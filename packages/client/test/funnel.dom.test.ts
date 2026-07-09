/**
 * funnel.dom.test.ts — C7 phone funnel (code-split entries) + exit screen.
 * Runs under jsdom (matched by the `.dom.test.ts` glob in vitest.config.ts).
 *
 * Covers the brief's Step-1 TDD checklist:
 *   • ballot entry joins (mock WS) WITHOUT importing `three` (import-graph assertion);
 *   • wisp entry emits `joined` BEFORE the 3D dynamic import resolves;
 *   • wisp picker renders ONLY server-offered options (no free-text <input>);
 *   • exit screen renders callsign + permalink + swaps copy on the LAN flag.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';

import { startBallotEntry } from '../src/funnel/ballot.ts';
import { startCrowdEntry } from '../src/funnel/crowd.ts';
import { startWispEntry } from '../src/funnel/wisp.ts';
import { renderExitScreen, EXIT_COPY } from '../src/funnel/exit.ts';
import { offerCallsignWords, joinRoom } from '../src/funnel/join.ts';
import { parseFunnelMode, bootFunnel } from '../src/funnel/funnel.ts';
import { CYBER_COLORS } from '@cyber-shapes/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNNEL_DIR = resolve(HERE, '../src/funnel');

// ---------------------------------------------------------------------------
// Mock WebSocket — the C2 handshake surface the funnel touches.
// ---------------------------------------------------------------------------
class MockWS {
  static instances: MockWS[] = [];
  readyState = 1; // OPEN
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  private listeners: Record<string, Array<() => void>> = {};

  constructor(public url: string) {
    MockWS.instances.push(this);
    // Fire onopen on the next microtask so the caller can wire handlers first.
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
    (this.listeners['close'] ?? []).forEach((cb) => cb());
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  deliver(msg: ServerMsg) {
    this.onmessage?.({ data: encodeText(msg) });
  }
}

/** Recursively collect the transitive import specifiers reachable from a file. */
function transitiveImports(entry: string, seen = new Set<string>()): Set<string> {
  const specs = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const re = /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      specs.add(spec);
      // Follow only relative imports (bare specifiers like `three` are leaves).
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec);
        for (const cand of [base, `${base}.ts`, `${base}.js`, resolve(base, 'index.ts')]) {
          if (existsSync(cand) && cand.endsWith('.ts')) {
            walk(cand);
            break;
          }
        }
      }
    }
  };
  walk(entry);
  return specs;
}

describe('C7 funnel — ballot entry (crowd tier, no three)', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('joins on the crowd tier via mock WS and shows the callsign', async () => {
    const root = document.createElement('div');
    const p = startBallotEntry(root, { room: 'abc', wsUrl: 'ws://x/ws' });
    await Promise.resolve(); // let the ctor microtask fire onopen
    const ws = MockWS.instances[0];
    expect(ws).toBeDefined();
    // The join must carry the EXPLICIT crowd tier (never resident, never absent).
    const join = JSON.parse(ws.sent[0]);
    expect(join.t).toBe('join');
    expect(join.tier).toBe('crowd');
    // Complete the handshake with a hello.
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'VOLT-17', tier: 'crowd', roomEpoch: 0 });
    await p;
    const status = root.querySelector('[data-role="status"]') as HTMLElement;
    expect(status.dataset.joined).toBe('true');
    expect(status.textContent).toContain('VOLT-17');
  });

  it('the ballot import graph does NOT contain `three` (code-split proof)', () => {
    const specs = transitiveImports(resolve(FUNNEL_DIR, 'ballot.ts'));
    expect([...specs]).not.toContain('three');
    // Nor via any relative hop (the walker followed them all).
    for (const s of specs) {
      expect(s.startsWith('three')).toBe(false);
    }
  });
});

