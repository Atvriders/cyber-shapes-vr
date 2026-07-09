// ---------------------------------------------------------------------------
// Task C5 — Cue engine + RoomTimeline (PURE, shared).
//
// This is the orchestration spine every Phase C feature plugs into. It is 100%
// pure: no Three.js, no `ws`, no raw `setTimeout`/`Date.now` — every scheduled
// effect takes an injected TimerApi (spec §5.5 / Global Constraints). Tests drive
// it with fake timers; production wraps the global timers via `systemTimerApi`.
//
// Contracts (spec §5.5, §5.6, §6.4, plan C5 brief Interfaces):
//   • Phase / PHASE_DURATIONS_MS               — the show phases + their timings
//   • Cue                                       — the one abstraction every feature registers
//   • RoomHandle                                — the ONLY surface a cue handler receives
//                                                 (feature→RoomHandle, never sibling-to-sibling — FAQ #5)
//   • CueRegistry                               — register/unregister/catalog/fire
//   • RoomTimeline                              — the pure phase state machine
//   • PACING_TABLE + pickAmbientCue             — the auto-cue playlist data + selector
//
// The SERVER host that wires PHASE_STATE broadcast, the auto-cue playlist, and the
// RESET handler onto a live room lives in `packages/server/src/timeline.ts`.
// ---------------------------------------------------------------------------

import type { TimerApi, TimerHandle } from './timers.js';
import type { PlayerInfo } from './net/types.js';

// ---------------------------------------------------------------------------
// PhysicsParams + DEFAULT_PARAMS — SUPERSEDED by C6 (§5.6).
//
// C5 originally declared a forward-seed of these here. C6 landed the real,
// authoritative shape (with attractors/restitution/friction/restThreshold and
// the DIAL_BOUNDS/mergeParams/applyRadialImpulse helpers) in `physicsCore.ts`.
// We now re-export those so there is a SINGLE definition and `DEFAULT_PARAMS`
// is ONE frozen object (the RESET contract's `toBe(DEFAULT_PARAMS)` identity
// holds). RoomHandle's signature is unchanged — the C6 shape is a superset of
// the C5 seed, so every call site (`setBaseParams({gravity:{…}})`) still typechecks.
// ---------------------------------------------------------------------------
export { DEFAULT_PARAMS } from './physicsCore.js';
export type { PhysicsParams } from './physicsCore.js';
import type { PhysicsParams } from './physicsCore.js';

// ---------------------------------------------------------------------------
// Phase + PHASE_DURATIONS_MS (spec §5.5). RUN_OF_SHOW.md cites this constant BY
// NAME — do not rename or inline it.
// ---------------------------------------------------------------------------

/** The seven show phases. ATTRACT is indefinite; the other six are timed. */
export type Phase = 'ATTRACT' | 'LOBBY' | 'PLAY' | 'OVERLOAD' | 'FINALE' | 'STATS' | 'RESET';

/**
 * The exhaustive ordered phase ring the auto-advance walks. ATTRACT sits outside
 * the timed ring (it exits only on the first HUMAN resident join → LOBBY); once
 * in the ring, phases auto-advance LOBBY→PLAY→OVERLOAD→FINALE→STATS→RESET→ATTRACT.
 */
export const PHASE_ORDER: readonly Phase[] = [
  'ATTRACT',
  'LOBBY',
  'PLAY',
  'OVERLOAD',
  'FINALE',
  'STATS',
  'RESET',
] as const;

/**
 * Timed-phase durations in ms (spec §5.5). ATTRACT is absent because it is
 * INDEFINITE (exits via `advance()` on the first human resident join).
 * `RUN_OF_SHOW.md` cites this constant by name.
 */
export const PHASE_DURATIONS_MS = {
  LOBBY: 45_000,
  PLAY: 180_000,
  OVERLOAD: 30_000,
  FINALE: 90_000,
  STATS: 30_000,
  RESET: 10_000,
} as const satisfies Partial<Record<Phase, number>>;

/** Duration (ms) of a timed phase, or `null` for the indefinite ATTRACT. */
export function phaseDurationMs(phase: Phase): number | null {
  if (phase === 'ATTRACT') return null;
  return PHASE_DURATIONS_MS[phase];
}

/** The phase that follows `phase` in the auto-advance ring (RESET → ATTRACT). */
export function nextPhase(phase: Phase): Phase {
  const i = PHASE_ORDER.indexOf(phase);
  // RESET wraps to ATTRACT (start of a fresh rotation).
  return PHASE_ORDER[(i + 1) % PHASE_ORDER.length];
}

