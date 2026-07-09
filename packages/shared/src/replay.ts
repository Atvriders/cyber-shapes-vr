/**
 * replay.ts — F11 Chrono Snap: the PURE ~30 s ring buffer + replay player +
 * micro-resim (C21, spec §7.11, §14). No I/O, no Date, no Math.random, no THREE,
 * no DOM. Injected time only. The thin stage adapter lives in
 * `packages/client/src/stage/replay.ts`; C29/C30 build the X-ray delay-shim + the
 * Pocket DVR on THIS module (the "shared, not client" placement is what lets
 * §7.18/§7.19 ride it without a later extraction refactor).
 *
 * ── The KEYSTONE (gates the "re-simulated, not recorded" flex line, §14) ──
 * A recorded FREE-FLIGHT segment, re-simulated forward from a keyframe via the
 * shared {@link stepBody} at the server's fixed {@link SIM_DT} (30 Hz), MATCHES
 * the recorded trajectory bit/near-bit. It matches because the recorded samples
 * ARE the output of the same `stepBody` at the same dt on the same tick grid — so
 * re-stepping from an authoritative {position, velocity} keyframe lands on the
 * same positions at the same ticks (proven by replay.test.ts). Only then does a
 * segment CLAIM resim.
 *
 * A segment under an ACTIVE non-default dial (bullet-time/gravity-flip/…) OR a
 * grabbed (non-free-flight) shape FALLS BACK to lerping the recorded samples AND
 * SUPPRESSES the resim claim (never a false "re-simulated" line).
 *
 * The highlight SCORER is NOT here — it is the SINGLE-SOURCE
 * {@link scoreHighlight} in `stageBrain.ts`, re-exported below (import identity;
 * no parallel implementation).
 */

import { stepBody, DEFAULT_PARAMS } from './physicsCore.js';
import type { PhysicsBody, PhysicsParams } from './physicsCore.js';
import type { ShapeType } from './types.js';
import type { Vec3 } from './net/types.js';

// The scorer is SHARED + SINGLE-SOURCE: re-export the stageBrain symbol so a
// consumer imports the SAME function object from either module (asserted by the
// import-identity test). NEVER a second implementation.
export {
  scoreHighlight,
  type Highlight,
  type HighlightKind,
  type HighlightScorerCfg,
} from './stageBrain.js';

// ---------------------------------------------------------------------------
// Constants (spec §7.11).
// ---------------------------------------------------------------------------

/** The ring holds ~30 s of history (spec §7.11 "~30 s ring buffer"). */
export const REPLAY_RING_MS = 30_000;

/** Self-snapshotted keyframe cadence: ~1 s (spec §7.11). */
export const REPLAY_KEYFRAME_MS = 1_000;

/** The server's fixed physics tick (30 Hz). Micro-resim steps at THIS dt. */
export const SIM_DT = 1 / 30;

/**
 * The replay entity namespace prefix. Replay entities are NAMESPACED so a
 * re-simulated shape never collides with the LIVE shape of the same id (they
 * co-exist on the stage: the live PiP inset + the replay scene).
 */
export const REPLAY_ID_PREFIX = 'replay::';

/** Namespace a live shape id into a replay id (never equal to the live id). */
export function namespaceReplayId(liveId: string): string {
  return `${REPLAY_ID_PREFIX}${liveId}`;
}

