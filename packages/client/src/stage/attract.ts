/**
 * attract.ts — the F10 Ghost Arcade attract mode (C13, spec §7.10 / §7.17).
 *
 * When the room goes quiet, the big screen becomes an ATTRACT loop: translucent
 * GHOST replays of real sessions (or, day-one, a scripted shape-ballet) with a
 * giant join QR — "the QR is inviting YOU to replace them" (§7.10). The moment a
 * real human does anything, the ghosts dissolve and the live world resyncs.
 *
 * The LOAD-BEARING invariant (spec §7.17, test-enforced): idle detection is
 * ACTIVITY-BASED over HUMAN intents/poses ONLY. It is NEVER connection count
 * (zombie sockets don't keep it live) and synthetic (daemon) activity is INVISIBLE
 * to it (a daemon-only room still enters attract). This machine therefore tracks
 * "last HUMAN activity" and nothing else for the idle decision — `humanResidents()`
 * is the server-side sibling of the same rule.
 *
 * Ghost replay rides the FROZEN `createInterpolator({source, now})` (C0 Step 3)
 * via {@link reelToStateSource} — a reel becomes a `StateSource` ADAPTER, so live
 * play and replay share ONE interpolation code path (the signature is never
 * extended). Ghosts render at {@link GHOST_OPACITY} with {@link ghostNameplate}
 * (GHOST_XX — never a real name, §6.1). This module is pure orchestration: no
 * THREE, no DOM — testable with an injected clock.
 */

import type { Reel, ReelFrame, Vec3 } from '@cyber-shapes/shared';
import { crossfadeLoopTime } from '@cyber-shapes/shared';
import type { StateFrame, StateSource } from '../net/interpolation.js';

/** How long (ms) of HUMAN silence before attract mode engages (spec §7.10). */
export const IDLE_TIMEOUT_MS = 45_000;

/** Ghost replay opacity — 70 % translucent so they read as recordings (§7.10). */
export const GHOST_OPACITY = 0.7;

/** The crossfade window (ms) the loop blends across the keyframe seam. */
export const LOOP_CROSSFADE_MS = 500;

