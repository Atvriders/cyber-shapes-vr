/**
 * clientIp.test.ts — C24 audit MUST-FIX 2 (per-IP limiter spoof-resistance).
 *
 * `clientIpOf` derives the key EVERY per-IP limiter uses (C4 room-create, C4
 * failed-join backoff, C25 audience cap + keyframe throttle, C31 clip throttle,
 * preflight/metrics LAN gate). The shipped nginx configs now APPEND the real peer
 * to X-Forwarded-For and STRIP any inbound CF-Connecting-IP; the server-side flag
 * `TRUST_CF_CONNECTING_IP=false` (set in both shipped composes) is the belt-and-
 * suspenders half of that fix: a client-forged `CF-Connecting-IP` must NEVER key
 * rung 1 on a deploy where the header is not authoritatively edge-set.
 *
 * DEFAULT (env unset) preserves the historical Cloudflare-Tunnel behaviour (rung 1
 * trusts CF-Connecting-IP) so the C25/C30/C31 limiter tests are unaffected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientIpOf } from '../src/index.js';

/** Build a minimal fake request `clientIpOf` can read (headers + socket peer). */
function req(opts: {
  cf?: string;
  xff?: string;
  socket?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.cf !== undefined) headers['cf-connecting-ip'] = opts.cf;
  if (opts.xff !== undefined) headers['x-forwarded-for'] = opts.xff;
  return {
    headers,
    socket: { remoteAddress: opts.socket ?? '10.9.9.9' },
  } as unknown as IncomingMessage;
}

afterEach(() => {
  delete process.env['TRUST_CF_CONNECTING_IP'];
});

describe('clientIpOf — default (trust CF-Connecting-IP): C25/C30 behaviour preserved', () => {
  it('rung 1: CF-Connecting-IP wins over XFF and the socket peer', () => {
    expect(clientIpOf(req({ cf: '9.9.9.9', xff: '1.1.1.1', socket: '2.2.2.2' }))).toBe('9.9.9.9');
  });

  it('rung 2: with no CF header, the RIGHTMOST (trusted) XFF hop wins — a forged leftmost is ignored', () => {
    // TRUSTED_PROXY_HOPS defaults to 0, so the rightmost entry (the real peer the
    // trusted proxy appended) is authoritative; the client-forged leftmost is not.
    expect(clientIpOf(req({ xff: '1.2.3.4, 203.0.113.7', socket: '198.51.100.2' }))).toBe('203.0.113.7');
  });
});

describe('clientIpOf — TRUST_CF_CONNECTING_IP=false: a forged CF-Connecting-IP can never key rung 1', () => {
  it('forged CF-Connecting-IP + a trusted-hop XFF resolves to the REAL peer, not the forgery', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = 'false';
    // Attacker forges cf=6.6.6.6; nginx appended the real peer (203.0.113.7) as the
    // rightmost XFF hop. The key MUST be the real peer, never the forged cf.
    const ip = clientIpOf(req({ cf: '6.6.6.6', xff: '9.9.9.9, 203.0.113.7', socket: '203.0.113.7' }));
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe('6.6.6.6');
  });

  it('models the nginx strip (empty CF-Connecting-IP) → keys on the XFF real peer', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = 'false';
    expect(clientIpOf(req({ cf: '', xff: '203.0.113.7', socket: '172.20.0.5' }))).toBe('203.0.113.7');
  });

  it('forged CF-Connecting-IP + no XFF → falls through to the socket peer (never the forgery)', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = 'false';
    const ip = clientIpOf(req({ cf: '6.6.6.6', socket: '203.0.113.7' }));
    expect(ip).toBe('203.0.113.7');
    expect(ip).not.toBe('6.6.6.6');
  });
});
