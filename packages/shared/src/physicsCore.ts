/**
 * physicsCore.ts — pure, Three-free physics step for a single body.
 *
 * Faithfully ports packages/client/src/physics.js (pre-A6) while:
 *   1. Fixing the frame-rate-dependent friction bug:
 *      OLD: velocity.x *= FRICTION  (per-frame constant; 60fps applies more friction than 30fps)
 *      NEW: velocity.x *= Math.pow(FRICTION, dt * 60)  (exponential delta-scaling; frame-rate independent)
 *   2. Moving the out-of-bounds check to a return flag instead of inline deletion.
 *   3. Skipping integration entirely when `grabbedBy !== null`.
 *
 * All threshold values (0.5 impact speed, REST_THRESHOLD, REMOVE_DISTANCE) match physics.js exactly.
 *
 * ---------------------------------------------------------------------------
 * Task C6 — PhysicsParams + containment (spec §5.6). `stepBody` gains an
 * OPTIONAL third `params` argument that DEFAULTS to `DEFAULT_PARAMS`. The
 * default path is INERT: every new behavior (freeze, wind, timescale, gravity
 * flip, ceiling rest plane, attractors, soft-sphere clamp, speed cap,
 * suspendDespawn) is gated behind a guard that `DEFAULT_PARAMS` fails, so the
 * arithmetic on the default path is BIT-IDENTICAL to the Phase B stepBody
 * above. Parity is proven by packages/shared/test/physicsParity.golden.json
 * (1000 seeded bodies × 100 steps captured from the pre-C6 code).
 *
 * PURE: no Three/DOM/Date/Math.random. `applyRadialImpulse` is seeded.
 * ---------------------------------------------------------------------------
 */

import type { ShapeType } from './types.js';
import type { Vec3 } from './net/types.js';
import { GRAVITY, BOUNCE, FRICTION, REST_THRESHOLD, REMOVE_DISTANCE } from './constants.js';
import { restYFor } from './shapeMath.js';

// ---------------------------------------------------------------------------
// PhysicsBody — the pure-data shape of a simulated object.
// Position mirrors what Three.js stores in group.position; the adapter
// (packages/client/src/physics.ts) is responsible for syncing the group.
// ---------------------------------------------------------------------------
export interface PhysicsBody {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  scale: number;
  type: ShapeType;
  grabbedBy: string | null;
  grounded: boolean;
}

export interface StepResult {
  impact: boolean;
  impactSpeed: number;
  removed: boolean;
}

// ---------------------------------------------------------------------------
// PhysicsParams (spec §5.6) — the one shared-core knob set.
//
// Every field is OPTIONAL: a param object is a *sparse overlay* whose absent
// fields fall back to the Phase B constants. This keeps the type structurally
// compatible with a `Partial<PhysicsParams>` overlay (mergeParams / cueOverlay)
// AND with the C5-seeded RoomHandle call sites (`setBaseParams({gravity:{…}})`),
// while `DEFAULT_PARAMS` supplies every field concretely.
//
// The C5 forward-seed in cues.ts is SUPERSEDED by re-exporting these definitions.
// ---------------------------------------------------------------------------

/** A single attractor: bodies are pulled toward `pos`, strength-capped + min-radius softened. */
export interface Attractor {
  pos: Vec3;
  strength: number;
  minRadius: number;
}

export interface PhysicsParams {
  /** Gravity acceleration (m/s²). Default `{x:0, y:-5, z:0}` (Phase B GRAVITY). Flip y for a ceiling pile. */
  gravity?: Vec3;
  /** Steady wind acceleration (m/s²) added each step. Default zero (no-op). */
  wind?: Vec3;
  /** Time-scale multiplier ∈ [0.1, 2]. Default 1 (no-op). Freeze is NOT timescale 0. */
  timescale?: number;
  /** Short-circuit: skip ALL integration, conserve state bit-exactly. Default false. */
  freeze?: boolean;
  /** Radial attractors (SINGULARITY). Strength-capped, min-radius-softened. Default none. */
  attractors?: Attractor[];
  /** Containment bounds. Default inert: `{ softSphereR: Infinity, speedCap: Infinity }`. */
  bounds?: { ceilingY?: number; softSphereR: number; speedCap: number };
  /** When true, the REMOVE_DISTANCE despawn is skipped (dials set this). Default false. */
  suspendDespawn?: boolean;
  /** Bounce coefficient. Default BOUNCE (0.5). */
  restitution?: number;
  /** Horizontal friction (per-60fps-frame). Default FRICTION (0.98). */
  friction?: number;
  /** Full-stop settle threshold. Default REST_THRESHOLD (0.05). */
  restThreshold?: number;
}

