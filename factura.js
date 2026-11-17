(function () {
  'use strict';

  const money = '(-?(?:US\\$|USD\\s*\\$?|\\$)?\\s*(?:\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d{1,7}[.,]\\d{2}))';
  const amount = value => {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
    const number = Number(value.replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  };
  const count = value => {
    const n = amount(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  function moneyCents(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    const match = text.match(/^(-?)(?:US\$|USD\s*\$?|\$)?\s*(\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:([.,])(\d{1,2}))?\s*(?:USD)?$/i);
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
    const verified = rows.length > 0 && pending === 0 && !totals.partial && !totals.conflictingTotal && !totals.foreignCurrency && !adjustments.includes(null)
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
      /\b(\d{1,4})\s*[-/]\s*\d+(?:[.,]\d+)?\s*(?:fl\s*oz|oz|ml|gr|g|gal|lt|lit(?:er|re)s?|l|lb|ct|pk|sticks?|drops?)\b/i,
      /\b(\d{1,4})\s*[x/]\s*1\s*$/i,
      /\b(?:case|caja|pack)\s*(?:of|de|x|:)?\s*(\d{1,4})\b/i,
      /\b(\d{1,3})\s*-\s*\d/
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
      const mismatch = raw.importe_dudoso || (line !== null && reconstructed !== null && line !== reconstructed);
      if (directQuantity && computedQuantity && directQuantity !== computedQuantity) warnings.push('Las unidades indicadas difieren de la cantidad de empaques por sus unidades.');
      if (mismatch) warnings.push(raw.importe_dudoso ? 'Confirma el importe neto impreso y sus descuentos o cargos.' : 'La cantidad comprada por el precio del empaque difiere del importe impreso.');
      if (!quantity) warnings.push(pcs ? 'Confirma si las piezas impresas corresponden a unidades vendibles.' : 'Confirma las unidades vendibles.');
      if (line === null) warnings.push('Confirma el importe impreso de la línea.');
      if (raw.confianza === 'baja') warnings.push('Lectura dudosa.');
      if (typeof raw.observacion === 'string' && raw.observacion.trim()) warnings.push(raw.observacion.trim().slice(0, 260));
      const codigo = String(raw.codigo ?? '').trim();
      const parts = [
        packages && pack && pack > 1 ? packages + ' × ' + pack : '',
        packages && !pack ? packages + (packages === 1 ? ' caja' : ' cajas') : ''
      ].filter(Boolean);
      return {
        nombre, codigo, codigoTipo: raw.codigo_tipo || '',
        costo: cost === null ? '' : (cost / 100).toFixed(2), cantidad: quantity || '',
        costUnconfirmed: line === null || raw.importe_dudoso === true,
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
    if (/\bAZ\s+METR[O0]\s+DISTRIBUT|\bCASES\b[^\n]*\bDESCRIPTION\b[^\n]*\b(?:DISCOUNT|DEPOSIT)\b/i.test(text)) return 'azmetro';
    if (/\bJER[A-Z]{2,4}\s+DA[I1]RY\b|ADDS\s*\/\s*CUTS[^\n]*DESCRIPTION|CASE\s*\/\s*UN[I1T]+[^\n]*\bPCS\b/i.test(text)) return 'dairy';
    if (/\bAAA[\s.]+WHOLESALE\b/i.test(text) || (text.match(/^[\s'"]*[IlTt]tem\s*No\s*[.:]+\s*\d{4,8}/gim) || []).length >= 2) return 'aaa';
    if (/\bTA[IÍ1L]NO\s+(?:TRADING|TRAD)|\bUPC\b[^\n]*\b(?:QUANTITY|QTY|PRICE EACH)\b/i.test(text)) return 'taino';
    if (/\bROSAS\s+A\b|\bPRODUCTO[S]?\s+CANT(?:IDAD)?\.?\s+PRECIO\s+TOTAL\b/i.test(text)) return 'rosas';
    return '';
  }

  function hasForeignCurrency(text) {
    const codes = '(?:EUR|GBP|CAD|MXN|DOP|JPY|COP|BRL|PEN|ARS|CLP|AUD|CHF|CNY)';
    const price = '(?:\\d{1,3}(?:[.,]\\d{3})+|\\d{1,9})[.,]\\d{2}(?!\\d)';
    const label = '(?:[€£¥]|\\b(?:RD|MX|CA|AU)\\$)';
    return new RegExp(label + '[ \\t]*' + price + '|' + price + '[ \\t]*[€£¥]|\\b' + codes + '[ \\t]+(?:[$€£¥][ \\t]*)?\\d|' + price + '[ \\t]*' + codes + '\\b', 'i').test(text);
  }

  const azMoney = new RegExp('^' + money + '$', 'i');
  const azLine = new RegExp('^[|\\s]*([1-9]\\d{0,3})\\s+([0-9]{2,6})\\s+(.+?)\\s+(\\d{11,14})' + ('\\s+' + money).repeat(5) + '$', 'i');

  function azProduct({ cases, name, upc, price, discount, deposit, tax, total }) {
    name = name.replace(/^[|_\\/\[{]+|[|_]+$/g, '').trim().replace(/\b0[Z2]\b/g, 'OZ')
      .replace(/^[Z2](?=\s+\d+\s+OZ\s+TALLBOY\b)/i, 'AZ');
    const pack = count(name.match(/\b(\d{1,3})\s*(?:PK|PACK|P)\b/i)?.[1]) ?? unitsFromDescription(name);
    const costo = moneyCents(total);
    const base = moneyCents(price), off = moneyCents(discount), fee = moneyCents(deposit), lineTax = moneyCents(tax);
    const components = [base, off, fee, lineTax];
    const inferred = costo !== null && base > 0 && components.every(value => value !== null)
      ? count((costo + Math.abs(off) - fee - lineTax) / base) : null;
    const printedCases = count(cases) ?? inferred;
    const validUpc = isRetailCode(upc);
    const expected = printedCases && components.every(value => value !== null)
      ? printedCases * base - Math.abs(off) + fee + lineTax : null;
    return {
      nombre: name, codigo: upc, cantidad_comprada: printedCases, unidades_por_empaque: pack,
      total_linea: total, importe_dudoso: expected !== null && costo !== expected,
      observacion: [printedCases ? '' : 'Confirma la cantidad de cajas impresa.',
        validUpc ? '' : 'Confirma el UPC impreso.'].filter(Boolean).join(' '),
      codigo_tipo: validUpc ? '' : 'interno'
    };
  }

  function isRetailCode(code) {
    return /^(?:\d{8}|\d{12,14})$/.test(code) && [...code].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0;
  }

  function readAzTable(tableWords, blockWords = tableWords) {
    // A UPC anchors each row even when the grid splits the description and prices into separate OCR blocks.
    const x = word => word.x + word.width / 2;
    const y = word => word.y + word.height / 2;
    const upcs = tableWords.filter(word => /^\d{11,14}$/.test(word.text)).sort((a, b) => y(a) - y(b));
    if (upcs.length < 2) return [];
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const center = median(upcs.map(x));
    const pitch = median(upcs.slice(1).map((word, i) => y(word) - y(upcs[i])));
    const height = median(upcs.map(word => word.height));
    if (pitch < height * 1.1 || upcs.some(word => Math.abs(x(word) - center) > height * 2.5)) return [];

    const prices = tableWords.filter(word => x(word) > center + height * 4 && azMoney.test(word.text));
    if (!prices.length) return [];
    const right = Math.max(...prices.map(x));
    const span = right - center;
    if (span < height * 18) return [];
    const leading = blockWords.filter(word => /^(?:[1-9]\d{0,2}|[|!'Il])$/.test(word.text) && x(word) < center - span * .83 && x(word) > center - span * .94);
    const descriptions = tableWords.filter(word => x(word) > center - span * .72 && word.x + word.width < center - span * .075);
    const net = prices.filter(word => x(word) > right - span * .08).sort((a, b) => y(a) - y(b));
    const column = (from, to) => [prices, blockWords].map(words => words.filter(word =>
      azMoney.test(word.text) && x(word) >= center + span * from && x(word) < center + span * to));
    const priceColumn = column(.12, .25), discountColumn = column(.32, .47);
    const depositColumn = column(.48, .65), taxColumn = column(.69, .86);
    const nearest = (words, rowY, tolerance) => words.reduce((best, word) =>
      Math.abs(y(word) - rowY) < Math.abs((best ? y(best) : rowY + tolerance) - rowY) ? word : best, null);
    const products = [];
    for (const upc of upcs) {
      const rowY = y(upc);
      const total = nearest(net, rowY, pitch * .45);
      if (!total) continue;
      const description = descriptions.filter(word => Math.abs(y(word) - rowY - (x(word) - center) * .035) < pitch * .40)
        .sort((a, b) => a.x - b.x).map(word => word.text).join(' ');
      if (!/[a-z]{3}/i.test(description)) continue;
      const prices = passes => [...new Set(passes.map(words => nearest(words, rowY, pitch * .40)?.text))];
      const qty = nearest(leading, rowY - height, pitch * .36)?.text;
      const deposit = prices(depositColumn).find(Boolean), tax = prices(taxColumn).find(Boolean);
      const discounts = prices(discountColumn), basePrices = prices(priceColumn);
      const [base, discount] = basePrices.flatMap(base => discounts.map(discount => [base, discount])).find(([base, discount]) => {
        const components = [base, discount, deposit, tax].map(moneyCents);
        if (components.some(value => value === null) || components[0] <= 0) return false;
        const [price, off, fee, lineTax] = components;
        const inferredCases = (moneyCents(total.text) + Math.abs(off) - fee - lineTax) / price;
        return count(qty) ? inferredCases === count(qty) : /[|!'Il]/.test(qty ?? '') ? inferredCases === 1 : count(inferredCases);
      }) ?? [basePrices.find(Boolean), discounts.find(Boolean)];
      products.push(azProduct({ cases: qty, name: description, upc: upc.text, total: total.text, price: base, discount, deposit, tax }));
    }
    return normalize({ productos: products }).rows;
  }

  function azFooter(line) {
    const match = line.replace(/^[\s|_:=~—–*'-]+/, '').match(/^(fuel\s*charges?|surcharge|allowance|deposits|credits|sub\s*total|please pay this\s+amount)\b[\s|_:~—–]*([\s\S]*)$/i);
    if (!match) return null;
    return { label: match[1].replace(/\s+/g, ' ').toLowerCase(), tail: match[2].replace(/[|_\s]+$/g, '') };
  }

  function productName(name) {
    let text = String(name || '').replace(/^[|Il¡_:=\-\s.]+/, '').trim();
    const junk = /^(?:[A-Za-z0-9]*\d[A-Za-z0-9]*|[A-Za-z]{1,2}[=+]|[BCDFGHJKLMNPQRSTVWXYZ]{1,2})\s+/i;
    const soft = /^(?!la\b|el\b|de\b|un\b|os\b|en\b)[A-Za-z]{2}\s+/i;
    while (junk.test(text) || soft.test(text)) {
      const next = text.replace(junk, '').replace(soft, '');
      if (!/[A-Za-zÁÉÍÓÚáéíóúñÑ]{4}/.test(next)) break;
      text = next;
    }
    return text.replace(/\s+(?!la$|el$|de$|oz$|ml$|gr$|lb$|pk$|ct$|ea$|un$|dz$)[A-Za-z]{1,2}$/i, '').replace(/\s+(?:ect|etc)$/i, '').trim();
  }

  function packSize(name, format) {
    const typed = unitsFromDescription(name);
    if (typed || format !== 'aaa') return typed;
    const loose = String(name).match(/\b(\d{1,3})\s*-(?:\s*$|\s+\S)/);
    return count(loose?.[1]);
  }

  function receiptLine(text) {
    let line = text.replace(/\bD[X×]\b/gi, 'bx');
    line = line.replace(/^[^\dA-Za-z]*[Il¡|][A-Za-z]{0,3}\s+(?=(?:cases?|cs|bx|box|bags?|bg|dz|pk|packs?|pack|each|ea)s?\b)/i, '1 ');
    const tail = line.match(/\s+(\S+)\s*$/);
    const brokenTail = tail && /^(?:[A-Za-z]+\.?\d{0,2}%?|\d{1,4}[.,]%+)$/.test(tail[1]);
    if (brokenTail && new RegExp(money + '\\s*$', 'i').test(line.slice(0, tail.index))) line = line.slice(0, tail.index).trim();
    return line;
  }

  function pricesAgree(quantity, unitPrice, lineTotal) {
    const qty = count(quantity);
    const unit = moneyCents(unitPrice);
    const total = moneyCents(lineTotal);
    return unit !== null && total !== null && qty !== null && qty * unit === total;
  }

  function parseText(text, { dairy, format = dairy === true ? 'dairy' : detectFormat(text) } = {}) {
    text = text.replace(/(^|\s)[€£§]\s+(?=\d)/g, '$1@ ').replace(/(\d{1,4}\s*(?:cases?|cs|bx|box(?:es)?|bags?|bg|pk|packs?|each|ea)s?)\s+[0-9eE€£§©&Uu]\s+(?=\d)/gi, '$1 @ ');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const recent = [];
    const products = [];
    const quantity = format === 'taino' ? '[0-9]+|[ilI]' : '[0-9]+';
    const textRow = new RegExp('^\\s*\\d{1,4}\\s+(.+?)\\s+(\\d+)\\s*(ca(?:ja)?s?|cs|cases?|un(?:d|id(?:ades)?)?)\\s+' + money + '(?:\\s+' + money + ')?[|\\s]*$', 'i');
    const tableRow = new RegExp('^([0-9]{6,14})[|.\\s]+(.+?)\\s+(' + quantity + ')\\s+' + money + '(?:[|\\s]+' + money + ')?[|\\s]*$', 'i');
    const receiptPrice = new RegExp('^(\\d+)\\s*(cases?|cs(?:-\\d+)?|bx|box|bags?|bg|dz|pk(?:-\\d+)?|pack|each|ea)s?\\s*(?:[@&©]\\s*)?' + money + '(?:\\s+' + money + ')?[|\\s]*$', 'i');
    const dairyRow = new RegExp('^[^\\w]*([0-9]{3,6})[.,:;)]?\\s+(.*?)\\s+(\\d+)\\s+' + money + '$');
    const amountOnly = new RegExp('^' + money + '$');
    const totalLabel = /^(inv[o0][i1l]c[e3]\s+total|total this inv[o0][i1l]c[e3]|total (?:de la )?factura|total neto|grand total|net total|total incl\.? (?:tax|vat)|total con (?:impuestos|iva)|total general|importe total|sub\s*total(?:\s+de\s+productos)?|total)\b[\s:/~|]*(.*)$/i;
    const adjustmentLabel = /^(sales tax|total tax|tax|impuesto(?:s)?|itbis|vat|iva|gst|shipping(?: fee)?|freight|flete|env[ií]o|deposit(?: fee)?|dep[oó]sito|service fee|recargo|rounding|redondeo|discount|descuento)\b\s*[:/]*\s*(.*)$/i;
    const adjustments = [];
    let subtotal = null, total = null, genericTotal = null, itemCode = '', attachCode = false;
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index];
      const line = rawLine.replace(/^[|\s]+/,'').replace(/\s*\|\s*/g, ' ').replace(/(\d)\s+([.,]\d{2}\b)/g, '$1$2').replace(/(\d[.,])\s+(?=\d{2}\b)/g, '$1').trim();
      const trimmed = line.replace(/^[\s"'«»~]+|[\s\\|"'<>]+$/g, '');
      const az = format === 'azmetro' ? azFooter(rawLine) : null;
      if (az) {
        const { label, tail } = az;
        const printed = (tail || lines[index + 1] || '').match(amountOnly)?.[1];
        if (printed !== undefined) {
          if (!tail) index++;
          if (/^sub\s*total$/.test(label)) genericTotal = printed;
          else if (label === 'please pay this amount') total = printed;
          else {
            const cents = moneyCents(printed);
            const value = label === 'allowance' || label === 'credits' ? -Math.abs(cents) : cents;
            if (value !== 0) adjustments.push({ importe: value / 100 });
          }
        } else if (tail && /\d/.test(tail) && /^(?:fuel|surcharge|allowance|deposits|credits)/.test(label)) {
          adjustments.push({ importe: null });
        }
        continue;
      }
      if (format === 'azmetro') {
        const azRow = trimmed.replace(/^[^\d]+/, '').match(azLine);
        if (azRow) {
          const [, cases, , name, upc, price, discount, deposit, tax, total] = azRow;
          products.push(azProduct({ cases, name, upc, price, discount, deposit, tax, total }));
          continue;
        }
      }
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
        ? /(?:item|tem|ten|[il1|\[\(]tem|[il1|\[\(]ten|lea|frit)\s*no\.?,?\s*[:.;\s]*(\d{4,8})\b/i
        : /^[IlTt]tem\s*(?:no\.?)?\s*[:.;]*\s*(\d{4,8})\s*$/i);
      if (item) {
        const previous = products.at(-1);
        if (format === 'aaa' && attachCode && previous) {
          previous.codigo = item[1];
          itemCode = '';
        } else itemCode = item[1];
        attachCode = false;
        recent.length = 0;
        continue;
      }
      attachCode = false;
      const bill = receiptLine(trimmed).replace(/^(?:[^A-Za-z0-9]+|[A-Za-z]{1,3}\s+(?=\d))/, '').replace(/\s+[A-Za-z]{1,3}\s+(?=\d+[.,]\d{2}\s*$)/, ' ').match(receiptPrice);
      if (bill && recent.length) {
        const [, purchased, type, price, lineTotal] = bill;
        const name = productName(recent.at(-1));
        const typeIsExplicitUnit = /^(ea|each)$/i.test(type);
        const mappedSize = packSize(name, format);
        const dozens = type.toLowerCase() === 'dz' ? 12 : null;
        const retailBundle = /\b\d+\s*[-/]\s*\d+\s*(?:ct|pk)\b/i.test(name) || /\b(?:case|cs|pk)-\d+\b/i.test(type);
        const ambiguousEach = typeIsExplicitUnit && /\b\d{1,4}\s*[-/]\s*\d/.test(name);
        const agreed = pricesAgree(purchased, price, lineTotal || price);
        if (/[a-záéíóú]{4}/i.test(name) && !/\b(?:address|subtotal|amount|credit cards|market|change|invoice)\b/i.test(name) && !/^\d+\s*(?:cases?|cs|bx|box|bags?|pk|packs?|each|ea)s?$/i.test(name)) {
          products.push({
            nombre: name, codigo: itemCode, codigo_tipo: 'interno', cantidad_comprada: purchased,
            unidades_por_empaque: retailBundle || ambiguousEach ? null : dozens ?? mappedSize ?? (typeIsExplicitUnit ? 1 : null),
            precio_empaque: lineTotal && !agreed ? '' : price, total_linea: lineTotal || price,
            confianza: lineTotal && agreed ? 'alta' : 'media'
          });
          attachCode = true;
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
          products.push({ nombre, codigo, codigo_tipo: 'interno', piezas_facturadas: pcs, total_linea,
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
      const shelf = trimmed.match(new RegExp('^(.+?[A-Za-zÁÉÍÓÚáéíóúñÑ]{3}.*?)\\s+(\\d{1,4})\\s+(?:' + money + '\\s+)?' + money + '\\s*$', 'i'));
      const qtyOnly = !shelf && trimmed.match(new RegExp('^(\\d{1,4})\\s+(?:' + money + '\\s+)?' + money + '\\s*$', 'i'));
      const shelfName = shelf ? shelf[1].replace(/^[^\wÁÉÍÓÚáéíóúñÑ]+/, '').trim() : (qtyOnly && recent.length ? recent.at(-1) : '');
      const shelfQty = shelf ? shelf[2] : qtyOnly?.[1];
      const shelfUnit = shelf ? (shelf[4] ? shelf[3] : '') : (qtyOnly?.[3] ? qtyOnly[2] : '');
      const shelfTotal = shelf ? (shelf[4] || shelf[3]) : (qtyOnly?.[3] || qtyOnly?.[2]);
      const shelfLooksNamed = /[A-Za-zÁÉÍÓÚáéíóúñÑ]{5}/.test(shelfName) && !/^\d+\s*(?:cases?|cs|bx|box|bags?|pk|packs?|each|ea)s?$/i.test(shelfName);
      const shelfAgrees = !shelfUnit || pricesAgree(shelfQty, shelfUnit, shelfTotal);
      if (shelfLooksNamed && shelfAgrees && shelfQty && shelfTotal && !/\b(?:sub\s*total|grand\s+total|invoice\s+total|total|tax|impuesto|itbis|factura|balance|change|vuelto|cash|efectivo|visa|mastercard|amount|pago|shipping|freight|discount|descuento|page|p[aá]gina|description|cantidad|amount)\b/i.test(shelfName)) {
        products.push({
          nombre: productName(shelfName), codigo: itemCode, codigo_tipo: itemCode ? 'interno' : '',
          cantidad_comprada: shelfQty, unidades_por_empaque: unitsFromDescription(shelfName),
          precio_empaque: shelfUnit, total_linea: shelfTotal, confianza: 'alta'
        });
        recent.length = 0;
        itemCode = '';
        continue;
      }
      if (!/^[-_\s]+$/.test(line) && !new RegExp(money + '\\s*$', 'i').test(line) && !/^\d+\s*(?:cases?|cs|bx|box|bags?|pk|packs?|each|ea)s?\b/i.test(trimmed)) recent.push(productName(line));
      if (recent.length > 2) recent.shift();
    }
    const unique = collapseRows(products);
    const result = normalize({ productos: unique, subtotal_productos: subtotal, total_factura: total ?? genericTotal, ajustes: adjustments });
    result.totals.foreignCurrency = hasForeignCurrency(text);
    return result;
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

  const columnNames = [
    ['unitPrice', /^(?:unit\s+(?:price|cost)|price\s+each|precio\s+(?:por\s+unidad|unitario)|p\.?\s*u\.?)$/i],
    ['description', /^(?:item\s+description|product\s+description|description|descripci[oó]n|producto[s]?|art[ií]culo[s]?|concepto|item\s+name)$/i],
    ['quantity', /^(?:qty\.?|quantity|cantidad|cant\.?|pcs\.?|piezas|units|unidades)$/i],
    ['amount', /^(?:line\s+total|line\s+amount|extended\s+(?:price|amount)|ext\.?\s+price|importe|amount|total|neto)$/i],
    ['code', /^(?:sku|upc|ean|item\s*(?:no\.?|number|code)|c[oóé]digo|ref\.?)$/i],
    ['measure', /^(?:uom|u\/m|u\.?m\.?|unit\s+of\s+measure|unidad)$/i],
    ['lineDiscount', /^(?:discount|descuento)$/i],
    ['other', /^(?:tax|impuesto|vat|iva|price|precio|cost|costo)$/i]
  ];

  function tsvWords(tsv) {
    if (typeof tsv !== 'string') return [];
    return tsv.split(/\r?\n/).slice(1).flatMap(line => {
      const cells = line.split('\t');
      if (cells[0] !== '5' || !cells[11]?.trim()) return [];
      const [x, y, width, height] = cells.slice(6, 10).map(Number);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
      return [{ text: cells[11].trim(), x, y, width, height }];
    });
  }

  function visualRows(words) {
    const center = word => word.y + word.height / 2;
    const rows = [];
    for (const word of [...words].sort((a, b) => center(a) - center(b) || a.x - b.x)) {
      const row = rows.at(-1);
      if (row && Math.abs(row.center - center(word)) < Math.max(row.height, word.height) * .48) row.words.push(word);
      else rows.push({ center: center(word), height: word.height, words: [word] });
    }
    return rows.map(row => row.words.sort((a, b) => a.x - b.x));
  }

  function invoiceColumns(words) {
    const columns = [];
    for (let index = 0; index < words.length;) {
      let matched = false;
      for (let length = Math.min(3, words.length - index); length > 0; length--) {
        const phrase = words.slice(index, index + length).map(word => word.text).join(' ').replace(/:$/, '');
        const field = columnNames.find(([, label]) => label.test(phrase));
        if (!field) continue;
        const first = words[index], last = words[index + length - 1];
        const center = (first.x + last.x + last.width) / 2;
        columns.push({ name: field[0], center });
        index += length;
        matched = true;
        break;
      }
      if (!matched) index++;
    }
    const names = columns.map(column => column.name);
    return names.includes('description') && names.includes('amount') && names.includes('quantity')
      && names.filter(name => name === 'amount').length === 1 ? columns : null;
  }

  function chooseTableReading(current, candidate) {
    return candidate.rows.length && preferReading(current, candidate) ? candidate : current;
  }

  function readColumns(words, format) {
    const rows = visualRows(words);
    const products = [];
    let columns = null;
    let previous = null;
    for (const row of rows) {
      const headers = invoiceColumns(row);
      if (headers) {
        columns = headers;
        previous = null;
        continue;
      }
      if (!columns) continue;
      const visible = row.map(word => word.text).join(' ');
      if (/^(?:sub\s*total|(?:grand|invoice|net|final)\s+total|total\b|tax\b|sales tax|vat\b|iva\b|impuesto|discount|descuento|shipping|env[ií]o|amount due|balance due|saldo|payment|pago)\b/i.test(visible)) {
        columns = null;
        previous = null;
        continue;
      }
      const values = Object.create(null);
      for (const word of row) {
        const center = word.x + word.width / 2;
        const column = columns.findIndex((col, i) => i === columns.length - 1 || center < (col.center + columns[i + 1].center) / 2);
        const name = columns[column].name;
        (values[name] ||= []).push(word.text);
      }

      const description = (values.description ?? []).join(' ');
      const amountText = (values.amount ?? []).join(' ').replace(/\s+(?=[.,]\d{2}\b)|(?<=[.,])\s+(?=\d{2}\b)/g, '');
      const cost = /\d[.,]\d{2}$/.test(amountText) ? moneyCents(amountText) : null;
      const qtyText = (values.quantity ?? []).join(' ');
      const qty = count(qtyText);
      if (cost === null) {
        if (previous && description && !values.amount && !values.quantity && !values.code && !values.unitPrice && !values.other && !values.measure && !values.lineDiscount) {
          previous.nombre += ' ' + description;
        } else previous = null;
        continue;
      }
      if (!/[a-záéíóúñ]{2}/i.test(description)) {
        previous = null;
        continue;
      }
      const measure = (values.measure ?? []).join(' ');
      const pack = unitsFromDescription(description);
      const ambiguous = /\b(?:cases?|cajas?|packs?|ctn|cartons?|box(?:es)?|kg|lb|lbs)\b|\b\d+\s*\/\s*C\b/i.test(measure + ' ' + description);
      const confirmPack = (format === 'taino' && !pack) || (ambiguous && !pack);
      const unitPrice = moneyCents((values.unitPrice ?? []).join(' '));
      const discount = moneyCents((values.lineDiscount ?? []).join(' '));
      const discountMatches = qty !== null && unitPrice !== null && discount !== null &&
        qty * unitPrice - Math.abs(discount) === cost;
      previous = {
        nombre: description, codigo: values.code?.join(''), codigo_tipo: format === 'dairy' || format === 'aaa' ? 'interno' : '',
        cantidad_comprada: qty,
        unidades_por_empaque: pack ?? (confirmPack ? null : 1),
        precio_empaque: unitPrice === null || discountMatches ? null : unitPrice / 100,
        total_linea: cost / 100,
        observacion: confirmPack ? 'Confirma las unidades vendibles o el contenido del empaque.' : ''
      };
      products.push(previous);
    }
    return normalize({ productos: products }).rows;
  }

  function readEmbeddedInvoice(words, format) {
    if (!words?.length) return null;
    const text = visualRows(words).map(row => row.map(word => word.text).join(' ')).join('\n');
    const parsed = parseText(text, { format: format || undefined });
    const reading = chooseTableReading(parsed, { rows: readColumns(words, format || detectFormat(text)), totals: parsed.totals });
    return { text, reading };
  }

  function rowIdentity(row) {
    const name = productName(row.nombre).replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
    const cases = count(row.cantidad_comprada) || count(String(row.info || '').match(/^(\d+)\b/)?.[1]);
    return { name, code: String(row.codigo || '').trim(), cost: moneyCents(row.costo ?? row.total_linea), cases };
  }

  function namesMatch(left, right) {
    if (!left || !right || left.length < 8 || right.length < 8) return false;
    if (left === right) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    const rest = longer.slice(shorter.length);
    const head = longer.slice(0, longer.length - shorter.length);
    return (longer.startsWith(shorter) && /^\d+$/.test(rest)) || (longer.endsWith(shorter) && /^[a-z]+$/.test(head));
  }

  function collapseRows(rows) {
    const kept = [];
    for (const row of rows) {
      const index = kept.findIndex(saved => {
        const left = rowIdentity(saved);
        const right = rowIdentity(row);
        if (!namesMatch(left.name, right.name)) return false;
        if (left.code && right.code && left.code === right.code) return true;
        if (left.cost !== null && left.cost === right.cost) return true;
        const suffix = left.name !== right.name && (left.name.endsWith(right.name) || right.name.endsWith(left.name));
        return Boolean(left.cases && left.cases === right.cases && suffix);
      });
      if (index < 0) {
        kept.push(row);
        continue;
      }
      const saved = rowIdentity(kept[index]);
      const next = rowIdentity(row);
      const longer = next.name.length > saved.name.length;
      const costlier = next.name.length === saved.name.length && (next.cost || 0) > (saved.cost || 0);
      if (longer || costlier) kept[index] = row;
    }
    return kept;
  }

  function unitCost(cost, quantity) {
    const cents = moneyCents(cost);
    const units = count(quantity);
    return cents !== null && cents >= 0 && units !== null ? cents / 100 / units : null;
  }

  function suggestedPrice(cost, quantity, margin) {
    const perUnit = unitCost(cost, quantity);
    return perUnit > 0 ? Math.ceil((perUnit / (1 - margin / 100) - 1e-9) * 100) / 100 : null;
  }

  function priceWithMarkup(cost, quantity) {
    const purchase = amount(cost);
    const units = count(quantity);
    if (purchase === null || units === null) return null;
    const unitPriceInCents = purchase / units * 150;
    return Number.isFinite(unitPriceInCents) ? Math.max(0, Math.ceil(unitPriceInCents - 1e-9)) / 100 : null;
  }

  const invoice = { normalize, parseText, collapseRows, unitCost, suggestedPrice, priceWithMarkup, moneyCents, reconcile, preferReading, detectFormat, readColumns, tsvWords, chooseTableReading, readEmbeddedInvoice, readAzTable,
    isDairyInvoice: text => detectFormat(text) === 'dairy' };
  if (typeof module === 'object') module.exports = invoice;
  else window.PorcentoFactura = invoice;
})();
