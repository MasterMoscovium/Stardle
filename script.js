const possibleWordsWorker = setup();

// --------------------------------------------------------
// GAME STATE:
// --------------------------------------------------------

const getTodayISTString = () => {
  const istDate = new Date(Date.now() + 330 * 60 * 1000);
  return istDate.toISOString().slice(0, 10);
};

const defaultGameState = {
  date: getTodayISTString(),
  wordle: '',
  token: null,
  //state can be one of: rightSpot, wrongSpot, wrongLetter, gusssed, or null
  gameBoard: Array.from({ length: 30 }, _ => ({ letter: null, state: null })),
  pointer: 0,
  checked: [null, null, null, null, null, null],
  won: false,
};

const defaultUserState = {
  colorScheme: null,
  winHistory: [null, null, null, null, null, null],
  persist: true,
  gameHistory: [],
  stats: {
    gamesPlayed: 0,
    winPercent: 0,
    currentStreak: 0,
    maxStreak: 0,
  },
};

const localStorageGameState = () => {
  try {
    const savedState = localStorage.getItem('gameState');
    if (!savedState) return null;
    const parsed = JSON.parse(savedState);
    const todayIST = getTodayISTString();
    const lastPlayedDate = localStorage.getItem('stardleLastDate');

    // If the saved state is from a previous day (or midnight passed), reset to a clean board!
    const recordedDate = parsed.date || lastPlayedDate;
    const isStaleWord = parsed.wordle && parsed.wordle.toLowerCase() !== 'muons';
    if ((recordedDate && recordedDate !== todayIST) || isStaleWord) {
      console.log('[Stardle] Clean board reset triggered (' + (recordedDate || 'today') + ' -> ' + todayIST + ').');
      const freshState = {
        ...defaultGameState,
        ...defaultUserState,
        stats: parsed.stats || defaultUserState.stats,
        winHistory: parsed.winHistory || defaultUserState.winHistory,
        gameHistory: parsed.gameHistory || defaultUserState.gameHistory,
        date: todayIST,
      };
      try {
        localStorage.setItem('gameState', JSON.stringify(freshState));
        localStorage.setItem('stardleLastDate', todayIST);
      } catch (_) {}
      return freshState;
    }
    return parsed;
  } catch (e) {
    console.warn('Could not load the saved game state:', e);
    return null;
  }
};

var State = { ...defaultGameState, ...defaultUserState };

localStorageGameState()?.persist && update(localStorageGameState())

let possibleWords;


// --------------------------------------------------------
// RUNTIME:
// --------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (
    State.won ||
    activeRow() == 6 ||
    $('stats-container').getAttribute('aria-hidden') == 'false'
  )
    return;
  if (e.key == 'Backspace') backspace();
  if (e.key == 'Enter' && isRowDone()) return enter();
  if (e.key.match(/^[a-z]|[A-Z]$/)) add(e.key.toLowerCase());
});

// Foward clicks of the "keyboard" to the above handler
$$('keyboard-row button').forEach((button) => {
  button.addEventListener('click', (e) => {
    let key;
    key = e.currentTarget?.innerText?.toLowerCase() ?? '';
    if (e.currentTarget.id == 'backspace') key = 'Backspace';
    if (e.currentTarget.id == 'enter') key = 'Enter';

    document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    e.currentTarget.blur();
  });
});

function render(actions, effects = []) {
  // Ensure actions and effects are arrays
  actions = [actions].flat();
  effects = [effects].flat();

  const oldGameState = clone(State);
  const newGameState =
    actions.length &&
    actions.reduce((acc, cur) => {
      return Object.assign(clone(oldGameState), cur(clone(acc)));
    }, clone(State));
  State = newGameState;

  const effectsToRun = [...effects, paint, persist];
  (async () => {
    try {
      for (let effect of effectsToRun) {
        await effect(oldGameState, newGameState);
      }
    } catch (e) {
      console.error(e)
    }
  })();

  return newGameState;
}

// --------------------------------------------------------
// ACTIONS:
// --------------------------------------------------------

function add(val) {
  return render(({ checked, gameBoard, pointer }) => {
    if (!checked[rowNum() - 1] && isRowDone()) return;
    gameBoard.length = 30;
    gameBoard[pointer] = { letter: val, state: 'guessedLetter' };
    if (pointer < 30) pointer++;
    return { gameBoard, pointer };
  });
}

