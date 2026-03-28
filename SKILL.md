# CinemaIndia Movie Recommendation Platform — Custom Development Skill

**Project:** Pan-India Movie Recommender (HTML/CSS/Bootstrap/JavaScript)  
**Goal:** Build a feature-rich, theme-flexible movie discovery platform with 100+ Indian cinema entries

---

## 1. DESIGN & THEMING STANDARDS

### Color Palettes (Approved)

#### Dark Theme (Cool Cinematic)
- **Primary BG**: `#0a0d14` (deep blue-black)
- **Panel**: `#10141f` (cool dark slate)
- **Accent**: `#00d4ff` (cool cyan) — replacing yellow
- **Secondary Accent**: `#0096d6` (deep cyan)
- **Text**: `#e8ecf1` (cool white)
- **Muted**: `#7a8a9e` (cool grey)

#### Light Theme
- **Primary BG**: `#f5f7fc` (cool white)
- **Panel**: `#ffffff`
- **Accent**: `#0073a8` (professional blue)
- **Text**: `#1a2332` (cool dark)

#### Neon Theme (Toned Down)
- **Primary BG**: `#05080d` (darker base)
- **Accent**: `#00ffaa` (muted mint) — less aggressive
- **Secondary**: `#0086ff` (deeper blue)
- **Glow Strength**: `--accent-glow: rgba(0,255,170,0.15)` (reduced from 0.3)

#### Stranger Things Theme (Keep as is)
- **Primary BG**: `#0a0a0a`
- **Accent**: `#ff3a00` (orange-red)

### Font Strategy Per Theme
- **Dark & Light**: `'DM Sans'` (body), `'Playfair Display'` (headings) — professional
- **Neon**: `'Orbitron'` (all text) — tech feel, geometric
- **Stranger Things**: `'Creepster'` (headings), `'DM Sans'` (body) — creepy-retro

---

## 2. DATA MANAGEMENT

### movies.json Structure
```json
{
  "movies": [
    {
      "id": 1,
      "title": "Movie Title",
      "language": "Tamil|Telugu|Malayalam|Hindi|Kannada",
      "genre": ["Drama", "Action"],
      "year": 2023,
      "rating": 8.5,
      "director": "Director Name",
      "cast": [
        {"name": "Hero Name", "role": "Lead"},
        {"name": "Actor Name", "role": "Supporting"}
      ],
      "description": "Short description",
      "posterUrl": "https://...",
      "trailerYT": "youtube-video-id",
      "ottPlatforms": ["Netflix", "Prime Video"],
      "similarMovieIds": [2, 5, 12],
      "actorMovieIds": [3, 7, 15]
    }
  ]
}
```

**Data Source:** Hand-curated 100+ realistic Tamil/Telugu/Malayalam/Hindi/Kannada films with IMDb-style ratings, real cast/directors, and plausible OTT links.

---

## 3. UI/UX BEHAVIORS

### Search & Hero Section
- **Default State**: Hero section visible with "Discover the Best of Indian Cinema"
- **Search Active**: Hero section **hides** immediately on first character typed
- **Search Clear**: Hero section **reappears** when search input is cleared
- **Search Results**: Display results in grid below filter bar with result count

### Movie Cards
- **Image Display**: Use proper poster URLs (or fallback placeholder with title overlay)
- **Overlay Actions**: On hover—Trailer button, Watchlist button, Details link
- **Rating Badge**: IMDb-style yellow star + rating number
- **Language Badge**: Color-coded per language (Tamil: 🎵, Telugu: 🌟, etc.)

### Detail Page
- **Lead Actor Display**: Show hero name from `cast[0].name` (not generic placeholder)
- **Cast/Crew Section**: Grid of 4-6 cast members with role labels
- **Trailers**: Embed `<iframe>` with YouTube ID if available
- **Similar Movies**: Horizontal scroll of 6-8 related films
- **Actor Carousel**: Show all films by lead actor from `actorMovieIds`
- **Director Carousel**: Show all films by director

### Watchlist & Favorites
- **Storage**: `localStorage` with "watchlist" & "favorites" keys
- **Persistence**: Survive page reload
- **Sync UI**: Button states reflect saved status (green border if saved)

---

## 4. RESPONSIVE DESIGN

| Breakpoint | Grid | Layout |
|-----------|------|--------|
| **Desktop** (≥1200px) | 4 cols | Multi-column sections |
| **Tablet** (768-1199px) | 2-3 cols | Collapsed navbar |
| **Mobile** (< 768px) | 1-2 cols | Stacked layout, hamburger nav |

---

## 5. ACCESSIBILITY & PERFORMANCE

- **Semantic HTML**: `<header>`, `<main>`, `<section>`, `<article>` structure
- **ARIA Labels**: Search inputs, buttons, live regions for results
- **Focus States**: Visible focus rings on all interactive elements
- **Images**: Descriptive `alt` text (e.g., "Poster for Kabali (2015)")
- **Lazy Loading**: Images load on-demand for 100+ movie list
- **Debouncing**: Search input fires on `input` event with 150ms debounce

---

## 6. IMPLEMENTATION CHECKLIST

- [ ] Update `movies.json` with 100+ movies (5 languages, realistic data)
- [ ] Refactor `main.css` — apply cool dark palette, toned neon, font adjustments
- [ ] Update `script.js`:
  - [ ] Hero section hide/show on search
  - [ ] Lead actor name display fix
  - [ ] Image fallback & lazy loading
  - [ ] Search debouncing
  - [ ] Cast/crew grid rendering
  - [ ] Watchlist/favorites localStorage
  - [ ] Detail page carousel logic
- [ ] Test all 4 themes visually
- [ ] Verify mobile responsiveness
- [ ] Check accessibility (tab navigation, screen reader compat)

---

## 7. DELIVERY FORMAT

**Files to Update:**
1. `movies.json` — 100+ movie data with cast, similar movies, URLs
2. `main.css` — New color vars, font stacks, improved responsive
3. `script.js` — All UI logic, search, detail page, storage ops
4. `main.html` — (Minor tweaks if needed, mostly CSS/JS-driven)

**Code Style:**
- ES6+ (const/let, arrow functions, template literals)
- BEM-like class naming where applicable
- Comments for complex logic
- No console spam; clean error handling

---

## Review & Approval

User reviews this SKILL.md and approves before implementation begins. Once approved, all files are updated in a single batch using `multi_replace_string_in_file` for efficiency.
