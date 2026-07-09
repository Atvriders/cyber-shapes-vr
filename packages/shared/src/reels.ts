/**
 * reels.ts — F10 Ghost Arcade reel model (C13, spec §7.10). PURE — no I/O, no
 * Date, no Math.random. Injected time only. Consumed by the server recorder
 * (`recorder.ts` tees into these types) and the client attract replay adapter.
 *
 * A REEL is a recording of a room session replayable through the FROZEN
 * `createInterpolator({source, now})` (C0 Step 3): a `reelToStateSource(...)`
 * adapter feeds a reel's transform frames as `StateFrame`s so live play and
 * replay share ONE interpolation code path (the signature is never extended).
 *
 * The coalescing recorder (spec §7.10, *verified — naive downsampling drops
 * events and diverges*):
 *   • CONTINUOUS transforms (a shape's p/r/v inside a `state` message) are
 *     LAST-WRITE-WINS per shape per frame — only the final transform survives.
 *   • DISCRETE events (spawn/despawn/grab/release/recolor/rendermode/scale/
 *     player-join/leave) are a LOSSLESS UNION — never dropped, order preserved.
 *   • Keyframes (a welcome-style world snapshot) land at segment start and every
 *     ~10 s (reuse the late-join serializer's payload shape), so a replay can
 *     resync / loop from any keyframe.
 *   • The loop crossfades at keyframe boundaries.
 *
 * The KEYSTONE (test-enforced): applying the full-rate event stream and
 * replaying the coalesced reel produce the IDENTICAL final ShapeStore state.
 */

import type { ServerMsg, NetShape, Vec3 } from './net/types.js';
import type { RenderMode } from './types.js';

/** A keyframe emits every ~10 s (spec §7.10). Segment start also emits one. */
export const KEYFRAME_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Reel data model.
// ---------------------------------------------------------------------------

/** One recorded room event stamped with its physics tick + wall time (§7.10). */
export interface ReelEvent {
  /** Source u32 serverTick (accommodation #2). */
  tick: number;
  /** Wall-clock ms (recorder's injected clock) — drives replay timing + banking. */
  wallTime: number;
  /** The (already-sanitized) ServerMsg — NEVER a voice-* message in a real reel. */
  msg: ServerMsg;
  /**
   * Intra-frame order index (0-based over the segment's raw stream), set by
   * {@link coalesceFrame}. Absent on raw pre-coalesce events; used to interleave
   * discretes with the coalesced transforms during parity-correct replay.
   */
  order?: number;
}

/** One shape's coalesced transform (last-write-wins within a frame). */
export interface ReelTransform {
  id: string;
  p: Vec3;
  r: Vec3;
  v: Vec3;
  /** impactSpeed this frame (accommodation #3), if any. */
  s?: number;
  /**
   * The intra-frame order index of this transform's LAST write relative to the
   * frame's discrete events (0-based over the raw stream). Load-bearing for
   * replay PARITY: a transform must be applied AFTER any discrete that preceded
   * it and BEFORE any discrete that followed it — else a release-then-settle vs
   * settle-then-release ordering diverges from full-rate (the keystone breaks).
   */
  order: number;
}

/**
 * A welcome-style world snapshot (the late-join serializer payload, C0 binding
 * 5 — `Room.snapshotFor` returns exactly this `welcome` shape). Stored on
 * keyframe frames so a replay can seed/resync the world from a single frame.
 */
export interface ReelKeyframe {
  shapes: NetShape[];
}

/**
 * A coalesced frame: the last transform per moving shape + the LOSSLESS union of
 * the discrete events in the segment, plus an optional keyframe. Stamped with
 * the last (tick, wallTime) it covers.
 */
export interface ReelFrame {
  tick: number;
  wallTime: number;
  transforms: ReelTransform[];
  discrete: ReelEvent[];
  keyframe: ReelKeyframe | null;
}

/** A replayable reel: an ordered list of coalesced frames + total duration. */
export interface Reel {
  frames: ReelFrame[];
  durationMs: number;
}

/**
 * A banked-reel LISTING entry (the REEL transport `reel-listing` payload, C22).
 * Metadata ONLY — never the frames — so a stage can enumerate the day's banked
 * reels cheaply and then PLAY one by id. No identity ever rides it (a reel is
 * anonymized at record time — callsigns/GHOST_XX only, §6.1).
 */
