/**
 * effects.test.ts — pure builder tests for particle ShaderMaterial (Task A7)
 *
 * createParticleMaterial() constructs a THREE.ShaderMaterial entirely from
 * data — no WebGL context required. All assertions are on JS properties only.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createParticleMaterial } from '../src/effects.ts';

describe('createParticleMaterial', () => {
  it('returns a THREE.ShaderMaterial', () => {
    const mat = createParticleMaterial();
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
  });

  it('vertex shader contains "attribute float size"', () => {
    const mat = createParticleMaterial();
    expect(mat.vertexShader).toContain('attribute float size');
  });

  it('vertex shader contains "gl_PointSize"', () => {
    const mat = createParticleMaterial();
    expect(mat.vertexShader).toContain('gl_PointSize');
  });

  it('uses AdditiveBlending', () => {
    const mat = createParticleMaterial();
    expect(mat.blending).toBe(THREE.AdditiveBlending);
  });

  it('is transparent', () => {
    const mat = createParticleMaterial();
    expect(mat.transparent).toBe(true);
  });
});
