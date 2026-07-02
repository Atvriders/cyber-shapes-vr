/**
 * controllers.test.ts — pure button-edge + intent-mapping helpers (Task A8)
 *
 * These helpers are the Three/DOM-free core of controllers.ts. The gamepad
 * button/axis wiring, ShapeStore mutations, and desktop raycaster all live in
 * thin shells around them. Only the pure logic is unit-tested here:
 *
 *   - buttonEdge(prev, curr): rising-edge detector (fires once per press).
 *   - intentForButtons(state): maps a snapshot of button/axis edges to one Intent.
 *
 * WebXR gamepad button layout (matches controllers.ts):
 *   buttons[0] = trigger → spawn
 *   buttons[1] = grip    → grab / release (toggle handled by caller via heldId)
 *   buttons[4] = A / X   → cycle color
 *   buttons[5] = B / Y   → cycle render mode
 *   axes[3]    = stick Y → scale held shape
 */

import { describe, expect, it } from 'vitest';
import {
  buttonEdge,
  intentForButtons,
  isClick,
  type ButtonSnapshot,
  type Intent,
} from '../src/controllers.ts';

function snapshot(overrides: Partial<ButtonSnapshot> = {}): ButtonSnapshot {
  return {
    trigger: { prev: false, curr: false },
    grip: { prev: false, curr: false },
    aButton: { prev: false, curr: false },
    bButton: { prev: false, curr: false },
    stickY: 0,
    ...overrides,
  };
}

describe('buttonEdge', () => {
  it('rising edge (false→true) is true', () => {
    expect(buttonEdge(false, true)).toBe(true);
  });

  it('held (true→true) is false', () => {
    expect(buttonEdge(true, true)).toBe(false);
  });

  it('falling edge (true→false) is false', () => {
    expect(buttonEdge(true, false)).toBe(false);
  });

  it('idle (false→false) is false', () => {
    expect(buttonEdge(false, false)).toBe(false);
  });

  it('fires exactly once over a press-hold-release sequence', () => {
    // prev, curr pairs across frames: up, press(edge), hold, hold, release
    const seq: Array<[boolean, boolean]> = [
      [false, false], // idle
      [false, true], // press → edge
      [true, true], // hold
      [true, true], // hold
      [true, false], // release
      [false, false], // idle
    ];
    const edges = seq.filter(([p, c]) => buttonEdge(p, c));
    expect(edges).toHaveLength(1);
  });
});

describe('intentForButtons', () => {
  it('grip press → grab', () => {
    expect(intentForButtons(snapshot({ grip: { prev: false, curr: true } }))).toBe<Intent>('grab');
  });

  it('grip release → release', () => {
    expect(intentForButtons(snapshot({ grip: { prev: true, curr: false } }))).toBe<Intent>(
      'release'
    );
  });

  it('trigger press → spawn', () => {
    expect(intentForButtons(snapshot({ trigger: { prev: false, curr: true } }))).toBe<Intent>(
      'spawn'
    );
  });

  it('A/X press → color', () => {
    expect(intentForButtons(snapshot({ aButton: { prev: false, curr: true } }))).toBe<Intent>(
      'color'
    );
  });

  it('B/Y press → mode', () => {
    expect(intentForButtons(snapshot({ bButton: { prev: false, curr: true } }))).toBe<Intent>(
      'mode'
    );
  });

  it('stick beyond deadzone → scale', () => {
    expect(intentForButtons(snapshot({ stickY: -0.8 }))).toBe<Intent>('scale');
    expect(intentForButtons(snapshot({ stickY: 0.8 }))).toBe<Intent>('scale');
  });

  it('stick inside deadzone → none', () => {
    expect(intentForButtons(snapshot({ stickY: 0.05 }))).toBe<Intent>('none');
  });

  it('idle → none', () => {
    expect(intentForButtons(snapshot())).toBe<Intent>('none');
  });

  it('held (no edge) → none even while grip stays down', () => {
    expect(intentForButtons(snapshot({ grip: { prev: true, curr: true } }))).toBe<Intent>('none');
  });

  it('grab takes priority when grip and trigger fire on the same frame', () => {
    expect(
      intentForButtons(
        snapshot({
          grip: { prev: false, curr: true },
          trigger: { prev: false, curr: true },
        })
      )
    ).toBe<Intent>('grab');
  });

  it('grip edge fires exactly once (grab) over a press-hold-release sequence', () => {
    const frames: ButtonSnapshot[] = [
      snapshot({ grip: { prev: false, curr: false } }),
      snapshot({ grip: { prev: false, curr: true } }), // press
      snapshot({ grip: { prev: true, curr: true } }), // hold
      snapshot({ grip: { prev: true, curr: false } }), // release
    ];
    const intents = frames.map(intentForButtons);
    expect(intents).toEqual<Intent[]>(['none', 'grab', 'none', 'release']);
  });
});

// ---------------------------------------------------------------------------
// isClick — pure click-vs-drag discrimination (NDC distance < epsilon)
// ---------------------------------------------------------------------------

describe('isClick', () => {
  it('returns true when press and release are the same point (exact click)', () => {
    expect(isClick({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBe(true);
  });

  it('returns true when pointer moved within epsilon (tiny jitter)', () => {
    // 0.005 is half the default epsilon — comfortably a click
    expect(isClick({ x: 0, y: 0 }, { x: 0.005, y: 0.005 })).toBe(true);
  });

  it('returns false when pointer moved beyond epsilon (camera rotate / drag)', () => {
    // 0.1 NDC ≈ 50px on a 1000-wide canvas — clearly a drag
    expect(isClick({ x: 0, y: 0 }, { x: 0.1, y: 0.0 })).toBe(false);
    expect(isClick({ x: 0, y: 0 }, { x: 0.0, y: 0.1 })).toBe(false);
    expect(isClick({ x: 0, y: 0 }, { x: 0.08, y: 0.08 })).toBe(false);
  });

  it('is true exactly at the epsilon boundary (diagonal: sqrt(2)*eps)', () => {
    // A point exactly epsilon away along one axis should still be a click
    const eps = 0.01;
    expect(isClick({ x: 0, y: 0 }, { x: eps, y: 0 })).toBe(true);
    expect(isClick({ x: 0, y: 0 }, { x: 0, y: eps })).toBe(true);
  });

  it('respects a custom epsilon override', () => {
    const bigEps = 0.2;
    expect(isClick({ x: 0, y: 0 }, { x: 0.15, y: 0 }, bigEps)).toBe(true);
    expect(isClick({ x: 0, y: 0 }, { x: 0.25, y: 0 }, bigEps)).toBe(false);
  });
});
