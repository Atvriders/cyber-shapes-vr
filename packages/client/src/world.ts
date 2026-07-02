/**
 * world.ts — ShapeStore: the single lifecycle + mutation API for shapes (A5).
 *
 * This is the keystone. Everything downstream (physics adapter A6, HUD A7,
 * controllers A8, and Phase B multiplayer) goes through this one class:
 *   - spawn / remove are the ONLY creation/deletion paths
 *   - setColor / setRenderMode / setScale / setGrab are the ONLY mutators
 *   - every change emits a typed ShapeEvent through onEvent — the network hook
 *     surface for Phase B (replicate local events out, apply remote events in).
 *
 * ShapeStore owns the shapes array, id assignment (via idFactory), the
 * maxShapes cap (evict oldest), and the MAX_LIGHTS budget (count LIVE lights —
 * never key off array index; that was a bug).
 */

import * as THREE from 'three';
import type { Shape, ShapeType, RenderMode } from '@cyber-shapes/shared';
import { MAX_LIGHTS, clampScale } from '@cyber-shapes/shared';
import {
  buildShapeObject,
  buildLight,
  applyColor,
  applyRenderMode,
  type ClientShape,
} from './shapes.js';

export type { ClientShape } from './shapes.js';

// ---------------------------------------------------------------------------
// ShapeEvent — the typed event union emitted on every store mutation.
// (contractual — do not change names/shapes; Phase B networking depends on it)
// ---------------------------------------------------------------------------
export type ShapeEvent =
  | { kind: 'spawn'; shape: ClientShape }
  | { kind: 'despawn'; id: string }
  | { kind: 'color'; id: string; colorIndex: number }
  | { kind: 'render'; id: string; mode: RenderMode }
  | { kind: 'scale'; id: string; scale: number }
  | { kind: 'grab'; id: string; peerId: string | null };

export interface ShapeStoreOptions {
  maxShapes: number;
  idFactory: () => string;
  onEvent?: (e: ShapeEvent) => void;
}

export class ShapeStore {
  private readonly scene: THREE.Scene;
  private readonly maxShapes: number;
  private readonly idFactory: () => string;
  private readonly onEvent?: (e: ShapeEvent) => void;

  private readonly _shapes: ClientShape[] = [];
  private readonly byId = new Map<string, ClientShape>();

  /**
   * When true (audit #15), the SERVER is authoritative for the shape SET, so the
   * store must NOT locally evict on spawn: a local eviction could delete a shape
   * the server still broadcasts (and the `state` handler never recreates unknown
   * ids), making that shape vanish on this client only. The server drives
   * despawns; local spawns while connected are client-predictions that the server
   * will reconcile (and evict on its own cap). Offline this stays false and the
   * Phase-A evict-oldest cap behaviour is unchanged.
   */
  private _serverAuthoritative = false;

  constructor(scene: THREE.Scene, opts: ShapeStoreOptions) {
    this.scene = scene;
    this.maxShapes = opts.maxShapes;
    this.idFactory = opts.idFactory;
    this.onEvent = opts.onEvent;
  }

