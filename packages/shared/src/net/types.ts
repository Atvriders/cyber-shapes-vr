import type { ShapeType, RenderMode } from '../types.js';
import type { Tier } from '../tiers.js';
// Type-only (erased) import — a reel is a plain data model in `reels.ts`, which
// type-imports back from here. TS type-only imports never form a runtime cycle.
import type { Reel, ReelSummary } from '../reels.js';

export const MAX_PLAYERS = 8;
export const PROTOCOL_VERSION = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

// Full serializable shape state (superset of Phase A Shape: adds position+rotation as plain data)
export interface NetShape {
  id: string;
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  grabbedBy: string | null;
  grounded: boolean;
  bobPhase: number;
  rotSpeed: Vec3;
  position: Vec3;
  rotation: Vec3;
  velocity: Vec3;
}
export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
  /**
   * Task C17 (F7 Titan Protocol) — ADDITIVE presence field. The remote player's
   * rig scale (spec §7.7): 1 for a normal player, 5 (or 10) while titanized. The
   * avatar renderer multiplies the remote avatar's scale by this (+ nameplate
   * clamp). Absent/undefined ≡ 1 (a Phase B / non-titan presence is byte-compatible).
   */
  playerScale?: number;
  /**
   * Task C28 (F17 Daemon Crew) — ADDITIVE presence flag (spec §7.17). True iff this
   * peer is a server-hosted synthetic DAEMON (a `DMN-` callsign), NEVER a human.
   * The remote-avatar renderer draws a drone + DAEMON badge for it, and a banked
   * reel PRESERVES the flag so a daemon replays with its badge (§6.1/§7.17).
   * Absent/undefined ≡ a real human (Phase B / non-daemon presence is byte-compatible).
   */
  synthetic?: boolean;
}
export interface Pose {
  head: { p: Vec3; q: Quat };
  hands: Array<{ p: Vec3; q: Quat } | null>;
}

