/**
 * titanMath.ts — Task C17 F7 Titan Protocol (spec §7.7), the PURE math.
 *
 * "Titan hands are impulse sources" — the server applies these radial impulses to
 * non-grabbed shapes within the scaled hand radius each tick. Every function here
 * is deterministic (NO Date.now, NO Math.random — Global Constraints): the server
 * host and the tests drive it exactly. The server layer owns the world mutation;
 * this module only computes vectors + scalars.
 *
 * The four surfaces:
 *   • titanHandImpulse   — radial impulse from a moving giant hand (falloff +
 *                          hand-speed scaling + containment damping outside
 *                          WORLD_RADIUS + TITAN_THROW_MAX clamp);
 *   • clampThrowVelocity — the TITAN_THROW_MAX velocity clamp (throwbacks);
 *   • isTitanOutOfBounds — |pos| > WORLD_RADIUS (the OOB-recall predicate);
 *   • titanRecallPosition— a deterministic respawn INSIDE WORLD_RADIUS;
 *   • titanRigScale      — the 1→scale ease over TITAN_SCALE_MS (identity at t=0).
 */

import type { Vec3 } from './net/types.js';
// WORLD_RADIUS lives in callsigns.ts (its §6.1 home); the titan constants are in
// constants.ts. Import each from its real module so neither resolves to undefined.
import { WORLD_RADIUS } from './callsigns.js';
import {
  TITAN_THROW_MAX,
  TITAN_HAND_REACH,
  TITAN_IMPULSE_STRENGTH,
  TITAN_SCALE_MS,
  TITAN_RECALL_RADIUS,
} from './constants.js';

/** True iff all three components are finite. */
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function magnitude(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * The radial impulse a giant titan hand imparts to a nearby non-grabbed shape.
 *
 * Direction: radially AWAY from the hand (hand → shape), so a sweep scatters
 * shapes outward — the "giant's hand sweeps down scattering shapes" moment.
 * Magnitude: `TITAN_IMPULSE_STRENGTH` × handSpeed-factor × linear-falloff, then
 * CLAMPED to `TITAN_THROW_MAX`. The effective reach is `TITAN_HAND_REACH ×
 * rigScale` (a scaled hand sweeps a scaled volume, spec §7.7).
 *
 * Containment: if the shape is already OUTSIDE `WORLD_RADIUS`, the impulse is
 * DAMPED — a titan sweep must never fling a shape further out of bounds (the OOB
 * recall then pulls it back; the impulse just shouldn't make that worse).
 *
 * Returns null when the shape is beyond the scaled reach, the hand/shape are
 * coincident (no radial direction), or any input is non-finite.
 */
export function titanHandImpulse(
  shapePos: Vec3,
  handPos: Vec3,
  handVel: Vec3,
  rigScale: number
): Vec3 | null {
  if (!finiteVec(shapePos) || !finiteVec(handPos) || !finiteVec(handVel)) return null;
  if (!Number.isFinite(rigScale) || rigScale <= 0) return null;

  // Radial direction: hand → shape.
  const dx = shapePos.x - handPos.x;
  const dy = shapePos.y - handPos.y;
  const dz = shapePos.z - handPos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return null; // coincident — no radial direction

  const reach = TITAN_HAND_REACH * rigScale;
  if (dist > reach) return null; // outside the scaled hand volume

  // Linear falloff: full strength at the hand, zero at the reach edge.
  const falloff = 1 - dist / reach; // ∈ (0, 1]

  // Hand-speed factor: a faster sweep imparts more. Saturates so a hostile huge
  // hand velocity can't blow past the clamp (the clamp below is the hard bound;
  // this keeps the pre-clamp value sane and monotonic in speed).
  const handSpeed = magnitude(handVel);
  const speedFactor = handSpeed / (handSpeed + 2); // ∈ [0, 1), monotonic in speed

  // Containment: damp the push for a shape already outside the world sphere.
  const contain = magnitude(shapePos) > WORLD_RADIUS ? 0.25 : 1;

  let strength = TITAN_IMPULSE_STRENGTH * speedFactor * falloff * contain;
  if (strength > TITAN_THROW_MAX) strength = TITAN_THROW_MAX;

  const inv = strength / dist;
  const out: Vec3 = { x: dx * inv, y: dy * inv, z: dz * inv };
  return finiteVec(out) ? out : null;
}

/**
 * Clamp a throw/impulse velocity magnitude to `TITAN_THROW_MAX`, preserving its
 * direction (spec §7.7). A non-finite input returns a zero vector so a NaN can
 * never become an undespawnable ghost (mirrors the world's finite guards).
 */
export function clampThrowVelocity(vel: Vec3): Vec3 {
  if (!finiteVec(vel)) return { x: 0, y: 0, z: 0 };
  const speed = magnitude(vel);
  if (speed <= TITAN_THROW_MAX || speed < 1e-9) return { x: vel.x, y: vel.y, z: vel.z };
  const k = TITAN_THROW_MAX / speed;
  return { x: vel.x * k, y: vel.y * k, z: vel.z * k };
}

/**
 * The OOB-recall predicate: true iff the shape is strictly beyond `WORLD_RADIUS`
 * (or carries a non-finite position — recall it rather than keep a ghost). This
 * is checked ONLY while a titan is active, BEFORE the physics `removed` flag is
 * honored (spec §7.7); baseline throws keep the Phase B despawn at REMOVE_DISTANCE.
 */
export function isTitanOutOfBounds(pos: Vec3): boolean {
  if (!finiteVec(pos)) return true;
  return magnitude(pos) > WORLD_RADIUS;
}

/**
 * A deterministic respawn position INSIDE `WORLD_RADIUS` for a recalled shape
 * (spec §7.7 "respawn at origin"). Places it on a small floating ring of radius
 * `TITAN_RECALL_RADIUS` at an angle derived from `seed` (an integer counter) so a
 * burst of simultaneous recalls does not stack on one point. NO Math.random.
 */
export function titanRecallPosition(_from: Vec3, seed: number): Vec3 {
  const s = Number.isFinite(seed) ? seed : 0;
  // Golden-angle stepping spreads consecutive seeds around the ring.
  const angle = s * 2.399963229728653; // ~137.5° in radians
  const r = TITAN_RECALL_RADIUS;
  return {
    x: Math.cos(angle) * r,
    y: 3 + (s % 3), // a small vertical spread so they rain, not pile
    z: Math.sin(angle) * r,
  };
}

/**
 * The rig-scale ease: 1 at `elapsedMs = 0`, easing up to `target` at
 * `elapsedMs = TITAN_SCALE_MS` and holding there after (spec §7.7: "1→5 over
 * 1.5 s ease"). smoothstep for a comfortable, non-linear grow. Identity (1) at
 * t=0 is the rig-scale-1 parity anchor.
 */
export function titanRigScale(elapsedMs: number, target: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (!Number.isFinite(target) || target <= 1) return 1;
  const t = Math.min(1, elapsedMs / TITAN_SCALE_MS);
  const eased = t * t * (3 - 2 * t); // smoothstep, 0→1
  return 1 + (target - 1) * eased;
}
