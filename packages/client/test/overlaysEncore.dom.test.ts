/**
 * overlaysEncore.dom.test.ts — Task C19 (F12 Supernova Encore) big-screen
 * constellation mirror (spec §7.13 — "the constellation mirror (complete at 5
 * phones)"). DOM-only (StageOverlays never imports three).
 */

import { describe, it, expect } from 'vitest';
import { StageOverlays } from '../src/stage/overlays.ts';

describe('C19 overlays — constellation mirror', () => {
  it('is hidden until the encore arms, then shows one star per phone', () => {
    const ov = new StageOverlays(document);
    const el = ov.root.querySelector('[data-role="constellation"]') as HTMLElement;
    expect(el.hidden).toBe(true);
    ov.updateConstellation(3, 60);
    expect(el.hidden).toBe(false);
    const stars = el.querySelectorAll('[data-role="constellation-star"]');
    expect(stars.length).toBe(3);
    expect(el.dataset.phones).toBe('3');
  });

  it('COMPLETES at 5 phones (data-complete flips at the threshold)', () => {
    const ov = new StageOverlays(document);
    const el = ov.root.querySelector('[data-role="constellation"]') as HTMLElement;
    ov.updateConstellation(4, 80);
    expect(el.dataset.complete).toBe('0');
    ov.updateConstellation(5, 90);
    expect(el.dataset.complete).toBe('1');
    expect(el.querySelectorAll('[data-role="constellation-star"]').length).toBe(5);
  });

  it('drives the charge bar from the CHARGE_STATE percentage (clamped)', () => {
    const ov = new StageOverlays(document);
    const bar = ov.root.querySelector('[data-role="constellation-charge"]') as HTMLElement;
    ov.updateConstellation(5, 42);
    expect(bar.dataset.charge).toBe('42');
    expect(bar.style.width).toBe('42%');
    ov.updateConstellation(5, 300); // clamps to 100
    expect(bar.dataset.charge).toBe('100');
  });

  it('caps the star field for legibility (never a starfield DoS)', () => {
    const ov = new StageOverlays(document);
    const el = ov.root.querySelector('[data-role="constellation"]') as HTMLElement;
    ov.updateConstellation(500, 100);
    expect(el.querySelectorAll('[data-role="constellation-star"]').length).toBe(64);
    // The reported phone count is the TRUE count (only the render is capped).
    expect(el.dataset.phones).toBe('500');
    expect(el.dataset.complete).toBe('1');
  });

  it('hideConstellation() hides the mirror at encore END', () => {
    const ov = new StageOverlays(document);
    ov.updateConstellation(5, 100);
    expect(ov.constellationActive).toBe(true);
    ov.hideConstellation();
    expect(ov.constellationActive).toBe(false);
  });
});
