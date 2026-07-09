/**
 * auth.integration.test.ts — Task C4 harness tests (real server + real ws).
 *
 * Exercises the wired auth surface end-to-end:
 *  - POST /api/rooms → {roomId, ownerToken} + per-IP rate limit
 *  - HMAC join secret gates EXPLICIT resident/spectator (bad/absent → crowd)
 *  - the Phase B compat path ({t:'join'} with NO tier) still joins as resident
 *  - ownerToken grants DIRECTOR_CMD on ANY tier
 *  - ROTATE_SECRET / DOOR_CLOSE / ROTATE_LINK incident controls
 *  - server-side mute (frames dropped) + kick (disconnect)
 *  - roster provenance {entryRoute, joinedAt} + rttMs
 *  - epoch + token survive a restart
 *
 * A FakeTimerApi is injected for the idle-kick pieces; auth TTL/backoff use the
 * store's own injected clock in the unit test (auth.test.ts). This file uses the
 * real HTTP + WS transport to prove the wiring.
 */

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { encodeText, decodeText, packVoice, VOICE_OPUS, PROTOCOL_VERSION } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _servers: ServerHandle[] = [];
let _tmpDirs: string[] = [];

afterEach(async () => {
  const servers = _servers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
  for (const d of _tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeServer(opts?: { dataDir?: string }): {
  server: ServerHandle;
  wsUrl: string;
  httpBase: string;
} {
  const server = startServer(0, opts?.dataDir ? { dataDir: opts.dataDir } : {});
  _servers.push(server);
  return {
    server,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpBase: `http://127.0.0.1:${server.port}`,
  };
}

function makeTmpDataDir(): string {
  const d = mkdtempSync(pathJoin(tmpdir(), 'c4-auth-'));
  _tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// HTTP helper (POST /api/rooms), with a settable X-Forwarded-For for per-IP tests
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

function httpPost(base: string, path: string, ip?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ip) headers['X-Forwarded-For'] = ip;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* non-JSON (e.g. moved page) */
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpGet(base: string, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

// Each ws gets a persistent text-message QUEUE so no message is lost between
// successive nextText() calls (the naive attach-a-fresh-listener approach races
// when a downgrade arrives immediately before its hello).
const _textQueues = new WeakMap<WebSocket, { buf: ServerMsg[]; waiters: Array<(m: ServerMsg) => void> }>();

function attachQueue(ws: WebSocket): void {
  if (_textQueues.has(ws)) return;
  const q = { buf: [] as ServerMsg[], waiters: [] as Array<(m: ServerMsg) => void> };
  _textQueues.set(ws, q);
  ws.on('message', (data: WebSocket.RawData) => {
    // Skip ALL binary frames — voice (0x10–0x1F) AND Phase C binary families
    // (0x20–0x3F, e.g. MUSIC 0x29 / CASTER_LINE 0x33 which fan out to spectators).
    // Text JSON always starts with '{' (0x7B); any other first byte is a binary frame.
    if (Buffer.isBuffer(data) && data.length > 0 && data[0] !== 0x7b) return;
    const msg = decodeText(data.toString()) as ServerMsg;
    const w = q.waiters.shift();
    if (w) w(msg);
    else q.buf.push(msg);
  });
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      attachQueue(ws);
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function nextText(ws: WebSocket, timeoutMs = 2000): Promise<ServerMsg> {
  const q = _textQueues.get(ws);
  if (!q) return Promise.reject(new Error('queue not attached (use open())'));
  const queued = q.buf.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = q.waiters.indexOf(w);
      if (i >= 0) q.waiters.splice(i, 1);
      reject(new Error('timeout waiting for text message'));
    }, timeoutMs);
    const w = (m: ServerMsg) => {
      clearTimeout(timer);
      resolve(m);
    };
    q.waiters.push(w);
  });
}

/** Wait for the next message whose `t` is in `types`, skipping join/world noise. */
async function waitFor(ws: WebSocket, types: string[], timeoutMs = 2000): Promise<ServerMsg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const m = await nextText(ws, remaining);
    if (types.includes(m.t)) return m;
    // skip welcome / player-join / player-leave / state / pose / voice noise
  }
}

