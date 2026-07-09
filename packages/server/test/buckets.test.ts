/**
 * buckets.test.ts — TDD tests for the persistence buckets (world / guestbook / dayStats).
 *
 * All I/O is injected (fake writeFile/readFile + fake timers) — no real disk,
 * no open handles, no timing flakiness. Mirrors the Phase B persistence.test.ts rigor.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NetShape } from '@cyber-shapes/shared';
import {
  WorldBucket,
  GuestbookBucket,
  DayStatsBucket,
  BUCKET_ID_RE,
} from '../src/buckets.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeShape(id: string): NetShape {
  return {
    id,
    type: 'cube',
    colorIndex: 2,
    renderMode: 'both',
    scale: 1.5,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0.42,
    rotSpeed: { x: 0.1, y: 0.2, z: 0.3 },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

/** Build an in-memory fake fs that records calls. */
function makeFakeFs() {
  const store = new Map<string, string>();
  const writeCalls: Array<{ path: string; data: string }> = [];

  const writeFile = async (path: string, data: string): Promise<void> => {
    writeCalls.push({ path, data });
    store.set(path, data);
  };

  const readFile = async (path: string): Promise<string> => {
    const content = store.get(path);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };

  return { store, writeCalls, writeFile, readFile };
}

// ---------------------------------------------------------------------------
// BUCKET_ID_RE
// ---------------------------------------------------------------------------

