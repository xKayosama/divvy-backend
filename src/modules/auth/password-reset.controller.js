const { randomInt, createHmac, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const bcrypt = require('bcryptjs');
const User = require('../users/User');
const emailDelivery = require('./password-reset.email');
const GENERIC = 'If an account exists for this email, you will receive a reset code. Check your inbox and spam folder.';
const INVALID = 'The code is invalid or expired. Request a new code and try again.';
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
// Keyed hashes prevent offline guessing of numeric codes from a database dump.
const hashCode = (email, code) => createHmac('sha256', process.env.JWT_SECRET).update(`password-reset:${email}:${code}`).digest('hex');

async function requestPasswordReset(req, res) {
  const started = Date.now();
  const email = req.body?.email;
  if (!validEmail(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  if (!emailDelivery.isConfigured()) return res.status(503).json({ success: false, message: 'Password reset is temporarily unavailable. Please try again later.' });
  const normalized = email.trim().toLowerCase();
  const code = String(randomInt(0, 100000000)).padStart(8, '0');
  const codeHash = hashCode(normalized, code);
  try {
    // Atomic per-account cooldown also works across multiple API instances.
    const user = await User.findOneAndUpdate({
      email: normalized, deletedAt: null,
      $or: [{ 'passwordReset.requestedAt': { $exists: false } }, { 'passwordReset.requestedAt': { $lte: new Date(started - 60000) } }]
    }, { $set: { passwordReset: { codeHash, requestedAt: new Date(started), expiresAt: new Date(started + 15 * 60000), attempts: 0 } } }, { new: true });
    if (user) {
      try { await emailDelivery.sendCode(normalized, code); }
      catch {
        // Do not leave a usable code after a known delivery failure, or erase a newer request.
        await User.updateOne({ _id: user._id, 'passwordReset.codeHash': codeHash }, { $unset: { passwordReset: 1 } });
        console.error('Password reset email could not be delivered.');
      }
    }
    // Pad fast/nonexistent-account requests to reduce timing disclosure.
    await delay(Math.max(0, 1000 - (Date.now() - started)));
    return res.status(200).json({ success: true, message: GENERIC });
  } catch {
    return res.status(503).json({ success: false, message: 'Password reset is temporarily unavailable. Please try again later.' });
  }
}

async function resetPassword(req, res) {
  const { email, code, password } = req.body || {};
  if (!validEmail(email) || typeof code !== 'string' || !/^\d{8}$/.test(code) ||
      typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ success: false, message: 'Enter a valid email, 8-digit code, and a password of at least 8 characters and at most 72 UTF-8 bytes.' });
  }
  try {
    // Reserve an attempt before checking. Concurrent guesses cannot exceed five.
    const user = await User.findOneAndUpdate({
      email: email.trim().toLowerCase(), deletedAt: null,
      'passwordReset.expiresAt': { $gt: new Date() },
      'passwordReset.attempts': { $lt: 5 }
    }, { $inc: { 'passwordReset.attempts': 1 } }, { new: true }).select('+passwordReset');
    const candidate = hashCode(email.trim().toLowerCase(), code);
    const stored = user?.passwordReset?.codeHash;
    if (!stored || stored.length !== candidate.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) {
      return res.status(400).json({ success: false, message: INVALID });
    }
    const hashedPassword = await bcrypt.hash(password, 12);
    // Password change, token invalidation, and code consumption are ONE atomic write.
    const result = await User.updateOne({
      _id: user._id,
      'passwordReset.codeHash': stored,
      'passwordReset.expiresAt': { $gt: new Date() }
    }, { $set: { password: hashedPassword }, $inc: { authVersion: 1 }, $unset: { passwordReset: 1, emailChange: 1 } });
    if (result.modifiedCount !== 1) return res.status(400).json({ success: false, message: INVALID });
    return res.status(200).json({ success: true, message: 'Your password has been reset. Sign in with your new password.' });
  } catch {
    return res.status(503).json({ success: false, message: 'Could not reset your password. Please try again.' });
  }
}
module.exports = { requestPasswordReset, resetPassword, hashCode };
