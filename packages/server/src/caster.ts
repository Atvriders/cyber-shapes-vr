/**
 * caster.ts — Task C26 F15 MC NULL: the stateful server caster host (spec §7.15).
 *
 * The pure vocabulary + decision lives in `packages/shared/src/casterGrammar.ts`
 * ({@link casterLine}); THIS host (Conductor pattern) owns the STATE the spec
 * mandates and emits `CASTER_LINE` (0x33) via the C1 golden codec:
 *   • streaks (consecutive throws by one callsign) — rotation-scoped;
 *   • a ~3-min no-repeat LRU over templateIds;
 *   • a per-rotation line quota + a max-1-line / 10-s rate limit;
 *   • the phase hype ladder source (reads the room phase each tick);
 *   • day-stats reads → "FASTEST THROW TODAY" superlatives fire ONLY on a real
 *     record (the ONLY cross-rotation reference — day-stats, spec §7.15);
 *   • the significance gate REUSES the shared C21 highlight scorer
 *     ({@link scoreHighlight}) over a rolling window — never a reimplementation;
 *   • single caption authority: while a showpiece owns the caption, only `arm`
 *     / `endCard` kinds may emit.
 *
 * ROTATION-SCOPED MEMORY (spec §7.15): streaks, LRU, quota, window, and showpiece
 * state ALL clear on {@link reset} (the RESET rotation boundary). The ONLY memory
 * that survives RESET is the day-record high-water the record superlative reads —
 * which IS a day-stats record, so a two-rotation transcript never references a
 * rotation-1 callsign after RESET UNLESS it holds that record.
 *
 * PURITY / TIME: no Date/Math.random — an injected `serverNow()` (the C3 server
 * clock) and an injected seeded `rng`. Deterministic given the same inputs.
 */

import {
  OPCODES,
  SINGLE_KIND,
  encodeBinary,
  scoreHighlight,
  casterLine,
  casterSlotsToWire,
  parseCallsign,
  CASTER_SCORER_CFG,
  CASTER_STREAK_MIN,
  type CasterEvent,
  type CasterLine,
  type CasterCallsign,
  type RoomEvent,
  type Rng,
  type Phase,
} from '@cyber-shapes/shared';

/**
 * CASTER_LINE fan-out — EXACTLY the spec §7.15 set: spectator / wisp / crowd
 * (+ audience attach-if-landed). The stage is a SPECTATOR connection (it renders
 * captions on the big screen); the phones are wisp/crowd. Residents are IN the
 * world (captions are a broadcast/stage concern, not a headset HUD) and directors
 * run a control console — neither receives 0x33. Audience (0x33 in the binary
 * allowlist) is admitted by the union path in `broadcastBinaryToTiers`,
 * independent of this list.
 */
export const CASTER_TIERS: readonly string[] = ['spectator', 'wisp', 'crowd', 'audience'];

/** A normalized caster input event (the host's own event stream). */
export type CasterInput =
  // A throw carries the thrower's callsign (also recorded so a later floor impact
  // of the SAME shape attributes to "the shape VOLT-17 threw").
  | { kind: 'throw'; id: string; callsign: string; speed: number }
  // An impact may carry an explicit callsign; absent, the host attributes it to
  // the shape's last thrower (the rotation-scoped throwerOf map).
  | { kind: 'impact'; id: string; speed: number; callsign?: string }
  | { kind: 'spawn'; id: string }
  | { kind: 'join'; callsign: string }
  | { kind: 'grabDuel'; id: string; callsign: string }
  | { kind: 'showpieceStart' }
  | { kind: 'showpieceArm'; callsign?: string }
  | { kind: 'showpieceEnd'; callsign?: string; catches?: number };

/** The day-stats record the superlative gate reads (null = no record yet). */
export interface DayThrowRecord {
  callsign: string;
  speedMs: number;
}

