/**
 * reelArcade.test.ts — Task C22 (F10 Ghost Arcade): the per-room reel recorder
 * TEE + the REEL bank/list/play transport (spec §7.10 / §7.17).
 *
 * Two layers:
 *   1. HUB-LEVEL (no socket server): a room broadcast is ALSO captured by the
 *      room's ReelRecorder (record-time sanitized — names → GHOST_XX, voice
 *      EXCLUDED), and teeing does NOT change what any tier receives (the C25
 *      audience-boundary + resident/wisp/crowd fan-out regression guard).
 *   2. FULL SERVER (real ws + POST /api/rooms ownerToken): BANK → LIST → PLAY
 *      round-trips, and the transport is CAPABILITY-GATED (an unauthorized bank is
 *      refused, never a mutation).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { encodeText, decodeText, PROTOCOL_VERSION } from '@cyber-shapes/shared';
import type { ServerMsg, NetShape } from '@cyber-shapes/shared';
import { makeConnectionHub } from '../src/connection.js';
import { ReelRecorder } from '../src/recorder.js';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Hub-level harness: a loose view of the InternalHub internals + a fake socket.
// ---------------------------------------------------------------------------

interface HubView {
  socketMeta: { set(ws: unknown, meta: unknown): void };
  roomSockets: Map<string, Set<unknown>>;
  recorders: Map<string, ReelRecorder>;
  broadcastToRoom(roomId: string, msg: ServerMsg): void;
  broadcastBinaryToTiers(roomId: string, frame: ArrayBuffer, tiers?: readonly string[]): void;
  getRecorder(roomId: string): ReelRecorder | undefined;
}

interface FakeSock {
  readyState: number;
  bufferedAmount: number;
  sent: unknown[];
  send(p: unknown): void;
  close(): void;
}

function fakeSock(): FakeSock {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send(p: unknown) {
      sent.push(p);
    },
    close() {
      this.readyState = 3;
    },
  };
}

function registerSock(hub: HubView, roomId: string, tier: string): FakeSock {
  const ws = fakeSock();
  let set = hub.roomSockets.get(roomId);
  if (!set) {
    set = new Set();
    hub.roomSockets.set(roomId, set);
  }
  set.add(ws);
  hub.socketMeta.set(ws, {
    roomId,
    playerId: `p-${tier}`,
    tier,
    callsign: `CS-${tier}`,
    roomEpoch: 0,
    idleTimer: null,
    director: false,
    entryRoute: 'test',
    joinedAt: 0,
    clientIp: '1.1.1.1',
  });
  return ws;
}

function netShape(id: string): NetShape {
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
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

describe('C22 per-room recorder tee (hub-level)', () => {
  it('tees a room broadcast into the recorder, anonymized to callsigns (no raw name)', () => {
    const hub = makeConnectionHub() as unknown as HubView;
    const roomId = 'tee-room';
    registerSock(hub, roomId, 'resident');
    // Construct the room's recorder the way ensureHost does (per-room, injected clock).
    hub.recorders.set(roomId, new ReelRecorder({ now: () => 1000 }));

    hub.broadcastToRoom(roomId, { t: 'player-join', player: { id: 'p1', name: 'Alice Smith', color: 2 } });
    hub.broadcastToRoom(roomId, { t: 'spawn', shape: netShape('a') });

    const reel = hub.getRecorder(roomId)!.snapshotReel();
    const json = JSON.stringify(reel);
    // The recorder REFLECTS the broadcast stream...
    const kinds = reel.frames.flatMap((f) => f.discrete.map((e) => e.msg.t));
    expect(kinds).toContain('spawn');
    expect(kinds).toContain('player-join');
    // ...with identity ANONYMIZED (no free-text name; a GHOST_XX handle instead).
    expect(json).not.toContain('Alice');
    expect(json).toContain('GHOST_');
  });

  it('teeing does NOT change what any tier receives (regression guard: C25 audience + fan-out)', () => {
    const roomId = 'nofanout-room';
    const msg: ServerMsg = { t: 'spawn', shape: netShape('s1') };

    // Run A: NO recorder in the map.
    const hubA = makeConnectionHub() as unknown as HubView;
    const a = {
      resident: registerSock(hubA, roomId, 'resident'),
      wisp: registerSock(hubA, roomId, 'wisp'),
      crowd: registerSock(hubA, roomId, 'crowd'),
      audience: registerSock(hubA, roomId, 'audience'),
    };
    hubA.broadcastToRoom(roomId, msg);

    // Run B: WITH a recorder teeing.
    const hubB = makeConnectionHub() as unknown as HubView;
    const b = {
      resident: registerSock(hubB, roomId, 'resident'),
      wisp: registerSock(hubB, roomId, 'wisp'),
      crowd: registerSock(hubB, roomId, 'crowd'),
      audience: registerSock(hubB, roomId, 'audience'),
    };
    hubB.recorders.set(roomId, new ReelRecorder({ now: () => 0 }));
    hubB.broadcastToRoom(roomId, msg);

    // Each tier received EXACTLY the same bytes with or without the tee.
    for (const tier of ['resident', 'wisp', 'crowd', 'audience'] as const) {
      expect(b[tier].sent).toEqual(a[tier].sent);
    }
    // And the tee actually captured the frame (it is a real additional sink).
    expect(hubB.getRecorder(roomId)!.rawEventCount).toBe(1);
  });

  it('EXCLUDES a 0x1x voice binary frame from the reel (teeBinary on the fan-out)', () => {
    const hub = makeConnectionHub() as unknown as HubView;
    const roomId = 'voice-room';
    registerSock(hub, roomId, 'resident');
    hub.recorders.set(roomId, new ReelRecorder({ now: () => 0 }));

    // A 0x10 voice frame on the binary fan-out (opcode byte in the 0x10–0x1F window).
    const ab = new ArrayBuffer(8);
    new DataView(ab).setUint8(0, 0x10);
    hub.broadcastBinaryToTiers(roomId, ab);

    const rec = hub.getRecorder(roomId)!;
    expect(rec.excludedVoiceCount).toBe(1);
    // No voice ever reaches the reel bytes.
    const json = JSON.stringify(rec.snapshotReel());
    expect(json).not.toMatch(/voice/);
  });
});

// ===========================================================================
// Full-server REEL transport (BANK / LIST / PLAY) + capability gating.
// ===========================================================================

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const s = _servers.splice(0);
  await Promise.allSettled(s.map((x) => x.close()));
});

function makeServer(): { wsUrl: string; httpBase: string } {
  const server = startServer(0);
  _servers.push(server);
  return {
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpBase: `http://127.0.0.1:${server.port}`,
  };
}

function httpPost(base: string, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function createRoom(httpBase: string): Promise<{ roomId: string; ownerToken: string }> {
  const j = await httpPost(httpBase, '/api/rooms');
  return { roomId: String(j['roomId']), ownerToken: String(j['ownerToken']) };
}

interface Client {
  ws: WebSocket;
  received: ServerMsg[];
  hello?: ServerMsg & { t: 'hello' };
  closed: boolean;
}

async function join(
  wsUrl: string,
  room: string,
  opts: { tier?: string; joinSecret?: string; ownerToken?: string } = {}
): Promise<Client> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    s.binaryType = 'arraybuffer';
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const client: Client = { ws, received: [], closed: false };
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return;
    const msg = decodeText(data.toString()) as ServerMsg;
    client.received.push(msg);
    if (msg.t === 'hello') client.hello = msg as ServerMsg & { t: 'hello' };
  });
  ws.on('close', () => {
    client.closed = true;
  });
  const joinMsg: Record<string, unknown> = { t: 'join', room, name: 'guest', color: 0, protocol: PROTOCOL_VERSION };
  if (opts.tier !== undefined) joinMsg['tier'] = opts.tier;
  if (opts.joinSecret !== undefined) joinMsg['joinSecret'] = opts.joinSecret;
  if (opts.ownerToken !== undefined) joinMsg['ownerToken'] = opts.ownerToken;
  ws.send(encodeText(joinMsg as never));
  await waitUntil(() => client.hello, { label: `hello (${opts.tier ?? 'resident'})` });
  return client;
}

function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 6000, intervalMs = 20, label = 'condition' } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val) return resolve(val);
      if (Date.now() - start >= timeoutMs)
        return reject(new Error(`waitUntil: "${label}" not satisfied within ${timeoutMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function closeAll(cs: Client[]): void {
  for (const c of cs) {
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close();
  }
}

function ofType(c: Client, t: string): ServerMsg[] {
  return c.received.filter((m) => (m as { t: string }).t === t);
}

describe('C22 REEL transport — BANK / LIST / PLAY round-trip + gating', () => {
  it('a director (ownerToken) can BANK → LIST → PLAY a real session reel (anonymized)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A resident generates a real recorded session (join + spawns are broadcast
      // and TEED into the recorder).
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      for (let i = 0; i < 6; i++) {
        resident.ws.send(
          encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: i, y: 1, z: 0 } } } as never)
        );
        await new Promise((r) => setTimeout(r, 10));
      }
      // The stage joins as a director-capable spectator (carries the ownerToken).
      const stage = await join(wsUrl, roomId, { tier: 'spectator', ownerToken });
      clients.push(stage);
      expect(stage.hello!.tier).toBe('spectator');
      // Wait for the room to have broadcast some activity into the recorder.
      await new Promise((r) => setTimeout(r, 150));

      // BANK the current best highlight.
      stage.ws.send(encodeText({ t: 'reel-bank' } as never));
      const ack = (await waitUntil(
        () => ofType(stage, 'reel-ack')[0] as (ServerMsg & { t: 'reel-ack' }) | undefined,
        { label: 'reel-ack' }
      )) as ServerMsg & { t: 'reel-ack'; ok: boolean; reelId?: string };
      expect(ack.ok).toBe(true);
      expect(typeof ack.reelId).toBe('string');

      // LIST shows the banked reel.
      stage.ws.send(encodeText({ t: 'reel-list' } as never));
      const listing = (await waitUntil(
        () => ofType(stage, 'reel-listing').slice(-1)[0] as (ServerMsg & { t: 'reel-listing' }) | undefined,
        { label: 'reel-listing' }
      )) as ServerMsg & { t: 'reel-listing'; reels: Array<{ id: string; frameCount: number }> };
      expect(listing.reels.length).toBeGreaterThanOrEqual(1);
      expect(listing.reels.some((r) => r.id === ack.reelId)).toBe(true);

      // PLAY returns the reel's frames (the ATTRACT ghost source) — anonymized.
      stage.ws.send(encodeText({ t: 'reel-play', reelId: ack.reelId } as never));
      const data = (await waitUntil(
        () => ofType(stage, 'reel-data')[0] as (ServerMsg & { t: 'reel-data' }) | undefined,
        { label: 'reel-data' }
      )) as ServerMsg & { t: 'reel-data'; reelId: string | null; reel: { frames: unknown[] } | null };
      expect(data.reelId).toBe(ack.reelId);
      expect(data.reel).not.toBeNull();
      expect(data.reel!.frames.length).toBeGreaterThan(0);
      // The played reel never carries a raw name (record-time sanitized, §6.1).
      const json = JSON.stringify(data.reel);
      expect(json).not.toContain(resident.hello!.callsign);
      expect(json).not.toContain('guest');
    } finally {
      closeAll(clients);
    }
  });

  it('an UNAUTHORIZED bank is REFUSED (reel-ack ok:false), never banked', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A resident with activity but WITHOUT the ownerToken (not director-capable).
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } } as never)
      );
      await new Promise((r) => setTimeout(r, 80));

      // A NON-director spectator (secret only, no ownerToken) may READ but NOT bank.
      const stage = await join(wsUrl, roomId, { tier: 'spectator', joinSecret: secret });
      clients.push(stage);

      stage.ws.send(encodeText({ t: 'reel-bank' } as never));
      const ack = (await waitUntil(
        () => ofType(stage, 'reel-ack')[0] as (ServerMsg & { t: 'reel-ack' }) | undefined,
        { label: 'reel-ack (refused)' }
      )) as ServerMsg & { t: 'reel-ack'; ok: boolean; reason?: string };
      expect(ack.ok).toBe(false);
      expect(ack.reason).toBe('not-authorized');

      // The bank stayed EMPTY — a LIST from the non-director shows nothing banked.
      stage.ws.send(encodeText({ t: 'reel-list' } as never));
      const listing = (await waitUntil(
        () => ofType(stage, 'reel-listing').slice(-1)[0] as (ServerMsg & { t: 'reel-listing' }) | undefined,
        { label: 'reel-listing (empty)' }
      )) as ServerMsg & { t: 'reel-listing'; reels: unknown[] };
      expect(listing.reels).toHaveLength(0);
    } finally {
      closeAll(clients);
    }
  });

  it('reel-play with an empty bank returns reel-data null (the day-one ballet fallback)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const clients: Client[] = [];
    try {
      const stage = await join(wsUrl, roomId, { tier: 'spectator', ownerToken });
      clients.push(stage);
      stage.ws.send(encodeText({ t: 'reel-play' } as never));
      const data = (await waitUntil(
        () => ofType(stage, 'reel-data')[0] as (ServerMsg & { t: 'reel-data' }) | undefined,
        { label: 'reel-data null' }
      )) as ServerMsg & { t: 'reel-data'; reelId: string | null; reel: unknown };
      expect(data.reelId).toBeNull();
      expect(data.reel).toBeNull();
    } finally {
      closeAll(clients);
    }
  });
});
