const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const { randomBytes } = require('crypto');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const GMAIL_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]{0,62}[a-zA-Z0-9])?@gmail\.com$/;
let googleOAuthClient = null;

function createHttpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidGmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return GMAIL_REGEX.test(normalized);
}

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    return null;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKeyRaw.replace(/\\n/g, '\n')
    })
  });

  return admin;
}

function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  if (!googleOAuthClient) {
    googleOAuthClient = new OAuth2Client(clientId);
  }
  return googleOAuthClient;
}

async function verifyGoogleIdentityToken(idToken) {
  const token = String(idToken || '').trim();
  if (!token) {
    throw createHttpError('idToken is required', 400);
  }

  let lastVerifyError = null;

  // Try Firebase Admin verification first when configured.
  const adminSdk = getFirebaseAdmin();
  if (adminSdk) {
    try {
      const decoded = await adminSdk.auth().verifyIdToken(token);
      return {
        sub: String(decoded.uid || decoded.sub || ''),
        email: normalizeEmail(decoded.email || ''),
        name: String(decoded.name || '').trim(),
        emailVerified: Boolean(decoded.email_verified)
      };
    } catch (err) {
      lastVerifyError = err;
    }
  }

  // Fallback to Google Identity Services ID token verification.
  const oauthClient = getGoogleOAuthClient();
  if (oauthClient) {
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      const payload = ticket.getPayload() || {};

      return {
        sub: String(payload.sub || ''),
        email: normalizeEmail(payload.email || ''),
        name: String(payload.name || '').trim(),
        emailVerified: Boolean(payload.email_verified)
      };
    } catch (err) {
      lastVerifyError = err;
    }
  }

  if (!adminSdk && !oauthClient) {
    throw createHttpError('Google auth is not configured on server', 500);
  }

  if (lastVerifyError) {
    throw createHttpError('Invalid or expired Google token', 401);
  }

  throw createHttpError('Google token verification failed', 401);
}

function buildSession(user) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';

  const token = jwt.sign(
    { sub: String(user._id), email: user.email },
    secret,
    { expiresIn: '30d' }
  );

  return {
    token,
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      authProvider: user.authProvider || 'local',
      preferredLanguages: user.preferredLanguages || [],
      preferredGenres: user.preferredGenres || [],
      watchlist: user.watchlist || [],
      ratings: user.ratings || {}
    }
  };
}

router.post('/register', async (req, res) => {
  try {
    const { name = '', email = '', password = '' } = req.body || {};
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !String(password).trim()) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (!isValidGmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Only valid Gmail accounts are allowed' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const existing = await User.findOne({ email: normalizedEmail }).lean();
    if (existing) {
      return res.status(409).json({ message: 'Email is already registered' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      name: String(name || '').trim(),
      email: normalizedEmail,
      passwordHash,
      authProvider: 'local',
      emailVerified: false,
      preferredLanguages: [],
      preferredGenres: [],
      watchlist: [],
      ratings: {}
    });

    return res.status(201).json(buildSession(user));
  } catch (error) {
    return res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email = '', password = '' } = req.body || {};
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || !String(password).trim()) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    if (!isValidGmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Only valid Gmail accounts are allowed' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    return res.json(buildSession(user));
  } catch (error) {
    return res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { idToken = '', credential = '' } = req.body || {};
    const tokenInput = String(idToken || credential || '').trim();

    if (!tokenInput) {
      return res.status(400).json({ message: 'idToken is required' });
    }

    const identity = await verifyGoogleIdentityToken(tokenInput);
    const normalizedEmail = identity.email;
    const name = identity.name;

    if (!identity.emailVerified) {
      return res.status(403).json({ message: 'Google account email is not verified' });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!isValidGmail(normalizedEmail)) {
      return res.status(403).json({ message: 'Only Gmail Google accounts are allowed' });
    }

    let user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      const randomSecret = `google-${randomBytes(24).toString('hex')}`;
      const passwordHash = await bcrypt.hash(randomSecret, 10);
      user = await User.create({
        name: String(name || '').trim(),
        email: normalizedEmail,
        passwordHash,
        authProvider: 'google',
        googleSub: identity.sub || '',
        emailVerified: true,
        preferredLanguages: [],
        preferredGenres: [],
        watchlist: [],
        ratings: {}
      });
    } else {
      let changed = false;

      if (!user.name && name) {
        user.name = String(name).trim();
        changed = true;
      }
      if (user.authProvider !== 'google') {
        user.authProvider = 'google';
        changed = true;
      }
      if (identity.sub && user.googleSub !== identity.sub) {
        user.googleSub = identity.sub;
        changed = true;
      }
      if (!user.emailVerified) {
        user.emailVerified = true;
        changed = true;
      }

      if (changed) {
        await user.save();
      }
    }

    return res.json(buildSession(user));
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    if (status >= 500) {
      return res.status(status).json({ message: 'Google login failed', error: error.message });
    }
    return res.status(status).json({ message: error.message });
  }
});

router.get('/google-config', (_req, res) => {
  const hasFirebaseAdminCreds = Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
  const googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();

  return res.json({
    enabled: Boolean(googleClientId || hasFirebaseAdminCreds),
    hasFirebaseAdminCreds,
    clientId: googleClientId || ''
  });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.user.id || ''))) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      preferredLanguages: user.preferredLanguages || [],
      preferredGenres: user.preferredGenres || [],
      watchlist: user.watchlist || [],
      ratings: user.ratings || {}
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load user', error: error.message });
  }
});

module.exports = router;
