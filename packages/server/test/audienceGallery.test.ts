/**
 * audienceGallery.test.ts — Task C25 (F14 The Gallery, spec §5.1 / §7.14).
 *
 * The remote `audience` tier: the additive 6th tier + a live watch-stream fan-out.
 * Covers the brief's harness cases:
 *   • the audience join handshake (public, no secret) + hello tier 'audience';
 *   • the §5.1 receive-set UNION reaches audience (audience-keyframe on join,
 *     audience-state counter, phase-state) and it NEVER receives a full-rate
 *     `state` delta, a full-rate `pose`, the `welcome` snapshot, or a voice frame
 *     (the egress/security invariant);
 *   • the per-IP cap (≤ 4) + over-cap "at capacity" card (never a crowd downgrade);
 *     one IP opening many sockets is capped, a different IP is unaffected;
 *   • the CACHED late-join keyframe is serialize-ONCE + reused (same-buffer spy
 *     across viewers / a reconnect stampede → zero fresh serializations);
 *   • backpressure verdicts (a stalled socket is skipped/dropped, never blocking);
 *   • audience never counts as world occupancy (no player-join, no resident slot).
 *
 * Uses the REAL server (startServer) + REAL ws clients + the real POST /api/rooms
 * ownerToken flow — no mocks. Distinct client IPs are simulated via the TRUSTED
 * `CF-Connecting-IP` header — the one header the spoof-resistant `clientIpOf`
 * keys on (C25 review M3). A spoofable leftmost `X-Forwarded-For` is injected
 * separately (via the `xff` opt) to prove it is IGNORED for per-IP keying.
 *
 * C25 review fixes covered here:
 *   M1 — send-side boundary: an audience send of EVERY intent family is a no-op.
 *   M2 — despawn ghosts: a removed shape DISAPPEARS for a viewer + churn convergence.
 *   M3 — spoof-resistance: same trusted IP + different spoofed XFF ⇒ one IP.
 *   M4 — the per-IP keyframe-throttle token bucket, drained by a join→leave churn.
 *   Minors — backpressure on the per-message path, over-cap close + room-cap(128),
 *   panic→audience, occupancy/ATTRACT + idle-kick, visibilitychange drop→rejoin.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import {
  encodeText,
  decodeText,
  packVoice,
  VOICE_OPUS,
  PROTOCOL_VERSION,
  AUDIENCE_MAX_PER_IP,
  BUILD_KIND,
} from '@cyber-shapes/shared';
import type { ServerMsg, TimerApi, TimerHandle, Vec3 } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';
import {
  AudienceKeyframeCache,
  audienceBackpressureAction,
  AUDIENCE_BUFFERED_SKIP_BYTES,
  AUDIENCE_BUFFERED_HARD_CEILING,
  AUDIENCE_CAP,
  IDLE_KICK_MS,
  makeConnectionHub,
} from '../src/connection.js';

// ---------------------------------------------------------------------------
// A controllable fake TimerApi (idle-kick / visibilitychange cases). Timers fire
// when the clock is advanced past their deadline via `advance(ms)` — the same
// pattern the C2 tiered-room idle-kick tests use.
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
  advance(ms: number): void {
    this._now += ms;
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

// ===========================================================================
// Unit — the cached keyframe (same-buffer / zero-serialization) + backpressure
// ===========================================================================

describe('C25 AudienceKeyframeCache — serialize-once, reuse-per-joiner', () => {
  it('a 128-join stampede after ONE refresh triggers ZERO fresh serializations (same buffer)', () => {
    let encodeCalls = 0;
    const cache = new AudienceKeyframeCache((m) => {
      encodeCalls += 1;
      return JSON.stringify(m);
    });
    // The sim loop refreshes ONCE.
    cache.refresh([{ id: 's0' } as never], 42);
    expect(cache.serializeCount).toBe(1);
    expect(encodeCalls).toBe(1);

    // 128 late-joiners all reuse the cached buffer — no new serialization each.
    const buffers: string[] = [];
    for (let i = 0; i < 128; i++) buffers.push(cache.getForJoin([{ id: 's0' } as never], 99));
    expect(cache.serializeCount).toBe(1); // STILL one — zero fresh serializations
    expect(encodeCalls).toBe(1);
    // Every joiner got the IDENTICAL buffer object (the same-buffer spy).
    for (const b of buffers) expect(b).toBe(buffers[0]);
  });

  it('cold cache builds exactly once on the first join, then reuses', () => {
    let encodeCalls = 0;
    const cache = new AudienceKeyframeCache((m) => {
      encodeCalls += 1;
      return JSON.stringify(m);
    });
    expect(cache.cached).toBeNull();
    const a = cache.getForJoin([], 1); // cold → one build
    const b = cache.getForJoin([], 1); // reuse
    expect(encodeCalls).toBe(1);
    expect(cache.serializeCount).toBe(1);
    expect(a).toBe(b);
  });
});

describe('C25 audience backpressure verdicts (spec §7.14 mandatory)', () => {
  it('sends under threshold, SKIPS a filling buffer, DISCONNECTS past the hard ceiling', () => {
    expect(audienceBackpressureAction(0)).toBe('send');
    expect(audienceBackpressureAction(AUDIENCE_BUFFERED_SKIP_BYTES - 1)).toBe('send');
    expect(audienceBackpressureAction(AUDIENCE_BUFFERED_SKIP_BYTES + 1)).toBe('skip');
    expect(audienceBackpressureAction(AUDIENCE_BUFFERED_HARD_CEILING + 1)).toBe('disconnect');
    // One stalled socket (huge buffer) is dropped/closed; a healthy one (0) still sends —
    // proof the stalled viewer never blocks the tick nor the others.
    expect(audienceBackpressureAction(5_000_000)).not.toBe('send');
  });
});

// ===========================================================================
// Integration harness (real server + ws clients + POST /api/rooms)
// ===========================================================================

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const s = _servers.splice(0);
  await Promise.allSettled(s.map((x) => x.close()));
});

function makeServer(opts?: { timerApi?: TimerApi }): {
  server: ServerHandle;
  wsUrl: string;
  httpBase: string;
} {
  const server = startServer(0, { ...(opts?.timerApi ? { timerApi: opts.timerApi } : {}) });
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

/**
 * Open a ws socket. `ip` is injected as the TRUSTED `CF-Connecting-IP` header —
 * the one header the spoof-resistant `clientIpOf` (M3) keys per-IP limiters on, so
 * distinct `ip` values still exercise distinct client IPs. `xff` injects a
 * SPOOFABLE leftmost `X-Forwarded-For` a hostile client would forge; the per-IP
 * limiters MUST ignore it (the M3 spoof-resistance test drives this).
 */
