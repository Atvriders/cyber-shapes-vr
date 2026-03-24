const GRAVITY = -5;
const BOUNCE = 0.5;
const FRICTION = 0.98;
const REST_THRESHOLD = 0.05;
const REMOVE_DISTANCE = 50;

export function updatePhysics(delta, world, onImpact) {
  for (let i = world.shapes.length - 1; i >= 0; i--) {
    const shape = world.shapes[i];
    if (shape.grabbed) continue;

    shape.velocity.y += GRAVITY * delta;

    shape.group.position.x += shape.velocity.x * delta;
    shape.group.position.y += shape.velocity.y * delta;
    shape.group.position.z += shape.velocity.z * delta;

    const restY = 0.15 * shape.scale;

    if (shape.group.position.y <= restY) {
      shape.group.position.y = restY;

      const impactVel = Math.abs(shape.velocity.y);

      if (impactVel > 0.5 && onImpact) {
        onImpact(shape);
      }

      shape.velocity.y = -shape.velocity.y * BOUNCE;

      if (Math.abs(shape.velocity.y) < REST_THRESHOLD) {
        shape.velocity.y = 0;
      }
    }

    shape.velocity.x *= FRICTION;
    shape.velocity.z *= FRICTION;

    const speed = shape.velocity.length();
    if (speed < REST_THRESHOLD && shape.group.position.y <= restY + 0.01) {
      shape.velocity.set(0, 0, 0);
      shape.group.position.y = restY;
      shape.grounded = true;
    } else {
      shape.grounded = false;
    }

    const dist = shape.group.position.length();
    if (dist > REMOVE_DISTANCE) {
      world.scene.remove(shape.group);
      shape.solidMesh.geometry.dispose();
      shape.solidMesh.material.dispose();
      shape.wireMesh.material.dispose();
      world.shapes.splice(i, 1);
    }
  }
}
