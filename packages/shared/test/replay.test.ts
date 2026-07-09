/**
 * replay.test.ts — F11 Chrono Snap: the ~30 s ring buffer + replay player +
 * micro-resim parity + the SHARED highlight scorer (C21, spec §7.11, §14).
 *
 * These are the Step-1 RED tests (brief C21 Step 1). Everything here is PURE —
 * no Date, no Math.random, injected time only. The KEYSTONE (gates the "re-
 * simulated, not recorded" flex line, §14): a recorded FREE-FLIGHT segment, re-
 * simulated via the shared `physicsCore.stepBody` from a keyframe, MATCHES the
 * recorded trajectory within tolerance. A segment under an ACTIVE non-default
 * dial falls back to lerp AND suppresses the resim claim.
 */

import { describe, it, expect } from 'vitest';
import { stepBody, DEFAULT_PARAMS, DIAL_BOUNDS, mergeParams } from '../src/physicsCore.js';
import type { PhysicsBody, PhysicsParams } from '../src/physicsCore.js';
import type { ShapeType } from '../src/types.js';
import type { Vec3 } from '../src/net/types.js';
import {
  ReplayRing,
  ReplayPlayer,
  microResimSegment,
  scoreHighlight,
  REPLAY_RING_MS,
  REPLAY_KEYFRAME_MS,
  SIM_DT,
  REPLAY_ID_PREFIX,
  namespaceReplayId,
  isReplayId,
  DelayFifoSource,
  XRAY_GHOST_DELAY_MS,
  // C30 (F19 Pocket DVR, spec §7.19) — the client scrub/rewind DVR.
  PocketDvr,
  keyframeFromRelease,
  DVR_RING_MS,
  DVR_IDLE_RETURN_MS,
  DVR_SPEED_NORMAL,
  DVR_SPEED_SLOW,
  type ReplaySample,
  type ReplayKeyframeBody,
  type DvrReleaseSeed,
} from '../src/replay.js';
// The scorer MUST be the SHARED stageBrain one (single-source — no duplicate).
import { scoreHighlight as scoreFromStageBrain } from '../src/stageBrain.js';

// ---------------------------------------------------------------------------
// Fixtures — a recorded free-flight trajectory produced by the SAME stepBody
// the server runs (30 Hz fixed tick), sampled at the ~15 Hz broadcast rate.
// ---------------------------------------------------------------------------

function body(type: ShapeType, p: Vec3, v: Vec3): PhysicsBody {
  return {
    position: { ...p },
    velocity: { ...v },
    scale: 1,
    type,
    grabbedBy: null,
    grounded: false,
  };
}

/**
 * Simulate a free-flight arc the SERVER way: stepBody at SIM_DT per tick. Record
 * a `state`-style sample every `broadcastEvery` ticks (default 2 → ~15 Hz from a
 * 30 Hz sim). Each sample is stamped with its serverTick + the authoritative
 * {p, v} at that tick (accommodation #2 + #5). This is the ground-truth reel.
 */
function recordArc(
  type: ShapeType,
  p0: Vec3,
  v0: Vec3,
  ticks: number,
  params: PhysicsParams = DEFAULT_PARAMS,
  broadcastEvery = 2
): { samples: ReplaySample[]; keyframe: ReplayKeyframeBody } {
  const b = body(type, p0, v0);
  const keyframe: ReplayKeyframeBody = {
    id: 'shapeA',
    type,
    scale: 1,
    position: { ...b.position },
    velocity: { ...b.velocity },
    grabbedBy: null,
  };
  const samples: ReplaySample[] = [];
  // Tick 0 sample (the keyframe instant).
  samples.push({
    tick: 0,
    id: 'shapeA',
    p: { ...b.position },
    r: { x: 0, y: 0, z: 0 },
    v: { ...b.velocity },
  });
  for (let t = 1; t <= ticks; t++) {
    stepBody(b, SIM_DT, params);
    if (t % broadcastEvery === 0) {
      samples.push({
        tick: t,
        id: 'shapeA',
        p: { ...b.position },
        r: { x: 0, y: 0, z: 0 },
        v: { ...b.velocity },
      });
    }
  }
  return { samples, keyframe };
}

const NEAR = 1e-9; // bit/near-bit tolerance — same stepBody, same dt, same tick.

// ---------------------------------------------------------------------------
// Constants sanity.
// ---------------------------------------------------------------------------

describe('replay — constants', () => {
  it('the ring holds ~30 s and keyframes cadence ~1 s', () => {
    expect(REPLAY_RING_MS).toBe(30_000);
    expect(REPLAY_KEYFRAME_MS).toBe(1_000);
  });
  it('SIM_DT is the 30 Hz server fixed tick', () => {
    expect(SIM_DT).toBeCloseTo(1 / 30, 12);
  });
});

// ---------------------------------------------------------------------------
// KEYSTONE — micro-resim parity (gates the "re-simulated, not recorded" claim).
// ---------------------------------------------------------------------------

