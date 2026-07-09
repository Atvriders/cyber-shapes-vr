/**
 * index.ts — WebSocket server entry point (Task B3).
 *
 * startServer(port) creates an HTTP server with /healthz + a WebSocketServer
 * sharing the same port. Manages per-room sim loops.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg, TimerApi } from '@cyber-shapes/shared';
import { RoomManager } from './roomManager.js';
import { RoomPersistence } from './persistence.js';
import { handleConnection, makeConnectionHub, MAX_PAYLOAD_BYTES } from './connection.js';
import type { ConnectionHub } from './connection.js';
import { RoomAuthStore, ROTATE_LINK_MOVED_PAGE, ROOM_TTL_MS } from './auth.js';
import { initBuckets } from './bucket-store.js';
import { makeMetrics } from './metrics.js';
import {
  makePreflightHandler,
  makeLanCheck,
  makeTunnelCheck,
  makeCertCheck,
  makeWsRttCheck,
  makeAutoplayCheck,
  makeMicSpeakerCheck,
  makeStageWatchdogCheck,
  makeHeadsetBatteryCheck,
  isLanOrLoopback,
} from './preflight.js';
import type { PreflightCheckers, PreflightCache, PreflightRateLimiter } from './preflight.js';
import {
  ClipStore,
  CLIP_MAX_BYTES,
  readBodyCapped,
  firstHeaderValue,
  PayloadTooLargeError,
  clipExtForContentType,
} from './clips.js';

export { ServerWorld } from './serverWorld.js';
export type { ServerWorldOpts } from './serverWorld.js';
export { Room } from './room.js';
export { RoomManager } from './roomManager.js';
export { RoomPersistence } from './persistence.js';
export { RoomAuthStore } from './auth.js';
export { ClipStore } from './clips.js';

// ---------------------------------------------------------------------------
// Sim loop constants
// ---------------------------------------------------------------------------

/** Physics tick interval (ms). 30 Hz. */
const TICK_MS = 1000 / 30;

/** Broadcast every N ticks (~15 Hz) — the resident/spectator full rate. */
const BROADCAST_EVERY = 2;

/**
 * Task C2 (spec §5.1): wisps receive ONE shared coalesced state summary at
 * ~5 Hz. 30 Hz / 6 = 5 Hz — every 6th physics tick the sim loop serializes the
 * coalesced buffer ONCE and sends the same payload to every wisp in the room.
 */
const WISP_COALESCE_EVERY = 6;

/** Task C18: broadcast MUSIC_CLOCK ~1 Hz (30 Hz / 30). */
const MUSIC_CLOCK_EVERY = 30;

/**
 * Task C25 (F14 The Gallery): broadcast AUDIENCE_STATE {viewerCount} at 0.2 Hz
 * (spec §5.2 row 0x32). 30 Hz / 150 = 0.2 Hz — every 150th tick the sim loop
 * samples the audience roster, fans out the counter, and records peakWatchers.
 */
const AUDIENCE_STATE_EVERY = 150;
/**
 * Task C25: re-serialize the cached audience late-join keyframe every ~10 s (spec
 * §7.14 "the recorder's most recent ~10 s keyframe"). 30 Hz × 10 s = 300 ticks.
 * This is the ONLY place the keyframe is serialized — a join-burst reuses it
 * (zero fresh serializations per late-joiner).
 */
const AUDIENCE_KEYFRAME_EVERY = 300;

/**
 * Task C2: reduce a full-rate `state` delta to the wisp coalesced summary — a
 * position-only ("head-only") view of moving shapes (spec §5.1: decimated 5 Hz
 * coalesced deltas). No rotation/velocity payload; wisps do not interpolate the
 * world at full fidelity. Serialized ONCE by broadcastCoalescedToWisps.
 */
function coalesceForWisps(state: ServerMsg & { t: 'state' }): ServerMsg {
  return {
    t: 'wisp-coalesced',
    tick: state.serverTick,
    shapes: state.shapes.map((s) => ({ id: s.id, p: s.p })),
  };
}

/** Dependencies a single sim-tick needs (the room manager + per-server hub + metrics). */
export interface SimTickDeps {
  manager: RoomManager;
  hub: ConnectionHub;
  metrics: ReturnType<typeof makeMetrics>;
}

