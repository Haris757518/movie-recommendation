// ==========================================================
// CinemaWorld – script.js v3 (Full Revamp)
// Fixes: separate Movies/Series pages, language-based Top 10,
// square mini-cards, nav highlighting, back navigation fix,
// actor filmography click fix, trailers, inline rate & review
// Reg: 24BIT0468 | Haris K | BITE304L
// ==========================================================

'use strict';

/* ===================================================
   API BASE RESOLUTION (Local + Production)
   =================================================== */
const LOCAL_API_BASE = 'http://localhost:5000/api';

function normalizeApiBase(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash.endsWith('/api')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/api`;
}

function resolveApiBase() {
  const configured = normalizeApiBase(window.CINEMA_API_BASE || '');
  if (configured) return configured;

  const host = String(window.location.hostname || '').trim();
  const isFileProtocol = window.location.protocol === 'file:';
  const isLocal = isFileProtocol || !host || ['localhost', '127.0.0.1'].includes(host);
  return isLocal ? LOCAL_API_BASE : 'https://movie-recommendation-bkup.onrender.com/api';
}

const API_BASE = resolveApiBase();
window.__API_BASE__ = API_BASE;

function rewriteApiUrl(input) {
  if (typeof input !== 'string') return input;

  const localOrigin = 'http://localhost:5000';
  if (input.startsWith(LOCAL_API_BASE)) {
    return `${API_BASE}${input.slice(LOCAL_API_BASE.length)}`;
  }

  if (input.startsWith(`${localOrigin}/api`)) {
    return `${API_BASE}${input.slice(`${localOrigin}/api`.length)}`;
  }

  if (input.startsWith('/api')) {
    return `${API_BASE}${input.slice(4)}`;
  }

  return input;
}

const nativeFetch = window.fetch.bind(window);
window.fetch = function wrappedFetch(input, init) {
  if (typeof input === 'string') {
    return nativeFetch(rewriteApiUrl(input), init);
  }

  if (input instanceof Request) {
    const rewrittenUrl = rewriteApiUrl(input.url);
    if (rewrittenUrl !== input.url) {
      return nativeFetch(new Request(rewrittenUrl, input), init);
    }
  }

  return nativeFetch(input, init);
};

/* ===================================================
   STATE
   =================================================== */
let allMovies = [];
let allSeries = [];
let filteredMovies = [];
let filteredSeries = [];
let searchTimeout;
let currentRating = 0;
let currentDetailRating = 0;
let currentDetailMovieId = null;
let currentDetailIsTV = false;
let currentApiPage = 1;
let isLoadingMore = false;
let navigationHistory = [];
let homeRowsLoaded = false;
let homeSectionObserver = null;
let currentMoviesAbortController = null;
let homePrefetchTimer = 0;
const homeCache = {};
const providerPreviewCache = {};
let currentUser = null;
let authToken = localStorage.getItem('authToken') || '';
let authMode = 'login';
let trailerPrefetchObserver = null;
let searchAbortController = null;
let searchRequestToken = 0;

// Page state: 'home' | 'movies' | 'series' | 'detail'
let currentPage = 'home';
let previousPage = 'home'; // tracks where we came from for back nav

const pageSelectionState = {
  home: null,
  movies: null,
  series: null
};

const PAGE_FILTER_IDS = {
  home: ['genreFilter', 'languageFilter', 'yearFilter', 'sortFilter', 'searchInput'],
  movies: ['moviesLangFilter', 'moviesGenreFilter', 'moviesYearFilter', 'moviesSortFilter'],
  series: ['seriesLangFilter', 'seriesGenreFilter', 'seriesYearFilter', 'seriesSortFilter']
};

function snapshotFiltersForPage(page) {
  const ids = PAGE_FILTER_IDS[page] || [];
  if (!ids.length) return null;

  return ids.reduce((acc, id) => {
    const el = document.getElementById(id);
    if (el) acc[id] = el.value;
    return acc;
  }, {});
}

function restoreFiltersForPage(page, filters) {
  if (!filters || typeof filters !== 'object') return;

  Object.entries(filters).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (!el || value == null) return;
    el.value = value;
  });
}

function capturePageSelectionState(page = currentPage) {
  if (!Object.prototype.hasOwnProperty.call(pageSelectionState, page)) return;

  pageSelectionState[page] = {
    scrollY: Math.max(0, Number(window.scrollY || window.pageYOffset || 0)),
    filters: snapshotFiltersForPage(page)
  };
}

function hasPageSelectionState(page) {
  return Boolean(pageSelectionState[page]);
}

function restorePageSelectionState(page) {
  const snapshot = pageSelectionState[page];
  if (!snapshot) return;

  restoreFiltersForPage(page, snapshot.filters);
  const targetScroll = Math.max(0, Number(snapshot.scrollY || 0));

  requestAnimationFrame(() => {
    window.scrollTo({ top: targetScroll, left: 0, behavior: 'auto' });
  });
}

const DEBOUNCE_DELAY = 250;
const ITEM_HEIGHT = 280;
const BUFFER = 5;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_W780 = 'https://image.tmdb.org/t/p/w780';
const TMDB_IMG_ORIGINAL = 'https://image.tmdb.org/t/p/original';
const PLACEHOLDER = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect fill="%23111827" width="300" height="300"/><rect fill="%231e2d42" x="90" y="100" width="120" height="100" rx="8"/><polygon fill="%23374151" points="90,200 150,130 180,160 210,120 210,200"/><circle fill="%23374151" cx="120" cy="125" r="15"/></svg>';
const INITIAL_MOVIES_PAGES = 2;
const INITIAL_SERIES_PAGES = 4;
const INITIAL_ROW_DELAY_MS = 220;
const DEMO_SIMPLE_HOME = false;
const ENABLE_CARD_PROVIDER_PREVIEW = false;
const HOME_ROW_LIMIT = 12;
const API_LIST_LIMIT = 12;
const SEARCH_DROPDOWN_LIMIT = 10;
const GET_CACHE_TTL_MS = 15000;
const REQUEST_TIMEOUT_MS = 4500;
const DETAIL_BUNDLE_TIMEOUT_MS = 3500;
const TMDB_TIMEOUT_MS = 5000;
const inflightGetRequests = new Map();
const getResponseCache = new Map();

const SORT_OPTIONS = {
  trending: 'Trending',
  upcoming: 'Upcoming',
  imdb: 'Top Rated',
  underrated: 'Underrated'
};

const BRAND_FULL_FORM = 'House of Digital Kino';
const BRAND_SHORT = 'HDK';
const BRAND_TAGLINE = 'Find Your Next Obsession';

const THEME_BRAND_ICON = {
  dark: 'bi-film',
  neon: 'bi-lightning-charge-fill',
  stranger: 'bi-broadcast-pin',
  got: 'bi-fire',
  hp: 'bi-stars'
};

const THEME_CHARACTERS = {
  got: [
    { name: 'Daenerys', note: 'Mother of Dragons', main: '👸', side: '🐉', mood: 'fire', image: 'images/characters/got-daenerys.svg' },
    { name: 'Jon Snow', note: 'The North Remembers', main: '⚔️', side: '🐺', mood: 'ice', image: 'images/characters/got-jon.svg' },
    { name: 'Arya Stark', note: 'No One, All Skill', main: '🗡️', side: '🦅', mood: 'steel', image: 'images/characters/got-arya.svg' }
  ],
  stranger: [
    { name: 'Eleven', note: 'Mind-Power Selections', main: '🩸', side: '⚡', mood: 'psy', image: 'images/characters/stranger-eleven.svg' },
    { name: 'Vecna', note: 'Upside Down Zone', main: '🕷️', side: '🕳️', mood: 'void', image: 'images/characters/stranger-vecna.svg' },
    { name: 'Demogorgon', note: 'Darkest Watchlist', main: '🌸', side: '🔴', mood: 'rift', image: 'images/characters/stranger-demogorgon.svg' }
  ],
  hp: [
    { name: 'Harry', note: 'Chosen One Picks', main: '🧙', side: '✨', mood: 'spark', image: 'images/characters/hp-harry.svg' },
    { name: 'Hermione', note: 'Brilliant Favorites', main: '📚', side: '🪄', mood: 'wisdom', image: 'images/characters/hp-hermione.svg' },
    { name: 'Snape', note: 'Half-Blood Classics', main: '🧪', side: '🦌', mood: 'shadow', image: 'images/characters/hp-snape.svg' }
  ]
};

const THEME_IMMERSION = {
  stranger: {
    character: 'images/characters/stranger-eleven.svg',
    characterAlt: 'Eleven cinematic presence',
    dialogues: [
      'I can feel it...',
      'The Upside Down is close.',
      'He is here...'
    ],
    eventText: 'RUN.',
    sound: 'horror'
  },
  got: {
    character: 'images/characters/got-daenerys.svg',
    characterAlt: 'Daenerys cinematic presence',
    dialogues: [
      'Dracarys.',
      'Power is everything.',
      'A storm is coming.'
    ],
    eventText: 'FIRE.',
    sound: 'fire'
  },
  hp: {
    character: 'images/characters/hp-harry.svg',
    characterAlt: 'Harry cinematic presence',
    dialogues: [
      'Lumos.',
      'Magic is everywhere.',
      'You are ready.'
    ],
    eventText: 'SPELL.',
    sound: 'magic'
  }
};

const themeCharacterVisibility = {};
let themeDialogueTimerId = 0;
let themeEventTimerId = 0;
let themeDialogueHideTimerId = 0;
let themeEventHideTimerId = 0;

const THEME_NARRATIVE_TITLES = {
  dark: {
    trending: '🔥 Trending Now',
    preferred: '🌍 Based on Your Languages',
    latest: '🆕 New for You',
    homeTopMovies: '🎬 Top 10 Movies Right Now',
    homeTopSeries: '📺 Top 10 Series Right Now',
    moviesTop: 'Top 10 Movies Right Now',
    seriesTop: 'Top 10 Series Right Now'
  },
  neon: {
    trending: '⚡ Pulse Trending',
    preferred: '🌍 Region Pulse',
    latest: '🆕 Fresh Drops',
    homeTopMovies: '🎬 Top 10 Movies Right Now',
    homeTopSeries: '📺 Top 10 Series Right Now',
    moviesTop: 'Top 10 Movies Right Now',
    seriesTop: 'Top 10 Series Right Now'
  },
  got: {
    trending: '🔥 Fire of the Realm',
    preferred: '🐉 Dragon\'s Watch',
    latest: '👑 King\'s Choice',
    homeTopMovies: '🐉 Dragon\'s Watch',
    homeTopSeries: '👑 King\'s Choice',
    moviesTop: '🐉 Dragon\'s Watch',
    seriesTop: '👑 King\'s Choice'
  },
  stranger: {
    trending: '⚡ Upside Down Trending',
    preferred: '🔴 Hawkins Spotlight',
    latest: '🧩 Mystery Queue',
    homeTopMovies: '🔴 Hawkins Spotlight',
    homeTopSeries: '🧩 Mystery Queue',
    moviesTop: '🔴 Hawkins Spotlight',
    seriesTop: '🧩 Mystery Queue'
  },
  hp: {
    trending: '🪄 Spells in Motion',
    preferred: '✨ Wizarding World Picks',
    latest: '📜 Hall of Fame',
    homeTopMovies: '✨ Wizarding World Picks',
    homeTopSeries: '📜 Hall of Fame',
    moviesTop: '✨ Wizarding World Picks',
    seriesTop: '📜 Hall of Fame'
  }
};

function activeTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function themeNarrativeTitles(theme = activeTheme()) {
  return THEME_NARRATIVE_TITLES[theme] || THEME_NARRATIVE_TITLES.dark;
}

function setHeadingHtml(id, iconClass, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<i class="bi ${iconClass} me-2 accent-text"></i>${escapeHtml(label)}`;
}

function characterCardMarkup(item) {
  const moodClass = item?.mood ? ` mood-${escapeHtml(item.mood)}` : '';
  const hasImage = Boolean(item?.image);
  const visualMarkup = hasImage
    ? `<img class="theme-character-portrait" src="${escapeHtml(item.image)}" alt="${escapeHtml(item?.name || 'Character')}" loading="lazy" decoding="async">`
    : `<span class="theme-character-main">${escapeHtml(item?.main || '✨')}</span>`;

  return `<article class="theme-character-card${moodClass}">
    <div class="theme-character-visual">
      ${visualMarkup}
      <span class="theme-character-aura" aria-hidden="true"></span>
      <span class="theme-character-side">${escapeHtml(item?.side || '')}</span>
    </div>
    <div class="theme-character-meta">
      <span class="theme-character-name">${escapeHtml(item?.name || 'Character')}</span>
      <span class="theme-character-note">${escapeHtml(item?.note || '')}</span>
    </div>
  </article>`;
}

function applyThemeCharacterStrip(theme = activeTheme()) {
  const container = document.getElementById('themeCharacterStrip');
  const toggleBtn = document.getElementById('themeCharacterToggleBtn');
  if (!container) return;

  const chars = THEME_CHARACTERS[theme] || [];
  if (!chars.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    container.classList.remove('is-visible');
    if (toggleBtn) {
      toggleBtn.style.display = 'none';
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  const isVisible = Boolean(themeCharacterVisibility[theme]);

  if (toggleBtn) {
    toggleBtn.style.display = 'inline-flex';
    toggleBtn.setAttribute('aria-expanded', String(isVisible));
    toggleBtn.innerHTML = isVisible
      ? '<i class="bi bi-x-circle me-1"></i>Hide Characters'
      : '<i class="bi bi-people me-1"></i>Show Characters';
  }

  if (!isVisible) {
    container.innerHTML = '';
    container.style.display = 'none';
    container.classList.remove('is-visible');
    return;
  }

  container.style.display = 'flex';
  container.classList.add('is-visible');
  container.innerHTML = chars.slice(0, 3).map((item) =>
    characterCardMarkup(item)
  ).join('');
}

function toggleThemeCharacters() {
  const theme = activeTheme();
  if (!(THEME_CHARACTERS[theme] || []).length) return;

  themeCharacterVisibility[theme] = !Boolean(themeCharacterVisibility[theme]);
  applyThemeCharacterStrip(theme);
}

function applyThemeBranding(theme = activeTheme()) {
  const titles = themeNarrativeTitles(theme);
  const logoIcon = THEME_BRAND_ICON[theme] || THEME_BRAND_ICON.dark;

  document.querySelectorAll('.brand-logo-glyph').forEach((iconEl) => {
    iconEl.className = `bi ${logoIcon} brand-logo-glyph`;
  });

  document.querySelectorAll('.brand-text').forEach((el) => {
    el.textContent = BRAND_SHORT;
  });

  setText('heroBrandBadge', BRAND_SHORT);
  const heroHeadline = document.getElementById('heroHeadline');
  if (heroHeadline) {
    heroHeadline.innerHTML = `<span class="accent-text">${escapeHtml(BRAND_FULL_FORM)}</span>`;
  }
  setText('brandTaglineHero', BRAND_TAGLINE);

  setHeadingHtml('homeTopMoviesHeading', 'bi-fire', titles.homeTopMovies);
  setHeadingHtml('homeTopSeriesHeading', 'bi-tv', titles.homeTopSeries);
  setHeadingHtml('moviesTopHeading', 'bi-fire', titles.moviesTop);
  setHeadingHtml('seriesTopHeading', 'bi-tv', titles.seriesTop);

  setText('preferredLangTitle', titles.preferred);
  setText('latestPreferredTitle', titles.latest);
  setText('trendingTitle', titles.trending);
  applyThemeCharacterStrip(theme);
}

function clearThemeImmersionTimers() {
  if (themeDialogueTimerId) {
    clearInterval(themeDialogueTimerId);
    themeDialogueTimerId = 0;
  }
  if (themeEventTimerId) {
    clearInterval(themeEventTimerId);
    themeEventTimerId = 0;
  }
  if (themeDialogueHideTimerId) {
    clearTimeout(themeDialogueHideTimerId);
    themeDialogueHideTimerId = 0;
  }
  if (themeEventHideTimerId) {
    clearTimeout(themeEventHideTimerId);
    themeEventHideTimerId = 0;
  }
}

function playThemeEventSound(kind) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const ctx = new AudioContextCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const profile = {
      horror: { type: 'sawtooth', start: 160, end: 118 },
      fire: { type: 'triangle', start: 220, end: 176 },
      magic: { type: 'sine', start: 520, end: 710 }
    }[kind] || { type: 'sine', start: 260, end: 220 };

    osc.type = profile.type;
    osc.frequency.setValueAtTime(profile.start, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(profile.end, ctx.currentTime + 0.35);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.03, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.44);

    setTimeout(() => {
      try { ctx.close(); } catch (_) {}
    }, 600);
  } catch (_) {
    // Audio is optional; ignore failures silently.
  }
}

function triggerThemeEvent(cfg) {
  const eventEl = document.getElementById('themeEvent');
  const textEl = document.getElementById('eventText');
  if (!eventEl || !textEl) return;

  textEl.textContent = cfg.eventText;
  eventEl.classList.remove('hidden');
  eventEl.classList.remove('is-active');
  void eventEl.offsetHeight;
  eventEl.classList.add('is-active');

  playThemeEventSound(cfg.sound);

  if (themeEventHideTimerId) clearTimeout(themeEventHideTimerId);
  themeEventHideTimerId = setTimeout(() => {
    eventEl.classList.add('hidden');
    eventEl.classList.remove('is-active');
  }, 620);
}

function startThemeDialogue(cfg) {
  const dialogueEl = document.getElementById('themeDialogue');
  if (!dialogueEl || !Array.isArray(cfg.dialogues) || !cfg.dialogues.length) return;

  const showDialogue = () => {
    if (document.hidden) return;

    const text = cfg.dialogues[Math.floor(Math.random() * cfg.dialogues.length)];
    dialogueEl.textContent = text;
    dialogueEl.classList.add('is-visible');

    if (themeDialogueHideTimerId) clearTimeout(themeDialogueHideTimerId);
    themeDialogueHideTimerId = setTimeout(() => {
      dialogueEl.classList.remove('is-visible');
    }, 2800);
  };

  setTimeout(showDialogue, 2500 + Math.floor(Math.random() * 2500));
  themeDialogueTimerId = setInterval(showDialogue, 15000);
}

function startThemeEvents(cfg) {
  themeEventTimerId = setInterval(() => {
    if (document.hidden) return;
    if (document.body.classList.contains('modal-open')) return;
    if (Math.random() < 0.2) triggerThemeEvent(cfg);
  }, 30000);
}

function initThemeImmersion(theme = activeTheme()) {
  clearThemeImmersionTimers();

  const wrapper = document.getElementById('themeCharacter');
  const img = document.getElementById('themeCharacterImg');
  const dialogue = document.getElementById('themeDialogue');
  const eventEl = document.getElementById('themeEvent');
  if (!wrapper || !img || !dialogue || !eventEl) return;

  const cfg = THEME_IMMERSION[theme];
  if (!cfg) {
    wrapper.classList.add('hidden');
    eventEl.classList.add('hidden');
    dialogue.classList.remove('is-visible');
    dialogue.textContent = '';
    return;
  }

  img.src = cfg.character;
  img.alt = cfg.characterAlt;
  wrapper.classList.remove('hidden');
  eventEl.classList.add('hidden');

  startThemeDialogue(cfg);
  startThemeEvents(cfg);
}

let TMDB_API_KEY = window.TMDB_API_KEY || localStorage.getItem('tmdb_api_key') || '';
let HAS_TMDB = Boolean(TMDB_API_KEY && TMDB_API_KEY.length > 10);

const moviesVirtualState = {
  initialized: false,
  container: null,
  spacer: null,
  content: null,
  source: [],
  startIndex: -1,
  endIndex: -1,
  rafId: 0,
  backendPage: 1,
  backendLimit: 100,
  hasMoreBackend: true,
  isFetchingBackend: false,
  clientSideSort: null,
  // Infinite scroll filter state (kept in sync with current filter UI)
  infiniteScrollLang: null,
  infiniteScrollSort: 'trending',
  infiniteScrollGenre: null,
  infiniteScrollYear: null,
  infiniteScrollSearch: null
};

const HOME_SECTION_CONFIG = {
  continueWatching: { containerId: 'homeContinueWatchingRow', custom: 'continueWatching' },
  watchlistRow: { containerId: 'homeWatchlistRow', custom: 'watchlist' },
  preferredLang: { containerId: 'homePreferredLangRow', custom: 'preferredLang' },
  latestPreferred: { containerId: 'homeLatestPreferredRow', custom: 'latestPreferred' },
  trending: { containerId: 'homeTrendingRow', params: { sort: 'trending' }, type: 'movie' }
};

/* ===================================================
   GENRE & LANGUAGE MAPS
   =================================================== */
const GENRE_ID_MAP = {
  28:'Action', 12:'Adventure', 16:'Animation', 35:'Comedy', 80:'Crime',
  99:'Documentary', 18:'Drama', 10751:'Family', 14:'Fantasy', 36:'History',
  27:'Horror', 10402:'Music', 9648:'Mystery', 10749:'Romance', 878:'Sci-Fi',
  10770:'TV Movie', 53:'Thriller', 10752:'War', 37:'Western'
};

const TV_GENRE_ID_MAP = {
  10759:'Action & Adventure', 16:'Animation', 35:'Comedy', 80:'Crime',
  99:'Documentary', 18:'Drama', 10751:'Family', 10762:'Kids', 9648:'Mystery',
  10763:'News', 10764:'Reality', 10765:'Sci-Fi & Fantasy', 10766:'Soap',
  10767:'Talk', 10768:'War & Politics', 37:'Western'
};

const LANG_CODE_MAP = {
  en:'English', hi:'Hindi', ta:'Tamil', te:'Telugu', ml:'Malayalam',
  kn:'Kannada', bn:'Bengali', fr:'French', es:'Spanish', de:'German',
  it:'Italian', ja:'Japanese', ko:'Korean', ru:'Russian', zh:'Chinese',
  ar:'Arabic', pt:'Portuguese', th:'Thai', tr:'Turkish', vi:'Vietnamese',
  mr:'Marathi', pa:'Punjabi', gu:'Gujarati', or:'Odia', ur:'Urdu',
  si:'Sinhala', ne:'Nepali', my:'Burmese', km:'Khmer', id:'Indonesian',
  ms:'Malay', tl:'Filipino', sw:'Swahili', nl:'Dutch', pl:'Polish',
  cs:'Czech', hu:'Hungarian', ro:'Romanian', sv:'Swedish', da:'Danish',
  fi:'Finnish', no:'Norwegian', he:'Hebrew', fa:'Persian', uk:'Ukrainian'
};

const LANG_EMOJI = {
  English:'🎬', Hindi:'🎭', Tamil:'🎵', Telugu:'🌟', Malayalam:'🌴',
  Kannada:'🏔️', Bengali:'📚', French:'🗼', Spanish:'💃', German:'🍺',
  Italian:'🍕', Japanese:'🎌', Korean:'🇰🇷', Russian:'🌨️', Chinese:'🐉',
  Arabic:'🌙', Portuguese:'🌊', Thai:'🐘', Turkish:'🌹', Vietnamese:'🌸',
  Marathi:'🎪', Punjabi:'🌾', Gujarati:'💫', Urdu:'✨', Odia:'🏛️',
  Sinhala:'🦁', Nepali:'🏔️', Burmese:'🌿', Indonesian:'🌴', Malay:'🌺',
  Filipino:'🌅', Dutch:'🌷', Polish:'🦅', Hebrew:'✡️', Persian:'🌷',
  Ukrainian:'🌻', Swedish:'🫐', Danish:'🧜', Finnish:'🌲', Norwegian:'🌊'
};

const LANG_MAP = {
  Tamil: 'ta',
  Telugu: 'te',
  Malayalam: 'ml',
  Hindi: 'hi',
  English: 'en'
};

function mapLanguage(code) {
  return LANG_CODE_MAP[code] || (code ? code.toUpperCase() : 'Unknown');
}

function resolveLanguageCode(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'all') return null;

  const explicit = LANG_MAP[raw];
  if (explicit) return explicit;

  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANG_CODE_MAP, lower)) return lower;

  const fromLabel = Object.entries(LANG_CODE_MAP).find(([, label]) => String(label).toLowerCase() === lower)?.[0];
  if (fromLabel) return fromLabel;

  const fromMovie = allMovies.find((m) => String(m.language || '').toLowerCase() === lower)?.langCode
    || allSeries.find((m) => String(m.language || '').toLowerCase() === lower)?.langCode;
  return fromMovie || null;
}

function getLangCode(label) {
  return resolveLanguageCode(label) || '';
}

function getStorageKey(baseKey) {
  const uid = currentUser?._id ? String(currentUser._id) : '';
  return uid ? `${baseKey}:${uid}` : baseKey;
}

