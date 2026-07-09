/**
 * room.ts — Pure, I/O-free room abstraction wrapping a ServerWorld.
 *
 * No `ws`, no I/O — all side-effects travel through returned ServerMsg arrays.
 * The WebSocket wiring lives in B3.
 */

import {
  type ClientMsg,
  type ServerMsg,
  type PlayerInfo,
  type NetShape,
  type Vec3,
  type PhysicsParams,
  type PhysicsBody,
  type ShapeType,
  MAX_PLAYERS,
  MAX_SHAPES,
  applyRadialImpulse,
  clampPulseMagnitude,
} from '@cyber-shapes/shared';
import { ServerWorld } from './serverWorld.js';
import type { RoomPersistence } from './persistence.js';

/** Small velocity threshold below which a shape is considered "at rest" for tick inclusion. */
const VELOCITY_EPSILON = 0.01;

/**
 * Task C18 (F8 Resonora): one enriched floor impact — shape facts + impactSpeed +
 * an attributed player key — the server Conductor scores into a MUSIC_NOTE. Shaped
 * to the Conductor's `ImpactInput` (which is a superset with an optional p95).
 */
export interface ResonoraImpact {
  shapeId: string;
  playerId: string;
  colorIndex: number;
  type: ShapeType;
  size: number;
  impactSpeed: number;
  posX: number;
}

export class Room {
  readonly roomId: string;

  private readonly _world: ServerWorld;
  private readonly _players: Map<string, PlayerInfo> = new Map();
  private _seq = 0;
  /**
   * Phase C accommodation #2 (spec §3, C0): a u32 PHYSICS-tick counter, bumped
   * once per `tick()` (30 Hz) — distinct from `_seq` (bumped per `state`
   * broadcast, ~15 Hz). Stamped into every `state` message as `serverTick`.
   * Wraps at 2³² (roomEpoch re-issue handles process lifetime, spec Appendix B).
   */
  private _serverTick = 0;
  private readonly _persistence: RoomPersistence | null;
  /**
   * Phase C accommodation #4 (spec §3, C0): when true, a rejected grab is ALSO
   * returned as a broadcastable `grab-rejected` event (alongside Phase B's
   * existing "loser gets nothing" behavior — the successful-grab and no-op paths
   * are untouched). Off by default so Phase B behavior is bit-identical until a
   * later task (C9/C21) opts in. Never REPLACES existing behavior.
   */
  private _broadcastGrabRejections = false;

  /**
   * Task C18 (F8 Resonora): the enriched floor-impact list from the MOST RECENT
   * `tick()`, exposed for the server Conductor to score into MUSIC_NOTE events.
   * This is a pure read-only capture — it does NOT change the `ServerMsg[]` the
   * tick returns (so the Phase B / C0 broadcast path is bit-identical). Empty on
   * a tick with no floor impacts. The Conductor (a sibling host) reads it via
   * {@link lastImpacts}; nothing here depends on the Conductor (cut-safe).
   */
  private _lastImpacts: ResonoraImpact[] = [];

  constructor(roomId: string, idFactory: () => string, persistence: RoomPersistence | null = null) {
    this.roomId = roomId;
    this._world = new ServerWorld({ maxShapes: MAX_SHAPES, idFactory });
    this._persistence = persistence;
  }

  // ---------------------------------------------------------------------------
  // World shape access (for persistence / tests)
  // ---------------------------------------------------------------------------

  get worldShapes(): NetShape[] {
    return this._world.shapes;
  }

  /**
   * Task C18 (F8 Resonora): the enriched floor impacts from the most recent
   * `tick()` (empty if none). The server Conductor reads this each tick to score
   * MUSIC_NOTE events. Read-only; a sibling host, never a dependency of the tick.
   */
  lastImpacts(): readonly ResonoraImpact[] {
    return this._lastImpacts;
  }

  /**
   * The authoritative ServerWorld this room wraps. Exposed so the C10
   * RoomTimelineHost can build its RoomHandle over the SAME world the sim ticks
   * (cue spawn/pin/remove must hit the live world, not a copy). The host only
   * touches spawn/remove/pin/unpin/get + reads the shape list.
   */
  get world(): ServerWorld {
    return this._world;
  }

  /**
   * Restore previously persisted shapes into the world (stable ids, no idFactory).
   */
  restore(shapes: NetShape[]): void {
    this._world.restore(shapes);
  }

