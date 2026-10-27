const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Inbox = require('../src/modules/notifications/InboxNotification');
beforeEach(() => mock.method(Inbox, 'updateOne', async () => ({})));
const Device = require('../src/modules/notifications/PushDevice');
const User = require('../src/modules/users/User');
const Revoked = require('../src/modules/auth/RevokedToken');
const Member = require('../src/modules/groups/GroupMember');
const Bill = require('../src/modules/bills/Bill');
const transport = require('../src/modules/notifications/push.transport');
const worker = require('../src/modules/notifications/bill-notifications');
const routes = require('../src/modules/notifications/notification.routes');
const originalTransport = { ...transport };
const now = new Date('2026-10-27T01:00:00Z');
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const device = () => ({ _id: 'd1', token: 'ExpoPushToken[abcdefghijklmnop]', userId: 'u1', timeZone: 'Asia/Manila', enabled: true, authTokenHash: 'hash', authVersion: 0, authExpiresAt: new Date('2026-11-01'), generation: 'g1', attempts: 0 });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const route = (path, method='post') => routes.stack.find(layer => layer.route?.path===path && layer.route.methods[method]).route.stack.at(-1).handle;
function setup() {
 mock.method(User, 'findById', () => query({ authVersion: 0 }));
 mock.method(Revoked, 'exists', async () => false);
 mock.method(Member, 'find', () => query([{ groupId: { _id: 'g1' } }]));
 mock.method(Bill, 'find', () => query([{ _id: 'b1', groupId: 'g1', status: 'PENDING', dueDate: '2026-10-27T00:00:00Z' }]));
 mock.method(Device, 'updateOne', async () => ({ matchedCount: 1 }));
 mock.method(transport, 'send', async () => ({ status: 'ok', id: 'ticket-1' }));
}
afterEach(() => { mock.restoreAll(); Object.assign(transport, originalTransport); });

test('device-local 9AM scheduling handles timezone date boundaries and DST', () => {
 assert.deepEqual(worker.localClock('Asia/Manila', now), { day: '2026-10-27', hour: 9 });
 assert.deepEqual(worker.localClock('America/Los_Angeles', now), { day: '2026-10-26', hour: 18 });
 assert.equal(worker.localClock('America/New_York', new Date('2026-11-01T14:00:00Z')).hour, 9);
});

test('digest includes unpaid overdue/today/tomorrow with UTC boundaries and excludes paid/later bills', () => {
 const bills = [
  { _id: 'old', groupId: 'g1', status: 'OVERDUE', dueDate: '2026-10-20' },
  { _id: 'today', groupId: 'g1', status: 'PENDING', dueDate: '2026-10-27' },
  { _id: 'tomorrow', groupId: 'g1', status: 'PENDING', dueDate: '2026-10-28T23:59:59Z' },
  { _id: 'later', groupId: 'g1', status: 'PENDING', dueDate: '2026-10-29' },
  { _id: 'paid', groupId: 'g1', status: 'PAID', dueDate: '2026-10-20' },
 ];
 assert.deepEqual(worker.summarize(bills, now), { body: '1 overdue · 1 due today · 1 due tomorrow', groupId: 'g1' });
 assert.deepEqual(worker.summarize([bills[1]], now), { body: '1 due today', groupId: 'g1', billId: 'today' });
 assert.equal(worker.summarize([bills[3], bills[4]], now), null);
 assert.equal(worker.summarize([bills[0], { ...bills[1], groupId: 'g2' }], now).groupId, undefined);
});

test('summary queries only active memberships and excludes deleted/missing groups', async () => {
 setup(); mock.method(Member, 'find', filter => { assert.deepEqual(filter, { userId: 'u1', status: 'ACTIVE' }); return query([{ groupId: null }, { groupId: { _id: 'deleted', deletedAt: now } }, { groupId: { _id: 'g1' } }]); });
 mock.method(Bill, 'find', filter => { assert.deepEqual(filter.groupId, { $in: ['g1'] }); assert.deepEqual(filter.status, { $ne: 'PAID' }); return query([]); });
 assert.equal(await worker.currentSummary('u1', now), null);
});