describe('replay — micro-resim parity (KEYSTONE, §14)', () => {
  it('a recorded FREE-FLIGHT segment re-simulated from a keyframe matches the recorded trajectory', () => {
    // A hard parabolic throw (up + across) recorded at 15 Hz from a 30 Hz sim.
    const { samples, keyframe } = recordArc(
      'icosahedron',
      { x: -3, y: 1.2, z: 0 },
      { x: 6, y: 5, z: 1.5 },
      40 // ~1.3 s of flight
    );

    const seg = microResimSegment(keyframe, samples, DEFAULT_PARAMS);

    // It CLAIMS resim (free-flight, dial-free).
    expect(seg.resimulated).toBe(true);

    // Every recorded sample tick has a re-simulated pose that matches within ε.
    for (const s of samples) {
      const rp = seg.at(s.tick);
      expect(rp).not.toBeNull();
      expect(Math.abs(rp!.p.x - s.p.x)).toBeLessThan(NEAR);
      expect(Math.abs(rp!.p.y - s.p.y)).toBeLessThan(NEAR);
      expect(Math.abs(rp!.p.z - s.p.z)).toBeLessThan(NEAR);
    }
  });

  it('exposes a pose at EVERY server tick (30 Hz dense slow-mo, > the ~15 Hz record)', () => {
    const { samples, keyframe } = recordArc(
      'cube',
      { x: 0, y: 2, z: 0 },
      { x: 4, y: 3, z: 0 },
      24
    );
    const seg = microResimSegment(keyframe, samples, DEFAULT_PARAMS);
    // The recorded stream is ~15 Hz (every 2nd tick) over the window; the resim
    // exposes a pose at EVERY server tick (30 Hz) → ~2× the recorded sample count
    // AND a pose at every integer tick in [firstTick, lastTick].
    const firstTick = samples[0].tick;
    const lastTick = samples[samples.length - 1].tick;
    let resimFrames = 0;
    for (let t = firstTick; t <= lastTick; t++) if (seg.at(t) !== null) resimFrames++;
    // Every tick in range has a pose (30 Hz), roughly double the ~15 Hz samples.
    expect(resimFrames).toBe(lastTick - firstTick + 1);
    expect(resimFrames).toBeGreaterThanOrEqual(2 * samples.length - 1);
  });

  it('at 0.25× playback the player yields ≥ 4× the recorded frame count over the window', () => {
    // Dense slow-mo acceptance: playing a ~15 Hz window at 0.25× exposes ≥ 4
    // rendered poses per RECORDED frame (the "quarter speed" jumbotron feel).
    const { samples, keyframe } = recordArc('cube', { x: 0, y: 2, z: 0 }, { x: 4, y: 3, z: 0 }, 24);
    const seg = microResimSegment(keyframe, samples, DEFAULT_PARAMS);
    const firstTick = samples[0].tick;
    const lastTick = samples[samples.length - 1].tick;
    // Sample the resim at the 0.25× render cadence: 4 sub-frames per server tick.
    let rendered = 0;
    for (let t = firstTick; t <= lastTick; t += 0.25) if (seg.at(t) !== null) rendered++;
    expect(rendered).toBeGreaterThanOrEqual(4 * samples.length);
    void keyframe;
  });

  it('is deterministic — identical input yields identical re-simulated poses', () => {
    const arc = recordArc('torus', { x: 1, y: 1.5, z: -1 }, { x: -5, y: 4, z: 2 }, 30);
    const a = microResimSegment(arc.keyframe, arc.samples, DEFAULT_PARAMS);
    const b = microResimSegment(arc.keyframe, arc.samples, DEFAULT_PARAMS);
    for (const s of arc.samples) {
      expect(a.at(s.tick)).toEqual(b.at(s.tick));
    }
  });
});

// ---------------------------------------------------------------------------
// DIAL FALLBACK — a segment under an ACTIVE dial lerps + SUPPRESSES the claim.
// ---------------------------------------------------------------------------

