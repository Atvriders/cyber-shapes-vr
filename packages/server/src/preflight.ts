/**
 * preflight.ts — Booth preflight check handler (spec §13 operational tooling).
 *
 * Each check is an injected async function that returns a CheckResult.
 * The aggregator runs them concurrently and returns an AggregateResult.
 *
 * Exposed as:
 *   GET /api/preflight   → AggregateResult (JSON)
 *
 * Checks (all injectable for unit-testing):
 *   lan-reach      — LAN reachability (ping the booth router / known LAN host).
 *   tunnel-reach   — Cloudflare Tunnel reachability (HTTP 200 from the public URL).
 *   cert-days      — TLS certificate days remaining (warn < 14, fail < 3).
 *   ws-rtt         — WebSocket round-trip latency to the local server (ms).
 *   autoplay       — Browser autoplay policy (injected; real check is client-side JS).
 *   mic-speaker    — Mic / speaker access policy (injected; client-side).
 *   stage-watchdog — Task C23: the stage kiosk's render-stall watchdog (spec §7.1,
 *                    `RENDER_STALL_MS`/`HEALTH_CHECK_INTERVAL_MS` in
 *                    `packages/client/src/stage/stage.ts`) is a CLIENT-side timer —
 *                    there is no server-observable signal for "is the stage tab
 *                    currently alive and rendering". This check is ALWAYS a manual
 *                    prompt (never auto-passed) unless the caller explicitly
 *                    injects 'ok' after physically confirming the stage screen.
 *   headset-battery — Task C23: a booth-day reminder. No browser/WebXR API exposes
 *                    Quest headset battery level to a web page, so this is ALWAYS a
 *                    manual prompt — staff physically checks both headsets.
 *
 * The LAN/tunnel mode flag:
 *   - If lan-reach passes AND tunnel-reach fails → mode: 'lan'
 *   - If tunnel-reach passes → mode: 'tunnel'
 *   - Both fail → mode: 'offline'
 *   - Both pass → mode: 'both'
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  /** Optional numeric detail (cert days, RTT ms, etc.). */
  value?: number;
}

export type ConnectivityMode = 'lan' | 'tunnel' | 'both' | 'offline';

