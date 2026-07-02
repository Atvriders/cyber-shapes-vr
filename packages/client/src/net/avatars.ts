/**
 * avatars.ts — Remote player avatar rendering (B8).
 *
 * Each remote player is represented by:
 *   - A neon HEAD mesh (box geometry, emissive MeshStandardMaterial colored from CYBER_COLORS)
 *   - TWO HAND meshes (sphere geometry, same emissive color)
 *   - A NAMEPLATE: a canvas-texture sprite plane floating above the head
 *   - A SPEAKING RING: a torus around the head that glows when speaking
 *
 * Geometry reuse: head and hand geometries are shared across all avatar instances
 * (single-allocation, disposed only on disposeAll). Materials/textures are per-avatar
 * (so each player has their own color + nameplate). Disposed on remove().
 *
 * Design notes:
 *   - upsert is idempotent: calling for an existing id updates name/color.
 *   - updatePose/setSpeaking/remove are no-ops if the id has no avatar.
 *   - remove() disposes per-avatar resources (materials + textures) and removes from scene.
 *   - disposeAll() disposes the shared geometries too.
 */

import * as THREE from 'three';
import { CYBER_COLORS } from '@cyber-shapes/shared';
import type { PlayerInfo, Pose } from '@cyber-shapes/shared';

/**
 * Client-side defence-in-depth (audit #3): a pose whose position/rotation carries
 * a NaN/Infinity must never be written to a THREE object — a NaN transform can
 * throw or produce garbage geometry inside the render loop, crashing every
 * client. The server now validates inbound poses, but we guard again here so a
 * bad value from any source is skipped rather than applied. Returns true only if
 * ALL supplied components are finite.
 */
function finite(...ns: number[]): boolean {
  for (const n of ns) if (!Number.isFinite(n)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Shared geometry (allocated once, reused across all avatars, disposed in disposeAll)
// ---------------------------------------------------------------------------
let _headGeo: THREE.BoxGeometry | null = null;
let _handGeo: THREE.SphereGeometry | null = null;
let _ringGeo: THREE.TorusGeometry | null = null;

function getSharedGeos(): {
  headGeo: THREE.BoxGeometry;
  handGeo: THREE.SphereGeometry;
  ringGeo: THREE.TorusGeometry;
} {
  if (!_headGeo) _headGeo = new THREE.BoxGeometry(0.2, 0.25, 0.2);
  if (!_handGeo) _handGeo = new THREE.SphereGeometry(0.06, 8, 6);
  if (!_ringGeo) _ringGeo = new THREE.TorusGeometry(0.18, 0.02, 8, 24);
  return { headGeo: _headGeo, handGeo: _handGeo, ringGeo: _ringGeo };
}

// ---------------------------------------------------------------------------
// Per-avatar data
// ---------------------------------------------------------------------------
interface AvatarEntry {
  playerId: string;
  // THREE objects added to the scene
  head: THREE.Mesh;
  hands: [THREE.Mesh, THREE.Mesh];
  ring: THREE.Mesh;
  nameplate: THREE.Mesh;
  // Per-avatar disposables
  headMat: THREE.MeshStandardMaterial;
  handMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshStandardMaterial;
  nameplateMat: THREE.MeshBasicMaterial;
  nameplateCanvas: CanvasLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nameplateTexture: THREE.CanvasTexture<any>;
  nameplatePlaneGeo: THREE.PlaneGeometry;
}

// ---------------------------------------------------------------------------
// Canvas nameplate helper
// ---------------------------------------------------------------------------
const NAMEPLATE_W = 256;
const NAMEPLATE_H = 64;

/** A minimal canvas-like stub for environments where neither OffscreenCanvas nor document is available (e.g. node/vitest). */
interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

function makeCanvasLike(): CanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(NAMEPLATE_W, NAMEPLATE_H);
  }
  if (typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = NAMEPLATE_W;
    el.height = NAMEPLATE_H;
    return el;
  }
  // Fallback stub for pure node (no DOM, no OffscreenCanvas): return a no-op object.
  return {
    width: NAMEPLATE_W,
    height: NAMEPLATE_H,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getContext(_type: '2d') {
      return null;
    },
  };
}

