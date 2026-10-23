const {money}=require('../../utils/money');
const {calculateSharesExpense}=require('./expense.shares');
const calculateExpenseParticipants = ({ amount, splitType = 'EQUAL', participants, currency }) => {
  const m = money(currency);
  if (!m.valid(amount)) return { error: `Expense amount must be positive with ${m.label}.` };
  const type = typeof splitType === 'string' ? splitType.toUpperCase() : '';
  if (type === 'SHARES') return calculateSharesExpense({ amount, participants, currency });
  const total = m.units(amount);
  if (type === 'EQUAL') {
    const base = Math.floor(total / participants.length);
    return { splitType: type, participants: participants.map((p, i) => ({ userId: p.userId,
      amount: (base + (i === 0 ? total - base * participants.length : 0)) / m.scale, percentage: null })) };
  }
  if (type === 'EXACT') {
    if (participants.some(p => !m.valid(p.amount, true))) return { error: `Each participant must have a nonnegative amount with ${m.label}.` };
    const sum = participants.reduce((sum, p) => sum + m.units(p.amount), 0);
    if (sum !== total) return { error: 'Participant amounts must equal the expense amount.' };
    return { splitType: type, participants: participants.map(p => ({ userId: p.userId, amount: m.round(p.amount), percentage: null })) };
  }
  if (type === 'PERCENTAGE') {
    const percent = money('PHP'); // Percentages keep two decimal places regardless of currency.
    if (participants.some(p => !percent.valid(p.percentage, true) || p.percentage > 100)) return { error: 'Each participant must have a valid percentage between 0 and 100.' };
    if (participants.reduce((sum, p) => sum + percent.units(p.percentage), 0) !== 10000) return { error: 'Participant percentages must total 100%.' };
    const amounts = participants.map(p => Number((BigInt(total) * BigInt(percent.units(p.percentage)) + 5000n) / 10000n));
    const last = amounts.length - 1;
    amounts[last] += total - amounts.reduce((sum, amount) => sum + amount, 0);
    let excess = Math.max(0, -amounts[last]);
    if (excess) amounts[last] = 0;
    for (let i = last - 1; i >= 0 && excess; i--) {
      const reduction = Math.min(amounts[i], excess);
      amounts[i] -= reduction; excess -= reduction;
    }
    return { splitType: type, participants: participants.map((p, i) => ({ userId: p.userId, amount: amounts[i] / m.scale, percentage: p.percentage })) };
  }
  return { error: 'Invalid split type. Supported standard types are EQUAL, EXACT, PERCENTAGE, and SHARES.' };
};


module.exports={calculateExpenseParticipants};
