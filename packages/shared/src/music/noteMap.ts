/**
 * noteMap.ts — the PURE Resonora note function (C18, spec §7.8).
 *
 * `noteMap(event)` maps a floor-impact event onto a MUSIC_NOTE:
 *   • pitch    = colorIndex → scale degree (a synthwave minor-pentatonic), plus
 *                an octave offset from the shape SIZE (a bigger shape is a LOWER
 *                note — the bass lands on the big cube);
 *   • timbre   = the shape TYPE recipe index (a stable per-type voice);
 *   • velocity = clamp(impactSpeed) into 1..127 (the C0 `impactSpeed` broadcast
 *                drives loudness — a slam is loud, a tap is quiet-but-audible);
 *   • pan      = position.x mapped into the i8 pan range.
 *
 * DETERMINISTIC: no Date, no Math.random. The same event ALWAYS yields the same
 * note — that is what lets a locally-PREDICTED note and the server ECHO share a
 * `computeNoteId` and dedupe to one audible note. The wire encoding is ALWAYS the
 * C1 Appendix B `MUSIC_NOTE` codec (opcodes.ts) — this module never touches bytes.
 */

import type { ShapeType } from '../types.js';
import { SHAPE_TYPES } from '../constants.js';

/** The input to {@link noteMap}: one floor-impact event (server-authoritative). */
export interface ImpactEvent {
  /** The shape's color index (→ scale degree). Any integer; wrapped into the scale. */
  colorIndex: number;
  /** The shape type (→ timbre recipe). */
  type: ShapeType;
  /** The shape's scale/size (→ octave; bigger = lower). */
  size: number;
  /** The impact speed on the contact tick (C0 broadcast) — drives velocity. */
  impactSpeed: number;
  /** The shape's world x at impact (→ stereo pan). Optional (defaults centered). */
  posX?: number;
}

/** A pure note (the fields that flow into the C1 MUSIC_NOTE codec). */
export interface Note {
  /** MIDI pitch (u8, 0..127). */
  pitch: number;
  /** Timbre recipe index (u8) — the shape type. */
  timbre: number;
  /** Velocity (u8, 1..127) — from impactSpeed. */
  velocity: number;
  /** Stereo pan (i8, -128..127) — from position.x. */
  pan: number;
}

// ---------------------------------------------------------------------------
// The scale — a minor pentatonic (synthwave-leaning), as semitone offsets from
// the root. 7 CYBER_COLORS map onto these 5 degrees (wrapping into the next
// octave for degrees ≥ 5) so every color has a distinct, in-key pitch.
// ---------------------------------------------------------------------------

/** Minor-pentatonic degrees (semitones from the root), extended so 7 colors differ. */
const SCALE_DEGREES: readonly number[] = [0, 3, 5, 7, 10, 12, 15];

/** The root MIDI note at the reference octave (C4 = 60 is the mid-register anchor). */
const ROOT_MIDI = 48; // C3 — leaves headroom to move up/down an octave with size.

/** Semitones per octave. */
const OCTAVE = 12;

/**
 * Size → octave offset (semitones). Bigger shape ⇒ LOWER note (spec: "octave =
 * size", bass on the big). Bucketed so the mapping is stable and legible:
 *   size ≤ 0.75  → +1 octave (small = high)
 *   size ≤ 1.5   →  0
 *   size ≤ 2.5   → −1 octave
 *   else         → −2 octaves (the biggest = deep bass)
 */
function octaveOffsetForSize(size: number): number {
  const s = Number.isFinite(size) ? size : 1;
  if (s <= 0.75) return +OCTAVE;
  if (s <= 1.5) return 0;
  if (s <= 2.5) return -OCTAVE;
  return -2 * OCTAVE;
}

/** Clamp a raw impactSpeed to a u8 velocity in 1..127 (a tap is audible; a slam saturates). */
export function clampVelocity(impactSpeed: number): number {
  if (!Number.isFinite(impactSpeed)) return 1;
  // Map a plausible impact-speed range (~0..12 m/s) onto 1..127 with a floor of 1.
  const SCALE = 127 / 12;
  const v = Math.round(impactSpeed * SCALE);
  if (v < 1) return 1;
  if (v > 127) return 127;
  return v;
}

/** Clamp a raw world-x to the i8 pan range (-128..127). ±100 world units → full pan. */
export function clampPan(posX: number): number {
  if (!Number.isFinite(posX)) return 0;
  const PAN_RANGE = 100; // world units at which pan saturates
  // Asymmetric scale so the full signed i8 range is reachable: +100 → +127,
  // -100 → -128 (i8 is [-128, 127]).
  const scale = posX < 0 ? 128 : 127;
  const p = Math.round((posX / PAN_RANGE) * scale);
  if (p > 127) return 127;
  if (p < -128) return -128;
  return p;
}

/** The timbre recipe index for a shape type (its position in SHAPE_TYPES; unknown → 0). */
export function timbreForType(type: ShapeType): number {
  const i = SHAPE_TYPES.indexOf(type);
  return i < 0 ? 0 : i;
}

/**
 * Map one floor-impact event to a pure {@link Note}. Deterministic — the whole
 * feature's predict/echo dedupe rests on this being a pure function.
 */
export function noteMap(event: ImpactEvent): Note {
  // pitch: colorIndex → scale degree, offset by the size octave.
  const ci = Math.abs(Math.trunc(Number.isFinite(event.colorIndex) ? event.colorIndex : 0));
  const degree = SCALE_DEGREES[ci % SCALE_DEGREES.length];
  let pitch = ROOT_MIDI + degree + octaveOffsetForSize(event.size);
  if (pitch < 0) pitch = 0;
  if (pitch > 127) pitch = 127;

  return {
    pitch,
    timbre: timbreForType(event.type),
    velocity: clampVelocity(event.impactSpeed),
    pan: clampPan(event.posX ?? 0),
  };
}

// ---------------------------------------------------------------------------
// computeNoteId — the deterministic dedupe key (u32).
//
// A predicted note and the server echo carry the SAME noteId iff they describe
// the SAME player striking on the SAME 16th grid slot with the SAME pitch class.
// Pure hash (FNV-1a over the composed key) → a u32. No Date/RNG.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of a string → u32. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The deterministic noteId for a note struck by `playerId` on 16th-grid slot
 * `sixteenthIndex` with color/pitch key `pitchKey`. The client PREDICTS this id
 * immediately; the server ECHO carries the same id → the synth dedupes to ONE
 * audible note. u32 (fits the Appendix B `noteId` field).
 */
export function computeNoteId(
  playerId: string,
  sixteenthIndex: number,
  pitchKey: number
): number {
  return fnv1a(`${playerId}|${sixteenthIndex >>> 0}|${pitchKey | 0}`);
}
