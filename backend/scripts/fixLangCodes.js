require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

async function run() {
  const apply = process.argv.includes('--apply');
  const fallbackLang = process.env.FALLBACK_LANG_CODE || 'en';

  await mongoose.connect(process.env.MONGO_URI);

  const filter = {
    $or: [
      { langCode: { $exists: false } },
      { langCode: '' },
      { langCode: null }
    ]
  };

  const missingCount = await Movie.countDocuments(filter);
  if (!apply) {
    console.log('Dry run only. Use --apply to write fallback langCode.');
    console.log(JSON.stringify({ missingCount, fallbackLang }, null, 2));
    await mongoose.disconnect();
    return;
  }

  const result = await Movie.updateMany(filter, {
    $set: { langCode: fallbackLang }
  });

  console.log('langCode backfill complete.');
  console.log(JSON.stringify({
    matched: result.matchedCount || 0,
    modified: result.modifiedCount || 0,
    fallbackLang
  }, null, 2));

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('langCode fix failed:', error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