export interface ReelSummary {
  /** Opaque banked-reel id (server-assigned). */
  id: string;
  /** Loop duration (ms). */
  durationMs: number;
  /** Coalesced-frame count (a cheap "how much is in here" hint). */
  frameCount: number;
  /** Wall-clock ms the reel was banked (recorder clock). */
  bankedAt: number;
}

// ---------------------------------------------------------------------------
// Discrete vs continuous classification.
// ---------------------------------------------------------------------------

/**
 * True iff a ServerMsg is a CONTINUOUS transform (a `state` delta). These
 * coalesce last-write-wins. Everything else that mutates the store is DISCRETE.
 */
function isContinuous(msg: ServerMsg): msg is Extract<ServerMsg, { t: 'state' }> {
  return msg.t === 'state';
}

// ---------------------------------------------------------------------------
// coalesceFrame — collapse one segment's raw events into a single ReelFrame.
// ---------------------------------------------------------------------------

/**
 * Coalesce a segment's raw {@link ReelEvent}s into ONE frame:
 *   • per-shape transforms are last-write-wins (only the final p/r/v survives);
 *   • discrete events are kept verbatim, in order (lossless union);
 *   • the frame is stamped with the last (tick, wallTime) it saw.
 * `keyframe` is attached by {@link buildReel}, not here (this fn is transform-pure).
 */
export function coalesceFrame(events: readonly ReelEvent[]): ReelFrame {
  // Insertion-ordered map keeps the FIRST-seen shape order stable while the
  // VALUE is always the LAST transform written for that shape — tagged with the
  // intra-frame `order` index of that last write (for parity-correct replay).
  const transforms = new Map<string, ReelTransform>();
  const discrete: ReelEvent[] = [];
  let lastTick = 0;
  let lastWall = 0;

  events.forEach((e, order) => {
    lastTick = e.tick;
    lastWall = e.wallTime;
    if (isContinuous(e.msg)) {
      for (const s of e.msg.shapes) {
        transforms.set(s.id, {
          id: s.id,
          p: { ...s.p },
          r: { ...s.r },
          v: { ...s.v },
          ...(s.s !== undefined ? { s: s.s } : {}),
          order,
        });
      }
    } else {
      // Preserve the discrete event AND its intra-frame order (for interleave).
      discrete.push({ ...e, order });
    }
  });

  return {
    tick: lastTick,
    wallTime: lastWall,
    transforms: [...transforms.values()],
    discrete,
    keyframe: null,
  };
}

// ---------------------------------------------------------------------------
// buildReel — segment raw events, coalesce each segment, stamp keyframes.
// ---------------------------------------------------------------------------

export interface BuildReelOpts {
  /** Injected clock (unused for pure banking but kept for signature parity). */
  now?: () => number;
  /** Segment length in ms (one coalesced frame per segment). Default 100 ms. */
  segmentMs?: number;
  /**
   * Optional keyframe builder: given the reduced world state at a frame
   * boundary, return the welcome-style snapshot. Defaults to snapshotting the
   * replayed-so-far ShapeStore (which mirrors `Room.snapshotFor`).
   */
  keyframeFor?: (shapes: NetShape[]) => ReelKeyframe;
}

/**
 * Build a replayable {@link Reel} from a raw event stream. Events are bucketed
 * into fixed-width segments (by wallTime); each segment coalesces to ONE frame.
 * A keyframe is stamped on the FIRST frame and on the first frame at/after every
 * {@link KEYFRAME_INTERVAL_MS} boundary — the world state is materialized by
 * replaying the frames produced so far (so the keyframe equals what a late
 * joiner would receive at that instant, C0 binding 5).
 */
