/**
 * stardle.js
 * -----------------------------------------------------------------
 * Handles all Stardle-specific features:
 *   1. Animated starfield canvas background
 *   2. CSV word list loading (astrophysics_wordle_song_links-2.csv)
 *   3. IST-based word-of-the-day selection
 *   4. Hint panel (song links: Spotify, Apple Music, YouTube Music)
 *   5. Post-game popup (post-it note with Buzz wings & thrusters)
 *
 * IMPORTANT: This file does NOT touch any game logic in script.js.
 *            It only reads state, and hooks into game end events via
 *            MutationObserver watching the toast container + game state.
 * -----------------------------------------------------------------
 */

/* ==============================================================
   1. STARFIELD CANVAS
   ============================================================== */
(function initStarfield() {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W, H, stars = [], shootingStars = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function randBetween(a, b) { return a + Math.random() * (b - a); }

  function createStars(count) {
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x:        Math.random() * W,
        y:        Math.random() * H,
        r:        randBetween(0.3, 1.8),
        alpha:    randBetween(0.2, 1.0),
        alphaDir: Math.random() < 0.5 ? 1 : -1,
        speed:    randBetween(0.003, 0.018),
      });
    }
  }

  function maybeAddShootingStar() {
    if (Math.random() < 0.004 && shootingStars.length < 3) {
      shootingStars.push({
        x:      randBetween(W * 0.1, W * 0.9),
        y:      randBetween(0, H * 0.4),
        len:    randBetween(60, 140),
        speed:  randBetween(6, 14),
        angle:  randBetween(Math.PI / 6, Math.PI / 3),
        alpha:  1,
        decay:  randBetween(0.012, 0.025),
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Twinkling stars
    for (const s of stars) {
      s.alpha += s.alphaDir * s.speed;
      if (s.alpha >= 1 || s.alpha <= 0.15) s.alphaDir *= -1;

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 230, 255, ${s.alpha})`;
      ctx.fill();
    }

    // Shooting stars
    maybeAddShootingStar();
    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const ss = shootingStars[i];
      ctx.save();
      ctx.globalAlpha = ss.alpha;
      const grd = ctx.createLinearGradient(
        ss.x, ss.y,
        ss.x - Math.cos(ss.angle) * ss.len,
        ss.y - Math.sin(ss.angle) * ss.len
      );
      grd.addColorStop(0, 'rgba(255, 255, 230, 0.95)');
      grd.addColorStop(1, 'rgba(255, 255, 230, 0)');
      ctx.strokeStyle = grd;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ss.x, ss.y);
      ctx.lineTo(ss.x - Math.cos(ss.angle) * ss.len, ss.y - Math.sin(ss.angle) * ss.len);
      ctx.stroke();
      ctx.restore();

      ss.x += Math.cos(ss.angle) * ss.speed;
      ss.y += Math.sin(ss.angle) * ss.speed;
      ss.alpha -= ss.decay;
      if (ss.alpha <= 0) shootingStars.splice(i, 1);
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', () => { resize(); createStars(260); });
  resize();
  createStars(260);
  draw();
})();


/* ==============================================================
   2. PUZZLE LOADING — fetch daily hint and metadata from API
   ============================================================== */

async function loadStardlePuzzle() {
  try {
    let data = null;
    let resp = await fetch('/api/puzzle-info');
    if (resp.ok) {
      data = await resp.json();
    } else {
      // Resilient fallback: parse JSON body anyway in case edge routing modified status
      try {
        const candidate = await resp.json();
        if (candidate && (candidate.hint || candidate.puzzleNumber)) {
          data = candidate;
        }
      } catch (_) {}
      // If still no data, try trailing-slash URL /api/puzzle-info/
      if (!data) {
        try {
          const altResp = await fetch('/api/puzzle-info/');
          if (altResp.ok) data = await altResp.json();
        } catch (_) {}
      }
    }

    if (data && data.hint) {
      window.stardlePuzzleInfo = data;
      if (typeof State !== 'undefined') {
        State.hint = data.hint;
      }
      updateHintPanel(data.hint);
      handleDailyPuzzleState(data.date);
    }
  } catch (e) {
    console.warn('[Stardle] Could not load puzzle info:', e);
  }
}

function handleDailyPuzzleState(todayIST) {
  if (!todayIST) return;
  const lastPlayedDate = safeStorageGet('stardleLastDate');
  const saved = (() => {
    try {
      const savedState = safeStorageGet('gameState');
      return savedState ? JSON.parse(savedState) : null;
    } catch(e) {
      return null;
    }
  })();

  const isStaleWord = saved?.wordle && saved.wordle.toLowerCase() !== 'muons';
  const isNewDay = (lastPlayedDate && lastPlayedDate !== todayIST) || (saved?.date && saved.date !== todayIST) || isStaleWord;

  // If today is a new calendar day in IST:
  if (isNewDay) {
    safeStorageSet('stardleLastDate', todayIST);
    window.stardleSolution = null;
    window.stardleToken = null;
    gameEndHandled = false;

    if (typeof defaultGameState !== 'undefined' && typeof defaultUserState !== 'undefined') {
      const freshState = {
        ...defaultGameState,
        ...defaultUserState,
        stats: saved?.stats || defaultUserState.stats,
        winHistory: saved?.winHistory || defaultUserState.winHistory,
        gameHistory: saved?.gameHistory || defaultUserState.gameHistory,
        wordle: '',
        solution: null,
        token: null,
        date: todayIST,
        pointer: 0,
        won: false,
        checked: [null, null, null, null, null, null],
        gameBoard: Array.from({ length: 30 }, _ => ({ letter: null, state: null })),
      };

      if (typeof State !== 'undefined') {
        State = { ...State, ...freshState };
      }
      safeStorageSet('gameState', JSON.stringify(freshState));

      // Clean all tiles in the DOM immediately
      document.querySelectorAll('#game-board box').forEach(tile => {
        tile.innerText = '';
        tile.className = '';
        tile.removeAttribute('style');
      });

      // Reset all keyboard buttons in the DOM
      document.querySelectorAll('keyboard-row button').forEach(k => {
        k.classList.remove('wrongLetter', 'wrongSpot', 'rightSpot');
        k.removeAttribute('style');
      });

      // Ensure win modal / word popup is closed
      const popup = document.getElementById('word-popup');
      if (popup) {
        popup.classList.remove('open');
        popup.setAttribute('aria-hidden', 'true');
      }

      if (typeof update === 'function') {
        update(freshState);
      }
    }
    return;
  }

  // Same day: restore solution, hint, and session token if present
  if (saved?.solution) {
    window.stardleSolution = saved.solution;
  }
  if (saved?.hint) {
    if (!window.stardlePuzzleInfo) window.stardlePuzzleInfo = {};
    window.stardlePuzzleInfo.hint = saved.hint;
    updateHintPanel(saved.hint);
  }
  if (saved?.token) {
    window.stardleToken = saved.token;
  }

  if (!lastPlayedDate) {
    safeStorageSet('stardleLastDate', todayIST);
  }
}


/* ==============================================================
   3. IST-BASED WORD-OF-THE-DAY & MIDNIGHT LOCKOUT
   ============================================================== */

const IST_OFFSET_MS = 330 * 60 * 1000; // +5:30 in ms

/**
 * Return current date string in IST, formatted as YYYY-MM-DD.
 */
function getISTDateString() {
  const istDate = new Date(Date.now() + IST_OFFSET_MS);
  return istDate.toISOString().slice(0, 10);
}

/* ==============================================================
   3a. PERSISTENT PLAYER STATISTICS
   ============================================================== */

const STARDLE_STATS_KEY = 'stardle:stats:v1';

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn(`[Stardle] Could not read ${key}:`, e);
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`[Stardle] Could not save ${key}:`, e);
    return false;
  }
}

function createDefaultStats() {
  return {
    version: 1,
    gamesPlayed: 0,
    gamesWon: 0,
    currentStreak: 0,
    maxStreak: 0,
    guessDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    lastPlayedPuzzle: null,
    lastWonPuzzle: null,
    lastResult: null,
  };
}

let statsSession = createDefaultStats();

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeStats(value) {
  const defaults = createDefaultStats();
  if (!value || typeof value !== 'object') return defaults;

  const distribution = value.guessDistribution && typeof value.guessDistribution === 'object'
    ? value.guessDistribution
    : {};
  const lastResult = value.lastResult && typeof value.lastResult === 'object'
    && typeof value.lastResult.puzzle === 'string'
    && typeof value.lastResult.won === 'boolean'
    && Number.isInteger(value.lastResult.guesses)
    && value.lastResult.guesses >= 1
    && value.lastResult.guesses <= 6
    ? { ...value.lastResult }
    : null;

  const gamesPlayed = nonNegativeInteger(value.gamesPlayed);

  return {
    version: 1,
    gamesPlayed,
    gamesWon: Math.min(nonNegativeInteger(value.gamesWon), gamesPlayed),
    currentStreak: nonNegativeInteger(value.currentStreak),
    maxStreak: nonNegativeInteger(value.maxStreak),
    guessDistribution: {
      1: nonNegativeInteger(distribution[1]),
      2: nonNegativeInteger(distribution[2]),
      3: nonNegativeInteger(distribution[3]),
      4: nonNegativeInteger(distribution[4]),
      5: nonNegativeInteger(distribution[5]),
      6: nonNegativeInteger(distribution[6]),
    },
    lastPlayedPuzzle: typeof value.lastPlayedPuzzle === 'string' ? value.lastPlayedPuzzle : null,
    lastWonPuzzle: typeof value.lastWonPuzzle === 'string' ? value.lastWonPuzzle : null,
    lastResult,
  };
}

function loadStats() {
  try {
    const stored = safeStorageGet(STARDLE_STATS_KEY);
    statsSession = normalizeStats(stored ? JSON.parse(stored) : statsSession);
  } catch (e) {
    console.warn('[Stardle] Could not load saved statistics:', e);
  }
  return statsSession;
}

function saveStats(stats) {
  statsSession = normalizeStats(stats);
  try {
    safeStorageSet(STARDLE_STATS_KEY, JSON.stringify(statsSession));
  } catch (e) {
    console.warn('[Stardle] Could not save statistics:', e);
  }
  return statsSession;
}

function isPreviousPuzzle(previousPuzzle, currentPuzzle) {
  if (typeof previousPuzzle !== 'string' || typeof currentPuzzle !== 'string') return false;
  const previous = Date.parse(`${previousPuzzle}T00:00:00Z`);
  const current = Date.parse(`${currentPuzzle}T00:00:00Z`);
  return Number.isFinite(previous) && Number.isFinite(current)
    && current - previous === 24 * 60 * 60 * 1000;
}

function getDisplayStats(stats, today = getISTDateString()) {
  const displayStats = normalizeStats(stats);
  if (displayStats.lastWonPuzzle !== today && !isPreviousPuzzle(displayStats.lastWonPuzzle, today)) {
    displayStats.currentStreak = 0;
  }
  return displayStats;
}

function recordGameResult({ won, guesses }) {
  const puzzle = getISTDateString();
  const stats = loadStats();
  if (stats.lastPlayedPuzzle === puzzle) return renderStats(stats);

  stats.gamesPlayed += 1;
  if (won) {
    stats.gamesWon += 1;
    stats.guessDistribution[guesses] += 1;
    stats.currentStreak = isPreviousPuzzle(stats.lastWonPuzzle, puzzle)
      ? stats.currentStreak + 1
      : 1;
    stats.maxStreak = Math.max(stats.maxStreak, stats.currentStreak);
    stats.lastWonPuzzle = puzzle;
  } else {
    stats.currentStreak = 0;
  }

  stats.lastPlayedPuzzle = puzzle;
  stats.lastResult = { puzzle, won, guesses };
  saveStats(stats);
  return renderStats(stats);
}

function renderStats(savedStats = loadStats()) {
  const stats = getDisplayStats(savedStats);
  const winPercent = stats.gamesPlayed
    ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100)
    : 0;

  const values = {
    gamesPlayed: stats.gamesPlayed,
    winPercent,
    currentStreak: stats.currentStreak,
    maxStreak: stats.maxStreak,
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  });

  const noHistory = document.querySelector('no-history');
  const graph = document.querySelector('graph');
  const heading = document.querySelector('stats h3');
  const maxCount = Math.max(...Object.values(stats.guessDistribution), 0);
  const hasWins = stats.gamesWon > 0;

  if (noHistory) noHistory.style.display = hasWins ? 'none' : 'flex';
  if (graph) graph.style.display = hasWins ? 'grid' : 'none';
  if (heading) heading.style.display = hasWins ? 'block' : 'none';

  if (hasWins) {
    for (let guess = 1; guess <= 6; guess++) {
      const bar = document.getElementById(`bar-${guess}`);
      if (!bar) continue;
      const count = stats.guessDistribution[guess];
      const container = bar.closest('bar-container');
      const barText = bar.querySelector('bar-text');
      const isLatestWin = stats.lastResult?.won && stats.lastResult.guesses === guess;
      bar.style.width = `${Math.max(8, Math.round((count / maxCount) * 100))}%`;
      bar.style.height = '28px';
      if (barText) barText.textContent = String(count);
      container?.classList.toggle('latest-win', isLatestWin);
    }
  }
  return stats;
}

window.loadStardleStats = loadStats;
window.renderStardleStats = renderStats;
window.recordStardleGameResult = recordGameResult;

/**
 * Return ms remaining until the next 12:00 AM (midnight) IST.
 */
function getMsUntilNextISTMidnight() {
  const now = Date.now();
  const nowIST = new Date(now + IST_OFFSET_MS);

  // Next midnight UTC in the offset timeframe represents next midnight IST
  const nextIST = new Date(nowIST);
  nextIST.setUTCHours(24, 0, 0, 0);

  return Math.max(0, nextIST.getTime() - nowIST.getTime());
}

function formatCountdown(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].join(':');
}

function startMidnightCountdown() {
  function tick() {
    const el = document.getElementById('countdown-timer');
    if (el) {
      const ms = getMsUntilNextISTMidnight();
      el.textContent = formatCountdown(ms);
      if (ms <= 1000) {
        // Next midnight IST arrived! Clear state cleanly and reload for the new day
        try {
          const saved = JSON.parse(localStorage.getItem('gameState') || '{}');
          const cleanState = {
            ...(typeof defaultGameState !== 'undefined' ? defaultGameState : {}),
            ...(typeof defaultUserState !== 'undefined' ? defaultUserState : {}),
            stats: saved?.stats || {},
            winHistory: saved?.winHistory || [null, null, null, null, null, null],
            gameHistory: saved?.gameHistory || [],
            date: 'CLEARED_MIDNIGHT',
          };
          localStorage.setItem('gameState', JSON.stringify(cleanState));
          localStorage.setItem('stardleLastDate', 'CLEARED_MIDNIGHT');
        } catch(e) {
          console.warn('[Stardle] Could not reset state at midnight:', e);
        }
        setTimeout(() => location.reload(), 1500);
      }
    }
  }
  tick();
  setInterval(tick, 1000);
}

function getStreamingUrl(url, fallbackQuery, platform) {
  if (url && typeof url === 'string' && url !== '#' && url !== 'true' && url.startsWith('http')) {
    return url;
  }
  if (fallbackQuery) {
    if (platform === 'spotify') return `https://open.spotify.com/search/${fallbackQuery}`;
    if (platform === 'apple')   return `https://music.apple.com/us/search?term=${fallbackQuery}`;
    if (platform === 'youtube') return `https://music.youtube.com/search?q=${fallbackQuery}`;
  }
  return '#';
}

/* Update hint panel with today's song info */
function updateHintPanel(hint) {
  if (!hint) hint = window.stardlePuzzleInfo?.hint || window.stardleSolution || State?.solution || State?.hint;
  if (!hint) return;

  const songNameEl  = document.getElementById('hint-song-name');
  const artistEl    = document.getElementById('hint-song-artist');
  const spotifyEl   = document.getElementById('hint-spotify');
  const appleEl     = document.getElementById('hint-apple');
  const youtubeEl   = document.getElementById('hint-youtube');

  const song   = hint.song   || '—';
  const artist = hint.artist || '—';
  const query  = song !== '—' ? encodeURIComponent(`${song} ${artist}`) : '';

  if (songNameEl) songNameEl.textContent = song;
  if (artistEl)   artistEl.textContent   = artist;

  if (spotifyEl) spotifyEl.href = getStreamingUrl(hint.spotify, query, 'spotify');
  if (appleEl)   appleEl.href   = getStreamingUrl(hint.apple, query, 'apple');
  if (youtubeEl) youtubeEl.href = getStreamingUrl(hint.youtube, query, 'youtube');
}


/* ==============================================================
   4. HINT PANEL TOGGLE
   ============================================================== */

let hintPanelOpen = false;

function toggleHintPanel(forceState) {
  const panel = document.getElementById('hint-panel');
  if (!panel) return;

  // If hint wasn't loaded yet, try loading puzzle info immediately
  if (!window.stardlePuzzleInfo?.hint && typeof loadStardlePuzzle === 'function') {
    loadStardlePuzzle().then(() => updateHintPanel());
  } else {
    updateHintPanel();
  }

  if (typeof forceState === 'boolean') {
    hintPanelOpen = forceState;
  } else {
    hintPanelOpen = !hintPanelOpen;
  }
  panel.classList.toggle('open', hintPanelOpen);
  panel.setAttribute('aria-hidden', String(!hintPanelOpen));
}

// Close hint panel when clicking outside, BUT do not close when typing on virtual keyboard!
document.addEventListener('click', function(e) {
  if (!hintPanelOpen) return;
  const wrapper = document.getElementById('hint-btn-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    // If the click was on the keyboard, keep the hint panel open for the player
    const isKeyboard = e.target.closest('keyboard-row') || e.target.closest('#keyboard');
    if (!isKeyboard) {
      toggleHintPanel(false);
    }
  }
});


/* ==============================================================
   4b. MOBILE DROPDOWN MENU
   ============================================================== */

let mobileMenuOpen = false;

function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  const btn = document.getElementById('mobile-dropdown-btn') || document.getElementById('hamburger-btn');
  if (!menu || !btn) return;

  mobileMenuOpen = !mobileMenuOpen;
  menu.classList.toggle('open', mobileMenuOpen);
  menu.setAttribute('aria-hidden', String(!mobileMenuOpen));
  btn.setAttribute('aria-expanded', String(mobileMenuOpen));
}

function closeMobileMenu() {
  if (!mobileMenuOpen) return;
  const menu = document.getElementById('mobile-menu');
  const btn = document.getElementById('mobile-dropdown-btn') || document.getElementById('hamburger-btn');
  mobileMenuOpen = false;
  if (menu) {
    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
  }
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
  }
}