/** True iff `id` is a namespaced replay id. */
export function isReplayId(id: string): boolean {
  return id.startsWith(REPLAY_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Recorded data model.
// ---------------------------------------------------------------------------

/**
 * One recorded per-shape transform sample (a `state` message entry, C0
 * accommodation #2 `serverTick` + #3 `s` + #5 release {p,v}). The ring stores
 * these plus an active-dial flag per frame.
 */
export interface ReplaySample {
  /** Source u32 serverTick (accommodation #2). */
  tick: number;
  id: string;
  p: Vec3;
  r: Vec3;
  v: Vec3;
  /** impactSpeed this tick, if the shape struck the floor (accommodation #3). */
  s?: number;
}

/**
 * A keyframe body — the authoritative {position, velocity} + shape metadata at a
 * tick, from which micro-resim re-steps. Self-snapshotted ~1 s (or seeded by the
 * caller with the last-known authoritative body for a shape).
 */
export interface ReplayKeyframeBody {
  id: string;
  type: ShapeType;
  scale: number;
  position: Vec3;
  velocity: Vec3;
  grabbedBy: string | null;
  /**
   * C30 MF2 (spec §7.19 / §14): the ACTUAL release tick this authoritative
   * {position, velocity} was sampled at (accommodation #5). Present on a
   * RELEASE-seeded keyframe ({@link keyframeFromRelease}); the micro-resim anchors
   * FORWARD from here so a shape CARRIED (in hand) for seconds before release is
   * never ballistically integrated over its pre-release ticks. Absent on the C21
   * self-snapshot keyframe (whose body IS at the segment's first sample) — the
   * resim then anchors at the first sample exactly as before (no C21 regression).
   */
  releaseTick?: number;
}

/** One frame in the ring: a wall-time-stamped batch of samples + gating flags. */
interface RingFrame {
  wallTime: number;
  samples: ReplaySample[];
  /** True if an ACTIVE non-default dial was governing physics this frame. */
  dialActive: boolean;
  /** A per-shape keyframe self-snapshot on this frame (~1 s cadence), if any. */
  keyframes: Record<string, ReplayKeyframeBody> | null;
}

// ---------------------------------------------------------------------------
// ReplayRing — the ~30 s ring buffer.
// ---------------------------------------------------------------------------

/**
 * A ~30 s ring of recorded frames. `pushState` appends a frame and evicts frames
 * older than {@link REPLAY_RING_MS} behind the newest wall time. Keyframes are
 * self-snapshotted about every {@link REPLAY_KEYFRAME_MS} (segment start + ~1 s).
 */
export class ReplayRing {
  private readonly frames: RingFrame[] = [];
  private lastKeyframeWall = -Infinity;

  /**
   * @param windowMs the retained ring span. Defaults to the C21 {@link REPLAY_RING_MS}
   *                 (~30 s stage ring); C30's Pocket DVR passes {@link DVR_RING_MS}
   *                 (60 s) for the wisp/audience scrub buffer. Additive — existing
   *                 `new ReplayRing()` callers keep the exact ~30 s behavior.
   */
  constructor(private readonly windowMs: number = REPLAY_RING_MS) {}

  /**
   * Append one recorded frame.
   * @param wallTime injected wall-clock ms.
   * @param samples  the moving-shape transforms this frame.
   * @param params   the EFFECTIVE PhysicsParams this frame stepped under (used to
   *                 detect an active dial: anything other than DEFAULT_PARAMS).
   * @param dialActive an explicit active-dial flag (the server's ENV_STATE truth);
   *                 OR omit and let the params-difference heuristic decide.
   * @param keyframes optional per-shape authoritative-body snapshot for this frame.
   */
  pushState(
    wallTime: number,
    samples: readonly ReplaySample[],
    params: PhysicsParams = DEFAULT_PARAMS,
    dialActive?: boolean,
    keyframes?: Record<string, ReplayKeyframeBody>
  ): void {
    const active = dialActive ?? isDialActive(params);
    // Self-snapshot a keyframe about every ~1 s (and always the first frame).
    let kf: Record<string, ReplayKeyframeBody> | null = keyframes ?? null;
    const isFirst = this.frames.length === 0;
    if (isFirst || wallTime - this.lastKeyframeWall >= REPLAY_KEYFRAME_MS) {
      this.lastKeyframeWall = wallTime;
      // If the caller didn't provide keyframes, self-snapshot from the samples.
      if (!kf) kf = {};
    } else {
      // Between keyframe boundaries we do NOT stamp a keyframe (~1 s cadence).
      kf = null;
    }
    this.frames.push({ wallTime, samples: samples.map(cloneSample), dialActive: active, keyframes: kf });
    this.evict(wallTime);
  }

  /** Evict frames older than the retained window behind `newestWall`. */
  private evict(newestWall: number): void {
    const cutoff = newestWall - this.windowMs;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].wallTime < cutoff) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** The retained window span in ms (newest − oldest). */
  spanMs(): number {
    if (this.frames.length === 0) return 0;
    return this.frames[this.frames.length - 1].wallTime - this.frames[0].wallTime;
  }

  /** The oldest retained frame's wall time (Infinity if empty). */
  oldestWallTime(): number {
    return this.frames.length ? this.frames[0].wallTime : Infinity;
  }

  /** The newest retained frame's wall time (−Infinity if empty). */
  newestWallTime(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].wallTime : -Infinity;
  }

  /** Wall times at which a keyframe was self-snapshotted (~1 s cadence). */
  keyframeWallTimes(): number[] {
    return this.frames.filter((f) => f.keyframes !== null).map((f) => f.wallTime);
  }

  /**
   * Extract the last `windowMs` of history as a replayable {@link ReplaySegment}.
   * The segment carries the samples, the newest keyframe per shape at/before the
   * window start (the resim seed), and the OR of the window's active-dial flags.
   */
  extractLast(windowMs: number): ReplaySegment {
    const newest = this.newestWallTime();
    const start = newest - windowMs;
    const frames = this.frames.filter((f) => f.wallTime >= start);
    return buildSegment(frames, this.frames, start);
  }

  // --- C30 Pocket DVR support (pure read accessors; no new mutation path) ---

  /** Number of retained frames. */
  frameCount(): number {
    return this.frames.length;
  }

  /** Total retained samples across all frames (the memory-estimate numerator). */
  totalSamples(): number {
    let n = 0;
    for (const f of this.frames) n += f.samples.length;
    return n;
  }

  /** True iff ANY retained frame ran under an active dial (suppresses resim). */
  anyDialActive(): boolean {
    return this.frames.some((f) => f.dialActive);
  }

  /** The distinct shape ids present anywhere in the retained buffer. */
  shapeIds(): string[] {
    const ids = new Set<string>();
    for (const f of this.frames) for (const s of f.samples) ids.add(s.id);
    return [...ids];
  }

  /**
   * The (wallTime, sample) track for ONE shape across the retained buffer,
   * ascending by wall time. The DVR wall-interpolates this for a scrub-head pose
   * and reads the shape's tick span for the resim gate.
   */
  sampleTrack(id: string): Array<{ wall: number; sample: ReplaySample }> {
    const out: Array<{ wall: number; sample: ReplaySample }> = [];
    for (const f of this.frames) {
      for (const s of f.samples) if (s.id === id) out.push({ wall: f.wallTime, sample: s });
    }
    return out;
  }

  /**
   * Contiguous wall-time GAPS wider than `thresholdMs` between adjacent frames —
   * the §5.3 background-tab stalls the DVR timeline shades. Returned as
   * `{from, to}` spans (the wall times bounding the gap).
   */
  gaps(thresholdMs: number): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = [];
    for (let i = 1; i < this.frames.length; i++) {
      const from = this.frames[i - 1].wallTime;
      const to = this.frames[i].wallTime;
      if (to - from > thresholdMs) out.push({ from, to });
    }
    return out;
  }

  /**
   * A coarse memory-footprint estimate (bytes) of the retained ring — the proxy
   * the "60 s wisp-rate ring < ~1 MB" budget asserts (spec §7.19). Counts a fixed
   * per-frame overhead plus a per-sample cost (id chars + the p/r/v numbers +
   * object overhead) — deliberately conservative (over-, never under-counts).
   */
  approxBytes(): number {
    let bytes = 0;
    for (const f of this.frames) {
      bytes += RING_FRAME_OVERHEAD_BYTES;
      for (const s of f.samples) bytes += RING_SAMPLE_BASE_BYTES + s.id.length * 2;
    }
    return bytes;
  }
}

