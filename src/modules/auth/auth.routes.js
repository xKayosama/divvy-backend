const express = require('express');

const { register, login, logout, getMe } = require('./auth.controller');

const { protect } = require('./auth.middleware');
const { loginLimit, registrationLimit } = require('./auth.rate-limit');

const { requestPasswordReset, resetPassword } = require('./password-reset.controller');
const { passwordResetRequestLimit, passwordResetLimit } = require('./auth.rate-limit');

const router = express.Router();
router.post('/forgot-password', passwordResetRequestLimit, requestPasswordReset);
router.post('/reset-password', passwordResetLimit, resetPassword);

router.post('/register', registrationLimit, register);
router.post('/login', loginLimit, login);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
const profile = require('./profile.controller');
const { rateLimit } = require('express-rate-limit');
const accountLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: req => String(req.user._id), message: { success: false, message: 'Too many account requests. Please try again later.' } });
router.patch('/me', protect, profile.updateProfile);
router.post('/email-change', protect, accountLimit, profile.requestEmailChange);
router.post('/email-change/confirm', protect, accountLimit, profile.confirmEmailChange);


const deletion = require('./account-deletion');
router.get('/deletion-preview', protect, deletion.preview);
router.delete('/me', protect, accountLimit, deletion.remove);

module.exports = router;
