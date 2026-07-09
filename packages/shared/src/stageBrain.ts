// ---------------------------------------------------------------------------
// F1 Neon Director — the auto-director shot brain (spec §7.1, plan C9).
//
// PURE + DETERMINISTIC. No Date, no Math.random, no I/O, no THREE, no DOM. The
// brain's only clock is `update(dtMs)`; feeding the SAME RoomEvent sequence at
// the SAME virtual times always yields the SAME shot sequence (the determinism
// invariant, test-enforced). This module is shared so C22/C33's "StageBrain runs
// anywhere" desktop-AUTO camera consumes the identical rules (the message→
// RoomEvent adapter is extracted separately; this is the pure decision core).
//
// v1 ships EXACTLY 3 conservative hard-cut rules (spec §7.1):
//   • FOLLOW_THROW  — on a release-velocity spike (damped: speed ≥ heatThreshold)
//   • JOIN_CRANE    — on a join ceremony
//   • WIDE_ESTABLISH — the dead-air default (slow orbit + music-reactive + the
//                      enlarged join-QR CTA); never a close-up of a hesitant
//                      player, so this is what we fall back to on silence.
//
// The two invariants under test:
//   • MIN-SHOT: a shot holds ≥ `minShotMs` before ANY new cut (even under event
//     spam). A staff `force()` overrides the brain for a fixed hold; when it
//     expires the brain resumes with the min-shot window re-applied.
//   • HYSTERESIS: only an event that clears the min-shot gate re-cuts; ordinary
//     events (glyph/vote/impact/spawn/despawn/fame bumps) never force a cut off
//     the establishing default. (C26 later adds a `fame` tiebreak among
//     FOLLOW_THROW candidates; the cfg key is already `heatThreshold` so no
//     rename churn lands in this Tier ≤5 module — fame bumps are ordinary events
//     now.)
// ---------------------------------------------------------------------------

/**
 * The spectator event stream a stage client receives (C0 binding 14). This is a
 * NORMALIZED, brain-facing projection of the `ServerMsg` union residents/
 * spectators receive (welcome / player-join|leave / spawn / despawn / recolor /
 * rendermode / scale / grab(+pos,vel) / release(+pos,vel) / grab-rejected /
 * state / pose / voice-* / …). C9 defines `RoomEvent` FROM that binding; C13
 * (reel scorer), C21 (highlight scorer) and C26 (caster) consume THIS type.
 *
 * Only the fields the shot brain actually reads are modeled — a release carries
 * a scalar `speed` (the server-computed release velocity magnitude, m/s, from
 * accommodation #5's `{pos,vel}`), a join carries the joining `peerId`. Every
 * other kind is an ORDINARY event (it advances "last activity" but never forces
 * a cut on its own) so the union stays open to C13/C21/C26 additions without
 * changing the brain's v1 rules.
 */
export type RoomEvent =
  // A shape released with a server-computed velocity magnitude (the FOLLOW_THROW
  // trigger). `speed` is the |vel| in m/s (accommodation #5).
  | { kind: 'release'; id: string; peerId: string; speed: number }
  // A shape grabbed (ordinary — establishes "activity" but never cuts alone).
  | { kind: 'grab'; id: string; peerId: string }
  // A broadcastable grab-arbitration REJECTION (accommodation #4). Ordinary to
  // the v1 shot brain, but the C21 highlight scorer reads it to gate GRAB_DUEL
  // (a duel is eligible ONLY once GRAB_REJECTED exists, spec §7.11). `by` is the
  // peer that already held the shape (absent/null tolerated).
  | { kind: 'grab-rejected'; id: string; peerId: string; by: string | null }
  // A world shape spawned / despawned (ordinary).
  | { kind: 'spawn'; id: string }
  | { kind: 'despawn'; id: string }
  // A floor impact this tick (ordinary; carries the impact speed for scorers).
  | { kind: 'impact'; id: string; speed: number }
  // A join ceremony (the JOIN_CRANE trigger).
  | { kind: 'join'; peerId: string }
  // A player left (ordinary).
  | { kind: 'leave'; peerId: string }
  // A guestbook glyph birth / a crowd vote (ordinary here; C12/C15 ride
  // `requestShot` for their own framings — the brain treats them as activity).
  | { kind: 'glyph'; id: string }
  | { kind: 'vote'; peerId: string }
  // A fame bump (C26) — an ORDINARY input event to the v1 brain (no cut).
  | { kind: 'fame'; peerId: string; delta: number };

