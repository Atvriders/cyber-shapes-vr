/**
 * elections.test.ts — the F5 Reality Referendum election reducer (C15, spec §7.5).
 *
 * The reducer is PURE + DETERMINISTIC: no Date, no Math.random, no I/O. Its clock
 * is `nowMs` passed into each transition; the same input sequence at the same
 * virtual times yields the SAME state, every run. These are the Step-1 RED specs
 * (brief C15 Step 1):
 *   • full cycle OPEN → TALLY → ENACT → COOLDOWN → (re-open)
 *   • TIE → RE-OPEN (never ENACT on a tie)
 *   • one SWITCHABLE vote per token (a token may change its vote, never double-count)
 *   • adaptive deadline SHORTENS under < 4 voters
 *   • cooldown holds, then a fresh election opens
 *   • options are dial cue ids ONLY (the C20 theme extension point is untouched)
 */

import { describe, it, expect } from 'vitest';
import {
  electionReducer,
  openElection,
  ELECTION_MIN_DEADLINE_MS,
  ELECTION_MAX_DEADLINE_MS,
  ELECTION_COOLDOWN_MS,
  ELECTION_QUORUM,
  type ElectionState,
  type ElectionAction,
} from '../src/elections.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Three candidate dial cue ids (options are dial ids ONLY — spec §7.5). */
const OPTIONS = ['low-g', 'gravity-flip', 'bullet-time'] as const;

/** Open a fresh election at t=0 with the three dial-id options. */
function open(nowMs = 0): ElectionState {
  return openElection({ options: [...OPTIONS], nowMs });
}

/** Drive one action through the reducer. */
function step(s: ElectionState, a: ElectionAction): ElectionState {
  return electionReducer(s, a);
}

/** Cast a vote from `token` for `option` at `nowMs`. */
function cast(
  s: ElectionState,
  token: string,
  option: string,
  nowMs: number
): ElectionState {
  return step(s, { type: 'CAST', token, option, nowMs });
}

/** Advance the clock (a pure TICK the host drives from its injected timer). */
function tick(s: ElectionState, nowMs: number): ElectionState {
  return step(s, { type: 'TICK', nowMs });
}

// ---------------------------------------------------------------------------
// Options are dial cue ids ONLY (theme options come later via C20)
// ---------------------------------------------------------------------------

