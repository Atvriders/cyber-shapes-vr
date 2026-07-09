/**
 * netClient.ts — NetClient: WebSocket integration layer (B5)
 *
 * Connects the local ShapeStore to the server via JSON WebSocket messages.
 *
 * Design notes:
 * - _applying guard: when we receive a server message and mutate the store, we set
 *   _applying=true around those mutations. The onEvent callback (onLocalStoreEvent)
 *   checks this flag and skips echoing events back to the server — preventing
 *   infinite echo loops.
 * - Server ids: ShapeStore.spawn now honors init.id if provided. NetClient passes
 *   the server's NetShape.id when applying welcome/spawn messages so the local
 *   shape id matches the server's canonical id.
 * - Despawn from client: the client does NOT send a 'despawn' ClientMsg. Shape
 *   removal is server-authoritative (eviction due to max-shapes cap on the server).
 *   A local eviction (from ShapeStore's maxShapes) while connected is suppressed
 *   at the onLocalStoreEvent handler because that despawn was triggered by the
 *   store's internal eviction logic — not a direct user action. This is safe:
 *   the server will also evict when it reaches its own cap.
 * - WebSocket: accessed via globalThis.WebSocket so tests can stub it.
 * - Time source: injectable via opts.now, defaults to performance.now(). Never
 *   calls Date.now() at module scope.
 */

import type { ShapeStore, ShapeEvent } from '../world.js';
import type {
  ClientMsg,
  ServerMsg,
  NetShape,
  Vec3,
  Pose,
  PhysicsParams,
  PongFields,
} from '@cyber-shapes/shared';
import {
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  packVoice,
  unpackVoice,
  isVoiceFrame,
  voiceOpcodeOf,
  VOICE_OPUS,
  VOICE_WEBM,
  VOICE_PCM,
  SHOWPIECE_KIND,
  encodeBinary,
  decodeBinary,
  OPCODES,
  MUSIC_KIND,
  SINGLE_KIND,
  TELEKINESIS_KIND,
} from '@cyber-shapes/shared';
import { createInterpolator, type Interpolator, type StateFrame } from './interpolation.js';
import type { MusicFrame } from '../music/musicScheduler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HELD_THROTTLE_MS = 50;
const DEFAULT_POSE_THROTTLE_MS = 100;

