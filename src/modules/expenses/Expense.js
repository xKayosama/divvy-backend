const mongoose = require('mongoose');

const expenseParticipantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    amount: {
      type: Number,
      required: true,
      min: 0
    },

     percentage: {
      type: Number,
      min: 0,
      max: 100,
      default: null
    }
  },
  {
    _id: false
  }
);

const expenseSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },

    description: {
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
        'FOOD',
        'RENT',
        'UTILITIES',
        'INTERNET',
        'TRANSPORTATION',
        'GROCERIES',
        'HEALTHCARE',
        'ENTERTAINMENT',
        'SHOPPING',
        'OTHERS'
      ],
      default: 'OTHERS'
    },

    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    splitType: {
      type: String,
      enum: [
        'EQUAL',
        'EXACT',
        'PERCENTAGE'
      ],
      default: 'EQUAL'
    },

    participants: {
      type: [expenseParticipantSchema],
      required: true,
      validate: {
        validator: (participants) => participants.length > 0,
        message: 'At least one participant is required.'
      }
    },

    date: {
      type: Date,
      default: Date.now
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

module.exports = mongoose.model('Expense', expenseSchema);