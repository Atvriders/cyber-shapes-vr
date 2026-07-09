/**
 * powersLab.ts — Task C32 F21 Powers Lab (spec §7.21): hand-tracking telekinesis.
 *
 * The player sets the controllers down, holds out a bare hand, pinches at a
 * distant shape — and the server tears it across the room into their palm under a
 * "NO CONTROLLERS — CAMERA-TRACKED HANDS" lower-third. This host owns ALL of the
 * server-authoritative behavior; the TK-specific vector/scalar math is the pure,
 * RESIDUE-FREE `tkMath.ts` (a Tier-6 cut removes this file + tkMath.ts and leaves
 * Tier ≤5 untouched).
 *
 * The pull is a per-tick LOOP FORCE exactly like the C17 titan hands (`titan.ts`):
 * each tick the host nudges the pulled shape's VELOCITY toward the hand anchor
 * (`tkPullVelocity`) — it is NEVER a PhysicsParams change (the default physics path
 * is byte-identical when no pull is live). Composed over the SAME `ServerWorld` +
 * `RoomHandle` the TitanHost uses.
 *
 * SAFETY RAILS (spec §7.21 — every one test-enforced):
 *   • ~250 ms DEAD-MAN'S SWITCH — a pull with no fresh TK_PULL within the window is
 *     released (tracking loss never freezes a stale force);
 *   • the pulled shape is `pin()`ned for the pull (unpinned on convert / release /
 *     timeout / disconnect / RESET — a meteor storm must not vaporize it mid-pull);
 *   • cone-select EXCLUDES `grabbedBy !== null` AND pinned bodies (so the other
 *     hand's pulled shape and any human-held shape are never re-targeted);
 *   • ≤ 2 concurrent pulls (one per hand, keyed by hand index 0/1);
 *   • ONE-TK-PLAYER invariant + REVERT-ON-DISCONNECT (a second player's pull is
 *     rejected while one player is active; the lock frees when they go idle/leave);
 *   • a CONTESTED TK-vs-human grab resolves to the HUMAN at the grab radius (the
 *     conversion is a normal first-claim-wins `world.grab`; if a human holds it the
 *     grab fails and TK yields);
 *   • a per-pull SPEED CAP (the loop force + the release throw are both clamped).
 *
 * PURITY: no raw setTimeout / Date.now — time comes from the injected TimerApi.
 */

import {
  TK_MAX_PULLS,
  TK_EXHIBIT_MS,
  TK_PULL_SPEED_MAX,
  tkPullVelocity,
  tkClampSpeed,
  tkConeSelect,
  advanceConeHold,
  CONE_HOLD_INIT,
  tkDeadManExpired,
  tkGrabRadiusReached,
  type ConeHoldState,
  type TkConeCandidate,
  type TimerApi,
  type TimerHandle,
  type RoomHandle,
  type Vec3,
} from '@cyber-shapes/shared';
import type { ServerWorld } from './serverWorld.js';

/** The tether/skeleton fan-out set (stage + desktop resident, like SHOWPIECE). */
export const TK_TETHER_TIERS: readonly string[] = ['resident', 'spectator', 'director'];

/** One TK tether the stage renders (server knows anchor + target — no joint stream). */
export interface TkTether {
  /** Hand index (0 = left, 1 = right). */
  hand: number;
  /** The bare-hand anchor world position (palm/wrist joint — Step 0). */
  anchor: Vec3;
  /** The pulled shape id. */
  targetId: string;
}

/** The late-join snapshot: the active TK player + their live tethers. */
export interface PowersLabSnapshot {
  peerId: string;
  tethers: TkTether[];
}

/** Per-hand pull/aim state (private). */
interface Aim {
  /** The sustained-hold reducer state (cone target + 300 ms commit). */
  hold: ConeHoldState;
  /** The committed, pinned, pulled shape id — null while still aiming. */
  shapeId: string | null;
  /** The latest hand anchor (loop-force target + tether). */
  anchor: Vec3;
  /** The previous anchor + its timestamp (throw-velocity differencing). */
  prevAnchor: { p: Vec3; t: number } | null;
  /** Wall time (ms) of the last fresh TK_PULL — the dead-man clock. */
  lastPullAt: number;
}

export interface PowersLabHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /** The authoritative world (pin/unpin + the loop-force velocity writes). */
  world: ServerWorld;
  /** The room's RoomHandle — roster (revert-on-disconnect uses the peer id). */
  handle: RoomHandle;
  /** Broadcast an opcode payload (the TK tether) to the room. */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** The TELEKINESIS opcode (injected so the module never imports the registry indirectly). */
  telekinesisOpcode: number;
}

