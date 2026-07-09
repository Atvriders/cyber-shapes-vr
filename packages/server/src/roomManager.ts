/**
 * roomManager.ts — Manages a set of Rooms and assigns player IDs.
 *
 * Pure: no `ws`, no I/O. Shape IDs are globally unique across all rooms
 * using the pattern `${roomId}:${n}`.
 *
 * Optional RoomPersistence: if provided, getOrCreate is async and restores
 * persisted shapes on first create with stable ids.
 */

import type { ServerMsg, NetShape, Tier } from '@cyber-shapes/shared';
import { Room } from './room.js';
import type { RoomPersistence } from './persistence.js';

/**
 * Hard cap on concurrently live rooms (finding #6). Each room runs a 30 Hz sim
 * loop and (optionally) persists a file, so an attacker joining thousands of
 * distinct room names could exhaust CPU / disk. Beyond this, creating a NEW
 * room is rejected; existing rooms still accept joiners.
 */
export const MAX_ROOMS = 200;

export class RoomManager {
  /** Overridable cap (kept small in tests). Defaults to MAX_ROOMS. */
  private readonly _maxRooms: number;

  private readonly _rooms: Map<string, Room> = new Map();
  /**
   * In-flight (or completed) room creation, keyed by roomId. Caching the
   * Promise makes getOrCreate race-safe: a concurrent second joiner awaits the
   * SAME creation/restore and receives the fully-restored room, never an empty
   * one exposed mid-restore. Resolved entries are kept so the map doubles as
   * the "room exists" set for the async path.
   */
  private readonly _creating: Map<string, Promise<Room>> = new Map();
  /** Per-room player counter for assigning p0, p1, ... */
  private readonly _playerCounters: Map<string, number> = new Map();
  /** Optional persistence layer. */
  private readonly _persistence: RoomPersistence | null;

  constructor(persistence?: RoomPersistence | null, maxRooms: number = MAX_ROOMS) {
    this._persistence = persistence ?? null;
    this._maxRooms = maxRooms;
  }

  /** Number of live (published) rooms. */
  get roomCount(): number {
    return this._rooms.size;
  }

  /**
   * True if creating a brand-new room `roomId` is allowed. Existing/in-flight
   * rooms are always allowed (a joiner to an existing room is never blocked).
   *
   * Counts DISTINCT live room ids: a resolved room appears in BOTH `_rooms` and
   * `_creating` (the creation Promise is cached), so summing sizes would
   * double-count. We count `_rooms` plus any `_creating` id not yet published.
   */
  private _canCreate(roomId: string): boolean {
    if (this._rooms.has(roomId) || this._creating.has(roomId)) return true;
    let liveCount = this._rooms.size;
    for (const id of this._creating.keys()) {
      if (!this._rooms.has(id)) liveCount++;
    }
    return liveCount < this._maxRooms;
  }

  /**
   * Get the existing Room or create a fresh one.
   * Shape ids are globally unique: `${roomId}:${n}`.
   *
   * When a RoomPersistence is configured, this is async: it loads persisted
   * shapes on first create and restores them with stable ids.
   *
   * Race-safe: concurrent calls for the same roomId share one creation Promise,
   * so a second joiner awaits the same restore and observes the full snapshot.
   */
  async getOrCreate(roomId: string): Promise<Room> {
    const ready = this._rooms.get(roomId);
    if (ready) return ready;

    const inFlight = this._creating.get(roomId);
    if (inFlight) return inFlight;

    const creation = this._create(roomId);
    this._creating.set(roomId, creation);
    try {
      const room = await creation;
      return room;
    } catch (err) {
      // Failed creation must not poison future joins.
      this._creating.delete(roomId);
      throw err;
    }
  }

  /**
   * Build a room and (if persistence is configured) restore it BEFORE exposing
   * it in `_rooms`. The idFactory counter is seeded past the highest restored
   * shape index so the next spawn cannot collide with a restored id.
   */
  private async _create(roomId: string): Promise<Room> {
    let n = 0;
    const idFactory = () => `${roomId}:${n++}`;
    const room = new Room(roomId, idFactory, this._persistence);

    // Restore from persistence BEFORE publishing the room, so a concurrent
    // joiner awaiting the same Promise never sees a half-restored room.
    if (this._persistence) {
      const shapes = await this._persistence.load(roomId);
      if (shapes !== null && shapes.length > 0) {
        room.restore(shapes);
        // Seed the id counter past the highest restored `${roomId}:N` index so
        // the next spawn yields a fresh unique id (e.g. room:3), never a
        // duplicate of a restored id. Restore ids that don't match the
        // `${roomId}:N` pattern are ignored for seeding (defensive).
        n = maxRestoredIndex(roomId, shapes) + 1;
      }
    }

    this._rooms.set(roomId, room);
    return room;
  }

  /**
   * Join a room: assign a per-room player id (p0, p1, ...) and register with the room.
   * Returns `{error:'room-full'}` if the room is at capacity.
   *
   * Phase B compatibility shim: a plain `join` is a `resident` join (the Phase B
   * invariant — MAX_PLAYERS residents). Task C2's tiered path calls `joinTier`.
   */
  async join(
    roomId: string,
    name: string,
    color: number
  ): Promise<{ room: Room; playerId: string } | { error: string }> {
    return this.joinTier(roomId, 'resident', name, color);
  }

