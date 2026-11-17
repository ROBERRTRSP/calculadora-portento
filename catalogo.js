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
    const photo = input.photo ?? null;
    if (photo && (photo.type !== 'image/jpeg' || !photo.size || photo.size > 1024 * 1024)) {
      throw Error('Elige una foto válida del producto.');
    }
    return { key: code ? 'upc:' + code : 'nombre:' + nameKey(name), name, code, cost: input.cost ?? null, sale, purchase, photo };
  }

  async function save(input, { previousKey, expected, fromInvoice = false, preserveMissing = fromInvoice, replace = false } = {}) {
    const product = prepare(input);
    return transaction('readwrite', (store, done) => {
      const target = store.get(product.key);
      target.onsuccess = () => {
        const existing = target.result;
        if ((replace || preserveMissing) && expected !== undefined && existing?.updated !== expected) {
          done({ stale: true });
          return;
        }
        if (!replace && existing && previousKey !== product.key && (!preserveMissing || expected !== existing.updated)) {
          done({ conflict: existing });
          return;
        }
        const write = (previous = existing) => {
          const keep = !replace && preserveMissing && existing;
          const cost = replace ? product.cost : product.cost ?? (keep ? existing.cost : null);
          const saved = {
            ...product,
            cost,
            purchase: replace ? product.purchase : product.purchase ?? (cost === previous?.cost ? previous.purchase ?? null : null),
            photo: replace ? product.photo : product.photo ?? previous?.photo ?? null,
            sale: replace ? product.sale : product.sale ?? (keep ? existing.sale : null),
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
  function dataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function exportSnapshot() {
    const products = await list();
    const items = [];
    for (const product of products) {
      items.push({
        name: product.name,
        code: product.code || '',
        cost: product.cost ?? null,
        sale: product.sale ?? null,
        purchase: product.purchase ?? null,
        photo: product.photo ? await dataURL(product.photo) : null
      });
    }
    return { porcento: 1, exportedAt: new Date().toISOString(), products: items };
  }

  async function importSnapshot(data) {
    if (!data || data.porcento !== 1 || !Array.isArray(data.products)) {
      throw Error('Ese archivo no es una copia de Porcento.');
    }
    let saved = 0;
    const failed = [];
    for (const item of data.products) {
      const name = String(item?.name || '').trim();
      try {
        let photo = null;
        if (typeof item.photo === 'string' && /^data:image\/jpeg(?:;charset=[^;,]+)?;base64,/i.test(item.photo)) {
          const fetched = await (await fetch(item.photo)).blob();
          if (fetched.size && fetched.size <= 1024 * 1024) photo = fetched.slice(0, fetched.size, 'image/jpeg');
        }
        const sale = item.sale == null || item.sale === '' ? '' : (Number(item.sale) / 100).toFixed(2);
        const units = item.purchase?.units;
        const purchase = Number.isSafeInteger(item.purchase?.cents) ? {
          cents: item.purchase.cents,
          units: Number.isSafeInteger(units) ? units : null
        } : null;
        const input = { name, code: String(item.code || ''), cost: item.cost ?? null, sale, purchase, photo };
        const result = await save(input, { replace: true });
        if (result.saved) saved++;
        else failed.push(name || 'Producto');
      } catch {
        failed.push(name || 'Producto');
      }
    }
    return { saved, failed };
  }

  const remove = product => transaction('readwrite', (store, done) => {
    const request = store.get(product.key);
    request.onsuccess = () => {
      const current = request.result;
      if (current?.updated !== product.updated) { done(false); return; }
      store.delete(product.key);
      done(true);
    };
  });

  window.PorcentoCatalogo = { save, saveNewProducts, list, findByCode, remove, searchKey, exportSnapshot, importSnapshot };
})();
