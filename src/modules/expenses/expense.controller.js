const Expense = require('./Expense');
const GroupMember = require('../groups/GroupMember');

const Group = require('../groups/Group');
const { money } = require('../../utils/money');

const calculateExpenseParticipants = ({ amount, splitType = 'EQUAL', participants, currency }) => {
  const m = money(currency);
  if (!m.valid(amount)) return { error: `Expense amount must be positive with ${m.label}.` };
  const type = typeof splitType === 'string' ? splitType.toUpperCase() : '';
  const total = m.units(amount);
  if (type === 'EQUAL') {
    const base = Math.floor(total / participants.length);
    return { splitType: type, participants: participants.map((p, i) => ({ userId: p.userId,
      amount: (base + (i === 0 ? total - base * participants.length : 0)) / m.scale, percentage: null })) };
  }
  if (type === 'EXACT') {
    if (participants.some(p => !m.valid(p.amount, true))) return { error: `Each participant must have a nonnegative amount with ${m.label}.` };
    const sum = participants.reduce((sum, p) => sum + m.units(p.amount), 0);
    if (sum !== total) return { error: 'Participant amounts must equal the expense amount.' };
    return { splitType: type, participants: participants.map(p => ({ userId: p.userId, amount: m.round(p.amount), percentage: null })) };
  }
  if (type === 'PERCENTAGE') {
    const percent = money('PHP'); // Percentages keep two decimal places regardless of currency.
    if (participants.some(p => !percent.valid(p.percentage, true) || p.percentage > 100)) return { error: 'Each participant must have a valid percentage between 0 and 100.' };
    if (participants.reduce((sum, p) => sum + percent.units(p.percentage), 0) !== 10000) return { error: 'Participant percentages must total 100%.' };
    const amounts = participants.map(p => Number((BigInt(total) * BigInt(percent.units(p.percentage)) + 5000n) / 10000n));
    const last = amounts.length - 1;
    amounts[last] += total - amounts.reduce((sum, amount) => sum + amount, 0);
    let excess = Math.max(0, -amounts[last]);
    if (excess) amounts[last] = 0;
    for (let i = last - 1; i >= 0 && excess; i--) {
      const reduction = Math.min(amounts[i], excess);
      amounts[i] -= reduction; excess -= reduction;
    }
    return { splitType: type, participants: participants.map((p, i) => ({ userId: p.userId, amount: amounts[i] / m.scale, percentage: p.percentage })) };
  }
  return { error: 'Invalid split type. Supported types are EQUAL, EXACT, and PERCENTAGE.' };
};

// -----------------------------
// Create Expense
// -----------------------------

const createExpense = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const {
      description,
      amount,
      category,
      paidBy,
      splitType,
      participants,
      date,
      notes
    } = req.body;

    // -----------------------------
    // Basic validation
    // -----------------------------

    if (!description) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: 'Expense description is required.'
      });
    }

    if (!money(req.group?.currency).valid(amount)) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          `Expense amount must be positive with ${money(req.group?.currency).label}.`
      });
    }

    if (!paidBy) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: 'paidBy is required.'
      });
    }

    if (
      !participants ||
      !Array.isArray(participants) ||
      participants.length === 0
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'At least one participant is required.'
      });
    }

    const normalizedAmount = Number(amount);

    // -----------------------------
    // Check payer membership
    // -----------------------------

    const payerMembership =
      await GroupMember.findOne({
        groupId,
        userId: paidBy,
        status: 'ACTIVE'
      });

    if (!payerMembership) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'The payer is not an active member of this group.'
      });
    }

    // -----------------------------
    // Check participants
    // -----------------------------

    const participantIds = participants.map(
      (participant) => participant.userId
    );

    const uniqueParticipantIds = new Set(
      participantIds.map((id) => id.toString())
    );

    if (
      uniqueParticipantIds.size !==
      participantIds.length
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'Duplicate participants are not allowed.'
      });
    }

    const groupMembers =
      await GroupMember.find({
        groupId,
        userId: { $in: participantIds },
        status: 'ACTIVE'
      });

    if (
      groupMembers.length !==
      participantIds.length
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'All participants must be active members of this group.'
      });
    }

    // -----------------------------
    // Calculate split
    // -----------------------------

    const splitResult =
      calculateExpenseParticipants({
        amount: normalizedAmount,
        currency: req.group?.currency,
        splitType,
        participants
      });

    if (splitResult.error) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: splitResult.error
      });
    }

    // -----------------------------
    // Create expense
    // -----------------------------

    const expense = await Expense.create({
      groupId,
      description,
      amount: normalizedAmount,
      category: category
        ? category.toUpperCase()
        : 'OTHERS',
      paidBy,
      splitType: splitResult.splitType,
      participants: splitResult.participants,
      date: date || new Date(),
      notes: notes || ''
    });

    // -----------------------------
    // Populate response
    // -----------------------------

    await expense.populate([
      {
        path: 'paidBy',
        select:
          'firstName lastName email avatar'
      },
      {
        path: 'participants.userId',
        select:
          'firstName lastName email avatar'
      }
    ]);

    return res.status(201).json({
      code: 201,
      success: true,
      message: 'Expense created successfully.',
      data: {
        expense
      }
    });
  } catch (error) {
    console.error(
      'Create expense error:',
      error
    );

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while creating the expense.'
    });
  }
};