  /**
   * Task C2: tier-aware join. Assigns a per-room peerId (`p0, p1, …`) from ONE
   * monotonic counter shared across all tiers (so callsign attribution + voice
   * senderId stay globally unique in the room). Only `resident` connections
   * register as world `PlayerInfo` (the Phase B avatar players, cap MAX_PLAYERS);
   * a resident over that cap is the Phase B `room-full` hard rejection. Every
   * other tier gets a peerId + the room handle but does NOT consume a resident
   * slot (its per-tier cap is enforced at the connection layer via TIER_CAPS).
   */
  async joinTier(
    roomId: string,
    tier: Tier,
    name: string,
    color: number
  ): Promise<{ room: Room; playerId: string } | { error: string }> {
    // Finding #6: refuse to create a NEW room past the cap. Checked BEFORE any
    // await so a flood of distinct room names cannot each spin up a sim loop.
    if (!this._canCreate(roomId)) {
      return { error: 'server-full' };
    }
    const room = await this.getOrCreate(roomId);

    // Assign next peer id for this room (shared counter across all tiers).
    const counter = this._playerCounters.get(roomId) ?? 0;
    const playerId = `p${counter}`;

    if (tier === 'resident') {
      // Residents are world avatar players — cap-enforced by Room.addPlayer.
      const ok = room.addPlayer({ id: playerId, name, color });
      if (!ok) {
        // Do NOT consume the counter for a rejected resident.
        return { error: 'room-full' };
      }
    }

    this._playerCounters.set(roomId, counter + 1);
    return { room, playerId };
  }

  /**
   * Task C28 (F17 Daemon Crew): SYNCHRONOUS resident join for a room that ALREADY
   * exists (daemons are only summoned INTO a live room, so no create/restore await
   * is needed). Mirrors {@link joinTier}'s resident branch EXACTLY — the SAME
   * per-room peer counter and the SAME cap-enforced {@link Room.addPlayer} — so a
   * daemon has NO god-mode: over MAX_PLAYERS it is refused precisely like a human.
   * Returns the assigned peerId, or null (room-full, or no such live room). The
   * connection layer routes daemon summons through here; a real human always uses
   * the async {@link joinTier}.
   */
  joinResidentSync(roomId: string, name: string, color: number): string | null {
    const room = this._rooms.get(roomId);
    if (!room) return null;
    const counter = this._playerCounters.get(roomId) ?? 0;
    const playerId = `p${counter}`;
    // Cap-enforced by Room.addPlayer (MAX_PLAYERS) — a daemon at cap is refused.
    if (!room.addPlayer({ id: playerId, name, color })) return null;
    this._playerCounters.set(roomId, counter + 1);
    return playerId;
  }

  /**
   * Remove a player from a room, dropping the room if it becomes empty.
   * Returns the ServerMsg[] produced by room.removePlayer.
   *
   * `keepAlive` (Task C2): when the caller knows the room still has live
   * connections that are NOT world players (wisps/crowd/spectators watching a
   * resident-less room), it passes `keepAlive: true` so the room object (and its
   * world shapes) survives past the last resident. The connection layer, which
   * owns the authoritative per-room socket set, sets this. Default `false`
   * preserves Phase B behavior (resident-only rooms drop with their last player).
   */
  leave(roomId: string, playerId: string, keepAlive = false): ServerMsg[] {
    const room = this._rooms.get(roomId);
    if (!room) return [];
    const events = room.removePlayer(playerId);
    if (room.isEmpty && !keepAlive) {
      this.dropRoom(roomId);
    }
    return events;
  }

  /**
   * Task C2: explicitly drop a room (called by the connection layer when the
   * last SOCKET — of any tier — leaves, so a wisp-only room is reclaimed too).
   */
  dropRoom(roomId: string): void {
    this._rooms.delete(roomId);
    this._creating.delete(roomId);
    this._playerCounters.delete(roomId);
  }

  get(roomId: string): Room | undefined {
    return this._rooms.get(roomId);
  }
}

/**
 * Highest numeric suffix among restored shape ids matching `${roomId}:N`.
 * Ids that don't match the pattern (or have a non-numeric suffix) are ignored,
 * so a garbled snapshot can't break seeding. Returns -1 if none match (so the
 * caller's `+1` yields 0).
 */
function maxRestoredIndex(roomId: string, shapes: NetShape[]): number {
  const prefix = `${roomId}:`;
  let max = -1;
  for (const s of shapes) {
    if (typeof s.id !== 'string' || !s.id.startsWith(prefix)) continue;
    const suffix = s.id.slice(prefix.length);
    // Strict integer suffix only (reject "1a", "1.5", "", "-1", etc.)
    if (!/^\d+$/.test(suffix)) continue;
    const idx = Number(suffix);
    if (Number.isSafeInteger(idx) && idx > max) max = idx;
  }
  return max;
}
