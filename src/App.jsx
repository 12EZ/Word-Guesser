import { useEffect, useMemo, useRef, useState } from 'react';
import { REAL_WORDS } from './data/realWords';
import { FAKE_WORDS } from './data/fakeWords';
import { fetchDefinition } from './api';
import './App.css';

// 8 distinct levels, each with its own shape:
//   shape: 'mixed'  → regular rounds, last one is a bonus round
//          'speed'  → all regular rounds, no bonus (pure quick-draw)
//          'bonus'  → every round is a bonus round (pure deduction)
const LEVELS = [
  {
    name: 'Spark',         tag: 'Easy does it',          color: '#22e6a0',
    rounds: 4, shape: 'mixed',
    seconds: 38, bonusOptions: 3, bonusPoints: 3, requiredCorrect: 3,
  },
  {
    name: 'Tempo',         tag: 'Pure speed run',        color: '#7ec5ff',
    rounds: 6, shape: 'speed',
    seconds: 18, bonusOptions: 3, bonusPoints: 3, requiredCorrect: 4,
  },
  {
    name: 'Mirage',        tag: 'Trust your gut',        color: '#5eead4',
    rounds: 5, shape: 'mixed',
    seconds: 24, bonusOptions: 3, bonusPoints: 4, requiredCorrect: 3,
  },
  {
    name: 'Bonus Blitz',   tag: 'All bonus, all reward', color: '#a78bfa',
    rounds: 4, shape: 'bonus',
    seconds: 30, bonusOptions: 4, bonusPoints: 4, requiredCorrect: 3,
  },
  {
    name: 'Curiouser',     tag: 'It only gets weirder',  color: '#f472b6',
    rounds: 5, shape: 'mixed',
    seconds: 22, bonusOptions: 4, bonusPoints: 5, requiredCorrect: 3,
  },
  {
    name: 'Labyrinth',     tag: 'More options, less time', color: '#c084fc',
    rounds: 5, shape: 'mixed',
    seconds: 18, bonusOptions: 4, bonusPoints: 5, requiredCorrect: 3,
  },
  {
    name: 'Gauntlet',      tag: 'Sprint to the end',     color: '#ff8a5b',
    rounds: 6, shape: 'speed',
    seconds: 12, bonusOptions: 3, bonusPoints: 3, requiredCorrect: 4,
  },
  {
    name: 'Reckoning',     tag: 'Big finish',            color: '#fbbf24',
    rounds: 5, shape: 'bonus',
    seconds: 22, bonusOptions: 5, bonusPoints: 7, requiredCorrect: 3,
  },
];

// Precompute global round ranges for each level.
const LEVEL_RANGES = (() => {
  const arr = [];
  let cursor = 0;
  for (const l of LEVELS) {
    arr.push({ start: cursor + 1, end: cursor + l.rounds });
    cursor += l.rounds;
  }
  return arr;
})();
const TOTAL_ROUNDS = LEVEL_RANGES[LEVEL_RANGES.length - 1].end;

const BEST_KEY = 'wg.best.v1';
const HINTS_PER_GAME = 2;
const SKIPS_PER_GAME = 1;
const FREEZES_PER_GAME = 1;
const FREEZE_DURATION_MS = 6000;
const FAST_ANSWER_THRESHOLD = 0.5; // % of time still remaining
const SKIP_SENTINEL_REGULAR = '__skip__';
const SKIP_SENTINEL_BONUS = -2;
const TIMEOUT_SENTINEL_REGULAR = '__timeout__';
const TIMEOUT_SENTINEL_BONUS = -1;

function levelOf(round) {
  for (let i = 0; i < LEVEL_RANGES.length; i++) {
    if (round >= LEVEL_RANGES[i].start && round <= LEVEL_RANGES[i].end) return i;
  }
  return 0;
}
function isLevelStart(round) { return round === LEVEL_RANGES[levelOf(round)].start; }
function isLevelEnd(round) { return round === LEVEL_RANGES[levelOf(round)].end; }
function isFinalRound(round) { return round === TOTAL_ROUNDS; }
function isBonusRound(round) {
  const meta = LEVELS[levelOf(round)];
  if (meta.shape === 'bonus') return true;
  if (meta.shape === 'mixed' && isLevelEnd(round)) return true;
  return false;
}
function bonusPointsFor(round) { return LEVELS[levelOf(round)].bonusPoints; }
function bonusOptionsFor(round) { return LEVELS[levelOf(round)].bonusOptions; }
function secondsFor(round) {
  const base = LEVELS[levelOf(round)].seconds;
  return isBonusRound(round) ? Math.round(base * 1.5) : base;
}
function multiplierForStreak(streak) {
  if (streak >= 5) return 3;
  if (streak >= 3) return 2;
  return 1;
}
function countLevelCorrect(results, lvl) {
  const { start, end } = LEVEL_RANGES[lvl];
  return results.filter((r) => r.round >= start && r.round <= end && r.correct).length;
}
function countLevelSkipped(results, lvl) {
  const { start, end } = LEVEL_RANGES[lvl];
  return results.filter((r) => r.round >= start && r.round <= end && r.skipped).length;
}
function maxPossibleScore() {
  return LEVELS.reduce((acc, l) => {
    if (l.shape === 'bonus') return acc + l.rounds * l.bonusPoints;
    if (l.shape === 'speed') return acc + l.rounds;
    return acc + (l.rounds - 1) + l.bonusPoints;
  }, 0);
}
function levelShapeLabel(shape) {
  if (shape === 'bonus') return 'All bonus';
  if (shape === 'speed') return 'Speed run';
  return 'Mixed';
}

const FAST_LABELS = ['FAST!', 'ZIP!', 'SHARP!', 'CRISP!'];
function pickFastLabel() {
  return FAST_LABELS[Math.floor(Math.random() * FAST_LABELS.length)];
}

const MUTED_KEY = 'wg.muted.v1';
const TUTORIAL_SEEN_KEY = 'wg.tutorialSeen.v2';

/* ============== Audio (Web Audio API) ============== */

function createAudioPlayer() {
  let ctx = null;
  function ensureCtx() {
    if (typeof window === 'undefined') return null;
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, { type = 'sine', vol = 0.12, attack = 0.005, release = 0.05, when = 0, slideTo = null } = {}) {
    const c = ensureCtx();
    if (!c) return;
    const start = c.currentTime + when;
    const end = start + dur;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo != null) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, end);
    }
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(vol, start + attack);
    gain.gain.setValueAtTime(vol, end - release);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
  function play(kind) {
    switch (kind) {
      case 'correct':
        tone(523.25, 0.08, { vol: 0.12 });
        tone(659.25, 0.08, { when: 0.07, vol: 0.12 });
        tone(783.99, 0.16, { when: 0.14, vol: 0.13 });
        break;
      case 'combo':
        tone(523.25, 0.07, { vol: 0.13 });
        tone(659.25, 0.07, { when: 0.06, vol: 0.13 });
        tone(783.99, 0.07, { when: 0.12, vol: 0.13 });
        tone(1046.5, 0.18, { when: 0.18, vol: 0.14 });
        break;
      case 'mega':
        tone(523.25, 0.06, { vol: 0.14 });
        tone(659.25, 0.06, { when: 0.05, vol: 0.14 });
        tone(783.99, 0.06, { when: 0.1, vol: 0.14 });
        tone(987.77, 0.06, { when: 0.15, vol: 0.14 });
        tone(1318.5, 0.28, { when: 0.2, vol: 0.16 });
        break;
      case 'wrong':
        tone(220, 0.25, { type: 'sawtooth', vol: 0.10, slideTo: 110, attack: 0.005 });
        break;
      case 'timeout':
        tone(330, 0.12, { type: 'square', vol: 0.08 });
        tone(220, 0.22, { when: 0.1, type: 'square', vol: 0.09, slideTo: 110 });
        break;
      case 'click':
        tone(1200, 0.04, { type: 'square', vol: 0.05 });
        break;
      case 'freeze':
        tone(880, 0.4, { type: 'sine', vol: 0.10, slideTo: 220, attack: 0.02, release: 0.15 });
        break;
      case 'wager':
        tone(587.33, 0.06, { type: 'square', vol: 0.08 });
        tone(880, 0.12, { when: 0.05, type: 'square', vol: 0.09 });
        break;
      case 'start':
      case 'levelup':
        tone(523.25, 0.1, { vol: 0.13 });
        tone(659.25, 0.1, { when: 0.09, vol: 0.13 });
        tone(783.99, 0.1, { when: 0.18, vol: 0.13 });
        tone(1046.5, 0.3, { when: 0.27, vol: 0.15 });
        break;
      case 'gameover':
        tone(440, 0.18, { vol: 0.12 });
        tone(349.23, 0.18, { when: 0.16, vol: 0.12 });
        tone(261.63, 0.4, { when: 0.32, vol: 0.13 });
        break;
      default:
        break;
    }
  }
  return { play, ensureCtx };
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ============== Inline SVG icons ============== */

