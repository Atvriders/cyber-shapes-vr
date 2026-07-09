/**
 * envTheme.ts — environmental theme + the in-headset countdown cue (C10, spec
 * §6.2 / §7.2). Created here in C10; C11 extends it with the dial cosmetic tweens
 * (BULLET TIME / FREEZE grade, etc.).
 *
 * THE COUNTDOWN CONTRACT (spec §7.2, VERBATIM):
 *   "In-headset countdown = environmental RED PULSE + KLAXON; the NUMERIC
 *    countdown is only on the STAGE, never in the headset."
 *
 * A headset wearer must NEVER see a numeric timer floating in their view — that
 * reads as broken UI and is a comfort risk. Instead the environment PULSES red
 * (a fog/ambient-light tint that ramps up as the phase-end nears) and a KLAXON
 * fires — a legible, comfortable "get ready" signal that needs no reading.
 *
 * This module is the PURE driver: it maps a PHASE_STATE remainingMs → an
 * environmental intensity (0..1) + a discrete klaxon schedule, and applies it via
 * an injected sink (a Three tint setter on the real headset; a spy in tests). NO
 * three import here — the sink is the seam, so this stays test-safe and can be
 * reused by the stage (which ignores the numeric-suppression rule) and the
 * audience client (C25) alike. Comfort: the pulse ramp is ≤ 3 Hz (§6.3) and never
 * moves the camera/rig/horizon.
 */

import { getTheme, DEFAULT_THEME_ID, THEME_MINI_GLITCH_MS } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Countdown window: how long before phase-end the red-pulse countdown runs, and
// the klaxon beat schedule (ms before end at which a klaxon fires).
// ---------------------------------------------------------------------------

/** The red-pulse countdown begins this many ms before the phase ends (spec §7.2). */
export const COUNTDOWN_WINDOW_MS = 5_000;

/**
 * Klaxon fire points (ms-before-end). A klaxon at 5 s, 3 s, 1 s — a "3-2-1"
 * feel without any numbers in the headset. Sorted DESC so the scheduler fires
 * them as the remaining time crosses each threshold exactly once.
 */
export const KLAXON_SCHEDULE_MS: readonly number[] = [5_000, 3_000, 1_000];

/**
 * The environmental sink the countdown drives. On the real headset this wraps a
 * fog-color / ambient-tint setter + the klaxon SFX; in tests it is a spy.
 */
export interface EnvThemeSink {
  /**
   * Set the red-pulse intensity in [0,1]. 0 = neutral environment; 1 = full red
   * alarm tint. The renderer lerps the fog/ambient toward red by this amount. It
   * NEVER moves the camera/rig/horizon (§6.3) — a color-only change.
   */
  setRedPulse(intensity: number): void;
  /** Fire the KLAXON one-shot (a headset-local SFX; never the stage mixer). */
  fireKlaxon(): void;
}

/**
 * Map a remaining-ms to the red-pulse intensity [0,1]. Outside the countdown
 * window → 0. Inside, it ramps 0→1 linearly as the end approaches, with a fast
 * pulse OSCILLATION (≤ 3 Hz) so the environment throbs rather than fades — the
 * throb is what reads as "hurry". `elapsedMs` is the animation clock (for the
 * oscillation phase); pass 0 for the ramp-only base intensity.
 */
export function redPulseIntensity(remainingMs: number | null, elapsedMs = 0): number {
  if (remainingMs === null || remainingMs > COUNTDOWN_WINDOW_MS || remainingMs < 0) return 0;
  // Linear ramp: full at 0 ms remaining, zero at the window edge.
  const ramp = 1 - remainingMs / COUNTDOWN_WINDOW_MS;
  // Throb at ~2.5 Hz (comfortably ≤ 3 Hz, §6.3): a raised-cosine in [0.5, 1] so
  // the tint never fully drops to 0 mid-countdown (it PULSES, never strobes off).
  const hz = 2.5;
  const osc = 0.75 + 0.25 * Math.cos((elapsedMs / 1000) * hz * 2 * Math.PI);
  return Math.max(0, Math.min(1, ramp * osc));
}

