const { money } = require('../../utils/money');
const { buildSpendingComparison } = require('./dashboard.comparison');
const { buildCategoryBreakdown } = require('./dashboard.categories');
const { resolveDashboardPeriod } = require('./dashboard.period');
const { presentBill, buildBillReminders, dayWindow } = require('../bills/bill.reminders');
const { applySettlementPayments } = require('../settlements/settlement.balances');
const Expense = require('../expenses/Expense');
const Bill = require('../bills/Bill');
const GroupMember = require('../groups/GroupMember');

const getGroupDashboard = async (req, res) => {
  try {
    const { id: groupId } = req.params;
    const m = money(req.group?.currency);
    const now = new Date();
    let selection;
    try {
      selection = resolveDashboardPeriod(req.query?.period, now);
    } catch (error) {
    if (error.code === 'CURRENCY_PRECISION_CONFLICT') return res.status(409).json({ success: false, message: error.message });
      return res.status(400).json({ code: 400, success: false, message: error.message });
    }
    const { period, start, end } = selection;

    // Get active group members
    const members = await GroupMember.find({
      groupId,
      $or: [{ status: 'ACTIVE' }, { accountDeleted: true }]
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
    const rawBills = await Bill.find({
      groupId
    })
      .sort({
        dueDate: 1
      })
      .populate({
        path: 'paidBy',
        select: 'firstName lastName email avatar'
      });

    const bills = rawBills.map(bill => presentBill(bill, now));
    const billReminders = buildBillReminders(bills, now, req.group?.currency);

    // Keep all expense history for live balances; period selection affects
    // only spending summaries and recent expense previews.
    const periodExpenses = start
      ? expenses.filter(expense => {
        const date = new Date(expense.date);
        return date >= start && date < end;
      })
      : expenses;
    const recentExpenses = periodExpenses.slice(0, 5);

    // Upcoming 5 pending bills
    const { today } = dayWindow(now);

    const upcomingBills = bills
      .filter(
        (bill) =>
          bill.status === 'PENDING' &&
          new Date(bill.dueDate) >= today
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
        balanceMap[paidById].paid += m.readUnits(expense.amount);
      }

      expense.participants.forEach((participant) => {
        const participantId = participant.userId._id.toString();

        if (balanceMap[participantId]) {
          balanceMap[participantId].owed += m.readUnits(participant.amount);
        }
      });
    });

    const balances = Object.values(balanceMap);

    balances.forEach((balance) => {
      balance.paid /= m.scale;
      balance.owed /= m.scale;
      balance.net = m.round(balance.paid - balance.owed);
    });

    await applySettlementPayments(groupId, balances, req.group?.currency);

    // Use the same cents totals for the spending card and category breakdown.
    const { totalAmount: totalExpenses, spendingByCategory } = buildCategoryBreakdown(periodExpenses, req.group?.currency);
    const totalPaid = totalExpenses;
    const spendingComparison = buildSpendingComparison(expenses, selection, req.group?.currency);

    const totalOwed = m.sum(periodExpenses.flatMap(expense => expense.participants.map(part => part.amount)));

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

    const pendingBillsAmount = m.sum(pendingBills.map(bill => bill.amount));

    const overdueBillsAmount = m.sum(overdueBills.map(bill => bill.amount));

    const paidBillsAmount = m.sum(paidBills.map(bill => bill.amount));

    return res.status(200).json({
      code: 200,
      success: true,
      message: 'Group dashboard retrieved successfully.',
      data: {
        period,
        spendingByCategory,
        spendingComparison,
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

        upcomingBills,
        billReminders
      }
    });
  } catch (error) {
    if (error.code === 'CURRENCY_PRECISION_CONFLICT') return res.status(409).json({ success: false, message: error.message });
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