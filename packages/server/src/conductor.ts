/**
 * conductor.ts — Task C18 F8 Resonora server Conductor (spec §7.8).
 *
 * The world is the instrument: floor impacts become on-beat notes in a
 * deterministic generative synthwave score. This host is server-authoritative and
 * owns the musical clock.
 *
 * It:
 *   • broadcasts MUSIC_CLOCK (~1 Hz) via the C1 Appendix B golden codec
 *     (opcodes.ts) — bpm / beatIndex / gridOrigin, the grid every client shares;
 *   • turns each floor impact into a MUSIC_NOTE (pure {@link noteMap}), quantized
 *     to the 16th grid ({@link quantizeNote}) at `playAtServerTime`, with a
 *     DETERMINISTIC {@link computeNoteId} so a client's PREDICTED note and this
 *     echo dedupe to ONE audible note;
 *   • applies a per-player note budget ({@link applyNoteBudget}) that TRUNCATES a
 *     burst (a 50-impact flood) — one spammer can't drown the mix;
 *   • runs the auto-intensity governor ({@link intensityGovernor}) — density
 *     scales monotonically with activity (mellow attract groove when idle);
 *   • exposes the DETERMINISTIC backing layer ({@link backingBar}) — seeded from
 *     (roomSeed, beatIndex, histogram), IDENTICAL on all clients → zero traffic.
 *
 * PURITY / TIME: no Date/Math.random here — the musical clock is an injected
 * `serverNow()` (the C3 server clock), and all note math is the pure shared core.
 * MUSIC is ALWAYS the C1 golden codec — this host never invents a byte layout.
 */

import {
  OPCODES,
  MUSIC_KIND,
  encodeBinary,
  beatAt,
  sixteenthAt,
  noteMap,
  computeNoteId,
  quantizeNote,
  applyNoteBudget,
  intensityGovernor,
  backingBar,
  type ShapeType,
  type ActivityHistogram,
  type BackingBar,
  type BeatClockConfig,
  type QuantizerClock,
} from '@cyber-shapes/shared';

/** MUSIC fans out to the resident-class receive set + spectator/audience (spec §5.1). */
export const MUSIC_TIERS: readonly string[] = [
  'resident',
  'spectator',
  'director',
  'audience',
];

/** One floor impact the conductor scores (the C0 impactSpeed broadcast + shape facts). */
export interface ImpactInput {
  /** The impacting shape's id. */
  shapeId: string;
  /** The player attributed the impact (for the per-player budget + noteId). */
  playerId: string;
  /** The shape's color index (→ pitch). */
  colorIndex: number;
  /** The shape type (→ timbre + role). */
  type: ShapeType;
  /** The shape's scale/size (→ octave). */
  size: number;
  /** The impact speed on the contact tick (C0) — drives velocity. */
  impactSpeed: number;
  /** The shape's world x at impact (→ pan). */
  posX: number;
  /**
   * The client's estimated p95 one-way delay (ms) for the attributed player, if
   * known (C3 rttMs/2). Absent → the conductor's default lookahead is used.
   */
  p95OneWayDelayMs?: number;
}

export interface ConductorOpts {
  /** The room seed — the ONLY entropy the deterministic backing layer sees. */
  roomSeed: number;
  /** The musical tempo (BPM). */
  bpm: number;
  /** The grid origin (ms, server/roomEpoch time-base) — beat 0 / 16th 0. */
  gridOriginMs: number;
  /** The injected server clock (C3) — the musical clock reads this. No Date here. */
  serverNow: () => number;
  /**
   * Broadcast a binary MUSIC frame. `payload` is the encoded ArrayBuffer (the
   * full Appendix B frame). Narrowed to {@link MUSIC_TIERS}.
   */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /**
   * Default client p95 one-way delay (ms) when an impact carries none. The spec
   * §5.5 lead for Resonora is one-to-two 16ths (125–300 ms adaptive); this is the
   * fallback the quantizer margins on top of. Default 60 ms.
   */
  defaultP95OneWayDelayMs?: number;
  /** The activity window (ms) the governor/backing histogram samples. Default 4000. */
  activityWindowMs?: number;
}

/**
 * The Resonora server Conductor. Construct once per room; call {@link tickClock}
 * on the ~1 Hz cadence and {@link onImpacts} from the sim loop's impact list.
 */
export class Conductor {
  private readonly opts: Required<Omit<ConductorOpts, 'broadcast' | 'serverNow'>> &
    Pick<ConductorOpts, 'broadcast' | 'serverNow'>;

  /** Recent impact timestamps (server ms) for the activity histogram window. */
  private readonly recentImpacts: Array<{ at: number; playerId: string }> = [];

