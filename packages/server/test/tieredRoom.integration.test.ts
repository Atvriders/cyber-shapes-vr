/**
 * tieredRoom.integration.test.ts — Task C2
 *
 * Extends the Phase B headless multi-client harness to the tiered room manager:
 * the join handshake (`{tier, joinSecret?, requestedName?}` → `{peerId, callsign,
 * tier, roomEpoch}`), tier auth + crowd-downgrade, per-tier caps + over-cap
 * downgrade payloads, per-tier fan-out (residents full / wisps ONE shared 5 Hz
 * coalesced buffer / crowd family-specific only), voice fan-out + roster
 * membership, spectator send-whitelist, wisp intent rejection, callsign overwrite
 * + uniqueness, and the idle-kick (fake timers).
 *
 * Uses the REAL server (startServer) + REAL ws clients — no mocks, authentic
 * protocol. A FakeTimerApi is injected into startServer for the idle-kick case so
 * we drive the 90–120 s idle window without wall-clock sleeps.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { encodeText, decodeText, packVoice, unpackVoice, VOICE_OPUS, PROTOCOL_VERSION, CURATED_WORDLIST } from '@cyber-shapes/shared';
import type { ServerMsg, Tier, TimerApi, TimerHandle } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { negotiateTier } from '../src/connection.js';

// ---------------------------------------------------------------------------
// The known staff key injected into every test server. Real resident/spectator
// joins present this; a privileged join without it downgrades to crowd.
// ---------------------------------------------------------------------------
const STAFF_KEY = 'test-staff-key-c2';

// ---------------------------------------------------------------------------
// A controllable fake TimerApi (for the idle-kick case). Timers fire when the
// clock is advanced past their deadline via `advance(ms)`.
// ---------------------------------------------------------------------------
class FakeTimerApi implements TimerApi {
  private _now = 0;
  private _seq = 0;
  private readonly _timers = new Map<number, { at: number; cb: () => void }>();

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this._seq++;
    this._timers.set(id, { at: this._now + ms, cb });
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this._timers.delete(h as number);
  }
  now(): number {
    return this._now;
  }
  /** Advance the clock by `ms`, firing any timers whose deadline passed. */
  advance(ms: number): void {
    this._now += ms;
    // Fire due timers in deadline order; a fired timer may schedule more.
    let fired = true;
    while (fired) {
      fired = false;
      for (const [id, t] of [...this._timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= this._now) {
          this._timers.delete(id);
          t.cb();
          fired = true;
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let _activeServers: ServerHandle[] = [];

afterEach(async () => {
  const servers = _activeServers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
});

function makeServer(opts?: { timerApi?: TimerApi }): { server: ServerHandle; url: string } {
  const server = startServer(0, { staffKey: STAFF_KEY, ...(opts ?? {}) });
  _activeServers.push(server);
  return { server, url: `ws://127.0.0.1:${server.port}` };
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextText(ws: WebSocket, timeoutMs = 3000): Promise<ServerMsg> {
  return new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nextText timed out after ${timeoutMs}ms`)), timeoutMs);
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(decodeText(data.toString()) as ServerMsg);
    };
    ws.on('message', onMsg);
  });
}

function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 4000, intervalMs = 25, label = 'condition' } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val) return resolve(val);
      if (Date.now() - start >= timeoutMs) return reject(new Error(`waitUntil: "${label}" not satisfied within ${timeoutMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A tiered client: records all text messages + binary frames, exposes hello.
// ---------------------------------------------------------------------------

interface TieredClient {
  ws: WebSocket;
  received: ServerMsg[];
  binary: Buffer[];
  hello?: ServerMsg & { t: 'hello' };
  downgrade?: ServerMsg & { t: 'downgrade' };
}

interface JoinOpts {
  tier?: Tier;
  joinSecret?: string;
  requestedName?: number;
  name?: string;
}

/** Open a socket, send a tiered join, and record everything. Resolves once the
 *  `hello` reply lands (every accepted join — including a downgrade — replies
 *  with a hello). */
async function joinTiered(url: string, room: string, opts: JoinOpts = {}): Promise<TieredClient> {
  const ws = await openSocket(url);
  const client: TieredClient = { ws, received: [], binary: [] };

  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      client.binary.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const msg = decodeText(data.toString()) as ServerMsg;
    client.received.push(msg);
    if (msg.t === 'hello') client.hello = msg;
    if (msg.t === 'downgrade') client.downgrade = msg;
  });

  const joinMsg: Record<string, unknown> = {
    t: 'join',
    room,
    name: opts.name ?? 'guest',
    color: 0,
    protocol: PROTOCOL_VERSION,
  };
  if (opts.tier !== undefined) joinMsg['tier'] = opts.tier;
  if (opts.joinSecret !== undefined) joinMsg['joinSecret'] = opts.joinSecret;
  if (opts.requestedName !== undefined) joinMsg['requestedName'] = opts.requestedName;
  ws.send(encodeText(joinMsg as never));

  await waitUntil(() => client.hello, { label: `hello for ${opts.tier ?? 'resident'} in ${room}` });
  return client;
}

function closeAll(clients: TieredClient[]): void {
  for (const c of clients) {
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close();
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('C2 tiered room manager — handshake + tier auth', () => {
  it('(handshake) a resident join replies {peerId, callsign, tier, roomEpoch} and callsign matches the frozen format', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const r = await joinTiered(url, 'hs-room', { tier: 'resident', joinSecret: STAFF_KEY });
      clients.push(r);
      expect(r.hello).toBeDefined();
      expect(r.hello!.tier).toBe('resident');
      expect(typeof r.hello!.peerId).toBe('string');
      expect(typeof r.hello!.roomEpoch).toBe('number');
      expect(r.hello!.callsign).toMatch(/^[A-Z]{3,10}-\d{2,3}$/);
    } finally {
      closeAll(clients);
    }
  });

  it('(a) unauthed TIER_HELLO{tier:resident} is DOWNGRADED to crowd, never rejected', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const c = await joinTiered(url, 'dg-room', { tier: 'resident' /* no secret */ });
      clients.push(c);
      expect(c.hello!.tier).toBe('crowd');
      expect(c.downgrade).toBeDefined();
      expect(c.downgrade!.from).toBe('resident');
      expect(c.downgrade!.to).toBe('crowd');
      // Never an error / never closed.
      expect(c.received.some((m) => m.t === 'error')).toBe(false);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeAll(clients);
    }
  });

  it('(a) 9th resident rejected (room-full); 9th CROWD accepted (>8 non-privileged is fine)', async () => {
    const { url } = makeServer();
    const residents: TieredClient[] = [];
    const crowd: TieredClient[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        residents.push(await joinTiered(url, 'cap-room', { tier: 'resident', joinSecret: STAFF_KEY }));
      }
      // 9th resident (authed) → hard room-full rejection (Phase B invariant).
      const ws9 = await openSocket(url);
      ws9.send(encodeText({ t: 'join', room: 'cap-room', name: 'x', color: 0, protocol: PROTOCOL_VERSION, tier: 'resident', joinSecret: STAFF_KEY } as never));
      const err = await nextText(ws9);
      expect(err.t).toBe('error');
      if (err.t === 'error') expect(err.code).toBe('room-full');
      ws9.close();

      // A crowd joiner into the SAME room (already 8 residents) is accepted.
      crowd.push(await joinTiered(url, 'cap-room', { tier: 'crowd' }));
      expect(crowd[0].hello!.tier).toBe('crowd');
    } finally {
      closeAll([...residents, ...crowd]);
    }
  });
});

describe('C2 tiered room manager — per-tier caps + over-cap downgrade', () => {
  it('(b) each public tier honors its cap: 24 wisps fit; the 25th downgrades to a spectate page', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      for (let i = 0; i < 24; i++) {
        clients.push(await joinTiered(url, 'wisp-cap', { tier: 'wisp' }));
      }
      expect(clients.every((c) => c.hello!.tier === 'wisp')).toBe(true);
      // (i) over-cap wisp → spectate-page downgrade (NOT a rejection).
      const over = await joinTiered(url, 'wisp-cap', { tier: 'wisp' });
      clients.push(over);
      expect(over.hello!.tier).not.toBe('wisp');
      expect(over.downgrade).toBeDefined();
      expect(over.downgrade!.from).toBe('wisp');
      expect(over.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeAll(clients);
    }
  });

  it('(b) spectator cap is 2 (authed)', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      clients.push(await joinTiered(url, 'spec-cap', { tier: 'spectator', joinSecret: STAFF_KEY }));
      clients.push(await joinTiered(url, 'spec-cap', { tier: 'spectator', joinSecret: STAFF_KEY }));
      expect(clients.every((c) => c.hello!.tier === 'spectator')).toBe(true);
      // 3rd authed spectator is over cap → downgrade (never a rejection screen).
      const over = await joinTiered(url, 'spec-cap', { tier: 'spectator', joinSecret: STAFF_KEY });
      clients.push(over);
      expect(over.hello!.tier).not.toBe('spectator');
    } finally {
      closeAll(clients);
    }
  });
});