// Close mobile menu when clicking outside
document.addEventListener('click', function(e) {
  if (!mobileMenuOpen) return;
  const btn = document.getElementById('mobile-dropdown-btn') || document.getElementById('hamburger-btn');
  const menu = document.getElementById('mobile-menu');
  if (btn && menu && !btn.contains(e.target) && !menu.contains(e.target)) {
    closeMobileMenu();
  }
});

// Close mobile menu on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && mobileMenuOpen) {
    closeMobileMenu();
    const btn = document.getElementById('mobile-dropdown-btn') || document.getElementById('hamburger-btn');
    if (btn) btn.focus();
  }
});


/* ==============================================================
   5. WORD POPUP — post-game reveal
   ============================================================== */

function showWordPopup() {
  // Ensure the game has been completed before revealing the word (won or all rows checked)
  if (!(State?.won || (State?.checked && State.checked[5] === true))) {
    if (typeof showToast === 'function') {
      showToast('Finish the game first!', 2, null, null, 'z-index:4');
    }
    return;
  }

  const sol = window.stardleSolution || State?.solution || State?.gameHistory?.at(-1)?.solution;
  const hint = window.stardlePuzzleInfo?.hint || State?.hint;
  const word = sol?.word || State?.wordle || '';

  // Word title
  const titleEl = document.getElementById('popup-word-title');
  if (titleEl) titleEl.textContent = word.toUpperCase();

  // Astrophysics explanation (loaded securely from server)
  const expEl = document.getElementById('popup-explanation');
  if (expEl) expEl.textContent = sol?.explanation || `"${word.toUpperCase()}" is a term from astrophysics. Check the article below for a detailed explanation.`;

  // Article link
  const articleLink = document.getElementById('popup-article-link');
  if (articleLink) {
    if (sol?.articleUrl && sol.articleUrl !== '#') {
      articleLink.href = sol.articleUrl;
      articleLink.style.display = 'inline-flex';
    } else {
      articleLink.style.display = 'none';
    }
  }

  // Song Clue details inside the modal
  const song = sol?.song || hint?.song || '—';
  const artist = sol?.artist || hint?.artist || '—';
  const query = song !== '—' ? encodeURIComponent(`${song} ${artist}`) : '';
  const songTitleEl = document.getElementById('popup-song-title');
  if (songTitleEl) {
    songTitleEl.textContent = `${song} by ${artist}`;
  }
  const popSpotify = document.getElementById('popup-spotify');
  const popApple = document.getElementById('popup-apple');
  const popYoutube = document.getElementById('popup-youtube');

  const rawSpotify = (sol?.spotify && sol.spotify !== '#') ? sol.spotify : hint?.spotify;
  const rawApple   = (sol?.apple && sol.apple !== '#')     ? sol.apple   : hint?.apple;
  const rawYoutube = (sol?.youtube && sol.youtube !== '#') ? sol.youtube : hint?.youtube;

  if (popSpotify) popSpotify.href = getStreamingUrl(rawSpotify, query, 'spotify');
  if (popApple)   popApple.href   = getStreamingUrl(rawApple, query, 'apple');
  if (popYoutube) popYoutube.href = getStreamingUrl(rawYoutube, query, 'youtube');

  if (hint) updateHintPanel(hint);

  // Prevent double modal clash: if stats-container is open, hide it
  const statsContainer = document.getElementById('stats-container');
  if (statsContainer && statsContainer.getAttribute('aria-hidden') === 'false') {
    statsContainer.style.display = 'none';
    statsContainer.setAttribute('aria-hidden', 'true');
  }

  const overlay = document.getElementById('word-popup-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
  }

  // Trigger pop animation
  const popup = document.getElementById('word-popup');
  if (popup) {
    popup.style.animation = 'none';
    popup.offsetHeight; // reflow
    popup.style.animation = '';
  }
}
function closeWordPopup() {
  const overlay = document.getElementById('word-popup-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
  }
  const h1 = document.querySelector('h1');
  const game = document.getElementById('game');
  if (h1) h1.classList.remove('blur');
  if (game) {
    game.classList.remove('blur');
    game.setAttribute('aria-hidden', 'false');
  }
}

