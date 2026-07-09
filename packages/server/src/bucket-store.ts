/**
 * bucket-store.ts — Singleton accessor + reset semantics for the three
 * persistence buckets (spec §6.4).
 *
 * Semantics (canonical — all code must use this module as the single source of
 * truth for bucket reset behaviour):
 *
 *   getBucket('world')    → WorldBucket — RESET wipes this bucket per rotation.
 *   getBucket('guestbook')→ GuestbookBucket — NEVER wiped by rotation RESET;
 *                           wiped only by staff / day close.
 *   getBucket('dayStats') → DayStatsBucket — wiped at day close ONLY (after
 *                           the Closing Ceremony export). Survives rotation RESET.
 *   getBucket('layouts')  → LayoutBucket — named Workshop compositions incl. the
 *                           showroom baseline (spec §7.23). NEVER wiped by a
 *                           rotation RESET or day close; only staff-cleared. Part
 *                           of the §10 LAN-day export.
 *
 * Phase D note: the bucket name union gains 'league' in Phase D.
 * Keep the BucketName union IN THIS FILE so there is one place to extend it.
 *
 * Usage:
 *   import { initBuckets, getBucket, onRoomReset } from './bucket-store.js';
 *
 *   // At server start:
 *   initBuckets({ dir: dataDir, writeFile, readFile });
 *
 *   // In the RESET path (rotation handler):
 *   await onRoomReset(roomId);          // clears world; leaves guestbook + dayStats
 *
 *   // In the day-close path:
 *   await onDayClose(roomId);           // clears world + dayStats; leaves guestbook
 */

import { WorldBucket, GuestbookBucket, DayStatsBucket, LayoutBucket } from './buckets.js';
import type { BucketOpts } from './buckets.js';

// ---------------------------------------------------------------------------
// BucketName union (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Valid bucket names. Phase D will add 'league' — extend HERE only.
 * The union is used in getBucket()'s overloads for type-narrowed returns.
 */
export type BucketName = 'world' | 'guestbook' | 'dayStats' | 'layouts';

// ---------------------------------------------------------------------------
// Module-level bucket instances (initialised by initBuckets)
// ---------------------------------------------------------------------------

let _world: WorldBucket | null = null;
let _guestbook: GuestbookBucket | null = null;
let _dayStats: DayStatsBucket | null = null;
let _layouts: LayoutBucket | null = null;

// ---------------------------------------------------------------------------
// Init / reset
// ---------------------------------------------------------------------------

/**
 * Initialise the bucket singletons. Call once at server start (or in each
 * test — the store is replaced so tests are isolated).
 */
export function initBuckets(opts: BucketOpts): void {
  _world = new WorldBucket(opts);
  _guestbook = new GuestbookBucket(opts);
  _dayStats = new DayStatsBucket(opts);
  _layouts = new LayoutBucket(opts);
}

// ---------------------------------------------------------------------------
// getBucket — type-narrowed overloads
// ---------------------------------------------------------------------------

export function getBucket(name: 'world'): WorldBucket;
export function getBucket(name: 'guestbook'): GuestbookBucket;
export function getBucket(name: 'dayStats'): DayStatsBucket;
export function getBucket(name: 'layouts'): LayoutBucket;
export function getBucket(
  name: BucketName
): WorldBucket | GuestbookBucket | DayStatsBucket | LayoutBucket {
  switch (name) {
    case 'world':
      if (!_world) throw new Error('[bucket-store] initBuckets() not called before getBucket("world")');
      return _world;
    case 'guestbook':
      if (!_guestbook) throw new Error('[bucket-store] initBuckets() not called before getBucket("guestbook")');
      return _guestbook;
    case 'dayStats':
      if (!_dayStats) throw new Error('[bucket-store] initBuckets() not called before getBucket("dayStats")');
      return _dayStats;
    case 'layouts':
      if (!_layouts) throw new Error('[bucket-store] initBuckets() not called before getBucket("layouts")');
      return _layouts;
  }
}

// ---------------------------------------------------------------------------
// Reset semantics (spec §6.4) — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Called when the room rotates (RESET event, spec §6.4):
 *   - WORLD bucket: saved with an EMPTY shapes array (cleared for the next rotation).
 *   - GUESTBOOK: unchanged — survives rotation RESET.
 *   - DAYSTATS: unchanged — survives until day close.
 *
 * The caller must reload shapes from the (now-empty) world bucket after calling this.
 */
export async function onRoomReset(roomId: string): Promise<void> {
  if (!_world) throw new Error('[bucket-store] initBuckets() not called');
  _world.scheduleSave(roomId, []);
  await _world.flush(roomId);
}

/**
 * Called at day close (after the Closing Ceremony export):
 *   - WORLD bucket: cleared (empty shapes).
 *   - DAYSTATS bucket: cleared (purge after export); in-memory _taken set reset.
 *   - GUESTBOOK: unchanged — only cleared by explicit staff action;
 *     but the in-memory _callsigns set is also reset so stale data does not
 *     accumulate across days until a server restart (LOW finding fix, Task C8).
 *
 * Caller must call metrics.exportDay() BEFORE this so the stats are captured.
 */
export async function onDayClose(roomId: string): Promise<void> {
  if (!_world || !_dayStats || !_guestbook) throw new Error('[bucket-store] initBuckets() not called');
  _world.scheduleSave(roomId, []);
  await _world.flush(roomId);
  // dayStats: we delete by saving a fresh zeroed record rather than deleting the
  // file (keeps the schema stable and the file present for the next day's boot).
  const today = new Date().toISOString().slice(0, 10);
  _dayStats.scheduleSave(roomId, {
    date: today,
    callsignsTaken: [],
    rotations: 0,
  });
  await _dayStats.flush(roomId);
  // Clear in-memory sets so getCallsignsTaken/getCallsigns don't return stale
  // data until the next server restart (LOW finding: stale sets after day-close).
  _dayStats.clearTaken(roomId);
  _guestbook.clearCallsigns(roomId);
}
