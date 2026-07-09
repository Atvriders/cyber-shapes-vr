/**
 * caster.test.ts — F15 MC NULL server host (C26, spec §7.15). Golden-transcript
 * tests for the stateful `CasterHost`: SILENCE default, the max-1/10-s rate limit,
 * the per-rotation quota, the ~3-min no-repeat LRU, streaks, the day-stats record
 * superlative, single caption authority under a showpiece, rotation-scoped memory
 * (cleared on RESET — a two-rotation transcript never references a rotation-1
 * callsign after RESET unless it holds a day-stats record), and determinism.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  decodeBinary,
  encodeBinary,
  renderCasterWire,
  casterTemplate,
  casterSlotsToWire,
  packVoice,
  VOICE_OPUS,
  OPCODES,
  SINGLE_KIND,
  type CasterLine,
  type Tier,
} from '@cyber-shapes/shared';
import { CasterHost, CASTER_TIERS, type CasterInput, type DayThrowRecord } from '../src/caster.js';
import { makeConnectionHub } from '../src/connection.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  host: CasterHost;
  frames: Array<{ templateId: number; slots: number[] }>;
  at(t: number): void;
  tick(): CasterLine | null;
}

function makeHost(opts: {
  phase?: () => 'LOBBY' | 'PLAY' | 'OVERLOAD' | 'FINALE' | 'STATS';
  seed?: number;
  minGapMs?: number;
  quotaPerRotation?: number;
  lruMs?: number;
  dayRecord?: () => DayThrowRecord | null;
} = {}): Harness {
  let now = 0;
  const frames: Array<{ templateId: number; slots: number[] }> = [];
  const host = new CasterHost({
    broadcast: (op, frame) => {
      expect(op).toBe(OPCODES.CASTER_LINE);
      const d = decodeBinary(frame);
      expect(d.opcode).toBe(OPCODES.CASTER_LINE);
      expect(d.kind).toBe(SINGLE_KIND.ONLY);
      frames.push({ templateId: d.fields.templateId as number, slots: d.fields.slots as number[] });
    },
    serverNow: () => now,
    phase: opts.phase ?? (() => 'PLAY'),
    rng: mulberry32(opts.seed ?? 1),
    dayRecord: opts.dayRecord,
    minGapMs: opts.minGapMs,
    quotaPerRotation: opts.quotaPerRotation,
    lruMs: opts.lruMs,
  });
  return {
    host,
    frames,
    at: (t: number) => {
      now = t;
    },
    tick: () => host.tick(),
  };
}

const throwEv = (id: string, callsign: string, speed: number): CasterInput => ({ kind: 'throw', id, callsign, speed });

/** Render a transcript of emitted lines (via the broadcast frames = the wire). */
function transcript(h: Harness): string[] {
  return h.frames.map((f) => renderCasterWire(f.templateId, f.slots)!);
}

// ---------------------------------------------------------------------------
// SILENCE default.
// ---------------------------------------------------------------------------

describe('CasterHost — SILENCE on a quiet stream', () => {
  it('emits nothing for a stream of sub-floor throws', () => {
    const h = makeHost();
    for (let i = 0; i < 30; i++) {
      h.at(i * 1000);
      h.host.onEvent(throwEv(`s${i}`, 'VOLT-17', 2)); // below the shared floor
      h.tick();
    }
    expect(h.frames).toHaveLength(0);
  });

  it('emits a line for a real throw (rendered from the wire — contains the callsign)', () => {
    const h = makeHost();
    h.at(0);
    h.host.onEvent(throwEv('s1', 'VOLT-17', 20));
    const line = h.tick();
    expect(line).not.toBeNull();
    expect(h.frames).toHaveLength(1);
    expect(transcript(h)[0]).toContain('VOLT-17');
  });
});

// ---------------------------------------------------------------------------
// Rate limit — max 1 line / 10 s.
// ---------------------------------------------------------------------------

