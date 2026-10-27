const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryBreakdown } = require('../src/modules/dashboard/dashboard.categories');
const { getGroupDashboard } = require('../src/modules/dashboard/dashboard.controller');
const Expense = require('../src/modules/expenses/Expense');
const Member = require('../src/modules/groups/GroupMember');
const Bill = require('../src/modules/bills/Bill');
const Settlement = require('../src/modules/settlements/Settlement');
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });

test('amounts use cents, counts count expenses once, and ties sort alphabetically', () => {
  const result = buildCategoryBreakdown([
    { category: 'FOOD', amount: 0.1, participants: [{}, {}, {}] },
    { category: 'FOOD', amount: 0.2 },
    { category: 'RENT', amount: 0.3 },
    { category: 'GROCERIES', amount: 0.6 },
  ]);
  assert.equal(result.totalAmount, 1.2);
  assert.deepEqual(result.spendingByCategory, [
    { category: 'GROCERIES', amount: 0.6, count: 1, percentage: 50 },
    { category: 'FOOD', amount: 0.3, count: 2, percentage: 25 },
    { category: 'RENT', amount: 0.3, count: 1, percentage: 25 },
  ]);
});

test('empty period yields no categories or nonfinite percentages', () => {
  assert.deepEqual(buildCategoryBreakdown([]), { totalAmount: 0, spendingByCategory: [] });
});

test('known legacy categories normalize and unknown/missing categories fall back to OTHERS', () => {
  const entries = [{ category: ' food ', amount: 1 }, { category: 'old-category', amount: 2 }, { amount: 3 }];
  const before = JSON.stringify(entries);
  const result = buildCategoryBreakdown(entries);
  assert.deepEqual(result.spendingByCategory, [
    { category: 'OTHERS', amount: 5, count: 2, percentage: 83.33 },
    { category: 'FOOD', amount: 1, count: 1, percentage: 16.67 },
  ]);
  assert.equal(JSON.stringify(entries), before);
});

test('percentage rounding is independent and single categories are 100 percent', () => {
  assert.equal(buildCategoryBreakdown([{ category: 'FOOD', amount: 1 }]).spendingByCategory[0].percentage, 100);
  const result = buildCategoryBreakdown(['FOOD', 'RENT', 'INTERNET'].map(category => ({ category, amount: 1 })));
  assert.ok(result.spendingByCategory.every(item => item.percentage === 33.33));
});

const now = new Date('2026-10-16T12:00:00Z');
const expense = (category, date, amount) => ({ category, date, amount, paidBy: { _id: 'u' }, participants: [{ userId: { _id: 'u' }, amount }] });
const chain = value => ({ sort() { return this; }, populate() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function setup(entries) {
  mock.timers.enable({ apis: ['Date'], now });
  mock.method(Member, 'find', filter => { assert.deepEqual(filter, { groupId: 'g', $or: [{ status: 'ACTIVE' }, { accountDeleted: true }] }); return chain([{ userId: { _id: 'u' } }]); });
  mock.method(Expense, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain(entries); });
  mock.method(Bill, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain([{ _id: 'bill', amount: 999, status: 'PENDING', category: 'FOOD', dueDate: '2026-10-15' }]); });
  mock.method(Settlement, 'find', async filter => { assert.deepEqual(filter, { groupId: 'g' }); return [{ from: 'u', to: 'other', amount: 50 }]; });
}
async function dashboard(period) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await getGroupDashboard({ params: { id: 'g' }, query: { period } }, res);
  assert.equal(res.statusCode, 200);
  return res.body.data;
}

test('dashboard category breakdown follows all three periods and boundaries, excluding bills/settlements', async () => {
  setup([
    expense('FOOD', '2026-10-01T00:00:00Z', 10),
    expense('FOOD', '2026-10-31T23:59:59.999Z', 20),
    expense('RENT', '2026-09-30T23:59:59.999Z', 60),
    expense('INTERNET', '2026-11-01T00:00:00Z', 30),
  ]);
  const all = await dashboard('all_time');
  const current = await dashboard('this_month');
  const previous = await dashboard('last_month');
  assert.deepEqual(current.spendingByCategory, [{ category: 'FOOD', amount: 30, count: 2, percentage: 100 }]);
  assert.deepEqual(previous.spendingByCategory, [{ category: 'RENT', amount: 60, count: 1, percentage: 100 }]);
  assert.deepEqual(all.spendingByCategory, [
    { category: 'RENT', amount: 60, count: 1, percentage: 50 },
    { category: 'FOOD', amount: 30, count: 2, percentage: 25 },
    { category: 'INTERNET', amount: 30, count: 1, percentage: 25 },
  ]);
  for (const data of [all, current, previous]) {
    assert.equal(data.spendingByCategory.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), Math.round(data.summary.totalExpenses * 100));
    assert.equal(data.summary.totalPaid, data.summary.totalExpenses);
    assert.deepEqual(data.balances, all.balances);
    assert.deepEqual(data.billReminders, all.billReminders);
  }
});

test('dashboard with no selected expenses returns an empty breakdown', async () => {
  setup([expense('RENT', '2026-09-01', 10)]);
  const data = await dashboard('this_month');
  assert.deepEqual(data.spendingByCategory, []);
  assert.equal(data.summary.totalExpenses, 0);
  assert.equal(data.balances[0].paid, 10);
});
