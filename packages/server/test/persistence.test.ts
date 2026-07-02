/**
 * persistence.test.ts — TDD tests for RoomPersistence.
 *
 * All I/O is injected (fake writeFile/readFile + fake clock) — no real disk,
 * no open handles, no timing flakiness.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoomPersistence } from '../src/persistence.js';
import { RoomManager } from '../src/roomManager.js';
import type { NetShape } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShape(id: string): NetShape {
  return {
    id,
    type: 'cube',
    colorIndex: 2,
    renderMode: 'both',
    scale: 1.5,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0.42,
    rotSpeed: { x: 0.1, y: 0.2, z: 0.3 },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

/** Build an in-memory fake fs that records calls. */
function makeFakeFs() {
  const store = new Map<string, string>();
  const writeCalls: Array<{ path: string; data: string }> = [];

  const writeFile = async (path: string, data: string): Promise<void> => {
    writeCalls.push({ path, data });
    store.set(path, data);
  };

  const readFile = async (path: string): Promise<string> => {
    const content = store.get(path);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };

  return { store, writeCalls, writeFile, readFile };
}

/** Fake monotonic clock that the tests control. */
function makeFakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. save → load round-trip
// ---------------------------------------------------------------------------

describe('RoomPersistence — save + load round-trip', () => {
  it('scheduleSave + flush → load returns exact shape set with stable ids', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const clock = makeFakeClock();

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      now: clock.now,
      debounceMs: 2000,
    });

    const shapes: NetShape[] = [makeShape('roomA:0'), makeShape('roomA:1')];

    persistence.scheduleSave('roomA', shapes);
    await persistence.flush('roomA');

    const loaded = await persistence.load('roomA');

    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    expect(loaded![0].id).toBe('roomA:0');
    expect(loaded![1].id).toBe('roomA:1');
    // Full shape equality
    expect(loaded![0]).toEqual(shapes[0]);
    expect(loaded![1]).toEqual(shapes[1]);
  });
});

// ---------------------------------------------------------------------------
// 2. load missing room → null
// ---------------------------------------------------------------------------

describe('RoomPersistence — load missing room', () => {
  it('returns null (not throw) for a room with no persisted file', async () => {
    const { writeFile, readFile } = makeFakeFs();

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
    });

    const result = await persistence.load('nonexistent-room');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. load malformed JSON → null
// ---------------------------------------------------------------------------

describe('RoomPersistence — load malformed JSON', () => {
  it('returns null (not throw) when the persisted file contains invalid JSON', async () => {
    const store = new Map<string, string>();
    store.set('/data/rooms/broken.json', '{ this is not json }');
    const readFile = async (path: string): Promise<string> => {
      const content = store.get(path);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    };

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile: async () => {},
      readFile,
    });

    const result = await persistence.load('broken');
    expect(result).toBeNull();
  });

  it('returns null when the JSON is valid but lacks a shapes array', async () => {
    const store = new Map<string, string>();
    store.set('/data/rooms/weird.json', JSON.stringify({ notShapes: 42 }));
    const readFile = async (path: string): Promise<string> => {
      const content = store.get(path);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    };

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile: async () => {},
      readFile,
    });

    const result = await persistence.load('weird');
    expect(result).toBeNull();
  });

  // AUDIT FINDING #9 — malformed shapes inside a valid shapes array are dropped,
  // not returned as {} that becomes an all-NaN, undespawnable ghost.
  it('drops a malformed shape from the shapes array on load (finding #9)', async () => {
    const good = makeShape('room:0'); // finite Vec3s, valid type
    const bad = {}; // would previously load as an all-NaN shape
    const store = new Map<string, string>();
    store.set('/data/rooms/mixed.json', JSON.stringify({ shapes: [good, bad] }));
    const readFile = async (path: string): Promise<string> => {
      const content = store.get(path);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    };

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile: async () => {},
      readFile,
    });

    const result = await persistence.load('mixed');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('room:0');
  });
});