function getStoredWatchlist() {
  return JSON.parse(localStorage.getItem(getStorageKey('watchlist')) || '[]');
}

function setStoredWatchlist(list) {
  localStorage.setItem(getStorageKey('watchlist'), JSON.stringify(list));
}

function getStoredRatings() {
  return JSON.parse(localStorage.getItem(getStorageKey('ratings')) || '{}');
}

function setStoredRatings(ratings) {
  localStorage.setItem(getStorageKey('ratings'), JSON.stringify(ratings));
}

function getStoredFavorites() {
  return JSON.parse(localStorage.getItem(getStorageKey('favorites')) || '[]');
}

function setStoredFavorites(list) {
  localStorage.setItem(getStorageKey('favorites'), JSON.stringify(list));
}

function getContinueWatchingItems() {
  const raw = JSON.parse(localStorage.getItem(getStorageKey('continueWatching')) || '[]');
  return Array.isArray(raw) ? raw : [];
}

function setContinueWatchingItems(list) {
  localStorage.setItem(getStorageKey('continueWatching'), JSON.stringify(list));
}

function trackContinueWatching(movie) {
  const movieId = Number(movie?.id || movie?.tmdbId || 0);
  if (!Number.isFinite(movieId)) return;

  const existing = getContinueWatchingItems().filter((item) => Number(item?.id) !== movieId);
  const next = [{
    id: movieId,
    isTV: Boolean(movie?.isTV),
    viewedAt: Date.now()
  }, ...existing].slice(0, 30);
  setContinueWatchingItems(next);
}

function userLangs() {
  const langs = Array.isArray(currentUser?.preferredLanguages) ? currentUser.preferredLanguages : [];
  return langs.length ? langs : ['en'];
}

function updateAuthUI() {
  const authBtn = document.getElementById('authBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  if (!authBtn || !logoutBtn) return;

  if (currentUser) {
    const name = escapeHtml(currentUser.name || currentUser.email || 'User');
    authBtn.innerHTML = `<i class="bi bi-person-check me-1"></i>${name}`;
    authBtn.setAttribute('title', currentUser.email || 'Signed in');
    authBtn.onclick = () => openProfileMenu();
    logoutBtn.style.display = 'inline-flex';
  } else {
    authBtn.innerHTML = '<i class="bi bi-person-circle"></i>';
    authBtn.setAttribute('title', 'Sign in');
    authBtn.onclick = () => openAuthModal();
    logoutBtn.style.display = 'none';
  }

  updateWelcomeBanner();
}

function openProfileMenu() {
  // Show a small dropdown/toast with options
  const existing = document.getElementById('profileMenuDropdown');
  if (existing) { existing.remove(); return; }

  const authBtn = document.getElementById('authBtn');
  if (!authBtn) return;

  const menu = document.createElement('div');
  menu.id = 'profileMenuDropdown';
  const langs = Array.isArray(currentUser?.preferredLanguages) ? currentUser.preferredLanguages : [];
  const langLabels = langs.map(c => mapLanguage(c)).join(', ') || 'None set';

  menu.style.cssText = `
    position: fixed;
    top: ${authBtn.getBoundingClientRect().bottom + 8}px;
    right: 12px;
    background: var(--card-bg, #1a1a2e);
    border: 1px solid var(--border-color, #334155);
    border-radius: 12px;
    padding: 12px;
    min-width: 240px;
    z-index: 9999;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  `;

  menu.innerHTML = `
    <div style="padding:8px 4px 10px;border-bottom:1px solid var(--border-color,#334155);margin-bottom:8px">
      <div style="font-weight:600;color:var(--text-primary,#fff);font-size:0.95rem">
        <i class="bi bi-person-circle me-2 accent-text"></i>${escapeHtml(currentUser.name || currentUser.email)}
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted,#94a3b8);margin-top:2px">${escapeHtml(currentUser.email || '')}</div>
    </div>
    <div style="font-size:0.78rem;color:var(--text-muted,#94a3b8);margin-bottom:8px">
      <i class="bi bi-translate me-1"></i>Languages: <span style="color:var(--accent,#f59e0b)">${escapeHtml(langLabels)}</span>
    </div>
    <button class="btn btn-outline-custom btn-sm w-100 mb-2" onclick="document.getElementById('profileMenuDropdown')?.remove(); openChangeLanguagesModal()">
      <i class="bi bi-translate me-1"></i>Change Languages
    </button>
    <button class="btn btn-outline-custom btn-sm w-100" style="color:#ef4444;border-color:#ef4444" onclick="document.getElementById('profileMenuDropdown')?.remove(); logoutUser()">
      <i class="bi bi-box-arrow-right me-1"></i>Sign Out
    </button>
  `;

  document.body.appendChild(menu);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== authBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 50);
}

function openChangeLanguagesModal() {
  // Pre-check current user language selections
  const currentLangs = Array.isArray(currentUser?.preferredLanguages) ? currentUser.preferredLanguages : [];
  document.querySelectorAll('#languageChoices input[type="checkbox"]').forEach(cb => {
    cb.checked = currentLangs.includes(cb.value);
  });
  // Allow closing when changing (not first-time)
  const modalEl = document.getElementById('languageModal');
  modalEl.setAttribute('data-bs-backdrop', 'true');
  const closeBtn = document.getElementById('languageModalCloseBtn');
  if (closeBtn) closeBtn.style.display = 'block';
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

function updateWelcomeBanner() {
  const el = document.getElementById('welcomeBackLine');
  if (!el) return;

  if (!currentUser) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }

  const name = currentUser.name || currentUser.email || 'there';
  el.textContent = `Welcome back, ${name}`;
  el.style.display = 'block';
}

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function fetchCurrentUser() {
  if (!authToken) return null;
  try {
    const res = await fetch('http://localhost:5000/api/auth/me', {
      headers: { ...authHeaders() }
    });
    if (!res.ok) return null;
    return res.json();
  } catch (_err) {
    return null;
  }
}

async function hydrateUserSession() {
  const cached = JSON.parse(localStorage.getItem('user') || 'null');
  if (cached && cached._id) currentUser = cached;

  if (!authToken) {
    updateAuthUI();
    return;
  }

  const latest = await fetchCurrentUser();
  if (latest && latest._id) {
    currentUser = latest;
    localStorage.setItem('user', JSON.stringify(currentUser));

    if (Array.isArray(currentUser.watchlist)) {
      setStoredWatchlist(currentUser.watchlist);
    }
    if (currentUser.ratings && typeof currentUser.ratings === 'object') {
      setStoredRatings(currentUser.ratings);
    }
  } else {
    authToken = '';
    currentUser = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
  }

  updateAuthUI();
  // If user has preferred languages, update the home top 10 language tab to their primary lang
  if (currentUser?.preferredLanguages?.length) {
    const primaryLang = currentUser.preferredLanguages[0];
    const tab = document.querySelector(`#homeTopSection .top-lang-tab[data-region="${primaryLang}"]`);
    if (tab && !document.querySelector('#homeTopSection .top-lang-tab.active[data-region="' + primaryLang + '"]')) {
      // Don't force switch — just make sure it's reflected after first load
    }
  }
}

/* ===================================================
   TMDB HELPERS
   =================================================== */
function tmdbUrl(path, params = {}) {
  const q = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  return `${TMDB_BASE}${path}?${q}`;
}

async function tmdbGet(path, params = {}) {
  // Reuse dedupe/cache layer so repeated TMDB requests resolve faster.
  return withTimeout(fetchJson(tmdbUrl(path, params)), TMDB_TIMEOUT_MS, 'TMDB request timed out');
}

function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS, message = 'Request timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

async function fetchJsonWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  return withTimeout(fetchJson(url, options), timeoutMs, `Request timed out: ${url}`);
}

async function fetchJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const dedupeSafe = method === 'GET' && !options.signal;

  if (!dedupeSafe) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const cached = getResponseCache.get(url);
  const now = Date.now();
  if (cached && now - cached.ts < GET_CACHE_TTL_MS) {
    return cached.data;
  }

  if (inflightGetRequests.has(url)) {
    return inflightGetRequests.get(url);
  }

  const promise = fetch(url, options)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      getResponseCache.set(url, { ts: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflightGetRequests.delete(url);
    });

  inflightGetRequests.set(url, promise);
  return promise;
}

function mapTmdbMovie(item) {
  const isTV = Boolean(item.first_air_date || item.name);
  const title = item.title || item.name || 'Untitled';
  const releaseDate = item.release_date || item.first_air_date || '';
  const posterUrl = item.poster_path
    ? `${TMDB_IMG_W500}${item.poster_path}`
    : (item.posterUrl || PLACEHOLDER);
  const backdropUrl = item.backdrop_path ? `${TMDB_IMG_W780}${item.backdrop_path}` : '';

  const genreMap = isTV ? TV_GENRE_ID_MAP : GENRE_ID_MAP;

  return {
    id: item.id,
    tmdbId: item.id,
    isTV,
    title,
    language: mapLanguage(item.original_language),
    langCode: item.original_language || '',
    genre: (item.genre_ids || []).map(id => genreMap[id] || GENRE_ID_MAP[id]).filter(Boolean),
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : 'N/A',
    rating: Number((item.vote_average || 0).toFixed(1)),
    voteCount: item.vote_count || 0,
    popularity: item.popularity || 0,
    director: 'N/A',
    cast: [],
    description: item.overview || 'Description not available.',
    posterUrl,
    backdropUrl,
    trailerYT: '',
    ottPlatforms: [],
    imdbId: '',
    similarMovieIds: [],
    actorMovieIds: []
  };
}

/* ===================================================
   INIT
   =================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  injectGotFont();
  setupAmbientCanvas();
  setupEventListeners();
  await hydrateUserSession();
  renderWatchlist();
  renderReviews();
  updateStats();
  requestAnimationFrame(() => document.body.classList.add('loaded'));

  if (!HAS_TMDB) {
    showApiKeyModal();
  } else {
    await initLoad();
    applyRouteFromLocation({ replaceHistory: true });
  }
});

async function initLoad() {
  showMoviesLoading(true);
  // Use user's primary preferred language for Top 10 on load
  const primaryLang = currentUser?.preferredLanguages?.[0] || 'all';
  try {
    // Try backend for both movies and series simultaneously
    await Promise.all([
      loadTopNow(primaryLang),
      loadMoviesFromBackend({ reset: true, pages: INITIAL_MOVIES_PAGES, limit: API_LIST_LIMIT, type: 'movie', sort: 'trending' }),
      loadSeriesFromBackend({ reset: true, pages: 2, limit: 24, sort: 'trending' })
    ]);

    renderMoviesPage(allMovies);
    renderSeriesGrid(allSeries);
    setupHomeSectionObserver();
    refreshPersonalizedHome().catch(() => {});
    showMoviesLoading(false);

  } catch (err) {
    console.warn('Backend load failed, falling back to TMDB/local:', err);
    showMoviesLoading(false);
    try {
      await Promise.all([
        loadTopNow(primaryLang),
        loadMoviesFromApi({ reset: true, pages: 10 }),
        loadSeriesFromApi({ reset: true, pages: 3 })
      ]);
      renderMoviesPage(allMovies);
      renderSeriesGrid(allSeries);
    } catch (fallbackErr) {
      console.warn('TMDB load failed, using local data:', fallbackErr);
      await loadMoviesLocal();
      renderFallbackTopNow();
    }
  }
}

function showMoviesLoading(show) {
  const el = document.getElementById('moviesLoading');
  const grid = document.getElementById('movieContainer');
  if (el) el.style.display = 'none'; // hide spinner — we use skeletons now
  if (show) {
    // Show skeleton cards instead of spinner
    renderSkeletonCards('movieContainer', 12);
    renderSkeletonCards('moviesPageContainer', 12);
  } else {
    if (grid) grid.style.opacity = '1';
  }
}

/* ===================================================
   API KEY MODAL
   =================================================== */
function showApiKeyModal() {
  const el = document.getElementById('apiKeyModal');
  if (!el || typeof bootstrap === 'undefined') return;

  const modal = new bootstrap.Modal(el);
  modal.show();
}

function openAuthModal() {
  setAuthMode('login');
  const modal = new bootstrap.Modal(document.getElementById('authModal'));
  modal.show();
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  const nameWrap = document.getElementById('authNameWrap');
  const hint = document.getElementById('authHint');
  const loginBtn = document.getElementById('loginModeBtn');
  const registerBtn = document.getElementById('registerModeBtn');

  if (nameWrap) nameWrap.style.display = authMode === 'register' ? '' : 'none';
  if (hint) hint.textContent = authMode === 'register'
    ? 'Create a Gmail account login to save preferences, watchlist, and ratings.'
    : 'Log in with a valid Gmail account to sync watchlist, ratings, and personalized rows.';

  loginBtn?.classList.toggle('active', authMode === 'login');
  registerBtn?.classList.toggle('active', authMode === 'register');
}

const GMAIL_EMAIL_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]{0,62}[a-zA-Z0-9])?@gmail\.com$/;
let cachedGoogleClientId = '';

function isValidGmailEmail(email) {
  return GMAIL_EMAIL_REGEX.test(String(email || '').trim().toLowerCase());
}

function getGoogleClientId() {
  const fromCache = String(cachedGoogleClientId || '').trim();
  if (fromCache) return fromCache;

  const fromGlobal = String(window.GOOGLE_CLIENT_ID || '').trim();
  if (fromGlobal) return fromGlobal;

  const fromFirebaseConfig = String(window.FIREBASE_CONFIG?.clientId || '').trim();
  return fromFirebaseConfig;
}

async function ensureGoogleClientId() {
  const existing = getGoogleClientId();
  if (existing) {
    cachedGoogleClientId = existing;
    return existing;
  }

  try {
    const res = await fetch('http://localhost:5000/api/auth/google-config');
    if (!res.ok) return '';

    const data = await res.json();
    const resolved = String(data?.clientId || '').trim();
    if (resolved) {
      cachedGoogleClientId = resolved;
      window.GOOGLE_CLIENT_ID = resolved;
      return resolved;
    }
  } catch (_err) {
    return '';
  }

  return '';
}

function requestGoogleCredentialViaGIS() {
  return new Promise((resolve, reject) => {
    const googleClientId = getGoogleClientId();

    if (!window.google?.accounts?.id) {
      reject(new Error('Google Identity Services SDK is not loaded'));
      return;
    }
    if (!googleClientId) {
      reject(new Error('GOOGLE_CLIENT_ID is not configured in window scope'));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response) => {
        if (response?.credential) {
          finish(resolve, response.credential);
          return;
        }
        finish(reject, new Error('Google did not return a credential'));
      },
      auto_select: true,
      cancel_on_tap_outside: true
    });

    window.google.accounts.id.prompt((notification) => {
      if (settled) return;

      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.() || notification?.isDismissedMoment?.()) {
        finish(reject, new Error('Google prompt was not completed'));
      }
    });
  });
}

async function exchangeGoogleToken(idToken) {
  const token = String(idToken || '').trim();
  if (!token) {
    throw new Error('Google login token missing');
  }

  const res = await fetch('http://localhost:5000/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken: token,
      credential: token
    })
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_err) {
    data = null;
  }

  if (!res.ok || !data?.token || !data?.user?._id) {
    const msg = data?.message || 'Google auth failed';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return data;
}

function initFirebaseAuth() {
  if (!window.firebase) return false;
  if (window.firebase.apps?.length) return true;
  if (!window.FIREBASE_CONFIG) return false;

  try {
    window.firebase.initializeApp(window.FIREBASE_CONFIG);
    return true;
  } catch (_err) {
    return false;
  }
}

async function submitAuth() {
  const name = (document.getElementById('authName')?.value || '').trim();
  const email = (document.getElementById('authEmail')?.value || '').trim().toLowerCase();
  const password = (document.getElementById('authPassword')?.value || '').trim();

  if (!email || !password) {
    showToast('❌ Email and password are required');
    return;
  }

  if (!isValidGmailEmail(email)) {
    showToast('❌ Enter a valid Gmail address (example@gmail.com)');
    return;
  }

  const endpoint = authMode === 'register' ? 'register' : 'login';

  try {
    const res = await fetch(`http://localhost:5000/api/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.message || 'Auth failed'}`);
      return;
    }

    authToken = data.token || '';
    currentUser = data.user || null;
    if (!authToken || !currentUser?._id) {
      showToast('❌ Invalid session response');
      return;
    }

    localStorage.setItem('authToken', authToken);
    localStorage.setItem('user', JSON.stringify(currentUser));
    setStoredWatchlist(Array.isArray(currentUser.watchlist) ? currentUser.watchlist : []);
    setStoredRatings(currentUser.ratings && typeof currentUser.ratings === 'object' ? currentUser.ratings : {});

    bootstrap.Modal.getInstance(document.getElementById('authModal'))?.hide();
    updateAuthUI();

    if (!Array.isArray(currentUser.preferredLanguages) || !currentUser.preferredLanguages.length) {
      const modal = new bootstrap.Modal(document.getElementById('languageModal'));
      modal.show();
    }

    await refreshPersonalizedHome();
    renderWatchlist();
    updateStats();
    showToast(authMode === 'register' ? '✅ Account created' : '✅ Logged in');
  } catch (_err) {
    showToast('❌ Auth server unavailable');
  }
}

async function loginWithGoogle() {
  try {
    await ensureGoogleClientId();

    let authData = null;
    let firstError = null;

    // Try direct Google Identity Services flow first.
    try {
      const gisToken = await requestGoogleCredentialViaGIS();
      authData = await exchangeGoogleToken(gisToken);
    } catch (gisErr) {
      firstError = gisErr;
    }

    // Fallback to Firebase popup flow for better compatibility.
    if (!authData && initFirebaseAuth()) {
      try {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        const result = await window.firebase.auth().signInWithPopup(provider);
        const profile = result?.user;
        if (!profile?.email) {
          throw new Error('Google login failed');
        }
        const firebaseToken = await profile.getIdToken();
        authData = await exchangeGoogleToken(firebaseToken);
      } catch (firebaseErr) {
        if (firstError) {
          throw new Error(`${firstError.message}. ${firebaseErr.message}`);
        }
        throw firebaseErr;
      }
    }

    if (!authData) {
      throw firstError || new Error('Google login is not configured. Set GOOGLE_CLIENT_ID or FIREBASE_CONFIG.');
    }

    authToken = authData.token;
    currentUser = authData.user;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('user', JSON.stringify(currentUser));
    setStoredWatchlist(Array.isArray(currentUser.watchlist) ? currentUser.watchlist : []);
    setStoredRatings(currentUser.ratings && typeof currentUser.ratings === 'object' ? currentUser.ratings : {});

    bootstrap.Modal.getInstance(document.getElementById('authModal'))?.hide();
    updateAuthUI();

    if (!Array.isArray(currentUser.preferredLanguages) || !currentUser.preferredLanguages.length) {
      const modal = new bootstrap.Modal(document.getElementById('languageModal'));
      modal.show();
    }

    await refreshPersonalizedHome();
    renderWatchlist();
    updateStats();
    showToast('✅ Logged in with Google');
  } catch (err) {
    showToast(`❌ ${err?.message || 'Google sign-in cancelled or failed'}`);
  }
}

function logoutUser() {
  authToken = '';
  currentUser = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('user');
  updateAuthUI();
  refreshPersonalizedHome().catch(() => {});
  renderWatchlist();
  updateStats();
  showToast('Logged out');
}

async function saveLanguages() {
  const selected = Array.from(document.querySelectorAll('#languageChoices input:checked'))
    .map((input) => input.value)
    .filter(Boolean);

  if (!selected.length) {
    showToast('❌ Select at least one language');
    return;
  }

  if (!currentUser?._id || !authToken) {
    showToast('❌ Login required');
    return;
  }

  try {
    const res = await fetch(`http://localhost:5000/api/users/${currentUser._id}/preferences`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ preferredLanguages: selected })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ ${data.message || 'Failed to save languages'}`);
      return;
    }

    currentUser = data;
    localStorage.setItem('user', JSON.stringify(currentUser));
    bootstrap.Modal.getInstance(document.getElementById('languageModal'))?.hide();

    // Reset home section observer so personalized rows reload fresh
    if (homeSectionObserver) {
      homeSectionObserver.disconnect();
      homeSectionObserver = null;
      homeRowsLoaded = false;
    }
    // Clear home cache for language-based rows
    homeCache.preferredLang = null;
    homeCache.latestPreferred = null;

    // Reload top 10 with first preferred language
    const primaryLang = selected[0];
    loadTopNow(primaryLang).catch(() => {});

    // Reset home section loaded state for language rows
    document.querySelectorAll('.home-row[data-section-key]').forEach(row => {
      row.removeAttribute('data-loaded');
    });

    await refreshPersonalizedHome();
    updateAuthUI();
    showToast(`✅ Languages updated — showing ${selected.map(c => mapLanguage(c)).join(', ')}`);
  } catch (_err) {
    showToast('❌ Failed to save preferences');
  }
}

function saveApiKey() {
  const input = document.getElementById('apiKeyInput');
  const key = (input?.value || '').trim();
  if (!key || key.length < 10) {
    showToast('❌ Please enter a valid API key.');
    return;
  }
  TMDB_API_KEY = key;
  HAS_TMDB = true;
  const saveCheck = document.getElementById('saveKeyCheck');
  if (saveCheck?.checked) {
    localStorage.setItem('tmdb_api_key', key);
  }
  bootstrap.Modal.getInstance(document.getElementById('apiKeyModal'))?.hide();
  showToast('✅ API key saved! Loading movies…');
  allMovies = [];
  allSeries = [];
  filteredMovies = [];
  filteredSeries = [];
  const legacyHomeGrid = document.getElementById('movieContainer');
  if (legacyHomeGrid) legacyHomeGrid.innerHTML = '';
  initLoad();
}

async function loadWithLocalData() {
  bootstrap.Modal.getInstance(document.getElementById('apiKeyModal'))?.hide();
  await loadMoviesLocal();
  renderFallbackTopNow();
}

/* ===================================================
   LOAD MOVIES
   =================================================== */
async function loadMoviesLocal() {
  try {
    const res = await fetch('images/data/movies.json');
    const data = await res.json();
    const movies = (data.movies || []).map(m => ({
      ...m,
      tmdbId: m.id,
      langCode: '',
      backdropUrl: '',
      popularity: m.rating || 0,
      voteCount: 0,
      isTV: false
    }));
    mergeMovies(movies);
  } catch (err) {
    console.error('Local JSON load failed:', err);
  }
}

async function loadMoviesFromBackend() {
  const {
    reset = false,
    pages = 1,
    limit = moviesVirtualState.backendLimit,
    language = null,
    genre = null,
    year = null,
    search = null,
    signal = null,
    type = 'movie',
    sort = 'popularity'
  } = arguments[0] || {};

  if (moviesVirtualState.isFetchingBackend || (!moviesVirtualState.hasMoreBackend && !reset)) {
    return [];
  }

  if (reset) {
    moviesVirtualState.backendPage = 1;
    moviesVirtualState.hasMoreBackend = true;
    allMovies = [];
    filteredMovies = [];
  }

  moviesVirtualState.backendLimit = limit;
  moviesVirtualState.isFetchingBackend = true;

  const collected = [];
  try {
    const toLoad = Math.max(1, Number(pages) || 1);
    for (let i = 0; i < toLoad && moviesVirtualState.hasMoreBackend; i++) {
      const page = moviesVirtualState.backendPage;

      const params = new URLSearchParams({ page, limit, type, sort: sort === 'trending' ? 'trending' : sort });
      if (language && language !== 'all') params.set('language', language);
      if (genre && genre !== 'all') params.set('genre', genre);
      if (year && year !== 'all') params.set('year', year);
      if (search) params.set('search', search);

      const data = await fetchJson(`http://localhost:5000/api/movies?${params}`, signal ? { signal } : undefined);
      const batch = Array.isArray(data) ? data : (data.movies || []);

      if (!batch.length) {
        moviesVirtualState.hasMoreBackend = false;
        break;
      }

      collected.push(...batch);
      moviesVirtualState.backendPage += 1;

      if (batch.length < limit) {
        moviesVirtualState.hasMoreBackend = false;
      }
    }

    if (collected.length) {
      // Force isTV: false for movie-type fetches — DB may have series mixed in
      const normalized = type === 'movie'
        ? collected.map(m => ({ ...(m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m), isTV: false }))
        : collected;
      mergeMovies(normalized);
    }

    return collected;
  } finally {
    moviesVirtualState.isFetchingBackend = false;
  }
}

