/**
 * importLayout.test.ts — Task C34 (F23 The Workshop) the no-UI rung: the
 * `tools/import-layout.mjs` hand-written-JSON importer (spec §7.23 Rungs).
 *
 * Asserts a hand-written layout JSON is validated (SAME shared gate the server
 * uses), settle-BAKED deterministically, and written into the room's `layouts`
 * bucket file in the LayoutBucket shape — and that an over-the-baseline-cap layout
 * is rejected as a baseline (the reserve). Uses a temp dir + a --print round-trip.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The importer body is exported for the test (no subprocess needed).
import { importLayout } from '../../../tools/import-layout.mjs';
import { BASELINE_MAX_SHAPES } from '@cyber-shapes/shared';

const _dirs: string[] = [];
afterEach(() => {
  for (const d of _dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'import-layout-'));
  _dirs.push(dir);
  return dir;
}

function writeLayoutFile(dir: string, layout: unknown): string {
  const file = join(dir, 'layout.json');
  writeFileSync(file, JSON.stringify(layout), 'utf8');
  return file;
}

function layout(n: number, name = 'showroom') {
  return {
    name,
    author: 'CLUB',
    savedAt: 0,
    shapes: Array.from({ length: n }, (_, i) => ({
      type: 'cube',
      colorIndex: i % 6,
      renderMode: 'both',
      scale: 1,
      position: { x: i, y: 6, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })),
  };
}

describe('tools/import-layout.mjs (Task C34, spec §7.23)', () => {
  it('imports a hand-written layout into the room layouts bucket file', () => {
    const dir = makeTemp();
    const file = writeLayoutFile(dir, layout(3));
    const manifest = importLayout({ file, room: 'room1', dataDir: dir, baseline: true });
    // The manifest was written + returned, marked as the baseline.
    expect(manifest.layouts).toHaveLength(1);
    expect(manifest.baselineName).toBe('showroom');
    // The bucket file exists at <dir>/buckets/layouts/room1.json.
    const bucketPath = join(dir, 'buckets', 'layouts', 'room1.json');
    expect(existsSync(bucketPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(bucketPath, 'utf8'));
    expect(onDisk.layouts[0].name).toBe('showroom');
    // The shapes were BAKED — they settled onto the floor (y dropped from 6).
    for (const s of onDisk.layouts[0].shapes) expect(s.position.y).toBeLessThan(6);
  });

  it('--print validates + bakes + returns WITHOUT writing a file', () => {
    const dir = makeTemp();
    const file = writeLayoutFile(dir, layout(2));
    const result = importLayout({ file, room: 'room1', dataDir: dir, print: true });
    expect(result.layouts).toHaveLength(1);
    // Nothing was written to disk in print mode.
    expect(existsSync(join(dir, 'buckets', 'layouts', 'room1.json'))).toBe(false);
  });

  it('rejects an over-the-baseline-cap layout imported as a baseline (the reserve)', () => {
    const dir = makeTemp();
    const file = writeLayoutFile(dir, layout(BASELINE_MAX_SHAPES + 1));
    expect(() => importLayout({ file, room: 'room1', dataDir: dir, baseline: true })).toThrow(
      /too-many-shapes/
    );
  });

  it('rejects a missing --room / a bad JSON file', () => {
    const dir = makeTemp();
    const file = writeLayoutFile(dir, layout(1));
    expect(() => importLayout({ file, dataDir: dir })).toThrow(/room/);
    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, '{ not json', 'utf8');
    expect(() => importLayout({ file: badFile, room: 'room1', dataDir: dir })).toThrow(/invalid JSON/);
  });

  it('a second import UPSERTS by name (never duplicates)', () => {
    const dir = makeTemp();
    importLayout({ file: writeLayoutFile(dir, layout(2, 'a')), room: 'room1', dataDir: dir });
    importLayout({ file: writeLayoutFile(dir, layout(3, 'a')), room: 'room1', dataDir: dir });
    const onDisk = JSON.parse(readFileSync(join(dir, 'buckets', 'layouts', 'room1.json'), 'utf8'));
    expect(onDisk.layouts).toHaveLength(1); // upserted, not duplicated
    expect(onDisk.layouts[0].shapes).toHaveLength(3); // the second (3-shape) won
  });
});
