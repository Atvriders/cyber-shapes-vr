/**
 * clips.ts — Task C31: F20 Neon Clip Machine, THE SECURITY SURFACE (spec §7.20).
 *
 * The take-home highlight-clip store, living beside C4's `auth.ts` and following
 * the SAME shape (injected clock + injected fs so the whole surface is unit-
 * testable without touching real disk or the wall clock; an in-memory index is
 * the source of truth for caps/TTL/sweep, mirroring `RoomAuthStore`).
 *
 *   POST /api/clips  → store a finished clip blob (index.ts wires the route).
 *     · ownerToken in a HEADER — never a URL (the C4 treatment).
 *     · ~25 MB per-clip cap, enforced while STREAMING the body (readBodyCapped
 *       aborts the instant the cap is crossed — never buffers past it).
 *     · per-room-per-day COUNT cap (a leaked ownerToken cannot fill the disk).
 *     · per-IP POST rate limit (sliding window, C4's room-create-limiter shape).
 *
 *   GET /api/clips/:id → PUBLIC retrieval (the burned-in QR end-slate IS this URL).
 *     · clipId is CLIENT-preminted, ≥128-bit crypto-random hex (spec §7.20 —
 *       "unlisted must mean unguessable": the id SPACE is the gate, not a secret
 *       check — no enumeration is feasible over a 128-bit id).
 *     · per-IP GET rate limit — keyed on the caller-supplied `ip`, which index.ts
 *       derives via the C25/C30-hardened `clientIpOf` (CF-Connecting-IP → the
 *       RIGHTMOST trusted X-Forwarded-For hop → socket.remoteAddress). This
 *       module NEVER re-derives an IP from a request — it only ever receives the
 *       already-hardened string, so a spoofed LEFTMOST XFF cannot evade it.
 *     · per-clip daily download cap (a viral/DoS'd clip cannot blow the bandwidth
 *       budget indefinitely).
 *     · TTL to day-close + a sweep that deletes the blob + metadata; a swept id
 *       404s — INDISTINGUISHABLE from "never existed" (no enumeration oracle).
 *
 * Storage: one blob file per clip; metadata lives in the in-memory index only
 * (rebuilt from a director's next save after a restart — a clip cache, not a
 * persistence bucket; the §6.4 buckets are untouched by this task).
 */

import type { IncomingMessage } from 'node:http';

// ---------------------------------------------------------------------------
// Tunables (exported so tests can reference the exact constants)
// ---------------------------------------------------------------------------

/** Per-clip upload cap (spec §7.20 "~25 MB cap"). */
export const CLIP_MAX_BYTES = 25 * 1024 * 1024;

/** Sliding window for the per-IP POST limiter. */
export const CLIP_POST_PER_IP_WINDOW_MS = 60_000;
/** Max POSTs per IP per window before a 429 (mirrors C4's ROOM_CREATE_PER_IP_MAX shape). */
export const CLIP_POST_PER_IP_MAX = 10;

/** Max clips a single room may save per calendar day (the leaked-token backstop). */
export const CLIP_MAX_PER_ROOM_PER_DAY = 40;

/** Sliding window for the per-IP GET (retrieval) limiter. */
export const CLIP_GET_PER_IP_WINDOW_MS = 60_000;
/** Max GETs per IP per window before a 429 — throttles scraping/hot-linking. */
export const CLIP_GET_PER_IP_MAX = 60;

/** Max downloads a single clip may serve per calendar day. */
export const CLIP_MAX_DOWNLOADS_PER_CLIP_PER_DAY = 500;

/** TTL to day-close: a clip older than this is swept (blob deleted, GET 404s). */
export const CLIP_TTL_MS = 24 * 60 * 60_000;

/**
 * The clipId shape: EXACTLY 32 lowercase hex chars = 16 bytes = 128 bits (spec
 * §7.20 "≥ 128-bit random"). Also the path-safety gate for the blob filename —
 * a clipId that fails this is refused before it ever touches the filesystem.
 *
 * C31 review fold-in: aligned to the client's `/^[0-9a-f]{32}$/` EXACTLY. The
 * client mints exactly 16 bytes (32 hex chars), so the server accepts exactly
 * that shape — a tighter gate is strictly safer (a `{32,64}` range accepted ids
 * the client never mints, widening the path-input surface for no benefit).
 */
