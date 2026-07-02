import { describe, it, expect, beforeEach } from 'vitest';
import { Room } from '../src/room.js';
import { RoomManager, MAX_ROOMS } from '../src/roomManager.js';
import type { PlayerInfo } from '@cyber-shapes/shared';
import { MAX_PLAYERS, MAX_SHAPES } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayerInfo(id: string, n: number): PlayerInfo {
  return { id, name: `Player ${n}`, color: n };
}

function makeRoom(roomId = 'roomA'): Room {
  let n = 0;
  const idFactory = () => `${roomId}:${n++}`;
  return new Room(roomId, idFactory);
}

// ---------------------------------------------------------------------------
// Room — capacity
// ---------------------------------------------------------------------------

describe('Room — player capacity', () => {
  it(`rejects the ${MAX_PLAYERS + 1}th player (addPlayer returns false at MAX_PLAYERS)`, () => {
    const room = makeRoom();
    // Fill to the limit
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const ok = room.addPlayer(makePlayerInfo(`p${i}`, i));
      expect(ok, `slot ${i} should accept`).toBe(true);
    }
    // 9th player rejected
    const rejected = room.addPlayer(makePlayerInfo(`p${MAX_PLAYERS}`, MAX_PLAYERS));
    expect(rejected).toBe(false);
    expect(room.playerCount).toBe(MAX_PLAYERS);
  });

  it('isEmpty is true before any players, false after adding one', () => {
    const room = makeRoom();
    expect(room.isEmpty).toBe(true);
    room.addPlayer(makePlayerInfo('p0', 0));
    expect(room.isEmpty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Room — applyIntent grab arbitration
// ---------------------------------------------------------------------------

describe('Room — applyIntent grab arbitration', () => {
  let room: Room;
  let shapeId: string;

  beforeEach(() => {
    room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));
    room.addPlayer(makePlayerInfo('pB', 1));

    // Spawn a shape so we have an id to grab
    const events = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    expect(events[0].t).toBe('spawn');
    if (events[0].t === 'spawn') {
      shapeId = events[0].shape.id;
    }
  });

  it('player A grab succeeds → returns [{t:"grab", id, peerId:"pA"}]', () => {
    const evts = room.applyIntent('pA', { t: 'grab', id: shapeId });
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ t: 'grab', id: shapeId, peerId: 'pA' });
  });

  it('player B grab same shape after A → returns [] (loser gets nothing)', () => {
    room.applyIntent('pA', { t: 'grab', id: shapeId });
    const evts = room.applyIntent('pB', { t: 'grab', id: shapeId });
    expect(evts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Room — removePlayer releases grabbed shapes
// ---------------------------------------------------------------------------

describe('Room — removePlayer releases grabbed shapes', () => {
  it('returns [{t:"grab", id, peerId:null}, {t:"player-leave", id}] when player had a grab', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));

    // Spawn and grab
    const spawnEvts = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const shapeId = spawnEvts[0].t === 'spawn' ? spawnEvts[0].shape.id : '';
    room.applyIntent('pA', { t: 'grab', id: shapeId });

    const evts = room.removePlayer('pA');

    const grabRelease = evts.find((e) => e.t === 'grab');
    expect(grabRelease).toMatchObject({ t: 'grab', id: shapeId, peerId: null });

    const leave = evts.find((e) => e.t === 'player-leave');
    expect(leave).toMatchObject({ t: 'player-leave', id: 'pA' });
  });

  it('returns only [{t:"player-leave"}] when player had no grabs', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));
    const evts = room.removePlayer('pA');
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ t: 'player-leave', id: 'pA' });
  });

  // audit-2 IMPORTANT — a departing player's held shape must become grabbable
  // by others even when its in-memory transform is non-finite (removePlayer
  // uses forceRelease, not release, so the finite-Vec3 guard can't leave the
  // shape permanently pinned to the departed player).
  it('clears grabbedBy even when the held shape transform is non-finite (grabbable again)', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));
    room.addPlayer(makePlayerInfo('pB', 1));

    const spawnEvts = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const shapeId = spawnEvts[0].t === 'spawn' ? spawnEvts[0].shape.id : '';
    room.applyIntent('pA', { t: 'grab', id: shapeId });

    // Corrupt the held shape's in-memory transform to non-finite.
    const held = room.worldShapes.find((s) => s.id === shapeId)!;
    held.position = { x: NaN, y: NaN, z: NaN };
    held.rotation = { x: Infinity, y: 0, z: 0 };

    const evts = room.removePlayer('pA');
    expect(evts.find((e) => e.t === 'grab')).toMatchObject({
      t: 'grab',
      id: shapeId,
      peerId: null,
    });

    // grabbedBy is now null → pB can grab it (not locked to the departed pA).
    expect(room.worldShapes.find((s) => s.id === shapeId)!.grabbedBy).toBeNull();
    const grabEvts = room.applyIntent('pB', { t: 'grab', id: shapeId });
    expect(grabEvts).toHaveLength(1);
    expect(grabEvts[0]).toMatchObject({ t: 'grab', id: shapeId, peerId: 'pB' });
  });
});