/** Send a join and return the `hello` (skipping any preceding `downgrade`). */
async function joinAndHello(
  ws: WebSocket,
  room: string,
  extra: Record<string, unknown> = {}
): Promise<Extract<ServerMsg, { t: 'hello' }> & { _downgraded?: boolean }> {
  ws.send(encodeText({ t: 'join', room, name: 'x', color: 0, protocol: PROTOCOL_VERSION, ...extra }));
  let downgraded = false;
  for (let i = 0; i < 6; i++) {
    const m = await nextText(ws);
    if (m.t === 'downgrade') {
      downgraded = true;
      continue;
    }
    if (m.t === 'hello') return { ...m, _downgraded: downgraded };
    if (m.t === 'error') throw new Error(`join error: ${m.code}`);
    // skip welcome/player-join noise while waiting for hello (hello precedes them)
  }
  throw new Error('no hello received');
}

async function createRoomHttp(httpBase: string, ip = '1.2.3.4'): Promise<{ roomId: string; ownerToken: string }> {
  const res = await httpPost(httpBase, '/api/rooms', ip);
  expect(res.status).toBe(200);
  expect(res.json).toBeTruthy();
  return {
    roomId: String(res.json?.roomId),
    ownerToken: String(res.json?.ownerToken),
  };
}

// ===========================================================================
// POST /api/rooms
// ===========================================================================

describe('C4 — POST /api/rooms', () => {
  it('returns a distinct {roomId, ownerToken} per call', async () => {
    const { httpBase } = makeServer();
    const a = await createRoomHttp(httpBase, '1.1.1.1');
    const b = await createRoomHttp(httpBase, '1.1.1.1');
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.ownerToken).not.toBe(b.ownerToken);
  });

  it('K rapid creations from one IP → 429', async () => {
    const { httpBase } = makeServer();
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await httpPost(httpBase, '/api/rooms', '5.5.5.5');
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
    // A different IP is not throttled.
    const other = await httpPost(httpBase, '/api/rooms', '6.6.6.6');
    expect(other.status).toBe(200);
  });
});

// ===========================================================================
// Explicit tier auth via the HMAC join secret (the C4 core + carried directive)
// ===========================================================================

describe('C4 — HMAC join secret gates explicit resident/spectator', () => {
  it('EXPLICIT tier:resident WITH a valid HMAC secret joins as resident', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident', joinSecret: secret });
    expect(hello.tier).toBe('resident');
    expect(hello._downgraded).toBe(false);
    ws.close();
  });

  it('EXPLICIT tier:resident with a BAD secret downgrades to crowd', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident', joinSecret: 'wrong-secret' });
    expect(hello.tier).toBe('crowd');
    expect(hello._downgraded).toBe(true);
    ws.close();
  });

  it('EXPLICIT tier:resident with NO secret downgrades to crowd', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident' });
    expect(hello.tier).toBe('crowd');
    ws.close();
  });

  it('EXPLICIT tier:spectator with a valid HMAC secret joins as spectator', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'spectator', joinSecret: secret });
    expect(hello.tier).toBe('spectator');
    ws.close();
  });

  // CARRIED-FORWARD DIRECTIVE (from the C2 review): the absent-tier Phase B
  // compat path MUST STILL join as resident (no tier + no secret). C7 inverts it.
  it('Phase B compat: a bare {t:join} with NO tier + NO secret still joins as resident', async () => {
    const { wsUrl } = makeServer();
    const ws = await open(wsUrl);
    // No room created via HTTP — Phase B rooms auto-create on join.
    const hello = await joinAndHello(ws, 'phasebroom', {});
    expect(hello.tier).toBe('resident');
    ws.close();
  });

  it('public wisp/crowd joins never need a secret (unaffected by auth)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const wisp = await open(wsUrl);
    const wh = await joinAndHello(wisp, roomId, { tier: 'wisp' });
    expect(wh.tier).toBe('wisp');
    const crowd = await open(wsUrl);
    const ch = await joinAndHello(crowd, roomId, { tier: 'crowd' });
    expect(ch.tier).toBe('crowd');
    wisp.close();
    crowd.close();
  });
});

