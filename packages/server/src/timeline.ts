/**
 * timeline.ts — Task C5 SERVER host for the cue engine + RoomTimeline.
 *
 * This wires the PURE `packages/shared/src/cues.ts` primitives (RoomTimeline,
 * CueRegistry, the pacing table) onto a live room: it builds the `RoomHandle`
 * every cue handler receives from a `ServerWorld` + injected broadcast/metrics,
 * broadcasts `PHASE_STATE` (via OPCODES.PHASE_STATE) at 1 Hz + on every phase
 * change, runs the auto-cue playlist per PACING_TABLE, and owns the RESET handler.
 *
 * PURITY: no raw setTimeout / Date.now — everything via the injected `TimerApi`
 * (spec §5.5 / Global Constraints). The connection/index layer wires the real
 * broadcast + system timer at the composition root (C9/C10 attach the director
 * console + hotkeys); C5 delivers + unit-tests the host.
 */

import {
  OPCODES,
  VOTE_KIND,
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  mergeParams,
  SHOWROOM_BASELINE,
  BUILD_SESSION_MAX_MS,
  RoomTimeline,
  CueRegistry,
  PACING_TABLE,
  pickAmbientCue,
  electionReducer,
  openElection,
  ELECTION_COOLDOWN_MS,
  scheduleAt,
  isTheme,
  themeIdFromOption,
  DEFAULT_THEME_ID,
  THEME_TRANSITION_MAX_LEAD_MS,
  THEME_MINI_GLITCH_MS,
  type ElectionState,
  type TimerApi,
  type TimerHandle,
  type Phase,
  type PhaseState,
  type RoomHandle,
  type PhysicsParams,
  type PeerInfo,
  type CueCatalogEntry,
  type FireResult,
  type ShowroomSeed,
  type NetShape,
  type StatsCard,
  type CueOverlayOpts,
  type EnvState,
} from '@cyber-shapes/shared';
import { ServerWorld } from './serverWorld.js';

/** PHASE_STATE heartbeat cadence (spec §5.5: 1 Hz + on change). */
export const PHASE_STATE_HEARTBEAT_MS = 1_000;

/**
 * The shared audience-union tier set: director + resident-class (spectator
 * included). All state-sync opcodes (PHASE_STATE, ENV_STATE, THEME_SET) fan out
 * to these tiers. C25 appends `'audience'` at ONE site here so the extension
 * is a single edit that covers all three — that is the C25 audience-tier HOOK.
 */
export const STATE_BROADCAST_TIERS: readonly string[] = ['director', 'resident', 'spectator'];

/**
 * The tiers PHASE_STATE fans out to (spec §5.1: director + residents). Residents
 * AND spectators share the resident-class `full` receive set, so both are named.
 * C25 appends `'audience'` to STATE_BROADCAST_TIERS (the §5.1 audience union
 * includes PHASE_STATE) — that hook lives in STATE_BROADCAST_TIERS above, NOT
 * narrowed to director.
 */
export const PHASE_STATE_TIERS: readonly string[] = STATE_BROADCAST_TIERS as string[];

/**
 * The tiers ENV_STATE fans out to (spec §5.1 audience union: resident-class +
 * director). C25 appends `'audience'` via STATE_BROADCAST_TIERS (the §5.1
 * audience union includes ENV_STATE) — the hook is NOT narrowed.
 */
export const ENV_STATE_TIERS: readonly string[] = STATE_BROADCAST_TIERS as string[];

/** How a cue instruction is broadcast/metered — supplied by the connection layer. */
export interface RoomTimelineHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /** The authoritative world this room drives (C0 binding 2). */
  world: ServerWorld;
  /**
   * Broadcast an opcode payload to the room. The connection layer maps this to
   * per-tier fan-out (director gets PHASE_STATE + CUE_CATALOG; §5.1). `tiers`
   * narrows the audience; absent = the opcode's default audience.
   */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** Current room roster (all tiers). Supplied by the connection layer. */
  roster(): PeerInfo[];
  /** Increment a named day-stats counter (spec §5.5 RESET → metrics.count('rotation')). */
  metricsCount?(key: string): void;
  /** Write the standing law params (C11 completes the two-layer state). */
  setBaseParams?(p: PhysicsParams): void;
  /** Write a timed overlay that pops back to baseParams (C10/C11). */
  setCueOverlay?(p: Partial<PhysicsParams>, revertAfterMs: number): void;
  /**
   * The showroom baseline the RESET handler restores. Defaults to the v1 shared
   * SHOWROOM_BASELINE seed list; C34 (Workshop) passes the named-baseline layout
   * with THIS as the fallback (spec §7.23) — C5 never depends on the Workshop.
   */
  showroomBaseline?: readonly ShowroomSeed[];
  /**
   * Called by the RESET handler with the world it just rebuilt: the ids it
   * despawned and the fresh baseline shapes it spawned. The connection layer
   * broadcasts these as the ordinary `despawn`/`spawn` ServerMsgs on the
   * resident/full path (accommodation #8 — an evicted/despawned id MUST reach
   * peers or they keep a ghost). The host itself never fabricates world opcodes.
   */
  onWorldReset?(removedIds: readonly string[], spawned: readonly NetShape[]): void;
  /**
   * Called when a CUE mutates the world through `RoomHandle.store` (C10 shape-rain
   * spawn burst / eviction). The connection layer broadcasts these as ordinary
   * spawn/despawn ServerMsgs (accommodation #8 — a cue-spawned shape and any
   * evicted id MUST reach peers). Separate from `onWorldReset` (which is the
   * rotation boundary): this is the per-cue live world delta.
   */
  onCueWorldDelta?(spawned: readonly NetShape[], removedIds: readonly string[]): void;
  /**
   * C10 STATS phase: compute the STATS_CARD to broadcast when the timeline enters
   * STATS (spec §7.2). Server-computed, CALLSIGNS ONLY. The connection layer
   * supplies this (it reads the room's throw stats + the `dayStats` bucket
   * leaderboard). Absent → no STATS_CARD is broadcast (a room with no stats source
   * still rotates cleanly).
   */
  computeStatsCard?(): StatsCard;
  /**
   * Task C34 (F23 The Workshop): called whenever build-mode ENTERS or EXITS (spec
   * §7.23). The connection layer uses it to broadcast the build-mode state to the
   * room and (on exit via RESET) to discard unsaved edits. Absent → the Workshop
   * cue is not wired (cut-safe).
   */
  onBuildModeChange?(active: boolean): void;
  /** Starting phase (default ATTRACT — the idle-hours attract loop). */
  initialPhase?: Phase;
}

/**
 * The C5 host: one per room. Owns the timeline + cue registry, the PHASE_STATE
 * heartbeat, the auto-cue playlist, and the RESET handler. The election-host stub
 * is left as the `setBaseParams` hook (C15 lands elections; the brief says leave
 * the hook, not implement election here).
 */
export class RoomTimelineHost {
  readonly timeline: RoomTimeline;
  readonly registry: CueRegistry;
  readonly handle: RoomHandle;

  private readonly _timer: TimerApi;
  private readonly _world: ServerWorld;
  private readonly _opts: RoomTimelineHostOpts;
  /**
   * The showroom baseline the RESET handler restores (spec §7.23). Defaults to the
   * v1 SHOWROOM_BASELINE seed list; C34's SET_BASELINE rebinds it to the baked
   * named-baseline layout's seeds via {@link setShowroomBaseline} — always the v1
   * list as the fallback (RESET falls back to it when no baseline is set). Mutable
   * so a SET_BASELINE takes effect on the NEXT RESET without rebuilding the host.
   */
  private _showroomBaseline: readonly ShowroomSeed[];

