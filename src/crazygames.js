// CrazyGames SDK wrapper.
//
// All functions are safe to call when the SDK isn't present (local dev,
// non-CrazyGames hosting). They no-op silently in that case.
//
// CrazyGames requirements satisfied by this integration:
//   - SDK is loaded (script tag in index.html)
//   - SDK is initialized on app mount
//   - gameplayStart() / gameplayStop() bracket active play (required for ads)
//   - happytime() is called at natural break points (between levels)
//   - No external login UI — we rely on the auto-logged-in CrazyGames user
//   - Automatic Progress Save: our localStorage writes are picked up
//     automatically by the SDK on CrazyGames; no extra code required.
//
// Docs: https://docs.crazygames.com/sdk/html5/

let initialized = false;
let initPromise = null;

function sdk() {
  return typeof window !== 'undefined' ? window.CrazyGames?.SDK : null;
}

export function isAvailable() {
  return !!sdk();
}

export async function init() {
  if (initialized) return true;
  if (initPromise) return initPromise;
  const s = sdk();
  if (!s) return false;
  initPromise = Promise.resolve()
    .then(() => s.init())
    .then(() => { initialized = true; return true; })
    .catch((err) => {
      console.warn('[CrazyGames] SDK init failed:', err);
      return false;
    });
  return initPromise;
}

// Mark the start of active gameplay. CrazyGames uses this to know when
// it's safe to schedule ads (i.e., NOT during gameplay).
export function gameplayStart() {
  try { sdk()?.game?.gameplayStart?.(); } catch { /* noop */ }
}

// Mark the end of active gameplay (game over, returned to menu, paused).
export function gameplayStop() {
  try { sdk()?.game?.gameplayStop?.(); } catch { /* noop */ }
}

// Signal a good moment for a midgame ad (e.g., between levels). Called
// freely — the SDK decides whether to actually show anything.
export function happytime() {
  try { sdk()?.game?.happytime?.(); } catch { /* noop */ }
}