  /**
   * Current u32 physics-tick counter (accommodation #2). Exposed for tests and
   * for later tasks (C21 replay) that key off serverTick.
   */
  get serverTick(): number {
    return this._serverTick;
  }

  /**
   * Phase C accommodation #4 (spec §3, C0): opt into broadcastable grab
   * rejections. OFF by default — Phase B behavior is unchanged until a later
   * task (C9/C21) enables it. This never replaces the existing grab paths.
   */
  setBroadcastGrabRejections(on: boolean): void {
    this._broadcastGrabRejections = on;
  }

  // ---------------------------------------------------------------------------
  // Player management
  // ---------------------------------------------------------------------------

  get playerCount(): number {
    return this._players.size;
  }

  get isEmpty(): boolean {
    return this._players.size === 0;
  }

  /**
   * Register a new player. Returns false (no-op) if the room is at MAX_PLAYERS.
   */
  addPlayer(info: PlayerInfo): boolean {
    if (this._players.size >= MAX_PLAYERS) return false;
    this._players.set(info.id, info);
    return true;
  }

  /**
   * Unregister a player.
   * Releases any shapes that player was grabbing → emits {t:'grab', id, peerId:null} for each.
   * Always emits {t:'player-leave', id} last.
   */
  removePlayer(id: string): ServerMsg[] {
    const events: ServerMsg[] = [];

    // Release every shape grabbed by this player. Use forceRelease (NOT
    // release), which clears grabbedBy UNCONDITIONALLY: if the departing
    // player's held shape has a non-finite in-memory transform, release()'s
    // finite-Vec3 guard would return false and leave grabbedBy pinned to the
    // departed player forever (peers were already told peerId:null) — a
    // permanently-locked shape. forceRelease side-steps that validation.
    for (const shape of this._world.shapes) {
      if (shape.grabbedBy === id) {
        this._world.forceRelease(shape.id, id);
        events.push({ t: 'grab', id: shape.id, peerId: null });
      }
    }

    this._players.delete(id);
    events.push({ t: 'player-leave', id });
    return events;
  }

  // ---------------------------------------------------------------------------
  // Intent handling
  // ---------------------------------------------------------------------------

