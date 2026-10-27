const express = require('express');
const {softDeleteGroup,restoreGroup,deletedGroups,ownerIncludingDeleted}=require('./group.lifecycle');

const {
  createGroup,
  getMyGroups,
  getGroupById,
  removeGroupMember,
  getGroupMembers,
  updateGroup,
  deleteGroup
} = require('./group.controller');

const { protect } = require('../auth/auth.middleware');
const { groupAccess } = require('./groupAccess.middleware');

const invitations = require('./group.invitations');
const { rateLimit } = require('express-rate-limit');
const invitationLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, message: 'Too many invitations. Please try again later.' } });
const router = express.Router();
router.get('/:id/invitations', protect, groupAccess, invitations.outgoing);
router.post('/:id/invitations', protect, groupAccess, invitationLimit, invitations.create);
router.post('/:id/invitations/:invitationId/revoke', protect, groupAccess, invitations.revoke);

router.get('/:id/activity', protect, groupAccess, require('../activity/activity.controller').getActivity);

router.post('/', protect, createGroup);

router.get('/', protect, getMyGroups);
router.get('/deleted',protect,deletedGroups);
router.post('/:id/soft-delete',protect,ownerIncludingDeleted,softDeleteGroup);
router.post('/:id/restore',protect,ownerIncludingDeleted,restoreGroup);

router.get(
  '/:id',
  protect,
  groupAccess,
  getGroupById
);

router.post(
  '/:id/members',
  protect,
  groupAccess,
  (_req, res) => res.status(410).json({ success: false, message: 'Direct member additions are no longer supported. Send a group invitation instead.' })
);

router.delete(
  '/:id/members/:userId',
  protect,
  groupAccess,
  removeGroupMember
);

router.get(
  '/:id/members',
  protect,
  groupAccess,
  getGroupMembers
);

router.put(
  '/:id',
  protect,
  groupAccess,
  updateGroup
);

router.delete(
  '/:id',
  protect,
  ownerIncludingDeleted,
  deleteGroup
);

module.exports = router;