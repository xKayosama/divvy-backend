const router = require('express').Router();
const { randomUUID } = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const Device = require('./PushDevice');
const transport = require('./push.transport');
const { protect } = require('../auth/auth.middleware');
const { safeError } = require('./bill-notifications');
const validToken = value => typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(value);
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const summary = device => ({ enabled: !!device?.enabled, timeZone: device?.timeZone || null, lastError: device?.lastError || null, deliveryState: device?.state || null, workerEnabled: process.env.BILL_NOTIFICATIONS_ENABLED === 'true' });
router.use(protect);
const inbox = require('./inbox');
router.get('/inbox', inbox.list);
router.get('/unread-count', inbox.unread);
router.post('/inbox/read-all', inbox.readAll);
router.post('/inbox/:id/read', inbox.read);
router.post('/devices', rateLimit({ windowMs: 60 * 60000, limit: 120,
  keyGenerator: req => String(req.user._id), standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, message: 'Too many device updates. Please try again later.' }
}), async (req, res) => {
  const { token, timeZone } = req.body || {};
  if (!validToken(token) || typeof timeZone !== 'string' || timeZone.length > 100) return fail(res, 400, 'A valid device token and timezone are required.');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { return fail(res, 400, 'Choose a valid timezone.'); }
  try {
    await Device.init();
    const existing = await Device.findOne({ token }).select('+authTokenHash');
    const sameOwner = existing && String(existing.userId) === String(req.user._id);
    const sameSession = sameOwner && existing.authTokenHash === req.auth.tokenHash && existing.enabled;
    const device = await Device.findOneAndUpdate({ token }, { $set: {
      userId: req.user._id, timeZone, enabled: true, authTokenHash: req.auth.tokenHash,
      authVersion: req.user.authVersion || 0, authExpiresAt: req.auth.expiresAt,
      generation: sameSession ? existing.generation : randomUUID(),
      leaseUntil: sameSession ? existing.leaseUntil : new Date(0), nextCheckAt: new Date(), lastError: sameSession ? existing.lastError || '' : '',
      ...(!sameOwner || !existing?.enabled ? { day: '', state: 'SKIPPED', ticketId: null, attempts: 0 } : {})
    } }, { upsert: true, returnDocument: 'after', runValidators: true });
    return res.json({ success: true, data: { device: summary(device) } });
  } catch { return fail(res, 503, 'Could not enable bill notifications. Please try again.'); }
});
router.post('/status', async (req, res) => {
  if (!validToken(req.body?.token)) return fail(res, 400, 'A valid device token is required.');
  try { return res.json({ success: true, data: { device: summary(await Device.findOne({ token: req.body.token, userId: req.user._id })) } }); }
  catch { return fail(res, 503, 'Could not check notification settings.'); }
});
router.delete('/devices', async (req, res) => {
  if (!validToken(req.body?.token)) return fail(res, 400, 'A valid device token is required.');
  try {
    await Device.updateOne({ token: req.body.token, userId: req.user._id }, { $set: { enabled: false, generation: randomUUID() } });
    return res.json({ success: true });
  } catch { return fail(res, 503, 'Could not disable bill notifications. Please try again.'); }
});
router.post('/test', rateLimit({ windowMs: 15 * 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, message: 'Too many notification tests. Please try again later.' } }), async (req, res) => {
  if (!validToken(req.body?.token)) return fail(res, 400, 'A valid device token is required.');
  try {
    const device = await Device.findOne({ token: req.body.token, userId: req.user._id, enabled: true }).select('+token');
    if (!device) return fail(res, 404, 'Enable notifications on this device first.');
    const ticket = await transport.send({ to: device.token, title: 'Divvy notifications are connected',
      body: 'This is your bill reminder test. Tap to open Divvy.', sound: 'default', channelId: 'bill-reminders', ttl: 300,
      data: { type: 'bill-reminder', userId: String(req.user._id) } });
    if (ticket.status === 'error') {
      await Device.updateOne({ _id: device._id }, { $set: { lastError: safeError(ticket.details?.error), ...(ticket.details?.error === 'DeviceNotRegistered' ? { enabled: false } : {}) } });
      return fail(res, 503, 'The push provider rejected this device. Check push credentials and enable notifications again.');
    }
    return res.json({ success: true, message: 'Test notification accepted by Expo. Check this device.' });
  } catch { return fail(res, 503, 'Could not send the test notification. Check the backend push setup.'); }
});
module.exports = router;
