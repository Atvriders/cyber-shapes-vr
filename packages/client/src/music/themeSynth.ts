/**
 * themeSynth.ts — the standalone theme synth (C13, spec §7.10 / §7.9 / §6.2).
 *
 * A 2-oscillator drone + attract loop, driven by the pure logical-BPM
 * {@link createBeatClock} (shared). First built here for F10's attract loop; F9
 * (Reality Channels) RETUNES it per theme (scale / BPM / timbre) and F8 layers
 * Resonora on top — this module owns only the generative drone + beat pulse.
 *
 * It registers with the C9 {@link StageMixer} at PRIORITY 4 (§6.2 — the Ghost
 * Arcade attract-loop rung: it ducks under klaxon/encore/Resonora, above ambient
 * SFX). It NEVER creates a second AudioContext (FAQ #8) — the stage's context is
 * injected. Web Audio only; no THREE, no DOM; unit-tested with a mock context.
 */

import {
  createBeatClock,
  getTheme,
  DEFAULT_THEME_ID,
  type BeatClock,
  type BeatClockConfig,
} from '@cyber-shapes/shared';
import type { StageMixer, MixPriority } from '../stage/mixer.js';
import { midiToHz } from './synth.js';

/** The §6.2 mixer rung for the Ghost Arcade attract loop / theme drone. */
export const THEME_SYNTH_PRIORITY: MixPriority = 4;

/** Base drone frequency (Hz) — a low pad the theme retunes. */
const DRONE_ROOT_HZ = 110; // A2
/** The second oscillator sits a fifth above for a hollow synthwave pad. */
const DRONE_FIFTH_RATIO = 1.5;
/** A slight detune (cents) between the two oscillators for chorused width. */
const DRONE_DETUNE_CENTS = 6;
/** Resting drone level + the per-beat pulse peak (linear gain). */
const DRONE_LEVEL = 0.12;
const BEAT_PULSE_LEVEL = 0.22;
/** Envelope release time constant (s) for the beat pulse decay. */
const BEAT_RELEASE_S = 0.18;

/**
 * Build a stepped quantization (bit-crush) WaveShaper curve. Divides the
 * -1..1 range into `steps` equal quantization buckets, each clamped to the
 * nearest step boundary. At 8 steps this produces a coarse staircase timbre
 * characteristic of low-bit digital distortion.
 *
 * @param steps - Number of quantization steps (≥ 2). The spec §6.5 default
 *   is 8 (3-bit equivalent) when the theme uses a non-zero `crushWet`.
 */
export function buildCrushCurve(steps: number): Float32Array<ArrayBuffer> {
  const len = 256;
  const buf = new ArrayBuffer(len * 4);
  const curve = new Float32Array(buf);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1; // -1..1
    // Quantize: round to nearest step boundary, then clamp.
    const quantized = Math.round((x * 0.5 + 0.5) * (steps - 1)) / (steps - 1);
    curve[i] = Math.max(-1, Math.min(1, quantized * 2 - 1));
  }
  return curve;
}

/** Number of bit-crush quantization steps (§6.5: 8 = 3-bit equivalent). */
const CRUSH_STEPS = 8;

/**
 * The theme synth. Construct with the stage AudioContext + mixer + a beat-clock
 * config + an injected clock; `start()` builds the drone and registers it on the
 * mixer at priority 4; `update()` (called each frame) pulses the pad on each new
 * beat off the beat clock; `setBpm()` retunes on a theme change.
 */
export class ThemeSynth {
  /** The mixer channel gain (the handle the mixer ducks). */
  readonly channel: GainNode;

  private readonly ctx: AudioContext;
  private readonly mixer: StageMixer;
  private readonly clock: BeatClock;

  private readonly droneGain: GainNode;
  private oscillators: OscillatorNode[] = [];
  private _lastBeat = -1;
  private _started = false;

  // C20 F9 Reality Channels — per-theme retune state (spec §6.5).
  /** The active theme id (starts on the default; retuned via applyTheme). */
  private _activeTheme: string = DEFAULT_THEME_ID;
  /** The drone root frequency (Hz) the theme scale resolves to (scale[0] MIDI → Hz). */
  private _droneRootHz = DRONE_ROOT_HZ;
  /** The current oscillator timbre (retuned per theme). */
  private _timbre: OscillatorType = 'sawtooth';
  /**
   * The stepped "bit-crush" wet gain (§6.5: "a stepped quantization-curve swaps
   * crossfaded via wet/dry gain — WaveShaper curves aren't automatable"). A
   * WET/DRY split whose wet fraction ∈ [0,1] mirrors the theme's `crushWet`. The
   * crushed (wet) branch routes through a WaveShaperNode with a stepped
   * quantization curve (bit-crush); the clean (dry) branch bypasses it. Both
   * branches sum into the drone sub-bus.
   */
  private readonly crushWetGain: GainNode;
  private readonly crushDryGain: GainNode;
  /** The WaveShaper that produces the stepped bit-crush timbre on the wet path. */
  readonly crushShaper: WaveShaperNode;
  private _crushWet = 0;

  constructor(
    ctx: AudioContext,
    mixer: StageMixer,
    beat: BeatClockConfig,
    now: () => number
  ) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.clock = createBeatClock(beat, now);

    // A pre-mixer sub-bus for the drone so a beat pulse rides ON TOP of the
    // resting level without fighting the mixer's ducking ramps.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = DRONE_LEVEL;

