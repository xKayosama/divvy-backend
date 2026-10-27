const { createHash } = require('node:crypto');
const Notification = require('./InboxNotification');
const Member = require('../groups/GroupMember');
const { currentSummary } = require('./bill-notifications');
const eventId = (userId, type, key) => createHash('sha256').update(JSON.stringify([String(userId), type, key])).digest('hex').slice(0, 24);
async function record(userId, type, key, fields, now = new Date()) {
  const _id = eventId(userId, type, key);
  try {
    await Notification.updateOne({ _id, userId }, { $setOnInsert: { userId, type, ...fields, createdAt: now, readAt: null } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
}
async function recordBill(userId, summary, now = new Date()) {
  if (!summary) return;
  await record(userId, 'bill-reminder', now.toISOString().slice(0, 10), {
    title: 'Bill reminders', body: summary.body,
    ...(summary.groupId ? { groupId: summary.groupId } : {}),
    ...(summary.billId ? { billId: summary.billId } : {}),
  }, now);
}
// Discover current reminders independently of push opt-in. No historical backfill.
async function sync(user, now = new Date()) {
  await recordBill(user._id, await currentSummary(user._id, now), now);
  const invitations = await Member.find({ 'invitation.email': user.email, 'invitation.status': 'PENDING',
    'invitation.expiresAt': { $gt: now }, status: 'INACTIVE' }).select('+invitation')
    .populate({ path: 'groupId', select: '_id deletedAt', match: { deletedAt: null } });
  for (const member of invitations) {
    if (!member.groupId || member.groupId.deletedAt) continue;
    await record(user._id, 'invitation', `${member._id}:${member.invitation.createdAt.toISOString()}`, {
      title: 'Group invitation', body: 'You have an invitation to join a group. Open invitations to review it.',
    }, member.invitation.createdAt);
  }
}
const present = item => ({ id: String(item._id), type: item.type, title: item.title, body: item.body,
  createdAt: item.createdAt, readAt: item.readAt, ...(item.groupId ? { groupId: String(item.groupId) } : {}),
  ...(item.billId ? { billId: String(item.billId) } : {}) });
const fail = (res, status, message) => res.status(status).json({ success: false, message });
async function list(req, res) {
  const raw = req.query.page ?? '1';
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || Number(raw) > 1000000) return fail(res, 400, 'Invalid page.');
  try {
    await sync(req.user);
    const page = Number(raw), limit = 20, filter = { userId: req.user._id };
    const [items, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments(filter), Notification.countDocuments({ ...filter, readAt: null }),
    ]);
    return res.json({ success: true, data: { notifications: items.map(present), unreadCount,
      pagination: { page, total, totalPages: Math.ceil(total / limit) } } });
  } catch { return fail(res, 503, 'Could not load notifications. Please try again.'); }
}
async function unread(req, res) {
  try {
    await sync(req.user);
    return res.json({ success: true, data: { unreadCount: await Notification.countDocuments({ userId: req.user._id, readAt: null }) } });
  } catch { return fail(res, 503, 'Could not check notifications.'); }
}
async function read(req, res) {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id || '')) return fail(res, 400, 'Invalid notification.');
  try {
    const filter = { _id: req.params.id, userId: req.user._id };
    if (!await Notification.exists(filter)) return fail(res, 404, 'Notification not found.');
    await Notification.updateOne({ ...filter, readAt: null }, { $set: { readAt: new Date() } });
    return res.json({ success: true });
  } catch { return fail(res, 503, 'Could not mark notification as read.'); }
}
async function readAll(req, res) {
  try {
    await Notification.updateMany({ userId: req.user._id, readAt: null, createdAt: { $lte: new Date() } }, { $set: { readAt: new Date() } });
    return res.json({ success: true });
  } catch { return fail(res, 503, 'Could not mark notifications as read.'); }
}
module.exports = { eventId, record, recordBill, sync, present, list, unread, read, readAll };