// -----------------------------
// Get Group Expenses
// -----------------------------

const getGroupExpenses = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const {
      page = 1,
      limit = 10,
      category,
      startDate,
      endDate,
      search,
      sort = 'newest'
    } = req.query;

    // Include a unique tie-breaker for deterministic pagination.
    const sortOptions = {
      newest: { date: -1, createdAt: -1, _id: -1 },
      oldest: { date: 1, createdAt: 1, _id: 1 },
      amount_high: { amount: -1, date: -1, createdAt: -1, _id: -1 },
      amount_low: { amount: 1, date: -1, createdAt: -1, _id: -1 },
    };
    if (typeof sort !== 'string' || !Object.hasOwn(sortOptions, sort)) {
      return res.status(400).json({ code: 400, success: false, message: 'sort must be one of: newest, oldest, amount_high, amount_low.' });
    }

    const currentPage = Math.max(
      Number(page),
      1
    );

    const currentLimit = Math.min(
      Math.max(Number(limit), 1),
      100
    );

    const skip =
      (currentPage - 1) *
      currentLimit;

    // -----------------------------
    // Build filters
    // -----------------------------

    const filters = { groupId };

    if (search !== undefined) {
      if (typeof search !== 'string' || search.trim().length > 200) {
        return res.status(400).json({
          success: false,
          code: 400,
          message: 'Search must be a string of at most 200 characters.'
        });
      }

      const term = search.trim();
      if (term) {
        filters.description = {
          $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i'
        };
      }
    }

    // -----------------------------
    // Category filter
    // -----------------------------

    if (category) {
      filters.category =
        category.toUpperCase();
    }

    // -----------------------------
    // Date filter
    // -----------------------------

    const dateRegex =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      startDate &&
      !dateRegex.test(startDate)
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'Invalid startDate. Expected format: YYYY-MM-DD.'
      });
    }

    if (
      endDate &&
      !dateRegex.test(endDate)
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'Invalid endDate. Expected format: YYYY-MM-DD.'
      });
    }

    if (startDate || endDate) {
      filters.date = {};

      // Start date
      if (startDate) {
        const start = new Date(
          `${startDate}T00:00:00.000Z`
        );

        if (
          Number.isNaN(start.getTime())
        ) {
          return res.status(400).json({
            code: 400,
            success: false,
            message:
              'Invalid startDate.'
          });
        }

        filters.date.$gte = start;
      }

      // End date
      if (endDate) {
        const end = new Date(
          `${endDate}T00:00:00.000Z`
        );

        if (
          Number.isNaN(end.getTime())
        ) {
          return res.status(400).json({
            code: 400,
            success: false,
            message:
              'Invalid endDate.'
          });
        }

        // Include the entire end date
        end.setUTCDate(
          end.getUTCDate() + 1
        );

        filters.date.$lt = end;
      }
    }

    // -----------------------------
    // Get expenses
    // -----------------------------

    const [expenses, total] =
      await Promise.all([
        Expense.find(filters)
          .populate({
            path: 'paidBy',
            select:
              'firstName lastName email avatar'
          })
          .populate({
            path: 'participants.userId',
            select:
              'firstName lastName email avatar'
          })
          .sort(sortOptions[sort])
          .skip(skip)
          .limit(currentLimit),

        Expense.countDocuments(filters)
      ]);

    // -----------------------------
    // Pagination
    // -----------------------------

    const totalPages = Math.ceil(
      total / currentLimit
    );

    return res.status(200).json({
      code: 200,
      success: true,
      message:
        'Expenses retrieved successfully.',
      data: {
        expenses
      },
      pagination: {
        page: currentPage,
        limit: currentLimit,
        total,
        totalPages,
        hasNextPage:
          currentPage < totalPages,
        hasPreviousPage:
          currentPage > 1
      }
    });
  } catch (error) {
    console.error(
      'Get group expenses error:',
      error
    );

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while retrieving expenses.'
    });
  }
};