// ---------------------------------------------------------------------------
// PHASE_STATE — the 1 Hz heartbeat payload (spec §5.5 / OPCODES.PHASE_STATE 0x21).
// Clients extrapolate from remainingMs (drift-proof; no clock-offset dependence).
// ---------------------------------------------------------------------------

export interface PhaseState {
  phase: Phase;
  /** Absolute server time (ms) the current phase ends, or null for ATTRACT. */
  endsAt: number | null;
  /** ms until the current phase ends, or null for ATTRACT. Never negative. */
  remainingMs: number | null;
}

// ---------------------------------------------------------------------------
// PeerInfo — the roster entry a RoomHandle exposes.
//
// The brief's RoomHandle types `roster()`/`humanResidents()` as `PeerInfo[]`.
// The as-built shared presence type is `PlayerInfo` (net/types.ts). Until C28
// (§7.17, Daemon Crew) adds the `synthetic` flag to presence, PeerInfo is
// PlayerInfo + an OPTIONAL `synthetic?` marker; `humanResidents()` excludes
// synthetic peers. Identical to `roster()` filtered until C28 lands.
// ---------------------------------------------------------------------------

export interface PeerInfo extends PlayerInfo {
  /** True iff this is a synthetic (Daemon Crew) peer (§7.17, C28). Absent = human. */
  synthetic?: boolean;
}

/** True iff a roster entry represents a real human (not a §7.17 synthetic peer). */
export function isHumanPeer(p: PeerInfo): boolean {
  return p.synthetic !== true;
}

// ---------------------------------------------------------------------------
// A minimal store view the RoomHandle exposes. The as-built authoritative world
// is `serverWorld.ts::ServerWorld` (C0 binding 2); there is NO server-side
// "ShapeStore" class. RoomHandle.store is structurally typed to the subset of
// ServerWorld a cue handler legitimately touches — spawn/remove/get/pin/unpin +
// read the shape list. This keeps cues.ts PURE (no server import) while giving the
// server host a concrete ServerWorld to satisfy it.
// ---------------------------------------------------------------------------

/** A minimal spawn intent a cue hands the store (matches ServerWorld.spawn's init). */
export interface CueSpawnInit {
  type: string;
  position: { x: number; y: number; z: number };
  colorIndex?: number;
  renderMode?: string;
  scale?: number;
}

/** What `store.spawn` returns: the new shape id + any id evicted by the cap (§6.4). */
export interface CueSpawnResult {
  id: string;
  /** The id the maxShapes cap evicted to make room, or null. Caller broadcasts despawn. */
  evictedId: string | null;
}

/** A pinnable, spawnable view of the authoritative world (satisfied by ServerWorld). */
export interface ShapeStoreView {
  /**
   * Live shape list (read-only intent; do not mutate directly). Entries expose
   * `velocity` so a dial can measure ambient kinetic energy (BULLET-TIME's
   * pre-roll auto-launch fires only under a low-energy threshold — §7.3). Absent
   * velocity is treated as at-rest.
   */
  readonly shapes: ReadonlyArray<{
    id: string;
    grabbedBy: string | null;
    velocity?: { x: number; y: number; z: number };
  }>;
  /**
   * Spawn a shape into the authoritative world (§6.4). Returns the new id and any
   * id the maxShapes recycle-oldest cap evicted (never a grabbed/pinned body), or
   * `null` if the spawn was rejected (non-finite input). C10's `shape-rain` cue
   * spawns its burst through THIS — it never touches ServerWorld directly (FAQ #5).
   */
  spawn(init: CueSpawnInit): CueSpawnResult | null;
  /** Remove a shape by id (idempotent). Used by cue cleanup / eviction handling. */
  remove(id: string): void;
  /** Pin a shape so it is NEVER evicted by the maxShapes cap (§6.4). */
  pin(id: string): void;
  /** Un-pin a shape, re-exposing it to eviction (§6.4). */
  unpin(id: string): void;
}

// ---------------------------------------------------------------------------
// RoomHandle — the parameter every cue handler receives (spec §5.5, plan brief).
//
// feature → RoomHandle ONLY, never sibling-to-sibling (FAQ #5). `broadcast` and
// `store` are supplied by the SERVER host; `timeline` is the pure state machine.
// `tiers?` narrows a broadcast to a subset of connection tiers (default = all).
// ---------------------------------------------------------------------------

/**
 * Options a dial passes with its timed overlay (C11). `mode` is the human cue
 * label the ENV_STATE broadcast + stage banner render ("BULLET TIME ×0.25");
 * absent → the low-g/legacy path (mode falls back to the cue id at the host).
 */
