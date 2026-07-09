/**
 * titan.test.ts — Task C17 F7 Titan Protocol (spec §7.7).
 *
 * TDD RED-first (brief Step 1). Deterministic + fake-time throughout: the
 * TitanHost takes an injected TimerApi and drives a live ServerWorld through a
 * RoomHandle, exactly like the C16 SiegeHost.
 *
 * The load-bearing test is the TITAN-SCOPED OOB recall: a shape thrown past
 * WORLD_RADIUS is RECALLED (respawned inside) while a titan is active, but the
 * SAME trajectory WITHOUT a titan DESPAWNS at REMOVE_DISTANCE (baseline Phase B
 * semantics preserved). Plus: one-titan invariant, 30 s auto-revert on TIMEOUT
 * and on DISCONNECT, and the throw clamp.
 */

import { describe, it, expect } from 'vitest';
import {
  OPCODES,
  MAX_SHAPES,
  WORLD_RADIUS,
  REMOVE_DISTANCE,
  TITAN_DURATION_MS,
  TITAN_SCALE_DEFAULT,
  TITAN_SCALE_MAX,
  TITAN_SCALE_MS,
  TITAN_THROW_MAX,
  type TimerApi,
  type TimerHandle,
  type RoomHandle,
  type PeerInfo,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { TitanHost } from '../src/titan.js';

// ---------------------------------------------------------------------------
// Fake timers (canonical shape, copied from siege/electionHost harnesses).
// ---------------------------------------------------------------------------
interface FakeEntry {
  id: number;
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}
function makeFakeTimers(initialNow = 0): {
  api: TimerApi;
  advance(ms: number): void;
  now(): number;
} {
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
    setTimeout(cb, ms): TimerHandle {
      const e: FakeEntry = { id: _nextId++, fireAt: _now + Math.max(0, ms), cb, cancelled: false };
      _timers.push(e);
      return e.id;
    },
    clearTimeout(hndl): void {
      const e = _timers.find((x) => x.id === hndl);
      if (e) e.cancelled = true;
    },
    now(): number {
      return _now;
    },
  };
  return {
    api,
    advance(ms: number): void {
      _now += ms;
      fireReady();
    },
    now(): number {
      return _now;
    },
  };
}

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

interface Broadcast {
  opcode: number;
  payload: unknown;
  tiers?: readonly string[];
}

function peers(n: number): PeerInfo[] {
  const out: PeerInfo[] = [];
  for (let i = 0; i < n; i++) out.push({ id: `p${i}`, name: `VOLT-${i}`, color: 0 } as PeerInfo);
  return out;
}

/** Build a TitanHost over a live world + timeline host, capturing broadcasts. */
function makeTitan(
  over: { maxShapes?: number; participants?: PeerInfo[] } = {}
): {
  t: ReturnType<typeof makeFakeTimers>;
  world: ServerWorld;
  host: RoomTimelineHost;
  titan: TitanHost;
  handle: RoomHandle;
  broadcasts: Broadcast[];
  showpieceCount: number;
} {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? MAX_SHAPES,
    idFactory: makeIdFactory('w'),
  });
  const roster = over.participants ?? peers(2);
  const broadcasts: Broadcast[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    initialPhase: 'PLAY',
  });
  const ctx = { showpieceCount: 0 };
  const titan = new TitanHost({
    timer: t.api,
    world,
    handle: host.handle,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    metricsCount: (k: string) => {
      if (k === 'showpiece') ctx.showpieceCount++;
    },
  });
  return {
    t,
    world,
    host,
    titan,
    handle: host.handle,
    broadcasts,
    get showpieceCount() {
      return ctx.showpieceCount;
    },
  };
}

/** PLAYER_SCALE broadcasts only. */
function scales(broadcasts: Broadcast[]): Array<{ peerId: string; scale: number; durationMs: number }> {
  return broadcasts
    .filter((b) => b.opcode === OPCODES.PLAYER_SCALE)
    .map((b) => b.payload as { peerId: string; scale: number; durationMs: number });
}

