/**
 * tkMath.ts — Task C32 F21 Powers Lab (spec §7.21), the PURE telekinesis math.
 *
 * ALL TK-specific math lives HERE so a Tier-6 cut leaves NO residue in the Tier
 * ≤5 files (the server host in `powersLab.ts` owns the world mutation; this module
 * only computes vectors + scalars). Every function is deterministic — NO Date.now,
 * NO Math.random (Global Constraints) — so the server host and the tests drive it
 * exactly.
 *
 * The surfaces (spec §7.21):
 *   • tkPullVelocity   — the per-tick, strength-capped, MIN-RADIUS-SOFTENED pull
 *                        toward the hand anchor (the loop force like titan hands —
 *                        a velocity delta, NOT a PhysicsParams change);
 *   • tkConeSelect     — the 300 ms sustained-hold cone pick (nearest-to-axis among
 *                        eligible shapes; the CALLER supplies the eligible set so
 *                        "excludes grabbed + pinned" is enforced upstream);
 *   • advanceConeHold  — the pure sustained-hold reducer (commit after 300 ms of a
 *                        stable target);
 *   • tkDeadManExpired — the ~250 ms dead-man's switch predicate;
 *   • tkGrabRadiusReached — the pull→grab conversion predicate;
 *   • tkClampSpeed     — the per-pull speed cap (also the release-throw clamp).
 */

import type { Vec3 } from './net/types.js';
import {
  TK_PULL_STRENGTH,
  TK_PULL_SPEED_MAX,
  TK_MIN_RADIUS,
  TK_GRAB_RADIUS,
  TK_DEADMAN_MS,
  TK_SELECT_HOLD_MS,
  TK_CONE_HALF_ANGLE,
  TK_CONE_RANGE,
} from './constants.js';

/** True iff all three components are finite. */
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function magnitude(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * Clamp a velocity magnitude to `max` (default the per-pull speed cap
 * {@link TK_PULL_SPEED_MAX}), preserving direction. A non-finite input returns a
 * zero vector so a NaN can never become an undespawnable ghost. This is BOTH the
 * loop-force clamp AND the release-throw clamp (spec §7.21 "per-pull speed cap").
 */
export function tkClampSpeed(vel: Vec3, max: number = TK_PULL_SPEED_MAX): Vec3 {
  if (!finiteVec(vel)) return { x: 0, y: 0, z: 0 };
  const cap = Number.isFinite(max) && max > 0 ? max : TK_PULL_SPEED_MAX;
  const speed = magnitude(vel);
  if (speed <= cap || speed < 1e-9) return { x: vel.x, y: vel.y, z: vel.z };
  const k = cap / speed;
  return { x: vel.x * k, y: vel.y * k, z: vel.z * k };
}

/**
 * The MIN-RADIUS softening factor (spec §7.21 "min-radius-softened"): 0 at/inside
 * the anchor, easing (smoothstep) up to 1 at `TK_MIN_RADIUS`, and 1 beyond. So the
 * pull is full-strength at distance and fades to zero as the shape reaches the
 * palm — it decays to rest there instead of oscillating through the hand.
 */
export function tkSoftenFactor(dist: number, minRadius: number = TK_MIN_RADIUS): number {
  if (!Number.isFinite(dist) || dist <= 0) return 0;
  const r = Number.isFinite(minRadius) && minRadius > 0 ? minRadius : TK_MIN_RADIUS;
  if (dist >= r) return 1;
  const t = dist / r; // 0→1 across the softening band
  return t * t * (3 - 2 * t); // smoothstep
}

export interface TkPullOpts {
  /** Base pull acceleration (m/s²). Default {@link TK_PULL_STRENGTH}. */
  strength?: number;
  /** Per-pull speed cap (m/s). Default {@link TK_PULL_SPEED_MAX}. */
  speedMax?: number;
  /** Min-radius softening distance (m). Default {@link TK_MIN_RADIUS}. */
  minRadius?: number;
}

/**
 * The per-tick loop-force pull: given a shape's current position + velocity, the
 * hand anchor, and the tick `dt` (seconds), return the shape's NEW velocity after
 * one tick of a strength-capped, min-radius-softened pull toward the anchor (spec
 * §7.21). This is a VELOCITY delta the host writes onto `shape.velocity` — exactly
 * the titan LOOP-FORCE pattern, NEVER a PhysicsParams change.
 *
 * Deterministic and pure. The direction is anchor − shapePos (toward the hand);
 * the magnitude is `strength × dt × soften(dist)`, added to the current velocity,
 * then the RESULT is clamped to the per-pull speed cap. A coincident shape/anchor
 * (dist ≈ 0) or a non-finite input returns the current velocity unchanged (no NaN).
 */
export function tkPullVelocity(
  shapePos: Vec3,
  currentVel: Vec3,
  anchorPos: Vec3,
  dt: number,
  opts: TkPullOpts = {}
): Vec3 {
  if (!finiteVec(shapePos) || !finiteVec(currentVel) || !finiteVec(anchorPos)) {
    return { x: 0, y: 0, z: 0 };
  }
  if (!Number.isFinite(dt) || dt <= 0) return { x: currentVel.x, y: currentVel.y, z: currentVel.z };

  const strength = opts.strength ?? TK_PULL_STRENGTH;
  const speedMax = opts.speedMax ?? TK_PULL_SPEED_MAX;
  const minRadius = opts.minRadius ?? TK_MIN_RADIUS;

  const dx = anchorPos.x - shapePos.x;
  const dy = anchorPos.y - shapePos.y;
  const dz = anchorPos.z - shapePos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) {
    // In the palm: no radial direction. Damp toward rest so a settled shape stops.
    return tkClampSpeed({ x: currentVel.x * 0.5, y: currentVel.y * 0.5, z: currentVel.z * 0.5 }, speedMax);
  }

  const soften = tkSoftenFactor(dist, minRadius);
  const dv = strength * dt * soften; // scalar velocity increment this tick
  const inv = dv / dist;
  const next: Vec3 = {
    x: currentVel.x + dx * inv,
    y: currentVel.y + dy * inv,
    z: currentVel.z + dz * inv,
  };
  return tkClampSpeed(next, speedMax);
}

