(function () {
  'use strict';

  const headerKey = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameKey = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  const codeKey = value => {
    const code = String(value ?? '').trim();
    return /^\d{4,14}$/.test(code) ? code : '';
  };

  function unitOffer(value) {
    const text = String(value ?? '').trim();
    const offer = text.match(/^(\d+)\s*(?:for|por|\/)\s*(.+)$/i);
    const cents = moneyCents(offer?.[2] ?? text);
    const quantity = offer ? Number(offer[1]) : 1;
    return cents > 0 && quantity > 0 ? { cents, quantity, bundled: Boolean(offer) } : null;
  }

  function moneyCents(value) {
    return factura.moneyCents(typeof value === 'string' ? value.replace(/\s*USD$/i, '') : value);
  }

  function readSheet(sheet) {
    const headings = {
      code: ['upc', 'upcean', 'ean', 'barcode', 'codigodebarras', 'itemupc'],
      name: ['name', 'itemname', 'productname', 'description', 'itemdescription', 'nombre', 'descripcion', 'producto'],
      cents: ['cents', 'pricecents', 'priceincents', 'centavos'],
      list: ['listprice', 'listpriceusd', 'retailprice', 'retailpriceusd', 'sellingprice', 'preciodeventa'],
      price: ['price', 'priceusd', 'precio', 'retail'],
      quantity: ['qty', 'quantity', 'priceqty', 'pricequantity'],
      size: ['size', 'packsize', 'tamano'],
      byWeight: ['byweight', 'soldbyweight'],
      inclusions: ['incltaxes', 'inclfees', 'includestax', 'includesfees']
    };
    for (const [index, line] of sheet.slice(0, 20).entries()) {
      const keys = line.map(headerKey);
      const lookup = aliases => keys.findIndex(key => aliases.includes(key));
      const columns = Object.fromEntries(Object.entries(headings).map(([name, aliases]) => [name, lookup(aliases)]));
      if (columns.name < 0 || [columns.cents, columns.list, columns.price].every(i => i < 0)) continue;
      const taxOrFee = keys.flatMap((key, i) => headings.inclusions.includes(key) ? [i] : []);
      const items = [];
      let skipped = 0;
      const yes = value => /^(?:y|yes|true|1|si|sí)$/i.test(String(value ?? '').trim());
      for (const row of sheet.slice(index + 1)) {
        const name = String(row[columns.name] ?? '').trim();
        const codeValue = row[columns.code];
        if (!name || /^\s*total\s*$/i.test(name)) continue;
        const code = codeKey(codeValue);
        const qty = String(row[columns.quantity] ?? '').trim();
        const quantity = qty === '' ? 1 : Number(qty);
        let offer;
        if (columns.cents >= 0 && String(row[columns.cents] ?? '').trim() !== '') {
          const text = String(row[columns.cents]).trim();
          const cents = /^\d+$/.test(text) ? Number(text) : 0;
          if (Number.isSafeInteger(cents) && cents > 0) offer = { cents, quantity, bundled: true };
        } else {
          offer = unitOffer(String(row[columns.list] ?? '').trim() || row[columns.price]);
          if (offer && !offer.bundled) offer.quantity = quantity;
        }
        if (!offer || !Number.isSafeInteger(offer.quantity) || offer.quantity < 1) {
          skipped++;
          continue;
        }
        items.push({ code, name, size: String(row[columns.size] ?? '').trim(),
          cents: offer.cents, quantity: offer.quantity,
          needsReview: yes(row[columns.byWeight]) || taxOrFee.some(i => yes(row[i])) });
      }
      return { items, skipped };
    }
    return null;
  }

  const nameHasSize = (name, size) => nameKey(name).endsWith(' ' + nameKey(size));

  function indexPricebook(items) {
    const names = new Map(), codes = new Map();
    for (const item of items) {
      if (item.code) {
        if (!codes.has(item.code)) codes.set(item.code, []);
        codes.get(item.code).push(item);
      }
      const label = item.size && !nameHasSize(item.name, item.size)
        ? nameKey(item.name + ' ' + item.size) : nameKey(item.name);
      if (!names.has(label)) names.set(label, []);
      names.get(label).push(item);
    }
    return { names, codes };
  }

  function matchItem(row, index) {
    const code = row.codigoTipo === 'interno' ? '' : codeKey(row.codigo);
    if (code) {
      const matches = index.codes.get(code) ?? [];
      if (matches.length === 1) return { item: matches[0], via: 'UPC/código exacto' };
      if (matches.length > 1) return null;
    }
    const matches = index.names.get(nameKey(row.nombre)) ?? [];
    if (matches.length !== 1 || (code && matches[0].code && code !== matches[0].code)) return null;
    return { item: matches[0], via: 'Nombre exacto' };
  }

  function compare(row, catalog, target) {
    const match = catalog ? matchItem(row, catalog) : null;
    const line = moneyCents(row.costo), units = Number(row.cantidad);
    const cost = line !== null && line > 0 && Number.isSafeInteger(units) && units > 0 ? line / units : null;
    const sale = match ? match.item.cents / match.item.quantity : null;
    const canCompare = cost !== null && sale !== null && !row.review && !row.costUnconfirmed && !match.item.needsReview;
    const validTarget = Number.isFinite(target) && target >= 0 && target < 100;
    const margin = canCompare ? (1 - cost / sale) * 100 : null;
    const suggested = canCompare && validTarget ? Math.ceil(cost * 100 / (100 - target) - 1e-9) : null;
    return { match, cost, sale, margin, suggested, below: margin !== null && validTarget && margin < target - 1e-9 };
  }

  const factura = typeof module === 'object' ? require('./factura.js') : window.PorcentoFactura;
  const pricebook = { readSheet, indexPricebook, compare };
  if (typeof module === 'object') module.exports = pricebook;
  else window.PorcentoPricebook = pricebook;
})();