  /**
   * The TWO-LAYER param state (C11, spec §5.6). `_baseParams` is the STANDING law
   * (elections write it; DEFAULT_PARAMS until C15). `_cueOverlay` is the timed dial
   * overlay. `effectiveParams = mergeParams(base, overlay)`; the auto-revert pops
   * the overlay back to `_baseParams` — NEVER to DEFAULT_PARAMS (an elected law
   * survives a dial firing).
   */
  private _baseParams: PhysicsParams = DEFAULT_PARAMS;
  private _cueOverlay: Partial<PhysicsParams> | null = null;
  private _overlayRevertHandle: TimerHandle | null = null;
  /** The live dial's mode label + auto-revert deadline (ENV_STATE mode/endsAt). */
  private _cueMode: string | null = null;
  private _cueEndsAt: number | null = null;
  /**
   * The §5.6/§7.16 single-overlay-writer guard: while a showpiece wave overlay (or
   * the Workshop build-mode freeze) is active, cues that write the overlay are
   * refused via the `wrongPhase` path. Toggled by C16/C27/C34 through
   * begin/endShowpieceOverlay; exercised directly in tests.
   */
  private _showpieceOverlayActive = false;
  /** In-flight compound-cue stage timers (TIME-FREEZE / SUPERNOVA), cleared on RESET. */
  private readonly _cueStageHandles = new Set<TimerHandle>();
  /**
   * Task C34 (F23 The Workshop, §7.23): true while a build-mode composition session
   * is engaged. While active: the timeline HOLDS (an `acquireHold` — the §5.5 hold
   * clause names build-mode), the auto-cue playlist is SUSPENDED (via
   * `timeline.isHeld`), overlay-writing cues are REFUSED (`_showpieceOverlayActive`
   * — the §5.6 single-overlay-writer guard names build-mode), and the freeze overlay
   * is live. Re-firing the cue toggles it OFF; a staff RESET forces it off.
   */
  private _buildModeActive = false;
  /** The build-session freeze auto-revert deadline (server ms), or null when off. */
  private _buildModeEndsAt: number | null = null;

  private _heartbeatHandle: TimerHandle | null = null;
  /** Auto-cue playlist timer (re-armed each phase from PACING_TABLE). */
  private _pacingHandle: TimerHandle | null = null;
  /** Server time (ms) the current phase began — gates PLAY's aggressive grace. */
  private _phaseStartedAt = 0;
  /** Comfort spent this rotation (reset on RESET / new rotation). */
  private _comfortSpent = 0;
  private _disposed = false;

  constructor(opts: RoomTimelineHostOpts) {
    this._timer = opts.timer;
    this._world = opts.world;
    this._opts = opts;
    this._showroomBaseline = opts.showroomBaseline ?? SHOWROOM_BASELINE;

    this.timeline = new RoomTimeline({
      timer: opts.timer,
      initialPhase: opts.initialPhase,
      onPhaseChange: (phase, state) => this._onPhaseChange(phase, state),
    });

    // Build the RoomHandle ONCE and share it with the registry (cue handlers and
    // the registry see the same surface).
    this.handle = this._buildHandle();

    this.registry = new CueRegistry({
      room: this.handle,
      timer: opts.timer,
      onChange: (catalog) => this._broadcastCatalog(catalog),
    });

    this._phaseStartedAt = this._timer.now();
    // Broadcast the opening PHASE_STATE and arm the heartbeat + pacing loops.
    this._broadcastPhaseState();
    this._armHeartbeat();
    this._armPacing();
  }

  // ---------------------------------------------------------------------------
  // RoomHandle construction — the single surface cue handlers receive (§5.5).
  // ---------------------------------------------------------------------------

  private _buildHandle(): RoomHandle {
    // Arrow closures capture lexical `this` — no `self` alias (lint clean).
    const world = this._world;
    return {
      store: {
        get shapes() {
          return world.shapes;
        },
        // C10 shape-rain spawns THROUGH the store (never ServerWorld directly —
        // FAQ #5). The ServerWorld.spawn return (shape + evictedId) is narrowed to
        // the ShapeStoreView shape (id + evictedId). A rejected spawn returns null.
        spawn: (init) => {
          const res = world.spawn({
            type: init.type as NetShape['type'],
            position: init.position,
            ...(init.colorIndex !== undefined ? { colorIndex: init.colorIndex } : {}),
            ...(init.renderMode !== undefined
              ? { renderMode: init.renderMode as NetShape['renderMode'] }
              : {}),
            ...(init.scale !== undefined ? { scale: init.scale } : {}),
          });
          if (!res) return null;
          // Route the world delta out as ordinary spawn/despawn ServerMsgs
          // (accommodation #8 — a cue-spawned shape + any evicted id MUST reach
          // peers, else ghosts). The host emits these via onCueWorldDelta so it
          // never fabricates world opcodes itself.
          this._onCueWorldDelta([res.shape], res.evictedId !== null ? [res.evictedId] : []);
          return { id: res.shape.id, evictedId: res.evictedId };
        },
        remove: (id: string) => {
          if (world.get(id)) {
            world.remove(id);
            this._onCueWorldDelta([], [id]);
          }
        },
        pin: (id: string) => world.pin(id),
        unpin: (id: string) => world.unpin(id),
      },
      setBaseParams: (p: PhysicsParams) => this._setBaseParams(p),
      setCueOverlay: (p: Partial<PhysicsParams>, revertAfterMs: number, opts?: CueOverlayOpts) =>
        this._setCueOverlay(p, revertAfterMs, opts),
      broadcast: (opcode: number, payload: unknown, tiers?: readonly string[]) =>
        this._opts.broadcast(opcode, payload, tiers),
      timeline: this.timeline,
      roster: () => this._opts.roster(),
      humanResidents: () => this._opts.roster().filter((p) => p.synthetic !== true),
      pin: (shapeId: string) => world.pin(shapeId),
      unpin: (shapeId: string) => world.unpin(shapeId),
      schedule: (fn: () => void, delayMs: number) => this._scheduleCueStage(fn, delayMs),
      setBuildMode: (on?: boolean) => this.setBuildMode(on),
    };
  }

  /**
   * Schedule a follow-up stage of a compound cue (TIME-FREEZE chaos→freeze,
   * SUPERNOVA pull→detonate) via the injected TimerApi. Tracked so RESET/dispose
   * cancels any in-flight stage (a rotation boundary must not fire a stale freeze).
   */
  private _scheduleCueStage(fn: () => void, delayMs: number): void {
    let handle: TimerHandle;
    handle = this._timer.setTimeout(() => {
      this._cueStageHandles.delete(handle);
      if (this._disposed) return;
      fn();
    }, delayMs);
    this._cueStageHandles.add(handle);
  }

  private _clearCueStages(): void {
    for (const h of this._cueStageHandles) this._timer.clearTimeout(h);
    this._cueStageHandles.clear();
  }

  // ---------------------------------------------------------------------------
  // Timeline exit: first HUMAN resident join advances ATTRACT → LOBBY (§5.5/§7.17).
  // ---------------------------------------------------------------------------