// ---------------------------------------------------------------------------
// Room — shape ids unique across rooms
// ---------------------------------------------------------------------------

describe('Room — shape ids are unique across rooms', () => {
  it('roomA and roomB use different prefixes (roomA:0 vs roomB:0)', () => {
    const roomA = makeRoom('roomA');
    const roomB = makeRoom('roomB');

    roomA.addPlayer(makePlayerInfo('pA', 0));
    roomB.addPlayer(makePlayerInfo('pA', 0));

    const evtsA = roomA.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const evtsB = roomB.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });

    const idA = evtsA[0].t === 'spawn' ? evtsA[0].shape.id : '';
    const idB = evtsB[0].t === 'spawn' ? evtsB[0].shape.id : '';

    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^roomA:/);
    expect(idB).toMatch(/^roomB:/);
  });
});

// ---------------------------------------------------------------------------
// Room — spawn tempId echo (B6 reconciliation)
// ---------------------------------------------------------------------------

describe('Room — applyIntent spawn echoes tempId', () => {
  it('echoes the client tempId and assigns a canonical shape.id', () => {
    const room = makeRoom('roomA');
    room.addPlayer(makePlayerInfo('pA', 0));

    const events = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
      tempId: 'x',
    });

    expect(events).toHaveLength(1);
    expect(events[0].t).toBe('spawn');
    if (events[0].t === 'spawn') {
      // tempId is echoed verbatim
      expect(events[0].tempId).toBe('x');
      // shape.id is the SERVER canonical id (not the tempId)
      expect(events[0].shape.id).not.toBe('x');
      expect(events[0].shape.id).toMatch(/^roomA:/);
    }
  });

  it('omits tempId when the client did not send one', () => {
    const room = makeRoom('roomA');
    room.addPlayer(makePlayerInfo('pA', 0));

    const events = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });

    expect(events[0].t).toBe('spawn');
    if (events[0].t === 'spawn') {
      expect(events[0].tempId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Room — tick emits state (moving) and despawn (out-of-bounds)
// ---------------------------------------------------------------------------

describe('Room — tick', () => {
  it('emits a state message containing a falling (moving) shape', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));

    // Spawn a shape high up so it is actively falling
    const spawnEvts = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 10, z: 0 } },
    });
    const shapeId = spawnEvts[0].t === 'spawn' ? spawnEvts[0].shape.id : '';

    const broadcasts = room.tick(1 / 60);
    const stateMsg = broadcasts.find((e) => e.t === 'state');
    expect(stateMsg).toBeDefined();
    if (stateMsg?.t === 'state') {
      expect(stateMsg.shapes.some((s) => s.id === shapeId)).toBe(true);
    }
  });

  it('emits a despawn for a shape that goes out-of-bounds', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));

    // Spawn way outside REMOVE_DISTANCE (50)
    const spawnEvts = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 100, y: 0, z: 0 } },
    });
    const shapeId = spawnEvts[0].t === 'spawn' ? spawnEvts[0].shape.id : '';

    const broadcasts = room.tick(1 / 60);
    const despawn = broadcasts.find((e) => e.t === 'despawn');
    expect(despawn).toBeDefined();
    if (despawn?.t === 'despawn') {
      expect(despawn.id).toBe(shapeId);
    }
  });

  it('tick increments seq monotonically', () => {
    const room = makeRoom();
    room.addPlayer(makePlayerInfo('pA', 0));

    room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 10, z: 0 } },
    });

    const b1 = room.tick(1 / 60);
    const b2 = room.tick(1 / 60);

    const s1 = b1.find((e) => e.t === 'state');
    const s2 = b2.find((e) => e.t === 'state');

    if (s1?.t === 'state' && s2?.t === 'state') {
      expect(s2.seq).toBeGreaterThan(s1.seq);
    }
  });
});

