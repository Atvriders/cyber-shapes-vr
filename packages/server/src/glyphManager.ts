/**
 * glyphManager.ts — the server-side Neon Guestbook core (spec §7.13, plan C12).
 *
 * The I/O-free brain the connection layer wires. It owns the per-room guestbook
 * glyphs (in memory, mirrored to the GuestbookBucket by the caller) and enforces
 * every C12 invariant:
 *
 *   - Admission: validate (bounds/count/finite), assign an id + a deterministic
 *     `spiralSlot` OUTSIDE the play volume + the sender's callsign.
 *   - Rate limiting (spec §7.13 — NEVER per-IP):
 *       1. a SERVER-WIDE glyph-inflow token bucket — overflow is QUEUED (never
 *          dropped) and drained as tokens refill;
 *       2. a per-GUEST lifetime cap (~3), keyed on an opaque guestKey (a device
 *          token / peerId — never an IP).
 *   - Budget: `capacity` (512) glyphs per room, evict-OLDEST; SEEDED glyphs
 *     (the pre-authored gallery) are exempt from eviction (spec §7.23).
 *   - Guestbook SURVIVES a world RESET: a rotation reset touches shapes only, so
 *     `onWorldReset` is a deliberate NO-OP on the guestbook.
 *   - Moderation: staff `despawn` (remove one), `panic` (hide the newest N + all
 *     name surfaces — the caster hook lands in C26), and an approval-queue flag.
 *
 * Deterministic + fake-time friendly: the clock is injected (`now`), so are the
 * id factory and the admit/evict hooks.
 */

import {
  validateGlyph,
  resampleStroke,
  GLYPH_MAX_POINTS,
  type GlyphStrokePoint,
} from '@cyber-shapes/shared';
import type { GlyphEntry } from './buckets.js';

// ---------------------------------------------------------------------------
// Defaults (spec §7.13)
// ---------------------------------------------------------------------------

/** Guestbook budget per room (evict-oldest past this; seeded glyphs exempt). */
export const GLYPH_CAPACITY = 512;
/** Per-guest lifetime cap (~3). */
export const GLYPH_LIFETIME_CAP = 3;
/** Server-wide inflow token-bucket burst (bounds troll throughput + render cost). */
export const GLYPH_INFLOW_BURST = 8;
/** Server-wide inflow refill rate (glyphs/second) — sustained throughput ceiling. */
export const GLYPH_INFLOW_REFILL_PER_SEC = 2;
/** How many of the newest glyphs a panic hides (spec §6.1). */
export const GLYPH_PANIC_HIDE_COUNT = 12;
/** Seeded-glyph cap (spec §7.23) — GLYPH_SEED refuses past this. */
export const SEEDED_GLYPH_CAP = 64;

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

export interface GlyphManagerOpts {
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Deterministic id factory (tests) / random in prod. */
  idFactory?: () => string;
  capacity?: number;
  lifetimeCap?: number;
  inflowBurst?: number;
  inflowRefillPerSec?: number;
  panicHideCount?: number;
  /** Called when a glyph is admitted (the caller broadcasts + persists). */
  onAdmit?: (roomId: string, glyph: GlyphEntry) => void;
  /** Called when a glyph is evicted at capacity (the caller broadcasts a REMOVE). */
  onEvict?: (roomId: string, glyph: GlyphEntry) => void;
}

export interface GlyphSubmit {
  roomId: string;
  /** An opaque per-guest key (device token / peerId) — NEVER an IP (spec §7.13). */
  guestKey: string;
  points: readonly GlyphStrokePoint[];
  color: string;
  callsign: string;
}

export type GlyphSubmitResult =
  | { status: 'ok'; glyph: GlyphEntry }
  | { status: 'queued' } // inflow-bucket overflow — held, NOT dropped
  | { status: 'lifetime-cap' } // this guest already has `lifetimeCap` glyphs
  | { status: 'invalid' }; // failed validateGlyph

export interface GlyphSeed {
  roomId: string;
  points: readonly GlyphStrokePoint[];
  color: string;
  callsign: string;
}

// ---------------------------------------------------------------------------
// Internal per-room record
// ---------------------------------------------------------------------------

