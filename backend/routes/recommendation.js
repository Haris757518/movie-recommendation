const express = require('express');
const User = require('../models/User');
const Movie = require('../models/Movie');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const PROJECTION = '-_id tmdbId title language langCode genre year rating popularity posterUrl backdropUrl description isTV';

// ─── helpers ────────────────────────────────────────────────────────────────

function parseLangCode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'all') return null;
  return value;
}

/**
 * Fetch the best N items from the DB with automatic quality/recency relaxation.
 * Tries strict → relaxed → no-recency in sequence so we never return an empty row.
 */
async function fetchWithFallback({ filter, projection, sort, limit }) {
  // Strict pass
  let results = await Movie.find(filter)
    .select(projection)
    .sort(sort)
    .limit(limit)
    .lean();

  if (results.length >= 6) return results;

  // Relax recency: extend to 6 years back
  const relaxed = { ...filter };
  if (relaxed.year?.$gte) relaxed.year = { $gte: relaxed.year.$gte - 4 };

  results = await Movie.find(relaxed)
    .select(projection)
    .sort(sort)
    .limit(limit)
    .lean();

  if (results.length >= 4) return results;

  // Last resort: drop year constraint entirely but keep quality floor
  const bare = { ...relaxed };
  delete bare.year;
  if (bare.rating?.$gte > 5) bare.rating = { $gte: 5 };

  return Movie.find(bare).select(projection).sort(sort).limit(limit).lean();
}

// ─── GET /top-now ────────────────────────────────────────────────────────────

router.get('/top-now', async (req, res) => {
  try {
    const type = String(req.query.type || 'movie').toLowerCase();
    const isTV = type === 'tv' || type === 'series';
    const langCode = parseLangCode(req.query.language);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20);
    const nowYear = new Date().getFullYear();

    const baseFilter = {
      isTV: Boolean(isTV),
      year: { $gte: nowYear - 1 },
      rating: { $gte: 6 },
      posterUrl: { $exists: true, $ne: '' }
    };

    if (langCode) baseFilter.langCode = langCode;

    let usedLanguageFallback = false;

    const movies = await fetchWithFallback({
      filter: baseFilter,
      projection: PROJECTION,
      sort: { year: -1, popularity: -1, rating: -1 },
      limit
    });

    // If language-filtered and still thin, drop the language constraint
    if (movies.length < 4 && langCode) {
      usedLanguageFallback = true;
      const fallback = {
        isTV: Boolean(isTV),
        year: { $gte: nowYear - 4 },
        rating: { $gte: 5.5 },
        posterUrl: { $exists: true, $ne: '' }
      };
      const fallbackMovies = await Movie.find(fallback)
        .select(PROJECTION)
        .sort({ popularity: -1, rating: -1, year: -1 })
        .limit(limit)
        .lean();

      return res.json({
        meta: { type: isTV ? 'tv' : 'movie', language: 'all', count: fallbackMovies.length, usedLanguageFallback },
        movies: fallbackMovies
      });
    }

    return res.json({
      meta: { type: isTV ? 'tv' : 'movie', language: langCode || 'all', count: movies.length, usedLanguageFallback },
      movies
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load top now rows', error: error.message });
  }
});

// ─── user signal extraction ──────────────────────────────────────────────────

async function getUserSignals(user) {
  const preferredLanguages = Array.isArray(user.preferredLanguages)
    ? user.preferredLanguages.filter(Boolean)
    : [];

  const ratingsObj = user.ratings instanceof Map
    ? Object.fromEntries(user.ratings)
    : (user.ratings || {});

  const likedIds = Object.keys(ratingsObj)
    .filter((id) => Number(ratingsObj[id]) >= 4)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  const watchlistIds = Array.isArray(user.watchlist)
    ? user.watchlist.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];

  const seedIds = Array.from(new Set([...likedIds, ...watchlistIds]));

  const seedMovies = seedIds.length
    ? await Movie.find({ tmdbId: { $in: seedIds } }).select('tmdbId genre langCode').lean()
    : [];

  const genreWeights = new Map();
  seedMovies.forEach((movie) => {
    const weight = Number(ratingsObj[String(movie.tmdbId)] || 4);
    (movie.genre || []).forEach((genre) => {
      genreWeights.set(genre, (genreWeights.get(genre) || 0) + weight);
    });
  });

  const topGenres = [...genreWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([genre]) => genre);

  return { preferredLanguages, ratingsObj, likedIds, watchlistIds, seedIds, topGenres };
}

