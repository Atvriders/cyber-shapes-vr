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
import {
  encodeText,
  encodeBinary,
  decodeBinary,
  packVoice,
  OPCODES,
  MUSIC_KIND,
  SINGLE_KIND,
  VOICE_OPUS,
  createClockSyncer,
  serverNow as toServerNow,
} from '@cyber-shapes/shared';
import type { ServerMsg, NetShape, TimerApi } from '@cyber-shapes/shared';
import { MusicScheduler, type NoteSink } from '../src/music/musicScheduler.ts';
import type { PlayNote } from '../src/music/synth.ts';

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
    // C28: the 4th arg is the §7.17 `synthetic` flag — undefined for a human peer.
    expect(onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(onPlayerJoin).toHaveBeenCalledWith('remote-a', 'Alice', 1, undefined);
    expect(onPlayerJoin).toHaveBeenCalledWith('remote-b', 'Bob', 2, undefined);
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

// ---------------------------------------------------------------------------
// C7 — client sends explicit tier:'resident' + optional joinSecret (security fix)
//
// The resident VR client must send an explicit tier:'resident' (not bare join)
// so a secret-configured booth room can distinguish a keyed client from an
// anonymous interloper. A ?k=<secret> param from the URL is forwarded as
// joinSecret. Without the param no joinSecret is sent (no-secret room → still
// resident; secret room → server downgrades to crowd).
// ---------------------------------------------------------------------------
describe('NetClient — explicit tier:resident join message (C7 security fix)', () => {
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

  it('connect() without joinSecret sends tier:resident in the join message', () => {
    const net = new NetClient(store, { now: () => 0 });
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();

    expect(ws.sent).toHaveLength(1);
    const joinMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(joinMsg['t']).toBe('join');
    expect(joinMsg['tier']).toBe('resident');
    // No joinSecret when none was provided.
    expect(joinMsg['joinSecret']).toBeUndefined();
  });

  it('connect() WITH a joinSecret forwards tier:resident AND joinSecret in the join message', () => {
    const net = new NetClient(store, { now: () => 0 });
    const secret = 'abc123hmac';
    net.connect('ws://test/ws', 'room1', 'tester', 0, secret);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();

    expect(ws.sent).toHaveLength(1);
    const joinMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(joinMsg['t']).toBe('join');
    expect(joinMsg['tier']).toBe('resident');
    expect(joinMsg['joinSecret']).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// Task C16 — F6 Meteor Siege: the lag-compensated catch (client side).
// ---------------------------------------------------------------------------
describe('NetClient — C16 siege catch (clientTimestamp + predict/rollback)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;
  // The active NetClient — the store's onEvent delegates to it (the main.ts wiring:
  // store.onEvent is the network replication hook). Set inside each test's connect.
  let activeNet: NetClient | null;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    activeNet = null;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
      // Replicate the main.ts wiring: every local store event is offered to the
      // NetClient, which builds + sends the corresponding intent.
      onEvent: (e) => activeNet?.onLocalStoreEvent(e),
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient): StubWebSocket {
    activeNet = net;
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  /** Bring the client into a live siege with one tagged meteor present. */
  function armSiegeWithMeteor(ws: StubWebSocket, meteorId: string): void {
    ws.deliver({ t: 'showpiece', kind: 0 /* START */, crystalId: 'crystal', hp: 40, maxHp: 40, endsAt: 90_000 });
    // The server places the meteor as a normal shape…
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: meteorId, type: 'octahedron' }) });
    // …and tags it as a siege meteor via the MET_LAUNCH ticker.
    ws.deliver({ t: 'showpiece', kind: 3 /* MET_LAUNCH */, meteorId, colorIndex: 2 });
  }

  it('a grab of a siege meteor carries a clientTimestamp + grabPoint (lag-comp anchor)', () => {
    const net = new NetClient(store, { now: () => 0, serverNow: () => 12345 });
    const ws = connect(net);
    armSiegeWithMeteor(ws, 'room1:m');
    ws.sent.length = 0;
    // The defender grabs the meteor locally (predict-attach).
    store.setGrab('room1:m', LOCAL_PEER_ID);
    const grab = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(grab.t).toBe('grab');
    expect(grab.id).toBe('room1:m');
    expect(grab.clientTimestamp).toBe(12345); // server-time anchor
    expect(grab.grabPoint).toBeDefined(); // the hand/shape position at grab
  });

  it('predict-attaches locally, then ROLLS BACK on grab-rejected (rewind missed)', () => {
    const net = new NetClient(store, { now: () => 0, serverNow: () => 100 });
    const ws = connect(net);
    armSiegeWithMeteor(ws, 'room1:m');
    // Predict-attach (the store grab fires the intent + optimistic local grab).
    store.setGrab('room1:m', LOCAL_PEER_ID);
    expect(store.get('room1:m')!.grabbedBy).toBe(LOCAL_PEER_ID);
    // The server rewind rejected the catch → GRAB_REJECTED echo → rollback.
    ws.deliver({ t: 'grab-rejected', id: 'room1:m', peerId: 'local-self', by: null });
    expect(store.get('room1:m')!.grabbedBy).toBeNull(); // rolled back
  });

  it('a confirmed server grab keeps the meteor attached (no rollback)', () => {
    const net = new NetClient(store, { now: () => 0, serverNow: () => 100 });
    const ws = connect(net);
    armSiegeWithMeteor(ws, 'room1:m');
    store.setGrab('room1:m', LOCAL_PEER_ID);
    // Server confirms the catch (a normal grab broadcast).
    ws.deliver({ t: 'grab', id: 'room1:m', peerId: 'local-self' });
    expect(store.get('room1:m')!.grabbedBy).toBe('local-self');
  });

  it('a plain (non-siege) grab still round-trips a clientTimestamp but no grabPoint', () => {
    const net = new NetClient(store, { now: () => 0, serverNow: () => 777 });
    const ws = connect(net);
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'room1:plain', type: 'cube' }) });
    ws.sent.length = 0;
    store.setGrab('room1:plain', LOCAL_PEER_ID);
    const grab = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(grab.clientTimestamp).toBe(777);
    expect(grab.grabPoint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task C22 — F8 Resonora MUSIC receive (0x29 → synth) + C3 client clock offset.
//
// The netClient demuxes binary frames by first-byte opcode: voice (0x10–0x12) →
// onVoice (unchanged); MUSIC (0x29) → onMusic (decode + dispatch to the synth
// scheduler); CLOCK_PONG (0x31) → onClockPong (offset syncer). A malformed 0x29 /
// pong is swallowed (C31 decode-safety). serverNow = localNow + offset (fallback
// to local before the first pong).
// ---------------------------------------------------------------------------

// A stub that carries BOTH text (JSON) and binary (ArrayBuffer) frames — the
// existing StubWebSocket is text-only. `send` branches on the payload type.
class BinStubWebSocket {
  static instances: BinStubWebSocket[] = [];
  readyState = 1; // OPEN
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  textSent: string[] = [];
  binarySent: ArrayBuffer[] = [];

  constructor(public url: string) {
    BinStubWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.textSent.push(data);
    else this.binarySent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver a JSON ServerMsg. */
  deliver(msg: ServerMsg): void {
    this.onmessage?.({ data: encodeText(msg) });
  }

  /** Deliver a raw binary frame (ArrayBuffer). */
  deliverBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
}

// A controllable fake TimerApi (now + fire-on-advance) — shared with the scheduler.
function makeFakeTimer() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const api: TimerApi = {
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimeout: (h: unknown) => {
      timers.delete(h as number);
    },
  };
  return {
    api,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
      const due = [...timers.entries()]
        .filter(([, x]) => x.at <= t)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, x] of due) if (timers.delete(id)) x.cb();
    },
  };
}