describe('election options', () => {
  it('opens with the given dial-cue-id options and zeroed tallies', () => {
    const s = open(0);
    expect(s.phase).toBe('OPEN');
    expect(s.options).toEqual([...OPTIONS]);
    for (const o of OPTIONS) expect(s.tally[o]).toBe(0);
  });

  it('an unknown option (not in the ballot) is rejected — never counted', () => {
    let s = open(0);
    s = cast(s, 'tokA', 'not-a-real-dial', 1_000);
    expect(s.tally['not-a-real-dial']).toBeUndefined();
    // total votes still zero
    expect(Object.values(s.tally).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full cycle OPEN → TALLY → ENACT → COOLDOWN → re-open
// ---------------------------------------------------------------------------

describe('election full cycle', () => {
  it('OPEN → TALLY → ENACT → COOLDOWN with a clear winner', () => {
    let s = open(0);
    expect(s.phase).toBe('OPEN');

    // A quorum of distinct tokens vote — low-g wins 3–1.
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't2', 'low-g', 1_100);
    s = cast(s, 't3', 'low-g', 1_200);
    s = cast(s, 't4', 'gravity-flip', 1_300);

    // Reach the deadline → TALLY.
    s = tick(s, s.deadlineMs);
    expect(s.phase).toBe('TALLY');

    // TALLY resolves the winner → ENACT.
    s = step(s, { type: 'RESOLVE', nowMs: s.deadlineMs });
    expect(s.phase).toBe('ENACT');
    expect(s.winner).toBe('low-g');

    // ENACT is consumed → COOLDOWN.
    s = step(s, { type: 'ENACTED', nowMs: s.deadlineMs });
    expect(s.phase).toBe('COOLDOWN');
    expect(s.cooldownUntilMs).toBe(s.deadlineMs + ELECTION_COOLDOWN_MS);
  });

  it('COOLDOWN holds, then a fresh election opens after the cooldown', () => {
    let s = open(0);
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't2', 'low-g', 1_100);
    s = cast(s, 't3', 'low-g', 1_200);
    s = cast(s, 't4', 'low-g', 1_300);
    s = tick(s, s.deadlineMs);
    s = step(s, { type: 'RESOLVE', nowMs: s.deadlineMs });
    const enactAt = s.deadlineMs;
    s = step(s, { type: 'ENACTED', nowMs: enactAt });
    expect(s.phase).toBe('COOLDOWN');

    // A tick BEFORE the cooldown ends does nothing.
    s = tick(s, enactAt + ELECTION_COOLDOWN_MS - 1);
    expect(s.phase).toBe('COOLDOWN');

    // A tick AT/AFTER the cooldown re-opens a fresh election.
    s = tick(s, enactAt + ELECTION_COOLDOWN_MS);
    expect(s.phase).toBe('OPEN');
    // Tallies are fresh (zeroed) for the new election.
    for (const o of s.options) expect(s.tally[o]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TIE → RE-OPEN (never enact on a tie)
// ---------------------------------------------------------------------------

describe('tie handling', () => {
  it('a tie RE-OPENS the election (never enacts)', () => {
    let s = open(0);
    // 2–2 tie between low-g and gravity-flip.
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't2', 'low-g', 1_100);
    s = cast(s, 't3', 'gravity-flip', 1_200);
    s = cast(s, 't4', 'gravity-flip', 1_300);
    s = tick(s, s.deadlineMs);
    expect(s.phase).toBe('TALLY');
    s = step(s, { type: 'RESOLVE', nowMs: s.deadlineMs });
    // A tie must NOT enact — it re-opens.
    expect(s.phase).toBe('OPEN');
    expect(s.winner).toBeNull();
    // Fresh tallies for the re-run.
    for (const o of s.options) expect(s.tally[o]).toBe(0);
  });

  it('an election with zero votes at the deadline RE-OPENS (no winner)', () => {
    let s = open(0);
    s = tick(s, s.deadlineMs);
    s = step(s, { type: 'RESOLVE', nowMs: s.deadlineMs });
    expect(s.phase).toBe('OPEN');
    expect(s.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One SWITCHABLE vote per token
// ---------------------------------------------------------------------------

describe('one switchable vote per token', () => {
  it('a token voting twice for the SAME option counts once', () => {
    let s = open(0);
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't1', 'low-g', 1_500);
    expect(s.tally['low-g']).toBe(1);
    expect(s.voterCount).toBe(1);
  });

  it('a token may SWITCH its vote — the old option is decremented, the new incremented', () => {
    let s = open(0);
    s = cast(s, 't1', 'low-g', 1_000);
    expect(s.tally['low-g']).toBe(1);
    expect(s.tally['gravity-flip']).toBe(0);
    // Switch.
    s = cast(s, 't1', 'gravity-flip', 1_500);
    expect(s.tally['low-g']).toBe(0);
    expect(s.tally['gravity-flip']).toBe(1);
    // Still ONE voter (never double-counted).
    expect(s.voterCount).toBe(1);
  });

  it('distinct tokens each add one vote', () => {
    let s = open(0);
    s = cast(s, 'a', 'low-g', 1_000);
    s = cast(s, 'b', 'low-g', 1_050);
    s = cast(s, 'c', 'gravity-flip', 1_100);
    expect(s.tally['low-g']).toBe(2);
    expect(s.tally['gravity-flip']).toBe(1);
    expect(s.voterCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Adaptive deadline — SHORTENS under < 4 voters
// ---------------------------------------------------------------------------

describe('adaptive cadence', () => {
  it('opens at the MAX deadline (a full 45–90 s window)', () => {
    const s = open(0);
    const span = s.deadlineMs - s.openedAtMs;
    expect(span).toBe(ELECTION_MAX_DEADLINE_MS);
    expect(span).toBeGreaterThanOrEqual(45_000);
    expect(span).toBeLessThanOrEqual(90_000);
  });

  it('with FEWER than quorum voters the deadline SHORTENS toward the min', () => {
    // A thin crowd: only 2 voters (< ELECTION_QUORUM = 4). The deadline
    // shortens so a nearly-dead ballot resolves fast instead of stalling.
    let s = open(0);
    const fullDeadline = s.deadlineMs;
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't2', 'gravity-flip', 1_100);
    // The reducer recomputes the deadline on each cast from the live voter count.
    expect(s.deadlineMs).toBeLessThan(fullDeadline);
    expect(s.deadlineMs - s.openedAtMs).toBeGreaterThanOrEqual(ELECTION_MIN_DEADLINE_MS);
  });

  it('once the quorum is met the deadline is the FULL window (no shortening)', () => {
    let s = open(0);
    s = cast(s, 't1', 'low-g', 1_000);
    s = cast(s, 't2', 'low-g', 1_050);
    s = cast(s, 't3', 'low-g', 1_100);
    s = cast(s, 't4', 'low-g', 1_150); // == ELECTION_QUORUM
    expect(s.deadlineMs - s.openedAtMs).toBe(ELECTION_MAX_DEADLINE_MS);
    expect(s.voterCount).toBe(ELECTION_QUORUM);
  });

  it('the shortened deadline never falls below the min even with a single voter', () => {
    let s = open(0);
    s = cast(s, 'solo', 'low-g', 500);
    expect(s.deadlineMs - s.openedAtMs).toBeGreaterThanOrEqual(ELECTION_MIN_DEADLINE_MS);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same action sequence yields identical state', () => {
    const run = (): ElectionState => {
      let s = open(0);
      s = cast(s, 't1', 'low-g', 1_000);
      s = cast(s, 't2', 'gravity-flip', 1_100);
      s = cast(s, 't1', 'gravity-flip', 1_200); // switch
      s = tick(s, s.deadlineMs);
      return step(s, { type: 'RESOLVE', nowMs: s.deadlineMs });
    };
    expect(run()).toEqual(run());
  });

  it('a CAST after the deadline (in TALLY/closed) is ignored', () => {
    let s = open(0);
    s = cast(s, 't1', 'low-g', 1_000);
    s = tick(s, s.deadlineMs);
    expect(s.phase).toBe('TALLY');
    const before = s.tally['gravity-flip'];
    s = cast(s, 't2', 'gravity-flip', s.deadlineMs + 10);
    expect(s.tally['gravity-flip']).toBe(before);
  });
});
