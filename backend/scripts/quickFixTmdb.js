require('dotenv').config();
const mongoose = require('mongoose');
const fetchModule = require('node-fetch');
const Movie = require('../models/Movie');

const TMDB_KEY = process.env.TMDB_API_KEY;
const fetch = typeof fetchModule === 'function' ? fetchModule : fetchModule.default;

async function fetchDetails(id, isTV) {
  const type = isTV ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[TMDB] ${type}/${id} HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const genres = Array.isArray(data.genres) ? data.genres : [];
    console.log('TMDB:', id, `(${type})`, genres);

    return {
      genre: genres.map(g => g.name).filter(Boolean),
      posterUrl: data.poster_path
        ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
        : '',
      backdropUrl: data.backdrop_path
        ? `https://image.tmdb.org/t/p/original${data.backdrop_path}`
        : ''
    };
  } catch (err) {
    console.log(`[TMDB] ${type}/${id} request failed: ${err.message}`);
    return null;
  }
}

async function fetchDetailsSmart(id, isTV) {
  let data = await fetchDetails(id, isTV);

  if (!data || !Array.isArray(data.genre) || data.genre.length === 0) {
    const fallback = await fetchDetails(id, !isTV);
    if (fallback) {
      console.log(`[TMDB] Fallback used for ${id}: ${(isTV ? 'tv' : 'movie')} -> ${(!isTV ? 'tv' : 'movie')}`);
      data = fallback;
    }
  }

  return data;
}

async function run() {
  if (!TMDB_KEY) {
    throw new Error('TMDB_API_KEY is missing. Set it in your environment or .env file.');
  }
  if (typeof fetch !== 'function') {
    throw new Error('node-fetch import failed. Ensure node-fetch is installed and compatible with CommonJS.');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected');

  if (process.env.RESET_GENRES === 'true') {
    const resetResult = await Movie.updateMany({}, { $set: { genre: [] } });
    console.log(`[RESET] Cleared genre array for ${resetResult.modifiedCount} docs`);
  }

  const movies = await Movie.find({}, '_id tmdbId isTV').lean();
  console.log('Total:', movies.length);

  const batchSize = 20;

  for (let i = 0; i < movies.length; i += batchSize) {
    const batch = movies.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(m => fetchDetailsSmart(m.tmdbId, m.isTV))
    );

    const bulkOps = [];

    batch.forEach((m, idx) => {
      const data = results[idx];
      if (!data || !Array.isArray(data.genre)) return;

      bulkOps.push({
        updateOne: {
          filter: { _id: m._id },
          update: {
            $set: {
              genre: data.genre.length ? data.genre : [],
              posterUrl: data.posterUrl || '',
              backdropUrl: data.backdropUrl || ''
            }
          }
        }
      });
    });

    if (bulkOps.length) {
      const writeResult = await Movie.bulkWrite(bulkOps, { ordered: false });
      console.log(`[BATCH] matched=${writeResult.matchedCount} modified=${writeResult.modifiedCount}`);
    }

    console.log(`Updated ${i + batch.length}`);
  }

  console.log('DONE ✅');
  await mongoose.disconnect();
}

run().catch(async err => {
  console.error('quickFixTmdb failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});