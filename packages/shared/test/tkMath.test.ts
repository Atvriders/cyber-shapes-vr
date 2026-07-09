import { describe, expect, it } from 'vitest';
import {
  tkPullVelocity,
  tkClampSpeed,
  tkSoftenFactor,
  tkConeSelect,
  advanceConeHold,
  CONE_HOLD_INIT,
  tkDeadManExpired,
  tkGrabRadiusReached,
  TK_PULL_SPEED_MAX,
  TK_MIN_RADIUS,
  TK_GRAB_RADIUS,
  TK_DEADMAN_MS,
  TK_SELECT_HOLD_MS,
  TK_CONE_HALF_ANGLE,
  TK_CONE_RANGE,
} from '../src/index.js';
import type { Vec3 } from '../src/net/types.js';

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const mag = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

// ===========================================================================
// tkPullVelocity — the per-tick loop force (strength-capped, min-radius-softened)
// ===========================================================================

describe('tkPullVelocity — the loop-force pull', () => {
  it('pulls a distant shape TOWARD the anchor (velocity points at the hand)', () => {
    const shape = V(10, 0, 0);
    const anchor = V(0, 0, 0);
    const next = tkPullVelocity(shape, V(0, 0, 0), anchor, 1 / 30);
    // Direction is anchor − shape = (−x): the shape gains −x velocity.
    expect(next.x).toBeLessThan(0);
    expect(Math.abs(next.y)).toBeLessThan(1e-9);
    expect(Math.abs(next.z)).toBeLessThan(1e-9);
  });

  it('is deterministic (same inputs → identical output)', () => {
    const a = tkPullVelocity(V(3, 2, 1), V(0.1, 0, 0), V(0, 0, 0), 1 / 30);
    const b = tkPullVelocity(V(3, 2, 1), V(0.1, 0, 0), V(0, 0, 0), 1 / 30);
    expect(a).toEqual(b);
  });

  it('CAPS the resulting speed to TK_PULL_SPEED_MAX even from a huge current velocity', () => {
    const next = tkPullVelocity(V(10, 0, 0), V(-1000, 0, 0), V(0, 0, 0), 1 / 30);
    expect(mag(next)).toBeLessThanOrEqual(TK_PULL_SPEED_MAX + 1e-6);
  });

  it('SOFTENS to near-zero acceleration inside the min radius (no overshoot)', () => {
    // Shape already essentially in the palm: the pull adds almost nothing.
    const shape = V(0.05, 0, 0);
    const next = tkPullVelocity(shape, V(0, 0, 0), V(0, 0, 0), 1 / 30);
    expect(mag(next)).toBeLessThan(0.5); // strongly softened vs the far-field push
  });

  it('adds MORE velocity far away than just inside the min radius (monotone soften)', () => {
    const far = tkPullVelocity(V(5, 0, 0), V(0, 0, 0), V(0, 0, 0), 1 / 30);
    const near = tkPullVelocity(V(TK_MIN_RADIUS * 0.5, 0, 0), V(0, 0, 0), V(0, 0, 0), 1 / 30);
    expect(mag(far)).toBeGreaterThan(mag(near));
  });

  it('returns the current velocity unchanged for dt ≤ 0', () => {
    const cur = V(0.3, 0.2, 0.1);
    expect(tkPullVelocity(V(5, 0, 0), cur, V(0, 0, 0), 0)).toEqual(cur);
  });

  it('never emits NaN for a coincident shape/anchor', () => {
    const next = tkPullVelocity(V(1, 1, 1), V(2, 0, 0), V(1, 1, 1), 1 / 30);
    expect(Number.isFinite(next.x) && Number.isFinite(next.y) && Number.isFinite(next.z)).toBe(true);
  });

  it('zeroes a non-finite input rather than propagating NaN', () => {
    expect(tkPullVelocity(V(NaN, 0, 0), V(0, 0, 0), V(0, 0, 0), 1 / 30)).toEqual(V(0, 0, 0));
  });
});

describe('tkClampSpeed — the per-pull speed cap / release-throw clamp', () => {
  it('leaves a sub-cap velocity untouched', () => {
    const v = V(1, 2, 2); // |v| = 3
    expect(tkClampSpeed(v, 10)).toEqual(v);
  });
  it('clamps an over-cap velocity to the cap, preserving direction', () => {
    const out = tkClampSpeed(V(100, 0, 0), 12);
    expect(out.x).toBeCloseTo(12, 6);
    expect(mag(out)).toBeCloseTo(12, 6);
  });
  it('defaults to TK_PULL_SPEED_MAX', () => {
    expect(mag(tkClampSpeed(V(999, 0, 0)))).toBeCloseTo(TK_PULL_SPEED_MAX, 6);
  });
  it('zeroes a non-finite velocity', () => {
    expect(tkClampSpeed(V(Infinity, 0, 0))).toEqual(V(0, 0, 0));
  });
});

describe('tkSoftenFactor', () => {
  it('is 0 at the anchor and 1 at/beyond the min radius', () => {
    expect(tkSoftenFactor(0)).toBe(0);
    expect(tkSoftenFactor(TK_MIN_RADIUS)).toBeCloseTo(1, 6);
    expect(tkSoftenFactor(TK_MIN_RADIUS * 3)).toBe(1);
  });
  it('is monotonically increasing across the band', () => {
    const a = tkSoftenFactor(TK_MIN_RADIUS * 0.25);
    const b = tkSoftenFactor(TK_MIN_RADIUS * 0.75);
    expect(b).toBeGreaterThan(a);
  });
});

// ===========================================================================
// tkConeSelect — the cone pick (caller supplies the eligible set)
// ===========================================================================

