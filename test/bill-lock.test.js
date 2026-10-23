const Group = require('../src/modules/groups/Group');
const { beforeEach } = require('node:test');
const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.BILL_BACKEND_ROOT || path.resolve(__dirname, '..');
const Bill = require(path.join(root, 'src/modules/bills/Bill'));
const Member = require(path.join(root, 'src/modules/groups/GroupMember'));
const controller = require(process.env.BILL_CONTROLLER_PATH || path.join(root, 'src/modules/bills/bill.controller'));
afterEach(() => mock.restoreAll());
function response() { return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } }; }
function setup(status) {
  const bill = { _id: 'b', groupId: 'g', name: 'Rent', amount: 20, category: 'RENT', dueDate: new Date('2026-10-20'), status, isRecurring: false, recurrence: null, paidBy: null, notes: '', populate: async () => {} };
  mock.method(Bill, 'findById', () => ({select(){return Promise.resolve(bill);},then(resolve,reject){return Promise.resolve(bill).then(resolve,reject);}}));
  mock.method(Member, 'findOne', async () => ({}));
  return bill;
}
for (const action of ['updateBill', 'deleteBill']) {
  test(`${action} rejects paid bills including attempts to reopen them`, async () => {
    setup('PAID');
    mock.method(Bill, 'findOneAndUpdate', () => assert.fail('No update allowed'));
    mock.method(Bill, 'findOneAndDelete', () => assert.fail('No delete allowed'));
    const res = response();
    await controller[action]({ params: { billId: 'b' }, user: { _id: 'u' }, body: { name: 'Changed', status: 'PENDING' } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /Paid bills/);
  });
  test(`${action} keeps authorization before paid-state disclosure`, async () => {
    setup('PAID'); mock.method(Member, 'findOne', async () => null);
    const res = response(); await controller[action]({ params: { billId: 'b' }, user: { _id: 'u' }, body: {} }, res);
    assert.equal(res.statusCode, 403);
  });
  for (const status of ['PENDING', 'OVERDUE']) {
    test(`${action} allows ${status} bills and checks paid state atomically`, async () => {
      const bill = setup(status);
      const method = action === 'updateBill' ? 'findOneAndUpdate' : 'findOneAndDelete';
      mock.method(Bill, method, async (filter, update, options) => {
        assert.deepEqual(filter, { _id: 'b', status: { $ne: 'PAID' }, expenseId: null });
        if (update) { assert.equal(update.$set.name, 'Updated'); assert.equal(options.runValidators, true); }
        return bill;
      });
      const res = response(); await controller[action]({ params: { billId: 'b' }, user: { _id: 'u' }, body: { name: 'Updated' } }, res);
      assert.equal(res.statusCode, 200);
    });
  }
  test(`${action} rejects a concurrent payment`, async () => {
    setup('PENDING');
    mock.method(Bill, action === 'updateBill' ? 'findOneAndUpdate' : 'findOneAndDelete', async () => null);
    const res = response(); await controller[action]({ params: { billId: 'b' }, user: { _id: 'u' }, body: { name: 'Updated' } }, res);
    assert.equal(res.statusCode, 409);
  });
}
test('marking a bill paid requires explicit split settings', async () => {
  setup('PENDING');
  mock.method(Bill,'findOneAndUpdate',()=>assert.fail('incomplete payment must not write'));
  const res=response();await controller.updateBill({params:{billId:'b'},user:{_id:'u'},body:{status:'PAID',paidBy:'u'}},res);
  assert.equal(res.statusCode,400);
});

beforeEach(() => { mock.method(Group, 'findById', async () => ({ currency: 'PHP' })); });
