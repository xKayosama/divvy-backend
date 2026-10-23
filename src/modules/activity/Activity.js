const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Group' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true, enum: ['EXPENSE_ADDED', 'EXPENSE_EDITED', 'EXPENSE_DELETED', 'BILL_PAID', 'GROUP_UPDATED'] },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  label: { type: String, required: true },
  changes: { type: mongoose.Schema.Types.Mixed },
  snapshot: { type: mongoose.Schema.Types.Mixed },
  eventKey: { type: String, required: true, unique: true },
  occurredAt: { type: Date, default: Date.now, required: true },
}, { bufferCommands: false, timestamps: true });
schema.index({ groupId: 1, occurredAt: -1, _id: -1 });
module.exports = mongoose.model('Activity', schema);
