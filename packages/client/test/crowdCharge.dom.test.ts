/**
 * crowdCharge.dom.test.ts — Task C19 (F12 Supernova Encore) phone light rig +
 * charge UI (spec §7.13). DOM-only (crowdCharge never imports three — the crowd
 * chunk stays < 100 KB gz).
 *
 * Verifies: a TAP sends the `charge-tap` intent (debounced ≤ 5/s client-side); a
 * CHARGE_STATE frame drives the meter; a BRIGHTNESS_PROMPT emphasises the prompt;
 * a PALETTE_FLASH fires the SINGLE synchronized flash at the frame's fireAt (via
 * an injected clock/setTimeout); the flash respects the ≤ 3 Hz single-pulse cap.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeText,
  decodeText,
  crowdCueFrame,
  chargeStateFrame,
  chargeToWire,
  CROWD_CUE_EFFECT,
  CHARGE_MIN_TAP_INTERVAL_MS,
} from '@cyber-shapes/shared';
import { mountCrowdCharge, makeChargeTapMessage } from '../src/funnel/crowdCharge.ts';

/** A fake crowd socket capturing sends + exposing a way to push server frames. */
function makeFakeSocket() {
  const sent: string[] = [];
  const listeners: Array<(ev: { data: unknown }) => void> = [];
  return {
    sent,
    socket: {
      send(data: string) {
        sent.push(data);
      },
      addEventListener(_type: string, cb: (ev: { data: unknown }) => void) {
        listeners.push(cb);
      },
      removeEventListener(_type: string, cb: (ev: { data: unknown }) => void) {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    /** Push a binary frame to every listener (as the WS would). */
    push(frame: ArrayBuffer) {
      for (const cb of listeners.slice()) cb({ data: frame });
    },
  };
}

/** A controllable fake clock + setTimeout for deterministic flash timing. */
function makeFakeTime(start = 0) {
  let now = start;
  interface E { id: number; at: number; cb: () => void; }
  const timers: E[] = [];
  let id = 1;
  return {
    now: () => now,
    setTimeoutImpl: (cb: () => void, ms: number) => {
      const e: E = { id: id++, at: now + Math.max(0, ms), cb };
      timers.push(e);
      return e.id;
    },
    clearTimeoutImpl: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.slice().sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
          t.cb();
        }
      }
    },
  };
}

describe('C19 crowdCharge — the charge tap intent (debounced ≤ 5/s)', () => {
  it('sends a charge-tap on TAP and debounces a rapid double-tap', () => {
    const root = document.createElement('div');
    const fs = makeFakeSocket();
    const time = makeFakeTime();
    mountCrowdCharge(root, fs.socket, {
      callsign: 'VOLT-1',
      now: time.now,
      setTimeoutImpl: time.setTimeoutImpl,
      clearTimeoutImpl: time.clearTimeoutImpl,
    });
    const btn = root.querySelector('[data-role="charge-tap"]') as HTMLButtonElement;
    btn.click();
    expect(fs.sent.length).toBe(1);
    const msg = decodeText(fs.sent[0]) as { t: string };
    expect(msg.t).toBe('charge-tap');
    // A rapid second tap inside the 200 ms window is debounced client-side.
    btn.click();
    expect(fs.sent.length).toBe(1);
    // After the window, a tap is accepted again.
    time.advance(CHARGE_MIN_TAP_INTERVAL_MS);
    btn.click();
    expect(fs.sent.length).toBe(2);
  });

  it('the tap message shape matches makeChargeTapMessage', () => {
    expect(makeChargeTapMessage()).toEqual({ t: 'charge-tap' });
    expect(encodeText(makeChargeTapMessage() as never)).toContain('charge-tap');
  });
});

