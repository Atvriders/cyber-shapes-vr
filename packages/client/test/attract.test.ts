/**
 * attract.test.ts — F10 Ghost Arcade attract state machine (C13).
 *
 * The load-bearing invariant (spec §7.10 / §7.17): idle detection is
 * ACTIVITY-BASED over HUMAN intents/poses ONLY — never connection count, and
 * synthetic (daemon) activity is invisible to it. So attract triggers on human
 * silence DESPITE zombie connections AND despite an active daemon; a single
 * meaningful HUMAN activity dissolves it; attract→live resync converges; and a
 * scripted shape-ballet plays with ZERO reels.
 *
 * Pure state machine — injected clock, fake time.
 */

import { describe, it, expect } from 'vitest';
import {
  AttractMachine,
  IDLE_TIMEOUT_MS,
  scriptedBallet,
  GHOST_OPACITY,
  ghostNameplate,
} from '../src/stage/attract.js';

function makeMachine(now: () => number) {
  return new AttractMachine({ now, idleTimeoutMs: IDLE_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Human-only idle detection.
// ---------------------------------------------------------------------------

describe('attract idle detection (HUMAN-only)', () => {
  it('triggers attract after human silence for idleTimeoutMs', () => {
    let t = 0;
    const m = makeMachine(() => t);
    expect(m.phase).toBe('LIVE');
    m.noteHumanActivity(); // last human activity at t=0
    t = IDLE_TIMEOUT_MS - 1;
    m.tick();
    expect(m.phase).toBe('LIVE');
    t = IDLE_TIMEOUT_MS + 1;
    m.tick();
    expect(m.phase).toBe('ATTRACT');
  });

  it('triggers attract DESPITE zombie connections (idle is NOT connection count)', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    // Many connected peers, but NONE are producing human activity.
    m.setConnectedCount(50);
    t = IDLE_TIMEOUT_MS + 100;
    m.tick();
    expect(m.phase).toBe('ATTRACT'); // connection count is irrelevant
  });

  it('triggers attract DESPITE an active daemon (synthetic activity is invisible)', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    // A daemon keeps throwing shapes — synthetic activity must NOT reset idle.
    for (let i = 0; i < 20; i++) {
      t = i * 50;
      m.noteSyntheticActivity(); // daemon intents — invisible to idle
    }
    t = IDLE_TIMEOUT_MS + 100;
    m.tick();
    expect(m.phase).toBe('ATTRACT');
  });

  it('a synthetic-flagged activity does NOT reset the idle timer', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    t = IDLE_TIMEOUT_MS - 100;
    m.noteSyntheticActivity(); // must NOT extend idle
    t = IDLE_TIMEOUT_MS + 1;
    m.tick();
    expect(m.phase).toBe('ATTRACT');
  });

  it('a real human activity DOES reset the idle timer (stays live)', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    t = IDLE_TIMEOUT_MS - 100;
    m.noteHumanActivity(); // reset
    t = IDLE_TIMEOUT_MS + 50; // < timeout since last HUMAN activity
    m.tick();
    expect(m.phase).toBe('LIVE');
  });
});

// ---------------------------------------------------------------------------
// Dissolve on first meaningful human activity + resync.
// ---------------------------------------------------------------------------

describe('attract dissolve + resync', () => {
  it('dissolves on the first meaningful HUMAN activity and requests a snapshot', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    t = IDLE_TIMEOUT_MS + 1;
    m.tick();
    expect(m.phase).toBe('ATTRACT');
    // A human joins / throws → dissolve to LIVE and flag a REQUEST_SNAPSHOT.
    t = IDLE_TIMEOUT_MS + 500;
    m.noteHumanActivity();
    expect(m.phase).toBe('DISSOLVING');
    expect(m.needsResync()).toBe(true);
  });

  it('a synthetic activity while in ATTRACT does NOT dissolve it', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    t = IDLE_TIMEOUT_MS + 1;
    m.tick();
    expect(m.phase).toBe('ATTRACT');
    m.noteSyntheticActivity(); // daemon acting during quiet hours
    expect(m.phase).toBe('ATTRACT');
  });

  it('attract→live resync converges: after resync the machine is LIVE and clears the flag', () => {
    let t = 0;
    const m = makeMachine(() => t);
    m.noteHumanActivity();
    t = IDLE_TIMEOUT_MS + 1;
    m.tick();
    t = IDLE_TIMEOUT_MS + 500;
    m.noteHumanActivity();
    expect(m.needsResync()).toBe(true);
    m.onSnapshotApplied(); // the REQUEST_SNAPSHOT response arrived + applied
    expect(m.needsResync()).toBe(false);
    m.tick();
    expect(m.phase).toBe('LIVE');
  });
});

// ---------------------------------------------------------------------------
// Ghost rendering constants + day-one scripted ballet (works with ZERO reels).
// ---------------------------------------------------------------------------

describe('ghost rendering + day-one ballet', () => {
  it('ghosts render at 70% opacity with GHOST_XX nameplates', () => {
    expect(GHOST_OPACITY).toBeCloseTo(0.7);
    expect(ghostNameplate(0)).toBe('GHOST_00');
    expect(ghostNameplate(7)).toBe('GHOST_07');
    expect(ghostNameplate(42)).toBe('GHOST_42');
    // NEVER a real name — always the GHOST_ prefix.
    expect(ghostNameplate(3)).toMatch(/^GHOST_\d{2}$/);
  });

  it('scriptedBallet produces a deterministic non-empty shape choreography with ZERO reels', () => {
    const a = scriptedBallet(0);
    const b = scriptedBallet(0);
    // Deterministic (same time → same poses).
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // It moves over time (different time → different poses).
    const later = scriptedBallet(2000);
    expect(later).not.toEqual(a);
    // Every ballet shape carries an id + a finite position (renderable).
    for (const s of a) {
      expect(typeof s.id).toBe('string');
      expect(Number.isFinite(s.position.x)).toBe(true);
      expect(Number.isFinite(s.position.y)).toBe(true);
      expect(Number.isFinite(s.position.z)).toBe(true);
    }
  });

  it('venue-brightness toggle flips a high-exposure palette flag', () => {
    let t = 0;
    const m = makeMachine(() => t);
    expect(m.venueBright).toBe(false);
    m.setVenueBright(true);
    expect(m.venueBright).toBe(true);
  });
});