describe('C2 tiered room manager — per-tier fan-out', () => {
  it('(c)+(d) wisps receive ONE shared serialized coalesced buffer at ~5 Hz; residents get full-rate state', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const resident = await joinTiered(url, 'fanout', { tier: 'resident', joinSecret: STAFF_KEY });
      const w1 = await joinTiered(url, 'fanout', { tier: 'wisp' });
      const w2 = await joinTiered(url, 'fanout', { tier: 'wisp' });
      clients.push(resident, w1, w2);
      await wait(30);

      // Resident spawns a falling shape so `state` messages flow for ~1 s.
      resident.ws.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 5, z: 0 } } }));
      await wait(1000);

      const residentStates = resident.received.filter((m) => m.t === 'state').length;
      // Wisps receive a coalesced summary family (never `state`).
      const w1Coalesced = w1.received.filter((m) => (m as { t: string }).t === 'wisp-coalesced').length;
      const w1States = w1.received.filter((m) => m.t === 'state').length;

      // Wisps NEVER get raw resident-rate `state` frames.
      expect(w1States).toBe(0);
      // Residents get full-rate (~15 Hz) — many frames over 1 s.
      expect(residentStates).toBeGreaterThan(5);
      // Wisps get the decimated ~5 Hz coalesced buffer — present but far fewer.
      expect(w1Coalesced).toBeGreaterThan(0);
      expect(w1Coalesced).toBeLessThan(residentStates);
    } finally {
      closeAll(clients);
    }
  });

  it('(e) crowd NEVER receives a delta (state) or a pose', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const resident = await joinTiered(url, 'crowd-fanout', { tier: 'resident', joinSecret: STAFF_KEY });
      const crowd = await joinTiered(url, 'crowd-fanout', { tier: 'crowd' });
      clients.push(resident, crowd);
      await wait(30);

      resident.ws.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 6, z: 0 } } }));
      // Resident streams a pose.
      resident.ws.send(encodeText({ t: 'pose', pose: { head: { p: { x: 0, y: 1, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [] } }));
      await wait(700);

      expect(crowd.received.some((m) => m.t === 'state')).toBe(false);
      expect(crowd.received.some((m) => m.t === 'pose')).toBe(false);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C2 tiered room manager — voice fan-out + roster membership', () => {
  it('(f) a wisp gets NEITHER a VOICE_ROSTER entry NOR voice frames; an authed spectator gets frames but no roster entry', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const resA = await joinTiered(url, 'voice-tier', { tier: 'resident', joinSecret: STAFF_KEY });
      const resB = await joinTiered(url, 'voice-tier', { tier: 'resident', joinSecret: STAFF_KEY });
      const spec = await joinTiered(url, 'voice-tier', { tier: 'spectator', joinSecret: STAFF_KEY });
      const wisp = await joinTiered(url, 'voice-tier', { tier: 'wisp' });
      clients.push(resA, resB, spec, wisp);
      await wait(30);

      // Residents enable voice (send). Spectator/wisp cannot send but may recv.
      resA.ws.send(encodeText({ t: 'voice-join' }));
      resB.ws.send(encodeText({ t: 'voice-join' }));
      await wait(120);

      // The VOICE_ROSTER on any peer that receives it lists SENDERS = residents only.
      const rosterOnB = [...resB.received].reverse().find((m) => m.t === 'voice-roster') as (ServerMsg & { t: 'voice-roster' }) | undefined;
      expect(rosterOnB).toBeDefined();
      const rosterIds = new Set(rosterOnB!.players.map((p) => p.id));
      expect(rosterIds.has(resA.hello!.peerId)).toBe(true);
      expect(rosterIds.has(resB.hello!.peerId)).toBe(true);
      // Spectator + wisp are NOT senders → never in the roster.
      expect(rosterIds.has(spec.hello!.peerId)).toBe(false);
      expect(rosterIds.has(wisp.hello!.peerId)).toBe(false);

      // resA sends a voice frame. It must reach resB (resident) + spec (spectator
      // recv) but NOT wisp.
      const opus = new Uint8Array([1, 2, 3, 4]);
      resA.ws.send(Buffer.from(packVoice(VOICE_OPUS, 0, 0, 0, opus)));
      await wait(200);

      const numericA = parseInt(resA.hello!.peerId.slice(1), 10);
      const bGotFrame = spec.binary.length >= 0 && resB.binary.some((buf) => unpackVoice(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)).senderId === numericA);
      const specGotFrame = spec.binary.some((buf) => unpackVoice(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)).senderId === numericA);
      expect(bGotFrame, 'resident B should receive the voice frame').toBe(true);
      expect(specGotFrame, 'authed spectator should receive the voice frame').toBe(true);
      expect(wisp.binary.length, 'wisp must receive ZERO voice frames').toBe(0);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C2 tiered room manager — send policy (whitelist / intents)', () => {
  it('(g) a spectator SPAWN intent is dropped, but a REEL/REQUEST_SNAPSHOT request is honored path-wise (no error)', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const resident = await joinTiered(url, 'spec-send', { tier: 'resident', joinSecret: STAFF_KEY });
      const spec = await joinTiered(url, 'spec-send', { tier: 'spectator', joinSecret: STAFF_KEY });
      clients.push(resident, spec);
      await wait(30);

      const residentSpawnsBefore = resident.received.filter((m) => m.t === 'spawn').length;
      // Spectator attempts to spawn — must be dropped (never reaches the world).
      spec.ws.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } }));
      await wait(300);
      const residentSpawnsAfter = resident.received.filter((m) => m.t === 'spawn').length;
      expect(residentSpawnsAfter, 'spectator spawn must NOT create a shape').toBe(residentSpawnsBefore);

      // A spectator stream-subscription / snapshot request is on the whitelist:
      // it must not error the connection.
      spec.ws.send(encodeText({ t: 'request-snapshot' } as never));
      await wait(150);
      expect(spec.received.some((m) => m.t === 'error'), 'spectator whitelist request should not error').toBe(false);
      expect(spec.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeAll(clients);
    }
  });

  it('(l) a wisp GRAB intent is rejected server-side (wisps cannot grab world shapes)', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const resident = await joinTiered(url, 'wisp-grab', { tier: 'resident', joinSecret: STAFF_KEY });
      const wisp = await joinTiered(url, 'wisp-grab', { tier: 'wisp' });
      clients.push(resident, wisp);
      await wait(30);

      // Resident spawns a shape.
      resident.ws.send(encodeText({ t: 'spawn', shape: { type: 'sphere', position: { x: 0, y: 1, z: 0 } } }));
      const spawn = await waitUntil(
        () => resident.received.find((m) => m.t === 'spawn') as (ServerMsg & { t: 'spawn' }) | undefined,
        { label: 'resident spawn echo' }
      );
      const shapeId = spawn.shape.id;
      await wait(50);

      // Wisp tries to grab it — must be dropped, no grab event ever broadcast.
      wisp.ws.send(encodeText({ t: 'grab', id: shapeId }));
      await wait(300);
      const anyGrab = resident.received.some((m) => m.t === 'grab' && (m as { peerId?: unknown }).peerId === wisp.hello!.peerId);
      expect(anyGrab, 'a wisp grab must never take ownership').toBe(false);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C2 tiered room manager — callsigns', () => {
  it('(j) a free-text requestedName never appears in the callsign; presence name is overwritten with the callsign', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      // A second resident observes the joiner's presence name.
      const observer = await joinTiered(url, 'callsign-room', { tier: 'resident', joinSecret: STAFF_KEY });
      clients.push(observer);
      await wait(20);
      const joiner = await joinTiered(url, 'callsign-room', {
        tier: 'resident',
        joinSecret: STAFF_KEY,
        name: 'PROFANE_FREETEXT_HANDLE',
      });
      clients.push(joiner);

      // The callsign the joiner was assigned never contains the raw free text.
      expect(joiner.hello!.callsign).not.toContain('PROFANE');
      expect(joiner.hello!.callsign).toMatch(/^[A-Z]{3,10}-\d{2,3}$/);

      // The observer's player-join for the joiner carries the CALLSIGN as name.
      const pj = await waitUntil(
        () =>
          observer.received.find(
            (m) => m.t === 'player-join' && (m as { player: { id: string } }).player.id === joiner.hello!.peerId
          ) as (ServerMsg & { t: 'player-join' }) | undefined,
        { label: 'observer sees joiner player-join' }
      );
      expect(pj.player.name).toBe(joiner.hello!.callsign);
      expect(pj.player.name).not.toContain('PROFANE');
    } finally {
      closeAll(clients);
    }
  });

  it('(j) a valid requestedName wordlist INDEX is honored as the callsign word', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const idx = 0; // CURATED_WORDLIST[0] === 'VOLT'
      const c = await joinTiered(url, 'reqname-room', { tier: 'crowd', requestedName: idx });
      clients.push(c);
      expect(c.hello!.callsign.startsWith(`${CURATED_WORDLIST[idx]}-`)).toBe(true);
    } finally {
      closeAll(clients);
    }
  });

  it('(k) 100 joins into one room yield 100 UNIQUE callsigns', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const c = await joinTiered(url, 'unique-room', { tier: 'crowd' });
        clients.push(c);
        seen.add(c.hello!.callsign);
      }
      expect(seen.size).toBe(100);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C2 tiered room manager — negotiateTier (pure)', () => {
  it('defaults an absent tier to resident (Phase B invariant)', () => {
    expect(negotiateTier(undefined, undefined, STAFF_KEY).tier).toBe('resident');
  });
  it('grants an authed privileged tier when the secret matches', () => {
    expect(negotiateTier('resident', STAFF_KEY, STAFF_KEY).tier).toBe('resident');
    expect(negotiateTier('spectator', STAFF_KEY, STAFF_KEY).tier).toBe('spectator');
  });
  it('DOWNGRADES an unauthed privileged tier to crowd (never rejects)', () => {
    const r = negotiateTier('resident', 'wrong', STAFF_KEY);
    expect(r.tier).toBe('crowd');
    expect(r.downgradeFrom).toBe('resident');
    expect(r.reason).toBe('auth');
  });
  it('public tiers (wisp/crowd) never require a secret', () => {
    expect(negotiateTier('wisp', undefined, STAFF_KEY).tier).toBe('wisp');
    expect(negotiateTier('crowd', undefined, STAFF_KEY).tier).toBe('crowd');
  });
  it('an unknown tier string is treated as crowd', () => {
    expect(negotiateTier('hacker' as Tier, undefined, STAFF_KEY).tier).toBe('crowd');
  });
});

