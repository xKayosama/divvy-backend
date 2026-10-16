const Bill = require('./Bill');
const GroupMember = require('../groups/GroupMember');

const createBill = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const {
      name,
      amount,
      category,
      dueDate,
      isRecurring,
      recurrence,
      paidBy,
      status,
      notes
    } = req.body;

    // Validate name
    if (!name || !name.trim()) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Bill name is required.'
      });
    }

    // Validate amount
    if (amount === undefined || Number(amount) <= 0) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Bill amount must be greater than zero.'
      });
    }

    // Validate due date
    if (!dueDate) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Due date is required.'
      });
    }

    const parsedDueDate = new Date(dueDate);

    if (Number.isNaN(parsedDueDate.getTime())) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Invalid due date.'
      });
    }

    const recurring = isRecurring === true;

    // Recurring bills must have a recurrence value
    if (
      recurring &&
      !['MONTHLY', 'WEEKLY', 'YEARLY'].includes(recurrence)
    ) {
      return res.status(400).json({
        code:400,
        success: false,
        message:
          'Recurrence is required for recurring bills.'
      });
    }

    // Non-recurring bills should not have recurrence
    if (!recurring && recurrence) {
      return res.status(400).json({
        code:400,
        success: false,
        message:
          'Recurrence should only be provided for recurring bills.'
      });
    }

    // If paidBy is provided, make sure that person belongs
    // to the group
    if (paidBy) {
      const payerMembership = await GroupMember.findOne({
        groupId,
        userId: paidBy,
        status: 'ACTIVE'
      });

      if (!payerMembership) {
        return res.status(400).json({
          code:400,
          success: false,
          message:
            'The payer is not an active member of this group.'
        });
      }
    }

    const bill = await Bill.create({
      groupId,
      name: name.trim(),
      amount: Number(amount),
      category: category || 'OTHER',
      dueDate: parsedDueDate,
      isRecurring: recurring,
      recurrence: recurring ? recurrence : null,
      paidBy: paidBy || null,
      status: status || 'PENDING',
      notes: notes ? notes.trim() : ''
    });

    await bill.populate({
      path: 'paidBy',
      select: 'firstName lastName email avatar'
    });

    return res.status(201).json({
      code:201,
      success: true,
      message: 'Bill created successfully.',
      data: {
        bill
      }
    });
  } catch (error) {
    console.error('Create bill error:', error);

    return res.status(500).json({
      code:500,
      success: false,
      message: 'Something went wrong while creating the bill.'
    });
  }
};

const getGroupBills = async (req, res) => {
  try {
    const { id: groupId } = req.params;

    const {
      page = 1,
      limit = 10,
      category,
      status,
      isRecurring,
      search
    } = req.query;

    const currentPage = Math.max(Number(page), 1);
    const currentLimit = Math.min(
      Math.max(Number(limit), 1),
      100
    );

    const skip = (currentPage - 1) * currentLimit;

    const filters = {
      groupId
    };

    if (search !== undefined && (typeof search !== 'string' || search.trim().length > 200)) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: 'search must be a string of at most 200 characters.'
      });
    }

    if (search && search.trim()) {
      const pattern = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filters.$or = ['name', 'notes'].map(field => ({
        [field]: { $regex: pattern, $options: 'i' }
      }));
    }

    // Category filter
    if (category) {
      filters.category = category.toUpperCase();
    }

    // Status filter
    if (status) {
      filters.status = status.toUpperCase();
    }

    // Recurring filter
    if (isRecurring !== undefined) {
      if (!['true', 'false'].includes(isRecurring)) {
        return res.status(400).json({
          code:400,
          success: false,
          message: 'isRecurring must be true or false.'
        });
      }

      filters.isRecurring = isRecurring === 'true';
    }

    const [bills, total] = await Promise.all([
      Bill.find(filters)
        .populate({
          path: 'paidBy',
          select: 'firstName lastName email avatar'
        })
        .sort({
          dueDate: 1,
          createdAt: -1
        })
        .skip(skip)
        .limit(currentLimit),

      Bill.countDocuments(filters)
    ]);

    const totalPages = Math.ceil(
      total / currentLimit
    );

    return res.status(200).json({
      code:200,
      success: true,
      message: 'Bills retrieved successfully.',
      data: {
        bills
      },
      pagination: {
        page: currentPage,
        limit: currentLimit,
        total,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPreviousPage: currentPage > 1
      }
    });
  } catch (error) {
    console.error(
      'Get group bills error:',
      error
    );

    return res.status(500).json({
      code:500,
      success: false,
      message:
        'Something went wrong while retrieving bills.'
    });
  }
};

