/**
 * powersLab.test.ts — Task C32 F21 Powers Lab (spec §7.21).
 *
 * TDD RED-first (brief Step 1). Deterministic + fake-time throughout: the
 * PowersLabHost takes an injected TimerApi and drives a live ServerWorld, exactly
 * like the C17 TitanHost harness. Every server SAFETY RAIL is exercised here:
 * cone-select excludes grabbed+pinned, the 300 ms sustained hold, the ~250 ms
 * dead-man switch, the pin/unpin lifecycle, ≤ 2 pulls, the one-TK-player invariant
 * + revert-on-disconnect, the contested-TK-vs-human → HUMAN resolution, the
 * grab-radius conversion, and the per-pull speed cap.
 */

import { describe, it, expect } from 'vitest';
import {
  OPCODES,
  MAX_SHAPES,
  TK_DEADMAN_MS,
  TK_SELECT_HOLD_MS,
  TK_EXHIBIT_MS,
  TK_PULL_SPEED_MAX,
  TK_GRAB_RADIUS,
  TITAN_THROW_MAX,
  type TimerApi,
  type TimerHandle,
  type PeerInfo,
  type Vec3,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { PowersLabHost } from '../src/powersLab.js';
import { TitanHost } from '../src/titan.js';

// --- fake timers (canonical harness shape) ---------------------------------
interface FakeEntry {
  id: number;
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}
function makeFakeTimers(initialNow = 0): { api: TimerApi; advance(ms: number): void; now(): number } {
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
    now: () => _now,
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

function makeLab(): {
  t: ReturnType<typeof makeFakeTimers>;
  world: ServerWorld;
  lab: PowersLabHost;
  broadcasts: Broadcast[];
} {
  const t = makeFakeTimers();
  const world = new ServerWorld({ maxShapes: MAX_SHAPES, idFactory: makeIdFactory('w') });
  const broadcasts: Broadcast[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => peers(2),
    initialPhase: 'PLAY',
  });
  const lab = new PowersLabHost({
    timer: t.api,
    world,
    handle: host.handle,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    telekinesisOpcode: OPCODES.TELEKINESIS,
  });
  return { t, world, lab, broadcasts };
}

/** Spawn a shape at an exact position; return its id. */
function spawnAt(world: ServerWorld, pos: Vec3): string {
  const r = world.spawn({ type: 'cube', position: pos });
  if (!r) throw new Error('spawn failed');
  return r.shape.id;
}

/**
 * Commit a pull on `hand` at `anchor` pointing at the shape at `targetPos` — feeds
 * the sustained hold across the 300 ms window. Returns the committed shape id.
 */
function commitPull(
  lab: PowersLabHost,
  now0: number,
  hand: number,
  anchor: Vec3,
  targetPos: Vec3
): string | null {
  const dir: Vec3 = { x: targetPos.x - anchor.x, y: targetPos.y - anchor.y, z: targetPos.z - anchor.z };
  lab.feedPull('p0', hand, anchor, dir, now0);
  return lab.feedPull('p0', hand, anchor, dir, now0 + TK_SELECT_HOLD_MS);
}

const mag = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

// ===========================================================================
// Exhibit arm gate + one-TK-player + ≤2 pulls
// ===========================================================================

describe('PowersLabHost — exhibit arm gate', () => {
  it('IGNORES a TK_PULL while unarmed (the cue has not fired)', () => {
    const { world, lab } = makeLab();
    spawnAt(world, { x: 0, y: 1, z: -5 });
    const committed = commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(committed).toBeNull();
    expect(lab.activePulls).toBe(0);
    expect(lab.tkPlayer).toBeNull();
  });

  it('re-firing the cue WHILE armed toggles the exhibit OFF (releasing pulls)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(world.isPinned(id)).toBe(true);
    lab.arm(); // re-fire = toggle OFF
    expect(lab.armed).toBe(false);
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });

  it('auto-reverts the exhibit after ~10 min', () => {
    const { lab, t } = makeLab();
    lab.arm();
    expect(lab.armed).toBe(true);
    t.advance(TK_EXHIBIT_MS + 1);
    expect(lab.armed).toBe(false);
  });
});