async function loadMoviesFromApi({ reset = false, pages = 5, langCode = null } = {}) {
  if (!HAS_TMDB) return;
  if (reset) {
    currentApiPage = 1;
    if (!langCode || langCode === 'all') allMovies = [];
  }

  const pageCount = Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : 1;
  const startPage = currentApiPage;
  const requests = [];

  for (let offset = 0; offset < pageCount; offset++) {
    const params = {
      sort_by: 'popularity.desc',
      include_adult: 'false',
      include_video: 'false',
      page: startPage + offset
    };
    if (langCode && langCode !== 'all') {
      params.with_original_language = langCode;
    }
    requests.push(tmdbGet('/discover/movie', params));
  }

  currentApiPage = startPage + pageCount;

  const settled = await Promise.allSettled(requests);
  const fulfilled = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!fulfilled.length) {
    throw new Error('Failed to fetch movie pages from TMDB');
  }

  const newItems = fulfilled.flatMap(d =>
    (d.results || []).map(m => ({ ...mapTmdbMovie(m), isTV: false }))
  );
  mergeMovies(newItems);

  // Ensure Movies page view gets refreshed after load.
  if (document.getElementById('moviesPageContainer')) {
    renderMoviesPage(allMovies);
  }
}

// Series backend virtual state (mirrors moviesVirtualState for series)
const seriesVirtualState = {
  backendPage: 1,
  backendLimit: 24,
  hasMoreBackend: true,
  hasMoreTmdb: true,
  isFetchingBackend: false,
  clientSideSort: null,
  infiniteScrollLang: null,
  infiniteScrollSort: 'trending',
  infiniteScrollGenre: null,
  infiniteScrollYear: null
};

async function loadSeriesFromBackend({
  reset = false,
  pages = 1,
  limit = seriesVirtualState.backendLimit,
  language = null,
  genre = null,
  year = null,
  sort = 'popularity',
  signal = null
} = {}) {
  if (seriesVirtualState.isFetchingBackend || (!seriesVirtualState.hasMoreBackend && !reset)) {
    return [];
  }

  if (reset) {
    seriesVirtualState.backendPage = 1;
    seriesVirtualState.hasMoreBackend = true;
    seriesVirtualState.hasMoreTmdb = true;
    allSeries = [];
    filteredSeries = [];
  }

  seriesVirtualState.backendLimit = limit;
  seriesVirtualState.isFetchingBackend = true;

  const collected = [];
  try {
    const toLoad = Math.max(1, Number(pages) || 1);
    for (let i = 0; i < toLoad && seriesVirtualState.hasMoreBackend; i++) {
      const page = seriesVirtualState.backendPage;
      const params = new URLSearchParams({ page, limit, type: 'tv', sort });
      if (language && language !== 'all') params.set('language', language);
      if (genre && genre !== 'all') params.set('genre', genre);
      if (year && year !== 'all') params.set('year', year);

      const data = await fetchJson(`http://localhost:5000/api/movies?${params}`, signal ? { signal } : undefined);
      const batch = Array.isArray(data) ? data : (data.movies || []);

      if (!batch.length) {
        seriesVirtualState.hasMoreBackend = false;
        break;
      }

      const normalized = batch.map(m => ({ ...(m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m), isTV: true }));
      collected.push(...normalized);
      seriesVirtualState.backendPage += 1;

      if (batch.length < limit) {
        seriesVirtualState.hasMoreBackend = false;
      }
    }

    if (collected.length) {
      mergeSeries(collected);
    }
    return collected;
  } finally {
    seriesVirtualState.isFetchingBackend = false;
  }
}

async function loadSeriesFromApi({ reset = false, pages = 3, langCode = null, render = true } = {}) {
  if (!HAS_TMDB) return;

  if (typeof loadSeriesFromApi.currentPage !== 'number') {
    loadSeriesFromApi.currentPage = 1;
  }
  if (reset) {
    loadSeriesFromApi.currentPage = 1;
    if (!langCode || langCode === 'all') allSeries = [];
  }

  const pageCount = Number.isFinite(pages) && pages > 0 ? Math.min(Math.floor(pages), 5) : 1;
  const startPage = loadSeriesFromApi.currentPage;
  const requests = [];

  for (let offset = 0; offset < pageCount; offset++) {
    const params = {
      sort_by: 'popularity.desc',
      include_adult: 'false',
      page: startPage + offset
    };
    if (langCode && langCode !== 'all') {
      params.with_original_language = langCode;
    }
    requests.push(tmdbGet('/discover/tv', params));
  }

  loadSeriesFromApi.currentPage = startPage + pageCount;

  const settled = await Promise.allSettled(requests);
  const fulfilled = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!fulfilled.length) {
    throw new Error('Failed to fetch series pages from TMDB');
  }

  const totalResults = fulfilled.reduce((acc, d) => acc + ((d.results || []).length), 0);
  if (totalResults === 0) {
    seriesVirtualState.hasMoreTmdb = false;
  }

  const newItems = fulfilled.flatMap(d =>
    (d.results || []).map(m => ({ ...mapTmdbMovie(m), isTV: true }))
  );
  mergeSeries(newItems);

  if (render && document.getElementById('seriesPageContainer')) {
    renderSeriesGrid(allSeries);
  }

  return newItems;
}

function mergeMovies(newItems) {
  const byTmdbId = new Map();

  // Keep existing order first, then append truly new keys.
  allMovies.forEach(m => {
    const key = String(m.tmdbId || m.id || `${m.title || ''}-${m.year || ''}`);
    if (!byTmdbId.has(key)) byTmdbId.set(key, m);
  });

  newItems.forEach(raw => {
    // Backend docs have tmdbId but no id — normalise so the whole app works
    const m = (raw.tmdbId && !raw.id) ? { ...raw, id: raw.tmdbId } : raw;
    const key = String(m.tmdbId || m.id || `${m.title || ''}-${m.year || ''}`);
    if (!byTmdbId.has(key)) byTmdbId.set(key, m);
  });

  allMovies = Array.from(byTmdbId.values());
  filteredMovies = [...allMovies];
  console.log('Loaded movies:', allMovies.length);
  // 🔥 REMOVED: renderMovies(filteredMovies); — causes lag on every merge
  populateFilters();
  updateStats();
}

function mergeSeries(newItems) {
  const byTmdbId = new Map();

  allSeries.forEach(m => {
    const key = String(m.tmdbId || m.id || `${m.title || ''}-${m.year || ''}`);
    if (!byTmdbId.has(key)) byTmdbId.set(key, m);
  });

  newItems.forEach(m => {
    const key = String(m.tmdbId || m.id || `${m.title || ''}-${m.year || ''}`);
    if (!byTmdbId.has(key)) byTmdbId.set(key, m);
  });

  allSeries = Array.from(byTmdbId.values());
  filteredSeries = [...allSeries];
  renderSeriesGrid(allSeries);
  populateSeriesFilters();
}

function getGenreList(movie) {
  const raw = movie?.genre;
  if (Array.isArray(raw)) {
    return raw.map((g) => String(g || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

function isExcludedSeriesItem(movie) {
  const genres = getGenreList(movie).map((g) => g.toLowerCase());
  return genres.includes('soap') || genres.includes('news') || genres.includes('talk');
}

function matchesSeriesActiveFilters(movie) {
  if (!movie || typeof movie !== 'object') return false;
  if (isExcludedSeriesItem(movie)) return false;

  const langCode = String(seriesVirtualState.infiniteScrollLang || '').toLowerCase();
  if (langCode) {
    const itemLangCode = String(movie.langCode || getLangCode(movie.language) || '').toLowerCase();
    if (itemLangCode !== langCode) return false;
  }

  const genre = String(seriesVirtualState.infiniteScrollGenre || '').toLowerCase();
  if (genre) {
    const genres = getGenreList(movie).map((g) => g.toLowerCase());
    if (!genres.includes(genre)) return false;
  }

  const year = seriesVirtualState.infiniteScrollYear;
  if (year && String(movie.year || '') !== String(year)) return false;

  return true;
}

/* ===================================================
   TOP NOW — with language filter
   =================================================== */
function topDateYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function rankTopCurrent(items, type) {
  const isTV = type === 'tv' || type === 'series';
  const currentYear = new Date().getFullYear();

  const scored = (items || []).map(item => {
    const dateStr = isTV ? item.first_air_date : item.release_date;
    const year = dateStr ? Number(String(dateStr).slice(0, 4)) : 0;
    const rating = Number(item.vote_average || 0);
    const votes = Number(item.vote_count || 0);
    const pop = Number(item.popularity || 0);
    const age = year ? Math.max(0, currentYear - year) : 20;

    // Strongly prefer currently watched titles: popularity + social proof + quality + recency.
    const score =
      (pop * 0.55) +
      (Math.log10(votes + 1) * 14) +
      (rating * 7.5) -
      (age * 1.3);

    return { item, score, rating, votes, year };
  });

  return scored
    .filter(x => x.rating >= 6.2 && x.votes >= 40 && x.year >= (currentYear - 12))
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

async function fetchTopCurrent(type = 'movie', langCode = 'all') {
  const topType = (type === 'tv' || type === 'series') ? 'tv' : 'movie';
  const params = new URLSearchParams({
    type: topType,
    language: langCode || 'all',
    limit: '10'
  });

  const data = await fetchJson(`http://localhost:5000/api/recommendations/top-now?${params.toString()}`);
  return Array.isArray(data?.movies) ? data.movies : [];
}

async function loadTopNow(langCode = 'all') {
  try {
    const [topMovies, topSeries] = await Promise.all([
      fetchTopCurrent('movie', langCode),
      fetchTopCurrent('tv', langCode)
    ]);

    renderTopList('topMoviesContainer', topMovies, 'movie');
    renderTopList('topSeriesContainer', topSeries, 'series');
  } catch (e) {
    console.warn('loadTopNow failed:', e);
    renderFallbackTopNow();
  }
}

async function setTopRegion(langCode, btn) {
  document.querySelectorAll('#homeTopSection .top-lang-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const mc = document.getElementById('topMoviesContainer');
  const sc = document.getElementById('topSeriesContainer');
  if (mc) mc.innerHTML = '<div class="skeleton-list"></div>';
  if (sc) sc.innerHTML = '<div class="skeleton-list"></div>';
  try {
    await loadTopNow(langCode);
  } catch(e) {
    console.warn('Top region load failed:', e);
  }
}

async function setMoviesRegion(langCode, btn) {
  document.querySelectorAll('#moviesPage .top-lang-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const c = document.getElementById('topMoviesPageContainer');
  if (c) c.innerHTML = '<div class="skeleton-list" style="height:200px"></div>';
  try {
    const items = await fetchTopCurrent('movie', langCode);
    renderTopListHorizontal('topMoviesPageContainer', items, 'movie');
  } catch(e) { console.warn(e); }
}

async function setSeriesRegion(langCode, btn) {
  document.querySelectorAll('#seriesPage .top-lang-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const c = document.getElementById('topSeriesPageContainer');
  if (c) c.innerHTML = '<div class="skeleton-list" style="height:200px"></div>';
  try {
    const items = await fetchTopCurrent('tv', langCode);
    renderTopListHorizontal('topSeriesPageContainer', items, 'series');
  } catch(e) { console.warn(e); }
}

function renderFallbackTopNow() {
  const topMovies = [...allMovies]
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, 10);
  renderTopList('topMoviesContainer', topMovies, 'movie', true);
  renderTopList('topSeriesContainer', [], 'series');
}

function renderTopList(containerId, items, type, isLocal = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = '<p class="text-muted small">No data available.</p>';
    return;
  }

  container.innerHTML = items.map((item, index) => {
    const title = item.title || item.name || 'Untitled';
    const rating = Number(item.vote_average || item.rating || 0).toFixed(1);
    const posterPath = item.poster_path ? `${TMDB_IMG_W500}${item.poster_path}` : (item.posterUrl || '');
    const langCode = item.original_language || item.langCode || '';
    const langLabel = mapLanguage(langCode);
    const tmdbId = item.id || item.tmdbId;

    const onclick = `openMovie(${tmdbId}, ${type === 'series' ? 'true' : 'false'})`;

    return `
      <button class="top-item" type="button" onclick="${onclick}">
        <span class="top-rank">#${index + 1}</span>
        ${posterPath ? `<img src="${posterPath}" class="top-poster-thumb" alt="${escapeHtml(title)}" loading="lazy" decoding="async" width="64" height="96" onerror="this.style.display='none'">` : ''}
        <span class="top-title">${escapeHtml(title)}</span>
        <span class="top-meta">
          <span class="top-rate"><i class="bi bi-star-fill"></i> ${rating}</span>
          ${langLabel !== 'Unknown' ? `<span class="top-lang">${langLabel}</span>` : ''}
        </span>
      </button>
    `;
  }).join('');
}

function renderTopListHorizontal(containerId, items, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!items?.length) {
    container.innerHTML = '<p class="text-muted small">No data available.</p>';
    return;
  }

  container.innerHTML = items.map((item, index) => {
    const title = item.title || item.name || 'Untitled';
    const rating = Number(item.vote_average || item.rating || 0).toFixed(1);
    const posterPath = item.poster_path ? `${TMDB_IMG_W500}${item.poster_path}` : (item.posterUrl || PLACEHOLDER);
    const tmdbId = item.id || item.tmdbId;
    const isTV = type === 'series';
    return `
      <div class="top-item-card" onclick="openMovie(${tmdbId}, ${isTV})">
        <span class="top-item-rank">#${index + 1}</span>
        <img src="${posterPath}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" width="342" height="342" onerror="this.src='${PLACEHOLDER}'">
        <div class="top-item-card-body">
          <h6>${escapeHtml(title)}</h6>
          <div class="top-rate"><i class="bi bi-star-fill"></i> ${rating}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadSection(containerId, params = {}, type = 'movie', sectionKey = '') {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (sectionKey && homeCache[sectionKey]) {
    renderHorizontalRow(containerId, homeCache[sectionKey], type === 'tv' ? 'series' : 'movie');
    return;
  }

  container.innerHTML = '<div class="skeleton-list" style="height:180px"></div>';

  const query = new URLSearchParams({ ...params, type, limit: 10, page: 1 });
  const res = await fetch(`http://localhost:5000/api/movies?${query}`);
  if (!res.ok) throw new Error(`Failed section ${containerId}: ${res.status}`);

  const data = await res.json();
  if (sectionKey) homeCache[sectionKey] = data;
  renderHorizontalRow(containerId, data, type === 'tv' ? 'series' : 'movie');
}

function getUserRating(movieId) {
  const ratings = getStoredRatings();
  const value = Number(ratings[String(movieId)] || 0);
  return Number.isFinite(value) ? value : 0;
}

async function fetchMoviesByIds(ids) {
  const cleaned = (ids || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  if (!cleaned.length) return [];

  try {
    const query = new URLSearchParams({ ids: cleaned.join(','), limit: String(Math.max(cleaned.length, 10)) });
    const res = await fetch(`http://localhost:5000/api/movies?${query}`);
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    return list
      .map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m))
      .sort((a, b) => cleaned.indexOf(Number(a.id || a.tmdbId)) - cleaned.indexOf(Number(b.id || b.tmdbId)));
  } catch (_err) {
    return [];
  }
}

async function loadWatchlistRow() {
  const container = document.getElementById('homeWatchlistRow');
  if (!container) return;

  const ids = getStoredWatchlist()
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  const rowWrapper = container.closest('.home-row');

  if (!ids.length) {
    // Hide the entire row so there's no blank spot on the home page
    if (rowWrapper) rowWrapper.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  // Make sure row is visible (in case it was previously hidden)
  if (rowWrapper) rowWrapper.style.display = '';

  let movies = ids
    .map((id) => allMovies.find((m) => Number(m.id) === id) || allSeries.find((m) => Number(m.id) === id))
    .filter(Boolean);

  if (movies.length < Math.min(ids.length, 10)) {
    const fromApi = await fetchMoviesByIds(ids);
    if (fromApi.length) {
      mergeMovies(fromApi);
      movies = ids
        .map((id) => allMovies.find((m) => Number(m.id) === id) || allSeries.find((m) => Number(m.id) === id))
        .filter(Boolean);
    }
  }

  renderHorizontalRow('homeWatchlistRow', movies.slice(0, 12), 'movie');
}

async function loadContinueWatchingRow() {
  const container = document.getElementById('homeContinueWatchingRow');
  if (!container) return;

  const ids = getContinueWatchingItems()
    .slice(0, 20)
    .map((item) => Number(item.id))
    .filter((id) => Number.isFinite(id));

  const rowWrapper = container.closest('.home-row');

  if (!ids.length) {
    // Hide entirely so there's no blank spot
    if (rowWrapper) rowWrapper.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  if (rowWrapper) rowWrapper.style.display = '';

  let movies = ids
    .map((id) => allMovies.find((m) => Number(m.id) === id) || allSeries.find((m) => Number(m.id) === id))
    .filter(Boolean);

  if (movies.length < Math.min(ids.length, 10)) {
    const fromApi = await fetchMoviesByIds(ids);
    if (fromApi.length) {
      mergeMovies(fromApi);
      movies = ids
        .map((id) => allMovies.find((m) => Number(m.id) === id) || allSeries.find((m) => Number(m.id) === id))
        .filter(Boolean);
    }
  }

  renderHorizontalRow('homeContinueWatchingRow', movies.slice(0, 12), 'mixed');
}

function getFavoriteGenresFromRatings() {
  const ratings = getStoredRatings();
  const ratedIds = Object.keys(ratings)
    .filter((id) => Number(ratings[id]) >= 4)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  const genreScore = new Map();
  const languageScore = new Map();

  ratedIds.forEach((id) => {
    const movie = allMovies.find((m) => Number(m.id) === id) || allSeries.find((m) => Number(m.id) === id);
    if (!movie) return;
    const score = Number(ratings[String(id)] || 0);
    (movie.genre || []).forEach((g) => {
      genreScore.set(g, (genreScore.get(g) || 0) + score);
    });
    if (movie.langCode) {
      languageScore.set(movie.langCode, (languageScore.get(movie.langCode) || 0) + score);
    }
  });

  const topGenres = [...genreScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([genre]) => genre);

  const topLanguage = [...languageScore.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { topGenres, topLanguage };
}

async function loadRecommendedRow() {
  const container = document.getElementById('homeRecommendedRow');
  if (!container) return;

  if (currentUser?._id && authToken) {
    try {
      const res = await fetch(`http://localhost:5000/api/recommendations/${currentUser._id}`, {
        headers: { ...authHeaders() }
      });

      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data.movies) ? data.movies : [];
        const normalized = list.map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m));
        renderHorizontalRow('homeRecommendedRow', normalized.slice(0, 12), 'mixed');
        return;
      }
    } catch (_err) {
      // Fallback to local strategy below.
    }
  }

  const { topGenres, topLanguage } = getFavoriteGenresFromRatings();
  if (!topGenres.length) {
    container.innerHTML = '<p class="text-muted small">Rate a few movies to unlock personalized picks.</p>';
    return;
  }

  const query = new URLSearchParams({
    genre: topGenres.join(','),
    minRating: '5',
    minYear: '2018',
    sort: 'popularity',
    limit: '6',
    page: '1',
    type: 'movie'
  });
  if (topLanguage) query.set('language', topLanguage);

  try {
    const data = await fetchJson(`http://localhost:5000/api/movies?${query}`);
    const list = Array.isArray(data) ? data : [];
    const ratedIds = new Set(Object.keys(getStoredRatings()).map((id) => Number(id)));
    const watchlistIds = new Set(getStoredWatchlist().map((id) => Number(id)));
    const filtered = list
      .map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m))
      .filter((m) => !ratedIds.has(Number(m.id || m.tmdbId)) && !watchlistIds.has(Number(m.id || m.tmdbId)))
      .slice(0, HOME_ROW_LIMIT);

    renderHorizontalRow('homeRecommendedRow', filtered, 'mixed');
  } catch (_err) {
    container.innerHTML = '<p class="text-muted small">Unable to load recommendations right now.</p>';
  }
}

async function loadHomeRecommendationRows() {
  if (!currentUser?._id || !authToken) return false;

  try {
    const res = await fetch(`http://localhost:5000/api/recommendations/${currentUser._id}/home`, {
      headers: { ...authHeaders() }
    });
    if (!res.ok) return false;

    const data = await res.json();
    const rows = data?.rows || {};

    // ── Static named rows (always use fixed containers) ────────────────────
    const staticMap = {
      becauseYouLiked: { titleId: 'becauseLikedTitle', rowId: 'homeRecommendedRow' },
      newForYou:       { titleId: 'latestPreferredTitle', rowId: 'homeLatestPreferredRow' },
      trending:        { titleId: 'trendingTitle', rowId: 'homeTrendingRow' }
    };

    for (const [key, { titleId, rowId }] of Object.entries(staticMap)) {
      const row = rows[key];
      if (!row || !Array.isArray(row.movies) || !row.movies.length) continue;
      const titles = themeNarrativeTitles();
      const themedOverride = key === 'trending'
        ? titles.trending
        : key === 'newForYou'
          ? titles.latest
          : '';
      const nextTitle = themedOverride || row.title || '';
      if (nextTitle) {
        const el = document.getElementById(titleId);
        if (el) el.textContent = nextTitle;
      }
      const movies = row.movies.map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m));
      renderHorizontalRow(rowId, movies.slice(0, HOME_ROW_LIMIT), 'mixed');
    }

    // ── Per-language rows (movies_ and series_ prefixed keys) ──────────────
    // Rendered into the dynamic container below the static rows.
    const dynContainer = document.getElementById('homeDynamicLangRows');
    if (dynContainer) {
      const langKeys = Object.keys(rows).filter(
        (k) => k.startsWith('movies_') || k.startsWith('series_')
      );

      if (langKeys.length) {
        // Build HTML for each non-empty language row
        const html = langKeys
          .filter((k) => Array.isArray(rows[k]?.movies) && rows[k].movies.length > 0)
          .map((k) => {
            const row = rows[k];
            const safeId = `homeLangRow_${k}`;
            const isSeriesRow = k.startsWith('series_');
            const viewMoreFn = isSeriesRow ? 'showSeriesPage()' : 'showMoviesPage()';
            return `
              <div class="mb-5 home-row">
                <div class="home-row-header">
                  <h3 class="carousel-section-title mb-0">${escapeHtml(row.title || k)}</h3>
                  <button class="view-more-btn" onclick="${viewMoreFn}">View More <i class="bi bi-chevron-right"></i></button>
                </div>
                <div id="${safeId}" class="top-list-horizontal"><div class="skeleton-list" style="height:220px"></div></div>
              </div>
            `;
          })
          .join('');

        dynContainer.innerHTML = html;

        // Render each row
        langKeys.forEach((k) => {
          const row = rows[k];
          if (!Array.isArray(row?.movies) || !row.movies.length) return;
          const safeId = `homeLangRow_${k}`;
          const movies = row.movies.map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m));
          const displayType = k.startsWith('series_') ? 'series' : 'movie';
          renderHorizontalRow(safeId, movies.slice(0, HOME_ROW_LIMIT), displayType);
        });
      }
    }

    // ── Hide static language rows that the backend now replaces ───────────
    // (preferredLang / latestPreferred are now in per-language rows above)
    const oldLangRow = document.getElementById('homePreferredLangRow');
    if (oldLangRow) {
      const wrapper = oldLangRow.closest('.home-row');
      if (wrapper) wrapper.style.display = 'none';
    }

    return true;
  } catch (_err) {
    return false;
  }
}

