/**
 * overlaysResonora.dom.test.ts — Task C18 (F8 Resonora) big-screen causality
 * visualization (spec §7.8 — a HARD deliverable, must survive sound-off):
 *   • a stage BEAT RING that pulses on the beat, and
 *   • a per-note FLASH drawn ON the impacting shape AT `playAtServerTime`,
 *     color-coded per player.
 *
 * DOM-only (StageOverlays never imports three). The flash is scheduled through an
 * INJECTED scheduler so the "fire at playAtServerTime" timing is deterministic in
 * a test (no real clock).
 */

import { describe, it, expect } from 'vitest';
import { StageOverlays } from '../src/stage/overlays.ts';

describe('C18 overlays — stage beat ring', () => {
  it('pulses the beat ring on a new beat (data-beat updates; a pulse marker set)', () => {
    const ov = new StageOverlays(document);
    ov.pulseBeatRing(4);
    const ring = ov.root.querySelector('[data-role="beat-ring"]') as HTMLElement;
    expect(ring).toBeTruthy();
    expect(ring.hidden).toBe(false);
    expect(ring.dataset.beat).toBe('4');
    // A pulse toggles a marker CSS can animate off.
    expect(ring.dataset.pulse).toBeDefined();
  });

  it('toggles the pulse marker across successive beats (so CSS re-triggers)', () => {
    const ov = new StageOverlays(document);
    ov.pulseBeatRing(1);
    const ring = ov.root.querySelector('[data-role="beat-ring"]') as HTMLElement;
    const first = ring.dataset.pulse;
    ov.pulseBeatRing(2);
    expect(ring.dataset.pulse).not.toBe(first);
  });
});

describe('C18 overlays — per-note flash ON the impacting shape at playAtServerTime', () => {
  it('schedules the flash and fires it AT playAtServerTime (injected scheduler)', () => {
    // A tiny fake scheduler that records the requested fire time and lets the test
    // release it — mimicking C3 scheduleAt(fireAtServerTime, …).
    let firedAt: number | null = null;
    let pending: (() => void) | null = null;
    const schedule = (fireAtServerTime: number, cb: () => void) => {
      firedAt = fireAtServerTime;
      pending = cb;
      return { cancel() {} };
    };

    const ov = new StageOverlays(document);
    ov.flashNoteOnShape(
      { shapeId: 'w7', colorHex: '#00ffff', playAtServerTime: 1234 },
      schedule
    );
    // The flash is scheduled for playAtServerTime, not drawn yet.
    expect(firedAt).toBe(1234);
    expect(ov.root.querySelector('[data-role="note-flash"][data-shape="w7"]')).toBeNull();

    // Release the scheduled callback → the flash appears ON the shape.
    pending!();
    const flash = ov.root.querySelector(
      '[data-role="note-flash"][data-shape="w7"]'
    ) as HTMLElement;
    expect(flash).toBeTruthy();
    expect(flash.dataset.shape).toBe('w7');
    // Color-coded per player (the shape's player color).
    expect(flash.style.color || flash.style.backgroundColor || flash.dataset.color).toBeTruthy();
  });

  it('color-codes the flash per player (distinct colors coexist)', () => {
    const fire: Array<() => void> = [];
    const schedule = (_t: number, cb: () => void) => {
      fire.push(cb);
      return { cancel() {} };
    };
    const ov = new StageOverlays(document);
    ov.flashNoteOnShape({ shapeId: 'a', colorHex: '#ff00ff', playAtServerTime: 0 }, schedule);
    ov.flashNoteOnShape({ shapeId: 'b', colorHex: '#00ff66', playAtServerTime: 0 }, schedule);
    fire.forEach((f) => f());
    const a = ov.root.querySelector('[data-role="note-flash"][data-shape="a"]') as HTMLElement;
    const b = ov.root.querySelector('[data-role="note-flash"][data-shape="b"]') as HTMLElement;
    expect(a.dataset.color).toBe('#ff00ff');
    expect(b.dataset.color).toBe('#00ff66');
  });
});

describe('C22.5 §6.1 audit — note flash carries pattern + per-entity id, never color alone', () => {
  it('ALWAYS sets a pattern token, even when the caller omits one (default "solid", never absent)', () => {
    const fire: Array<() => void> = [];
    const schedule = (_t: number, cb: () => void) => {
      fire.push(cb);
      return { cancel() {} };
    };
    const ov = new StageOverlays(document);
    ov.flashNoteOnShape({ shapeId: 'w7', colorHex: '#00ffff', playAtServerTime: 0 }, schedule);
    fire.forEach((f) => f());
    const flash = ov.root.querySelector('[data-role="note-flash"][data-shape="w7"]') as HTMLElement;
    expect(flash.dataset.pattern).toBe('solid');
    // The per-entity identity token (shape id) is present alongside the color —
    // a colorblind viewer can tell this flash apart from another without color.
    expect(flash.dataset.shape).toBe('w7');
  });

  it('two flashes sharing the SAME colorHex are still distinguishable via pattern + shape id', () => {
    const fire: Array<() => void> = [];
    const schedule = (_t: number, cb: () => void) => {
      fire.push(cb);
      return { cancel() {} };
    };
    const ov = new StageOverlays(document);
    ov.flashNoteOnShape(
      { shapeId: 'a', colorHex: '#ff00ff', playAtServerTime: 0, pattern: 'stripe' },
      schedule
    );
    ov.flashNoteOnShape(
      { shapeId: 'b', colorHex: '#ff00ff', playAtServerTime: 0, pattern: 'dot' },
      schedule
    );
    fire.forEach((f) => f());
    const a = ov.root.querySelector('[data-role="note-flash"][data-shape="a"]') as HTMLElement;
    const b = ov.root.querySelector('[data-role="note-flash"][data-shape="b"]') as HTMLElement;
    // Same color on both — the ONLY way to tell them apart without color vision is
    // the pattern token + the per-entity shape id, both of which must differ here.
    expect(a.dataset.color).toBe(b.dataset.color);
    expect(a.dataset.pattern).not.toBe(b.dataset.pattern);
    expect(a.dataset.shape).not.toBe(b.dataset.shape);
  });
});