const getBillById = async (req, res) => {
  try {
    const { billId } = req.params;

    const bill = await Bill.findById(billId).populate({
      path: 'paidBy',
      select: 'firstName lastName email avatar'
    });

    if (!bill) {
      return res.status(404).json({
        code:404,
        success: false,
        message: 'Bill not found.'
      });
    }

    // Check if logged-in user has access to the group
    const membership = await GroupMember.findOne({
      groupId: bill.groupId,
      userId: req.user._id,
      status: 'ACTIVE'
    });

    if (!membership) {
      return res.status(403).json({
        code:403,
        success: false,
        message: 'You do not have access to this bill.'
      });
    }

    return res.status(200).json({
      code:200,
      success: true,
      message: 'Bill retrieved successfully.',
      data: {
        bill
      }
    });
  } catch (error) {
    console.error('Get bill by ID error:', error);

    return res.status(500).json({
      code:500,
      success: false,
      message: 'Something went wrong while retrieving the bill.'
    });
  }
};

const updateBill = async (req, res) => {
  try {
    const { billId } = req.params;

    const {
      name,
      amount,
      category,
      dueDate,
      isRecurring,
      recurrence,
      paidBy,
      status,
      notes
    } = req.body;

    const bill = await Bill.findById(billId);

    if (!bill) {
      return res.status(404).json({
        code:404,
        success: false,
        message: 'Bill not found.'
      });
    }

    // Check group access
    const membership = await GroupMember.findOne({
      groupId: bill.groupId,
      userId: req.user._id,
      status: 'ACTIVE'
    });

    if (!membership) {
      return res.status(403).json({
        code:403,
        success: false,
        message: 'You do not have access to this bill.'
      });
    }

    if (bill.status === 'PAID') {
      return res.status(409).json({
        code: 409,
        success: false,
        message: 'Paid bills cannot be edited or deleted.'
      });
    }

    if (bill.recurrenceSourceId && isRecurring === true) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: 'Generated occurrences cannot become recurring sources. Create a new recurring bill instead.'
      });
    }

    // Use existing values when fields are not provided
    const updatedName =
      name !== undefined ? name.trim() : bill.name;

    const updatedAmount =
      amount !== undefined
        ? Number(amount)
        : bill.amount;

    const updatedCategory =
      category !== undefined
        ? category.toUpperCase()
        : bill.category;

    const updatedDueDate =
      dueDate !== undefined
        ? new Date(dueDate)
        : bill.dueDate;

    const updatedIsRecurring =
      isRecurring !== undefined
        ? isRecurring
        : bill.isRecurring;

    const updatedRecurrence =
      recurrence !== undefined
        ? recurrence
        : bill.recurrence;

    const updatedPaidBy =
      paidBy !== undefined
        ? paidBy
        : bill.paidBy;

    const updatedStatus =
      status !== undefined
        ? status.toUpperCase()
        : bill.status;

    const updatedNotes =
      notes !== undefined
        ? notes.trim()
        : bill.notes;

    // Validate name
    if (!updatedName) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Bill name is required.'
      });
    }

    // Validate amount
    if (!updatedAmount || updatedAmount <= 0) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Bill amount must be greater than zero.'
      });
    }

    // Validate due date
    if (Number.isNaN(updatedDueDate.getTime())) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Invalid due date.'
      });
    }

    // Validate recurring settings
    if (
      updatedIsRecurring &&
      !['MONTHLY', 'WEEKLY', 'YEARLY'].includes(
        updatedRecurrence
      )
    ) {
      return res.status(400).json({
        code:400,
        success: false,
        message:
          'A valid recurrence is required for recurring bills.'
      });
    }

    if (!updatedIsRecurring) {
      // Non-recurring bills should not have recurrence
      bill.recurrence = null;
    }

    // Validate status
    if (
      !['PENDING', 'PAID', 'OVERDUE'].includes(
        updatedStatus
      )
    ) {
      return res.status(400).json({
        code:400,
        success: false,
        message: 'Invalid bill status.'
      });
    }

    // Validate payer
    if (updatedPaidBy) {
      const payerMembership =
        await GroupMember.findOne({
          groupId: bill.groupId,
          userId: updatedPaidBy,
          status: 'ACTIVE'
        });

      if (!payerMembership) {
        return res.status(400).json({
          code:400,
          success: false,
          message:
            'The payer is not an active member of this group.'
        });
      }
    }

    // Update fields
    bill.name = updatedName;
    bill.amount = updatedAmount;
    bill.category = updatedCategory;
    bill.dueDate = updatedDueDate;
    bill.isRecurring = updatedIsRecurring;
    bill.recurrence = updatedIsRecurring
      ? updatedRecurrence
      : null;
    bill.paidBy = updatedPaidBy || null;
    bill.status = updatedStatus;
    bill.notes = updatedNotes;

    // The condition also prevents a concurrent payment from being overwritten.
    const updatedBill = await Bill.findOneAndUpdate(
      { _id: billId, status: { $ne: 'PAID' } },
      { $set: {
        name: bill.name, amount: bill.amount, category: bill.category,
        dueDate: bill.dueDate, isRecurring: bill.isRecurring,
        recurrence: bill.recurrence, paidBy: bill.paidBy,
        status: bill.status, notes: bill.notes
      } },
      { new: true, runValidators: true }
    );
    if (!updatedBill) {
      return res.status(409).json({ code: 409, success: false, message: 'Bill was paid or removed. Reload the bill list.' });
    }

    await updatedBill.populate({
      path: 'paidBy',
      select: 'firstName lastName email avatar'
    });

    return res.status(200).json({
      code:200,  
      success: true,
      message: 'Bill updated successfully.',
      data: {
        bill: updatedBill
      }
    });
  } catch (error) {
    console.error('Update bill error:', error);

    return res.status(500).json({
      code:500,  
      success: false,
      message:
        'Something went wrong while updating the bill.'
    });
  }
};

