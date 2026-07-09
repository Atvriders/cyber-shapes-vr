/**
 * connection.ts — Per-connection WebSocket handling (Task B3).
 *
 * Pure I/O: no domain logic beyond what RoomManager/Room expose.
 * All domain logic lives in room.ts / roomManager.js.
 *
 * All mutable state (socketMeta, roomSockets, voiceEnabled) lives in a
 * per-server "hub" created by makeConnectionHub(). No module-level mutable
 * maps remain, so two startServer() instances in the same process cannot
 * share or bleed state into each other.
 */

import type WebSocket from 'ws';
import {
  decodeText,
  encodeText,
  isVoiceFrame,
  isVoiceOpcode,
  voiceOpcodeOf,
  unpackVoice,
  packVoice,
  validateClientMsg,
  PROTOCOL_VERSION,
  MAX_VOICE_CONFIG_LEN,
  TIER_POLICY,
  TIERS,
  generateCallsign,
  CURATED_WORDLIST,
  systemTimerApi,
  decodeBinary,
  OPCODES,
  SHOWPIECE_KIND,
  SIEGE_WAVES,
  isPhaseCOpcode,
  WISP_KIND,
  WispPulseBucket,
  allocateSlot,
  WISP_CAP,
  chargeStateFrame,
  themeElectionOptions,
  nextThemeId,
  BUILD_KIND,
  TELEKINESIS_KIND,
  LAYOUT_COUNT_CAP,
  validateLayout,
  settleBake,
  layoutToSeeds,
  DEFAULT_PARAMS,
  AUDIENCE_MAX_PER_IP,
  AUDIENCE_RECV_BINARY_OPCODES,
  TIER_CAPS,
} from '@cyber-shapes/shared';
import type { WispFrustum, Layout, LayoutShape } from '@cyber-shapes/shared';
import type {
  ServerMsg,
  ClientMsg,
  Tier,
  TimerApi,
  TimerHandle,
  PeerInfo,
  StatsCard,
  StatsRow,
  NetShape,
  Pose,
  DaemonShapeView,
  DaemonHumanTarget,
  Reel,
  ReelSummary,
} from '@cyber-shapes/shared';
import { ReelRecorder } from './recorder.js';
import type { RoomManager } from './roomManager.js';
import type { Room } from './room.js';
import { applyWispPulse } from './room.js';
import { ROOM_ID_RE } from './persistence.js';
import { handleClockPing, createRttStore } from './clockSync.js';
import type { ClockPingFields, RttStore } from './clockSync.js';
import type { RoomAuthStore } from './auth.js';
import type { MetricsStore } from './metrics.js';
import { RoomTimelineHost, ElectionHost, ThemeChannelHost } from './timeline.js';
import { SiegeHost } from './siege.js';
import { TitanHost } from './titan.js';
import { PowersLabHost } from './powersLab.js';
import { DaemonCrewHost, excludeDaemons, QUEUE_BRIDGE_PROMPT } from './daemons.js';
import { Conductor } from './conductor.js';
import { CasterHost } from './caster.js';
import { EncoreHost } from './encore.js';
import { registerDialCues, registerBuildModeCue, dialLaw, ELECTION_DIAL_OPTIONS } from './dials.js';
import { getBucket } from './bucket-store.js';
import { GlyphManager } from './glyphManager.js';
import { seedAuthoredGlyphs } from './glyphSeeds.js';
import type { GlyphEntry, LayoutManifest } from './buckets.js';
import type { GlyphNet } from '@cyber-shapes/shared';

/** Max bytes buffered per peer before we drop a voice frame for that peer. */
const VOICE_BACKPRESSURE_CAP = 256 * 1024;

/**
 * Task C28 (F17 Daemon Crew) — the SHIP GATE (spec §7.17). Daemons are staff/cue-
 * summoned ONLY at ship; the LOBBY auto-summon (a lone visitor auto-gets a crew)
 * sits behind THIS config flag, which DEFAULTS **OFF**. It is enabled ONLY after the
 * owner acceptance pass of the recorded fetch-and-return script on the real stage
 * (mirrors F8's gate — a taste failure degrades to "feature off", never "bug on the
 * big screen"). Read once at the composition root from the env; absent/≠'1' ⇒ false.
 */
const DAEMON_AUTOSUMMON_LOBBY = process.env.DAEMON_AUTOSUMMON_LOBBY === '1';

/**
 * Task C32 (F21 Powers Lab, spec §7.21): the hand-tracking telekinesis SHIP GATE.
 * The powers-lab cue is advertised ONLY when a resident reports camera-tracked
 * hands (TK_HANDS_STATE) AND this flag is set. It DEFAULTS **OFF** — it is
 * documented ON only after the owner's Quest fps measurement lands in
 * BUDGET_LEDGER.md (hands + a TK pull mid-flight + representative PLAY load, ≥ 72
 * fps, no frame > 20 ms — never an idle-room number). Read at cue-gate time from
 * the env; absent/≠'1' ⇒ false (a taste/perf failure degrades to "exhibit off").
 */
function powersLabEnabled(): boolean {
  return process.env.POWERS_LAB_ENABLED === '1';
}

/** TK_PULL anchor fixed-point: 1 wire unit = 4 mm (the WISP_POSE convention). */
const TK_POS_UNIT_M = 0.004;
/** TK_PULL dir fixed-point: 1 normalized component = 32767 wire units. */
const TK_DIR_UNIT = 32767;
/** TK_RELEASE velocity fixed-point: 1 wire unit = 1 mm/s. */
const TK_VEL_UNIT_M = 0.001;

// ---------------------------------------------------------------------------
// DoS caps (finding #1)
// ---------------------------------------------------------------------------

/**
 * Largest single WS frame we accept. Passed to WebSocketServer.maxPayload so ws
 * rejects (and closes) anything bigger BEFORE it reaches us. Voice frames and
 * JSON intents are all far under this; a 100 MiB default (ws's) is a DoS vector.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Largest binary voice frame we will unpack/relay. A byteLength guard before
 * unpackVoice rejects oversized frames even if they slip under MAX_PAYLOAD.
 */
export const MAX_VOICE_FRAME_BYTES = 8 * 1024;

/**
 * Per-socket message-rate cap (token bucket). Sustained rate = REFILL tokens/s
 * with a BURST-token bucket. A socket that outruns this has its message dropped;
 * on gross flooding the socket is closed. Normal play (pose/held ~20 Hz + voice
 * on the binary path) stays well under this.
 */
export const RATE_REFILL_PER_SEC = 100;
export const RATE_BURST = 200;
/**
 * Consecutive dropped (over-budget) messages before we close the socket. Set
 * well above a single recoverable burst (e.g. a reconnect replay of a few
 * hundred frames): those excess frames are dropped cheaply and the socket
 * stays open. Only a SUSTAINED flood — never letting the bucket refill —
 * accumulates this many consecutive drops and is closed.
 */
export const RATE_CLOSE_AFTER_DROPS = 1000;

// ---------------------------------------------------------------------------
// Task C25 (F14 The Gallery) — audience-tier egress caps + backpressure.
// ---------------------------------------------------------------------------

/** Per-room audience-tier cap (spec §5.1 / §7.14). Mirrors TIER_CAPS.audience. */
export const AUDIENCE_CAP = TIER_CAPS.audience;

/**
 * Per-IP audience join-attempt token bucket (spec §7.14 — the unauthed-surface
 * egress defense; the C4 backoff/token pattern). Bounds the RATE of audience
 * joins from one IP AND throttles the (expensive) cached-keyframe send on top of
 * the hard {@link AUDIENCE_MAX_PER_IP} concurrency cap. Generous burst so a
 * single legit reconnect is never throttled; a stampede from one IP drains it and
 * its keyframe sends are skipped (the roll-forward buffer still catches it up).
 */
export const AUDIENCE_JOIN_REFILL_PER_SEC = 2;
export const AUDIENCE_JOIN_BURST = 6;

/**
 * Backpressure (spec §7.14, mandatory): skip an audience send once the socket has
 * this many bytes already buffered (a slow/stalled viewer never stalls the tick —
 * its send is dropped, the others are unaffected).
 */
export const AUDIENCE_BUFFERED_SKIP_BYTES = 96 * 1024; // ~64–128 KB band
/**
 * The hard ceiling: past this buffered amount the audience socket is DISCONNECTED
 * ("paused — click to rejoin"). A viewer that cannot keep up is dropped, never
 * allowed to accumulate unbounded server memory.
 */
export const AUDIENCE_BUFFERED_HARD_CEILING = 512 * 1024;

/** The backpressure verdict for one audience send given the socket's buffered bytes. */
export type AudienceSendAction = 'send' | 'skip' | 'disconnect';

/**
 * Task C25 — the PURE backpressure decision (spec §7.14): given a socket's
 * `bufferedAmount`, decide whether to send, skip (drop this frame — a slow viewer
 * never stalls the tick), or disconnect ("paused — click to rejoin" past the hard
 * ceiling). Exported so the invariant is unit-testable without a live socket.
 */
export function audienceBackpressureAction(bufferedAmount: number): AudienceSendAction {
  if (bufferedAmount > AUDIENCE_BUFFERED_HARD_CEILING) return 'disconnect';
  if (bufferedAmount > AUDIENCE_BUFFERED_SKIP_BYTES) return 'skip';
  return 'send';
}

/**
 * Task C25 — the CACHED audience late-join keyframe (spec §7.14 "served from the
 * recorder's most recent ~10 s keyframe + roll-forward", zero fresh snapshot
 * serializations). One per room. The sim loop calls {@link refresh} on a ~10 s
 * cadence (serialize ONCE); every late-joining audience socket is sent the SAME
 * cached buffer via {@link getForJoin} — a 128-join Discord burst reuses the one
 * cached string and triggers ZERO fresh serializations (the same-buffer spy
 * invariant). `serializeCount` is exposed so a test can PROVE it.
 */
export class AudienceKeyframeCache {
  private _buf: string | null = null;
  private _serializeCount = 0;
  private _builtAtTick = -1;

  constructor(private readonly _encode: (m: ServerMsg) => string = encodeText) {}

  /** How many times the keyframe has been serialized (the same-buffer proof). */
  get serializeCount(): number {
    return this._serializeCount;
  }

  /** The last cached buffer, or null if never built. */
  get cached(): string | null {
    return this._buf;
  }

  /**
   * (Re)serialize the keyframe from the current world. Called by the sim loop on
   * a rolling cadence — NOT per join. Serializes exactly once per call.
   */
  refresh(shapes: NetShape[], serverTick: number): void {
    this._buf = this._encode({ t: 'audience-keyframe', serverTick, shapes });
    this._serializeCount += 1;
    this._builtAtTick = serverTick;
  }

  /**
   * The cached keyframe to send a late-joining audience socket. If the cache is
   * COLD (no sim tick has refreshed it yet) it is built ONCE here; otherwise the
   * existing buffer is reused verbatim (zero fresh serialization per joiner — the
   * stampede guard). Returns the SAME string reference across a join burst.
   */
  getForJoin(shapes: NetShape[], serverTick: number): string {
    if (this._buf === null) this.refresh(shapes, serverTick);
    return this._buf as string;
  }
}

/** A simple monotonic-time token bucket. Injectable clock for tests. */
export class TokenBucket {
  private _tokens: number;
  private _last: number;
  constructor(
    private readonly _refillPerSec: number,
    private readonly _burst: number,
    private readonly _now: () => number = () => Date.now()
  ) {
    this._tokens = _burst;
    this._last = _now();
  }

