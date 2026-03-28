const express = require('express');
const NodeCache = require('node-cache');
const Movie = require('../models/Movie');

const router = express.Router();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
const MOVIE_PROJECTION = '-_id tmdbId title language langCode genre year rating popularity posterUrl isTV';
const SEARCH_STOP_WORDS = new Set(['actor', 'actress', 'name', 'movie', 'movies', 'series', 'show', 'shows', 'film', 'films']);

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeIMDBScore(movie) {
  const rating = Number(movie?.rating || 0);
  const popularity = Number(movie?.popularity || 0);
  return Number((rating * 0.7 + Math.log10(popularity + 1) * 3).toFixed(4));
}

function normalizeSearchTokens(query) {
  const raw = String(query || '')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);

  const cleaned = raw.filter((t) => !SEARCH_STOP_WORDS.has(t));
  return cleaned.length ? cleaned.slice(0, 6) : raw.slice(0, 6);
}

function getPersonSearchVariants(query, preferActor = false) {
  const base = String(query || '').trim();
  if (!base) return [];

  const variants = [base];
  const tokens = normalizeSearchTokens(base);
  const key = tokens.length === 1 ? tokens[0] : '';

  const aliasMap = {
    vijay: ['thalapathy vijay', 'joseph vijay']
  };

  if (key && aliasMap[key]) {
    variants.push(...aliasMap[key]);
  }

  if (preferActor && tokens.length === 1 && key && !aliasMap[key]) {
    variants.push(`${base} actor`);
  }

  return Array.from(new Set(variants)).slice(0, 3);
}

async function fetchTmdbActorKnownForIds(query, type = 'all', maxItems = 24, preferActor = false) {
  const apiKey = String(process.env.TMDB_API_KEY || '').trim();
  if (!apiKey || typeof fetch !== 'function') return [];

  try {
    const variants = getPersonSearchVariants(query, preferActor);
    if (!variants.length) return [];

    const peopleMap = new Map();

    for (const variant of variants) {
      const url = new URL('https://api.themoviedb.org/3/search/person');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('query', variant);
      url.searchParams.set('include_adult', 'false');
      url.searchParams.set('page', '1');

      const res = await fetch(url.toString());
      if (!res.ok) continue;

      const data = await res.json();
      const people = Array.isArray(data?.results) ? data.results.slice(0, 8) : [];

      people.forEach((person) => {
        const personId = Number(person?.id || 0);
        if (!Number.isFinite(personId) || personId <= 0) return;

        const prev = peopleMap.get(personId);
        const popularity = Number(person?.popularity || 0);
        if (!prev || popularity > Number(prev?.popularity || 0)) {
          peopleMap.set(personId, person);
        }
      });
    }

    const people = Array.from(peopleMap.values())
      .sort((a, b) => {
        const aActing = String(a?.known_for_department || '').toLowerCase() === 'acting' ? 1 : 0;
        const bActing = String(b?.known_for_department || '').toLowerCase() === 'acting' ? 1 : 0;
        if (bActing !== aActing) return bActing - aActing;
        return Number(b?.popularity || 0) - Number(a?.popularity || 0);
      })
      .slice(0, 8);

    if (!people.length) return [];

    const merged = new Map();

    people.forEach((person, personIndex) => {
      const personPopularity = Number(person?.popularity || 0);
      const knownFor = Array.isArray(person?.known_for) ? person.known_for : [];

      knownFor.forEach((media, mediaIndex) => {
        const tmdbId = Number(media?.id || 0);
        if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;

        const mediaType = String(media?.media_type || '').toLowerCase();
        const isTV = mediaType === 'tv';
        if (type === 'movie' && isTV) return;
        if ((type === 'tv' || type === 'series') && !isTV) return;

        const key = `${isTV ? 'tv' : 'movie'}:${tmdbId}`;
        const mediaPopularity = Number(media?.popularity || 0);
        const rankScore = personPopularity * 0.8 + mediaPopularity * 0.6 + (20 - personIndex * 2 - mediaIndex);

        const prev = merged.get(key);
        if (!prev || rankScore > prev.rankScore) {
          merged.set(key, { id: tmdbId, isTV, rankScore });
        }
      });
    });

    return Array.from(merged.values())
      .sort((a, b) => Number(b.rankScore || 0) - Number(a.rankScore || 0))
      .slice(0, maxItems);
  } catch (_error) {
    return [];
  }
}