// Client -> Server
export type ClientMsg =
  // Phase C (Task C2): the join handshake gains a tier negotiation. All new
  // fields are OPTIONAL — a Phase B client that omits them joins as `resident`
  // (the Phase B invariant), so existing clients are byte-compatible.
  //  - `tier`          : requested connection tier (spec §5.1). Absent → resident.
  //  - `joinSecret`    : the per-room join secret (provisionally STAFF_KEY env;
  //                       C4 rebinds to an ownerToken-derived HMAC). Required for
  //                       resident/spectator/director; absent/invalid on a
  //                       privileged request → DOWNGRADE to crowd (never reject).
  //  - `requestedName` : an INDEX into CURATED_WORDLIST (never free text). Invalid
  //                       index → a random callsign. The server always overwrites
  //                       the presence `name` with the assigned callsign at join.
  | {
      t: 'join';
      room: string;
      name: string;
      color: number;
      protocol: number;
      tier?: Tier;
      joinSecret?: string;
      requestedName?: number;
      // Phase C (Task C4): the staff ownerToken (spec §5.4). Presented in the
      // join payload over wss (NEVER in a URL); grants DIRECTOR_CMD on ANY tier
      // (and BUILD on a resident). Constant-time compared against the persisted
      // token hash. Absent for every public/participant join.
      ownerToken?: string;
    }
  | {
      t: 'spawn';
      shape: {
        type: ShapeType;
        position: Vec3;
        colorIndex?: number;
        renderMode?: RenderMode;
        scale?: number;
      };
      tempId?: string;
    }
  // Phase C (Task C16): a grab carries an OPTIONAL `clientTimestamp` (ms since the
  // per-room roomEpoch) — the lag-comp anchor for Meteor Siege catches (§7.6) — and
  // an OPTIONAL `grabPoint` (the defender's hand position in world metres at grab).
  // The server validates a siege catch against the meteor's REWOUND position at the
  // timestamp vs the grab point (a 100 ms-late grab lands). Both absent on a Phase B
  // grab (backward-compat); a regular grab ignores them.
  | { t: 'grab'; id: string; clientTimestamp?: number; grabPoint?: Vec3 }
  | { t: 'release'; id: string; velocity: Vec3; position: Vec3; rotation: Vec3 }
  // Phase C (Task C16): the F6 Meteor Siege slingshot intent (spec §7.6 / OPCODES.
  // SHOWPIECE 0x27, MET_LAUNCH kind). A phone (wisp/crowd tier) fires a meteor at
  // the crystal. The server NEVER trusts `power`: the meteor speed is CLAMPED to
  // 6–8 m/s (anti-cheat) + rate-limited to 1/3 s. JSON-after-preamble (0x27 is a
  // cold JSON family per Appendix B's scope rule — no binary layout).
  | {
      t: 'met-launch';
      origin: Vec3;
      aim: Vec3;
      power?: number;
      colorIndex?: number;
    }
  // Phase C (Task C16): the F6 client-claimed swat (MET_HIT kind). A hand sweep
  // deflects a meteor; the server plausibility-checks it against the same rewind
  // buffer (hand near the meteor at `clientTimestamp`). Server-authoritative.
  | {
      t: 'met-hit';
      meteorId: string;
      handPoint: Vec3;
      clientTimestamp: number;
    }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  | { t: 'held'; id: string; position: Vec3; rotation: Vec3 } // streamed while holding (throttled)
  | { t: 'pose'; pose: Pose } // throttled
  | { t: 'voice-join' }
  | { t: 'voice-leave' }
  | { t: 'voice-state'; speaking: boolean; muted: boolean }
  | { t: 'voice-config'; config: string }
  // Phase C (Task C4): a staff DIRECTOR command (spec §5.4). Only a connection
  // that presented the room's ownerToken at join may issue one (any tier). The
  // JSON `director-cmd` is the transport until the 0x22 DIRECTOR/CMD binary kind
  // wires in (C9/C10). `cmd` is the incident/staff verb; per-cmd fields:
  //  - ROTATE_SECRET | DOOR_CLOSE | ROSTER | NOOP : no extra fields
  //  - ROTATE_LINK : `confirm?: boolean` (confirm-twice — first call asks again)
  //  - MUTE | UNMUTE | KICK : `targetId: string` (the peerId to act on)
  //  - FIRE (Task C10) : `cueId: string` + `cueInstanceId: string` (client-generated;
  //                      the server dedupes on it, §5.5) — fire a CUE_CATALOG cue.
  //  - ADVANCE | HOLD | RESET (Task C10) : timeline controls (Space/H/R hotkeys).
  | {
      t: 'director-cmd';
      cmd: string;
      targetId?: string;
      confirm?: boolean;
      cueId?: string;
      cueInstanceId?: string;
      /** HOLD extends the current timed phase by this many ms (default 60 s). */
      holdMs?: number;
      /**
       * Task C17: TITANIZE target rig scale (spec §7.7) — the default (5) SHOW
       * button omits it; the "bigger" (10) Advanced button sends `scale: 10`.
       */
      scale?: number;
    }
  // Phase C (Task C12): the Neon Guestbook GLYPH_ADD (spec §7.13 / OPCODES.GLYPH
  // 0x2B, ADD kind). A crowd-tier scribe draws a stroke (≤ 32 resampled points in
  // normalised [-1,1] space) + a hex color; the server validates, assigns an id +
  // a deterministic spiral-shell slot + the sender's CALLSIGN (never free text),
  // writes it to the guestbook bucket, and broadcasts a `glyph`. JSON-after-preamble
  // transport (0x2B is a cold JSON family per Appendix B's scope rule).
  | { t: 'glyph-add'; points: Array<{ x: number; y: number }>; color: string }
  // Phase C (Task C14): the F4 WISP_PULSE intent (spec §7.4 / OPCODES.WISP 0x26,
  // PULSE kind). A wisp fires a server-clamped radial impulse at an aimed point.
  // JSON-after-preamble transport — WISP_PULSE has NO Appendix B binary layout
  // (only WISP_POSE does), so per the scope rule it is a cold JSON family. The
  // server NEVER trusts `magnitude`: it is CLAMPED (anti-cheat) + rate-limited to
  // 2/s. `pos` is the epicenter in metres (world space). Unclamped feedback
  // (tracer/flash/shockwave) is a client concern and never rides this message.
  | { t: 'wisp-pulse'; pos: { x: number; y: number; z: number }; magnitude: number }
  // Phase C (Task C15): the F5 Reality Referendum VOTE_CAST intent (spec §7.5 /
  // OPCODES.VOTE 0x25, CAST kind). A crowd-tier (or resident) ballot casts — or
  // SWITCHES — its vote for a dial-cue-id `option`. One switchable vote per opaque
  // voter key (device token on phones, peerId on residents — the server keys on
  // peerId here; the phone's localStorage token is a client-side anti-stuff hint).
  // JSON-after-preamble transport (0x25 is a cold JSON family per the scope rule).
  | { t: 'vote-cast'; option: string }
  // Phase C (Task C19): the F12 Supernova Encore CHARGE TAP (spec §7.13). A phone
  // taps to charge the supernova (the PRIMARY input; DeviceMotion shake is an
  // opt-in client garnish that maps to the SAME intent). Debounced ≤ 5/s + crowd-
  // size NORMALIZED server-side — the client never sends a charge value, only the
  // tap event. JSON-after-preamble (the crowd tier's charge intent). No-op when no
  // encore is armed. Crowd (or resident) tier.
  | { t: 'charge-tap' }
  // Phase C (Task C22, F10 Ghost Arcade): the REEL transport (spec §7.10). The
  // 0x2C REEL family carried on the spectator/staff send-whitelist (`reel-*`).
  // Three read/staff verbs — NO world mutation ever rides them:
  //  - `reel-bank` : STAFF/cue-driven — bank the recorder's current best highlight
  //                  window as a replayable reel. CAPABILITY-GATED (a director/
  //                  ownerToken connection only — the C4 pattern); a non-staff bank
  //                  is refused (`reel-ack {ok:false}`), never a mutation.
  //  - `reel-list` : list the day's banked reels (metadata only) — the stage/staff
  //                  menu. Spectator/director-scoped.
  //  - `reel-play` : fetch a banked reel's frames to DRIVE the ATTRACT ghost
  //                  playback (`reelId` omitted → the most-recent banked reel).
  //                  Read-only; spectator/director-scoped. The played ghosts are
  //                  already anonymized at record time (callsigns/GHOST_XX, §6.1).
  | { t: 'reel-bank' }
  | { t: 'reel-list' }
  | { t: 'reel-play'; reelId?: string }
  // Phase C (Task C34): the F23 Workshop BUILD family (spec §7.23 / OPCODES.BUILD
  // 0x35). One ClientMsg carries all mutating + query kinds via a discriminating
  // `kind` byte (BUILD_KIND: SET_TRANSFORM 0 / SPAWN_EXACT 1 / DELETE 2 / ACK 3 /
  // LAYOUT_SAVE 4 / LAYOUT_LOAD 5 / LAYOUT_LIST 6 / SET_BASELINE 7 / GLYPH_SEED 8).
  // JSON-after-preamble (0x35 is a cold JSON family per Appendix B's scope rule).
  // `opId` is the client's opaque op correlation id (echoed in the ACK for undo).
  // The whole family is CAPABILITY-GATED (a resident presenting the ownerToken)
  // and the MUTATING kinds are additionally refused unless build-mode is ACTIVE —
  // both gates are connection-layer concerns (a stale tab can never wipe a live
  // rotation, §7.23). The per-kind payload is validated in the server handler.
  | {
      t: 'build';
      kind: number;
      opId?: string;
      /** SET_TRANSFORM / DELETE target shape id. */
      id?: string;
      /** SPAWN_EXACT / SET_TRANSFORM transform + shape fields (validated in the handler). */
      shape?: unknown;
      /** LAYOUT_SAVE / LAYOUT_LOAD / SET_BASELINE layout name. */
      name?: string;
      /** LAYOUT_LOAD / SET_BASELINE / import: the layout payload (validated in the handler). */
      layout?: unknown;
      /** GLYPH_SEED authored stroke (points + color; validated in the handler). */
      points?: Array<{ x: number; y: number }>;
      color?: string;
    };