// ---------------------------------------------------------------------------
// 4. debounce — N rapid saves coalesce into ONE write of LATEST snapshot
// ---------------------------------------------------------------------------

describe('RoomPersistence — debounce', () => {
  it('N rapid scheduleSave calls within debounceMs produce exactly ONE write of the LATEST snapshot', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const clock = makeFakeClock(0);

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      now: clock.now,
      debounceMs: 2000,
    });

    const shapesV1: NetShape[] = [makeShape('r:0')];
    const shapesV2: NetShape[] = [makeShape('r:0'), makeShape('r:1')];
    const shapesV3: NetShape[] = [makeShape('r:0'), makeShape('r:1'), makeShape('r:2')];

    // All three calls happen within the 2000ms window (clock doesn't advance)
    persistence.scheduleSave('r', shapesV1);
    persistence.scheduleSave('r', shapesV2);
    persistence.scheduleSave('r', shapesV3);

    // Flush forces the pending write
    await persistence.flush('r');

    // Exactly one write happened
    expect(writeCalls).toHaveLength(1);

    // The write contains the LATEST snapshot (v3)
    const written = JSON.parse(writeCalls[0].data);
    expect(written.shapes).toHaveLength(3);
    expect(written.shapes[2].id).toBe('r:2');
  });

  it('a second flush after the debounce window produces a second write', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const clock = makeFakeClock(0);

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      now: clock.now,
      debounceMs: 2000,
    });

    const shapesA: NetShape[] = [makeShape('r:0')];
    const shapesB: NetShape[] = [makeShape('r:0'), makeShape('r:1')];

    // First batch — flush
    persistence.scheduleSave('r', shapesA);
    await persistence.flush('r');
    expect(writeCalls).toHaveLength(1);

    // Advance time past debounce window
    clock.advance(3000);

    // Second batch — flush
    persistence.scheduleSave('r', shapesB);
    await persistence.flush('r');
    expect(writeCalls).toHaveLength(2);

    const written2 = JSON.parse(writeCalls[1].data);
    expect(written2.shapes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. flush() with no roomId flushes all pending rooms
// ---------------------------------------------------------------------------

describe('RoomPersistence — flush() flushes all rooms', () => {
  it('flush() with no argument writes all pending rooms', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
    });

    persistence.scheduleSave('roomX', [makeShape('roomX:0')]);
    persistence.scheduleSave('roomY', [makeShape('roomY:0')]);

    await persistence.flush();

    const paths = writeCalls.map((c) => c.path);
    expect(paths.some((p) => p.includes('roomX'))).toBe(true);
    expect(paths.some((p) => p.includes('roomY'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. RoomManager + RoomPersistence — restore on create
// ---------------------------------------------------------------------------

describe('RoomManager — restores persisted shapes on room create', () => {
  it('getOrCreate loads persisted shapes with STABLE ids (no id reassignment)', async () => {
    const { store, writeFile, readFile } = makeFakeFs();

    // Pre-seed the store as if a prior session saved room "alpha"
    const persistedShapes: NetShape[] = [makeShape('alpha:42'), makeShape('alpha:99')];
    store.set('/data/rooms/alpha.json', JSON.stringify({ shapes: persistedShapes }));

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
    });

    const manager = new RoomManager(persistence);

    // This call should be async since it loads from persistence
    const room = await manager.getOrCreate('alpha');

    const shapes = room.worldShapes;
    expect(shapes).toHaveLength(2);
    // Original ids preserved — no id reassignment
    expect(shapes[0].id).toBe('alpha:42');
    expect(shapes[1].id).toBe('alpha:99');
    // Position/transform preserved
    expect(shapes[0].position).toEqual({ x: 1, y: 2, z: 3 });
    expect(shapes[0].colorIndex).toBe(2);
    expect(shapes[0].scale).toBe(1.5);
  });

  it('getOrCreate with no persisted file creates an empty room (no throw)', async () => {
    const { writeFile, readFile } = makeFakeFs();

    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
    });

    const manager = new RoomManager(persistence);
    const room = await manager.getOrCreate('brand-new-room');

    expect(room.worldShapes).toHaveLength(0);
  });

  it('getOrCreate returns same room instance on second call (no double-restore)', async () => {
    const { store, writeFile, readFile } = makeFakeFs();

    const persistedShapes: NetShape[] = [makeShape('beta:0')];
    store.set('/data/rooms/beta.json', JSON.stringify({ shapes: persistedShapes }));

    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });
    const manager = new RoomManager(persistence);

    const r1 = await manager.getOrCreate('beta');
    const r2 = await manager.getOrCreate('beta');

    expect(r1).toBe(r2);
    // Only one restore — shapes not doubled
    expect(r1.worldShapes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 — id-counter seed after restore (RoomManager + idFactory)
// ---------------------------------------------------------------------------

describe('RoomManager — id counter is seeded past restored ids (finding 1)', () => {
  it('restore 3 shapes then spawn → the new shape gets a FRESH id (room:3), not a duplicate', async () => {
    const { store, writeFile, readFile } = makeFakeFs();

    // Restored ids room:0, room:1, room:2 — counter must resume at 3.
    const persisted: NetShape[] = [makeShape('room:0'), makeShape('room:1'), makeShape('room:2')];
    store.set('/data/rooms/room.json', JSON.stringify({ shapes: persisted }));

    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });
    const manager = new RoomManager(persistence);
    const room = await manager.getOrCreate('room');

    expect(room.worldShapes.map((s) => s.id)).toEqual(['room:0', 'room:1', 'room:2']);

    // Spawn via the intent path (uses the room's idFactory).
    const events = room.applyIntent('p0', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } },
    });
    const spawn = events.find((e) => e.t === 'spawn') as (typeof events)[number] & { t: 'spawn' };
    expect(spawn).toBeTruthy();

    // BEFORE the fix the counter was 0 → this would collide with 'room:0'.
    expect(spawn.shape.id).toBe('room:3');

    // No duplicate ids in the world.
    const ids = room.worldShapes.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('room:3');
  });

  it('non-matching restored ids do not break seeding (counter starts at 0)', async () => {
    const { store, writeFile, readFile } = makeFakeFs();

    // Ids that do NOT match `${roomId}:N` must be ignored for seeding.
    const persisted: NetShape[] = [
      makeShape('legacy-abc'),
      makeShape('room:oops'),
      makeShape('other:5'),
    ];
    store.set('/data/rooms/room.json', JSON.stringify({ shapes: persisted }));

    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });
    const manager = new RoomManager(persistence);
    const room = await manager.getOrCreate('room');

    const events = room.applyIntent('p0', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } },
    });
    const spawn = events.find((e) => e.t === 'spawn') as (typeof events)[number] & { t: 'spawn' };
    // No matching `room:N` id → seed stays at 0 → first spawn is room:0.
    expect(spawn.shape.id).toBe('room:0');
  });
});