function backspace() {
  return render(({ pointer, gameBoard, checked }) => {
    if (pointer == 0) return;
    if (checked[rowNum(pointer - 1)]) return;
    pointer--;
    gameBoard[pointer] = { letter: null, state: null };
    return { pointer, gameBoard };
  });
}

let isCheckingGuess = false;

async function enter() {
  if (isCheckingGuess) return;
  const { checked, gameBoard } = State;
  const currentRow = activeRow({ checked });
  if (currentRow > 5) return;

  const guess = guesses(gameBoard)[currentRow];
  if (!guess || guess.length !== 5) return;
  if (possibleWords && !possibleWords.has(guess)) return badWord();
  if (guesses(gameBoard).filter((g) => g == guess).length > 1) return badWord('Already guessed');

  isCheckingGuess = true;
  try {
    const token = State.token || window.stardleToken || null;
    const res = await fetch('/api/check-guess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guess, token }),
    });

    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }

    const data = await res.json();
    if (!data.valid) {
      isCheckingGuess = false;
      return badWord(data.message || 'Not in word list');
    }

    if (data.token) {
      window.stardleToken = data.token;
      State.token = data.token;
    }

    const validityMask = data.eval;

    if (data.won) {
      if (data.solution) {
        window.stardleSolution = data.solution;
        State.wordle = data.solution.word;
        State.solution = data.solution;
      }
      return wonWithMask(validityMask);
    } else if (currentRow >= 5) {
      if (data.solution) {
        window.stardleSolution = data.solution;
        State.wordle = data.solution.word;
        State.solution = data.solution;
      }
      return lostWithMask(validityMask);
    } else {
      return checkWithMask(validityMask);
    }
  } catch (err) {
    console.error('[Stardle] Failed to validate guess:', err);
    showToast('Network error, please try again', 2);
  } finally {
    isCheckingGuess = false;
  }
}

function applyMaskToBoard(gameState, validityMask) {
  const row = Math.min(activeRow(gameState), 5);
  validityMask.forEach((state, idx) => {
    let tileIdx = idx + row * 5;
    gameState.gameBoard[tileIdx].state = state;
  });
  return gameState.gameBoard;
}

function checkWithMask(validityMask) {
  return render((gameState) => {
    gameState.gameBoard = applyMaskToBoard(gameState, validityMask);
    gameState.checked[activeRow(gameState)] = true;
    return gameState;
  }, animateSumbittedRow);
}

function getCheckedGameboard(gameState) {
  const row = Math.min(activeRow(gameState), 5);
  const validityMask = getRowValidityMask(row, gameState);
  validityMask.forEach((state, idx) => {
    let tileIdx = idx + row * 5;
    gameState.gameBoard[tileIdx].state = state;
  });
  return gameState.gameBoard;
}

function check() {
  return render((gameState) => {
    gameState.gameBoard = getCheckedGameboard(gameState);
    gameState.checked[activeRow()] = true;
    return gameState;
  }, animateSumbittedRow);
}

function setStats() {
  if (typeof window.renderStardleStats === 'function') {
    window.renderStardleStats();
    return State;
  }

  return render(
    ({ stats, checked, winHistory, gameHistory }) => {
      stats.gamesPlayed = gameHistory.length;
      stats.winPercent =
        Math.round(
          (winHistory.reduce((acc, cur) => acc + cur, 0) / stats.gamesPlayed) * 100 || 0
        );

      let currentStreak = 0
      for (let game of [...gameHistory].reverse()) {
        if (!game.won) break
        currentStreak++
      }
      stats.currentStreak = currentStreak

      if (stats.currentStreak > stats.maxStreak)
        stats.maxStreak = stats.currentStreak;

      return { stats };
    },
    [paintStats, showGraph]
  );
}

function wonWithMask(validityMask) {
  var winningRow;
  return render(
    (gameState) => {
      let {
        checked,
        winHistory,
        gameHistory,
        won,
        wordle,
        gameBoard,
        pointer,
        solution,
      } = gameState;
      gameBoard = applyMaskToBoard(gameState, validityMask);
      checked[activeRow(gameState)] = true;
      winningRow = activeRow({ checked }) - 1;
      won = true;
      winHistory[winningRow]++;
      pointer++;
      const finalWord = wordle || window.stardleSolution?.word || '';
      const finalSolution = solution || window.stardleSolution || null;
      gameHistory.push({ wordle: finalWord, gameBoard, won, checked, solution: finalSolution });
      return { winHistory, won, gameHistory, pointer, gameBoard, wordle: finalWord, solution: finalSolution };
    },
    [
      animateSumbittedRow,
      (oldGameState, newGameState) => {
        window.recordStardleGameResult?.({ won: true, guesses: winningRow + 1 });
        const randomPraise = generateWinningMessage(winningRow);
        showToast(randomPraise, 2.5, () => showStatsModal(oldGameState, newGameState));
      },
    ]
  );
}