    // The bit-crush wet/dry split (§6.5). The WET branch routes oscillators through
    // a WaveShaperNode with a stepped quantization curve (bit-crush), then through
    // crushWetGain → droneGain. The DRY branch bypasses the shaper (clean signal).
    // Both branches sum into the drone sub-bus; the theme sets the wet fraction.
    this.crushShaper = ctx.createWaveShaper();
    this.crushShaper.curve = buildCrushCurve(CRUSH_STEPS);
    this.crushShaper.oversample = '4x';
    this.crushWetGain = ctx.createGain();
    this.crushDryGain = ctx.createGain();
    this.crushWetGain.gain.value = 0; // default theme = clean (dry)
    this.crushDryGain.gain.value = 1;
    // Wet path: oscillators → crushShaper → crushWetGain → droneGain
    this.crushShaper.connect(this.crushWetGain);
    this.crushWetGain.connect(this.droneGain);
    // Dry path: oscillators → crushDryGain → droneGain
    this.crushDryGain.connect(this.droneGain);

    // Register the sub-bus on the mixer at PRIORITY 4 (§6.2). NOT voice-tagged.
    this.channel = mixer.register(this.droneGain, THEME_SYNTH_PRIORITY);
  }

  /** Number of live oscillators (2 when the drone is running). */
  get oscillatorCount(): number {
    return this.oscillators.length;
  }

  /** The last beat index the update loop pulsed on. */
  get lastBeat(): number {
    return this._lastBeat;
  }

  /** Current BPM. */
  get bpm(): number {
    return this.clock.config.bpm;
  }

  /** The active theme id (C20 — retuned via applyTheme). */
  get activeTheme(): string {
    return this._activeTheme;
  }

  /** The drone root frequency (Hz) the active theme's scale root resolves to. */
  get droneRootHz(): number {
    return this._droneRootHz;
  }

  /** The active theme's stepped bit-crush wet fraction ∈ [0,1]. */
  get crushWet(): number {
    return this._crushWet;
  }

  /** Build + start the 2-osc drone (idempotent). Uses the active theme's tuning. */
  start(): void {
    if (this._started) return;
    this._started = true;

    const root = this.mkOsc(this._droneRootHz, this._timbre, 0);
    const fifth = this.mkOsc(this._droneRootHz * DRONE_FIFTH_RATIO, 'sine', DRONE_DETUNE_CENTS);
    this.oscillators = [root, fifth];
    for (const o of this.oscillators) o.start();

    // Prime the beat cursor so the first update pulses on the current beat.
    this._lastBeat = this.clock.beat() - 1;
  }

  /**
   * Advance the synth. On each NEW beat (off the beat clock) it schedules a short
   * gain pulse — the attract loop's pulse. Deterministic on the injected clock.
   */
  update(): void {
    if (!this._started) return;
    const beat = this.clock.beat();
    if (beat > this._lastBeat) {
      this._lastBeat = beat;
      this.pulse();
    }
  }

  /** Retune the drone (theme change): shift the beat clock's BPM. */
  setBpm(bpm: number): void {
    this.clock.setBpm(bpm);
  }

  /**
   * C20 F9 Reality Channels — RETUNE the drone to a theme (scale / BPM / timbre +
   * the stepped bit-crush wet/dry gain). DETERMINISTIC: the drone root resolves
   * from the theme scale's first MIDI note; the crush wet fraction is the theme's
   * `crushWet`. An UNKNOWN theme id is a no-op. Safe to call before or after
   * `start()` — a live drone's oscillators are retuned in place.
   */
  applyTheme(themeId: string): void {
    const theme = getTheme(themeId);
    if (!theme) return; // unknown id → no retune
    this._activeTheme = theme.id;
    // BPM → the beat clock.
    this.clock.setBpm(theme.synth.bpm);
    // Scale root (MIDI) → drone root frequency (Hz).
    this._droneRootHz = midiToHz(theme.synth.scale[0]);
    this._timbre = theme.synth.timbre;
    // Retune a LIVE drone's oscillators in place (root + fifth).
    if (this.oscillators.length === 2) {
      const [root, fifth] = this.oscillators;
      root.type = this._timbre;
      root.frequency.value = this._droneRootHz;
      fifth.frequency.value = this._droneRootHz * DRONE_FIFTH_RATIO;
    }
    // Stepped bit-crush via wet/dry gain (§6.5 — WaveShaper curves aren't
    // automatable, so we crossfade a crushed branch against a clean one).
    this._crushWet = theme.synth.crushWet;
    this.crushWetGain.gain.value = this._crushWet;
    this.crushDryGain.gain.value = 1 - this._crushWet;
  }

  /** Stop + tear down the drone and drop the mixer channel. */
  stop(): void {
    for (const o of this.oscillators) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.oscillators = [];
    this._started = false;
    this.mixer.unregister(this.channel);
  }

  // ---- internals ----------------------------------------------------------

  private mkOsc(freq: number, type: OscillatorType, detuneCents: number): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detuneCents;
    // DRY path: oscillator → crushDryGain → droneGain (clean signal).
    osc.connect(this.crushDryGain);
    // WET path: oscillator → crushShaper → crushWetGain → droneGain (bit-crushed).
    osc.connect(this.crushShaper);
    return osc;
  }

  /** Schedule a short attack→release gain pulse on the drone sub-bus. */
  private pulse(): void {
    const t = this.ctx.currentTime;
    const g = this.droneGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(BEAT_PULSE_LEVEL, t);
    // Exponential-ish decay back to the resting level via setTargetAtTime.
    g.setTargetAtTime(DRONE_LEVEL, t, BEAT_RELEASE_S);
  }
}
