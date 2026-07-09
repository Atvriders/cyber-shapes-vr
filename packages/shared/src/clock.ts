// ---------------------------------------------------------------------------
// Task C3 — Clock sync + fire-at scheduler (pure; injected TimerApi only).
//
// Spec §5.3 / plan C3 brief. Provides:
//   • PingSample — one CLOCK_PING/PONG round-trip measurement.
//   • estimateOffset(samples) — min-RTT-filtered EMA offset estimator.
//   • serverNow(offsetMs, localNow) — convert local clock to estimated server time.
//   • scheduleAt(…) — fire-at-server-time scheduler; two late policies.
//   • createClockSyncer(…) — client-side periodic re-sample helper (§5.3: fires
//       on visibilitychange + every ~10 s for resident/spectator clients).
//
// PURITY RULES:
//   – No raw setTimeout / Date.now; everything via the injected TimerApi.
//   – No import of browser globals (visibilitychange wiring is caller-side).
//   – No new runtime dependencies.
// ---------------------------------------------------------------------------

import type { TimerApi, TimerHandle } from './timers.js';
import { systemTimerApi } from './timers.js';

// ---------------------------------------------------------------------------
// PingSample — one CLOCK_PING/CLOCK_PONG round-trip measurement
// ---------------------------------------------------------------------------

/**
 * The four timestamps that describe one NTP-lite ping/pong exchange.
 *
 *   clientSendMs   — local clock when CLOCK_PING was sent (echoed back in PONG).
 *   serverTimeMs   — roomEpoch-relative server time from the PONG payload.
 *   clientRecvMs   — local clock when CLOCK_PONG was received.
 *   rttMs          — clientRecvMs − clientSendMs (derived, kept for convenience).
 *
 * NTP-lite offset formula (per-sample):
 *   offset_est = ((serverTimeMs − clientSendMs) + (serverTimeMs − clientRecvMs)) / 2
 *             = serverTimeMs − (clientSendMs + clientRecvMs) / 2
 */
export interface PingSample {
  clientSendMs: number;
  serverTimeMs: number;
  clientRecvMs: number;
  rttMs: number;
}

// ---------------------------------------------------------------------------
// estimateOffset — min-RTT-filtered EMA
// ---------------------------------------------------------------------------

/**
 * Estimate the server-clock offset (ms) from a list of PingSamples.
 *
 * Algorithm (spec §5.3 "min-RTT-filtered … EMA over samples, discard high-RTT"):
 *  1. If no samples, return 0.
 *  2. Find the minimum RTT across all samples.
 *  3. Keep only samples whose RTT ≤ minRtt × LOW_RTT_FACTOR (low-RTT cohort).
 *     Using a 1.5× factor: a sample is "low-RTT" if its RTT is at most 50%
 *     above the best observation — in practice this filters out the heavily
 *     queued / asymmetric samples while keeping a reasonable cohort size.
 *  4. Compute the per-sample NTP offset for each kept sample.
 *  5. Return the arithmetic mean of those offsets (the "EMA" step — in
 *     production the caller accumulates across calls; within one call this
 *     is an unweighted mean of the filtered cohort, which is correct for
 *     a small synchronous batch).
 *
 * Accuracy target: ±20 ms on booth Wi-Fi (spec §5.3).
 */
export const LOW_RTT_FACTOR = 1.5;

export function estimateOffset(samples: readonly PingSample[]): number {
  if (samples.length === 0) return 0;

  // Step 1: find minimum RTT
  let minRtt = Infinity;
  for (const s of samples) {
    if (s.rttMs < minRtt) minRtt = s.rttMs;
  }

  // Step 2: filter to low-RTT cohort
  const threshold = minRtt * LOW_RTT_FACTOR;
  const kept: number[] = [];
  for (const s of samples) {
    if (s.rttMs <= threshold) {
      // NTP-lite per-sample offset
      const offsetEst =
        (s.serverTimeMs - s.clientSendMs + (s.serverTimeMs - s.clientRecvMs)) / 2;
      kept.push(offsetEst);
    }
  }

  if (kept.length === 0) return 0;

  // Step 3: arithmetic mean of filtered offsets
  return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}

// ---------------------------------------------------------------------------
// serverNow — convert local clock to estimated server time
// ---------------------------------------------------------------------------

/**
 * Estimate the current server time given the local clock reading and the
 * cached offset (server − local, in ms).
 */
export function serverNow(offsetMs: number, localNow: number): number {
  return localNow + offsetMs;
}

// ---------------------------------------------------------------------------
// scheduleAt — fire-at-server-time scheduler
// ---------------------------------------------------------------------------

/** Opaque handle returned by scheduleAt. */
export interface Handle {
  /** Cancel a pending scheduled callback. No-op if already fired or cancelled. */
  cancel(): void;
}

/**
 * Schedule `cb` to fire when estimated server time reaches `fireAtServerTime`.
 *
 * @param fireAtServerTime — absolute server-time target (ms; roomEpoch-relative
 *   callers must add roomEpoch to the wire u32 before calling here).
 * @param offsetMs — current estimated server offset (server − local, ms).
 *   Typically from `estimateOffset(samples)` kept live by createClockSyncer.
 * @param latePolicy — what to do when the deadline is already past:
 *   'fireNow' — call `cb` immediately (Encore detonation / sparkle mode).
 *   'skip'    — do nothing (slow ambient cues / theme transitions).
 * @param cb — the callback to fire.
 * @param timer — injected TimerApi (defaults to systemTimerApi for production).
 * @returns a Handle whose `cancel()` aborts the pending timer.
 */
