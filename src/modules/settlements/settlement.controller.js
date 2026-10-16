const mongoose = require('mongoose');
const Settlement = require('./Settlement');
const { getSettlementSnapshot } = require('./settlement.snapshot');
const GroupMember = require('../groups/GroupMember');

const getGroupSettlements = async (req, res) => {
  try {
    const result = await getSettlementSnapshot(req.params.id);
    if (!result.memberCount) return res.status(404).json({ success: false, message: 'No active group members found.' });
    return res.status(200).json({ success: true, message: 'Group settlements calculated successfully.', data: { settlements: result.settlements } });
  } catch (error) {
    console.error('Get group settlements error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong while calculating group settlements.' });
  }
};

const recordSettlement = async (req, res) => {
  try {
    const { to, amount, paidAt, requestId } = req.body;
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
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))) {
      return res.status(400).json({ success: false, message: 'Invalid payment request ID.' });
    }
    if (requestId) {
      const previous = await Settlement.findOne({ groupId: req.params.id, from, requestId });
      if (previous) {
        if (String(previous.to) !== String(to) || previous.amount !== amount || (paidAt !== undefined && previous.paidAt.getTime() !== date.getTime())) return res.status(409).json({ success: false, message: 'This request already recorded a different payment.' });
        return res.status(200).json({ success: true, message: 'Payment already recorded.', data: { settlement: previous } });
      }
    }
    const recipient = await GroupMember.findOne({ groupId: req.params.id, userId: to, status: 'ACTIVE' });
    if (!recipient) {
      return res.status(400).json({ success: false, message: 'Recipient must be an active group member.' });
    }
    await Settlement.createIndexes(); // Fail closed if duplicate-payment indexes cannot be ensured.
    const { settlements, snapshot } = await getSettlementSnapshot(req.params.id);
    const outstanding = settlements.find(item => String(item.from._id) === String(from) && String(item.to._id) === String(to));
    if (!outstanding || Math.round(amount * 100) > Math.round(outstanding.amount * 100)) {
      return res.status(409).json({ success: false, message: 'This repayment is already settled or the amount exceeds the current outstanding balance. Reload payments.' });
    }
    const settlement = await Settlement.create({
      groupId: req.params.id, from, to, amount: Math.round(scaled) / 100,
      paidAt: date, recordedBy: from,
      ...(requestId ? { requestId } : {}), balanceClaim: `${snapshot}:${String(from)}:${String(to)}`
    });
    return res.status(201).json({ success: true, message: 'Settlement payment recorded.', data: { settlement } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'This payment was already recorded or the balance changed. Reload payments before retrying.' });
    }
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