/** Sentinel used to identify locally-originated grabs vs. remote grabs. */
export const LOCAL_PEER_ID = '__local__';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetClientOpts {
  onPose?: (id: string, pose: Pose) => void;
  /**
   * A remote player joined. `synthetic` is true for a §7.17 DAEMON (C28) — the
   * caller renders a drone + DAEMON badge and MUST NOT fire the human JOIN_CRANE.
   */
  onPlayerJoin?: (id: string, name: string, color: number, synthetic?: boolean) => void;
  onPlayerLeave?: (id: string) => void;
  /** Task C28 (F17 Daemon Crew): the distinct "DMN-07 ONLINE" glitch banner (§7.17). */
  onDaemonBanner?: (callsign: string) => void;
  onVoice?: (senderId: number, tsMs: number, bytes: Uint8Array, flags: number) => void;
  /**
   * Task C22 (F8 Resonora, §7.8): a decoded MUSIC (0x29) frame — a CLOCK (the
   * shared bpm/beat/grid) or a NOTE (one scored floor impact). The caller's
   * MusicScheduler updates the grid / SCHEDULES the note on the beat via the app's
   * existing AudioContext (never a second one). Fired only when the server's
   * generative score is live; a room without a Conductor never invokes it.
   */
  onMusic?: (frame: MusicFrame) => void;
  /**
   * Task C22 (C3 clock sync): a decoded CLOCK_PONG (0x31). The caller's ClockSyncer
   * consumes it (`syncer.onPong(fields)`) to maintain the smoothed client→server
   * offset that feeds {@link serverNow}. The netClient only DECODES + routes — the
   * offset math lives in the shared syncer.
   */
  onClockPong?: (fields: PongFields) => void;
  getLocalPose?: () => Pose;
  /**
   * Called when a locally-predicted shape is re-keyed from its temp id to the
   * server's canonical id (B6 spawn reconciliation). Lets controllers/main update
   * any tracked held id so a spawned-then-immediately-grabbed shape keeps working.
   */
  onRekey?: (oldId: string, newId: string) => void;
  /**
   * Called once when the server 'welcome' has been received (audit #22). Lets the
   * loop switch to server-driven mode only after the initial snapshot arrives,
   * rather than on raw socket OPEN (which would freeze seeded shapes in the gap).
   *
   * Task C22 (carry #1, laws-chip-on-join): `baseParams` is the welcome's
   * ADDITIVE STANDING-law field (the room's elected law, or DEFAULT_PARAMS —
   * absent on an older server). The desktop HUD paints the laws chip from THIS
   * on join, rather than waiting for the next VOTE_RESULT (which may never
   * come this session on a tie/no-vote re-open).
   */
  onWelcome?: (baseParams?: PhysicsParams) => void;
  /**
   * Called on every ENV_STATE (spec §7.3, C11) — the Reality-Dials broadcast +
   * the late-join snapshot's env. Carries the EFFECTIVE PhysicsParams the world is
   * stepping under; `params.freeze` drives the client freeze render-pause (the loop
   * pauses autonomous rotation/bob while frozen — §5.6/§7.3).
   */
  onEnvState?: (env: {
    serverTimestamp: number;
    mode: string | null;
    params: PhysicsParams;
    endsAt: number | null;
  }) => void;
  /**
   * Task C16: called on every SHOWPIECE broadcast (F6 Meteor Siege) — START/STATE/
   * END/MET_LAUNCH. The stage renders the crystal cam + oversized HP bar + callout;
   * the headset HUD shows the bar. Carries the raw `showpiece` ServerMsg.
   */
  onShowpiece?: (msg: Extract<ServerMsg, { t: 'showpiece' }>) => void;
  /**
   * Task C20 (F9 Reality Channels): called on every THEME_SET broadcast (spec §5.2
   * row 0x24). `themeId` is the reality to apply, `transitionAtServerTime` the
   * (roomEpoch-relative) server time the flip lands, `glitch` whether to play the
   * ≤ 500 ms comfort mini-glitch on a snap/late cut. The caller's ThemeApplier
   * schedules/applies the theme; the palette LUT never touches avatar colors.
   */
  onThemeSet?: (themeId: string, transitionAtServerTime: number, glitch: boolean) => void;
  /**
   * Task C17 (F7 Titan Protocol): called on every PLAYER_SCALE broadcast (spec
   * §7.7). `peerId` is the titan (or reverting) player, `scale` the target (1→5,
   * 10, or 1), `durationMs` the ease window. `isSelf` is true when the peerId is
   * THIS client's own id — the caller then eases the LOCAL rig; otherwise it scales
   * the REMOTE avatar (presence playerScale). Fired only when a titan changes, so a
   * non-titan session never invokes it (rig-scale-1 parity).
   */
  onPlayerScale?: (peerId: string, scale: number, durationMs: number, isSelf: boolean) => void;
  /**
   * Task C16 (accommodation #4): called when the server rejects a grab (GRAB_REJECTED
   * — a siege catch that missed the rewind window, or a lost grab-arbitration). The
   * client rolls back a predicted siege catch before invoking this.
   */
  onGrabRejected?: (id: string, by: string | null) => void;
  /**
   * Task C33 (F22 Desktop Command): the Showrunner PHASE_STATE heartbeat (spec
   * §5.5 / §7.22). Residents receive it (the §5.1 widen). The desktop HUD renders
   * the phase + extrapolates the countdown from `remainingMs` (drift-proof).
   */
  onPhaseState?: (phase: string, endsAt: number | null, remainingMs: number | null) => void;
  /**
   * Task C33: a VOTE ServerMsg (OPEN / TALLY / RESULT — the CAST kind is client→
   * server). The desktop HUD ballot widget renders the options + tally and the
   * elected law. Carries the raw `vote` ServerMsg fields.
   */
  onVote?: (msg: Extract<ServerMsg, { t: 'vote' }>) => void;
  /**
   * Task C33: the staff/room roster (spec §5.4). The desktop HUD renders callsigns
   * + tiers ONLY — never `rttMs` (a director/spectator surface, §5.1 footnote).
   */
  onRoster?: (entries: Extract<ServerMsg, { t: 'roster' }>['entries']) => void;
  heldThrottleMs?: number;
  poseThrottleMs?: number;
  /** Injectable time source for throttling (defaults to performance.now). */
  now?: () => number;
  /**
   * Task C16: an estimate of the SERVER's clock (ms, roomEpoch-relative) for the
   * Meteor Siege lag-comp anchor. A siege grab intent stamps `clientTimestamp` with
   * this so the server rewinds to the position the player SAW. Defaults to `now`
   * (a room without the C3 clock sync still round-trips a coherent timestamp).
   */
  serverNow?: () => number;
}

// ---------------------------------------------------------------------------
// NetClient
// ---------------------------------------------------------------------------

export class NetClient {
  private readonly store: ShapeStore;
  readonly opts: NetClientOpts;
  private readonly now: () => number;
  /** Task C16: server-time estimate for the siege lag-comp anchor (see opts). */
  private readonly _serverNow: () => number;

  private _ws: WebSocket | null = null;
  private _playerId: string | null = null;

  /**
   * True once the server 'welcome' has arrived (audit #22). The game loop uses
   * this (not raw socket OPEN) to decide when the server is authoritative, so
   * seeded/offline shapes keep running local physics in the OPEN-before-welcome
   * window instead of freezing.
   */
  private _welcomeReceived = false;

  /** Guard: true while applying inbound server messages to the store. */
  private _applying = false;

  /**
   * The C0-frozen interpolation layer. NetClient is the StateSource: it feeds
   * each inbound `state` message to `_emitState`, which the interpolator ingested
   * at construction. Per-shape SnapshotBuffers now live INSIDE the interpolator
   * (parity with the old inline `_snapshots` map — see interpolation.test.ts).
   */
  private readonly _interp: Interpolator;
  /** The interpolator's frame listener (set synchronously in the constructor). */
  private _emitState: ((frame: StateFrame) => void) | null = null;

