/**
 * interpolation.test.ts — TDD RED→GREEN for SnapshotBuffer (Task B5)
 *
 * Pure unit tests: no mocks needed. All inputs/outputs are plain Vec3 objects.
 */

import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from '../src/net/interpolation.js';

describe('SnapshotBuffer', () => {
  it('empty buffer returns null for any renderTime', () => {
    const buf = new SnapshotBuffer();
    expect(buf.sample(0)).toBeNull();
    expect(buf.sample(100)).toBeNull();
    expect(buf.sample(-50)).toBeNull();
  });

  it('single sample clamps to itself regardless of renderTime', () => {
    const buf = new SnapshotBuffer();
    buf.push(50, { x: 1, y: 2, z: 3 }, { x: 0.1, y: 0.2, z: 0.3 });

    const before = buf.sample(0);
    expect(before).not.toBeNull();
    expect(before!.p).toEqual({ x: 1, y: 2, z: 3 });
    expect(before!.r).toEqual({ x: 0.1, y: 0.2, z: 0.3 });

    const after = buf.sample(999);
    expect(after!.p).toEqual({ x: 1, y: 2, z: 3 });
    expect(after!.r).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });

  it('sample(50) interpolates midpoint between t=0 and t=100', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    buf.push(100, { x: 10, y: 20, z: 30 }, { x: 1, y: 2, z: 3 });

    const mid = buf.sample(50);
    expect(mid).not.toBeNull();
    expect(mid!.p.x).toBeCloseTo(5);
    expect(mid!.p.y).toBeCloseTo(10);
    expect(mid!.p.z).toBeCloseTo(15);
    expect(mid!.r.x).toBeCloseTo(0.5);
    expect(mid!.r.y).toBeCloseTo(1);
    expect(mid!.r.z).toBeCloseTo(1.5);
  });

  it('sample(25) interpolates at quarter-point between t=0 and t=100', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    buf.push(100, { x: 4, y: 8, z: 12 }, { x: 2, y: 4, z: 6 });

    const result = buf.sample(25);
    expect(result!.p.x).toBeCloseTo(1);
    expect(result!.p.y).toBeCloseTo(2);
    expect(result!.p.z).toBeCloseTo(3);
    expect(result!.r.x).toBeCloseTo(0.5);
    expect(result!.r.y).toBeCloseTo(1);
    expect(result!.r.z).toBeCloseTo(1.5);
  });

  it('sample(-10) clamps to first sample when renderTime is before first', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, { x: 1, y: 2, z: 3 }, { x: 0.1, y: 0.2, z: 0.3 });
    buf.push(100, { x: 10, y: 20, z: 30 }, { x: 1, y: 2, z: 3 });

    const result = buf.sample(-10);
    expect(result).not.toBeNull();
    expect(result!.p).toEqual({ x: 1, y: 2, z: 3 });
    expect(result!.r).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });

  it('sample(200) clamps to last sample when renderTime is after last', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, { x: 1, y: 2, z: 3 }, { x: 0.1, y: 0.2, z: 0.3 });
    buf.push(100, { x: 10, y: 20, z: 30 }, { x: 1, y: 2, z: 3 });

    const result = buf.sample(200);
    expect(result).not.toBeNull();
    expect(result!.p).toEqual({ x: 10, y: 20, z: 30 });
    expect(result!.r).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('interpolates across multiple segments (picks the correct bracket)', () => {
    const buf = new SnapshotBuffer();
    buf.push(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    buf.push(100, { x: 10, y: 10, z: 10 }, { x: 1, y: 1, z: 1 });
    buf.push(200, { x: 30, y: 30, z: 30 }, { x: 3, y: 3, z: 3 });

    // Should interpolate in [100..200] segment
    const result = buf.sample(150);
    expect(result!.p.x).toBeCloseTo(20);
    expect(result!.r.x).toBeCloseTo(2);
  });

  it('keeps a bounded history (max ~20 samples, oldest are discarded)', () => {
    const buf = new SnapshotBuffer();
    // push 30 samples; oldest 10 should be dropped
    for (let i = 0; i < 30; i++) {
      buf.push(i * 10, { x: i, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    }
    // sample before the window should clamp to the earliest RETAINED sample
    // (t=100 is s10, not s0)
    const earlyResult = buf.sample(0);
    // after 30 pushes, oldest retained is at index ~10 (t=100, x=10)
    expect(earlyResult!.p.x).toBeGreaterThanOrEqual(9); // clamped to first retained
  });
});