export function scheduleAt(
  fireAtServerTime: number,
  offsetMs: number,
  latePolicy: 'fireNow' | 'skip',
  cb: () => void,
  timer: TimerApi = systemTimerApi
): Handle {
  const localNow = timer.now();
  // Convert server fire time to local fire time:
  //   localFireTime = fireAtServerTime − offsetMs
  //   (because serverTime = localTime + offsetMs)
  const localFireTime = fireAtServerTime - offsetMs;
  const delayMs = localFireTime - localNow;

  if (delayMs <= 0) {
    // Past deadline
    if (latePolicy === 'fireNow') {
      cb();
    }
    // 'skip' — do nothing
    return { cancel() {} };
  }

  // Future fire
  let handle: TimerHandle | null = timer.setTimeout(cb, delayMs);
  return {
    cancel() {
      if (handle !== null) {
        timer.clearTimeout(handle);
        handle = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ClockSyncer — client-side periodic re-sample helper
// ---------------------------------------------------------------------------

/**
 * Fields from a CLOCK_PONG decoded by the Appendix B codec.
 * Mirrors `decodeBinary(CLOCK_PONG).fields`.
 */
export interface PongFields {
  clientSendMs: number;
  serverTimeMs: number;
  reserved: number;
}

export interface ClockSyncerOpts {
  /**
   * Called when the syncer wants to send a CLOCK_PING. The caller should:
   *  1. Note the local time.
   *  2. Encode and transmit a CLOCK_PING binary frame (via the golden codec).
   *  3. When the CLOCK_PONG arrives, call `syncer.onPong(fields)`.
   *
   * The `clientSendMs` argument is the local clock value at send time (from
   * the injected timer). The caller must echo this value into the CLOCK_PING
   * `clientSendMs` field (Appendix B).
   */
  sendPing(clientSendMs: number): void;

  /**
   * Injected timer (spec Global Constraints — no raw setTimeout in shared).
   * Defaults to systemTimerApi in production; tests pass a fake.
   */
  timerApi?: TimerApi;

  /**
   * How often to re-sample (ms). Spec §5.3: ~10 s for resident/spectator.
   * Defaults to 10 000 ms.
   */
  resampleIntervalMs?: number;

  /**
   * Maximum number of samples to retain in the rolling window for
   * `estimateOffset`. Defaults to 8 (enough for reliable min-RTT filtering
   * without memory bloat).
   */
  maxSamples?: number;
}

export interface ClockSyncer {
  /** Start the periodic re-sample loop. Fires the first ping immediately. */
  start(): void;
  /**
   * Stop the re-sample loop (call on `visibilitychange: hidden` or WS close).
   * A stopped syncer can be restarted with `start()`.
   */
  stop(): void;
  /**
   * Deliver a decoded CLOCK_PONG. Must be called by the WS message handler
   * when a binary CLOCK_PONG frame arrives.
   */
  onPong(fields: PongFields): void;
  /**
   * Current best estimate of (server − local) offset in ms.
   * Updated after each `onPong`. Returns 0 until at least one sample.
   */
  readonly offsetMs: number;
  /**
   * Last measured round-trip time in ms. −1 until first sample.
   */
  readonly rttMs: number;
}

/**
 * Create a client-side clock syncer that:
 *  - fires `sendPing` immediately on `start()`.
 *  - schedules periodic re-pings every `resampleIntervalMs` (default 10 s).
 *  - accumulates samples in a rolling window and keeps `offsetMs` / `rttMs` live.
 *
 * Caller responsibilities (spec §5.3):
 *  - Call `stop()` on `visibilitychange: hidden`; call `start()` on
 *    `visibilitychange: visible` (re-sync after backgrounding).
 *  - Wire `onPong(fields)` into the binary WS message handler.
 *  - Use `offsetMs` in `scheduleAt(fireAtServerTime, syncer.offsetMs, …)`.
 */
export function createClockSyncer(opts: ClockSyncerOpts): ClockSyncer {
  const timer = opts.timerApi ?? systemTimerApi;
  const resampleIntervalMs = opts.resampleIntervalMs ?? 10_000;
  const maxSamples = opts.maxSamples ?? 8;

  const samples: PingSample[] = [];
  let _offsetMs = 0;
  let _rttMs = -1;
  let _periodicHandle: TimerHandle | null = null;

  function ping(): void {
    const now = timer.now();
    opts.sendPing(now);
  }

  function scheduleNext(): void {
    _periodicHandle = timer.setTimeout(() => {
      ping();
      scheduleNext();
    }, resampleIntervalMs);
  }

  return {
    start() {
      ping(); // immediate first ping
      scheduleNext();
    },

    stop() {
      if (_periodicHandle !== null) {
        timer.clearTimeout(_periodicHandle);
        _periodicHandle = null;
      }
    },

    onPong(fields: PongFields) {
      const recvMs = timer.now();
      const sendMs = fields.clientSendMs;
      const rtt = recvMs - sendMs;

      const sample: PingSample = {
        clientSendMs: sendMs,
        serverTimeMs: fields.serverTimeMs,
        clientRecvMs: recvMs,
        rttMs: rtt,
      };

      samples.push(sample);
      if (samples.length > maxSamples) {
        samples.shift();
      }

      _rttMs = rtt;
      _offsetMs = estimateOffset(samples);
    },

    get offsetMs(): number {
      return _offsetMs;
    },

    get rttMs(): number {
      return _rttMs;
    },
  };
}