function openSocket(url: string, ip?: string, xff?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (ip) headers['CF-Connecting-IP'] = ip;
    if (xff) headers['X-Forwarded-For'] = xff;
    const ws = new WebSocket(url, Object.keys(headers).length > 0 ? { headers } : undefined);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  ws: WebSocket;
  received: ServerMsg[];
  rawText: string[];
  binary: Buffer[];
  hello?: ServerMsg & { t: 'hello' };
  error?: ServerMsg & { t: 'error' };
  closed: boolean;
}

interface JoinOpts {
  tier?: string;
  joinSecret?: string;
  ownerToken?: string;
  ip?: string;
  /** A spoofable leftmost X-Forwarded-For to prove it is ignored for keying (M3). */
  xff?: string;
}

/** Open a socket + send a join; record raw text, decoded msgs, and binary frames. */
async function openClient(url: string, room: string, opts: JoinOpts = {}): Promise<Client> {
  const ws = await openSocket(url, opts.ip, opts.xff);
  const client: Client = { ws, received: [], rawText: [], binary: [], closed: false };
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      client.binary.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const raw = data.toString();
    client.rawText.push(raw);
    const msg = decodeText(raw) as ServerMsg;
    client.received.push(msg);
    if (msg.t === 'hello') client.hello = msg as ServerMsg & { t: 'hello' };
    if (msg.t === 'error') client.error = msg as ServerMsg & { t: 'error' };
  });
  ws.on('close', () => {
    client.closed = true;
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
  return client;
}

/** Join and wait for hello (an accepted join). */
async function join(url: string, room: string, opts: JoinOpts = {}): Promise<Client> {
  const c = await openClient(url, room, opts);
  await waitUntil(() => c.hello, { label: `hello (${opts.tier ?? 'resident'})` });
  return c;
}

/** Join and wait for EITHER a hello (admitted) or an error (at-capacity). */
async function joinResolveEither(url: string, room: string, opts: JoinOpts = {}): Promise<Client> {
  const c = await openClient(url, room, opts);
  await waitUntil(() => c.hello || c.error, { label: `hello|error (${opts.tier ?? '?'})` });
  return c;
}

function closeAll(cs: Client[]): void {
  for (const c of cs) {
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close();
  }
}

function ofType(client: Client, t: string): ServerMsg[] {
  return client.received.filter((m) => (m as { t: string }).t === t);
}

/** A binary frame whose opcode byte is in the Phase B voice window (0x10–0x1F). */
function isVoiceFrame(buf: Buffer): boolean {
  return buf.length > 0 && buf[0] >= 0x10 && buf[0] <= 0x1f;
}

// ===========================================================================
// Integration tests
// ===========================================================================

describe('C25 The Gallery — audience join + receive-set union', () => {
  it('an audience join is public (no secret) and replies hello with tier "audience"', async () => {
    const { wsUrl } = makeServer();
    const clients: Client[] = [];
    try {
      const a = await join(wsUrl, 'gallery-room', { tier: 'audience' });
      clients.push(a);
      expect(a.hello!.tier).toBe('audience');
      expect(a.error).toBeUndefined();
      expect(a.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      closeAll(clients);
    }
  });

  it('audience receives the §5.1 union (keyframe/audience-state/phase-state) but NEVER state, pose, welcome, or voice', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      // The resident generates the full-rate families audience must NEVER receive:
      // a spawn+fall (state deltas), a pose relay, and a voice frame.
      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 6, z: 0 } } } as never)
      );
      resident.ws.send(
        encodeText({
          t: 'pose',
          pose: { head: { p: { x: 0, y: 1.6, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [] },
        } as never)
      );
      resident.ws.send(encodeText({ t: 'voice-join' } as never));
      resident.ws.send(packVoice(VOICE_OPUS, 0, 1234, 0, new Uint8Array([1, 2, 3, 4])));

      // Let deltas/poses/voice fan out + the 1 Hz phase heartbeat tick.
      await waitUntil(() => ofType(audience, 'phase-state').length > 0, {
        label: 'audience receives phase-state (union)',
        timeoutMs: 4000,
      });
      await wait(400);

      // Positive: the union families reach audience.
      expect(ofType(audience, 'audience-keyframe').length).toBeGreaterThan(0);
      expect(ofType(audience, 'audience-state').length).toBeGreaterThan(0);
      expect(ofType(audience, 'phase-state').length).toBeGreaterThan(0);

      // THE INVARIANT: never a full-rate delta / pose / snapshot / voice.
      expect(ofType(audience, 'state').length).toBe(0);
      expect(ofType(audience, 'pose').length).toBe(0);
      expect(ofType(audience, 'welcome').length).toBe(0);
      expect(audience.received.some((m) => (m as { t: string }).t.startsWith('voice'))).toBe(false);
      expect(audience.binary.some(isVoiceFrame)).toBe(false);

      // Sanity: the resident DID get the full-rate deltas (so the room was live).
      expect(ofType(resident, 'state').length).toBeGreaterThan(0);
    } finally {
      closeAll(clients);
    }
  });

  it('C30 Step 0 — audience RECEIVES the release event with {pos, vel} (the Pocket DVR resim seed), still NEVER state/pose/welcome/voice', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      // Resident spawns a shape, grabs it, then RELEASES it — the release produces
      // the server-authoritative {t:'grab', peerId:null, pos, vel} (accommodation #5).
      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 3, z: 0 } } } as never)
      );
      await waitUntil(() => ofType(resident, 'spawn').length > 0, { label: 'resident spawn ack' });
      const spawned = ofType(resident, 'spawn')[0] as ServerMsg & { t: 'spawn'; shape: { id: string } };
      const shapeId = spawned.shape.id;

      resident.ws.send(encodeText({ t: 'grab', id: shapeId } as never));
      await waitUntil(
        () => resident.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null),
        { label: 'resident grab ack' }
      );
      resident.ws.send(
        encodeText({
          t: 'release',
          id: shapeId,
          velocity: { x: 4, y: 5, z: -2 },
          position: { x: 0, y: 3, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        } as never)
      );

      // THE STEP-0 ASSERTION: the audience receives the RELEASE (peerId null) with
      // the authoritative {pos, vel} the DVR seeds its micro-resim from.
      await waitUntil(
        () =>
          audience.received.some(
            (m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null
          ),
        { label: 'audience receives release', timeoutMs: 4000 }
      );
      const release = audience.received.find(
        (m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null
      ) as ServerMsg & { t: 'grab'; pos?: Vec3; vel?: Vec3 };
      expect(release.pos).toBeDefined();
      expect(release.vel).toBeDefined();
      expect(release.vel).toMatchObject({ x: 4, y: 5, z: -2 });

      // The egress/security boundary is UNCHANGED: never a full-rate delta / pose /
      // snapshot / voice — the additive `grab` family did NOT widen the boundary.
      expect(ofType(audience, 'state').length).toBe(0);
      expect(ofType(audience, 'pose').length).toBe(0);
      expect(ofType(audience, 'welcome').length).toBe(0);
      expect(audience.received.some((m) => (m as { t: string }).t.startsWith('voice'))).toBe(false);
      expect(audience.binary.some(isVoiceFrame)).toBe(false);
    } finally {
      closeAll(clients);
    }
  });

  it('C30 MF1 — audience receives ONLY the release (peerId null); grab-START (peerId set) is EXCLUDED; a wisp receives BOTH', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const wisp = await join(wsUrl, roomId, { tier: 'wisp' });
      clients.push(wisp);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 3, z: 0 } } } as never)
      );
      await waitUntil(() => ofType(resident, 'spawn').length > 0, { label: 'spawn ack' });
      const shapeId = (ofType(resident, 'spawn')[0] as ServerMsg & { t: 'spawn'; shape: { id: string } }).shape.id;

      // grab-START — {t:'grab', peerId:<residentPlayerId>} (NO pos/vel). It discloses
      // the holder's stable internal playerId + who-holds-what.
      resident.ws.send(encodeText({ t: 'grab', id: shapeId } as never));
      await waitUntil(
        () => wisp.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null),
        { label: 'wisp grab-START' }
      );

      // release — {t:'grab', peerId:null, pos, vel} (the F19 resim seed).
      resident.ws.send(
        encodeText({ t: 'release', id: shapeId, velocity: { x: 4, y: 5, z: -2 }, position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } as never)
      );
      // Per-socket FIFO: once the audience has the RELEASE, any grab-START it would
      // have gotten must ALREADY have arrived — so a count of 0 is conclusive.
      await waitUntil(
        () => audience.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null),
        { label: 'audience release', timeoutMs: 4000 }
      );

      // MF1 CORE — audience got the release but NEVER a grab-START (peerId set).
      const audienceGrabStart = audience.received.filter(
        (m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null
      );
      expect(audienceGrabStart.length).toBe(0);
      const audienceRelease = audience.received.filter(
        (m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null
      );
      expect(audienceRelease.length).toBeGreaterThan(0);

      // A wisp legitimately sees BOTH grab-START and the release (full grab family).
      expect(wisp.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null)).toBe(true);
      expect(wisp.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null)).toBe(true);

      // The C25 boundary is intact — still never state/pose/welcome/voice.
      expect(ofType(audience, 'state').length).toBe(0);
      expect(ofType(audience, 'pose').length).toBe(0);
      expect(ofType(audience, 'welcome').length).toBe(0);
      expect(audience.received.some((m) => (m as { t: string }).t.startsWith('voice'))).toBe(false);
    } finally {
      closeAll(clients);
    }
  });

  it('C30 MF1 — the disconnect auto-release {peerId:null} (no pos/vel) reaches audience harmlessly (no grab-START leak, DVR-ignorable)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      const wisp = await join(wsUrl, roomId, { tier: 'wisp' }); // keep the room alive after resident leaves
      clients.push(wisp);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 3, z: 0 } } } as never)
      );
      await waitUntil(() => ofType(resident, 'spawn').length > 0, { label: 'spawn ack' });
      const shapeId = (ofType(resident, 'spawn')[0] as ServerMsg & { t: 'spawn'; shape: { id: string } }).shape.id;
      resident.ws.send(encodeText({ t: 'grab', id: shapeId } as never));
      await waitUntil(
        () => wisp.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null),
        { label: 'wisp grab-START' }
      );

      // Resident DISCONNECTS while still holding → forceRelease emits the auto-release
      // {t:'grab', id, peerId:null} with NO pos/vel (a removal, not a throw).
      resident.ws.close();
      await waitUntil(
        () => audience.received.some((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null),
        { label: 'audience auto-release', timeoutMs: 4000 }
      );
      const rel = audience.received.find(
        (m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId === null
      ) as ServerMsg & { t: 'grab'; pos?: Vec3; vel?: Vec3 };
      // Harmless: no {pos, vel} → the client DVR guard (needs pos&&vel) ignores it.
      expect(rel.pos).toBeUndefined();
      expect(rel.vel).toBeUndefined();
      // And STILL no grab-START (peerId set) leaked to audience.
      expect(
        audience.received.filter((m) => m.t === 'grab' && (m as { peerId?: string | null }).peerId != null).length
      ).toBe(0);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C25 The Gallery — per-IP cap + over-cap "at capacity" (never crowd)', () => {
  it('one IP is capped at 4 audience sockets (5th+ = at-capacity card); a different IP is unaffected', async () => {
    const { wsUrl } = makeServer();
    const clients: Client[] = [];
    try {
      // 6 audience sockets from ONE IP → 4 admitted, 2 get the at-capacity card.
      const sameIp = '5.5.5.5';
      const admitted: Client[] = [];
      const rejected: Client[] = [];
      for (let i = 0; i < 6; i++) {
        const c = await joinResolveEither(wsUrl, 'cap-room', { tier: 'audience', ip: sameIp });
        clients.push(c);
        if (c.hello) admitted.push(c);
        else rejected.push(c);
      }
      expect(admitted.length).toBe(AUDIENCE_MAX_PER_IP); // 4
      expect(rejected.length).toBe(6 - AUDIENCE_MAX_PER_IP); // 2
      // Over-cap is the SOFT static card — NEVER a crowd downgrade — AND the
      // socket is actually CLOSED (the "no socket" half of the at-capacity card).
      for (const r of rejected) {
        expect(r.error!.code).toBe('at-capacity');
        expect(r.hello).toBeUndefined(); // never granted any tier
        await waitUntil(() => r.closed, { label: 'over-cap socket closed' });
      }
      // A viewer from a DIFFERENT IP is unaffected.
      const other = await joinResolveEither(wsUrl, 'cap-room', { tier: 'audience', ip: '6.6.6.6' });
      clients.push(other);
      expect(other.hello!.tier).toBe('audience');
    } finally {
      closeAll(clients);
    }
  });

  it('the per-ROOM cap (128) is enforced: the 129th viewer (distinct IPs) gets the at-capacity card + close', async () => {
    const { wsUrl } = makeServer();
    const clients: Client[] = [];
    try {
      // Fill the room to AUDIENCE_CAP from DISTINCT IPs (so the per-IP cap of 4 is
      // never the limiter — this exercises the ROOM-cap branch specifically).
      let admitted = 0;
      for (let i = 0; i < AUDIENCE_CAP; i++) {
        const c = await joinResolveEither(wsUrl, 'room-cap', {
          tier: 'audience',
          ip: `172.16.${Math.floor(i / 250)}.${i % 250}`,
        });
        clients.push(c);
        if (c.hello) admitted++;
      }
      expect(admitted).toBe(AUDIENCE_CAP); // exactly 128 admitted

      // The 129th (a fresh IP, so NOT a per-IP rejection) trips the ROOM cap.
      const overflow = await joinResolveEither(wsUrl, 'room-cap', { tier: 'audience', ip: '203.0.113.7' });
      clients.push(overflow);
      expect(overflow.error!.code).toBe('at-capacity');
      expect(overflow.hello).toBeUndefined();
      await waitUntil(() => overflow.closed, { label: 'room-cap socket closed' });
    } finally {
      closeAll(clients);
    }
  });
});

