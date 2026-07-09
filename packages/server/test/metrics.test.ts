/**
 * metrics.test.ts — TDD tests for the metrics module (spec §7.17).
 *
 * Covers:
 *   - counters per tier (real peers)
 *   - synthetic DMN- peers excluded from real totals
 *   - peak gauge (high-water-mark)
 *   - export schema: counters-only, no PII
 *   - day reset zeroes all counters + gauges
 *   - date field from injected clock
 */

import { describe, it, expect } from 'vitest';
import { makeMetrics } from '../src/metrics.js';

// ---------------------------------------------------------------------------
// Basic counter tests
// ---------------------------------------------------------------------------

describe('metrics.count — basic counting', () => {
  it('increments the total for a known event', () => {
    const m = makeMetrics();
    m.count('join');
    m.count('join');
    const d = m.exportDay();
    expect(d.join).toBe(2);
  });

  it('all events start at zero on a fresh store', () => {
    const m = makeMetrics();
    const d = m.exportDay();
    expect(d.scan).toBe(0);
    expect(d.join).toBe(0);
    expect(d.glyph).toBe(0);
    expect(d.vote).toBe(0);
    expect(d.rotation).toBe(0);
    expect(d.showpiece).toBe(0);
  });

  it('counts multiple events independently', () => {
    const m = makeMetrics();
    m.count('join');
    m.count('scan');
    m.count('scan');
    m.count('glyph');
    const d = m.exportDay();
    expect(d.join).toBe(1);
    expect(d.scan).toBe(2);
    expect(d.glyph).toBe(1);
    expect(d.vote).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-tier breakdown
// ---------------------------------------------------------------------------

describe('metrics.count — per-tier breakdown', () => {
  it('tracks counts by tier in byTier', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    m.count('join', 'resident');
    m.count('join', 'wisp');
    m.count('join', 'crowd');
    const d = m.exportDay();
    expect(d.join).toBe(4);
    expect(d.byTier['join']!['resident']).toBe(2);
    expect(d.byTier['join']!['wisp']).toBe(1);
    expect(d.byTier['join']!['crowd']).toBe(1);
  });

  it('total equals sum of tier counts', () => {
    const m = makeMetrics();
    m.count('vote', 'wisp');
    m.count('vote', 'wisp');
    m.count('vote', 'crowd');
    const d = m.exportDay();
    expect(d.vote).toBe(3);
    const tierTotal = Object.values(d.byTier['vote']!).reduce((a, b) => a + b, 0);
    expect(tierTotal).toBe(3);
  });

  it('count without tier increments total but leaves byTier empty for that call', () => {
    const m = makeMetrics();
    m.count('rotation');
    const d = m.exportDay();
    expect(d.rotation).toBe(1);
    expect(Object.keys(d.byTier['rotation']!)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic peer exclusion (spec §7.17)
// ---------------------------------------------------------------------------

describe('metrics.count — synthetic DMN- peers excluded', () => {
  it('DMN- prefixed tier goes to synthetic, NOT real total', () => {
    const m = makeMetrics();
    m.count('join', 'DMN-tester-01');
    const d = m.exportDay();
    expect(d.join).toBe(0); // real total unchanged
    expect(d.synthetic['join']).toBe(1);
  });

  // Regression test for the connection.ts DMN- wiring fix (Task C8):
  // connection.ts now passes the CALLSIGN (not grantedTier) when the callsign
  // starts with 'DMN-', so the synthetic check fires on the actual peer identity
  // rather than a tier string ('resident'/'wisp'/etc.) that never has DMN- prefix.
  it('C8 wiring: callsign "DMN-bot01" with grantedTier "resident" → join=0, synthetic.join=1', () => {
    const m = makeMetrics();
    const callsign = 'DMN-bot01';
    const grantedTier = 'resident';
    // This mirrors the fixed code: metricsStore?.count('join', callsign.startsWith('DMN-') ? callsign : grantedTier)
    m.count('join', callsign.startsWith('DMN-') ? callsign : grantedTier);
    const d = m.exportDay();
    expect(d.join).toBe(0);           // NOT in real total
    expect(d.synthetic['join']).toBe(1); // counted as synthetic
  });

  it('C8 wiring: normal callsign "VOLT-01" with grantedTier "resident" → join=1, synthetic.join=0', () => {
    const m = makeMetrics();
    const callsign = 'VOLT-01';
    const grantedTier = 'resident';
    m.count('join', callsign.startsWith('DMN-') ? callsign : grantedTier);
    const d = m.exportDay();
    expect(d.join).toBe(1);
    expect(d.byTier['join']!['resident']).toBe(1);
    expect(d.synthetic['join']).toBe(0);
  });

  it('mixed real + synthetic: real total only counts real peers', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    m.count('join', 'DMN-bot');
    m.count('join', 'wisp');
    m.count('join', 'DMN-bot2');
    const d = m.exportDay();
    expect(d.join).toBe(2); // only resident + wisp
    expect(d.synthetic['join']).toBe(2);
  });

  it('synthetic bucket has all event keys in export', () => {
    const m = makeMetrics();
    const d = m.exportDay();
    expect('scan' in d.synthetic).toBe(true);
    expect('join' in d.synthetic).toBe(true);
    expect('glyph' in d.synthetic).toBe(true);
    expect('vote' in d.synthetic).toBe(true);
    expect('rotation' in d.synthetic).toBe(true);
    expect('showpiece' in d.synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gauge tests
// ---------------------------------------------------------------------------

describe('metrics.gauge — peak gauge (high-water-mark)', () => {
  it('gauge stores the maximum value seen', () => {
    const m = makeMetrics();
    m.gauge('peakConcurrent', 5);
    m.gauge('peakConcurrent', 3);
    m.gauge('peakConcurrent', 10);
    m.gauge('peakConcurrent', 7);
    const d = m.exportDay();
    expect(d.gauges.peakConcurrent).toBe(10);
  });

  it('gauge starts at 0 on fresh store', () => {
    const m = makeMetrics();
    const d = m.exportDay();
    expect(d.gauges.peakConcurrent).toBe(0);
  });

  it('ignores non-finite values', () => {
    const m = makeMetrics();
    m.gauge('peakConcurrent', Infinity);
    m.gauge('peakConcurrent', NaN);
    m.gauge('peakConcurrent', 5);
    const d = m.exportDay();
    expect(d.gauges.peakConcurrent).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Export schema — no PII
// ---------------------------------------------------------------------------

describe('metrics.exportDay — export schema (counters-only, no PII)', () => {
  it('export contains only count fields and gauges (no ids, no callsigns)', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    const d = m.exportDay();
    // Verify the top-level keys
    const keys = Object.keys(d).sort();
    expect(keys).toContain('join');
    expect(keys).toContain('scan');
    expect(keys).toContain('glyph');
    expect(keys).toContain('vote');
    expect(keys).toContain('rotation');
    expect(keys).toContain('showpiece');
    expect(keys).toContain('byTier');
    expect(keys).toContain('synthetic');
    expect(keys).toContain('gauges');
    expect(keys).toContain('date');
    // No PII keys
    expect(keys).not.toContain('callsign');
    expect(keys).not.toContain('peerId');
    expect(keys).not.toContain('playerId');
    expect(keys).not.toContain('name');
  });

  it('export is JSON-serializable (no undefined, no functions)', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    m.count('glyph');
    m.gauge('peakConcurrent', 4);
    const json = JSON.parse(JSON.stringify(m.exportDay()));
    expect(json.join).toBe(1);
    expect(json.glyph).toBe(1);
    expect(json.gauges.peakConcurrent).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Day reset
// ---------------------------------------------------------------------------

describe('metrics.resetDay — zeroes all counters and gauges', () => {
  it('after resetDay, all counters are 0', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    m.count('join', 'wisp');
    m.count('scan');
    m.gauge('peakConcurrent', 12);
    m.resetDay();
    const d = m.exportDay();
    expect(d.join).toBe(0);
    expect(d.scan).toBe(0);
    expect(d.gauges.peakConcurrent).toBe(0);
  });

  it('after resetDay, byTier is empty', () => {
    const m = makeMetrics();
    m.count('join', 'resident');
    m.resetDay();
    const d = m.exportDay();
    expect(Object.keys(d.byTier['join']!)).toHaveLength(0);
  });

  it('after resetDay, synthetic counts are 0', () => {
    const m = makeMetrics();
    m.count('join', 'DMN-bot');
    m.resetDay();
    const d = m.exportDay();
    expect(d.synthetic['join']).toBe(0);
  });

  it('can count after a resetDay (store is still functional)', () => {
    const m = makeMetrics();
    m.count('glyph');
    m.resetDay();
    m.count('glyph');
    m.count('glyph');
    expect(m.exportDay().glyph).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Date field from injected clock
// ---------------------------------------------------------------------------

describe('metrics.exportDay — date field', () => {
  it('date field reflects the injected clock', () => {
    const m = makeMetrics({ now: () => new Date('2026-07-04T12:00:00Z').getTime() });
    const d = m.exportDay();
    expect(d.date).toBe('2026-07-04');
  });

  it('date changes after resetDay when clock advances', () => {
    let fakeNow = new Date('2026-07-01T23:00:00Z').getTime();
    const m = makeMetrics({ now: () => fakeNow });
    expect(m.exportDay().date).toBe('2026-07-01');
    // Advance to next day
    fakeNow = new Date('2026-07-02T01:00:00Z').getTime();
    m.resetDay();
    expect(m.exportDay().date).toBe('2026-07-02');
  });
});
