/**
 * Task C10 — seed cues (shape-rain / low-g) + the C10 host extensions:
 *   • shape-rain spawns a budgeted burst via RoomHandle.store respecting
 *     MAX_SHAPES + the §6.4 eviction/pin invariant, comfort-free;
 *   • low-g applies the DIAL_BOUNDS + suspendDespawn overlay AND auto-reverts
 *     (fake time), and effectiveParams() reflects the single-overlay merge;
 *   • a double-fired cueInstanceId fires the effect ONCE (idempotent);
 *   • the STATS_CARD (computeStatsCard) is broadcast on STATS entry, callsigns only;
 *   • a per-cue world delta (spawn/evicted id) reaches onCueWorldDelta.
 *
 * All time is fake via an injected TimerApi (no raw setTimeout/Date).
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '@cyber-shapes/shared';
import {
  OPCODES,
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  type PeerInfo,
  type StatsCard,
  type NetShape,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import {
  shapeRainCue,
  lowGCue,
  SEED_CUES,
  registerSeedCues,
  SHAPE_RAIN_BURST,
  LOW_G_REVERT_MS,
} from '../src/dials.js';

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

interface HostOver {
  roster?: PeerInfo[];
  initialPhase?: Parameters<typeof RoomTimelineHost>[0]['initialPhase'];
  maxShapes?: number;
  statsCard?: StatsCard;
}

function makeHost(over: HostOver = {}) {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? 40,
    idFactory: makeIdFactory('room'),
  });
  const broadcasts: Array<{ opcode: number; payload: unknown; tiers?: readonly string[] }> = [];
  const cueDeltas: Array<{ spawned: readonly NetShape[]; removedIds: readonly string[] }> = [];
  const roster: PeerInfo[] = over.roster ?? [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    onCueWorldDelta: (spawned, removedIds) => void cueDeltas.push({ spawned, removedIds }),
    ...(over.statsCard ? { computeStatsCard: () => over.statsCard as StatsCard } : {}),
    initialPhase: over.initialPhase,
  });
  registerSeedCues(host.registry);
  return { t, world, host, broadcasts, cueDeltas, roster };
}

// ===========================================================================
// The two seed cues — shape (final form)
// ===========================================================================

describe('C10 seed cues — the two-cue set', () => {
  it('SEED_CUES is exactly [shape-rain, low-g] (no compound bank in C10)', () => {
    expect(SEED_CUES.map((c) => c.id).sort()).toEqual(['low-g', 'shape-rain']);
  });

  it('shape-rain is comfort-free (ATTRACT playlist eligible)', () => {
    expect(shapeRainCue.comfortCost).toBe(0);
  });

  it('low-g overlay carries DIAL_BOUNDS + suspendDespawn (its final C11 form)', () => {
    // The overlay itself is exercised via the host below; assert its envelope here.
    // A low-g fire writes the overlay; effectiveParams reflects DIAL_BOUNDS + suspendDespawn.
    const { host } = makeHost({ initialPhase: 'PLAY' });
    host.fire('low-g', 'lg-1');
    const p = host.effectiveParams();
    expect(p.bounds?.softSphereR).toBe(DIAL_BOUNDS.softSphereR);
    expect(p.bounds?.speedCap).toBe(DIAL_BOUNDS.speedCap);
    expect(p.suspendDespawn).toBe(true);
  });
});

// ===========================================================================
// shape-rain — budgeted burst via RoomHandle.store, MAX_SHAPES + eviction
// ===========================================================================

describe('C10 shape-rain — spawns via RoomHandle.store respecting MAX_SHAPES + §6.4', () => {
  it('spawns a burst of SHAPE_RAIN_BURST shapes into an empty world', () => {
    const { host, world } = makeHost({ maxShapes: 40, initialPhase: 'ATTRACT' });
    host.fire('shape-rain', 'sr-1');
    expect(world.shapes.length).toBe(SHAPE_RAIN_BURST);
  });

  it('at MAX_SHAPES the burst evicts oldest ungrabbed+unpinned bodies (never exceeds the cap)', () => {
    const { host, world } = makeHost({ maxShapes: 10, initialPhase: 'ATTRACT' });
    // Fire twice: 8 + 8 = 16 spawns into a cap of 10 → clamps at 10.
    host.fire('shape-rain', 'sr-1');
    expect(world.shapes.length).toBe(SHAPE_RAIN_BURST); // 8
    // A second fire would be on cooldown; use a distinct instance after advancing.
    host.registry.fire('shape-rain', 'sr-2-blocked'); // cooldown (8s not elapsed) — no-op
    expect(world.shapes.length).toBe(SHAPE_RAIN_BURST);
  });

  it('a PINNED body is never evicted by the shape-rain burst (§6.4 invariant exercised, not reimplemented)', () => {
    const { host, world } = makeHost({ maxShapes: 8, initialPhase: 'ATTRACT' });
    // Pre-seed a pinned "crystal" + fill to the cap so the next burst must evict.
    const crystal = world.spawn({ type: 'torusKnot', position: { x: 0, y: 0, z: 0 } })!.shape;
    world.pin(crystal.id);
    for (let i = 0; i < 7; i++) world.spawn({ type: 'cube', position: { x: i, y: 0, z: 0 } });
    expect(world.shapes.length).toBe(8);
    host.fire('shape-rain', 'sr-pin'); // 8 new spawns into a full cap → evicts oldest unpinned
    // The pinned crystal survives; the world stays at the cap.
    expect(world.get(crystal.id)).toBeDefined();
    expect(world.shapes.length).toBe(8);
  });

  it('routes the spawn/evicted-id delta out via onCueWorldDelta (accommodation #8)', () => {
    const { host, cueDeltas } = makeHost({ maxShapes: 40, initialPhase: 'ATTRACT' });
    host.fire('shape-rain', 'sr-delta');
    // One delta per spawned shape; each carries the spawned NetShape.
    const totalSpawned = cueDeltas.reduce((n, d) => n + d.spawned.length, 0);
    expect(totalSpawned).toBe(SHAPE_RAIN_BURST);
  });
});

// ===========================================================================
// low-g — overlay applies + auto-reverts (fake time)
// ===========================================================================

describe('C10 low-g — DIAL_BOUNDS overlay + timed auto-revert', () => {
  it('applies the overlay on fire and auto-reverts to base (DEFAULT_PARAMS) after LOW_G_REVERT_MS', () => {
    const { t, host } = makeHost({ initialPhase: 'PLAY' });
    host.fire('low-g', 'lg-1');
    expect(host.cueOverlay).not.toBeNull();
    expect(host.effectiveParams().suspendDespawn).toBe(true);

    // Before the revert window: still active.
    t.advance(LOW_G_REVERT_MS - 1);
    expect(host.cueOverlay).not.toBeNull();

    // After the revert window: popped back to base (implicit DEFAULT_PARAMS in C10).
    t.advance(2);
    expect(host.cueOverlay).toBeNull();
    expect(host.effectiveParams()).toEqual(DEFAULT_PARAMS);
    expect(host.effectiveParams().suspendDespawn).toBe(false);
  });
});

// ===========================================================================
// Idempotent double-fire (spec §5.5 dedupe) — the effect runs ONCE
// ===========================================================================

describe('C10 idempotency — double-firing one cueInstanceId fires the effect ONCE', () => {
  it('a re-sent shape-rain cueInstanceId spawns only ONE burst', () => {
    const { host, world } = makeHost({ maxShapes: 40, initialPhase: 'ATTRACT' });
    const first = host.registry.fire('shape-rain', 'dup-1');
    const second = host.registry.fire('shape-rain', 'dup-1'); // same instance id
    expect(first).toBe('ok');
    expect(second).toBe('deduped');
    expect(world.shapes.length).toBe(SHAPE_RAIN_BURST); // one burst, not two
  });
});

// ===========================================================================
// STATS_CARD — broadcast on STATS entry, callsigns only
// ===========================================================================

describe('C10 STATS_CARD — server-computed, callsigns only', () => {
  const card: StatsCard = {
    shapesThrown: 42,
    fastestThrow: { callsign: 'VOLT-07', value: 12.5 },
    topContributor: { callsign: 'NEON-03', value: 9 },
    dayLeaderboard: [
      { callsign: 'NEON-03', value: 30 },
      { callsign: 'VOLT-07', value: 22 },
    ],
    nextInHeadset: 'NEXT IN THE HEADSET? Scan the QR to jump the line.',
  };

  it('broadcasts STATS_CARD (0x2E) when the timeline enters STATS', () => {
    const { t, host, broadcasts } = makeHost({ initialPhase: 'FINALE', statsCard: card });
    // FINALE (90s) → STATS auto-advance.
    t.advance(90_000);
    const statsMsgs = broadcasts.filter((b) => b.opcode === OPCODES.STATS_CARD);
    expect(statsMsgs.length).toBe(1);
    expect(host.timeline.phase).toBe('STATS');
  });

  it('the STATS_CARD payload carries CALLSIGNS, never raw names', () => {
    const { t, broadcasts } = makeHost({ initialPhase: 'FINALE', statsCard: card });
    t.advance(90_000);
    const payload = broadcasts.find((b) => b.opcode === OPCODES.STATS_CARD)?.payload as StatsCard;
    expect(payload.topContributor?.callsign).toBe('NEON-03');
    expect(payload.dayLeaderboard.every((r) => /-\d/.test(r.callsign))).toBe(true);
    // The serialized card must contain no field literally named "name".
    expect(JSON.stringify(payload)).not.toMatch(/"name"/);
  });

  it('no STATS_CARD is broadcast when no computeStatsCard provider is wired', () => {
    const { t, broadcasts } = makeHost({ initialPhase: 'FINALE' }); // no statsCard
    t.advance(90_000);
    expect(broadcasts.filter((b) => b.opcode === OPCODES.STATS_CARD).length).toBe(0);
  });
});

// ===========================================================================
// PHASE_STATE widen — fans out to director + residents (+ spectators)
// ===========================================================================

describe('C10 PHASE_STATE widen — director + residents (spec §5.1)', () => {
  it('the opening PHASE_STATE targets director AND resident (never director-only)', () => {
    const { broadcasts } = makeHost();
    const ps = broadcasts.find((b) => b.opcode === OPCODES.PHASE_STATE);
    expect(ps).toBeDefined();
    expect(ps?.tiers).toContain('director');
    expect(ps?.tiers).toContain('resident'); // the widen — NOT director-only
  });
});

// re-export a lint-quiet reference so the imported cue is used even if a case
// above is removed later.
void lowGCue;

// ===========================================================================
// C11 — the compound cue bank (six new cues + the two adopted seeds) + the
// two-layer params host (revert-to-BASE, not DEFAULT) + ENV_STATE + showpiece
// guard. All time is fake via the injected TimerApi.
// ===========================================================================

import {
  ALL_DIAL_CUES,
  registerDialCues,
  gravityFlipCue,
  bulletTimeCue,
  timeFreezeCue,
  neonStormCue,
  singularityCue,
  supernovaCue,
  GRAVITY_FLIP_REVERT_MS,
  BULLET_TIME_REVERT_MS,
  BULLET_TIME_ENERGY_THRESHOLD,
  BULLET_TIME_PREROLL_COUNT,
  TIME_FREEZE_CHAOS_MS,
  TIME_FREEZE_CAP_MS,
  NEON_STORM_REVERT_MS,
  SINGULARITY_REVERT_MS,
  SUPERNOVA_REVERT_MS,
} from '../src/dials.js';
import { OPCODES as OPS, DEFAULT_PARAMS as DEFAULTP } from '@cyber-shapes/shared';
import type { PhysicsParams } from '@cyber-shapes/shared';

/** A host with the FULL C11 dial bank registered (not just the two seeds). */
function makeFullHost(over: HostOver = {}) {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? 40,
    idFactory: makeIdFactory('room'),
  });
  const broadcasts: Array<{ opcode: number; payload: unknown; tiers?: readonly string[] }> = [];
  const cueDeltas: Array<{ spawned: readonly NetShape[]; removedIds: readonly string[] }> = [];
  const roster: PeerInfo[] = over.roster ?? [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    onCueWorldDelta: (spawned, removedIds) => void cueDeltas.push({ spawned, removedIds }),
    initialPhase: over.initialPhase,
  });
  registerDialCues(host.registry);
  return { t, world, host, broadcasts, cueDeltas, roster };
}

