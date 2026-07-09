/**
 * glyphRender.ts — the Neon Guestbook constellation renderer (spec §7.13 / §6.5,
 * plan C12). LAZY-loaded (the ONLY glyph module that imports THREE), so it lands
 * in an async chunk behind `import('./glyphRender.js')` from the headset/stage
 * render loop — NEVER from the phone scribe (funnel/crowd.ts stays DOM-only + the
 * < 100 KB size gate stays green).
 *
 * Render budget (spec §6.5 "in-headset glyphs"):
 *   - nearest ~32–48 glyphs → ONE merged fat-line batch (LineSegments, additive);
 *   - the rest → Points impostors (< 5 k points, 1 draw call), additive/neon —
 *     "which IS the constellation".
 *   - backfill is CHUNKED (~32 glyphs/frame) post-snapshot so a big guestbook
 *     never stalls a frame.
 *   - every glyph sits on the deterministic `spiralSlot` shell OUTSIDE the play
 *     volume (shared with the server / stage, so all screens agree).
 *
 * Visuals are manual-verify; this file is written to typecheck + build. The pure,
 * testable logic (slots, resample, validation) lives in the shared `glyphs.ts`.
 */

import * as THREE from 'three';
import { spiralSlot, CYBER_COLORS, type GlyphStrokePoint } from '@cyber-shapes/shared';

/** The wire glyph shape (mirrors GlyphNet — kept local so this stays leaf-y). */
export interface RenderGlyph {
  id: string;
  callsign: string;
  points: GlyphStrokePoint[];
  color: string;
  slotIndex: number;
  seeded?: boolean;
}

/** How many glyphs get the full fat-line treatment (spec §6.5: nearest 32–48). */
const NEAREST_FATLINE_COUNT = 48;
/** Chunked backfill: how many glyphs to ingest per frame (spec §7.13). */
const BACKFILL_PER_FRAME = 32;
/** The per-glyph local footprint radius on the shell (world units). */
const GLYPH_LOCAL_SCALE = 1.6;
/** Points-impostor budget (spec §6.5: < 5 k points). */
const MAX_IMPOSTOR_POINTS = 5000;

/** Parse a `#rgb`/`#rrggbb` hex string → a THREE.Color (falls back to cyan). */
function parseColor(hex: string): THREE.Color {
  try {
    return new THREE.Color(hex);
  } catch {
    return new THREE.Color(CYBER_COLORS[0]);
  }
}

/** A per-glyph world basis on the spiral shell (position + a facing frame). */
function glyphBasis(slotIndex: number): { pos: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const s = spiralSlot(slotIndex);
  const pos = new THREE.Vector3(s.x, s.y, s.z);
  // Face the world center (0, pos.y, 0): the glyph plane's normal points inward.
  const normal = new THREE.Vector3(-s.x, 0, -s.z).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  return { pos, right, up };
}

/**
 * The Neon Guestbook field. Owns two draw objects:
 *   - a LineSegments batch (the nearest glyphs' strokes, merged, additive), and
 *   - a Points cloud (impostors for the far glyphs — the constellation dust).
 * Call `setGlyphs` with the snapshot; `update(cameraPos)` re-selects the nearest
 * set + advances the chunked backfill; `add`/`remove`/`hide` react to live births.
 */
export class GlyphField {
  readonly group = new THREE.Group();

  private readonly _glyphs = new Map<string, RenderGlyph>();
  private readonly _hidden = new Set<string>();
  /** Pending backfill ingest queue (chunked ~32/frame). */
  private _pending: RenderGlyph[] = [];

  private readonly _lineGeom = new THREE.BufferGeometry();
  private readonly _lines: THREE.LineSegments;
  private readonly _pointsGeom = new THREE.BufferGeometry();
  private readonly _points: THREE.Points;

  /** id of the glyph currently spotlighted (birth highlight), or null. */
  private _highlightId: string | null = null;

  constructor() {
    // The fat-line batch (additive neon — no lights, spec §6.5). LineSegments is
    // the Quest-cheap stand-in for a fat-line material (1 draw call, vertex color).
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this._lines = new THREE.LineSegments(this._lineGeom, lineMat);
    this._lines.frustumCulled = false;

    // The impostor cloud (constellation dust). Additive points, 1 draw call.
    const pointMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.6,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this._points = new THREE.Points(this._pointsGeom, pointMat);
    this._points.frustumCulled = false;

    this.group.add(this._lines);
    this.group.add(this._points);
  }

  /** Number of glyphs currently in the field (test / debug surface). */
  get count(): number {
    return this._glyphs.size;
  }

  /** Queue the full guestbook snapshot for CHUNKED ingest (spec §7.13 backfill). */
  setGlyphs(glyphs: readonly RenderGlyph[]): void {
    this._glyphs.clear();
    this._hidden.clear();
    this._pending = glyphs.slice();
  }

