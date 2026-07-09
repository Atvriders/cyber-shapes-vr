/**
 * encore.test.ts — Task C19 F12 Supernova Encore (spec §5.3 / §7.13).
 *
 * TDD RED-first (brief Step 1). Deterministic + fake-time throughout: the
 * EncoreHost takes an injected TimerApi + a C3-scheduleAt-shaped scheduler and
 * drives a live ServerWorld through a RoomHandle, exactly like the C16 SiegeHost.
 * No raw setTimeout / Date.now / Math.random anywhere.
 *
 * The load-bearing test is the SYNCHRONIZED DROP: impulse + arp + flash all fire
 * on the SAME server tick at the exact `fireAtServerTime` (via scheduleAt,
 * late = fireNow). The attach-if-landed hooks (`melodySource?`, `themeCut?`) are
 * invoked ONLY when wired; the feature works fully with NEITHER (the no-sibling
 * palette-flash fallback via CROWD_CUE + ENV_STATE).
 */

import { describe, it, expect } from 'vitest';
import {
  OPCODES,
  CROWD_KIND,
  decodeBinary,
  crowdNormalizedCharge,
  createChargeDebounce,
  seededArp,
  chargeToWire,
  ambientCuePhase,
  crowdCueFrame,
  chargeStateFrame,
  CROWD_CUE_EFFECT,
  CHARGE_MIN_TAP_INTERVAL_MS,
  ORB_AUTOLAUNCH_MS,
  DROP_LEAD_MS,
  MAX_SHAPES,
  type TimerApi,
  type TimerHandle,
  type PeerInfo,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { EncoreHost } from '../src/encore.js';

// ---------------------------------------------------------------------------
// Fake timers (canonical shape, copied from siege.test / electionHost.test).
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

function peers(n: number, tier = 'crowd'): PeerInfo[] {
  const out: PeerInfo[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `p${i}`, name: `VOLT-${i}`, color: 0, tier } as unknown as PeerInfo);
  }
  return out;
}

/**
 * Build an EncoreHost over a live world + timeline host, capturing broadcasts.
 * `crowd` = the crowd-tier peers (charge participants); `residents` = the human
 * residents (headset players — the no-headset rung fires when this is empty).
 * `hooks` supplies the OPTIONAL melodySource/themeCut so a test can prove the
 * feature works with NEITHER (default) and that the hooks fire ONLY when wired.
 */
function makeEncore(
  over: {
    crowd?: PeerInfo[];
    residents?: PeerInfo[];
    maxShapes?: number;
    initialPhase?: 'FINALE' | 'PLAY' | 'OVERLOAD';
    melodySource?: (fireAtServerTime: number, seed: number) => void;
    themeCut?: (fireAtServerTime: number) => void;
    metricsCount?: (k: string) => void;
  } = {}
): {
  t: ReturnType<typeof makeFakeTimers>;
  world: ServerWorld;
  host: RoomTimelineHost;
  encore: EncoreHost;
  broadcasts: Broadcast[];
} {
  const t = makeFakeTimers();
  const world = new ServerWorld({
    maxShapes: over.maxShapes ?? MAX_SHAPES,
    idFactory: makeIdFactory('w'),
  });
  const crowd = over.crowd ?? peers(10, 'crowd');
  const residents = over.residents ?? peers(1, 'resident');
  const roster: PeerInfo[] = [...residents, ...crowd];
  const broadcasts: Broadcast[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => roster,
    initialPhase: over.initialPhase ?? 'FINALE',
  });
  const encore = new EncoreHost({
    timer: t.api,
    world,
    handle: host.handle,
    host,
    // roomEpoch 0 → serverNow == timer.now() (fireAt is roomEpoch-relative).
    roomEpoch: 0,
    // offsetMs 0 → the scheduler fires at the absolute fireAt (local == server).
    offsetMs: 0,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    ...(over.melodySource ? { melodySource: over.melodySource } : {}),
    ...(over.themeCut ? { themeCut: over.themeCut } : {}),
    ...(over.metricsCount ? { metricsCount: over.metricsCount } : {}),
  });
  return { t, world, host, encore, broadcasts };
}

