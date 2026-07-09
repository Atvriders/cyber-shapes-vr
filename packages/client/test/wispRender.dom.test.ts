/**
 * wispRender.dom.test.ts — Task C14 (F4) Quest wisp renderer STRUCTURAL budget
 * test (spec §6.5 render ledger). jsdom so the nameplate atlas `CanvasTexture`
 * has a document/canvas to draw into.
 *
 * The Quest wisp field is ONE InstancedMesh (all wisp billboards) + ONE nameplate
 * atlas + at most the two transient pulse-feedback objects (tracer + shockwave),
 * and ZERO Lights — the whole tier stays inside `WISP_DRAW_CALL_BUDGET` (4) draw
 * calls no matter how many wisps are present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { WISP_CAP, WISP_DRAW_CALL_BUDGET } from '@cyber-shapes/shared';
import { WispField } from '../src/wisps.ts';

/** Renderable = a leaf that issues a draw call (mesh/instanced/points/lines/sprite). */
function isRenderable(o: THREE.Object3D): boolean {
  const t = o as unknown as {
    isMesh?: boolean;
    isInstancedMesh?: boolean;
    isPoints?: boolean;
    isLine?: boolean;
    isLineSegments?: boolean;
    isSprite?: boolean;
  };
  return !!(t.isMesh || t.isInstancedMesh || t.isPoints || t.isLine || t.isLineSegments || t.isSprite);
}

function countRenderables(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (isRenderable(o)) n++;
  });
  return n;
}

function countLights(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as unknown as { isLight?: boolean }).isLight) n++;
  });
  return n;
}

describe('WispField — Quest render budget (spec §6.5)', () => {
  let scene: THREE.Scene;
  let field: WispField;

  beforeEach(() => {
    scene = new THREE.Scene();
    field = new WispField(scene);
  });

  afterEach(() => {
    field.dispose();
  });

  it('adds ≤ WISP_DRAW_CALL_BUDGET renderables and ZERO lights with an empty field', () => {
    expect(countRenderables(scene)).toBeLessThanOrEqual(WISP_DRAW_CALL_BUDGET);
    expect(countLights(scene)).toBe(0);
  });

  it('24 wisps at max still add ≤ WISP_DRAW_CALL_BUDGET renderables AND zero Lights', () => {
    for (let i = 0; i < WISP_CAP; i++) {
      field.upsert({
        slot: i,
        callsign: `VOLT-${i}`,
        colorIndex: i % 6,
        pos: { x: Math.cos(i) * 5, y: 2 + (i % 3), z: Math.sin(i) * 5 },
        yaw: (i / WISP_CAP) * Math.PI * 2,
      });
    }
    // Fire a pulse from a couple of wisps too — the transient tracer + shockwave
    // must still live INSIDE the budget (they are pre-allocated, not per-pulse).
    field.pulse(0, { x: 0, y: 1, z: 0 });
    field.pulse(5, { x: 1, y: 2, z: -1 });
    field.update(0.016);

    expect(countRenderables(scene)).toBeLessThanOrEqual(WISP_DRAW_CALL_BUDGET);
    expect(countLights(scene)).toBe(0);
  });

  it('recycles a slot: re-upserting the same slot never grows the draw count', () => {
    for (let i = 0; i < WISP_CAP; i++) {
      field.upsert({ slot: i, callsign: `A${i}`, colorIndex: 0, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    }
    const before = countRenderables(scene);
    // A wisp leaves (slot freed) then a new wisp takes the same slot.
    field.remove(3);
    field.upsert({ slot: 3, callsign: 'NEW-9', colorIndex: 4, pos: { x: 1, y: 1, z: 1 }, yaw: 1 });
    expect(countRenderables(scene)).toBe(before);
    expect(countLights(scene)).toBe(0);
  });

  it('exposes the live wisp count and clamps at WISP_CAP', () => {
    for (let i = 0; i < WISP_CAP; i++) {
      field.upsert({ slot: i, callsign: `Z${i}`, colorIndex: 0, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    }
    expect(field.count).toBe(WISP_CAP);
    field.remove(0);
    expect(field.count).toBe(WISP_CAP - 1);
  });
});

/**
 * C22.5 §6.1 audit — the wisp nameplate atlas (spec §6.5 "one nameplate atlas")
 * draws the CALLSIGN as text alongside the per-instance body color (never color
 * alone). jsdom's `HTMLCanvasElement.getContext('2d')` is unimplemented without
 * the `canvas` npm package (returns null — verified: the real atlas draw is a
 * silent no-op under plain jsdom, so the structural budget test above can never
 * catch a dropped `fillText`). This closes that gap by monkeypatching
 * `getContext` to a tiny recording stub — a dependency-free way to make the
 * "callsign accompanies color" claim genuinely test-enforced (fails if the
 * `ctx.fillText(callsign, …)` call in `wisps.ts#_drawNameplate` is ever removed).
 */
describe('WispField nameplate — §6.1 callsign-as-text redundancy (not color alone)', () => {
  it('draws the callsign as fillText into the atlas alongside the per-instance color', () => {
    const calls: { fillText: unknown[][]; fillStyleAtFillText: string[] } = {
      fillText: [],
      fillStyleAtFillText: [],
    };
    let currentFillStyle = '';
    const fakeCtx = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: (text: string, x: number, y: number, maxWidth?: number) => {
        calls.fillText.push([text, x, y, maxWidth]);
        calls.fillStyleAtFillText.push(currentFillStyle);
      },
      set fillStyle(v: string) {
        currentFillStyle = v;
      },
      get fillStyle() {
        return currentFillStyle;
      },
      font: '',
      textAlign: '' as CanvasTextAlign,
      textBaseline: '' as CanvasTextBaseline,
    };
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (type: string) => unknown;
    };
    const orig = proto.getContext;
    proto.getContext = () => fakeCtx;
    let localScene: THREE.Scene;
    let localField: WispField;
    try {
      localScene = new THREE.Scene();
      localField = new WispField(localScene);
      localField.upsert({
        slot: 0,
        callsign: 'VOLT-17',
        colorIndex: 2,
        pos: { x: 0, y: 0, z: 0 },
        yaw: 0,
      });
    } finally {
      proto.getContext = orig;
    }
    // The callsign was drawn as TEXT (readable regardless of color perception) —
    // not merely encoded as the instance color.
    expect(calls.fillText.some((c) => c[0] === 'VOLT-17')).toBe(true);
    localField!.dispose();
  });
});
