const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Bill = require('../src/modules/bills/Bill');
const { getGroupBills } = require('../src/modules/bills/bill.controller');
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function stubList(check) {
  const chain = { populate() { return this; }, sort(value) { assert.deepEqual(value, { dueDate: 1, createdAt: -1, _id: -1 }); return this; }, skip(value) { assert.equal(value, 5); return this; }, limit(value) { assert.equal(value, 5); return Promise.resolve([]); } };
  mock.method(Bill, 'find', filter => { check(filter); return chain; });
  mock.method(Bill, 'countDocuments', async filter => { check(filter); return 7; });
}
test('search combines name and notes matching with group filters and pagination', async () => {
  let calls = 0;
  stubList(filter => {
    calls++;
    assert.equal(filter.groupId, 'g');
    assert.equal(filter.category, 'RENT');
    assert.deepEqual(filter.status, { $ne: 'PAID' });
    assert.ok(filter.dueDate.$gte instanceof Date);
    assert.equal(filter.isRecurring, true);
    assert.deepEqual(filter.$or.map(item => Object.keys(item)[0]), ['name', 'notes']);
    for (const item of filter.$or) {
      const options = Object.values(item)[0];
      const regex = new RegExp(options.$regex, options.$options);
      assert.ok(regex.test('Monthly RENT payment'));
      assert.ok(!regex.test('Internet'));
    }
  });
  const res = response();
  await getGroupBills({ params: { id: 'g' }, query: { search: ' rent ', category: 'rent', status: 'pending', isRecurring: 'true', page: '2', limit: '5' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(res.body.pagination.total, 7);
  assert.equal(res.body.pagination.totalPages, 2);
});
test('search treats regex metacharacters as literal text', async () => {
  const term = '.*+?^${}()|[]\\';
  stubList(filter => {
    const regex = new RegExp(filter.$or[0].name.$regex, 'i');
    assert.ok(regex.test('Bill ' + term));
    assert.ok(!regex.test('arbitrary bill'));
  });
  const res = response();
  await getGroupBills({ params: { id: 'g' }, query: { search: term, page: 2, limit: 5 } }, res);
  assert.equal(res.statusCode, 200);
});
for (const search of [undefined, '', '   ']) {
  test(`empty search ${JSON.stringify(search)} adds no search condition`, async () => {
    stubList(filter => assert.deepEqual(filter, { groupId: 'g' }));
    const res = response();
    await getGroupBills({ params: { id: 'g' }, query: { search, page: 2, limit: 5 } }, res);
    assert.equal(res.statusCode, 200);
  });
}
test('rejects structured or oversized search values without querying bills', async () => {
  mock.method(Bill, 'find', () => assert.fail('must not query'));
  for (const search of [['rent', 'food'], { $ne: '' }, 'a'.repeat(201)]) {
    const res = response();
    await getGroupBills({ params: { id: 'g' }, query: { search } }, res);
    assert.equal(res.statusCode, 400);
  }
});
