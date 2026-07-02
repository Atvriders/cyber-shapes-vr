import { describe, it, expect } from 'vitest';
import { SHAPE_TYPES } from '@cyber-shapes/shared';
import { clampScale, cycleColorIndex, cycleRenderMode, restYFor } from '@cyber-shapes/shared';

describe('clampScale', () => {
  it('clamps above max to 3', () => {
    expect(clampScale(5)).toBe(3);
  });

  it('clamps below min to 0.2', () => {
    expect(clampScale(0.1)).toBe(0.2);
  });

  it('passes through in-range value unchanged', () => {
    expect(clampScale(1)).toBe(1);
  });
});

describe('cycleRenderMode', () => {
  it('cycles both → solid', () => {
    expect(cycleRenderMode('both')).toBe('solid');
  });

  it('cycles solid → wireframe', () => {
    expect(cycleRenderMode('solid')).toBe('wireframe');
  });

  it('cycles wireframe → both', () => {
    expect(cycleRenderMode('wireframe')).toBe('both');
  });
});

describe('cycleColorIndex', () => {
  it('wraps last index (6) back to 0', () => {
    expect(cycleColorIndex(6)).toBe(0);
  });

  it('increments 0 → 1', () => {
    expect(cycleColorIndex(0)).toBe(1);
  });
});

describe('restYFor', () => {
  it('cube at scale 1 equals 0.15 (half of BoxGeometry height 0.3)', () => {
    expect(restYFor('cube', 1)).toBeCloseTo(0.15);
  });

  it('sphere at scale 2 is positive', () => {
    expect(restYFor('sphere', 2)).toBeGreaterThan(0);
  });

  it('every SHAPE_TYPE at scale 1 returns a positive number', () => {
    for (const type of SHAPE_TYPES) {
      const y = restYFor(type, 1);
      expect(y, `restYFor('${type}', 1) should be > 0`).toBeGreaterThan(0);
    }
  });
});
