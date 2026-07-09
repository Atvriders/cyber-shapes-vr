/**
 * themes.ts — Task C20 F9 Reality Channels: the PURE ThemeDef table (spec §6.5,
 * the channels sections, §7.5, §14). PURE + DETERMINISTIC — no Three/DOM/Date/
 * Math.random. This is a DATA table + a handful of accessors; the client applies
 * it (envTheme.ts / music/themeSynth.ts) and the server schedules it (THEME_SET).
 *
 * 0 ASSETS / 100% PROCEDURAL (spec §14 stage line): every theme is described by
 * NUMBERS ONLY — palettes (hex ints), a procedural grid descriptor (replaces
 * Three's GridHelper), a procedural skydome shader BRANCH name (a uniform switch,
 * never a cubemap file), fog + bloom tints, and a synth retune block. No file
 * paths, no urls, no textures — a test asserts the table carries no asset ref.
 *
 * SHIP GATE = 3 fully-art-directed themes (spec §14): Cyber Grid (the default),
 * Ghost Monochrome, and the hero Vaporwave Sunset. Two STRETCH themes (Tron Canyon,
 * Infrared Storm) round out the pool but are optional; every theme is fully
 * specified so the 5-meter legibility rule holds for any adjacent pair.
 *
 * THE PALETTE IS SCOPED TO SHAPES + ENVIRONMENT ONLY (spec §5.6 / §6.5: "avatar
 * identity colors exempt from palette LUT"). A ThemeDef intentionally carries NO
 * avatar-palette field — the apply layer (envTheme.ts) only ever routes `palette`
 * to the shape/environment sink, never to the avatar color channel.
 *
 * THEME VOTES ARE ORDINARY §7.5 ELECTIONS (spec §5.2 row 0x24): a theme option is
 * a NAMESPACED ballot id (`theme:<id>`) registered into the SAME C15 pool as the
 * dial-cue-id options. There is NO second vote path — the election host routes a
 * THEME-namespaced winner to `setTheme`/THEME_SET instead of `setBaseParams`.
 */

// ---------------------------------------------------------------------------
// The ThemeDef schema.
// ---------------------------------------------------------------------------

/**
 * The procedural GRID descriptor — replaces Three's GridHelper with a custom
 * shader grid (spec §6.5 "custom shader grid replaces GridHelper — counted work").
 * All numbers: two hex colors + division/line params. NEVER moves the grid
 * transform (the grid is the vestibular anchor — §6.3); only its color/emissive.
 */
export interface ThemeGrid {
  /** The base grid line color (hex int). */
  color: number;
  /** The emissive glow color for the grid lines (hex int). */
  glowColor: number;
  /** Grid subdivisions (procedural — no geometry asset). */
  divisions: number;
  /** Line width in shader units (a silhouette feature — thin vs fat lines). */
  lineWidth: number;
}

/**
 * The procedural SKYDOME descriptor — a shader BRANCH (a `themeId`-keyed uniform
 * switch, §6.5 "uber-shader with themeId branch"), never a baked file. `branch`
 * names the procedural sky style (`starfield` / `void` / `gradient` / …) the
 * uber-shader selects; `topColor`/`horizonColor` grade the two-stop gradient the
 * flat-gradient fallback also uses.
 */
export interface ThemeSky {
  /** Zenith color of the procedural gradient (hex int). */
  topColor: number;
  /** Horizon color of the procedural gradient (hex int). */
  horizonColor: number;
  /** The uber-shader sky branch name (a uniform switch, 0 assets). */
  branch: string;
}

/**
 * The theme SYNTH retune block — drives the standalone theme synth
 * (music/themeSynth.ts): scale/BPM/timbre + the stepped "bit-crush" wet fraction.
 * DETERMINISTIC: the synth resolves the drone root from `scale[0]` (a MIDI note)
 * and crossfades the crush curve via a wet/dry gain of `crushWet`.
 */
export interface ThemeSynthBlock {
  /** Logical BPM the beat clock retunes to. */
  bpm: number;
  /** The theme scale as MIDI note numbers (scale[0] = the drone root). */
  scale: number[];
  /** The oscillator timbre label (`sawtooth` / `sine` / `square` / `triangle`). */
  timbre: OscillatorTimbre;
  /** The stepped bit-crush wet fraction ∈ [0,1] applied via wet/dry gain. */
  crushWet: number;
}

/** The oscillator timbres the theme synth understands (Web Audio OscillatorType subset). */
export type OscillatorTimbre = 'sawtooth' | 'sine' | 'square' | 'triangle';

/**
 * A complete Reality Channel: an art-directed procedural theme (0 assets). The
 * `palette` is the shape/environment color LUT — NEVER the avatar color channel.
 */