// ---------------------------------------------------------------------------
// RoomManager
// ---------------------------------------------------------------------------

describe('RoomManager', () => {
  it('join returns a playerId and the room', async () => {
    const mgr = new RoomManager();
    const result = await mgr.join('roomX', 'Alice', 1);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.playerId).toMatch(/^p\d+$/);
      expect(result.room).toBeDefined();
    }
  });

  it('getOrCreate returns the same room for same roomId', async () => {
    const mgr = new RoomManager();
    const r1 = await mgr.getOrCreate('roomY');
    const r2 = await mgr.getOrCreate('roomY');
    expect(r1).toBe(r2);
  });

  it('get returns undefined for unknown roomId', () => {
    const mgr = new RoomManager();
    expect(mgr.get('nope')).toBeUndefined();
  });

  it('join rejects the 9th player with {error:"room-full"}', async () => {
    const mgr = new RoomManager();
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const r = await mgr.join('fullRoom', `Player${i}`, i);
      expect('error' in r).toBe(false);
    }
    const overLimit = await mgr.join('fullRoom', 'Extra', 99);
    expect('error' in overLimit).toBe(true);
    if ('error' in overLimit) {
      expect(overLimit.error).toBe('room-full');
    }
  });

  it('leave delegates to room.removePlayer and drops an empty room', async () => {
    const mgr = new RoomManager();
    const joinResult = await mgr.join('tempRoom', 'Alice', 1);
    if ('error' in joinResult) throw new Error('unexpected error');
    const { playerId } = joinResult;

    const evts = mgr.leave('tempRoom', playerId);
    expect(evts.some((e) => e.t === 'player-leave')).toBe(true);

    // Room should be dropped since it's now empty
    expect(mgr.get('tempRoom')).toBeUndefined();
  });

  it('shape ids from two rooms via RoomManager are globally unique', async () => {
    const mgr = new RoomManager();
    await mgr.getOrCreate('mgr-roomA');
    await mgr.getOrCreate('mgr-roomB');

    const rA = mgr.get('mgr-roomA')!;
    const rB = mgr.get('mgr-roomB')!;

    rA.addPlayer(makePlayerInfo('pA', 0));
    rB.addPlayer(makePlayerInfo('pA', 0));

    const eA = rA.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const eB = rB.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });

    const idA = eA[0].t === 'spawn' ? eA[0].shape.id : '';
    const idB = eB[0].t === 'spawn' ? eB[0].shape.id : '';

    expect(idA).not.toBe(idB);
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #8 — spawning past MAX_SHAPES appends a despawn for the evicted id
// ---------------------------------------------------------------------------

