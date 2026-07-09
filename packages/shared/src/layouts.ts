/**
 * layouts.ts — the PURE, deterministic Workshop layout core (spec §7.23, F23,
 * plan C34). Shared by the server (validate on LAYOUT_SAVE / SET_BASELINE, bake
 * on save), the `tools/import-layout.mjs` no-UI rung, and the C35 builder UI.
 *
 * A `Layout` is an ORDINARY list of shapes with EXACT transforms (spec §7.23:
 * "It does NOT add a second world model: layouts are ordinary shapes with exact
 * transforms, restored through the same authoritative store"). The Workshop
 * composes the play space the show machinery already consumes — the showroom
 * baseline the C5 RESET restores, named variants, and authored glyph seeds.
 *
 * Two pure functions gate everything:
 *   • validateLayout(l, isBaseline) — schema + cap check. ≤ MAX_SHAPES for a play
 *     layout, ≤ MAX_SHAPES − METEOR_BUDGET for a BASELINE (a baseline must leave
 *     the siege its in-flight headroom — the cross-constant tie of §7.16/§7.23).
 *   • settleBake(layout, params, maxIterations) — a pure, DETERMINISTIC physics
 *     settle via the shared `stepBody`, run with `suspendDespawn: true` +
 *     DIAL_BOUNDS containment and with wind/freeze/attractors STRIPPED (the bake
 *     must not depend on a transient dial). Baseline bakes run under
 *     DEFAULT_PARAMS. Unsettled at the iteration bound → `settled: false`.
 *
 * PURE: no Date, no Math.random, no ws, no server import. Every function is total
 * (returns a discriminated result — never throws on hostile input).
 */

import type { ShapeType, RenderMode } from './types.js';
import type { Vec3 } from './net/types.js';
import { MAX_SHAPES, METEOR_BUDGET } from './constants.js';
import {
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  stepBody,
  type PhysicsParams,
  type PhysicsBody,
} from './physicsCore.js';

// ---------------------------------------------------------------------------
// Schema (spec §7.23 — normative here; the builder UI + import tool mirror it).
// ---------------------------------------------------------------------------

/**
 * One placed shape in a layout: the EXACT transform the show machinery restores.
 * `bobPhase`/`rotSpeed` are optional idle-animation fields (the shape's ambient
 * spin/bob); absent → a still shape (0 phase, 0 spin). Everything else mirrors a
 * `NetShape`'s authored fields (id/velocity/grabbed/grounded are NOT authored —
 * they are assigned by the store when the layout is spawned).
 */
export interface LayoutShape {
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  position: Vec3;
  rotation: Vec3;
  /** Ambient bob phase (spec §7.23 optional idle field). Absent → 0. */
  bobPhase?: number;
  /** Ambient rotation speed (spec §7.23 optional idle field). Absent → still. */
  rotSpeed?: Vec3;
}

/**
 * A named composition (spec §7.23). `themeId`/`baseParams` are authored context
 * that apply ONLY via an explicit LAYOUT_LOAD (a baseParams write + THEME_SET) —
 * a RESET restoring a BASELINE always runs under DEFAULT_PARAMS and IGNORES them
 * (C5's §D4 params invariant is unchanged — §7.23).
 */
export interface Layout {
  name: string;
  shapes: LayoutShape[];
  /** The theme applied ONLY on an explicit LAYOUT_LOAD (never on RESET). */
  themeId?: string;
  /** The standing law applied ONLY on an explicit LAYOUT_LOAD (never on RESET). */
  baseParams?: PhysicsParams;
  /** Author-supplied save time (ms). Opaque — never a determinism input. */
  savedAt: number;
  /** The composing member's callsign (attribution, §6.1). */
  author: string;
}

// ---------------------------------------------------------------------------
// Caps (spec §7.23). The cross-constant tie (§7.16): a baseline is capped so the
// first meteor volley — or a siege admission — can never starve it.
// ---------------------------------------------------------------------------