function openStatsFromPopup() {
  closeWordPopup();
  if (typeof showStatsModal === 'function') {
    showStatsModal();
  }
}

// Close popup when clicking overlay backdrop
document.getElementById('word-popup-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeWordPopup();
});

// Intercept clicks on music links if they are placeholder '#' so browser doesn't append /# to address bar
document.addEventListener('click', function(e) {
  const link = e.target.closest('a.hint-link, a.popup-music-link');
  if (link) {
    const href = link.getAttribute('href');
    if (!href || href === '#' || href === 'javascript:void(0)' || href === 'true' || href.endsWith('/true')) {
      e.preventDefault();
      if (typeof showToast === 'function') {
        showToast('Hint link loading...', 1.5);
      }
    }
  }
});


/* ==============================================================
   6. DETECT GAME END — hook into script.js without touching it
   ============================================================== */

/**
 * We watch the toast-container for messages. When the game ends
 * (won or lost), script.js calls showToast() which appends a <toast>.
 * We also watch State.won and State.checked to detect the game-over.
 */

let gameEndHandled = false;

function checkGameEnd() {
  if (gameEndHandled) return;
  if (typeof State === 'undefined') return;

  const isWon  = State.won === true;
  const isLost = !State.won && State.checked && State.checked[5] === true;

  if (isWon || isLost) {
    gameEndHandled = true;
    // Show discovery modal shortly after toast finishes
    setTimeout(showWordPopup, 2700);
  }
}

