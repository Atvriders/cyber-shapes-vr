/**
 * overlaysCaster.dom.test.ts — Task C26 (F15 MC NULL) stage caption renderer +
 * panic / mute / TTS garnish (spec §7.15 / §6.1). DOM-only (StageOverlays never
 * imports three). The stage RENDERS from (templateId + slots) via the shared
 * grammar — it NEVER generates a line — and a caption never carries a raw string
 * on the wire (§6.1 attribution redundancy: the callsign is rendered as text).
 */

import { describe, it, expect, vi } from 'vitest';
import { StageOverlays } from '../src/stage/overlays.ts';
import { casterSlotsToWire, type CasterSlot } from '@cyber-shapes/shared';

// A throw-normal template (id 2) with a callsign + release-velocity number.
const THROW_TEMPLATE = 2;
const THROW_SLOTS: CasterSlot[] = [
  { kind: 'callsign', who: { wordIndex: 0, suffix: 17 } }, // VOLT-17
  { kind: 'num', value: 18.4 },
];
const THROW_WIRE = casterSlotsToWire(THROW_SLOTS); // [1,0,17, 0,184,0]

describe('C26 overlays — caster caption renderer', () => {
  it('renders a CASTER_LINE (templateId + wire slots) into the caption — with the callsign as TEXT', () => {
    const ov = new StageOverlays(document);
    const text = ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE);
    expect(text).toBe('VOLT-17 RIPS IT · 18.4 M/S');
    expect(ov.bannerText()).toContain('VOLT-17'); // attribution reads sound-off
    expect(ov.activeSlot()).toBe('caster');
  });

  it('never airs an unknown template or an over-budget line', () => {
    const ov = new StageOverlays(document);
    expect(ov.setCasterLine(9999, THROW_WIRE)).toBeNull(); // unknown template id
    expect(ov.bannerText()).toBe('');
  });

  it('a higher-priority slot (replay / cue) suppresses the caption but retains it', () => {
    const ov = new StageOverlays(document);
    ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE);
    ov.setCueBanner('BULLET TIME ×0.25');
    expect(ov.activeSlot()).toBe('cue'); // cue > caster
    ov.clearSlot('cue');
    expect(ov.activeSlot()).toBe('caster'); // caption re-shows
  });
});

describe('C26 overlays — panic + mute', () => {
  it('panic clears the caption AND suppresses further lines (+ cancels TTS)', () => {
    const ov = new StageOverlays(document);
    ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE);
    expect(ov.bannerText()).not.toBe('');
    ov.panicCaster();
    expect(ov.bannerText()).toBe('');
    expect(ov.casterSuppressed).toBe(true);
    // A further line is suppressed while panicked.
    expect(ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE)).toBeNull();
    expect(ov.bannerText()).toBe('');
    // Resume lifts the suppression.
    ov.resumeCaster();
    expect(ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE)).not.toBeNull();
  });

  it('the caster-mute cue suppresses captions', () => {
    const ov = new StageOverlays(document);
    ov.setCasterMuted(true);
    expect(ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE)).toBeNull();
    ov.setCasterMuted(false);
    expect(ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE)).not.toBeNull();
  });
});

describe('C26 overlays — TTS duck-shim (default OFF)', () => {
  function withMockSynth(): { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
    const synth = { speak: vi.fn(), cancel: vi.fn() };
    const win = document.defaultView as unknown as Record<string, unknown>;
    win['speechSynthesis'] = synth;
    win['SpeechSynthesisUtterance'] = class {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      constructor(public text: string) {}
    };
    return synth;
  }

  it('does NOT speak when TTS is off (the default)', () => {
    const synth = withMockSynth();
    const ov = new StageOverlays(document);
    ov.setCasterLine(THROW_TEMPLATE, THROW_WIRE);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('speaks + ducks a low-priority line when TTS is enabled', () => {
    const synth = withMockSynth();
    const ov = new StageOverlays(document);
    const duck = vi.fn();
    ov.setCasterDuck(duck);
    ov.setCasterTts(true);
    // Template 0 is throw-CALM (priority 3) → it ducks the mix on start.
    ov.setCasterLine(0, THROW_WIRE);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    const utter = synth.speak.mock.calls[0][0] as { onstart: () => void; onend: () => void };
    utter.onstart();
    expect(duck).toHaveBeenLastCalledWith(true);
    utter.onend();
    expect(duck).toHaveBeenLastCalledWith(false);
  });

  it('a priority-1 line cancels any in-flight utterance (barges in)', () => {
    const synth = withMockSynth();
    const ov = new StageOverlays(document);
    ov.setCasterTts(true);
    // Template 13 is record-CALM (priority 1) → cancels current speech first.
    const recordSlots = casterSlotsToWire([
      { kind: 'callsign', who: { wordIndex: 0, suffix: 17 } },
      { kind: 'num', value: 24 },
    ]);
    ov.setCasterLine(13, recordSlots);
    expect(synth.cancel).toHaveBeenCalled();
    expect(synth.speak).toHaveBeenCalledTimes(1);
  });
});
