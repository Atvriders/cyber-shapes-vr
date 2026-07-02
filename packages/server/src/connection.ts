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
  unpackVoice,
  packVoice,
  validateClientMsg,
  clampName,
  PROTOCOL_VERSION,
  MAX_VOICE_CONFIG_LEN,
} from '@cyber-shapes/shared';
import type { ServerMsg, ClientMsg } from '@cyber-shapes/shared';
import type { RoomManager } from './roomManager.js';
import { ROOM_ID_RE } from './persistence.js';

/** Max bytes buffered per peer before we drop a voice frame for that peer. */
const VOICE_BACKPRESSURE_CAP = 256 * 1024;

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

/** Metadata we attach to each connected socket. */
interface SocketMeta {
  roomId: string;
  playerId: string;
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
}

/** Internal hub type with access to the full state (used within this module). */
interface InternalHub extends ConnectionHub {
  readonly socketMeta: WeakMap<WebSocket, SocketMeta>;
  readonly roomSockets: Map<string, Set<WebSocket>>;
  readonly voiceEnabled: Map<string, Set<string>>;
  getRoomSockets(roomId: string): Set<WebSocket>;
  getVoiceSet(roomId: string): Set<string>;
  sendText(ws: WebSocket, msg: ServerMsg): void;
  broadcast(roomId: string, msg: ServerMsg, exclude?: WebSocket): void;
  broadcastEvents(roomId: string, events: ServerMsg[], sender: WebSocket): void;
  broadcastVoiceRoster(roomId: string): void;
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