/**
 * The v1 shot kinds (spec §7.1) plus the external-cue framings that ride
 * `requestShot`: GLYPH_BIRTH (C12) and CRYSTAL_CAM (C16 — the Meteor Siege
 * built-in auto-framed crystal camera, §7.6). The brain only ever AUTO-cuts the
 * first three; the rest are forced by a feature via `requestShot`.
 */
export type ShotKind =
  | 'FOLLOW_THROW'
  | 'WIDE_ESTABLISH'
  | 'JOIN_CRANE'
  | 'GLYPH_BIRTH'
  | 'CRYSTAL_CAM'
  // C17 (F7 Titan Protocol, §7.7): the hardcoded low-angle worm's-eye framing the
  // titan cue forces via requestShot — the giant towers over the camera for "the
  // shot people post". requestShot-only (the brain never auto-cuts it).
  | 'WORM_EYE'
  // C32 (F21 Powers Lab, §7.21): a medium on the player + the pulled shape as it
  // tears across the room — the "NO CONTROLLERS — CAMERA-TRACKED HANDS" moment.
  // requestShot-only (the brain never auto-cuts it); the target is the TK player.
  | 'POWERS';

/**
 * A directed shot. `targetId` is the shape/peer the camera frames (absent for a
 * bare WIDE_ESTABLISH). `sinceMs` is how long THIS shot has been held — 0 on the
 * frame it was cut, growing by `dtMs` each `update`. Consumers read `sinceMs` to
 * drive shot-internal easing (crane descent, follow lead).
 */
export interface Shot {
  kind: ShotKind;
  targetId?: string;
  sinceMs: number;
}

/** Constructor config (spec §7.1). `heatThreshold` keeps the C26 fame name. */
export interface StageBrainCfg {
  /** Minimum ms a shot holds before ANY new cut (the min-shot invariant). */
  minShotMs: number;
  /**
   * Release |velocity| (m/s) at/above which a throw triggers FOLLOW_THROW (the
   * damped-velocity gate). C26's fame tiebreak keeps this exact cfg key.
   */
  heatThreshold: number;
}

/** Priority of a candidate cut — higher wins when two events arrive together. */
const CUT_PRIORITY: Record<'JOIN_CRANE' | 'FOLLOW_THROW', number> = {
  JOIN_CRANE: 2,
  FOLLOW_THROW: 1,
};

// ---------------------------------------------------------------------------
// C26 fame — a FOLLOW_THROW camera TIEBREAK only (spec §7.15). "Fame" is the
// renamed "heat"; the cfg key stays `heatThreshold` (no rename churn in this
// Tier ≤5 module). Fame is stage-local, rotation-scoped, and is ONLY consulted
// to order two SAME-FRAME FOLLOW_THROW candidates — it NEVER creates a cut,
// never outranks JOIN_CRANE, and never starves WIDE_ESTABLISH (the rule-priority
// order is unchanged; fame lives strictly inside the FOLLOW_THROW tie).
// ---------------------------------------------------------------------------

/** Max accumulated fame per resident (bounds the decay window). */
export const FAME_MAX = 100;

/** Fame fully decays within this window (spec §7.15 "decay ≤ 180 s"). */
export const FAME_DECAY_MS = 180_000;

/** Fame decay per ms (a maxed resident reaches 0 in exactly FAME_DECAY_MS). */
const FAME_DECAY_PER_MS = FAME_MAX / FAME_DECAY_MS;

/**
 * The fairness cap (spec §7.15): no single resident may own more than this share
 * of FOLLOW_THROW shot time per rotation. Over the cap, a resident's fame no
 * longer wins the tiebreak (others get airtime) — but the throw still cuts on its
 * own merits; fame only decides WHICH of two simultaneous throws is framed.
 */
export const FAME_SHOT_SHARE_CAP = 0.6;

/** Clamp a fame value to [0, FAME_MAX] (bounded so decay always reaches 0). */
function clampFame(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v > FAME_MAX ? FAME_MAX : v;
}

/**
 * The self-directing shot brain. Deterministic: identical `feed`/`update` call
 * sequences produce identical `Shot` outputs.
 */
