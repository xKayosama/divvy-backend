const mongoose = require('mongoose');

const groupMemberSchema = new mongoose.Schema(
  {
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function () { return this.status !== 'INACTIVE' || !this.invitation; }
    },

    role: {
      type: String,
      enum: ['OWNER', 'MEMBER'],
      default: 'MEMBER'
    },

    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE'
    },

    // An invitation is an inactive membership until the recipient consents.
    // Keeping both states in one document makes accept/decline/revoke atomic.
    invitation: {
      type: new mongoose.Schema({
        email: { type: String, required: true },
        codeHash: { type: String, required: true },
        status: { type: String, enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'], required: true },
        invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        createdAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true }
      }, { _id: false }),
      select: false
    },

    accountDeleted: { type: Boolean, default: false },

    joinedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

groupMemberSchema.index({ groupId: 1, 'invitation.email': 1 }, {
  unique: true, partialFilterExpression: { 'invitation.email': { $type: 'string' } }
});
groupMemberSchema.index({ 'invitation.codeHash': 1 }, {
  unique: true, partialFilterExpression: { 'invitation.codeHash': { $type: 'string' } }
});

// Keep the existing MongoDB collection to preserve deployed data.
module.exports = mongoose.model(
  'GroupMember',
  groupMemberSchema,
  'householdmembers'
);