/**
 * roomManager.ts — Manages a set of Rooms and assigns player IDs.
 *
 * Pure: no `ws`, no I/O. Shape IDs are globally unique across all rooms
 * using the pattern `${roomId}:${n}`.
 *
 * Optional RoomPersistence: if provided, getOrCreate is async and restores
 * persisted shapes on first create with stable ids.
 */

import type { ServerMsg, NetShape } from '@cyber-shapes/shared';
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
   */
  async join(
    roomId: string,
    name: string,
    color: number
  ): Promise<{ room: Room; playerId: string } | { error: string }> {
    // Finding #6: refuse to create a NEW room past the cap. Checked BEFORE any
    // await so a flood of distinct room names cannot each spin up a sim loop.
    if (!this._canCreate(roomId)) {
      return { error: 'server-full' };
    }
    const room = await this.getOrCreate(roomId);

    // Assign next player id for this room
    const counter = this._playerCounters.get(roomId) ?? 0;
    const playerId = `p${counter}`;
    this._playerCounters.set(roomId, counter + 1);

    const ok = room.addPlayer({ id: playerId, name, color });
    if (!ok) {
      return { error: 'room-full' };
    }

    return { room, playerId };
  }

  /**
   * Remove a player from a room, drop the room if it becomes empty.
   * Returns the ServerMsg[] produced by room.removePlayer.
   */
  leave(roomId: string, playerId: string): ServerMsg[] {
    const room = this._rooms.get(roomId);
    if (!room) return [];
    const events = room.removePlayer(playerId);
    if (room.isEmpty) {
      this._rooms.delete(roomId);
      this._creating.delete(roomId);
      this._playerCounters.delete(roomId);
    }
    return events;
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