export interface AggregateResult {
  /** ISO timestamp of the check run. */
  timestamp: string;
  /** Overall status: worst of all individual check statuses. */
  overall: CheckStatus;
  /** LAN/tunnel connectivity mode. */
  mode: ConnectivityMode;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Individual check functions (injectable)
// ---------------------------------------------------------------------------

/** A check function: returns a CheckResult for its domain. */
export type CheckFn = () => Promise<CheckResult>;

/**
 * Default LAN reachability check.
 * Attempts to resolve/reach a known LAN address. Skipped/stubbed here
 * (real check runs in a deployed context — this default always returns ok
 * so the preflight page can still load in a dev environment without a LAN).
 *
 * Production: replace via the injected checkers map.
 */
export function makeLanCheck(lanUrl: string, fetchFn?: typeof fetch): CheckFn {
  return async (): Promise<CheckResult> => {
    const f = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) {
      return { name: 'lan-reach', status: 'warn', message: 'fetch unavailable in this environment' };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await f(lanUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok
        ? { name: 'lan-reach', status: 'ok', message: `LAN reachable (${res.status})` }
        : { name: 'lan-reach', status: 'warn', message: `LAN returned ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: 'lan-reach', status: 'fail', message: `LAN unreachable: ${msg}` };
    }
  };
}

export function makeTunnelCheck(tunnelUrl: string, fetchFn?: typeof fetch): CheckFn {
  return async (): Promise<CheckResult> => {
    const f = fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) {
      return { name: 'tunnel-reach', status: 'warn', message: 'fetch unavailable in this environment' };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await f(tunnelUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok
        ? { name: 'tunnel-reach', status: 'ok', message: `tunnel reachable (${res.status})` }
        : { name: 'tunnel-reach', status: 'warn', message: `tunnel returned ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: 'tunnel-reach', status: 'fail', message: `tunnel unreachable: ${msg}` };
    }
  };
}

export function makeCertCheck(certDaysRemaining: number): CheckFn {
  return async (): Promise<CheckResult> => {
    const days = certDaysRemaining;
    if (days < 3) {
      return { name: 'cert-days', status: 'fail', message: `cert expires in ${days}d`, value: days };
    }
    if (days < 14) {
      return { name: 'cert-days', status: 'warn', message: `cert expires in ${days}d (renew soon)`, value: days };
    }
    return { name: 'cert-days', status: 'ok', message: `cert valid ${days}d`, value: days };
  };
}

export function makeWsRttCheck(rttMs: number): CheckFn {
  return async (): Promise<CheckResult> => {
    if (rttMs < 0) {
      return { name: 'ws-rtt', status: 'fail', message: 'WS RTT measurement failed', value: rttMs };
    }
    if (rttMs > 300) {
      return { name: 'ws-rtt', status: 'warn', message: `WS RTT high: ${rttMs}ms`, value: rttMs };
    }
    return { name: 'ws-rtt', status: 'ok', message: `WS RTT ${rttMs}ms`, value: rttMs };
  };
}

/**
 * Autoplay and mic/speaker checks are CLIENT-SIDE (browser policy).
 * The server receives the result injected from the client (or stubs it).
 * These stubs default to 'warn' so the page flags them as "check in browser".
 */
export function makeAutoplayCheck(status: CheckStatus = 'warn'): CheckFn {
  return async (): Promise<CheckResult> => ({
    name: 'autoplay',
    status,
    message: status === 'ok' ? 'autoplay allowed' : 'autoplay policy unknown (check in browser)',
  });
}

export function makeMicSpeakerCheck(status: CheckStatus = 'warn'): CheckFn {
  return async (): Promise<CheckResult> => ({
    name: 'mic-speaker',
    status,
    message: status === 'ok' ? 'mic/speaker access granted' : 'mic/speaker policy unknown (check in browser)',
  });
}

/**
 * Task C23: the stage render-stall watchdog "alive" checklist item. Genuinely
 * HONEST — there is no server-observable signal for a live stage kiosk tab (the
 * watchdog lives entirely in `packages/client/src/stage/stage.ts` as a browser
 * timer: `RENDER_STALL_MS` = 10 s auto-reload-on-freeze, `HEALTH_CHECK_INTERVAL_MS`
 * = 30 s join-URL health poll). This NEVER auto-passes; `status` defaults to
 * 'warn' (a checklist prompt) and only flips to 'ok' when the CALLER explicitly
 * passes it after a staffer has physically looked at the stage screen and
 * confirmed it is rendering (not frozen / not on the auto-reload spinner).
 */
export function makeStageWatchdogCheck(status: CheckStatus = 'warn'): CheckFn {
  return async (): Promise<CheckResult> => ({
    name: 'stage-watchdog',
    status,
    message:
      status === 'ok'
        ? 'stage screen confirmed live (staff visual check)'
        : 'MANUAL CHECK: look at the stage screen — it should be rendering, not frozen (auto-reloads within 10 s if stalled; see RUNBOOK Monitoring)',
  });
}

/**
 * Task C23: the headset-battery reminder. Genuinely HONEST — no browser or WebXR
 * API exposes a Quest headset's battery level to a web page (the deprecated
 * Battery Status API, even where present, would only read the STAGE LAPTOP's
 * battery, not the headset's). This NEVER auto-passes; `status` defaults to
 * 'warn' and only flips to 'ok' when the CALLER passes it after a staffer has
 * physically confirmed both headsets are sufficiently charged.
 */
export function makeHeadsetBatteryCheck(status: CheckStatus = 'warn'): CheckFn {
  return async (): Promise<CheckResult> => ({
    name: 'headset-battery',
    status,
    message:
      status === 'ok'
        ? 'headset battery confirmed sufficient (staff physical check)'
        : 'MANUAL CHECK: confirm both A/B headsets are charged (no browser/WebXR API can read headset battery) — see RUNBOOK A/B hygiene rotation',
  });
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

export interface PreflightCheckers {
  'lan-reach': CheckFn;
  'tunnel-reach': CheckFn;
  'cert-days': CheckFn;
  'ws-rtt': CheckFn;
  'autoplay': CheckFn;
  'mic-speaker': CheckFn;
  /** Task C23: manual checklist prompt (see {@link makeStageWatchdogCheck}). */
  'stage-watchdog': CheckFn;
  /** Task C23: manual checklist prompt (see {@link makeHeadsetBatteryCheck}). */
  'headset-battery': CheckFn;
}

const STATUS_ORDER: CheckStatus[] = ['ok', 'warn', 'fail'];

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const s of statuses) {
    if (STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(worst)) {
      worst = s;
    }
  }
  return worst;
}

