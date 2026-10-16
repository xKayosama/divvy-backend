const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Bill = require('../src/modules/bills/Bill');
const Member = require('../src/modules/groups/GroupMember');
const { createBill, updateBill, getBillById, getGroupBills } = require('../src/modules/bills/bill.controller');
const { presentBill } = require('../src/modules/bills/bill.reminders');
const now = new Date('2026-10-16T12:34:56.000Z');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const record = (status = 'PENDING') => ({ _id: 'b', groupId: 'g', name: 'Rent', amount: 20, category: 'RENT', dueDate: new Date('2026-10-20'), status, isRecurring: false, recurrence: null, paidBy: null, notes: '', async populate() {} });
const request = body => ({ params: { id: 'g', billId: 'b' }, user: { _id: 'u' }, body, query: {} });
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
function setup(bill) {
  mock.timers.enable({ apis: ['Date'], now });
  mock.method(Member, 'findOne', async () => ({}));
  mock.method(Bill, 'findById', async () => bill);
}

test('schema stores a nullable Date; legacy paid records serialize as unknown without guessing', () => {
  const paid = new Bill({ name: 'Rent', amount: 20, dueDate: '2026-10-20', status: 'PAID' });
  assert.equal(Bill.schema.path('paidAt').instance, 'Date');
  assert.equal(paid.paidAt, null);
  assert.equal(presentBill({ ...record('PAID'), updatedAt: now }).paidAt, null);
});

for (const status of ['PENDING', 'OVERDUE']) {
  test(`marking ${status} paid writes server timestamp atomically and ignores supplied paidAt`, async () => {
    const bill = record(status); setup(bill);
    mock.method(Bill, 'findOneAndUpdate', async (filter, update, options) => {
      assert.deepEqual(filter, { _id: 'b', status: { $ne: 'PAID' } });
      assert.equal(update.$set.status, 'PAID');
      assert.equal(update.$set.paidBy, 'u');
      assert.equal(update.$set.paidAt.toISOString(), now.toISOString());
      assert.equal(options.new, true);
      assert.equal(options.runValidators, true);
      return { ...bill, ...update.$set };
    });
    const res = response();
    await updateBill(request({ status: 'PAID', paidBy: 'u', paidAt: '2000-01-01' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.bill.paidAt.toISOString(), now.toISOString());
  });
}

test('ordinary unpaid edits cannot attach a payment timestamp', async () => {
  const bill = record(); setup(bill);
  mock.method(Bill, 'findOneAndUpdate', async (_filter, update) => {
    assert.equal(update.$set.paidAt, null);
    return { ...bill, ...update.$set };
  });
  const res = response();
  await updateBill(request({ name: 'Updated', paidAt: now }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.bill.paidAt, null);
});

for (const status of ['PENDING', 'PAID']) {
  test(`creating ${status} uses server-owned timestamp`, async () => {
    setup(record());
    mock.method(Bill, 'create', async fields => {
      assert.equal(fields.paidAt?.toISOString() ?? null, status === 'PAID' ? now.toISOString() : null);
      return { ...fields, async populate() {} };
    });
    const res = response();
    await createBill(request({ name: 'Rent', amount: 20, dueDate: '2026-10-20', paidBy: 'u', status, paidAt: '2000-01-01' }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.bill.paidAt?.toISOString() ?? null, status === 'PAID' ? now.toISOString() : null);
  });
}

test('repeated payment cannot overwrite the original timestamp', async () => {
  const original = new Date('2026-10-10T10:00:00Z');
  const bill = { ...record('PAID'), paidAt: original }; setup(bill);
  mock.method(Bill, 'findOneAndUpdate', () => assert.fail('paid bill must be locked'));
  const res = response();
  await updateBill(request({ status: 'PAID', paidBy: 'u', paidAt: now }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(bill.paidAt, original);
});

test('concurrent payment rejects conditional write instead of overwriting timestamp', async () => {
  setup(record());
  mock.method(Bill, 'findOneAndUpdate', async () => null);
  const res = response();
  await updateBill(request({ status: 'PAID', paidBy: 'u' }), res);
  assert.equal(res.statusCode, 409);
});

test('unauthorized payment does not write a timestamp', async () => {
  setup(record());
  mock.method(Member, 'findOne', async () => null);
  mock.method(Bill, 'findOneAndUpdate', () => assert.fail('must not write'));
  const res = response(); await updateBill(request({ status: 'PAID', paidBy: 'u' }), res);
  assert.equal(res.statusCode, 403);
});

test('bill list and detail preserve the stored date and legacy null', async () => {
  const paid = { ...record('PAID'), paidAt: now };
  mock.method(Member, 'findOne', async () => ({}));
  const chain = { populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return Promise.resolve([paid, record('PAID')]); }, then(resolve, reject) { return Promise.resolve(paid).then(resolve, reject); } };
  mock.method(Bill, 'find', () => chain);
  mock.method(Bill, 'countDocuments', async () => 2);
  mock.method(Bill, 'findById', () => chain);
  let res = response(); await getGroupBills(request({}), res);
  assert.equal(res.body.data.bills[0].paidAt, now);
  assert.equal(res.body.data.bills[1].paidAt, null);
  res = response(); await getBillById(request({}), res);
  assert.equal(res.body.data.bill.paidAt, now);
});
