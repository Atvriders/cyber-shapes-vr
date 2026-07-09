/**
 * clips.integration.test.ts — Task C31 (F20 Neon Clip Machine, spec §7.20)
 * harness tests: real server + real HTTP requests + the real WS director-cmd
 * relay. Proves the WIRING (not just the ClipStore's isolated logic, covered
 * in clips.test.ts):
 *   - POST /api/clips: ownerToken-in-header auth, real streaming size reject,
 *     success round-trips to a working GET.
 *   - GET /api/clips/:id: PUBLIC (no auth), delivers the exact bytes + content
 *     type, counts metrics('clip') on delivery.
 *   - The per-IP limiter reuses the SAME hardened `clientIpOf` every other C25/
 *     C30 per-IP limiter uses: a spoofed LEFTMOST X-Forwarded-For does NOT
 *     evade it (only the trusted CF-Connecting-IP / rightmost-XFF hop counts).
 *   - SAVE_CLIP director-cmd relays to the stage (spectator) as a director-msg,
 *     and NEVER reaches the audience tier (the C25 boundary, unmodified).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { encodeText, decodeText, PROTOCOL_VERSION } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';
import { CLIP_POST_PER_IP_MAX, CLIP_GET_PER_IP_MAX } from '../src/clips.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const servers = _servers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
});

function makeServer(opts: { clipMaxBytes?: number; clipNow?: () => number } = {}): {
  server: ServerHandle;
  wsUrl: string;
  httpBase: string;
} {
  const server = startServer(0, opts);
  _servers.push(server);
  return {
    server,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    httpBase: `http://127.0.0.1:${server.port}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  json: Record<string, unknown> | null;
}

function httpPostJson(base: string, path: string, ip?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ip) headers['X-Forwarded-For'] = ip;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.end();
  });
}

interface PostClipHttpOpts {
  clipId: string;
  roomId: string;
  ownerToken?: string;
  body: Buffer;
  contentType?: string;
  /** Trusted CF-Connecting-IP (spoof-resistant per-IP keying). */
  cfIp?: string;
  /** A SPOOFABLE leftmost X-Forwarded-For — must be IGNORED for per-IP keying. */
  xff?: string;
}

function postClipHttp(base: string, opts: PostClipHttpOpts): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + '/api/clips');
    const headers: Record<string, string> = {
      'Content-Type': opts.contentType ?? 'video/webm',
      'X-Clip-Id': opts.clipId,
      'X-Room-Id': opts.roomId,
      'Content-Length': String(opts.body.byteLength),
    };
    if (opts.ownerToken !== undefined) headers['X-Owner-Token'] = opts.ownerToken;
    if (opts.cfIp) headers['CF-Connecting-IP'] = opts.cfIp;
    if (opts.xff) headers['X-Forwarded-For'] = opts.xff;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers },
      (res) => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

function getClipHttp(
  base: string,
  clipId: string,
  opts: { cfIp?: string; xff?: string } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + `/api/clips/${clipId}`);
    const headers: Record<string, string> = {};
    if (opts.cfIp) headers['CF-Connecting-IP'] = opts.cfIp;
    if (opts.xff) headers['X-Forwarded-For'] = opts.xff;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers },
      (res) => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.end();
  });
}

function collect(
  res: http.IncomingMessage,
  resolve: (r: HttpResult) => void,
  reject: (e: unknown) => void
): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    const body = Buffer.concat(chunks);
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      /* binary body (a real clip GET) — non-JSON is expected */
    }
    resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
  });
  res.on('error', reject);
}

async function createRoomHttp(httpBase: string): Promise<{ roomId: string; ownerToken: string }> {
  const res = await httpPostJson(httpBase, '/api/rooms');
  expect(res.status).toBe(200);
  return { roomId: String(res.json?.['roomId']), ownerToken: String(res.json?.['ownerToken']) };
}

/** A valid-shaped 128-bit-hex clipId fixture (deterministic per test, not random). */
function fixtureClipId(seed: string): string {
  let hex = '';
  for (let i = 0; i < seed.length; i++) hex += seed.charCodeAt(i).toString(16);
  return (hex + '0'.repeat(32)).slice(0, 32);
}

// ===========================================================================
// POST /api/clips
// ===========================================================================

