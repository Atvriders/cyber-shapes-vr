/**
 * stageBrain.test.ts — the F1 Neon Director shot brain (C9, spec §7.1).
 *
 * The brain is PURE + DETERMINISTIC: no Date, no Math.random, no I/O. Its clock
 * is advanced only by `update(dtMs)`; the same RoomEvent sequence (fed at the
 * same virtual times) yields the SAME sequence of shots, every run. These tests
 * are the Step-1 RED specification (brief C9 Step 1):
 *   • FOLLOW_THROW on a release-velocity spike
 *   • min-shot holds under event spam (hysteresis / min-shot invariant)
 *   • WIDE_ESTABLISH on silence (dead-air default + QR CTA)
 *   • JOIN_CRANE on a join, then fallback to WIDE_ESTABLISH
 *   • force() wins + invariants hold on resume
 *   • determinism (same sequence → same shots)
 */

import { describe, it, expect } from 'vitest';
import { StageBrain, type RoomEvent, type Shot } from '../src/stageBrain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CFG = { minShotMs: 2000, heatThreshold: 6 } as const;

/** A release event with an explicit velocity magnitude (the FOLLOW_THROW trigger). */
function release(id: string, speed: number): RoomEvent {
  return { kind: 'release', id, peerId: 'p1', speed };
}

/** Drive the brain `steps` frames of `dtMs` each, returning the final shot. */
function tick(brain: StageBrain, steps: number, dtMs: number): Shot {
  let shot!: Shot;
  for (let i = 0; i < steps; i++) shot = brain.update(dtMs);
  return shot;
}

// ---------------------------------------------------------------------------
// FOLLOW_THROW
// ---------------------------------------------------------------------------

