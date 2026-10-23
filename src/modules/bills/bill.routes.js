const {activeRecordGroup}=require('../groups/group.lifecycle');
const Record=require('./Bill');
const recordGroup=activeRecordGroup(Record,'billId');
const express = require('express');
const {payBill}=require('./bill.payment');

const {
  createBill,
  getGroupBills,
  getBillById,
  updateBill,
  deleteBill
} = require('./bill.controller');

const { protect } = require('../auth/auth.middleware');
const { groupAccess } = require('../groups/groupAccess.middleware');

const router = express.Router();

router.post(
  '/:id/bills',
  protect,
  groupAccess,
  createBill
);

router.get(
  '/:id/bills',
  protect,
  groupAccess,
  getGroupBills
);

router.get(
  '/:billId',
  protect,
  recordGroup,
  getBillById
);

router.put(
  '/:billId',
  protect,
  recordGroup,
  updateBill
);

router.delete(
  '/:billId',
  protect,
  recordGroup,
  deleteBill
);

router.post('/:billId/pay',protect,recordGroup,payBill);

module.exports = router;