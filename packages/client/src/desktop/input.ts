/**
 * desktop/input.ts — the F22 Desktop Command keymap (spec §7.22, plan C33).
 *
 * PURE: `keymapToIntent(key, state)` maps a keyboard key + an edge-tracking
 * `KeymapState` to exactly one {@link DesktopIntent} (or null). No THREE, no DOM,
 * no I/O — unit-tested as pure keybinding→intent functions.
 *
 * THE NORMATIVE §7.22 KEYMAP (tested one binding at a time):
 *   T          → spawn        (net-new, ALONGSIDE the preserved click-spawn)
 *   C          → recolor      (AS-BUILT Phase A — the regression pin)
 *   V          → rendermode   (AS-BUILT Phase A — the regression pin)
 *   1 2 3 4    → camera        orbit / fly / follow / auto
 *   Tab        → followNext
 *   B          → ballot
 *   ` (backtick)→ ptt (hold)   pressed:true on down, pressed:false on up
 *   M          → mute
 *   ?          → help
 *
 * ── THE AS-BUILT BINDINGS ARE NEVER REBOUND ──
 * `C`/`V`/click/drag stay EXACTLY as `controllers.ts` implements them. This module
 * is purely ADDITIVE: it is a SECOND classifier the desktop entry consults for the
 * NEW keys (T/1–4/Tab/B/backtick/M/?). The existing `controllers.ts` `keydown`
 * listener that handles `c`/`v` on the last-touched shape is untouched — so C33 lists
 * `C`/`V` here only to PIN their intent semantics (recolor / rendermode), never to
 * re-wire the handler. The desktop entry routes T's spawn + the camera/ballot/PTT
 * intents; recolor/rendermode continue to flow through the Phase A path.
 *
 * EDGE-TRIGGERED (once per press): the state records which keys are currently held.
 * The first observation of a key returns its intent; a repeat while held returns
 * null; `state.up(key)` re-arms the edge (and, for PTT, returns the falling edge).
 */

// ---------------------------------------------------------------------------
// The desktop intent union (§7.22). Distinct from controllers.ts `Intent` (the
// VR gamepad snapshot union) — this is the keyboard-command surface.
// ---------------------------------------------------------------------------

/** One of the four desktop camera modes (mirrors cameras.ts CameraMode). */
export type DesktopCameraMode = 'orbit' | 'fly' | 'follow' | 'auto';

/** The action a §7.22 keypress maps to, or null for an unbound key. */
export type DesktopIntent =
  | { kind: 'spawn' } // T — net-new spawn alongside the preserved click-spawn
  | { kind: 'recolor' } // C — AS-BUILT Phase A intent (regression pin)
  | { kind: 'rendermode' } // V — AS-BUILT Phase A intent (regression pin)
  | { kind: 'camera'; mode: DesktopCameraMode } // 1–4
  | { kind: 'followNext' } // Tab
  | { kind: 'ballot' } // B
  | { kind: 'ptt'; pressed: boolean } // ` (hold — pressed:true down / false up)
  | { kind: 'mute' } // M
  | { kind: 'help' }; // ?

// ---------------------------------------------------------------------------
// Key normalization + the static binding table.
// ---------------------------------------------------------------------------

/**
 * Normalize a KeyboardEvent.key to a stable map key. Letter bindings are
 * case-insensitive (so Shift+C still recolors); everything else is verbatim.
 * `?` arrives as its own key on US layouts; we accept it directly.
 */
function normalizeKey(key: string): string {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    // Only letters are folded; digits / punctuation stay literal.
    if (lower >= 'a' && lower <= 'z') return lower;
  }
  return key;
}

/** The pure, static binding table — normalized key → intent (PTT down variant). */
function bindingFor(normKey: string): DesktopIntent | null {
  switch (normKey) {
    case 't':
      return { kind: 'spawn' };
    case 'c':
      return { kind: 'recolor' };
    case 'v':
      return { kind: 'rendermode' };
    case '1':
      return { kind: 'camera', mode: 'orbit' };
    case '2':
      return { kind: 'camera', mode: 'fly' };
    case '3':
      return { kind: 'camera', mode: 'follow' };
    case '4':
      return { kind: 'camera', mode: 'auto' };
    case 'Tab':
      return { kind: 'followNext' };
    case 'b':
      return { kind: 'ballot' };
    case '`':
      return { kind: 'ptt', pressed: true };
    case 'm':
      return { kind: 'mute' };
    case '?':
      return { kind: 'help' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// KeymapState — the edge-tracking scratch (once-per-press).
// ---------------------------------------------------------------------------

/**
 * Tracks which bound keys are currently held so a key auto-repeat fires its intent
 * only ONCE per physical press. `up(key)` clears the held flag (re-arming the edge)
 * and, for the PTT key, returns the falling-edge `{ptt, pressed:false}` intent.
 */
export interface KeymapState {
  /** True iff this normalized key is currently held (edge already consumed). */
  isDown(normKey: string): boolean;
  /**
   * Mark a key released. Re-arms its edge. Returns the PTT falling-edge intent for
   * the backtick key (so the caller can stop transmitting on keyup); null otherwise.
   */
  up(key: string): DesktopIntent | null;
}

/** Construct a fresh edge-tracking state. */
export function makeKeymapState(): KeymapState & { _down: Set<string> } {
  const down = new Set<string>();
  return {
    _down: down,
    isDown(normKey: string): boolean {
      return down.has(normKey);
    },
    up(key: string): DesktopIntent | null {
      const norm = normalizeKey(key);
      down.delete(norm);
      // PTT is a HOLD: releasing the backtick emits the falling edge.
      if (norm === '`') return { kind: 'ptt', pressed: false };
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// keymapToIntent — the pure classifier.
// ---------------------------------------------------------------------------

/**
 * Map a keydown `key` (+ edge state) to a §7.22 intent, or null.
 *
 * Edge-triggered: an unbound key is null; a bound key returns its intent on the
 * FIRST observation and null while still held (records the key as down). The
 * caller pairs each keydown with a `state.up(key)` on keyup to re-arm the edge.
 */
export function keymapToIntent(key: string, state: KeymapState): DesktopIntent | null {
  const norm = normalizeKey(key);
  const binding = bindingFor(norm);
  if (!binding) return null; // unbound key
  if (state.isDown(norm)) return null; // held — edge already consumed (fire once)
  // Record the press (mutating the concrete state's Set through the interface).
  (state as unknown as { _down: Set<string> })._down.add(norm);
  return binding;
}
