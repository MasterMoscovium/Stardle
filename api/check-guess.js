const crypto = require('crypto');
const { getTodayWordEntry, isValidWord, evaluateGuess, getISTDateString } = require('./_lib/stardleCore');

// ---------------------------------------------------------------
// HMAC Stateless Token Infrastructure
// ---------------------------------------------------------------
const TOKEN_SECRET = process.env.STARDLE_TOKEN_SECRET || 'stardle-dhruva-astronomy-2026-secure-secret-salt';
const MAX_GUESSES_PER_DAY = 6;

function signToken(data) {
  const json = JSON.stringify(data);
  const b64 = Buffer.from(json).toString('base64url');
  const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  return `${b64}.${hmac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, signature] = parts;

  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  
  // Timing-safe constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------
// Per-IP Rate Limiting (blocks automated denial-of-service / brute-force)
// ---------------------------------------------------------------
const rateLimiter = new Map(); // key: IP string -> { count: number, windowStart: number }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30;      // max 30 guesses per minute per IP

function getClientIP(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimiter.get(ip);
  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimiter.set(ip, entry);
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

// Clean up stale rate-limit entries periodically
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimiter) {
    if ((now - entry.windowStart) > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimiter.delete(ip);
    }
  }
}, 5 * 60 * 1000);
if (rateCleanupTimer && typeof rateCleanupTimer.unref === 'function') {
  rateCleanupTimer.unref();
}

// ---------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, message: 'Method Not Allowed' });
  }

  // Rate limiting check
  const clientIP = getClientIP(req);
  if (isRateLimited(clientIP)) {
    return res.status(429).json({ valid: false, message: 'Too many requests. Please slow down.' });
  }

  try {
    // Parse JSON body
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    } else if (!body && typeof req.on === 'function') {
      body = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
          try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
        });
        req.on('error', () => resolve({}));
      });
    }
    body = body || {};

    const rawGuess = body.guess;
    if (!rawGuess || typeof rawGuess !== 'string') {
      return res.status(400).json({ valid: false, message: 'Missing guess' });
    }

    const guess = rawGuess.trim().toLowerCase();
    if (guess.length !== 5) {
      return res.status(400).json({ valid: false, message: 'Word must be 5 letters' });
    }

    // Check against dictionary of valid 5-letter words
    if (!isValidWord(guess)) {
      return res.status(200).json({ valid: false, message: 'Not in word list' });
    }

    const todayEntry = getTodayWordEntry();
    if (!todayEntry) {
      return res.status(500).json({ valid: false, message: 'Daily puzzle not found' });
    }

    const todayDate = getISTDateString();
    const targetWord = todayEntry.word.toLowerCase();

    // Verify client session token (cryptographically prevents guessIndex spoofing)
    const clientToken = body.token;
    let tokenData = verifyToken(clientToken);

    // If token belonged to a different target word (e.g. from duplicate 'epoch' earlier today), invalidate it
    if (tokenData && tokenData.t && tokenData.t !== targetWord) {
      tokenData = null;
    }

    let previousGuesses = [];
    if (tokenData && tokenData.d === todayDate && Array.isArray(tokenData.g)) {
      // If player already completed puzzle on this token, return game over
      if (tokenData.c >= MAX_GUESSES_PER_DAY || tokenData.w) {
        return res.status(200).json({
          valid: false,
          message: 'You have already completed today\'s puzzle.',
          gameOver: true,
          solution: {
            word: todayEntry.word,
            explanation: todayEntry.explanation,
            articleUrl: todayEntry.articleUrl,
            song: todayEntry.song,
            artist: todayEntry.artist,
            spotify: todayEntry.spotify,
            apple: todayEntry.apple,
            youtube: todayEntry.youtube
          }
        });
      }

      // Prevent duplicate guesses within the same session
      if (tokenData.g.includes(guess)) {
        return res.status(200).json({ valid: false, message: 'Already guessed' });
      }

      previousGuesses = tokenData.g;
    }

    const evalResult = evaluateGuess(guess, targetWord);
    const won = (guess === targetWord);

    const newGuesses = [...previousGuesses, guess];
    const newCount = newGuesses.length;
    const isGameOver = won || (newCount >= MAX_GUESSES_PER_DAY);

    // Issue new cryptographically signed token for the client
    const newToken = signToken({
      d: todayDate,
      t: targetWord,
      c: newCount,
      g: newGuesses,
      w: won
    });

    const response = {
      valid: true,
      won,
      eval: evalResult,
      activeRow: previousGuesses.length, // Server-verified 0-indexed row
      token: newToken
    };

    // Solution is strictly released ONLY when the player wins or legitimately exhausts all 6 attempts
    if (isGameOver) {
      response.solution = {
        word: todayEntry.word,
        explanation: todayEntry.explanation,
        articleUrl: todayEntry.articleUrl,
        song: todayEntry.song,
        artist: todayEntry.artist,
        spotify: todayEntry.spotify,
        apple: todayEntry.apple,
        youtube: todayEntry.youtube
      };
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('[API /check-guess error]:', err);
    return res.status(500).json({ valid: false, message: 'Internal server error' });
  }
};
