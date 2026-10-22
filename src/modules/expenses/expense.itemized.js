const mongoose = require('mongoose');
const { money } = require('../../utils/money');

const MAX_ITEMS = 100;
function calculateItemizedExpense({ amount, items, currency }) {
  const m = money(currency);
  if (!m.valid(amount)) return { error: `Expense amount must be positive with ${m.label}.` };
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) return { error: `Add between 1 and ${MAX_ITEMS} items.` };
  const normalized = [];
  const shares = new Map();
  let total = 0n;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const fail = message => ({ error: `Item ${index + 1}: ${message}` });
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Invalid item.');
    if (typeof item.description !== 'string' || !item.description.trim() || item.description.trim().length > 200) return fail('Enter a description of up to 200 characters.');
    const quantity = item.quantity === undefined ? 1 : item.quantity;
    if (!money('KWD').valid(quantity) || quantity > 1000000) return fail('Quantity must be positive, at most 1,000,000 and have up to 3 decimals.');
    if (!m.valid(item.amount, true)) return fail(`Line total must be nonnegative with ${m.label}.`);
    if (!Array.isArray(item.memberIds) || !item.memberIds.length || item.memberIds.some(id => !mongoose.isObjectIdOrHexString(id))) return fail('Assign at least one valid group member.');
    const memberIds = item.memberIds.map(id => String(id).toLowerCase());
    if (new Set(memberIds).size !== memberIds.length) return fail('A member can only be assigned once per item.');
    const units = BigInt(m.units(item.amount));
    total += units;
    const base = units / BigInt(memberIds.length);
    const remainder = units % BigInt(memberIds.length);
    memberIds.forEach((id, i) => shares.set(id, (shares.get(id) ?? 0n) + base + (i === 0 ? remainder : 0n)));
    normalized.push({ description: item.description.trim(), quantity, amount: m.round(item.amount), memberIds });
  }
  if (total !== BigInt(m.units(amount))) return { error: 'Item totals must equal the expense amount. Include tax or tip as separate assigned items.' };
  return {
    splitType: 'ITEMIZED', items: normalized,
    participants: [...shares].map(([userId, units]) => ({ userId, amount: Number(units) / m.scale, percentage: null })),
  };
}
module.exports = { calculateItemizedExpense, MAX_ITEMS };
