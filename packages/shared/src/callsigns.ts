// ---------------------------------------------------------------------------
// Callsigns (spec §6.1) — free text NEVER reaches a screen. Every peer gets a
// server-assigned cyberpunk handle ("VOLT-17"); an optional `requestedName` is a
// validated INDEX into CURATED_WORDLIST (validated in C2, never free text).
//
// Format is frozen: /^[A-Z]{3,10}-\d{2,3}$/ — a curated uppercase word, a hyphen,
// then a 2- or 3-digit number. The `DMN-` prefix is RESERVED for synthetic peers
// (§7.17) and is never emitted for humans by construction (no curated word is
// "DMN"). The wordlist is pronounceable by construction (a TTS review criterion,
// §7.15) and denylist-screened.
// ---------------------------------------------------------------------------

/** Radius of the standing world (shared constant; spec §6.1 / §7.4 orbit slots). */
export const WORLD_RADIUS = 20;

/** Reserved prefix for synthetic peers (Daemon Crew, §7.17). Never a human. */
export const DMN_PREFIX = 'DMN-';

/** The frozen callsign format. `generateCallsign` output always matches this. */
export const CALLSIGN_RE = /^[A-Z]{3,10}-\d{2,3}$/;

/**
 * Curated cyberpunk wordlist (≥ 64). Every word is:
 *  - `[A-Z]{3,10}` (fits the callsign word slot),
 *  - pronounceable (a TTS review criterion, §7.15 — no consonant-only tokens),
 *  - denylist-screened (no profanity/slur substrings — the callsign test's
 *    independent DENYLIST tripwire re-verifies this on every run),
 *  - not "DMN" (that prefix is reserved for synthetic peers).
 * Later curation stays additive; never reorder (callers may key on nothing here,
 * but stable ordering keeps golden-style determinism reviewable).
 */
export const CURATED_WORDLIST: readonly string[] = [
  'VOLT', 'NEON', 'CHROME', 'PULSE', 'FLUX', 'HELIX', 'CIPHER', 'VECTOR',
  'PRISM', 'QUARK', 'PHOTON', 'PLASMA', 'COBALT', 'AZURE', 'CRIMSON', 'VIOLET',
  'ONYX', 'JADE', 'AMBER', 'IVORY', 'RAVEN', 'FALCON', 'LYNX', 'VIPER',
  'COMET', 'NOVA', 'PULSAR', 'QUASAR', 'NEBULA', 'ORBIT', 'ZENITH', 'APEX',
  'ECHO', 'DELTA', 'SIGMA', 'OMEGA', 'KILO', 'TANGO', 'BRAVO', 'JULIET',
  'RADAR', 'SONAR', 'LASER', 'MAGNET', 'CIRCUIT', 'MATRIX', 'PIXEL', 'BINARY',
  'GLITCH', 'SPARK', 'EMBER', 'FROST', 'STORM', 'BOLT', 'FLARE', 'BLAZE',
  'RIPPLE', 'CASCADE', 'SUMMIT', 'RIDGE', 'CANYON', 'MESA', 'TUNDRA', 'DELTAS',
  'TALON', 'ATLAS', 'ORACLE', 'PHOENIX', 'HYDRA', 'GRIFFIN', 'SPHINX', 'KRAKEN',
] as const;

/**
 * A tiny type for the injected RNG: a function returning a float in [0, 1),
 * exactly the shape of `Math.random`. C1's tests pass a seeded mulberry32 so the
 * generator is deterministic; production injects a per-room seeded RNG.
 */
export type Rng = () => number;

const MAX_2_DIGIT = 100; // 00–99
const MAX_3_DIGIT = 1000; // 000–999

function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0');
}

/**
 * Build a synthetic-peer callsign in the reserved `DMN-` namespace (§7.17, C28).
 * `n` is a daemon index; the number is zero-padded to 2 digits (3 past 99) so the
 * result always matches {@link CALLSIGN_RE} (`DMN` is 3 uppercase letters). Daemon
 * callsigns only ever collide with OTHER daemons (a human is NEVER `DMN-`), so a
 * monotonic index suffices — no roster scan. Example: `daemonCallsign(7)` →
 * "DMN-07" (the spec's "DMN-07 ONLINE" banner handle).
 */
export function daemonCallsign(n: number): string {
  const idx = Math.max(0, Math.floor(n));
  const width = idx < MAX_2_DIGIT ? 2 : 3;
  return `${DMN_PREFIX}${pad(idx, width)}`;
}

/** True iff a callsign belongs to the reserved synthetic-peer namespace (§7.17). */
export function isDaemonCallsign(callsign: string): boolean {
  return callsign.startsWith(DMN_PREFIX);
}

/**
 * Generate a unique callsign not present in `taken`.
 *
 * - Deterministic: identical `rng` output + identical `taken` yields the same
 *   result (no Date/Math.random/global state).
 * - Never mutates `taken` (it is a ReadonlySet; the caller records assignments).
 * - Never emits a `DMN-` callsign (no curated word is "DMN").
 * - Format always matches CALLSIGN_RE.
 *
 * Strategy: draw a word + a 2-digit suffix; if taken, escalate the retry count
 * and widen to a 3-digit suffix (spec §6.1 "retry with fresh number, 3-digit
 * fallback"). If the random path keeps colliding (a nearly-saturated room), fall
 * back to a deterministic scan over the full word × number product so the
 * function always terminates with a unique value while the space is not full.
 */
export function generateCallsign(rng: Rng, taken: ReadonlySet<string>): string {
  const words = CURATED_WORDLIST;

  // Phase 1: randomized draws (the common path — determinism preserved via rng).
  const MAX_RANDOM_TRIES = 64;
  for (let i = 0; i < MAX_RANDOM_TRIES; i++) {
    const word = words[Math.floor(rng() * words.length) % words.length];
    // Widen to 3 digits once random 2-digit draws start colliding.
    const wide = i >= 8;
    const range = wide ? MAX_3_DIGIT : MAX_2_DIGIT;
    const width = wide ? 3 : 2;
    const num = Math.floor(rng() * range) % range;
    const cs = `${word}-${pad(num, width)}`;
    if (!taken.has(cs)) return cs;
  }

  // Phase 2: deterministic scan — guarantees a unique value while space remains.
  // Scan 2-digit then 3-digit suffixes across every word, in a fixed order.
  for (let num = 0; num < MAX_2_DIGIT; num++) {
    for (const word of words) {
      const cs = `${word}-${pad(num, 2)}`;
      if (!taken.has(cs)) return cs;
    }
  }
  for (let num = 0; num < MAX_3_DIGIT; num++) {
    for (const word of words) {
      const cs = `${word}-${pad(num, 3)}`;
      if (!taken.has(cs)) return cs;
    }
  }

  // Space exhausted (words × 1100 ≈ 79k combos). Callers cap far below this.
  throw new Error('generateCallsign: callsign space exhausted');
}