describe('C25 The Gallery — cached keyframe: zero fresh serialization on a join burst', () => {
  it('a 32-viewer burst (distinct IPs) all receive the byte-identical cached keyframe', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A resident spawns a shape so the keyframe carries real world content.
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'sphere', position: { x: 1, y: 3, z: -1 } } } as never)
      );
      await wait(150);

      // 32 remote viewers, each a distinct IP (so the per-IP cap never trips).
      const viewers: Client[] = [];
      for (let i = 0; i < 32; i++) {
        const c = await join(wsUrl, roomId, { tier: 'audience', ip: `10.0.${i}.1` });
        clients.push(c);
        viewers.push(c);
      }
      // Every viewer received exactly the SAME keyframe bytes (the cached buffer
      // reused verbatim — zero fresh serialization per joiner).
      const keyframes = viewers.map((v) => v.rawText.find((r) => r.includes('"audience-keyframe"')));
      expect(keyframes.every((k) => typeof k === 'string')).toBe(true);
      const first = keyframes[0];
      for (const k of keyframes) expect(k).toBe(first);
    } finally {
      closeAll(clients);
    }
  });
});

describe('C25 The Gallery — occupancy exclusion (spec §7.14)', () => {
  it('an audience viewer never counts as world occupancy (no player-join, no resident slot)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      // The resident's welcome lists exactly 1 world player (itself).
      const welcome = ofType(resident, 'welcome')[0] as (ServerMsg & { t: 'welcome' }) | undefined;
      expect(welcome).toBeDefined();
      expect(welcome!.players.length).toBe(1);

      const before = ofType(resident, 'player-join').length;
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);
      await wait(300);
      // The audience join produced NO world player-join (it is not an avatar / not
      // occupancy). The resident's roster is unchanged.
      expect(ofType(resident, 'player-join').length).toBe(before);
      // And the audience itself never received the full `welcome` snapshot.
      expect(ofType(audience, 'welcome').length).toBe(0);
    } finally {
      closeAll(clients);
    }
  });

  it('an audience join does NOT fire onPeerJoined / attract-exit (a resident join does)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A director OBSERVES phase-state without itself being world occupancy — so it
      // can witness whether the timeline advances, without perturbing it.
      const director = await join(wsUrl, roomId, { tier: 'director', ownerToken });
      clients.push(director);
      const first = (await waitUntil(() => ofType(director, 'phase-state')[0], {
        label: 'initial phase-state',
      })) as ServerMsg & { t: 'phase-state'; phase: string };
      expect(first.phase).toBe('ATTRACT'); // idle-hours attract loop, no residents yet

      // An AUDIENCE join must NOT advance the timeline (it is never occupancy, §7.14).
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);
      await wait(400);
      expect(
        ofType(director, 'phase-state').every((m) => (m as { phase: string }).phase === 'ATTRACT')
      ).toBe(true);

      // A RESIDENT join DOES advance ATTRACT → LOBBY — proof the mechanism is live
      // and resident-only (so the earlier audience join genuinely did nothing).
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);
      await waitUntil(
        () => ofType(director, 'phase-state').some((m) => (m as { phase: string }).phase !== 'ATTRACT'),
        { label: 'resident advanced the phase out of ATTRACT' }
      );
    } finally {
      closeAll(clients);
    }
  });

  it('an idle audience socket is disconnected after the idle window (fake timers)', async () => {
    const timerApi = new FakeTimerApi();
    const { wsUrl } = makeServer({ timerApi });
    const clients: Client[] = [];
    try {
      const audience = await join(wsUrl, 'idle-aud-room', { tier: 'audience', ip: '4.4.4.4' });
      clients.push(audience);
      expect(audience.ws.readyState).toBe(WebSocket.OPEN);
      // No inbound frame for the idle window → the audience (idleKick:true) is dropped.
      timerApi.advance(IDLE_KICK_MS + 5_000);
      await waitUntil(() => audience.closed, { label: 'audience idle-kicked' });
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// M1 — SEND-SIDE BOUNDARY: an audience send of EVERY intent family is a NO-OP.
// ===========================================================================

describe('C25 review M1 — audience send-side boundary (spec §5.1: heartbeat + CLOCK_PING only)', () => {
  it('an audience send of every intent family (glyph-add/build/vote/charge/cue/director-cmd/request-snapshot/spawn/pose) is a NO-OP', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A resident WITNESS: any audience send that took effect would surface here
      // (a glyph birth carrying the audience callsign, a pose relay, a new spawn…).
      const witness = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(witness);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);
      await wait(250); // let the room quiesce (baseline shapes settle)

      const spawnsBefore = ofType(witness, 'spawn').length;
      const aud = audience.ws;
      // EVERY client→server intent family a hostile ?watch viewer could try. All are
      // valid per validateClientMsg (so ONLY the send-side tier gate stops them).
      aud.send(
        encodeText({
          t: 'glyph-add',
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.5 },
            { x: 1, y: 1 },
          ],
          color: '#00ffff',
        } as never)
      );
      aud.send(encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'aud-1' } as never));
      aud.send(encodeText({ t: 'vote-cast', option: 'low-gravity' } as never));
      aud.send(encodeText({ t: 'charge-tap' } as never));
      aud.send(
        encodeText({ t: 'director-cmd', cmd: 'FIRE', cueId: 'shape-rain', cueInstanceId: 'aud-c1' } as never)
      );
      aud.send(encodeText({ t: 'director-cmd', cmd: 'PANIC' } as never));
      aud.send(encodeText({ t: 'request-snapshot' } as never));
      aud.send(
        encodeText({ t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 6, z: 0 } } } as never)
      );
      aud.send(
        encodeText({
          t: 'pose',
          pose: { head: { p: { x: 0, y: 1.6, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [] },
        } as never)
      );

      await wait(500); // ample time for any (erroneous) side-effect to surface

      // The audience got NO processing reply — the gate is a SILENT drop (no error).
      expect(ofType(audience, 'glyph-ack')).toHaveLength(0); // glyph-add gated
      expect(ofType(audience, 'build-msg')).toHaveLength(0); // build op gated
      expect(ofType(audience, 'director-ack')).toHaveLength(0); // director-cmd gated
      expect(audience.error).toBeUndefined(); // a dropped send never errors
      expect(audience.ws.readyState).toBe(WebSocket.OPEN); // never closed the socket

      // The WITNESS saw NO world/state side-effect attributable to the audience:
      const audCs = (audience.hello as { callsign: string }).callsign;
      const audId = (audience.hello as { peerId: string }).peerId;
      expect(
        witness.received.some(
          (m) => m.t === 'glyph' && (m as { glyph: { callsign: string } }).glyph.callsign === audCs
        )
      ).toBe(false); // no glyph birth (no bucket write / broadcast)
      expect(witness.received.some((m) => m.t === 'pose' && (m as { id: string }).id === audId)).toBe(
        false
      ); // no pose relay
      expect(ofType(witness, 'spawn').length).toBe(spawnsBefore); // no world spawn
    } finally {
      closeAll(clients);
    }
  });

  it('a wisp/spectator glyph-add is ALSO rejected (glyph submissions are a crowd/resident send)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    const stroke = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ];
    try {
      const wisp = await join(wsUrl, roomId, { tier: 'wisp' });
      clients.push(wisp);
      const spectator = await join(wsUrl, roomId, { tier: 'spectator', joinSecret: secret });
      clients.push(spectator);
      wisp.ws.send(encodeText({ t: 'glyph-add', points: stroke, color: '#00ffff' } as never));
      spectator.ws.send(encodeText({ t: 'glyph-add', points: stroke, color: '#ff00ff' } as never));
      await wait(400);
      // Neither non-crowd/resident tier gets a glyph-ack (the guestbook write is refused).
      expect(ofType(wisp, 'glyph-ack')).toHaveLength(0);
      expect(ofType(spectator, 'glyph-ack')).toHaveLength(0);
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// M2 — DESPAWN GHOSTS: a removed shape DISAPPEARS + churn convergence.
// ===========================================================================

describe('C25 review M2 — despawn reaches audience (no permanent ghosts)', () => {
  it('a removed shape DISAPPEARS for an audience viewer (despawn is in the receive set now)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // Director-capable resident (ownerToken → meta.director) so it can force a RESET.
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret, ownerToken });
      clients.push(resident);
      resident.ws.send(
        encodeText({ t: 'spawn', shape: { type: 'sphere', position: { x: 2, y: 2, z: 2 } } } as never)
      );
      const echo = (await waitUntil(
        () => ofType(resident, 'spawn').find((m) => (m as { shape?: { type: string } }).shape?.type === 'sphere'),
        { label: 'resident spawn echo' }
      )) as ServerMsg & { t: 'spawn'; shape: { id: string } };
      const targetId = echo.shape.id;

      // The audience joins → its COLD-cache keyframe is built fresh from the current
      // world, so it includes the just-spawned shape.
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);
      const kf = (await waitUntil(() => ofType(audience, 'audience-keyframe')[0], {
        label: 'audience keyframe',
      })) as ServerMsg & { t: 'audience-keyframe'; shapes: Array<{ id: string }> };
      expect(kf.shapes.some((s) => s.id === targetId)).toBe(true);

      // Force a RESET → the shape is removed → a despawn fans out to the room. Before
      // M2 this despawn was DROPPED for the audience tier → a permanent ghost.
      resident.ws.send(encodeText({ t: 'director-cmd', cmd: 'RESET' } as never));
      await waitUntil(
        () => ofType(audience, 'despawn').some((m) => (m as { id: string }).id === targetId),
        { label: 'audience despawn for the removed shape' }
      );

      // Reconstruct the audience live set (keyframe − despawns): the ghost is gone.
      const despawned = new Set(ofType(audience, 'despawn').map((m) => (m as { id: string }).id));
      const live = kf.shapes.map((s) => s.id).filter((id) => !despawned.has(id));
      expect(live).not.toContain(targetId);
    } finally {
      closeAll(clients);
    }
  });

  it('an audience viewer CONVERGES to ground truth across a spawn+settle+remove churn', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret, ownerToken });
      clients.push(resident);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      // CHURN: spawn 3 shapes that FALL (→ they ride the 5 Hz roll-forward buffer),
      // let them settle, then RESET (removes them all).
      for (const p of [
        { x: -2, y: 5, z: 0 },
        { x: 0, y: 5, z: 1 },
        { x: 2, y: 5, z: -1 },
      ]) {
        resident.ws.send(encodeText({ t: 'spawn', shape: { type: 'cube', position: p } } as never));
      }
      await waitUntil(
        () => ofType(resident, 'spawn').filter((m) => (m as { shape?: { type: string } }).shape?.type === 'cube').length >= 3,
        { label: '3 cube spawn echoes' }
      );
      const ids = ofType(resident, 'spawn')
        .map((m) => (m as { shape?: { type: string; id: string } }).shape)
        .filter((s): s is { type: string; id: string } => s?.type === 'cube')
        .map((s) => s.id);
      expect(ids).toHaveLength(3);

      // While falling, the shapes appear in the audience's coalesced roll-forward.
      await wait(600);
      const coalescedSeen = new Set<string>();
      for (const m of ofType(audience, 'wisp-coalesced'))
        for (const s of (m as { shapes?: Array<{ id: string }> }).shapes ?? [])
          coalescedSeen.add(s.id);
      expect(ids.some((id) => coalescedSeen.has(id))).toBe(true); // tracked via roll-forward

      // Remove the whole world.
      resident.ws.send(encodeText({ t: 'director-cmd', cmd: 'RESET' } as never));
      await waitUntil(
        () => ids.every((id) => ofType(audience, 'despawn').some((m) => (m as { id: string }).id === id)),
        { label: 'all churned shapes despawned' }
      );

      // CONVERGENCE: reconstruct (keyframe ∪ coalesced-seen) − despawns. Every
      // churned shape is gone from the audience world — it converged, no ghosts.
      const despawned = new Set(ofType(audience, 'despawn').map((m) => (m as { id: string }).id));
      const kfIds =
        ((ofType(audience, 'audience-keyframe')[0] as { shapes?: Array<{ id: string }> } | undefined)
          ?.shapes ?? []).map((s) => s.id);
      const liveSet = new Set(
        [...kfIds, ...coalescedSeen].filter((id) => !despawned.has(id))
      );
      for (const id of ids) expect(liveSet.has(id)).toBe(false);
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// M3 — per-IP keying is SPOOF-RESISTANT (trusted CF-Connecting-IP, not XFF).
// ===========================================================================

