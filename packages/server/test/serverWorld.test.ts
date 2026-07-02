import { describe, it, expect, beforeEach } from 'vitest';
import { ServerWorld } from '../src/serverWorld.js';

// Deterministic id factory for tests
function makeIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('ServerWorld — spawn', () => {
  it('assigns id from idFactory and returns a NetShape with defaults', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const { shape } = world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } })!;
    expect(shape.id).toBe('id-1');
    expect(shape.type).toBe('cube');
    expect(shape.colorIndex).toBe(0);
    expect(shape.renderMode).toBe('both');
    expect(shape.scale).toBe(1);
    expect(shape.grabbedBy).toBeNull();
    expect(shape.grounded).toBe(false);
    expect(shape.position).toEqual({ x: 0, y: 5, z: 0 });
    expect(shape.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(shape.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('respects provided colorIndex, renderMode, scale, bobPhase, rotSpeed', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const { shape } = world.spawn({
      type: 'sphere',
      position: { x: 1, y: 2, z: 3 },
      colorIndex: 3,
      renderMode: 'wireframe',
      scale: 2,
      bobPhase: 1.5,
      rotSpeed: { x: 0.1, y: 0.2, z: 0.3 },
    })!;
    expect(shape.colorIndex).toBe(3);
    expect(shape.renderMode).toBe('wireframe');
    expect(shape.scale).toBe(2);
    expect(shape.bobPhase).toBe(1.5);
    expect(shape.rotSpeed).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });

  it('caps at maxShapes by evicting oldest when full', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-3
    expect(world.shapes.length).toBe(3);

    // Adding a 4th should evict id-1
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-4
    expect(world.shapes.length).toBe(3);
    expect(world.get('id-1')).toBeUndefined();
    expect(world.get('id-4')).toBeDefined();
  });

  it('get() returns the shape if present, undefined if not', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } });
    expect(world.get('id-1')).toBeDefined();
    expect(world.get('nope')).toBeUndefined();
  });

  it('remove() removes the shape', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } });
    world.remove('id-1');
    expect(world.get('id-1')).toBeUndefined();
    expect(world.shapes.length).toBe(0);
  });
});

describe('ServerWorld — grab arbitration', () => {
  let world: ServerWorld;
  beforeEach(() => {
    world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } }); // id-1
  });

  it('first grab succeeds and sets grabbedBy', () => {
    const ok = world.grab('id-1', 'peer-A');
    expect(ok).toBe(true);
    expect(world.get('id-1')!.grabbedBy).toBe('peer-A');
    expect(world.get('id-1')!.grounded).toBe(false);
  });

  it('same peer re-grabbing is idempotent true', () => {
    world.grab('id-1', 'peer-A');
    const ok = world.grab('id-1', 'peer-A');
    expect(ok).toBe(true);
    expect(world.get('id-1')!.grabbedBy).toBe('peer-A');
  });

  it('different peer gets false and grabbedBy is unchanged (first-claim-wins)', () => {
    world.grab('id-1', 'peer-A');
    const ok = world.grab('id-1', 'peer-B');
    expect(ok).toBe(false);
    expect(world.get('id-1')!.grabbedBy).toBe('peer-A');
  });

  it('grab on unknown id returns false', () => {
    expect(world.grab('no-such', 'peer-A')).toBe(false);
  });
});

describe('ServerWorld — release', () => {
  let world: ServerWorld;
  beforeEach(() => {
    world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } }); // id-1
    world.grab('id-1', 'peer-A');
  });

  it('owner can release: grabbedBy becomes null, transform updated', () => {
    const ok = world.release(
      'id-1',
      'peer-A',
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
      { x: 0, y: 1, z: 0 }
    );
    expect(ok).toBe(true);
    const shape = world.get('id-1')!;
    expect(shape.grabbedBy).toBeNull();
    expect(shape.velocity).toEqual({ x: 1, y: 2, z: 3 });
    expect(shape.position).toEqual({ x: 4, y: 5, z: 6 });
    expect(shape.rotation).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('non-owner release returns false and does not mutate', () => {
    const before = { ...world.get('id-1')! };
    const ok = world.release(
      'id-1',
      'peer-B',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    expect(ok).toBe(false);
    expect(world.get('id-1')!.grabbedBy).toBe(before.grabbedBy);
    expect(world.get('id-1')!.position).toEqual(before.position);
  });

  it('release on unknown id returns false', () => {
    expect(
      world.release(
        'no-such',
        'peer-A',
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
      )
    ).toBe(false);
  });
});

describe('ServerWorld — setHeld', () => {
  let world: ServerWorld;
  beforeEach(() => {
    world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } }); // id-1
    world.grab('id-1', 'peer-A');
  });

  it('owner can update position+rotation', () => {
    const ok = world.setHeld('id-1', 'peer-A', { x: 1, y: 2, z: 3 }, { x: 0.1, y: 0.2, z: 0.3 });
    expect(ok).toBe(true);
    expect(world.get('id-1')!.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(world.get('id-1')!.rotation).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });

  it('non-owner setHeld returns false and does not mutate', () => {
    const posBefore = { ...world.get('id-1')!.position };
    const ok = world.setHeld('id-1', 'peer-B', { x: 9, y: 9, z: 9 }, { x: 0, y: 0, z: 0 });
    expect(ok).toBe(false);
    expect(world.get('id-1')!.position).toEqual(posBefore);
  });
});

