/**
 * Task C3 — Clock sync + fire-at scheduler tests.
 *
 * TDD order: tests written first (RED), implementation follows (GREEN).
 * All tests use fake timers via the injected TimerApi — no raw setTimeout.
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '../src/timers.js';
import {
  estimateOffset,
  serverNow,
  scheduleAt,
  createClockSyncer,
  type PingSample,
} from '../src/clock.js';

// ---------------------------------------------------------------------------
// Fake TimerApi — deterministic, no real time
// ---------------------------------------------------------------------------

interface FakeTimerEntry {
  id: number;
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}

function makeFakeTimers(initialNow = 0): { api: TimerApi; advance(ms: number): void; now(): number } {
  let _now = initialNow;
  let _nextId = 1;
  const _timers: FakeTimerEntry[] = [];

  function fireReady(): void {
    // Fire in chronological order; re-check after each fire (cb may add timers).
    let fired = true;
    while (fired) {
      fired = false;
      for (const t of _timers.slice().sort((a, b) => a.fireAt - b.fireAt)) {
        if (!t.cancelled && t.fireAt <= _now) {
          t.cancelled = true;
          t.cb();
          fired = true;
          break;
        }
      }
    }
  }

  return {
    api: {
      setTimeout(cb: () => void, ms: number): TimerHandle {
        const id = _nextId++;
        _timers.push({ id, fireAt: _now + ms, cb, cancelled: false });
        return id as unknown as TimerHandle;
      },
      clearTimeout(h: TimerHandle): void {
        const id = h as unknown as number;
        const t = _timers.find((x) => x.id === id);
        if (t) t.cancelled = true;
      },
      now(): number {
        return _now;
      },
    },
    advance(ms: number): void {
      _now += ms;
      fireReady();
    },
    now(): number {
      return _now;
    },
  };
}

// ---------------------------------------------------------------------------
// PingSample helpers
// ---------------------------------------------------------------------------

/**
 * Construct a PingSample from first principles.
 *
 * NTP-lite model: client sends at `clientSendMs`, server receives it
 * `propUp` ms later, server clock shows `serverTimeMs = clientSendMs + offset + propUp`,
 * server replies immediately, client receives the pong after another `propDown` ms.
 *
 *   rttMs          = propUp + propDown
 *   clientRecvMs   = clientSendMs + rttMs
 *
 * Caller supplies `serverTimeMs` directly; `rttMs` is derived from propUp + propDown.
 * For a symmetric sample: propUp = propDown = rttMs/2.
 */
function makeSample(clientSendMs: number, serverTimeMs: number, rttMs: number): PingSample {
  return {
    clientSendMs,
    serverTimeMs,
    clientRecvMs: clientSendMs + rttMs,
    rttMs,
  };
}

// ---------------------------------------------------------------------------
// §1  estimateOffset — symmetric samples → offset within ±1 ms
// ---------------------------------------------------------------------------

