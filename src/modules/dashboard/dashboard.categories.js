const Expense = require('../expenses/Expense');
const categories = new Set(Expense.schema.path('category').enumValues);

function buildCategoryBreakdown(expenses) {
  const groups = new Map();
  let totalCents = 0;
  for (const expense of expenses) {
    const normalized = typeof expense.category === 'string' ? expense.category.trim().toUpperCase() : '';
    const category = categories.has(normalized) ? normalized : 'OTHERS';
    const cents = Math.round(expense.amount * 100);
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
      amount: cents / 100,
      count,
      percentage: totalCents > 0 ? Math.round(cents / totalCents * 10000) / 100 : 0
    }));
  return { totalAmount: totalCents / 100, spendingByCategory };
}

module.exports = { buildCategoryBreakdown };
