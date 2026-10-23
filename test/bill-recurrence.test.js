const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Bill = require('../src/modules/bills/Bill');
const Group = require('../src/modules/groups/Group');
const { occurrenceDate, generateRecurringBills, startRecurringBillWorker } = require('../src/modules/bills/bill.recurrence');
afterEach(() => mock.restoreAll());

test('UTC recurrence preserves anchor day and time across months, years and weeks', () => {
  assert.equal(occurrenceDate('2025-01-31T12:30:00Z', 'MONTHLY', 1).toISOString(), '2025-02-28T12:30:00.000Z');
  assert.equal(occurrenceDate('2025-01-31T12:30:00Z', 'MONTHLY', 2).toISOString(), '2025-03-31T12:30:00.000Z');
  assert.equal(occurrenceDate('2024-02-29', 'YEARLY', 1).toISOString(), '2025-02-28T00:00:00.000Z');
  assert.equal(occurrenceDate('2024-02-29', 'YEARLY', 4).toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(occurrenceDate('2025-12-29', 'WEEKLY', 1).toISOString(), '2026-01-05T00:00:00.000Z');
  assert.throws(() => occurrenceDate('bad-date', 'WEEKLY', 1));
  assert.throws(() => occurrenceDate('2026-01-01', 'DAILY', 1));
});

function fixture(overrides = {}) {
  const source = { _id: 'source', groupId: 'group', name: 'Internet', amount: 1500, category: 'INTERNET', notes: 'Plan', dueDate: new Date('2026-01-31'), recurrence: 'MONTHLY', isRecurring: true, ...overrides };
  const generated = new Map();
  mock.method(Bill, 'find', filter => {
    assert.deepEqual(filter, { isRecurring: true, recurrenceSourceId: null });
    return { cursor: async function* () { yield source; } };
  });
  mock.method(Bill, 'findById', async () => source);
  mock.method(Group, 'findById', async () => ({ currency: 'PHP' }));
  mock.method(Bill, 'exists', async filter => generated.has(filter.occurrenceNumber));
  mock.method(Bill, 'updateOne', async (filter, update, options) => {
    if (update.$setOnInsert) {
      assert.equal(options.upsert, true); assert.equal(options.runValidators, true);
      if (!generated.has(filter.occurrenceNumber)) generated.set(filter.occurrenceNumber, update.$setOnInsert);
    } else if ((source.generatedThrough || 0) === (filter.generatedThrough || 0)) source.generatedThrough = update.$set.generatedThrough;
  });
  return { source, generated };
}

test('generates next unpaid occurrence at due date and preserves source', async () => {
  const { source, generated } = fixture();
  await generateRecurringBills({ now: new Date('2026-01-30') }); assert.equal(generated.size, 0);
  await generateRecurringBills({ now: new Date('2026-01-31') }); assert.equal(generated.size, 1);
  const bill = generated.get(1);
  assert.equal(bill.dueDate.toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(bill.status, 'PENDING'); assert.equal(bill.paidBy, null);
  assert.equal(bill.isRecurring, false); assert.equal(bill.recurrenceSourceId, 'source');
  assert.equal(bill.groupId, source.groupId); assert.equal(bill.amount, source.amount);
  await generateRecurringBills({ now: new Date('2026-01-31') }); assert.equal(generated.size, 1);
});

test('catches up with a bounded batch and does not recreate deleted occurrences', async () => {
  const { generated } = fixture();
  const now = new Date('2026-04-01');
  await generateRecurringBills({ now, maxPerSource: 2 }); assert.equal(generated.size, 2);
  await generateRecurringBills({ now, maxPerSource: 2 }); assert.equal(generated.size, 3);
  assert.equal(generated.get(3).dueDate.toISOString(), '2026-04-30T00:00:00.000Z');
  generated.delete(2);
  await generateRecurringBills({ now }); assert.equal(generated.size, 2);
});

test('disabled/deleted sources and deleted groups stop generation', async () => {
  const { source, generated } = fixture({ isRecurring: false });
  await generateRecurringBills(); assert.equal(generated.size, 0);
  source.isRecurring = true; mock.method(Group, 'findById', async () => null);
  await generateRecurringBills(); assert.equal(generated.size, 0);
  mock.method(Bill, 'findById', async () => null);
  await generateRecurringBills(); assert.equal(generated.size, 0);
});

test('interrupted progress update resumes without duplicating saved bill', async () => {
  const { source, generated } = fixture();
  let failed = false;
  const original = Bill.updateOne;
  mock.method(Bill, 'updateOne', async (filter, update, options) => {
    if (update.$set && !failed) { failed = true; throw new Error('Interrupted'); }
    return original(filter, update, options);
  });
  const errors = []; const now = new Date('2026-01-31');
  await generateRecurringBills({ now, onError: (...args) => errors.push(args) });
  assert.equal(errors.length, 1); assert.equal(generated.size, 1); assert.equal(source.generatedThrough, undefined);
  await generateRecurringBills({ now }); assert.equal(generated.size, 1); assert.equal(source.generatedThrough, 1);
});

test('concurrent workers use one unique occurrence', async () => {
  const { generated } = fixture();
  await Promise.all([generateRecurringBills({ now: new Date('2026-01-31') }), generateRecurringBills({ now: new Date('2026-01-31') })]);
  assert.equal(generated.size, 1);
  assert.ok(Bill.schema.indexes().some(([keys, options]) => keys.recurrenceSourceId && keys.occurrenceNumber && options.unique && options.partialFilterExpression));
});

test('worker requires indexes and runs immediately on startup', async () => {
  fixture({ isRecurring: false });
  let indexed = false; mock.method(Bill, 'createIndexes', async () => { indexed = true; });
  const stop = await startRecurringBillWorker(); assert.ok(indexed); stop();
  mock.method(Bill, 'createIndexes', async () => { throw new Error('Index unavailable'); });
  await assert.rejects(startRecurringBillWorker(), /Index unavailable/);
});


test('recurring KWD bills retain fils and legacy fractional JPY sources are blocked', async () => {
  const { generated } = fixture({ amount: 0.001 });
  mock.method(Group, 'findById', async () => ({ currency: 'KWD' }));
  await generateRecurringBills({ now: new Date('2026-01-31') });
  assert.equal(generated.get(1).amount, 0.001);
  mock.restoreAll();
  const legacy = fixture({ amount: 1.25 });
  mock.method(Group, 'findById', async () => ({ currency: 'JPY' }));
  const errors = [];
  await generateRecurringBills({ now: new Date('2026-01-31'), onError: (...args) => errors.push(args) });
  assert.equal(legacy.generated.size, 0);
  assert.equal(errors[0][1].code, 'CURRENCY_PRECISION_CONFLICT');
  assert.equal(legacy.source.amount, 1.25);
});

test('soft-deleted groups do not generate recurring bills',async()=>{
 const {generated}=fixture();mock.method(Group,'findById',async()=>({currency:'PHP',deletedAt:new Date()}));
 await generateRecurringBills({now:new Date('2026-10-23')});assert.equal(generated.size,0);
});