/**
 * Task C22: ONE physics-tick of a room's sim loop, extracted verbatim from
 * startSimLoop's setInterval body so the deterministic 30-minute soak harness
 * (test/soak.test.ts) can drive the PRODUCTION tick path manually with an injected
 * clock — never a copy that could drift from production. `tickCount` is the
 * post-increment tick number (every `% CADENCE` gate keys on it). A no-op when the
 * room is gone.
 */
export function runSimTick(roomId: string, tickCount: number, deps: SimTickDeps): void {
  const { manager, hub, metrics } = deps;
  const room = manager.get(roomId);
  if (!room) return;
  // Step the sim under the room's EFFECTIVE PhysicsParams (base+overlay host merge).
  const params = hub.getHost(roomId)?.effectiveParams();
  // C17: titan-scoped OOB recall BEFORE the physics step.
  hub.getTitan(roomId)?.recallOutOfBounds();
  // C32: telekinesis pull loop force BEFORE the physics step.
  hub.tickPowersLab(roomId, TICK_MS / 1000);
  const events = room.tick(TICK_MS / 1000, params);
  // C16: auto-arm + advance the Meteor Siege AFTER the physics step.
  hub.maybeAutoArmSiege(roomId);
  hub.getSiege(roomId)?.tick(TICK_MS / 1000);
  // C28: drive the daemon crew AFTER the physics step.
  hub.getDaemonCrew(roomId)?.tick(TICK_MS / 1000);
  // C18/C19: Resonora + Encore siblings.
  const conductor = hub.getConductor(roomId);
  const encore = hub.getEncore(roomId);
  if (conductor || encore) {
    const impacts = room.lastImpacts();
    if (conductor) {
      if (impacts.length > 0) conductor.onImpacts(impacts);
      if (tickCount % MUSIC_CLOCK_EVERY === 0) conductor.tickClock();
    }
    hub.maybeAutoArmEncore(roomId);
    if (encore && encore.active) {
      const orbId = encore.orbId;
      if (orbId) {
        for (const im of impacts) {
          if (im.shapeId === orbId) {
            encore.notifyImpact(orbId);
            break;
          }
        }
      }
      encore.publishCharge();
    }
  }
  // C26: feed the caster this tick's impacts + the live showpiece flag.
  const caster = hub.getCaster(roomId);
  if (caster) {
    for (const im of room.lastImpacts()) {
      caster.onEvent({ kind: 'impact', id: im.shapeId, speed: im.impactSpeed });
    }
    const siege = hub.getSiege(roomId);
    caster.setShowpieceActive(!!(siege?.active || encore?.active), siege?.topDefender() ?? undefined);
    caster.tick();
  }
  // C12: drain the server-wide glyph-inflow overflow queue.
  hub.drainGlyphs();
  // Discrete events broadcast immediately; only `state` is BROADCAST_EVERY-throttled.
  for (const evt of events) {
    if (evt.t !== 'state') {
      hub.broadcastToRoom(roomId, evt);
    }
  }
  const stateEvt = events.find((e): e is ServerMsg & { t: 'state' } => e.t === 'state');
  if (tickCount % BROADCAST_EVERY === 0 && stateEvt) {
    hub.broadcastToRoom(roomId, stateEvt);
  }
  // C2/C25: the once-serialized 5 Hz coalesced buffer feeds wisps AND audience.
  if (
    tickCount % WISP_COALESCE_EVERY === 0 &&
    stateEvt &&
    (hub.hasWisps(roomId) || hub.hasAudience(roomId))
  ) {
    hub.broadcastCoalescedToWisps(roomId, coalesceForWisps(stateEvt));
  }
  // C25: the remote-audience drivers — only paid for while the room has viewers.
  if (hub.hasAudience(roomId)) {
    if (tickCount % AUDIENCE_KEYFRAME_EVERY === 0) {
      hub.refreshAudienceKeyframe(roomId, room.worldShapes, room.serverTick);
    }
    if (tickCount % AUDIENCE_STATE_EVERY === 0) {
      hub.broadcastAudienceState(roomId);
      metrics.gauge('peakWatchers', hub.audienceCount(roomId));
    }
  }
}

/**
 * Hard cap on concurrent WebSocket connections per server (finding #6). Beyond
 * this, a new socket is rejected (error + close) before it can join a room.
 * MAX_ROOMS × MAX_PLAYERS is the theoretical live-player ceiling; this is a
 * looser socket-count backstop against a connection flood.
 */
const MAX_CONNECTIONS = 2000;

// ---------------------------------------------------------------------------
// Task C4 — HTTP auth surface (POST /api/rooms + the retired-room status page)
// ---------------------------------------------------------------------------

