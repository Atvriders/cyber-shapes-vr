/**
 * recorder.ts — the F10 Ghost Arcade ReelRecorder (C13, spec §7.10 / §6.1 / §7.17).
 *
 * TEES the room's outbound event stream into a rolling ring buffer, with
 * RECORD-TIME SANITIZATION (never a post-hoc scrub — the raw bytes never store
 * PII or voice):
 *   • ALL 0x1x voice frames are EXCLUDED (binary opcodes 0x10–0x1F AND the JSON
 *     `voice-*` ServerMsgs) — test-enforced. Room voice never enters a reel, so
 *     a published clip can never contain a private conversation.
 *   • IDENTITY is ANONYMIZED: any free-text `name` is replaced with a stable
 *     GHOST_XX handle (callsigns/GHOST_XX only reach a reel — §6.1). No raw name
 *     string ever reaches the reel bytes.
 *   • The `synthetic` presence flag is PRESERVED (§7.17) so a banked daemon
 *     replays with its DAEMON badge.
 *   • Rolling caps bound the ring buffer (honest ~5–7 KB/s budget, §7.10).
 *
 * AUTO-BANKER: on room-empty, score the recorded windows by (events/s + shapes +
 * players) and bank the highest — but DAEMON-HEAVY windows are DOWN-RANKED, never
 * blanket-excluded (quiet-hour daemon sessions are the typical capture, §7.17).
 *
 * The whole module is deterministic on an INJECTED clock. It builds reels via the
 * pure `packages/shared/src/reels.ts` coalescer, so a banked artifact replays
 * through the same reducer the keystone parity test covers.
 */

import {
  buildReel,
  type ReelEvent,
  type Reel,
} from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';

/** Voice opcode window (Phase B): 0x10–0x1F. Any binary frame here is EXCLUDED. */
const VOICE_OPCODE_LO = 0x10;
const VOICE_OPCODE_HI = 0x1f;

/** A synthetic (Daemon Crew) peer id prefix (§6.1 / §7.17). Down-ranked in banking. */
const SYNTHETIC_PREFIX = 'DMN-';

export interface ReelRecorderOpts {
  /** Injected clock (ms). Fake in tests; real Date.now-derived in production. */
  now: () => number;
  /** Rolling cap: max raw events retained (oldest evicted). Default 200k. */
  capFrames?: number;
  /** Segment length (ms) for coalescing when a reel is materialized. Default 100. */
  segmentMs?: number;
}

/** A scored candidate window over the recorded ring (auto-banker). */
export interface ScoredWindow {
  /** Wall time (ms) the window starts at. */
  startWallTime: number;
  /** Wall time (ms) the window ends at. */
  endWallTime: number;
  /** Composite score (events/s + shapes + players), daemon-heavy DOWN-RANKED. */
  score: number;
  /** Fraction (0..1) of the window's join/activity that was synthetic. */
  syntheticFraction: number;
  /** The (sanitized) raw events inside the window. */
  events: ReelEvent[];
}

export interface ScoreWindowsOpts {
  /** Window width in ms. Default 30 s (a hero-take length). */
  windowMs?: number;
  /** Step between candidate window starts (ms). Default = windowMs (tiled). */
  stepMs?: number;
}

/**
 * How hard a daemon-heavy window is penalized. A fully-synthetic window keeps
 * (1 - DAEMON_PENALTY) of its score — never zero, so it can still be banked when
 * it is the only content (§7.17: down-ranked, NEVER excluded).
 */
const DAEMON_PENALTY = 0.5;

export class ReelRecorder {
  private readonly now: () => number;
  private readonly capFrames: number;
  private readonly segmentMs: number;

  /** The rolling ring of SANITIZED raw events (oldest at index 0). */
  private readonly raw: ReelEvent[] = [];

  /** Count of 0x1x voice frames EXCLUDED at record time (test-enforced). */
  private _excludedVoiceCount = 0;

  /** Monotonic tick stamp (a fallback when a msg carries no serverTick). */
  private _tick = 0;

  constructor(opts: ReelRecorderOpts) {
    this.now = opts.now;
    this.capFrames = opts.capFrames ?? 200_000;
    this.segmentMs = opts.segmentMs ?? 100;
  }

  // ---- Counters (for tests + ops) -----------------------------------------

