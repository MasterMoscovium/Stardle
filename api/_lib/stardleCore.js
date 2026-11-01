const fs = require('fs');
const path = require('path');
const vm = require('vm');

const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+5:30 in ms

// Load curated words list
const wordsPath = path.join(__dirname, '..', '_data', 'words.json');
let curatedWords = [];
try {
  curatedWords = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
} catch (e) {
  console.error('[Stardle Backend] Error reading words.json:', e);
}

// Load dictionary of valid 5-letter words from possibleWords.js
let dictionarySet = new Set();
try {
  const possibleWordsFilePath = path.join(__dirname, '..', '..', 'possibleWords.js');
  if (fs.existsSync(possibleWordsFilePath)) {
    try {
      // First attempt direct require (fastest)
      delete require.cache[require.resolve(possibleWordsFilePath)];
      const pwModule = require(possibleWordsFilePath);
      if (typeof pwModule.possibleWords === 'function') {
        pwModule.possibleWords().forEach(w => dictionarySet.add(w.toLowerCase().trim()));
      }
    } catch (_) {
      // Fallback via vm context
      const content = fs.readFileSync(possibleWordsFilePath, 'utf8');
      const ctx = {};
      vm.runInNewContext(content, ctx);
      if (typeof ctx.possibleWords === 'function') {
        ctx.possibleWords().forEach(w => dictionarySet.add(w.toLowerCase().trim()));
      }
    }
  }
} catch (e) {
  console.warn('[Stardle Backend] Error loading possibleWords.js dictionary:', e);
}

// Ensure all curated words are also recognized as valid words
curatedWords.forEach(item => {
  if (item.word) dictionarySet.add(item.word.toLowerCase().trim());
});

console.log(`[Stardle Backend] Loaded dictionary with ${dictionarySet.size} valid 5-letter words.`);

function getISTDate() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function getISTDateString() {
  const istDate = getISTDate();
  return istDate.toISOString().slice(0, 10);
}