function won() {
  var winningRow;
  return render(
    (gameState) => {
      let {
        checked,
        winHistory,
        gameHistory,
        won,
        wordle,
        gameBoard,
        pointer,
      } = gameState;
      gameBoard = getCheckedGameboard(gameState);
      checked[activeRow()] = true;
      winningRow = activeRow({ checked }) - 1;
      won = true;
      winHistory[winningRow]++;
      pointer++;
      gameHistory.push({ wordle, gameBoard, won, checked });
      return { winHistory, won, gameHistory, pointer, gameBoard };
    },
    [
      animateSumbittedRow,
      (oldGameState, newGameState) => {
        window.recordStardleGameResult?.({ won: true, guesses: winningRow + 1 });
        const randomPraise = generateWinningMessage(winningRow);
        showToast(randomPraise, 2.5, () => showStatsModal(oldGameState, newGameState));
      },
    ]
  );
}

function lostWithMask(validityMask) {
  return render(
    (gameState) => {
      let { checked, wordle, gameHistory, gameBoard, won, pointer, solution } = gameState;
      checked[5] = true;
      gameBoard = applyMaskToBoard(gameState, validityMask);
      const finalWord = wordle || window.stardleSolution?.word || '';
      const finalSolution = solution || window.stardleSolution || null;
      gameHistory.push({ wordle: finalWord, gameBoard, won, checked, pointer, solution: finalSolution });
      return { checked, gameHistory, gameBoard, wordle: finalWord, solution: finalSolution };
    },
    [
      animateSumbittedRow,
      ({ wordle }) => {
        const finalWord = wordle || window.stardleSolution?.word || '';
        window.recordStardleGameResult?.({ won: false, guesses: 6 });
        showToast(finalWord, 2.5, showStatsModal, true);
      },
    ]
  );
}

function lost() {
  return render(
    (gameState) => {
      let { checked, wordle, gameHistory, gameBoard, won, pointer } = gameState;
      checked[5] = true;
      gameBoard = getCheckedGameboard(gameState);
      gameHistory.push({ wordle, gameBoard, won, checked, pointer });
      return { checked, gameHistory, gameBoard };
    },
    [
      animateSumbittedRow,
      ({ wordle }) => {
        window.recordStardleGameResult?.({ won: false, guesses: 6 });
        showToast(wordle, 2.5, showStatsModal, true);
      },
    ]
  );
}

function newGame() {
  return render(
    ({ wordle }) => {
      wordle = possibleWordsWorker.postMessage('newWordle');
      return {
        ...defaultGameState,
        wordle: wordle,
      };
    },
    [
      () => {
        closeStatsModal();
        [...$$('keyboard-row button')].forEach((key) => {
          key.setAttribute('style', '');
          key.classList.remove('wrongLetter', 'wrongSpot', 'rightSpot');
        });
        $('toast-container').replaceChildren()
      }
    ]
  );
}

function update(newState) {
  return render(
    () => newState
  )
}

function toggleColorScheme() {
  return render(({ colorScheme }) => {
    colorScheme = colorScheme == 'dark' ? 'light' : 'dark'
    return { colorScheme }
  })
}

// --------------------------------------------------------
// EFFECTFUL:
// --------------------------------------------------------

