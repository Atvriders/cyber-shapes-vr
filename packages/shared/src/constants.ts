import type { ShapeType, RenderMode } from './types.js';

// ---------------------------------------------------------------------------
// Shape types — source: packages/client/src/shapes.js lines 3-6
// ---------------------------------------------------------------------------
export const SHAPE_TYPES: readonly ShapeType[] = [
  'cube',
  'sphere',
  'icosahedron',
  'torus',
  'torusKnot',
  'octahedron',
  'dodecahedron',
  'cylinder',
  'cone',
  'tetrahedron',
] as const;

// ---------------------------------------------------------------------------
// Render modes — source: packages/client/src/shapes.js lines 133-136
// ---------------------------------------------------------------------------
export const RENDER_MODES: readonly RenderMode[] = ['both', 'solid', 'wireframe'] as const;

// ---------------------------------------------------------------------------
// Colors (hex integers) — source: packages/client/src/shapes.js lines 8-10
// ---------------------------------------------------------------------------
export const CYBER_COLORS: readonly number[] = [
  0x00ffff, 0xff00ff, 0xff0066, 0x0066ff, 0x00ff66, 0x9900ff, 0xff6600,
] as const;

// ---------------------------------------------------------------------------
// World constants — source: packages/client/src/main.js line 34 (maxShapes: 40)
//                          packages/client/src/shapes.js line 59 (first 20 shapes get a light)
// ---------------------------------------------------------------------------
export const MAX_SHAPES = 40;
export const MAX_LIGHTS = 6;

// ---------------------------------------------------------------------------
// Physics constants — source: packages/client/src/physics.js lines 1-5
// ---------------------------------------------------------------------------
export const GRAVITY = -5;
export const BOUNCE = 0.5;
export const FRICTION = 0.98;
export const REST_THRESHOLD = 0.05;
export const REMOVE_DISTANCE = 50;
