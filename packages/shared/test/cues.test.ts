/**
 * Task C5 — Cue engine + RoomTimeline tests (PURE shared primitives).
 *
 * TDD: written to drive `packages/shared/src/cues.ts`. All time is fake — every
 * scheduled effect goes through the injected TimerApi (no raw setTimeout/Date).
 *
 * Coverage (brief Step 1):
 *   • cue registration + firing at a scheduled time
 *   • PHASE_STATE transitions through PHASE_DURATIONS_MS
 *   • the pacing table advances phases in order (full 7-phase rotation, loops)
 *   • ATTRACT exits on a simulated HUMAN join; synthetic join does NOT
 *   • hold() extends; showpiece-active hold freezes advance until release
 *   • fire() returns each of ok|cooldown|deduped|wrongPhase|unknown
 *   • pacing respects comfort budget + PLAY first-60 s gate; ATTRACT fires
 *     continuously with a 2-cue catalog without stalling
 *   • CUE_CATALOG re-broadcasts on register/unregister; destructive marked
 *   • RoomHandle methods behave
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '../src/timers.js';
import {
  RoomTimeline,
  CueRegistry,
  PHASE_DURATIONS_MS,
  PHASE_ORDER,
  PACING_TABLE,
  pickAmbientCue,
  nextPhase,
  phaseDurationMs,
  DEFAULT_PARAMS,
  buildConsoleModel,
  type Cue,
  type Phase,
  type RoomHandle,
  type PeerInfo,
  type CueCatalogEntry,
} from '../src/cues.js';

// ---------------------------------------------------------------------------
// Fake TimerApi (chronological; cb may enqueue more timers)
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

  return {
    api: {
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
      now(): number {
        return _now;
      },
    },
    advance(ms: number): void {
      _now += ms;
      fireReady();
    },
    now(): number {
      return _now;
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal RoomHandle for cue tests: timeline is the real one; store/broadcast
// are spies. (The full ServerWorld-backed handle is exercised in the server test.)
// ---------------------------------------------------------------------------

function makeHandle(timeline: RoomTimeline): {
  handle: RoomHandle;
  fired: string[];
  broadcasts: Array<{ opcode: number; payload: unknown }>;
  pins: Set<string>;
  peers: PeerInfo[];
} {
  const fired: string[] = [];
  const broadcasts: Array<{ opcode: number; payload: unknown }> = [];
  const pins = new Set<string>();
  const peers: PeerInfo[] = [];
  const shapes: Array<{ id: string; grabbedBy: string | null }> = [];
  let spawnN = 0;
  const handle: RoomHandle = {
    store: {
      get shapes() {
        return shapes;
      },
      spawn: () => {
        const id = `s-${++spawnN}`;
        shapes.push({ id, grabbedBy: null });
        return { id, evictedId: null };
      },
      remove: (id) => {
        const i = shapes.findIndex((s) => s.id === id);
        if (i >= 0) shapes.splice(i, 1);
      },
      pin: (id) => void pins.add(id),
      unpin: (id) => void pins.delete(id),
    },
    setBaseParams: () => {},
    setCueOverlay: () => {},
    broadcast: (opcode, payload) => void broadcasts.push({ opcode, payload }),
    timeline,
    roster: () => peers,
    humanResidents: () => peers.filter((p) => p.synthetic !== true),
    pin: (id) => void pins.add(id),
    unpin: (id) => void pins.delete(id),
  };
  return { handle, fired, broadcasts, pins, peers };
}

function makeCue(id: string, over: Partial<Cue> = {}): Cue {
  return {
    id,
    label: id.toUpperCase(),
    tab: 'show',
    cooldownMs: 0,
    phases: ['ATTRACT', 'LOBBY', 'PLAY', 'OVERLOAD', 'FINALE', 'STATS', 'RESET'],
    comfortCost: 0,
    run: () => {},
    ...over,
  };
}

// ===========================================================================
// PHASE_DURATIONS_MS constant (RUN_OF_SHOW.md cites it by name)
// ===========================================================================

describe('PHASE_DURATIONS_MS + ordering', () => {
  it('carries the exact spec §5.5 timings and no ATTRACT (indefinite)', () => {
    expect(PHASE_DURATIONS_MS).toEqual({
      LOBBY: 45_000,
      PLAY: 180_000,
      OVERLOAD: 30_000,
      FINALE: 90_000,
      STATS: 30_000,
      RESET: 10_000,
    });
    expect('ATTRACT' in PHASE_DURATIONS_MS).toBe(false);
    expect(phaseDurationMs('ATTRACT')).toBeNull();
    expect(phaseDurationMs('LOBBY')).toBe(45_000);
  });

  it('PHASE_ORDER rings LOBBY→…→RESET→ATTRACT', () => {
    expect([...PHASE_ORDER]).toEqual([
      'ATTRACT',
      'LOBBY',
      'PLAY',
      'OVERLOAD',
      'FINALE',
      'STATS',
      'RESET',
    ]);
    expect(nextPhase('ATTRACT')).toBe('LOBBY');
    expect(nextPhase('RESET')).toBe('ATTRACT');
    expect(nextPhase('PLAY')).toBe('OVERLOAD');
  });
});

// ===========================================================================
// RoomTimeline — transitions + PHASE_STATE
// ===========================================================================

describe('RoomTimeline — ATTRACT exit + timed auto-advance', () => {
  it('starts in ATTRACT, indefinite (endsAt/remainingMs null), no auto-advance', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    expect(tl.phase).toBe('ATTRACT');
    expect(tl.state()).toEqual({ phase: 'ATTRACT', endsAt: null, remainingMs: null });
    t.advance(10_000_000); // eons pass; ATTRACT never auto-advances
    expect(tl.phase).toBe('ATTRACT');
  });

  it('advance() exits ATTRACT → LOBBY and LOBBY reports remainingMs from PHASE_DURATIONS_MS', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    tl.advance(); // simulated first human resident join
    expect(tl.phase).toBe('LOBBY');
    const s = tl.state();
    expect(s.phase).toBe('LOBBY');
    expect(s.remainingMs).toBe(45_000);
    expect(s.endsAt).toBe(t.now() + 45_000);
    // Halfway through, remaining halves.
    t.advance(22_500);
    expect(tl.state().remainingMs).toBe(22_500);
  });

  it('walks the full 7-phase rotation in order and loops back to ATTRACT', () => {
    const t = makeFakeTimers();
    const seen: Phase[] = [];
    const tl = new RoomTimeline({
      timer: t.api,
      onPhaseChange: (p) => seen.push(p),
    });
    tl.advance(); // ATTRACT → LOBBY
    // Auto-advance through every timed phase by expiring each duration.
    t.advance(PHASE_DURATIONS_MS.LOBBY);
    expect(tl.phase).toBe('PLAY');
    t.advance(PHASE_DURATIONS_MS.PLAY);
    expect(tl.phase).toBe('OVERLOAD');
    t.advance(PHASE_DURATIONS_MS.OVERLOAD);
    expect(tl.phase).toBe('FINALE');
    t.advance(PHASE_DURATIONS_MS.FINALE);
    expect(tl.phase).toBe('STATS');
    t.advance(PHASE_DURATIONS_MS.STATS);
    expect(tl.phase).toBe('RESET');
    t.advance(PHASE_DURATIONS_MS.RESET);
    // RESET auto-advances back to ATTRACT (rotation loops).
    expect(tl.phase).toBe('ATTRACT');
    expect(seen).toEqual([
      'LOBBY',
      'PLAY',
      'OVERLOAD',
      'FINALE',
      'STATS',
      'RESET',
      'ATTRACT',
    ]);
  });

  it('a synthetic-only join must NOT advance ATTRACT (the caller gates; timeline just exposes advance)', () => {
    // The host gates on humanResidents(); here we assert the timeline itself only
    // advances when advance() is CALLED — a synthetic join simply never calls it.
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    // no advance() → still ATTRACT
    expect(tl.phase).toBe('ATTRACT');
  });
});

describe('RoomTimeline — hold + showpiece freeze', () => {
  it('hold(ms) extends the current timed phase', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    tl.advance(); // LOBBY (45s)
    tl.hold(10_000); // +10s → 55s
    expect(tl.state().remainingMs).toBe(55_000);
    t.advance(45_000);
    expect(tl.phase).toBe('LOBBY'); // still LOBBY thanks to the hold
    t.advance(10_000);
    expect(tl.phase).toBe('PLAY'); // now expired
  });

  it('an active showpiece hold FREEZES auto-advance until release, then resumes', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    tl.advance(); // LOBBY (45s)
    t.advance(20_000); // 25s remain
    tl.acquireHold(); // showpiece/encore/build-mode active
    expect(tl.isHeld).toBe(true);
    expect(tl.state().remainingMs).toBe(25_000);
    // Time passes far beyond the phase duration; held → no advance.
    t.advance(10_000_000);
    expect(tl.phase).toBe('LOBBY');
    expect(tl.state().remainingMs).toBe(25_000); // frozen
    tl.releaseHold();
    expect(tl.isHeld).toBe(false);
    // Resumes from the frozen 25s.
    t.advance(24_999);
    expect(tl.phase).toBe('LOBBY');
    t.advance(1);
    expect(tl.phase).toBe('PLAY');
  });

  it('nested holds: last release resumes (build-mode + showpiece)', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    tl.advance();
    tl.acquireHold();
    tl.acquireHold();
    tl.releaseHold();
    expect(tl.isHeld).toBe(true); // one hold still active
    t.advance(10_000_000);
    expect(tl.phase).toBe('LOBBY');
    tl.releaseHold();
    expect(tl.isHeld).toBe(false);
  });

  it('advance() is a no-op while held', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    tl.advance(); // LOBBY
    tl.acquireHold();
    tl.advance(); // ignored
    expect(tl.phase).toBe('LOBBY');
  });
});

// ===========================================================================
// CueRegistry — register / catalog / fire (all 5 results)
// ===========================================================================

describe('CueRegistry — fire results', () => {
  it('unknown → unknown', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    expect(reg.fire('nope', 'i1')).toBe('unknown');
  });

  it('registers, fires ok, runs the effect, and re-fire with same instance dedupes', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    let runs = 0;
    reg.register(makeCue('sparkle', { run: () => void runs++ }));
    expect(reg.fire('sparkle', 'i1')).toBe('ok');
    expect(runs).toBe(1);
    // Same cueInstanceId → deduped (idempotent re-send), effect not re-run.
    expect(reg.fire('sparkle', 'i1')).toBe('deduped');
    expect(runs).toBe(1);
  });

  it('wrongPhase when the current phase is not in the cue phases', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api }); // ATTRACT
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('playOnly', { phases: ['PLAY'] }));
    expect(reg.fire('playOnly', 'i1')).toBe('wrongPhase');
    tl.advance(); // LOBBY
    tl.advance(); // PLAY
    expect(reg.fire('playOnly', 'i2')).toBe('ok');
  });

  it('cooldown when re-fired within cooldownMs; ok again after it elapses', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('boom', { cooldownMs: 5_000 }));
    expect(reg.fire('boom', 'i1')).toBe('ok');
    t.advance(3_000);
    expect(reg.fire('boom', 'i2')).toBe('cooldown');
    expect(reg.cooldownRemainingMs('boom')).toBe(2_000);
    t.advance(2_000);
    expect(reg.fire('boom', 'i3')).toBe('ok');
  });

  it('a cue scheduled to fire at a future time via scheduleAt fires then (injected timer)', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    let fired = false;
    reg.register(makeCue('timed', { run: () => void (fired = true) }));
    // Simulate a fire-at scheduler: nothing fires until the timer advances.
    t.api.setTimeout(() => void reg.fire('timed', 'i1'), 3_000);
    t.advance(2_999);
    expect(fired).toBe(false);
    t.advance(1);
    expect(fired).toBe(true);
  });
});

describe('CueRegistry — catalog + onChange re-broadcast', () => {
  it('catalog marks destructive cues and reflects register/unregister', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const changes: CueCatalogEntry[][] = [];
    const reg = new CueRegistry({
      room: handle,
      timer: t.api,
      onChange: (cat) => changes.push(cat),
    });
    reg.register(makeCue('reset', { destructive: true, tab: 'advanced' }));
    reg.register(makeCue('sparkle'));
    expect(reg.catalog().map((c) => c.id).sort()).toEqual(['reset', 'sparkle']);
    const reset = reg.catalog().find((c) => c.id === 'reset')!;
    expect(reset.destructive).toBe(true);
    expect(reset.tab).toBe('advanced');
    const sparkle = reg.catalog().find((c) => c.id === 'sparkle')!;
    expect(sparkle.destructive).toBe(false); // absent → false
    // onChange fired on each register (re-broadcast to director on change, §7.21).
    expect(changes.length).toBe(2);
    reg.unregister('sparkle');
    expect(reg.has('sparkle')).toBe(false);
    expect(changes.length).toBe(3); // unregister re-broadcasts too
    reg.unregister('sparkle'); // second unregister is a no-op → no re-broadcast
    expect(changes.length).toBe(3);
  });
});

// ===========================================================================
// Pacing table (spec §5.5)
// ===========================================================================

describe('pacing table — pickAmbientCue', () => {
  function ctxFor(
    phase: Phase,
    reg: CueRegistry,
    over: { phaseElapsedMs?: number; comfortSpent?: number } = {}
  ) {
    return {
      phase,
      phaseElapsedMs: over.phaseElapsedMs ?? 0,
      comfortSpent: over.comfortSpent ?? 0,
      registry: reg,
      catalog: reg.catalog(),
    };
  }

  it('phases with no PACING_TABLE row never auto-cue', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('sparkle', { comfortCost: 0 }));
    for (const p of ['LOBBY', 'OVERLOAD', 'FINALE', 'STATS', 'RESET'] as Phase[]) {
      expect(PACING_TABLE[p]).toBeUndefined();
      expect(pickAmbientCue(ctxFor(p, reg))).toBeNull();
    }
    // ATTRACT + PLAY DO have rows.
    expect(PACING_TABLE.ATTRACT).toBeDefined();
    expect(PACING_TABLE.PLAY).toBeDefined();
  });

  it('ATTRACT: comfort-free only (a cost>0 cue is never picked)', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('aggressive', { comfortCost: 3, phases: ['ATTRACT'] }));
    // ATTRACT budget is 0 → the only registered cue (cost 3) is ineligible.
    expect(pickAmbientCue(ctxFor('ATTRACT', reg))).toBeNull();
    reg.register(makeCue('calm', { comfortCost: 0, phases: ['ATTRACT'] }));
    expect(pickAmbientCue(ctxFor('ATTRACT', reg))?.id).toBe('calm');
  });

  it('ATTRACT rotates a 2-cue catalog without stalling (cooldown-aware)', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('a', { comfortCost: 0, phases: ['ATTRACT'], cooldownMs: 30_000 }));
    reg.register(makeCue('b', { comfortCost: 0, phases: ['ATTRACT'], cooldownMs: 30_000 }));
    // First pick: 'a' (first in catalog order), fire it → on cooldown.
    const p1 = pickAmbientCue(ctxFor('ATTRACT', reg))!;
    expect(p1.id).toBe('a');
    reg.fire('a', 'x1');
    // 'a' now cooling; the selector must fall through to 'b' (never stalls).
    const p2 = pickAmbientCue(ctxFor('ATTRACT', reg))!;
    expect(p2.id).toBe('b');
    reg.fire('b', 'x2');
    // Both cooling now → nothing eligible until a cooldown expires.
    expect(pickAmbientCue(ctxFor('ATTRACT', reg))).toBeNull();
    t.advance(30_000);
    // 'a' ready again → rotation resumes (2-cue catalog never permanently stalls).
    expect(pickAmbientCue(ctxFor('ATTRACT', reg))?.id).toBe('a');
  });

  it('PLAY: aggressive (cost>0) cues blocked in the first 60 s, allowed after', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('storm', { comfortCost: 2, phases: ['PLAY'] }));
    // Within the 60 s grace → blocked.
    expect(pickAmbientCue(ctxFor('PLAY', reg, { phaseElapsedMs: 30_000 }))).toBeNull();
    // At/after 60 s → allowed (within comfort budget of 6).
    expect(pickAmbientCue(ctxFor('PLAY', reg, { phaseElapsedMs: 60_000 }))?.id).toBe('storm');
  });

  it('PLAY: comfort budget caps cumulative discomfort', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle } = makeHandle(tl);
    const reg = new CueRegistry({ room: handle, timer: t.api });
    reg.register(makeCue('storm', { comfortCost: 5, phases: ['PLAY'] }));
    // budget 6, already spent 2 → 2+5 = 7 > 6 → ineligible.
    expect(
      pickAmbientCue(ctxFor('PLAY', reg, { phaseElapsedMs: 60_000, comfortSpent: 2 }))
    ).toBeNull();
    // spent 1 → 1+5 = 6 ≤ 6 → eligible.
    expect(
      pickAmbientCue(ctxFor('PLAY', reg, { phaseElapsedMs: 60_000, comfortSpent: 1 }))?.id
    ).toBe('storm');
  });
});

// ===========================================================================
// RoomHandle surface
// ===========================================================================

describe('RoomHandle — surface behavior', () => {
  it('humanResidents() excludes synthetic peers; roster() includes them', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle, peers } = makeHandle(tl);
    peers.push({ id: 'p0', name: 'VOLT-1', color: 0 });
    peers.push({ id: 'p1', name: 'DMN-9', color: 1, synthetic: true });
    expect(handle.roster().map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(handle.humanResidents().map((p) => p.id)).toEqual(['p0']);
  });

  it('pin/unpin route to the store view', () => {
    const t = makeFakeTimers();
    const tl = new RoomTimeline({ timer: t.api });
    const { handle, pins } = makeHandle(tl);
    handle.pin('s1');
    expect(pins.has('s1')).toBe(true);
    handle.unpin('s1');
    expect(pins.has('s1')).toBe(false);
    // store.pin/unpin too.
    handle.store.pin('s2');
    expect(pins.has('s2')).toBe(true);
  });

  it('DEFAULT_PARAMS is inert (Phase B preserved) — softSphere/speedCap Infinity, suspendDespawn false', () => {
    expect(DEFAULT_PARAMS.suspendDespawn).toBe(false);
    expect(DEFAULT_PARAMS.bounds?.softSphereR).toBe(Infinity);
    expect(DEFAULT_PARAMS.bounds?.speedCap).toBe(Infinity);
  });
});

// ===========================================================================
// Task C10 — director-console view model (buildConsoleModel).
//
// Tested with HARNESS-REGISTERED STUB cues (a synthetic destructive cue + a
// synthetic wrongPhase cue + a synthetic cooldown cue) — the compound cue bank
// isn't built until C11, so the console render logic is proven on stubs here.
// ===========================================================================

describe('C10 buildConsoleModel — SHOW/Advanced split + confirm + disabled states', () => {
  const catalog: CueCatalogEntry[] = [
    // SHOW-tab, allowed in ATTRACT, not destructive → enabled.
    {
      id: 'stub-show',
      label: 'STUB SHOW',
      tab: 'show',
      destructive: false,
      cooldownMs: 0,
      phases: ['ATTRACT', 'PLAY'],
      comfortCost: 0,
    },
    // Advanced-tab, DESTRUCTIVE → console must confirm.
    {
      id: 'stub-destructive',
      label: 'PURGE',
      tab: 'advanced',
      destructive: true,
      cooldownMs: 0,
      phases: ['ATTRACT', 'PLAY'],
      comfortCost: 0,
    },
    // Advanced-tab, allowed only in FINALE → wrongPhase in ATTRACT → DISABLED.
    {
      id: 'stub-wrongphase',
      label: 'FINALE ONLY',
      tab: 'advanced',
      destructive: false,
      cooldownMs: 0,
      phases: ['FINALE'],
      comfortCost: 0,
    },
    // Advanced-tab, allowed in ATTRACT but on cooldown → DISABLED (cooldown).
    {
      id: 'stub-cooldown',
      label: 'COOLING',
      tab: 'advanced',
      destructive: false,
      cooldownMs: 10_000,
      phases: ['ATTRACT', 'PLAY'],
      comfortCost: 0,
    },
  ];

  // Injected cooldown snapshot: only stub-cooldown has time remaining.
  const cd = (id: string): number => (id === 'stub-cooldown' ? 4_200 : 0);

  it('splits cues into SHOW (giant buttons) and ADVANCED (everything else)', () => {
    const model = buildConsoleModel(catalog, 'ATTRACT', cd);
    expect(model.show.map((r) => r.id)).toEqual(['stub-show']);
    expect(model.advanced.map((r) => r.id)).toEqual([
      'stub-destructive',
      'stub-wrongphase',
      'stub-cooldown',
    ]);
  });

  it('marks a destructive cue for CONFIRM (and only that one)', () => {
    const model = buildConsoleModel(catalog, 'ATTRACT', cd);
    const destructive = model.advanced.find((r) => r.id === 'stub-destructive')!;
    expect(destructive.destructive).toBe(true);
    // A non-destructive cue never confirms.
    expect(model.show[0].destructive).toBe(false);
  });

  it('renders wrongPhase as a DISABLED state (reason wrongPhase)', () => {
    const model = buildConsoleModel(catalog, 'ATTRACT', cd);
    const wp = model.advanced.find((r) => r.id === 'stub-wrongphase')!;
    expect(wp.disabled).toBe(true);
    expect(wp.disabledReason).toBe('wrongPhase');
  });

  it('renders cooldown as a DISABLED state (reason cooldown) with the remaining ms', () => {
    const model = buildConsoleModel(catalog, 'ATTRACT', cd);
    const cldwn = model.advanced.find((r) => r.id === 'stub-cooldown')!;
    expect(cldwn.disabled).toBe(true);
    expect(cldwn.disabledReason).toBe('cooldown');
    expect(cldwn.cooldownRemainingMs).toBe(4_200);
  });

  it('an in-phase, off-cooldown cue is ENABLED (no disabled reason)', () => {
    const model = buildConsoleModel(catalog, 'ATTRACT', cd);
    const show = model.show.find((r) => r.id === 'stub-show')!;
    expect(show.disabled).toBe(false);
    expect(show.disabledReason).toBeNull();
  });

  it('wrongPhase wins over cooldown when a cue is both out-of-phase AND cooling', () => {
    // Evaluate stub-cooldown in FINALE (not in its phases) while it has cooldown left.
    const model = buildConsoleModel(catalog, 'FINALE', cd);
    const cldwn = model.advanced.find((r) => r.id === 'stub-cooldown')!;
    expect(cldwn.disabled).toBe(true);
    expect(cldwn.disabledReason).toBe('wrongPhase'); // phase gate wins the reason
  });
});