interface RoomGlyphs {
  /** Insertion-ordered live glyphs (oldest first — evict from the front). */
  glyphs: GlyphEntry[];
  /** Ids currently hidden by a panic (still in `glyphs`, but not "visible"). */
  hidden: Set<string>;
  /** Per-guest lifetime submission counts (keyed on the opaque guestKey). */
  lifetime: Map<string, number>;
  /** Monotonic slot counter — the next spiralSlot index (never reused). */
  nextSlot: number;
  /** Approval-queue mode (strict events): admitted glyphs land hidden until approved. */
  approvalMode: boolean;
}

type QueuedSubmit = GlyphSubmit;

// ---------------------------------------------------------------------------
// A monotonic-clock token bucket (server-wide inflow limiter).
// ---------------------------------------------------------------------------

class InflowBucket {
  private _tokens: number;
  private _last: number;
  constructor(
    private readonly _refillPerSec: number,
    private readonly _burst: number,
    private readonly _now: () => number
  ) {
    this._tokens = _burst;
    this._last = _now();
  }
  /** Try to consume one token. Returns true if allowed. */
  take(): boolean {
    this._refill();
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }
    return false;
  }
  private _refill(): void {
    const now = this._now();
    const elapsedSec = Math.max(0, (now - this._last) / 1000);
    this._last = now;
    this._tokens = Math.min(this._burst, this._tokens + elapsedSec * this._refillPerSec);
  }
}

// ---------------------------------------------------------------------------
// GlyphManager
// ---------------------------------------------------------------------------

export class GlyphManager {
  private readonly _now: () => number;
  private readonly _idFactory: () => string;
  private readonly _capacity: number;
  private readonly _lifetimeCap: number;
  private readonly _panicHideCount: number;
  private readonly _onAdmit?: (roomId: string, glyph: GlyphEntry) => void;
  private readonly _onEvict?: (roomId: string, glyph: GlyphEntry) => void;

  private readonly _inflow: InflowBucket;
  /** Overflow queue (server-wide) — FIFO; drained as tokens refill. NEVER dropped. */
  private readonly _queue: QueuedSubmit[] = [];
  private readonly _rooms: Map<string, RoomGlyphs> = new Map();

  constructor(opts: GlyphManagerOpts = {}) {
    this._now = opts.now ?? Date.now;
    let seq = 0;
    this._idFactory = opts.idFactory ?? (() => `gl_${(seq++).toString(36)}_${this._now().toString(36)}`);
    this._capacity = opts.capacity ?? GLYPH_CAPACITY;
    this._lifetimeCap = opts.lifetimeCap ?? GLYPH_LIFETIME_CAP;
    this._panicHideCount = opts.panicHideCount ?? GLYPH_PANIC_HIDE_COUNT;
    this._onAdmit = opts.onAdmit;
    this._onEvict = opts.onEvict;
    this._inflow = new InflowBucket(
      opts.inflowRefillPerSec ?? GLYPH_INFLOW_REFILL_PER_SEC,
      opts.inflowBurst ?? GLYPH_INFLOW_BURST,
      this._now
    );
  }

  private _room(roomId: string): RoomGlyphs {
    let r = this._rooms.get(roomId);
    if (!r) {
      r = { glyphs: [], hidden: new Set(), lifetime: new Map(), nextSlot: 0, approvalMode: false };
      this._rooms.set(roomId, r);
    }
    return r;
  }

  // -------------------------------------------------------------------------
  // Load (rehydrate from the guestbook bucket on room boot).
  // -------------------------------------------------------------------------

  /**
   * Seed the in-memory guestbook from persisted glyphs (the bucket load). Sets
   * `nextSlot` past the highest persisted slot so new glyphs never reuse a slot.
   */
  load(roomId: string, glyphs: readonly GlyphEntry[]): void {
    const r = this._room(roomId);
    r.glyphs = glyphs.map((g) => ({ ...g, points: g.points.map((p) => ({ ...p })) }));
    let maxSlot = -1;
    for (const g of r.glyphs) if (g.slotIndex > maxSlot) maxSlot = g.slotIndex;
    r.nextSlot = maxSlot + 1;
  }

