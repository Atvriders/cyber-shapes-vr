/**
 * preflight-security.test.ts — Security tests for /api/preflight (Task C8 fixes).
 *
 * Covers:
 *   HIGH 1+2:
 *     - Off-LAN + no key → 401 (runPreflight never called)
 *     - LAN-source → 200 (no key needed)
 *     - Off-LAN + correct staff key → 200
 *     - Off-LAN + wrong staff key → 401
 *     - Repeated calls within TTL → runPreflight invoked ONCE (cache hit)
 *     - Burst past rate limit → 429
 *   isLanOrLoopback: unit tests for the IP classifier
 *   PreflightCache: TTL correctly cached vs expired
 *   PreflightRateLimiter: window + count logic
 */

import { describe, it, expect } from 'vitest';
import {
  isLanOrLoopback,
  makePreflightCache,
  makePreflightRateLimiter,
  makePreflightHandler,
} from '../src/preflight.js';
import type { PreflightCheckers, CheckResult } from '../src/preflight.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okCheck(name: string): () => Promise<CheckResult> {
  return async () => ({ name, status: 'ok', message: 'ok' });
}

function allOkCheckers(overrides: Partial<PreflightCheckers> = {}): PreflightCheckers {
  return {
    'lan-reach': okCheck('lan-reach'),
    'tunnel-reach': okCheck('tunnel-reach'),
    'cert-days': okCheck('cert-days'),
    'ws-rtt': okCheck('ws-rtt'),
    'autoplay': okCheck('autoplay'),
    'mic-speaker': okCheck('mic-speaker'),
    'stage-watchdog': okCheck('stage-watchdog'),
    'headset-battery': okCheck('headset-battery'),
    ...overrides,
  };
}

/** Build a minimal fake request. */
function fakeReq(opts: {
  remoteAddress?: string;
  authorization?: string;
}): {
  socket: { remoteAddress: string };
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers['authorization'] = opts.authorization;
  return {
    socket: { remoteAddress: opts.remoteAddress ?? '1.2.3.4' },
    headers,
  };
}

/** Build a fake response that captures status + body. */
function fakeRes(): {
  statusCode: number | null;
  body: string;
  writeHead(code: number, _headers?: Record<string, string>): void;
  end(body: string): void;
} {
  const r = {
    statusCode: null as number | null,
    body: '',
    writeHead(code: number) { r.statusCode = code; },
    end(body: string) { r.body = body; },
  };
  return r;
}

// ---------------------------------------------------------------------------
// isLanOrLoopback
// ---------------------------------------------------------------------------