  get excludedVoiceCount(): number {
    return this._excludedVoiceCount;
  }
  get rawEventCount(): number {
    return this.raw.length;
  }

  // ---- Tee (the record-time sanitizing intake) ----------------------------

  /**
   * Tee one BINARY outbound frame. A voice frame (opcode 0x10–0x1F) is EXCLUDED
   * and counted; any other binary frame is currently ignored by the reel (the
   * reel records the JSON ServerMsg stream — binary Phase C opcodes are replayed
   * from their JSON ServerMsg forms). This method exists so the exclusion of
   * voice is structural + testable even on the raw binary path.
   */
  teeBinary(buf: ArrayBuffer): void {
    if (buf.byteLength < 1) return;
    const opcode = new DataView(buf).getUint8(0);
    if (opcode >= VOICE_OPCODE_LO && opcode <= VOICE_OPCODE_HI) {
      this._excludedVoiceCount += 1;
      return; // voice NEVER enters a reel (§6.1)
    }
    // Non-voice binary frames are not reel-recorded here (their JSON ServerMsg
    // form is teed instead) — no-op.
  }

  /**
   * Tee one outbound ServerMsg. Voice-* messages are EXCLUDED; identity names are
   * ANONYMIZED; the synthetic flag is PRESERVED. The sanitized event is appended
   * to the rolling ring (oldest evicted past the cap).
   */
  tee(msg: ServerMsg): void {
    if (isVoiceMsg(msg)) {
      this._excludedVoiceCount += 1;
      return;
    }
    const sanitized = sanitize(msg);
    const tick = extractTick(msg) ?? this._tick++;
    this.raw.push({ tick, wallTime: this.now(), msg: sanitized });
    // Rolling cap: evict the oldest events past the cap.
    while (this.raw.length > this.capFrames) this.raw.shift();
  }

  // ---- Reel materialization ------------------------------------------------

  /** Materialize the WHOLE ring as a replayable coalesced reel (for tests/export). */
  snapshotReel(): Reel {
    return buildReel(this.raw, { now: this.now, segmentMs: this.segmentMs });
  }

  // ---- Auto-banker ---------------------------------------------------------

  /**
   * Score every candidate window over the ring by (events/s + shapes + players),
   * DOWN-RANKING daemon-heavy windows (never excluding them). Returns windows in
   * ring order (ascending startWallTime).
   */
  scoreWindows(opts: ScoreWindowsOpts = {}): ScoredWindow[] {
    const windowMs = opts.windowMs ?? 30_000;
    // A SLIDING window (fine step) so a candidate can align to a burst of
    // activity — a coarse tile that straddles a quiet+busy boundary would
    // under-score the real highlight. Default step = a quarter window.
    const stepMs = opts.stepMs ?? Math.max(1, Math.floor(windowMs / 4));
    if (this.raw.length === 0) return [];

    const t0 = this.raw[0].wallTime;
    const tEnd = this.raw[this.raw.length - 1].wallTime;
    const windows: ScoredWindow[] = [];

    for (let start = t0; start <= Math.max(t0, tEnd); start += stepMs) {
      const end = start + windowMs;
      const events = this.raw.filter((e) => e.wallTime >= start && e.wallTime < end);
      if (events.length === 0) continue;
      windows.push(this.scoreWindow(start, end, events, windowMs));
    }
    return windows;
  }

  /** Pick the single HIGHEST-scoring window, or null if the ring is empty. */
  pickBestWindow(opts: ScoreWindowsOpts = {}): ScoredWindow | null {
    const windows = this.scoreWindows(opts);
    if (windows.length === 0) return null;
    // Highest score wins; on a TIE prefer the LATER (fresher) window — two
    // windows that capture the identical burst are equally good, so bank the
    // most recent one rather than an earlier one padded with dead air.
    return windows.reduce((best, w) => (w.score >= best.score ? w : best));
  }

  /**
   * Auto-bank on room-empty: pick the best window and materialize it as a
   * replayable reel (segment start keyframe included). Returns null if nothing
   * was recorded. Daemon-heavy windows are down-ranked but STILL bankable when
   * they are the only content.
   */
  bankOnEmpty(opts: ScoreWindowsOpts = {}): Reel | null {
    const best = this.pickBestWindow(opts);
    if (!best) return null;
    return buildReel(best.events, { now: this.now, segmentMs: this.segmentMs });
  }

