/**
 * connectionCaps.test.ts — unit regression tests for the DoS caps added in the
 * server security audit (finding #1): the per-socket token-bucket rate limiter
 * and the payload / voice-frame size caps.
 */

import { describe, it, expect } from 'vitest';
import {
  TokenBucket,
  MAX_PAYLOAD_BYTES,
  MAX_VOICE_FRAME_BYTES,
  RATE_REFILL_PER_SEC,
} from '../src/connection.js';

describe('TokenBucket rate limiter (finding #1)', () => {
  it('allows up to `burst` frames immediately, then drops', () => {
    let now = 0;
    const bucket = new TokenBucket(10 /* refill/s */, 5 /* burst */, () => now);
    // First 5 (burst) are allowed with no time elapsed.
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    // 6th is over budget → dropped.
    expect(bucket.take()).toBe(false);
    expect(bucket.take()).toBe(false);
  });

  it('refills over time at refillPerSec', () => {
    let now = 0;
    const bucket = new TokenBucket(10 /* refill/s */, 5, () => now);
    // Drain the burst.
    for (let i = 0; i < 5; i++) bucket.take();
    expect(bucket.take()).toBe(false);

    // Advance 100ms → 10/s * 0.1s = 1 token back.
    now = 100;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false); // only one refilled

    // Advance 1s → fully refilled (capped at burst).
    now = 1100;
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (bucket.take()) allowed++;
    expect(allowed).toBe(5); // capped at burst
  });

  it('a sustained flood at one instant is dropped after the burst is spent', () => {
    let now = 0;
    const bucket = new TokenBucket(RATE_REFILL_PER_SEC, 200, () => now);
    let allowed = 0;
    let dropped = 0;
    // 1000 frames all at the same instant (no time advance).
    for (let i = 0; i < 1000; i++) {
      if (bucket.take()) allowed++;
      else dropped++;
    }
    expect(allowed).toBe(200); // only the burst
    expect(dropped).toBe(800); // the rest are dropped (cheap, no processing)
  });
});

describe('payload size caps (finding #1)', () => {
  it('MAX_PAYLOAD_BYTES is a sane cap far below ws default (100 MiB)', () => {
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(100 * 1024 * 1024);
  });

  it('MAX_VOICE_FRAME_BYTES is tighter than the overall payload cap', () => {
    expect(MAX_VOICE_FRAME_BYTES).toBeGreaterThan(0);
    expect(MAX_VOICE_FRAME_BYTES).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });
});