describe('isLanOrLoopback — IP classifier', () => {
  it('127.0.0.1 → true (loopback)', () => {
    expect(isLanOrLoopback('127.0.0.1')).toBe(true);
  });
  it('::1 → true (IPv6 loopback)', () => {
    expect(isLanOrLoopback('::1')).toBe(true);
  });
  it('10.0.0.1 → true (10/8)', () => {
    expect(isLanOrLoopback('10.0.0.1')).toBe(true);
  });
  it('10.255.255.255 → true (10/8 boundary)', () => {
    expect(isLanOrLoopback('10.255.255.255')).toBe(true);
  });
  it('192.168.1.50 → true (192.168/16)', () => {
    expect(isLanOrLoopback('192.168.1.50')).toBe(true);
  });
  it('172.16.0.1 → true (172.16/12 lower bound)', () => {
    expect(isLanOrLoopback('172.16.0.1')).toBe(true);
  });
  it('172.31.255.255 → true (172.16/12 upper bound)', () => {
    expect(isLanOrLoopback('172.31.255.255')).toBe(true);
  });
  it('172.15.0.1 → false (below 172.16/12)', () => {
    expect(isLanOrLoopback('172.15.0.1')).toBe(false);
  });
  it('172.32.0.1 → false (above 172.31/12)', () => {
    expect(isLanOrLoopback('172.32.0.1')).toBe(false);
  });
  it('8.8.8.8 → false (public IP)', () => {
    expect(isLanOrLoopback('8.8.8.8')).toBe(false);
  });
  it('1.2.3.4 → false (public IP)', () => {
    expect(isLanOrLoopback('1.2.3.4')).toBe(false);
  });
  it('empty string → false', () => {
    expect(isLanOrLoopback('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PreflightCache — TTL cache unit tests
// ---------------------------------------------------------------------------

describe('makePreflightCache — TTL cache', () => {
  it('first call runs the checker and returns a result', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => { runCount++; return { name: 'lan-reach', status: 'ok', message: 'ok' }; },
    });
    const cache = makePreflightCache({ ttlMs: 30_000, nowMs: () => 0 });
    const result = await cache.get(checkers);
    expect(result.overall).toBe('ok');
    expect(runCount).toBe(1);
  });

  it('second call within TTL returns cached result WITHOUT re-running checkers', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => { runCount++; return { name: 'lan-reach', status: 'ok', message: 'ok' }; },
    });
    let fakeNow = 0;
    const cache = makePreflightCache({ ttlMs: 30_000, nowMs: () => fakeNow });

    await cache.get(checkers);
    fakeNow = 15_000; // 15 s later — still within TTL
    await cache.get(checkers);
    await cache.get(checkers);

    // lan-reach called once (only on first fetch)
    expect(runCount).toBe(1);
  });

  it('call after TTL expires re-runs the checkers', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => { runCount++; return { name: 'lan-reach', status: 'ok', message: 'ok' }; },
    });
    let fakeNow = 0;
    const cache = makePreflightCache({ ttlMs: 30_000, nowMs: () => fakeNow });

    await cache.get(checkers);
    expect(runCount).toBe(1);

    fakeNow = 30_001; // just past TTL
    await cache.get(checkers);
    expect(runCount).toBe(2);
  });

  it('invalidate() forces next call to re-run checkers', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => { runCount++; return { name: 'lan-reach', status: 'ok', message: 'ok' }; },
    });
    const cache = makePreflightCache({ ttlMs: 30_000, nowMs: () => 0 });

    await cache.get(checkers);
    cache.invalidate();
    await cache.get(checkers);

    expect(runCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PreflightRateLimiter — per-IP window
// ---------------------------------------------------------------------------

describe('makePreflightRateLimiter — per-IP burst throttle', () => {
  it('allows up to maxRequests per window', () => {
    let fakeNow = 0;
    const limiter = makePreflightRateLimiter({ maxRequests: 3, windowMs: 30_000, nowMs: () => fakeNow });

    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false); // 4th → rejected
  });

  it('different IPs are tracked independently', () => {
    const limiter = makePreflightRateLimiter({ maxRequests: 1, windowMs: 30_000, nowMs: () => 0 });

    expect(limiter.check('1.1.1.1')).toBe(true);
    expect(limiter.check('2.2.2.2')).toBe(true);
    expect(limiter.check('1.1.1.1')).toBe(false); // 2nd for 1.1.1.1 → rejected
    expect(limiter.check('2.2.2.2')).toBe(false); // 2nd for 2.2.2.2 → rejected
  });

  it('window reset allows requests again after windowMs', () => {
    let fakeNow = 0;
    const limiter = makePreflightRateLimiter({ maxRequests: 1, windowMs: 30_000, nowMs: () => fakeNow });

    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false); // over limit

    fakeNow = 30_000; // exactly at window boundary → new window
    expect(limiter.check('1.2.3.4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// makePreflightHandler — auth gate + cache + rate-limit integration
// ---------------------------------------------------------------------------

describe('makePreflightHandler — auth gate', () => {
  it('off-LAN + no key → 401 (runPreflight NOT called)', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => { runCount++; return { name: 'lan-reach', status: 'ok', message: 'ok' }; },
    });
    const handler = makePreflightHandler({
      checkers,
      staffKey: 'secret',
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '1.2.3.4' }); // off-LAN
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(runCount).toBe(0); // preflight NOT invoked
  });

  it('off-LAN + wrong key → 401', async () => {
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '8.8.8.8', authorization: 'Bearer wrong' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it('off-LAN + correct staff key → 200', async () => {
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '8.8.8.8', authorization: 'Bearer secret' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('LAN-source (127.0.0.1) → 200 (no key needed)', async () => {
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '127.0.0.1' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('LAN-source (192.168.x.x) → 200 (no key needed)', async () => {
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '192.168.1.50' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('IPv4-mapped loopback (::ffff:127.0.0.1 stripped to 127.0.0.1) → 200', async () => {
    // The handler strips the ::ffff: prefix (matching normalizeIp in index.ts)
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      nowMs: () => 0,
    });

    // The handler strips ::ffff: prefix before isLanOrLoopback check
    const req = fakeReq({ remoteAddress: '::ffff:127.0.0.1' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('no staffKey configured + off-LAN → 401 (key not guessable)', async () => {
    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      // no staffKey
      nowMs: () => 0,
    });

    const req = fakeReq({ remoteAddress: '8.8.8.8', authorization: 'Bearer anything' });
    const res = fakeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });
});

describe('makePreflightHandler — cache hit (runPreflight invoked once on repeated LAN calls)', () => {
  it('repeated calls within TTL invoke checker only once', async () => {
    let runCount = 0;
    const checkers = allOkCheckers({
      'lan-reach': async () => {
        runCount++;
        return { name: 'lan-reach', status: 'ok', message: 'ok' };
      },
    });

    let fakeNow = 0;
    const cache = makePreflightCache({ ttlMs: 30_000, nowMs: () => fakeNow });
    // unlimited rate limiter for this test
    const rateLimiter = makePreflightRateLimiter({ maxRequests: 100, windowMs: 30_000, nowMs: () => fakeNow });

    const handler = makePreflightHandler({
      checkers,
      staffKey: 'secret',
      cache,
      rateLimiter,
      nowMs: () => fakeNow,
    });

    const req = fakeReq({ remoteAddress: '127.0.0.1' });

    // 5 calls within TTL window
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    // lan-reach check fired only once (cache hit for calls 2-5)
    expect(runCount).toBe(1);
  });
});

describe('makePreflightHandler — rate limit (burst throttled)', () => {
  it('burst of calls past rate limit returns 429', async () => {
    let fakeNow = 0;
    const rateLimiter = makePreflightRateLimiter({ maxRequests: 3, windowMs: 30_000, nowMs: () => fakeNow });
    // unlimited cache so rate limit is the only gate
    const cache = makePreflightCache({ ttlMs: 0, nowMs: () => fakeNow });

    const handler = makePreflightHandler({
      checkers: allOkCheckers(),
      staffKey: 'secret',
      cache,
      rateLimiter,
      nowMs: () => fakeNow,
    });

    const req = fakeReq({ remoteAddress: '127.0.0.1' }); // LAN — passes auth
    const statuses: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      await handler(req, res);
      statuses.push(res.statusCode);
    }

    // First 3 pass; 4th and 5th are rate-limited
    expect(statuses.slice(0, 3).every((s) => s === 200)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });
});