const Icon = {
  Bolt: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  ),
  Star: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2l2.9 6.9 7.4.6-5.6 4.9 1.7 7.2L12 17.8 5.6 21.6l1.7-7.2L1.7 9.5l7.4-.6L12 2z" />
    </svg>
  ),
  Flame: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M13 2c.5 4 4 5.5 4 9.5 0 3.6-2.7 6.5-6 6.5s-6-2.9-6-6.5c0-2.7 2-4.5 3.5-4.5C7 4 9 2 13 2zm0 12c1.5 0 2.5-1 2.5-2.5 0-1-.5-1.7-1.5-2.5-.6.7-.7 1.5-.7 2-.8-.6-1.3-1.5-1.3-2.7C10.5 9 9 10 9 12c0 1.5 1.5 2.5 2.5 2.5z" />
    </svg>
  ),
  Check: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  X: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  ArrowRight: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  ),
  Trophy: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M7 4h10v3a5 5 0 01-5 5 5 5 0 01-5-5V4zm-3 1h2v2a3 3 0 003 3 3 3 0 01-5-3V5zm14 0h2v2a3 3 0 01-5 3 3 3 0 003-3V5zM9 14h6l-1 4h-4l-1-4zm-2 6h10v2H7v-2z" />
    </svg>
  ),
  Clock: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  ),
  Bulb: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M9 21h6v1a1 1 0 01-1 1h-4a1 1 0 01-1-1v-1zm-1-3h8v2H8v-2zm4-16a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
    </svg>
  ),
  Skull: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2C7 2 3 5.8 3 10.5c0 2.8 1.4 5.2 3.5 6.7V20a1 1 0 001 1h11a1 1 0 001-1v-2.8c2.1-1.5 3.5-3.9 3.5-6.7C21 5.8 17 2 12 2zM8 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm8 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 16h4l-1 2h-2l-1-2z" />
    </svg>
  ),
  Keyboard: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h12" />
    </svg>
  ),
  Volume: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4-.91 7-4.49 7-8.77S18 4.14 14 3.23z" />
    </svg>
  ),
  VolumeOff: (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.18l2.45 2.45c.03-.2.05-.39.05-.6zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
    </svg>
  ),
};

function Kbd({ children, className = '' }) {
  return <kbd className={`kbd ${className}`}>{children}</kbd>;
}

