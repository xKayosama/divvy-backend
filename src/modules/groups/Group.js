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

    deletedAt:{type:Date,default:null},
    accountDeletion: { type: new mongoose.Schema({ purgeAfter: Date, originalDeletedAt: Date }, { _id: false }), default: undefined },
    deletedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',default:null},
    currency: {
      type: String,
      default: 'PHP'
    }
  },
  {
    timestamps: true
  }
);

// Soft-deleted groups are invisible unless trusted lifecycle code opts in.
for (const operation of ['find','findOne','countDocuments','findOneAndUpdate','findOneAndDelete']) {
  groupSchema.pre(operation,function() {
    const include=this.getOptions().withDeleted===true;
    delete this.options.withDeleted;
    if(!include)this.where({deletedAt:null});
  });
}
groupSchema.index({ownerId:1,deletedAt:1});
// Keep the existing MongoDB collection to preserve deployed data.
module.exports = mongoose.model('Group', groupSchema, 'households');