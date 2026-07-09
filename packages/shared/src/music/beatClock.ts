/**
 * beatClock.ts — the PURE logical-BPM beat clock (C13, spec §7.8/§7.9/§7.10).
 *
 * Created HERE for the F10 attract choreography (the theme synth's drone + loop
 * are driven off its beat); C18 (Resonora) EXTENDS this with the quantizer grid.
 *
 * Determinism is the whole point: beat/bar are a pure function of (bpm, origin,
 * logical time) — NO Date, NO performance.now, NO Math.random. The same inputs
 * always yield the same beat, so every client's attract loop (and, later, the
 * Resonora generative layer seeded from the beat index) stays in lockstep.
 */

/** Beat-clock configuration. `beatsPerBar` defaults to 4 (4/4). */
export interface BeatClockConfig {
  /** Beats per minute (> 0). */
  bpm: number;
  /** Logical-time origin (ms) of beat 0 (e.g. the grid origin / roomEpoch base). */
  originMs: number;
  /** Beats per bar (default 4). */
  beatsPerBar?: number;
}

/** ms per beat for a given BPM. Throws on a non-positive bpm (guards drift). */
export function msPerBeat(bpm: number): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) {
    throw new Error(`beatClock: bpm must be a positive finite number (got ${bpm})`);
  }
  return 60_000 / bpm;
}

/** The (integer) beat index at logical time `nowMs`. Never negative. */
export function beatAt(cfg: BeatClockConfig, nowMs: number): number {
  const per = msPerBeat(cfg.bpm);
  const elapsed = nowMs - cfg.originMs;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / per);
}

/** The (integer) bar index at logical time `nowMs` (beats grouped by beatsPerBar). */
export function barAt(cfg: BeatClockConfig, nowMs: number): number {
  const bpb = cfg.beatsPerBar ?? 4;
  return Math.floor(beatAt(cfg, nowMs) / bpb);
}

/** The fractional position (0..1) WITHIN the current beat at `nowMs`. */
export function phaseInBeat(cfg: BeatClockConfig, nowMs: number): number {
  const per = msPerBeat(cfg.bpm);
  const elapsed = nowMs - cfg.originMs;
  if (elapsed <= 0) return 0;
  const frac = (elapsed % per) / per;
  return frac < 0 ? frac + 1 : frac;
}

// ---------------------------------------------------------------------------
// C18 (Resonora) — the 16th-note grid. The quantizer snaps impact events to the
// nearest 16th; the conductor keys its per-slot noteId + backing layer off the
// integer 16th index. All PURE — a function of (bpm, origin, logical time).
// ---------------------------------------------------------------------------

/** The number of 16th notes per beat (4/4 straight — a beat is 4 sixteenths). */
export const SIXTEENTHS_PER_BEAT = 4;

/** ms per 16th note for a given BPM (a quarter of {@link msPerBeat}). */
export function sixteenthMs(bpm: number): number {
  return msPerBeat(bpm) / SIXTEENTHS_PER_BEAT;
}

/** The (integer) 16th-note index at logical time `nowMs`. Never negative. */
export function sixteenthAt(cfg: BeatClockConfig, nowMs: number): number {
  const per = sixteenthMs(cfg.bpm);
  const elapsed = nowMs - cfg.originMs;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / per);
}

/**
 * The logical time (ms) of the FIRST 16th-note grid line at or after `nowMs`.
 * If `nowMs` sits exactly on a line, that line is returned. Never before origin.
 */
export function nextSixteenthMs(cfg: BeatClockConfig, nowMs: number): number {
  const per = sixteenthMs(cfg.bpm);
  const elapsed = nowMs - cfg.originMs;
  if (elapsed <= 0) return cfg.originMs;
  const idx = Math.ceil(elapsed / per - 1e-9); // tolerance so on-line stays on-line
  return cfg.originMs + idx * per;
}

/** The logical time (ms) of 16th-note line `index` (index ≥ 0). */
export function sixteenthLineMs(cfg: BeatClockConfig, index: number): number {
  return cfg.originMs + Math.max(0, index) * sixteenthMs(cfg.bpm);
}

/**
 * A stateful beat-clock handle bound to an INJECTED time source. `beat()`/`bar()`
 * read the current logical time and report the deterministic index; `setBpm`
 * retunes on a theme change (the origin is preserved so the grid stays coherent).
 * Pure w.r.t. its clock — no internal Date/RNG.
 */
export interface BeatClock {
  beat(): number;
  bar(): number;
  phase(): number;
  setBpm(bpm: number): void;
  /** ms per beat at the current BPM (for scheduling the synth's envelope). */
  msPerBeat(): number;
  readonly config: Readonly<BeatClockConfig>;
}

/** Build a {@link BeatClock} over an injected `now` (ms). Defaults to 120 BPM 4/4. */
export function createBeatClock(
  cfg: BeatClockConfig,
  now: () => number
): BeatClock {
  const state: BeatClockConfig = {
    bpm: cfg.bpm,
    originMs: cfg.originMs,
    beatsPerBar: cfg.beatsPerBar ?? 4,
  };
  // Validate up front so a bad BPM fails at construction, not mid-render.
  msPerBeat(state.bpm);
  return {
    beat: () => beatAt(state, now()),
    bar: () => barAt(state, now()),
    phase: () => phaseInBeat(state, now()),
    setBpm: (bpm: number) => {
      msPerBeat(bpm); // validate
      state.bpm = bpm;
    },
    msPerBeat: () => msPerBeat(state.bpm),
    get config() {
      return state;
    },
  };
}