describe('C19 crowdCharge — CHARGE_STATE drives the meter', () => {
  it('reveals + fills the meter from a CHARGE_STATE frame', () => {
    const root = document.createElement('div');
    const fs = makeFakeSocket();
    const time = makeFakeTime();
    mountCrowdCharge(root, fs.socket, {
      callsign: 'VOLT-2',
      now: time.now,
      setTimeoutImpl: time.setTimeoutImpl,
      clearTimeoutImpl: time.clearTimeoutImpl,
    });
    const meter = root.querySelector('[data-role="charge-meter"]') as HTMLElement;
    expect(meter.hidden).toBe(true); // idle until a CHARGE_STATE arrives
    fs.push(chargeStateFrame({ charge: chargeToWire(0.5), crowdSize: 10, fireAtMs: 0 }));
    expect(meter.hidden).toBe(false);
    expect(meter.dataset.charge).toBe('50');
    fs.push(chargeStateFrame({ charge: chargeToWire(1), crowdSize: 10, fireAtMs: 0 }));
    expect(meter.dataset.charge).toBe('100');
    expect(meter.dataset.full).toBe('1');
  });
});

describe('C19 crowdCharge — the synchronized single flash (≤ 3 Hz)', () => {
  it('fires ONE flash at the frame fireAt and rejects a strobe within 334 ms', () => {
    const root = document.createElement('div');
    const fs = makeFakeSocket();
    const time = makeFakeTime(1_000);
    mountCrowdCharge(root, fs.socket, {
      callsign: 'VOLT-3',
      now: time.now,
      setTimeoutImpl: time.setTimeoutImpl,
      clearTimeoutImpl: time.clearTimeoutImpl,
    });
    const flash = root.querySelector('[data-role="charge-flash"]') as HTMLElement;
    // Learn the epoch base from a CHARGE_STATE carrying a fireAt first (fireAtMs
    // is roomEpoch-relative; the module maps it to a local delay).
    fs.push(chargeStateFrame({ charge: 200, crowdSize: 5, fireAtMs: 500 }));
    // A PALETTE_FLASH cue scheduled at the same roomEpoch-relative fireAt (500).
    fs.push(
      crowdCueFrame({
        effect: CROWD_CUE_EFFECT.PALETTE_FLASH,
        colorIndex: 6,
        intensity: 255,
        durationMs: 400,
        seed: 123,
        fireAtMs: 500,
      })
    );
    expect(flash.hidden).toBe(true); // not yet — scheduled for the fireAt
    // epochBase = now(1000) − 500 = 500 → localFireAt = 500 + 500 = 1000 = now.
    // delay = max(0, 1000 − 1000) = 0 → fires on the next timer drain.
    time.advance(0);
    expect(flash.dataset.on).toBe('1');
    // A SECOND flash within 334 ms is rejected (comfort ≤ 3 Hz single-pulse).
    const before = flash.dataset.on;
    fs.push(
      crowdCueFrame({
        effect: CROWD_CUE_EFFECT.PALETTE_FLASH,
        colorIndex: 6,
        intensity: 255,
        durationMs: 400,
        seed: 123,
        fireAtMs: 500,
      })
    );
    time.advance(0);
    expect(flash.dataset.on).toBe(before); // no re-trigger inside the window
  });
});

describe('C19 crowdCharge — the max-brightness prompt', () => {
  it('emphasises the brightness prompt at CHARGE_START (a BRIGHTNESS_PROMPT cue)', () => {
    const root = document.createElement('div');
    const fs = makeFakeSocket();
    const time = makeFakeTime();
    mountCrowdCharge(root, fs.socket, {
      callsign: 'VOLT-4',
      now: time.now,
      setTimeoutImpl: time.setTimeoutImpl,
      clearTimeoutImpl: time.clearTimeoutImpl,
    });
    const prompt = root.querySelector('[data-role="brightness-prompt"]') as HTMLElement;
    // The prompt exists at join (max-brightness prompt at join AND CHARGE_START).
    expect(prompt).toBeTruthy();
    fs.push(
      crowdCueFrame({
        effect: CROWD_CUE_EFFECT.BRIGHTNESS_PROMPT,
        colorIndex: 6,
        intensity: 255,
        durationMs: 2000,
        seed: 1,
        fireAtMs: 0,
      })
    );
    expect(prompt.dataset.emphasis).toBe('1');
  });
});
