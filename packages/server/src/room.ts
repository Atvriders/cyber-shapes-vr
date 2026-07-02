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
  MAX_PLAYERS,
  MAX_SHAPES,
} from '@cyber-shapes/shared';
import { ServerWorld } from './serverWorld.js';
import type { RoomPersistence } from './persistence.js';

/** Small velocity threshold below which a shape is considered "at rest" for tick inclusion. */
const VELOCITY_EPSILON = 0.01;

export class Room {
  readonly roomId: string;

  private readonly _world: ServerWorld;
  private readonly _players: Map<string, PlayerInfo> = new Map();
  private _seq = 0;
  private readonly _persistence: RoomPersistence | null;

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
   * Restore previously persisted shapes into the world (stable ids, no idFactory).
   */
  restore(shapes: NetShape[]): void {
    this._world.restore(shapes);
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
        if (!ok) return [];
        result = [{ t: 'grab', id: msg.id, peerId: playerId }];
        dirty = true;
        break;
      }

      case 'release': {
        const ok = this._world.release(msg.id, playerId, msg.velocity, msg.position, msg.rotation);
        if (!ok) return [];
        result = [{ t: 'grab', id: msg.id, peerId: null }];
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
   */
  tick(dt: number): ServerMsg[] {
    const { removed } = this._world.step(dt);
    const broadcasts: ServerMsg[] = [];

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
        shapes: movingShapes.map((s) => ({
          id: s.id,
          p: { ...s.position },
          r: { ...s.rotation },
          v: { ...s.velocity },
        })),
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
   */
  snapshotFor(playerId: string): ServerMsg {
    return {
      t: 'welcome',
      playerId,
      room: this.roomId,
      shapes: this._world.shapes,
      players: [...this._players.values()],
    };
  }
}