// -----------------------------
// Get Expense By ID
// -----------------------------

const getExpenseById = async (
  req,
  res
) => {
  try {
    const { expenseId } =
      req.params;

    const expense =
      await Expense.findById(
        expenseId
      )
        .populate({
          path: 'paidBy',
          select:
            'firstName lastName email avatar'
        })
        .populate({
          path: 'participants.userId',
          select:
            'firstName lastName email avatar'
        });

    if (!expense) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: 'Expense not found.'
      });
    }

    // -----------------------------
    // Check group membership
    // -----------------------------

    const membership =
      await GroupMember.findOne({
        groupId:
          expense.groupId,
        userId: req.user._id,
        status: 'ACTIVE'
      });

    if (!membership) {
      return res.status(403).json({
        code: 403,
        success: false,
        message:
          'You do not have access to this expense.'
      });
    }

    return res.status(200).json({
      code: 200,
      success: true,
      message:
        'Expense retrieved successfully.',
      data: {
        expense
      }
    });
  } catch (error) {
    console.error(
      'Get expense by ID error:',
      error
    );

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while retrieving the expense.'
    });
  }
};

// -----------------------------
// Update Expense
// -----------------------------

const updateExpense = async (
  req,
  res
) => {
  try {
    const { expenseId } =
      req.params;

    const {
      description,
      amount,
      category,
      paidBy,
      splitType,
      participants,
      date,
      notes
    } = req.body;

    // -----------------------------
    // Find expense
    // -----------------------------

    const expense =
      await Expense.findById(
        expenseId
      );

    if (!expense) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: 'Expense not found.'
      });
    }

    // -----------------------------
    // Check membership
    // -----------------------------

    const membership =
      await GroupMember.findOne({
        groupId:
          expense.groupId,
        userId: req.user._id,
        status: 'ACTIVE'
      });

    if (!membership) {
      return res.status(403).json({
        code: 403,
        success: false,
        message:
          'You do not have access to this expense.'
      });
    }

    // -----------------------------
    // Existing values
    // -----------------------------

    const updatedDescription =
      description !== undefined
        ? description
        : expense.description;

    const group = await Group.findById(expense.groupId);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found.' });
    const updatedAmount = amount !== undefined ? amount : expense.amount;

    const updatedCategory =
      category !== undefined
        ? category.toUpperCase()
        : expense.category;

    const updatedPaidBy =
      paidBy !== undefined
        ? paidBy
        : expense.paidBy;

    const updatedSplitType =
      splitType !== undefined
        ? splitType
        : expense.splitType;

    const updatedParticipants =
      participants !== undefined
        ? participants
        : expense.participants;

    const updatedDate =
      date !== undefined
        ? date
        : expense.date;

    const updatedNotes =
      notes !== undefined
        ? notes
        : expense.notes;

    // -----------------------------
    // Basic validation
    // -----------------------------

    if (!updatedDescription) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'Expense description is required.'
      });
    }

    if (
      !money(group.currency).valid(updatedAmount)
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          `Expense amount must be positive with ${money(group.currency).label}.`
      });
    }

    if (!updatedPaidBy) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'paidBy is required.'
      });
    }

    if (
      !updatedParticipants ||
      !Array.isArray(
        updatedParticipants
      ) ||
      updatedParticipants.length === 0
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'At least one participant is required.'
      });
    }

    // -----------------------------
    // Check payer membership
    // -----------------------------

    const payerMembership =
      await GroupMember.findOne({
        groupId:
          expense.groupId,
        userId: updatedPaidBy,
        status: 'ACTIVE'
      });

    if (!payerMembership) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'The payer is not an active member of this group.'
      });
    }

    // -----------------------------
    // Check participants
    // -----------------------------

    const participantIds =
      updatedParticipants.map(
        (participant) =>
          participant.userId
      );

    const uniqueParticipantIds =
      new Set(
        participantIds.map((id) =>
          id.toString()
        )
      );

    if (
      uniqueParticipantIds.size !==
      participantIds.length
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'Duplicate participants are not allowed.'
      });
    }

    const groupMembers =
      await GroupMember.find({
        groupId:
          expense.groupId,
        userId: {
          $in: participantIds
        },
        status: 'ACTIVE'
      });

    if (
      groupMembers.length !==
      participantIds.length
    ) {
      return res.status(400).json({
        code: 400,
        success: false,
        message:
          'All participants must be active members of this group.'
      });
    }

    // -----------------------------
    // Calculate split
    // -----------------------------

    const splitResult =
      calculateExpenseParticipants({
        amount: updatedAmount,
        currency: group.currency,
        splitType:
          updatedSplitType,
        participants:
          updatedParticipants
      });

    if (splitResult.error) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: splitResult.error
      });
    }

    // -----------------------------
    // Update expense
    // -----------------------------

    expense.description =
      updatedDescription;

    expense.amount =
      updatedAmount;

    expense.category =
      updatedCategory;

    expense.paidBy =
      updatedPaidBy;

    expense.splitType =
      splitResult.splitType;

    expense.participants =
      splitResult.participants;

    expense.date =
      updatedDate;

    expense.notes =
      updatedNotes;

    await expense.save();

    // -----------------------------
    // Populate response
    // -----------------------------

    await expense.populate([
      {
        path: 'paidBy',
        select:
          'firstName lastName email avatar'
      },
      {
        path: 'participants.userId',
        select:
          'firstName lastName email avatar'
      }
    ]);

    return res.status(200).json({
      code: 200,
      success: true,
      message:
        'Expense updated successfully.',
      data: {
        expense
      }
    });
  } catch (error) {
    console.error(
      'Update expense error:',
      error
    );

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while updating the expense.'
    });
  }
};

// -----------------------------
// Delete Expense
// -----------------------------

const deleteExpense = async (
  req,
  res
) => {
  try {
    const { expenseId } =
      req.params;

    const expense =
      await Expense.findById(
        expenseId
      );

    if (!expense) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: 'Expense not found.'
      });
    }

    // -----------------------------
    // Check membership
    // -----------------------------

    const membership =
      await GroupMember.findOne({
        groupId:
          expense.groupId,
        userId: req.user._id,
        status: 'ACTIVE'
      });

    if (!membership) {
      return res.status(403).json({
        code: 403,
        success: false,
        message:
          'You do not have access to this expense.'
      });
    }

    await Expense.findByIdAndDelete(
      expenseId
    );

    return res.status(200).json({
      code: 200,
      success: true,
      message:
        'Expense deleted successfully.'
    });
  } catch (error) {
    console.error(
      'Delete expense error:',
      error
    );

    return res.status(500).json({
      code: 500,
      success: false,
      message:
        'Something went wrong while deleting the expense.'
    });
  }
};

module.exports = {
  createExpense,
  getGroupExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense
};