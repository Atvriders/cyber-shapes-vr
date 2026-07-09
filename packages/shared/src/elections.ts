/**
 * elections.ts — the F5 Reality Referendum election reducer (C15, spec §7.5).
 *
 * PURE + DETERMINISTIC: no Date, no Math.random, no I/O. The reducer takes the
 * current {@link ElectionState} + an {@link ElectionAction} (each carrying an
 * explicit `nowMs` from the host's injected timer) and returns the next state.
 * The same action sequence at the same virtual times yields the SAME state,
 * every run (asserted in elections.test.ts).
 *
 * The lifecycle (spec §7.5): OPEN → TALLY → ENACT → COOLDOWN, then a fresh
 * OPEN when the cooldown elapses. A TIE (or a no-vote election) RE-OPENS instead
 * of enacting — the crowd never gets an arbitrary law it did not choose.
 *
 * OPTIONS ARE DIAL CUE IDS ONLY. Theme options are registered later by C20
 * (§7.5 "options reference dial cue ids; theme options are registered by C20").
 * The `options` array is the extension point — a caller passes whatever ids the
 * ballot should carry; the reducer never invents or filters them beyond the
 * "cast must name a listed option" guard. Theme elections are ordinary elections
 * enacted as THEME_SET at the host — there is NO second vote path in here.
 *
 * ADAPTIVE CADENCE (spec §7.5: "45–90 s under traffic"): the OPEN window is the
 * MAX (90 s) once a quorum is voting; under a THIN crowd (< quorum voters) the
 * deadline SHORTENS toward the MIN (45 s) so a nearly-dead ballot resolves fast
 * instead of stalling. The deadline is recomputed from the live voter count on
 * every cast (never lengthened below the elapsed time — it only ever tightens).
 *
 * ONE SWITCHABLE VOTE PER TOKEN: votes are keyed on an opaque `token` (a device
 * token on phone ballots, a peerId on residents — §5.9). A token voting again
 * REPLACES its prior choice (decrement old, increment new); it never
 * double-counts. `voterCount` is the number of distinct tokens.
 */

// ---------------------------------------------------------------------------
// Tunables (spec §7.5 "45–90 s"). Named exports so tests + the host share them.
// ---------------------------------------------------------------------------

/** The FULL OPEN window under traffic (spec §7.5 upper bound). */
export const ELECTION_MAX_DEADLINE_MS = 90_000;
/** The SHORTENED window a thin crowd resolves within (spec §7.5 lower bound). */
export const ELECTION_MIN_DEADLINE_MS = 45_000;
/**
 * The voter count at/above which the FULL window applies. Below it the deadline
 * shortens linearly toward the min (spec §7.5 "deadline auto-shortens < 4
 * voters"). Four voters == a live ballot.
 */
export const ELECTION_QUORUM = 4;
/** The gap between a law enacting and the next election opening (spec §7.5). */
export const ELECTION_COOLDOWN_MS = 20_000;

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

/** The four reducer phases (spec §7.5). */
export type ElectionPhase = 'OPEN' | 'TALLY' | 'ENACT' | 'COOLDOWN';

/** The election state. Plain data — safe to broadcast + snapshot. */
export interface ElectionState {
  /** Current lifecycle phase (spec §7.5). */
  phase: ElectionPhase;
  /** The ballot options (dial cue ids ONLY; theme ids appended by C20). */
  options: string[];
  /** option id → vote count. Keys are exactly `options`. */
  tally: Record<string, number>;
  /** token → the option it currently backs (for switchable, one-per-token votes). */
  votes: Record<string, string>;
  /** Number of distinct tokens that have voted this election. */
  voterCount: number;
  /** Wall-clock (ms) this OPEN window started (deadline is relative to this). */
  openedAtMs: number;
  /** Wall-clock (ms) the OPEN window closes → TALLY (adaptive; recomputed on cast). */
  deadlineMs: number;
  /** The resolved winner (set in ENACT), or null while OPEN/TALLY/tie. */
  winner: string | null;
  /** Wall-clock (ms) the COOLDOWN ends → a fresh election opens. Null unless COOLDOWN. */
  cooldownUntilMs: number | null;
}

/** Actions the host drives through the reducer (each carries `nowMs`). */
export type ElectionAction =
  /** A token casts (or switches) a vote for `option`. */
  | { type: 'CAST'; token: string; option: string; nowMs: number }
  /** The host's clock advanced — close on deadline / re-open after cooldown. */
  | { type: 'TICK'; nowMs: number }
  /** Resolve the TALLY into a winner (→ ENACT) or re-open on a tie / no votes. */
  | { type: 'RESOLVE'; nowMs: number }
  /** The host applied the ENACT winner (wrote baseParams) → COOLDOWN. */
  | { type: 'ENACTED'; nowMs: number };

// ---------------------------------------------------------------------------
// openElection — the fresh-OPEN factory (also used for re-open / post-cooldown).
// ---------------------------------------------------------------------------

/** Options for {@link openElection}. */
export interface OpenElectionOpts {
  /** The ballot options — DIAL CUE IDS ONLY (theme ids appended by C20). */
  options: string[];
  /** Wall-clock (ms) the window opens. */
  nowMs: number;
}

/**
 * Open a fresh election at `nowMs` with zeroed tallies. The deadline starts at
 * the FULL window (no voters yet → it will shorten on the first casts if the
 * crowd stays thin). Options are the caller's list verbatim (dial ids; C20 adds
 * theme ids the same way).
 */
