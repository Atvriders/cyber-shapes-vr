/**
 * reels.test.ts — F10 Ghost Arcade reel coalescing + replay parity (C13).
 *
 * These are the Step-1 RED tests (brief C13 Step 1). They pin the KEYSTONE:
 * a coalesced reel replayed reproduces the IDENTICAL final ShapeStore state as
 * the full-rate stream. Plus: keyframe cadence (segment start + ~10 s), the
 * crossfade loop, and the pure reel reducer.
 *
 * Everything here is PURE — no Date, no Math.random, injected time only.
 */

import { describe, it, expect } from 'vitest';
import type { ServerMsg, NetShape } from '../src/index.js';
import {
  coalesceFrame,
  replayReel,
  buildReel,
  KEYFRAME_INTERVAL_MS,
  crossfadeLoopTime,
  type ReelEvent,
  type ReelFrame,
} from '../src/reels.js';

// ---------------------------------------------------------------------------
// Fixtures: a stream of ServerMsg events + per-tick `state` transform frames.
// ---------------------------------------------------------------------------

function netShape(id: string, x: number): NetShape {
  return {
    id,
    type: 'cube',
    colorIndex: 1,
    renderMode: 'both',
    scale: 1,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0,
    rotSpeed: { x: 0, y: 0, z: 0 },
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

/** A discrete event (spawn) as a ReelEvent stamped with tick/wallTime. */
function ev(tick: number, wallTime: number, msg: ServerMsg): ReelEvent {
  return { tick, wallTime, msg };
}

/** A `state` transform message with one moving shape. */
function stateMsg(tick: number, id: string, x: number): ServerMsg {
  return {
    t: 'state',
    seq: tick,
    serverTick: tick,
    shapes: [{ id, p: { x, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 1, y: 0, z: 0 } }],
  };
}

// ---------------------------------------------------------------------------
// coalesceFrame: last-write-wins continuous transforms, lossless union discrete.
// ---------------------------------------------------------------------------

describe('coalesceFrame', () => {
  it('last-write-wins for a continuous transform (same shape, many state msgs → one)', () => {
    const raw: ReelEvent[] = [
      ev(1, 0, stateMsg(1, 'a', 1)),
      ev(2, 33, stateMsg(2, 'a', 2)),
      ev(3, 66, stateMsg(3, 'a', 3)), // WINS
    ];
    const frame: ReelFrame = coalesceFrame(raw);
    // Exactly ONE transform for shape a — the last position.
    expect(frame.transforms).toHaveLength(1);
    expect(frame.transforms[0].id).toBe('a');
    expect(frame.transforms[0].p.x).toBe(3);
    // The frame is stamped with the LAST tick/wallTime it covered.
    expect(frame.tick).toBe(3);
    expect(frame.wallTime).toBe(66);
  });

  it('coalesces per shape (two shapes each keep their own last transform)', () => {
    const raw: ReelEvent[] = [
      ev(1, 0, stateMsg(1, 'a', 1)),
      ev(1, 0, stateMsg(1, 'b', 10)),
      ev(2, 33, stateMsg(2, 'a', 2)),
      ev(2, 33, stateMsg(2, 'b', 20)),
    ];
    const frame = coalesceFrame(raw);
    const byId = Object.fromEntries(frame.transforms.map((t) => [t.id, t.p.x]));
    expect(byId).toEqual({ a: 2, b: 20 });
  });

  it('LOSSLESS union for discrete events — NONE are dropped, order preserved', () => {
    const raw: ReelEvent[] = [
      ev(1, 0, { t: 'spawn', shape: netShape('a', 0) }),
      ev(1, 0, stateMsg(1, 'a', 1)),
      ev(2, 33, { t: 'grab', id: 'a', peerId: 'p1' }),
      ev(3, 66, { t: 'grab', id: 'a', peerId: null, pos: { x: 5, y: 0, z: 0 }, vel: { x: 2, y: 0, z: 0 } }),
      ev(3, 66, stateMsg(3, 'a', 5)),
    ];
    const frame = coalesceFrame(raw);
    // Every discrete event survives (spawn + grab + release = 3).
    expect(frame.discrete.map((e) => e.msg.t)).toEqual(['spawn', 'grab', 'grab']);
    // The continuous transform collapses to one.
    expect(frame.transforms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// KEYSTONE: coalesced replay reproduces the IDENTICAL final ShapeStore state.
// ---------------------------------------------------------------------------

describe('replay parity (KEYSTONE)', () => {
  it('full-rate replay === coalesced-then-replayed final ShapeStore state', () => {
    // A dense synthetic session: spawn 2 shapes, throw one (grab→release),
    // recolor, scale, then many high-rate `state` transforms (the noise that
    // naive downsampling would corrupt), then despawn one.
    const full: ReelEvent[] = [
      ev(1, 0, { t: 'spawn', shape: netShape('a', 0) }),
      ev(1, 0, { t: 'spawn', shape: netShape('b', 5) }),
      ev(2, 33, { t: 'grab', id: 'a', peerId: 'p1' }),
      ev(3, 66, stateMsg(3, 'a', 1)),
      ev(4, 99, stateMsg(4, 'a', 2)),
      ev(5, 132, stateMsg(5, 'a', 3)),
      ev(6, 165, { t: 'recolor', id: 'b', colorIndex: 4 }),
      ev(7, 198, { t: 'scale', id: 'b', scale: 2 }),
      ev(8, 231, { t: 'rendermode', id: 'b', mode: 'wireframe' }),
      ev(9, 264, {
        t: 'grab',
        id: 'a',
        peerId: null,
        pos: { x: 9, y: 1, z: 2 },
        vel: { x: 4, y: 0, z: 0 },
      }),
      // more transform noise AFTER release
      ev(10, 297, stateMsg(10, 'a', 9)),
      ev(11, 330, stateMsg(11, 'a', 9)),
      ev(12, 363, { t: 'despawn', id: 'b' }),
    ];

    // Full-rate: apply every event verbatim.
    const fullFinal = replayReel(full.map((e) => ({ ...e, coalesced: false })) as never, {
      buildFrames: false,
    });

    // Coalesced: build a reel (segments → coalesced frames + keyframes) then replay.
    const reel = buildReel(full, { now: () => 0, segmentMs: 1000 });
    const coalescedFinal = replayReel(reel);

    // The final ShapeStore state must be IDENTICAL.
    expect(coalescedFinal).toEqual(fullFinal);
    // Sanity: shape a exists at its released rest transform; b was despawned.
    expect(coalescedFinal.shapes.map((s) => s.id).sort()).toEqual(['a']);
    const a = coalescedFinal.shapes.find((s) => s.id === 'a')!;
    expect(a.position.x).toBe(9);
    expect(a.grabbedBy).toBeNull();
  });

  it('coalescing NEVER drops a discrete release event (the throw survives)', () => {
    const full: ReelEvent[] = [
      ev(1, 0, { t: 'spawn', shape: netShape('a', 0) }),
      ev(2, 33, { t: 'grab', id: 'a', peerId: 'p1' }),
      // high-rate held transforms then a release, all in ONE segment
      ev(3, 66, stateMsg(3, 'a', 1)),
      ev(4, 99, stateMsg(4, 'a', 2)),
      ev(5, 132, {
        t: 'grab',
        id: 'a',
        peerId: null,
        pos: { x: 7, y: 0, z: 0 },
        vel: { x: 3, y: 0, z: 0 },
      }),
    ];
    const reel = buildReel(full, { now: () => 0, segmentMs: 1000 });
    // The release must be present in the reel's discrete stream somewhere.
    const releases = reel.frames.flatMap((f) =>
      f.discrete.filter((e) => e.msg.t === 'grab' && e.msg.peerId === null)
    );
    expect(releases).toHaveLength(1);
    const final = replayReel(reel);
    expect(final.shapes.find((s) => s.id === 'a')!.position.x).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Keyframe cadence: segment start + every ~10 s (reuse the late-join serializer).
// ---------------------------------------------------------------------------

describe('keyframe cadence', () => {
  it('emits a keyframe at segment start', () => {
    const full: ReelEvent[] = [ev(1, 0, { t: 'spawn', shape: netShape('a', 0) })];
    const reel = buildReel(full, { now: () => 0, segmentMs: 1000 });
    expect(reel.frames[0].keyframe).not.toBeNull();
    // The keyframe is a welcome-style snapshot of the world at that point.
    expect(reel.frames[0].keyframe!.shapes.map((s) => s.id)).toEqual(['a']);
  });

  it('emits a keyframe every ~10 s (KEYFRAME_INTERVAL_MS), not every frame', () => {
    expect(KEYFRAME_INTERVAL_MS).toBe(10_000);
    // A 25 s session at 1 s segments: keyframes at 0, ~10, ~20 s → 3 total.
    const full: ReelEvent[] = [];
    for (let s = 0; s < 25; s++) {
      full.push(ev(s, s * 1000, stateMsg(s, 'a', s)));
    }
    full.unshift(ev(0, 0, { t: 'spawn', shape: netShape('a', 0) }));
    const reel = buildReel(full, { now: () => 0, segmentMs: 1000 });
    const kfTimes = reel.frames.filter((f) => f.keyframe !== null).map((f) => f.wallTime);
    // First at 0, then ~10 s apart — never one per frame.
    expect(kfTimes[0]).toBe(0);
    expect(kfTimes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < kfTimes.length; i++) {
      expect(kfTimes[i] - kfTimes[i - 1]).toBeGreaterThanOrEqual(KEYFRAME_INTERVAL_MS - 1000);
    }
    // and far fewer keyframes than frames (not one-per-frame).
    expect(kfTimes.length).toBeLessThan(reel.frames.length);
  });

  it('a replay from a keyframe alone (no prior frames) reconstructs the world', () => {
    const full: ReelEvent[] = [
      ev(0, 0, { t: 'spawn', shape: netShape('a', 0) }),
      ev(0, 0, { t: 'spawn', shape: netShape('b', 5) }),
    ];
    for (let s = 1; s < 15; s++) full.push(ev(s, s * 1000, stateMsg(s, 'a', s)));
    const reel = buildReel(full, { now: () => 0, segmentMs: 1000 });
    // Take the SECOND keyframe (~10 s in) and replay only from there.
    const kfIdx = reel.frames.findIndex((f, i) => f.keyframe !== null && i > 0);
    expect(kfIdx).toBeGreaterThan(0);
    const tail = { ...reel, frames: reel.frames.slice(kfIdx) };
    const final = replayReel(tail);
    // Both shapes reconstructed from the keyframe (b never moved but exists).
    expect(final.shapes.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Crossfade loop.
// ---------------------------------------------------------------------------

describe('crossfade loop', () => {
  it('loops seamlessly at keyframe boundaries (wraps time within duration)', () => {
    const durationMs = 10_000;
    const fadeMs = 500;
    // Just past the end wraps back to the start.
    expect(crossfadeLoopTime(0, durationMs, fadeMs)).toBe(0);
    expect(crossfadeLoopTime(9999, durationMs, fadeMs)).toBe(9999);
    expect(crossfadeLoopTime(10_000, durationMs, fadeMs)).toBe(0);
    expect(crossfadeLoopTime(10_250, durationMs, fadeMs)).toBe(250);
    // The crossfade window is reported so the renderer can blend the seam.
    const at = crossfadeLoopTime(9_800, durationMs, fadeMs);
    expect(at).toBe(9_800);
  });
});
