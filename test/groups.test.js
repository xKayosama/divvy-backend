const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Group = require('../src/modules/groups/Group');
const Member = require('../src/modules/groups/GroupMember');
const Expense = require('../src/modules/expenses/Expense');
const Bill = require('../src/modules/bills/Bill');
const groups = require('../src/modules/groups/group.controller');
const expenses = require('../src/modules/expenses/expense.controller');
const bills = require('../src/modules/bills/bill.controller');
const { groupAccess } = require('../src/modules/groups/groupAccess.middleware');
const { migrateGroups } = require('../scripts/migrate-groups');
afterEach(() => mock.restoreAll());
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const query = value => ({ populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const req = () => ({ params: { id: 'g' }, user: { _id: 'a' }, group: { _id: 'g' }, membership: { role: 'OWNER' }, body: {}, query: {} });

test('models retain collections and Group references, membership status and defaults', () => {
  assert.equal(Group.collection.name, 'households');
  assert.equal(Member.collection.name, 'householdmembers');
  for (const Model of [Member, Expense, Bill]) {
    assert.equal(Model.schema.path('groupId').options.ref, 'Group');
    assert.equal(Model.schema.path('groupId').isRequired, true);
    assert.equal(Model.schema.path('householdId'), undefined);
  }
  assert.deepEqual(Member.schema.path('status').enumValues, ['ACTIVE', 'INACTIVE']);
  assert.equal(new Group({ name: 'Trip', ownerId: '012345678901234567890123' }).currency, 'PHP');
});

test('Group access uses active group membership and denies missing groups/nonmembers', async () => {
  mock.method(Group, 'findById', async () => null);
  let res = response(); await groupAccess(req(), res, () => assert.fail()); assert.equal(res.statusCode, 404);
  mock.method(Group, 'findById', async () => ({ _id: 'g' }));
  mock.method(Member, 'findOne', async filter => { assert.deepEqual(filter, { groupId: 'g', userId: 'a', status: 'ACTIVE' }); return null; });
  res = response(); await groupAccess(req(), res, () => assert.fail()); assert.equal(res.statusCode, 403);
  mock.method(Member, 'findOne', async () => ({ role: 'MEMBER' }));
  const request = req(); let passed = false; await groupAccess(request, response(), () => { passed = true; });
  assert.ok(passed); assert.equal(request.group._id, 'g');
});

test('Group create, list, read, update, delete preserve owner membership and cascades', async () => {
  const record = { _id: 'g', name: 'Trip', currency: 'PHP', ownerId: 'a', save: async () => {} };
  mock.method(Group, 'create', async fields => { assert.deepEqual(fields, { name: 'Trip', ownerId: 'a' }); return record; });
  mock.method(Member, 'create', async fields => { assert.deepEqual(fields, { groupId: 'g', userId: 'a', role: 'OWNER' }); return fields; });
  let request = req(); request.body.name = ' Trip '; let res = response(); await groups.createGroup(request, res); assert.equal(res.statusCode, 201); assert.equal(res.body.data.group, record);
  mock.method(Member, 'find', () => query([{ groupId: record, userId: { _id: 'a' }, role: 'OWNER' }]));
  res = response(); await groups.getMyGroups(req(), res); assert.equal(res.body.data.groups[0].id, 'g');
  request = req(); request.group = record; res = response(); await groups.getGroupById(request, res); assert.equal(res.body.data.group.id, 'g');
  mock.method(Group, 'findById', async () => record);
  request = req(); request.body = { name: ' Event ', currency: ' usd ' }; res = response(); await groups.updateGroup(request, res); assert.equal(record.name, 'Event'); assert.equal(record.currency, 'USD');
  request.user._id = 'b'; res = response(); await groups.updateGroup(request, res); assert.equal(res.statusCode, 403);
  mock.method(Group, 'findByIdAndDelete', async id => assert.equal(id, 'g'));
  for (const Model of [Member, Expense, Bill]) mock.method(Model, 'deleteMany', async filter => assert.deepEqual(filter, { groupId: 'g' }));
  res = response(); await groups.deleteGroup(req(), res); assert.equal(res.statusCode, 200);
});

test('group list skips missing references and preserves valid memberships', async () => {
  const record = { _id: 'g', name: 'Trip', currency: 'PHP', ownerId: { _id: 'a' } };
  mock.method(Member, 'find', filter => {
    assert.deepEqual(filter, { userId: 'a', status: 'ACTIVE' });
    return query([
      { groupId: null, role: 'MEMBER' },
      { householdId: 'legacy', role: 'OWNER' },
      { groupId: record, role: 'OWNER', joinedAt: '2026-10-02' }
    ]);
  });
  const res = response();
  await groups.getMyGroups(req(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.groups, [{
    id: 'g', name: 'Trip', currency: 'PHP', role: 'OWNER',
    owner: record.ownerId, joinedAt: '2026-10-02'
  }]);
  mock.method(Member, 'find', () => query([{ groupId: null }, {}]));
  const empty = response();
  await groups.getMyGroups(req(), empty);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body.data.groups, []);
});

test('member management keeps owner restrictions, duplicate rejection and INACTIVE removal', async () => {
  const User = require('../src/modules/users/User');
  mock.method(User, 'findOne', async () => ({ _id: 'b', email: 'b@example.com' }));
  mock.method(Member, 'findOne', async () => null);
  mock.method(Member, 'create', async fields => { assert.equal(fields.groupId, 'g'); return fields; });
  const request = req(); request.body.email = 'b@example.com'; let res = response(); await groups.addGroupMember(request, res); assert.equal(res.statusCode, 201);
  mock.method(Member, 'findOne', async () => ({ status: 'ACTIVE' }));
  res = response(); await groups.addGroupMember(request, res); assert.equal(res.statusCode, 409);
  const membership = { status: 'ACTIVE', save: async () => {} }; mock.method(Member, 'findOne', async () => membership);
  request.params.userId = 'b'; res = response(); await groups.removeGroupMember(request, res); assert.equal(membership.status, 'INACTIVE');
  request.params.userId = 'a'; res = response(); await groups.removeGroupMember(request, res); assert.equal(res.statusCode, 400);
  request.membership.role = 'MEMBER'; res = response(); await groups.addGroupMember(request, res); assert.equal(res.statusCode, 403);
});

test('removed members can rejoin by reactivating their existing membership', async () => {
  const User = require('../src/modules/users/User');
  mock.method(User, 'findOne', async () => ({ _id: 'b', email: 'b@example.com' }));
  let saves = 0;
  const membership = {
    status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date('2020-01-01'),
    async save() { saves++; return this; }
  };
  mock.method(Member, 'findOne', async () => membership);
  mock.method(Member, 'create', () => assert.fail('must reuse the existing membership'));
  const request = req();
  request.params.userId = 'b';
  request.body.email = 'b@example.com';
  await groups.removeGroupMember(request, response());
  assert.equal(membership.status, 'INACTIVE');
  const beforeRejoin = Date.now();
  const res = response();
  await groups.addGroupMember(request, res);
  assert.equal(res.statusCode, 201);
  assert.equal(membership.status, 'ACTIVE');
  assert.equal(membership.role, 'MEMBER');
  assert.ok(membership.joinedAt.getTime() >= beforeRejoin);
  assert.equal(res.body.data.member.joinedAt, membership.joinedAt);
  assert.equal(saves, 2);
  const duplicate = response();
  await groups.addGroupMember(request, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(saves, 2);
});

const expenseRequest = (splitType, participants, amount = 10) => ({ ...req(), body: { description: 'Shared meal', paidBy: 'a', amount, splitType, participants } });
function allowExpenseMembers() {
  mock.method(Member, 'findOne', async filter => { assert.equal(filter.groupId, 'g'); assert.equal(filter.status, 'ACTIVE'); return {}; });
  mock.method(Member, 'find', async filter => filter.userId.$in.map(userId => ({ userId })));
  mock.method(Expense, 'create', async fields => ({ ...fields, populate: async () => {} }));
}
test('expense creation preserves EQUAL remainder, EXACT and PERCENTAGE splits', async () => {
  allowExpenseMembers();
  for (const [split, participants, expected] of [
    ['EQUAL', [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], [3.34, 3.33, 3.33]],
    ['EXACT', [{ userId: 'a', amount: 7 }, { userId: 'b', amount: 3 }], [7, 3]],
    ['PERCENTAGE', [{ userId: 'a', percentage: 70 }, { userId: 'b', percentage: 30 }], [7, 3]]
  ]) {
    const res = response(); await expenses.createExpense(expenseRequest(split, participants), res);
    assert.equal(res.statusCode, 201); assert.equal(res.body.data.expense.groupId, 'g');
    assert.deepEqual(res.body.data.expense.participants.map(p => p.amount), expected);
  }
});
test('expense validation rejects duplicates, inactive payer/participants and unequal exact totals', async () => {
  allowExpenseMembers();
  let res = response(); await expenses.createExpense(expenseRequest('EQUAL', [{ userId: 'a' }, { userId: 'a' }]), res); assert.equal(res.statusCode, 400); assert.match(res.body.message, /Duplicate/);
  res = response(); await expenses.createExpense(expenseRequest('EXACT', [{ userId: 'a', amount: 9 }]), res); assert.equal(res.statusCode, 400); assert.match(res.body.message, /must equal/);
  mock.method(Member, 'find', async () => []); res = response(); await expenses.createExpense(expenseRequest('EQUAL', [{ userId: 'b' }]), res); assert.equal(res.statusCode, 400);
  mock.method(Member, 'findOne', async () => null); res = response(); await expenses.createExpense(expenseRequest('EQUAL', [{ userId: 'a' }]), res); assert.equal(res.statusCode, 400);
});
test('expense pagination, category, inclusive date range and sort remain scoped to group', async () => {
  const request = req(); request.query = { page: '2', limit: '5', category: 'food', startDate: '2026-09-01', endDate: '2026-09-02' };
  const chain = query([]); chain.sort = sort => { assert.deepEqual(sort, { date: -1, createdAt: -1 }); return chain; }; chain.skip = skip => { assert.equal(skip, 5); return chain; }; chain.limit = limit => { assert.equal(limit, 5); return chain; };
  const check = filter => { assert.equal(filter.groupId, 'g'); assert.equal(filter.category, 'FOOD'); assert.equal(filter.date.$lt.toISOString(), '2026-09-03T00:00:00.000Z'); };
  mock.method(Expense, 'find', filter => { check(filter); return chain; }); mock.method(Expense, 'countDocuments', async filter => { check(filter); return 11; });
  const res = response(); await expenses.getGroupExpenses(request, res); assert.equal(res.body.pagination.totalPages, 3); assert.equal(res.body.pagination.hasNextPage, true);
});
test('expense resource read, update and delete authorize using groupId', async () => {
  const record = { groupId: 'g', description: 'Meal', amount: 10, category: 'FOOD', paidBy: 'a', splitType: 'EXACT', participants: [{ userId: 'a', amount: 10 }], save: async () => {}, populate: async () => {} };
  allowExpenseMembers(); mock.method(Expense, 'findById', () => query(record)); mock.method(Expense, 'findByIdAndDelete', async () => {});
  const request = req(); request.params.expenseId = 'e';
  for (const action of [expenses.getExpenseById, expenses.updateExpense, expenses.deleteExpense]) { const res = response(); await action(request, res); assert.equal(res.statusCode, 200); }
  mock.method(Member, 'findOne', async () => null);
  for (const action of [expenses.getExpenseById, expenses.updateExpense, expenses.deleteExpense]) { const res = response(); await action(request, res); assert.equal(res.statusCode, 403); }
});
test('balance, settlements and dashboard retain totals and Group filters', async () => {
  const users = [{ _id: 'a' }, { _id: 'b' }];
  mock.method(Member, 'find', filter => { assert.equal(filter.groupId, 'g'); return query(users.map(userId => ({ userId }))); });
  const raw = { amount: 10, paidBy: 'a', participants: [{ userId: 'a', amount: 5 }, { userId: 'b', amount: 5 }] };
  mock.method(Expense, 'find', filter => { assert.equal(filter.groupId, 'g'); return query([raw]); });
  const res = response(); await require('../src/modules/balances/balance.controller').getGroupBalances(req(), res); assert.deepEqual(res.body.data.members.map(m => m.net), [5, -5]);
  const settlement = response(); await require('../src/modules/settlements/settlement.controller').getGroupSettlements(req(), settlement); assert.equal(settlement.body.data.settlements[0].amount, 5);
  mock.method(Expense, 'find', () => query([{ ...raw, paidBy: users[0], participants: users.map(userId => ({ userId, amount: 5 })) }]));
  mock.method(Bill, 'find', filter => { assert.equal(filter.groupId, 'g'); return query([{ amount: 20, status: 'PENDING', dueDate: '2099-01-01' }]); });
  const dashboard = response(); await require('../src/modules/dashboard/dashboard.controller').getGroupDashboard(req(), dashboard);
  assert.equal(dashboard.body.data.summary.totalExpenses, 10); assert.deepEqual(dashboard.body.data.balances.map(b => b.net), [5, -5]); assert.equal(dashboard.body.data.bills.pendingAmount, 20); assert.equal(dashboard.body.data.upcomingBills.length, 1);
});
test('recurring bill CRUD uses groupId and membership authorization', async () => {
  mock.method(Member, 'findOne', async filter => { assert.equal(filter.groupId, 'g'); return {}; });
  let record;
  mock.method(Bill, 'create', async fields => (record = { ...fields, save: async () => {}, populate: async () => {} }));
  const request = req(); request.body = { name: 'Rent', amount: 20, dueDate: '2099-01-01', isRecurring: true, recurrence: 'MONTHLY', paidBy: 'a' };
  let res = response(); await bills.createBill(request, res); assert.equal(res.statusCode, 201); assert.equal(record.groupId, 'g');
  mock.method(Bill, 'findById', () => query(record)); mock.method(Bill, 'findOneAndUpdate', async () => record); mock.method(Bill, 'findOneAndDelete', async () => record);
  request.params.billId = 'b'; request.body = {};
  for (const action of [bills.getBillById, bills.updateBill, bills.deleteBill]) { res = response(); await action(request, res); assert.equal(res.statusCode, 200); }
  mock.method(Member, 'findOne', async () => null); res = response(); await bills.getBillById(request, res); assert.equal(res.statusCode, 403);
});

test('migration defaults to dry run and checks all conflicts before updates', async () => {
  const writes = [];
  const db = { listCollections: () => ({ toArray: async () => ['householdmembers', 'expenses', 'bills'].map(name => ({ name })) }), collection: name => ({ countDocuments: async filter => filter.groupId ? 0 : 2, updateMany: async (...args) => writes.push([name, ...args]) }) };
  await migrateGroups(db, { log: () => {} }); assert.equal(writes.length, 0);
  db.collection = name => ({ countDocuments: async filter => filter.groupId && name === 'bills' ? 1 : 0, updateMany: async () => writes.push(name) });
  await assert.rejects(migrateGroups(db, { dryRun: false, log: () => {} }), /conflicting/); assert.equal(writes.length, 0);
});
test('migration applies pipeline to all affected collections and reruns safely', async () => {
  const writes = []; const remaining = new Set(['householdmembers', 'expenses', 'bills']);
  const db = { listCollections: () => ({ toArray: async () => [...remaining].map(name => ({ name })) }), collection: name => ({ countDocuments: async filter => filter.groupId ? 0 : Number(remaining.has(name)), updateMany: async (filter, pipeline) => { writes.push(name); assert.deepEqual(pipeline, [{ $set: { groupId: '$householdId' } }, { $unset: 'householdId' }]); remaining.delete(name); } }) };
  await migrateGroups(db, { dryRun: false, log: () => {} }); assert.deepEqual(writes, ['householdmembers', 'expenses', 'bills']);
  await migrateGroups(db, { dryRun: false, log: () => {} }); assert.equal(writes.length, 3);
});
test('Express starts, health works, groups require auth and legacy route is gone', async () => {
  const app = require('../src/app'); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    for (const path of ['/api/groups', '/api/groups/g/members', '/api/groups/g/expenses', '/api/groups/g/bills', '/api/groups/g/dashboard', '/api/groups/g/balances', '/api/groups/g/settlements']) assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(`${base}/api/households`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
