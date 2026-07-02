/**
 * modeSelect.test.ts — TDD RED→GREEN for chooseTransformSource (Task B6)
 *
 * Pure unit test: decides whether a shape's transform this frame comes from the
 * local controller ('local') or from the server snapshot buffer ('remote').
 *
 *   offline (!connected)                 → 'local'  (Phase-A path owns everything)
 *   connected + shape is locally held    → 'local'  (controller drives it, stream held)
 *   connected + shape NOT locally held   → 'remote' (server authoritative)
 */

import { describe, expect, it } from 'vitest';
import {
  chooseTransformSource,
  chooseTransformSourceMulti,
  isServerDriven,
} from '../src/net/modeSelect.js';

describe('chooseTransformSource', () => {
  it("returns 'local' when offline (not connected), regardless of held id", () => {
    expect(chooseTransformSource('s1', null, false)).toBe('local');
    expect(chooseTransformSource('s1', 's1', false)).toBe('local');
    expect(chooseTransformSource('s1', 's2', false)).toBe('local');
  });

  it("returns 'local' when connected AND the shape is the locally-held one", () => {
    expect(chooseTransformSource('s1', 's1', true)).toBe('local');
  });

  it("returns 'remote' when connected and the shape is NOT locally held", () => {
    expect(chooseTransformSource('s1', null, true)).toBe('remote');
    expect(chooseTransformSource('s1', 's2', true)).toBe('remote');
  });
});

// ---------------------------------------------------------------------------
// Audit #14 — set-based multi-held variant. VR holds one shape PER HAND, so more
// than one shape can be locally driven at once. Every id in the held set must be
// 'local' (streamed via sendHeld); everything else is 'remote'.
// ---------------------------------------------------------------------------
describe('chooseTransformSourceMulti (audit #14)', () => {
  it("returns 'local' for EVERY id in the held set when connected", () => {
    const held = new Set(['a', 'b']); // two hands
    expect(chooseTransformSourceMulti('a', held, true)).toBe('local');
    expect(chooseTransformSourceMulti('b', held, true)).toBe('local');
  });

  it("returns 'remote' for an id NOT in the held set when connected", () => {
    const held = new Set(['a', 'b']);
    expect(chooseTransformSourceMulti('c', held, true)).toBe('remote');
  });

  it("returns 'local' for any id when offline, even with an empty held set", () => {
    const held = new Set<string>();
    expect(chooseTransformSourceMulti('a', held, false)).toBe('local');
    expect(chooseTransformSourceMulti('z', held, false)).toBe('local');
  });

  it("returns 'remote' for all ids when connected with an EMPTY held set", () => {
    const held = new Set<string>();
    expect(chooseTransformSourceMulti('a', held, true)).toBe('remote');
    expect(chooseTransformSourceMulti('b', held, true)).toBe('remote');
  });

  it('accepts a ReadonlySet<string>', () => {
    const held: ReadonlySet<string> = new Set(['x']);
    expect(chooseTransformSourceMulti('x', held, true)).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// Audit #22 — server-driven gate: connected AND welcome both required. The
// truth table below is false until the welcome snapshot arrives, so the offline
// path keeps running (local physics) in the OPEN-before-welcome window.
// ---------------------------------------------------------------------------
describe('isServerDriven (audit #22)', () => {
  it('is false when not connected (regardless of welcome)', () => {
    expect(isServerDriven(false, false)).toBe(false);
    expect(isServerDriven(false, true)).toBe(false);
  });

  it('is false when connected but welcome NOT yet received (the OPEN-before-welcome gap)', () => {
    expect(isServerDriven(true, false)).toBe(false);
  });

  it('is true ONLY when connected AND welcome received', () => {
    expect(isServerDriven(true, true)).toBe(true);
  });
});
