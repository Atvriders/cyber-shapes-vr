/**
 * avatars.test.ts — Avatars (B8): head + 2 hands + nameplate + speaking ring.
 *
 * Uses a real THREE.Scene (constructs fine under node/vitest without WebGL).
 * The shared module-level geometry cache is reset between tests by calling
 * disposeAll() on any Avatars instance that adds avatars, which nulls the refs.
 *
 * Coverage:
 *   - upsert adds head + 2 hands + nameplate to scene; ring too (hidden)
 *   - upsert is idempotent (no duplicates on second call for same id)
 *   - updatePose positions head + hands; null hand hides the mesh
 *   - setSpeaking(id, true) makes ring visible; false reverts
 *   - remove detaches all meshes; second remove is a no-op
 *   - remove disposes per-avatar materials/texture/geo
 *   - disposeAll disposes shared geos
 *   - color is sourced from CYBER_COLORS[player.color]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Avatars } from '../src/net/avatars.ts';
import { CYBER_COLORS } from '@cyber-shapes/shared';
import type { PlayerInfo, Pose } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayer(overrides: Partial<PlayerInfo> = {}): PlayerInfo {
  return { id: 'p1', name: 'Alice', color: 2, ...overrides };
}

function makePose(
  opts: {
    hx?: number;
    hy?: number;
    hz?: number;
    h0null?: boolean;
    h1null?: boolean;
  } = {}
): Pose {
  const headP = { x: opts.hx ?? 0, y: opts.hy ?? 1.6, z: opts.hz ?? -1 };
  const headQ = { x: 0, y: 0, z: 0, w: 1 };
  const h0 = opts.h0null ? null : { p: { x: 0.3, y: 1, z: -1 }, q: { x: 0, y: 0, z: 0, w: 1 } };
  const h1 = opts.h1null ? null : { p: { x: -0.3, y: 1, z: -1 }, q: { x: 0, y: 0, z: 0, w: 1 } };
  return { head: { p: headP, q: headQ }, hands: [h0, h1] };
}

/** Count meshes in a scene that have name matching prefix. */
function countByPrefix(scene: THREE.Scene, prefix: string): number {
  let n = 0;
  scene.traverse((o) => {
    if (o.name.startsWith(prefix)) n++;
  });
  return n;
}

