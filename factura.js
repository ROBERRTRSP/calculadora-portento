(function () {
  'use strict';

  const money = '(-?\\$?\\s*(?:\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d{1,7}[.,]\\d{2}))';
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
  function moneyCents(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    const match = text.match(/^(-?)\$?\s*(\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:([.,])(\d{1,2}))?$/);
    if (!match || (match[2].includes(',') && match[3] === ',')) return null;
    const magnitude = Number(match[2].replaceAll(',', '')) * 100 + Number((match[4] || '').padEnd(2, '0'));
    return match[1] === '-' ? -magnitude : magnitude;
  }

  function reconcile(rows, totals) {
    let sum = 0;
    let pending = 0;
    for (const row of rows) {
      const line = moneyCents(row.costo);
      if (!row.nombre.trim() || line === null || row.costUnconfirmed) pending++;
      if (line !== null) sum += line;
    }
    const { subtotal, total, adjustments } = totals;
    const adjustmentTotal = adjustments.reduce((sum, adjustment) => sum + adjustment, 0);
    const computed = sum + adjustmentTotal;
    const subtotalDifference = subtotal === null ? null : subtotal - sum;
    const difference = total === null ? null : total - computed;
    const verified = rows.length > 0 && pending === 0 && !totals.partial && !totals.conflictingTotal && !adjustments.includes(null)
      && difference === 0 && (subtotalDifference === null || subtotalDifference === 0);
    return { sum, computed, difference, subtotalDifference, pending, verified };
  }

  function preferReading(current, next) {
    const a = reconcile(current.rows, current.totals);
    const b = reconcile(next.rows, next.totals);
    if (a.verified !== b.verified) return b.verified;
    if (Boolean(current.rows.length) !== Boolean(next.rows.length)) return next.rows.length > 0;
    if (a.difference === null && b.difference !== null) return true;
    if (a.difference !== null && b.difference === null) return false;
    const gap = check => Math.abs(check.difference || 0) + Math.abs(check.subtotalDifference || 0);
    if (gap(a) !== gap(b)) return gap(b) < gap(a);
    if (a.pending !== b.pending) return b.pending < a.pending;
    return next.rows.length > current.rows.length;
  }

  function unitsFromDescription(name) {
    // Weight/volume lookalikes from receipts such as 16.9OZ -> 16.902.
    const clean = name.replace(/0Z\b/gi, 'oz').replace(/(?<=\d)9r\b/gi, 'gr');
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
      const line = moneyCents(raw.total_linea);
      const price = moneyCents(raw.precio_empaque);
      const pcs = count(raw.piezas_facturadas);
      const directQuantity = count(raw.unidades_vendibles_totales);
      const computedQuantity = packages && pack ? count(packages * pack) : null;
      const quantity = directQuantity ?? computedQuantity;
      const reconstructed = packages && price !== null && price >= 0 ? packages * price : null;
      const cost = line ?? reconstructed;
      const warnings = [];
      const mismatch = line !== null && reconstructed !== null && line !== reconstructed;
      if (directQuantity && computedQuantity && directQuantity !== computedQuantity) warnings.push('Las unidades indicadas difieren de la cantidad de empaques por sus unidades.');
      if (mismatch) warnings.push('La cantidad comprada por el precio del empaque difiere del importe impreso.');
      if (!quantity) warnings.push(pcs ? 'Confirma si las piezas impresas corresponden a unidades vendibles.' : 'Confirma las unidades vendibles.');
      if (line === null) warnings.push('Confirma el importe impreso de la línea.');
      if (raw.confianza === 'baja') warnings.push('Lectura dudosa.');
      if (typeof raw.observacion === 'string' && raw.observacion.trim()) warnings.push(raw.observacion.trim().slice(0, 260));
      const parts = [packages && pack && pack > 1 ? packages + ' × ' + pack : '', raw.codigo && /^\d{4,14}$/.test(String(raw.codigo)) ? 'Código ' + raw.codigo : ''].filter(Boolean);
      return {
        nombre, costo: cost === null ? '' : (cost / 100).toFixed(2), cantidad: quantity || '',
        costUnconfirmed: line === null,
        info: parts.join(' · '), warning: warnings.join(' '), review: warnings.length > 0 || raw.confianza === 'media'
      };
    });
    const totals = {
      subtotal: moneyCents(data.subtotal_productos),
      total: moneyCents(data.total_factura),
      adjustments: Array.isArray(data.ajustes) ? data.ajustes.map(adjustment => moneyCents(adjustment?.importe)) : [],
      partial: data.lectura_parcial === true || rows.length !== products.length
    };
    return { rows, totals };
  }

  function detectFormat(text) {
    if (/\bJER[A-Z]{2,4}\s+DA[I1]RY\b|ADDS\s*\/\s*CUTS[^\n]*DESCRIPTION|CASE\s*\/\s*UN[I1T]+[^\n]*\bPCS\b/i.test(text)) return 'dairy';
    if (/\bAAA[\s.]+WHOLESALE\b/i.test(text) || (text.match(/^[\s'"]*[IlTt]tem\s*No\s*[.:]+\s*\d{4,8}/gim) || []).length >= 2) return 'aaa';
    if (/\bTA[IÍ1L]NO\s+(?:TRADING|TRAD)|\bUPC\b[^\n]*\b(?:QUANTITY|QTY|PRICE EACH)\b/i.test(text)) return 'taino';
    if (/\bROSAS\s+A\b|\bPRODUCTO[S]?\s+CANT(?:IDAD)?\.?\s+PRECIO\s+TOTAL\b/i.test(text)) return 'rosas';
    return '';
  }

  function parseText(text, { dairy, format = dairy === true ? 'dairy' : detectFormat(text) } = {}) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const recent = [];
    const products = [];
    const quantity = format === 'taino' ? '[0-9]+|[ilI]' : '[0-9]+';
    const textRow = new RegExp('^\\s*\\d{1,4}\\s+(.+?)\\s+(\\d+)\\s*(ca(?:ja)?s?|cs|cases?|un(?:d|id(?:ades)?)?)\\s+' + money + '(?:\\s+' + money + ')?[|\\s]*$', 'i');
    const tableRow = new RegExp('^([0-9]{6,14})[|.\\s]+(.+?)\\s+(' + quantity + ')\\s+' + money + '(?:[|\\s]+' + money + ')?[|\\s]*$', 'i');
    const receiptPrice = new RegExp('^(\\d+)\\s*(cases?|cs(?:-\\d+)?|bx|box|bags?|bg|dz|pk(?:-\\d+)?|pack|each|ea)\\s*' + (format === 'aaa' ? '[@&©]' : '@') + '\\s*' + money + '(?:\\s+' + money + ')?[|\\s]*$', 'i');
    const dairyRow = new RegExp('^[^\\w]*([0-9]{3,6})[.,:;)]?\\s+(.*?)\\s+(\\d+)\\s+' + money + '$');
    const amountOnly = new RegExp('^' + money + '$');
    const totalLabel = /^(inv[o0][i1l]c[e3]\s+total|total this inv[o0][i1l]c[e3]|total (?:de la )?factura|total neto|grand total|net total|sub\s*total(?:\s+de\s+productos)?|total)\b[\s:/~|]*(.*)$/i;
    const adjustmentLabel = /^(sales tax|total tax|tax|impuesto(?:s)?|itbis|shipping(?: fee)?|freight|flete|env[ií]o|deposit(?: fee)?|dep[oó]sito|service fee|recargo|discount|descuento)\b\s*[:/]*\s*(.*)$/i;
    const adjustments = [];
    let subtotal = null, total = null, genericTotal = null, itemCode = '';
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index];
      const line = rawLine.replace(/^[|\s]+/,'').replace(/\s*\|\s*/g, ' ').replace(/(\d[.,])\s+(?=\d{2}\b)/g, '$1').trim();
      const trimmed = line.replace(/^[\s"'«»~]+|[\s\\|"'<>]+$/g, '');
      const adjustmentMatch = line.match(adjustmentLabel);
      const totalMatch = !adjustmentMatch && trimmed.match(totalLabel);
      if (adjustmentMatch || totalMatch) {
        const [, label, tail] = adjustmentMatch || totalMatch;
        let totalText = tail || lines[index + 1] || '';
        if (totalMatch && format === 'dairy') {
          totalText = totalText.replace(/^([0-9]{1,7})\s*[-:;]\s*(\d{2})$/, '$1.$2');
        }
        const match = totalText.match(amountOnly);
        if (match) {
          if (!tail) index++;
          const value = match[1];
          if (adjustmentMatch) adjustments.push({ importe: /discount|descuento/i.test(label) && !value.startsWith('-') ? '-' + value : value });
          else if (/^sub\s*total/i.test(label)) subtotal = value;
          else if (/^total$/i.test(label)) genericTotal = value;
          else total = value;
        }
        continue;
      }
      const item = trimmed.match(format === 'aaa'
        ? /^[IlTt]tem\s*(?:no\.?)?\s*[:.;]*\s*(\d{4,8})\b/i
        : /^[IlTt]tem\s*(?:no\.?)?\s*[:.;]*\s*(\d{4,8})\s*$/i);
      if (item) {
        itemCode = item[1];
        recent.length = 0;
        continue;
      }
      const bill = trimmed.match(receiptPrice);
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
      const dairyText = trimmed.replace(/(\d)[;:](?=\d{2}$)/, '$1.').replace(/(?<=\d[.,]\d{2})\s+[A-Z?]+$/i, '');
      const dairyMatch = format === 'dairy' && dairyText.match(dairyRow);
      if (dairyMatch) {
        const [, codigo, description, pcs, total_linea] = dairyMatch;
        const nombre = description.replace(/^(?:(?:\d+(?!\d|\/|\s*(?:OZ|QT)\b)|[_~=\/|.·—–-]+)\s*)+/i, '').trim();
        if (/[a-záéíóú]{3}/i.test(nombre)) {
          products.push({ nombre, codigo, piezas_facturadas: pcs, total_linea,
            unidades_vendibles_totales: /\b\d+\s*\/\s*C\b/i.test(nombre) ? null : pcs });
          continue;
        }
      }
      const table = trimmed.match(tableRow);
      const rosas = format === 'rosas' ? parseRosasRow(trimmed) : null;
      if (rosas) {
        products.push(rosas);
        continue;
      }
      const simple = trimmed.match(textRow);
      if (table || simple) {
        const [, first, second, third, price, lineTotal] = (table || simple);
        const nombre = table ? second : first;
        const printedQuantity = table ? third : second;
        const purchased = /^[il]$/i.test(printedQuantity) && lineTotal && moneyCents(price) === moneyCents(lineTotal) ? 1 : printedQuantity;
        const pack = simple && /^un/i.test(third) ? 1 : unitsFromDescription(nombre);
        if (/[a-záéíóú]{3}/i.test(nombre)) products.push({
          nombre, codigo: table ? first : '', cantidad_comprada: purchased, unidades_por_empaque: pack,
          precio_empaque: price, total_linea: lineTotal, confianza: lineTotal && purchased === printedQuantity ? 'alta' : 'media',
          observacion: /\b\d+\s*x\s*1\s*$/i.test(nombre) ? 'Confirma que la indicación x1 corresponde al empaque.' : ''
        });
        continue;
      }
      if (!/^[-_\s]+$/.test(line)) recent.push(line);
      if (recent.length > 2) recent.shift();
    }
    return normalize({ productos: products, subtotal_productos: subtotal, total_factura: total ?? genericTotal, ajustes: adjustments });
  }

  function parseRosasRow(line) {
    const row = line.match(/^(?:\d{1,3}|[+]|[lI][ce]?)\s+(.+?)\s+(?:(\d+)\s*([c¢][aá]|caja|un)|([ilto]{1,3})\s*[c¢][aá])\s+(.+)$/i);
    if (!row) return null;
    const [, nombre, quantity, unit, ambiguousQuantity, tail] = row;
    if (!/[a-záéíóú]{3}/i.test(nombre)) return null;
    const prices = [...tail.matchAll(new RegExp(money, 'g'))].map(match => match[1]);
    if (prices.length !== 2) return null;
    const samePrice = moneyCents(prices[0]) === moneyCents(prices[1]);
    const cantidad_comprada = quantity ?? (ambiguousQuantity && samePrice ? 1 : null);
    return { nombre, cantidad_comprada, unidades_por_empaque: /^un$/i.test(unit ?? '') ? 1 : unitsFromDescription(nombre),
      precio_empaque: prices[0], total_linea: prices[1], confianza: ambiguousQuantity ? 'media' : 'alta',
      observacion: ambiguousQuantity ? 'Confirma la cantidad de cajas.' : '' };
  }

  function suggestedPrice(cost, quantity, margin) {
    if (!positive(cost) || !count(quantity)) return null;
    return Math.ceil((Number(cost) / Number(quantity) / (1 - margin / 100) - 1e-9) * 100) / 100;
  }

  function priceWithMarkup(cost, quantity) {
    const purchase = amount(cost);
    const units = count(quantity);
    if (purchase === null || units === null) return null;
    const unitPriceInCents = purchase / units * 150;
    return Number.isFinite(unitPriceInCents) ? Math.max(0, Math.ceil(unitPriceInCents - 1e-9)) / 100 : null;
  }

  const invoice = { normalize, parseText, suggestedPrice, priceWithMarkup, moneyCents, reconcile, preferReading, detectFormat,
    isDairyInvoice: text => detectFormat(text) === 'dairy' };
  if (typeof module === 'object') module.exports = invoice;
  else window.PorcentoFactura = invoice;
})();
