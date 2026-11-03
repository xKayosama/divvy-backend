const { randomInt, createHmac, timingSafeEqual } = require('node:crypto');
const User = require('../users/User');
const delivery = require('./password-reset.email');
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
const hashCode = (email, code) => createHmac('sha256', process.env.JWT_SECRET).update(`signup:${email}:${code}`).digest('hex');
async function issueCode(email) {
  if (!delivery.isConfigured()) return false;
  const now = Date.now();
  const code = String(randomInt(0, 100000000)).padStart(8, '0');
  const codeHash = hashCode(email, code);
  const user = await User.findOneAndUpdate({ email, emailVerified: false, deletedAt: null,
    $or: [{ 'signupVerification.requestedAt': { $exists: false } }, { 'signupVerification.requestedAt': { $lte: new Date(now - 60000) } }]
  }, { $set: { signupVerification: { codeHash, requestedAt: new Date(now), expiresAt: new Date(now + 15 * 60000), attempts: 0 } } });
  if (!user) return true;
  try { await delivery.sendSignupCode(email, code); return true; }
  catch {
    await User.updateOne({ _id: user._id, 'signupVerification.codeHash': codeHash }, { $unset: { signupVerification: 1 } });
    return false;
  }
}
async function resend(req, res) {
  if (!validEmail(req.body?.email)) return fail(res, 400, 'Enter a valid email address.');
  try {
    if (!await issueCode(req.body.email.trim().toLowerCase())) return fail(res, 503, 'Could not send the verification email. Please try again.');
    return res.json({ success: true, message: 'If your account needs verification, a code has been sent. Check your inbox and spam folder. Wait 60 seconds before requesting another code.' });
  } catch { return fail(res, 503, 'Could not send the verification email. Please try again.'); }
}
async function verify(req, res) {
  const { email: raw, code } = req.body || {};
  if (!validEmail(raw) || typeof code !== 'string' || !/^\d{8}$/.test(code)) return fail(res, 400, 'Enter your email and its 8-digit verification code.');
  const email = raw.trim().toLowerCase();
  const invalid = () => fail(res, 400, 'The code is invalid or expired. Request a new code.');
  try {
    const user = await User.findOneAndUpdate({ email, emailVerified: false, deletedAt: null,
      'signupVerification.expiresAt': { $gt: new Date() }, 'signupVerification.attempts': { $lt: 5 }
    }, { $inc: { 'signupVerification.attempts': 1 } }, { new: true }).select('+signupVerification');
    const stored = user?.signupVerification?.codeHash, candidate = hashCode(email, code);
    if (!stored || stored.length !== candidate.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(candidate))) return invalid();
    const result = await User.updateOne({ _id: user._id, emailVerified: false, deletedAt: null,
      'signupVerification.codeHash': stored, 'signupVerification.expiresAt': { $gt: new Date() }
    }, { $set: { emailVerified: true }, $unset: { signupVerification: 1 } });
    if (result.modifiedCount !== 1) return invalid();
    return res.json({ success: true, message: 'Email verified. You can now sign in.' });
  } catch { return fail(res, 503, 'Could not verify your email. Please try again.'); }
}
module.exports = { issueCode, resend, verify, hashCode };
