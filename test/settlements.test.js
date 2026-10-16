const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Settlement = require('../src/modules/settlements/Settlement');
const Member = require('../src/modules/groups/GroupMember');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const controller = require('../src/modules/settlements/settlement.controller');
const sender = '507f1f77bcf86cd799439011';
const recipient = '507f1f77bcf86cd799439012';
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = body => ({ params: { id: 'g' }, user: { _id: sender }, body, query: {} });
function query(value) {
  const chain = { then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  for (const method of ['populate', 'sort', 'skip', 'limit']) chain[method] = () => chain;
  return chain;
}
afterEach(() => mock.restoreAll());

test('records sender payment, group, date and audit identity', async () => {
  mock.method(Member, 'findOne', async filter => { assert.deepEqual(filter, { groupId: 'g', userId: recipient, status: 'ACTIVE' }); return {}; });
  mock.method(Settlement, 'createIndexes', async () => {});
  mock.method(Member, 'find', () => query([sender, recipient].map(_id => ({ userId: { _id } }))));
  mock.method(Expense, 'find', () => query([{ paidBy: recipient, amount: 600, participants: [{ userId: sender, amount: 300 }, { userId: recipient, amount: 300 }] }]));
  mock.method(Settlement, 'find', () => query([]));
  mock.method(Settlement, 'create', async fields => fields);
  const res = response();
  await controller.recordSettlement(request({ to: recipient, amount: 300, paidAt: '2026-01-01' }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.settlement.from, sender);
  assert.equal(res.body.data.settlement.recordedBy, sender);
  assert.equal(res.body.data.settlement.amount, 300);
  assert.equal(res.body.data.settlement.groupId, 'g');
});

test('rejects invalid amounts, recipients, dates and recording another sender', async () => {
  mock.method(Settlement, 'create', () => assert.fail('must not write'));
  for (const body of [
    ...[0, -1, 0.001, '300', Infinity, NaN, 1e20].map(amount => ({ to: recipient, amount })),
    { to: sender, amount: 1 }, { to: 'invalid', amount: 1 },
    { to: recipient, amount: 1, paidAt: 'invalid' },
    { to: recipient, amount: 1, paidAt: null },
    { to: recipient, amount: 1, paidAt: '2099-01-01' }
  ]) {
    const res = response(); await controller.recordSettlement(request(body), res); assert.equal(res.statusCode, 400);
  }
  const res = response();
  await controller.recordSettlement(request({ from: recipient, to: recipient, amount: 1 }), res);
  assert.equal(res.statusCode, 403);
  mock.method(Member, 'findOne', async () => null);
  const inactive = response(); await controller.recordSettlement(request({ to: recipient, amount: 1 }), inactive);
  assert.equal(inactive.statusCode, 400);
});

test('partial and full repayments agree across balances, suggestions and dashboard', async () => {
  const users = [recipient, sender].map(_id => ({ _id }));
  mock.method(Member, 'find', () => query(users.map(userId => ({ userId }))));
  mock.method(Expense, 'find', () => query([{ amount: 1500, paidBy: users[0], participants: users.map(userId => ({ userId, amount: 750 })) }]));
  mock.method(Bill, 'find', () => query([]));
  for (const amount of [300, 750, 800]) {
    mock.method(Settlement, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return query([{ from: sender, to: recipient, amount }]); });
    const balances = response(); await require('../src/modules/balances/balance.controller').getGroupBalances(request({}), balances);
    const members = balances.body.data.members;
    assert.deepEqual(members.map(m => m.net), [750 - amount, amount - 750]);
    assert.equal(balances.body.data.totalExpenses, 1500);
    assert.equal(members[0].paid, 1500);
    assert.equal(members[1].settlementPaid, amount);
    const suggestions = response(); await controller.getGroupSettlements(request({}), suggestions);
    const items = suggestions.body.data.settlements;
    if (amount === 750) assert.deepEqual(items, []);
    else {
      assert.equal(items[0].amount, Math.abs(750 - amount));
      assert.equal(items[0].from._id, amount > 750 ? recipient : sender);
    }
    const dashboard = response(); await require('../src/modules/dashboard/dashboard.controller').getGroupDashboard(request({}), dashboard);
    assert.deepEqual(dashboard.body.data.balances.map(m => m.net), members.map(m => m.net));
  }
});

test('history is scoped, populated and paginated', async () => {
  const chain = query([{ amount: 300 }]);
  chain.sort = value => { assert.deepEqual(value, { paidAt: -1, createdAt: -1, _id: -1 }); return chain; };
  chain.skip = value => { assert.equal(value, 5); return chain; };
  chain.limit = value => { assert.equal(value, 5); return chain; };
  mock.method(Settlement, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain; });
  mock.method(Settlement, 'countDocuments', async filter => { assert.deepEqual(filter, { groupId: 'g' }); return 6; });
  const req = request({}); req.query = { page: '2', limit: '5' };
  const res = response(); await controller.getSettlementHistory(req, res);
  assert.equal(res.body.pagination.totalPages, 2);
  assert.equal(res.body.data.settlements[0].amount, 300);
  req.query.limit = '101'; const invalid = response(); await controller.getSettlementHistory(req, invalid); assert.equal(invalid.statusCode, 400);
});

