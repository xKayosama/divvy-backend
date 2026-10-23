const { money } = require('../../utils/money');
const Bill = require('./Bill');
const Group = require('../groups/Group');

// Calculate from the original anchor so Jan 31 -> Feb 28 -> Mar 31.
// All arithmetic is UTC and retains the anchor's time of day.
function occurrenceDate(anchor, recurrence, number) {
  const date = new Date(anchor);
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(number) || number < 0) {
    throw new Error('Invalid recurrence anchor or occurrence number.');
  }
  if (recurrence === 'WEEKLY') {
    date.setUTCDate(date.getUTCDate() + 7 * number);
  } else if (recurrence === 'MONTHLY' || recurrence === 'YEARLY') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (recurrence === 'MONTHLY') date.setUTCMonth(date.getUTCMonth() + number);
    else date.setUTCFullYear(date.getUTCFullYear() + number);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    throw new Error('Unsupported bill recurrence.');
  }
  return date;
}

async function generateRecurringBills({ now = new Date(), maxPerSource = 120, onError = console.error } = {}) {
  const sources = Bill.find({ isRecurring: true, recurrenceSourceId: null }).cursor();
  for await (const candidate of sources) {
    try {
      for (let count = 0; count < maxPerSource; count++) {
        // Refresh to honor edits, disabling, deletion, and another worker's progress.
        const source = await Bill.findById(candidate._id);
        if (!source || !source.isRecurring || source.recurrenceSourceId) break;
        const group = await Group.findById(source.groupId);
        if (!group || group.deletedAt) break;
        money(group.currency).readUnits(source.amount);
        const through = source.generatedThrough || 0;
        // Generate the next bill when the previous occurrence becomes due.
        if (occurrenceDate(source.dueDate, source.recurrence, through) > now) break;
        const number = through + 1;
        const filter = { recurrenceSourceId: source._id, occurrenceNumber: number };
        try {
          await Bill.updateOne(filter, { $setOnInsert: {
            ...filter,
            groupId: source.groupId,
            name: source.name,
            amount: source.amount,
            category: source.category,
            notes: source.notes,
            dueDate: occurrenceDate(source.dueDate, source.recurrence, number),
            isRecurring: false,
            recurrence: null,
            status: 'PENDING',
            paidBy: null
          } }, { upsert: true, runValidators: true });
        } catch (error) {
          // Another server may have inserted this exact occurrence concurrently.
          if (error.code !== 11000 || !await Bill.exists(filter)) throw error;
        }
        // Advance only after the occurrence is safely persisted. Old documents
        // may lack generatedThrough; no backfill is required.
        await Bill.updateOne({
          _id: source._id,
          isRecurring: true,
          ...(through === 0 ? { $or: [{ generatedThrough: 0 }, { generatedThrough: { $exists: false } }] } : { generatedThrough: through })
        }, { $set: { generatedThrough: number } });
      }
    } catch (error) {
      onError(`Recurring bill ${candidate._id}:`, error);
    }
  }
}

async function startRecurringBillWorker({ intervalMs = 60000, onError = console.error } = {}) {
  // Do not start without the unique index, even when autoIndex is disabled.
  await Bill.createIndexes();
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try { await generateRecurringBills({ onError }); }
    catch (error) { onError('Recurring bill worker:', error); }
    finally { running = false; }
  }
  await tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { occurrenceDate, generateRecurringBills, startRecurringBillWorker };
