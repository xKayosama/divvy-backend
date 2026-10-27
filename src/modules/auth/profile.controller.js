const bcrypt = require('bcryptjs');
const { randomInt, createHmac, timingSafeEqual } = require('node:crypto');
const User = require('../users/User');
const emailDelivery = require('./password-reset.email');
const { generateToken } = require('./jwt');
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const present = user => ({ id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role });
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
const validPassword = password => typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 72;
const codeHash = (id, email, code) => createHmac('sha256', process.env.JWT_SECRET).update(`email-change:${id}:${email}:${code}`).digest('hex');
const accountFilter = req => ({ _id: req.user._id, deletedAt: null, authVersion: req.user.authVersion || { $in: [0, null] } });
async function updateProfile(req, res) {
  const { firstName, lastName } = req.body || {};
  if (Object.keys(req.body || {}).some(key => !['firstName', 'lastName'].includes(key)) ||
      ![firstName, lastName].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100)) {
    return fail(res, 400, 'Enter first and last names of 1–100 characters. Email changes require verification.');
  }
  try {
    const user = await User.findOneAndUpdate(accountFilter(req), { $set: { firstName: firstName.trim(), lastName: lastName.trim() } }, { returnDocument: 'after', runValidators: true });
    if (!user) return fail(res, 409, 'Your account changed. Sign in again.');
    return res.json({ success: true, data: { user: present(user) } });
  } catch { return fail(res, 503, 'Could not update your profile. Please try again.'); }
}
async function requestEmailChange(req, res) {
  const { email: raw, password } = req.body || {};
  if (!validEmail(raw) || !validPassword(password)) return fail(res, 400, 'Enter a valid new email and your current password.');
  const email = raw.trim().toLowerCase();
  if (email === req.user.email) return fail(res, 400, 'Enter a different email address.');
  try {
    const user = await User.findOne(accountFilter(req));
    if (!user || !await bcrypt.compare(password, user.password)) return fail(res, 400, 'Your current password is incorrect.');
    if (await User.exists({ email })) return fail(res, 409, 'This email is unavailable.');
    if (!emailDelivery.isConfigured()) return fail(res, 503, 'Email verification is temporarily unavailable.');
    const now = new Date(), code = String(randomInt(0, 100000000)).padStart(8, '0');
    const hash = codeHash(user._id, email, code);
    const issued = await User.findOneAndUpdate({ ...accountFilter(req), password: user.password,
      $or: [{ 'emailChange.requestedAt': { $exists: false } }, { 'emailChange.requestedAt': { $lte: new Date(now.getTime() - 60000) } }],
    }, { $set: { emailChange: { email, codeHash: hash, authVersion: user.authVersion || 0, requestedAt: now, expiresAt: new Date(now.getTime() + 15 * 60000), attempts: 0 } } });
    if (!issued) return fail(res, 429, 'Wait 60 seconds before requesting another email code.');
    try { await emailDelivery.sendEmailChangeCode(email, code); }
    catch {
      await User.updateOne({ _id: user._id, 'emailChange.codeHash': hash }, { $unset: { emailChange: 1 } });
      return fail(res, 503, 'Could not send the verification email. Check your email and try again.');
    }
    return res.json({ success: true, message: 'Verification code sent to your new email. It expires in 15 minutes.' });
  } catch { return fail(res, 503, 'Could not request an email change. Please try again.'); }
}
async function confirmEmailChange(req, res) {
  const { email: raw, code } = req.body || {};
  if (!validEmail(raw) || typeof code !== 'string' || !/^\d{8}$/.test(code)) return fail(res, 400, 'Enter the new email and its 8-digit verification code.');
  const email = raw.trim().toLowerCase();
  const invalid = () => fail(res, 400, 'The code is invalid or expired. Request a new one.');
  try {
    const user = await User.findOneAndUpdate({ ...accountFilter(req), 'emailChange.email': email,
      'emailChange.authVersion': req.user.authVersion || 0, 'emailChange.expiresAt': { $gt: new Date() }, 'emailChange.attempts': { $lt: 5 },
    }, { $inc: { 'emailChange.attempts': 1 } }, { returnDocument: 'after' }).select('+emailChange');
    const stored = user?.emailChange?.codeHash, candidate = codeHash(req.user._id, email, code);
    if (!stored || stored.length !== candidate.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) return invalid();
    const updated = await User.findOneAndUpdate({ ...accountFilter(req), 'emailChange.codeHash': stored, 'emailChange.expiresAt': { $gt: new Date() } }, {
      $set: { email }, $inc: { authVersion: 1 }, $unset: { emailChange: 1, passwordReset: 1 },
    }, { returnDocument: 'after', runValidators: true });
    if (!updated) return invalid();
    return res.json({ success: true, data: { user: present(updated), token: generateToken(String(updated._id), updated.authVersion) } });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'This email is unavailable. Choose another email.');
    return fail(res, 503, 'Could not verify your new email. Please try again.');
  }
}
module.exports = { updateProfile, requestEmailChange, confirmEmailChange, present, validPassword, codeHash, accountFilter };