test('settlement routes require authentication and active group access', async () => {
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/api/groups', require('../src/modules/settlements/settlement.routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/groups/g/settlements`;
    for (const [url, method] of [[base, 'POST'], [base + '/history', 'GET']]) {
      assert.equal((await fetch(url, { method })).status, 401);
    }
    const secretBefore = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'settlement-test-secret';
    try {
      const token = require('jsonwebtoken').sign({ userId: sender }, process.env.JWT_SECRET, { expiresIn: '1h' });
      mock.method(require('../src/modules/users/User'), 'findById', () => ({ select: async () => ({ _id: sender }) }));
      mock.method(require('../src/modules/auth/RevokedToken'), 'exists', async () => null);
      mock.method(require('../src/modules/groups/Group'), 'findById', async () => ({ _id: 'g' }));
      mock.method(Member, 'findOne', async () => null);
      mock.method(Settlement, 'create', () => assert.fail('nonmember must not write'));
      for (const [url, method] of [[base, 'POST'], [base + '/history', 'GET']]) {
        assert.equal((await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } })).status, 403);
      }
    } finally {
      if (secretBefore === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = secretBefore;
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function paymentFixture(alreadyPaid = 0) {
  const payments = alreadyPaid ? [{ _id: 'old-payment', from: sender, to: recipient, amount: alreadyPaid }] : [];
  mock.method(Member, 'findOne', async () => ({}));
  mock.method(Member, 'find', () => query([sender, recipient].map(_id => ({ userId: { _id } }))));
  mock.method(Expense, 'find', () => query([{ paidBy: recipient, amount: 600, participants: [{ userId: sender, amount: 300 }, { userId: recipient, amount: 300 }] }]));
  mock.method(Settlement, 'find', () => query([...payments]));
  mock.method(Settlement, 'createIndexes', async () => {});
  mock.method(Settlement, 'findOne', async () => null);
  return payments;
}

test('settled balances and payments exceeding the remainder cannot be recorded', async () => {
  paymentFixture(300);
  mock.method(Settlement, 'create', () => assert.fail('settled must not write'));
  const settled = response(); await controller.recordSettlement(request({ to: recipient, amount: 1 }), settled);
  assert.equal(settled.statusCode, 409);
  paymentFixture(200);
  const excessive = response(); await controller.recordSettlement(request({ to: recipient, amount: 100.01 }), excessive);
  assert.equal(excessive.statusCode, 409);
});

test('partial payment permits only the unpaid remainder', async () => {
  const payments = paymentFixture();
  mock.method(Settlement, 'create', async fields => { const item = { _id: String(payments.length), ...fields }; payments.push(item); return item; });
  for (const [amount, expected] of [[100, 201], [200, 201], [1, 409]]) {
    const res = response(); await controller.recordSettlement(request({ to: recipient, amount }), res); assert.equal(res.statusCode, expected);
  }
  assert.equal(payments.length, 2);
});

test('same request ID replays the original payment and rejects changed details', async () => {
  const previous = { groupId: 'g', from: sender, to: recipient, amount: 300, paidAt: new Date('2026-01-01'), requestId: 'payment_request_1' };
  mock.method(Settlement, 'findOne', async filter => { assert.equal(filter.from, sender); assert.equal(filter.groupId, 'g'); assert.equal(filter.requestId, previous.requestId); return previous; });
  mock.method(Settlement, 'create', () => assert.fail('must not create replay'));
  for (const [amount, expected] of [[300, 200], [200, 409]]) {
    const res = response(); await controller.recordSettlement(request({ to: recipient, amount, paidAt: '2026-01-01', requestId: previous.requestId }), res); assert.equal(res.statusCode, expected);
  }
});

test('concurrent requests for the same balance claim create only one payment', async () => {
  paymentFixture();
  const claims = new Set();
  mock.method(Settlement, 'create', async fields => {
    if (claims.has(fields.balanceClaim)) throw Object.assign(new Error('Duplicate balance claim'), { code: 11000 });
    claims.add(fields.balanceClaim); return fields;
  });
  const results = [response(), response()];
  await Promise.all(results.map((res, index) => controller.recordSettlement(request({ to: recipient, amount: 300, paidAt: '2026-01-01', requestId: `parallel_request_${index}` }), res)));
  assert.deepEqual(results.map(res => res.statusCode).sort(), [201, 409]);
  assert.equal(claims.size, 1);
});
