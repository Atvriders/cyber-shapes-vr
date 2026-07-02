/**
 * netClient.test.ts — NetClient spawn reconciliation (B6 tempId re-key).
 *
 * Focus: the duplicate-on-connected-spawn bug. When the client predicts a spawn
 * (local temp id) and the server echoes it back with the canonical id + tempId,
 * the client must RE-KEY the predicted shape (no duplicate) and key its
 * SnapshotBuffer under the canonical id. An inbound spawn with an unknown tempId
 * (or none) must create a new shape (a remote peer's spawn).
 *
 * Seams used:
 *  - globalThis.WebSocket is stubbed (StubWebSocket) so connect() is testable.
 *  - A real ShapeStore over a real THREE.Scene (constructs fine under node).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ShapeStore } from '../src/world.ts';
import { NetClient, LOCAL_PEER_ID } from '../src/net/netClient.ts';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg, NetShape } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// StubWebSocket — minimal implementation of the surface NetClient touches.
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

  /** Test helper: deliver a server message to the client. */
  deliver(msg: ServerMsg): void {
    this.onmessage?.({ data: encodeText(msg) });
  }
}

function makeNetShape(over: Partial<NetShape> & { id: string; type: NetShape['type'] }): NetShape {
  return {
    colorIndex: 0,
    renderMode: 'both',
    scale: 1,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0,
    rotSpeed: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 5, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    ...over,
  };
}

describe('NetClient — spawn reconciliation (B6)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let localCounter: number;
  let originalWS: unknown;

  beforeEach(() => {
    scene = new THREE.Scene();
    localCounter = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${localCounter++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient) {
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  it('re-keys a predicted local shape on echo (no duplicate) and keys the SnapshotBuffer under the canonical id', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    // Client predicts a spawn locally (local temp id).
    const local = store.spawn({ type: 'cube', colorIndex: 3 });
    expect(local.id).toBe(`${LOCAL_PEER_ID}:0`);
    expect(store.shapes).toHaveLength(1);

    // Server echoes the spawn back with the canonical id AND the tempId.
    const canonicalId = 'room1:0';
    ws.deliver({
      t: 'spawn',
      shape: makeNetShape({
        id: canonicalId,
        type: 'cube',
        colorIndex: 3,
        position: { x: 1, y: 2, z: 3 },
      }),
      tempId: local.id,
    });

    // Exactly ONE shape, now under the canonical id (re-keyed, same object).
    expect(store.shapes).toHaveLength(1);
    expect(store.get(canonicalId)).toBe(local);
    expect(store.get(`${LOCAL_PEER_ID}:0`)).toBeUndefined();
    expect(local.id).toBe(canonicalId);

    // Server-authoritative position reconciled onto the existing object.
    expect(local.group.position.x).toBeCloseTo(1);
    expect(local.group.position.y).toBeCloseTo(2);
    expect(local.group.position.z).toBeCloseTo(3);

    // SnapshotBuffer is keyed by the canonical id: a 'state' for canonicalId
    // must feed sampleRemote(canonicalId), and the temp id has no buffer.
    ws.deliver({
      t: 'state',
      seq: 1,
      shapes: [
        {
          id: canonicalId,
          p: { x: 9, y: 9, z: 9 },
          r: { x: 0, y: 0, z: 0 },
          v: { x: 0, y: 0, z: 0 },
        },
      ],
    });
    const sampled = net.sampleRemote(canonicalId, 0);
    expect(sampled).not.toBeNull();
    expect(sampled!.p.x).toBeCloseTo(9);
    expect(net.sampleRemote(`${LOCAL_PEER_ID}:0`, 0)).toBeNull();
  });

  it('fires onRekey with (tempId, canonicalId) so held id can be updated', () => {
    const onRekey = vi.fn();
    const net = new NetClient(store, { now: () => 0, onRekey });
    const ws = connect(net);

    const local = store.spawn({ type: 'cube' });
    ws.deliver({
      t: 'spawn',
      shape: makeNetShape({ id: 'room1:0', type: 'cube' }),
      tempId: local.id,
    });

    expect(onRekey).toHaveBeenCalledOnce();
    expect(onRekey).toHaveBeenCalledWith(`${LOCAL_PEER_ID}:0`, 'room1:0');
  });

  it('creates a NEW shape for an inbound spawn with an unknown tempId', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    const local = store.spawn({ type: 'cube' }); // __local__:0
    ws.deliver({
      t: 'spawn',
      shape: makeNetShape({ id: 'room1:5', type: 'sphere' }),
      tempId: 'someone-elses-temp',
    });

    // Two shapes: our local one is untouched, plus the new remote one.
    expect(store.shapes).toHaveLength(2);
    expect(store.get(local.id)).toBe(local);
    expect(store.get('room1:5')).toBeDefined();
    expect(store.get('room1:5')).not.toBe(local);
  });

  it('creates a NEW shape for an inbound spawn with NO tempId (remote peer spawn)', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    ws.deliver({
      t: 'spawn',
      shape: makeNetShape({ id: 'room1:7', type: 'cone' }),
    });

    expect(store.shapes).toHaveLength(1);
    expect(store.get('room1:7')).toBeDefined();
  });

  it('welcome: does NOT fire onPlayerJoin for the local playerId (self-avatar guard)', () => {
    const onPlayerJoin = vi.fn();
    const net = new NetClient(store, { now: () => 0, onPlayerJoin });
    const ws = connect(net);

    // Server sends a welcome whose players list includes both the local player
    // (playerId = 'local-self') AND two remote peers.
    ws.deliver({
      t: 'welcome',
      playerId: 'local-self',
      shapes: [],
      players: [
        { id: 'local-self', name: 'Me', color: 0 },
        { id: 'remote-a', name: 'Alice', color: 1 },
        { id: 'remote-b', name: 'Bob', color: 2 },
      ],
    });

    // onPlayerJoin must only be called for the two remote peers — never for self.
    expect(onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(onPlayerJoin).toHaveBeenCalledWith('remote-a', 'Alice', 1);
    expect(onPlayerJoin).toHaveBeenCalledWith('remote-b', 'Bob', 2);
    const callArgs = onPlayerJoin.mock.calls.map((c: [string, ...unknown[]]) => c[0]);
    expect(callArgs).not.toContain('local-self');
  });

  it('the local spawn ClientMsg carries tempId = the local shape id', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    const local = store.spawn({ type: 'cube', colorIndex: 2 });
    // main.ts wires onEvent → netClient.onLocalStoreEvent; simulate that.
    net.onLocalStoreEvent({ kind: 'spawn', shape: local });

    // Last sent message (after the join) is the spawn intent with tempId.
    const sent = ws.sent.map((s) => JSON.parse(s) as { t: string; tempId?: string });
    const spawn = sent.find((m) => m.t === 'spawn');
    expect(spawn).toBeDefined();
    expect(spawn!.tempId).toBe(local.id);
  });
});