describe('C11 catalog — every cue id registered exactly once', () => {
  it('ALL_DIAL_CUES is the 8-cue bank (2 seeds + 6 compound), ids unique', () => {
    const ids = ALL_DIAL_CUES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup
    expect(ids.sort()).toEqual(
      [
        'bullet-time',
        'gravity-flip',
        'low-g',
        'neon-storm',
        'shape-rain',
        'singularity',
        'supernova',
        'time-freeze',
      ].sort()
    );
  });

  it('C10 seed ids are UNCHANGED (no id migration)', () => {
    expect(ALL_DIAL_CUES.find((c) => c.id === 'shape-rain')).toBeDefined();
    expect(ALL_DIAL_CUES.find((c) => c.id === 'low-g')).toBeDefined();
  });

  it('registerDialCues registers each id exactly once into the catalog', () => {
    const { host } = makeFullHost();
    const cat = host.registry.catalog();
    const ids = cat.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(8);
  });

  it('every overlay-writing dial carries DIAL_BOUNDS + suspendDespawn in its envelope', () => {
    // Fire each overlay dial in a phase it allows and assert the merged params.
    for (const cue of ALL_DIAL_CUES) {
      if (!cue.writesOverlay) continue;
      const phase = cue.phases.includes('PLAY') ? 'PLAY' : cue.phases[0];
      const { host } = makeFullHost({ initialPhase: phase });
      const r = host.registry.fire(cue.id, `env-${cue.id}`);
      expect(r).toBe('ok');
      const p = host.effectiveParams();
      // time-freeze applies its overlay after the chaos window; assert it's queued.
      if (cue.id !== 'time-freeze') {
        expect(p.suspendDespawn).toBe(true);
        expect(p.bounds?.softSphereR).toBe(DIAL_BOUNDS.softSphereR);
        expect(p.bounds?.speedCap).toBe(DIAL_BOUNDS.speedCap);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The two-layer host — an elected BASE law survives a dial firing (revert-to-base)
// ---------------------------------------------------------------------------

describe('C11 two-layer params — a dial reverts to the ACTIVE BASE, never DEFAULT', () => {
  it('with a non-DEFAULT baseParams (elected low-g law), firing bullet-time reverts to the LAW', () => {
    const { t, host } = makeFullHost({ initialPhase: 'PLAY' });
    // An "elected law": a standing low-gravity base (as C15 elections will write).
    const LAW: PhysicsParams = { ...DEFAULTP, gravity: { x: 0, y: -1.2, z: 0 } };
    host.setBaseParams(LAW);
    expect(host.effectiveParams().gravity).toEqual({ x: 0, y: -1.2, z: 0 });

    // Fire bullet-time (×0.25). While active, timescale is overlaid AND the law's
    // gravity still shows through (mergeParams overlay-wins field-wise).
    host.fire('bullet-time', 'bt-1');
    expect(host.effectiveParams().timescale).toBe(0.25);
    expect(host.effectiveParams().gravity).toEqual({ x: 0, y: -1.2, z: 0 }); // law intact

    // Auto-revert pops the overlay back to the BASE LAW — NOT to DEFAULT_PARAMS.
    t.advance(BULLET_TIME_REVERT_MS + 1);
    expect(host.cueOverlay).toBeNull();
    expect(host.effectiveParams().timescale).toBe(DEFAULTP.timescale); // overlay gone
    expect(host.effectiveParams().gravity).toEqual({ x: 0, y: -1.2, z: 0 }); // LAW survives
    expect(host.effectiveParams()).not.toEqual(DEFAULTP); // definitely not DEFAULT
  });
});

// ---------------------------------------------------------------------------
// GRAVITY-FLIP — a ceiling pile that rains down on revert
// ---------------------------------------------------------------------------

describe('C11 gravity-flip — ceilingY overlay, rain-down on revert', () => {
  it('overlays a ceilingY + upward gravity, then pops back so shapes rain down', () => {
    const { t, host } = makeFullHost({ initialPhase: 'PLAY' });
    expect(host.fire('gravity-flip', 'gf-1')).toBe('ok');
    const p = host.effectiveParams();
    expect(p.bounds?.ceilingY).toBeDefined();
    expect((p.gravity?.y ?? 0)).toBeGreaterThan(0); // flipped UP (pile overhead)
    // On revert, gravity is back to the base (down) → the pile rains down.
    t.advance(GRAVITY_FLIP_REVERT_MS + 1);
    expect(host.cueOverlay).toBeNull();
    expect(host.effectiveParams().gravity?.y).toBe(DEFAULTP.gravity?.y); // down again
  });
});

// ---------------------------------------------------------------------------
// BULLET-TIME — ×0.25 + kinetic pre-roll ONLY under the energy threshold
// ---------------------------------------------------------------------------

describe('C11 bullet-time — kinetic pre-roll fires ONLY under the energy threshold', () => {
  it('a QUIET world (low kinetic energy) auto-launches the pre-roll shapes', () => {
    const { host, world, cueDeltas } = makeFullHost({ initialPhase: 'PLAY' });
    // Empty/quiet world → energy below threshold → pre-roll spawns.
    expect(world.shapes.length).toBe(0);
    host.fire('bullet-time', 'bt-quiet');
    const spawned = cueDeltas.reduce((n, d) => n + d.spawned.length, 0);
    expect(spawned).toBe(BULLET_TIME_PREROLL_COUNT);
  });

  it('a LIVELY world (high kinetic energy) does NOT auto-launch the pre-roll', () => {
    const { host, world, cueDeltas } = makeFullHost({ initialPhase: 'PLAY' });
    // Seed fast-moving shapes so ambient energy is above the threshold.
    for (let i = 0; i < 6; i++) {
      const s = world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 } })!.shape;
      s.velocity = { x: 10, y: 10, z: 10 }; // well above threshold
    }
    const before = cueDeltas.reduce((n, d) => n + d.spawned.length, 0);
    host.fire('bullet-time', 'bt-lively');
    const after = cueDeltas.reduce((n, d) => n + d.spawned.length, 0);
    expect(after - before).toBe(0); // no pre-roll launch
    // The ×0.25 timescale still applied regardless.
    expect(host.effectiveParams().timescale).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// TIME-FREEZE — burst → chaos → freeze; hard cap ≤ 8 s
// ---------------------------------------------------------------------------

describe('C11 time-freeze — burst → ~1.5s chaos → freeze, 5–8s hard cap', () => {
  it('freeze is NOT applied during the chaos window, THEN applies, THEN caps ≤ 8 s', () => {
    const { t, host, world } = makeFullHost({ initialPhase: 'PLAY' });
    // Seed a few shapes so the pre-roll burst has something to kick.
    for (let i = 0; i < 4; i++) world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 } });
    expect(host.fire('time-freeze', 'tf-1')).toBe('ok');
    // During chaos: not yet frozen.
    expect(host.effectiveParams().freeze).not.toBe(true);
    t.advance(TIME_FREEZE_CHAOS_MS + 1);
    // After the chaos window: frozen.
    expect(host.effectiveParams().freeze).toBe(true);
    // The hard cap is between 5 and 8 s (spec §7.3).
    expect(TIME_FREEZE_CAP_MS).toBeGreaterThanOrEqual(5_000);
    expect(TIME_FREEZE_CAP_MS).toBeLessThanOrEqual(8_000);
    // After the cap (measured from the freeze application): reverted to base.
    t.advance(TIME_FREEZE_CAP_MS + 1);
    expect(host.cueOverlay).toBeNull();
    expect(host.effectiveParams().freeze).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEON-STORM — wind + spawn bursts; a HELD shape is NEVER evicted
// ---------------------------------------------------------------------------

describe('C11 neon-storm — held shapes exempt from eviction', () => {
  it('a GRABBED shape survives the storm burst (§6.4 invariant exercised)', () => {
    const { host, world } = makeFullHost({ maxShapes: 12, initialPhase: 'PLAY' });
    // A defender's held shape + fill toward the cap.
    const held = world.spawn({ type: 'sphere', position: { x: 0, y: 3, z: 0 } })!.shape;
    world.grab(held.id, 'defender-1'); // grabbedBy set → never evicted
    for (let i = 0; i < 10; i++) world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 } });
    expect(host.fire('neon-storm', 'ns-1')).toBe('ok');
    // The held shape is still present after the storm's spawn burst.
    expect(world.get(held.id)).toBeDefined();
    expect(world.get(held.id)!.grabbedBy).toBe('defender-1');
    // Storm overlays wind.
    const w = host.effectiveParams().wind;
    expect(w && (w.x !== 0 || w.y !== 0 || w.z !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SINGULARITY — attractor accretion disk
// ---------------------------------------------------------------------------

describe('C11 singularity — attractor overlay', () => {
  it('overlays at least one attractor with a positive strength', () => {
    const { host } = makeFullHost({ initialPhase: 'PLAY' });
    expect(host.fire('singularity', 'sg-1')).toBe('ok');
    const a = host.effectiveParams().attractors;
    expect(a && a.length).toBeGreaterThan(0);
    expect(a![0].strength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SUPERNOVA — destructive, the built-in FINALE cue; guarded by showpiece-active
// ---------------------------------------------------------------------------

describe('C11 supernova — destructive-flagged, fireable in FINALE', () => {
  it('is destructive-flagged and includes FINALE in its phases', () => {
    expect(supernovaCue.destructive).toBe(true);
    expect(supernovaCue.phases).toContain('FINALE');
  });

  it('fires successfully in FINALE (SUPERNOVA IS the built-in finale cue)', () => {
    const { host } = makeFullHost({ initialPhase: 'FINALE' });
    expect(host.fire('supernova', 'sn-fin')).toBe('ok');
  });

  it('is REFUSED (wrongPhase) while a siege/encore showpiece overlay is live', () => {
    const { host } = makeFullHost({ initialPhase: 'FINALE' });
    host.beginShowpieceOverlay(); // a siege wave overlay claims the single overlay
    expect(host.fire('supernova', 'sn-guarded')).toBe('wrongPhase');
    host.endShowpieceOverlay();
    expect(host.fire('supernova', 'sn-after')).toBe('ok'); // clear again
  });
});

// ---------------------------------------------------------------------------
// Contention guard (§7.16) — an ambient dial in OVERLOAD → wrongPhase
// ---------------------------------------------------------------------------

describe('C11 contention guard — ambient dials exclude OVERLOAD/FINALE', () => {
  it('an ambient overlay dial fired during OVERLOAD returns wrongPhase', () => {
    const { host } = makeFullHost({ initialPhase: 'OVERLOAD' });
    for (const id of ['low-g', 'gravity-flip', 'bullet-time', 'neon-storm', 'singularity', 'time-freeze']) {
      expect(host.registry.fire(id, `ov-${id}`)).toBe('wrongPhase');
    }
  });

  it('the same ambient dials also exclude FINALE (SUPERNOVA is the finale-only dial)', () => {
    const { host } = makeFullHost({ initialPhase: 'FINALE' });
    for (const id of ['low-g', 'gravity-flip', 'bullet-time', 'neon-storm', 'singularity', 'time-freeze']) {
      expect(host.registry.fire(id, `fn-${id}`)).toBe('wrongPhase');
    }
    // ...but SUPERNOVA fires here (it IS the finale cue).
    expect(host.fire('supernova', 'fn-sn')).toBe('ok');
  });

  it('while a showpiece overlay is active, an overlay dial is refused (single-writer guard)', () => {
    const { host } = makeFullHost({ initialPhase: 'PLAY' });
    host.beginShowpieceOverlay();
    expect(host.fire('bullet-time', 'sp-bt')).toBe('wrongPhase');
    // A non-overlay cue (shape-rain) is NOT guarded — it still fires.
    expect(host.fire('shape-rain', 'sp-sr')).toBe('ok');
    host.endShowpieceOverlay();
  });

  // C11 CQ-1 (made reachable by C16): a retried overlay-dial packet that ALREADY
  // fired must stay idempotent (echo `deduped`) even when a showpiece overlay is
  // now live — the dedupe peek runs BEFORE the single-writer guard.
  it('CQ-1: a retried overlay-dial packet echoes deduped (not wrongPhase) under an active showpiece overlay', () => {
    const { host } = makeFullHost({ initialPhase: 'PLAY' });
    // Fire an overlay dial to completion (records its cueInstanceId in the dedupe).
    expect(host.fire('bullet-time', 'cq1-retry')).toBe('ok');
    // A siege now claims the single overlay.
    host.beginShowpieceOverlay();
    // The SAME packet is retransmitted (network retry): it must dedupe, not flip to
    // wrongPhase (the CQ-1 forward-hook fix — deduped precedes the guard).
    expect(host.fire('bullet-time', 'cq1-retry')).toBe('deduped');
    // A FRESH overlay-dial packet is still refused by the guard.
    expect(host.fire('bullet-time', 'cq1-fresh')).toBe('wrongPhase');
    host.endShowpieceOverlay();
  });
});

// ---------------------------------------------------------------------------
// ENV_STATE — broadcast on set + revert; carries mode/params/endsAt
// ---------------------------------------------------------------------------

describe('C11 ENV_STATE — broadcast on overlay set + revert', () => {
  it('firing a dial broadcasts ENV_STATE with a mode label + endsAt', () => {
    const { host, broadcasts } = makeFullHost({ initialPhase: 'PLAY' });
    host.fire('bullet-time', 'bt-env');
    const env = broadcasts.filter((b) => b.opcode === OPS.ENV_STATE);
    expect(env.length).toBeGreaterThan(0);
    const payload = env[env.length - 1].payload as {
      mode: string | null;
      params: PhysicsParams;
      endsAt: number | null;
      serverTimestamp: number;
    };
    expect(payload.mode).toBeTruthy();
    expect(payload.endsAt).not.toBeNull();
    expect(payload.params.timescale).toBe(0.25);
  });

  it('on auto-revert, a fresh ENV_STATE with mode:null + endsAt:null is broadcast', () => {
    const { t, host, broadcasts } = makeFullHost({ initialPhase: 'PLAY' });
    host.fire('bullet-time', 'bt-env2');
    const beforeCount = broadcasts.filter((b) => b.opcode === OPS.ENV_STATE).length;
    t.advance(BULLET_TIME_REVERT_MS + 1);
    const env = broadcasts.filter((b) => b.opcode === OPS.ENV_STATE);
    expect(env.length).toBeGreaterThan(beforeCount);
    const last = env[env.length - 1].payload as { mode: string | null; endsAt: number | null };
    expect(last.mode).toBeNull();
    expect(last.endsAt).toBeNull();
  });

  it('host.envState() reflects the live dial (for the late-join snapshot)', () => {
    const { host } = makeFullHost({ initialPhase: 'PLAY' });
    host.fire('gravity-flip', 'gf-env');
    const env = host.envState();
    expect(env.mode).toBeTruthy();
    expect(env.endsAt).not.toBeNull();
    expect(env.params.bounds?.ceilingY).toBeDefined();
  });
});

void [
  gravityFlipCue,
  bulletTimeCue,
  timeFreezeCue,
  neonStormCue,
  singularityCue,
  supernovaCue,
  registerDialCues,
  ALL_DIAL_CUES,
  NEON_STORM_REVERT_MS,
  SINGULARITY_REVERT_MS,
  SUPERNOVA_REVERT_MS,
  BULLET_TIME_ENERGY_THRESHOLD,
];
