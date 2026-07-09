/**
 * overlaysClipTakeHome.dom.test.ts — Task C31 (F20 Neon Clip Machine, spec §7.20)
 * MUST-FIX 3: the STATS/RESET "SCAN TO TAKE YOUR CLIP HOME" card.
 *
 * The §7.20 review found CLIP_TAKE_HOME_HEADLINE + CLIP_TAKE_HOME_CARD_MS were
 * dead constants consumed by NOTHING — overlays.ts rendered no take-home card, so
 * the mandated on-stage CTA never appeared. These tests prove the card is now
 * wired: it renders the mandated headline at STATS/RESET and auto-clears after its
 * duration. DOM-only (StageOverlays never imports three); jsdom-testable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { StageOverlays } from '../src/stage/overlays.ts';
import { CLIP_TAKE_HOME_HEADLINE, CLIP_TAKE_HOME_CARD_MS } from '../src/stage/clips.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('C31 MF3 — STATS/RESET take-home card', () => {
  it('is hidden until STATS/RESET, then renders the §7.20 headline', () => {
    const ov = new StageOverlays(document);
    const el = ov.root.querySelector('[data-role="clip-take-home"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.hidden).toBe(true);
    expect(ov.clipTakeHomeActive).toBe(false);

    ov.showClipTakeHomeCard();
    expect(el.hidden).toBe(false);
    expect(ov.clipTakeHomeActive).toBe(true);
    // The mandated CTA copy is actually on the big screen.
    expect(ov.clipTakeHomeText()).toBe(CLIP_TAKE_HOME_HEADLINE);
    expect(CLIP_TAKE_HOME_HEADLINE).toBe('SCAN TO TAKE YOUR CLIP HOME');
    const headline = el.querySelector('[data-role="clip-take-home-headline"]') as HTMLElement;
    expect(headline.textContent).toBe('SCAN TO TAKE YOUR CLIP HOME');
  });

  it('carries the retrieval URL for the QR raster when given', () => {
    const ov = new StageOverlays(document);
    const el = ov.root.querySelector('[data-role="clip-take-home"]') as HTMLElement;
    const url = 'https://booth.example/api/clips/' + 'a'.repeat(32);
    ov.showClipTakeHomeCard(url);
    expect(el.dataset.url).toBe(url);
    const urlEl = el.querySelector('[data-role="clip-take-home-url"]') as HTMLElement;
    expect(urlEl.textContent).toBe(url);
    // No URL → no data-url attr (headline-only card still shows).
    const ov2 = new StageOverlays(document);
    ov2.showClipTakeHomeCard();
    const el2 = ov2.root.querySelector('[data-role="clip-take-home"]') as HTMLElement;
    expect(el2.dataset.url).toBeUndefined();
    expect(ov2.clipTakeHomeActive).toBe(true);
  });

  it('auto-clears after ~CLIP_TAKE_HOME_CARD_MS (the spec ~20 s duration)', () => {
    vi.useFakeTimers();
    const ov = new StageOverlays(document);
    ov.showClipTakeHomeCard();
    expect(ov.clipTakeHomeActive).toBe(true);
    // Just before the duration — still shown.
    vi.advanceTimersByTime(CLIP_TAKE_HOME_CARD_MS - 1);
    expect(ov.clipTakeHomeActive).toBe(true);
    // At the duration — auto-cleared.
    vi.advanceTimersByTime(2);
    expect(ov.clipTakeHomeActive).toBe(false);
    expect(ov.clipTakeHomeText()).toBe('');
    expect(CLIP_TAKE_HOME_CARD_MS).toBe(20_000);
  });

  it('hideClipTakeHomeCard() clears it immediately (rotation boundary / LOBBY)', () => {
    const ov = new StageOverlays(document);
    ov.showClipTakeHomeCard('https://x/api/clips/' + 'b'.repeat(32));
    expect(ov.clipTakeHomeActive).toBe(true);
    ov.hideClipTakeHomeCard();
    expect(ov.clipTakeHomeActive).toBe(false);
    const el = ov.root.querySelector('[data-role="clip-take-home"]') as HTMLElement;
    expect(el.dataset.url).toBeUndefined();
  });

  it('a re-show resets the auto-clear timer (idempotent, no premature hide)', () => {
    vi.useFakeTimers();
    const ov = new StageOverlays(document);
    ov.showClipTakeHomeCard();
    vi.advanceTimersByTime(CLIP_TAKE_HOME_CARD_MS - 100);
    // Re-show before the first timer fires — the countdown restarts.
    ov.showClipTakeHomeCard();
    vi.advanceTimersByTime(200); // past the FIRST timer's fire point
    expect(ov.clipTakeHomeActive).toBe(true); // not prematurely hidden
    vi.advanceTimersByTime(CLIP_TAKE_HOME_CARD_MS);
    expect(ov.clipTakeHomeActive).toBe(false);
  });
});
