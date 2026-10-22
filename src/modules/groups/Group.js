const mongoose = require('mongoose');
const groupIcons = require('./group.icons.json');

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    icon: {
      type: String,
      enum: groupIcons,
      default: 'people'
    },

    currency: {
      type: String,
      default: 'PHP'
    }
  },
  {
    timestamps: true
  }
);

// Keep the existing MongoDB collection to preserve deployed data.
module.exports = mongoose.model('Group', groupSchema, 'households');