// ===========================================================================
// Titanize — arm / scale broadcast / metric / one-titan invariant
// ===========================================================================
describe('TitanHost — titanize', () => {
  it('titanizes a peer: broadcasts PLAYER_SCALE 1→5 over 1.5 s + counts a showpiece', () => {
    const s = makeTitan();
    const ok = s.titan.titanize('p0');
    expect(ok).toBe(true);
    expect(s.titan.active).toBe(true);
    expect(s.titan.activeTitan).toBe('p0');
    expect(s.showpieceCount).toBe(1);
    const sc = scales(s.broadcasts);
    expect(sc.length).toBeGreaterThanOrEqual(1);
    const grow = sc[0];
    expect(grow.peerId).toBe('p0');
    expect(grow.scale).toBe(TITAN_SCALE_DEFAULT);
    expect(grow.durationMs).toBe(TITAN_SCALE_MS);
  });

  it('honors the bigger scale behind the second button (scale 10)', () => {
    const s = makeTitan();
    s.titan.titanize('p0', { scale: TITAN_SCALE_MAX });
    expect(scales(s.broadcasts)[0].scale).toBe(TITAN_SCALE_MAX);
  });

  it('ONE-TITAN INVARIANT: a second titanize while one is active REPLACES the first (reverts it)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.broadcasts.length = 0;
    s.titan.titanize('p1');
    // p0 must be reverted to scale 1, and p1 grown — only ONE titan at a time.
    expect(s.titan.activeTitan).toBe('p1');
    const sc = scales(s.broadcasts);
    const p0revert = sc.find((x) => x.peerId === 'p0');
    const p1grow = sc.find((x) => x.peerId === 'p1');
    expect(p0revert).toBeDefined();
    expect(p0revert!.scale).toBe(1);
    expect(p1grow).toBeDefined();
    expect(p1grow!.scale).toBe(TITAN_SCALE_DEFAULT);
  });

  it('re-titanizing the SAME peer while active is a no-op (idempotent, not a double-count)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    const before = s.showpieceCount;
    const ok = s.titan.titanize('p0');
    expect(ok).toBe(false);
    expect(s.showpieceCount).toBe(before);
  });
});

// ===========================================================================
// Auto-revert — on TIMEOUT (30 s) and on DISCONNECT
// ===========================================================================
describe('TitanHost — auto-revert', () => {
  it('auto-reverts after TITAN_DURATION_MS (30 s) and broadcasts scale→1', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.broadcasts.length = 0;
    // Just before the deadline: still a titan.
    s.t.advance(TITAN_DURATION_MS - 1);
    expect(s.titan.active).toBe(true);
    // At the deadline: reverted.
    s.t.advance(2);
    expect(s.titan.active).toBe(false);
    expect(s.titan.activeTitan).toBeNull();
    const revert = scales(s.broadcasts).find((x) => x.peerId === 'p0' && x.scale === 1);
    expect(revert).toBeDefined();
  });

  it('reverts ON DISCONNECT of the titan peer (before the 30 s timeout)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.broadcasts.length = 0;
    s.titan.onPeerDisconnect('p0');
    expect(s.titan.active).toBe(false);
    expect(s.titan.activeTitan).toBeNull();
    const revert = scales(s.broadcasts).find((x) => x.peerId === 'p0' && x.scale === 1);
    expect(revert).toBeDefined();
  });

  it('a disconnect of a NON-titan peer does NOT revert the active titan', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.titan.onPeerDisconnect('p1');
    expect(s.titan.active).toBe(true);
    expect(s.titan.activeTitan).toBe('p0');
  });

  it('the 30 s timeout does NOT fire after a manual revert (timer cleared)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.titan.revert();
    s.broadcasts.length = 0;
    s.t.advance(TITAN_DURATION_MS * 2);
    // No further PLAYER_SCALE (the timer was cleared on revert).
    expect(scales(s.broadcasts).length).toBe(0);
  });
});

// ===========================================================================
// Throw clamp — TITAN_THROW_MAX
// ===========================================================================
describe('TitanHost — throw clamp', () => {
  it('clamps a titan throw velocity to TITAN_THROW_MAX', () => {
    const s = makeTitan();
    const out = s.titan.clampThrow({ x: 500, y: 0, z: 0 });
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(TITAN_THROW_MAX, 6);
  });
});