  /**
   * Bank the current best highlight window on a STAFF/cue trigger (the C13 BANK
   * cue) — identical scoring to {@link bankOnEmpty} but named for the on-demand
   * path (a session is banked while the room is still live, not only on empty).
   */
  bankHighlight(opts: ScoreWindowsOpts = {}): Reel | null {
    return this.bankOnEmpty(opts);
  }

  /** Drop the ring (called after banking or on a new session). */
  reset(): void {
    this.raw.length = 0;
    this._excludedVoiceCount = 0;
    this._tick = 0;
  }

  // ---- Scoring internals ---------------------------------------------------

  private scoreWindow(
    start: number,
    end: number,
    events: ReelEvent[],
    windowMs: number
  ): ScoredWindow {
    const seconds = Math.max(windowMs / 1000, 0.001);
    const eventsPerSecond = events.length / seconds;

    // Distinct shapes touched + distinct players joined; synthetic joins counted
    // separately so a daemon-driven window can be DOWN-RANKED (not excluded).
    const shapeIds = new Set<string>();
    let humanJoins = 0;
    let syntheticJoins = 0;
    for (const e of events) {
      const m = e.msg;
      collectShapeId(m, shapeIds);
      if (m.t === 'player-join') {
        if (isSyntheticPlayer(m.player)) syntheticJoins += 1;
        else humanJoins += 1;
      }
    }
    const totalJoins = humanJoins + syntheticJoins;
    const syntheticFraction = totalJoins === 0 ? 0 : syntheticJoins / totalJoins;

    // Composite raw score: activity + world richness + human presence.
    const rawScore = eventsPerSecond + shapeIds.size + humanJoins * 2 + syntheticJoins;

    // Down-rank daemon-heavy windows: scale by (1 - penalty*syntheticFraction),
    // which is ≥ (1 - DAEMON_PENALTY) > 0 — never excluded (§7.17).
    const score = rawScore * (1 - DAEMON_PENALTY * syntheticFraction);

    return { startWallTime: start, endWallTime: end, score, syntheticFraction, events };
  }
}

// ---------------------------------------------------------------------------
// Sanitization helpers.
// ---------------------------------------------------------------------------

/** True iff the ServerMsg is a voice-* message (excluded from reels). */
function isVoiceMsg(msg: ServerMsg): boolean {
  return typeof msg.t === 'string' && msg.t.startsWith('voice');
}

/** True iff a player entry is a synthetic (Daemon Crew) peer (§7.17). */
function isSyntheticPlayer(p: { id: string; synthetic?: boolean }): boolean {
  return p.synthetic === true || p.id.startsWith(SYNTHETIC_PREFIX);
}

// ---------------------------------------------------------------------------
// Sanitizer EXHAUSTIVENESS guard (integration-hardening #10).
//
// `sanitize()` was an if/if/default-clone: a FUTURE ServerMsg kind that carries a
// raw free-text `name` (a `player` / `players[]`) would ride the `default` branch
// UN-anonymized and leak PII into a published reel. Two compile-time guards close
// that hole:
//
//   1. {@link NameBearingKind} is COMPUTED from the ServerMsg union — the set of
//      kinds whose payload structurally carries a `{ name: string }` (a `player`
//      or a `players[]`). Add such a field to any ServerMsg and this union GROWS
//      automatically.
//   2. {@link NAME_BEARING_KINDS} is a `Record<NameBearingKind, true>` — a new
//      name-bearing kind makes it MISSING A KEY (a compile error), forcing the
//      author to register it; and the switch below closes over that same union
//      with a `never` default, so an unhandled kind ALSO fails to compile.
//
// Net effect: a name-bearing ServerMsg kind cannot be added without being routed
// through an explicit anonymizer here — the reel can never silently leak a name.
// ---------------------------------------------------------------------------

/** The ServerMsg kinds whose payload structurally carries a free-text player name. */
type NameBearingMsg = Extract<
  ServerMsg,
  { player: { name: string } } | { players: Array<{ name: string }> }
>;
/** The discriminant `t` values of every {@link NameBearingMsg} (auto-derived). */
export type NameBearingKind = NameBearingMsg['t'];