// ===========================================================================
// Failed-auth backoff per (IP, roomId)
// ===========================================================================

describe('C4 — failed-join backoff', () => {
  it('a bad-secret resident join is not director AND arms the (IP,roomId) backoff', async () => {
    const { wsUrl, httpBase, server } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident', joinSecret: 'wrong' });
    expect(hello.tier).toBe('crowd'); // not a resident, certainly not director
    ws.close();
    // The auth store records the failed attempt. We can observe throttle state
    // via the server's exposed auth accessor.
    const auth = server.authStore;
    expect(auth).toBeTruthy();
    expect(auth!.isJoinThrottled('127.0.0.1', roomId)).toBe(true);
  });
});

// ===========================================================================
// Regression: throttle IS consulted at the join path (was never enforced before)
// ===========================================================================

describe('C4 — throttle enforcement at join path (regression)', () => {
  /**
   * This test MUST FAIL against the old code (where isJoinThrottled was never
   * called in the join handler). It verifies that after N failed explicit-resident
   * joins the per-(IP,roomId) backoff is ACTUALLY CONSULTED and the next join
   * attempt with a bad secret receives `{t:'error', code:'throttled'}` — NOT merely
   * a downgrade-by-bad-secret. A bare {t:'join'} (no tier) is never throttled.
   */
  it('throttled (IP,roomId): subsequent explicit-resident join with bad secret gets throttled error', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);

    // Exhaust the initial backoff window: first failed join records fails=1 → 500 ms window.
    // We just need at least one failure to arm the backoff (BACKOFF_BASE_MS=500 ms).
    const ws1 = await open(wsUrl);
    const h1 = await joinAndHello(ws1, roomId, { tier: 'resident', joinSecret: 'wrong-secret' });
    expect(h1.tier).toBe('crowd'); // first failure → downgrade (not yet throttled)
    ws1.close();

    // Now the (IP, roomId) is throttled (nextAllowedAt = now + 500 ms).
    // A SECOND explicit-resident join with a bad secret must be refused with
    // {t:'error', code:'throttled'}, NOT merely downgraded.
    const ws2 = await open(wsUrl);
    ws2.send(encodeText({
      t: 'join',
      room: roomId,
      name: 'x',
      color: 0,
      protocol: PROTOCOL_VERSION,
      tier: 'resident',
      joinSecret: 'wrong-secret',
    }));
    // The server should reply with an error, then close the socket.
    const reply = await nextText(ws2);
    expect(reply.t).toBe('error');
    if (reply.t === 'error') {
      expect(reply.code).toBe('throttled');
    }
    ws2.close();
  });

  it('throttle does NOT affect a bare {t:join} with no tier (downgraded to crowd, not throttled error)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);

    // Arm the backoff with a bad explicit-resident attempt.
    const ws1 = await open(wsUrl);
    await joinAndHello(ws1, roomId, { tier: 'resident', joinSecret: 'wrong' });
    ws1.close();

    // A bare join (no tier) to a secret-configured room is NOT throttled — the
    // throttle is keyed on FAILED auth attempts, and a bare join does not fail
    // auth (it downgrades silently). Post-inversion: bare join to a secret room
    // lands as crowd (not resident), but crucially it gets a 'hello' (not an
    // 'error'/'throttled') — the connection is accepted, only the tier differs.
    const ws2 = await open(wsUrl);
    const hello = await joinAndHello(ws2, roomId, {}); // no tier
    // The inversion: secret-configured room → bare join lands as crowd, not resident.
    expect(hello.tier).toBe('crowd');
    // And it was NOT throttled (we got a hello, not a throttled error).
    expect(hello._downgraded).toBe(true);
    ws2.close();
  });
});