async function loadPreferredLanguageRow() {
  const langs = userLangs();
  const titles = themeNarrativeTitles();
  const title = document.getElementById('preferredLangTitle');
  if (title) {
    const labels = langs.slice(0, 4).map((code) => mapLanguage(code));
    title.textContent = `${titles.preferred} (${labels.join(', ')})`;
  }

  // Fetch movies + series for ALL selected languages concurrently
  const requests = langs.slice(0, 4).flatMap((lang) => {
    const common = {
      language: lang,
      minYear: 2018,
      minRating: 5,
      sort: 'popularity',
      limit: 6,
      page: 1
    };
    return [
      fetchJson(`http://localhost:5000/api/movies?${new URLSearchParams({ ...common, type: 'movie' })}`),
      fetchJson(`http://localhost:5000/api/movies?${new URLSearchParams({ ...common, type: 'tv' })}`)
    ];
  });

  try {
    const payloads = await Promise.all(requests);

    const merged = payloads
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m));

    const unique = [];
    const seen = new Set();
    merged.forEach((m) => {
      const key = `${m.isTV ? 'tv' : 'movie'}:${m.id || m.tmdbId}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(m);
    });

    // Sort: interleave by popularity, then sort each lang group so all langs are represented
    unique.sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));
    renderHorizontalRow('homePreferredLangRow', unique.slice(0, Math.max(HOME_ROW_LIMIT, 12)), 'mixed');
  } catch (_err) {
    const row = document.getElementById('homePreferredLangRow');
    if (row) row.innerHTML = '<p class="text-muted small">Unable to load language mix.</p>';
  }
}

async function loadLatestPreferredRow() {
  const langs = userLangs();
  const [primary] = langs;
  const titles = themeNarrativeTitles();
  const title = document.getElementById('latestPreferredTitle');
  if (title) {
    const label = mapLanguage(primary) || primary;
    title.textContent = langs.length > 1
      ? `${titles.latest} (${label} & more)`
      : `${titles.latest} (${label})`;
  }

  const common = {
    latest: 'true',
    minRating: '5',
    sort: 'latest',
    limit: '6',
    page: '1'
  };

  // Fetch latest movies + series for up to 2 preferred languages
  const requests = langs.slice(0, 2).flatMap((lang) => [
    fetchJson(`http://localhost:5000/api/movies?${new URLSearchParams({ ...common, language: lang, type: 'movie' })}`),
    fetchJson(`http://localhost:5000/api/movies?${new URLSearchParams({ ...common, language: lang, type: 'tv' })}`)
  ]);

  try {
    const payloads = await Promise.all(requests);
    const combined = payloads
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .map((m) => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m));

    // Deduplicate
    const seen = new Set();
    const unique = combined.filter((m) => {
      const key = `${m.isTV ? 'tv' : 'movie'}:${m.id || m.tmdbId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => Number(b.year || 0) - Number(a.year || 0) || Number(b.popularity || 0) - Number(a.popularity || 0));
    renderHorizontalRow('homeLatestPreferredRow', unique.slice(0, Math.max(HOME_ROW_LIMIT, 12)), 'mixed');
  } catch (_err) {
    const row = document.getElementById('homeLatestPreferredRow');
    if (row) row.innerHTML = '<p class="text-muted small">Unable to load latest picks.</p>';
  }
}

async function renderDynamicLanguageRows() {
  const container = document.getElementById('homeDynamicLangRows');
  if (!container) return;

  const langs = userLangs();
  if (langs.length <= 1) {
    container.innerHTML = '';
    return;
  }

  const extra = langs.slice(1, 4);
  container.innerHTML = extra.map((lang) => {
    const label = mapLanguage(lang);
    return `
      <div class="mb-4 home-row">
        <h3 class="carousel-section-title mb-2">🔥 Popular in ${escapeHtml(label)}</h3>
        <div id="homeLangRow_${escapeHtml(lang)}" class="top-list-horizontal"><div class="skeleton-list" style="height:180px"></div></div>
      </div>
    `;
  }).join('');

  await Promise.all(extra.map((lang) => loadSection(`homeLangRow_${lang}`, {
    language: lang,
    sort: 'popularity',
    minYear: 2018,
    minRating: 5
  }, 'movie', `lang:${lang}`)));
}

async function refreshPersonalizedHome() {
  homeCache.preferredLang = null;
  homeCache.latestPreferred = null;

  await Promise.all([
    loadContinueWatchingRow(),
    loadPreferredLanguageRow(),
    loadLatestPreferredRow(),
    loadWatchlistRow(),
    loadHomeSectionByKey('trending')
  ]);
}

async function loadHomeSectionByKey(key) {
  const cfg = HOME_SECTION_CONFIG[key];
  if (!cfg) return;
  if (cfg.custom === 'continueWatching') return loadContinueWatchingRow();
  if (cfg.custom === 'watchlist') return loadWatchlistRow();
  if (cfg.custom === 'preferredLang') return loadPreferredLanguageRow();
  if (cfg.custom === 'latestPreferred') return loadLatestPreferredRow();
  return loadSection(cfg.containerId, cfg.params, cfg.type, key);
}

function renderHorizontalRow(containerId, movies, type = 'movie') {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Hide row wrapper completely if no data
  if (!movies?.length) {
    const rowWrapper = container.closest('.home-row');
    if (rowWrapper) rowWrapper.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  // Make sure row is visible
  const rowWrapper = container.closest('.home-row');
  if (rowWrapper) rowWrapper.style.display = '';

  container.classList.add('top-list-horizontal');
  container.innerHTML = movies.slice(0, HOME_ROW_LIMIT).map((m) => {
    const title = m.title || m.name || 'Untitled';
    const rating = Number(m.rating || m.vote_average || 0);
    const ratingStr = rating > 0 ? rating.toFixed(1) : null;
    const posterPath = m.poster_path ? `${TMDB_IMG_W500}${m.poster_path}` : (m.posterUrl || PLACEHOLDER);
    const tmdbId = m.id || m.tmdbId;
    const isTV = type === 'mixed' ? Boolean(m.isTV) : type === 'series';
    const langCode = m.langCode || m.original_language || '';
    const langLabel = LANG_CODE_MAP[langCode] || '';
    const firstGenre = (m.genre || []).filter(g => g && g.toLowerCase() !== 'series')[0] || '';
    const year = m.year || '';
    const ratingClass = rating >= 8 ? 'rating-high' : rating >= 7 ? 'rating-mid' : 'rating-low';
    return `
      <div class="home-row-card" data-movie-id="${tmdbId}" data-is-tv="${isTV ? 'true' : 'false'}" onclick="openMovie(${tmdbId}, ${isTV})">
        <div class="home-row-card-img">
          <img src="${posterPath}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" width="200" height="300" onerror="this.src='${PLACEHOLDER}'">
          ${ratingStr ? `<span class="home-row-rating ${ratingClass}"><i class="bi bi-star-fill"></i> ${ratingStr}</span>` : ''}
          ${isTV ? '<span class="home-row-type-badge">Series</span>' : ''}
        </div>
        <div class="home-row-card-body">
          <p class="home-row-title">${escapeHtml(title)}</p>
          <p class="home-row-meta">${[firstGenre, year].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
    `;
  }).join('');

  prefetchTrailerKeysForContainer(container, 10);
}

function prefetchTrailerKeysForContainer(container, maxCards = 16) {
  if (!HAS_TMDB || !container || !ENABLE_CARD_PROVIDER_PREVIEW) return;

  const cards = Array.from(container.querySelectorAll('.movie-card, .top-item-card')).slice(0, maxCards);
  if (!cards.length) return;

  if (!trailerPrefetchObserver) {
    trailerPrefetchObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const card = entry.target;
        const movieId = Number(card.getAttribute('data-movie-id'));
        const isTV = card.getAttribute('data-is-tv') === 'true';
        if (Number.isFinite(movieId)) {
          preloadProviders(movieId, isTV).catch(() => {});
          hydrateCardProviderPreview(card, movieId, isTV).catch(() => {});
        }
        trailerPrefetchObserver.unobserve(card);
      });
    }, { root: null, rootMargin: '220px 0px', threshold: 0.1 });
  }

  cards.forEach((card) => {
    trailerPrefetchObserver.observe(card);
  });
}

async function preloadProviders(movieId, isTV = false) {
  return getProviderPreview(movieId, isTV);
}

async function getProviderPreview(movieId, isTV = false) {
  if (!HAS_TMDB || !Number.isFinite(Number(movieId))) return [];
  const key = `${isTV ? 'tv' : 'movie'}:${movieId}`;
  if (Object.prototype.hasOwnProperty.call(providerPreviewCache, key)) {
    return providerPreviewCache[key];
  }

  try {
    const endpoint = isTV ? `/tv/${movieId}/watch/providers` : `/movie/${movieId}/watch/providers`;
    const data = await tmdbGet(endpoint);
    const region = data.results?.IN || data.results?.US || null;
    const platforms = (region?.flatrate || []).slice(0, 4).map((p) => ({
      name: p.provider_name,
      logoPath: p.logo_path || ''
    }));
    providerPreviewCache[key] = platforms;
    return platforms;
  } catch (_err) {
    providerPreviewCache[key] = [];
    return [];
  }
}

async function hydrateCardProviderPreview(card, movieId, isTV = false) {
  const target = card.querySelector('[data-provider-target]');
  if (!target) return;
  const providers = await getProviderPreview(movieId, isTV);
  const title = card.getAttribute('data-movie-title') || '';
  if (!providers.length) {
    target.innerHTML = '<span class="provider-empty">OTT unavailable</span>';
    return;
  }
  target.innerHTML = providers.map((p) => {
    const logo = p.logoPath ? `https://image.tmdb.org/t/p/w45${p.logoPath}` : '';
    const link = `https://www.google.com/search?q=${encodeURIComponent(`${title} watch on ${p.name}`)}`;
    return `
      <a href="${link}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(p.name)}" onclick="event.stopPropagation()">
        ${logo ? `<img src="${logo}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async"/>` : `<span>${escapeHtml(p.name)}</span>`}
      </a>
    `;
  }).join('');
}

async function loadHomeDiscoverSections() {
  if (homeRowsLoaded) return;
  setupHomeSectionObserver();
}

function setupHomeSectionObserver() {
  if (homeSectionObserver) return;

  const rows = document.querySelectorAll('.home-row[data-section-key]');
  if (!rows.length) return;

  homeSectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const row = entry.target;
      const key = row.getAttribute('data-section-key');
      if (!key || row.getAttribute('data-loaded') === 'true') {
        homeSectionObserver.unobserve(row);
        return;
      }

      row.setAttribute('data-loaded', 'loading');
      loadHomeSectionByKey(key)
        .then(() => row.setAttribute('data-loaded', 'true'))
        .catch(() => row.setAttribute('data-loaded', 'error'))
        .finally(() => {
          if (homeSectionObserver) homeSectionObserver.unobserve(row);
          const allRows = Array.from(document.querySelectorAll('.home-row[data-section-key]'));
          if (allRows.length && allRows.every((r) => r.getAttribute('data-loaded') === 'true')) {
            homeRowsLoaded = true;
          }
        });
    });
  }, {
    root: null,
    rootMargin: '220px 0px',
    threshold: 0.05
  });

  rows.forEach((row) => homeSectionObserver.observe(row));
}

/* ===================================================
   PAGE NAVIGATION
   =================================================== */
function setActivePage(page, options = {}) {
  const {
    skipHistory = false,
    replaceHistory = false,
    url = null,
    preserveScroll = false
  } = options;

  currentPage = page;
  // Hide all pages
  ['homePage','moviesPage','seriesPage','detailPage'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Show requested
  const map = { home: 'homePage', movies: 'moviesPage', series: 'seriesPage', detail: 'detailPage' };
  const target = document.getElementById(map[page]);
  if (target) target.style.display = 'block';

  // Update nav highlights
  document.querySelectorAll('.nav-home, .nav-movies, .nav-series').forEach(a => a.classList.remove('nav-active'));
  if (page === 'home') document.querySelector('.nav-home')?.classList.add('nav-active');
  if (page === 'movies') document.querySelector('.nav-movies')?.classList.add('nav-active');
  if (page === 'series') document.querySelector('.nav-series')?.classList.add('nav-active');

  if (!skipHistory) {
    const state = {
      page: currentPage,
      previousPage,
      navigationHistory: JSON.parse(JSON.stringify(navigationHistory)),
      currentDetailMovieId,
      currentDetailIsTV
    };
    const nextUrl = url || getPageRouteUrl(page);
    if (replaceHistory) {
      window.history.replaceState(state, '', nextUrl);
    } else {
      window.history.pushState(state, '', nextUrl);
    }
  }

  if (!preserveScroll) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function getPageRouteUrl(page) {
  if (page === 'movies') return '/movies';
  if (page === 'series') return '/series';
  if (page === 'detail' && Number.isFinite(Number(currentDetailMovieId))) {
    return `/movie/${Number(currentDetailMovieId)}?tv=${currentDetailIsTV ? 'true' : 'false'}`;
  }
  return '/';
}

function applyRouteFromLocation(options = {}) {
  const { replaceHistory = false } = options;
  const path = window.location.pathname || '/';
  const movieMatch = path.match(/^\/movie\/(\d+)/);

  if (movieMatch) {
    const movieId = Number(movieMatch[1]);
    const isTV = new URLSearchParams(window.location.search).get('tv') === 'true';
    if (Number.isFinite(movieId)) {
      showDetailPage(movieId, isTV, { replaceHistory });
      return;
    }
  }

  if (path === '/movies') {
    showMoviesPage({ replaceHistory });
    return;
  }

  if (path === '/series') {
    showSeriesPage({ replaceHistory });
    return;
  }

  setActivePage('home', { replaceHistory, url: '/' });
}

function showHome(options = {}) {
  if (options.restoreOnly && hasPageSelectionState('home')) {
    setActivePage('home', { ...options, preserveScroll: true });
    restorePageSelectionState('home');
    return;
  }

  navigationHistory = [];
  previousPage = 'home';
  setActivePage('home', options);
  loadHome().catch(err => console.warn('Home load failed:', err));
}

async function loadHome() {
  // Use user's primary language for Top 10 if logged in
  const primaryLang = currentUser?.preferredLanguages?.[0] || 'all';
  loadTopNow(primaryLang).catch(() => {});
  refreshPersonalizedHome().catch(() => {});
}

function scrollToWatchlist() {
  showHome();
  setTimeout(() => {
    document.getElementById('watchlist')?.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function scrollToReviews() {
  showHome();
  setTimeout(() => {
    document.getElementById('review-section')?.scrollIntoView({ behavior: 'smooth' });
  }, 100);
}

function showMoviesPageWithSort(sort) {
  showMoviesPage().then(() => {
    const sel = document.getElementById('moviesSortFilter');
    if (sel) {
      sel.value = sort;
      applyMoviesPageFilters();
    }
  }).catch(() => {});
}

async function showMoviesPage(options = {}) {
  previousPage = currentPage === 'detail' ? previousPage : currentPage;

  if (options.restoreOnly && hasPageSelectionState('movies')) {
    setActivePage('movies', { ...options, preserveScroll: true });
    restorePageSelectionState('movies');
    return;
  }

  setActivePage('movies', options);

  // Set default sort to trending
  const sortSel = document.getElementById('moviesSortFilter');
  if (sortSel && !options.keepFilters) {
    // Only set default if it's still set to an old value
    if (sortSel.value === 'popularity') sortSel.value = 'trending';
  }

  // Load top 10 movies if not loaded
  if (HAS_TMDB) {
    const c = document.getElementById('topMoviesPageContainer');
    if (c && c.querySelector('.skeleton-list')) {
      try {
        const items = await fetchTopCurrent('movie', 'all');
        renderTopListHorizontal('topMoviesPageContainer', items, 'movie');
      } catch(e) { console.warn(e); }
    }

    // Load movies grid if empty
    if (!allMovies.length) {
      try {
        await loadMoviesFromBackend({ reset: true, pages: 1, limit: API_LIST_LIMIT, sort: 'trending', type: 'movie' });
      } catch (_backendErr) {
        await loadMoviesFromApi({ reset: true, pages: 8 });
      }
    } else {
      renderMoviesPage(allMovies);
    }
  }

  populateMoviesPageFilters();
  applyMoviesPageFilters();
}

async function showSeriesPage(options = {}) {
  previousPage = currentPage === 'detail' ? previousPage : currentPage;

  if (options.restoreOnly && hasPageSelectionState('series')) {
    setActivePage('series', { ...options, preserveScroll: true });
    restorePageSelectionState('series');
    return;
  }

  setActivePage('series', options);

  // Set default sort to trending
  const sortSel = document.getElementById('seriesSortFilter');
  if (sortSel && !options.keepFilters && sortSel.value === 'popularity') sortSel.value = 'trending';

  // Load top 10 series if not loaded
  if (HAS_TMDB) {
    const c = document.getElementById('topSeriesPageContainer');
    if (c && c.querySelector('.skeleton-list')) {
      try {
        const items = await fetchTopCurrent('tv', 'all');
        renderTopListHorizontal('topSeriesPageContainer', items, 'series');
      } catch(e) { console.warn(e); }
    }
  }

  // Load series grid — backend first, TMDB fallback
  if (!allSeries.length) {
    renderSkeletonCards('seriesPageContainer', 24);
    try {
      await loadSeriesFromBackend({ reset: true, pages: 2, limit: 24, sort: 'trending' });
    } catch (_backendErr) {
      if (HAS_TMDB) {
        try {
          await loadSeriesFromApi({ reset: true, pages: 3 });
        } catch (e) { console.warn('Series TMDB fallback failed:', e); }
      }
    }
  }

  renderSeriesGrid(allSeries);
  populateSeriesFilters();
  applySeriesFilters();
}

/* ===================================================
   EVENT LISTENERS
   =================================================== */
function setupEventListeners() {
  // Search
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSearchDropdown();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrapper')) closeSearchDropdown();
    });
  }

  // Home filters
  ['genreFilter', 'languageFilter', 'yearFilter', 'sortFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyFilters);
  });

  // Movies page filters
  ['moviesLangFilter', 'moviesGenreFilter', 'moviesYearFilter', 'moviesSortFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyMoviesPageFilters);
  });

  // Series page filters
  ['seriesLangFilter', 'seriesGenreFilter', 'seriesYearFilter', 'seriesSortFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applySeriesFilters);
  });

  const homeLoadBtn = document.getElementById('loadMoreBtn');
  const moviesLoadBtn = document.getElementById('moviesLoadMoreBtn');
  const seriesLoadBtn = document.getElementById('seriesLoadMoreBtn');
  if (homeLoadBtn) homeLoadBtn.style.display = 'none';
  if (moviesLoadBtn) moviesLoadBtn.style.display = 'none';
  if (seriesLoadBtn) seriesLoadBtn.style.display = 'none';

  let moviesVirtualScrollRaf = 0;
  let moviesLoadDebounceTimer = 0;
  // Unified infinite scroll: movies + series pages (window-level)
  let seriesScrollLock = false;
  let moviesWindowScrollLock = false;

  window.addEventListener('scroll', async () => {
    // Virtual scroll rendering for movies page
    if (currentPage === 'movies') {
      if (moviesVirtualScrollRaf) return;
      moviesVirtualScrollRaf = requestAnimationFrame(() => {
        moviesVirtualScrollRaf = 0;
        virtualScrollMovies();
      });
    }

    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 2000;

    clearTimeout(moviesLoadDebounceTimer);
    moviesLoadDebounceTimer = setTimeout(async () => {
      // --- Movies page infinite scroll (window-level fallback) ---
      if (currentPage === 'movies' && nearBottom && !moviesWindowScrollLock) {
        // Don't infinite scroll on client-side sorts
        if (moviesVirtualState.clientSideSort) return;
        if (moviesVirtualState.hasMoreBackend && !moviesVirtualState.isFetchingBackend) {
          moviesWindowScrollLock = true;
          try {
            const batch = await loadMoviesFromBackend({
              pages: 1,
              limit: API_LIST_LIMIT,
              language: moviesVirtualState.infiniteScrollLang || null,
              genre: moviesVirtualState.infiniteScrollGenre || null,
              year: moviesVirtualState.infiniteScrollYear || null,
              search: moviesVirtualState.infiniteScrollSearch || null,
              type: 'movie',
              sort: moviesVirtualState.infiniteScrollSort || 'trending'
            });

            if (Array.isArray(batch) && batch.length) {
              appendMoviesPage(batch);
            }
            const el = document.getElementById('moviesResultsCount');
            if (el) el.textContent = `${allMovies.length.toLocaleString()} movies loaded`;
          } catch (err) {
            console.warn('Movies infinite scroll failed:', err);
          } finally {
            moviesWindowScrollLock = false;
          }
        }
      }

      // --- Series page infinite scroll ---
      if (currentPage === 'series' && nearBottom && !seriesScrollLock) {
        // Don't infinite scroll on client-side sorts
        if (seriesVirtualState.clientSideSort) return;
        // No more backend/TMDB data — show end indicator and stop
        if (!seriesVirtualState.hasMoreBackend && (!HAS_TMDB || !seriesVirtualState.hasMoreTmdb)) {
          const el = document.getElementById('seriesResultsCount');
          if (el && !el.dataset.endShown) {
            el.dataset.endShown = '1';
            const count = (el.textContent || '').replace(/\s*—.*$/, '').trim();
            el.textContent = `${count} — end of results`;
          }
          return;
        }
        seriesScrollLock = true;
        isLoadingMore = true;
        try {
          // Try backend first
          if (seriesVirtualState.hasMoreBackend && !seriesVirtualState.isFetchingBackend) {
            const batch = await loadSeriesFromBackend({
              pages: 1,
              limit: seriesVirtualState.backendLimit,
              language: seriesVirtualState.infiniteScrollLang || null,
              genre: seriesVirtualState.infiniteScrollGenre || null,
              year: seriesVirtualState.infiniteScrollYear || null,
              sort: seriesVirtualState.infiniteScrollSort || 'trending'
            });
            if (Array.isArray(batch) && batch.length) {
              // Filter unsupported genres and malformed records before appending.
              const filtered = batch.filter(matchesSeriesActiveFilters);
              if (filtered.length) appendSeriesPage(filtered);
              const el = document.getElementById('seriesResultsCount');
              if (el) {
                const shown = document.getElementById('seriesPageContainer')?.querySelectorAll('.movie-card-wrapper').length || 0;
                el.textContent = `${shown.toLocaleString()} series loaded`;
              }
            }
          } else if (HAS_TMDB && seriesVirtualState.hasMoreTmdb) {
            const newItems = await loadSeriesFromApi({
              pages: 2,
              langCode: seriesVirtualState.infiniteScrollLang || null,
              render: false
            });

            if (!Array.isArray(newItems) || !newItems.length) {
              seriesVirtualState.hasMoreTmdb = false;
            } else {
              const filtered = newItems.filter(matchesSeriesActiveFilters);
              if (filtered.length) appendSeriesPage(filtered);
            }

            const el = document.getElementById('seriesResultsCount');
            if (el) {
              const shown = document.getElementById('seriesPageContainer')?.querySelectorAll('.movie-card-wrapper').length || 0;
              el.textContent = `${shown.toLocaleString()} series loaded`;
            }
          }
        } finally {
          isLoadingMore = false;
          seriesScrollLock = false;
        }
      }
    }, 150);
  }, { passive: true });

  // Grid / List view
  document.getElementById('gridView')?.addEventListener('click', () => {
    document.getElementById('movieContainer').classList.remove('list-view');
    document.getElementById('gridView').classList.add('active');
    document.getElementById('listView').classList.remove('active');
  });

  document.getElementById('listView')?.addEventListener('click', () => {
    document.getElementById('movieContainer').classList.add('list-view');
    document.getElementById('listView').classList.add('active');
    document.getElementById('gridView').classList.remove('active');
  });

  // Theme switcher
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.getAttribute('data-theme')));
  });

  // Star rating (home reviews)
  document.querySelectorAll('.star:not(.detail-star)').forEach(star => {
    star.addEventListener('click', () => {
      currentRating = Number(star.getAttribute('data-rating'));
      document.querySelectorAll('.star:not(.detail-star)').forEach(s => {
        s.classList.toggle('active', Number(s.getAttribute('data-rating')) <= currentRating);
      });
    });
    star.addEventListener('mouseenter', () => {
      const val = Number(star.getAttribute('data-rating'));
      document.querySelectorAll('.star:not(.detail-star)').forEach(s => {
        s.classList.toggle('hover', Number(s.getAttribute('data-rating')) <= val);
      });
    });
    star.addEventListener('mouseleave', () => {
      document.querySelectorAll('.star:not(.detail-star)').forEach(s => s.classList.remove('hover'));
    });
  });

  // Review form
  document.getElementById('reviewForm')?.addEventListener('submit', handleReviewSubmit);

  // Mood filter chips
  document.querySelectorAll('.mood-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const isActive = chip.classList.contains('active');
      document.querySelectorAll('.mood-chip').forEach(c => c.classList.remove('active'));
      if (!isActive) chip.classList.add('active');
      applyMoodFilter();
    });
  });

  // Quick tags
  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const isActive = tag.classList.contains('active');
      document.querySelectorAll('.quick-tag').forEach(t => t.classList.remove('active'));
      if (!isActive) tag.classList.add('active');
      applyQuickTag();
    });
  });
}

/* ===================================================
   MOOD FILTER — maps moods to genres
   =================================================== */
const MOOD_GENRE_MAP = {
  happy:    ['Comedy', 'Animation', 'Family', 'Music', 'Musical'],
  dark:     ['Horror', 'Thriller', 'Crime', 'Mystery'],
  action:   ['Action', 'Adventure', 'War', 'Action & Adventure', 'War & Politics'],
  romantic: ['Romance'],
  scifi:    ['Sci-Fi', 'Sci-Fi & Fantasy', 'Fantasy'],
  drama:    ['Drama']
};

function applyMoodFilter() {
  const activeChip = document.querySelector('.mood-chip.active');
  const mood = activeChip?.getAttribute('data-mood');

  // Also clear quick tags when mood changes
  document.querySelectorAll('.quick-tag').forEach(t => t.classList.remove('active'));

  if (!mood) {
    filteredMovies = [...allMovies];
  } else {
    const targetGenres = MOOD_GENRE_MAP[mood] || [];
    filteredMovies = allMovies.filter(m =>
      (m.genre || []).some(g => targetGenres.some(tg => g.toLowerCase().includes(tg.toLowerCase())))
    );
  }

  renderMovies(filteredMovies);
  const el = document.getElementById('resultsCount');
  if (el) el.textContent = `${filteredMovies.length.toLocaleString()} movies`;
}