class MockSynth implements NoteSink {
  played: PlayNote[] = [];
  play(note: PlayNote): boolean {
    this.played.push(note);
    return true;
  }
}

describe('NetClient — C22 MUSIC receive + clock offset', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;
  let activeNet: NetClient | null;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    activeNet = null;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
      onEvent: (e) => activeNet?.onLocalStoreEvent(e),
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = BinStubWebSocket;
    BinStubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient): BinStubWebSocket {
    activeNet = net;
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = BinStubWebSocket.instances[BinStubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  // ---- MUSIC (0x29) decode → schedule -------------------------------------

  it('decodes a MUSIC_CLOCK + MUSIC_NOTE (0x29) and SCHEDULES the note on the synth at the beat-derived time', () => {
    const timer = makeFakeTimer();
    timer.set(1000);
    const synth = new MockSynth();
    const scheduler = new MusicScheduler(synth, { timerApi: timer.api, offsetMs: () => 500 });
    const net = new NetClient(store, {
      now: () => timer.api.now(),
      onMusic: (f) => scheduler.onFrame(f),
    });
    const ws = connect(net);

    // MUSIC_CLOCK sets the shared grid.
    ws.deliverBinary(
      encodeBinary(OPCODES.MUSIC, MUSIC_KIND.CLOCK, {
        bpm: 120,
        beatIndex: 4,
        gridOriginMs: 0,
        reserved: 0,
      })
    );
    expect(scheduler.bpm).toBe(120);
    expect(scheduler.beatIndex).toBe(4);

    // MUSIC_NOTE at server playAtMs=2000 → local fire (offset 500) = 1500 (500 ms out).
    ws.deliverBinary(
      encodeBinary(OPCODES.MUSIC, MUSIC_KIND.NOTE, {
        noteId: 42,
        playAtMs: 2000,
        pitch: 72,
        timbre: 1,
        velocity: 90,
        pan: 10,
        reserved: 0,
      })
    );
    expect(synth.played).toHaveLength(0); // scheduled, not yet fired
    timer.advance(500);
    expect(synth.played).toHaveLength(1);
    expect(synth.played[0].pitch).toBe(72);
    expect(synth.played[0].noteId).toBe(42);
    expect(synth.played[0].pan).toBe(10);
  });

  it('a malformed / short 0x29 MUSIC frame is ignored WITHOUT throwing (C31 decode-safety)', () => {
    const onMusic = vi.fn();
    const net = new NetClient(store, { onMusic });
    const ws = connect(net);

    // A 0x29/NOTE frame far too short (MUSIC_NOTE needs 16 bytes; give 3).
    const short = new Uint8Array([OPCODES.MUSIC, MUSIC_KIND.NOTE, 0x00]).buffer;
    expect(() => ws.deliverBinary(short)).not.toThrow();
    expect(onMusic).not.toHaveBeenCalled();

    // A 0x29 with an unknown kind (no Appendix B layout) is also swallowed.
    const unknownKind = new Uint8Array([OPCODES.MUSIC, 0x7f, 1, 2, 3, 4]).buffer;
    expect(() => ws.deliverBinary(unknownKind)).not.toThrow();
    expect(onMusic).not.toHaveBeenCalled();

    // The socket bus still works: a valid CLOCK frame after is dispatched.
    ws.deliverBinary(
      encodeBinary(OPCODES.MUSIC, MUSIC_KIND.CLOCK, {
        bpm: 100,
        beatIndex: 0,
        gridOriginMs: 0,
        reserved: 0,
      })
    );
    expect(onMusic).toHaveBeenCalledTimes(1);
    expect(onMusic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clock', bpm: 100 })
    );
  });

  it('does NOT regress the voice binary path — a voice opcode still routes to onVoice', () => {
    const onVoice = vi.fn();
    const onMusic = vi.fn();
    const net = new NetClient(store, { onVoice, onMusic });
    const ws = connect(net);
    const frame = packVoice(VOICE_OPUS, 3, 1234, 0, new Uint8Array([1, 2, 3]));
    ws.deliverBinary(frame);
    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(onVoice.mock.calls[0][0]).toBe(3); // senderId
    expect(onMusic).not.toHaveBeenCalled();
  });

  // ---- CLOCK_PING / PONG → offset → serverNow ------------------------------

  it('sends a CLOCK_PING and a CLOCK_PONG yields offset; serverNow = localNow + offset', () => {
    const timer = makeFakeTimer();
    timer.set(1000);
    let net!: NetClient;
    const syncer = createClockSyncer({
      timerApi: timer.api,
      sendPing: (clientSendMs) => net.sendClockPing(clientSendMs, syncer.rttMs),
    });
    net = new NetClient(store, {
      now: () => timer.api.now(),
      serverNow: () => toServerNow(syncer.offsetMs, timer.api.now()),
      onClockPong: (f) => syncer.onPong(f),
    });
    const ws = connect(net);

    // Before any pong: offset 0 → serverNow falls back to local now.
    expect(toServerNow(syncer.offsetMs, 1000)).toBe(1000);

    // Fire the first ping (at local t=1000). The netClient sent a CLOCK_PING frame.
    syncer.start();
    const ping = ws.binarySent[ws.binarySent.length - 1];
    const decodedPing = decodeBinary(ping);
    expect(decodedPing.opcode).toBe(OPCODES.CLOCK_PING);
    expect(decodedPing.fields.clientSendMs).toBe(1000);

    // The server echoes clientSendMs + serverTimeMs=5000; the pong arrives at t=1020
    // (RTT 20). offset = 5000 − (1000 + 1020) / 2 = 3990.
    timer.set(1020);
    ws.deliverBinary(
      encodeBinary(OPCODES.CLOCK_PONG, SINGLE_KIND.ONLY, {
        clientSendMs: 1000,
        serverTimeMs: 5000,
        reserved: 0,
      })
    );
    expect(syncer.offsetMs).toBe(3990);

    // serverNow (via the wired NetClient opt) now returns localNow + offset.
    expect(net.opts.serverNow!()).toBe(1020 + 3990);

    // …and it flows into an outgoing grab's clientTimestamp (the C16 lag-comp anchor).
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'room1:g', type: 'cube' }) });
    ws.textSent.length = 0;
    store.setGrab('room1:g', LOCAL_PEER_ID);
    const grab = JSON.parse(ws.textSent[ws.textSent.length - 1]);
    expect(grab.t).toBe('grab');
    expect(grab.clientTimestamp).toBe(1020 + 3990);
  });

  it('a malformed CLOCK_PONG is swallowed (no throw, offset stays at fallback)', () => {
    const onClockPong = vi.fn();
    const net = new NetClient(store, { onClockPong });
    const ws = connect(net);
    const shortPong = new Uint8Array([OPCODES.CLOCK_PONG, SINGLE_KIND.ONLY, 0x00]).buffer;
    expect(() => ws.deliverBinary(shortPong)).not.toThrow();
    expect(onClockPong).not.toHaveBeenCalled();
  });

  it('serverNow falls back to LOCAL now when no serverNow opt is wired (offset unavailable)', () => {
    const net = new NetClient(store, { now: () => 4242 });
    const ws = connect(net);
    ws.deliver({ t: 'spawn', shape: makeNetShape({ id: 'room1:p', type: 'cube' }) });
    ws.textSent.length = 0;
    store.setGrab('room1:p', LOCAL_PEER_ID);
    const grab = JSON.parse(ws.textSent[ws.textSent.length - 1]);
    // No serverNow opt → _serverNow defaults to the local clock (now()).
    expect(grab.clientTimestamp).toBe(4242);
  });
});
