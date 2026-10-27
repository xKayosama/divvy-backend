const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDashboardPeriod } = require('../src/modules/dashboard/dashboard.period');
const { buildSpendingComparison } = require('../src/modules/dashboard/dashboard.comparison');
const { getGroupDashboard } = require('../src/modules/dashboard/dashboard.controller');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const Member = require('../src/modules/groups/GroupMember');
const Settlement = require('../src/modules/settlements/Settlement');
const now = new Date('2026-10-16T12:00:00Z');
const expense = (date, amount) => ({ date, amount, category: 'FOOD', paidBy: { _id: 'u' }, participants: [{ userId: { _id: 'u' }, amount }] });
const compare = entries => buildSpendingComparison(entries, resolveDashboardPeriod('this_month', now));
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });

for (const [current, previous, difference, percentageChange, direction] of [
  [2000, 2500, -500, -20, 'decrease'],
  [3000, 2500, 500, 20, 'increase'],
  [2500, 2500, 0, 0, 'unchanged'],
  [100, 0, 100, null, 'increase'],
  [0, 0, 0, null, 'unchanged'],
  [0, 100, -100, -100, 'decrease'],
]) {
  test(`comparison ${current} versus ${previous} has safe signed difference and percentage`, () => {
    const result = compare([expense('2026-10-01', current), expense('2026-09-01', previous)]);
    assert.equal(result.current.amount, current);
    assert.equal(result.previous.amount, previous);
    assert.equal(result.difference, difference);
    assert.equal(result.percentageChange, percentageChange);
    assert.equal(result.direction, direction);
    assert.equal(result.current.isInProgress, true);
    assert.equal(result.basis, 'calendar_month');
  });
}

test('uses cents without binary float artifacts and rounds percentage to two decimals', () => {
  let result = compare([expense('2026-10-01', 0.1), expense('2026-10-02', 0.2), expense('2026-09-01', 0.2)]);
  assert.equal(result.current.amount, 0.3); assert.equal(result.difference, 0.1); assert.equal(result.percentageChange, 50);
  result = compare([expense('2026-10-01', 2), expense('2026-09-01', 3)]);
  assert.equal(result.percentageChange, -33.33);
});

test('calendar windows include full last days, exclude adjacent months and preserve input', () => {
  const entries = [expense('2026-08-31T23:59:59.999Z', 999), expense('2026-09-01T00:00:00Z', 10), expense('2026-09-30T23:59:59.999Z', 20), expense('2026-10-01T00:00:00Z', 5), expense('2026-10-31T23:59:59.999Z', 10), expense('2026-11-01T00:00:00Z', 999)];
  const before = JSON.stringify(entries); const result = compare(entries);
  assert.equal(result.current.amount, 15); assert.equal(result.previous.amount, 30);
  assert.equal(result.previous.startDate, '2026-09-01'); assert.equal(result.previous.endDate, '2026-09-30');
  assert.equal(JSON.stringify(entries), before);
});

for (const [period, clock, start, end, inProgress] of [
  ['this_month', '2027-01-15', '2026-12-01', '2026-12-31', true],
  ['last_month', '2028-04-15', '2028-02-01', '2028-02-29', false],
  ['last_month', '2027-02-15', '2026-12-01', '2026-12-31', false],
]) {
  test(`${period} previous month handles rollover at ${clock}`, () => {
    const result = buildSpendingComparison([], resolveDashboardPeriod(period, new Date(clock)));
    assert.equal(result.previous.startDate, start); assert.equal(result.previous.endDate, end);
    assert.equal(result.current.isInProgress, inProgress);
  });
}

test('all-time and default requests have no comparison', () => {
  assert.equal(buildSpendingComparison([], resolveDashboardPeriod(undefined, now)), null);
  assert.equal(buildSpendingComparison([expense('2026-10-01', 10)], resolveDashboardPeriod('all_time', now)), null);
});

const chain = value => ({ populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
test('dashboard comparison reconciles with selected summary while bills and settlements stay separate', async () => {
  mock.timers.enable({ apis: ['Date'], now });
  const entries = [expense('2026-10-01', 20), expense('2026-09-01', 10), expense('2026-08-01', 5)];
  mock.method(Member, 'find', filter => { assert.deepEqual(filter, { groupId: 'g', $or: [{ status: 'ACTIVE' }, { accountDeleted: true }] }); return chain([{ userId: { _id: 'u' } }]); });
  mock.method(Expense, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain(entries); });
  mock.method(Bill, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain([{ _id: 'b', amount: 999, status: 'PENDING', dueDate: '2026-10-15' }]); });
  mock.method(Settlement, 'find', async filter => { assert.deepEqual(filter, { groupId: 'g' }); return [{ from: 'u', to: 'other', amount: 3 }]; });
  let original;
  for (const [period, expected, previous] of [['this_month', 20, 10], ['last_month', 10, 5], ['all_time', 35, null]]) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await getGroupDashboard({ params: { id: 'g' }, query: { period } }, res);
    assert.equal(res.statusCode, 200); const data = res.body.data;
    assert.equal(data.summary.totalExpenses, expected);
    if (previous === null) assert.equal(data.spendingComparison, null);
    else {
      assert.equal(data.spendingComparison.current.amount, expected);
      assert.equal(data.spendingComparison.previous.amount, previous);
    }
    if (!original) original = data;
    assert.deepEqual(data.balances, original.balances);
    assert.deepEqual(data.bills, original.bills);
    assert.deepEqual(data.billReminders, original.billReminders);
  }
});