/** A cone-select candidate: an id + its world position. */
export interface TkConeCandidate {
  id: string;
  position: Vec3;
}

export interface TkConeOpts {
  /** Cone half-angle (rad). Default {@link TK_CONE_HALF_ANGLE}. */
  halfAngle?: number;
  /** Max range (m). Default {@link TK_CONE_RANGE}. */
  range?: number;
}

/**
 * Cone-select: among the ELIGIBLE candidates, pick the one nearest the pointing
 * axis within the cone (half-angle + range). The CALLER supplies only eligible
 * shapes (the host filters out grabbed + pinned bodies — spec §7.21 "cone-select
 * excludes grabbedBy !== null AND pinned"), so this stays a pure geometric pick.
 *
 * `dir` need not be normalized (it is normalized here). Selection: smallest angle
 * to the axis wins; ties break to the NEARER shape, then to the lexicographically
 * smaller id (fully deterministic). Returns null when nothing lies in the cone or
 * any input is degenerate.
 */
export function tkConeSelect(
  anchor: Vec3,
  dir: Vec3,
  candidates: readonly TkConeCandidate[],
  opts: TkConeOpts = {}
): string | null {
  if (!finiteVec(anchor) || !finiteVec(dir)) return null;
  const dm = magnitude(dir);
  if (dm < 1e-6) return null;
  const ax = dir.x / dm;
  const ay = dir.y / dm;
  const az = dir.z / dm;

  const halfAngle = opts.halfAngle ?? TK_CONE_HALF_ANGLE;
  const range = opts.range ?? TK_CONE_RANGE;
  const cosLimit = Math.cos(halfAngle);

  let bestId: string | null = null;
  let bestCos = -Infinity;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (!c || !finiteVec(c.position)) continue;
    const dx = c.position.x - anchor.x;
    const dy = c.position.y - anchor.y;
    const dz = c.position.z - anchor.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6 || dist > range) continue;
    const cos = (dx * ax + dy * ay + dz * az) / dist; // cos(angle to axis)
    if (cos < cosLimit) continue; // outside the cone
    // Nearest-to-axis wins; ties → nearer; ties → smaller id (deterministic).
    if (
      cos > bestCos + 1e-9 ||
      (Math.abs(cos - bestCos) <= 1e-9 && dist < bestDist - 1e-9) ||
      (Math.abs(cos - bestCos) <= 1e-9 &&
        Math.abs(dist - bestDist) <= 1e-9 &&
        (bestId === null || c.id < bestId))
    ) {
      bestId = c.id;
      bestCos = cos;
      bestDist = dist;
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Sustained-hold reducer (spec §7.21 "300 ms sustained-hold cone-select").
// PURE + deterministic: the host feeds it the current cone target + `now`; it
// tracks how long a target has been held and reports `committed` once the hold
// crosses TK_SELECT_HOLD_MS. A target CHANGE resets the clock — a glance across a
// shape never commits.
// ---------------------------------------------------------------------------

export interface ConeHoldState {
  /** The target currently being held (null = nothing in the cone). */
  targetId: string | null;
  /** The time (ms) the current target was first seen; 0 when targetId is null. */
  heldSince: number;
  /** True once the current target has been held ≥ TK_SELECT_HOLD_MS. */
  committed: boolean;
}

/** The zero state a fresh hold starts from. */
export const CONE_HOLD_INIT: ConeHoldState = Object.freeze({
  targetId: null,
  heldSince: 0,
  committed: false,
});

/**
 * Advance the sustained-hold reducer. `candidateId` is this frame's cone pick
 * (null = nothing selectable this frame). Returns the next {@link ConeHoldState}:
 *   • a NEW / different / null candidate resets the clock (committed=false);
 *   • the SAME candidate held ≥ `holdMs` (default TK_SELECT_HOLD_MS) commits.
 * Deterministic in (prev, candidateId, now). The host commits the pull on the
 * rising edge to `committed === true`.
 */
export function advanceConeHold(
  prev: ConeHoldState,
  candidateId: string | null,
  now: number,
  holdMs: number = TK_SELECT_HOLD_MS
): ConeHoldState {
  const t = Number.isFinite(now) ? now : 0;
  if (candidateId === null) {
    return { targetId: null, heldSince: 0, committed: false };
  }
  if (prev.targetId !== candidateId) {
    // A new/changed target — restart the hold clock.
    return { targetId: candidateId, heldSince: t, committed: false };
  }
  const held = t - prev.heldSince;
  const committed = held >= holdMs;
  return { targetId: candidateId, heldSince: prev.heldSince, committed };
}

/**
 * The DEAD-MAN'S SWITCH predicate (spec §7.21 "~250 ms"): true iff more than the
 * dead-man window has elapsed since the last fresh TK_PULL — the pull must then be
 * released (tracking loss / a dropped hand never freezes a stale force).
 */
export function tkDeadManExpired(
  lastPullAt: number,
  now: number,
  windowMs: number = TK_DEADMAN_MS
): boolean {
  if (!Number.isFinite(lastPullAt) || !Number.isFinite(now)) return true;
  return now - lastPullAt > windowMs;
}

/**
 * The pull→grab conversion predicate (spec §7.21 "at grab radius it converts to a
 * normal Phase B first-claim-wins grab"): true iff the shape is within
 * {@link TK_GRAB_RADIUS} of the hand anchor.
 */
export function tkGrabRadiusReached(
  shapePos: Vec3,
  anchorPos: Vec3,
  radius: number = TK_GRAB_RADIUS
): boolean {
  if (!finiteVec(shapePos) || !finiteVec(anchorPos)) return false;
  const dx = anchorPos.x - shapePos.x;
  const dy = anchorPos.y - shapePos.y;
  const dz = anchorPos.z - shapePos.z;
  return Math.hypot(dx, dy, dz) <= radius;
}