/* ===================================================
   QUICK TAGS
   =================================================== */
function applyQuickTag() {
  const activeTag = document.querySelector('.quick-tag.active');
  const tag = activeTag?.getAttribute('data-tag');

  // Clear mood chips
  document.querySelectorAll('.mood-chip').forEach(c => c.classList.remove('active'));

  if (!tag) {
    filteredMovies = [...allMovies];
  } else if (tag === 'trending') {
    filteredMovies = [...allMovies].sort((a, b) => Number(b.popularity) - Number(a.popularity)).slice(0, 200);
  } else if (tag === 'underrated') {
    // High rating but lower popularity rank
    filteredMovies = allMovies
      .filter(m => Number(m.rating) >= 7.5 && Number(m.popularity) < 50)
      .sort((a, b) => Number(b.rating) - Number(a.rating))
      .slice(0, 200);
  } else if (tag === 'new') {
    const currentYear = new Date().getFullYear();
    filteredMovies = allMovies
      .filter(m => Number(m.year) >= currentYear - 2)
      .sort((a, b) => Number(b.year) - Number(a.year) || Number(b.popularity) - Number(a.popularity));
  }

  renderMovies(filteredMovies);
  const el = document.getElementById('resultsCount');
  if (el) el.textContent = `${filteredMovies.length.toLocaleString()} movies`;
}

/* ===================================================
   SURPRISE ME — random movie from DB
   =================================================== */
function surpriseMe() {
  const pool = allMovies.length ? allMovies : allSeries;
  if (!pool.length) { showToast('⏳ Movies still loading, try again in a moment!'); return; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  showToast(`🎲 Surprise! Opening "${pick.title}"`);
  openMovie(pick.id, pick.isTV || false);
}

/* ===================================================
   EXPAND HOME ROW (Netflix-style inline "See All")
   =================================================== */
const homeRowExpandedCache = {};

async function expandHomeRow(rowId, sectionKey) {
  const expandedId = rowId + 'Expanded';
  const expandedEl = document.getElementById(expandedId);
  const rowEl = document.getElementById(rowId);
  const homeRowEl = rowEl?.closest('.home-row');
  const btn = homeRowEl?.querySelector('.view-more-btn');
  if (!expandedEl) return;

  // Toggle: if already open, close it
  if (expandedEl.style.display !== 'none' && expandedEl.innerHTML) {
    expandedEl.style.display = 'none';
    if (homeRowEl) homeRowEl.classList.remove('is-expanded');
    if (btn) btn.innerHTML = 'See All <i class="bi bi-chevron-down"></i>';
    return;
  }

  // Update button
  if (btn) btn.innerHTML = 'Show Less <i class="bi bi-chevron-up"></i>';
  if (homeRowEl) homeRowEl.classList.add('is-expanded');
  expandedEl.style.display = 'block';

  // If already cached, just show
  if (homeRowExpandedCache[sectionKey]) {
    renderExpandedRow(expandedEl, homeRowExpandedCache[sectionKey], sectionKey);
    return;
  }

  expandedEl.innerHTML = '<div class="row g-3" style="margin-top:12px"><div class="col-12 text-center text-muted">Loading more...</div></div>';

  try {
    let items = [];
    if (sectionKey === 'continueWatching') {
      const ids = getContinueWatchingItems().map(i => Number(i.id)).filter(Number.isFinite);
      items = await fetchMoviesByIds(ids);
    } else if (sectionKey === 'trending') {
      const data = await fetchJson('http://localhost:5000/api/movies?' + new URLSearchParams({ sort: 'trending', type: 'movie', limit: '48', page: '1' }));
      items = Array.isArray(data) ? data : [];
    } else if (sectionKey === 'preferredLang') {
      const langs = userLangs();
      const reqs = langs.slice(0, 3).map(lang =>
        fetchJson('http://localhost:5000/api/movies?' + new URLSearchParams({ language: lang, sort: 'trending', limit: '16', page: '1' }))
      );
      const results = await Promise.allSettled(reqs);
      items = results.flatMap(r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
    } else if (sectionKey === 'latestPreferred') {
      const langs = userLangs();
      const reqs = langs.slice(0, 3).flatMap(lang => [
        fetchJson('http://localhost:5000/api/movies?' + new URLSearchParams({ language: lang, type: 'movie', sort: 'latest', limit: '12', page: '1' })),
        fetchJson('http://localhost:5000/api/movies?' + new URLSearchParams({ language: lang, type: 'tv', sort: 'latest', limit: '12', page: '1' }))
      ]);
      const results = await Promise.allSettled(reqs);
      items = results.flatMap(r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
    }

    // Deduplicate
    const seen = new Set();
    items = items
      .map(m => (m.tmdbId && !m.id ? { ...m, id: m.tmdbId } : m))
      .filter(m => {
        const key = String(m.id || m.tmdbId || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    homeRowExpandedCache[sectionKey] = items;
    renderExpandedRow(expandedEl, items, sectionKey);
  } catch (err) {
    expandedEl.innerHTML = '<p class="text-muted small text-center py-3">Could not load more items.</p>';
  }
}

function renderExpandedRow(container, items, sectionKey) {
  if (!items.length) {
    container.innerHTML = '<p class="text-muted small text-center py-3">No additional items found.</p>';
    return;
  }
  // Use the full movie card grid layout
  const isSeriesRow = false; // home rows show mixed content
  container.innerHTML = `
    <div class="row g-3" style="margin-top:12px">
      ${items.map(m => createMovieCard(m, Boolean(m.isTV))).join('')}
    </div>
  `;
  setTimeout(() => attachWatchlistBtns(container), 0);
}


function renderSkeletonCards(containerId, count = 12) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => `
    <div class="col-6 col-sm-4 col-md-3 col-lg-2 movie-card-wrapper">
      <div class="movie-skeleton">
        <div class="skeleton-poster"></div>
        <div class="skeleton-body">
          <div class="skeleton-line title"></div>
          <div class="skeleton-line sub"></div>
          <div class="skeleton-line meta"></div>
        </div>
      </div>
    </div>
  `).join('');
}

/* ===================================================
   SEARCH DROPDOWN
   =================================================== */
function handleSearchInput(e) {
  const term = e.target.value.trim();
  const requestToken = ++searchRequestToken;
  clearTimeout(searchTimeout);

  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }

  if (term.length === 0) {
    closeSearchDropdown();
    applyFilters();
    return;
  }

  if (term.length < 2) {
    closeSearchDropdown();
    applyFilters();
    return;
  }

  searchTimeout = setTimeout(() => {
    renderSearchDropdown(term, requestToken);
    applyFilters();
  }, DEBOUNCE_DELAY);
}

function localSearchDropdownResults(term, limit = SEARCH_DROPDOWN_LIMIT) {
  const lower = term.toLowerCase();
  const allContent = [...allMovies, ...allSeries];

  return allContent
    .filter((m) => {
      const title = String(m.title || '').toLowerCase();
      const director = String(m.director || '').toLowerCase();
      const description = String(m.description || '').toLowerCase();
      const castMatch = Array.isArray(m.cast)
        ? m.cast.some((c) => String(typeof c === 'string' ? c : (c?.name || '')).toLowerCase().includes(lower))
        : false;

      return title.includes(lower) || director.includes(lower) || description.includes(lower) || castMatch;
    })
    .map((m) => ((m.tmdbId && !m.id) ? { ...m, id: m.tmdbId } : m))
    .slice(0, limit);
}

async function fetchSearchDropdownResults(term, limit = SEARCH_DROPDOWN_LIMIT) {
  const params = new URLSearchParams({ q: term, limit: String(limit) });
  const url = `http://localhost:5000/api/movies/search?${params.toString()}`;

  const controller = new AbortController();
  searchAbortController = controller;

  try {
    const data = await fetchJson(url, { signal: controller.signal });
    if (!Array.isArray(data)) return [];

    return data
      .map((raw) => ((raw.tmdbId && !raw.id) ? { ...raw, id: raw.tmdbId } : raw))
      .filter((m) => Number.isFinite(Number(m.id || m.tmdbId)));
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    console.warn('DB search failed, falling back to local search:', error);
    return [];
  } finally {
    if (searchAbortController === controller) searchAbortController = null;
  }
}

async function renderSearchDropdown(term, token = searchRequestToken) {
  const dropdown = document.getElementById('searchDropdown');
  if (!dropdown) return;

  dropdown.innerHTML = '<div class="search-result-item"><span class="text-muted small">Searching database...</span></div>';
  dropdown.classList.add('open');

  const dbResults = await fetchSearchDropdownResults(term, SEARCH_DROPDOWN_LIMIT);
  if (token !== searchRequestToken || dbResults === null) return;

  const results = dbResults.length
    ? dbResults
    : localSearchDropdownResults(term, SEARCH_DROPDOWN_LIMIT);

  const seen = new Set();
  const uniqueResults = results.filter((m) => {
    const key = String(m.id || m.tmdbId || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueResults.length === 0) {
    dropdown.innerHTML = '<div class="search-result-item"><span class="text-muted small">No results found</span></div>';
  } else {
    dropdown.innerHTML = uniqueResults.map(m => `
      <div class="search-result-item" onclick="selectSearchResult(${m.id}, ${m.isTV || false})">
        <img src="${m.posterUrl || PLACEHOLDER}" alt="${escapeHtml(m.title)}" onerror="this.src='${PLACEHOLDER}'">
        <div class="search-result-info">
          <span class="result-title">${escapeHtml(m.title)} ${m.isTV ? '<small style="color:var(--accent)">Series</small>' : ''}</span>
          <span class="result-meta">${m.year || 'N/A'} · ${m.language || ''} · ⭐ ${m.rating || 'N/A'}</span>
        </div>
      </div>
    `).join('');
  }

  dropdown.classList.add('open');
}

function selectSearchResult(movieId, isTV = false) {
  closeSearchDropdown();
  document.getElementById('searchInput').value = '';
  openMovie(movieId, isTV);
}

function closeSearchDropdown() {
  const dropdown = document.getElementById('searchDropdown');
  if (dropdown) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); }
}

/* ===================================================
   FILTERS — HOME PAGE
   =================================================== */
function applyFilters() {
  const searchTerm = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  const selectedGenre = document.getElementById('genreFilter')?.value || 'all';
  const selectedLang = document.getElementById('languageFilter')?.value || 'all';
  const selectedYear = document.getElementById('yearFilter')?.value || 'all';
  const sortBy = document.getElementById('sortFilter')?.value || 'popularity';

  let result = [...allMovies];

  if (searchTerm) {
    result = result.filter(m =>
      (m.title || '').toLowerCase().includes(searchTerm) ||
      (m.director || '').toLowerCase().includes(searchTerm) ||
      (m.description || '').toLowerCase().includes(searchTerm) ||
      (m.cast || []).some(c => (c.name || '').toLowerCase().includes(searchTerm))
    );
  }

  const selectedLangCode = getLangCode(selectedLang);

  if (selectedLang !== 'all') {
    result = result.filter(m => (m.langCode || '').toLowerCase() === String(selectedLangCode || '').toLowerCase());
  }
  if (selectedGenre !== 'all') result = result.filter(m => m.genre?.includes(selectedGenre));
  if (selectedYear !== 'all') result = result.filter(m => String(m.year) === selectedYear);

  if (sortBy === 'rating') result.sort((a, b) => Number(b.rating) - Number(a.rating));
  else if (sortBy === 'year') result.sort((a, b) => Number(b.year) - Number(a.year));
  else if (sortBy === 'title') result.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sortBy === 'trending') {
    const currentYear = new Date().getFullYear();
    result.sort((a, b) => {
      const scoreA = (Number(a.popularity || 0) * 0.5) + (Number(a.rating || 0) * 8) + ((Number(a.year || 2000) - 2000) * 3);
      const scoreB = (Number(b.popularity || 0) * 0.5) + (Number(b.rating || 0) * 8) + ((Number(b.year || 2000) - 2000) * 3);
      return scoreB - scoreA;
    });
  } else {
    result.sort((a, b) => {
      const popDiff = Number(b.popularity || 0) - Number(a.popularity || 0);
      if (popDiff !== 0) return popDiff;
      const ratingDiff = Number(b.rating || 0) - Number(a.rating || 0);
      if (ratingDiff !== 0) return ratingDiff;
      return Number(b.year || 0) - Number(a.year || 0);
    });
  }

  filteredMovies = result;
  renderMovies(result);
  updateResultsCount(result.length);
}

function resetFilters() {
  ['genreFilter', 'languageFilter', 'yearFilter', 'sortFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.options[0]?.value || 'all';
  });
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  applyFilters();
}

function updateResultsCount(count) {
  const el = document.getElementById('resultsCount');
  if (el) el.textContent = `${count.toLocaleString()} of ${allMovies.length.toLocaleString()} movies`;
}

function populateFilters() {
  populateLanguageFilter();
  populateGenreFilter();
  populateYearFilter();
  populateMovieSelect();
}

function populateLanguageFilter() {
  const sel = document.getElementById('languageFilter');
  if (!sel) return;
  const cur = sel.value || 'all';
  const langs = new Set(allMovies.map(m => m.language).filter(Boolean));
  sel.innerHTML = '<option value="all">All Languages</option>';
  [...langs].sort().forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang; opt.textContent = `${LANG_EMOJI[lang] || ''} ${lang}`.trim();
    sel.appendChild(opt);
  });
  if ([...langs, 'all'].includes(cur)) sel.value = cur;
}

function populateGenreFilter() {
  const sel = document.getElementById('genreFilter');
  if (!sel) return;
  const cur = sel.value || 'all';
  const genres = new Set(allMovies.flatMap(m => m.genre || []));
  sel.innerHTML = '<option value="all">All Genres</option>';
  [...genres].sort().forEach(g => {
    const opt = document.createElement('option');
    opt.value = g; opt.textContent = g;
    sel.appendChild(opt);
  });
  if ([...genres, 'all'].includes(cur)) sel.value = cur;
}

function populateYearFilter() {
  const sel = document.getElementById('yearFilter');
  if (!sel) return;
  const cur = sel.value || 'all';
  const years = new Set(allMovies.map(m => m.year).filter(y => y && y !== 'N/A'));
  sel.innerHTML = '<option value="all">All Years</option>';
  [...years].sort((a, b) => Number(b) - Number(a)).forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  });
  if ([...years, 'all'].includes(cur)) sel.value = cur;
}

function populateMovieSelect() {
  const sel = document.getElementById('reviewMovieSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select a movie --</option>';
  allMovies.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = `${m.title} (${m.year || 'N/A'})`;
    sel.appendChild(opt);
  });
}

/* ===================================================
   FILTERS — MOVIES PAGE
   =================================================== */
function populateMoviesPageFilters() {
  // Merge languages actually present in loaded movies with the full known-language list
  // so filters like Tamil/Telugu always appear even before those movies are loaded.
  const allKnownLanguages = Object.values(LANG_CODE_MAP);
  const loadedLanguages = allMovies.map(m => m.language).filter(Boolean);
  const mergedLanguages = [...new Set([...allKnownLanguages, ...loadedLanguages])];
  populateSelectFromData('moviesLangFilter', 'All Languages', mergedLanguages, l => `${LANG_EMOJI[l] || ''} ${l}`.trim());
  populateSelectFromData('moviesGenreFilter', 'All Genres', allMovies.flatMap(m => m.genre || []));
  populateSelectFromData('moviesYearFilter', 'All Years', allMovies.map(m => m.year).filter(y => y && y !== 'N/A'), null, true);
}

function applyMoviesPageFilters() {
  const lang = document.getElementById('moviesLangFilter')?.value || 'all';
  const genre = document.getElementById('moviesGenreFilter')?.value || 'all';
  const year = document.getElementById('moviesYearFilter')?.value || 'all';
  const sort = document.getElementById('moviesSortFilter')?.value || 'trending';

  // Map display language back to langCode for backend
  const langCode = getLangCode(lang);

  // Title/A-Z sort is client-side only — use popularity for backend fetch then sort locally
  const isClientSort = sort === 'title';
  const backendSort = isClientSort ? 'trending' :
    (['trending', 'upcoming', 'imdb', 'underrated', 'rating', 'year', 'popularity'].includes(sort) ? sort : 'trending');
  // 'imdb' and 'top_rated' both mean pure rating-descending on the backend
  const mappedSort = (sort === 'top_rated' || sort === 'imdb') ? 'rating' : backendSort;

  // Fully backend-driven filters
  moviesVirtualState.infiniteScrollLang = langCode;
  moviesVirtualState.infiniteScrollSort = mappedSort;
  moviesVirtualState.infiniteScrollGenre = genre !== 'all' ? genre : null;
  moviesVirtualState.infiniteScrollYear = year !== 'all' ? year : null;
  moviesVirtualState.infiniteScrollSearch = null;
  moviesVirtualState.clientSideSort = isClientSort ? sort : null;

  if (currentMoviesAbortController) {
    currentMoviesAbortController.abort();
  }
  currentMoviesAbortController = new AbortController();

  renderSkeletonCards('moviesPageContainer', 12);
  loadMoviesFromBackend({
    reset: true,
    pages: 1,
    limit: isClientSort ? 100 : API_LIST_LIMIT,
    language: langCode,
    genre: genre !== 'all' ? genre : null,
    year: year !== 'all' ? year : null,
    signal: currentMoviesAbortController.signal,
    type: 'movie',
    sort: mappedSort
  }).then(() => {
    let moviesForRender = [...allMovies];
    // Apply client-side A-Z sort
    if (isClientSort) {
      moviesForRender = moviesForRender.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    renderMoviesPage(moviesForRender);
    const el = document.getElementById('moviesResultsCount');
    if (el) el.textContent = `${moviesForRender.length.toLocaleString()} movies loaded`;

    if (isClientSort) return; // don't prefetch for client-side sorts

    // Prefetch one extra page for instant next scroll experience.
    clearTimeout(homePrefetchTimer);
    homePrefetchTimer = setTimeout(async () => {
      if (!moviesVirtualState.hasMoreBackend || moviesVirtualState.isFetchingBackend) return;
      try {
        const batch = await loadMoviesFromBackend({
          pages: 1,
          limit: API_LIST_LIMIT,
          language: moviesVirtualState.infiniteScrollLang || null,
          genre: moviesVirtualState.infiniteScrollGenre || null,
          year: moviesVirtualState.infiniteScrollYear || null,
          search: moviesVirtualState.infiniteScrollSearch || null,
          type: 'movie',
          sort: moviesVirtualState.infiniteScrollSort || 'trending'
        });
        if (Array.isArray(batch) && batch.length) {
          appendMoviesPage(batch);
          const c = document.getElementById('moviesResultsCount');
          if (c) c.textContent = `${allMovies.length.toLocaleString()} movies loaded`;
        }
      } catch (err) {
        console.warn('Movies prefetch failed:', err);
      }
    }, 500);
  }).catch(err => {
    if (err?.name === 'AbortError') return;
    console.warn('Filter fetch failed:', err);
  });
}

function resetMoviesFilters() {
  ['moviesLangFilter','moviesGenreFilter','moviesYearFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.options[0]?.value || 'all';
  });
  const sortEl = document.getElementById('moviesSortFilter');
  if (sortEl) sortEl.value = 'trending';
  applyMoviesPageFilters();
}

function resetSeriesFilters() {
  ['seriesLangFilter','seriesGenreFilter','seriesYearFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = el.options[0]?.value || 'all';
  });
  const sortEl = document.getElementById('seriesSortFilter');
  if (sortEl) sortEl.value = 'trending';
  applySeriesFilters();
}

/* ===================================================
   FILTERS — SERIES PAGE
   =================================================== */
function populateSeriesFilters() {
  // Preserve selections
  const curLang = document.getElementById('seriesLangFilter')?.value || 'all';
  const curGenre = document.getElementById('seriesGenreFilter')?.value || 'all';
  const curYear = document.getElementById('seriesYearFilter')?.value || 'all';

  const allMappedLanguages = Object.values(LANG_CODE_MAP);
  const seriesLanguages = allSeries.map(m => m.language).filter(Boolean);
  const mergedLanguages = [...new Set([...allMappedLanguages, ...seriesLanguages])];
  populateSelectFromData('seriesLangFilter', 'All Languages', mergedLanguages, l => `${LANG_EMOJI[l] || ''} ${l}`.trim());

  // Use TV genres from TV_GENRE_ID_MAP + loaded series genres
  const tvGenres = Object.values(TV_GENRE_ID_MAP);
  const loadedSeriesGenres = allSeries.flatMap((m) => getGenreList(m));
  const mergedGenres = [...new Set([...tvGenres, ...loadedSeriesGenres])].filter(Boolean).sort();
  populateSelectFromData('seriesGenreFilter', 'All Genres', mergedGenres);

  populateSelectFromData('seriesYearFilter', 'All Years', allSeries.map(m => m.year).filter(y => y && y !== 'N/A'), null, true);

  // Restore selections
  const langSel = document.getElementById('seriesLangFilter');
  const genreSel = document.getElementById('seriesGenreFilter');
  const yearSel = document.getElementById('seriesYearFilter');
  if (langSel && curLang !== 'all') langSel.value = curLang;
  if (genreSel && curGenre !== 'all') genreSel.value = curGenre;
  if (yearSel && curYear !== 'all') yearSel.value = curYear;
}

let currentSeriesAbortController = null;

function applySeriesFilters() {
  const lang = document.getElementById('seriesLangFilter')?.value || 'all';
  const genre = document.getElementById('seriesGenreFilter')?.value || 'all';
  const year = document.getElementById('seriesYearFilter')?.value || 'all';
  const sort = document.getElementById('seriesSortFilter')?.value || 'trending';

  const selectedLangCode = getLangCode(lang);

  // Title/A-Z sort is client-side only
  const isClientSort = sort === 'title';
  const backendSort = isClientSort ? 'trending' :
    (['trending', 'upcoming', 'imdb', 'underrated', 'rating', 'year', 'popularity'].includes(sort) ? sort : 'trending');
  // 'imdb' and 'top_rated' both mean pure rating-descending on the backend
  const mappedSort = (sort === 'top_rated' || sort === 'imdb') ? 'rating' : backendSort;

  // Update infinite scroll state
  seriesVirtualState.infiniteScrollLang = selectedLangCode || null;
  seriesVirtualState.infiniteScrollSort = mappedSort;
  seriesVirtualState.infiniteScrollGenre = genre !== 'all' ? genre : null;
  seriesVirtualState.infiniteScrollYear = year !== 'all' ? year : null;
  seriesVirtualState.clientSideSort = isClientSort ? sort : null;
  seriesVirtualState.hasMoreTmdb = true;

  if (currentSeriesAbortController) {
    currentSeriesAbortController.abort();
  }
  currentSeriesAbortController = new AbortController();

  // Reset end-of-results indicator for fresh filter fetch
  const seriesCountEl = document.getElementById('seriesResultsCount');
  if (seriesCountEl) delete seriesCountEl.dataset.endShown;

  renderSkeletonCards('seriesPageContainer', 24);

  loadSeriesFromBackend({
    reset: true,
    pages: 1,
    limit: isClientSort ? 100 : 24,
    language: selectedLangCode || null,
    genre: genre !== 'all' ? genre : null,
    year: year !== 'all' ? year : null,
    sort: mappedSort,
    signal: currentSeriesAbortController.signal
  }).then(() => {
    let seriesForRender = [...allSeries];
    // Filter out unsupported genres and malformed records.
    seriesForRender = seriesForRender.filter((m) => matchesSeriesActiveFilters(m));
    // Apply client-side A-Z sort
    if (isClientSort) {
      seriesForRender = seriesForRender.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
    renderSeriesGrid(seriesForRender);
    const el = document.getElementById('seriesResultsCount');
    if (el) el.textContent = `${seriesForRender.length.toLocaleString()} series loaded`;
  }).catch(err => {
    if (err?.name === 'AbortError') return;
    // Backend failed — do local filter
    let result = [...allSeries];
    const lc = selectedLangCode;
    if (lang !== 'all' && lc) result = result.filter(m => (m.langCode || '').toLowerCase() === lc.toLowerCase());
    if (genre !== 'all') result = result.filter((m) => getGenreList(m).includes(genre));
    if (year !== 'all') result = result.filter(m => String(m.year) === year);
    result = result.filter((m) => !isExcludedSeriesItem(m));
    if (isClientSort) result.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else result.sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));
    filteredSeries = result;
    renderSeriesGrid(result);
    console.warn('Series filter backend failed, showing local results:', err);
  });
}


