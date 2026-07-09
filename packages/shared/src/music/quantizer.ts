/**
 * quantizer.ts — the PURE Resonora 16th-grid quantizer (C18, spec §7.8).
 *
 * `quantizeNote(eventTime, clock, p95OneWayDelayMs)` schedules an impact's note on
 * the beat grid using ADAPTIVE lookahead (a fixed 1-beat lookahead kills causality
 * — spec §7.8):
 *
 *   earliest audible = eventTime + client p95 one-way delay + QUANTIZER_MARGIN_MS
 *   playAt           = the FIRST 16th grid line ≥ earliest
 *
 * plus a BACKWARD-SNAP (≤ 60 ms): if `earliest` only just missed a grid line
 * (the line it passed is within {@link BACKWARD_SNAP_MS}), schedule the note ON
 * that missed line instead of waiting a whole 16th — this halves the worst-case
 * delay (spec §7.8). Notes are only ever snapped backward when the resulting time
 * is still in the future relative to the event (it always is: the line ≤ earliest
 * but earliest > eventTime by the p95 + margin).
 *
 * DETERMINISTIC: no Date, no Math.random — a function of its arguments only.
 * `playAt` is a logical/server time (ms); the caller adds/uses the grid origin.
 */

import { nextSixteenthMs, sixteenthMs, type BeatClockConfig } from './beatClock.js';

/** The safety margin (ms) added on top of the client p95 one-way delay. */
export const QUANTIZER_MARGIN_MS = 20;

/**
 * The backward-snap window (ms): if the earliest-audible bound sits within this
 * many ms PAST a grid line, the note snaps back ONTO that line (halving the
 * worst-case delay). ≤ 60 ms per spec §7.8.
 */
export const BACKWARD_SNAP_MS = 60;

/** The clock state the quantizer needs (bpm + grid origin). */
export interface QuantizerClock {
  bpm: number;
  gridOriginMs: number;
}

/** The result of quantizing one note. */
export interface QuantizedNote {
  /** The scheduled play time (ms, same time-base as `eventTime`/gridOrigin). */
  playAtMs: number;
  /** True iff the backward-snap fired (the note landed on a just-missed line). */
  snappedBackward: boolean;
}

/**
 * Quantize an impact `eventTime` to the next 16th grid line, accounting for the
 * client's p95 one-way delay (so the note is still in flight when it fires) with
 * a backward-snap for a note that only just missed a line.
 */
export function quantizeNote(
  eventTime: number,
  clock: QuantizerClock,
  p95OneWayDelayMs: number
): QuantizedNote {
  const cfg: BeatClockConfig = { bpm: clock.bpm, originMs: clock.gridOriginMs };
  const per = sixteenthMs(clock.bpm);

  const p95 = Number.isFinite(p95OneWayDelayMs) && p95OneWayDelayMs > 0 ? p95OneWayDelayMs : 0;
  const earliest = eventTime + p95 + QUANTIZER_MARGIN_MS;

  // The first grid line at or after `earliest`.
  const forwardLine = nextSixteenthMs(cfg, earliest);

  // The grid line immediately BEFORE `forwardLine` (the one we just missed).
  const missedLine = forwardLine - per;
  const missBy = earliest - missedLine; // how far past that line `earliest` is

  // Backward-snap: if the miss is within the window AND the missed line is still
  // strictly after the event (so the note never fires in the past relative to the
  // impact), land ON the missed line.
  if (missBy > 0 && missBy <= BACKWARD_SNAP_MS && missedLine > eventTime) {
    return { playAtMs: missedLine, snappedBackward: true };
  }

  return { playAtMs: forwardLine, snappedBackward: false };
}