function connectivityMode(results: CheckResult[]): ConnectivityMode {
  const lan = results.find((r) => r.name === 'lan-reach');
  const tunnel = results.find((r) => r.name === 'tunnel-reach');
  const lanOk = lan?.status === 'ok' || lan?.status === 'warn';
  const tunnelOk = tunnel?.status === 'ok' || tunnel?.status === 'warn';
  if (lanOk && tunnelOk) return 'both';
  if (lanOk) return 'lan';
  if (tunnelOk) return 'tunnel';
  return 'offline';
}

/**
 * Run all injected checks concurrently and return an aggregate result.
 * Each check is independently guarded — a thrown exception becomes a 'fail' result.
 */
export async function runPreflight(
  checkers: PreflightCheckers,
  nowIso?: () => string
): Promise<AggregateResult> {
  const checkOrder: Array<keyof PreflightCheckers> = [
    'lan-reach',
    'tunnel-reach',
    'cert-days',
    'ws-rtt',
    'autoplay',
    'mic-speaker',
    'stage-watchdog',
    'headset-battery',
  ];

  const results = await Promise.all(
    checkOrder.map(async (key) => {
      try {
        return await checkers[key]();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { name: key, status: 'fail' as CheckStatus, message: `check threw: ${msg}` };
      }
    })
  );

  return {
    timestamp: nowIso ? nowIso() : new Date().toISOString(),
    overall: worstStatus(results.map((r) => r.status)),
    mode: connectivityMode(results),
    checks: results,
  };
}

// ---------------------------------------------------------------------------
// LAN / loopback source check (auth gate for /api/preflight)
// ---------------------------------------------------------------------------

/**
 * Returns true when `ip` is a loopback or RFC-1918 private address.
 * Used to gate /api/preflight: LAN-source callers are allowed without a key;
 * off-LAN callers must present a staff key.
 */