function makeNameplateCanvas(
  name: string,
  colorHex: number
): {
  canvas: CanvasLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  texture: THREE.CanvasTexture<any>;
} {
  const canvas = makeCanvasLike();
  const ctx = canvas.getContext('2d');
  if (ctx) drawNameplateText(ctx, name, colorHex, NAMEPLATE_W, NAMEPLATE_H);
  // THREE.CanvasTexture accepts HTMLCanvasElement | OffscreenCanvas; cast for compatibility
  const texture = new THREE.CanvasTexture(canvas as unknown as OffscreenCanvas);
  return { canvas, texture };
}

function drawNameplateText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  name: string,
  colorHex: number,
  w: number,
  h: number
): void {
  const css = `#${colorHex.toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,20,0.65)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = css;
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = css;
  ctx.font = 'bold 18px Courier New, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = css;
  ctx.shadowBlur = 8;
  ctx.fillText(name, w / 2, h / 2);
  ctx.shadowBlur = 0;
}

// ---------------------------------------------------------------------------
// Avatars class
// ---------------------------------------------------------------------------
export class Avatars {
  private readonly scene: THREE.Scene;
  private readonly avatars = new Map<string, AvatarEntry>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create (or update name/color of) the avatar for `player`.
   * Idempotent: calling again for the same id does NOT add duplicates.
   */
  upsert(player: PlayerInfo): void {
    const existing = this.avatars.get(player.id);
    if (existing) {
      // Update color + nameplate if they changed.
      this._applyColor(existing, player.color);
      this._refreshNameplate(existing, player.name, player.color);
      return;
    }

    const { headGeo, handGeo, ringGeo } = getSharedGeos();
    const colorHex = CYBER_COLORS[player.color % CYBER_COLORS.length] ?? CYBER_COLORS[0];

    // Head
    const headMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.6,
      metalness: 0.3,
      roughness: 0.4,
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.name = `avatar-head-${player.id}`;
    this.scene.add(head);

    // Hands
    const handMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.5,
      metalness: 0.3,
      roughness: 0.5,
    });
    const hand0 = new THREE.Mesh(handGeo, handMat);
    hand0.name = `avatar-hand0-${player.id}`;
    const hand1 = new THREE.Mesh(handGeo, handMat);
    hand1.name = `avatar-hand1-${player.id}`;
    this.scene.add(hand0);
    this.scene.add(hand1);

    // Speaking ring (initially invisible)
    const ringMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.name = `avatar-ring-${player.id}`;
    ring.visible = false;
    this.scene.add(ring);

    // Nameplate (canvas sprite plane above head)
    const { canvas: nameplateCanvas, texture: nameplateTexture } = makeNameplateCanvas(
      player.name,
      colorHex
    );
    const nameplatePlaneGeo = new THREE.PlaneGeometry(0.6, 0.15);
    const nameplateMat = new THREE.MeshBasicMaterial({
      map: nameplateTexture,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const nameplate = new THREE.Mesh(nameplatePlaneGeo, nameplateMat);
    nameplate.name = `avatar-nameplate-${player.id}`;
    // Offset above the head
    nameplate.position.y = 0.28;
    this.scene.add(nameplate);

    const entry: AvatarEntry = {
      playerId: player.id,
      head,
      hands: [hand0, hand1],
      ring,
      nameplate,
      headMat,
      handMat,
      ringMat,
      nameplateMat,
      nameplateCanvas,
      nameplateTexture,
      nameplatePlaneGeo,
    };

    this.avatars.set(player.id, entry);
  }

  /**
   * Apply the latest remote pose to the player's avatar meshes.
   * No-op if the player has no avatar.
   */
  updatePose(playerId: string, pose: Pose): void {
    const entry = this.avatars.get(playerId);
    if (!entry) return;

    // Head — skip the whole head/nameplate/ring update if any component is
    // non-finite (audit #3 defence-in-depth: never write NaN to a THREE object).
    const { p: hp, q: hq } = pose.head;
    if (finite(hp.x, hp.y, hp.z, hq.x, hq.y, hq.z, hq.w)) {
      entry.head.position.set(hp.x, hp.y, hp.z);
      entry.head.quaternion.set(hq.x, hq.y, hq.z, hq.w);

      // Nameplate follows head (offset up)
      entry.nameplate.position.set(hp.x, hp.y + 0.28, hp.z);
      entry.nameplate.quaternion.set(hq.x, hq.y, hq.z, hq.w);

      // Ring follows head too
      entry.ring.position.set(hp.x, hp.y, hp.z);
      entry.ring.quaternion.set(hq.x, hq.y, hq.z, hq.w);
    }

    // Hands
    for (let i = 0; i < 2; i++) {
      const handPose = pose.hands[i] ?? null;
      const mesh = entry.hands[i];
      if (handPose === null) {
        mesh.visible = false;
      } else if (
        finite(
          handPose.p.x,
          handPose.p.y,
          handPose.p.z,
          handPose.q.x,
          handPose.q.y,
          handPose.q.z,
          handPose.q.w
        )
      ) {
        mesh.visible = true;
        mesh.position.set(handPose.p.x, handPose.p.y, handPose.p.z);
        mesh.quaternion.set(handPose.q.x, handPose.q.y, handPose.q.z, handPose.q.w);
      }
      // A non-finite hand pose is skipped: the mesh keeps its last good transform.
    }
  }

  /**
   * Toggle the speaking indicator for a player. When speaking=true, a neon
   * glowing ring becomes visible around the avatar's head.
   * No-op if the player has no avatar.
   */
  setSpeaking(playerId: string, on: boolean): void {
    const entry = this.avatars.get(playerId);
    if (!entry) return;
    entry.ringMat.opacity = on ? 0.85 : 0;
    entry.ringMat.emissiveIntensity = on ? 1.2 : 0;
    entry.ring.visible = on;
  }

  /**
   * Remove a player's avatar from the scene and dispose all GPU resources.
   * A second call for the same id is a safe no-op.
   */
  remove(playerId: string): void {
    const entry = this.avatars.get(playerId);
    if (!entry) return;
    this.avatars.delete(playerId);

    // Remove from scene
    this.scene.remove(entry.head);
    this.scene.remove(entry.hands[0]);
    this.scene.remove(entry.hands[1]);
    this.scene.remove(entry.ring);
    this.scene.remove(entry.nameplate);

    // Dispose per-avatar materials + textures + nameplate geometry
    entry.headMat.dispose();
    entry.handMat.dispose();
    entry.ringMat.dispose();
    entry.nameplateMat.dispose();
    entry.nameplateTexture.dispose();
    entry.nameplatePlaneGeo.dispose();
  }

  /**
   * Dispose all avatars AND the shared geometries. Call on disconnect.
   */
  disposeAll(): void {
    for (const id of [...this.avatars.keys()]) {
      this.remove(id);
    }
    // Dispose shared geometries
    if (_headGeo) {
      _headGeo.dispose();
      _headGeo = null;
    }
    if (_handGeo) {
      _handGeo.dispose();
      _handGeo = null;
    }
    if (_ringGeo) {
      _ringGeo.dispose();
      _ringGeo = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _applyColor(entry: AvatarEntry, colorIndex: number): void {
    const colorHex = CYBER_COLORS[colorIndex % CYBER_COLORS.length] ?? CYBER_COLORS[0];
    const c = new THREE.Color(colorHex);
    entry.headMat.color.set(c);
    entry.headMat.emissive.set(c);
    entry.handMat.color.set(c);
    entry.handMat.emissive.set(c);
    entry.ringMat.color.set(c);
    entry.ringMat.emissive.set(c);
  }

  private _refreshNameplate(entry: AvatarEntry, name: string, colorIndex: number): void {
    const colorHex = CYBER_COLORS[colorIndex % CYBER_COLORS.length] ?? CYBER_COLORS[0];
    const ctx = entry.nameplateCanvas.getContext('2d');
    if (ctx) {
      drawNameplateText(ctx, name, colorHex, NAMEPLATE_W, NAMEPLATE_H);
      entry.nameplateTexture.needsUpdate = true;
    }
  }
}
