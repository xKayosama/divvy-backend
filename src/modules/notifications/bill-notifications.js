const Device = require('./PushDevice');
const transport = require('./push.transport');
const User = require('../users/User');
const Revoked = require('../auth/RevokedToken');
const Member = require('../groups/GroupMember');
const Bill = require('../bills/Bill');
const { dayWindow } = require('../bills/bill.reminders');
const RETRYABLE = new Set(['MessageRateExceeded', 'PUSH_SERVICE_UNAVAILABLE']);
const knownErrors = new Set(['DeviceNotRegistered', 'InvalidCredentials', 'MismatchSenderId', 'MessageTooBig', 'MessageRateExceeded', 'PUSH_SERVICE_UNAVAILABLE', 'RECEIPT_UNAVAILABLE']);
const safeError = code => knownErrors.has(code) ? code : 'PUSH_SERVICE_UNAVAILABLE';
function localClock(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return { day: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}
function summarize(bills, now) {
  const { today, tomorrow } = dayWindow(now);
  const end = new Date(tomorrow.getTime() + 86400000);
  const eligible = bills.filter(bill => bill.status !== 'PAID' && new Date(bill.dueDate) < end);
  const counts = { overdue: 0, today: 0, tomorrow: 0 };
  for (const bill of eligible) {
    const due = new Date(bill.dueDate);
    counts[due < today ? 'overdue' : due < tomorrow ? 'today' : 'tomorrow']++;
  }
  if (!eligible.length) return null;
  const groups = [...new Set(eligible.map(bill => String(bill.groupId)))];
  return { body: [counts.overdue && `${counts.overdue} overdue`, counts.today && `${counts.today} due today`, counts.tomorrow && `${counts.tomorrow} due tomorrow`].filter(Boolean).join(' · '),
    ...(groups.length === 1 ? { groupId: groups[0] } : {}), ...(eligible.length === 1 ? { billId: String(eligible[0]._id) } : {}) };
}
async function currentSummary(userId, now) {
  const members = await Member.find({ userId, status: 'ACTIVE' }).populate({ path: 'groupId', select: '_id deletedAt', match: { deletedAt: null } });
  const ids = members.filter(member => member.groupId && !member.groupId.deletedAt).map(member => member.groupId._id);
  if (!ids.length) return null;
  const end = new Date(dayWindow(now).tomorrow.getTime() + 86400000);
  const bills = await Bill.find({ groupId: { $in: ids }, status: { $ne: 'PAID' }, dueDate: { $lt: end } }).select('_id groupId status dueDate');
  return summarize(bills, now);
}
async function validSession(device, now) {
  if (device.authExpiresAt <= now) return false;
  const user = await User.findById(device.userId).select('authVersion');
  return !!user && (user.authVersion || 0) === device.authVersion && !await Revoked.exists({ tokenHash: device.authTokenHash });
}
async function save(device, fields) {
  return Device.updateOne({ _id: device._id, generation: device.generation, enabled: true }, { $set: { leaseUntil: new Date(0), ...fields } });
}
async function failure(device, code, now) {
  code = safeError(code);
  const retry = RETRYABLE.has(code) && device.attempts < 5;
  await save(device, { lastError: code, state: retry ? 'PENDING' : 'FAILED',
    ...(code === 'DeviceNotRegistered' ? { enabled: false } : {}), ticketId: null,
    nextAttemptAt: new Date(now.getTime() + Math.min(3600000, 60000 * 2 ** device.attempts)) });
}
async function processDevice(device, now = new Date()) {
  try {
    if (!await validSession(device, now)) { await save(device, { enabled: false, lastError: 'SESSION_EXPIRED' }); return; }
    if (device.ticketId && device.state === 'ACCEPTED') {
      if (device.receiptAt > now) { await save(device, {}); return; }
      const receipt = await transport.receipt(device.ticketId);
      if (!receipt) {
        if (now - device.receiptAt > 24 * 3600000) await save(device, { state: 'FAILED', lastError: 'RECEIPT_UNAVAILABLE', ticketId: null });
        else await save(device, {});
        return;
      }
      if (receipt.status === 'error') { await failure(device, receipt.details?.error, now); return; }
      await save(device, { state: 'DELIVERED', ticketId: null, lastError: '' }); return;
    }
    const clock = localClock(device.timeZone, now);
    if (clock.hour < 9 || (device.day === clock.day && device.state !== 'PENDING') ||
        (device.day === clock.day && device.nextAttemptAt > now)) { await save(device, {}); return; }
    // Recompute on every attempt so paid/deleted bills and removed members are excluded.
    const summary = await currentSummary(device.userId, now);
    if (!summary) { await save(device, device.state === 'PENDING' ? { state: 'SKIPPED' } : {}); return; }
    // Inbox failures must not block push delivery. Deterministic IDs deduplicate devices/retries.
    try { await require('./inbox').recordBill(device.userId, summary, now); }
    catch { console.error('Could not save bill reminder to notification inbox.'); }
    const attempts = device.day === clock.day ? device.attempts + 1 : 1;
    const claim = await Device.updateOne({ _id: device._id, generation: device.generation, enabled: true },
      { $set: { day: clock.day, state: 'PENDING', attempts } });
    if (claim.matchedCount !== 1) return;
    device.day = clock.day; device.attempts = attempts;
    const ticket = await transport.send({ to: device.token, title: 'Divvy bill reminders', body: summary.body,
      sound: 'default', channelId: 'bill-reminders', ttl: 3600,
      data: { type: 'bill-reminder', userId: String(device.userId), ...(summary.groupId ? { groupId: summary.groupId } : {}), ...(summary.billId ? { billId: summary.billId } : {}) } });
    if (ticket.status === 'error') { await failure(device, ticket.details?.error, now); return; }
    if (!ticket.id) throw new Error('PUSH_SERVICE_UNAVAILABLE');
    await save(device, { state: 'ACCEPTED', ticketId: ticket.id, receiptAt: new Date(now.getTime() + 15 * 60000), lastError: '' });
  } catch {
    // Do not resend a known accepted ticket when receipt polling fails.
    if (device.ticketId && device.state === 'ACCEPTED') await save(device, { lastError: 'PUSH_SERVICE_UNAVAILABLE' });
    else await failure(device, 'PUSH_SERVICE_UNAVAILABLE', now);
  }
}
async function runOnce(now = new Date()) {
  const devices = await Device.find({ enabled: true, nextCheckAt: { $lte: now }, authExpiresAt: { $gt: now } })
    .select('+token +authTokenHash').sort({ nextCheckAt: 1 }).limit(100);
  for (const candidate of devices) {
    const checkTime = new Date(Math.max(now.getTime(), Date.now()));
    const device = await Device.findOneAndUpdate({ _id: candidate._id, generation: candidate.generation, enabled: true, leaseUntil: { $lte: checkTime } },
      { $set: { leaseUntil: new Date(checkTime.getTime() + 60000), nextCheckAt: new Date(checkTime.getTime() + 60000) } }, { returnDocument: 'after' }).select('+token +authTokenHash');
    if (device) await processDevice(device, checkTime);
  }
}
function startBillNotificationsWorker() {
  if (process.env.BILL_NOTIFICATIONS_ENABLED !== 'true') return () => {};
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await runOnce(); } catch { console.error('Bill notification worker failed; retrying next minute.'); }
    finally { running = false; }
  };
  void tick(); const timer = setInterval(tick, 60000); timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { localClock, summarize, currentSummary, validSession, processDevice, runOnce, startBillNotificationsWorker, safeError };
