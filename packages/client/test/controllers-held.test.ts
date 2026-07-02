/**
 * controllers-held.test.ts — regression for audit #14 (getHeldShapeIds).
 *
 * VR can hold a shape in EACH hand (two controllers). getHeldShapeIds() must
 * return the FULL set of held ids so the connected loop treats every one as
 * 'local' (controller-driven) and streams each via sendHeld. Pre-fix only a
 * single first-held id was tracked (getHeldShapeId), so a shape grabbed by the
 * SECOND hand was classified 'remote' and frozen server-side.
 *
 * We mock XRControllerModelFactory (needs no WebGL) and drive updateControllers
 * with a fake XRFrame whose two input sources each report a grip press, so both
 * controllers grab a nearby shape. Then assert getHeldShapeIds() returns BOTH.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// Mock the controller-model factory: it's only cosmetics and would otherwise
// pull in WebGL/GLTF machinery. createControllerModel returns an empty group.
vi.mock('three/addons/webxr/XRControllerModelFactory.js', () => ({
  XRControllerModelFactory: class {
    createControllerModel() {
      return new THREE.Group();
    }
  },
}));

const { initControllers, updateControllers, getHeldShapeIds } = await import(
  '../src/controllers.ts'
);
const { ShapeStore } = await import('../src/world.ts');
const { LOCAL_PEER_ID } = await import('../src/net/netClient.ts');

// ---------------------------------------------------------------------------
// Minimal renderer stub: xr.getController(i) / getControllerGrip(i) return real
// THREE.Groups (positioned per-controller). domElement is undefined so the
// desktop listener path short-circuits.
// ---------------------------------------------------------------------------
function makeRendererStub() {
  const controllers = [new THREE.Group(), new THREE.Group()];
  const grips = [new THREE.Group(), new THREE.Group()];
  return {
    xr: {
      getController: (i: number) => controllers[i],
      getControllerGrip: (i: number) => grips[i],
    },
    domElement: undefined,
    _controllers: controllers,
  } as unknown as THREE.WebGLRenderer & { _controllers: THREE.Group[] };
}

/** A fake XRFrame with two input sources, each with a gamepad we can drive. */
function makeFrame(gripPressed: [boolean, boolean]): XRFrame {
  const src = (grip: boolean) => ({
    gamepad: {
      buttons: [
        { pressed: false }, // 0 trigger
        { pressed: grip }, // 1 grip
        { pressed: false }, // 2
        { pressed: false }, // 3 thumbstick-click (PTT)
        { pressed: false }, // 4 A
        { pressed: false }, // 5 B
      ],
      axes: [0, 0, 0, 0],
    },
  });
  return {
    session: { inputSources: [src(gripPressed[0]), src(gripPressed[1])] },
  } as unknown as XRFrame;
}

describe('getHeldShapeIds (audit #14)', () => {
  let scene: THREE.Scene;
  let store: InstanceType<typeof ShapeStore>;
  let renderer: ReturnType<typeof makeRendererStub>;
  let camera: THREE.PerspectiveCamera;

  const audioStub = {
    ctx: null,
    resume: () => Promise.resolve(),
    playSpawn: () => {},
    playGrab: () => {},
    playRelease: () => {},
    playImpact: () => {},
  };

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
    });
    renderer = makeRendererStub();
    camera = new THREE.PerspectiveCamera();
    initControllers(renderer, scene, store, camera, audioStub as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('returns an empty array when nothing is held', () => {
    expect(getHeldShapeIds()).toEqual([]);
  });

  it('returns ALL held ids — one shape per hand (two controllers)', () => {
    // Spawn a shape right at each controller's position so findNearestShape hits.
    const shapeL = store.spawn({ type: 'cube' });
    const shapeR = store.spawn({ type: 'sphere' });
    // Controller 0 at origin, controller 1 offset far away so each grabs its own.
    renderer._controllers[0].position.set(0, 0, 0);
    renderer._controllers[1].position.set(10, 0, 0);
    shapeL.group.position.set(0, 0, 0); // near controller 0
    shapeR.group.position.set(10, 0, 0); // near controller 1

    // Frame 1: both grips PRESSED (rising edge → grab).
    updateControllers(makeFrame([true, true]), 0.016, store, { audio: audioStub as never });

    const held = getHeldShapeIds();
    expect(held).toHaveLength(2);
    expect(new Set(held)).toEqual(new Set([shapeL.id, shapeR.id]));
  });

  it('drops a held id on grip release (falling edge)', () => {
    const shape = store.spawn({ type: 'cube' });
    renderer._controllers[0].position.set(0, 0, 0);
    renderer._controllers[1].position.set(100, 0, 0); // nothing near hand 1
    shape.group.position.set(0, 0, 0);

    // Press (grab) then release only hand 0.
    updateControllers(makeFrame([true, false]), 0.016, store, { audio: audioStub as never });
    expect(getHeldShapeIds()).toEqual([shape.id]);

    updateControllers(makeFrame([false, false]), 0.016, store, { audio: audioStub as never });
    expect(getHeldShapeIds()).toEqual([]);
  });
});
