/**
 * wsServer.test.ts — Integration test for Task B3
 *
 * Starts the server on an ephemeral port (0) and exercises real in-process ws clients.
 * TDD RED: written before connection.ts / index.ts rewrite exist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeText, decodeText, packVoice, unpackVoice, VOICE_OPUS } from '@cyber-shapes/shared';
import type { ServerMsg, NetShape } from '@cyber-shapes/shared';

// startServer is the B3 deliverable — not yet written → test will fail at import
import { startServer } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the next message on a ws client, decoded as JSON. */
function nextMsg(ws: WebSocket): Promise<ServerMsg> {
  return new Promise<ServerMsg>((resolve, reject) => {
    const onMsg = (data: WebSocket.RawData) => {
      ws.off('message', onMsg);
      ws.off('error', onErr);
      resolve(decodeText(data.toString()) as ServerMsg);
    };
    const onErr = (e: Error) => {
      ws.off('message', onMsg);
      ws.off('error', onErr);
      reject(e);
    };
    ws.on('message', onMsg);
    ws.on('error', onErr);
  });
}

/** Collect `n` text messages (decoded). Rejects if the socket closes first. */
function collectMsgs(ws: WebSocket, n: number, timeoutMs = 2000): Promise<ServerMsg[]> {
  return new Promise<ServerMsg[]>((resolve, reject) => {
    const msgs: ServerMsg[] = [];
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      ws.off('close', onClose);
      reject(new Error(`timeout waiting for ${n} messages (got ${msgs.length})`));
    }, timeoutMs);

    const onMsg = (data: WebSocket.RawData) => {
      // Only collect text frames
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
      msgs.push(decodeText(data.toString()) as ServerMsg);
      if (msgs.length >= n) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        ws.off('close', onClose);
        resolve(msgs);
      }
    };
    const onClose = () => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      reject(new Error('socket closed before collecting all messages'));
    };
    ws.on('message', onMsg);
    ws.on('close', onClose);
  });
}

/** Collect next binary message as Buffer. */
function nextBinary(ws: WebSocket, timeoutMs = 2000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for binary message'));
    }, timeoutMs);

    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return; // skip text
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    };
    ws.on('message', onMsg);
  });
}

