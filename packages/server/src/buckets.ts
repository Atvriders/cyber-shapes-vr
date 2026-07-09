/**
 * buckets.ts — Persistence buckets for world / guestbook / dayStats (spec §6.4).
 *
 * Three separate file-backed stores under <DATA_DIR>/buckets/<name>/<roomId>.json.
 * Each bucket reuses Phase B's proven persistence safety patterns:
 *   - Injected writeFile / readFile / timers (fully testable, no real disk in tests).
 *   - Debounced writes with LATEST-wins coalescing.
 *   - Validate-on-load (drop malformed entries, never throw into caller).
 *   - Path-traversal guard via BUCKET_ID_RE (same character set as ROOM_ID_RE).
 *   - Write errors on flush propagate (reject) — no silent data loss.
 *
 * File layout:
 *   <dir>/buckets/world/<roomId>.json      → { shapes: NetShape[] }
 *   <dir>/buckets/guestbook/<roomId>.json  → { glyphs: GlyphEntry[] }
 *   <dir>/buckets/dayStats/<roomId>.json   → DayStats (object)
 *
 * Semantics (spec §6.4):
 *   - world     : reset per rotation; survives server restart between rotations.
 *   - guestbook : NEVER wiped by rotation RESET; wiped only by staff / day close.
 *   - dayStats  : wiped at day close (after Closing Ceremony export).
 *
 * Callsign uniqueness (spec §6.1):
 *   C2 checks active roster only. C8 (this task) provides the API:
 *   - GuestbookBucket.getCallsigns(roomId) — glyph attribution callsigns.
 *   - DayStatsBucket.getCallsignsTaken(roomId) — day-scope taken set.
 *   Full wiring of uniqueness check into connection.ts is DEFERRED to C8/C9 (when
 *   the room manager is extended to query buckets before assigning callsigns).
 */

import type { NetShape, Layout } from '@cyber-shapes/shared';
import { isValidPersistedShape, validateLayout } from '@cyber-shapes/shared';
import { resolve as resolvePath, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Options common to every bucket class. */
export interface BucketOpts {
  /** Root data directory. Files are written under <dir>/buckets/<kind>/. */
  dir: string;
  /** Override for fs write (defaults to node:fs/promises writeFile + mkdir -p). */
  writeFile?: (path: string, data: string) => Promise<void>;
  /** Override for fs read (defaults to node:fs/promises readFile). */
  readFile?: (path: string) => Promise<string>;
  /** Debounce window in ms. Default: 2000. */
  debounceMs?: number;
  /**
   * Injectable timer scheduler for debounce. Defaults to setTimeout/clearTimeout.
   * Return handle is opaque; only passed back to clearTimer.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// ---------------------------------------------------------------------------
// GlyphEntry (shared between guestbook bucket and C12's glyph handler)
// ---------------------------------------------------------------------------

export interface GlyphEntry {
  id: string;
  callsign: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  slotIndex: number;
  /** Seeded glyphs are exempt from evict-oldest (spec §7.23). */
  seeded?: boolean;
}

function isValidGlyph(g: unknown): g is GlyphEntry {
  if (!g || typeof g !== 'object') return false;
  const obj = g as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['callsign'] === 'string' &&
    Array.isArray(obj['points']) &&
    typeof obj['color'] === 'string' &&
    typeof obj['slotIndex'] === 'number' &&
    isFinite(obj['slotIndex'] as number)
  );
}

// ---------------------------------------------------------------------------
// DayStats (schema for the dayStats bucket)
// ---------------------------------------------------------------------------

export interface DayStats {
  /** ISO date string YYYY-MM-DD (the day this record covers). */
  date: string;
  /** All callsigns assigned in this room today (for uniqueness extension). */
  callsignsTaken: string[];
  /** Optional leaderboard: fastest throw of the day. */
  fastestThrow?: { callsign: string; speedMs: number };
  /** Optional leaderboard: top contributor. */
  topContributor?: { callsign: string; count: number };
  /** Number of completed rotations today. */
  rotations: number;
}