/**
 * The showpiece end-card summary fed on the falling authority edge (C26): the top
 * defender's callsign + their successful-catch count. `catches` binds the endCard
 * template's `catches` num slot (label↔signal truth). Absent/null → the summary
 * releases authority quietly (no defender to celebrate, e.g. the encore FINALE).
 */
export interface CasterEndCard {
  callsign: string;
  catches: number;
}

export interface CasterHostOpts {
  /** Broadcast an encoded CASTER_LINE frame, narrowed to {@link CASTER_TIERS}. */
  broadcast(opcode: number, frame: ArrayBuffer, tiers?: readonly string[]): void;
  /** Injected server clock (ms) — the ONLY time source (no Date). */
  serverNow(): number;
  /** The room phase — the hype ladder source (calm/normal/hype). */
  phase(): Phase;
  /** Seeded RNG for variant selection (deterministic; no Math.random). */
  rng: Rng;
  /** The current day-record throw (the superlative gate) — day-scoped read. */
  dayRecord?(): DayThrowRecord | null;
  /** Max lines per rotation (default 30). */
  quotaPerRotation?: number;
  /** Min ms between lines — the max-1/10-s rate limit (default 10_000). */
  minGapMs?: number;
  /** No-repeat LRU window (default ~180_000 = 3 min). */
  lruMs?: number;
  /** Significance window the shared scorer samples (default 4_000). */
  windowMs?: number;
}

interface WindowEntry {
  at: number;
  event: RoomEvent;
  /** The callsign attributed to this event's target (throw/impact/grabDuel). */
  callsign?: string;
}

/** The shape id a RoomEvent references (undefined for peer-only events). */
function eventId(e: RoomEvent): string | undefined {
  return 'id' in e ? e.id : undefined;
}

/** The highest-priority pending event (ties keep insertion order — stable). */
function highestPriority(pending: readonly Pending[]): Pending {
  let best = pending[0];
  for (let i = 1; i < pending.length; i++) {
    if (pending[i].priority > best.priority) best = pending[i];
  }
  return best;
}

/** A pending one-shot caster event (fires ahead of window-scored highlights). */
interface Pending {
  event: CasterEvent;
  /** Priority: higher fires first (record > endCard > arm > join > streak). */
  priority: number;
}

const PENDING_PRIORITY = {
  record: 5,
  endCard: 4,
  arm: 3,
  join: 2,
  streak: 1,
} as const;

export class CasterHost {
  private readonly opts: Required<Omit<CasterHostOpts, 'broadcast' | 'serverNow' | 'phase' | 'rng' | 'dayRecord'>> &
    Pick<CasterHostOpts, 'broadcast' | 'serverNow' | 'phase' | 'rng' | 'dayRecord'>;

  /** The rolling significance window (RoomEvents + attributed callsigns). */
  private readonly window: WindowEntry[] = [];

  /** Pending one-shot caster events, highest-priority first. */
  private pending: Pending[] = [];

  /** Rotation-scoped: the LRU of recently-emitted templateIds → last-emit ms. */
  private readonly lru = new Map<number, number>();

  /** Rotation-scoped: lines emitted this rotation (the quota counter). */
  private linesThisRotation = 0;

  /** Rotation-scoped: the server ms of the last emitted line (rate limit). */
  private lastLineAt = -Infinity;

  /** Rotation-scoped: the last thrower's callsign + streak length. */
  private streakCallsign: string | null = null;
  private streakLen = 0;

  /** Rotation-scoped: shapeId → last thrower's callsign (attributes floor impacts). */
  private readonly throwerOf = new Map<string, string>();

  /** Single caption authority: true while a showpiece owns the caption. */
  private showpieceActive = false;

  /**
   * DAY-scoped (survives RESET): the highest throw speed this host has announced
   * as a record. A throw beats the record iff it clears BOTH the persisted
   * day-record and this high-water — so a record is announced at most once per
   * speed, and never re-fired for a slower throw after RESET.
   */
  private announcedRecordSpeed = 0;

