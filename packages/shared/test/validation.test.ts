/**
 * validation.test.ts — regression tests for the untrusted-input validation
 * layer added in the server security audit (findings #2, #5, #9, #17).
 *
 * These are the PRIMARY defence: a NaN/non-number Vec3 component, an invalid
 * shape type/colorIndex/renderMode, or a malformed persisted shape must be
 * rejected here before it can ever reach the sim or be persisted.
 */

import { describe, it, expect } from 'vitest';
import {
  isFiniteNumber,
  isFiniteVec3,
  validateClientMsg,
  isValidPersistedShape,
  clampName,
  MAX_NAME_LEN,
} from '../src/net/protocol.js';
import { CYBER_COLORS } from '../src/constants.js';
import type { NetShape } from '../src/net/types.js';

// ---------------------------------------------------------------------------
// isFiniteNumber / isFiniteVec3
// ---------------------------------------------------------------------------

describe('isFiniteNumber', () => {
  it('accepts finite numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-3.14)).toBe(true);
    expect(isFiniteNumber(1e9)).toBe(true);
  });
  it('rejects NaN, Infinity, and non-numbers', () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });
});

describe('isFiniteVec3', () => {
  it('accepts a finite {x,y,z}', () => {
    expect(isFiniteVec3({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isFiniteVec3({ x: 0, y: -0.5, z: 100 })).toBe(true);
  });
  it('rejects a Vec3 with a NaN component (finding #2 poison)', () => {
    expect(isFiniteVec3({ x: NaN, y: 0, z: 0 })).toBe(false);
    expect(isFiniteVec3({ x: 0, y: Infinity, z: 0 })).toBe(false);
  });
  it('rejects a Vec3 with a non-number component', () => {
    expect(isFiniteVec3({ x: '1', y: 0, z: 0 })).toBe(false);
    expect(isFiniteVec3({ x: 0, y: 0 })).toBe(false); // missing z
  });
  it('rejects non-objects', () => {
    expect(isFiniteVec3(null)).toBe(false);
    expect(isFiniteVec3(42)).toBe(false);
    expect(isFiniteVec3('x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClientMsg — spawn (findings #2, #5)
// ---------------------------------------------------------------------------

describe('validateClientMsg — spawn', () => {
  const validSpawn = { t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } };

  it('accepts a well-formed spawn', () => {
    expect(validateClientMsg(validSpawn)).toBe(true);
  });

  it('rejects a spawn with a NaN position component (finding #2)', () => {
    expect(
      validateClientMsg({ t: 'spawn', shape: { type: 'cube', position: { x: NaN, y: 1, z: 0 } } })
    ).toBe(false);
  });

  it('rejects a spawn with a non-number position component (finding #2)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: '0', y: 1, z: 0 } },
      })
    ).toBe(false);
  });

  it('rejects a spawn with an invalid shape type (finding #5)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'wormhole', position: { x: 0, y: 1, z: 0 } },
      })
    ).toBe(false);
  });

  it('rejects a spawn with an out-of-range colorIndex (finding #5)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: CYBER_COLORS.length },
      })
    ).toBe(false);
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: -1 },
      })
    ).toBe(false);
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: 1.5 },
      })
    ).toBe(false);
  });

  it('rejects a spawn with an invalid renderMode (finding #5)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, renderMode: 'holographic' },
      })
    ).toBe(false);
  });

  it('rejects a spawn with a non-finite scale (finding #5)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, scale: NaN },
      })
    ).toBe(false);
  });

  it('rejects a structurally-malformed spawn (missing shape — finding #4 shape)', () => {
    expect(validateClientMsg({ t: 'spawn' })).toBe(false);
  });

  // --- spawn-poison via rotSpeed / bobPhase (audit-2 CRITICAL) ---
  // Raw JSON `{"rotSpeed":{"x":1e999,...}}` parses to {x:Infinity,...} (valid
  // JSON), and serverWorld would store it → step() broadcasts a non-finite
  // rotation at 15Hz forever + persists it. Must be rejected here.
  it('rejects a spawn whose rotSpeed has an Infinity component (poison)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 }, rotSpeed: { x: Infinity, y: 0, z: 0 } },
      })
    ).toBe(false);
  });

  it('rejects a spawn whose rotSpeed has a NaN component (poison)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 }, rotSpeed: { x: NaN, y: 0, z: 0 } },
      })
    ).toBe(false);
  });

  it('rejects a spawn whose rotSpeed is not a Vec3 (non-number)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 }, rotSpeed: { x: '1', y: 0, z: 0 } },
      })
    ).toBe(false);
  });

  it('rejects a spawn with a non-finite bobPhase (poison)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 }, bobPhase: Infinity },
      })
    ).toBe(false);
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: { type: 'cube', position: { x: 0, y: 5, z: 0 }, bobPhase: 'x' },
      })
    ).toBe(false);
  });

  it('accepts a spawn with a valid finite rotSpeed + bobPhase (no false rejection)', () => {
    expect(
      validateClientMsg({
        t: 'spawn',
        shape: {
          type: 'cube',
          position: { x: 0, y: 5, z: 0 },
          rotSpeed: { x: 0.1, y: 0.2, z: 0.3 },
          bobPhase: 1.5,
        },
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateClientMsg — release / held / pose Vec3s (finding #2)
// ---------------------------------------------------------------------------

describe('validateClientMsg — release/held/pose', () => {
  it('rejects a release with a NaN velocity (finding #2)', () => {
    expect(
      validateClientMsg({
        t: 'release',
        id: 's1',
        velocity: { x: NaN, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      })
    ).toBe(false);
  });

  it('rejects a held with a non-number position (finding #2)', () => {
    expect(
      validateClientMsg({
        t: 'held',
        id: 's1',
        position: { x: 'x', y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      })
    ).toBe(false);
  });

  it('rejects a held with a non-string id', () => {
    expect(
      validateClientMsg({
        t: 'held',
        id: 42,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      })
    ).toBe(false);
  });

  it('rejects a pose with a NaN head component (finding #2)', () => {
    expect(
      validateClientMsg({
        t: 'pose',
        pose: {
          head: { p: { x: NaN, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0 } },
          hands: [null, null],
        },
      })
    ).toBe(false);
  });

  it('accepts a well-formed pose with null hands', () => {
    expect(
      validateClientMsg({
        t: 'pose',
        pose: {
          head: { p: { x: 0, y: 1.7, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } },
          hands: [null, null],
        },
      })
    ).toBe(true);
  });

  it('rejects a pose with an over-long hands array (amplification guard)', () => {
    // All-finite hands but too many entries — the real client sends exactly 2.
    const oneHand = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0 } };
    const hands = Array.from({ length: 500 }, () => oneHand);
    expect(
      validateClientMsg({
        t: 'pose',
        pose: { head: { p: { x: 0, y: 1.7, z: 0 }, q: { x: 0, y: 0, z: 0 } }, hands },
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClientMsg — grab / recolor / etc. id + field checks
// ---------------------------------------------------------------------------

describe('validateClientMsg — id/field checks', () => {
  it('accepts a grab with a string id, rejects a non-string id (finding #4)', () => {
    expect(validateClientMsg({ t: 'grab', id: 's1' })).toBe(true);
    expect(validateClientMsg({ t: 'grab', id: 123 })).toBe(false);
    expect(validateClientMsg({ t: 'grab' })).toBe(false);
  });

  it('rejects recolor with an out-of-range colorIndex (finding #5)', () => {
    expect(validateClientMsg({ t: 'recolor', id: 's1', colorIndex: 2 })).toBe(true);
    expect(validateClientMsg({ t: 'recolor', id: 's1', colorIndex: 999 })).toBe(false);
  });

  it('rejects rendermode with an invalid mode (finding #5)', () => {
    expect(validateClientMsg({ t: 'rendermode', id: 's1', mode: 'solid' })).toBe(true);
    expect(validateClientMsg({ t: 'rendermode', id: 's1', mode: 'nope' })).toBe(false);
  });

  it('rejects scale with a NaN scale (finding #5)', () => {
    expect(validateClientMsg({ t: 'scale', id: 's1', scale: 2 })).toBe(true);
    expect(validateClientMsg({ t: 'scale', id: 's1', scale: NaN })).toBe(false);
  });

  it('validates join fields', () => {
    expect(
      validateClientMsg({ t: 'join', room: 'r', name: 'A', color: 0, protocol: 1 })
    ).toBe(true);
    expect(
      validateClientMsg({ t: 'join', room: 'r', name: 'A', color: NaN, protocol: 1 })
    ).toBe(false);
    expect(
      validateClientMsg({ t: 'join', room: 5, name: 'A', color: 0, protocol: 1 })
    ).toBe(false);
  });

  it('accepts voice control messages and a string voice-config', () => {
    expect(validateClientMsg({ t: 'voice-join' })).toBe(true);
    expect(validateClientMsg({ t: 'voice-state', speaking: true, muted: false })).toBe(true);
    expect(validateClientMsg({ t: 'voice-state', speaking: 'yes', muted: false })).toBe(false);
    expect(validateClientMsg({ t: 'voice-config', config: '{}' })).toBe(true);
    expect(validateClientMsg({ t: 'voice-config', config: 5 })).toBe(false);
  });

  it('passes through unknown message types (dropped harmlessly downstream)', () => {
    expect(validateClientMsg({ t: 'totally-unknown' })).toBe(true);
  });

  it('rejects non-objects and missing t', () => {
    expect(validateClientMsg(null)).toBe(false);
    expect(validateClientMsg(42)).toBe(false);
    expect(validateClientMsg({ x: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clampName (finding #17)
// ---------------------------------------------------------------------------

describe('clampName', () => {
  it('trims and length-clamps a long name', () => {
    const long = 'x'.repeat(MAX_NAME_LEN + 50);
    const clamped = clampName(long);
    expect(clamped.length).toBe(MAX_NAME_LEN);
  });
  it('trims surrounding whitespace', () => {
    expect(clampName('  Alice  ')).toBe('Alice');
  });
  it('collapses non-strings to empty string', () => {
    expect(clampName(42)).toBe('');
    expect(clampName(null)).toBe('');
    expect(clampName(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isValidPersistedShape (finding #9)
// ---------------------------------------------------------------------------

function makeGoodShape(): NetShape {
  return {
    id: 'room:0',
    type: 'cube',
    colorIndex: 1,
    renderMode: 'both',
    scale: 1,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0,
    rotSpeed: { x: 0, y: 0, z: 0 },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

describe('isValidPersistedShape', () => {
  it('accepts a well-formed persisted shape', () => {
    expect(isValidPersistedShape(makeGoodShape())).toBe(true);
  });
  it('rejects a shape missing its position Vec3 (finding #9)', () => {
    const s = makeGoodShape() as Partial<NetShape>;
    delete s.position;
    expect(isValidPersistedShape(s)).toBe(false);
  });
  it('rejects a shape with a NaN position component (finding #9)', () => {
    const s = makeGoodShape();
    s.position = { x: NaN, y: 0, z: 0 };
    expect(isValidPersistedShape(s)).toBe(false);
  });
  it('rejects a shape with an invalid type', () => {
    const s = makeGoodShape() as unknown as Record<string, unknown>;
    s['type'] = 'wormhole';
    expect(isValidPersistedShape(s)).toBe(false);
  });
  it('rejects an empty object (the {} that becomes NaN)', () => {
    expect(isValidPersistedShape({})).toBe(false);
  });
  it('rejects null / non-object', () => {
    expect(isValidPersistedShape(null)).toBe(false);
    expect(isValidPersistedShape('shape')).toBe(false);
  });
});
