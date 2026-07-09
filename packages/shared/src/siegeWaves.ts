/**
 * siegeWaves.ts — Task C27 F16 Siege Waves (spec §7.16). The escalating wave arc
 * for the C16 Meteor Siege.
 *
 * THIS SIBLING MODULE IS THE REQUIREMENT (spec §7.16 / plan Tier 6): ALL
 * WAVE-specific data + logic (the wave table, the meteor-admission math, the
 * budget / bullet-time / Σ-duration invariants, the HP-advance partition) lives
 * HERE so that if "Tier 6 is cut" the delete of this file leaves NO residue in any
 * Tier ≤5 file — `siege.ts` (C16) gets only a minimal attach hook that imports
 * from here. Everything below is PURE data + pure functions (no Three/DOM/Date/
 * Math.random / server deps): the shared package can carry it, the client resolves
 * a wave's banner NAME from this table (so no wave strings ride the wire), and the
 * server drives the arc from it.
 *
 * The invariants this module encodes (all tested):
 *   • Budget (the math fix): every row satisfies
 *       rate × meteorRateMult × flightTime(timescale, gravity) ≤ METEOR_BUDGET
 *     against the REAL constant (METEOR_BUDGET = 12 — NOT the ~28 that some prose
 *     rounds to; 28 is BASELINE_MAX_SHAPES = MAX_SHAPES − METEOR_BUDGET). Retuning
 *     the table can never silently reintroduce mid-air despawn pops.
 *   • Bullet-time window: no overlay with timescale < 0.5 runs longer than 15 s.
 *   • Σ durations ≤ the 90 s siege window.
 */

import {
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  mergeParams,
  type PhysicsParams,
} from './physicsCore.js';
import {
  GRAVITY,
  METEOR_BUDGET,
  MET_LAUNCH_INTERVAL_MS,
  SIEGE_FULL_DURATION_MS,
} from './constants.js';

// ---------------------------------------------------------------------------
// WaveDef + the wave TABLE (spec §7.16).
// ---------------------------------------------------------------------------

/** One siege wave (spec §7.16). Every WAVE-specific knob lives in this shape. */
export interface WaveDef {
  /**
   * The 5-m-legible wave name for the full-screen SPLASH ("WAVE 3 — BULLET TIME").
   * Resolved CLIENT-SIDE from {@link SIEGE_WAVES} by index — NEVER sent on the wire
   * (SHOWPIECE_STATE carries only the numeric waveIndex; §7.16 "no names on the wire").
   */
  name: string;
  /** How long this wave runs (ms) before the TIMER advances to the next. */
  durationMs: number;
  /**
   * The SERVER-SIDE meteor-admission throttle. It gates ADMISSION only — the client
   * cooldown UI is untouched (zero funnel diffs); the crowd keeps firing at ≥ 1×
   * cadence and the server admits `meteorRateMult ×` the attempts. WAVE 3 cuts this
   * to ~0.3 so the ×4-flight-time (bullet-time) cloud stays inside the budget.
   */
  meteorRateMult: number;
  /**
   * The crystal-HP WEIGHT of this wave — it partitions the HP-advance thresholds
   * (a heavier wave absorbs more damage before it gives way; see
   * {@link waveHpAdvanceFraction}). Later waves are tougher → the arc escalates.
   */
  hpBonusMult: number;
  /**
   * The wave's ENV overlay (rides ENV_STATE for physics). Merged OVER `baseParams`
   * via the C11 two-layer `setCueOverlay` path and popped back to base between
   * waves — an elected law SURVIVES the whole siege (it is never clobbered).
   */
  dialOverlay?: Partial<PhysicsParams>;
  /**
   * The NOMINAL §6.3 comfort WEIGHT of this wave (a design annotation of the
   * escalating intensity: 0 → 1 → 2 across the arc). It is deliberately NOT booked
   * into the timeline's ambient `_comfortSpent` ledger: a siege is a §7.6 showpiece
   * host that lives OUTSIDE the ambient dial cue-registry (it never fires through
   * `RoomTimelineHost.fire`, which is the only path that debits `_comfortSpent`), so
   * showpieces are outside ambient comfort budgeting by design. The comfort SAFETY
   * of a wave is instead enforced by HARD runtime controls: the in-flight
   * {@link METEOR_BUDGET} = 12 cap ({@link admitMeteor}) and the 12 s < 15 s
   * bullet-time window ({@link wavesSatisfyBulletTimeCap}). This field remains as
   * the intent annotation the wave-table tests read for escalation.
   */
  comfortCost: number;
}

/** The active containment envelope every wave overlay carries (§5.6 — a dial/
 * showpiece overlay contains its shapes; the meteor swarm never flies off). */