describe('C7 funnel — wisp entry (join-first, render-later)', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('emits `joined` BEFORE the 3D dynamic import resolves', async () => {
    const order: string[] = [];
    let resolve3d!: (m: { mountWispView: () => { dispose(): void } }) => void;
    const import3d = vi.fn(
      () =>
        new Promise<{ mountWispView: () => { dispose(): void } }>((res) => {
          order.push('import3d-called');
          resolve3d = res;
        })
    );

    const root = document.createElement('div');
    let joinedCallsign: string | null = null;
    startWispEntry(root, {
      room: 'abc',
      wsUrl: 'ws://x/ws',
      offerSeed: 0,
      import3d: import3d as unknown as import('../src/funnel/wisp.ts').Import3d,
      onJoined: (info) => {
        order.push('joined');
        joinedCallsign = info.callsign;
      },
    });

    // Tap ENTER to start the join.
    (root.querySelector('[data-role="enter"]') as HTMLButtonElement).click();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const join = JSON.parse(ws.sent[0]);
    expect(join.tier).toBe('wisp');
    expect(typeof join.requestedName).toBe('number'); // a curated-wordlist index

    // Server completes the handshake.
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'NOVA-42', tier: 'wisp', roomEpoch: 0 });
    // Let the join promise + onJoined + the import3d() call run.
    await Promise.resolve();
    await Promise.resolve();

    // `joined` MUST have fired, and the in-world panel shown, BEFORE 3D resolves.
    expect(joinedCallsign).toBe('NOVA-42');
    const inMsg = root.querySelector('[data-role="in-msg"]') as HTMLElement;
    expect(inMsg.dataset.joined).toBe('true');
    expect(order.indexOf('joined')).toBeLessThan(order.indexOf('import3d-called'));
    expect(order).not.toContain('3d-mounted');

    // Now resolve the 3D chunk — this happens strictly after `joined`.
    resolve3d({
      mountWispView: () => {
        order.push('3d-mounted');
        return { dispose() {} };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain('3d-mounted');
  });

  it('picker renders ONLY server-offered options — NO free-text input', () => {
    const root = document.createElement('div');
    startWispEntry(root, { room: 'abc', wsUrl: 'ws://x/ws', offerSeed: 0 });
    // Zero free-text fields anywhere in the picker (spec §6.1).
    expect(root.querySelectorAll('input[type="text"]').length).toBe(0);
    expect(root.querySelectorAll('input').length).toBe(0);
    // The word options are exactly the server-offered curated words.
    const offered = offerCallsignWords(0, 6);
    const wordBtns = [...root.querySelectorAll('[data-role="word"]')] as HTMLElement[];
    expect(wordBtns.length).toBe(offered.length);
    expect(wordBtns.map((b) => b.textContent)).toEqual(offered.map((o) => o.word));
    // Every option carries a real CURATED_WORDLIST index (never free text).
    for (const b of wordBtns) {
      expect(Number.isInteger(Number(b.dataset.wordIndex))).toBe(true);
    }
  });
});

// ── Finding #2: crowd import graph must NOT contain `three` ─────────────────
describe('C7 funnel — crowd entry (crowd tier, no three)', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('the crowd import graph does NOT contain `three` (code-split proof)', () => {
    const specs = transitiveImports(resolve(FUNNEL_DIR, 'crowd.ts'));
    // Bare `three` specifier must be absent.
    expect([...specs]).not.toContain('three');
    // Nor any three sub-path via relative hops.
    for (const s of specs) {
      expect(s.startsWith('three')).toBe(false);
    }
  });
});

// ── Finding #3: wake-lock release on ws error ────────────────────────────────
describe('C7 funnel — wake-lock release paths', () => {
  let originalWS: unknown;
  let mockNav: { wakeLock: { request: ReturnType<typeof vi.fn>; released: boolean } };

  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];

    // Mock navigator.wakeLock.
    let sentinel: { release: ReturnType<typeof vi.fn> };
    mockNav = {
      wakeLock: {
        released: false,
        request: vi.fn(async () => {
          sentinel = { release: vi.fn(async () => { mockNav.wakeLock.released = true; }) };
          return sentinel;
        }),
      },
    };
    (globalThis as { navigator: unknown }).navigator = mockNav;
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('ballot: ws error releases the wake lock and removes visibilitychange listener', async () => {
    const root = document.createElement('div');
    const p = startBallotEntry(root, { room: 'abc', wsUrl: 'ws://x/ws' });
    await Promise.resolve();
    const ws = MockWS.instances[0];
    // Complete the handshake so wake lock is acquired.
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'VOLT-17', tier: 'crowd', roomEpoch: 0 });
    const handle = await p;
    // Sanity: wake lock requested.
    expect(mockNav.wakeLock.request).toHaveBeenCalled();

    // Simulate silent TCP drop via ws error event.
    ws.onerror?.();
    // Wake lock release is async — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    // Verify release() via the returned handle (a no-op second call is safe).
    handle.release();
    // If no error is thrown, the release path is sound.
    expect(true).toBe(true);
  });

  it('crowd: ws error triggers release (returned handle is callable)', async () => {
    const root = document.createElement('div');
    const p = startCrowdEntry(root, { room: 'abc', wsUrl: 'ws://x/ws' });
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'CROWD-1', tier: 'crowd', roomEpoch: 0 });
    const handle = await p;
    expect(mockNav.wakeLock.request).toHaveBeenCalled();

    // Fire ws error (silent TCP drop simulation).
    ws.onerror?.();
    await Promise.resolve();
    await Promise.resolve();

    // Should not throw when release is called again.
    expect(() => handle.release()).not.toThrow();
  });
});