// Disable newGame — Stardle is strictly one puzzle per day according to IST
function disableNewGame() {
  window.newGame = function() {
    if (typeof showToast === 'function') {
      showToast('Next Stardle unlocks at midnight IST!', 2.5);
    }
  };
}

// Guard keyboard when user has completed today's game
function setupDailyLockoutGuards() {
  function warnIfDone() {
    if (typeof State !== 'undefined' && (State.won || (State.checked && State.checked[5] === true))) {
      if (typeof showToast === 'function' && !document.querySelector('toast-container toast')) {
        showToast('Next Stardle unlocks at midnight IST!', 2);
      }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Backspace' || (e.key && e.key.match(/^[a-zA-Z]$/))) {
      warnIfDone();
    }
  });

  document.querySelectorAll('keyboard-row button').forEach(btn => {
    btn.addEventListener('click', warnIfDone);
  });
}

// MutationObserver watching toast container
const toastObserver = new MutationObserver(() => {
  // Give script.js time to update State
  setTimeout(checkGameEnd, 300);
});

function startObserving() {
  const tc = document.querySelector('toast-container');
  if (tc) {
    toastObserver.observe(tc, { childList: true });
  }
}

// Also watch State directly with a debounced interval after any keydown
let gameCheckInterval = null;
document.addEventListener('keydown', () => {
  if (gameEndHandled) return;
  clearTimeout(gameCheckInterval);
  gameCheckInterval = setTimeout(checkGameEnd, 400);
});


