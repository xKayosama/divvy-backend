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
  getExpenseById
);

router.put(
  '/:expenseId',
  protect,
  updateExpense
);

router.delete(
  '/:expenseId',
  protect,
  deleteExpense
);

router.patch('/:expenseId/recurrence',protect,updateRecurrence);

module.exports = router;