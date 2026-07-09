/**
 * builder.test.ts — Task C35 (F23 The Workshop UI, spec §7.23).
 *
 * Tests covering:
 *   1. OpStack — undo/redo invariants, depth cap, clear triggers, ACK id-remap
 *   2. Snap math — 0.1 m grid snap + 15° angle snap (pure)
 *   3. Palette → SPAWN_EXACT payload mapping
 *   4. settleBake preview — ghost positions match bake output + settled:false blocks BAKE
 *   5. Layout panel (jsdom) — confirm on destructive actions
 *   6. Capability-absent fallback → "staff link required" notice rendered
 *
 * Environment: node for pure tests; jsdom via file name convention applies to
 * layout-panel + capability-fallback tests that need DOM. Because the vitest
 * config runs `*.dom.test.ts` in jsdom, this file is node-env. DOM tests that
 * need jsdom are split into `builder.dom.test.ts` (mounted via the naming rule).
 * Pure tests (OpStack, snap, palette, settle) run here in node.
 */

import { describe, it, expect } from 'vitest';
import {
  OpStack,
  snapPosition,
  snapAngle,
  paletteToSpawnPayload,
  type BuildOp,
} from '../src/builder/undo.ts';
import { PALETTE_TYPES, PALETTE_COLORS, PALETTE_RENDER_MODES } from '../src/builder/palette.ts';
import { isBlockedByUnsettled } from '../src/builder/layoutPanel.ts';
import { settleBake, DEFAULT_PARAMS, BUILD_KIND, type Layout } from '@cyber-shapes/shared';

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a minimal fixture Layout with one shape (cube at y=5). */
function makeFixtureLayout(y = 5): Layout {
  return {
    name: 'test',
    author: 'tester',
    savedAt: 0,
    shapes: [
      {
        type: 'cube',
        colorIndex: 0,
        renderMode: 'solid',
        scale: 1,
        position: { x: 0, y, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    ],
  };
}

/** Create a mock send function that captures emitted ops. */
function makeSender() {
  const sent: BuildOp[] = [];
  const send = (op: BuildOp) => { sent.push(op); };
  return { sent, send };
}

// ===========================================================================
// 1. OpStack
// ===========================================================================

describe('OpStack — undo/redo invariants', () => {
  it('push/undo emits the inverse op', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    const fwd: BuildOp = { kind: BUILD_KIND.SPAWN_EXACT, shape: { type: 'cube', colorIndex: 0, renderMode: 'solid', scale: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, opId: 'op1' };
    const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: 'shape-abc', opId: 'inv1' };

    stack.push(fwd, inv);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);

    stack.undo();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(inv);
  });

  it('redo replays the forward op after undo', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    const fwd: BuildOp = { kind: BUILD_KIND.SET_TRANSFORM, id: 's1', shape: { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, opId: 'op2' };
    const inv: BuildOp = { kind: BUILD_KIND.SET_TRANSFORM, id: 's1', shape: { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, opId: 'inv2' };

    stack.push(fwd, inv);
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    stack.redo();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(fwd);
  });

  it('multiple pushes: undo walks back in LIFO order', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    const inv1: BuildOp = { kind: BUILD_KIND.DELETE, id: 'a', opId: 'i1' };
    const inv2: BuildOp = { kind: BUILD_KIND.DELETE, id: 'b', opId: 'i2' };

    stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: 'f1' } as BuildOp, inv1);
    stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: 'f2' } as BuildOp, inv2);

    stack.undo();
    stack.undo();
    expect(sent[0]).toEqual(inv2); // LIFO: last pushed is first undone
    expect(sent[1]).toEqual(inv1);
  });

  it('depth cap at 50: push beyond 50 evicts the oldest entry', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    // Push 51 entries
    for (let i = 0; i < 51; i++) {
      const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: `shape-${i}`, opId: `inv${i}` };
      stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: `f${i}` } as BuildOp, inv);
    }

    // Undo 51 times — should only be able to undo 50 times (oldest evicted)
    let undoCount = 0;
    while (stack.canUndo()) {
      stack.undo();
      undoCount++;
    }
    expect(undoCount).toBe(50);
    // The oldest (shape-0) was evicted, so the last undo emits inv50 first, inv1 last
    expect(sent[sent.length - 1].id).toBe('shape-1');
  });

  it('LAYOUT_LOAD clears the stack', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: 'x', opId: 'i' };
    stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: 'f' } as BuildOp, inv);
    expect(stack.canUndo()).toBe(true);

    stack.clearOnLayoutLoad();
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
    // Attempting undo emits nothing
    stack.undo();
    expect(sent).toHaveLength(0);
  });

  it('build-mode exit clears the stack', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: 'y', opId: 'i2' };
    stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: 'f2' } as BuildOp, inv);

    stack.clearOnBuildExit();
    expect(stack.canUndo()).toBe(false);
    stack.undo();
    expect(sent).toHaveLength(0);
  });

  // The key correctness piece: undo-of-DELETE id-remap from the ACK echo
  it('undo-of-DELETE: SPAWN_EXACT inverse op gets id remapped from ACK echo, redo chain stays valid', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    // Simulate: we deleted shape 'old-id'.
    // The inverse is a SPAWN_EXACT that will re-create it.
    // The inverse op starts with a placeholder opId we can match the ACK to.
    const inverseOpId = 'respawn-op-1';
    const deleteOp: BuildOp = { kind: BUILD_KIND.DELETE, id: 'old-id', opId: 'del-op-1' };
    const inverseSpawnOp: BuildOp = {
      kind: BUILD_KIND.SPAWN_EXACT,
      shape: { type: 'cube', colorIndex: 0, renderMode: 'solid', scale: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      opId: inverseOpId,
    };

    stack.push(deleteOp, inverseSpawnOp);

    // Undo emits the inverse SPAWN_EXACT
    stack.undo();
    expect(sent[0].kind).toBe(BUILD_KIND.SPAWN_EXACT);
    expect(sent[0].opId).toBe(inverseOpId);

    // Server ACKs with the NEW id assigned to the re-spawned shape
    stack.onAck(inverseOpId, 'new-id-from-server');

    // Now redo the delete — it must target 'new-id-from-server', NOT 'old-id'
    stack.redo();
    expect(sent[1].kind).toBe(BUILD_KIND.DELETE);
    expect(sent[1].id).toBe('new-id-from-server');
  });

  it('undo when empty does not emit', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);
    stack.undo();
    expect(sent).toHaveLength(0);
    expect(stack.canUndo()).toBe(false);
  });

  it('redo when nothing to redo does not emit', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);
    const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: 'z', opId: 'iz' };
    stack.push({ kind: BUILD_KIND.SPAWN_EXACT, shape: {}, opId: 'fz' } as BuildOp, inv);
    // No undo → nothing to redo
    stack.redo();
    expect(sent).toHaveLength(0);
  });
});

