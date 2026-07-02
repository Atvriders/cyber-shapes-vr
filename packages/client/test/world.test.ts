/**
 * world.test.ts — ShapeStore lifecycle + event API (Task A5, the keystone refactor)
 *
 * THREE Group/Mesh/Geometry/Material construct fine under node (no WebGL needed).
 * We use a real THREE.Scene and a deterministic idFactory (counter → 's0','s1',...).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ShapeEvent } from '../src/world.ts';
import { ShapeStore } from '../src/world.ts';
import { disposeGeometryCache } from '../src/shapes.ts';

function makeIdFactory(): () => string {
  let n = 0;
  return () => `s${n++}`;
}

describe('ShapeStore', () => {
  let scene: THREE.Scene;
  let events: ShapeEvent[];

  beforeEach(() => {
    scene = new THREE.Scene();
    events = [];
  });

  function makeStore(maxShapes = 40) {
    return new ShapeStore(scene, {
      maxShapes,
      idFactory: makeIdFactory(),
      onEvent: (e) => events.push(e),
    });
  }

  it('spawn assigns id from idFactory, returns a ClientShape with group added to scene', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });

    expect(shape.id).toBe('s0');
    expect(shape.type).toBe('cube');
    expect(scene.children).toContain(shape.group);
    expect(store.shapes).toHaveLength(1);
    expect(store.get('s0')).toBe(shape);

    // spawn event emitted exactly once, carrying the shape
    const spawnEvents = events.filter((e) => e.kind === 'spawn');
    expect(spawnEvents).toHaveLength(1);
    expect(spawnEvents[0]).toMatchObject({ kind: 'spawn', shape });
  });

  it('seeds bobPhase and rotSpeed when not provided, applies defaults', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'sphere' });

    expect(shape.bobPhase).toBeGreaterThanOrEqual(0);
    expect(shape.bobPhase).toBeLessThanOrEqual(Math.PI * 2);
    expect(typeof shape.rotSpeed.x).toBe('number');
    expect(typeof shape.rotSpeed.y).toBe('number');
    expect(typeof shape.rotSpeed.z).toBe('number');
    expect(shape.colorIndex).toBe(0);
    expect(shape.renderMode).toBe('both');
    expect(shape.scale).toBe(1);
    expect(shape.grabbedBy).toBeNull();
    expect(shape.grounded).toBe(false);
  });

  it('respects provided init fields (does not overwrite bobPhase/rotSpeed/colorIndex)', () => {
    const store = makeStore();
    const shape = store.spawn({
      type: 'cone',
      colorIndex: 3,
      renderMode: 'wireframe',
      scale: 2,
      bobPhase: 1.23,
      rotSpeed: { x: 1, y: 2, z: 3 },
    });

    expect(shape.colorIndex).toBe(3);
    expect(shape.renderMode).toBe('wireframe');
    expect(shape.scale).toBe(2);
    expect(shape.bobPhase).toBe(1.23);
    expect(shape.rotSpeed).toEqual({ x: 1, y: 2, z: 3 });
    // scale applied to the group
    expect(shape.group.scale.x).toBe(2);
  });

  it('spawning past maxShapes removes the OLDEST and keeps length at max', () => {
    const store = makeStore(2);
    const a = store.spawn({ type: 'cube' }); // s0
    store.spawn({ type: 'sphere' }); // s1
    events.length = 0; // reset to isolate the third spawn

    const c = store.spawn({ type: 'cone' }); // s2 → should evict s0

    expect(store.shapes).toHaveLength(2);
    expect(store.get('s0')).toBeUndefined();
    expect(store.get('s1')).toBeDefined();
    expect(store.get('s2')).toBe(c);
    expect(scene.children).not.toContain(a.group);

    // eviction emits despawn for the removed id, THEN spawn for the new shape
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['despawn', 'spawn']);
    expect(events[0]).toEqual({ kind: 'despawn', id: 's0' });
    expect(events[1]).toMatchObject({ kind: 'spawn', shape: c });
  });

  // Audit #15: when SERVER-authoritative (connected), the store must NOT locally
  // evict the oldest shape on spawn — the server owns the shape set + despawns.
  // Local eviction could delete a shape the server still broadcasts, making it
  // vanish on this client only. Offline the evict-oldest behaviour is unchanged
  // (asserted by the test above).
  it('does NOT locally evict on spawn when server-authoritative (audit #15)', () => {
    const store = makeStore(2);
    const a = store.spawn({ type: 'cube' }); // s0
    store.spawn({ type: 'sphere' }); // s1 — at cap now
    store.setServerAuthoritative(true);
    events.length = 0;

    const c = store.spawn({ type: 'cone' }); // s2 — would evict s0 offline

    // No eviction: the oldest survives and length exceeds maxShapes transiently.
    expect(store.shapes).toHaveLength(3);
    expect(store.get('s0')).toBe(a); // NOT evicted
    expect(store.get('s2')).toBe(c);
    // Only a spawn was emitted — no despawn (the server drives despawns).
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['spawn']);
  });

  it('resumes local evict-oldest after server-authoritative is turned OFF (audit #15)', () => {
    const store = makeStore(2);
    store.spawn({ type: 'cube' }); // s0
    store.spawn({ type: 'sphere' }); // s1
    store.setServerAuthoritative(true);
    store.spawn({ type: 'cone' }); // s2 — no eviction (3 shapes)
    expect(store.shapes).toHaveLength(3);

    // Back offline: the next spawn evicts the oldest again.
    store.setServerAuthoritative(false);
    events.length = 0;
    store.spawn({ type: 'torus' }); // evicts s0
    expect(store.get('s0')).toBeUndefined();
    expect(store.shapes).toHaveLength(3); // cap re-enforced (evict then add)
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['despawn', 'spawn']);
  });

  it('remove emits exactly one despawn and the group leaves the scene', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'torus' });
    events.length = 0;

    store.remove(shape.id);

    expect(store.shapes).toHaveLength(0);
    expect(store.get(shape.id)).toBeUndefined();
    expect(scene.children).not.toContain(shape.group);

    const despawns = events.filter((e) => e.kind === 'despawn');
    expect(despawns).toHaveLength(1);
    expect(despawns[0]).toEqual({ kind: 'despawn', id: shape.id });
  });

  it('remove on an absent id is a no-op (no event)', () => {
    const store = makeStore();
    store.spawn({ type: 'cube' });
    events.length = 0;

    store.remove('does-not-exist');

    expect(store.shapes).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('setColor sets colorIndex (no auto-cycle) and emits color once', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    events.length = 0;

    store.setColor(shape.id, 4);

    expect(shape.colorIndex).toBe(4);
    const colorEvents = events.filter((e) => e.kind === 'color');
    expect(colorEvents).toHaveLength(1);
    expect(colorEvents[0]).toEqual({ kind: 'color', id: shape.id, colorIndex: 4 });
  });

  it('setRenderMode mutates renderMode, toggles mesh visibility, emits render once', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    events.length = 0;

    store.setRenderMode(shape.id, 'wireframe');

    expect(shape.renderMode).toBe('wireframe');
    expect(shape.solidMesh.visible).toBe(false);
    expect(shape.wireMesh.visible).toBe(true);

    const renderEvents = events.filter((e) => e.kind === 'render');
    expect(renderEvents).toHaveLength(1);
    expect(renderEvents[0]).toEqual({ kind: 'render', id: shape.id, mode: 'wireframe' });
  });

  it('setScale clamps (5 → 3) and emits scale once', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    events.length = 0;

    store.setScale(shape.id, 5);

    expect(shape.scale).toBe(3);
    expect(shape.group.scale.x).toBe(3);

    const scaleEvents = events.filter((e) => e.kind === 'scale');
    expect(scaleEvents).toHaveLength(1);
    expect(scaleEvents[0]).toEqual({ kind: 'scale', id: shape.id, scale: 3 });
  });

  it('setScale clamps low (0.05 → 0.2)', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    store.setScale(shape.id, 0.05);
    expect(shape.scale).toBe(0.2);
  });

  it('setGrab sets grabbedBy and emits grab once', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    events.length = 0;

    store.setGrab(shape.id, 'peerX');
    expect(shape.grabbedBy).toBe('peerX');

    store.setGrab(shape.id, null);
    expect(shape.grabbedBy).toBeNull();

    const grabEvents = events.filter((e) => e.kind === 'grab');
    expect(grabEvents).toHaveLength(2);
    expect(grabEvents[0]).toEqual({ kind: 'grab', id: shape.id, peerId: 'peerX' });
    expect(grabEvents[1]).toEqual({ kind: 'grab', id: shape.id, peerId: null });
  });

  it('setGrab(id, peerId) clears grounded so y-clamp does not fight dragging', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    // Simulate a shape that has settled on the floor
    shape.grounded = true;

    store.setGrab(shape.id, 'peerX');

    expect(shape.grounded).toBe(false);
  });

  it('setGrab(id, null) release does NOT force grounded — physics re-derives it', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'cube' });
    // Start grabbed and not grounded
    store.setGrab(shape.id, 'peerX');
    expect(shape.grounded).toBe(false);

    // Release: grounded must remain false (physics will update it on next frame)
    store.setGrab(shape.id, null);
    expect(shape.grounded).toBe(false);

    // Also works when grounded was already true before release (edge case:
    // a grabbed shape that somehow got grounded=true should NOT be forced
    // to any particular value on release — this just documents that the store
    // leaves whatever value was already there).
    const shape2 = store.spawn({ type: 'sphere' });
    store.setGrab(shape2.id, 'peerY');
    shape2.grounded = true; // hypothetical external set
    store.setGrab(shape2.id, null);
    expect(shape2.grounded).toBe(true); // store did NOT touch it
  });

  it('mutators on an absent id are no-ops (no events)', () => {
    const store = makeStore();
    store.spawn({ type: 'cube' });
    events.length = 0;

    store.setColor('nope', 2);
    store.setRenderMode('nope', 'solid');
    store.setScale('nope', 1.5);
    store.setGrab('nope', 'x');

    expect(events).toHaveLength(0);
  });

  it('lighting: only up to MAX_LIGHTS shapes get a PointLight, counting live lights not index', () => {
    // maxShapes large so no eviction; spawn more than the light cap.
    const store = makeStore(40);
    const spawned = [];
    for (let i = 0; i < 8; i++) {
      spawned.push(store.spawn({ type: 'cube' }));
    }

    const withLight = spawned.filter((s) => s.light !== undefined && s.light !== null);
    // MAX_LIGHTS is 6 in shared constants
    expect(withLight).toHaveLength(6);

    // The lit ones are the FIRST 6 spawned (lights attach while under cap)
    for (let i = 0; i < 6; i++) {
      expect(spawned[i].light).toBeTruthy();
    }
    for (let i = 6; i < 8; i++) {
      expect(spawned[i].light == null).toBe(true);
    }
  });

  it('lighting: removing a lit shape frees a slot so the next spawn gets a light', () => {
    const store = makeStore(40);
    const spawned = [];
    for (let i = 0; i < 6; i++) {
      spawned.push(store.spawn({ type: 'cube' }));
    }
    // 7th spawn: no light left
    const overCap = store.spawn({ type: 'cube' });
    expect(overCap.light == null).toBe(true);

    // free a slot by removing a lit shape
    store.remove(spawned[0].id);

    // next spawn should now receive a light (live-light count is back under cap)
    const afterFree = store.spawn({ type: 'cube' });
    expect(afterFree.light).toBeTruthy();
  });
});

describe('geometry cache — shared geometry + disposal safety', () => {
  let scene: THREE.Scene;
  let events: ShapeEvent[];

  beforeEach(() => {
    scene = new THREE.Scene();
    events = [];
    // Clear the shared geometry cache between tests so each test starts fresh
    disposeGeometryCache();
  });

  function makeStore(maxShapes = 40) {
    return new ShapeStore(scene, {
      maxShapes,
      idFactory: (() => {
        let n = 0;
        return () => `s${n++}`;
      })(),
      onEvent: (e) => events.push(e),
    });
  }

  it('two shapes of the same type share the same geometry object (identity)', () => {
    const store = makeStore();
    const a = store.spawn({ type: 'cube' });
    const b = store.spawn({ type: 'cube' });
    expect(a.solidMesh.geometry).toBe(b.solidMesh.geometry);
  });

  it('two shapes of different types do NOT share geometry', () => {
    const store = makeStore();
    const a = store.spawn({ type: 'cube' });
    const b = store.spawn({ type: 'sphere' });
    expect(a.solidMesh.geometry).not.toBe(b.solidMesh.geometry);
  });

  it('remove() does NOT dispose shared geometry (disposal-safety)', () => {
    const store = makeStore();
    const a = store.spawn({ type: 'cube' });
    store.spawn({ type: 'cube' });
    store.spawn({ type: 'cube' });

    const sharedGeo = a.solidMesh.geometry;
    const disposeSpy = vi.spyOn(sharedGeo, 'dispose');

    store.remove(a.id);

    expect(disposeSpy).not.toHaveBeenCalled();

    // Clean up spy
    disposeSpy.mockRestore();
  });

  it('remove() disposes per-instance solid + wire materials', () => {
    const store = makeStore();
    const shape = store.spawn({ type: 'torus' });
    const solidMat = shape.solidMesh.material as THREE.MeshStandardMaterial;
    const wireMat = shape.wireMesh.material as THREE.MeshBasicMaterial;
    const solidDispose = vi.spyOn(solidMat, 'dispose');
    const wireDispose = vi.spyOn(wireMat, 'dispose');

    store.remove(shape.id);

    expect(solidDispose).toHaveBeenCalledOnce();
    expect(wireDispose).toHaveBeenCalledOnce();

    solidDispose.mockRestore();
    wireDispose.mockRestore();
  });

  it('disposeGeometryCache() disposes all cached geometries', () => {
    const store = makeStore();
    const cube = store.spawn({ type: 'cube' });
    const sphere = store.spawn({ type: 'sphere' });

    const cubeGeo = cube.solidMesh.geometry;
    const sphereGeo = sphere.solidMesh.geometry;
    const cubeDispose = vi.spyOn(cubeGeo, 'dispose');
    const sphereDispose = vi.spyOn(sphereGeo, 'dispose');

    disposeGeometryCache();

    expect(cubeDispose).toHaveBeenCalledOnce();
    expect(sphereDispose).toHaveBeenCalledOnce();

    cubeDispose.mockRestore();
    sphereDispose.mockRestore();
  });

  // -------------------------------------------------------------------------
  // rekey — B6 tempId reconciliation
  // -------------------------------------------------------------------------
  describe('rekey', () => {
    it('changes the id, preserves object identity, updates the byId index, emits nothing', () => {
      const store = makeStore();
      const shape = store.spawn({ type: 'cube' }); // s0
      const before = events.length;

      const ok = store.rekey('s0', 'room:0');

      expect(ok).toBe(true);
      // Same object identity
      expect(shape.id).toBe('room:0');
      expect(store.get('room:0')).toBe(shape);
      // Old id no longer resolves
      expect(store.get('s0')).toBeUndefined();
      // Still exactly one shape
      expect(store.shapes).toHaveLength(1);
      expect(store.shapes[0]).toBe(shape);
      // No spawn/despawn (or any) event emitted for a rekey
      expect(events.length).toBe(before);
    });

    it('returns false when oldId is missing (no mutation, no event)', () => {
      const store = makeStore();
      store.spawn({ type: 'cube' }); // s0
      const before = events.length;

      expect(store.rekey('nope', 'room:0')).toBe(false);
      expect(store.get('nope')).toBeUndefined();
      expect(store.get('room:0')).toBeUndefined();
      expect(store.get('s0')).toBeDefined();
      expect(events.length).toBe(before);
    });

    it('returns false when newId already exists (no mutation, no event)', () => {
      const store = makeStore();
      const a = store.spawn({ type: 'cube' }); // s0
      const b = store.spawn({ type: 'sphere' }); // s1
      const before = events.length;

      expect(store.rekey('s0', 's1')).toBe(false);
      // Both untouched
      expect(store.get('s0')).toBe(a);
      expect(store.get('s1')).toBe(b);
      expect(events.length).toBe(before);
    });

    it('returns false when oldId === newId', () => {
      const store = makeStore();
      store.spawn({ type: 'cube' }); // s0
      expect(store.rekey('s0', 's0')).toBe(false);
    });
  });
});