/** The ceiling for a PLAY layout (an ordinary named composition). */
export const LAYOUT_MAX_SHAPES = MAX_SHAPES;

/**
 * The ceiling for a BASELINE layout: `MAX_SHAPES − METEOR_BUDGET` (spec §7.23 "=
 * 12 at current constants" is the reserve, so the cap is 40 − 12 = 28). A baseline
 * MUST leave `METEOR_BUDGET` shapes of headroom so a composed showroom can never
 * be eaten by a meteor volley. The cross-constant test asserts
 * `BASELINE_MAX_SHAPES + METEOR_BUDGET ≤ MAX_SHAPES`.
 */
export const BASELINE_MAX_SHAPES = MAX_SHAPES - METEOR_BUDGET;

// ---------------------------------------------------------------------------
// validateLayout — the schema + cap admission gate.
// ---------------------------------------------------------------------------

/** The successful validation result (a narrowed, trusted layout). */
export interface ValidateOk {
  ok: true;
  layout: Layout;
}

/** A rejected validation with a machine-readable reason (never throws). */
export interface ValidateErr {
  ok: false;
  reason:
    | 'not-object'
    | 'bad-name'
    | 'bad-author'
    | 'bad-shapes'
    | 'too-many-shapes'
    | 'bad-shape'
    | 'bad-baseParams';
  /** The index of the first offending shape (for 'bad-shape'), else undefined. */
  index?: number;
}

export type ValidateResult = ValidateOk | ValidateErr;

const SHAPE_TYPE_SET: ReadonlySet<string> = new Set<ShapeType>([
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
]);

const RENDER_MODE_SET: ReadonlySet<string> = new Set<RenderMode>(['both', 'solid', 'wireframe']);

/** A finite plain-number Vec3 (never NaN/Infinity → never poisons the settle math). */
function isFiniteVec3(v: unknown): v is Vec3 {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['x'] === 'number' &&
    Number.isFinite(o['x']) &&
    typeof o['y'] === 'number' &&
    Number.isFinite(o['y']) &&
    typeof o['z'] === 'number' &&
    Number.isFinite(o['z'])
  );
}

/** Validate one LayoutShape (total; returns false on any malformation). */
function isValidLayoutShape(s: unknown): s is LayoutShape {
  if (s === null || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o['type'] !== 'string' || !SHAPE_TYPE_SET.has(o['type'])) return false;
  if (typeof o['renderMode'] !== 'string' || !RENDER_MODE_SET.has(o['renderMode'])) return false;
  if (typeof o['colorIndex'] !== 'number' || !Number.isInteger(o['colorIndex']) || o['colorIndex'] < 0)
    return false;
  if (typeof o['scale'] !== 'number' || !Number.isFinite(o['scale']) || o['scale'] <= 0) return false;
  if (!isFiniteVec3(o['position'])) return false;
  if (!isFiniteVec3(o['rotation'])) return false;
  if (o['bobPhase'] !== undefined && (typeof o['bobPhase'] !== 'number' || !Number.isFinite(o['bobPhase'])))
    return false;
  if (o['rotSpeed'] !== undefined && !isFiniteVec3(o['rotSpeed'])) return false;
  return true;
}

/**
 * Validate a layout against the §7.23 schema + the cap.
 *
 * A PLAY layout admits ≤ {@link LAYOUT_MAX_SHAPES}; a BASELINE (`isBaseline`)
 * admits ≤ {@link BASELINE_MAX_SHAPES} (the siege-reserve cap — §7.16/§7.23).
 * An EMPTY shapes array is admissible (a deliberately cleared showroom); the
 * count is only ever an UPPER bound.
 *
 * Total: returns a discriminated {@link ValidateResult}, never throws.
 */
