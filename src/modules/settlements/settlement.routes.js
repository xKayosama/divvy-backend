const express = require('express');

const {
  getGroupSettlements, recordSettlement, getSettlementHistory
} = require('./settlement.controller');

const { protect } = require('../auth/auth.middleware');
const { groupAccess } = require('../groups/groupAccess.middleware');

const router = express.Router();

router.get(
  '/:id/settlements',
  protect,
  groupAccess,
  getGroupSettlements, recordSettlement, getSettlementHistory
);

router.post('/:id/settlements', protect, groupAccess, recordSettlement);
router.get('/:id/settlements/history', protect, groupAccess, getSettlementHistory);

module.exports = router;