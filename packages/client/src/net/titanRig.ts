/**
 * titanRig.ts — Task C17 (F7 Titan Protocol) client rig-scale math (spec §7.7).
 *
 * PURE + Three-free so the rig-scale-1 PARITY is unit-testable without a WebGL
 * context. The player rig `Group` (camera + controller groups) scales 1→5 (10
 * behind a second button) ABOUT THE FLOOR POINT — not the camera — so a growing
 * giant's feet stay planted (the eye rises; the world becomes a city at their
 * feet). The environment NEVER scales; only the rig (spec §7.7 / §6.3 comfort).
 *
 * The transform that scales a rig (starting at origin/identity) uniformly by `s`
 * about a fixed world floor point `P = (px, 0, pz)` while keeping P fixed:
 *
 *     worldOf(local) = rigPosition + s · local     (rig at origin ⇒ local ≡ world at s=1)
 *     want worldOf(P) = P  ⇒  rigPosition = P · (1 − s)
 *
 * At s = 1 this yields rigPosition = 0 and scale = 1 — the IDENTITY transform, so
 * the render + OrbitControls path is byte-identical to Phase B (the parity anchor).
 */

/** A rig transform: uniform `scale` + a position offset (both applied to the Group). */
export interface RigTransform {
  scale: number;
  position: { x: number; y: number; z: number };
}

/**
 * The rig transform that scales the rig by `scale` about the FLOOR point directly
 * below the head (`floorX`, y=0, `floorZ`). `scale = 1` returns the IDENTITY
 * transform (scale 1, position {0,0,0}) — the rig-scale-1 parity guarantee.
 *
 * A non-finite / non-positive scale is treated as 1 (never NaN the rig).
 */
export function rigTransformForScale(scale: number, floorX: number, floorZ: number): RigTransform {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const px = Number.isFinite(floorX) ? floorX : 0;
  const pz = Number.isFinite(floorZ) ? floorZ : 0;
  // `+ 0` normalises a `-0` (e.g. −7.5 · 0) to `0` so scale 1 is EXACTLY identity.
  return {
    scale: s,
    // rigPosition = P · (1 − s); the floor point (y=0) keeps position y=0 too.
    position: { x: px * (1 - s) + 0, y: 0, z: pz * (1 - s) + 0 },
  };
}

/** True iff a rig transform is the exact identity (scale 1, position origin). */
export function isIdentityRig(t: RigTransform): boolean {
  return t.scale === 1 && t.position.x === 0 && t.position.y === 0 && t.position.z === 0;
}
