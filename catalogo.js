(function () {
  'use strict';

  const storeName = 'productos';
  let connection;

  function open() {
    connection ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('porcento-catalogo', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'key' });
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); connection = null; };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => { connection = null; throw error; });
    return connection;
  }

  async function transaction(mode, action) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || Error('No se pudo acceder al catálogo.'));
      action(tx.objectStore(storeName), value => { result = value; });
    });
  }

  const nameKey = name => name.trim().replace(/\s+/g, ' ').normalize('NFC').toLocaleLowerCase('es');
  const searchKey = value => nameKey(value).normalize('NFD').replace(/\p{M}/gu, '');

  function prepare(input) {
    const name = input.name.trim().replace(/\s+/g, ' ');
    const code = cleanCode(input.code);
    if (!name || name.length > 180) throw Error('Escribe un nombre de hasta 180 caracteres.');
    if (code && !/^\d{8,14}$/.test(code)) throw Error('Escribe un UPC/EAN de 8 a 14 dígitos o deja el campo vacío.');
    if (input.cost != null && (!Number.isFinite(input.cost) || input.cost < 0)) throw Error('Revisa el costo por unidad.');
    const saleText = input.sale.trim();
    const sale = saleText === '' ? null : window.PorcentoFactura.moneyCents(saleText);
    if (saleText && (sale === null || sale < 0)) throw Error('Escribe un precio de venta válido, con hasta dos decimales.');
    const purchase = input.purchase ?? null;
    if (purchase && (!Number.isSafeInteger(purchase.cents) || purchase.cents < 0 ||
        (purchase.units !== null && (!Number.isSafeInteger(purchase.units) || purchase.units < 1)))) {
      throw Error('Revisa el costo de compra y las unidades.');
    }
    const photo = input.photo ?? null;
    if (photo && (photo.type !== 'image/jpeg' || !photo.size || photo.size > 1024 * 1024)) {
      throw Error('Elige una foto válida del producto.');
    }
    return { key: code ? 'upc:' + code : 'nombre:' + nameKey(name), name, code, cost: input.cost ?? null, sale, purchase, photo };
  }

  const cleanCode = code => code.trim().replace(/[\s-]+/g, '');
  const barcodeKey = code => /^\d{12,14}$/.test(code) ? code.padStart(14, '0') : code;

  function readProduct(store, key, found) {
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result || !key.startsWith('upc:')) { found(request.result); return; }
      const code = key.slice(4);
      if (!/^\d{12,14}$/.test(code)) { found(); return; }
      const canonical = barcodeKey(code);
      const alternatives = [12, 13, 14].map(length => canonical.slice(-length))
        .filter(value => value !== code && barcodeKey(value) === canonical);
      function next(index) {
        if (index === alternatives.length) { found(); return; }
        const alternate = store.get('upc:' + alternatives[index]);
        alternate.onsuccess = () => alternate.result ? found(alternate.result) : next(index + 1);
      }
      next(0);
    };
  }

  const grossMargin = (cost, sale) => Number.isFinite(cost) && sale > 0 ? (1 - cost / (sale / 100)) * 100 : null;

  function purchaseHistory(product) {
    if (!product) return [];
    if (Array.isArray(product.purchases)) return product.purchases;
    if (product.cost == null) return [];
    return [{ cost: product.cost, purchase: product.purchase, sale: product.sale,
      margin: grossMargin(product.cost, product.sale), date: null, supplier: '', id: '' }];
  }

  function merge(product, previous, { preserveMissing = false, record } = {}) {
    const sale = product.sale ?? (preserveMissing ? previous?.sale ?? null : null);
    const cost = product.cost ?? (preserveMissing ? previous?.cost ?? null : null);
    const now = Math.max(Date.now(), (previous?.updated ?? 0) + 1);
    const purchases = purchaseHistory(previous).slice();
    if (product.cost !== null && (record || !purchases.length)) {
      purchases.unshift({ id: record?.id ?? '', cost: product.cost, purchase: product.purchase, sale,
        margin: grossMargin(product.cost, sale), date: record?.date ?? now, supplier: record?.supplier ?? '' });
    }
    return {
      ...product, cost, sale, purchases, updated: now,
      purchase: product.purchase ?? (cost === previous?.cost ? previous?.purchase ?? null : null),
      photo: product.photo ?? previous?.photo ?? null
    };
  }

  async function save(input, { previousKey, expected, preserveMissing = false, record } = {}) {
    const product = prepare(input);
    return transaction('readwrite', (store, done) => {
      readProduct(store, product.key, existing => {
        if (existing && existing.key !== previousKey && (!preserveMissing || expected === undefined)) {
          done({ conflict: existing });
          return;
        }
        const write = previous => {
          if (expected !== undefined && previous?.updated !== expected) { done({ stale: true }); return; }
          const next = !previousKey && previous ? { ...product, key: previous.key, code: previous.code } : product;
          const saved = merge(next, previous, { preserveMissing, record });
          if (previousKey && previousKey !== saved.key) store.delete(previousKey);
          store.put(saved);
          done({ saved });
        };
        if (!previousKey || previousKey === existing?.key) { write(existing); return; }
        const previous = store.get(previousKey);
        previous.onsuccess = () => write(previous.result);
      });
    });
  }

  async function saveInvoiceProducts(inputs) {
    const products = inputs.map(input => {
      try {
        return { product: prepare(input), record: input.record };
      } catch (error) {
        throw Error((input.name.trim() || 'Producto sin nombre') + ': ' + error.message);
      }
    });
    return transaction('readwrite', (store, done) => {
      const results = [];
      function next(index) {
        const entry = products[index];
        if (!entry) { done(results); return; }
        const { product, record } = entry;
        readProduct(store, product.key, existing => {
          if (product.cost === null) {
            results.push({ pending: true });
          } else if (purchaseHistory(existing).some(purchase => purchase.id === record.id)) {
            results.push({ duplicate: true, product: existing });
          } else {
            const nextProduct = existing ? { ...product, key: existing.key, code: existing.code, name: existing.name } : product;
            const saved = merge(nextProduct, existing, { preserveMissing: true, record });
            store.put(saved);
            results.push({ saved: true, product: saved });
          }
          next(index + 1);
        });
      }
      next(0);
    });
  }

  const list = () => transaction('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => a.name.localeCompare(b.name, 'es')));
  });
  const findByCode = code => transaction('readonly', (store, done) => {
    readProduct(store, 'upc:' + cleanCode(code), done);
  });
  const remove = product => transaction('readwrite', (store, done) => {
    const request = store.get(product.key);
    request.onsuccess = () => {
      const current = request.result;
      if (current?.updated !== product.updated) { done(false); return; }
      store.delete(product.key);
      done(true);
    };
  });

  window.PorcentoCatalogo = { save, saveInvoiceProducts, list, findByCode, remove, searchKey, barcodeKey, grossMargin, purchaseHistory };
})();
