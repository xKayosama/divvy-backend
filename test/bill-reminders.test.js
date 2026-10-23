const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { dayWindow, effectiveStatus, presentBill, buildBillReminders } = require('../src/modules/bills/bill.reminders');
const Bill = require('../src/modules/bills/Bill');
const Member = require('../src/modules/groups/GroupMember');
const Expense = require('../src/modules/expenses/Expense');
const Settlement = require('../src/modules/settlements/Settlement');
const { getGroupBills, getBillById } = require('../src/modules/bills/bill.controller');
const { getGroupDashboard } = require('../src/modules/dashboard/dashboard.controller');
const now = new Date('2026-10-16T12:00:00Z');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const bill = (id, dueDate, status = 'PENDING', amount = 10) => ({ _id: id, groupId: 'g', name: id, category: 'RENT', dueDate, status, amount });
const records = [
  bill('late', '2026-10-15T23:59:59.999Z'),
  bill('today', '2026-10-16T00:00:00Z'),
  bill('today-end', '2026-10-16T23:59:59.999Z', 'OVERDUE'),
  bill('tomorrow', '2026-10-17T00:00:00Z', 'OVERDUE'),
  bill('day-seven', '2026-10-23T23:59:59.999Z'),
  bill('day-eight', '2026-10-24T00:00:00Z'),
  bill('paid-late', '2026-10-01T00:00:00Z', 'PAID'),
  { ...bill('another-group', '2026-10-01T00:00:00Z'), groupId: 'other' },
];
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
function freeze() { mock.timers.enable({ apis: ['Date'], now }); }
function chain(value) {
  return { populate() { return this; }, sort() { return this; }, skip(n) { this.offset = n; return this; }, limit(n) { return Promise.resolve(value.slice(this.offset || 0, (this.offset || 0) + n)); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
}
function matches(item, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(clause => matches(item, clause));
    if (value && typeof value === 'object') {
      if ('$regex' in value) return new RegExp(value.$regex, value.$options).test(item[key]);
      if ('$ne' in value) return item[key] !== value.$ne;
      return (!('$lt' in value) || new Date(item[key]) < value.$lt) && (!('$gte' in value) || new Date(item[key]) >= value.$gte);
    }
    return item[key] === value;
  });
}

test('UTC calendar boundaries include the full due day and exactly the next seven days', () => {
  const reminders = buildBillReminders(records.filter(item => item.groupId === 'g'), now);
  assert.equal(reminders.timeZone, 'UTC');
  assert.equal(reminders.windowDays, 7);
  assert.equal(reminders.asOf, now.toISOString());
  assert.deepEqual(reminders.overdue.bills.map(b => b._id), ['late']);
  assert.deepEqual(reminders.dueToday.bills.map(b => b._id), ['today', 'today-end']);
  assert.deepEqual(reminders.dueSoon.bills.map(b => b._id), ['tomorrow', 'day-seven']);
  assert.equal(reminders.overdue.amount, 10);
  assert.equal(reminders.dueToday.amount, 20);
  assert.equal(effectiveStatus(records[0], now), 'OVERDUE');
  assert.equal(effectiveStatus(records[2], now), 'PENDING');
  assert.equal(effectiveStatus(records[3], now), 'PENDING');
  assert.equal(effectiveStatus(records[6], now), 'PAID');
});

test('status rolls over at midnight, across leap day and year boundaries', () => {
  for (const [due, before, after] of [
    ['2026-10-16', '2026-10-16T23:59:59.999Z', '2026-10-17T00:00:00Z'],
    ['2028-02-29', '2028-02-29T23:59:59.999Z', '2028-03-01T00:00:00Z'],
    ['2026-12-31', '2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00Z'],
  ]) {
    assert.equal(effectiveStatus(bill('b', due), before), 'PENDING');
    assert.equal(effectiveStatus(bill('b', due), after), 'OVERDUE');
  }
  assert.equal(dayWindow('2026-12-28').end.toISOString(), '2027-01-05T00:00:00.000Z');
});

