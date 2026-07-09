/**
 * glyphs.test.ts — the PURE glyph helpers (spec §7.13, C12):
 *   - resampleStroke(points, max=32): deterministic arc-length resample to ≤ max.
 *   - validateGlyph(glyph): bounds + point-count + finite check (server gate).
 *   - spiralSlot(index): a deterministic position on a SHELL OUTSIDE the play
 *     volume (never collides with shapes bounded by DIAL_BOUNDS.softSphereR).
 *
 * Determinism is load-bearing (the same input MUST map to the same slot / same
 * resample on every client, headset, and the server): no Date, no Math.random.
 */

import { describe, it, expect } from 'vitest';
import {
  resampleStroke,
  validateGlyph,
  spiralSlot,
  GLYPH_MAX_POINTS,
  GLYPH_SHELL_RADIUS,
  type GlyphStrokePoint,
} from '../src/glyphs.js';
import { DIAL_BOUNDS } from '../src/physicsCore.js';

// ---------------------------------------------------------------------------
// resampleStroke
// ---------------------------------------------------------------------------

function line(n: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: i / (n - 1), y: 0 });
  return pts;
}

describe('resampleStroke', () => {
  it('caps the output at GLYPH_MAX_POINTS (32)', () => {
    const out = resampleStroke(line(500));
    expect(out.length).toBeLessThanOrEqual(GLYPH_MAX_POINTS);
    expect(out.length).toBe(GLYPH_MAX_POINTS);
  });

  it('honors a custom max', () => {
    const out = resampleStroke(line(500), 8);
    expect(out.length).toBe(8);
  });

  it('is deterministic — same input → byte-identical output', () => {
    const input = line(137);
    expect(resampleStroke(input)).toEqual(resampleStroke(input));
  });

  it('keeps the first and last points (endpoints preserved)', () => {
    const input = line(200);
    const out = resampleStroke(input);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1].x).toBeCloseTo(1, 6);
  });

  it('passes a short stroke through unchanged (already ≤ max)', () => {
    const input = line(5);
    expect(resampleStroke(input)).toEqual(input);
  });

  it('returns [] for an empty stroke and the single point for a 1-point stroke', () => {
    expect(resampleStroke([])).toEqual([]);
    expect(resampleStroke([{ x: 0.5, y: 0.5 }])).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('drops NaN / Infinity points before resampling (never emits a non-finite)', () => {
    const dirty: GlyphStrokePoint[] = [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      { x: 0.5, y: Infinity },
      { x: 1, y: 1 },
    ];
    const out = resampleStroke(dirty);
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateGlyph
// ---------------------------------------------------------------------------

describe('validateGlyph', () => {
  const good = {
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
    color: '#00ffff',
  };

  it('accepts a well-formed glyph', () => {
    expect(validateGlyph(good)).toBe(true);
  });

  it('rejects a glyph with too few points (< 2)', () => {
    expect(validateGlyph({ ...good, points: [{ x: 0, y: 0 }] })).toBe(false);
    expect(validateGlyph({ ...good, points: [] })).toBe(false);
  });

  it('rejects a glyph with more than GLYPH_MAX_POINTS points', () => {
    const tooMany = Array.from({ length: GLYPH_MAX_POINTS + 1 }, (_, i) => ({
      x: i / 100,
      y: 0,
    }));
    expect(validateGlyph({ ...good, points: tooMany })).toBe(false);
  });

  it('rejects out-of-bounds points (normalized coords must be within [-1, 1] or [0, 1])', () => {
    expect(validateGlyph({ ...good, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] })).toBe(false);
    expect(validateGlyph({ ...good, points: [{ x: 0, y: 0 }, { x: 0, y: -9 }] })).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(validateGlyph({ ...good, points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }] })).toBe(false);
    expect(validateGlyph({ ...good, points: [{ x: 0, y: 0 }, { x: Infinity, y: 0 }] })).toBe(false);
  });

  it('rejects a missing / non-array points field', () => {
    expect(validateGlyph({ color: '#fff' } as unknown)).toBe(false);
    expect(validateGlyph({ points: 'nope', color: '#fff' } as unknown)).toBe(false);
  });

  it('rejects a non-string / malformed color', () => {
    expect(validateGlyph({ ...good, color: 123 } as unknown)).toBe(false);
    expect(validateGlyph({ ...good, color: 'not-a-color' })).toBe(false);
  });

  it('rejects a null / non-object glyph', () => {
    expect(validateGlyph(null)).toBe(false);
    expect(validateGlyph(42 as unknown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spiralSlot
// ---------------------------------------------------------------------------

describe('spiralSlot', () => {
  it('is deterministic — same index → identical position', () => {
    for (const i of [0, 1, 7, 42, 200, 511]) {
      expect(spiralSlot(i)).toEqual(spiralSlot(i));
    }
  });

  it('places every slot OUTSIDE the play volume (radius > DIAL_BOUNDS.softSphereR)', () => {
    for (let i = 0; i < 512; i++) {
      const p = spiralSlot(i);
      const r = Math.hypot(p.x, p.y, p.z);
      expect(r).toBeGreaterThan(DIAL_BOUNDS.softSphereR);
    }
  });

  it('anchors the shell radius at GLYPH_SHELL_RADIUS (> softSphereR)', () => {
    expect(GLYPH_SHELL_RADIUS).toBeGreaterThan(DIAL_BOUNDS.softSphereR);
  });

  it('produces distinct positions for distinct indices (no two glyphs stack)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 512; i++) {
      const p = spiralSlot(i);
      const key = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('emits only finite coordinates', () => {
    for (const i of [0, 1, 99, 300, 511]) {
      const p = spiralSlot(i);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });
});