// ---------------------------------------------------------------------------
// DEFAULT_PARAMS — the INERT baseline (spec §5.6 "Defaults are inert").
//
// softSphereR/speedCap = Infinity, suspendDespawn: false, gravity = Phase B
// GRAVITY on y. Under these values every param-gated branch in stepBody is
// skipped, so behavior is bit-for-bit Phase B. Frozen so a caller can never
// mutate the shared inert baseline (the RESET contract reverts to THIS ref).
// ---------------------------------------------------------------------------
export const DEFAULT_PARAMS: PhysicsParams = Object.freeze({
  gravity: Object.freeze({ x: 0, y: GRAVITY, z: 0 }),
  wind: Object.freeze({ x: 0, y: 0, z: 0 }),
  timescale: 1,
  freeze: false,
  attractors: Object.freeze([]) as unknown as Attractor[],
  bounds: Object.freeze({ softSphereR: Infinity, speedCap: Infinity }),
  suspendDespawn: false,
  restitution: BOUNCE,
  friction: FRICTION,
  restThreshold: REST_THRESHOLD,
}) as PhysicsParams;

// ---------------------------------------------------------------------------
// DIAL_BOUNDS — the ACTIVE containment clamp limits (spec §5.6). Dial/showpiece
// cues put these into their param envelopes; they are NOT the default.
// ---------------------------------------------------------------------------
export const DIAL_BOUNDS = Object.freeze({ softSphereR: 18, speedCap: 30 });