describe('PowersLabHost — one-TK-player + ≤ 2 pulls', () => {
  it('commits a pull after the 300 ms sustained hold + pins the shape', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    const committed = commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(committed).toBe(id);
    expect(lab.activePulls).toBe(1);
    expect(world.isPinned(id)).toBe(true);
    expect(lab.tkPlayer).toBe('p0');
  });

  it('does NOT commit before the hold window elapses', () => {
    const { world, lab } = makeLab();
    spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    const dir = { x: 0, y: 0, z: -1 };
    lab.feedPull('p0', 0, { x: 0, y: 1, z: 0 }, dir, 1000);
    const c = lab.feedPull('p0', 0, { x: 0, y: 1, z: 0 }, dir, 1000 + TK_SELECT_HOLD_MS - 1);
    expect(c).toBeNull();
    expect(lab.activePulls).toBe(0);
  });

  it('allows two pulls (one per hand) but REJECTS a third hand index', () => {
    const { world, lab } = makeLab();
    const left = spawnAt(world, { x: -2, y: 1, z: -5 });
    const right = spawnAt(world, { x: 2, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: -1, y: 1, z: 0 }, { x: -2, y: 1, z: -5 });
    commitPull(lab, 1000, 1, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: -5 });
    expect(lab.activePulls).toBe(2);
    expect(world.isPinned(left)).toBe(true);
    expect(world.isPinned(right)).toBe(true);
    // hand index 2 is rejected (≤ 2 pulls, one per hand).
    const third = lab.feedPull('p0', 2, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 1000);
    expect(third).toBeNull();
    expect(lab.activePulls).toBe(2);
  });

  it('REJECTS a second player while one player is actively pulling (one-TK-player)', () => {
    const { world, lab } = makeLab();
    spawnAt(world, { x: 0, y: 1, z: -5 });
    const other = spawnAt(world, { x: 5, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    const dir = { x: 5, y: 0, z: -5 };
    const p1a = lab.feedPull('p1', 0, { x: 0, y: 1, z: 0 }, dir, 1000);
    const p1b = lab.feedPull('p1', 0, { x: 0, y: 1, z: 0 }, dir, 1000 + TK_SELECT_HOLD_MS);
    expect(p1a).toBeNull();
    expect(p1b).toBeNull();
    expect(world.isPinned(other)).toBe(false);
    expect(lab.tkPlayer).toBe('p0');
  });
});

// ===========================================================================
// Cone-select EXCLUDES grabbed + pinned
// ===========================================================================

describe('PowersLabHost — cone-select excludes grabbed + pinned', () => {
  it('TK targeting a HUMAN-GRABBED shape is a no-op (never commits)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    world.grab(id, 'human9'); // a human holds it
    lab.arm();
    const committed = commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(committed).toBeNull();
    expect(lab.activePulls).toBe(0);
  });

  it('TK targeting a PINNED shape is a no-op (never commits)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    world.pin(id); // e.g. the encore orb / the other hand's pull
    lab.arm();
    const committed = commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(committed).toBeNull();
    expect(lab.activePulls).toBe(0);
  });

  it("the second hand cannot re-target the first hand's (now pinned) pulled shape", () => {
    const { world, lab } = makeLab();
    const only = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(world.isPinned(only)).toBe(true);
    // hand 1 aims at the SAME shape — excluded (pinned) → no second commit on it.
    const c = commitPull(lab, 1000, 1, { x: 0, y: 1, z: 0.01 }, { x: 0, y: 1, z: -5 });
    expect(c).toBeNull();
    expect(lab.activePulls).toBe(1);
  });
});