/**
 * The stateful countdown driver. Feed it PHASE_STATE remainingMs each frame (or
 * on each heartbeat); it applies the red-pulse intensity and fires the klaxon
 * ONCE as the remaining time crosses each KLAXON_SCHEDULE_MS threshold. Reset on
 * a phase change so the next phase's countdown re-arms its klaxons.
 */
export class CountdownDriver {
  private readonly sink: EnvThemeSink;
  /** Thresholds already fired for the CURRENT countdown (cleared on reset). */
  private firedThresholds = new Set<number>();
  /** The last remaining we saw — detects a phase change (remaining jumps up). */
  private lastRemaining: number | null = null;

  constructor(sink: EnvThemeSink) {
    this.sink = sink;
  }

  /**
   * Advance the countdown to `remainingMs` at animation clock `elapsedMs`. Applies
   * the red pulse and fires any newly-crossed klaxon threshold exactly once.
   */
  update(remainingMs: number | null, elapsedMs = 0): void {
    // A phase change (or ATTRACT) resets the fired-set: remaining jumped UP or
    // went null. Re-arm the klaxons for the new phase's countdown.
    if (remainingMs === null || (this.lastRemaining !== null && remainingMs > this.lastRemaining + 500)) {
      this.firedThresholds.clear();
    }
    this.lastRemaining = remainingMs;

    this.sink.setRedPulse(redPulseIntensity(remainingMs, elapsedMs));

    if (remainingMs === null) return;
    for (const threshold of KLAXON_SCHEDULE_MS) {
      // Fire once as we cross below the threshold (and haven't yet this countdown).
      if (remainingMs <= threshold && !this.firedThresholds.has(threshold)) {
        this.firedThresholds.add(threshold);
        this.sink.fireKlaxon();
      }
    }
  }

  /** Force-reset the countdown state (e.g. on a hard phase jump / RESET). */
  reset(): void {
    this.firedThresholds.clear();
    this.lastRemaining = null;
    this.sink.setRedPulse(0);
  }
}

// ===========================================================================
// Task C20 — F9 Reality Channels: the client THEME APPLY layer (spec §6.5 / the
// channels sections / §5.6 "avatar identity colors exempt from palette LUT").
//
// The ThemeApplier maps a ThemeDef → the procedural grid / palette / sky / fog /
// bloom via an INJECTED env sink (a Three setter on the real headset; a spy in
// tests). It is the seam that keeps this module test-safe (no THREE import) and
// reusable by the stage + audience clients.
//
// THE CRITICAL INVARIANT: the theme color LUT NEVER touches the AVATAR color
// channel. The applier only ever routes `palette` to the ENV sink; the optional
// avatar sink exists ONLY so a regression that recolors avatars is caught by the
// test — a correct apply never calls it. Avatars keep their per-player identity
// colors across any theme change (§6.1 attribution redundancy).
// ===========================================================================

/**
 * The environmental theme sink (the shape/environment surface the LUT drives). On
 * the real headset this wraps the custom shader-grid uniforms, the shape material
 * palette, the skydome shader branch + gradient, the fog, and the bloom tint; in
 * tests it is a spy. Comfort (§6.3): it only ever changes COLORS/emissive — it
 * NEVER moves the grid transform, camera, rig, or horizon.
 */
export interface ThemeEnvSink {
  /** Recolor the procedural grid (line color + emissive glow). No transform move. */
  setGrid(color: number, glowColor: number): void;
  /** Set the shape/environment color LUT (the palette). NEVER the avatar channel. */
  setPalette(colors: readonly number[]): void;
  /** Grade the procedural skydome (gradient stops + the uber-shader branch name). */
  setSky(topColor: number, horizonColor: number, branch: string): void;
  /** Set the fog color + density. */
  setFog(color: number, density: number): void;
  /** Set the bloom post grade tint. */
  setBloomTint(color: number): void;
  /** Play a short comfort mini-glitch (≤ 500 ms) on a snap/late transition. */
  miniGlitch(ms: number): void;
}