describe('C25 review M3 — per-IP keying is spoof-resistant', () => {
  it('same TRUSTED CF-Connecting-IP + DIFFERENT spoofed X-Forwarded-For ⇒ counted as ONE IP', async () => {
    const { wsUrl } = makeServer();
    const clients: Client[] = [];
    try {
      const trustedIp = '7.7.7.7';
      // AUDIENCE_MAX_PER_IP sockets — all the SAME trusted IP but EACH forging a
      // different leftmost XFF. Under the OLD leftmost-XFF keying each spoof would
      // have looked like a new IP and been granted its own slot.
      for (let i = 0; i < AUDIENCE_MAX_PER_IP; i++) {
        const c = await joinResolveEither(wsUrl, 'spoof-room', {
          tier: 'audience',
          ip: trustedIp,
          xff: `9.9.9.${i}`,
        });
        clients.push(c);
        expect(c.hello!.tier).toBe('audience'); // the first 4 land
      }
      // The 5th — SAME trusted IP, ANOTHER forged XFF — is at-capacity: the spoof
      // bought no new slot. Proof the leftmost XFF is ignored for per-IP keying.
      const spoof = await joinResolveEither(wsUrl, 'spoof-room', {
        tier: 'audience',
        ip: trustedIp,
        xff: '9.9.9.250',
      });
      clients.push(spoof);
      expect(spoof.error!.code).toBe('at-capacity');
      expect(spoof.hello).toBeUndefined();
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// M4 — the per-IP keyframe-throttle token bucket, drained by a join→leave churn.
// ===========================================================================

describe('C25 review M4 — per-IP keyframe-throttle token bucket', () => {
  it('a join→leave→join churn from ONE IP drains the bucket → later joins CONNECT but the keyframe is SKIPPED', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      // A resident keeps the room ALIVE so the per-(room,IP) join bucket PERSISTS
      // across the audience churn (it is torn down only on last-socket teardown).
      const resident = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
      clients.push(resident);

      const ip = '3.3.3.3';
      let firstHadKeyframe = false;
      let throttledJoin = false;
      // Each cycle re-joins from the SAME IP; LEAVING frees the concurrency slot so
      // the join BUCKET keeps draining (the cap never guards the throttle). Burst is
      // 6 → the ~7th take fails on a fast localhost churn.
      for (let i = 0; i < 24 && !throttledJoin; i++) {
        const c = await join(wsUrl, roomId, { tier: 'audience', ip });
        await wait(90); // ordered after hello; the keyframe (if any) has landed
        const hasKf = ofType(c, 'audience-keyframe').length > 0;
        if (i === 0) firstHadKeyframe = hasKf;
        // Throttled ⇔ CONNECTED (hello) but NO keyframe. The only reason a fresh
        // socket's cold keyframe is skipped is the drained per-IP token bucket.
        if (i >= 1 && c.hello && !hasKf) throttledJoin = true;
        c.ws.close();
        await waitUntil(() => c.closed, { label: 'audience left (frees the slot)' });
      }
      // The FIRST join got a keyframe (the mechanism sends one when tokens exist)…
      expect(firstHadKeyframe).toBe(true);
      // …and a LATER join CONNECTED (hello) but had its cached keyframe THROTTLED.
      expect(throttledJoin).toBe(true);
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// Minor — backpressure is applied on the PER-MESSAGE path (sendAudienceRaw).
// ===========================================================================

describe('C25 review Minor — per-message backpressure (sendAudienceRaw)', () => {
  it('skips a filling buffer, DISCONNECTS a wedged socket, and never wedges the healthy ones', () => {
    const hub = makeConnectionHub() as unknown as {
      sendAudienceRaw(ws: unknown, payload: string | Buffer): void;
    };
    function fakeWs(bufferedAmount: number) {
      const sent: unknown[] = [];
      const state = { closed: false };
      return {
        obj: {
          readyState: 1,
          bufferedAmount,
          send: (p: unknown) => sent.push(p),
          close: () => {
            state.closed = true;
          },
        },
        sent,
        state,
      };
    }
    // Under threshold → sent.
    const healthy = fakeWs(0);
    hub.sendAudienceRaw(healthy.obj, 'frame');
    expect(healthy.sent).toEqual(['frame']);
    expect(healthy.state.closed).toBe(false);

    // Filling buffer → SKIPPED (dropped, never blocks the tick), NOT disconnected.
    const filling = fakeWs(AUDIENCE_BUFFERED_SKIP_BYTES + 1);
    hub.sendAudienceRaw(filling.obj, 'frame');
    expect(filling.sent).toHaveLength(0);
    expect(filling.state.closed).toBe(false);

    // Past the hard ceiling → DISCONNECTED (never accumulates unbounded memory).
    const wedged = fakeWs(AUDIENCE_BUFFERED_HARD_CEILING + 1);
    hub.sendAudienceRaw(wedged.obj, 'frame');
    expect(wedged.sent).toHaveLength(0);
    expect(wedged.state.closed).toBe(true);

    // A healthy socket AFTER a wedged one still sends — others unaffected.
    const healthy2 = fakeWs(0);
    hub.sendAudienceRaw(healthy2.obj, 'frame2');
    expect(healthy2.sent).toEqual(['frame2']);
  });
});

// ===========================================================================
// Minor — the staff PANIC key fans out to the audience tier's screens (§6.1).
// ===========================================================================

describe('C25 review Minor — PANIC reaches the audience tier (spec §6.1)', () => {
  it('a director PANIC reaches an audience client as glyph-hide + director-msg PANIC', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret, ownerToken });
      clients.push(director);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);
      // Wait until the guestbook is seeded (so PANIC has glyphs to hide).
      await waitUntil(() => director.received.some((m) => m.t === 'glyph-snapshot'), {
        label: 'guestbook seeded',
      });

      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'PANIC' } as never));

      // The panic SIGNAL reaches the anonymous home screens: BOTH the name-clearing
      // director-msg PANIC and the glyph-hide (both in the §5.1 audience union).
      await waitUntil(
        () => audience.received.some((m) => m.t === 'director-msg' && (m as { kind: string }).kind === 'PANIC'),
        { label: 'audience received director PANIC' }
      );
      await waitUntil(() => ofType(audience, 'glyph-hide').length > 0, {
        label: 'audience received glyph-hide',
      });
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// Minor — visibilitychange:hidden → server drop → one-tap rejoin (fake timers).
// ===========================================================================

describe('C25 review Minor — hidden-tab pause → drop → rejoin (fake timers)', () => {
  it('a paused (heartbeat-stopped) audience socket is dropped, then the same IP rejoins in one tap', async () => {
    const timerApi = new FakeTimerApi();
    const { wsUrl } = makeServer({ timerApi });
    const clients: Client[] = [];
    try {
      const ip = '4.4.4.8';
      const audience = await join(wsUrl, 'pause-room', { tier: 'audience', ip });
      clients.push(audience);
      // The tab hides → the client stops its heartbeat (no more inbound frames). The
      // server-side idle-kick is the backstop: after the idle window it drops the socket.
      timerApi.advance(IDLE_KICK_MS + 5_000);
      await waitUntil(() => audience.closed, { label: 'server drop on hidden-tab pause' });

      // One tap re-opens the world: the same IP rejoins (the slot was freed on close).
      const rejoin = await join(wsUrl, 'pause-room', { tier: 'audience', ip });
      clients.push(rejoin);
      expect(rejoin.hello!.tier).toBe('audience');
      expect(rejoin.error).toBeUndefined();
    } finally {
      closeAll(clients);
    }
  });
});

// ===========================================================================
// C29 (F18 X-Ray Broadcast, spec §7.18) — the STAGE_XRAY director-console relay
// stays stage/spectator-scoped and NEVER leaks to the audience tier, exactly
// like the C25 PANIC-reaches-audience test above proves the OPPOSITE claim for
// PANIC. `tierAdmits`'s `director-msg` filter only ever admits `kind ===
// 'PANIC'` to `audience` (connection.ts) — a pre-existing filter, unmodified
// by C29 — so 'STAGE_XRAY' is excluded by construction. This test is the
// receive-side half of the boundary; the send-side half (an audience socket
// can never ISSUE a director-cmd at all, STAGE_XRAY included) is already
// covered by the M1 "audience send-side boundary" suite above.
// ===========================================================================

describe('C29 review — STAGE_XRAY stays stage/spectator-scoped (spec §7.18 / the C25 audience boundary)', () => {
  it('a director STAGE_XRAY reaches an authed spectator (the stage) as director-msg', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret, ownerToken });
      clients.push(director);
      // The stage itself: a `spectator` connection carrying the ownerToken (§5.1/§5.4).
      const stage = await join(wsUrl, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });
      clients.push(stage);

      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'STAGE_XRAY' } as never));

      await waitUntil(
        () => stage.received.some((m) => m.t === 'director-msg' && (m as { kind: string }).kind === 'STAGE_XRAY'),
        { label: 'stage (spectator) received director-msg STAGE_XRAY' }
      );
      // The issuing director console gets the ack (never the relay itself twice).
      await waitUntil(
        () => director.received.some((m) => m.t === 'director-ack' && (m as { cmd: string }).cmd === 'STAGE_XRAY'),
        { label: 'director received director-ack STAGE_XRAY' }
      );
    } finally {
      closeAll(clients);
    }
  });

  it('a director STAGE_XRAY NEVER reaches the audience tier (the C25 boundary — unmodified tierAdmits)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const clients: Client[] = [];
    try {
      const director = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret, ownerToken });
      clients.push(director);
      const stage = await join(wsUrl, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });
      clients.push(stage);
      const audience = await join(wsUrl, roomId, { tier: 'audience' });
      clients.push(audience);

      director.ws.send(encodeText({ t: 'director-cmd', cmd: 'STAGE_XRAY' } as never));

      // Wait for the STAGE to receive it (proves the relay fired at all)…
      await waitUntil(
        () => stage.received.some((m) => m.t === 'director-msg' && (m as { kind: string }).kind === 'STAGE_XRAY'),
        { label: 'stage received director-msg STAGE_XRAY' }
      );
      // …then give the audience socket ample time to have received it too, and
      // assert it NEVER did — never even a bare `director-msg`, any kind.
      await wait(300);
      expect(audience.received.some((m) => m.t === 'director-msg')).toBe(false);
    } finally {
      closeAll(clients);
    }
  });
});
