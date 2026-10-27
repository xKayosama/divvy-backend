const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Member = require('../src/modules/groups/GroupMember');
const Group = require('../src/modules/groups/Group');
const User = require('../src/modules/users/User');
const invitations = require('../src/modules/groups/group.invitations');
const groupId = '100000000000000000000001';
const userId = '200000000000000000000001';
const ownerId = '300000000000000000000001';
const invitationId = '400000000000000000000001';
const email = 'friend@example.com';
const group = { _id: groupId, ownerId, name: 'Our trip', currency: 'PHP' };
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const req = () => ({ group, membership: { role: 'OWNER' }, user: { _id: ownerId, email: 'owner@example.com' }, params: { id: groupId, invitationId }, body: { email } });
const recipient = record => ({ user: { _id: userId, email }, params: { invitationId }, body: { createdAt: record.invitation.createdAt.toISOString(), code: "a".repeat(32) } });
afterEach(() => mock.restoreAll());
function record() {
 return { _id: invitationId, groupId, status: 'INACTIVE', role: 'MEMBER', invitation: {
  email, codeHash: createHash('sha256').update('a'.repeat(32)).digest('hex'), status: 'PENDING', invitedBy: ownerId,
  createdAt: new Date('2026-01-01'), expiresAt: new Date(Date.now() + 86400000)
 } };
}
function setupCreate(existing = null, user = null) {
 mock.method(Member, 'init', async () => {});
 mock.method(User, 'findOne', async () => user);
 mock.method(Member, 'findOne', () => query(existing));
 mock.method(Member, 'create', async values => ({ _id: invitationId, ...values }));
}
function setupResponse(value) {
 mock.method(Member, 'findOne', filter => query(filter['invitation.email'] === email ? structuredClone(value) : null));
 mock.method(Group, 'findById', async () => group);
 mock.method(Member, 'findOneAndUpdate', (filter, update) => {
  const match = value.status === filter.status && value.invitation.status === filter['invitation.status'] &&
   value.invitation.codeHash === filter['invitation.codeHash'] && value.invitation.expiresAt > filter['invitation.expiresAt'].$gt;
  if (!match) return query(null);
  for (const [key, field] of Object.entries(update.$set)) {
   if (key.startsWith('invitation.')) value.invitation[key.slice(11)] = field;
   else value[key] = field;
  }
  return query(structuredClone(value));
 });
}

test('new and unregistered recipients remain inactive; raw code is returned once and only its hash is stored', async () => {
 setupCreate(); const request = req(); request.body.email = ' FRIEND@example.com '; const res = response();
 await invitations.create(request, res);
 assert.equal(res.statusCode, 201); assert.match(res.body.data.code, /^[a-f0-9]{32}$/);
 const stored = Member.create.mock.calls[0].arguments[0];
 assert.equal(stored.status, 'INACTIVE'); assert.equal(stored.userId, undefined); assert.equal(stored.invitation.email, email);
 assert.equal(stored.invitation.expiresAt - stored.invitation.createdAt, 7 * 86400000);
 assert.equal(stored.invitation.codeHash, createHash('sha256').update(res.body.data.code).digest('hex'));
 assert.equal(res.body.data.invitation.codeHash, undefined); assert.equal(res.body.data.invitation.group.name, group.name);
});

test('creation rejects nonowners, malformed emails, self invites, active members and duplicate pending invitations', async () => {
 let request = req(); request.membership.role = 'MEMBER'; let res = response(); await invitations.create(request, res); assert.equal(res.statusCode, 403);
 for (const email of [{}, '', 'invalid', 'a'.repeat(255)+'@example.com', 'owner@example.com']) {
  request = req(); request.body.email = email; res = response(); await invitations.create(request, res); assert.equal(res.statusCode, 400);
 }
 setupCreate({ status: 'ACTIVE' }); res = response(); await invitations.create(req(), res); assert.equal(res.statusCode, 409);
 mock.method(Member, 'findOne', () => query(record())); res = response(); await invitations.create(req(), res); assert.equal(res.statusCode, 409);
});

test('expired/revoked invites reuse inactive memberships with a generation comparison', async () => {
 const old = record(); old.userId = userId; old.invitation.status = 'REVOKED'; setupCreate(old, { _id: userId });
 mock.method(Member, 'findOneAndUpdate', (filter, update) => {
  assert.equal(filter._id, invitationId); assert.equal(filter.status, 'INACTIVE'); assert.equal(filter['invitation.codeHash'], old.invitation.codeHash);
  assert.equal(update.$set.role, 'MEMBER'); return query({ ...old, ...update.$set });
 });
 const res = response(); await invitations.create(req(), res); assert.equal(res.statusCode, 201); assert.equal(Member.create.mock.callCount(), 0);
});

test('concurrent creation conflicts and index initialization failures fail safely', async () => {
 setupCreate(); mock.method(Member, 'create', async () => { throw Object.assign(Error(), { code: 11000 }); });
 let res = response(); await invitations.create(req(), res); assert.equal(res.statusCode, 409);
 mock.method(Member, 'init', async () => { throw Error('index unavailable'); });
 res = response(); await invitations.create(req(), res); assert.equal(res.statusCode, 503);
});

test('invitation-only records validate without a registered user; ordinary memberships still require userId', () => {
 const invitation = record().invitation;
 assert.equal(new Member({ groupId, status: 'INACTIVE', invitation }).validateSync(), undefined);
 assert.ok(new Member({ groupId }).validateSync().errors.userId);
 assert.equal(Member.schema.path('invitation').options.select, false);
 assert.ok(Member.schema.indexes().some(([keys, options]) => keys['invitation.email'] && options.unique && options.partialFilterExpression));
});