export class StageBrain {
  private readonly minShotMs: number;
  private readonly heatThreshold: number;

  /** The current live shot (never null after construction). */
  private current: Shot;

  /** Virtual elapsed ms the current (non-forced) shot has been held. */
  private shotAgeMs = 0;

  /**
   * When a staff `force()` is active, its remaining hold in ms (> 0). While > 0
   * the brain is fully overridden and no fed event can cut. 0 = brain in control.
   */
  private forcedRemainingMs = 0;

  /**
   * The pending best candidate cut accumulated from `feed()` calls since the last
   * `update()`. Resolved (and cleared) at the next `update()` so cut decisions
   * are frame-quantized and deterministic. null = no cut-worthy event pending.
   * `peerId` (FOLLOW_THROW only) keys the C26 fame tiebreak + fairness cap.
   */
  private pending: {
    kind: 'JOIN_CRANE' | 'FOLLOW_THROW';
    targetId: string;
    peerId?: string;
  } | null = null;

  /** C26 fame per resident (peerId → fame). A FOLLOW_THROW tiebreak signal ONLY. */
  private readonly fame = new Map<string, number>();

  /** FOLLOW_THROW shot ms per resident this rotation (the fairness-cap numerator). */
  private readonly followShotMs = new Map<string, number>();

  /** Total FOLLOW_THROW shot ms this rotation (the fairness-cap denominator). */
  private totalFollowShotMs = 0;

  /** The peer framed by the current FOLLOW_THROW (for shot-time accounting). */
  private currentPeerId: string | undefined;

  constructor(cfg: StageBrainCfg) {
    this.minShotMs = cfg.minShotMs;
    this.heatThreshold = cfg.heatThreshold;
    // The dead-air default is where every session opens (spec §7.1).
    this.current = { kind: 'WIDE_ESTABLISH', sinceMs: 0 };
  }

  /**
   * Ingest one spectator RoomEvent. Only a velocity-spike release (FOLLOW_THROW)
   * or a join (JOIN_CRANE) is cut-worthy; everything else is ordinary activity
   * that never forces a cut. The best pending candidate is kept (JOIN_CRANE beats
   * a same-frame FOLLOW_THROW — a join ceremony wins the moment). Pure: no clock.
   */
  feed(e: RoomEvent): void {
    // A fame bump is an ORDINARY event to the shot rules (it never cuts, spec
    // §7.1/§7.15) — it only updates the fame map the FOLLOW_THROW tiebreak reads.
    if (e.kind === 'fame') {
      const prev = this.fame.get(e.peerId) ?? 0;
      this.fame.set(e.peerId, clampFame(prev + e.delta));
      return;
    }

    let cand: { kind: 'JOIN_CRANE' | 'FOLLOW_THROW'; targetId: string; peerId?: string } | null =
      null;
    if (e.kind === 'release' && e.speed >= this.heatThreshold) {
      cand = { kind: 'FOLLOW_THROW', targetId: e.id, peerId: e.peerId };
    } else if (e.kind === 'join') {
      cand = { kind: 'JOIN_CRANE', targetId: e.peerId };
    }
    if (!cand) return; // ordinary event — no pending cut
    if (this.pending === null) {
      this.pending = cand;
      return;
    }
    // Strictly-higher priority always wins (JOIN_CRANE > FOLLOW_THROW — the
    // rule-priority order is UNCHANGED; fame never lifts a throw over a join).
    if (CUT_PRIORITY[cand.kind] > CUT_PRIORITY[this.pending.kind]) {
      this.pending = cand;
      return;
    }
    // Same-priority FOLLOW_THROW tie: the C26 fame tiebreak. Higher effective
    // fame wins; a resident over the fairness share cap cannot win the tie (so no
    // one hogs > ~60 % of FOLLOW_THROW airtime). Ties keep the incumbent (first
    // wins) so the default — all fame 0 — is byte-identical to the v1 brain.
    if (
      cand.kind === 'FOLLOW_THROW' &&
      this.pending.kind === 'FOLLOW_THROW' &&
      this.effectiveFame(cand.peerId) > this.effectiveFame(this.pending.peerId)
    ) {
      this.pending = cand;
    }
  }

