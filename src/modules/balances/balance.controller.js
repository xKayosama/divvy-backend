const { money } = require('../../utils/money');
const { applySettlementPayments } = require('../settlements/settlement.balances');
const Expense = require('../expenses/Expense');
const GroupMember = require('../groups/GroupMember');

const getGroupBalances = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const m = money(req.group?.currency);

    // Get active group members
    const memberships = await GroupMember.find({
      groupId,
      $or: [{ status: 'ACTIVE' }, { accountDeleted: true }]
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
        balances[payerId].paid += m.readUnits(expense.amount);
      }

      // Amount owed by each participant
      expense.participants.forEach((participant) => {
        const participantId = (participant.userId._id || participant.userId).toString();

        if (balances[participantId]) {
          balances[participantId].owed += m.readUnits(participant.amount);
        }
      });
    });

    Object.values(balances).forEach(balance => {
      balance.paid /= m.scale;
      balance.owed /= m.scale;
    });
    await applySettlementPayments(groupId, Object.values(balances), req.group?.currency);
    const totalExpenses = m.sum(expenses.map(expense => expense.amount));
    const totalOwed = m.sum(Object.values(balances).map(balance => balance.owed));

    return res.status(200).json({
      success: true,
      message: 'Group balances retrieved successfully.',
      data: {
        totalExpenses: totalExpenses,
        totalOwed: totalOwed,
        members: Object.values(balances)
      }
    });
  } catch (error) {
    if (error.code === 'CURRENCY_PRECISION_CONFLICT') return res.status(409).json({ success: false, message: error.message });
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