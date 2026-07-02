/**
 * physics.ts — Three.js adapter over the pure physicsCore.
 *
 * Replaces physics.js (deleted). Key differences from physics.js:
 *  - Removal routes through store.remove(id) — the SINGLE deletion path — instead
 *    of inline scene.remove + splice (which bypassed ShapeStore and skipped the
 *    despawn event).
 *  - Friction is delta-scaled (FRICTION ** (dt*60)) rather than a per-frame
 *    constant multiply; see physicsCore.ts for the full explanation.
 *  - The onImpact callback receives (shape, impactSpeed) instead of just (shape).
 */

import type { ShapeStore, ClientShape } from './world.js';
import { stepBody, type PhysicsBody } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// updatePhysics — the new export.
// Called from the game loop with (dt, store, onImpact).
// ---------------------------------------------------------------------------
export function updatePhysics(
  dt: number,
  store: ShapeStore,
  onImpact: (shape: ClientShape, impactSpeed: number) => void
): void {
  // Snapshot the array so removal during iteration is safe.
  const shapes = store.shapes.slice();

  for (const shape of shapes) {
    // Build a PhysicsBody from the ClientShape, reading position from the THREE group.
    const body: PhysicsBody = {
      position: {
        x: shape.group.position.x,
        y: shape.group.position.y,
        z: shape.group.position.z,
      },
      velocity: shape.velocity, // plain {x,y,z} — shared by reference intentionally
      scale: shape.scale,
      type: shape.type,
      grabbedBy: shape.grabbedBy,
      grounded: shape.grounded,
    };

    const result = stepBody(body, dt);

    // Write position back to the THREE group.
    shape.group.position.set(body.position.x, body.position.y, body.position.z);

    // velocity was mutated in-place (shared reference), but write back explicitly for clarity.
    shape.velocity.x = body.velocity.x;
    shape.velocity.y = body.velocity.y;
    shape.velocity.z = body.velocity.z;

    shape.grounded = body.grounded;

    if (result.impact) {
      onImpact(shape, result.impactSpeed);
    }

    if (result.removed) {
      // Route through the SINGLE deletion path so despawn event fires and geometry is disposed.
      store.remove(shape.id);
    }
  }
}