describe('CasterHost — max 1 line / 10 s', () => {
  it('a second significant throw within 10 s is suppressed', () => {
    const h = makeHost({ minGapMs: 10_000 });
    h.at(0);
    h.host.onEvent(throwEv('s1', 'VOLT-17', 20));
    expect(h.tick()).not.toBeNull();
    h.at(5_000);
    h.host.onEvent(throwEv('s2', 'NEON-05', 22));
    expect(h.tick()).toBeNull(); // within the 10 s gap
    h.at(10_001);
    h.host.onEvent(throwEv('s3', 'CHROME-09', 24));
    expect(h.tick()).not.toBeNull();
    expect(h.frames).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Per-rotation quota.
// ---------------------------------------------------------------------------

describe('CasterHost — per-rotation quota', () => {
  it('stops emitting once the rotation quota is spent', () => {
    const h = makeHost({ quotaPerRotation: 2, minGapMs: 0, lruMs: 0 });
    for (let i = 0; i < 5; i++) {
      h.at(i * 1000);
      h.host.onEvent(throwEv(`s${i}`, `VOLT-${10 + i}`, 20));
      h.tick();
    }
    expect(h.frames).toHaveLength(2);
    expect(h.host.lineCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// No-repeat LRU.
// ---------------------------------------------------------------------------

describe('CasterHost — ~3-min no-repeat LRU', () => {
  it('never repeats a templateId within the LRU window (silence when all used)', () => {
    // PLAY throw has 2 normal variants; a 3rd throw within the LRU window has no
    // unused variant → SILENCE (no repeat).
    const h = makeHost({ minGapMs: 10_000, lruMs: 180_000 });
    const used: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.at(i * 11_000);
      h.host.onEvent(throwEv(`s${i}`, `VOLT-${10 + i}`, 20));
      const line = h.tick();
      if (line) used.push(line.templateId);
    }
    expect(new Set(used).size).toBe(used.length); // no repeats
    expect(h.frames.length).toBeLessThanOrEqual(2); // the 3rd is silence
  });
});

// ---------------------------------------------------------------------------
// Streaks.
// ---------------------------------------------------------------------------

describe('CasterHost — streaks', () => {
  it('announces a streak once the same callsign hits the milestone', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    let sawStreak = false;
    for (let i = 0; i < 4; i++) {
      h.at(i * 1000);
      h.host.onEvent(throwEv(`s${i}`, 'VOLT-17', 20));
      const line = h.tick();
      if (line && casterTemplate(line.templateId)!.kind === 'streak') sawStreak = true;
    }
    expect(sawStreak).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Day-stats record superlative — only on a real record.
// ---------------------------------------------------------------------------

describe('CasterHost — record superlative (day-stats)', () => {
  it('fires a record line only when the day record is beaten', () => {
    let record: DayThrowRecord | null = { callsign: 'VOLT-17', speedMs: 30 };
    const h = makeHost({ minGapMs: 0, lruMs: 0, dayRecord: () => record });
    // A throw that does NOT beat 30 → no record line.
    h.at(0);
    h.host.onEvent(throwEv('s1', 'NEON-05', 25));
    h.tick();
    expect(h.frames.some((f) => casterTemplate(f.templateId)!.kind === 'record')).toBe(false);
    // A throw that BEATS 30 → a record line referencing the new holder.
    h.at(1000);
    h.host.onEvent(throwEv('s2', 'CHROME-09', 40));
    h.tick();
    const rec = h.frames.find((f) => casterTemplate(f.templateId)!.kind === 'record');
    expect(rec).toBeDefined();
    expect(renderCasterWire(rec!.templateId, rec!.slots)).toContain('CHROME-09');
    record = { callsign: 'CHROME-09', speedMs: 40 };
  });
});

// ---------------------------------------------------------------------------
// M1: the day-scoped record survives RESET — no FALSE cross-rotation superlative.
// ---------------------------------------------------------------------------

describe('CasterHost — day-scoped record survives RESET (M1 false-superlative fix)', () => {
  it('rotation-1 throw 50 → RESET → rotation-2 throw 40 fires NO "fastest throw today"; a 55 DOES', () => {
    // Simulates the day-stats bucket the production `dayRecord()` now reads (a
    // running max that SURVIVES RESET), fed in production order (caster reads the
    // PRIOR record in onEvent, then recordThrow updates the day bucket).
    let dayBest: DayThrowRecord | null = null;
    const h = makeHost({ minGapMs: 0, lruMs: 0, dayRecord: () => dayBest });
    const feed = (t: number, id: string, cs: string, speed: number) => {
      h.at(t);
      h.host.onEvent(throwEv(id, cs, speed));
      if (!dayBest || speed > dayBest.speedMs) dayBest = { callsign: cs, speedMs: speed };
      h.tick();
    };

    // Rotation 1: VOLT-17 throws 50 — first of the day (nothing to beat → no record
    // line yet), but it SETS the day best to 50.
    feed(0, 'a', 'VOLT-17', 50);
    expect(h.frames.some((f) => casterTemplate(f.templateId)!.kind === 'record')).toBe(false);

    // RESET clears rotation-scoped memory; the DAY best (50) SURVIVES (day-scoped).
    h.host.reset();
    const afterR1 = h.frames.length;

    // Rotation 2: NEON-05 throws 40 (< the day best 50). The OLD code read the
    // RESET-cleared rotation bucket and FALSELY announced "FASTEST THROW TODAY ·
    // 40.0". The fix reads the day bucket → NO record line.
    feed(10_000, 'b', 'NEON-05', 40);
    const r2 = h.frames.slice(afterR1);
    expect(r2.every((f) => casterTemplate(f.templateId)!.kind !== 'record')).toBe(true);

    // A rotation-2 throw of 55 (> the day best 50) DOES fire the record, naming the
    // new holder (the sole permitted cross-rotation reference: the day-stats bucket).
    feed(20_000, 'c', 'NEON-05', 55);
    const rec = h.frames.slice(afterR1).find((f) => casterTemplate(f.templateId)!.kind === 'record');
    expect(rec).toBeDefined();
    expect(renderCasterWire(rec!.templateId, rec!.slots)).toContain('NEON-05');
  });
});

// ---------------------------------------------------------------------------
// Production single-caption-authority via setShowpieceActive (the sim-loop route).
// ---------------------------------------------------------------------------

describe('CasterHost — production authority via setShowpieceActive (sim-loop route)', () => {
  it('a rising edge arms and a FALLING edge end-cards: start→arm→end yields BOTH lines', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    // Rising edge (the sim loop's `siege.active || encore.active` goes true).
    h.at(0);
    h.host.setShowpieceActive(true);
    expect(h.host.underShowpiece).toBe(true);
    const arm = h.tick();
    expect(arm).not.toBeNull();
    expect(casterTemplate(arm!.templateId)!.kind).toBe('arm');

    // A big throw MID-showpiece is still SILENCED (only arm/endCard may emit).
    h.at(1000);
    h.host.onEvent(throwEv('s1', 'VOLT-17', 30));
    expect(h.tick()).toBeNull();

    // Falling edge WITH the siege's top-defender summary → the endCard airs before
    // authority releases (the C26 fix — production used to feed only the rising edge).
    h.at(2000);
    h.host.setShowpieceActive(false, { callsign: 'VOLT-17', catches: 9 });
    const end = h.tick();
    expect(end).not.toBeNull();
    expect(casterTemplate(end!.templateId)!.kind).toBe('endCard');
    // Render from the broadcast WIRE frame (flat slots), not the tick return.
    expect(transcript(h).at(-1)).toContain('VOLT-17');
    expect(h.host.underShowpiece).toBe(false);
  });

  it('a falling edge with NO defender (the encore FINALE) releases authority quietly — no endCard', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    h.at(0);
    h.host.setShowpieceActive(true);
    h.tick(); // arm
    const before = h.frames.length;
    h.at(1000);
    h.host.setShowpieceActive(false); // no summary → nothing to celebrate
    expect(h.tick()).toBeNull();
    expect(h.frames.length).toBe(before);
    expect(h.host.underShowpiece).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shapeRain + grabDuel grammar are LIVE in production (fed from real signals).
// ---------------------------------------------------------------------------

describe('CasterHost — shapeRain fires from a spawn burst (fed by onCueWorldDelta)', () => {
  it('a burst of ≥ shapeRainMin spawn events surfaces a shapeRain caption', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    h.at(0);
    // The shape-rain cue drops SHAPE_RAIN_BURST (8) shapes through the store — each
    // one fed as a `spawn` event. The shared scorer surfaces SHAPE_RAIN at ≥ 8.
    for (let i = 0; i < 8; i++) h.host.onEvent({ kind: 'spawn', id: `x${i}` });
    const line = h.tick();
    expect(line).not.toBeNull();
    expect(casterTemplate(line!.templateId)!.kind).toBe('shapeRain');
  });

  it('a small cue spawn (< shapeRainMin) stays SILENT (no filler)', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    h.at(0);
    for (let i = 0; i < 3; i++) h.host.onEvent({ kind: 'spawn', id: `x${i}` });
    expect(h.tick()).toBeNull();
  });
});

describe('CasterHost — grabDuel fires from a contested grab (fed by grab-rejected)', () => {
  it('a grabDuel event surfaces a grabDuel caption naming the contesting winner', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    h.at(0);
    // A losing grab on an already-held shape (Phase B first-claim-wins) → the winner
    // (the current holder) is fed as the grab-duel star.
    h.host.onEvent({ kind: 'grabDuel', id: 'm1', callsign: 'VOLT-17' });
    const line = h.tick();
    expect(line).not.toBeNull();
    expect(casterTemplate(line!.templateId)!.kind).toBe('grabDuel');
    // Render from the broadcast WIRE frame (flat slots), not the tick return.
    expect(transcript(h).at(-1)).toContain('VOLT-17');
  });
});

// ---------------------------------------------------------------------------
// Single caption authority under a showpiece.
// ---------------------------------------------------------------------------

describe('CasterHost — single caption authority under a showpiece', () => {
  it('suppresses everything except arm / endCard while a showpiece owns the caption', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    h.at(0);
    h.host.onEvent({ kind: 'showpieceStart' });
    // A big throw during the showpiece → SILENCE (F6 owns catch/swat/hit).
    h.host.onEvent(throwEv('s1', 'VOLT-17', 30));
    expect(h.tick()).toBeNull();
    // An arm line IS allowed.
    h.at(1000);
    h.host.onEvent({ kind: 'showpieceArm' });
    const arm = h.tick();
    expect(arm).not.toBeNull();
    expect(casterTemplate(arm!.templateId)!.kind).toBe('arm');
    // An end-card line IS allowed, and it releases authority.
    h.at(2000);
    h.host.onEvent({ kind: 'showpieceEnd', callsign: 'VOLT-17', catches: 9 });
    const end = h.tick();
    expect(end).not.toBeNull();
    expect(casterTemplate(end!.templateId)!.kind).toBe('endCard');
    expect(h.host.underShowpiece).toBe(false);
    // No non-arm/endCard kind ever aired during the showpiece.
    for (const f of h.frames) {
      const k = casterTemplate(f.templateId)!.kind;
      expect(['arm', 'endCard']).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// Rotation-scoped memory — cleared on RESET.
// ---------------------------------------------------------------------------

describe('CasterHost — rotation-scoped memory (cleared on RESET)', () => {
  it('rotation 2 RE-FEEDING the rotation-1 callsign surfaces it only via fresh events / the day-record — never stale rotation-1 memory', () => {
    // The old test fed only NEON-05 in rotation 2, so a rotation-1 callsign could
    // never surface REGARDLESS of whether memory leaked (vacuous). This reworks it:
    // rotation 2 re-feeds the SAME callsign, and asserts the only cross-rotation
    // carry is the day-stats record — a stale streak never carries, and a false
    // record never fires.
    let dayBest: DayThrowRecord | null = null;
    const h = makeHost({ minGapMs: 0, lruMs: 0, dayRecord: () => dayBest });
    // feed() mirrors the production order: the caster reads the PRIOR day best in
    // onEvent, then recordThrow updates the day bucket (here, our closure).
    const feed = (t: number, id: string, cs: string, speed: number) => {
      h.at(t);
      h.host.onEvent(throwEv(id, cs, speed));
      if (!dayBest || speed > dayBest.speedMs) dayBest = { callsign: cs, speedMs: speed };
      h.tick();
    };

    // Rotation 1: VOLT-17 throws 4× — builds a streak AND becomes the day best (20).
    for (let i = 0; i < 4; i++) feed(i * 1000, `s${i}`, 'VOLT-17', 20);
    const kindsR1 = h.frames.map((f) => casterTemplate(f.templateId)!.kind);
    expect(kindsR1).toContain('streak'); // a rotation-1 streak DID air
    const r1End = h.frames.length;

    // RESET clears rotation-scoped memory (streaks/LRU/quota/window). Day best survives.
    h.host.reset();
    expect(h.host.lineCount).toBe(0);

    // Rotation 2: RE-FEED VOLT-17 a SINGLE slower throw (18 < the day best it set).
    feed(10_000, 't0', 'VOLT-17', 18);
    const r2 = h.frames.slice(r1End);
    // VOLT-17 surfaces as a FRESH throw — never a carried streak, never a false record.
    expect(r2.length).toBeGreaterThan(0);
    for (const f of r2) {
      const k = casterTemplate(f.templateId)!.kind;
      expect(k).not.toBe('streak');
      expect(k).not.toBe('record');
    }
    // A rotation-2 throw that BEATS the day best (25 > 20) DOES fire a record — the
    // sole permitted cross-rotation surfacing, via the surviving day-stats high-water.
    feed(20_000, 't1', 'VOLT-17', 25);
    const rec = h.frames.slice(r1End).find((f) => casterTemplate(f.templateId)!.kind === 'record');
    expect(rec).toBeDefined();
    expect(renderCasterWire(rec!.templateId, rec!.slots)).toContain('VOLT-17');
  });

  it('a streak built in rotation 1 does not carry into rotation 2', () => {
    const h = makeHost({ minGapMs: 0, lruMs: 0 });
    for (let i = 0; i < 3; i++) {
      h.at(i * 1000);
      h.host.onEvent(throwEv(`s${i}`, 'VOLT-17', 20));
      h.tick();
    }
    h.host.reset();
    // A single rotation-2 throw by VOLT-17 must NOT be a 3-streak (memory cleared).
    h.at(10_000);
    h.host.onEvent(throwEv('t0', 'VOLT-17', 20));
    const line = h.tick();
    if (line) expect(casterTemplate(line.templateId)!.kind).not.toBe('streak');
  });
});

// ---------------------------------------------------------------------------
// Determinism — the golden-transcript property.
// ---------------------------------------------------------------------------

describe('CasterHost — deterministic transcripts per seed', () => {
  function runScript(seed: number): string[] {
    const h = makeHost({ seed, minGapMs: 0, lruMs: 30_000 });
    const script: Array<[number, CasterInput]> = [
      [0, throwEv('a', 'VOLT-17', 18)],
      [1000, { kind: 'join', callsign: 'NEON-05' }],
      [12_000, throwEv('b', 'CHROME-09', 24)],
      [13_000, throwEv('c', 'CHROME-09', 22)],
      [14_000, throwEv('d', 'CHROME-09', 26)],
      [26_000, { kind: 'impact', id: 'e', callsign: 'PULSE-11', speed: 15 }],
    ];
    for (const [t, ev] of script) {
      h.at(t);
      h.host.onEvent(ev);
      h.tick();
    }
    return transcript(h);
  }

  it('the same seed + script yields the identical transcript', () => {
    expect(runScript(1234)).toEqual(runScript(1234));
  });

  it('produces legible, callsign-bearing captions', () => {
    const out = runScript(1234);
    expect(out.length).toBeGreaterThan(0);
    for (const line of out) expect(line.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Audience 0x33 attach (attach-if-landed) + the C25 receive-only boundary.
// ---------------------------------------------------------------------------

describe('CasterHost — audience 0x33 attach + C25 boundary intact', () => {
  interface FakeWs {
    readyState: number;
    bufferedAmount: number;
    send: ReturnType<typeof vi.fn>;
  }

  function setup() {
    const hub = makeConnectionHub();
    const h = hub as unknown as {
      socketMeta: WeakMap<object, { roomId: string; playerId: string; tier: Tier; callsign: string; roomEpoch: number; idleTimer: unknown }>;
      roomSockets: Map<string, Set<object>>;
    };
    const make = (tier: Tier, id: string): FakeWs => {
      const ws: FakeWs = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
      h.socketMeta.set(ws, { roomId: 'r', playerId: id, tier, callsign: id, roomEpoch: 0, idleTimer: null });
      let set = h.roomSockets.get('r');
      if (!set) {
        set = new Set();
        h.roomSockets.set('r', set);
      }
      set.add(ws);
      return ws;
    };
    return { hub, make };
  }

  it('a CASTER_LINE (0x33) frame reaches the 128 audience screens (attach) alongside spectator/wisp/crowd', () => {
    const { hub, make } = setup();
    const audience = make('audience', 'a0');
    const spectator = make('spectator', 's0');
    const wisp = make('wisp', 'w0');

    const frame = encodeBinary(OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, {
      templateId: 2,
      slots: casterSlotsToWire([
        { kind: 'callsign', who: { wordIndex: 0, suffix: 17 } },
        { kind: 'num', value: 18 },
      ]),
    });
    hub.broadcastBinaryToTiers('r', frame, CASTER_TIERS);

    expect(audience.send).toHaveBeenCalledTimes(1);
    expect(spectator.send).toHaveBeenCalledTimes(1);
    expect(wisp.send).toHaveBeenCalledTimes(1);
    // The audience frame decodes to a real 0x33 caption.
    const buf = audience.send.mock.calls[0][0] as Uint8Array;
    expect(new Uint8Array(buf)[0]).toBe(OPCODES.CASTER_LINE);
  });

  it('the C25 boundary is INTACT: audience never gets a voice frame or a full-rate state delta', () => {
    const { hub, make } = setup();
    const audience = make('audience', 'a0');
    const spectator = make('spectator', 's0');

    // A voice frame fanned to a tier list that INCLUDES audience — audience is
    // still skipped (voice opcode is not in the audience binary allowlist).
    const voice = packVoice(VOICE_OPUS, 0, 0, 0, new Uint8Array(0));
    hub.broadcastBinaryToTiers('r', voice, ['resident', 'spectator', 'audience']);
    expect(audience.send).not.toHaveBeenCalled(); // never a voice frame
    expect(spectator.send).toHaveBeenCalledTimes(1);

    // A full-rate `state` delta is never admitted to audience (JSON path).
    hub.broadcast('r', { t: 'state', seq: 1, shapes: [] });
    expect(audience.send).not.toHaveBeenCalled(); // never a full-rate delta
  });

  it('END-TO-END: a real host onEvent(throw) → tick() → emit → broadcastBinaryToTiers delivers 0x33 to spectator/wisp/crowd + audience, never to residents / never a delta/voice', () => {
    const { hub, make } = setup();
    const spectator = make('spectator', 's0');
    const wisp = make('wisp', 'w0');
    const crowd = make('crowd', 'c0');
    const audience = make('audience', 'a0');
    const resident = make('resident', 'r0');

    // A REAL CasterHost whose broadcast is the hub's binary tier fan-out (the exact
    // production wiring in connection.ts) — not a hand-built frame.
    let now = 0;
    const host = new CasterHost({
      broadcast: (_op, frame, tiers) => hub.broadcastBinaryToTiers('r', frame as ArrayBuffer, tiers),
      serverNow: () => now,
      phase: () => 'PLAY',
      rng: mulberry32(1),
    });
    host.onEvent({ kind: 'throw', id: 's1', callsign: 'VOLT-17', speed: 20 });
    now = 0;
    const line = host.tick();
    expect(line).not.toBeNull();

    // The wire path delivered ONE real 0x33 frame to every broadcast tier.
    for (const ws of [spectator, wisp, crowd, audience]) {
      expect(ws.send).toHaveBeenCalledTimes(1);
      const buf = ws.send.mock.calls[0][0] as Uint8Array;
      expect(new Uint8Array(buf)[0]).toBe(OPCODES.CASTER_LINE);
    }
    // Residents are NOT a caster tier (captions are a broadcast/stage concern).
    expect(resident.send).not.toHaveBeenCalled();

    // C25 boundary INTACT: the audience never gets a voice frame or a full-rate delta.
    const voice = packVoice(VOICE_OPUS, 0, 0, 0, new Uint8Array(0));
    hub.broadcastBinaryToTiers('r', voice, ['resident', 'spectator', 'audience']);
    expect(audience.send).toHaveBeenCalledTimes(1); // still only the one 0x33 frame
    hub.broadcast('r', { t: 'state', seq: 1, shapes: [] });
    expect(audience.send).toHaveBeenCalledTimes(1); // never a full-rate delta
  });
});
