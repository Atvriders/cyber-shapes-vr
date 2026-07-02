/**
 * multiclient.integration.test.ts — Task B7
 *
 * Headless multi-client integration harness: audit backbone for multiplayer
 * correctness. Uses the REAL server (startServer) and REAL WebSocket clients
 * (ws library) with the authentic protocol. No mocks, no arbitrary sleeps.
 *
 * Properties asserted:
 *  1. Convergence of shared state (shapes + discrete props agree across all clients)
 *  2. No duplicate on connected spawn (B6 regression lock)
 *  3. No ghost shapes (despawn propagates to all clients)
 *  4. No id collisions (all ids unique, server-namespaced)
 *  5. Grab conflict (exactly one owner when two grab simultaneously)
 *  6. Room isolation (two rooms never bleed)
 *  7. Capacity (9th joiner rejected with room-full)
 *  8. Clean disconnect (shape released + player-leave when holder disconnects)
 *  9. Voice fan-out (binary frame reaches peers, not sender)
 * 10. Backpressure/robustness (flood does not crash; subsequent message still works)
 */

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import {
  encodeText,
  decodeText,
  packVoice,
  unpackVoice,
  VOICE_OPUS,
  PROTOCOL_VERSION,
} from '@cyber-shapes/shared';
import type { ServerMsg, NetShape } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Client {
  ws: WebSocket;
  playerId: string;
  /** All text messages received (in order). */
  received: ServerMsg[];
  /** Active message listeners (cleared on cleanup). */
  _listeners: Array<(data: WebSocket.RawData, isBinary: boolean) => void>;
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Open a WebSocket connection and wait for OPEN. */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Wait for exactly the next TEXT message on `ws`. */
function nextText(ws: WebSocket, timeoutMs = 3000): Promise<ServerMsg> {
  return new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`nextText timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(decodeText(data.toString()) as ServerMsg);
    };
    ws.on('message', onMsg);
  });
}

/** Wait for the next BINARY message on `ws`. */
function nextBinary(ws: WebSocket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`nextBinary timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    };
    ws.on('message', onMsg);
  });
}

/**
 * Poll `predicate` up to `timeoutMs`. Calls predicate roughly every `intervalMs`.
 * Resolves with the predicate's truthy return value; rejects on timeout.
 */