const deleteBill = async (req, res) => {
  try {
    const { billId } = req.params;

    const bill = await Bill.findById(billId);

    if (!bill) {
      return res.status(404).json({
        code:404,
        success: false,
        message: 'Bill not found.'
      });
    }

    const membership = await GroupMember.findOne({
      groupId: bill.groupId,
      userId: req.user._id,
      status: 'ACTIVE'
    });

    if (!membership) {
      return res.status(403).json({
        code:403,
        success: false,
        message: 'You do not have access to this bill.'
      });
    }

    if (bill.status === 'PAID') {
      return res.status(409).json({
        code: 409,
        success: false,
        message: 'Paid bills cannot be edited or deleted.'
      });
    }

    const deletedBill = await Bill.findOneAndDelete({ _id: billId, status: { $ne: 'PAID' } });
    if (!deletedBill) {
      return res.status(409).json({ code: 409, success: false, message: 'Bill was paid or removed. Reload the bill list.' });
    }

    return res.status(200).json({
      code:200,
      success: true,
      message: 'Bill deleted successfully.'
    });
  } catch (error) {
    console.error('Delete bill error:', error);

    return res.status(500).json({
      code:500,
      success: false,
      message: 'Something went wrong while deleting the bill.'
    });
  }
};

module.exports = {
  createBill,
  getGroupBills,
  getBillById,
  updateBill,
  deleteBill
};
