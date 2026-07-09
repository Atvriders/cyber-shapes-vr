/**
 * stage/replay.ts — F11 Chrono Snap: the THIN stage adapter (C21, spec §7.11).
 *
 * The pure ~30 s ring buffer, micro-resim, replay player, and the single-source
 * highlight scorer all live in `@cyber-shapes/shared` (replay.ts + stageBrain.ts).
 * This adapter is the three-free glue that:
 *   • feeds inbound `state` frames + the ENV_STATE dial flag into the ring;
 *   • tracks a rolling window of RoomEvents for the SHARED highlight scorer so the
 *     primary hotkey can "replay the last SCORED highlight" (min-activity gated —
 *     staff can never air 6 s of idle bobbing);
 *   • runs the replay FLOW state machine: live (bloom-free ≤ 480p inset owned by
 *     render.ts) → 0.25× replay through the FROZEN interpolator with micro-resim
 *     of free-flight segments + the oversized "REPLAY // T-…s" chrome (must-ship)
 *     → 6 s auto-return + a stinger hook → cooldown;
 *   • gates the "RE-SIMULATED, NOT RECORDED" flex line on §14 (overlays'
 *     flex-claim grant) AND suppresses it whenever the window ran under an active
 *     dial (only a free-flight, dial-free segment claims resim);
 *   • NAMESPACES every replay entity id (never collides with a live shape).
 *
 * The 0.25× camera spring-orbit + the ≤ 480p bloom-free PiP inset are render.ts
 * concerns (manual-verify); this module owns the deterministic, testable control.
 */

import {
  ReplayRing,
  ReplayPlayer,
  scoreHighlight,
  namespaceReplayId,
  DEFAULT_PARAMS,
  type ReplaySample,
  type ReplayKeyframeBody,
  type Highlight,
  type RoomEvent,
  type ServerMsg,
  type PhysicsParams,
} from '@cyber-shapes/shared';
// The FROZEN interpolator (C0 Step 3) is the CLIENT render-side module — replay
// reuses it (never extends it) so live play and replay share ONE interpolation
// code path (spec §7.11).
import {
  createInterpolator,
  type Interpolator,
  type StateSource,
  type StateFrame,
} from '../net/interpolation.js';
import { serverMsgToRoomEvent } from './stage.js';
import type { StageOverlays } from './overlays.js';

/** How long a replay airs before it auto-returns to live (spec §7.11 "6 s"). */
export const REPLAY_AUTO_RETURN_MS = 6_000;

/** A cooldown after a replay so the stage can't strobe replay-after-replay. */
export const REPLAY_COOLDOWN_MS = 8_000;

/** The window (ms) the "replay last scored highlight" hotkey scores + airs. */
export const REPLAY_HIGHLIGHT_WINDOW_MS = 6_000;

/** The min-activity gate: a highlight must clear this score to be aired. */
export const REPLAY_MIN_ACTIVITY = 6;

export interface StageReplayOpts {
  overlays: StageOverlays;
  /** Injected clock (ms). Defaults to performance.now. */
  now?: () => number;
  /** Optional stinger hook fired on auto-return (audio garnish; render/audio owns it). */
  onStinger?: () => void;
}

/** The replay flow phases. */
type ReplayPhase = 'live' | 'airing' | 'cooldown';

/**
 * The thin stage replay controller. Deterministic given its injected clock; no
 * three, no DOM beyond the injected {@link StageOverlays}.
 */
export class StageReplay {
  private readonly overlays: StageOverlays;
  private readonly now: () => number;
  private readonly onStinger: (() => void) | null;

  /** The ~30 s ring of recorded state frames + dial flags + ~1 s keyframes. */
  private readonly ring = new ReplayRing();

  /** The current effective PhysicsParams (from the latest ENV_STATE), for dial gating. */
  private params: PhysicsParams = DEFAULT_PARAMS;
  private dialActive = false;

  /** The last-known authoritative body per shape (the resim keyframe seed). */
  private readonly bodies = new Map<string, ReplayKeyframeBody>();

  /** A rolling window of scored RoomEvents: {wallTime, event} (for the scorer). */
  private events: Array<{ wall: number; ev: RoomEvent }> = [];

