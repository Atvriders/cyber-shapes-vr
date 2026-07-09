/**
 * builder/undo.ts — OpStack: client-side inverse-op undo/redo (spec §7.23, C35).
 *
 * Design:
 *   • The SERVER stays authoritative. Undo/redo just emit BUILD ops (inverse of
 *     what was done) to the server through the same `send` callback.
 *   • `push(op, inverseOp)` records one undoable action.
 *   • `undo()` emits the inverse op and moves the pointer back.
 *   • `redo()` replays the forward op and moves the pointer forward.
 *   • Depth cap: ≤50 entries; push beyond 50 evicts the oldest (FIFO).
 *
 * ACK id-remap (THE subtle correctness piece, spec §7.23):
 *   When undo-of-DELETE emits a SPAWN_EXACT, the server assigns a NEW id
 *   to the re-spawned shape. The forward op in the redo chain still references
 *   the OLD (now-dead) id of the DELETE target. `onAck(opId, newId)` fixes this:
 *   it finds every pending forward-op DELETE that targeted the shape the SPAWN_EXACT
 *   re-created (matched by the SPAWN's opId → the pending redo DELETE's original
 *   `id` → replaced with `newId`). The redo chain stays valid across round trips.
 *
 * Stack clear triggers:
 *   • `clearOnLayoutLoad()`  — call on receiving LAYOUT_LOAD (spec §7.23).
 *   • `clearOnBuildExit()`   — call on build-mode exit / RESET (spec §7.23).
 *
 * Pure: no DOM, no Three.js. Re-exported snap helpers + paletteToSpawnPayload
 * live here so tests can import from one place.
 */

import type { ShapeType, RenderMode } from '@cyber-shapes/shared';
import { BUILD_KIND, SHAPE_TYPES, RENDER_MODES } from '@cyber-shapes/shared';
import { PALETTE_TYPES, PALETTE_RENDER_MODES } from './palette.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnShape {
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

/**
 * A BUILD op payload the client emits to the server (wire format for undo/redo).
 * Mirrors the ClientMsg `build` variant but typed for the builder.
 */
export type BuildOp =
  | { kind: typeof BUILD_KIND.SPAWN_EXACT; shape: Partial<SpawnShape> | Record<string, unknown>; opId: string }
  | { kind: typeof BUILD_KIND.SET_TRANSFORM; id: string; shape: Partial<SpawnShape> | Record<string, unknown>; opId: string }
  | { kind: typeof BUILD_KIND.DELETE; id: string; opId?: string }
  | { kind: typeof BUILD_KIND.LAYOUT_LOAD; name: string; opId?: string }
  | { kind: typeof BUILD_KIND.LAYOUT_SAVE; name: string; opId?: string }
  | { kind: typeof BUILD_KIND.LAYOUT_LIST; opId?: string }
  | { kind: typeof BUILD_KIND.SET_BASELINE; name: string; opId?: string }
  | { kind: typeof BUILD_KIND.GLYPH_SEED; points: Array<{ x: number; y: number }>; color: string; opId?: string }
  | { kind: number; [key: string]: unknown };

// ---------------------------------------------------------------------------
// OpStack
// ---------------------------------------------------------------------------

/** One entry in the undo/redo history. */
interface HistoryEntry {
  /** The forward op (what was done; emitted on REDO). */
  fwd: BuildOp;
  /** The inverse op (what un-does it; emitted on UNDO). */
  inv: BuildOp;
  /**
   * When inv is a SPAWN_EXACT (undo-of-DELETE), this is the opId of that
   * SPAWN_EXACT. The stack maps it to the server-assigned id via `onAck`.
   */
  spawnOpId?: string;
}

const MAX_DEPTH = 50;

export class OpStack {
  private _history: HistoryEntry[] = [];
  /** Points to the NEXT slot to fill (one past the current committed entry). */
  private _ptr = 0;
  private _send: (op: BuildOp) => void;
  /**
   * Live map from a SPAWN_EXACT opId → the server-assigned id.
   * Populated by `onAck`; consumed when a redo's DELETE op is emitted.
   */
  private _ackMap = new Map<string, string>();

  constructor(send: (op: BuildOp) => void) {
    this._send = send;
  }

  /** True when there is at least one entry to undo. */
  canUndo(): boolean {
    return this._ptr > 0;
  }

  /** True when there is at least one entry to redo. */
  canRedo(): boolean {
    return this._ptr < this._history.length;
  }

  /**
   * Record a new action. Clears any redo tail (a new action after undo
   * invalidates the redo chain). Evicts the oldest if depth > MAX_DEPTH.
   */
  push(op: BuildOp, inverseOp: BuildOp): void {
    // Truncate redo tail
    this._history.length = this._ptr;

    const entry: HistoryEntry = { fwd: op, inv: inverseOp };

    // If the inverse is a SPAWN_EXACT (undo-of-DELETE), capture its opId
    // so onAck can remap the id into the forward (DELETE) op when redo fires.
    if (inverseOp.kind === BUILD_KIND.SPAWN_EXACT) {
      const spawnOp = inverseOp as Extract<BuildOp, { kind: typeof BUILD_KIND.SPAWN_EXACT }>;
      if (spawnOp.opId) entry.spawnOpId = spawnOp.opId;
    }

    this._history.push(entry);
    this._ptr++;

    // Evict the oldest if over cap
    if (this._history.length > MAX_DEPTH) {
      this._history.shift();
      this._ptr = Math.max(0, this._ptr - 1);
    }
  }