// ===========================================================================
// The loop force (titan pattern — velocity nudge, NOT a PhysicsParams change)
// ===========================================================================

describe('PowersLabHost — loop-force pull', () => {
  it('nudges the pulled shape VELOCITY toward the anchor each tick', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    const before = { ...world.get(id)!.velocity };
    lab.tick(1 / 30, 1000 + 10);
    const after = world.get(id)!.velocity;
    // anchor is at z=0, shape at z=-5 → pull is +z; velocity gains +z.
    expect(after.z).toBeGreaterThan(before.z);
    expect(mag(after)).toBeLessThanOrEqual(TK_PULL_SPEED_MAX + 1e-6);
  });

  it('broadcasts a TETHER (anchor + target id — NO joint stream) for the stage beat', () => {
    const { world, lab, broadcasts } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    lab.tick(1 / 30, 1000 + 10);
    const tether = broadcasts
      .filter((b) => b.opcode === OPCODES.TELEKINESIS)
      .map((b) => b.payload as { kind: string; pulls: Array<{ hand: number; anchor: Vec3; targetId: string }> })
      .pop();
    expect(tether).toBeTruthy();
    expect(tether!.kind).toBe('tether');
    expect(tether!.pulls[0].targetId).toBe(id);
    expect(tether!.pulls[0].anchor).toEqual({ x: 0, y: 1, z: 0 });
    // The payload carries an anchor + id ONLY — never a joint array.
    expect(JSON.stringify(tether)).not.toContain('joint');
  });
});

// ===========================================================================
// Dead-man switch (~250 ms)
// ===========================================================================

describe('PowersLabHost — dead-man switch', () => {
  it('releases (unpins) a pull that gets no fresh TK_PULL within ~250 ms', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    const lastPull = 1000 + TK_SELECT_HOLD_MS;
    expect(world.isPinned(id)).toBe(true);
    // A tick still inside the window keeps it alive.
    lab.tick(1 / 30, lastPull + TK_DEADMAN_MS);
    expect(world.isPinned(id)).toBe(true);
    // A tick PAST the window expires it (dead-man release → unpin).
    lab.tick(1 / 30, lastPull + TK_DEADMAN_MS + 1);
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });
});

// ===========================================================================
// Grab-radius conversion + contested → HUMAN
// ===========================================================================

describe('PowersLabHost — grab conversion + contested resolves to the HUMAN', () => {
  it('converts to a normal Phase B grab once the shape reaches the palm', () => {
    const { world, lab } = makeLab();
    // Spawn the shape already within the grab radius of the anchor.
    const anchor = { x: 0, y: 1, z: 0 };
    const id = spawnAt(world, { x: 0, y: 1, z: -(TK_GRAB_RADIUS * 0.5) });
    lab.arm();
    // Commit by aiming down −z (the shape is on the −z axis).
    commitPull(lab, 1000, 0, anchor, { x: 0, y: 1, z: -1 });
    lab.tick(1 / 30, 1010);
    // Converted: grabbed by the TK player, unpinned, pull dropped.
    expect(world.get(id)!.grabbedBy).toBe('p0');
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });

  it('a CONTESTED grab at the palm resolves to the HUMAN (world.grab fails → TK yields)', () => {
    const { world, lab } = makeLab();
    const anchor = { x: 0, y: 1, z: 0 };
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, anchor, { x: 0, y: 1, z: -1 });
    expect(world.isPinned(id)).toBe(true);
    // A human grabs the pinned-but-ungrabbed shape mid-pull.
    expect(world.grab(id, 'human9')).toBe(true);
    // Next tick: TK sees a foreign grab → yields (unpin, drop) — the HUMAN keeps it.
    lab.tick(1 / 30, 1010);
    expect(world.get(id)!.grabbedBy).toBe('human9');
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });
});

// ===========================================================================
// Release throw (from pose history, speed-capped)
// ===========================================================================

