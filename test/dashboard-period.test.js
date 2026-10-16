const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDashboardPeriod } = require('../src/modules/dashboard/dashboard.period');
const { getGroupDashboard } = require('../src/modules/dashboard/dashboard.controller');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const Member = require('../src/modules/groups/GroupMember');
const Settlement = require('../src/modules/settlements/Settlement');
const now = new Date('2026-10-16T12:00:00Z');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const chain = value => ({ populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });

for (const [value, date, startDate, endDate] of [
  ['this_month', now, '2026-10-01', '2026-10-31'],
  ['last_month', now, '2026-09-01', '2026-09-30'],
  ['last_month', new Date('2027-01-01'), '2026-12-01', '2026-12-31'],
  ['last_month', new Date('2028-03-01'), '2028-02-01', '2028-02-29'],
  ['this_month', new Date('2026-12-31T23:59:59.999Z'), '2026-12-01', '2026-12-31'],
]) {
  test(`${value} resolves UTC boundaries at ${date.toISOString()}`, () => {
    const result = resolveDashboardPeriod(value, date);
    assert.deepEqual(result.period, { value, timeZone: 'UTC', startDate, endDate });
    assert.equal(result.start.toISOString(), `${startDate}T00:00:00.000Z`);
    assert.equal(new Date(result.end - 1).toISOString(), `${endDate}T23:59:59.999Z`);
  });
}

const expense = (id, date, amount) => ({ _id: id, groupId: 'g', date, createdAt: '2026-10-16', amount, paidBy: { _id: 'a' }, participants: [{ userId: { _id: 'a' }, amount: amount / 2 }, { userId: { _id: 'b' }, amount: amount / 2 }] });
const entries = [
  expense('next-month', '2026-11-01T00:00:00.000Z', 80),
  expense('month-end', '2026-10-31T23:59:59.999Z', 40),
  expense('month-start', '2026-10-01T00:00:00.000Z', 20),
  expense('previous-end', '2026-09-30T23:59:59.999Z', 10),
  expense('previous-start', '2026-09-01T00:00:00.000Z', 6),
  expense('older', '2026-08-31T23:59:59.999Z', 4),
];
function setup(expenses = entries) {
  mock.timers.enable({ apis: ['Date'], now });
  const groupFilter = filter => assert.deepEqual(filter, { groupId: 'g' });
  mock.method(Member, 'find', filter => { assert.deepEqual(filter, { groupId: 'g', status: 'ACTIVE' }); return chain([{ userId: { _id: 'a' } }, { userId: { _id: 'b' } }]); });
  mock.method(Expense, 'find', filter => { groupFilter(filter); return chain(expenses); });
  mock.method(Bill, 'find', filter => { groupFilter(filter); return chain([{ _id: 'late', status: 'PENDING', amount: 25, dueDate: '2026-10-15' }, { _id: 'today', status: 'PENDING', amount: 5, dueDate: '2026-10-16' }, { _id: 'paid', status: 'PAID', amount: 8, dueDate: '2026-01-01' }]); });
  mock.method(Settlement, 'find', async filter => { groupFilter(filter); return [{ from: 'b', to: 'a', amount: 10 }]; });
}
async function dashboard(period) {
  const res = response(); await getGroupDashboard({ params: { id: 'g' }, query: period === undefined ? {} : { period } }, res);
  assert.equal(res.statusCode, 200);
  return res.body.data;
}

test('monthly summaries and previews select expense date while balances and bills retain all history', async () => {
  setup();
  const all = await dashboard();
  assert.deepEqual(all.period, { value: 'all_time', timeZone: 'UTC', startDate: null, endDate: null });
  assert.equal(all.summary.totalExpenses, 160);
  for (const [period, expected, ids] of [
    ['this_month', 60, ['month-end', 'month-start']],
    ['last_month', 16, ['previous-end', 'previous-start']],
  ]) {
    const selected = await dashboard(period);
    assert.deepEqual(selected.summary, { totalExpenses: expected, totalPaid: expected, totalOwed: expected });
    assert.deepEqual(selected.recentExpenses.map(item => item._id), ids);
    assert.deepEqual(selected.balances, all.balances);
    assert.deepEqual(selected.bills, all.bills);
    assert.deepEqual(selected.billReminders, all.billReminders);
    assert.deepEqual(selected.upcomingBills, all.upcomingBills);
  }
  assert.equal(all.balances[0].net, 70);
  assert.equal(all.balances[1].net, -70);
  assert.equal(all.bills.overdue, 1);
  assert.equal(all.billReminders.overdue.count, 1);
});

test('explicit all_time matches the default, with newest five previews', async () => {
  setup();
  const implicit = await dashboard();
  const explicit = await dashboard('all_time');
  assert.deepEqual(explicit, implicit);
  assert.equal(explicit.recentExpenses.length, 5);
  assert.equal(explicit.recentExpenses[0]._id, 'next-month');
});

test('empty selected month returns zero totals and no previews without erasing existing balances', async () => {
  setup([entries[5]]);
  const data = await dashboard('this_month');
  assert.deepEqual(data.summary, { totalExpenses: 0, totalPaid: 0, totalOwed: 0 });
  assert.deepEqual(data.recentExpenses, []);
  assert.equal(data.balances[0].paid, 4);
  assert.equal(data.billReminders.overdue.count, 1);
});

test('selected recent preview is capped at five after month filtering', async () => {
  const month = Array.from({ length: 7 }, (_, i) => expense(String(i), `2026-10-${String(20 - i).padStart(2, '0')}`, 1));
  setup([entries[0], ...month, entries[5]]);
  const data = await dashboard('this_month');
  assert.equal(data.summary.totalExpenses, 7);
  assert.deepEqual(data.recentExpenses.map(item => item._id), ['0', '1', '2', '3', '4']);
});

for (const period of ['', 'year', 'THIS_MONTH', ['this_month', 'last_month'], { $ne: '' }, null]) {
  test(`rejects invalid period ${JSON.stringify(period)} before database access`, async () => {
    for (const Model of [Member, Expense, Bill, Settlement]) mock.method(Model, 'find', () => assert.fail('must not query'));
    const res = response(); await getGroupDashboard({ params: { id: 'g' }, query: { period } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /period must be/);
  });
}
