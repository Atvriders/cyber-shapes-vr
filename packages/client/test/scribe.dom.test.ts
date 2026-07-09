/**
 * scribe.dom.test.ts — the C12 phone Neon Guestbook scribe (spec §7.13). jsdom
 * (matched by the `.dom.test.ts` glob). Covers the DOM-only surface: the resample
 * message helper, the kaleidoscope draw not throwing, the send wiring emitting a
 * `glyph-add`, the private `glyph-ack {callsign, ring}` closing the loop, and the
 * import-graph guarantee that the scribe never pulls `three` (crowd < 100 KB).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { encodeText, resampleStroke, GLYPH_MAX_POINTS } from '@cyber-shapes/shared';
import {
  makeGlyphAddMessage,
  drawKaleidoscope,
  toNormalized,
  mountScribe,
  KALEIDO_FOLDS,
  SCRIBE_COLORS,
} from '../src/funnel/scribe.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('C12 scribe — helpers', () => {
  it('makeGlyphAddMessage resamples the raw stroke to ≤ 32 points', () => {
    const raw = Array.from({ length: 300 }, (_, i) => ({ x: (i / 299) * 2 - 1, y: 0 }));
    const msg = makeGlyphAddMessage(raw, '#00ffff');
    expect(msg.t).toBe('glyph-add');
    expect(msg.color).toBe('#00ffff');
    expect(msg.points.length).toBeLessThanOrEqual(GLYPH_MAX_POINTS);
    // It uses the shared resampler (same result).
    expect(msg.points).toEqual(resampleStroke(raw));
  });

  it('toNormalized maps a canvas point to center-origin [-1, 1] space', () => {
    // Center of a 320×320 canvas → origin.
    expect(toNormalized(160, 160, 320, 320)).toEqual({ x: 0, y: 0 });
    // Right edge → ~+1 on x.
    expect(toNormalized(320, 160, 320, 320).x).toBeCloseTo(1, 6);
  });

  it('drawKaleidoscope draws 6-fold without throwing (short + long strokes)', () => {
    expect(KALEIDO_FOLDS).toBe(6);
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    // jsdom ships without a 2D canvas backend; the browser has one. Skip the draw
    // assertion when the context is unavailable (the scribe guards `if (ctx)`).
    if (!ctx) return;
    // Empty / one-point strokes are a no-op (guarded), not a throw.
    expect(() => drawKaleidoscope(ctx, [], SCRIBE_COLORS[0], 200, 200)).not.toThrow();
    expect(() =>
      drawKaleidoscope(ctx, [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }], SCRIBE_COLORS[1], 200, 200)
    ).not.toThrow();
  });
});

describe('C12 scribe — mount + wire', () => {
  it('SEND emits a `glyph-add` on the socket and the glyph-ack updates the prompt', () => {
    const sent: string[] = [];
    let msgCb: ((ev: { data: unknown }) => void) | null = null;
    const ws = {
      send: (d: string) => sent.push(d),
      addEventListener: (_t: string, cb: (ev: { data: unknown }) => void) => {
        msgCb = cb;
      },
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = mountScribe(root, ws);

    // Simulate a drawn stroke by dispatching pointer events on the canvas.
    const canvas = root.querySelector('[data-role="scribe-canvas"]') as HTMLCanvasElement;
    const sendBtn = root.querySelector('[data-role="scribe-send"]') as HTMLButtonElement;
    // Before any stroke, SEND is disabled.
    expect(sendBtn.disabled).toBe(true);

    const pd = new Event('pointerdown') as PointerEvent & { clientX: number; clientY: number };
    Object.assign(pd, { clientX: 100, clientY: 100 });
    canvas.dispatchEvent(pd);
    const pm = new Event('pointermove') as PointerEvent & { clientX: number; clientY: number };
    Object.assign(pm, { clientX: 200, clientY: 200 });
    canvas.dispatchEvent(pm);
    canvas.dispatchEvent(new Event('pointerup'));

    expect(sendBtn.disabled).toBe(false);
    sendBtn.click();
    expect(sent).toHaveLength(1);
    const decoded = JSON.parse(sent[0]);
    expect(decoded.t).toBe('glyph-add');
    expect(typeof decoded.color).toBe('string');
    expect(Array.isArray(decoded.points)).toBe(true);

    // The server acks with {callsign, ring}; the prompt closes the loop.
    msgCb!({ data: encodeText({ t: 'glyph-ack', callsign: 'VOLT-17', ring: 2 } as never) });
    const prompt = root.querySelector('.scribe-prompt') as HTMLElement;
    expect(prompt.textContent).toContain('VOLT-17');
    expect(prompt.textContent).toContain('ring 2');

    handle.release();
    root.remove();
  });

  it('the scribe module never statically imports `three` (crowd chunk stays < 100 KB)', () => {
    const src = readFileSync(resolve(HERE, '../src/funnel/scribe.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]three['"]/);
    expect(src).not.toMatch(/import\(['"]three['"]\)/);
  });
});