test('accept atomically activates only the invited account, sets its join date and cannot be replayed', async () => {
 const value = record(); setupResponse(value);
 const res = response(); await invitations.accept(recipient(value), res);
 assert.equal(res.statusCode, 200); assert.equal(value.status, 'ACTIVE'); assert.equal(value.userId, userId); assert.equal(value.invitation.status, 'ACCEPTED'); assert.ok(value.joinedAt instanceof Date);
 const replay = response(); await invitations.accept(recipient(value), replay); assert.equal(replay.statusCode, 409);
});

test('decline never activates membership, and a decline racing accept has only one winner', async () => {
 const value = record(); setupResponse(value); const request = recipient(value);
 const results = [response(), response()];
 await Promise.all([invitations.decline(request, results[0]), invitations.accept(request, results[1])]);
 assert.deepEqual(results.map(res => res.statusCode).sort(), [200, 409]); assert.equal(value.status, 'INACTIVE'); assert.equal(value.invitation.status, 'DECLINED');
});

test('wrong accounts, expired, revoked and deleted-group invitations cannot be accepted', async () => {
 const value = record(); setupResponse(value); let request = recipient(value); request.user.email = 'other@example.com'; let res = response();
 await invitations.accept(request, res); assert.equal(res.statusCode, 404);
 value.invitation.expiresAt = new Date(Date.now()-1); res = response(); await invitations.accept(recipient(value), res); assert.equal(res.statusCode, 410);
 value.invitation.expiresAt = new Date(Date.now()+86400000); value.invitation.status = 'REVOKED'; res = response(); await invitations.accept(recipient(value), res); assert.equal(res.statusCode, 409);
 value.invitation.status = 'PENDING'; mock.method(Group, 'findById', async () => null); res = response(); await invitations.accept(recipient(value), res); assert.equal(res.statusCode, 404);
 assert.equal(value.status, 'INACTIVE');
});

test('old screens cannot answer a replacement invitation or malformed IDs', async () => {
 const value = record(); setupResponse(value); const request = recipient(value); request.body.createdAt = new Date(0).toISOString(); let res = response();
 await invitations.accept(request, res); assert.equal(res.statusCode, 409);
 request.params.invitationId = 'bad'; res = response(); await invitations.accept(request, res); assert.equal(res.statusCode, 404);
 assert.equal(Member.findOneAndUpdate.mock.callCount(), 0);
});

test('code lookup normalizes input, scopes to recipient and does not join', async () => {
 const value = record(); setupResponse(value); const request = recipient(value); request.body = { code: ' A'.trim().repeat(32) };
 const res = response(); await invitations.lookup(request, res); assert.equal(res.statusCode, 200);
 const filter = Member.findOne.mock.calls[0].arguments[0]; assert.equal(filter['invitation.email'], email); assert.equal(filter['invitation.codeHash'], value.invitation.codeHash); assert.equal(value.status, 'INACTIVE');
});

test('incoming invitations hide deleted groups and expose no hashes; owner listing requires ownership', async () => {
 const value = record(); value.groupId = group;
 mock.method(Member, 'find', filter => { assert.equal(filter.status, 'INACTIVE'); assert.equal(filter['invitation.email'], email); return query([value, { ...value, groupId: null }]); });
 let res = response(); await invitations.incoming(recipient(value), res); assert.equal(res.body.data.invitations.length, 1); assert.equal(JSON.stringify(res.body).includes('codeHash'), false);
 const request = req(); request.membership.role = 'MEMBER'; res = response(); await invitations.outgoing(request, res); assert.equal(res.statusCode, 403);
});

test('owner revocation is scoped to group, generation, pending state and inactive membership', async () => {
 mock.method(Member, 'findOneAndUpdate', filter => {
  assert.equal(filter.groupId, groupId); assert.equal(filter.status, 'INACTIVE'); assert.equal(filter['invitation.status'], 'PENDING'); assert.ok(filter['invitation.createdAt']); return query(record());
 });
 const request = req(); request.body.createdAt = record().invitation.createdAt.toISOString(); let res = response(); await invitations.revoke(request, res); assert.equal(res.statusCode, 200);
 request.membership.role = 'MEMBER'; res = response(); await invitations.revoke(request, res); assert.equal(res.statusCode, 403);
});

test('all invitation routes require authentication; legacy direct addition grants no access', async () => {
 const router = require('../src/modules/groups/invitation.routes');
 const { protect } = require('../src/modules/auth/auth.middleware');
 assert.equal(router.stack[0].handle, protect);
 const groupRoutes = require('../src/modules/groups/group.routes');
 const legacy = groupRoutes.stack.find(layer => layer.route?.path === '/:id/members' && layer.route.methods.post).route;
 const res = response(); legacy.stack.at(-1).handle({}, res); assert.equal(res.statusCode, 410);
});


test('knowing the target email or invitation ID without the shared code cannot activate membership', async () => {
 const value = record(); setupResponse(value); const request = recipient(value); delete request.body.code;
 let res = response(); await invitations.accept(request, res); assert.equal(res.statusCode, 400);
 request.body.code = 'b'.repeat(32); res = response(); await invitations.accept(request, res); assert.equal(res.statusCode, 400);
 assert.equal(value.status, 'INACTIVE'); assert.equal(Member.findOneAndUpdate.mock.callCount(), 0);
});
