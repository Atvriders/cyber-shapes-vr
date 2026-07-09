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

// ---------------------------------------------------------------------------
// createInterpolator — the injected-clock + message-source interpolation layer.
//
// Task C0 Step 3 (FROZEN SIGNATURE — later tasks C13/C21/C29/C30 build replay on
// top of THIS entry point; C29 computes diagnostics at the source/shim layer and
// NEVER extends this signature).
//
// A StateFrame is a decimated snapshot of moving shapes — the exact payload of a
// Phase B `state` message (Appendix B: p/r plus the additive per-shape fields).
// A StateSource emits StateFrames; the live socket adapter and a replay/reel
// buffer are both StateSources, so the SAME interpolation code path serves live
// play and replay. `now()` supplies the sample-stamp clock (injectable for
// deterministic replay + fake-timer tests).
//
// Parity: the interpolator owns one SnapshotBuffer per shape id and pushes
// (now(), p, r) exactly as NetClient did inline — so its output is identical to
// the pre-C0 per-shape-buffer behavior (asserted by the parity test).
// ---------------------------------------------------------------------------

/** One shape's transform inside a state frame (superset-tolerant: extra fields ignored). */
export interface StateShapeEntry {
  id: string;
  p: Vec3;
  r: Vec3;
}

/** A decimated snapshot of moving shapes (the `state` message payload). */
export interface StateFrame {
  shapes: readonly StateShapeEntry[];
}

/**
 * A source of StateFrames. `onState` registers a listener and returns an
 * unsubscribe function. The live WebSocket adapter and a replay buffer both
 * implement this so the interpolator is source-agnostic.
 */
export interface StateSource {
  onState(cb: (frame: StateFrame) => void): () => void;
}

export interface InterpolatorOptions {
  /** Where StateFrames come from (live socket adapter OR replay buffer). */
  source: StateSource;
  /** Sample-stamp clock. Defaults to performance.now (injectable for tests/replay). */
  now?: () => number;
}

/** The frozen interpolation handle consumed by the render loop + replay adapters. */
export interface Interpolator {
  /** Sample the interpolated transform for `id` at `renderTime`, or null if unknown/empty. */
  sample(id: string, renderTime: number): { p: Vec3; r: Vec3 } | null;
  /** Ingest a single frame directly (used by adapters that don't push through the source). */
  ingest(frame: StateFrame): void;
  /** True if a buffer exists for `id`. */
  has(id: string): boolean;
  /**
   * Move a shape's buffer from `oldId` to `newId` (B6 tempId reconciliation).
   * No-op if `oldId` has no buffer; if `newId` already has one, the old is dropped.
   */
  rekey(oldId: string, newId: string): void;
  /** Drop a shape's buffer (on despawn) so it doesn't leak. */
  drop(id: string): void;
  /** Clear all buffers (on welcome / re-seed). */
  clear(): void;
  /** Stop listening to the source. */
  dispose(): void;
}

/**
 * Build an Interpolator bound to a StateSource + injected clock. FROZEN entry
 * point (C0 Step 3). Reuses SnapshotBuffer per shape id, so its interpolation is
 * bit-parity with the pre-C0 inline netClient behavior.
 */
export function createInterpolator(opts: InterpolatorOptions): Interpolator {
  const now = opts.now ?? (() => performance.now());
  const buffers = new Map<string, SnapshotBuffer>();

  function ingest(frame: StateFrame): void {
    const t = now();
    const shapes = Array.isArray(frame.shapes) ? frame.shapes : [];
    for (const entry of shapes) {
      let buf = buffers.get(entry.id);
      if (!buf) {
        buf = new SnapshotBuffer();
        buffers.set(entry.id, buf);
      }
      buf.push(t, entry.p, entry.r);
    }
  }

  const unsubscribe = opts.source.onState(ingest);

  return {
    sample(id, renderTime) {
      const buf = buffers.get(id);
      return buf ? buf.sample(renderTime) : null;
    },
    ingest,
    has(id) {
      return buffers.has(id);
    },
    rekey(oldId, newId) {
      if (oldId === newId) return;
      const buf = buffers.get(oldId);
      if (!buf) return;
      buffers.delete(oldId);
      if (!buffers.has(newId)) buffers.set(newId, buf);
    },
    drop(id) {
      buffers.delete(id);
    },
    clear() {
      buffers.clear();
    },
    dispose() {
      unsubscribe();
    },
  };
}
