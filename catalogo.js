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
    const code = input.code.trim().replace(/[\s-]+/g, '');
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
    return { key: code ? 'upc:' + code : 'nombre:' + nameKey(name), name, code, cost: input.cost ?? null, sale, purchase };
  }

  async function save(input, { previousKey, expected, fromInvoice = false, preserveMissing = fromInvoice } = {}) {
    const product = prepare(input);
    return transaction('readwrite', (store, done) => {
      const target = store.get(product.key);
      target.onsuccess = () => {
        const existing = target.result;
        if (preserveMissing && expected !== undefined && existing?.updated !== expected) {
          done({ stale: true });
          return;
        }
        if (existing && previousKey !== product.key && (!preserveMissing || expected !== existing.updated)) {
          done({ conflict: existing });
          return;
        }
        const write = (previous = existing) => {
          const keep = preserveMissing && existing;
          const cost = product.cost ?? (keep ? existing.cost : null);
          const saved = {
            ...product,
            cost,
            purchase: product.purchase ?? (cost === previous?.cost ? previous.purchase ?? null : null),
            sale: product.sale ?? (keep ? existing.sale : null),
            updated: Math.max(Date.now(), (existing?.updated ?? 0) + 1)
          };
          if (previousKey && previousKey !== product.key) store.delete(previousKey);
          store.put(saved);
          done({ saved });
        };
        if (!previousKey) { write(); return; }
        const previous = store.get(previousKey);
        previous.onsuccess = () => {
          if (!previous.result || previous.result.updated !== expected) done({ stale: true });
          else write(previous.result);
        };
      };
    });
  }

  async function saveNewProducts(inputs) {
    const products = inputs.map(input => {
      try {
        return prepare(input);
      } catch (error) {
        throw Error((input.name.trim() || 'Producto sin nombre') + ': ' + error.message);
      }
    });
    return transaction('readwrite', (store, done) => {
      const saved = [];
      const skipped = [];
      function next(index) {
        const product = products[index];
        if (!product) { done({ saved, skipped }); return; }
        const request = store.get(product.key);
        request.onsuccess = () => {
          if (request.result) {
            skipped.push(index);
          } else {
            store.add({ ...product, updated: Date.now() });
            saved.push(index);
          }
          next(index + 1);
        };
      }
      next(0);
    });
  }

  const list = () => transaction('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result.sort((a, b) => a.name.localeCompare(b.name, 'es')));
  });
  const findByCode = code => transaction('readonly', (store, done) => {
    const request = store.get('upc:' + code);
    request.onsuccess = () => done(request.result);
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

  window.PorcentoCatalogo = { save, saveNewProducts, list, findByCode, remove, searchKey };
})();
