/**
 * wisps.test.ts — Task C14 (F4 Wisp Protocol) PURE shared-model tests.
 *
 * The shared model is deterministic (no Date/Math.random). It owns:
 *   - `allocateSlot(slots, headsetFrustum, stageDir)` — deterministic slot pick
 *     biased into the headset frustum + toward the stage camera direction.
 *   - `WISP_DRAW_CALL_BUDGET = 4` (spec §6.5 — the render ledger line).
 *   - pulse token-bucket constants (2/s) + a pure `WispPulseBucket`.
 *   - `clampPulseMagnitude` — the server-side anti-cheat impulse clamp.
 *   - `WISP_SLOT_POSITIONS` — the fixed orbit-slot layout the allocator ranks.
 */

import { describe, it, expect } from 'vitest';
import {
  WISP_CAP,
  WISP_DRAW_CALL_BUDGET,
  WISP_SLOT_POSITIONS,
  WISP_PULSE_RATE_PER_SEC,
  WISP_PULSE_BURST,
  WISP_PULSE_MAX_IMPULSE,
  allocateSlot,
  clampPulseMagnitude,
  WispPulseBucket,
  type WispFrustum,
} from '../src/wisps.js';

// A headset looking down −Z from a small +Z offset (the common booth pose), and
// a stage camera roughly ahead of it (−Z). Deterministic literals — no time.
const HEADSET: WispFrustum = {
  pos: { x: 0, y: 1.6, z: 3 },
  dir: { x: 0, y: 0, z: -1 },
  halfAngleCos: Math.cos(Math.PI / 3), // 60° half-angle cone
};
const STAGE_DIR = { x: 0, y: 0, z: -1 };

describe('WISP constants', () => {
  it('caps at 24 wisps (spec §5.1) and budgets ≤ 4 draw calls (spec §6.5)', () => {
    expect(WISP_CAP).toBe(24);
    expect(WISP_DRAW_CALL_BUDGET).toBe(4);
    // The fixed orbit layout offers exactly one slot per wisp cap.
    expect(WISP_SLOT_POSITIONS.length).toBe(WISP_CAP);
  });

  it('rate-limits pulses at 2/s (token bucket)', () => {
    expect(WISP_PULSE_RATE_PER_SEC).toBe(2);
    expect(WISP_PULSE_BURST).toBe(2);
  });
});

describe('allocateSlot — deterministic + frustum/stage biased', () => {
  it('same input → same slot (deterministic, no time/random)', () => {
    const occupied: boolean[] = new Array(WISP_CAP).fill(false);
    const a = allocateSlot(occupied, HEADSET, STAGE_DIR);
    const b = allocateSlot(occupied, HEADSET, STAGE_DIR);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('biases toward the headset frustum / stage — the chosen slot is in-view', () => {
    const occupied: boolean[] = new Array(WISP_CAP).fill(false);
    const slot = allocateSlot(occupied, HEADSET, STAGE_DIR);
    expect(slot).not.toBeNull();
    const p = WISP_SLOT_POSITIONS[slot!];
    // The picked slot must lie within the headset's view cone (dot ≥ cos(half)).
    const dx = p.x - HEADSET.pos.x;
    const dy = p.y - HEADSET.pos.y;
    const dz = p.z - HEADSET.pos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dot =
      (dx / len) * HEADSET.dir.x + (dy / len) * HEADSET.dir.y + (dz / len) * HEADSET.dir.z;
    expect(dot).toBeGreaterThanOrEqual(HEADSET.halfAngleCos - 1e-9);
  });

  it('skips occupied slots and never returns an occupied index', () => {
    const occupied: boolean[] = new Array(WISP_CAP).fill(false);
    const first = allocateSlot(occupied, HEADSET, STAGE_DIR)!;
    occupied[first] = true;
    const second = allocateSlot(occupied, HEADSET, STAGE_DIR)!;
    expect(second).not.toBe(first);
    expect(occupied[second]).toBe(false);
  });

  it('fills all 24 slots with distinct indices, then returns null (over-cap)', () => {
    const occupied: boolean[] = new Array(WISP_CAP).fill(false);
    const seen = new Set<number>();
    for (let i = 0; i < WISP_CAP; i++) {
      const s = allocateSlot(occupied, HEADSET, STAGE_DIR);
      expect(s).not.toBeNull();
      expect(seen.has(s!)).toBe(false);
      seen.add(s!);
      occupied[s!] = true;
    }
    expect(seen.size).toBe(WISP_CAP);
    // 25th allocation → null (spectate/queue page, over-cap).
    expect(allocateSlot(occupied, HEADSET, STAGE_DIR)).toBeNull();
  });
});

describe('clampPulseMagnitude — server anti-cheat impulse clamp', () => {
  it('clamps a huge client magnitude to the server max regardless of client value', () => {
    expect(clampPulseMagnitude(1e9)).toBe(WISP_PULSE_MAX_IMPULSE);
    expect(clampPulseMagnitude(Number.POSITIVE_INFINITY)).toBe(WISP_PULSE_MAX_IMPULSE);
  });

  it('floors a negative/NaN client magnitude to 0 (never a suction/garbage impulse)', () => {
    expect(clampPulseMagnitude(-500)).toBe(0);
    expect(clampPulseMagnitude(Number.NaN)).toBe(0);
  });

  it('passes an in-range magnitude through unchanged', () => {
    const mid = WISP_PULSE_MAX_IMPULSE / 2;
    expect(clampPulseMagnitude(mid)).toBe(mid);
  });
});

describe('WispPulseBucket — 2/s token bucket (fake time)', () => {
  it('rejects the 3rd pulse within 1 second', () => {
    let now = 0;
    const bucket = new WispPulseBucket(() => now);
    expect(bucket.tryPulse()).toBe(true); // 1st
    now = 100;
    expect(bucket.tryPulse()).toBe(true); // 2nd
    now = 200;
    expect(bucket.tryPulse()).toBe(false); // 3rd within 1 s — REJECTED
  });

  it('refills at 2/s — a pulse is allowed again after ~500 ms', () => {
    let now = 0;
    const bucket = new WispPulseBucket(() => now);
    expect(bucket.tryPulse()).toBe(true);
    expect(bucket.tryPulse()).toBe(true);
    expect(bucket.tryPulse()).toBe(false);
    now = 500; // one token refilled at 2/s
    expect(bucket.tryPulse()).toBe(true);
    expect(bucket.tryPulse()).toBe(false);
  });

  it('24 wisps at max rate never exceed the budget or drop a tick', () => {
    // Each of 24 wisps hammers its bucket every 100 ms for 1 s. Over that second
    // NO wisp may fire more than the 2/s bucket allows (burst 2 + 2 refilled ≈ 4),
    // and the loop must run all 240 attempts without an error/thrown tick.
    let now = 0;
    const buckets = Array.from({ length: WISP_CAP }, () => new WispPulseBucket(() => now));
    const admitted = new Array(WISP_CAP).fill(0);
    for (let t = 0; t < 1000; t += 100) {
      now = t;
      for (let w = 0; w < WISP_CAP; w++) {
        if (buckets[w].tryPulse()) admitted[w]++;
      }
    }
    for (let w = 0; w < WISP_CAP; w++) {
      // burst (2) + ~2 refilled over the second → ≤ 4 admitted, never unbounded.
      expect(admitted[w]).toBeGreaterThanOrEqual(2);
      expect(admitted[w]).toBeLessThanOrEqual(WISP_PULSE_RATE_PER_SEC + WISP_PULSE_BURST);
    }
  });
});
