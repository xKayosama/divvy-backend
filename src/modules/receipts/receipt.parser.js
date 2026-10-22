const currencyCodes = require('../groups/group.currencies.json');
const { money: currencyMoney } = require('../../utils/money');
const { validateReceipt } = require('./receipt.schema');

function parseReceipt(text, confidence = 100) {
  const lines = text.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const receipt = {
    isReceipt: false, merchant: null, date: null, currency: null,
    subtotal: null, tax: null, tip: null, total: null, items: [],
    warnings: ['Local OCR uses receipt text patterns. Review every extracted value before saving.']
  };
  if (confidence < 70) receipt.warnings.push('Receipt text recognition confidence is low. Try a clearer image.');
  const currencies = new Set();
  for (const [code, pattern] of [['PHP', /\b(?:PHP|PESO[S]?)\b|₱/i], ['USD', /\bUSD\b|US\$/i], ['EUR', /\bEUR\b|€/i], ['GBP', /\bGBP\b|£/i]]) {
    if (pattern.test(text)) currencies.add(code);
  }
  const codePattern = currencyCodes.join('|');
  for (const match of text.matchAll(new RegExp(`\\b(${codePattern})\\s+\\d`, 'g'))) currencies.add(match[1]);
  for (const line of lines) {
    const match = line.match(new RegExp(`^(?:Currency:\\s*)?(${codePattern})$`, 'i'));
    if (match) currencies.add(match[1].toUpperCase());
  }
  receipt.currency = currencies.size === 1 ? [...currencies][0] : null;
  if (!receipt.currency) receipt.warnings.push('Currency is missing or ambiguous; confirm it matches the Group currency.');

  const dates = new Set();
  const validDate = (year, month, day) => {
    const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) dates.add(value);
  };
  for (const match of text.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)) validDate(match[1], match[2], match[3]);
  for (const match of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/g)) {
    const a = Number(match[1]), b = Number(match[2]);
    if (a > 12) validDate(match[3], b, a);
    else if (b > 12 || a === b) validDate(match[3], a, b);
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthPattern = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  for (const match of text.matchAll(new RegExp(`\\b${monthPattern}\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'gi'))) validDate(match[3], months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1, match[2]);
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${monthPattern},?\\s+(20\\d{2})\\b`, 'gi'))) validDate(match[3], months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1, match[1]);
  receipt.date = dates.size === 1 ? [...dates][0] : null;
  if (!receipt.date) receipt.warnings.push('Receipt date is missing, ambiguous, or invalid.');

  // Only accept a clearly labelled trailing amount, not card numbers or dates.
  const decimals = receipt.currency ? currencyMoney(receipt.currency).digits : 3;
  const fraction = decimals === 0 ? '' : `(?:\\.\\d{1,${decimals}})?`;
  const money = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)' + fraction;
  const suffix = new RegExp(`(?:${codePattern}|US\\$|[$₱€£])?\\s*(${money})\\s*$`, 'i');
  const labels = [
    ['subtotal', /^sub[ -]?total\b/i],
    ['tax', /^(?:tax|vat|sales tax)\b/i],
    ['tip', /^(?:tip|gratuity)\b/i],
    ['total', /^(?:grand total|total amount|amount due|total due|total)\b/i]
  ];
  const values = { subtotal: [], tax: [], tip: [], total: [] };
  for (const line of lines) {
    const label = labels.find(([, pattern]) => pattern.test(line));
    if (label) {
      const remainder = line.replace(label[1], '').replace(/^\s*[:=]\s*/, '');
      // Avoid misreading "TOTAL ITEMS 2" or "TOTAL SAVINGS 10" as a payable total.
      if (new RegExp(`^\\s*(?:${codePattern}|US\\$|[$₱€£])?\\s*${money}\\s*$`, 'i').test(remainder)) {
        values[label[0]].push(Number(remainder.match(suffix)[1].replace(/,/g, '')));
      }
      continue;
    }
    if (/\b(?:cash|change|tender|balance|payment|card|discount|savings|tax|vat|total|date|time|receipt|invoice|tel|phone|vatable|vat-exempt|taxable)\b/i.test(line)) continue;
    // Require decimals on item prices so address/phone/header numbers aren't items.
    const itemDigits = receipt.currency ? decimals : '2,3';
    const item = decimals === 0 ? null : line.match(new RegExp(`^(.+?[A-Za-z].*?)\\s+(?:${codePattern}|US\\$|[$₱€£])?\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{${itemDigits}})\\s*$`, 'i'));
    if (item) {
      let description = item[1].trim();
      let quantity = null, unitPrice = null;
      const explicit = description.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*[x×@]\\s*(\\d+\\.\\d{${itemDigits}})\\s+(.+)$`, 'i'));
      if (explicit) { quantity = Number(explicit[1]); unitPrice = Number(explicit[2]); description = explicit[3]; }
      receipt.items.push({ description, quantity, unitPrice, total: Number(item[2].replace(/,/g, '')) });
    }
  }
  for (const [field, candidates] of Object.entries(values)) {
    const unique = [...new Set(candidates)];
    receipt[field] = unique.length === 1 ? unique[0] : null;
    if (unique.length > 1) receipt.warnings.push(`Multiple different ${field} values found; select the correct receipt value.`);
  }
  receipt.isReceipt = (receipt.total !== null && (/\b(?:receipt|invoice|subtotal|sub total|vat|tax|cash|change)\b/i.test(text) || receipt.items.length > 0)) || (/\b(?:receipt|invoice)\b/i.test(text) && receipt.items.length > 0);
  if (receipt.isReceipt) {
    const merchant = lines.find(line => /[A-Za-z]/.test(line) && !/\d|\b(?:receipt|invoice|date|total|tax|vat|cash|thank|welcome)\b/i.test(line));
    receipt.merchant = merchant || null;
    receipt.warnings.push('Merchant is inferred from the receipt heading; confirm its name.');
  }
  if (receipt.total === null) receipt.warnings.push('A clear payable total could not be found.');
  return validateReceipt(receipt);
}

module.exports = { parseReceipt };
