const express = require('express');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

function isOwner(req, res) {
  if (String(req.params.id) !== String(req.user.id)) {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

router.post('/:id/preferences', async (req, res) => {
  try {
    if (!isOwner(req, res)) return;

    const preferredLanguages = Array.isArray(req.body?.preferredLanguages)
      ? req.body.preferredLanguages.map((v) => String(v).trim()).filter(Boolean)
      : undefined;

    const preferredGenres = Array.isArray(req.body?.preferredGenres)
      ? req.body.preferredGenres.map((v) => String(v).trim()).filter(Boolean)
      : undefined;

    const patch = {};
    if (preferredLanguages) patch.preferredLanguages = preferredLanguages;
    if (preferredGenres) patch.preferredGenres = preferredGenres;

    const user = await User.findByIdAndUpdate(req.params.id, patch, { new: true });
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
    return res.status(500).json({ message: 'Failed to save preferences', error: error.message });
  }
});

router.post('/:id/watchlist', async (req, res) => {
  try {
    if (!isOwner(req, res)) return;

    const movieId = Number(req.body?.movieId);
    if (!Number.isFinite(movieId)) {
      return res.status(400).json({ message: 'movieId must be a number' });
    }

    const action = req.body?.action === 'remove' ? 'remove' : 'add';
    const update = action === 'remove'
      ? { $pull: { watchlist: movieId } }
      : { $addToSet: { watchlist: movieId } };

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });

    return res.json({ watchlist: user.watchlist || [] });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update watchlist', error: error.message });
  }
});

router.post('/:id/ratings', async (req, res) => {
  try {
    if (!isOwner(req, res)) return;

    const movieId = Number(req.body?.movieId);
    const rating = Number(req.body?.rating);

    if (!Number.isFinite(movieId)) {
      return res.status(400).json({ message: 'movieId must be a number' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (!Number.isFinite(rating) || rating <= 0) {
      user.ratings.delete(String(movieId));
    } else {
      user.ratings.set(String(movieId), Math.max(1, Math.min(5, rating)));
    }

    await user.save();
    return res.json({ ratings: user.ratings || {} });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update ratings', error: error.message });
  }
});

module.exports = router;