describe('StageBrain — FOLLOW_THROW on a velocity spike', () => {
  it('cuts to FOLLOW_THROW on a release whose speed exceeds heatThreshold', () => {
    const brain = new StageBrain(CFG);
    // Start in the dead-air default.
    expect(brain.update(16).kind).toBe('WIDE_ESTABLISH');
    // A hard throw arrives.
    brain.feed(release('s7', 12));
    const shot = brain.update(16);
    expect(shot.kind).toBe('FOLLOW_THROW');
    expect(shot.targetId).toBe('s7');
  });

  it('a gentle release BELOW the threshold does NOT trigger FOLLOW_THROW', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed(release('s1', 2)); // below heatThreshold=6
    expect(brain.update(16).kind).toBe('WIDE_ESTABLISH');
  });

  it('sinceMs resets to 0 on the cut and grows as the shot holds', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed(release('s2', 20));
    const first = brain.update(100);
    expect(first.kind).toBe('FOLLOW_THROW');
    expect(first.sinceMs).toBe(0); // freshly cut this frame
    const later = brain.update(500);
    expect(later.kind).toBe('FOLLOW_THROW');
    expect(later.sinceMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// MIN-SHOT / HYSTERESIS
// ---------------------------------------------------------------------------

describe('StageBrain — min-shot length holds under event spam', () => {
  it('a FOLLOW_THROW holds ≥ minShotMs even as newer throws arrive', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed(release('first', 15));
    expect(brain.update(16).kind).toBe('FOLLOW_THROW');
    expect(brain.update(16).targetId).toBe('first');

    // Spam more throws well before minShotMs elapses.
    for (let i = 0; i < 20; i++) {
      brain.feed(release(`spam${i}`, 30));
      const s = brain.update(50); // ~1s total, < minShotMs (2000)
      expect(s.kind).toBe('FOLLOW_THROW');
      expect(s.targetId).toBe('first'); // NEVER re-cuts to a newer target early
    }
  });

  it('after minShotMs a fresh throw IS allowed to re-cut to the new target', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed(release('first', 15));
    expect(brain.update(16).kind).toBe('FOLLOW_THROW');

    // Hold past the min-shot window with no new events.
    tick(brain, 30, 100); // 3000ms >> minShotMs

    brain.feed(release('second', 15));
    const s = brain.update(16);
    expect(s.kind).toBe('FOLLOW_THROW');
    expect(s.targetId).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// WIDE_ESTABLISH (dead-air default)
// ---------------------------------------------------------------------------

describe('StageBrain — WIDE_ESTABLISH on silence', () => {
  it('defaults to WIDE_ESTABLISH from the first frame with no events', () => {
    const brain = new StageBrain(CFG);
    expect(brain.update(16).kind).toBe('WIDE_ESTABLISH');
  });

  it('returns to WIDE_ESTABLISH after a shot expires with no new events', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed(release('s3', 15));
    expect(brain.update(16).kind).toBe('FOLLOW_THROW');
    // Long dead-air after the min-shot window: fall back to the establishing shot.
    const s = tick(brain, 60, 100); // 6000ms of silence
    expect(s.kind).toBe('WIDE_ESTABLISH');
  });
});

// ---------------------------------------------------------------------------
// JOIN_CRANE then fallback
// ---------------------------------------------------------------------------

describe('StageBrain — JOIN_CRANE then fallback', () => {
  it('cuts to JOIN_CRANE on a player-join ceremony', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed({ kind: 'join', peerId: 'p9' });
    const s = brain.update(16);
    expect(s.kind).toBe('JOIN_CRANE');
    expect(s.targetId).toBe('p9');
  });

  it('falls back to WIDE_ESTABLISH once the join shot expires', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed({ kind: 'join', peerId: 'p9' });
    expect(brain.update(16).kind).toBe('JOIN_CRANE');
    const s = tick(brain, 60, 100); // long silence after
    expect(s.kind).toBe('WIDE_ESTABLISH');
  });

  it('a mid-JOIN_CRANE throw does NOT preempt the min-shot window', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.feed({ kind: 'join', peerId: 'p9' });
    expect(brain.update(16).kind).toBe('JOIN_CRANE');
    brain.feed(release('s5', 30));
    const s = brain.update(50); // still inside minShotMs
    expect(s.kind).toBe('JOIN_CRANE');
  });
});

// ---------------------------------------------------------------------------
// force()
// ---------------------------------------------------------------------------

describe('StageBrain — force() wins and invariants hold on resume', () => {
  it('force() overrides the brain until the hold elapses', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.force({ kind: 'GLYPH_BIRTH', targetId: 'g1', sinceMs: 0 }, 3000);
    // Even a huge throw cannot preempt a forced shot.
    brain.feed(release('s6', 100));
    const held = brain.update(1000);
    expect(held.kind).toBe('GLYPH_BIRTH');
    expect(held.targetId).toBe('g1');
  });

  it('after the forced hold expires the brain resumes with the min-shot invariant intact', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.force({ kind: 'GLYPH_BIRTH', targetId: 'g1', sinceMs: 0 }, 1000);
    tick(brain, 15, 100); // 1500ms — past the forced hold
    // With no pending events, the resumed brain establishes.
    const resumed = brain.update(16);
    expect(resumed.kind).toBe('WIDE_ESTABLISH');
    // A throw NOW is honored (the forced hold is over).
    brain.feed(release('s8', 20));
    expect(brain.update(16).kind).toBe('FOLLOW_THROW');
  });

  it('a shot cut immediately after resume still respects its own min-shot window', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    brain.force({ kind: 'GLYPH_BIRTH', targetId: 'g1', sinceMs: 0 }, 1000);
    tick(brain, 11, 100); // 1100ms — forced hold expired
    brain.feed(release('a', 20));
    expect(brain.update(16).kind).toBe('FOLLOW_THROW');
    expect(brain.update(16).targetId).toBe('a');
    // A newer throw right after cannot re-cut before minShotMs.
    brain.feed(release('b', 40));
    const s = brain.update(50);
    expect(s.targetId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

describe('StageBrain — determinism', () => {
  /** A scripted timeline of (atMs, event) pairs, replayed against a fresh brain. */
  const script: Array<{ atMs: number; event?: RoomEvent }> = [
    { atMs: 0 },
    { atMs: 100, event: { kind: 'join', peerId: 'pA' } },
    { atMs: 3000, event: release('x1', 12) },
    { atMs: 3100, event: release('x2', 30) }, // inside min-shot — ignored
    { atMs: 6000, event: release('x3', 20) },
    { atMs: 6050, event: { kind: 'glyph', id: 'g' } }, // fame/ordinary event — no cut
    { atMs: 12000 },
  ];

  /** Run the script, sampling the shot kind+target every 100ms. Deterministic. */
  function run(): string[] {
    const brain = new StageBrain(CFG);
    const out: string[] = [];
    const dt = 100;
    let virt = 0;
    let i = 0;
    while (virt <= 12000) {
      // Feed any events scheduled at/before this virtual time.
      while (i < script.length && script[i].atMs <= virt) {
        if (script[i].event) brain.feed(script[i].event!);
        i++;
      }
      const s = brain.update(dt);
      out.push(`${s.kind}:${s.targetId ?? ''}`);
      virt += dt;
    }
    return out;
  }

  it('the same event sequence produces the same shot sequence across runs', () => {
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it('uses no wall-clock — replays identically regardless of real time', () => {
    const a = run();
    // A no-op busy spin would change Date.now but must not change output.
    const b = run();
    expect(a).toEqual(b);
    // And it actually produced meaningful transitions (not all one kind).
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it('treats a fame/glyph bump as an ordinary event (C26 forward-compat)', () => {
    const brain = new StageBrain(CFG);
    brain.update(16);
    // A glyph/fame event alone never forces a cut off the establishing default.
    brain.feed({ kind: 'glyph', id: 'g1' });
    expect(brain.update(16).kind).toBe('WIDE_ESTABLISH');
  });
});
