/**
 * titanRig.test.ts — Task C17 (F7 Titan Protocol) client rig-scale math (spec §7.7).
 *
 * The load-bearing PARITY test: at rig scale 1 the transform is the exact IDENTITY
 * (scale 1, position origin), so the client render + OrbitControls path is
 * byte-identical to Phase B (the TOP-RISK constraint — no Phase B regression). Plus
 * the scale-about-the-floor-point invariant: the floor point stays fixed as the rig
 * grows (a giant's feet stay planted).
 */

import { describe, it, expect } from 'vitest';
import { rigTransformForScale, isIdentityRig } from '../src/net/titanRig.ts';

describe('rigTransformForScale', () => {
  it('PARITY: scale 1 is the exact identity transform (no Phase B regression)', () => {
    const t = rigTransformForScale(1, 3.2, -7.5);
    expect(t.scale).toBe(1);
    expect(t.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(isIdentityRig(t)).toBe(true);
  });

  it('a non-finite / non-positive scale falls back to the identity (never NaNs the rig)', () => {
    expect(isIdentityRig(rigTransformForScale(NaN, 1, 1))).toBe(true);
    expect(isIdentityRig(rigTransformForScale(0, 1, 1))).toBe(true);
    expect(isIdentityRig(rigTransformForScale(-3, 1, 1))).toBe(true);
  });

  it('keeps the FLOOR POINT fixed as the rig grows (scale about the floor, not the camera)', () => {
    const floorX = 2;
    const floorZ = -4;
    for (const s of [2, 5, 10]) {
      const t = rigTransformForScale(s, floorX, floorZ);
      // worldOf(P) = rigPosition + s · P must equal P (the floor point is fixed).
      expect(t.position.x + s * floorX).toBeCloseTo(floorX, 9);
      expect(t.position.z + s * floorZ).toBeCloseTo(floorZ, 9);
      // The floor stays on the ground plane (y unaffected).
      expect(t.position.y).toBe(0);
      expect(t.scale).toBe(s);
    }
  });

  it('with the floor point at the origin, scaling leaves the rig position at origin', () => {
    const t = rigTransformForScale(5, 0, 0);
    expect(t.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(t.scale).toBe(5);
  });
});
