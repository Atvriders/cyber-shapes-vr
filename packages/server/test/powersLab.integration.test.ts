/**
 * powersLab.integration.test.ts — Task C32 F21 Powers Lab (spec §7.21).
 *
 * The CAPABILITY GATE end-to-end against the LIVE server (real startServer + real
 * ws): the powers-lab cue is ABSENT from the director's CUE_CATALOG until BOTH a
 * resident has reported camera-tracked hands (a TK_HANDS_STATE binary frame) AND
 * the POWERS_LAB_ENABLED env flag is set — then it appears (a CUE_CATALOG
 * re-broadcast). Default OFF is proven by the flag-off case never advertising it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import {
  encodeText,
  decodeText,
  encodeBinary,
  PROTOCOL_VERSION,
  OPCODES,
  TELEKINESIS_KIND,
} from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';

let _servers: ServerHandle[] = [];
const _envBefore = process.env.POWERS_LAB_ENABLED;
afterEach(async () => {
  const s = _servers.splice(0);
  await Promise.allSettled(s.map((x) => x.close()));
  if (_envBefore === undefined) delete process.env.POWERS_LAB_ENABLED;
  else process.env.POWERS_LAB_ENABLED = _envBefore;
});

function makeServer(): { wsUrl: string; httpBase: string } {
  const server = startServer(0);
  _servers.push(server);
  return { wsUrl: `ws://127.0.0.1:${server.port}`, httpBase: `http://127.0.0.1:${server.port}` };
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Client {
  ws: WebSocket;
  received: ServerMsg[];
  hello?: ServerMsg & { t: 'hello' };
}

async function join(
  url: string,
  room: string,
  opts: { tier?: string; joinSecret?: string; ownerToken?: string } = {}
): Promise<Client> {
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

/** The latest CUE_CATALOG the director has received, as a list of cue ids. */
function catalogIds(director: Client): string[] {
  const cats = director.received.filter(
    (m) => (m as { t: string; kind?: string }).t === 'director-msg' && (m as { kind?: string }).kind === 'CATALOG'
  );
  const last = cats[cats.length - 1] as unknown as { catalog?: Array<{ id: string }> } | undefined;
  return (last?.catalog ?? []).map((c) => c.id);
}

/** The TK_HANDS_STATE {available:1} binary frame a headset sends on inputsourceschange. */
function handsStateFrame(available: number): ArrayBuffer {
  return encodeBinary(OPCODES.TELEKINESIS, TELEKINESIS_KIND.TK_HANDS_STATE, { available, reserved: 0 });
}

describe('C32 Powers Lab — capability gate (live server)', () => {
  it('the powers-lab cue is ABSENT from CUE_CATALOG when the flag is OFF, even with hands reported', async () => {
    delete process.env.POWERS_LAB_ENABLED; // default OFF
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      // wait for the initial catalog to establish the baseline
      await waitUntil(() => catalogIds(director).length > 0, { label: 'initial catalog' });
      // the resident reports camera-tracked hands
      resident.ws.send(handsStateFrame(1));
      await sleep(150); // allow any (there should be none) re-broadcast to arrive
      expect(catalogIds(director)).not.toContain('powers-lab');
    } finally {
      closeAll(clients);
    }
  });

  it('the powers-lab cue is ABSENT when the flag is ON but NO hands have been reported', async () => {
    process.env.POWERS_LAB_ENABLED = '1';
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      await waitUntil(() => catalogIds(director).length > 0, { label: 'initial catalog' });
      await sleep(100);
      expect(catalogIds(director)).not.toContain('powers-lab');
    } finally {
      closeAll(clients);
    }
  });

  it('the powers-lab cue APPEARS once (hands reported ∧ flag ON) — a CUE_CATALOG re-broadcast', async () => {
    process.env.POWERS_LAB_ENABLED = '1';
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      await waitUntil(() => catalogIds(director).length > 0, { label: 'initial catalog' });
      // Absent before hands.
      expect(catalogIds(director)).not.toContain('powers-lab');
      // The resident reports camera-tracked hands (inputsourceschange).
      resident.ws.send(handsStateFrame(1));
      // The cue now registers → a CUE_CATALOG re-broadcast carries it.
      await waitUntil(() => catalogIds(director).includes('powers-lab'), {
        label: 'powers-lab advertised after hands∧flag',
      });
      // It is an ADVANCED-tab, LOBBY/PLAY cue (never ATTRACT) — check the entry.
      const cats = director.received.filter(
        (m) => (m as { t: string; kind?: string }).t === 'director-msg' && (m as { kind?: string }).kind === 'CATALOG'
      );
      const last = cats[cats.length - 1] as unknown as {
        catalog: Array<{ id: string; tab: string; phases: string[] }>;
      };
      const entry = last.catalog.find((c) => c.id === 'powers-lab')!;
      expect(entry.tab).toBe('advanced');
      expect(entry.phases).toEqual(['LOBBY', 'PLAY']);
      expect(entry.phases).not.toContain('ATTRACT');
    } finally {
      closeAll(clients);
    }
  });
});

