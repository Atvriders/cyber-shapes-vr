import { describe, it, expect } from 'vitest';
import {
  detectHandSources,
  PoseVelocityTracker,
  PowersHandInput,
  type TkNetSink,
} from '../src/powers/handInput.js';
import type { Vec3 } from '@cyber-shapes/shared';

describe('detectHandSources', () => {
  it('is true when any source is a camera-tracked hand', () => {
    expect(detectHandSources([{ hand: {} }, null])).toBe(true);
  });
  it('is false for controller-only sources', () => {
    expect(detectHandSources([{}, { hand: undefined }])).toBe(false);
  });
  it('is false for an empty source set', () => {
    expect(detectHandSources([])).toBe(false);
  });
});

describe('PoseVelocityTracker', () => {
  it('derives velocity from the pose delta (m/s)', () => {
    const t = new PoseVelocityTracker();
    t.push({ x: 0, y: 0, z: 0 }, 1000);
    const v = t.push({ x: 1, y: 0, z: 0 }, 1100); // 1 m in 0.1 s → 10 m/s
    expect(v.x).toBeCloseTo(10, 6);
  });
  it('yields zero velocity on the first sample (no prior)', () => {
    const t = new PoseVelocityTracker();
    expect(t.push({ x: 5, y: 5, z: 5 }, 1000)).toEqual({ x: 0, y: 0, z: 0 });
  });
  it('reset() clears the history', () => {
    const t = new PoseVelocityTracker();
    t.push({ x: 0, y: 0, z: 0 }, 1000);
    t.push({ x: 1, y: 0, z: 0 }, 1100);
    t.reset();
    expect(t.velocity).toEqual({ x: 0, y: 0, z: 0 });
    // after reset, the next push is a fresh first sample → zero
    expect(t.push({ x: 2, y: 0, z: 0 }, 1200)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// --- PowersHandInput orchestration (mocked renderer + net) ------------------

interface Vec3Mock {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): Vec3Mock;
}
function makeVec3(): Vec3Mock {
  return {
    x: 0,
    y: 0,
    z: 0,
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    },
  };
}

function makeNet(): TkNetSink & { pulls: Array<{ hand: number; anchor: Vec3; dir: Vec3 }>; releases: Array<{ hand: number; v: Vec3 }>; hands: boolean[] } {
  return {
    pulls: [],
    releases: [],
    hands: [],
    sendTkHandsState(available) {
      this.hands.push(available);
    },
    sendTkPull(hand, anchor, dir) {
      this.pulls.push({ hand, anchor, dir });
    },
    sendTkRelease(hand, velocity) {
      this.releases.push({ hand, v: velocity });
    },
  };
}

/** A mock three renderer whose hands + controllers we drive from the test. */
function makeRenderer(opts: { anchor: Vec3; sources: Array<{ hand?: unknown }> }) {
  const listeners: Record<string, Array<() => void>> = {};
  const ctrlListeners: Array<Record<string, Array<() => void>>> = [{}, {}];
  const renderer = {
    _fireCtrl(i: number, type: string) {
      for (const fn of ctrlListeners[i][type] ?? []) fn();
    },
    _fireSession(type: string) {
      for (const fn of listeners[type] ?? []) fn();
    },
    xr: {
      isPresenting: true,
      getController(i: number) {
        return {
          addEventListener(type: string, fn: () => void) {
            (ctrlListeners[i][type] ??= []).push(fn);
          },
          getWorldDirection(v: { set(x: number, y: number, z: number): unknown }) {
            v.set(0, 0, 1); // +z; the seam negates to −z ray
            return v;
          },
        };
      },
      getHand() {
        return {
          joints: {
            'middle-finger-metacarpal': {
              getWorldPosition(v: { set(x: number, y: number, z: number): unknown }) {
                v.set(opts.anchor.x, opts.anchor.y, opts.anchor.z);
                return v;
              },
            },
          },
        };
      },
      getSession() {
        return {
          addEventListener(type: string, fn: () => void) {
            (listeners[type] ??= []).push(fn);
          },
          inputSources: opts.sources,
        };
      },
    },
  };
  return renderer;
}

describe('PowersHandInput — orchestration', () => {
  it('reports TK_HANDS_STATE(true) on inputsourceschange when a hand appears (once)', () => {
    const net = makeNet();
    const r = makeRenderer({ anchor: { x: 0, y: 1, z: 0 }, sources: [{ hand: {} }] });
    const hi = new PowersHandInput({ renderer: r as never, net, makeVec3 });
    hi.attachSession();
    expect(net.hands).toEqual([true]);
    // a redundant change with the same availability does not re-send
    r._fireSession('inputsourceschange');
    expect(net.hands).toEqual([true]);
  });

  it('streams a throttled TK_PULL while pinching and TK_RELEASE on release', () => {
    const net = makeNet();
    const r = makeRenderer({ anchor: { x: 0.1, y: 1.2, z: -0.3 }, sources: [{ hand: {} }] });
    const hi = new PowersHandInput({ renderer: r as never, net, makeVec3, pullIntervalMs: 50 });
    // pinch the RIGHT hand (index 1)
    r._fireCtrl(1, 'selectstart');
    hi.update(1000);
    hi.update(1010); // within the throttle → no second pull
    hi.update(1060); // past the throttle → a second pull
    expect(net.pulls.length).toBe(2);
    expect(net.pulls[0].hand).toBe(1);
    // the cone axis is the −z ray (renderer returns +z, the seam negates it)
    expect(net.pulls[0].dir).toEqual({ x: -0, y: -0, z: -1 });
    expect(net.pulls[0].anchor).toEqual({ x: 0.1, y: 1.2, z: -0.3 });
    // release → exactly one TK_RELEASE for that hand
    r._fireCtrl(1, 'selectend');
    expect(net.releases.length).toBe(1);
    expect(net.releases[0].hand).toBe(1);
  });

  it('is a no-op while not presenting (off-XR inertness)', () => {
    const net = makeNet();
    const r = makeRenderer({ anchor: { x: 0, y: 1, z: 0 }, sources: [{ hand: {} }] });
    r.xr.isPresenting = false;
    const hi = new PowersHandInput({ renderer: r as never, net, makeVec3 });
    r._fireCtrl(0, 'selectstart');
    hi.update(1000);
    expect(net.pulls.length).toBe(0);
  });
});
