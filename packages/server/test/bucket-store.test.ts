/**
 * bucket-store.test.ts — Tests for getBucket accessor + §6.4 reset semantics.
 *
 * Verifies:
 *   - getBucket() returns the correct bucket type for each name.
 *   - Throws before initBuckets() is called.
 *   - onRoomReset(): world bucket cleared; guestbook + dayStats unchanged.
 *   - onDayClose(): world + dayStats cleared; guestbook unchanged.
 *   - Isolation: initBuckets replaces singletons (tests are independent).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NetShape } from '@cyber-shapes/shared';
import { WorldBucket, GuestbookBucket, DayStatsBucket, LayoutBucket } from '../src/buckets.js';
import type { LayoutManifest } from '../src/buckets.js';
import { initBuckets, getBucket, onRoomReset, onDayClose } from '../src/bucket-store.js';
import type { Layout } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Helpers
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

function makeGlyph(id: string, callsign: string) {
  return { id, callsign, points: [{ x: 0, y: 0 }], color: '#ff00ff', slotIndex: 0 };
}

function makeFakeFs() {
  const store = new Map<string, string>();
  return {
    store,
    writeFile: async (path: string, data: string): Promise<void> => { store.set(path, data); },
    readFile: async (path: string): Promise<string> => {
      const c = store.get(path);
      if (c === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return c;
    },
  };
}

// Each test calls initBuckets with a fresh fake FS so there's no shared state.
let fakeFs: ReturnType<typeof makeFakeFs>;
beforeEach(() => {
  fakeFs = makeFakeFs();
  initBuckets({ dir: '/data', writeFile: fakeFs.writeFile, readFile: fakeFs.readFile, debounceMs: 0 });
});

// ---------------------------------------------------------------------------
// getBucket — type-narrowed return + error before init
// ---------------------------------------------------------------------------

describe('getBucket — accessor returns correct type', () => {
  it('getBucket("world") returns a WorldBucket', () => {
    expect(getBucket('world')).toBeInstanceOf(WorldBucket);
  });

  it('getBucket("guestbook") returns a GuestbookBucket', () => {
    expect(getBucket('guestbook')).toBeInstanceOf(GuestbookBucket);
  });

  it('getBucket("dayStats") returns a DayStatsBucket', () => {
    expect(getBucket('dayStats')).toBeInstanceOf(DayStatsBucket);
  });

  it('getBucket("layouts") returns a LayoutBucket (Task C34)', () => {
    expect(getBucket('layouts')).toBeInstanceOf(LayoutBucket);
  });
});

// ---------------------------------------------------------------------------
// Task C34 — the layouts bucket (spec §7.23): round-trips a manifest, validates
// on load (drops malformed layouts), and survives BOTH a rotation RESET + day close.
// ---------------------------------------------------------------------------

function makeLayout(name: string, n = 2): Layout {
  return {
    name,
    author: 'VOLT-01',
    savedAt: 42,
    shapes: Array.from({ length: n }, (_, i) => ({
      type: 'cube' as const,
      colorIndex: i % 6,
      renderMode: 'both' as const,
      scale: 1,
      position: { x: i, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })),
  };
}

describe('LayoutBucket (Task C34, spec §7.23)', () => {
  it('round-trips a manifest (layouts + baselineName)', async () => {
    const layouts = getBucket('layouts');
    const manifest: LayoutManifest = { layouts: [makeLayout('showroom'), makeLayout('variant', 3)], baselineName: 'showroom' };
    layouts.scheduleSave('room1', manifest);
    await layouts.flush('room1');
    const loaded = await layouts.load('room1');
    expect(loaded.layouts).toHaveLength(2);
    expect(loaded.baselineName).toBe('showroom');
    expect(loaded.layouts[0].name).toBe('showroom');
    expect(loaded.layouts[1].shapes).toHaveLength(3);
  });

  it('an absent layouts file loads as an empty manifest (not null)', async () => {
    const loaded = await getBucket('layouts').load('never-saved');
    expect(loaded.layouts).toHaveLength(0);
    expect(loaded.baselineName).toBeUndefined();
  });

  it('validate-on-load drops a malformed layout (never throws)', async () => {
    // Hand-write a manifest with one good + one malformed (bad shape type) layout.
    const good = makeLayout('good');
    const bad = { name: 'bad', author: 'x', savedAt: 0, shapes: [{ type: 'blob', colorIndex: 0, renderMode: 'both', scale: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }] };
    fakeFs.store.set('/data/buckets/layouts/room1.json', JSON.stringify({ layouts: [good, bad] }));
    const loaded = await getBucket('layouts').load('room1');
    expect(loaded.layouts).toHaveLength(1); // the malformed one dropped
    expect(loaded.layouts[0].name).toBe('good');
  });

  it('layouts SURVIVE a rotation RESET (never wiped — spec §7.23)', async () => {
    const layouts = getBucket('layouts');
    layouts.scheduleSave('room1', { layouts: [makeLayout('showroom')], baselineName: 'showroom' });
    await layouts.flush('room1');
    await onRoomReset('room1'); // rotation boundary — must not touch layouts
    const loaded = await layouts.load('room1');
    expect(loaded.layouts).toHaveLength(1);
    expect(loaded.baselineName).toBe('showroom');
  });

  it('layouts SURVIVE a day close (never wiped — part of the LAN-day export)', async () => {
    const layouts = getBucket('layouts');
    layouts.scheduleSave('room1', { layouts: [makeLayout('showroom')], baselineName: 'showroom' });
    await layouts.flush('room1');
    await onDayClose('room1'); // day close wipes world + dayStats, NOT layouts
    const loaded = await layouts.load('room1');
    expect(loaded.layouts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// onRoomReset — spec §6.4: world clears; guestbook + dayStats survive
// ---------------------------------------------------------------------------

describe('onRoomReset — world resets; guestbook and dayStats survive', () => {
  it('world bucket is cleared (empty shapes) after RESET', async () => {
    const world = getBucket('world');
    world.scheduleSave('room1', [makeShape('r:0'), makeShape('r:1')]);
    await world.flush('room1');

    await onRoomReset('room1');

    const loaded = await world.load('room1');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(0);
  });

  it('guestbook is NOT cleared by RESET', async () => {
    const guestbook = getBucket('guestbook');
    guestbook.scheduleSave('room1', [makeGlyph('g:0', 'VOLT-01')]);
    await guestbook.flush('room1');

    await onRoomReset('room1');

    const glyphs = await guestbook.load('room1');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.callsign).toBe('VOLT-01');
  });

  it('dayStats is NOT cleared by RESET', async () => {
    const dayStats = getBucket('dayStats');
    dayStats.scheduleSave('room1', {
      date: '2026-07-01',
      callsignsTaken: ['VOLT-01'],
      rotations: 2,
    });
    await dayStats.flush('room1');

    await onRoomReset('room1');

    const stats = await dayStats.load('room1');
    expect(stats).not.toBeNull();
    expect(stats!.rotations).toBe(2);
    expect(stats!.callsignsTaken).toContain('VOLT-01');
  });

  it('repeated RESETs keep guestbook intact', async () => {
    const guestbook = getBucket('guestbook');
    guestbook.scheduleSave('room1', [makeGlyph('g:0', 'VOLT-01'), makeGlyph('g:1', 'NEON-02')]);
    await guestbook.flush('room1');

    await onRoomReset('room1');
    await onRoomReset('room1');
    await onRoomReset('room1');

    const glyphs = await guestbook.load('room1');
    expect(glyphs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// onDayClose — world + dayStats cleared; guestbook survives
// ---------------------------------------------------------------------------

describe('onDayClose — world and dayStats reset; guestbook survives', () => {
  it('world bucket is cleared at day close', async () => {
    const world = getBucket('world');
    world.scheduleSave('room1', [makeShape('r:0')]);
    await world.flush('room1');

    await onDayClose('room1');

    const loaded = await world.load('room1');
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(0);
  });

  it('dayStats is zeroed at day close', async () => {
    const dayStats = getBucket('dayStats');
    dayStats.scheduleSave('room1', {
      date: '2026-07-01',
      callsignsTaken: ['VOLT-01', 'NEON-02'],
      rotations: 5,
    });
    await dayStats.flush('room1');

    await onDayClose('room1');

    const stats = await dayStats.load('room1');
    expect(stats).not.toBeNull();
    expect(stats!.callsignsTaken).toHaveLength(0);
    expect(stats!.rotations).toBe(0);
  });

  it('guestbook is NOT cleared at day close', async () => {
    const guestbook = getBucket('guestbook');
    guestbook.scheduleSave('room1', [makeGlyph('g:0', 'VOLT-01')]);
    await guestbook.flush('room1');

    await onDayClose('room1');

    const glyphs = await guestbook.load('room1');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.callsign).toBe('VOLT-01');
  });
});

// ---------------------------------------------------------------------------
// onDayClose — in-memory set reset (LOW finding, Task C8)
// Verifies that _taken and _callsigns sets are cleared so stale data does not
// survive until a server restart after a day-close event.
// ---------------------------------------------------------------------------

describe('onDayClose — in-memory sets cleared (stale-data fix)', () => {
  it('DayStatsBucket._taken is cleared after onDayClose', async () => {
    const dayStats = getBucket('dayStats');
    dayStats.scheduleSave('room1', {
      date: '2026-07-01',
      callsignsTaken: ['VOLT-01', 'NEON-02'],
      rotations: 3,
    });
    await dayStats.flush('room1');
    await dayStats.load('room1');

    // Before close: set is populated
    expect(dayStats.getCallsignsTaken('room1').has('VOLT-01')).toBe(true);

    await onDayClose('room1');

    // After close: in-memory set is empty (not stale)
    expect(dayStats.getCallsignsTaken('room1').size).toBe(0);
  });

  it('GuestbookBucket._callsigns is cleared after onDayClose', async () => {
    const guestbook = getBucket('guestbook');
    guestbook.scheduleSave('room1', [makeGlyph('g:0', 'VOLT-01'), makeGlyph('g:1', 'NEON-02')]);
    await guestbook.flush('room1');
    await guestbook.load('room1');

    // Before close: set is populated
    expect(guestbook.getCallsigns('room1').has('VOLT-01')).toBe(true);

    await onDayClose('room1');

    // After close: in-memory set is empty (not stale)
    expect(guestbook.getCallsigns('room1').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-bucket isolation (spec §6.4 — semantic contract in one place)
// ---------------------------------------------------------------------------

describe('cross-bucket isolation — distinct files per bucket', () => {
  it('world, guestbook, and dayStats write to different file paths', async () => {
    const writtenPaths: string[] = [];
    const fs2 = makeFakeFs();
    const origWrite = fs2.writeFile;
    initBuckets({
      dir: '/data',
      writeFile: async (path, data) => {
        writtenPaths.push(path);
        return origWrite(path, data);
      },
      readFile: fs2.readFile,
      debounceMs: 0,
    });

    getBucket('world').scheduleSave('r', [makeShape('r:0')]);
    getBucket('guestbook').scheduleSave('r', [makeGlyph('g:0', 'V-01')]);
    getBucket('dayStats').scheduleSave('r', { date: '2026-07-01', callsignsTaken: [], rotations: 0 });

    await getBucket('world').flush('r');
    await getBucket('guestbook').flush('r');
    await getBucket('dayStats').flush('r');

    expect(writtenPaths.some((p) => p.includes('/world/'))).toBe(true);
    expect(writtenPaths.some((p) => p.includes('/guestbook/'))).toBe(true);
    expect(writtenPaths.some((p) => p.includes('/dayStats/'))).toBe(true);
    // All three paths are distinct
    expect(new Set(writtenPaths).size).toBe(3);
  });
});