/** Decode the CHARGE_STATE frames from a broadcast log (binary 0x2A/CHARGE). */
function chargeStates(broadcasts: Broadcast[]): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  for (const b of broadcasts) {
    if (b.opcode !== OPCODES.CROWD_CUE) continue;
    const d = decodeBinary(b.payload as ArrayBuffer);
    if (d.kind === CROWD_KIND.CHARGE) out.push(d.fields as Record<string, number>);
  }
  return out;
}

/** Decode the CROWD_CUE frames from a broadcast log (binary 0x2A/CUE). */
function crowdCues(broadcasts: Broadcast[]): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  for (const b of broadcasts) {
    if (b.opcode !== OPCODES.CROWD_CUE) continue;
    const d = decodeBinary(b.payload as ArrayBuffer);
    if (d.kind === CROWD_KIND.CUE) out.push(d.fields as Record<string, number>);
  }
  return out;
}

// ===========================================================================
// PURE core — charge normalization / debounce / arp / phase / wire codecs
// ===========================================================================
describe('C19 pure core — charge normalization (§5.3: 5 vs 30 comparable)', () => {
  it('5 phones and 30 phones reach a COMPARABLE normalized charge for proportional taps', () => {
    // A "fully engaged" crowd = every phone taps its per-phone quota. 5 phones and
    // 30 phones both reach ~1.0 when each contributes the same per-phone effort.
    const smallTaps = 5 * 12; // 5 phones × the per-phone quota
    const bigTaps = 30 * 12; // 30 phones × the same per-phone quota
    const small = crowdNormalizedCharge(smallTaps, 5);
    const big = crowdNormalizedCharge(bigTaps, 30);
    expect(small).toBeCloseTo(1, 5);
    expect(big).toBeCloseTo(1, 5);
    expect(Math.abs(small - big)).toBeLessThan(0.05); // comparable — the invariant
  });

  it('is deterministic and clamps to [0,1]', () => {
    expect(crowdNormalizedCharge(0, 10)).toBe(0);
    expect(crowdNormalizedCharge(99999, 5)).toBe(1);
    expect(crowdNormalizedCharge(-5, 5)).toBe(0);
    // Same inputs → same output (no Date/RNG).
    expect(crowdNormalizedCharge(30, 5)).toBe(crowdNormalizedCharge(30, 5));
  });

  it('a solo tester (crowdSize 0/1) can still charge (staff-fire covers empty crowd)', () => {
    expect(crowdNormalizedCharge(12, 0)).toBeGreaterThan(0);
    expect(crowdNormalizedCharge(12, 1)).toBeCloseTo(1, 5);
  });
});

describe('C19 pure core — per-phone tap debounce (≤ 5/s)', () => {
  it('rejects a second tap inside the 200 ms window and accepts after it', () => {
    const d = createChargeDebounce();
    expect(d.accept('p1', 0)).toBe(true);
    expect(d.accept('p1', CHARGE_MIN_TAP_INTERVAL_MS - 1)).toBe(false); // too soon
    expect(d.accept('p1', CHARGE_MIN_TAP_INTERVAL_MS)).toBe(true); // exactly at the window
  });

  it('a phone tapping 20×/s yields ≤ 5 accepted taps in one second (per-phone)', () => {
    const d = createChargeDebounce();
    let accepted = 0;
    for (let ms = 0; ms < 1000; ms += 50) {
      // 20 taps/s
      if (d.accept('flooder', ms)) accepted++;
    }
    expect(accepted).toBeLessThanOrEqual(5);
  });

  it('one phone flooding does NOT starve another phone (per-phone window)', () => {
    const d = createChargeDebounce();
    for (let ms = 0; ms < 1000; ms += 10) d.accept('flooder', ms); // hammer
    // A different phone's first tap is always accepted regardless of the flood.
    expect(d.accept('quiet', 500)).toBe(true);
  });
});

