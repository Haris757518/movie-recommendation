const https = require('https');
const Movie = require('../models/Movie');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_W500 = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMAGE_W780 = 'https://image.tmdb.org/t/p/w780';
const TMDB_TIMEOUT_MS = Math.max(parseInt(process.env.TMDB_SYNC_TIMEOUT_MS, 10) || 12000, 3000);
const TMDB_SYNC_RETRIES = Math.min(Math.max(parseInt(process.env.TMDB_SYNC_RETRIES, 10) || 2, 0), 5);
const AUTO_SYNC_MINUTES = Math.max(parseInt(process.env.TMDB_AUTO_SYNC_INTERVAL_MINUTES, 10) || 360, 30);
const DEFAULT_RECENT_PAGES = Math.min(Math.max(parseInt(process.env.TMDB_SYNC_RECENT_PAGES, 10) || 3, 1), 10);
const DEFAULT_POPULAR_PAGES = Math.min(Math.max(parseInt(process.env.TMDB_SYNC_POPULAR_PAGES, 10) || 2, 1), 10);
const AUTO_SYNC_ENABLED = String(process.env.TMDB_AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_SYNC_RUN_ON_START = String(process.env.TMDB_AUTO_SYNC_RUN_ON_START || 'true').toLowerCase() !== 'false';

const MOVIE_GENRE_MAP = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

const TV_GENRE_MAP = {
  10759: 'Action',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  10762: 'Kids',
  9648: 'Mystery',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
  37: 'Western'
};

const LANGUAGE_NAME_MAP = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  bn: 'Bengali',
  mr: 'Marathi',
  pa: 'Punjabi',
  gu: 'Gujarati',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  zh: 'Chinese',
  ar: 'Arabic',
  pt: 'Portuguese',
  tr: 'Turkish',
  th: 'Thai',
  vi: 'Vietnamese'
};

const tmdbHttpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,
  maxSockets: 20,
  timeout: TMDB_TIMEOUT_MS + 2000
});

let fetchImpl = null;
let autoSyncHandle = null;
let isSyncRunning = false;

async function serverFetch(url, options = {}) {
  if (!fetchImpl) {
    const nodeFetchModule = await import('node-fetch');
    fetchImpl = nodeFetchModule.default;
  }

  return fetchImpl(url, options);
}

function mapLanguageName(langCode = '') {
  const code = String(langCode || '').trim().toLowerCase();
  if (!code) return 'Unknown';
  return LANGUAGE_NAME_MAP[code] || code.toUpperCase();
}

function parseYearFromDate(dateValue = '') {
  const value = String(dateValue || '').trim();
  if (!value || value.length < 4) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function mapTmdbItemToMovieDoc(item, mediaType) {
  const isTV = mediaType === 'tv';
  const title = String(item?.title || item?.name || 'Untitled').trim();
  const langCode = String(item?.original_language || '').trim().toLowerCase();
  const releaseDate = isTV ? item?.first_air_date : item?.release_date;
  const genreMap = isTV ? TV_GENRE_MAP : MOVIE_GENRE_MAP;

  const genre = Array.isArray(item?.genre_ids)
    ? item.genre_ids
      .map((id) => genreMap[Number(id)])
      .filter(Boolean)
      .slice(0, 4)
    : [];

  return {
    tmdbId: Number(item?.id || 0),
    title: title || 'Untitled',
    language: mapLanguageName(langCode),
    langCode,
    genre,
    year: parseYearFromDate(releaseDate),
    rating: Number(item?.vote_average || 0),
    popularity: Number(item?.popularity || 0),
    posterUrl: item?.poster_path ? `${TMDB_IMAGE_W500}${item.poster_path}` : '',
    backdropUrl: item?.backdrop_path ? `${TMDB_IMAGE_W780}${item.backdrop_path}` : '',
    description: String(item?.overview || '').trim(),
    isTV
  };
}

async function tmdbGet(path, params = {}) {
  const apiKey = String(process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('TMDB_API_KEY is required for TMDB sync');
  }

  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set('api_key', apiKey);

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  const shouldRetryStatus = (status) => [408, 425, 429, 500, 502, 503, 504].includes(Number(status));

  for (let attempt = 0; attempt <= TMDB_SYNC_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS + (attempt * 1000));

    try {
      const response = await serverFetch(url.toString(), {
        signal: controller.signal,
        agent: tmdbHttpsAgent,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CinemaWorld/1.0 (+auto-sync)'
        }
      });

      if (!response.ok) {
        const status = Number(response.status);
        if (attempt < TMDB_SYNC_RETRIES && shouldRetryStatus(status)) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }

        throw new Error(`TMDB ${status}`);
      }

      return response.json();
    } catch (error) {
      const status = Number(error?.status || 0);
      const errorCode = String(error?.code || error?.cause?.code || '');
      const isTimeout = error?.name === 'AbortError';
      const isNetworkError = isTimeout || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(errorCode);
      const canRetry = attempt < TMDB_SYNC_RETRIES && (isNetworkError || shouldRetryStatus(status));

      if (!canRetry) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('TMDB sync request failed after retries');
}

