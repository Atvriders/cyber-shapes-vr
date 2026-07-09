/**
 * desktop/cameras.ts — the F22 Desktop Command camera rig (spec §7.22, plan C33).
 *
 * `CameraRig` is the desktop VIEW's 4-mode camera:
 *   ORBIT  — the Phase A default (OrbitControls stays enabled, UNCHANGED).
 *   FLY    — WASD + mouse-look, shift = fast (free-look flight; OrbitControls off).
 *   FOLLOW — Tab cycles residents/wisps (the camera chases a target's position).
 *   AUTO   — the shared C9 `StageBrain` drives the framing over the `events.ts`
 *            RoomEvent stream (a desktop resident receives the full-rate stream, so
 *            this runs at full fidelity with no §14 gate). The stage OVERLAYS stay
 *            stage-only; the desktop only borrows the pure decision core.
 *
 * ── XR INERTNESS (spec §7.22 "Quest inertness") ──
 * The client has ONE entry, so this loads in the headset too. While
 * `renderer.xr.isPresenting`, `update()` is a HARD NO-OP (the camera is the XR
 * head; the rig must never offset it) and the keymap/HUD are inert. On
 * `sessionstart` the rig is restored to a SANE default (ORBIT), so exiting VR from
 * an AUTO/FLY session never leaves the desktop in a stage-brain camera.
 *
 * Structural typing keeps this unit-testable without a WebGL context: the camera,
 * renderer, and OrbitControls are consumed via minimal interfaces the fakes in
 * desktop.dom.test.ts satisfy. In production main.ts passes the real THREE objects.
 */

import { StageBrain, type Shot, type RoomEvent } from '@cyber-shapes/shared';

/** The four desktop camera modes (spec §7.22 `1–4` keys). */
export type CameraMode = 'orbit' | 'fly' | 'follow' | 'auto';

/** A minimal 3-vector-with-setter — THREE.Vector3 satisfies this structurally. */
interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

/** The camera surface the rig writes (THREE.PerspectiveCamera satisfies this). */
interface CameraLike {
  position: Vec3Like;
  lookAt(x: number, y: number, z: number): void;
}

/** Just the `xr.isPresenting` flag the rig reads (THREE.WebGLRenderer satisfies it). */
interface RendererLike {
  xr: { isPresenting: boolean };
}

/** The OrbitControls surface the rig toggles (THREE addons OrbitControls satisfies). */
interface ControlsLike {
  enabled: boolean;
  update(): void;
}

/** A follow target: an id + a live world position (resident avatar head or wisp). */
export interface FollowTarget {
  id: string;
  pos: { x: number; y: number; z: number };
}

/** FLY input this frame (WASD → forward/right/up, shift → fast, mouse → yaw/pitch). */
export interface FlyInput {
  /** -1..1 forward/back (W/S). */
  forward: number;
  /** -1..1 strafe right/left (D/A). */
  right: number;
  /** -1..1 up/down (E/Q or space/ctrl). */
  up: number;
  /** Shift held → the fast multiplier. */
  fast: boolean;
  /** Accumulated yaw delta (rad) from mouse-look this frame. */
  yaw: number;
  /** Accumulated pitch delta (rad) from mouse-look this frame. */
  pitch: number;
}

export interface CameraRigOpts {
  renderer: RendererLike;
  camera: CameraLike;
  /** OrbitControls (optional — tests may omit; ORBIT toggles it when present). */
  controls?: ControlsLike;
  /** FOLLOW target provider — residents + wisps, evaluated on demand. */
  followTargets?: () => FollowTarget[];
  /** StageBrain config for AUTO (defaults to the C9 conservative config). */
  brain?: { minShotMs: number; heatThreshold: number };
}

const DEFAULT_BRAIN = { minShotMs: 2500, heatThreshold: 6 } as const;
/** Base FLY speed (m/s); shift multiplies it. */
const FLY_SPEED = 4;
const FLY_FAST_MULT = 4;

/**
 * The desktop camera rig. Constructing it leaves the camera untouched in ORBIT (the
 * Phase A default). `setMode`/`update`/`followNext` drive the other three modes.
 */
export class CameraRig {
  private readonly renderer: RendererLike;
  private readonly camera: CameraLike;
  private readonly controls?: ControlsLike;
  private readonly followTargets: () => FollowTarget[];
  private readonly brain: StageBrain;

  private _mode: CameraMode = 'orbit';
  private _followIndex = 0;
  private _fly: FlyInput = { forward: 0, right: 0, up: 0, fast: false, yaw: 0, pitch: 0 };
  private _shot: Shot | null = null;
  /** FLY facing (yaw/pitch integrated from mouse-look); drives forward vector. */
  private _yaw = 0;
  private _pitch = 0;

  constructor(opts: CameraRigOpts) {
    this.renderer = opts.renderer;
    this.camera = opts.camera;
    this.controls = opts.controls;
    this.followTargets = opts.followTargets ?? (() => []);
    this.brain = new StageBrain(opts.brain ?? DEFAULT_BRAIN);
  }

  /** The active camera mode. */
  get mode(): CameraMode {
    return this._mode;
  }

  /** The current FOLLOW target id, or null when FOLLOW has no targets. */
  get followTargetId(): string | null {
    const targets = this.followTargets();
    if (targets.length === 0) return null;
    const i = ((this._followIndex % targets.length) + targets.length) % targets.length;
    return targets[i]?.id ?? null;
  }