export interface CueOverlayOpts {
  /** The ENV_STATE `mode` label (banner text source). */
  mode?: string;
}

export interface RoomHandle {
  /** The authoritative world view (pin/unpin/spawn/remove — §6.4 eviction). */
  store: ShapeStoreView;
  /** Write the STANDING law params (elections; persists until next election / REVERT). */
  setBaseParams(p: PhysicsParams): void;
  /**
   * Write a TIMED overlay that pops back to baseParams after `revertAfterMs`
   * (NEVER to DEFAULT_PARAMS — §5.6). The optional `opts.mode` is the ENV_STATE
   * banner label. Refused (no-op) while a showpiece/build-mode overlay is live
   * (the single-overlay-writer guard, §5.6/§7.16); the fire itself is gated at
   * the host BEFORE run via the cue's `writesOverlay` flag.
   */
  setCueOverlay(p: Partial<PhysicsParams>, revertAfterMs: number, opts?: CueOverlayOpts): void;
  /** Broadcast an opcode payload to the room (optionally narrowed to `tiers`). */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** The room's pure phase state machine. */
  timeline: RoomTimeline;
  /** Every peer in the room (all tiers). */
  roster(): PeerInfo[];
  /** Residents that are real humans — excludes §7.17 synthetic peers. */
  humanResidents(): PeerInfo[];
  /** Pin a shape so the maxShapes cap never evicts it (§6.4). */
  pin(shapeId: string): void;
  /** Un-pin a shape, re-exposing it to eviction (§6.4). */
  unpin(shapeId: string): void;
  /**
   * Schedule a follow-up stage of a compound cue after `delayMs`, driven by the
   * host's injected TimerApi (spec §5.5 purity — a cue NEVER touches raw
   * setTimeout/Date). TIME-FREEZE (burst → chaos → freeze) and SUPERNOVA
   * (pull → hold → detonate) script their stages through this. Returns a canceller
   * the host will also clear on RESET/dispose.
   */
  schedule(fn: () => void, delayMs: number): void;
  /**
   * Task C34 (F23 The Workshop, spec §7.23): TOGGLE build-mode. `on: undefined`
   * flips the current state; `on: true/false` forces it. Engaging build-mode
   * HOLDS the timeline (a composition session never rotates), SUSPENDS the auto-cue
   * playlist, applies the freeze overlay (revertAfterMs = BUILD_SESSION_MAX_MS,
   * re-fire extends), and claims the single overlay writer so ambient overlay cues
   * are refused. Re-firing WHILE ACTIVE toggles it OFF cleanly. The build-mode CUE
   * is the ONLY caller (a resident with the BUILD capability, gated at the wire);
   * a staff RESET also exits it (discarding unsaved edits). Absent on a host that
   * never landed the Workshop (cut-safe — the cue is simply never registered).
   */
  setBuildMode?(on?: boolean): void;
}

// ---------------------------------------------------------------------------
// Cue — the one abstraction every feature plugs into (spec §5.5).
// ---------------------------------------------------------------------------

export interface Cue {
  /** Stable cue id (dispatch key; also the CUE_CATALOG entry key). */
  id: string;
  /** Human-readable label rendered on the director console. */
  label: string;
  /** Which console tab surfaces this cue. */
  tab: 'show' | 'advanced';
  /** True iff the cue is destructive (RESET/purge) — the console warns. */
  destructive?: boolean;
  /** Minimum ms between two fires of THIS cue (per-cue cooldown). */
  cooldownMs: number;
  /** The phases in which this cue is allowed to fire. */
  phases: Phase[];
  /** Comfort budget cost (spec §6.3) — aggressive cues cost more. */
  comfortCost: number;
  /**
   * True iff this cue writes the timed `cueOverlay` (a Reality Dial). The
   * single-overlay-writer guard (§5.6/§7.16) refuses such a cue via the
   * `wrongPhase` path while a showpiece wave overlay — or the Workshop's
   * build-mode freeze (§7.23) — is already live. Absent = a non-overlay cue
   * (e.g. shape-rain, a pure spawn burst) that is never guarded.
   */
  writesOverlay?: boolean;
  /** The effect. Receives the RoomHandle; MUST NOT reach for a sibling feature. */
  run(room: RoomHandle): void;
}

/** The catalog entry re-broadcast to the director tier on registry change (§7.21). */
export interface CueCatalogEntry {
  id: string;
  label: string;
  tab: 'show' | 'advanced';
  destructive: boolean;
  cooldownMs: number;
  phases: Phase[];
  comfortCost: number;
}

