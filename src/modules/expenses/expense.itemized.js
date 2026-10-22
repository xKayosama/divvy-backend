const mongoose = require('mongoose');
const { money } = require('../../utils/money');

const MAX_ITEMS = 100;
function calculateItemizedExpense({ amount, items, currency, adjustments }) {
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
  if (adjustments?.toObject) adjustments = adjustments.toObject();
  if (adjustments !== undefined && (!adjustments || typeof adjustments !== 'object' || Array.isArray(adjustments) || Object.keys(adjustments).some(key => !['tax', 'tip'].includes(key)))) return { error: 'Adjustments must contain only tax and tip.' };
  const normalizedAdjustments = {};
  const baseShares = [...shares.values()];
  for (const key of ['tax', 'tip']) {
    const charge = adjustments?.[key];
    if (charge === undefined) continue;
    if (!charge || typeof charge !== 'object' || Array.isArray(charge) || !m.valid(charge.amount, true) || !['EQUAL', 'PROPORTIONAL'].includes(charge.allocation)) return { error: `${key}: enter a nonnegative amount with ${m.label} and EQUAL or PROPORTIONAL allocation.` };
    const units = BigInt(m.units(charge.amount));
    const weights = baseShares.map(value => charge.allocation === 'EQUAL' ? 1n : value);
    const denominator = weights.reduce((sum, value) => sum + value, 0n);
    if (units > 0n && denominator === 0n) return { error: `Cannot allocate ${key} proportionally when item totals are zero. Choose equal allocation.` };
    if (units > 0n) {
      const parts = weights.map((weight, index) => ({ index, units: units * weight / denominator, remainder: units * weight % denominator }));
      const remaining = units - parts.reduce((sum, part) => sum + part.units, 0n);
      const ordered = [...parts].sort((a,b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
      for (let i = 0; i < Number(remaining); i++) ordered[i].units++;
      [...shares.keys()].forEach((id, i) => shares.set(id, shares.get(id) + parts[i].units));
    }
    total += units;
    normalizedAdjustments[key] = { amount: m.round(charge.amount), allocation: charge.allocation };
  }
  if (total !== BigInt(m.units(amount))) return { error: 'Item totals plus tax and tip must equal the expense amount.' };
  return {
    splitType: 'ITEMIZED', items: normalized, adjustments: normalizedAdjustments,
    participants: [...shares].map(([userId, units]) => ({ userId, amount: Number(units) / m.scale, percentage: null })),
  };
}
module.exports = { calculateItemizedExpense, MAX_ITEMS };
