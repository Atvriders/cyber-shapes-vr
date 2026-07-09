/**
 * preflight.test.ts — Unit tests for the preflight check aggregator.
 *
 * All checks are injected (no real network, no real TLS) so tests are
 * fast and deterministic.
 *
 * Covers:
 *   - All-ok aggregate → overall 'ok'
 *   - One 'warn' → overall 'warn'
 *   - One 'fail' → overall 'fail'
 *   - LAN/tunnel mode flag: lan, tunnel, both, offline
 *   - Check throws → converted to 'fail' result (never throws out)
 *   - Timestamp from injected clock
 *   - Individual check helpers (certDays, wsRtt)
 */

import { describe, it, expect } from 'vitest';
import {
  runPreflight,
  makeCertCheck,
  makeWsRttCheck,
  makeAutoplayCheck,
  makeMicSpeakerCheck,
  makeStageWatchdogCheck,
  makeHeadsetBatteryCheck,
} from '../src/preflight.js';
import type { PreflightCheckers, CheckResult } from '../src/preflight.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okCheck(name: string): () => Promise<CheckResult> {
  return async () => ({ name, status: 'ok', message: 'ok' });
}

function warnCheck(name: string): () => Promise<CheckResult> {
  return async () => ({ name, status: 'warn', message: 'warn' });
}

function failCheck(name: string): () => Promise<CheckResult> {
  return async () => ({ name, status: 'fail', message: 'fail' });
}