/** `fire()` outcomes (spec §5.5 — consoles surface wrongPhase/cooldown as disabled). */
export type FireResult = 'ok' | 'cooldown' | 'deduped' | 'wrongPhase' | 'unknown';

// ---------------------------------------------------------------------------
// CueRegistry — register/unregister/catalog/fire (spec §5.5).
//
// `fire(id, cueInstanceId)` dedupes on the client-generated cueInstanceId (spec
// §5.5 "server dedupes"). Cooldown + phase gates are enforced here; the actual
// effect runs against the injected RoomHandle. An `onChange` hook lets the server
// host re-broadcast CUE_CATALOG on register/unregister (§7.21 capability-gating).
// PURE: time comes from the injected TimerApi (no raw Date.now).
// ---------------------------------------------------------------------------

export interface CueRegistryOpts {
  /** The room handle every fired cue receives. */
  room: RoomHandle;
  /** Injected timer — supplies `now()` for cooldown accounting. */
  timer: TimerApi;
  /** Fired on register/unregister so the host can re-broadcast CUE_CATALOG. */
  onChange?: (catalog: CueCatalogEntry[]) => void;
  /**
   * Max distinct cueInstanceIds remembered for dedupe (LRU-ish ring). Defaults to
   * 256 — plenty for a booth day; keeps memory bounded against a flood.
   */
  dedupeWindow?: number;
}

export class CueRegistry {
  private readonly _room: RoomHandle;
  private readonly _timer: TimerApi;
  private readonly _onChange?: (catalog: CueCatalogEntry[]) => void;
  private readonly _dedupeWindow: number;

  private readonly _cues = new Map<string, Cue>();
  /** cueId → last fire time (ms, from timer.now()). */
  private readonly _lastFiredAt = new Map<string, number>();
  /** Seen cueInstanceIds for dedupe, in insertion order (bounded ring). */
  private readonly _seenInstances = new Set<string>();

  constructor(opts: CueRegistryOpts) {
    this._room = opts.room;
    this._timer = opts.timer;
    this._onChange = opts.onChange;
    this._dedupeWindow = opts.dedupeWindow ?? 256;
  }

  /** Register (or replace) a cue. Fires onChange with the fresh catalog. */
  register(cue: Cue): void {
    this._cues.set(cue.id, cue);
    this._emitChange();
  }

  /** Unregister a cue by id (no-op if absent). Fires onChange when it removed one. */
  unregister(id: string): void {
    if (this._cues.delete(id)) {
      this._lastFiredAt.delete(id);
      this._emitChange();
    }
  }

  /** True iff a cue with this id is registered. */
  has(id: string): boolean {
    return this._cues.has(id);
  }

  /**
   * True iff `cueInstanceId` has already fired (a retried/duplicated packet). The
   * TimelineHost peeks this BEFORE its showpiece-overlay guard so a retried packet
   * echoes `deduped` (not `wrongPhase`) — the guard is a fresh-packet-only gate
   * (C11 CQ-1: without this peek a retried overlay dial flips deduped→wrongPhase).
   */
  hasSeenInstance(cueInstanceId: string): boolean {
    return this._seenInstances.has(cueInstanceId);
  }

  /**
   * True iff the registered cue writes the timed `cueOverlay` (a Reality Dial —
   * §5.6). The single-overlay-writer guard consults this to refuse an overlay dial
   * while a showpiece/build-mode overlay is live. Unknown id → false.
   */
  writesOverlay(id: string): boolean {
    return this._cues.get(id)?.writesOverlay === true;
  }

  /** The current CUE_CATALOG — one entry per registered cue (stable order). */
  catalog(): CueCatalogEntry[] {
    return [...this._cues.values()].map((c) => ({
      id: c.id,
      label: c.label,
      tab: c.tab,
      destructive: c.destructive === true,
      cooldownMs: c.cooldownMs,
      phases: [...c.phases],
      comfortCost: c.comfortCost,
    }));
  }