export interface ThemeDef {
  /** Stable kebab-case id (frozen — never migrated; wire byte + persistence key). */
  id: string;
  /** Human label for the stage/attract surface (uppercased at render). */
  label: string;
  /** The shape + environment color LUT (hex ints). EXEMPT from avatar colors. */
  palette: number[];
  /** The procedural grid descriptor (replaces GridHelper). */
  grid: ThemeGrid;
  /** The procedural skydome shader branch descriptor. */
  sky: ThemeSky;
  /** Fog color (hex int) + density (0 = clear). */
  fogColor: number;
  fogDensity: number;
  /** The bloom post grade tint (hex int). */
  bloomTint: number;
  /** The theme synth retune block. */
  synth: ThemeSynthBlock;
}

// ---------------------------------------------------------------------------
// The table — 3 ship-gate themes (+ 2 stretch). Every field concrete so the
// 5-meter legibility rule holds for any adjacent pair (distinct sky branch, hue
// family, and one silhouette feature — grid line width / divisions).
// ---------------------------------------------------------------------------

/** CYBER GRID (default) — cyan neon on a black starfield; sharp thin grid. */
const CYBER_GRID: ThemeDef = {
  id: 'cyber-grid',
  label: 'CYBER GRID',
  palette: [0x00ffff, 0xff00ff, 0xff0066, 0x0066ff, 0x00ff66, 0x9900ff, 0xff6600],
  grid: { color: 0x00ffff, glowColor: 0x003333, divisions: 200, lineWidth: 1 },
  sky: { topColor: 0x02030a, horizonColor: 0x061428, branch: 'starfield' },
  fogColor: 0x050510,
  fogDensity: 0.012,
  bloomTint: 0x00ffff,
  synth: { bpm: 120, scale: [45, 47, 48, 50, 52, 55, 57], timbre: 'sawtooth', crushWet: 0 },
};

/** GHOST MONOCHROME — pale grayscale in a foggy void; fat soft grid, no starfield. */
const GHOST_MONOCHROME: ThemeDef = {
  id: 'ghost-monochrome',
  label: 'GHOST MONOCHROME',
  palette: [0xf0f0f0, 0xc8c8c8, 0xa0a0a0, 0x808080, 0xd8d8d8, 0xb0b0b0, 0xe8e8e8],
  grid: { color: 0x9aa0a6, glowColor: 0x2a2d31, divisions: 120, lineWidth: 2 },
  sky: { topColor: 0x1a1c1e, horizonColor: 0x3a3d41, branch: 'void' },
  fogColor: 0x2a2c2e,
  fogDensity: 0.045,
  bloomTint: 0xf0f0f0,
  synth: { bpm: 84, scale: [43, 46, 48, 50, 53, 55, 58], timbre: 'sine', crushWet: 0.35 },
};

/** VAPORWAVE SUNSET (hero) — magenta/orange over a gradient sunset; wide low grid. */
const VAPORWAVE_SUNSET: ThemeDef = {
  id: 'vaporwave-sunset',
  label: 'VAPORWAVE SUNSET',
  palette: [0xff2fb3, 0xff6ec7, 0xffa64d, 0xffd24d, 0x6a5acd, 0x00d1d1, 0xff5f6d],
  grid: { color: 0xff2fb3, glowColor: 0x3a0a3a, divisions: 64, lineWidth: 3 },
  sky: { topColor: 0x2a0a4a, horizonColor: 0xff7a59, branch: 'gradient' },
  fogColor: 0x3a1050,
  fogDensity: 0.02,
  bloomTint: 0xff6ec7,
  synth: { bpm: 96, scale: [40, 43, 45, 47, 50, 52, 55], timbre: 'triangle', crushWet: 0.6 },
};

/** TRON CANYON (stretch) — electric blue/orange in a canyon gradient; medium grid. */
const TRON_CANYON: ThemeDef = {
  id: 'tron-canyon',
  label: 'TRON CANYON',
  palette: [0x35d1ff, 0x00b7ff, 0xff8a00, 0xffb547, 0x1affd5, 0x0a7bff, 0xffe08a],
  grid: { color: 0x35d1ff, glowColor: 0x06283a, divisions: 100, lineWidth: 2 },
  sky: { topColor: 0x020814, horizonColor: 0x0a3a5a, branch: 'canyon' },
  fogColor: 0x04121e,
  fogDensity: 0.018,
  bloomTint: 0x35d1ff,
  synth: { bpm: 128, scale: [48, 50, 51, 53, 55, 56, 58], timbre: 'square', crushWet: 0.25 },
};

/** INFRARED STORM (stretch) — red/amber heat in a smoky sky; dense hot grid. */
const INFRARED_STORM: ThemeDef = {
  id: 'infrared-storm',
  label: 'INFRARED STORM',
  palette: [0xff2b2b, 0xff6b2b, 0xffb02b, 0xffe02b, 0xd12bff, 0x2bffd1, 0xff2b8a],
  grid: { color: 0xff3b2b, glowColor: 0x3a0808, divisions: 160, lineWidth: 1 },
  sky: { topColor: 0x140202, horizonColor: 0x5a1a06, branch: 'smoke' },
  fogColor: 0x1e0604,
  fogDensity: 0.03,
  bloomTint: 0xff3b2b,
  synth: { bpm: 140, scale: [41, 44, 46, 48, 51, 53, 56], timbre: 'sawtooth', crushWet: 0.8 },
};

