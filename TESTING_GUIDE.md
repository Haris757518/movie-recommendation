# 🧪 QUICK TEST GUIDE - CinemaWorld v3

## TEST 1: Navigation Flow ✅
```
1. Open main.html
2. Click "Movies" → should show movies page
3. Click "Series" → should show series page  
4. Click any movie → should show detail page
5. Click "Back" button → should return to previous page
```

**Expected**: All redirects work smoothly, no broken links

---

## TEST 2: Local Data Fallback ✅
```
1. Open main.html
2. When API key modal appears, click "Skip (use local data)"
3. Should load 23 local movies from images/data/movies.json
4. Top 10 trending should display from local data
5. Movies grid should populate with results
```

**Expected**: Local data loads perfectly when no API key

---

## TEST 3: Detail Page ✅
```
1. Load app with local data
2. Click any movie card
3. Should show poster, title, year, rating, director
4. Should show cast & crew section
5. Should show similar movies
6. Should show actor filmography
7. Should show director's other films
8. Should show rate & review section
```

**Expected**: Complete detail page with all sections

---

## TEST 4: Back Navigation ✅
```
SCENARIO A: Home → Movies → Detail → Back
1. From Home, click "Movies" button
2. Click first movie
3. Click "Back" button
4. Should return to Movies page (NOT Home)

SCENARIO B: Home → Detail → Back  
1. From Home, click first trending movie
2. Click "Back" button
3. Should return to Home page

SCENARIO C: Detail → Actor → Back
1. In detail page, click any actor
2. Should go to actor filmography page
3. Click "Back" button
4. Should return to detail page
```

**Expected**: Back button always goes to correct previous page

---

## TEST 5: Watchlist Functionality ✅
```
1. Click "Save" on any movie card
2. Should show ✅ confirmation toast
3. Navigate to Watchlist section (on Home)
4. Movie should appear in watchlist
5. Click "Save" again to remove
6. Should say "Removed from watchlist"
7. Movie disappears from watchlist
```

**Expected**: Watchlist adds/removes movies correctly

---

## TEST 6: Reviews System ✅
```
1. Scroll to "Community Reviews" section
2. Enter name in "YOUR NAME" field
3. Click stars to set rating (1-5)
4. Enter review text (min 10 chars)
5. Select movie from dropdown
6. Click "Submit Review"
7. Should see ✅ success toast
8. Review should appear in list
```

**Expected**: Reviews save, validate, and display correctly

---

## TEST 7: Search & Filters ✅
```
1. Type in search box (min 2 chars)
2. Results should appear in dropdown
3. Click result → should go to detail page
4. Use language filter → results update
5. Use genre filter → results update
6. Use year filter → results update
7. Use sort options → results re-sort
```

**Expected**: Search and filters work instantly

---

## TEST 8: Movies vs Series ✅
```
1. Click "Movies" button
2. Should show only movies
3. Click "Series" button  
4. Should show only TV series
5. Series should have "Series" badge
6. Click series → should load series detail
7. Back to Home, top 10 should show both
```

**Expected**: Movies and Series properly separated

---

## TEST 9: Theme Switching ✅
```
1. Click theme dropdown in navbar
2. Select "Dark" → apply dark theme
3. Select "Neon" → apply neon colors
4. Select "Stranger Things" → orange ambient effects
5. Select "Game of Thrones" → gold ambient effects
6. Theme should persist on refresh
```

**Expected**: All 4 themes work and persist

---

## TEST 10: Responsive Design ✅
```
Mobile (375px):
1. Grid should show 6 columns (small cards)
2. Menu should be hamburger
3. All text readable

Tablet (768px):
1. Grid should show 4 columns
2. Larger margins/padding
3. Good spacing

Desktop (1920px):
1. Grid should show 2 columns  
2. Detail page in columns
3. All sections visible
```

**Expected**: Layout adapts to all screen sizes

---

## KEY FILES TO CHECK

✅ **script.js** - Updated to v3 (85,320 bytes)
- Separate movies/series arrays
- Proper navigation tracking
- Fixed back button
- Correct movies.json path

✅ **main.html** - No changes needed
- Links to script.js
- Has all required elements (IDs, classes)

✅ **images/data/movies.json** - No changes needed
- Contains 23 local movies
- Used as fallback

✅ **main.css** - No changes needed
- Has all styling
- Responsive grid

---

## COMMON ISSUES & SOLUTIONS

### Issue: Movies won't load
**Solution**: Check browser console (F12) for errors. If "movies.json 404", verify path is "images/data/movies.json"

### Issue: Detail page blank
**Solution**: Movie ID might not exist. Check if movie exists in allMovies array. Verify TMDB API key if using API.

### Issue: Back button not working
**Solution**: Ensure navigationHistory and previousPage are being tracked. Check console for errors. Refresh page and try again.

### Issue: Watchlist not persisting
**Solution**: Check browser localStorage is enabled. Clear localStorage and try again. Check browser console for errors.

### Issue: Reviews disappearing
**Solution**: Reviews are stored in localStorage. Clear browser cache/localStorage and re-enter reviews. Max 100 reviews stored.

---

## SUCCESS INDICATORS ✅

After testing, you should see:
- All pages load without errors
- Navigation flows smoothly
- Back button works in all scenarios
- Movies and Series are separate
- Detail page shows all sections
- Watchlist persists across navigation
- Reviews save and display
- Search works with min 2 characters
- All themes apply correctly
- No 404 errors for movies.json
- No JavaScript errors in console
- Responsive layout works on all sizes

**If all tests pass = PERFECT PRODUCTION-READY CODE! 🚀**