  /** Throttle tracking for 'held' messages. */
  private _lastHeldMs = 0;
  /** Throttle tracking for 'pose' messages. */
  private _lastPoseMs = 0;

  /**
   * Task C16 (F6 Meteor Siege). Ids of live siege meteors (learned from the
   * SHOWPIECE MET_LAUNCH ticker + cleared on SHOWPIECE_END). A grab of one of these
   * is a LAG-COMPENSATED catch: the intent carries a `clientTimestamp` (the server-
   * time the player SAW the meteor) + a `grabPoint` (the hand/shape position), the
   * client PREDICTS the attach locally, and ROLLS BACK on a `grab-rejected` echo.
   */
  private readonly _siegeMeteors = new Set<string>();
  /** True while a siege is active → catch-assist (enlarged radius) is on. */
  private _siegeActive = false;
  /** Ids the client optimistically predict-attached, awaiting server confirmation. */
  private readonly _predictedCatches = new Set<string>();

  /**
   * The active inbound-voice callback. Owned internally (not read straight from
   * opts) so callers install/clear it via setOnVoice() rather than mutating
   * `opts` — this closes the async enable/disable race where a late enable()
   * continuation could re-install a stale handler over a disable()'s clear.
   */
  private _onVoice: NetClientOpts['onVoice'] | null = null;