  constructor(opts: CasterHostOpts) {
    this.opts = {
      broadcast: opts.broadcast,
      serverNow: opts.serverNow,
      phase: opts.phase,
      rng: opts.rng,
      dayRecord: opts.dayRecord,
      quotaPerRotation: opts.quotaPerRotation ?? 30,
      minGapMs: opts.minGapMs ?? 10_000,
      lruMs: opts.lruMs ?? 180_000,
      windowMs: opts.windowMs ?? 4_000,
    };
  }

  // -------------------------------------------------------------------------
  // Ingest.
  // -------------------------------------------------------------------------

  /** Ingest one normalized caster input. Updates streaks + window + pending. */
  onEvent(input: CasterInput): void {
    const now = this.opts.serverNow();
    switch (input.kind) {
      case 'throw': {
        this.throwerOf.set(input.id, input.callsign);
        this.pushWindow(now, { kind: 'release', id: input.id, peerId: input.callsign, speed: input.speed }, input.callsign);
        // Only a SIGNIFICANT throw advances a streak / can set a record — a soft
        // toss is beneath the caster (SILENCE default; a streak of taps is not a
        // moment). The shared floor is the same one the scorer uses.
        if (input.speed >= CASTER_SCORER_CFG.minActivitySpeed) {
          this.bumpStreak(input.callsign);
          this.maybeQueueStreak(input.callsign);
          this.maybeQueueRecord(input.callsign, input.speed);
        }
        break;
      }
      case 'impact': {
        // Attribute the impact to the explicit callsign, else the shape's thrower.
        const callsign = input.callsign ?? this.throwerOf.get(input.id);
        this.pushWindow(now, { kind: 'impact', id: input.id, speed: input.speed }, callsign);
        break;
      }
      case 'spawn':
        this.pushWindow(now, { kind: 'spawn', id: input.id });
        break;
      case 'grabDuel':
        this.pushWindow(now, { kind: 'grab-rejected', id: input.id, peerId: input.callsign, by: null }, input.callsign);
        break;
      case 'join': {
        const who = parseCallsign(input.callsign);
        if (who) this.queuePending({ kind: 'join', who }, PENDING_PRIORITY.join);
        break;
      }
      case 'showpieceStart':
        this.showpieceActive = true;
        break;
      case 'showpieceArm': {
        this.showpieceActive = true;
        const who = input.callsign ? parseCallsign(input.callsign) ?? undefined : undefined;
        this.queuePending({ kind: 'arm', who }, PENDING_PRIORITY.arm);
        break;
      }
      case 'showpieceEnd': {
        const who = input.callsign ? parseCallsign(input.callsign) : null;
        if (who) {
          this.queuePending(
            { kind: 'endCard', who, catches: Math.max(0, Math.floor(input.catches ?? 0)) },
            PENDING_PRIORITY.endCard
          );
        }
        this.showpieceActive = false;
        break;
      }
    }
  }

  private pushWindow(at: number, event: RoomEvent, callsign?: string): void {
    this.window.push({ at, event, callsign });
    this.pruneWindow(at);
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (this.window.length > 0 && this.window[0].at < cutoff) this.window.shift();
  }

  private bumpStreak(callsign: string): void {
    if (callsign === this.streakCallsign) this.streakLen += 1;
    else {
      this.streakCallsign = callsign;
      this.streakLen = 1;
    }
  }

  private maybeQueueStreak(callsign: string): void {
    if (this.streakLen < CASTER_STREAK_MIN) return;
    const who = parseCallsign(callsign);
    if (who) this.queuePending({ kind: 'streak', who, streakCount: this.streakLen }, PENDING_PRIORITY.streak);
  }

