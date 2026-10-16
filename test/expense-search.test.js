const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Expense = require('../src/modules/expenses/Expense');
const { getGroupExpenses } = require('../src/modules/expenses/expense.controller');
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

async function search(query, check) {
  const chain = {
    populate() { return this; },
    sort(value) { assert.deepEqual(value, { date: -1, createdAt: -1 }); return this; },
    skip(value) { assert.equal(value, query.page === '2' ? 5 : 0); return this; },
    limit() { return Promise.resolve([]); }
  };
  mock.method(Expense, 'find', filter => { check(filter); return chain; });
  mock.method(Expense, 'countDocuments', async filter => { check(filter); return 11; });
  const res = response();
  await getGroupExpenses({ params: { id: 'group-a' }, query }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(Expense.find.mock.callCount(), 1);
  assert.equal(Expense.countDocuments.mock.callCount(), 1);
  return res;
}

test('description search trims, matches case-insensitive substrings and combines group/date/category pagination', async () => {
  const res = await search({ search: '  groCERies  ', category: 'food', startDate: '2026-10-01', endDate: '2026-10-02', page: '2', limit: '5' }, filter => {
    assert.equal(filter.groupId, 'group-a');
    assert.equal(filter.category, 'FOOD');
    assert.equal(filter.date.$gte.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(filter.date.$lt.toISOString(), '2026-10-03T00:00:00.000Z');
    const pattern = new RegExp(filter.description.$regex, filter.description.$options);
    assert.ok(pattern.test('Weekly groceries at market'));
    assert.ok(!pattern.test('Rent'));
  });
  assert.equal(res.body.pagination.totalPages, 3);
  assert.equal(res.body.pagination.hasNextPage, true);
});

test('search treats all regex metacharacters literally', async () => {
  const term = '.*+?^${}()|[]\\';
  await search({ search: term }, filter => {
    const pattern = new RegExp(filter.description.$regex, filter.description.$options);
    assert.ok(pattern.test(`Receipt ${term} paid`));
    assert.ok(!pattern.test('ordinary description'));
  });
});

for (const term of [undefined, '', '   ']) {
  test(`empty or absent search preserves existing listing (${JSON.stringify(term)})`, async () => {
    await search(term === undefined ? {} : { search: term }, filter => assert.deepEqual(filter, { groupId: 'group-a' }));
  });
}

for (const term of [['meal', 'rent'], { $ne: '' }, 'x'.repeat(201)]) {
  test(`invalid search is rejected before database access (${JSON.stringify(term).slice(0, 30)})`, async () => {
    mock.method(Expense, 'find', () => assert.fail('must not query'));
    mock.method(Expense, 'countDocuments', () => assert.fail('must not count'));
    const res = response();
    await getGroupExpenses({ params: { id: 'g' }, query: { search: term } }, res);
    assert.equal(res.statusCode, 400);
  });
}

test('200-character search is accepted', async () => {
  await search({ search: 'x'.repeat(200) }, filter => assert.equal(filter.description.$regex.length, 200));
});