describe('Room — applyIntent spawn evict-despawn (finding #8)', () => {
  it('emits a despawn for the evicted (oldest) shape when spawning past MAX_SHAPES', () => {
    const room = makeRoom('evictRoom');
    room.addPlayer(makePlayerInfo('pA', 0));

    // Fill the room to MAX_SHAPES; record the first (oldest) id.
    let firstId = '';
    for (let i = 0; i < MAX_SHAPES; i++) {
      const evts = room.applyIntent('pA', {
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
      });
      // Under the cap: exactly one spawn event, no despawn.
      expect(evts).toHaveLength(1);
      if (i === 0 && evts[0].t === 'spawn') firstId = evts[0].shape.id;
    }

    // One more spawn evicts the oldest → spawn + despawn(firstId).
    const overflow = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const despawns = overflow.filter((e) => e.t === 'despawn');
    expect(despawns).toHaveLength(1);
    if (despawns[0].t === 'despawn') expect(despawns[0].id).toBe(firstId);
    // The new spawn event is still present.
    expect(overflow.some((e) => e.t === 'spawn')).toBe(true);
  });

  // audit-2 IMPORTANT — eviction must SKIP a currently-grabbed shape so a peer's
  // held object never vanishes (which would turn its held/release into no-ops).
  it('when the OLDEST shape at MAX_SHAPES is grabbed, a new spawn evicts an UNGRABBED one (grabbed survives)', () => {
    const room = makeRoom('evictGrabRoom');
    room.addPlayer(makePlayerInfo('pA', 0));

    // Fill to MAX_SHAPES; capture the oldest and the second-oldest id.
    let oldestId = '';
    let secondId = '';
    for (let i = 0; i < MAX_SHAPES; i++) {
      const evts = room.applyIntent('pA', {
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
      });
      if (i === 0 && evts[0].t === 'spawn') oldestId = evts[0].shape.id;
      if (i === 1 && evts[0].t === 'spawn') secondId = evts[0].shape.id;
    }

    // Grab the OLDEST shape (the one eviction would normally take).
    room.applyIntent('pA', { t: 'grab', id: oldestId });

    // One more spawn: must evict the oldest UNGRABBED (secondId), not oldestId.
    const overflow = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const despawns = overflow.filter((e) => e.t === 'despawn');
    expect(despawns).toHaveLength(1);
    if (despawns[0].t === 'despawn') expect(despawns[0].id).toBe(secondId);

    // The grabbed shape survives and is still owned by pA.
    const survivor = room.worldShapes.find((s) => s.id === oldestId);
    expect(survivor).toBeDefined();
    expect(survivor!.grabbedBy).toBe('pA');
    // The evicted (ungrabbed) shape is gone.
    expect(room.worldShapes.find((s) => s.id === secondId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #18 — recolor/rendermode/scale on a nonexistent id is a no-op
// ---------------------------------------------------------------------------

describe('Room — recolor/rendermode/scale on nonexistent id (finding #18)', () => {
  let saveCalls: number;
  let room: Room;

  beforeEach(() => {
    saveCalls = 0;
    // Minimal persistence stub that only counts scheduleSave calls.
    const persistence = {
      scheduleSave: () => {
        saveCalls++;
      },
    } as unknown as import('../src/persistence.js').RoomPersistence;
    let n = 0;
    room = new Room('ghostRoom', () => `ghostRoom:${n++}`, persistence);
    room.addPlayer(makePlayerInfo('pA', 0));
  });

  it('recolor of a nonexistent id yields no broadcast and no persistence write', () => {
    const evts = room.applyIntent('pA', { t: 'recolor', id: 'does-not-exist', colorIndex: 2 });
    expect(evts).toEqual([]);
    expect(saveCalls).toBe(0);
  });

  it('rendermode of a nonexistent id yields no broadcast and no persistence write', () => {
    const evts = room.applyIntent('pA', { t: 'rendermode', id: 'does-not-exist', mode: 'solid' });
    expect(evts).toEqual([]);
    expect(saveCalls).toBe(0);
  });

  it('scale of a nonexistent id yields no broadcast and no persistence write', () => {
    const evts = room.applyIntent('pA', { t: 'scale', id: 'does-not-exist', scale: 2 });
    expect(evts).toEqual([]);
    expect(saveCalls).toBe(0);
  });

  it('recolor of an EXISTING id still broadcasts and persists (control)', () => {
    const spawn = room.applyIntent('pA', {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } },
    });
    const id = spawn[0].t === 'spawn' ? spawn[0].shape.id : '';
    saveCalls = 0;
    const evts = room.applyIntent('pA', { t: 'recolor', id, colorIndex: 3 });
    expect(evts).toHaveLength(1);
    expect(evts[0].t).toBe('recolor');
    expect(saveCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AUDIT FINDING #6 — RoomManager caps the number of live rooms
// ---------------------------------------------------------------------------

describe('RoomManager — MAX_ROOMS cap (finding #6)', () => {
  it('exposes a sane default MAX_ROOMS', () => {
    expect(MAX_ROOMS).toBeGreaterThan(0);
  });

  it('rejects creating a room past the cap with {error:"server-full"}', async () => {
    const mgr = new RoomManager(null, 2); // tiny cap for the test
    const r1 = await mgr.join('room-1', 'A', 0);
    const r2 = await mgr.join('room-2', 'B', 0);
    expect('error' in r1).toBe(false);
    expect('error' in r2).toBe(false);
    expect(mgr.roomCount).toBe(2);

    // A THIRD distinct room exceeds the cap.
    const r3 = await mgr.join('room-3', 'C', 0);
    expect('error' in r3).toBe(true);
    if ('error' in r3) expect(r3.error).toBe('server-full');
    expect(mgr.roomCount).toBe(2);
  });

  it('still admits a joiner to an EXISTING room when at the cap', async () => {
    const mgr = new RoomManager(null, 1);
    await mgr.join('only-room', 'A', 0);
    // Second joiner to the SAME room is fine even though we are at the cap.
    const r = await mgr.join('only-room', 'B', 0);
    expect('error' in r).toBe(false);
  });
});