  /**
   * Notify the host that a peer joined. If the timeline is in ATTRACT and this is
   * a HUMAN resident (synthetic peers never advance — §7.17), advance to LOBBY.
   * The connection layer calls this after a successful join.
   */
  onPeerJoined(peer: PeerInfo): void {
    if (this._disposed) return;
    if (this.timeline.phase !== 'ATTRACT') return;
    if (peer.synthetic === true) return; // synthetic join does NOT advance
    this.timeline.advance(); // ATTRACT → LOBBY
  }

  // ---------------------------------------------------------------------------
  // Cue firing (delegates to the registry; convenience passthrough).
  // ---------------------------------------------------------------------------

  fire(cueId: string, cueInstanceId: string): FireResult {
    // §5.6/§7.16 single-overlay-writer guard: while a showpiece wave overlay (or
    // the build-mode freeze) owns the single cueOverlay, an overlay-writing dial
    // is refused via the existing `wrongPhase` path (SUPERNOVA is guarded here too
    // — it is fireable in FINALE but refused while a siege/encore overlay is live).
    // A non-overlay cue (shape-rain) is never guarded.
    //
    // C11 CQ-1 fix: peek the dedupe FIRST so a RETRIED packet stays idempotent
    // (echoes `deduped`, not `wrongPhase`). C16 makes this guard reachable (the
    // siege is the first real overlay claimant), so the ordering now matters: a
    // client that resends its FIRE while a siege is live must see the same
    // `deduped` it would see with no siege. Only a FRESH overlay-writing packet is
    // refused by the guard.
    if (
      this._showpieceOverlayActive &&
      this.registry.writesOverlay(cueId) &&
      !this.registry.hasSeenInstance(cueInstanceId)
    ) {
      return 'wrongPhase';
    }
    const result = this.registry.fire(cueId, cueInstanceId);
    if (result === 'ok') {
      const cue = this.registry.catalog().find((c) => c.id === cueId);
      if (cue) this._comfortSpent += cue.comfortCost;
    }
    return result;
  }

  /**
   * Begin a showpiece/build-mode overlay claim (spec §5.6/§7.16). While active,
   * overlay-writing dials are refused via `wrongPhase`. Idempotent. Called by
   * C16/C27 (siege waves) and C34 (build-mode freeze); exercised in C11 tests.
   */
  beginShowpieceOverlay(): void {
    this._showpieceOverlayActive = true;
  }

  /** Release the showpiece/build-mode overlay claim — overlay dials fire again. */
  endShowpieceOverlay(): void {
    this._showpieceOverlayActive = false;
  }

  /** True iff a showpiece/build-mode overlay currently owns the single cueOverlay. */
  get showpieceOverlayActive(): boolean {
    return this._showpieceOverlayActive;
  }

  // ---------------------------------------------------------------------------
  // Build-mode (Task C34, spec §7.23). Engaging it HOLDS the timeline, SUSPENDS
  // the auto-cue playlist, claims the single overlay writer (overlay cues refused),
  // and applies the freeze overlay (revertAfterMs = BUILD_SESSION_MAX_MS). Re-fire
  // toggles OFF; the session-max auto-revert + a staff RESET also exit it.
  // ---------------------------------------------------------------------------

  /** True iff a build-mode composition session is engaged (spec §7.23). */
  get buildModeActive(): boolean {
    return this._buildModeActive;
  }

  /**
   * The freeze overlay a build session applies: a fully static world (freeze
   * short-circuits stepBody) contained by DIAL_BOUNDS + suspendDespawn, so a
   * composer walks among still shapes without any despawn. NOT a Reality Dial —
   * it never enters the pacing table or the ballot; it is the build-mode freeze.
   */
  private _buildFreezeOverlay(): Partial<PhysicsParams> {
    return {
      freeze: true,
      bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
      suspendDespawn: true,
    };
  }

  /**
   * Toggle build-mode (spec §7.23). `on: undefined` flips; `on: true/false` forces.
   *   • ENTER: acquire a timeline hold (phase advance freezes — the §5.5 clause),
   *     claim the single overlay writer (overlay cues refused — §5.6), apply the
   *     freeze overlay with revertAfterMs = BUILD_SESSION_MAX_MS (re-fire extends).
   *     The auto-cue playlist is suspended because `timeline.isHeld` is now true.
   *   • RE-FIRE while active: EXIT cleanly.
   *   • EXIT: release the hold, drop the overlay writer, revert the freeze overlay.
   * Idempotent for the forced form (setBuildMode(true) while active just extends the
   * freeze session; setBuildMode(false) while inactive is a no-op).
   */
  setBuildMode(on?: boolean): void {
    if (this._disposed) return;
    const target = on === undefined ? !this._buildModeActive : on;
    if (target && !this._buildModeActive) {
      // ENTER build-mode.
      this._buildModeActive = true;
      this.timeline.acquireHold(); // §5.5: build-mode HOLDS phase advance
      this.beginShowpieceOverlay(); // §5.6: overlay-writing cues refused
      // Apply the freeze overlay for the whole session (re-fire extends).
      this._buildModeEndsAt = this._timer.now() + BUILD_SESSION_MAX_MS;
      this._setCueOverlay(this._buildFreezeOverlay(), BUILD_SESSION_MAX_MS, { mode: 'BUILD MODE' });
      this._opts.onBuildModeChange?.(true);
      return;
    }
    if (target && this._buildModeActive) {
      // RE-FIRE with force-on while active: EXTEND the freeze session.
      this._buildModeEndsAt = this._timer.now() + BUILD_SESSION_MAX_MS;
      this._setCueOverlay(this._buildFreezeOverlay(), BUILD_SESSION_MAX_MS, { mode: 'BUILD MODE' });
      return;
    }
    if (!target && this._buildModeActive) {
      // EXIT build-mode (toggle-off / session-max / staff RESET).
      this._exitBuildMode();
    }
    // (!target && !active) — nothing to do.
  }

  /** Internal build-mode teardown: release the hold, drop the overlay, revert freeze. */
  private _exitBuildMode(): void {
    if (!this._buildModeActive) return;
    this._buildModeActive = false;
    this._buildModeEndsAt = null;
    this.endShowpieceOverlay();
    this.timeline.releaseHold();
    // Revert the freeze overlay back to the base (never DEFAULT — an elected law
    // survives). Clearing it directly (not waiting on the BUILD_SESSION_MAX_MS
    // timer) unfreezes the world immediately on a toggle-off.
    if (this._overlayRevertHandle !== null) {
      this._timer.clearTimeout(this._overlayRevertHandle);
      this._overlayRevertHandle = null;
    }
    this._cueOverlay = null;
    this._cueMode = null;
    this._cueEndsAt = null;
    this._broadcastEnvState();
    this._opts.onBuildModeChange?.(false);
  }

  // ---------------------------------------------------------------------------
  // PHASE_STATE broadcast (spec §5.5 — 1 Hz heartbeat + on change).
  // ---------------------------------------------------------------------------

  private _onPhaseChange(_phase: Phase, state: PhaseState): void {
    if (this._disposed) return;
    this._phaseStartedAt = this._timer.now();
    // RESET is the rotation boundary: run the RESET handler as the phase begins.
    if (_phase === 'RESET') this._runReset();
    // STATS phase: broadcast the server-computed STATS_CARD (spec §7.2 — callsigns
    // only, day-leaderboard). Fired as the phase begins so the stage/phones render
    // the card for the whole STATS window.
    if (_phase === 'STATS') this._broadcastStatsCard();
    this._broadcastPhaseState(state);
    // Re-arm the auto-cue playlist for the new phase (interval differs per phase).
    this._armPacing();
  }