async function paint(oldGameState, newGameState) {
  if (newGameState.colorScheme) {
    if (newGameState.colorScheme == 'light') document.documentElement.classList.remove('dark')
    if (newGameState.colorScheme == 'dark') document.documentElement.classList.remove('light')
    document.documentElement.classList.add(newGameState.colorScheme)
    // $('html').classList.add('transistion')
  }

  newGameState.gameBoard.forEach(({ letter, state }, idx) => {
    // Dont bother repainting tiles
    const { letter: oldLetter, state: oldState } = oldGameState.gameBoard[idx];
    if (oldLetter == letter && state == oldState) return;

    const tiles = getTiles();
    tiles[idx].innerText = letter ?? '';
    tiles[idx].classList = '';
    tiles[idx].classList.add(state);
    if (state == 'rightSpot') {
      tiles[idx].style.backgroundColor = '#22c55e';
      tiles[idx].style.color = '#ffffff';
      tiles[idx].style.borderColor = '#22c55e';
    } else if (state == 'wrongSpot') {
      tiles[idx].style.backgroundColor = '#eab308';
      tiles[idx].style.color = '#ffffff';
      tiles[idx].style.borderColor = '#eab308';
    } else if (state == 'wrongLetter') {
      tiles[idx].style.backgroundColor = '#334155';
      tiles[idx].style.color = '#ffffff';
      tiles[idx].style.borderColor = '#334155';
    } else {
      tiles[idx].style.backgroundColor = '';
      tiles[idx].style.color = '';
      tiles[idx].style.borderColor = '';
    }
  });

  if (newGameState.pointer == 0) {
    $$('keyboard-row button').forEach((key) => {
      key.classList.remove('wrongLetter', 'wrongSpot', 'rightSpot');
    });
  }

  // Update keyboard key states based on highest priority (rightSpot > wrongSpot > wrongLetter)
  const keyStatePriority = {
    wrongLetter: 1,
    wrongSpot: 2,
    rightSpot: 3,
  };

  const keyStates = {};
  newGameState.gameBoard.forEach(({ letter, state }) => {
    if (letter && keyStatePriority[state]) {
      const currentPriority = keyStatePriority[keyStates[letter]] || 0;
      if (keyStatePriority[state] > currentPriority) {
        keyStates[letter] = state;
      }
    }
  });

  Object.entries(keyStates).forEach(([letter, state]) => {
    const letterEl = $('#' + letter);
    if (!letterEl) return;
    letterEl.classList.remove('wrongLetter', 'wrongSpot', 'rightSpot');
    letterEl.classList.add(state);
  });
}

async function paintStats(_, { stats, winHistory }) {
  Object.entries(stats).forEach(([stat, value]) => {
    $(`#${stat}`).innerText = value;
  });
  const mostCommonRow = winHistory.reduce(
    (acc, cur) => (cur > acc ? cur : acc),
    0
  );

  const rowHeights =
    winHistory.map((row) => {
      const res = Math.floor((+row / mostCommonRow) * 100);
      return res;
    }) || 0;

  const bars = [...$$('bar-text')];
  bars?.forEach((bar, idx) => {
    bar.innerText = winHistory[idx];
    (bar?.parentElement.animate(
      [
        { height: '0%' },
        {
          height: `${rowHeights?.[idx] ?? 0}%`,
          backgroundColor: `var(--barRank-${Math.round((rowHeights?.[idx] ?? 0) / 20)})`,
        },
      ],
      { duration: 350, easing: 'ease-in-out', delay: ((170 * idx) - idx * 50) + 250 }
    )).onfinish = () => {
      bar.parentElement.style.height = `${rowHeights?.[idx] ?? 0}%`;
      bar.parentElement.style.backgroundColor = `var(--barRank-${Math.round(
        (rowHeights?.[idx] ?? 0) / 20
      )})`;
    };
  });
}

async function animateSumbittedRow(oldState, newState) {
  if (activeRow(oldState) == activeRow(newState) && !newState.won) return;
  const sumbittedRow = getRowEls(activeRow(oldState));
  let done = await new Promise((resolve, reject) => {
    sumbittedRow.forEach((tile, idx) => {
      tile.classList.remove('guessedLetter');
      const styles = getValidityStyles(activeRow(oldState), idx, newState);
      tile.style.perspective = '500px';
      tile.style.transformStyle = 'preserve-3d';

      tile.animate(
        [
          { transform: 'rotate3d(50, 0, 0, -180deg)', ...styles },
          { transform: 'rotate3d(0,0,0, 180deg)', ...styles },
        ],
        {
          duration: 650,
          delay: (idx * 300) + 50,
          easing: 'ease-in-out',
        }
      ).onfinish = async (_) => {
        setStylesOnElement(styles, tile);
        if (idx == 4) resolve(true);
        if (!idx && newState.won) await animateWinningRow(null, State);
      };
    });
  });
}

async function animateWinningRow(_, { gameState }) {
  getRowEls(activeRow(gameState)).forEach((tile, idx) => {
    tile.animate(
      [
        { transform: 'translate(0,-10px)' },
        { transform: 'translate(0, -35px)' },
        { transform: 'translate(0, -25px)' },
        { transform: 'translate(0, 7px)' },
        { transform: 'translate(0,-8px)' },
        { transform: 'translate(0,0px)' },
      ],
      {
        duration: 450,
        delay: idx * 100 + 750,
        easing: 'ease-out',
      }
    );
  });
}

