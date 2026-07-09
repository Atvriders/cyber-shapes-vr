/**
 * wisps.ts — Task C14 (F4 Wisp Protocol), the QUEST/headset wisp renderer.
 *
 * The whole wisp tier renders in AT MOST `WISP_DRAW_CALL_BUDGET` (4) draw calls,
 * no matter how many wisps are present, with ZERO dynamic Lights (spec §6.5):
 *
 *   1) ONE InstancedMesh  — every wisp's neon billboard body (per-instance color
 *      via `instanceColor`; a MeshBasicMaterial, so no light is ever needed).
 *   2) ONE nameplate atlas — a single InstancedMesh of textured quads, each
 *      instance UV-offset into ONE shared atlas canvas (all callsigns baked into
 *      one texture → one draw call for every nameplate).
 *   3) ONE pre-allocated pulse TRACER (LineSegments) — reused for every pulse.
 *   4) ONE pre-allocated shockwave RING (a ring Mesh) — reused for every pulse.
 *
 * Slots recycle: a wisp is addressed by its server-assigned orbit slot index
 * (0…WISP_CAP−1); `remove(slot)` hides that instance, `upsert(slot, …)` reuses
 * it. Nothing is ever added/removed from the scene graph after construction, so
 * the draw count is CONSTANT — the structural render test asserts this.
 */

import * as THREE from 'three';
import { WISP_CAP, WISP_DRAW_CALL_BUDGET, CYBER_COLORS } from '@cyber-shapes/shared';

/** A wisp's live render state (what the coalesced buffer / local sim supplies). */
export interface WispRenderState {
  /** Server-assigned orbit slot (0…WISP_CAP−1) — the instance index. */
  slot: number;
  callsign: string;
  colorIndex: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
}

// Nameplate atlas: one cell per possible slot, tiled in a square-ish grid so all
// callsigns live in ONE texture (→ one draw call for every nameplate).
const CELL_W = 256;
const CELL_H = 64;
const ATLAS_COLS = 4; // 4×6 = 24 cells (WISP_CAP)
const ATLAS_ROWS = Math.ceil(WISP_CAP / ATLAS_COLS);
const ATLAS_W = CELL_W * ATLAS_COLS;
const ATLAS_H = CELL_H * ATLAS_ROWS;

/** A minimal canvas-like stub for headless/node (no DOM, no OffscreenCanvas). */
interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

function makeAtlasCanvas(): CanvasLike {
  if (typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = ATLAS_W;
    el.height = ATLAS_H;
    return el;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(ATLAS_W, ATLAS_H);
  }
  return {
    width: ATLAS_W,
    height: ATLAS_H,
    getContext: () => null,
  };
}

/** The Quest wisp field. Construct once with the scene; upsert/remove per wisp. */
export class WispField {
  /** The single group holding EVERY wisp draw object (added to the scene once). */
  readonly group = new THREE.Group();

  private readonly _bodies: THREE.InstancedMesh;
  private readonly _plates: THREE.InstancedMesh;
  private readonly _tracer: THREE.LineSegments;
  private readonly _shock: THREE.Mesh;

  private readonly _bodyGeo: THREE.IcosahedronGeometry;
  private readonly _bodyMat: THREE.MeshBasicMaterial;
  private readonly _plateGeo: THREE.InstancedBufferGeometry | THREE.PlaneGeometry;
  private readonly _plateMat: THREE.MeshBasicMaterial;
  private readonly _tracerGeo: THREE.BufferGeometry;
  private readonly _tracerMat: THREE.LineBasicMaterial;
  private readonly _shockGeo: THREE.RingGeometry;
  private readonly _shockMat: THREE.MeshBasicMaterial;

  private readonly _atlasCanvas: CanvasLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _atlasTexture: THREE.CanvasTexture<any>;
  /** The atlas 2D context, obtained ONCE at construction (null when unavailable). */
  private readonly _atlasCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;

  /** Which slots are currently live (drives `count` + hides free instances). */
  private readonly _live = new Set<number>();
  /** Per-instance UV offset (atlas cell) — set once from the slot index. */
  private readonly _uvOffset = new Float32Array(WISP_CAP * 2);

  private readonly _tmpMat = new THREE.Matrix4();
  private readonly _tmpColor = new THREE.Color();
  /** Shockwave animation timer (seconds remaining), 0 = idle. */
  private _shockTtl = 0;