async function fetchDiscoverBatch(mediaType, sortBy, pages) {
  const docs = [];

  for (let page = 1; page <= pages; page++) {
    const data = await tmdbGet(`/discover/${mediaType}`, {
      sort_by: sortBy,
      include_adult: 'false',
      include_video: 'false',
      page
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    results.forEach((item) => {
      const doc = mapTmdbItemToMovieDoc(item, mediaType);
      if (Number.isFinite(doc.tmdbId) && doc.tmdbId > 0 && doc.posterUrl) {
        docs.push(doc);
      }
    });
  }

  return docs;
}

function toBulkOps(docs = []) {
  return docs.map((doc) => ({
    updateOne: {
      filter: { tmdbId: doc.tmdbId, isTV: doc.isTV },
      update: { $set: doc },
      upsert: true
    }
  }));
}

async function syncTmdbCatalog(options = {}) {
  const movieRecentPages = Math.min(Math.max(parseInt(options.movieRecentPages, 10) || DEFAULT_RECENT_PAGES, 1), 15);
  const moviePopularPages = Math.min(Math.max(parseInt(options.moviePopularPages, 10) || DEFAULT_POPULAR_PAGES, 1), 15);
  const tvRecentPages = Math.min(Math.max(parseInt(options.tvRecentPages, 10) || DEFAULT_RECENT_PAGES, 1), 15);
  const tvPopularPages = Math.min(Math.max(parseInt(options.tvPopularPages, 10) || DEFAULT_POPULAR_PAGES, 1), 15);

  const stats = {
    fetched: 0,
    uniquePrepared: 0,
    upserted: 0,
    matched: 0,
    modified: 0,
    syncedAt: new Date().toISOString()
  };

  const [movieRecent, moviePopular, tvRecent, tvPopular] = await Promise.all([
    fetchDiscoverBatch('movie', 'primary_release_date.desc', movieRecentPages),
    fetchDiscoverBatch('movie', 'popularity.desc', moviePopularPages),
    fetchDiscoverBatch('tv', 'first_air_date.desc', tvRecentPages),
    fetchDiscoverBatch('tv', 'popularity.desc', tvPopularPages)
  ]);

  const merged = new Map();
  const allDocs = [...movieRecent, ...moviePopular, ...tvRecent, ...tvPopular];
  stats.fetched = allDocs.length;

  allDocs.forEach((doc) => {
    const key = `${doc.isTV ? 'tv' : 'movie'}:${doc.tmdbId}`;
    const existing = merged.get(key);

    if (!existing || Number(doc.popularity || 0) > Number(existing.popularity || 0)) {
      merged.set(key, doc);
    }
  });

  const uniqueDocs = Array.from(merged.values());
  stats.uniquePrepared = uniqueDocs.length;

  if (!uniqueDocs.length) {
    return stats;
  }

  const result = await Movie.bulkWrite(toBulkOps(uniqueDocs), { ordered: false });
  stats.upserted = Number(result?.upsertedCount || 0);
  stats.matched = Number(result?.matchedCount || 0);
  stats.modified = Number(result?.modifiedCount || 0);

  return stats;
}

async function runSyncOnce(trigger = 'manual', logger = console) {
  if (isSyncRunning) {
    return { skipped: true, reason: 'Sync already in progress', trigger };
  }

  isSyncRunning = true;
  const startedAt = Date.now();

  try {
    const stats = await syncTmdbCatalog();
    const durationMs = Date.now() - startedAt;
    logger.log(`[TMDB Sync] ${trigger} completed in ${durationMs}ms (fetched: ${stats.fetched}, upserted: ${stats.upserted}, modified: ${stats.modified}).`);
    return { ...stats, trigger, durationMs };
  } catch (error) {
    logger.error(`[TMDB Sync] ${trigger} failed: ${error.message}`);
    throw error;
  } finally {
    isSyncRunning = false;
  }
}

function startTmdbAutoSync(logger = console) {
  if (autoSyncHandle) {
    return;
  }

  if (!AUTO_SYNC_ENABLED) {
    logger.log('[TMDB Sync] Auto sync is disabled by TMDB_AUTO_SYNC_ENABLED=false.');
    return;
  }

  if (!String(process.env.TMDB_API_KEY || '').trim()) {
    logger.warn('[TMDB Sync] TMDB_API_KEY is missing; auto sync skipped.');
    return;
  }

  const intervalMs = AUTO_SYNC_MINUTES * 60 * 1000;

  if (AUTO_SYNC_RUN_ON_START) {
    runSyncOnce('startup', logger).catch(() => {});
  }

  autoSyncHandle = setInterval(() => {
    runSyncOnce('interval', logger).catch(() => {});
  }, intervalMs);

  if (typeof autoSyncHandle.unref === 'function') {
    autoSyncHandle.unref();
  }

  logger.log(`[TMDB Sync] Auto sync scheduled every ${AUTO_SYNC_MINUTES} minutes.`);
}

function stopTmdbAutoSync() {
  if (!autoSyncHandle) return;
  clearInterval(autoSyncHandle);
  autoSyncHandle = null;
}

module.exports = {
  syncTmdbCatalog,
  runSyncOnce,
  startTmdbAutoSync,
  stopTmdbAutoSync
};
