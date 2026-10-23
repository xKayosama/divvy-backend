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

    shares: {
      type: Number,
      min: 1,
      max: 1000000,
      default: null,
      validate: { validator: value => value === null || Number.isInteger(value), message: 'Shares must be whole numbers.' }
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
        'COFFEE',
        'TRAVEL',
        'ACCOMMODATION',
        'FUEL',
        'PARKING',
        'EDUCATION',
        'PETS',
        'GIFTS',
        'HOME_MAINTENANCE',
        'PERSONAL_CARE',
        'FITNESS',
        'SUBSCRIPTIONS',
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
        'PERCENTAGE',
        'ITEMIZED',
        'SHARES'
      ],
      default: 'EQUAL'
    },

    items: {
      type: [new mongoose.Schema({
        description: { type: String, required: true, trim: true, maxlength: 200 },
        quantity: { type: Number, required: true, min: 0.001, max: 1000000 },
        amount: { type: Number, required: true, min: 0 },
        memberIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], required: true,
          validate: { validator: ids => ids.length > 0, message: 'Assign at least one member to every item.' } }
      }, { _id: false })],
      default: undefined,
      required: function () { return this.splitType === 'ITEMIZED'; },
      validate: { validator: function (items) { return this.splitType === 'ITEMIZED' ? items?.length > 0 && items.length <= 100 : !items?.length; }, message: 'Itemized expenses require 1–100 items; Standard expenses cannot contain items.' }
    },

    adjustments: {
      type: new mongoose.Schema({
        tax: { type: new mongoose.Schema({ amount: { type: Number, required: true, min: 0 }, allocation: { type: String, required: true, enum: ['EQUAL', 'PROPORTIONAL'] } }, { _id: false }), default: undefined },
        tip: { type: new mongoose.Schema({ amount: { type: Number, required: true, min: 0 }, allocation: { type: String, required: true, enum: ['EQUAL', 'PROPORTIONAL'] } }, { _id: false }), default: undefined }
      }, { _id: false }),
      default: undefined,
      validate: { validator: function(value) { return value == null || this.splitType === 'ITEMIZED'; }, message: 'Tax and tip require ITEMIZED.' }
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

    recurring: {
      type: new mongoose.Schema({
        frequency: {type:String,enum:['WEEKLY','MONTHLY','YEARLY'],required:true},
        anchor:{type:Date,required:true},
        endDate:{type:Date,default:null},
        paused:{type:Boolean,default:false},
        nextNumber:{type:Number,required:true,min:1},
        nextDate:{type:Date,default:null},
        lastError:{type:String,default:''},
        lockToken:{type:String,select:false},
        lockedUntil:{type:Date,select:false}
      },{_id:false}),
      default:undefined
    },
    recurrenceSourceId:{type:mongoose.Schema.Types.ObjectId,ref:'Expense',default:null},
    occurrenceNumber:{type:Number,min:1},

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

expenseSchema.index({recurrenceSourceId:1,occurrenceNumber:1},{unique:true,partialFilterExpression:{recurrenceSourceId:{$type:'objectId'},occurrenceNumber:{$type:'number'}}});
expenseSchema.index({'recurring.paused':1,'recurring.nextDate':1});

module.exports = mongoose.model('Expense', expenseSchema);