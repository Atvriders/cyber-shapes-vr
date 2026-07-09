/**
 * gallery.dom.test.ts — C25 (F14 The Gallery), client surface.
 * Runs under jsdom (the `.dom.test.ts` glob in vitest.config.ts).
 *
 * Covers the brief's client cases:
 *   • `?watch` occupancy routing — during LIVE occupancy the permalink exposes NO
 *     wisp/crowd/ballot join (audience-only); the booth-QR variant exposes entry;
 *   • the exit screen gains the "it's live right now — share it" watch-link hook;
 *   • the WatchViewer joins as the `audience` tier (NO ownerToken/secret), drives
 *     the viewer counter off AUDIENCE_STATE, cycles camera modes, one-tap pauses on
 *     hidden-tab (explicit socket close) + rejoins, and lands on the static
 *     "at capacity" card (no reconnect) when the room is full;
 *   • the stage "N WATCHING · 0 VIDEO FRAMES SENT" counter renders only at N ≥ 5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import {
  parseFunnelMode,
  isBoothEntry,
  watchExposesEntry,
  bootFunnel,
} from '../src/funnel/funnel.ts';
import { renderExitScreen, EXIT_COPY } from '../src/funnel/exit.ts';
import {
  WatchViewer,
  WATCH_CAMERA_MODES,
  nextWatchCameraMode,
} from '../src/stage/stage.ts';
import { StageOverlays } from '../src/stage/overlays.ts';

// ---------------------------------------------------------------------------
// Mock WebSocket (the audience handshake surface).
// ---------------------------------------------------------------------------
class MockWS {
  static instances: MockWS[] = [];
  readyState = 0; // CONNECTING
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    MockWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  deliver(msg: ServerMsg) {
    this.onmessage?.({ data: encodeText(msg) });
  }
  deliverRaw(s: string) {
    this.onmessage?.({ data: s });
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = MockWS as unknown;
  MockWS.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Pure routing helpers
// ===========================================================================

describe('C25 funnel — watch routing helpers (pure)', () => {
  it('parseFunnelMode recognises ?watch', () => {
    expect(parseFunnelMode('?watch')).toBe('watch');
    expect(parseFunnelMode('?mode=wisp')).toBe('wisp');
  });

  it('isBoothEntry: only the booth-QR variant (?booth / ?mode) — the ?watch permalink is not', () => {
    expect(isBoothEntry('?watch')).toBe(false);
    expect(isBoothEntry('?booth=1')).toBe(true);
    expect(isBoothEntry('?mode=wisp')).toBe(true);
  });

  it('watchExposesEntry: audience-only during live occupancy; entry only booth-or-idle', () => {
    expect(watchExposesEntry({ booth: false, occupied: true })).toBe(false); // Discord permalink, live
    expect(watchExposesEntry({ booth: true, occupied: true })).toBe(true); // booth QR
    expect(watchExposesEntry({ booth: false, occupied: false })).toBe(true); // idle permalink
  });
});

// ===========================================================================
// bootFunnel — the ?watch DOM (occupancy invariant)
// ===========================================================================

describe('C25 funnel — the ?watch permalink DOM', () => {
  it('during live occupancy exposes NO wisp/crowd/ballot join (audience-only)', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, { href: 'https://x/r/abc?watch', search: '?watch' });
    await flush();
    // The plan invariant: no entry choices on the live permalink.
    expect(root.querySelector('[data-role="choice"][data-mode="wisp"]')).toBeNull();
    expect(root.querySelector('[data-role="choice"][data-mode="crowd"]')).toBeNull();
    expect(root.querySelector('[data-role="choice"][data-mode="ballot"]')).toBeNull();
    // But the watch chrome + the "share it" hook IS present.
    expect(root.querySelector('[data-role="watch-share"]')).not.toBeNull();
    expect(root.querySelector('[data-role="watch-counter"]')).not.toBeNull();
    expect(root.dataset['exposeEntry']).toBe('false');
  });

  it('the booth-QR variant (?watch&booth=1) DOES expose live-room entry', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, { href: 'https://x/r/abc?watch&booth=1', search: '?watch&booth=1' });
    await flush();
    expect(root.querySelector('[data-role="choice"][data-mode="wisp"]')).not.toBeNull();
    expect(root.dataset['exposeEntry']).toBe('true');
  });
});

// ===========================================================================
// Exit screen — the "share it" watch-link hook
// ===========================================================================

describe('C25 exit screen — the "it\'s live right now — share it" hook', () => {
  it('renders the share copy + a SHARE WATCH LINK button carrying the ?watch permalink', () => {
    const root = document.createElement('div');
    renderExitScreen(root, { callsign: 'VOLT-17', roomId: 'abc', origin: 'https://x' });
    const share = root.querySelector('[data-role="share-live"]');
    expect(share?.textContent).toBe(EXIT_COPY.shareLive);
    const btn = root.querySelector('[data-role="share-btn"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.dataset['watchLink']).toContain('watch');
  });
});

// ===========================================================================
// WatchViewer — the receive-only audience socket
// ===========================================================================

describe('C25 WatchViewer — audience join + counter + pause/rejoin + at-capacity', () => {
  it('joins as the audience tier with NO ownerToken/secret', async () => {
    const v = new WatchViewer({ room: 'abc', heartbeatMs: 100000 });
    v.connect();
    await flush();
    const ws = MockWS.instances[0];
    expect(ws.sent.length).toBe(1);
    const join = JSON.parse(ws.sent[0]) as Record<string, unknown>;
    expect(join['t']).toBe('join');
    expect(join['tier']).toBe('audience');
    expect(join['ownerToken']).toBeUndefined();
    expect(join['joinSecret']).toBeUndefined();
    v.dispose();
  });

  it('drives the viewer counter off AUDIENCE_STATE', async () => {
    const counts: number[] = [];
    const v = new WatchViewer({ room: 'abc', heartbeatMs: 100000, onViewerCount: (n) => counts.push(n) });
    v.connect();
    await flush();
    MockWS.instances[0].deliver({ t: 'hello', peerId: 'p0', callsign: 'X-1', tier: 'audience', roomEpoch: 1 });
    MockWS.instances[0].deliver({ t: 'audience-state', viewerCount: 42 });
    expect(v.status).toBe('live');
    expect(v.viewerCount).toBe(42);
    expect(counts).toContain(42);
    v.dispose();
  });

  it('over-cap → the static "at capacity" card (terminal, no socket/reconnect)', async () => {
    vi.useFakeTimers();
    const v = new WatchViewer({ room: 'full', heartbeatMs: 100000 });
    v.connect();
    await flush();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'error', code: 'at-capacity', message: 'at capacity — the world reopens tonight' });
    expect(v.status).toBe('at-capacity');
    expect(ws.closed).toBe(true);
    // No reconnect ever fires (the terminal card path).
    vi.advanceTimersByTime(60000);
    expect(MockWS.instances.length).toBe(1);
    v.dispose();
  });

  it('hidden-tab → explicit pause (socket closed) → one-tap rejoin reconnects', async () => {
    const v = new WatchViewer({ room: 'abc', heartbeatMs: 100000 });
    v.connect();
    await flush();
    const first = MockWS.instances[0];
    first.deliver({ t: 'hello', peerId: 'p0', callsign: 'X-1', tier: 'audience', roomEpoch: 1 });
    expect(v.status).toBe('live');

    // Tab hidden → the viewer explicitly stops + closes (no lingering cap slot).
    v.setHidden(true);
    expect(v.status).toBe('paused');
    expect(first.closed).toBe(true);
    expect(v.isConnected()).toBe(false);

    // One-tap rejoin opens a fresh socket.
    v.rejoin();
    await flush();
    expect(MockWS.instances.length).toBe(2);
    v.dispose();
  });

  it('camera switcher cycles free-orbit ⇄ follow (pure + on the viewer)', () => {
    expect(WATCH_CAMERA_MODES).toEqual(['orbit', 'follow']);
    expect(nextWatchCameraMode('orbit')).toBe('follow');
    expect(nextWatchCameraMode('follow')).toBe('orbit');
    const v = new WatchViewer({ room: 'abc', heartbeatMs: 100000 });
    expect(v.cameraMode).toBe('orbit');
    expect(v.cycleCamera()).toBe('follow');
    expect(v.cycleCamera()).toBe('orbit');
    v.dispose();
  });

  it('emits a heartbeat (only) on its cadence — never an intent', async () => {
    vi.useFakeTimers();
    const v = new WatchViewer({ room: 'abc', heartbeatMs: 1000 });
    v.connect();
    await Promise.resolve(); // let the queued microtask (onopen) run
    const ws = MockWS.instances[0];
    ws.sent.length = 0; // drop the join
    vi.advanceTimersByTime(3500);
    expect(ws.sent.length).toBeGreaterThanOrEqual(3);
    for (const s of ws.sent) expect(JSON.parse(s)['t']).toBe('heartbeat');
    v.dispose();
  });
});

// ===========================================================================
// Stage overlays — the "N WATCHING" counter renders only at N ≥ 5
// ===========================================================================

describe('C25 overlays — watcher counter renders only at N ≥ 5', () => {
  it('hidden below 5, shows "N WATCHING · 0 VIDEO FRAMES SENT" at ≥ 5', () => {
    const o = new StageOverlays(document, { flexLineGranted: true });
    o.setWatcherCount(4);
    expect(o.watcherCounterText()).toBe('');
    o.setWatcherCount(5);
    expect(o.watcherCounterText()).toBe('5 WATCHING · 0 VIDEO FRAMES SENT');
    o.setWatcherCount(120);
    expect(o.watcherCounterText()).toBe('120 WATCHING · 0 VIDEO FRAMES SENT');
    // Drops back below threshold → hidden again.
    o.setWatcherCount(2);
    expect(o.watcherCounterText()).toBe('');
  });
});