// ─── scoring ─────────────────────────────────────────────────────────────────

function scoreCandidates(candidates, preferredLanguages, topGenres) {
  const currentYear = new Date().getFullYear();
  return candidates.map((movie) => {
    let score = 0;
    if (preferredLanguages.includes(movie.langCode)) score += 20;
    const genreMatchCount = (movie.genre || []).filter((g) => topGenres.includes(g)).length;
    score += genreMatchCount * 18;
    score += Math.min(25, Number(movie.popularity || 0) * 0.08);
    score += Number(movie.rating || 0) * 2.5;
    const age = movie.year ? Math.max(0, currentYear - Number(movie.year)) : 12;
    score += Math.max(0, 10 - age * 0.9);
    return { ...movie, recScore: Number(score.toFixed(2)) };
  });
}

// ─── GET /:userId — personalised recommendations ─────────────────────────────

router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.userId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { preferredLanguages, seedIds, topGenres } = await getUserSignals(user);

    const filter = {
      rating: { $gte: 5 },
      popularity: { $gt: 8 },
      tmdbId: { $nin: seedIds }
    };

    if (preferredLanguages.length) {
      filter.langCode = { $in: preferredLanguages };
    }

    const candidates = await Movie.find(filter)
      .select(PROJECTION)
      .sort({ popularity: -1 })
      .limit(500)
      .lean();

    const scored = scoreCandidates(candidates, preferredLanguages, topGenres);
    scored.sort((a, b) => b.recScore - a.recScore || Number(b.popularity || 0) - Number(a.popularity || 0));

    return res.json({
      meta: { preferredLanguages, inferredGenres: topGenres, basedOn: seedIds.length },
      movies: scored.slice(0, 20)
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to generate recommendations', error: error.message });
  }
});

// ─── GET /:userId/home — full home feed ──────────────────────────────────────
//
// Key improvements:
//  • Separate "Popular Movies" and "Popular Series" rows per language
//  • Watchlist / continue-watching rows skipped when empty (no black spots)
//  • All rows guaranteed non-empty via fetchWithFallback
//  • becauseYouLiked falls back to popular-in-language if seed is empty