  private maybeQueueRecord(callsign: string, speed: number): void {
    // A "FASTEST THROW TODAY" superlative fires ONLY against an ESTABLISHED
    // day-stats record (spec §7.15 — "only when the record is actually beaten").
    // With no day record yet there is nothing to beat → SILENCE.
    const dayBest = this.opts.dayRecord?.()?.speedMs ?? 0;
    if (dayBest <= 0) return;
    const bar = Math.max(dayBest, this.announcedRecordSpeed);
    if (speed <= bar) return; // not a real record → SILENCE on the superlative
    const who = parseCallsign(callsign);
    if (!who) return;
    this.announcedRecordSpeed = speed; // day-scoped high-water (survives RESET)
    this.queuePending({ kind: 'record', who, recordSpeed: speed }, PENDING_PRIORITY.record);
  }

  private queuePending(event: CasterEvent, priority: number): void {
    this.pending.push({ event, priority });
  }

  /**
   * Drive single caption authority off a live showpiece flag (the sim loop passes
   * `siege.active || encore.active`). A rising edge queues an `arm` line and takes
   * the caption; a FALLING edge queues the defender `endCard` summary (C26 fix —
   * production previously fed only the rising 'arm' edge, so the end-card summary
   * never aired) BEFORE releasing authority. `endCard` is one of the two kinds
   * allowed under showpiece authority, so it airs on the same tick the flag falls.
   * The summary needs a self-contained callsign (the siege's top defender); with
   * none — e.g. the encore FINALE, which has no defender — authority simply releases
   * quietly (a `who`-less endCard binds to SILENCE anyway). Idempotent — a steady
   * flag is a no-op.
   */
  setShowpieceActive(on: boolean, endCard?: CasterEndCard | null): void {
    if (on && !this.showpieceActive) {
      this.showpieceActive = true;
      this.queuePending({ kind: 'arm' }, PENDING_PRIORITY.arm);
    } else if (!on && this.showpieceActive) {
      const who = endCard?.callsign ? parseCallsign(endCard.callsign) : null;
      if (who) {
        this.queuePending(
          { kind: 'endCard', who, catches: Math.max(0, Math.floor(endCard!.catches)) },
          PENDING_PRIORITY.endCard
        );
      }
      this.showpieceActive = false;
    }
  }

  // -------------------------------------------------------------------------
  // Tick — the frame-quantized decision. Returns the CasterLine emitted this
  // tick (also broadcast), or null.
  // -------------------------------------------------------------------------

  /**
   * Evaluate the caster for this tick. Returns the emitted {@link CasterLine} (and
   * broadcasts its CASTER_LINE frame) or null. Deterministic given the injected
   * clock + rng. Gates in order: rate limit → quota → single authority → build a
   * candidate → no-repeat LRU (via `avoidTemplateIds`) → SILENCE-by-default.
   */
  tick(): CasterLine | null {
    const now = this.opts.serverNow();
    this.pruneWindow(now);
    this.pruneLru(now);

    // Rate limit: max 1 line / minGapMs.
    if (now - this.lastLineAt < this.opts.minGapMs) return null;
    // Per-rotation quota.
    if (this.linesThisRotation >= this.opts.quotaPerRotation) return null;

    const event = this.pickEvent();
    if (!event) return null;

    // Single caption authority: while a showpiece owns the caption, ONLY arm /
    // endCard may emit (spec §7.15 — F6's callout queue owns catch/swat/hit).
    if (this.showpieceActive && event.kind !== 'arm' && event.kind !== 'endCard') {
      return null;
    }

    const avoid = new Set(this.lru.keys());
    const line = casterLine(event, { phase: this.opts.phase(), avoidTemplateIds: avoid }, this.opts.rng);
    if (!line) return null;

    // Commit: LRU + quota + rate + clear the consumed candidate.
    this.lru.set(line.templateId, now);
    this.linesThisRotation += 1;
    this.lastLineAt = now;
    this.consume(event);

    this.emit(line);
    return line;
  }