async function showGraph(_, { winHistory }) {
  const gamesWon = winHistory.reduce((acc, cur) => acc + cur, 0);
  if (gamesWon == 0) return;
  $('graph').style.display = 'flex';
  $('stats h3').style.display = 'block';
  $('no-history').style.display = 'none';
}

async function persist(_, newGameState) {
  if (!newGameState.persist) return;
  try {
    const stateToSave = {
      ...newGameState,
      date: newGameState.date || getTodayISTString()
    };
    localStorage.setItem('gameState', JSON.stringify(stateToSave));
  } catch (e) {
    console.warn('Could not save the game state:', e);
  }
}

function badWord(msg = 'Not In Word List') {
  showToast(msg);
  const row = getRowEls(activeRow(), false);
  row.animate(
    [
      { transform: 'translate(10px)' },
      { transform: 'translate(-10px)' },
      { transform: 'translate(5px)' },
      { transform: 'translate(-5px)' },
      { transform: 'translate(2px)' },
    ],
    {
      duration: 250,
      easing: 'ease-out',
    }
  );
}

function showToast(msg, time = 1, cb = () => { }, persist = false, style = '') {
  const toastContainer = $('toast-container');

  const toastTemplate = html(`<toast style=${style}>${msg.toUpperCase()}</toast>`);
  toastContainer.prepend(toastTemplate);
  const toast = toastContainer.firstChild;

  setTimeout(function () {
    if (!persist)
      toast.animate([{ opacity: '1' }, { opacity: '0' }], 400).onfinish = () => {
        toastContainer.removeChild(toast);
      };
    cb?.();
  }, time * 1000);
}

function getValidityStyles(rowNum = activeRow(), idx, gameState = State) {
  const tileIdx = rowNum * 5 + idx;
  const tile = gameState.gameBoard && gameState.gameBoard[tileIdx];
  const style = tile?.state || (gameState.wordle ? getRowValidityMask(rowNum, gameState)[idx] : 'wrongLetter');
  const styles = {
    borderColor: 'transparent',
    color: '#ffffff',
    backgroundColor: '#334155',
  };
  if (style == 'rightSpot') styles.backgroundColor = '#22c55e';
  if (style == 'wrongSpot') styles.backgroundColor = '#eab308';
  return styles;
}

function setStylesOnElement(styles, element) {
  Object.assign(element.style, styles);
}

function showStatsModal() {
  setStats();
  $('stats-container').style.display = 'flex';
  $('stats-container').setAttribute('aria-hidden', 'false');
  $('stats').classList = '';
  $('stats').classList.add('enter');
  $('h1').classList.add('blur');
  $('#game').classList.add('blur');
  $('#game').setAttribute('aria-hidden', 'true');
}

function closeStatsModal(e) {
  $('h1').classList.remove('blur');
  $('#game').classList.remove('blur');
  $('#game').setAttribute('aria-hidden', 'false');
  $$('[id^="bar"]').forEach((bar) => { bar.style.height = 0; bar.style.backgroundColor = 'var(--winHistoryBarColor)' });
  $('stats-container').setAttribute('aria-hidden', 'true');
  $('stats').classList = '';
  $('stats').animate(
    { transform: 'translate(0, -200px)', opacity: 0 },
    { duration: 200, easing: 'ease-in-out' }
  ).onfinish = () => {
    $('stats-container').style.display = 'none';
  };
}

function share() {
  if (!State.won && !State.checked[5]) {
    showToast('Finish the game first!', 2, null, null, 'z-index:4');
    return;
  }
  const share = getEmojiGameBoard();
  navigator.clipboard.writeText(share);
  showToast('Copied to Clipboard', 2, null, null, 'z-index:4');
}

function getRowValidityMask(rowNumber = activeRow(), { gameBoard, wordle }) {
  let guess = guesses(gameBoard);
  guess = guess[rowNumber];
  // The following logic is necessary because of how the OG wordle handles duplicate letters, see "Note on Rules" in readme
  let foil = wordle;
  return guess
    .split('')
    .map((letter, idx) => {
      if (wordle[idx] == letter) {
        foil = replaceAt(foil, idx);
        return 'rightSpot';
      }
      return letter;
    })
    .map((letter, idx) => {
      if (foil.match(guess[idx]) && letter.length == 1) {
        foil = replaceAt(foil, foil.indexOf(guess[idx]));
        return 'wrongSpot';
      }
      return letter;
    })
    .map((letter, idx, arr) => {
      if (!~foil.indexOf(guess[idx]) && letter.length == 1)
        return 'wrongLetter';
      return letter;
    });
}

