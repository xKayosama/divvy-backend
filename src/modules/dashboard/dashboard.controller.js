const { applySettlementPayments } = require('../settlements/settlement.balances');
const Expense = require('../expenses/Expense');
const Bill = require('../bills/Bill');
const GroupMember = require('../groups/GroupMember');

const getGroupDashboard = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    // Get active group members
    const members = await GroupMember.find({
      groupId,
      status: 'ACTIVE'
    }).populate({
      path: 'userId',
      select: 'firstName lastName email avatar'
    });

    // Get group expenses
    const expenses = await Expense.find({
      groupId
    })
      .sort({
        date: -1,
        createdAt: -1
      })
      .populate({
        path: 'paidBy',
        select: 'firstName lastName email avatar'
      })
      .populate({
        path: 'participants.userId',
        select: 'firstName lastName email avatar'
      });

    // Get group bills
    const bills = await Bill.find({
      groupId
    })
      .sort({
        dueDate: 1
      })
      .populate({
        path: 'paidBy',
        select: 'firstName lastName email avatar'
      });

    // Recent 5 expenses
    const recentExpenses = expenses.slice(0, 5);

    // Upcoming 5 pending bills
    const now = new Date();

    const upcomingBills = bills
      .filter(
        (bill) =>
          bill.status === 'PENDING' &&
          new Date(bill.dueDate) >= now
      )
      .slice(0, 5);

    // Calculate member balances
    const balanceMap = {};

    members.forEach((member) => {
      const userId = member.userId._id.toString();

      balanceMap[userId] = {
        user: member.userId,
        paid: 0,
        owed: 0,
        net: 0
      };
    });

    expenses.forEach((expense) => {
      const paidById = expense.paidBy._id.toString();

      if (balanceMap[paidById]) {
        balanceMap[paidById].paid += expense.amount;
      }

      expense.participants.forEach((participant) => {
        const participantId = participant.userId._id.toString();

        if (balanceMap[participantId]) {
          balanceMap[participantId].owed += participant.amount;
        }
      });
    });

    const balances = Object.values(balanceMap);

    balances.forEach((balance) => {
      balance.net = balance.paid - balance.owed;
    });

    await applySettlementPayments(groupId, balances);

    // Calculate totals
    const totalExpenses = expenses.reduce(
      (total, expense) => total + expense.amount,
      0
    );

    const totalPaid = expenses.reduce(
      (total, expense) => total + expense.amount,
      0
    );

    const totalOwed = expenses.reduce(
      (total, expense) =>
        total +
        expense.participants.reduce(
          (participantTotal, participant) =>
            participantTotal + participant.amount,
          0
        ),
      0
    );

    // Bill summary
    const pendingBills = bills.filter(
      (bill) => bill.status === 'PENDING'
    );

    const overdueBills = bills.filter(
      (bill) => bill.status === 'OVERDUE'
    );

    const paidBills = bills.filter(
      (bill) => bill.status === 'PAID'
    );

    const pendingBillsAmount = pendingBills.reduce(
      (total, bill) => total + bill.amount,
      0
    );

    const overdueBillsAmount = overdueBills.reduce(
      (total, bill) => total + bill.amount,
      0
    );

    const paidBillsAmount = paidBills.reduce(
      (total, bill) => total + bill.amount,
      0
    );

    return res.status(200).json({
      code: 200,
      success: true,
      message: 'Group dashboard retrieved successfully.',
      data: {
        summary: {
          totalExpenses,
          totalPaid,
          totalOwed
        },

        balances,

        bills: {
          total: bills.length,
          pending: pendingBills.length,
          overdue: overdueBills.length,
          paid: paidBills.length,
          pendingAmount: pendingBillsAmount,
          overdueAmount: overdueBillsAmount,
          paidAmount: paidBillsAmount
        },

        recentExpenses,

        upcomingBills
      }
    });
  } catch (error) {
    console.error('Get group dashboard error:', error);

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while retrieving the group dashboard.'
    });
  }
};


module.exports = {
  getGroupDashboard
};