  /**
   * Choose this tick's candidate: a pending one-shot (record/endCard/arm/join/
   * streak, highest priority) beats a window-scored highlight (throw/impact/
   * shapeRain/grabDuel). Under showpiece authority, non-arm/endCard candidates are
   * still built here but suppressed by the authority gate in {@link tick}.
   */
  private pickEvent(): CasterEvent | null {
    // Single caption authority (spec §7.15): while a showpiece owns the caption,
    // ONLY an arm/endCard pending event is eligible — nothing else (not a lower
    // pending, not a window highlight) may surface.
    if (this.showpieceActive) {
      const eligible = this.pending.filter((p) => p.event.kind === 'arm' || p.event.kind === 'endCard');
      return eligible.length > 0 ? highestPriority(eligible).event : null;
    }
    // Otherwise a pending one-shot beats a window-scored highlight.
    if (this.pending.length > 0) return highestPriority(this.pending).event;
    return this.scoreWindow();
  }

  /** Reuse the SHARED C21 highlight scorer over the window → a CasterEvent. */
  private scoreWindow(): CasterEvent | null {
    if (this.window.length === 0) return null;
    const events = this.window.map((w) => w.event);
    const hi = scoreHighlight(events, CASTER_SCORER_CFG);
    if (!hi) return null;
    switch (hi.kind) {
      case 'THROW': {
        const who = this.callsignForTarget(hi.targetId, 'release');
        return who ? { kind: 'throw', who, releaseVel: hi.score } : null;
      }
      case 'SLAM': {
        const who = this.callsignForTarget(hi.targetId, 'impact');
        return who ? { kind: 'impact', who, impactSpeed: hi.score } : null;
      }
      case 'SHAPE_RAIN':
        return { kind: 'shapeRain', spawnCount: Math.round(hi.score) };
      case 'GRAB_DUEL': {
        const who = this.callsignForTarget(hi.targetId, 'grab-rejected');
        return who ? { kind: 'grabDuel', who } : null;
      }
    }
  }

  /** The self-contained callsign for a scored highlight's target (or null). */
  private callsignForTarget(targetId: string | undefined, kind: RoomEvent['kind']): CasterCallsign | null {
    if (targetId === undefined) return null;
    // The strongest matching window entry carries the attributed callsign.
    for (let i = this.window.length - 1; i >= 0; i--) {
      const w = this.window[i];
      if (w.event.kind === kind && eventId(w.event) === targetId && w.callsign) {
        return parseCallsign(w.callsign);
      }
    }
    return null;
  }

  private consume(event: CasterEvent): void {
    // Remove the emitted pending one-shot (by identity), if it was one.
    const idx = this.pending.findIndex((p) => p.event === event);
    if (idx >= 0) this.pending.splice(idx, 1);
    // A window-scored line clears the window so the same burst is not re-aired.
    else this.window.length = 0;
  }

  private pruneLru(now: number): void {
    const cutoff = now - this.opts.lruMs;
    for (const [id, at] of this.lru) if (at < cutoff) this.lru.delete(id);
  }

  private emit(line: CasterLine): void {
    const frame = encodeBinary(OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, {
      templateId: line.templateId,
      slots: casterSlotsToWire(line.slots),
    });
    this.opts.broadcast(OPCODES.CASTER_LINE, frame, CASTER_TIERS);
  }

  // -------------------------------------------------------------------------
  // Rotation boundary.
  // -------------------------------------------------------------------------

  /**
   * RESET (spec §7.15): clear ALL rotation-scoped memory — streaks, LRU, quota,
   * window, pending, and showpiece state. The day-record high-water is
   * DELIBERATELY kept (records are day-scoped, cross-rotation only via day-stats).
   */
  reset(): void {
    this.window.length = 0;
    this.pending = [];
    this.lru.clear();
    this.linesThisRotation = 0;
    this.lastLineAt = -Infinity;
    this.streakCallsign = null;
    this.streakLen = 0;
    this.throwerOf.clear();
    this.showpieceActive = false;
    // announcedRecordSpeed is NOT cleared — day-scoped.
  }

  /** Lines emitted this rotation (for tests / metrics). */
  get lineCount(): number {
    return this.linesThisRotation;
  }

  /** True while a showpiece owns the caption (single-authority state, for tests). */
  get underShowpiece(): boolean {
    return this.showpieceActive;
  }
}