// --------------------------------------------------------
// UTILITY FUNCTIONS:
// --------------------------------------------------------

function html(html) {
  var template = document.createElement('template');
  html = html.trim();
  template.innerHTML = html;
  return template.content.firstChild;
}

function $(selector) {
  return document.querySelector(selector);
}

function $$(selector) {
  return document.querySelectorAll(selector);
}

function replaceAt(str, idx) {
  return str.slice(0, idx) + '#' + str.slice(idx + 1);
}

function getTiles() {
  const tiles = [];
  for (let i = 0; i < 6; i++) {
    tiles.push(...($(`#row-${i}`)?.children || []));
  }
  return tiles;
}

function pointer({ gameBoard } = State) {
  return gameBoard.reduce((acc, cur, idx, arr) => {
    if ((!cur?.letter && !acc) || idx == arr.length - 1) return idx;
    return acc;
  }, 0);
}

function rowNum(point = State.pointer) {
  if (point < 0) point = 0;
  return Math.floor(point / 5);
}

function activeRow({ checked } = State) {
  return checked.filter((i) => i).length;
}

function isRowDone({ checked, pointer } = State) {
  return !checked[rowNum() - 1] && rowNum(pointer - 1) < rowNum();
}

function guesses(gameBoard) {
  return gameBoard.reduce((acc, cur, idx, arr) => {
    let groupNum = Math.floor(idx / 5);
    acc[groupNum] = (acc?.[groupNum] ?? '') + (cur.letter || '');
    return acc;
  }, []);
}

function getRowEls(rowNumber = activeRow(), kids = true) {
  rowNumber = rowNumber == 6 ? 5 : rowNumber;
  const row = $(`#row-${rowNumber}`);
  if (!kids) return row;
  return [...row?.children] ?? [];
}

function collect(arr) {
  return arr.reduce((acc, cur) => acc + cur.innerText.toLowerCase(), '');
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function randomIdx(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateWinningMessage(winningRow) {
  const generalPraises = [
    'You Won!',
    'Great Job!',
    'You Rock!',
    'Pure Genius!',
    'Wonderful',
    'Beautiful!',
    'Gold Star!',
    'Nice!',
    'Very Cool!',
    'You got it!',
    'Keep it up!',
    'wow!',
    'incredible!',
    'cheers!',
    'Magnificent!',
    'Impressive!',
    'Splendid!',
    'Way To Go!',
  ];
  const lastLinePraises = [
    'phew!',
    'close call!',
    'I was worried about you there!',
  ];
  const firstLinePraises = [
    'impossible!',
    "I can't believe it!",
    "How'd you know?!",
    'genius!',
    'Cheater!',
  ];

  return winningRow == 0
    ? randomIdx(firstLinePraises)
    : winningRow == 5
      ? randomIdx(lastLinePraises)
      : randomIdx(generalPraises);
}

function getEmojiGameBoard() {
  const submittedRows = State.won ? activeRow() : activeRow() + 1;
  const tilesToShow = Math.min((submittedRows + 1) * 5, 30);
  return State.gameBoard.slice(0, tilesToShow).reduce((acc, cur, idx) => {
    const newLine = (idx + 1) % 5 === 0 ? '\n' : '';
    const bgColor = cur?.state || 'wrongLetter';
    if (bgColor === 'rightSpot') return acc + '🟩' + newLine;
    if (bgColor === 'wrongSpot') return acc + '🟨' + newLine;
    return acc + '⬜' + newLine;
  }, '');
}

function setup() {
  // getColorScheme
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => {
      update({ ...State, colorScheme: (e.matches ? 'dark' : 'light') })
    });

  const possibleWordsWorker = new Worker('possibleWords.js');
  possibleWordsWorker.postMessage('');
  possibleWordsWorker.onmessage = function (e) {
    if (typeof e.data !== 'object') return;
    possibleWords = e.data.possibleWordsMap;
  };


  return possibleWordsWorker;
}

if (State?.pointer == 30 && !State?.won && State.checked.at(-1))
  showToast(State?.wordle, null, null, true)