  /** Try to consume one token. Returns true if allowed, false if over budget. */
  take(): boolean {
    const now = this._now();
    const elapsedSec = Math.max(0, (now - this._last) / 1000);
    this._last = now;
    this._tokens = Math.min(this._burst, this._tokens + elapsedSec * this._refillPerSec);
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Client intents that are validated + mutated by Room.applyIntent.
 * MUST include every game action so none are silently dropped.
 * `pose` and `voice-*` are intentionally NOT here — they have dedicated branches
 * (pose relays with sender-exclusion; voice is not a game intent).
 */
const GAME_INTENTS: ReadonlySet<string> = new Set([
  'spawn',
  'grab',
  'release',
  'recolor',
  'rendermode',
  'scale',
  'held',
]);

// ---------------------------------------------------------------------------
// Phase C (Task C2) — tiered room manager
// ---------------------------------------------------------------------------

/**
 * The idle window (spec §5.1: 90–120 s) after which an idle `wisp`/`crowd`
 * connection with no intent/pose/heartbeat is disconnected (one-tap rejoin).
 * Chosen at 105 s — comfortably inside the 90–120 s band AND under Cloudflare's
 * ~100 s… wait: the FREE-plan idle-WS timeout is ~100 s, so the CLIENT heartbeat
 * cadence must stay under it (that is a client concern / Phase D note). The
 * server-side idle-kick simply must not fire before a heartbeating client has
 * had a chance to ping; 105 s > any sane client heartbeat, so a live client is
 * never kicked. Non-idle-kicked tiers (resident/spectator/director) never arm it.
 */
export const IDLE_KICK_MS = 105_000;

/**
 * Task C14 (F4): the default headset frustum + stage direction the server passes
 * to `allocateSlot` when it has no live headset pose (a forward-facing booth pose
 * looking down −Z toward the stage). The allocator's determinism means every wisp
 * gets a stable, stage-forward slot; a future task can feed the real headset
 * frustum from a resident's pose to bias more precisely.
 */
const DEFAULT_WISP_FRUSTUM: WispFrustum = {
  pos: { x: 0, y: 1.6, z: 4 },
  dir: { x: 0, y: 0, z: -1 },
  halfAngleCos: Math.cos(Math.PI / 2.5), // ~72° half-angle — a generous booth cone
};
const DEFAULT_STAGE_DIR = { x: 0, y: 0, z: -1 };

/**
 * Negotiate the granted tier for a join request (spec §5.1 "Tier auth").
 *
 *  - An ABSENT `tier` is the legacy Phase B path: `{t:'join'}` with no tier field
 *    joins as `resident` WITHOUT a secret (the Phase B invariant — the as-built
 *    headset/desktop client sends no tier, and every Phase B test joins this
 *    way). This is NOT a privileged TIER_HELLO, so it is not auth-gated. C4's
 *    HMAC rebinding tightens this if the funnel is hardened.
 *  - An EXPLICIT privileged request (`tier:'resident'|'spectator'|'director'`)
 *    is a TIER_HELLO: without the room join secret it is DOWNGRADED to `crowd`,
 *    NEVER rejected (spec §5.1 — assume hostile devtools on the public QR).
 *  - An unknown/invalid tier string is treated as `crowd` (safest public tier).
 *
 * Returns the granted tier plus, when a downgrade occurred, the reason. Cap
 * checks happen separately (they may downgrade further or hard-reject a
 * resident).
 */
export function negotiateTier(
  requested: Tier | undefined,
  joinSecret: string | undefined,
  staffKey: string | undefined
): { tier: Tier; downgradeFrom?: Tier; reason?: string } {
  // Legacy Phase B path: no tier field → trusted resident, no auth.
  if (requested === undefined) {
    return { tier: 'resident' };
  }
  const req: Tier = (TIERS as readonly string[]).includes(requested) ? requested : 'crowd';
  const policy = TIER_POLICY[req];
  if (policy.authRequired) {
    // The provisional secret is `staffKey` (C4 rebinds to an ownerToken HMAC).
    // A constant-time compare is overkill for the provisional env key; C4 owns
    // the hardened comparison.
    const ok = typeof staffKey === 'string' && staffKey.length > 0 && joinSecret === staffKey;
    if (!ok) {
      return { tier: 'crowd', downgradeFrom: req, reason: 'auth' };
    }
  }
  return { tier: req };
}

/**
 * Task C4 — the AUTHED tier negotiation (spec §5.4). Rebinds C2's provisional
 * `STAFF_KEY` to the per-room HMAC join secret while preserving every C2 rule:
 *
 *  - ABSENT `tier` — THE INVERSION (closes the booth-room hole):
 *      • If the room HAS a configured HMAC join secret (a POST /api/rooms booth
 *        room with a persisted joinSecretHash): downgrade to CROWD. A bare join
 *        must not land as resident in an internet-facing booth room.
 *      • If the room has NO configured secret (a Phase B / dev room that
 *        auto-spawned on join): grant RESIDENT (Phase B compat — existing tests
 *        must still pass; the headset client sends no tier in Phase B).
 *  - EXPLICIT privileged tier (resident/spectator/director) authorizes when ANY
 *    of these holds: a VALID HMAC join secret for the room's current epoch, the
 *    C2 GLOBAL `staffKey` (back-compat), or a VALID ownerToken (`isOwner`).
 *    Otherwise → DOWNGRADE to crowd (never reject) AND flag `authFailed` so the
 *    caller arms the (IP, roomId) backoff.
 *  - unknown/invalid tier string → crowd (safest public tier).
 */
export function negotiateAuthedTier(
  requested: Tier | undefined,
  joinSecret: string | undefined,
  isOwner: boolean,
  roomId: string,
  authStore: RoomAuthStore | undefined,
  staffKey: string | undefined
): { tier: Tier; downgradeFrom?: Tier; reason?: string; authFailed?: boolean } {
  // Absent-tier path: the inversion that closes the booth-room hole.
  // A bare {t:'join'} (no tier) was previously always treated as resident.
  // Now: if the room has a configured HMAC secret, it's a booth room — downgrade
  // to crowd. If not, it's a plain dev/Phase-B room — keep resident (compat).
  if (requested === undefined) {
    if (authStore?.hasConfiguredSecret(roomId)) {
      return { tier: 'crowd', downgradeFrom: 'resident', reason: 'auth' };
    }
    return { tier: 'resident' };
  }
  const req: Tier = (TIERS as readonly string[]).includes(requested) ? requested : 'crowd';
  const policy = TIER_POLICY[req];
  if (!policy.authRequired) {
    // Public tier (wisp/crowd) — no secret needed.
    return { tier: req };
  }
  // Privileged tier: authorize via HMAC secret, staffKey fallback, or ownerToken.
  // Dev/Phase-B compat: if the room has NO configured HMAC secret AND there is
  // no staffKey on this server (i.e. no auth mechanism is configured at all),
  // grant the requested tier without a secret. This preserves the Phase B invariant
  // that explicit tier:'resident' still works in dev/test servers with no auth.
  // When a staffKey IS configured, we must still check it — C2 tests rely on this.
  // On an internet-facing booth room (hasConfiguredSecret=true) a secret is required.
  const noAuthConfigured =
    !!authStore &&
    !authStore.hasConfiguredSecret(roomId) &&
    (typeof staffKey !== 'string' || staffKey.length === 0);
  if (noAuthConfigured) {
    return { tier: req };
  }
  // TODO: remove staffKeyOk once the C2 test suite fully migrates to the HMAC path;
  //       staffKey is unset in the real deploy, so this is not a live hole.
  const hmacOk = !!authStore && authStore.verifyJoinSecret(roomId, joinSecret);
  const staffKeyOk =
    typeof staffKey === 'string' && staffKey.length > 0 && joinSecret === staffKey;
  if (hmacOk || staffKeyOk || isOwner) {
    return { tier: req };
  }
  return { tier: 'crowd', downgradeFrom: req, reason: 'auth', authFailed: true };
}

/** A tiny deterministic PRNG (mulberry32) — same generator the C1 tests use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-room RNG for callsign assignment. Seeded on a hash of the room id plus a
 * time salt so successive joins draw different words while `generateCallsign`'s
 * `taken`-set check still guarantees uniqueness regardless of the draw sequence.
 */
function makeRoomRng(roomId: string): () => number {
  let hash = 2166136261;
  for (let i = 0; i < roomId.length; i++) {
    hash ^= roomId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Salt with a coarse time source so two joins to the same room diverge.
  return mulberry32((hash ^ (Date.now() & 0xffffffff)) >>> 0);
}

/**
 * Task C18: a STABLE deterministic u32 seed for a room's Resonora backing layer.
 * A time-free FNV-1a of the roomId — the SAME seed every process/client derives
 * for the same room (the backing-layer determinism keystone; NOT time-salted like
 * {@link makeRoomRng}, whose salt would break cross-client identity).
 */
function roomSeedFor(roomId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < roomId.length; i++) {
    hash ^= roomId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Task C22 (F10 Ghost Arcade) — the per-room reel bank (spec §7.10 / §7.17).
// ---------------------------------------------------------------------------

/**
 * How many banked reels a room keeps (evict-oldest). Bounds memory — a reel is a
 * few KB; "the day's best" needs only a handful. The bank is DAY-scoped: it
 * survives the room's teardown so an after-hours attract permalink that re-creates
 * the room still finds ghosts to play (§7.10 "ghosts of the day's best players").
 */
export const MAX_BANKED_REELS_PER_ROOM = 8;

/**
 * Global cap on how many DISTINCT rooms retain a day-scoped bank (evict the
 * oldest-inserted room's bank). Bounds the cross-room memory of the day-scoped
 * bank the same way {@link MAX_ROOMS} bounds live rooms.
 */
export const MAX_BANKED_ROOMS = 256;

/** One banked reel + its listing metadata (the day-scoped bank entry, C22). */
interface BankedReel {
  id: string;
  reel: Reel;
  summary: ReelSummary;
}

/** Metadata we attach to each connected socket. */
interface SocketMeta {
  roomId: string;
  playerId: string;
  /** Granted connection tier (spec §5.1). Phase B joins are `resident`. */
  tier: Tier;
  /** Server-assigned callsign — also written into the presence `name`. */
  callsign: string;
  /** Per-room epoch (u32 ms base) issued in the `hello` reply. */
  roomEpoch: number;
  /** Pending idle-kick timer handle (wisp/crowd only), or null. */
  idleTimer: TimerHandle | null;
  /**
   * Task C4: this connection presented a VALID ownerToken at join → it may issue
   * a `DIRECTOR_CMD` on ANY tier (spec §5.4). Grants BUILD on a resident (C34).
   */
  director: boolean;
  /**
   * Task C4: the validated ownerToken (in-memory ONLY, never persisted/logged/
   * broadcast). Held so ROTATE_SECRET/ROTATE_LINK can recompute the HMAC without
   * the client re-sending it on every command. Set iff `director` is true.
   */
  ownerToken?: string;
  /**
   * Task C4: join provenance (spec §5.4). `entryRoute` = the tier route the peer
   * arrived on (staff/funnel/phase-b); `joinedAt` = roomEpoch-relative ms.
   */
  entryRoute: string;
  joinedAt: number;
  /** Task C4: the client IP (keys the failed-join backoff). */
  clientIp: string;
  /**
   * Task C14 (F4): the per-socket WISP_PULSE 2/s token bucket (wisp tier only).
   * A pulse that fails `tryPulse()` is DROPPED before it can touch the world —
   * the server never applies more than 2 pulses/s from one wisp (anti-spam,
   * spec §5.1). Lazily created on the first pulse; absent for non-wisp tiers.
   */
  wispPulseBucket?: WispPulseBucket;
  /**
   * Task C14 (F4): this wisp's assigned orbit-slot index (0…WISP_CAP−1), used as
   * `wispIndex` in the WISP_POSE it broadcasts and as the anti-spoof identity for
   * its pulses. Only set for the wisp tier.
   */
  wispSlot?: number;
  /**
   * Task C34 (F23 The Workshop): the per-socket BUILD light rate limiter (the C4
   * pattern). A resident with the BUILD capability may issue a bounded number of
   * BUILD ops per second — a runaway/hostile builder can never flood the world or
   * the layouts bucket. Lazily created on the first BUILD op; absent otherwise.
   */
  buildBucket?: TokenBucket;
}

// ---------------------------------------------------------------------------
// Task C10 — per-rotation throw stats (feeds the STATS_CARD, callsigns only).
//
// A "throw" is a release with speed above THROW_SPEED_MIN. We track the total
// count, the fastest throw (callsign + speed), and per-callsign counts (for the
// top contributor). Reset on rotation RESET. NO raw names — the callsign is the
// only identity ever recorded (spec §6.1).
// ---------------------------------------------------------------------------

/** A release under this speed (m/s) is a place-down, not a throw. */
export const THROW_SPEED_MIN = 1.5;

/**
 * Task C34 (F23 The Workshop): the per-socket BUILD op rate limiter (the C4
 * pattern). A gizmo drag streams SET_TRANSFORMs at interactive rates; the burst
 * is generous so normal building never stalls, and the sustained refill bounds a
 * runaway/hostile builder. Applied to EVERY BUILD op (mutations + saves + seeds).
 */
export const BUILD_RATE_REFILL_PER_SEC = 30;
export const BUILD_RATE_BURST = 60;

interface RoomThrowStats {
  shapesThrown: number;
  fastest: { callsign: string; speedMs: number } | null;
  /** callsign → throw count (top-contributor source). */
  byCallsign: Map<string, number>;
}

function newThrowStats(): RoomThrowStats {
  return { shapesThrown: 0, fastest: null, byCallsign: new Map() };
}

// ---------------------------------------------------------------------------
// Task C10 — map a host opcode broadcast → the client-facing ServerMsg.
//
// The RoomTimelineHost speaks in opcodes (PHASE_STATE 0x21 / DIRECTOR 0x22 /
// STATS_CARD 0x2E). The connection layer is the composition root that turns those
// into the JSON ServerMsg families the client already understands. Returns null
// for an opcode with no client mapping (silently ignored — the host never sends one).
// ---------------------------------------------------------------------------

function opcodeToServerMsg(opcode: number, payload: unknown): ServerMsg | null {
  switch (opcode) {
    case OPCODES.PHASE_STATE: {
      const p = payload as { phase: string; endsAt: number | null; remainingMs: number | null };
      return { t: 'phase-state', phase: p.phase, endsAt: p.endsAt, remainingMs: p.remainingMs };
    }
    case OPCODES.DIRECTOR: {
      const p = payload as { kind: string; catalog?: unknown; fireResult?: string; cueId?: string };
      return {
        t: 'director-msg',
        kind: p.kind,
        ...(p.catalog !== undefined ? { catalog: p.catalog as never } : {}),
        ...(p.fireResult !== undefined ? { fireResult: p.fireResult } : {}),
        ...(p.cueId !== undefined ? { cueId: p.cueId } : {}),
      };
    }
    case OPCODES.ENV_STATE: {
      const e = payload as {
        serverTimestamp: number;
        mode: string | null;
        params: import('@cyber-shapes/shared').PhysicsParams;
        endsAt: number | null;
      };
      return {
        t: 'env-state',
        serverTimestamp: e.serverTimestamp,
        mode: e.mode,
        params: e.params,
        endsAt: e.endsAt,
      };
    }
    case OPCODES.THEME_SET: {
      // Task C20 (F9 Reality Channels): the ThemeChannelHost broadcasts THEME_SET
      // {themeId, transitionAtServerTime, glitch} (spec §5.2 row 0x24). Map it to
      // the `theme-set` ServerMsg the client's ThemeApplier consumes.
      const th = payload as { themeId: string; transitionAtServerTime: number; glitch: boolean };
      return {
        t: 'theme-set',
        themeId: th.themeId,
        transitionAtServerTime: th.transitionAtServerTime,
        glitch: th.glitch,
      };
    }
    case OPCODES.STATS_CARD: {
      const c = payload as StatsCard;
      return {
        t: 'stats-card',
        shapesThrown: c.shapesThrown,
        fastestThrow: c.fastestThrow,
        topContributor: c.topContributor,
        dayLeaderboard: c.dayLeaderboard,
        nextInHeadset: c.nextInHeadset,
      };
    }
    case OPCODES.VOTE: {
      // Task C15: the ElectionHost broadcasts VOTE_OPEN/TALLY/RESULT as one `vote`
      // ServerMsg discriminated by `kind`. Pass the payload through verbatim (it is
      // already the wire shape — kind + options/tally/winner/deadlines).
      const v = payload as {
        kind: number;
        options?: string[];
        tally?: Record<string, number>;
        voterCount?: number;
        winner?: string | null;
        openedAtMs?: number;
        deadlineMs?: number;
        cooldownMs?: number;
        serverTimestamp?: number;
      };
      return { t: 'vote', ...v };
    }
    case OPCODES.SHOWPIECE: {
      // Task C16: the SiegeHost broadcasts SHOWPIECE_START/STATE/END/MET_LAUNCH as
      // one `showpiece` ServerMsg discriminated by `kind`. Pass the payload through
      // verbatim (it is already the wire shape — kind + crystal/hp/callout/etc.).
      const s = payload as { kind: number } & Record<string, unknown>;
      return { t: 'showpiece', ...s } as ServerMsg;
    }
    case OPCODES.PLAYER_SCALE: {
      // Task C17: the TitanHost broadcasts PLAYER_SCALE {peerId, scale, durationMs}
      // (spec §7.7). Map it to the `player-scale` ServerMsg the client decodes.
      const p = payload as { peerId: string; scale: number; durationMs: number };
      return { t: 'player-scale', peerId: p.peerId, scale: p.scale, durationMs: p.durationMs };
    }
    case OPCODES.BUILD: {
      // Task C34 (F23 The Workshop): the BUILD family server → client message
      // (ACK / LAYOUT_LIST / build-mode state broadcast). Pass the payload through
      // verbatim (it is already the wire shape — kind + opId/id/result/layouts/
      // buildModeActive). Received only by build-mode residents + director.
      const b = payload as { kind: number } & Record<string, unknown>;
      return { t: 'build-msg', ...b } as ServerMsg;
    }
    case OPCODES.TELEKINESIS: {
      // Task C32 (F21 Powers Lab): the server → stage TETHER broadcast (the ONLY TK
      // message the client receives — TK_PULL/RELEASE/HANDS_STATE are client → server
      // binary). The server knows the anchor + target, so NO joint streaming: the
      // stage draws a neon tether beam from each anchor to its pulled shape. Mapped
      // to the `tk-tether` ServerMsg the stage/desktop renderer consumes.
      const t = payload as {
        peerId: string | null;
        pulls: Array<{ hand: number; anchor: { x: number; y: number; z: number }; targetId: string }>;
      };
      return { t: 'tk-tether', peerId: t.peerId, pulls: t.pulls };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-server hub — created once per startServer() call
// ---------------------------------------------------------------------------

/**
 * Opaque per-server state container. One instance per startServer() call.
 * Pass the same hub to every handleConnection() for that server.
 * broadcastToRoom is the only public API; internals are package-private.
 */
export interface ConnectionHub {
  broadcastToRoom(roomId: string, msg: ServerMsg): void;
  /**
   * Task C2: send ONE serialized wisp coalesced summary to every wisp in a room
   * (the shared ~5 Hz buffer, spec §5.1). Called from the sim loop.
   */
  broadcastCoalescedToWisps(roomId: string, msg: ServerMsg): void;
  /** True if the room currently has at least one wisp connection. */
  hasWisps(roomId: string): boolean;
  /**
   * Task C25 (F14 The Gallery): true if the room has ≥ 1 audience (remote viewer)
   * connection. The sim loop uses `hasWisps || hasAudience` to decide whether to
   * build the once-serialized 5 Hz coalesced buffer (audience reuses it).
   */
  hasAudience(roomId: string): boolean;
  /** Task C25: the room's live audience (remote-viewer) count — feeds peakWatchers. */
  audienceCount(roomId: string): number;
  /**
   * Task C25: (re)serialize the room's cached audience late-join keyframe from the
   * current world (spec §7.14 — the "most recent ~10 s keyframe"). Called by the
   * sim loop on a rolling cadence, NOT per join, so a 128-join burst reuses the one
   * cached buffer (zero fresh serializations).
   */
  refreshAudienceKeyframe(roomId: string, shapes: NetShape[], serverTick: number): void;
  /** Task C25: broadcast AUDIENCE_STATE {viewerCount} (0.2 Hz driver in the sim loop). */
  broadcastAudienceState(roomId: string): void;
  /** Task C25 (test hook): how many times the room's keyframe has been serialized. */
  audienceKeyframeSerializeCount(roomId: string): number;
  /**
   * Task C3: per-connection RTT store (quantized lastRttMs from CLOCK_PING,
   * spec §5.1 footnote). C4 roster reads this to populate `rttMs?` on entries.
   */
  readonly rttStore: RttStore;
  /**
   * Task C10: the live Showrunner (RoomTimelineHost) for a room, or undefined if
   * the room has none yet. The sim loop reads `getHost(roomId)?.effectiveParams()`
   * so the single-overlay dial (low-g) actually affects the tick.
   */
  getHost(roomId: string): RoomTimelineHost | undefined;
  /**
   * Task C16: the live F6 Meteor Siege for a room, or undefined. The sim loop calls
   * `getSiege(roomId)?.tick(dt)` AFTER the physics step so meteor rewind rings +
   * speed re-clamps + crystal-hit damage run each tick; it also auto-arms the siege
   * on the OVERLOAD/FINALE phases via `maybeAutoArmSiege(roomId)`.
   */
  getSiege(roomId: string): SiegeHost | undefined;
  /** Task C16: auto-arm the siege when the timeline enters OVERLOAD/FINALE. */
  maybeAutoArmSiege(roomId: string): void;
  /**
   * Task C19: the live F12 Supernova Encore for a room, or undefined. The sim
   * loop calls `getEncore(roomId)?.publishCharge()` each tick to emit the coalesced
   * CHARGE_STATE (rate-limited inside the host), and notifies the host of the orb's
   * first floor impact so the drop fires. A sibling host: the tick never depends on
   * it (cut-safe). Auto-armed on FINALE via `maybeAutoArmEncore(roomId)`.
   */
  getEncore(roomId: string): EncoreHost | undefined;
  /** Task C19: auto-arm the encore when the timeline enters FINALE (no siege). */
  maybeAutoArmEncore(roomId: string): void;
  /**
   * Task C17: the live F7 Titan Protocol host for a room, or undefined. The sim
   * loop calls `getTitan(roomId)?.recallOutOfBounds()` BEFORE the physics step so a
   * titan-thrown shape past WORLD_RADIUS is recalled BEFORE `removed` is honored
   * (baseline throws keep the Phase B despawn); it also applies the giant's hand
   * impulses from resident poses each tick.
   */
  getTitan(roomId: string): TitanHost | undefined;
  /**
   * Task C18: the live F8 Resonora Conductor for a room, or undefined. The sim
   * loop calls `getConductor(roomId)?.onImpacts(room.lastImpacts())` each tick to
   * score floor impacts into MUSIC_NOTE events, and `tickClock()` ~1 Hz to emit
   * MUSIC_CLOCK. A sibling host — the tick never depends on it (cut-safe).
   */
  getConductor(roomId: string): Conductor | undefined;
  /**
   * Task C26: the live F15 MC NULL caster host for a room, or undefined. The sim
   * loop feeds it floor impacts + the live showpiece flag and calls `tick()` each
   * step; the intent/join handlers feed it throws + joins. It emits CASTER_LINE
   * (0x33). A sibling host — the tick never depends on it (cut-safe).
   */
  getCaster(roomId: string): CasterHost | undefined;
  /**
   * Task C28 (F17 Daemon Crew): the live Daemon Crew host for a room, or undefined.
   * The sim loop calls `getDaemonCrew(roomId)?.tick(dt)` AFTER the physics step so
   * daemons fetch-and-return over post-step positions. Daemons join/leave/act via
   * the STANDARD paths (no god-mode) and are synthetic-blind everywhere (no socket).
   */
  getDaemonCrew(roomId: string): DaemonCrewHost | undefined;
  /**
   * Task C32 (F21 Powers Lab): the live telekinesis host for a room, or undefined.
   * The sim loop calls `tickPowersLab(roomId, dt)` BEFORE the physics step so the
   * per-tick pull LOOP FORCE (the C17 titan pattern) nudges the pulled shape's
   * velocity toward the hand anchor, honors the ~250 ms dead-man switch, and
   * converts to a Phase B grab at the palm — BEFORE the step integrates it. A
   * sibling host: a cheap no-op unless the exhibit is armed AND a pull is live.
   */
  getPowersLab(roomId: string): PowersLabHost | undefined;
  /** Task C32: drive the Powers Lab pull loop for a room (no-op when absent/idle). */
  tickPowersLab(roomId: string, dt: number): void;
  /**
   * Task C12: drain the server-wide glyph-inflow overflow QUEUE (spec §7.13 —
   * overflow is queued, not dropped). Called from the sim loop so queued glyphs
   * land as the token bucket refills. onAdmit broadcasts + persists each one.
   */
  drainGlyphs(): void;
  /**
   * Task C22 (F10 Ghost Arcade): the room's live ReelRecorder — the PASSIVE tee
   * sink every broadcast/binary fan-out ALSO feeds (record-time sanitized). One
   * per active room; undefined before the room's host is ensured. Exposed so ops /
   * tests can assert the tee captured the broadcast stream (anonymized).
   */
  getRecorder(roomId: string): ReelRecorder | undefined;
  /** Task C22: the day-scoped banked-reel listing for a room (metadata only). */
  listReels(roomId: string): ReelSummary[];
}

/** Internal hub type with access to the full state (used within this module). */
interface InternalHub extends ConnectionHub {
  readonly socketMeta: WeakMap<WebSocket, SocketMeta>;
  readonly roomSockets: Map<string, Set<WebSocket>>;
  readonly voiceEnabled: Map<string, Set<string>>;
  /** roomId → set of callsigns currently taken in the room (uniqueness roster). */
  readonly takenCallsigns: Map<string, Set<string>>;
  /** roomId → the per-room epoch (u32 ms base), issued once per room lifetime. */
  readonly roomEpochs: Map<string, number>;
  /** Task C4: roomIds whose door is CLOSED — new PUBLIC joins are refused. */
  readonly doorClosed: Set<string>;
  /** Task C4: roomId → set of muted playerIds (their 0x1x frames dropped). */
  readonly muted: Map<string, Set<string>>;
  /** Task C10: roomId → the live Showrunner (timeline host). One per active room. */
  readonly hosts: Map<string, RoomTimelineHost>;
  /** Task C15: roomId → the live F5 Reality Referendum election host. */
  readonly elections: Map<string, ElectionHost>;
  /** Task C16: roomId → the live F6 Meteor Siege host (one per active room). */
  readonly sieges: Map<string, SiegeHost>;
  /** Task C17: roomId → the live F7 Titan Protocol host (one per active room). */
  readonly titans: Map<string, TitanHost>;
  /** Task C18: roomId → the live F8 Resonora Conductor (one per active room). */
  readonly conductors: Map<string, Conductor>;
  /** Task C26: roomId → the live F15 MC NULL caster host (one per active room). */
  readonly casters: Map<string, CasterHost>;
  /** Task C28: roomId → the live F17 Daemon Crew host (one per active room). */
  readonly daemons: Map<string, DaemonCrewHost>;
  /** Task C32: roomId → the live F21 Powers Lab telekinesis host (one per active room). */
  readonly powersLabs: Map<string, PowersLabHost>;
  /** Task C22: roomId → the live F10 Ghost Arcade ReelRecorder (one per active room). */
  readonly recorders: Map<string, ReelRecorder>;
  /** Task C22: roomId → the DAY-scoped banked reels (survives room teardown). */
  readonly reelBanks: Map<string, BankedReel[]>;
  /**
   * Task C32: roomId → whether a resident has reported camera-tracked hands
   * (TK_HANDS_STATE). The powers-lab cue registers ONLY when this is true AND the
   * POWERS_LAB_ENABLED env flag is set (spec §7.21 capability gate).
   */
  readonly powersHandsReported: Map<string, boolean>;
  /**
   * Task C28: roomId → (human resident playerId → latest relayed Pose). Fed from the
   * resident pose intent path so a daemon can aim its return lob at the nearest human
   * head (chest offset). ONLY human residents are recorded — daemon poses bypass the
   * socket handler, so this map is inherently synthetic-blind (it never holds a daemon).
   */
  readonly lastResidentPose: Map<string, Map<string, Pose>>;
  /** Task C19: roomId → the live F12 Supernova Encore host (one per active room). */
  readonly encores: Map<string, EncoreHost>;
  /** Task C20: roomId → the live F9 Reality Channels theme host (one per active room). */
  readonly themeChannels: Map<string, ThemeChannelHost>;
  /** Task C10: roomId → per-rotation throw stats (reset on rotation RESET). */
  readonly throwStats: Map<string, RoomThrowStats>;
  /**
   * Task C12: the server-wide Neon Guestbook manager (one per server; per-room
   * state inside). Holds the guestbook glyphs, the server-wide inflow token bucket
   * (overflow queued), per-guest lifetime caps, evict-oldest, panic, and despawn.
   */
  readonly glyphs: GlyphManager;
  /** Task C12: roomIds whose guestbook has been loaded/seeded (once per room boot). */
  readonly glyphRoomsReady: Set<string>;
  /** Task C34: roomIds whose saved layouts baseline has been loaded into the host. */
  readonly layoutsReady: Set<string>;
  /**
   * Task C34: roomId → the in-memory layouts manifest (the authoritative live copy,
   * mirrored to the `layouts` bucket when one is configured). A room WITHOUT a data
   * dir (tests / LAN-less) keeps its compositions here for the session so SAVE →
   * LIST → LOAD round-trips even with no disk.
   */
  readonly layoutManifests: Map<string, LayoutManifest>;
  getRoomSockets(roomId: string): Set<WebSocket>;
  getVoiceSet(roomId: string): Set<string>;
  /** Task C14: record/clear a wisp's latest head-only pose for the coalesced buffer. */
  setWispPose(
    roomId: string,
    playerId: string,
    pose: { wispIndex: number; pos: [number, number, number]; yaw: number }
  ): void;
  clearWispPose(roomId: string, playerId: string): void;
  sendText(ws: WebSocket, msg: ServerMsg): void;
  /** Task C25: backpressure-guarded raw send to one audience socket. */
  sendAudienceRaw(ws: WebSocket, payload: string | Buffer): void;
  broadcast(roomId: string, msg: ServerMsg, exclude?: WebSocket): void;
  /** Task C10: deliver a Showrunner opcode broadcast to the named tiers. */
  broadcastOpcodeToTiers(
    roomId: string,
    opcode: number,
    payload: unknown,
    tiers?: readonly string[]
  ): void;
  /** Task C18: broadcast a raw binary Appendix B frame (e.g. MUSIC), tier-filtered. */
  broadcastBinaryToTiers(roomId: string, frame: ArrayBuffer, tiers?: readonly string[]): void;
  broadcastEvents(roomId: string, events: ServerMsg[], sender: WebSocket): void;
  broadcastVoiceRoster(roomId: string): void;
  /** Count live sockets of a given tier in a room (cap enforcement). */
  tierCount(roomId: string, tier: Tier): number;
  /** Task C25: the room's cached audience keyframe (get-or-create). */
  audienceKeyframe(roomId: string): AudienceKeyframeCache;
  /** Task C25: concurrent audience sockets from `ip` in `roomId` (per-IP cap). */
  audienceIpCount(roomId: string, ip: string): number;
  /** Task C25: the per-(room, IP) join/keyframe token bucket. */
  audienceJoinBucket(roomId: string, ip: string): TokenBucket;
  /** Task C25: increment the per-IP audience count (successful join). */
  incAudienceIp(roomId: string, ip: string): void;
  /** Task C25: decrement the per-IP audience count (disconnect). */
  decAudienceIp(roomId: string, ip: string): void;
  /** Task C25: drop all audience state for a room (last-socket teardown). */
  dropRoomAudience(roomId: string): void;
  /** Reserve a unique callsign for a room; returns the assigned callsign. */
  reserveCallsign(roomId: string, requestedName: number | undefined, rng: () => number): string;
  /** Release a callsign back to the room pool (on disconnect). */
  releaseCallsign(roomId: string, callsign: string): void;
  /** Get (issuing once) the per-room epoch. */
  getRoomEpoch(roomId: string): number;
  /** Task C3: per-connection RTT store (already on ConnectionHub, narrowed here). */
  readonly rttStore: RttStore;
  /** Task C22: bank a materialized reel into the day-scoped bank (null if empty). */
  bankReel(roomId: string, reel: Reel): ReelSummary | null;
  /** Task C22: fetch a banked reel by id, or the most-recent when id is absent. */
  getBankedReel(roomId: string, reelId?: string): BankedReel | null;
}

/**
 * Create a fresh, isolated hub. Must be called once per startServer() and
 * passed to every handleConnection() for that server.
 */
export function makeConnectionHub(): ConnectionHub {
  // WeakMap so metadata is GC-friendly when sockets are closed.
  const socketMeta = new WeakMap<WebSocket, SocketMeta>();
  /** Lookup: roomId → Set of sockets in that room. */
  const roomSockets = new Map<string, Set<WebSocket>>();
  /** Lookup: roomId → Set of playerId strings that have joined voice. */
  const voiceEnabled = new Map<string, Set<string>>();
  /** Lookup: roomId → Set of callsigns taken (uniqueness roster, Task C2). */
  const takenCallsigns = new Map<string, Set<string>>();
  /** Lookup: roomId → per-room epoch (issued once, Task C2). */
  const roomEpochs = new Map<string, number>();
  /** Task C3: per-connection quantized RTT store (keyed by playerId). */
  const rttStore = createRttStore();
  /** Task C4: rooms whose door is CLOSED (new public joins refused). */
  const doorClosed = new Set<string>();
  /** Task C4: roomId → muted playerIds (their voice frames dropped at fan-out). */
  const muted = new Map<string, Set<string>>();
  /** Task C10: roomId → the live Showrunner (timeline host). */
  const hosts = new Map<string, RoomTimelineHost>();
  /** Task C15: roomId → the live F5 Reality Referendum election host. */
  const elections = new Map<string, ElectionHost>();
  /** Task C16: roomId → the live F6 Meteor Siege host. */
  const sieges = new Map<string, SiegeHost>();
  /** Task C17: roomId → the live F7 Titan Protocol host (one per active room). */
  const titans = new Map<string, TitanHost>();
  /** Task C18: roomId → the live F8 Resonora Conductor (one per active room). */
  const conductors = new Map<string, Conductor>();
  /** Task C19: roomId → the live F12 Supernova Encore host (one per active room). */
  const encores = new Map<string, EncoreHost>();
  /** Task C20: roomId → the live F9 Reality Channels theme host (one per active room). */
  const themeChannels = new Map<string, ThemeChannelHost>();
  /** Task C26: roomId → the live F15 MC NULL caster host (one per active room). */
  const casters = new Map<string, CasterHost>();
  /** Task C28: roomId → the live F17 Daemon Crew host (one per active room). */
  const daemons = new Map<string, DaemonCrewHost>();
  /** Task C32: roomId → the live F21 Powers Lab telekinesis host (one per active room). */
  const powersLabs = new Map<string, PowersLabHost>();
  /** Task C22: roomId → the live F10 Ghost Arcade ReelRecorder (one per active room). */
  const recorders = new Map<string, ReelRecorder>();
  /** Task C22: roomId → the DAY-scoped banked reels (survives room teardown). */
  const reelBanks = new Map<string, BankedReel[]>();
  /** Task C22: monotonic banked-reel id counter (opaque, per-server). */
  let reelIdSeq = 0;
  /** Task C32: roomId → whether a resident has reported camera-tracked hands. */
  const powersHandsReported = new Map<string, boolean>();
  /** Task C28: roomId → (human resident playerId → latest relayed Pose) — daemon aim. */
  const lastResidentPose = new Map<string, Map<string, Pose>>();
  /** Task C10: roomId → per-rotation throw stats (STATS_CARD source). */
  const throwStats = new Map<string, RoomThrowStats>();
  /** Task C12: roomIds whose guestbook has been loaded/seeded (once per room boot). */
  const glyphRoomsReady = new Set<string>();
  /** Task C34: roomIds whose saved layouts baseline has been loaded into the host. */
  const layoutsReady = new Set<string>();
  /** Task C34: roomId → the in-memory layouts manifest (mirrored to the bucket). */
  const layoutManifests = new Map<string, LayoutManifest>();
  /**
   * Task C14 (F4): roomId → (playerId → latest WISP_POSE). Last-write-wins per
   * wisp; the sim loop reads (and clears staleness by presence) this into the
   * shared ~5 Hz coalesced buffer once per 5 Hz tick. Cleared per-wisp on
   * disconnect so a departed wisp's pose is never re-broadcast.
   */
  const wispPoses = new Map<
    string,
    Map<string, { wispIndex: number; pos: [number, number, number]; yaw: number }>
  >();

  // Task C25 (F14 The Gallery) — audience-tier per-server state.
  /** roomId → the cached late-join keyframe (serialize-once, reused per joiner). */
  const audienceKeyframes = new Map<string, AudienceKeyframeCache>();
  /** roomId → (clientIp → concurrent audience socket count) — the per-IP cap. */
  const audienceIpCounts = new Map<string, Map<string, number>>();
  /** `${roomId}|${ip}` → the per-IP join/keyframe token bucket (egress throttle). */
  const audienceJoinBuckets = new Map<string, TokenBucket>();

  /** Task C12: map a stored GlyphEntry → the on-wire GlyphNet (callsign only). */
  function toGlyphNet(g: GlyphEntry): GlyphNet {
    return {
      id: g.id,
      callsign: g.callsign,
      points: g.points.map((p) => ({ x: p.x, y: p.y })),
      color: g.color,
      slotIndex: g.slotIndex,
      ...(g.seeded ? { seeded: true } : {}),
    };
  }

  /** Task C12: schedule a guestbook-bucket save for a room (best-effort; no-op if buckets absent). */
  function persistGuestbook(roomId: string): void {
    try {
      getBucket('guestbook').scheduleSave(roomId, [...glyphs.glyphs(roomId)]);
    } catch {
      // Buckets not initialised (tests without DATA_DIR) — the guestbook is
      // in-memory only; still fully functional for the session.
    }
  }

  /**
   * Task C12: the server-wide Neon Guestbook manager. onAdmit broadcasts the
   * birthed glyph to the whole room (all tiers see the constellation grow) + a
   * guestbook-bucket save; onEvict (evict-oldest at 512) broadcasts a REMOVE so no
   * client keeps a ghost. Callsigns only on the wire (§6.1).
   */
  const glyphs = new GlyphManager({
    onAdmit: (roomId, glyph) => {
      broadcast(roomId, { t: 'glyph', glyph: toGlyphNet(glyph) });
      persistGuestbook(roomId);
    },
    onEvict: (roomId, glyph) => {
      broadcast(roomId, { t: 'glyph-remove', id: glyph.id });
      persistGuestbook(roomId);
    },
  });

  function getRoomSockets(roomId: string): Set<WebSocket> {
    let set = roomSockets.get(roomId);
    if (!set) {
      set = new Set();
      roomSockets.set(roomId, set);
    }
    return set;
  }

  function getVoiceSet(roomId: string): Set<string> {
    let set = voiceEnabled.get(roomId);
    if (!set) {
      set = new Set();
      voiceEnabled.set(roomId, set);
    }
    return set;
  }

  function getCallsignSet(roomId: string): Set<string> {
    let set = takenCallsigns.get(roomId);
    if (!set) {
      set = new Set();
      takenCallsigns.set(roomId, set);
    }
    return set;
  }

  function sendText(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(encodeText(msg));
    }
  }

  /**
   * Task C25 (F14 The Gallery) — backpressure-guarded raw send to ONE audience
   * socket (spec §7.14, mandatory). A slow/stalled viewer must never stall the
   * tick or exhaust memory:
   *   • past ~64–128 KB already buffered → SKIP this send (the frame is dropped;
   *     the other viewers are unaffected — the coalesced buffer is idempotent, the
   *     next tick catches a recovered socket up);
   *   • past the hard ceiling → DISCONNECT ("paused — click to rejoin"), so a
   *     wedged socket can never accumulate unbounded server memory.
   * `payload` is the SAME once-serialized buffer/string passed to every viewer —
   * this never re-serializes.
   */
  function sendAudienceRaw(ws: WebSocket, payload: string | Buffer): void {
    if (ws.readyState !== 1 /* OPEN */) return;
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    switch (audienceBackpressureAction(buffered)) {
      case 'disconnect':
        try {
          ws.close(1013, 'audience-backpressure');
        } catch {
          /* already closing */
        }
        return;
      case 'skip':
        return; // drop this frame — never block the tick; the next tick catches up
      case 'send':
        ws.send(payload);
    }
  }

  // -------------------------------------------------------------------------
  // Per-tier fan-out (Task C2, spec §5.1). A message is delivered to a socket
  // only if that socket's tier's ReceiveClass admits the message's family:
  //  - `full`      (resident/spectator): everything (deltas, poses, snapshots).
  //  - `coalesced5`(wisp): NEVER a raw `state`/`pose`/`welcome` — wisps get the
  //                 shared coalesced buffer (a `wisp-coalesced` family) instead.
  //  - `summary`   (crowd): NEVER a `state`/`pose`/`welcome` — only cue/summary
  //                 families (votes, charge, showpiece, glyph, phase, etc.).
  //  - `stateOnly` (director): state + roster + phase + catalog (no poses).
  // Lifecycle/handshake messages (hello/downgrade/error/player-*) reach every
  // tier so every peer's roster stays coherent.
  // -------------------------------------------------------------------------

  /** True if a socket of the given tier may RECEIVE this message family. */
  function tierAdmits(tier: Tier, msg: ServerMsg): boolean {
    const cls = TIER_POLICY[tier].receive;
    switch (cls) {
      case 'full':
        return true;
      case 'stateOnly':
        // director: everything a resident gets EXCEPT peer poses (not needed).
        return msg.t !== 'pose';
      case 'coalesced5':
      case 'summary': {
        // wisp/crowd: never full deltas, poses, or the late-join snapshot.
        if (msg.t === 'state' || msg.t === 'pose' || msg.t === 'welcome') return false;
        return true;
      }
      case 'audience': {
        // Task C25 (F14 The Gallery) — the §5.1 audience-row UNION is the ONE
        // normative enumeration (tiers.ts AUDIENCE_RECV_FAMILIES). This is the
        // additive composition seam: audience inclusion is driven by the union,
        // so no existing per-tier broadcast call site is edited.
        //
        // THE EGRESS/SECURITY INVARIANT (asserted in tests): audience NEVER
        // receives a full-rate delta, a full-rate pose, the full welcome
        // snapshot, or ANY voice frame.
        if (msg.t === 'state' || msg.t === 'pose' || msg.t === 'welcome') return false;
        if (msg.t.startsWith('voice')) return false;
        // The staff PANIC control signal reaches audience (§6.1 panic coverage
        // extends to the 128 anonymous home screens) — but ONLY the PANIC kind;
        // the CUE catalog / acks never reach a remote viewer.
        if (msg.t === 'director-msg') return (msg as { kind?: string }).kind === 'PANIC';
        // C30 REVIEW MF1 — the `grab` family is BIVALENT (tiers.ts). A family Set
        // cannot express this, so admit `grab` to AUDIENCE for the RELEASE SEED
        // ONLY (peerId === null → {pos, vel}, the F19 resim seed). grab-START
        // (peerId set) is EXCLUDED: it discloses a participant's stable internal
        // playerId + who-holds-what, identity/held-state the §5.1 audience boundary
        // withholds. Wisp/other tiers (above) keep the full `grab` family.
        if (msg.t === 'grab') return (msg as { peerId?: string | null }).peerId === null;
        const families = TIER_POLICY[tier].receiveFamilies;
        return families ? families.has(msg.t) : false;
      }
    }
  }

  function broadcast(roomId: string, msg: ServerMsg, exclude?: WebSocket): void {
    // Task C22 (F10 Ghost Arcade): PASSIVE tee — the room's ReelRecorder is an
    // ADDITIONAL sink of the outbound stream (record-time sanitized). This does
    // NOT touch the fan-out below (no tier is added/removed, no gate changes) — a
    // tee is a new consumer, never a new route. `?.` no-ops before the host exists.
    recorders.get(roomId)?.tee(msg);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    for (const ws of sockets) {
      if (ws === exclude) continue;
      const m = socketMeta.get(ws);
      // Pre-join sockets (no meta yet) still receive their own handshake replies
      // via sendText directly; broadcast only targets registered sockets.
      if (m && !tierAdmits(m.tier, msg)) continue;
      // Task C25 review (backpressure uniformity): an audience frame on the
      // per-message path (glyph births, glyph-hide/remove, despawn, audience-state,
      // …) honors the SAME ~64–128 KB bufferedAmount skip / hard-ceiling disconnect
      // as the coalesced + keyframe paths — a slow/stalled viewer never stalls the
      // tick nor grows an unbounded buffer, and it never wedges the others.
      if (m?.tier === 'audience') {
        sendAudienceRaw(ws, encodeText(msg));
        continue;
      }
      sendText(ws, msg);
    }
  }

  function broadcastEvents(roomId: string, events: ServerMsg[], sender: WebSocket): void {
    for (const evt of events) {
      if (evt.t === 'pose') {
        broadcast(roomId, evt, sender); // exclude sender
      } else {
        broadcast(roomId, evt); // include sender (e.g. spawn confirmation, grab)
      }
    }
  }

  /**
   * Task C10 — deliver a Showrunner opcode broadcast (PHASE_STATE / DIRECTOR /
   * STATS_CARD) to the sockets whose tier is in `tiers`. This is the seam the
   * RoomTimelineHost's injected `broadcast(opcode, payload, tiers)` maps to. A
   * socket receives it iff (a) its tier is named AND (b) the tier's fan-out policy
   * admits the mapped ServerMsg (director/resident/spectator all admit these).
   * When `tiers` is absent the opcode's default audience (the mapped ServerMsg's
   * ordinary tierAdmits) applies.
   */
  function broadcastOpcodeToTiers(
    roomId: string,
    opcode: number,
    payload: unknown,
    tiers?: readonly string[]
  ): void {
    const msg = opcodeToServerMsg(opcode, payload);
    if (!msg) return;
    // Task C22: PASSIVE tee (the mapped ServerMsg) — additional sink, not a route.
    recorders.get(roomId)?.tee(msg);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    for (const ws of sockets) {
      const m = socketMeta.get(ws);
      if (!m) continue;
      // Task C25 (F14 The Gallery) — the ADDITIVE composition seam. The `audience`
      // tier is admitted purely by the §5.1 receive-set UNION (tierAdmits), and is
      // deliberately EXEMPT from the legacy per-opcode `tiers` list gate below.
      // That is why no existing broadcast call site (STATE_BROADCAST_TIERS,
      // VOTE_TIERS, SHOWPIECE_TIERS, the inline STATS_CARD list, …) needed editing
      // to reach audience — the receive-set union drives fan-out. Tier ≤5 keeps
      // the exact behavior it had (both gates).
      if (m.tier === 'audience') {
        // Backpressure-guarded (C25 review uniformity) — same skip/disconnect band
        // as the coalesced/keyframe paths.
        if (tierAdmits('audience', msg)) sendAudienceRaw(ws, encodeText(msg));
        continue;
      }
      // Tier gate: when a tier set is given, the socket's tier must be listed.
      if (tiers && !tiers.includes(m.tier)) continue;
      // Fan-out policy gate (director stateOnly / resident+spectator full admit these).
      if (!tierAdmits(m.tier, msg)) continue;
      sendText(ws, msg);
    }
  }

  /**
   * Task C18: broadcast an already-encoded BINARY Appendix B frame (e.g. a MUSIC
   * frame from the Conductor) to a room, tier-filtered. Unlike
   * {@link broadcastOpcodeToTiers} (which maps an opcode to a JSON ServerMsg),
   * this sends the raw ArrayBuffer verbatim — the hot MUSIC family is binary per
   * Appendix B. The buffer is serialized ONCE and the SAME payload is sent to
   * every admitted socket.
   */
  function broadcastBinaryToTiers(
    roomId: string,
    frame: ArrayBuffer,
    tiers?: readonly string[]
  ): void {
    // Task C22: PASSIVE tee of the binary frame — the recorder EXCLUDES 0x1x voice
    // structurally (a reel can never carry a private conversation) and ignores the
    // rest; additional sink, never a route change to the fan-out below.
    recorders.get(roomId)?.teeBinary(frame);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    const payload = Buffer.from(frame);
    const opcode = frame.byteLength > 0 ? new Uint8Array(frame)[0] : -1;
    for (const ws of sockets) {
      const m = socketMeta.get(ws);
      if (!m) continue;
      // Task C25 — audience is union-driven on the binary path too: it receives a
      // frame IFF its opcode is in the §5.1 audience binary allowlist (MUSIC 0x29
      // garnish, CROWD_CUE 0x2A charge), regardless of the caller's `tiers` list.
      // Voice opcodes (0x10–0x1F) are never in that set — audience NEVER gets a
      // voice frame (the same invariant enforced on the JSON path).
      if (m.tier === 'audience') {
        // Backpressure-guarded binary send (C25 review uniformity): a stalled
        // viewer's MUSIC/CROWD_CUE frame is skipped/disconnected exactly like every
        // other audience path, never blindly buffered.
        if (AUDIENCE_RECV_BINARY_OPCODES.has(opcode)) sendAudienceRaw(ws, payload);
        continue;
      }
      if (tiers && !tiers.includes(m.tier)) continue;
      if (ws.readyState === 1 /* OPEN */) ws.send(payload);
    }
  }

  function broadcastVoiceRoster(roomId: string): void {
    const vset = getVoiceSet(roomId);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;

    // Task C2: the VOICE_ROSTER lists SENDERS only. Only tiers whose policy
    // `voiceSend` is true (residents) can appear — a spectator/wisp/crowd
    // connection is never a roster entry even if it somehow toggled voice.
    const players = [...sockets]
      .map((s) => {
        const m = socketMeta.get(s);
        if (!m) return null;
        if (!TIER_POLICY[m.tier].voiceSend) return null;
        return { id: m.playerId, voice: vset.has(m.playerId) };
      })
      .filter(Boolean) as Array<{ id: string; voice: boolean }>;

    broadcast(roomId, { t: 'voice-roster', players });
  }

  /**
   * Task C2 (spec §5.1): serialize the wisp coalesced buffer ONCE and send the
   * SAME string to every wisp in the room. Wisps receive one shared ~5 Hz
   * head-only summary — never per-wisp re-serialization, never a raw `state`.
   * The single `payload` is built here and passed verbatim to each `ws.send`,
   * so a spy on `send` sees the identical buffer object for all wisps.
   */
  function broadcastCoalescedToWisps(roomId: string, msg: ServerMsg): void {
    // Task C22: PASSIVE tee of the coalesced wisp summary — additional sink, not a
    // route change to the wisp/audience fan-out below.
    recorders.get(roomId)?.tee(msg);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    // Task C14: FOLD the room's wisp head-only poses into this SAME shared buffer
    // (serialized ONCE below) so wisps see each other at ~5 Hz — never a per-peer
    // relay (spec §5.1). Attach only when there are poses to send.
    const outbound: ServerMsg =
      msg.t === 'wisp-coalesced'
        ? (() => {
            const poses = collectWispPoses(roomId);
            return poses.length > 0 ? { ...msg, wisps: poses } : msg;
          })()
        : msg;
    const payload = encodeText(outbound); // serialize ONCE
    // Task C25 (F14 The Gallery): the `audience` tier reuses THIS same once-
    // serialized buffer (spec §7.14 "reuses C2's serialize-once wisp buffer —
    // zero marginal serialization"). Wisps get it raw; audience sockets get it
    // through the backpressure guard. One serialization, one buffer, every viewer.
    for (const ws of sockets) {
      const m = socketMeta.get(ws);
      if (!m) continue;
      if (m.tier === 'wisp') {
        if (ws.readyState === 1 /* OPEN */) ws.send(payload);
      } else if (m.tier === 'audience') {
        sendAudienceRaw(ws, payload);
      }
    }
  }

  /** Task C14: record a wisp's latest head-only pose (last-write-wins per wisp). */
  function setWispPose(
    roomId: string,
    playerId: string,
    pose: { wispIndex: number; pos: [number, number, number]; yaw: number }
  ): void {
    let room = wispPoses.get(roomId);
    if (!room) {
      room = new Map();
      wispPoses.set(roomId, room);
    }
    room.set(playerId, pose);
  }

  /** Task C14: the room's current wisp head-only poses (snapshot array for the buffer). */
  function collectWispPoses(
    roomId: string
  ): Array<{ wispIndex: number; pos: [number, number, number]; yaw: number }> {
    const room = wispPoses.get(roomId);
    if (!room) return [];
    return [...room.values()];
  }

  /** Task C14: drop a departed wisp's pose so it is never re-broadcast (disconnect). */
  function clearWispPose(roomId: string, playerId: string): void {
    const room = wispPoses.get(roomId);
    if (!room) return;
    room.delete(playerId);
    if (room.size === 0) wispPoses.delete(roomId);
  }

  function tierCount(roomId: string, tier: Tier): number {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return 0;
    let n = 0;
    for (const ws of sockets) {
      const m = socketMeta.get(ws);
      if (m && m.tier === tier) n++;
    }
    return n;
  }

  // ---- Task C25 (F14 The Gallery) — audience-tier helpers -------------------

  /** The room's audience keyframe cache (get-or-create). */
  function audienceKeyframe(roomId: string): AudienceKeyframeCache {
    let c = audienceKeyframes.get(roomId);
    if (!c) {
      c = new AudienceKeyframeCache();
      audienceKeyframes.set(roomId, c);
    }
    return c;
  }

  /** Concurrent audience sockets from `ip` in `roomId` (the per-IP cap check). */
  function audienceIpCount(roomId: string, ip: string): number {
    return audienceIpCounts.get(roomId)?.get(ip) ?? 0;
  }

  /** The per-(room, IP) join/keyframe token bucket (get-or-create). */
  function audienceJoinBucket(roomId: string, ip: string): TokenBucket {
    const key = `${roomId}|${ip}`;
    let b = audienceJoinBuckets.get(key);
    if (!b) {
      b = new TokenBucket(AUDIENCE_JOIN_REFILL_PER_SEC, AUDIENCE_JOIN_BURST);
      audienceJoinBuckets.set(key, b);
    }
    return b;
  }

  /** Increment the per-IP audience count (on a successful audience join). */
  function incAudienceIp(roomId: string, ip: string): void {
    let m = audienceIpCounts.get(roomId);
    if (!m) {
      m = new Map();
      audienceIpCounts.set(roomId, m);
    }
    m.set(ip, (m.get(ip) ?? 0) + 1);
  }

  /** Decrement the per-IP audience count (on an audience disconnect). */
  function decAudienceIp(roomId: string, ip: string): void {
    const m = audienceIpCounts.get(roomId);
    if (!m) return;
    const n = (m.get(ip) ?? 0) - 1;
    if (n <= 0) m.delete(ip);
    else m.set(ip, n);
    if (m.size === 0) audienceIpCounts.delete(roomId);
  }

  /** Drop ALL audience state for a room (called on last-socket teardown). */
  function dropRoomAudience(roomId: string): void {
    audienceKeyframes.delete(roomId);
    audienceIpCounts.delete(roomId);
    const prefix = `${roomId}|`;
    for (const key of audienceJoinBuckets.keys()) {
      if (key.startsWith(prefix)) audienceJoinBuckets.delete(key);
    }
  }

  /**
   * Broadcast AUDIENCE_STATE {viewerCount} (spec §5.2 row 0x32, driven at 0.2 Hz
   * by the sim loop). Every tier that admits it receives the count — audience
   * shows its own counter, the spectator/stage renders "N WATCHING" (N ≥ 5 only).
   */
  function broadcastAudienceState(roomId: string): void {
    broadcast(roomId, { t: 'audience-state', viewerCount: tierCount(roomId, 'audience') });
  }

  // ---- Task C22 (F10 Ghost Arcade) — the day-scoped reel bank ---------------

  /**
   * Bank a materialized reel for a room (day-scoped). Assigns an opaque id,
   * evicts the oldest reel past {@link MAX_BANKED_REELS_PER_ROOM}, and evicts the
   * oldest ROOM's bank past {@link MAX_BANKED_ROOMS} — both bound memory. Returns
   * the reel's listing summary. A reel with zero frames is NOT banked (nothing to
   * play) — returns null.
   */
  function bankReel(roomId: string, reel: Reel): ReelSummary | null {
    if (reel.frames.length === 0) return null;
    const id = `reel-${roomId}-${reelIdSeq++}`;
    // Stamp `bankedAt` from the reel's last frame wallTime (the recorder's injected
    // clock) — always monotonic + deterministic under a fake clock in tests.
    const bankedAt = reel.frames[reel.frames.length - 1].wallTime;
    const summary: ReelSummary = {
      id,
      durationMs: reel.durationMs,
      frameCount: reel.frames.length,
      bankedAt,
    };
    let bank = reelBanks.get(roomId);
    if (!bank) {
      bank = [];
      reelBanks.set(roomId, bank);
      // Evict the oldest-inserted room's bank if we now track too many rooms.
      if (reelBanks.size > MAX_BANKED_ROOMS) {
        const oldest = reelBanks.keys().next().value;
        if (oldest !== undefined && oldest !== roomId) reelBanks.delete(oldest);
      }
    }
    bank.push({ id, reel, summary });
    // Evict-oldest past the per-room cap.
    while (bank.length > MAX_BANKED_REELS_PER_ROOM) bank.shift();
    return summary;
  }

  /** The room's banked-reel listing (metadata only, newest last). */
  function listReels(roomId: string): ReelSummary[] {
    return (reelBanks.get(roomId) ?? []).map((b) => b.summary);
  }

  /**
   * Fetch a banked reel by id, or (when `reelId` is absent) the MOST-RECENT banked
   * reel — the default the ATTRACT ghost playback plays. Returns null if the bank
   * is empty or the id is unknown.
   */
  function getBankedReel(roomId: string, reelId?: string): BankedReel | null {
    const bank = reelBanks.get(roomId);
    if (!bank || bank.length === 0) return null;
    if (reelId === undefined) return bank[bank.length - 1];
    return bank.find((b) => b.id === reelId) ?? null;
  }

  function reserveCallsign(
    roomId: string,
    requestedName: number | undefined,
    rng: () => number
  ): string {
    const taken = getCallsignSet(roomId);
    // A valid requestedName is an INDEX into CURATED_WORDLIST (never free text).
    // When present + in range, prefer that word with a unique numeric suffix;
    // otherwise fall back to a fully random callsign.
    if (
      requestedName !== undefined &&
      Number.isInteger(requestedName) &&
      requestedName >= 0 &&
      requestedName < CURATED_WORDLIST.length
    ) {
      const word = CURATED_WORDLIST[requestedName];
      for (let num = 0; num < 1000; num++) {
        const width = num < 100 ? 2 : 3;
        const cs = `${word}-${num.toString().padStart(width, '0')}`;
        if (!taken.has(cs)) {
          taken.add(cs);
          return cs;
        }
      }
      // Word saturated (unlikely) — fall through to random.
    }
    const cs = generateCallsign(rng, taken);
    taken.add(cs);
    return cs;
  }

  function releaseCallsign(roomId: string, callsign: string): void {
    const set = takenCallsigns.get(roomId);
    if (!set) return;
    set.delete(callsign);
    if (set.size === 0) takenCallsigns.delete(roomId);
  }

  function getRoomEpoch(roomId: string): number {
    let e = roomEpochs.get(roomId);
    if (e === undefined) {
      e = Date.now();
      roomEpochs.set(roomId, e);
    }
    return e;
  }

  const hub: InternalHub = {
    socketMeta,
    roomSockets,
    voiceEnabled,
    takenCallsigns,
    roomEpochs,
    doorClosed,
    muted,
    hosts,
    elections,
    sieges,
    titans,
    conductors,
    casters,
    daemons,
    powersLabs,
    recorders,
    reelBanks,
    powersHandsReported,
    lastResidentPose,
    encores,
    themeChannels,
    throwStats,
    glyphs,
    glyphRoomsReady,
    layoutsReady,
    layoutManifests,
    rttStore,
    getRoomSockets,
    getVoiceSet,
    sendText,
    sendAudienceRaw,
    broadcast,
    broadcastEvents,
    broadcastOpcodeToTiers,
    broadcastBinaryToTiers,
    broadcastVoiceRoster,
    tierCount,
    audienceKeyframe,
    audienceIpCount,
    audienceJoinBucket,
    incAudienceIp,
    decAudienceIp,
    dropRoomAudience,
    reserveCallsign,
    releaseCallsign,
    getRoomEpoch,
    broadcastToRoom(roomId: string, msg: ServerMsg): void {
      broadcast(roomId, msg);
    },
    broadcastCoalescedToWisps,
    setWispPose,
    clearWispPose,
    hasWisps(roomId: string): boolean {
      return tierCount(roomId, 'wisp') > 0;
    },
    hasAudience(roomId: string): boolean {
      return tierCount(roomId, 'audience') > 0;
    },
    audienceCount(roomId: string): number {
      return tierCount(roomId, 'audience');
    },
    refreshAudienceKeyframe(roomId: string, shapes: NetShape[], serverTick: number): void {
      // Only pay for a keyframe serialization when the room actually has viewers.
      if (tierCount(roomId, 'audience') === 0) return;
      const cache = audienceKeyframe(roomId);
      cache.refresh(shapes, serverTick);
      // C22 (carry #9, the C25 M2 residual): fan the freshly-serialized keyframe out
      // to EVERY current audience viewer as a ~10 s re-sync — not just to late joiners.
      // The `state` delta carries MOVING shapes only, so an AT-REST shape born after a
      // viewer's join keyframe would otherwise never reach that viewer (a permanent
      // ghost-ABSENCE, the inverse of the M2 despawn ghost). This periodic full-world
      // keyframe guarantees every viewer CONVERGES to ground truth within one cadence
      // (spec §7.14 "the recorder's most recent ~10 s keyframe" — now a heartbeat, not
      // a join-only artifact). Serialize-ONCE is preserved: `refresh` serialized once
      // above; this reuses the cached buffer (a 128-viewer room pays raw bytes only,
      // ≈ 0.1 Hz × keyframe size ≪ the §6.5 audience budget). Backpressure-guarded.
      const buf = cache.cached;
      if (buf === null) return;
      const sockets = roomSockets.get(roomId);
      if (!sockets) return;
      for (const ws of sockets) {
        if (socketMeta.get(ws)?.tier === 'audience') sendAudienceRaw(ws, buf);
      }
    },
    broadcastAudienceState,
    audienceKeyframeSerializeCount(roomId: string): number {
      return audienceKeyframes.get(roomId)?.serializeCount ?? 0;
    },
    getHost(roomId: string): RoomTimelineHost | undefined {
      return hosts.get(roomId);
    },
    getSiege(roomId: string): SiegeHost | undefined {
      return sieges.get(roomId);
    },
    getTitan(roomId: string): TitanHost | undefined {
      return titans.get(roomId);
    },
    getConductor(roomId: string): Conductor | undefined {
      return conductors.get(roomId);
    },
    getCaster(roomId: string): CasterHost | undefined {
      return casters.get(roomId);
    },
    getEncore(roomId: string): EncoreHost | undefined {
      return encores.get(roomId);
    },
    getDaemonCrew(roomId: string): DaemonCrewHost | undefined {
      return daemons.get(roomId);
    },
    getPowersLab(roomId: string): PowersLabHost | undefined {
      return powersLabs.get(roomId);
    },
    getRecorder(roomId: string): ReelRecorder | undefined {
      return recorders.get(roomId);
    },
    listReels,
    bankReel,
    getBankedReel,
    tickPowersLab(roomId: string, dt: number): void {
      // `tick(dt)` reads the host's own injected timer for `now` — the SAME clock
      // the TK_PULL handler stamps, so the dead-man switch stays consistent.
      powersLabs.get(roomId)?.tick(dt);
    },
    maybeAutoArmSiege(roomId: string): void {
      const siege = sieges.get(roomId);
      const host = hosts.get(roomId);
      if (!siege || !host || siege.active) return;
      const phase = host.timeline.phase;
      // OVERLOAD → auto-arm (extends the phase via hold(60_000)); FINALE →
      // staff/finale full 90 s. Either phase arms the barrage window; other phases
      // never auto-arm (a staff SIEGE_ARM director-cmd can force it explicitly).
      // BUT: the F12 Encore + the F6 Siege are MUTUALLY EXCLUSIVE showpieces
      // (§6.5 concurrency clause). If the crowd-charged encore already claimed the
      // FINALE, the siege stands down (the encore owns the overlay guard).
      if (phase === 'FINALE' && encores.get(roomId)?.active) return;
      if (phase === 'OVERLOAD') siege.arm({ staffArmed: false });
      else if (phase === 'FINALE') siege.arm({ staffArmed: true });
    },
    maybeAutoArmEncore(roomId: string): void {
      const encore = encores.get(roomId);
      const host = hosts.get(roomId);
      const siege = sieges.get(roomId);
      if (!encore || !host || encore.active) return;
      // The Encore is the FINALE crowd-charged experience. It auto-arms on FINALE
      // ONLY when the mutually-exclusive Siege is not live (§6.5 concurrency
      // clause) and the encore is not in cooldown (arm() self-guards cooldown).
      // Staff may also fire it explicitly (a director cue) — the no-crowd rung.
      if (host.timeline.phase !== 'FINALE') return;
      if (siege?.active) return;
      encore.arm({ staffFired: false });
    },
    drainGlyphs(): void {
      glyphs.drainQueue();
    },
  };

  return hub;
}

// ---------------------------------------------------------------------------
// Exported connection handler (called per new ws connection)
// ---------------------------------------------------------------------------

/** Options threaded from startServer into every connection (Task C2 / C4). */
export interface ConnectionOpts {
  /**
   * Task C2 GLOBAL fallback secret. Task C4 rebinds per-room tier auth to the
   * ownerToken-derived HMAC (`authStore`). When a room is auth-tracked, the HMAC
   * join secret is the gate; `staffKey` remains an accepted GLOBAL secret so a
   * C2-era env-key deploy still works. A Phase B `{t:'join'}` (no tier) still
   * joins as resident regardless (it is not a privileged REQUEST).
   */
  staffKey?: string;
  /**
   * Task C4: the room auth store. Verifies the HMAC join secret + ownerToken,
   * gates DOOR_CLOSE / retired rooms, tracks occupancy for TTL, and keys the
   * failed-join backoff. Always present in production (startServer creates it).
   */
  authStore?: RoomAuthStore;
  /** Task C4: the client IP (keys the per-(IP,roomId) failed-join backoff). */
  clientIp?: string;
  /** Injected timers (idle-kick). Defaults to the system timers. */
  timerApi?: TimerApi;
  /**
   * Task C8: injected metrics store. When provided, join events are counted
   * per granted tier. Omit in tests that do not need metrics.
   */
  metrics?: MetricsStore;
}

export function handleConnection(
  ws: WebSocket,
  manager: RoomManager,
  hub: ConnectionHub,
  onRoomGainedFirstPlayer: (roomId: string) => void,
  onRoomBecameEmpty: (roomId: string) => void,
  opts: ConnectionOpts = {}
): void {
  ws.binaryType = 'arraybuffer';

  const staffKey = opts.staffKey;
  const authStore = opts.authStore;
  const clientIp = opts.clientIp ?? 'unknown';
  const timerApi = opts.timerApi ?? systemTimerApi;
  const metricsStore = opts.metrics;

  // Cast to InternalHub to access per-server state. The only callers are
  // within this module (startServer passes the hub it created with makeConnectionHub).
  const h = hub as InternalHub;

  // ---------------------------------------------------------------------------
  // Idle-kick (Task C2, spec §5.1): wisp/crowd connections with no activity for
  // IDLE_KICK_MS are disconnected. Armed on join (for idle-kicked tiers only),
  // reset on every inbound message, cleared on close. Uses the injected timer.
  // ---------------------------------------------------------------------------
  function armIdleTimer(): void {
    const meta = h.socketMeta.get(ws);
    if (!meta) return;
    if (!TIER_POLICY[meta.tier].idleKick) return;
    if (meta.idleTimer !== null) timerApi.clearTimeout(meta.idleTimer);
    meta.idleTimer = timerApi.setTimeout(() => {
      // No activity within the window — disconnect (one-tap rejoin client-side).
      try {
        ws.close(1000, 'idle-kick');
      } catch {
        /* already closing */
      }
    }, IDLE_KICK_MS);
  }

  function noteActivity(): void {
    const meta = h.socketMeta.get(ws);
    if (!meta || !TIER_POLICY[meta.tier].idleKick) return;
    armIdleTimer(); // re-arm resets the deadline
  }

  // Finding #1/#4: a per-socket 'error' handler. ws emits 'error' (not throw
  // per-socket, but an unhandled ws 'error' becomes an uncaughtException) for
  // protocol errors incl. exceeding maxPayload. Handle it locally: log + close
  // this ONE socket; never let it bubble to the process.
  ws.on('error', (err) => {
    console.error('[connection] socket error (closing this socket only):', err);
    try {
      ws.close(1011, 'socket-error');
    } catch {
      /* already closing */
    }
  });

  // Per-socket rate limiter (finding #1). Covers BOTH text and binary frames.
  const bucket = new TokenBucket(RATE_REFILL_PER_SEC, RATE_BURST);
  let consecutiveDrops = 0;

  // Task C4: ROTATE_LINK is confirm-twice — the first command primes this flag,
  // the second (or a `confirm:true`) executes. Per-connection so one staff tab's
  // confirm state never bleeds into another's.
  let rotateLinkPrimed = false;

  /**
   * Charge one token for this frame. Returns true if the frame may be
   * processed. On sustained flooding (RATE_CLOSE_AFTER_DROPS consecutive
   * over-budget frames) the socket is closed.
   */
  function allowFrame(): boolean {
    if (bucket.take()) {
      consecutiveDrops = 0;
      return true;
    }
    consecutiveDrops++;
    if (consecutiveDrops >= RATE_CLOSE_AFTER_DROPS) {
      try {
        ws.close(1008, 'rate-limit');
      } catch {
        /* already closing */
      }
    }
    return false;
  }

  // ----- TEXT messages -------------------------------------------------------
  ws.on('message', (data, isBinary) => {
    // Finding #1: rate-limit EVERY inbound frame (text + binary) per socket.
    if (!allowFrame()) return; // dropped (and possibly closed) on flood

    // Task C2 — idle-kick: ANY inbound frame (text or binary) is activity and
    // resets the idle timer for idle-kicked tiers (wisp/crowd).
    noteActivity();

    // Finding #4: a structurally-malformed intent must never throw out of this
    // handler and kill the Node process (all rooms). Wrap the whole dispatch;
    // log + drop the offending message, keep the socket and room alive.
    try {
      dispatchMessage(data, isBinary);
    } catch (err) {
      console.error('[connection] message dispatch failed (dropped):', err);
      try {
        h.sendText(ws, { t: 'error', code: 'bad-message', message: 'message rejected' });
      } catch {
        /* socket may be gone */
      }
    }
  });

  function dispatchMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) {
      handleBinary(ws, data);
      return;
    }

    const raw = (data as { toString(): string }).toString();
    let msg: ReturnType<typeof decodeText>;
    try {
      msg = decodeText(raw);
    } catch {
      h.sendText(ws, { t: 'error', code: 'bad-message', message: 'invalid JSON' });
      return;
    }

    // Findings #2/#5/#17: validate the decoded message BEFORE it can touch the
    // world or be relayed. Reject (drop + error) invalid Vec3s, out-of-range
    // color/type/renderMode, non-string ids, etc. NEVER mutates the world.
    if (!validateClientMsg(msg)) {
      h.sendText(ws, { t: 'error', code: 'bad-message', message: 'invalid message fields' });
      return;
    }

    const meta = h.socketMeta.get(ws);

    // --- join (Task C2: the tiered handshake) ---
    if (msg.t === 'join') {
      if (meta) {
        // Already joined — ignore duplicate
        return;
      }
      // Finding #16: reject a client speaking a different protocol version.
      if (msg.protocol !== PROTOCOL_VERSION) {
        h.sendText(ws, {
          t: 'error',
          code: 'protocol-mismatch',
          message: `protocol ${String(msg.protocol)} != server ${PROTOCOL_VERSION}`,
        });
        ws.close();
        return;
      }
      // Validate the room name at the WS boundary so a malicious/traversal
      // room name (e.g. "../../etc/passwd") never reaches RoomManager/persistence.
      if (typeof msg.room !== 'string' || !ROOM_ID_RE.test(msg.room)) {
        h.sendText(ws, { t: 'error', code: 'bad-room', message: 'invalid room name' });
        ws.close();
        return;
      }
      const room = msg.room;
      const safeColor = Number.isFinite(msg.color) ? Math.trunc(msg.color) : 0;
      const requestedName =
        typeof msg.requestedName === 'number' ? msg.requestedName : undefined;
      const presentedOwnerToken = typeof msg.ownerToken === 'string' ? msg.ownerToken : undefined;
      const presentedSecret = typeof msg.joinSecret === 'string' ? msg.joinSecret : undefined;

      void (async () => {
        // Task C4 — AUTH GATE. Order:
        //  (0) retired room (ROTATE_LINK'd) → hard refuse (the old id is dead).
        //  (1) rehydrate the room's auth record from disk (post-restart permalink).
        //  (2) EXPLICIT privileged tier (resident/spectator/director) is gated by
        //      the HMAC join secret (C4) OR the C2 global staffKey fallback OR the
        //      ownerToken itself. Bad/absent → record failed-join backoff +
        //      DOWNGRADE to crowd (never reject). Absent-tier (Phase B) → resident.
        //  (3) any VALID ownerToken → this connection is DIRECTOR-capable (any tier).
        //  (4) DOOR_CLOSE → a NEW public (wisp/crowd) join is refused (downgrade),
        //      an authed resident/spectator still lands.

        // (0)+(1): rehydrate + retired-room check.
        if (authStore) {
          await authStore.loadRoom(room);
          if (authStore.isRetired(room)) {
            h.sendText(ws, {
              t: 'error',
              code: 'room-retired',
              message: 'this room has moved — check the club Discord',
            });
            ws.close();
            return;
          }
        }

        // (2b): per-(IP, roomId) failed-auth backoff check (spec §5.4).
        // ONLY an EXPLICIT privileged tier request is throttled — a bare {t:'join'}
        // (absent tier, Phase B compat) NEVER fails auth so it is never backed off.
        // If throttled: send an error and downgrade to crowd (never reject outright
        // so the "downgrade-not-reject" C2 invariant is preserved for the peer's UI).
        if (msg.tier !== undefined && authStore && authStore.isJoinThrottled(clientIp, room)) {
          const retryAfterMs = authStore.throttleRemainingMs(clientIp, room);
          h.sendText(ws, {
            t: 'error',
            code: 'throttled',
            message: `too many failed auth attempts — retry after ${retryAfterMs} ms`,
            retryAfterMs,
          } as unknown as ServerMsg);
          // Land as crowd (visible-but-limited) rather than closing the connection.
          // A clean bare join with no tier would have bypassed this block anyway.
          ws.close();
          return;
        }

        // (3): a presented ownerToken (validated against the room) is director-capable.
        const isOwner =
          presentedOwnerToken !== undefined &&
          !!authStore &&
          authStore.verifyOwnerToken(room, presentedOwnerToken);

        // (2): negotiate the tier via the HMAC/staffKey/ownerToken gate.
        const negotiated = negotiateAuthedTier(
          msg.tier,
          presentedSecret,
          isOwner,
          room,
          authStore,
          staffKey
        );

        // A privileged request that FAILED auth arms the (IP, roomId) backoff so a
        // devtools bruteforce is slowed. A successful/public join clears it.
        if (authStore) {
          if (negotiated.authFailed) {
            authStore.recordFailedJoin(clientIp, room);
          } else if (msg.tier !== undefined && TIER_POLICY[negotiated.tier]?.authRequired) {
            authStore.recordSuccessfulJoin(clientIp, room);
          }
        }
        // Task C2 — CAPS: try the negotiated tier; if it is over cap, either
        // hard-reject (authed resident — the Phase B invariant) or downgrade a
        // non-privileged/privileged-non-resident connection to crowd (never a
        // rejection screen). Resident cap is enforced by RoomManager (addPlayer).
        let grantedTier: Tier = negotiated.tier;
        let downgradeFrom: Tier | undefined = negotiated.downgradeFrom;
        let downgradeReason: string | undefined = negotiated.reason;

        // Task C4 — DOOR_CLOSE (spec §5.4): when a room's door is CLOSED, a NEW
        // PUBLIC join (anything that negotiated down to wisp/crowd, i.e. NOT an
        // authed resident/spectator/director) is refused → downgraded to crowd
        // with a `door-closed` reason. Authed staff (resident/spectator/director)
        // still get in. A connection carrying the ownerToken is never door-blocked.
        if (
          h.doorClosed.has(room) &&
          (grantedTier === 'wisp' || grantedTier === 'crowd') &&
          !isOwner
        ) {
          if (grantedTier !== 'crowd') {
            downgradeFrom = grantedTier;
          } else {
            // A public wisp/crowd is still "downgraded" in the sense of refused-
            // full-entry: surface it so the client shows the door-closed card.
            downgradeFrom = negotiated.downgradeFrom ?? grantedTier;
          }
          downgradeReason = 'door-closed';
          grantedTier = 'crowd';
        }

        // Task C25 (F14 The Gallery) — AUDIENCE admission (spec §5.1/§7.14). An
        // over-cap remote viewer is NEVER downgraded to a booth crowd participant
        // (that would consume a booth cap / the queue bridge — the §7.14 rule): it
        // gets a soft static "at capacity — the world reopens tonight" card and the
        // socket closes (no crowd fallback). Two independent limits, plus a per-IP
        // join token bucket that also throttles the cached-keyframe egress:
        //   (i)  the per-IP concurrency cap (≤ 4 sockets/IP) — the unauthed-surface
        //        defense (one IP opening 64 sockets → 4 admitted, 60 at-capacity);
        //   (ii) the per-room cap (128).
        let audienceKeyframeThrottled = false;
        if (grantedTier === 'audience') {
          const overPerIp = h.audienceIpCount(room, clientIp) >= AUDIENCE_MAX_PER_IP;
          const overRoomCap = h.tierCount(room, 'audience') >= AUDIENCE_CAP;
          if (overPerIp || overRoomCap) {
            h.sendText(ws, {
              t: 'error',
              code: 'at-capacity',
              message: 'at capacity — the world reopens tonight',
            });
            ws.close(1013, 'audience-at-capacity');
            return;
          }
          // The per-IP token bucket gates the join RATE and the keyframe egress. An
          // empty bucket does NOT reject (a live viewer still lands + rolls forward
          // from the coalesced buffer) — it only SKIPS the expensive cached-keyframe
          // send for this rapid join (the egress throttle, §7.14).
          audienceKeyframeThrottled = !h.audienceJoinBucket(room, clientIp).take();
        }

        // Cap check for NON-resident tiers (resident cap is Room.addPlayer's job).
        // Audience is handled by its own dedicated block above (never crowd-downgraded).
        if (grantedTier !== 'resident' && grantedTier !== 'audience') {
          const cap = TIER_POLICY[grantedTier].cap;
          if (h.tierCount(room, grantedTier) >= cap) {
            // Over cap → degrade to crowd (over-cap wisp = spectate page;
            // over-cap spectator/director/crowd all soft-degrade, never reject).
            if (grantedTier !== 'crowd') {
              downgradeFrom = grantedTier;
              downgradeReason = grantedTier === 'wisp' ? 'wisp-over-cap' : 'over-cap';
              grantedTier = 'crowd';
            }
            // If crowd itself is over cap the connection still lands as crowd
            // (cheer-button mode) — the doctrine is never a rejection screen.
          }
        }

        // Task C2 — CALLSIGN: assign a unique per-room callsign BEFORE the world
        // join so the presence `name` written by RoomManager → Room.addPlayer is
        // the callsign itself (spec §3 change 4 / §6.1, C0 binding 15). Uniqueness
        // is roster-only until C8 buckets fold in day-stats + guestbook. The
        // free-text `msg.name` is NEVER used — it never reaches a screen.
        const epoch = h.getRoomEpoch(room);
        const rng = makeRoomRng(room);
        const callsign = h.reserveCallsign(room, requestedName, rng);

        let result = await manager.joinTier(room, grantedTier, callsign, safeColor);

        // Task C28 (F17 Daemon Crew): EVICT-FIRST at the 8-resident cap (§7.17). A
        // real resident is NEVER blocked by a daemon — if the room is full and a
        // synthetic peer occupies a slot, dismiss ONE daemon (a standard disconnect
        // that releases its held shape) and retry the join ONCE. Only a genuine
        // human room-full (no daemons to evict) falls through to the refusal below.
        if ('error' in result && result.error === 'room-full' && grantedTier === 'resident') {
          if (h.getDaemonCrew(room)?.evictOneForHuman()) {
            result = await manager.joinTier(room, grantedTier, callsign, safeColor);
          }
        }

        if ('error' in result) {
          // Only an authed resident over MAX_PLAYERS reaches here (Phase B
          // room-full invariant). server-full is the room-count DoS cap. Release
          // the callsign we reserved for this rejected join.
          h.releaseCallsign(room, callsign);
          h.sendText(ws, {
            t: 'error',
            code: result.error,
            message: `Cannot join: ${result.error}`,
          });
          ws.close();
          return;
        }

        const { room: roomObj, playerId } = result;

        // (6b) The client may have disconnected DURING `await joinTier`. If so,
        // the close handler already ran (no meta yet) so it did NOT evict this
        // just-joined player. Reconcile: leave + release callsign and bail. Only
        // a resident was addPlayer'd, so only a resident needs manager.leave; a
        // non-resident that raced just releases its callsign.
        if (ws.readyState !== 1 /* OPEN */) {
          h.releaseCallsign(room, callsign);
          const sockets0 = h.roomSockets.get(room);
          const keepAlive = (sockets0?.size ?? 0) > 0;
          if (grantedTier === 'resident') {
            const events = manager.leave(room, playerId, keepAlive);
            for (const evt of events) h.broadcast(room, evt);
          } else if (!keepAlive) {
            manager.dropRoom(room);
            h.roomEpochs.delete(room);
          }
          if (!manager.get(room)) onRoomBecameEmpty(room);
          return;
        }

        // Task C4 — join provenance (spec §5.4). `entryRoute` records how the peer
        // arrived: staff (ownerToken), the funnel route it requested, or the Phase
        // B compat path (no tier). `joinedAt` is roomEpoch-relative ms.
        const entryRoute = isOwner
          ? 'staff'
          : msg.tier === undefined
            ? 'phase-b'
            : downgradeFrom !== undefined
              ? `${downgradeFrom}->${grantedTier}`
              : grantedTier;
        const joinedAt = Math.max(0, timerApi.now() - epoch);

        h.socketMeta.set(ws, {
          roomId: room,
          playerId,
          tier: grantedTier,
          callsign,
          roomEpoch: epoch,
          idleTimer: null,
          director: isOwner,
          ...(isOwner && presentedOwnerToken ? { ownerToken: presentedOwnerToken } : {}),
          entryRoute,
          joinedAt,
          clientIp,
        });

        // Task C14 (F4) — assign this wisp a server-owned orbit slot (spec §7.4).
        // Slots bias INTO the headset frustum + toward the stage; the server has no
        // live headset frustum here, so it uses a forward-facing default and lets
        // the deterministic allocator fill the most stage-forward FREE slot. The
        // slot is the wisp's `wispIndex` (anti-spoof — the client cannot pick it).
        if (grantedTier === 'wisp') {
          const occupied = new Array(WISP_CAP).fill(false);
          for (const other of h.getRoomSockets(room)) {
            const om = h.socketMeta.get(other);
            if (om && om.tier === 'wisp' && om.wispSlot !== undefined) occupied[om.wispSlot] = true;
          }
          const slot = allocateSlot(occupied, DEFAULT_WISP_FRUSTUM, DEFAULT_STAGE_DIR);
          const m = h.socketMeta.get(ws);
          if (m && slot !== null) m.wispSlot = slot;
        }

        // Task C25 (F14 The Gallery) — track this remote viewer against its IP so
        // the per-IP cap (and the disconnect decrement) stay coherent.
        if (grantedTier === 'audience') h.incAudienceIp(room, clientIp);

        // Task C4 — TTL occupancy: mark the room joined so it is not TTL-evicted
        // while occupied (spec §5.4 "TTL eviction of never-joined/empty rooms").
        // NOTE (spec §7.14): a remote viewer never counts as booth occupancy — the
        // ATTRACT-exit + idle detection key on RESIDENT presence (host.onPeerJoined
        // fires for residents only, below), not on this audience socket.
        if (authStore) authStore.markJoined(room);

        // Task C8 — metrics: count this join per granted tier (spec §7.17).
        // Synthetic DMN- peers (callsign starts with 'DMN-') are keyed separately
        // in the metrics store so daemon joins don't inflate the real join counter.
        // Pass the callsign (not grantedTier) so isSynthetic() detects 'DMN-' peers.
        // count('scan') is deferred to C7 — add it at the funnel beacon landing
        // point in the QR-scan / landing-page handler when C7 lands.
        metricsStore?.count('join', callsign.startsWith('DMN-') ? callsign : grantedTier);

        const sockets = h.getRoomSockets(room);
        const isFirstPlayer = sockets.size === 0;

        // Task C10 — ensure the room's Showrunner exists BEFORE this socket enters
        // the room set. Registering the seed cues fires incremental CUE_CATALOG
        // broadcasts; doing it before `sockets.add(ws)` means the just-joining
        // director never receives a PARTIAL catalog — only the clean full snapshot
        // sent below (its console renders the complete seed set at once).
        const host = ensureHost(roomObj);

        // Task C12: pre-warm the guestbook (load from the bucket + seed the 50
        // authored openers if empty) BEFORE the welcome batch, so the glyph
        // snapshot rides the SAME synchronous send as welcome/env-state (a single
        // await here, not one interleaved between broadcasts — keeps the join
        // message ordering deterministic for full-receive tiers).
        await ensureGuestbook(room);

        // (6c) Add this socket to the room set FIRST, then broadcast player-join
        // to OTHERS (exclude self). This ordering guarantees concurrent joiners
        // to a fresh room each see the other's player-join.
        sockets.add(ws);

        // Task C2 — HELLO reply (Appendix B): {peerId, callsign, tier, roomEpoch}.
        // A downgrade payload precedes it so the client knows it was demoted.
        if (downgradeFrom !== undefined) {
          h.sendText(ws, {
            t: 'downgrade',
            from: downgradeFrom,
            to: grantedTier,
            reason: downgradeReason ?? 'downgrade',
          });
        }
        h.sendText(ws, { t: 'hello', peerId: playerId, callsign, tier: grantedTier, roomEpoch: epoch });

        // Presence player-join carries the CALLSIGN as the display name — every
        // nameplate/roster renderer reads PlayerInfo.name, so callsigns show with
        // zero client change (spec §3 change 4). ONLY residents are world avatar
        // players (registered via addPlayer, present in welcome.players); a
        // wisp/crowd/spectator/director is NOT an avatar, so it emits no world
        // player-join (wisps announce via WISP_JOIN when C14 lands). This keeps
        // welcome.players and the player-join stream in agreement.
        if (grantedTier === 'resident') {
          const playerInfo = { id: playerId, name: callsign, color: safeColor };
          h.broadcast(room, { t: 'player-join', player: playerInfo }, ws);
          // C26: the caster welcomes the joining RESIDENT (a JOIN_CRANE moment) — a
          // self-contained callsign slot, so crowd/audience render it roster-free.
          h.getCaster(room)?.onEvent({ kind: 'join', callsign });
        }

        // Send welcome snapshot to the joiner (only full-receive tiers; the
        // fan-out policy blocks `welcome` for wisp/crowd — send directly and let
        // sendText go out only when the tier admits it).
        if (TIER_POLICY[grantedTier].receive === 'full' || TIER_POLICY[grantedTier].receive === 'stateOnly') {
          // C22 (carry #1): the welcome snapshot carries the STANDING baseParams
          // (host.baseParams — the elected law, or DEFAULT_PARAMS) ADDITIVELY, so
          // the desktop laws chip paints correctly on join, before any VOTE_RESULT.
          h.sendText(ws, roomObj.snapshotFor(playerId, host.baseParams));
          // C11: include the active ENV_STATE in the late-join snapshot (spec §7.3
          // "late-join coherent auto-revert") — a joiner mid-dial lands with the
          // active dial + its `endsAt`, and (critically) the `params.freeze` flag so
          // its render-pause engages immediately. Sent right after `welcome` so the
          // client applies params before its first frame.
          const env = host.envState();
          h.sendText(ws, {
            t: 'env-state',
            serverTimestamp: env.serverTimestamp,
            mode: env.mode,
            params: env.params,
            endsAt: env.endsAt,
          });
          // Task C12: the full guestbook backfill (spec §7.13 — chunked render is
          // a client concern; the wire carries the VISIBLE set once). The stage
          // (spectator) + headset (resident) + director all render the
          // constellation. The guestbook was loaded/seeded above (pre-warm), so
          // this send is synchronous — same ordering guarantee as welcome/env-state.
          const gvis = h.glyphs.visibleGlyphs(room);
          if (gvis.length > 0) {
            h.sendText(ws, { t: 'glyph-snapshot', glyphs: gvis.map((g) => toGlyphNetLocal(g)) });
          }
          // Task C16 (F6): a joiner mid-siege lands on a coherent SHOWPIECE state —
          // the pinned crystal id + the LIVE hp/maxHp + the self-terminate endsAt
          // (the crystal cam + oversized HP bar render immediately). Sent as a
          // SHOWPIECE_START so the client's siege handler engages before its first
          // frame. No-op when no siege is active.
          const siege = h.sieges.get(roomObj.roomId);
          const snap = siege?.snapshot();
          if (snap) {
            h.sendText(ws, {
              t: 'showpiece',
              kind: SHOWPIECE_KIND.START,
              crystalId: snap.crystalId,
              hp: snap.hp,
              maxHp: snap.maxHp,
              endsAt: snap.endsAt,
            });
            // Task C27 (F16 Siege Waves): a joiner mid-wave also lands on the LIVE
            // wave narrative — {waveIndex, waveEndsAt} (indices only, no name on the
            // wire; the client resolves the splash name from the shared SIEGE_WAVES
            // table). The wave PHYSICS + banner already arrived on the ENV_STATE above.
            // The index is bounded to a REAL wave row (0..len−1): the −1 post-arc /
            // no-active-wave sentinel — and any out-of-range index — forwards NO WAVE
            // frame, so a tail late-join never renders a phantom "WAVE 4" splash
            // (§7.16 post-arc coherence; consistent with the client's unknown-kind
            // ignore).
            if (snap.waveIndex >= 0 && snap.waveIndex < SIEGE_WAVES.length) {
              h.sendText(ws, {
                t: 'showpiece',
                kind: SHOWPIECE_KIND.WAVE,
                waveIndex: snap.waveIndex,
                waveEndsAt: snap.waveEndsAt,
              });
            }
          }
          // Task C17 (F7 Titan Protocol, §7.7): a joiner mid-titan lands with the
          // active titan's presence playerScale — a PLAYER_SCALE at the FULL target
          // scale + 0 ms duration (already grown; no re-ease) so the joiner's avatar
          // renderer scales the giant immediately. No-op when no titan is active.
          const titanSnap = h.titans.get(roomObj.roomId)?.snapshot();
          if (titanSnap) {
            h.sendText(ws, {
              t: 'player-scale',
              peerId: titanSnap.peerId,
              scale: titanSnap.scale,
              durationMs: 0,
            });
          }
        }

        // Task C25 (F14 The Gallery) — the audience CACHED late-join keyframe
        // (spec §7.14). A remote viewer NEVER receives the full `welcome` snapshot
        // (that path is full/stateOnly only, above); it lands on the room's cached,
        // once-serialized keyframe (all shapes) and rolls forward from the shared
        // 5 Hz coalesced buffer. `getForJoin` REUSES the cached buffer, so a 128-join
        // Discord burst triggers ZERO fresh serializations (the stampede guard). The
        // send is SKIPPED when the per-IP token bucket was drained (egress throttle)
        // — the viewer still catches up from the roll-forward buffer.
        if (grantedTier === 'audience' && !audienceKeyframeThrottled && ws.readyState === 1) {
          const kf = h.audienceKeyframe(room).getForJoin(roomObj.worldShapes, roomObj.serverTick);
          h.sendAudienceRaw(ws, kf);
        }
        // Task C25: refresh the "N WATCHING" counter promptly on an audience join
        // (the 0.2 Hz sim driver is the steady-state backstop).
        if (grantedTier === 'audience') h.broadcastAudienceState(room);

        // Arm the idle-kick for wisp/crowd/audience (spec §5.1). Residents/
        // spectators/directors are never idle-kicked.
        armIdleTimer();

        // Task C19 (F12): a joiner mid-encore (esp. a phone scanning during the
        // charge) lands on the LIVE charge — an immediate CHARGE_STATE binary frame
        // (Appendix B) so its meter is coherent before the next coalesced tick. No-op
        // when no encore is armed. All receive tiers (the crowd meter reads it).
        const encoreSnap = h.encores.get(roomObj.roomId)?.snapshot();
        if (encoreSnap && ws.readyState === 1) {
          const frame = chargeStateFrame({
            charge: encoreSnap.charge,
            crowdSize: encoreSnap.crowdSize,
            fireAtMs: encoreSnap.fireAtMs,
          });
          ws.send(frame);
        }

        // Task C20 (F9 Reality Channels): a joiner lands on the room's ACTIVE
        // reality — send the current theme as an immediate THEME_SET (snap NOW, no
        // glitch: a late-join is not a transition). The active theme persists via
        // the room's ThemeChannelHost, so a rejoiner sees the same channel everyone
        // else is on. No-op if the room has no theme channel.
        const themeChan = h.themeChannels.get(roomObj.roomId);
        if (themeChan && ws.readyState === 1) {
          // COORDINATE SYSTEM: `transitionAtServerTime` is ABSOLUTE server ms
          // (timer.now()), matching _applyAndBroadcast in ThemeChannelHost. A late
          // joiner receives a snap-NOW (no lead), so we pass the current server time.
          // Do NOT subtract roomEpoch here — that would create a different coordinate
          // system than the broadcast path and break onThemeSet client scheduling.
          h.sendText(ws, {
            t: 'theme-set',
            themeId: themeChan.activeTheme,
            transitionAtServerTime: timerApi.now(),
            glitch: false,
          });
        }

        // A director-capable connection just joined → prime it with the current
        // CUE_CATALOG + the live PHASE_STATE so its console renders immediately (a
        // stateless staff phone re-renders from exactly these on every reconnect).
        // Director-capable = the director tier OR any tier carrying the ownerToken
        // (the stage joins as a spectator carrying it — §5.4).
        if (grantedTier === 'director' || isOwner) {
          h.sendText(ws, { t: 'director-msg', kind: 'CATALOG', catalog: host.registry.catalog() });
          const ps = host.timeline.state();
          h.sendText(ws, {
            t: 'phase-state',
            phase: ps.phase,
            endsAt: ps.endsAt,
            remainingMs: ps.remainingMs,
          });
        }

        // A HUMAN resident join advances ATTRACT → LOBBY (§5.5/§7.17); synthetic
        // (DMN-) joins never advance it. Non-residents don't drive the timeline.
        if (grantedTier === 'resident') {
          host.onPeerJoined({
            id: playerId,
            name: callsign,
            color: safeColor,
            ...(callsign.startsWith('DMN-') ? { synthetic: true } : {}),
          });
          // Task C28 (F17 Daemon Crew): a human-resident join is a dismissal trigger
          // (§7.17): humans ≥ 2 dismisses the crew (the booth is lively again); a
          // lone-visitor transition auto-summons ONLY behind the ship gate (default
          // OFF). humanResidentCount is socket-based — synthetic-blind by construction.
          h.getDaemonCrew(room)?.onHumanCountChanged(humanResidentCount(room));
        }

        // If room just went from 0→1 socket, start the sim loop.
        if (isFirstPlayer) {
          onRoomGainedFirstPlayer(room);
        }
      })().catch((err) => {
        // (6a) An un-caught rejection here would be an unhandled promise
        // rejection (can crash Node). Surface an error to the client and close.
        console.error(`[connection] join failed for room ${JSON.stringify(room)}:`, err);
        h.sendText(ws, { t: 'error', code: 'join-failed', message: 'internal error joining room' });
        ws.close();
      });
      return;
    }

    // --- Task C25 (F14 The Gallery) — SEND-SIDE audience boundary (spec §5.1) --
    // An `audience` connection SENDS heartbeat + CLOCK_PING ONLY. CLOCK_PING is a
    // BINARY frame (handled in handleBinary, allowed for any tier); a text
    // `heartbeat` is a pure no-op whose ONLY effect — resetting the idle timer —
    // ALREADY ran at the top of ws.on('message') via noteActivity(). So EVERY
    // other client→server text message is dropped HERE for a remote viewer:
    // glyph-add, build ops, vote-cast, charge-tap, director-cmd, pose, wisp-pulse,
    // met-launch/met-hit, and every game intent. This is the single choke point
    // that guarantees a socket on the public unauthed `?watch` permalink can NEVER
    // trigger a world / state / persistence side-effect through ANY dispatch
    // branch — it closes the C25 review M1 glyph-add hole (whose branch ran BEFORE
    // the generic canSendIntents gate) and pre-empts every other branch too.
    if (meta && meta.tier === 'audience') return;

    // --- voice control messages ---
    // Task C2: only voice SENDER tiers (residents) may join voice / appear in the
    // roster. A spectator/wisp/crowd voice-join is dropped (it can RECEIVE frames
    // if its tier allows, but never becomes a sender).
    if (msg.t === 'voice-join') {
      if (!meta) return;
      if (!TIER_POLICY[meta.tier].voiceSend) return;
      const vset = h.getVoiceSet(meta.roomId);
      vset.add(meta.playerId);
      // Broadcast updated voice roster to the whole room
      h.broadcastVoiceRoster(meta.roomId);
      return;
    }

    if (msg.t === 'voice-leave') {
      if (!meta) return;
      if (!TIER_POLICY[meta.tier].voiceSend) return;
      const vset = h.getVoiceSet(meta.roomId);
      vset.delete(meta.playerId);
      h.broadcastVoiceRoster(meta.roomId);
      return;
    }

    if (msg.t === 'voice-state') {
      if (!meta) return;
      if (!TIER_POLICY[meta.tier].voiceSend) return;
      // Relay to others (exclude sender)
      h.broadcast(
        meta.roomId,
        { t: 'voice-state', id: meta.playerId, speaking: msg.speaking, muted: msg.muted },
        ws
      );
      return;
    }

    if (msg.t === 'voice-config') {
      if (!meta) return;
      if (!TIER_POLICY[meta.tier].voiceSend) return;
      // Finding #7: build the outbound object EXPLICITLY with only the
      // whitelisted `config` field — never spread the attacker's raw message
      // (which would relay arbitrary keys, 1→N amplified, to every peer).
      // validateClientMsg already guaranteed msg.config is a string; cap length.
      const config = msg.config.slice(0, MAX_VOICE_CONFIG_LEN);
      h.broadcast(
        meta.roomId,
        { t: 'voice-config', id: meta.playerId, config } as unknown as ServerMsg,
        ws
      );
      return;
    }

    // --- Task C4: staff DIRECTOR command (spec §5.4) -------------------------
    // ANY connection that presented a valid ownerToken at join is director-
    // capable regardless of tier (`meta.director`). A non-director connection is
    // refused with `not-authorized` — never silently dropped, so a stale staff
    // tab learns it lost authority (e.g. after a ROTATE that it missed).
    if (msg.t === 'director-cmd') {
      if (!meta) return;
      if (!meta.director) {
        h.sendText(ws, { t: 'error', code: 'not-authorized', message: 'director command refused' });
        return;
      }
      void handleDirectorCmd(ws, meta, msg);
      return;
    }

    // --- pose relay (own branch, NOT a game intent) ---
    // Task C2: only tiers whose policy permits intents/poses relay a pose. A
    // resident's pose relays to peers; a spectator/crowd pose is dropped
    // (spectators are receive-only for world state; crowd has no avatar). Wisp
    // poses ride the WISP_POSE family (C14), not this Phase B pose relay.
    if (msg.t === 'pose') {
      if (!meta) return;
      if (!TIER_POLICY[meta.tier].canSendIntents) return;
      if (meta.tier !== 'resident') return; // only residents drive avatar poses here
      h.broadcast(meta.roomId, { t: 'pose', id: meta.playerId, pose: msg.pose }, ws);
      // Task C28 (F17 Daemon Crew): tee the latest HUMAN resident pose so a daemon can
      // aim its return lob at the nearest real head (chest offset, §7.17). Only residents
      // reach here — daemon poses bypass this socket path, so the map is synthetic-blind.
      let rposes = h.lastResidentPose.get(meta.roomId);
      if (!rposes) {
        rposes = new Map();
        h.lastResidentPose.set(meta.roomId, rposes);
      }
      rposes.set(meta.playerId, msg.pose);
      // Task C17 (F7 Titan Protocol, §7.7): if this resident is the active titan,
      // feed their HAND world-positions to the titan host — it derives hand velocity
      // (poses carry none on the wire) and applies the giant's impulse sweep to
      // non-grabbed shapes within the scaled hand radius. A no-op for a non-titan.
      const titan = h.titans.get(meta.roomId);
      if (titan?.active && titan.activeTitan === meta.playerId) {
        const hands = msg.pose.hands.map((hnd) => (hnd ? hnd.p : null));
        titan.feedTitanPose(meta.playerId, hands, timerApi.now());
      }
      return;
    }

    // --- Task C12: GLYPH_ADD (the Neon Guestbook scribe) ----------------------
    // A crowd-tier scribe (ephemeral guest) — or any joined peer — draws a glyph.
    // Validated at the wire boundary already (validateClientMsg → validateGlyph).
    // The GlyphManager applies the three rate-limit layers (server-wide inflow
    // token bucket with QUEUED overflow + per-guest lifetime cap; NEVER per-IP)
    // and, on admit, broadcasts the birthed `glyph` + persists to the guestbook
    // bucket. The scribe gets a private `glyph-ack {callsign, ring}` (closes the
    // loop even with no projector — Phase D's exit greeting persists it).
    if (msg.t === 'glyph-add') {
      if (!meta) return;
      // Task C25 review (M1) — TIER GATE (defense-in-depth): a guestbook glyph is
      // a crowd/resident SEND (spec §5.1 crowd row: "glyph submissions"). Gate it
      // exactly like vote-cast / charge-tap so NO other tier can inject a
      // persistent glyph (broadcast to every screen + written to the guestbook
      // bucket). The audience early-gate above already dropped an audience send;
      // this also blocks wisp/spectator/director, and handleGlyphAdd re-checks.
      if (meta.tier !== 'crowd' && meta.tier !== 'resident') return;
      void handleGlyphAdd(meta, msg);
      return;
    }

    // --- Task C14 (F4): WISP_PULSE (server-validated radial impulse) -----------
    // Only the wisp tier may fire (trust the server-granted tier, not a claim).
    //   (1) 2/s TOKEN BUCKET — the 3rd pulse inside 1 s is DROPPED here, before it
    //       can touch the world (anti-spam, spec §5.1).
    //   (2) the client-sent `magnitude` is CLAMPED server-side (applyWispPulse →
    //       clampPulseMagnitude); the world never feels a client's huge value.
    // The unclamped cosmetic feedback (tracer/flash/shockwave) is client-only and
    // never rides this path.
    if (msg.t === 'wisp-pulse') {
      if (!meta || meta.tier !== 'wisp') return;
      const bucket = (meta.wispPulseBucket ??= new WispPulseBucket(() => timerApi.now()));
      if (!bucket.tryPulse()) return; // over 2/s — dropped, no world mutation.
      const room = manager.get(meta.roomId);
      if (!room) return;
      // Deterministic per-pulse seed: wisp slot mixed with the live serverTick, so
      // the seeded jitter varies pulse-to-pulse yet is reproducible in a replay.
      const seed = ((meta.wispSlot ?? 0) * 2654435761 + room.serverTick) >>> 0;
      applyWispPulse(room, msg.pos, msg.magnitude, seed);
      return;
    }

    // --- Task C15 (F5): VOTE_CAST (the Reality Referendum ballot) --------------
    // Crowd ballots ride the crowd tier; residents may also vote (spec §5.9). The
    // election host keys on the PEER ID (one switchable vote per token). Unknown
    // options / a closed ballot are no-ops in the reducer. The 2 Hz tally coalescer
    // (never per-vote) does the broadcast — this handler only records the vote.
    if (msg.t === 'vote-cast') {
      if (!meta) return;
      if (meta.tier !== 'crowd' && meta.tier !== 'resident') return;
      const election = h.elections.get(meta.roomId);
      if (!election) return;
      election.cast(meta.playerId, msg.option);
      return;
    }

    // --- Task C19 (F12): CHARGE_TAP (a phone charges the supernova) ------------
    // The PRIMARY encore input (the shake garnish maps to the same intent). The
    // host debounces to ≤ 5/s PER PHONE + normalizes by crowd size (never trust a
    // flood). No-op when no encore is armed. Crowd (or resident) tier.
    if (msg.t === 'charge-tap') {
      if (!meta) return;
      if (meta.tier !== 'crowd' && meta.tier !== 'resident') return;
      const encore = h.encores.get(meta.roomId);
      if (!encore || !encore.active) return;
      encore.tap(meta.playerId);
      return;
    }

    // --- Task C34 (F23 The Workshop): BUILD ops (SET_TRANSFORM/SPAWN_EXACT/DELETE/
    // LAYOUT_*/SET_BASELINE/GLYPH_SEED) --------------------------------------------
    // CAPABILITY-GATED inside handleBuild: only a resident presenting the ownerToken
    // may build. The MUTATING kinds are ADDITIONALLY refused unless build-mode is
    // ACTIVE (the stale-tab safety, §7.23) — a stale tab can never wipe a live
    // rotation. Every path ACKs (echoing opId + assigned id / a refusal reason).
    if (msg.t === 'build') {
      if (!meta) return;
      void handleBuild(ws, meta, msg);
      return;
    }

    // --- Task C22 (F10 Ghost Arcade): the REEL transport (reel-bank/list/play) ---
    // CAPABILITY-GATED inside handleReel (bank = director/ownerToken; list/play =
    // spectator/director). Read/staff verbs ONLY — no world mutation ever rides
    // them, so an unauthorized bank is REFUSED (an inert `reel-ack`), never a
    // mutation. Whitelisted on the spectator send-plane (`reel-*`), so this runs
    // BEFORE the spectator no-op whitelist below.
    if (msg.t === 'reel-bank' || msg.t === 'reel-list' || msg.t === 'reel-play') {
      if (!meta) return;
      handleReel(ws, meta, msg);
      return;
    }

    // --- Task C16 (F6): MET_LAUNCH (a phone slingshots a meteor) ---------------
    // Phones (wisp/crowd tier) bombard the crystal. The server spawns the meteor
    // (speed CLAMPED to 6–8 m/s — never the client's power) + rate-limits to 1/3 s.
    // No-op when no siege is armed. Residents may also launch (a defender co-op).
    if (msg.t === 'met-launch') {
      if (!meta) return;
      if (meta.tier !== 'wisp' && meta.tier !== 'crowd' && meta.tier !== 'resident') return;
      const siege = h.sieges.get(meta.roomId);
      if (!siege || !siege.active) return;
      siege.launch(meta.playerId, {
        origin: msg.origin,
        aim: msg.aim,
        ...(msg.power !== undefined ? { power: msg.power } : {}),
        ...(msg.colorIndex !== undefined ? { colorIndex: msg.colorIndex } : {}),
        callsign: meta.callsign,
      });
      return;
    }

    // --- Task C16 (F6): MET_HIT (a client-claimed swat) ------------------------
    // A hand sweep deflects a meteor; the server plausibility-checks it against the
    // rewind buffer (hand near the meteor at the claimed timestamp). Resident-only
    // (the defender). Server-authoritative; cut-safe (drop this branch if over budget).
    if (msg.t === 'met-hit') {
      if (!meta || meta.tier !== 'resident') return;
      const siege = h.sieges.get(meta.roomId);
      if (!siege || !siege.active) return;
      siege.swat(msg.meteorId, msg.handPoint, msg.clientTimestamp, meta.callsign);
      return;
    }

    // --- send policy for non-intent-bearing tiers (Task C2) -------------------
    if (!meta) return;

    // Spectator: send-whitelist ONLY (spec §5.1). Text-plane whitelist =
    // heartbeat + stream-subscription control + the REEL/REQUEST_SNAPSHOT family
    // (`reel-*` / `request-snapshot`). Everything else (spawn/grab/…) is dropped
    // silently — never an error, never a world mutation. (The binary
    // SPECTATOR_SEND_WHITELIST gates opcode frames; that path lands with C13.)
    if (meta.tier === 'spectator') {
      if (isSpectatorWhitelistedText(msg.t)) return; // accepted (no-op until its handler lands)
      return; // dropped
    }

    // wisp/crowd: no Phase B world intents. Wisps send poses + rate-limited WISP
    // intents (C14); crowd sends votes/taps/glyphs (C12/C15). A wisp GRAB/spawn
    // etc. is rejected server-side here (spec §5.1: wisps cannot grab shapes).
    if (meta.tier === 'wisp' || meta.tier === 'crowd') {
      // Heartbeat + tier-appropriate control messages are accepted (no-op until
      // their handlers land); world GAME_INTENTS are dropped.
      return;
    }

    // --- generic intent (game actions only — resident/director path) ---
    const room = manager.get(meta.roomId);
    if (!room) return;

    // Only forward recognised game intents; unknown `t` values are silently ignored (no crash).
    // NOTE: `pose` and `voice-*` are handled by their own branches above and must
    // NOT be listed here (pose is relayed with sender-exclusion; voice is not a game intent).
    if (!GAME_INTENTS.has(msg.t)) return;
    if (!TIER_POLICY[meta.tier].canSendIntents) return; // director: DIRECTOR_CMD only (C4/C10)

    // --- Task C16 (F6): a LAG-COMPENSATED siege catch --------------------------
    // A resident grab of a live siege meteor that carries a clientTimestamp +
    // grabPoint is validated against the meteor's ~300 ms REWIND ring (a 100 ms-late
    // grab lands). On success the meteor attaches (grabbedBy set → never evicted) and
    // the grab is broadcast; on a failed rewind the client rolls back its predict-
    // attach (a GRAB_REJECTED echo). A grab of a NON-meteor shape falls through to
    // the ordinary Phase B path unchanged.
    if (msg.t === 'grab') {
      // `msg` is a decoded ClientMsg here (validateClientMsg gated it); narrow to the
      // ClientMsg grab shape to read the C16 lag-comp fields (the ServerMsg grab that
      // shares `t:'grab'` has no grabPoint/clientTimestamp).
      const grab = msg as Extract<ClientMsg, { t: 'grab' }>;
      const siege = h.sieges.get(meta.roomId);
      if (
        siege &&
        siege.active &&
        siege.isMeteor(grab.id) &&
        grab.grabPoint !== undefined &&
        grab.clientTimestamp !== undefined
      ) {
        const caught = siege.catch(
          meta.playerId,
          grab.id,
          grab.grabPoint,
          grab.clientTimestamp,
          meta.callsign
        );
        if (caught) {
          h.broadcastEvents(meta.roomId, [{ t: 'grab', id: grab.id, peerId: meta.playerId }], ws);
        } else {
          // Rewind rejected — echo GRAB_REJECTED so the client rolls back.
          h.sendText(ws, { t: 'grab-rejected', id: grab.id, peerId: meta.playerId, by: null });
        }
        return;
      }
    }

    const events = room.applyIntent(meta.playerId, msg as ClientMsg);
    // Task C10 — STATS_CARD source: a RELEASE with a server-computed final velocity
    // (accommodation #5) above THROW_SPEED_MIN counts as a throw for this rotation
    // (callsign only — recordThrow reads the callsign, never the raw name).
    for (const evt of events) {
      if (evt.t === 'grab' && evt.peerId === null && evt.vel) {
        const speed = Math.hypot(evt.vel.x, evt.vel.y, evt.vel.z);
        // C26: feed the caster the throw BEFORE recordThrow updates the day fastest,
        // so a record-beating throw sees the PRIOR record (a real superlative). The
        // callsign (never the raw name) attributes the line + later floor impacts.
        if (meta.callsign) {
          h.getCaster(meta.roomId)?.onEvent({
            kind: 'throw',
            id: evt.id,
            callsign: meta.callsign,
            speed,
          });
        }
        recordThrow(meta.roomId, meta.playerId, speed);
        // Task C16: a RELEASE of a live siege meteor is a THROWBACK — the defender
        // hurls it back at the crowd. Enqueue a `throwback` callout (§7.6 priority
        // catches > throwbacks > swats > hits). The meteor stays a siege meteor.
        const siege = h.sieges.get(meta.roomId);
        if (siege && siege.active && siege.isMeteor(evt.id)) {
          siege.enqueueCallout('throwback', meta.callsign);
        }
      } else if (evt.t === 'grab-rejected' && evt.by) {
        // C26 fix: a losing grab on an already-held shape (Phase B first-claim-wins
        // arbitration, room.ts) is the natural GRAB_DUEL signal (§7.11/§7.15). Feed
        // it attributed to the WINNER — the current holder `by` — since the shape the
        // caster frames is theirs. Rendered only if the holder still has a
        // self-contained callsign; otherwise the caster stays SILENT (no roster
        // needed downstream). The scorer's §7.11 gate + rate limit/quota keep a
        // contested-grab storm from spamming captions.
        const winner = findMetaByPlayerId(meta.roomId, evt.by)?.callsign;
        if (winner) {
          h.getCaster(meta.roomId)?.onEvent({ kind: 'grabDuel', id: evt.id, callsign: winner });
        }
      }
    }
    h.broadcastEvents(meta.roomId, events, ws);
  }

  /**
   * Task C2 — the spectator TEXT-plane send whitelist (spec §5.1 spectator row):
   * heartbeat, stream-subscription control, and the 0x2C REEL family
   * (`reel-*` + `request-snapshot`). Binary opcode frames are gated separately by
   * SPECTATOR_SEND_WHITELIST when the REEL codec lands (C13). All other text is
   * dropped server-side.
   */
  function isSpectatorWhitelistedText(t: string): boolean {
    return t === 'heartbeat' || t === 'request-snapshot' || t.startsWith('reel');
  }

  // ----- Task C22 (F10 Ghost Arcade): the REEL transport handler ------------
  /**
   * Handle a `reel-bank` / `reel-list` / `reel-play` message (spec §7.10). The
   * CAPABILITY GATE (the C4/tier pattern) is enforced HERE, never trusted from the
   * client:
   *   • `reel-bank` (STAFF/cue) needs `meta.director` (a valid ownerToken presented
   *     at join) — an unauthorized bank is REFUSED (`reel-ack {ok:false}`), never a
   *     mutation. Banking materializes the recorder's current best highlight window
   *     into the day-scoped bank.
   *   • `reel-list` / `reel-play` are READ-only — spectator/director scoped (the
   *     stage/staff). A crowd/wisp/audience sender is refused (no reel surface for
   *     the unauthed public plane). `reel-play` drives the ATTRACT ghost playback
   *     (the sanitized reel frames; `reelId` omitted → the most-recent banked reel).
   */
  function handleReel(
    ws: WebSocket,
    meta: SocketMeta,
    msg: Extract<ClientMsg, { t: 'reel-bank' | 'reel-list' | 'reel-play' }>
  ): void {
    // READ capability: the on-site stage/staff plane only (spectator/director, or a
    // director-token holder on any tier). The unauthed public tiers get nothing.
    const canRead =
      meta.tier === 'spectator' || meta.tier === 'director' || meta.director === true;
    // BANK capability: a director (ownerToken) ONLY — the staff/cue mutation gate.
    const canBank = meta.director === true;

    if (msg.t === 'reel-bank') {
      if (!canBank) {
        h.sendText(ws, { t: 'reel-ack', ok: false, reason: 'not-authorized' });
        return;
      }
      const reel = h.recorders.get(meta.roomId)?.bankHighlight() ?? null;
      const summary = reel ? h.bankReel(meta.roomId, reel) : null;
      if (!summary) {
        // Nothing recorded yet — an honest empty ack (no reel to bank), not an error.
        h.sendText(ws, { t: 'reel-ack', ok: false, reason: 'nothing-to-bank' });
        return;
      }
      h.sendText(ws, { t: 'reel-ack', ok: true, reelId: summary.id });
      // Let the requester's menu refresh with the freshly banked reel.
      h.sendText(ws, { t: 'reel-listing', reels: h.listReels(meta.roomId) });
      return;
    }

    if (!canRead) {
      // A read verb from an unauthed plane — silently ignored (never an error, never
      // a leak). Mirrors the spectator-whitelist no-op doctrine.
      return;
    }

    if (msg.t === 'reel-list') {
      h.sendText(ws, { t: 'reel-listing', reels: h.listReels(meta.roomId) });
      return;
    }

    // reel-play: fetch the requested (or most-recent) banked reel to DRIVE the
    // ATTRACT ghost playback. Null when the bank is empty → the client falls back
    // to the scripted day-one shape-ballet.
    const banked = h.getBankedReel(meta.roomId, msg.reelId);
    h.sendText(ws, {
      t: 'reel-data',
      reelId: banked?.id ?? null,
      reel: banked?.reel ?? null,
    });
  }

  // ----- Task C4: DIRECTOR command handler ----------------------------------
  /**
   * Execute a staff DIRECTOR command (spec §5.4). The caller already verified
   * `meta.director` (a valid ownerToken was presented at join). Every mutating
   * incident control (ROTATE_SECRET/ROTATE_LINK) additionally re-verifies the
   * stashed ownerToken through the auth store as a defence-in-depth check.
   */
  async function handleDirectorCmd(
    ws: WebSocket,
    meta: SocketMeta,
    msg: Extract<ClientMsg, { t: 'director-cmd' }>
  ): Promise<void> {
    const roomId = meta.roomId;
    const cmd = msg.cmd;

    switch (cmd) {
      case 'ROTATE_SECRET': {
        if (!authStore || !meta.ownerToken) {
          h.sendText(ws, { t: 'error', code: 'not-authorized', message: 'rotate refused' });
          return;
        }
        const r = await authStore.rotateSecret(roomId, meta.ownerToken);
        if (!r.ok) {
          h.sendText(ws, { t: 'error', code: r.error, message: 'rotate failed' });
          return;
        }
        h.sendText(ws, { t: 'director-ack', cmd, epoch: r.epoch });
        return;
      }

      case 'DOOR_CLOSE': {
        h.doorClosed.add(roomId);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'DOOR_OPEN': {
        h.doorClosed.delete(roomId);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'ROTATE_LINK': {
        if (!authStore || !meta.ownerToken) {
          h.sendText(ws, { t: 'error', code: 'not-authorized', message: 'rotate-link refused' });
          return;
        }
        // Confirm-twice (spec §5.4 last resort): the first call primes; the second
        // (or an explicit `confirm:true`) executes and retires the old id.
        if (!rotateLinkPrimed && msg.confirm !== true) {
          rotateLinkPrimed = true;
          h.sendText(ws, { t: 'director-ack', cmd, confirmRequired: true });
          return;
        }
        rotateLinkPrimed = false;
        const r = await authStore.rotateLink(roomId, meta.ownerToken);
        if (!r.ok) {
          h.sendText(ws, { t: 'error', code: r.error, message: 'rotate-link failed' });
          return;
        }
        // The old id is now retired: serve the moved page + refuse joins. Ack the
        // NEW {roomId, ownerToken} to the staff console ONLY (never broadcast).
        h.sendText(ws, {
          t: 'director-ack',
          cmd,
          newRoomId: r.newRoomId,
          newOwnerToken: r.newOwnerToken,
        });
        return;
      }

      case 'MUTE': {
        if (typeof msg.targetId !== 'string') {
          h.sendText(ws, { t: 'error', code: 'bad-target', message: 'MUTE needs targetId' });
          return;
        }
        let set = h.muted.get(roomId);
        if (!set) {
          set = new Set();
          h.muted.set(roomId, set);
        }
        set.add(msg.targetId);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'UNMUTE': {
        if (typeof msg.targetId === 'string') h.muted.get(roomId)?.delete(msg.targetId);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'KICK': {
        if (typeof msg.targetId !== 'string') {
          h.sendText(ws, { t: 'error', code: 'bad-target', message: 'KICK needs targetId' });
          return;
        }
        const target = findSocketByPlayerId(roomId, msg.targetId);
        if (target) {
          try {
            target.close(1000, 'kicked');
          } catch {
            /* already closing */
          }
        }
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'ROSTER': {
        h.sendText(ws, { t: 'roster', entries: buildRoster(roomId) });
        return;
      }

      // ---- Task C29 (F18 X-Ray Broadcast, spec §7.18) --------------------------

      case 'STAGE_XRAY': {
        // The director-console trigger path (0x22 DIRECTOR family, STAGE_XRAY
        // kind — C1 registry). The stage-LOCAL hotkey is the PRIMARY trigger and
        // never touches the wire; THIS is the secondary path for a separate
        // director console: relay a zero-state toggle pulse to the stage (a
        // `spectator` connection) + any other `director` console — the SAME
        // `broadcastOpcodeToTiers(DIRECTOR, …)` seam PANIC already rides. The
        // stage owns ALL x-ray timing/state locally (auto-revert, ATTRACT
        // precedence); the server is a pure relay, never authoritative over it.
        //
        // The C25 audience boundary needs NO change: `tierAdmits` only ever
        // admits a `director-msg` to the `audience` tier when its kind is
        // 'PANIC' (connection.ts `tierAdmits`), so 'STAGE_XRAY' is excluded by
        // the EXISTING filter — never reaches the 128 anonymous home screens.
        h.broadcastOpcodeToTiers(roomId, OPCODES.DIRECTOR, { kind: 'STAGE_XRAY' }, [
          'spectator',
          'director',
        ]);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      // ---- Task C31 (F20 Neon Clip Machine, spec §7.20) -----------------------

      case 'SAVE_CLIP': {
        // The console's SAVE CLIP override — a zero-state trigger pulse, the SAME
        // shape as STAGE_XRAY above. The stage-LOCAL hotkey is the PRIMARY trigger
        // (zero protocol); this is the secondary console path. The stage owns ALL
        // recording state locally (clipId minting via crypto random, the recorder
        // state machine, the upload) — the server is a pure relay, never
        // authoritative over it, and never sees clip bytes on this channel (the
        // finished blob rides `POST /api/clips`, a SEPARATE HTTP surface).
        //
        // The C25 audience boundary needs NO change: `tierAdmits` only ever admits
        // a `director-msg` to the `audience` tier when its kind is 'PANIC', so
        // 'SAVE_CLIP' is excluded by the EXISTING filter — never reaches the 128
        // anonymous home screens.
        h.broadcastOpcodeToTiers(roomId, OPCODES.DIRECTOR, { kind: 'SAVE_CLIP' }, [
          'spectator',
          'director',
        ]);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      // ---- Task C10: Showrunner controls (the director console + hotkeys) -----

      case 'FIRE': {
        // Fire a CUE_CATALOG cue. `cueInstanceId` is client-generated; the host's
        // registry dedupes on it (§5.5 — a re-sent FIRE is idempotent). The result
        // is echoed back so the console renders wrongPhase/cooldown as a disabled
        // flash and never double-counts.
        const host = h.hosts.get(roomId);
        if (!host) {
          h.sendText(ws, { t: 'error', code: 'no-timeline', message: 'room has no timeline' });
          return;
        }
        const cueId = typeof msg.cueId === 'string' ? msg.cueId : '';
        const cueInstanceId =
          typeof msg.cueInstanceId === 'string' && msg.cueInstanceId.length > 0
            ? msg.cueInstanceId
            : `dir:${meta.playerId}:${timerApi.now()}`;
        // Task C34: the build-mode cue is the desktop world-builder's freeze toggle
        // — it requires the BUILD capability (a RESIDENT-tier connection presenting
        // the ownerToken, spec §5.1/§7.23), stricter than the ownerToken-any-tier
        // DIRECTOR_CMD gate. A stage/spectator ownerToken bearer cannot toggle it.
        if (cueId === 'build-mode' && meta.tier !== 'resident') {
          h.sendText(ws, { t: 'director-msg', kind: 'ACK', fireResult: 'wrongPhase', cueId });
          h.sendText(ws, { t: 'director-ack', cmd });
          return;
        }
        const result = host.fire(cueId, cueInstanceId);
        h.sendText(ws, { t: 'director-msg', kind: 'ACK', fireResult: result, cueId });
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'ADVANCE': {
        // Space = next phase (staff override; ATTRACT→LOBBY on a manual advance).
        h.hosts.get(roomId)?.timeline.advance();
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'FINALE': {
        // F = "fire finale": jump the timeline straight to FINALE (the built-in
        // finale cue SUPERNOVA lands in C11; the F hotkey drives the phase here).
        h.hosts.get(roomId)?.timeline.goTo('FINALE');
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'HOLD': {
        // H = hold +60 s (extend the current timed phase).
        const holdMs = typeof msg.holdMs === 'number' && isFinite(msg.holdMs) ? msg.holdMs : 60_000;
        h.hosts.get(roomId)?.timeline.hold(holdMs);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'RESET': {
        // R = force a rotation RESET now (the safety override). forceReset()
        // despawns the world, reverts params, respawns the baseline — the
        // onWorldReset hook broadcasts the despawn/spawn deltas to peers.
        h.hosts.get(roomId)?.forceReset();
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'TITANIZE': {
        // Task C17 (F7 Titan Protocol, §7.7): one-tap "Titanize the current headset
        // player". The server picks the CURRENT HEADSET PLAYER — a human resident
        // (staff may name one via targetId; else the first human resident). The
        // default (SHOW button) grows to scale 5; the Advanced "bigger" button sends
        // scale:10. One-titan invariant + 30 s auto-revert live in the TitanHost.
        const titan = h.titans.get(roomId);
        const host = h.hosts.get(roomId);
        if (!titan || !host) {
          h.sendText(ws, { t: 'error', code: 'no-titan', message: 'room has no titan host' });
          return;
        }
        // C24 audit fix: humanResidents() excludes synthetic daemons but NOT
        // non-resident tiers — a spectator/director/wisp/crowd/audience human
        // must NEVER be titanized as "the current headset player" (spec §7.7).
        // Restrict the target pool to RESIDENT-tier peers (the actual headset
        // players) by intersecting the roster with the room's resident sockets.
        const residentIds = new Set<string>();
        const roomSockets = h.roomSockets.get(roomId);
        if (roomSockets) {
          for (const s of roomSockets) {
            const rMeta = h.socketMeta.get(s);
            if (rMeta && rMeta.tier === 'resident') residentIds.add(rMeta.playerId);
          }
        }
        const residents = host.handle.humanResidents().filter((p) => residentIds.has(p.id));
        const target =
          (msg.targetId && residents.find((p) => p.id === msg.targetId)?.id) ??
          residents[0]?.id ??
          null;
        if (target === null) {
          h.sendText(ws, { t: 'director-ack', cmd });
          return; // no headset player to titanize — a no-op ack
        }
        const scale = typeof msg.scale === 'number' && isFinite(msg.scale) ? msg.scale : undefined;
        titan.titanize(target, scale !== undefined ? { scale } : {});
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'DETITANIZE': {
        // Task C17: staff manual revert (the safety override — the 30 s auto-revert
        // handles the common case).
        h.titans.get(roomId)?.revert();
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'PANIC': {
        // Task C12 — the staff PANIC HANDLER (spec §6.1). C10 wired the trigger
        // (console key + stage hotkey); the destructive suppression lands HERE:
        //  1. hide the newest N guestbook glyphs (they stay in the bucket —
        //     reversible via clearPanic, not despawned) and broadcast a
        //     `glyph-hide {ids}` so every screen (headset/stage/crowd — and the
        //     audience tier's home screens when C25 lands) drops them at once;
        //  2. broadcast a director PANIC notice so every name surface + the live
        //     caster caption clears (the caster suppression + speechSynthesis.cancel()
        //     hook is C26's — leave the trigger; the caption surface reads this).
        await ensureGuestbook(roomId);
        const hidden = h.glyphs.panic(roomId);
        if (hidden.length > 0) {
          h.broadcast(roomId, { t: 'glyph-hide', ids: hidden.map((g) => g.id) });
        }
        h.broadcast(roomId, { t: 'director-msg', kind: 'PANIC' });
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'GLYPH_DESPAWN': {
        // Task C12 — the staff one-tap despawn cue (spec §7.13 moderation). Remove
        // exactly one glyph by id from the guestbook + broadcast the REMOVE so no
        // client keeps a ghost. Persists the trimmed guestbook.
        if (typeof msg.targetId !== 'string') {
          h.sendText(ws, { t: 'error', code: 'bad-target', message: 'GLYPH_DESPAWN needs targetId' });
          return;
        }
        if (h.glyphs.despawn(roomId, msg.targetId)) {
          h.broadcast(roomId, { t: 'glyph-remove', id: msg.targetId });
          try {
            getBucket('guestbook').scheduleSave(roomId, [...h.glyphs.glyphs(roomId)]);
          } catch {
            /* in-memory only */
          }
        }
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'GLYPH_APPROVAL': {
        // Task C12 — toggle the strict-event approval queue (§7.13). New glyphs
        // land hidden until a staff GLYPH_DESPAWN/approve. `confirm` carries the on/off.
        h.glyphs.setApprovalMode(roomId, msg.confirm === true);
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      case 'NOOP': {
        h.sendText(ws, { t: 'director-ack', cmd });
        return;
      }

      default:
        h.sendText(ws, { t: 'error', code: 'unknown-cmd', message: `unknown director cmd ${cmd}` });
        return;
    }
  }

  // ----- Task C12: the Neon Guestbook glyph handlers ------------------------

  /** Map a stored GlyphEntry → the on-wire GlyphNet (callsign only — §6.1). */
  function toGlyphNetLocal(g: GlyphEntry): GlyphNet {
    return {
      id: g.id,
      callsign: g.callsign,
      points: g.points.map((p) => ({ x: p.x, y: p.y })),
      color: g.color,
      slotIndex: g.slotIndex,
      ...(g.seeded ? { seeded: true } : {}),
    };
  }

  /**
   * Ensure a room's guestbook is loaded from the bucket and pre-seeded with the
   * 50 authored openers if it loaded empty (spec §7.13 — hour-one never empty).
   * Idempotent per room boot (guarded by `glyphRoomsReady`). Best-effort: with no
   * DATA_DIR the bucket load throws and we seed a fresh in-memory guestbook.
   */
  async function ensureGuestbook(roomId: string): Promise<void> {
    if (h.glyphRoomsReady.has(roomId)) return;
    h.glyphRoomsReady.add(roomId); // set first so concurrent joins don't double-seed
    let loaded: GlyphEntry[] = [];
    try {
      loaded = await getBucket('guestbook').load(roomId);
    } catch {
      loaded = [];
    }
    if (loaded.length > 0) {
      h.glyphs.load(roomId, loaded);
    } else {
      // Empty guestbook → seed the 50 authored openers (permanent gallery).
      const n = seedAuthoredGlyphs(h.glyphs, roomId);
      if (n > 0) {
        try {
          getBucket('guestbook').scheduleSave(roomId, [...h.glyphs.glyphs(roomId)]);
        } catch {
          /* in-memory only */
        }
      }
    }
  }

  /** Handle a GLYPH_ADD (validated) — admit via the manager, ack the scribe. */
  async function handleGlyphAdd(
    meta: SocketMeta,
    msg: Extract<ClientMsg, { t: 'glyph-add' }>
  ): Promise<void> {
    // Task C25 review (M1) — the innermost guard: a glyph admission is a
    // world/state/persistence side-effect (room-wide broadcast + guestbook-bucket
    // write). NEVER accept one from a tier other than crowd/resident, no matter
    // how this handler was reached (belt-and-suspenders behind the dispatch gates).
    if (meta.tier !== 'crowd' && meta.tier !== 'resident') return;
    await ensureGuestbook(meta.roomId);
    const result = h.glyphs.submit({
      roomId: meta.roomId,
      // The opaque per-guest key is the peerId (per-connection) — NEVER the IP
      // (spec §7.13 CGNAT). The client localStorage token is the cross-reconnect
      // politeness layer; the server-wide inflow bucket bounds troll throughput.
      guestKey: meta.playerId,
      points: msg.points,
      color: msg.color,
      callsign: meta.callsign,
    });
    const ws = findSocketByPlayerId(meta.roomId, meta.playerId);
    if (result.status === 'ok') {
      // count('glyph') — anonymous counter (§11). onAdmit already broadcast the
      // `glyph` + persisted; ack the scribe privately with {callsign, ring}.
      metricsStore?.count('glyph', meta.tier);
      // The "ring" is the coarse slot band (spiralSlot walks 64 slots per ring).
      const ring = Math.floor(result.glyph.slotIndex / 64);
      if (ws) h.sendText(ws, { t: 'glyph-ack', callsign: meta.callsign, ring });
    } else if (result.status === 'queued') {
      // Overflow QUEUED (not dropped) — tell the scribe it will land shortly.
      if (ws) h.sendText(ws, { t: 'glyph-ack', callsign: meta.callsign, ring: -1 });
    } else if (result.status === 'lifetime-cap') {
      if (ws)
        h.sendText(ws, {
          t: 'error',
          code: 'glyph-cap',
          message: 'you have drawn your glyphs — thanks!',
        });
    }
    // 'invalid' cannot happen here (validateClientMsg already gated the wire).
  }

  // ---------------------------------------------------------------------------
  // Task C34 — F23 The Workshop: BUILD ops + the layouts baseline load (spec §7.23).
  // ---------------------------------------------------------------------------

  /**
   * Load the room's saved layouts baseline into the host so a RESET restores the
   * composed showroom (spec §7.23). Idempotent per room boot (guarded by
   * `layoutsReady`). If a `baselineName` is set and the named layout is present, it
   * is re-baked under DEFAULT_PARAMS and bound as the RESET baseline; otherwise the
   * v1 seed list stays in place (RESET never depends on the Workshop). Best-effort:
   * a bucket read error leaves the v1 fallback in place.
   */
  async function ensureLayouts(roomId: string, host: RoomTimelineHost): Promise<void> {
    if (h.layoutsReady.has(roomId)) return;
    h.layoutsReady.add(roomId);
    // Load the persisted manifest into the in-memory cache (once per room boot). A
    // bucket read error leaves the empty cache in place (the v1 fallback baseline).
    let manifest: LayoutManifest = h.layoutManifests.get(roomId) ?? { layouts: [] };
    try {
      manifest = await getBucket('layouts').load(roomId);
    } catch {
      /* no bucket / read error → keep the (empty) in-memory manifest */
    }
    h.layoutManifests.set(roomId, manifest);
    const baseline =
      manifest.baselineName !== undefined
        ? manifest.layouts.find((l) => l.name === manifest.baselineName)
        : undefined;
    if (!baseline) return; // no saved baseline → v1 fallback stays
    // Re-bake under DEFAULT_PARAMS (the baseline settles under the booth's physics)
    // and bind the seeds. A RESET restores THESE under DEFAULT_PARAMS, ignoring the
    // layout's baseParams/themeId (§D4 invariant — those apply only via LAYOUT_LOAD).
    const baked = settleBake(baseline, DEFAULT_PARAMS);
    host.setShowroomBaseline(layoutToSeeds(baked.layout));
  }

  /**
   * Read the room's saved layouts manifest. The in-memory cache is authoritative
   * (populated by ensureLayouts on boot); it degrades gracefully without a bucket
   * so a BUILD op round-trips even with no disk (tests / LAN-less).
   */
  async function loadLayoutManifest(roomId: string): Promise<LayoutManifest> {
    const cached = h.layoutManifests.get(roomId);
    if (cached) return cached;
    let manifest: LayoutManifest = { layouts: [] };
    try {
      manifest = await getBucket('layouts').load(roomId);
    } catch {
      /* no bucket → empty in-memory manifest */
    }
    h.layoutManifests.set(roomId, manifest);
    return manifest;
  }

  /** Persist a layouts manifest: update the in-memory cache + mirror to the bucket. */
  function saveLayoutManifest(roomId: string, manifest: LayoutManifest): void {
    h.layoutManifests.set(roomId, manifest);
    try {
      getBucket('layouts').scheduleSave(roomId, manifest);
    } catch {
      /* in-memory only (tests / LAN-less without a data dir) */
    }
  }

  /** Send a BUILD ACK to one socket (echoes opId + assigned id + result). */
  function sendBuildAck(
    ws: WebSocket,
    opId: string | undefined,
    result: string,
    id?: string
  ): void {
    h.sendText(ws, {
      t: 'build-msg',
      kind: BUILD_KIND.ACK,
      ...(opId !== undefined ? { opId } : {}),
      ...(id !== undefined ? { id } : {}),
      result,
    });
  }

  /**
   * Coerce a wire `shape` payload into a validated LayoutShape (SPAWN_EXACT /
   * SET_TRANSFORM). Reuses the shared, pure `validateLayout` on a one-shape layout
   * so the wire boundary and the layout admission agree exactly. Returns null on
   * any malformation (the handler NACKs).
   */
  function coerceLayoutShape(raw: unknown): LayoutShape | null {
    const probe = validateLayout(
      { name: 'x', author: '', savedAt: 0, shapes: [raw] },
      false
    );
    return probe.ok ? probe.layout.shapes[0] : null;
  }

  /**
   * Handle a BUILD op (spec §7.23). The whole family is CAPABILITY-GATED: only a
   * `resident`-tier connection presenting the ownerToken (meta.director) may build
   * (§5.1). The MUTATING kinds (SET_TRANSFORM / SPAWN_EXACT / DELETE / LAYOUT_LOAD)
   * are ADDITIONALLY refused unless build-mode is ACTIVE — THE key safety (§7.23):
   * a stale tab with the capability can never wipe a live rotation.
   */
  async function handleBuild(
    ws: WebSocket,
    meta: SocketMeta,
    msg: Extract<ClientMsg, { t: 'build' }>
  ): Promise<void> {
    // (1) CAPABILITY gate: resident-tier + a valid ownerToken → BUILD (spec §5.1).
    //     Any other connection is refused (never trust a client tier claim).
    if (meta.tier !== 'resident' || !meta.director) {
      sendBuildAck(ws, msg.opId, 'no-capability');
      return;
    }
    // (2) Light rate limit (the C4 pattern) — a runaway builder is bounded.
    const bucket = (meta.buildBucket ??= new TokenBucket(
      BUILD_RATE_REFILL_PER_SEC,
      BUILD_RATE_BURST,
      () => timerApi.now()
    ));
    if (!bucket.take()) {
      sendBuildAck(ws, msg.opId, 'rate-limited');
      return;
    }

    const room = manager.get(meta.roomId);
    if (!room) {
      sendBuildAck(ws, msg.opId, 'no-room');
      return;
    }
    const host = h.hosts.get(meta.roomId);

    // (3) The MUTATING kinds require build-mode ACTIVE (the stale-tab safety, §7.23).
    const mutating =
      msg.kind === BUILD_KIND.SET_TRANSFORM ||
      msg.kind === BUILD_KIND.SPAWN_EXACT ||
      msg.kind === BUILD_KIND.DELETE ||
      msg.kind === BUILD_KIND.LAYOUT_LOAD ||
      msg.kind === BUILD_KIND.LAYOUT_DELETE;
    if (mutating && !host?.buildModeActive) {
      // Server-side refusal — a stale tab can NEVER wipe a live rotation.
      sendBuildAck(ws, msg.opId, 'not-in-build-mode');
      return;
    }

    switch (msg.kind) {
      case BUILD_KIND.SPAWN_EXACT: {
        const shape = coerceLayoutShape(msg.shape);
        if (!shape) {
          sendBuildAck(ws, msg.opId, 'bad-shape');
          return;
        }
        const res = room.world.spawn({
          type: shape.type,
          position: shape.position,
          colorIndex: shape.colorIndex,
          renderMode: shape.renderMode,
          scale: shape.scale,
          ...(shape.bobPhase !== undefined ? { bobPhase: shape.bobPhase } : {}),
          ...(shape.rotSpeed !== undefined ? { rotSpeed: shape.rotSpeed } : {}),
        });
        if (!res) {
          sendBuildAck(ws, msg.opId, 'spawn-rejected');
          return;
        }
        h.broadcast(meta.roomId, { t: 'spawn', shape: res.shape });
        if (res.evictedId !== null) h.broadcast(meta.roomId, { t: 'despawn', id: res.evictedId });
        // ACK carries the ASSIGNED shape id (undo correlation — spec §7.23).
        sendBuildAck(ws, msg.opId, 'ok', res.shape.id);
        return;
      }
      case BUILD_KIND.SET_TRANSFORM: {
        const id = msg.id;
        const target = typeof id === 'string' ? room.world.get(id) : undefined;
        if (!target) {
          sendBuildAck(ws, msg.opId, 'no-shape');
          return;
        }
        const patch = coerceLayoutShape(msg.shape);
        if (!patch) {
          sendBuildAck(ws, msg.opId, 'bad-shape');
          return;
        }
        // Apply the EXACT transform (position/rotation/scale) + optional render
        // fields. Velocity is zeroed — a placed shape is at rest (a build is static).
        target.position = { ...patch.position };
        target.rotation = { ...patch.rotation };
        target.velocity = { x: 0, y: 0, z: 0 };
        target.scale = patch.scale;
        target.colorIndex = patch.colorIndex;
        target.renderMode = patch.renderMode;
        // Broadcast the moved shape as an ordinary spawn (a full re-send of the
        // authoritative shape — clients re-key on id, matching the spawn path).
        h.broadcast(meta.roomId, { t: 'spawn', shape: { ...target } });
        sendBuildAck(ws, msg.opId, 'ok', target.id);
        return;
      }
      case BUILD_KIND.DELETE: {
        const id = msg.id;
        if (typeof id !== 'string' || !room.world.get(id)) {
          sendBuildAck(ws, msg.opId, 'no-shape');
          return;
        }
        room.world.remove(id);
        h.broadcast(meta.roomId, { t: 'despawn', id });
        sendBuildAck(ws, msg.opId, 'ok', id);
        return;
      }
      case BUILD_KIND.GLYPH_SEED: {
        // Authored glyph seed: bypasses the C12 inflow bucket + lifetime cap, marks
        // seeded:true (evict-exempt), refused past SEEDED_GLYPH_CAP (spec §7.23).
        await ensureGuestbook(meta.roomId);
        if (!Array.isArray(msg.points) || typeof msg.color !== 'string') {
          sendBuildAck(ws, msg.opId, 'bad-glyph');
          return;
        }
        const glyph = h.glyphs.seed({
          roomId: meta.roomId,
          points: msg.points,
          color: msg.color,
          callsign: meta.callsign,
        });
        if (!glyph) {
          // Invalid stroke OR the seeded-glyph cap is full (§7.23 SEEDED_GLYPH_CAP).
          sendBuildAck(ws, msg.opId, 'seed-refused');
          return;
        }
        h.broadcast(meta.roomId, { t: 'glyph', glyph: toGlyphNetLocal(glyph) });
        try {
          getBucket('guestbook').scheduleSave(meta.roomId, [...h.glyphs.glyphs(meta.roomId)]);
        } catch {
          /* in-memory only */
        }
        sendBuildAck(ws, msg.opId, 'ok', glyph.id);
        return;
      }
      case BUILD_KIND.LAYOUT_SAVE: {
        // Bake the LIVE world into a named layout + persist it (spec §7.23). The
        // count cap (~32) is enforced here — refuse + manual delete past it.
        const name = typeof msg.name === 'string' ? msg.name : '';
        if (name.length === 0 || name.length > 64) {
          sendBuildAck(ws, msg.opId, 'bad-name');
          return;
        }
        const manifest = await loadLayoutManifest(meta.roomId);
        const existingIdx = manifest.layouts.findIndex((l) => l.name === name);
        if (existingIdx === -1 && manifest.layouts.length >= LAYOUT_COUNT_CAP) {
          sendBuildAck(ws, msg.opId, 'layout-cap');
          return;
        }
        const layout = worldToLayout(room, name, meta.callsign, timerApi.now());
        // BAKE the composition so a load/restore lands it at rest (spec §7.23 BAKE).
        const baked = settleBake(layout, DEFAULT_PARAMS).layout;
        if (existingIdx === -1) manifest.layouts.push(baked);
        else manifest.layouts[existingIdx] = baked; // overwrite (last-write-wins)
        saveLayoutManifest(meta.roomId, manifest);
        sendBuildAck(ws, msg.opId, 'ok', name);
        return;
      }
      case BUILD_KIND.LAYOUT_LOAD: {
        // DESTRUCTIVE (spec §7.23): clear the live world + restore a named layout.
        // The ONLY path that applies the layout's baseParams (a standing-law write)
        // + themeId (THEME_SET) — a RESET never does (§D4). Requires build-mode
        // (gated above as a mutating kind).
        const name = typeof msg.name === 'string' ? msg.name : '';
        const manifest = await loadLayoutManifest(meta.roomId);
        const layout = manifest.layouts.find((l) => l.name === name);
        if (!layout) {
          sendBuildAck(ws, msg.opId, 'no-layout');
          return;
        }
        loadLayoutIntoRoom(room, meta.roomId, layout, host);
        sendBuildAck(ws, msg.opId, 'ok', name);
        return;
      }
      case BUILD_KIND.SET_BASELINE: {
        // Validate + re-bake a layout under DEFAULT_PARAMS + bind it as the RESET
        // baseline (spec §7.23). Uses the named saved layout, or an inline `layout`
        // payload (the import tool path). Validated as a BASELINE (the reserve cap).
        const name = typeof msg.name === 'string' ? msg.name : undefined;
        const manifest = await loadLayoutManifest(meta.roomId);
        let candidate: unknown;
        if (msg.layout !== undefined) candidate = msg.layout;
        else if (name !== undefined) candidate = manifest.layouts.find((l) => l.name === name);
        const v = validateLayout(candidate, true); // BASELINE cap (MAX_SHAPES − METEOR_BUDGET)
        if (!v.ok) {
          sendBuildAck(ws, msg.opId, `baseline-invalid:${v.reason}`);
          return;
        }
        // Re-bake under DEFAULT_PARAMS (the baseline settles under the booth physics).
        const baked = settleBake(v.layout, DEFAULT_PARAMS).layout;
        // Persist: store the baked layout + mark it the baseline (upsert by name).
        const idx = manifest.layouts.findIndex((l) => l.name === baked.name);
        if (idx === -1) {
          if (manifest.layouts.length >= LAYOUT_COUNT_CAP) {
            sendBuildAck(ws, msg.opId, 'layout-cap');
            return;
          }
          manifest.layouts.push(baked);
        } else {
          manifest.layouts[idx] = baked;
        }
        manifest.baselineName = baked.name;
        saveLayoutManifest(meta.roomId, manifest);
        // Bind it as the live RESET baseline (takes effect on the NEXT RESET). The
        // RESET restores these under DEFAULT_PARAMS, ignoring baseParams/themeId.
        host?.setShowroomBaseline(layoutToSeeds(baked));
        sendBuildAck(ws, msg.opId, 'ok', baked.name);
        return;
      }
      case BUILD_KIND.LAYOUT_LIST: {
        // The saved-layout manifest (names + counts + baseline flag) — the builder's
        // load menu. A pure READ (never mutating → no build-mode requirement).
        const manifest = await loadLayoutManifest(meta.roomId);
        h.sendText(ws, {
          t: 'build-msg',
          kind: BUILD_KIND.LAYOUT_LIST,
          ...(msg.opId !== undefined ? { opId: msg.opId } : {}),
          layouts: manifest.layouts.map((l) => ({
            name: l.name,
            shapeCount: l.shapes.length,
            baseline: l.name === manifest.baselineName,
          })),
        });
        return;
      }
      case BUILD_KIND.LAYOUT_DELETE: {
        // Carry #8 (spec §7.23): remove a named saved layout from the manifest.
        // MUTATING (gated above — build-mode + capability, the stale-tab safety).
        // Deleting an id that isn't present is a SAFE NO-OP (idempotent — the end
        // state the caller wants, "this name is gone", already holds).
        const name = typeof msg.name === 'string' ? msg.name : '';
        const manifest = await loadLayoutManifest(meta.roomId);
        const idx = manifest.layouts.findIndex((l) => l.name === name);
        if (idx === -1) {
          sendBuildAck(ws, msg.opId, 'ok', name);
          return;
        }
        manifest.layouts.splice(idx, 1);
        // If the deleted layout WAS the bound RESET baseline, CLEAR it (the safest
        // option, spec §7.23) — falls back to the v1 SHOWROOM_BASELINE seed list
        // rather than leaving a dangling reference to a layout that no longer
        // exists. RESET never depends on the Workshop (Tier 0 invariant).
        if (manifest.baselineName === name) {
          manifest.baselineName = undefined;
          host?.setShowroomBaseline(null);
        }
        saveLayoutManifest(meta.roomId, manifest);
        sendBuildAck(ws, msg.opId, 'ok', name);
        return;
      }
      default:
        sendBuildAck(ws, msg.opId, 'unknown-kind');
        return;
    }
  }

  /** Snapshot the live world into a Layout (LAYOUT_SAVE — the exact authored transforms). */
  function worldToLayout(room: Room, name: string, author: string, savedAt: number): Layout {
    const shapes: LayoutShape[] = room.worldShapes.map((s) => ({
      type: s.type,
      colorIndex: s.colorIndex,
      renderMode: s.renderMode,
      scale: s.scale,
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      rotation: { x: s.rotation.x, y: s.rotation.y, z: s.rotation.z },
      bobPhase: s.bobPhase,
      rotSpeed: { x: s.rotSpeed.x, y: s.rotSpeed.y, z: s.rotSpeed.z },
    }));
    return { name, author, savedAt, shapes };
  }

  /**
   * Destructively load a layout into a room (LAYOUT_LOAD, spec §7.23). Clears the
   * live world, spawns the layout's shapes at their exact transforms, and — UNLIKE
   * a RESET — applies the layout's `baseParams` (a standing-law write) + `themeId`
   * (a THEME_SET). This is the ONLY path those authored fields take (§D4). Broadcast
   * as ordinary despawn/spawn ServerMsgs (accommodation #8 — never leave ghosts).
   */
  function loadLayoutIntoRoom(
    room: Room,
    roomId: string,
    layout: Layout,
    host: RoomTimelineHost | undefined
  ): void {
    // Clear the live world.
    const removedIds = room.worldShapes.map((s) => s.id);
    for (const id of removedIds) room.world.remove(id);
    for (const id of removedIds) h.broadcast(roomId, { t: 'despawn', id });
    // Spawn the layout's shapes at their exact transforms.
    for (const s of layout.shapes) {
      const res = room.world.spawn({
        type: s.type,
        position: s.position,
        colorIndex: s.colorIndex,
        renderMode: s.renderMode,
        scale: s.scale,
        ...(s.bobPhase !== undefined ? { bobPhase: s.bobPhase } : {}),
        ...(s.rotSpeed !== undefined ? { rotSpeed: s.rotSpeed } : {}),
      });
      if (res) h.broadcast(roomId, { t: 'spawn', shape: res.shape });
    }
    // LAYOUT_LOAD applies baseParams (standing law) + themeId (THEME_SET) — the ONLY
    // path (§D4). A RESET never does. Absent fields leave the current law/theme.
    // Carry #7: NORMALIZE to a COMPLETE PhysicsParams — validateLayout only checks
    // baseParams is a plain object (schema-shallow, spec §7.23), so a hand-authored
    // PARTIAL baseParams (e.g. only `gravity`) must never write an incomplete param
    // set (every OTHER field would read `undefined` instead of its DEFAULT_PARAMS
    // value). SAVE always bakes a full set (SAVE→LOAD stays a no-op here).
    if (layout.baseParams !== undefined)
      host?.setBaseParams({ ...DEFAULT_PARAMS, ...layout.baseParams });
    if (layout.themeId !== undefined) h.themeChannels.get(roomId)?.setTheme(layout.themeId);
  }

  /** Find the live socket for a playerId in a room (KICK / targeted ops). */
  function findSocketByPlayerId(roomId: string, playerId: string): WebSocket | undefined {
    const sockets = h.roomSockets.get(roomId);
    if (!sockets) return undefined;
    for (const s of sockets) {
      const m = h.socketMeta.get(s);
      if (m && m.playerId === playerId) return s;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Task C10 — the live Showrunner (RoomTimelineHost) lifecycle + roster/stats.
  // ---------------------------------------------------------------------------

  /**
   * Task C28 (F17 Daemon Crew): the number of HUMAN residents in a room. Daemons
   * have NO socket, so counting resident-tier SOCKETS is inherently synthetic-blind
   * — a daemon never inflates this. Drives the dismissal triggers (≥2 / last-departs)
   * and the ship-gated lone-visitor auto-summon.
   */
  function humanResidentCount(roomId: string): number {
    const sockets = h.roomSockets.get(roomId);
    if (!sockets) return 0;
    let n = 0;
    for (const s of sockets) {
      const m = h.socketMeta.get(s);
      if (m && m.tier === 'resident') n++;
    }
    return n;
  }

  /**
   * Task C28: the human-resident aim targets a daemon lobs toward (head + live hand
   * world positions), built from the latest relayed resident poses. ONLY humans are
   * present (daemon poses bypass the socket pose path, so `lastResidentPose` never
   * holds a daemon) — the chest-offset return target is always a real head (§7.17).
   */
  function daemonHumanTargets(roomId: string): DaemonHumanTarget[] {
    const poses = h.lastResidentPose.get(roomId);
    if (!poses) return [];
    const targets: DaemonHumanTarget[] = [];
    for (const [id, pose] of poses) {
      const hands = pose.hands.filter((hd): hd is NonNullable<typeof hd> => hd !== null).map((hd) => hd.p);
      targets.push({ id, head: pose.head.p, hands });
    }
    return targets;
  }

  /** Build the host-facing PeerInfo roster (every live SOCKET peer). C28: daemons are
   *  socketless, so they never appear here — humanResidents()/roster() stay human. */
  function buildPeerRoster(roomId: string): PeerInfo[] {
    const sockets = h.roomSockets.get(roomId);
    if (!sockets) return [];
    const peers: PeerInfo[] = [];
    for (const s of sockets) {
      const m = h.socketMeta.get(s);
      if (!m) continue;
      // DMN- callsigns are synthetic (§7.17); real peers are unflagged.
      const synthetic = m.callsign.startsWith('DMN-');
      peers.push({ id: m.playerId, name: m.callsign, color: 0, ...(synthetic ? { synthetic } : {}) });
    }
    return peers;
  }

  /**
   * Compute the STATS_CARD for a room (spec §7.2 — CALLSIGNS ONLY). Rotation
   * highlights come from the per-rotation throw stats; the day leaderboard from
   * the `dayStats` bucket (persisted, survives restart). The "NEXT IN THE HEADSET?"
   * queue-bridge line is a fixed prompt (never a name).
   */
  function computeStatsCardFor(roomId: string): StatsCard {
    const stats = h.throwStats.get(roomId) ?? newThrowStats();
    // Top contributor = the callsign with the most throws this rotation. Task C28
    // (§7.17): synthetic DMN- peers are EXCLUDED from the leaderboard/queue bridge —
    // a daemon that lobbed a shape never appears as a "top contributor".
    let topContributor: StatsRow | null = null;
    for (const [callsign, count] of stats.byCallsign) {
      if (callsign.startsWith('DMN-')) continue; // daemon — off the human leaderboard
      if (!topContributor || count > topContributor.value) {
        topContributor = { callsign, value: count };
      }
    }
    // The rotation fastest is likewise human-only (a daemon lob never headlines).
    const fastestThrow: StatsRow | null =
      stats.fastest && !stats.fastest.callsign.startsWith('DMN-')
        ? { callsign: stats.fastest.callsign, value: Math.round(stats.fastest.speedMs * 10) / 10 }
        : null;

    // Day leaderboard from the persisted dayStats bucket (callsigns only). The
    // bucket may not be initialised (tests without buckets) — guard defensively.
    let dayLeaderboard: StatsRow[] = [];
    try {
      const day = getBucket('dayStats').getCallsignsTaken(roomId);
      // The bucket's schema tracks fastestThrow/topContributor; expose the top
      // contributor as the one persisted leaderboard row we have today (C15/C25
      // extend this). Fall back to the taken-set count as a participation stat.
      // Task C28: strip any synthetic DMN- peer from the leaderboard rows (§7.17).
      dayLeaderboard = excludeDaemons(
        [...day].slice(0, 5).map((callsign) => ({ callsign, value: 0 }))
      );
    } catch {
      // buckets not initialised — no day leaderboard (still a valid card).
      dayLeaderboard = [];
    }

    return {
      shapesThrown: stats.shapesThrown,
      fastestThrow,
      topContributor,
      dayLeaderboard,
      // Task C28 (§7.17 / §6.1): the queue bridge renders a FIXED prompt, NEVER a
      // roster name — so a "DMN-03 NEXT IN THE HEADSET?" line is IMPOSSIBLE.
      nextInHeadset: QUEUE_BRIDGE_PROMPT,
    };
  }

  /**
   * Record a throw for the STATS_CARD (a release above THROW_SPEED_MIN). Callsign
   * only — never the raw name. Called from the release intent path.
   */
  function recordThrow(roomId: string, playerId: string, speedMs: number): void {
    if (speedMs < THROW_SPEED_MIN) return;
    const meta = findMetaByPlayerId(roomId, playerId);
    const callsign = meta?.callsign;
    if (!callsign) return;
    let stats = h.throwStats.get(roomId);
    if (!stats) {
      stats = newThrowStats();
      h.throwStats.set(roomId, stats);
    }
    stats.shapesThrown++;
    stats.byCallsign.set(callsign, (stats.byCallsign.get(callsign) ?? 0) + 1);
    if (!stats.fastest || speedMs > stats.fastest.speedMs) {
      stats.fastest = { callsign, speedMs };
    }
    // C26 fix: ALSO record into the DAY-scoped bucket (survives rotation RESET) —
    // the source of truth for the caster's "FASTEST THROW TODAY" superlative
    // (§7.15). The rotation-scoped `stats.fastest` above is cleared every RESET, so
    // reading it for the record produced a FALSE cross-rotation claim (a slower
    // rotation-2 throw announced as the day's fastest). The dayStats bucket does not
    // clear on RESET. Guarded — buckets may be uninitialised in unit tests, exactly
    // as `computeStatsCardFor` guards its dayStats read.
    try {
      getBucket('dayStats').recordFastestThrow(roomId, callsign, speedMs);
    } catch {
      // buckets not initialised — the caster's dayRecord() read is likewise guarded.
    }
  }

  function findMetaByPlayerId(roomId: string, playerId: string): SocketMeta | undefined {
    const s = findSocketByPlayerId(roomId, playerId);
    return s ? h.socketMeta.get(s) : undefined;
  }

  /**
   * Ensure the room's Showrunner (RoomTimelineHost) exists. Idempotent — created
   * once when a room gains its first socket. Registers the C10 seed cues, wires
   * the PHASE_STATE/CUE_CATALOG/STATS_CARD fan-out (the widen: director + resident
   * + spectator), and routes cue/rotation world deltas out as ordinary spawn/
   * despawn ServerMsgs (accommodation #8). The single-overlay host's effectiveParams
   * is consumed by the sim loop in index.ts.
   */
  function ensureHost(room: Room): RoomTimelineHost {
    const existing = h.hosts.get(room.roomId);
    if (existing) return existing;
    const host = new RoomTimelineHost({
      timer: timerApi,
      world: room.world,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
      roster: () => buildPeerRoster(room.roomId),
      // The host only ever counts 'rotation' (the RESET rotation boundary); count
      // it as a real-peer event. Any other key is ignored (the metrics union is
      // closed — the host never emits one).
      ...(metricsStore
        ? { metricsCount: (k: string) => { if (k === 'rotation') metricsStore.count('rotation'); } }
        : {}),
      onWorldReset: (removedIds, spawned) => {
        // Rotation boundary: broadcast the world delta as ordinary despawn/spawn
        // ServerMsgs (accommodation #8 — never leave ghost shapes). Also reset the
        // per-rotation throw stats.
        for (const id of removedIds) h.broadcast(room.roomId, { t: 'despawn', id });
        for (const shape of spawned) h.broadcast(room.roomId, { t: 'spawn', shape });
        h.throwStats.set(room.roomId, newThrowStats());
        // C26: the caster is rotation-scoped — RESET clears streaks/LRU/quota/window
        // (a rotation-1 callsign is never referenced after RESET unless it holds a
        // day-stats record; that path reads throwStats, cleared just above).
        h.casters.get(room.roomId)?.reset();
        // C28: a RESET rotation boundary DISMISSES the daemon crew (§7.17 dismissal
        // trigger) — releasing any held shape via the standard disconnect.
        h.daemons.get(room.roomId)?.onReset();
        // C32: a RESET releases every TK pull (unpin) — the world is being reset, so
        // a mid-pull pinned shape must not survive the despawn/respawn (§7.21).
        h.powersLabs.get(room.roomId)?.reset();
        // C22 (carry #5, defensive): a RESET also clears the election's base-params
        // undo stack — the standing law is already reverted to DEFAULT_PARAMS above
        // (RoomTimelineHost._runReset); a pre-RESET law must never be restorable by
        // a (currently unwired, defensive) revert() after the rotation boundary.
        h.elections.get(room.roomId)?.clearBaseHistory();
      },
      onCueWorldDelta: (spawned, removedIds) => {
        // A cue (shape-rain) mutated the world through the store: broadcast it.
        for (const shape of spawned) h.broadcast(room.roomId, { t: 'spawn', shape });
        for (const id of removedIds) h.broadcast(room.roomId, { t: 'despawn', id });
        // C26 fix: a cue spawn burst is the natural SHAPE_RAIN signal (§7.15). Feed
        // each cue-spawned shape as a `spawn` event — the shared scorer only surfaces
        // SHAPE_RAIN once the burst clears `shapeRainMin` (8 = the shape-rain cue's
        // SHAPE_RAIN_BURST), so a small cue spawn stays SILENT. The rotation RESET
        // respawn does NOT flow through this path (it spawns on ServerWorld directly,
        // not the store view), so a rotation boundary never fakes a shape storm.
        const caster = h.casters.get(room.roomId);
        if (caster) for (const shape of spawned) caster.onEvent({ kind: 'spawn', id: shape.id });
      },
      computeStatsCard: () => computeStatsCardFor(room.roomId),
      // C34 (F23 The Workshop): broadcast the build-mode state on enter/exit to the
      // build-mode residents + director so a second builder tab / the console sees
      // it. On EXIT the freeze reverts (handled by the host); a staff RESET exit
      // discards unsaved edits (spec §7.23).
      onBuildModeChange: (active) => {
        h.broadcastOpcodeToTiers(
          room.roomId,
          OPCODES.BUILD,
          { kind: BUILD_KIND.ACK, buildModeActive: active },
          ['resident', 'spectator', 'director']
        );
      },
    });
    // C11: advertise the FULL Reality-Dials bank (the two seeds + six compound
    // cues), each id exactly once (spec §7.3). The console renders whatever is
    // advertised — no hard dependency on any sibling feature.
    registerDialCues(host.registry);
    // C34 (F23): advertise the build-mode cue (Advanced tab, ATTRACT/LOBBY). Firing
    // it is CAPABILITY-GATED at the BUILD dispatch (resident + ownerToken); the
    // advertisement itself is harmless (a non-owner's fire is refused).
    registerBuildModeCue(host.registry);
    h.hosts.set(room.roomId, host);
    // C34 (F23): load the room's saved baseline layout (if any) into the host so a
    // RESET restores the composed showroom, not the v1 seed list. Fire-and-forget:
    // if it fails or there is no baseline, the v1 fallback is already in place.
    void ensureLayouts(room.roomId, host);
    // C20: the F9 Reality Channels theme host — owns the ACTIVE THEME + the
    // THEME_SET broadcast (0x24, JSON-after-preamble). Created BEFORE the election
    // so the election's `enactTheme` hook can flip the reality on a theme-vote win.
    // Standalone: a room with no theme votes still runs on the default channel.
    const themeChannel = new ThemeChannelHost({
      timer: timerApi,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
    });
    h.themeChannels.set(room.roomId, themeChannel);
    // C15: the F5 Reality Referendum election host — runs the pure reducer over the
    // SAME RoomHandle. On ENACT it tops the world up to the legibility band FIRST,
    // then writes the elected dial law into baseParams (survives dial firings +
    // rotations per C11 until re-elected / reverted / RESET). One switchable vote
    // per token; VOTE_TALLY coalesced to 2 Hz (never a per-vote storm).
    //
    // C20: the theme options register INTO THIS SAME POOL (ordinary §7.5 elections
    // — no second vote path). A THEME-namespaced winner routes to `enactTheme`
    // (→ setTheme / THEME_SET) instead of `setBaseParams` — a theme vote flips the
    // reality, it never rewrites the physics law.
    const election = new ElectionHost({
      timer: timerApi,
      handle: host.handle,
      options: [...ELECTION_DIAL_OPTIONS, ...themeElectionOptions()],
      dialLaw,
      enactTheme: (themeId) => themeChannel.setTheme(themeId),
      readBaseParams: () => host.baseParams,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
      ...(metricsStore
        ? { metricsCount: (k: string) => { if (k === 'vote') metricsStore.count('vote'); } }
        : {}),
    });
    election.open();
    h.elections.set(room.roomId, election);
    // C16: the F6 Meteor Siege host — composed over the SAME RoomHandle. Spawns
    // (crystal + meteors) ride the store's onCueWorldDelta broadcast (accommodation
    // #8), so the crystal + every meteor reach peers as ordinary spawn/despawn. The
    // siege owns SHOWPIECE broadcasts (START/STATE/END) + the callout queue.
    const siege = new SiegeHost({
      timer: timerApi,
      world: room.world,
      handle: host.handle,
      host,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
      ...(metricsStore
        ? { metricsCount: (k: string) => { if (k === 'showpiece') metricsStore.count('showpiece'); } }
        : {}),
    });
    h.sieges.set(room.roomId, siege);
    // C17: the F7 Titan Protocol host — composed over the SAME RoomHandle/world. It
    // broadcasts PLAYER_SCALE (0x28), enforces the one-titan invariant + the 30 s
    // auto-revert (incl. disconnect), applies the giant's hand impulses, and owns the
    // titan-scoped OOB recall the sim loop runs BEFORE honoring the physics `removed`.
    const titan = new TitanHost({
      timer: timerApi,
      world: room.world,
      handle: host.handle,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
      ...(metricsStore
        ? { metricsCount: (k: string) => { if (k === 'showpiece') metricsStore.count('showpiece'); } }
        : {}),
    });
    h.titans.set(room.roomId, titan);
    // C32: the F21 Powers Lab telekinesis host — composed over the SAME world +
    // RoomHandle. It applies the per-tick pull LOOP FORCE (the C17 titan pattern —
    // NOT a PhysicsParams change), owns every safety rail (250 ms dead-man, pin/
    // unpin, cone-excludes-grabbed+pinned, ≤ 2 pulls, one-TK-player + disconnect
    // revert, contested→human, speed cap), and broadcasts the stage tether (server
    // knows anchor + target — NO joint streaming). The powers-lab CUE is NOT
    // registered here — it registers lazily on TK_HANDS_STATE only when
    // (hands reported ∧ POWERS_LAB_ENABLED), per the §7.21 capability gate.
    const powersLab = new PowersLabHost({
      timer: timerApi,
      world: room.world,
      handle: host.handle,
      broadcast: (opcode, payload, tiers) =>
        h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers),
      telekinesisOpcode: OPCODES.TELEKINESIS,
    });
    h.powersLabs.set(room.roomId, powersLab);
    // C22.5 hardening: ORDER-INDEPENDENCE for the capability latch. In today's
    // wiring `ensureHost` (and so this `powersLabs.set`) always runs synchronously
    // within the SAME join handshake that must complete before any TK_HANDS_STATE
    // for this room can even be sent, so hands-reported-before-the-lab-exists
    // cannot occur via the live socket path. This call is a cheap, IDEMPOTENT
    // defensive re-check (`maybeRegisterPowersLabCue` no-ops unless the latch is
    // already true) that keeps that guarantee even if a future refactor reorders
    // room setup — the latch is never permanently missed just because the lab
    // didn't exist yet at the moment hands were reported.
    // C22.5 hardening: ORDER-INDEPENDENCE for the capability latch. In today's
    // wiring `ensureHost` (and so this `powersLabs.set`) always runs synchronously
    // within the SAME join handshake that must complete before any TK_HANDS_STATE
    // for this room can even be sent, so hands-reported-before-the-lab-exists
    // cannot occur via the live socket path. This call is a cheap, IDEMPOTENT
    // defensive re-check (`maybeRegisterPowersLabCue` no-ops unless the latch is
    // already true) that keeps that guarantee even if a future refactor reorders
    // room setup — the latch is never permanently missed just because the lab
    // didn't exist yet at the moment hands were reported.
    maybeRegisterPowersLabCue(room.roomId);
    // C22 (F10 Ghost Arcade): the per-room ReelRecorder — the PASSIVE tee sink for
    // the room's outbound broadcast stream (record-time sanitized — server-assigned
    // callsigns/GHOST_XX only, ALL 0x1x voice EXCLUDED, §6.1/§7.10). Owned like the
    // sibling hosts (created with the room's host, disposed + auto-banked on empty).
    // Deterministic on the injected timerApi clock (the SAME clock the sim loop +
    // hosts stamp), so banking windows align with the wire timestamps. Idempotent:
    // a re-created room (attract permalink) gets a fresh recorder; the day-scoped
    // reel BANK is separate (survives teardown) so the ghosts still have content.
    if (!h.recorders.has(room.roomId)) {
      h.recorders.set(room.roomId, new ReelRecorder({ now: () => timerApi.now() }));
    }
    // C18: the F8 Resonora Conductor — scores floor impacts into MUSIC_NOTE events
    // and emits MUSIC_CLOCK (~1 Hz), both binary Appendix B frames via the C1
    // golden codec. Its musical clock is roomEpoch-relative (matching the u32 wire
    // timestamps); the backing layer is seeded from the STABLE room seed so every
    // client renders the identical backing bar. A sibling host: the sim loop feeds
    // it, but the tick never depends on it (cut-safe). MUSIC is binary → it
    // broadcasts through broadcastBinaryToTiers (raw frame), not the JSON path.
    const roomEpoch = h.getRoomEpoch(room.roomId);
    const conductor = new Conductor({
      roomSeed: roomSeedFor(room.roomId),
      bpm: 120,
      gridOriginMs: 0, // roomEpoch-relative: grid origin = the room epoch base
      serverNow: () => Math.max(0, timerApi.now() - roomEpoch),
      broadcast: (_opcode, payload, tiers) =>
        h.broadcastBinaryToTiers(room.roomId, payload as ArrayBuffer, tiers),
    });
    h.conductors.set(room.roomId, conductor);
    // C26: the F15 MC NULL caster host — turns the room's own event stream (throws
    // + joins from the intent/join handlers, floor impacts + the live showpiece
    // flag from the sim loop) into procedural CASTER_LINE (0x33) captions via the
    // C1 golden codec. SILENCE by default; rotation-scoped memory cleared on RESET;
    // the phase hype ladder reads `host.timeline.phase`; the record superlative
    // reads the rotation's fastest throw. A sibling host — the tick never depends on
    // it (cut-safe). Its seeded RNG comes from the STABLE room seed (deterministic).
    let casterRngState = (roomSeedFor(room.roomId) >>> 0) || 1;
    const caster = new CasterHost({
      broadcast: (_opcode, frame, tiers) =>
        h.broadcastBinaryToTiers(room.roomId, frame as ArrayBuffer, tiers),
      serverNow: () => Math.max(0, timerApi.now() - roomEpoch),
      phase: () => host.timeline.phase,
      rng: () => {
        // mulberry32 — a deterministic, dependency-free per-room stream.
        casterRngState = (casterRngState + 0x6d2b79f5) | 0;
        let t = casterRngState;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      dayRecord: () => {
        // C26 fix: read the DAY-scoped fastest throw (survives rotation RESET), NOT
        // the rotation-scoped `throwStats.fastest` (cleared every RESET, §7.15). The
        // old read let a 40 m/s rotation-2 throw claim "FASTEST THROW TODAY" even
        // after a 50 m/s rotation-1 throw — a factually false superlative. Guarded:
        // buckets may be uninitialised in a bare unit test → no record (SILENCE).
        try {
          return getBucket('dayStats').getFastestThrow(room.roomId);
        } catch {
          return null;
        }
      },
    });
    h.casters.set(room.roomId, caster);
    // C19: the F12 Supernova Encore — the crowd-charged FINALE. Composed over the
    // SAME RoomHandle/world/timeline host (like the siege). It owns the ambient
    // CROWD_CUE light rig, the debounced+normalized charge, the pinned orb, and the
    // synchronized drop (impulse + arp + flash on ONE server tick via C3 scheduleAt).
    // The melodySource hook is NOT wired here (F8 wires it if it lands). C20's
    // `themeCut` IS wired below (F9 landed): the encore hard-cuts the theme on the
    // drop so the reality FLIPS on the same instant as the flash + arp (spec §7.13).
    // The no-sibling fallback (ENV_STATE + palette flash) stays intact — the encore
    // still fires it independently, so cutting C20 (dropping this hook) leaves the
    // encore fully working. A sibling host: the tick feeds it but never depends on it.
    const encore = new EncoreHost({
      timer: timerApi,
      world: room.world,
      handle: host.handle,
      host,
      roomEpoch: h.getRoomEpoch(room.roomId),
      broadcast: (opcode, payload, tiers) => {
        // CROWD_CUE frames are BINARY (Appendix B); ENV_STATE/SHOWPIECE are JSON.
        if (opcode === OPCODES.CROWD_CUE && payload instanceof ArrayBuffer) {
          h.broadcastBinaryToTiers(room.roomId, payload, tiers);
        } else {
          h.broadcastOpcodeToTiers(room.roomId, opcode, payload, tiers);
        }
      },
      // C20 F9 themeCut (attach-if-landed): on the drop, advance the reality to the
      // NEXT channel scheduled at the SAME fireAtServerTime so the theme flip lands
      // on the drop instant (roomEpoch-relative → absolute server ms for the host).
      themeCut: (fireAtServerTime) => {
        const chan = h.themeChannels.get(room.roomId);
        if (!chan) return;
        const next = nextThemeId(chan.activeTheme);
        chan.setTheme(next, h.getRoomEpoch(room.roomId) + fireAtServerTime);
      },
      ...(metricsStore
        ? { metricsCount: (k: string) => { if (k === 'showpiece') metricsStore.count('showpiece'); } }
        : {}),
    });
    h.encores.set(room.roomId, encore);
    // C28: the F17 Daemon Crew host — server-hosted synthetic resident peers that play
    // fetch-and-return so a lone-visitor booth is never an empty sandbox (§7.17). Every
    // interaction is a STANDARD path (NO god-mode): join = manager.joinResidentSync
    // (the SAME cap-enforced world add as a human), intents = room.applyIntent (the
    // SAME validated grab/held/release), leave = manager.leave (the SAME force-release
    // disconnect). Daemons are socketless, so ATTRACT-exit / idle / auto-banker /
    // VOICE_ROSTER / queue-bridge / occupancy are all inherently synthetic-blind; the
    // ONLY daemon-specific side-effects are the synthetic metric key, the "DMN-07"
    // banner (NOT the join-crane), and the dismissal triggers.
    const daemonCrew = new DaemonCrewHost({
      timer: timerApi,
      autoSummonLobby: DAEMON_AUTOSUMMON_LOBBY, // ship gate — DEFAULT OFF
      port: {
        join: (callsign, color) => manager.joinResidentSync(room.roomId, callsign, color),
        applyIntent: (playerId, msg) => {
          // The STANDARD validated intent path — a daemon's grab/held/release/pose is
          // arbitrated + budgeted EXACTLY like a human's; broadcast the result to all.
          const events = room.applyIntent(playerId, msg);
          for (const evt of events) h.broadcast(room.roomId, evt);
        },
        leave: (playerId) => {
          const sockets = h.roomSockets.get(room.roomId);
          const keepAlive = (sockets?.size ?? 0) > 0;
          // STANDARD disconnect: force-releases the daemon's held shape + player-leave.
          const events = manager.leave(room.roomId, playerId, keepAlive);
          for (const evt of events) h.broadcast(room.roomId, evt);
        },
        announceAvatar: (peer) => {
          // The daemon avatar renders via a normal player-join carrying `synthetic:true`
          // (the client draws a drone + DAEMON badge). NOT a join-crane ceremony.
          h.broadcast(room.roomId, {
            t: 'player-join',
            player: { id: peer.id, name: peer.callsign, color: peer.color, synthetic: true },
          });
        },
        banner: (callsign) => {
          // The distinct "DMN-07 ONLINE" glitch banner — the caster join event is NOT
          // fired for a daemon, so the human JOIN_CRANE never triggers (§7.17).
          h.broadcast(room.roomId, { t: 'daemon-banner', callsign });
        },
        countSyntheticJoin: (callsign) => {
          // Synthetic joins land in the metrics SYNTHETIC bucket only (never the club
          // day export) — the callsign's DMN- prefix routes it there (§7.17).
          metricsStore?.count('join', callsign);
        },
        shapes: (): DaemonShapeView[] =>
          room.worldShapes.map((s) => ({ id: s.id, position: s.position, grabbedBy: s.grabbedBy })),
        humanTargets: () => daemonHumanTargets(room.roomId),
      },
    });
    h.daemons.set(room.roomId, daemonCrew);
    // C28: the staff/cue summon + dismiss cues (advanced tab). Summoning is
    // staff/cue-only at ship; firing rides the SAME director cue-fire path as the
    // dial cues. A daemon crew is never auto-summoned unless DAEMON_AUTOSUMMON_LOBBY.
    host.registry.register({
      id: 'summon-daemons',
      label: 'Summon Daemon Crew',
      tab: 'advanced',
      cooldownMs: 3_000,
      phases: ['ATTRACT', 'LOBBY', 'PLAY'],
      comfortCost: 0,
      run: () => daemonCrew.summon(),
    });
    host.registry.register({
      id: 'dismiss-daemons',
      label: 'Dismiss Daemon Crew',
      tab: 'advanced',
      cooldownMs: 0,
      phases: ['ATTRACT', 'LOBBY', 'PLAY', 'OVERLOAD', 'FINALE', 'STATS', 'RESET'],
      comfortCost: 0,
      run: () => daemonCrew.dismiss(),
    });
    return host;
  }

  /**
   * Task C32 (F21 Powers Lab, spec §7.21): register the powers-lab CUE — but ONLY
   * when (a resident has reported camera-tracked hands ∧ POWERS_LAB_ENABLED). Until
   * BOTH hold, the cue is ABSENT from CUE_CATALOG, so a director console never sees
   * it and `fire('powers-lab', …)` returns the existing `unknown`. Registering fires
   * the registry's onChange → a CUE_CATALOG re-broadcast (the capability gate). The
   * cue's effect ARMS the exhibit (~10 min auto-revert); firing it again toggles it
   * OFF. Idempotent — a second call after registration is a no-op.
   */
  function maybeRegisterPowersLabCue(roomId: string): void {
    if (!powersLabEnabled()) return;
    if (h.powersHandsReported.get(roomId) !== true) return;
    const host = h.hosts.get(roomId);
    const lab = h.powersLabs.get(roomId);
    if (!host || !lab) return;
    if (host.registry.has('powers-lab')) return; // already advertised
    host.registry.register({
      id: 'powers-lab',
      label: 'Powers Lab (Hand Telekinesis)',
      tab: 'advanced',
      cooldownMs: 3_000,
      // PLAY/LOBBY only — NEVER ATTRACT (the demoing staffer's join ends ATTRACT).
      phases: ['LOBBY', 'PLAY'],
      comfortCost: 0,
      run: () => lab.arm(),
    });
  }

  /** Dispose + drop the room's Showrunner (last socket left). */
  function disposeHost(roomId: string): void {
    // C22 (F10 Ghost Arcade): AUTO-BANK on room-empty (§7.10) — score the recorded
    // windows and bank the best into the DAY-scoped bank (which OUTLIVES the room)
    // so an after-hours attract permalink still has ghosts to play. Daemon-heavy
    // windows are down-ranked (never excluded) inside the recorder. The recorder is
    // then dropped; the reelBank is intentionally NOT dropped here (day-scoped).
    const recorder = h.recorders.get(roomId);
    if (recorder) {
      const reel = recorder.bankOnEmpty();
      if (reel) h.bankReel(roomId, reel);
      h.recorders.delete(roomId);
    }
    const host = h.hosts.get(roomId);
    if (host) {
      host.dispose();
      h.hosts.delete(roomId);
    }
    const election = h.elections.get(roomId);
    if (election) {
      election.dispose();
      h.elections.delete(roomId);
    }
    const siege = h.sieges.get(roomId);
    if (siege) {
      siege.dispose();
      h.sieges.delete(roomId);
    }
    const titan = h.titans.get(roomId);
    if (titan) {
      titan.dispose();
      h.titans.delete(roomId);
    }
    // C32: the Powers Lab host holds the ~10 min exhibit auto-revert timer — dispose
    // it (unpins any held shapes) and drop the room's hands-reported flag.
    const powersLab = h.powersLabs.get(roomId);
    if (powersLab) {
      powersLab.dispose();
      h.powersLabs.delete(roomId);
    }
    h.powersHandsReported.delete(roomId);
    // C18: the Conductor holds no timers (the sim loop drives it) — just drop it.
    h.conductors.delete(roomId);
    // C26: the caster host holds no timers (the sim loop drives it) — just drop it.
    h.casters.delete(roomId);
    // C28: the Daemon Crew — dispose (dismisses the whole crew: release-held +
    // player-leave via the standard disconnect) and drop its cached aim poses.
    const daemonCrew = h.daemons.get(roomId);
    if (daemonCrew) {
      daemonCrew.dispose();
      h.daemons.delete(roomId);
    }
    h.lastResidentPose.delete(roomId);
    // C19: the Encore holds timers (cap/ambient/auto-launch/drop) — dispose them.
    const encore = h.encores.get(roomId);
    if (encore) {
      encore.dispose();
      h.encores.delete(roomId);
    }
    const themeChannel = h.themeChannels.get(roomId);
    if (themeChannel) {
      themeChannel.dispose();
      h.themeChannels.delete(roomId);
    }
    h.throwStats.delete(roomId);
  }

  /**
   * Build the staff roster (spec §5.4): one entry per live peer with join
   * provenance {entryRoute, joinedAt} + the optional quantized rttMs (C3 store).
   * rttMs is surfaced to director + spectator tiers only (this is a director cmd).
   */
  function buildRoster(roomId: string): Array<{
    id: string;
    callsign: string;
    tier: Tier;
    entryRoute: string;
    joinedAt: number;
    rttMs?: number;
  }> {
    const sockets = h.roomSockets.get(roomId);
    if (!sockets) return [];
    const entries: Array<{
      id: string;
      callsign: string;
      tier: Tier;
      entryRoute: string;
      joinedAt: number;
      rttMs?: number;
    }> = [];
    for (const s of sockets) {
      const m = h.socketMeta.get(s);
      if (!m) continue;
      const rtt = h.rttStore.get(m.playerId);
      entries.push({
        id: m.playerId,
        callsign: m.callsign,
        tier: m.tier,
        entryRoute: m.entryRoute,
        joinedAt: m.joinedAt,
        ...(typeof rtt === 'number' ? { rttMs: rtt } : {}),
      });
    }
    return entries;
  }

  // ----- BINARY messages (voice frames + Phase C binary families) -----------
  function handleBinary(ws: WebSocket, data: unknown): void {
    const meta = h.socketMeta.get(ws);
    if (!meta) return;

    // Normalise to ArrayBuffer
    let buf: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (Buffer.isBuffer(data)) {
      buf = new Uint8Array(data).buffer;
    } else {
      return; // unexpected
    }

    if (buf.byteLength < 1) return;

    const firstByte = new DataView(buf).getUint8(0);

    // ---- Task C3: Phase C binary families (0x20–0x3F) ----------------------
    // Demux on the first byte FIRST so Phase C frames are never mis-routed as
    // voice. Currently only CLOCK_PING (0x30) is handled; future Phase C binary
    // opcodes extend this block without touching the voice path below.
    if (isPhaseCOpcode(firstByte)) {
      // CLOCK_PING (0x30) — any tier may send a clock ping (spec §5.3: audience
      // also sends CLOCK_PING; resident/spectator/wisp/crowd likewise).
      if (firstByte === OPCODES.CLOCK_PING) {
        let pingFields: ClockPingFields;
        try {
          const decoded = decodeBinary(buf);
          pingFields = decoded.fields as unknown as ClockPingFields;
        } catch {
          return; // malformed — drop
        }

        // Store the quantized RTT per connection (C4 roster surface).
        h.rttStore.set(meta.playerId, pingFields.lastRttMs);

        // Produce and send the CLOCK_PONG. serverTimeMs = now − roomEpoch.
        const serverNowMs = timerApi.now() - meta.roomEpoch;
        const pongBuf = handleClockPing(pingFields, serverNowMs);
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(Buffer.from(pongBuf));
        }
        return;
      }

      // ---- Task C14 (F4) — WISP_POSE (0x26/0x02) -----------------------------
      // The wisp's own head-only pose (the ONLY WISP family with an Appendix B
      // binary layout — WISP_PULSE is a cold JSON intent, handled in the text
      // path). ONLY the wisp tier originates it; a spoofed WISP_POSE from any
      // other tier is dropped (trust the server-granted `meta.tier`, not a claim).
      // The pose rides the C2 shared ~5 Hz coalesced buffer to the room's wisps
      // (never a per-peer relay). We STAMP the server-assigned slot as `wispIndex`
      // (the client cannot pick another wisp's index) — last-write-wins per socket.
      if (firstByte === OPCODES.WISP) {
        if (meta.tier !== 'wisp') return;
        let decoded;
        try {
          decoded = decodeBinary(buf);
        } catch {
          return; // malformed — drop (decodeBinary only knows the WISP_POSE layout)
        }
        if (decoded.kind === WISP_KIND.POSE) {
          const f = decoded.fields as { pos: number[]; yaw: number };
          h.setWispPose(meta.roomId, meta.playerId, {
            wispIndex: meta.wispSlot ?? 0,
            pos: [f.pos[0] | 0, f.pos[1] | 0, f.pos[2] | 0],
            yaw: f.yaw | 0,
          });
        }
        return;
      }

      // ---- Task C32 (F21 Powers Lab) — TELEKINESIS (0x34) ---------------------
      // Hand-tracking telekinesis. ONLY the resident tier originates TK (the wearer
      // in the headset); a spoofed TK from any other tier is dropped (trust the
      // server-granted `meta.tier`, not a claim). Fixed-point wire → SI at the
      // boundary (anchor 1 unit = 4 mm; dir 1 unit = 1/32767 normalized; vel 1 unit
      // = 1 mm/s). Cone-select + the pull + every safety rail live in the
      // PowersLabHost — this handler only decodes + routes.
      if (firstByte === OPCODES.TELEKINESIS) {
        if (meta.tier !== 'resident') return;
        let decoded;
        try {
          decoded = decodeBinary(buf);
        } catch {
          return; // malformed — drop
        }
        const lab = h.powersLabs.get(meta.roomId);
        if (decoded.kind === TELEKINESIS_KIND.TK_HANDS_STATE) {
          // Capability signal (§7.21): a resident reported camera-tracked hands. The
          // powers-lab cue registers ONLY when (hands reported ∧ POWERS_LAB_ENABLED),
          // then CUE_CATALOG re-broadcasts (via the registry onChange). DEFAULT OFF.
          const f = decoded.fields as { available: number };
          if (f.available === 1) {
            h.powersHandsReported.set(meta.roomId, true);
            maybeRegisterPowersLabCue(meta.roomId);
          }
          return;
        }
        if (!lab) return;
        if (decoded.kind === TELEKINESIS_KIND.TK_PULL) {
          const f = decoded.fields as { hand: number; anchor: number[]; dir: number[] };
          const anchor = {
            x: f.anchor[0] * TK_POS_UNIT_M,
            y: f.anchor[1] * TK_POS_UNIT_M,
            z: f.anchor[2] * TK_POS_UNIT_M,
          };
          const dir = {
            x: f.dir[0] / TK_DIR_UNIT,
            y: f.dir[1] / TK_DIR_UNIT,
            z: f.dir[2] / TK_DIR_UNIT,
          };
          lab.feedPull(meta.playerId, f.hand | 0, anchor, dir, timerApi.now());
          return;
        }
        if (decoded.kind === TELEKINESIS_KIND.TK_RELEASE) {
          const f = decoded.fields as { hand: number; vel: number[] };
          const velHint = {
            x: f.vel[0] * TK_VEL_UNIT_M,
            y: f.vel[1] * TK_VEL_UNIT_M,
            z: f.vel[2] * TK_VEL_UNIT_M,
          };
          lab.release(meta.playerId, f.hand | 0, timerApi.now(), velHint);
          return;
        }
        return;
      }
      // Other 0x20–0x3F opcodes: ignored until their tasks land (§3 unknown-opcode-ignore).
      return;
    }

    // ---- Voice binary frames (0x10–0x12) ------------------------------------
    // Phase C accommodation #1 (spec §3, C0 — unknown-opcode ignore for binary):
    // Only the three voice opcodes (0x10–0x12) are relayed as voice; any other
    // binary first byte in the voice range is dropped.
    if (!isVoiceFrame(buf)) return;

    // Task C2: only voice SENDER tiers (residents, TIER_POLICY.voiceSend) may
    // originate a voice frame. A spectator/wisp/crowd binary voice frame is
    // dropped at the source — those tiers are never room-audio senders.
    if (!TIER_POLICY[meta.tier].voiceSend) return;

    // Task C4 — MUTE (spec §5.4): a muted sender's 0x1x frames are DROPPED at
    // fan-out (server-side, so no client can un-mute them). The sender still
    // "hears themselves locally" (their mic), but no peer receives their audio.
    if (h.muted.get(meta.roomId)?.has(meta.playerId)) return;

    const voiceFirstByte = voiceOpcodeOf(buf);
    if (voiceFirstByte === null || !isVoiceOpcode(voiceFirstByte)) return;

    // Finding #1: reject an oversized voice frame BEFORE unpackVoice allocates.
    // (maxPayload already caps single frames; this is a tighter, voice-specific
    // guard so a large-but-under-maxPayload buffer can't be relayed either.)
    if (buf.byteLength > MAX_VOICE_FRAME_BYTES) return;

    // Stamp server-side senderId (numeric part of playerId)
    const numericId = parseInt(meta.playerId.slice(1), 10);
    let unpacked: ReturnType<typeof unpackVoice>;
    try {
      unpacked = unpackVoice(buf);
    } catch {
      return; // malformed frame — drop
    }

    const stamped = packVoice(
      unpacked.opcode,
      numericId,
      unpacked.tsMs,
      unpacked.flags,
      unpacked.opus
    );
    const stampedBuf = Buffer.from(stamped);

    // Task C2 — voice fan-out is tier-gated (spec §5.1): frames reach authed
    // `resident` + authed `spectator` connections ONLY. A resident opts in via
    // voice-join (Phase B `vset` membership); a spectator is receive-only and
    // gets frames without opting in (playback is a client concern, OFF by
    // default). wisp/crowd (voiceRecv=false) NEVER receive room audio.
    const vset = h.getVoiceSet(meta.roomId);
    const sockets = h.roomSockets.get(meta.roomId);
    if (!sockets) return;

    for (const peer of sockets) {
      if (peer === ws) continue; // never echo to sender
      const peerMeta = h.socketMeta.get(peer);
      if (!peerMeta) continue;
      if (!TIER_POLICY[peerMeta.tier].voiceRecv) continue; // only voice-recv tiers
      // Residents must have opted into voice (Phase B); spectators auto-receive.
      if (peerMeta.tier === 'resident' && !vset.has(peerMeta.playerId)) continue;

      // Backpressure: drop frame for this peer if their buffer is too full
      if (peer.bufferedAmount > VOICE_BACKPRESSURE_CAP) continue;

      if (peer.readyState === 1 /* OPEN */) {
        peer.send(stampedBuf);
      }
    }
  }

  // ----- CLOSE ---------------------------------------------------------------
  ws.on('close', () => {
    const meta = h.socketMeta.get(ws);
    if (!meta) return;

    const { roomId, playerId, callsign, idleTimer, tier } = meta;

    // Task C2: cancel any pending idle-kick + release the callsign back to the
    // room pool so a rejoin (or a new joiner) can reuse it.
    if (idleTimer !== null) timerApi.clearTimeout(idleTimer);
    h.releaseCallsign(roomId, callsign);
    // Task C3: remove RTT store entry on disconnect (C4 roster cleanup).
    h.rttStore.delete(playerId);
    // Task C14: drop a departed wisp's pose so it is never re-broadcast + free its
    // orbit slot (allocateSlot reads live occupancy, so deleting the meta frees it).
    if (tier === 'wisp') h.clearWispPose(roomId, playerId);
    // Task C25 (F14 The Gallery): free this remote viewer's per-IP slot so a
    // rejoin (or another viewer behind the same IP) can reclaim it.
    if (tier === 'audience') h.decAudienceIp(roomId, meta.clientIp);

    h.socketMeta.delete(ws);

    // Remove from room socket set. `roomStillHasSockets` decides whether the
    // room object (and its world shapes) must survive past this leaver — a
    // resident may leave while wisps/spectators keep watching (Task C2).
    const sockets = h.roomSockets.get(roomId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        h.roomSockets.delete(roomId);
      }
    }
    const roomStillHasSockets = (sockets?.size ?? 0) > 0;

    // Task C25 (F14 The Gallery): a departing viewer changes the watcher count —
    // refresh the "N WATCHING" counter promptly (the 0.2 Hz sim driver is the
    // backstop). No-op if the room is now empty (broadcast no-ops on a gone room).
    if (tier === 'audience' && roomStillHasSockets) h.broadcastAudienceState(roomId);

    // Remove from voice set. Remember whether they were voice-enabled so we can
    // rebroadcast the roster (voice-join/voice-leave both do; the close path
    // must too, else peers keep a stale roster showing the departed player).
    const vset = h.voiceEnabled.get(roomId);
    const wasVoiceEnabled = vset?.has(playerId) ?? false;
    if (vset) {
      vset.delete(playerId);
      if (vset.size === 0) {
        h.voiceEnabled.delete(roomId);
      }
    }

    // Tell the room manager — ONLY for residents (the world avatar players).
    // A non-resident (wisp/crowd/spectator/director) was never addPlayer'd, so
    // calling leave would emit a spurious world `player-leave`; instead its
    // per-room state is dropped below via the socket-set + callsign cleanup.
    // `keepAlive` when other sockets remain so a resident-less-but-still-watched
    // room is not torn down (world state lost).
    if (tier === 'resident') {
      // Task C17 (F7 Titan Protocol, §7.7): revert-on-disconnect. If the departing
      // resident IS the active titan, revert them (broadcasts PLAYER_SCALE → 1); a
      // no-op otherwise. Runs BEFORE manager.leave so the revert broadcast reaches the
      // still-present peers.
      h.titans.get(roomId)?.onPeerDisconnect(playerId);
      // Task C32 (F21 Powers Lab, §7.21): revert-on-disconnect. If the departing
      // resident IS the active TK player, release all their pulls (unpin) + free the
      // one-TK-player lock; a no-op otherwise. Runs BEFORE manager.leave.
      h.powersLabs.get(roomId)?.onPeerDisconnect(playerId);
      const events = manager.leave(roomId, playerId, roomStillHasSockets);
      // Broadcast disconnect events to remaining members.
      for (const evt of events) {
        h.broadcast(roomId, evt);
      }
      // Task C28 (F17 Daemon Crew): drop this human's cached aim pose, then run the
      // dismissal trigger on the NEW human count (§7.17). humans === 0 (the last human
      // departed) dismisses the whole crew, releasing any held shape via the standard
      // disconnect. Runs while the room may still be kept alive by spectators/wisps.
      h.lastResidentPose.get(roomId)?.delete(playerId);
      h.daemons.get(roomId)?.onHumanCountChanged(humanResidentCount(roomId));
    }

    // If the departing player was voice-enabled, refresh the roster for the
    // remaining peers. broadcastVoiceRoster no-ops when the room is already
    // gone (roomSockets deleted above), so it is safe even for the last leaver.
    if (wasVoiceEnabled) {
      h.broadcastVoiceRoster(roomId);
    }

    // Task C2: when the LAST socket (any tier) leaves, drop the room + its epoch
    // so a wisp-only room is reclaimed too. Otherwise keep it alive.
    if (!roomStillHasSockets) {
      // Task C10: dispose the room's Showrunner (cancels its heartbeat/pacing/
      // overlay timers) BEFORE dropping the room.
      disposeHost(roomId);
      manager.dropRoom(roomId);
      h.roomEpochs.delete(roomId);
      // Task C4: clear per-room incident state + mark the room empty so the auth
      // store's TTL can reclaim it after the empty window (spec §5.4).
      h.doorClosed.delete(roomId);
      h.muted.delete(roomId);
      // Task C25 (F14 The Gallery): drop the room's audience keyframe cache +
      // per-IP counters + join buckets so nothing leaks past the room's life.
      h.dropRoomAudience(roomId);
      if (authStore) authStore.markEmpty(roomId);
      onRoomBecameEmpty(roomId);
    }
  });
}