describe('C19 pure core — seeded arp (deterministic drop audio)', () => {
  it('is IDENTICAL for the same seed and DIFFERS across seeds', () => {
    const a1 = seededArp(0xcafef00d);
    const a2 = seededArp(0xcafef00d);
    expect(a1).toEqual(a2); // determinism keystone
    const b = seededArp(0xdeadbeef);
    expect(JSON.stringify(a1)).not.toEqual(JSON.stringify(b));
  });

  it('produces a rising, in-range MIDI run with monotonic offsets', () => {
    const arp = seededArp(1234);
    expect(arp.length).toBeGreaterThan(0);
    for (let i = 0; i < arp.length; i++) {
      expect(arp[i].midi).toBeGreaterThanOrEqual(0);
      expect(arp[i].midi).toBeLessThanOrEqual(127);
      if (i > 0) expect(arp[i].offsetMs).toBeGreaterThan(arp[i - 1].offsetMs);
    }
  });
});

describe('C19 pure core — seeded ambient phase offsets (ripple, not lockstep)', () => {
  it('is a stable 0..1 offset per (seed, peer) and differs across phones', () => {
    const a = ambientCuePhase(42, 'VOLT-1');
    expect(a).toBe(ambientCuePhase(42, 'VOLT-1')); // stable
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(ambientCuePhase(42, 'VOLT-1')).not.toBe(ambientCuePhase(42, 'VOLT-2'));
  });
});

describe('C19 pure core — CROWD_CUE / CHARGE_STATE golden round-trips (Appendix B, C1 codec)', () => {
  it('CROWD_CUE frame round-trips through the C1 codec', () => {
    const buf = crowdCueFrame({
      effect: CROWD_CUE_EFFECT.PALETTE_FLASH,
      colorIndex: 5,
      intensity: 200,
      durationMs: 1200,
      seed: 0xcafef00d,
      fireAtMs: 200000,
    });
    const d = decodeBinary(buf);
    expect(d.opcode).toBe(OPCODES.CROWD_CUE);
    expect(d.kind).toBe(CROWD_KIND.CUE);
    expect(d.fields.effect).toBe(CROWD_CUE_EFFECT.PALETTE_FLASH);
    expect(d.fields.colorIndex).toBe(5);
    expect(d.fields.intensity).toBe(200);
    expect(d.fields.durationMs).toBe(1200);
    expect(d.fields.seed).toBe(0xcafef00d);
    expect(d.fields.fireAtMs).toBe(200000);
    expect(d.fields.reserved).toBe(0);
  });

  it('CHARGE_STATE frame round-trips (charge 0–200 = 0–100 %)', () => {
    const buf = chargeStateFrame({ charge: chargeToWire(0.75), crowdSize: 42, fireAtMs: 300000 });
    const d = decodeBinary(buf);
    expect(d.opcode).toBe(OPCODES.CROWD_CUE);
    expect(d.kind).toBe(CROWD_KIND.CHARGE);
    expect(d.fields.charge).toBe(150); // 0.75 × 200
    expect(d.fields.crowdSize).toBe(42);
    expect(d.fields.fireAtMs).toBe(300000);
    expect(d.fields.reserved).toBe(0);
  });
});