// Seeded PRNG (Mulberry32) for deterministic, reproducible daily shuffling
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates shuffle with seeded PRNG (over a range 0..length-1)
function getShuffledIndices(length, seed) {
  const indices = Array.from({ length }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

// Fisher-Yates shuffle over an arbitrary array of values
function shuffleArray(arr, seed) {
  const a = [...arr];
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let cachedCycle = null;
let cachedPermutation = null;

function getCyclePermutation(cycle, length) {
  if (cachedCycle === cycle && cachedPermutation && cachedPermutation.length === length) {
    return cachedPermutation;
  }
  const cycleSeed = (cycle * 2654435761 + 1337) >>> 0;
  const perm = getShuffledIndices(length, cycleSeed);

  // Boundary check: ensure the first word of a new cycle is not identical to the last word of the previous cycle
  if (cycle > 0) {
    const prevCycleSeed = ((cycle - 1) * 2654435761 + 1337) >>> 0;
    const prevPerm = getShuffledIndices(length, prevCycleSeed);
    const lastWordIdx = prevPerm[length - 1];
    if (perm[0] === lastWordIdx && length > 1) {
      [perm[0], perm[1]] = [perm[1], perm[0]];
    }
  }

  cachedCycle = cycle;
  cachedPermutation = perm;
  return perm;
}

function getDaysSinceEpoch() {
  const epoch = new Date('2024-01-01T00:00:00Z').getTime();
  const nowIST = Date.now() + IST_OFFSET_MS;
  return Math.floor((nowIST - epoch) / (24 * 60 * 60 * 1000));
}

// --- Transition phase constants ---
// The 9 words played historically in order before the backend shuffle was introduced:
//   apsis, epoch, comet, lunar, helio, orbit, solar, night, atoms
// plus 'laser' which was served on day 1035 (Nov 1, 2026 IST).
//
// These 10 words MUST NOT appear again during the remainder of this 38-word window.
// Exactly 28 unplayed words remain in curatedWords.
// For days 1036 to 1063 (the remaining 28 days), we serve exclusively from the
// 28 unplayed word indices, shuffled deterministically.
// Normal full-cycle rotation (all 38 words) will resume cleanly on day 1064 (cycle 28).
const HISTORICALLY_PLAYED_WORDS = new Set([
  'apsis', 'epoch', 'comet', 'lunar', 'helio', 'orbit', 'solar', 'night', 'atoms',
  'laser'
]);

const TRANSITION_START_DAY = 1036; // Nov 2, 2026 IST (today)
const TRANSITION_END_DAY   = 1063; // Last day of this 38-word window (= 1036 + 27)
const TRANSITION_SEED      = 20261102;

// Lazily-computed, cached transition permutation over the 28 unplayed words
let _transitionPerm = null;
function getTransitionPermutation() {
  if (_transitionPerm) return _transitionPerm;
  const unplayedIndices = [];
  curatedWords.forEach((item, idx) => {
    if (item.word && !HISTORICALLY_PLAYED_WORDS.has(item.word.toLowerCase().trim())) {
      unplayedIndices.push(idx);
    }
  });
  _transitionPerm = shuffleArray(unplayedIndices, TRANSITION_SEED);
  return _transitionPerm;
}

function getISTDayIndex(length = curatedWords.length) {
  if (!length) return 0;
  const days = getDaysSinceEpoch();

  // Day 1035 was laser
  if (days === 1035) {
    const laserIdx = curatedWords.findIndex(w => w.word.toLowerCase() === 'laser');
    return laserIdx !== -1 ? laserIdx : 12;
  }

  // Transition phase: serve exclusively the 28 unplayed words for days 1036..1063
  if (days >= TRANSITION_START_DAY && days <= TRANSITION_END_DAY) {
    const transitionPerm = getTransitionPermutation();
    const offset = days - TRANSITION_START_DAY;
    if (offset >= 0 && offset < transitionPerm.length) {
      return transitionPerm[offset];
    }
  }

  // Normal cycle logic (day 1064+ starts cycle 28)
  const cycle = Math.floor(days / length);
  const dayInCycle = ((days % length) + length) % length;
  const permutation = getCyclePermutation(cycle, length);
  return permutation[dayInCycle];
}

function getTodayWordEntry() {
  if (!curatedWords.length) return null;
  const idx = getISTDayIndex(curatedWords.length);
  return curatedWords[idx];
}

function isValidWord(guess) {
  if (!guess || typeof guess !== 'string' || guess.length !== 5) return false;
  const normalized = guess.trim().toLowerCase();
  return dictionarySet.has(normalized);
}

function evaluateGuess(guess, targetWord) {
  const g = guess.toLowerCase().trim();
  const t = targetWord.toLowerCase().trim();
  let foil = t;
  const result = new Array(5);

  // Pass 1: exact matches (greens)
  for (let i = 0; i < 5; i++) {
    if (g[i] === t[i]) {
      result[i] = 'rightSpot';
      foil = foil.slice(0, i) + '#' + foil.slice(i + 1);
    }
  }

  // Pass 2: wrong spot (yellows) vs wrong letter (grays)
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'rightSpot') continue;
    const char = g[i];
    const foundIdx = foil.indexOf(char);
    if (foundIdx !== -1) {
      result[i] = 'wrongSpot';
      foil = foil.slice(0, foundIdx) + '#' + foil.slice(foundIdx + 1);
    } else {
      result[i] = 'wrongLetter';
    }
  }

  return result;
}

function getPuzzleInfo() {
  const entry = getTodayWordEntry();
  if (!entry) {
    return {
      error: 'No puzzle available'
    };
  }

  return {
    puzzleNumber: getDaysSinceEpoch(),
    date: getISTDateString(),
    hint: {
      song: entry.song,
      artist: entry.artist,
      spotify: entry.spotify,
      apple: entry.apple,
      youtube: entry.youtube
    }
  };
}

module.exports = {
  getISTDateString,
  getTodayWordEntry,
  isValidWord,
  evaluateGuess,
  getPuzzleInfo
};