  /** The AUTO shot the shared StageBrain last resolved (null until AUTO runs). */
  get currentShot(): Shot | null {
    return this._shot;
  }

  /**
   * Switch camera mode. ORBIT re-enables OrbitControls (the Phase A path);
   * FLY/FOLLOW/AUTO disable it so the rig owns the camera. Entering FOLLOW resets
   * the cycle to the first target.
   */
  setMode(mode: CameraMode): void {
    this._mode = mode;
    if (this.controls) this.controls.enabled = mode === 'orbit';
    if (mode === 'follow') this._followIndex = 0;
  }

  /** Cycle to the next FOLLOW target (wraps). No-op when there are no targets. */
  followNext(): void {
    const targets = this.followTargets();
    if (targets.length === 0) return;
    this._followIndex = (this._followIndex + 1) % targets.length;
  }

  /** Set the FLY input for this frame (from the desktop WASD/mouse handlers). */
  setFlyInput(input: FlyInput): void {
    this._fly = input;
  }

  /**
   * Feed one normalized RoomEvent to the AUTO StageBrain (via `events.ts`). Only
   * meaningful in AUTO mode, but harmless otherwise (the brain just accumulates
   * pending candidates that a non-AUTO `update` never resolves into camera moves).
   */
  feedAuto(ev: RoomEvent | null): void {
    if (!ev) return;
    this.brain.feed(ev);
  }

  /**
   * Advance the rig by `dt` seconds. HARD NO-OP while XR is presenting (spec §7.22
   * inertness — the camera IS the XR head; the rig must never offset it). Off-XR it
   * drives the active mode:
   *   ORBIT  — nothing (OrbitControls owns the camera).
   *   FLY    — integrate WASD + mouse-look into the camera transform.
   *   FOLLOW — chase the current target's position.
   *   AUTO   — advance the StageBrain and frame its shot's target (best-effort).
   */
  update(dt: number): void {
    // ── XR INERTNESS: while presenting, the rig is completely inert. ──
    if (this.renderer.xr.isPresenting) return;

    switch (this._mode) {
      case 'orbit':
        // The Phase A path: OrbitControls (updated by main.ts) owns the camera.
        break;
      case 'fly':
        this.updateFly(dt);
        break;
      case 'follow':
        this.updateFollow();
        break;
      case 'auto':
        this._shot = this.brain.update(dt * 1000);
        this.updateAuto();
        break;
    }
  }

  /**
   * Restore a SANE default on XR sessionstart (spec §7.22): ORBIT, so a desktop
   * that had FLY/FOLLOW/AUTO active never carries a stage-brain / free-look camera
   * into the headset. The XR head owns the camera in VR regardless; this guarantees
   * the desktop returns to the Phase A default on session end too.
   */
  onSessionStart(): void {
    this.setMode('orbit');
    // Reset FLY facing so a subsequent desktop FLY starts from a neutral heading.
    this._yaw = 0;
    this._pitch = 0;
    this._fly = { forward: 0, right: 0, up: 0, fast: false, yaw: 0, pitch: 0 };
  }

  // -------------------------------------------------------------------------
  // Per-mode integration
  // -------------------------------------------------------------------------

  private updateFly(dt: number): void {
    const f = this._fly;
    // Integrate mouse-look into the facing, clamping pitch to avoid a flip.
    this._yaw += f.yaw;
    this._pitch = clamp(this._pitch + f.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    // Forward vector from yaw/pitch (right-handed, -Z forward at yaw 0).
    const cosP = Math.cos(this._pitch);
    const fwd = {
      x: -Math.sin(this._yaw) * cosP,
      y: Math.sin(this._pitch),
      z: -Math.cos(this._yaw) * cosP,
    };
    // Right vector (perpendicular in the XZ plane).
    const right = { x: Math.cos(this._yaw), y: 0, z: -Math.sin(this._yaw) };

    const speed = FLY_SPEED * (f.fast ? FLY_FAST_MULT : 1) * dt;
    const p = this.camera.position;
    const nx = p.x + (fwd.x * f.forward + right.x * f.right) * speed;
    const ny = p.y + (fwd.y * f.forward + f.up) * speed;
    const nz = p.z + (fwd.z * f.forward + right.z * f.right) * speed;
    p.set(nx, ny, nz);
    this.camera.lookAt(nx + fwd.x, ny + fwd.y, nz + fwd.z);
  }

  private updateFollow(): void {
    const targets = this.followTargets();
    if (targets.length === 0) return;
    const i = ((this._followIndex % targets.length) + targets.length) % targets.length;
    const t = targets[i];
    if (!t) return;
    // Chase from a fixed offset behind/above, framing the target.
    const off = { x: 0, y: 1.4, z: 3 };
    this.camera.position.set(t.pos.x + off.x, t.pos.y + off.y, t.pos.z + off.z);
    this.camera.lookAt(t.pos.x, t.pos.y, t.pos.z);
  }

  private updateAuto(): void {
    const shot = this._shot;
    if (!shot) return;
    // AUTO borrows only the pure decision core (the framing follows the shot's
    // target when one exists; a bare WIDE_ESTABLISH keeps a slow establishing pose).
    const targetId = shot.targetId;
    if (!targetId) return;
    const t = this.followTargets().find((x) => x.id === targetId);
    if (!t) return;
    this.camera.lookAt(t.pos.x, t.pos.y, t.pos.z);
  }
}

/** Clamp a scalar to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
