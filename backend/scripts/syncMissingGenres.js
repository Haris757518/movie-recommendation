require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const API_KEY = process.env.TMDB_API_KEY;

const LIMIT = Number(process.env.GENRE_SYNC_LIMIT || 1000);
const DELAY_MS = Number(process.env.GENRE_SYNC_DELAY_MS || 50);
const FORCE = String(process.env.GENRE_SYNC_FORCE || 'false').toLowerCase() === 'true';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbFetch(path) {
  const url = `${TMDB_BASE}${path}?api_key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

function buildQuery() {
  if (FORCE) return {};
  return {
    $or: [
      { genre: { $exists: false } },
      { genre: { $size: 0 } },
      { genre: null }
    ]
  };
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  if (!API_KEY) throw new Error('TMDB_API_KEY is not set');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const query = buildQuery();
  const rows = await Movie.find(query, {
    _id: 1,
    tmdbId: 1,
    isTV: 1,
    title: 1,
    langCode: 1,
    popularity: 1,
    rating: 1,
    year: 1,
    posterUrl: 1,
    backdropUrl: 1,
    description: 1
  })
    .sort({ popularity: -1 })
    .limit(LIMIT)
    .lean();

  console.log(`Rows selected for genre sync: ${rows.length} (force=${FORCE})`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const media = row.isTV ? 'tv' : 'movie';
    try {
      const data = await tmdbFetch(`/${media}/${row.tmdbId}`);
      const genres = Array.isArray(data.genres) ? data.genres.map((g) => g.name).filter(Boolean) : [];

      if (!genres.length) {
        skipped += 1;
        await sleep(DELAY_MS);
        continue;
      }

      const update = {
        genre: genres,
        langCode: row.langCode || data.original_language || '',
        popularity: Number.isFinite(Number(data.popularity)) ? Number(data.popularity) : row.popularity,
        rating: Number.isFinite(Number(data.vote_average)) ? Number(data.vote_average) : row.rating,
        description: row.description || data.overview || ''
      };

      if (!row.posterUrl && data.poster_path) {
        update.posterUrl = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
      }
      if (!row.backdropUrl && data.backdrop_path) {
        update.backdropUrl = `https://image.tmdb.org/t/p/w780${data.backdrop_path}`;
      }
      if (!row.year) {
        const dateStr = row.isTV ? data.first_air_date : data.release_date;
        if (dateStr) update.year = Number(String(dateStr).slice(0, 4));
      }

      await Movie.updateOne({ _id: row._id }, { $set: update });
      updated += 1;
    } catch {
      failed += 1;
    }

    await sleep(DELAY_MS);
  }

  console.log(`Genre sync complete. updated=${updated}, skipped=${skipped}, failed=${failed}`);
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error('Genre sync failed:', err.message);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
