const { createHash } = require('node:crypto');
const Expense = require('../expenses/Expense');
const GroupMember = require('../groups/GroupMember');
const Settlement = require('./Settlement');
const id = value => value ? String(value._id || value) : '';
const { money } = require('../../utils/money');

async function getSettlementSnapshot(groupId, currency) {
  const { readUnits: cents, scale } = money(currency);
  const memberships = await GroupMember.find({ groupId, status: 'ACTIVE' }).populate({ path: 'userId', select: 'firstName lastName email avatar' });
  const expenses = await Expense.find({ groupId });
  const payments = await Settlement.find({ groupId });
  const balances = new Map(memberships.filter(m => m.userId).map(m => [id(m.userId), { user: m.userId, net: 0 }]));
  for (const expense of expenses) {
    const payer = balances.get(id(expense.paidBy));
    if (payer) payer.net += cents(expense.amount);
    for (const part of expense.participants) {
      const participant = balances.get(id(part.userId));
      if (participant) participant.net -= cents(part.amount);
    }
  }
  for (const payment of payments) {
    const from = balances.get(id(payment.from)); const to = balances.get(id(payment.to));
    if (from) from.net += cents(payment.amount);
    if (to) to.net -= cents(payment.amount);
  }
  const ordered = [...balances.values()].sort((a, b) => id(a.user).localeCompare(id(b.user)));
  const creditors = ordered.filter(b => b.net > 0).map(b => ({ ...b }));
  const debtors = ordered.filter(b => b.net < 0).map(b => ({ ...b, net: -b.net }));
  const settlements = [];
  let d = 0; let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].net, creditors[c].net);
    if (amount > 0) settlements.push({ from: debtors[d].user, to: creditors[c].user, amount: amount / scale });
    debtors[d].net -= amount; creditors[c].net -= amount;
    if (!debtors[d].net) d++;
    if (!creditors[c].net) c++;
  }
  // A unique key claims a suggested pair against this exact repayment state.
  const snapshot = createHash('sha256').update(JSON.stringify({
    currency: currency || 'PHP',
    balances: ordered.map(b => [id(b.user), b.net]),
    payments: payments.map(p => id(p)).sort(),
  })).digest('hex');
  return { settlements, snapshot, memberCount: balances.size };
}
module.exports = { getSettlementSnapshot };
