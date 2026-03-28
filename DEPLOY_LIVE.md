# Deploy Live (Render + Vercel)

## 1) Backend on Render
1. Push this repo to GitHub.
2. In Render, create a Web Service from this repo.
3. Use these settings:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add env vars from `backend/.env.example`:
   - `MONGO_URI`
   - `TMDB_API_KEY`
   - `GOOGLE_CLIENT_ID` (optional but recommended)
5. Deploy and verify:
   - `https://YOUR_BACKEND.onrender.com/api/health`

## 2) Frontend on Vercel
1. Create a new Vercel project from the same repo.
2. Deploy from repository root (`main.html`, `script.js`, `main.css`).
3. After backend deploy, update one line in `main.html`:
   - Replace `https://your-backend.onrender.com/api` with your real Render URL.

## 3) Connect + Test
1. Open live frontend URL.
2. Validate:
   - Search from home works (movie + series)
   - Tamil upcoming list loads
   - Login and theme events work
3. If backend is sleeping on free tier, first request may be slow.

## Notes
- Local development still uses `http://localhost:5000/api` automatically.
- Production uses `window.CINEMA_API_BASE` set in `main.html`.