const CONTAINMENT: Pick<PhysicsParams, 'bounds' | 'suspendDespawn'> = {
  bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
  suspendDespawn: true,
};

/** WAVE 3 slow-mo timescale (×0.25 — the marquee "BULLET TIME"; §7.16). */
export const SIEGE_WAVE_BULLET_TIMESCALE = 0.25;

/**
 * The escalating wave arc (spec §7.16). Tuned so EVERY row satisfies the budget
 * invariant against the REAL `METEOR_BUDGET = 12` (see {@link wavesSatisfyBudget}):
 *   WAVE 1 (×1.0) leaves the headroom the invariant forces; WAVE 2 tightens with a
 *   storm; WAVE 3 CUTS admission to ×0.30 while ×0.25 slow-mo makes meteors linger
 *   ×4 — the frozen cloud is dense because meteors LINGER, not because more launch.
 */
export const SIEGE_WAVES: readonly WaveDef[] = [
  {
    name: 'WAVE 1 — FIRST CONTACT',
    durationMs: 30_000,
    meteorRateMult: 1.0,
    hpBonusMult: 1.0,
    dialOverlay: { ...CONTAINMENT },
    comfortCost: 0,
  },
  {
    name: 'WAVE 2 — STORMFRONT',
    durationMs: 40_000,
    meteorRateMult: 0.65,
    hpBonusMult: 1.5,
    dialOverlay: { wind: { x: 6, y: 1, z: 4 }, ...CONTAINMENT },
    comfortCost: 1,
  },
  {
    name: 'WAVE 3 — BULLET TIME',
    durationMs: 12_000,
    meteorRateMult: 0.3,
    hpBonusMult: 2.0,
    dialOverlay: { timescale: SIEGE_WAVE_BULLET_TIMESCALE, ...CONTAINMENT },
    comfortCost: 2,
  },
] as const;

// ---------------------------------------------------------------------------
// The meteor-in-flight budget model (the math fix — spec §7.16).
// ---------------------------------------------------------------------------

/**
 * A meteor's nominal in-flight LIFETIME (s) at timescale 1 under default gravity:
 * a ~9.5 m arc from the launch ring to the pinned crystal at the ~7 m/s mean of
 * the §7.6 6–8 m/s speed band ≈ 1.2 s. This is the base the flight-time model
 * scales by timescale + gravity.
 */
export const SIEGE_METEOR_NOMINAL_FLIGHT_S = 1.2;

/** The default gravity magnitude (|GRAVITY|) — the flight-time gravity baseline. */
const DEFAULT_GRAVITY_MAG = Math.abs(GRAVITY);

/** The design-max sustained launcher count (spec §7.16 "24-launcher max rate"). */
export const SIEGE_MAX_LAUNCHERS = 24;

/**
 * The design-max sustained crowd launch rate (meteors/s): every launcher firing at
 * its 1-per-`MET_LAUNCH_INTERVAL_MS` cadence (24 / 3 s = 8/s). This is the `rate`
 * the budget invariant multiplies each row's `meteorRateMult` against.
 */
export const SIEGE_MAX_LAUNCH_RATE = SIEGE_MAX_LAUNCHERS / (MET_LAUNCH_INTERVAL_MS / 1000);

/**
 * A meteor's in-flight lifetime (s) under a wave's `timescale` + `gravityY`. Slower
 * timescale multiplies flight time (×4 at ts = 0.25 — the bullet-time linger that
 * DENSIFIES the cloud); weaker-than-default gravity floats meteors longer. The
 * gravity factor is clamped to ≥ 1 so the estimate is a CONSERVATIVE upper bound —
 * stronger gravity is never allowed to understate the in-flight count.
 */
export function meteorFlightTime(timescale: number, gravityY: number): number {
  const ts = timescale > 0 ? timescale : 1;
  const g = Math.abs(gravityY) > 1e-6 ? Math.abs(gravityY) : DEFAULT_GRAVITY_MAG;
  const gravFactor = Math.max(1, DEFAULT_GRAVITY_MAG / g);
  return (SIEGE_METEOR_NOMINAL_FLIGHT_S / ts) * gravFactor;
}

/**
 * The steady-state in-flight meteor estimate for a wave at the design-max crowd
 * rate: `rate × meteorRateMult × flightTime(timescale, gravity)`. The timescale +
 * gravity are read from the wave's overlay MERGED over DEFAULT_PARAMS (so an
 * overlay that only sets timescale still resolves the default gravity, exactly as
 * the running siege would with an elected law's containment).
 */
