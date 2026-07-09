/**
 * synth.ts — the Resonora note voice pool + local prediction (C18, spec §7.8).
 *
 * A bounded pool of ≤ 12 EQUAL-POWER-panned voices (Quest budget, §6.5): each
 * note plays through a StereoPannerNode (equal-power), NEVER an HRTF PannerNode —
 * HRTF is reserved for room voice, which is structurally absent from the stage bus
 * (§6.2). The pool registers with the C9 stage mixer at PRIORITY 3 (§6.2 — the
 * Resonora quantized-mix rung).
 *
 * LOCAL PREDICTION (spec §7.8): the client schedules its OWN note immediately with
 * a DETERMINISTIC `noteId` (from the shared {@link computeNoteId}); when the server
 * ECHO arrives carrying the SAME noteId, the synth DEDUPES — the predicted note and
 * the echo play as ONE audible note, never two. The sub-50 ms instant impact SFX
 * is a SEPARATE causal transient owned by the caller: {@link shouldPlayInstantSfx}
 * fires it exactly once, on the first (causal, local) sighting of a noteId, and
 * never on the echo — the transient survives under the tonal tail.
 *
 * Web Audio only; no THREE, no DOM. Unit-tested with a mocked AudioContext.
 */

import type { StageMixer, MixPriority } from '../stage/mixer.js';

/** The §6.2 mixer rung for the Resonora quantized mix. */
export const RESONORA_PRIORITY: MixPriority = 3;

/** The Quest voice cap (§6.5) — ≤ 12 pre-allocated equal-power voices. */
export const MAX_VOICES = 12;

/** A note to play (the fields decoded from the C1 MUSIC_NOTE frame). */
export interface PlayNote {
  /** The deterministic dedupe key (predict ≡ echo). */
  noteId: number;
  /** Server play time (ms) — the caller schedules the actual fire via C3. */
  playAtMs: number;
  /** MIDI pitch (0..127). */
  pitch: number;
  /** Timbre recipe index (shape type). */
  timbre: number;
  /** Velocity (1..127). */
  velocity: number;
  /** Stereo pan (i8, -128..127). */
  pan: number;
}

/** One pre-allocated voice: oscillator → gain (env) → panner → the pool sub-bus. */
interface Voice {
  osc: OscillatorNode;
  env: GainNode;
  panner: StereoPannerNode;
  /** Whether this voice is currently sounding. */
  busy: boolean;
  /** The noteId currently occupying the voice (for reuse bookkeeping). */
  noteId: number;
  started: boolean;
}

/** Convert a MIDI pitch to Hz (equal temperament, A4 = 440). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Map a timbre index to an oscillator waveform (deterministic, small palette). */
function waveformForTimbre(timbre: number): OscillatorType {
  const forms: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
  return forms[((timbre % forms.length) + forms.length) % forms.length];
}

/**
 * The Resonora synth voice pool. Construct with the stage AudioContext + mixer.
 * `play(note)` triggers a voice (deduping a repeated noteId). Register happens in
 * the constructor at PRIORITY 3; the pool never routes voice (HRTF) audio.
 */
export class ResonoraSynth {
  /** The mixer channel gain (the handle the mixer ducks). */
  readonly channel: GainNode;

  private readonly ctx: AudioContext;
  private readonly mixer: StageMixer;
  /** The pre-mixer sub-bus every voice feeds (registered on the mixer). */
  private readonly bus: GainNode;
  private readonly voices: Voice[] = [];
  /** noteIds already played (dedupe: a predicted note + its echo share an id). */
  private readonly playedNoteIds = new Set<number>();
  /** noteIds whose instant SFX transient has already fired (once, on causal sight). */
  private readonly sfxFiredNoteIds = new Set<number>();

  private _notesPlayed = 0;
  private _nextVoice = 0;