  /**
   * Toggle server-authoritative mode (audit #15). Set true once connected (the
   * server owns the shape set + despawns); set false when offline/disconnected so
   * the local evict-oldest cap resumes.
   */
  setServerAuthoritative(on: boolean): void {
    this._serverAuthoritative = on;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------
  get shapes(): ClientShape[] {
    return this._shapes;
  }

  get(id: string): ClientShape | undefined {
    return this.byId.get(id);
  }

  // -------------------------------------------------------------------------
  // spawn — the ONLY creation path.
  // -------------------------------------------------------------------------
  spawn(init: Partial<Shape> & { type: ShapeType }): ClientShape {
    // Enforce the cap BEFORE inserting, by evicting the OLDEST shape. This
    // guarantees a despawn event precedes the spawn event.
    //
    // Audit #15: skip local eviction when server-authoritative — the server owns
    // the shape set and drives despawns, so evicting `_shapes[0]` locally could
    // delete a shape the server still broadcasts (vanishing only on this client).
    if (
      !this._serverAuthoritative &&
      this._shapes.length >= this.maxShapes &&
      this._shapes.length > 0
    ) {
      this.remove(this._shapes[0].id);
    }

    const shape: ClientShape = {
      // If the caller supplies an id (e.g. NetClient applying a server-authoritative
      // id from a 'welcome' or 'spawn' message), use it; otherwise generate a local id.
      id: (init as Partial<Shape> & { id?: string }).id ?? this.idFactory(),
      type: init.type,
      colorIndex: init.colorIndex ?? 0,
      renderMode: init.renderMode ?? 'both',
      scale: init.scale ?? 1,
      grabbedBy: init.grabbedBy ?? null,
      grounded: init.grounded ?? false,
      bobPhase: init.bobPhase ?? Math.random() * Math.PI * 2,
      rotSpeed: init.rotSpeed ?? {
        x: (Math.random() - 0.5) * 2,
        y: (Math.random() - 0.5) * 2,
        z: (Math.random() - 0.5) * 2,
      },
      velocity: init.velocity ?? { x: 0, y: 0, z: 0 },
    } as ClientShape;

    // Build render objects.
    const visual = buildShapeObject(shape);
    shape.group = visual.group;
    shape.solidMesh = visual.solidMesh;
    shape.wireMesh = visual.wireMesh;

    // Lighting: attach a PointLight only if the number of LIVE lights is under
    // MAX_LIGHTS. Count live lights — never key off array index.
    if (this.liveLightCount() < MAX_LIGHTS) {
      shape.light = buildLight(shape.colorIndex);
      shape.group.add(shape.light);
    }

    // Apply initial render state (visibility from renderMode; colors already
    // baked into materials by buildShapeObject, but apply for consistency).
    applyRenderMode(shape, shape.renderMode);

    this.scene.add(shape.group);
    this._shapes.push(shape);
    this.byId.set(shape.id, shape);

    this.emit({ kind: 'spawn', shape });
    return shape;
  }

  // -------------------------------------------------------------------------
  // remove — the ONLY deletion path (physics + out-of-bounds + eviction).
  // -------------------------------------------------------------------------
  remove(id: string): void {
    const shape = this.byId.get(id);
    if (!shape) return; // no-op if absent

    this.scene.remove(shape.group);

    // Dispose per-instance materials and light. Geometry is shared across shapes
    // of the same type (see _geometryCache in shapes.ts) and must NOT be disposed
    // here — use disposeGeometryCache() on full teardown only.
    (shape.solidMesh.material as THREE.Material).dispose();
    (shape.wireMesh.material as THREE.Material).dispose();
    if (shape.light) {
      shape.group.remove(shape.light);
      shape.light.dispose();
    }

    const idx = this._shapes.indexOf(shape);
    if (idx !== -1) this._shapes.splice(idx, 1);
    this.byId.delete(id);

    this.emit({ kind: 'despawn', id });
  }

  // -------------------------------------------------------------------------
  // rekey — change a shape's id in place (B6 tempId reconciliation).
  //
  // Used when a locally-predicted spawn (temp id `__local__:N`) is confirmed by
  // the server, which assigns a canonical id (`room:N`). This re-keys the SAME
  // ClientShape object — it does NOT create a new shape and does NOT emit a
  // spawn/despawn event (downstream must treat this as identity-preserving, not
  // a lifecycle change). Returns true on success; false if `oldId` is absent or
  // `newId` already exists (no mutation in either failure case).
  // -------------------------------------------------------------------------
  rekey(oldId: string, newId: string): boolean {
    if (oldId === newId) return false;
    const shape = this.byId.get(oldId);
    if (!shape) return false;
    if (this.byId.has(newId)) return false;

    shape.id = newId;
    this.byId.delete(oldId);
    this.byId.set(newId, shape);
    // Intentionally no emit — a rekey is the same object, not a new shape.
    return true;
  }

  // -------------------------------------------------------------------------
  // Mutators — each sets state, applies to render handles, and emits an event.
  // All are no-ops on an absent id.
  // -------------------------------------------------------------------------

  /**
   * Set the color to an ALREADY-VALID index. Cycling is the caller's job via
   * cycleColorIndex from shared — this does NOT auto-cycle.
   */
  setColor(id: string, colorIndex: number): void {
    const shape = this.byId.get(id);
    if (!shape) return;
    shape.colorIndex = colorIndex;
    applyColor(shape);
    this.emit({ kind: 'color', id, colorIndex });
  }

  setRenderMode(id: string, mode: RenderMode): void {
    const shape = this.byId.get(id);
    if (!shape) return;
    shape.renderMode = mode;
    applyRenderMode(shape, mode);
    this.emit({ kind: 'render', id, mode });
  }

  setScale(id: string, scale: number): void {
    const shape = this.byId.get(id);
    if (!shape) return;
    const clamped = clampScale(scale);
    shape.scale = clamped;
    shape.group.scale.setScalar(clamped);
    this.emit({ kind: 'scale', id, scale: clamped });
  }

  setGrab(id: string, peerId: string | null): void {
    const shape = this.byId.get(id);
    if (!shape) return;
    shape.grabbedBy = peerId;
    // Clear grounded when grabbed so updateShapeRender's y-clamp doesn't fight
    // the drag. On release, leave grounded as-is — physics re-derives it on the
    // next bounce/land. Forward-compatible with remote grabs (Phase B).
    if (peerId !== null) shape.grounded = false;
    this.emit({ kind: 'grab', id, peerId });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  private liveLightCount(): number {
    let n = 0;
    for (const s of this._shapes) if (s.light) n++;
    return n;
  }

  private emit(e: ShapeEvent): void {
    this.onEvent?.(e);
  }
}