  /** A live glyph birth — ingest immediately + rebuild the impostor cloud. */
  add(glyph: RenderGlyph): void {
    this._glyphs.set(glyph.id, glyph);
    this._rebuildImpostors();
  }

  /** A staff despawn / evict-oldest — drop the glyph everywhere. */
  remove(id: string): void {
    this._glyphs.delete(id);
    this._hidden.delete(id);
    if (this._highlightId === id) this._highlightId = null;
    this._rebuildImpostors();
  }

  /** The panic-key result — hide these ids on every screen (still in the bucket). */
  hide(ids: readonly string[]): void {
    for (const id of ids) this._hidden.add(id);
    this._rebuildImpostors();
  }

  /** Un-hide everything a panic hid (staff "all clear"). */
  clearHidden(): void {
    this._hidden.clear();
    this._rebuildImpostors();
  }

  /** Spotlight a glyph for the birth-moment highlight (3 s, driven by the caller). */
  highlight(id: string | null): void {
    this._highlightId = id;
  }

  /** The world position of a glyph's slot (the stage camera flies here on birth). */
  slotPosition(id: string): THREE.Vector3 | null {
    const g = this._glyphs.get(id);
    if (!g) return null;
    return glyphBasis(g.slotIndex).pos;
  }

  /**
   * Per-frame: advance the chunked backfill (~32 glyphs/frame) and re-select the
   * nearest fat-line set relative to `cameraPos`. Cheap when idle.
   */
  update(cameraPos: THREE.Vector3): void {
    // 1. Chunked backfill — ingest up to BACKFILL_PER_FRAME queued glyphs.
    if (this._pending.length > 0) {
      const chunk = this._pending.splice(0, BACKFILL_PER_FRAME);
      for (const g of chunk) this._glyphs.set(g.id, g);
      this._rebuildImpostors();
    }

    // 2. Select the nearest N visible glyphs → the fat-line batch.
    const visible = [...this._glyphs.values()].filter((g) => !this._hidden.has(g.id));
    visible.sort((a, b) => {
      const da = glyphBasis(a.slotIndex).pos.distanceToSquared(cameraPos);
      const db = glyphBasis(b.slotIndex).pos.distanceToSquared(cameraPos);
      return da - db;
    });
    const nearest = visible.slice(0, NEAREST_FATLINE_COUNT);
    this._rebuildLines(nearest);
  }

  dispose(): void {
    this._lineGeom.dispose();
    this._pointsGeom.dispose();
    (this._lines.material as THREE.Material).dispose();
    (this._points.material as THREE.Material).dispose();
    this.group.clear();
  }

  // -------------------------------------------------------------------------
  // Geometry builders
  // -------------------------------------------------------------------------

  /** Rebuild the merged fat-line batch from the nearest glyph set. */
  private _rebuildLines(nearest: readonly RenderGlyph[]): void {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const g of nearest) {
      const { pos, right, up } = glyphBasis(g.slotIndex);
      const c = parseColor(g.color);
      // A highlighted glyph blazes brighter (birth spotlight).
      const boost = g.id === this._highlightId ? 2.2 : 1;
      const pts = g.points;
      // Emit each polyline as consecutive segments (LineSegments = pairs).
      for (let i = 0; i < pts.length - 1; i++) {
        const a = this._localToWorld(pts[i], pos, right, up);
        const b = this._localToWorld(pts[i + 1], pos, right, up);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(c.r * boost, c.g * boost, c.b * boost, c.r * boost, c.g * boost, c.b * boost);
      }
    }
    this._lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this._lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this._lineGeom.attributes['position'].needsUpdate = true;
    this._lineGeom.computeBoundingSphere();
  }

  /** Rebuild the impostor Points cloud — one bright point per (visible) glyph. */
  private _rebuildImpostors(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    let n = 0;
    for (const g of this._glyphs.values()) {
      if (this._hidden.has(g.id)) continue;
      if (n >= MAX_IMPOSTOR_POINTS) break;
      const { pos } = glyphBasis(g.slotIndex);
      const c = parseColor(g.color);
      positions.push(pos.x, pos.y, pos.z);
      colors.push(c.r, c.g, c.b);
      n++;
    }
    this._pointsGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this._pointsGeom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this._pointsGeom.attributes['position'].needsUpdate = true;
    this._pointsGeom.computeBoundingSphere();
  }

  /** Map a normalised stroke point → a world position on the glyph's shell plane. */
  private _localToWorld(
    p: GlyphStrokePoint,
    pos: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3
  ): THREE.Vector3 {
    return new THREE.Vector3()
      .copy(pos)
      .addScaledVector(right, p.x * GLYPH_LOCAL_SCALE)
      .addScaledVector(up, p.y * GLYPH_LOCAL_SCALE);
  }
}