  // -------------------------------------------------------------------------
  // Submit (the GLYPH_ADD path)
  // -------------------------------------------------------------------------

  /**
   * Admit a phone-scribe glyph. Order of gates (spec §7.13):
   *   1. validate (bounds/count/finite) → 'invalid';
   *   2. per-guest lifetime cap → 'lifetime-cap';
   *   3. server-wide inflow token bucket — no token → QUEUE (return 'queued');
   *   4. otherwise admit (assign id + slot + callsign, evict-oldest at capacity).
   *
   * The stroke is resampled to ≤ 32 points server-side (defence in depth: a phone
   * that skips the client resample still lands a bounded glyph).
   */
  submit(sub: GlyphSubmit): GlyphSubmitResult {
    // 1. Validate. Resample first so an over-length (but otherwise clean) stroke
    //    is bounded before the point-count check.
    const points = resampleStroke(sub.points, GLYPH_MAX_POINTS);
    if (!validateGlyph({ points, color: sub.color })) return { status: 'invalid' };

    const r = this._room(sub.roomId);

    // 2. Per-guest lifetime cap (opaque guestKey — never per-IP).
    const used = r.lifetime.get(sub.guestKey) ?? 0;
    if (used >= this._lifetimeCap) return { status: 'lifetime-cap' };

    // 3. Server-wide inflow bucket. Overflow is QUEUED (drained later), never dropped.
    if (!this._inflow.take()) {
      this._queue.push({ ...sub });
      return { status: 'queued' };
    }

    // 4. Admit.
    const glyph = this._admit(sub, points);
    return { status: 'ok', glyph };
  }

  /**
   * Drain the overflow queue: for each queued submit, if a token is available and
   * the guest is still under cap, admit it (via `onAdmit`) and pop it. Called on a
   * timer tick by the connection layer so queued glyphs land as inflow permits.
   */
  drainQueue(): void {
    while (this._queue.length > 0) {
      const sub = this._queue[0];
      const r = this._room(sub.roomId);
      const used = r.lifetime.get(sub.guestKey) ?? 0;
      if (used >= this._lifetimeCap) {
        this._queue.shift(); // this guest hit the cap while queued — drop from queue
        continue;
      }
      if (!this._inflow.take()) return; // no token yet — leave the rest queued
      this._queue.shift();
      const points = resampleStroke(sub.points, GLYPH_MAX_POINTS);
      if (!validateGlyph({ points, color: sub.color })) continue;
      this._admit(sub, points);
    }
  }

  /** Number of glyphs currently held in the overflow queue (test surface). */
  queueLength(): number {
    return this._queue.length;
  }

  private _admit(sub: GlyphSubmit, points: GlyphStrokePoint[]): GlyphEntry {
    const r = this._room(sub.roomId);
    const slotIndex = r.nextSlot++;
    const glyph: GlyphEntry = {
      id: this._idFactory(),
      callsign: sub.callsign,
      points,
      color: sub.color,
      slotIndex,
    };
    r.glyphs.push(glyph);
    r.lifetime.set(sub.guestKey, (r.lifetime.get(sub.guestKey) ?? 0) + 1);
    // Approval mode: a fresh glyph lands HIDDEN until a staff approve() (§7.13).
    if (r.approvalMode) r.hidden.add(glyph.id);
    this._evictIfOver(sub.roomId);
    this._onAdmit?.(sub.roomId, glyph);
    return glyph;
  }

  /** Evict the OLDEST non-seeded glyph(s) until at/under capacity (spec §7.23). */
  private _evictIfOver(roomId: string): void {
    const r = this._room(roomId);
    while (r.glyphs.length > this._capacity) {
      // Find the oldest NON-seeded glyph (seeded = the permanent gallery, exempt).
      const idx = r.glyphs.findIndex((g) => !g.seeded);
      if (idx === -1) break; // every glyph is seeded — nothing to evict (§7.23)
      const [victim] = r.glyphs.splice(idx, 1);
      r.hidden.delete(victim.id);
      this._onEvict?.(roomId, victim);
    }
  }

