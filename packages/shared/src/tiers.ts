// ---------------------------------------------------------------------------
// Connection tiers (spec §5.1) — the one enum that replaces every ad-hoc role.
// Negotiated in the WS TIER_HELLO/join payload, enforced server-side per room.
// ---------------------------------------------------------------------------

import { OPCODES } from './protocol/opcodes.js';

/**
 * The six Phase C connection tiers.
 *
 * The `audience` tier (spec §5.1, cap 128, receive-only remote viewers) LANDS
 * with C25 (F14 The Gallery). It is added ADDITIVELY: `TIER_POLICY` gains an
 * optional per-family receive field ({@link TierPolicy.receiveFamilies}) so the
 * central fan-out functions can admit audience from the §5.1 receive-set UNION
 * without editing any existing per-tier broadcast call site (C25's composition
 * acceptance criterion). Tier ≤5 code depends on none of this.
 */
export type Tier = 'resident' | 'spectator' | 'director' | 'wisp' | 'crowd' | 'audience';

/** Runtime list of every tier — the exhaustiveness anchor for the tests. */
export const TIERS = [
  'resident',
  'spectator',
  'director',
  'wisp',
  'crowd',
  'audience',
] as const satisfies readonly Tier[];

/** Per-room connection cap per tier (spec §5.1). resident=8 is the Phase B invariant. */
export const TIER_CAPS: Record<Tier, number> = {
  resident: 8,
  spectator: 2,
  director: 2,
  wisp: 24,
  crowd: 64,
  audience: 128,
};

/**
 * Task C25 (F14 The Gallery, spec §5.1/§7.14): the per-IP concurrency cap on the
 * `audience` tier — the unauthed-surface defense. No single IP may hold more than
 * this many concurrent audience sockets to one room (a per-IP join-attempt token
 * bucket ALSO throttles cached-keyframe egress on top of this). The §7.13
 * never-per-IP doctrine is written for booth phones behind CGNAT; remote viewers
 * are the case it doesn't cover (mobile-CGNAT caveat noted in the runbook).
 */
export const AUDIENCE_MAX_PER_IP = 4;

/**
 * Fan-out rate class per tier (spec §5.1 "Receives" column):
 *  - `full`      : full-rate deltas + poses + snapshot (residents; spectators get
 *                  this plus an optional `streamRate:'full'` upgrade).
 *  - `coalesced5`: one shared 5 Hz coalesced buffer, serialized ONCE per room per
 *                  tick and sent to every wisp (head-only poses).
 *  - `summary`   : family-specific coalesced summaries only (crowd) — never full
 *                  deltas, poses, or snapshots.
 *  - `stateOnly` : state + roster + PHASE_STATE + CUE_CATALOG (director).
 *  - `audience`  : the §5.1 audience-row UNION only (see {@link AUDIENCE_RECV_FAMILIES})
 *                  — strictly less than a spectator; NEVER a full-rate delta,
 *                  pose, snapshot, or voice frame (C25 — the egress/security
 *                  invariant). The world arrives via the shared 5 Hz coalesced
 *                  buffer + a cached late-join keyframe, not `state`/`welcome`.
 */
export type ReceiveClass = 'full' | 'coalesced5' | 'summary' | 'stateOnly' | 'audience';

/**
 * The policy row for a tier (spec §5.1). Additive fields land here as tiers gain
 * capabilities (C25 adds an optional per-family receive set for `audience`);
 * existing fields must not change shape.
 */
export interface TierPolicy {
  /** Per-room cap (mirror of TIER_CAPS[tier], kept for single-object lookup). */
  cap: number;
  /** resident/spectator require the room join secret; the rest are public QR. */
  authRequired: boolean;
  /** Does this tier RECEIVE voice frames? Only authed resident + spectator do. */
  voiceRecv: boolean;
  /** Is this tier a voice SENDER (appears in VOICE_ROSTER)? residents only. */
  voiceSend: boolean;
  /** Fan-out rate class (see ReceiveClass). */
  receive: ReceiveClass;
  /** May this tier send world intents (spawn/grab/…)? residents + wisps (rate-limited). */
  canSendIntents: boolean;
  /** Is this connection subject to the 90–120 s idle-kick? wisp/crowd/audience. */
  idleKick: boolean;
  /**
   * Task C25 (F14 The Gallery): the ADDITIVE per-family receive set (spec §5.1
   * "additive optional per-family receive field"). Present ONLY on the `audience`
   * tier: the exact §5.1 audience-row UNION of `ServerMsg.t` families this tier
   * may receive (the SINGLE normative enumeration — {@link AUDIENCE_RECV_FAMILIES}).
   * The central fan-out functions consult THIS to admit audience, so no existing
   * per-tier broadcast call site needs editing — the receive-set union drives
   * fan-out (the composition acceptance criterion). Absent on Tier ≤5 (their
   * `receive` class is sufficient); its shape must not change for those tiers.
   */
  receiveFamilies?: ReadonlySet<string>;
}

