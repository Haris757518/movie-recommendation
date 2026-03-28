const mongoose = require('mongoose');

const movieSchema = new mongoose.Schema(
  {
    tmdbId: { type: Number, required: true, index: true },
    title: { type: String, required: true, trim: true },
    language: { type: String, default: 'Unknown' },
    langCode: { type: String, default: '' },
    genre: { type: [String], default: [] },
    year: { type: Number, default: null },
    rating: { type: Number, default: 0 },
    popularity: { type: Number, default: 0 },
    cast: { type: [String], default: [] },
    posterUrl: { type: String, default: '' },
    backdropUrl: { type: String, default: '' },
    description: { type: String, default: '' },
    isTV: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

movieSchema.index({ tmdbId: 1, isTV: 1 }, { unique: true });
movieSchema.index({ popularity: -1 });
movieSchema.index({ rating: -1 });
movieSchema.index({ year: -1 });
movieSchema.index({ langCode: 1 });
movieSchema.index({ langCode: 1, popularity: -1 });
movieSchema.index({ genre: 1 });
movieSchema.index({ isTV: 1 });
movieSchema.index(
  { title: 'text', description: 'text', cast: 'text' },
  { name: 'search_text_idx', language_override: '_textLangOverride' }
);

module.exports = mongoose.model('Movie', movieSchema);