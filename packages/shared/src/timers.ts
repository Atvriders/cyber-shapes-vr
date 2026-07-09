// ---------------------------------------------------------------------------
// TimerApi — the injected-timer contract (Global Constraints; spec §5.5).
//
// Shared/server code NEVER calls raw setTimeout/Date.now: every scheduled effect
// takes an injected TimerApi so tests drive it with fake timers and replay/soak
// paths drive it from an injected clock. C2's idle-kick uses it from day one and
// C3's `scheduleAt` consumes it. A production adapter wraps global timers; tests
// pass a controllable fake.
// ---------------------------------------------------------------------------

/** Opaque handle returned by `setTimeout`, accepted by `clearTimeout`. */
export type TimerHandle = unknown;

export interface TimerApi {
  /** Schedule `cb` to run after `ms` milliseconds; returns a cancel handle. */
  setTimeout(cb: () => void, ms: number): TimerHandle;
  /** Cancel a pending timer by its handle (no-op if already fired/cleared). */
  clearTimeout(h: TimerHandle): void;
  /** Current time in milliseconds (monotonic-ish; the injected clock's `now`). */
  now(): number;
}

/**
 * A production TimerApi backed by the host's global timer + clock. Shared/server
 * modules receive this by injection at their composition root — they must never
 * reach for the globals themselves (the review reject rule).
 */
export const systemTimerApi: TimerApi = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