  /**
   * A resident's fame for the tiebreak, ZEROED once it owns more than the
   * fairness share cap of FOLLOW_THROW airtime this rotation — so a ringer can't
   * hog the camera (spec §7.15; the runbook halves the club ringer's fame). Pure.
   */
  private effectiveFame(peerId: string | undefined): number {
    if (peerId === undefined) return 0;
    if (this.totalFollowShotMs > 0) {
      const share = (this.followShotMs.get(peerId) ?? 0) / this.totalFollowShotMs;
      if (share > FAME_SHOT_SHARE_CAP) return 0;
    }
    return this.fame.get(peerId) ?? 0;
  }

  /** The current fame of a resident (for tests / the runbook ringer-halving). */
  fameOf(peerId: string): number {
    return this.fame.get(peerId) ?? 0;
  }

  /** A resident's share of FOLLOW_THROW airtime this rotation (0..1). */
  followShareOf(peerId: string): number {
    if (this.totalFollowShotMs <= 0) return 0;
    return (this.followShotMs.get(peerId) ?? 0) / this.totalFollowShotMs;
  }

  /**
   * Rotation boundary (spec §7.15 "cleared on RESET"): drop all fame + the
   * per-rotation FOLLOW_THROW airtime accounting. Cross-rotation continuity is
   * day-stats only (the caster host), never carried in the camera brain.
   */
  reset(): void {
    this.fame.clear();
    this.followShotMs.clear();
    this.totalFollowShotMs = 0;
    this.currentPeerId = undefined;
  }

  /**
   * Advance the virtual clock by `dtMs` and return the shot for this frame. This
   * is the ONLY time source — no Date. Resolution order each frame:
   *   1. A forced shot counts down; while active it wins outright (invariants
   *      resume when it expires).
   *   2. Otherwise, a pending cut is honored ONLY if the current shot has held
   *      ≥ minShotMs (the min-shot / hysteresis gate); else it is discarded (the
   *      spam is dropped, not queued — a stale target must not cut in late).
   *   3. Otherwise, a dead-air shot that has outlived its window falls back to
   *      WIDE_ESTABLISH.
   */
  update(dtMs: number): Shot {
    // C26 fame maintenance (spec §7.15): decay all fame toward 0 (fully within
    // FAME_DECAY_MS) and bill this frame's dt to the live FOLLOW_THROW's peer for
    // the fairness-share cap. Both are pure functions of the injected dt.
    this.decayFame(dtMs);
    if (this.current.kind === 'FOLLOW_THROW' && this.currentPeerId !== undefined) {
      this.followShotMs.set(
        this.currentPeerId,
        (this.followShotMs.get(this.currentPeerId) ?? 0) + dtMs
      );
      this.totalFollowShotMs += dtMs;
    }

    // (1) Forced-shot override.
    if (this.forcedRemainingMs > 0) {
      this.forcedRemainingMs -= dtMs;
      // A forced shot suppresses any pending brain cut for its whole hold.
      this.pending = null;
      if (this.forcedRemainingMs > 0) {
        this.current = { ...this.current, sinceMs: this.current.sinceMs + dtMs };
        return this.current;
      }
      // The hold just expired this frame: the forced shot's own window is over,
      // so the brain resumes able to cut immediately. A forced GLYPH_BIRTH (etc.)
      // is a directed shot, so on resume with no pending event we fall back to the
      // establishing default rather than freeze on the stale forced frame.
      this.forcedRemainingMs = 0;
      this.shotAgeMs = this.minShotMs;
    }

    this.shotAgeMs += dtMs;
    this.current = { ...this.current, sinceMs: this.current.sinceMs + dtMs };

    // The MIN-SHOT gate protects an ACTIVE directed shot (FOLLOW_THROW /
    // JOIN_CRANE / GLYPH_BIRTH) from being re-cut before minShotMs. The dead-air
    // WIDE_ESTABLISH default is the ABSENCE of a directed shot — it cedes to real
    // activity immediately (a throw at t=0 must not wait out the whole window).
    const isDirected = this.current.kind !== 'WIDE_ESTABLISH';
    const gateOpen = !isDirected || this.shotAgeMs >= this.minShotMs;

    // (2) Honor a pending cut once the gate is open.
    const pending = this.pending;
    this.pending = null;
    if (pending && gateOpen) {
      this.currentPeerId = pending.kind === 'FOLLOW_THROW' ? pending.peerId : undefined;
      this.cut(pending.kind, pending.targetId);
      return this.current;
    }

    // (3) Dead-air fallback: a directed shot that has run past its hold with
    // nothing new reverts to the establishing shot (never fame-starved — the
    // establishing default is unconditional, spec §7.15).
    if (isDirected && this.shotAgeMs >= this.minShotMs) {
      this.currentPeerId = undefined;
      this.cut('WIDE_ESTABLISH', undefined);
    }

    return this.current;
  }

