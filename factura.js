(function () {
  'use strict';

  const money = '\\$?\\s*(\\d{1,7}[.,]\\d{2})';
  const amount = value => {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
    const number = Number(value.replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  };
  const positive = value => {
    const n = amount(value);
    return n > 0 ? n : null;
  };
  const count = value => {
    const n = amount(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const cents = value => Math.round(value * 100);

  function unitsFromDescription(name) {
    // Weight/volume lookalikes from receipts such as 16.9OZ -> 16.902.
    const clean = name.replace(/0Z\b/gi, 'oz');
    const patterns = [
      /\b(\d{1,4})\s*[-/]\s*\d+(?:[.,]\d+)?\s*(?:fl\s*oz|oz|ml|gr|g|gal|lt|l|lb|ct|pk|sticks?|drops?)\b/i,
      /\b(\d{1,4})\s*[x/]\s*1\s*$/i,
      /\b(?:case|caja|pack)\s*(\d{1,4})\b/i
    ];
    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match) return count(match[1]);
    }
    return null;
  }

  function normalize(data) {
    const products = Array.isArray(data.productos) ? data.productos : [];
    const rows = products.filter(raw => raw && typeof raw.nombre === 'string' && raw.nombre.trim()).map(raw => {
      const nombre = raw.nombre.trim().slice(0, 180);
      const packages = count(raw.cantidad_comprada);
      const pack = count(raw.unidades_por_empaque);
      const line = positive(raw.total_linea);
      const price = positive(raw.precio_empaque);
      const pcs = count(raw.piezas_facturadas);
      const directQuantity = count(raw.unidades_vendibles_totales);
      const computedQuantity = packages && pack ? count(packages * pack) : null;
      const quantity = directQuantity ?? computedQuantity;
      const reconstructed = packages && price ? packages * price : null;
      const cost = line ?? reconstructed;
      const warnings = [];
      const mismatch = line !== null && reconstructed !== null && Math.abs(cents(line) - cents(reconstructed)) > 1;
      if (directQuantity && computedQuantity && directQuantity !== computedQuantity) warnings.push('Las unidades indicadas difieren de la cantidad de empaques por sus unidades.');
      if (mismatch) warnings.push('La cantidad comprada por el precio del empaque difiere del importe impreso.');
      if (!quantity) warnings.push(pcs ? 'Confirma si las piezas impresas corresponden a unidades vendibles.' : 'Confirma las unidades vendibles.');
      if (!cost) warnings.push('Confirma el importe de la línea.');
      if (raw.confianza === 'baja') warnings.push('Lectura dudosa.');
      if (typeof raw.observacion === 'string' && raw.observacion.trim()) warnings.push(raw.observacion.trim().slice(0, 260));
      const parts = [packages && pack && pack > 1 ? packages + ' × ' + pack : '', raw.codigo && /^\d{4,14}$/.test(String(raw.codigo)) ? 'Código ' + raw.codigo : ''].filter(Boolean);
      return {
        nombre, costo: cost ? cost.toFixed(2) : '', cantidad: quantity || '',
        info: parts.join(' · '), warning: warnings.join(' '), review: warnings.length > 0 || raw.confianza === 'media'
      };
    });
    const printed = positive(data.subtotal_productos) ?? positive(data.total_factura);
    return { rows, printed };
  }

  function parseText(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const recent = [];
    const products = [];
    const textRow = new RegExp('^\\s*\\d{1,4}\\s+(.+?)\\s+(\\d+)\\s*(ca(?:ja)?s?|cs|cases?|un(?:d|id(?:ades)?)?)\\s+' + money + '(?:\\s+' + money + ')?[|\\s]*$', 'i');
    const tableRow = new RegExp('^([0-9]{8,14})[|.\\s]+(.+?)\\s+(\\d+)\\s+' + money + '(?:[|\\s]+' + money + ')?[|\\s]*$', 'i');
    const receiptPrice = new RegExp('^(\\d+)\\s*(cases?|cs(?:-\\d+)?|bx|box|bags?|bg|dz|pk(?:-\\d+)?|pack|each|ea)\\s*@\\s*' + money + '(?:[|\\s]+' + money + ')?[|\\s]*$', 'i');
    const dairyRow = new RegExp('^(\\d{3,6})\\s+(?:[-_/]+\\s+)*(\\d+)\\s*(?:[-_/]+\\s+)?(.+?)\\s+(\\d+)\\s+' + money + '[|\\s]*$');
    const dairy = /JERSEY\s+DAIRY|CASE\s*\/\s*UNIT[^\n]*\bPCS\b/i.test(text);
    let printed = null, itemCode = '';
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[|\s]+/,'').replace(/\s*\|\s*/g, ' ').trim();
      const total = line.match(new RegExp('^(?:invoice total|total this invoice|total neto|subtotal|total)[:\\s/]*' + money + '\\s*$', 'i'));
      if (total) {
        printed ??= amount(total[1]);
        continue;
      }
      const item = line.match(/^[IlTt]tem\s*(?:no\.?)?\s*[:.;]*\s*(\d{4,8})\s*$/i);
      if (item) {
        itemCode = item[1];
        recent.length = 0;
        continue;
      }
      const bill = line.match(receiptPrice);
      if (bill && recent.length) {
        const [, purchased, type, price, lineTotal] = bill;
        const name = recent.at(-1);
        const typeIsExplicitUnit = /^(ea|each)$/i.test(type);
        const mappedSize = unitsFromDescription(name);
        const dozens = type.toLowerCase() === 'dz' ? 12 : null;
        const retailBundle = /\b\d+\s*[-/]\s*\d+\s*(?:ct|pk)\b/i.test(name) || /\b(?:case|cs|pk)-\d+\b/i.test(type);
        const ambiguousEach = typeIsExplicitUnit && /\b\d{1,4}\s*[-/]\s*\d/.test(name);
        if (/[a-záéíóú]{3}/i.test(name) && !/\b(?:address|subtotal|amount|credit cards|market|change|invoice)\b/i.test(name)) {
          products.push({
            nombre: name, codigo: itemCode, cantidad_comprada: purchased,
            unidades_por_empaque: retailBundle || ambiguousEach ? null : dozens ?? mappedSize ?? (typeIsExplicitUnit ? 1 : null),
            precio_empaque: price, total_linea: lineTotal,
            confianza: lineTotal ? 'alta' : 'media'
          });
        }
        recent.length = 0;
        itemCode = '';
        continue;
      }
      const dairyMatch = dairy && line.match(dairyRow);
      if (dairyMatch) {
        const [, codigo, , nombre, pcs, total_linea] = dairyMatch;
        products.push({ nombre, codigo, piezas_facturadas: pcs, total_linea,
          unidades_vendibles_totales: /\b\d+\s*\/\s*C\b/i.test(nombre) ? null : pcs });
        continue;
      }
      const table = line.match(tableRow);
      const simple = line.match(textRow);
      if (table || simple) {
        const [, first, second, third, price, lineTotal] = (table || simple);
        const nombre = table ? second : first;
        const purchased = table ? third : second;
        const pack = simple && /^un/i.test(third) ? 1 : unitsFromDescription(nombre);
        if (/[a-záéíóú]{3}/i.test(nombre)) products.push({
          nombre, codigo: table ? first : '', cantidad_comprada: purchased, unidades_por_empaque: pack,
          precio_empaque: price, total_linea: lineTotal, confianza: lineTotal ? 'alta' : 'media',
          observacion: /\b\d+\s*x\s*1\s*$/i.test(nombre) ? 'Confirma que la indicación x1 corresponde al empaque.' : ''
        });
        continue;
      }
      if (!/^[-_\s]+$/.test(line)) recent.push(line);
      if (recent.length > 2) recent.shift();
    }
    return normalize({ productos: products, subtotal_productos: printed });
  }

  function suggestedPrice(cost, quantity, margin) {
    if (!positive(cost) || !count(quantity)) return null;
    return Math.ceil((Number(cost) / Number(quantity) / (1 - margin / 100) - 1e-9) * 100) / 100;
  }

  const invoice = { normalize, parseText, suggestedPrice, cents };
  if (typeof module === 'object') module.exports = invoice;
  else window.PorcentoFactura = invoice;
})();