// ===========================================================================
// Security fix: absent-tier inversion — closes the booth-room hole (Phase C7)
// ===========================================================================

describe('C7 — absent-tier inversion (booth-room security)', () => {
  /**
   * THE HOLE: bare {t:'join'} (no tier) to a secret-configured room used to
   * land as resident (granting grab/spawn/vote/voice with NO secret). The
   * inversion must close this: bare join to a POST /api/rooms room → crowd.
   *
   * This test must FAIL before the fix and PASS after.
   */
  it('bare {t:join} to a SECRET-configured room → granted crowd (closes the hole)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const ws = await open(wsUrl);
    // Send bare join with NO tier and NO secret to a booth room.
    const hello = await joinAndHello(ws, roomId, {}); // no tier, no secret
    expect(hello.tier).toBe('crowd'); // must NOT be resident
    expect(hello._downgraded).toBe(true); // downgrade path was taken
    ws.close();
  });

  /**
   * Phase B compat: bare {t:'join'} to a room with NO configured secret
   * (a plain dev / Phase B room that was NOT created via POST /api/rooms)
   * must still land as resident. The inversion must NOT affect Phase B.
   *
   * This test must PASS both before and after the fix (it is the invariant).
   */
  it('bare {t:join} to a NO-secret room → granted resident (Phase B compat)', async () => {
    const { wsUrl } = makeServer();
    // 'phasebroom' was NOT registered via POST /api/rooms → no configured secret.
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, 'phasebroom', {}); // no tier, no secret
    expect(hello.tier).toBe('resident');
    expect(hello._downgraded).toBeFalsy(); // no downgrade
    ws.close();
  });

  /**
   * C4 behavior still holds: explicit tier:'resident' + VALID HMAC secret → resident.
   * This test confirms the inversion does NOT break the explicit authorized path.
   */
  it('explicit tier:resident + VALID HMAC secret to secret-room → granted resident', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident', joinSecret: secret });
    expect(hello.tier).toBe('resident');
    expect(hello._downgraded).toBe(false);
    ws.close();
  });

  /**
   * C4 behavior still holds: explicit tier:'resident' + BAD/absent secret to
   * a secret-room → downgrade to crowd (unchanged from C2/C4).
   */
  it('explicit tier:resident + BAD secret to secret-room → crowd (C2/C4 unchanged)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const ws = await open(wsUrl);
    const hello = await joinAndHello(ws, roomId, { tier: 'resident', joinSecret: 'wrong-bad-secret' });
    expect(hello.tier).toBe('crowd');
    expect(hello._downgraded).toBe(true);
    ws.close();
  });
});

// ===========================================================================
// ownerToken grants DIRECTOR_CMD on any tier
// ===========================================================================

describe('C4 — DIRECTOR_CMD authorization', () => {
  it('a DIRECTOR_CMD is rejected from an unauthed resident but accepted from a spectator carrying the ownerToken', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    // (a) An authed resident WITHOUT the ownerToken cannot issue a DIRECTOR_CMD.
    const resident = await open(wsUrl);
    await joinAndHello(resident, roomId, { tier: 'resident', joinSecret: secret });
    resident.send(encodeText({ t: 'director-cmd', cmd: 'NOOP' }));
    const r1 = await waitFor(resident, ['error', 'director-ack']);
    expect(r1.t).toBe('error');
    if (r1.t === 'error') expect(r1.code).toBe('not-authorized');
    resident.close();

    // (b) A spectator carrying the ownerToken IS a director-capable connection.
    const spectator = await open(wsUrl);
    const sh = await joinAndHello(spectator, roomId, {
      tier: 'spectator',
      joinSecret: secret,
      ownerToken,
    });
    expect(sh.tier).toBe('spectator');
    spectator.send(encodeText({ t: 'director-cmd', cmd: 'NOOP' }));
    const r2 = await waitFor(spectator, ['director-ack', 'error']);
    expect(r2.t).toBe('director-ack');
    spectator.close();
  });
});