export const CLIP_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The ONLY Content-Types a clip GET may ever advertise (C31 review MUST-FIX 1 —
 * stored XSS). The compositor produces mp4 / webm ONLY; anything else is coerced
 * to `application/octet-stream` on store so the PUBLIC GET can never echo an
 * attacker-chosen active type (e.g. `text/html`) on the app's own origin. The
 * GET additionally forces `nosniff` + `Content-Disposition: attachment`.
 */
export const CLIP_CONTENT_TYPE_ALLOWLIST = ['video/mp4', 'video/webm'] as const;
export type ClipContentType = (typeof CLIP_CONTENT_TYPE_ALLOWLIST)[number];

/** The forced-safe fallback for any non-allowlisted uploaded Content-Type. */
export const CLIP_CONTENT_TYPE_FALLBACK = 'application/octet-stream';

/**
 * Coerce an uploaded Content-Type to a SAFE stored value. A bare allowlisted
 * type (ignoring any `; codecs=…` parameter and case) is kept; ANYTHING else —
 * `text/html`, `image/svg+xml`, a missing header — becomes
 * `application/octet-stream`. Never trusts the uploader's string on the GET.
 */
export function coerceClipContentType(raw: string | undefined): string {
  if (typeof raw !== 'string') return CLIP_CONTENT_TYPE_FALLBACK;
  // Strip any parameter (`video/webm;codecs=vp8,opus`) and normalize.
  const base = raw.split(';')[0]!.trim().toLowerCase();
  return (CLIP_CONTENT_TYPE_ALLOWLIST as readonly string[]).includes(base)
    ? base
    : CLIP_CONTENT_TYPE_FALLBACK;
}

