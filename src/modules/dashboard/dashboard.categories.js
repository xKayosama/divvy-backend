const { money } = require('../../utils/money');
const Expense = require('../expenses/Expense');
const categories = new Set(Expense.schema.path('category').enumValues);

function buildCategoryBreakdown(expenses, currency) {
  const { scale, readUnits } = money(currency);
  const groups = new Map();
  let totalCents = 0;
  for (const expense of expenses) {
    const normalized = typeof expense.category === 'string' ? expense.category.trim().toUpperCase() : '';
    const category = categories.has(normalized) ? normalized : 'OTHERS';
    const cents = readUnits(expense.amount);
    totalCents += cents;
    const group = groups.get(category) || { category, cents: 0, count: 0 };
    group.cents += cents;
    group.count++;
    groups.set(category, group);
  }
  const spendingByCategory = [...groups.values()]
    .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category))
    .map(({ category, cents, count }) => ({
      category,
      amount: cents / scale,
      count,
      percentage: totalCents > 0 ? Math.round(cents / totalCents * 10000) / 100 : 0
    }));
  return { totalAmount: totalCents / scale, spendingByCategory };
}

module.exports = { buildCategoryBreakdown };
