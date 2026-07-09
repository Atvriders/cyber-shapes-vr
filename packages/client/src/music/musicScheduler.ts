/**
 * musicScheduler.ts — the client MUSIC receive → synth scheduler (C22, F8 Resonora).
 *
 * The server Conductor (packages/server/src/conductor.ts) broadcasts the generative
 * synthwave score on binary opcode 0x29 (MUSIC): a ~1 Hz MUSIC_CLOCK (bpm / beat /
 * grid origin — the shared grid) plus one MUSIC_NOTE per scored floor impact
 * (deterministic noteId + a `playAtMs` grid line the quantizer already snapped to,
 * with adaptive lookahead so the note is still IN FLIGHT when it fires). This
 * module is the CLIENT end: it takes the decoded frames (netClient's `onMusic`
 * dispatch) and SCHEDULES each note to fire on the beat.
 *
 * Scheduling is server-time aligned: `playAtMs` is a roomEpoch-relative server
 * time in the SAME base as the C3 clock offset, so a note fires at the local wall-
 * clock instant `playAtMs − offset` (via the shared {@link scheduleAt}). Every
 * client that shares the offset therefore lands the SAME note on the SAME beat —
 * "every impact lands on-beat in a generative synthwave score".
 *
 * NO Web Audio here — the injected {@link NoteSink} (the real {@link ResonoraSynth}
 * in main.ts, a mock in tests) owns the audio graph + the app's single
 * AudioContext. This module is pure scheduling math over an injected TimerApi, so
 * it is unit-testable without a real AudioContext (owner/hardware-verifies sound).
 */

import { scheduleAt, systemTimerApi, type Handle, type TimerApi } from '@cyber-shapes/shared';
import type { PlayNote } from './synth.js';

/**
 * A decoded MUSIC (0x29) frame — the typed union netClient dispatches to `onMusic`.
 * CLOCK carries the shared grid (bpm / beat / origin); NOTE carries one scored
 * impact (the C18 {@link PlayNote} fields).
 */
export type MusicFrame =
  | { kind: 'clock'; bpm: number; beatIndex: number; gridOriginMs: number }
  | {
      kind: 'note';
      noteId: number;
      playAtMs: number;
      pitch: number;
      timbre: number;
      velocity: number;
      pan: number;
    };

/** The minimal synth surface the scheduler drives (the real ResonoraSynth satisfies it). */
export interface NoteSink {
  play(note: PlayNote): boolean;
}

export interface MusicSchedulerOpts {
  /**
   * The current estimated (server − local) clock offset in ms (the C3 syncer's
   * `offsetMs`). Defaults to 0 (unsynced): a note whose grid time then maps into
   * the past is dropped by the 'skip' policy, so Resonora stays silent — never
   * off-beat — until the first CLOCK_PONG lands.
   */
  offsetMs?: () => number;
  /** Injected timer (defaults to systemTimerApi in production; a fake in tests). */
  timerApi?: TimerApi;
  /**
   * Audio gate: return false to DROP scheduling (the gesture-unlock / mute check —
   * main.ts gates on the app AudioContext being 'running'). Defaults to always-on.
   */
  isEnabled?: () => boolean;
  /**
   * Defensive scheduling horizon (ms): a note whose local fire time is further out
   * than this is DROPPED rather than pinning a runaway timer (a corrupt `playAtMs`
   * or an unsynced clock would otherwise arm a timer minutes/hours away). Default
   * 5000 ms — well beyond the quantizer's one-to-two-16th lookahead.
   */
  maxLookaheadMs?: number;
}

const DEFAULT_MAX_LOOKAHEAD_MS = 5000;

/**
 * The client MUSIC scheduler. Feed it decoded MUSIC frames via {@link onFrame}
 * (netClient's `onMusic` dispatch). CLOCK updates the shared grid; NOTE schedules
 * a synth voice on the beat via the server-time-aligned {@link scheduleAt}.
 */
