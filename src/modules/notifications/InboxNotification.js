const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['bill-reminder', 'invitation'], required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  groupId: mongoose.Schema.Types.ObjectId,
  billId: mongoose.Schema.Types.ObjectId,
  createdAt: { type: Date, required: true },
  readAt: { type: Date, default: null },
}, { versionKey: false });
schema.index({ userId: 1, createdAt: -1, _id: -1 });
schema.index({ userId: 1, readAt: 1 });
module.exports = mongoose.model('InboxNotification', schema);