test('worker sends a generic digest and records the ticket for later receipts', async () => {
 setup(); const value=device(); await worker.processDevice(value, now);
 const message=transport.send.mock.calls[0].arguments[0];
 assert.equal(message.to, value.token); assert.equal(message.channelId, 'bill-reminders'); assert.equal(message.ttl, 3600);
 assert.deepEqual(message.data, { type: 'bill-reminder', userId: 'u1', groupId: 'g1', billId: 'b1' });
 assert.equal(message.body, '1 due today');
 const final=Device.updateOne.mock.calls.at(-1).arguments[1].$set;
 assert.equal(final.state, 'ACCEPTED'); assert.equal(final.ticketId, 'ticket-1'); assert.equal(final.receiptAt-now, 15*60000);
});

test('before 9AM, same-day accepted/delivered attempts and retry backoff do not resend', async () => {
 setup();
 for(const value of [{...device(),day:'2026-10-27',state:'DELIVERED'}, {...device(),day:'2026-10-27',state:'PENDING',nextAttemptAt:new Date(now.getTime()+60000)}, {...device(),timeZone:'UTC'}]) await worker.processDevice(value,now);
 assert.equal(transport.send.mock.callCount(),0);
});

test('revoked, expired and password-reset sessions cannot receive bill notifications', async () => {
 setup(); mock.method(Revoked,'exists',async()=>true);await worker.processDevice(device(),now);
 assert.equal(transport.send.mock.callCount(),0);assert.equal(Device.updateOne.mock.calls.at(-1).arguments[1].$set.enabled,false);
 mock.method(Revoked,'exists',async()=>false);mock.method(User,'findById',()=>query({authVersion:1}));await worker.processDevice(device(),now);
 assert.equal(transport.send.mock.callCount(),0);
 await worker.processDevice({...device(),authExpiresAt:new Date('2026-10-01')},now);assert.equal(transport.send.mock.callCount(),0);
});

test('receipt success completes delivery; DeviceNotRegistered disables a stale device', async () => {
 setup();mock.method(transport,'receipt',async()=>({status:'ok'}));
 const value={...device(),state:'ACCEPTED',ticketId:'ticket-1',receiptAt:new Date(now-1),day:'2026-10-27'};
 await worker.processDevice(value,now);assert.equal(Device.updateOne.mock.calls.at(-1).arguments[1].$set.state,'DELIVERED');
 mock.method(transport,'receipt',async()=>({status:'error',details:{error:'DeviceNotRegistered'}}));
 await worker.processDevice(value,now);assert.equal(Device.updateOne.mock.calls.at(-1).arguments[1].$set.enabled,false);assert.equal(transport.send.mock.callCount(),0);
});

test('receipt transport failure does not resend a known accepted push', async () => {
 setup();mock.method(transport,'receipt',async()=>{throw Error('network');});
 await worker.processDevice({...device(),state:'ACCEPTED',ticketId:'ticket-1',receiptAt:new Date(now-1)},now);
 assert.equal(transport.send.mock.callCount(),0);
 assert.equal(Device.updateOne.mock.calls.at(-1).arguments[1].$set.lastError,'PUSH_SERVICE_UNAVAILABLE');
});

test('transient sends back off with a bounded retry count; credential errors are terminal', async () => {
 setup();mock.method(transport,'send',async()=>({status:'error',details:{error:'MessageRateExceeded'}}));
 await worker.processDevice(device(),now);let fields=Device.updateOne.mock.calls.at(-1).arguments[1].$set;assert.equal(fields.state,'PENDING');assert.ok(fields.nextAttemptAt>now);
 await worker.processDevice({...device(),day:'2026-10-27',attempts:4,state:'PENDING'},now);fields=Device.updateOne.mock.calls.at(-1).arguments[1].$set;assert.equal(fields.state,'FAILED');
 mock.method(transport,'send',async()=>({status:'error',details:{error:'InvalidCredentials'}}));await worker.processDevice(device(),now);assert.equal(Device.updateOne.mock.calls.at(-1).arguments[1].$set.state,'FAILED');
});

test('lost device claim and resolved bills prevent delivery', async () => {
 setup();mock.method(Device,'updateOne',async()=>({matchedCount:0}));await worker.processDevice(device(),now);assert.equal(transport.send.mock.callCount(),0);
 mock.method(Bill,'find',()=>query([]));await worker.processDevice(device(),now);assert.equal(transport.send.mock.callCount(),0);
});

test('device schema hides push/auth tokens and indexes registration uniqueness', () => {
 assert.equal(Device.schema.path('token').options.select,false);assert.equal(Device.schema.path('authTokenHash').options.select,false);
 assert.ok(Device.schema.indexes().some(([keys,options])=>keys.token&&options.unique));
});