/**
 * Number of TRUSTED reverse-proxy hops in FRONT of this server (env override).
 * `0` (default, the Cloudflare-Tunnel deploy) means the RIGHTMOST `X-Forwarded-For`
 * entry is the one the trusted edge itself appended — i.e. the real client. Bump
 * it only if additional trusted proxies sit between the edge and this process.
 */
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env['TRUSTED_PROXY_HOPS'] ?? 0) || 0);

/**
 * C24 audit (MF2): whether to trust the inbound `CF-Connecting-IP` header at rung 1.
 * DEFAULT `true` — the historical behaviour (a genuine Cloudflare-Tunnel deploy
 * where the edge authoritatively OVERWRITES any client-supplied value, so the
 * header is forge-proof for tunnel traffic). Set `TRUST_CF_CONNECTING_IP=false`
 * on any deploy where `CF-Connecting-IP` is NOT set by a trusted edge and could be
 * client-forged — the LAN deploy (no Cloudflare at all; nginx-lan.conf strips it),
 * OR a Cloudflare deploy whose origin port is ALSO reachable direct (bypassing the
 * tunnel). With it disabled, keying falls to the nginx-appended `X-Forwarded-For`
 * hop (rung 2) / the socket peer (rung 3), which those nginx configs make
 * un-spoofable via `$proxy_add_x_forwarded_for`. Read at call-time so a deploy's
 * env (and the unit test) takes effect without re-import; the path is per-request
 * (never per-frame), so the env read is negligible.
 */
function trustCfConnectingIp(): boolean {
  return process.env['TRUST_CF_CONNECTING_IP'] !== 'false';
}

/**
 * Extract the client IP for EVERY per-IP limiter (the room-create limiter, the
 * C25 audience concurrency cap, and the C25 keyframe-throttle bucket all key on
 * this — so the derivation must be centralized here and SPOOF-RESISTANT).
 *
 * C25 review finding M3: the previous "trust the LEFTMOST X-Forwarded-For entry"
 * was client-controllable — a real proxy APPENDS the true client IP to the RIGHT,
 * so the leftmost value is whatever the client sent. A unique fake leftmost XFF
 * per handshake trivially evaded every per-IP limiter. The trusted-source order:
 *
 *   1. `CF-Connecting-IP` — Cloudflare sets this to the true client IP and, on a
 *      request that arrives THROUGH the tunnel, OVERWRITES any client-supplied
 *      value. It is the one header a public `?watch` viewer cannot forge — SO LONG
 *      AS the request truly transits Cloudflare. C24 audit (MF2): this rung is
 *      GATED by `trustCfConnectingIp()` — deploys where the header is NOT edge-set
 *      (LAN, or a Cloudflare origin also reachable direct) set `TRUST_CF_CONNECTING_IP=false`
 *      so a client-forged `CF-Connecting-IP` can NEVER key rung 1; keying then falls
 *      to the nginx-appended XFF hop (rung 2). The shipped nginx configs ALSO strip
 *      the inbound header, so this is defence-in-depth.
 *   2. else the `X-Forwarded-For` hop the TRUSTED edge appended — the entry at
 *      `len - 1 - TRUSTED_PROXY_HOPS` from the right (NOT the spoofable leftmost).
 *      The shipped nginx (`$proxy_add_x_forwarded_for`) appends the REAL peer to the
 *      RIGHT, so a client-forged leftmost XFF is ignored. `TRUSTED_PROXY_HOPS` must
 *      equal the number of trusted proxies that appended AFTER the true-client entry
 *      (LAN: 0 — nginx is the sole hop; tunnel-with-strip: 1 — nginx is one hop in
 *      front of the CF-appended client entry).
 *   3. else the socket `remoteAddress` — a direct connection with no XFF: the real
 *      peer address.
 */
export function clientIpOf(req: IncomingMessage): string {
  // (1) Cloudflare Tunnel — the un-spoofable true client IP (only when the edge
  //     is trusted to set it; see trustCfConnectingIp / TRUST_CF_CONNECTING_IP).
  const cf = req.headers['cf-connecting-ip'];
  if (trustCfConnectingIp() && typeof cf === 'string' && cf.length > 0) {
    const v = cf.trim();
    if (v) return normalizeIp(v);
  }
  // (2) A trusted reverse proxy that APPENDS the client to XFF → the RIGHTMOST hop
  //     (after skipping TRUSTED_PROXY_HOPS additional trusted proxies). The
  //     leftmost entries are client-controllable and are NEVER trusted for keying.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 0) {
      const idx = Math.max(0, parts.length - 1 - TRUSTED_PROXY_HOPS);
      const hop = parts[idx];
      if (hop) return normalizeIp(hop);
    }
  }
  // (3) Direct connection (LAN mode / no proxy) — the real socket peer address.
  return normalizeIp(req.socket.remoteAddress ?? 'unknown');
}

