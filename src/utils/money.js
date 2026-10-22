const precisions = require('./currency-precision.json');
function money(currency = 'PHP') {
  const digits = Object.hasOwn(precisions, currency) ? precisions[currency] : 2;
  const scale = 10 ** digits;
  const units = value => Math.round(value * scale);
  const valid = (value, allowZero = false) => typeof value === 'number' && Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0) && Number.isSafeInteger(units(value)) &&
    Number(value.toFixed(digits)) === value;
  const readUnits = value => {
    if (!valid(value, true)) {
      const error = new Error(`Existing ${currency} amounts do not match its native precision. Review the original records before calculating balances.`);
      error.code = 'CURRENCY_PRECISION_CONFLICT';
      throw error;
    }
    return units(value);
  };
  const round = value => units(value) / scale;
  const sum = values => values.reduce((total, value) => total + readUnits(value), 0) / scale;
  const label = digits === 0 ? 'whole units' : `at most ${digits} decimal places`;
  return { digits, scale, units, readUnits, valid, round, sum, label };
}
module.exports = { money };
