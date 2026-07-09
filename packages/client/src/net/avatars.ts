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
  /** Task C17: the current remote rig scale (1 for a normal player). */
  playerScale: number;
  /**
   * Task C28 (F17 Daemon Crew): true iff this remote peer is a synthetic DAEMON
   * (`PlayerInfo.synthetic`, a `DMN-` callsign). The head renders with a brighter
   * non-humanoid DRONE emissive and the nameplate carries a "DAEMON" badge — so a
   * daemon never reads as a human player (protects the "every ghost is real" line).
   */
  synthetic: boolean;
}

/** The fixed drone hue for a synthetic (daemon) avatar — a cold cyan, never a player color. */
const DAEMON_DRONE_HEX = 0x00e5ff;

// ---------------------------------------------------------------------------
// Task C17 (F7 Titan Protocol) — remote avatar scaling.
//
// A titanized remote player carries `playerScale` on their presence (spec §7.7);
// the avatar head + hands + ring multiply by it so a giant reads as a giant on
// every screen. The NAMEPLATE scale is CLAMPED (spec §7.7: "nameplate scale
// clamped") — a 10× nameplate would blot out the screen and break the 5-m
// legibility rule, so it grows only slightly and its OFFSET tracks the (scaled)
// head so it still floats above the giant.
// ---------------------------------------------------------------------------

/** The remote nameplate never scales past this even for a 10× titan (legibility). */
const NAMEPLATE_MAX_SCALE = 1.6;
/** The base nameplate offset above the head (unscaled). */
const NAMEPLATE_BASE_OFFSET = 0.28;

/** The clamped nameplate scale for a given rig scale (a gentle sqrt growth). */
function nameplateScaleFor(playerScale: number): number {
  if (!Number.isFinite(playerScale) || playerScale <= 1) return 1;
  return Math.min(NAMEPLATE_MAX_SCALE, Math.sqrt(playerScale));
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
  colorHex: number,
  synthetic = false
): {
  canvas: CanvasLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  texture: THREE.CanvasTexture<any>;
} {
  const canvas = makeCanvasLike();
  const ctx = canvas.getContext('2d');
  if (ctx) drawNameplateText(ctx, name, colorHex, NAMEPLATE_W, NAMEPLATE_H, synthetic);
  // THREE.CanvasTexture accepts HTMLCanvasElement | OffscreenCanvas; cast for compatibility
  const texture = new THREE.CanvasTexture(canvas as unknown as OffscreenCanvas);
  return { canvas, texture };
}