  constructor(ctx: AudioContext, mixer: StageMixer) {
    this.ctx = ctx;
    this.mixer = mixer;

    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;

    // Pre-allocate the voice pool ONCE (Quest budget — no per-note allocation).
    for (let i = 0; i < MAX_VOICES; i++) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      env.gain.value = 0;
      // EQUAL-POWER pan (StereoPanner) — NEVER an HRTF PannerNode (§6.2/§6.5).
      const panner = ctx.createStereoPanner();
      osc.connect(env);
      env.connect(panner);
      panner.connect(this.bus);
      this.voices.push({ osc, env, panner, busy: false, noteId: -1, started: false });
    }

    // Register the sub-bus on the mixer at PRIORITY 3 (§6.2). NOT voice-tagged.
    this.channel = mixer.register(this.bus, RESONORA_PRIORITY);
  }

  /** How many notes have actually SOUNDED (deduped count). */
  get notesPlayed(): number {
    return this._notesPlayed;
  }

  /** How many voices are currently sounding (≤ {@link MAX_VOICES}). */
  get activeVoiceCount(): number {
    let n = 0;
    for (const v of this.voices) if (v.busy) n++;
    return n;
  }

  /**
   * Should the caller fire the sub-50 ms instant impact SFX (the causal transient)
   * for `noteId`? TRUE only on the FIRST sighting — the local causal event — and
   * FALSE on the server echo. The transient is SEPARATE from the tonal note and is
   * never deduped away; it just fires exactly once, on the causal side.
   */
  shouldPlayInstantSfx(noteId: number): boolean {
    if (this.sfxFiredNoteIds.has(noteId)) return false;
    this.sfxFiredNoteIds.add(noteId);
    return true;
  }

  /**
   * Play a note. If `note.noteId` has already been played (a predicted note's
   * server echo, or a duplicate), this DEDUPES — no second voice is triggered.
   * Returns true iff a voice was actually triggered.
   */
  play(note: PlayNote): boolean {
    if (this.playedNoteIds.has(note.noteId)) return false; // dedupe predict ≡ echo
    this.playedNoteIds.add(note.noteId);

    const voice = this.acquireVoice(note.noteId);
    if (!voice) return false;

    this.trigger(voice, note);
    this._notesPlayed++;
    return true;
  }

  /** Stop + drop the pool from the mixer. */
  stop(): void {
    for (const v of this.voices) {
      try {
        if (v.started) v.osc.stop();
        v.osc.disconnect();
        v.env.disconnect();
        v.panner.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.voices.length = 0;
    this.mixer.unregister(this.channel);
  }

  // ---- internals ----------------------------------------------------------

  /** Acquire a free voice, or steal the next in round-robin (voice-stealing cap). */
  private acquireVoice(noteId: number): Voice | null {
    if (this.voices.length === 0) return null;
    // Prefer an idle voice.
    for (const v of this.voices) {
      if (!v.busy) {
        v.noteId = noteId;
        return v;
      }
    }
    // All busy → steal the next voice round-robin (keeps the cap at MAX_VOICES).
    const v = this.voices[this._nextVoice % this.voices.length];
    this._nextVoice++;
    v.noteId = noteId;
    return v;
  }

  /** Trigger a voice's envelope + pitch + pan for `note`. */
  private trigger(voice: Voice, note: PlayNote): void {
    const t = this.ctx.currentTime;
    voice.busy = true;

    voice.osc.type = waveformForTimbre(note.timbre);
    voice.osc.frequency.setValueAtTime(midiToHz(note.pitch), t);
    // Equal-power pan: StereoPanner takes -1..1; i8 pan / 128.
    voice.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, note.pan / 128)), t);

    // A short percussive-ish AD envelope scaled by velocity.
    const peak = Math.max(0.02, Math.min(1, note.velocity / 127)) * 0.6;
    const g = voice.env.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + 0.005);
    g.setTargetAtTime(0.0001, t + 0.01, 0.18);

    if (!voice.started) {
      voice.osc.start();
      voice.started = true;
    }
    // The voice stays `busy` for its audible tail; the oscillator keeps running
    // and is silent between notes (no per-note allocation on the audio thread).
    // The pool can never exceed MAX_VOICES because it IS the fixed pool.
  }
}
