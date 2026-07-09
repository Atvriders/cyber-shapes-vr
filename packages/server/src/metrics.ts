/**
 * metrics.ts — In-process event counters + gauges for the booth day (spec §7.17).
 *
 * Design constraints:
 *   - Injected clock (fake in tests, real Date.now in production).
 *   - Counters-ONLY export (exportDay). NO callsigns, NO peer ids, NO PII.
 *   - Synthetic DMN- peers (spec §7.17) are EXCLUDED from the real-peer counts
 *     and tracked in a separate `synthetic` sub-counter so ops can audit them.
 *   - The event union anticipates future tasks (comments only — no dead code):
 *       'peakWatchers'   → gains a gauge with C25 (showpiece watcher peak)
 *   - Phase D note: when the 'league' bucket name is added, add 'league' to
 *     the count() event union at that point — keep the union in ONE place (here).
 *
 * Usage:
 *   const m = makeMetrics();
 *   m.count('join', 'resident');
 *   m.count('join', 'wisp');
 *   m.count('scan');          // no tier
 *   m.gauge('peakConcurrent', liveCount);
 *   const snapshot = m.exportDay();
 *   m.resetDay();             // called by day-close after export
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Countable event kinds.
 *
 * Current: scan | join | glyph | vote | rotation | showpiece | clip
 * C31 (F20 Neon Clip Machine, spec §7.20 / §11): 'clip' is counted on a
 * successful `GET /api/clips/:id` DELIVERY (a clip actually leaving the booth),
 * never on the POST/save — §11 "clips delivered".
 * C25 adds: peakWatchers gauge (add 'peakWatchers' to GaugeKey at C25)
 */
export type CountEvent =
  | 'scan'
  | 'join'
  | 'glyph'
  | 'vote'
  | 'rotation'
  | 'showpiece'
  | 'clip';

/** Tier label as used in connection.ts (resident/wisp/crowd/spectator/director). */
export type MetricsTier = string;

/** A DMN- prefixed peer id indicates a synthetic test peer (spec §7.17). */
export const SYNTHETIC_PEER_PREFIX = 'DMN-';

/**
 * Gauge keys.
 *
 * Current: peakConcurrent | peakWatchers
 * peakWatchers (C25, F14 The Gallery): the high-water remote-audience count,
 * sampled from the audience roster each 0.2 Hz AUDIENCE_STATE tick (feeds §11).
 */
export type GaugeKey = 'peakConcurrent' | 'peakWatchers';

/**
 * Structure of a day counter export (counters only, NO PII).
 * Keys: event names. Values: total real-peer count.
 * `byTier` drills down per-tier. `synthetic` counts DMN- peers (excluded from top-level).
 */
export interface DayCounters {
  scan: number;
  join: number;
  glyph: number;
  vote: number;
  rotation: number;
  showpiece: number;
  /** C31 (F20 Neon Clip Machine): clips successfully delivered (GET, not POST). */
  clip: number;
  byTier: Record<string, Record<string, number>>; // event → tier → count
  synthetic: Record<string, number>;              // event → synthetic count
  gauges: {
    peakConcurrent: number;
    /** C25 (F14 The Gallery): high-water remote-audience (watcher) count. */
    peakWatchers: number;
  };
  /** ISO date string YYYY-MM-DD of the day this snapshot covers. */
  date: string;
}

// ---------------------------------------------------------------------------
// MetricsStore
// ---------------------------------------------------------------------------

export interface MetricsOpts {
  /** Injectable clock. Defaults to () => Date.now(). */
  now?: () => number;
}

export interface MetricsStore {
  /**
   * Increment a real-event counter.
   * If `tier` starts with SYNTHETIC_PEER_PREFIX ('DMN-') the count goes to the
   * synthetic sub-counter only, NOT the real-peer total (spec §7.17).
   *
   * @param event  The event kind to count.
   * @param tier   Optional tier label (or a full peer id — DMN- prefix check).
   */
  count(event: CountEvent, tier?: string): void;