/**
 * Collapse an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) to its IPv4 form so
 * the per-IP limiters key consistently regardless of the socket family (a
 * loopback ws connection reports the mapped form; XFF carries the bare IPv4).
 */
function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/**
 * Default preflight checkers for production. LAN/tunnel URLs come from env;
 * cert days and WS RTT are stubbed at 'warn' until C22 wires real measurement.
 * Task C23: stage-watchdog + headset-battery are ALWAYS manual prompts (no
 * server-observable signal exists for either — see their doc comments in
 * preflight.ts); they default to 'warn' just like autoplay/mic-speaker.
 * Inject replacements via opts.preflightCheckers in startServer for tests.
 */
function makeDefaultPreflightCheckers(): PreflightCheckers {
  const lanUrl = process.env['LAN_URL'] ?? 'http://192.168.1.1/';
  const tunnelUrl = process.env['TUNNEL_URL'] ?? 'https://example.cloudflare.com/healthz';
  return {
    'lan-reach': makeLanCheck(lanUrl),
    'tunnel-reach': makeTunnelCheck(tunnelUrl),
    'cert-days': makeCertCheck(Number(process.env['CERT_DAYS_REMAINING'] ?? 30)),
    'ws-rtt': makeWsRttCheck(Number(process.env['WS_RTT_MS'] ?? 20)),
    'autoplay': makeAutoplayCheck(),
    'mic-speaker': makeMicSpeakerCheck(),
    'stage-watchdog': makeStageWatchdogCheck(),
    'headset-battery': makeHeadsetBatteryCheck(),
  };
}