// =============================================================================
// C22.5 Part C.3 — gating ORDER race: hands-reported-BEFORE-the-lab-exists. This
// cannot be reached through the PUBLIC wire API — `ensureHost` (and so the room's
// `PowersLabHost`) always runs synchronously within the SAME join handshake that
// must complete before any TK_HANDS_STATE for that room can be sent at all — but a
// future refactor could change that. A cheap, idempotent defensive re-check
// (`maybeRegisterPowersLabCue(room.roomId)` right after `h.powersLabs.set(...)` in
// connection.ts) makes the ordering guaranteed-safe regardless. This test drives
// that fix directly: it seeds the `powersHandsReported` latch on the INTERNAL hub
// BEFORE the room (and so the lab) exists, then proves the cue still appears the
// instant the room is created — the latch is never permanently missed.
// =============================================================================
import { makeConnectionHub, handleConnection } from '../src/connection.js';
import type { ConnectionHub } from '../src/connection.js';
import { RoomManager } from '../src/roomManager.js';
import { RoomAuthStore } from '../src/auth.js';

describe('C22.5 Part C.3 — powers-lab cue registration is ORDER-INDEPENDENT (hands-before-lab)', () => {
  class OrderFakeWs {
    readyState = 1;
    closed = false;
    received: ServerMsg[] = [];
    private readonly listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    on(ev: string, cb: (...a: unknown[]) => void): this {
      const l = this.listeners.get(ev);
      if (l) l.push(cb);
      else this.listeners.set(ev, [cb]);
      return this;
    }
    once(ev: string, cb: (...a: unknown[]) => void): this {
      const wrap = (...a: unknown[]): void => {
        this.off(ev, wrap);
        cb(...a);
      };
      return this.on(ev, wrap);
    }
    off(ev: string, cb: (...a: unknown[]) => void): this {
      const l = this.listeners.get(ev);
      if (l) {
        const i = l.indexOf(cb);
        if (i >= 0) l.splice(i, 1);
      }
      return this;
    }
    emit(ev: string, ...args: unknown[]): void {
      const l = this.listeners.get(ev);
      if (l) for (const cb of [...l]) cb(...args);
    }
    send(data: unknown): void {
      if (this.closed || typeof data !== 'string') return;
      try {
        this.received.push(decodeText(data) as ServerMsg);
      } catch {
        /* not JSON */
      }
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
      this.emit('close');
    }
  }

  function memFs(): { readFile: (p: string) => Promise<string>; writeFile: (p: string, d: string) => Promise<void> } {
    const store = new Map<string, string>();
    return {
      async readFile(p) {
        const v = store.get(p);
        if (v === undefined) {
          const e = new Error('ENOENT') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        }
        return v;
      },
      async writeFile(p, d) {
        store.set(p, d);
      },
    };
  }

  it('a hands-reported latch set BEFORE the room/lab exist still registers the cue the instant the room is created', async () => {
    process.env.POWERS_LAB_ENABLED = '1';
    try {
      const manager = new RoomManager(null);
      const hub: ConnectionHub = makeConnectionHub();
      const authStore = new RoomAuthStore({ now: () => Date.now(), dir: '/mem', ...memFs() });
      const created = await authStore.createRoom('1.0.0.1');
      if ('error' in created) throw new Error('createRoom failed');
      const roomId = created.roomId;
      const ownerToken = created.ownerToken;

      // Seed the latch BEFORE any join — at this point NEITHER `h.hosts` NOR
      // `h.powersLabs` has an entry for `roomId` (the room doesn't even exist in
      // the RoomManager yet). This is the exact "hands reported before the lab
      // exists" ordering the task worries about.
      (hub as unknown as { powersHandsReported: Map<string, boolean> }).powersHandsReported.set(roomId, true);

      const director = new OrderFakeWs();
      handleConnection(director as never, manager, hub, () => {}, () => {}, {
        authStore,
        clientIp: '1.0.0.1',
      });
      director.emit(
        'message',
        encodeText({
          t: 'join',
          room: roomId,
          name: 'guest',
          color: 0,
          protocol: PROTOCOL_VERSION,
          tier: 'director',
          ownerToken,
        } as never),
        false
      );
      // Flush the async join IIFE.
      for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));

      const cats = director.received.filter(
        (m) => (m as { t: string; kind?: string }).t === 'director-msg' && (m as { kind?: string }).kind === 'CATALOG'
      );
      expect(cats.length).toBeGreaterThan(0);
      const last = cats[cats.length - 1] as unknown as { catalog: Array<{ id: string }> };
      // The cue registered the INSTANT the room's lab was created — never stuck
      // unregistered just because the latch predates the room.
      expect(last.catalog.map((c) => c.id)).toContain('powers-lab');
    } finally {
      delete process.env.POWERS_LAB_ENABLED;
    }
  });
});