router.get('/meta/genres', async (_req, res) => {
  try {
    const cacheKey = 'meta:genres';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const data = await Movie.aggregate([
      { $match: { genre: { $exists: true, $ne: [] } } },
      { $unwind: '$genre' },
      { $group: { _id: '$genre', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    cache.set(cacheKey, data);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load genre metadata', error: error.message });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || req.query.search || '').trim();
    if (query.length < 2) return res.json([]);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 25);
    const type = String(req.query.type || 'all').toLowerCase();
    const cacheKey = `movies:search:${type}:${limit}:${query.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const baseFilter = {
      posterUrl: { $exists: true, $ne: '' },
      genre: { $nin: ['Soap', 'News', 'Talk', 'Reality'] }
    };

    if (type === 'tv' || type === 'series') {
      baseFilter.isTV = true;
    } else if (type === 'movie') {
      baseFilter.isTV = false;
    }

    const tokens = normalizeSearchTokens(query);
    const actorIntent = /\b(actor|actress|star|hero|cast|name)\b/i.test(query);

    const regexClauses = [];
    const phraseRegex = new RegExp(escapeRegex(query), 'i');
    regexClauses.push(
      { title: phraseRegex },
      { description: phraseRegex },
      { cast: phraseRegex }
    );

    tokens.forEach((token) => {
      const tokenRegex = new RegExp(escapeRegex(token), 'i');
      regexClauses.push(
        { title: tokenRegex },
        { description: tokenRegex },
        { cast: tokenRegex }
      );
    });

    const rawResults = await Movie.find({
      ...baseFilter,
      $or: regexClauses
    })
      .select('-_id tmdbId title language langCode genre year rating popularity posterUrl isTV cast description')
      .sort({ popularity: -1, rating: -1, year: -1 })
      .limit(Math.max(limit * 3, 18))
      .lean();

    const lowerQuery = query.toLowerCase();
    const lowerTokens = tokens.map((t) => t.toLowerCase());

    let scored = rawResults
      .map((movie) => {
        const title = String(movie.title || '').toLowerCase();
        const description = String(movie.description || '').toLowerCase();
        const castEntries = Array.isArray(movie.cast) ? movie.cast : [];
        const castText = castEntries.map((c) => String(c || '').toLowerCase()).join(' ');

        let score = 0;
        if (title === lowerQuery) score += 500;
        else if (title.startsWith(lowerQuery)) score += 280;
        else if (title.includes(lowerQuery)) score += 160;

        if (description.includes(lowerQuery)) score += 25;
        if (castEntries.some((c) => String(c || '').toLowerCase().includes(lowerQuery))) score += 40;

        lowerTokens.forEach((token) => {
          if (!token) return;
          if (title.includes(token)) score += 55;
          if (castText.includes(token)) score += 75;
          if (description.includes(token)) score += 12;
        });

        score += Number(movie.popularity || 0) * 0.22;
        score += Number(movie.rating || 0) * 4;
        score += Math.max(0, Number(movie.year || 0) - 1990) * 0.25;

        return {
          tmdbId: movie.tmdbId,
          title: movie.title,
          language: movie.language,
          langCode: movie.langCode,
          genre: movie.genre,
          year: movie.year,
          rating: movie.rating,
          popularity: movie.popularity,
          posterUrl: movie.posterUrl,
          isTV: Boolean(movie.isTV),
          _searchScore: score
        };
      })
      .sort((a, b) => Number(b._searchScore || 0) - Number(a._searchScore || 0))
      .slice(0, limit)
      .map(({ _searchScore, ...movie }) => movie);

    // Actor-name assist: cast fields are sparse in many records, so use TMDB person known_for
    // to prioritize relevant DB titles for queries like "vijay actor name".
    if (actorIntent || tokens.length <= 2 || scored.length < limit) {
      const tmdbCandidates = await fetchTmdbActorKnownForIds(query, type, Math.max(limit * 4, 24), actorIntent);
      if (tmdbCandidates.length) {
        const candidateIds = tmdbCandidates.map((c) => Number(c.id)).filter(Number.isFinite);
        if (candidateIds.length) {
          const dbMatches = await Movie.find({
            ...baseFilter,
            tmdbId: { $in: candidateIds }
          })
            .select('-_id tmdbId title language langCode genre year rating popularity posterUrl isTV')
            .lean();

          const ranked = new Map(tmdbCandidates.map((item, idx) => [`${item.isTV ? 'tv' : 'movie'}:${item.id}`, idx]));
          const assisted = dbMatches
            .filter((m) => {
              if (type === 'movie' && m.isTV) return false;
              if ((type === 'tv' || type === 'series') && !m.isTV) return false;
              return true;
            })
            .map((m) => ({
              ...m,
              _rank: Number(ranked.get(`${m.isTV ? 'tv' : 'movie'}:${m.tmdbId}`) ?? 9999)
            }))
            .sort((a, b) => Number(a._rank || 9999) - Number(b._rank || 9999) || Number(b.popularity || 0) - Number(a.popularity || 0))
            .map(({ _rank, ...m }) => m);

          const merged = [];
          const seen = new Set();
          const pushUnique = (item) => {
            const id = Number(item?.tmdbId);
            if (!Number.isFinite(id) || seen.has(id)) return;
            seen.add(id);
            merged.push(item);
          };

          const assistFirstCount = actorIntent ? Math.min(8, limit) : Math.min(4, limit);
          assisted.slice(0, assistFirstCount).forEach(pushUnique);
          scored.forEach(pushUnique);
          assisted.slice(assistFirstCount).forEach(pushUnique);

          scored = merged.slice(0, limit);
        }
      }
    }

    cache.set(cacheKey, scored, 45);
    return res.json(scored);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to search movies', error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 120);
    const skip = (page - 1) * limit;
    const cacheKey = `movies:${JSON.stringify(req.query)}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Build filter
    const filter = {};

    // ── Language ────────────────────────────────────────────────────────────
    // Accept both langCode (2-letter, e.g. "ta") AND full display name (e.g. "Tamil")
    if (req.query.language && req.query.language !== 'all') {
      const rawLang = String(req.query.language).trim();
      // If it looks like a 2-letter code use it directly; otherwise treat as display name
      if (rawLang.length <= 3 && rawLang === rawLang.toLowerCase()) {
        filter.langCode = rawLang;
      } else {
        // Try exact match on langCode first, then fall back to language display name
        const DISPLAY_TO_CODE = {
          english: 'en', hindi: 'hi', tamil: 'ta', telugu: 'te', malayalam: 'ml',
          kannada: 'kn', bengali: 'bn', french: 'fr', spanish: 'es', german: 'de',
          italian: 'it', japanese: 'ja', korean: 'ko', russian: 'ru', chinese: 'zh',
          arabic: 'ar', portuguese: 'pt', thai: 'th', turkish: 'tr', vietnamese: 'vi',
          marathi: 'mr', punjabi: 'pa', gujarati: 'gu', odia: 'or', urdu: 'ur',
          sinhala: 'si', nepali: 'ne', burmese: 'my', indonesian: 'id', malay: 'ms',
          filipino: 'tl', dutch: 'nl', polish: 'pl', hebrew: 'he', persian: 'fa',
          ukrainian: 'uk', swedish: 'sv', danish: 'da', finnish: 'fi', norwegian: 'no'
        };
        const code = DISPLAY_TO_CODE[rawLang.toLowerCase()];
        if (code) {
          filter.langCode = code;
        } else {
          // Best-effort: match by stored language display field
          filter.language = new RegExp(`^${rawLang}$`, 'i');
        }
      }
    }

    // ── Type (movie / tv) ───────────────────────────────────────────────────
    if (req.query.type === 'tv') {
      filter.isTV = true;
    } else if (req.query.type === 'movie') {
      filter.isTV = false;
    }

    // ── IDs lookup ──────────────────────────────────────────────────────────
    if (req.query.ids && String(req.query.ids).trim()) {
      const ids = String(req.query.ids)
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isFinite(id));
      if (ids.length) {
        filter.tmdbId = { $in: ids };
      }
    }

    // ── Genre ───────────────────────────────────────────────────────────────
    if (req.query.genre && req.query.genre !== 'all') {
      const genres = String(req.query.genre)
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (genres.length === 1) {
        filter.genre = genres[0];
      } else if (genres.length > 1) {
        filter.genre = { $in: genres };
      }
    }

    // ── Full-text search ────────────────────────────────────────────────────
    if (req.query.search && String(req.query.search).trim()) {
      filter.$text = { $search: String(req.query.search).trim() };
    }

    // ── Year ────────────────────────────────────────────────────────────────
    if (req.query.year && req.query.year !== 'all') {
      const parsedYear = Number(req.query.year);
      if (Number.isFinite(parsedYear)) {
        filter.year = parsedYear;
      }
    } else {
      let minYear = null;

      if (req.query.latest === 'true') {
        minYear = 2022;
      }

      if (req.query.minYear) {
        const parsedMinYear = Number(req.query.minYear);
        if (Number.isFinite(parsedMinYear)) {
          minYear = minYear === null ? parsedMinYear : Math.max(minYear, parsedMinYear);
        }
      }

      if (minYear !== null) {
        filter.year = { $gte: minYear };
      }
    }

    // ── Min Rating ──────────────────────────────────────────────────────────
    if (req.query.minRating) {
      const parsedMinRating = Number(req.query.minRating);
      if (Number.isFinite(parsedMinRating)) {
        filter.rating = { $gte: parsedMinRating };
      }
    }

    const sortMode = String(req.query.sort || 'trending').toLowerCase();

    // Exclude soap operas, news, talk shows — merge with existing genre filter using $and
    if (filter.genre) {
      // Already have a genre filter — wrap both in $and
      filter.$and = [
        { genre: filter.genre },
        { genre: { $nin: ['Soap', 'News', 'Talk', 'Reality'] } }
      ];
      delete filter.genre;
    } else {
      filter.genre = { $nin: ['Soap', 'News', 'Talk', 'Reality'] };
    }

    // For popularity/trending default sorts, constrain recency only when NO language is specified
    // (language-specific catalogs like Tamil/Telugu need full date range)
    const hasLangFilter = Boolean(filter.langCode || filter.language);
    if ((sortMode === 'trending') && !filter.year && !hasLangFilter) {
      filter.year = { $gte: new Date().getFullYear() - 3 };
    }

    if (!req.query.minRating && (sortMode === 'trending' || sortMode === 'imdb' || sortMode === 'top_rated' || sortMode === 'rating' || sortMode === 'underrated')) {
      filter.rating = { $gte: 4 };
    }

    filter.posterUrl = { $exists: true, $ne: '' };

    // ── Build sort & query ──────────────────────────────────────────────────
    let movies;

    if (sortMode === 'upcoming') {
      // Upcoming: include current and future year. If sparse (common in regional catalogs),
      // backfill with recent titles so users still see a meaningful list.
      const currentYear = new Date().getFullYear();
      const upcomingFilter = { ...filter };
      delete upcomingFilter.rating;

      const hasExplicitYear = Boolean(req.query.year && req.query.year !== 'all');
      const targetCount = skip + limit;

      if (hasExplicitYear) {
        movies = await Movie.find(upcomingFilter)
          .select(MOVIE_PROJECTION)
          .sort({ year: 1, popularity: -1 })
          .skip(skip)
          .limit(limit)
          .lean();
      } else {
        const primaryFilter = { ...upcomingFilter, year: { $gte: currentYear } };
        const primary = await Movie.find(primaryFilter)
          .select(MOVIE_PROJECTION)
          .sort({ year: 1, popularity: -1 })
          .limit(targetCount)
          .lean();

        let merged = [...primary];
        if (merged.length < targetCount) {
          const seen = new Set(merged.map((m) => Number(m.tmdbId)).filter(Number.isFinite));
          const backfillFilter = { ...upcomingFilter, year: { $gte: currentYear - 2 } };

          const backfill = await Movie.find(backfillFilter)
            .select(MOVIE_PROJECTION)
            .sort({ year: -1, popularity: -1, rating: -1 })
            .limit(Math.max(targetCount * 2, 60))
            .lean();

          for (const item of backfill) {
            const id = Number(item.tmdbId);
            if (!Number.isFinite(id) || seen.has(id)) continue;
            seen.add(id);
            merged.push(item);
            if (merged.length >= targetCount) break;
          }
        }

        movies = merged.slice(skip, skip + limit);
      }
    } else if (sortMode === 'trending') {
      const pipeline = [
        { $match: filter },
        {
          $addFields: {
            trendingScore: {
              $add: [
                { $multiply: ['$popularity', 0.5] },
                { $multiply: ['$rating', 8] },
                { $multiply: [{ $subtract: [{ $ifNull: ['$year', 2000] }, 2000] }, 3] }
              ]
            }
          }
        },
        { $sort: { trendingScore: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: 0, tmdbId: 1, title: 1, language: 1, langCode: 1, genre: 1,
            year: 1, rating: 1, popularity: 1, posterUrl: 1, isTV: 1
          }
        }
      ];
      movies = await Movie.aggregate(pipeline).exec();
    } else if (sortMode === 'imdb' || sortMode === 'top_rated') {
      const candidateLimit = Math.max(limit * 8 + skip, 120);
      const raw = await Movie.find(filter)
        .select(MOVIE_PROJECTION)
        .sort({ popularity: -1, rating: -1, year: -1 })
        .limit(candidateLimit)
        .lean();

      raw.forEach((m) => {
        m.imdbScore = computeIMDBScore(m);
      });

      raw.sort((a, b) => Number(b.imdbScore || 0) - Number(a.imdbScore || 0));
      movies = raw.slice(skip, skip + limit);
    } else if (sortMode === 'rating') {
      // Pure rating sort — ordered strictly by vote average descending
      movies = await Movie.find(filter)
        .select(MOVIE_PROJECTION)
        .sort({ rating: -1, popularity: -1, year: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    } else if (sortMode === 'underrated') {
      const underratedFilter = {
        ...filter,
        rating: { $gte: 6, $lte: 7.5 }
      };

      movies = await Movie.find(underratedFilter)
        .select(MOVIE_PROJECTION)
        .sort({ rating: -1, popularity: -1, year: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    } else {
      const sortOption = {};
      if (filter.$text) {
        sortOption.score = { $meta: 'textScore' };
      } else if (sortMode === 'latest') {
        sortOption.year = -1;
        sortOption.popularity = -1;
      } else if (sortMode === 'rating') {
        sortOption.rating = -1;
        sortOption.popularity = -1;
        sortOption.year = -1;
      } else if (sortMode === 'year') {
        sortOption.year = -1;
        sortOption.popularity = -1;
        sortOption.rating = -1;
      } else if (sortMode === 'title') {
        sortOption.title = 1;
      } else {
        // trending/popularity (default)
        sortOption.popularity = -1;
        sortOption.rating = -1;
        sortOption.year = -1;
      }

      const query = Movie.find(filter);
      query.select(MOVIE_PROJECTION);
      if (filter.$text) {
        query.select({ score: { $meta: 'textScore' } });
      }

      movies = await query
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean();

      // ── TV fallback: if language-specific TV is empty, try relaxing recency ──
      if (filter.isTV === true && (!movies || movies.length === 0)) {
        const relaxedFilter = {
          isTV: true,
          posterUrl: { $exists: true, $ne: '' },
          rating: { $gte: 4 },
          genre: { $nin: ['Soap', 'News', 'Talk', 'Reality'] }
        };
        if (filter.langCode) relaxedFilter.langCode = filter.langCode;
        if (filter.language) relaxedFilter.language = filter.language;

        movies = await Movie.find(relaxedFilter)
          .select(MOVIE_PROJECTION)
          .sort({ popularity: -1, rating: -1, year: -1 })
          .limit(Math.max(limit, 12))
          .lean();
      }
    }

    cache.set(cacheKey, movies);
    return res.json(movies);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch movies', error: error.message });
  }
});

router.post('/bulk', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : req.body.movies;
    if (!Array.isArray(payload) || payload.length === 0) {
      return res.status(400).json({ message: 'movies array is required' });
    }

    const ops = payload
      .filter((item) => Number.isFinite(Number(item.tmdbId)))
      .map((item) => ({
        updateOne: {
          filter: { tmdbId: Number(item.tmdbId) },
          update: {
            $set: {
              tmdbId: Number(item.tmdbId),
              title: item.title || 'Untitled',
              language: item.language || 'Unknown',
              langCode: item.langCode || '',
              genre: Array.isArray(item.genre) ? item.genre : [],
              year: Number.isFinite(Number(item.year)) ? Number(item.year) : null,
              rating: Number(item.rating) || 0,
              popularity: Number(item.popularity) || 0,
              posterUrl: item.posterUrl || '',
              backdropUrl: item.backdropUrl || '',
              description: item.description || '',
              isTV: Boolean(item.isTV)
            }
          },
          upsert: true
        }
      }));

    if (!ops.length) {
      return res.status(400).json({ message: 'No valid movies with tmdbId provided' });
    }

    const result = await Movie.bulkWrite(ops, { ordered: false });
    return res.status(201).json({
      message: 'Bulk import completed',
      insertedOrUpdated: ops.length,
      result
    });
  } catch (error) {
    return res.status(500).json({ message: 'Bulk import failed', error: error.message });
  }
});

module.exports = router;