/**
 * siege.test.ts — Task C16 F6 Meteor Siege (spec §7.6).
 *
 * TDD RED-first (brief Step 1). Deterministic + fake-time throughout: the
 * SiegeHost takes an injected TimerApi and drives a live ServerWorld through a
 * RoomHandle, exactly like the C15 ElectionHost. No raw setTimeout / Date.now.
 *
 * The load-bearing test is the lag-compensated catch: a grab made under ~100 ms
 * latency that a NAIVE (no-rewind) check REJECTS but the rewind check ACCEPTS.
 */

import { describe, it, expect } from 'vitest';
import {
  OPCODES,
  SHOWPIECE_KIND,
  MAX_SHAPES,
  METEOR_SPEED_CAP,
  METEOR_CATCH_RADIUS,
  METEOR_BUDGET,
  MET_LAUNCH_INTERVAL_MS,
  SIEGE_CALLOUT_INTERVAL_MS,
  SIEGE_FULL_DURATION_MS,
  SIEGE_OVERLOAD_HOLD_MS,
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  mergeParams,
  SIEGE_WAVES,
  SIEGE_WAVE_BULLET_TIMESCALE,
  SIEGE_BULLET_TIME_CAP_MS,
  SIEGE_MAX_LAUNCH_RATE,
  wavesSatisfyBudget,
  wavesSatisfyBulletTimeCap,
  wavesFitSiegeWindow,
  waveInFlightEstimate,
  meteorFlightTime,
  admitMeteor,
  totalWaveDurationMs,
  type TimerApi,
  type TimerHandle,
  type RoomHandle,
  type PeerInfo,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { SiegeHost } from '../src/siege.js';
import { registerDialCues } from '../src/dials.js';

/** An elected LOW-G standing law (gravity ~¼ default) — the two-layer base a wave
 * overlay must never clobber (§5.6/§7.16). */
const ELECTED_LOW_G = mergeParams(DEFAULT_PARAMS, { gravity: { x: 0, y: -1.2, z: 0 } });

// ---------------------------------------------------------------------------
// Fake timers (copied from the electionHost.test harness — the canonical shape).
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

/** Build a siege over a live world + timeline host, capturing broadcasts. */
function makeSiege(
  over: {
    maxShapes?: number;
    participants?: PeerInfo[];
    launchers?: number;
    initialPhase?: 'OVERLOAD' | 'FINALE' | 'PLAY';
  } = {}
): {
  t: ReturnType<typeof makeFakeTimers>;
  world: ServerWorld;
  host: RoomTimelineHost;
  siege: SiegeHost;
  handle: RoomHandle;
  broadcasts: Broadcast[];
} {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? MAX_SHAPES,
    idFactory: makeIdFactory('w'),
  });
  const roster: PeerInfo[] = over.participants ?? [];
  const broadcasts: Broadcast[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    initialPhase: over.initialPhase ?? 'OVERLOAD',
  });
  const siege = new SiegeHost({
    timer: t.api,
    world,
    handle: host.handle,
    host,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
  });
  return { t, world, host, siege, handle: host.handle, broadcasts };
}

function peers(n: number, tier = 'crowd'): PeerInfo[] {
  const out: PeerInfo[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `p${i}`, name: `VOLT-${i}`, color: 0, tier } as unknown as PeerInfo);
  }
  return out;
}

/** Filter broadcasts to SHOWPIECE-family opcodes with a given kind. */
function showpiece(broadcasts: Broadcast[], kind?: number): Broadcast[] {
  return broadcasts.filter(
    (b) =>
      b.opcode === OPCODES.SHOWPIECE &&
      (kind === undefined || (b.payload as { kind?: number }).kind === kind)
  );
}

/**
 * Advance the fake clock wave-by-wave until the siege reaches wave `target`. The
 * fake timer's `now()` JUMPS to the target on a single big advance, so a chained
 * wave-advance timer (scheduled relative to `now()` when the previous wave starts)
 * must be crossed ONE boundary at a time — exactly like real incremental time.
 */
function advanceToWave(
  t: ReturnType<typeof makeFakeTimers>,
  siege: SiegeHost,
  target: number
): void {
  let guard = 0;
  while (siege.active && siege.waveIndex >= 0 && siege.waveIndex < target && guard++ < 12) {
    t.advance(SIEGE_WAVES[siege.waveIndex].durationMs + 5);
  }
}