/* ==============================================================
   7. BRIGHT TILES ENFORCEMENT — Guarantee maximum brightness & white text
   ============================================================== */
function enforceBrightTiles() {
  document.querySelectorAll('box').forEach(tile => {
    tile.style.color = '#ffffff';
    tile.style.fontWeight = '800';
    if (tile.classList.contains('rightSpot')) {
      tile.style.backgroundColor = '#22c55e';
      tile.style.borderColor = '#22c55e';
    } else if (tile.classList.contains('wrongSpot')) {
      tile.style.backgroundColor = '#eab308';
      tile.style.borderColor = '#eab308';
    } else if (tile.classList.contains('wrongLetter')) {
      tile.style.backgroundColor = '#334155';
      tile.style.borderColor = '#334155';
    }
  });

  const game = document.getElementById('game');
  if (game && game.classList.contains('blur')) {
    game.classList.remove('blur');
  }
}

// Watch board mutations to instantly enforce bright colors when rows flip
const boardObserver = new MutationObserver(enforceBrightTiles);
function startBoardObserver() {
  const gb = document.getElementById('game-board');
  if (gb) {
    boardObserver.observe(gb, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
  }
}

/* ==============================================================
   8. INIT — run everything
   ============================================================== */

(function stardleInit() {
  // Wait for DOM + script.js to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    loadStardlePuzzle();
    startObserving();
    startBoardObserver();
    disableNewGame();
    setupDailyLockoutGuards();
    startMidnightCountdown();
    enforceBrightTiles();
    setInterval(enforceBrightTiles, 500);

    // If game was already over on page load (persisted state), show popup after a delay
    setTimeout(() => {
      enforceBrightTiles();
      if (typeof State !== 'undefined') {
        if (State.won || (State.checked && State.checked[5] === true)) {
          gameEndHandled = true;
          showWordPopup();
        }
      }
    }, 1000);
  }
})();

/* ==============================================================
   HOW TO PLAY MODAL
   ============================================================== */
function showHowToPlay() {
  const overlay = document.getElementById('how-to-play-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.classList.add('open');
  }
}

function closeHowToPlay(e) {
  // Close only if clicking the overlay backdrop or the close button
  if (e && e.target !== document.getElementById('how-to-play-overlay') && e.target.id !== 'htp-close') return;
  const overlay = document.getElementById('how-to-play-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('open');
  }
}

// Show on first ever visit
(function() {
  if (!safeStorageGet('stardle_htp_seen')) {
    setTimeout(showHowToPlay, 600);
    safeStorageSet('stardle_htp_seen', '1');
  }
})();
