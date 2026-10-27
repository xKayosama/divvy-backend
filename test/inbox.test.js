const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Notification = require('../src/modules/notifications/InboxNotification');
const Member = require('../src/modules/groups/GroupMember');
const Bill = require('../src/modules/bills/Bill');
const inbox = require('../src/modules/notifications/inbox');
const user = { _id: '111111111111111111111111', email: 'test@example.com' };
const now = new Date('2026-10-27T09:00:00Z');
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
afterEach(() => mock.restoreAll());
function emptySources() { mock.method(Member, 'find', () => query([])); }
test('event keys deduplicate retries and devices, but isolate accounts, dates, and reinvites', () => {
 const key = inbox.eventId(user._id, 'bill-reminder', '2026-10-27');
 assert.match(key, /^[a-f0-9]{24}$/);
 assert.equal(key, inbox.eventId(user._id, 'bill-reminder', '2026-10-27'));
 assert.notEqual(key, inbox.eventId('222222222222222222222222', 'bill-reminder', '2026-10-27'));
 assert.notEqual(key, inbox.eventId(user._id, 'bill-reminder', '2026-10-28'));
 assert.notEqual(inbox.eventId(user._id, 'invitation', 'id:date1'), inbox.eventId(user._id, 'invitation', 'id:date2'));
});
test('daily reminder upserts never overwrite an existing read state or snapshot', async () => {
 mock.method(Notification, 'updateOne', async (filter, update, options) => {
   assert.equal(filter.userId, user._id); assert.equal(options.upsert, true);
   assert.deepEqual(Object.keys(update), ['$setOnInsert']);
   assert.equal(update.$setOnInsert.readAt, null);
   assert.equal(update.$setOnInsert.body, '1 overdue');
 });
 await inbox.recordBill(user._id, { body: '1 overdue' }, now);
});
test('concurrent duplicate upserts are accepted; database failures are propagated', async () => {
 mock.method(Notification, 'updateOne', async () => { throw Object.assign(new Error(), { code: 11000 }); });
 await inbox.recordBill(user._id, { body: '1 overdue' }, now);
 mock.restoreAll();
 mock.method(Notification, 'updateOne', async () => { throw new Error('offline'); });
 await assert.rejects(inbox.recordBill(user._id, { body: '1 overdue' }, now), /offline/);
});
test('sync uses recipient email, active group membership and pending unexpired invitations', async () => {
 let calls = 0;
 mock.method(Member, 'find', filter => {
   if (filter.userId) { assert.equal(filter.status, 'ACTIVE'); return query([]); }
   assert.equal(filter['invitation.email'], user.email);
   assert.equal(filter['invitation.status'], 'PENDING');
   assert.equal(filter.status, 'INACTIVE');
   assert.deepEqual(filter['invitation.expiresAt'], { $gt: now });
   return query([{ _id: 'member1', groupId: { _id: 'group1' }, invitation: { createdAt: now } },
     { _id: 'member2', groupId: null }, { _id: 'member3', groupId: { deletedAt: now } }]);
 });
 mock.method(Notification, 'updateOne', async (filter, update) => { calls++; assert.equal(update.$setOnInsert.type, 'invitation'); assert.equal(filter.userId, user._id); });
 await inbox.sync(user, now); assert.equal(calls, 1);
});
test('pagination validates structured, zero and oversized pages', async () => {
 for (const page of ['0', '-1', '1.5', '1000001', ['1'], {}]) {
   const res = response(); await inbox.list({ user, query: { page } }, res); assert.equal(res.statusCode, 400);
 }
});
test('list and unread count are strictly scoped to authenticated account', async () => {
 emptySources();
 mock.method(Notification, 'find', filter => { assert.deepEqual(filter, { userId: user._id }); return query([]); });
 mock.method(Notification, 'countDocuments', async filter => { assert.equal(filter.userId, user._id); return filter.readAt === null ? 2 : 3; });
 const res = response(); await inbox.list({ user, query: {} }, res);
 assert.equal(res.body.data.unreadCount, 2); assert.equal(res.body.data.pagination.total, 3);
 const count = response(); await inbox.unread({ user }, count); assert.equal(count.body.data.unreadCount, 2);
});
test('read refuses other-account IDs and updates only unread records', async () => {
 const id = '333333333333333333333333';
 mock.method(Notification, 'exists', async filter => { assert.deepEqual(filter, { _id: id, userId: user._id }); return null; });
 const missing = response(); await inbox.read({ user, params: { id } }, missing); assert.equal(missing.statusCode, 404);
 mock.restoreAll();
 mock.method(Notification, 'exists', async () => true);
 mock.method(Notification, 'updateOne', async filter => { assert.deepEqual(filter, { _id: id, userId: user._id, readAt: null }); });
 const res = response(); await inbox.read({ user, params: { id } }, res); assert.equal(res.body.success, true);
 const bad = response(); await inbox.read({ user, params: { id: 'bad' } }, bad); assert.equal(bad.statusCode, 400);
});
test('mark all read scopes account and leaves later arrivals unread', async () => {
 mock.method(Notification, 'updateMany', async (filter, update) => {
   assert.equal(filter.userId, user._id); assert.equal(filter.readAt, null);
   assert.ok(filter.createdAt.$lte instanceof Date); assert.ok(update.$set.readAt instanceof Date);
 });
 const res = response(); await inbox.readAll({ user }, res); assert.equal(res.body.success, true);
});
test('serialization exposes no owner ID, device token or invitation secret', () => {
 const item = inbox.present({ _id: 'id', type: 'invitation', title: 'title', body: 'body', createdAt: now, readAt: null, userId: user._id, token: 'secret', invitation: { codeHash: 'secret' } });
 assert.deepEqual(Object.keys(item).sort(), ['body','createdAt','id','readAt','title','type']);
});
