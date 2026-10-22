const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { calculateSharesExpense } = require('../src/modules/expenses/expense.shares');
const Expense = require('../src/modules/expenses/Expense');
const Member = require('../src/modules/groups/GroupMember');
const Group = require('../src/modules/groups/Group');
const controller = require('../src/modules/expenses/expense.controller');
const { money } = require('../src/utils/money');
const a = '507f1f77bcf86cd799439011', b = '507f1f77bcf86cd799439012';
const people = weights => weights.map((shares, i) => ({ userId: i ? b : a, shares }));
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const req = body => ({ params: { id: 'g', expenseId: 'e' }, group: { currency: 'KWD' }, user: { _id: a }, body });
afterEach(() => mock.restoreAll());

for (const [currency, amount, weights, expected] of [
  ['PHP', 100, [2,1], [66.67,33.33]], ['JPY', 100, [2,1], [67,33]], ['KWD', .1, [2,1], [.067,.033]],
  ['PHP', .01, [1,2], [0,.01]], ['JPY', 2, [1,1,1], [1,1,0]], ['KWD', .001, [1,1], [.001,0]],
]) test(`${currency} ${amount} shares ${weights.join(':')} allocate exactly`, () => {
  const result = calculateSharesExpense({ currency, amount, participants: people(weights) });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.participants.map(p => p.amount), expected);
  assert.deepEqual(result.participants.map(p => p.shares), weights);
  assert.equal(money(currency).sum(result.participants.map(p => p.amount)), amount);
});

test('shares reject absent, zero, fractional, negative, nonnumeric and oversized weights', () => {
  for (const value of [undefined, null, 0, -1, .5, '2', NaN, Infinity, 1000001, {}, []]) {
    assert.ok(calculateSharesExpense({ amount: 1, participants: people([1, value]), currency: 'PHP' }).error);
  }
  assert.ok(calculateSharesExpense({ amount: 1, participants: [], currency: 'PHP' }).error);
  assert.ok(calculateSharesExpense({ amount: .001, participants: people([1,2]), currency: 'PHP' }).error);
});

test('shares use exact integer arithmetic for large weights and large safe amounts', () => {
  const result = calculateSharesExpense({ amount: Number.MAX_SAFE_INTEGER, participants: people([1000000,999999]), currency: 'JPY' });
  assert.equal(result.error, undefined);
  assert.equal(result.participants.reduce((sum, p) => sum + BigInt(p.amount), 0n), BigInt(Number.MAX_SAFE_INTEGER));
});

function allowMembers() {
  mock.method(Member, 'findOne', async () => ({}));
  mock.method(Member, 'find', async filter => filter.userId.$in.map(userId => ({ userId })));
}
test('creation derives amounts from stored weights, ignoring client amount claims', async () => {
  allowMembers();
  let saved;
  mock.method(Expense, 'create', async fields => { saved = { _id: 'e', ...fields, async populate() {} }; return saved; });
  const res = response();
  await controller.createExpense(req({ description: 'Meal', amount: .003, paidBy: a, splitType: 'SHARES', participants: people([2,1]).map(p => ({ ...p, amount: 999 })) }), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(saved.participants.map(p => p.amount), [.002,.001]);
  assert.deepEqual(saved.participants.map(p => p.shares), [2,1]);
});

test('partial updates retain weights and recalculate after total changes; changing split clears weights', async () => {
  allowMembers();
  const saved = { _id: 'e', groupId: 'g', description: 'Meal', paidBy: a, amount: .003,
    ...calculateSharesExpense({ amount: .003, participants: people([2,1]), currency: 'KWD' }), async save() {}, async populate() {} };
  mock.method(Group, 'findById', async () => ({ currency: 'KWD' }));
  mock.method(Expense, 'findById', async () => saved);
  let res = response(); await controller.updateExpense(req({ amount: .006 }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(saved.participants.map(p => p.amount), [.004,.002]);
  assert.deepEqual(saved.participants.map(p => p.shares), [2,1]);
  res = response(); await controller.updateExpense(req({ splitType: 'EQUAL' }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(saved.participants.map(p => p.amount), [.003,.003]);
  assert.ok(saved.participants.every(p => p.shares === undefined));
});

test('inactive and duplicate participants cannot receive share splits', async () => {
  allowMembers();
  mock.method(Expense, 'create', () => assert.fail('must not write'));
  let res = response(); await controller.createExpense(req({ description: 'Meal', amount: 1, paidBy: a, splitType: 'SHARES', participants: [{ userId: a, shares: 1 }, { userId: a, shares: 2 }] }), res);
  assert.equal(res.statusCode, 400);
  mock.method(Member, 'find', async () => []);
  res = response(); await controller.createExpense(req({ description: 'Meal', amount: 1, paidBy: a, splitType: 'SHARES', participants: people([2,1]) }), res);
  assert.equal(res.statusCode, 400);
});

test('schema persists share weights and keeps legacy split defaults', async () => {
  const fields = { groupId: a, paidBy: a, description: 'Meal', amount: 1 };
  const standard = new Expense({ ...fields, participants: [{ userId: a, amount: 1 }] });
  assert.equal(standard.splitType, 'EQUAL'); assert.equal(standard.participants[0].shares, null);
  const shared = new Expense({ ...fields, ...calculateSharesExpense({ amount: 1, participants: people([2,1]), currency: 'PHP' }) });
  await shared.validate();
  assert.deepEqual(JSON.parse(JSON.stringify(shared)).participants.map(p => p.shares), [2,1]);
});