describe('estimateOffset — symmetric samples', () => {
  it('single symmetric sample: offset within ±1 ms', () => {
    // Client clock 0, server clock 1000 ms ahead, RTT = 20 ms symmetric.
    // serverTime = clientSend + offset + propUp = 0 + 1000 + 10 = 1010
    const sample = makeSample(0, 1010, 20);
    const off = estimateOffset([sample]);
    expect(Math.abs(off - 1000)).toBeLessThanOrEqual(1);
  });

  it('multiple symmetric samples: EMA within ±1 ms of true offset', () => {
    const TRUE_OFFSET = 500;
    const samples = [20, 22, 18, 24, 20].map((rtt, i) =>
      makeSample(i * 100, i * 100 + TRUE_OFFSET + rtt / 2, rtt)
    );
    const off = estimateOffset(samples);
    expect(Math.abs(off - TRUE_OFFSET)).toBeLessThanOrEqual(1);
  });

  it('returns 0 for an empty sample array', () => {
    expect(estimateOffset([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2  estimateOffset — asymmetric-jitter case (min-RTT filter)
//
// Build a set where naive mean offset errs > 20 ms but min-RTT-filtered
// estimate errs < 5 ms.
// ---------------------------------------------------------------------------

describe('estimateOffset — asymmetric-jitter case (min-RTT filter)', () => {
  it('naive mean errs > 20 ms; filtered estimate errs < 5 ms', () => {
    /**
     * True offset = 100 ms (server is 100 ms ahead of client).
     *
     * "Good" samples: rtt = 20 ms, symmetric (propUp = propDown = 10 ms).
     *   serverTime = clientSend + 100 + 10 = clientSend + 110
     *   NTP est    = (serverTime − clientSend + serverTime − clientRecv) / 2
     *              = (110 + (110 − 20)) / 2 = (110 + 90) / 2 = 100  ← exact.
     *
     * "Jittered" samples: rtt = 200 ms, propUp = 180 ms, propDown = 20 ms.
     *   serverTime = clientSend + 100 + 180 = clientSend + 280
     *   clientRecv = clientSend + 200
     *   NTP est    = (280 + (280 − 200)) / 2 = (280 + 80) / 2 = 180  ← errs +80.
     *
     * With 2 good + 8 jittered:
     *   naive mean ≈ (2×100 + 8×180) / 10 = 164  → err = 64 > 20 ✓
     *   min-RTT filter keeps only 2 good samples → est ≈ 100 → err < 5 ✓
     */
    const TRUE_OFFSET = 100;

    const goodSamples: PingSample[] = [0, 50].map((send) =>
      makeSample(send, send + TRUE_OFFSET + 10, 20)
    );

    const jitteredSamples: PingSample[] = [100, 200, 300, 400, 500, 600, 700, 800].map((send) =>
      makeSample(send, send + TRUE_OFFSET + 180, 200)
    );

    const allSamples = [...goodSamples, ...jitteredSamples];

    // Verify naive mean errs > 20 ms
    const naiveMean =
      allSamples.reduce((sum, s) => {
        const estOff =
          (s.serverTimeMs - s.clientSendMs + s.serverTimeMs - s.clientRecvMs) / 2;
        return sum + estOff;
      }, 0) / allSamples.length;
    expect(Math.abs(naiveMean - TRUE_OFFSET)).toBeGreaterThan(20);

    // Verify filtered estimate errs < 5 ms
    const filtered = estimateOffset(allSamples);
    expect(Math.abs(filtered - TRUE_OFFSET)).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// §3  serverNow
// ---------------------------------------------------------------------------

describe('serverNow', () => {
  it('returns localNow + offsetMs', () => {
    expect(serverNow(1000, 5000)).toBe(6000);
  });

  it('works with negative offset', () => {
    expect(serverNow(-200, 5000)).toBe(4800);
  });
});

// ---------------------------------------------------------------------------
// §4  scheduleAt — late-policy 'fireNow': fires immediately when past deadline
// ---------------------------------------------------------------------------

describe("scheduleAt — past-deadline 'fireNow' policy", () => {
  it('fires the callback immediately when fireAtServerTime is in the past', () => {
    const fake = makeFakeTimers(10_000); // local clock at 10 000
    const offsetMs = 1000; // server 1000 ms ahead → serverNow = 11 000
    const fireAtServerTime = 10_000; // past: server was 10 000 < serverNow(11 000)

    const fired: number[] = [];
    scheduleAt(fireAtServerTime, offsetMs, 'fireNow', () => fired.push(fake.now()), fake.api);

    // Must have fired synchronously (no advance needed)
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// §5  scheduleAt — late-policy 'skip': does NOT fire when past deadline
// ---------------------------------------------------------------------------

describe("scheduleAt — past-deadline 'skip' policy", () => {
  it('does NOT fire the callback when fireAtServerTime is in the past', () => {
    const fake = makeFakeTimers(10_000);
    const offsetMs = 1000;
    const fireAtServerTime = 9_000; // past

    const fired: number[] = [];
    scheduleAt(fireAtServerTime, offsetMs, 'skip', () => fired.push(fake.now()), fake.api);

    fake.advance(5_000);
    expect(fired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6  scheduleAt — fires at the correct future local time
// ---------------------------------------------------------------------------

describe('scheduleAt — future scheduling', () => {
  it('fires at the correct local time derived from fireAtServerTime and offsetMs', () => {
    const fake = makeFakeTimers(0);
    const offsetMs = 500; // server is 500 ms ahead
    const fireAtServerTime = 1_500; // fire at server time 1500
    // localFireTime = 1500 − 500 = 1000

    const fired: number[] = [];
    scheduleAt(fireAtServerTime, offsetMs, 'skip', () => fired.push(fake.now()), fake.api);

    fake.advance(999);
    expect(fired).toHaveLength(0); // not yet

    fake.advance(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// §7  scheduleAt — roomEpoch-relative fireAt case
// ---------------------------------------------------------------------------

describe('scheduleAt — roomEpoch-relative fireAt', () => {
  /**
   * Appendix B: timestamps are u32 ms since roomEpoch. Callers pass
   * roomEpoch-absolute server times; scheduleAt converts to local fire time via:
   *   localFireTime = fireAtServerTime − offsetMs
   */
  it('fires correctly with a realistic epoch-absolute fireAt', () => {
    const roomEpoch = 1_700_000_000_000;
    const localClockBase = roomEpoch - 200; // client 200 ms behind server epoch

    const fake = makeFakeTimers(localClockBase);
    const offsetMs = 200; // server 200 ms ahead
    // Fire 500 ms after epoch (server time = epoch + 500)
    const fireAtServerTime = roomEpoch + 500;
    // localFireTime = fireAtServerTime − offsetMs = (epoch + 500) − 200 = epoch + 300
    // delay from localClockBase = (epoch + 300) − (epoch − 200) = 500 ms

    const fired: number[] = [];
    scheduleAt(fireAtServerTime, offsetMs, 'skip', () => fired.push(fake.now()), fake.api);

    fake.advance(499);
    expect(fired).toHaveLength(0);

    fake.advance(1);
    expect(fired).toHaveLength(1);
    // Fired at localClockBase + 500 = epoch + 300
    expect(fired[0]).toBe(localClockBase + 500);
  });
});

// ---------------------------------------------------------------------------
// §8  scheduleAt — cancel
// ---------------------------------------------------------------------------

describe('scheduleAt — cancel', () => {
  it('cancel prevents the callback from firing', () => {
    const fake = makeFakeTimers(0);
    const offsetMs = 0;
    const fireAtServerTime = 1_000;

    const fired: number[] = [];
    const handle = scheduleAt(
      fireAtServerTime,
      offsetMs,
      'skip',
      () => fired.push(fake.now()),
      fake.api
    );

    fake.advance(500);
    handle.cancel();
    fake.advance(1_000);

    expect(fired).toHaveLength(0);
  });

  it('cancel on an already-fired handle is a no-op (no throw, no double-fire)', () => {
    const fake = makeFakeTimers(0);
    const fired: number[] = [];
    const handle = scheduleAt(100, 0, 'skip', () => fired.push(fake.now()), fake.api);

    fake.advance(200); // fires at t=100
    expect(fired).toHaveLength(1);

    expect(() => handle.cancel()).not.toThrow();
    fake.advance(100);
    expect(fired).toHaveLength(1); // no double-fire
  });
});

// ---------------------------------------------------------------------------
// §9  createClockSyncer — periodic re-sample fires on schedule
// ---------------------------------------------------------------------------

describe('createClockSyncer — periodic re-sample', () => {
  it('fires sendPing on start and then every resampleIntervalMs', () => {
    const fake = makeFakeTimers(0);
    const pings: number[] = [];

    const syncer = createClockSyncer({
      sendPing: (clientSendMs: number) => {
        pings.push(fake.now());
        // Immediately deliver a symmetric pong (RTT = 0 for simplicity)
        syncer.onPong({ clientSendMs, serverTimeMs: clientSendMs + 50, reserved: 0 });
      },
      timerApi: fake.api,
      resampleIntervalMs: 10_000,
    });

    syncer.start();
    const afterStart = pings.length;
    expect(afterStart).toBeGreaterThanOrEqual(1); // initial ping

    fake.advance(10_000);
    expect(pings.length).toBeGreaterThan(afterStart); // re-sample fired

    fake.advance(10_000);
    expect(pings.length).toBeGreaterThan(afterStart + 1); // another re-sample

    syncer.stop();
  });

  it('stop() prevents further re-samples', () => {
    const fake = makeFakeTimers(0);
    const pings: number[] = [];

    const syncer = createClockSyncer({
      sendPing: (clientSendMs: number) => {
        pings.push(fake.now());
        syncer.onPong({ clientSendMs, serverTimeMs: clientSendMs + 50, reserved: 0 });
      },
      timerApi: fake.api,
      resampleIntervalMs: 10_000,
    });

    syncer.start();
    const countAfterStart = pings.length;

    syncer.stop();
    fake.advance(100_000);

    expect(pings.length).toBe(countAfterStart); // no more pings after stop
  });
});

// ---------------------------------------------------------------------------
// §10  createClockSyncer — offset and rttMs updated after pong
// ---------------------------------------------------------------------------

describe('createClockSyncer — offset and rttMs after pong', () => {
  it('offsetMs reflects estimated server offset after pong delivery', () => {
    const fake = makeFakeTimers(0);

    const syncer = createClockSyncer({
      sendPing: (clientSendMs: number) => {
        // Server 100 ms ahead. RTT = 20 ms symmetric (propUp = propDown = 10 ms).
        // We advance the fake clock 20 ms to simulate network round-trip BEFORE
        // delivering the pong, so clientRecvMs = clientSendMs + 20.
        // serverTimeMs = clientSend + 100 + 10 = clientSend + 110.
        // NTP-lite: (110 - 0 + 110 - 20) / 2 = (110 + 90) / 2 = 100. ✓
        fake.advance(20);
        syncer.onPong({
          clientSendMs,
          serverTimeMs: clientSendMs + 110,
          reserved: 0,
        });
      },
      timerApi: fake.api,
      resampleIntervalMs: 10_000,
    });

    syncer.start();

    expect(Math.abs(syncer.offsetMs - 100)).toBeLessThan(5);
  });

  it('rttMs reflects the last measured round-trip time', () => {
    const fake = makeFakeTimers(0);

    const syncer = createClockSyncer({
      sendPing: (clientSendMs: number) => {
        // Simulate 30 ms RTT: server is 100 ms ahead, propUp = 15 ms
        // serverTime = clientSend + 115; clientRecv = clientSend + 30
        syncer.onPong({
          clientSendMs,
          serverTimeMs: clientSendMs + 115,
          reserved: 0,
        });
        // The syncer measures RTT as now() − clientSendMs.
        // We simulate 30 ms elapsed by advancing the fake clock before the pong resolves.
        // Since the pong is delivered synchronously here (no real delay), we test
        // that the syncer stores the correct RTT from the pong delivery context.
      },
      timerApi: fake.api,
      resampleIntervalMs: 10_000,
    });

    // Advance 30 ms BEFORE pong to simulate network RTT
    const fakeWithDelay = makeFakeTimers(0);
    let pendingSend = 0;
    const syncerDelayed = createClockSyncer({
      sendPing: (clientSendMs: number) => {
        pendingSend = clientSendMs;
        // Schedule pong delivery 30 ms later
        fakeWithDelay.api.setTimeout(() => {
          syncerDelayed.onPong({
            clientSendMs: pendingSend,
            serverTimeMs: pendingSend + 115,
            reserved: 0,
          });
        }, 30);
      },
      timerApi: fakeWithDelay.api,
      resampleIntervalMs: 10_000,
    });

    syncerDelayed.start();
    fakeWithDelay.advance(30); // deliver the pong

    expect(syncerDelayed.rttMs).toBeCloseTo(30, 0);
  });
});
