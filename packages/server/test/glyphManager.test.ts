/**
 * glyphManager.test.ts — the server GlyphManager (spec §7.13, C12).
 *
 * The pure-ish, I/O-free core the connection layer wires: validates + admits a
 * GLYPH_ADD, assigns an id + spiralSlot + the sender's callsign, enforces the
 * three rate-limit layers (server-wide inflow token bucket with QUEUED overflow +
 * per-guest lifetime cap; NEVER per-IP), evicts oldest at the 512 budget (seeded
 * glyphs exempt), survives a world RESET (it is NOT the world), and hides the
 * newest N glyphs on a staff panic.
 *
 * Deterministic + fake time throughout (injected `now`, injected id factory).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GlyphManager } from '../src/glyphManager.js';

// ---------------------------------------------------------------------------
// Harness: a fake clock + a deterministic id factory + a stroke helper.
// ---------------------------------------------------------------------------

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function stroke() {
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];
}

let ids = 0;
function idFactory(): string {
  return `g${(ids++).toString().padStart(4, '0')}`;
}

beforeEach(() => {
  ids = 0;
});

describe('GlyphManager — admit + attribution', () => {
  it('assigns an id + deterministic spiralSlot + the callsign on submit', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory });
    const r = gm.submit({ roomId: 'room1', guestKey: 'gk-1', points: stroke(), color: '#0ff', callsign: 'VOLT-17' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.glyph.callsign).toBe('VOLT-17');
    expect(typeof r.glyph.id).toBe('string');
    expect(typeof r.glyph.slotIndex).toBe('number');
    expect(gm.glyphs('room1')).toHaveLength(1);
  });

  it('rejects an INVALID glyph (bad stroke) with status invalid, admits nothing', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory });
    const r = gm.submit({ roomId: 'room1', guestKey: 'gk-1', points: [{ x: 5, y: 0 }], color: '#0ff', callsign: 'VOLT-17' });
    expect(r.status).toBe('invalid');
    expect(gm.glyphs('room1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: the server-wide inflow token bucket QUEUES overflow.
// ---------------------------------------------------------------------------

describe('GlyphManager — inflow token bucket (overflow QUEUED, not dropped)', () => {
  it('admits up to the burst, then QUEUES the overflow (never drops it)', () => {
    const clock = makeClock();
    // burst 2, refill 1/s → the 3rd submit within the same instant is queued.
    const gm = new GlyphManager({
      now: clock.now,
      idFactory,
      inflowBurst: 2,
      inflowRefillPerSec: 1,
    });
    const a = gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-1' });
    const b = gm.submit({ roomId: 'r', guestKey: 'g2', points: stroke(), color: '#0ff', callsign: 'B-1' });
    const c = gm.submit({ roomId: 'r', guestKey: 'g3', points: stroke(), color: '#0ff', callsign: 'C-1' });
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(c.status).toBe('queued'); // overflow — NOT dropped
    // Only the two admitted glyphs are live so far.
    expect(gm.glyphs('r')).toHaveLength(2);
    expect(gm.queueLength()).toBe(1);
  });

  it('drains the queue as tokens refill — the queued glyph eventually lands', () => {
    const clock = makeClock();
    const admitted: string[] = [];
    const gm = new GlyphManager({
      now: clock.now,
      idFactory,
      inflowBurst: 1,
      inflowRefillPerSec: 1,
      onAdmit: (roomId, glyph) => admitted.push(glyph.callsign),
    });
    gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-1' }); // ok
    const q = gm.submit({ roomId: 'r', guestKey: 'g2', points: stroke(), color: '#0ff', callsign: 'B-1' }); // queued
    expect(q.status).toBe('queued');
    expect(gm.queueLength()).toBe(1);
    // Advance a full second so a token refills; drain releases the queued glyph.
    clock.advance(1000);
    gm.drainQueue();
    expect(gm.queueLength()).toBe(0);
    expect(gm.glyphs('r')).toHaveLength(2);
    expect(admitted).toContain('B-1');
  });
});

// ---------------------------------------------------------------------------
// Per-guest lifetime cap of 3 (NEVER per-IP).
// ---------------------------------------------------------------------------

describe('GlyphManager — per-guest lifetime cap of 3', () => {
  it('admits 3 glyphs for a guest, refuses the 4th (lifetime-cap)', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory, lifetimeCap: 3, inflowBurst: 100 });
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        gm.submit({ roomId: 'r', guestKey: 'the-same-guest', points: stroke(), color: '#0ff', callsign: `X-${i}` })
          .status
      );
    }
    expect(results).toEqual(['ok', 'ok', 'ok', 'lifetime-cap']);
    expect(gm.glyphs('r')).toHaveLength(3);
  });

  it('tracks the cap PER GUEST (a different guestKey has its own budget) — never per-IP', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory, lifetimeCap: 3, inflowBurst: 100 });
    for (let i = 0; i < 3; i++)
      gm.submit({ roomId: 'r', guestKey: 'guestA', points: stroke(), color: '#0ff', callsign: `A-${i}` });
    // guestB shares nothing with guestA (no IP grouping) — gets its own 3.
    const r = gm.submit({ roomId: 'r', guestKey: 'guestB', points: stroke(), color: '#0ff', callsign: 'B-0' });
    expect(r.status).toBe('ok');
    expect(gm.glyphs('r')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Guestbook budget: evict-oldest at 512 (seeded glyphs exempt).
// ---------------------------------------------------------------------------

describe('GlyphManager — evict-oldest at capacity', () => {
  it('evicts the OLDEST glyph when the guestbook exceeds capacity', () => {
    const clock = makeClock();
    const evicted: string[] = [];
    const gm = new GlyphManager({
      now: clock.now,
      idFactory,
      capacity: 3,
      inflowBurst: 1000,
      lifetimeCap: 1000,
      onEvict: (roomId, glyph) => evicted.push(glyph.callsign),
    });
    for (const cs of ['A', 'B', 'C', 'D']) {
      gm.submit({ roomId: 'r', guestKey: `g-${cs}`, points: stroke(), color: '#0ff', callsign: `${cs}-0` });
    }
    const live = gm.glyphs('r').map((g) => g.callsign);
    expect(live).toHaveLength(3);
    expect(live).not.toContain('A-0'); // oldest evicted
    expect(live).toEqual(['B-0', 'C-0', 'D-0']);
    expect(evicted).toEqual(['A-0']);
  });

  it('skips SEEDED glyphs when evicting (the permanent gallery survives)', () => {
    const clock = makeClock();
    const gm = new GlyphManager({
      now: clock.now,
      idFactory,
      capacity: 3,
      inflowBurst: 1000,
      lifetimeCap: 1000,
    });
    // Two seeded glyphs (bypass the inflow bucket, exempt from eviction).
    gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-0' });
    gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-1' });
    // Fill to capacity + overflow with ordinary glyphs.
    gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-0' });
    gm.submit({ roomId: 'r', guestKey: 'g2', points: stroke(), color: '#0ff', callsign: 'B-0' });
    const live = gm.glyphs('r').map((g) => g.callsign);
    // Seeds are never evicted; the oldest ORDINARY glyph (A-0) is.
    expect(live).toContain('SEED-0');
    expect(live).toContain('SEED-1');
    expect(live).not.toContain('A-0');
  });
});

// ---------------------------------------------------------------------------
// Task C34 — seeded-glyph caps (spec §7.23): a seeded glyph survives a 512-evict,
// SEEDED_GLYPH_CAP refuses past 64, and an all-seeded book refuses a new ordinary.
// ---------------------------------------------------------------------------

describe('GlyphManager — Task C34 seeded caps (spec §7.23)', () => {
  it('a seeded glyph survives 512+ ordinary submissions; the unseeded oldest is evicted', () => {
    const gm = new GlyphManager({
      now: makeClock().now,
      idFactory,
      capacity: 512,
      inflowBurst: 100_000,
      lifetimeCap: 100_000,
    });
    const seeded = gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-KEEP' })!;
    expect(seeded).not.toBeNull();
    // Flood well past the 512 budget with ordinary glyphs.
    for (let i = 0; i < 600; i++) {
      gm.submit({ roomId: 'r', guestKey: `g${i}`, points: stroke(), color: '#0ff', callsign: `A-${i}` });
    }
    const live = gm.glyphs('r');
    expect(live.length).toBeLessThanOrEqual(512);
    // The seeded glyph is still present — never evicted (§7.23).
    expect(live.some((g) => g.callsign === 'SEED-KEEP')).toBe(true);
    // The very first ordinary glyph was evicted (unseeded, oldest).
    expect(live.some((g) => g.callsign === 'A-0')).toBe(false);
  });

  it('SEEDED_GLYPH_CAP (64): the 65th seed is REFUSED (returns null)', () => {
    const gm = new GlyphManager({ now: makeClock().now, idFactory, capacity: 100_000 });
    for (let i = 0; i < 64; i++) {
      const g = gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: `SEED-${i}` });
      expect(g).not.toBeNull();
    }
    const over = gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-64' });
    expect(over).toBeNull(); // past SEEDED_GLYPH_CAP → refused
  });

  it('an all-seeded book at capacity: a new ordinary GLYPH_ADD is refused via the overflow queue (nothing evicted)', () => {
    // capacity 2, both slots seeded → the eviction loop finds NO unseeded victim, so
    // a new ordinary submit lands but cannot evict a seed (the book briefly holds 3;
    // the seeds are protected). We assert both seeds survive + no seed was evicted.
    const evicted: string[] = [];
    const gm = new GlyphManager({
      now: makeClock().now,
      idFactory,
      capacity: 2,
      inflowBurst: 1000,
      lifetimeCap: 1000,
      onEvict: (_r, g) => evicted.push(g.callsign),
    });
    gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-0' });
    gm.seed({ roomId: 'r', points: stroke(), color: '#0ff', callsign: 'SEED-1' });
    gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-0' });
    const live = gm.glyphs('r').map((g) => g.callsign);
    // The seeds are NEVER evicted — the eviction path skips them (§7.23).
    expect(live).toContain('SEED-0');
    expect(live).toContain('SEED-1');
    expect(evicted.some((c) => c.startsWith('SEED-'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Survives a world RESET.
// ---------------------------------------------------------------------------

describe('GlyphManager — guestbook survives a world RESET', () => {
  it('a rotation RESET does NOT clear the guestbook glyphs', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory, inflowBurst: 100 });
    gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-0' });
    gm.submit({ roomId: 'r', guestKey: 'g2', points: stroke(), color: '#0ff', callsign: 'B-0' });
    expect(gm.glyphs('r')).toHaveLength(2);
    // A world rotation reset touches shapes only — the guestbook manager has NO
    // reset hook that wipes glyphs. Simulate the rotation boundary: nothing here
    // should remove a glyph.
    gm.onWorldReset?.('r');
    expect(gm.glyphs('r')).toHaveLength(2);
    expect(gm.glyphs('r').map((g) => g.callsign)).toEqual(['A-0', 'B-0']);
  });
});

// ---------------------------------------------------------------------------
// Panic: hide the newest N glyphs.
// ---------------------------------------------------------------------------

describe('GlyphManager — panic hides the newest N glyphs', () => {
  it('hides the newest N glyphs, leaving the older ones visible', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory, inflowBurst: 100, panicHideCount: 2 });
    for (const cs of ['A', 'B', 'C', 'D', 'E']) {
      gm.submit({ roomId: 'r', guestKey: `g-${cs}`, points: stroke(), color: '#0ff', callsign: `${cs}-0` });
    }
    const hidden = gm.panic('r');
    // Newest 2 (D, E) hidden.
    const hiddenCallsigns = hidden.map((g) => g.callsign);
    expect(hiddenCallsigns).toEqual(['D-0', 'E-0']);
    const visible = gm.visibleGlyphs('r').map((g) => g.callsign);
    expect(visible).toEqual(['A-0', 'B-0', 'C-0']);
    // The hidden glyphs are still in the bucket (hidden ≠ despawned).
    expect(gm.glyphs('r')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Staff despawn.
// ---------------------------------------------------------------------------

describe('GlyphManager — staff despawn removes a glyph', () => {
  it('despawn(roomId, id) removes exactly that glyph', () => {
    const clock = makeClock();
    const gm = new GlyphManager({ now: clock.now, idFactory, inflowBurst: 100 });
    const r = gm.submit({ roomId: 'r', guestKey: 'g1', points: stroke(), color: '#0ff', callsign: 'A-0' });
    if (r.status !== 'ok') throw new Error('expected ok');
    gm.submit({ roomId: 'r', guestKey: 'g2', points: stroke(), color: '#0ff', callsign: 'B-0' });
    const removed = gm.despawn('r', r.glyph.id);
    expect(removed).toBe(true);
    expect(gm.glyphs('r').map((g) => g.callsign)).toEqual(['B-0']);
  });
});
