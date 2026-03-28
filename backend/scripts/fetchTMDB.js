require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_W780 = 'https://image.tmdb.org/t/p/w780';

const API_KEY = process.env.TMDB_API_KEY;

// 🔥 CONFIG
const LANGUAGES = ['ta','hi','te','ml','kn','en','ko','ja','zh','fr','es'];
const DISCOVER_PAGES = 300;
const SEARCH_PAGES = 40;
const BATCH_SIZE = 10; // parallel requests

const LANG_MAP = {
  en:'English', hi:'Hindi', ta:'Tamil', te:'Telugu', ml:'Malayalam',
  kn:'Kannada', ko:'Korean', ja:'Japanese', zh:'Chinese', fr:'French', es:'Spanish'
};

// ---------- HELPERS ----------

function mapItem(m, isTV=false) {
  return {
    tmdbId: m.id,
    title: m.title || m.name || 'Untitled',
    language: LANG_MAP[m.original_language] || m.original_language,
    langCode: m.original_language,
    year: m.release_date ? Number(m.release_date.slice(0,4)) : null,
    rating: m.vote_average || 0,
    popularity: m.popularity || 0,
    posterUrl: m.poster_path ? TMDB_IMG_W500 + m.poster_path : '',
    backdropUrl: m.backdrop_path ? TMDB_IMG_W780 + m.backdrop_path : '',
    description: m.overview || '',
    isTV
  };
}

async function fetchTMDB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('TMDB error');
  return res.json();
}

async function bulkSave(docs) {
  if (!docs.length) return;

  const ops = docs.map(d => ({
    updateOne: {
      filter: { tmdbId: d.tmdbId, isTV: d.isTV },
      update: { $set: d },
      upsert: true
    }
  }));

  await Movie.bulkWrite(ops, { ordered: false });
}

// ---------- DISCOVER ----------

async function fetchDiscover(endpoint, isTV=false) {
  let total = 0;

  for (const lang of LANGUAGES) {
    for (let i = 1; i <= DISCOVER_PAGES; i += BATCH_SIZE) {

      const batch = [];

      for (let j = 0; j < BATCH_SIZE; j++) {
        const page = i + j;
        if (page > DISCOVER_PAGES) break;

        const url =
          `${TMDB_BASE}${endpoint}?api_key=${API_KEY}` +
          `&with_original_language=${lang}` +
          `&sort_by=popularity.desc&page=${page}`;

        batch.push(fetchTMDB(url));
      }

      const results = await Promise.allSettled(batch);

      const docs = [];

      for (const r of results) {
        if (r.status === 'fulfilled') {
          docs.push(...r.value.results.map(m => mapItem(m, isTV)));
        }
      }

      await bulkSave(docs);
      total += docs.length;

      console.log(`DISCOVER ${endpoint} lang=${lang} pages=${i}-${i+BATCH_SIZE} total=${total}`);
    }
  }

  return total;
}

// ---------- SEARCH ----------

async function fetchSearch(endpoint, isTV=false) {
  let total = 0;
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');

  for (const letter of letters) {
    for (let i = 1; i <= SEARCH_PAGES; i += BATCH_SIZE) {

      const batch = [];

      for (let j = 0; j < BATCH_SIZE; j++) {
        const page = i + j;
        if (page > SEARCH_PAGES) break;

        const url =
          `${TMDB_BASE}${endpoint}?api_key=${API_KEY}` +
          `&query=${letter}&page=${page}`;

        batch.push(fetchTMDB(url));
      }

      const results = await Promise.allSettled(batch);

      const docs = [];

      for (const r of results) {
        if (r.status === 'fulfilled') {
          docs.push(...r.value.results.map(m => mapItem(m, isTV)));
        }
      }

      await bulkSave(docs);
      total += docs.length;

      console.log(`SEARCH ${endpoint} letter=${letter} pages=${i}-${i+BATCH_SIZE} total=${total}`);
    }
  }

  return total;
}

// ---------- MAIN ----------

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB Connected");

  try {
    const m1 = await fetchDiscover('/discover/movie', false);
    const m2 = await fetchDiscover('/discover/tv', true);
    const m3 = await fetchSearch('/search/movie', false);
    const m4 = await fetchSearch('/search/tv', true);

    const count = await Movie.countDocuments();

    console.log("DONE ✅");
    console.log("Movies:", m1);
    console.log("TV:", m2);
    console.log("Search Movies:", m3);
    console.log("Search TV:", m4);
    console.log("TOTAL IN DB:", count);

  } catch (e) {
    console.error(e);
  } finally {
    mongoose.connection.close();
  }
}

run();