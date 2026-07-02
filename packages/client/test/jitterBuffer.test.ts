/**
 * jitterBuffer.test.ts — Unit tests for the pure JitterBuffer class (B10).
 *
 * JitterBuffer semantics:
 *   - push(tsMs, bytes, flags): insert frame keyed by tsMs (ordered set)
 *   - pop(nowMs): return next in-order frame once buffered ~targetDepth behind
 *     the newest frame; drop-oldest when over maxDepth; null when nothing ready.
 *   - On talk-stop frame (flag bit2 set), flush so next utterance starts clean.
 *   - flush(): empty the buffer immediately.
 *
 * Flag constants (bit masks):
 *   bit0 = 0x01 → key / first frame
 *   bit1 = 0x02 → talk-start
 *   bit2 = 0x04 → talk-stop
 */

import { describe, it, expect } from 'vitest';
import {
  JitterBuffer,
  FLAG_KEY,
  FLAG_TALK_START,
  FLAG_TALK_STOP,
} from '../src/voice/jitterBuffer.js';

// Helper: make a small Uint8Array with a given first byte (so frames are distinguishable)
function frame(tag: number): Uint8Array {
  return new Uint8Array([tag]);
}

describe('JitterBuffer', () => {
  describe('flag constants', () => {
    it('FLAG_KEY is 0x01', () => {
      expect(FLAG_KEY).toBe(0x01);
    });
    it('FLAG_TALK_START is 0x02', () => {
      expect(FLAG_TALK_START).toBe(0x02);
    });
    it('FLAG_TALK_STOP is 0x04', () => {
      expect(FLAG_TALK_STOP).toBe(0x04);
    });
  });

  describe('in-order push then pop', () => {
    it('returns null when nothing pushed', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      expect(jb.pop(1000)).toBeNull();
    });

    it('returns null when frame has not buffered past targetDepth', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      // push at t=100; pop at t=140, only 40ms of buffering behind newest (100)
      // Since newest=100 and we need nowMs - newest >= targetDepth → 140-100=40 < 60
      jb.push(100, frame(1), FLAG_KEY);
      const result = jb.pop(140);
      expect(result).toBeNull();
    });

    it('returns frame once targetDepth ms have elapsed since the newest frame', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      jb.push(100, frame(1), FLAG_KEY);
      // nowMs - newest (100) = 70 >= targetDepth (60) → ready
      const result = jb.pop(170);
      expect(result).not.toBeNull();
      expect(result!.tsMs).toBe(100);
      expect(result!.bytes[0]).toBe(1);
    });

    it('returns frames in timestamp order', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 500 });
      jb.push(100, frame(1), FLAG_KEY);
      jb.push(120, frame(2), 0);
      jb.push(140, frame(3), 0);

      // nowMs well past newest (140), so all buffered
      const r1 = jb.pop(300);
      const r2 = jb.pop(300);
      const r3 = jb.pop(300);
      const r4 = jb.pop(300);

      expect(r1!.tsMs).toBe(100);
      expect(r2!.tsMs).toBe(120);
      expect(r3!.tsMs).toBe(140);
      expect(r4).toBeNull();
    });

    it('returns null again after all frames consumed', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      jb.push(100, frame(1), FLAG_KEY);
      jb.pop(200); // consume it
      expect(jb.pop(200)).toBeNull();
    });
  });

  describe('reordered insert', () => {
    it('late-arriving frame is returned in correct timestamp order', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 500 });
      // Push t=40 before t=20 (simulating out-of-order arrival)
      jb.push(40, frame(40), 0);
      jb.push(20, frame(20), FLAG_KEY);

      const r1 = jb.pop(200);
      const r2 = jb.pop(200);

      // Must come back sorted: 20 before 40
      expect(r1!.tsMs).toBe(20);
      expect(r2!.tsMs).toBe(40);
    });

    it('three frames pushed out of order come back in order', () => {
      const jb = new JitterBuffer({ targetDepthMs: 40, maxDepthMs: 500 });
      jb.push(60, frame(60), 0);
      jb.push(20, frame(20), FLAG_KEY);
      jb.push(40, frame(40), 0);

      const r1 = jb.pop(500);
      const r2 = jb.pop(500);
      const r3 = jb.pop(500);

      expect(r1!.tsMs).toBe(20);
      expect(r2!.tsMs).toBe(40);
      expect(r3!.tsMs).toBe(60);
    });
  });

  describe('overflow: drop-oldest when over maxDepth', () => {
    it('drops oldest frames to stay within maxDepth', () => {
      // maxDepthMs=100: frames spanning more than 100ms → oldest dropped
      const jb = new JitterBuffer({ targetDepthMs: 0, maxDepthMs: 100 });
      // Push frames at 0, 20, 40, 60, 80, 100, 120 — span=120 > maxDepth=100
      for (let t = 0; t <= 120; t += 20) {
        jb.push(t, frame(t), t === 0 ? FLAG_KEY : 0);
      }

      // The buffer should have dropped earliest frames so span <= 100ms
      // Remaining: frames from t=20..120 (span=100) or t=0..100 depending on impl.
      // Either way oldest should be gone (t=0 dropped) if span was exceeded.
      const results: number[] = [];
      let r;
      while ((r = jb.pop(9999)) !== null) {
        results.push(r.tsMs);
      }

      // We pushed 7 frames (0..120 step 20). maxDepthMs=100 means at most
      // frames spanning 100ms can be kept. The oldest (smallest ts) get dropped.
      // At minimum, t=0 must have been dropped.
      expect(results).not.toContain(0);
      // The newest (t=120) must be present
      expect(results).toContain(120);
    });

    it('keeps the newest frames when overflowing', () => {
      const jb = new JitterBuffer({ targetDepthMs: 0, maxDepthMs: 60 });
      // Push 5 frames spanning 80ms (0,20,40,60,80) → span=80 > 60
      for (let t = 0; t <= 80; t += 20) {
        jb.push(t, frame(t), t === 0 ? FLAG_KEY : 0);
      }

      const results: number[] = [];
      let r;
      while ((r = jb.pop(9999)) !== null) {
        results.push(r.tsMs);
      }

      // Must include the newest (80) and not include the oldest (0)
      expect(results).toContain(80);
      expect(results).not.toContain(0);
    });
  });

  describe('talk-stop flush', () => {
    it('pop of a talk-stop frame returns it and flushes the buffer', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 500 });
      jb.push(100, frame(1), FLAG_KEY);
      jb.push(120, frame(2), 0);
      jb.push(140, frame(3), FLAG_TALK_STOP);
      jb.push(160, frame(4), 0); // one more after stop

      // Pop until we hit the talk-stop
      const r1 = jb.pop(500);
      const r2 = jb.pop(500);
      const r3 = jb.pop(500); // this is the talk-stop frame

      expect(r1!.tsMs).toBe(100);
      expect(r2!.tsMs).toBe(120);
      expect(r3!.tsMs).toBe(140);
      expect(r3!.flags & FLAG_TALK_STOP).toBeTruthy();

      // After talk-stop is popped, buffer should be flushed (even t=160 is gone)
      const r4 = jb.pop(500);
      expect(r4).toBeNull();
    });

    it('flush() empties buffer immediately', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 500 });
      jb.push(100, frame(1), FLAG_KEY);
      jb.push(120, frame(2), 0);
      jb.flush();

      expect(jb.pop(500)).toBeNull();
    });

    it('after flush, new frames can be pushed and popped cleanly', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 500 });
      jb.push(100, frame(1), FLAG_KEY);
      jb.flush();

      // New utterance
      jb.push(200, frame(2), FLAG_KEY | FLAG_TALK_START);
      jb.push(220, frame(3), 0);

      const r1 = jb.pop(400);
      const r2 = jb.pop(400);

      expect(r1!.tsMs).toBe(200);
      expect(r2!.tsMs).toBe(220);
    });
  });

  describe('conceal (missing frame / stalled clock)', () => {
    it('returns null when clock has not advanced past targetDepth', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      jb.push(1000, frame(1), FLAG_KEY);
      // Clock only 30ms past newest → not ready yet
      expect(jb.pop(1030)).toBeNull();
    });

    it('does not throw when pop is called repeatedly with no new frames', () => {
      const jb = new JitterBuffer({ targetDepthMs: 60, maxDepthMs: 200 });
      // Drain any ready frames
      for (let i = 0; i < 20; i++) {
        expect(() => jb.pop(i * 10)).not.toThrow();
      }
    });
  });

  describe('default opts', () => {
    it('constructs with no options (uses defaults)', () => {
      expect(() => new JitterBuffer()).not.toThrow();
    });

    it('works end-to-end with default opts', () => {
      const jb = new JitterBuffer();
      jb.push(1000, frame(1), FLAG_KEY);
      jb.push(1020, frame(2), 0);
      // Pop well into the future — should return frames
      const r1 = jb.pop(2000);
      expect(r1).not.toBeNull();
      expect(r1!.tsMs).toBe(1000);
    });
  });
});