// ===========================================================================
// EncoreHost — arm / charge / prompt / orb / drop
// ===========================================================================
describe('EncoreHost — arm + max-brightness prompt', () => {
  it('arms and broadcasts a max-brightness PROMPT at CHARGE_START, counting a showpiece', () => {
    let showpieceCount = 0;
    const { encore, broadcasts } = makeEncore({ metricsCount: (k) => { if (k === 'showpiece') showpieceCount++; } });
    encore.arm({ staffFired: true });
    expect(encore.active).toBe(true);
    expect(showpieceCount).toBe(1);
    // A CROWD_CUE with the BRIGHTNESS_PROMPT effect went out at CHARGE_START.
    const prompts = crowdCues(broadcasts).filter((c) => c.effect === CROWD_CUE_EFFECT.BRIGHTNESS_PROMPT);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  it('a second arm while active is a no-op', () => {
    const { encore, broadcasts } = makeEncore();
    encore.arm({ staffFired: true });
    const n = broadcasts.length;
    encore.arm({ staffFired: true });
    expect(broadcasts.length).toBe(n);
  });
});

describe('EncoreHost — charge accumulation → CHARGE_STATE + orb spawn', () => {
  it('accumulates debounced taps into a rising normalized CHARGE_STATE', () => {
    const { encore, broadcasts, t } = makeEncore({ crowd: peers(5, 'crowd') });
    encore.arm({ staffFired: true });
    // Each phone taps its quota, spread out so the debounce accepts them all.
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < 5; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS); // clear the debounce window
      encore.publishCharge(); // emit a coalesced CHARGE_STATE
    }
    const states = chargeStates(broadcasts);
    expect(states.length).toBeGreaterThan(0);
    // Charge rose over time (monotonic non-decreasing until 100 %).
    for (let i = 1; i < states.length; i++) {
      expect(states[i].charge).toBeGreaterThanOrEqual(states[i - 1].charge);
    }
    // Reached full.
    expect(states[states.length - 1].charge).toBe(200);
  });

  it('spawns a PINNED orb at 100 % that the store never evicts', () => {
    const { encore, world, t } = makeEncore({ crowd: peers(3, 'crowd'), maxShapes: 8 });
    encore.arm({ staffFired: true });
    // Fully charge (3 phones × 12 taps, spaced to pass the debounce).
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < 3; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    const orbId = encore.orbId;
    expect(orbId).not.toBeNull();
    expect(world.isPinned(orbId!)).toBe(true);
    // Spawn far past the cap — the pinned orb must survive every eviction.
    for (let i = 0; i < 40; i++) {
      world.spawn({ type: 'cube', position: { x: i, y: 1, z: 0 } });
    }
    expect(world.get(orbId!)).toBeDefined();
    expect(world.isPinned(orbId!)).toBe(true);
  });

  it('the pinned orb survives a spawn STORM (§6.4 eviction invariant)', () => {
    const { encore, world, t } = makeEncore({ crowd: peers(2, 'crowd'), maxShapes: 4 });
    encore.arm({ staffFired: true });
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < 2; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    const orbId = encore.orbId!;
    for (let i = 0; i < 200; i++) world.spawn({ type: 'sphere', position: { x: i, y: 2, z: 0 } });
    expect(world.get(orbId)).toBeDefined();
  });
});