export function validateLayout(l: unknown, isBaseline: boolean): ValidateResult {
  if (l === null || typeof l !== 'object') return { ok: false, reason: 'not-object' };
  const o = l as Record<string, unknown>;

  if (typeof o['name'] !== 'string' || o['name'].length === 0 || o['name'].length > 64)
    return { ok: false, reason: 'bad-name' };
  if (typeof o['author'] !== 'string' || o['author'].length > 64)
    return { ok: false, reason: 'bad-author' };

  const shapes = o['shapes'];
  if (!Array.isArray(shapes)) return { ok: false, reason: 'bad-shapes' };

  const cap = isBaseline ? BASELINE_MAX_SHAPES : LAYOUT_MAX_SHAPES;
  if (shapes.length > cap) return { ok: false, reason: 'too-many-shapes' };

  for (let i = 0; i < shapes.length; i++) {
    if (!isValidLayoutShape(shapes[i])) return { ok: false, reason: 'bad-shape', index: i };
  }

  // baseParams (optional) — must be a plain object when present (it is applied
  // ONLY via LAYOUT_LOAD; a malformed one is rejected so a load never writes junk).
  if (o['baseParams'] !== undefined && (o['baseParams'] === null || typeof o['baseParams'] !== 'object'))
    return { ok: false, reason: 'bad-baseParams' };

  const savedAt =
    typeof o['savedAt'] === 'number' && Number.isFinite(o['savedAt']) ? (o['savedAt'] as number) : 0;

  // Build the narrowed, trusted layout (copy the shapes so the caller can't alias
  // hostile references into the store; drop unknown keys).
  const layout: Layout = {
    name: o['name'],
    author: o['author'],
    savedAt,
    shapes: (shapes as LayoutShape[]).map((s) => ({
      type: s.type,
      colorIndex: s.colorIndex,
      renderMode: s.renderMode,
      scale: s.scale,
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      rotation: { x: s.rotation.x, y: s.rotation.y, z: s.rotation.z },
      ...(s.bobPhase !== undefined ? { bobPhase: s.bobPhase } : {}),
      ...(s.rotSpeed !== undefined
        ? { rotSpeed: { x: s.rotSpeed.x, y: s.rotSpeed.y, z: s.rotSpeed.z } }
        : {}),
    })),
    ...(typeof o['themeId'] === 'string' ? { themeId: o['themeId'] } : {}),
    ...(o['baseParams'] !== undefined ? { baseParams: o['baseParams'] as PhysicsParams } : {}),
  };
  return { ok: true, layout };
}

// ---------------------------------------------------------------------------
// settleBake — the pure, deterministic physics settle (BAKE, spec §7.23).
// ---------------------------------------------------------------------------

/** The outcome of a bake — the settled layout + whether it reached rest. */
export interface SettleBakeResult {
  /** The layout with every shape's position updated to its settled transform. */
  layout: Layout;
  /** True iff EVERY shape came to rest (grounded) within `maxIterations`. */
  settled: boolean;
  /** Non-fatal warnings (e.g. a shape that never grounded). */
  warnings: string[];
}

/** The fixed settle timestep (s). Fixed → the bake is deterministic + reproducible. */
export const SETTLE_DT = 1 / 60;

/** The default iteration bound for a bake (~10 s at 60 Hz — a still layout settles fast). */
export const SETTLE_MAX_ITERATIONS = 600;

/**
 * Strip every TRANSIENT dial force from a param set for baking (spec §7.23:
 * "strips wind/freeze/attractors"). A bake must reflect the SETTLED arrangement
 * under gravity + containment ONLY — never a dial that happened to be live when
 * the composer hit BAKE. The result keeps the base gravity + friction/restitution
 * but forces `wind: 0`, `freeze: false`, `attractors: []`, and applies the
 * DIAL_BOUNDS soft-sphere/speed-cap + `suspendDespawn: true` containment so a
 * shape can never fly out of the world mid-bake.
 */
export function bakeParams(base: PhysicsParams): PhysicsParams {
  return {
    ...base,
    // STRIP the transient dial forces — a bake is gravity + containment only.
    wind: { x: 0, y: 0, z: 0 },
    freeze: false,
    attractors: [],
    // Containment: keep every shape inside the world while it settles (§5.6). No
    // ceilingY — a bake settles onto the FLOOR, never a flipped-gravity ceiling.
    bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
    suspendDespawn: true,
  };
}

