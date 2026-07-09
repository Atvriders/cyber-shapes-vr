/**
 * powers/handInput.ts — Task C32 F21 Powers Lab (spec §7.21): the CLIENT hand-
 * tracking input seam. Cut-safe + residue-free — a Tier-6 cut deletes this folder
 * and leaves the rest of the client untouched.
 *
 * STEP 0 BINDING (verified against three's WebXR + the WebXR Hand Input spec):
 *   • Quest Browser HAND input sources DO NOT expose a `gripSpace` (grip space is
 *     for held controllers). So the pull/throw ANCHOR is a JOINT — the
 *     `middle-finger-metacarpal` (the palm), with the `wrist` joint as the
 *     fallback — read from `renderer.xr.getHand(i).joints[...]` each frame.
 *   • Pinch = the STANDARD generic-hand-select profile: `selectstart` / `selectend`
 *     on `renderer.xr.getController(i)` (NO custom gesture recognition, spec §7.21).
 *   • The cone AXIS is the targetRaySpace pointing direction (the controller's −z
 *     world direction), which the generic-hand-select profile tracks from the pinch.
 *   • Throw velocity is derived from the anchor joint's POSE HISTORY (Δpos / Δt).
 *
 * The XR frame reads (joint world poses, per-frame streaming) are the OWNER /
 * HARDWARE-verified seam — there is no WebXR in the sandbox. The PURE decision
 * helpers ({@link detectHandSources}, {@link PoseVelocityTracker}) are unit-tested.
 */

import type { Vec3 } from '@cyber-shapes/shared';

/** The minimal NetClient surface this seam needs (keeps it decoupled + testable). */
export interface TkNetSink {
  sendTkHandsState(available: boolean): void;
  sendTkPull(hand: number, anchor: Vec3, dir: Vec3): void;
  sendTkRelease(hand: number, velocity: Vec3): void;
}

/**
 * True iff ANY input source is a camera-tracked HAND (`source.hand` is populated).
 * PURE — drives the TK_HANDS_STATE capability signal on `inputsourceschange`.
 */
export function detectHandSources(sources: Iterable<{ hand?: unknown } | null | undefined>): boolean {
  for (const s of sources) {
    if (s && s.hand != null) return true;
  }
  return false;
}

/**
 * A tiny pose-history velocity estimator (m/s) — the release throw derives from
 * the anchor joint's recent motion (Δpos / Δt), exactly like the server titan
 * differences hand poses. PURE + deterministic. A missing/zero-Δt prior yields a
 * zero velocity (no phantom throw).
 */
export class PoseVelocityTracker {
  private _prev: { p: Vec3; t: number } | null = null;
  private _vel: Vec3 = { x: 0, y: 0, z: 0 };

  /** Feed the latest anchor pose (world) at time `t` (ms); returns the current velocity. */
  push(p: Vec3, t: number): Vec3 {
    const prev = this._prev;
    if (prev) {
      const dt = (t - prev.t) / 1000;
      if (dt > 1e-4) {
        this._vel = { x: (p.x - prev.p.x) / dt, y: (p.y - prev.p.y) / dt, z: (p.z - prev.p.z) / dt };
      }
    }
    this._prev = { p: { x: p.x, y: p.y, z: p.z }, t };
    return this._vel;
  }

  /** The most recent velocity estimate. */
  get velocity(): Vec3 {
    return this._vel;
  }

  /** Reset the history (on release / tracking loss). */
  reset(): void {
    this._prev = null;
    this._vel = { x: 0, y: 0, z: 0 };
  }
}

// ---------------------------------------------------------------------------
// The XR seam (OWNER/HARDWARE-verified — no WebXR in the sandbox).
// ---------------------------------------------------------------------------

/** The minimal three.js renderer surface the seam reads (structural — no import). */
interface XrRendererLike {
  xr: {
    isPresenting: boolean;
    getController(i: number): { addEventListener(type: string, fn: () => void): void } & {
      getWorldDirection(v: { set(x: number, y: number, z: number): unknown }): unknown;
    };
    getHand(i: number): { joints?: Record<string, { getWorldPosition(v: unknown): unknown } | undefined> } | null;
    getSession(): { addEventListener(type: string, fn: () => void): void; inputSources: Iterable<{ hand?: unknown }> } | null;
  };
}

/** THREE.Vector3-like sink for reading a joint world pose without importing three. */
interface Vector3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
}

