import type { RenderMode, ShapeType } from './types.js';
import { CYBER_COLORS, RENDER_MODES } from './constants.js';

// ---------------------------------------------------------------------------
// cycleColorIndex
// Pure: returns (i + 1) % CYBER_COLORS.length
// ---------------------------------------------------------------------------
export function cycleColorIndex(i: number): number {
  return (i + 1) % CYBER_COLORS.length;
}

// ---------------------------------------------------------------------------
// cycleRenderMode
// Order: both → solid → wireframe → both
// (follows RENDER_MODES constant order: ['both', 'solid', 'wireframe'])
// ---------------------------------------------------------------------------
export function cycleRenderMode(m: RenderMode): RenderMode {
  const idx = RENDER_MODES.indexOf(m);
  return RENDER_MODES[(idx + 1) % RENDER_MODES.length] as RenderMode;
}

// ---------------------------------------------------------------------------
// clampScale
// Clamp scale to [0.2, 3] (matches setShapeScale in packages/client/src/shapes.js line 139)
// ---------------------------------------------------------------------------
export function clampScale(s: number): number {
  return Math.max(0.2, Math.min(3, s));
}

// ---------------------------------------------------------------------------
// restYFor
// Per-shape resting half-height at scale 1, derived from geometry params in
// packages/client/src/shapes.js createGeometry() (lines 15-27).
//
// Derivation:
//   cube:         BoxGeometry(0.3, 0.3, 0.3)         → height/2 = 0.3/2      = 0.15   (line 16)
//   sphere:       SphereGeometry(0.18, 12, 8)         → radius   = 0.18               (line 17)
//   icosahedron:  IcosahedronGeometry(0.2, 0)         → radius   = 0.2                (line 18)
//   torus:        TorusGeometry(0.15, 0.06, 8, 16)    → r+tube   = 0.15+0.06  = 0.21  (line 19)
//   torusKnot:    TorusKnotGeometry(0.14, 0.04, 32,6) → r+tube   = 0.14+0.04  = 0.18  (line 20)
//   octahedron:   OctahedronGeometry(0.2, 0)          → radius   = 0.2                (line 21)
//   dodecahedron: DodecahedronGeometry(0.18, 0)       → radius   = 0.18               (line 22)
//   cylinder:     CylinderGeometry(0.15, 0.15, 0.3, 12) → height/2 = 0.3/2    = 0.15  (line 23)
//   cone:         ConeGeometry(0.18, 0.35, 10)        → height/2 = 0.35/2     = 0.175 (line 24)
//   tetrahedron:  TetrahedronGeometry(0.22, 0)        → radius   = 0.22               (line 25)
// ---------------------------------------------------------------------------
const HALF_HEIGHT_AT_SCALE_1: Record<ShapeType, number> = {
  cube: 0.15, // BoxGeometry(0.3, 0.3, 0.3) → height/2 = 0.3/2      (shapes.js line 16)
  sphere: 0.18, // SphereGeometry(0.18, …)    → radius = 0.18          (shapes.js line 17)
  icosahedron: 0.2, // IcosahedronGeometry(0.2, 0) → radius = 0.2          (shapes.js line 18)
  torus: 0.21, // TorusGeometry(0.15, 0.06, …) → r+tube = 0.15+0.06  (shapes.js line 19)
  torusKnot: 0.18, // TorusKnotGeometry(0.14, 0.04, …) → r+tube = 0.14+0.04 (shapes.js line 20)
  octahedron: 0.2, // OctahedronGeometry(0.2, 0) → radius = 0.2           (shapes.js line 21)
  dodecahedron: 0.18, // DodecahedronGeometry(0.18, 0) → radius = 0.18       (shapes.js line 22)
  cylinder: 0.15, // CylinderGeometry(0.15, 0.15, 0.3, 12) → height/2   (shapes.js line 23)
  cone: 0.175, // ConeGeometry(0.18, 0.35, 10) → height/2 = 0.35/2   (shapes.js line 24)
  tetrahedron: 0.22, // TetrahedronGeometry(0.22, 0) → radius = 0.22        (shapes.js line 25)
};

export function restYFor(type: ShapeType, scale: number): number {
  return HALF_HEIGHT_AT_SCALE_1[type] * scale;
}