// ===========================================================================
// THE LOAD-BEARING TEST: titan-active OOB recall vs baseline despawn.
// ===========================================================================
describe('TitanHost — OOB recall scoped to titan-active', () => {
  it('RECALLS a shape past WORLD_RADIUS while a titan is active (before the step honors removed)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    // A shape well past WORLD_RADIUS but short of REMOVE_DISTANCE.
    const spawn = s.world.spawn({ type: 'cube', position: { x: WORLD_RADIUS + 10, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    expect(Math.hypot(WORLD_RADIUS + 10, 3, 0)).toBeGreaterThan(WORLD_RADIUS);
    // The titan pre-step recall pass runs BEFORE the physics step.
    const recalled = s.titan.recallOutOfBounds();
    expect(recalled).toContain(id);
    // The shape STILL EXISTS (recalled, not despawned) and is now inside the world.
    const shape = s.world.get(id);
    expect(shape).toBeDefined();
    expect(Math.hypot(shape!.position.x, shape!.position.y, shape!.position.z)).toBeLessThan(
      WORLD_RADIUS
    );
  });

  it('DESPAWNS the SAME trajectory (past REMOVE_DISTANCE) with NO titan (baseline Phase B preserved)', () => {
    const s = makeTitan();
    // No titanize — baseline. Place a shape past REMOVE_DISTANCE with outward velocity.
    const spawn = s.world.spawn({ type: 'cube', position: { x: REMOVE_DISTANCE + 5, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    // The titan recall pass is a NO-OP when no titan is active (baseline untouched)…
    const recalled = s.titan.recallOutOfBounds();
    expect(recalled.length).toBe(0);
    expect(s.world.get(id)).toBeDefined(); // recall did not touch it
    // …so the ordinary physics step honors `removed` and DESPAWNS it (Phase B).
    const { removed } = s.world.step(1 / 30);
    expect(removed).toContain(id);
    expect(s.world.get(id)).toBeUndefined();
  });

  it('does NOT recall a shape inside WORLD_RADIUS even while a titan is active', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    const spawn = s.world.spawn({ type: 'cube', position: { x: 5, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    const recalled = s.titan.recallOutOfBounds();
    expect(recalled).not.toContain(id);
    // Unmoved.
    expect(s.world.get(id)!.position.x).toBe(5);
  });

  it('a GRABBED out-of-bounds shape is not recalled (the giant may be holding it past the edge)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    const spawn = s.world.spawn({ type: 'cube', position: { x: WORLD_RADIUS + 10, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    s.world.grab(id, 'p0');
    const recalled = s.titan.recallOutOfBounds();
    expect(recalled).not.toContain(id);
  });
});

// ===========================================================================
// Hand impulses — the titan sweep touches the live world.
// ===========================================================================
describe('TitanHost — hand impulses', () => {
  it('applies a radial impulse to a non-grabbed shape within the scaled hand reach', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    // The giant has finished growing (rig scale 5 → hand reach 6 m).
    s.t.advance(TITAN_SCALE_MS);
    const spawn = s.world.spawn({ type: 'cube', position: { x: 2, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    // A giant hand near the shape sweeping in +x.
    const touched = s.titan.applyHandImpulses('p0', [
      { pos: { x: 0, y: 3, z: 0 }, vel: { x: 5, y: 0, z: 0 } },
    ]);
    expect(touched).toContain(id);
    const v = s.world.get(id)!.velocity;
    // Got pushed (non-zero velocity) and stayed within the throw cap.
    expect(Math.hypot(v.x, v.y, v.z)).toBeGreaterThan(0);
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(TITAN_THROW_MAX + 1e-6);
  });

  it('does not impulse a shape a NON-titan peer claims to sweep (only the active titan)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    s.world.spawn({ type: 'cube', position: { x: 2, y: 3, z: 0 } });
    const touched = s.titan.applyHandImpulses('p1', [
      { pos: { x: 0, y: 3, z: 0 }, vel: { x: 5, y: 0, z: 0 } },
    ]);
    expect(touched.length).toBe(0);
  });

  it('does not impulse a GRABBED shape (spec §7.7 — non-grabbed shapes only)', () => {
    const s = makeTitan();
    s.titan.titanize('p0');
    const spawn = s.world.spawn({ type: 'cube', position: { x: 2, y: 3, z: 0 } });
    const id = spawn!.shape.id;
    s.world.grab(id, 'p1');
    const touched = s.titan.applyHandImpulses('p0', [
      { pos: { x: 0, y: 3, z: 0 }, vel: { x: 5, y: 0, z: 0 } },
    ]);
    expect(touched).not.toContain(id);
  });
});

// ===========================================================================
// Presence snapshot — playerScale for late-join / avatar tiers.
// ===========================================================================
describe('TitanHost — presence playerScale', () => {
  it('exposes the active titan peer + its target scale for the presence snapshot', () => {
    const s = makeTitan();
    expect(s.titan.snapshot()).toBeNull();
    s.titan.titanize('p0', { scale: TITAN_SCALE_MAX });
    const snap = s.titan.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.peerId).toBe('p0');
    expect(snap!.scale).toBe(TITAN_SCALE_MAX);
  });
});