  /** Emit a per-cue world delta (spec accommodation #8) to the connection layer. */
  private _onCueWorldDelta(spawned: readonly NetShape[], removedIds: readonly string[]): void {
    if (this._disposed) return;
    this._opts.onCueWorldDelta?.(spawned, removedIds);
  }

  /**
   * Broadcast the STATS_CARD on STATS entry (spec §7.2). Server-computed via the
   * injected `computeStatsCard` (CALLSIGNS ONLY). No-op if no provider is wired.
   */
  private _broadcastStatsCard(): void {
    const card = this._opts.computeStatsCard?.();
    if (!card) return;
    // STATS_CARD (0x2E) rides the resident-class receive set + director + audience
    // hook (§5.1 audience union). The connection layer applies the tier fan-out.
    this._opts.broadcast(OPCODES.STATS_CARD, card, ['resident', 'spectator', 'director']);
  }

  private _broadcastPhaseState(state?: PhaseState): void {
    const s = state ?? this.timeline.state();
    // CARRIED DIRECTIVE (C10 widen): spec §5.1 routes PHASE_STATE to director +
    // residents (the whole resident-class `full` receive set — residents and
    // spectators). The C25 `audience` tier is added to PHASE_STATE_TIERS then
    // (the §5.1 audience union includes PHASE_STATE); the hook is left here and
    // NOT narrowed. Never director-only.
    this._opts.broadcast(OPCODES.PHASE_STATE, s, PHASE_STATE_TIERS);
  }

  private _armHeartbeat(): void {
    this._clearHeartbeat();
    const tick = (): void => {
      if (this._disposed) return;
      this._broadcastPhaseState();
      this._heartbeatHandle = this._timer.setTimeout(tick, PHASE_STATE_HEARTBEAT_MS);
    };
    this._heartbeatHandle = this._timer.setTimeout(tick, PHASE_STATE_HEARTBEAT_MS);
  }

  private _clearHeartbeat(): void {
    if (this._heartbeatHandle !== null) {
      this._timer.clearTimeout(this._heartbeatHandle);
      this._heartbeatHandle = null;
    }
  }

  private _broadcastCatalog(catalog: CueCatalogEntry[]): void {
    if (this._disposed) return;
    // CUE_CATALOG rides the DIRECTOR family (§5.1 stateOnly tier) — the console
    // renders whatever is advertised. The 0x22 DIRECTOR/CATALOG kind is the wire
    // form (C1 minted DIRECTOR_KIND.CATALOG); JSON payload here.
    this._opts.broadcast(OPCODES.DIRECTOR, { kind: 'CATALOG', catalog }, ['director']);
  }

  // ---------------------------------------------------------------------------
  // Auto-cue playlist (spec §5.5 pacing table).
  // ---------------------------------------------------------------------------

  private _armPacing(): void {
    this._clearPacing();
    const row = PACING_TABLE[this.timeline.phase];
    if (!row) return; // this phase has no ambient playlist
    const tick = (): void => {
      if (this._disposed) return;
      this._tryAmbientCue();
      // Re-read the row each tick (phase may have changed underneath us).
      const cur = PACING_TABLE[this.timeline.phase];
      if (cur) this._pacingHandle = this._timer.setTimeout(tick, cur.intervalMs);
    };
    this._pacingHandle = this._timer.setTimeout(tick, row.intervalMs);
  }

  private _tryAmbientCue(): void {
    // Build-mode / showpiece holds suspend the auto-cue playlist (§5.5/§7.23).
    if (this.timeline.isHeld) return;
    const phaseElapsedMs = this._timer.now() - this._phaseStartedAt;
    const pick = pickAmbientCue({
      phase: this.timeline.phase,
      phaseElapsedMs,
      comfortSpent: this._comfortSpent,
      registry: this.registry,
      catalog: this.registry.catalog(),
    });
    if (!pick) return;
    // Auto-fire with a synthetic instance id (never collides with a client's).
    this.fire(pick.id, `auto:${pick.id}:${this._timer.now()}`);
  }