router.get('/:userId/home', authMiddleware, async (req, res) => {
  try {
    if (String(req.user.id) !== String(req.params.userId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { preferredLanguages, seedIds, topGenres } = await getUserSignals(user);
    const nowYear = new Date().getFullYear();

    // ── 1. Per-language rows: Movies + Series separately ───────────────────
    //    For each preferred language, produce two rows.
    const langRows = {};

    await Promise.all(
      preferredLanguages.slice(0, 4).map(async (lang) => {
        const langLabel = lang.toUpperCase();

        // Movies row
        const movieFilter = {
          langCode: lang,
          isTV: false,
          rating: { $gte: 5 },
          posterUrl: { $exists: true, $ne: '' }
        };
        const movieResults = await fetchWithFallback({
          filter: movieFilter,
          projection: PROJECTION,
          sort: { popularity: -1, rating: -1, year: -1 },
          limit: 20
        });

        // Series row
        const seriesFilter = {
          langCode: lang,
          isTV: true,
          rating: { $gte: 4 },
          posterUrl: { $exists: true, $ne: '' }
        };
        const seriesResults = await fetchWithFallback({
          filter: seriesFilter,
          projection: PROJECTION,
          sort: { popularity: -1, rating: -1, year: -1 },
          limit: 20
        });

        langRows[`movies_${lang}`] = {
          title: `🎬 Popular ${langLabel} Movies`,
          reason: 'language_movies',
          lang,
          movies: movieResults.map(normalise)
        };

        langRows[`series_${lang}`] = {
          title: `📺 Popular ${langLabel} Series`,
          reason: 'language_series',
          lang,
          movies: seriesResults.map(normalise)
        };
      })
    );

    // ── 2. Because you liked (genre-based) ─────────────────────────────────
    const becauseGenre = topGenres[0] || null;
    let becauseYouLiked = { title: null, movies: [] };

    if (becauseGenre) {
      const genreFilter = {
        genre: becauseGenre,
        rating: { $gte: 5 },
        popularity: { $gt: 8 },
        tmdbId: { $nin: seedIds },
        posterUrl: { $exists: true, $ne: '' }
      };
      if (preferredLanguages.length) genreFilter.langCode = { $in: preferredLanguages };

      const genreResults = await fetchWithFallback({
        filter: genreFilter,
        projection: PROJECTION,
        sort: { popularity: -1, rating: -1 },
        limit: 20
      });

      if (genreResults.length > 0) {
        becauseYouLiked = {
          title: `🔥 Because You Like ${becauseGenre}`,
          reason: 'genre_match',
          movies: genreResults.map(normalise)
        };
      }
    }

    // ── 3. New for you (latest across preferred languages) ─────────────────
    const newForYouFilter = {
      rating: { $gte: 5 },
      year: { $gte: nowYear - 3 },
      tmdbId: { $nin: seedIds },
      posterUrl: { $exists: true, $ne: '' }
    };
    if (preferredLanguages.length) newForYouFilter.langCode = { $in: preferredLanguages };

    const newResults = await fetchWithFallback({
      filter: newForYouFilter,
      projection: PROJECTION,
      sort: { year: -1, popularity: -1 },
      limit: 20
    });

    const newForYou = {
      title: '🆕 New for You',
      reason: 'recency',
      movies: newResults.map(normalise)
    };

    // ── 4. Trending (global or language-weighted) ──────────────────────────
    const trendingFilter = {
      rating: { $gte: 5 },
      popularity: { $gt: 10 },
      year: { $gte: nowYear - 2 },
      posterUrl: { $exists: true, $ne: '' }
    };
    // Slightly prefer user languages but don't restrict — trending should feel broad
    const trendingResults = await Movie.find(trendingFilter)
      .select(PROJECTION)
      .sort({ popularity: -1, rating: -1, year: -1 })
      .limit(20)
      .lean();

    // Boost preferred-language items to the front
    const trendingScored = trendingResults.map((m) => ({
      ...m,
      _boost: preferredLanguages.includes(m.langCode) ? 1 : 0
    }));
    trendingScored.sort((a, b) => b._boost - a._boost || Number(b.popularity || 0) - Number(a.popularity || 0));

    const trending = {
      title: '🔥 Trending Now',
      reason: 'trending',
      movies: trendingScored.map(normalise)
    };

    // ── 5. Assemble rows — skip empty ones so UI has no black spots ─────────
    const rows = {};

    // Per-language movies/series rows first
    for (const [key, row] of Object.entries(langRows)) {
      if (row.movies.length > 0) rows[key] = row;
    }

    // Genre/interest rows
    if (becauseYouLiked.movies.length > 0) rows.becauseYouLiked = becauseYouLiked;
    if (newForYou.movies.length > 0) rows.newForYou = newForYou;
    if (trending.movies.length > 0) rows.trending = trending;

    return res.json({ rows });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to build home feed', error: error.message });
  }
});

// ── helper: normalise backend doc to frontend shape ──────────────────────────
function normalise(m) {
  return m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m;
}

module.exports = router;