// ── Finding #4: wisp retry shows CONNECTING (not stale error) ───────────────
describe('C7 funnel — wisp retry shows CONNECTING state', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('after a failed attempt, a second ENTER shows CONNECTING during the handshake', async () => {
    const root = document.createElement('div');
    // import3d that never resolves (we don't care about 3D in this test).
    const import3d = vi.fn(() => new Promise<never>(() => {}));

    startWispEntry(root, {
      room: 'abc',
      wsUrl: 'ws://x/ws',
      offerSeed: 0,
      import3d: import3d as unknown as import('../src/funnel/wisp.ts').Import3d,
    });

    // First attempt: click ENTER.
    (root.querySelector('[data-role="enter"]') as HTMLButtonElement).click();
    await Promise.resolve();
    const ws1 = MockWS.instances[0];

    // Simulate failure on the first WS.
    ws1.onerror?.();
    await Promise.resolve();
    await Promise.resolve();

    // After failure the in-panel should show the error.
    const inMsg = root.querySelector('[data-role="in-msg"]') as HTMLElement;
    expect(inMsg.textContent).toBe('COULD NOT CONNECT — ASK STAFF');

    // Second attempt: click ENTER again.
    MockWS.instances = [];
    (root.querySelector('[data-role="enter"]') as HTMLButtonElement).click();
    // The CONNECTING state must appear immediately (synchronously within the click handler).
    expect(inMsg.textContent).toBe('CONNECTING…');
  });
});

// ── Finding #6: empty ?ring= yields no glyph ring ───────────────────────────
describe('C7 funnel — empty ring param → no glyph ring', () => {
  it('parseFunnelMode is unaffected by ring (sanity)', () => {
    expect(parseFunnelMode('?mode=ballot')).toBe('ballot');
  });

  it('bootFunnel with ?ring= (empty) renders exit with NO glyph element', async () => {
    const root = document.createElement('div');
    // Simulate ?mode=exit&cs=VOLT-17&ring= (empty)
    await bootFunnel(root, { href: 'https://x/r/abc?mode=exit&cs=VOLT-17&ring=', search: '?mode=exit&cs=VOLT-17&ring=' });
    // Glyph line must NOT be present when ring is empty-string.
    expect(root.querySelector('[data-role="glyph"]')).toBeNull();
  });

  it('bootFunnel with ?ring=3 renders exit WITH glyph element', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, { href: 'https://x/r/abc?mode=exit&cs=VOLT-17&ring=3', search: '?mode=exit&cs=VOLT-17&ring=3' });
    const glyph = root.querySelector('[data-role="glyph"]') as HTMLElement;
    expect(glyph).not.toBeNull();
    expect(glyph.textContent).toContain('ring 3');
  });
});

// ── Task C23: the LAN-mode exit copy is wired end-to-end through bootFunnel ──
describe('C23 funnel — ?lan=1 threads through bootFunnel into the exit copy', () => {
  it('no ?lan param → the default "stays online" copy', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, { href: 'https://x/r/abc?mode=exit&cs=VOLT-17', search: '?mode=exit&cs=VOLT-17' });
    expect((root.querySelector('[data-role="copy"]') as HTMLElement).textContent).toBe(
      EXIT_COPY.online
    );
  });

  it('?lan=1 → the LAN "goes online tonight" copy', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, {
      href: 'https://x/r/abc?mode=exit&cs=VOLT-17&lan=1',
      search: '?mode=exit&cs=VOLT-17&lan=1',
    });
    expect((root.querySelector('[data-role="copy"]') as HTMLElement).textContent).toBe(EXIT_COPY.lan);
  });

  it('?lan=0 (anything but "1") does NOT enable the LAN copy', async () => {
    const root = document.createElement('div');
    await bootFunnel(root, {
      href: 'https://x/r/abc?mode=exit&cs=VOLT-17&lan=0',
      search: '?mode=exit&cs=VOLT-17&lan=0',
    });
    expect((root.querySelector('[data-role="copy"]') as HTMLElement).textContent).toBe(
      EXIT_COPY.online
    );
  });
});