  private _clearPacing(): void {
    if (this._pacingHandle !== null) {
      this._timer.clearTimeout(this._pacingHandle);
      this._pacingHandle = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Params host (seed — C11 completes the two-layer merge). The election host is
  // the `setBaseParams` hook (C15 lands elections; the brief says leave the hook).
  // ---------------------------------------------------------------------------

  get baseParams(): PhysicsParams {
    return this._baseParams;
  }

  /**
   * Write the STANDING law params (the election hook — spec §5.6). `baseParams`
   * stays DEFAULT_PARAMS until C15 elections call this; the point (C11) is that an
   * elected law SURVIVES a dial firing — a dial's auto-revert pops the overlay back
   * to THIS base, never to DEFAULT_PARAMS. Broadcasts a fresh ENV_STATE.
   */
  setBaseParams(p: PhysicsParams): void {
    this._setBaseParams(p);
  }

  get cueOverlay(): Partial<PhysicsParams> | null {
    return this._cueOverlay;
  }

  /**
   * The EFFECTIVE PhysicsParams the sim steps under right now: the timed
   * `_cueOverlay` merged over the STANDING `_baseParams` (the two-layer resolution,
   * spec §5.6). `mergeParams` is field-wise overlay-wins and identity on a null
   * overlay, so with no active dial this returns the base unchanged (an elected law,
   * or DEFAULT_PARAMS → Phase B parity).
   */
  effectiveParams(): PhysicsParams {
    return mergeParams(this._baseParams, this._cueOverlay);
  }

  /**
   * The current ENV_STATE {serverTimestamp, mode, params, endsAt} (spec §7.3). Used
   * for the live broadcast AND the late-join snapshot (a late joiner gets the active
   * dial + endsAt). `mode`/`endsAt` are null when no dial is live.
   */
  envState(): EnvState {
    return {
      serverTimestamp: this._timer.now(),
      mode: this._cueMode,
      params: this.effectiveParams(),
      endsAt: this._cueEndsAt,
    };
  }

  private _setBaseParams(p: PhysicsParams): void {
    this._baseParams = p;
    this._opts.setBaseParams?.(p);
    // A law change re-broadcasts ENV_STATE so late params changes reach clients
    // even without an active dial (the effective params moved).
    this._broadcastEnvState();
  }

  private _setCueOverlay(
    p: Partial<PhysicsParams>,
    revertAfterMs: number,
    opts?: CueOverlayOpts
  ): void {
    this._cueOverlay = p;
    this._cueMode = opts?.mode ?? null;
    this._cueEndsAt = this._timer.now() + revertAfterMs;
    this._opts.setCueOverlay?.(p, revertAfterMs);
    // Broadcast ENV_STATE for the newly-applied dial (banner + late-join endsAt).
    this._broadcastEnvState();
    // Auto-revert the overlay back to baseParams (NEVER to DEFAULT_PARAMS — §5.6).
    if (this._overlayRevertHandle !== null) this._timer.clearTimeout(this._overlayRevertHandle);
    this._overlayRevertHandle = this._timer.setTimeout(() => {
      this._overlayRevertHandle = null;
      // Task C34: if this is the build-mode freeze session's timer firing, it is the
      // SESSION-MAX expiry (spec §7.23 "session-max" exit) — exit build-mode fully
      // (release the hold + overlay writer), not just pop the overlay.
      if (this._buildModeActive) {
        this._exitBuildMode();
        return;
      }
      this._cueOverlay = null; // pop back to baseParams (the ACTIVE LAW, not DEFAULT)
      this._cueMode = null;
      this._cueEndsAt = null;
      // Broadcast the revert so the banner clears + clients resume (freeze off).
      this._broadcastEnvState();
    }, revertAfterMs);
  }

  /** Broadcast the current ENV_STATE (spec §7.3 / OPCODES.ENV_STATE 0x23). */
  private _broadcastEnvState(): void {
    if (this._disposed) return;
    // ENV_STATE rides the audience-union receive set (§5.1): resident-class + director
    // (+ audience when C25 lands). The connection layer maps the opcode → ServerMsg.
    this._opts.broadcast(OPCODES.ENV_STATE, this.envState(), ENV_STATE_TIERS);
  }

  // ---------------------------------------------------------------------------
  // RESET handler (spec §5.5 / §D4). Despawn all world shapes, revert base AND
  // overlay to DEFAULT_PARAMS, respawn the curated showroom baseline, count a
  // rotation. World persistence never captures mid-showpiece forces (§6.4).
  // ---------------------------------------------------------------------------

  /**
   * Restore the room to its baseline. Called automatically as the RESET phase
   * begins (rotation boundary) and available for a staff-forced RESET (the safety
   * override). Idempotent + side-effect-explicit.
   */
  private _runReset(): void {
    // 0. Task C34: a RESET is the staff safety override that EXITS build-mode and
    //    discards unsaved edits (spec §7.23). Release the hold + overlay writer +
    //    notify BEFORE the world rebuild so the freeze is gone as the baseline
    //    restores. Exit is idempotent — a RESET outside build-mode is a no-op here.
    if (this._buildModeActive) {
      this._buildModeActive = false;
      this._buildModeEndsAt = null;
      this.timeline.releaseHold();
      this._opts.onBuildModeChange?.(false);
    }
    // 1. Despawn every world shape (also drops all pins — remove() clears them).
    const removedIds: string[] = this._world.shapes.map((s) => s.id);
    for (const id of removedIds) this._world.remove(id);
    // 2. Revert BOTH param layers to DEFAULT_PARAMS (base AND overlay — §5.5).
    //    A bullet-time overlay must not survive a rotation; the elected law is
    //    also cleared here because RESET is the rotation boundary (§D4 restores
    //    the baseline world under DEFAULT_PARAMS — §7.23 "params semantics").
    if (this._overlayRevertHandle !== null) {
      this._timer.clearTimeout(this._overlayRevertHandle);
      this._overlayRevertHandle = null;
    }
    this._clearCueStages(); // cancel any in-flight TIME-FREEZE/SUPERNOVA stage
    this._cueOverlay = null;
    this._cueMode = null;
    this._cueEndsAt = null;
    this._showpieceOverlayActive = false;
    this._baseParams = DEFAULT_PARAMS;
    this._opts.setBaseParams?.(DEFAULT_PARAMS);
    // Broadcast the reverted ENV_STATE so any live banner/freeze clears at the
    // rotation boundary (params back to DEFAULT_PARAMS).
    this._broadcastEnvState();
    // 3. Respawn the curated showroom baseline (v1 shared-constants seed list, or
    //    a Workshop-named baseline with THIS as the fallback — §7.23).
    const spawned: NetShape[] = [];
    for (const seed of this._showroomBaseline) {
      const res = this._world.spawn({
        type: seed.type,
        position: seed.position,
        colorIndex: seed.colorIndex,
        renderMode: seed.renderMode,
        scale: seed.scale,
      });
      if (res) spawned.push(res.shape);
    }
    // 4. Hand the world change to the connection layer to broadcast as ordinary
    //    despawn/spawn ServerMsgs (accommodation #8 — never leave ghost shapes).
    this._opts.onWorldReset?.(removedIds, spawned);
    // 5. Count the rotation + reset the per-rotation comfort budget.
    this._opts.metricsCount?.('rotation');
    this._comfortSpent = 0;
  }

  /** Force a RESET now (staff safety override — discards transient state). */
  forceReset(): void {
    this._runReset();
  }

  /**
   * Task C34 (F23 The Workshop, spec §7.23): rebind the showroom baseline the RESET
   * handler restores. SET_BASELINE calls this with the BAKED named-baseline layout's
   * seeds (validated + re-baked under DEFAULT_PARAMS by the connection layer). It
   * takes effect on the NEXT RESET. `null`/empty falls back to the v1 seed list —
   * RESET NEVER depends on the Workshop (C5 is Tier 0). The RESET always restores
   * these under DEFAULT_PARAMS (ignoring any layout.baseParams/themeId — §D4).
   */
  setShowroomBaseline(seeds: readonly ShowroomSeed[] | null): void {
    this._showroomBaseline = seeds && seeds.length > 0 ? seeds : SHOWROOM_BASELINE;
  }

  /** The current showroom baseline the RESET handler restores (test surface). */
  get showroomBaseline(): readonly ShowroomSeed[] {
    return this._showroomBaseline;
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  dispose(): void {
    this._disposed = true;
    this._clearHeartbeat();
    this._clearPacing();
    this._clearCueStages();
    if (this._overlayRevertHandle !== null) {
      this._timer.clearTimeout(this._overlayRevertHandle);
      this._overlayRevertHandle = null;
    }
    this.timeline.dispose();
  }
}

// ===========================================================================
// Task C15 — F5 Reality Referendum election host (spec §7.5).
//
// The election host runs the PURE `electionReducer` (shared/elections.ts) on a
// live room. It owns the ballot's server side: accepts VOTE_CAST from the crowd
// (one switchable vote per opaque token), coalesces VOTE_TALLY to 2 Hz (NEVER a
// per-vote broadcast storm), and on ENACT runs the spec §7.5 sequence —
//
//   1. LEGIBILITY TOP-UP FIRST: auto-fill the world to 20–30 shapes so the money
//      shot reads (spec §7.5 "server auto-tops-up to ~20–30 shapes BEFORE
//      enacting"). Spawns ride the RoomHandle store (accommodation #8 broadcast).
//   2. THEN write baseParams (the elected law) via `RoomHandle.setBaseParams`.
//      The elected law becomes the STANDING law: a dial fired later reverts back
//      to THIS base, never DEFAULT_PARAMS (the C11 two-layer loop) and it
//      survives a rotation until re-elected / reverted / RESET.
//
// Options are DIAL CUE IDS ONLY; the winner's PhysicsParams law is resolved via
// the injected `dialLaw(id)` map (a dial overlay merged over DEFAULT → a full
// baseParams). Theme options are registered by C20 as ordinary elections enacted
// as THEME_SET — there is no second vote path (the `dialLaw` hook is where C20
// widens the enactment target; the reducer is untouched).
//
// STAFF REVERT/VETO restores the PREVIOUS baseParams (a one-deep-per-enact undo
// stack). PURE-timed: no raw setTimeout/Date — everything via the injected timer.
// ===========================================================================

/** The VOTE_TALLY coalescing cadence (2 Hz — spec §5.2 row 0x25 / §7.5). */
export const ELECTION_TALLY_HZ_MS = 500;
/** The legibility floor — the world is topped up to AT LEAST this many shapes (§7.5). */
export const ELECTION_LEGIBILITY_FLOOR = 20;
/** The legibility ceiling — top-up never exceeds this (spec §7.5 "~20–30 shapes"). */
export const ELECTION_LEGIBILITY_CEIL = 30;
/** The first visible change must land within this window after zero (spec §7.5). */
export const ELECTION_FIRST_CHANGE_MAX_MS = 300;

/** The shape types the legibility top-up cycles through (deterministic; no Math.random). */
const TOPUP_TYPES = ['cube', 'sphere', 'icosahedron', 'octahedron', 'tetrahedron'] as const;

/** Options for {@link ElectionHost}. */
export interface ElectionHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /**
   * The room's `RoomHandle` — the ONLY surface the host touches (FAQ #5). It uses
   * `store` (top-up spawns + shape count), `setBaseParams` (the enact write), and
   * `setCueOverlay` is NOT used here (elections write BASE, dials write overlay).
   */
  handle: RoomHandle;
  /** The ballot options — DIAL CUE IDS ONLY (theme ids appended by C20). */
  options: string[];
  /**
   * Resolve a winning dial id → the STANDING law PhysicsParams to write into
   * baseParams (a dial overlay merged over DEFAULT_PARAMS). C20 widens this to
   * theme ids without touching the reducer or the host. Returns undefined for an
   * unknown id (the enact is skipped — the reducer already re-opens on no winner).
   */
  dialLaw(id: string): PhysicsParams | undefined;
  /**
   * C20 F9 Reality Channels: enact a THEME vote. A theme option is a NAMESPACED
   * ballot id (`theme:<id>`) registered into THIS SAME pool (ordinary §7.5
   * election — no second vote path). When the winner is a theme option, the host
   * routes it HERE (→ `ThemeChannelHost.setTheme` / THEME_SET) INSTEAD OF writing
   * baseParams — a theme vote flips the reality, it never rewrites the physics law.
   * Absent → theme options are inert (the enact is skipped; a room with no theme
   * channel still runs dial elections). `themeId` is the un-namespaced theme id.
   */
  enactTheme?(themeId: string): void;
  /**
   * Broadcast an opcode payload (VOTE family) to the room. The connection layer
   * maps this to the crowd-class fan-out (ballots ride the crowd tier + the stage
   * renders the tally). `tiers` narrows the audience; absent = the opcode default.
   */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** Increment the day-stats 'vote' counter (spec §7.17 / C8). Optional. */
  metricsCount?(key: string): void;
  /**
   * Read the STANDING baseParams (the RoomHandle has no getter). Used to snapshot
   * the current law onto the undo stack BEFORE an enact overwrites it, so a staff
   * REVERT restores it. Absent → DEFAULT_PARAMS is assumed as the pre-enact base.
   */
  readBaseParams?(): PhysicsParams;
  /**
   * The phase-gated curation predicate (spec §7.5 "no purge during a fresh
   * wearer's first minute"). Returns the options the ballot should carry for a
   * fresh election. Absent → the constructor `options` verbatim. C-phase curation
   * (e.g. suppress aggressive dials in a fresh wearer's first minute) plugs in
   * here without touching the reducer.
   */
  curateOptions?(): string[];
}

/** The tiers VOTE_OPEN / VOTE_TALLY / VOTE_RESULT fan out to (crowd ballots + stage). */
export const VOTE_TIERS: readonly string[] = ['crowd', 'resident', 'spectator', 'director'];

/**
 * The C15 election host: one per room, composed with the {@link RoomTimelineHost}
 * over the SAME `RoomHandle`. Runs the pure reducer; drives the 2 Hz tally + the
 * enact→baseParams sequence with the legibility top-up FIRST.
 */
export class ElectionHost {
  private readonly _timer: TimerApi;
  private readonly _handle: RoomHandle;
  private readonly _opts: ElectionHostOpts;
  private readonly _options: string[];

  private _state: ElectionState;
  /** True while a coalesced tally is dirty (a vote landed since the last flush). */
  private _tallyDirty = false;
  private _tallyHandle: TimerHandle | null = null;
  private _clockHandle: TimerHandle | null = null;
  /**
   * The one-deep-per-enact undo stack of PREVIOUS baseParams (spec §7.5 staff
   * REVERT). `pop()` on revert restores the law that stood before the last enact.
   */
  private readonly _baseHistory: PhysicsParams[] = [];
  private _disposed = false;

  constructor(opts: ElectionHostOpts) {
    this._timer = opts.timer;
    this._handle = opts.handle;
    this._opts = opts;
    this._options = [...opts.options];
    // Start CLOSED (COOLDOWN with an immediate re-open on the first clock tick) so
    // a caller can `open()` explicitly; the reducer state is real from the start.
    this._state = openElection({ options: this._curated(), nowMs: this._timer.now() });
    // The election is not yet "running" until open() — but seed a coherent state.
    this._state = { ...this._state, phase: 'COOLDOWN', cooldownUntilMs: this._timer.now() };
  }

  /** The current (immutable) election state — safe to read/snapshot/broadcast. */
  get state(): ElectionState {
    return this._state;
  }

  private _curated(): string[] {
    return this._opts.curateOptions?.() ?? [...this._options];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open a fresh election NOW (phase-gated curation resolves the options). Arms
   * the deadline clock + the 2 Hz tally coalescer. Broadcasts VOTE_OPEN + an
   * initial tally so a late-scanning phone lands on a live ballot immediately.
   */
  open(nowMs: number = this._timer.now()): void {
    if (this._disposed) return;
    this._state = openElection({ options: this._curated(), nowMs });
    this._broadcastOpen();
    this._broadcastTally(); // one immediate tally (never-dead ballot)
    this._armClock();
    this._armTally();
  }

  /**
   * Accept a vote (one SWITCHABLE vote per opaque token). Marks the coalesced
   * tally dirty; the 2 Hz flusher (never per-vote) does the broadcast. Counts a
   * 'vote' metric on a NEW voter (a switch is not a new count). No-op when closed.
   */
  cast(token: string, option: string, nowMs: number = this._timer.now()): void {
    if (this._disposed) return;
    const before = this._state.voterCount;
    const next = electionReducer(this._state, { type: 'CAST', token, option, nowMs });
    if (next === this._state) return; // rejected (closed / unknown option / no-op)
    // A NEW voter (not a switch) → count the ballot (§8 metrics.count('vote')).
    if (next.voterCount > before) this._opts.metricsCount?.('vote');
    this._state = next;
    this._tallyDirty = true;
    // The adaptive deadline may have tightened — re-arm the clock to the new one.
    this._armClock();
  }

  /**
   * Staff REVERT/VETO (spec §7.5): restore the PREVIOUS baseParams (the law that
   * stood before the last enact). A one-deep-per-enact undo — repeated REVERTs
   * peel the history back. No-op when nothing has been enacted.
   */
  revert(): void {
    if (this._disposed) return;
    const prev = this._baseHistory.pop();
    if (prev === undefined) return;
    this._handle.setBaseParams(prev);
  }

  /**
   * Task C22 (carry #5, defensive): discard the ENTIRE base-params undo stack.
   * Called on a RESET (the rotation boundary — spec §D4/§7.23): the standing law
   * is already reverted to DEFAULT_PARAMS there, and a pre-RESET law must never
   * be restorable afterward (a `revert()` after RESET must be an inert no-op).
   * `revert()` itself is currently unwired in production (defensive symmetry).
   */
  clearBaseHistory(): void {
    this._baseHistory.length = 0;
  }

  // -------------------------------------------------------------------------
  // The deadline clock: OPEN → (top-up + enact) → COOLDOWN → re-open.
  // -------------------------------------------------------------------------

  private _armClock(): void {
    this._clearClock();
    if (this._disposed) return;
    const now = this._timer.now();
    let fireAt: number | null = null;
    if (this._state.phase === 'OPEN') fireAt = this._state.deadlineMs;
    else if (this._state.phase === 'COOLDOWN' && this._state.cooldownUntilMs !== null)
      fireAt = this._state.cooldownUntilMs;
    if (fireAt === null) return;
    const delay = Math.max(0, fireAt - now);
    this._clockHandle = this._timer.setTimeout(() => {
      this._clockHandle = null;
      this._onClock();
    }, delay);
  }

  private _onClock(): void {
    if (this._disposed) return;
    const now = this._timer.now();
    if (this._state.phase === 'OPEN') {
      // Deadline reached → TALLY, then RESOLVE (unique winner → ENACT, else re-open).
      this._state = electionReducer(this._state, { type: 'TICK', nowMs: now });
      this._state = electionReducer(this._state, { type: 'RESOLVE', nowMs: now });
      if (this._state.phase === 'ENACT') {
        this._enact(now);
      } else {
        // Tie / no-votes → the reducer re-opened. Announce + re-arm.
        this._broadcastOpen();
        this._broadcastTally();
      }
      this._armClock();
      return;
    }
    if (this._state.phase === 'COOLDOWN') {
      // Cooldown elapsed → re-open a fresh election. We go straight through
      // `openElection` (rather than the reducer's TICK re-open) so the phase-gated
      // curation (§7.5) can re-pick the options for the new round.
      this._state = openElection({ options: this._curated(), nowMs: now });
      this._broadcastOpen();
      this._broadcastTally();
      this._armClock();
    }
  }

  /**
   * The ENACT money shot (spec §7.5): TOP UP the world to the legibility band
   * FIRST, THEN write the elected law into baseParams, THEN broadcast VOTE_RESULT
   * and enter COOLDOWN. The order matters — the crowd sees a FULL world snap into
   * the new law, not a near-empty one (the legibility floor).
   */
  private _enact(nowMs: number): void {
    const winner = this._state.winner;
    // C20: a THEME-namespaced winner (`theme:<id>`) is enacted as a THEME_SET via
    // the `enactTheme` hook — NOT as a baseParams write. This is the SAME ballot,
    // resolved by the SAME reducer; only the enactment TARGET differs (theme vs
    // dial law). No second vote path.
    const themeId = winner !== null ? themeIdFromOption(winner) : undefined;
    // 1. LEGIBILITY TOP-UP FIRST — before ANY visible change (theme or law).
    this._legibilityTopUp();
    if (themeId !== undefined) {
      // 2a. A THEME vote: flip the reality (setTheme / THEME_SET). baseParams is
      //     left EXACTLY as it stands — a theme change never rewrites the law.
      this._opts.enactTheme?.(themeId);
    } else {
      // 2b. A DIAL vote (or a mis-registered option): write the elected law. Push
      //     the current base onto the undo stack so a staff REVERT restores it.
      //     Skip on an unknown id (the reducer already guaranteed a unique winner;
      //     this is only a defensive guard for a mis-registered option).
      const law = winner !== null ? this._opts.dialLaw(winner) : undefined;
      if (law !== undefined) {
        this._baseHistory.push(this._currentBase());
        this._handle.setBaseParams(law);
      }
    }
    // 3. VOTE_RESULT + metric + COOLDOWN.
    this._broadcastResult(winner);
    this._state = electionReducer(this._state, { type: 'ENACTED', nowMs });
  }

  /**
   * Read the STANDING baseParams from the host through the handle. The handle's
   * `setBaseParams` writes it; we snapshot the CURRENT effective base by asking
   * the host — but the RoomHandle does not expose a getter, so the host wires the
   * base read via `_currentBase` at construction. Falls back to DEFAULT_PARAMS.
   */
  private _currentBase(): PhysicsParams {
    return this._opts.readBaseParams?.() ?? DEFAULT_PARAMS;
  }

  /**
   * Auto-top-up the world to the legibility floor (spec §7.5). Spawns through the
   * RoomHandle store (so the cap/eviction invariant + accommodation #8 broadcast
   * apply), stopping at the floor or the ceiling — never over-fills. Deterministic
   * placement (no Math.random). No-op when the world is already in the band.
   */
  private _legibilityTopUp(): void {
    let count = this._handle.store.shapes.length;
    let i = 0;
    // Never exceed the ceiling; fill only up to the floor from below.
    while (count < ELECTION_LEGIBILITY_FLOOR && count < ELECTION_LEGIBILITY_CEIL) {
      const type = TOPUP_TYPES[i % TOPUP_TYPES.length];
      const angle = (i / 8) * Math.PI * 2;
      const radius = 3 + (i % 3);
      const res = this._handle.store.spawn({
        type,
        position: { x: Math.cos(angle) * radius, y: 9 + (i % 4), z: Math.sin(angle) * radius },
        colorIndex: i % 6,
      });
      i++;
      // A spawn may evict the oldest (cap) — recount from the live world so we do
      // not over-count a topped-up shape that immediately recycled another.
      count = this._handle.store.shapes.length;
      if (res === null) break; // rejected spawn — stop rather than spin
      if (i > ELECTION_LEGIBILITY_CEIL * 2) break; // hard safety bound
    }
  }

  // -------------------------------------------------------------------------
  // The 2 Hz VOTE_TALLY coalescer (spec §5.2 / §7.5 — NEVER per-vote).
  // -------------------------------------------------------------------------

  private _armTally(): void {
    this._clearTally();
    if (this._disposed) return;
    const tick = (): void => {
      if (this._disposed) return;
      if (this._tallyDirty && this._state.phase === 'OPEN') this._broadcastTally();
      this._tallyHandle = this._timer.setTimeout(tick, ELECTION_TALLY_HZ_MS);
    };
    this._tallyHandle = this._timer.setTimeout(tick, ELECTION_TALLY_HZ_MS);
  }

  private _broadcastTally(): void {
    this._tallyDirty = false;
    this._opts.broadcast(
      OPCODES.VOTE,
      {
        kind: VOTE_KIND.TALLY,
        options: this._state.options,
        tally: this._state.tally,
        voterCount: this._state.voterCount,
        deadlineMs: this._state.deadlineMs,
        serverTimestamp: this._timer.now(),
      },
      VOTE_TIERS
    );
  }

  private _broadcastOpen(): void {
    this._opts.broadcast(
      OPCODES.VOTE,
      {
        kind: VOTE_KIND.OPEN,
        options: this._state.options,
        openedAtMs: this._state.openedAtMs,
        deadlineMs: this._state.deadlineMs,
      },
      VOTE_TIERS
    );
  }

  private _broadcastResult(winner: string | null): void {
    this._opts.broadcast(
      OPCODES.VOTE,
      {
        kind: VOTE_KIND.RESULT,
        winner,
        tally: this._state.tally,
        cooldownMs: ELECTION_COOLDOWN_MS,
        serverTimestamp: this._timer.now(),
      },
      VOTE_TIERS
    );
  }

  private _clearClock(): void {
    if (this._clockHandle !== null) {
      this._timer.clearTimeout(this._clockHandle);
      this._clockHandle = null;
    }
  }

  private _clearTally(): void {
    if (this._tallyHandle !== null) {
      this._timer.clearTimeout(this._tallyHandle);
      this._tallyHandle = null;
    }
  }

  dispose(): void {
    this._disposed = true;
    this._clearClock();
    this._clearTally();
  }
}

// ===========================================================================
// Task C20 — F9 Reality Channels: the ThemeChannelHost (spec §6.5 / §7.5 / the
// channels sections / §5.2 row 0x24).
//
// One per room. It owns the ACTIVE THEME and the THEME_SET broadcast
// (OPCODES.THEME_SET 0x24 {themeId, transitionAtServerTime, glitch}). A theme
// change is either an immediate SNAP (no lead) or a SCHEDULED transition a short
// comfort-bounded lead ahead, fired on the SAME server tick everywhere via the C3
// `scheduleAt` — so every phone flips the reality in the same instant. A LATE
// transitionAtServerTime → snap NOW with a MINI-GLITCH (the `fireNow` policy).
//
// The active theme PERSISTS via a `snapshot()` / `restore()` round-trip (the
// room/bucket seam) — a rejoining room restores its reality. The palette LUT
// never touches avatars — that exemption lives in the CLIENT apply layer
// (envTheme.ts); the host only carries the theme id.
//
// THEME VOTES ARE ORDINARY §7.5 ELECTIONS: the ElectionHost routes a THEME-
// namespaced winner to THIS host's `setTheme` (its `enactTheme` hook) — there is
// NO second vote path. Staff cues also call `setTheme` directly.
//
// PURE-TIMED: no raw setTimeout/Date/Math.random — everything via the injected
// TimerApi + the C3 scheduleAt.
// ===========================================================================

/** THEME_SET fans out to the same audience-union receive set as PHASE/ENV_STATE. */
export const THEME_SET_TIERS: readonly string[] = STATE_BROADCAST_TIERS as string[];

/** The persisted theme snapshot (the room/bucket round-trip — spec §6.4 world bucket). */
export interface ThemeSnapshot {
  /** The active theme id (a known theme; restore falls back to the default). */
  themeId: string;
}

/** Options for {@link ThemeChannelHost}. */
export interface ThemeChannelHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /**
   * Broadcast an opcode payload (THEME_SET / JSON) to the room. The connection
   * layer maps this to the audience-union fan-out. `tiers` narrows the audience.
   */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** The estimated clock offset for scheduleAt (server host runs local, so ~0). */
  offsetMs?: number;
  /** The starting theme (default DEFAULT_THEME_ID). Unknown → the default. */
  initialTheme?: string;
}

/** The THEME_SET wire payload (spec §5.2 row 0x24 — JSON-after-preamble). */
export interface ThemeSetPayload {
  themeId: string;
  /** Absolute server time (ms) the transition lands (== now for an immediate snap). */
  transitionAtServerTime: number;
  /** True when a late/immediate snap should play the comfort mini-glitch. */
  glitch: boolean;
}

export class ThemeChannelHost {
  private readonly _timer: TimerApi;
  private readonly _opts: ThemeChannelHostOpts;
  private readonly _offsetMs: number;

  private _activeTheme: string;
  /** The pending scheduled transition handle (cancelled if a newer setTheme lands). */
  private _pending: { cancel(): void } | null = null;
  private _disposed = false;

  constructor(opts: ThemeChannelHostOpts) {
    this._timer = opts.timer;
    this._opts = opts;
    this._offsetMs = opts.offsetMs ?? 0;
    const init = opts.initialTheme;
    this._activeTheme = init !== undefined && isTheme(init) ? init : DEFAULT_THEME_ID;
  }

  /** The currently-active theme id. */
  get activeTheme(): string {
    return this._activeTheme;
  }

  /**
   * Set the room's theme (staff cue OR an enacted theme vote via the election
   * host's `enactTheme` hook). An UNKNOWN theme id is ignored.
   *
   * `transitionAtServerTime` (absolute server ms) schedules the flip:
   *   • absent / already elapsed → SNAP NOW with a mini-glitch (late-policy fireNow);
   *   • a future time within the comfort bound → a scheduled transition on that tick;
   *   • an over-long lead is CLAMPED to {@link THEME_TRANSITION_MAX_LEAD_MS}.
   */
  setTheme(themeId: string, transitionAtServerTime?: number): void {
    if (this._disposed || !isTheme(themeId)) return;
    // Supersede any pending transition (the newest intent wins).
    if (this._pending) {
      this._pending.cancel();
      this._pending = null;
    }
    const now = this._timer.now();
    if (transitionAtServerTime === undefined) {
      // Immediate snap (a staff cut / a same-instant flip). No glitch — it is a
      // deliberate, unhurried swap; the mini-glitch is reserved for a LATE snap.
      this._applyAndBroadcast(themeId, now, false);
      return;
    }
    // Clamp an over-long lead to the comfort bound so a mis-set transition never
    // schedules far into the future (§6.3 — headset transitions stay short).
    const maxAt = now + THEME_TRANSITION_MAX_LEAD_MS;
    const fireAt = Math.min(transitionAtServerTime, maxAt);
    // A late fireAt (already past) → snap NOW with the mini-glitch. The scheduleAt
    // 'fireNow' policy fires the callback immediately when the deadline has passed;
    // we detect that late case here so the payload carries the glitch flag.
    const isLate = fireAt <= now;
    this._pending = scheduleAt(
      fireAt,
      this._offsetMs,
      'fireNow',
      () => {
        this._pending = null;
        // Pass the CLAMPED fireAt (not the original transitionAtServerTime) so the
        // broadcast payload tells clients the same server time the scheduler used.
        this._applyAndBroadcast(themeId, fireAt, isLate);
      },
      this._timer
    );
  }

  /** Snapshot the active theme for persistence (the room/bucket round-trip). */
  snapshot(): ThemeSnapshot {
    return { themeId: this._activeTheme };
  }

  /**
   * Restore a persisted theme (a rejoining room). An unknown snapshot theme falls
   * back to the default (never crashes). Does NOT broadcast — the caller sends the
   * restored theme in the late-join snapshot path.
   */
  restore(snap: ThemeSnapshot): void {
    this._activeTheme = isTheme(snap.themeId) ? snap.themeId : DEFAULT_THEME_ID;
  }

  private _applyAndBroadcast(themeId: string, transitionAtServerTime: number, glitch: boolean): void {
    if (this._disposed) return;
    this._activeTheme = themeId;
    const payload: ThemeSetPayload = {
      themeId,
      transitionAtServerTime,
      glitch,
    };
    this._opts.broadcast(OPCODES.THEME_SET, payload, THEME_SET_TIERS);
  }

  dispose(): void {
    this._disposed = true;
    if (this._pending) {
      this._pending.cancel();
      this._pending = null;
    }
  }
}

/** The mini-glitch duration a late THEME_SET snap requests (re-exported for the client). */
export { THEME_MINI_GLITCH_MS };
