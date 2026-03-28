require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const mongoose = require('mongoose');

const moviesRoutes = require('./routes/movies');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const recommendationRoutes = require('./routes/recommendation');

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS not allowed for this origin'));
  }
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));

app.use('/api/movies', moviesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/recommendations', recommendationRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'CinemaWorld API' });
});

async function startServer() {
  try {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI is not set in environment variables');
    }

    await mongoose.connect(mongoUri);
    console.log('MongoDB connected successfully');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  }
}

startServer();