/** Per-frame bookkeeping overhead (wallTime, flags, array headers). */
const RING_FRAME_OVERHEAD_BYTES = 48;
/** Per-sample cost: tick + p/r/v (9 f64) + object overhead (excl. id chars). */
const RING_SAMPLE_BASE_BYTES = 9 * 8 + 40;

/** A frame's params differ from the inert DEFAULT → a dial is active. */
function isDialActive(params: PhysicsParams): boolean {
  if (params === DEFAULT_PARAMS) return false;
  const p = params;
  if (p.freeze === true) return true;
  if (p.timescale !== undefined && p.timescale !== 1) return true;
  if (p.suspendDespawn === true) return true;
  if (p.attractors && p.attractors.length > 0) return true;
  if (p.wind && (p.wind.x !== 0 || p.wind.y !== 0 || p.wind.z !== 0)) return true;
  const g = p.gravity;
  if (g && (g.x !== 0 || g.z !== 0 || g.y !== (DEFAULT_PARAMS.gravity as Vec3).y)) return true;
  const b = p.bounds;
  if (b && (b.ceilingY !== undefined || b.softSphereR !== Infinity || b.speedCap !== Infinity)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// ReplaySegment — an extracted window ready to micro-resim or lerp.
// ---------------------------------------------------------------------------

export interface ReplaySegment {
  /** The window's samples (ascending tick), keyed for lookup. */
  samples: ReplaySample[];
  /** The seed keyframe per shape (newest at/before the window start). */
  keyframes: Record<string, ReplayKeyframeBody>;
  /** True if ANY frame in the window ran under an active dial. */
  dialActive: boolean;
  /** The window's earliest/latest recorded ticks. */
  firstTick: number;
  lastTick: number;
}

function buildSegment(
  windowFrames: readonly RingFrame[],
  allFrames: readonly RingFrame[],
  windowStart: number
): ReplaySegment {
  const samples: ReplaySample[] = [];
  let dialActive = false;
  for (const f of windowFrames) {
    if (f.dialActive) dialActive = true;
    for (const s of f.samples) samples.push(cloneSample(s));
  }
  samples.sort((a, b) => a.tick - b.tick);

  // Seed keyframes: the newest keyframe per shape at/before the window start;
  // fall back to the earliest sample per shape as an authoritative-body seed.
  const keyframes: Record<string, ReplayKeyframeBody> = {};
  for (const f of allFrames) {
    if (f.wallTime > windowStart) break;
    if (f.keyframes) for (const [id, kf] of Object.entries(f.keyframes)) keyframes[id] = cloneKeyframe(kf);
  }
  // Also honor keyframes stamped INSIDE the window (their body is the resim seed).
  for (const f of windowFrames) {
    if (f.keyframes) for (const [id, kf] of Object.entries(f.keyframes)) {
      if (!keyframes[id]) keyframes[id] = cloneKeyframe(kf);
    }
  }

  const firstTick = samples.length ? samples[0].tick : 0;
  const lastTick = samples.length ? samples[samples.length - 1].tick : 0;
  return { samples, keyframes, dialActive, firstTick, lastTick };
}

// ---------------------------------------------------------------------------
// microResimSegment — the KEYSTONE. Re-simulate a free-flight segment or lerp.
// ---------------------------------------------------------------------------

/** A re-simulated (or lerped) pose at a given tick. */
export interface ResimPose {
  p: Vec3;
  r: Vec3;
  v: Vec3;
}

/** The result of resimming/lerping one shape's segment. */
export interface ResimSegment {
  /** TRUE only for a free-flight, dial-free segment (claims "re-simulated"). */
  resimulated: boolean;
  /**
   * C30 MF2: is `tick` inside the RE-SIMULATED BALLISTIC window — i.e. at/after the
   * release anchor and at/before the last recorded tick? On a release-seeded
   * segment the pre-release (carried, in-hand) ticks are NOT ballistic: they lerp
   * the recorded samples and this returns false, so a claim of "re-simulated" is
   * scoped to the post-release arc only (the §14 gate). Always false on the lerp
   * fallback; true across the whole window on the C21 self-snapshot path.
   */
  resimulatedAt(tick: number): boolean;
  /**
   * The pose at a given (possibly fractional) tick.
   *  - resim path: an exact per-tick pose (30 Hz) from the release anchor forward;
   *    a pre-release (carried) tick lerps the recorded samples instead.
   *  - lerp path : linear interpolation of the recorded samples.
   */
  at(tick: number): ResimPose | null;
}

export interface MicroResimOpts {
  /** Explicit override: an active dial governed this segment (suppress resim). */
  dialActive?: boolean;
}

/**
 * Re-simulate ONE shape's recorded segment from its keyframe body, OR lerp it.
 *
 * The claim gate (spec §7.11 / §14): resim is claimed ONLY for a FREE-FLIGHT,
 * DIAL-FREE segment — the keyframe body is not grabbed AND no active dial ran.
 * Otherwise the segment is played by LERPING the recorded samples (mush is
 * acceptable there; the false claim is not).
 *
 * Resim path: from the keyframe's authoritative {position, velocity}, call
 * `stepBody(body, SIM_DT, params)` once per tick up to the last recorded tick,
 * caching the pose at EVERY tick. Because the recorded samples are the output of
 * the SAME stepBody at the SAME dt on the SAME tick grid, the re-simulated pose
 * at a recorded tick equals the recorded sample within float tolerance — the
 * keystone. And every tick has a pose (30 Hz) → ≥ 4× the ~15 Hz recorded frames.
 */
export function microResimSegment(
  keyframe: ReplayKeyframeBody,
  samples: readonly ReplaySample[],
  params: PhysicsParams = DEFAULT_PARAMS,
  opts: MicroResimOpts = {}
): ResimSegment {
  const shapeSamples = samples
    .filter((s) => s.id === keyframe.id)
    .sort((a, b) => a.tick - b.tick);

  const dialActive = opts.dialActive ?? isDialActive(params);
  const freeFlight = keyframe.grabbedBy === null;
  const canResim = freeFlight && !dialActive;

  if (!canResim || shapeSamples.length === 0) {
    // LERP fallback — never claims resim (at any tick).
    return lerpSegment(shapeSamples);
  }

  const sampleFirst = shapeSamples[0].tick;
  const lastTick = shapeSamples[shapeSamples.length - 1].tick;

  // C30 MF2 (the live-data fix, spec §14): anchor the resim at the ACTUAL release
  // tick, NOT the first recorded sample. On live data a shape is CARRIED (in hand)
  // for seconds before release, so the coalesced track's first sample PRECEDES the
  // release; seeding the release {pos, vel} at that pre-release tick over-integrates
  // the ballistic arc by (releaseTick − sampleFirst) ticks and breaks endpoint-ε.
  // A release-seeded keyframe carries `releaseTick`; the C21 self-snapshot keyframe
  // does not (its body IS at sampleFirst) — anchor there, unchanged.
  const anchorTick = keyframe.releaseTick ?? sampleFirst;

  // If the release anchor is AFTER the last retained sample — e.g. ring-cap
  // eviction trimmed every post-release sample — there is NO ballistic window to
  // re-simulate. REFUSE (lerp the carried remnant) rather than silently mis-seed.
  if (anchorTick > lastTick) {
    return lerpSegment(shapeSamples);
  }

  // Resim path: step the keyframe body FORWARD from the release anchor, caching
  // every tick's pose from the anchor to the last recorded tick.
  const b: PhysicsBody = {
    position: { ...keyframe.position },
    velocity: { ...keyframe.velocity },
    scale: keyframe.scale,
    type: keyframe.type,
    grabbedBy: null,
    grounded: false,
  };
  const poses = new Map<number, ResimPose>();
  poses.set(anchorTick, { p: { ...b.position }, r: { x: 0, y: 0, z: 0 }, v: { ...b.velocity } });
  for (let t = anchorTick + 1; t <= lastTick; t++) {
    stepBody(b, SIM_DT, params);
    poses.set(t, { p: { ...b.position }, r: { x: 0, y: 0, z: 0 }, v: { ...b.velocity } });
  }

  return {
    resimulated: true,
    // Only the post-release ballistic window [anchorTick, lastTick] is resimulated;
    // pre-release carried ticks are NOT (they lerp the recorded in-hand samples).
    resimulatedAt: (tick) => Number.isFinite(tick) && tick >= anchorTick && tick <= lastTick,
    at: (tick) => {
      // Pre-release (carried, in-hand) ticks are NOT ballistic — lerp the recorded
      // samples; only the release→landing window re-simulates.
      if (tick < anchorTick) return lerpAt(shapeSamples, tick);
      // Exact integer tick → the resim pose; fractional → lerp neighbours.
      if (Number.isInteger(tick)) return poses.get(tick) ?? null;
      const lo = Math.floor(tick);
      const hi = Math.ceil(tick);
      const a = poses.get(lo);
      const c = poses.get(hi);
      if (!a || !c) return a ?? c ?? null;
      const alpha = tick - lo;
      return {
        p: lerp3(a.p, c.p, alpha),
        r: lerp3(a.r, c.r, alpha),
        v: lerp3(a.v, c.v, alpha),
      };
    },
  };
}

/** The LERP fallback segment — plays recorded samples, never claims resim. */
function lerpSegment(shapeSamples: readonly ReplaySample[]): ResimSegment {
  return {
    resimulated: false,
    resimulatedAt: () => false,
    at: (tick) => lerpAt(shapeSamples, tick),
  };
}

/** Lerp the recorded samples at `tick` (the dial/grab fallback path). */
function lerpAt(samples: readonly ReplaySample[], tick: number): ResimPose | null {
  if (samples.length === 0) return null;
  if (tick <= samples[0].tick) return poseOf(samples[0]);
  const last = samples[samples.length - 1];
  if (tick >= last.tick) return poseOf(last);
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tick <= tick) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.tick - a.tick;
  const alpha = span === 0 ? 0 : (tick - a.tick) / span;
  return { p: lerp3(a.p, b.p, alpha), r: lerp3(a.r, b.r, alpha), v: lerp3(a.v, b.v, alpha) };
}

function poseOf(s: ReplaySample): ResimPose {
  return { p: { ...s.p }, r: { ...s.r }, v: { ...s.v } };
}

// ---------------------------------------------------------------------------
// ReplayPlayer — plays an extracted segment at 0.25× (dense slow-mo).
// ---------------------------------------------------------------------------

/** Playback speed (spec §7.11 "quarter speed"). */
export const REPLAY_SPEED = 0.25;

/**
 * A deterministic replay player. Constructs per-shape resim/lerp tracks from a
 * {@link ReplaySegment}, advances a play head at {@link REPLAY_SPEED}, and
 * exposes namespaced poses for the render layer. No clock of its own — the caller
 * drives `advance(wallDtMs)`. When the head passes the end, {@link finished} is
 * true (the thin adapter triggers the 6 s auto-return + stinger on that).
 */
export class ReplayPlayer {
  /** Play-head position within the segment, in RECORDED-tick space × SIM_DT ms. */
  headMs = 0;
  /** True once the head has consumed the whole window. */
  finished = false;
  /** True iff EVERY track resimulated (a fully free-flight, dial-free window). */
  readonly resimulated: boolean;

  private readonly tracks: Map<string, ResimSegment>;
  private readonly firstTick: number;
  private readonly durationMs: number;
  private readonly segment: ReplaySegment;

  constructor(segment: ReplaySegment) {
    this.segment = segment;
    this.tracks = new Map();
    const ids = new Set(segment.samples.map((s) => s.id));
    let allResim = ids.size > 0;
    for (const id of ids) {
      const kf =
        segment.keyframes[id] ?? seedKeyframeFromSamples(id, segment.samples);
      const track = microResimSegment(kf, segment.samples, DEFAULT_PARAMS, {
        dialActive: segment.dialActive,
      });
      if (!track.resimulated) allResim = false;
      this.tracks.set(id, track);
    }
    this.resimulated = allResim;
    this.firstTick = segment.firstTick;
    // The window's real-time duration = tick span × SIM_DT.
    this.durationMs = Math.max(0, (segment.lastTick - segment.firstTick) * SIM_DT * 1000);
  }

  /** Advance the play head by `wallDtMs` of REAL time (scaled by REPLAY_SPEED). */
  advance(wallDtMs: number): void {
    this.headMs += wallDtMs * REPLAY_SPEED;
    if (this.headMs >= this.durationMs) {
      this.headMs = this.durationMs;
      this.finished = true;
    }
  }

  /** The pose for a LIVE shape id at the current head (null if unknown). */
  poseFor(liveId: string): ResimPose | null {
    const track = this.tracks.get(liveId);
    if (!track) return null;
    const tick = this.firstTick + (this.headMs / 1000) / SIM_DT;
    return track.at(tick);
  }

  /** The NAMESPACED replay ids the render layer should spawn (never live ids). */
  namespacedIds(): string[] {
    return [...this.tracks.keys()].map(namespaceReplayId);
  }

  /** Every namespaced replay entity's pose at the current head. */
  poses(): Array<{ id: string; pose: ResimPose }> {
    const out: Array<{ id: string; pose: ResimPose }> = [];
    for (const liveId of this.tracks.keys()) {
      const pose = this.poseFor(liveId);
      if (pose) out.push({ id: namespaceReplayId(liveId), pose });
    }
    return out;
  }
}

/** Seed a keyframe body from the earliest sample of a shape (authoritative {p,v}). */
function seedKeyframeFromSamples(id: string, samples: readonly ReplaySample[]): ReplayKeyframeBody {
  const first = samples.find((s) => s.id === id);
  return {
    id,
    type: 'cube',
    scale: 1,
    position: first ? { ...first.p } : { x: 0, y: 0, z: 0 },
    velocity: first ? { ...first.v } : { x: 0, y: 0, z: 0 },
    // Absent a keyframe body we cannot prove free-flight → mark grabbed so the
    // player LERPS + suppresses the claim (never a false resim line).
    grabbedBy: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}
function cloneSample(s: ReplaySample): ReplaySample {
  return { ...s, p: { ...s.p }, r: { ...s.r }, v: { ...s.v } };
}
function cloneKeyframe(k: ReplayKeyframeBody): ReplayKeyframeBody {
  return { ...k, position: { ...k.position }, velocity: { ...k.velocity } };
}

// ---------------------------------------------------------------------------
// DelayFifoSource — the C29 (F18 X-Ray Broadcast, spec §7.18) −300 ms ghost-world
// shim, BESIDE the ring buffer.
//
// ⚠ THE C0 FROZEN CONTRACT: `createInterpolator({source, now})` (defined in the
// CLIENT at `packages/client/src/net/interpolation.ts`) is NEVER modified or
// extended by this task. The ghost world is produced by feeding a SECOND
// `createInterpolator` instance through THIS delay-FIFO `StateSource` ADAPTER —
// exactly the same seam `reelToStateSource` (attract.ts) and `PushStateSource`
// (stage/replay.ts) already use to hand the frozen interpolator a non-socket
// source. All x-ray diagnostics (tick rate, snapshot age, interp buffer depth)
// are computed at THIS shim layer — never inside the interpolator.
//
// Deliberately GENERIC over the frame type (`TFrame`) rather than importing the
// client's `StateFrame`/`StateSource` types: this module is PURE shared code (no
// I/O, no DOM, no THREE) and must not import ANYTHING from `packages/client` —
// the shared test (`replay.test.ts`) exercises it with zero client import. Its
// `onState`/frame shape is STRUCTURALLY compatible with the client's
// `StateSource` interface (an `onState(cb): unsub` source of opaque frames), so
// the client wires it into `createInterpolator({ source: delayFifo, now })`
// exactly like any other StateSource — no adapter glue needed at the call site.
//
// The core property under test (the "equivalence"): every frame pushed at wall
// time `t` is emitted to listeners no earlier than `t + delayMs`, in the SAME
// relative order it was pushed (a pure FIFO time-delay, never a reorder/drop).
// Because `createInterpolator` stamps a sample with ITS OWN `now()` at the
// instant a source fires, and linear interpolation (`SnapshotBuffer.sample`) is
// shift-invariant under a uniform time offset, a ghost interpolator fed by a
// `DelayFifoSource(delayMs)` — driven by the SAME `now()` as the live
// interpolator — renders, at any time T, exactly what the live interpolator
// rendered at `T − delayMs` (proven with the REAL frozen interpolator in
// `packages/client/test/xray.test.ts`, which is the only place allowed to import
// both `createInterpolator` and this shim together).
// ---------------------------------------------------------------------------

/** The spec §7.18 ghost-world delay ("+300 ms — WHAT LAG FEELS LIKE"). */
export const XRAY_GHOST_DELAY_MS = 300;

/** One queued frame awaiting its emission time. */
interface DelayFifoEntry<TFrame> {
  frame: TFrame;
  /** Wall time (the SAME clock `push` was called with) at which this is due. */
  dueAtMs: number;
}

/**
 * A pure, generic delay-FIFO message source: {@link push} enqueues a frame
 * observed at `atMs`; {@link tick} advances the shim's notion of "now" and
 * synchronously emits (FIFO order, never reordered/dropped) every frame whose
 * `atMs + delayMs` has elapsed. `onState` matches the client's `StateSource`
 * shape structurally (no import needed) so a `DelayFifoSource<StateFrame>` can
 * be handed straight to `createInterpolator({ source, now })` as a second,
 * independent instance — the C0 signature is consumed, never touched.
 *
 * Generic over `TFrame` — this module never inspects frame contents, so it
 * carries whatever the caller pushes (a client `StateFrame`, a test fixture,
 * anything) without depending on that shape.
 */
export class DelayFifoSource<TFrame = unknown> {
  private readonly delayMs: number;
  private readonly queue: Array<DelayFifoEntry<TFrame>> = [];
  private readonly listeners = new Set<(frame: TFrame) => void>();

  constructor(delayMs: number = XRAY_GHOST_DELAY_MS) {
    this.delayMs = delayMs;
  }

  /** The configured delay (ms). */
  get delay(): number {
    return this.delayMs;
  }

  /** Register a listener; returns an unsubscribe function (StateSource shape). */
  onState(cb: (frame: TFrame) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Enqueue `frame`, observed at wall time `atMs`. Due at `atMs + delayMs`. */
  push(frame: TFrame, atMs: number): void {
    this.queue.push({ frame, dueAtMs: atMs + this.delayMs });
  }

  /**
   * Advance the shim to `nowMs`: synchronously emit (FIFO order) every queued
   * frame whose due time has elapsed. Idempotent / safe to call every render
   * frame. Frames not yet due stay queued (their count is {@link pending}).
   */
  tick(nowMs: number): void {
    while (this.queue.length > 0 && this.queue[0].dueAtMs <= nowMs) {
      const entry = this.queue.shift();
      if (!entry) break;
      for (const cb of this.listeners) cb(entry.frame);
    }
  }

  /** Count of frames queued but not yet due (an "interp buffer depth" proxy). */
  pending(): number {
    return this.queue.length;
  }

  /** Drop every queued frame without emitting (e.g. on a mode-switch reset). */
  clear(): void {
    this.queue.length = 0;
  }
}

// ===========================================================================
// C30 — F19 Pocket DVR (spec §7.19). The client scrub/rewind DVR that rides the
// C21 ring buffer + micro-resim for the wisp/audience tiers. PURE shared code —
// no I/O, no Date, no THREE, no DOM (the DOM scrub UI is the lazy wisp3d chunk).
//
// ⚠ THE C0 FROZEN CONTRACT (same as C29): `createInterpolator({source, now})` is
// NEVER modified/extended here. The DVR reconstructs poses from the ring by
// micro-resim (free-flight, release-seeded) or by wall-interpolating the
// decimated samples — it does NOT touch the interpolator.
//
// ── The §14 FLEX GATE keystone ──
// The wisp/audience fan-out is DECIMATED to 5 Hz + POSITION-ONLY (`wisp-coalesced`
// drops velocity). A ballistic "rewind" would be impossible from position-only
// samples ALONE — BUT the RELEASE event (accommodation #5) carries the
// authoritative {pos, vel}. Seeding a micro-resim from that release reproduces
// the arc to endpoint-ε (proven on a 5 Hz-decimated fixture in replay.test.ts).
// Only when that ε passes is the "rewind the broadcast" copy aired; otherwise the
// copy demotes to "scrub the broadcast" (plain interpolation of the 5 Hz samples).
// Step 0 finding: the wisp tier already receives the release per-message; the
// audience tier's receive set was additively extended so its release survives too.
// ===========================================================================

/** The Pocket DVR ring holds 60 s at wisp rates (spec §7.19 "60 s ring < ~1 MB"). */
export const DVR_RING_MS = 60_000;

/** Idle auto-return to live after ~10 s (spec §7.19 — never cost a participation beat). */
export const DVR_IDLE_RETURN_MS = 10_000;

/** Default scrub speed 1× (spec §7.19 — never slow-mo the live world). */
export const DVR_SPEED_NORMAL = 1;

/** Slow-mo 0.25× — engages ONLY inside a resimmed ballistic segment (spec §7.19). */
export const DVR_SPEED_SLOW = REPLAY_SPEED;

/** The non-spectator tiers the DVR serves (resume drains forward for THESE only). */
export type DvrTier = 'wisp' | 'audience';

/** The booth-critical yield signals that auto-snap a scrubbed viewer to live. */
export type DvrYieldSignal = 'SHOWPIECE_START' | 'CHARGE_START' | 'VOTE_OPEN';

/**
 * A release event carrying the server-computed authoritative {pos, vel} at the
 * instant a shape left a hand (Phase B §3 accommodation #5). This is the resim
 * SEED — the one field that turns a position-only 5 Hz stream into a rewindable
 * ballistic arc. Mirrors the `grab` (peerId:null) ServerMsg payload.
 */
export interface DvrReleaseSeed {
  /** The serverTick the release landed on (the resim start tick). */
  tick: number;
  id: string;
  p: Vec3;
  v: Vec3;
}

/**
 * Build a free-flight micro-resim keyframe from a release event's {pos, vel}. The
 * body is NOT grabbed (`grabbedBy: null`) — the release put it into ballistic
 * flight, so a resim from here CLAIMS "re-simulated" (the §14 gate) when dial-free.
 * `type`/`scale` come from the client's world model (the keyframe / spawn), which
 * the decimated position-only stream does not carry.
 */
export function keyframeFromRelease(
  release: DvrReleaseSeed,
  type: ShapeType,
  scale: number
): ReplayKeyframeBody {
  return {
    id: release.id,
    type,
    scale,
    position: { ...release.p },
    velocity: { ...release.v },
    grabbedBy: null,
    // C30 MF2: preserve the release tick so the micro-resim anchors FORWARD from
    // the real release (not the first carried sample) on live, carried-then-thrown
    // streams — the §14 endpoint-ε only holds when the seed is placed at its tick.
    releaseTick: release.tick,
  };
}

export interface PocketDvrOpts {
  /** Ring span (ms). Default {@link DVR_RING_MS} (60 s). */
  ringMs?: number;
  /** Idle auto-return window (ms). Default {@link DVR_IDLE_RETURN_MS} (10 s). */
  idleReturnMs?: number;
}

/** The mandatory REWOUND badge state (spec §7.19 — never mistake paused for frozen). */
export interface DvrBadge {
  rewound: boolean;
  offsetSec: number;
  /** "REWOUND // T-6.2s" when rewound; '' at live. */
  text: string;
}

/**
 * The Pocket DVR controller (spec §7.19). Wraps a 60 s {@link ReplayRing} that
 * KEEPS BUFFERING while the viewer scrubs (zero marginal fan-out — the frames are
 * already sent), and exposes:
 *   • {@link scrubTo} / {@link jumpToLive} — jump-to-live DRAINS the buffered ring
 *     FORWARD, converging with NO server round-trip (non-spectator tiers only;
 *     `REQUEST_SNAPSHOT` stays spectator/stage-only, so {@link serverRoundTrips}
 *     is always 0 here);
 *   • ring-cap eviction trims the scrub range from the BACK (a rewound head is
 *     clamped forward as the oldest frames evict);
 *   • {@link onYieldSignal} — SHOWPIECE_START/CHARGE_START/VOTE_OPEN auto-snap to
 *     live within one frame (+ a banner), and {@link tick} auto-returns after
 *     ~10 s idle;
 *   • {@link badge} — the mandatory "REWOUND // T-…s" surface;
 *   • {@link speed} — 1× by default, 0.25× ONLY inside a resimmed ballistic segment;
 *   • {@link poses} — NAMESPACED replay poses (a scrubbed replay NEVER leaks a live id);
 *   • {@link gaps} — the §5.3 background-tab spans the timeline shades.
 *
 * No clock of its own: {@link push} carries the frame wall time; {@link scrubTo}
 * and {@link tick} take an injected `now`. Heartbeats (the caller's WS keepalive)
 * continue while paused — the DVR never touches the socket, so idle-kick never
 * fires mid-scrub.
 */
export class PocketDvr {
  readonly tier: DvrTier;
  private readonly ring: ReplayRing;
  private readonly idleReturnMs: number;

  /** Scrub head wall time, or null when FOLLOWING LIVE (head = newest). */
  private _head: number | null = null;
  private lastInteractionWall = -Infinity;
  private banner: DvrYieldSignal | null = null;
  /**
   * Server round-trips a resume was forced to issue. A REAL mutable counter (not a
   * hardcoded 0): it is bumped ONLY on the snapshot-required condition — a resume
   * that finds the ring COLD, with nothing buffered to drain forward. On the live
   * wisp/audience feed the client never stops consuming, so the ring is always warm
   * and this stays 0 — but the counter is now a GENUINE guard on drain-forward
   * convergence (a regression that broke buffering would make it go non-zero),
   * never a tautology. `REQUEST_SNAPSHOT` itself is spectator/stage-only.
   */
  private _roundTrips = 0;

  /** Per-shape release seeds (authoritative {pos, vel} → resim keyframe). */
  private readonly releaseSeeds = new Map<string, DvrReleaseSeed>();
  /** Per-shape type/scale (from the world model — the decimated stream omits it). */
  private readonly shapeMeta = new Map<string, { type: ShapeType; scale: number }>();

  constructor(tier: DvrTier, opts: PocketDvrOpts = {}) {
    this.tier = tier;
    this.ring = new ReplayRing(opts.ringMs ?? DVR_RING_MS);
    this.idleReturnMs = opts.idleReturnMs ?? DVR_IDLE_RETURN_MS;
  }

  /**
   * Feed one DECIMATED frame into the ring. Called EVERY frame — including while
   * scrubbed/paused (the client keeps consuming; that is what lets jump-to-live
   * drain forward with no round-trip). A rewound head below the (now-advanced)
   * oldest edge is clamped forward — ring-cap eviction trims the scrub range from
   * the back.
   */
  push(
    wallTime: number,
    samples: readonly ReplaySample[],
    opts: { dialActive?: boolean; keyframes?: Record<string, ReplayKeyframeBody> } = {}
  ): void {
    this.ring.pushState(wallTime, samples, DEFAULT_PARAMS, opts.dialActive ?? false, opts.keyframes);
    if (this._head !== null) {
      const oldest = this.ring.oldestWallTime();
      if (this._head < oldest) this._head = oldest;
    }
  }

  /** Record a shape's type/scale (from the keyframe/spawn) for resim. */
  setShapeMeta(id: string, type: ShapeType, scale: number): void {
    this.shapeMeta.set(id, { type, scale });
  }

  /** Record a release event's authoritative {pos, vel} as the resim seed. */
  onRelease(release: DvrReleaseSeed): void {
    this.releaseSeeds.set(release.id, {
      tick: release.tick,
      id: release.id,
      p: { ...release.p },
      v: { ...release.v },
    });
  }

  /** True while following the live edge (not rewound). */
  get isLive(): boolean {
    return this._head === null;
  }

  /** The scrub head wall time, or null when following live. */
  headWall(): number | null {
    return this._head;
  }

  /** The newest buffered wall time (the "live" edge). */
  liveWall(): number {
    return this.ring.newestWallTime();
  }

  /** The oldest retained wall time (the far end of the rewind range). */
  oldestWall(): number {
    return this.ring.oldestWallTime();
  }

  /** Resume round-trips — always 0 (drain-forward; never a REQUEST_SNAPSHOT). */
  get serverRoundTrips(): number {
    return this._roundTrips;
  }

  /**
   * Scrub to a past wall time (enters rewound mode), clamped to the retained
   * [oldest, newest] range. Stamps the interaction so the idle timer resets.
   */
  scrubTo(wall: number, now: number): void {
    const lo = this.ring.oldestWallTime();
    const hi = this.ring.newestWallTime();
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return; // empty ring — nothing to scrub
    this._head = Math.max(lo, Math.min(hi, wall));
    this.lastInteractionWall = now;
  }

  /**
   * Jump to live by DRAINING the buffered ring FORWARD — the frames are already
   * here (the client never stopped consuming), so this converges with ZERO server
   * round-trips. `REQUEST_SNAPSHOT` is NEVER sent (spectator/stage-only).
   */
  jumpToLive(): void {
    // Drain-forward: the buffered ring already holds every frame up to the live
    // edge, so following live (head=null) converges with ZERO server round-trips.
    // The ONE condition that would force a REQUEST_SNAPSHOT — a COLD ring with
    // nothing buffered to drain — cannot arise on the live wisp/audience feed (the
    // client never stops consuming), but is counted so `serverRoundTrips` is a real
    // guard rather than a constant. REQUEST_SNAPSHOT is never actually sent here.
    if (this.ring.frameCount() === 0) this._roundTrips++;
    this._head = null;
  }

  /** The booth-critical yield: snap a scrubbed viewer to live within one frame. */
  onYieldSignal(sig: DvrYieldSignal): void {
    if (this._head !== null) {
      this._head = null; // snap to live THIS frame
      this.banner = sig; // show the "pulled you back" banner
    }
  }

  /** The current yield banner (null when none). */
  yieldBanner(): DvrYieldSignal | null {
    return this.banner;
  }

  /** Dismiss the yield banner. */
  clearBanner(): void {
    this.banner = null;
  }

  /** Idle auto-return: snap to live after ~10 s of no scrub interaction. */
  tick(now: number): void {
    if (this._head !== null && now - this.lastInteractionWall >= this.idleReturnMs) {
      this._head = null;
      // C30 fold: clear any stale yield banner on the idle auto-return — a viewer
      // that quietly drifted back to live is never labelled with an old "pulled you
      // back" banner (that copy belongs only to a live yield snap).
      this.banner = null;
    }
  }

  /** The mandatory REWOUND badge (spec §7.19) — "REWOUND // T-6.2s" or hidden at live. */
  badge(): DvrBadge {
    if (this._head === null) return { rewound: false, offsetSec: 0, text: '' };
    const offsetMs = Math.max(0, this.ring.newestWallTime() - this._head);
    const offsetSec = offsetMs / 1000;
    return { rewound: true, offsetSec, text: `REWOUND // T-${offsetSec.toFixed(1)}s` };
  }

  /**
   * Playback speed at the current head: {@link DVR_SPEED_SLOW} (0.25×) ONLY when
   * the head sits inside a resimmed BALLISTIC segment (a release-seeded, dial-free
   * free-flight arc); otherwise {@link DVR_SPEED_NORMAL} (1×). Live is always 1×.
   */
  speed(): number {
    if (this._head === null) return DVR_SPEED_NORMAL;
    for (const id of this.releaseSeeds.keys()) {
      const seed = this.releaseSeeds.get(id);
      if (!seed || !this.shapeMeta.has(id)) continue;
      const seg = this.resimSegmentFor(id);
      if (!seg || !seg.resimulated) continue;
      // C30 MF2 fold — confine 0.25× to THIS shape's BALLISTIC window only. The
      // window is the samples at/after the release tick (release→landing); a head
      // over a PRE-RELEASE carried tick, a RESTING (post-window) tick, or a
      // DIFFERENT shape's span stays 1× (the multi-shape false-positive fix: it is
      // no longer enough for any shape's full track to merely straddle the head).
      const ballistic = this.ring.sampleTrack(id).filter((t) => t.sample.tick >= seed.tick);
      if (ballistic.length === 0) continue;
      const lo = ballistic[0].wall;
      const hi = ballistic[ballistic.length - 1].wall;
      if (this._head >= lo && this._head <= hi) return DVR_SPEED_SLOW;
    }
    return DVR_SPEED_NORMAL;
  }

  /**
   * The micro-resim segment for one shape, seeded from its release {pos, vel}. The
   * renderer samples this densely (30 Hz) for the slow-mo scrub; null when the
   * shape has no release seed / meta / buffered samples. Dial-flagged from the
   * ring so a bullet-time window LERPS + suppresses the resim claim.
   */
  resimSegmentFor(id: string): ResimSegment | null {
    const seed = this.releaseSeeds.get(id);
    const meta = this.shapeMeta.get(id);
    if (!seed || !meta) return null;
    const samples = this.ring.sampleTrack(id).map((t) => t.sample);
    if (samples.length === 0) return null;
    const kf = keyframeFromRelease(seed, meta.type, meta.scale);
    return microResimSegment(kf, samples, DEFAULT_PARAMS, { dialActive: this.ring.anyDialActive() });
  }

  /**
   * The NAMESPACED replay poses at the current head (live edge if not rewound).
   * EVERY id is `replay::`-namespaced so a scrubbed replay can NEVER collide with
   * — or leak into — a LIVE shape in the inset/scene (the C21 isolation discipline).
   */
  poses(): Array<{ id: string; pose: ResimPose }> {
    const wall = this._head ?? this.ring.newestWallTime();
    const out: Array<{ id: string; pose: ResimPose }> = [];
    for (const id of this.ring.shapeIds()) {
      const pose = this.displayPose(id, wall);
      if (pose) out.push({ id: namespaceReplayId(id), pose });
    }
    return out;
  }

  /** The §5.3 background-tab gaps the timeline shades (spans wider than `thresholdMs`). */
  gaps(thresholdMs: number): Array<{ from: number; to: number }> {
    return this.ring.gaps(thresholdMs);
  }

  /** Retained frame count (memory diagnostics). */
  frameCount(): number {
    return this.ring.frameCount();
  }

  /** Coarse memory estimate (bytes) of the retained ring (the < ~1 MB budget). */
  approxBytes(): number {
    return this.ring.approxBytes();
  }

  /** Wall-interpolate a shape's decimated samples for a display pose at `wall`. */
  private displayPose(id: string, wall: number): ResimPose | null {
    const track = this.ring.sampleTrack(id);
    if (track.length === 0) return null;
    if (wall <= track[0].wall) return poseOf(track[0].sample);
    const lastEntry = track[track.length - 1];
    if (wall >= lastEntry.wall) return poseOf(lastEntry.sample);
    let hi = 1;
    while (hi < track.length && track[hi].wall < wall) hi++;
    const a = track[hi - 1];
    const b = track[hi];
    const span = b.wall - a.wall;
    const alpha = span === 0 ? 0 : (wall - a.wall) / span;
    return {
      p: lerp3(a.sample.p, b.sample.p, alpha),
      r: lerp3(a.sample.r, b.sample.r, alpha),
      v: lerp3(a.sample.v, b.sample.v, alpha),
    };
  }
}
