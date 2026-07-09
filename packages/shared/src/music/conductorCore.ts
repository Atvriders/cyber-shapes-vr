/**
 * conductorCore.ts — the PURE Resonora conductor core (C18, spec §7.8).
 *
 * The server Conductor (packages/server/src/conductor.ts) is the stateful host;
 * THIS module is the pure, deterministic math it (and the client backing renderer)
 * share:
 *
 *   • backingBar(roomSeed, beatIndex, histogram) — the DETERMINISTIC generative
 *     backing layer. Seeded ONLY from (roomSeed, beatIndex, activity histogram),
 *     it is IDENTICAL on every client for the same seed → zero MUSIC_NOTE traffic;
 *     each client renders the same bar locally. This is the determinism keystone.
 *   • intensityGovernor(histogram) — the auto-intensity governor: a 0..1 density
 *     that is MONOTONIC (non-decreasing) with activity, with a small idle floor
 *     (the mellow attract groove) — never silence, never > 1.
 *   • applyNoteBudget(events) — per-player note-rate budget: truncates a burst
 *     (a 50-impact flood) to a fair per-player cap so one spammer can't drown the
 *     mix or starve a second player.
 *   • splitRole(type) — the drum/melody role split by shape type.
 *
 * DETERMINISTIC: no Date, no Math.random. A seeded PRNG (mulberry32, the same one
 * used across the shared package) drives the backing layer.
 */

import type { ShapeType } from '../types.js';
import { SHAPE_TYPES } from '../constants.js';
import { SIXTEENTHS_PER_BEAT } from './beatClock.js';

/** A coarse activity histogram the conductor recomputes each window. */
export interface ActivityHistogram {
  /** Floor impacts observed in the recent window. */
  impactsInWindow: number;
  /** Distinct players active in the window. */
  activePlayers: number;
}

// ---------------------------------------------------------------------------
// mulberry32 — the shared seeded PRNG (identical to physicsCore/callsigns).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// intensityGovernor — density scales monotonically with activity (0..1).
// ---------------------------------------------------------------------------

/** The idle groove floor — a mellow attract groove is never silent. */
export const IDLE_INTENSITY_FLOOR = 0.15;

/** The impact count at which the governor saturates toward 1. */
const INTENSITY_SATURATION_IMPACTS = 30;

/**
 * Map an activity histogram to a 0..1 intensity. Monotonic non-decreasing in
 * `impactsInWindow` (more activity → denser mix), bounded to [floor, 1], with a
 * non-zero idle floor. Deterministic.
 */
export function intensityGovernor(h: ActivityHistogram): number {
  const impacts = Number.isFinite(h.impactsInWindow) ? Math.max(0, h.impactsInWindow) : 0;
  // A saturating curve: floor + (1 - floor) * (impacts / (impacts + K)).
  const frac = impacts / (impacts + INTENSITY_SATURATION_IMPACTS);
  const i = IDLE_INTENSITY_FLOOR + (1 - IDLE_INTENSITY_FLOOR) * frac;
  return i > 1 ? 1 : i;
}

// ---------------------------------------------------------------------------
// backingBar — the deterministic generative backing layer.
// ---------------------------------------------------------------------------

/** One backing note the client renders locally (never sent on the wire). */
export interface BackingNote {
  /** MIDI pitch. */
  pitch: number;
  /** Offset from the bar start, in 16th notes (0..15 within a 4/4 bar). */
  offsetSixteenths: number;
  /** Velocity (1..127). */
  velocity: number;
}

/** A backing bar = the notes to render for one bar. */
export interface BackingBar {
  notes: BackingNote[];
}

/** The backing layer's minor-pentatonic bass/pad degrees (semitones from root). */
const BACKING_DEGREES: readonly number[] = [0, 3, 5, 7, 10];
/** The backing root MIDI note (a low pad register). */
const BACKING_ROOT = 36; // C2 — sits below the impact melody.
/** 16th notes per 4/4 bar. */
const SIXTEENTHS_PER_BAR = SIXTEENTHS_PER_BEAT * 4;