// ===========================================================================
// Arming
// ===========================================================================
describe('SiegeHost — arm / HP / termination', () => {
  it('arms a pinned crystal that the store never evicts, and counts a showpiece metric', () => {
    let showpieceCount = 0;
    const t = makeFakeTimers();
    const world = new ServerWorld({ maxShapes: MAX_SHAPES, idFactory: makeIdFactory('w') });
    const broadcasts: Broadcast[] = [];
    const host = new RoomTimelineHost({
      timer: t.api,
      world,
      broadcast: (o, p, ti) => void broadcasts.push({ opcode: o, payload: p, tiers: ti }),
      roster: () => [],
      initialPhase: 'FINALE',
    });
    const siege = new SiegeHost({
      timer: t.api,
      world,
      handle: host.handle,
      host,
      broadcast: (o, p, ti) => void broadcasts.push({ opcode: o, payload: p, tiers: ti }),
      metricsCount: (k) => {
        if (k === 'showpiece') showpieceCount++;
      },
    });
    siege.arm({ staffArmed: true });
    expect(siege.active).toBe(true);
    expect(showpieceCount).toBe(1);
    const crystalId = siege.crystalId!;
    expect(crystalId).not.toBeNull();
    expect(world.isPinned(crystalId)).toBe(true);
    // Fill far beyond the cap — the pinned crystal must survive every eviction.
    for (let i = 0; i < MAX_SHAPES * 3; i++) {
      world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 }, colorIndex: 0 });
    }
    expect(world.get(crystalId)).toBeDefined();
    // A SHOWPIECE_START was broadcast on the showpiece family.
    expect(showpiece(broadcasts, SHOWPIECE_KIND.START).length).toBe(1);
  });

  it('scales crystal HP with participant count', () => {
    const few = makeSiege({ participants: peers(2), initialPhase: 'FINALE' });
    few.siege.arm({ staffArmed: true });
    const many = makeSiege({ participants: peers(10), initialPhase: 'FINALE' });
    many.siege.arm({ staffArmed: true });
    expect(many.siege.maxHp).toBeGreaterThan(few.siege.maxHp);
    // HP is also >0 with zero participants (base HP).
    const none = makeSiege({ participants: peers(0), initialPhase: 'FINALE' });
    none.siege.arm({ staffArmed: true });
    expect(none.siege.maxHp).toBeGreaterThan(0);
  });

  it('OVERLOAD auto-arm extends the phase via hold() (fake time)', () => {
    const { siege, host } = makeSiege({ initialPhase: 'OVERLOAD' });
    const before = host.timeline.state().remainingMs ?? 0;
    siege.arm({ staffArmed: false }); // OVERLOAD auto-arm → hold(60_000)
    const after = host.timeline.state().remainingMs ?? 0;
    expect(after).toBeGreaterThanOrEqual(before + SIEGE_OVERLOAD_HOLD_MS - 1);
  });

  it('self-terminates after the full 90 s when FINALE/staff-armed', () => {
    const { siege, t, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    expect(siege.active).toBe(true);
    t.advance(SIEGE_FULL_DURATION_MS - 100);
    expect(siege.active).toBe(true);
    t.advance(200); // cross the 90 s boundary
    expect(siege.active).toBe(false);
    // An END card was broadcast (SHOWPIECE_END).
    expect(showpiece(broadcasts, SHOWPIECE_KIND.END).length).toBe(1);
  });

  it('terminates early (CRYSTAL FALLS) when HP is depleted', () => {
    const { siege } = makeSiege({ participants: peers(0), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const hp = siege.hp;
    // Depleting HP directly (the swat/hit path funnels through damage()).
    for (let i = 0; i < hp; i++) siege.damage(1);
    expect(siege.active).toBe(false);
    expect(siege.outcome).toBe('CROWD_WINS');
  });
});

// ===========================================================================
// Meteor spawn + speed cap + eviction
// ===========================================================================
describe('SiegeHost — meteor spawn + speed cap + eviction', () => {
  it('caps meteor speed to 6–8 m/s regardless of what the client claims', () => {
    const { siege, world } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    // A launcher claims an absurd power; the server clamps the resulting speed.
    siege.launch('p0', {
      origin: { x: 10, y: 1, z: 0 },
      aim: { x: -1, y: 0.3, z: 0 },
      power: 999, // hostile — never trusted
      colorIndex: 2,
    });
    const meteors = world.shapes.filter((s) => siege.isMeteor(s.id));
    expect(meteors.length).toBe(1);
    const v = meteors[0].velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    expect(speed).toBeLessThanOrEqual(METEOR_SPEED_CAP + 1e-6);
    expect(speed).toBeGreaterThan(0);
  });

  it('rate-limits a launcher to one meteor per MET_LAUNCH_INTERVAL_MS', () => {
    const { siege, t } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const shoot = (): boolean =>
      siege.launch('p0', { origin: { x: 5, y: 1, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    expect(shoot()).toBe(true); // first launch accepted
    expect(shoot()).toBe(false); // too soon — rejected by the 1/3 s rate limit
    t.advance(MET_LAUNCH_INTERVAL_MS + 10);
    expect(shoot()).toBe(true); // window elapsed — accepted again
  });

  it('meteors carry the per-launcher color and zero lights (never lit)', () => {
    const { siege, world } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    siege.launch('p0', { origin: { x: 5, y: 1, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1, colorIndex: 4 });
    const m = world.shapes.find((s) => siege.isMeteor(s.id))!;
    expect(m.colorIndex).toBe(4);
    // renderMode 'wireframe' = no solid → no light in the client's first-20 rule.
    expect(m.renderMode).toBe('wireframe');
  });

  it('a defender holding a meteor + the pinned crystal SURVIVE 24 launchers at max rate; the MAX_SHAPES cap holds', () => {
    const { siege, world, t } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const crystalId = siege.crystalId!;
    // A defender grabs one meteor and holds it for the whole barrage.
    siege.launch('p0', { origin: { x: 5, y: 1, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    const held = world.shapes.find((s) => siege.isMeteor(s.id))!;
    world.grab(held.id, 'defender');
    expect(held.grabbedBy).toBe('defender');
    // 24 launchers fire as fast as the rate limiter allows for ~24 s (well within
    // the 90 s siege window — a longer run would self-terminate + despawn the crystal).
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 24; i++) {
        siege.launch(`p${i}`, {
          origin: { x: 8, y: 2, z: 0 },
          aim: { x: -1, y: 0, z: 0 },
          power: 1,
        });
      }
      t.advance(MET_LAUNCH_INTERVAL_MS + 1);
    }
    // The cap held (never exceeded MAX_SHAPES).
    expect(world.shapes.length).toBeLessThanOrEqual(MAX_SHAPES);
    // The crystal (pinned) is never evicted.
    expect(world.get(crystalId)).toBeDefined();
    // The held meteor (grabbed) is never evicted.
    expect(world.get(held.id)).toBeDefined();
    expect(world.get(held.id)!.grabbedBy).toBe('defender');
  });
});

// ===========================================================================
// Lag-compensated catch — THE load-bearing test.
// ===========================================================================
describe('SiegeHost — lag-compensated rewind catch', () => {
  it('a ~100 ms-late catch: the NAIVE (no-rewind) check REJECTS, the rewind check ACCEPTS', () => {
    const { siege, world, t } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    // Launch a meteor moving along -x at a known speed.
    siege.launch('p0', { origin: { x: 5, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    const meteor = world.shapes.find((s) => siege.isMeteor(s.id))!;
    const meteorId = meteor.id;

    // Advance the sim ~100 ms; the meteor moves, and the rewind ring records
    // its historical positions each tick.
    const dtMs = 1000 / 30;
    let simTime = t.now();
    for (let i = 0; i < 3; i++) {
      simTime += dtMs;
      t.advance(dtMs);
      world.step(dtMs / 1000); // sim loop steps the world (meteor arcs)
      siege.tick(dtMs / 1000); // then the siege records the rewind ring
    }
    // The player SAW the meteor ~100 ms ago (their render is interpolation-delayed
    // + RTT). They grab at that OLD position with a timestamp ~100 ms in the past.
    const rewound = siege.rewoundPositionAt(meteorId, simTime - 100)!;
    const nowPos = world.get(meteorId)!.position;
    // The meteor has visibly moved away from where the player grabbed.
    const drift = Math.hypot(
      nowPos.x - rewound.x,
      nowPos.y - rewound.y,
      nowPos.z - rewound.z
    );
    expect(drift).toBeGreaterThan(METEOR_CATCH_RADIUS); // out of naive reach

    // NAIVE check (grab at the rewound point vs the CURRENT position) → REJECT.
    const naive = siege.validateCatchNaive(meteorId, rewound);
    expect(naive).toBe(false);

    // REWIND check (grab at the rewound point vs the position 100 ms ago) → ACCEPT.
    const rewindOk = siege.validateCatch(meteorId, rewound, simTime - 100);
    expect(rewindOk).toBe(true);
  });

  it('a catch far from BOTH the current and the rewound position is still rejected', () => {
    const { siege, world, t } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    siege.launch('p0', { origin: { x: 5, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    const meteor = world.shapes.find((s) => siege.isMeteor(s.id))!;
    const dtMs = 1000 / 30;
    let simTime = t.now();
    for (let i = 0; i < 3; i++) {
      simTime += dtMs;
      t.advance(dtMs);
      world.step(dtMs / 1000); // sim loop steps the world (meteor arcs)
      siege.tick(dtMs / 1000); // then the siege records the rewind ring
    }
    const wayOff = { x: 100, y: 100, z: 100 };
    expect(siege.validateCatch(meteor.id, wayOff, simTime - 100)).toBe(false);
  });

  it('catch() attaches the meteor to the defender (grabbedBy set) on a valid rewind grab', () => {
    const { siege, world, t } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    siege.launch('p0', { origin: { x: 5, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    const meteor = world.shapes.find((s) => siege.isMeteor(s.id))!;
    const dtMs = 1000 / 30;
    let simTime = t.now();
    for (let i = 0; i < 2; i++) {
      simTime += dtMs;
      t.advance(dtMs);
      world.step(dtMs / 1000); // sim loop steps the world (meteor arcs)
      siege.tick(dtMs / 1000); // then the siege records the rewind ring
    }
    const rewound = siege.rewoundPositionAt(meteor.id, simTime - 66)!;
    const caught = siege.catch('defender', meteor.id, rewound, simTime - 66);
    expect(caught).toBe(true);
    expect(world.get(meteor.id)!.grabbedBy).toBe('defender');
  });
});

// ===========================================================================
// Grab intent round-trips clientTimestamp (protocol).
// ===========================================================================
describe('grab intent carries a clientTimestamp', () => {
  it('validateClientMsg accepts a grab with a numeric clientTimestamp and rejects a non-numeric one', async () => {
    const { validateClientMsg } = await import('@cyber-shapes/shared');
    expect(validateClientMsg({ t: 'grab', id: 'w1', clientTimestamp: 12345 })).toBe(true);
    expect(validateClientMsg({ t: 'grab', id: 'w1' })).toBe(true); // optional
    expect(validateClientMsg({ t: 'grab', id: 'w1', clientTimestamp: 'nope' })).toBe(false);
  });
});

// ===========================================================================
// Callout queue: rate + priority order.
// ===========================================================================
describe('SiegeHost — callout queue rate + priority', () => {
  it('drains at most one callout per 2 s in priority order (catches > throwbacks > swats > hits)', () => {
    const { siege, t, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const startLen = broadcasts.length;
    // Enqueue out of priority order in the same instant.
    siege.enqueueCallout('hit', 'VOLT-1');
    siege.enqueueCallout('swat', 'VOLT-2');
    siege.enqueueCallout('throwback', 'VOLT-3');
    siege.enqueueCallout('catch', 'VOLT-4');
    // Drain one at a time; each STATE broadcast carries the current callout.
    const drained: string[] = [];
    for (let i = 0; i < 4; i++) {
      t.advance(SIEGE_CALLOUT_INTERVAL_MS + 1);
      const st = showpiece(broadcasts.slice(startLen), SHOWPIECE_KIND.STATE)
        .map((b) => (b.payload as { callout?: { kind: string } }).callout?.kind)
        .filter((x): x is string => !!x);
      if (st.length) drained.push(st[st.length - 1]);
    }
    // The catch is announced FIRST despite being enqueued last.
    expect(drained[0]).toBe('catch');
    expect(drained.indexOf('catch')).toBeLessThan(drained.indexOf('throwback'));
    expect(drained.indexOf('throwback')).toBeLessThan(drained.indexOf('swat'));
    expect(drained.indexOf('swat')).toBeLessThan(drained.indexOf('hit'));
  });

  it('never emits two callouts within a single 2 s window', () => {
    const { siege, t, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    for (let i = 0; i < 5; i++) siege.enqueueCallout('catch', `VOLT-${i}`);
    const startLen = broadcasts.length;
    t.advance(SIEGE_CALLOUT_INTERVAL_MS - 100); // just under one window
    const withCallout = showpiece(broadcasts.slice(startLen), SHOWPIECE_KIND.STATE).filter(
      (b) => (b.payload as { callout?: unknown }).callout
    );
    expect(withCallout.length).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// Showpiece overlay guard (+ CQ-1).
// ===========================================================================
describe('SiegeHost — showpiece overlay guard (§7.15/§7.16)', () => {
  it('claims the showpiece overlay on arm and releases it on end', () => {
    const { siege, host, t } = makeSiege({ initialPhase: 'FINALE' });
    expect(host.showpieceOverlayActive).toBe(false);
    siege.arm({ staffArmed: true });
    expect(host.showpieceOverlayActive).toBe(true);
    t.advance(SIEGE_FULL_DURATION_MS + 10);
    expect(siege.active).toBe(false);
    expect(host.showpieceOverlayActive).toBe(false);
  });
});

// ===========================================================================
// Late-join coherence.
// ===========================================================================
describe('SiegeHost — late join mid-siege', () => {
  it('a late joiner receives a coherent SHOWPIECE snapshot with the live HP', () => {
    const { siege } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    siege.damage(5);
    const snap = siege.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.active).toBe(true);
    expect(snap!.hp).toBe(siege.hp);
    expect(snap!.maxHp).toBe(siege.maxHp);
    expect(snap!.hp).toBeLessThan(snap!.maxHp);
    expect(typeof snap!.crystalId).toBe('string');
    expect(typeof snap!.endsAt).toBe('number');
  });

  it('snapshot() is null when no siege is active', () => {
    const { siege } = makeSiege({ initialPhase: 'PLAY' });
    expect(siege.snapshot()).toBeNull();
  });
});

// ===========================================================================
// No-uplink barrage rung (works with zero phones).
// ===========================================================================
describe('SiegeHost — no-uplink barrage', () => {
  it('spawns server meteors on a barrage cadence with zero launchers', () => {
    const { siege, world, t } = makeSiege({ participants: peers(0), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const before = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    // Run the sim for a few seconds with NO client launches at all.
    const dtMs = 1000 / 30;
    for (let i = 0; i < 120; i++) {
      t.advance(dtMs);
      siege.tick(dtMs / 1000);
    }
    const after = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    expect(after).toBeGreaterThan(before); // the barrage kept firing crowd-less
  });
});

// ===========================================================================
// End card → top-3 callsigns for the stats-card bridge.
// ===========================================================================
describe('SiegeHost — end card', () => {
  it('reports the top-3 bombardier callsigns by launch count', () => {
    const { siege } = makeSiege({ participants: peers(5), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    // p1 fires most, p0 next, p2 once. Use distinct launchers with rate reset.
    const fire = (id: string): void => {
      siege.launch(id, { origin: { x: 5, y: 1, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    };
    // Attribute launches directly via the counter (rate-limit tested separately).
    siege.recordLaunchFor('VOLT-1');
    siege.recordLaunchFor('VOLT-1');
    siege.recordLaunchFor('VOLT-1');
    siege.recordLaunchFor('VOLT-0');
    siege.recordLaunchFor('VOLT-0');
    siege.recordLaunchFor('VOLT-2');
    fire('p9'); // exercise the rate-gated path too
    const top = siege.topBombardiers(3);
    expect(top[0].callsign).toBe('VOLT-1');
    expect(top[0].value).toBe(3);
    expect(top[1].callsign).toBe('VOLT-0');
    expect(top.length).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// C27 — F16 Siege Waves (spec §7.16). The wave-table invariants + the meteor
// admission budget + bullet-time cap + ENV/SHOWPIECE wire + dial contention +
// elected-law survival + late-join + unknown-kind-ignore.
// ===========================================================================

/** Filter captured broadcasts to ENV_STATE. */
function envStates(broadcasts: Broadcast[]): Array<{ mode: string | null; params: { gravity?: { y: number }; timescale?: number } }> {
  return broadcasts
    .filter((b) => b.opcode === OPCODES.ENV_STATE)
    .map((b) => b.payload as { mode: string | null; params: { gravity?: { y: number }; timescale?: number } });
}

describe('C27 Siege Waves — the data-driven wave-table invariants (pure, over ALL rows)', () => {
  it('the BUDGET invariant holds for every row against the REAL METEOR_BUDGET', () => {
    // Reconciliation: the REAL constant is 12 (NOT the ~28 = MAX_SHAPES − METEOR_BUDGET
    // the brief rounds to). Every row: rate × mult × flightTime(ts,g) ≤ 12.
    expect(METEOR_BUDGET).toBe(12);
    expect(wavesSatisfyBudget()).toBe(true);
    for (const w of SIEGE_WAVES) {
      expect(waveInFlightEstimate(w)).toBeLessThanOrEqual(METEOR_BUDGET + 1e-9);
    }
    // WAVE 1 must leave headroom the invariant forces (never sit AT the budget).
    expect(waveInFlightEstimate(SIEGE_WAVES[0])).toBeLessThan(METEOR_BUDGET);
    // The design rate is the 24-launcher max cadence (24 / 3 s = 8/s).
    expect(SIEGE_MAX_LAUNCH_RATE).toBeCloseTo(8, 6);
    // WAVE 3 (×4 flight time under ×0.25) cuts admission into the 0.25–0.35 band.
    expect(SIEGE_WAVES[2].meteorRateMult).toBeGreaterThanOrEqual(0.25);
    expect(SIEGE_WAVES[2].meteorRateMult).toBeLessThanOrEqual(0.35);
    // Flight time is ×4 at the bullet-time timescale (lingering densifies the cloud).
    expect(meteorFlightTime(SIEGE_WAVE_BULLET_TIMESCALE, -5)).toBeCloseTo(
      meteorFlightTime(1, -5) * 4,
      6
    );
  });

  it('the BULLET-TIME window cap holds: no timescale<0.5 overlay exceeds 15 s', () => {
    expect(wavesSatisfyBulletTimeCap()).toBe(true);
    for (const w of SIEGE_WAVES) {
      const ts = w.dialOverlay?.timescale ?? 1;
      if (ts < 0.5) expect(w.durationMs).toBeLessThanOrEqual(SIEGE_BULLET_TIME_CAP_MS);
    }
  });

  it('Σ wave durations ≤ the 90 s siege window', () => {
    expect(wavesFitSiegeWindow()).toBe(true);
    expect(totalWaveDurationMs()).toBeLessThanOrEqual(SIEGE_FULL_DURATION_MS);
  });

  it('the admission throttle admits deterministically at the wave mult (no RNG)', () => {
    // mult 1.0 → always admit; mult 0.3 → ~every 3rd attempt (30 %).
    let c = 0;
    for (let i = 0; i < 10; i++) {
      const r = admitMeteor(c, 1.0);
      c = r.credit;
      expect(r.admit).toBe(true);
    }
    c = 0;
    let admitted = 0;
    for (let i = 0; i < 30; i++) {
      const r = admitMeteor(c, 0.3);
      c = r.credit;
      if (r.admit) admitted++;
    }
    // ~30 × 0.3 ≈ 9 (float accumulation lands at 8–9): the throttle admits ~30 %.
    expect(admitted).toBeGreaterThanOrEqual(8);
    expect(admitted).toBeLessThanOrEqual(9);
  });
});

describe('C27 Siege Waves — meteor admission budget (inFlightMeteors ≤ METEOR_BUDGET)', () => {
  it('never admits more than METEOR_BUDGET in-flight meteors, at the 24-launcher max rate', () => {
    const { siege, world } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    // Fire far more than the budget in one instant (wave 1, mult 1.0 → no throttle).
    for (let i = 0; i < 40; i++) {
      siege.launch(`p${i}`, { origin: { x: 8, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    }
    const inFlight = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    expect(inFlight).toBeLessThanOrEqual(METEOR_BUDGET);
  });

  it('a HELD meteor + the pinned crystal SURVIVE a wave transition at the 24-launcher max rate', () => {
    const { siege, world, t } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    const crystalId = siege.crystalId!;
    siege.launch('p0', { origin: { x: 5, y: 1, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    const held = world.shapes.find((s) => siege.isMeteor(s.id))!;
    world.grab(held.id, 'defender');
    // Fire across the wave-1 → wave-2 transition boundary (30 s) at max cadence.
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 24; i++) {
        siege.launch(`p${i}`, { origin: { x: 8, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
      }
      t.advance(MET_LAUNCH_INTERVAL_MS + 1);
    }
    expect(world.shapes.length).toBeLessThanOrEqual(MAX_SHAPES);
    expect(world.get(crystalId)).toBeDefined(); // pinned — never evicted
    expect(world.get(held.id)).toBeDefined(); // grabbed — never evicted
    expect(world.get(held.id)!.grabbedBy).toBe('defender');
    // We actually crossed into wave 2 (or beyond).
    expect(siege.waveIndex).toBeGreaterThanOrEqual(1);
  });

  it('WAVE 3 (×0.25 slow-mo) keeps the in-flight swarm inside the budget while the crowd fires', () => {
    const { siege, world, t } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    advanceToWave(t, siege, 2); // reach wave 3 (bullet time) on the timer
    expect(siege.waveIndex).toBe(2);
    expect(SIEGE_WAVES[2].meteorRateMult).toBeLessThan(1); // the ×0.3 admission throttle
    // Fire a large burst — the budget + the ×0.3 throttle drop the excess silently.
    for (let i = 0; i < 40; i++) {
      siege.launch(`p${i}`, { origin: { x: 8, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    }
    // The in-flight count NEVER exceeds the budget (the frozen cloud is dense from
    // lingering, not from more launches — spec §7.16).
    const inFlight = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    expect(inFlight).toBeLessThanOrEqual(METEOR_BUDGET);
  });
});

describe('C27 Siege Waves — ENV_STATE + SHOWPIECE_STATE wire (no strings on the WAVE wire)', () => {
  it('each wave rides ENV_STATE (physics + mode banner) and a SHOWPIECE WAVE (indices only)', () => {
    const { siege, host, t, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    // WAVE 1 broadcast on arm.
    const wave0 = showpiece(broadcasts, SHOWPIECE_KIND.WAVE).map((b) => b.payload as { waveIndex: number; waveEndsAt: number });
    expect(wave0.length).toBeGreaterThanOrEqual(1);
    expect(wave0[0].waveIndex).toBe(0);
    expect(typeof wave0[0].waveEndsAt).toBe('number');
    // The WAVE payload carries NO name string (indices/fixed-point only).
    const wavePayload = showpiece(broadcasts, SHOWPIECE_KIND.WAVE)[0].payload as Record<string, unknown>;
    expect(Object.values(wavePayload).some((v) => typeof v === 'string')).toBe(false);
    // The physics rides ENV_STATE with the wave name as the cue-banner mode.
    const envs = envStates(broadcasts);
    expect(envs.some((e) => e.mode === SIEGE_WAVES[0].name)).toBe(true);
    // Advance to wave 3 (bullet time): ENV_STATE carries the ×0.25 timescale.
    advanceToWave(t, siege, 2);
    expect(host.effectiveParams().timescale).toBeCloseTo(SIEGE_WAVE_BULLET_TIMESCALE, 6);
    const w2 = showpiece(broadcasts, SHOWPIECE_KIND.WAVE).map((b) => (b.payload as { waveIndex: number }).waveIndex);
    expect(w2).toContain(2);
  });

  it('the WAVE broadcast fans out to SHOWPIECE_TIERS only (the C25 audience boundary holds)', async () => {
    const { SHOWPIECE_TIERS } = await import('../src/siege.js');
    const { siege, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    for (const b of showpiece(broadcasts, SHOWPIECE_KIND.WAVE)) {
      expect(b.tiers).toEqual(SHOWPIECE_TIERS);
      expect(b.tiers).not.toContain('audience'); // never leaks past the allowlist
    }
  });

  it('a late-joiner mid-wave gets a coherent {waveIndex, waveEndsAt} snapshot', () => {
    const { siege, t } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    t.advance(SIEGE_WAVES[0].durationMs + 5); // now in wave 2 (index 1)
    const snap = siege.snapshot()!;
    expect(snap.active).toBe(true);
    expect(snap.waveIndex).toBe(1);
    expect(typeof snap.waveEndsAt).toBe('number');
    expect(snap.waveEndsAt).toBeGreaterThan(t.now());
  });
});

describe('C27 Siege Waves — dial contention + elected law survives the siege AND the between-wave pop', () => {
  it('a staff-forced dial fired mid-wave is REJECTED, the wave overlay is intact, and the elected law survives', () => {
    const { siege, host, t } = makeSiege({ initialPhase: 'FINALE' });
    registerDialCues(host.registry); // advertise the bank so fire() can find supernova
    host.setBaseParams(ELECTED_LOW_G); // an elected standing law
    siege.arm({ staffArmed: true });
    t.advance(1000); // mid wave 1
    // SUPERNOVA includes FINALE in its phases, so only the SHOWPIECE-active guard
    // can refuse it — proving the showpiece overlay guard (not just the phase gate).
    const res = host.fire('supernova', 'staff:supernova:1');
    expect(res).toBe('wrongPhase');
    // The elected LOW-G base survives underneath (gravity is the elected −1.2, not
    // the −5 SUPERNOVA would have written).
    expect(host.effectiveParams().gravity!.y).toBeCloseTo(-1.2, 6);
    expect(host.baseParams.gravity!.y).toBeCloseTo(-1.2, 6);
    // De-vacuous: assert the WAVE overlay's OWN fields survive the rejected dial —
    // not just the base gravity (which equals the elected base regardless of any
    // overlay). WAVE 1's containment overlay (§5.6) sets bounds = DIAL_BOUNDS and
    // suspendDespawn = true; both must still ride effectiveParams, proving the
    // siege still OWNS the single cueOverlay and the refused SUPERNOVA never
    // clobbered/cleared it.
    const eff = host.effectiveParams();
    expect(eff.bounds!.softSphereR).toBe(DIAL_BOUNDS.softSphereR);
    expect(eff.bounds!.speedCap).toBe(DIAL_BOUNDS.speedCap);
    expect(eff.suspendDespawn).toBe(true);
    expect(siege.waveIndex).toBe(0); // still in the WAVE 1 overlay, unchanged
  });

  it('the elected law is preserved through EVERY wave overlay AND the between-wave pop', () => {
    const { siege, host, t, broadcasts } = makeSiege({ initialPhase: 'FINALE' });
    host.setBaseParams(ELECTED_LOW_G);
    siege.arm({ staffArmed: true });
    const startLen = broadcasts.length;
    // Wave 1: base gravity shows through the containment-only overlay.
    expect(host.effectiveParams().gravity!.y).toBeCloseTo(-1.2, 6);
    // Cross the wave-1 → wave-2 boundary and capture the between-wave pop.
    t.advance(SIEGE_WAVES[0].durationMs + 5);
    // At the boundary the overlay popped to base (an ENV_STATE with mode=null) whose
    // params still carry the elected LOW-G law — the wave never clobbered baseParams.
    const popped = envStates(broadcasts.slice(startLen)).find((e) => e.mode === null);
    expect(popped).toBeDefined();
    expect(popped!.params.gravity!.y).toBeCloseTo(-1.2, 6);
    // Wave 3 (bullet time): the overlay changes ONLY timescale; the elected gravity
    // survives (base ⊕ overlay = LOW-G gravity + ×0.25 timescale).
    advanceToWave(t, siege, 2);
    expect(host.effectiveParams().timescale).toBeCloseTo(SIEGE_WAVE_BULLET_TIMESCALE, 6);
    expect(host.effectiveParams().gravity!.y).toBeCloseTo(-1.2, 6);
    // Run the siege out; the elected base law still stands after the whole siege.
    t.advance(SIEGE_FULL_DURATION_MS + 10);
    expect(siege.active).toBe(false);
    expect(host.baseParams.gravity!.y).toBeCloseTo(-1.2, 6);
  });
});

describe('C27 Siege Waves — HP-advance only SHORTENS; Σ ≤ 90 s; OVERLOAD auto-arm runs the table', () => {
  it('HP-advance shortens a wave (advances BEFORE the timer would) and never extends it', () => {
    const { siege, t } = makeSiege({ participants: peers(0), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    expect(siege.waveIndex).toBe(0);
    // Deplete HP past wave-0's threshold well before the 30 s timer.
    t.advance(2_000);
    const maxHp = siege.maxHp;
    // Damage enough to cross wave-0's cumulative-damage fraction (~1/4.5 of maxHp).
    for (let i = 0; i < Math.ceil(maxHp / 3); i++) siege.damage(1);
    // The wave advanced EARLY (HP threshold), well before the 30 s timer.
    expect(siege.waveIndex).toBeGreaterThanOrEqual(1);
    expect(t.now()).toBeLessThan(SIEGE_WAVES[0].durationMs);
  });

  it('the OVERLOAD auto-armed siege (zero-volunteer path) runs the wave table', () => {
    const { siege, t, broadcasts } = makeSiege({ participants: peers(0), initialPhase: 'OVERLOAD' });
    siege.arm({ staffArmed: false }); // OVERLOAD auto-arm → hold(60 s) engages
    expect(siege.active).toBe(true);
    expect(siege.waveIndex).toBe(0);
    // The wave table advances on the timer even with zero volunteers.
    t.advance(SIEGE_WAVES[0].durationMs + 5);
    expect(siege.waveIndex).toBe(1);
    const seen = showpiece(broadcasts, SHOWPIECE_KIND.WAVE).map((b) => (b.payload as { waveIndex: number }).waveIndex);
    expect(seen).toContain(0);
    expect(seen).toContain(1);
  });
});

describe('C27 Siege Waves — unknown-kind-ignore (banner-only degrade rung, §7.16)', () => {
  it('a client that knows only START/STATE/END ignores WAVE and still renders a coherent siege', () => {
    const { siege, t, broadcasts } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    t.advance(SIEGE_WAVES[0].durationMs + 5); // wave 2
    siege.damage(3);
    t.advance(SIEGE_FULL_DURATION_MS + 10); // out

    // A minimal pre-C27 client reducer: it knows only START/STATE/END + MET_LAUNCH
    // and IGNORES any other kind (the if/else dispatch has no throwing default).
    let active = false;
    let hp = -1;
    let sawWave = false;
    let ended = false;
    for (const b of showpiece(broadcasts)) {
      const p = b.payload as { kind: number; hp?: number; waveIndex?: number };
      if (p.kind === SHOWPIECE_KIND.START) active = true;
      else if (p.kind === SHOWPIECE_KIND.STATE) hp = p.hp ?? hp;
      else if (p.kind === SHOWPIECE_KIND.END) {
        active = false;
        ended = true;
      } else if (p.kind === SHOWPIECE_KIND.WAVE) sawWave = true; // (would-be-unknown → ignored)
    }
    // The stream DID carry WAVE broadcasts the old client would not decode…
    expect(sawWave).toBe(true);
    // …yet the coherent siege reads perfectly from START/STATE/END alone.
    expect(ended).toBe(true);
    expect(active).toBe(false);
    expect(hp).toBeGreaterThanOrEqual(0);
    // The BANNER still degrades gracefully: it rides ENV_STATE (mode = wave name),
    // so even a WAVE-blind client shows the wave banner.
    expect(envStates(broadcasts).some((e) => e.mode === SIEGE_WAVES[0].name)).toBe(true);
  });
});

// ===========================================================================
// C27 review fix — MUST-FIX 1: the post-arc (§7.16) coherence hole. Waves sum to
// 82 s but the siege runs 90 s; in the ~8 s tail the arc is complete. A late-join
// / snapshot in that window MUST emit a coherent wave field — never the out-of-
// range `index === SIEGE_WAVES.length` + stale past `waveEndsAt` that rendered a
// phantom "WAVE 4" splash + an expired countdown on EVERY siege (the untested
// window the existing late-join test — which stops at wave index 1 — let through).
// ===========================================================================
describe('C27 Siege Waves — post-arc tail coherence (no phantom WAVE 4)', () => {
  /** Advance the fake clock through the WHOLE wave arc into the post-arc tail. */
  function advanceIntoPostArcTail(t: ReturnType<typeof makeFakeTimers>): void {
    // Cross each wave boundary ONE at a time (the chained wave-advance timer is
    // rescheduled relative to now() when the previous wave starts).
    t.advance(SIEGE_WAVES[0].durationMs + 5); // → wave 2 (index 1)
    t.advance(SIEGE_WAVES[1].durationMs + 5); // → wave 3 (index 2)
    t.advance(SIEGE_WAVES[2].durationMs + 5); // → arc complete (the ~8 s tail)
  }

  it('a late-join in the 82–90 s post-arc tail gets a COHERENT wave field (no index ≥ length, no past waveEndsAt)', () => {
    const { siege, t } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    advanceIntoPostArcTail(t);
    // The arc is done but the siege still runs (82 s < 90 s) — the untested tail.
    expect(siege.active).toBe(true);
    expect(t.now()).toBeGreaterThan(totalWaveDurationMs()); // past the 82 s arc
    expect(t.now()).toBeLessThan(SIEGE_FULL_DURATION_MS); // before the 90 s clock

    const snap = siege.snapshot()!;
    expect(snap.active).toBe(true);
    // COHERENT: the index is the −1 "no active wave" sentinel — NEVER ≥ length.
    expect(snap.waveIndex).toBe(-1);
    expect(snap.waveIndex).toBeLessThan(SIEGE_WAVES.length);
    // COHERENT: no active-but-expired wave (a stale past countdown for a wave that
    // is not running is exactly what rendered the phantom "WAVE 4" splash).
    expect(snap.waveIndex >= 0 && snap.waveEndsAt <= t.now()).toBe(false);

    // The WIRE forward (connection.ts) is bounded to a REAL wave row 0..len−1, so a
    // tail snapshot forwards NO WAVE frame at all — the joiner falls back to the
    // plain siege (the client renders NO phantom splash; see stage.dom.test.ts for
    // the real-reducer render assertion).
    const wouldForwardWave = snap.waveIndex >= 0 && snap.waveIndex < SIEGE_WAVES.length;
    expect(wouldForwardWave).toBe(false);
  });

  it('mid-arc the snapshot STILL lands the live wave (the fix does not regress mid-arc late-join)', () => {
    const { siege, t } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    t.advance(SIEGE_WAVES[0].durationMs + 5); // mid wave 2 (index 1)
    const snap = siege.snapshot()!;
    expect(snap.waveIndex).toBe(1);
    expect(snap.waveEndsAt).toBeGreaterThan(t.now());
    const wouldForwardWave = snap.waveIndex >= 0 && snap.waveIndex < SIEGE_WAVES.length;
    expect(wouldForwardWave).toBe(true); // a live wave IS forwarded
  });
});

// ===========================================================================
// C27 review fix — MUST-FIX 2: the WAVE-3 throttle must be DISTINGUISHABLY tested.
// Every other runtime admission test fires a 40-launch instant → the 12-cap alone
// dominates, so a bug that IGNORES meteorRateMult (fires at full rate, clamped to
// 12) passes them all. This constructs the BELOW-budget-headroom case where the
// ×0.30 throttle is the BINDING constraint, proving admission drops PROPORTIONALLY
// at WAVE 3 end-to-end (through siege.launch, not just the pure admitMeteor unit).
// ===========================================================================
describe('C27 Siege Waves — the WAVE-3 throttle BINDS below the budget headroom', () => {
  it('at WAVE 3 (×0.30) a 20-attempt burst admits ~6 (the mult binds), NOT the 12 the cap would allow', () => {
    const { siege, world, t } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    advanceToWave(t, siege, 2); // reach WAVE 3 (bullet time; mult 0.30, fresh credit)
    expect(siege.waveIndex).toBe(2);

    // Clear the barrage meteors that accumulated during the 70 s advance so the
    // in-flight budget starts EMPTY — the 12-cap has full headroom and can never be
    // the binding constraint for a 20-attempt burst (0.30 × 20 ≈ 6 < 12).
    for (const m of world.shapes.filter((s) => siege.isMeteor(s.id))) world.remove(m.id);
    siege.tick(0); // sync the siege bookkeeping (drops removed shapes from _meteors)
    expect(world.shapes.filter((s) => siege.isMeteor(s.id)).length).toBe(0);

    // Fire 20 attempts from DISTINCT launchers in one instant (each passes the
    // per-launcher rate limit). Full-rate would admit all 20 (capped to 12); the
    // ×0.30 mult admits only ~6.
    for (let i = 0; i < 20; i++) {
      siege.launch(`q${i}`, { origin: { x: 8, y: 2, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    }
    const admitted = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    // The throttle BINDS: ~0.30 × 20 ≈ 6 admitted (deterministic credit accumulator,
    // no RNG; float accumulation lands it at 5). Proportional to the mult — far below
    // the 20 attempts fired.
    expect(admitted).toBeGreaterThanOrEqual(4);
    expect(admitted).toBeLessThanOrEqual(7);
    // …and crucially it is BELOW the 12-cap, so a mult-ignoring bug (which would
    // admit min(20, 12) = 12) is caught — the cap is NOT what's binding here.
    expect(admitted).toBeLessThan(METEOR_BUDGET);
  });
});

// ===========================================================================
// C27 review fix — FOLD-IN: the early-terminate overlay leak. A CROWD_WINS /
// forceEnd mid-wave cancelled the wave-advance timer but left the wave's ENV
// overlay applied for the rest of its durationMs (up to ~11 s of room-wide slow-mo
// AFTER the END card). _terminate now pops the overlay back to the elected base.
// ===========================================================================
describe('C27 Siege Waves — early terminate reverts physics to the elected base immediately', () => {
  it('force-ending mid-WAVE-3 clears the ×0.25 bullet-time overlay at once (no lingering slow-mo)', () => {
    const { siege, host, t } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    host.setBaseParams(ELECTED_LOW_G); // an elected standing law (gravity −1.2, timescale 1)
    siege.arm({ staffArmed: true });
    advanceToWave(t, siege, 2); // WAVE 3 — the ×0.25 bullet-time overlay is live
    expect(siege.waveIndex).toBe(2);
    expect(host.effectiveParams().timescale).toBeCloseTo(SIEGE_WAVE_BULLET_TIMESCALE, 6);

    // Force-end mid-wave (the staff override / CROWD_WINS path). No time advance —
    // the revert must be IMMEDIATE, not wait out the wave overlay's ~11 s durationMs.
    siege.forceEnd();
    expect(siege.active).toBe(false);
    // Physics reverted to the elected base the instant the siege ended: timescale
    // is back to the base 1.0 (NOT the WAVE-3 0.25), and the elected LOW-G gravity
    // still stands underneath (the base law survives the siege end).
    expect(host.effectiveParams().timescale).toBeCloseTo(1, 6);
    expect(host.effectiveParams().gravity!.y).toBeCloseTo(-1.2, 6);
  });

  it('force-ending mid-WAVE-2 clears the wind overlay at once', () => {
    const { siege, host, t } = makeSiege({ participants: peers(4), initialPhase: 'FINALE' });
    siege.arm({ staffArmed: true });
    advanceToWave(t, siege, 1); // WAVE 2 — the wind overlay is live
    expect(siege.waveIndex).toBe(1);
    expect(host.effectiveParams().wind!.x).toBeCloseTo(6, 6); // WAVE 2 wind
    siege.forceEnd();
    // Wind reverted to the base zero immediately (not left blowing after the end card).
    expect(host.effectiveParams().wind!.x).toBeCloseTo(0, 6);
    expect(host.effectiveParams().wind!.z).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// C27 review fix — COMPLETENESS: the in-flight cap must protect the ELECTED-LAW
// case too. The wavesSatisfyBudget invariant estimates flight time under
// DEFAULT_PARAMS gravity; an elected LOW-G base (gravity −1.2 vs |GRAVITY| = 5)
// floats meteors ~4.17× longer, and WAVE 3's ×0.25 slow-mo stacks another ×4 on
// top. Only the RUNTIME 12-cap protects this — prove it holds end-to-end.
// ===========================================================================
describe('C27 Siege Waves — the in-flight cap holds under an elected LOW-G base DURING WAVE 3', () => {
  it('LOW-G × WAVE-3 (real flight ≫ the default-gravity estimate) never exceeds the budget; no crystal pileup', () => {
    const { siege, world, host, t } = makeSiege({ participants: peers(24), initialPhase: 'FINALE' });
    host.setBaseParams(ELECTED_LOW_G); // elected standing law, gravity ≈ −1.2
    siege.arm({ staffArmed: true });
    advanceToWave(t, siege, 2); // WAVE 3 (bullet time)
    expect(siege.waveIndex).toBe(2);
    // effectiveParams = elected −1.2 gravity ⊕ the ×0.25 wave timescale.
    expect(host.effectiveParams().gravity!.y).toBeCloseTo(-1.2, 6);
    expect(host.effectiveParams().timescale).toBeCloseTo(SIEGE_WAVE_BULLET_TIMESCALE, 6);

    const crystalId = siege.crystalId!;
    // Clear the accumulated barrage cloud so we drive the cap ourselves.
    for (const m of world.shapes.filter((s) => siege.isMeteor(s.id))) world.remove(m.id);
    siege.tick(0);

    // Fire a large burst (40 distinct launchers) — the ×0.30 mult + the 12-cap admit
    // up to the budget. Then step the sim under LOW-G × slow-mo for ~6 s; the
    // in-flight count NEVER exceeds the budget at ANY step (no despawn-pop /
    // crystal-pileup), and meteors that reach the crystal are consumed.
    for (let i = 0; i < 40; i++) {
      siege.launch(`q${i}`, { origin: { x: 8, y: 6, z: 0 }, aim: { x: -1, y: 0, z: 0 }, power: 1 });
    }
    let maxInFlight = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
    expect(maxInFlight).toBeLessThanOrEqual(METEOR_BUDGET); // the cap held on the burst
    expect(maxInFlight).toBeGreaterThan(0); // non-vacuous — we actually loaded the cloud

    const dtMs = 1000 / 30;
    for (let k = 0; k < 200 && siege.active; k++) {
      world.step(dtMs / 1000);
      siege.tick(dtMs / 1000);
      t.advance(dtMs);
      const inFlight = world.shapes.filter((s) => siege.isMeteor(s.id)).length;
      maxInFlight = Math.max(maxInFlight, inFlight);
      expect(inFlight).toBeLessThanOrEqual(METEOR_BUDGET); // cap holds EVERY step
    }
    expect(maxInFlight).toBeLessThanOrEqual(METEOR_BUDGET);
    expect(world.shapes.length).toBeLessThanOrEqual(MAX_SHAPES);
    // The pinned crystal is never evicted / piled-over — the in-flight swarm is
    // bounded by the 12-cap the WHOLE time (no despawn-pop from an overflowing
    // cloud), so under LOW-G × slow-mo the meteors linger inside the budget rather
    // than piling up beyond it.
    if (siege.active) expect(world.get(crystalId)).toBeDefined();
  });
});
