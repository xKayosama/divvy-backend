const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, select: false },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timeZone: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  authTokenHash: { type: String, required: true, select: false },
  authVersion: { type: Number, default: 0 },
  authExpiresAt: { type: Date, required: true },
  generation: { type: String, required: true },
  nextCheckAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: () => new Date(0) },
  day: String,
  state: { type: String, enum: ['PENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'SKIPPED'] },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  ticketId: String,
  receiptAt: Date,
  lastError: String,
  lastTestAt: Date
}, { timestamps: true });
schema.index({ enabled: 1, nextCheckAt: 1 });
module.exports = mongoose.model('PushDevice', schema);
