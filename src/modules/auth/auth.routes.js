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

module.exports = router;
