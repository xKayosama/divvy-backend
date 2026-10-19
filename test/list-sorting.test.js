const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const { getGroupExpenses } = require('../src/modules/expenses/expense.controller');
const { getGroupBills } = require('../src/modules/bills/bill.controller');
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const specs = [
  { name: 'expenses', Model: Expense, controller: getGroupExpenses, defaultSort: 'newest', options: {
    newest: { date: -1, createdAt: -1, _id: -1 },
    oldest: { date: 1, createdAt: 1, _id: 1 },
    amount_high: { amount: -1, date: -1, createdAt: -1, _id: -1 },
    amount_low: { amount: 1, date: -1, createdAt: -1, _id: -1 },
  } },
  { name: 'bills', Model: Bill, controller: getGroupBills, defaultSort: 'due_soonest', options: {
    due_soonest: { dueDate: 1, createdAt: -1, _id: -1 },
    due_latest: { dueDate: -1, createdAt: -1, _id: -1 },
    amount_high: { amount: -1, dueDate: 1, createdAt: -1, _id: -1 },
    amount_low: { amount: 1, dueDate: 1, createdAt: -1, _id: -1 },
  } },
];
for (const { name, Model, controller, defaultSort, options } of specs) {
  for (const sort of [undefined, ...Object.keys(options)]) {
    test(`${name}: ${sort ?? 'default'} sorting precedes pagination and preserves combined filters/count`, async () => {
      const calls = [];
      let listFilter, countFilter;
      const chain = {
        populate() { return this; },
        sort(value) { calls.push('sort'); assert.deepEqual(value, options[sort ?? defaultSort]); return this; },
        skip(value) { calls.push('skip'); assert.equal(value, 5); return this; },
        limit(value) { calls.push('limit'); assert.equal(value, 5); return Promise.resolve([]); },
      };
      mock.method(Model, 'find', filter => { listFilter = filter; return chain; });
      mock.method(Model, 'countDocuments', async filter => { countFilter = filter; return 12; });
      const query = { page: '2', limit: '5', search: ' rent ', category: name === 'bills' ? 'rent' : 'food', ...(sort === undefined ? {} : { sort }), ...(name === 'bills' ? { status: 'paid', isRecurring: 'false' } : { startDate: '2026-10-01', endDate: '2026-10-31' }) };
      const res = response();
      await controller({ params: { id: 'g1' }, query }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(calls, ['sort', 'skip', 'limit']);
      assert.deepEqual(listFilter, countFilter);
      assert.equal(listFilter.groupId, 'g1');
      if (name === 'bills') {
        assert.equal(listFilter.category, 'RENT');
        assert.equal(listFilter.status, 'PAID');
        assert.equal(listFilter.isRecurring, false);
        assert.equal(listFilter.$or[0].name.$regex, 'rent');
      } else {
        assert.equal(listFilter.category, 'FOOD');
        assert.equal(listFilter.description.$regex, 'rent');
        assert.equal(listFilter.date.$gte.toISOString(), '2026-10-01T00:00:00.000Z');
        assert.equal(listFilter.date.$lt.toISOString(), '2026-11-01T00:00:00.000Z');
      }
      assert.equal(res.body.pagination.total, 12);
      assert.equal(res.body.pagination.totalPages, 3);
      assert.equal(res.body.pagination.page, 2);
    });
  }
  for (const sort of ['', ' ', 'unknown', 'NEWEST', 'toString', '__proto__', ['amount_high', 'amount_low'], { amount: -1 }, null, 1]) {
    test(`${name}: rejects invalid sort ${JSON.stringify(sort)} before database access`, async () => {
      mock.method(Model, 'find', () => assert.fail('must not query'));
      mock.method(Model, 'countDocuments', () => assert.fail('must not count'));
      const res = response();
      await controller({ params: { id: 'g1' }, query: { sort } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /sort must be one of/);
    });
  }
}