// =============================================================================
// C22.5 Part C.6 — TK_HANDS_STATE{available:0} DEREGISTRATION decision.
//
// DECISION: the capability latch (`powersHandsReported`) stays A ONE-WAY LATCH —
// a hands-dropped signal (`available:0`) is intentionally a NO-OP; the cue is
// never de-registered once advertised. Justification:
//   1. The feature is DEFAULT-OFF (`POWERS_LAB_ENABLED`); this only matters once
//      an owner has already opted a booth in.
//   2. Advertising the cue is NOT the same as arming TK — a director/staffer must
//      still explicitly FIRE it (`lab.arm()`); a hands-drop mid-session doesn't
//      leave TK silently active.
//   3. Even if TK IS armed and hands are physically dropped, the ~250 ms dead-man
//      switch (already test-enforced above) releases any live pull well before a
//      catalog entry's presence/absence could matter.
//   4. De-registering would require re-broadcasting CUE_CATALOG on every
//      hands-flicker (camera hand-tracking is noisy — frequent transient losses),
//      which is disproportionate churn for a cosmetic catalog entry on a
//      staff-only advanced tab, for a booth exhibit that is supervised anyway.
// This test documents (and pins) that decision: an `available:0` frame is a
// structural no-op — the cue, once advertised, is NEVER pulled back.
// =============================================================================
describe('C22.5 Part C.6 — TK_HANDS_STATE{available:0} is a documented no-op (accepted one-way latch)', () => {
  it('hands dropping (available:0) after the cue is advertised does NOT de-register it', async () => {
    process.env.POWERS_LAB_ENABLED = '1';
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      await waitUntil(() => catalogIds(director).length > 0, { label: 'initial catalog' });

      resident.ws.send(handsStateFrame(1));
      await waitUntil(() => catalogIds(director).includes('powers-lab'), { label: 'cue advertised' });
      const catalogLenAfterAdvertise = director.received.length;

      // Hands drop (camera lost tracking / gloves off).
      resident.ws.send(handsStateFrame(0));
      await sleep(150); // give any (there should be none) re-broadcast a chance to arrive

      // The DECISION, pinned: still present (never de-registered), and no extra
      // CUE_CATALOG churn was triggered by the drop (a true structural no-op, not
      // merely "re-broadcast the same list").
      expect(catalogIds(director)).toContain('powers-lab');
      expect(director.received.length).toBe(catalogLenAfterAdvertise);
    } finally {
      closeAll(clients);
    }
  });
});
