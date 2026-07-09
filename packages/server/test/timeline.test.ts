/**
 * Task C5 — server host tests: RoomTimelineHost (PHASE_STATE / pacing / RESET /
 * ATTRACT-exit) + the §6.4 pin/unpin eviction invariant in ServerWorld.
 *
 * All time is fake via an injected TimerApi (no raw setTimeout/Date).
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '@cyber-shapes/shared';
import {
  OPCODES,
  SHOWROOM_BASELINE,
  DEFAULT_PARAMS,
  type PeerInfo,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost, PHASE_STATE_HEARTBEAT_MS } from '../src/timeline.js';

// ---------------------------------------------------------------------------
// Fake timers (chronological; cb may enqueue more)
// ---------------------------------------------------------------------------

interface FakeEntry {
  id: number;
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}

function makeFakeTimers(initialNow = 0) {
  let _now = initialNow;
  let _nextId = 1;
  const _timers: FakeEntry[] = [];
  function fireReady(): void {
    let fired = true;
    while (fired) {
      fired = false;
      for (const t of _timers.slice().sort((a, b) => a.fireAt - b.fireAt)) {
        if (!t.cancelled && t.fireAt <= _now) {
          t.cancelled = true;
          t.cb();
          fired = true;
          break;
        }
      }
    }
  }
  const api: TimerApi = {
    setTimeout(cb: () => void, ms: number): TimerHandle {
      const id = _nextId++;
      _timers.push({ id, fireAt: _now + ms, cb, cancelled: false });
      return id as unknown as TimerHandle;
    },
    clearTimeout(h: TimerHandle): void {
      const id = h as unknown as number;
      const t = _timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    now: () => _now,
  };
  return {
    api,
    advance(ms: number) {
      _now += ms;
      fireReady();
    },
    now: () => _now,
  };
}

function makeIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// ===========================================================================
// §6.4 eviction invariant in ServerWorld (pin/unpin)
// ===========================================================================

describe('ServerWorld — §6.4 eviction invariant (pin/unpin)', () => {
  it('at MAX_SHAPES, spawning evicts the oldest UNGRABBED UNPINNED body + reports it for despawn', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1 (oldest)
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-3
    const res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-4
    expect(world.shapes.length).toBe(3);
    expect(res.evictedId).toBe('id-1'); // oldest evicted → caller broadcasts despawn
    expect(world.get('id-1')).toBeUndefined();
    expect(world.get('id-4')).toBeDefined();
  });

  it('a PINNED body survives an eviction wave while the oldest UNPINNED is evicted', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1 (oldest)
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-3
    world.pin('id-1'); // pin the OLDEST (e.g. the siege crystal)
    const res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-4
    // id-1 is pinned → survives; the next-oldest unpinned (id-2) is evicted.
    expect(res.evictedId).toBe('id-2');
    expect(world.get('id-1')).toBeDefined();
    expect(world.get('id-2')).toBeUndefined();
    expect(world.get('id-4')).toBeDefined();
  });

  it('a GRABBED body survives (Phase B behavior preserved for unpinned held shapes)', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1 (oldest, grabbed)
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-3
    world.grab('id-1', 'peerA'); // a defender is holding id-1
    const res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-4
    // id-1 is grabbed → skipped; the oldest ungrabbed unpinned (id-2) is evicted.
    expect(res.evictedId).toBe('id-2');
    expect(world.get('id-1')).toBeDefined();
    expect(world.get('id-2')).toBeUndefined();
  });

  it('both a grabbed AND a pinned body survive the same eviction wave', () => {
    const world = new ServerWorld({ maxShapes: 3, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1 grabbed
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2 pinned
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-3 (only evictable)
    world.grab('id-1', 'peerA');
    world.pin('id-2');
    const res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-4
    expect(res.evictedId).toBe('id-3');
    expect(world.get('id-1')).toBeDefined();
    expect(world.get('id-2')).toBeDefined();
    expect(world.get('id-3')).toBeUndefined();
  });

  it('unpin() re-exposes a body to eviction', () => {
    const world = new ServerWorld({ maxShapes: 2, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.pin('id-1');
    // While pinned, id-1 survives; id-2 evicted.
    let res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-3
    expect(res.evictedId).toBe('id-2');
    expect(world.get('id-1')).toBeDefined();
    // Now unpin id-1; it is the oldest again → next spawn evicts it.
    world.unpin('id-1');
    res = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!; // id-4
    expect(res.evictedId).toBe('id-1');
    expect(world.get('id-1')).toBeUndefined();
  });

  it('when EVERY shape is pinned, spawn evicts NOTHING (never despawns a pin)', () => {
    const world = new ServerWorld({ maxShapes: 2, idFactory: makeIdFactory() });
    world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } }); // id-1
    world.spawn({ type: 'sphere', position: { x: 0, y: 0, z: 0 } }); // id-2
    world.pin('id-1');
    world.pin('id-2');
    const res = world.spawn({ type: 'cone', position: { x: 0, y: 0, z: 0 } })!; // id-3
    expect(res.evictedId).toBeNull(); // no pin was sacrificed
    expect(world.get('id-1')).toBeDefined();
    expect(world.get('id-2')).toBeDefined();
    expect(world.shapes.length).toBe(3); // briefly over cap rather than kill a pin
  });

  it('remove() clears a shape pin; restore() clears all pins (transient, never persisted)', () => {
    const world = new ServerWorld({ maxShapes: 5, idFactory: makeIdFactory() });
    const s = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!.shape;
    world.pin(s.id);
    expect(world.isPinned(s.id)).toBe(true);
    world.remove(s.id);
    expect(world.isPinned(s.id)).toBe(false);
    // restore wipes pins.
    const s2 = world.spawn({ type: 'cube', position: { x: 0, y: 0, z: 0 } })!.shape;
    world.pin(s2.id);
    world.restore([{ ...s2 }]);
    expect(world.isPinned(s2.id)).toBe(false);
  });
});

// ===========================================================================
// RoomTimelineHost — broadcast harness helper
// ===========================================================================

function makeHost(
  over: {
    roster?: PeerInfo[];
    initialPhase?: Parameters<typeof RoomTimelineHost>[0]['initialPhase'];
    maxShapes?: number;
  } = {}
) {
  const t = makeFakeTimers();
  const world = new ServerWorld({ maxShapes: over.maxShapes ?? 40, idFactory: makeIdFactory('room') });
  const broadcasts: Array<{ opcode: number; payload: unknown; tiers?: readonly string[] }> = [];
  const metrics: string[] = [];
  const resets: Array<{ removedIds: readonly string[]; spawned: readonly { id: string }[] }> = [];
  const roster: PeerInfo[] = over.roster ?? [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    metricsCount: (k) => void metrics.push(k),
    onWorldReset: (removedIds, spawned) => void resets.push({ removedIds, spawned }),
    initialPhase: over.initialPhase,
  });
  return { t, world, host, broadcasts, metrics, roster, resets };
}

function phaseStates(broadcasts: Array<{ opcode: number; payload: unknown }>) {
  return broadcasts
    .filter((b) => b.opcode === OPCODES.PHASE_STATE)
    .map((b) => b.payload)
    .filter((p): p is { phase: string } => !!p && typeof p === 'object' && 'phase' in p);
}

// ===========================================================================
// PHASE_STATE broadcast
// ===========================================================================

describe('RoomTimelineHost — PHASE_STATE broadcast', () => {
  it('broadcasts an opening PHASE_STATE via OPCODES.PHASE_STATE', () => {
    const { broadcasts } = makeHost();
    const states = phaseStates(broadcasts);
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].phase).toBe('ATTRACT');
  });

  it('heartbeats PHASE_STATE at ~1 Hz', () => {
    const { t, broadcasts } = makeHost();
    const before = phaseStates(broadcasts).length;
    // Advance in 1 s steps so the self-re-arming heartbeat fires once per second
    // (a single big jump only fires the first re-armed timer — real-timer parity).
    t.advance(PHASE_STATE_HEARTBEAT_MS);
    t.advance(PHASE_STATE_HEARTBEAT_MS);
    t.advance(PHASE_STATE_HEARTBEAT_MS);
    const after = phaseStates(broadcasts).length;
    expect(after - before).toBe(3); // one per second
  });

  it('broadcasts a PHASE_STATE on every phase change', () => {
    const { t, host, broadcasts } = makeHost();
    host.onPeerJoined({ id: 'p0', name: 'VOLT-1', color: 0 }); // ATTRACT → LOBBY
    const states = phaseStates(broadcasts).map((s) => s.phase);
    expect(states).toContain('LOBBY');
    // advance to PLAY — a change broadcast appears.
    t.advance(45_000);
    expect(phaseStates(broadcasts).map((s) => s.phase)).toContain('PLAY');
  });
});

// ===========================================================================
// ATTRACT exit: human vs synthetic
// ===========================================================================

describe('RoomTimelineHost — ATTRACT exit (human vs synthetic, §7.17)', () => {
  it('a HUMAN resident join advances ATTRACT → LOBBY', () => {
    const { host } = makeHost();
    expect(host.timeline.phase).toBe('ATTRACT');
    host.onPeerJoined({ id: 'p0', name: 'VOLT-1', color: 0 });
    expect(host.timeline.phase).toBe('LOBBY');
  });

  it('a SYNTHETIC join does NOT advance the timeline', () => {
    const { host } = makeHost();
    host.onPeerJoined({ id: 'd0', name: 'DMN-1', color: 0, synthetic: true });
    expect(host.timeline.phase).toBe('ATTRACT');
  });

  it('humanResidents() on the handle excludes synthetic peers', () => {
    const roster: PeerInfo[] = [
      { id: 'p0', name: 'VOLT-1', color: 0 },
      { id: 'd0', name: 'DMN-1', color: 1, synthetic: true },
    ];
    const { host } = makeHost({ roster });
    expect(host.handle.roster().map((p) => p.id)).toEqual(['p0', 'd0']);
    expect(host.handle.humanResidents().map((p) => p.id)).toEqual(['p0']);
  });
});

// ===========================================================================
// RESET handler (spec §5.5 / §D4)
// ===========================================================================

describe('RoomTimelineHost — RESET handler', () => {
  it('RESET despawns the world, reverts params to DEFAULT_PARAMS, respawns the showroom baseline, counts a rotation', () => {
    const { host, world, metrics, resets } = makeHost({ maxShapes: 40 });
    // Dirty the world + params: spawn junk, pin one, set a base param + overlay.
    world.spawn({ type: 'torus', position: { x: 9, y: 9, z: 9 } });
    const pinned = world.spawn({ type: 'cube', position: { x: 1, y: 1, z: 1 } })!.shape;
    world.pin(pinned.id);
    host.handle.setBaseParams({ gravity: { x: 0, y: 2, z: 0 } }); // an elected law
    host.handle.setCueOverlay({ freeze: true }, 5_000); // a live dial overlay
    expect(host.baseParams.gravity?.y).toBe(2);
    expect(host.cueOverlay).not.toBeNull();

    host.forceReset();

    // World == showroom baseline exactly (junk + pinned junk gone).
    expect(world.shapes.length).toBe(SHOWROOM_BASELINE.length);
    expect(world.shapes.map((s) => s.type)).toEqual(SHOWROOM_BASELINE.map((s) => s.type));
    // No pins survive (remove() cleared them; restore semantics).
    expect(world.shapes.every((s) => !world.isPinned(s.id))).toBe(true);
    // Params reverted to DEFAULT_PARAMS (base AND overlay).
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
    expect(host.cueOverlay).toBeNull();
    // Rotation counted.
    expect(metrics).toContain('rotation');
    // onWorldReset handed the connection layer the removed ids + fresh baseline
    // shapes to broadcast as ordinary despawn/spawn ServerMsgs (accommodation #8).
    expect(resets.length).toBe(1);
    expect(resets[0].removedIds.length).toBe(2); // the junk + pinned junk
    expect(resets[0].spawned.length).toBe(SHOWROOM_BASELINE.length);
  });

  it('the timeline auto-runs RESET at the rotation boundary and restores the baseline', () => {
    const { t, host, world } = makeHost();
    host.onPeerJoined({ id: 'p0', name: 'VOLT-1', color: 0 }); // → LOBBY
    world.spawn({ type: 'torus', position: { x: 9, y: 9, z: 9 } }); // junk mid-rotation
    // Fast-forward through every timed phase into RESET.
    t.advance(45_000); // → PLAY
    t.advance(180_000); // → OVERLOAD
    t.advance(30_000); // → FINALE
    t.advance(90_000); // → STATS
    t.advance(30_000); // → RESET (RESET handler runs on entry)
    // The showroom baseline is now restored (junk gone) even before RESET expires.
    expect(world.shapes.map((s) => s.type)).toEqual(SHOWROOM_BASELINE.map((s) => s.type));
  });
});

// ===========================================================================
// Auto-cue playlist (pacing)
// ===========================================================================

describe('RoomTimelineHost — auto-cue playlist', () => {
  it('ATTRACT auto-fires a comfort-free cue on the pacing interval', () => {
    const { t, host } = makeHost();
    let runs = 0;
    host.registry.register({
      id: 'ambient',
      label: 'AMBIENT',
      tab: 'show',
      cooldownMs: 0,
      phases: ['ATTRACT'],
      comfortCost: 0,
      run: () => void runs++,
    });
    // ATTRACT interval is 20 s; advancing past it fires the ambient cue.
    t.advance(20_000);
    expect(runs).toBe(1);
    t.advance(20_000);
    expect(runs).toBe(2); // continuous ambient cueing
  });

  it('build-mode / showpiece HOLD suspends the auto-cue playlist', () => {
    const { t, host } = makeHost();
    let runs = 0;
    host.registry.register({
      id: 'ambient',
      label: 'AMBIENT',
      tab: 'show',
      cooldownMs: 0,
      phases: ['ATTRACT'],
      comfortCost: 0,
      run: () => void runs++,
    });
    host.timeline.acquireHold(); // build-mode active
    t.advance(60_000); // three intervals pass
    expect(runs).toBe(0); // suspended while held
    host.timeline.releaseHold();
    t.advance(20_000);
    expect(runs).toBe(1); // resumes
  });
});

// ===========================================================================
// dispose
// ===========================================================================

describe('RoomTimelineHost — dispose', () => {
  it('stops the heartbeat + pacing loops', () => {
    const { t, host, broadcasts } = makeHost();
    host.dispose();
    const before = broadcasts.length;
    t.advance(10_000);
    expect(broadcasts.length).toBe(before); // no more heartbeats
  });
});