/**
 * Task C25 (F14 The Gallery, spec §5.1 — THE single normative enumeration; §7.14
 * and FAQ 6 both cite this cell): the set of `ServerMsg.t` families an `audience`
 * connection may RECEIVE. The audience-row union, VERBATIM:
 *
 *   crowd's receive set (votes / showpiece summaries)
 *   ∪ GLYPH family (births, removes, panic-hides — closes the panic-key hole)
 *   ∪ `despawn` (world-lifecycle removals — evictions / OOB / RESET / build-delete:
 *      a tiny id-only message; WITHOUT it a shape that was in the join keyframe
 *      but later removed is a permanent ghost for the whole session — C25 review
 *      finding M2; the roll-forward buffer carries MOVING shapes only, never removals)
 *   ∪ PHASE_STATE ∪ ENV_STATE ∪ THEME_SET
 *   ∪ STATS_CARD
 *   ∪ AUDIENCE_STATE (0x32 — the viewer counter)
 *   ∪ the cached late-join keyframe (audience-keyframe)
 *   (+ CASTER_LINE attach-if-landed — C26; MUSIC is binary, see
 *    {@link AUDIENCE_RECV_BINARY_OPCODES})
 *
 * The 5 Hz coalesced world buffer + head-only poses (`wisp-coalesced`) is NOT in
 * this set: it is delivered by the serialize-ONCE coalesced path (zero marginal
 * serialization), never the per-message `broadcast`. `spawn` is likewise absent —
 * new shapes arrive to a viewer via the roll-forward coalesced buffer + the next
 * cached keyframe (never the per-shape `spawn`); `despawn` IS admitted because a
 * removal has no roll-forward carrier (a removed shape simply stops appearing) —
 * omitting it strands a ghost. What is NOT here is as load-bearing as what is:
 * NEVER `state` (full-rate delta), `pose` (full-rate pose), `welcome` (full
 * snapshot), or any `voice-*` frame — the egress/security invariant. `director-msg`
 * is admitted for the PANIC control kind ONLY (§6.1 panic coverage extends to the
 * 128 anonymous audience screens); the CUE catalog never reaches audience.
 */
// Task C30 (F19 Pocket DVR, spec §7.19) — the ADDITIVE `grab` (RELEASE-ONLY) family.
// Step 0 substrate-binding finding: the wisp tier already receives `grab` release
// events per-message (its `coalesced5` gate blocks only state/pose/welcome), so
// the §3 accommodation #5 release {pos, vel} — the resim SEED that turns the
// decimated 5 Hz position-only stream into a REWINDABLE ballistic arc — already
// survives for wisps. The AUDIENCE tier's receive UNION did NOT include `grab`, so
// that authoritative {pos, vel} was DROPPED for the 128 remote screens. Per §7.19
// ("preserves release events with server-computed {pos, vel}, or rebase that
// fan-out") we ADDITIVELY admit `grab` to the audience union so the release seed
// survives there too.
//
// ⚠ C30 REVIEW MF1 — the `grab` family is BIVALENT. `room.ts` emits BOTH a
// grab-START `{t:'grab', id, peerId:<playerId>}` (NO pos/vel) AND the release seed
// `{t:'grab', id, peerId:null, pos, vel}`. A family-name Set cannot distinguish
// them — so audience admission is REFINED to RELEASE-ONLY by a per-message
// predicate in `tierAdmits` (connection.ts): audience receives `grab` IFF
// `peerId === null`. grab-START (peerId set) is EXCLUDED — it would disclose a
// participant's stable internal playerId + who-holds-what (identity/held-state the
// §5.1 audience boundary withholds; public callsign only). Wisp/other tiers keep
// the FULL `grab` family (they legitimately see grab-START). This does NOT weaken
// the C25 egress/security boundary: audience STILL never receives a full-rate
// `state`, `pose`, `welcome`, or any `voice` frame (asserted). The release seed is
// a tiny discrete already broadcast to residents/spectators/wisps; delivering it
// (only the peerId:null form) to audience carries no new secret.
export const AUDIENCE_RECV_FAMILIES: ReadonlySet<string> = new Set<string>([
  'phase-state',
  'env-state',
  'theme-set',
  'stats-card',
  'vote',
  'showpiece',
  'glyph',
  'glyph-remove',
  'glyph-hide',
  'despawn',
  'audience-state',
  'audience-keyframe',
  // C30 (F19 Pocket DVR): the release event's authoritative {pos, vel} resim seed.
  // BIVALENT — admission is refined to RELEASE-ONLY (peerId === null) by the
  // `tierAdmits` audience predicate; grab-START (peerId set) is EXCLUDED (MF1).
  'grab',
]);