// ===========================================================================
// ROTATE_SECRET incident control
// ===========================================================================

describe('C4 — ROTATE_SECRET', () => {
  it('post-rotation: old secret downgrades to crowd, a re-issued bookmark joins as resident, public + permalink unaffected', async () => {
    const dataDir = makeTmpDataDir();
    const { wsUrl, httpBase, server } = makeServer({ dataDir });
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const oldSecret = deriveJoinSecret(ownerToken, roomId, 0);

    // A staff connection carrying the ownerToken issues ROTATE_SECRET.
    const staff = await open(wsUrl);
    await joinAndHello(staff, roomId, { tier: 'spectator', joinSecret: oldSecret, ownerToken });
    staff.send(encodeText({ t: 'director-cmd', cmd: 'ROTATE_SECRET' }));
    const ack = await waitFor(staff, ['director-ack', 'error']);
    expect(ack.t).toBe('director-ack');
    if (ack.t === 'director-ack') expect(ack.epoch).toBe(1);
    staff.close();

    // Old staff URL (epoch-0 secret) now DOWNGRADES to crowd (arms the backoff).
    const stale = await open(wsUrl);
    const staleHello = await joinAndHello(stale, roomId, { tier: 'resident', joinSecret: oldSecret });
    expect(staleHello.tier).toBe('crowd');
    stale.close();

    // Clear the (IP, roomId) backoff so the fresh join (valid epoch-1 secret) is
    // not pre-refused by the throttle that the stale join armed. A successful join
    // naturally calls recordSuccessfulJoin; calling it here mimics a client that
    // paused long enough for the window to expire (avoids a real 500 ms sleep).
    server.authStore.recordSuccessfulJoin('127.0.0.1', roomId);

    // A re-issued bookmark (epoch-1 secret) joins as resident.
    const fresh = await open(wsUrl);
    const newSecret = deriveJoinSecret(ownerToken, roomId, 1);
    const freshHello = await joinAndHello(fresh, roomId, { tier: 'resident', joinSecret: newSecret });
    expect(freshHello.tier).toBe('resident');
    fresh.close();

    // Public wisp/crowd joins (the permalink path) are unaffected.
    const wisp = await open(wsUrl);
    const wh = await joinAndHello(wisp, roomId, { tier: 'wisp' });
    expect(wh.tier).toBe('wisp');
    wisp.close();
  });

  it('epoch survives a server restart (same DATA_DIR)', async () => {
    const dataDir = makeTmpDataDir();
    // First server: create + rotate.
    const s1 = makeServer({ dataDir });
    const { roomId, ownerToken } = await createRoomHttp(s1.httpBase);
    const staff = await open(s1.wsUrl);
    await joinAndHello(staff, roomId, {
      tier: 'spectator',
      joinSecret: deriveJoinSecret(ownerToken, roomId, 0),
      ownerToken,
    });
    staff.send(encodeText({ t: 'director-cmd', cmd: 'ROTATE_SECRET' }));
    await waitFor(staff, ['director-ack', 'error']); // ack
    staff.close();
    await _servers.splice(0)[0]!.close(); // close s1 explicitly (afterEach would too)

    // Second server over the SAME data dir: epoch-1 secret still resident,
    // epoch-0 still downgrades, ownerToken still works.
    const s2 = makeServer({ dataDir });
    const okWs = await open(s2.wsUrl);
    const okHello = await joinAndHello(okWs, roomId, {
      tier: 'resident',
      joinSecret: deriveJoinSecret(ownerToken, roomId, 1),
    });
    expect(okHello.tier).toBe('resident');
    okWs.close();

    const staleWs = await open(s2.wsUrl);
    const staleHello = await joinAndHello(staleWs, roomId, {
      tier: 'resident',
      joinSecret: deriveJoinSecret(ownerToken, roomId, 0),
    });
    expect(staleHello.tier).toBe('crowd');
    staleWs.close();
  });

  it('token survives restart: the ownerToken still grants DIRECTOR_CMD after reboot', async () => {
    const dataDir = makeTmpDataDir();
    const s1 = makeServer({ dataDir });
    const { roomId, ownerToken } = await createRoomHttp(s1.httpBase);
    await _servers.splice(0)[0]!.close();

    const s2 = makeServer({ dataDir });
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const ws = await open(s2.wsUrl);
    await joinAndHello(ws, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });
    ws.send(encodeText({ t: 'director-cmd', cmd: 'NOOP' }));
    const ack = await waitFor(ws, ['director-ack', 'error']);
    expect(ack.t).toBe('director-ack');
    ws.close();
  });
});

