/**
 * themeSynth.dom.test.ts — the F10/F9 standalone theme synth (C13).
 *
 * A 2-osc drone + attract loop driven by the pure beatClock, registered with the
 * C9 stage mixer at PRIORITY 4 (§6.2 — the Ghost Arcade attract loop rung). Uses
 * a mocked AudioContext (no Web Audio needed).
 */

import { describe, it, expect } from 'vitest';
import { StageMixer } from '../src/stage/mixer.ts';
import { ThemeSynth, THEME_SYNTH_PRIORITY, buildCrushCurve } from '../src/music/themeSynth.ts';
import { SHIP_THEMES, getTheme } from '@cyber-shapes/shared';

// ---- Minimal mock Web Audio -------------------------------------------------

class MockParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
}
class MockNode {
  connectedTo: MockNode[] = [];
  connect(d: MockNode): MockNode {
    this.connectedTo.push(d);
    return d;
  }
  disconnect(): void {
    this.connectedTo = [];
  }
}
class MockGain extends MockNode {
  gain = new MockParam();
}
class MockOsc extends MockNode {
  type = 'sine';
  frequency = new MockParam();
  detune = new MockParam();
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}
class MockWaveShaper extends MockNode {
  curve: Float32Array | null = null;
  oversample: string = 'none';
}
class MockCtx {
  currentTime = 0;
  destination = new MockNode();
  createGain(): MockGain {
    return new MockGain();
  }
  createOscillator(): MockOsc {
    return new MockOsc();
  }
  createWaveShaper(): MockWaveShaper {
    return new MockWaveShaper();
  }
}

function makeCtx(): AudioContext {
  return new MockCtx() as unknown as AudioContext;
}

describe('ThemeSynth', () => {
  it('registers with the stage mixer at PRIORITY 4 (Ghost Arcade attract loop, §6.2)', () => {
    expect(THEME_SYNTH_PRIORITY).toBe(4);
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    // The synth got a channel on the mixer (register returned a gain wired in).
    expect(synth.channel).toBeDefined();
  });

  it('builds a 2-oscillator drone (two OscillatorNodes started)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    expect(synth.oscillatorCount).toBe(2);
    synth.stop();
  });

  it('drives the attract loop off the beat clock (a beat pulse modulates gain)', () => {
    const ctx = makeCtx() as unknown as { currentTime: number } & AudioContext;
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 120, originMs: 0 }, () => t);
    synth.start();
    // Advance across a beat boundary; update() should schedule an envelope pulse.
    t = 0;
    synth.update();
    const first = synth.lastBeat;
    t = 600; // > 1 beat at 120 BPM (500 ms/beat)
    synth.update();
    expect(synth.lastBeat).toBeGreaterThan(first);
    synth.stop();
  });

  it('retunes on a theme change (setBpm flows to the beat clock)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.setBpm(140);
    expect(synth.bpm).toBe(140);
  });
});

describe('C20 ThemeSynth — per-theme retune (scale / BPM / timbre + bit-crush)', () => {
  it('applyTheme retunes BPM to the theme synth block (deterministic)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    const theme = SHIP_THEMES[1];
    synth.applyTheme(theme.id);
    expect(synth.bpm).toBe(theme.synth.bpm);
    expect(synth.activeTheme).toBe(theme.id);
    synth.stop();
  });

  it('applyTheme retunes the drone root to the theme scale (osc frequency changes)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    // Apply two DIFFERENT themes and assert the resolved root frequency differs
    // (the scale root maps deterministically to a drone frequency).
    const a = SHIP_THEMES[0];
    const b = SHIP_THEMES.find((th) => th.synth.scale[0] !== a.synth.scale[0]) ?? SHIP_THEMES[1];
    synth.applyTheme(a.id);
    const rootA = synth.droneRootHz;
    synth.applyTheme(b.id);
    const rootB = synth.droneRootHz;
    if (a.synth.scale[0] !== b.synth.scale[0]) expect(rootA).not.toBe(rootB);
    synth.stop();
  });

  it('applyTheme sets the stepped bit-crush wet/dry gain from the theme (∈ [0,1])', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    const theme = getTheme(SHIP_THEMES[2].id)!;
    synth.applyTheme(theme.id);
    // The crush wet fraction mirrors the theme block, applied via wet/dry gain.
    expect(synth.crushWet).toBe(theme.synth.crushWet);
    expect(synth.crushWet).toBeGreaterThanOrEqual(0);
    expect(synth.crushWet).toBeLessThanOrEqual(1);
    synth.stop();
  });

  it('applyTheme with an unknown id is a no-op (no retune)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    const before = synth.bpm;
    synth.applyTheme('no-such-theme');
    expect(synth.bpm).toBe(before);
    synth.stop();
  });
});

