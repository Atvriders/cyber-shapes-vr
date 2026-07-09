/**
 * glyphs.ts — the PURE, deterministic glyph helpers (spec §7.13, F13 Neon
 * Guestbook, plan C12). Shared by the phone scribe (resample before submit), the
 * server (validate on `GLYPH_ADD` + assign a spiral-shell slot), and the client
 * renderers (batch positions).
 *
 * DETERMINISM is load-bearing: the same stroke resamples identically on every
 * device, and `spiralSlot(index)` maps a glyph's slot to the SAME world position
 * on the phone, the headset, the stage, and the server. So:
 *   - NO `Date`, NO `Math.random`, NO `performance.now`.
 *   - Only pure arithmetic; every function is total (never throws on bad input —
 *     it sanitises or returns a safe default so a hostile phone can't crash it).
 */

import { DIAL_BOUNDS } from './physicsCore.js';

/** A single stroke point in the phone's NORMALISED drawing space. */
export interface GlyphStrokePoint {
  x: number;
  y: number;
}

/**
 * Max points a resampled stroke carries on the wire (spec §7.13: "stroke
 * resampled ≤ 32 points"). Bounds the render cost (the fat-line batch) and the
 * `GLYPH_ADD` payload regardless of how frantically a phone scribbles.
 */
export const GLYPH_MAX_POINTS = 32;

/**
 * The radius of the spiral SHELL glyphs live on. Chosen OUTSIDE the play volume:
 * shapes are contained by `DIAL_BOUNDS.softSphereR` (18) — they bounce off that
 * soft sphere and never settle past it — so a shell at 26 can never be collided
 * with by a shape (the never-collides-with-shapes guarantee, spec §7.13). Still
 * well inside `REMOVE_DISTANCE` (50) so the shell is in-frustum for the stage cam.
 */
export const GLYPH_SHELL_RADIUS = DIAL_BOUNDS.softSphereR + 8; // 26

/** The vertical band the spiral shell fills (glyphs fan up/down a little). */
const GLYPH_SHELL_HEIGHT = 14;

/** The golden-angle step (radians) that de-clumps successive spiral slots. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.399963…

/** A finite in-band drawing coordinate (spec: normalised space, |c| ≤ 1). */
function inBounds(c: number): boolean {
  return Number.isFinite(c) && c >= -1 && c <= 1;
}

// ---------------------------------------------------------------------------
// resampleStroke — arc-length resample to ≤ max points (deterministic)
// ---------------------------------------------------------------------------

/**
 * Resample `points` to at most `max` points (default {@link GLYPH_MAX_POINTS}),
 * spaced by arc length so the glyph's SHAPE is preserved while the point count is
 * bounded. Non-finite points are dropped first. Endpoints are always kept.
 *
 * Deterministic: a pure function of the input array — same in, same out.
 *
 *  - `[]`         → `[]`
 *  - one point    → that point (a dot)
 *  - ≤ max points → returned unchanged (already small enough)
 *  - > max points → `max` samples along the polyline's cumulative arc length
 */