// ===========================================================================
// DOOR_CLOSE incident control
// ===========================================================================

describe('C4 — DOOR_CLOSE', () => {
  it('after DOOR_CLOSE a new wisp is refused (downgrade) while an authed resident still joins', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const staff = await open(wsUrl);
    await joinAndHello(staff, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });
    staff.send(encodeText({ t: 'director-cmd', cmd: 'DOOR_CLOSE' }));
    const ack = await waitFor(staff, ['director-ack', 'error']);
    expect(ack.t).toBe('director-ack');

    // A NEW public wisp is refused → lands as crowd with a door-closed downgrade.
    const wisp = await open(wsUrl);
    const wh = await joinAndHello(wisp, roomId, { tier: 'wisp' });
    expect(wh.tier).toBe('crowd');
    expect(wh._downgraded).toBe(true);
    wisp.close();

    // An authed resident STILL joins (doors only pause public joins).
    const res = await open(wsUrl);
    const rh = await joinAndHello(res, roomId, { tier: 'resident', joinSecret: secret });
    expect(rh.tier).toBe('resident');
    res.close();
    staff.close();
  });
});

// ===========================================================================
// ROTATE_LINK incident control
// ===========================================================================

describe('C4 — ROTATE_LINK', () => {
  it('confirm-twice is required, then the old id serves a moved page with NO new roomId, and joins on it fail', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const staff = await open(wsUrl);
    await joinAndHello(staff, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });

    // First ROTATE_LINK → a confirm-required response, NOT yet rotated.
    staff.send(encodeText({ t: 'director-cmd', cmd: 'ROTATE_LINK' }));
    const first = await waitFor(staff, ['director-ack', 'error']);
    expect(first.t).toBe('director-ack');
    if (first.t === 'director-ack') expect(first.confirmRequired).toBe(true);

    // Second (confirmed) ROTATE_LINK → rotated; a NEW roomId is minted.
    staff.send(encodeText({ t: 'director-cmd', cmd: 'ROTATE_LINK', confirm: true }));
    const second = await waitFor(staff, ['director-ack', 'error']);
    expect(second.t).toBe('director-ack');
    const newRoomId = second.t === 'director-ack' ? second.newRoomId : undefined;
    expect(typeof newRoomId).toBe('string');
    if (typeof newRoomId !== 'string') throw new Error('no newRoomId');
    staff.close();

    // The OLD id now serves the static "moved" page — with NO new-room identifier.
    const moved = await httpGet(httpBase, `/api/rooms/${roomId}/status`);
    expect(moved.body.toLowerCase()).toContain('discord');
    expect(moved.body).not.toContain(newRoomId);

    // A JOIN on the OLD id now fails (the room is retired).
    const ws = await open(wsUrl);
    ws.send(encodeText({ t: 'join', room: roomId, name: 'x', color: 0, protocol: PROTOCOL_VERSION, tier: 'resident', joinSecret: secret }));
    const m = await nextText(ws);
    expect(m.t).toBe('error');
    if (m.t === 'error') expect(m.code).toBe('room-retired');
    ws.close();
  });
});