export function openElection(opts: OpenElectionOpts): ElectionState {
  const options = [...opts.options];
  const tally: Record<string, number> = {};
  for (const o of options) tally[o] = 0;
  return {
    phase: 'OPEN',
    options,
    tally,
    votes: {},
    voterCount: 0,
    openedAtMs: opts.nowMs,
    // No voters yet → the full window; recomputed downward on each cast.
    deadlineMs: opts.nowMs + ELECTION_MAX_DEADLINE_MS,
    winner: null,
    cooldownUntilMs: null,
  };
}

// ---------------------------------------------------------------------------
// Adaptive deadline (spec §7.5) — SHORTENS under < quorum voters.
// ---------------------------------------------------------------------------

/**
 * The window length (ms) for a given voter count: MAX at/above the quorum,
 * shortening LINEARLY toward MIN as the crowd thins (never below MIN). Pure.
 *
 *   voters >= QUORUM        → MAX
 *   voters == 0             → MIN
 *   0 < voters < QUORUM     → MIN + (MAX-MIN) * voters/QUORUM
 */
export function electionWindowMs(voterCount: number): number {
  if (voterCount >= ELECTION_QUORUM) return ELECTION_MAX_DEADLINE_MS;
  const v = voterCount < 0 ? 0 : voterCount;
  const span = ELECTION_MAX_DEADLINE_MS - ELECTION_MIN_DEADLINE_MS;
  return ELECTION_MIN_DEADLINE_MS + Math.round((span * v) / ELECTION_QUORUM);
}

// ---------------------------------------------------------------------------
// The reducer.
// ---------------------------------------------------------------------------

/** Pure election state transition. Never mutates `state`. */
export function electionReducer(state: ElectionState, action: ElectionAction): ElectionState {
  switch (action.type) {
    case 'CAST':
      return applyCast(state, action.token, action.option);
    case 'TICK':
      return applyTick(state, action.nowMs);
    case 'RESOLVE':
      return applyResolve(state, action.nowMs);
    case 'ENACTED':
      return applyEnacted(state, action.nowMs);
    default:
      return state;
  }
}

/**
 * Cast (or switch) a vote. Only meaningful while OPEN and the named option exists.
 * The action's `nowMs` is not needed here (the deadline is anchored to
 * `openedAtMs`, not the cast time) — the adaptive recompute is purely a function
 * of the voter count.
 */
function applyCast(state: ElectionState, token: string, option: string): ElectionState {
  // Votes only count while OPEN (a cast in TALLY/ENACT/COOLDOWN is ignored — the
  // window has closed). Unknown options are rejected (never counted).
  if (state.phase !== 'OPEN') return state;
  if (!Object.prototype.hasOwnProperty.call(state.tally, option)) return state;

  const prior = state.votes[token];
  // No-op: same token re-affirming the same option → identical state.
  if (prior === option) return state;

  const tally = { ...state.tally };
  const votes = { ...state.votes };
  let voterCount = state.voterCount;

  if (prior !== undefined) {
    // SWITCH: decrement the prior option (it is a listed option since it was
    // recorded through this same guard). Voter count unchanged.
    tally[prior] = Math.max(0, (tally[prior] ?? 0) - 1);
  } else {
    // A brand-new voter.
    voterCount += 1;
  }
  votes[token] = option;
  tally[option] = (tally[option] ?? 0) + 1;

  // Recompute the adaptive deadline from the NEW voter count. It only ever
  // TIGHTENS (a thin crowd resolves faster); it is never pushed earlier than the
  // already-elapsed time would allow, and never lengthened past the max window.
  const deadlineMs = state.openedAtMs + electionWindowMs(voterCount);

  return { ...state, tally, votes, voterCount, deadlineMs };
}

/** Advance the clock: OPEN→TALLY on deadline; COOLDOWN→OPEN after the cooldown. */
function applyTick(state: ElectionState, nowMs: number): ElectionState {
  if (state.phase === 'OPEN' && nowMs >= state.deadlineMs) {
    return { ...state, phase: 'TALLY' };
  }
  if (
    state.phase === 'COOLDOWN' &&
    state.cooldownUntilMs !== null &&
    nowMs >= state.cooldownUntilMs
  ) {
    // Re-open a fresh election with the SAME options (dial ids; C20 may have
    // widened `options` by re-opening with a new list at the host).
    return openElection({ options: state.options, nowMs });
  }
  return state;
}

/**
 * Resolve the TALLY. A UNIQUE plurality winner → ENACT. A TIE (two options level
 * at the top) or ZERO votes → RE-OPEN (spec §7.5 — never enact a law the crowd
 * did not choose).
 */
function applyResolve(state: ElectionState, nowMs: number): ElectionState {
  if (state.phase !== 'TALLY') return state;

  let top = -1;
  let topCount = 0;
  let winner: string | null = null;
  // Deterministic scan in the fixed `options` order (no Math.random). A later
  // option only wins by STRICTLY exceeding the running top; equal counts flag a
  // tie (topCount > 1) which re-opens.
  for (const o of state.options) {
    const c = state.tally[o] ?? 0;
    if (c > top) {
      top = c;
      topCount = 1;
      winner = o;
    } else if (c === top) {
      topCount += 1;
    }
  }

  // No votes at all (top === 0) OR a tie at the top → RE-OPEN, no winner.
  if (top <= 0 || topCount > 1) {
    return openElection({ options: state.options, nowMs });
  }

  return { ...state, phase: 'ENACT', winner };
}

/** The host applied the ENACT winner → enter COOLDOWN. */
function applyEnacted(state: ElectionState, nowMs: number): ElectionState {
  if (state.phase !== 'ENACT') return state;
  return {
    ...state,
    phase: 'COOLDOWN',
    cooldownUntilMs: nowMs + ELECTION_COOLDOWN_MS,
  };
}