describe('BUCKET_ID_RE — path-safety guard', () => {
  it('accepts normal alphanumeric-plus-underscore-hyphen ids up to 64 chars', () => {
    expect(BUCKET_ID_RE.test('room-alpha')).toBe(true);
    expect(BUCKET_ID_RE.test('room_1')).toBe(true);
    expect(BUCKET_ID_RE.test('A'.repeat(64))).toBe(true);
  });

  it('rejects traversal characters, slashes, dots, percent', () => {
    expect(BUCKET_ID_RE.test('../etc')).toBe(false);
    expect(BUCKET_ID_RE.test('room/bad')).toBe(false);
    expect(BUCKET_ID_RE.test('room%20bad')).toBe(false);
    expect(BUCKET_ID_RE.test('')).toBe(false);
    expect(BUCKET_ID_RE.test('A'.repeat(65))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorldBucket — shapes (reset per rotation, validate-on-load, path guard)
// ---------------------------------------------------------------------------

describe('WorldBucket — save → load round-trip', () => {
  it('scheduleSave + flush → load returns exact shape set', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new WorldBucket({ dir: '/data', writeFile, readFile, debounceMs: 2000 });

    const shapes: NetShape[] = [makeShape('roomA:0'), makeShape('roomA:1')];
    bucket.scheduleSave('roomA', shapes);
    await bucket.flush('roomA');

    const loaded = await bucket.load('roomA');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    expect(loaded![0]).toEqual(shapes[0]);
    expect(loaded![1]).toEqual(shapes[1]);
  });
});

describe('WorldBucket — load missing bucket returns null (not throws)', () => {
  it('returns null for a room with no persisted file', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new WorldBucket({ dir: '/data', writeFile, readFile });
    expect(await bucket.load('nonexistent')).toBeNull();
  });
});

describe('WorldBucket — malformed JSON drops safely', () => {
  it('returns null (not throws) for invalid JSON', async () => {
    const store = new Map<string, string>();
    store.set('/data/buckets/world/broken.json', '{ NOT JSON }');
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new WorldBucket({ dir: '/data', writeFile: async () => {}, readFile });
    expect(await bucket.load('broken')).toBeNull();
  });

  it('drops malformed shapes (no NaN ghosts) and returns remaining valid ones', async () => {
    const good = makeShape('room:0');
    const bad = { id: 'room:1', type: 'cube', position: { x: NaN, y: 0, z: 0 } }; // NaN position
    const store = new Map<string, string>();
    store.set('/data/buckets/world/mixed.json', JSON.stringify({ shapes: [good, bad] }));
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new WorldBucket({ dir: '/data', writeFile: async () => {}, readFile });
    const loaded = await bucket.load('mixed');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(1);
    expect(loaded![0].id).toBe('room:0');
  });
});

describe('WorldBucket — debounce coalesces rapid saves', () => {
  afterEach(() => vi.useRealTimers());

  it('N rapid saves within debounceMs produce exactly ONE write of the LATEST snapshot', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new WorldBucket({ dir: '/data', writeFile, readFile, debounceMs: 2000 });

    bucket.scheduleSave('r', [makeShape('r:0')]);
    bucket.scheduleSave('r', [makeShape('r:0'), makeShape('r:1')]);
    bucket.scheduleSave('r', [makeShape('r:0'), makeShape('r:1'), makeShape('r:2')]);

    expect(writeCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeCalls).toHaveLength(1);
    const written = JSON.parse(writeCalls[0].data);
    expect(written.shapes).toHaveLength(3);
    expect(written.shapes[2].id).toBe('r:2');
  });
});

describe('WorldBucket — write error on flush propagates (no silent loss)', () => {
  it('flush() rejects when writeFile throws', async () => {
    const writeFile = async (): Promise<void> => { throw new Error('disk full'); };
    const readFile = async (): Promise<string> => '{}';
    const bucket = new WorldBucket({ dir: '/data', writeFile, readFile });
    bucket.scheduleSave('r', [makeShape('r:0')]);
    await expect(bucket.flush('r')).rejects.toThrow(/disk full/);
  });
});

describe('WorldBucket — path traversal rejected', () => {
  it('load with traversal roomId throws without touching disk', async () => {
    let readAttempted = false;
    const bucket = new WorldBucket({
      dir: '/data',
      writeFile: async () => {},
      readFile: async () => { readAttempted = true; return '{}'; },
    });
    await expect(bucket.load('../../etc/passwd')).rejects.toThrow(/invalid.*id/i);
    expect(readAttempted).toBe(false);
  });

  it('scheduleSave with traversal id throws without scheduling a write', async () => {
    let wrote = false;
    const bucket = new WorldBucket({
      dir: '/data',
      writeFile: async () => { wrote = true; },
      readFile: async () => '{}',
    });
    expect(() => bucket.scheduleSave('../evil', [makeShape('x:0')])).toThrow(/invalid.*id/i);
    await bucket.flush();
    expect(wrote).toBe(false);
  });

  it('accepts normal roomId and writes under <dir>/buckets/world/', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new WorldBucket({ dir: '/data', writeFile, readFile });
    bucket.scheduleSave('good-room_1', [makeShape('good-room_1:0')]);
    await bucket.flush();
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe('/data/buckets/world/good-room_1.json');
  });
});

// ---------------------------------------------------------------------------
// GuestbookBucket — glyphs (never wiped by RESET; validate-on-load)
// ---------------------------------------------------------------------------

interface GlyphEntry {
  id: string;
  callsign: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  slotIndex: number;
  seeded?: boolean;
}

function makeGlyph(id: string, callsign: string): GlyphEntry {
  return { id, callsign, points: [{ x: 0, y: 0 }], color: '#ff00ff', slotIndex: 0 };
}

describe('GuestbookBucket — save → load round-trip', () => {
  it('scheduleSave + flush → load returns exact glyph set', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile, debounceMs: 2000 });

    const glyphs: GlyphEntry[] = [makeGlyph('g:0', 'VOLT-01'), makeGlyph('g:1', 'NEON-02')];
    bucket.scheduleSave('roomA', glyphs);
    await bucket.flush('roomA');

    const loaded = await bucket.load('roomA');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    expect(loaded![0].callsign).toBe('VOLT-01');
    expect(loaded![1].callsign).toBe('NEON-02');
  });
});

describe('GuestbookBucket — load missing bucket returns empty array (default)', () => {
  it('returns empty array (not null, not throws) for a room with no persisted file', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile });
    const result = await bucket.load('nonexistent');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe('GuestbookBucket — malformed JSON drops safely', () => {
  it('returns empty array (not throws) for invalid JSON', async () => {
    const store = new Map<string, string>();
    store.set('/data/buckets/guestbook/broken.json', '{ NOT JSON }');
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new GuestbookBucket({ dir: '/data', writeFile: async () => {}, readFile });
    const result = await bucket.load('broken');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('drops malformed entries and returns remaining valid ones', async () => {
    const good = makeGlyph('g:0', 'VOLT-01');
    const bad = { not: 'a glyph' };
    const store = new Map<string, string>();
    store.set('/data/buckets/guestbook/mixed.json', JSON.stringify({ glyphs: [good, bad] }));
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new GuestbookBucket({ dir: '/data', writeFile: async () => {}, readFile });
    const result = await bucket.load('mixed');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g:0');
  });
});

describe('GuestbookBucket — callsign set readable for uniqueness', () => {
  it('load returns glyphs; getCallsigns() returns the set of attribution callsigns', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile });

    const glyphs: GlyphEntry[] = [
      makeGlyph('g:0', 'VOLT-01'),
      makeGlyph('g:1', 'NEON-02'),
      makeGlyph('g:2', 'VOLT-01'), // same callsign, different glyph (allowed)
    ];
    bucket.scheduleSave('room', glyphs);
    await bucket.flush('room');

    const loaded = await bucket.load('room');
    const callsigns = bucket.getCallsigns('room');
    expect(callsigns.has('VOLT-01')).toBe(true);
    expect(callsigns.has('NEON-02')).toBe(true);
    expect(loaded).toHaveLength(3);
  });
});