/**
 * Task C25: the BINARY opcodes an `audience` connection may receive (spec §5.1
 * audience union — MUSIC_CLOCK/MUSIC_NOTE garnish 0x29, and the crowd CHARGE
 * summary 0x2A). Consulted by the once-serialized binary fan-out. The voice
 * window (0x10–0x1F) is deliberately absent — audience NEVER receives a voice
 * frame (the same invariant enforced on the JSON path).
 *
 * Task C26 (F15 MC NULL) — the ATTACH-IF-LANDED addition (spec §5.1 "CASTER_LINE
 * attach-if-landed", §7.15): CASTER_LINE (0x33) joins the allowlist so the 128
 * remote watch screens get captions. It is a tiny, indices-only frame — it does
 * NOT weaken the C25 receive-only boundary: audience still NEVER gets a full-rate
 * delta (`state`), a pose, the welcome snapshot, or any voice frame. This set is
 * additive; the JSON union (AUDIENCE_RECV_FAMILIES) is unchanged.
 */
export const AUDIENCE_RECV_BINARY_OPCODES: ReadonlySet<number> = new Set<number>([
  OPCODES.MUSIC,
  OPCODES.CROWD_CUE,
  OPCODES.CASTER_LINE,
]);

/**
 * The complete, exhaustive §5.1 policy table. Keyed by every Tier so the
 * exhaustiveness test can assert `keys(TIER_POLICY) === TIERS`.
 */
export const TIER_POLICY: Record<Tier, TierPolicy> = {
  resident: {
    cap: TIER_CAPS.resident,
    authRequired: true,
    voiceRecv: true,
    voiceSend: true,
    receive: 'full',
    canSendIntents: true,
    idleKick: false,
  },
  spectator: {
    cap: TIER_CAPS.spectator,
    authRequired: true,
    voiceRecv: true,
    voiceSend: false,
    receive: 'full',
    canSendIntents: false, // send-whitelist ONLY (SPECTATOR_SEND_WHITELIST)
    idleKick: false,
  },
  director: {
    cap: TIER_CAPS.director,
    authRequired: true, // ownerToken (§5.4) — a privileged credential
    voiceRecv: false,
    voiceSend: false,
    receive: 'stateOnly',
    canSendIntents: false, // DIRECTOR_CMD only
    idleKick: false,
  },
  wisp: {
    cap: TIER_CAPS.wisp,
    authRequired: false,
    voiceRecv: false,
    voiceSend: false,
    receive: 'coalesced5',
    canSendIntents: true, // wisp poses + rate-limited intents
    idleKick: true,
  },
  crowd: {
    cap: TIER_CAPS.crowd,
    authRequired: false,
    voiceRecv: false,
    voiceSend: false,
    receive: 'summary',
    canSendIntents: false, // votes / charge taps / glyph submissions only
    idleKick: true,
  },
  // Task C25 (F14 The Gallery): the remote receive-only viewer tier. Public
  // permalink (no secret), NEVER a voice receiver/sender, sends heartbeat +
  // CLOCK_PING only (canSendIntents:false), idle-kicked like wisp/crowd. Its
  // receive set is the §5.1 audience-row UNION carried additively in
  // `receiveFamilies` (+ the coalesced/keyframe/binary paths) — strictly less
  // than a spectator.
  audience: {
    cap: TIER_CAPS.audience,
    authRequired: false,
    voiceRecv: false,
    voiceSend: false,
    receive: 'audience',
    canSendIntents: false,
    idleKick: true,
    receiveFamilies: AUDIENCE_RECV_FAMILIES,
  },
};

/**
 * Opcodes a `spectator` connection is allowed to SEND (spec §5.1 spectator row):
 * heartbeat, CLOCK_PING, the 0x2C REEL family (REEL_* + REQUEST_SNAPSHOT), and
 * stream-subscription control (carried on the DIRECTOR/stream control path). All
 * other intents are dropped server-side. Heartbeat is a text message (no opcode),
 * so it is enforced separately at the connection layer; this set gates binary
 * opcodes. C2 consumes this to filter spectator sends.
 */
export const SPECTATOR_SEND_WHITELIST: ReadonlySet<number> = new Set<number>([
  OPCODES.CLOCK_PING,
  OPCODES.REEL,
]);
