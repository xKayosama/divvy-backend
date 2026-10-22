const mongoose = require('mongoose');

const billSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },

    name: {
      type: String,
      required: true,
      trim: true
    },

    amount: {
      type: Number,
      required: true,
      min: 0.001
    },

    category: {
      type: String,
      enum: [
        'RENT',
        'ELECTRICITY',
        'WATER',
        'INTERNET',
        'PHONE',
        'SUBSCRIPTION',
        'INSURANCE',
        'OTHER'
      ],
      default: 'OTHER'
    },

    dueDate: {
      type: Date,
      required: true
    },

    isRecurring: {
      type: Boolean,
      default: false
    },

    recurrence: {
      type: String,
      enum: [
        'MONTHLY',
        'WEEKLY',
        'YEARLY',
        null
      ],
      default: null
    },

    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },

    // Server time when payment was recorded; legacy paid bills remain unknown.
    paidAt: {
      type: Date,
      default: null
    },

    // Generated bills never act as recurrence sources.
    recurrenceSourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bill',
      default: null
    },

    occurrenceNumber: { type: Number, min: 1 },
    generatedThrough: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: [
        'PENDING',
        'PAID',
        'OVERDUE'
      ],
      default: 'PENDING'
    },

    notes: {
      type: String,
      trim: true,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

// Required for idempotent generation across processes and interrupted runs.
billSchema.index(
  { recurrenceSourceId: 1, occurrenceNumber: 1 },
  { unique: true, partialFilterExpression: { recurrenceSourceId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Bill', billSchema);