/** A GHOST_XX nameplate (never a real name — §6.1). Two-digit, zero-padded. */
export function ghostNameplate(index: number): string {
  const n = ((index % 100) + 100) % 100;
  return `GHOST_${String(n).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The pure attract state machine.
// ---------------------------------------------------------------------------

/** Attract phases: LIVE ⇄ ATTRACT, with a brief DISSOLVING handoff on wake. */
export type AttractPhase = 'LIVE' | 'ATTRACT' | 'DISSOLVING';

export interface AttractMachineOpts {
  /** Injected clock (ms). Fake in tests; performance.now in production. */
  now: () => number;
  /** HUMAN-silence timeout before attract engages. Default IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

export class AttractMachine {
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;

  private _phase: AttractPhase = 'LIVE';
  /** Wall time (ms) of the last HUMAN activity — the ONLY idle signal (§7.17). */
  private _lastHumanActivity: number;
  /** Set true when we wake from attract and must `REQUEST_SNAPSHOT` to resync. */
  private _needsResync = false;
  /** Connected socket count — DIAGNOSTIC ONLY; NEVER an idle signal (§7.17). */
  private _connectedCount = 0;
  /** Venue-brightness (high-exposure palette) toggle (spec §7.10). */
  private _venueBright = false;

  constructor(opts: AttractMachineOpts) {
    this.now = opts.now;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this._lastHumanActivity = this.now();
  }

  get phase(): AttractPhase {
    return this._phase;
  }

  get venueBright(): boolean {
    return this._venueBright;
  }

  /**
   * Record a MEANINGFUL HUMAN activity (a real resident's intent/pose/join). This
   * is the ONLY thing that resets the idle timer. While in ATTRACT it also wakes
   * the machine — DISSOLVING the ghosts and flagging a snapshot resync.
   */
  noteHumanActivity(): void {
    this._lastHumanActivity = this.now();
    if (this._phase === 'ATTRACT') {
      this._phase = 'DISSOLVING';
      this._needsResync = true; // resync the live world before showing it
    }
  }

  /**
   * Record a SYNTHETIC (daemon) activity. Explicitly a NO-OP for idle + wake
   * (§7.17): a daemon's intents/poses are invisible to presence, so they neither
   * keep the room live nor dissolve an attract loop. Present as an explicit hook
   * so the caller routes daemon events HERE (and never to noteHumanActivity).
   */
  noteSyntheticActivity(): void {
    // Intentionally empty — synthetic activity never touches the idle timer.
  }

  /** Update the connected-socket count. DIAGNOSTIC ONLY — never an idle input. */
  setConnectedCount(n: number): void {
    this._connectedCount = n;
  }

  get connectedCount(): number {
    return this._connectedCount;
  }

  /** Toggle venue-brightness (high-exposure palette for a bright hall, §7.10). */
  setVenueBright(on: boolean): void {
    this._venueBright = on;
  }

  /** True iff the machine woke from attract and still needs a live resync. */
  needsResync(): boolean {
    return this._needsResync;
  }

  /** Called once the `REQUEST_SNAPSHOT` reply is applied — clears the resync flag. */
  onSnapshotApplied(): void {
    this._needsResync = false;
  }

  /**
   * Advance the machine. LIVE → ATTRACT after idleTimeoutMs of HUMAN silence;
   * DISSOLVING → LIVE once the resync has completed. Idempotent; call each frame.
   */
  tick(): void {
    const t = this.now();
    switch (this._phase) {
      case 'LIVE':
        if (t - this._lastHumanActivity >= this.idleTimeoutMs) {
          this._phase = 'ATTRACT';
        }
        break;
      case 'DISSOLVING':
        if (!this._needsResync) this._phase = 'LIVE';
        break;
      case 'ATTRACT':
        // Stays in attract until noteHumanActivity() wakes it (never on its own).
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// reelToStateSource — feed a reel through the FROZEN interpolator (C0 Step 3).
//
// A reel's coalesced transform frames become `StateFrame`s. The interpolator's
// injected `now` is what the caller drives (deterministic replay), so this
// adapter is a pure PUSH surface: `advanceTo(playHeadMs)` emits every frame up to
// the play head, looping via crossfadeLoopTime at the keyframe boundary. The
// interpolator signature is NOT extended — a reel is just another StateSource.
// ---------------------------------------------------------------------------

/** A reel-backed StateSource + a driver to push its frames on a play head. */
export interface ReelSource extends StateSource {
  /** Push every reel frame whose wallTime ≤ the (looped) play head. */
  advanceTo(playHeadMs: number): void;
  /** The reel's loop duration (ms). */
  readonly durationMs: number;
}

/**
 * Build a {@link ReelSource} over `reel`. `onState` registers the interpolator's
 * ingest callback; `advanceTo` emits the frames due at a play head (wrapping the
 * head into [0, duration) so the attract loop crossfades at the seam). A ghost
 * replay wires this to `createInterpolator({ source, now })` — same code path as
 * live play, per the frozen contract.
 */
export function reelToStateSource(reel: Reel): ReelSource {
  const listeners = new Set<(f: StateFrame) => void>();
  const t0 = reel.frames.length > 0 ? reel.frames[0].wallTime : 0;
  let lastEmittedIndex = -1;

  function emit(frame: ReelFrame): void {
    const stateFrame: StateFrame = {
      shapes: frame.transforms.map((t) => ({ id: t.id, p: t.p, r: t.r })),
    };
    for (const cb of listeners) cb(stateFrame);
  }

  return {
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    durationMs: reel.durationMs,
    advanceTo(playHeadMs: number) {
      const looped = crossfadeLoopTime(playHeadMs, reel.durationMs, LOOP_CROSSFADE_MS);
      // On a wrap (looped < last frame's offset), restart the emission cursor.
      const targetWall = t0 + looped;
      // Detect a loop wrap: if the target moved backwards, reset the cursor.
      if (lastEmittedIndex >= 0 && reel.frames[lastEmittedIndex]?.wallTime > targetWall) {
        lastEmittedIndex = -1;
      }
      for (let i = lastEmittedIndex + 1; i < reel.frames.length; i++) {
        if (reel.frames[i].wallTime > targetWall) break;
        emit(reel.frames[i]);
        lastEmittedIndex = i;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Day-one scripted shape-ballet (works with ZERO reels — spec §7.10 day-one rung).
// ---------------------------------------------------------------------------

/** One ballet shape's pose at a point in time (renderable transform). */
export interface BalletShape {
  id: string;
  position: Vec3;
  rotation: Vec3;
}

/** How many shapes orbit in the scripted ballet. */
const BALLET_SHAPE_COUNT = 6;
/** Ballet orbit radius (m) and period (ms). */
const BALLET_RADIUS = 3;
const BALLET_PERIOD_MS = 12_000;

/**
 * A deterministic scripted shape-ballet for the DAY-ONE rung (before any reels
 * exist). Pure function of logical time: `N` shapes orbit a shared center on
 * phase-offset circles, gently bobbing. No RNG, no Date — identical on every
 * client, so a multi-screen booth stays in sync. Used as the attract visual when
 * the reel bank is empty (spec §7.10 "scripted shape-ballet before any reels").
 */
export function scriptedBallet(nowMs: number): BalletShape[] {
  const shapes: BalletShape[] = [];
  const twoPi = Math.PI * 2;
  const t = (nowMs % BALLET_PERIOD_MS) / BALLET_PERIOD_MS; // 0..1
  for (let i = 0; i < BALLET_SHAPE_COUNT; i++) {
    const phase = (i / BALLET_SHAPE_COUNT) * twoPi;
    const angle = t * twoPi + phase;
    shapes.push({
      id: `ballet-${i}`,
      position: {
        x: Math.cos(angle) * BALLET_RADIUS,
        y: 1.5 + Math.sin(angle * 2 + phase) * 0.5, // gentle vertical bob
        z: Math.sin(angle) * BALLET_RADIUS,
      },
      rotation: { x: 0, y: angle, z: 0 },
    });
  }
  return shapes;
}
