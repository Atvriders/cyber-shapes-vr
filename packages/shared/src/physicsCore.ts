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
 */

import type { ShapeType } from './types.js';
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
// stepBody — integrate one time step in place; return result flags.
// Pure: only mutates the provided body; never touches any store or renderer.
// ---------------------------------------------------------------------------
export function stepBody(body: PhysicsBody, dt: number): StepResult {
  // Grabbed shapes are held by a peer; skip integration entirely.
  if (body.grabbedBy !== null) {
    return { impact: false, impactSpeed: 0, removed: false };
  }

  // --- Gravity (physics.js line 12) ---
  body.velocity.y += GRAVITY * dt;

  // --- Integrate position (physics.js lines 14-16) ---
  body.position.x += body.velocity.x * dt;
  body.position.y += body.velocity.y * dt;
  body.position.z += body.velocity.z * dt;

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

    // Bounce (physics.js line 29)
    body.velocity.y = -body.velocity.y * BOUNCE;

    // Settle if post-bounce velocity is tiny (physics.js lines 31-33)
    if (Math.abs(body.velocity.y) < REST_THRESHOLD) {
      body.velocity.y = 0;
    }
  }

  // --- Delta-scaled horizontal friction (fixes physics.js lines 36-37 bug) ---
  // physics.js: velocity.x *= FRICTION  (frame-rate-dependent: at 30fps you apply it once,
  //   at 60fps twice per real second — giving wildly different damping).
  // Fix: exponentiate so the accumulated friction per second is FRICTION^60 regardless of step count.
  const frictionFactor = Math.pow(FRICTION, dt * 60);
  body.velocity.x *= frictionFactor;
  body.velocity.z *= frictionFactor;

  // --- Full-stop settle (physics.js lines 40-46) ---
  const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z);
  if (speed < REST_THRESHOLD && body.position.y <= restY + 0.01) {
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.position.y = restY;
    body.grounded = true;
  } else {
    body.grounded = false;
  }

  // --- Out-of-bounds check (physics.js lines 48-55; replicated as a flag) ---
  // physics.js used `shape.group.position.length()` which is THREE.Vector3.length()
  // = Math.sqrt(x^2 + y^2 + z^2) = Math.hypot(x, y, z). Replicate exactly.
  const dist = Math.hypot(body.position.x, body.position.y, body.position.z);
  const removed = dist > REMOVE_DISTANCE;

  return { impact, impactSpeed, removed };
}
