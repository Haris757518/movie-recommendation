require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

function printStat(label, value) {
  console.log(`${label.padEnd(34, '.')} ${value}`);
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(process.env.MONGO_URI);

  const [
    total,
    missingPoster,
    missingLangCode,
    missingGenre,
    lowPopularity,
    duplicateTmdbRows
  ] = await Promise.all([
    Movie.countDocuments(),
    Movie.countDocuments({ $or: [{ posterUrl: { $exists: false } }, { posterUrl: '' }, { posterUrl: null }] }),
    Movie.countDocuments({ $or: [{ langCode: { $exists: false } }, { langCode: '' }, { langCode: null }] }),
    Movie.countDocuments({ $or: [{ genre: { $exists: false } }, { genre: { $size: 0 } }] }),
    Movie.countDocuments({ popularity: { $lte: 0 } }),
    Movie.aggregate([
      { $group: { _id: { tmdbId: '$tmdbId', isTV: '$isTV' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'rows' }
    ])
  ]);

  const duplicateCount = duplicateTmdbRows[0]?.rows || 0;

  console.log('\n=== CinemaWorld DB Audit ===\n');
  printStat('Total documents', total);
  printStat('Missing posterUrl', missingPoster);
  printStat('Missing langCode', missingLangCode);
  printStat('Missing/empty genre', missingGenre);
  printStat('Popularity <= 0', lowPopularity);
  printStat('Duplicate tmdbId+isTV groups', duplicateCount);

  const sample = await Movie.findOne({}, { title: 1, langCode: 1, genre: 1, posterUrl: 1, popularity: 1, isTV: 1, _id: 0 }).lean();
  console.log('\nSample document:');
  console.log(sample || 'No documents found');

  await mongoose.connection.close();
}

run()
  .catch(async (err) => {
    console.error('Audit failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
