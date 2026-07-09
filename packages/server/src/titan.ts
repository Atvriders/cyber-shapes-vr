/**
 * titan.ts — Task C17 F7 Titan Protocol (spec §7.7): the photo moment. A staff
 * "Titanize the current headset player" cue grows one headset player's RIG 1→5
 * (10 behind a second button) over 1.5 s; the giant's hands become impulse
 * sources that scatter shapes; the world NEVER scales (only the rig).
 *
 * This host is composed with the {@link RoomTimelineHost} over the SAME
 * `RoomHandle` (exactly like the C16 SiegeHost). It is server-authoritative and
 * enforces every clamp/invariant the spec §7.7 requires:
 *   • ONE-TITAN invariant — only one titan at a time; a second titanize REPLACES
 *     the first (reverts it, grows the new one);
 *   • hard 30 s auto-revert via the injected TimerApi — INCLUDING revert-on-
 *     disconnect (`onPeerDisconnect`);
 *   • the giant's hand impulses (pure `titanMath.titanHandImpulse`) hit non-grabbed
 *     shapes within the SCALED hand radius each tick, CLAMPED to TITAN_THROW_MAX;
 *   • OOB recall SCOPED to titan-active — `recallOutOfBounds()` runs in the sim
 *     loop BEFORE the physics step honors `removed`; a shape past WORLD_RADIUS is
 *     respawned INSIDE. Baseline (non-titan) throws keep the Phase B despawn at
 *     REMOVE_DISTANCE (this host is a no-op when no titan is active).
 *
 * PURITY: no raw setTimeout / Date.now — everything via the injected TimerApi
 * (Global Constraints / spec §5.5). The world mutation lives here; the vector /
 * scalar math is the pure `titanMath.ts`.
 */

import {
  OPCODES,
  TITAN_SCALE_DEFAULT,
  TITAN_SCALE_MS,
  TITAN_DURATION_MS,
  titanHandImpulse,
  clampThrowVelocity,
  isTitanOutOfBounds,
  titanRecallPosition,
  titanRigScale,
  type TimerApi,
  type TimerHandle,
  type RoomHandle,
  type Vec3,
} from '@cyber-shapes/shared';
import type { ServerWorld } from './serverWorld.js';

/** PLAYER_SCALE fans out to the resident-class receive set + director (like SHOWPIECE). */
export const TITAN_TIERS: readonly string[] = ['resident', 'spectator', 'director', 'wisp', 'crowd'];

/** A single titan hand (world pose + world velocity) the sweep reads. */
export interface TitanHand {
  pos: Vec3;
  vel: Vec3;
}

/** The late-join / presence snapshot: which peer is a titan + its target scale. */
export interface TitanSnapshot {
  peerId: string;
  scale: number;
}

export interface TitanHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /** The authoritative world (OOB recall + hand impulses mutate shapes here). */
  world: ServerWorld;
  /** The room's RoomHandle — roster + broadcast (FAQ #5). */
  handle: RoomHandle;
  /** Broadcast an opcode payload (PLAYER_SCALE family) to the room. */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** Increment the day-stats 'showpiece' counter on titanize (§8 / C8). Optional. */
  metricsCount?(key: string): void;
}

/**
 * The C17 TitanHost: one per room. At most one active titan (the one-titan
 * invariant). Owns the scale broadcast, the 30 s auto-revert (incl. disconnect),
 * the hand-impulse sweep, and the titan-scoped OOB recall.
 */
export class TitanHost {
  private readonly _timer: TimerApi;
  private readonly _world: ServerWorld;
  private readonly _opts: TitanHostOpts;

  private _titanId: string | null = null;
  private _scale = 1;
  private _startedAt = 0;
  private _revertHandle: TimerHandle | null = null;
  /** Monotonic counter seeding recall positions (deterministic spread, no random). */
  private _recallSeq = 0;
  /** The titan's last hand poses (+ timestamp) — used to derive hand velocity. */
  private _lastHands: Array<{ p: Vec3; t: number }> = [];
  private _disposed = false;

