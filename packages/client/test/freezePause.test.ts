/**
 * freezePause.test.ts — Task C11 client freeze render-pause (Tier 1, owned here).
 *
 * While the world is FROZEN (effectiveParams.freeze via ENV_STATE), clients SKIP
 * BOTH autonomous animations:
 *   • shapes.ts updateShapeRender's `rotation += rotSpeed * delta`
 *   • main.ts gameLoop's `bobPhase += delta * 2`   (extracted to advanceShapeBob)
 *
 * A frozen world is fully static (spec §5.6/§7.3). CRITICAL: when NOT frozen the
 * behavior is BYTE-IDENTICAL to Phase B — rotation + bob advance exactly as before
 * (the parity half of every test). THREE Group/Mesh construct fine under node.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ShapeStore } from '../src/world.ts';
import {
  updateShapeRender,
  advanceShapeBob,
  disposeGeometryCache,
} from '../src/shapes.ts';

function makeIdFactory(): () => string {
  let n = 0;
  return () => `s${n++}`;
}

describe('C11 freeze render-pause — rotation gate (shapes.ts updateShapeRender)', () => {
  let scene: THREE.Scene;
  beforeEach(() => {
    scene = new THREE.Scene();
    disposeGeometryCache();
  });

  function seedShape() {
    const store = new ShapeStore(scene, { maxShapes: 40, idFactory: makeIdFactory() });
    const shape = store.spawn({
      type: 'cube',
      rotSpeed: { x: 1, y: 2, z: 3 },
      bobPhase: 0.5,
    });
    // grounded so the bob path is exercised too.
    shape.grounded = true;
    return shape;
  }

  it('FROZEN: rotation is UNCHANGED across many simulated frames', () => {
    const shape = seedShape();
    const rot0 = {
      x: shape.group.rotation.x,
      y: shape.group.rotation.y,
      z: shape.group.rotation.z,
    };
    for (let f = 0; f < 30; f++) updateShapeRender(shape, 1 / 60, /* frozen */ true);
    expect(shape.group.rotation.x).toBe(rot0.x);
    expect(shape.group.rotation.y).toBe(rot0.y);
    expect(shape.group.rotation.z).toBe(rot0.z);
  });

  it('UNFROZEN: rotation advances by rotSpeed*delta (Phase B parity — no regression)', () => {
    const shape = seedShape();
    const delta = 1 / 60;
    updateShapeRender(shape, delta, /* frozen */ false);
    expect(shape.group.rotation.x).toBeCloseTo(shape.rotSpeed.x * delta, 10);
    expect(shape.group.rotation.y).toBeCloseTo(shape.rotSpeed.y * delta, 10);
    expect(shape.group.rotation.z).toBeCloseTo(shape.rotSpeed.z * delta, 10);
  });

  it('UNFROZEN default (no frozen arg) is byte-identical to the explicit false path', () => {
    const a = seedShape();
    const b = seedShape();
    const delta = 1 / 60;
    // Default-arg path (what today's callers use) vs explicit false.
    updateShapeRender(a, delta);
    updateShapeRender(b, delta, false);
    expect(a.group.rotation.x).toBe(b.group.rotation.x);
    expect(a.group.rotation.y).toBe(b.group.rotation.y);
    expect(a.group.rotation.z).toBe(b.group.rotation.z);
  });

  it('FROZEN: a grabbed shape (already rotation-skipped) is also untouched', () => {
    const shape = seedShape();
    shape.grabbedBy = 'peer-1';
    const y0 = shape.group.rotation.y;
    updateShapeRender(shape, 1 / 60, true);
    expect(shape.group.rotation.y).toBe(y0);
  });
});

describe('C11 freeze render-pause — bob gate (main.ts advanceShapeBob)', () => {
  let scene: THREE.Scene;
  beforeEach(() => {
    scene = new THREE.Scene();
    disposeGeometryCache();
  });

  function seedGrounded() {
    const store = new ShapeStore(scene, { maxShapes: 40, idFactory: makeIdFactory() });
    const shape = store.spawn({ type: 'sphere', bobPhase: 0.25 });
    shape.grounded = true;
    return shape;
  }

  it('FROZEN: bobPhase is UNCHANGED across simulated frames', () => {
    const shape = seedGrounded();
    const bob0 = shape.bobPhase;
    for (let f = 0; f < 30; f++) advanceShapeBob(shape, 1 / 60, /* frozen */ true);
    expect(shape.bobPhase).toBe(bob0);
  });

  it('UNFROZEN: bobPhase advances by delta*2 when grounded (Phase B parity)', () => {
    const shape = seedGrounded();
    const bob0 = shape.bobPhase;
    const delta = 1 / 60;
    advanceShapeBob(shape, delta, /* frozen */ false);
    expect(shape.bobPhase).toBeCloseTo(bob0 + delta * 2, 10);
  });

  it('UNFROZEN default (no frozen arg) advances bob exactly like explicit false', () => {
    const a = seedGrounded();
    const b = seedGrounded();
    const delta = 1 / 60;
    advanceShapeBob(a, delta);
    advanceShapeBob(b, delta, false);
    expect(a.bobPhase).toBe(b.bobPhase);
  });

  it('UNFROZEN but NOT grounded: bob does not advance (unchanged Phase B rule)', () => {
    const shape = seedGrounded();
    shape.grounded = false;
    const bob0 = shape.bobPhase;
    advanceShapeBob(shape, 1 / 60, false);
    expect(shape.bobPhase).toBe(bob0);
  });
});

describe('C11 freeze render-pause — both gates together over an ENV_STATE freeze', () => {
  let scene: THREE.Scene;
  beforeEach(() => {
    scene = new THREE.Scene();
    disposeGeometryCache();
  });

  it('a frozen ENV_STATE ⇒ rotation AND bobPhase unchanged over 60 frames; unfrozen ⇒ both advance', () => {
    const store = new ShapeStore(scene, { maxShapes: 40, idFactory: makeIdFactory() });
    const s = store.spawn({ type: 'icosahedron', rotSpeed: { x: 1, y: 1, z: 1 }, bobPhase: 0.1 });
    s.grounded = true;

    // Frozen: simulate the gameLoop's two calls per frame.
    const rY0 = s.group.rotation.y;
    const bob0 = s.bobPhase;
    for (let f = 0; f < 60; f++) {
      advanceShapeBob(s, 1 / 60, true);
      updateShapeRender(s, 1 / 60, true);
    }
    expect(s.group.rotation.y).toBe(rY0);
    expect(s.bobPhase).toBe(bob0);

    // Unfrozen: the very next frame advances both (parity — freeze did not corrupt state).
    advanceShapeBob(s, 1 / 60, false);
    updateShapeRender(s, 1 / 60, false);
    expect(s.group.rotation.y).toBeGreaterThan(rY0);
    expect(s.bobPhase).toBeGreaterThan(bob0);
  });
});
