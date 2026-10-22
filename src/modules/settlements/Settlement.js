const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0.001 },
  paidAt: { type: Date, required: true, default: Date.now },
  requestId: { type: String },
  balanceClaim: { type: String },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

settlementSchema.index({ groupId: 1, paidAt: -1, createdAt: -1 });
settlementSchema.index({ groupId: 1, from: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
settlementSchema.index({ groupId: 1, balanceClaim: 1 }, { unique: true, partialFilterExpression: { balanceClaim: { $type: 'string' } } });
module.exports = mongoose.model('Settlement', settlementSchema);
