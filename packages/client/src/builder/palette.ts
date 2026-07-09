/**
 * builder/palette.ts — shape-type × color × render-mode palette constants (spec §7.23, C35).
 *
 * 10 types × 7 colors × 3 render modes → SPAWN_EXACT payload via paletteToSpawnPayload()
 * (re-exported from undo.ts which imports this).
 *
 * Pure: no Three.js, no DOM, no network. Tests run in node.
 */

import type { ShapeType, RenderMode } from '@cyber-shapes/shared';
import { SHAPE_TYPES, RENDER_MODES } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// The 10 shape types the palette exposes (mirrors SHAPE_TYPES from shared).
// ---------------------------------------------------------------------------
export const PALETTE_TYPES: readonly ShapeType[] = SHAPE_TYPES;

// ---------------------------------------------------------------------------
// The 7 neon colors by colorIndex (mirrors CYBER_COLORS ordering in shared).
// ---------------------------------------------------------------------------
export const PALETTE_COLOR_COUNT = 7;
export const PALETTE_COLORS: readonly number[] = [0, 1, 2, 3, 4, 5, 6] as const;

// ---------------------------------------------------------------------------
// The 3 render modes ('both' | 'solid' | 'wireframe').
// ---------------------------------------------------------------------------
export const PALETTE_RENDER_MODES: readonly RenderMode[] = RENDER_MODES;