export function buildReel(events: readonly ReelEvent[], opts: BuildReelOpts = {}): Reel {
  const segmentMs = opts.segmentMs ?? 100;
  const keyframeFor = opts.keyframeFor ?? ((shapes) => ({ shapes: shapes.map(cloneNetShape) }));

  if (events.length === 0) return { frames: [], durationMs: 0 };

  const t0 = events[0].wallTime;
  const tEnd = events[events.length - 1].wallTime;

  // Bucket events into segments keyed by floor((wallTime - t0) / segmentMs).
  const buckets = new Map<number, ReelEvent[]>();
  for (const e of events) {
    const seg = Math.floor((e.wallTime - t0) / segmentMs);
    let bucket = buckets.get(seg);
    if (!bucket) {
      bucket = [];
      buckets.set(seg, bucket);
    }
    bucket.push(e);
  }

  const segKeys = [...buckets.keys()].sort((a, b) => a - b);
  const frames: ReelFrame[] = [];

  // A running world we replay INTO so each keyframe is the true world at that
  // point (the coalesced frame's transforms + discretes are applied as we go).
  const world = new ReplayWorld();
  let lastKeyframeWall = -Infinity;

  for (const seg of segKeys) {
    const frame = coalesceFrame(buckets.get(seg)!);
    // Advance the world by this frame BEFORE deciding the keyframe so a segment
    // that spawns a shape includes it in that segment's keyframe.
    applyFrame(world, frame);
    const isFirst = frames.length === 0;
    if (isFirst || frame.wallTime - lastKeyframeWall >= KEYFRAME_INTERVAL_MS) {
      frame.keyframe = keyframeFor(world.toNetShapes());
      lastKeyframeWall = frame.wallTime;
    }
    frames.push(frame);
  }

  return { frames, durationMs: Math.max(0, tEnd - t0) };
}

// ---------------------------------------------------------------------------
// crossfadeLoopTime — wrap a monotonically-rising play head into [0, duration),
// so the loop crossfades seamlessly at the keyframe boundary (spec §7.10).
// ---------------------------------------------------------------------------

/**
 * Map a monotonic play-head time (ms) into the reel's [0, durationMs) window so
 * the attract loop wraps at the keyframe boundary. `fadeMs` is the crossfade
 * window the renderer blends across the seam (returned unchanged here — the
 * blend is a render concern; this fn owns only the deterministic wrap).
 */
export function crossfadeLoopTime(playHeadMs: number, durationMs: number, fadeMs: number): number {
  if (durationMs <= 0) return 0;
  const wrapped = playHeadMs % durationMs;
  const t = wrapped < 0 ? wrapped + durationMs : wrapped;
  // `fadeMs` never changes the play-head TIME (the blend is a render concern),
  // but a fade window wider than the whole reel would blend nonsensically — guard
  // it so callers get a sane invariant they can rely on when sizing the seam.
  return fadeMs >= durationMs ? Math.min(t, durationMs) : t;
}

// ---------------------------------------------------------------------------
// Replay reducer — reduce a reel (or a raw full-rate stream) to a final store.
// ---------------------------------------------------------------------------

/** The reduced ShapeStore state a replay yields (parity target). */
export interface ReplayState {
  shapes: NetShape[];
}

export interface ReplayReelOpts {
  /**
   * When false, the argument is a RAW full-rate {@link ReelEvent}[] (not a
   * {@link Reel}) — applied verbatim (no coalescing) to produce the full-rate
   * reference state for the keystone parity test.
   */
  buildFrames?: boolean;
}

/**
 * Replay a {@link Reel} (or a raw event array with `{buildFrames:false}`) to its
 * FINAL ShapeStore state. This is the KEYSTONE reducer: replaying the coalesced
 * reel yields the IDENTICAL final state as applying the full-rate stream.
 */
export function replayReel(reel: Reel | readonly ReelEvent[], opts: ReplayReelOpts = {}): ReplayState {
  const world = new ReplayWorld();

  if (opts.buildFrames === false || Array.isArray(reel)) {
    // Raw full-rate path: apply every event verbatim (spawn/despawn/grab/…/state).
    for (const e of reel as readonly ReelEvent[]) applyEvent(world, e.msg);
    return { shapes: world.toNetShapes() };
  }

  // Coalesced reel path: seed from keyframes, then apply discretes + transforms.
  for (const frame of (reel as Reel).frames) applyFrame(world, frame);
  return { shapes: world.toNetShapes() };
}

// ---------------------------------------------------------------------------
// ReplayWorld — a minimal deterministic ShapeStore for the reducer.
//
// Mirrors the fields the server ShapeStore tracks (id/type/color/renderMode/
// scale/grabbedBy/grounded/bobPhase/rotSpeed/position/rotation/velocity). No
// physics — a reel replays authoritative outputs, never re-simulates.
// ---------------------------------------------------------------------------