describe('tkConeSelect', () => {
  it('picks the shape nearest the pointing axis', () => {
    const anchor = V(0, 0, 0);
    const dir = V(0, 0, -1); // pointing −z
    const sel = tkConeSelect(anchor, dir, [
      { id: 'onAxis', position: V(0, 0, -5) },
      { id: 'offAxis', position: V(3, 0, -5) },
    ]);
    expect(sel).toBe('onAxis');
  });

  it('returns null when nothing lies inside the cone', () => {
    const sel = tkConeSelect(V(0, 0, 0), V(0, 0, -1), [
      { id: 'behind', position: V(0, 0, 5) }, // opposite direction
      { id: 'wide', position: V(10, 0, -1) }, // way off axis
    ]);
    expect(sel).toBeNull();
  });

  it('excludes a shape beyond the cone range', () => {
    const sel = tkConeSelect(V(0, 0, 0), V(0, 0, -1), [
      { id: 'tooFar', position: V(0, 0, -(TK_CONE_RANGE + 5)) },
    ]);
    expect(sel).toBeNull();
  });

  it('respects the half-angle: a shape just outside is rejected, just inside accepted', () => {
    const anchor = V(0, 0, 0);
    const dir = V(0, 0, -1);
    const dist = 5;
    const justInside = Math.tan(TK_CONE_HALF_ANGLE * 0.9) * dist;
    const justOutside = Math.tan(TK_CONE_HALF_ANGLE * 1.2) * dist;
    expect(tkConeSelect(anchor, dir, [{ id: 'in', position: V(justInside, 0, -dist) }])).toBe('in');
    expect(tkConeSelect(anchor, dir, [{ id: 'out', position: V(justOutside, 0, -dist) }])).toBeNull();
  });

  it('is deterministic on a tie (smaller id wins)', () => {
    const anchor = V(0, 0, 0);
    const dir = V(0, 0, -1);
    // two identical-on-axis-and-distance candidates
    const a = tkConeSelect(anchor, dir, [
      { id: 'b', position: V(0, 0, -5) },
      { id: 'a', position: V(0, 0, -5) },
    ]);
    const b = tkConeSelect(anchor, dir, [
      { id: 'a', position: V(0, 0, -5) },
      { id: 'b', position: V(0, 0, -5) },
    ]);
    expect(a).toBe('a');
    expect(b).toBe('a');
  });

  it('normalizes an unnormalized direction', () => {
    const sel = tkConeSelect(V(0, 0, 0), V(0, 0, -100), [{ id: 's', position: V(0, 0, -5) }]);
    expect(sel).toBe('s');
  });
});

// ===========================================================================
// advanceConeHold — the 300 ms sustained-hold reducer
// ===========================================================================

describe('advanceConeHold — 300 ms sustained hold', () => {
  it('does NOT commit before the hold window elapses', () => {
    let s = advanceConeHold(CONE_HOLD_INIT, 'shape-1', 1000);
    expect(s.committed).toBe(false);
    s = advanceConeHold(s, 'shape-1', 1000 + TK_SELECT_HOLD_MS - 1);
    expect(s.committed).toBe(false);
  });

  it('commits once the SAME target is held ≥ 300 ms', () => {
    let s = advanceConeHold(CONE_HOLD_INIT, 'shape-1', 1000);
    s = advanceConeHold(s, 'shape-1', 1000 + TK_SELECT_HOLD_MS);
    expect(s.committed).toBe(true);
    expect(s.targetId).toBe('shape-1');
  });

  it('a target CHANGE restarts the clock (a glance never commits)', () => {
    let s = advanceConeHold(CONE_HOLD_INIT, 'shape-1', 1000);
    s = advanceConeHold(s, 'shape-2', 1000 + TK_SELECT_HOLD_MS - 10); // switched
    expect(s.committed).toBe(false);
    expect(s.targetId).toBe('shape-2');
    // now shape-2 must be held its own full window from the switch time
    s = advanceConeHold(s, 'shape-2', 1000 + TK_SELECT_HOLD_MS - 10 + TK_SELECT_HOLD_MS);
    expect(s.committed).toBe(true);
  });

  it('losing the target (null) resets to the init state', () => {
    let s = advanceConeHold(CONE_HOLD_INIT, 'shape-1', 1000);
    s = advanceConeHold(s, null, 1100);
    expect(s.targetId).toBeNull();
    expect(s.committed).toBe(false);
    expect(s.heldSince).toBe(0);
  });
});

// ===========================================================================
// tkDeadManExpired — the ~250 ms dead-man's switch
// ===========================================================================

describe('tkDeadManExpired — the dead-man switch', () => {
  it('is NOT expired within the window', () => {
    expect(tkDeadManExpired(1000, 1000 + TK_DEADMAN_MS)).toBe(false);
  });
  it('IS expired past the window', () => {
    expect(tkDeadManExpired(1000, 1000 + TK_DEADMAN_MS + 1)).toBe(true);
  });
  it('treats a non-finite timestamp as expired (fail-safe release)', () => {
    expect(tkDeadManExpired(NaN, 1000)).toBe(true);
  });
});

// ===========================================================================
// tkGrabRadiusReached — the pull→grab conversion predicate
// ===========================================================================

describe('tkGrabRadiusReached', () => {
  it('is true once within the grab radius', () => {
    expect(tkGrabRadiusReached(V(0, 0, 0), V(TK_GRAB_RADIUS * 0.5, 0, 0))).toBe(true);
  });
  it('is false while still outside the grab radius', () => {
    expect(tkGrabRadiusReached(V(0, 0, 0), V(TK_GRAB_RADIUS + 1, 0, 0))).toBe(false);
  });
});
