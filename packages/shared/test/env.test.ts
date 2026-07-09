/**
 * env.test.ts — Task C11 ENV_STATE + cue-banner text derivation (pure).
 */

import { describe, it, expect } from 'vitest';
import { cueBannerText, envProgress, DEFAULT_PARAMS } from '../src/index.js';
import type { EnvState } from '../src/index.js';

function env(over: Partial<EnvState> = {}): EnvState {
  return {
    serverTimestamp: 1_000,
    mode: 'BULLET TIME ×0.25',
    params: DEFAULT_PARAMS,
    endsAt: 6_000,
    ...over,
  };
}

describe('cueBannerText', () => {
  it('returns the mode label when a dial is live', () => {
    expect(cueBannerText(env())).toBe('BULLET TIME ×0.25');
  });
  it('returns "" when no dial is live (null env / null / empty mode) → banner clears', () => {
    expect(cueBannerText(null)).toBe('');
    expect(cueBannerText(env({ mode: null }))).toBe('');
    expect(cueBannerText(env({ mode: '' }))).toBe('');
  });
});

describe('envProgress', () => {
  it('is 0 at fire, 1 at endsAt, and a fraction between', () => {
    const e = env({ serverTimestamp: 1_000, endsAt: 6_000 }); // 5 s window
    expect(envProgress(e, 1_000)).toBe(0);
    expect(envProgress(e, 6_000)).toBe(1);
    expect(envProgress(e, 3_500)).toBeCloseTo(0.5, 6);
  });
  it('clamps outside the window and returns 0 when no dial is active', () => {
    const e = env({ serverTimestamp: 1_000, endsAt: 6_000 });
    expect(envProgress(e, 0)).toBe(0); // before fire
    expect(envProgress(e, 9_999)).toBe(1); // after end
    expect(envProgress(env({ endsAt: null }), 3_000)).toBe(0);
    expect(envProgress(null, 3_000)).toBe(0);
  });
});
