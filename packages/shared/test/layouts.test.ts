/**
 * layouts.test.ts — Task C34 (F23 The Workshop) PURE layout core (spec §7.23).
 *
 * Covers the brief's Step-1 pure cases: validateLayout caps (>12 baseline /
 * >MAX_SHAPES any) + the CROSS-CONSTANT tie (baselineCap + METEOR_BUDGET ≤
 * MAX_SHAPES), settleBake determinism + the wind/freeze/attractor strip + a
 * DEFAULT_PARAMS fixture whose baked bodies all ground + a never-settling fixture
 * that returns settled:false.
 */

import { describe, it, expect } from 'vitest';
import {
  validateLayout,
  settleBake,
  bakeParams,
  layoutToSeeds,
  LAYOUT_MAX_SHAPES,
  BASELINE_MAX_SHAPES,
  MAX_SHAPES,
  METEOR_BUDGET,
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  type Layout,
  type LayoutShape,
} from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function shape(overrides: Partial<LayoutShape> = {}): LayoutShape {
  return {
    type: 'cube',
    colorIndex: 0,
    renderMode: 'both',
    scale: 1,
    position: { x: 0, y: 8, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function layout(n: number, overrides: Partial<Layout> = {}): Layout {
  return {
    name: 'test',
    author: 'VOLT-01',
    savedAt: 123,
    shapes: Array.from({ length: n }, (_, i) =>
      shape({ position: { x: i * 0.1, y: 8, z: i * 0.1 }, colorIndex: i % 6 })
    ),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateLayout — caps + schema
// ---------------------------------------------------------------------------

describe('validateLayout — caps (spec §7.23)', () => {
  it('the cross-constant tie holds: baselineCap + METEOR_BUDGET ≤ MAX_SHAPES', () => {
    // Read the REAL constant values — a retune that breaks the reserve must fail here.
    expect(BASELINE_MAX_SHAPES + METEOR_BUDGET).toBeLessThanOrEqual(MAX_SHAPES);
    expect(BASELINE_MAX_SHAPES).toBe(MAX_SHAPES - METEOR_BUDGET);
    expect(LAYOUT_MAX_SHAPES).toBe(MAX_SHAPES);
    // The baseline cap must be strictly below the play cap (the whole point).
    expect(BASELINE_MAX_SHAPES).toBeLessThan(LAYOUT_MAX_SHAPES);
  });

  it('accepts a baseline exactly at the baseline cap', () => {
    const r = validateLayout(layout(BASELINE_MAX_SHAPES), true);
    expect(r.ok).toBe(true);
  });

  it('rejects a baseline ONE OVER the baseline cap (> 12 headroom shapes)', () => {
    const r = validateLayout(layout(BASELINE_MAX_SHAPES + 1), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-many-shapes');
  });

  it('a layout that is fine as a PLAY layout is REJECTED as a baseline (the reserve)', () => {
    const overCap = BASELINE_MAX_SHAPES + 4; // still ≤ MAX_SHAPES
    expect(validateLayout(layout(overCap), false).ok).toBe(true);
    expect(validateLayout(layout(overCap), true).ok).toBe(false);
  });

  it('accepts a play layout exactly at MAX_SHAPES', () => {
    expect(validateLayout(layout(MAX_SHAPES), false).ok).toBe(true);
  });

  it('rejects a play layout ONE OVER MAX_SHAPES', () => {
    const r = validateLayout(layout(MAX_SHAPES + 1), false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too-many-shapes');
  });

  it('an empty layout is admissible (a deliberately cleared showroom)', () => {
    expect(validateLayout(layout(0), true).ok).toBe(true);
    expect(validateLayout(layout(0), false).ok).toBe(true);
  });
});

describe('validateLayout — schema (total, never throws)', () => {
  it('rejects non-objects / a missing name / a bad shape', () => {
    expect(validateLayout(null, false).ok).toBe(false);
    expect(validateLayout(42, false).ok).toBe(false);
    expect(validateLayout({ ...layout(1), name: '' }, false).ok).toBe(false);
    const bad = layout(2);
    (bad.shapes[1] as unknown as { position: unknown }).position = { x: NaN, y: 0, z: 0 };
    const r = validateLayout(bad, false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('bad-shape');
      expect(r.index).toBe(1);
    }
  });

  it('rejects an unknown shape type / render mode', () => {
    expect(validateLayout(layout(1, { shapes: [shape({ type: 'blob' as never })] }), false).ok).toBe(false);
    expect(
      validateLayout(layout(1, { shapes: [shape({ renderMode: 'glow' as never })] }), false).ok
    ).toBe(false);
  });

  it('narrows a trusted copy (drops unknown keys, deep-copies vectors)', () => {
    const src = layout(1) as Layout & { evil?: string };
    src.evil = 'x';
    const r = validateLayout(src, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.layout as { evil?: string }).evil).toBeUndefined();
      // Mutating the returned copy must not touch the source.
      r.layout.shapes[0].position.x = 999;
      expect(src.shapes[0].position.x).not.toBe(999);
    }
  });

  it('preserves themeId + baseParams (they apply ONLY via LAYOUT_LOAD)', () => {
    const l = layout(1, { themeId: 'ghost-monochrome', baseParams: { gravity: { x: 0, y: -1, z: 0 } } });
    const r = validateLayout(l, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layout.themeId).toBe('ghost-monochrome');
      expect(r.layout.baseParams?.gravity?.y).toBe(-1);
    }
  });
});

// ---------------------------------------------------------------------------
// settleBake — deterministic settle, strip, grounded, never-settles
// ---------------------------------------------------------------------------

describe('settleBake — determinism (spec §7.23)', () => {
  it('is deterministic: same input → byte-identical settled positions', () => {
    const l = layout(6);
    const a = settleBake(l, DEFAULT_PARAMS);
    const b = settleBake(l, DEFAULT_PARAMS);
    expect(JSON.stringify(a.layout.shapes)).toBe(JSON.stringify(b.layout.shapes));
    expect(a.settled).toBe(b.settled);
  });

  it('never mutates the input layout', () => {
    const l = layout(3);
    const before = JSON.stringify(l);
    settleBake(l, DEFAULT_PARAMS);
    expect(JSON.stringify(l)).toBe(before);
  });

  it('all baked bodies are grounded (settled:true) on a DEFAULT_PARAMS fixture', () => {
    // Shapes dropped from above the floor settle down under gravity.
    const l = layout(8, {
      shapes: Array.from({ length: 8 }, (_, i) =>
        shape({ position: { x: (i - 4) * 2, y: 6 + i, z: (i % 3) * 2 } })
      ),
    });
    const r = settleBake(l, DEFAULT_PARAMS);
    expect(r.settled).toBe(true);
    expect(r.warnings).toHaveLength(0);
    // Every shape came to rest AT or below where it started (fell onto the floor).
    for (let i = 0; i < r.layout.shapes.length; i++) {
      expect(r.layout.shapes[i].position.y).toBeLessThanOrEqual(l.shapes[i].position.y + 1e-6);
    }
  });

  it('a never-settling fixture returns settled:false with a warning', () => {
    // A tiny iteration bound cannot settle a shape dropped from high up.
    const l = layout(1, { shapes: [shape({ position: { x: 0, y: 40, z: 0 } })] });
    const r = settleBake(l, DEFAULT_PARAMS, 2);
    expect(r.settled).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('settleBake — strips wind/freeze/attractors (spec §7.23)', () => {
  it('bakeParams zeroes wind, clears freeze, empties attractors, applies containment', () => {
    const dial = {
      ...DEFAULT_PARAMS,
      wind: { x: 9, y: 9, z: 9 },
      freeze: true,
      attractors: [{ pos: { x: 0, y: 0, z: 0 }, strength: 100, minRadius: 1 }],
    };
    const baked = bakeParams(dial);
    expect(baked.wind).toEqual({ x: 0, y: 0, z: 0 });
    expect(baked.freeze).toBe(false);
    expect(baked.attractors).toEqual([]);
    expect(baked.suspendDespawn).toBe(true);
    expect(baked.bounds?.softSphereR).toBe(DIAL_BOUNDS.softSphereR);
    expect(baked.bounds?.speedCap).toBe(DIAL_BOUNDS.speedCap);
    // Base gravity is preserved (a bake settles under the room's gravity).
    expect(baked.gravity?.y).toBe(DEFAULT_PARAMS.gravity?.y);
  });

  it('a FROZEN param set still settles (freeze is stripped before the bake)', () => {
    const frozen = { ...DEFAULT_PARAMS, freeze: true };
    const l = layout(4, {
      shapes: Array.from({ length: 4 }, (_, i) => shape({ position: { x: i, y: 7, z: 0 } })),
    });
    const r = settleBake(l, frozen);
    // Had freeze NOT been stripped, stepBody would short-circuit and nothing would
    // ground → settled:false. Stripping it means the layout settles normally.
    expect(r.settled).toBe(true);
  });

  it('a strong attractor does NOT pull shapes off the floor during a bake', () => {
    const withAttractor = {
      ...DEFAULT_PARAMS,
      attractors: [{ pos: { x: 0, y: 30, z: 0 }, strength: 500, minRadius: 1 }],
    };
    const l = layout(3, {
      shapes: Array.from({ length: 3 }, (_, i) => shape({ position: { x: i * 3, y: 5, z: 0 } })),
    });
    const r = settleBake(l, withAttractor);
    expect(r.settled).toBe(true);
    // With the attractor stripped, shapes settle on the floor, not up at y=30.
    for (const s of r.layout.shapes) expect(s.position.y).toBeLessThan(5);
  });
});

describe('layoutToSeeds', () => {
  it('maps authored shapes to the RESET seed shape', () => {
    const l = layout(2);
    const seeds = layoutToSeeds(l);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({
      type: l.shapes[0].type,
      colorIndex: l.shapes[0].colorIndex,
      renderMode: l.shapes[0].renderMode,
      scale: l.shapes[0].scale,
    });
    expect(seeds[0].position).toEqual(l.shapes[0].position);
  });
});
