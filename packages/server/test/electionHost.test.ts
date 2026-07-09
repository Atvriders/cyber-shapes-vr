/**
 * electionHost.test.ts — Task C15 SERVER election host (F5 Reality Referendum).
 *
 * The host runs the PURE reducer (shared/elections.ts) on a live room: it accepts
 * VOTE_CAST, coalesces VOTE_TALLY at 2 Hz (never per-vote), and on ENACT does the
 * spec §7.5 sequence — the LEGIBILITY TOP-UP FIRST (auto-fill to 20–30 shapes so
 * the money shot reads), THEN the baseParams write (the elected law). The elected
 * law survives a dial firing (the C11 revert-to-BASE loop) and a staff REVERT
 * restores the PREVIOUS baseParams.
 *
 * All time is fake via an injected TimerApi (no raw setTimeout/Date).
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '@cyber-shapes/shared';
import {
  OPCODES,
  VOTE_KIND,
  DEFAULT_PARAMS,
  mergeParams,
  type PhysicsParams,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import {
  ElectionHost,
  ELECTION_TALLY_HZ_MS,
  ELECTION_LEGIBILITY_FLOOR,
  ELECTION_LEGIBILITY_CEIL,
  ELECTION_FIRST_CHANGE_MAX_MS,
} from '../src/timeline.js';
import { LOW_G_OVERLAY, GRAVITY_FLIP_OVERLAY, BULLET_TIME_OVERLAY } from '../src/dials.js';

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

/** The dial-id → law map (a winning dial's overlay merged over DEFAULT → baseParams). */
const DIAL_LAWS: Record<string, PhysicsParams> = {
  'low-g': mergeParams(DEFAULT_PARAMS, LOW_G_OVERLAY),
  'gravity-flip': mergeParams(DEFAULT_PARAMS, GRAVITY_FLIP_OVERLAY),
  'bullet-time': mergeParams(DEFAULT_PARAMS, BULLET_TIME_OVERLAY),
};

const OPTIONS = ['low-g', 'gravity-flip', 'bullet-time'];

// ---------------------------------------------------------------------------
// Harness — a RoomTimelineHost + an ElectionHost wired over the same world.
// ---------------------------------------------------------------------------

function makeElection(over: { maxShapes?: number; startShapes?: number } = {}) {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? 40,
    idFactory: makeIdFactory('w'),
  });
  // Seed a starting world (below the legibility floor by default so top-up runs).
  const start = over.startShapes ?? 3;
  for (let i = 0; i < start; i++) {
    world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 }, colorIndex: i % 6 });
  }
  const broadcasts: Array<{ opcode: number; payload: unknown; tiers?: readonly string[] }> = [];
  // Spy the ordered event stream: 'spawn' when a top-up shape is created, 'base'
  // when setBaseParams fires — so a test can assert top-up happens BEFORE enact.
  const order: string[] = [];
  // Forward-declared: the `host`'s onWorldReset closure below references
  // `election`, constructed just after `host` — this mirrors the PRODUCTION
  // wiring in connection.ts's `ensureHost` (which does the exact same forward
  // reference via the `h.elections` map). The closure only ever FIRES on a later
  // RESET, well after `election` is assigned, so this is safe.
  let election!: ElectionHost;
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => [],
    setBaseParams: () => void order.push('base'),
    onCueWorldDelta: (spawned) => {
      for (let i = 0; i < spawned.length; i++) order.push('spawn');
    },
    // C22 (carry #5): a RESET clears the election's base-params undo history —
    // the SAME wiring `ensureHost` uses in connection.ts, reproduced here.
    onWorldReset: () => election.clearBaseHistory(),
  });
  election = new ElectionHost({
    timer: t.api,
    handle: host.handle,
    options: OPTIONS,
    dialLaw: (id) => DIAL_LAWS[id],
    readBaseParams: () => host.baseParams,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
  });
  return { t, world, host, election, broadcasts, order };
}

