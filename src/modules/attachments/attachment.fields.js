const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  name: String,
  mime: String,
  size: Number,
  uploadedBy: mongoose.Schema.Types.ObjectId,
}, { _id: false });

module.exports = {
  attachment: { type: attachmentSchema, default: undefined, select: false },
  attachmentBytes: { type: Buffer, select: false },
};