// ===========================================================================
// The synchronized DROP — impulse + arp + flash on the SAME server tick
// ===========================================================================
describe('EncoreHost — the drop timeline (impulse + arp + flash SAME tick @ fireAt)', () => {
  function fullyCharge(encore: EncoreHost, t: ReturnType<typeof makeFakeTimers>, n: number): void {
    encore.arm({ staffFired: true });
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < n; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
  }

  it('the orb auto-launches after 10 s if unthrown and schedules the drop', () => {
    const { encore, t } = makeEncore({ crowd: peers(3, 'crowd') });
    fullyCharge(encore, t, 3);
    expect(encore.orbId).not.toBeNull();
    expect(encore.dropScheduled).toBe(false);
    // A small advance — still well before the 10 s auto-launch window.
    t.advance(1_000);
    expect(encore.dropScheduled).toBe(false);
    // Cross well past the auto-launch window → the drop is scheduled (impact was
    // never sent). The auto-launch is measured from the orb spawn, so overshoot.
    t.advance(ORB_AUTOLAUNCH_MS + 500);
    expect(encore.dropScheduled).toBe(true);
  });

  it('fires impulse + arp + flash ALL on the SAME server tick at the exact fireAt', () => {
    // Seed a body so the radial impulse has something to move.
    const { encore, world, broadcasts, t } = makeEncore({ crowd: peers(3, 'crowd') });
    const body = world.spawn({ type: 'cube', position: { x: 3, y: 2, z: 0 } })!.shape;
    fullyCharge(encore, t, 3);
    // First orb impact fires the drop.
    encore.notifyImpact(encore.orbId!);
    expect(encore.dropScheduled).toBe(true);
    const fireAt = encore.dropFireAt!;
    // Nothing has fired yet (the drop waits for the clock-synced fireAt).
    const before = { ...world.get(body.id)!.velocity };
    const cuesBefore = crowdCues(broadcasts).length;
    // Advance to JUST before fireAt — still nothing.
    t.advance(DROP_LEAD_MS - 1);
    expect(world.get(body.id)!.velocity).toEqual(before);
    // Advance onto fireAt — impulse + arp + flash all fire on THIS tick.
    t.advance(1);
    expect(t.now()).toBe(fireAt);
    // 1) impulse — the body's velocity changed.
    expect(world.get(body.id)!.velocity).not.toEqual(before);
    // 2) flash — a PALETTE_FLASH CROWD_CUE went out (fallback climax, no siblings).
    const flashes = crowdCues(broadcasts).filter((c) => c.effect === CROWD_CUE_EFFECT.PALETTE_FLASH);
    expect(flashes.length).toBeGreaterThanOrEqual(1);
    // 3) arp — an arp payload broadcast landed this tick.
    expect(encore.arpFired).toBe(true);
    // All three happened on the SAME server time (the fireAt tick).
    expect(encore.dropFiredAt).toBe(fireAt);
    expect(crowdCues(broadcasts).length).toBeGreaterThan(cuesBefore);
  });

  it('late = fireNow — a drop whose fireAt already passed fires immediately', () => {
    const { encore, world, t } = makeEncore({ crowd: peers(3, 'crowd') });
    const body = world.spawn({ type: 'cube', position: { x: 3, y: 2, z: 0 } })!.shape;
    fullyCharge(encore, t, 3);
    // Simulate a late phone: jump the clock PAST the lead window before impact.
    encore.notifyImpact(encore.orbId!);
    const before = { ...world.get(body.id)!.velocity };
    // A far-future advance — the scheduled callback fires (fireNow semantics).
    t.advance(DROP_LEAD_MS + 5000);
    expect(encore.arpFired).toBe(true);
    expect(world.get(body.id)!.velocity).not.toEqual(before);
  });
});

// ===========================================================================
// Attach-if-landed hooks (OPTIONAL) — theme cut + melody replay
// ===========================================================================
describe('EncoreHost — attach-if-landed hooks are invoked ONLY when wired', () => {
  function fullyChargeAndDrop(encore: EncoreHost, t: ReturnType<typeof makeFakeTimers>, n: number): void {
    encore.arm({ staffFired: true });
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < n; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    encore.notifyImpact(encore.orbId!);
    t.advance(DROP_LEAD_MS + 1);
  }

  it('with NEITHER hook wired the drop still fully fires (no-sibling fallback)', () => {
    const { encore, broadcasts, t } = makeEncore({ crowd: peers(3, 'crowd') });
    fullyChargeAndDrop(encore, t, 3);
    // The fallback climax fired: a PALETTE_FLASH CROWD_CUE + an ENV_STATE went out.
    expect(crowdCues(broadcasts).some((c) => c.effect === CROWD_CUE_EFFECT.PALETTE_FLASH)).toBe(true);
    expect(broadcasts.some((b) => b.opcode === OPCODES.ENV_STATE)).toBe(true);
    expect(encore.arpFired).toBe(true);
  });

  it('invokes themeCut + melodySource EXACTLY when wired, at the drop fireAt', () => {
    let themeAt = -1;
    let melodyAt = -1;
    let melodySeed = -1;
    const { encore, t } = makeEncore({
      crowd: peers(3, 'crowd'),
      themeCut: (fireAt) => { themeAt = fireAt; },
      melodySource: (fireAt, seed) => { melodyAt = fireAt; melodySeed = seed; },
    });
    fullyChargeAndDrop(encore, t, 3);
    expect(themeAt).toBe(encore.dropFireAt);
    expect(melodyAt).toBe(encore.dropFireAt);
    expect(melodySeed).toBe(encore.dropSeed);
  });
});