describe('C2 tiered room manager — wisp coalesced buffer is serialized ONCE', () => {
  it('(d) broadcastCoalescedToWisps sends the SAME payload object to every wisp (spy)', async () => {
    // Import the hub factory + drive it directly with fake sockets so we can spy
    // on `send` and assert every wisp received the identical serialized buffer.
    const { makeConnectionHub } = await import('../src/connection.js');
    const hub = makeConnectionHub();
    // Cast to reach the internal maps (the module casts the same way).
    const h = hub as unknown as {
      socketMeta: WeakMap<object, { roomId: string; playerId: string; tier: Tier; callsign: string; roomEpoch: number; idleTimer: unknown }>;
      roomSockets: Map<string, Set<object>>;
    };

    function fakeSocket(tier: Tier, id: string) {
      const ws = { readyState: 1, send: vi.fn() };
      h.socketMeta.set(ws, { roomId: 'r', playerId: id, tier, callsign: id, roomEpoch: 0, idleTimer: null });
      let set = h.roomSockets.get('r');
      if (!set) {
        set = new Set();
        h.roomSockets.set('r', set);
      }
      set.add(ws);
      return ws;
    }

    const w1 = fakeSocket('wisp', 'p0');
    const w2 = fakeSocket('wisp', 'p1');
    const resident = fakeSocket('resident', 'p2'); // must NOT receive the wisp buffer

    hub.broadcastCoalescedToWisps('r', { t: 'wisp-coalesced', tick: 7, shapes: [{ id: 's', p: { x: 1, y: 2, z: 3 } }] });

    expect(w1.send).toHaveBeenCalledTimes(1);
    expect(w2.send).toHaveBeenCalledTimes(1);
    expect(resident.send).not.toHaveBeenCalled();
    // Serialized ONCE → every wisp received the byte-identical payload. (The
    // implementation calls encodeText a single time and passes the SAME `payload`
    // reference to each ws.send; strings are primitives so this asserts value
    // equality, and the exactly-once send counts above pin the shared-buffer
    // fan-out shape.)
    const p1 = w1.send.mock.calls[0][0];
    const p2 = w2.send.mock.calls[0][0];
    expect(p1).toBe(p2);
    expect(typeof p1).toBe('string');
  });
});