  function sendText(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(encodeText(msg));
    }
  }

  function broadcast(roomId: string, msg: ServerMsg, exclude?: WebSocket): void {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    for (const ws of sockets) {
      if (ws === exclude) continue;
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

  function broadcastVoiceRoster(roomId: string): void {
    const vset = getVoiceSet(roomId);
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;

    const players = [...sockets]
      .map((s) => {
        const m = socketMeta.get(s);
        if (!m) return null;
        return { id: m.playerId, voice: vset.has(m.playerId) };
      })
      .filter(Boolean) as Array<{ id: string; voice: boolean }>;

    broadcast(roomId, { t: 'voice-roster', players });
  }

  const hub: InternalHub = {
    socketMeta,
    roomSockets,
    voiceEnabled,
    getRoomSockets,
    getVoiceSet,
    sendText,
    broadcast,
    broadcastEvents,
    broadcastVoiceRoster,
    broadcastToRoom(roomId: string, msg: ServerMsg): void {
      broadcast(roomId, msg);
    },
  };

  return hub;
}

// ---------------------------------------------------------------------------
// Exported connection handler (called per new ws connection)
// ---------------------------------------------------------------------------

export function handleConnection(
  ws: WebSocket,
  manager: RoomManager,
  hub: ConnectionHub,
  onRoomGainedFirstPlayer: (roomId: string) => void,
  onRoomBecameEmpty: (roomId: string) => void
): void {
  ws.binaryType = 'arraybuffer';

  // Cast to InternalHub to access per-server state. The only callers are
  // within this module (startServer passes the hub it created with makeConnectionHub).
  const h = hub as InternalHub;

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

    // --- join ---
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
      // Finding #17: trim + length-clamp the untrusted name; clamp color to a
      // finite int (validateClientMsg already guaranteed it is a finite number).
      const safeName = clampName(msg.name);
      const safeColor = Number.isFinite(msg.color) ? Math.trunc(msg.color) : 0;
      void (async () => {
        const result = await manager.join(room, safeName, safeColor);

        if ('error' in result) {
          h.sendText(ws, {
            t: 'error',
            code: result.error,
            message: `Cannot join: ${result.error}`,
          });
          ws.close();
          return;
        }

        const { room: roomObj, playerId } = result;

        // (6b) The client may have disconnected DURING `await join`. If so, the
        // close handler already ran (no meta was set yet), so it did NOT evict
        // this just-joined player. Reconcile: leave the room and bail before
        // registering a dead socket / leaking an un-evicted player.
        if (ws.readyState !== 1 /* OPEN */) {
          const events = manager.leave(room, playerId);
          for (const evt of events) h.broadcast(room, evt);
          if (!manager.get(room)) onRoomBecameEmpty(room);
          return;
        }

        h.socketMeta.set(ws, { roomId: room, playerId });

        const sockets = h.getRoomSockets(room);
        const isFirstPlayer = sockets.size === 0;

        // (6c) Add this socket to the room set FIRST, then broadcast player-join
        // to OTHERS (exclude self). This ordering guarantees concurrent joiners
        // to a fresh room each see the other's player-join.
        sockets.add(ws);

        const playerInfo = { id: playerId, name: safeName, color: safeColor };
        h.broadcast(room, { t: 'player-join', player: playerInfo }, ws);

        // Send welcome snapshot to the joiner
        h.sendText(ws, roomObj.snapshotFor(playerId));

        // If room just went from 0→1 socket, start the sim loop
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

    // --- voice control messages ---
    if (msg.t === 'voice-join') {
      if (!meta) return;
      const vset = h.getVoiceSet(meta.roomId);
      vset.add(meta.playerId);
      // Broadcast updated voice roster to the whole room
      h.broadcastVoiceRoster(meta.roomId);
      return;
    }

    if (msg.t === 'voice-leave') {
      if (!meta) return;
      const vset = h.getVoiceSet(meta.roomId);
      vset.delete(meta.playerId);
      h.broadcastVoiceRoster(meta.roomId);
      return;
    }

    if (msg.t === 'voice-state') {
      if (!meta) return;
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

    // --- pose relay (own branch, NOT a game intent) ---
    if (msg.t === 'pose') {
      if (!meta) return;
      // Relay peer pose to OTHERS in the room (exclude sender).
      h.broadcast(meta.roomId, { t: 'pose', id: meta.playerId, pose: msg.pose }, ws);
      return;
    }

    // --- generic intent (game actions only) ---
    if (!meta) return;
    const room = manager.get(meta.roomId);
    if (!room) return;

    // Only forward recognised game intents; unknown `t` values are silently ignored (no crash).
    // NOTE: `pose` and `voice-*` are handled by their own branches above and must
    // NOT be listed here (pose is relayed with sender-exclusion; voice is not a game intent).
    if (!GAME_INTENTS.has(msg.t)) return;

    const events = room.applyIntent(meta.playerId, msg as ClientMsg);
    h.broadcastEvents(meta.roomId, events, ws);
  }

  // ----- BINARY messages (voice frames) --------------------------------------
  function handleBinary(ws: WebSocket, data: unknown): void {
    const meta = h.socketMeta.get(ws);
    if (!meta) return;

    // Treat anything that passes isVoiceFrame as a voice frame
    let buf: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (Buffer.isBuffer(data)) {
      buf = new Uint8Array(data).buffer;
    } else {
      return; // unexpected
    }

    if (!isVoiceFrame(buf)) return;

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

    // Fan out to voice-enabled peers (exclude sender)
    const vset = h.getVoiceSet(meta.roomId);
    const sockets = h.roomSockets.get(meta.roomId);
    if (!sockets) return;

    for (const peer of sockets) {
      if (peer === ws) continue; // never echo to sender
      const peerMeta = h.socketMeta.get(peer);
      if (!peerMeta) continue;
      if (!vset.has(peerMeta.playerId)) continue; // only voice-enabled

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

    const { roomId, playerId } = meta;
    h.socketMeta.delete(ws);

    // Remove from room socket set
    const sockets = h.roomSockets.get(roomId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        h.roomSockets.delete(roomId);
      }
    }

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

    // Tell the room manager
    const events = manager.leave(roomId, playerId);

    // Broadcast disconnect events to remaining members
    for (const evt of events) {
      h.broadcast(roomId, evt);
    }

    // If the departing player was voice-enabled, refresh the roster for the
    // remaining peers. broadcastVoiceRoster no-ops when the room is already
    // gone (roomSockets deleted above), so it is safe even for the last leaver.
    if (wasVoiceEnabled) {
      h.broadcastVoiceRoster(roomId);
    }

    // Check if room became empty
    if (!manager.get(roomId)) {
      onRoomBecameEmpty(roomId);
    }
  });
}