export function resampleStroke(
  points: readonly GlyphStrokePoint[],
  max: number = GLYPH_MAX_POINTS
): GlyphStrokePoint[] {
  const cap = Number.isInteger(max) && max > 0 ? max : GLYPH_MAX_POINTS;

  // 1. Drop non-finite points (a hostile phone can send NaN/Infinity).
  const clean: GlyphStrokePoint[] = [];
  for (const p of points) {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) clean.push({ x: p.x, y: p.y });
  }
  if (clean.length <= 1) return clean.map((p) => ({ x: p.x, y: p.y }));
  if (clean.length <= cap) return clean.map((p) => ({ x: p.x, y: p.y }));

  // 2. Cumulative arc length along the polyline.
  const cum: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    const dx = clean[i].x - clean[i - 1].x;
    const dy = clean[i].y - clean[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];

  // Degenerate (all points coincide): just take the first `cap` distinct-index
  // samples so the count is bounded and the result stays deterministic.
  if (total === 0) return clean.slice(0, cap).map((p) => ({ x: p.x, y: p.y }));

  // 3. Sample `cap` evenly-spaced arc-length targets (endpoints inclusive).
  const out: GlyphStrokePoint[] = [];
  let seg = 0;
  for (let k = 0; k < cap; k++) {
    const target = (total * k) / (cap - 1);
    // Advance the segment cursor until `target` falls inside [cum[seg], cum[seg+1]].
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = clean[seg];
    const b = clean[seg + 1];
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// ---------------------------------------------------------------------------
// validateGlyph — the server-side admission gate (bounds / count / finite)
// ---------------------------------------------------------------------------

/** The minimal shape the server validates before admitting a glyph. */
export interface GlyphCandidate {
  points: readonly GlyphStrokePoint[];
  color: string;
}

/** A hex color string (`#rgb` or `#rrggbb`) — the ONLY thing on the wire; no free text. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Validate a candidate glyph (spec §7.13 "server validates (bounds, count)").
 * A glyph is admissible iff:
 *   - it is an object with a `points` ARRAY of length 2..GLYPH_MAX_POINTS,
 *   - every point has FINITE x/y within the normalised [-1, 1] band, and
 *   - `color` is a hex color string (never free text — §6.1).
 *
 * Total: returns false for null/non-object/malformed input, never throws.
 */
export function validateGlyph(glyph: unknown): glyph is GlyphCandidate {
  if (glyph === null || typeof glyph !== 'object') return false;
  const g = glyph as Record<string, unknown>;

  const points = g['points'];
  if (!Array.isArray(points)) return false;
  if (points.length < 2 || points.length > GLYPH_MAX_POINTS) return false;
  for (const p of points) {
    if (p === null || typeof p !== 'object') return false;
    const pt = p as Record<string, unknown>;
    if (typeof pt['x'] !== 'number' || typeof pt['y'] !== 'number') return false;
    if (!inBounds(pt['x']) || !inBounds(pt['y'])) return false;
  }

  const color = g['color'];
  if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// spiralSlot — a deterministic position on a shell OUTSIDE the play volume
// ---------------------------------------------------------------------------

/** A world position (the same {x,y,z} shape the net layer uses). */
export interface GlyphSlot {
  x: number;
  y: number;
  z: number;
}

/**
 * Map a glyph's slot `index` to a deterministic position on an expanding spiral
 * SHELL that lives OUTSIDE the play volume (spec §7.13). A golden-angle spiral
 * fans successive glyphs around a cylinder of radius {@link GLYPH_SHELL_RADIUS}
 * while walking the y band, so:
 *   - the same index ALWAYS yields the same position (no Date/Math.random),
 *   - the radius is always > `DIAL_BOUNDS.softSphereR` (never collides with a
 *     shape, which is contained inside that soft sphere), and
 *   - distinct indices yield distinct positions (glyphs never stack).
 *
 * The radius grows a hair with the ring so a very full guestbook (512) doesn't
 * overlap on the y band, while staying inside `REMOVE_DISTANCE` for the camera.
 */
export function spiralSlot(index: number): GlyphSlot {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  const angle = i * GOLDEN_ANGLE;
  // The shell radius grows slowly with the slot count so a full book fans out
  // rather than perfectly overlapping the y band; bounded so it stays < 50.
  const radius = GLYPH_SHELL_RADIUS + (i % 64) * 0.15; // 26 → ≤ ~35.5
  // Walk the vertical band deterministically (a triangle wave over the ring).
  const ring = Math.floor(i / 64);
  const yPhase = ((i % 64) / 64) * 2 - 1; // -1..1 across each ring
  const y = yPhase * (GLYPH_SHELL_HEIGHT / 2) + (ring % 2 === 0 ? 0.5 : -0.5);
  return {
    x: Math.cos(angle) * radius,
    y,
    z: Math.sin(angle) * radius,
  };
}