  constructor(opts: TitanHostOpts) {
    this._timer = opts.timer;
    this._world = opts.world;
    this._opts = opts;
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  get active(): boolean {
    return this._titanId !== null;
  }
  /** The peer id currently titanized, or null. */
  get activeTitan(): string | null {
    return this._titanId;
  }
  /** The target scale of the active titan (1 when none). */
  get targetScale(): number {
    return this._titanId !== null ? this._scale : 1;
  }

  /** The live eased rig scale at time `now` (1 during the pre-titan window). */
  currentScale(now: number): number {
    if (this._titanId === null) return 1;
    return titanRigScale(now - this._startedAt, this._scale);
  }

  // -------------------------------------------------------------------------
  // Titanize / revert (spec §7.7 — one-titan invariant + 30 s auto-revert)
  // -------------------------------------------------------------------------

  /**
   * Titanize `peerId`: grow their rig 1→`scale` (default 5, 10 behind the second
   * button) over 1.5 s and arm the hard 30 s auto-revert. ONE-TITAN INVARIANT: if
   * a DIFFERENT peer is already a titan, that one is reverted first (only one titan
   * at a time). Re-titanizing the SAME active peer is a no-op (returns false — not
   * a double-count). Counts a `showpiece` metric on a fresh titanize.
   */
  titanize(peerId: string, opts: { scale?: number } = {}): boolean {
    if (this._disposed) return false;
    // Idempotent for the SAME active titan (no double-count, no re-grow).
    if (this._titanId === peerId) return false;

    // One-titan invariant: a new titan REPLACES the old (revert it to scale 1).
    if (this._titanId !== null) this._revertActive();

    const scale = opts.scale && opts.scale > 1 ? opts.scale : TITAN_SCALE_DEFAULT;
    this._titanId = peerId;
    this._scale = scale;
    this._startedAt = this._timer.now();

    // Broadcast the grow: the client eases the RIG from 1→scale over durationMs;
    // remote clients multiply the avatar scale by `scale` (presence playerScale).
    this._broadcastScale(peerId, scale, TITAN_SCALE_MS);

    // Arm the hard 30 s auto-revert (incl. the disconnect path via onPeerDisconnect).
    this._revertHandle = this._timer.setTimeout(() => {
      this._revertHandle = null;
      this._revertActive();
    }, TITAN_DURATION_MS);

    this._opts.metricsCount?.('showpiece');
    return true;
  }

  /** Revert the active titan now (staff override / RESET boundary / timeout). */
  revert(): void {
    this._revertActive();
  }

  /**
   * Revert-on-disconnect (spec §7.7 "incl. revert-on-disconnect"): if the departing
   * peer IS the active titan, revert them; otherwise a no-op (a non-titan leaving
   * never disturbs the giant).
   */
  onPeerDisconnect(peerId: string): void {
    if (this._titanId === peerId) this._revertActive();
  }

  /** Internal: revert whatever titan is active back to scale 1 + clear the timer. */
  private _revertActive(): void {
    if (this._titanId === null) return;
    const peerId = this._titanId;
    this._titanId = null;
    this._scale = 1;
    this._lastHands = [];
    if (this._revertHandle !== null) {
      this._timer.clearTimeout(this._revertHandle);
      this._revertHandle = null;
    }
    // Broadcast the shrink 5→1 over the same ease window (a graceful return).
    this._broadcastScale(peerId, 1, TITAN_SCALE_MS);
  }

  // -------------------------------------------------------------------------
  // Hand impulses (spec §7.7 — titan hands are impulse sources)
  // -------------------------------------------------------------------------

  /**
   * Apply the active titan's hand sweep to non-grabbed shapes within the SCALED
   * hand radius (pure `titanHandImpulse`). Only the ACTIVE titan may sweep (a
   * non-titan `peerId` is ignored — anti-spoof). The imparted velocity is CLAMPED
   * to TITAN_THROW_MAX. Returns the ids of shapes that were pushed this call.
   */
  applyHandImpulses(peerId: string, hands: readonly TitanHand[]): string[] {
    const touched: string[] = [];
    if (this._disposed || this._titanId === null || this._titanId !== peerId) return touched;
    const rigScale = this.currentScale(this._timer.now());

    for (const shape of this._world.shapes) {
      if (shape.grabbedBy !== null) continue; // non-grabbed shapes only (§7.7)
      let dvx = 0;
      let dvy = 0;
      let dvz = 0;
      let any = false;
      for (const hand of hands) {
        const imp = titanHandImpulse(shape.position, hand.pos, hand.vel, rigScale);
        if (imp) {
          dvx += imp.x;
          dvy += imp.y;
          dvz += imp.z;
          any = true;
        }
      }
      if (!any) continue;
      // Add the impulse to the current velocity, then clamp the RESULT to the cap.
      const nv = clampThrowVelocity({
        x: shape.velocity.x + dvx,
        y: shape.velocity.y + dvy,
        z: shape.velocity.z + dvz,
      });
      shape.velocity.x = nv.x;
      shape.velocity.y = nv.y;
      shape.velocity.z = nv.z;
      shape.grounded = false; // a swept shape is airborne
      touched.push(shape.id);
    }
    return touched;
  }

  /**
   * Feed the active titan's latest HAND poses (world positions). Derives each
   * hand's velocity from the previous pose (Δposition / Δtime) and applies the
   * impulse sweep. This is the sim-loop entry point (poses carry no velocity on the
   * wire, so the server differences them). A no-op unless `peerId` is the active
   * titan. Returns the ids of shapes swept this call.
   */
  feedTitanPose(peerId: string, handPositions: ReadonlyArray<Vec3 | null>, now: number): string[] {
    if (this._disposed || this._titanId === null || this._titanId !== peerId) {
      this._lastHands = [];
      return [];
    }
    const hands: TitanHand[] = [];
    for (let i = 0; i < handPositions.length; i++) {
      const p = handPositions[i];
      if (!p) continue;
      const prev = this._lastHands[i];
      // Velocity = Δposition / Δtime (seconds). A missing/zero-Δt prior pose yields
      // a zero-velocity sweep (no impulse this frame — the falloff still needs speed).
      let vel: Vec3 = { x: 0, y: 0, z: 0 };
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 1e-4) {
          vel = { x: (p.x - prev.p.x) / dt, y: (p.y - prev.p.y) / dt, z: (p.z - prev.p.z) / dt };
        }
      }
      hands.push({ pos: p, vel });
    }
    // Record this pose as the prior for the next call.
    this._lastHands = handPositions.map((p) => ({ p: p ?? { x: 0, y: 0, z: 0 }, t: now }));
    if (hands.length === 0) return [];
    return this.applyHandImpulses(peerId, hands);
  }

  /** Expose the TITAN_THROW_MAX clamp (a titan release rides this at the call site). */
  clampThrow(vel: Vec3): Vec3 {
    return clampThrowVelocity(vel);
  }

  // -------------------------------------------------------------------------
  // OOB recall — SCOPED to titan-active (spec §7.7). Runs in the sim loop BEFORE
  // the physics step honors `removed`. A no-op when no titan is active, so the
  // baseline (non-titan) throw keeps the Phase B REMOVE_DISTANCE despawn.
  // -------------------------------------------------------------------------

  /**
   * While a titan is active, recall every NON-grabbed shape whose position is
   * beyond WORLD_RADIUS back INSIDE the world (respawned deterministically near
   * the origin). Returns the ids recalled (for a `state`/despawn-free reposition —
   * the shape is NOT despawned, so no despawn is broadcast; its new position rides
   * the next `state`). NO-OP (returns []) when no titan is active.
   */
  recallOutOfBounds(): string[] {
    const recalled: string[] = [];
    if (this._disposed || this._titanId === null) return recalled;

    for (const shape of this._world.shapes) {
      if (shape.grabbedBy !== null) continue; // don't yank a held shape
      if (!isTitanOutOfBounds(shape.position)) continue;
      const to = titanRecallPosition(shape.position, this._recallSeq++);
      shape.position.x = to.x;
      shape.position.y = to.y;
      shape.position.z = to.z;
      // Kill the outward velocity so it doesn't immediately fly out again.
      shape.velocity.x = 0;
      shape.velocity.y = 0;
      shape.velocity.z = 0;
      shape.grounded = false;
      recalled.push(shape.id);
    }
    return recalled;
  }

  // -------------------------------------------------------------------------
  // Presence snapshot (late-join playerScale for the avatar tiers)
  // -------------------------------------------------------------------------

  /** The active titan + scale for a late joiner's presence, or null if none. */
  snapshot(): TitanSnapshot | null {
    if (this._titanId === null) return null;
    return { peerId: this._titanId, scale: this._scale };
  }

  // -------------------------------------------------------------------------
  // Broadcast helper + teardown
  // -------------------------------------------------------------------------

  private _broadcastScale(peerId: string, scale: number, durationMs: number): void {
    if (this._disposed) return;
    this._opts.broadcast(OPCODES.PLAYER_SCALE, { peerId, scale, durationMs }, TITAN_TIERS);
  }

  dispose(): void {
    this._disposed = true;
    if (this._revertHandle !== null) {
      this._timer.clearTimeout(this._revertHandle);
      this._revertHandle = null;
    }
    this._titanId = null;
    this._scale = 1;
  }
}
