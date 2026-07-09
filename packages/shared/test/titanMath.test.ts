/**
 * titanMath.test.ts — Task C17 F7 Titan Protocol (spec §7.7), the PURE math.
 *
 * TDD RED-first (brief Step 1). Every function here is deterministic — no
 * Date.now, no Math.random — so a fixture drives it exactly. The load-bearing
 * cases:
 *   • a hand impulse's radial direction + hand-speed scaling + linear falloff to
 *     zero at the scaled reach edge (a scaled hand sweeps a scaled volume);
 *   • the impulse is DAMPED when the target is already outside WORLD_RADIUS
 *     (containment — a titan sweep never flings a shape further out of bounds);
 *   • TITAN_THROW_MAX clamps the imparted velocity magnitude;
 *   • the recall position is deterministic AND inside WORLD_RADIUS;
 *   • the rig-scale ease is identity (1) at t=0 and reaches the target at t≥dur.
 */

import { describe, it, expect } from 'vitest';
import {
  WORLD_RADIUS,
  TITAN_THROW_MAX,
  TITAN_HAND_REACH,
  TITAN_SCALE_MS,
  TITAN_SCALE_DEFAULT,
  TITAN_RECALL_RADIUS,
  type Vec3,
} from '@cyber-shapes/shared';
import {
  titanHandImpulse,
  clampThrowVelocity,
  isTitanOutOfBounds,
  titanRecallPosition,
  titanRigScale,
} from '@cyber-shapes/shared';

const mag = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

// ===========================================================================
// titanHandImpulse — radial impulse from a moving giant hand.
// ===========================================================================
describe('titanHandImpulse', () => {
  it('pushes a shape radially AWAY from the hand, scaled by hand speed', () => {
    // Hand at origin moving +x fast; shape just in front at +x. The impulse
    // should push the shape further along +x (radially away from the hand).
    const shapePos: Vec3 = { x: 0.5, y: 1, z: 0 };
    const handPos: Vec3 = { x: 0, y: 1, z: 0 };
    const handVel: Vec3 = { x: 4, y: 0, z: 0 };
    const imp = titanHandImpulse(shapePos, handPos, handVel, 1);
    expect(imp).not.toBeNull();
    // Dominant component along +x (away from the hand).
    expect(imp!.x).toBeGreaterThan(0);
    expect(Math.abs(imp!.x)).toBeGreaterThan(Math.abs(imp!.y));
    expect(Math.abs(imp!.x)).toBeGreaterThan(Math.abs(imp!.z));
  });

  it('scales with hand speed — a faster hand imparts a stronger impulse', () => {
    const shapePos: Vec3 = { x: 0.5, y: 1, z: 0 };
    const handPos: Vec3 = { x: 0, y: 1, z: 0 };
    const slow = titanHandImpulse(shapePos, handPos, { x: 1, y: 0, z: 0 }, 1)!;
    const fast = titanHandImpulse(shapePos, handPos, { x: 5, y: 0, z: 0 }, 1)!;
    expect(mag(fast)).toBeGreaterThan(mag(slow));
  });

  it('returns null when the shape is beyond the scaled hand reach', () => {
    const handPos: Vec3 = { x: 0, y: 1, z: 0 };
    const handVel: Vec3 = { x: 4, y: 0, z: 0 };
    // At rig scale 1 a shape at distance 5 m is well beyond TITAN_HAND_REACH.
    const far: Vec3 = { x: 5, y: 1, z: 0 };
    expect(titanHandImpulse(far, handPos, handVel, 1)).toBeNull();
    // But at a large rig scale the reach grows and the same shape is IN range.
    const bigScale = Math.ceil(5 / TITAN_HAND_REACH) + 1;
    expect(titanHandImpulse(far, handPos, handVel, bigScale)).not.toBeNull();
  });

  it('falls off with distance — closer shapes get a stronger impulse (linear falloff)', () => {
    const handPos: Vec3 = { x: 0, y: 1, z: 0 };
    const handVel: Vec3 = { x: 4, y: 0, z: 0 };
    const near = titanHandImpulse({ x: 0.2, y: 1, z: 0 }, handPos, handVel, 1)!;
    const edge = titanHandImpulse({ x: TITAN_HAND_REACH * 0.95, y: 1, z: 0 }, handPos, handVel, 1)!;
    expect(mag(near)).toBeGreaterThan(mag(edge));
  });

  it('DAMPS the impulse when the target is already outside WORLD_RADIUS (containment)', () => {
    // Same relative geometry inside vs outside the world sphere. A giant scale so
    // the reach covers the offset. The out-of-bounds shape gets a WEAKER push
    // (a titan sweep never flings a shape further out of bounds — spec §7.7).
    const scale = 30; // reach = TITAN_HAND_REACH * 30 = 36 m
    const handVel: Vec3 = { x: 4, y: 0, z: 0 };
    // Inside: shape near the origin.
    const inHand: Vec3 = { x: 0, y: 1, z: 0 };
    const inShape: Vec3 = { x: 1, y: 1, z: 0 };
    const inside = titanHandImpulse(inShape, inHand, handVel, scale)!;
    // Outside: identical hand→shape offset but translated well past WORLD_RADIUS.
    const outHand: Vec3 = { x: WORLD_RADIUS + 5, y: 1, z: 0 };
    const outShape: Vec3 = { x: WORLD_RADIUS + 6, y: 1, z: 0 };
    const outside = titanHandImpulse(outShape, outHand, handVel, scale)!;
    expect(mag(outside)).toBeLessThan(mag(inside));
  });

  it('is bounded — never exceeds TITAN_THROW_MAX even at extreme hand speed', () => {
    const shapePos: Vec3 = { x: 0.1, y: 1, z: 0 };
    const handPos: Vec3 = { x: 0, y: 1, z: 0 };
    const insane: Vec3 = { x: 1e6, y: 0, z: 0 };
    const imp = titanHandImpulse(shapePos, handPos, insane, 1)!;
    expect(mag(imp)).toBeLessThanOrEqual(TITAN_THROW_MAX + 1e-6);
  });

  it('returns null for a degenerate (coincident) hand/shape or non-finite input', () => {
    const p: Vec3 = { x: 0, y: 1, z: 0 };
    expect(titanHandImpulse(p, p, { x: 1, y: 0, z: 0 }, 1)).toBeNull();
    expect(titanHandImpulse({ x: NaN, y: 1, z: 0 }, p, { x: 1, y: 0, z: 0 }, 1)).toBeNull();
  });
});