/* ============== App ============== */

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [round, setRound] = useState(1);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [results, setResults] = useState([]);
  const [current, setCurrent] = useState(null);
  const [guess, setGuess] = useState(null);
  const [timedOut, setTimedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [interstitial, setInterstitial] = useState(null);
  const [pointPops, setPointPops] = useState([]);
  const [timeLeft, setTimeLeft] = useState(0);
  const [hintsLeft, setHintsLeft] = useState(HINTS_PER_GAME);
  const [skipsLeft, setSkipsLeft] = useState(SKIPS_PER_GAME);
  const [freezesLeft, setFreezesLeft] = useState(FREEZES_PER_GAME);
  const [frozenActive, setFrozenActive] = useState(false);
  const [wager, setWager] = useState(1);
  const [skipped, setSkipped] = useState(false);
  const [eliminatedIdx, setEliminatedIdx] = useState(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [burstKey, setBurstKey] = useState(0);
  const [gameOverReason, setGameOverReason] = useState(null);
  const [bestScore, setBestScore] = useState(() => {
    if (typeof localStorage === 'undefined') return 0;
    const v = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
    return Number.isFinite(v) ? v : 0;
  });
  // Tutorial mode: 'quick' = 3-page visual onboarding (auto-shown once),
  // 'full' = 12-page deep guide (opened from menu), null = closed.
  const [tutorialMode, setTutorialMode] = useState(() => {
    if (typeof localStorage === 'undefined') return 'quick';
    return localStorage.getItem(TUTORIAL_SEEN_KEY) === '1' ? null : 'quick';
  });
  const [muted, setMuted] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(MUTED_KEY) === '1';
  });

  const audioRef = useRef(null);
  if (!audioRef.current) audioRef.current = createAudioPlayer();
  function sfx(kind) {
    if (muted) return;
    audioRef.current?.play(kind);
  }
  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      try { localStorage.setItem(MUTED_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

  function closeTutorial() {
    setTutorialMode(null);
    try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch {}
  }
  function openFullGuide() { setTutorialMode('full'); }

  const popId = useRef(0);
  const realPool = useRef([]);
  const fakePool = useRef([]);
  const badRealWords = useRef(new Set());
  const guessRef = useRef(null);
  const frozenRef = useRef({ frozenStartedAt: 0, accumulatedMs: 0 });

  // keep guessRef in sync — timer effect uses it to know if user has answered
  useEffect(() => { guessRef.current = guess; }, [guess]);

  // Keyboard shortcuts. Use a ref so the listener stays mounted but always
  // sees the current state and handlers.
  const kbdRef = useRef(null);
  kbdRef.current = {
    screen, current, guess, loading, interstitial, tutorialMode,
  };
  const kbdHandlersRef = useRef(null);

  function resetGame() {
    realPool.current = shuffle(REAL_WORDS.filter((w) => !badRealWords.current.has(w)));
    fakePool.current = shuffle(FAKE_WORDS);
    frozenRef.current = { frozenStartedAt: 0, accumulatedMs: 0 };
    setRound(1);
    setScore(0);
    setStreak(0);
    setResults([]);
    setCurrent(null);
    setGuess(null);
    setTimedOut(false);
    setSkipped(false);
    setLoadError(false);
    setInterstitial(null);
    setPointPops([]);
    setTimeLeft(0);
    setHintsLeft(HINTS_PER_GAME);
    setSkipsLeft(SKIPS_PER_GAME);
    setFreezesLeft(FREEZES_PER_GAME);
    setFrozenActive(false);
    setWager(1);
    setEliminatedIdx(null);
    setGameOverReason(null);
  }

  function takeFakeWord() {
    if (fakePool.current.length === 0) fakePool.current = shuffle(FAKE_WORDS);
    return fakePool.current.pop();
  }

  async function takeRealWord() {
    while (realPool.current.length > 0) {
      const word = realPool.current.pop();
      if (badRealWords.current.has(word)) continue;
      const def = await fetchDefinition(word);
      if (def && def.definition) return def;
      badRealWords.current.add(word);
    }
    return null;
  }

  async function buildRegularRound() {
    const isReal = Math.random() < 0.5;
    if (isReal) {
      const def = await takeRealWord();
      if (def) {
        return {
          kind: 'regular',
          word: def.word,
          partOfSpeech: def.partOfSpeech,
          definition: def.definition,
          example: def.example,
          isReal: true,
        };
      }
    }
    const f = takeFakeWord();
    return {
      kind: 'regular',
      word: f.word,
      partOfSpeech: f.partOfSpeech,
      definition: f.definition,
      isReal: false,
    };
  }

  async function buildBonusRound(roundNum) {
    const optionCount = bonusOptionsFor(roundNum);
    const main = await takeRealWord();
    if (!main) return buildRegularRound();

    const decoys = [];
    while (decoys.length < optionCount - 1) {
      const d = await takeRealWord();
      if (!d) break;
      if (d.word.toLowerCase() === main.word.toLowerCase()) continue;
      decoys.push(d);
    }
    if (decoys.length < optionCount - 1) return buildRegularRound();

    const options = shuffle([
      { definition: main.definition, partOfSpeech: main.partOfSpeech, isCorrect: true },
      ...decoys.map((d) => ({
        definition: d.definition,
        partOfSpeech: d.partOfSpeech,
        isCorrect: false,
      })),
    ]);

    return {
      kind: 'bonus',
      word: main.word,
      options,
      pointsForCorrect: bonusPointsFor(roundNum),
      isFinal: isFinalRound(roundNum),
    };
  }

  async function loadRound(n) {
    setLoading(true);
    setLoadError(false);
    setGuess(null);
    setTimedOut(false);
    setSkipped(false);
    setEliminatedIdx(null);
    setWager(1);
    setFrozenActive(false);
    frozenRef.current = { frozenStartedAt: 0, accumulatedMs: 0 };
    try {
      const r = isBonusRound(n) ? await buildBonusRound(n) : await buildRegularRound();
      setCurrent(r);
    } catch (err) {
      console.error(err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  // Bonus-reveal interstitial fires for mixed levels (a bonus round mid- or end-of-level).
  // For all-bonus levels, the level intro already announces the shape — don't double-prompt.
  function shouldShowBonusReveal(n) {
    const meta = LEVELS[levelOf(n)];
    return isBonusRound(n) && meta.shape === 'mixed';
  }

  function enterRound(n) {
    if (isLevelStart(n)) {
      setInterstitial({ type: 'level', level: levelOf(n), pending: n });
      return;
    }
    if (shouldShowBonusReveal(n)) {
      setInterstitial({ type: isFinalRound(n) ? 'final' : 'bonus', pending: n });
      return;
    }
    loadRound(n);
  }

  function dismissInterstitial() {
    if (!interstitial) return;
    const { pending, type } = interstitial;
    if (type === 'level' && shouldShowBonusReveal(pending)) {
      setInterstitial({ type: isFinalRound(pending) ? 'final' : 'bonus', pending });
      return;
    }
    setInterstitial(null);
    loadRound(pending);
  }

  function startGame() {
    audioRef.current?.ensureCtx?.(); // unlock audio with the user gesture
    resetGame();
    setScreen('playing');
    setInterstitial({ type: 'level', level: 0, pending: 1 });
    sfx('start');
  }

  function endGame(finalScore, reason = null) {
    if (finalScore > bestScore) {
      setBestScore(finalScore);
      try { localStorage.setItem(BEST_KEY, String(finalScore)); } catch {}
    }
    setGameOverReason(reason);
    setScreen('gameover');
    sfx(reason?.kind === 'failed-level' ? 'gameover' : 'mega');
  }

  function spawnPointPop(amount, label) {
    const id = ++popId.current;
    setPointPops((p) => [...p, { id, amount, label }]);
    setTimeout(() => {
      setPointPops((p) => p.filter((pop) => pop.id !== id));
    }, 1200);
  }

  /* ============== Timer ============== */

  useEffect(() => {
    if (!current || loading || interstitial || screen !== 'playing') return;
    if (guess !== null) return;
    const total = secondsFor(round);
    setTimeLeft(total);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      const fs = frozenRef.current;
      const liveFrozenMs = fs.frozenStartedAt > 0 ? now - fs.frozenStartedAt : 0;
      const totalFrozenMs = fs.accumulatedMs + liveFrozenMs;
      const elapsed = (now - startedAt - totalFrozenMs) / 1000;
      const remaining = Math.max(0, total - elapsed);
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(tick);
        // Only fire timeout if user hasn't answered in the meantime
        if (guessRef.current === null) handleTimeout();
      }
    }, 100);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, loading, interstitial, screen, round]);

  function handleTimeout() {
    if (guess !== null || !current) return;
    setTimedOut(true);
    setStreak(0);
    setShakeKey((k) => k + 1);
    sfx('timeout');
    if (current.kind === 'regular') {
      setGuess(TIMEOUT_SENTINEL_REGULAR);
      setResults((r) => [...r, { round, kind: 'regular', correct: false, gained: 0 }]);
    } else {
      setGuess(TIMEOUT_SENTINEL_BONUS);
      setResults((r) => [...r, { round, kind: 'bonus', correct: false, gained: 0 }]);
    }
  }

  /* ============== Scoring ============== */

  function submitRegular(choice) {
    if (guess !== null) return;
    const total = secondsFor(round);
    const fast = timeLeft / total >= FAST_ANSWER_THRESHOLD;
    const correct = (choice === 'real') === current.isReal;
    const newStreak = correct ? streak + 1 : 0;
    const mult = multiplierForStreak(newStreak);
    const wagerActive = wager > 1;
    let gained;
    if (correct) {
      const base = 1 * wager;
      const timeBonus = fast ? 1 : 0;
      gained = (base + timeBonus) * mult;
    } else {
      gained = -(wager - 1); // 0 normally, -1 if 2× wager
    }

    setGuess(choice);
    setScore((s) => Math.max(0, s + gained));
    setStreak(newStreak);
    setResults((r) => [...r, { round, kind: 'regular', correct, gained }]);

    if (correct) {
      setBurstKey((k) => k + 1);
      const label =
        wagerActive && mult > 1 ? `${mult}× · 2× WAGER` :
        wagerActive ? '2× WAGER' :
        mult >= 3 ? `${mult}× BLAZE` :
        mult > 1 ? `${mult}× COMBO` :
        fast ? pickFastLabel() :
        null;
      spawnPointPop(gained, label);
      sfx(mult >= 3 ? 'mega' : mult > 1 ? 'combo' : 'correct');
    } else {
      setShakeKey((k) => k + 1);
      if (gained < 0) spawnPointPop(gained, 'WAGER LOST');
      sfx('wrong');
    }
  }

  function submitBonus(idx) {
    if (guess !== null) return;
    if (idx === eliminatedIdx) return;
    const total = secondsFor(round);
    const fast = timeLeft / total >= FAST_ANSWER_THRESHOLD;
    const correct = current.options[idx].isCorrect;
    const newStreak = correct ? streak + 1 : 0;
    const mult = multiplierForStreak(newStreak);
    const wagerActive = wager > 1;
    let gained;
    if (correct) {
      const base = current.pointsForCorrect * wager;
      const timeBonus = fast ? 1 : 0;
      gained = (base + timeBonus) * mult;
    } else {
      gained = -(wager - 1) * current.pointsForCorrect;
    }

    setGuess(idx);
    setScore((s) => Math.max(0, s + gained));
    setStreak(newStreak);
    setResults((r) => [...r, { round, kind: 'bonus', correct, gained }]);

    if (correct) {
      setBurstKey((k) => k + 1);
      const label =
        current.isFinal ? 'FINAL!' :
        wagerActive && mult > 1 ? `${mult}× · 2× WAGER` :
        wagerActive ? '2× WAGER' :
        mult >= 3 ? `${mult}× BLAZE` :
        mult > 1 ? `${mult}× COMBO` :
        'bonus!';
      spawnPointPop(gained, label);
      sfx(current.isFinal || mult >= 3 ? 'mega' : 'combo');
    } else {
      setShakeKey((k) => k + 1);
      if (gained < 0) spawnPointPop(gained, 'WAGER LOST');
      sfx('wrong');
    }
  }

  function triggerHint() {
    if (hintsLeft <= 0 || guess !== null) return;
    if (!current || current.kind !== 'bonus') return;
    if (eliminatedIdx !== null) return;
    const wrong = current.options
      .map((o, i) => (o.isCorrect ? null : i))
      .filter((i) => i !== null);
    if (wrong.length === 0) return;
    const elim = wrong[Math.floor(Math.random() * wrong.length)];
    setEliminatedIdx(elim);
    setHintsLeft((h) => h - 1);
    sfx('click');
  }

  function triggerSkip() {
    if (skipsLeft <= 0 || guess !== null || !current) return;
    setSkipsLeft((s) => s - 1);
    setSkipped(true);
    sfx('click');
    // No streak change — skip preserves your streak (whole point of the power-up).
    if (current.kind === 'regular') {
      setGuess(SKIP_SENTINEL_REGULAR);
      setResults((r) => [...r, { round, kind: 'regular', correct: false, gained: 0, skipped: true }]);
    } else {
      setGuess(SKIP_SENTINEL_BONUS);
      setResults((r) => [...r, { round, kind: 'bonus', correct: false, gained: 0, skipped: true }]);
    }
  }

  function triggerFreeze() {
    if (freezesLeft <= 0 || guess !== null || !current) return;
    if (current.kind !== 'regular') return; // bonus rounds already get 1.5× time
    if (frozenActive) return;
    const fs = frozenRef.current;
    fs.frozenStartedAt = Date.now();
    setFreezesLeft((f) => f - 1);
    setFrozenActive(true);
    sfx('freeze');
    setTimeout(() => {
      const f2 = frozenRef.current;
      if (f2.frozenStartedAt > 0) {
        f2.accumulatedMs += Date.now() - f2.frozenStartedAt;
        f2.frozenStartedAt = 0;
      }
      setFrozenActive(false);
    }, FREEZE_DURATION_MS);
  }

  function toggleWager() {
    if (guess !== null) return;
    setWager((w) => (w === 1 ? 2 : 1));
    sfx('wager');
  }

  function nextRound() {
    // Check level-end threshold after the bonus completes.
    if (isLevelEnd(round)) {
      const lvl = levelOf(round);
      const baseNeed = LEVELS[lvl].requiredCorrect;
      const got = countLevelCorrect(results, lvl);
      const skips = countLevelSkipped(results, lvl);
      // Skips don't count against you — they reduce the requirement instead.
      const need = Math.max(0, baseNeed - skips);
      if (got < need) {
        endGame(score, { kind: 'failed-level', level: lvl, got, need });
        return;
      }
      // Passed this level — celebrate.
      sfx('levelup');
    }
    if (round >= TOTAL_ROUNDS) {
      endGame(score, { kind: 'completed' });
      return;
    }
    const next = round + 1;
    setRound(next);
    enterRound(next);
  }

  // Keep handler ref fresh each render so the keydown listener calls latest closures.
  kbdHandlersRef.current = {
    submitRegular, submitBonus,
    triggerHint, triggerSkip, triggerFreeze, toggleWager,
    nextRound, dismissInterstitial,
  };

  useEffect(() => {
    function onKey(e) {
      const r = kbdRef.current;
      const h = kbdHandlersRef.current;
      if (!r || !h || r.tutorialMode) return;
      // Dismiss an interstitial overlay on Enter / Space.
      if (r.interstitial && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        h.dismissInterstitial();
        return;
      }
      if (r.screen !== 'playing' || !r.current || r.loading || r.interstitial) return;
      // After answering, advance with Enter / Space / →
      if (r.guess !== null) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
          e.preventDefault();
          h.nextRound();
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (r.current.kind === 'regular') {
        if (k === 'r') h.submitRegular('real');
        else if (k === 'f') h.submitRegular('fake');
        else if (k === 'w') h.toggleWager();
        else if (k === 'z') h.triggerFreeze();
        else if (k === 's') h.triggerSkip();
      } else if (r.current.kind === 'bonus') {
        const num = parseInt(k, 10);
        if (!isNaN(num) && num >= 1 && num <= r.current.options.length) {
          h.submitBonus(num - 1);
        } else if (k === 'h') h.triggerHint();
        else if (k === 's') h.triggerSkip();
        else if (k === 'w') h.toggleWager();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const progress = useMemo(
    () => Math.min(100, (results.length / TOTAL_ROUNDS) * 100),
    [results.length],
  );

  const currentLevelIdx = levelOf(round);
  const accent = LEVELS[currentLevelIdx]?.color ?? '#ff8a5b';
  const totalSeconds = secondsFor(round);
  const timerActive = !!current && guess === null && !loading && !interstitial;
  const mult = multiplierForStreak(streak);

  if (screen === 'menu') {
    return (
      <>
        <MenuScreen onStart={startGame} onShowTutorial={openFullGuide} bestScore={bestScore} />
        {tutorialMode && (
          <TutorialOverlay
            pages={tutorialMode === 'full' ? FULL_TUTORIAL_PAGES : QUICK_TUTORIAL_PAGES}
            onClose={closeTutorial}
          />
        )}
      </>
    );
  }
  if (screen === 'gameover') {
    return (
      <>
        <GameOverScreen
          score={score}
          results={results}
          bestScore={bestScore}
          reason={gameOverReason}
          onPlayAgain={startGame}
          onHome={() => setScreen('menu')}
        />
        {tutorialMode && (
          <TutorialOverlay
            pages={tutorialMode === 'full' ? FULL_TUTORIAL_PAGES : QUICK_TUTORIAL_PAGES}
            onClose={closeTutorial}
          />
        )}
      </>
    );
  }

  const streakTier = streak >= 5 ? 'blaze' : streak >= 3 ? 'combo' : 'idle';

  return (
    <div className={`app streak-tier-${streakTier}`} style={{ '--level-accent': accent }}>
      <div className={`streak-overlay streak-overlay-${streakTier}`} aria-hidden="true" />
      <Header
        round={round}
        total={TOTAL_ROUNDS}
        score={score}
        streak={streak}
        progress={progress}
        levelIdx={currentLevelIdx}
        levelName={LEVELS[currentLevelIdx]?.name}
        pointPops={pointPops}
        hintsLeft={hintsLeft}
        mult={mult}
        muted={muted}
        onToggleMute={toggleMute}
      />

      {interstitial?.type === 'level' && (
        <LevelIntro level={interstitial.level} onDone={dismissInterstitial} />
      )}
      {interstitial?.type === 'bonus' && (
        <BonusReveal level={levelOf(interstitial.pending)} onDone={dismissInterstitial} />
      )}
      {interstitial?.type === 'final' && (
        <FinalReveal onDone={dismissInterstitial} />
      )}

      {!interstitial && loading && <LoadingCard />}
      {!interstitial && loadError && <ErrorCard onRetry={() => loadRound(round)} />}

      {!interstitial && !loading && !loadError && current && (
        <PowerMeter streak={streak} />
      )}

      {!interstitial && !loading && !loadError && current && (
        <TimerBar
          timeLeft={timeLeft}
          total={totalSeconds}
          active={timerActive}
          frozen={guess !== null}
          frozenActive={frozenActive}
        />
      )}

      {!interstitial && !loading && !loadError && current && (
        <PowerUpBar
          canHint={current.kind === 'bonus' && guess === null && eliminatedIdx === null}
          canSkip={guess === null}
          canFreeze={current.kind === 'regular' && guess === null && !frozenActive}
          hintsLeft={hintsLeft}
          skipsLeft={skipsLeft}
          freezesLeft={freezesLeft}
          frozenActive={frozenActive}
          onHint={triggerHint}
          onSkip={triggerSkip}
          onFreeze={triggerFreeze}
        />
      )}

      {!interstitial && !loading && !loadError && current?.kind === 'regular' && (
        <RegularCard
          key={round}
          data={current}
          guess={guess}
          timedOut={timedOut}
          skipped={skipped}
          shakeKey={shakeKey}
          burstKey={burstKey}
          wager={wager}
          onToggleWager={toggleWager}
          onGuess={submitRegular}
          onNext={nextRound}
          isLast={round >= TOTAL_ROUNDS}
        />
      )}

      {!interstitial && !loading && !loadError && current?.kind === 'bonus' && (
        <BonusCard
          key={round}
          data={current}
          guess={guess}
          timedOut={timedOut}
          skipped={skipped}
          shakeKey={shakeKey}
          burstKey={burstKey}
          eliminatedIdx={eliminatedIdx}
          wager={wager}
          onToggleWager={toggleWager}
          onPick={submitBonus}
          onNext={nextRound}
          isLast={round >= TOTAL_ROUNDS}
        />
      )}
    </div>
  );
}

/* ============== Menu ============== */

const FLOATING_WORDS = [
  'petrichor', 'eldritch', 'gloaming', 'limpid', 'mercurial',
  'palimpsest', 'lacuna', 'velleity', 'opprobrium', 'sonorous',
  'fugacious', 'halcyon', 'jejune', 'recondite', 'kakistocracy',
  'flibbertigibbet',
];

function FloatingWordsBackdrop() {
  return (
    <div className="floating-words" aria-hidden="true">
      {FLOATING_WORDS.map((word, i) => {
        const top = ((i * 67) % 90) + 5;
        const left = ((i * 41) % 92) + 4;
        return (
          <span
            key={word}
            className="floating-word"
            style={{
              top: `${top}%`,
              left: `${left}%`,
              animationDelay: `${(i * 0.6).toFixed(1)}s`,
              animationDuration: `${14 + (i % 5) * 3}s`,
              fontSize: `${14 + (i % 4) * 4}px`,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
}

/* ============== Tutorial ============== */

// QUICK start — auto-shown once on first visit. Three visual pages, minimal text,
// focused on the core loop (real/fake, controls, go). Per CrazyGames onboarding guidelines:
// short, skippable, visuals over text, no restricted keys.
const QUICK_TUTORIAL_PAGES = [
  {
    icon: 'star',
    accent: '#fbbf24',
    title: 'Real or Fake?',
    body: "Some words are real. Some we invented. Tell them apart.",
    visual: 'card',
  },
  {
    icon: 'keyboard',
    accent: '#7ec5ff',
    title: 'Tap or Type',
    body: "Click the buttons — or use these keys.",
    visual: 'keymap',
  },
  {
    icon: 'flame',
    accent: '#ff8a5b',
    title: "Let's Play",
    body: "8 stages. Build combos. Don't let the streak die.",
  },
];

// FULL guide — opened from the menu "How to play" button. The deep tour.
const FULL_TUTORIAL_PAGES = [
  {
    icon: 'star',
    accent: '#fbbf24',
    title: 'Welcome to Word Guesser',
    body: "Some of these words are real. Some we made up. Your job: spot the truth across 8 stages.",
  },
  {
    icon: 'check',
    accent: '#22e6a0',
    title: 'Real or Fake?',
    body: "Read the word and its definition, then pick REAL or FAKE. Tap a button or hit the matching key.",
    keys: [['R', 'Vote REAL'], ['F', 'Vote FAKE']],
  },
  {
    icon: 'bolt',
    accent: '#a78bfa',
    title: 'Bonus Rounds',
    body: "One word, several definitions, only one is real. Bigger reward — 3 to 7 points each.",
    keys: [['1–5', 'Pick option']],
  },
  {
    icon: 'clock',
    accent: '#7ec5ff',
    title: 'Beat the Clock',
    body: "Every round has a timer. Run out and it counts as wrong. Answer with more than half the time left for a FAST! bonus point.",
  },
  {
    icon: 'flame',
    accent: '#ff8a5b',
    title: 'Combos & Power Meter',
    body: "3 correct in a row = 2× points. 5 in a row = 3× points. The POWER meter under the header fills as your streak grows — and the background heats up.",
  },
  {
    icon: 'bolt',
    accent: '#ffd166',
    title: '2× Wager',
    body: "Feeling sure? Tap WAGER before answering. Right = double points. Wrong = lose points equal to the wager. Risk it for big swings.",
    keys: [['W', 'Toggle wager']],
  },
  {
    icon: 'bulb',
    accent: '#fbbf24',
    title: 'Power-up: Hint',
    body: "You get 2 hints per game. In a bonus round, tap HINT to eliminate one wrong definition. Saves you when nothing looks familiar.",
    keys: [['H', 'Use hint']],
  },
  {
    icon: 'arrow',
    accent: '#7ec5ff',
    title: 'Power-up: Skip',
    body: "1 skip per game. Bail on a round you can't solve — your streak survives, AND that stage's pass-threshold drops by 1. It's safe to use.",
    keys: [['S', 'Skip round']],
  },
  {
    icon: 'clock',
    accent: '#b6dcff',
    title: 'Power-up: Freeze',
    body: "1 freeze per game (regular rounds only). Pauses the timer for 6 seconds so you can think. Lifesaver on the speed-run stages.",
    keys: [['Z', 'Freeze timer']],
  },
  {
    icon: 'skull',
    accent: '#ff5b7e',
    title: 'Pass or Perish',
    body: "Each stage has a correct-answer target. Miss it and the game ends. Skip lowers the target by 1 each time you spend one.",
  },
  {
    icon: 'trophy',
    accent: '#a78bfa',
    title: 'Three Stage Shapes',
    body: "MIXED: regular rounds with a bonus finale. SPEED: all regular, very fast clock. BONUS: every round is a bonus round. 8 stages, all different.",
  },
  {
    icon: 'volume',
    accent: '#22e6a0',
    title: "You're Ready",
    body: "Mute toggle lives in the top-right of the header. Press → or hit Let's Play to start. Good luck — don't let the streak die.",
    keys: [['→', 'Next page'], ['Enter', 'Confirm']],
  },
];

const TUTORIAL_ICON_MAP = {
  star: Icon.Star,
  check: Icon.Check,
  bolt: Icon.Bolt,
  flame: Icon.Flame,
  bulb: Icon.Bulb,
  skull: Icon.Skull,
  trophy: Icon.Trophy,
  clock: Icon.Clock,
  arrow: Icon.ArrowRight,
  volume: Icon.Volume,
  keyboard: Icon.Keyboard,
};

function TutorialCardMock() {
  return (
    <div className="tut-mock" aria-hidden="true">
      <div className="tut-mock-card">
        <span className="tut-mock-tab">GUESS!</span>
        <div className="tut-mock-word">defenestrate</div>
        <div className="tut-mock-def">to throw someone out of a window</div>
        <div className="tut-mock-choices">
          <span className="tut-mock-btn real"><Icon.Check width="14" height="14" /> REAL</span>
          <span className="tut-mock-btn fake"><Icon.X width="14" height="14" /> FAKE</span>
        </div>
      </div>
    </div>
  );
}

function TutorialKeyMap() {
  return (
    <div className="tut-keymap" aria-hidden="true">
      <div className="tut-keymap-row">
        <span className="tut-keymap-pair"><Kbd>R</Kbd><Kbd>F</Kbd></span>
        <span className="tut-keymap-label">Real / Fake</span>
      </div>
      <div className="tut-keymap-row">
        <span className="tut-keymap-pair"><Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd><Kbd>4</Kbd><Kbd>5</Kbd></span>
        <span className="tut-keymap-label">Bonus options</span>
      </div>
      <div className="tut-keymap-row">
        <span className="tut-keymap-pair"><Kbd>↵</Kbd></span>
        <span className="tut-keymap-label">Next round</span>
      </div>
    </div>
  );
}

function TutorialOverlay({ pages, onClose }) {
  const [step, setStep] = useState(0);
  const page = pages[step];
  const isFirst = step === 0;
  const isLast = step === pages.length - 1;
  const IconCmp = TUTORIAL_ICON_MAP[page.icon] || Icon.Star;

  function next() {
    if (isLast) onClose();
    else setStep((s) => s + 1);
  }
  function back() {
    if (!isFirst) setStep((s) => s - 1);
  }

  // Note: intentionally NOT binding Escape — per web-game best practices,
  // Escape is reserved for fullscreen exit. Use the Skip button or click outside.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isFirst, isLast]);

  return (
    <div className="overlay tutorial-overlay" onClick={onClose}>
      <div
        className="tutorial-card"
        style={{ '--page-accent': page.accent }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="tutorial-skip" onClick={onClose} type="button">Skip</button>
        <div className="tutorial-icon"><IconCmp width="42" height="42" /></div>
        <div className="tutorial-step-label">{step + 1} / {pages.length}</div>
        <h2 className="tutorial-title">{page.title}</h2>
        <p className="tutorial-body">{page.body}</p>
        {page.visual === 'card' && <TutorialCardMock />}
        {page.visual === 'keymap' && <TutorialKeyMap />}
        {page.keys && (
          <div className="tutorial-keys">
            {page.keys.map(([k, label]) => (
              <span key={k} className="tutorial-key-row">
                <Kbd>{k}</Kbd>
                <span>{label}</span>
              </span>
            ))}
          </div>
        )}
        <div className="tutorial-dots">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`tutorial-dot ${i === step ? 'on' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`Go to page ${i + 1}`}
            />
          ))}
        </div>
        <div className="tutorial-actions">
          <button
            className="btn-ghost"
            onClick={back}
            disabled={isFirst}
            type="button"
          >
            Back
          </button>
          <button className="btn-primary" onClick={next} type="button">
            <span>{isLast ? "Let's play" : 'Next'}</span>
            <Icon.ArrowRight width="16" height="16" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuScreen({ onStart, onShowTutorial, bestScore }) {
  return (
    <div className="app menu">
      <FloatingWordsBackdrop />

      <div className="brand">
        <div className="brand-tile">W</div>
        <div className="brand-wordmark">
          <span className="brand-line-1">WORD</span>
          <span className="brand-line-2">GUESSER</span>
        </div>
      </div>
      <p className="tagline">Real word, or did we make it up? <span className="tagline-em">8 levels — let's go.</span></p>

      {bestScore > 0 && (
        <div className="best-pill">
          <Icon.Trophy width="14" height="14" />
          <span className="best-label">Best</span>
          <span className="best-value">{bestScore}</span>
        </div>
      )}

      <div className="menu-actions">
        <button className="btn-cta" onClick={onStart}>
          <span>PLAY</span>
          <Icon.ArrowRight width="20" height="20" />
        </button>
        <button className="btn-secondary" onClick={onShowTutorial} type="button">
          <Icon.Bulb width="16" height="16" />
          <span>Full guide</span>
        </button>
      </div>

      <div className="rules-card">
        <div className="rules-eyebrow">How it works</div>
        <div className="rules-grid">
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(34, 230, 160, 0.15)', color: 'var(--real)' }}>
              <Icon.Check width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Real or fake?</div>
              <div className="rule-sub">20 rounds across 4 levels</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(126, 197, 255, 0.18)', color: '#7ec5ff' }}>
              <Icon.Clock width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Beat the clock</div>
              <div className="rule-sub">Time shrinks each level</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(255, 138, 91, 0.18)', color: 'var(--accent)' }}>
              <Icon.Flame width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Combo multipliers</div>
              <div className="rule-sub">3 streak = 2x, 5 = 3x</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(255, 91, 126, 0.18)', color: 'var(--fake)' }}>
              <Icon.Skull width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Pass or perish</div>
              <div className="rule-sub">Hit each level's target or it's over</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(167, 139, 250, 0.18)', color: 'var(--bonus)' }}>
              <Icon.Bolt width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Bonus rounds</div>
              <div className="rule-sub">Harder & richer at higher levels</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(251, 191, 36, 0.18)', color: 'var(--final)' }}>
              <Icon.Bulb width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">Power-ups</div>
              <div className="rule-sub">{HINTS_PER_GAME} hints · {SKIPS_PER_GAME} skip · {FREEZES_PER_GAME} freeze</div>
            </div>
          </div>
          <div className="rule">
            <span className="rule-icon" style={{ background: 'rgba(255, 209, 102, 0.16)', color: 'var(--accent-2)' }}>
              <Icon.Bolt width="16" height="16" />
            </span>
            <div className="rule-body">
              <div className="rule-title">2× wager</div>
              <div className="rule-sub">Bigger reward — but you lose if wrong</div>
            </div>
          </div>
        </div>
        <div className="rules-thresholds">
          {LEVELS.map((l, i) => (
            <span
              key={l.name}
              className={`threshold-chip threshold-${l.shape}`}
              style={{ '--lvl': l.color }}
              title={`${l.name} — ${levelShapeLabel(l.shape)} · ${l.seconds}s · need ${l.requiredCorrect}/${l.rounds}`}
            >
              <span className="threshold-chip-num">L{i + 1}</span>
              <span className="threshold-chip-sec">{l.seconds}s</span>
              <span className="threshold-chip-need">{l.requiredCorrect}/{l.rounds}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============== Header ============== */

function Header({ round, total, score, streak, progress, levelIdx, levelName, pointPops, hintsLeft, mult, muted, onToggleMute }) {
  return (
    <header className="game-header">
      <div className="header-top">
        <div className="level-pill">
          <span className="level-pill-num">L{levelIdx + 1}</span>
          <span className="level-pill-name">{levelName}</span>
        </div>
        <div className="round-counter">
          <span className="round-counter-label">Round</span>
          <span className="round-counter-val">{round}<span className="round-counter-of">/{total}</span></span>
        </div>
        <div className="header-stats">
          <div className="chip chip-score">
            <Icon.Star width="13" height="13" />
            <span className="chip-val">{score}</span>
            <span className="pops">
              {pointPops.map((p) => (
                <span key={p.id} className={`point-pop ${p.amount < 0 ? 'point-pop-neg' : ''}`}>
                  {p.amount >= 0 ? '+' : ''}{p.amount}{p.label && <em> {p.label}</em>}
                </span>
              ))}
            </span>
          </div>
          <div className={`chip chip-streak ${streak >= 3 ? 'chip-streak-hot' : ''}`}>
            <Icon.Flame width="13" height="13" />
            <span className="chip-val">{streak}</span>
            {mult > 1 && <span className="chip-mult">{mult}x</span>}
          </div>
          <div className={`chip chip-hint ${hintsLeft === 0 ? 'chip-hint-empty' : ''}`} title={`${hintsLeft} hint${hintsLeft === 1 ? '' : 's'} left`}>
            <Icon.Bulb width="13" height="13" />
            <span className="chip-val">{hintsLeft}</span>
          </div>
          <button
            type="button"
            className={`chip chip-mute ${muted ? 'chip-mute-off' : ''}`}
            onClick={onToggleMute}
            title={muted ? 'Sound off — tap to enable' : 'Sound on — tap to mute'}
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
          >
            {muted ? <Icon.VolumeOff width="13" height="13" /> : <Icon.Volume width="13" height="13" />}
          </button>
        </div>
      </div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${progress}%` }} />
        {LEVEL_RANGES.slice(0, -1).map((r, i) => (
          <div
            key={i}
            className="progress-tick"
            style={{ left: `${(r.end / TOTAL_ROUNDS) * 100}%` }}
          />
        ))}
      </div>
    </header>
  );
}

/* ============== Power Meter ============== */

const POWER_MAX = 5;

function PowerMeter({ streak }) {
  const filled = Math.min(streak, POWER_MAX);
  const mult = multiplierForStreak(streak);
  const tier =
    streak >= 5 ? 'blaze' :
    streak >= 3 ? 'combo' :
    'idle';
  return (
    <div className={`power-meter power-${tier}`}>
      <div className="power-label">
        <Icon.Flame width="12" height="12" />
        <span>POWER</span>
      </div>
      <div className="power-pips">
        {Array.from({ length: POWER_MAX }).map((_, i) => {
          const on = i < filled;
          const milestone = i === 2 || i === 4; // combo at 3, blaze at 5
          return (
            <span
              key={i}
              className={`power-pip ${on ? 'on' : ''} ${milestone ? 'milestone' : ''}`}
            />
          );
        })}
      </div>
      <div className="power-status">
        {tier === 'blaze' ? `${mult}× BLAZE`
          : tier === 'combo' ? `${mult}× COMBO`
          : streak > 0 ? `${POWER_MAX - filled} to combo`
          : 'Build a streak'}
      </div>
    </div>
  );
}

/* ============== Timer ============== */

function TimerBar({ timeLeft, total, active, frozen, frozenActive }) {
  const pct = Math.max(0, Math.min(100, (timeLeft / total) * 100));
  const urgent = active && !frozenActive && timeLeft <= 5 && timeLeft > 0;
  const expired = timeLeft <= 0;
  const cls = [
    'timer-row',
    urgent ? 'timer-urgent' : '',
    frozen ? 'timer-frozen' : '',
    frozenActive ? 'timer-freeze-active' : '',
  ].join(' ').trim();
  return (
    <div className={cls}>
      <Icon.Clock width="14" height="14" />
      <div className="timer-bar">
        <div className="timer-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="timer-num">
        {frozenActive ? 'FROZEN' : expired ? '0' : `${Math.ceil(timeLeft)}s`}
      </span>
    </div>
  );
}

function PowerUpBar({
  canHint, canSkip, canFreeze,
  hintsLeft, skipsLeft, freezesLeft,
  frozenActive,
  onHint, onSkip, onFreeze,
}) {
  return (
    <div className="powerup-bar" role="toolbar" aria-label="Power-ups">
      <button
        type="button"
        className="powerup powerup-hint"
        onClick={onHint}
        disabled={!canHint || hintsLeft <= 0}
        title="Hint — eliminate a wrong option (bonus only)"
        aria-keyshortcuts="H"
      >
        <Icon.Bulb width="14" height="14" />
        <span className="powerup-label">Hint</span>
        <span className="powerup-count">{hintsLeft}</span>
        <Kbd className="kbd-on-powerup">H</Kbd>
      </button>
      <button
        type="button"
        className="powerup powerup-skip"
        onClick={onSkip}
        disabled={!canSkip || skipsLeft <= 0}
        title="Skip without breaking your streak"
        aria-keyshortcuts="S"
      >
        <Icon.ArrowRight width="14" height="14" />
        <span className="powerup-label">Skip</span>
        <span className="powerup-count">{skipsLeft}</span>
        <Kbd className="kbd-on-powerup">S</Kbd>
      </button>
      <button
        type="button"
        className={`powerup powerup-freeze ${frozenActive ? 'powerup-freeze-on' : ''}`}
        onClick={onFreeze}
        disabled={!canFreeze || freezesLeft <= 0}
        title="Freeze — pause the timer 6s (regular only)"
        aria-keyshortcuts="Z"
      >
        <Icon.Clock width="14" height="14" />
        <span className="powerup-label">{frozenActive ? 'Frozen' : 'Freeze'}</span>
        <span className="powerup-count">{freezesLeft}</span>
        <Kbd className="kbd-on-powerup">Z</Kbd>
      </button>
    </div>
  );
}

function WagerToggle({ wager, onToggle, baseLabel }) {
  const on = wager > 1;
  return (
    <button
      type="button"
      className={`wager-btn ${on ? 'wager-on' : ''}`}
      onClick={onToggle}
      title={on ? 'Wager active: doubled reward, penalty if wrong' : 'Tap to wager 2× — bigger reward, but you lose points if wrong'}
      aria-keyshortcuts="W"
    >
      <Icon.Bolt width="14" height="14" />
      <span>{on ? '2× WAGER ON' : baseLabel}</span>
      <Kbd className="kbd-on-wager">W</Kbd>
    </button>
  );
}

/* ============== Interstitials ============== */

function useAutoDismiss(onDone, ms) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
}

function LevelIntro({ level, onDone }) {
  useAutoDismiss(onDone, 2600);
  const meta = LEVELS[level];
  return (
    <div className="overlay" onClick={onDone}>
      <div className="level-intro" style={{ '--level-accent': meta.color }}>
        <div className="level-eyebrow">Stage {level + 1} / {LEVELS.length}</div>
        <div className="level-title">{meta.name}</div>
        <div className="level-tag">{meta.tag}</div>
        <div className="level-shape">
          <span className={`shape-badge shape-${meta.shape}`}>
            {meta.shape === 'bonus' && <Icon.Bolt width="12" height="12" />}
            {meta.shape === 'speed' && <Icon.Flame width="12" height="12" />}
            {meta.shape === 'mixed' && <Icon.Star width="12" height="12" />}
            <span>{levelShapeLabel(meta.shape)}</span>
          </span>
        </div>
        <div className="level-stats">
          <div className="level-stat">
            <Icon.Clock width="14" height="14" />
            <span>{meta.seconds}s · {meta.rounds} rounds</span>
          </div>
          <div className="level-stat">
            <Icon.Trophy width="14" height="14" />
            <span>Need {meta.requiredCorrect}/{meta.rounds} to advance</span>
          </div>
        </div>
        <div className="ready-tag">READY?</div>
        <div className="level-bar" />
      </div>
    </div>
  );
}

function BonusReveal({ level, onDone }) {
  useAutoDismiss(onDone, 1700);
  const meta = LEVELS[level];
  return (
    <div className="overlay overlay-bonus" onClick={onDone}>
      <div className="bonus-reveal">
        <div className="bonus-reveal-icon"><Icon.Bolt width="48" height="48" /></div>
        <div className="bonus-reveal-eyebrow">Bonus Round</div>
        <div className="bonus-reveal-title">Pick the real one</div>
        <div className="bonus-reveal-sub">{meta.bonusPoints} points · {meta.bonusOptions} options</div>
      </div>
    </div>
  );
}

function FinalReveal({ onDone }) {
  useAutoDismiss(onDone, 2200);
  const meta = LEVELS[LEVELS.length - 1];
  return (
    <div className="overlay overlay-final" onClick={onDone}>
      <div className="bonus-reveal final-reveal">
        <div className="bonus-reveal-icon"><Icon.Star width="56" height="56" /></div>
        <div className="bonus-reveal-eyebrow">Final Challenge</div>
        <div className="bonus-reveal-title">{meta.bonusOptions} options. One truth.</div>
        <div className="bonus-reveal-sub">{meta.bonusPoints} points · make it count</div>
      </div>
    </div>
  );
}

/* ============== Cards ============== */

function LoadingCard() {
  return (
    <div className="card loading-card">
      <div className="loader">
        <span className="dot" /><span className="dot" /><span className="dot" />
      </div>
      <div className="loader-text">Conjuring a word…</div>
    </div>
  );
}

function ErrorCard({ onRetry }) {
  return (
    <div className="card">
      <p>Couldn't fetch a word. Check your connection.</p>
      <button className="btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

function ConfettiBurst({ trigger }) {
  if (!trigger) return null;
  const n = 16;
  return (
    <div className="confetti" key={trigger} aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => {
        const angle = (i / n) * Math.PI * 2;
        const dist = 70 + Math.random() * 50;
        return (
          <span
            key={i}
            className="confetto"
            style={{
              '--x': `${Math.cos(angle) * dist}px`,
              '--y': `${Math.sin(angle) * dist - 20}px`,
              '--hue': `${Math.floor(Math.random() * 360)}`,
              '--delay': `${(i % 4) * 0.03}s`,
              '--rot': `${Math.floor(Math.random() * 360)}deg`,
            }}
          />
        );
      })}
    </div>
  );
}

function RegularCard({ data, guess, timedOut, skipped, shakeKey, burstKey, wager, onToggleWager, onGuess, onNext, isLast }) {
  const answered = guess !== null;
  const correct = answered && !timedOut && !skipped && (guess === 'real') === data.isReal;
  const cardCls = [
    'card',
    'slide-in',
    answered && !skipped ? (correct ? 'card-win' : 'card-lose') : '',
    answered && skipped ? 'card-skip' : '',
    !correct && !skipped && shakeKey ? 'shake' : '',
    wager > 1 && !answered ? 'card-wager' : '',
  ].join(' ').trim();
  return (
    <div className={cardCls} data-shake={shakeKey}>
      <ConfettiBurst trigger={correct ? burstKey : 0} />
      <div className="card-tab"><span>GUESS!</span></div>
      <div className="word-block">
        <div className="word">{data.word}</div>
        {data.partOfSpeech && <div className="pos">{data.partOfSpeech}</div>}
        <div className="definition">{data.definition}</div>
        {answered && data.example && <div className="example">"{data.example}"</div>}
      </div>

      {!answered ? (
        <>
          <div className="wager-row">
            <WagerToggle wager={wager} onToggle={onToggleWager} baseLabel="Double or nothing" />
            {wager > 1 && <span className="wager-hint">+1 extra if right · −1 if wrong</span>}
          </div>
          <div className="choices">
            <button className="btn-vote real" onClick={() => onGuess('real')} aria-keyshortcuts="R">
              <Icon.Check width="22" height="22" />
              <span>REAL</span>
              <Kbd className="kbd-on-btn">R</Kbd>
            </button>
            <button className="btn-vote fake" onClick={() => onGuess('fake')} aria-keyshortcuts="F">
              <Icon.X width="22" height="22" />
              <span>FAKE</span>
              <Kbd className="kbd-on-btn">F</Kbd>
            </button>
          </div>
        </>
      ) : (
        <div className={`verdict ${skipped ? 'skip' : correct ? 'win' : 'lose'} pop-in`}>
          <div className="verdict-line">
            <span className={`verdict-icon ${skipped ? 'neutral' : correct ? 'ok' : 'bad'}`}>
              {skipped
                ? <Icon.ArrowRight width="20" height="20" />
                : correct
                  ? <Icon.Check width="20" height="20" />
                  : <Icon.X width="20" height="20" />}
            </span>
            <span>
              {skipped
                ? <>Skipped — streak preserved. It was <strong>{data.isReal ? 'REAL' : 'FAKE'}</strong>.</>
                : timedOut
                  ? <>Time's up! It was <strong>{data.isReal ? 'REAL' : 'FAKE'}</strong>.</>
                  : correct
                    ? <>Correct! It was <strong>{data.isReal ? 'REAL' : 'FAKE'}</strong>.</>
                    : <>Nope. It was <strong>{data.isReal ? 'REAL' : 'FAKE'}</strong>.</>}
            </span>
          </div>
          <button className="btn-primary" onClick={onNext} aria-keyshortcuts="Enter">
            <span>{isLast ? 'See results' : 'Next round'}</span>
            <Icon.ArrowRight width="16" height="16" />
            <Kbd className="kbd-on-btn-primary">↵</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}

function BonusCard({ data, guess, timedOut, skipped, shakeKey, burstKey, eliminatedIdx, wager, onToggleWager, onPick, onNext, isLast }) {
  const answered = guess !== null;
  const correct = answered && !timedOut && !skipped && guess >= 0 && data.options[guess]?.isCorrect;
  const cardCls = [
    'card',
    'bonus',
    data.isFinal ? 'final' : '',
    'slide-in',
    answered && skipped ? 'card-skip' : '',
    !correct && !skipped && shakeKey ? 'shake' : '',
    wager > 1 && !answered ? 'card-wager' : '',
  ].join(' ').trim();
  return (
    <div className={cardCls} data-shake={shakeKey}>
      <ConfettiBurst trigger={correct ? burstKey : 0} />
      <div className="bonus-banner">
        {data.isFinal ? <Icon.Star width="14" height="14" /> : <Icon.Bolt width="14" height="14" />}
        <span>
          {data.isFinal ? 'FINAL · ' : 'BONUS · '}
          {wager > 1 ? `${data.pointsForCorrect * 2} pts (2× wagered)` : `${data.pointsForCorrect} pts`}
        </span>
      </div>
      <div className="word-block">
        <div className="word">{data.word}</div>
        <div className="bonus-prompt">Which is the real definition?</div>
      </div>
      <ol className="options">
        {data.options.map((opt, idx) => {
          const isPicked = guess === idx;
          const reveal = answered;
          const isEliminated = idx === eliminatedIdx && !reveal;
          const cls = [
            'option',
            reveal && opt.isCorrect ? 'option-correct' : '',
            reveal && isPicked && !opt.isCorrect ? 'option-wrong' : '',
            reveal && !opt.isCorrect && !isPicked ? 'option-dim' : '',
            isEliminated ? 'option-eliminated' : '',
          ].join(' ').trim();
          return (
            <li key={idx}>
              <button
                className={cls}
                disabled={answered || isEliminated}
                onClick={() => onPick(idx)}
                aria-keyshortcuts={String(idx + 1)}
              >
                {opt.partOfSpeech && <span className="pos-inline">{opt.partOfSpeech}. </span>}
                <span className="option-text">{opt.definition}</span>
                {!answered && !isEliminated && <Kbd className="kbd-on-option">{idx + 1}</Kbd>}
              </button>
            </li>
          );
        })}
      </ol>
      {!answered && (
        <div className="wager-row">
          <WagerToggle wager={wager} onToggle={onToggleWager} baseLabel="Double or nothing" />
          {wager > 1 && (
            <span className="wager-hint">
              +{data.pointsForCorrect} extra if right · −{data.pointsForCorrect} if wrong
            </span>
          )}
        </div>
      )}
      {answered && (
        <div className={`verdict ${skipped ? 'skip' : correct ? 'win' : 'lose'} pop-in`}>
          <div className="verdict-line">
            <span className={`verdict-icon ${skipped ? 'neutral' : correct ? 'ok' : 'bad'}`}>
              {skipped
                ? <Icon.ArrowRight width="20" height="20" />
                : correct
                  ? <Icon.Check width="20" height="20" />
                  : <Icon.X width="20" height="20" />}
            </span>
            <span>
              {skipped ? 'Skipped — streak preserved.'
                : timedOut ? "Time's up!"
                : correct ? `Nailed it!`
                : 'Not quite.'}
            </span>
          </div>
          <button className="btn-primary" onClick={onNext} aria-keyshortcuts="Enter">
            <span>{isLast ? 'See results' : 'Next round'}</span>
            <Icon.ArrowRight width="16" height="16" />
            <Kbd className="kbd-on-btn-primary">↵</Kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/* ============== Game Over ============== */

function GameOverScreen({ score, results, bestScore, reason, onPlayAgain, onHome }) {
  const correctCount = results.filter((r) => r.correct).length;
  const trueMax = maxPossibleScore();
  const ratio = score / trueMax;
  const failed = reason?.kind === 'failed-level';

  const stars = failed
    ? 0
    : (ratio >= 0.85 ? 3 : ratio >= 0.55 ? 2 : ratio >= 0.25 ? 1 : 0);

  const label = failed
    ? 'Eliminated'
    : ratio >= 0.9 ? 'Lexicographer'
    : ratio >= 0.7 ? 'Wordsmith'
    : ratio >= 0.5 ? 'Decent ear'
    : ratio >= 0.3 ? 'Apprentice'
    : 'Easily duped';

  const isNewBest = !failed && score >= bestScore && score > 0;

  const perLevel = LEVELS.map((l, idx) => {
    const { start, end } = LEVEL_RANGES[idx];
    const items = results.filter((r) => r.round >= start && r.round <= end);
    const got = items.filter((r) => r.correct).length;
    const skips = items.filter((r) => r.skipped).length;
    const reached = items.length > 0;
    const need = Math.max(0, l.requiredCorrect - skips);
    return { name: l.name, color: l.color, got, of: l.rounds, played: items.length, need, reached };
  });

  return (
    <div className="app menu game-over">
      <FloatingWordsBackdrop />
      <div className={`go-eyebrow ${failed ? 'go-eyebrow-fail' : ''}`}>
        {failed ? 'Eliminated' : isNewBest ? '🏆 NEW BEST' : 'Game over'}
      </div>

      {failed ? (
        <div className="fail-icon"><Icon.Skull width="64" height="64" /></div>
      ) : (
        <div className="stars">
          {[0, 1, 2].map((i) => (
            <span key={i} className={`star ${i < stars ? 'on' : 'off'}`} style={{ animationDelay: `${i * 0.18}s` }}>
              <Icon.Star width="44" height="44" />
            </span>
          ))}
        </div>
      )}

      <div className="final-score">{score}<span className="final-divide"> / {trueMax}</span></div>
      <div className="final-label">{label}</div>

      {failed ? (
        <p className="tagline fail-reason">
          You needed <strong>{reason.need}/{LEVELS[reason.level].rounds}</strong> in{' '}
          <strong>{LEVELS[reason.level].name}</strong> to advance. You got{' '}
          <strong>{reason.got}/{LEVELS[reason.level].rounds}</strong>.
        </p>
      ) : (
        <p className="tagline">{correctCount} of {TOTAL_ROUNDS} rounds correct.</p>
      )}

      <div className="level-breakdown">
        {perLevel.map((l) => {
          const passed = l.reached && l.got >= l.need;
          const failedHere = l.reached && l.got < l.need;
          return (
            <div className="lb-row" key={l.name} style={{ '--lvl': l.color }}>
              <span className="lb-dot" />
              <span className="lb-name">{l.name}</span>
              <span className="lb-score">
                {l.reached ? `${l.got}/${l.played}` : '—'}
                {passed && <span className="lb-pass">✓</span>}
                {failedHere && <span className="lb-fail">✗</span>}
              </span>
            </div>
          );
        })}
      </div>

      <div className="go-actions">
        <button className="btn-cta" onClick={onPlayAgain}>
          <span>{failed ? 'TRY AGAIN' : 'PLAY AGAIN'}</span>
          <Icon.ArrowRight width="20" height="20" />
        </button>
        <button className="btn-ghost" onClick={onHome}>Home</button>
      </div>
    </div>
  );
}