function throwCheck(name: string): () => Promise<CheckResult> {
  return async () => { throw new Error(`${name} exploded`); };
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

const NOW_ISO = () => '2026-07-01T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Overall status aggregation
// ---------------------------------------------------------------------------

describe('runPreflight — overall status', () => {
  it('all ok → overall ok', async () => {
    const r = await runPreflight(allOkCheckers(), NOW_ISO);
    expect(r.overall).toBe('ok');
  });

  it('one warn → overall warn', async () => {
    const r = await runPreflight(allOkCheckers({ 'ws-rtt': warnCheck('ws-rtt') }), NOW_ISO);
    expect(r.overall).toBe('warn');
  });

  it('one fail → overall fail', async () => {
    const r = await runPreflight(allOkCheckers({ 'cert-days': failCheck('cert-days') }), NOW_ISO);
    expect(r.overall).toBe('fail');
  });

  it('fail beats warn — worst is fail even if others are ok/warn', async () => {
    const r = await runPreflight(allOkCheckers({
      'ws-rtt': warnCheck('ws-rtt'),
      'mic-speaker': failCheck('mic-speaker'),
    }), NOW_ISO);
    expect(r.overall).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// LAN/tunnel mode flag
// ---------------------------------------------------------------------------

describe('runPreflight — mode flag', () => {
  it('both reachable → mode "both"', async () => {
    const r = await runPreflight(allOkCheckers(), NOW_ISO);
    expect(r.mode).toBe('both');
  });

  it('only LAN reachable → mode "lan"', async () => {
    const r = await runPreflight(allOkCheckers({
      'tunnel-reach': failCheck('tunnel-reach'),
    }), NOW_ISO);
    expect(r.mode).toBe('lan');
  });

  it('only tunnel reachable → mode "tunnel"', async () => {
    const r = await runPreflight(allOkCheckers({
      'lan-reach': failCheck('lan-reach'),
    }), NOW_ISO);
    expect(r.mode).toBe('tunnel');
  });

  it('neither reachable → mode "offline"', async () => {
    const r = await runPreflight(allOkCheckers({
      'lan-reach': failCheck('lan-reach'),
      'tunnel-reach': failCheck('tunnel-reach'),
    }), NOW_ISO);
    expect(r.mode).toBe('offline');
  });

  it('LAN warn still counts as reachable for mode', async () => {
    const r = await runPreflight(allOkCheckers({
      'lan-reach': warnCheck('lan-reach'),
      'tunnel-reach': failCheck('tunnel-reach'),
    }), NOW_ISO);
    expect(r.mode).toBe('lan');
  });
});

// ---------------------------------------------------------------------------
// Thrown check → converted to fail
// ---------------------------------------------------------------------------

describe('runPreflight — thrown checks become fail results', () => {
  it('a check that throws becomes a fail result (never throws out)', async () => {
    const r = await runPreflight(allOkCheckers({
      'ws-rtt': throwCheck('ws-rtt'),
    }), NOW_ISO);
    const wsRtt = r.checks.find((c) => c.name === 'ws-rtt');
    expect(wsRtt?.status).toBe('fail');
    expect(wsRtt?.message).toMatch(/ws-rtt exploded/);
  });

  it('even if multiple checks throw, runPreflight still resolves', async () => {
    const r = await runPreflight(allOkCheckers({
      'lan-reach': throwCheck('lan-reach'),
      'tunnel-reach': throwCheck('tunnel-reach'),
      'cert-days': throwCheck('cert-days'),
    }), NOW_ISO);
    expect(r.overall).toBe('fail');
    expect(r.checks).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Result shape + timestamp
// ---------------------------------------------------------------------------

describe('runPreflight — result shape', () => {
  it('returns 8 check results in the correct order', async () => {
    const r = await runPreflight(allOkCheckers(), NOW_ISO);
    const names = r.checks.map((c) => c.name);
    expect(names).toEqual([
      'lan-reach',
      'tunnel-reach',
      'cert-days',
      'ws-rtt',
      'autoplay',
      'mic-speaker',
      'stage-watchdog',
      'headset-battery',
    ]);
  });

  it('timestamp comes from injected clock', async () => {
    const r = await runPreflight(allOkCheckers(), NOW_ISO);
    expect(r.timestamp).toBe('2026-07-01T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Individual check helpers
// ---------------------------------------------------------------------------

describe('makeCertCheck', () => {
  it('days < 3 → fail', async () => {
    const r = await makeCertCheck(1)();
    expect(r.status).toBe('fail');
    expect(r.value).toBe(1);
  });

  it('3 ≤ days < 14 → warn', async () => {
    const r = await makeCertCheck(7)();
    expect(r.status).toBe('warn');
    expect(r.value).toBe(7);
  });

  it('days ≥ 14 → ok', async () => {
    const r = await makeCertCheck(30)();
    expect(r.status).toBe('ok');
    expect(r.value).toBe(30);
  });
});

describe('makeWsRttCheck', () => {
  it('rtt < 0 → fail', async () => {
    const r = await makeWsRttCheck(-1)();
    expect(r.status).toBe('fail');
  });

  it('rtt > 300 → warn', async () => {
    const r = await makeWsRttCheck(350)();
    expect(r.status).toBe('warn');
  });

  it('rtt ≤ 300 → ok', async () => {
    const r = await makeWsRttCheck(50)();
    expect(r.status).toBe('ok');
    expect(r.value).toBe(50);
  });
});

describe('makeAutoplayCheck + makeMicSpeakerCheck', () => {
  it('default status is warn', async () => {
    expect((await makeAutoplayCheck()()).status).toBe('warn');
    expect((await makeMicSpeakerCheck()()).status).toBe('warn');
  });

  it('injected ok → ok', async () => {
    expect((await makeAutoplayCheck('ok')()).status).toBe('ok');
    expect((await makeMicSpeakerCheck('ok')()).status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Task C23: stage-watchdog + headset-battery — ALWAYS-manual checklist prompts
// ---------------------------------------------------------------------------

describe('makeStageWatchdogCheck + makeHeadsetBatteryCheck', () => {
  it('default status is warn (never a fake automated pass)', async () => {
    expect((await makeStageWatchdogCheck()()).status).toBe('warn');
    expect((await makeHeadsetBatteryCheck()()).status).toBe('warn');
  });

  it('default message instructs a MANUAL check', async () => {
    expect((await makeStageWatchdogCheck()()).message).toMatch(/MANUAL CHECK/);
    expect((await makeHeadsetBatteryCheck()()).message).toMatch(/MANUAL CHECK/);
  });

  it('the caller can explicitly confirm ok (after a physical check)', async () => {
    expect((await makeStageWatchdogCheck('ok')()).status).toBe('ok');
    expect((await makeHeadsetBatteryCheck('ok')()).status).toBe('ok');
  });

  it('names are stable (used by the CLI + index.html generic renderer)', async () => {
    expect((await makeStageWatchdogCheck()()).name).toBe('stage-watchdog');
    expect((await makeHeadsetBatteryCheck()()).name).toBe('headset-battery');
  });
});