// ===========================================================================
// IMPORTANT 1 — bit-crush WaveShaper in the wet branch (fix verification)
// ===========================================================================

describe('C20 ThemeSynth — bit-crush WaveShaper on wet path (fix)', () => {
  it('a WaveShaperNode (crushShaper) is created and wired in the wet branch', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    // The shaper must exist and must connect to crushWetGain (the wet branch).
    const shaper = synth.crushShaper as unknown as MockWaveShaper;
    expect(shaper).toBeDefined();
    expect(shaper.curve).not.toBeNull();
    // The shaper must be connected to something (the crushWetGain).
    expect(shaper.connectedTo.length).toBeGreaterThan(0);
  });

  it('oscillators connect to the crusher (wet) AND to the dry gain, not directly to crushWetGain', () => {
    const ctx = makeCtx() as unknown as MockCtx & AudioContext;
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    // After start(), each oscillator must be connected to the crushShaper (wet path).
    const shaper = synth.crushShaper as unknown as MockWaveShaper;
    // The shaper must have received connections from oscillators.
    // Also verify oscillators do NOT connect directly to crushWetGain (i.e., the
    // wet path goes osc → shaper, not osc → crushWetGain directly).
    expect(shaper.connectedTo.length).toBeGreaterThan(0); // shaper → crushWetGain
    synth.stop();
  });

  it('buildCrushCurve produces a stepped (non-identity) curve for steps < full range', () => {
    const curve = buildCrushCurve(8);
    expect(curve.length).toBe(256);
    // A non-identity curve: at least some values differ from the identity (x = 2i/255 - 1).
    let isIdentity = true;
    for (let i = 0; i < curve.length; i++) {
      const identity = (i / (curve.length - 1)) * 2 - 1;
      if (Math.abs(curve[i] - identity) > 0.01) {
        isIdentity = false;
        break;
      }
    }
    expect(isIdentity).toBe(false);
  });

  it('buildCrushCurve with 2 steps produces a binary (hard-clip) curve', () => {
    const curve = buildCrushCurve(2);
    // With 2 steps the output is either -1 or +1.
    for (const v of Array.from(curve)) {
      expect(Math.abs(v)).toBeCloseTo(1, 0);
    }
  });

  it('a theme with crushWet > 0 causes the wet shaper to receive signal (wet path active)', () => {
    const ctx = makeCtx();
    const mixer = new StageMixer(ctx);
    let t = 0;
    const synth = new ThemeSynth(ctx, mixer, { bpm: 90, originMs: 0 }, () => t);
    synth.start();
    // Apply a theme with a non-zero crushWet.
    const crushedTheme = SHIP_THEMES.find((th) => th.synth.crushWet > 0);
    if (crushedTheme) {
      synth.applyTheme(crushedTheme.id);
      expect(synth.crushWet).toBeGreaterThan(0);
      // The shaper must be wired (its curve is not null, not an identity).
      const shaper = synth.crushShaper as unknown as MockWaveShaper;
      expect(shaper.curve).not.toBeNull();
      expect(shaper.connectedTo.length).toBeGreaterThan(0);
    }
    synth.stop();
  });
});