test('registration validates token/timezone before storage and exposes no secrets', async () => {
 const handler=route('/devices');
 for(const body of [{}, {token:'bad',timeZone:'UTC'}, {token:device().token,timeZone:'bad/zone'}]){const res=response();await handler({body},res);assert.equal(res.statusCode,400);}
 mock.method(Device,'init',async()=>{});mock.method(Device,'findOne',()=>query(null));mock.method(Device,'findOneAndUpdate',async(filter,update)=>{
  assert.equal(filter.token,device().token);assert.equal(update.$set.userId,'u1');assert.equal(update.$set.authTokenHash,'hash');assert.equal(update.$set.day,'');return {...device(),...update.$set};
 });
 const res=response();await handler({body:{token:device().token,timeZone:'Asia/Manila'},user:{_id:'u1',authVersion:0},auth:{tokenHash:'hash',expiresAt:device().authExpiresAt}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.data.device.enabled,true);assert.equal(res.body.data.device.token,undefined);
});

test('status, disabling and tests are scoped to the authenticated user', async () => {
 mock.method(Device,'findOne',filter=>{assert.equal(filter.userId,'u1');return query(null);});mock.method(Device,'updateOne',async filter=>{assert.equal(filter.userId,'u1');return {};});
 const request={body:{token:device().token},user:{_id:'u1'}};
 let res=response();await route('/status')(request,res);assert.equal(res.body.data.device.enabled,false);
 res=response();await route('/devices','delete')(request,res);assert.equal(res.body.success,true);
 res=response();await route('/test')(request,res);assert.equal(res.statusCode,404);
 assert.equal(routes.stack[0].handle,require('../src/modules/auth/auth.middleware').protect);
});

test('push transport uses Expo HTTPS with timeouts and never accepts malformed tickets', async () => {
 const original=global.fetch;
 try {
  global.fetch=async(url,options)=>{assert.equal(url,'https://exp.host/--/api/v2/push/send');assert.ok(options.signal);return {ok:true,json:async()=>({data:{status:'ok',id:'ticket'}})};};
  assert.equal((await transport.send({to:device().token})).id,'ticket');
  global.fetch=async()=>({ok:true,json:async()=>({data:{}})});await assert.rejects(transport.send({}));
 }finally{global.fetch=original;}
});

test('two workers racing the same device obtain only one active lease and send once', async () => {
 setup(); const value={...device(),leaseUntil:new Date(0),nextCheckAt:new Date(0)};
 mock.method(Device,'find',()=>query([structuredClone(value)]));
 mock.method(Device,'findOneAndUpdate',(filter,update)=>{
  if(value.leaseUntil>filter.leaseUntil.$lte)return query(null);
  Object.assign(value,update.$set);return query(structuredClone(value));
 });
 mock.method(Device,'updateOne',async(filter,update)=>{assert.equal(filter.generation,'g1');Object.assign(value,update.$set);return {matchedCount:1};});
 // Keep the synthetic calendar instant ahead of wall clock, for deterministic lease comparisons.
 const future=new Date('2030-01-01T01:00:00Z');value.authExpiresAt=new Date('2031-01-01');
 mock.method(Bill,'find',()=>query([{_id:'b1',groupId:'g1',status:'PENDING',dueDate:'2030-01-01'}]));
 await Promise.all([worker.runOnce(future),worker.runOnce(future)]);
 assert.equal(transport.send.mock.callCount(),1);
});

test('switching device ownership clears the previous account delivery state', async () => {
 mock.method(Device,'init',async()=>{});
 mock.method(Device,'findOne',()=>query({...device(),userId:'old-user',day:'2026-10-27',state:'ACCEPTED',ticketId:'old-ticket'}));
 mock.method(Device,'findOneAndUpdate',async(_filter,update)=>{
  assert.equal(update.$set.day,'');assert.equal(update.$set.ticketId,null);assert.equal(update.$set.attempts,0);assert.notEqual(update.$set.generation,'g1');
  return {...device(),...update.$set};
 });
 const res=response();await route('/devices')({body:{token:device().token,timeZone:'UTC'},user:{_id:'u1'},auth:{tokenHash:'new-hash',expiresAt:device().authExpiresAt}},res);
 assert.equal(res.statusCode,200);
});
