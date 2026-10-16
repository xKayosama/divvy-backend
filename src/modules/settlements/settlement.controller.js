const mongoose = require('mongoose');
const Settlement = require('./Settlement');
const { applySettlementPayments } = require('../settlements/settlement.balances');
const Expense = require('../expenses/Expense');
const GroupMember = require('../groups/GroupMember');

const getGroupSettlements = async (req, res) => {
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

    // Get group expenses
    const expenses = await Expense.find({
      groupId
    });

    // Calculate each member's paid and owed amounts
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

    expenses.forEach((expense) => {
      const payerId = (expense.paidBy._id || expense.paidBy).toString();

      if (balances[payerId]) {
        balances[payerId].paid += expense.amount;
      }

      expense.participants.forEach((participant) => {
        const participantId = (participant.userId._id || participant.userId).toString();

        if (balances[participantId]) {
          balances[participantId].owed += participant.amount;
        }
      });
    });

    // Calculate net balances
    const creditors = [];
    const debtors = [];

    await applySettlementPayments(groupId, Object.values(balances));

    Object.values(balances).forEach((balance) => {
      balance.paid = Number(balance.paid.toFixed(2));
      balance.owed = Number(balance.owed.toFixed(2));



      if (balance.net > 0) {
        creditors.push({
          user: balance.user,
          amount: balance.net
        });
      }

      if (balance.net < 0) {
        debtors.push({
          user: balance.user,
          amount: Math.abs(balance.net)
        });
      }
    });

    // Calculate settlements
    const settlements = [];

    let debtorIndex = 0;
    let creditorIndex = 0;

    while (
      debtorIndex < debtors.length &&
      creditorIndex < creditors.length
    ) {
      const debtor = debtors[debtorIndex];
      const creditor = creditors[creditorIndex];

      const amount = Number(
        Math.min(
          debtor.amount,
          creditor.amount
        ).toFixed(2)
      );

      if (amount > 0) {
        settlements.push({
          from: debtor.user,
          to: creditor.user,
          amount
        });
      }

      debtor.amount = Number(
        (debtor.amount - amount).toFixed(2)
      );

      creditor.amount = Number(
        (creditor.amount - amount).toFixed(2)
      );

      if (debtor.amount <= 0) {
        debtorIndex++;
      }

      if (creditor.amount <= 0) {
        creditorIndex++;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Group settlements calculated successfully.',
      data: {
        settlements
      }
    });
  } catch (error) {
    console.error(
      'Get group settlements error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Something went wrong while calculating group settlements.'
    });
  }
};

const recordSettlement = async (req, res) => {
  try {
    const { to, amount, paidAt } = req.body;
    const from = req.user._id;
    if (!mongoose.isObjectIdOrHexString(to) || String(to) === String(from)) {
      return res.status(400).json({ success: false, message: 'Choose a different valid recipient.' });
    }
    if (req.body.from !== undefined && String(req.body.from) !== String(from)) {
      return res.status(403).json({ success: false, message: 'You can only record payments you sent.' });
    }
    const scaled = amount * 100;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 ||
        !Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 0.000001) {
      return res.status(400).json({ success: false, message: 'Amount must be positive with at most two decimal places.' });
    }
    const date = paidAt === undefined ? new Date() : new Date(paidAt);
    if ((paidAt !== undefined && typeof paidAt !== 'string') || !Number.isFinite(date.getTime()) || date > new Date()) {
      return res.status(400).json({ success: false, message: 'Payment date must be valid and cannot be in the future.' });
    }
    const recipient = await GroupMember.findOne({ groupId: req.params.id, userId: to, status: 'ACTIVE' });
    if (!recipient) {
      return res.status(400).json({ success: false, message: 'Recipient must be an active group member.' });
    }
    const settlement = await Settlement.create({
      groupId: req.params.id, from, to, amount: Math.round(scaled) / 100,
      paidAt: date, recordedBy: from
    });
    return res.status(201).json({ success: true, message: 'Settlement payment recorded.', data: { settlement } });
  } catch (error) {
    console.error('Record settlement error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong while recording the settlement.' });
  }
};

const getSettlementHistory = async (req, res) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    if (!/^\d+$/.test(String(page)) || !/^\d+$/.test(String(limit)) ||
        !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000000 ||
        Number(limit) < 1 || Number(limit) > 100) {
      return res.status(400).json({ success: false, message: 'Use a positive page and a limit between 1 and 100.' });
    }
    const filter = { groupId: req.params.id };
    const settlements = await Settlement.find(filter)
      .sort({ paidAt: -1, createdAt: -1, _id: -1 })
      .skip((Number(page) - 1) * Number(limit)).limit(Number(limit))
      .populate({ path: 'from to recordedBy', select: 'firstName lastName email avatar' });
    const total = await Settlement.countDocuments(filter);
    return res.status(200).json({ success: true, data: { settlements },
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) } });
  } catch (error) {
    console.error('Settlement history error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong while retrieving settlement history.' });
  }
};

module.exports = { getGroupSettlements, recordSettlement, getSettlementHistory };