// ===========================================================================
// Comfort — the flash respects the staff-disable + the ≤ 3 Hz cap
// ===========================================================================
describe('EncoreHost — flash respects the staff-disable (§6.3)', () => {
  function fullyChargeAndDrop(encore: EncoreHost, t: ReturnType<typeof makeFakeTimers>, n: number): void {
    encore.arm({ staffFired: true });
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < n; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    encore.notifyImpact(encore.orbId!);
    t.advance(DROP_LEAD_MS + 1);
  }

  it('when the flash is staff-disabled the drop fires WITHOUT a PALETTE_FLASH', () => {
    const { encore, world, broadcasts, t } = makeEncore({ crowd: peers(3, 'crowd') });
    const body = world.spawn({ type: 'cube', position: { x: 3, y: 2, z: 0 } })!.shape;
    encore.setFlashDisabled(true);
    fullyChargeAndDrop(encore, t, 3);
    // No PALETTE_FLASH went out (comfort staff-disable) …
    expect(crowdCues(broadcasts).some((c) => c.effect === CROWD_CUE_EFFECT.PALETTE_FLASH)).toBe(false);
    // … but the physical drop (impulse + arp) STILL fired (the show goes on).
    expect(encore.arpFired).toBe(true);
    expect(world.get(body.id)!.velocity).not.toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ===========================================================================
// Late-join mid-charge — a joiner gets the coherent charge state
// ===========================================================================
describe('EncoreHost — late-join mid-charge receives the charge state', () => {
  it('snapshot() reports the live charge + crowd size + fireAt (0 until armed)', () => {
    const { encore, t } = makeEncore({ crowd: peers(4, 'crowd') });
    expect(encore.snapshot()).toBeNull(); // no encore yet
    encore.arm({ staffFired: true });
    for (let round = 0; round < 3; round++) {
      for (let p = 0; p < 4; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    const snap = encore.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.charge).toBeGreaterThan(0);
    expect(snap!.charge).toBeLessThan(200); // mid-charge
    expect(snap!.crowdSize).toBeGreaterThan(0);
    expect(snap!.fireAtMs).toBe(0); // not armed for a drop yet
  });
});

// ===========================================================================
// Degrade rungs — no-headset auto-detonate; no-crowd staff-fire
// ===========================================================================
describe('EncoreHost — degrade rungs', () => {
  it('no headset (no human residents) → auto-detonate (drop still delivered)', () => {
    // A crowd-only room with ZERO residents: the orb cannot be thrown, so the
    // encore auto-detonates on the timeline (never stalls without a headset).
    const { encore, t } = makeEncore({ crowd: peers(5, 'crowd'), residents: [] });
    encore.arm({ staffFired: true });
    for (let round = 0; round < 12; round++) {
      for (let p = 0; p < 5; p++) encore.tap(`p${p}`);
      t.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    }
    // Even with no headset to throw the orb, the auto-launch + drop still runs.
    // (First cross the auto-launch window — that SCHEDULES the drop at +700 ms —
    // then advance past the drop lead so the synchronized drop fires.)
    t.advance(ORB_AUTOLAUNCH_MS + 5);
    expect(encore.dropScheduled).toBe(true);
    t.advance(DROP_LEAD_MS + 5);
    expect(encore.arpFired).toBe(true);
  });

  it('no crowd → a staff-fired encore still detonates (empty-crowd rung)', () => {
    const { encore, t } = makeEncore({ crowd: [], residents: peers(1, 'resident') });
    encore.arm({ staffFired: true });
    // No taps at all — staff force the drop directly.
    encore.forceDrop();
    t.advance(DROP_LEAD_MS + 1);
    expect(encore.arpFired).toBe(true);
  });
});

// ===========================================================================
// Cooldown + termination — sequence ≤ 90 s
// ===========================================================================
describe('EncoreHost — cooldown + ≤ 90 s termination', () => {
  it('self-terminates within the 90 s cap and re-arm is refused during cooldown', () => {
    const { encore, t } = makeEncore({ crowd: peers(3, 'crowd') });
    encore.arm({ staffFired: true });
    t.advance(90_000 + 10);
    expect(encore.active).toBe(false);
    // A re-arm during the cooldown window is refused.
    expect(encore.arm({ staffFired: true })).toBe(false);
  });
});
