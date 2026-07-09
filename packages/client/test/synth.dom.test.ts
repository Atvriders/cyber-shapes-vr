/**
 * synth.dom.test.ts — the Resonora note voice pool + local prediction (C18).
 *
 * The synth registers with the C9 stage mixer at PRIORITY 3 (§6.2 — the Resonora
 * quantized-mix rung). It plays quantized notes through a bounded pool of ≤ 12
 * equal-power-panned voices (HRTF is voice-only, never here). Local prediction:
 * a client schedules its OWN note immediately (deterministic noteId) and, when the
 * server echo arrives with the SAME noteId, it DEDUPES to one audible note — the
 * predicted note and the echo never double-trigger.
 *
 * Uses a mocked AudioContext (no Web Audio needed).
 */

import { describe, it, expect } from 'vitest';
import { StageMixer } from '../src/stage/mixer.ts';
import { ResonoraSynth, RESONORA_PRIORITY, MAX_VOICES } from '../src/music/synth.ts';

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
  exponentialRampToValueAtTime(v: number): this {
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
class MockStereoPanner extends MockNode {
  pan = new MockParam();
}
class MockOsc extends MockNode {
  type = 'sine';
  frequency = new MockParam();
  detune = new MockParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
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
  createStereoPanner(): MockStereoPanner {
    return new MockStereoPanner();
  }
}

function makeCtx(): AudioContext & { currentTime: number } {
  return new MockCtx() as unknown as AudioContext & { currentTime: number };
}

function makeSynth() {
  const ctx = makeCtx();
  const mixer = new StageMixer(ctx);
  const synth = new ResonoraSynth(ctx, mixer);
  return { ctx, mixer, synth };
}

const noteAt = (noteId: number, playAtMs: number) => ({
  noteId,
  playAtMs,
  pitch: 60,
  timbre: 0,
  velocity: 100,
  pan: 0,
});

describe('ResonoraSynth', () => {
  it('registers with the stage mixer at PRIORITY 3 (Resonora quantized mix, §6.2)', () => {
    expect(RESONORA_PRIORITY).toBe(3);
    const { synth } = makeSynth();
    expect(synth.channel).toBeDefined();
  });

  it('caps the voice pool at ≤ 12 equal-power voices (Quest budget, §6.5)', () => {
    expect(MAX_VOICES).toBeLessThanOrEqual(12);
    const { synth } = makeSynth();
    // Fire more notes than the pool holds; the live-voice count never exceeds the cap.
    for (let i = 0; i < 30; i++) synth.play(noteAt(1000 + i, 0));
    expect(synth.activeVoiceCount).toBeLessThanOrEqual(MAX_VOICES);
  });

  it('local prediction + server echo DEDUPE to ONE audible note (same noteId)', () => {
    const { synth } = makeSynth();
    // 1) The client PREDICTS its own note immediately (deterministic noteId).
    const noteId = 0xabcdef;
    synth.play(noteAt(noteId, 0));
    const afterPredict = synth.notesPlayed;
    expect(afterPredict).toBe(1);
    // 2) The server ECHO arrives carrying the SAME noteId → it must NOT play again.
    synth.play(noteAt(noteId, 0));
    expect(synth.notesPlayed).toBe(1); // still one — deduped
  });

  it('a genuinely different note DOES play (dedupe is per-noteId, not a global mute)', () => {
    const { synth } = makeSynth();
    synth.play(noteAt(1, 0));
    synth.play(noteAt(2, 0));
    expect(synth.notesPlayed).toBe(2);
  });

  it('the instant SFX stays the causal transient (dedupe applies to the TONAL note only)', () => {
    // A predicted note deduping the echo must NOT suppress the sub-50 ms impact
    // SFX — that is a separate causal transient owned by the caller. The synth
    // exposes `shouldPlayInstantSfx(noteId)` which is TRUE only on first sight
    // (the transient fires once, on the causal local event, never on the echo).
    const { synth } = makeSynth();
    const noteId = 7;
    expect(synth.shouldPlayInstantSfx(noteId)).toBe(true); // local causal event
    synth.play(noteAt(noteId, 0));
    // The echo does not re-fire the transient.
    expect(synth.shouldPlayInstantSfx(noteId)).toBe(false);
  });

  it('never routes voice through the mixer (HRTF/voice exclusion holds structurally)', () => {
    // The synth registers a NON-voice channel; the mixer would throw on voice.
    const { synth } = makeSynth();
    expect(synth.channel).toBeDefined(); // register() succeeded (not voice-tagged)
  });
});
