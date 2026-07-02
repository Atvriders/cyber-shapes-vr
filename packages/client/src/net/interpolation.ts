/**
 * interpolation.ts — SnapshotBuffer: bounded history + linear interpolation (B5)
 *
 * Pure: no I/O, no globals. Suitable for unit testing without stubs.
 *
 * Usage:
 *   const buf = new SnapshotBuffer();
 *   buf.push(t, position, rotation);      // called on every incoming 'state' msg
 *   const { p, r } = buf.sample(now - INTERP_DELAY) ?? default;
 */

import type { Vec3 } from '@cyber-shapes/shared';

/** Maximum number of retained samples per buffer. */
const MAX_SAMPLES = 20;

interface Sample {
  t: number;
  p: Vec3;
  r: Vec3;
}

export class SnapshotBuffer {
  private readonly _samples: Sample[] = [];

  /**
   * Append a timestamped position+rotation sample.
   * Maintains bounded history: oldest samples are evicted once MAX_SAMPLES is reached.
   */
  push(t: number, p: Vec3, r: Vec3): void {
    this._samples.push({ t, p: { ...p }, r: { ...r } });
    if (this._samples.length > MAX_SAMPLES) {
      this._samples.shift();
    }
  }

  /**
   * Linearly interpolate position AND rotation at `renderTime`.
   * - Returns null if the buffer is empty.
   * - Clamps to the first sample if renderTime is before the first timestamp.
   * - Clamps to the last sample if renderTime is after the last timestamp.
   * - Otherwise lerps component-wise between the two surrounding samples.
   *
   * Euler rotation lerp is component-wise (adequate for this app).
   */
  sample(renderTime: number): { p: Vec3; r: Vec3 } | null {
    const samples = this._samples;
    if (samples.length === 0) return null;

    // Clamp: before first
    if (renderTime <= samples[0].t) {
      return { p: { ...samples[0].p }, r: { ...samples[0].r } };
    }

    // Clamp: after last
    const last = samples[samples.length - 1];
    if (renderTime >= last.t) {
      return { p: { ...last.p }, r: { ...last.r } };
    }

    // Find the bracket [a, b] where a.t <= renderTime < b.t
    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= renderTime) lo = mid;
      else hi = mid;
    }

    const a = samples[lo];
    const b = samples[hi];
    const span = b.t - a.t;
    const alpha = span === 0 ? 0 : (renderTime - a.t) / span;

    return {
      p: lerp3(a.p, b.p, alpha),
      r: lerp3(a.r, b.r, alpha),
    };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}