/**
 * Compute the deterministic backing bar for `beatIndex` in a room seeded by
 * `roomSeed`, modulated by the activity `histogram`. IDENTICAL across clients for
 * the same (roomSeed, beatIndex, histogram) — the determinism keystone. The PRNG
 * seed folds all three inputs so the bar varies with the seed AND the bar
 * position AND the current intensity, but is otherwise fully reproducible.
 */
export function backingBar(
  roomSeed: number,
  beatIndex: number,
  histogram: ActivityHistogram
): BackingBar {
  // Fold (seed, beatIndex, intensity bucket) into one 32-bit PRNG seed.
  const intensity = intensityGovernor(histogram);
  const intensityBucket = Math.round(intensity * 8); // 0..8 — coarse, stable
  const bar = Math.floor((beatIndex >>> 0) / 4); // which bar this beat is in
  let seed = roomSeed >>> 0;
  seed = (Math.imul(seed, 0x01000193) ^ (bar >>> 0)) >>> 0;
  seed = (Math.imul(seed, 0x01000193) ^ intensityBucket) >>> 0;
  const rng = mulberry32(seed);

  // Denser bars at higher intensity: 2 notes at idle → up to ~6 when busy.
  const noteCount = 2 + Math.round(intensity * 4);
  const notes: BackingNote[] = [];
  for (let i = 0; i < noteCount; i++) {
    const degree = BACKING_DEGREES[Math.floor(rng() * BACKING_DEGREES.length)];
    const octave = rng() < 0.25 ? 12 : 0; // occasional octave-up pad
    const offset = Math.floor(rng() * SIXTEENTHS_PER_BAR);
    const velocity = 40 + Math.floor(rng() * 40); // soft pad, 40..79
    notes.push({ pitch: BACKING_ROOT + degree + octave, offsetSixteenths: offset, velocity });
  }
  // Sort by offset for a stable, comparable ordering across clients.
  notes.sort((a, b) => a.offsetSixteenths - b.offsetSixteenths || a.pitch - b.pitch);
  return { notes };
}

// ---------------------------------------------------------------------------
// applyNoteBudget — per-player note-rate budget (truncate a burst).
// ---------------------------------------------------------------------------

/** One candidate note (before budgeting) — the fields the budget needs. */
export interface BudgetCandidate {
  playerId: string;
  /** The 16th-grid slot this note would land on. */
  sixteenthIndex: number;
}

/**
 * The per-player budget: at most this many notes per player per budgeting call.
 * A 50-impact single-player burst is truncated to this; a second player is never
 * starved because the cap is PER PLAYER.
 */
export const PER_PLAYER_NOTE_BUDGET = 8;

/**
 * Apply the per-player note budget to a batch of candidate notes. For each
 * player, keep only the first {@link PER_PLAYER_NOTE_BUDGET} notes (in stable,
 * deterministic input order). Different players' budgets are independent (fair).
 * Deterministic — no Date/RNG.
 */
export function applyNoteBudget<T extends BudgetCandidate>(events: readonly T[]): T[] {
  const perPlayer = new Map<string, number>();
  const kept: T[] = [];
  for (const e of events) {
    const n = perPlayer.get(e.playerId) ?? 0;
    if (n >= PER_PLAYER_NOTE_BUDGET) continue;
    perPlayer.set(e.playerId, n + 1);
    kept.push(e);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// splitRole — drum vs melody by shape type (pure, tested).
// ---------------------------------------------------------------------------

/** A note's role in the mix. */
export type NoteRole = 'drum' | 'melody';

/**
 * The drum/melody role split by shape TYPE (spec §7.8). Angular/compact shapes
 * (cube, octahedron, tetrahedron, cylinder) are PERCUSSION; rounded/complex
 * shapes (sphere, torus, torusKnot, icosahedron, dodecahedron, cone) are MELODY.
 * Stable per type; both roles are always represented.
 */
const DRUM_TYPES: ReadonlySet<ShapeType> = new Set<ShapeType>([
  'cube',
  'octahedron',
  'tetrahedron',
  'cylinder',
]);

export function splitRole(type: ShapeType): NoteRole {
  // Guard an unknown type (defensive — SHAPE_TYPES is the source of truth).
  if (!SHAPE_TYPES.includes(type)) return 'melody';
  return DRUM_TYPES.has(type) ? 'drum' : 'melody';
}
