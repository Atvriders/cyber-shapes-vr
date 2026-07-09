/**
 * glyphSeeds.ts — the 50 pre-authored opener glyphs (spec §7.13, plan C12).
 *
 * "Pre-seed ~50 authored glyphs (hour-one never empty)." These are DETERMINISTIC,
 * hand-parameterised strokes (a small library of neon shapes — spirals, stars,
 * zig-zags, waves, loops) drawn in the same normalised [-1,1] space the phone
 * scribe uses. Marked `seeded: true` by the GlyphManager so they are the permanent
 * gallery (evict-exempt — spec §7.23; C34 keeps this contract). Pure: no Date, no
 * Math.random — the same seed set on every boot, so a re-seeded room is stable.
 */

import type { GlyphStrokePoint } from '@cyber-shapes/shared';
import { GLYPH_MAX_POINTS, CYBER_COLORS } from '@cyber-shapes/shared';
import type { GlyphManager } from './glyphManager.js';

/** Hex color strings for the seed palette (mirrors CYBER_COLORS, §6.1 attribution). */
const SEED_COLORS: readonly string[] = CYBER_COLORS.map(
  (c) => `#${c.toString(16).padStart(6, '0')}`
);

/** Clamp to the normalised drawing band. */
function clamp(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** A spiral opener (k arms, turns). */
function spiral(turns: number, scale: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  const n = GLYPH_MAX_POINTS;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = t * turns * 2 * Math.PI;
    const r = t * scale;
    pts.push({ x: clamp(Math.cos(a) * r), y: clamp(Math.sin(a) * r) });
  }
  return pts;
}

/** An n-point star (alternating inner/outer radius). */
function star(points: number, inner: number, outer: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  const steps = points * 2;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push({ x: clamp(Math.cos(a) * r), y: clamp(Math.sin(a) * r) });
  }
  return pts.slice(0, GLYPH_MAX_POINTS);
}

/** A sine wave across the canvas. */
function wave(cycles: number, amp: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  const n = GLYPH_MAX_POINTS;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ x: clamp(t * 2 - 1), y: clamp(Math.sin(t * cycles * 2 * Math.PI) * amp) });
  }
  return pts;
}

/** A zig-zag lightning bolt. */
function zigzag(segments: number, amp: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push({ x: clamp(t * 2 - 1), y: clamp((i % 2 === 0 ? amp : -amp) * (1 - t * 0.3)) });
  }
  return pts;
}

/** A closed loop / petal ring. */
function petals(count: number, scale: number): GlyphStrokePoint[] {
  const pts: GlyphStrokePoint[] = [];
  const n = GLYPH_MAX_POINTS;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = t * 2 * Math.PI;
    const r = (0.4 + 0.6 * Math.abs(Math.cos(count * a))) * scale;
    pts.push({ x: clamp(Math.cos(a) * r), y: clamp(Math.sin(a) * r) });
  }
  return pts;
}

/** Build the deterministic 50-glyph library. */
export function authoredGlyphStrokes(): Array<{ points: GlyphStrokePoint[]; color: string }> {
  const out: Array<{ points: GlyphStrokePoint[]; color: string }> = [];
  const shapes: GlyphStrokePoint[][] = [];
  // 10 spirals, 10 stars, 10 waves, 10 zigzags, 10 petals → 50 distinct openers.
  for (let i = 0; i < 10; i++) shapes.push(spiral(1 + i * 0.4, 0.6 + i * 0.03));
  for (let i = 0; i < 10; i++) shapes.push(star(4 + i, 0.35, 0.9));
  for (let i = 0; i < 10; i++) shapes.push(wave(1 + i, 0.4 + (i % 3) * 0.15));
  for (let i = 0; i < 10; i++) shapes.push(zigzag(4 + i, 0.5 + (i % 4) * 0.1));
  for (let i = 0; i < 10; i++) shapes.push(petals(2 + (i % 5), 0.7 + (i % 3) * 0.08));
  for (let i = 0; i < shapes.length; i++) {
    out.push({ points: shapes[i], color: SEED_COLORS[i % SEED_COLORS.length] });
  }
  return out;
}

/**
 * Seed a room's guestbook with the 50 authored glyphs (spec §7.13 — hour-one
 * never empty). Idempotent-by-caller: only call when the guestbook loaded empty.
 * Callsigns use the reserved `SEED-` prefix so they never collide with a live
 * player's callsign draw. Returns the seeded glyph entries.
 */
export function seedAuthoredGlyphs(gm: GlyphManager, roomId: string): number {
  const strokes = authoredGlyphStrokes();
  let n = 0;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const g = gm.seed({
      roomId,
      points: s.points,
      color: s.color,
      callsign: `SEED-${i.toString().padStart(2, '0')}`,
    });
    if (g) n++;
  }
  return n;
}