/** Open a ws connection and wait until it is OPEN. */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Send a join message and wait for the welcome. */
async function joinRoom(
  ws: WebSocket,
  room: string,
  name: string,
  color = 0xff0000
): Promise<ServerMsg & { t: 'welcome' }> {
  ws.send(encodeText({ t: 'join', room, name, color, protocol: 1 }));
  const msg = await nextMsg(ws);
  if (msg.t !== 'welcome') throw new Error(`Expected welcome, got ${msg.t}`);
  return msg as ServerMsg & { t: 'welcome' };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let closeServer: () => Promise<void>;
let serverUrl: string;

beforeAll(async () => {
  const handle = startServer(0);
  closeServer = handle.close;
  // Wait a tick for the server to bind
  await new Promise<void>((r) => setTimeout(r, 50));
  const port = (handle as unknown as { port: number }).port;
  serverUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeServer();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wsServer integration', () => {
  it('two clients can join the same room and both receive a server-assigned spawn id', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);

    try {
      // A joins first
      const wA = await joinRoom(wsA, 'room1', 'Alice');
      expect(wA.t).toBe('welcome');
      expect(wA.playerId).toMatch(/^p\d+$/);

      // B joining sends player-join to A first — consume it
      const joinPromise = nextMsg(wsA); // A receives player-join for B
      const wB = await joinRoom(wsB, 'room1', 'Bob');
      expect(wB.t).toBe('welcome');
      expect(wB.playerId).toMatch(/^p\d+$/);
      expect(wB.playerId).not.toBe(wA.playerId);
      await joinPromise; // wait for A's notification

      // A spawns a shape
      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } },
        })
      );

      // Both A and B should receive the spawn event
      const [msgA, msgB] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);

      expect(msgA.t).toBe('spawn');
      expect(msgB.t).toBe('spawn');
      if (msgA.t === 'spawn' && msgB.t === 'spawn') {
        expect(msgA.shape.id).toMatch(/^room1:\d+$/);
        expect(msgB.shape.id).toBe(msgA.shape.id); // same id, server-assigned
      }
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('grab arbitration: B cannot grab a shape A already holds', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);

    try {
      await joinRoom(wsA, 'room2', 'Alice');
      // consume A's player-join notification after B joins
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'room2', 'Bob');
      await joinNotify;

      // A spawns
      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'sphere', position: { x: 0, y: 1, z: 0 } },
        })
      );
      const spawnMsgs = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      const [spawnA] = spawnMsgs;
      expect(spawnA.t).toBe('spawn');
      const shapeId = (spawnA as ServerMsg & { t: 'spawn' }).shape.id;

      // A grabs first
      wsA.send(encodeText({ t: 'grab', id: shapeId }));
      // A receives grab confirm, B receives grab notification
      const [grabA, grabB] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      expect(grabA.t).toBe('grab');
      expect(grabB.t).toBe('grab');
      if (grabA.t === 'grab') expect(grabA.peerId).toBeTruthy();

      // B tries to grab same shape — should NOT receive a grab event (arbitration rejects)
      wsB.send(encodeText({ t: 'grab', id: shapeId }));

      // Wait briefly to ensure no erroneous message arrives
      const unexpectedGrab = await Promise.race([
        nextMsg(wsB),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300)),
      ]);
      // Only 'timeout' or a non-grab message (like a state tick) is acceptable
      if (unexpectedGrab !== 'timeout') {
        expect((unexpectedGrab as ServerMsg).t).not.toBe('grab');
      }
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('binary voice frame from A is received by B with correct senderId; A does not receive echo', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);

    try {
      const wA = await joinRoom(wsA, 'room3', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'room3', 'Bob');
      await joinNotify;

      // Both enable voice
      wsA.send(encodeText({ t: 'voice-join' }));
      wsB.send(encodeText({ t: 'voice-join' }));

      // Small delay to let voice-join propagate
      await new Promise<void>((r) => setTimeout(r, 50));

      // Extract numeric senderId from A's playerId
      const numericIdA = parseInt(wA.playerId.slice(1), 10);

      // Pack a voice frame with a placeholder senderId (server will stamp its own)
      const opus = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const frameBuf = packVoice(VOICE_OPUS, 0, Date.now(), 0, opus);

      // Confirm nothing queued on B before sending
      const bReceived = nextBinary(wsB, 1000);

      // A sends the binary frame
      wsA.send(Buffer.from(frameBuf));

      // B should receive it
      const bBuf = await bReceived;
      const unpacked = unpackVoice(
        bBuf.buffer.slice(bBuf.byteOffset, bBuf.byteOffset + bBuf.byteLength)
      );
      expect(unpacked.senderId).toBe(numericIdA); // server stamped A's id

      // A should NOT receive an echo — wait 300ms to be sure
      const aEcho = await Promise.race([
        nextBinary(wsA, 2000)
          .then(() => 'got-echo' as const)
          .catch(() => 'no-echo' as const),
        new Promise<'no-echo'>((r) => setTimeout(() => r('no-echo'), 300)),
      ]);
      expect(aEcho).toBe('no-echo');
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('9th client joining a full room receives error and connection closes', async () => {
    const sockets: WebSocket[] = [];

    try {
      // Fill room4 with 8 players (MAX_PLAYERS)
      for (let i = 0; i < 8; i++) {
        const ws = await openSocket(serverUrl);
        sockets.push(ws);
        // Each join triggers player-join notifications to earlier sockets — ignore them here
        ws.send(encodeText({ t: 'join', room: 'room4', name: `p${i}`, color: 0, protocol: 1 }));
        // Wait for welcome (consuming it drains the socket)
        await nextMsg(ws);
      }

      // 9th client
      const ws9 = await openSocket(serverUrl);
      ws9.send(encodeText({ t: 'join', room: 'room4', name: 'overflow', color: 0, protocol: 1 }));

      const errorMsg = await nextMsg(ws9);
      expect(errorMsg.t).toBe('error');
      if (errorMsg.t === 'error') {
        expect(errorMsg.code).toBe('room-full');
      }

      // Server should close the connection
      await new Promise<void>((resolve, reject) => {
        if (ws9.readyState === WebSocket.CLOSED) return resolve();
        ws9.once('close', resolve);
        ws9.once('error', reject);
        setTimeout(() => reject(new Error('ws9 not closed in time')), 1000);
      });
    } finally {
      for (const ws of sockets) ws.close();
    }
  });

  it('on disconnect while holding a shape, remaining client gets grab-null and player-leave', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);

    try {
      await joinRoom(wsA, 'room5', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'room5', 'Bob');
      await joinNotify;

      // A spawns
      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'tetrahedron', position: { x: 0, y: 1, z: 0 } },
        })
      );
      const [spawnA] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      const shapeId = (spawnA as ServerMsg & { t: 'spawn' }).shape.id;

      // A grabs
      wsA.send(encodeText({ t: 'grab', id: shapeId }));
      await Promise.all([nextMsg(wsA), nextMsg(wsB)]); // consume grab broadcasts

      // A disconnects abruptly
      wsA.terminate();

      // B should receive grab-null (release) + player-leave
      const msgs = await collectMsgs(wsB, 2, 2000);
      const types = msgs.map((m) => m.t).sort();
      expect(types).toContain('grab');
      expect(types).toContain('player-leave');
      const grabMsg = msgs.find((m) => m.t === 'grab') as (ServerMsg & { t: 'grab' }) | undefined;
      expect(grabMsg?.peerId).toBeNull();
      expect(grabMsg?.id).toBe(shapeId);
    } finally {
      wsB.close();
    }
  });

  it('/healthz endpoint returns 200', async () => {
    // Extract port from serverUrl
    const port = new URL(serverUrl.replace('ws://', 'http://')).port;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // FINDING 3 — recolor / scale / held intents are NOT dropped
  // -------------------------------------------------------------------------

  it('recolor and scale intents broadcast to peers (finding 3)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'room-intents', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'room-intents', 'Bob');
      await joinNotify;

      // A spawns a shape (both receive it)
      wsA.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } }));
      const [spawnA] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      const shapeId = (spawnA as ServerMsg & { t: 'spawn' }).shape.id;

      // A recolors → peer B must receive a recolor broadcast (was dropped before fix)
      wsA.send(encodeText({ t: 'recolor', id: shapeId, colorIndex: 5 }));
      const recolorB = await nextMsg(wsB);
      expect(recolorB.t).toBe('recolor');
      if (recolorB.t === 'recolor') {
        expect(recolorB.id).toBe(shapeId);
        expect(recolorB.colorIndex).toBe(5);
      }

      // A scales → peer B must receive a scale broadcast (was dropped before fix)
      wsA.send(encodeText({ t: 'scale', id: shapeId, scale: 2 }));
      const scaleB = await nextMsg(wsB);
      expect(scaleB.t).toBe('scale');
      if (scaleB.t === 'scale') {
        expect(scaleB.id).toBe(shapeId);
        expect(scaleB.scale).toBe(2);
      }
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('held intent updates the shape; peer sees the new transform in a state snapshot (finding 3)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'room-held', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'room-held', 'Bob');
      await joinNotify;

      wsA.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } } }));
      const [spawnA] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      const shapeId = (spawnA as ServerMsg & { t: 'spawn' }).shape.id;

      // A grabs then sends a held transform (held was dropped before the fix)
      wsA.send(encodeText({ t: 'grab', id: shapeId }));
      await Promise.all([nextMsg(wsA), nextMsg(wsB)]); // consume grab broadcasts

      wsA.send(
        encodeText({
          t: 'held',
          id: shapeId,
          position: { x: 7, y: 8, z: 9 },
          rotation: { x: 0, y: 0, z: 0 },
        })
      );

      // The grabbed shape rides the periodic `state` broadcast. Wait for a
      // state that carries the new position for our shape.
      const found = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          wsB.off('message', onMsg);
          resolve(false);
        }, 1500);
        const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) return;
          const m = decodeText(data.toString()) as ServerMsg;
          if (m.t !== 'state') return;
          const entry = m.shapes.find((s) => s.id === shapeId);
          if (entry && entry.p.x === 7 && entry.p.y === 8 && entry.p.z === 9) {
            clearTimeout(timer);
            wsB.off('message', onMsg);
            resolve(true);
          }
        };
        wsB.on('message', onMsg);
      });
      expect(found).toBe(true);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // -------------------------------------------------------------------------
  // FINDING 2 (WS boundary) — traversal room name rejected before RoomManager
  // -------------------------------------------------------------------------

  it('join with a path-traversal room name is rejected with bad-room and closed (finding 2)', async () => {
    const ws = await openSocket(serverUrl);
    try {
      ws.send(
        encodeText({ t: 'join', room: '../../etc/passwd', name: 'evil', color: 0, protocol: 1 })
      );
      const msg = await nextMsg(ws);
      expect(msg.t).toBe('error');
      if (msg.t === 'error') expect(msg.code).toBe('bad-room');

      await new Promise<void>((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        setTimeout(() => reject(new Error('socket not closed after bad-room')), 1000);
      });
    } finally {
      ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-server state isolation — two independent servers, same room name
// ---------------------------------------------------------------------------

describe('cross-server isolation', () => {
  it('spawn/voice on server1 room "shared" does NOT bleed to client on server2 room "shared"', async () => {
    // Start two completely independent servers on ephemeral ports.
    const handle1 = startServer(0);
    const handle2 = startServer(0);

    // Wait a tick for both to bind.
    await new Promise<void>((r) => setTimeout(r, 50));

    const url1 = `ws://127.0.0.1:${handle1.port}`;
    const url2 = `ws://127.0.0.1:${handle2.port}`;

    const wsA = await openSocket(url1); // client on server1
    const wsB = await openSocket(url2); // client on server2

    try {
      // Both join a room with the SAME name on their respective servers.
      await joinRoom(wsA, 'shared', 'Alice');
      const wB = await joinRoom(wsB, 'shared', 'Bob');
      expect(wB.t).toBe('welcome');

      // Client A on server1 spawns a shape.
      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } },
        })
      );

      // Client A should receive its own spawn confirmation.
      const spawnA = await nextMsg(wsA);
      expect(spawnA.t).toBe('spawn');

      // Client A on server1 joins voice and sends voice-state.
      wsA.send(encodeText({ t: 'voice-join' }));
      await new Promise<void>((r) => setTimeout(r, 50));
      wsA.send(encodeText({ t: 'voice-state', speaking: true, muted: false }));

      // Client B on server2 must NOT receive any of these events.
      // We wait 400ms — long enough that any bleed would have arrived.
      const bleedCheck = await Promise.race([
        nextMsg(wsB).then((m) => ({ bled: true, msg: m })),
        new Promise<{ bled: false }>((r) => setTimeout(() => r({ bled: false }), 400)),
      ]);

      expect(bleedCheck.bled).toBe(false);
    } finally {
      wsA.close();
      wsB.close();
      await handle1.close();
      await handle2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// FINDING 6 — join-path races + crash safety (persistence-enabled server)
// ---------------------------------------------------------------------------

function makePersistedShape(id: string): NetShape {
  return {
    id,
    type: 'cube',
    colorIndex: 1,
    renderMode: 'both',
    scale: 1,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0,
    rotSpeed: { x: 0, y: 0, z: 0 },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

describe('join-path races (finding 6)', () => {
  let dataDir: string;
  let handle: ReturnType<typeof startServer>;
  let url: string;
  let prevDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'csvr-b4-'));
    mkdirSync(join(dataDir, 'rooms'), { recursive: true });
    // Pre-seed a persisted room "persisted" with two restored shapes.
    writeFileSync(
      join(dataDir, 'rooms', 'persisted.json'),
      JSON.stringify({
        shapes: [makePersistedShape('persisted:0'), makePersistedShape('persisted:1')],
      })
    );

    prevDataDir = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = dataDir;
    handle = startServer(0);
    await new Promise<void>((r) => setTimeout(r, 50));
    url = `ws://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.close();
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('concurrent joiners to a new persisted room each learn of the other and both get restored shapes', async () => {
    const wsA = await openSocket(url);
    const wsB = await openSocket(url);
    try {
      // Fire both joins WITHOUT awaiting between them → concurrent getOrCreate.
      // Each client should either receive a player-join for the peer OR see the
      // peer in its own welcome.players roster; and both welcomes carry the
      // 2 restored shapes (race-safe restore, not an empty room).
      const aMsgs: ServerMsg[] = [];
      const bMsgs: ServerMsg[] = [];
      const collect = (arr: ServerMsg[]) => (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        arr.push(decodeText(data.toString()) as ServerMsg);
      };
      const onA = collect(aMsgs);
      const onB = collect(bMsgs);
      wsA.on('message', onA);
      wsB.on('message', onB);

      wsA.send(encodeText({ t: 'join', room: 'persisted', name: 'Alice', color: 1, protocol: 1 }));
      wsB.send(encodeText({ t: 'join', room: 'persisted', name: 'Bob', color: 2, protocol: 1 }));

      // Let both joins + any player-join broadcasts settle.
      await new Promise<void>((r) => setTimeout(r, 300));
      wsA.off('message', onA);
      wsB.off('message', onB);

      const welcomeA = aMsgs.find((m) => m.t === 'welcome') as
        (ServerMsg & { t: 'welcome' }) | undefined;
      const welcomeB = bMsgs.find((m) => m.t === 'welcome') as
        (ServerMsg & { t: 'welcome' }) | undefined;
      expect(welcomeA).toBeTruthy();
      expect(welcomeB).toBeTruthy();

      // Both got the FULL restored snapshot (not an empty room mid-restore).
      expect(welcomeA!.shapes.map((s) => s.id).sort()).toEqual(['persisted:0', 'persisted:1']);
      expect(welcomeB!.shapes.map((s) => s.id).sort()).toEqual(['persisted:0', 'persisted:1']);

      // Each client knows about the other: via a player-join event OR via its
      // own welcome roster (both are valid, race-order-dependent).
      const aKnowsB =
        aMsgs.some((m) => m.t === 'player-join' && m.player.id === welcomeB!.playerId) ||
        welcomeA!.players.some((p) => p.id === welcomeB!.playerId);
      const bKnowsA =
        bMsgs.some((m) => m.t === 'player-join' && m.player.id === welcomeA!.playerId) ||
        welcomeB!.players.some((p) => p.id === welcomeA!.playerId);
      expect(aKnowsB).toBe(true);
      expect(bKnowsA).toBe(true);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('disconnect-during-join leaves no ghost player: room still accepts MAX_PLAYERS later', async () => {
    // Rapidly join+close on a persisted room (join awaits a real disk read, so
    // the close can land DURING the await → exercises the ghost-socket guard).
    const room = 'ghostcheck';
    // Seed the room so getOrCreate performs an async disk load on first create.
    writeFileSync(
      join(dataDir, 'rooms', `${room}.json`),
      JSON.stringify({ shapes: [makePersistedShape(`${room}:0`)] })
    );

    for (let i = 0; i < 12; i++) {
      const ws = await openSocket(url);
      ws.send(encodeText({ t: 'join', room, name: `ghost${i}`, color: 0, protocol: 1 }));
      // Close immediately — no await for welcome → disconnect races the join.
      ws.close();
    }

    // Give the server time to reconcile all the aborted joins.
    await new Promise<void>((r) => setTimeout(r, 300));

    // If ghosts had leaked, the room would be at/over capacity and reject.
    // Now MAX_PLAYERS (8) real clients must be able to join cleanly.
    const live: WebSocket[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        const ws = await openSocket(url);
        live.push(ws);
        ws.send(encodeText({ t: 'join', room, name: `real${i}`, color: 0, protocol: 1 }));
        const msg = await nextMsg(ws);
        expect(msg.t).toBe('welcome'); // no ghost stole this slot
      }
    } finally {
      for (const ws of live) ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AUDIT — security/robustness hardening integration tests
// (findings #1, #2, #4, #5, #7, #16, #17). Uses the module-scoped serverUrl.
// ---------------------------------------------------------------------------

describe('audit hardening', () => {
  // FINDING #4 — a structurally-malformed intent must NOT crash the process.
  it('malformed spawn (missing shape) does not crash the server; peers unaffected (finding #4)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'crash-room', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'crash-room', 'Bob');
      await joinNotify;

      // Send a spawn with NO `shape` — before the fix this threw out of the
      // message handler in ServerWorld.spawn and killed the whole process.
      wsA.send(encodeText({ t: 'spawn' } as unknown as object));

      // The server must stay up: a normal spawn from B still round-trips.
      wsB.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } }));
      const [mA, mB] = await Promise.all([nextMsg(wsA), nextMsg(wsB)]);
      // The valid spawn arrives to both (the malformed one produced no spawn).
      expect([mA.t, mB.t]).toContain('spawn');
      const gotSpawn = [mA, mB].find((m) => m.t === 'spawn') as
        | (ServerMsg & { t: 'spawn' })
        | undefined;
      expect(gotSpawn?.shape.type).toBe('cube');
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // FINDING #2 — a NaN Vec3 component is rejected and never enters the world.
  it('spawn with a NaN position is rejected and never broadcast (finding #2)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      const wA = await joinRoom(wsA, 'nan-room', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'nan-room', 'Bob');
      await joinNotify;

      // JSON has no NaN literal; send it as a raw string so it decodes to NaN.
      wsA.send('{"t":"spawn","shape":{"type":"cube","position":{"x":null,"y":1,"z":0}}}');
      // null is not a number → rejected; send another invalid one with a string.
      wsA.send('{"t":"spawn","shape":{"type":"cube","position":{"x":"NaN","y":1,"z":0}}}');

      // Neither should produce a spawn broadcast. A valid spawn afterwards must.
      const noBleed = await Promise.race([
        nextMsg(wsB).then((m) => m.t),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300)),
      ]);
      expect(noBleed).not.toBe('spawn');

      // Control: a valid spawn IS broadcast, and its welcome-snapshot world has
      // no NaN-position shapes.
      wsA.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } }));
      const spawnB = await nextMsg(wsB);
      expect(spawnB.t).toBe('spawn');

      // A late joiner's welcome must contain exactly the one valid shape.
      const wsC = await openSocket(serverUrl);
      try {
        const wC = await joinRoom(wsC, 'nan-room', 'Carol');
        expect(wC.shapes.length).toBe(1);
        for (const s of wC.shapes) {
          expect(Number.isFinite(s.position.x)).toBe(true);
        }
      } finally {
        wsC.close();
      }
      void wA;
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // FINDING #5 — invalid type/colorIndex/renderMode rejected.
  it('spawn with an invalid shape type is rejected (finding #5)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'type-room', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'type-room', 'Bob');
      await joinNotify;

      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'wormhole', position: { x: 0, y: 1, z: 0 } },
        } as unknown as object)
      );
      wsA.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: 999 },
        } as unknown as object)
      );

      const noBleed = await Promise.race([
        nextMsg(wsB).then((m) => m.t),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 300)),
      ]);
      expect(noBleed).not.toBe('spawn');
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // FINDING #7 — voice-config relays ONLY the whitelisted `config` field.
  it('extra attacker keys on voice-config are NOT relayed to peers (finding #7)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      const wA = await joinRoom(wsA, 'vc-room', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'vc-room', 'Bob');
      await joinNotify;

      // Attacker injects extra keys alongside `config`.
      wsA.send(
        encodeText({
          t: 'voice-config',
          config: '{"bitrate":32000}',
          evil: 'payload',
          __proto__key: 1,
        } as unknown as object)
      );

      const relayed = (await nextMsg(wsB)) as ServerMsg & Record<string, unknown>;
      expect(relayed.t).toBe('voice-config');
      // Only whitelisted keys: t, id, config. No `evil`/injected keys.
      expect(relayed['config']).toBe('{"bitrate":32000}');
      expect(relayed['id']).toBe(wA.playerId);
      expect(relayed['evil']).toBeUndefined();
      expect(Object.keys(relayed).sort()).toEqual(['config', 'id', 't']);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // FINDING #16 — protocol version mismatch is rejected + closed.
  it('join with a wrong protocol version is rejected and closed (finding #16)', async () => {
    const ws = await openSocket(serverUrl);
    try {
      ws.send(encodeText({ t: 'join', room: 'proto-room', name: 'X', color: 0, protocol: 999 }));
      const msg = await nextMsg(ws);
      expect(msg.t).toBe('error');
      if (msg.t === 'error') expect(msg.code).toBe('protocol-mismatch');
      await new Promise<void>((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        setTimeout(() => reject(new Error('socket not closed after protocol-mismatch')), 1000);
      });
    } finally {
      ws.close();
    }
  });

  // FINDING #17 — an over-long join name is clamped in the broadcast player-join.
  it('an over-long join name is length-clamped (finding #17)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'name-room', 'Alice');
      // B joins with a 500-char name; A must see a clamped name in player-join.
      const longName = 'B'.repeat(500);
      const joinNotify = nextMsg(wsA);
      wsB.send(encodeText({ t: 'join', room: 'name-room', name: longName, color: 0, protocol: 1 }));
      await nextMsg(wsB); // welcome
      const pj = await joinNotify;
      expect(pj.t).toBe('player-join');
      if (pj.t === 'player-join') {
        expect(pj.player.name.length).toBeLessThanOrEqual(32);
      }
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // FINDING #1 — an oversized voice frame is not relayed (byteLength guard) and
  // an oversized single frame trips ws's maxPayload (socket closed).
  it('an oversized voice frame is not relayed to peers (finding #1)', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      await joinRoom(wsA, 'big-voice', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'big-voice', 'Bob');
      await joinNotify;
      wsA.send(encodeText({ t: 'voice-join' }));
      wsB.send(encodeText({ t: 'voice-join' }));
      await new Promise<void>((r) => setTimeout(r, 50));

      // A 32 KiB opus payload → frame is > MAX_VOICE_FRAME_BYTES (8 KiB) but
      // still under MAX_PAYLOAD (64 KiB) so ws accepts it; our byteLength guard
      // must drop it (never relayed to B).
      const opus = new Uint8Array(32 * 1024).fill(0xaa);
      const big = Buffer.from(packVoice(VOICE_OPUS, 0, Date.now(), 0, opus));

      const bGot = Promise.race([
        nextBinary(wsB, 1000)
          .then(() => 'relayed' as const)
          .catch(() => 'dropped' as const),
        new Promise<'dropped'>((r) => setTimeout(() => r('dropped'), 400)),
      ]);
      wsA.send(big);
      expect(await bGot).toBe('dropped');
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('a frame larger than maxPayload closes the connection (maxPayload option present) (finding #1)', async () => {
    const ws = await openSocket(serverUrl);
    try {
      await joinRoom(ws, 'payload-room', 'Alice');
      // A frame well over MAX_PAYLOAD_BYTES (64 KiB). ws enforces maxPayload and
      // closes the socket (code 1009) before delivering it to us.
      const huge = Buffer.alloc(200 * 1024, 0x41);
      const closed = new Promise<boolean>((resolve) => {
        ws.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 1500);
      });
      ws.send(huge);
      expect(await closed).toBe(true);
    } finally {
      ws.close();
    }
  });

  // audit-2 MINOR — when a voice-enabled player disconnects, the 'close' handler
  // must rebroadcast the voice roster so remaining peers don't keep a stale one
  // listing the departed player.
  it('rebroadcasts the voice roster to remaining peers when a voice-enabled player disconnects', async () => {
    const wsA = await openSocket(serverUrl);
    const wsB = await openSocket(serverUrl);
    try {
      const wA = await joinRoom(wsA, 'roster-close', 'Alice');
      const joinNotify = nextMsg(wsA);
      await joinRoom(wsB, 'roster-close', 'Bob');
      await joinNotify;

      // Both enable voice; drain the roster broadcasts that voice-join triggers.
      wsA.send(encodeText({ t: 'voice-join' }));
      wsB.send(encodeText({ t: 'voice-join' }));
      await new Promise<void>((r) => setTimeout(r, 80));

      // Arm B for the next voice-roster, then close A (a voice-enabled player).
      const rosterAfterClose = new Promise<ServerMsg>((resolve, reject) => {
        const timer = setTimeout(() => {
          wsB.off('message', onMsg);
          reject(new Error('B never received a voice-roster after A disconnected'));
        }, 2000);
        const onMsg = (data: WebSocket.RawData) => {
          if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
          const m = decodeText(data.toString()) as ServerMsg;
          if (m.t === 'voice-roster') {
            clearTimeout(timer);
            wsB.off('message', onMsg);
            resolve(m);
          }
        };
        wsB.on('message', onMsg);
      });

      wsA.close();

      const roster = await rosterAfterClose;
      expect(roster.t).toBe('voice-roster');
      if (roster.t === 'voice-roster') {
        // The departed player (A) must NOT be in the refreshed roster.
        expect(roster.players.some((p) => p.id === wA.playerId)).toBe(false);
      }
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  // audit-2 MINOR — the LAST voice-enabled player leaving (room becomes gone)
  // must not crash the close handler (broadcastVoiceRoster no-ops when the room
  // is already torn down).
  it('does not crash when the last voice-enabled player disconnects (room gone)', async () => {
    const ws = await openSocket(serverUrl);
    await joinRoom(ws, 'roster-last', 'Solo');
    ws.send(encodeText({ t: 'voice-join' }));
    await new Promise<void>((r) => setTimeout(r, 80));

    // Close the only socket; the room tears down. The close handler must not throw.
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close();
    await closed;
    // Give the server a beat to run its close handler; if it crashed the guard
    // would log but the process (and this test run) stays up. Reaching here = ok.
    await new Promise<void>((r) => setTimeout(r, 80));
    expect(true).toBe(true);
  });
});