  private phase: ReplayPhase = 'live';
  private player: ReplayPlayer | null = null;
  /**
   * Ms remaining in the current phase (airing → auto-return; cooldown → refire
   * lockout). Counted down by `update(dtMs)` so the flow is driven by the render
   * delta, not the wall clock (deterministic under a fake/injected clock).
   */
  private phaseRemainingMs = 0;
  /** Whether the CURRENT replay is claiming resim (free-flight, dial-free). */
  private claimResim = false;

  /** The FROZEN interpolator, source-fed from the replay player during airing. */
  private readonly replaySource: PushStateSource;
  private readonly interpolator: Interpolator;

  constructor(opts: StageReplayOpts) {
    this.overlays = opts.overlays;
    this.now = opts.now ?? (() => performance.now());
    this.onStinger = opts.onStinger ?? null;
    // Reuse the FROZEN createInterpolator (never extend it) with a push source:
    // the replay player pushes 0.25× frames through the SAME interpolation path
    // live play uses, so replay and live share one code path (§7.11 / C0).
    this.replaySource = new PushStateSource();
    this.interpolator = createInterpolator({ source: this.replaySource, now: this.now });
  }

  // -------------------------------------------------------------------------
  // Ingest — feed inbound ServerMsgs into the ring + the scorer window.
  // -------------------------------------------------------------------------

  /** Apply one decoded ServerMsg: update the ring, dial flag, and scorer window. */
  ingest(msg: ServerMsg): void {
    const wall = this.now();

    // ENV_STATE → the effective params + the active-dial flag for gating.
    if (msg.t === 'env-state') {
      this.params = msg.params ?? DEFAULT_PARAMS;
      this.dialActive = isDialMode(msg);
      return;
    }

    // Track authoritative bodies for the resim keyframe seed: a release carries
    // the server-computed final {pos, vel} (accommodation #5); a state carries
    // per-shape {p, v}; a spawn carries the full body.
    if (msg.t === 'spawn') {
      this.bodies.set(msg.shape.id, bodyFromNetShape(msg.shape));
    } else if (msg.t === 'despawn') {
      this.bodies.delete(msg.id);
    } else if (msg.t === 'grab') {
      const b = this.bodies.get(msg.id);
      if (b) {
        if (msg.peerId === null) {
          b.grabbedBy = null;
          if (msg.pos) b.position = { ...msg.pos };
          if (msg.vel) b.velocity = { ...msg.vel };
        } else {
          b.grabbedBy = msg.peerId;
        }
      }
    }

    // state → push samples into the ring (with the current dial flag + keyframes).
    if (msg.t === 'state') {
      const samples: ReplaySample[] = msg.shapes.map((s) => ({
        tick: msg.serverTick,
        id: s.id,
        p: { ...s.p },
        r: { ...s.r },
        v: { ...s.v },
        ...(s.s !== undefined ? { s: s.s } : {}),
      }));
      // Keep the last-known body {position, velocity} current for the seed.
      for (const s of msg.shapes) {
        const b = this.bodies.get(s.id);
        if (b && b.grabbedBy === null) {
          b.position = { ...s.p };
          b.velocity = { ...s.v };
        }
      }
      // Snapshot the current bodies as keyframes (the ring rate-limits to ~1 s).
      const keyframes: Record<string, ReplayKeyframeBody> = {};
      for (const s of msg.shapes) {
        const b = this.bodies.get(s.id);
        keyframes[s.id] = b
          ? cloneKeyframe(b)
          : { id: s.id, type: 'cube', scale: 1, position: { ...s.p }, velocity: { ...s.v }, grabbedBy: null };
      }
      this.ring.pushState(wall, samples, this.params, this.dialActive, keyframes);

      // Emit an `impact` RoomEvent for each shape that struck the floor this tick.
      for (const s of msg.shapes) {
        if (s.s !== undefined && s.s > 0) this.pushEvent(wall, { kind: 'impact', id: s.id, speed: s.s });
      }
    }

    // Feed the shared scorer window (release/spawn/grab/grab-rejected/…).
    const ev = serverMsgToRoomEvent(msg);
    if (ev) this.pushEvent(wall, ev);
    // grab-rejected has no RoomEvent mapping in the shot adapter — add it here so
    // the scorer can gate GRAB_DUEL (spec §7.11).
    if (msg.t === 'grab-rejected') {
      this.pushEvent(wall, { kind: 'grab-rejected', id: msg.id, peerId: msg.peerId, by: msg.by });
    }
  }