// ---------------------------------------------------------------------------
// mergeParams — field-wise, overlay-wins. Identity on null/undefined overlay.
// Never mutates `base`. Absent overlay fields fall through to base.
// ---------------------------------------------------------------------------
export function mergeParams(
  base: PhysicsParams,
  overlay: Partial<PhysicsParams> | null | undefined
): PhysicsParams {
  if (overlay === null || overlay === undefined) return base;
  const out: PhysicsParams = { ...base };
  // Field-wise overlay-wins: only overwrite keys the overlay actually provides.
  for (const key of Object.keys(overlay) as (keyof PhysicsParams)[]) {
    const v = overlay[key];
    if (v !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// stepBody — integrate one time step in place; return result flags.
// Pure: only mutates the provided body; never touches any store or renderer.
//
// The third `params` argument DEFAULTS to DEFAULT_PARAMS so every existing
// caller (serverWorld.step, client physics adapter) keeps bit-identical Phase B
// behavior. New behaviors are param-gated; the guards are written so the
// DEFAULT_PARAMS path executes the ORIGINAL instruction sequence unchanged.
// ---------------------------------------------------------------------------
export function stepBody(body: PhysicsBody, dt: number, params: PhysicsParams = DEFAULT_PARAMS): StepResult {
  // Grabbed shapes are held by a peer; skip integration entirely.
  if (body.grabbedBy !== null) {
    return { impact: false, impactSpeed: 0, removed: false };
  }

  // --- FREEZE short-circuit (C6): conserve state bit-exactly, no float ops. ---
  // A frozen world is fully static; velocity is BANKED (released on unfreeze).
  if (params.freeze === true) {
    return { impact: false, impactSpeed: 0, removed: false };
  }

  // --- Resolve params. On the DEFAULT_PARAMS path these locals equal the Phase
  //     B constants, and each `!== default` guard below is FALSE, so the
  //     arithmetic reduces to the original stepBody exactly. ---
  const grav = params.gravity;
  const gy = grav ? grav.y : GRAVITY;
  const gx = grav ? grav.x : 0;
  const gz = grav ? grav.z : 0;
  const wind = params.wind;
  const timescale = params.timescale ?? 1;
  const bounce = params.restitution ?? BOUNCE;
  const friction = params.friction ?? FRICTION;
  const restThreshold = params.restThreshold ?? REST_THRESHOLD;
  const bounds = params.bounds;
  const attractors = params.attractors;

  // --- Timescale (C6): scale dt. DEFAULT timescale===1 → identical dt. ---
  const sdt = timescale === 1 ? dt : dt * timescale;

  // --- Attractor pull (C6): strength-capped, min-radius-softened. No-op default. ---
  if (attractors && attractors.length > 0) {
    for (const a of attractors) {
      const dx = a.pos.x - body.position.x;
      const dy = a.pos.y - body.position.y;
      const dz = a.pos.z - body.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const soft = Math.max(distSq, a.minRadius * a.minRadius);
      const dist = Math.sqrt(soft);
      // Inverse-square pull, capped by strength; normalize by the softened dist.
      const accel = a.strength / soft;
      const inv = accel / dist;
      body.velocity.x += dx * inv * sdt;
      body.velocity.y += dy * inv * sdt;
      body.velocity.z += dz * inv * sdt;
    }
  }

  // --- Gravity (physics.js line 12). gy===GRAVITY on the default path. ---
  body.velocity.y += gy * sdt;
  // Horizontal gravity components (gravity tilt) — skipped on the default path.
  if (gx !== 0) body.velocity.x += gx * sdt;
  if (gz !== 0) body.velocity.z += gz * sdt;

  // --- Wind (C6): steady horizontal/vertical accel. Skipped when zero (default). ---
  if (wind && (wind.x !== 0 || wind.y !== 0 || wind.z !== 0)) {
    body.velocity.x += wind.x * sdt;
    body.velocity.y += wind.y * sdt;
    body.velocity.z += wind.z * sdt;
  }

  // --- Speed cap (C6): clamp |v| ≤ speedCap. Infinity default → no-op. ---
  const speedCap = bounds ? bounds.speedCap : Infinity;
  if (speedCap !== Infinity) {
    const sp = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z);
    if (sp > speedCap) {
      const k = speedCap / sp;
      body.velocity.x *= k;
      body.velocity.y *= k;
      body.velocity.z *= k;
    }
  }

  // --- Integrate position (physics.js lines 14-16). sdt===dt on default. ---
  body.position.x += body.velocity.x * sdt;
  body.position.y += body.velocity.y * sdt;
  body.position.z += body.velocity.z * sdt;

  // --- Floor collision (physics.js lines 18-33) ---
  const restY = restYFor(body.type, body.scale);
  let impact = false;
  let impactSpeed = 0;

  if (body.position.y <= restY) {
    body.position.y = restY;

    const velAbsY = Math.abs(body.velocity.y);

    // Impact threshold: physics.js line 25 (`impactVel > 0.5`)
    if (velAbsY > 0.5) {
      impact = true;
      impactSpeed = velAbsY;
    }

    // Bounce (physics.js line 29). bounce===BOUNCE on the default path.
    body.velocity.y = -body.velocity.y * bounce;

    // Settle if post-bounce velocity is tiny (physics.js lines 31-33)
    if (Math.abs(body.velocity.y) < restThreshold) {
      body.velocity.y = 0;
    }
  }

  // --- Ceiling rest plane (C6): mirror of the floor when a ceilingY is set
  //     (gravity flip → shapes pile overhead). ONLY runs when bounds.ceilingY
  //     is defined; the default path has no ceilingY so this is skipped. ---
  const ceilingY = bounds ? bounds.ceilingY : undefined;
  let ceilRestY = 0;
  let atCeiling = false;
  if (ceilingY !== undefined) {
    ceilRestY = ceilingY - restY;
    if (body.position.y >= ceilRestY) {
      body.position.y = ceilRestY;
      const velAbsY = Math.abs(body.velocity.y);
      if (velAbsY > 0.5) {
        impact = true;
        impactSpeed = velAbsY;
      }
      body.velocity.y = -body.velocity.y * bounce;
      if (Math.abs(body.velocity.y) < restThreshold) {
        body.velocity.y = 0;
      }
      atCeiling = true;
    }
  }

  // --- Delta-scaled horizontal friction (fixes physics.js lines 36-37 bug) ---
  // friction===FRICTION and sdt===dt on the default path → Math.pow(FRICTION, dt*60).
  const frictionFactor = Math.pow(friction, sdt * 60);
  body.velocity.x *= frictionFactor;
  body.velocity.z *= frictionFactor;

  // --- Full-stop settle (physics.js lines 40-46) ---
  // On the default path (no ceiling) this is the original settle exactly. When a
  // ceiling plane is active and the body rests against it, settle it there too.
  const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z);
  if (speed < restThreshold && body.position.y <= restY + 0.01) {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.position.y = restY;
    body.grounded = true;
  } else if (atCeiling && speed < restThreshold && body.position.y >= ceilRestY - 0.01) {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.position.y = ceilRestY;
    body.grounded = true;
  } else {
    body.grounded = false;
  }

  // --- Soft-sphere containment (C6): keep the body within softSphereR of the
  //     origin; bounce it back on breach. Infinity default → no-op (bit-parity). ---
  const softSphereR = bounds ? bounds.softSphereR : Infinity;
  if (softSphereR !== Infinity) {
    const r = Math.hypot(body.position.x, body.position.y, body.position.z);
    if (r > softSphereR && r > 0) {
      const k = softSphereR / r;
      // Clamp position back onto the sphere surface.
      body.position.x *= k;
      body.position.y *= k;
      body.position.z *= k;
      // Reflect the outward radial velocity component inward (bounce off the shell).
      const nx = body.position.x / softSphereR;
      const ny = body.position.y / softSphereR;
      const nz = body.position.z / softSphereR;
      const vDotN = body.velocity.x * nx + body.velocity.y * ny + body.velocity.z * nz;
      if (vDotN > 0) {
        const j = (1 + bounce) * vDotN;
        body.velocity.x -= j * nx;
        body.velocity.y -= j * ny;
        body.velocity.z -= j * nz;
      }
    }
  }

  // --- Out-of-bounds check (physics.js lines 48-55; replicated as a flag) ---
  // physics.js used `shape.group.position.length()` which is THREE.Vector3.length()
  // = Math.sqrt(x^2 + y^2 + z^2) = Math.hypot(x, y, z). Replicate exactly.
  // suspendDespawn (C6): while a dial is active, the despawn is skipped entirely.
  let removed = false;
  if (params.suspendDespawn !== true) {
    const dist = Math.hypot(body.position.x, body.position.y, body.position.z);
    removed = dist > REMOVE_DISTANCE;
  }

  return { impact, impactSpeed, removed };
}

// ---------------------------------------------------------------------------
// applyRadialImpulse — deterministic (seeded) radial velocity impulse (spec
// §7.13 finale drop; standalone pure fn with Vitest goldens). Pushes each body
// away from `epicenter` with a magnitude that falls off with distance, plus a
// small SEEDED jitter (no Math.random). Grabbed bodies are left untouched.
// ---------------------------------------------------------------------------

/** mulberry32 — the same seeded PRNG used across the shared package (callsigns). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function applyRadialImpulse(
  bodies: PhysicsBody[],
  epicenter: Vec3,
  magnitude: number,
  seed: number
): void {
  const rng = mulberry32(seed);
  for (const body of bodies) {
    // Draw jitter for EVERY body (even grabbed) so the seeded stream is
    // position-independent and deterministic regardless of grab state.
    const jx = (rng() - 0.5) * 0.2;
    const jy = (rng() - 0.5) * 0.2;
    const jz = (rng() - 0.5) * 0.2;
    if (body.grabbedBy !== null) continue; // held bodies are exempt.

    let dx = body.position.x - epicenter.x;
    let dy = body.position.y - epicenter.y;
    let dz = body.position.z - epicenter.z;
    let dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) {
      // Body sits on the epicenter — push it straight up (deterministic).
      dx = 0;
      dy = 1;
      dz = 0;
      dist = 1;
    }
    // Unit radial direction + seeded jitter, re-normalized.
    let ux = dx / dist + jx;
    let uy = dy / dist + jy;
    let uz = dz / dist + jz;
    const ulen = Math.hypot(ux, uy, uz) || 1;
    ux /= ulen;
    uy /= ulen;
    uz /= ulen;
    // Falloff with distance (inverse-linear, softened) so near bodies fly hardest.
    const strength = magnitude / (1 + dist);
    body.velocity.x += ux * strength;
    body.velocity.y += uy * strength;
    body.velocity.z += uz * strength;
  }
}
