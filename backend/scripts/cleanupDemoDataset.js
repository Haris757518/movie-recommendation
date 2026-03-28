require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

async function run() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(process.env.MONGO_URI);

  const junkFilter = {
    $or: [
      { genre: { $exists: false } },
      { genre: { $size: 0 } },
      { posterUrl: '' },
      { rating: { $lte: 0 } }
    ]
  };

  const before = await Movie.countDocuments({});
  const junk = await Movie.countDocuments(junkFilter);

  if (!apply) {
    console.log('Dry run only. Use --apply to execute deletion.');
    console.log(JSON.stringify({ before, junk, afterEstimate: before - junk }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const result = await Movie.deleteMany(junkFilter);
  const after = await Movie.countDocuments({});

  console.log('Cleanup complete.');
  console.log(JSON.stringify({ before, deleted: result.deletedCount || 0, after }, null, 2));

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Cleanup failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