  constructor(opts: ConductorOpts) {
    this.opts = {
      roomSeed: opts.roomSeed >>> 0,
      bpm: opts.bpm,
      gridOriginMs: opts.gridOriginMs,
      serverNow: opts.serverNow,
      broadcast: opts.broadcast,
      defaultP95OneWayDelayMs: opts.defaultP95OneWayDelayMs ?? 60,
      activityWindowMs: opts.activityWindowMs ?? 4000,
    };
  }

  private get clockCfg(): QuantizerClock {
    return { bpm: this.opts.bpm, gridOriginMs: this.opts.gridOriginMs };
  }

  /** The beat-clock config (origin-named) the grid helpers consume. */
  private get beatCfg(): BeatClockConfig {
    return { bpm: this.opts.bpm, originMs: this.opts.gridOriginMs };
  }

  /** The current activity histogram over the recent window (for the governor + backing). */
  private histogram(now: number): ActivityHistogram {
    this.pruneWindow(now);
    const players = new Set<string>();
    for (const e of this.recentImpacts) players.add(e.playerId);
    return { impactsInWindow: this.recentImpacts.length, activePlayers: players.size };
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.opts.activityWindowMs;
    while (this.recentImpacts.length > 0 && this.recentImpacts[0].at < cutoff) {
      this.recentImpacts.shift();
    }
  }

  /** The auto-intensity governor value (0..1) at the current server time. */
  intensity(): number {
    return intensityGovernor(this.histogram(this.opts.serverNow()));
  }

  /**
   * The deterministic backing bar for `beatIndex` (identical across clients). The
   * histogram defaults to the live window but may be supplied for a specific
   * cross-client comparison. Emits NO traffic — clients render it locally.
   */
  backingLayer(beatIndex: number, histogram?: ActivityHistogram): BackingBar {
    const h = histogram ?? this.histogram(this.opts.serverNow());
    return backingBar(this.opts.roomSeed, beatIndex, h);
  }

  /**
   * The deterministic noteId a client would PREDICT for a note struck by
   * `playerId` at server time `eventTime` with color/pitch key `pitchKey`. The
   * conductor's echo carries the SAME id → the synth dedupes to one note.
   */
  predictNoteId(playerId: string, eventTime: number, pitchKey: number): number {
    const slot = sixteenthAt(this.beatCfg, eventTime);
    return computeNoteId(playerId, slot, pitchKey);
  }

  /** Broadcast the MUSIC_CLOCK (bpm / beatIndex / gridOrigin) via the C1 codec. */
  tickClock(): void {
    const now = this.opts.serverNow();
    const beatIndex = beatAt({ bpm: this.opts.bpm, originMs: this.opts.gridOriginMs }, now);
    const frame = encodeBinary(OPCODES.MUSIC, MUSIC_KIND.CLOCK, {
      bpm: this.opts.bpm & 0xffff,
      beatIndex: beatIndex >>> 0,
      gridOriginMs: this.opts.gridOriginMs >>> 0,
      reserved: 0,
    });
    this.opts.broadcast(OPCODES.MUSIC, frame, MUSIC_TIERS);
  }

  /**
   * Score a batch of floor impacts: budget → note-map → quantize → broadcast a
   * MUSIC_NOTE per surviving impact. Deterministic given the same inputs + clock.
   */
  onImpacts(impacts: readonly ImpactInput[]): void {
    const now = this.opts.serverNow();

    // Record activity BEFORE budgeting so the governor sees the true load.
    for (const im of impacts) this.recentImpacts.push({ at: now, playerId: im.playerId });
    this.pruneWindow(now);

    // Per-player note budget — truncate a burst (fair per player).
    const candidates = impacts.map((im, i) => ({
      playerId: im.playerId,
      sixteenthIndex: sixteenthAt(this.beatCfg, now),
      _idx: i,
    }));
    const kept = applyNoteBudget(candidates);

    for (const c of kept) {
      const im = impacts[c._idx];
      const note = noteMap({
        colorIndex: im.colorIndex,
        type: im.type,
        size: im.size,
        impactSpeed: im.impactSpeed,
        posX: im.posX,
      });
      const p95 = im.p95OneWayDelayMs ?? this.opts.defaultP95OneWayDelayMs;
      const q = quantizeNote(now, this.clockCfg, p95);
      // The dedupe key is keyed on the grid SLOT of the EVENT (so predict/echo
      // agree) and the color (pitch key) — a pure function of the causal event.
      const slot = sixteenthAt(this.beatCfg, now);
      const noteId = computeNoteId(im.playerId, slot, im.colorIndex);

      const frame = encodeBinary(OPCODES.MUSIC, MUSIC_KIND.NOTE, {
        noteId: noteId >>> 0,
        playAtMs: Math.max(0, Math.round(q.playAtMs)) >>> 0,
        pitch: note.pitch,
        timbre: note.timbre,
        velocity: note.velocity,
        pan: note.pan,
        reserved: 0,
      });
      this.opts.broadcast(OPCODES.MUSIC, frame, MUSIC_TIERS);
    }
  }
}