function populateSelectFromData(selId, defaultLabel, rawData, labelFn = null, reverseSort = false) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const unique = [...new Set(rawData)].filter(Boolean);
  if (reverseSort) unique.sort((a, b) => Number(b) - Number(a));
  else unique.sort();
  sel.innerHTML = `<option value="all">${defaultLabel}</option>`;
  unique.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = labelFn ? labelFn(item) : item;
    sel.appendChild(opt);
  });
}

/* ===================================================
   RENDER MOVIES — HOME & MOVIES PAGE
   =================================================== */
function renderMovies(movies) {
  const container = document.getElementById('movieContainer');
  const emptyState = document.getElementById('emptyState');
  if (!container) return;
  if (!movies?.length) {
    container.innerHTML = '';
    emptyState?.classList.remove('d-none');
    return;
  }
  emptyState?.classList.add('d-none');
  container.innerHTML = movies.slice(0, 200).map(createMovieCard).join('');
  setTimeout(() => attachWatchlistBtns(container), 0);
  prefetchTrailerKeysForContainer(container, 20);
}

function renderMoviesPage(movies) {
  const container = document.getElementById('moviesPageContainer');
  const emptyState = document.getElementById('moviesEmptyState');
  if (!container) return;
  if (!movies?.length) {
    container.innerHTML = '';
    emptyState?.classList.remove('d-none');
    return;
  }
  emptyState?.classList.add('d-none');
  filteredMovies = [...movies];
  container.innerHTML = filteredMovies.map(createMovieCard).join('');
  setTimeout(() => attachWatchlistBtns(container), 0);
  prefetchTrailerKeysForContainer(container, 28);
}

function appendMoviesPage(movies) {
  const container = document.getElementById('moviesPageContainer');
  const emptyState = document.getElementById('moviesEmptyState');
  if (!container || !Array.isArray(movies) || !movies.length) return;

  emptyState?.classList.add('d-none');

  const existingIds = new Set(
    Array.from(container.querySelectorAll('.movie-card-wrapper[data-movie-id]'))
      .map((el) => el.getAttribute('data-movie-id'))
      .filter(Boolean)
  );

  let html = '';
  movies.forEach((raw) => {
    const m = (raw.tmdbId && !raw.id) ? { ...raw, id: raw.tmdbId } : raw;
    const key = String(m.id || m.tmdbId || '');
    if (!key || existingIds.has(key)) return;
    html += createMovieCard(m);
  });

  if (!html) return;
  container.insertAdjacentHTML('beforeend', html);
  setTimeout(() => attachWatchlistBtns(container), 0);
  prefetchTrailerKeysForContainer(container, 36);
}

function setupMoviesVirtualScroll(container) {
  if (moviesVirtualState.initialized && moviesVirtualState.container === container) return;

  moviesVirtualState.initialized = true;
  moviesVirtualState.container = container;
  moviesVirtualState.startIndex = -1;
  moviesVirtualState.endIndex = -1;

  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.display = 'block';
  container.style.overflowY = 'visible';
  container.style.height = 'auto';
  container.style.willChange = 'transform';

  const spacer = document.createElement('div');
  spacer.style.width = '100%';
  spacer.style.height = '0px';

  const content = document.createElement('div');
  content.className = 'row g-3 position-absolute top-0 start-0 w-100 m-0';
  content.style.transform = 'translateY(0px)';

  container.appendChild(spacer);
  container.appendChild(content);

  moviesVirtualState.spacer = spacer;
  moviesVirtualState.content = content;

  container.addEventListener('scroll', handleMoviesVirtualScroll, { passive: true });
}

function handleMoviesVirtualScroll() {
  const container = moviesVirtualState.container;
  if (!container) return;

  if (moviesVirtualState.rafId) return;
  moviesVirtualState.rafId = requestAnimationFrame(() => {
    moviesVirtualState.rafId = 0;
    virtualScrollMovies();

    // Container-scroll-based fetch (for when container has its own scroll)
    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - ITEM_HEIGHT * 2;
    if (!nearBottom || moviesVirtualState.isFetchingBackend || !moviesVirtualState.hasMoreBackend) {
      return;
    }
  });
}

function virtualScrollMovies(force = false) {
  const container = moviesVirtualState.container;
  const content = moviesVirtualState.content;
  const source = moviesVirtualState.source;
  if (!container || !content || !Array.isArray(source)) return;

  // Use window scroll since container no longer has its own scroll
  const containerTop = container.getBoundingClientRect().top + window.scrollY;
  const scrollTop = Math.max(0, window.scrollY - containerTop);
  const viewportHeight = window.innerHeight;
  const visibleCount = Math.ceil(viewportHeight / ITEM_HEIGHT);
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
  const endIndex = Math.min(source.length, startIndex + visibleCount + BUFFER * 2);

  if (!force && startIndex === moviesVirtualState.startIndex && endIndex === moviesVirtualState.endIndex) {
    return;
  }

  moviesVirtualState.startIndex = startIndex;
  moviesVirtualState.endIndex = endIndex;

  const MAX_RENDER = 60;
  const visibleItems = source.slice(startIndex, endIndex).slice(0, MAX_RENDER);
  const fragment = document.createDocumentFragment();
  const temp = document.createElement('div');
  temp.innerHTML = visibleItems.map(createMovieCard).join('');

  while (temp.firstElementChild) {
    const node = temp.firstElementChild;
    if (node.classList?.contains('movie-card-wrapper')) {
      node.style.minHeight = `${ITEM_HEIGHT}px`;
    }
    fragment.appendChild(node);
  }

  content.replaceChildren(fragment);
  content.style.transform = `translateY(${startIndex * ITEM_HEIGHT}px)`;
  attachWatchlistBtns(content);
}

function renderSeriesGrid(series) {
  const container = document.getElementById('seriesPageContainer');
  const emptyState = document.getElementById('seriesEmptyState');
  if (!container) return;

  // Filter out unsupported genres and malformed records.
  const cleaned = (Array.isArray(series) ? series : []).filter((m) => !isExcludedSeriesItem(m));

  if (!cleaned.length) {
    container.innerHTML = '';
    emptyState?.classList.remove('d-none');
    return;
  }
  emptyState?.classList.add('d-none');
  filteredSeries = [...cleaned];
  container.innerHTML = cleaned.slice(0, 200).map(m => createMovieCard(m, true)).join('');
  setTimeout(() => attachWatchlistBtns(container), 0);
}

function appendSeriesPage(series) {
  const container = document.getElementById('seriesPageContainer');
  if (!container || !Array.isArray(series) || !series.length) return;

  document.getElementById('seriesEmptyState')?.classList.add('d-none');

  const existingIds = new Set(
    Array.from(container.querySelectorAll('.movie-card-wrapper[data-movie-id]'))
      .map(el => el.getAttribute('data-movie-id'))
      .filter(Boolean)
  );

  let html = '';
  series.forEach(raw => {
    const m = (raw.tmdbId && !raw.id) ? { ...raw, id: raw.tmdbId } : raw;
    const key = String(m.id || m.tmdbId || '');
    if (!key || existingIds.has(key)) return;
    html += createMovieCard(m, true);
  });

  if (!html) return;
  container.insertAdjacentHTML('beforeend', html);
  setTimeout(() => attachWatchlistBtns(container), 0);
}

function attachWatchlistBtns(container) {
  container.querySelectorAll('.btn-watchlist-add').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleWatchlist(e); });
  });
}

function createMovieCard(movie, isSeries = false) {
  if (!movie || typeof movie !== 'object') return '';

  const genres = getGenreList(movie);
  const posterUrl = (movie.posterUrl && movie.posterUrl !== '') ? movie.posterUrl : PLACEHOLDER;
  const rating = Number(movie.rating || 0);
  const ratingClass = rating >= 8 ? 'rating-high' : rating >= 7 ? 'rating-mid' : 'rating-low';
  const langEmoji = LANG_EMOJI[movie.language] || '🎬';
  const langShort = (movie.language || '').split(' ')[0].slice(0, 7);
  const inWatchlist = isInWatchlist(Number(movie.id || movie.tmdbId || 0));
  const safeTitle = escapeHtml(movie.title || 'Untitled');
  const safePoster = PLACEHOLDER.replace(/'/g, '%27');
  const isTV = movie.isTV || isSeries;
  const cardMovieId = Number(movie.id || movie.tmdbId || 0);
  const inFavorites = isInFavorites(cardMovieId);

  return `
    <div class="col-6 col-sm-4 col-md-3 col-lg-2 movie-card-wrapper" data-movie-id="${movie.id || movie.tmdbId || ''}">
      <div class="movie-card" onclick="openMovie(${cardMovieId}, ${isTV})"
        data-movie-id="${cardMovieId}"
        data-is-tv="${isTV ? 'true' : 'false'}"
        data-movie-title="${safeTitle}">
        <div class="movie-card-img-wrapper">
          <img src="${posterUrl}" alt="${safeTitle}"
            loading="lazy"
            decoding="async"
            width="342"
            height="513"
            onerror="if(this.src!=='${safePoster}'){this.src='${safePoster}'}" />
          ${isTV ? '<span class="series-type-badge">Series</span>' : ''}
          ${rating > 0 ? `<span class="card-rating-badge"><i class="bi bi-star-fill" style="font-size:0.6rem"></i> ${rating.toFixed(1)}</span>` : ''}
          ${langShort ? `<span class="card-lang-badge">${langShort}</span>` : ''}
        </div>

        <div class="hover-preview" onclick="event.stopPropagation()">
          <div class="hover-info">
            <div class="hover-actions">
              <button class="hover-btn" type="button" title="Play" onclick="event.stopPropagation(); openMovie(${cardMovieId}, ${isTV})">▶</button>
              <button class="hover-btn secondary" type="button" title="Watchlist" data-hover-watchlist onclick="event.stopPropagation(); addToWatchlist(${cardMovieId}, this)">${inWatchlist ? '✓' : '+'}</button>
              <button class="hover-btn secondary" type="button" title="Like" data-hover-like onclick="event.stopPropagation(); likeMovie(${cardMovieId}, this)">${inFavorites ? '♥' : '❤'}</button>
            </div>
            <div class="hover-meta">
              ⭐ ${movie.rating || 'N/A'} · 📅 ${movie.year || 'N/A'}<br>
              🎬 ${escapeHtml(genres.slice(0, 3).join(', ') || 'Genre unavailable')}
            </div>
            <div class="providers" data-provider-target></div>
          </div>
        </div>

        <div class="movie-card-body">
          <h3>${safeTitle}</h3>
          <div class="d-flex gap-1 mb-1 flex-wrap">
            ${isTV ? '<span class="genre-badge series-genre-badge">Series</span>' : ''}
            ${genres.filter(g => g && g.toLowerCase() !== 'series').slice(0, isTV ? 1 : 2).map(g => '<span class="genre-badge">' + escapeHtml(g) + '</span>').join('')}
          </div>
          <div class="card-meta">
            <span class="card-year">${langEmoji} ${movie.year || 'N/A'}</span>
            <span class="card-rating ${ratingClass}"><i class="bi bi-star-fill"></i> ${movie.rating || 'N/A'}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function saveRating(id, rating, silent = false) {
  const movieId = Number(id);
  const score = Number(rating);
  if (!Number.isFinite(movieId)) return;

  const ratings = getStoredRatings();
  if (score <= 0) delete ratings[String(movieId)];
  else ratings[String(movieId)] = Math.max(1, Math.min(5, score));

  setStoredRatings(ratings);

  if (currentUser?._id && authToken) {
    fetch(`http://localhost:5000/api/users/${currentUser._id}/ratings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ movieId, rating: score })
    }).catch(() => {});
  }

  if (!silent) showToast('✅ Rating saved');
  loadRecommendedRow();
}

function playMovie(movieId, isTV = false) {
  openMovie(movieId, isTV);
}

function openMovie(movieId, isTV = false) {
  showDetailPage(Number(movieId), Boolean(isTV));
}

function addToWatchlist(movieId, btn = null) {
  const id = Number(movieId);
  if (!Number.isFinite(id)) return;

  const wl = getStoredWatchlist();
  const idx = wl.indexOf(id);
  let added = false;
  if (idx > -1) wl.splice(idx, 1);
  else {
    wl.push(id);
    added = true;
  }
  setStoredWatchlist(wl);

  if (currentUser?._id && authToken) {
    fetch(`http://localhost:5000/api/users/${currentUser._id}/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ movieId: id, action: added ? 'add' : 'remove' })
    }).catch(() => {});
  }

  if (btn) btn.textContent = added ? '✓' : '+';
  renderWatchlist();
  loadWatchlistRow();
  loadRecommendedRow();
  updateStats();
}

function likeMovie(movieId, btn = null) {
  const id = Number(movieId);
  if (!Number.isFinite(id)) return;

  const favs = getStoredFavorites();
  const idx = favs.indexOf(id);
  const liked = idx === -1;
  if (liked) favs.push(id);
  else favs.splice(idx, 1);
  setStoredFavorites(favs);

  if (btn) btn.textContent = liked ? '♥' : '❤';
}

/* ===================================================
   PLATFORM WATCH BUTTONS
   =================================================== */
const PLATFORM_CONFIG = {
  'Netflix':        { cls: 'platform-btn-netflix',  icon: 'bi-play-circle-fill', url: (t) => `https://www.netflix.com/search?q=${encodeURIComponent(t)}` },
  'Amazon Prime Video': { cls: 'platform-btn-prime', icon: 'bi-play-fill',      url: (t) => `https://www.primevideo.com/search/ref=atv_nb_sug?phrase=${encodeURIComponent(t)}` },
  'Disney Plus':    { cls: 'platform-btn-hotstar',   icon: 'bi-play-fill',       url: (t) => `https://www.disneyplus.com/search/${encodeURIComponent(t)}` },
  'Disney+':        { cls: 'platform-btn-hotstar',   icon: 'bi-play-fill',       url: (t) => `https://www.disneyplus.com/search/${encodeURIComponent(t)}` },
  'Apple TV+':      { cls: 'platform-btn-apple',     icon: 'bi-apple',           url: (t) => `https://tv.apple.com/search?term=${encodeURIComponent(t)}` },
  'Apple TV':       { cls: 'platform-btn-apple',     icon: 'bi-apple',           url: (t) => `https://tv.apple.com/search?term=${encodeURIComponent(t)}` },
  'Google Play Movies': { cls: 'platform-btn-google', icon: 'bi-play-circle',   url: (t) => `https://play.google.com/store/search?q=${encodeURIComponent(t)}&c=movies` },
  'Hotstar':        { cls: 'platform-btn-hotstar',   icon: 'bi-play-fill',       url: (t) => `https://www.hotstar.com/in/search?q=${encodeURIComponent(t)}` },
  'JioCinema':      { cls: 'platform-btn-prime',     icon: 'bi-play-fill',       url: (t) => `https://www.jiocinema.com/search/${encodeURIComponent(t)}` },
  'SonyLIV':        { cls: 'platform-btn-generic',   icon: 'bi-play-circle',     url: (t) => `https://www.sonyliv.com/search?q=${encodeURIComponent(t)}` },
  'Zee5':           { cls: 'platform-btn-generic',   icon: 'bi-play-circle',     url: (t) => `https://www.zee5.com/search?q=${encodeURIComponent(t)}` },
  'Mubi':           { cls: 'platform-btn-generic',   icon: 'bi-film',            url: (t) => `https://mubi.com/search/${encodeURIComponent(t)}` },
};

function renderPlatformButtons(movie) {
  const container = document.getElementById('detailPlatformBtns');
  if (!container) return;
  const platforms = movie.ottPlatforms || [];
  const providerMeta = Array.isArray(movie.ottProviderMeta) ? movie.ottProviderMeta : [];
  if (!platforms.length) { container.innerHTML = ''; return; }

  const logoStrip = providerMeta.length
    ? `<div class="provider-logo-strip mb-2">${providerMeta.slice(0, 5).map((p) => {
      const logo = p.logoPath ? `https://image.tmdb.org/t/p/w45${p.logoPath}` : '';
      if (!logo) return '';
      return `<img src="${logo}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" loading="lazy" decoding="async"/>`;
    }).join('')}</div>`
    : '';

  container.innerHTML = platforms.slice(0, 4).map(p => {
    const cfg = PLATFORM_CONFIG[p] || { cls: 'platform-btn-generic', icon: 'bi-play-circle', url: (t) => `https://www.google.com/search?q=${encodeURIComponent(t + ' watch online ' + p)}` };
    return `<a href="${cfg.url(movie.title)}" target="_blank" rel="noopener noreferrer"
      class="platform-btn ${cfg.cls}">
      <i class="bi ${cfg.icon}"></i>${p}
    </a>`;
  }).join('');

  container.innerHTML = `${logoStrip}${container.innerHTML}`;
}

async function fetchAndSetWatchProviders(movie) {
  if (!HAS_TMDB || !movie.tmdbId) return;
  try {
    const endpoint = movie.isTV ? `/tv/${movie.tmdbId}/watch/providers` : `/movie/${movie.tmdbId}/watch/providers`;
    const data = await tmdbGet(endpoint);
    const region = data.results?.IN || data.results?.US || null;
    if (!region) return;
    const allProviders = [...(region.flatrate || []), ...(region.rent || []), ...(region.buy || [])];
    const seen = new Set();
    const unique = allProviders.filter(p => { if (seen.has(p.provider_name)) return false; seen.add(p.provider_name); return true; });
    const platforms = unique.slice(0, 4).map(p => p.provider_name);
    if (platforms.length) {
      movie.ottPlatforms = platforms;
      movie.ottProviderMeta = unique.slice(0, 5).map((p) => ({
        name: p.provider_name,
        logoPath: p.logo_path || ''
      }));
      renderPlatformButtons(movie);
    }
  } catch (e) { /* silent */ }
}

/* ===================================================
   AMBIENT CANVAS — Stranger Things & GoT
   =================================================== */
let ambientAnimFrame = null;
let ambientParticles = [];

