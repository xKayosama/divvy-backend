const { money } = require('../../utils/money');
const MAX_SHARE_WEIGHT = 1000000;

function calculateSharesExpense({ amount, participants, currency }) {
  const m = money(currency);
  if (!m.valid(amount)) return { error: `Expense amount must be positive with ${m.label}.` };
  if (!Array.isArray(participants) || !participants.length || participants.some(p =>
    typeof p.shares !== 'number' || !Number.isInteger(p.shares) || p.shares < 1 || p.shares > MAX_SHARE_WEIGHT)) {
    return { error: 'Each participant must have a whole number of shares from 1 to 1,000,000.' };
  }
  const total = BigInt(m.units(amount));
  const totalWeight = participants.reduce((sum, p) => sum + BigInt(p.shares), 0n);
  const parts = participants.map((p, index) => {
    const numerator = total * BigInt(p.shares);
    return { index, units: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  const remaining = total - parts.reduce((sum, p) => sum + p.units, 0n);
  const ordered = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < Number(remaining); index++) ordered[index].units++;
  return { splitType: 'SHARES', participants: participants.map((p, i) => ({
    userId: p.userId, shares: p.shares, amount: Number(parts[i].units) / m.scale, percentage: null,
  })) };
}
module.exports = { calculateSharesExpense, MAX_SHARE_WEIGHT };