export class MusicScheduler {
  private readonly synth: NoteSink;
  private readonly offsetMs: () => number;
  private readonly timer: TimerApi;
  private readonly isEnabled: () => boolean;
  private readonly maxLookaheadMs: number;

  private _bpm = 0;
  private _beatIndex = 0;
  private _gridOriginMs = 0;
  private _hasClock = false;
  private _scheduledCount = 0;
  /** Pending note handles so a disconnect/teardown can cancel armed timers. */
  private readonly _pending = new Set<Handle>();

  constructor(synth: NoteSink, opts: MusicSchedulerOpts = {}) {
    this.synth = synth;
    this.offsetMs = opts.offsetMs ?? (() => 0);
    this.timer = opts.timerApi ?? systemTimerApi;
    this.isEnabled = opts.isEnabled ?? (() => true);
    this.maxLookaheadMs = opts.maxLookaheadMs ?? DEFAULT_MAX_LOOKAHEAD_MS;
  }

  /** The last MUSIC_CLOCK tempo (BPM); 0 until the first CLOCK frame. */
  get bpm(): number {
    return this._bpm;
  }

  /** The last MUSIC_CLOCK beat index. */
  get beatIndex(): number {
    return this._beatIndex;
  }

  /** The shared grid origin (ms, roomEpoch-relative) from the last CLOCK frame. */
  get gridOriginMs(): number {
    return this._gridOriginMs;
  }

  /** True once at least one MUSIC_CLOCK has been received. */
  get hasClock(): boolean {
    return this._hasClock;
  }

  /** How many notes have been SCHEDULED (armed a timer) — not necessarily fired. */
  get scheduledCount(): number {
    return this._scheduledCount;
  }

  /** Number of note timers currently armed (awaiting their grid line). */
  get pendingCount(): number {
    return this._pending.size;
  }

  /** Dispatch one decoded MUSIC frame (CLOCK updates the grid; NOTE schedules). */
  onFrame(frame: MusicFrame): void {
    if (frame.kind === 'clock') {
      this._bpm = frame.bpm;
      this._beatIndex = frame.beatIndex;
      this._gridOriginMs = frame.gridOriginMs;
      this._hasClock = true;
      return;
    }
    this.scheduleNote(frame);
  }

  /**
   * Schedule one MUSIC_NOTE to fire on its grid line. The note's `playAtMs` is a
   * roomEpoch-relative server time; {@link scheduleAt} maps it to the local wall
   * clock via the current offset and arms a timer. A note already past its line
   * (late, or unsynced clock) is dropped ('skip'); an absurdly-far note is dropped
   * by the lookahead guard.
   */
  private scheduleNote(f: Extract<MusicFrame, { kind: 'note' }>): void {
    if (!this.isEnabled()) return;

    const offset = this.offsetMs();
    const localFire = f.playAtMs - offset;
    const delay = localFire - this.timer.now();
    // Drop a runaway-future note (corrupt playAtMs / unsynced clock) so we never
    // pin a timer minutes away. A past-deadline note is left to scheduleAt's 'skip'.
    if (delay > this.maxLookaheadMs) return;

    const note: PlayNote = {
      noteId: f.noteId,
      playAtMs: f.playAtMs,
      pitch: f.pitch,
      timbre: f.timbre,
      velocity: f.velocity,
      pan: f.pan,
    };

    // 'skip': a note whose grid line already passed is NOT fired (an off-beat late
    // note is worse than silence — the synth dedupes on noteId anyway). scheduleAt
    // returns a no-op handle for the past case; the future case fires asynchronously,
    // by which point `handle` is assigned (never fires synchronously under 'skip').
    const handle: Handle = scheduleAt(
      f.playAtMs,
      offset,
      'skip',
      () => {
        this._pending.delete(handle);
        this.synth.play(note);
      },
      this.timer
    );
    this._pending.add(handle);
    this._scheduledCount++;
  }

  /** Cancel every armed note timer (call on WS disconnect / teardown). */
  clear(): void {
    for (const h of this._pending) h.cancel();
    this._pending.clear();
  }
}