function setupAmbientCanvas() {
  const canvas = document.getElementById('ambientCanvas');
  if (!canvas) return;
  const observer = new MutationObserver(() => {
    const theme = document.documentElement.getAttribute('data-theme');
    startAmbient(theme);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  startAmbient(document.documentElement.getAttribute('data-theme'));
}

function startAmbient(theme) {
  const canvas = document.getElementById('ambientCanvas');
  if (!canvas) return;
  cancelAnimationFrame(ambientAnimFrame);
  ambientParticles = [];
  if (theme === 'stranger') { canvas.style.opacity = '1'; runStrangerAmbient(canvas); }
  else if (theme === 'got') { canvas.style.opacity = '1'; runGotAmbient(canvas); }
  else if (theme === 'hp') { canvas.style.opacity = '1'; runHPAmbient(canvas); }
  else { canvas.style.opacity = '0'; }
}

function runStrangerAmbient(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  for (let i = 0; i < 60; i++) {
    ambientParticles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, r: Math.random() * 2 + 0.5, vx: (Math.random() - 0.5) * 0.3, vy: -(Math.random() * 0.4 + 0.1), alpha: Math.random() * 0.5 + 0.1, flicker: Math.random() * Math.PI * 2 });
  }
  const lights = [];
  for (let i = 0; i < 20; i++) {
    lights.push({ x: (i / 19) * canvas.width, y: 30 + Math.sin(i * 0.7) * 15, color: ['#ff3a00','#ff7700','#ffcc00','#ff0000','#ff5500'][i % 5], on: Math.random() > 0.3, timer: Math.random() * 200 });
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath(); ctx.moveTo(0, 30);
    lights.forEach(l => ctx.lineTo(l.x, l.y));
    ctx.lineTo(canvas.width, 25); ctx.strokeStyle = 'rgba(80,30,10,0.3)'; ctx.lineWidth = 1; ctx.stroke();
    lights.forEach(light => {
      light.timer--;
      if (light.timer <= 0) { light.on = !light.on; light.timer = light.on ? Math.random() * 300 + 100 : Math.random() * 60 + 10; }
      ctx.beginPath(); ctx.arc(light.x, light.y, light.on ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = light.on ? light.color : 'rgba(60,20,10,0.5)';
      if (light.on) { ctx.shadowColor = light.color; ctx.shadowBlur = 12; }
      ctx.fill(); ctx.shadowBlur = 0;
    });
    ambientParticles.forEach(p => {
      p.flicker += 0.03;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,80,10,${p.alpha * (0.7 + 0.3 * Math.sin(p.flicker))})`;
      ctx.shadowColor = 'rgba(255,60,0,0.5)'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
      p.x += p.vx + Math.sin(p.flicker * 0.5) * 0.2; p.y += p.vy;
      if (p.y < -10) { p.y = canvas.height + 10; p.x = Math.random() * canvas.width; }
      if (p.x < -10) p.x = canvas.width + 10;
      if (p.x > canvas.width + 10) p.x = -10;
    });
    ambientAnimFrame = requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
  draw();
}

function runGotAmbient(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  for (let i = 0; i < 50; i++) {
    ambientParticles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, r: Math.random() * 1.8 + 0.3, vx: (Math.random() - 0.5) * 0.4, vy: Math.random() * 0.5 + 0.2, alpha: Math.random() * 0.35 + 0.05, flicker: Math.random() * Math.PI * 2, glow: Math.random() > 0.7 });
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ambientParticles.forEach(p => {
      p.flicker += 0.02;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      if (p.glow) { ctx.fillStyle = `rgba(220,150,40,${p.alpha * (0.8 + 0.2 * Math.sin(p.flicker))})`; ctx.shadowColor = 'rgba(201,146,47,0.6)'; ctx.shadowBlur = 8; }
      else { ctx.fillStyle = `rgba(160,130,80,${p.alpha * 0.6 * (0.8 + 0.2 * Math.sin(p.flicker))})`; ctx.shadowBlur = 0; }
      ctx.fill(); ctx.shadowBlur = 0;
      p.x += p.vx + Math.sin(p.flicker * 0.3) * 0.3; p.y += p.vy;
      if (p.y > canvas.height + 10) { p.y = -10; p.x = Math.random() * canvas.width; }
      if (p.x < -10) p.x = canvas.width + 10;
      if (p.x > canvas.width + 10) p.x = -10;
    });
    ambientAnimFrame = requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
  draw();
}

function injectGotFont() {
  if (!document.getElementById('got-font')) {
    const link = document.createElement('link');
    link.id = 'got-font'; link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@400;700&display=swap';
    document.head.appendChild(link);
  }
}

function runHPAmbient(canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Stars — deep night-sky field over Hogwarts
  const stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.4 + 0.2,
      alpha: Math.random() * 0.7 + 0.2,
      twinkleSpeed: Math.random() * 0.015 + 0.004,
      twinkleOffset: Math.random() * Math.PI * 2,
      hue: Math.random() > 0.85 ? 55 : (Math.random() > 0.5 ? 270 : 200) // gold / purple / blue-white
    });
  }

  // Spell sparks — like Lumos or wand trails
  const sparks = [];
  function spawnSpark() {
    const side = Math.random();
    let x, y, vx, vy;
    if (side < 0.5) {
      x = Math.random() * canvas.width;
      y = canvas.height + 10;
      vx = (Math.random() - 0.5) * 1.2;
      vy = -(Math.random() * 1.8 + 0.6);
    } else {
      x = Math.random() < 0.5 ? -10 : canvas.width + 10;
      y = Math.random() * canvas.height;
      vx = x < 0 ? Math.random() * 1.2 + 0.3 : -(Math.random() * 1.2 + 0.3);
      vy = (Math.random() - 0.5) * 1.0;
    }
    const isGold = Math.random() > 0.45;
    sparks.push({
      x, y, vx, vy,
      life: 1,
      decay: Math.random() * 0.008 + 0.004,
      r: Math.random() * 2.2 + 0.8,
      trail: [],
      isGold,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: (Math.random() - 0.5) * 0.04
    });
  }
  // Seed initial sparks
  for (let i = 0; i < 18; i++) spawnSpark();

  // Floating rune symbols
  const runes = ['✦', '✧', '⚡', '✵', '✶', '⋆', '✴', '☆'];
  const runeParticles = [];
  for (let i = 0; i < 8; i++) {
    runeParticles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      char: runes[Math.floor(Math.random() * runes.length)],
      alpha: Math.random() * 0.25 + 0.05,
      size: Math.random() * 14 + 8,
      vy: -(Math.random() * 0.18 + 0.04),
      vx: (Math.random() - 0.5) * 0.15,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.008,
      twinkle: Math.random() * Math.PI * 2
    });
  }

  let frame = 0;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;

    // ── Draw stars ──
    stars.forEach(s => {
      s.twinkleOffset += s.twinkleSpeed;
      const alpha = s.alpha * (0.6 + 0.4 * Math.sin(s.twinkleOffset));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      if (s.hue === 55) {
        ctx.fillStyle = `rgba(255, 215, 80, ${alpha})`;
        if (s.r > 0.9) { ctx.shadowColor = 'rgba(255,200,50,0.6)'; ctx.shadowBlur = 6; }
      } else if (s.hue === 270) {
        ctx.fillStyle = `rgba(180, 120, 255, ${alpha})`;
        if (s.r > 0.9) { ctx.shadowColor = 'rgba(160,80,255,0.5)'; ctx.shadowBlur = 5; }
      } else {
        ctx.fillStyle = `rgba(200, 220, 255, ${alpha})`;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    // ── Draw spell sparks ──
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.wobble += sp.wobbleSpeed;
      sp.x += sp.vx + Math.sin(sp.wobble) * 0.3;
      sp.y += sp.vy;
      sp.life -= sp.decay;

      // Trail
      sp.trail.push({ x: sp.x, y: sp.y });
      if (sp.trail.length > 14) sp.trail.shift();

      if (sp.life <= 0 || sp.x < -20 || sp.x > canvas.width + 20 || sp.y < -20 || sp.y > canvas.height + 20) {
        sparks.splice(i, 1);
        spawnSpark();
        continue;
      }

      // Draw trail
      for (let t = 0; t < sp.trail.length - 1; t++) {
        const trailAlpha = (t / sp.trail.length) * sp.life * 0.5;
        ctx.beginPath();
        ctx.moveTo(sp.trail[t].x, sp.trail[t].y);
        ctx.lineTo(sp.trail[t + 1].x, sp.trail[t + 1].y);
        if (sp.isGold) {
          ctx.strokeStyle = `rgba(255, 200, 50, ${trailAlpha})`;
          ctx.shadowColor = 'rgba(255,180,0,0.4)';
        } else {
          ctx.strokeStyle = `rgba(160, 80, 255, ${trailAlpha})`;
          ctx.shadowColor = 'rgba(120,40,255,0.4)';
        }
        ctx.shadowBlur = 4;
        ctx.lineWidth = sp.r * 0.7;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // Draw spark head
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.r * sp.life, 0, Math.PI * 2);
      if (sp.isGold) {
        ctx.fillStyle = `rgba(255, 220, 80, ${sp.life * 0.9})`;
        ctx.shadowColor = 'rgba(255,200,50,0.7)';
      } else {
        ctx.fillStyle = `rgba(180, 100, 255, ${sp.life * 0.9})`;
        ctx.shadowColor = 'rgba(140,60,255,0.7)';
      }
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // ── Draw floating runes ──
    runeParticles.forEach(rp => {
      rp.x += rp.vx;
      rp.y += rp.vy;
      rp.rot += rp.rotSpeed;
      rp.twinkle += 0.012;
      const alpha = rp.alpha * (0.7 + 0.3 * Math.sin(rp.twinkle));

      if (rp.y < -40) { rp.y = canvas.height + 20; rp.x = Math.random() * canvas.width; }

      ctx.save();
      ctx.translate(rp.x, rp.y);
      ctx.rotate(rp.rot);
      ctx.globalAlpha = alpha;
      ctx.font = `${rp.size}px serif`;
      ctx.fillStyle = Math.random() > 0.999 ? '#f0c040' : '#a070e0';
      ctx.shadowColor = 'rgba(180,100,255,0.5)';
      ctx.shadowBlur = 8;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rp.char, 0, 0);
      ctx.shadowBlur = 0;
      ctx.restore();
      ctx.globalAlpha = 1;
    });

    ambientAnimFrame = requestAnimationFrame(draw);
  }

  window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
  draw();
}

/* ===================================================
   DETAIL PAGE
   =================================================== */
function getImdbTitleUrlFromId(imdbId) {
  const cleanId = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d+$/i.test(cleanId)) return '';
  return `https://www.imdb.com/title/${cleanId}`;
}

function extractImdbIdFromValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (/^tt\d+$/i.test(raw)) {
    return raw.toLowerCase();
  }

  try {
    const parsed = new URL(raw);
    const match = String(parsed.pathname || '').match(/\/title\/(tt\d+)/i);
    return match?.[1] ? match[1].toLowerCase() : '';
  } catch (_err) {
    return '';
  }
}

function buildImdbPlayUrl(imdbUrl = '') {
  const rawUrl = String(imdbUrl || '').trim();
  if (!rawUrl) return '';

  try {
    const parsed = new URL(rawUrl);
    const isImdbHost = /(^|\.)imdb\.com$/i.test(parsed.hostname);
    const isTitlePath = /^\/title\/tt/i.test(parsed.pathname || '');
    if (!isImdbHost || !isTitlePath) return '';

    parsed.protocol = 'https:';
    parsed.hostname = 'www.playimdb.com';
    return parsed.toString();
  } catch (_err) {
    return '';
  }
}

function setDetailWatchNowLink(imdbUrl = '') {
  const watchNowBtn = document.getElementById('detailOTTBtn');
  if (!watchNowBtn) return;

  const playUrl = buildImdbPlayUrl(imdbUrl);
  if (!playUrl) {
    watchNowBtn.style.display = 'none';
    watchNowBtn.removeAttribute('href');
    watchNowBtn.onclick = null;
    return;
  }

  watchNowBtn.href = playUrl;
  watchNowBtn.style.display = 'inline-flex';
  watchNowBtn.onclick = (event) => {
    const trailerEmbed = document.getElementById('detailTrailerEmbed');
    if (!trailerEmbed) return;
    event.preventDefault();
    trailerEmbed.src = playUrl;
    trailerEmbed.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

function setDetailImdbLink(imdbUrl = '') {
  const imdbBtn = document.getElementById('detailIMDbBtn');
  if (!imdbBtn) return;

  if (!imdbUrl) {
    imdbBtn.style.display = 'none';
    imdbBtn.removeAttribute('href');
    return;
  }

  imdbBtn.style.display = 'inline-flex';
  imdbBtn.href = imdbUrl;
}

async function resolveExactImdbLink(movie) {
  if (!movie || typeof movie !== 'object') return '';

  const existingUrl = getImdbTitleUrlFromId(
    extractImdbIdFromValue(movie.imdbId || movie.imdb_id || movie.imdbURL)
  );
  if (existingUrl) return existingUrl;

  if (movie._imdbResolvePromise) {
    return movie._imdbResolvePromise;
  }

  const params = new URLSearchParams();
  const numericTmdbId = Number(movie.tmdbId || movie.id);
  if (Number.isFinite(numericTmdbId) && numericTmdbId > 0) {
    params.set('tmdbId', String(numericTmdbId));
  }

  const cleanTitle = String(movie.title || '').trim();
  if (cleanTitle) params.set('title', cleanTitle);

  const numericYear = Number(movie.year);
  if (Number.isFinite(numericYear) && numericYear > 1800) {
    params.set('year', String(numericYear));
  }

  params.set('type', movie.isTV ? 'tv' : 'movie');

  if (![...params.keys()].length) return '';

  movie._imdbResolvePromise = (async () => {
    try {
      const data = await fetchJsonWithTimeout(`${API_BASE}/movies/resolve-imdb?${params.toString()}`);
      const resolvedImdbId = extractImdbIdFromValue(data?.imdbId || data?.imdbUrl);
      const resolvedUrl = getImdbTitleUrlFromId(resolvedImdbId);
      if (resolvedImdbId) movie.imdbId = resolvedImdbId;
      return resolvedUrl;
    } catch (_err) {
      return '';
    } finally {
      movie._imdbResolvePromise = null;
    }
  })();

  return movie._imdbResolvePromise;
}

async function showDetailPage(movieId, isTV = false, options = {}) {
  const { skipHistory = false, replaceHistory = false } = options;

  // Track where we came from
  if (currentPage !== 'detail') {
    capturePageSelectionState(currentPage);
    previousPage = currentPage;
  }

  // Look in appropriate list first
  let movie = isTV
    ? (allSeries.find(m => m.id === movieId) || allMovies.find(m => m.id === movieId))
    : (allMovies.find(m => m.id === movieId) || allSeries.find(m => m.id === movieId));

  // If not found locally, fetch from TMDB
  if (!movie && HAS_TMDB) {
    try {
      const endpoint = isTV ? `/tv/${movieId}` : `/movie/${movieId}`;
      const raw = await tmdbGet(endpoint);
      const genreIds = raw.genres?.map(g => g.id) || [];
      movie = mapTmdbMovie({ ...raw, genre_ids: genreIds, isTV });
      movie.isTV = isTV;
      if (isTV) allSeries.push(movie);
      else allMovies.push(movie);
    } catch (err) {
      console.warn('Could not fetch detail:', err);
    }
  }

  // If still not found, try our own backend (handles browser refresh with no TMDB key)
  if (!movie) {
    try {
      const fallbackType = isTV ? 'tv' : 'movie';
      const res = await fetch(`http://localhost:5000/api/movies?ids=${movieId}&type=${fallbackType}&limit=1`);
      if (res.ok) {
        const data = await res.json();
        const found = Array.isArray(data) && data.length ? data[0] : null;
        if (found) {
          movie = found.tmdbId && !found.id ? { ...found, id: found.tmdbId } : found;
          movie.isTV = Boolean(movie.isTV ?? isTV);
          if (movie.isTV) allSeries.push(movie); else allMovies.push(movie);
        }
      }
    } catch (_) {}
  }

  // Graceful fallback: go home instead of leaving a blank page
  if (!movie) {
    showHome({ replaceHistory: true });
    return;
  }

  trackContinueWatching(movie);
  loadContinueWatchingRow().catch(() => {});

  // Push to navigation history
  if (!skipHistory) {
    navigationHistory.push({ type: 'detail', id: movieId, isTV: movie.isTV || isTV });
  }
  currentDetailMovieId = movie.id;
  currentDetailIsTV = Boolean(movie.isTV || isTV);
  currentDetailRating = 0;

  // Reset detail hero to original structure (may have been replaced by actor page)
  const detailHero = document.getElementById('detailHero');
  if (detailHero && !detailHero.querySelector('#detailPoster')) {
    detailHero.innerHTML = `
      <div class="detail-hero-bg" id="detailHeroBg"></div>
      <div class="detail-hero-overlay"></div>
      <div class="container-xl py-5 position-relative">
        <div class="row g-4 align-items-end">
          <div class="col-md-3 col-sm-4 col-5">
            <div class="detail-poster-wrapper">
              <img id="detailPoster" src="" alt="" class="detail-poster img-fluid" />
              <div class="detail-poster-shine"></div>
            </div>
          </div>
          <div class="col-md-9 col-sm-8 col-7">
            <div class="d-flex flex-wrap gap-2 mb-2">
              <span class="lang-badge" id="detailLang"></span>
              <span class="genre-badge" id="detailGenreBadge"></span>
              <span class="cert-badge" id="detailCert" style="display:none"></span>
            </div>
            <h1 class="detail-title" id="detailTitle"></h1>
            <div class="detail-meta d-flex flex-wrap gap-3 mb-2">
              <span class="meta-item"><i class="bi bi-calendar3 me-1"></i><span id="detailYear"></span></span>
              <span class="meta-item imdb-badge-lg"><i class="bi bi-star-fill me-1"></i><span id="detailRating"></span><span class="text-muted">/10</span></span>
              <span class="meta-item" id="detailRuntimeWrap" style="display:none"><i class="bi bi-clock me-1"></i><span id="detailRuntime"></span></span>
              <span class="meta-item"><i class="bi bi-camera-video me-1"></i><span id="detailDirector"></span></span>
            </div>
            <div id="detailTagline" class="detail-tagline mb-2"></div>
            <p class="detail-desc" id="detailDesc"></p>
            <div class="d-flex flex-wrap gap-2 mt-3">
              <a id="detailOTTBtn" href="#" target="_blank" rel="noopener noreferrer" class="btn btn-primary-custom" style="display:none">
                <i class="bi bi-play-fill me-1"></i><span id="detailOTTName">Watch Now</span>
              </a>
              <div id="detailPlatformBtns" class="d-flex flex-wrap gap-2"></div>
              <a id="detailIMDbBtn" href="#" target="_blank" rel="noopener noreferrer" class="btn btn-outline-custom">
                <i class="bi bi-box-arrow-up-right me-1"></i>IMDb
              </a>
              <button id="detailWatchlistBtn" class="btn btn-outline-custom" onclick="toggleWatchlistDetail()">
                <i class="bi bi-bookmark-plus me-1" id="detailWLIcon"></i><span id="detailWLText">Save</span>
              </button>
              <button id="detailFavBtn" class="btn btn-outline-custom" onclick="toggleFavDetail()">
                <i class="bi bi-heart me-1" id="detailFavIcon"></i><span id="detailFavText">Like</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Restore detail body structure if actor page replaced it
  const detailBody = document.getElementById('detailBody');
  if (detailBody && !detailBody.querySelector('#detailTrailerEmbed')) {
    detailBody.innerHTML = `
      <div class="row g-4 mb-5">
        <div class="col-lg-7">
          <h3 class="carousel-section-title mb-3"><i class="bi bi-play-circle-fill accent-text me-2"></i>Trailer</h3>
          <div class="trailer-embed-wrapper">
            <div class="ratio ratio-16x9">
              <iframe id="detailTrailerEmbed" src="" title="Movie Trailer" allow="encrypted-media" allowfullscreen loading="lazy"></iframe>
            </div>
          </div>
        </div>
        <div class="col-lg-5">
          <h3 class="carousel-section-title mb-3"><i class="bi bi-people-fill accent-text me-2"></i>Cast & Crew</h3>
          <div id="detailCastCrew" class="cast-crew-grid"></div>
        </div>
      </div>
      <div class="mb-5 detail-review-section">
        <h3 class="carousel-section-title mb-3"><i class="bi bi-star accent-text me-2"></i>Rate & Review This Movie</h3>
        <div class="detail-review-box p-4">
          <div class="row g-4">
            <div class="col-md-6">
              <form id="detailReviewForm" novalidate>
                <div class="mb-3">
                  <label class="form-label text-muted small">YOUR NAME</label>
                  <input type="text" class="form-control custom-input" id="detailReviewerName" placeholder="Enter your name" />
                </div>
                <div class="mb-3">
                  <label class="form-label text-muted small">RATING</label>
                  <div class="star-rating" id="detailStarRating">
                    <span class="star detail-star" data-rating="1">★</span>
                    <span class="star detail-star" data-rating="2">★</span>
                    <span class="star detail-star" data-rating="3">★</span>
                    <span class="star detail-star" data-rating="4">★</span>
                    <span class="star detail-star" data-rating="5">★</span>
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label text-muted small">YOUR REVIEW</label>
                  <textarea class="form-control custom-input" id="detailReviewText" rows="3" placeholder="Share your thoughts about this movie…"></textarea>
                </div>
                <button type="submit" class="btn btn-primary-custom"><i class="bi bi-send me-2"></i>Submit Review</button>
              </form>
            </div>
            <div class="col-md-6">
              <div id="detailMovieReviews" class="detail-reviews-list">
                <p class="text-muted small">No reviews yet for this movie.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="mb-5">
        <h3 class="carousel-section-title mb-3"><i class="bi bi-film accent-text me-2"></i>Similar</h3>
        <div class="similar-grid" id="similarMoviesRow"></div>
      </div>
      <div class="mb-5">
        <h3 class="carousel-section-title mb-3"><i class="bi bi-person-video2 accent-text me-2"></i>More from <span id="leadActorName"></span></h3>
        <div class="similar-grid" id="actorMoviesRow"></div>
      </div>
      <div class="mb-5">
        <h3 class="carousel-section-title mb-3"><i class="bi bi-camera2 accent-text me-2"></i>More from Director — <span id="directorName"></span></h3>
        <div class="similar-grid" id="directorMoviesRow"></div>
      </div>
    `;

    // Re-attach detail review form — done unconditionally below
  }

  // Always re-setup review form for current movie (handles repeat visits without rebuild)
  setupDetailReviewForm(movie.id);

  // Fill in content
  const posterEl = document.getElementById('detailPoster');
  if (posterEl) { posterEl.src = movie.posterUrl || PLACEHOLDER; posterEl.alt = movie.title; posterEl.onerror = () => { posterEl.src = PLACEHOLDER; }; }

  const heroBg = document.getElementById('detailHeroBg');
  if (heroBg) heroBg.style.backgroundImage = `url(${movie.backdropUrl || movie.posterUrl || ''})`;

  setText('detailTitle', movie.title);
  setText('detailYear', movie.year || 'N/A');
  setText('detailRating', movie.rating || 'N/A');
  setText('detailDesc', movie.description || 'Description not available.');
  setText('detailDirector', movie.director || 'N/A');

  const bc = document.getElementById('breadcrumbTitle');
  if (bc) bc.textContent = movie.title;

  const langBadge = document.getElementById('detailLang');
  if (langBadge) langBadge.textContent = `${LANG_EMOJI[movie.language] || '🎬'} ${movie.language || 'N/A'}`;

  const genreBadge = document.getElementById('detailGenreBadge');
  if (genreBadge) genreBadge.textContent = getGenreList(movie).join(', ') || 'N/A';

  setText('detailTagline', '');

  const imdbTitleUrl = getImdbTitleUrlFromId(movie.imdbId || movie.imdb_id);
  setDetailImdbLink(imdbTitleUrl);
  setDetailWatchNowLink(imdbTitleUrl);

  if (!imdbTitleUrl) {
    resolveExactImdbLink(movie).then((resolvedUrl) => {
      if (!resolvedUrl) return;
      if (Number(currentDetailMovieId) !== Number(movie.id)) return;
      setDetailImdbLink(resolvedUrl);
      setDetailWatchNowLink(resolvedUrl);
    });
  }

  renderPlatformButtons(movie);
  updateDetailActionButtons();

  const trailerEmbed = document.getElementById('detailTrailerEmbed');
  if (trailerEmbed) trailerEmbed.src = '';

  renderCastCrew([]);
  renderMiniGrid('similarMoviesRow', [], 'Loading…');
  renderMiniGrid('actorMoviesRow', [], 'Loading…');
  renderMiniGrid('directorMoviesRow', [], 'Loading…');

  // Load reviews for this movie
  renderDetailMovieReviews(movie.id, movie.title);

  setActivePage('detail', {
    skipHistory,
    replaceHistory,
    url: `/movie/${Number(movie.id)}?tv=${currentDetailIsTV ? 'true' : 'false'}`
  });

  // Enrich
  if (movie.tmdbId) {
    enrichDetailPage(movie);
  } else {
    fallbackDetailSections(movie);
  }
}

function setupDetailReviewForm(movieId) {
  // Clone the form element to wipe all previously attached event listeners
  const oldForm = document.getElementById('detailReviewForm');
  if (!oldForm) return;
  const form = oldForm.cloneNode(true);
  oldForm.parentNode.replaceChild(form, oldForm);

  // Setup star rating
  currentDetailRating = 0;
  const stars = form.querySelectorAll('.detail-star');
  stars.forEach(star => {
    star.classList.remove('active');
    star.addEventListener('click', () => {
      currentDetailRating = Number(star.getAttribute('data-rating'));
      stars.forEach(s => s.classList.toggle('active', Number(s.getAttribute('data-rating')) <= currentDetailRating));
    });
    star.addEventListener('mouseenter', () => {
      const val = Number(star.getAttribute('data-rating'));
      stars.forEach(s => s.classList.toggle('hover', Number(s.getAttribute('data-rating')) <= val));
    });
    star.addEventListener('mouseleave', () => stars.forEach(s => s.classList.remove('hover')));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.querySelector('#detailReviewerName')?.value.trim();
    const text = form.querySelector('#detailReviewText')?.value.trim();
    if (!name || name.length < 2) { showToast('❌ Please enter your name.'); return; }
    if (!currentDetailRating) { showToast('❌ Please select a rating.'); return; }
    if (!text || text.length < 10) { showToast('❌ Please write a longer review.'); return; }

    const movie = allMovies.find(m => m.id === movieId) || allSeries.find(m => m.id === movieId);
    const reviews = JSON.parse(localStorage.getItem('reviews') || '[]');
    reviews.unshift({
      id: Date.now(),
      name,
      movieId,
      movieTitle: movie?.title || 'Unknown',
      rating: currentDetailRating,
      text,
      date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    });
    localStorage.setItem('reviews', JSON.stringify(reviews.slice(0, 100)));
    renderDetailMovieReviews(movieId, movie?.title);
    renderReviews();
    updateStats();
    form.reset();
    currentDetailRating = 0;
    form.querySelectorAll('.detail-star').forEach(s => s.classList.remove('active'));
    showToast('✅ Review submitted!');
  });
}

function renderDetailMovieReviews(movieId, movieTitle) {
  const container = document.getElementById('detailMovieReviews');
  if (!container) return;
  const allReviews = JSON.parse(localStorage.getItem('reviews') || '[]');
  const movieReviews = allReviews.filter(r => r.movieId === movieId);
  if (!movieReviews.length) {
    container.innerHTML = '<p class="text-muted small">No reviews yet for this movie. Be the first!</p>';
    return;
  }
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  container.innerHTML = movieReviews.map(r => `
    <div class="review-item mb-3">
      <div class="review-header">
        <span class="reviewer-name">${escapeHtml(r.name)}</span>
        <span class="review-stars">${stars(r.rating)}</span>
      </div>
      <p class="review-text mb-1">${escapeHtml(r.text)}</p>
      <span class="review-date">${r.date}</span>
    </div>
  `).join('');
}

async function fetchDetailBundle(movie) {
  const tmdbId = Number(movie?.tmdbId || movie?.id);
  if (!Number.isFinite(tmdbId)) throw new Error('Missing TMDB id for detail bundle');

  const preferredIsTV = Boolean(movie?.isTV);

  // Prefer backend bundle so detail works even without a browser TMDB key.
  try {
    const type = preferredIsTV ? 'tv' : 'movie';
    return await fetchJsonWithTimeout(`${API_BASE}/movies/${tmdbId}/details?type=${type}`, DETAIL_BUNDLE_TIMEOUT_MS);
  } catch (_backendErr) {
    // Fall through to direct TMDB only if a browser key is present.
  }

  if (!HAS_TMDB) {
    throw new Error('Detail bundle unavailable from backend and browser TMDB key is missing');
  }

  const mediaAttempts = preferredIsTV ? [true, false] : [false, true];
  let lastError = null;

  for (const isTV of mediaAttempts) {
    try {
      const endpoint = isTV ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
      const similarEndpoint = isTV ? `/tv/${tmdbId}/similar` : `/movie/${tmdbId}/similar`;
      const details = await tmdbGet(endpoint, { append_to_response: 'videos,credits,watch/providers' });
      const similar = await tmdbGet(similarEndpoint, { page: 1 }).catch(() => ({ results: [] }));

      return {
        isTV,
        mediaType: isTV ? 'tv' : 'movie',
        details: {
          ...details,
          videos: details.videos || { results: [] },
          credits: details.credits || { cast: [], crew: [] },
          watchProviders: details['watch/providers'] || { results: {} }
        },
        similar
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to resolve TMDB detail bundle');
}

function applyWatchProvidersFromDetails(movie, details) {
  const providerData = details?.watchProviders || details?.['watch/providers'];
  const region = providerData?.results?.IN || providerData?.results?.US || null;
  if (!region) return;

  const allProviders = [
    ...(region.flatrate || []),
    ...(region.rent || []),
    ...(region.buy || [])
  ];

  const seen = new Set();
  const unique = allProviders.filter((provider) => {
    const name = String(provider?.provider_name || '');
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  const platforms = unique.slice(0, 4).map((provider) => provider.provider_name);
  if (!platforms.length) return;

  movie.ottPlatforms = platforms;
  movie.ottProviderMeta = unique.slice(0, 5).map((provider) => ({
    name: provider.provider_name,
    logoPath: provider.logo_path || ''
  }));
}

async function enrichDetailPage(movie) {
  try {
    const bundle = await fetchDetailBundle(movie);
    const details = bundle?.details || {};
    const videos = details.videos || { results: [] };
    const credits = details.credits || { cast: [], crew: [] };
    const similar = bundle?.similar || { results: [] };
    movie.isTV = Boolean(bundle?.isTV ?? movie.isTV);

    if (details.overview) setText('detailDesc', details.overview);
    if (details.tagline) setText('detailTagline', `"${details.tagline}"`);

    // Runtime
    const runtime = details.runtime || (details.episode_run_time?.[0]);
    if (runtime) {
      const h = Math.floor(runtime / 60), m = runtime % 60;
      setText('detailRuntime', `${h > 0 ? h + 'h ' : ''}${m}m`);
      show('detailRuntimeWrap');
    }

    // Genres
    const genreBadge = document.getElementById('detailGenreBadge');
    if (details.genres?.length && genreBadge) {
      genreBadge.textContent = details.genres.map(g => g.name).join(', ');
    }

    // IMDb link + Watch Now (IMDb Play)
    const resolvedImdbId = String(details.imdb_id || movie.imdbId || movie.imdb_id || '').trim();
    const imdbTitleUrl = getImdbTitleUrlFromId(resolvedImdbId);
    if (imdbTitleUrl) {
      movie.imdbId = resolvedImdbId;
    }
    setDetailImdbLink(imdbTitleUrl);
    setDetailWatchNowLink(imdbTitleUrl);

    if (!imdbTitleUrl) {
      resolveExactImdbLink(movie).then((resolvedUrl) => {
        if (!resolvedUrl) return;
        if (Number(currentDetailMovieId) !== Number(movie.id)) return;
        setDetailImdbLink(resolvedUrl);
        setDetailWatchNowLink(resolvedUrl);
      });
    }

    // Director / Creator
    const director = credits.crew?.find(c => c.job === 'Director');
    const creator = details.created_by?.[0];
    const directorName = director?.name || creator?.name;
    if (directorName) {
      setText('detailDirector', directorName);
      setText('directorName', directorName);
    }

    // Cast
    const cast = credits.cast?.slice(0, 10).map(c => ({
      name: c.name, role: c.character || 'Cast',
      personId: c.id,
      profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
    })) || [];
    renderCastCrew(cast);

    // Trailer — embed YouTube
    const trailer = videos.results?.find(v => v.site === 'YouTube' && v.type === 'Trailer')
      || videos.results?.find(v => v.site === 'YouTube');
    const trailerEmbed = document.getElementById('detailTrailerEmbed');
    if (trailerEmbed) {
      if (trailer?.key) {
        trailerEmbed.src = `https://www.youtube.com/embed/${trailer.key}?controls=1&rel=0`;
      } else {
        trailerEmbed.src = `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(movie.title + ' official trailer')}`;
      }
    }

    // Similar
    const similarMapped = (similar.results || []).slice(0, 12).map(m => {
      const mapped = { ...mapTmdbMovie(m), isTV: movie.isTV };
      if (!allMovies.find(x => x.id === mapped.id) && !allSeries.find(x => x.id === mapped.id)) {
        if (movie.isTV) allSeries.push(mapped); else allMovies.push(mapped);
      }
      return mapped;
    });
    renderMiniGrid('similarMoviesRow', similarMapped, 'No similar titles found.');

    // Lead actor movies
    if (cast[0]) {
      setText('leadActorName', cast[0].name);
      await renderActorMoviesInSection('actorMoviesRow', cast[0].personId, cast[0].name);
    } else {
      renderMiniGrid('actorMoviesRow', [], 'Cast info unavailable.');
    }

    // Director movies
    if (directorName) {
      await renderDirectorMoviesInSection('directorMoviesRow', directorName, movie.id);
    } else {
      renderMiniGrid('directorMoviesRow', [], 'Director info unavailable.');
    }

    // Backdrop
    if (details.backdrop_path) {
      const heroBg = document.getElementById('detailHeroBg');
      if (heroBg) heroBg.style.backgroundImage = `url(${TMDB_IMG_ORIGINAL}${details.backdrop_path})`;
    }

    // Poster
    const posterEl = document.getElementById('detailPoster');
    if (posterEl && details.poster_path && (!movie.posterUrl || movie.posterUrl === PLACEHOLDER)) {
      posterEl.src = `${TMDB_IMG_W500}${details.poster_path}`;
    }

    applyWatchProvidersFromDetails(movie, details);
    renderPlatformButtons(movie);

    if (!movie.ottPlatforms?.length && HAS_TMDB) {
      await fetchAndSetWatchProviders({ ...movie, tmdbId: movie.tmdbId });
    }

  } catch (err) {
    console.warn('Detail enrich failed:', err);
    fallbackDetailSections(movie);
  }
}

function fallbackDetailSections(movie) {
  const imdbTitleUrl = getImdbTitleUrlFromId(movie.imdbId || movie.imdb_id);
  setDetailImdbLink(imdbTitleUrl);
  setDetailWatchNowLink(imdbTitleUrl);

  if (!imdbTitleUrl) {
    resolveExactImdbLink(movie).then((resolvedUrl) => {
      if (!resolvedUrl) return;
      if (Number(currentDetailMovieId) !== Number(movie.id)) return;
      setDetailImdbLink(resolvedUrl);
      setDetailWatchNowLink(resolvedUrl);
    });
  }

  const trailerEmbed = document.getElementById('detailTrailerEmbed');
  if (trailerEmbed) {
    trailerEmbed.src = movie.trailerYT
      ? `https://www.youtube.com/embed/${movie.trailerYT}?controls=1`
      : `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(movie.title + ' trailer')}`;
  }
  renderCastCrew(normalizeCastEntries(movie.cast || []));
  setText('directorName', movie.director || 'N/A');
  const similarMovies = (movie.similarMovieIds || []).map(id => allMovies.find(m => m.id === id)).filter(Boolean).slice(0, 12);
  renderMiniGrid('similarMoviesRow', similarMovies, 'No similar movies found.');
  const lead = (movie.cast || [])[0];
  if (lead) {
    setText('leadActorName', lead.name);
    const actorMovies = allMovies.filter(m => m.id !== movie.id && (m.cast || []).some(c => c.name === lead.name)).slice(0, 12);
    renderMiniGrid('actorMoviesRow', actorMovies, 'No other films by this actor.');
  } else {
    renderMiniGrid('actorMoviesRow', [], 'Cast info unavailable.');
  }
  const dirMovies = allMovies.filter(m => m.id !== movie.id && m.director === movie.director).slice(0, 12);
  renderMiniGrid('directorMoviesRow', dirMovies, 'No other films by this director.');
}

/* ===================================================
   CAST CREW
   =================================================== */
function normalizeCastEntries(cast = []) {
  return (Array.isArray(cast) ? cast : []).map((entry) => {
    if (!entry) return null;

    if (typeof entry === 'string') {
      return { name: entry, role: 'Cast', personId: null, profilePath: null };
    }

    const name = entry.name || entry.original_name || 'Unknown';
    const role = entry.role || entry.character || entry.job || 'Cast';
    const rawId = Number(entry.personId ?? entry.id ?? NaN);
    const personId = Number.isFinite(rawId) ? rawId : null;
    const profilePath = entry.profilePath
      || (entry.profile_path ? `https://image.tmdb.org/t/p/w185${entry.profile_path}` : null);

    return { name, role, personId, profilePath };
  }).filter(Boolean);
}

function renderCastCrew(cast) {
  const container = document.getElementById('detailCastCrew');
  if (!container) return;
  const normalizedCast = normalizeCastEntries(cast);
  if (!normalizedCast.length) {
    container.innerHTML = '<p class="text-muted small">Cast information unavailable.</p>';
    return;
  }
  container.innerHTML = normalizedCast.map(person => {
    const encodedName = encodeURIComponent(person.name || 'Unknown');
    const personId = Number.isFinite(person.personId) ? person.personId : 'null';
    const avatar = person.profilePath
      ? `<img src="${person.profilePath}" alt="${escapeHtml(person.name)}" onerror="this.parentNode.innerHTML='<i class=\\'bi bi-person-circle\\'></i>'">`
      : '<i class="bi bi-person-circle"></i>';
    return `
      <button class="cast-card" type="button"
        onclick="showActorPage(decodeURIComponent('${encodedName}'), ${personId})"
        title="View filmography of ${escapeHtml(person.name)}">
        <div class="cast-avatar">${avatar}</div>
        <div class="cast-info">
          <h6>${escapeHtml(person.name || 'Unknown')}</h6>
          <small>${escapeHtml(person.role || 'Cast')}</small>
        </div>
        <i class="bi bi-chevron-right ms-auto" style="font-size:0.7rem; color: var(--muted)"></i>
      </button>
    `;
  }).join('');
}

/* ===================================================
   ACTOR PAGE
   =================================================== */
async function showActorPage(actorName, personId = null) {
  if (currentPage !== 'detail') previousPage = currentPage;
  navigationHistory.push({ type: 'actor', name: actorName, id: personId });

  let actorMovies = [];
  let actorInfo = null;

  if (HAS_TMDB && personId && Number.isFinite(personId)) {
    try {
      const [credits, person] = await Promise.all([
        tmdbGet(`/person/${personId}/movie_credits`),
        tmdbGet(`/person/${personId}`)
      ]);
      actorInfo = person;
      actorMovies = (credits.cast || [])
        .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))
        .slice(0, 80)
        .map(item => {
          const mapped = { ...mapTmdbMovie(item), isTV: false };
          // CRITICAL: merge into allMovies so showDetailPage can find them
          if (!allMovies.find(m => m.id === mapped.id)) allMovies.push(mapped);
          return mapped;
        });
    } catch (err) {
      console.warn('Actor page API failed:', err);
    }
  }

  if (!actorMovies.length) {
    actorMovies = allMovies.filter(m =>
      (m.cast || []).some(c => c.name?.toLowerCase() === actorName?.toLowerCase())
    );
  }

  const profileImg = actorInfo?.profile_path
    ? `<img src="https://image.tmdb.org/t/p/w185${actorInfo.profile_path}" alt="${escapeHtml(actorName)}" style="width:100%;height:100%;object-fit:cover">`
    : '<i class="bi bi-person-fill"></i>';

  const heroBio = actorInfo?.biography
    ? `<p class="actor-bio small mt-2" style="max-width:600px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(actorInfo.biography)}</p>`
    : '';

  const detailHero = document.getElementById('detailHero');
  const detailBody = document.getElementById('detailBody');
  const heroBg = document.getElementById('detailHeroBg');
  if (heroBg) heroBg.style.backgroundImage = actorInfo?.profile_path
    ? `url(https://image.tmdb.org/t/p/w780${actorInfo.profile_path})`
    : '';

  if (detailHero) detailHero.innerHTML = `
    <div class="detail-hero-bg" id="detailHeroBg" style="background-image:${actorInfo?.profile_path ? `url(https://image.tmdb.org/t/p/w780${actorInfo.profile_path})` : ''}"></div>
    <div class="detail-hero-overlay"></div>
    <div class="container-xl py-5 position-relative">
      <div class="d-flex align-items-center gap-4 flex-wrap">
        <div class="actor-avatar-lg">${profileImg}</div>
        <div>
          <h1 class="detail-title mb-1">${escapeHtml(actorName)}</h1>
          <p class="actor-subtext mb-0">${actorMovies.length} films in database</p>
          ${heroBio}
        </div>
      </div>
    </div>
  `;

  if (detailBody) detailBody.innerHTML = `
    <div class="mb-4 d-flex align-items-center justify-content-between">
      <h3 class="carousel-section-title mb-0">
        <i class="bi bi-film me-2 accent-text"></i>Filmography — ${escapeHtml(actorName)}
      </h3>
    </div>
    <div class="similar-grid" id="actorFilmography"></div>
  `;

  const filmographyEl = document.getElementById('actorFilmography');
  if (filmographyEl) {
    if (!actorMovies.length) {
      filmographyEl.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:3rem 0;color:var(--muted)">
          <i class="bi bi-camera-video" style="font-size:3rem;display:block;margin-bottom:1rem"></i>
          <p>No movies found for ${escapeHtml(actorName)}</p>
        </div>`;
    } else {
      // Use square mini-cards for filmography
      filmographyEl.innerHTML = actorMovies.map(m => createMiniMovieCard(m)).join('');
      // Attach watchlist buttons
      setTimeout(() => attachWatchlistBtns(filmographyEl), 0);
    }
  }

  const bc = document.getElementById('breadcrumbTitle');
  if (bc) bc.textContent = actorName;

  setActivePage('detail');
}