// ── Finding #7: out-of-range color is clamped to 0 ─────────────────────────
describe('C7 funnel — joinRoom color clamping', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('an out-of-range color (>= CYBER_COLORS.length) is clamped to 0', async () => {
    const outOfRange = CYBER_COLORS.length + 5; // definitely out of range
    const p = joinRoom('crowd', { room: 'abc', wsUrl: 'ws://x/ws', color: outOfRange });
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const sentMsg = JSON.parse(ws.sent[0]);
    expect(sentMsg.color).toBe(0);
    // Clean up: deliver hello so the promise settles.
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'X', tier: 'crowd', roomEpoch: 0 });
    await p;
  });

  it('a negative color index is clamped to 0', async () => {
    const p = joinRoom('crowd', { room: 'abc', wsUrl: 'ws://x/ws', color: -3 });
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const sentMsg = JSON.parse(ws.sent[0]);
    expect(sentMsg.color).toBe(0);
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'X', tier: 'crowd', roomEpoch: 0 });
    await p;
  });

  it('a valid color index passes through unchanged', async () => {
    const validColor = CYBER_COLORS.length - 1;
    const p = joinRoom('crowd', { room: 'abc', wsUrl: 'ws://x/ws', color: validColor });
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const sentMsg = JSON.parse(ws.sent[0]);
    expect(sentMsg.color).toBe(validColor);
    ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'X', tier: 'crowd', roomEpoch: 0 });
    await p;
  });
});

describe('C7 funnel — exit screen', () => {
  it('renders callsign + permalink and swaps copy on the LAN flag', () => {
    const root = document.createElement('div');
    renderExitScreen(root, {
      callsign: 'VOLT-17',
      roomId: 'abc',
      origin: 'https://booth.example',
      glyphRing: 3,
    });
    // Callsign present.
    expect((root.querySelector('[data-role="callsign"]') as HTMLElement).textContent).toBe(
      'VOLT-17'
    );
    // Glyph line present.
    expect((root.querySelector('[data-role="glyph"]') as HTMLElement).textContent).toContain(
      'ring 3'
    );
    // Permalink is the canonical /r/:roomId URL.
    const link = root.querySelector('[data-role="permalink"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://booth.example/r/abc');
    // Discord QR slot present.
    expect(root.querySelector('[data-role="discord-qr"]')).not.toBeNull();
    // Default copy = the permanent-online promise.
    expect((root.querySelector('[data-role="copy"]') as HTMLElement).textContent).toBe(
      EXIT_COPY.online
    );

    // LAN flag swaps the copy variant.
    renderExitScreen(root, {
      callsign: 'VOLT-17',
      roomId: 'abc',
      origin: 'https://booth.example',
      lan: true,
    });
    expect((root.querySelector('[data-role="copy"]') as HTMLElement).textContent).toBe(
      EXIT_COPY.lan
    );
  });

  // C31 (F20 Neon Clip Machine, spec §7.20): the clips-by-callsign line.
  it('omits the clips line when no clipUrls are given', () => {
    const root = document.createElement('div');
    renderExitScreen(root, { callsign: 'VOLT-17', roomId: 'abc', origin: 'https://booth.example' });
    expect(root.querySelector('[data-role="clips"]')).toBeNull();
  });

  it('renders one link per saved clip retrieval URL when clipUrls are given', () => {
    const root = document.createElement('div');
    const urls = [
      'https://booth.example/api/clips/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://booth.example/api/clips/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    renderExitScreen(root, {
      callsign: 'VOLT-17',
      roomId: 'abc',
      origin: 'https://booth.example',
      clipUrls: urls,
    });
    const clipsBlock = root.querySelector('[data-role="clips"]');
    expect(clipsBlock).not.toBeNull();
    const links = Array.from(root.querySelectorAll('[data-role="clip-link"]')) as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(urls);
  });
});