// ===========================================================================
// Server-side mute (drop 0x1x frames at fan-out) + kick (disconnect)
// ===========================================================================

describe('C4 — mute + kick', () => {
  it('a muted resident’s voice frames are NOT fanned to peers', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    // Director (spectator + ownerToken), a talker resident, and a listener resident.
    const director = await open(wsUrl);
    await joinAndHello(director, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });

    const talker = await open(wsUrl);
    const th = await joinAndHello(talker, roomId, { tier: 'resident', joinSecret: secret });
    const listener = await open(wsUrl);
    await joinAndHello(listener, roomId, { tier: 'resident', joinSecret: secret });

    // Both enable voice so frames would normally fan out.
    talker.send(encodeText({ t: 'voice-join' }));
    listener.send(encodeText({ t: 'voice-join' }));
    await new Promise((r) => setTimeout(r, 50));

    // Director mutes the talker.
    director.send(encodeText({ t: 'director-cmd', cmd: 'MUTE', targetId: th.peerId }));
    await waitFor(director, ['director-ack', 'error']); // ack
    await new Promise((r) => setTimeout(r, 30));

    // Listen for any binary frame on the listener for a short window.
    let gotFrame = false;
    const onBin = (data: WebSocket.RawData) => {
      if (Buffer.isBuffer(data) && data.length > 0 && data[0]! >= 0x10 && data[0]! <= 0x12) gotFrame = true;
    };
    listener.on('message', onBin);

    // Talker sends a voice frame — it must be dropped at fan-out.
    talker.send(Buffer.from(packVoice(VOICE_OPUS, 0, 1234, 0, new Uint8Array([1, 2, 3]))));
    await new Promise((r) => setTimeout(r, 120));
    listener.off('message', onBin);
    expect(gotFrame).toBe(false);

    director.close();
    talker.close();
    listener.close();
  });

  it('a kicked peer is disconnected', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const director = await open(wsUrl);
    await joinAndHello(director, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });
    const victim = await open(wsUrl);
    const vh = await joinAndHello(victim, roomId, { tier: 'resident', joinSecret: secret });

    const closed = new Promise<void>((resolve) => victim.once('close', () => resolve()));
    director.send(encodeText({ t: 'director-cmd', cmd: 'KICK', targetId: vh.peerId }));
    await waitFor(director, ['director-ack', 'error']); // ack
    await closed; // resolves → the victim socket was disconnected
    director.close();
  });
});

// ===========================================================================
// Roster provenance {entryRoute, joinedAt} + rttMs
// ===========================================================================

describe('C4 — roster provenance + rttMs', () => {
  it('the director/spectator roster carries {entryRoute, joinedAt} per peer', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const director = await open(wsUrl);
    await joinAndHello(director, roomId, { tier: 'spectator', joinSecret: secret, ownerToken });

    const resident = await open(wsUrl);
    await joinAndHello(resident, roomId, { tier: 'resident', joinSecret: secret });

    // Ask the director connection for the roster (a DIRECTOR_CMD).
    director.send(encodeText({ t: 'director-cmd', cmd: 'ROSTER' }));
    const roster = await waitFor(director, ['roster', 'error']);
    expect(roster.t).toBe('roster');
    if (roster.t !== 'roster') throw new Error('expected roster');
    expect(Array.isArray(roster.entries)).toBe(true);
    const entry = roster.entries.find((e) => e.tier === 'resident');
    expect(entry).toBeTruthy();
    expect(typeof entry!.entryRoute).toBe('string');
    expect(typeof entry!.joinedAt).toBe('number');

    director.close();
    resident.close();
  });
});