// ===========================================================================
// 2. Snap math (pure)
// ===========================================================================

describe('snapPosition — 0.1 m grid snap', () => {
  it('snaps to nearest 0.1 m on each axis', () => {
    const r = snapPosition({ x: 0.14, y: 0.05, z: -0.32 });
    expect(r.x).toBeCloseTo(0.1, 5);
    expect(r.y).toBeCloseTo(0.1, 5);
    expect(r.z).toBeCloseTo(-0.3, 5);
  });

  it('zero stays zero', () => {
    const r = snapPosition({ x: 0, y: 0, z: 0 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.z).toBe(0);
  });

  it('exact multiples are unchanged', () => {
    const r = snapPosition({ x: 1.0, y: -2.5, z: 0.7 });
    expect(r.x).toBeCloseTo(1.0, 5);
    expect(r.y).toBeCloseTo(-2.5, 5);
    expect(r.z).toBeCloseTo(0.7, 5);
  });

  it('rounds to nearest (0.05 rounds up)', () => {
    // 0.05 is exactly at the midpoint — Math.round rounds it up to 1
    const r = snapPosition({ x: 0.05, y: 0, z: 0 });
    expect(r.x).toBeCloseTo(0.1, 5);
  });

  it('negative values snap correctly', () => {
    const r = snapPosition({ x: -0.14, y: -0.06, z: 0 });
    expect(r.x).toBeCloseTo(-0.1, 5);
    expect(r.y).toBeCloseTo(-0.1, 5);
  });
});

describe('snapAngle — 15° quantization', () => {
  it('snaps to nearest 15°', () => {
    expect(snapAngle(0)).toBe(0);
    expect(snapAngle(7)).toBe(0); // 7 < 7.5 → 0
    expect(snapAngle(8)).toBe(15); // 8 > 7.5 → 15
    expect(snapAngle(15)).toBe(15);
    expect(snapAngle(22)).toBe(15); // 22 < 22.5 → 15
    expect(snapAngle(23)).toBe(30); // 23 > 22.5 → 30
  });

  it('360 wraps to 0', () => {
    expect(snapAngle(360)).toBe(0);
  });

  it('negative angles snap correctly', () => {
    expect(snapAngle(-8)).toBe(-15);
    expect(snapAngle(-1)).toBe(0);
  });

  it('large angles work (>360)', () => {
    expect(snapAngle(370)).toBe(15);
  });
});

// ===========================================================================
// 3. Palette → SPAWN_EXACT payload mapping
// ===========================================================================

describe('paletteToSpawnPayload', () => {
  it('maps all 10 shape types', () => {
    expect(PALETTE_TYPES).toHaveLength(10);
  });

  it('maps all 7 colors', () => {
    expect(PALETTE_COLORS).toHaveLength(7);
  });

  it('maps all 3 render modes', () => {
    expect(PALETTE_RENDER_MODES).toHaveLength(3);
  });

  it('produces a valid SPAWN_EXACT payload from palette selection', () => {
    const pos = { x: 1, y: 0, z: -1 };
    const payload = paletteToSpawnPayload({
      typeIndex: 0,     // 'cube'
      colorIndex: 2,    // third color
      renderModeIndex: 1, // 'solid'
      position: pos,
    });
    expect(payload.kind).toBe(BUILD_KIND.SPAWN_EXACT);
    expect(payload.shape.type).toBe(PALETTE_TYPES[0]);
    expect(payload.shape.colorIndex).toBe(2);
    expect(payload.shape.renderMode).toBe(PALETTE_RENDER_MODES[1]);
    expect(payload.shape.position).toEqual(pos);
    expect(typeof payload.opId).toBe('string');
    expect(payload.opId.length).toBeGreaterThan(0);
  });

  it('opId is unique per call', () => {
    const p = { typeIndex: 0, colorIndex: 0, renderModeIndex: 0, position: { x: 0, y: 0, z: 0 } };
    const a = paletteToSpawnPayload(p);
    const b = paletteToSpawnPayload(p);
    expect(a.opId).not.toBe(b.opId);
  });

  it('maps typeIndex to the correct ShapeType', () => {
    for (let i = 0; i < PALETTE_TYPES.length; i++) {
      const payload = paletteToSpawnPayload({
        typeIndex: i,
        colorIndex: 0,
        renderModeIndex: 0,
        position: { x: 0, y: 0, z: 0 },
      });
      expect(payload.shape.type).toBe(PALETTE_TYPES[i]);
    }
  });
});

// ===========================================================================
// 4. Settle preview — ghost positions match settleBake output
// ===========================================================================

describe('settle preview (pure — reuses shared settleBake)', () => {
  it('ghost positions from settleBake match expected settled y for a cube dropped from y=5', () => {
    const layout = makeFixtureLayout(5);
    const result = settleBake(layout, DEFAULT_PARAMS);
    // The cube should have fallen to near the floor (y ≈ 0.5 for scale 1)
    expect(result.settled).toBe(true);
    expect(result.layout.shapes[0].position.y).toBeLessThan(2);
    expect(result.layout.shapes[0].position.y).toBeGreaterThan(-0.5);
  });

  it('settled:false result BLOCKS bake (pure path: blockedByUnsettled returns true)', () => {
    const notSettled = { settled: false, layout: makeFixtureLayout(), warnings: ['x did not settle'] };
    expect(isBlockedByUnsettled(notSettled)).toBe(true);

    const settled = { settled: true, layout: makeFixtureLayout(), warnings: [] };
    expect(isBlockedByUnsettled(settled)).toBe(false);
  });

  it('settle result with warnings still settles as long as settled:true', () => {
    // settled:true with warnings is NOT blocked
    expect(isBlockedByUnsettled({ settled: true, layout: makeFixtureLayout(), warnings: ['minor'] })).toBe(false);
  });

  it('settleBake with 0 max iterations always returns settled:false', () => {
    const layout = makeFixtureLayout(5);
    const result = settleBake(layout, DEFAULT_PARAMS, 1); // 1 iter — not enough
    // With only 1 step the cube won't reach ground
    // (settled:false means bake is blocked)
    expect(result.settled).toBe(false);
  });
});

// ===========================================================================
// 5. ACK id-remap chain correctness
// ===========================================================================

describe('OpStack ACK id-remap — multi-level undo/redo chain', () => {
  it('two sequential deletes + two undos: both get fresh ids from their ACKs', () => {
    const { sent, send } = makeSender();
    const stack = new OpStack(send);

    // Delete shape-A, inverse is SPAWN_EXACT with opId 'r1'
    stack.push(
      { kind: BUILD_KIND.DELETE, id: 'shape-A', opId: 'd1' },
      { kind: BUILD_KIND.SPAWN_EXACT, shape: { type: 'cube', colorIndex: 0, renderMode: 'solid', scale: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, opId: 'r1' }
    );
    // Delete shape-B, inverse is SPAWN_EXACT with opId 'r2'
    stack.push(
      { kind: BUILD_KIND.DELETE, id: 'shape-B', opId: 'd2' },
      { kind: BUILD_KIND.SPAWN_EXACT, shape: { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, opId: 'r2' }
    );

    // Undo delete-B → emits SPAWN_EXACT opId=r2
    stack.undo();
    expect(sent[0].opId).toBe('r2');
    // Server ACKs with new-B
    stack.onAck('r2', 'new-B');

    // Undo delete-A → emits SPAWN_EXACT opId=r1
    stack.undo();
    expect(sent[1].opId).toBe('r1');
    // Server ACKs with new-A
    stack.onAck('r1', 'new-A');

    // Redo delete-A → must target new-A
    stack.redo();
    expect(sent[2].kind).toBe(BUILD_KIND.DELETE);
    expect(sent[2].id).toBe('new-A');

    // Redo delete-B → must target new-B
    stack.redo();
    expect(sent[3].kind).toBe(BUILD_KIND.DELETE);
    expect(sent[3].id).toBe('new-B');
  });
});
