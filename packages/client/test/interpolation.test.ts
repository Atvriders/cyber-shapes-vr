/**
 * interpolation.test.ts — TDD RED→GREEN for SnapshotBuffer (Task B5)
 *
 * Pure unit tests: no mocks needed. All inputs/outputs are plain Vec3 objects.
 */

import { describe, expect, it } from 'vitest';
import {
  SnapshotBuffer,
  createInterpolator,
  type StateFrame,
  type StateSource,
} from '../src/net/interpolation.js';

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

// ---------------------------------------------------------------------------
// createInterpolator (Task C0 Step 3) — injected clock + message source.
// The signature is FROZEN here; later tasks (C13/C21/C29/C30) build on it.
// ---------------------------------------------------------------------------

/** A tiny manual StateSource: push frames on demand; capture the ingest cb. */
function makeManualSource(): { source: StateSource; emit: (f: StateFrame) => void } {
  let cb: ((f: StateFrame) => void) | null = null;
  return {
    source: {
      onState(fn) {
        cb = fn;
        return () => {
          if (cb === fn) cb = null;
        };
      },
    },
    emit(f) {
      cb?.(f);
    },
  };
}

describe('createInterpolator', () => {
  it('accepts an injected clock (now) and a message source (StateSource)', () => {
    const { source, emit } = makeManualSource();
    let clock = 0;
    const interp = createInterpolator({ source, now: () => clock });

    clock = 0;
    emit({ shapes: [{ id: 'a', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } }] });
    clock = 100;
    emit({ shapes: [{ id: 'a', p: { x: 10, y: 20, z: 30 }, r: { x: 1, y: 2, z: 3 } }] });

    // Midpoint sample matches a lerp between the two clock-stamped frames.
    const mid = interp.sample('a', 50);
    expect(mid).not.toBeNull();
    expect(mid!.p.x).toBeCloseTo(5);
    expect(mid!.p.y).toBeCloseTo(10);
    expect(mid!.p.z).toBeCloseTo(15);
    expect(mid!.r.y).toBeCloseTo(1);
    interp.dispose();
  });

  it('PARITY: interpolator output is identical to direct SnapshotBuffer usage', () => {
    const { source, emit } = makeManualSource();
    let clock = 0;
    const interp = createInterpolator({ source, now: () => clock });
    // Mirror buffer driven with the SAME (t, p, r) tuples the interpolator ingests.
    const mirror = new SnapshotBuffer();

    const frames: Array<{ t: number; p: { x: number; y: number; z: number }; r: { x: number; y: number; z: number } }> = [
      { t: 0, p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } },
      { t: 33, p: { x: 1, y: -2, z: 3 }, r: { x: 0.1, y: 0.2, z: 0.3 } },
      { t: 66, p: { x: 4, y: 5, z: -6 }, r: { x: 0.4, y: 0.5, z: 0.6 } },
      { t: 100, p: { x: -7, y: 8, z: 9 }, r: { x: 0.7, y: 0.8, z: 0.9 } },
    ];
    for (const f of frames) {
      clock = f.t;
      emit({ shapes: [{ id: 'x', p: f.p, r: f.r }] });
      mirror.push(f.t, f.p, f.r);
    }

    // Sample a spread of render times; both must agree exactly.
    for (const rt of [-10, 0, 17, 33, 50, 66, 80, 100, 250]) {
      const a = interp.sample('x', rt);
      const b = mirror.sample(rt);
      expect(a).toEqual(b);
    }
    interp.dispose();
  });

  it('lazily creates a buffer per id; sample of an unknown id is null', () => {
    const { source, emit } = makeManualSource();
    const interp = createInterpolator({ source, now: () => 0 });
    expect(interp.sample('ghost', 0)).toBeNull();
    expect(interp.has('ghost')).toBe(false);
    emit({ shapes: [{ id: 'ghost', p: { x: 1, y: 1, z: 1 }, r: { x: 0, y: 0, z: 0 } }] });
    expect(interp.has('ghost')).toBe(true);
    interp.dispose();
  });

  it('drop() removes a buffer; clear() removes all; rekey() moves one', () => {
    const { source, emit } = makeManualSource();
    const interp = createInterpolator({ source, now: () => 0 });
    emit({ shapes: [{ id: 'a', p: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } }] });
    emit({ shapes: [{ id: 'b', p: { x: 2, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } }] });

    interp.rekey('a', 'a2');
    expect(interp.has('a')).toBe(false);
    expect(interp.has('a2')).toBe(true);

    interp.drop('b');
    expect(interp.has('b')).toBe(false);

    interp.clear();
    expect(interp.has('a2')).toBe(false);
    interp.dispose();
  });

  it('extra per-shape fields on a frame (serverTick/impactSpeed carriers) are tolerated', () => {
    const { source, emit } = makeManualSource();
    const interp = createInterpolator({ source, now: () => 0 });
    // A frame whose entries also carry `v`/`s` (Phase C additive fields) ingests fine.
    emit({
      shapes: [
        {
          id: 'a',
          p: { x: 1, y: 2, z: 3 },
          r: { x: 0, y: 0, z: 0 },
          // Extra fields ignored by the interpolator's p/r-only ingest.
          ...({ v: { x: 0, y: -5, z: 0 }, s: 5.5 } as unknown as object),
        },
      ] as StateFrame['shapes'],
    });
    expect(interp.sample('a', 0)).toEqual({ p: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0 } });
    interp.dispose();
  });

  it('dispose() unsubscribes: later frames no longer mutate buffers', () => {
    const { source, emit } = makeManualSource();
    let clock = 0;
    const interp = createInterpolator({ source, now: () => clock });
    emit({ shapes: [{ id: 'a', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } }] });
    interp.dispose();
    clock = 100;
    // After dispose, the source's ingest cb is cleared → this emit is a no-op.
    emit({ shapes: [{ id: 'a', p: { x: 99, y: 99, z: 99 }, r: { x: 0, y: 0, z: 0 } }] });
    // Buffer still holds only the pre-dispose sample.
    expect(interp.sample('a', 100)).toEqual({ p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } });
  });
});
