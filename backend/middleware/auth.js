const jwt = require('jsonwebtoken');

const GMAIL_EMAIL_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]{0,62}[a-zA-Z0-9])?@gmail\.com$/;

function isGmailEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return GMAIL_EMAIL_REGEX.test(normalized);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({ message: 'Missing auth token' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';

    const payload = jwt.verify(token, secret);
    if (!isGmailEmail(payload.email)) {
      return res.status(401).json({ message: 'Only Gmail accounts are allowed' });
    }
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (_error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
