const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { money } = require('../src/utils/money');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const Settlement = require('../src/modules/settlements/Settlement');
const Group = require('../src/modules/groups/Group');
const Member = require('../src/modules/groups/GroupMember');
const expenses = require('../src/modules/expenses/expense.controller');
const bills = require('../src/modules/bills/bill.controller');
const payments = require('../src/modules/settlements/settlement.controller');
const { getGroupBalances } = require('../src/modules/balances/balance.controller');
const { getGroupDashboard } = require('../src/modules/dashboard/dashboard.controller');
const { updateGroup } = require('../src/modules/groups/group.controller');
const sender = '507f1f77bcf86cd799439011', recipient = '507f1f77bcf86cd799439012';
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const query = value => ({ populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const request = (currency, body = {}) => ({ params: { id: 'g', expenseId: 'e', billId: 'b' }, group: { currency }, user: { _id: sender }, body, query: {} });
afterEach(() => mock.restoreAll());

for (const [currency, total, expected] of [['JPY', 100, [34, 33, 33]], ['PHP', 1, [.34, .33, .33]], ['KWD', .1, [.034, .033, .033]]]) {
  test(`${currency}: equal, exact and percentage splits conserve native minor units`, async () => {
    const ids = [sender, recipient, '507f1f77bcf86cd799439013'];
    mock.method(Member, 'findOne', async () => ({}));
    mock.method(Member, 'find', async () => ids.map(userId => ({ userId })));
    let saved;
    mock.method(Expense, 'create', async fields => { saved = { ...fields, async populate() {} }; return saved; });
    for (const type of ['EQUAL', 'EXACT', 'PERCENTAGE']) {
      const res = response();
      await expenses.createExpense(request(currency, { description: 'Meal', amount: total, paidBy: sender, splitType: type,
        participants: ids.map((userId, i) => ({ userId, ...(type === 'EXACT' ? { amount: expected[i] } : type === 'PERCENTAGE' ? { percentage: [34, 33, 33][i] } : {}) })) }), res);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(saved.participants.map(p => p.amount), expected);
      assert.equal(money(currency).sum(saved.participants.map(p => p.amount)), total);
    }
  });
}

test('tiny percentage splits never create a negative share and conserve the total', async () => {
  mock.method(Member, 'findOne', async () => ({}));
  mock.method(Member, 'find', async () => [{}, {}, {}, {}]);
  let saved;
  mock.method(Expense, 'create', async fields => { saved = fields; return { ...fields, async populate() {} }; });
  const res = response();
  await expenses.createExpense(request('JPY', { description: 'Meal', amount: 2, paidBy: sender, splitType: 'PERCENTAGE',
    participants: [0, 1, 2, 3].map(i => ({ userId: String(i), percentage: [25, 25, 25, 25][i] })) }), res);
  assert.equal(res.statusCode, 201);
  assert.ok(saved.participants.every(p => p.amount >= 0));
  assert.equal(saved.participants.reduce((sum, p) => sum + p.amount, 0), 2);
});

for (const [currency, valid, invalid] of [['JPY', 1, 1.1], ['PHP', .01, .001], ['KWD', .001, .0001]]) {
  test(`${currency}: expense and bill creation validate precision before writes`, async () => {
    mock.method(Member, 'findOne', async () => ({}));
    mock.method(Member, 'find', async () => [{}]);
    mock.method(Expense, 'create', async fields => ({ ...fields, async populate() {} }));
    mock.method(Bill, 'create', async fields => ({ ...fields, async populate() {} }));
    for (const [amount, status] of [[valid, 201], [invalid, 400], [NaN, 400], [Infinity, 400], [1e20, 400], [String(valid), 400]]) {
      let res = response();
      await expenses.createExpense(request(currency, { description: 'Meal', amount, paidBy: sender, participants: [{ userId: sender }] }), res);
      assert.equal(res.statusCode, status);
      res = response();
      await bills.createBill(request(currency, { name: 'Bill', amount, dueDate: '2026-10-30' }), res);
      assert.equal(res.statusCode, status);
    }
  });

  test(`${currency}: standalone updates use the saved group currency`, async () => {
    mock.method(Group, 'findById', async () => ({ currency }));
    mock.method(Member, 'findOne', async () => ({}));
    mock.method(Member, 'find', async () => [{}]);
    const expense = { _id: 'e', groupId: 'g', description: 'Meal', amount: valid, paidBy: sender, splitType: 'EQUAL', participants: [{ userId: sender }], async save() {}, async populate() {} };
    const bill = { _id: 'b', groupId: 'g', name: 'Bill', amount: valid, dueDate: new Date('2026-10-30'), status: 'PENDING', isRecurring: false, async populate() {} };
    mock.method(Expense, 'findById', async () => expense);
    mock.method(Bill, 'findById', async () => bill);
    mock.method(Bill, 'findOneAndUpdate', async () => bill);
    for (const action of [expenses.updateExpense, bills.updateBill]) {
      const res = response();
      await action(request(currency, { amount: invalid }), res);
      assert.equal(res.statusCode, 400);
      const success = response();
      await action(request(currency, { amount: valid }), success);
      assert.equal(success.statusCode, 200);
    }
  });
}

for (const [currency, total, share, payment] of [['JPY', 10, 5, 1], ['PHP', .1, .05, .01], ['KWD', .01, .005, .001]]) {
  test(`${currency}: balances, dashboard, suggestions and repayments agree at the smallest unit`, async () => {
    const people = [sender, recipient].map(_id => ({ _id }));
    const expense = { amount: total, category: 'FOOD', paidBy: people[1], date: new Date(), participants: people.map(userId => ({ userId, amount: share })) };
    mock.method(Member, 'find', () => query(people.map(userId => ({ userId }))));
    mock.method(Member, 'findOne', async () => ({}));
    mock.method(Expense, 'find', () => query([expense]));
    mock.method(Bill, 'find', () => query([{ _id: 'b', amount: payment, status: 'PENDING', dueDate: new Date() }]));
    const history = [];
    mock.method(Settlement, 'find', () => query(history));
    mock.method(Settlement, 'createIndexes', async () => {});
    mock.method(Settlement, 'create', async fields => { const value = { _id: 'p', ...fields }; history.push(value); return value; });
    let res = response();
    await payments.getGroupSettlements(request(currency), res);
    assert.equal(res.body.data.settlements[0].amount, share);
    res = response();
    await payments.recordSettlement(request(currency, { to: recipient, amount: payment }), res);
    assert.equal(res.statusCode, 201);
    for (const action of [getGroupBalances, getGroupDashboard]) {
      res = response(); await action(request(currency), res);
      assert.equal(res.statusCode, 200);
      const balance = (res.body.data.members ?? res.body.data.balances).find(b => String(b.user._id) === sender);
      assert.equal(balance.net, money(currency).round(payment - share));
      assert.equal(balance.settlementPaid, payment);
      if (res.body.data.summary) {
        assert.equal(res.body.data.summary.totalExpenses, total);
        assert.equal(res.body.data.summary.totalOwed, total);
        assert.equal(res.body.data.spendingByCategory[0].amount, total);
        assert.equal(res.body.data.billReminders.dueToday.amount, payment);
      }
    }
  });
}

test('currencies cannot change after financial activity and invalid codes are rejected', async () => {
  let saved = false;
  const record = { _id: 'g', currency: 'PHP', ownerId: sender, async save() { saved = true; } };
  mock.method(Group, 'findById', async () => record);
  mock.method(Expense, 'exists', async () => ({ _id: 'e' }));
  mock.method(Bill, 'exists', async () => null);
  mock.method(Settlement, 'exists', async () => null);
  for (const [currency, status] of [['JPY', 409], ['XYZ', 400], [null, 400]]) {
    const res = response(); await updateGroup(request('PHP', { currency }), res);
    assert.equal(res.statusCode, status); assert.equal(saved, false);
  }
});

test('money validates ISO precisions without changing the stored major-unit representation', () => {
  assert.equal(money('JPY').digits, 0);
  assert.equal(money('KWD').digits, 3);
  for (const currency of ['PHP', 'JPY', 'KWD']) {
    const m = money(currency);
    assert.ok(m.valid(1 / m.scale));
    assert.ok(!m.valid(1 / m.scale / 10));
    assert.ok(!m.valid(Number.MAX_SAFE_INTEGER * 2));
  }
});


test('legacy fractional JPY records stop balance calculation without changing records', async () => {
  const expense = { amount: 1.25, paidBy: { _id: sender }, participants: [{ userId: { _id: sender }, amount: 1.25 }] };
  mock.method(Member, 'find', () => query([{ userId: { _id: sender } }]));
  mock.method(Expense, 'find', () => query([expense]));
  mock.method(Settlement, 'find', () => query([]));
  mock.method(Bill, 'find', () => query([]));
  for (const action of [getGroupBalances, getGroupDashboard, payments.getGroupSettlements]) {
    const res = response(); await action(request('JPY'), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /original records/);
  }
  assert.equal(expense.amount, 1.25);
  assert.equal(expense.participants[0].amount, 1.25);
});

test('receipt parser preserves KWD fils and JPY whole-unit totals', () => {
  const { parseReceipt } = require('../src/modules/receipts/receipt.parser');
  const kwd = parseReceipt('Store\nRECEIPT\nMilk KWD 1.234\nTOTAL KWD 1.234');
  assert.equal(kwd.currency, 'KWD');
  assert.equal(kwd.total, 1.234);
  assert.equal(kwd.items[0].total, 1.234);
  const jpy = parseReceipt('Store\nRECEIPT\nTOTAL JPY 1234');
  assert.equal(jpy.currency, 'JPY');
  assert.equal(jpy.total, 1234);
  assert.equal(parseReceipt('Store\nRECEIPT\nTOTAL JPY 1.25').total, null);
});


test('receipt parsing retains two-decimal items when currency is unknown', () => {
  const { parseReceipt } = require('../src/modules/receipts/receipt.parser');
  const unknown = parseReceipt('Store\nRECEIPT\nMilk 1.50\nTOTAL 1.50');
  assert.equal(unknown.currency, null);
  assert.equal(unknown.items[0].total, 1.5);
  assert.equal(unknown.total, 1.5);
  assert.equal(parseReceipt('Store\nRECEIPT\nCurrency: KWD\nTOTAL 1.234').total, 1.234);
});