// ---------------------------------------------------------------------------
// Audit #11/#21 — SnapshotBuffer pruning: deleted on despawn, cleared on welcome.
// Observable via sampleRemote() (returns null once the buffer is gone).
// ---------------------------------------------------------------------------
describe('NetClient — snapshot buffer pruning (audit #11/#21)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient) {
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  it('deletes a shape SnapshotBuffer on despawn (sampleRemote → null)', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    // A remote shape exists + a 'state' populates its snapshot buffer.
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'room1:9', type: 'cube' }) });
    ws.deliver({
      t: 'state',
      seq: 1,
      shapes: [{ id: 'room1:9', p: { x: 5, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    });
    expect(net.sampleRemote('room1:9', 0)).not.toBeNull();

    // Despawn drops the buffer too — no leak, and sampleRemote returns null.
    ws.deliver({ t: 'despawn', id: 'room1:9' });
    expect(net.sampleRemote('room1:9', 0)).toBeNull();
  });

  it('clears ALL SnapshotBuffers on welcome (stale buffers pruned)', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);

    // Populate a buffer for an old shape id.
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'old:1', type: 'cube' }) });
    ws.deliver({
      t: 'state',
      seq: 1,
      shapes: [{ id: 'old:1', p: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    });
    expect(net.sampleRemote('old:1', 0)).not.toBeNull();

    // A fresh welcome repopulates the shape set — the old buffer must be gone.
    ws.deliver({
      t: 'welcome',
      playerId: 'me',
      shapes: [makeNetShape({ id: 'new:1', type: 'sphere' })],
      players: [],
    });
    expect(net.sampleRemote('old:1', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit #19 — malformed server messages must be ignored WITHOUT throwing out of
// ws.onmessage (which would kill the socket handler). The dispatch is wrapped in
// try/catch and collection fields are Array.isArray-guarded.
// ---------------------------------------------------------------------------
describe('NetClient — malformed server message guards (audit #19)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient) {
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  /** Deliver a raw (possibly malformed) object to onmessage without type-checking. */
  function deliverRaw(ws: StubWebSocket, obj: unknown): void {
    ws.onmessage?.({ data: encodeText(obj as never) });
  }

  it("a 'state' whose shapes is NOT an array is ignored (no throw)", () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);
    expect(() => deliverRaw(ws, { t: 'state', seq: 1, shapes: 'not-an-array' })).not.toThrow();
    // The socket handler still works afterwards: a valid message is processed.
    expect(() =>
      ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'room1:1', type: 'cube' }) })
    ).not.toThrow();
    expect(store.get('room1:1')).toBeDefined();
  });

  it("a 'pose' missing its pose payload is ignored (no throw)", () => {
    const onPose = vi.fn((_id: string, pose: unknown) => {
      // Simulate the real avatars.updatePose reading pose.head — a missing pose
      // would throw here; the netClient try/catch must contain it.
      const _p = (pose as { head: { p: unknown } }).head.p;
      void _p;
    });
    const net = new NetClient(store, { now: () => 0, onPose });
    const ws = connect(net);
    expect(() => deliverRaw(ws, { t: 'pose', id: 'p1' /* no pose */ })).not.toThrow();
  });

  it("a 'player-join' missing its player payload is ignored (no throw)", () => {
    const onPlayerJoin = vi.fn();
    const net = new NetClient(store, { now: () => 0, onPlayerJoin });
    const ws = connect(net);
    // No `player` field → reading m.player.id would throw; must be contained.
    expect(() => deliverRaw(ws, { t: 'player-join' })).not.toThrow();
    expect(onPlayerJoin).not.toHaveBeenCalled();
  });

  it('a totally malformed message (unknown shape) is ignored without throwing', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);
    expect(() => deliverRaw(ws, { t: 'welcome', shapes: 42, players: null })).not.toThrow();
  });
});