  /**
   * Undo the most recent action: emit its inverse op.
   * Does nothing if there is nothing to undo.
   */
  undo(): void {
    if (!this.canUndo()) return;
    this._ptr--;
    const entry = this._history[this._ptr];
    this._send(entry.inv);
  }

  /**
   * Redo the most recently undone action: emit its forward op, substituting
   * any stale id with the server-assigned id from the ACK map.
   */
  redo(): void {
    if (!this.canRedo()) return;
    const entry = this._history[this._ptr];
    this._ptr++;

    // If the forward op is a DELETE and we have an ACK remap for the
    // corresponding SPAWN_EXACT inverse, substitute the new id before emitting.
    let opToSend: BuildOp = entry.fwd;
    if (
      entry.fwd.kind === BUILD_KIND.DELETE &&
      entry.spawnOpId &&
      this._ackMap.has(entry.spawnOpId)
    ) {
      const newId = this._ackMap.get(entry.spawnOpId)!;
      opToSend = { ...entry.fwd, id: newId } as BuildOp;
    }

    this._send(opToSend);
  }

  /**
   * Called when the server ACKs a SPAWN_EXACT with the newly assigned shape id.
   * Stores the opId → newId mapping so redo-of-DELETE can target the new id.
   *
   * @param spawnOpId  The opId of the SPAWN_EXACT that was ACK'd.
   * @param newId      The server-assigned shape id for the newly spawned shape.
   */
  onAck(spawnOpId: string, newId: string): void {
    this._ackMap.set(spawnOpId, newId);
  }

  /** Clear on LAYOUT_LOAD (spec §7.23). */
  clearOnLayoutLoad(): void {
    this._clear();
  }

  /** Clear on build-mode exit / RESET (spec §7.23). */
  clearOnBuildExit(): void {
    this._clear();
  }

  private _clear(): void {
    this._history = [];
    this._ptr = 0;
    this._ackMap.clear();
  }
}

// ---------------------------------------------------------------------------
// Snap helpers (pure, spec §7.23: 0.1 m grid snap + 15° angle snap).
// ---------------------------------------------------------------------------

const GRID_SNAP = 0.1;
const ANGLE_SNAP_DEG = 15;

/** Snap a single value to the nearest grid step, avoiding float drift. */
function snapValue(v: number, step: number): number {
  return parseFloat((Math.round(v / step) * step).toFixed(10));
}

/** Snap a position Vec3 to the nearest 0.1 m grid (drift-free). */
export function snapPosition(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: snapValue(pos.x, GRID_SNAP),
    y: snapValue(pos.y, GRID_SNAP),
    z: snapValue(pos.z, GRID_SNAP),
  };
}

/**
 * Snap an angle (degrees) to the nearest 15°.
 * Angles >360 or <-360 are first reduced by modulo. 360 wraps to 0.
 */
export function snapAngle(deg: number): number {
  // Normalise to (-360, 360] then snap
  const normalised = deg % 360;
  const snapped = Math.round(normalised / ANGLE_SNAP_DEG) * ANGLE_SNAP_DEG;
  // 360 → 0 and -0 → 0
  if (snapped === 360 || snapped === -360) return 0;
  if (Object.is(snapped, -0)) return 0;
  return snapped;
}

// ---------------------------------------------------------------------------
// paletteToSpawnPayload — map a palette selection to a SPAWN_EXACT BuildOp.
// ---------------------------------------------------------------------------

let _opCounter = 0;

/** Generate a unique opId for client-side correlation. */
function nextOpId(): string {
  return `build-${Date.now()}-${++_opCounter}`;
}

export interface PaletteSelection {
  typeIndex: number;
  colorIndex: number;
  renderModeIndex: number;
  position: { x: number; y: number; z: number };
  scale?: number;
}

/**
 * Map a palette selection (typeIndex/colorIndex/renderModeIndex/position) to
 * a SPAWN_EXACT BuildOp ready to send and push onto OpStack.
 */
export function paletteToSpawnPayload(sel: PaletteSelection): Extract<BuildOp, { kind: typeof BUILD_KIND.SPAWN_EXACT }> {
  const type = PALETTE_TYPES[sel.typeIndex] ?? PALETTE_TYPES[0];
  const renderMode = PALETTE_RENDER_MODES[sel.renderModeIndex] ?? 'solid';
  return {
    kind: BUILD_KIND.SPAWN_EXACT,
    opId: nextOpId(),
    shape: {
      type,
      colorIndex: sel.colorIndex,
      renderMode,
      scale: sel.scale ?? 1,
      position: { ...sel.position },
      rotation: { x: 0, y: 0, z: 0 },
    },
  };
}

// Re-export so imports from undo.ts get everything.
export { BUILD_KIND, SHAPE_TYPES, RENDER_MODES };