// ---------------------------------------------------------------------------
// FINDING 2 — path traversal at the persistence boundary
// ---------------------------------------------------------------------------

describe('RoomPersistence — rejects path traversal (finding 2, security)', () => {
  it('load with a traversal roomId throws (never touches disk outside <dir>/rooms)', async () => {
    let readAttempted = false;
    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile: async () => {},
      readFile: async () => {
        readAttempted = true;
        return '{}';
      },
    });

    await expect(persistence.load('../../etc/passwd')).rejects.toThrow(/invalid roomId/);
    await expect(persistence.load('..%2f..')).rejects.toThrow(/invalid roomId/);
    expect(readAttempted).toBe(false);
  });

  it('scheduleSave with a traversal roomId throws (no write scheduled)', async () => {
    let wrote = false;
    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile: async () => {
        wrote = true;
      },
      readFile: async () => '{}',
    });

    expect(() => persistence.scheduleSave('../evil', [makeShape('x:0')])).toThrow(/invalid roomId/);
    await persistence.flush();
    expect(wrote).toBe(false);
  });

  it('accepts a normal roomId and writes under <dir>/rooms', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });
    persistence.scheduleSave('good-room_1', [makeShape('good-room_1:0')]);
    await persistence.flush();
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe('/data/rooms/good-room_1.json');
  });
});

