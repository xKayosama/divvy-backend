const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { calculateItemizedExpense } = require('../src/modules/expenses/expense.itemized');
const Expense = require('../src/modules/expenses/Expense');
const Member = require('../src/modules/groups/GroupMember');
const Group = require('../src/modules/groups/Group');
const controller = require('../src/modules/expenses/expense.controller');
const { money } = require('../src/utils/money');
const a = '507f1f77bcf86cd799439011', b = '507f1f77bcf86cd799439012', outsider = '507f1f77bcf86cd799439013';
const line = (amount, memberIds = [a, b]) => ({ description: ' Pizza ', quantity: 2, amount, memberIds });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (body, currency = 'PHP') => ({ params: { id: 'g', expenseId: 'e' }, user: { _id: a }, group: { currency }, body });
afterEach(() => mock.restoreAll());

for (const [currency, total, parts] of [['JPY', 5, [3, 2]], ['PHP', .05, [.03, .02]], ['KWD', .005, [.003, .002]]]) {
  test(`${currency}: itemized sharing conserves native units, including per-item remainders`, () => {
    const result = calculateItemizedExpense({ currency, amount: total, items: [line(total)] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.participants.map(p => p.amount), parts);
    assert.equal(money(currency).sum(result.participants.map(p => p.amount)), total);
    assert.equal(result.items[0].description, 'Pizza');
    const individual = calculateItemizedExpense({ currency, amount: total, items: [line(total, [b]), line(0, [a])] });
    assert.deepEqual(individual.participants.map(p => p.amount), [total, 0]);
  });
}

test('multiple items aggregate member shares and quantity does not multiply the line total', () => {
  const result = calculateItemizedExpense({ amount: 15, items: [line(10, [a]), line(5, [a, b])], currency: 'PHP' });
  assert.deepEqual(result.participants.map(p => p.amount), [12.5, 2.5]);
  assert.equal(result.items[0].quantity, 2);
});

test('invalid amounts, quantities, descriptions and assignments are rejected', () => {
  const bad = [null, [], {}, line(-1), line(.001), line(Infinity), line(NaN), line('1'), line(1, []), line(1, [a,a]), line(1, [null]), line(1, ['bad-id']),
    { ...line(1), quantity: 0 }, { ...line(1), quantity: -1 }, { ...line(1), quantity: '1' }, { ...line(1), quantity: .0001 }, { ...line(1), quantity: 1000001 },
    { ...line(1), description: '' }, { ...line(1), description: ' '.repeat(10) }, { ...line(1), description: 'x'.repeat(201) },
    { ...line(1), amount: Number.MAX_SAFE_INTEGER }];
  for (const item of bad) assert.ok(calculateItemizedExpense({ amount: 1, items: [item], currency: 'PHP' }).error, JSON.stringify(item));
  for (const items of [null, {}, [], Array(101).fill(line(1))]) assert.ok(calculateItemizedExpense({ amount: 1, items, currency: 'PHP' }).error);
  assert.ok(calculateItemizedExpense({ amount: 2, items: [line(1)], currency: 'PHP' }).error);
  assert.ok(calculateItemizedExpense({ amount: 1, items: [line(1.1)], currency: 'JPY' }).error);
});

function allowMembers() {
  mock.method(Member, 'findOne', async () => ({}));
  mock.method(Member, 'find', async filter => filter.userId.$in.filter(id => id !== outsider).map(userId => ({ userId })));
}

test('create saves server-derived participants and retained item metadata', async () => {
  allowMembers();
  let saved;
  mock.method(Expense, 'create', async fields => { saved = { _id: 'e', ...fields, async populate() {} }; return saved; });
  const res = response();
  await controller.createExpense(request({ description: 'Meal', amount: 15, paidBy: a, splitType: 'ITEMIZED', items: [line(10, [a]), line(5)] }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(saved.splitType, 'ITEMIZED');
  assert.deepEqual(saved.participants.map(p => p.amount), [12.5, 2.5]);
  assert.equal(saved.items.length, 2);
  assert.equal(res.body.data.expense.items[1].amount, 5);
});

test('membership checks and server derivation cannot be bypassed by item assignments or submitted shares', async () => {
  allowMembers();
  mock.method(Expense, 'create', () => assert.fail('must not write invalid expense'));
  for (const body of [
    { items: [line(1, [outsider])] },
    { items: [line(1)], participants: [{ userId: a, amount: 0 }] },
    { items: [line(2)] },
  ]) {
    const res = response();
    await controller.createExpense(request({ description: 'Meal', amount: 1, paidBy: a, splitType: 'ITEMIZED', ...body }), res);
    assert.equal(res.statusCode, 400);
  }
});

test('itemized updates preserve items on partial edits and explicit standard conversion removes them', async () => {
  allowMembers();
  const result = calculateItemizedExpense({ amount: 1, items: [line(1)], currency: 'KWD' });
  let saves = 0;
  const saved = { _id: 'e', groupId: 'g', description: 'Meal', paidBy: a, amount: 1, ...result, async save() { saves++; }, async populate() {} };
  mock.method(Group, 'findById', async () => ({ currency: 'KWD' }));
  mock.method(Expense, 'findById', async () => saved);
  let res = response(); await controller.updateExpense(request({ description: 'Updated' }), res);
  assert.equal(res.statusCode, 200); assert.equal(saved.splitType, 'ITEMIZED'); assert.equal(saved.items.length, 1);
  res = response(); await controller.updateExpense(request({ amount: .003, items: [line(.003)] }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(saved.participants.map(p => p.amount), [.002, .001]);
  res = response(); await controller.updateExpense(request({ amount: 1 }), res);
  assert.equal(res.statusCode, 400); assert.equal(saved.amount, .003);
  res = response(); await controller.updateExpense(request({ splitType: 'EXACT', participants: [{ userId: a, amount: .003 }] }), res);
  assert.equal(res.statusCode, 200); assert.equal(saved.splitType, 'EXACT'); assert.equal(saved.items, undefined); assert.equal(saves, 3);
});

test('standard requests cannot silently discard submitted item details', async () => {
  const res = response();
  await controller.createExpense(request({ description: 'Meal', amount: 1, paidBy: a, splitType: 'EQUAL', items: [line(1)], participants: [{ userId: a }] }), res);
  assert.equal(res.statusCode, 400);
});

test('schema serializes item member IDs and preserves Standard defaults without a migration', () => {
  const standard = new Expense({ groupId: a, paidBy: a, amount: 1, description: 'Meal', participants: [{ userId: a, amount: 1 }] });
  assert.equal(standard.splitType, 'EQUAL'); assert.equal(standard.items, undefined);
  const itemized = new Expense({ groupId: a, paidBy: a, amount: 1, description: 'Meal', ...calculateItemizedExpense({ amount: 1, items: [line(1)], currency: 'PHP' }) });
  assert.equal(itemized.validateSync(), undefined);
  assert.equal(JSON.parse(JSON.stringify(itemized)).items[0].memberIds[0], a);
});

test('saved itemization is returned by the expense details controller after membership checks', async () => {
  const saved = { _id: 'e', groupId: 'g', ...calculateItemizedExpense({ amount: .003, items: [line(.003)], currency: 'KWD' }) };
  mock.method(Expense, 'findById', () => ({ populate() { return this; }, then(resolve, reject) { return Promise.resolve(saved).then(resolve, reject); } }));
  mock.method(Member, 'findOne', async () => ({}));
  let res = response(); await controller.getExpenseById(request({}), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.data.expense.items, saved.items);
  mock.method(Member, 'findOne', async () => null);
  res = response(); await controller.getExpenseById(request({}), res); assert.equal(res.statusCode, 403);
});

test('itemized ledger shares drive existing balances and repayment suggestions without double counting', async () => {
  const { getGroupBalances } = require('../src/modules/balances/balance.controller');
  const { getGroupSettlements } = require('../src/modules/settlements/settlement.controller');
  const Settlement = require('../src/modules/settlements/Settlement');
  const result = calculateItemizedExpense({ amount: .005, items: [line(.002, [a]), line(.003, [a,b])], currency: 'KWD' });
  const saved = { amount: .005, paidBy: a, ...result };
  const query = value => ({ populate() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  mock.method(Member, 'find', () => query([a,b].map(_id => ({ userId: { _id } }))));
  mock.method(Expense, 'find', () => query([saved]));
  mock.method(Settlement, 'find', () => query([]));
  let res = response(); await getGroupBalances(request({}, 'KWD'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.totalExpenses, .005); assert.equal(res.body.data.totalOwed, .005);
  assert.deepEqual(res.body.data.members.map(member => member.net), [.001, -.001]);
  res = response(); await getGroupSettlements(request({}, 'KWD'), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.settlements[0].amount, .001);
});