describe('GuestbookBucket — debounce + error propagation', () => {
  afterEach(() => vi.useRealTimers());

  it('rapid saves coalesce to ONE write of latest snapshot', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile, debounceMs: 1000 });

    bucket.scheduleSave('r', [makeGlyph('g:0', 'VOLT-01')]);
    bucket.scheduleSave('r', [makeGlyph('g:0', 'VOLT-01'), makeGlyph('g:1', 'NEON-02')]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writeCalls).toHaveLength(1);
    const written = JSON.parse(writeCalls[0].data);
    expect(written.glyphs).toHaveLength(2);
  });

  it('flush() rejects when writeFile throws', async () => {
    const writeFile = async (): Promise<void> => { throw new Error('disk full'); };
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile: async () => '{}' });
    bucket.scheduleSave('r', [makeGlyph('g:0', 'VOLT-01')]);
    await expect(bucket.flush('r')).rejects.toThrow(/disk full/);
  });
});

describe('GuestbookBucket — path traversal rejected', () => {
  it('load with traversal id throws without touching disk', async () => {
    let readAttempted = false;
    const bucket = new GuestbookBucket({
      dir: '/data',
      writeFile: async () => {},
      readFile: async () => { readAttempted = true; return '{}'; },
    });
    await expect(bucket.load('../../etc')).rejects.toThrow(/invalid.*id/i);
    expect(readAttempted).toBe(false);
  });

  it('writes under <dir>/buckets/guestbook/', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new GuestbookBucket({ dir: '/data', writeFile, readFile });
    bucket.scheduleSave('myroom', [makeGlyph('g:0', 'VOLT-01')]);
    await bucket.flush();
    expect(writeCalls[0].path).toBe('/data/buckets/guestbook/myroom.json');
  });
});

// ---------------------------------------------------------------------------
// DayStatsBucket — leaderboard/metrics + callsign taken set (per-day, wiped at day close)
// ---------------------------------------------------------------------------

interface DayStats {
  date: string;                 // YYYY-MM-DD
  callsignsTaken: string[];     // for uniqueness extension
  fastestThrow?: { callsign: string; speedMs: number };
  topContributor?: { callsign: string; count: number };
  rotations: number;
}

function makeDayStats(date = '2026-07-01'): DayStats {
  return { date, callsignsTaken: ['VOLT-01', 'NEON-02'], rotations: 3 };
}

describe('DayStatsBucket — save → load round-trip', () => {
  it('scheduleSave + flush → load returns exact stats', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile, debounceMs: 2000 });

    const stats = makeDayStats();
    bucket.scheduleSave('roomA', stats);
    await bucket.flush('roomA');

    const loaded = await bucket.load('roomA');
    expect(loaded).not.toBeNull();
    expect(loaded!.date).toBe('2026-07-01');
    expect(loaded!.rotations).toBe(3);
    expect(loaded!.callsignsTaken).toEqual(['VOLT-01', 'NEON-02']);
  });
});

describe('DayStatsBucket — load missing bucket returns null (not throws)', () => {
  it('returns null for a room with no persisted stats file', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile });
    expect(await bucket.load('nonexistent')).toBeNull();
  });
});

describe('DayStatsBucket — malformed JSON drops safely (no NaN, no throws)', () => {
  it('returns null (not throws) for invalid JSON', async () => {
    const store = new Map<string, string>();
    store.set('/data/buckets/dayStats/broken.json', '{ NOT JSON }');
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new DayStatsBucket({ dir: '/data', writeFile: async () => {}, readFile });
    expect(await bucket.load('broken')).toBeNull();
  });

  it('returns null when JSON is valid but missing required date field', async () => {
    const store = new Map<string, string>();
    store.set('/data/buckets/dayStats/nodate.json', JSON.stringify({ rotations: 5 }));
    const readFile = async (path: string) => {
      const c = store.get(path);
      if (!c) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    };
    const bucket = new DayStatsBucket({ dir: '/data', writeFile: async () => {}, readFile });
    expect(await bucket.load('nodate')).toBeNull();
  });
});