export function isLanOrLoopback(ip: string): boolean {
  if (!ip) return false;
  // Loopback
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  // 10.0.0.0/8
  if (/^10\./.test(ip)) return true;
  // 192.168.0.0/16
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0/12  (172.16.x.x – 172.31.x.x)
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = parseInt(m[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Result cache
// ---------------------------------------------------------------------------

/** Options for the preflight result cache. */
export interface PreflightCacheOpts {
  /** Cache TTL in ms (default 30 000). */
  ttlMs?: number;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  nowMs?: () => number;
}

/**
 * A simple one-slot cache around runPreflight. Re-uses the last result until
 * ttlMs have elapsed, so rapid callers cannot amplify outbound fetch traffic.
 */
export interface PreflightCache {
  /** Run preflight or return the cached result if still fresh. */
  get(checkers: PreflightCheckers, nowIso?: () => string): Promise<AggregateResult>;
  /** Evict the cache entry (for tests). */
  invalidate(): void;
}

export function makePreflightCache(opts: PreflightCacheOpts = {}): PreflightCache {
  const ttlMs = opts.ttlMs ?? 30_000;
  const nowMs = opts.nowMs ?? (() => Date.now());

  let cachedResult: AggregateResult | null = null;
  let cachedAt = -Infinity;

  return {
    async get(checkers: PreflightCheckers, nowIso?: () => string): Promise<AggregateResult> {
      const now = nowMs();
      if (cachedResult !== null && now - cachedAt < ttlMs) {
        return cachedResult;
      }
      const result = await runPreflight(checkers, nowIso);
      cachedResult = result;
      cachedAt = nowMs();
      return result;
    },
    invalidate(): void {
      cachedResult = null;
      cachedAt = -Infinity;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-IP rate limiter (for /api/preflight)
// ---------------------------------------------------------------------------

export interface PreflightRateLimiterOpts {
  /** Max requests per window per IP (default 5). */
  maxRequests?: number;
  /** Window duration in ms (default 30 000). */
  windowMs?: number;
  /** Injectable clock. Defaults to Date.now. */
  nowMs?: () => number;
}

export interface PreflightRateLimiter {
  /** Returns true when the IP is ALLOWED (not over limit). Returns false to reject. */
  check(ip: string): boolean;
}

export function makePreflightRateLimiter(opts: PreflightRateLimiterOpts = {}): PreflightRateLimiter {
  const maxRequests = opts.maxRequests ?? 5;
  const windowMs = opts.windowMs ?? 30_000;
  const nowMs = opts.nowMs ?? (() => Date.now());

  /** ip → { windowStart, count } */
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    check(ip: string): boolean {
      const now = nowMs();
      const entry = windows.get(ip);
      if (!entry || now - entry.windowStart >= windowMs) {
        windows.set(ip, { windowStart: now, count: 1 });
        return true;
      }
      entry.count++;
      return entry.count <= maxRequests;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler factory (wired into index.ts GET /api/preflight)
// ---------------------------------------------------------------------------

/** The subset of an http.IncomingMessage the preflight handler reads. */
export interface PreflightRequest {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

export interface PreflightHandlerOpts {
  checkers: PreflightCheckers;
  /** Injected ISO timestamp (tests). */
  nowIso?: () => string;
  /** Staff key for off-LAN callers. Required to pass auth when not on LAN. */
  staffKey?: string;
  /** Injectable cache (omit to create a default 30-s cache). */
  cache?: PreflightCache;
  /** Injectable rate limiter (omit to create a default limiter). */
  rateLimiter?: PreflightRateLimiter;
  /** Injectable clock for cache + rate limiter defaults (tests). */
  nowMs?: () => number;
  /**
   * C24 audit (CRITICAL): derive the CALLER IP the SAME spoof-resistant way every
   * other route does — `clientIpOf` (CF-Connecting-IP → rightmost trusted XFF hop
   * → socket peer). Behind the C23 nginx `/api/` proxy the raw socket peer is
   * ALWAYS nginx's private docker-bridge IP (172.x) → `isLanOrLoopback` would be
   * unconditionally TRUE, silently SKIPPING the staff-key gate for every public
   * caller and disclosing the full AggregateResult (LAN_URL, tunnel health, cert
   * days, connectivity mode). Wired to the shared `clientIpOf` in index.ts. When
   * omitted (unit tests) the gate falls back to the raw socket peer.
   */
  ipOf?: (req: PreflightRequest) => string;
}

/**
 * Build a GET /api/preflight HTTP handler with:
 *  - LAN/loopback-source gate OR Bearer staff-key auth (else 401).
 *  - 30-second result cache (kills SSRF amplification).
 *  - Per-IP rate limiter (burst throttle).
 *
 * Usage in index.ts:
 *   import { makePreflightHandler } from './preflight.js';
 *   const preflightHandler = makePreflightHandler({ checkers, staffKey });
 *   // then in handleHttp:
 *   if (path === '/api/preflight' && req.method === 'GET') {
 *     await preflightHandler(req, res);
 *     return;
 *   }
 */
export function makePreflightHandler(opts: PreflightHandlerOpts): (
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
  },
  res: {
    writeHead(code: number, headers?: Record<string, string>): void;
    end(body: string): void;
  }
) => Promise<void> {
  const { checkers, nowIso, staffKey } = opts;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const cache = opts.cache ?? makePreflightCache({ nowMs });
  const rateLimiter = opts.rateLimiter ?? makePreflightRateLimiter({ nowMs });
  const ipOf = opts.ipOf;

  return async (req, res) => {
    // --- Auth gate ---
    // C24 audit (CRITICAL): key the LAN/staff gate on the REAL caller IP via the
    // injected `clientIpOf` (else, behind the nginx `/api/` proxy, the socket peer
    // is nginx's bridge IP → the gate is bypassed for every public caller). Falls
    // back to the raw socket peer only when no deriver is injected (unit tests).
    const remoteIp: string = ipOf
      ? ipOf(req)
      : (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const isLan = isLanOrLoopback(remoteIp);

    if (!isLan) {
      // Off-LAN: require Authorization: Bearer <staffKey>
      const authHeader = req.headers?.['authorization'];
      const token = typeof authHeader === 'string'
        ? authHeader.replace(/^Bearer\s+/i, '').trim()
        : '';
      if (!staffKey || token !== staffKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    // --- Rate limit ---
    if (!rateLimiter.check(remoteIp || 'unknown')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many requests' }));
      return;
    }

    // --- Cached run ---
    try {
      const result = await cache.get(checkers, nowIso);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `preflight failed: ${msg}` }));
    }
  };
}