  constructor(scene: THREE.Scene) {
    // ── (1) bodies: ONE InstancedMesh, MeshBasicMaterial (no light) ──────────
    this._bodyGeo = new THREE.IcosahedronGeometry(0.22, 1);
    this._bodyMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._bodies = new THREE.InstancedMesh(this._bodyGeo, this._bodyMat, WISP_CAP);
    this._bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._bodies.count = WISP_CAP; // fixed allocation; free slots are scaled to 0.
    // Per-instance color (neon identity) — requires an instanceColor buffer.
    this._bodies.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(WISP_CAP * 3),
      3
    );
    this._bodies.frustumCulled = false;

    // ── (2) nameplates: ONE atlas texture + ONE InstancedMesh of quads ───────
    this._atlasCanvas = makeAtlasCanvas();
    // Obtain the 2D context ONCE — jsdom without the `canvas` package throws here,
    // so probe defensively and cache null (blank atlas; the structure still holds).
    let atlasCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    try {
      atlasCtx = this._atlasCanvas.getContext('2d');
    } catch {
      atlasCtx = null;
    }
    this._atlasCtx = atlasCtx;
    this._atlasTexture = new THREE.CanvasTexture(this._atlasCanvas as unknown as OffscreenCanvas);
    this._plateMat = new THREE.MeshBasicMaterial({
      map: this._atlasTexture,
      transparent: true,
      depthWrite: false,
    });
    // A plane whose UVs are shifted per-instance into the atlas via an
    // `instanceUvOffset` attribute (each instance samples ONE atlas cell).
    const plate = new THREE.PlaneGeometry(0.7, 0.18);
    // Scale the base UVs down to a single cell, then the attribute offsets it.
    const uv = plate.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) / ATLAS_COLS, uv.getY(i) / ATLAS_ROWS);
    }
    this._plateGeo = plate;
    this._plates = new THREE.InstancedMesh(this._plateGeo, this._plateMat, WISP_CAP);
    this._plates.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._plates.count = WISP_CAP;
    this._plates.geometry.setAttribute(
      'instanceUvOffset',
      new THREE.InstancedBufferAttribute(this._uvOffset, 2)
    );
    // Inject the per-instance UV offset into the material's shader (one atlas cell).
    this._plateMat.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute vec2 instanceUvOffset;\n' +
        shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vMapUv += instanceUvOffset;');
    };
    this._plates.frustumCulled = false;

    // ── (3) pulse tracer: ONE pre-allocated LineSegments, reused ─────────────
    this._tracerGeo = new THREE.BufferGeometry();
    this._tracerGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3) // one segment (2 pts)
    );
    this._tracerMat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._tracer = new THREE.LineSegments(this._tracerGeo, this._tracerMat);
    this._tracer.frustumCulled = false;

    // ── (4) shockwave ring: ONE pre-allocated ring Mesh, reused ──────────────
    this._shockGeo = new THREE.RingGeometry(0.2, 0.26, 32);
    this._shockMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._shock = new THREE.Mesh(this._shockGeo, this._shockMat);
    this._shock.frustumCulled = false;

    // Assemble — after this, NOTHING is added/removed (draw count is constant).
    this.group.add(this._bodies, this._plates, this._tracer, this._shock);
    scene.add(this.group);

    // Start every instance hidden (scale 0), and prime each slot's atlas cell.
    for (let i = 0; i < WISP_CAP; i++) {
      this._hideInstance(i);
      const col = i % ATLAS_COLS;
      const row = Math.floor(i / ATLAS_COLS);
      this._uvOffset[i * 2] = col / ATLAS_COLS;
      this._uvOffset[i * 2 + 1] = 1 - (row + 1) / ATLAS_ROWS;
    }
    (this._plates.geometry.getAttribute('instanceUvOffset') as THREE.BufferAttribute).needsUpdate =
      true;
  }

  /** Number of live wisps (never exceeds WISP_CAP). */
  get count(): number {
    return this._live.size;
  }

  /** Add or update a wisp at its slot. Reuses the instance (slot recycling). */
  upsert(w: WispRenderState): void {
    const slot = w.slot;
    if (slot < 0 || slot >= WISP_CAP) return; // out-of-cap → over-cap spectate page (client).
    this._live.add(slot);

    // Body transform (billboard-ish: position + yaw around Y).
    this._tmpMat.makeRotationY(w.yaw);
    this._tmpMat.setPosition(w.pos.x, w.pos.y, w.pos.z);
    this._bodies.setMatrixAt(slot, this._tmpMat);
    this._bodies.instanceMatrix.needsUpdate = true;

    // Per-instance neon color.
    const hex = CYBER_COLORS[w.colorIndex % CYBER_COLORS.length] ?? 0x00ffff;
    this._tmpColor.setHex(hex);
    this._bodies.setColorAt(slot, this._tmpColor);
    if (this._bodies.instanceColor) this._bodies.instanceColor.needsUpdate = true;

    // Nameplate: draw the callsign into this slot's atlas cell + place the quad
    // just above the body.
    this._drawNameplate(slot, w.callsign, hex);
    this._tmpMat.identity();
    this._tmpMat.setPosition(w.pos.x, w.pos.y + 0.34, w.pos.z);
    this._plates.setMatrixAt(slot, this._tmpMat);
    this._plates.instanceMatrix.needsUpdate = true;
  }

  /** Remove a wisp (free its slot). Recyclable — a later upsert reuses the slot. */
  remove(slot: number): void {
    if (slot < 0 || slot >= WISP_CAP) return;
    this._live.delete(slot);
    this._hideInstance(slot);
  }

  /**
   * Fire the (unclamped, COSMETIC) pulse feedback from a wisp: a tracer to the
   * epicenter + a 300 ms shockwave ring. This is CLIENT-ONLY eye-candy — the
   * authoritative impulse is applied server-side (clamped). Reuses the two
   * pre-allocated objects, so no draw call is ever added.
   */
  pulse(slot: number, epicenter: { x: number; y: number; z: number }): void {
    if (slot < 0 || slot >= WISP_CAP || !this._live.has(slot)) return;
    // Tracer: wisp body → epicenter.
    this._bodies.getMatrixAt(slot, this._tmpMat);
    const from = new THREE.Vector3().setFromMatrixPosition(this._tmpMat);
    const pos = this._tracerGeo.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, epicenter.x, epicenter.y, epicenter.z);
    pos.needsUpdate = true;
    this._tracerMat.opacity = 1;
    // Shockwave ring at the epicenter (grows + fades over 300 ms).
    this._shock.position.set(epicenter.x, epicenter.y, epicenter.z);
    this._shock.scale.setScalar(0.3);
    this._shockMat.opacity = 1;
    this._shockTtl = 0.3;
  }

  /** Per-frame: fade the transient pulse feedback (tracer + shockwave). */
  update(dt: number): void {
    if (this._tracerMat.opacity > 0) {
      this._tracerMat.opacity = Math.max(0, this._tracerMat.opacity - dt * 4);
    }
    if (this._shockTtl > 0) {
      this._shockTtl = Math.max(0, this._shockTtl - dt);
      const t = 1 - this._shockTtl / 0.3;
      this._shock.scale.setScalar(0.3 + t * 2.2);
      this._shockMat.opacity = Math.max(0, 1 - t);
    }
  }

  /** Release GL resources. */
  dispose(): void {
    this.group.parent?.remove(this.group);
    this._bodyGeo.dispose();
    this._bodyMat.dispose();
    (this._plateGeo as THREE.BufferGeometry).dispose();
    this._plateMat.dispose();
    this._tracerGeo.dispose();
    this._tracerMat.dispose();
    this._shockGeo.dispose();
    this._shockMat.dispose();
    this._atlasTexture.dispose();
    this._bodies.dispose();
    this._plates.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _hideInstance(slot: number): void {
    // Scale to zero so the instance draws nothing but stays allocated (no add/remove).
    this._tmpMat.makeScale(0, 0, 0);
    this._bodies.setMatrixAt(slot, this._tmpMat);
    this._plates.setMatrixAt(slot, this._tmpMat);
    this._bodies.instanceMatrix.needsUpdate = true;
    this._plates.instanceMatrix.needsUpdate = true;
  }

  private _drawNameplate(slot: number, callsign: string, colorHex: number): void {
    const ctx = this._atlasCtx;
    if (!ctx) return; // headless — the atlas stays blank but the structure holds.
    const col = slot % ATLAS_COLS;
    const row = Math.floor(slot / ATLAS_COLS);
    const x = col * CELL_W;
    const y = row * CELL_H;
    ctx.clearRect(x, y, CELL_W, CELL_H);
    const hex = `#${colorHex.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + 4, y + 4, CELL_W - 8, CELL_H - 8);
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hex;
    ctx.fillText(callsign, x + CELL_W / 2, y + CELL_H / 2, CELL_W - 16);
    this._atlasTexture.needsUpdate = true;
  }
}

/** Re-exported for callers that render the wisp field (the budget assertion). */
export { WISP_DRAW_CALL_BUDGET };