// Server -> Client
export type ServerMsg =
  // Phase C (Task C2): the TIER_HELLO reply (Appendix B — JSON after the join
  // handshake). Sent BEFORE the `welcome` snapshot so the client learns its
  // server-assigned callsign, the tier it was actually granted (may be a
  // DOWNGRADE from what it requested), and the per-room roomEpoch (u32 ms base
  // for all Phase C timestamps). `peerId` mirrors `welcome.playerId`.
  | { t: 'hello'; peerId: string; callsign: string; tier: Tier; roomEpoch: number }
  // Phase C (Task C2): a soft DOWNGRADE payload. Sent to a NON-privileged join
  // that was over its tier's cap (e.g. a 25th wisp) — never a hard rejection
  // screen (spec §5.1 over-cap doctrine). `to` is the tier actually granted;
  // the accompanying `hello` carries that same tier. `reason` is advisory.
  | { t: 'downgrade'; from: Tier; to: Tier; reason: string }
  | {
      t: 'welcome';
      playerId: string;
      room: string;
      shapes: NetShape[];
      players: PlayerInfo[];
      // Task C22 (carry #1, laws-chip-on-join): the room's STANDING baseParams
      // (the elected law, or DEFAULT_PARAMS when none stands) — ADDITIVE, never
      // replacing the EFFECTIVE params ENV_STATE already carries in the same
      // join snapshot. Optional so an older server/client pairing round-trips.
      baseParams?: import('../physicsCore.js').PhysicsParams;
    }
  | { t: 'player-join'; player: PlayerInfo }
  | { t: 'player-leave'; id: string }
  | { t: 'spawn'; shape: NetShape; tempId?: string } // tempId: opaque echo of the client's local id for prediction reconciliation
  | { t: 'despawn'; id: string }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  // peerId null = released. Phase C accommodation #5 (spec §3, C0): a RELEASE
  // event (peerId:null) additionally carries the server-computed final transform
  // {pos, vel} so a decimated/replay consumer (C30) has the authoritative rest
  // state without waiting for the next `state` snapshot. Both are OPTIONAL and
  // absent on GRAB events (peerId non-null) — Phase B clients ignore them.
  | { t: 'grab'; id: string; peerId: string | null; pos?: Vec3; vel?: Vec3 }
  // Phase C accommodation #4 (spec §3, C0): a BROADCASTABLE grab-arbitration
  // rejection, emitted ALONGSIDE — never instead of — Phase B's behavior (the
  // loser previously received nothing). `by` is the peer that already holds the
  // shape. The 0x2D binary GRAB_REJECTED opcode is minted in C1; this JSON form
  // is the transport until then. Additive: off by default (see Room.applyIntent).
  | { t: 'grab-rejected'; id: string; peerId: string; by: string | null }
  | {
      t: 'state';
      // Phase C accommodation #2 (spec §3, C0): `serverTick` is the u32 PHYSICS
      // tick counter (30 Hz), distinct from `seq` (the ~15 Hz broadcast counter,
      // Phase B). Replay (C21) keys on serverTick; `seq` keeps Phase B semantics.
      seq: number;
      serverTick: number;
      // Per-shape `s` = accommodation #3 (spec §3, C0): impactSpeed (m/s) present
      // ONLY on the tick a shape struck the floor this frame (consumed by Resonora
      // §7.8 / Chrono Snap §7.11). Absent otherwise; Phase B clients ignore it.
      shapes: Array<{ id: string; p: Vec3; r: Vec3; v: Vec3; s?: number }>;
    } // ~15-20Hz, moving shapes only
  | { t: 'pose'; id: string; pose: Pose } // relayed peer pose
  // Phase C (Task C2): the WISP-tier coalesced state summary (spec §5.1). Wisps
  // NEVER receive the full-rate `state` delta — they get ONE shared, once-
  // serialized ~5 Hz buffer with position-only shape data (no rotation/velocity
  // interpolation payload; a head-only view of the world). The WISP opcode
  // family (0x26) carries this on the wire once C14 lands its codec; the JSON
  // form here is the transport until then. `tick` is the source serverTick.
  // Phase C (Task C14): `wisps` carries the other wisps' head-only poses (their
  // WISP_POSE, decimated into this SAME shared ~5 Hz buffer — serialized ONCE per
  // room per tick, one buffer to every wisp). `wispIndex` is the server-assigned
  // orbit slot; `pos` is fixed-point (1 unit = 4 mm, Appendix B) so it stays
  // integer on the wire; `yaw` is the u16-scaled heading. A wisp renders every
  // OTHER wisp from this array — never a per-peer pose relay.
  | {
      t: 'wisp-coalesced';
      tick: number;
      shapes: Array<{ id: string; p: Vec3 }>;
      wisps?: Array<{ wispIndex: number; pos: [number, number, number]; yaw: number }>;
    }
  | { t: 'voice-roster'; players: Array<{ id: string; voice: boolean }> }
  | { t: 'voice-state'; id: string; speaking: boolean; muted: boolean }
  // Phase C (Task C4): acknowledgement of a `director-cmd`. Per-cmd payload:
  //  - ROTATE_SECRET : `epoch` (the new epoch)
  //  - ROTATE_LINK   : `confirmRequired: true` (first call) OR `newRoomId` +
  //                    `newOwnerToken` (confirmed call)
  //  - others        : bare ack (`cmd` echoed)
  | {
      t: 'director-ack';
      cmd: string;
      epoch?: number;
      confirmRequired?: boolean;
      newRoomId?: string;
      newOwnerToken?: string;
    }
  // Phase C (Task C4): the staff roster (spec §5.4) — sent to a director/spectator
  // connection on request. Each entry carries join provenance + optional rttMs
  // (director + spectator tiers only, ≤1 Hz on material change).
  | {
      t: 'roster';
      entries: Array<{
        id: string;
        callsign: string;
        tier: Tier;
        entryRoute: string;
        joinedAt: number;
        rttMs?: number;
      }>;
    }
  // Phase C (Task C10): the Showrunner heartbeat (spec §5.5 / OPCODES.PHASE_STATE
  // 0x21). The 1 Hz + on-change phase state. Fanned out to director + residents
  // (the widen — §5.1; the C25 audience tier is added then). JSON-after-preamble
  // transport (the wire opcode is 0x21; this is the client-facing ServerMsg form).
  | { t: 'phase-state'; phase: string; endsAt: number | null; remainingMs: number | null }
  // Phase C (Task C10): the DIRECTOR family (0x22) delivered to the director tier.
  // `kind` is one of CATALOG / ACK (C29/C31 add STAGE_XRAY / SAVE_CLIP). CATALOG
  // carries the advertised CUE_CATALOG (capability-gated cues, §7.21); the console
  // renders whatever is advertised. Director-tier only.
  | {
      t: 'director-msg';
      kind: string;
      catalog?: Array<{
        id: string;
        label: string;
        tab: 'show' | 'advanced';
        destructive: boolean;
        cooldownMs: number;
        phases: string[];
        comfortCost: number;
      }>;
      /** FIRE result echoed back to the console (ok | cooldown | deduped | wrongPhase | unknown). */
      fireResult?: string;
      cueId?: string;
    }
  // Phase C (Task C11): the Reality-Dials ENV_STATE (spec §7.3 / OPCODES.ENV_STATE
  // 0x23). Carries the EFFECTIVE PhysicsParams the world is stepping under, a human
  // `mode` label the big-screen cue banner renders, and the auto-revert `endsAt`
  // (late-join coherent auto-revert). `params.freeze` is the client freeze
  // render-pause flag (§5.6/§7.3). Fanned out to the audience-union receive set
  // (resident-class + director; + audience when C25 lands). `params` is the plain
  // PhysicsParams data (structurally a Partial with all fields concrete). Included
  // in the late-join snapshot so a joiner lands mid-dial coherently.
  | {
      t: 'env-state';
      serverTimestamp: number;
      mode: string | null;
      params: import('../physicsCore.js').PhysicsParams;
      endsAt: number | null;
    }
  // Phase C (Task C20): the F9 Reality Channels THEME_SET (spec §5.2 row 0x24 /
  // OPCODES.THEME_SET 0x24). Carries the active `themeId`, the absolute server time
  // the transition lands (`transitionAtServerTime` — == now for an immediate snap),
  // and `glitch` (true → play the ≤ 500 ms comfort mini-glitch on a late/snap cut).
  // Fanned out to the audience-union receive set (resident-class + director; +
  // audience when C25 lands). The client's ThemeApplier consumes it. JSON transport.
  | {
      t: 'theme-set';
      themeId: string;
      transitionAtServerTime: number;
      glitch: boolean;
    }
  // Phase C (Task C10): the STATS-phase card (spec §7.2 / OPCODES.STATS_CARD 0x2E).
  // Server-computed, CALLSIGNS ONLY (never a raw name). Fanned out to the resident-
  // class receive set + director (+ audience when C25 lands). JSON transport.
  | {
      t: 'stats-card';
      shapesThrown: number;
      fastestThrow: { callsign: string; value: number } | null;
      topContributor: { callsign: string; value: number } | null;
      dayLeaderboard: Array<{ callsign: string; value: number }>;
      nextInHeadset: string;
    }
  // Phase C (Task C12): the Neon Guestbook GLYPH family (spec §7.13 / OPCODES.GLYPH
  // 0x2B). CALLSIGNS ONLY — never free text on a glyph surface (§6.1). All four are
  // JSON-after-preamble (0x2B is a cold family per Appendix B's scope rule).
  //  - `glyph`        (ADD)   : a birthed glyph, broadcast to the room (all tiers)
  //                             and cached in the late-join snapshot.
  //  - `glyph-ack`    (ACK)   : the scribe's private confirmation — its callsign +
  //                             the ring (slot band) its glyph landed at (closes the
  //                             loop even with no projector; Phase D's exit greeting
  //                             persists it).
  //  - `glyph-remove` (REMOVE): a staff despawn / an evict-oldest at the 512 budget.
  //  - `glyph-hide`   (HIDE)  : the panic-key result — the newest N glyph ids to
  //                             suppress on every screen (still in the bucket).
  | { t: 'glyph'; glyph: GlyphNet }
  | { t: 'glyph-ack'; callsign: string; ring: number }
  | { t: 'glyph-remove'; id: string }
  | { t: 'glyph-hide'; ids: string[] }
  // Phase C (Task C12): the full guestbook backfill sent to a joining full-receive
  // client after `welcome` (chunked render is a client concern — the wire carries
  // the whole set once, capped at the 512 budget).
  | { t: 'glyph-snapshot'; glyphs: GlyphNet[] }
  // Phase C (Task C15): the F5 Reality Referendum VOTE family (spec §7.5 /
  // OPCODES.VOTE 0x25). One ServerMsg carries all four kinds via a discriminating
  // `kind` field (VOTE_KIND: OPEN 0 / CAST 1 / TALLY 2 / RESULT 3):
  //  - OPEN  : a fresh ballot opened — the dial-cue-id options + the deadline so a
  //            late-scanning phone lands on a live ballot (never-dead — §7.5).
  //  - TALLY : the 2 Hz COALESCED live tally (NEVER per-vote — §5.2 row 0x25); the
  //            phone charge meter + the stage dueling bars read this.
  //  - RESULT: the enacted winner ("THE CROWD DECREED") + the cooldown length.
  // Fanned out to the crowd-class receive set + residents + spectator + director.
  // JSON-after-preamble (0x25 is a cold JSON family per the scope rule).
  | {
      t: 'vote';
      kind: number;
      options?: string[];
      tally?: Record<string, number>;
      voterCount?: number;
      winner?: string | null;
      openedAtMs?: number;
      deadlineMs?: number;
      cooldownMs?: number;
      serverTimestamp?: number;
    }
  // Phase C (Task C16): the F6 Meteor Siege SHOWPIECE family (spec §7.6 / OPCODES.
  // SHOWPIECE 0x27). One ServerMsg carries all kinds via a discriminating `kind`
  // (SHOWPIECE_KIND: START 0 / STATE 1 / END 2 / MET_LAUNCH 3 / MET_HIT 4):
  //  - START      : the siege armed — crystalId + hp/maxHp + endsAt (crystal cam +
  //                 oversized HP bar); banner treatment, never the callout queue.
  //  - STATE      : the live HP + at most ONE narration `callout` per 2 s (the
  //                 rate-limited callout queue OWNS showpiece narration — §7.15).
  //  - END        : the end card — outcome ("CRYSTAL STANDS"/"CROWD WINS") + the
  //                 top-3 bombardier callsigns (→ STATS_CARD + queue bridge).
  //  - MET_LAUNCH : a live meteor-launch ticker line (ambient texture).
  //  - WAVE (C27) : the F16 Siege-Waves narrative — {waveIndex, waveEndsAt} ONLY
  //                 (indices/fixed-point, no wave NAME on the wire; the client
  //                 resolves the splash name from the shared SIEGE_WAVES table).
  //                 Purely additive: an older client ignores this kind (§7.16
  //                 unknown-kind-ignore) and still renders a coherent siege.
  // CALLSIGNS ONLY (never a raw name, §6.1). JSON-after-preamble (0x27 is a cold
  // JSON family per Appendix B's scope rule — no binary layout).
  | {
      t: 'showpiece';
      kind: number;
      crystalId?: string;
      hp?: number;
      maxHp?: number;
      endsAt?: number;
      outcome?: string;
      meteorId?: string;
      colorIndex?: number;
      barrage?: boolean;
      callout?: { kind: string; callsign: string };
      topBombardiers?: Array<{ callsign: string; value: number }>;
      /** C27 WAVE: the current wave index into the shared SIEGE_WAVES table. */
      waveIndex?: number;
      /** C27 WAVE: absolute server time (ms) this wave ends (narrative countdown). */
      waveEndsAt?: number;
    }
  // Task C17 (F7 Titan Protocol, opcode 0x28): the headset player's rig scale
  // changed (spec §7.7). `scale` is the TARGET (1→5, or 10, or back to 1 on
  // revert); `durationMs` is the ease window (1.5 s). The client eases the LOCAL
  // rig when `peerId` is self, and multiplies the REMOTE avatar's scale by `scale`
  // otherwise (presence playerScale). A single-kind family (0x28).
  | { t: 'player-scale'; peerId: string; scale: number; durationMs: number }
  // Phase C (Task C32, F21 Powers Lab, opcode 0x34): the server → stage TK TETHER
  // (spec §7.21). The server knows each live pull's hand ANCHOR + pulled shape id,
  // so the stage/desktop renderer draws a neon tether beam from anchor to target —
  // NO joint streaming. `peerId` is the active TK player (null when idle); `pulls`
  // is the ≤ 2 live tethers. The ONLY TK message the CLIENT receives (TK_PULL /
  // TK_RELEASE / TK_HANDS_STATE are client → server binary). Fanned to stage +
  // desktop resident (TK_TETHER_TIERS). Cut-safe: an unknown `t` is ignored.
  | {
      t: 'tk-tether';
      peerId: string | null;
      pulls: Array<{ hand: number; anchor: Vec3; targetId: string }>;
    }
  // Phase C (Task C25, F14 The Gallery): the AUDIENCE_STATE viewer counter (spec
  // §5.2 row 0x32, 0.2 Hz). Carries the live remote-viewer count; the stage reads
  // it for the "N WATCHING · 0 VIDEO FRAMES SENT" line (renders only at N ≥ 5) and
  // each audience client shows its own counter. A cold JSON-after-preamble family
  // (0x32 carries no binary layout — the scope rule). Fanned out to the
  // audience-union receive set (+ spectator/stage for the counter).
  | { t: 'audience-state'; viewerCount: number }
  // Phase C (Task C25): the CACHED late-join keyframe for the `audience` tier
  // (spec §7.14 "served from the recorder's most recent ~10 s keyframe +
  // roll-forward"). A remote viewer NEVER receives the full `welcome` snapshot;
  // instead it lands on this once-serialized world keyframe (all shapes) and rolls
  // forward from the shared 5 Hz coalesced buffer. The SAME cached buffer is sent
  // to every late-joiner — a 128-join Discord burst costs ZERO fresh snapshot
  // serializations (the same-buffer stampede guard). `serverTick` stamps the
  // keyframe's physics tick so the client can align its roll-forward.
  | { t: 'audience-keyframe'; serverTick: number; shapes: NetShape[] }
  // Phase C (Task C34): the F23 Workshop BUILD family server → client message
  // (spec §7.23 / OPCODES.BUILD 0x35). One ServerMsg carries every server-emitted
  // BUILD kind via a discriminating `kind` byte (BUILD_KIND):
  //  - ACK          : echoes the client `opId` + the assigned shape `id` (undo
  //                   correlation — a SPAWN_EXACT's ACK carries the new id) +
  //                   `result` ('ok' | a refusal reason).
  //  - LAYOUT_LIST  : the saved-layout manifest (names + shape counts + which is
  //                   the baseline) — the builder's load menu.
  //  - SET_TRANSFORM/SPAWN_EXACT/DELETE/LAYOUT_LOAD : the mutation is ALSO
  //                   broadcast to build-mode residents so a second builder tab
  //                   stays in sync (last-write-wins). Ordinary world spawn/despawn
  //                   ServerMsgs carry the actual shapes; this is the build echo.
  // Capability-gated on the receive side (build-mode residents + director only).
  | {
      t: 'build-msg';
      kind: number;
      opId?: string;
      id?: string;
      result?: string;
      /** LAYOUT_LIST manifest entries. */
      layouts?: Array<{ name: string; shapeCount: number; baseline: boolean }>;
      /** Build-mode active state (broadcast on enter/exit). */
      buildModeActive?: boolean;
    }
  // Phase C (Task C28, F17 Daemon Crew): the distinct "DMN-07 ONLINE" glitch banner
  // a summoned synthetic peer emits (spec §7.17). This is DELIBERATELY NOT the human
  // JOIN_CRANE ceremony — a daemon join never fires the caster join event nor the
  // crane shot; it gets THIS banner instead (protecting the "every human-shaped ghost
  // is a real player" narration). `callsign` is the DMN- handle. Fanned to the booth
  // tiers (resident/spectator/director/wisp/crowd), never the audience union.
  | { t: 'daemon-banner'; callsign: string }
  // Phase C (Task C22, F10 Ghost Arcade): the REEL transport replies (spec §7.10).
  // All three are anonymized-by-construction (a banked reel is sanitized at record
  // time — callsigns/GHOST_XX only, never a raw name or a voice frame, §6.1):
  //  - `reel-listing` : the day's banked reels (metadata only — {@link ReelSummary}).
  //  - `reel-data`    : the requested reel's frames for ATTRACT playback (or null
  //                     when the bank is empty → the client falls back to the
  //                     scripted day-one shape-ballet). `reelId` echoes which reel.
  //  - `reel-ack`     : the bank/refuse confirmation to the requester (the assigned
  //                     `reelId` on success; a `reason` on a capability refusal —
  //                     never a mutation, so a refusal is inert).
  | { t: 'reel-listing'; reels: ReelSummary[] }
  | { t: 'reel-data'; reelId: string | null; reel: Reel | null }
  | { t: 'reel-ack'; ok: boolean; reelId?: string; reason?: string }
  | { t: 'error'; code: string; message: string };

/**
 * The on-wire glyph shape (spec §7.13). Points are ≤ 32 resampled normalised
 * coords; `slotIndex` maps to a deterministic `spiralSlot` position; `callsign`
 * is the ONLY identity ever on a glyph (§6.1). `seeded` marks the pre-authored
 * gallery (evict-exempt).
 */
export interface GlyphNet {
  id: string;
  callsign: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  slotIndex: number;
  seeded?: boolean;
}

// Binary voice frame (the ONLY binary message): [opcode u8][senderId u8][timestampMs u32 LE][flags u8][opus bytes]
// opcodes: 0x10 VOICE_OPUS, 0x11 VOICE_WEBM, 0x12 VOICE_PCM. Server stamps senderId, fans out to room (excl sender).