/** The download filename extension for a stored (already-coerced) Content-Type. */
export function clipExtForContentType(contentType: string): string {
  if (contentType === 'video/mp4') return 'mp4';
  if (contentType === 'video/webm') return 'webm';
  return 'bin';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClipMeta {
  clipId: string;
  roomId: string;
  createdAt: number;
  size: number;
  contentType: string;
  /** Download counts bucketed by calendar day (YYYY-MM-DD from the injected clock). */
  downloadsByDay: Record<string, number>;
}

export interface ClipStoreOpts {
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Data root; blobs live at <dir>/clips/<clipId>.bin. */
  dir: string;
  /** Override for fs write (defaults to node:fs/promises writeFile + mkdir -p). */
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  /** Override for fs read (defaults to node:fs/promises readFile). */
  readFile?: (path: string) => Promise<Buffer>;
  /** Override for fs delete (defaults to node:fs/promises unlink; ENOENT is swallowed). */
  deleteFile?: (path: string) => Promise<void>;
  /**
   * Override for listing the clips dir (defaults to node:fs/promises readdir).
   * Used ONLY by {@link ClipStore.reconcileDisk} (startup orphan sweep).
   */
  listDir?: (dir: string) => Promise<string[]>;
  /**
   * Override for stat'ing a blob (defaults to node:fs/promises stat → mtimeMs).
   * Used ONLY by {@link ClipStore.reconcileDisk} (startup orphan sweep).
   */
  statFile?: (path: string) => Promise<{ mtimeMs: number }>;
  maxBytes?: number;
  maxPerRoomPerDay?: number;
  maxDownloadsPerClipPerDay?: number;
  ttlMs?: number;
}

export type PutClipResult =
  | { ok: true; clipId: string }
  | { error: 'bad-clip-id'; status: 400 }
  | { error: 'unauthorized'; status: 401 }
  | { error: 'too-large'; status: 413 }
  | { error: 'rate-limited'; status: 429 }
  | { error: 'day-cap'; status: 429 }
  | { error: 'duplicate'; status: 409 };

export interface PutClipOpts {
  /** The C25/C30-hardened client IP (derived ONCE, in index.ts, via clientIpOf). */
  ip: string;
  clipId: string;
  roomId: string;
  ownerToken: string | undefined;
  /**
   * Injected ownerToken verifier — the caller binds `authStore.verifyOwnerToken`
   * so this module never imports auth.ts (kept decoupled + independently unit-
   * testable with a fake verifier).
   */
  verifyOwnerToken: (roomId: string, token: string | undefined) => boolean;
  contentType: string;
  body: Buffer;
  /**
   * MUST-FIX 2: set by index.ts when the per-IP POST hit was ALREADY checked +
   * recorded at the route (via {@link ClipStore.registerPostAttempt}, pre-auth,
   * before the body was buffered). When true, putClip does NOT re-check or
   * re-record the per-IP limit (avoids double-counting one HTTP POST). Direct
   * unit callers omit it, so putClip keeps its own limiter (safe to call alone).
   */
  ipAlreadyCounted?: boolean;
}

export type GetClipResult =
  | { ok: true; body: Buffer; contentType: string }
  | { error: 'not-found'; status: 404 }
  | { error: 'rate-limited'; status: 429 }
  | { error: 'download-cap'; status: 429 };

export interface GetClipOpts {
  /** The C25/C30-hardened client IP (derived ONCE, in index.ts, via clientIpOf). */
  ip: string;
  clipId: string;
}

// ---------------------------------------------------------------------------
// Default fs ports (real disk; never used in tests)
// ---------------------------------------------------------------------------

async function defaultWriteFile(path: string, data: Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function defaultReadFile(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

async function defaultDeleteFile(path: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(path);
  } catch {
    /* ENOENT / already gone — a sweep is idempotent */
  }
}

async function defaultListDir(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(dir);
  } catch {
    return []; // dir not created yet (no clip ever saved) — nothing to reconcile
  }
}

async function defaultStatFile(path: string): Promise<{ mtimeMs: number }> {
  const { stat } = await import('node:fs/promises');
  const st = await stat(path);
  return { mtimeMs: st.mtimeMs };
}

// ---------------------------------------------------------------------------
// ClipStore
// ---------------------------------------------------------------------------

export class ClipStore {
  private readonly _now: () => number;
  private readonly _dir: string;
  private readonly _writeFile: (path: string, data: Buffer) => Promise<void>;
  private readonly _readFile: (path: string) => Promise<Buffer>;
  private readonly _deleteFile: (path: string) => Promise<void>;
  private readonly _listDir: (dir: string) => Promise<string[]>;
  private readonly _statFile: (path: string) => Promise<{ mtimeMs: number }>;
  private readonly _maxBytes: number;
  private readonly _maxPerRoomPerDay: number;
  private readonly _maxDownloadsPerClipPerDay: number;
  private readonly _ttlMs: number;

  /** clipId → metadata. The in-memory index is authoritative for caps/TTL. */
  private readonly _clips = new Map<string, ClipMeta>();
  /** `${roomId} ${dayKey}` → POST count, for the per-room-per-day cap. */
  private readonly _roomDayCounts = new Map<string, number>();
  /** ip → recent POST timestamps (sliding window). */
  private readonly _postHits = new Map<string, number[]>();
  /** ip → recent GET timestamps (sliding window). */
  private readonly _getHits = new Map<string, number[]>();

  constructor(opts: ClipStoreOpts) {
    this._now = opts.now ?? (() => Date.now());
    this._dir = opts.dir;
    this._writeFile = opts.writeFile ?? defaultWriteFile;
    this._readFile = opts.readFile ?? defaultReadFile;
    this._deleteFile = opts.deleteFile ?? defaultDeleteFile;
    this._listDir = opts.listDir ?? defaultListDir;
    this._statFile = opts.statFile ?? defaultStatFile;
    this._maxBytes = opts.maxBytes ?? CLIP_MAX_BYTES;
    this._maxPerRoomPerDay = opts.maxPerRoomPerDay ?? CLIP_MAX_PER_ROOM_PER_DAY;
    this._maxDownloadsPerClipPerDay = opts.maxDownloadsPerClipPerDay ?? CLIP_MAX_DOWNLOADS_PER_CLIP_PER_DAY;
    this._ttlMs = opts.ttlMs ?? CLIP_TTL_MS;
  }

  private _blobPath(clipId: string): string {
    return `${this._dir}/clips/${clipId}.bin`;
  }

  private _dayKey(t: number = this._now()): string {
    return new Date(t).toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // POST /api/clips
  // -------------------------------------------------------------------------

  async putClip(opts: PutClipOpts): Promise<PutClipResult> {
    this.sweep();

    // Path-safety + entropy-shape gate FIRST (cheap, and the id becomes a
    // filename below — never let an unvalidated string near the filesystem).
    if (!CLIP_ID_RE.test(opts.clipId)) {
      return { error: 'bad-clip-id', status: 400 };
    }

    // ownerToken auth (never a URL — spec §7.20 / the C4 treatment).
    if (!opts.verifyOwnerToken(opts.roomId, opts.ownerToken)) {
      return { error: 'unauthorized', status: 401 };
    }

    // A clipId is client-preminted ONCE; a resend of the same id is refused
    // (never silently overwrites a delivered clip's blob).
    if (this._clips.has(opts.clipId)) {
      return { error: 'duplicate', status: 409 };
    }

    // Backstop size cap (the PRIMARY defense is the streaming abort in
    // readBodyCapped, enforced by the caller before this method ever sees the
    // buffer — this re-check makes the store safe to call directly too).
    if (opts.body.byteLength > this._maxBytes) {
      return { error: 'too-large', status: 413 };
    }

    // Per-IP POST limit. index.ts already checked+recorded this pre-auth (MF2)
    // and sets `ipAlreadyCounted` — skip here so one HTTP POST records ONE hit.
    // A direct unit caller omits the flag, so the store stays safe to call alone.
    if (!opts.ipAlreadyCounted && this._isPostRateLimited(opts.ip)) {
      return { error: 'rate-limited', status: 429 };
    }

    const dayKey = this._dayKey();
    const roomDayKey = `${opts.roomId} ${dayKey}`;
    const count = this._roomDayCounts.get(roomDayKey) ?? 0;
    if (count >= this._maxPerRoomPerDay) {
      return { error: 'day-cap', status: 429 };
    }

    if (!opts.ipAlreadyCounted) this._recordPostHit(opts.ip);
    this._roomDayCounts.set(roomDayKey, count + 1);

    await this._writeFile(this._blobPath(opts.clipId), opts.body);
    this._clips.set(opts.clipId, {
      clipId: opts.clipId,
      roomId: opts.roomId,
      createdAt: this._now(),
      size: opts.body.byteLength,
      // MUST-FIX 1 (stored XSS): NEVER store the uploader's raw Content-Type. A
      // non-allowlisted type (`text/html`, `image/svg+xml`, …) is coerced to
      // `application/octet-stream` here so the PUBLIC GET can never echo an
      // attacker-chosen active type on the app's own origin. The GET FURTHER
      // forces nosniff + attachment regardless of this stored value.
      contentType: coerceClipContentType(opts.contentType),
      downloadsByDay: {},
    });
    return { ok: true, clipId: opts.clipId };
  }

  /**
   * MUST-FIX 2 (unauth POST flood): the PUBLIC pre-auth per-IP POST gate. index.ts
   * calls this at the route BEFORE `readBodyCapped`/auth so EVERY POST attempt
   * (authed or not, valid body or not) counts toward the per-IP limit and is
   * rejected up front when over — an unauth flood is throttled before a single
   * 25 MB body is buffered. It BOTH checks and RECORDS the hit (unlike putClip's
   * post-auth path, which recorded only on the way to a successful store and so
   * never throttled a tokenless flood). Returns true when the caller must 429.
   */
  registerPostAttempt(ip: string): boolean {
    if (this._isPostRateLimited(ip)) return true;
    this._recordPostHit(ip);
    return false;
  }

  private _isPostRateLimited(ip: string): boolean {
    const now = this._now();
    const cutoff = now - CLIP_POST_PER_IP_WINDOW_MS;
    const hits = (this._postHits.get(ip) ?? []).filter((t) => t > cutoff);
    // Fold-in (unbounded map growth): drop the per-IP entry once its window is
    // empty rather than leaving an empty array behind for every distinct IP.
    if (hits.length === 0) this._postHits.delete(ip);
    else this._postHits.set(ip, hits);
    return hits.length >= CLIP_POST_PER_IP_MAX;
  }

  private _recordPostHit(ip: string): void {
    const hits = this._postHits.get(ip) ?? [];
    hits.push(this._now());
    this._postHits.set(ip, hits);
  }

  // -------------------------------------------------------------------------
  // GET /api/clips/:id — PUBLIC (the QR end-slate IS this URL)
  // -------------------------------------------------------------------------

  async getClip(opts: GetClipOpts): Promise<GetClipResult> {
    this.sweep();

    const meta = this._clips.get(opts.clipId);
    // A swept / never-existed id is INDISTINGUISHABLE — same 404, no oracle.
    if (!meta) {
      return { error: 'not-found', status: 404 };
    }

    if (this._isGetRateLimited(opts.ip)) {
      return { error: 'rate-limited', status: 429 };
    }

    const dayKey = this._dayKey();
    const downloadsToday = meta.downloadsByDay[dayKey] ?? 0;
    if (downloadsToday >= this._maxDownloadsPerClipPerDay) {
      return { error: 'download-cap', status: 429 };
    }

    this._recordGetHit(opts.ip);

    // Fold-in robustness: the blob read is GUARDED. If meta exists but the blob
    // is gone (external deletion / partial write / a swept blob racing a read)
    // the read rejects — WITHOUT this guard the promise would reject unhandled,
    // no response would be written, and the client would hang to its timeout.
    // A missing blob → a clean 404 (indistinguishable from never-existed), and
    // the now-dangling index entry is dropped so the store stays consistent.
    let body: Buffer;
    try {
      body = await this._readFile(this._blobPath(opts.clipId));
    } catch {
      this._clips.delete(opts.clipId);
      return { error: 'not-found', status: 404 };
    }

    // Count the download ONLY after a SUCCESSFUL read — a failed read must never
    // burn a per-clip day-cap slot (previously incremented before the read).
    meta.downloadsByDay[dayKey] = downloadsToday + 1;
    return { ok: true, body, contentType: meta.contentType };
  }

  private _isGetRateLimited(ip: string): boolean {
    const now = this._now();
    const cutoff = now - CLIP_GET_PER_IP_WINDOW_MS;
    const hits = (this._getHits.get(ip) ?? []).filter((t) => t > cutoff);
    // Fold-in (unbounded map growth): drop the per-IP entry once its window is empty.
    if (hits.length === 0) this._getHits.delete(ip);
    else this._getHits.set(ip, hits);
    return hits.length >= CLIP_GET_PER_IP_MAX;
  }

  private _recordGetHit(ip: string): void {
    const hits = this._getHits.get(ip) ?? [];
    hits.push(this._now());
    this._getHits.set(ip, hits);
  }

  // -------------------------------------------------------------------------
  // TTL day-close sweep (booth ops: RUNBOOK day-close calls this; index.ts also
  // runs it on the SAME periodic interval as the C4 auth sweep).
  // -------------------------------------------------------------------------

  /**
   * Delete every clip older than the TTL: drops the index entry + the blob. Also
   * PRUNES the auxiliary rate-limit / day-count maps (fold-in: unbounded map
   * growth) so a flood of distinct IPs/days can never leak memory unbounded —
   * each was a second DoS amplifier (every spoofed source seeded a permanent key).
   */
  sweep(): void {
    const now = this._now();
    for (const [id, meta] of this._clips) {
      if (now - meta.createdAt > this._ttlMs) {
        this._clips.delete(id);
        void this._deleteFile(this._blobPath(id));
      }
    }
    this._pruneRateMaps(now);
    this._pruneRoomDayCounts(now);
  }

  /** Drop per-IP rate-limit entries whose sliding window is now empty (idle IPs). */
  private _pruneRateMaps(now: number): void {
    for (const [ip, hits] of this._postHits) {
      const live = hits.filter((t) => t > now - CLIP_POST_PER_IP_WINDOW_MS);
      if (live.length === 0) this._postHits.delete(ip);
      else this._postHits.set(ip, live);
    }
    for (const [ip, hits] of this._getHits) {
      const live = hits.filter((t) => t > now - CLIP_GET_PER_IP_WINDOW_MS);
      if (live.length === 0) this._getHits.delete(ip);
      else this._getHits.set(ip, live);
    }
  }

  /**
   * Drop stale `${roomId} ${YYYY-MM-DD}` day-count keys. The per-room-per-day cap
   * only ever consults TODAY's key, so any key for a day strictly before today is
   * dead weight — without this, every (room, day) pair seeded a permanent entry.
   */
  private _pruneRoomDayCounts(now: number): void {
    const today = this._dayKey(now);
    for (const key of [...this._roomDayCounts.keys()]) {
      const dayKey = key.slice(key.lastIndexOf(' ') + 1);
      if (dayKey < today) this._roomDayCounts.delete(key);
    }
  }

  /**
   * Fold-in (orphaned-blob disk leak): a STARTUP filesystem reconciliation. The
   * in-memory index is rebuilt empty on restart, so `sweep()` (which iterates the
   * index) can never TTL-sweep a blob written by a PRE-restart process — those
   * `<dir>/clips/*.bin` files would accumulate forever. This scans the clips dir
   * and deletes any blob whose mtime is older than the TTL. Best-effort: a missing
   * dir / unreadable entry is skipped, never thrown (index.ts fires it and logs).
   */
  async reconcileDisk(): Promise<void> {
    const dir = `${this._dir}/clips`;
    const names = await this._listDir(dir);
    const now = this._now();
    for (const name of names) {
      if (!name.endsWith('.bin')) continue;
      const path = `${dir}/${name}`;
      try {
        const st = await this._statFile(path);
        if (now - st.mtimeMs > this._ttlMs) {
          await this._deleteFile(path);
        }
      } catch {
        /* stat/delete race — skip this entry, reconciliation is idempotent */
      }
    }
  }

  /** True if the clip is currently known (not swept, not never-saved). Test/ops hook. */
  has(clipId: string): boolean {
    return this._clips.has(clipId);
  }

  /** Count of currently-tracked (unswept) clips. Test/ops hook. */
  size(): number {
    return this._clips.size;
  }

  /**
   * Sizes of the auxiliary rate-limit / day-count maps (fold-in pruning check).
   * Test/ops hook — a bounded, prunable set of counters, never a memory leak.
   */
  debugMapSizes(): { postHits: number; getHits: number; roomDayCounts: number } {
    return {
      postHits: this._postHits.size,
      getHits: this._getHits.size,
      roomDayCounts: this._roomDayCounts.size,
    };
  }
}

// ---------------------------------------------------------------------------
// Streaming body cap — the PRIMARY size defense (aborts mid-stream, never
// buffers past CLIP_MAX_BYTES). index.ts calls this before putClip.
// ---------------------------------------------------------------------------

/** A minimal readable-stream shape (IncomingMessage satisfies this; so does a PassThrough). */
export interface CappedBodySource {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  /** Stop consuming further chunks (bounds memory) — NEVER destroy: `req` and
   * `res` share one socket on a real IncomingMessage, and destroying it here
   * would kill the connection before the 413 response can be written. */
  pause?(): unknown;
}

export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeded the ${maxBytes}-byte cap`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Read a request body up to `maxBytes`. The instant the running total crosses
 * the cap the stream is PAUSED (no more chunks are buffered — bounded memory,
 * spec §7.20 "reject oversize") and the promise REJECTS with
 * {@link PayloadTooLargeError}. Deliberately does NOT `destroy()` the source:
 * on a real `http.IncomingMessage`, `req` and `res` share one socket, and
 * destroying `req` mid-read would reset the connection before the caller can
 * write a clean 413 response (the caller may destroy the socket itself AFTER
 * the response is flushed, if desired).
 */
export function readBodyCapped(req: CappedBodySource, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause?.();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Small header-parsing helper (Node dedupes some headers into arrays).
// ---------------------------------------------------------------------------

/** The first value of a Node header (which may be a string, an array, or absent). */
export function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Convenience: pull one header off a real IncomingMessage. */
export function headerOf(req: IncomingMessage, name: string): string | undefined {
  return firstHeaderValue(req.headers[name]);
}