describe('replay — active-dial segment falls back to lerp + suppresses the resim line', () => {
  it('a bullet-time (timescale 0.25) segment does NOT claim resim; uses lerp', () => {
    const dialParams = mergeParams(DEFAULT_PARAMS, {
      timescale: 0.25,
      bounds: DIAL_BOUNDS,
      suspendDespawn: true,
    });
    const { samples, keyframe } = recordArc(
      'sphere',
      { x: 0, y: 3, z: 0 },
      { x: 3, y: 2, z: 0 },
      30,
      dialParams
    );

    // The player is told a dial is ACTIVE for this segment.
    const seg = microResimSegment(keyframe, samples, dialParams, { dialActive: true });

    // Claim SUPPRESSED — never a false "re-simulated" line under an active dial.
    expect(seg.resimulated).toBe(false);

    // Fallback = LERP the recorded samples: sampling AT a recorded tick returns
    // that recorded pose; BETWEEN two ticks it linearly interpolates them.
    const s0 = samples[0];
    const s1 = samples[1];
    const atS0 = seg.at(s0.tick);
    expect(atS0!.p.x).toBeCloseTo(s0.p.x, 9);
    const mid = seg.at((s0.tick + s1.tick) / 2);
    expect(mid!.p.x).toBeCloseTo((s0.p.x + s1.p.x) / 2, 9);
  });

  it('a default-params (dial-free) free-flight segment DOES claim resim', () => {
    const { samples, keyframe } = recordArc('cone', { x: 0, y: 2, z: 0 }, { x: 5, y: 4, z: 0 }, 20);
    const seg = microResimSegment(keyframe, samples, DEFAULT_PARAMS, { dialActive: false });
    expect(seg.resimulated).toBe(true);
  });

  it('a GRABBED segment (not free-flight) suppresses the resim claim', () => {
    const { samples, keyframe } = recordArc('cube', { x: 0, y: 2, z: 0 }, { x: 5, y: 4, z: 0 }, 20);
    const held = { ...keyframe, grabbedBy: 'p1' };
    const seg = microResimSegment(held, samples, DEFAULT_PARAMS);
    expect(seg.resimulated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ring buffer — holds ~30 s, evicts oldest, self-snapshots ~1 s keyframes.
// ---------------------------------------------------------------------------

describe('replay — ~30 s ring buffer', () => {
  function sample(tick: number): ReplaySample {
    return { tick, id: 'shapeA', p: { x: tick, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 1, y: 0, z: 0 } };
  }

  it('holds ~30 s of samples and evicts the oldest past the window', () => {
    const ring = new ReplayRing();
    // Push 45 s of samples at 15 Hz (wallTime in ms).
    let tick = 0;
    for (let wall = 0; wall <= 45_000; wall += 66) {
      ring.pushState(wall, [sample(tick)], DEFAULT_PARAMS, false);
      tick += 2;
    }
    const span = ring.spanMs();
    // The retained window is ~30 s (never grows unboundedly to 45 s).
    expect(span).toBeLessThanOrEqual(REPLAY_RING_MS + 1_000);
    expect(span).toBeGreaterThanOrEqual(REPLAY_RING_MS - 2_000);
    // The oldest retained sample is within the last 30 s (older ones evicted).
    expect(ring.oldestWallTime()).toBeGreaterThanOrEqual(45_000 - REPLAY_RING_MS - 1_000);
  });

  it('self-snapshots a keyframe about every 1 s (not every frame)', () => {
    const ring = new ReplayRing();
    let tick = 0;
    for (let wall = 0; wall <= 10_000; wall += 66) {
      ring.pushState(wall, [sample(tick)], DEFAULT_PARAMS, false);
      tick += 2;
    }
    const kfTimes = ring.keyframeWallTimes();
    // ~10 s window → ~10-11 keyframes (one per ~1 s), far fewer than the ~150 frames.
    expect(kfTimes.length).toBeGreaterThanOrEqual(9);
    expect(kfTimes.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < kfTimes.length; i++) {
      expect(kfTimes[i] - kfTimes[i - 1]).toBeGreaterThanOrEqual(REPLAY_KEYFRAME_MS - 100);
    }
  });

  it('records the active-dial flag per frame so the player can gate resim', () => {
    const ring = new ReplayRing();
    ring.pushState(0, [sample(0)], DEFAULT_PARAMS, false);
    ring.pushState(66, [sample(2)], mergeParams(DEFAULT_PARAMS, { timescale: 0.25 }), true);
    const seg = ring.extractLast(200); // last 200 ms
    // The window saw an active dial → the extracted segment is dial-flagged.
    expect(seg.dialActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ReplayPlayer — plays a ring window at 0.25× through per-tick resim/lerp.
// ---------------------------------------------------------------------------

describe('replay — ReplayPlayer (0.25× playback + auto-return)', () => {
  it('plays a free-flight window at 0.25× and reports resimulated=true', () => {
    const ring = new ReplayRing();
    const arc = recordArc('icosahedron', { x: -2, y: 1.5, z: 0 }, { x: 5, y: 5, z: 0 }, 30);
    // Feed the recorded arc into the ring at 15 Hz.
    let wall = 0;
    for (const s of arc.samples) {
      ring.pushState(wall, [s], DEFAULT_PARAMS, false, { [s.id]: arc.keyframe });
      wall += 66;
    }
    const player = new ReplayPlayer(ring.extractLast(2_000));
    expect(player.resimulated).toBe(true);
    // Advancing at 0.25× consumes 1 s of playback per 4 s of wall.
    const before = player.headMs;
    player.advance(400 /* wall ms */);
    expect(player.headMs - before).toBeCloseTo(100, 6); // 0.25× rate
    // A pose is available for the current head.
    expect(player.poseFor('shapeA')).not.toBeNull();
  });

  it('auto-returns after its playback window (finished flips true)', () => {
    const ring = new ReplayRing();
    const arc = recordArc('cube', { x: 0, y: 2, z: 0 }, { x: 3, y: 3, z: 0 }, 12);
    let wall = 0;
    for (const s of arc.samples) {
      ring.pushState(wall, [s], DEFAULT_PARAMS, false, { [s.id]: arc.keyframe });
      wall += 66;
    }
    const player = new ReplayPlayer(ring.extractLast(1_000));
    expect(player.finished).toBe(false);
    // Advance well past window / 0.25× (4× the window duration in wall time).
    player.advance(1_000 * 4 + 100);
    expect(player.finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Namespacing — replay ids never collide with live shape ids.
// ---------------------------------------------------------------------------

describe('replay — entity namespacing', () => {
  it('namespaces a live id into a replay id that never equals the live id', () => {
    for (const id of ['shapeA', 'x', 'replay', 'r::123']) {
      const ns = namespaceReplayId(id);
      expect(ns).not.toBe(id);
      expect(ns.startsWith(REPLAY_ID_PREFIX)).toBe(true);
      expect(isReplayId(ns)).toBe(true);
      expect(isReplayId(id)).toBe(false);
    }
  });

  it('the player exposes namespaced pose ids (no collision with live shapes)', () => {
    const ring = new ReplayRing();
    const arc = recordArc('cube', { x: 0, y: 2, z: 0 }, { x: 3, y: 3, z: 0 }, 12);
    let wall = 0;
    for (const s of arc.samples) {
      ring.pushState(wall, [s], DEFAULT_PARAMS, false, { [s.id]: arc.keyframe });
      wall += 66;
    }
    const player = new ReplayPlayer(ring.extractLast(1_000));
    const ids = player.namespacedIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isReplayId(id)).toBe(true);
      expect(id).not.toBe('shapeA'); // never the LIVE id
    }
  });
});

// ---------------------------------------------------------------------------
// Highlight scorer — over REAL signals, SHARED single-source (from stageBrain).
// ---------------------------------------------------------------------------

describe('replay — highlight scorer (SHARED, single-source)', () => {
  it('the scorer IS the shared stageBrain scorer (import identity — no duplicate)', () => {
    expect(scoreHighlight).toBe(scoreFromStageBrain);
  });

  it('picks a top-decile floor slam over ambient noise (non-vacuous)', () => {
    // A window of ordinary low-speed impacts + one huge slam.
    const events = [
      ...Array.from({ length: 20 }, (_, i) => ({ kind: 'impact' as const, id: `n${i}`, speed: 2 + (i % 3) })),
      { kind: 'impact' as const, id: 'slam', speed: 22 }, // top-decile floor slam
    ];
    const best = scoreHighlight(events);
    expect(best).not.toBeNull();
    expect(best!.kind).toBe('SLAM');
    expect(best!.targetId).toBe('slam');
    // A pure ambient window with no standout scores lower than the slam window.
    const quiet = scoreHighlight(Array.from({ length: 20 }, (_, i) => ({ kind: 'impact' as const, id: `q${i}`, speed: 2 })));
    expect(best!.score).toBeGreaterThan(quiet?.score ?? 0);
  });

  it('picks a long-arc throw (high release velocity)', () => {
    const events = [
      { kind: 'release' as const, id: 'gentle', peerId: 'p1', speed: 3 },
      { kind: 'release' as const, id: 'bomb', peerId: 'p2', speed: 18 }, // long arc
    ];
    const best = scoreHighlight(events);
    expect(best).not.toBeNull();
    expect(best!.kind).toBe('THROW');
    expect(best!.targetId).toBe('bomb');
  });

  it('picks a shape-rain burst (many spawns in the window)', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ kind: 'spawn' as const, id: `s${i}` }));
    const best = scoreHighlight(events);
    expect(best).not.toBeNull();
    expect(best!.kind).toBe('SHAPE_RAIN');
  });

  it('a grab duel is scored ONLY when a GRAB_REJECTED signal is present', () => {
    // Two grabs on one shape WITHOUT a rejection → NOT a duel.
    const noReject = scoreHighlight([
      { kind: 'grab', id: 's1', peerId: 'p1' },
      { kind: 'grab', id: 's1', peerId: 'p2' },
    ]);
    expect(noReject?.kind).not.toBe('GRAB_DUEL');

    // WITH a GRAB_REJECTED → a duel is eligible.
    const withReject = scoreHighlight([
      { kind: 'grab', id: 's1', peerId: 'p1' },
      { kind: 'grab-rejected', id: 's1', peerId: 'p2', by: 'p1' },
    ]);
    expect(withReject).not.toBeNull();
    expect(withReject!.kind).toBe('GRAB_DUEL');
  });

  it('returns null for an under-threshold (idle) window — staff never airs idle bobbing', () => {
    const idle = scoreHighlight([
      { kind: 'grab', id: 's1', peerId: 'p1' },
      { kind: 'impact', id: 's1', speed: 1 }, // below the min-activity floor
    ]);
    expect(idle).toBeNull();
  });

  it('is deterministic — same window → same winner', () => {
    const window = [
      { kind: 'impact' as const, id: 'a', speed: 15 },
      { kind: 'release' as const, id: 'b', peerId: 'p1', speed: 9 },
    ];
    expect(scoreHighlight(window)).toEqual(scoreHighlight(window));
  });
});

// ===========================================================================
// C29 (F18 X-Ray Broadcast, spec §7.18) — DelayFifoSource: the pure delay-FIFO
// shim BESIDE the ring buffer. This file stays shared-only (no client import) —
// the FULL equivalence proof against the real, FROZEN `createInterpolator`
// lives in `packages/client/test/xray.test.ts` (the one place both may be
// imported together). What's proven HERE is the shim's own pure guarantee: a
// frame pushed at time t is emitted no earlier than t + delayMs, in FIFO order,
// never dropped/reordered — the property the interpolator-level equivalence is
// built on (linear interpolation is shift-invariant under a uniform delay).
// ===========================================================================

describe('C29 DelayFifoSource — pure delay-FIFO (no client import)', () => {
  it('defaults to the spec §7.18 ghost delay (300 ms)', () => {
    const src = new DelayFifoSource<string>();
    expect(src.delay).toBe(300);
    expect(XRAY_GHOST_DELAY_MS).toBe(300);
  });

  it('does not emit a pushed frame before its due time (push at t, tick before t+delay)', () => {
    const src = new DelayFifoSource<string>(300);
    const seen: string[] = [];
    src.onState((f) => seen.push(f));
    src.push('a', 1000);
    src.tick(1299); // 1 ms short of due
    expect(seen).toEqual([]);
    expect(src.pending()).toBe(1);
  });

  it('emits exactly at (and past) the due time', () => {
    const src = new DelayFifoSource<string>(300);
    const seen: string[] = [];
    src.onState((f) => seen.push(f));
    src.push('a', 1000);
    src.tick(1300); // exactly due
    expect(seen).toEqual(['a']);
    expect(src.pending()).toBe(0);
  });

  it('preserves FIFO order across multiple pushes, never reordering', () => {
    const src = new DelayFifoSource<number>(300);
    const seen: number[] = [];
    src.onState((f) => seen.push(f));
    src.push(1, 1000);
    src.push(2, 1050);
    src.push(3, 1100);
    src.tick(1500); // all three are due
    expect(seen).toEqual([1, 2, 3]);
  });

  it('emits only the frames due so far, holding the rest queued (a live delay window)', () => {
    const src = new DelayFifoSource<number>(300);
    const seen: number[] = [];
    src.onState((f) => seen.push(f));
    src.push(1, 1000); // due at 1300
    src.push(2, 1200); // due at 1500
    src.tick(1300);
    expect(seen).toEqual([1]);
    expect(src.pending()).toBe(1);
    src.tick(1500);
    expect(seen).toEqual([1, 2]);
    expect(src.pending()).toBe(0);
  });

  it('never drops a frame — every pushed frame is eventually emitted exactly once', () => {
    const src = new DelayFifoSource<number>(50);
    const seen: number[] = [];
    src.onState((f) => seen.push(f));
    for (let i = 0; i < 20; i++) src.push(i, i * 10);
    // Advance in small steps (never one giant leap) — simulates a render loop.
    for (let t = 0; t <= 400; t += 17) src.tick(t);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('supports multiple independent listeners (both receive every frame)', () => {
    const src = new DelayFifoSource<string>(100);
    const a: string[] = [];
    const b: string[] = [];
    src.onState((f) => a.push(f));
    const unsubB = src.onState((f) => b.push(f));
    src.push('x', 0);
    src.tick(100);
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
    unsubB();
    src.push('y', 100);
    src.tick(200);
    expect(a).toEqual(['x', 'y']);
    expect(b).toEqual(['x']); // unsubscribed — never receives 'y'
  });

  it('clear() drops queued frames without emitting them (a mode-switch reset)', () => {
    const src = new DelayFifoSource<string>(300);
    const seen: string[] = [];
    src.onState((f) => seen.push(f));
    src.push('a', 1000);
    src.clear();
    expect(src.pending()).toBe(0);
    src.tick(2000);
    expect(seen).toEqual([]); // never emitted — dropped by clear()
  });

  it('is a generic, opaque-frame source — never inspects frame contents (Three-free, pure)', () => {
    // A structural object frame (mirrors the shape of a client StateFrame) passes
    // through completely untouched — the shim never reads/mutates it.
    interface Frame {
      shapes: Array<{ id: string; p: { x: number; y: number; z: number } }>;
    }
    const src = new DelayFifoSource<Frame>(10);
    let received: Frame | null = null;
    src.onState((f) => (received = f));
    const frame: Frame = { shapes: [{ id: 's1', p: { x: 1, y: 2, z: 3 } }] };
    src.push(frame, 0);
    src.tick(10);
    expect(received).toBe(frame); // same object identity — never cloned/mutated
  });
});

// ===========================================================================
// C30 (F19 Pocket DVR, spec §7.19) — the client scrub/rewind DVR on the C21
// ring buffer + micro-resim. PURE — no client import, no Date, injected time.
//
// The §14 FLEX GATE keystone (FIRST): a 5 Hz-DECIMATED synthetic throw fixture
// (position-only, like the real `wisp-coalesced` fan-out) that CONTAINS the
// release event with {pos, vel} re-simulates to endpoint-ε — the "rewind the
// broadcast" copy is FORBIDDEN until this is green (else it demotes to "scrub
// the broadcast" with plain interpolation). The release {pos, vel} is the §3
// fifth accommodation field — Step 0 verified the wisp fan-out preserves it and
// additively preserves it for audience.
// ===========================================================================

/**
 * Simulate a throw the SERVER way (stepBody @ SIM_DT, 30 Hz) and return a
 * DECIMATED 5 Hz stream (every 6th tick — 30 Hz / 6 = 5 Hz, matching
 * `WISP_COALESCE_EVERY`) that is POSITION-ONLY (velocity zeroed on the wire, like
 * the real `wisp-coalesced` head-only summary), PLUS the release event carrying
 * the authoritative {pos, vel} (accommodation #5) and the full-rate ground truth.
 */
function decimatedThrow(
  type: ShapeType,
  p0: Vec3,
  v0: Vec3,
  ticks: number,
  decimateEvery = 6
): { decimated: ReplaySample[]; release: DvrReleaseSeed; truth: ReplaySample[] } {
  const b = body(type, p0, v0);
  const release: DvrReleaseSeed = { tick: 0, id: 'shapeA', p: { ...p0 }, v: { ...v0 } };
  const decimated: ReplaySample[] = [];
  const truth: ReplaySample[] = [];
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  const rec = (tick: number): void => {
    truth.push({ tick, id: 'shapeA', p: { ...b.position }, r: { ...zero }, v: { ...b.velocity } });
    // The decimated wire carries POSITION ONLY — velocity is NOT sent (head-only).
    if (tick % decimateEvery === 0) {
      decimated.push({ tick, id: 'shapeA', p: { ...b.position }, r: { ...zero }, v: { ...zero } });
    }
  };
  rec(0);
  for (let t = 1; t <= ticks; t++) {
    stepBody(b, SIM_DT, DEFAULT_PARAMS);
    rec(t);
  }
  return { decimated, release, truth };
}

const DVR_EPS = 1e-6; // endpoint-ε on the decimated fixture (same stepBody, same grid).

describe('C30 Pocket DVR — §14 KEYSTONE: decimated-stream resim endpoint-ε', () => {
  it('a 5 Hz-decimated throw fixture CONTAINS the release event with {pos, vel}', () => {
    const { decimated, release } = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 42);
    // The fixture is genuinely decimated (5 Hz ≪ 30 Hz) and carries the release.
    expect(decimated.length).toBeLessThan(43 / 6 + 2);
    expect(release.p).toEqual({ x: -3, y: 1.2, z: 0 });
    expect(release.v).toEqual({ x: 6, y: 5, z: 1.5 });
    // Decimated samples are POSITION-ONLY — velocity is zeroed on the wire.
    for (const s of decimated) expect(s.v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('micro-resim seeded FROM the release {pos, vel} matches the decimated trajectory to endpoint-ε (the flex gate)', () => {
    const { decimated, release, truth } = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 42);
    const kf = keyframeFromRelease(release, 'icosahedron', 1);
    const seg = microResimSegment(kf, decimated, DEFAULT_PARAMS);

    // It CLAIMS resim (free-flight seed, dial-free) — only then is "rewind" aired.
    expect(seg.resimulated).toBe(true);

    // ENDPOINT-ε: the resim pose at the last decimated tick matches the recorded
    // (server-truth) position within ε — the §14 gate for "rewind the broadcast".
    const lastTick = decimated[decimated.length - 1].tick;
    const rp = seg.at(lastTick);
    const truthAtLast = truth.find((t) => t.tick === lastTick)!;
    expect(rp).not.toBeNull();
    expect(Math.abs(rp!.p.x - truthAtLast.p.x)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp!.p.y - truthAtLast.p.y)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp!.p.z - truthAtLast.p.z)).toBeLessThan(DVR_EPS);

    // And EVERY decimated sample tick matches its resim pose to ε (whole arc).
    for (const s of decimated) {
      const pose = seg.at(s.tick)!;
      expect(Math.abs(pose.p.x - s.p.x)).toBeLessThan(DVR_EPS);
      expect(Math.abs(pose.p.y - s.p.y)).toBeLessThan(DVR_EPS);
      expect(Math.abs(pose.p.z - s.p.z)).toBeLessThan(DVR_EPS);
    }
  });

  it('the release {pos, vel} is LOAD-BEARING — seeding from the position-only 5 Hz sample (no velocity) diverges', () => {
    const { decimated } = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 42);
    // Seed a keyframe from the FIRST decimated sample — which has ZEROED velocity
    // (the wire dropped it). Re-stepping from v=0 cannot reproduce the arc.
    const bad = keyframeFromRelease(
      { tick: decimated[0].tick, id: 'shapeA', p: { ...decimated[0].p }, v: { ...decimated[0].v } },
      'icosahedron',
      1
    );
    const seg = microResimSegment(bad, decimated, DEFAULT_PARAMS);
    const lastTick = decimated[decimated.length - 1].tick;
    const rp = seg.at(lastTick)!;
    const last = decimated[decimated.length - 1];
    // WITHOUT the release velocity the endpoint is badly wrong (proving the seed).
    const err = Math.abs(rp.p.x - last.p.x) + Math.abs(rp.p.y - last.p.y) + Math.abs(rp.p.z - last.p.z);
    expect(err).toBeGreaterThan(1); // gross divergence, not ε
  });
});

// ===========================================================================
// C30 REVIEW MF2 (spec §14, live data) — the resim must anchor at the ACTUAL
// release tick, not the first CARRIED sample. On live data a shape is carried
// (in hand, moving) for seconds before release; the coalesced stream carries
// those pre-release positions. Seeding the release {pos, vel} at the FIRST sample
// (as the pre-fix code did) over-integrates by (releaseTick − firstSampleTick)
// ticks, breaking the §14 endpoint-ε and falsely claiming resim over the carried
// window. Every prior fixture released at sample[0], hiding the defect.
// ===========================================================================

/**
 * A LIVE-LIKE decimated track: the shape is CARRIED (in hand, moving on a linear
 * hand path) up to `releaseTick`, THEN released into free flight. Mirrors the real
 * wisp-coalesced stream (which carries a grabbed shape's positions before release).
 * Returns the POSITION-ONLY decimated samples (carried + ballistic), the release
 * seed at the ACTUAL release tick, and the ballistic ground truth.
 */
function carriedThenReleasedThrow(
  type: ShapeType,
  carriedStart: Vec3,
  carriedVel: Vec3,
  releaseTick: number,
  v0: Vec3,
  ballisticTicks: number,
  decimateEvery = 6
): { decimated: ReplaySample[]; release: DvrReleaseSeed; truth: ReplaySample[] } {
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  const decimated: ReplaySample[] = [];
  const carriedAt = (t: number): Vec3 => ({
    x: carriedStart.x + carriedVel.x * t * SIM_DT,
    y: carriedStart.y + carriedVel.y * t * SIM_DT,
    z: carriedStart.z + carriedVel.z * t * SIM_DT,
  });
  // Phase 1 — CARRIED (in hand): position-only samples on a linear hand path.
  for (let t = 0; t < releaseTick; t += decimateEvery) {
    decimated.push({ tick: t, id: 'shapeA', p: carriedAt(t), r: { ...zero }, v: { ...zero } });
  }
  const releasePos = carriedAt(releaseTick);
  const release: DvrReleaseSeed = { tick: releaseTick, id: 'shapeA', p: { ...releasePos }, v: { ...v0 } };
  // Phase 2 — BALLISTIC: stepBody forward from the release {pos, vel}.
  const b = body(type, releasePos, v0);
  const truth: ReplaySample[] = [];
  const rec = (tick: number): void => {
    truth.push({ tick, id: 'shapeA', p: { ...b.position }, r: { ...zero }, v: { ...b.velocity } });
    if ((tick - releaseTick) % decimateEvery === 0) {
      decimated.push({ tick, id: 'shapeA', p: { ...b.position }, r: { ...zero }, v: { ...zero } });
    }
  };
  rec(releaseTick);
  for (let i = 1; i <= ballisticTicks; i++) {
    stepBody(b, SIM_DT, DEFAULT_PARAMS);
    rec(releaseTick + i);
  }
  return { decimated, release, truth };
}

describe('C30 Pocket DVR — MF2 live-like carried-then-released resim (the real §14 property)', () => {
  it('anchors the resim at the REAL release tick; endpoint matches server-truth < 1e-6; resimulated ONLY post-release', () => {
    const { decimated, release, truth } = carriedThenReleasedThrow(
      'icosahedron',
      { x: -2, y: 1, z: 0 },
      { x: 1, y: 0.5, z: 0 },
      18, // carried ~0.6 s BEFORE release (ticks 0,6,12 carried; release at 18)
      { x: 6, y: 5, z: 1.5 },
      24
    );
    const kf = keyframeFromRelease(release, 'icosahedron', 1);
    const seg = microResimSegment(kf, decimated, DEFAULT_PARAMS);

    expect(seg.resimulated).toBe(true);

    // resimulated ONLY inside the post-release ballistic window.
    expect(seg.resimulatedAt(0)).toBe(false);
    expect(seg.resimulatedAt(6)).toBe(false);
    expect(seg.resimulatedAt(12)).toBe(false);
    expect(seg.resimulatedAt(18)).toBe(true);
    expect(seg.resimulatedAt(24)).toBe(true);

    // ENDPOINT-ε (the real §14 gate): the resim at the last ballistic tick matches
    // server-truth < 1e-6. This FAILS on the pre-fix code (which seeded the release
    // at tick 0 and over-integrated the whole carried+ballistic span).
    const lastTick = decimated[decimated.length - 1].tick;
    const rp = seg.at(lastTick)!;
    const truthLast = truth.find((t) => t.tick === lastTick)!;
    expect(Math.abs(rp.p.x - truthLast.p.x)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp.p.y - truthLast.p.y)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp.p.z - truthLast.p.z)).toBeLessThan(DVR_EPS);

    // EVERY post-release decimated sample matches its resim pose to ε (whole arc).
    for (const s of decimated) {
      if (s.tick < release.tick) continue;
      const pose = seg.at(s.tick)!;
      expect(Math.abs(pose.p.x - s.p.x)).toBeLessThan(DVR_EPS);
      expect(Math.abs(pose.p.y - s.p.y)).toBeLessThan(DVR_EPS);
      expect(Math.abs(pose.p.z - s.p.z)).toBeLessThan(DVR_EPS);
    }

    // A pre-release (carried) tick is played from the recorded IN-HAND sample —
    // NOT the ballistic resim (the carried window is never falsely re-simulated).
    const carried = seg.at(6)!;
    const carriedSample = decimated.find((s) => s.tick === 6)!;
    expect(carried.p).toEqual(carriedSample.p);
  });

  it('the decimated keystone (release at sample[0]) stays green — unchanged behavior', () => {
    const { decimated, release, truth } = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 42);
    const seg = microResimSegment(keyframeFromRelease(release, 'icosahedron', 1), decimated, DEFAULT_PARAMS);
    expect(seg.resimulated).toBe(true);
    expect(seg.resimulatedAt(0)).toBe(true); // release IS at sample[0] here.
    const lastTick = decimated[decimated.length - 1].tick;
    const rp = seg.at(lastTick)!;
    const truthLast = truth.find((t) => t.tick === lastTick)!;
    expect(Math.abs(rp.p.x - truthLast.p.x)).toBeLessThan(DVR_EPS);
  });

  it('MF2 — ring-cap eviction trimming the release sample still anchors at the release tick (from the seed)', () => {
    const { decimated, release, truth } = carriedThenReleasedThrow(
      'icosahedron', { x: -2, y: 1, z: 0 }, { x: 1, y: 0.5, z: 0 }, 18, { x: 6, y: 5, z: 1.5 }, 24
    );
    // Front-eviction removes the carried + release-tick samples; only POST-release
    // ballistic samples remain. The anchor comes from the SEED (release.tick), not
    // the retained samples — so the arc still resims correctly (no silent mis-seed
    // at the new oldest sample).
    const trimmed = decimated.filter((s) => s.tick > release.tick);
    const seg = microResimSegment(keyframeFromRelease(release, 'icosahedron', 1), trimmed, DEFAULT_PARAMS);
    expect(seg.resimulated).toBe(true);
    const lastTick = trimmed[trimmed.length - 1].tick;
    const rp = seg.at(lastTick)!;
    const truthLast = truth.find((t) => t.tick === lastTick)!;
    expect(Math.abs(rp.p.x - truthLast.p.x)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp.p.y - truthLast.p.y)).toBeLessThan(DVR_EPS);
    expect(Math.abs(rp.p.z - truthLast.p.z)).toBeLessThan(DVR_EPS);
  });

  it('MF2 — when eviction trims EVERY post-release sample, the resim REFUSES (no silent mis-seed)', () => {
    const { decimated, release } = carriedThenReleasedThrow(
      'icosahedron', { x: -2, y: 1, z: 0 }, { x: 1, y: 0.5, z: 0 }, 18, { x: 6, y: 5, z: 1.5 }, 24
    );
    // Only PRE-release carried samples remain (all tick < releaseTick) → no
    // ballistic window forward of the anchor → REFUSE (lerp fallback, no claim).
    const carriedOnly = decimated.filter((s) => s.tick < release.tick);
    const seg = microResimSegment(keyframeFromRelease(release, 'icosahedron', 1), carriedOnly, DEFAULT_PARAMS);
    expect(seg.resimulated).toBe(false);
    expect(seg.resimulatedAt(24)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PocketDvr — drain-forward resume, eviction, yield-to-live, badge, speed, gaps.
// ---------------------------------------------------------------------------

function posSample(tick: number, id = 'shapeA', x = tick): ReplaySample {
  return { tick, id, p: { x, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
}

describe('C30 Pocket DVR — constants', () => {
  it('60 s ring, 10 s idle auto-return, 1× default / 0.25× slow', () => {
    expect(DVR_RING_MS).toBe(60_000);
    expect(DVR_IDLE_RETURN_MS).toBe(10_000);
    expect(DVR_SPEED_NORMAL).toBe(1);
    expect(DVR_SPEED_SLOW).toBeCloseTo(0.25, 12);
  });
});

describe('C30 Pocket DVR — drain-forward resume (NO server round-trip)', () => {
  it('a paused client keeps buffering and jump-to-live converges WITHOUT a server round-trip', () => {
    const dvr = new PocketDvr('wisp');
    let wall = 0;
    let tick = 0;
    for (let i = 0; i < 10; i++) {
      dvr.push(wall, [posSample(tick)]);
      wall += 200; // 5 Hz
      tick += 6;
    }
    // Scrub back into the past — now paused/rewound.
    dvr.scrubTo(400, wall);
    expect(dvr.isLive).toBe(false);

    // The client KEEPS consuming + buffering while paused (zero marginal fan-out).
    for (let i = 0; i < 6; i++) {
      dvr.push(wall, [posSample(tick)]);
      wall += 200;
      tick += 6;
    }
    const live = dvr.liveWall();

    // Jump-to-live: DRAIN the buffered ring FORWARD — never a REQUEST_SNAPSHOT.
    dvr.jumpToLive();
    expect(dvr.isLive).toBe(true);
    expect(dvr.headWall()).toBeNull();
    expect(dvr.serverRoundTrips).toBe(0); // converged with ZERO server round-trips
    expect(dvr.liveWall()).toBe(live); // the buffered newest IS live
  });

  it('is a non-spectator (wisp/audience) surface — REQUEST_SNAPSHOT never fires', () => {
    for (const tier of ['wisp', 'audience'] as const) {
      const dvr = new PocketDvr(tier);
      dvr.push(0, [posSample(0)]);
      dvr.push(200, [posSample(6)]);
      dvr.scrubTo(0, 200);
      dvr.jumpToLive();
      expect(dvr.serverRoundTrips).toBe(0);
      expect(dvr.tier).toBe(tier);
    }
  });
});

describe('C30 Pocket DVR — ring-cap eviction trims the scrub range from the BACK', () => {
  it('eviction advances the oldest scrubbable edge and clamps a rewound head forward', () => {
    const dvr = new PocketDvr('wisp', { ringMs: 2_000 });
    let wall = 0;
    let tick = 0;
    for (; wall <= 1_000; wall += 200) {
      dvr.push(wall, [posSample(tick)]);
      tick += 6;
    }
    // Scrub to the OLDEST retained frame (the far end of the rewind range).
    dvr.scrubTo(0, 1_000);
    expect(dvr.oldestWall()).toBe(0);
    expect(dvr.headWall()).toBe(0);

    // Keep buffering past the 2 s ring cap → the oldest frames evict (from the back).
    for (; wall <= 3_000; wall += 200) {
      dvr.push(wall, [posSample(tick)]);
      tick += 6;
    }
    expect(dvr.oldestWall()).toBeGreaterThan(0); // the back was trimmed
    // The rewound head can no longer sit before the new oldest edge.
    expect(dvr.headWall()!).toBeGreaterThanOrEqual(dvr.oldestWall());
  });

  it('scrubbing before the oldest retained frame clamps to the oldest edge', () => {
    const dvr = new PocketDvr('wisp', { ringMs: 2_000 });
    for (let wall = 2_000; wall <= 4_000; wall += 200) dvr.push(wall, [posSample(wall)]);
    const oldest = dvr.oldestWall();
    dvr.scrubTo(oldest - 5_000, 4_000); // way before the buffer
    expect(dvr.headWall()).toBe(oldest);
  });
});

describe('C30 Pocket DVR — yield-to-live (booth-critical) + idle auto-return', () => {
  function scrubbed(): PocketDvr {
    const dvr = new PocketDvr('wisp');
    for (let wall = 0; wall <= 2_000; wall += 200) dvr.push(wall, [posSample(wall)]);
    dvr.scrubTo(400, 2_000);
    return dvr;
  }

  for (const sig of ['SHOWPIECE_START', 'CHARGE_START', 'VOTE_OPEN'] as const) {
    it(`${sig} auto-snaps a scrubbed viewer to live within one frame (banner set)`, () => {
      const dvr = scrubbed();
      expect(dvr.isLive).toBe(false);
      dvr.onYieldSignal(sig);
      expect(dvr.isLive).toBe(true); // snapped THIS frame
      expect(dvr.yieldBanner()).toBe(sig);
      dvr.clearBanner();
      expect(dvr.yieldBanner()).toBeNull();
    });
  }

  it('~10 s idle auto-returns to live; a fresh scrub interaction resets the timer', () => {
    const dvr = new PocketDvr('wisp');
    for (let wall = 0; wall <= 2_000; wall += 200) dvr.push(wall, [posSample(wall)]);
    dvr.scrubTo(400, 1_000);
    dvr.tick(1_000 + DVR_IDLE_RETURN_MS - 1); // just under 10 s
    expect(dvr.isLive).toBe(false);
    dvr.tick(1_000 + DVR_IDLE_RETURN_MS); // 10 s idle
    expect(dvr.isLive).toBe(true);
  });
});

describe('C30 Pocket DVR — mandatory REWOUND badge + speed scoping', () => {
  it('shows "REWOUND // T-6.2s" when scrubbed, nothing at live', () => {
    const dvr = new PocketDvr('wisp');
    for (let wall = 0; wall <= 10_000; wall += 200) dvr.push(wall, [posSample(wall)]);
    // newest = 10000; scrub to 3800 → 6.2 s behind live.
    dvr.scrubTo(3_800, 10_000);
    const badge = dvr.badge();
    expect(badge.rewound).toBe(true);
    expect(badge.offsetSec).toBeCloseTo(6.2, 6);
    expect(badge.text).toBe('REWOUND // T-6.2s');
    // At live the badge is not shown (a live phone is never labelled REWOUND).
    dvr.jumpToLive();
    expect(dvr.badge().rewound).toBe(false);
  });

  it('default speed is 1×; 0.25× engages ONLY inside a resimmed ballistic segment', () => {
    const dvr = new PocketDvr('wisp');
    // A free-flight throw, decimated into the ring; the release seeds the resim.
    const { decimated, release } = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 42);
    dvr.setShapeMeta('shapeA', 'icosahedron', 1);
    dvr.onRelease(release);
    // Feed the decimated 5 Hz samples into the ring at their tick walls.
    for (const s of decimated) dvr.push(s.tick * SIM_DT * 1000, [s]);

    // At live → 1× (never slow-mo the live world).
    expect(dvr.speed()).toBe(DVR_SPEED_NORMAL);

    // Scrub INTO the ballistic arc → 0.25× (resimmed segment).
    const midTick = decimated[Math.floor(decimated.length / 2)].tick;
    dvr.scrubTo(midTick * SIM_DT * 1000, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_SLOW);
  });
});

describe('C30 Pocket DVR — namespace isolation (no leak into the live scene)', () => {
  it('a scrubbed replay only ever exposes NAMESPACED ids — never a live shape id', () => {
    const dvr = new PocketDvr('wisp');
    const { decimated, release } = decimatedThrow('cube', { x: 0, y: 2, z: 0 }, { x: 4, y: 4, z: 0 }, 30);
    dvr.setShapeMeta('shapeA', 'cube', 1);
    dvr.onRelease(release);
    for (const s of decimated) dvr.push(s.tick * SIM_DT * 1000, [s]);
    dvr.scrubTo(decimated[3].tick * SIM_DT * 1000, 999_999);

    const poses = dvr.poses();
    expect(poses.length).toBeGreaterThan(0);
    for (const { id } of poses) {
      expect(isReplayId(id)).toBe(true); // replay:: namespaced
      expect(id).not.toBe('shapeA'); // NEVER the live id
      expect(id.startsWith(REPLAY_ID_PREFIX)).toBe(true);
    }
  });
});

describe('C30 Pocket DVR — timeline gap shading (§5.3 background-tab stalls)', () => {
  it('reports a background-tab gap between contiguous frames as a shaded span', () => {
    const dvr = new PocketDvr('wisp');
    dvr.push(0, [posSample(0)]);
    dvr.push(200, [posSample(6)]);
    dvr.push(400, [posSample(12)]);
    // Background-tab stall: no frames for ~4.6 s (the §5.3 gap).
    dvr.push(5_000, [posSample(18)]);
    dvr.push(5_200, [posSample(24)]);
    const gaps = dvr.gaps(1_000);
    expect(gaps.length).toBe(1);
    expect(gaps[0].from).toBe(400);
    expect(gaps[0].to).toBe(5_000);
  });
});

describe('C30 Pocket DVR — memory: 60 s ring at wisp rates < ~1 MB', () => {
  it('a 60 s wisp-rate ring (5 Hz, position-only, room-sized) stays under ~1 MB', () => {
    const dvr = new PocketDvr('wisp'); // 60 s ring
    const SHAPES = 16; // a busy room's moving shapes
    let tick = 0;
    for (let wall = 0; wall <= 60_000; wall += 200) {
      const samples: ReplaySample[] = [];
      for (let i = 0; i < SHAPES; i++) {
        samples.push({ tick, id: `s${i}`, p: { x: i, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } });
      }
      dvr.push(wall, samples);
      tick += 6;
    }
    expect(dvr.frameCount()).toBeGreaterThan(250); // ~300 frames retained
    expect(dvr.approxBytes()).toBeLessThan(1024 * 1024); // < ~1 MB
  });
});

// ===========================================================================
// C30 FOLD-INS — 0.25× confinement (post-MF2) + serverRoundTrips real counter.
// ===========================================================================

describe('C30 Pocket DVR — FOLD: 0.25× confined to the ballistic window (post-MF2)', () => {
  it('a PRE-RELEASE carried head is 1×; only the release→landing ballistic head is 0.25×', () => {
    const dvr = new PocketDvr('wisp');
    const { decimated, release } = carriedThenReleasedThrow(
      'icosahedron', { x: -2, y: 1, z: 0 }, { x: 1, y: 0.5, z: 0 }, 18, { x: 6, y: 5, z: 1.5 }, 24
    );
    dvr.setShapeMeta('shapeA', 'icosahedron', 1);
    dvr.onRelease(release);
    for (const s of decimated) dvr.push(s.tick * SIM_DT * 1000, [s]);

    // Live → 1×.
    expect(dvr.speed()).toBe(DVR_SPEED_NORMAL);
    // A PRE-RELEASE carried tick (6 < release 18) → 1× (never slow-mo the carry).
    dvr.scrubTo(6 * SIM_DT * 1000, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_NORMAL);
    // A ballistic (post-release) tick → 0.25×.
    dvr.scrubTo(24 * SIM_DT * 1000, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_SLOW);
  });

  it('multi-shape: 0.25× only when the head is in THAT shape’s ballistic window (no false positive from another shape spanning the head)', () => {
    const dvr = new PocketDvr('wisp');
    // shapeA — released at tick 0, SHORT ballistic (ticks 0,6,12 → walls 0,200,400).
    const A = decimatedThrow('icosahedron', { x: -3, y: 1.2, z: 0 }, { x: 6, y: 5, z: 1.5 }, 12);
    dvr.setShapeMeta('shapeA', 'icosahedron', 1);
    dvr.onRelease(A.release);
    for (const s of A.decimated) dvr.push(s.tick * SIM_DT * 1000, [s]);
    // shapeB — CARRIED until tick 30 then ballistic; its FULL track spans walls 0..~1400.
    const Braw = carriedThenReleasedThrow('cube', { x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 30, { x: 4, y: 4, z: 0 }, 18);
    dvr.setShapeMeta('shapeB', 'cube', 1);
    dvr.onRelease({ ...Braw.release, id: 'shapeB' });
    for (const s of Braw.decimated) dvr.push(s.tick * SIM_DT * 1000, [{ ...s, id: 'shapeB' }]);

    // Head at wall 500: PAST shapeA's ballistic window [0,400] and INSIDE shapeB's
    // CARRIED (pre-release) region — no shape's BALLISTIC window contains it → 1×.
    // (Pre-fix, shapeB's full track straddling 500 falsely lit 0.25×.)
    dvr.scrubTo(500, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_NORMAL);

    // Head inside shapeA's ballistic window → 0.25×.
    dvr.scrubTo(200, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_SLOW);

    // Head inside shapeB's ballistic window (tick ≥ 30 → wall ≥ 1000) → 0.25×.
    dvr.scrubTo(36 * SIM_DT * 1000, 999_999);
    expect(dvr.speed()).toBe(DVR_SPEED_SLOW);
  });
});

describe('C30 Pocket DVR — FOLD: serverRoundTrips is a REAL counter (not a tautology)', () => {
  it('stays 0 across a WARM-ring drain-forward resume, but increments on a COLD-ring resume', () => {
    // Warm ring → drain-forward converges with ZERO server round-trips.
    const warm = new PocketDvr('wisp');
    let tick = 0;
    for (let wall = 0; wall <= 1_000; wall += 200) {
      warm.push(wall, [posSample(tick)]);
      tick += 6;
    }
    warm.scrubTo(0, 1_000);
    warm.jumpToLive();
    expect(warm.serverRoundTrips).toBe(0);

    // COLD ring (nothing buffered to drain) → the resume meets the snapshot-required
    // condition, proving the counter genuinely MUTATES (a hardcoded 0 could not).
    const cold = new PocketDvr('wisp');
    expect(cold.serverRoundTrips).toBe(0);
    cold.jumpToLive();
    expect(cold.serverRoundTrips).toBe(1);
  });
});