  private pushEvent(wall: number, ev: RoomEvent): void {
    this.events.push({ wall, ev });
    // Evict events older than the ring window (bounded memory).
    const cutoff = wall - REPLAY_HIGHLIGHT_WINDOW_MS * 6;
    if (this.events.length > 0 && this.events[0].wall < cutoff) {
      this.events = this.events.filter((e) => e.wall >= cutoff);
    }
  }

  // -------------------------------------------------------------------------
  // Replay flow.
  // -------------------------------------------------------------------------

  /** True while a replay is on screen. */
  isAiring(): boolean {
    return this.phase === 'airing';
  }

  /** True iff the CURRENT replay claims resim (free-flight, dial-free). */
  claimingResim(): boolean {
    return this.claimResim;
  }

  /** The retained ring span in ms. */
  ringSpanMs(): number {
    return this.ring.spanMs();
  }

  /** The NAMESPACED replay entity ids the render layer should spawn (never live ids). */
  replayEntityIds(): string[] {
    return this.player ? this.player.namespacedIds() : [];
  }

  /**
   * PRIMARY hotkey: "replay the last SCORED highlight." Scores the trailing
   * window with the SHARED scorer; if it clears the min-activity floor AND the
   * flow is idle (not airing / not cooling down), airs the replay. Returns
   * whether a replay was aired.
   */
  replayLastHighlight(): boolean {
    if (this.phase !== 'live') return false;
    const now = this.now();
    const window = this.events.filter((e) => e.wall >= now - REPLAY_HIGHLIGHT_WINDOW_MS).map((e) => e.ev);
    const best = scoreHighlight(window, { minActivitySpeed: REPLAY_MIN_ACTIVITY });
    if (!best || best.score < REPLAY_MIN_ACTIVITY) return false;
    return this.air(REPLAY_HIGHLIGHT_WINDOW_MS, best);
  }

  /**
   * SECONDARY: raw "replay the last N ms" (no highlight scoring). Still refused
   * while airing/cooling down. Returns whether a replay was aired.
   */
  replayLast(windowMs: number): boolean {
    if (this.phase !== 'live') return false;
    return this.air(windowMs, null);
  }

  /** Air a replay of the last `windowMs`. Returns false if the window is empty. */
  private air(windowMs: number, highlight: Highlight | null): boolean {
    const segment = this.ring.extractLast(windowMs);
    if (segment.samples.length === 0) return false;

    const player = new ReplayPlayer(segment);
    this.player = player;
    this.phase = 'airing';
    this.phaseRemainingMs = REPLAY_AUTO_RETURN_MS;

    // Resim claim: ONLY a fully free-flight, dial-free window claims it (the
    // player reports resimulated=true only then). §14: the line renders only if
    // the flex-claim grant is present.
    this.claimResim = player.resimulated && !segment.dialActive;

    // Seed the interpolator with the replay entities' namespaced ids so live and
    // replay never collide, then push the first frame.
    this.interpolator.clear();
    this.pushReplayFrame();

    // Oversized "REPLAY // T-…s" chrome (must-ship) on the highest-priority slot.
    this.renderChrome(REPLAY_AUTO_RETURN_MS, highlight);
    return true;
  }

  /**
   * Advance the flow by `dtMs` of real wall time. Advances the player (0.25×),
   * pushes the interpolated replay frame, refreshes the countdown chrome, and
   * handles auto-return + the stinger + the cooldown.
   */
  update(dtMs: number): void {
    if (this.phase === 'airing' && this.player) {
      this.player.advance(dtMs);
      this.pushReplayFrame();
      this.phaseRemainingMs -= dtMs;
      const remaining = Math.max(0, this.phaseRemainingMs);
      this.renderChrome(remaining, null, /*refresh*/ true);
      if (this.phaseRemainingMs <= 0 || this.player.finished) {
        this.finishReplay();
      }
    } else if (this.phase === 'cooldown') {
      this.phaseRemainingMs -= dtMs;
      if (this.phaseRemainingMs <= 0) this.phase = 'live';
    }
  }

