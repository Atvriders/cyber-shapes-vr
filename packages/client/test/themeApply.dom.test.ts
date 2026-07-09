/**
 * themeApply.dom.test.ts — Task C20 F9 Reality Channels client apply layer.
 *
 * The ThemeApplier maps a ThemeDef → the procedural grid/palette/sky/fog via an
 * INJECTED sink (a Three setter on the real headset; a spy here). The critical
 * invariant (spec §5.6/§6.5 "avatar identity colors exempt from palette LUT"):
 * the theme color LUT NEVER touches the avatar color channel. A separate avatar
 * sink is offered to the applier and MUST remain untouched by a theme apply.
 *
 * Also covers the Quest render-path selection (uber-shader/prewarm vs baked
 * cubemap ≤ 4 Hz vs flat-gradient fallback) as a pure decision.
 */

import { describe, it, expect } from 'vitest';
import {
  ThemeApplier,
  pickThemeRenderPath,
  THEME_RENDER_PATH,
  type ThemeEnvSink,
  type ThemeAvatarSink,
} from '../src/envTheme.ts';
import { SHIP_THEMES, DEFAULT_THEME_ID } from '@cyber-shapes/shared';

function makeEnvSink() {
  const calls = {
    grid: [] as Array<{ color: number; glowColor: number }>,
    palette: [] as number[][],
    sky: [] as Array<{ topColor: number; horizonColor: number; branch: string }>,
    fog: [] as Array<{ color: number; density: number }>,
    bloom: [] as number[],
    glitch: [] as number[],
  };
  const sink: ThemeEnvSink = {
    setGrid(color, glowColor) {
      calls.grid.push({ color, glowColor });
    },
    setPalette(colors) {
      calls.palette.push([...colors]);
    },
    setSky(topColor, horizonColor, branch) {
      calls.sky.push({ topColor, horizonColor, branch });
    },
    setFog(color, density) {
      calls.fog.push({ color, density });
    },
    setBloomTint(color) {
      calls.bloom.push(color);
    },
    miniGlitch(ms) {
      calls.glitch.push(ms);
    },
  };
  return { sink, calls };
}

/** A recording avatar sink — used ONLY to prove it is NEVER called by a theme apply. */
function makeAvatarSink() {
  const setColorCalls: Array<{ id: string; color: number }> = [];
  const sink: ThemeAvatarSink = {
    setAvatarColor(id, color) {
      setColorCalls.push({ id, color });
    },
  };
  return { sink, setColorCalls };
}

describe('C20 ThemeApplier — applies the procedural grid/palette/sky/fog', () => {
  it('drives the env sink from the ThemeDef (grid, palette, sky, fog, bloom)', () => {
    const { sink, calls } = makeEnvSink();
    const applier = new ThemeApplier({ env: sink });
    const theme = SHIP_THEMES.find((t) => t.id !== DEFAULT_THEME_ID)!;
    applier.apply(theme.id);
    expect(calls.grid.length).toBe(1);
    expect(calls.grid[0]).toEqual({ color: theme.grid.color, glowColor: theme.grid.glowColor });
    expect(calls.palette.length).toBe(1);
    expect(calls.palette[0]).toEqual([...theme.palette]);
    expect(calls.sky[0]).toEqual({
      topColor: theme.sky.topColor,
      horizonColor: theme.sky.horizonColor,
      branch: theme.sky.branch,
    });
    expect(calls.fog[0]).toEqual({ color: theme.fogColor, density: theme.fogDensity });
    expect(calls.bloom[0]).toBe(theme.bloomTint);
    expect(applier.activeTheme).toBe(theme.id);
  });

  it('an unknown theme id is a no-op (nothing driven, active theme unchanged)', () => {
    const { sink, calls } = makeEnvSink();
    const applier = new ThemeApplier({ env: sink });
    const before = applier.activeTheme;
    applier.apply('no-such-theme');
    expect(calls.grid.length).toBe(0);
    expect(applier.activeTheme).toBe(before);
  });

  it('a snap-transition (glitch=true) requests a mini-glitch (≤ 500 ms, comfort §6.3)', () => {
    const { sink, calls } = makeEnvSink();
    const applier = new ThemeApplier({ env: sink });
    applier.apply(SHIP_THEMES[1].id, { glitch: true });
    expect(calls.glitch.length).toBe(1);
    expect(calls.glitch[0]).toBeGreaterThan(0);
    expect(calls.glitch[0]).toBeLessThanOrEqual(500);
  });
});

// ===========================================================================
// The LUT NEVER touches the avatar color channel (avatars keep their colors)
// ===========================================================================

describe('C20 ThemeApplier — the palette LUT is EXEMPT from avatar colors', () => {
  it('applying ANY theme NEVER calls the avatar sink (avatar colors unchanged)', () => {
    const { sink } = makeEnvSink();
    const { sink: avatarSink, setColorCalls } = makeAvatarSink();
    // The applier is GIVEN the avatar sink so a regression that recolors avatars
    // would be caught — but a correct apply must never touch it.
    const applier = new ThemeApplier({ env: sink, avatar: avatarSink });
    for (const theme of SHIP_THEMES) {
      applier.apply(theme.id);
    }
    expect(setColorCalls.length).toBe(0);
  });

  it('the theme palette is delivered to the ENV sink only, never the avatar sink', () => {
    const { sink, calls } = makeEnvSink();
    const { sink: avatarSink, setColorCalls } = makeAvatarSink();
    const applier = new ThemeApplier({ env: sink, avatar: avatarSink });
    const theme = SHIP_THEMES[0];
    applier.apply(theme.id);
    // Palette reached the env sink …
    expect(calls.palette[0]).toEqual([...theme.palette]);
    // … and NOTHING reached the avatar sink.
    expect(setColorCalls.length).toBe(0);
  });
});

// ===========================================================================
// Quest render-path selection (uber-shader / baked cubemap ≤ 4 Hz / fallback)
// ===========================================================================

describe('C20 pickThemeRenderPath — Quest budget path selection (§6.5)', () => {
  it('picks the uber-shader path when shader prewarm is available', () => {
    expect(pickThemeRenderPath({ canCompileAsync: true, lowEnd: false })).toBe(
      THEME_RENDER_PATH.UBER_SHADER
    );
  });

  it('picks the baked-cubemap (≤ 4 Hz) path on a device without async compile', () => {
    expect(pickThemeRenderPath({ canCompileAsync: false, lowEnd: false })).toBe(
      THEME_RENDER_PATH.BAKED_CUBEMAP
    );
  });

  it('falls back to the flat-gradient path on a low-end device', () => {
    expect(pickThemeRenderPath({ canCompileAsync: false, lowEnd: true })).toBe(
      THEME_RENDER_PATH.FLAT_GRADIENT
    );
  });
});