  /** Decay every resident's fame toward 0 (fully within FAME_DECAY_MS). Pure. */
  private decayFame(dtMs: number): void {
    if (this.fame.size === 0) return;
    const drop = FAME_DECAY_PER_MS * dtMs;
    for (const [peer, value] of this.fame) {
      const next = value - drop;
      if (next <= 0) this.fame.delete(peer);
      else this.fame.set(peer, next);
    }
  }

  /**
   * Staff / external-cue override (spec §7.1). Forces `shot` to hold for `holdMs`
   * (the brain is suppressed for that whole window); when it elapses the brain
   * resumes with the min-shot invariant re-applied. C12/C16/C17/C32 ride this via
   * the client `stage.requestShot(shot, holdMs)` seam; hotkeys 1–9/0 call it too.
   */
  force(shot: Shot, holdMs: number): void {
    this.current = { ...shot, sinceMs: 0 };
    this.forcedRemainingMs = Math.max(0, holdMs);
    this.shotAgeMs = 0;
    this.pending = null;
    // A forced shot is staff/cue-driven, not fame-driven → not billed to fame.
    this.currentPeerId = undefined;
  }

  /** Internal: perform an immediate hard cut and reset the min-shot clock. */
  private cut(kind: ShotKind, targetId: string | undefined): void {
    this.current = { kind, targetId, sinceMs: 0 };
    this.shotAgeMs = 0;
  }
}

// ---------------------------------------------------------------------------
// Highlight scorer (C21 F11 Chrono Snap, spec §7.11 / §14) — the SHARED,
// SINGLE-SOURCE highlight vocabulary. PURE + DETERMINISTIC (no Date, no
// Math.random). It lives HERE, beside the shot brain, because both score the
// SAME `RoomEvent` stream — C21 extracts/reuses this surface (never a parallel
// implementation) and C26's caster consumes the reduced-signal-set subset (the
// exported {@link HighlightKind} + {@link scoreHighlight}).
//
// The vocabulary is grounded in REAL physics signals only (spec §7.11 — no
// stacks/pileups/shape-shape collisions exist):
//   • SLAM       — a top-decile floor slam (impactSpeed): the biggest impact in
//                  the window, and it must clear the top-decile bar over the
//                  window's OTHER impacts (so a window of equal small taps scores
//                  nothing standout).
//   • THROW      — a long-arc throw (release |velocity|): the fastest release.
//   • SHAPE_RAIN — a mass shape-rain burst (many spawns in the window).
//   • GRAB_DUEL  — a contested grab, scored ONLY when a `grab-rejected` signal is
//                  present in the window (the §7.11 gate: grab duels are eligible
//                  only once GRAB_REJECTED exists — accommodation #4).
//
// Below a min-activity floor the window scores NOTHING (returns null) — staff can
// never air 6 s of idle bobbing (the primary-hotkey min-activity threshold).
// ---------------------------------------------------------------------------

/** The physics-grounded highlight vocabulary (spec §7.11). */
export type HighlightKind = 'SLAM' | 'THROW' | 'SHAPE_RAIN' | 'GRAB_DUEL';

/** A scored highlight candidate: the winning kind, its focal entity, and its score. */
export interface Highlight {
  kind: HighlightKind;
  /** The shape/peer the replay camera should frame (absent for SHAPE_RAIN). */
  targetId?: string;
  /** The raw comparable score (higher = a better clip). Deterministic. */
  score: number;
}

/**
 * Scorer tuning. Every field has a conservative default so a bare
 * `scoreHighlight(events)` works; C26's reduced-signal-set subset overrides the
 * weights it cares about without forking the function.
 */
export interface HighlightScorerCfg {
  /** A release/impact this magnitude (m/s) is the floor for "worth airing". */
  minActivitySpeed?: number;
  /** ≥ this many spawns in the window is a shape-rain burst. */
  shapeRainMin?: number;
  /**
   * A SLAM must beat the window's median impact speed by at least this factor to
   * count as a top-decile standout (so a flat field of equal taps scores none).
   */
  slamStandoutFactor?: number;
}

