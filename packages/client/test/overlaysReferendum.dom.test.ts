/**
 * overlaysReferendum.dom.test.ts — Task C15 (F5 Reality Referendum) big-screen
 * chrome: the dueling tally bars, the countdown takeover, and the "THE CROWD
 * DECREED" enactment splash (spec §7.5 — "Big screen owns the drama").
 *
 * DOM-only (StageOverlays never imports three). 5-meter legible per §7.1.
 */

import { describe, it, expect } from 'vitest';
import { StageOverlays } from '../src/stage/overlays.ts';

describe('C15 overlays — dueling tally bars', () => {
  it('renders one bar per option with its share width from a tally', () => {
    const ov = new StageOverlays(document);
    ov.setReferendumTally({
      options: ['low-g', 'gravity-flip'],
      tally: { 'low-g': 7, 'gravity-flip': 3 },
      voterCount: 10,
    });
    const bars = ov.root.querySelectorAll('[data-role="referendum-bar"]');
    expect(bars.length).toBe(2);
    const lowG = ov.root.querySelector(
      '[data-role="referendum-bar"][data-option="low-g"]'
    ) as HTMLElement;
    expect(lowG.dataset.count).toBe('7');
    // 7/10 → 70% width.
    expect(lowG.style.width).toBe('70%');
  });

  it('C22.5 §6.1 audit: the bar TEXT carries the option name + count (color/width is never the only signal)', () => {
    const ov = new StageOverlays(document);
    ov.setReferendumTally({
      options: ['low-g', 'gravity-flip'],
      tally: { 'low-g': 7, 'gravity-flip': 3 },
      voterCount: 10,
    });
    const lowG = ov.root.querySelector(
      '[data-role="referendum-bar"][data-option="low-g"]'
    ) as HTMLElement;
    const flip = ov.root.querySelector(
      '[data-role="referendum-bar"][data-option="gravity-flip"]'
    ) as HTMLElement;
    // The visible TEXT (not just a data attribute) carries the option + count — a
    // colorblind viewer reading the bar itself (not just its width/color) still
    // gets the same information a sighted viewer does.
    expect(lowG.textContent).toContain('LOW G');
    expect(lowG.textContent).toContain('7');
    expect(flip.textContent).toContain('GRAVITY FLIP');
    expect(flip.textContent).toContain('3');
  });

  it('clearing the tally hides the referendum region', () => {
    const ov = new StageOverlays(document);
    ov.setReferendumTally({
      options: ['low-g'],
      tally: { 'low-g': 1 },
      voterCount: 1,
    });
    expect(ov.referendumActive).toBe(true);
    ov.clearReferendum();
    expect(ov.referendumActive).toBe(false);
  });
});

describe('C15 overlays — countdown takeover', () => {
  it('shows the countdown when set and clears at zero', () => {
    const ov = new StageOverlays(document);
    ov.setReferendumCountdown(5);
    const cd = ov.root.querySelector('[data-role="referendum-countdown"]') as HTMLElement;
    expect(cd.hidden).toBe(false);
    expect(cd.textContent).toContain('5');
    ov.setReferendumCountdown(null);
    expect(cd.hidden).toBe(true);
  });
});

describe('C15 overlays — "THE CROWD DECREED" enactment splash', () => {
  it('shows the decree splash with the winning law name', () => {
    const ov = new StageOverlays(document);
    ov.showCrowdDecreed('LOW GRAVITY');
    const splash = ov.root.querySelector('[data-role="referendum-decree"]') as HTMLElement;
    expect(splash.hidden).toBe(false);
    expect(splash.textContent).toContain('THE CROWD DECREED');
    expect(splash.textContent).toContain('LOW GRAVITY');
  });

  it('the decree splash uses the cue banner slot at replay-adjacent priority (takeover)', () => {
    const ov = new StageOverlays(document);
    // The decree is a takeover moment — it should own the shared banner region.
    ov.showCrowdDecreed('CEILING GRAVITY');
    expect(ov.activeSlot()).toBe('cue');
    expect((ov.root.querySelector('[data-role="banner"]') as HTMLElement).textContent).toContain(
      'CROWD DECREED'
    );
  });
});
