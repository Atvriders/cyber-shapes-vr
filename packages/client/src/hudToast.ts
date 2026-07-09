/**
 * hudToast.ts — a minimal, reusable in-headset HUD toast panel (spec §7.13 birth
 * moment "in-rotation HUD toast"; plan C12, C0 binding 11: none existed, CREATE it).
 *
 * A small neon panel anchored in front of the camera that shows a transient
 * message ("GLYPH ADDED", "VOLT-17 JOINED", …) then fades. Camera-anchored so it
 * rides the headset without moving the rig (comfort — §6.3: HUD chrome never
 * displaces the vestibular anchor). LAZY: imports THREE, so a caller that needs it
 * pulls it into their (already-3D) chunk; the DOM-only funnel never touches it.
 *
 * Deliberately tiny + dependency-light: create → `show(text)` → the module fades
 * + hides itself via `update(dtMs)`. Reused by any in-headset notice, not just
 * glyphs.
 */

import * as THREE from 'three';

/** How long a toast stays fully visible before it begins to fade (ms). */
const TOAST_HOLD_MS = 2500;
/** Fade-out duration after the hold (ms). */
const TOAST_FADE_MS = 600;
/** Distance in front of the camera the toast floats (world units). */
const TOAST_DISTANCE = 2.2;
/** Vertical offset (below center so it doesn't block the play space). */
const TOAST_Y_OFFSET = -0.7;

export class HudToast {
  /** The toast mesh — add this to the camera (so it rides the head). */
  readonly mesh: THREE.Mesh;

  private readonly _canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _texture: THREE.CanvasTexture;
  private readonly _mat: THREE.MeshBasicMaterial;
  private _remainingMs = 0;

  /**
   * @param doc  The owning document (injectable for tests / non-window hosts).
   */
  constructor(doc: Document = document) {
    this._canvas = doc.createElement('canvas');
    this._canvas.width = 512;
    this._canvas.height = 128;
    this._ctx = this._canvas.getContext('2d')!;

    this._texture = new THREE.CanvasTexture(this._canvas);
    this._mat = new THREE.MeshBasicMaterial({
      map: this._texture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    const geo = new THREE.PlaneGeometry(1.6, 0.4);
    this.mesh = new THREE.Mesh(geo, this._mat);
    this.mesh.position.set(0, TOAST_Y_OFFSET, -TOAST_DISTANCE);
    this.mesh.renderOrder = 999; // draw on top of the world
    this.mesh.visible = false;
  }

  /**
   * Show a toast. `color` is the accent (a wisp/glyph color) — defaults to cyan.
   * Re-showing while one is up replaces it (latest wins) — a burst of births
   * doesn't stack panels.
   */
  show(text: string, color = '#00ffff'): void {
    this._draw(text, color);
    this._texture.needsUpdate = true;
    this._remainingMs = TOAST_HOLD_MS + TOAST_FADE_MS;
    this.mesh.visible = true;
    this._mat.opacity = 0.9;
  }

  /** Advance the fade timer. Call once per frame with the frame delta (ms). */
  update(dtMs: number): void {
    if (this._remainingMs <= 0) return;
    this._remainingMs -= dtMs;
    if (this._remainingMs <= 0) {
      this._remainingMs = 0;
      this._mat.opacity = 0;
      this.mesh.visible = false;
      return;
    }
    // Fade over the last TOAST_FADE_MS of the lifetime.
    this._mat.opacity =
      this._remainingMs > TOAST_FADE_MS ? 0.9 : (this._remainingMs / TOAST_FADE_MS) * 0.9;
  }

  dispose(): void {
    this._texture.dispose();
    this._mat.dispose();
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
  }

  private _draw(text: string, color: string): void {
    const w = this._canvas.width;
    const h = this._canvas.height;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0, 10, 30, 0.55)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = color;
    ctx.font = 'bold 44px Courier New, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillText(text, w / 2, h / 2);
    ctx.shadowBlur = 0;
  }
}