  /**
   * Set a high-water-mark gauge. Stores max(current, n).
   * Called from the room sim tick for peakConcurrent.
   *
   * @param key  The gauge key.
   * @param n    The current value (non-finite values are silently ignored).
   */
  gauge(key: GaugeKey, n: number): void;

  /**
   * Export all counters and gauges as a plain JSON-safe object.
   * Contains ONLY counts and gauges — no callsigns, no peer ids, no PII.
   */
  exportDay(): DayCounters;

  /**
   * Reset all counters and gauges to zero (call after exportDay at day close).
   * The `date` field advances to the next calendar day automatically via the
   * injected clock.
   */
  resetDay(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** All countable events for iteration. */
const ALL_EVENTS: CountEvent[] = ['scan', 'join', 'glyph', 'vote', 'rotation', 'showpiece', 'clip'];

/**
 * Make an in-memory metrics store. One instance per server process; the room
 * manager calls count('join') on join and count('rotation') on rotation.
 */
export function makeMetrics(opts: MetricsOpts = {}): MetricsStore {
  const nowFn = opts.now ?? (() => Date.now());

  // Real-peer counters: event → tier|'_total' → count
  const counters = new Map<string, Map<string, number>>();
  // Synthetic peer counters: event → count
  const synthetic = new Map<string, number>();
  // Gauges: key → value
  const gauges = new Map<GaugeKey, number>();

  // Initialise to zero.
  for (const ev of ALL_EVENTS) {
    counters.set(ev, new Map([['_total', 0]]));
    synthetic.set(ev, 0);
  }

  function isSynthetic(tier: string | undefined): boolean {
    return typeof tier === 'string' && tier.startsWith(SYNTHETIC_PEER_PREFIX);
  }

  function count(event: CountEvent, tier?: string): void {
    if (isSynthetic(tier)) {
      // Synthetic peer: count in the synthetic bucket only.
      synthetic.set(event, (synthetic.get(event) ?? 0) + 1);
      return;
    }
    const eventMap = counters.get(event);
    if (!eventMap) return; // guard (should not happen — all events initialised above)
    // Increment the total.
    eventMap.set('_total', (eventMap.get('_total') ?? 0) + 1);
    // Increment the tier bucket if a tier was provided.
    if (typeof tier === 'string' && tier.length > 0) {
      eventMap.set(tier, (eventMap.get(tier) ?? 0) + 1);
    }
  }

  function gauge(key: GaugeKey, n: number): void {
    if (!Number.isFinite(n)) return;
    const prev = gauges.get(key) ?? 0;
    if (n > prev) gauges.set(key, n);
  }

  function isoDate(): string {
    return new Date(nowFn()).toISOString().slice(0, 10);
  }

  function exportDay(): DayCounters {
    const byTier: Record<string, Record<string, number>> = {};
    const syntheticOut: Record<string, number> = {};

    for (const ev of ALL_EVENTS) {
      const eventMap = counters.get(ev);
      const tierObj: Record<string, number> = {};
      if (eventMap) {
        for (const [k, v] of eventMap) {
          if (k !== '_total') tierObj[k] = v;
        }
      }
      byTier[ev] = tierObj;
      syntheticOut[ev] = synthetic.get(ev) ?? 0;
    }

    return {
      scan: counters.get('scan')?.get('_total') ?? 0,
      join: counters.get('join')?.get('_total') ?? 0,
      glyph: counters.get('glyph')?.get('_total') ?? 0,
      vote: counters.get('vote')?.get('_total') ?? 0,
      rotation: counters.get('rotation')?.get('_total') ?? 0,
      showpiece: counters.get('showpiece')?.get('_total') ?? 0,
      clip: counters.get('clip')?.get('_total') ?? 0,
      byTier,
      synthetic: syntheticOut,
      gauges: {
        peakConcurrent: gauges.get('peakConcurrent') ?? 0,
        peakWatchers: gauges.get('peakWatchers') ?? 0,
      },
      date: isoDate(),
    };
  }

  function resetDay(): void {
    for (const ev of ALL_EVENTS) {
      counters.set(ev, new Map([['_total', 0]]));
      synthetic.set(ev, 0);
    }
    gauges.clear();
  }

  return { count, gauge, exportDay, resetDay };
}
