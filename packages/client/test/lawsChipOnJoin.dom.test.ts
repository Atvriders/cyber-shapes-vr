/**
 * lawsChipOnJoin.dom.test.ts — Task C22 carry #1 (laws-chip-on-join, C33 desktop).
 *
 * A desktop resident joining a room with a STANDING elected physics law must see
 * the CORRECT laws chip on JOIN — before any VOTE_RESULT ever arrives. Previously
 * the welcome/join snapshot carried only the EFFECTIVE params (via a separate
 * ENV_STATE send), never the STANDING baseParams, so a joiner always saw
 * "LAW: NORMAL PHYSICS" until the next VOTE_RESULT — which could be the whole
 * session on a tie/no-vote re-open (spec §7.5/§7.22).
 *
 * `room.test.ts` pins the SERVER wire contract (welcome carries baseParams
 * additively). This file pins the CLIENT wiring: NetClient's `onWelcome` callback
 * now forwards the received baseParams, and `main.ts` wires it straight into
 * `desktopHud.setBaseParams` — reproduced here exactly (no clockSyncer/etc., just
 * the piece under test) so the laws chip paints correctly on join.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ShapeStore } from '../src/world.ts';
import { NetClient, LOCAL_PEER_ID } from '../src/net/netClient.ts';
import { DesktopHud } from '../src/desktop/hud.ts';
import { encodeText, DEFAULT_PARAMS } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// StubWebSocket — mirrors netClient.test.ts's minimal seam.
// ---------------------------------------------------------------------------
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    StubWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  deliver(msg: ServerMsg): void {
    this.onmessage?.({ data: encodeText(msg) });
  }
}

describe('C22 carry #1 — laws-chip-on-join (welcome baseParams → desktop HUD)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;
  let root: HTMLElement;
  let idCounter: number;

  beforeEach(() => {
    scene = new THREE.Scene();
    idCounter = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${idCounter++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
    root.remove();
  });

  function connect(net: NetClient) {
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  it('a client joining a room with a non-default STANDING law renders the correct chip on join (before any VOTE_RESULT)', () => {
    const hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    const chip = () => hud.root.querySelector('[data-role="laws"]') as HTMLElement;
    // Before any server message: the HUD's inert default.
    expect(chip().textContent).toContain('NORMAL');

    // main.ts wiring, reproduced: NetClient's onWelcome forwards the welcome's
    // baseParams straight to the desktop HUD's laws chip.
    const net = new NetClient(store, {
      now: () => 0,
      onWelcome: (baseParams) => hud.setBaseParams(baseParams ?? DEFAULT_PARAMS),
    });
    const ws = connect(net);

    // The room elected LOW GRAVITY before this client ever joined — a STANDING
    // law with NO VOTE_RESULT sent to this client (a late-join / tie-re-open).
    ws.deliver({
      t: 'welcome',
      playerId: 'local-self',
      shapes: [],
      players: [],
      baseParams: { ...DEFAULT_PARAMS, gravity: { x: 0, y: -1.2, z: 0 } },
    });

    expect(chip().textContent).toContain('LOW GRAVITY');
  });

  it('a client joining a room with NO elected law (DEFAULT baseParams) renders NORMAL PHYSICS', () => {
    const hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    const chip = () => hud.root.querySelector('[data-role="laws"]') as HTMLElement;

    const net = new NetClient(store, {
      now: () => 0,
      onWelcome: (baseParams) => hud.setBaseParams(baseParams ?? DEFAULT_PARAMS),
    });
    const ws = connect(net);
    ws.deliver({
      t: 'welcome',
      playerId: 'local-self',
      shapes: [],
      players: [],
      baseParams: DEFAULT_PARAMS,
    });

    expect(chip().textContent).toContain('NORMAL');
  });
});