export interface PowersHandInputOpts {
  renderer: XrRendererLike;
  net: TkNetSink;
  /** Factory for a scratch Vector3 (main.ts passes `() => new THREE.Vector3()`). */
  makeVec3(): Vector3Like;
  /** Send-rate throttle for TK_PULL (ms). Default ~50 ms (pose rate). */
  pullIntervalMs?: number;
}

/** The two joints (palm first, wrist fallback) the anchor reads (Step 0). */
const ANCHOR_JOINTS = ['middle-finger-metacarpal', 'wrist'] as const;

/**
 * Wires camera-tracked hands to the TELEKINESIS wire. `onInputSourcesChange` sends
 * TK_HANDS_STATE; `update(nowMs)` (called each XR frame) streams TK_PULL while a
 * hand is pinching and sends TK_RELEASE on the pinch's falling edge. All XR frame
 * reads live here (the owner/hardware seam); the pure velocity/detection logic is
 * the tested helpers above.
 */
export class PowersHandInput {
  private readonly _r: XrRendererLike;
  private readonly _net: TkNetSink;
  private readonly _mkV: () => Vector3Like;
  private readonly _pullMs: number;
  private readonly _pinching: [boolean, boolean] = [false, false];
  private readonly _vel: [PoseVelocityTracker, PoseVelocityTracker] = [
    new PoseVelocityTracker(),
    new PoseVelocityTracker(),
  ];
  private _lastPullAt: [number, number] = [0, 0];
  private _lastHandsReported = false;

  constructor(opts: PowersHandInputOpts) {
    this._r = opts.renderer;
    this._net = opts.net;
    this._mkV = opts.makeVec3;
    this._pullMs = opts.pullIntervalMs ?? 50;
    // Pinch edges via the STANDARD generic-hand-select profile (no gesture code).
    for (let i = 0; i < 2; i++) {
      const c = this._r.xr.getController(i);
      c.addEventListener('selectstart', () => {
        this._pinching[i] = true;
        this._vel[i].reset();
      });
      c.addEventListener('selectend', () => {
        if (this._pinching[i]) {
          this._pinching[i] = false;
          this._net.sendTkRelease(i, this._vel[i].velocity);
          this._vel[i].reset();
        }
      });
    }
  }

  /** Attach the `inputsourceschange` listener once a session exists (sessionstart). */
  attachSession(): void {
    const session = this._r.xr.getSession();
    if (!session) return;
    const report = (): void => this.onInputSourcesChange();
    session.addEventListener('inputsourceschange', report);
    this.onInputSourcesChange(); // report the initial state too
  }

  /** Send TK_HANDS_STATE when the camera-tracked-hands availability changes. */
  onInputSourcesChange(): void {
    const session = this._r.xr.getSession();
    const hands = session ? detectHandSources(session.inputSources) : false;
    if (hands !== this._lastHandsReported) {
      this._lastHandsReported = hands;
      this._net.sendTkHandsState(hands);
    }
  }

  /**
   * Per-XR-frame update: for each pinching hand, read the palm anchor + cone axis
   * and stream a throttled TK_PULL. A no-op off-XR or when no hand is pinching.
   */
  update(nowMs: number): void {
    if (!this._r.xr.isPresenting) return;
    for (let i = 0; i < 2; i++) {
      if (!this._pinching[i]) continue;
      const anchor = this._readAnchor(i);
      if (!anchor) continue;
      this._vel[i].push(anchor, nowMs);
      if (nowMs - this._lastPullAt[i] < this._pullMs) continue;
      this._lastPullAt[i] = nowMs;
      const dir = this._readConeAxis(i);
      this._net.sendTkPull(i, anchor, dir);
    }
  }

  /** Read the palm anchor world pose (middle-finger-metacarpal, wrist fallback). */
  private _readAnchor(i: number): Vec3 | null {
    const hand = this._r.xr.getHand(i);
    const joints = hand?.joints;
    if (!joints) return null;
    for (const name of ANCHOR_JOINTS) {
      const j = joints[name];
      if (j) {
        const v = this._mkV();
        j.getWorldPosition(v);
        return { x: v.x, y: v.y, z: v.z };
      }
    }
    return null;
  }

  /** Read the cone axis: the targetRaySpace (controller) −z world direction. */
  private _readConeAxis(i: number): Vec3 {
    const v = this._mkV();
    this._r.xr.getController(i).getWorldDirection(v);
    // three's getWorldDirection returns +z; the ray points down −z.
    return { x: -v.x, y: -v.y, z: -v.z };
  }
}