  /**
   * Fire a cue. Ordered gates (spec §5.5):
   *   1. unknown  — no such cue id.
   *   2. deduped  — this cueInstanceId already fired (idempotent re-send).
   *   3. wrongPhase — the current timeline phase is not in the cue's `phases`.
   *   4. cooldown — fired within `cooldownMs` of its last fire.
   *   5. ok       — runs the effect; records fire time + instance id.
   *
   * The dedupe check precedes phase/cooldown so a duplicated command is idempotent
   * regardless of gate state (a retried packet must never flip ok→wrongPhase).
   */
  fire(id: string, cueInstanceId: string): FireResult {
    const cue = this._cues.get(id);
    if (!cue) return 'unknown';

    if (this._seenInstances.has(cueInstanceId)) return 'deduped';

    const phase = this._room.timeline.phase;
    if (!cue.phases.includes(phase)) return 'wrongPhase';

    const now = this._timer.now();
    const last = this._lastFiredAt.get(id);
    if (last !== undefined && now - last < cue.cooldownMs) return 'cooldown';

    // Commit: record BEFORE run so a re-entrant fire from within run() dedupes.
    this._rememberInstance(cueInstanceId);
    this._lastFiredAt.set(id, now);
    cue.run(this._room);
    return 'ok';
  }

  /** ms remaining on a cue's cooldown at `now`, or 0 if ready/unknown. */
  cooldownRemainingMs(id: string): number {
    const cue = this._cues.get(id);
    if (!cue) return 0;
    const last = this._lastFiredAt.get(id);
    if (last === undefined) return 0;
    const rem = cue.cooldownMs - (this._timer.now() - last);
    return rem > 0 ? rem : 0;
  }

  private _rememberInstance(instanceId: string): void {
    this._seenInstances.add(instanceId);
    // Bound memory: evict the oldest seen instance once past the window.
    if (this._seenInstances.size > this._dedupeWindow) {
      const oldest = this._seenInstances.values().next().value;
      if (oldest !== undefined) this._seenInstances.delete(oldest);
    }
  }

  private _emitChange(): void {
    if (this._onChange) this._onChange(this.catalog());
  }
}

// ---------------------------------------------------------------------------
// RoomTimeline — the pure phase state machine (spec §5.5).
//
// ATTRACT is indefinite (exits via `advance()` on the first HUMAN resident join —
// synthetic joins never advance it, §7.17). Timed phases auto-advance on expiry
// via a single injected timer. `advance()` = manual/event override; `hold(ms)`
// extends the current timed phase. An active showpiece/encore/build-mode HOLDS
// phase advance until its END event, toggle-off, or a hard cap (`hold`/`holdUntil`).
//
// PURE: all time from the injected TimerApi (no raw setTimeout / Date.now).
// ---------------------------------------------------------------------------

export interface RoomTimelineOpts {
  /** Injected timer — schedules auto-advance + supplies now(). */
  timer: TimerApi;
  /** Starting phase (default ATTRACT). */
  initialPhase?: Phase;
  /**
   * Called AFTER every phase change with the fresh phase and its PhaseState. The
   * server host wires this to the PHASE_STATE broadcast + the auto-cue playlist.
   */
  onPhaseChange?: (phase: Phase, state: PhaseState) => void;
}

export class RoomTimeline {
  private readonly _timer: TimerApi;
  private readonly _onPhaseChange?: (phase: Phase, state: PhaseState) => void;

  private _phase: Phase;
  /** Absolute server time (ms) the current timed phase ends; null for ATTRACT/held. */
  private _endsAt: number | null = null;
  /** Pending auto-advance timer handle (null when ATTRACT or held). */
  private _timerHandle: TimerHandle | null = null;
  /**
   * Count of active "holds" (showpiece / encore / build-mode). While > 0 the
   * timeline never auto-advances; the current phase's remaining time is frozen
   * and restored when the last hold releases.
   */
  private _holdCount = 0;
  /** Remaining ms captured when a hold froze a timed phase (null if not frozen). */
  private _frozenRemainingMs: number | null = null;

  constructor(opts: RoomTimelineOpts) {
    this._timer = opts.timer;
    this._onPhaseChange = opts.onPhaseChange;
    this._phase = opts.initialPhase ?? 'ATTRACT';
    // Arm the initial phase's auto-advance (ATTRACT is indefinite → no timer).
    this._armCurrentPhase();
  }

  /** The current phase. */
  get phase(): Phase {
    return this._phase;
  }

  /** True iff at least one hold (showpiece/encore/build-mode) is active. */
  get isHeld(): boolean {
    return this._holdCount > 0;
  }

  /** The current PHASE_STATE snapshot (the 1 Hz heartbeat payload). */
  state(): PhaseState {
    if (this._phase === 'ATTRACT') {
      return { phase: 'ATTRACT', endsAt: null, remainingMs: null };
    }
    if (this._holdCount > 0) {
      // Held: report the frozen remaining; endsAt is indeterminate while held.
      return {
        phase: this._phase,
        endsAt: null,
        remainingMs: this._frozenRemainingMs,
      };
    }
    const endsAt = this._endsAt;
    const remainingMs = endsAt === null ? null : Math.max(0, endsAt - this._timer.now());
    return { phase: this._phase, endsAt, remainingMs };
  }

