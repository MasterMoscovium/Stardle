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

function getDaysSinceEpoch() {
  const epoch = new Date('2024-01-01T00:00:00Z').getTime();
  const nowIST = Date.now() + IST_OFFSET_MS;
  return Math.floor((nowIST - epoch) / (24 * 60 * 60 * 1000));
}

// Fixed sequential daily word progression:
// Words in words.json are ordered with the 11 already-played words first:
//   0: apsis, 1: epoch, 2: comet, 3: lunar, 4: helio, 5: orbit, 6: solar,
//   7: night, 8: atoms, 9: laser, 10: quark
// followed by the remaining 27 unplayed words (11: muons, 12: gamma, ...).
// Offset 1 aligns Day 1036 (Nov 2, 2026 IST) to index 11 (muons).
function getISTDayIndex(length = curatedWords.length) {
  if (!length) return 0;
  const days = getDaysSinceEpoch();
  return ((days + 1) % length + length) % length;
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