// ---------------------------------------------------------------------------
// Exports: the ship gate, the full pool, and the default.
// ---------------------------------------------------------------------------

/** The 3 SHIP-GATE themes (spec §14) — fully art-directed, always advertised. */
export const SHIP_THEMES: readonly ThemeDef[] = Object.freeze([
  CYBER_GRID,
  GHOST_MONOCHROME,
  VAPORWAVE_SUNSET,
]);

/** The 2 optional STRETCH themes (round out the pool; still fully specified). */
export const STRETCH_THEMES: readonly ThemeDef[] = Object.freeze([TRON_CANYON, INFRARED_STORM]);

/** The FULL theme pool (ship gate + stretch). */
export const ALL_THEMES: readonly ThemeDef[] = Object.freeze([...SHIP_THEMES, ...STRETCH_THEMES]);

/** Every theme id, in pool order. */
export const THEME_IDS: readonly string[] = Object.freeze(ALL_THEMES.map((t) => t.id));

/** The default channel — the Cyber Grid (the Phase B look, art-directed). */
export const DEFAULT_THEME_ID = CYBER_GRID.id;

const THEME_BY_ID: ReadonlyMap<string, ThemeDef> = new Map(ALL_THEMES.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// Helper accessors.
// ---------------------------------------------------------------------------

/** Resolve a theme by id, or undefined for an unknown id. */
export function getTheme(id: string): ThemeDef | undefined {
  return THEME_BY_ID.get(id);
}

/** True iff `id` names a known theme (a cheap type guard). */
export function isTheme(id: string): boolean {
  return THEME_BY_ID.has(id);
}

/** The default ThemeDef (Cyber Grid). */
export function defaultTheme(): ThemeDef {
  return CYBER_GRID;
}

/**
 * The NEXT theme id in pool order (wraps). DETERMINISTIC — used by the encore
 * `themeCut` to advance the reality one channel on the drop (no Math.random). An
 * unknown current id starts from the default's successor.
 */
export function nextThemeId(currentId: string): string {
  const idx = THEME_IDS.indexOf(currentId);
  const base = idx < 0 ? THEME_IDS.indexOf(DEFAULT_THEME_ID) : idx;
  return THEME_IDS[(base + 1) % THEME_IDS.length];
}

// ---------------------------------------------------------------------------
// The stage / attract line (spec §14): "N REALITIES · 0 ASSETS · 100% PROCEDURAL".
// ---------------------------------------------------------------------------

/**
 * The stage/attract flex line. `count` defaults to the full pool size; pass an
 * explicit count to advertise only the ship gate (`themeStageLine(3)`).
 */
export function themeStageLine(count: number = THEME_IDS.length): string {
  return `${count} REALITIES · 0 ASSETS · 100% PROCEDURAL`;
}

// ---------------------------------------------------------------------------
// Election-pool registration — theme options plug into the SAME C15 pool.
//
// A theme ballot option is a NAMESPACED id (`theme:<themeId>`) so it never
// collides with a plain dial-cue-id option in the same ballot. The election host
// routes a THEME-namespaced winner to `enactTheme` (→ setTheme / THEME_SET),
// NOT to `setBaseParams` — ordinary §7.5 elections, no second vote path.
// ---------------------------------------------------------------------------

/** The prefix that marks a ballot option as a THEME vote (never a dial id). */
export const THEME_OPTION_PREFIX = 'theme:';

/** The ballot option id for a theme (`theme:<id>`). */
export function themeOptionFor(themeId: string): string {
  return `${THEME_OPTION_PREFIX}${themeId}`;
}

/** True iff a ballot option is a THEME option (namespaced), not a dial id. */
export function isThemeOption(option: string): boolean {
  return option.startsWith(THEME_OPTION_PREFIX);
}

/**
 * The theme id a ballot option names, or undefined if it is not a theme option
 * OR the namespaced id is not a known theme.
 */
export function themeIdFromOption(option: string): string | undefined {
  if (!isThemeOption(option)) return undefined;
  const id = option.slice(THEME_OPTION_PREFIX.length);
  return isTheme(id) ? id : undefined;
}

/** The theme ballot options for the C15 pool — one namespaced option per theme. */
export function themeElectionOptions(themes: readonly ThemeDef[] = ALL_THEMES): string[] {
  return themes.map((t) => themeOptionFor(t.id));
}

// ---------------------------------------------------------------------------
// Transition comfort bound (spec §6.3 / §7.5): THEME_SET transitions are
// scheduled a SHORT lead ahead (a headset glitch transition ≤ 500 ms; a slow
// scheduled swap tolerates ~1–2 s). The server clamps a requested lead to this
// bound so a mis-set transition never schedules far into the future.
// ---------------------------------------------------------------------------

/** The maximum lead (ms) a scheduled THEME_SET transition may sit in the future. */
export const THEME_TRANSITION_MAX_LEAD_MS = 2_000;

/** The mini-glitch duration (ms) a late/snap THEME_SET requests (comfort ≤ 500 ms). */
export const THEME_MINI_GLITCH_MS = 300;
