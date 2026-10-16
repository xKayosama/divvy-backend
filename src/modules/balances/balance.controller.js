const { applySettlementPayments } = require('../settlements/settlement.balances');
const Expense = require('../expenses/Expense');
const GroupMember = require('../groups/GroupMember');

const getGroupBalances = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    // Get active group members
    const memberships = await GroupMember.find({
      groupId,
      status: 'ACTIVE'
    }).populate({
      path: 'userId',
      select: 'firstName lastName email avatar'
    });

    if (memberships.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active group members found.'
      });
    }

    // Get all group expenses
    const expenses = await Expense.find({
      groupId
    });

    // Initialize balances
    const balances = {};

    memberships.forEach((membership) => {
      const userId = membership.userId._id.toString();

      balances[userId] = {
        user: membership.userId,
        paid: 0,
        owed: 0,
        net: 0
      };
    });

    // Calculate paid and owed amounts
    expenses.forEach((expense) => {
      const payerId = (expense.paidBy._id || expense.paidBy).toString();

      // Amount paid by the person
      if (balances[payerId]) {
        balances[payerId].paid += expense.amount;
      }

      // Amount owed by each participant
      expense.participants.forEach((participant) => {
        const participantId = (participant.userId._id || participant.userId).toString();

        if (balances[participantId]) {
          balances[participantId].owed += participant.amount;
        }
      });
    });

    // Calculate net balance
    Object.values(balances).forEach((balance) => {
      balance.paid = Number(balance.paid.toFixed(2));
      balance.owed = Number(balance.owed.toFixed(2));

      balance.net = Number(
        (balance.paid - balance.owed).toFixed(2)
      );
    });

    await applySettlementPayments(groupId, Object.values(balances));

    // Calculate group totals
    const totalExpenses = expenses.reduce(
      (total, expense) => total + expense.amount,
      0
    );

    const totalOwed = Object.values(balances).reduce(
      (total, balance) => total + balance.owed,
      0
    );

    return res.status(200).json({
      success: true,
      message: 'Group balances retrieved successfully.',
      data: {
        totalExpenses: Number(totalExpenses.toFixed(2)),
        totalOwed: Number(totalOwed.toFixed(2)),
        members: Object.values(balances)
      }
    });
  } catch (error) {
    console.error('Get group balances error:', error);

    return res.status(500).json({
      success: false,
      message: 'Something went wrong while calculating group balances.'
    });
  }
};

module.exports = {
  getGroupBalances
};