export class PowersLabHost {
  private readonly _timer: TimerApi;
  private readonly _world: ServerWorld;
  private readonly _opts: PowersLabHostOpts;

  /** True while the staff exhibit cue has armed TK (auto-reverts after ~10 min). */
  private _armed = false;
  private _armHandle: TimerHandle | null = null;
  /** The single TK player (one-TK-player invariant), or null. */
  private _tkPlayer: string | null = null;
  /** Per-hand aims for the active player (≤ TK_MAX_PULLS entries). */
  private _aims = new Map<number, Aim>();
  private _disposed = false;

  constructor(opts: PowersLabHostOpts) {
    this._timer = opts.timer;
    this._world = opts.world;
    this._opts = opts;
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  get armed(): boolean {
    return this._armed;
  }
  /** The peer id currently doing TK, or null. */
  get tkPlayer(): string | null {
    return this._tkPlayer;
  }
  /** Count of committed (pinned + pulling) shapes right now. */
  get activePulls(): number {
    let n = 0;
    for (const a of this._aims.values()) if (a.shapeId !== null) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Exhibit arm / disarm (the staff cue, spec §7.21 "~10 min auto-revert")
  // -------------------------------------------------------------------------

  /**
   * Arm the Powers Lab exhibit (the staff cue's effect). While armed, TK_PULL from
   * a resident is honored; unarmed, every TK_PULL is a no-op. Re-arming extends the
   * ~10 min auto-revert. Firing the cue a second time WHILE armed toggles it OFF.
   */
  arm(): void {
    if (this._disposed) return;
    if (this._armed) {
      this.disarm();
      return;
    }
    this._armed = true;
    this._armHandle = this._timer.setTimeout(() => {
      this._armHandle = null;
      this.disarm();
    }, TK_EXHIBIT_MS);
  }

  /** Disarm the exhibit: release every pull + clear the auto-revert timer. */
  disarm(): void {
    this._armed = false;
    if (this._armHandle !== null) {
      this._timer.clearTimeout(this._armHandle);
      this._armHandle = null;
    }
    this._releaseAll();
  }

  // -------------------------------------------------------------------------
  // TK_PULL — the pose-rate intent (cone-select + sustained-hold commit)
  // -------------------------------------------------------------------------

  /**
   * Feed a TK_PULL from `peerId`'s hand. `anchor` is the bare-hand palm/wrist world
   * position; `dir` is the pointing (cone) axis. Enforces the exhibit-armed gate,
   * the one-TK-player invariant, and the ≤ 2-pulls (hand ∈ {0,1}) rail. On a
   * committed 300 ms cone hold over an ELIGIBLE (ungrabbed + unpinned) shape it
   * pins that shape and the tick loop begins pulling it. Refreshes the dead-man
   * clock. Returns the committed shape id for this hand (or null while aiming).
   */
  feedPull(peerId: string, hand: number, anchor: Vec3, dir: Vec3, now: number): string | null {
    if (this._disposed || !this._armed) return null;
    if (!finiteVec(anchor) || !finiteVec(dir)) return null;
    if (hand !== 0 && hand !== 1) return null; // ≤ 2 pulls, one per hand
    // One-TK-player invariant: reject a second player while one is active.
    if (this._tkPlayer !== null && this._tkPlayer !== peerId) return null;
    if (this._tkPlayer === null) this._tkPlayer = peerId;

    let aim = this._aims.get(hand);
    if (!aim) {
      // Enforce the hard ≤ TK_MAX_PULLS ceiling (belt-and-braces vs the hand check).
      if (this._aims.size >= TK_MAX_PULLS) return null;
      aim = { hold: CONE_HOLD_INIT, shapeId: null, anchor, prevAnchor: null, lastPullAt: now };
      this._aims.set(hand, aim);
    }
    // Update the anchor history (throw-velocity differencing) + dead-man clock.
    aim.prevAnchor = { p: aim.anchor, t: aim.lastPullAt };
    aim.anchor = { x: anchor.x, y: anchor.y, z: anchor.z };
    aim.lastPullAt = now;

    // Already committed: just keep pulling (the tick loop applies the force).
    if (aim.shapeId !== null) return aim.shapeId;

    // Aiming: cone-select over the ELIGIBLE set (excludes grabbed + pinned — this
    // is where "the other hand's pulled shape / a human-held shape is never
    // re-targeted" is enforced), then advance the 300 ms sustained hold.
    const candidates = this._eligibleCandidates();
    const pick = tkConeSelect(anchor, dir, candidates);
    aim.hold = advanceConeHold(aim.hold, pick, now);
    if (aim.hold.committed && aim.hold.targetId !== null) {
      // Re-check eligibility at commit time (a shape grabbed/pinned during the hold
      // is no longer valid — the human/other-hand wins).
      const target = aim.hold.targetId;
      const shape = this._world.get(target);
      if (shape && shape.grabbedBy === null && !this._world.isPinned(target)) {
        this._world.pin(target);
        aim.shapeId = target;
      } else {
        // Lost the target during the hold — restart aiming.
        aim.hold = CONE_HOLD_INIT;
      }
    }
    return aim.shapeId;
  }

  // -------------------------------------------------------------------------
  // TK_RELEASE — the throw (velocity from the anchor pose history, speed-capped)
  // -------------------------------------------------------------------------

  /**
   * Release `peerId`'s `hand` pull with a throw. The throw velocity is derived from
   * the anchor pose history (server-authoritative, like the titan), or a client
   * `velocityHint` may be supplied — either way it is CLAMPED to the per-pull speed
   * cap (spec §7.21). Unpins the shape. A no-op unless `peerId` is the active TK
   * player. Frees the one-player lock once the player has no remaining aims.
   */
  release(peerId: string, hand: number, now: number, velocityHint?: Vec3): void {
    if (this._disposed || this._tkPlayer !== peerId) return;
    const aim = this._aims.get(hand);
    if (!aim) return;
    if (aim.shapeId !== null) {
      const shape = this._world.get(aim.shapeId);
      this._world.unpin(aim.shapeId);
      if (shape && shape.grabbedBy === null) {
        const vel = velocityHint && finiteVec(velocityHint)
          ? tkClampSpeed(velocityHint, TK_PULL_SPEED_MAX)
          : tkClampSpeed(this._throwFromHistory(aim, now), TK_PULL_SPEED_MAX);
        shape.velocity.x = vel.x;
        shape.velocity.y = vel.y;
        shape.velocity.z = vel.z;
        shape.grounded = false;
      }
    }
    this._aims.delete(hand);
    this._maybeReleaseLock();
    this._broadcastTethers();
  }

  // -------------------------------------------------------------------------
  // tick — the per-tick LOOP FORCE (spec §7.21, the C17 titan pattern). Runs
  // BEFORE the physics step so the step integrates the nudged velocity.
  // -------------------------------------------------------------------------

  /**
   * Apply one tick of the pull loop force to every committed shape, honoring the
   * dead-man switch (expired → release), the contested-grab→human rail (a human
   * grabbed the pinned shape → yield), and the grab-radius conversion (→ a normal
   * first-claim-wins `world.grab`; human wins on a contested claim). `dt` is the
   * tick seconds; `now` defaults to the injected timer's clock (the SAME clock
   * `feedPull`/`release` are handed at the wire, so the dead-man switch is
   * consistent) — tests pass it explicitly. Broadcasts the live tethers.
   */
  tick(dt: number, now: number = this._timer.now()): void {
    if (this._disposed) return;
    if (this._tkPlayer === null || this._aims.size === 0) return;
    const peer = this._tkPlayer;

    for (const [hand, aim] of [...this._aims.entries()]) {
      // DEAD-MAN'S SWITCH: no fresh pull within the window → release (unpin).
      if (tkDeadManExpired(aim.lastPullAt, now)) {
        if (aim.shapeId !== null) this._world.unpin(aim.shapeId);
        this._aims.delete(hand);
        continue;
      }
      if (aim.shapeId === null) continue; // still aiming — nothing to pull yet

      const shape = this._world.get(aim.shapeId);
      if (!shape) {
        // Shape vanished (despawn) — drop the pull.
        this._world.unpin(aim.shapeId);
        this._aims.delete(hand);
        continue;
      }

      // CONTESTED → HUMAN: a human grabbed the pinned shape mid-pull → TK yields.
      if (shape.grabbedBy !== null && shape.grabbedBy !== peer) {
        this._world.unpin(aim.shapeId);
        this._aims.delete(hand);
        continue;
      }

      // GRAB-RADIUS CONVERSION: at the palm, convert to a normal Phase B grab
      // (first-claim-wins). If a human already holds it, `grab` returns false —
      // the HUMAN wins; TK yields. On success the shape is a normal held body.
      if (tkGrabRadiusReached(shape.position, aim.anchor)) {
        const claimed = this._world.grab(aim.shapeId, peer);
        this._world.unpin(aim.shapeId);
        this._aims.delete(hand);
        // (claimed === false → contested by a human → left to the human; nothing to do.)
        void claimed;
        continue;
      }

      // The LOOP FORCE: nudge the velocity toward the anchor (strength-capped,
      // min-radius-softened). Written onto shape.velocity; the physics step
      // integrates it. NOT a PhysicsParams change.
      const nv = tkPullVelocity(shape.position, shape.velocity, aim.anchor, dt);
      shape.velocity.x = nv.x;
      shape.velocity.y = nv.y;
      shape.velocity.z = nv.z;
      shape.grounded = false;
    }

    this._maybeReleaseLock();
    this._broadcastTethers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle: disconnect / reset / dispose
  // -------------------------------------------------------------------------

  /**
   * Revert-on-disconnect (spec §7.21): if the departing peer IS the active TK
   * player, release all their pulls (unpin) + free the lock; otherwise a no-op.
   */
  onPeerDisconnect(peerId: string): void {
    if (this._tkPlayer === peerId) this._releaseAll();
  }

  /** On a rotation RESET: release every pull (unpin) — the world is being reset. */
  reset(): void {
    this._releaseAll();
  }

  /** The active TK player + their live tethers for a late joiner, or null. */
  snapshot(): PowersLabSnapshot | null {
    if (this._tkPlayer === null) return null;
    const tethers = this._tethers();
    if (tethers.length === 0) return null;
    return { peerId: this._tkPlayer, tethers };
  }

  dispose(): void {
    this._disposed = true;
    if (this._armHandle !== null) {
      this._timer.clearTimeout(this._armHandle);
      this._armHandle = null;
    }
    // Unpin any held shapes so a torn-down host never leaks a pin.
    for (const aim of this._aims.values()) {
      if (aim.shapeId !== null) this._world.unpin(aim.shapeId);
    }
    this._aims.clear();
    this._tkPlayer = null;
    this._armed = false;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Eligible cone-select candidates: ungrabbed AND unpinned shapes (spec §7.21). */
  private _eligibleCandidates(): TkConeCandidate[] {
    const out: TkConeCandidate[] = [];
    for (const s of this._world.shapes) {
      if (s.grabbedBy !== null) continue;
      if (this._world.isPinned(s.id)) continue;
      out.push({ id: s.id, position: s.position });
    }
    return out;
  }

  /** Throw velocity from the anchor pose history (Δanchor / Δt, m/s). */
  private _throwFromHistory(aim: Aim, now: number): Vec3 {
    const prev = aim.prevAnchor;
    if (!prev) return { x: 0, y: 0, z: 0 };
    const dt = (now - prev.t) / 1000;
    if (dt <= 1e-4) return { x: 0, y: 0, z: 0 };
    return {
      x: (aim.anchor.x - prev.p.x) / dt,
      y: (aim.anchor.y - prev.p.y) / dt,
      z: (aim.anchor.z - prev.p.z) / dt,
    };
  }

  /** Release every pull (unpin) + clear the one-player lock (disconnect/reset/disarm). */
  private _releaseAll(): void {
    for (const aim of this._aims.values()) {
      if (aim.shapeId !== null) this._world.unpin(aim.shapeId);
    }
    this._aims.clear();
    this._tkPlayer = null;
    this._broadcastTethers();
  }

  /** Free the one-TK-player lock once the player has no remaining aims. */
  private _maybeReleaseLock(): void {
    if (this._aims.size === 0) this._tkPlayer = null;
  }

  /** The live tethers (committed pulls only) for the stage beat. */
  private _tethers(): TkTether[] {
    const out: TkTether[] = [];
    for (const [hand, aim] of this._aims.entries()) {
      if (aim.shapeId !== null) {
        out.push({ hand, anchor: { x: aim.anchor.x, y: aim.anchor.y, z: aim.anchor.z }, targetId: aim.shapeId });
      }
    }
    return out;
  }

  /** Broadcast the current tethers (server knows anchor + target — NO joint stream). */
  private _broadcastTethers(): void {
    if (this._disposed) return;
    const tethers = this._tethers();
    this._opts.broadcast(
      this._opts.telekinesisOpcode,
      { kind: 'tether', peerId: this._tkPlayer, pulls: tethers },
      TK_TETHER_TIERS
    );
  }
}

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