function tallies(broadcasts: Array<{ opcode: number; payload: unknown }>) {
  return broadcasts.filter(
    (b) =>
      b.opcode === OPCODES.VOTE &&
      !!b.payload &&
      typeof b.payload === 'object' &&
      (b.payload as { kind?: number }).kind === VOTE_KIND.TALLY
  );
}

// ===========================================================================
// Enactment: TOP-UP FIRST, THEN baseParams write (the spy-order assertion)
// ===========================================================================

describe('ElectionHost — enactment writes baseParams (legibility top-up FIRST)', () => {
  it('tops up to the legibility floor BEFORE the first param change', () => {
    const { t, world, election, order } = makeElection({ startShapes: 3 });
    election.open(0);

    // A clear winner: low-g 3–1.
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'gravity-flip', 1_300);

    // Reach the deadline → the host tallies, tops up, enacts.
    t.advance(90_000);

    // The world was topped up into the legibility band.
    expect(world.shapes.length).toBeGreaterThanOrEqual(ELECTION_LEGIBILITY_FLOOR);
    expect(world.shapes.length).toBeLessThanOrEqual(ELECTION_LEGIBILITY_CEIL);

    // SPY ORDER: every top-up spawn happens BEFORE the setBaseParams write.
    const firstBase = order.indexOf('base');
    const lastSpawn = order.lastIndexOf('spawn');
    expect(firstBase).toBeGreaterThan(-1);
    expect(lastSpawn).toBeGreaterThan(-1);
    expect(lastSpawn).toBeLessThan(firstBase); // top-up FIRST, then enact
  });

  it('writes the elected law into baseParams (the winner\'s dial law)', () => {
    const { t, host, election } = makeElection();
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    // baseParams is now the low-g law (gravity ~ -1.2, not DEFAULT -5).
    expect(host.baseParams.gravity?.y).toBe(DIAL_LAWS['low-g'].gravity?.y);
    expect(host.baseParams).not.toBe(DEFAULT_PARAMS);
  });

  it('does NOT top up a world already inside the legibility band', () => {
    const { t, world, election } = makeElection({ startShapes: ELECTION_LEGIBILITY_FLOOR + 2 });
    const before = world.shapes.length;
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    // No over-fill: the world stayed at/near its starting size (within the ceil).
    expect(world.shapes.length).toBe(before);
    expect(world.shapes.length).toBeLessThanOrEqual(ELECTION_LEGIBILITY_CEIL);
  });

  it('the first param change lands within the first-change budget after zero', () => {
    const { t, election } = makeElection();
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    // Just cross the deadline. The enact (with its top-up) must complete inside the
    // budget window; we assert it happened by the time the budget elapses.
    t.advance(90_000 + ELECTION_FIRST_CHANGE_MAX_MS);
    expect(election.state.phase).toBe('COOLDOWN');
  });
});

// ===========================================================================
// C11 interaction: a dial fired during a STANDING elected law reverts to the LAW
// ===========================================================================

describe('ElectionHost — C11 revert-to-elected-law', () => {
  it('a dial fired during a standing elected law reverts to the LAW, not DEFAULT', () => {
    const { t, host, election } = makeElection();
    election.open(0);
    // Elect low-g → baseParams = low-g law.
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    const electedGravity = host.baseParams.gravity?.y;
    expect(electedGravity).toBe(DIAL_LAWS['low-g'].gravity?.y);

    // Fire a bullet-time dial overlay (×0.25 timescale) over the elected law.
    host.handle.setCueOverlay(BULLET_TIME_OVERLAY, 12_000, { mode: 'BULLET TIME' });
    expect(host.effectiveParams().timescale).toBe(0.25);
    // The elected gravity law is STILL in the effective params under the overlay.
    expect(host.effectiveParams().gravity?.y).toBe(electedGravity);

    // The overlay auto-reverts — pops back to the ELECTED LAW, never DEFAULT.
    t.advance(12_000);
    expect(host.effectiveParams().timescale).toBe(1); // overlay gone
    expect(host.effectiveParams().gravity?.y).toBe(electedGravity); // law SURVIVES
    expect(host.effectiveParams().gravity?.y).not.toBe(DEFAULT_PARAMS.gravity?.y);
  });
});

