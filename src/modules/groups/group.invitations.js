const { randomBytes, createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Member = require('./GroupMember');
const Group = require('./Group');
const User = require('../users/User');
const hashCode = code => createHash('sha256').update(code).digest('hex');
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const owner = req => req.membership?.role === 'OWNER' && String(req.group.ownerId) === String(req.user._id);
const unavailable = res => fail(res, 404, 'Invitation not found for this account. Sign in with the invited email.');
function present(member, group) {
  const invite = member.invitation;
  return {
    id: String(member._id), email: invite.email,
    status: invite.status === 'PENDING' && invite.expiresAt <= new Date() ? 'EXPIRED' : invite.status,
    createdAt: invite.createdAt, expiresAt: invite.expiresAt,
    group: { id: String(group._id), name: group.name, currency: group.currency, icon: group.icon || 'people' }
  };
}
async function create(req, res) {
  if (!owner(req)) return fail(res, 403, 'Only the group owner can invite members.');
  const raw = req.body?.email;
  if (typeof raw !== 'string' || raw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())) return fail(res, 400, 'Enter a valid email address.');
  const email = raw.trim().toLowerCase();
  if (email === req.user.email) return fail(res, 400, 'You are already the group owner.');
  try {
    // Fail closed until uniqueness indexes are ready; no transaction/replica set required.
    await Member.init();
    const user = await User.findOne({ email });
    const existing = await Member.findOne({ groupId: req.group._id,
      $or: [{ 'invitation.email': email }, ...(user ? [{ userId: user._id }] : [])]
    }).select('+invitation');
    if (existing?.status === 'ACTIVE') return fail(res, 409, 'This person is already a member.');
    if (existing?.invitation?.status === 'PENDING' && existing.invitation.expiresAt > new Date()) return fail(res, 409, 'An invitation is already pending. Revoke it before creating another.');
    const code = randomBytes(16).toString('hex');
    const now = new Date();
    const invitation = { email, codeHash: hashCode(code), status: 'PENDING', invitedBy: req.user._id,
      createdAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000) };
    let member;
    if (existing) {
      member = await Member.findOneAndUpdate({ _id: existing._id, status: 'INACTIVE',
        'invitation.codeHash': existing.invitation?.codeHash || { $exists: false }
      }, { $set: { invitation, role: 'MEMBER' } }, { returnDocument: 'after', runValidators: true }).select('+invitation');
      if (!member) return fail(res, 409, 'Membership changed. Refresh and try again.');
    } else {
      member = await Member.create({ groupId: req.group._id, userId: user?._id, role: 'MEMBER', status: 'INACTIVE', invitation });
    }
    return res.status(201).json({ success: true, message: 'Invitation created. Share the code with the recipient.', data: { invitation: present(member, req.group), code } });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'An invitation already exists. Refresh and try again.');
    return fail(res, 503, 'Could not create the invitation. Please try again.');
  }
}
async function outgoing(req, res) {
  if (!owner(req)) return fail(res, 403, 'Only the group owner can manage invitations.');
  try {
    const records = await Member.find({ groupId: req.group._id, invitation: { $exists: true } })
      .select('+invitation').sort({ 'invitation.createdAt': -1, _id: -1 }).limit(100);
    return res.json({ success: true, data: { invitations: records.map(record => present(record, req.group)) } });
  } catch { return fail(res, 503, 'Could not load invitations.'); }
}
async function incoming(req, res) {
  try {
    const records = await Member.find({ 'invitation.email': req.user.email, 'invitation.status': 'PENDING',
      'invitation.expiresAt': { $gt: new Date() }, status: 'INACTIVE' })
      .select('+invitation').populate({ path: 'groupId', select: 'name currency icon deletedAt', match: { deletedAt: null } })
      .sort({ 'invitation.createdAt': -1, _id: -1 }).limit(100);
    return res.json({ success: true, data: { invitations: records.filter(record => record.groupId && !record.groupId.deletedAt).map(record => present(record, record.groupId)) } });
  } catch { return fail(res, 503, 'Could not load invitations.'); }
}
async function loadRecipient(req, res, filter) {
  const member = await Member.findOne({ ...filter, 'invitation.email': req.user.email }).select('+invitation');
  if (!member) { unavailable(res); return null; }
  const group = await Group.findById(member.groupId);
  if (!group || group.deletedAt) { unavailable(res); return null; }
  if (member.invitation.status !== 'PENDING' || member.status !== 'INACTIVE') {
    fail(res, 409, 'This invitation has already been answered or revoked. Refresh your invitations.'); return null;
  }
  if (member.invitation.expiresAt <= new Date()) { fail(res, 410, 'This invitation expired. Ask the owner for a new one.'); return null; }
  return { member, group };
}
async function lookup(req, res) {
  const code = req.body?.code;
  if (typeof code !== 'string' || !/^[a-f0-9]{32}$/i.test(code.trim())) return fail(res, 400, 'Enter a valid 32-character invitation code.');
  try {
    const record = await loadRecipient(req, res, { 'invitation.codeHash': hashCode(code.trim().toLowerCase()) });
    if (record) return res.json({ success: true, data: { invitation: present(record.member, record.group) } });
  } catch { return fail(res, 503, 'Could not check the invitation.'); }
}
async function respond(req, res, accept) {
  if (!mongoose.isValidObjectId(req.params.invitationId)) return unavailable(res);
  try {
    const record = await loadRecipient(req, res, { _id: req.params.invitationId });
    if (!record) return;
    const { member, group } = record;
    if (accept && (typeof req.body?.code !== 'string' ||
        !/^[a-f0-9]{32}$/i.test(req.body.code.trim()) || hashCode(req.body.code.trim().toLowerCase()) !== member.invitation.codeHash)) {
      return fail(res, 400, 'Enter the invitation code shared by the owner before accepting.');
    }
    // Compare the generation hash as well as state so an old screen cannot answer a replacement invite.
    if (req.body?.createdAt !== member.invitation.createdAt.toISOString()) return fail(res, 409, 'The invitation changed. Refresh before responding.');
    const updated = await Member.findOneAndUpdate({ _id: member._id, status: 'INACTIVE',
      'invitation.email': req.user.email, 'invitation.status': 'PENDING',
      'invitation.codeHash': member.invitation.codeHash, 'invitation.expiresAt': { $gt: new Date() }
    }, { $set: { 'invitation.status': accept ? 'ACCEPTED' : 'DECLINED',
      ...(accept ? { status: 'ACTIVE', userId: req.user._id, role: 'MEMBER', joinedAt: new Date() } : {})
    } }, { returnDocument: 'after', runValidators: true }).select('+invitation');
    if (!updated) return fail(res, 409, 'The invitation changed. Refresh and try again.');
    return res.json({ success: true, message: accept ? 'You joined the group.' : 'Invitation declined.', data: { invitation: present(updated, group) } });
  } catch { return fail(res, 503, 'Could not respond to the invitation. Refresh and try again.'); }
}
async function revoke(req, res) {
  if (!owner(req)) return fail(res, 403, 'Only the group owner can revoke invitations.');
  if (!mongoose.isValidObjectId(req.params.invitationId)) return unavailable(res);
  if (typeof req.body?.createdAt !== 'string' || !Number.isFinite(Date.parse(req.body.createdAt))) return fail(res, 400, 'Refresh the invitation before revoking it.');
  try {
    const result = await Member.findOneAndUpdate({ _id: req.params.invitationId, groupId: req.group._id,
      status: 'INACTIVE', 'invitation.status': 'PENDING', 'invitation.createdAt': req.body?.createdAt
    }, { $set: { 'invitation.status': 'REVOKED' } }, { returnDocument: 'after' }).select('+invitation');
    if (!result) return fail(res, 409, 'The invitation changed. Refresh and try again.');
    return res.json({ success: true, message: 'Invitation revoked.' });
  } catch { return fail(res, 503, 'Could not revoke the invitation.'); }
}
module.exports = { create, incoming, outgoing, lookup, accept: (req, res) => respond(req, res, true), decline: (req, res) => respond(req, res, false), revoke };
