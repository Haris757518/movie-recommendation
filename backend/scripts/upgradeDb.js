require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

const LANG_CODE_BY_NAME = {
  Tamil: 'ta',
  Telugu: 'te',
  Malayalam: 'ml',
  Kannada: 'kn',
  Hindi: 'hi',
  English: 'en',
  Japanese: 'ja',
  Korean: 'ko',
  Chinese: 'zh',
  French: 'fr',
  Spanish: 'es',
  German: 'de',
  Italian: 'it',
  Russian: 'ru',
  Arabic: 'ar',
  Portuguese: 'pt'
};

async function backfillLangCodes() {
  let totalUpdated = 0;
  for (const [language, langCode] of Object.entries(LANG_CODE_BY_NAME)) {
    const res = await Movie.updateMany(
      {
        language,
        $or: [
          { langCode: { $exists: false } },
          { langCode: '' },
          { langCode: null }
        ]
      },
      { $set: { langCode } }
    );

    const modified = res.modifiedCount || 0;
    if (modified > 0) {
      console.log(`Backfilled ${modified} docs: ${language} -> ${langCode}`);
    }
    totalUpdated += modified;
  }

  return totalUpdated;
}

async function createIndexes() {
  const synced = await Movie.syncIndexes();
  console.log('Indexes synced:', synced);
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const langUpdated = await backfillLangCodes();
  console.log(`Total langCode updates: ${langUpdated}`);

  await createIndexes();

  await mongoose.connection.close();
  console.log('DB upgrade completed');
}

run()
  .catch(async (err) => {
    console.error('Upgrade failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
