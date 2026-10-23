const { createSchedule, unlocked } = require('./expense.recurrence');
const { calculateItemizedExpense } = require('./expense.itemized');
const Expense = require('./Expense');
const GroupMember = require('../groups/GroupMember');

const Group = require('../groups/Group');
const { money } = require('../../utils/money');

const {calculateExpenseParticipants}=require('./expense.split');

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
      participants: suppliedParticipants,
      items,
      adjustments,
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

    const isItemized = typeof splitType === 'string' && splitType.toUpperCase() === 'ITEMIZED';
    if (isItemized && suppliedParticipants !== undefined) return res.status(400).json({ success: false, message: 'Itemized participants are calculated from items; omit participants.' });
    if (!isItemized && adjustments !== undefined) return res.status(400).json({ success: false, message: 'Tax and tip adjustments require ITEMIZED.' });
    if (!isItemized && items !== undefined && (!Array.isArray(items) || items.length)) return res.status(400).json({ success: false, message: 'Items require the ITEMIZED split type.' });
    const itemizedResult = isItemized ? calculateItemizedExpense({ amount, items, adjustments, currency: req.group?.currency }) : null;
    if (itemizedResult?.error) return res.status(400).json({ success: false, message: itemizedResult.error });
    const participants = isItemized ? itemizedResult.participants : suppliedParticipants;

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

    const splitResult = itemizedResult ??
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

    let recurring;
    try { recurring = createSchedule(req.body.recurring,date || new Date()); }
    catch(error) { return res.status(400).json({success:false,message:error.message}); }
    const expense = await Expense.create({
      ...(recurring ? {recurring} : {}),
      groupId,
      description,
      amount: normalizedAmount,
      category: category
        ? category.toUpperCase()
        : 'OTHERS',
      paidBy,
      splitType: splitResult.splitType,
      participants: splitResult.participants,
      ...(isItemized ? { items: splitResult.items, adjustments: splitResult.adjustments } : {}),
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
      participants: suppliedParticipants,
      items,
      adjustments,
      date,
      notes
    } = req.body;

    // -----------------------------
    // Find expense
    // -----------------------------

    let expense =
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
    if(expense.billId) return res.status(409).json({success:false,message:'This expense records a paid bill and cannot be edited or deleted independently.'});
    if (req.body.recurring !== undefined) return res.status(400).json({success:false,message:'Manage the schedule from expense details.'});
    if (expense.recurring && req.body.date !== undefined && new Date(req.body.date).getTime() !== new Date(expense.date).getTime()) return res.status(400).json({success:false,message:'The first expense date anchors this schedule and cannot change.'});

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

    const isItemized = typeof updatedSplitType === 'string' && updatedSplitType.toUpperCase() === 'ITEMIZED';
    if (isItemized && suppliedParticipants !== undefined) return res.status(400).json({ success: false, message: 'Itemized participants are calculated from items; omit participants.' });
    if (!isItemized && adjustments !== undefined) return res.status(400).json({ success: false, message: 'Tax and tip adjustments require ITEMIZED.' });
    if (!isItemized && items !== undefined && (!Array.isArray(items) || items.length)) return res.status(400).json({ success: false, message: 'Items require the ITEMIZED split type.' });
    const itemizedResult = isItemized ? calculateItemizedExpense({ amount: updatedAmount, items: items !== undefined ? items : expense.items, adjustments: adjustments !== undefined ? adjustments : expense.adjustments, currency: group.currency }) : null;
    if (itemizedResult?.error) return res.status(400).json({ success: false, message: itemizedResult.error });
    const updatedParticipants = isItemized ? itemizedResult.participants :
      suppliedParticipants !== undefined ? suppliedParticipants : expense.participants;

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

    const splitResult = itemizedResult ??
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

    // Explicit conversion to Standard clears the persisted itemization.
    if (isItemized) {
      expense.items = splitResult.items;
      expense.adjustments = splitResult.adjustments;
    } else {
      expense.items = undefined;
      expense.adjustments = undefined;
    }

    expense.date =
      updatedDate;

    expense.notes =
      updatedNotes;

    if (expense.recurring) {
      const fields = {};
      for (const key of ['description','amount','category','paidBy','splitType','participants','items','adjustments','date','notes']) fields[key] = expense.toObject()[key];
      const unset = {};
      for (const key of ['items','adjustments']) if (fields[key] === undefined) { delete fields[key]; unset[key]=1; }
      expense = await Expense.findOneAndUpdate({_id:expense._id,...unlocked(new Date())},{$set:fields,...(Object.keys(unset).length ? {$unset:unset} : {})},{new:true,runValidators:true});
      if(!expense) return res.status(409).json({success:false,message:'Schedule is processing. Try saving again shortly.'});
    } else await expense.save();

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

    if(expense.billId) return res.status(409).json({success:false,message:'This expense records a paid bill and cannot be edited or deleted independently.'});
    if(expense.recurrenceSourceId) {
      const source = await Expense.findById(expense.recurrenceSourceId);
      if(source?.recurring && source.recurring.nextNumber <= expense.occurrenceNumber) return res.status(409).json({success:false,message:'This occurrence is still processing. Try again shortly.'});
    }
    if(expense.recurring) {
      if(!await Expense.findOneAndDelete({_id:expenseId,...unlocked(new Date())})) return res.status(409).json({success:false,message:'Schedule is processing. Try deleting again shortly.'});
    } else await Expense.findByIdAndDelete(expenseId);

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