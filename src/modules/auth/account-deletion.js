const { createHash, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const User = require('../users/User');
const Group = require('../groups/Group');
const Member = require('../groups/GroupMember');
const Device = require('../notifications/PushDevice');
const Inbox = require('../notifications/InboxNotification');
const { validPassword, accountFilter } = require('./profile.controller');
const fail = (res, status, message) => res.status(status).json({ success: false, message });
async function ownershipPlan(userId) {
  const groups = await Group.find({ ownerId: userId }).setOptions({ withDeleted: true }).sort({ _id: 1 });
  const plan = [];
  for (const group of groups) {
    const members = await Member.find({ groupId: group._id, userId: { $ne: userId }, status: 'ACTIVE' })
      .populate({ path: 'userId', select: 'firstName lastName deletedAt' }).sort({ joinedAt: 1, _id: 1 });
    const next = members.find(member => member.userId && !member.userId.deletedAt);
    plan.push({ id: String(group._id), name: group.name, deleted: !!group.deletedAt,
      action: next ? 'TRANSFER' : 'DELETE',
      successor: next ? { id: String(next.userId._id), firstName: next.userId.firstName, lastName: next.userId.lastName } : null });
  }
  return plan;
}
const planHash = groups => createHash('sha256').update(JSON.stringify(groups)).digest('hex');
async function preview(req, res) {
  try {
    const groups = await ownershipPlan(req.user._id);
    return res.json({ success: true, data: { groups, planHash: planHash(groups) } });
  } catch { return fail(res, 503, 'Could not check your groups. Please try again.'); }
}
async function purgeSoloGroup(groupId, userId) {
  // Hide first; retries can find hidden groups and finish cleanup after a crash.
  let group = await Group.findById(groupId).setOptions({ withDeleted: true });
  if (!group || String(group.ownerId) !== String(userId)) return;
  if (!group.accountDeletion) {
    group = await Group.findOneAndUpdate({ _id: groupId, ownerId: userId, accountDeletion: { $exists: false } }, {
      $set: { deletedAt: new Date(), deletedBy: userId, accountDeletion: {
        purgeAfter: new Date(Date.now() + 90000), originalDeletedAt: group.deletedAt || null,
      } },
    }, { returnDocument: 'after', withDeleted: true });
    if (!group) throw new Error('OWNERSHIP_CHANGED');
  }
  // Allow existing HTTP operations and 60-second worker leases to drain first.
  if (group.accountDeletion.purgeAfter > new Date()) throw new Error('CLEANUP_PENDING');
  const members = await Member.find({ groupId, userId: { $ne: userId }, status: 'ACTIVE' }).populate({ path: 'userId', select: 'deletedAt' });
  if (members.some(member => member.userId && !member.userId.deletedAt)) throw new Error('OWNERSHIP_CHANGED');
  for (const model of [require('../bills/Bill'), require('../expenses/Expense'), require('../settlements/Settlement'), require('../activity/Activity')]) {
    await model.deleteMany({ groupId });
  }
  await Member.deleteMany({ groupId });
  await Group.deleteOne({ _id: groupId, ownerId: userId });
}
async function cleanup(userId) {
  const user = await User.findOne({ _id: userId, deletedAt: { $ne: null }, deletion: { $exists: true } }).select('+deletion');
  if (!user) return;
  await Member.updateMany({ userId, status: 'ACTIVE' }, { $set: { status: 'INACTIVE', role: 'MEMBER', accountDeleted: true } });
  await Device.deleteMany({ userId });
  await Inbox.deleteMany({ userId });
  const plan = await ownershipPlan(userId);
  let pending = false;
  for (const entry of plan) {
    try {
    if (entry.successor) {
      // Promote before changing ownership. Each step is retryable without a transaction.
      const successor = await User.exists({ _id: entry.successor.id, deletedAt: null });
      if (!successor) throw new Error('OWNERSHIP_CHANGED');
      const promoted = await Member.updateOne({ groupId: entry.id, userId: entry.successor.id, status: 'ACTIVE' }, { $set: { role: 'OWNER' } });
      if (promoted.matchedCount !== 1) throw new Error('OWNERSHIP_CHANGED');
      const group = await Group.findById(entry.id).setOptions({ withDeleted: true });
      const result = await Group.findOneAndUpdate({ _id: entry.id, ownerId: userId }, {
        $set: { ownerId: entry.successor.id, ...(group?.accountDeletion ? { deletedAt: group.accountDeletion.originalDeletedAt || null, deletedBy: null } : {}) },
        $unset: { accountDeletion: 1 },
      }, { returnDocument: 'after', withDeleted: true });
      if (!result) throw new Error('OWNERSHIP_CHANGED');
    } else await purgeSoloGroup(entry.id, userId);
    } catch { pending = true; }
  }
  // Keep anonymous references so balances and shared financial history do not change.
  await Member.updateMany({ $or: [{ userId }, { 'invitation.email': user.deletion.email }] }, { $unset: { invitation: 1 } });
  await Device.deleteMany({ userId });
  await Inbox.deleteMany({ userId });
  // Only finish once no late/in-flight group creation still belongs to this account.
  if (pending || user.deletion.finalizeAfter > new Date() || (await ownershipPlan(userId)).length) throw new Error('OWNERSHIP_CHANGED');
  await User.updateOne({ _id: userId, deletedAt: { $ne: null } }, { $unset: { deletion: 1 } });
}
async function remove(req, res) {
  const { password, confirmation, planHash: expectedPlan } = req.body || {};
  if (!validPassword(password) || confirmation !== 'DELETE' || typeof expectedPlan !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlan)) {
    return fail(res, 400, 'Enter your current password and DELETE, and review your group changes.');
  }
  try {
    const user = await User.findOne(accountFilter(req));
    if (!user || !await bcrypt.compare(password, user.password)) return fail(res, 400, 'Your current password is incorrect.');
    const groups = await ownershipPlan(user._id);
    if (planHash(groups) !== expectedPlan) return fail(res, 409, 'Your groups changed. Review the updated deletion details before confirming.');
    // This single write removes login identity and revokes every session before cleanup.
    const deleted = await User.findOneAndUpdate({ ...accountFilter(req), password: user.password }, {
      $set: { firstName: 'Deleted', lastName: 'account', email: `deleted-${user._id}@account.divvy.invalid`,
        password: randomBytes(48).toString('hex'), role: 'USER', avatar: null, deletedAt: new Date(), deletion: { email: user.email, finalizeAfter: new Date(Date.now() + 90000) } },
      $inc: { authVersion: 1 }, $unset: { passwordReset: 1, emailChange: 1 },
    }, { returnDocument: 'after' });
    if (!deleted) return fail(res, 409, 'Your account changed. Sign in again.');
    try { await cleanup(user._id); }
    catch { console.error('Account deletion cleanup pending; the worker will retry.'); }
    return res.json({ success: true, message: 'Your account has been deleted. Any remaining data cleanup will finish automatically.' });
  } catch { return fail(res, 503, 'Could not delete your account. Please try again.'); }
}
async function runOnce() {
  const pending = await User.find({ deletedAt: { $ne: null }, deletion: { $exists: true } }).select('_id').limit(100);
  for (const user of pending) {
    try { await cleanup(user._id); }
    catch { console.error('Account deletion cleanup will retry.'); }
  }
}
function startAccountDeletionWorker() {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await runOnce(); } catch { console.error('Account deletion worker will retry.'); }
    finally { running = false; }
  };
  void tick(); const timer = setInterval(tick, 60000); timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { ownershipPlan, planHash, preview, remove, cleanup, runOnce, startAccountDeletionWorker };