describe('C2 tiered room manager — idle-kick (fake timers)', () => {
  it('(h) an idle wisp is disconnected after the idle window; a resident is NOT idle-kicked', async () => {
    const timerApi = new FakeTimerApi();
    const { url } = makeServer({ timerApi });
    const clients: TieredClient[] = [];
    try {
      const resident = await joinTiered(url, 'idle-room', { tier: 'resident', joinSecret: STAFF_KEY });
      const wisp = await joinTiered(url, 'idle-room', { tier: 'wisp' });
      clients.push(resident, wisp);
      await wait(50);

      const wispClosed = new Promise<void>((resolve) => wisp.ws.once('close', () => resolve()));

      // Advance past the 90–120 s idle window with no wisp intent/pose/heartbeat.
      timerApi.advance(130_000);

      // The wisp is disconnected.
      await Promise.race([
        wispClosed,
        wait(2000).then(() => {
          throw new Error('idle wisp was not disconnected after the idle window');
        }),
      ]);
      // The resident (idleKick=false) stays connected.
      expect(resident.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// C12 — Neon Guestbook: GLYPH_ADD over the real crowd tier (end-to-end)
// ===========================================================================

describe('C12 Neon Guestbook — GLYPH_ADD over the crowd tier', () => {
  /** A minimal valid stroke (≥ 2 in-bounds finite points). */
  const stroke = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];

  it('an ephemeral crowd scribe submits a glyph → ack {callsign, ring} + a GLYPH broadcast', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      const scribe = await joinTiered(url, 'gb-room', { tier: 'crowd' });
      clients.push(scribe);
      const cs = scribe.hello!.callsign;

      scribe.ws.send(encodeText({ t: 'glyph-add', points: stroke, color: '#00ffff' } as never));

      // The scribe receives a glyph-ack echoing its callsign + the ring it landed at.
      const ack = await waitUntil(
        () => scribe.received.find((m) => m.t === 'glyph-ack') as (ServerMsg & { t: 'glyph-ack' }) | undefined,
        { label: 'glyph-ack' }
      );
      expect(ack.callsign).toBe(cs);
      expect(typeof ack.ring).toBe('number');

      // The room broadcasts the birthed glyph (a `glyph` family message).
      const birth = scribe.received.find(
        (m) => m.t === 'glyph'
      ) as (ServerMsg & { t: 'glyph' }) | undefined;
      expect(birth).toBeDefined();
      expect(birth!.glyph.callsign).toBe(cs);
    } finally {
      closeAll(clients);
    }
  });

  it('a crowd scribe glyph NEVER occupies a resident slot (8 residents still fit after)', async () => {
    const { url } = makeServer();
    const clients: TieredClient[] = [];
    try {
      // An ephemeral crowd scribe submits a glyph.
      const scribe = await joinTiered(url, 'cap-room', { tier: 'crowd' });
      clients.push(scribe);
      scribe.ws.send(encodeText({ t: 'glyph-add', points: stroke, color: '#ff00ff' } as never));
      await waitUntil(() => scribe.received.find((m) => m.t === 'glyph-ack'), { label: 'glyph-ack' });

      // All 8 resident slots remain available — the crowd guest consumed none.
      for (let i = 0; i < 8; i++) {
        const r = await joinTiered(url, 'cap-room', { tier: 'resident', joinSecret: STAFF_KEY });
        clients.push(r);
        expect(r.hello!.tier).toBe('resident');
      }
      // The 9th resident is room-full (the Phase B invariant) — crowd never ate a slot.
      const ninth = await openSocket(url);
      clients.push({ ws: ninth, received: [], binary: [] });
      const err = new Promise<ServerMsg>((resolve) => {
        ninth.on('message', (data, isBinary) => {
          if (isBinary) return;
          const m = decodeText(data.toString()) as ServerMsg;
          if (m.t === 'error') resolve(m);
        });
      });
      ninth.send(
        encodeText({ t: 'join', room: 'cap-room', name: 'r9', color: 0, protocol: PROTOCOL_VERSION, tier: 'resident', joinSecret: STAFF_KEY } as never)
      );
      const e = await Promise.race([
        err,
        wait(2000).then(() => ({ t: 'error', code: 'timeout' }) as ServerMsg),
      ]);
      expect((e as ServerMsg & { code: string }).code).toBe('room-full');
    } finally {
      closeAll(clients);
    }
  });
});