export function waveInFlightEstimate(wave: WaveDef): number {
  const params = mergeParams(DEFAULT_PARAMS, wave.dialOverlay);
  const ts = params.timescale ?? 1;
  const gy = params.gravity?.y ?? GRAVITY;
  return SIEGE_MAX_LAUNCH_RATE * wave.meteorRateMult * meteorFlightTime(ts, gy);
}

/**
 * THE BUDGET INVARIANT (spec §7.16 "the math fix"): every wave's steady-state
 * in-flight estimate stays ≤ the REAL `METEOR_BUDGET`. If a retune breaks this, the
 * table would silently reintroduce mid-air despawn pops — so the test over ALL rows
 * is the tripwire. Uses the real constant, never a rounded prose value.
 */
export function wavesSatisfyBudget(waves: readonly WaveDef[] = SIEGE_WAVES): boolean {
  return waves.every((w) => waveInFlightEstimate(w) <= METEOR_BUDGET + 1e-9);
}

// ---------------------------------------------------------------------------
// The deterministic ADMISSION throttle (server-side; client cooldown untouched).
// ---------------------------------------------------------------------------

/**
 * Decide whether to ADMIT one launch attempt under a wave's `meteorRateMult`,
 * threading a running `credit` accumulator (no Math.random — deterministic).
 * `credit + mult ≥ 1` admits and carries the fractional remainder forward, so a
 * mult of 1.0 always admits and a mult of 0.3 admits ~every 3rd attempt. This
 * throttles ADMISSION only — the client keeps firing on its own cooldown (zero
 * funnel diffs); the server silently drops the un-admitted attempts.
 */
export function admitMeteor(
  credit: number,
  meteorRateMult: number
): { admit: boolean; credit: number } {
  const next = credit + meteorRateMult;
  if (next >= 1) return { admit: true, credit: next - 1 };
  return { admit: false, credit: next };
}

// ---------------------------------------------------------------------------
// The bullet-time window cap (spec §7.16 — the FREEZE-cap precedent).
// ---------------------------------------------------------------------------

/** The bullet-time window HARD cap (ms): no sub-0.5-timescale overlay runs longer. */
export const SIEGE_BULLET_TIME_CAP_MS = 15_000;

/** The timescale at/below which an overlay counts as "bullet time" for the cap. */
export const SIEGE_BULLET_TIME_THRESHOLD = 0.5;

/**
 * THE BULLET-TIME INVARIANT (spec §7.16): no wave whose overlay drops the timescale
 * below {@link SIEGE_BULLET_TIME_THRESHOLD} may run longer than
 * {@link SIEGE_BULLET_TIME_CAP_MS} — the defender last-stand is bounded so slow-mo
 * never overstays its comfort welcome (consistent with the FREEZE 5–8 s cap).
 */
export function wavesSatisfyBulletTimeCap(waves: readonly WaveDef[] = SIEGE_WAVES): boolean {
  return waves.every((w) => {
    const ts = w.dialOverlay?.timescale ?? 1;
    return ts >= SIEGE_BULLET_TIME_THRESHOLD || w.durationMs <= SIEGE_BULLET_TIME_CAP_MS;
  });
}

// ---------------------------------------------------------------------------
// Σ durations + the HP-advance partition (spec §7.16).
// ---------------------------------------------------------------------------

/** The total wave-arc duration (ms). Invariant: ≤ {@link SIEGE_FULL_DURATION_MS}. */
export function totalWaveDurationMs(waves: readonly WaveDef[] = SIEGE_WAVES): number {
  return waves.reduce((sum, w) => sum + w.durationMs, 0);
}

/** THE Σ-DURATION INVARIANT: the wave arc fits inside the 90 s siege window. */
export function wavesFitSiegeWindow(waves: readonly WaveDef[] = SIEGE_WAVES): boolean {
  return totalWaveDurationMs(waves) <= SIEGE_FULL_DURATION_MS;
}

/**
 * The cumulative-damage FRACTION [0,1] at which wave `index` gives way to `index+1`,
 * partitioning the crystal HP by the waves' `hpBonusMult` weights (a heavier wave
 * absorbs more damage). The last wave's fraction is 1 (crystal destroyed →
 * CROWD_WINS, not an advance). The siege advances a wave when the crowd's cumulative
 * damage crosses this — and because the TIMER is the max duration, an HP cross can
 * only ever fire EARLIER → it SHORTENS a wave, never extends it (§7.16).
 */
export function waveHpAdvanceFraction(
  index: number,
  waves: readonly WaveDef[] = SIEGE_WAVES
): number {
  const total = waves.reduce((s, w) => s + w.hpBonusMult, 0) || 1;
  let acc = 0;
  for (let i = 0; i <= index && i < waves.length; i++) acc += waves[i].hpBonusMult;
  return Math.min(1, acc / total);
}