// ===========================================================================
// Staff REVERT restores the PREVIOUS baseParams
// ===========================================================================

describe('ElectionHost — staff REVERT/VETO', () => {
  it('REVERT restores the pre-enactment baseParams', () => {
    const { t, host, election } = makeElection();
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    expect(host.baseParams.gravity?.y).toBe(DIAL_LAWS['low-g'].gravity?.y);

    // Staff REVERT → the PREVIOUS baseParams (DEFAULT, since nothing was elected before).
    election.revert();
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
  });

  it('a second REVERT restores the law before that (a one-deep undo stack)', () => {
    const { t, host, election } = makeElection();
    // First election: low-g wins.
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    const lowGY = host.baseParams.gravity?.y;

    // Cooldown ends → a new election opens; gravity-flip wins.
    t.advance(90_000);
    expect(election.state.phase).toBe('OPEN');
    const openAt = t.now();
    election.cast('t1', 'gravity-flip', openAt + 100);
    election.cast('t2', 'gravity-flip', openAt + 200);
    election.cast('t3', 'gravity-flip', openAt + 300);
    election.cast('t4', 'gravity-flip', openAt + 400);
    t.advance(90_000);
    expect(host.baseParams.gravity?.y).toBe(DIAL_LAWS['gravity-flip'].gravity?.y);

    // REVERT → back to the low-g law (the previous baseParams).
    election.revert();
    expect(host.baseParams.gravity?.y).toBe(lowGY);
  });
});

// ===========================================================================
// C22 carry #5 (defensive) — RESET clears the base-params undo history. The
// standing law itself IS cleared on RESET (timeline.ts's _runReset), but the
// `_baseHistory` undo stack was NOT — a future-wired `revert()` (currently
// unwired in production, but exercised directly here) could otherwise restore
// a PRE-RESET law after the rotation boundary.
// ===========================================================================
describe('ElectionHost — RESET clears the base-params undo history (carry #5, defensive)', () => {
  it('after RESET, base-params history is empty (revert() is a no-op)', () => {
    const { t, host, election } = makeElection();
    // First election: low-g wins → history = [DEFAULT_PARAMS].
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    expect(host.baseParams.gravity?.y).toBe(DIAL_LAWS['low-g'].gravity?.y);

    // Second election: gravity-flip wins → history = [DEFAULT_PARAMS, low-g law].
    t.advance(90_000);
    expect(election.state.phase).toBe('OPEN');
    const openAt = t.now();
    election.cast('t1', 'gravity-flip', openAt + 100);
    election.cast('t2', 'gravity-flip', openAt + 200);
    election.cast('t3', 'gravity-flip', openAt + 300);
    election.cast('t4', 'gravity-flip', openAt + 400);
    t.advance(90_000);
    expect(host.baseParams.gravity?.y).toBe(DIAL_LAWS['gravity-flip'].gravity?.y);

    // RESET (the rotation boundary / staff safety override): baseParams reverts
    // to DEFAULT_PARAMS AND (the fix) the undo history is cleared.
    host.forceReset();
    expect(host.baseParams).toBe(DEFAULT_PARAMS);

    // Without the fix, `_baseHistory` would still hold [DEFAULT_PARAMS, low-g
    // law] — a revert() here would WRONGLY pop the low-g law and restore it
    // (observably DIFFERENT from DEFAULT_PARAMS). With the fix, the stack is
    // empty: revert() is an inert no-op and baseParams stays DEFAULT_PARAMS.
    election.revert();
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
  });

  it('RESET after only ONE election also clears the history (revert() stays a no-op)', () => {
    const { t, host, election } = makeElection();
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    expect(host.baseParams).not.toBe(DEFAULT_PARAMS);

    host.forceReset();
    expect(host.baseParams).toBe(DEFAULT_PARAMS);

    // A revert() must not un-RESET the law that stood before the (now-cleared)
    // single enact — it stays a no-op.
    election.revert();
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
  });
});

