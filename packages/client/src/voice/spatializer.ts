/**
 * spatializer.ts — Per-peer HRTF spatial audio (B10).
 *
 * Each remote peer gets:
 *   PannerNode (HRTF, inverse distance) → GainNode → ctx.destination
 *
 * The local listener (camera) is updated each frame from the XR camera pose.
 * Per-peer positions are updated each frame from the remote avatar head pose.
 *
 * No browser/DOM is needed at module scope — all Web Audio calls are inside
 * class methods so this is safely importable in test environments that mock
 * AudioContext.
 */

import type { Vec3 } from '@cyber-shapes/shared';

export interface PeerNodes {
  panner: PannerNode;
  gain: GainNode;
}

/**
 * Client-side defence-in-depth (audit #3): a non-finite (NaN/Infinity) value fed
 * to a Web Audio AudioParam.setValueAtTime throws a RangeError, which would
 * escape setAnimationLoop and kill the render loop. We skip any position/listener
 * update carrying a bad component instead of applying it. Returns true only if
 * ALL supplied numbers are finite.
 */
function allFinite(...ns: number[]): boolean {
  for (const n of ns) if (!Number.isFinite(n)) return false;
  return true;
}

export class Spatializer {
  private readonly _ctx: AudioContext;
  private readonly _peers = new Map<string, PeerNodes>();

  constructor(ctx: AudioContext) {
    this._ctx = ctx;
  }

  // -------------------------------------------------------------------------
  // Peer lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ensure a PannerNode + GainNode chain exists for `id`.
   * Idempotent: second call returns the existing nodes.
   */
  ensurePeer(id: string): PeerNodes {
    const existing = this._peers.get(id);
    if (existing) return existing;

    const panner = this._ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.rolloffFactor = 1;

    const gain = this._ctx.createGain();
    gain.gain.value = 1;

    panner.connect(gain);
    gain.connect(this._ctx.destination);

    const nodes: PeerNodes = { panner, gain };
    this._peers.set(id, nodes);
    return nodes;
  }

  /**
   * Update the 3-D position of a peer's panner.
   * Creates the panner if it doesn't exist yet.
   */
  setPeerPosition(id: string, p: Vec3): void {
    // Skip a non-finite position (audit #3): setValueAtTime(NaN) throws and would
    // crash the render loop. Do not create/touch the panner for a bad value.
    if (!allFinite(p.x, p.y, p.z)) return;
    const nodes = this.ensurePeer(id);
    nodes.panner.positionX.setValueAtTime(p.x, this._ctx.currentTime);
    nodes.panner.positionY.setValueAtTime(p.y, this._ctx.currentTime);
    nodes.panner.positionZ.setValueAtTime(p.z, this._ctx.currentTime);
  }

  /**
   * Set the gain for a peer (0 = muted, 1 = full).
   * Creates the gain node if it doesn't exist yet.
   */
  setPeerGain(id: string, g: number): void {
    const nodes = this.ensurePeer(id);
    nodes.gain.gain.setValueAtTime(g, this._ctx.currentTime);
  }

  /**
   * Disconnect and remove a peer's audio nodes.
   * No-op if the peer doesn't exist.
   */
  removePeer(id: string): void {
    const nodes = this._peers.get(id);
    if (!nodes) return;
    try {
      nodes.gain.disconnect();
    } catch {
      /* ignore */
    }
    try {
      nodes.panner.disconnect();
    } catch {
      /* ignore */
    }
    this._peers.delete(id);
  }

  /** Dispose all peer nodes. */
  disposeAll(): void {
    for (const id of [...this._peers.keys()]) {
      this.removePeer(id);
    }
  }

  // -------------------------------------------------------------------------
  // Listener
  // -------------------------------------------------------------------------

  /**
   * Update the Web Audio listener to match the local XR camera.
   *
   * `headPos`     — world position of the camera/head
   * `headForward` — normalised forward vector of the camera (−Z in THREE)
   * `headUp`      — normalised up vector of the camera (+Y in THREE)
   */
  setListener(headPos: Vec3, headForward: Vec3, headUp: Vec3): void {
    // Skip a non-finite listener pose (audit #3): setValueAtTime(NaN) / the legacy
    // setPosition(NaN) throws and would crash the render loop.
    if (
      !allFinite(
        headPos.x,
        headPos.y,
        headPos.z,
        headForward.x,
        headForward.y,
        headForward.z,
        headUp.x,
        headUp.y,
        headUp.z
      )
    ) {
      return;
    }

    const l = this._ctx.listener;
    const t = this._ctx.currentTime;

    if (l.positionX) {
      // Modern API (AudioParam)
      l.positionX.setValueAtTime(headPos.x, t);
      l.positionY.setValueAtTime(headPos.y, t);
      l.positionZ.setValueAtTime(headPos.z, t);
      l.forwardX.setValueAtTime(headForward.x, t);
      l.forwardY.setValueAtTime(headForward.y, t);
      l.forwardZ.setValueAtTime(headForward.z, t);
      l.upX.setValueAtTime(headUp.x, t);
      l.upY.setValueAtTime(headUp.y, t);
      l.upZ.setValueAtTime(headUp.z, t);
    } else {
      // Legacy API
      (
        l as AudioListener & {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
        }
      ).setPosition(headPos.x, headPos.y, headPos.z);
      (
        l as AudioListener & {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
        }
      ).setOrientation(headForward.x, headForward.y, headForward.z, headUp.x, headUp.y, headUp.z);
    }
  }
}