/**
 * The shared highlight-scorer defaults. EXPORTED so C26's caster reuses the exact
 * significance floor (`minActivitySpeed` / `shapeRainMin`) — the "reduced signal
 * set" agreement (spec §7.15: caster and replay agree on what counts). A
 * shared-thresholds test asserts the caster reads THIS object, never a fork.
 */
export const DEFAULT_HIGHLIGHT_SCORER_CFG: Required<HighlightScorerCfg> = {
  minActivitySpeed: 6,
  shapeRainMin: 8,
  slamStandoutFactor: 1.5,
};

/** @deprecated internal alias kept for readability inside this module. */
const DEFAULT_SCORER_CFG = DEFAULT_HIGHLIGHT_SCORER_CFG;

/**
 * Score a window of {@link RoomEvent}s and return the single best highlight, or
 * `null` if the window is below the min-activity floor (idle → never aired).
 * PURE + DETERMINISTIC: the same window always yields the same winner (ties are
 * broken by a fixed kind priority, then by first occurrence).
 *
 * This is the ONE scorer — C21's replay module re-exports THIS symbol (import
 * identity, no duplicate); C26's caster reads the same reduced signal set.
 */
export function scoreHighlight(
  events: readonly RoomEvent[],
  cfg: HighlightScorerCfg = {}
): Highlight | null {
  const c = { ...DEFAULT_SCORER_CFG, ...cfg };

  // --- Gather the real signals. ---
  const impacts: Array<{ id: string; speed: number }> = [];
  const releases: Array<{ id: string; speed: number }> = [];
  let spawnCount = 0;
  let grabRejected: { id: string } | null = null;

  for (const e of events) {
    switch (e.kind) {
      case 'impact':
        impacts.push({ id: e.id, speed: e.speed });
        break;
      case 'release':
        releases.push({ id: e.id, speed: e.speed });
        break;
      case 'spawn':
        spawnCount += 1;
        break;
      case 'grab-rejected':
        if (!grabRejected) grabRejected = { id: e.id };
        break;
      default:
        // grab / join / leave / glyph / vote / fame / despawn — ordinary here.
        break;
    }
  }

  const candidates: Highlight[] = [];

  // --- SLAM: the biggest impact, if it clears the top-decile standout bar. ---
  if (impacts.length > 0) {
    const speeds = impacts.map((i) => i.speed).sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)];
    const top = impacts.reduce((m, i) => (i.speed > m.speed ? i : m), impacts[0]);
    const clearsFloor = top.speed >= c.minActivitySpeed;
    const standsOut = top.speed >= Math.max(c.minActivitySpeed, median * c.slamStandoutFactor);
    if (clearsFloor && standsOut) {
      candidates.push({ kind: 'SLAM', targetId: top.id, score: top.speed });
    }
  }

  // --- THROW: the fastest release above the activity floor (long arc). ---
  if (releases.length > 0) {
    const top = releases.reduce((m, r) => (r.speed > m.speed ? r : m), releases[0]);
    if (top.speed >= c.minActivitySpeed) {
      candidates.push({ kind: 'THROW', targetId: top.id, score: top.speed });
    }
  }

  // --- SHAPE_RAIN: a mass spawn burst (a whole window of new shapes). ---
  if (spawnCount >= c.shapeRainMin) {
    candidates.push({ kind: 'SHAPE_RAIN', score: spawnCount });
  }

  // --- GRAB_DUEL: contested grab — ONLY when a GRAB_REJECTED signal exists. ---
  if (grabRejected) {
    // A duel scores modestly (it is a beat, not a money-shot) but is eligible.
    candidates.push({ kind: 'GRAB_DUEL', targetId: grabRejected.id, score: c.minActivitySpeed });
  }

  if (candidates.length === 0) return null;

  // --- Deterministic winner: highest score; ties broken by a fixed kind rank. ---
  const rank: Record<HighlightKind, number> = { SLAM: 3, THROW: 2, SHAPE_RAIN: 1, GRAB_DUEL: 0 };
  candidates.sort((a, b) => b.score - a.score || rank[b.kind] - rank[a.kind]);
  return candidates[0];
}
