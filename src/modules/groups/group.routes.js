const express = require('express');
const {softDeleteGroup,restoreGroup,deletedGroups,ownerIncludingDeleted}=require('./group.lifecycle');

const {
  createGroup,
  getMyGroups,
  getGroupById,
  addGroupMember,
  removeGroupMember,
  getGroupMembers,
  updateGroup,
  deleteGroup
} = require('./group.controller');

const { protect } = require('../auth/auth.middleware');
const { groupAccess } = require('./groupAccess.middleware');

const router = express.Router();

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
  addGroupMember
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