function drawNameplateText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  name: string,
  colorHex: number,
  w: number,
  h: number,
  synthetic = false
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
  // Task C28 (F17 Daemon Crew): a synthetic peer carries a "DAEMON" badge above its
  // callsign so it is unmistakably NOT a human player (§7.17 narration guard).
  if (synthetic) {
    ctx.font = 'bold 12px Courier New, monospace';
    ctx.fillText('◆ DAEMON', w / 2, h * 0.3);
    ctx.font = 'bold 18px Courier New, monospace';
    ctx.fillText(name, w / 2, h * 0.66);
  } else {
    ctx.fillText(name, w / 2, h / 2);
  }
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
   * Task C33 (F22 Desktop Command): the live remote peer ids, for the desktop
   * FOLLOW camera's target cycle (§7.22 — Tab cycles residents). Render-only.
   */
  ids(): string[] {
    return [...this.avatars.keys()];
  }

  /**
   * Create (or update name/color of) the avatar for `player`.
   * Idempotent: calling again for the same id does NOT add duplicates.
   */
  upsert(player: PlayerInfo): void {
    const synthetic = player.synthetic === true;
    const existing = this.avatars.get(player.id);
    if (existing) {
      // Update color + nameplate if they changed (a synthetic peer keeps its drone hue).
      this._applyColor(existing, player.color);
      this._refreshNameplate(existing, player.name, player.color);
      // Task C17: a re-upsert may carry an updated playerScale (presence refresh).
      if (player.playerScale !== undefined) this.setPlayerScale(player.id, player.playerScale);
      return;
    }

    const { headGeo, handGeo, ringGeo } = getSharedGeos();
    // Task C28 (F17 Daemon Crew): a synthetic peer renders as a cold-cyan DRONE, not a
    // player-colored humanoid — a distinct non-humanoid read (§7.17 styling).
    const colorHex = synthetic
      ? DAEMON_DRONE_HEX
      : CYBER_COLORS[player.color % CYBER_COLORS.length] ?? CYBER_COLORS[0];

    // Head
    const headMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: synthetic ? 1.0 : 0.6, // a brighter drone core
      metalness: synthetic ? 0.8 : 0.3,
      roughness: synthetic ? 0.2 : 0.4,
      wireframe: synthetic, // a non-humanoid wireframe drone shell
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

    // Nameplate (canvas sprite plane above head) — DAEMON badge for a synthetic peer.
    const { canvas: nameplateCanvas, texture: nameplateTexture } = makeNameplateCanvas(
      player.name,
      colorHex,
      synthetic
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
      playerScale: 1,
      synthetic,
    };

    this.avatars.set(player.id, entry);

    // Task C17: apply an initial playerScale from presence (a late joiner may land
    // mid-titan). Default 1 leaves the avatar byte-identical to a non-titan avatar.
    if (player.playerScale !== undefined && player.playerScale !== 1) {
      this.setPlayerScale(player.id, player.playerScale);
    }
  }

  /**
   * Task C17 (F7 Titan Protocol): scale a remote player's avatar by `playerScale`
   * (spec §7.7 — remote clients multiply avatar scale by presence playerScale). The
   * head + hands + ring scale directly; the NAMEPLATE scale is CLAMPED (legibility)
   * and its offset tracks the scaled head. A no-op if the player has no avatar.
   */
  setPlayerScale(playerId: string, playerScale: number): void {
    const entry = this.avatars.get(playerId);
    if (!entry) return;
    const s = Number.isFinite(playerScale) && playerScale > 0 ? playerScale : 1;
    entry.playerScale = s;
    entry.head.scale.setScalar(s);
    entry.hands[0].scale.setScalar(s);
    entry.hands[1].scale.setScalar(s);
    entry.ring.scale.setScalar(s);
    // Nameplate: clamped scale + offset tracks the scaled head so it still floats
    // above the giant without blotting out the screen.
    const npScale = nameplateScaleFor(s);
    entry.nameplate.scale.setScalar(npScale);
    entry.nameplate.position.y = this._nameplateOffset(entry);
  }

  /** The nameplate Y-offset above the (scaled) head. */
  private _nameplateOffset(entry: AvatarEntry): number {
    // The head half-height (0.125) grows with the rig scale; keep the nameplate a
    // little above the giant's crown.
    return NAMEPLATE_BASE_OFFSET * entry.playerScale;
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

      // Nameplate follows head (offset up — scaled for a titan, spec §7.7).
      entry.nameplate.position.set(hp.x, hp.y + this._nameplateOffset(entry), hp.z);
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
    // A synthetic (daemon) avatar keeps its fixed drone hue — never a player color.
    const colorHex = entry.synthetic
      ? DAEMON_DRONE_HEX
      : CYBER_COLORS[colorIndex % CYBER_COLORS.length] ?? CYBER_COLORS[0];
    const c = new THREE.Color(colorHex);
    entry.headMat.color.set(c);
    entry.headMat.emissive.set(c);
    entry.handMat.color.set(c);
    entry.handMat.emissive.set(c);
    entry.ringMat.color.set(c);
    entry.ringMat.emissive.set(c);
  }

  private _refreshNameplate(entry: AvatarEntry, name: string, colorIndex: number): void {
    const colorHex = entry.synthetic
      ? DAEMON_DRONE_HEX
      : CYBER_COLORS[colorIndex % CYBER_COLORS.length] ?? CYBER_COLORS[0];
    const ctx = entry.nameplateCanvas.getContext('2d');
    if (ctx) {
      drawNameplateText(ctx, name, colorHex, NAMEPLATE_W, NAMEPLATE_H, entry.synthetic);
      entry.nameplateTexture.needsUpdate = true;
    }
  }
}
