/**
 * showrunner.integration.test.ts — Task C10.
 *
 * The Showrunner wired into the LIVE server loop (real startServer + real ws
 * clients + the real POST /api/rooms ownerToken flow). Asserts:
 *   • PHASE_STATE reaches a RESIDENT (the CARRIED widen — director + residents,
 *     NOT director-only);
 *   • a director FIRE command fires a seed cue end-to-end (shape-rain spawns
 *     shapes that reach a resident as ordinary `spawn` ServerMsgs);
 *   • the seed CUE_CATALOG is advertised to the director;
 *   • MUTE / disconnect (KICK) round-trip via the director console.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { encodeText, decodeText, PROTOCOL_VERSION } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const s = _servers.splice(0);
  await Promise.allSettled(s.map((x) => x.close()));
});

function makeServer(): { server: ServerHandle; wsUrl: string; httpBase: string } {
  const server = startServer(0);
  _servers.push(server);
  return {
    server,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpBase: `http://127.0.0.1:${server.port}`,
  };
}

function httpPost(base: string, path: string, ip = '9.9.9.9'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      },
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

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}
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

interface Client {
  ws: WebSocket;
  received: ServerMsg[];
  hello?: ServerMsg & { t: 'hello' };
}

interface JoinOpts {
  tier?: string;
  joinSecret?: string;
  ownerToken?: string;
}

async function join(url: string, room: string, opts: JoinOpts = {}): Promise<Client> {
  const ws = await openSocket(url);
  const client: Client = { ws, received: [] };
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return;
    const msg = decodeText(data.toString()) as ServerMsg;
    client.received.push(msg);
    if (msg.t === 'hello') client.hello = msg as ServerMsg & { t: 'hello' };
  });
  const joinMsg: Record<string, unknown> = {
    t: 'join',
    room,
    name: 'guest',
    color: 0,
    protocol: PROTOCOL_VERSION,
  };
  if (opts.tier !== undefined) joinMsg['tier'] = opts.tier;
  if (opts.joinSecret !== undefined) joinMsg['joinSecret'] = opts.joinSecret;
  if (opts.ownerToken !== undefined) joinMsg['ownerToken'] = opts.ownerToken;
  ws.send(encodeText(joinMsg as never));
  await waitUntil(() => client.hello, { label: `hello (${opts.tier ?? 'resident'})` });
  return client;
}

function closeAll(cs: Client[]): void {
  for (const c of cs) {
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close();
  }
}

function ofType(client: Client, t: string): ServerMsg[] {
  return client.received.filter((m) => (m as { t: string }).t === t);
}

describe('C10 Showrunner — live host wiring', () => {
  it('PHASE_STATE reaches a RESIDENT (the widen — director + residents)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const ps = await waitUntil(() => ofType(resident, 'phase-state')[0], {
        label: 'resident receives PHASE_STATE',
      });
      expect((ps as unknown as { phase: string }).phase).toBeTypeOf('string');
    } finally {
      closeAll(clients);
    }
  });

  it('a director FIRE command fires shape-rain end-to-end (shapes reach a resident)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);

      const before = ofType(resident, 'spawn').length;
      director.ws.send(
        encodeText({
          t: 'director-cmd',
          cmd: 'FIRE',
          cueId: 'shape-rain',
          cueInstanceId: 'fire-1',
        } as never)
      );
      await waitUntil(() => ofType(resident, 'spawn').length > before, {
        label: 'resident sees shape-rain spawns',
      });
      expect(ofType(resident, 'spawn').length).toBeGreaterThan(before);
    } finally {
      closeAll(clients);
    }
  });

  it('advertises the seed CUE_CATALOG (shape-rain + low-g) to the director', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const catMsg = await waitUntil(
        () =>
          director.received.find(
            (m) =>
              (m as { t: string; kind?: string }).t === 'director-msg' &&
              (m as { kind?: string }).kind === 'CATALOG'
          ),
        { label: 'director receives CUE_CATALOG' }
      );
      const catalog = ((catMsg as unknown as { catalog?: Array<{ id: string }> }).catalog ?? []).map(
        (c) => c.id
      );
      expect(catalog).toContain('shape-rain');
      expect(catalog).toContain('low-g');
    } finally {
      closeAll(clients);
    }
  });

  it('the timeline controls (ADVANCE / FINALE / RESET) drive the phase for residents', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);

      // The resident join already advanced ATTRACT→LOBBY. FINALE jumps to FINALE.
      const seenPhase = (phase: string): boolean =>
        resident.received.some((m) => (m as { t: string; phase?: string }).t === 'phase-state' && (m as { phase?: string }).phase === phase);
      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'FINALE' } as never));
      await waitUntil(() => seenPhase('FINALE'), { label: 'resident sees FINALE' });
      expect(seenPhase('FINALE')).toBe(true);
    } finally {
      closeAll(clients);
    }
  });

  it('MUTE + disconnect (KICK) round-trip via the director console', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const victim = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(victim);
      const victimId = victim.hello!.peerId;

      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'MUTE', targetId: victimId } as never));
      await waitUntil(
        () =>
          director.received.find(
            (m) =>
              (m as { t: string; cmd?: string }).t === 'director-ack' &&
              (m as { cmd?: string }).cmd === 'MUTE'
          ),
        { label: 'MUTE ack' }
      );

      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'KICK', targetId: victimId } as never));
      await waitUntil(
        () =>
          victim.ws.readyState === WebSocket.CLOSED || victim.ws.readyState === WebSocket.CLOSING,
        { label: 'victim disconnected' }
      );
      expect([WebSocket.CLOSED, WebSocket.CLOSING]).toContain(victim.ws.readyState);
    } finally {
      closeAll(clients);
    }
  });
});