/** Route + serve the HTTP surface (health + Task C4 auth + Task C31 clip endpoints). */
async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  authStore: RoomAuthStore,
  preflightHandler: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>,
  clipStore: ClipStore,
  metrics: ReturnType<typeof makeMetrics>,
  clipMaxBytes: number,
  staffKey: string | undefined
): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // GET /api/preflight — booth preflight check (Task C8).
  // Auth-gated: LAN/loopback-source OR Bearer staff-key; cached 30 s; rate-limited.
  if (path === '/api/preflight' && req.method === 'GET') {
    await preflightHandler(req, res);
    return;
  }

  // GET /api/metrics/day — Task C23: the Closing Ceremony's day-counters export
  // (the RUNBOOK previously promised this endpoint "planned: C22" and it never
  // landed — this closes that gap). `metrics.exportDay()` is a PURE read (never
  // mutates; `resetDay()` is a separate, deliberate day-close step still taken by
  // an operator with process access — see RUNBOOK/CLOSING_CEREMONY). Counters are
  // PII-free by construction (metrics.ts docstring), but the endpoint is still
  // gated the SAME way as /api/preflight (LAN/loopback source OR Bearer staff-key)
  // to keep operational numbers off the public internet.
  if (path === '/api/metrics/day' && req.method === 'GET') {
    const ip = clientIpOf(req);
    if (!isLanOrLoopback(ip)) {
      const authHeader = req.headers['authorization'];
      const token =
        typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
      if (!staffKey || token !== staffKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics.exportDay()));
    return;
  }

  // POST /api/rooms → {roomId, ownerToken} (spec §5.4).
  if (path === '/api/rooms' && req.method === 'POST') {
    const ip = clientIpOf(req);
    const result = await authStore.createRoom(ip);
    if ('error' in result) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/rooms/:id/status → for a RETIRED (ROTATE_LINK'd) id, the static
  // "moved — check the club Discord" page that NEVER discloses the new roomId.
  const statusMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{1,80})\/status$/.exec(path);
  if (statusMatch && req.method === 'GET') {
    const roomId = statusMatch[1]!;
    if (authStore.isRetired(roomId)) {
      res.writeHead(410, { 'Content-Type': 'text/plain' });
      res.end(ROTATE_LINK_MOVED_PAGE);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roomId, retired: false }));
    return;
  }

  // POST /api/clips → store a finished highlight clip (spec §7.20, Task C31).
  // ownerToken / roomId / clipId ride HEADERS — never a URL (the C4 treatment).
  if (path === '/api/clips' && req.method === 'POST') {
    const ip = clientIpOf(req);
    const clipId = firstHeaderValue(req.headers['x-clip-id']) ?? '';
    const roomId = firstHeaderValue(req.headers['x-room-id']) ?? '';
    const ownerToken = firstHeaderValue(req.headers['x-owner-token']);
    const contentType = firstHeaderValue(req.headers['content-type']) ?? 'application/octet-stream';

    // MUST-FIX 2 (unauth POST flood / memory-DoS): enforce AND record the per-IP
    // POST limit HERE — BEFORE readBodyCapped buffers up to 25 MB and BEFORE the
    // ownerToken check. Every POST attempt (authed or NOT) counts toward the
    // per-IP limit, so a tokenless flood is throttled up front (previously the
    // limiter sat AFTER the 401 and only recorded on SUCCESS, so a tokenless IP
    // was never recorded and never throttled — 25 MB × N unthrottled bodies).
    // The ownerToken 401 + the 25 MB streaming cap remain the subsequent checks.
    if (clipStore.registerPostAttempt(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate-limited' }));
      return;
    }

    let body: Buffer;
    try {
      body = await readBodyCapped(req, clipMaxBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Drain (never destroy) the rest of the oversized upload so the CLIENT's
        // write completes cleanly and it actually receives this response instead
        // of an ECONNRESET race — readBodyCapped already stopped BUFFERING past
        // the cap (bounded memory); resuming here only discards bytes already
        // in flight, it never re-enters the size accounting.
        req.resume();
        req.on('data', () => {
          /* discard — readBodyCapped already stopped collecting */
        });
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too-large' }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad-body' }));
      return;
    }

    const result = await clipStore.putClip({
      ip,
      clipId,
      roomId,
      ownerToken,
      verifyOwnerToken: (r, t) => authStore.verifyOwnerToken(r, t),
      contentType,
      body,
      // The per-IP POST hit was already checked + recorded above (pre-auth), so
      // putClip must not re-count it (one HTTP POST → one per-IP hit).
      ipAlreadyCounted: true,
    });
    if ('error' in result) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clipId: result.clipId }));
    return;
  }

  // GET /api/clips/:id → PUBLIC retrieval (the burned-in QR end-slate IS this
  // URL, spec §7.20). clipId must already look like the 128-bit hex shape —
  // anything else 404s exactly like a swept/unknown id (no enumeration oracle).
  // Mirrors CLIP_ID_RE (clips.ts) EXACTLY (32 hex chars — the client mints exactly
  // that) — a path-level pre-filter, never a second source of truth (the store
  // re-derives nothing from this match).
  const clipsGetMatch = /^\/api\/clips\/([0-9a-f]{32})$/.exec(path);
  if (clipsGetMatch && req.method === 'GET') {
    const clipId = clipsGetMatch[1]!;
    const ip = clientIpOf(req);
    const result = await clipStore.getClip({ ip, clipId });
    if ('error' in result) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    metrics.count('clip'); // §11 "clips delivered" — counted on DELIVERY, not save.
    // MUST-FIX 1 (stored XSS): a FORCED-SAFE header set, independent of anything
    // the uploader supplied. `result.contentType` is already coerced to the
    // allowlist (or application/octet-stream) at store time, but we ALSO:
    //   • X-Content-Type-Options: nosniff — the browser must NEVER sniff the body
    //     into an active type (an octet-stream blob of `<script>` stays inert).
    //   • Content-Disposition: attachment — the response is a DOWNLOAD, never a
    //     navigable HTML document on the app's own (shared-tunnel) origin.
    //   • Content-Security-Policy: sandbox — belt-and-suspenders; even if somehow
    //     rendered, scripts/same-origin are denied.
    const ext = clipExtForContentType(result.contentType);
    res.writeHead(200, {
      'Content-Type': result.contentType,
      'Content-Length': String(result.body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="clip-${clipId}.${ext}"`,
      'Content-Security-Policy': 'sandbox',
    });
    res.end(result.body);
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

/**
 * An in-memory fs pair for the auth store when no DATA_DIR is configured (single
 * process, never restarts). Keeps createRoom/rotate working without touching disk.
 */
function makeMemAuthFs(): {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    async readFile(path: string): Promise<string> {
      const v = store.get(path);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(path: string, data: string): Promise<void> {
      store.set(path, data);
    },
  };
}

/**
 * An in-memory fs triple for the clip store when no DATA_DIR is configured
 * (Task C31). Mirrors {@link makeMemAuthFs} — without this, the store's real-fs
 * default would try to `mkdir`/write under the literal path `/mem`, which fails
 * (or worse, writes to real disk) on every process that has no DATA_DIR set.
 */
function makeMemClipFs(): {
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
} {
  const store = new Map<string, Buffer>();
  return {
    async readFile(path: string): Promise<Buffer> {
      const v = store.get(path);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(path: string, data: Buffer): Promise<void> {
      store.set(path, data);
    },
    async deleteFile(path: string): Promise<void> {
      store.delete(path);
    },
  };
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export interface ServerHandle {
  /** Actual bound port (useful when started on port 0). */
  port: number;
  /** Graceful shutdown: close new connections, drain existing ones. */
  close(): Promise<void>;
  /**
   * Task C4: the room auth store (room creation + staff auth + incident controls).
   * Exposed for tests + operational tooling (the runbook's TTL/eviction check).
   */
  authStore: RoomAuthStore;
  /**
   * Task C31: the clip store (F20 Neon Clip Machine security surface). Exposed
   * for tests + operational tooling (the runbook's day-close sweep).
   */
  clipStore: ClipStore;
}

/**
 * Finding #4: top-level backstop so a stray throw / rejected promise anywhere
 * in the process logs and is swallowed rather than killing Node (which would
 * take down EVERY room). Installed once, idempotently (multiple startServer()
 * calls in one process — e.g. tests — do not stack duplicate listeners).
 */
let _crashGuardsInstalled = false;
export function installProcessCrashGuards(): void {
  if (_crashGuardsInstalled) return;
  _crashGuardsInstalled = true;
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException (kept alive):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection (kept alive):', reason);
  });
}

/** Options for startServer (Task C2 / C4). */
export interface StartServerOpts {
  /**
   * DEPRECATED provisional join secret (Task C2). Task C4 rebinds tier auth to a
   * per-room ownerToken-derived HMAC (the RoomAuthStore). When `staffKey` is set
   * it is honored as a GLOBAL fallback secret alongside the HMAC path (so a
   * C2-era test still passes); the HMAC join secret is the real gate.
   */
  staffKey?: string;
  /** Injected timers for the idle-kick (tests pass a controllable fake). */
  timerApi?: TimerApi;
  /**
   * Task C4: data directory for auth persistence (token hash + epoch beside the
   * room file). Defaults to `process.env.DATA_DIR`. When unset, auth records live
   * in-memory only (fine for a single-process test that never restarts).
   */
  dataDir?: string;
  /** Task C4: injected clock for the auth store's TTL/backoff (tests). */
  authNow?: () => number;
  /**
   * Task C8: injected preflight checkers (for integration tests that want to
   * assert on the /api/preflight endpoint without real network calls).
   * Defaults to makeDefaultPreflightCheckers() in production.
   */
  preflightCheckers?: PreflightCheckers;
  /**
   * Task C8 security: injected preflight result cache (tests inject a
   * makePreflightCache with a controllable clock to assert cache-hit behaviour).
   */
  preflightCache?: PreflightCache;
  /**
   * Task C8 security: injected preflight rate limiter (tests inject to assert
   * burst-throttle behaviour without needing real wall-clock advances).
   */
  preflightRateLimiter?: PreflightRateLimiter;
  /** Task C31: injected clock for the clip store's TTL/rate-limit windows (tests). */
  clipNow?: () => number;
  /**
   * Task C31: override the clip store's per-clip byte cap. Defaults to the spec
   * ~25 MB (`CLIP_MAX_BYTES`) in production; tests lower it to exercise the
   * real streaming-reject path (readBodyCapped) without uploading 25 MB.
   */
  clipMaxBytes?: number;
}

export function startServer(port: number, opts: StartServerOpts = {}): ServerHandle {
  installProcessCrashGuards();
  // Only enable persistence when DATA_DIR is explicitly set (avoids shared ./data in tests)
  const dataDir = opts.dataDir ?? process.env['DATA_DIR'];
  const persistence = dataDir ? new RoomPersistence({ dir: dataDir }) : null;
  const manager = new RoomManager(persistence);

  // Task C10: initialise the persistence buckets so the Showrunner's STATS_CARD
  // day-leaderboard (getBucket('dayStats')) resolves. When no DATA_DIR is set the
  // buckets live in-memory (single-process; the day leaderboard is empty but the
  // card still renders). Idempotent per process — safe across test servers.
  if (dataDir) initBuckets({ dir: dataDir });

  // Task C8/C12: the per-server anonymous metrics store (counters only, no PII —
  // §11). count('join')/count('glyph')/count('rotation') flow through here.
  const metrics = makeMetrics();

  const staffKey = opts.staffKey ?? process.env['STAFF_KEY'];
  const timerApi = opts.timerApi;
  const preflightCheckers = opts.preflightCheckers ?? makeDefaultPreflightCheckers();

  // Task C8 security — build the auth-gated, cached, rate-limited preflight handler.
  // C24 audit (CRITICAL): thread the shared `clientIpOf` so the LAN/staff gate keys
  // on the REAL caller IP (CF-Connecting-IP → rightmost trusted XFF hop → socket),
  // NOT the nginx `/api/` proxy's bridge peer — EXACTLY as GET /api/metrics/day does.
  const preflightHandler = makePreflightHandler({
    checkers: preflightCheckers,
    staffKey,
    ipOf: (req) => clientIpOf(req as unknown as IncomingMessage),
    ...(opts.preflightCache ? { cache: opts.preflightCache } : {}),
    ...(opts.preflightRateLimiter ? { rateLimiter: opts.preflightRateLimiter } : {}),
  });

  // Task C4 — the room auth store. When a DATA_DIR is configured, auth records
  // (token hash + epoch) persist beside the room file and survive restart; with
  // no data dir they live in-memory (a single-process test that never restarts).
  const authNow = opts.authNow ?? (() => Date.now());
  const authStore = dataDir
    ? new RoomAuthStore({ now: authNow, dir: dataDir })
    : new RoomAuthStore({
        now: authNow,
        dir: '/mem',
        // In-memory fs so createRoom/rotate work with no disk (tests / LAN dev).
        ...makeMemAuthFs(),
      });

  // Task C31 — the clip store (F20 Neon Clip Machine, spec §7.20). Blobs persist
  // to <dataDir>/clips when a DATA_DIR is configured; with none they live
  // in-memory only (fine for a single-process test / LAN dev that never restarts
  // — matches the authStore fallback shape immediately above).
  const clipNow = opts.clipNow ?? (() => Date.now());
  const clipMaxBytes = opts.clipMaxBytes ?? CLIP_MAX_BYTES;
  const clipStore = dataDir
    ? new ClipStore({ now: clipNow, dir: dataDir, maxBytes: clipMaxBytes })
    : new ClipStore({ now: clipNow, dir: '/mem', maxBytes: clipMaxBytes, ...makeMemClipFs() });

  // Fold-in (orphaned-blob disk leak): a STARTUP reconciliation deletes any
  // pre-restart <dataDir>/clips/*.bin blob older than the TTL. sweep() only
  // iterates the in-memory index (rebuilt empty on restart), so without this a
  // crashed/restarted process would leak every blob it wrote before dying.
  // Only meaningful with a real DATA_DIR (the in-mem fs has no stale blobs).
  if (dataDir) {
    clipStore.reconcileDisk().catch((err) => {
      console.error('[server] clip disk reconciliation failed:', err);
    });
  }

  // Per-server connection hub — isolated state; no module-level globals.
  const hub = makeConnectionHub();

  // Task C4/C31: periodically sweep expired (never-joined / long-empty) auth
  // rooms AND TTL'd clips (day-close sweep, spec §7.20). Injectable-clock stores
  // drive this from tests via authStore.sweep()/clipStore.sweep() directly; in
  // production a coarse wall-clock interval reclaims stale creation slots.
  const sweepInterval = setInterval(
    () => {
      try {
        authStore.sweep();
      } catch (err) {
        console.error('[server] auth sweep failed:', err);
      }
      try {
        clipStore.sweep();
      } catch (err) {
        console.error('[server] clip sweep failed:', err);
      }
    },
    Math.min(ROOM_TTL_MS, 5 * 60_000)
  );
  if (typeof sweepInterval.unref === 'function') sweepInterval.unref();

  // Per-room sim intervals: roomId → interval handle.
  // tickCount is tracked via the closure variable inside startSimLoop; the
  // map value is only the interval so there is one source of truth.
  const simIntervals = new Map<string, ReturnType<typeof setInterval>>();

  function startSimLoop(roomId: string): void {
    if (simIntervals.has(roomId)) return; // already running
    let tickCount = 0;
    const interval = setInterval(() => {
      const room = manager.get(roomId);
      if (!room) {
        // Room dropped (shouldn't happen normally, but guard)
        stopSimLoop(roomId);
        return;
      }
      // The full per-tick body lives in the exported runSimTick (Task C22) so the
      // deterministic soak drives the identical production path. tickCount is the
      // post-increment number the % cadence gates key on (unchanged semantics).
      tickCount++;
      runSimTick(roomId, tickCount, { manager, hub, metrics });
    }, TICK_MS);
    simIntervals.set(roomId, interval);
  }

  function stopSimLoop(roomId: string): void {
    const interval = simIntervals.get(roomId);
    if (interval !== undefined) {
      clearInterval(interval);
      simIntervals.delete(roomId);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP server with /healthz
  // ---------------------------------------------------------------------------

  const httpServer = createServer((req, res) => {
    // Fold-in robustness: an OUTER catch so a rejected handleHttp promise (e.g. a
    // guarded-but-still-throwing fs path, or any unforeseen throw) writes a clean
    // 500 and is LOGGED — never an unhandledRejection that leaves the client
    // hanging to its timeout with no response written.
    handleHttp(req, res, authStore, preflightHandler, clipStore, metrics, clipMaxBytes, staffKey).catch(
      (err) => {
        console.error('[server] handleHttp failed:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        } else {
          res.end();
        }
      }
    );
  });

  // ---------------------------------------------------------------------------
  // WebSocket server (shares the HTTP server)
  // ---------------------------------------------------------------------------

  // Finding #1: cap the max frame size so ws rejects (and closes) oversized
  // frames before they reach us — ws's default is 100 MiB, a DoS vector.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on('connection', (ws, req: IncomingMessage) => {
    // Finding #6: reject new sockets past the connection cap before any handling.
    // Use >= : the just-connected socket is ALREADY in wss.clients when this
    // fires, so `> MAX_CONNECTIONS` would admit MAX_CONNECTIONS+1 (off-by-one).
    if (wss.clients.size >= MAX_CONNECTIONS) {
      try {
        ws.send(encodeText({ t: 'error', code: 'server-full', message: 'too many connections' }));
      } catch {
        /* socket may already be gone */
      }
      ws.close(1013, 'server-full');
      return;
    }
    // Task C4: the client IP keys the failed-join backoff (per IP, roomId).
    const clientIp = clientIpOf(req);
    handleConnection(
      ws,
      manager,
      hub,
      (roomId) => startSimLoop(roomId),
      (roomId) => stopSimLoop(roomId),
      { staffKey, authStore, clientIp, metrics, ...(timerApi ? { timerApi } : {}) }
    );
  });

  // ---------------------------------------------------------------------------
  // Bind
  // ---------------------------------------------------------------------------

  httpServer.listen(port);

  // Resolve the actual bound port synchronously via address()
  const getPort = (): number => {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') return addr.port;
    return port;
  };

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------

  const handle: ServerHandle = {
    get port() {
      return getPort();
    },

    authStore,
    clipStore,

    async close(): Promise<void> {
      clearInterval(sweepInterval);
      // Stop all sim loops
      for (const [roomId] of simIntervals) {
        stopSimLoop(roomId);
      }

      // Flush pending persistence writes before closing
      if (persistence) await persistence.flush();

      // Close all WS connections and servers
      await new Promise<void>((resolve, reject) => {
        // Close all WS connections
        for (const ws of wss.clients) {
          ws.terminate();
        }

        wss.close((wsErr) => {
          if (wsErr) return reject(wsErr);
          httpServer.close((httpErr) => {
            if (httpErr) return reject(httpErr);
            resolve();
          });
        });
      });
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Entrypoint guard
// ---------------------------------------------------------------------------

// `import.meta.url` main-module check (Node ESM)
const isMain = process.argv[1]
  ? new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname
  : false;

if (isMain) {
  // Default DATA_DIR for production; keep unset in tests so persistence is skipped.
  if (!process.env['DATA_DIR']) process.env['DATA_DIR'] = './data';
  const port = Number(process.env['PORT']) || 3030;
  const handle = startServer(port);
  // Bind is synchronous on port 0, but we wait one event-loop turn for determinism
  setImmediate(() => {
    console.log(`cyber-shapes-vr server listening on port ${handle.port}`);
  });
}