/** Find a mesh in a scene by name. */
function findByName(scene: THREE.Scene, name: string): THREE.Mesh | undefined {
  let found: THREE.Mesh | undefined;
  scene.traverse((o) => {
    if (o.name === name) found = o as THREE.Mesh;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Avatars (B8)', () => {
  let scene: THREE.Scene;
  let avatars: Avatars;

  beforeEach(() => {
    scene = new THREE.Scene();
    avatars = new Avatars(scene);
  });

  afterEach(() => {
    // Clean up shared geos to avoid cross-test pollution
    avatars.disposeAll();
  });

  // -------------------------------------------------------------------------
  describe('upsert', () => {
    it('adds a head mesh to the scene', () => {
      avatars.upsert(makePlayer());
      expect(countByPrefix(scene, 'avatar-head-p1')).toBe(1);
    });

    it('adds exactly 2 hand meshes to the scene', () => {
      avatars.upsert(makePlayer());
      expect(countByPrefix(scene, 'avatar-hand0-p1')).toBe(1);
      expect(countByPrefix(scene, 'avatar-hand1-p1')).toBe(1);
    });

    it('adds a nameplate mesh to the scene', () => {
      avatars.upsert(makePlayer());
      expect(countByPrefix(scene, 'avatar-nameplate-p1')).toBe(1);
    });

    it('adds a speaking ring to the scene (hidden)', () => {
      avatars.upsert(makePlayer());
      const ring = findByName(scene, 'avatar-ring-p1');
      expect(ring).toBeDefined();
      expect(ring!.visible).toBe(false);
    });

    it('is idempotent — second upsert for same id does NOT duplicate', () => {
      avatars.upsert(makePlayer());
      avatars.upsert(makePlayer({ name: 'Alice2' }));
      // Still exactly one of each per player
      expect(countByPrefix(scene, 'avatar-head-p1')).toBe(1);
      expect(countByPrefix(scene, 'avatar-hand0-p1')).toBe(1);
      expect(countByPrefix(scene, 'avatar-hand1-p1')).toBe(1);
      expect(countByPrefix(scene, 'avatar-nameplate-p1')).toBe(1);
    });

    it('uses CYBER_COLORS[player.color] for the head material emissive', () => {
      const colorIndex = 3;
      avatars.upsert(makePlayer({ color: colorIndex }));
      const head = findByName(scene, 'avatar-head-p1');
      expect(head).toBeDefined();
      const mat = head!.material as THREE.MeshStandardMaterial;
      const expected = new THREE.Color(CYBER_COLORS[colorIndex]);
      expect(mat.emissive.r).toBeCloseTo(expected.r, 3);
      expect(mat.emissive.g).toBeCloseTo(expected.g, 3);
      expect(mat.emissive.b).toBeCloseTo(expected.b, 3);
    });

    it('wraps color index via modulo (colorIndex beyond array length)', () => {
      const colorIndex = CYBER_COLORS.length + 1;
      avatars.upsert(makePlayer({ color: colorIndex }));
      const head = findByName(scene, 'avatar-head-p1');
      const mat = head!.material as THREE.MeshStandardMaterial;
      const expected = new THREE.Color(CYBER_COLORS[colorIndex % CYBER_COLORS.length]);
      expect(mat.emissive.r).toBeCloseTo(expected.r, 3);
    });
  });

  // -------------------------------------------------------------------------
  describe('updatePose', () => {
    it('sets head position from pose.head.p', () => {
      avatars.upsert(makePlayer());
      avatars.updatePose('p1', makePose({ hx: 1.5, hy: 1.7, hz: -2.0 }));
      const head = findByName(scene, 'avatar-head-p1')!;
      expect(head.position.x).toBeCloseTo(1.5);
      expect(head.position.y).toBeCloseTo(1.7);
      expect(head.position.z).toBeCloseTo(-2.0);
    });

    it('sets head quaternion from pose.head.q', () => {
      avatars.upsert(makePlayer());
      const pose = makePose();
      pose.head.q = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
      avatars.updatePose('p1', pose);
      const head = findByName(scene, 'avatar-head-p1')!;
      expect(head.quaternion.x).toBeCloseTo(0.1);
      expect(head.quaternion.y).toBeCloseTo(0.2);
      expect(head.quaternion.z).toBeCloseTo(0.3);
      expect(head.quaternion.w).toBeCloseTo(0.9);
    });

    it('positions and makes visible a non-null hand', () => {
      avatars.upsert(makePlayer());
      const pose = makePose();
      pose.hands[0] = { p: { x: 0.5, y: 1.2, z: -0.8 }, q: { x: 0, y: 0, z: 0, w: 1 } };
      avatars.updatePose('p1', pose);
      const hand0 = findByName(scene, 'avatar-hand0-p1')!;
      expect(hand0.visible).toBe(true);
      expect(hand0.position.x).toBeCloseTo(0.5);
      expect(hand0.position.y).toBeCloseTo(1.2);
    });

    it('hides a hand when its pose entry is null', () => {
      avatars.upsert(makePlayer());
      avatars.updatePose('p1', makePose({ h0null: true }));
      const hand0 = findByName(scene, 'avatar-hand0-p1')!;
      expect(hand0.visible).toBe(false);
    });

    it('is a no-op when the player has no avatar', () => {
      // Should not throw
      expect(() => avatars.updatePose('unknown', makePose())).not.toThrow();
    });

    // Audit #3: a pose with a NaN/Infinity component must never be written to a
    // THREE object (NaN transforms crash/garbage the render loop). updatePose
    // skips the bad update — no throw, and the mesh keeps its last good transform.
    it('updatePose with a NaN head component does NOT throw and does NOT write NaN (audit #3)', () => {
      avatars.upsert(makePlayer());
      // First apply a good pose so we have a known-good baseline.
      avatars.updatePose('p1', makePose({ hx: 1, hy: 2, hz: -3 }));
      const head = findByName(scene, 'avatar-head-p1')!;
      expect(head.position.x).toBeCloseTo(1);

      // Now a NaN head position — must be skipped.
      const badPose = makePose({ hx: 1, hy: 2, hz: -3 });
      badPose.head.p = { x: NaN, y: 2, z: -3 };
      expect(() => avatars.updatePose('p1', badPose)).not.toThrow();

      // Position is unchanged (last good) and definitely not NaN.
      expect(Number.isNaN(head.position.x)).toBe(false);
      expect(head.position.x).toBeCloseTo(1);
      expect(head.position.z).toBeCloseTo(-3);
    });

    it('updatePose with a NaN hand component skips that hand, keeps last good transform (audit #3)', () => {
      avatars.upsert(makePlayer());
      const good = makePose();
      good.hands[0] = { p: { x: 0.5, y: 1.2, z: -0.8 }, q: { x: 0, y: 0, z: 0, w: 1 } };
      avatars.updatePose('p1', good);
      const hand0 = findByName(scene, 'avatar-hand0-p1')!;
      expect(hand0.position.x).toBeCloseTo(0.5);

      const bad = makePose();
      bad.hands[0] = { p: { x: Infinity, y: 1.2, z: -0.8 }, q: { x: 0, y: 0, z: 0, w: 1 } };
      expect(() => avatars.updatePose('p1', bad)).not.toThrow();
      expect(Number.isFinite(hand0.position.x)).toBe(true);
      expect(hand0.position.x).toBeCloseTo(0.5); // last good, not Infinity
    });
  });

  // -------------------------------------------------------------------------
  describe('setSpeaking', () => {
    it('makes ring visible when speaking=true', () => {
      avatars.upsert(makePlayer());
      avatars.setSpeaking('p1', true);
      const ring = findByName(scene, 'avatar-ring-p1')!;
      expect(ring.visible).toBe(true);
    });

    it('sets ring material opacity > 0 when speaking=true', () => {
      avatars.upsert(makePlayer());
      avatars.setSpeaking('p1', true);
      const ring = findByName(scene, 'avatar-ring-p1')!;
      const mat = ring.material as THREE.MeshStandardMaterial;
      expect(mat.opacity).toBeGreaterThan(0);
    });

    it('hides ring when speaking=false', () => {
      avatars.upsert(makePlayer());
      avatars.setSpeaking('p1', true);
      avatars.setSpeaking('p1', false);
      const ring = findByName(scene, 'avatar-ring-p1')!;
      expect(ring.visible).toBe(false);
    });

    it('resets ring material opacity to 0 when speaking=false', () => {
      avatars.upsert(makePlayer());
      avatars.setSpeaking('p1', true);
      avatars.setSpeaking('p1', false);
      const ring = findByName(scene, 'avatar-ring-p1')!;
      const mat = ring.material as THREE.MeshStandardMaterial;
      expect(mat.opacity).toBe(0);
    });

    it('is a no-op when the player has no avatar', () => {
      expect(() => avatars.setSpeaking('unknown', true)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('remove', () => {
    it('removes head from the scene', () => {
      avatars.upsert(makePlayer());
      avatars.remove('p1');
      expect(countByPrefix(scene, 'avatar-head-p1')).toBe(0);
    });

    it('removes both hands from the scene', () => {
      avatars.upsert(makePlayer());
      avatars.remove('p1');
      expect(countByPrefix(scene, 'avatar-hand0-p1')).toBe(0);
      expect(countByPrefix(scene, 'avatar-hand1-p1')).toBe(0);
    });

    it('removes nameplate and ring from the scene', () => {
      avatars.upsert(makePlayer());
      avatars.remove('p1');
      expect(countByPrefix(scene, 'avatar-nameplate-p1')).toBe(0);
      expect(countByPrefix(scene, 'avatar-ring-p1')).toBe(0);
    });

    it('disposes per-avatar materials', () => {
      avatars.upsert(makePlayer());
      const head = findByName(scene, 'avatar-head-p1')!;
      const mat = head.material as THREE.MeshStandardMaterial;
      const disposeSpy = vi.spyOn(mat, 'dispose');
      avatars.remove('p1');
      expect(disposeSpy).toHaveBeenCalled();
    });

    it('disposes nameplate texture', () => {
      avatars.upsert(makePlayer());
      const nameplate = findByName(scene, 'avatar-nameplate-p1')!;
      const mat = nameplate.material as THREE.MeshBasicMaterial;
      const tex = mat.map!;
      const disposeSpy = vi.spyOn(tex, 'dispose');
      avatars.remove('p1');
      expect(disposeSpy).toHaveBeenCalled();
    });

    it('is a safe no-op when called a second time', () => {
      avatars.upsert(makePlayer());
      avatars.remove('p1');
      expect(() => avatars.remove('p1')).not.toThrow();
    });

    it('is a safe no-op for an unknown id', () => {
      expect(() => avatars.remove('nobody')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('disposeAll', () => {
    it('removes all avatars from the scene', () => {
      avatars.upsert(makePlayer({ id: 'p1' }));
      avatars.upsert(makePlayer({ id: 'p2', name: 'Bob' }));
      avatars.disposeAll();
      expect(countByPrefix(scene, 'avatar-')).toBe(0);
    });

    it('is callable on an empty Avatars instance without error', () => {
      const fresh = new Avatars(new THREE.Scene());
      expect(() => fresh.disposeAll()).not.toThrow();
    });

    it('disposes the shared head/hand/ring geometries on disposeAll', () => {
      // Ensure shared geos are allocated by upsert, then spy on them via the head mesh geometry.
      avatars.upsert(makePlayer({ id: 'p1' }));
      const head = findByName(scene, 'avatar-head-p1')!;
      const sharedHeadGeo = head.geometry as THREE.BufferGeometry;
      const disposeHeadSpy = vi.spyOn(sharedHeadGeo, 'dispose');

      // Grab the hand's shared geometry too
      const hand0 = findByName(scene, 'avatar-hand0-p1')!;
      const sharedHandGeo = hand0.geometry as THREE.BufferGeometry;
      const disposeHandSpy = vi.spyOn(sharedHandGeo, 'dispose');

      avatars.disposeAll();

      expect(disposeHeadSpy).toHaveBeenCalled();
      expect(disposeHandSpy).toHaveBeenCalled();
    });

    it('A normal remove() does NOT dispose the shared geometry (other avatars still usable)', () => {
      // Two avatars share the same head geometry singleton.
      avatars.upsert(makePlayer({ id: 'p1' }));
      avatars.upsert(makePlayer({ id: 'p2', name: 'Bob' }));

      const head1 = findByName(scene, 'avatar-head-p1')!;
      const head2 = findByName(scene, 'avatar-head-p2')!;

      // They share the SAME underlying geometry object (module-level singleton).
      expect(head1.geometry).toBe(head2.geometry);

      // Spy to confirm dispose is NOT called during a normal remove()
      const disposeGeoSpy = vi.spyOn(head1.geometry as THREE.BufferGeometry, 'dispose');

      // Remove only p1 — shared geo must survive for p2.
      avatars.remove('p1');

      expect(disposeGeoSpy).not.toHaveBeenCalled();

      // p2's head is still in scene and still refers to the (un-disposed) shared geo.
      expect(countByPrefix(scene, 'avatar-head-p2')).toBe(1);
      const head2After = findByName(scene, 'avatar-head-p2')!;
      expect(head2After.geometry).toBe(head1.geometry); // same object, not disposed
    });
  });

  // -------------------------------------------------------------------------
  describe('multiple players', () => {
    it('creates separate avatar sets for different player ids', () => {
      avatars.upsert(makePlayer({ id: 'p1', name: 'Alice' }));
      avatars.upsert(makePlayer({ id: 'p2', name: 'Bob' }));
      expect(countByPrefix(scene, 'avatar-head-p1')).toBe(1);
      expect(countByPrefix(scene, 'avatar-head-p2')).toBe(1);
    });

    it('remove for one player does not remove the other', () => {
      avatars.upsert(makePlayer({ id: 'p1', name: 'Alice' }));
      avatars.upsert(makePlayer({ id: 'p2', name: 'Bob' }));
      avatars.remove('p1');
      expect(countByPrefix(scene, 'avatar-head-p1')).toBe(0);
      expect(countByPrefix(scene, 'avatar-head-p2')).toBe(1);
    });
  });
});
