/**
 * fame.test.ts — C26 fame camera tiebreak in the StageBrain (spec §7.15). Fame is
 * a FOLLOW_THROW tiebreak ONLY: it orders two SAME-FRAME throws, never creates a
 * cut, never outranks JOIN_CRANE, never starves WIDE_ESTABLISH, is capped at
 * ~60 % of FOLLOW_THROW airtime per resident, decays within 180 s, and clears on
 * RESET. The cfg key stays `heatThreshold` (no rename churn).
 */

import { describe, it, expect } from 'vitest';
import {
  StageBrain,
  scoreHighlight,
  FAME_DECAY_MS,
  FAME_SHOT_SHARE_CAP,
  type RoomEvent,
} from '../src/stageBrain.js';

const CFG = { minShotMs: 100, heatThreshold: 6 } as const;
const rel = (id: string, peerId: string, speed: number): RoomEvent => ({ kind: 'release', id, peerId, speed });
const fame = (peerId: string, delta: number): RoomEvent => ({ kind: 'fame', peerId, delta });

describe('fame — cfg key stays heatThreshold', () => {
  it('a release below heatThreshold never cuts (key unchanged)', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(rel('s1', 'P1', 3));
    expect(b.update(16).kind).toBe('WIDE_ESTABLISH');
  });
});

describe('fame — a FOLLOW_THROW tiebreak only', () => {
  it('a fame bump is an ordinary event (never cuts)', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(fame('P1', 50));
    expect(b.fameOf('P1')).toBe(50); // recorded immediately (before any decay)
    expect(b.update(16).kind).toBe('WIDE_ESTABLISH'); // ordinary — never cuts
    expect(b.fameOf('P1')).toBeLessThan(50); // and it decays over time
  });

  it('higher fame wins a same-frame FOLLOW_THROW tie', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(fame('P2', 40)); // P2 is famous, P1 is not
    b.feed(rel('sP1', 'P1', 20));
    b.feed(rel('sP2', 'P2', 20)); // same frame — fame breaks the tie
    const s = b.update(16);
    expect(s.kind).toBe('FOLLOW_THROW');
    expect(s.targetId).toBe('sP2');
  });

  it('all-fame-0 keeps the incumbent (first wins) — byte-identical to the v1 brain', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(rel('first', 'P1', 20));
    b.feed(rel('second', 'P2', 20));
    expect(b.update(16).targetId).toBe('first');
  });

  it('fame NEVER lifts a throw over a JOIN_CRANE (rule priority unchanged)', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(fame('P1', 100));
    b.feed(rel('sP1', 'P1', 30)); // hugely famous throw
    b.feed({ kind: 'join', peerId: 'P9' }); // a join in the same frame
    const s = b.update(16);
    expect(s.kind).toBe('JOIN_CRANE');
    expect(s.targetId).toBe('P9');
  });
});

describe('fame — fairness cap (≤ 60 % of FOLLOW_THROW airtime)', () => {
  it('a resident over the share cap loses the tiebreak so others get airtime', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(fame('P1', 80));
    b.feed(fame('P2', 20));
    // Give P1 sustained FOLLOW_THROW airtime (re-cutting past minShot each frame).
    for (let i = 0; i < 20; i++) {
      b.feed(rel(`a${i}`, 'P1', 20));
      b.update(200);
    }
    expect(b.followShareOf('P1')).toBeGreaterThan(FAME_SHOT_SHARE_CAP);
    // Now a same-frame tie: P1 is over the cap → its fame is suppressed → P2 wins.
    b.feed(rel('sP1', 'P1', 20));
    b.feed(rel('sP2', 'P2', 20));
    const s = b.update(200);
    expect(s.kind).toBe('FOLLOW_THROW');
    expect(s.targetId).toBe('sP2');
  });
});

describe('fame — decay ≤ 180 s', () => {
  it('fame fully decays to 0 within FAME_DECAY_MS', () => {
    const b = new StageBrain(CFG);
    b.feed(fame('P1', 100));
    expect(b.fameOf('P1')).toBe(100);
    const step = 1000;
    for (let t = 0; t < FAME_DECAY_MS; t += step) b.update(step);
    expect(b.fameOf('P1')).toBe(0);
  });
});

describe('fame — cleared on RESET + never starves the establishing default', () => {
  it('reset() clears fame + the per-rotation airtime accounting', () => {
    const b = new StageBrain(CFG);
    b.feed(fame('P1', 60));
    b.feed(rel('s', 'P1', 20));
    b.update(200);
    expect(b.fameOf('P1')).toBeGreaterThan(0);
    b.reset();
    expect(b.fameOf('P1')).toBe(0);
    expect(b.followShareOf('P1')).toBe(0);
  });

  it('a famous resident never starves WIDE_ESTABLISH on dead air', () => {
    const b = new StageBrain(CFG);
    b.update(16);
    b.feed(fame('P1', 100));
    b.feed(rel('s', 'P1', 20));
    expect(b.update(16).kind).toBe('FOLLOW_THROW');
    // Long silence — the establishing default still reclaims the screen.
    let s = b.update(16);
    for (let i = 0; i < 40; i++) s = b.update(100);
    expect(s.kind).toBe('WIDE_ESTABLISH');
  });
});

// ---------------------------------------------------------------------------
// Isolation — fame is a STAGE-CLIENT-local camera signal. It must NEVER leak into
// a server-authoritative consumer: the caster host + C21 replay both score the
// SAME event stream through `scoreHighlight`, which the server owns. If fame could
// perturb `scoreHighlight`, the "camera preference" would leak into what counts as
// a highlight (the sim/determinism path). It must not.
// ---------------------------------------------------------------------------
describe('fame — isolated from the server-authoritative scorer (never leaks into the sim path)', () => {
  const relE = (id: string, speed: number): RoomEvent => ({ kind: 'release', id, peerId: 'P1', speed });

  it('scoreHighlight IGNORES fame events — identical result with and without fame in the window', () => {
    const base: RoomEvent[] = [relE('s1', 20), { kind: 'impact', id: 's2', speed: 12 }];
    const withFame: RoomEvent[] = [
      fame('P1', 100),
      ...base,
      fame('P2', 50),
      fame('P1', 100), // even a runaway fame stack changes nothing the scorer sees
    ];
    expect(scoreHighlight(withFame)).toEqual(scoreHighlight(base));
  });

  it('a huge fame bump never changes which highlight the scorer picks (the caster reads THIS, not fame)', () => {
    const events: RoomEvent[] = [relE('s9', 30)];
    const before = scoreHighlight(events);
    expect(before?.kind).toBe('THROW');
    const withHugeFame: RoomEvent[] = [fame('P1', 999), ...events];
    expect(scoreHighlight(withHugeFame)).toEqual(before);
  });
});