// ===========================================================================
// VOTE_TALLY cadence: 2 Hz coalesced, NOT per-vote
// ===========================================================================

describe('ElectionHost — VOTE_TALLY 2 Hz (no per-vote broadcast storm)', () => {
  it('does NOT broadcast a tally per vote', () => {
    const { election, broadcasts } = makeElection();
    election.open(0);
    // Cast a flurry of votes WITHOUT advancing time — no per-vote tally fires.
    for (let i = 0; i < 30; i++) election.cast(`t${i}`, 'low-g', 0);
    const perVote = tallies(broadcasts);
    // At most the one opening tally (or none) — never 30.
    expect(perVote.length).toBeLessThanOrEqual(1);
  });

  it('coalesces the tally to a 2 Hz cadence', () => {
    const { t, election, broadcasts } = makeElection();
    election.open(0);
    for (let i = 0; i < 30; i++) election.cast(`t${i}`, 'low-g', 0);
    const before = tallies(broadcasts).length;
    // Advance one tally interval → exactly one coalesced tally.
    t.advance(ELECTION_TALLY_HZ_MS);
    const after1 = tallies(broadcasts).length;
    expect(after1).toBe(before + 1);
    // A clean interval (no new votes) emits NOTHING — no redundant tally spam.
    t.advance(ELECTION_TALLY_HZ_MS);
    expect(tallies(broadcasts).length).toBe(after1);
    // A new vote re-dirties → the next interval emits one more.
    election.cast('late', 'gravity-flip', t.now());
    t.advance(ELECTION_TALLY_HZ_MS);
    expect(tallies(broadcasts).length).toBe(after1 + 1);
  });

  it('a crowd at cap casting ballots tallies correctly (egress stays 2 Hz)', () => {
    const { t, election, broadcasts } = makeElection();
    election.open(0);
    // 40 distinct tokens vote (crowd-at-cap). All for low-g except a few.
    for (let i = 0; i < 40; i++) {
      election.cast(`p${i}`, i < 30 ? 'low-g' : 'gravity-flip', i * 10);
    }
    // No time advanced → no storm.
    expect(tallies(broadcasts).length).toBeLessThanOrEqual(1);
    // One 2 Hz tick → one coalesced tally carrying the correct totals.
    const before = tallies(broadcasts).length;
    t.advance(ELECTION_TALLY_HZ_MS);
    const emitted = tallies(broadcasts);
    expect(emitted.length).toBe(before + 1);
    const last = emitted[emitted.length - 1].payload as {
      tally: Record<string, number>;
    };
    expect(last.tally['low-g']).toBe(30);
    expect(last.tally['gravity-flip']).toBe(10);
  });
});

// ===========================================================================
// One switchable vote per token (through the host)
// ===========================================================================

describe('ElectionHost — one switchable vote per token', () => {
  it('a token may switch its vote; it is never double-counted', () => {
    const { t, election, broadcasts } = makeElection();
    election.open(0);
    election.cast('solo', 'low-g', 0);
    election.cast('solo', 'gravity-flip', 100); // switch
    t.advance(ELECTION_TALLY_HZ_MS);
    const emitted = tallies(broadcasts);
    const last = emitted[emitted.length - 1].payload as {
      tally: Record<string, number>;
      voterCount: number;
    };
    expect(last.tally['low-g']).toBe(0);
    expect(last.tally['gravity-flip']).toBe(1);
    expect(last.voterCount).toBe(1);
  });
});

// ===========================================================================
// Tie → re-open (through the host — no baseParams write on a tie)
// ===========================================================================

describe('ElectionHost — tie re-opens without enacting', () => {
  it('a tie re-opens and never writes baseParams', () => {
    const { t, host, election, order } = makeElection();
    election.open(0);
    election.cast('t1', 'low-g', 0);
    election.cast('t2', 'gravity-flip', 100);
    t.advance(90_000);
    // Tie → re-opened, no law written.
    expect(election.state.phase).toBe('OPEN');
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
    expect(order.includes('base')).toBe(false);
  });
});
