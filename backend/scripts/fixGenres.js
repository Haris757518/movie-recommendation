require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

async function run() {
  const apply = process.argv.includes('--apply');
  const fallbackGenre = process.env.FALLBACK_GENRE || 'Drama';

  await mongoose.connect(process.env.MONGO_URI);

  const filter = {
    $or: [
      { genre: { $exists: false } },
      { genre: { $size: 0 } }
    ]
  };

  const missingCount = await Movie.countDocuments(filter);
  if (!apply) {
    console.log('Dry run only. Use --apply to write fallback genres.');
    console.log(JSON.stringify({ missingCount, fallbackGenre }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const result = await Movie.updateMany(filter, {
    $set: { genre: [fallbackGenre] }
  });

  console.log('Genre backfill complete.');
  console.log(JSON.stringify({
    matched: result.matchedCount || 0,
    modified: result.modifiedCount || 0,
    fallbackGenre
  }, null, 2));

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Genre fix failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