describe('DayStatsBucket — callsign taken set persists and is readable for uniqueness', () => {
  it('getCallsignsTaken returns the set after load', async () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile });

    const stats: DayStats = {
      date: '2026-07-01',
      callsignsTaken: ['VOLT-01', 'NEON-02', 'CHROME-33'],
      rotations: 2,
    };
    bucket.scheduleSave('room', stats);
    await bucket.flush('room');
    await bucket.load('room');

    const taken = bucket.getCallsignsTaken('room');
    expect(taken.has('VOLT-01')).toBe(true);
    expect(taken.has('NEON-02')).toBe(true);
    expect(taken.has('CHROME-33')).toBe(true);
    expect(taken.has('UNKNOWN-99')).toBe(false);
  });

  it('getCallsignsTaken returns empty set for a never-loaded room', () => {
    const { writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile });
    const taken = bucket.getCallsignsTaken('fresh-room');
    expect(taken.size).toBe(0);
  });
});

describe('DayStatsBucket — debounce coalesces rapid saves', () => {
  afterEach(() => vi.useRealTimers());

  it('rapid saves coalesce to ONE write of the LATEST snapshot', async () => {
    vi.useFakeTimers();
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile, debounceMs: 1000 });

    bucket.scheduleSave('r', { date: '2026-07-01', callsignsTaken: [], rotations: 1 });
    bucket.scheduleSave('r', { date: '2026-07-01', callsignsTaken: ['VOLT-01'], rotations: 2 });
    bucket.scheduleSave('r', { date: '2026-07-01', callsignsTaken: ['VOLT-01', 'NEON-02'], rotations: 3 });

    expect(writeCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeCalls).toHaveLength(1);
    const written = JSON.parse(writeCalls[0].data);
    expect(written.rotations).toBe(3);
    expect(written.callsignsTaken).toHaveLength(2);
  });
});

describe('DayStatsBucket — write error on flush propagates', () => {
  it('flush() rejects when writeFile throws', async () => {
    const writeFile = async (): Promise<void> => { throw new Error('disk full'); };
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile: async () => '{}' });
    bucket.scheduleSave('r', { date: '2026-07-01', callsignsTaken: [], rotations: 0 });
    await expect(bucket.flush('r')).rejects.toThrow(/disk full/);
  });
});

describe('DayStatsBucket — path traversal rejected', () => {
  it('load with traversal id throws without touching disk', async () => {
    let readAttempted = false;
    const bucket = new DayStatsBucket({
      dir: '/data',
      writeFile: async () => {},
      readFile: async () => { readAttempted = true; return '{}'; },
    });
    await expect(bucket.load('../../etc')).rejects.toThrow(/invalid.*id/i);
    expect(readAttempted).toBe(false);
  });

  it('writes under <dir>/buckets/dayStats/', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const bucket = new DayStatsBucket({ dir: '/data', writeFile, readFile });
    bucket.scheduleSave('myroom', { date: '2026-07-01', callsignsTaken: [], rotations: 0 });
    await bucket.flush();
    expect(writeCalls[0].path).toBe('/data/buckets/dayStats/myroom.json');
  });
});

// ---------------------------------------------------------------------------
// Cross-bucket: world RESET doesn't affect guestbook or dayStats
// ---------------------------------------------------------------------------

describe('Cross-bucket isolation — world RESET does NOT wipe guestbook or dayStats', () => {
  it('clearing world saves leaves guestbook intact (separate files)', async () => {
    const { writeCalls, writeFile, readFile } = makeFakeFs();
    const worldBucket = new WorldBucket({ dir: '/data', writeFile, readFile });
    const guestbookBucket = new GuestbookBucket({ dir: '/data', writeFile, readFile });

    // Save both
    worldBucket.scheduleSave('room', [makeShape('room:0')]);
    guestbookBucket.scheduleSave('room', [makeGlyph('g:0', 'VOLT-01')]);
    await worldBucket.flush();
    await guestbookBucket.flush();

    expect(writeCalls).toHaveLength(2);
    // Distinct paths
    const paths = writeCalls.map((c) => c.path);
    expect(paths.some((p) => p.includes('world'))).toBe(true);
    expect(paths.some((p) => p.includes('guestbook'))).toBe(true);

    // RESET: save empty world
    worldBucket.scheduleSave('room', []);
    await worldBucket.flush('room');

    // Guestbook still intact
    const glyphs = await guestbookBucket.load('room');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].callsign).toBe('VOLT-01');
  });
});