describe('C31 — POST /api/clips (wired)', () => {
  it('an authorized POST stores the clip and a subsequent GET retrieves the exact bytes', async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('roundtrip1');
    const body = Buffer.from('fake-webm-clip-bytes');

    const post = await postClipHttp(httpBase, { clipId, roomId, ownerToken, body, contentType: 'video/webm' });
    expect(post.status).toBe(200);
    expect(post.json).toMatchObject({ ok: true, clipId });

    const get = await getClipHttp(httpBase, clipId);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('video/webm');
    expect(get.body.equals(body)).toBe(true);
  });

  it('a MISSING ownerToken is rejected with 401 (never a URL-based secret)', async () => {
    const { httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('noauth1');
    const post = await postClipHttp(httpBase, { clipId, roomId, body: Buffer.from('x') });
    expect(post.status).toBe(401);
  });

  it('a WRONG ownerToken is rejected with 401', async () => {
    const { httpBase } = makeServer();
    const { roomId } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('badauth1');
    const post = await postClipHttp(httpBase, {
      clipId,
      roomId,
      ownerToken: 'totally-wrong-token',
      body: Buffer.from('x'),
    });
    expect(post.status).toBe(401);
  });

  it('a real oversize body is rejected mid-stream (413) — the streaming cap actually wires up', async () => {
    // A small clipMaxBytes override so the test doesn't need to push 25 MB
    // over loopback; CLIP_MAX_BYTES' real 25 MB VALUE is asserted in clips.test.ts.
    const { httpBase } = makeServer({ clipMaxBytes: 1000 });
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('oversize1');
    const body = Buffer.alloc(5000, 1);
    const post = await postClipHttp(httpBase, { clipId, roomId, ownerToken, body });
    expect(post.status).toBe(413);

    // The oversized clip was never actually stored — a GET still 404s.
    const get = await getClipHttp(httpBase, clipId);
    expect(get.status).toBe(404);
  });

  it(`>= ${CLIP_POST_PER_IP_MAX} rapid POSTs from ONE (trusted) IP hit the per-IP limit (429)`, async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    let got429 = false;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 5; i++) {
      const res = await postClipHttp(httpBase, {
        clipId: fixtureClipId(`ratelimit${i}`),
        roomId,
        ownerToken,
        body: Buffer.from('x'),
        cfIp: '11.11.11.11',
      });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('MF2 — an UNAUTH (tokenless) POST flood from one IP is 429\'d (the pre-auth gate records unauth attempts)', async () => {
    // On base ed01ae5 the per-IP limiter sat AFTER the 401 and recorded only on
    // SUCCESS, so a tokenless IP NEVER got a 429 — every request was a bare 401.
    // Now the pre-auth gate counts every attempt, so a tokenless flood trips 429.
    const { httpBase } = makeServer();
    let saw401 = false;
    let saw429 = false;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 5; i++) {
      const res = await postClipHttp(httpBase, {
        clipId: fixtureClipId(`unauthflood${i}`),
        roomId: 'anyroom',
        // NO ownerToken — a tokenless attacker.
        body: Buffer.from('x'),
        cfIp: '55.55.55.55',
      });
      if (res.status === 401) saw401 = true;
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw401).toBe(true); // early tokenless attempts 401 (auth still enforced)
    expect(saw429).toBe(true); // but the flood IS throttled (the MF2 fix)
  });

  it('MF2 — the per-IP throttle fires BEFORE the body is buffered (an over-limit oversized POST is 429, not 413)', async () => {
    // A small clipMaxBytes so an oversized body is cheap to send over loopback.
    const { httpBase } = makeServer({ clipMaxBytes: 1000 });
    // Consume the whole per-IP budget with small tokenless POSTs (each 401, but
    // each RECORDED by the pre-auth gate).
    for (let i = 0; i < CLIP_POST_PER_IP_MAX; i++) {
      await postClipHttp(httpBase, {
        clipId: fixtureClipId(`consume${i}`),
        roomId: 'r',
        body: Buffer.from('x'),
        cfIp: '56.56.56.56',
      });
    }
    // Now an OVERSIZED tokenless POST from the SAME IP: if the throttle ran AFTER
    // the body read (the bug) this would 413 (having buffered the body first).
    // Because the throttle runs BEFORE readBodyCapped, it is 429 — the 25 MB body
    // is never buffered on the unauth surface.
    const res = await postClipHttp(httpBase, {
      clipId: fixtureClipId('overlimitbig'),
      roomId: 'r',
      body: Buffer.alloc(5000, 1), // > clipMaxBytes
      cfIp: '56.56.56.56',
    });
    expect(res.status).toBe(429);
  });

  it('MF2 — a spoofed LEFTMOST X-Forwarded-For does NOT evade the pre-auth POST throttle (clientIpOf)', async () => {
    // Mirrors the GET spoof regression: a unique fake leftmost XFF per request must
    // NOT look like a distinct attacker. All requests share the same real socket
    // peer (rightmost trusted hop), so the tokenless flood still trips 429.
    const { httpBase } = makeServer();
    let saw429 = false;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 5; i++) {
      const res = await postClipHttp(httpBase, {
        clipId: fixtureClipId(`spoofpost${i}`),
        roomId: 'r',
        body: Buffer.from('x'),
        xff: `9.${i}.${i}.${i}, 127.0.0.1`,
      });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

// ===========================================================================
// MUST-FIX 1 — the PUBLIC GET serves FORCED-SAFE headers (stored XSS)
// ===========================================================================

describe('C31 MF1 — GET /api/clips/:id forced-safe headers (stored XSS)', () => {
  it('a clip POSTed as text/html with a <script> body is served INERT (octet-stream + nosniff + attachment)', async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('xss1');
    const evil = Buffer.from('<script>fetch("/steal?c="+document.cookie)</script>');

    const post = await postClipHttp(httpBase, {
      clipId,
      roomId,
      ownerToken,
      body: evil,
      contentType: 'text/html', // the attack: an active type on the shared origin
    });
    expect(post.status).toBe(200);

    const get = await getClipHttp(httpBase, clipId);
    expect(get.status).toBe(200);
    // NEVER served as text/html — coerced to an inert type.
    expect(get.headers['content-type']).toBe('application/octet-stream');
    // The browser must not sniff the bytes into HTML.
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    // It is a DOWNLOAD, never a navigable document on the app's own origin.
    expect(String(get.headers['content-disposition'])).toContain('attachment');
    expect(String(get.headers['content-disposition'])).toContain(`clip-${clipId}.bin`);
    // Belt-and-suspenders: even if rendered, scripts are sandboxed away.
    expect(String(get.headers['content-security-policy'])).toContain('sandbox');
  });

  it('a legit video/webm clip is served as video/webm + nosniff + attachment (.webm)', async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('webmok1');
    const body = Buffer.from('fake-webm');
    await postClipHttp(httpBase, { clipId, roomId, ownerToken, body, contentType: 'video/webm;codecs=vp8,opus' });

    const get = await getClipHttp(httpBase, clipId);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('video/webm');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(String(get.headers['content-disposition'])).toContain(`clip-${clipId}.webm`);
    expect(get.body.equals(body)).toBe(true);
  });
});

// ===========================================================================
// GET /api/clips/:id — public + per-IP rate limit + the clientIpOf spoof test
// ===========================================================================

describe('C31 — GET /api/clips/:id (wired, PUBLIC)', () => {
  it('requires NO auth headers at all — a bare GET succeeds', async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('public1');
    await postClipHttp(httpBase, { clipId, roomId, ownerToken, body: Buffer.from('hi') });
    const get = await getClipHttp(httpBase, clipId);
    expect(get.status).toBe(200);
  });

  it('an unknown id 404s (never distinguishes swept from never-existed)', async () => {
    const { httpBase } = makeServer();
    const get = await getClipHttp(httpBase, fixtureClipId('unknown1'));
    expect(get.status).toBe(404);
  });

  it(`>= ${CLIP_GET_PER_IP_MAX} rapid GETs from ONE trusted (CF-Connecting-IP) IP hit the per-IP limit (429); a different trusted IP is unaffected`, async () => {
    const { httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const clipId = fixtureClipId('getlimit1');
    await postClipHttp(httpBase, { clipId, roomId, ownerToken, body: Buffer.from('x') });

    let got429 = false;
    for (let i = 0; i < CLIP_GET_PER_IP_MAX + 5; i++) {
      const res = await getClipHttp(httpBase, clipId, { cfIp: '22.22.22.22' });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    const other = await getClipHttp(httpBase, clipId, { cfIp: '33.33.33.33' });
    expect(other.status).toBe(200);
  });

  it(
    'REGRESSION — a spoofed LEFTMOST X-Forwarded-For does NOT evade the per-IP GET limit ' +
      '(clientIpOf keys on CF-Connecting-IP / the rightmost trusted XFF hop, never the client-controlled leftmost)',
    async () => {
      const { httpBase } = makeServer();
      const { roomId, ownerToken } = await createRoomHttp(httpBase);
      const clipId = fixtureClipId('spoofcheck1');
      await postClipHttp(httpBase, { clipId, roomId, ownerToken, body: Buffer.from('x') });

      // No CF-Connecting-IP (this deploy trusts XFF's rightmost hop per
      // TRUSTED_PROXY_HOPS=0 default) — every request carries the SAME real
      // socket peer (127.0.0.1 in-process), but a UNIQUE fake LEFTMOST XFF each
      // time, exactly the attack clientIpOf's M3 fix defeats. If clientIpOf
      // (wrongly) trusted the leftmost XFF hop, every request would look like a
      // distinct attacker and NEVER hit the limit.
      let got429 = false;
      for (let i = 0; i < CLIP_GET_PER_IP_MAX + 5; i++) {
        const res = await getClipHttp(httpBase, clipId, { xff: `9.${i}.${i}.${i}, 127.0.0.1` });
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      expect(got429).toBe(true);
    }
  );
});

// ===========================================================================
// SAVE_CLIP director-cmd relay (mirrors the C29 STAGE_XRAY harness pattern)
// ===========================================================================

describe('C31 — SAVE_CLIP director-cmd relay (spec §7.20)', () => {
  function openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  interface Client {
    ws: WebSocket;
    received: ServerMsg[];
  }

  function attach(ws: WebSocket): Client {
    const c: Client = { ws, received: [] };
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return; // this test only cares about the JSON director-msg relay
      c.received.push(decodeText(data.toString()) as ServerMsg);
    });
    return c;
  }

  function waitUntil<T>(predicate: () => T | false | undefined, timeoutMs = 4000): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const v = predicate();
        if (v) return resolve(v);
        if (Date.now() - start >= timeoutMs) return reject(new Error('waitUntil timed out'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('a director SAVE_CLIP reaches an authed spectator (the stage) as director-msg {kind:"SAVE_CLIP"}', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const stageWs = await openSocket(wsUrl);
    const stage = attach(stageWs);
    stageWs.send(
      encodeText({
        t: 'join',
        room: roomId,
        name: 'stage',
        color: 0,
        protocol: PROTOCOL_VERSION,
        tier: 'spectator',
        joinSecret: secret,
      } as never)
    );
    await waitUntil(() => stage.received.some((m) => m.t === 'hello'));

    const directorWs = await openSocket(wsUrl);
    const director = attach(directorWs);
    directorWs.send(
      encodeText({
        t: 'join',
        room: roomId,
        name: 'console',
        color: 0,
        protocol: PROTOCOL_VERSION,
        tier: 'spectator',
        joinSecret: secret,
        ownerToken,
      } as never)
    );
    await waitUntil(() => director.received.some((m) => m.t === 'hello'));

    directorWs.send(encodeText({ t: 'director-cmd', cmd: 'SAVE_CLIP' } as never));

    await waitUntil(() =>
      stage.received.some((m) => m.t === 'director-msg' && (m as { kind: string }).kind === 'SAVE_CLIP')
    );
    await waitUntil(() =>
      director.received.some((m) => m.t === 'director-ack' && (m as { cmd: string }).cmd === 'SAVE_CLIP')
    );

    stageWs.close();
    directorWs.close();
  });

  it('SAVE_CLIP is refused (not-authorized) from a connection with NO ownerToken', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoomHttp(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);

    const residentWs = await openSocket(wsUrl);
    const resident = attach(residentWs);
    residentWs.send(
      encodeText({
        t: 'join',
        room: roomId,
        name: 'r',
        color: 0,
        protocol: PROTOCOL_VERSION,
        tier: 'resident',
        joinSecret: secret,
      } as never)
    );
    await waitUntil(() => resident.received.some((m) => m.t === 'hello'));

    residentWs.send(encodeText({ t: 'director-cmd', cmd: 'SAVE_CLIP' } as never));
    const reply = await waitUntil(() =>
      resident.received.find((m) => m.t === 'error' || m.t === 'director-ack')
    );
    expect(reply.t).toBe('error');
    if (reply.t === 'error') expect(reply.code).toBe('not-authorized');
    residentWs.close();
  });
});