  // -------------------------------------------------------------------------
  // Seed (the pre-authored gallery — bypasses the inflow bucket + lifetime cap)
  // -------------------------------------------------------------------------

  /**
   * Add a SEEDED glyph (the 50 pre-authored openers / the Workshop's GLYPH_SEED).
   * Bypasses the inflow bucket + lifetime cap (capability-gated), marks `seeded:
   * true` so it is exempt from evict-oldest. Refuses past SEEDED_GLYPH_CAP.
   * Returns the glyph, or null if the stroke is invalid or the seed cap is full.
   */
  seed(sub: GlyphSeed): GlyphEntry | null {
    const r = this._room(sub.roomId);
    const seededCount = r.glyphs.reduce((n, g) => n + (g.seeded ? 1 : 0), 0);
    if (seededCount >= SEEDED_GLYPH_CAP) return null;
    const points = resampleStroke(sub.points, GLYPH_MAX_POINTS);
    if (!validateGlyph({ points, color: sub.color })) return null;
    const glyph: GlyphEntry = {
      id: this._idFactory(),
      callsign: sub.callsign,
      points,
      color: sub.color,
      slotIndex: r.nextSlot++,
      seeded: true,
    };
    r.glyphs.push(glyph);
    this._evictIfOver(sub.roomId);
    return glyph;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every glyph in the room's guestbook (visible + hidden). */
  glyphs(roomId: string): readonly GlyphEntry[] {
    return this._room(roomId).glyphs;
  }

  /** Only the VISIBLE glyphs (panic-hidden + approval-pending excluded). */
  visibleGlyphs(roomId: string): readonly GlyphEntry[] {
    const r = this._room(roomId);
    return r.glyphs.filter((g) => !r.hidden.has(g.id));
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  /**
   * The staff PANIC handler (spec §6.1): hide the newest N glyphs (they stay in
   * the bucket — hidden, not despawned — so a false alarm is reversible). The
   * name-surface / caster suppression is the caller's job (this returns the set
   * of glyphs to hide on the wire). Returns the newly-hidden glyphs, oldest→newest.
   */
  panic(roomId: string): GlyphEntry[] {
    const r = this._room(roomId);
    const n = Math.min(this._panicHideCount, r.glyphs.length);
    const newest = r.glyphs.slice(r.glyphs.length - n);
    for (const g of newest) r.hidden.add(g.id);
    return newest;
  }

  /** Un-hide everything a panic hid (staff "all clear"). Returns the un-hidden glyphs. */
  clearPanic(roomId: string): GlyphEntry[] {
    const r = this._room(roomId);
    const unhidden = r.glyphs.filter((g) => r.hidden.has(g.id));
    r.hidden.clear();
    return unhidden;
  }

  /** Staff despawn one glyph (the one-tap moderation cue). Returns true if removed. */
  despawn(roomId: string, id: string): boolean {
    const r = this._room(roomId);
    const idx = r.glyphs.findIndex((g) => g.id === id);
    if (idx === -1) return false;
    r.glyphs.splice(idx, 1);
    r.hidden.delete(id);
    return true;
  }

  /** Toggle the strict-event approval queue (new glyphs land hidden until approved). */
  setApprovalMode(roomId: string, on: boolean): void {
    this._room(roomId).approvalMode = on;
  }

  /** Approve a queued glyph (un-hide it). Returns true if it was pending. */
  approve(roomId: string, id: string): boolean {
    const r = this._room(roomId);
    if (!r.hidden.has(id)) return false;
    r.hidden.delete(id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * The world-RESET hook (spec §6.4). A rotation reset restores the showroom
   * SHAPES; the guestbook is NEVER wiped by it. Deliberately a NO-OP — its whole
   * point is that calling it leaves the glyphs untouched (the invariant test).
   * We touch the room map (read-only) so the room exists but is untouched.
   */
  onWorldReset(roomId: string): void {
    // Read-only touch: ensure the room record exists (never clears its glyphs).
    void this._room(roomId).glyphs.length;
  }

  /** Drop a room's in-memory guestbook (last socket left / server teardown). */
  dropRoom(roomId: string): void {
    this._rooms.delete(roomId);
  }
}