  /** End the replay: clear chrome, fire the stinger, enter cooldown. */
  private finishReplay(): void {
    this.overlays.clearSlot('replay');
    this.player = null;
    this.claimResim = false;
    this.interpolator.clear();
    this.onStinger?.();
    this.phase = 'cooldown';
    this.phaseRemainingMs = REPLAY_COOLDOWN_MS;
  }

  /** Push the player's current poses through the FROZEN interpolator (0.25× frame). */
  private pushReplayFrame(): void {
    if (!this.player) return;
    const poses = this.player.poses(); // namespaced ids
    const frame: StateFrame = { shapes: poses.map((p) => ({ id: p.id, p: p.pose.p, r: p.pose.r })) };
    this.replaySource.emit(frame);
  }

  /**
   * Sample the interpolated replay pose for a NAMESPACED entity id at `renderTime`
   * (the render layer draws the replay scene from these). Reuses the frozen
   * interpolator — live and replay share one interpolation path.
   */
  sampleReplay(namespacedId: string, renderTime: number): { p: { x: number; y: number; z: number }; r: { x: number; y: number; z: number } } | null {
    return this.interpolator.sample(namespacedId, renderTime);
  }

  /** Render the oversized replay chrome + the §14-gated resim line. */
  private renderChrome(remainingMs: number, highlight: Highlight | null, refresh = false): void {
    const secs = (remainingMs / 1000).toFixed(1);
    let line = `REPLAY // T-${secs}s`;
    // §14: the "RE-SIMULATED, NOT RECORDED" claim renders ONLY when granted AND
    // the window is a free-flight, dial-free resim (never a false claim).
    if (this.claimResim && this.overlays.flexClaimsGranted) {
      line += '  ·  RE-SIMULATED, NOT RECORDED';
    }
    if (!refresh && highlight) {
      // Label the highlight kind as a subtle tag (ambient — never load-bearing).
      line += `  ·  ${highlightTag(highlight.kind)}`;
    }
    this.overlays.setReplayChrome(line);
  }
}

// ---------------------------------------------------------------------------
// PushStateSource — a StateSource whose frames are pushed imperatively (the
// replay player is the producer). The FROZEN createInterpolator consumes it, so
// the replay path reuses the SAME interpolation code as the live socket adapter.
// ---------------------------------------------------------------------------

class PushStateSource implements StateSource {
  private cb: ((frame: StateFrame) => void) | null = null;
  onState(cb: (frame: StateFrame) => void): () => void {
    this.cb = cb;
    return () => {
      this.cb = null;
    };
  }
  emit(frame: StateFrame): void {
    this.cb?.(frame);
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** True iff an ENV_STATE marks an ACTIVE non-default dial (suppresses resim). */
function isDialMode(msg: Extract<ServerMsg, { t: 'env-state' }>): boolean {
  // A named mode OR a non-default param envelope both mean a dial is live.
  if (msg.mode) return true;
  const p = msg.params;
  if (!p) return false;
  if (p.freeze === true) return true;
  if (p.timescale !== undefined && p.timescale !== 1) return true;
  if (p.suspendDespawn === true) return true;
  if (p.attractors && p.attractors.length > 0) return true;
  if (p.wind && (p.wind.x !== 0 || p.wind.y !== 0 || p.wind.z !== 0)) return true;
  return false;
}

function bodyFromNetShape(s: {
  id: string;
  type: import('@cyber-shapes/shared').ShapeType;
  scale: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  grabbedBy: string | null;
}): ReplayKeyframeBody {
  return {
    id: s.id,
    type: s.type,
    scale: s.scale,
    position: { ...s.position },
    velocity: { ...s.velocity },
    grabbedBy: s.grabbedBy,
  };
}

function cloneKeyframe(k: ReplayKeyframeBody): ReplayKeyframeBody {
  return { ...k, position: { ...k.position }, velocity: { ...k.velocity } };
}

function highlightTag(kind: Highlight['kind']): string {
  switch (kind) {
    case 'SLAM':
      return 'FLOOR SLAM';
    case 'THROW':
      return 'LONG ARC';
    case 'SHAPE_RAIN':
      return 'SHAPE RAIN';
    case 'GRAB_DUEL':
      return 'GRAB DUEL';
  }
}

// Re-export the namespacing helper for the render layer.
export { namespaceReplayId };