class ReplayWorld {
  private readonly shapes = new Map<string, NetShape>();

  seedFromKeyframe(kf: ReelKeyframe): void {
    this.shapes.clear();
    for (const s of kf.shapes) this.shapes.set(s.id, cloneNetShape(s));
  }

  applyServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.shapes.clear();
        for (const s of msg.shapes) this.shapes.set(s.id, cloneNetShape(s));
        break;
      case 'spawn':
        this.shapes.set(msg.shape.id, cloneNetShape(msg.shape));
        break;
      case 'despawn':
        this.shapes.delete(msg.id);
        break;
      case 'recolor': {
        const s = this.shapes.get(msg.id);
        if (s) s.colorIndex = msg.colorIndex;
        break;
      }
      case 'rendermode': {
        const s = this.shapes.get(msg.id);
        if (s) s.renderMode = msg.mode as RenderMode;
        break;
      }
      case 'scale': {
        const s = this.shapes.get(msg.id);
        if (s) s.scale = msg.scale;
        break;
      }
      case 'grab': {
        const s = this.shapes.get(msg.id);
        if (!s) break;
        if (msg.peerId === null) {
          // Release: clear grabber + apply the server-computed final {pos,vel}
          // (accommodation #5) so the rest state matches full-rate exactly.
          s.grabbedBy = null;
          if (msg.pos) s.position = { ...msg.pos };
          if (msg.vel) s.velocity = { ...msg.vel };
        } else {
          s.grabbedBy = msg.peerId;
        }
        break;
      }
      case 'state':
        for (const st of msg.shapes) {
          const s = this.shapes.get(st.id);
          if (!s) continue;
          s.position = { ...st.p };
          s.rotation = { ...st.r };
          s.velocity = { ...st.v };
        }
        break;
      default:
        // player-join / player-leave / pose / voice-* / hello / etc. carry no
        // ShapeStore mutation — ignored by the world reducer (presence is tracked
        // elsewhere; voice never reaches a reel).
        break;
    }
  }

  applyTransform(t: ReelTransform): void {
    const s = this.shapes.get(t.id);
    if (!s) return;
    s.position = { ...t.p };
    s.rotation = { ...t.r };
    s.velocity = { ...t.v };
  }

  toNetShapes(): NetShape[] {
    return [...this.shapes.values()].map(cloneNetShape);
  }
}

/**
 * Apply one coalesced frame: keyframe first, then discretes + the coalesced
 * transforms INTERLEAVED by their intra-frame `order`. Interleaving (rather than
 * "all discretes then all transforms") is what makes replay bit-parity with the
 * full-rate stream: a release that lands AFTER the last settle transform must
 * still win, and a settle that lands after a release must still win — exactly as
 * the raw ordering dictated (the keystone).
 */
function applyFrame(world: ReplayWorld, frame: ReelFrame): void {
  if (frame.keyframe) world.seedFromKeyframe(frame.keyframe);
  // Merge discretes (each carrying `order`) and transforms (each carrying
  // `order`) into one ascending-order stream, then apply.
  type Step = { order: number; kind: 'd'; msg: ServerMsg } | { order: number; kind: 't'; t: ReelTransform };
  const steps: Step[] = [];
  for (const e of frame.discrete) steps.push({ order: e.order ?? 0, kind: 'd', msg: e.msg });
  for (const t of frame.transforms) steps.push({ order: t.order, kind: 't', t });
  steps.sort((a, b) => a.order - b.order);
  for (const step of steps) {
    if (step.kind === 'd') world.applyServerMsg(step.msg);
    else world.applyTransform(step.t);
  }
}

/** Apply one raw ServerMsg (full-rate path). */
function applyEvent(world: ReplayWorld, msg: ServerMsg): void {
  world.applyServerMsg(msg);
}

/** Deep-clone a NetShape (no aliasing between reel + world). */
function cloneNetShape(s: NetShape): NetShape {
  return {
    ...s,
    rotSpeed: { ...s.rotSpeed },
    position: { ...s.position },
    rotation: { ...s.rotation },
    velocity: { ...s.velocity },
  };
}