  /**
   * Validate + mutate the world and return the authoritative events to broadcast.
   */
  applyIntent(playerId: string, msg: ClientMsg): ServerMsg[] {
    let dirty = false;
    let result: ServerMsg[] = [];

    switch (msg.t) {
      case 'spawn': {
        // spawn returns null on rejected (non-finite) input — the connection
        // layer already gates this, so on the real path spawned is never null;
        // an internal caller passing a bad shape gets a silent no-op.
        const spawned = this._world.spawn(msg.shape);
        if (!spawned) return [];
        const { shape, evictedId } = spawned;
        // Echo the client's opaque tempId (if any) so the originating client can
        // correlate this canonical shape with its predicted local shape and re-key
        // instead of creating a duplicate. tempId is NEVER trusted for anything but
        // this passthrough — the server assigns the canonical shape.id.
        result = [
          { t: 'spawn', shape, ...(msg.tempId !== undefined ? { tempId: msg.tempId } : {}) },
        ];
        // Finding #8: if spawning evicted the oldest shape (MAX_SHAPES), tell
        // peers to despawn it — otherwise they keep a ghost of it forever.
        if (evictedId !== null) {
          result.push({ t: 'despawn', id: evictedId });
        }
        dirty = true;
        break;
      }

      case 'grab': {
        const ok = this._world.grab(msg.id, playerId);
        if (!ok) {
          // Phase C accommodation #4 (spec §3, C0): ADDITIVELY expose a
          // broadcastable rejection. Phase B behavior (return []) is preserved
          // unless a later task opts in via setBroadcastGrabRejections(true).
          // Never emitted when the grab merely no-ops on an absent/self-held
          // shape — only when a DIFFERENT peer already holds it (a real duel).
          if (this._broadcastGrabRejections) {
            const shape = this._world.get(msg.id);
            if (shape && shape.grabbedBy !== null && shape.grabbedBy !== playerId) {
              return [{ t: 'grab-rejected', id: msg.id, peerId: playerId, by: shape.grabbedBy }];
            }
          }
          return [];
        }
        result = [{ t: 'grab', id: msg.id, peerId: playerId }];
        dirty = true;
        break;
      }

      case 'release': {
        const ok = this._world.release(msg.id, playerId, msg.velocity, msg.position, msg.rotation);
        if (!ok) return [];
        // Phase C accommodation #5 (spec §3, C0): the release event carries the
        // server-computed final {pos, vel} (needed by C30; harmless to Phase B
        // clients, which ignore the extra fields). Read them back from the world
        // so they are the authoritative post-release values, not the raw intent.
        const released = this._world.get(msg.id);
        const grabEvent: ServerMsg = released
          ? {
              t: 'grab',
              id: msg.id,
              peerId: null,
              pos: { ...released.position },
              vel: { ...released.velocity },
            }
          : { t: 'grab', id: msg.id, peerId: null };
        result = [grabEvent];
        dirty = true;
        break;
      }

      case 'recolor': {
        // Finding #18: no-op on a nonexistent id → no broadcast, no save.
        const ok = this._world.setColor(msg.id, msg.colorIndex);
        if (!ok) return [];
        result = [{ t: 'recolor', id: msg.id, colorIndex: msg.colorIndex }];
        dirty = true;
        break;
      }

      case 'rendermode': {
        // Finding #18: no-op on a nonexistent id → no broadcast, no save.
        const ok = this._world.setRenderMode(msg.id, msg.mode);
        if (!ok) return [];
        result = [{ t: 'rendermode', id: msg.id, mode: msg.mode }];
        dirty = true;
        break;
      }

      case 'scale': {
        // Finding #18: no-op on a nonexistent id → no broadcast, no save.
        const ok = this._world.setScale(msg.id, msg.scale);
        if (!ok) return [];
        result = [{ t: 'scale', id: msg.id, scale: msg.scale }];
        dirty = true;
        break;
      }

      case 'held': {
        this._world.setHeld(msg.id, playerId, msg.position, msg.rotation);
        // Held transform rides the periodic `state` snapshot; no discrete broadcast.
        return [];
      }

      case 'pose': {
        // Relay to others; caller (B3) is responsible for excluding the sender.
        return [{ t: 'pose', id: playerId, pose: msg.pose }];
      }

      // join and voice-* are handled at the connection layer (B3)
      default:
        return [];
    }

    if (dirty && this._persistence) {
      this._persistence.scheduleSave(this.roomId, this._world.shapes);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Tick — physics step + state snapshot
  // ---------------------------------------------------------------------------

  /**
   * Advance physics by `dt` seconds.
   * Returns broadcasts: one `state` message for all "moving" shapes,
   * plus a `despawn` for each out-of-bounds removal.
   *
   * "Moving" = grabbed OR not grounded OR velocity magnitude > VELOCITY_EPSILON.
   *
   * `params` (C10 single-overlay host) is the effective PhysicsParams the sim
   * steps under this tick — the timeline host's merged base+overlay. It DEFAULTS
   * to DEFAULT_PARAMS (via ServerWorld.step's default), so every existing caller
   * and Phase B parity are bit-identical.
   */
  tick(dt: number, params?: PhysicsParams): ServerMsg[] {
    const { impacts, removed } = params ? this._world.step(dt, params) : this._world.step(dt);
    // Bump the physics-tick counter every tick (whether or not a `state` is
    // emitted this tick) so serverTick reflects real sim time (accommodation #2).
    this._serverTick = (this._serverTick + 1) >>> 0; // u32 wrap
    const broadcasts: ServerMsg[] = [];

    // Phase C accommodation #3 (spec §3, C0): index this tick's floor impacts by
    // shape id so the `state` message can carry the authoritative impactSpeed for
    // any shape that struck the floor this tick (consumed by Resonora / Chrono Snap).
    const impactSpeedById = new Map<string, number>();
    for (const im of impacts) impactSpeedById.set(im.id, im.speed);

    // Task C18 (F8 Resonora): capture the enriched impact list for the Conductor
    // (shape facts → note pitch/timbre/octave; impactSpeed → velocity; grabber →
    // per-player budget/noteId, falling back to the shape id when the thrower is
    // no longer holding it). Read-only; does not alter the returned events.
    this._lastImpacts = impacts.map((im) => {
      const shape = this._world.get(im.id);
      return {
        shapeId: im.id,
        playerId: shape?.grabbedBy ?? im.id,
        colorIndex: shape?.colorIndex ?? 0,
        type: (shape?.type ?? 'cube') as ShapeType,
        size: shape?.scale ?? 1,
        impactSpeed: im.speed,
        posX: shape?.position.x ?? 0,
      };
    });

    // Build the moving-shapes snapshot
    const movingShapes = this._world.shapes.filter((s) => {
      if (s.grabbedBy !== null) return true;
      if (!s.grounded) return true;
      const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
      return speed > VELOCITY_EPSILON;
    });

    if (movingShapes.length > 0) {
      broadcasts.push({
        t: 'state',
        seq: ++this._seq,
        serverTick: this._serverTick,
        shapes: movingShapes.map((s) => {
          const entry: { id: string; p: Vec3; r: Vec3; v: Vec3; s?: number } = {
            id: s.id,
            p: { ...s.position },
            r: { ...s.rotation },
            v: { ...s.velocity },
          };
          const impactSpeed = impactSpeedById.get(s.id);
          if (impactSpeed !== undefined) entry.s = impactSpeed;
          return entry;
        }),
      });
    }

    // Emit despawn for each removed shape
    for (const id of removed) {
      broadcasts.push({ t: 'despawn', id });
    }

    // Schedule persistence after removals
    if (removed.length > 0 && this._persistence) {
      this._persistence.scheduleSave(this.roomId, this._world.shapes);
    }

    return broadcasts;
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  /**
   * Build the full welcome payload for a newly joining player.
   *
   * Task C22 (carry #1, laws-chip-on-join): `baseParams` is the room's
   * STANDING law (the caller passes the RoomTimelineHost's `baseParams` — the
   * elected law, or DEFAULT_PARAMS when none stands) as an ADDITIVE field.
   * This is deliberately NOT the EFFECTIVE params (which also carry a transient
   * cue overlay, sent separately via ENV_STATE right after welcome) — a joiner's
   * laws chip must reflect the STANDING law immediately, not wait for the next
   * VOTE_RESULT (spec §7.5 / §7.22).
   */
  snapshotFor(playerId: string, baseParams: PhysicsParams): ServerMsg {
    return {
      t: 'welcome',
      playerId,
      room: this.roomId,
      shapes: this._world.shapes,
      players: [...this._players.values()],
      baseParams,
    };
  }
}

// ---------------------------------------------------------------------------
// Task C14 (F4 Wisp Protocol) — server-validated WISP_PULSE application.
//
// A wisp fires a pulse claiming an epicenter + a magnitude. The server NEVER
// trusts the client magnitude (anti-cheat, spec §7.4): it CLAMPS it via the
// shared `clampPulseMagnitude` and applies the resulting radial impulse to the
// live world through the shared, SEEDED `applyRadialImpulse` (deterministic —
// no Math.random). Grabbed bodies are exempt (applyRadialImpulse skips them).
//
// The unclamped cosmetic feedback (wisp-colored tracer + 300 ms flash +
// shockwave ring) is a CLIENT concern and is not applied here — it never touches
// the authoritative world. The per-socket 2/s TOKEN BUCKET that gates whether a
// pulse reaches this function lives in the connection layer (WispPulseBucket).
// ---------------------------------------------------------------------------

/**
 * Apply a server-clamped WISP_PULSE radial impulse to a room's world.
 *
 * @param room            the target room.
 * @param epicenter       the pulse origin (the wisp's aimed point).
 * @param clientMagnitude the CLIENT-SENT magnitude — clamped, never trusted.
 * @param seed            deterministic jitter seed (u32) for `applyRadialImpulse`.
 * @returns the clamped magnitude actually applied (0 → no-op impulse).
 */
export function applyWispPulse(
  room: Room,
  epicenter: Vec3,
  clientMagnitude: number,
  seed: number
): number {
  const magnitude = clampPulseMagnitude(clientMagnitude);
  if (magnitude <= 0) return 0; // negative/NaN/zero → the world feels nothing.

  // Build PhysicsBody views over the live shapes (same object references for
  // position/velocity, so applyRadialImpulse's velocity writes go straight
  // through to the world — mirrors ServerWorld.step's body view).
  const bodies: PhysicsBody[] = room.world.shapes.map((s) => ({
    position: s.position,
    velocity: s.velocity,
    scale: s.scale,
    type: s.type,
    grabbedBy: s.grabbedBy,
    grounded: s.grounded,
  }));
  applyRadialImpulse(bodies, epicenter, magnitude, seed >>> 0);
  return magnitude;
}