test('reminder previews cap at five but counts and cents totals include every matching bill', () => {
  const entries = Array.from({ length: 7 }, (_, i) => bill(String(7 - i), '2026-10-15', 'PENDING', 0.1));
  const result = buildBillReminders(entries, now);
  assert.equal(result.overdue.count, 7);
  assert.equal(result.overdue.amount, 0.7);
  assert.deepEqual(result.overdue.bills.map(item => item._id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(result.dueToday, { count: 0, amount: 0, bills: [] });
});

test('presentation handles Mongoose documents without mutating saved status', () => {
  const record = new Bill({ name: 'Rent', amount: 10, dueDate: '2026-10-15', status: 'PENDING' });
  assert.equal(presentBill(record, now).status, 'OVERDUE');
  assert.equal(record.status, 'PENDING');
});

for (const status of ['PENDING', 'OVERDUE', 'PAID']) {
  test(`bill list ${status} filter and pagination use effective status, with search/category/group constraints`, async () => {
    freeze();
    const seen = [];
    mock.method(Bill, 'find', filter => { seen.push(filter); return chain(records.filter(item => matches(item, filter))); });
    mock.method(Bill, 'countDocuments', async filter => { seen.push(filter); return records.filter(item => matches(item, filter)).length; });
    const res = response();
    await getGroupBills({ params: { id: 'g' }, query: { status: status.toLowerCase(), category: 'rent', search: '', page: '1', limit: '2' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen[0], seen[1]);
    const expected = records.filter(item => item.groupId === 'g' && effectiveStatus(item, now) === status);
    assert.equal(res.body.pagination.total, expected.length);
    assert.equal(res.body.pagination.totalPages, Math.ceil(expected.length / 2));
    assert.ok(res.body.data.bills.every(item => item.status === status));
    assert.deepEqual(res.body.data.bills.map(item => item._id), expected.slice(0, 2).map(item => item._id));
  });
}

test('invalid status filters return 400 without database access', async () => {
  mock.method(Bill, 'find', () => assert.fail('must not query'));
  for (const status of ['invalid', ['PAID'], { $ne: 'PAID' }]) {
    const res = response();
    await getGroupBills({ params: { id: 'g' }, query: { status } }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('bill detail returns computed status after checking active membership', async () => {
  freeze();
  mock.method(Bill, 'findById', () => chain(records[0]));
  mock.method(Member, 'findOne', async filter => { assert.equal(filter.groupId, 'g'); assert.equal(filter.status, 'ACTIVE'); return {}; });
  const req = { params: { billId: 'late' }, user: { _id: 'u' } };
  let res = response();
  await getBillById(req, res);
  assert.equal(res.body.data.bill.status, 'OVERDUE');
  assert.equal(records[0].status, 'PENDING');
  mock.method(Member, 'findOne', async () => null);
  res = response(); await getBillById(req, res); assert.equal(res.statusCode, 403);
});

test('dashboard reminders and summaries agree, include today in upcoming and remove paid bills', async () => {
  freeze();
  const fixtures = records.map(record => ({ ...record }));
  mock.method(Member, 'find', () => chain([]));
  mock.method(Expense, 'find', () => chain([]));
  mock.method(Settlement, 'find', async () => []);
  mock.method(Bill, 'find', filter => { assert.deepEqual(filter, { groupId: 'g' }); return chain(fixtures.filter(item => item.groupId === 'g')); });
  const request = { params: { id: 'g' } };
  let res = response(); await getGroupDashboard(request, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.bills.overdue, 1);
  assert.equal(res.body.data.bills.pending, 5);
  assert.equal(res.body.data.bills.paid, 1);
  assert.equal(res.body.data.bills.overdueAmount, res.body.data.billReminders.overdue.amount);
  assert.ok(res.body.data.upcomingBills.some(b => b._id === 'today'));
  assert.ok(res.body.data.upcomingBills.every(b => b.status === 'PENDING'));
  fixtures[0].status = 'PAID';
  res = response(); await getGroupDashboard(request, res);
  assert.equal(res.body.data.billReminders.overdue.count, 0);
  assert.equal(res.body.data.bills.paid, 2);
  assert.equal(res.body.data.bills.overdue, 0);
});

test('paid bills are excluded from every reminder bucket, including generated occurrences', () => {
  const paid = ['2026-10-15', '2026-10-16', '2026-10-20'].map((date, i) => ({ ...bill(String(i), date, 'PAID'), recurrenceSourceId: 'source' }));
  const result = buildBillReminders(paid, now);
  for (const group of ['overdue', 'dueToday', 'dueSoon']) assert.deepEqual(result[group], { count: 0, amount: 0, bills: [] });
});

test('search and category narrow overdue results before paging and counting', async () => {
  freeze();
  const entries = [bill('rent-one', '2026-10-01'), bill('rent-two', '2026-10-02'), { ...bill('water', '2026-10-01'), category: 'WATER' }, bill('rent-future', '2026-10-20')];
  mock.method(Bill, 'find', filter => chain(entries.filter(item => matches(item, filter))));
  mock.method(Bill, 'countDocuments', async filter => entries.filter(item => matches(item, filter)).length);
  const res = response();
  await getGroupBills({ params: { id: 'g' }, query: { search: 'rent-', category: 'rent', status: 'overdue', page: '2', limit: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.bills.map(b => b._id), ['rent-two']);
  assert.equal(res.body.pagination.total, 2);
  assert.equal(res.body.pagination.hasPreviousPage, true);
  assert.equal(res.body.pagination.hasNextPage, false);
});


test('default and explicit upcoming views contain all unpaid statuses before pagination/counting',async()=>{
 freeze();const seen=[];
 mock.method(Bill,'find',filter=>{seen.push(filter);return chain(records.filter(item=>matches(item,filter)));});
 mock.method(Bill,'countDocuments',async filter=>{seen.push(filter);return records.filter(item=>matches(item,filter)).length;});
 for(const view of [undefined,'upcoming']){
  const res=response();await getGroupBills({params:{id:'g'},query:{view,limit:'2'}},res);
  assert.equal(res.statusCode,200);assert.equal(res.body.pagination.total,6);
  assert.ok(res.body.data.bills.every(item=>item.status!=='PAID'));
  assert.equal(res.body.data.bills[0].status,'OVERDUE');assert.equal(res.body.data.bills[1].status,'PENDING');
 }
 assert.deepEqual(seen[0],seen[1]);
});
test('history is paid-only while legacy PAID shortcuts still open history',async()=>{
 freeze();
 mock.method(Bill,'find',filter=>chain(records.filter(item=>matches(item,filter))));
 mock.method(Bill,'countDocuments',async filter=>records.filter(item=>matches(item,filter)).length);
 for(const query of [{view:'history'},{status:'PAID'},{view:'history',category:'rent',search:'paid'}]){
  const res=response();await getGroupBills({params:{id:'g'},query},res);assert.equal(res.statusCode,200);assert.equal(res.body.pagination.total,1);assert.deepEqual(res.body.data.bills.map(item=>item._id),['paid-late']);
 }
});
test('invalid or contradictory views cannot mix paid and unpaid results',async()=>{
 mock.method(Bill,'find',()=>assert.fail('must not query invalid views'));
 for(const query of [{view:'all'},{view:['history','upcoming']},{view:{$ne:'history'}},{view:'upcoming',status:'PAID'},{view:'history',status:'PENDING'},{view:'history',status:'OVERDUE'}]){
  const res=response();await getGroupBills({params:{id:'g'},query},res);assert.equal(res.statusCode,400);
 }
});
