/**
 * persistence.ts — Debounced file-based room persistence.
 *
 * Injectable writeFile/readFile/now so the class is fully testable without
 * touching the real disk or wall clock.
 *
 * File format: <dir>/rooms/<roomId>.json  →  { shapes: NetShape[] }
 *
 * Security: roomId originates from client-controlled `join` messages. It is
 * validated (see ROOM_ID_RE) and the resolved path is confined to
 * <dir>/rooms before any I/O, so a malicious roomId cannot escape the data dir.
 */

import type { NetShape } from '@cyber-shapes/shared';
import { isValidPersistedShape } from '@cyber-shapes/shared';
import { resolve as resolvePath, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomPersistenceOpts {
  /** Root data directory. Room files are written to <dir>/rooms/<roomId>.json. */
  dir: string;
  /** Override for fs write (defaults to node:fs/promises writeFile + mkdir -p). */
  writeFile?: (path: string, data: string) => Promise<void>;
  /** Override for fs read (defaults to node:fs/promises readFile). */
  readFile?: (path: string) => Promise<string>;
  /**
   * Clock override (defaults to Date.now). Accepted for API compatibility;
   * debounce now uses an injectable timer (see setTimer) rather than a clock.
   */
  now?: () => number;
  /** Debounce window in ms. Rapid saves within this window coalesce. Default: 2000. */
  debounceMs?: number;
  /**
   * Injectable timer scheduler for debounce. Defaults to setTimeout/clearTimeout.
   * The setTimer return handle is opaque and only passed back to clearTimer.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// Path-safety
// ---------------------------------------------------------------------------

/**
 * Allowed roomId characters. Rejects `.`, `/`, `\`, `%`, and everything else
 * that could be used to escape <dir>/rooms via path traversal.
 */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Default fs helpers (real disk, no test usage)
// ---------------------------------------------------------------------------

async function defaultWriteFile(path: string, data: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, 'utf8');
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

// ---------------------------------------------------------------------------
// RoomPersistence
// ---------------------------------------------------------------------------

interface PendingEntry {
  /** Latest snapshot to write when the timer fires. */
  shapes: NetShape[];
  /** Debounce timer handle (from setTimer). */
  timer: unknown;
  /** Waiters resolved/rejected when the coalesced write completes. */
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class RoomPersistence {
  private readonly _dir: string;
  private readonly _writeFile: (path: string, data: string) => Promise<void>;
  private readonly _readFile: (path: string) => Promise<string>;
  private readonly _debounceMs: number;
  private readonly _setTimer: (cb: () => void, ms: number) => unknown;
  private readonly _clearTimer: (handle: unknown) => void;

  /** Pending debounced write per roomId. */
  private readonly _pending: Map<string, PendingEntry> = new Map();

  constructor(opts: RoomPersistenceOpts) {
    this._dir = opts.dir;
    this._writeFile = opts.writeFile ?? defaultWriteFile;
    this._readFile = opts.readFile ?? defaultReadFile;
    this._debounceMs = opts.debounceMs ?? 2000;
    this._setTimer =
      opts.setTimer ??
      ((cb, ms) => {
        const h = setTimeout(cb, ms);
        // Do not keep the event loop alive purely for a pending save.
        if (typeof h.unref === 'function') h.unref();
        return h;
      });
    this._clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Read <dir>/rooms/<roomId>.json.
   * Returns the shapes array, or null if the file is missing / malformed.
   * Never throws into the caller — EXCEPT for an invalid roomId (path-safety),
   * which is a programming/security error and must surface loudly.
   */
  async load(roomId: string): Promise<NetShape[] | null> {
    const path = this._roomPath(roomId);
    try {
      const raw = await this._readFile(path);
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'shapes' in parsed &&
        Array.isArray((parsed as { shapes: unknown }).shapes)
      ) {
        // Finding #9: drop any structurally-invalid shape (missing/NaN Vec3,
        // bad type) so a corrupted/hand-edited snapshot can never load a shape
        // that becomes an undespawnable NaN ghost. This is the SINGLE validation
        // point — the loaded array is already clean, so restore() must NOT
        // re-filter (dedup: load is the disk boundary and owns this check).
        const rawShapes = (parsed as { shapes: unknown[] }).shapes;
        const valid = rawShapes.filter((s) => {
          if (isValidPersistedShape(s)) return true;
          console.warn(
            `[persistence] ${path}: dropping malformed shape ${JSON.stringify(
              (s as { id?: unknown } | null)?.id
            )}`
          );
          return false;
        }) as NetShape[];
        return valid;
      }
      console.warn(`[persistence] ${path}: malformed (no shapes array) — ignoring`);
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[persistence] ${path}: read error (${String(err)}) — ignoring`);
      }
      return null;
    }
  }

  /**
   * Schedule a debounced write of `shapes` to <dir>/rooms/<roomId>.json.
   * (Re)arms a debounceMs timer; rapid calls within the window coalesce into a
   * single write of the LATEST snapshot. A timer fire flushes without any
   * explicit flush() call.
   */
  scheduleSave(roomId: string, shapes: NetShape[]): void {
    // Validate eagerly so a bad roomId can never arm a timer that later writes.
    this._roomPath(roomId);

    const existing = this._pending.get(roomId);
    if (existing) {
      // Same window: update the snapshot and re-arm the timer (debounce).
      existing.shapes = shapes;
      this._clearTimer(existing.timer);
      existing.timer = this._setTimer(() => {
        void this._flushOne(roomId);
      }, this._debounceMs);
      return;
    }

    // First call for this roomId in this window — create a deferred write entry.
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Never let an unobserved rejection crash the process; flush()/close() are
    // the intended observers, but a fire-and-forget timer write must be safe too.
    promise.catch(() => {});

    const timer = this._setTimer(() => {
      void this._flushOne(roomId);
    }, this._debounceMs);

    this._pending.set(roomId, { shapes, timer, promise, resolve, reject });
  }

  /**
   * Force pending write(s) to disk immediately, cancelling their debounce timer.
   * - flush(roomId) flushes only that room.
   * - flush() with no argument flushes all pending rooms.
   * Rejects if any underlying write rejects (aggregated for the all-rooms form).
   */
  async flush(roomId?: string): Promise<void> {
    if (roomId !== undefined) {
      await this._flushOne(roomId);
      return;
    }
    const results = await Promise.allSettled(
      [...this._pending.keys()].map((id) => this._flushOne(id))
    );
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `[persistence] ${errors.length} flush(es) failed`);
    }
  }

  /**
   * Flush all pending writes and stop. Rejects if any write fails.
   */
  async close(): Promise<void> {
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async _flushOne(roomId: string): Promise<void> {
    const entry = this._pending.get(roomId);
    if (!entry) return;

    // Cancel the debounce timer and remove from pending BEFORE writing so a
    // concurrent scheduleSave during the async write creates a fresh entry.
    this._clearTimer(entry.timer);
    this._pending.delete(roomId);

    const { shapes, resolve, reject } = entry;
    const path = this._roomPath(roomId);
    const data = JSON.stringify({ shapes });

    try {
      await this._writeFile(path, data);
      resolve();
    } catch (err) {
      // Surface AND log: a swallowed write error is silent data loss.
      console.error(`[persistence] failed to write ${path}:`, err);
      reject(err);
      throw err;
    }
  }

  /**
   * Build (and validate) the on-disk path for a room.
   * Throws on an invalid roomId or any path that escapes <dir>/rooms.
   */
  private _roomPath(roomId: string): string {
    if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) {
      throw new Error(`[persistence] invalid roomId: ${JSON.stringify(roomId)}`);
    }
    const roomsDir = resolvePath(this._dir, 'rooms');
    const fullPath = resolvePath(roomsDir, `${roomId}.json`);
    // Defence-in-depth: confirm the resolved path stays under <dir>/rooms even
    // though ROOM_ID_RE already forbids traversal characters.
    if (fullPath !== `${roomsDir}/${roomId}.json` && !fullPath.startsWith(`${roomsDir}/`)) {
      throw new Error(`[persistence] roomId escapes data dir: ${JSON.stringify(roomId)}`);
    }
    return fullPath;
  }
}