/**
 * The registry of name-bearing kinds. Typed `Record<NameBearingKind, true>` so a
 * NEW name-bearing ServerMsg kind is a COMPILE ERROR here until registered — the
 * runtime {@link isNameBearing} predicate then narrows to the full union so the
 * exhaustive switch in {@link sanitizeNameBearing} must also handle it.
 */
export const NAME_BEARING_KINDS: Record<NameBearingKind, true> = {
  'player-join': true,
  welcome: true,
};

/** True (and narrows to {@link NameBearingMsg}) iff the msg is a name-bearing kind. */
function isNameBearing(msg: ServerMsg): msg is NameBearingMsg {
  return Object.prototype.hasOwnProperty.call(NAME_BEARING_KINDS, msg.t);
}

/** A compile-time exhaustiveness assertion that also THROWS at runtime. */
function assertNever(x: never, label: string): never {
  throw new Error(`${label}: unhandled name-bearing kind ${JSON.stringify(x)}`);
}

/**
 * Anonymize a KNOWN name-bearing ServerMsg. The switch is EXHAUSTIVE over
 * {@link NameBearingKind} with a `never` default — a future name-bearing kind
 * that reaches here without a case FAILS TO COMPILE (and throws at runtime,
 * exercised by the exhaustiveness test), never leaking a raw name.
 */
export function sanitizeNameBearing(msg: NameBearingMsg): ServerMsg {
  switch (msg.t) {
    case 'player-join':
      return { ...msg, player: anonymizePlayer(msg.player) };
    case 'welcome':
      return {
        ...msg,
        players: msg.players.map(anonymizePlayer),
        shapes: msg.shapes.map((s) => ({ ...s })),
      };
    default:
      return assertNever(msg, 'sanitizeNameBearing');
  }
}

/**
 * Anonymize identity: replace any free-text `name` with a stable GHOST_XX handle
 * derived from the peer id, while PRESERVING the `synthetic` flag (§7.17). Deep-
 * copies the message so the ring never aliases live room state. Non-identity
 * messages are deep-cloned unchanged. Name-bearing kinds route through the
 * EXHAUSTIVENESS-guarded {@link sanitizeNameBearing} (#10).
 */
export function sanitize(msg: ServerMsg): ServerMsg {
  if (isNameBearing(msg)) return sanitizeNameBearing(msg);
  // Structured clone for everything else so the ring holds a private copy.
  return structuredCloneSafe(msg);
}

/**
 * Replace a player's free-text name with GHOST_XX (never a real name reaches a
 * reel — §6.1). The `synthetic` flag rides through untouched (§7.17). The handle
 * is deterministic from the peer id so the same peer maps to the same ghost.
 */
function anonymizePlayer<T extends { id: string; name: string; color: number; synthetic?: boolean }>(
  p: T
): T {
  const ghost = ghostHandleFor(p.id);
  return {
    ...p,
    name: ghost,
    ...(p.synthetic === true ? { synthetic: true } : {}),
  };
}

/** Deterministic GHOST_XX handle from a peer id (two-digit, stable per id). */
function ghostHandleFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const n = h % 100;
  return `GHOST_${String(n).padStart(2, '0')}`;
}

/** Collect any shape id a message references (for window richness scoring). */
function collectShapeId(msg: ServerMsg, out: Set<string>): void {
  switch (msg.t) {
    case 'spawn':
      out.add(msg.shape.id);
      break;
    case 'despawn':
    case 'recolor':
    case 'rendermode':
    case 'scale':
    case 'grab':
      out.add(msg.id);
      break;
    case 'state':
      for (const s of msg.shapes) out.add(s.id);
      break;
    default:
      break;
  }
}

/** Extract the source serverTick from a message, or null if it carries none. */
function extractTick(msg: ServerMsg): number | null {
  if (msg.t === 'state') return msg.serverTick;
  return null;
}

/**
 * A JSON-safe deep clone that never throws on a plain ServerMsg. Uses
 * structuredClone when available; falls back to JSON round-trip (reels are
 * plain data — no functions, no cycles).
 */
function structuredCloneSafe<T>(v: T): T {
  const sc = (globalThis as { structuredClone?: (x: T) => T }).structuredClone;
  if (typeof sc === 'function') return sc(v);
  return JSON.parse(JSON.stringify(v)) as T;
}
