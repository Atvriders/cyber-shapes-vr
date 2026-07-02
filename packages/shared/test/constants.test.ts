import { describe, it, expect } from 'vitest';
import {
  SHAPE_TYPES,
  RENDER_MODES,
  CYBER_COLORS,
  MAX_SHAPES,
  MAX_LIGHTS,
  GRAVITY,
  BOUNCE,
  FRICTION,
  REST_THRESHOLD,
  REMOVE_DISTANCE,
} from '@cyber-shapes/shared';

describe('shared constants', () => {
  it('SHAPE_TYPES has exactly 10 entries', () => {
    expect(SHAPE_TYPES.length).toBe(10);
  });

  it('SHAPE_TYPES contains all expected shape names', () => {
    const expected = [
      'cube',
      'sphere',
      'icosahedron',
      'torus',
      'torusKnot',
      'octahedron',
      'dodecahedron',
      'cylinder',
      'cone',
      'tetrahedron',
    ] as const;
    for (const name of expected) {
      expect(SHAPE_TYPES).toContain(name);
    }
  });

  it('RENDER_MODES has exactly 3 entries', () => {
    expect(RENDER_MODES.length).toBe(3);
  });

  it('RENDER_MODES contains both, solid, wireframe', () => {
    expect(RENDER_MODES).toContain('both');
    expect(RENDER_MODES).toContain('solid');
    expect(RENDER_MODES).toContain('wireframe');
  });

  it('CYBER_COLORS has exactly 7 entries', () => {
    expect(CYBER_COLORS.length).toBe(7);
  });

  it('each CYBER_COLORS entry is an integer in 0..0xffffff', () => {
    for (const color of CYBER_COLORS) {
      expect(Number.isInteger(color)).toBe(true);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('MAX_SHAPES is 40', () => {
    expect(MAX_SHAPES).toBe(40);
  });

  it('MAX_LIGHTS is 6', () => {
    expect(MAX_LIGHTS).toBe(6);
  });

  it('physics constants have correct values', () => {
    expect(GRAVITY).toBe(-5);
    expect(BOUNCE).toBe(0.5);
    expect(FRICTION).toBe(0.98);
    expect(REST_THRESHOLD).toBe(0.05);
    expect(REMOVE_DISTANCE).toBe(50);
  });
});