function isValidDayStats(d: unknown): d is DayStats {
  if (!d || typeof d !== 'object') return false;
  const obj = d as Record<string, unknown>;
  return (
    typeof obj['date'] === 'string' &&
    Array.isArray(obj['callsignsTaken']) &&
    typeof obj['rotations'] === 'number' &&
    isFinite(obj['rotations'] as number)
  );
}

// ---------------------------------------------------------------------------
// Path-safety (mirrors ROOM_ID_RE from persistence.ts)
// ---------------------------------------------------------------------------

/**
 * Allowed bucket id characters. Rejects `.`, `/`, `\`, `%`, and all traversal
 * characters. Identical constraints to Phase B's ROOM_ID_RE.
 */
export const BUCKET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Default fs helpers (real disk; never used in tests)
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
// BaseBucket — shared debounce + path-guard + flush/close logic
// ---------------------------------------------------------------------------

interface PendingEntry<T> {
  value: T;
  timer: unknown;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

abstract class BaseBucket<T> {
  protected readonly _dir: string;
  protected readonly _kind: string;
  protected readonly _writeFile: (path: string, data: string) => Promise<void>;
  protected readonly _readFile: (path: string) => Promise<string>;
  protected readonly _debounceMs: number;
  protected readonly _setTimer: (cb: () => void, ms: number) => unknown;
  protected readonly _clearTimer: (handle: unknown) => void;

  private readonly _pending: Map<string, PendingEntry<T>> = new Map();

  constructor(kind: string, opts: BucketOpts) {
    this._dir = opts.dir;
    this._kind = kind;
    this._writeFile = opts.writeFile ?? defaultWriteFile;
    this._readFile = opts.readFile ?? defaultReadFile;
    this._debounceMs = opts.debounceMs ?? 2000;
    this._setTimer =
      opts.setTimer ??
      ((cb, ms) => {
        const h = setTimeout(cb, ms);
        if (typeof (h as { unref?: () => void }).unref === 'function') {
          (h as { unref: () => void }).unref();
        }
        return h;
      });
    this._clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Schedule a debounced write. Re-arms within the window (LATEST-wins coalescing).
   * Validates the id eagerly — a bad id never arms a timer.
   */
  scheduleSave(id: string, value: T): void {
    this._bucketPath(id); // throws on invalid id

    const existing = this._pending.get(id);
    if (existing) {
      existing.value = value;
      this._clearTimer(existing.timer);
      existing.timer = this._setTimer(() => void this._flushOne(id), this._debounceMs);
      return;
    }

    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {}); // prevent unhandled rejection on fire-and-forget

    const timer = this._setTimer(() => void this._flushOne(id), this._debounceMs);
    this._pending.set(id, { value, timer, promise, resolve, reject });
  }

  /**
   * Force pending write(s) to disk immediately.
   * - flush(id) flushes that id only.
   * - flush()   flushes all pending ids.
   * Rejects if any underlying write rejects.
   */
  async flush(id?: string): Promise<void> {
    if (id !== undefined) {
      await this._flushOne(id);
      return;
    }
    const results = await Promise.allSettled(
      [...this._pending.keys()].map((k) => this._flushOne(k))
    );
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `[buckets:${this._kind}] ${errors.length} flush(es) failed`);
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  // ---------------------------------------------------------------------------
  // Subclass contract
  // ---------------------------------------------------------------------------

  protected abstract serialize(value: T): string;
  protected abstract deserialize(raw: string): T | null;

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async _flushOne(id: string): Promise<void> {
    const entry = this._pending.get(id);
    if (!entry) return;

    this._clearTimer(entry.timer);
    this._pending.delete(id);

    const { value, resolve, reject } = entry;
    const path = this._bucketPath(id);
    const data = this.serialize(value);

    try {
      await this._writeFile(path, data);
      resolve();
    } catch (err) {
      console.error(`[buckets:${this._kind}] failed to write ${path}:`, err);
      reject(err);
      throw err;
    }
  }

