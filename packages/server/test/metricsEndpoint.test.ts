/**
 * metricsEndpoint.test.ts — Task C23: `GET /api/metrics/day` harness tests (real
 * server + real HTTP). The RUNBOOK previously promised this endpoint
 * "(planned: C22)" and it never landed; C23 closes that gap so the Closing
 * Ceremony's `metrics.exportDay()` step is reachable WITHOUT process access.
 *
 * Covers:
 *   - LAN/loopback source → 200, valid DayCounters JSON shape.
 *   - Off-LAN + no staff key → 401.
 *   - Off-LAN + correct staff key → 200.
 *   - Off-LAN + wrong staff key → 401.
 *   - exportDay() is a PURE read: two consecutive GETs return the same counts
 *     (the endpoint never calls resetDay()).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const servers = _servers.splice(0);
  await Promise.allSettled(servers.map((s) => s.close()));
});

function makeServer(opts: { staffKey?: string } = {}): { server: ServerHandle; httpBase: string } {
  const server = startServer(0, opts);
  _servers.push(server);
  return { server, httpBase: `http://127.0.0.1:${server.port}` };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

function httpGet(
  base: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
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

describe('GET /api/metrics/day', () => {
  it('LAN/loopback source → 200 with a valid DayCounters shape', async () => {
    const { httpBase } = makeServer();
    const res = await httpGet(httpBase, '/api/metrics/day');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      scan: 0,
      join: 0,
      glyph: 0,
      vote: 0,
      rotation: 0,
      showpiece: 0,
      clip: 0,
    });
    expect(typeof res.json?.['date']).toBe('string');
    expect(res.json?.['gauges']).toMatchObject({ peakConcurrent: 0, peakWatchers: 0 });
  });

  it('off-LAN + no staff key → 401 (counters withheld)', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/metrics/day', { 'CF-Connecting-IP': '8.8.8.8' });
    expect(res.status).toBe(401);
  });

  it('off-LAN + wrong staff key → 401', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/metrics/day', {
      'CF-Connecting-IP': '8.8.8.8',
      Authorization: 'Bearer wrong',
    });
    expect(res.status).toBe(401);
  });

  it('off-LAN + correct staff key → 200', async () => {
    const { httpBase } = makeServer({ staffKey: 'secret' });
    const res = await httpGet(httpBase, '/api/metrics/day', {
      'CF-Connecting-IP': '8.8.8.8',
      Authorization: 'Bearer secret',
    });
    expect(res.status).toBe(200);
  });

  it('is a pure read — two consecutive GETs return identical counters (never resets)', async () => {
    const { httpBase } = makeServer();
    const first = await httpGet(httpBase, '/api/metrics/day');
    const second = await httpGet(httpBase, '/api/metrics/day');
    expect(second.json?.['join']).toBe(first.json?.['join']);
    expect(second.json?.['scan']).toBe(first.json?.['scan']);
  });
});