describe('PowersLabHost — release throw', () => {
  it('CLAMPS a client throw hint to the per-pull speed cap', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    lab.release('p0', 0, 1000 + TK_SELECT_HOLD_MS + 10, { x: 9999, y: 0, z: 0 });
    const v = world.get(id)!.velocity;
    expect(mag(v)).toBeLessThanOrEqual(TK_PULL_SPEED_MAX + 1e-6);
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });
});

// ===========================================================================
// Revert-on-disconnect + RESET
// ===========================================================================

describe('PowersLabHost — disconnect + reset revert', () => {
  it('releases all pulls (unpins) when the active TK player disconnects, freeing the lock', () => {
    const { world, lab } = makeLab();
    const a = spawnAt(world, { x: -2, y: 1, z: -5 });
    const b = spawnAt(world, { x: 2, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: -1, y: 1, z: 0 }, { x: -2, y: 1, z: -5 });
    commitPull(lab, 1000, 1, { x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: -5 });
    expect(lab.activePulls).toBe(2);
    // A non-TK peer leaving is a no-op.
    lab.onPeerDisconnect('someone-else');
    expect(lab.activePulls).toBe(2);
    // The TK player leaving reverts everything.
    lab.onPeerDisconnect('p0');
    expect(world.isPinned(a)).toBe(false);
    expect(world.isPinned(b)).toBe(false);
    expect(lab.activePulls).toBe(0);
    expect(lab.tkPlayer).toBeNull();
  });

  it('a NEW player may take over once the first fully disconnects', () => {
    const { world, lab } = makeLab();
    spawnAt(world, { x: 0, y: 1, z: -5 });
    const second = spawnAt(world, { x: 5, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    lab.onPeerDisconnect('p0');
    // p1 can now pull.
    const dir = { x: 5, y: 0, z: -5 };
    lab.feedPull('p1', 0, { x: 0, y: 1, z: 0 }, dir, 2000);
    const c = lab.feedPull('p1', 0, { x: 0, y: 1, z: 0 }, dir, 2000 + TK_SELECT_HOLD_MS);
    expect(c).toBe(second);
    expect(lab.tkPlayer).toBe('p1');
  });

  it('reset() unpins every pull (RESET boundary)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    lab.reset();
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
  });
});

// ===========================================================================
// C22.5 Part C — hardening tests (feature stays DEFAULT-OFF; these harden it
// before the owner enables it). Each closes a gap flagged in the C32 review.
// ===========================================================================

describe('C22.5 C.1 — server pose-history throw (NO velocityHint) is speed-capped', () => {
  it('CLAMPS a CRAFTED fast anchor-history throw driven through `_throwFromHistory` (not the client-hint path)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    const t0 = 1000;
    commitPull(lab, t0, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    const committedAt = t0 + TK_SELECT_HOLD_MS;
    // A CRAFTED FAST pose sequence: the anchor jumps 10 m in 1 ms — a raw
    // (unclamped) velocity of ~5,000-10,000 m/s. A sign/unit bug (ms not seconds,
    // a dropped division, or a dropped `tkClampSpeed`) would either explode past
    // the cap or collapse toward zero/negative; the clamp is the only thing that
    // keeps this sane.
    lab.feedPull('p0', 0, { x: 10, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, committedAt + 1);
    // Release WITHOUT a velocityHint — forces the server pose-history path
    // (`_throwFromHistory`), NOT the explicit client-hint branch the existing
    // "CLAMPS a client throw hint" test exercises.
    lab.release('p0', 0, committedAt + 2);
    const v = world.get(id)!.velocity;
    expect(mag(v)).toBeLessThanOrEqual(TK_PULL_SPEED_MAX + 1e-6);
    // Not silently zeroed either (a dropped-dt bug would produce ~0) — the throw
    // direction should point toward +x (the anchor moved toward +x).
    expect(mag(v)).toBeGreaterThan(0.5);
    expect(v.x).toBeGreaterThan(0);
    expect(world.isPinned(id)).toBe(false);
  });
});

describe('C22.5 C.2 — post-conversion release actually frees a TK-converted-then-held shape', () => {
  it('a NORMAL world.release() after grab-radius conversion frees the shape (never grabbed-but-unheld forever)', () => {
    const { world, lab } = makeLab();
    const anchor = { x: 0, y: 1, z: 0 };
    const id = spawnAt(world, { x: 0, y: 1, z: -(TK_GRAB_RADIUS * 0.5) });
    lab.arm();
    commitPull(lab, 1000, 0, anchor, { x: 0, y: 1, z: -1 });
    lab.tick(1 / 30, 1010); // converts to a normal Phase B grab
    expect(world.get(id)!.grabbedBy).toBe('p0');
    expect(world.isPinned(id)).toBe(false); // TK's own bookkeeping is gone post-conversion

    const released = world.release(
      id,
      'p0',
      { x: 0, y: 0, z: 0 },
      world.get(id)!.position,
      { x: 0, y: 0, z: 0 }
    );
    expect(released).toBe(true);
    expect(world.get(id)!.grabbedBy).toBeNull();
  });

  it('DISCONNECT CLEANUP (the same forceRelease Room.leave uses) frees a TK-converted-then-held shape', () => {
    const { world, lab } = makeLab();
    const anchor = { x: 0, y: 1, z: 0 };
    const id = spawnAt(world, { x: 0, y: 1, z: -(TK_GRAB_RADIUS * 0.5) });
    lab.arm();
    commitPull(lab, 1000, 0, anchor, { x: 0, y: 1, z: -1 });
    lab.tick(1 / 30, 1010);
    expect(world.get(id)!.grabbedBy).toBe('p0');
    // `forceRelease` — the EXACT method `room.ts`'s disconnect handler calls (never
    // plain `release`, which can be wedged by a non-finite in-flight transform).
    const ok = world.forceRelease(id, 'p0');
    expect(ok).toBe(true);
    expect(world.get(id)!.grabbedBy).toBeNull();
  });
});

describe('C22.5 C.4 — concurrent loop-force on the SAME shape (TK pin + a titan hand sweep)', () => {
  function makeTitanOn(world: ServerWorld, t: ReturnType<typeof makeFakeTimers>): TitanHost {
    const host2 = new RoomTimelineHost({
      timer: t.api,
      world,
      broadcast: () => {},
      roster: () => peers(2),
      initialPhase: 'PLAY',
    });
    return new TitanHost({ timer: t.api, world, handle: host2.handle, broadcast: () => {} });
  }

  // `pin !== grab` — titan's own `grabbedBy !== null` exclusion does NOT shield a
  // pinned-but-ungrabbed shape. Both hosts can write `shape.velocity` in the SAME
  // pre-physics window (index.ts `runSimTick`: a titan pose impulse arrives via the
  // socket pose handler at any point relative to `hub.tickPowersLab`, both BEFORE
  // `room.tick()` integrates). Each host's write independently clamps its OWN
  // FULL result (not just its own delta) to ITS OWN cap — so whichever host writes
  // LAST determines the final speed, tightly bounded by THAT host's cap; this test
  // proves BOTH orderings hold (never an unbounded/summed compounding of the two).

  it('TK writes LAST → the final speed is tightly bounded by TK_PULL_SPEED_MAX (titan residue does not leak through)', () => {
    const { world, lab, t } = makeLab();
    const titan = makeTitanOn(world, t);
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(world.isPinned(id)).toBe(true);

    titan.titanize('p1');
    // A titan hand relays poses FASTER than the 30 Hz sim tick, so several
    // impulse applications can land inside one tick window — a slightly
    // hand-offset (non-coincident) high-speed sweep, applied repeatedly, drives
    // the shape's velocity up toward TITAN_THROW_MAX (25) before TK's tick runs.
    const hand = { pos: { x: 0.05, y: 1, z: -5 }, vel: { x: 80, y: 0, z: 0 } };
    for (let i = 0; i < 6; i++) titan.applyHandImpulses('p1', [hand]);
    // Confirm the pre-condition so the TK-clamp assertion below is not vacuous.
    expect(mag(world.get(id)!.velocity)).toBeGreaterThan(TK_PULL_SPEED_MAX);

    lab.tick(1 / 30, 1010); // TK's own loop-force write, same tick window, LAST
    const v = world.get(id)!.velocity;
    expect(mag(v)).toBeLessThanOrEqual(TK_PULL_SPEED_MAX + 1e-6);
  });

  it('titan writes LAST → the final speed is tightly bounded by TITAN_THROW_MAX (TK residue does not push it further)', () => {
    const { world, lab, t } = makeLab();
    const titan = makeTitanOn(world, t);
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    commitPull(lab, 1000, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    expect(world.isPinned(id)).toBe(true);

    lab.tick(1 / 30, 1010); // TK's own loop-force write, same tick window, FIRST
    const afterTk = { ...world.get(id)!.position };
    expect(mag(world.get(id)!.velocity)).toBeGreaterThan(0); // a pre-condition sanity check

    titan.titanize('p1');
    const hand = { pos: { x: afterTk.x + 0.05, y: afterTk.y, z: afterTk.z }, vel: { x: 80, y: 0, z: 0 } };
    for (let i = 0; i < 6; i++) titan.applyHandImpulses('p1', [hand]);
    const v = world.get(id)!.velocity;
    // Confirm titan's repeated sweep actually drove it near ITS cap (not a
    // no-op) so the assertion below is not vacuous.
    expect(mag(v)).toBeGreaterThan(TK_PULL_SPEED_MAX);
    // Even starting from TK's already-nonzero velocity, titan's clamp re-clamps
    // the WHOLE combined result — never TK's cap PLUS titan's cap summed.
    expect(mag(v)).toBeLessThanOrEqual(TITAN_THROW_MAX + 1e-6);
    expect(mag(v)).toBeLessThanOrEqual(Math.max(TK_PULL_SPEED_MAX, TITAN_THROW_MAX) + 1e-6);
  });
});

describe('C22.5 C.5 — dead-man + contest + expire same-tick ordering', () => {
  it('a pull that is BOTH contested by a human AND past the dead-man window in one tick leaves a consistent state (no stuck pin, human wins)', () => {
    const { world, lab } = makeLab();
    const id = spawnAt(world, { x: 0, y: 1, z: -5 });
    lab.arm();
    const t0 = 1000;
    commitPull(lab, t0, 0, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 });
    const lastPull = t0 + TK_SELECT_HOLD_MS;
    expect(world.isPinned(id)).toBe(true);

    // A human's OWN grab intent lands on the pinned-but-ungrabbed shape (mirrors
    // the existing "contested at the palm" test — `world.grab` succeeds on a
    // pinned body; pin never blocks grab arbitration).
    expect(world.grab(id, 'human9')).toBe(true);

    // The SAME tick is ALSO past the ~250 ms dead-man window (no fresh TK_PULL
    // arrived) — `tick()`'s per-hand loop checks dead-man FIRST, so both
    // conditions are live simultaneously for this single tick.
    const tickAt = lastPull + TK_DEADMAN_MS + 5;
    lab.tick(1 / 30, tickAt);

    // Consistent end state either way the internal ordering resolves it: the pin
    // is gone (never stuck), the aim is reaped (no phantom activePulls), and the
    // human keeps the shape (never reverted/re-contested by TK).
    expect(world.isPinned(id)).toBe(false);
    expect(lab.activePulls).toBe(0);
    expect(world.get(id)!.grabbedBy).toBe('human9');
    expect(lab.tkPlayer).toBeNull(); // the aim was TK's only aim — lock freed too
  });
});