describe('ServerWorld — setColor / setRenderMode / setScale', () => {
  it('setColor updates colorIndex', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } });
    world.setColor('id-1', 4);
    expect(world.get('id-1')!.colorIndex).toBe(4);
  });

  it('setRenderMode updates renderMode', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } });
    world.setRenderMode('id-1', 'solid');
    expect(world.get('id-1')!.renderMode).toBe('solid');
  });

  it('setScale clamps to [0.2, 3]', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } });
    world.setScale('id-1', 10); // over max
    expect(world.get('id-1')!.scale).toBe(3);
    world.setScale('id-1', 0.01); // under min
    expect(world.get('id-1')!.scale).toBe(0.2);
    world.setScale('id-1', 1.5);
    expect(world.get('id-1')!.scale).toBe(1.5);
  });
});

describe('ServerWorld — step', () => {
  it('integrates gravity: a raised free shape falls (position.y decreases)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 10, z: 0 } });
    const before = world.get('id-1')!.position.y;
    world.step(1 / 60);
    expect(world.get('id-1')!.position.y).toBeLessThan(before);
  });

  it('grabbed shape is NOT integrated by step (position unchanged)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 10, z: 0 } });
    world.grab('id-1', 'peer-A');
    const before = { ...world.get('id-1')!.position };
    world.step(1 / 60);
    expect(world.get('id-1')!.position).toEqual(before);
  });

  it('step returns removed ids for out-of-bounds shapes and removes them from shapes', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    // Place shape very far away — beyond REMOVE_DISTANCE (50)
    world.spawn({ type: 'cube', position: { x: 100, y: 0, z: 0 } });
    const result = world.step(1 / 60);
    expect(result.removed).toContain('id-1');
    expect(world.get('id-1')).toBeUndefined();
    expect(world.shapes.length).toBe(0);
  });

  it('step reports impacts for hard floor hits', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    // Drop from high, pre-set a large downward velocity
    world.spawn({ type: 'cube', position: { x: 0, y: 0.15, z: 0 } }); // at restY
    const shape = world.get('id-1')!;
    shape.velocity.y = -10; // big downward velocity
    const result = world.step(1 / 60);
    expect(result.impacts.length).toBeGreaterThan(0);
    expect(result.impacts[0].id).toBe('id-1');
    expect(result.impacts[0].speed).toBeGreaterThan(0.5);
  });

  it('step advances rotation by rotSpeed*dt for ungrabbed shapes', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({
      type: 'cube',
      position: { x: 0, y: 10, z: 0 },
      rotSpeed: { x: 1, y: 2, z: 3 },
    });
    const shape = world.get('id-1')!;
    // Manually set rotation to zero to verify advancement
    shape.rotation = { x: 0, y: 0, z: 0 };
    const dt = 1 / 60;
    world.step(dt);
    expect(world.get('id-1')!.rotation.x).toBeCloseTo(1 * dt);
    expect(world.get('id-1')!.rotation.y).toBeCloseTo(2 * dt);
    expect(world.get('id-1')!.rotation.z).toBeCloseTo(3 * dt);
  });

  it('step does NOT advance rotation for grabbed shapes', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    world.spawn({
      type: 'cube',
      position: { x: 0, y: 10, z: 0 },
      rotSpeed: { x: 1, y: 2, z: 3 },
    });
    const shape = world.get('id-1')!;
    shape.rotation = { x: 0, y: 0, z: 0 };
    world.grab('id-1', 'peer-A');
    world.step(1 / 60);
    // Grabbed: rotation should not be advanced by rotSpeed
    expect(world.get('id-1')!.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// FINDING 7 — restore() must deep-copy Vec3 fields (no aliasing with input)
// ---------------------------------------------------------------------------

describe('ServerWorld — restore() Vec3 aliasing (finding 7)', () => {
  function netShape(id: string) {
    return {
      id,
      type: 'cube' as const,
      colorIndex: 0,
      renderMode: 'both' as const,
      scale: 1,
      grabbedBy: null,
      grounded: false,
      bobPhase: 0,
      rotSpeed: { x: 1, y: 2, z: 3 },
      position: { x: 10, y: 20, z: 30 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
      velocity: { x: 4, y: 5, z: 6 },
    };
  }

  it('mutating the input array Vec3s after restore does NOT change the world', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const input = [netShape('room:0')];
    world.restore(input);

    // Mutate every nested Vec3 on the ORIGINAL input object.
    input[0].position.x = 999;
    input[0].rotation.y = 999;
    input[0].velocity.z = 999;
    input[0].rotSpeed.x = 999;

    const s = world.get('room:0')!;
    // Before the fix these were shared refs and would read 999.
    expect(s.position).toEqual({ x: 10, y: 20, z: 30 });
    expect(s.rotation).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
    expect(s.velocity).toEqual({ x: 4, y: 5, z: 6 });
    expect(s.rotSpeed).toEqual({ x: 1, y: 2, z: 3 });
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #8 — spawn reports the evicted id so peers can despawn it
// ---------------------------------------------------------------------------

describe('ServerWorld — spawn eviction reporting (finding #8)', () => {
  it('returns evictedId=null while under maxShapes', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    const r1 = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!;
    expect(r1.evictedId).toBeNull();
    const r2 = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!;
    expect(r2.evictedId).toBeNull();
  });

  it('returns the evicted (oldest) id when spawning past maxShapes', () => {
    const world = new ServerWorld({ maxShapes: 2, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-2
    // 3rd spawn evicts id-1 (oldest)
    const r3 = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!; // id-3
    expect(r3.evictedId).toBe('id-1');
    expect(world.get('id-1')).toBeUndefined();
    expect(world.get('id-3')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #2 (defensive) — spawn never lets a NaN into the world
// ---------------------------------------------------------------------------

describe('ServerWorld — defensive spawn/release/setHeld (finding #2)', () => {
  it('spawn with a NaN position is REJECTED (returns null, nothing enters the world)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const result = world.spawn({
      type: 'cube',
      position: { x: NaN, y: 1, z: 0 } as unknown as { x: number; y: number; z: number },
    });
    // Coherent with release()/setHeld(): reject rather than silently default.
    expect(result).toBeNull();
    expect(world.shapes).toHaveLength(0);
  });

  it('release with a NaN velocity is a no-op (returns false, shape unchanged)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const spawned = world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } })!;
    const { shape } = spawned;
    world.grab(shape.id, 'pA');
    const ok = world.release(
      shape.id,
      'pA',
      { x: NaN, y: 0, z: 0 } as unknown as { x: number; y: number; z: number },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    expect(ok).toBe(false);
    // Still grabbed; velocity untouched (no NaN).
    expect(world.get(shape.id)!.grabbedBy).toBe('pA');
    expect(Number.isFinite(world.get(shape.id)!.velocity.x)).toBe(true);
  });

  // audit-2 CRITICAL (defensive) — spawn REJECTS non-finite rotSpeed/bobPhase so
  // the internal path can't be poisoned even behind the connection-layer gate.
  it('spawn with an Infinity rotSpeed component is REJECTED (returns null, nothing spawned)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const result = world.spawn({
      type: 'cube',
      position: { x: 0, y: 5, z: 0 },
      rotSpeed: { x: Infinity, y: 0, z: 0 },
    });
    expect(result).toBeNull();
    expect(world.shapes).toHaveLength(0);
  });

  it('spawn with a non-finite bobPhase is REJECTED (returns null, nothing spawned)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const result = world.spawn({
      type: 'cube',
      position: { x: 0, y: 5, z: 0 },
      bobPhase: NaN,
    });
    expect(result).toBeNull();
    expect(world.shapes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// audit-2 IMPORTANT — forceRelease clears grabbedBy UNCONDITIONALLY
// (even when the held shape's in-memory transform is non-finite, where
// release()'s finite-Vec3 guard would otherwise leave it pinned forever).
// ---------------------------------------------------------------------------

describe('ServerWorld — forceRelease (departure cleanup)', () => {
  it('clears grabbedBy on a shape whose transform is non-finite (release() would not)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const { shape } = world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } })!;
    world.grab(shape.id, 'pA');
    // Corrupt the in-memory transform to a non-finite value.
    world.get(shape.id)!.position = { x: NaN, y: NaN, z: NaN };

    // release() would refuse (finite-Vec3 guard) and leave it grabbed:
    const releaseOk = world.release(
      shape.id,
      'pA',
      { x: 0, y: 0, z: 0 },
      world.get(shape.id)!.position,
      world.get(shape.id)!.rotation
    );
    expect(releaseOk).toBe(false);
    expect(world.get(shape.id)!.grabbedBy).toBe('pA'); // still pinned

    // forceRelease clears it regardless of the non-finite transform.
    const forced = world.forceRelease(shape.id, 'pA');
    expect(forced).toBe(true);
    expect(world.get(shape.id)!.grabbedBy).toBeNull();
  });

  it('forceRelease is a no-op when the shape is grabbed by a different peer', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const { shape } = world.spawn({ type: 'cube', position: { x: 0, y: 5, z: 0 } })!;
    world.grab(shape.id, 'pA');
    expect(world.forceRelease(shape.id, 'pB')).toBe(false);
    expect(world.get(shape.id)!.grabbedBy).toBe('pA');
  });
});

// ---------------------------------------------------------------------------
// audit-2 IMPORTANT — spawn eviction SKIPS a currently-grabbed shape
// ---------------------------------------------------------------------------

describe('ServerWorld — eviction skips grabbed shapes', () => {
  it('at maxShapes with the OLDEST shape grabbed, a new spawn evicts the oldest UNGRABBED shape', () => {
    const world = new ServerWorld({ maxShapes: 2, idFactory: makeIdFactory() });
    const a = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!.shape; // id-1 (oldest)
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-2
    // Grab the oldest — it must NOT be evicted.
    world.grab(a.id, 'pA');

    const result = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!; // id-3
    // Evicted the oldest UNGRABBED (id-2), NOT the grabbed oldest (id-1).
    expect(result.evictedId).toBe('id-2');
    expect(world.get(a.id)).toBeDefined(); // grabbed shape survives
    expect(world.get(a.id)!.grabbedBy).toBe('pA');
    expect(world.get('id-2')).toBeUndefined();
    expect(world.get('id-3')).toBeDefined();
  });

  it('falls back to evicting the oldest when ALL shapes are grabbed', () => {
    const world = new ServerWorld({ maxShapes: 2, idFactory: makeIdFactory() });
    const a = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!.shape; // id-1
    const b = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!.shape; // id-2
    world.grab(a.id, 'pA');
    world.grab(b.id, 'pB');
    const result = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!; // id-3
    // All grabbed → evict the oldest anyway (documented fallback).
    expect(result.evictedId).toBe('id-1');
    expect(world.get('id-1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #9 — malformed-shape validation lives SOLELY at the load
// boundary (RoomPersistence.load); restore() no longer re-filters (dedup).
// The drop-on-load guarantee is covered by persistence.test.ts.
// ---------------------------------------------------------------------------

describe('ServerWorld — restore restores its (already-validated) input verbatim (finding #9 dedup)', () => {
  it('restores every shape it is given (validation is the load boundary, not restore)', () => {
    const world = new ServerWorld({ maxShapes: 10, idFactory: makeIdFactory() });
    const good = {
      id: 'room:0',
      type: 'cube',
      colorIndex: 1,
      renderMode: 'both',
      scale: 1,
      grabbedBy: null,
      grounded: false,
      bobPhase: 0,
      rotSpeed: { x: 0, y: 0, z: 0 },
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    } as const;

    world.restore([good]);

    expect(world.shapes.map((s) => s.id)).toEqual(['room:0']);
    for (const s of world.shapes) {
      expect(Number.isFinite(s.position.x)).toBe(true);
      expect(Number.isFinite(s.position.y)).toBe(true);
      expect(Number.isFinite(s.position.z)).toBe(true);
    }
  });
});
