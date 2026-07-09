/**
 * themes.test.ts — Task C20 F9 Reality Channels: the PURE ThemeDef table + the
 * election-pool registration helpers (spec §6.5 / §7.5 / the channels sections).
 *
 * PURE + DETERMINISTIC: no Date, no Math.random, no I/O. The whole module is a
 * data table + a few accessors; these tests pin the schema completeness of the 3
 * ship-gate themes, the helper accessors, the "N REALITIES · 0 ASSETS · 100%
 * PROCEDURAL" stage line, and the theme→election-option registration (theme
 * options plug into the SAME C15 pool — ordinary elections, no second vote path).
 */

import { describe, it, expect } from 'vitest';
import {
  SHIP_THEMES,
  ALL_THEMES,
  THEME_IDS,
  DEFAULT_THEME_ID,
  getTheme,
  isTheme,
  defaultTheme,
  themeStageLine,
  themeElectionOptions,
  isThemeOption,
  themeIdFromOption,
  themeOptionFor,
  nextThemeId,
  type ThemeDef,
} from '../src/themes.js';

// ---------------------------------------------------------------------------
// The ship-gate 3 themes are fully specified (palette + grid + sky + synth).
// ---------------------------------------------------------------------------

describe('C20 themes — the 3 ship-gate ThemeDefs are fully specified', () => {
  it('ships EXACTLY 3 gate themes (each with a stable id)', () => {
    expect(SHIP_THEMES.length).toBe(3);
    const ids = SHIP_THEMES.map((t) => t.id);
    // Unique, non-empty, kebab-case ids.
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('every ship theme fully specifies palette + grid + sky + fog + bloom + synth', () => {
    for (const t of SHIP_THEMES) {
      // A human label for the stage/attract surface.
      expect(typeof t.label).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);

      // PALETTE: the shape/environment color LUT. A non-empty list of hex colors.
      expect(Array.isArray(t.palette)).toBe(true);
      expect(t.palette.length).toBeGreaterThan(0);
      for (const c of t.palette) expect(Number.isInteger(c)).toBe(true);

      // GRID descriptor (procedural — replaces GridHelper; 0 assets).
      expect(Number.isInteger(t.grid.color)).toBe(true);
      expect(Number.isInteger(t.grid.glowColor)).toBe(true);
      expect(t.grid.divisions).toBeGreaterThan(0);
      expect(t.grid.lineWidth).toBeGreaterThan(0);

      // SKY descriptor (procedural skydome shader branch, 0 assets).
      expect(Number.isInteger(t.sky.topColor)).toBe(true);
      expect(Number.isInteger(t.sky.horizonColor)).toBe(true);
      expect(typeof t.sky.branch).toBe('string');
      expect(t.sky.branch.length).toBeGreaterThan(0);

      // FOG + BLOOM tint (procedural post grade).
      expect(Number.isInteger(t.fogColor)).toBe(true);
      expect(t.fogDensity).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(t.bloomTint)).toBe(true);

      // SYNTH retune block (drives the standalone theme synth).
      expect(t.synth.bpm).toBeGreaterThan(0);
      expect(Array.isArray(t.synth.scale)).toBe(true);
      expect(t.synth.scale.length).toBeGreaterThan(0);
      expect(typeof t.synth.timbre).toBe('string');
      // The stepped "bit-crush" wet fraction ∈ [0,1] (wet/dry gain).
      expect(t.synth.crushWet).toBeGreaterThanOrEqual(0);
      expect(t.synth.crushWet).toBeLessThanOrEqual(1);
    }
  });

  it('the 3 ship themes are 5-meter distinct: no two share a sky branch AND hue family', () => {
    // Spec §14 5-meter test: adjacent themes differ in sky content, hue family, and
    // one silhouette feature. Assert no two ship themes collide on BOTH sky branch
    // and grid hue (a cheap proxy for the legibility rule).
    for (let i = 0; i < SHIP_THEMES.length; i++) {
      for (let j = i + 1; j < SHIP_THEMES.length; j++) {
        const a = SHIP_THEMES[i];
        const b = SHIP_THEMES[j];
        const sameSky = a.sky.branch === b.sky.branch;
        const sameGrid = a.grid.color === b.grid.color;
        expect(sameSky && sameGrid).toBe(false);
      }
    }
  });

  it('is 0-asset / 100% procedural: no ThemeDef carries an asset url/path field', () => {
    for (const t of ALL_THEMES) {
      const json = JSON.stringify(t);
      expect(json).not.toMatch(/\.(png|jpg|jpeg|hdr|exr|glb|gltf|mp3|ogg|wav)/i);
      expect(json).not.toMatch(/https?:\/\//i);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper accessors.
// ---------------------------------------------------------------------------

describe('C20 themes — helper accessors', () => {
  it('THEME_IDS lists every theme id; ALL_THEMES ⊇ SHIP_THEMES', () => {
    expect(THEME_IDS.length).toBe(ALL_THEMES.length);
    expect(ALL_THEMES.length).toBeGreaterThanOrEqual(SHIP_THEMES.length);
    for (const t of SHIP_THEMES) expect(THEME_IDS).toContain(t.id);
  });

  it('getTheme resolves a known id and returns undefined for an unknown one', () => {
    const first = SHIP_THEMES[0];
    expect(getTheme(first.id)).toEqual(first);
    expect(getTheme('no-such-theme')).toBeUndefined();
  });

  it('isTheme is a type guard over the known ids', () => {
    expect(isTheme(SHIP_THEMES[0].id)).toBe(true);
    expect(isTheme('no-such-theme')).toBe(false);
  });

  it('DEFAULT_THEME_ID is a ship theme and defaultTheme() returns it', () => {
    expect(THEME_IDS).toContain(DEFAULT_THEME_ID);
    expect(SHIP_THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
    expect(defaultTheme().id).toBe(DEFAULT_THEME_ID);
  });

  it('nextThemeId advances one channel in pool order (wraps; used by encore themeCut)', () => {
    for (let i = 0; i < THEME_IDS.length; i++) {
      const cur = THEME_IDS[i];
      const expected = THEME_IDS[(i + 1) % THEME_IDS.length];
      expect(nextThemeId(cur)).toBe(expected);
    }
    // An unknown current id starts from the default's successor (never crashes).
    expect(THEME_IDS).toContain(nextThemeId('no-such-theme'));
  });
});

// ---------------------------------------------------------------------------
// The stage / attract line — "N REALITIES · 0 ASSETS · 100% PROCEDURAL".
// ---------------------------------------------------------------------------

describe('C20 themes — the stage line', () => {
  it('renders "N REALITIES · 0 ASSETS · 100% PROCEDURAL" with the live theme count', () => {
    expect(themeStageLine()).toBe(`${THEME_IDS.length} REALITIES · 0 ASSETS · 100% PROCEDURAL`);
    // Accepts an explicit count (e.g. only the ship gate advertised).
    expect(themeStageLine(SHIP_THEMES.length)).toBe('3 REALITIES · 0 ASSETS · 100% PROCEDURAL');
  });
});

// ---------------------------------------------------------------------------
// Election-pool registration — theme options plug into the SAME C15 pool.
// ---------------------------------------------------------------------------

describe('C20 themes — election option registration (into the C15 pool)', () => {
  it('themeElectionOptions() yields one option id per theme, all THEME-namespaced', () => {
    const opts = themeElectionOptions();
    expect(opts.length).toBe(THEME_IDS.length);
    for (const o of opts) expect(isThemeOption(o)).toBe(true);
    // Every option maps back to a real theme id.
    for (const o of opts) expect(THEME_IDS).toContain(themeIdFromOption(o));
  });

  it('theme options are DISTINCT from dial-cue-id options (namespaced, never collide)', () => {
    // A plain dial cue id (e.g. "low-g") is NOT a theme option; a theme option is
    // NOT a bare theme id — so the two option spaces never collide in one ballot.
    expect(isThemeOption('low-g')).toBe(false);
    expect(isThemeOption('gravity-flip')).toBe(false);
    expect(isThemeOption(SHIP_THEMES[0].id)).toBe(false); // a bare id is not an option
    expect(themeOptionFor(SHIP_THEMES[0].id)).not.toBe(SHIP_THEMES[0].id);
  });

  it('themeOptionFor / themeIdFromOption round-trip', () => {
    for (const t of ALL_THEMES) {
      const opt = themeOptionFor(t.id);
      expect(isThemeOption(opt)).toBe(true);
      expect(themeIdFromOption(opt)).toBe(t.id);
    }
    // A non-theme option yields undefined from themeIdFromOption.
    expect(themeIdFromOption('low-g')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The palette LUT NEVER touches the avatar color channel — pure-data assertion.
// (The full apply-time exemption lives in the client envTheme test; here we pin
// the DATA CONTRACT: a ThemeDef exposes only a shape/environment palette and has
// no avatar-palette field at all.)
// ---------------------------------------------------------------------------

describe('C20 themes — the palette is scoped to shapes/environment (no avatar field)', () => {
  it('a ThemeDef exposes `palette` but never an `avatarPalette`/avatar color LUT', () => {
    const t: ThemeDef = SHIP_THEMES[0];
    expect('palette' in t).toBe(true);
    expect('avatarPalette' in t).toBe(false);
    expect('avatarColors' in t).toBe(false);
  });
});
