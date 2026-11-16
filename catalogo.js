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
  // Correct only this confirmed legacy record. Other similar codes can be different products.
  const correctedCode = '819721012045';
  const oldCode = '8721012045';

  const isLegacyProduct = product => product &&
    /^blunt ?ville triple (?:vinilla|vainilla|vanilla)$/.test(searchKey(product.name));

  function codeCandidates(value) {
    const code = cleanCode(value);
    const canonical = barcodeKey(code);
    if (!/^\d{12,14}$/.test(code)) return [code];
    return [code, ...[12, 13, 14].map(length => canonical.slice(-length))
      .filter(value => value !== code && barcodeKey(value) === canonical)];
  }

  function matchByCode(value, productsByCode) {
    const match = codeCandidates(value).map(code => productsByCode.get(code)).find(Boolean);
    if (match || barcodeKey(cleanCode(value)) !== barcodeKey(correctedCode)) return match;
    const legacy = productsByCode.get(oldCode);
    return isLegacyProduct(legacy) ? legacy : undefined;
  }

  function readProduct(store, key, found, repair = false) {
    const code = key.startsWith('upc:') ? key.slice(4) : null;
    const candidates = code === null ? [key] : codeCandidates(code).map(code => 'upc:' + code);
    const isConfirmedCode = code !== null && barcodeKey(code) === barcodeKey(correctedCode);
    function next(index) {
      if (index === candidates.length) {
        if (isConfirmedCode) checkLegacy();
        else found();
        return;
      }
      const request = store.get(candidates[index]);
      request.onsuccess = () => {
        const exact = request.result;
        if (!exact) next(index + 1);
        else if (repair && isConfirmedCode && isLegacyProduct(exact)) checkLegacy(exact);
        else found(currentProduct(exact));
      };
    }
    function checkLegacy(exact) {
      const request = store.get('upc:' + oldCode);
      request.onsuccess = () => {
        const legacy = request.result;
        if (!isLegacyProduct(legacy)) { found(exact && currentProduct(exact)); return; }
        if (!repair) { found(currentProduct(legacy)); return; }
        const corrected = exact ? combineLegacyProduct(exact, legacy) :
          { ...currentProduct(legacy), key: 'upc:' + correctedCode, code: correctedCode };
        corrected.updated = Math.max(Date.now(), (legacy.updated ?? 0) + 1, (exact?.updated ?? 0) + 1);
        store.put(corrected);
        store.delete(legacy.key);
        found(corrected);
      };
    }
    next(0);
  }

  const grossMargin = (cost, sale) => Number.isFinite(cost) && sale > 0 ? (1 - cost / (sale / 100)) * 100 : null;

  const purchaseDate = entry => Number.isFinite(entry?.date) ? entry.date : -Infinity;
  const comparePurchases = (a, b) => purchaseDate(a) === purchaseDate(b) ? 0 : purchaseDate(a) > purchaseDate(b) ? -1 : 1;

  function purchaseHistory(product) {
    if (!product) return [];
    if (Array.isArray(product.purchases)) return product.purchases.slice().sort(comparePurchases);
    if (product.cost == null) return [];
    return [{ cost: product.cost, purchase: product.purchase, sale: product.sale,
      margin: grossMargin(product.cost, product.sale), date: null, supplier: '', id: '' }];
  }

  function currentProduct(product) {
    const recordedFirst = product.purchases?.[0];
    if (!recordedFirst?.id || recordedFirst.cost !== product.cost || !Number.isFinite(recordedFirst.date)) return product;
    const latest = purchaseHistory(product)[0];
    if (comparePurchases(latest, recordedFirst) >= 0) return product;
    return { ...product, cost: latest.cost, purchase: latest.purchase };
  }

  function combineLegacyProduct(exact, legacy) {
    const seen = new Set();
    const purchases = [...purchaseHistory(exact), ...purchaseHistory(legacy)]
      .filter(entry => {
        if (!entry.id) return true;
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      }).sort(comparePurchases);
    const latest = purchases[0];
    return { ...exact, photo: exact.photo ?? legacy.photo, sale: exact.sale ?? legacy.sale,
      cost: latest?.cost ?? exact.cost ?? legacy.cost,
      purchase: latest ? latest.purchase : exact.purchase ?? legacy.purchase, purchases };
  }

  function merge(product, previous, { preserveMissing = false, record } = {}) {
    const sale = product.sale ?? (preserveMissing ? previous?.sale ?? null : null);
    const cost = product.cost ?? (preserveMissing ? previous?.cost ?? null : null);
    const now = Math.max(Date.now(), (previous?.updated ?? 0) + 1);
    const purchases = purchaseHistory(previous);
    const older = record?.id && Number.isFinite(record.date) && record.date < purchaseDate(purchases[0]);
    if (product.cost !== null && (record || !purchases.length)) {
      purchases.unshift({ id: record?.id ?? '', cost: product.cost, purchase: product.purchase, sale,
        margin: grossMargin(product.cost, sale), date: record?.date ?? now, supplier: record?.supplier ?? '' });
      purchases.sort(comparePurchases);
    }
    const latest = older ? purchases[0] : null;
    return {
      ...product, cost: latest ? latest.cost : cost, sale: older && previous?.sale != null ? previous.sale : sale,
      purchases, updated: now,
      purchase: latest ? latest.purchase : product.purchase ?? (cost === previous?.cost ? previous?.purchase ?? null : null),
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
        previous.onsuccess = () => write(previous.result && currentProduct(previous.result));
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
        }, product.cost !== null);
      }
      next(0);
    });
  }

  const list = () => transaction('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result.map(currentProduct).sort((a, b) => a.name.localeCompare(b.name, 'es')));
  });
  function findByCode(value) {
    const code = cleanCode(value);
    const repair = barcodeKey(code) === barcodeKey(correctedCode);
    return transaction(repair ? 'readwrite' : 'readonly', (store, done) => {
      readProduct(store, 'upc:' + code, done, repair);
    });
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

  async function exportBackup() {
    const products = await list();
    const entries = await Promise.all(products.map(async product => {
      if (!product.photo) return { ...product, photo: null };
      const bytes = new Uint8Array(await product.photo.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      return { ...product, photo: btoa(binary) };
    }));
    return JSON.stringify({ format: 'porcento-catalogo', version: 1, products: entries });
  }

  async function importBackup(text) {
    const backup = JSON.parse(text);
    if (backup?.format !== 'porcento-catalogo' || backup.version !== 1 || !Array.isArray(backup.products)) {
      throw Error('Selecciona un respaldo de Mi catálogo en formato JSON.');
    }
    const validSale = sale => sale === null || (Number.isSafeInteger(sale) && sale >= 0);
    const validCost = cost => cost === null || (Number.isFinite(cost) && cost >= 0);
    const validPurchase = purchase => purchase == null || (
      Number.isSafeInteger(purchase.cents) && purchase.cents >= 0 &&
      (purchase.units == null || (Number.isSafeInteger(purchase.units) && purchase.units > 0)));
    const validDate = date => date == null || (Number.isSafeInteger(date) && date > 0 && date <= 8.64e15);
    const products = backup.products.map(entry => {
      if (typeof entry?.name !== 'string' || typeof entry.code !== 'string' ||
          !validSale(entry.sale) || !validCost(entry.cost) || !validPurchase(entry.purchase)) {
        throw Error('El respaldo contiene una ficha inválida.');
      }
      if (entry.photo != null && (typeof entry.photo !== 'string' || entry.photo.length > 1398104)) {
        throw Error('El respaldo contiene una foto inválida.');
      }
      const photo = entry.photo == null ? null :
        new Blob([Uint8Array.from(atob(entry.photo), character => character.charCodeAt(0))], { type: 'image/jpeg' });
      const product = prepare({ ...entry, sale: entry.sale === null ? '' : (entry.sale / 100).toFixed(2), photo });
      const purchases = purchaseHistory(entry).map(item => {
        if (!item || !validCost(item.cost) || item.cost === null || !validPurchase(item.purchase) || !validSale(item.sale) ||
            !validDate(item.date) || typeof item.supplier !== 'string' || typeof item.id !== 'string') {
          throw Error('El respaldo contiene un historial de compras inválido.');
        }
        return { id: item.id, supplier: item.supplier, date: item.date ?? null, cost: item.cost,
          purchase: item.purchase ?? null, sale: item.sale, margin: grossMargin(item.cost, item.sale) };
      });
      return { ...product, purchases, updated: Date.now() };
    });
    return transaction('readwrite', (store, done) => {
      let imported = 0;
      function next(index) {
        const product = products[index];
        if (!product) { done({ imported, skipped: products.length - imported }); return; }
        readProduct(store, product.key, existing => {
          if (!existing) {
            store.add(product);
            imported++;
          }
          next(index + 1);
        });
      }
      next(0);
    });
  }

  window.PorcentoCatalogo = { save, saveInvoiceProducts, list, findByCode, matchByCode, remove, exportBackup, importBackup, searchKey, barcodeKey, grossMargin, purchaseHistory };
})();