  constructor(store: ShapeStore, opts: NetClientOpts = {}) {
    this.store = store;
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    // Task C16: the server-time estimate for the siege lag-comp anchor (falls back
    // to the local clock when the C3 clock sync is not wired).
    this._serverNow = opts.serverNow ?? (() => this.now());
    // Seed from opts for backward-compatibility; callers may also use setOnVoice.
    this._onVoice = opts.onVoice ?? null;
    // Build the C0-frozen interpolator with THIS client as its StateSource and
    // the same injected clock used for throttling (parity with the old inline
    // `_snapshots` push at `this.now()`).
    this._interp = createInterpolator({
      source: {
        onState: (cb) => {
          this._emitState = cb;
          return () => {
            if (this._emitState === cb) this._emitState = null;
          };
        },
      },
      now: () => this.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get playerId(): string | null {
    return this._playerId;
  }

  isConnected(): boolean {
    return this._ws !== null && this._ws.readyState === /* OPEN */ 1;
  }

  /**
   * Whether the server 'welcome' has been received (audit #22). The loop should
   * only enter server-driven mode when BOTH isConnected() and this are true.
   */
  welcomeReceived(): boolean {
    return this._welcomeReceived;
  }

  /**
   * Install (or clear, with null) the inbound-voice callback. Preferred over
   * mutating `opts.onVoice` directly: Voice.enable()/disable() use this so a
   * late-resolving enable() cannot clobber a disable()'s clear.
   */
  setOnVoice(cb: NetClientOpts['onVoice'] | null): void {
    this._onVoice = cb ?? null;
  }

  /**
   * Open a WebSocket connection to `wsUrl` and send a join message for
   * the given room, name, and avatar color.
   *
   * @param joinSecret Optional HMAC join secret sourced from the room link (e.g.
   *   `?k=<secret>`). When provided, the join message includes `tier:'resident'`
   *   and the `joinSecret` so the server can authorize the privileged tier.
   *   When absent, the join still sends `tier:'resident'` — if the room has no
   *   configured secret (Phase B / dev) the server grants resident; if the room
   *   is a secret-configured booth room, the server downgrades to crowd.
   */
  connect(wsUrl: string, room: string, name: string, color: number, joinSecret?: string): void {
    if (this._ws) {
      this.disconnect();
    }

    const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    const ws = new WS(wsUrl);
    // BLOCKING: inbound binary voice frames MUST arrive as ArrayBuffer, not Blob.
    // Without this the `ev.data instanceof ArrayBuffer` check below is always false
    // and 100% of received voice is silently dropped.
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      // Always send explicit tier:'resident' so secret-configured rooms can
      // authorize via HMAC. Phase B / dev rooms (no configured secret) still grant
      // resident when presented with an explicit tier + no secret.
      const joinMsg: ClientMsg = joinSecret
        ? { t: 'join', room, name, color, protocol: PROTOCOL_VERSION, tier: 'resident', joinSecret }
        : { t: 'join', room, name, color, protocol: PROTOCOL_VERSION, tier: 'resident' };
      this._send(joinMsg);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (isVoiceFrame(ev.data) && ev.data instanceof ArrayBuffer) {
        this._handleBinaryMessage(ev.data);
      } else {
        this._handleMessage(ev.data as string);
      }
    };

    ws.onclose = () => {
      if (this._ws === ws) {
        this._ws = null;
        // Audit #15/#22: connection dropped — return to offline authority so the
        // local evict-oldest cap + local physics resume, and require a fresh
        // welcome before re-entering server-driven mode.
        this._welcomeReceived = false;
        this.store.setServerAuthoritative(false);
      }
    };

    ws.onerror = (err: Event) => {
      console.error('[NetClient] WebSocket error', err);
    };
  }

  /** Close the current WebSocket connection. */
  disconnect(): void {
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.close();
      this._ws = null;
    }
    // Audit #15/#22: reset server-driven state on explicit disconnect too (the
    // onclose handler is cleared above, so do it here).
    this._welcomeReceived = false;
    this.store.setServerAuthoritative(false);
  }

  /**
   * Called by main.ts from the store's onEvent callback.
   * Translates local store changes into outbound ClientMsgs.
   * Skips when _applying (server-originated mutations must not echo back).
   */
  onLocalStoreEvent(e: ShapeEvent): void {
    if (this._applying) return;
    if (!this.isConnected()) return;

    switch (e.kind) {
      case 'spawn': {
        const s = e.shape;
        const position: Vec3 = {
          x: s.group.position.x,
          y: s.group.position.y,
          z: s.group.position.z,
        };
        this._send({
          t: 'spawn',
          shape: {
            type: s.type,
            position,
            colorIndex: s.colorIndex,
            renderMode: s.renderMode,
            scale: s.scale,
          },
          // Client-prediction: carry the local temp id so the server can echo it
          // back and we re-key our predicted shape to the canonical id (rather than
          // creating a duplicate). See the inbound 'spawn' handler.
          tempId: s.id,
        });
        break;
      }

      case 'despawn':
        // Client does NOT send despawn. Server-authoritative only.
        // (See design note in file header.)
        break;

      case 'color':
        this._send({ t: 'recolor', id: e.id, colorIndex: e.colorIndex });
        break;

      case 'render':
        this._send({ t: 'rendermode', id: e.id, mode: e.mode });
        break;

      case 'scale':
        this._send({ t: 'scale', id: e.id, scale: e.scale });
        break;

      case 'grab': {
        if (e.peerId === LOCAL_PEER_ID) {
          // Task C16: a grab of a live siege meteor is a LAG-COMPENSATED catch. The
          // intent carries a `clientTimestamp` (the server-time the player SAW the
          // meteor) + a `grabPoint` (the shape's rendered position). The store's
          // setGrab already predict-attached it locally; we remember it so a
          // `grab-rejected` echo can ROLL BACK the optimistic attach.
          if (this._siegeMeteors.has(e.id)) {
            const shape = this.store.get(e.id);
            const grabPoint: Vec3 | undefined = shape
              ? { x: shape.group.position.x, y: shape.group.position.y, z: shape.group.position.z }
              : undefined;
            this._predictedCatches.add(e.id);
            this._send({
              t: 'grab',
              id: e.id,
              clientTimestamp: this._serverNow(),
              ...(grabPoint ? { grabPoint } : {}),
            });
          } else {
            // A plain grab (Phase B) still carries a clientTimestamp so the lag-comp
            // anchor round-trips uniformly; the server ignores it for non-meteors.
            this._send({ t: 'grab', id: e.id, clientTimestamp: this._serverNow() });
          }
        } else if (e.peerId === null) {
          // Local release — read current transform from the shape
          const shape = this.store.get(e.id);
          if (shape) {
            const position: Vec3 = {
              x: shape.group.position.x,
              y: shape.group.position.y,
              z: shape.group.position.z,
            };
            const rotation: Vec3 = {
              x: shape.group.rotation.x,
              y: shape.group.rotation.y,
              z: shape.group.rotation.z,
            };
            this._send({
              t: 'release',
              id: e.id,
              velocity: shape.velocity,
              position,
              rotation,
            });
          }
        }
        // Remote grabs (peerId !== LOCAL_PEER_ID && peerId !== null) are server-
        // originated and arrive while _applying=true, so they are already skipped.
        break;
      }
    }
  }

  /**
   * Send a throttled 'held' message for the currently-grabbed shape.
   * Call this every frame while a shape is locally held.
   */
  sendHeld(id: string, position: Vec3, rotation: Vec3): void {
    if (!this.isConnected()) return;
    const throttleMs = this.opts.heldThrottleMs ?? DEFAULT_HELD_THROTTLE_MS;
    const t = this.now();
    if (t - this._lastHeldMs < throttleMs) return;
    this._lastHeldMs = t;
    this._send({ t: 'held', id, position, rotation });
  }

  /**
   * Send a throttled 'pose' message using the current local head/hand pose.
   * Call this every frame from the render loop.
   */
  sendPose(): void {
    if (!this.isConnected()) return;
    if (!this.opts.getLocalPose) return;
    const throttleMs = this.opts.poseThrottleMs ?? DEFAULT_POSE_THROTTLE_MS;
    const t = this.now();
    if (t - this._lastPoseMs < throttleMs) return;
    this._lastPoseMs = t;
    const pose = this.opts.getLocalPose();
    this._send({ t: 'pose', pose });
  }

  /**
   * Task C33 (F22 Desktop Command): cast (or SWITCH) this resident's vote for a
   * dial-cue-id `option` (spec §7.22 — residents vote; §5.1 resident Sends includes
   * votes). The server keys the resident on peerId (its voterKey), so no device
   * token is sent — one switchable vote per peerId in the C15 reducer.
   */
  sendVoteCast(option: string): void {
    if (!this.isConnected()) return;
    this._send({ t: 'vote-cast', option });
  }

  /**
   * Send an outbound voice frame (Opus) as a binary WebSocket message.
   *
   * The client always sends senderId=0; the server will stamp the real
   * senderId (the peer's numeric slot) before broadcasting to other peers.
   *
   * Layout: packVoice(VOICE_OPUS, 0, tsMs, flags, bytes) → binary frame.
   */
  sendVoiceFrame(bytes: Uint8Array, tsMs: number, flags: number): void {
    if (!this.isConnected() || !this._ws) return;
    const buf = packVoice(VOICE_OPUS, 0, tsMs, flags, bytes);
    this._ws.send(buf);
  }

  /**
   * Task C22 (C3 clock sync): send a CLOCK_PING (0x30) binary frame. `clientSendMs`
   * is the local clock at send (the server ECHOES it in the PONG so the client can
   * derive RTT + the NTP-lite offset); `lastRttMs` is the last measured RTT (the
   * §5.1-footnote additive field the server records per connection). The PONG
   * arrives at {@link _handleClockPong} → the caller's ClockSyncer. Driven by
   * `createClockSyncer`'s `sendPing` in main.ts. A no-op when disconnected.
   */
  sendClockPing(clientSendMs: number, lastRttMs: number): void {
    if (!this.isConnected() || !this._ws) return;
    const buf = encodeBinary(OPCODES.CLOCK_PING, SINGLE_KIND.ONLY, {
      clientSendMs: clientSendMs >>> 0,
      lastRttMs: Math.max(0, Math.min(0xffff, Math.round(lastRttMs))) & 0xffff,
      reserved: 0,
    });
    this._ws.send(buf);
  }

  // -------------------------------------------------------------------------
  // C32 (F21 Powers Lab, §7.21): the TELEKINESIS (0x34) binary send seam. Fixed-
  // point on the wire (Appendix B): anchor 1 unit = 4 mm; dir 1 unit = 1/32767
  // normalized; vel 1 unit = 1 mm/s. Cone-select + the pull + every safety rail
  // are SERVER-authoritative — the client just streams anchor + cone axis.
  // -------------------------------------------------------------------------

  /** TK_HANDS_STATE: report camera-tracked hands availability (on inputsourceschange). */
  sendTkHandsState(available: boolean): void {
    if (!this.isConnected() || !this._ws) return;
    const buf = encodeBinary(OPCODES.TELEKINESIS, TELEKINESIS_KIND.TK_HANDS_STATE, {
      available: available ? 1 : 0,
      reserved: 0,
    });
    this._ws.send(buf);
  }

  /** TK_PULL: stream a hand's palm ANCHOR (world) + the cone AXIS (need not be unit). */
  sendTkPull(hand: number, anchor: Vec3, dir: Vec3): void {
    if (!this.isConnected() || !this._ws) return;
    const dm = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const q = (v: number, unit: number): number => Math.max(-32767, Math.min(32767, Math.round(v / unit)));
    const buf = encodeBinary(OPCODES.TELEKINESIS, TELEKINESIS_KIND.TK_PULL, {
      hand: hand & 0xff,
      anchor: [q(anchor.x, 0.004), q(anchor.y, 0.004), q(anchor.z, 0.004)],
      dir: [q(dir.x / dm, 1 / 32767), q(dir.y / dm, 1 / 32767), q(dir.z / dm, 1 / 32767)],
      reserved: 0,
    });
    this._ws.send(buf);
  }

  /** TK_RELEASE: end a hand's pull with its pose-history throw velocity (server clamps). */
  sendTkRelease(hand: number, velocity: Vec3): void {
    if (!this.isConnected() || !this._ws) return;
    const q = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v / 0.001)));
    const buf = encodeBinary(OPCODES.TELEKINESIS, TELEKINESIS_KIND.TK_RELEASE, {
      hand: hand & 0xff,
      vel: [q(velocity.x), q(velocity.y), q(velocity.z)],
      reserved: 0,
    });
    this._ws.send(buf);
  }

  /**
   * Sample the interpolated remote transform for a shape at the given
   * render time. Returns null if no snapshot data or unknown id.
   */
  sampleRemote(id: string, renderTime: number): { p: Vec3; r: Vec3 } | null {
    return this._interp.sample(id, renderTime);
  }

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  /**
   * Handle an inbound binary WebSocket message by its FIRST-BYTE opcode demux
   * (Appendix B: byte 0 = opcode). Phase B voice is 0x10–0x12; Phase C mints
   * 0x20–0x3F. The opcode is read WITHOUT decoding so each family routes to its own
   * handler and a stray/future opcode is ignored (great-guard) rather than mis-
   * decoded as voice:
   *   • VOICE_OPUS/WEBM/PCM → onVoice (unchanged voice path).
   *   • MUSIC (0x29)        → {@link _handleMusicFrame} (F8 Resonora, C22).
   *   • CLOCK_PONG (0x31)   → {@link _handleClockPong}  (C3 clock offset, C22).
   *   • anything else       → ignored.
   */
  private _handleBinaryMessage(buf: ArrayBuffer): void {
    const opcode = voiceOpcodeOf(buf); // reads byte 0 (null if the frame is empty)
    if (opcode === null) return;

    if (opcode === VOICE_OPUS || opcode === VOICE_WEBM || opcode === VOICE_PCM) {
      // Voice path — only routed when a voice sink is installed (unchanged).
      if (!this._onVoice) return;
      try {
        const { senderId, tsMs, flags, opus } = unpackVoice(buf);
        this._onVoice(senderId, tsMs, opus, flags);
      } catch (e) {
        console.warn('[NetClient] binary voice frame decode error', e);
      }
      return;
    }

    if (opcode === OPCODES.MUSIC) {
      this._handleMusicFrame(buf);
      return;
    }

    if (opcode === OPCODES.CLOCK_PONG) {
      this._handleClockPong(buf);
      return;
    }
    // Any other binary opcode (a future Phase C family) is ignored.
  }

  /**
   * Task C22 (F8 Resonora): decode a MUSIC (0x29) frame and dispatch the typed
   * CLOCK / NOTE to the music sink (`onMusic`). THROW-SAFE (mirrors the C31 decode-
   * safety discipline): a malformed / short / unknown-kind 0x29 frame is swallowed
   * — it never throws out of ws.onmessage (which would kill the socket bus) and is
   * never dispatched. No Web Audio here; scheduling lives in the MusicScheduler.
   */
  private _handleMusicFrame(buf: ArrayBuffer): void {
    const onMusic = this.opts.onMusic;
    if (!onMusic) return;
    let decoded: ReturnType<typeof decodeBinary>;
    try {
      decoded = decodeBinary(buf);
    } catch {
      // A malformed / truncated / unknown-kind MUSIC frame — ignore (decodeBinary
      // throws on a too-short frame or an (opcode,kind) with no Appendix B layout).
      return;
    }
    if (decoded.opcode !== OPCODES.MUSIC) return;
    const f = decoded.fields;
    if (decoded.kind === MUSIC_KIND.CLOCK) {
      onMusic({
        kind: 'clock',
        bpm: f.bpm as number,
        beatIndex: f.beatIndex as number,
        gridOriginMs: f.gridOriginMs as number,
      });
    } else if (decoded.kind === MUSIC_KIND.NOTE) {
      onMusic({
        kind: 'note',
        noteId: f.noteId as number,
        playAtMs: f.playAtMs as number,
        pitch: f.pitch as number,
        timbre: f.timbre as number,
        velocity: f.velocity as number,
        pan: f.pan as number,
      });
    }
    // Any other MUSIC kind is ignored (additive-safe — a future kind degrades to
    // a no-op rather than a throw).
  }

  /**
   * Task C22 (C3 clock sync): decode a CLOCK_PONG (0x31) and hand the echoed
   * clientSendMs + serverTimeMs to the caller's ClockSyncer via `onClockPong`.
   * THROW-SAFE: a malformed / short pong is swallowed, never crashing the bus.
   */
  private _handleClockPong(buf: ArrayBuffer): void {
    const onClockPong = this.opts.onClockPong;
    if (!onClockPong) return;
    try {
      const { fields } = decodeBinary(buf);
      onClockPong({
        clientSendMs: fields.clientSendMs as number,
        serverTimeMs: fields.serverTimeMs as number,
        reserved: fields.reserved as number,
      });
    } catch {
      // A malformed / short CLOCK_PONG — ignore.
    }
  }

  private _handleMessage(raw: string): void {
    let msg: ClientMsg | ServerMsg;
    try {
      msg = decodeText(raw);
    } catch (err) {
      console.error('[NetClient] failed to decode message', err);
      return;
    }

    const m = msg as ServerMsg;

    // Audit #19: a single try/catch around the whole dispatch so a malformed or
    // compromised server message (missing/wrong-typed fields, e.g. a `state`
    // whose `shapes` is not an array, or a `pose` whose `hands` isn't an array)
    // can NEVER throw out of ws.onmessage and kill the socket handler. Combined
    // with the per-case shape guards below.
    try {
      this._dispatchMessage(m);
    } catch (err) {
      console.warn('[NetClient] error handling server message; ignored', err);
      // Never leave the _applying guard stuck true if a handler threw mid-apply.
      this._applying = false;
    }
  }

  /** Dispatch a decoded server message. Wrapped by _handleMessage's guard (#19). */
  private _dispatchMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        // Guard the collection fields so a malformed welcome can't throw in the
        // for..of loops below (audit #19).
        const shapes = Array.isArray(m.shapes) ? m.shapes : [];
        const players = Array.isArray(m.players) ? m.players : [];
        this._playerId = m.playerId;
        // Audit #15: the server now owns the shape set — suppress local eviction.
        this.store.setServerAuthoritative(true);
        // Audit #22: signal that server-driven mode is now safe (welcome received).
        this._welcomeReceived = true;
        // C22 (carry #1): forward the STANDING baseParams (absent on an older
        // server) so the caller can paint the laws chip correctly on join.
        this.opts.onWelcome?.(m.baseParams);
        // Clear all existing shapes from the store and repopulate from server snapshot.
        this._applying = true;
        try {
          // Remove all current shapes
          for (const s of [...this.store.shapes]) {
            this.store.remove(s.id);
          }
          // Audit #11/21: welcome repopulates the shape set from scratch, so the
          // per-shape snapshot buffers for the OLD set are stale — clear them to
          // avoid a leak (buffers for ids the server no longer broadcasts).
          this._interp.clear();
          // Spawn each server shape with its authoritative id
          for (const ns of shapes) {
            this._applyNetShape(ns);
          }
          // Fire player-join callbacks for existing players (excluding self — the
          // local player must NOT be rendered as a remote avatar).
          for (const p of players) {
            if (p.id !== m.playerId) {
              this.opts.onPlayerJoin?.(p.id, p.name, p.color, p.synthetic);
            }
          }
        } finally {
          this._applying = false;
        }
        break;
      }

      case 'spawn':
        this._applying = true;
        try {
          this._applySpawn(m.shape, m.tempId);
        } finally {
          this._applying = false;
        }
        break;

      case 'despawn':
        this._applying = true;
        try {
          this.store.remove(m.id);
          // Audit #11/21: drop the shape's SnapshotBuffer too — otherwise it
          // leaks forever (the despawn handler removed the store shape but left
          // the interpolation buffer keyed under the dead id).
          this._interp.drop(m.id);
        } finally {
          this._applying = false;
        }
        break;

      case 'recolor':
        this._applying = true;
        try {
          this.store.setColor(m.id, m.colorIndex);
        } finally {
          this._applying = false;
        }
        break;

      case 'rendermode':
        this._applying = true;
        try {
          this.store.setRenderMode(m.id, m.mode);
        } finally {
          this._applying = false;
        }
        break;

      case 'scale':
        this._applying = true;
        try {
          this.store.setScale(m.id, m.scale);
        } finally {
          this._applying = false;
        }
        break;

      case 'grab':
        this._applying = true;
        try {
          this.store.setGrab(m.id, m.peerId);
        } finally {
          this._applying = false;
        }
        break;

      case 'state': {
        // Audit #19: guard the collection so a malformed 'state' (shapes not an
        // array) can't throw in the for..of. Combined with the outer try/catch.
        const stateShapes = Array.isArray(m.shapes) ? m.shapes : [];
        // C0 Step 3: feed the frame to the interpolator (which stamps it with
        // the injected clock and owns the per-shape SnapshotBuffers). Parity with
        // the old inline push at `this.now()`. The additive serverTick / per-shape
        // `s` (impactSpeed) fields ride along untouched — consumed by later tasks.
        this._emitState?.({ shapes: stateShapes });
        break;
      }

      case 'pose':
        this.opts.onPose?.(m.id, m.pose);
        break;

      case 'player-join':
        this.opts.onPlayerJoin?.(m.player.id, m.player.name, m.player.color, m.player.synthetic);
        break;

      // Task C28 (F17 Daemon Crew): the distinct "DMN-07 ONLINE" glitch banner — NOT
      // the human join-crane (a daemon join never fires the crane ceremony, §7.17).
      case 'daemon-banner':
        this.opts.onDaemonBanner?.(m.callsign);
        break;

      case 'player-leave':
        this.opts.onPlayerLeave?.(m.id);
        break;

      case 'voice-roster':
      case 'voice-state':
        // JSON voice control messages (roster/mute state) are no longer
        // forwarded via onVoice — binary Opus frames arrive via _handleBinaryMessage.
        // If a future feature needs roster events, wire a separate callback.
        break;

      case 'env-state':
        // C11 Reality Dials: hand the effective params (incl. the freeze flag) to
        // the render loop. No store mutation — the server owns transforms; this only
        // drives the client freeze render-pause + the cosmetic dial grade.
        this.opts.onEnvState?.({
          serverTimestamp: m.serverTimestamp,
          mode: m.mode,
          params: m.params,
          endsAt: m.endsAt,
        });
        break;

      // Task C33 (F22 Desktop Command): the desktop HUD surfaces. A resident
      // receives PHASE_STATE (the §5.1 widen), VOTE broadcasts, and — when it
      // requests one — the roster. All render-only; no store mutation.
      case 'phase-state':
        this.opts.onPhaseState?.(m.phase, m.endsAt, m.remainingMs);
        break;

      case 'vote':
        this.opts.onVote?.(m);
        break;

      case 'roster':
        this.opts.onRoster?.(m.entries);
        break;

      case 'theme-set':
        // C20 Reality Channels: hand the theme flip to the client's ThemeApplier.
        // No store mutation — a theme change is a cosmetic grid/palette/sky grade;
        // the palette LUT never touches the avatar color channel (§5.6/§6.5).
        this.opts.onThemeSet?.(m.themeId, m.transitionAtServerTime, m.glitch);
        break;

      // Task C16 accommodation #4: a broadcastable GRAB_REJECTED. For a siege catch
      // the client PREDICT-attached the meteor; a rejection ROLLS BACK the optimistic
      // attach (the server rewind said the grab missed). For a normal grab-rejected
      // the loser simply never held it — a no-op locally.
      case 'grab-rejected':
        if (this._predictedCatches.has(m.id)) {
          this._predictedCatches.delete(m.id);
          this._applying = true;
          try {
            this.store.setGrab(m.id, null); // undo the predicted attach
          } finally {
            this._applying = false;
          }
        }
        this.opts.onGrabRejected?.(m.id, m.by);
        break;

      // Task C16 (F6 Meteor Siege): the SHOWPIECE family (crystal cam + HP bar +
      // narration callouts). START/STATE/END drive the client siege HUD; MET_LAUNCH
      // tags a meteor id so a grab of it becomes a lag-comp catch.
      case 'showpiece': {
        const kind = m.kind;
        if (kind === SHOWPIECE_KIND.START) {
          this._siegeActive = true;
          this._siegeMeteors.clear();
          this._predictedCatches.clear();
        } else if (kind === SHOWPIECE_KIND.MET_LAUNCH) {
          if (typeof m.meteorId === 'string') this._siegeMeteors.add(m.meteorId);
        } else if (kind === SHOWPIECE_KIND.END) {
          this._siegeActive = false;
          this._siegeMeteors.clear();
          this._predictedCatches.clear();
        }
        this.opts.onShowpiece?.(m);
        break;
      }

      // Task C17 (F7 Titan Protocol): a headset player's rig scale changed. Route
      // to main.ts, flagging whether the peerId is THIS client (ease the local rig)
      // or a remote (scale the remote avatar via presence playerScale).
      case 'player-scale':
        this.opts.onPlayerScale?.(
          m.peerId,
          m.scale,
          m.durationMs,
          m.peerId === this._playerId
        );
        break;

      case 'error':
        console.error(`[NetClient] server error ${m.code}: ${m.message}`);
        break;

      default:
        // Unrecognised message type — ignore silently.
        break;
    }
  }

  /** Task C16: true while a Meteor Siege is live → controllers enable catch-assist. */
  isSiegeActive(): boolean {
    return this._siegeActive;
  }

  /** Task C16: true iff `id` is a live siege meteor (a catchable target). */
  isSiegeMeteor(id: string): boolean {
    return this._siegeMeteors.has(id);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Handle an inbound 'spawn' with optional tempId echo (B6 reconciliation).
   *
   * If `tempId` is present AND a locally-predicted shape with id === tempId exists,
   * this is the server confirming OUR spawn: re-key the existing shape to the
   * canonical id (no duplicate), move/create its SnapshotBuffer under the canonical
   * id, and reconcile the server-authoritative fields onto the SAME object.
   *
   * Otherwise (no tempId, or no local match → a remote peer's spawn), create a new
   * shape from the NetShape as before.
   */
  private _applySpawn(ns: NetShape, tempId?: string): void {
    if (tempId !== undefined && this.store.get(tempId) && !this.store.get(ns.id)) {
      const rekeyed = this.store.rekey(tempId, ns.id);
      if (rekeyed) {
        // Move any interpolation buffer that was keyed under the temp id (rare,
        // but safe). The interpolator lazily creates one under the canonical id
        // on the next `state`, so no explicit "ensure exists" is needed.
        this._interp.rekey(tempId, ns.id);
        // Reconcile server-authoritative fields onto the existing object.
        this._reconcileShape(ns);
        // Let controllers/main learn the new id (spawned-then-grabbed case).
        this.opts.onRekey?.(tempId, ns.id);
        return;
      }
    }
    // Remote peer spawn (or no matching local prediction): create anew.
    this._applyNetShape(ns);
  }

  /**
   * Reconcile the server-authoritative fields of an existing (already-present)
   * shape from a NetShape. Uses the store's mutators where they exist (so cosmetics
   * apply) but stays under the _applying guard, and writes position/rotation onto
   * the THREE group directly. Does NOT create or remove shapes.
   */
  private _reconcileShape(ns: NetShape): void {
    const shape = this.store.get(ns.id);
    if (!shape) return;
    this.store.setColor(ns.id, ns.colorIndex);
    this.store.setRenderMode(ns.id, ns.renderMode);
    this.store.setScale(ns.id, ns.scale);
    this.store.setGrab(ns.id, ns.grabbedBy);
    shape.bobPhase = ns.bobPhase;
    shape.rotSpeed = ns.rotSpeed;
    shape.velocity = ns.velocity;
    shape.grounded = ns.grounded;
    shape.group.position.set(ns.position.x, ns.position.y, ns.position.z);
    shape.group.rotation.set(ns.rotation.x, ns.rotation.y, ns.rotation.z);
  }

  /**
   * Apply a NetShape from the server to the local store.
   * Passes the server's id so ShapeStore.spawn uses it instead of idFactory.
   */
  private _applyNetShape(ns: NetShape): void {
    const shape = this.store.spawn({
      id: ns.id,
      type: ns.type,
      colorIndex: ns.colorIndex,
      renderMode: ns.renderMode,
      scale: ns.scale,
      grabbedBy: ns.grabbedBy,
      grounded: ns.grounded,
      bobPhase: ns.bobPhase,
      rotSpeed: ns.rotSpeed,
      velocity: ns.velocity,
    } as Parameters<ShapeStore['spawn']>[0] & { id: string });

    // Apply the server's position/rotation to the THREE group.
    shape.group.position.set(ns.position.x, ns.position.y, ns.position.z);
    shape.group.rotation.set(ns.rotation.x, ns.rotation.y, ns.rotation.z);
    // The interpolator lazily creates this shape's buffer on its first `state`
    // frame — no pre-seeding required (parity: the old buffer held no samples
    // until the first state either).
  }

  private _send(msg: ClientMsg): void {
    if (!this.isConnected() || !this._ws) return;
    this._ws.send(encodeText(msg));
  }
}
