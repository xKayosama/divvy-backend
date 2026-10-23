const { randomUUID, createHash } = require('node:crypto');
const Activity = require('./Activity');
const id = value => value == null ? null : String(value._id || value);
function expenseSnapshot(expense, currency) {
  const raw = expense.toObject ? expense.toObject() : expense;
  return {
    ...(currency ? {currency} : {}), description: raw.description, amount: raw.amount, category: raw.category,
    date: raw.date, notes: raw.notes || '', paidBy: id(raw.paidBy), splitType: raw.splitType,
    participants: (raw.participants || []).map(p => ({ userId: id(p.userId), amount: p.amount, percentage: p.percentage, shares: p.shares })),
    items: (raw.items || []).map(item => ({ description: item.description, quantity: item.quantity, amount: item.amount, memberIds: (item.memberIds || []).map(id) })),
    adjustments: raw.adjustments,
  };
}
function groupSnapshot(group) { return { name: group.name, currency: group.currency, icon: group.icon || 'people' }; }
function changesBetween(before, after) {
  return Object.fromEntries(Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}
// Logging must not turn a completed financial write into a retryable failure.
// Payment reservations retain enough information to retry their event on recovery.
async function recordActivity(event) {
  try {
    const eventKey = event.eventKey || randomUUID();
    // Built-in _id uniqueness protects retries even before optional indexes exist.
    const _id = createHash('sha256').update(eventKey).digest('hex').slice(0, 24);
    await Activity.updateOne({ _id }, { $setOnInsert: { ...event, eventKey } }, { upsert: true, runValidators: true });
    return true;
  } catch (error) {
    if (error.code === 11000) return true;
    console.error('Activity history write failed:', error.message);
    return false;
  }
}
module.exports = { recordActivity, expenseSnapshot, groupSnapshot, changesBetween };
