/**
 * env.ts — ENV_STATE (F3 Reality Dials, spec §7.3 / OPCODES.ENV_STATE 0x23) +
 * the stage cue-banner text derivation. PURE (no Three/DOM/Date/Math.random).
 *
 * ENV_STATE is the broadcast every dial fires: it carries the EFFECTIVE physics
 * params the world is stepping under, a human `mode` label the big-screen cue
 * banner renders, and the auto-revert deadline (`endsAt`) so a LATE JOINER lands
 * mid-dial with a coherent countdown (spec §7.3: "endsAt = late-join coherent
 * auto-revert"). `serverTimestamp` lets the stage schedule a sting against the
 * interpolated timeline (spec §7.3).
 *
 * The banner text is derived HERE (a pure fn) so both the stage overlay and any
 * future surface render an identical "BULLET TIME ×0.25" line from one ENV_STATE.
 */

import type { PhysicsParams } from './physicsCore.js';

/**
 * ENV_STATE {serverTimestamp, mode, params, endsAt} (spec §7.3 / §5.2 row 0x23).
 * Broadcast on every overlay change (set AND revert) + included in the late-join
 * snapshot. When no dial is active, `mode` is null and `params` is the current
 * base (usually DEFAULT_PARAMS) with `endsAt` null (nothing to auto-revert).
 */
export interface EnvState {
  /** Absolute server time (ms since roomEpoch) this state was stamped (sting sync). */
  serverTimestamp: number;
  /** The human cue label the big-screen banner renders, or null when no dial is live. */
  mode: string | null;
  /** The EFFECTIVE PhysicsParams the sim is stepping under right now. */
  params: PhysicsParams;
  /** Absolute server time (ms) the active dial auto-reverts, or null (no active dial). */
  endsAt: number | null;
}

/**
 * The stage cue-banner text for an ENV_STATE (spec §7.3 "BULLET TIME ×0.25" +
 * progress bar). Returns '' when no dial is live (mode null) so the caller
 * CLEARS the banner slot (the §7.1 slot contention re-resolves). The banner text
 * is just the `mode` label — the PROGRESS BAR is driven separately from
 * `endsAt`/`serverTimestamp` (see {@link envProgress}); a banner never bakes a
 * number that would go stale between heartbeats.
 */
export function cueBannerText(env: EnvState | null): string {
  if (!env || env.mode === null || env.mode === '') return '';
  return env.mode;
}

/**
 * The dial progress in [0,1] at wall-clock `nowMs` (ms since roomEpoch): 0 at the
 * moment it fired (`serverTimestamp`), 1 at `endsAt`. Returns 0 when there is no
 * active dial (endsAt null) or the window is degenerate. Clamped — a late frame
 * past `endsAt` reads 1, never overshoots (the auto-revert clears the banner).
 */
export function envProgress(env: EnvState | null, nowMs: number): number {
  if (!env || env.endsAt === null) return 0;
  const span = env.endsAt - env.serverTimestamp;
  if (span <= 0) return 1;
  const elapsed = nowMs - env.serverTimestamp;
  if (elapsed <= 0) return 0;
  if (elapsed >= span) return 1;
  return elapsed / span;
}