  protected _bucketPath(id: string): string {
    if (typeof id !== 'string' || !BUCKET_ID_RE.test(id)) {
      throw new Error(`[buckets:${this._kind}] invalid id: ${JSON.stringify(id)}`);
    }
    const kindDir = resolvePath(this._dir, 'buckets', this._kind);
    const fullPath = resolvePath(kindDir, `${id}.json`);
    // Defence-in-depth: confirm the resolved path stays under <dir>/buckets/<kind>/.
    if (fullPath !== `${kindDir}/${id}.json` && !fullPath.startsWith(`${kindDir}/`)) {
      throw new Error(`[buckets:${this._kind}] id escapes data dir: ${JSON.stringify(id)}`);
    }
    return fullPath;
  }

  protected async _readRaw(id: string): Promise<string | null> {
    const path = this._bucketPath(id);
    try {
      return await this._readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[buckets:${this._kind}] ${path}: read error (${String(err)}) — ignoring`);
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// WorldBucket — shapes (reset per rotation, validate-on-load via isValidPersistedShape)
// ---------------------------------------------------------------------------

export class WorldBucket extends BaseBucket<NetShape[]> {
  constructor(opts: BucketOpts) {
    super('world', opts);
  }

  /**
   * Load shapes from disk. Returns null if the file is missing or malformed.
   * Drops individual malformed shapes (finding #9 pattern from Phase B) so
   * corrupted entries never become NaN ghosts.
   */
  async load(roomId: string): Promise<NetShape[] | null> {
    const raw = await this._readRaw(roomId);
    if (raw === null) return null;
    return this.deserialize(raw);
  }

  protected serialize(shapes: NetShape[]): string {
    return JSON.stringify({ shapes });
  }

  protected deserialize(raw: string): NetShape[] | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'shapes' in parsed &&
        Array.isArray((parsed as { shapes: unknown }).shapes)
      ) {
        const rawShapes = (parsed as { shapes: unknown[] }).shapes;
        const valid = rawShapes.filter((s) => {
          if (isValidPersistedShape(s)) return true;
          console.warn(
            `[buckets:world] dropping malformed shape ${JSON.stringify(
              (s as { id?: unknown } | null)?.id
            )}`
          );
          return false;
        }) as NetShape[];
        return valid;
      }
      console.warn(`[buckets:world] malformed (no shapes array) — ignoring`);
      return null;
    } catch {
      console.warn(`[buckets:world] invalid JSON — ignoring`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// GuestbookBucket — glyphs (never wiped by rotation RESET)
// ---------------------------------------------------------------------------

export class GuestbookBucket extends BaseBucket<GlyphEntry[]> {
  /** In-memory callsign set per room (populated on load; used for uniqueness check API). */
  private readonly _callsigns: Map<string, Set<string>> = new Map();

  constructor(opts: BucketOpts) {
    super('guestbook', opts);
  }

  /**
   * Load glyphs from disk. Returns an empty array (not null) if missing —
   * an absent guestbook is a valid initial state (no glyphs yet), not an error.
   * Drops malformed entries.
   */
  async load(roomId: string): Promise<GlyphEntry[]> {
    const raw = await this._readRaw(roomId);
    if (raw === null) return [];
    const result = this.deserialize(raw);
    if (result !== null) {
      // Rebuild the in-memory callsign set from the loaded glyphs.
      this._callsigns.set(roomId, new Set(result.map((g) => g.callsign)));
    }
    return result ?? [];
  }

  /**
   * Return the set of callsigns that have glyphs in the guestbook for this room.
   * Used by C9+ to extend callsign uniqueness beyond the active roster.
   * Deferred wiring: connection.ts does not yet query this; the API is provided
   * so the room manager can call it in C9/C10.
   */
  getCallsigns(roomId: string): ReadonlySet<string> {
    return this._callsigns.get(roomId) ?? new Set<string>();
  }

  /**
   * Clear the in-memory callsign set for a room (called on day close via onDayClose).
   * Prevents stale callsign-taken data from surviving until a server restart.
   */
  clearCallsigns(roomId: string): void {
    this._callsigns.delete(roomId);
  }

  protected serialize(glyphs: GlyphEntry[]): string {
    return JSON.stringify({ glyphs });
  }

  protected deserialize(raw: string): GlyphEntry[] | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'glyphs' in parsed &&
        Array.isArray((parsed as { glyphs: unknown }).glyphs)
      ) {
        const rawGlyphs = (parsed as { glyphs: unknown[] }).glyphs;
        const valid = rawGlyphs.filter((g) => {
          if (isValidGlyph(g)) return true;
          console.warn(
            `[buckets:guestbook] dropping malformed glyph ${JSON.stringify(
              (g as { id?: unknown } | null)?.id
            )}`
          );
          return false;
        }) as GlyphEntry[];
        return valid;
      }
      console.warn(`[buckets:guestbook] malformed (no glyphs array) — ignoring`);
      return [];
    } catch {
      console.warn(`[buckets:guestbook] invalid JSON — ignoring`);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// DayStatsBucket — leaderboard / metrics / callsign-taken set (per-day)
// ---------------------------------------------------------------------------

export class DayStatsBucket extends BaseBucket<DayStats> {
  /** In-memory callsignsTaken set per room (populated on load). */
  private readonly _taken: Map<string, Set<string>> = new Map();

  /**
   * In-memory DAY-scoped fastest throw per room (C26 fix). Survives a rotation
   * RESET (the dayStats bucket is only wiped at day close, spec §6.4) — it is the
   * source of truth for the caster's "FASTEST THROW TODAY" superlative (§7.15).
   * The rotation-scoped throw stats (connection.ts `throwStats`) are cleared every
   * RESET, so reading THEM for the record produced a FALSE cross-rotation claim;
   * this day-scoped high-water is the correct source.
   */
  private readonly _fastest: Map<string, { callsign: string; speedMs: number }> = new Map();

  constructor(opts: BucketOpts) {
    super('dayStats', opts);
  }

  /**
   * Load day stats from disk. Returns null if missing or malformed.
   * A missing dayStats file is treated as "no data yet today".
   */
  async load(roomId: string): Promise<DayStats | null> {
    const raw = await this._readRaw(roomId);
    if (raw === null) return null;
    const result = this.deserialize(raw);
    if (result !== null) {
      this._taken.set(roomId, new Set(result.callsignsTaken));
      // Rehydrate the day-scoped record so a mid-day server restart never re-fires
      // an already-beaten "FASTEST THROW TODAY" (C26).
      if (result.fastestThrow) this._fastest.set(roomId, { ...result.fastestThrow });
    }
    return result;
  }

  /**
   * Record a throw's release speed against the DAY record (C26). Returns true iff
   * it is a new day-best (strictly beats the prior best, or is the first of the
   * day). Updates the in-memory day-record (survives rotation RESET) and schedules
   * a debounced persist so the record also survives a mid-day server restart.
   *
   * The persisted DayStats preserves the day-scoped callsigns-taken set; `rotations`
   * is not tracked live (kept 0, matching the day-open state — day close rewrites
   * it), so this never clobbers a live-maintained field.
   */
  recordFastestThrow(roomId: string, callsign: string, speedMs: number): boolean {
    if (!BUCKET_ID_RE.test(roomId)) return false; // never arm a bad-id write
    if (!Number.isFinite(speedMs)) return false;
    const prev = this._fastest.get(roomId);
    if (prev && speedMs <= prev.speedMs) return false;
    const record = { callsign, speedMs };
    this._fastest.set(roomId, record);
    this.scheduleSave(roomId, {
      date: new Date().toISOString().slice(0, 10),
      callsignsTaken: [...(this._taken.get(roomId) ?? [])],
      fastestThrow: { ...record },
      rotations: 0,
    });
    return true;
  }

  /**
   * The current day's fastest throw (null = none yet). DAY-scoped read — the
   * caster's record-superlative gate (§7.15). Survives rotation RESET.
   */
  getFastestThrow(roomId: string): { callsign: string; speedMs: number } | null {
    return this._fastest.get(roomId) ?? null;
  }

  /**
   * Return the set of callsigns assigned in this room today.
   * Used by C9+ to extend callsign uniqueness to roster ∪ dayStats ∪ guestbook
   * (spec §6.1). Deferred wiring: connection.ts does not yet query this; the
   * API is provided for the room manager to use when wiring C9/C10.
   */
  getCallsignsTaken(roomId: string): ReadonlySet<string> {
    return this._taken.get(roomId) ?? new Set<string>();
  }

  /**
   * Clear the in-memory day-scoped state for a room (called on day close). Drops
   * BOTH the callsigns-taken set and the C26 fastest-throw record — both are
   * day-scoped and must not survive the Closing Ceremony into the next day.
   * Prevents stale data from surviving until a server restart.
   */
  clearTaken(roomId: string): void {
    this._taken.delete(roomId);
    this._fastest.delete(roomId);
  }

  protected serialize(stats: DayStats): string {
    return JSON.stringify(stats);
  }

  protected deserialize(raw: string): DayStats | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidDayStats(parsed)) {
        console.warn(`[buckets:dayStats] malformed stats object — ignoring`);
        return null;
      }
      return parsed;
    } catch {
      console.warn(`[buckets:dayStats] invalid JSON — ignoring`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// LayoutBucket — named Workshop compositions (spec §7.23, plan C34).
//
// The `layouts` bucket the C8 union anticipated. It holds a per-room MANIFEST:
// the named layouts (incl. the showroom baseline) + which name is the baseline
// the RESET handler restores. NEVER wiped by a rotation RESET (like guestbook) —
// it survives a rotation, a server restart, and is included in the §10 LAN-day
// export. Layout count is capped (spec §7.23 ~32) so a troll can't fill the disk;
// the cap is enforced at SAVE time by the connection layer (this store validates
// on load and drops malformed entries, never throws into the caller).
// ---------------------------------------------------------------------------

/** The persisted per-room layouts record: the named compositions + the baseline. */
export interface LayoutManifest {
  layouts: Layout[];
  /** The name of the layout the RESET handler restores, or absent (→ v1 fallback). */
  baselineName?: string;
}

export class LayoutBucket extends BaseBucket<LayoutManifest> {
  constructor(opts: BucketOpts) {
    super('layouts', opts);
  }

  /**
   * Load the manifest from disk. Returns an EMPTY manifest (not null) if missing —
   * an absent layouts file is a valid initial state (no compositions yet), exactly
   * like the guestbook. Drops malformed layouts (validate-on-load), never throws.
   */
  async load(roomId: string): Promise<LayoutManifest> {
    const raw = await this._readRaw(roomId);
    if (raw === null) return { layouts: [] };
    return this.deserialize(raw) ?? { layouts: [] };
  }

  protected serialize(m: LayoutManifest): string {
    return JSON.stringify(m);
  }

  protected deserialize(raw: string): LayoutManifest | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'layouts' in parsed &&
        Array.isArray((parsed as { layouts: unknown }).layouts)
      ) {
        const rawLayouts = (parsed as { layouts: unknown[] }).layouts;
        // Validate-on-load: a persisted layout is validated as a PLAY layout (the
        // permissive cap); the baseline cap is re-checked at SET_BASELINE time.
        const valid: Layout[] = [];
        for (const l of rawLayouts) {
          const r = validateLayout(l, false);
          if (r.ok) valid.push(r.layout);
          else console.warn(`[buckets:layouts] dropping malformed layout (${r.reason})`);
        }
        const baselineName = (parsed as { baselineName?: unknown }).baselineName;
        return {
          layouts: valid,
          ...(typeof baselineName === 'string' && valid.some((l) => l.name === baselineName)
            ? { baselineName }
            : {}),
        };
      }
      console.warn(`[buckets:layouts] malformed (no layouts array) — ignoring`);
      return { layouts: [] };
    } catch {
      console.warn(`[buckets:layouts] invalid JSON — ignoring`);
      return { layouts: [] };
    }
  }
}
