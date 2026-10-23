const {activeRecordGroup}=require('../groups/group.lifecycle');
const Record=require('./Expense');
const recordGroup=activeRecordGroup(Record,'expenseId');
const express = require('express');
const { updateRecurrence } = require('./expense.recurrence');

const {
  createExpense,
  getGroupExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense
} = require('./expense.controller');

const { protect } = require('../auth/auth.middleware');
const { groupAccess } = require('../groups/groupAccess.middleware');

const router = express.Router();

router.post(
  '/:id/expenses',
  protect,
  groupAccess,
  createExpense
);
  
router.get(
  '/:id/expenses',
  protect,
  groupAccess,
  getGroupExpenses
);

router.get(
  '/:expenseId',
  protect,
  recordGroup,
  getExpenseById
);

router.put(
  '/:expenseId',
  protect,
  recordGroup,
  updateExpense
);

router.delete(
  '/:expenseId',
  protect,
  recordGroup,
  deleteExpense
);

router.patch('/:expenseId/recurrence',protect,recordGroup,updateRecurrence);

module.exports = router;