/**
 * BAKE a layout: run each shape through the shared `stepBody` under a stripped +
 * contained param set until every shape grounds (or `maxIterations` is hit). PURE
 * + DETERMINISTIC — a fixed dt, no Date/Math.random, and the SAME input always
 * yields the SAME settled positions. Baseline bakes pass `DEFAULT_PARAMS` (spec
 * §7.23) so the showroom settles under the same physics the booth runs.
 *
 * Shapes start at REST (velocity 0) — the settle only drops them onto the floor /
 * ceiling rest plane and lets them come to rest. A shape that never grounds within
 * the bound (e.g. authored inside the soft-sphere shell but perpetually bouncing)
 * leaves `settled: false` and a warning; its last position is still returned.
 *
 * @param layout        the composition to settle (never mutated — a copy is baked).
 * @param params        the physics envelope (baseline bakes pass DEFAULT_PARAMS).
 * @param maxIterations the settle bound (default {@link SETTLE_MAX_ITERATIONS}).
 */
export function settleBake(
  layout: Layout,
  params: PhysicsParams = DEFAULT_PARAMS,
  maxIterations: number = SETTLE_MAX_ITERATIONS
): SettleBakeResult {
  const bake = bakeParams(params);
  const warnings: string[] = [];

  // Build a PhysicsBody per shape (velocity 0 — a bake settles from rest). The
  // body's position is a fresh copy so `layout` is never mutated.
  const bodies: PhysicsBody[] = layout.shapes.map((s) => ({
    position: { x: s.position.x, y: s.position.y, z: s.position.z },
    velocity: { x: 0, y: 0, z: 0 },
    scale: s.scale,
    type: s.type,
    grabbedBy: null,
    grounded: false,
  }));

  const iters = Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : SETTLE_MAX_ITERATIONS;
  let settled = false;
  for (let i = 0; i < iters; i++) {
    for (const b of bodies) stepBody(b, SETTLE_DT, bake);
    // All grounded → the arrangement is at rest; stop early (deterministic bound).
    if (bodies.every((b) => b.grounded)) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    const unsettled = bodies.reduce((n, b) => n + (b.grounded ? 0 : 1), 0);
    warnings.push(`${unsettled} shape(s) did not settle within ${iters} iterations`);
  }

  // Write the settled positions back onto a COPY of the layout (never mutate input).
  const baked: Layout = {
    ...layout,
    shapes: layout.shapes.map((s, i) => ({
      ...s,
      position: { x: bodies[i].position.x, y: bodies[i].position.y, z: bodies[i].position.z },
      rotation: { x: s.rotation.x, y: s.rotation.y, z: s.rotation.z },
      ...(s.rotSpeed !== undefined
        ? { rotSpeed: { x: s.rotSpeed.x, y: s.rotSpeed.y, z: s.rotSpeed.z } }
        : {}),
    })),
  };

  return { layout: baked, settled, warnings };
}

// ---------------------------------------------------------------------------
// layoutToSeeds — adapt a Layout's shapes to the ShowroomSeed shape the C5 RESET
// handler spawns. The RESET rebind hands the baked baseline's shapes here so the
// handler restores them through the SAME authoritative store as the v1 seed list
// (spec §7.23 "restored through the same authoritative store").
// ---------------------------------------------------------------------------

/** A spawn seed the ServerWorld.spawn / RESET handler consumes (mirrors ShowroomSeed). */
export interface LayoutSeed {
  type: ShapeType;
  position: Vec3;
  colorIndex: number;
  renderMode?: RenderMode;
  scale?: number;
}

/** Map a layout's authored shapes to the seed list the RESET handler restores. */
export function layoutToSeeds(layout: Layout): LayoutSeed[] {
  return layout.shapes.map((s) => ({
    type: s.type,
    position: { x: s.position.x, y: s.position.y, z: s.position.z },
    colorIndex: s.colorIndex,
    renderMode: s.renderMode,
    scale: s.scale,
  }));
}