/**
 * The AVATAR color sink — supplied to the applier ONLY to prove the exemption.
 * The applier must NEVER call `setAvatarColor` during a theme apply; the test
 * asserts it stays untouched. On the real client this is wired to the Avatars
 * renderer's per-player color, which the theme LUT is forbidden to touch.
 */
export interface ThemeAvatarSink {
  setAvatarColor(playerId: string, color: number): void;
}

/** The Quest render-path choices for the procedural sky (spec §6.5 ledger). */
export const THEME_RENDER_PATH = {
  /** Uber-shader with a `themeId` branch (compileAsync prewarm) — the default. */
  UBER_SHADER: 'uber-shader',
  /** A baked cubemap re-baked ≤ 4 Hz — for devices without async shader compile. */
  BAKED_CUBEMAP: 'baked-cubemap',
  /** A flat two-stop gradient — the low-end auto-fallback (always works). */
  FLAT_GRADIENT: 'flat-gradient',
} as const;

export type ThemeRenderPath = (typeof THEME_RENDER_PATH)[keyof typeof THEME_RENDER_PATH];

/**
 * Pick the theme render path for a device (spec §6.5 acceptance: "first in-headset
 * theme switch produces no frame > 20 ms"). Pure decision:
 *   • a low-end device → the flat-gradient fallback (cheapest, always legible);
 *   • a device with async shader compile → the uber-shader/prewarm path;
 *   • otherwise → the baked-cubemap (≤ 4 Hz re-bake) path.
 */
export function pickThemeRenderPath(caps: {
  canCompileAsync: boolean;
  lowEnd: boolean;
}): ThemeRenderPath {
  if (caps.lowEnd) return THEME_RENDER_PATH.FLAT_GRADIENT;
  return caps.canCompileAsync ? THEME_RENDER_PATH.UBER_SHADER : THEME_RENDER_PATH.BAKED_CUBEMAP;
}

/** Options for {@link ThemeApplier}. */
export interface ThemeApplierOpts {
  /** The env sink the theme LUT drives (grid/palette/sky/fog/bloom). */
  env: ThemeEnvSink;
  /**
   * The avatar color sink — OPTIONAL and, when present, NEVER called by an apply.
   * Its only purpose is to let a test assert the avatar-exemption invariant.
   */
  avatar?: ThemeAvatarSink;
}

/**
 * Apply a ThemeDef's procedural grid/palette/sky/fog to the environment. The
 * active theme starts at the default; `apply(themeId)` drives the env sink and
 * records the active theme. `apply(themeId, { glitch })` additionally requests the
 * comfort mini-glitch (a snap/late THEME_SET). An unknown id is a no-op.
 */
export class ThemeApplier {
  private readonly env: ThemeEnvSink;
  private _activeTheme: string = DEFAULT_THEME_ID;

  constructor(opts: ThemeApplierOpts) {
    this.env = opts.env;
    // Note: opts.avatar is intentionally NOT retained — the applier has no code
    // path that touches the avatar channel, so there is nothing to store. Keeping
    // it out of the instance is the structural guarantee behind the exemption.
  }

  /** The currently-applied theme id. */
  get activeTheme(): string {
    return this._activeTheme;
  }

  /**
   * Apply the theme's procedural look. Drives ONLY the env sink — the palette LUT
   * is scoped to shapes + environment and NEVER reaches the avatar color channel.
   */
  apply(themeId: string, opts: { glitch?: boolean } = {}): void {
    const theme = getTheme(themeId);
    if (!theme) return; // unknown id → no-op (active theme unchanged)
    // A snap/late transition plays the comfort mini-glitch FIRST (≤ 500 ms, §6.3)
    // so the swap reads as a deliberate cut, not a hitch.
    if (opts.glitch) this.env.miniGlitch(THEME_MINI_GLITCH_MS);
    this.env.setGrid(theme.grid.color, theme.grid.glowColor);
    this.env.setPalette(theme.palette); // shapes + environment ONLY (never avatars)
    this.env.setSky(theme.sky.topColor, theme.sky.horizonColor, theme.sky.branch);
    this.env.setFog(theme.fogColor, theme.fogDensity);
    this.env.setBloomTint(theme.bloomTint);
    this._activeTheme = theme.id;
  }
}