// ===========================================================================
// clampThrowVelocity — TITAN_THROW_MAX clamp.
// ===========================================================================
describe('clampThrowVelocity', () => {
  it('leaves an in-range velocity untouched', () => {
    const v: Vec3 = { x: 3, y: -2, z: 1 };
    const out = clampThrowVelocity(v);
    expect(out).toEqual(v);
  });

  it('clamps an over-cap velocity to exactly TITAN_THROW_MAX, preserving direction', () => {
    const v: Vec3 = { x: 100, y: 0, z: 0 };
    const out = clampThrowVelocity(v);
    expect(mag(out)).toBeCloseTo(TITAN_THROW_MAX, 6);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('returns a zero vector for a non-finite input (never propagates NaN)', () => {
    const out = clampThrowVelocity({ x: Infinity, y: 0, z: 0 });
    expect(mag(out)).toBe(0);
  });
});

// ===========================================================================
// isTitanOutOfBounds + titanRecallPosition — OOB recall math.
// ===========================================================================
describe('isTitanOutOfBounds', () => {
  it('is true only strictly beyond WORLD_RADIUS', () => {
    expect(isTitanOutOfBounds({ x: WORLD_RADIUS - 0.1, y: 0, z: 0 })).toBe(false);
    expect(isTitanOutOfBounds({ x: WORLD_RADIUS + 0.1, y: 0, z: 0 })).toBe(true);
    // A huge REMOVE_DISTANCE-crossing throw is out of bounds well before despawn.
    expect(isTitanOutOfBounds({ x: 45, y: 0, z: 0 })).toBe(true);
  });

  it('treats a non-finite position as out of bounds (recall it rather than keep a ghost)', () => {
    expect(isTitanOutOfBounds({ x: NaN, y: 0, z: 0 })).toBe(true);
  });
});

describe('titanRecallPosition', () => {
  it('respawns deterministically INSIDE WORLD_RADIUS (near origin)', () => {
    const a = titanRecallPosition({ x: 45, y: 3, z: 0 }, 0);
    const b = titanRecallPosition({ x: 45, y: 3, z: 0 }, 0);
    expect(a).toEqual(b); // deterministic (no Math.random)
    // Comfortably inside the world sphere, near the origin.
    expect(mag(a)).toBeLessThan(WORLD_RADIUS);
    // The horizontal ring radius is exactly TITAN_RECALL_RADIUS (a tidy respawn ring).
    expect(Math.hypot(a.x, a.z)).toBeCloseTo(TITAN_RECALL_RADIUS, 6);
  });

  it('varies with the seed so a burst of recalls does not stack on one point', () => {
    const a = titanRecallPosition({ x: 45, y: 3, z: 0 }, 0);
    const b = titanRecallPosition({ x: 45, y: 3, z: 0 }, 7);
    expect(a).not.toEqual(b);
  });
});

// ===========================================================================
// titanRigScale — the 1→scale ease over TITAN_SCALE_MS.
// ===========================================================================
describe('titanRigScale', () => {
  it('is identity (1) at t=0 (rig-scale-1 parity: no growth yet)', () => {
    expect(titanRigScale(0, TITAN_SCALE_DEFAULT)).toBeCloseTo(1, 6);
  });

  it('reaches exactly the target at t = TITAN_SCALE_MS and holds after', () => {
    expect(titanRigScale(TITAN_SCALE_MS, TITAN_SCALE_DEFAULT)).toBeCloseTo(TITAN_SCALE_DEFAULT, 6);
    expect(titanRigScale(TITAN_SCALE_MS * 2, TITAN_SCALE_DEFAULT)).toBeCloseTo(
      TITAN_SCALE_DEFAULT,
      6
    );
  });

  it('is monotonic non-decreasing between 1 and the target', () => {
    let prev = 0;
    for (let ms = 0; ms <= TITAN_SCALE_MS; ms += TITAN_SCALE_MS / 10) {
      const s = titanRigScale(ms, TITAN_SCALE_DEFAULT);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(TITAN_SCALE_DEFAULT);
      prev = s;
    }
  });
});