  /**
   * Manually advance to the next phase in the ring (event/staff override). From
   * ATTRACT this is the "first human resident join" exit → LOBBY. Ignored while
   * held (a showpiece/encore/build-mode holds phase advance until it releases).
   */
  advance(): void {
    if (this._holdCount > 0) return; // held — no advance until release
    this._enter(nextPhase(this._phase));
  }

  /** Jump directly to a specific phase (RESET handler / staff key). Not held-gated. */
  goTo(phase: Phase): void {
    this._enter(phase);
  }

  /**
   * Extend the current timed phase by `ms`. No-op on ATTRACT (already indefinite)
   * or while held (its remaining is frozen). Re-arms the auto-advance timer.
   */
  hold(ms: number): void {
    if (this._phase === 'ATTRACT' || this._endsAt === null) return;
    if (this._holdCount > 0) {
      if (this._frozenRemainingMs !== null) this._frozenRemainingMs += ms;
      return;
    }
    this._endsAt += ms;
    this._rearmTimer();
    this._emitChange();
  }

  /**
   * Acquire a showpiece/encore/build-mode HOLD: freezes phase advance until the
   * matching `releaseHold()`. Multiple holds nest (count); the last release
   * resumes the timed phase from where it froze. No-op semantics on ATTRACT
   * (ATTRACT has no auto-advance to freeze) but the count is still tracked so a
   * build-mode hold survives an ATTRACT→LOBBY advance triggered by a human join.
   */
  acquireHold(): void {
    this._holdCount++;
    if (this._holdCount === 1) {
      // First hold: freeze the current timed phase's remaining time.
      if (this._endsAt !== null) {
        this._frozenRemainingMs = Math.max(0, this._endsAt - this._timer.now());
      }
      this._clearTimer();
    }
  }

  /** Release one showpiece/encore/build-mode hold; the last release resumes timing. */
  releaseHold(): void {
    if (this._holdCount === 0) return;
    this._holdCount--;
    if (this._holdCount === 0) {
      // Last hold released: resume the timed phase from the frozen remaining.
      if (this._frozenRemainingMs !== null && this._phase !== 'ATTRACT') {
        this._endsAt = this._timer.now() + this._frozenRemainingMs;
        this._rearmTimer();
      }
      this._frozenRemainingMs = null;
      this._emitChange();
    }
  }

  /** Dispose: cancel any pending auto-advance timer (call on room teardown). */
  dispose(): void {
    this._clearTimer();
  }

  // --- internals -----------------------------------------------------------

  private _enter(phase: Phase): void {
    this._clearTimer();
    this._phase = phase;
    this._frozenRemainingMs = null;
    // A phase change does NOT clear active holds (a build-mode hold survives the
    // ATTRACT→LOBBY human-join advance, §7.23). If still held, keep the timer off.
    this._armCurrentPhase();
    this._emitChange();
  }

  /** Arm (or leave un-armed) the auto-advance timer for the current phase. */
  private _armCurrentPhase(): void {
    const dur = phaseDurationMs(this._phase);
    if (dur === null) {
      // ATTRACT — indefinite; no auto-advance.
      this._endsAt = null;
      return;
    }
    this._endsAt = this._timer.now() + dur;
    if (this._holdCount > 0) {
      // Entered a timed phase while held (e.g. build-mode held through join):
      // freeze immediately rather than arm a timer.
      this._frozenRemainingMs = dur;
      this._endsAt = null;
      return;
    }
    this._rearmTimer();
  }

  private _rearmTimer(): void {
    this._clearTimer();
    if (this._endsAt === null) return;
    const delay = Math.max(0, this._endsAt - this._timer.now());
    this._timerHandle = this._timer.setTimeout(() => {
      this._timerHandle = null;
      // Auto-advance to the next phase (never while held — we clear the timer on
      // acquireHold, so this only runs when unheld).
      this._enter(nextPhase(this._phase));
    }, delay);
  }

