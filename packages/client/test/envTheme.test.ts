/**
 * envTheme.test.ts — the in-headset countdown driver (C10, spec §7.2).
 *
 * Verifies the countdown contract: an environmental RED PULSE + KLAXON, NEVER a
 * numeric countdown in the headset. The driver maps PHASE_STATE remainingMs → a
 * red-pulse intensity + a klaxon schedule via an injected sink (no DOM/three).
 */

import { describe, it, expect } from 'vitest';
import {
  CountdownDriver,
  redPulseIntensity,
  COUNTDOWN_WINDOW_MS,
  KLAXON_SCHEDULE_MS,
  type EnvThemeSink,
} from '../src/envTheme.ts';

function makeSink(): EnvThemeSink & { pulses: number[]; klaxons: number } {
  const state = { pulses: [] as number[], klaxons: 0 };
  return {
    pulses: state.pulses,
    get klaxons() {
      return state.klaxons;
    },
    setRedPulse(v: number) {
      state.pulses.push(v);
    },
    fireKlaxon() {
      state.klaxons++;
    },
  } as EnvThemeSink & { pulses: number[]; klaxons: number };
}

describe('C10 envTheme — redPulseIntensity ramp (comfort ≤ 3 Hz, color-only)', () => {
  it('is 0 outside the countdown window and null (ATTRACT)', () => {
    expect(redPulseIntensity(null)).toBe(0);
    expect(redPulseIntensity(COUNTDOWN_WINDOW_MS + 1)).toBe(0);
    expect(redPulseIntensity(-1)).toBe(0);
  });

  it('ramps toward 1 as the phase-end nears (0 at window edge, ~1 at 0 ms)', () => {
    // At the window edge, ramp is 0 → intensity 0.
    expect(redPulseIntensity(COUNTDOWN_WINDOW_MS, 0)).toBeCloseTo(0, 5);
    // Near the end, ramp is high; at elapsed 0 the osc is at its peak (0.75+0.25=1).
    const near = redPulseIntensity(100, 0);
    expect(near).toBeGreaterThan(0.9);
    // Intensity is always within [0,1].
    for (let r = 0; r <= COUNTDOWN_WINDOW_MS; r += 500) {
      const v = redPulseIntensity(r, 123);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('C10 envTheme — CountdownDriver (red pulse + klaxon schedule)', () => {
  it('applies a red pulse each update within the window', () => {
    const sink = makeSink();
    const driver = new CountdownDriver(sink);
    driver.update(2_000, 0);
    expect(sink.pulses.length).toBe(1);
    expect(sink.pulses[0]).toBeGreaterThan(0);
  });

  it('fires a klaxon ONCE as remaining crosses each scheduled threshold', () => {
    const sink = makeSink();
    const driver = new CountdownDriver(sink);
    // Walk the countdown down through every threshold.
    driver.update(6_000); // above the first threshold (5s) — no klaxon yet
    expect(sink.klaxons).toBe(0);
    driver.update(4_900); // crossed 5s → 1 klaxon
    expect(sink.klaxons).toBe(1);
    driver.update(4_800); // still below 5s but not a new threshold → no extra
    expect(sink.klaxons).toBe(1);
    driver.update(2_900); // crossed 3s → 2 klaxons
    expect(sink.klaxons).toBe(2);
    driver.update(900); // crossed 1s → 3 klaxons
    expect(sink.klaxons).toBe(KLAXON_SCHEDULE_MS.length);
  });

  it('re-arms the klaxons on a phase change (remaining jumps up / goes null)', () => {
    const sink = makeSink();
    const driver = new CountdownDriver(sink);
    driver.update(900); // fires all three thresholds at once (≤1s)
    expect(sink.klaxons).toBe(KLAXON_SCHEDULE_MS.length);
    // New phase: remaining jumps back up → the fired-set resets.
    driver.update(45_000);
    driver.update(900); // fires all three again for the new phase
    expect(sink.klaxons).toBe(KLAXON_SCHEDULE_MS.length * 2);
  });

  it('NEVER emits a numeric countdown — the sink has no number-setter, only pulse + klaxon', () => {
    // The EnvThemeSink surface is strictly {setRedPulse, fireKlaxon}. This is the
    // structural guarantee that the in-headset countdown carries no numeral (the
    // numeric countdown is stage-only, spec §7.2).
    const sink = makeSink();
    const keys = Object.keys(sink).filter((k) => typeof (sink as never)[k] === 'function');
    expect(keys.sort()).toEqual(['fireKlaxon', 'setRedPulse']);
  });

  it('reset() clears the pulse to 0 and re-arms the klaxons', () => {
    const sink = makeSink();
    const driver = new CountdownDriver(sink);
    driver.update(900);
    const firedBefore = sink.klaxons;
    driver.reset();
    expect(sink.pulses[sink.pulses.length - 1]).toBe(0);
    driver.update(900);
    expect(sink.klaxons).toBe(firedBefore + KLAXON_SCHEDULE_MS.length);
  });
});
