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
import type { ClientMsg, ServerMsg, NetShape, Vec3, Pose } from '@cyber-shapes/shared';
import {
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  packVoice,
  unpackVoice,
  isVoiceFrame,
  VOICE_OPUS,
  VOICE_WEBM,
  VOICE_PCM,
} from '@cyber-shapes/shared';
import { SnapshotBuffer } from './interpolation.js';

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
  onPlayerJoin?: (id: string, name: string, color: number) => void;
  onPlayerLeave?: (id: string) => void;
  onVoice?: (senderId: number, tsMs: number, bytes: Uint8Array, flags: number) => void;
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
   */
  onWelcome?: () => void;
  heldThrottleMs?: number;
  poseThrottleMs?: number;
  /** Injectable time source for throttling (defaults to performance.now). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// NetClient
// ---------------------------------------------------------------------------

export class NetClient {
  private readonly store: ShapeStore;
  readonly opts: NetClientOpts;
  private readonly now: () => number;

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

  /** Per-shape SnapshotBuffers keyed by server shape id. */
  private readonly _snapshots = new Map<string, SnapshotBuffer>();

  /** Throttle tracking for 'held' messages. */
  private _lastHeldMs = 0;
  /** Throttle tracking for 'pose' messages. */
  private _lastPoseMs = 0;

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
    // Seed from opts for backward-compatibility; callers may also use setOnVoice.
    this._onVoice = opts.onVoice ?? null;
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
   */
  connect(wsUrl: string, room: string, name: string, color: number): void {
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
      this._send({ t: 'join', room, name, color, protocol: PROTOCOL_VERSION });
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
          // Local grab
          this._send({ t: 'grab', id: e.id });
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
   * Sample the interpolated remote transform for a shape at the given
   * render time. Returns null if no snapshot data or unknown id.
   */
  sampleRemote(id: string, renderTime: number): { p: Vec3; r: Vec3 } | null {
    const buf = this._snapshots.get(id);
    return buf ? buf.sample(renderTime) : null;
  }

  // -------------------------------------------------------------------------
  // Inbound message handling
  // -------------------------------------------------------------------------

  /**
   * Handle inbound binary WebSocket message as a voice frame.
   *
   * Uses the shared `unpackVoice` decoder (single source of truth for the header
   * layout) and validates the opcode: only VOICE_OPUS/VOICE_WEBM/VOICE_PCM frames
   * are routed to onVoice. Any other opcode is ignored (great-guard), so a stray
   * or future binary opcode never gets mis-decoded as voice.
   */
  private _handleBinaryMessage(buf: ArrayBuffer): void {
    if (!this._onVoice) return;
    try {
      const { opcode, senderId, tsMs, flags, opus } = unpackVoice(buf);
      if (opcode !== VOICE_OPUS && opcode !== VOICE_WEBM && opcode !== VOICE_PCM) {
        // Not a voice opcode — ignore silently.
        return;
      }
      this._onVoice(senderId, tsMs, opus, flags);
    } catch (e) {
      console.warn('[NetClient] binary voice frame decode error', e);
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
        this.opts.onWelcome?.();
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
          this._snapshots.clear();
          // Spawn each server shape with its authoritative id
          for (const ns of shapes) {
            this._applyNetShape(ns);
          }
          // Fire player-join callbacks for existing players (excluding self — the
          // local player must NOT be rendered as a remote avatar).
          for (const p of players) {
            if (p.id !== m.playerId) {
              this.opts.onPlayerJoin?.(p.id, p.name, p.color);
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
          this._snapshots.delete(m.id);
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
        // Push each transform into the shape's SnapshotBuffer.
        for (const entry of stateShapes) {
          let buf = this._snapshots.get(entry.id);
          if (!buf) {
            buf = new SnapshotBuffer();
            this._snapshots.set(entry.id, buf);
          }
          // The server sends integer sequence numbers as timestamps;
          // use the current local time as the sample timestamp for interpolation.
          buf.push(this.now(), entry.p, entry.r);
        }
        break;
      }

      case 'pose':
        this.opts.onPose?.(m.id, m.pose);
        break;

      case 'player-join':
        this.opts.onPlayerJoin?.(m.player.id, m.player.name, m.player.color);
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

      case 'error':
        console.error(`[NetClient] server error ${m.code}: ${m.message}`);
        break;

      default:
        // Unrecognised message type — ignore silently.
        break;
    }
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
        // Move any SnapshotBuffer that was keyed under the temp id (unlikely, but
        // safe) and ensure one exists under the canonical id.
        const oldBuf = this._snapshots.get(tempId);
        if (oldBuf) {
          this._snapshots.delete(tempId);
          if (!this._snapshots.has(ns.id)) this._snapshots.set(ns.id, oldBuf);
        }
        if (!this._snapshots.has(ns.id)) {
          this._snapshots.set(ns.id, new SnapshotBuffer());
        }
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

    // Ensure a SnapshotBuffer exists for this shape.
    if (!this._snapshots.has(ns.id)) {
      this._snapshots.set(ns.id, new SnapshotBuffer());
    }
  }

  private _send(msg: ClientMsg): void {
    if (!this.isConnected() || !this._ws) return;
    this._ws.send(encodeText(msg));
  }
}
