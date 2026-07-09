/**
 * preflightEndpoint.test.ts — C24 audit MUST-FIX 1 (CRITICAL): `GET /api/preflight`
 * gates LAN/staff auth on the REAL caller IP (`clientIpOf`), NOT the raw socket peer.
 *
 * Behind the C23 nginx `/api/` proxy the socket peer is ALWAYS nginx's private
 * docker-bridge IP → `isLanOrLoopback` was unconditionally true → the Bearer staff-key
 * check was SKIPPED for every public caller, publicly disclosing the full
 * AggregateResult (LAN_URL, tunnel health, cert-days, connectivity mode).
 *
 * These tests spin the REAL server + REAL HTTP and simulate an internet caller
 * arriving THROUGH the proxy via `CF-Connecting-IP` / `X-Forwarded-For` (the exact
 * headers `clientIpOf` trusts). The off-LAN-public cases MUST fail on the pre-fix
 * code (which read the loopback socket peer → 200 with no key) and pass now (401).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/index.js';
import type { ServerHandle, StartServerOpts } from '../src/index.js';
import type { PreflightCheckers, CheckResult } from '../src/preflight.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const servers = _servers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
});

/** All-ok stub checkers (no real network fetch — deterministic + fast). */
function allOkCheckers(): PreflightCheckers {
  const ok = (name: string) => async (): Promise<CheckResult> => ({ name, status: 'ok', message: 'ok' });
  return {
    'lan-reach': ok('lan-reach'),
    'tunnel-reach': ok('tunnel-reach'),
    'cert-days': ok('cert-days'),
    'ws-rtt': ok('ws-rtt'),
    'autoplay': ok('autoplay'),
    'mic-speaker': ok('mic-speaker'),
    'stage-watchdog': ok('stage-watchdog'),
    'headset-battery': ok('headset-battery'),
  };
}

function makeServer(opts: StartServerOpts = {}): { server: ServerHandle; httpBase: string } {
  const server = startServer(0, { preflightCheckers: allOkCheckers(), ...opts });
  _servers.push(server);
  return { server, httpBase: `http://127.0.0.1:${server.port}` };
}

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

function httpGet(base: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers },
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
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/preflight — auth keys on clientIpOf, not the socket peer', () => {
  it('LAN/loopback source → 200 with a valid AggregateResult shape', async () => {
    const { httpBase } = makeServer();
    const res = await httpGet(httpBase, '/api/preflight');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ overall: 'ok' });
    expect(Array.isArray(res.json?.['checks'])).toBe(true);
  });

  it('public caller via CF-Connecting-IP + no staff key → 401 (FAILS on pre-fix socket-peer code)', async () => {
    // A real internet caller arriving through the nginx `/api/` proxy: the socket
    // peer is loopback (the proxy), but CF-Connecting-IP carries the true public IP.
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/preflight', { 'CF-Connecting-IP': '8.8.8.8' });
    expect(res.status).toBe(401);
    // The disclosure NEVER happens: no checks array leaked in the 401 body.
    expect(res.json?.['checks']).toBeUndefined();
  });

  it('public caller via X-Forwarded-For + no staff key → 401 (FAILS on pre-fix socket-peer code)', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/preflight', { 'X-Forwarded-For': '203.0.113.9' });
    expect(res.status).toBe(401);
  });

  it('public caller (CF-Connecting-IP) + correct staff key → 200', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/preflight', {
      'CF-Connecting-IP': '8.8.8.8',
      Authorization: 'Bearer secret',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ overall: 'ok' });
  });

  it('public caller (CF-Connecting-IP) + wrong staff key → 401', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/preflight', {
      'CF-Connecting-IP': '8.8.8.8',
      Authorization: 'Bearer nope',
    });
    expect(res.status).toBe(401);
  });

  it('a LAN socket peer with a spoofed public XFF is NOT downgraded past the gate incorrectly — the rightmost trusted hop rules', async () => {
    // Single-entry XFF (what nginx sends after $proxy_add_x_forwarded_for on a
    // direct LAN client) resolves to that entry with TRUSTED_PROXY_HOPS=0. A public
    // value here (no staff key) is correctly refused.
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/preflight', { 'X-Forwarded-For': '1.2.3.4' });
    expect(res.status).toBe(401);
  });
});
