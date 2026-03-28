const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleSub: { type: String, default: '' },
    emailVerified: { type: Boolean, default: false },
    preferredLanguages: { type: [String], default: [] },
    preferredGenres: { type: [String], default: [] },
    watchlist: { type: [Number], default: [] },
    ratings: { type: Map, of: Number, default: {} }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model('User', userSchema);
