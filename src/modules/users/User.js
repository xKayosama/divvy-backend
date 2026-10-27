const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true
    },

    lastName: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    password: {
      type: String,
      required: true,
      minlength: 6
    },

    // Hidden from ordinary queries and member population responses.
    passwordReset: {
      type: new mongoose.Schema({
        codeHash: String,
        expiresAt: Date,
        requestedAt: Date,
        attempts: { type: Number, default: 0 }
      }, { _id: false }),
      select: false
    },
    authVersion: { type: Number, default: 0 },

    avatar: {
      type: String,
      default: null
    },

    role: {
      type: String,
      enum: ['USER', 'ADMIN', 'OWNER'],
      default: 'USER'
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('User', userSchema);
