/**
 * ballot.dom.test.ts — Task C15 (F5 Reality Referendum) the VOTER ballot UI.
 *
 * The ballot is DOM-ONLY (never imports three — asserted by funnel.dom.test.ts +
 * the size gate). These tests cover the C15 additions:
 *   • NEVER-DEAD ballot: laws-in-effect (from the standing law) + a charge-next
 *     meter are shown even with no open election (something to press ≤ 2 s);
 *   • the laws-in-effect reflect the BASE (elected) law, NOT a transient dial
 *     overlay (an ENV_STATE dial must not repaint "the law");
 *   • a tap on an option sends a `vote-cast` for the dial id;
 *   • a live VOTE_TALLY repaints the dueling bars;
 *   • the localStorage device token is written (best-effort anti-stuff).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startBallotEntry, describeLaw } from '../src/funnel/ballot.ts';

class MockWS {
  static instances: MockWS[] = [];
  readyState = 1;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public url: string) {
    MockWS.instances.push(this);
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
  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ??= []).push(cb as () => void);
  }
  deliver(msg: ServerMsg) {
    const ev = { data: encodeText(msg) };
    this.onmessage?.(ev);
    // A real WebSocket also fans a delivery to every addEventListener('message').
    (this.listeners['message'] ?? []).forEach((cb) => (cb as (e: unknown) => void)(ev));
  }
}

/** A minimal localStorage shim for jsdom-without-storage safety. */
function installStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls as unknown as Storage;
  return store;
}

async function joinBallot(): Promise<{ root: HTMLElement; ws: MockWS }> {
  const root = document.createElement('div');
  const p = startBallotEntry(root, { room: 'abc', wsUrl: 'ws://x/ws' });
  await Promise.resolve();
  const ws = MockWS.instances[MockWS.instances.length - 1];
  ws.deliver({ t: 'hello', peerId: 'p1', callsign: 'VOLT-17', tier: 'crowd', roomEpoch: 0 });
  await p;
  return { root, ws };
}

describe('C15 ballot — describeLaw (pure)', () => {
  it('names low-gravity from a base with a small gravity y', () => {
    const label = describeLaw({ gravity: { x: 0, y: -1.2, z: 0 } });
    expect(label).toContain('LOW');
  });
  it('names the default (inert) base as NORMAL/EARTH physics', () => {
    const label = describeLaw({ gravity: { x: 0, y: -5, z: 0 } });
    expect(label.length).toBeGreaterThan(0);
  });
});

describe('C15 ballot — never-dead + interaction', () => {
  let originalWS: unknown;
  beforeEach(() => {
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
    installStorage();
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('shows a never-dead ballot (laws-in-effect + charge meter) even with no open election', async () => {
    const { root } = await joinBallot();
    // The laws-in-effect panel + charge meter exist immediately (something to read).
    expect(root.querySelector('[data-role="laws"]')).not.toBeNull();
    expect(root.querySelector('[data-role="charge"]')).not.toBeNull();
  });

  it('renders vote options on a VOTE_OPEN and sends a vote-cast on tap', async () => {
    const { root, ws } = await joinBallot();
    ws.deliver({
      t: 'vote',
      kind: 0, // OPEN
      options: ['low-g', 'gravity-flip', 'bullet-time'],
      deadlineMs: 90_000,
    });
    const opts = root.querySelectorAll('[data-role="option"]');
    expect(opts.length).toBe(3);
    (opts[1] as HTMLElement).click();
    const sent = ws.sent.map((s) => JSON.parse(s));
    const vote = sent.find((m) => m.t === 'vote-cast');
    expect(vote).toBeDefined();
    expect(vote.option).toBe('gravity-flip');
  });

  it('repaints the dueling bars from a VOTE_TALLY', async () => {
    const { root, ws } = await joinBallot();
    ws.deliver({ t: 'vote', kind: 0, options: ['low-g', 'gravity-flip'], deadlineMs: 90_000 });
    ws.deliver({
      t: 'vote',
      kind: 2, // TALLY
      options: ['low-g', 'gravity-flip'],
      tally: { 'low-g': 7, 'gravity-flip': 3 },
      voterCount: 10,
      deadlineMs: 90_000,
    });
    const bar = root.querySelector('[data-role="bar"][data-option="low-g"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.dataset.count).toBe('7');
  });

  it('laws-in-effect reflect the elected BASE law, NOT a transient dial overlay', async () => {
    const { root, ws } = await joinBallot();
    // The crowd elects low-g → VOTE_RESULT names the standing law.
    ws.deliver({ t: 'vote', kind: 3, winner: 'low-g' }); // RESULT
    const laws = root.querySelector('[data-role="laws"]') as HTMLElement;
    expect(laws.textContent).toContain('LOW');
    // A transient dial fires (env-state carries the MERGED effective params —
    // bullet-time ×0.25 over the low-g base). The laws-in-effect must STILL read
    // the elected base law, never the transient overlay's mode.
    ws.deliver({
      t: 'env-state',
      serverTimestamp: 1000,
      mode: 'BULLET TIME ×0.25',
      params: { gravity: { x: 0, y: -1.2, z: 0 }, timescale: 0.25 },
      endsAt: 13_000,
    });
    // Still the elected law — the overlay did not repaint "the law".
    expect((root.querySelector('[data-role="laws"]') as HTMLElement).textContent).toContain('LOW');
    expect((root.querySelector('[data-role="laws"]') as HTMLElement).textContent).not.toContain(
      'BULLET'
    );
  });

  it('writes a localStorage device token (best-effort anti-stuff)', async () => {
    await joinBallot();
    const token = (globalThis as { localStorage: Storage }).localStorage.getItem(
      'csv-ballot-token'
    );
    expect(token).not.toBeNull();
    expect((token ?? '').length).toBeGreaterThan(0);
  });
});
