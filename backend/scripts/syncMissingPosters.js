require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w500';
const API_KEY = process.env.TMDB_API_KEY;

const LIMIT = Number(process.env.POSTER_SYNC_LIMIT || 500);
const DELAY_MS = Number(process.env.POSTER_SYNC_DELAY_MS || 120);
const FILL_PLACEHOLDER = String(process.env.POSTER_FILL_PLACEHOLDER || 'false').toLowerCase() === 'true';
const PLACEHOLDER_URL = process.env.POSTER_PLACEHOLDER_URL || 'https://placehold.co/500x750/111827/e5e7eb?text=No+Poster';

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPosterFromSearch(results, title, year) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return '';

  const target = normalizeTitle(title);
  const match = rows.find((r) => {
    if (!r?.poster_path) return false;
    const candidateTitle = normalizeTitle(r.title || r.name || '');
    if (!candidateTitle) return false;
    const sameTitle = candidateTitle === target;
    if (!sameTitle) return false;
    if (!year) return true;
    const d = r.release_date || r.first_air_date || '';
    const y = d ? Number(String(d).slice(0, 4)) : 0;
    return !y || Math.abs(y - Number(year)) <= 1;
  });

  if (match?.poster_path) return match.poster_path;

  const firstWithPoster = rows.find((r) => r?.poster_path);
  return firstWithPoster?.poster_path || '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tmdbFetch(path) {
  const url = `${TMDB_BASE}${path}?api_key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  if (!API_KEY) throw new Error('TMDB_API_KEY is not set');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  const rows = await Movie.find(
    {
      $and: [
        { $or: [{ posterUrl: { $exists: false } }, { posterUrl: '' }, { posterUrl: null }] },
        { tmdbId: { $type: 'number' } }
      ]
    },
    { _id: 1, tmdbId: 1, isTV: 1, title: 1, year: 1 }
  )
    .sort({ popularity: -1 })
    .limit(LIMIT)
    .lean();

  console.log(`Rows selected for poster sync: ${rows.length}`);

  let updated = 0;
  let noPoster = 0;
  let placeholderFilled = 0;
  let failed = 0;

  for (const row of rows) {
    const preferredMedia = row.isTV ? 'tv' : 'movie';
    const fallbackMedia = row.isTV ? 'movie' : 'tv';
    try {
      let data;
      try {
        data = await tmdbFetch(`/${preferredMedia}/${row.tmdbId}`);
      } catch {
        data = await tmdbFetch(`/${fallbackMedia}/${row.tmdbId}`);
      }

      let posterPath = data.poster_path || '';
      if (!posterPath) {
        try {
          let images;
          try {
            images = await tmdbFetch(`/${preferredMedia}/${row.tmdbId}/images`);
          } catch {
            images = await tmdbFetch(`/${fallbackMedia}/${row.tmdbId}/images`);
          }
          posterPath = images?.posters?.[0]?.file_path || '';
        } catch {
          posterPath = '';
        }
      }

      // Final fallback: search by title when direct id endpoints have no poster.
      if (!posterPath && row.title) {
        const query = encodeURIComponent(String(row.title).trim());
        try {
          let searchData;
          try {
            searchData = await tmdbFetch(`/search/${preferredMedia}?query=${query}`);
          } catch {
            searchData = await tmdbFetch(`/search/${fallbackMedia}?query=${query}`);
          }

          posterPath = pickPosterFromSearch(searchData?.results, row.title, row.year);

          if (!posterPath) {
            const multiSearch = await tmdbFetch(`/search/multi?query=${query}`);
            posterPath = pickPosterFromSearch(
              (multiSearch?.results || []).filter((r) => r?.media_type === 'movie' || r?.media_type === 'tv'),
              row.title,
              row.year
            );
          }
        } catch {
          posterPath = '';
        }
      }

      if (!posterPath) {
        if (FILL_PLACEHOLDER) {
          await Movie.updateOne(
            { _id: row._id },
            { $set: { posterUrl: PLACEHOLDER_URL } }
          );
          placeholderFilled += 1;
          continue;
        }
        noPoster += 1;
        continue;
      }

      await Movie.updateOne(
        { _id: row._id },
        { $set: { posterUrl: `${TMDB_IMG_W500}${posterPath}` } }
      );

      updated += 1;
    } catch {
      failed += 1;
    }

    await sleep(DELAY_MS);
  }

  console.log(`Poster sync complete. updated=${updated}, placeholderFilled=${placeholderFilled}, noPoster=${noPoster}, failed=${failed}`);

  await mongoose.connection.close();
}

run()
  .catch(async (err) => {
    console.error('Poster sync failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