async function renderActorMoviesInSection(rowId, personId, actorName) {
  if (!HAS_TMDB || !personId) {
    renderMiniGrid(rowId, [], 'No other films by this actor.');
    return;
  }
  try {
    const credits = await tmdbGet(`/person/${personId}/movie_credits`);
    const movies = (credits.cast || []).slice(0, 12).map(item => {
      const mapped = { ...mapTmdbMovie(item), isTV: false };
      if (!allMovies.find(m => m.id === mapped.id)) allMovies.push(mapped);
      return mapped;
    });
    renderMiniGrid(rowId, movies, 'No other films by this actor.');
  } catch {
    renderMiniGrid(rowId, [], 'Could not load actor films.');
  }
}

async function renderDirectorMoviesInSection(rowId, directorName, currentMovieId) {
  if (!directorName || directorName === 'N/A') {
    renderMiniGrid(rowId, [], 'Director info unavailable.'); return;
  }
  if (HAS_TMDB) {
    try {
      const data = await tmdbGet('/search/person', { query: directorName });
      const person = data.results?.[0];
      if (person) {
        const credits = await tmdbGet(`/person/${person.id}/movie_credits`);
        const movies = (credits.crew || [])
          .filter(c => c.job === 'Director' && c.id !== currentMovieId)
          .slice(0, 12)
          .map(item => {
            const mapped = { ...mapTmdbMovie(item), isTV: false };
            if (!allMovies.find(m => m.id === mapped.id)) allMovies.push(mapped);
            return mapped;
          });
        renderMiniGrid(rowId, movies, 'No other films by this director.');
        return;
      }
    } catch {}
  }
  const dirMovies = allMovies.filter(m => m.id !== currentMovieId && m.director === directorName).slice(0, 12);
  renderMiniGrid(rowId, dirMovies, 'No other films by this director.');
}

/* ===================================================
  MINI GRID (horizontal rail)
  =================================================== */
function renderMiniGrid(containerId, movies, emptyMessage) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!movies?.length) {
    container.innerHTML = `<p class="no-similar">${emptyMessage}</p>`;
    return;
  }
  container.innerHTML = movies.map(createMiniMovieCard).join('');
}

function createMiniMovieCard(movie) {
  const posterUrl = (movie.posterUrl && movie.posterUrl !== '') ? movie.posterUrl : PLACEHOLDER;
  const safePoster = PLACEHOLDER.replace(/'/g, '%27');
  const isTV = movie.isTV || false;
  const rating = Number(movie.rating);
  const langShort = (movie.language || '').split(' ')[0].slice(0, 7);

  return `
    <div class="mini-movie-card" onclick="openMovie(${movie.id}, ${isTV})" title="${escapeHtml(movie.title)}">
      <div class="mini-movie-card-img">
        <img src="${posterUrl}" alt="${escapeHtml(movie.title)}" loading="lazy" decoding="async" width="342" height="342"
          onerror="if(this.src!=='${safePoster}'){this.src='${safePoster}'}" />
        ${rating > 0 ? `<span class="mini-rating-badge"><i class="bi bi-star-fill" style="font-size:0.6rem"></i> ${rating.toFixed(1)}</span>` : ''}
        ${langShort ? `<span class="mini-lang-badge">${langShort}</span>` : ''}
      </div>
      <div class="mini-movie-card-body">
        <h6>${escapeHtml(movie.title)}</h6>
        <small>${movie.year || 'N/A'}</small>
      </div>
    </div>
  `;
}

/* ===================================================
   NAVIGATION
   =================================================== */
function historyBack() {
  // Remove current entry
  navigationHistory.pop();
  const prev = navigationHistory[navigationHistory.length - 1];

  if (!prev) {
    // Go back to where we came from before detail
    if (previousPage === 'movies') {
      showMoviesPage({ keepFilters: true, restoreOnly: true });
    } else if (previousPage === 'series') {
      showSeriesPage({ keepFilters: true, restoreOnly: true });
    } else {
      showHome({ restoreOnly: true });
    }
    return;
  }

  navigationHistory.pop();

  if (prev.type === 'detail') {
    showDetailPage(prev.id, prev.isTV || false);
  } else if (prev.type === 'actor') {
    showActorPage(prev.name, prev.id);
  } else {
    if (previousPage === 'movies') {
      showMoviesPage({ keepFilters: true, restoreOnly: true });
    } else if (previousPage === 'series') {
      showSeriesPage({ keepFilters: true, restoreOnly: true });
    } else {
      showHome({ restoreOnly: true });
    }
  }
}

/* ===================================================
   BROWSER BACK BUTTON SUPPORT
   =================================================== */
window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (!state) {
    applyRouteFromLocation({ replaceHistory: true });
    return;
  }

  currentPage = state.page || 'home';
  previousPage = state.previousPage || 'home';
  navigationHistory = state.navigationHistory || [];
  currentDetailMovieId = Number(state.currentDetailMovieId) || null;
  currentDetailIsTV = Boolean(state.currentDetailIsTV);

  if (state.page === 'detail' && state.currentDetailMovieId) {
    showDetailPage(Number(state.currentDetailMovieId), Boolean(state.currentDetailIsTV), { skipHistory: true });
  } else if (state.page === 'movies') {
    showMoviesPage({ skipHistory: true, keepFilters: true, restoreOnly: hasPageSelectionState('movies') });
  } else if (state.page === 'series') {
    showSeriesPage({ skipHistory: true, keepFilters: true, restoreOnly: hasPageSelectionState('series') });
  } else {
    showHome({ skipHistory: true, restoreOnly: hasPageSelectionState('home') });
  }
});

/* ===================================================
   WATCHLIST
   =================================================== */
function isInWatchlist(movieId) {
  return getStoredWatchlist().includes(movieId);
}

function isInFavorites(movieId) {
  return getStoredFavorites().includes(movieId);
}

function toggleWatchlist(e) {
  const movieId = Number(e.currentTarget.getAttribute('data-movie-id'));
  const wl = getStoredWatchlist();
  const idx = wl.indexOf(movieId);
  if (idx > -1) { wl.splice(idx, 1); showToast('Removed from watchlist.'); }
  else { wl.push(movieId); showToast('✅ Added to watchlist!'); }
  setStoredWatchlist(wl);

  if (currentUser?._id && authToken) {
    const action = idx > -1 ? 'remove' : 'add';
    fetch(`http://localhost:5000/api/users/${currentUser._id}/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ movieId, action })
    }).catch(() => {});
  }

  renderWatchlist();
  renderMovies(filteredMovies);
  loadRecommendedRow();
  updateDetailActionButtons();
  updateStats();
}

function toggleWatchlistDetail() {
  if (!currentDetailMovieId) return;
  const wl = getStoredWatchlist();
  const idx = wl.indexOf(currentDetailMovieId);
  if (idx > -1) { wl.splice(idx, 1); showToast('Removed from watchlist.'); }
  else { wl.push(currentDetailMovieId); showToast('✅ Added to watchlist!'); }
  setStoredWatchlist(wl);

  if (currentUser?._id && authToken) {
    const action = idx > -1 ? 'remove' : 'add';
    fetch(`http://localhost:5000/api/users/${currentUser._id}/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ movieId: currentDetailMovieId, action })
    }).catch(() => {});
  }

  renderWatchlist();
  loadRecommendedRow();
  updateDetailActionButtons();
  updateStats();
}

function toggleFavDetail() {
  if (!currentDetailMovieId) return;
  const favs = getStoredFavorites();
  const idx = favs.indexOf(currentDetailMovieId);
  if (idx > -1) { favs.splice(idx, 1); showToast('Removed from favourites.'); }
  else { favs.push(currentDetailMovieId); showToast('❤️ Added to favourites!'); }
  setStoredFavorites(favs);
  updateDetailActionButtons();
}

function updateDetailActionButtons() {
  if (!currentDetailMovieId) return;
  const inWL = isInWatchlist(currentDetailMovieId);
  const inFav = isInFavorites(currentDetailMovieId);
  const wlIcon = document.getElementById('detailWLIcon');
  const wlText = document.getElementById('detailWLText');
  const favIcon = document.getElementById('detailFavIcon');
  const favText = document.getElementById('detailFavText');
  if (wlIcon) wlIcon.className = `bi bi-${inWL ? 'bookmark-heart-fill' : 'bookmark-heart'} me-1`;
  if (wlText) wlText.textContent = inWL ? 'Saved' : 'Save';
  if (favIcon) favIcon.className = `bi bi-${inFav ? 'heart-fill' : 'heart'} me-1`;
  if (favText) favText.textContent = inFav ? 'Liked' : 'Like';
}

function renderWatchlist() {
  const container = document.getElementById('watchlistContainer');
  const empty = document.getElementById('watchlistEmpty');
  const clearBtn = document.getElementById('clearWatchlistBtn');
  if (!container) return;
  const wl = getStoredWatchlist();
  const movies = wl.map(id => allMovies.find(m => m.id === id) || allSeries.find(m => m.id === id)).filter(Boolean);
  if (!movies.length) {
    container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  container.innerHTML = movies.map(m => createMovieCard(m)).join('');
  setTimeout(() => attachWatchlistBtns(container), 0);
  loadWatchlistRow();
}

function clearWatchlist() {
  const previousWatchlist = getStoredWatchlist();
  setStoredWatchlist([]);

  if (currentUser?._id && authToken) {
    // Simple sync path: remove each locally-known id from backend.
    const removals = previousWatchlist.map((movieId) => fetch(`http://localhost:5000/api/users/${currentUser._id}/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({ movieId, action: 'remove' })
    }));
    Promise.allSettled(removals).catch(() => {});
  }

  renderWatchlist();
  renderMovies(filteredMovies);
  loadWatchlistRow();
  loadRecommendedRow();
  updateStats();
  showToast('Watchlist cleared.');
}

/* ===================================================
   REVIEWS
   =================================================== */
function handleReviewSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('reviewerName').value.trim();
  const movieId = document.getElementById('reviewMovieSelect').value;
  const text = document.getElementById('reviewText').value.trim();

  let valid = true;
  if (!name || name.length < 2) { document.getElementById('reviewerName').classList.add('is-invalid'); valid = false; } else document.getElementById('reviewerName').classList.remove('is-invalid');
  if (!movieId) { document.getElementById('reviewMovieSelect').classList.add('is-invalid'); valid = false; } else document.getElementById('reviewMovieSelect').classList.remove('is-invalid');
  if (!currentRating) { document.getElementById('ratingError').style.display = 'block'; valid = false; } else document.getElementById('ratingError').style.display = 'none';
  if (!text || text.length < 10) { document.getElementById('reviewText').classList.add('is-invalid'); valid = false; } else document.getElementById('reviewText').classList.remove('is-invalid');

  if (!valid) return;

  const movie = allMovies.find(m => m.id === Number(movieId)) || allSeries.find(m => m.id === Number(movieId));
  const reviews = JSON.parse(localStorage.getItem('reviews') || '[]');
  reviews.unshift({
    id: Date.now(), name, movieId: Number(movieId),
    movieTitle: movie?.title || 'Unknown', rating: currentRating, text,
    date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  });
  localStorage.setItem('reviews', JSON.stringify(reviews.slice(0, 100)));
  renderReviews();
  e.target.reset();
  currentRating = 0;
  document.querySelectorAll('.star:not(.detail-star)').forEach(s => s.classList.remove('active'));
  showToast('✅ Review submitted!');
  updateStats();
}

function renderReviews() {
  const container = document.getElementById('reviewsContainer');
  const empty = document.getElementById('reviewsEmpty');
  const reviews = JSON.parse(localStorage.getItem('reviews') || '[]');
  if (!container) return;
  if (!reviews.length) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  container.innerHTML = reviews.map(r => `
    <div class="review-item">
      <div class="review-header">
        <div>
          <span class="reviewer-name">${escapeHtml(r.name)}</span>
          <span class="review-movie ms-2">— ${escapeHtml(r.movieTitle)}</span>
        </div>
        <span class="review-stars">${stars(r.rating)}</span>
      </div>
      <p class="review-text mb-1">${escapeHtml(r.text)}</p>
      <span class="review-date">${r.date}</span>
    </div>
  `).join('');
}

/* ===================================================
   STATS
   =================================================== */
function updateStats() {
  setText('totalMovies', (allMovies.length + allSeries.length).toLocaleString());
  setText('totalReviews', JSON.parse(localStorage.getItem('reviews') || '[]').length.toLocaleString());
  setText('watchlistCount', getStoredWatchlist().length.toLocaleString());
}

/* ===================================================
   THEME
   =================================================== */
function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  setTheme(saved, false);
}

function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (save) localStorage.setItem('theme', theme);
  // Inject theme-specific fonts on demand
  if (theme === 'hp' && !document.getElementById('hp-font')) {
    const link = document.createElement('link');
    link.id = 'hp-font'; link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Uncial+Antiqua&display=swap';
    document.head.appendChild(link);
  }

  applyThemeBranding(theme);
  initThemeImmersion(theme);
}

/* ===================================================
   TOAST
   =================================================== */
function showToast(message) {
  const toastEl = document.getElementById('appToast');
  const toastBody = document.getElementById('toastBody');
  if (!toastEl || !toastBody) return;
  toastBody.textContent = message;
  const toast = new bootstrap.Toast(toastEl, { delay: 2500 });
  toast.show();
}

/* ===================================================
   UTILS
   =================================================== */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = '';
}