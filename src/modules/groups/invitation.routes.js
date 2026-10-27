const router = require('express').Router();
const { protect } = require('../auth/auth.middleware');
const invitations = require('./group.invitations');
const { rateLimit } = require('express-rate-limit');
router.use(protect);
router.get('/', invitations.incoming);
router.post('/lookup', rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, message: 'Too many code lookups. Please try again later.' } }), invitations.lookup);
router.post('/:invitationId/accept', invitations.accept);
router.post('/:invitationId/decline', invitations.decline);
module.exports = router;