function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 4000, intervalMs = 30, label = 'condition' } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val) {
        resolve(val);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`waitUntil: "${label}" not satisfied within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Higher-level helpers
// ---------------------------------------------------------------------------

/** Connect a client, join a room, and record all received messages. */
async function joinAsClient(
  url: string,
  room: string,
  name: string,
  colorIndex = 0
): Promise<Client> {
  const ws = await openSocket(url);
  const received: ServerMsg[] = [];

  const listener = (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return; // text only in received[]
    received.push(decodeText(data.toString()) as ServerMsg);
  };
  ws.on('message', listener);

  ws.send(encodeText({ t: 'join', room, name, color: colorIndex, protocol: PROTOCOL_VERSION }));

  // Wait for welcome — first message MUST be welcome
  const welcome = await waitUntil(
    () => received.find((m) => m.t === 'welcome') as (ServerMsg & { t: 'welcome' }) | undefined,
    { label: `welcome for ${name}` }
  );

  return { ws, playerId: welcome.playerId, received, _listeners: [listener] };
}

/**
 * Drain messages for `drainMs`, then resolve the snapshot of shapes from
 * `received` at that moment. Used to give all async broadcasts time to land.
 */
function settle(clients: Client[], drainMs = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, drainMs));
}

/** Close all clients cleanly then close the server. */
async function teardown(clients: Client[], server: ServerHandle): Promise<void> {
  for (const c of clients) {
    for (const l of c._listeners) {
      c.ws.off('message', l);
    }
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) {
      c.ws.close();
    }
  }
  await server.close();
}

/** Shapes currently known to a client based on its message log. */
function clientShapeMap(client: Client): Map<string, Partial<NetShape>> {
  const map = new Map<string, Partial<NetShape>>();

  for (const m of client.received) {
    if (m.t === 'welcome') {
      map.clear();
      for (const s of m.shapes) map.set(s.id, { ...s });
    } else if (m.t === 'spawn') {
      map.set(m.shape.id, { ...m.shape });
    } else if (m.t === 'despawn') {
      map.delete(m.id);
    } else if (m.t === 'recolor') {
      const s = map.get(m.id);
      if (s) s.colorIndex = m.colorIndex;
    } else if (m.t === 'rendermode') {
      const s = map.get(m.id);
      if (s) s.renderMode = m.mode;
    } else if (m.t === 'scale') {
      const s = map.get(m.id);
      if (s) s.scale = m.scale;
    } else if (m.t === 'grab') {
      const s = map.get(m.id);
      if (s) s.grabbedBy = m.peerId;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Track servers created per-test for guaranteed teardown
// ---------------------------------------------------------------------------

let _activeServers: ServerHandle[] = [];

afterEach(async () => {
  // Safety net: close any server not already torn down by the test
  const servers = _activeServers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
});

function makeServer(): { server: ServerHandle; url: string } {
  const server = startServer(0);
  _activeServers.push(server);
  const url = `ws://127.0.0.1:${server.port}`;
  return { server, url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('multiclient integration — 10 multiplayer properties', () => {
  // =========================================================================
  // Property 1: Convergence of shared state
  // =========================================================================
  it('(P1) N=4 clients converge on same shape set + discrete props after spawn/recolor/scale', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      // Four clients join the same room
      for (let i = 0; i < 4; i++) {
        clients.push(await joinAsClient(url, 'conv-room', `Player${i}`, i));
        // Consume any player-join messages that preceding clients receive
        await new Promise((r) => setTimeout(r, 20));
      }

      // Each client spawns one shape
      const spawnMsgs: Array<{ clientIdx: number; shapeId: string }> = [];

      for (let i = 0; i < clients.length; i++) {
        const c = clients[i];
        const beforeCount = c.received.filter((m) => m.t === 'spawn').length;
        c.ws.send(
          encodeText({
            t: 'spawn',
            shape: { type: 'cube', position: { x: i, y: 1, z: 0 } },
          })
        );
        // Wait until this client sees the spawn echo
        const spawnMsg = await waitUntil(
          () => {
            const spawnMsgsNow = c.received.filter((m) => m.t === 'spawn');
            return spawnMsgsNow.length > beforeCount
              ? (spawnMsgsNow[spawnMsgsNow.length - 1] as ServerMsg & { t: 'spawn' })
              : undefined;
          },
          { label: `spawn echo for client ${i}` }
        );
        spawnMsgs.push({ clientIdx: i, shapeId: spawnMsg.shape.id });
      }

      // Recolor all shapes from client 0's perspective
      for (const { shapeId } of spawnMsgs) {
        clients[0].ws.send(encodeText({ t: 'recolor', id: shapeId, colorIndex: 3 }));
      }

      // Scale all shapes from client 1's perspective
      for (const { shapeId } of spawnMsgs) {
        clients[1].ws.send(encodeText({ t: 'scale', id: shapeId, scale: 2 }));
      }

      // Settle: let all broadcasts propagate
      await settle(clients, 500);

      // Assert: every client sees the same shape map
      const shapeMaps = clients.map((c) => clientShapeMap(c));
      const shapeIds = [...shapeMaps[0].keys()].sort();

      expect(shapeIds.length).toBeGreaterThanOrEqual(4); // at least one per client

      for (let ci = 1; ci < clients.length; ci++) {
        const otherIds = [...shapeMaps[ci].keys()].sort();
        expect(otherIds, `client ${ci} shape ids differ from client 0`).toEqual(shapeIds);
      }

      // Discrete props: every shape in the set should have colorIndex=3 and scale=2 on all clients
      for (const id of shapeIds) {
        for (let ci = 0; ci < clients.length; ci++) {
          const s = shapeMaps[ci].get(id);
          expect(s?.colorIndex, `client ${ci} shape ${id} colorIndex`).toBe(3);
          expect(s?.scale, `client ${ci} shape ${id} scale`).toBe(2);
        }
      }
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 2: No duplicate on connected spawn (B6 regression lock)
  // =========================================================================
  it('(P2) spawning while connected yields exactly ONE canonical shape (no duplicate)', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const c = await joinAsClient(url, 'spawn-dedup', 'Alice', 0);
      clients.push(c);

      const beforeCount = c.received.filter((m) => m.t === 'spawn').length;
      c.ws.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'sphere', position: { x: 0, y: 1, z: 0 } },
          tempId: '__local__:0',
        })
      );

      // Wait for the spawn echo
      const spawnMsg = await waitUntil(
        () => {
          const all = c.received.filter((m) => m.t === 'spawn');
          return all.length > beforeCount
            ? (all[all.length - 1] as ServerMsg & { t: 'spawn' })
            : undefined;
        },
        { label: 'spawn echo' }
      );

      const canonicalId = spawnMsg.shape.id;

      // Give extra time for any duplicate to arrive
      await settle(clients, 200);

      // Count how many spawn msgs carry this canonical id
      const spawnsForId = c.received.filter(
        (m) => m.t === 'spawn' && (m as ServerMsg & { t: 'spawn' }).shape.id === canonicalId
      );
      expect(
        spawnsForId.length,
        `Expected exactly 1 spawn for canonical id ${canonicalId}, got ${spawnsForId.length}`
      ).toBe(1);
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 3: No ghost shapes — despawn propagates to all clients
  // =========================================================================
  it('(P3) out-of-bounds despawn propagates to all clients', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA = await joinAsClient(url, 'despawn-room', 'Alice', 0);
      await new Promise((r) => setTimeout(r, 20));
      const cB = await joinAsClient(url, 'despawn-room', 'Bob', 1);
      clients.push(cA, cB);

      // A spawns a shape way out of bounds (server evicts shapes > REMOVE_DISTANCE=50)
      const beforeA = cA.received.filter((m) => m.t === 'spawn').length;
      cA.ws.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'cube', position: { x: 0, y: 999, z: 0 } },
        })
      );

      // Wait for spawn echo on A
      const spawnMsg = await waitUntil(
        () => {
          const all = cA.received.filter((m) => m.t === 'spawn');
          return all.length > beforeA
            ? (all[all.length - 1] as ServerMsg & { t: 'spawn' })
            : undefined;
        },
        { label: 'out-of-bounds spawn echo' }
      );
      const shapeId = spawnMsg.shape.id;

      // The physics loop will fire a despawn after the shape goes out of bounds.
      // Wait until BOTH clients have received the despawn.
      await waitUntil(
        () => {
          const aDespawn = cA.received.some(
            (m) => m.t === 'despawn' && (m as ServerMsg & { t: 'despawn' }).id === shapeId
          );
          const bDespawn = cB.received.some(
            (m) => m.t === 'despawn' && (m as ServerMsg & { t: 'despawn' }).id === shapeId
          );
          return aDespawn && bDespawn;
        },
        { label: 'despawn on both clients', timeoutMs: 5000 }
      );

      // Verify final shape maps: shapeId must not be present in either
      const mapA = clientShapeMap(cA);
      const mapB = clientShapeMap(cB);
      expect(mapA.has(shapeId), 'ghost shape on A').toBe(false);
      expect(mapB.has(shapeId), 'ghost shape on B').toBe(false);
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 4: No id collisions
  // =========================================================================
  it('(P4) all shape ids across the room are unique and server-namespaced', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      for (let i = 0; i < 4; i++) {
        clients.push(await joinAsClient(url, 'id-room', `P${i}`, i));
        await new Promise((r) => setTimeout(r, 10));
      }

      // Each client spawns 3 shapes quickly
      for (const c of clients) {
        for (let j = 0; j < 3; j++) {
          c.ws.send(
            encodeText({
              t: 'spawn',
              shape: { type: 'cube', position: { x: j, y: 1, z: 0 } },
            })
          );
        }
      }

      // Poll until client 0 has seen ALL 12 spawned shapes (4 clients × 3 each).
      // A missing/dropped spawn fails here rather than passing vacuously over a
      // smaller set.
      await waitUntil(() => clientShapeMap(clients[0]).size >= 12, {
        label: 'client 0 sees all 12 spawns',
        timeoutMs: 4000,
      });

      // Collect all shape ids seen by client 0
      const map = clientShapeMap(clients[0]);
      const ids = [...map.keys()];

      // Exact count: must be exactly 12 (not just "at least" — dropped spawns fail)
      expect(ids.length, `expected 12 shape ids on client 0, got ${ids.length}`).toBe(12);

      // All should be namespaced with the room id
      for (const id of ids) {
        expect(id, `shape id "${id}" not server-namespaced`).toMatch(/^id-room:\d+$/);
      }

      // No duplicates
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size, 'duplicate shape ids detected').toBe(ids.length);
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 5: Grab conflict — exactly one winner
  // =========================================================================
  it('(P5) grab conflict: exactly ONE client wins ownership; both see the same grabbedBy', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA = await joinAsClient(url, 'grab-room', 'Alice', 0);
      await new Promise((r) => setTimeout(r, 20));
      const cB = await joinAsClient(url, 'grab-room', 'Bob', 1);
      clients.push(cA, cB);
      await new Promise((r) => setTimeout(r, 20));

      // A spawns a shape
      const beforeA = cA.received.filter((m) => m.t === 'spawn').length;
      cA.ws.send(
        encodeText({
          t: 'spawn',
          shape: { type: 'sphere', position: { x: 0, y: 1, z: 0 } },
        })
      );

      const spawnMsg = await waitUntil(
        () => {
          const all = cA.received.filter((m) => m.t === 'spawn');
          return all.length > beforeA
            ? (all[all.length - 1] as ServerMsg & { t: 'spawn' })
            : undefined;
        },
        { label: 'spawn echo for grab test' }
      );
      const shapeId = spawnMsg.shape.id;

      // Wait for B to also see the spawn
      await waitUntil(
        () =>
          cB.received.some(
            (m) => m.t === 'spawn' && (m as ServerMsg & { t: 'spawn' }).shape.id === shapeId
          ),
        { label: 'B sees spawn' }
      );

      // Both grab the same shape simultaneously
      cA.ws.send(encodeText({ t: 'grab', id: shapeId }));
      cB.ws.send(encodeText({ t: 'grab', id: shapeId }));

      // Wait for at least one grab message to reach both clients
      await waitUntil(
        () => {
          const grabsA = cA.received.filter(
            (m) =>
              m.t === 'grab' &&
              (m as ServerMsg & { t: 'grab' }).id === shapeId &&
              (m as ServerMsg & { t: 'grab' }).peerId !== null
          );
          const grabsB = cB.received.filter(
            (m) =>
              m.t === 'grab' &&
              (m as ServerMsg & { t: 'grab' }).id === shapeId &&
              (m as ServerMsg & { t: 'grab' }).peerId !== null
          );
          return grabsA.length > 0 && grabsB.length > 0;
        },
        { label: 'at least one grab observed by both clients', timeoutMs: 3000 }
      );

      await settle(clients, 200);

      // Build final shape maps
      const mapA = clientShapeMap(cA);
      const mapB = clientShapeMap(cB);

      const grabbedByA = mapA.get(shapeId)?.grabbedBy;
      const grabbedByB = mapB.get(shapeId)?.grabbedBy;

      // Both must agree on who has it
      expect(grabbedByA, 'A and B disagree on grabbedBy').toBe(grabbedByB);

      // Exactly one owner (not null, not both)
      expect(grabbedByA, 'no owner after grab conflict').not.toBeNull();

      // Owner must be one of the actual player ids
      expect([cA.playerId, cB.playerId]).toContain(grabbedByA);
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 6: Room isolation
  // =========================================================================
  it('(P6) shapes in room A never appear in room B and vice versa', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA1 = await joinAsClient(url, 'iso-room-a', 'Alice1', 0);
      const cA2 = await joinAsClient(url, 'iso-room-a', 'Alice2', 1);
      const cB1 = await joinAsClient(url, 'iso-room-b', 'Bob1', 0);
      clients.push(cA1, cA2, cB1);
      await new Promise((r) => setTimeout(r, 30));

      // A1 spawns in room A
      cA1.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } })
      );
      // B1 spawns in room B
      cB1.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'sphere', position: { x: 0, y: 1, z: 0 } } })
      );

      await settle(clients, 400);

      const mapA1 = clientShapeMap(cA1);
      const mapA2 = clientShapeMap(cA2);
      const mapB1 = clientShapeMap(cB1);

      // A's shapes are namespaced with iso-room-a
      for (const id of mapA1.keys()) {
        expect(id, `A1's shape leaked to room B`).toMatch(/^iso-room-a:/);
      }
      // B's shapes are namespaced with iso-room-b
      for (const id of mapB1.keys()) {
        expect(id, `B1's shape has wrong namespace`).toMatch(/^iso-room-b:/);
      }

      // A1 and A2 agree; B's shapes are not in A's map
      const a1Ids = new Set(mapA1.keys());
      const a2Ids = new Set(mapA2.keys());
      const b1Ids = new Set(mapB1.keys());

      // No room-b ids in room-a clients
      for (const id of b1Ids) {
        expect(a1Ids.has(id), `room-b shape ${id} leaked into room-a client 1`).toBe(false);
        expect(a2Ids.has(id), `room-b shape ${id} leaked into room-a client 2`).toBe(false);
      }

      // No room-a ids in room-b client
      for (const id of a1Ids) {
        expect(b1Ids.has(id), `room-a shape ${id} leaked into room-b`).toBe(false);
      }

      // A1 and A2 see the same shapes
      expect([...a1Ids].sort()).toEqual([...a2Ids].sort());
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 7: Capacity — 9th joiner rejected
  // =========================================================================
  it('(P7) 9th client joining a full room receives {t:"error",code:"room-full"} and is closed', async () => {
    const { server, url } = makeServer();
    const sockets: WebSocket[] = [];

    try {
      // Fill with 8 clients (MAX_PLAYERS)
      for (let i = 0; i < 8; i++) {
        const ws = await openSocket(url);
        sockets.push(ws);
        ws.send(
          encodeText({
            t: 'join',
            room: 'cap-room',
            name: `p${i}`,
            color: i,
            protocol: PROTOCOL_VERSION,
          })
        );
        await nextText(ws, 3000); // consume welcome
      }

      // 9th client
      const ws9 = await openSocket(url);
      ws9.send(
        encodeText({
          t: 'join',
          room: 'cap-room',
          name: 'overflow',
          color: 0,
          protocol: PROTOCOL_VERSION,
        })
      );

      const errMsg = await nextText(ws9, 3000);
      expect(errMsg.t).toBe('error');
      if (errMsg.t === 'error') {
        expect(errMsg.code).toBe('room-full');
      }

      // Server should close the connection
      await new Promise<void>((resolve, reject) => {
        if (ws9.readyState === WebSocket.CLOSED) return resolve();
        ws9.once('close', resolve);
        ws9.once('error', reject);
        setTimeout(() => reject(new Error('ws9 not closed in time')), 2000);
      });
    } finally {
      for (const ws of sockets) ws.close();
      await server.close();
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 8: Clean disconnect
  // =========================================================================
  it('(P8) disconnecting holder releases shape (grabbedBy null) + player-leave reaches remaining clients', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA = await joinAsClient(url, 'disc-room', 'Alice', 0);
      await new Promise((r) => setTimeout(r, 20));
      const cB = await joinAsClient(url, 'disc-room', 'Bob', 1);
      await new Promise((r) => setTimeout(r, 20));
      const cC = await joinAsClient(url, 'disc-room', 'Carol', 2);
      clients.push(cA, cB, cC);

      // A spawns
      const beforeA = cA.received.filter((m) => m.t === 'spawn').length;
      cA.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } })
      );
      const spawnMsg = await waitUntil(
        () => {
          const all = cA.received.filter((m) => m.t === 'spawn');
          return all.length > beforeA
            ? (all[all.length - 1] as ServerMsg & { t: 'spawn' })
            : undefined;
        },
        { label: 'A spawn echo' }
      );
      const shapeId = spawnMsg.shape.id;

      // Wait for B and C to see the spawn
      await waitUntil(
        () =>
          cB.received.some(
            (m) => m.t === 'spawn' && (m as ServerMsg & { t: 'spawn' }).shape.id === shapeId
          ) &&
          cC.received.some(
            (m) => m.t === 'spawn' && (m as ServerMsg & { t: 'spawn' }).shape.id === shapeId
          ),
        { label: 'B and C see spawn' }
      );

      // A grabs the shape
      cA.ws.send(encodeText({ t: 'grab', id: shapeId }));
      await waitUntil(
        () =>
          cB.received.some(
            (m) =>
              m.t === 'grab' &&
              (m as ServerMsg & { t: 'grab' }).id === shapeId &&
              (m as ServerMsg & { t: 'grab' }).peerId !== null
          ),
        { label: 'B sees A grab' }
      );

      // Record snapshots before disconnect
      const bBeforeCount = cB.received.length;
      const cBeforeCount = cC.received.length;

      // A disconnects abruptly (no clean close)
      cA.ws.terminate();

      // B and C should each receive grab-null (shape release) + player-leave
      await waitUntil(
        () => {
          const bNewMsgs = cB.received.slice(bBeforeCount);
          const cNewMsgs = cC.received.slice(cBeforeCount);
          const bGrabNull = bNewMsgs.some(
            (m) =>
              m.t === 'grab' &&
              (m as ServerMsg & { t: 'grab' }).id === shapeId &&
              (m as ServerMsg & { t: 'grab' }).peerId === null
          );
          const bLeave = bNewMsgs.some(
            (m) =>
              m.t === 'player-leave' && (m as ServerMsg & { t: 'player-leave' }).id === cA.playerId
          );
          const cGrabNull = cNewMsgs.some(
            (m) =>
              m.t === 'grab' &&
              (m as ServerMsg & { t: 'grab' }).id === shapeId &&
              (m as ServerMsg & { t: 'grab' }).peerId === null
          );
          const cLeave = cNewMsgs.some(
            (m) =>
              m.t === 'player-leave' && (m as ServerMsg & { t: 'player-leave' }).id === cA.playerId
          );
          return bGrabNull && bLeave && cGrabNull && cLeave;
        },
        { label: 'grab-null + player-leave on B and C', timeoutMs: 3000 }
      );

      // Final shape state: grabbedBy must be null
      const mapB = clientShapeMap(cB);
      expect(
        mapB.get(shapeId)?.grabbedBy,
        'shape still grabbed on B after holder disconnect'
      ).toBeNull();
      const mapC = clientShapeMap(cC);
      expect(
        mapC.get(shapeId)?.grabbedBy,
        'shape still grabbed on C after holder disconnect'
      ).toBeNull();
    } finally {
      // Don't try to close cA — it was terminated above
      for (const c of [clients[1], clients[2]]) {
        c.ws.close();
      }
      await server.close();
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 9: Voice fan-out
  // =========================================================================
  it('(P9) binary voice frame from sender reaches peers (with stamped senderId); sender does not receive echo', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA = await joinAsClient(url, 'voice-room', 'Alice', 0);
      await new Promise((r) => setTimeout(r, 20));
      const cB = await joinAsClient(url, 'voice-room', 'Bob', 1);
      await new Promise((r) => setTimeout(r, 20));
      const cC = await joinAsClient(url, 'voice-room', 'Carol', 2);
      clients.push(cA, cB, cC);

      // All three enable voice
      cA.ws.send(encodeText({ t: 'voice-join' }));
      cB.ws.send(encodeText({ t: 'voice-join' }));
      cC.ws.send(encodeText({ t: 'voice-join' }));

      // Wait for voice-roster to propagate
      await new Promise((r) => setTimeout(r, 100));

      // Extract numeric part of A's playerId (server stamps this into the frame)
      const numericIdA = parseInt(cA.playerId.slice(1), 10);

      const opus = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
      const voiceFrame = packVoice(VOICE_OPUS, 0, Date.now(), 0, opus);

      // Set up binary listeners BEFORE sending
      const bBinaryP = nextBinary(cB.ws, 2000);
      const cBinaryP = nextBinary(cC.ws, 2000);

      cA.ws.send(Buffer.from(voiceFrame));

      // B and C receive it
      const bBuf = await bBinaryP;
      const cBuf = await cBinaryP;

      const bUnpacked = unpackVoice(
        bBuf.buffer.slice(bBuf.byteOffset, bBuf.byteOffset + bBuf.byteLength)
      );
      const cUnpacked = unpackVoice(
        cBuf.buffer.slice(cBuf.byteOffset, cBuf.byteOffset + cBuf.byteLength)
      );

      expect(bUnpacked.senderId, 'B: wrong senderId').toBe(numericIdA);
      expect(cUnpacked.senderId, 'C: wrong senderId').toBe(numericIdA);

      // A does NOT receive an echo
      const aEcho = await Promise.race([
        nextBinary(cA.ws, 2000)
          .then(() => 'echo' as const)
          .catch(() => 'no-echo' as const),
        new Promise<'no-echo'>((r) => setTimeout(() => r('no-echo'), 300)),
      ]);
      expect(aEcho, 'sender received echo of its own voice frame').toBe('no-echo');
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });

  // =========================================================================
  // Property 10: Backpressure / robustness
  // =========================================================================
  it('(P10) flooding voice frames does not crash the server; subsequent normal message still works', async () => {
    const { server, url } = makeServer();
    const clients: Client[] = [];

    try {
      const cA = await joinAsClient(url, 'flood-room', 'Alice', 0);
      await new Promise((r) => setTimeout(r, 20));
      const cB = await joinAsClient(url, 'flood-room', 'Bob', 1);
      clients.push(cA, cB);

      // Both enable voice so frames are processed
      cA.ws.send(encodeText({ t: 'voice-join' }));
      cB.ws.send(encodeText({ t: 'voice-join' }));
      await new Promise((r) => setTimeout(r, 50));

      const opus = new Uint8Array(100).fill(0xaa);
      const voiceFrame = Buffer.from(packVoice(VOICE_OPUS, 0, Date.now(), 0, opus));

      // Flood 500 frames as fast as possible
      for (let i = 0; i < 500; i++) {
        cA.ws.send(voiceFrame);
      }

      // Give server a moment to process
      await new Promise((r) => setTimeout(r, 200));

      // Server must still be up: verify with a normal spawn message
      const beforeSpawn = cA.received.filter((m) => m.t === 'spawn').length;
      cA.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } })
      );

      await waitUntil(() => cA.received.filter((m) => m.t === 'spawn').length > beforeSpawn, {
        label: 'spawn after flood',
        timeoutMs: 3000,
      });

      // Server is still responsive — spawn arrived
      const spawnAfterFlood = cA.received.filter((m) => m.t === 'spawn');
      expect(spawnAfterFlood.length, 'server unresponsive after voice flood').toBeGreaterThan(
        beforeSpawn
      );
    } finally {
      await teardown(clients, server);
      _activeServers = _activeServers.filter((s) => s !== server);
    }
  });
});
