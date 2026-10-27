const { rateLimit } = require('express-rate-limit');

const options = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' }
};

const loginLimit = rateLimit({ ...options, limit: 20, skipSuccessfulRequests: true });
const registrationLimit = rateLimit({ ...options, limit: 5 });

const passwordResetRequestLimit = rateLimit({ ...options, limit: 5 });
const passwordResetLimit = rateLimit({ ...options, limit: 20 });
module.exports = { loginLimit, registrationLimit, passwordResetRequestLimit, passwordResetLimit };