// ---------------------------------------------------------------------------
// FINDING 4 — debounce timer FIRES without an explicit flush
// ---------------------------------------------------------------------------

describe('RoomPersistence — debounce timer (finding 4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advancing time by debounceMs triggers exactly ONE write of the LATEST snapshot (no flush)', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      debounceMs: 2000,
    });

    persistence.scheduleSave('r', [makeShape('r:0')]);
    persistence.scheduleSave('r', [makeShape('r:0'), makeShape('r:1')]);
    persistence.scheduleSave('r', [makeShape('r:0'), makeShape('r:1'), makeShape('r:2')]);

    // Nothing written yet — timer has not fired.
    expect(writeCalls).toHaveLength(0);

    // Fire the debounce timer and let the write microtask settle.
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeCalls).toHaveLength(1);
    const written = JSON.parse(writeCalls[0].data);
    expect(written.shapes).toHaveLength(3);
    expect(written.shapes[2].id).toBe('r:2');
  });

  it('rapid re-arm within the window coalesces to ONE write; timer only fires after quiet period', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      debounceMs: 1000,
    });

    persistence.scheduleSave('r', [makeShape('r:0')]);
    await vi.advanceTimersByTimeAsync(600); // still inside window
    persistence.scheduleSave('r', [makeShape('r:0'), makeShape('r:1')]); // re-arms
    await vi.advanceTimersByTimeAsync(600); // 1200ms total but only 600ms since re-arm
    expect(writeCalls).toHaveLength(0); // re-arm pushed the deadline out

    await vi.advanceTimersByTimeAsync(400); // now 1000ms since re-arm
    expect(writeCalls).toHaveLength(1);
    expect(JSON.parse(writeCalls[0].data).shapes).toHaveLength(2);
  });

  it('flush() BEFORE the window still writes exactly once and cancels the pending timer', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const persistence = new RoomPersistence({
      dir: '/data',
      writeFile,
      readFile,
      debounceMs: 2000,
    });

    persistence.scheduleSave('r', [makeShape('r:0')]);
    await persistence.flush('r');
    expect(writeCalls).toHaveLength(1);

    // Advancing past the window must NOT produce a second (timer-fired) write.
    await vi.advanceTimersByTimeAsync(5000);
    expect(writeCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FINDING 5 — write errors PROPAGATE (no silent data loss)
// ---------------------------------------------------------------------------

describe('RoomPersistence — write errors propagate (finding 5)', () => {
  it('a rejecting writeFile makes flush() REJECT (not resolve silently)', async () => {
    const writeFile = async (): Promise<void> => {
      throw new Error('disk full');
    };
    const readFile = async (): Promise<string> => '{}';
    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });

    persistence.scheduleSave('r', [makeShape('r:0')]);
    await expect(persistence.flush('r')).rejects.toThrow(/disk full/);
  });

  it('flush() with no arg aggregates and rejects if any room write fails', async () => {
    const writeFile = async (path: string): Promise<void> => {
      if (path.includes('bad')) throw new Error('write bad failed');
    };
    const readFile = async (): Promise<string> => '{}';
    const persistence = new RoomPersistence({ dir: '/data', writeFile, readFile });

    persistence.scheduleSave('good', [makeShape('good:0')]);
    persistence.scheduleSave('bad', [makeShape('bad:0')]);

    await expect(persistence.flush()).rejects.toThrow(/write bad failed/);
  });
});