  private _clearTimer(): void {
    if (this._timerHandle !== null) {
      this._timer.clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
  }

  private _emitChange(): void {
    if (this._onPhaseChange) this._onPhaseChange(this._phase, this.state());
  }
}

// ---------------------------------------------------------------------------
// Pacing table + auto-cue selector (spec §5.5 "Auto-cue playlist" + §6.3 comfort).
//
// Data-driven so the auto-cue playlist never hard-codes cue ids. PLAY fires one
// ambient cue ≈ every 90 s (cooldowns + per-rotation comfortBudget; aggressive
// cues blocked during PLAY's first 60 s). ATTRACT = continuous ambient cueing at
// a shorter interval, COMFORT-FREE cues only, cooldown-aware rotation that
// tolerates a 2-cue catalog without stalling. Tier 6 cues never enter this table.
// ---------------------------------------------------------------------------

export interface PacingRow {
  /** Interval between auto-cue attempts in this phase (ms). */
  intervalMs: number;
  /**
   * Per-rotation comfort budget: the auto-cue playlist will not fire a cue whose
   * `comfortCost` would push the rotation's spent comfort over this. `Infinity`
   * effectively disables the budget for that phase. ATTRACT uses 0 (comfort-free
   * cues only — a comfortCost>0 cue is never auto-fired in ATTRACT).
   */
  comfortBudget: number;
  /**
   * ms into the phase before comfortCost>0 ("aggressive") cues may auto-fire.
   * PLAY = 60_000 (spec: aggressive cues blocked during PLAY's first 60 s).
   */
  aggressiveGraceMs: number;
}

/**
 * The auto-cue pacing table (spec §5.5). Only ATTRACT + PLAY auto-cue; every other
 * phase is either too short or is showpiece-owned (OVERLOAD/FINALE), so they carry
 * no ambient playlist row. `pickAmbientCue` treats an absent row as "no auto-cue".
 */
export const PACING_TABLE: Partial<Record<Phase, PacingRow>> = {
  // Continuous ambient cueing; comfort-free only (budget 0 blocks any cost>0 cue);
  // short interval so the idle-hours content engine never goes quiet. The
  // cooldown-aware rotation below tolerates a 2-cue catalog without stalling.
  ATTRACT: { intervalMs: 20_000, comfortBudget: 0, aggressiveGraceMs: 0 },
  // One ambient cue ≈ every 90 s; aggressive cues blocked for the first 60 s;
  // a per-rotation comfort budget caps cumulative discomfort.
  PLAY: { intervalMs: 90_000, comfortBudget: 6, aggressiveGraceMs: 60_000 },
};

/** Inputs the auto-cue selector needs at each tick of the pacing loop. */
export interface PickAmbientCtx {
  /** The phase we are pacing. */
  phase: Phase;
  /** ms elapsed since this phase began (gates the aggressive-cue grace window). */
  phaseElapsedMs: number;
  /** Comfort already spent this rotation (against the phase's comfortBudget). */
  comfortSpent: number;
  /** Registry to consult for cooldown readiness. */
  registry: CueRegistry;
  /** The full catalog to rotate through (typically registry.catalog()). */
  catalog: CueCatalogEntry[];
}

// ---------------------------------------------------------------------------
// STATS_CARD (spec §7.2 / OPCODES.STATS_CARD 0x2E). The STATS-phase payload the
// Showrunner broadcasts: rotation highlights + a day-leaderboard. CALLSIGNS ONLY
// — a raw name NEVER appears on this card (§6.1). The "NEXT IN THE HEADSET?"
// queue-bridge line is the crowd→headset handoff prompt (a plain string; never a
// name). Server-computed (C10) and rendered on the stage / phones.
// ---------------------------------------------------------------------------

/** A single leaderboard/highlight row — a callsign + a numeric stat, never a name. */
export interface StatsRow {
  /** The contributor's server-assigned callsign (NEVER a raw name). */
  callsign: string;
  /** The stat value (shapes thrown / speed / count — interpretation per row kind). */
  value: number;
}

export interface StatsCard {
  /** Total shapes thrown this rotation (a count; no identity). */
  shapesThrown: number;
  /** The fastest throw of the rotation (callsign + speed m/s), or null if none. */
  fastestThrow: StatsRow | null;
  /** The rotation's top contributor (callsign + count), or null if none. */
  topContributor: StatsRow | null;
  /** The persisted day leaderboard (callsigns only), highest first. May be empty. */
  dayLeaderboard: StatsRow[];
  /**
   * The "NEXT IN THE HEADSET?" crowd→headset queue-bridge line (spec §7.2). A plain
   * prompt string — NEVER a raw name (a callsign at most). Empty string = no bridge.
   */
  nextInHeadset: string;
}

// ---------------------------------------------------------------------------
// Director-console view model (spec §7.2). A PURE mapping from the advertised
// CUE_CATALOG + live phase + per-cue cooldown snapshot → the two-tab render model
// the console draws. This is the tested seam: the console DOM shell is thin, the
// SHOW/Advanced split + destructive-confirm + wrongPhase/cooldown DISABLED-state
// logic lives HERE so it can be unit-tested without a DOM. Both C10's console and
// any future surface (C22 desktop) render from the same model.
// ---------------------------------------------------------------------------

/** One rendered console row (a cue button's full render state). */
export interface ConsoleCueRow {
  id: string;
  label: string;
  /** True iff the cue is destructive → the console CONFIRMS before firing. */
  destructive: boolean;
  /** True iff the button is DISABLED right now (wrongPhase or cooldown). */
  disabled: boolean;
  /** Why it is disabled (renders as the disabled hint), or null when enabled. */
  disabledReason: 'wrongPhase' | 'cooldown' | null;
  /** ms of cooldown remaining (0 when off cooldown) — drives the countdown pill. */
  cooldownRemainingMs: number;
}

/** The full two-tab console model: SHOW (giant buttons) + ADVANCED (everything else). */
export interface ConsoleModel {
  show: ConsoleCueRow[];
  advanced: ConsoleCueRow[];
}

/**
 * Build the director-console render model from the advertised catalog + live
 * state. Ordered disabled logic (spec §5.5 fire gates surfaced as UI state):
 *   • wrongPhase — the current phase is not in the cue's `phases` → DISABLED.
 *   • cooldown   — a positive cooldownRemainingMs (from the snapshot) → DISABLED.
 * A cue can be both; wrongPhase wins the reason (a staffer can't fire it AT ALL in
 * this phase, cooldown or not). Destructive cues render enabled-but-confirming.
 *
 * PURE: `cooldownRemaining(id)` is injected (the console fills it from the server's
 * cooldown snapshot; a stateless phone re-derives it from PHASE_STATE + the last
 * catalog). No timer/DOM here.
 */
export function buildConsoleModel(
  catalog: CueCatalogEntry[],
  phase: Phase,
  cooldownRemaining: (id: string) => number
): ConsoleModel {
  const show: ConsoleCueRow[] = [];
  const advanced: ConsoleCueRow[] = [];
  for (const c of catalog) {
    const wrongPhase = !c.phases.includes(phase);
    const cdRem = Math.max(0, cooldownRemaining(c.id));
    const onCooldown = cdRem > 0;
    const disabled = wrongPhase || onCooldown;
    const disabledReason: 'wrongPhase' | 'cooldown' | null = wrongPhase
      ? 'wrongPhase'
      : onCooldown
        ? 'cooldown'
        : null;
    const row: ConsoleCueRow = {
      id: c.id,
      label: c.label,
      destructive: c.destructive === true,
      disabled,
      disabledReason,
      cooldownRemainingMs: cdRem,
    };
    (c.tab === 'show' ? show : advanced).push(row);
  }
  return { show, advanced };
}

/**
 * Pick the next ambient cue to auto-fire in `ctx.phase`, or `null` if none is
 * eligible right now. Selection rules (spec §5.5 pacing):
 *   • the phase must have a PACING_TABLE row (else null — no auto-cue).
 *   • the cue's `phases` must include the current phase.
 *   • the cue must be OFF cooldown (registry.cooldownRemainingMs === 0).
 *   • Tier 6 discipline: cues carrying comfortCost that would exceed the phase's
 *     comfortBudget are excluded (ATTRACT budget 0 ⇒ only comfortCost===0 cues).
 *   • aggressive (comfortCost>0) cues are excluded until aggressiveGraceMs into
 *     the phase (PLAY's first-60 s block).
 * Among eligible cues it prefers the one whose cooldown last expired LEAST recently
 * (round-robin fairness) — but the simplest tolerant rule that never stalls a tiny
 * catalog is "first eligible in catalog order", which we use: with a 2-cue catalog
 * and alternating cooldowns, one is always eligible, so ATTRACT never goes quiet.
 */
export function pickAmbientCue(ctx: PickAmbientCtx): CueCatalogEntry | null {
  const row = PACING_TABLE[ctx.phase];
  if (!row) return null;

  const aggressiveAllowed = ctx.phaseElapsedMs >= row.aggressiveGraceMs;

  for (const entry of ctx.catalog) {
    if (!entry.phases.includes(ctx.phase)) continue;
    // Comfort budget: a cost that would exceed the budget is ineligible.
    if (entry.comfortCost > 0) {
      if (!aggressiveAllowed) continue;
      if (ctx.comfortSpent + entry.comfortCost > row.comfortBudget) continue;
    }
    // Cooldown readiness.
    if (ctx.registry.cooldownRemainingMs(entry.id) > 0) continue;
    return entry;
  }
  return null;
}
