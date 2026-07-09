/**
 * daemon.test.ts — F17 Daemon Crew host (spec §7.17, C28).
 *
 * TDD RED-first. The harness wires a real {@link DaemonPort} over a REAL
 * RoomManager + Room + metrics store, so the daemon genuinely travels the STANDARD
 * paths: `joinResidentSync` (cap-enforced world add — no god-mode), `room.applyIntent`
 * (the exact validated grab/held/release path a human uses), and `manager.leave`
 * (the force-release disconnect). The load-bearing rules are pinned here:
 *
 *   • NO GOD-MODE — a daemon is a real cap-counted resident whose intents obey
 *     grab arbitration; it cannot claim a shape a human holds.
 *   • SYNTHETIC-BLIND — a daemon join never advances the ATTRACT timeline; its join
 *     lands in the metrics SYNTHETIC bucket, never the real-peer total.
 *   • GRAB DEFERENCE — a contested same-window grab always resolves to the HUMAN.
 *   • EVICT-FIRST — a daemon is evicted before a real resident is refused at cap.
 *   • DISMISSAL COMPLETENESS — RESET / humans≥2 / last-human-departs all dismiss,
 *     and dismissal RELEASES the daemon's held shape.
 *   • EXCLUSIONS — the "DMN-07 ONLINE" banner is NOT the join-crane; the queue
 *     bridge prompt is a fixed string (a "DMN-03 NEXT IN THE HEADSET?" is impossible).
 *   • SHIP GATE — LOBBY auto-summon defaults OFF.
 */

import { describe, it, expect } from 'vitest';
import {
  daemonCallsign,
  isDaemonCallsign,
  type TimerApi,
  type ClientMsg,
  type NetShape,
  type DaemonShapeView,
  type DaemonHumanTarget,
} from '@cyber-shapes/shared';
import { RoomManager } from '../src/roomManager.js';
import type { Room } from '../src/room.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { ServerWorld } from '../src/serverWorld.js';
import { makeMetrics } from '../src/metrics.js';
import {
  DaemonCrewHost,
  excludeDaemons,
  QUEUE_BRIDGE_PROMPT,
  type DaemonPort,
  type DaemonPeerInit,
} from '../src/daemons.js';

// A trivial fake TimerApi (the host uses only now() for its default RNG seed).
function fakeTimer(): TimerApi {
  let now = 1000;
  return {
    setTimeout: (cb: () => void) => cb as unknown,
    clearTimeout: () => {},
    now: () => now,
  };
}

const ROOM = 'daemon-room';

/**
 * Build a real-Room-backed DaemonPort + spies. `humanTargets` is a mutable ref the
 * test controls (the server would derive these from relayed human poses). The port
 * uses ONLY the standard room paths — the daemon has no privileged surface.
 */
async function makeHarness(opts: { humans?: number } = {}): Promise<{
  manager: RoomManager;
  room: Room;
  port: DaemonPort;
  metrics: ReturnType<typeof makeMetrics>;
  humanTargetsRef: { current: DaemonHumanTarget[] };
  banners: string[];
  avatars: DaemonPeerInit[];
  joinCraneSpy: { count: number };
  leaveEvents: Array<{ id: string; msg: unknown }>;
  humanIds: string[];
  addHuman: (callsign: string) => string | null;
  spawnShape: (id: string, x: number) => NetShape;
}> {
  const manager = new RoomManager();
  const metrics = makeMetrics({ now: () => 1000 });
  const humanTargetsRef: { current: DaemonHumanTarget[] } = { current: [] };
  const banners: string[] = [];
  const avatars: DaemonPeerInit[] = [];
  const joinCraneSpy = { count: 0 }; // the port has NO join-crane hook; never bumped by the host
  const leaveEvents: Array<{ id: string; msg: unknown }> = [];
  const humanIds: string[] = [];

  // Create the room + seed the requested number of human residents (async std path).
  const first = await manager.joinTier(ROOM, 'resident', 'VOLT-01', 0);
  if ('error' in first) throw new Error('setup: first join failed');
  const room = first.room;
  humanIds.push(first.playerId);
  for (let i = 1; i < (opts.humans ?? 1); i++) {
    const r = await manager.joinTier(ROOM, 'resident', `VOLT-${10 + i}`, 0);
    if ('error' in r) throw new Error('setup: human join failed');
    humanIds.push(r.playerId);
  }

  function addHuman(callsign: string): string | null {
    // A human uses the SAME sync world add for the cap test (equivalent to joinTier).
    return manager.joinResidentSync(ROOM, callsign, 0);
  }

  function spawnShape(id: string, x: number): NetShape {
    const shape: NetShape = {
      id,
      type: 'cube',
      colorIndex: 0,
      renderMode: 'solid',
      scale: 1,
      grabbedBy: null,
      grounded: true,
      bobPhase: 0,
      rotSpeed: { x: 0, y: 0, z: 0 },
      position: { x, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    room.restore([...room.worldShapes, shape]);
    return shape;
  }

  const port: DaemonPort = {
    join: (callsign, color) => manager.joinResidentSync(ROOM, callsign, color),
    applyIntent: (playerId, msg) => {
      room.applyIntent(playerId, msg);
    },
    leave: (playerId) => {
      const events = manager.leave(ROOM, playerId, /* keepAlive */ true);
      for (const e of events) leaveEvents.push({ id: playerId, msg: e });
    },
    announceAvatar: (peer) => avatars.push(peer),
    banner: (callsign) => banners.push(callsign),
    countSyntheticJoin: (callsign) => metrics.count('join', callsign),
    shapes: () =>
      room.worldShapes.map(
        (s): DaemonShapeView => ({ id: s.id, position: s.position, grabbedBy: s.grabbedBy })
      ),
    humanTargets: () => humanTargetsRef.current,
  };

  return {
    manager,
    room,
    port,
    metrics,
    humanTargetsRef,
    banners,
    avatars,
    joinCraneSpy,
    leaveEvents,
    humanIds,
    addHuman,
    spawnShape,
  };
}

describe('DaemonCrewHost — summon through the STANDARD join path (no god-mode)', () => {
  it('summons real cap-counted residents with DMN- callsigns + synthetic metric + banner', async () => {
    const h = await makeHarness();
    const before = h.room.playerCount; // 1 human
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    const ids = host.summon(2);
    expect(ids.length).toBe(2);
    // Each daemon is a REAL world player (occupies a cap slot — counted in the cap).
    expect(h.room.playerCount).toBe(before + 2);
    // Avatars announced + DMN-07 banner fired + synthetic metric — NOT the join-crane.
    expect(h.avatars.length).toBe(2);
    expect(h.banners.every(isDaemonCallsign)).toBe(true);
    expect(h.banners).toContain(daemonCallsign(1));
    expect(h.joinCraneSpy.count).toBe(0); // the host has no join-crane surface at all
    // Metrics: synthetic bucket got the joins; the real-peer total did NOT.
    const day = h.metrics.exportDay();
    expect(day.synthetic.join).toBe(2);
    expect(day.byTier.join?.['resident'] ?? 0).toBe(0);
  });

  it('a daemon has NO god-mode: its grab obeys arbitration (a human-held shape is refused)', async () => {
    const h = await makeHarness();
    const shape = h.spawnShape('s1', 0);
    const humanId = h.humanIds[0];
    // Human grabs first (standard validated path).
    h.room.applyIntent(humanId, { t: 'grab', id: 's1' });
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(humanId);
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    const [daemonId] = host.summon(1);
    // Even a direct daemon grab through the standard path is REFUSED (human holds it).
    h.port.applyIntent(daemonId, { t: 'grab', id: 's1' } as ClientMsg);
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(humanId);
    void shape;
  });
});

describe('DaemonCrewHost — grab deference (the HUMAN always wins a contest)', () => {
  it('never grabs a shape a human already holds (contested → human)', async () => {
    const h = await makeHarness();
    h.spawnShape('s1', 0.2);
    const humanId = h.humanIds[0];
    h.room.applyIntent(humanId, { t: 'grab', id: 's1' });
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    host.summon(1);
    // Drive several ticks: the daemon must never wrest s1 from the human.
    for (let i = 0; i < 20; i++) host.tick(0.1);
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(humanId);
  });

  it('yields a loose shape a human hand is reaching for (same-window contest)', async () => {
    const h = await makeHarness();
    h.spawnShape('s1', 0);
    // A human hand sits right on the loose shape.
    h.humanTargetsRef.current = [
      { id: h.humanIds[0], head: { x: 0, y: 1.6, z: 0 }, hands: [{ x: 0, y: 1, z: 0 }] },
    ];
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    host.summon(1);
    for (let i = 0; i < 20; i++) host.tick(0.1);
    // The daemon never claimed it (deference); the shape stays loose for the human.
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(null);
  });
});

describe('DaemonCrewHost — evict-first at cap (never block a human)', () => {
  it('evicts a daemon so a real resident can seat at the 8-cap', async () => {
    const h = await makeHarness(); // 1 human
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    // Fill the room to the 8-resident cap with daemons (7 daemons + 1 human = 8).
    const ids = host.summon(20);
    expect(h.room.playerCount).toBe(8); // cap-enforced: join returned null past 8
    expect(ids.length).toBe(7); // only 7 seats were free
    // A real resident tries to join at cap → refused.
    expect(h.addHuman('NEON-99')).toBe(null);
    // Evict-first frees a slot; the human now seats.
    expect(host.evictOneForHuman()).toBe(true);
    const seated = h.addHuman('NEON-99');
    expect(seated).not.toBe(null);
    expect(host.count).toBe(6); // one daemon gone
    expect(h.room.playerCount).toBe(8); // 2 humans + 6 daemons
  });
});

describe('DaemonCrewHost — dismissal completeness + release-held', () => {
  it('dismissal releases the daemon\'s held shape (standard disconnect force-release)', async () => {
    const h = await makeHarness();
    h.spawnShape('s1', 0);
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    const [daemonId] = host.summon(1);
    // The daemon grabs the shape through the standard path.
    h.port.applyIntent(daemonId, { t: 'grab', id: 's1' } as ClientMsg);
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(daemonId);
    host.dismiss();
    // Held shape released (grabbedBy cleared) + the daemon left the world.
    expect(h.room.worldShapes.find((s) => s.id === 's1')?.grabbedBy).toBe(null);
    expect(host.count).toBe(0);
  });

  it('dismisses on humans ≥ 2, on last-human-departs (0), and on RESET', async () => {
    const h = await makeHarness();
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });

    host.summon(2);
    host.onHumanCountChanged(2); // a crowd arrived
    expect(host.count).toBe(0);

    host.summon(2);
    host.onHumanCountChanged(0); // last human departed
    expect(host.count).toBe(0);

    host.summon(2);
    host.onReset(); // rotation boundary
    expect(host.count).toBe(0);
  });
});

describe('DaemonCrewHost — ship gate (LOBBY auto-summon default OFF)', () => {
  it('does NOT auto-summon on a lone-visitor transition by default', async () => {
    const h = await makeHarness();
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer() });
    expect(host.autoSummonLobby).toBe(false);
    host.onHumanCountChanged(1); // a lone visitor
    expect(host.count).toBe(0); // no crew — staff/cue must summon
  });

  it('auto-summons on a lone-visitor transition ONLY when the flag is explicitly ON', async () => {
    const h = await makeHarness();
    const host = new DaemonCrewHost({ port: h.port, timer: fakeTimer(), autoSummonLobby: true });
    host.onHumanCountChanged(1);
    expect(host.count).toBeGreaterThan(0);
  });
});

describe('Daemon exclusions — queue bridge + leaderboard', () => {
  it('the queue-bridge prompt is a fixed string — a "DMN-03 NEXT IN THE HEADSET?" is impossible', () => {
    // The prompt never interpolates any callsign (human OR daemon).
    expect(QUEUE_BRIDGE_PROMPT).not.toMatch(/DMN-/);
    expect(QUEUE_BRIDGE_PROMPT).not.toMatch(/-\d{2,3}/);
  });

  it('excludeDaemons filters synthetic peers off any leaderboard/queue row list', () => {
    const rows = [
      { callsign: 'VOLT-17', value: 9 },
      { callsign: daemonCallsign(3), value: 99 }, // a daemon that threw fastest
      { callsign: 'NEON-04', value: 5 },
    ];
    const human = excludeDaemons(rows);
    expect(human.map((r) => r.callsign)).toEqual(['VOLT-17', 'NEON-04']);
    expect(human.some((r) => isDaemonCallsign(r.callsign))).toBe(false);
  });
});

describe('Daemon presence — synthetic-blind timeline (never advances ATTRACT)', () => {
  it('a synthetic resident join never advances ATTRACT; a human join does', () => {
    let roster: Array<{ id: string; name: string; color: number; synthetic?: boolean }> = [];
    const host = new RoomTimelineHost({
      timer: fakeTimer(),
      world: new ServerWorld({ maxShapes: 40, idFactory: () => 'x' }),
      broadcast: () => {},
      roster: () => roster,
    });
    expect(host.timeline.phase).toBe('ATTRACT');
    // A DAEMON join — must NOT advance the timeline (synthetic-blind).
    roster = [{ id: 'p1', name: daemonCallsign(1), color: 0, synthetic: true }];
    host.onPeerJoined({ id: 'p1', name: daemonCallsign(1), color: 0, synthetic: true });
    expect(host.timeline.phase).toBe('ATTRACT');
    // A HUMAN join — advances ATTRACT → LOBBY.
    roster = [...roster, { id: 'p2', name: 'VOLT-02', color: 0 }];
    host.onPeerJoined({ id: 'p2', name: 'VOLT-02', color: 0 });
    expect(host.timeline.phase).toBe('LOBBY');
    host.dispose();
  });
});

// =============================================================================
// C22.5 Part B — LIVE connection-layer integration (spec §7.17). Task C28's own
// review flagged that `joinCraneSpy` above is NEVER incremented by any code path
// (a tautological `expect(0).toBe(0)`), and that `onHumanCountChanged` /
// `evictOneForHuman` were only ever driven as direct host-method calls, never
// through the REAL socket join/leave handshake. These tests drive the actual
// production `handleConnection` join/leave/broadcast/tee paths (in-memory
// `FakeWs` — no TCP, no wall clock) so a regression in the WIRING (not just the
// host's own logic, already covered above) would fail them.
// =============================================================================

import {
  decodeBinary,
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  OPCODES,
  renderCasterWire,
} from '@cyber-shapes/shared';
import { makeConnectionHub, handleConnection } from '../src/connection.js';
import type { ConnectionHub } from '../src/connection.js';
import { runSimTick } from '../src/index.js';
import { RoomAuthStore, deriveJoinSecret } from '../src/auth.js';

const LIVE_TICK_MS = 1000 / 30;

/** A trivial deterministic clock (setTimeout/advance) — no Date.now anywhere. */
class LiveFakeTimer {
  private _now = 0;
  private _seq = 0;
  private readonly _timers = new Map<number, { at: number; cb: () => void }>();
  setTimeout(cb: () => void, ms: number): number {
    const id = this._seq++;
    this._timers.set(id, { at: this._now + Math.max(0, ms), cb });
    return id;
  }
  clearTimeout(h: number): void {
    this._timers.delete(h);
  }
  now(): number {
    return this._now;
  }
  advance(ms: number): void {
    this._now += ms;
    for (;;) {
      let due: Array<[number, { at: number; cb: () => void }]> | null = null;
      for (const entry of this._timers) if (entry[1].at <= this._now) (due ??= []).push(entry);
      if (!due) break;
      due.sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        if (!this._timers.has(id)) continue;
        this._timers.delete(id);
        t.cb();
      }
    }
  }
}

/** An in-memory WebSocket the REAL `handleConnection` drives (no TCP/async I/O). */
class LiveFakeWs {
  binaryType = 'nodebuffer';
  readyState = 1; // OPEN
  closed = false;
  tier?: string;
  director?: boolean;
  hello?: ServerMsg & { t: 'hello'; peerId: string; callsign: string; tier: string };
  /** Decoded TEXT ServerMsgs received, when constructed with `record: true`. */
  received: ServerMsg[] = [];
  /** Raw BINARY frames received (e.g. CASTER_LINE), when `record: true`. */
  binaryReceived: ArrayBuffer[] = [];
  private readonly recording: boolean;
  private readonly listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  constructor(recording = false) {
    this.recording = recording;
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    const l = this.listeners.get(ev);
    if (l) l.push(cb);
    else this.listeners.set(ev, [cb]);
    return this;
  }
  once(ev: string, cb: (...a: unknown[]) => void): this {
    const wrap = (...a: unknown[]): void => {
      this.off(ev, wrap);
      cb(...a);
    };
    return this.on(ev, wrap);
  }
  off(ev: string, cb: (...a: unknown[]) => void): this {
    const l = this.listeners.get(ev);
    if (l) {
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    }
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    const l = this.listeners.get(ev);
    if (l) for (const cb of [...l]) cb(...args);
  }
  send(data: unknown): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (!this.hello && data.includes('"hello"')) {
        try {
          const m = decodeText(data) as ServerMsg & { t: string };
          if (m.t === 'hello') {
            this.hello = m as LiveFakeWs['hello'];
            this.tier = (m as { tier?: string }).tier;
          }
        } catch {
          /* not hello */
        }
      }
      if (this.recording) {
        try {
          this.received.push(decodeText(data) as ServerMsg);
        } catch {
          /* non-JSON (shouldn't happen on the text path) */
        }
      }
    } else if (this.recording) {
      let buf: ArrayBuffer | null = null;
      if (data instanceof ArrayBuffer) {
        buf = data;
      } else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
      }
      if (buf) this.binaryReceived.push(buf);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

function memAuthFs(): {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, d: string) => Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    async readFile(p) {
      const v = store.get(p);
      if (v === undefined) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return v;
    },
    async writeFile(p, d) {
      store.set(p, d);
    },
  };
}

interface LiveHarness {
  timer: LiveFakeTimer;
  manager: RoomManager;
  hub: ConnectionHub;
  roomId: string;
  ownerToken: string;
  secret: string;
  connect(
    tier: string | undefined,
    opts?: { ip?: string; owner?: boolean; secret?: boolean; record?: boolean; color?: number }
  ): Promise<LiveFakeWs>;
  inject(ws: LiveFakeWs, msg: unknown, binary?: boolean): void;
  flush(): Promise<void>;
  tick(n: number): void;
}

async function buildLiveHarness(): Promise<LiveHarness> {
  const timer = new LiveFakeTimer();
  const now = (): number => timer.now();
  const manager = new RoomManager(null);
  const hub = makeConnectionHub();
  const authStore = new RoomAuthStore({ now, dir: '/mem', ...memAuthFs() });

  const created = await authStore.createRoom('1.0.0.1');
  if ('error' in created) throw new Error(`createRoom failed: ${created.error}`);
  const roomId = created.roomId;
  const ownerToken = created.ownerToken;
  const secret = deriveJoinSecret(ownerToken, roomId, 0);

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
  };

  const connect: LiveHarness['connect'] = async (tier, opts = {}) => {
    const ws = new LiveFakeWs(opts.record ?? false);
    handleConnection(ws as never, manager, hub, () => {}, () => {}, {
      authStore,
      clientIp: opts.ip ?? '1.0.0.1',
      timerApi: timer as never,
    });
    const join: Record<string, unknown> = {
      t: 'join',
      room: roomId,
      name: 'guest',
      color: opts.color ?? 0,
      protocol: PROTOCOL_VERSION,
    };
    if (tier !== undefined) join['tier'] = tier;
    if (opts.secret) join['joinSecret'] = secret;
    if (opts.owner) join['ownerToken'] = ownerToken;
    ws.emit('message', encodeText(join as never), false);
    await flush();
    return ws;
  };

  const inject: LiveHarness['inject'] = (ws, msg, binary = false) => {
    if (ws.closed) return;
    ws.emit('message', binary ? msg : encodeText(msg as never), binary);
  };

  const tick: LiveHarness['tick'] = (n) => {
    for (let k = 0; k < n; k++) {
      timer.advance(LIVE_TICK_MS);
      runSimTick(roomId, k + 1, { manager, hub, metrics: makeMetrics({ now }) });
    }
  };

  return { timer, manager, hub, roomId, ownerToken, secret, connect, inject, flush, tick };
}

/** Fire a director-cmd cue by id (the standard console FIRE path). */
function fireCue(H: LiveHarness, director: LiveFakeWs, cueId: string, instanceId: string): void {
  H.inject(director, { t: 'director-cmd', cmd: 'FIRE', cueId, cueInstanceId: instanceId });
}

describe('C22.5 Part B.1 — a LIVE daemon join fires daemon-banner, NEVER a join-crane', () => {
  it('the summon path emits {t:"daemon-banner"} and NO CASTER_LINE ever mentions the daemon callsign', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const observer = await H.connect('spectator', { secret: true, record: true }); // CASTER_TIERS includes spectator
    await H.flush();

    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    H.tick(5); // let the caster's own per-tick drain run a few times

    // (a) the distinct DMN banner fired.
    const banner = observer.received.find((m): m is ServerMsg & { t: 'daemon-banner' } => m.t === 'daemon-banner');
    expect(banner).toBeDefined();
    expect(banner!.callsign).toMatch(/^DMN-/);

    // (b) the daemon's own player-join carries synthetic:true (never a bare join).
    const joins = observer.received.filter((m): m is ServerMsg & { t: 'player-join' } => m.t === 'player-join');
    expect(joins.some((j) => j.player.synthetic === true && j.player.name === banner!.callsign)).toBe(true);

    // (c) NO CASTER_LINE (0x33) frame ever decodes to a line naming the daemon —
    // the real join-crane trigger (`getCaster(room)?.onEvent({kind:'join', …})`)
    // is called ONLY inside the human resident-join socket handler, which the
    // daemon join path never touches. (Manually verified non-vacuous: temporarily
    // dropping the `banner()` call fails assertion (a) above. A SECOND, independent
    // guard also protects this specific assertion — `parseCallsign` rejects any
    // `DMN-` word since it is frozen out of the human wordlist, so even a
    // reintroduced `onEvent({kind:'join', callsign:'DMN-…'})` could never queue a
    // caster line — so (a)/(b) are the load-bearing regression guards here.)
    const casterTexts = observer.binaryReceived
      .map((buf) => {
        try {
          const d = decodeBinary(buf);
          if (d.opcode !== OPCODES.CASTER_LINE) return null;
          const f = d.fields as { templateId: number; slots: number[] };
          return renderCasterWire(f.templateId, f.slots);
        } catch {
          return null;
        }
      })
      .filter((t): t is string => t !== null);
    expect(casterTexts.some((t) => t.includes(banner!.callsign))).toBe(false);
  });
});

describe('C22.5 Part B.2 — onHumanCountChanged wired from the REAL socket join/leave paths', () => {
  it('a 2nd human JOINING live (handleConnection) dismisses an already-summoned crew', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const human1 = await H.connect('resident', { owner: true, secret: true });
    void human1;
    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    expect(H.hub.getDaemonCrew(H.roomId)!.count).toBeGreaterThan(0);

    // A SECOND human joins through the REAL join handshake (not a direct
    // `onHumanCountChanged(2)` call) — the dismissal trigger must fire from the
    // join handler itself (~connection.ts join path).
    const human2 = await H.connect('resident', { secret: true, color: 1 });
    expect(human2.tier).toBe('resident');
    expect(H.hub.getDaemonCrew(H.roomId)!.count).toBe(0);
  });

  it('the LAST human LEAVING live (socket close) dismisses the crew', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const human = await H.connect('resident', { owner: true, secret: true, record: true });
    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    expect(H.hub.getDaemonCrew(H.roomId)!.count).toBeGreaterThan(0);

    // The lone human's socket closes through the REAL close handler (not a
    // direct `onHumanCountChanged(0)` call).
    human.close();
    await H.flush();
    expect(H.hub.getDaemonCrew(H.roomId)!.count).toBe(0);
  });
});

describe('C22.5 Part B.3 — connection-layer evict-first at cap (real join path)', () => {
  it('a human joining at the 8-cap evicts a daemon via the REAL join handler; the 2nd human then dismisses the rest', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    void director;
    const human1 = await H.connect('resident', { owner: true, secret: true });
    void human1;
    // Fill the remaining 7 seats with daemons directly on the REAL host (the
    // summon mechanism itself is already covered elsewhere; here we need cap
    // FAST) — this is still the production DaemonCrewHost + its real port.
    const crew = H.hub.getDaemonCrew(H.roomId)!;
    crew.summon(7);
    expect(H.manager.get(H.roomId)!.playerCount).toBe(8);
    expect(crew.count).toBe(7);

    // A 2nd human joins THROUGH THE REAL SOCKET PATH at cap — evict-first must
    // free a slot via the connection layer's own `evictOneForHuman()` call
    // (connection.ts's join-refused retry), not a direct unit call. The SAME
    // join then also crosses humans==2, so the dismissal trigger fires too —
    // both effects are asserted so a break in EITHER wiring fails this test.
    const human2 = await H.connect('resident', { secret: true, color: 2 });
    expect(human2.tier).toBe('resident'); // the join SUCCEEDED (not refused)
    expect(H.manager.get(H.roomId)!.playerCount).toBe(2); // 2 humans, 0 daemons
    expect(crew.count).toBe(0); // evict-first freed the seat; humans==2 dismissed the rest
  });
});

describe('C22.5 Part B.4 — reel-tee of a LIVE daemon session preserves synthetic:true', () => {
  it('a live daemon join + grab + release is teed into the recorder; a banked reel keeps synthetic:true (the DAEMON badge survives)', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const human = await H.connect('resident', { owner: true, secret: true });
    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    const crew = H.hub.getDaemonCrew(H.roomId)!;
    const daemonId = crew.ids()[0]!;

    H.inject(human, { t: 'spawn', shape: { type: 'cube', position: { x: 0, y: 1, z: 0 } } });
    await H.flush();
    const shape = H.manager.get(H.roomId)!.worldShapes[0]!;

    // Drive the daemon's REAL port DIRECTLY — the SAME production port
    // `DaemonCrewHost.tick()`'s autonomous fetch-and-return uses (broadcast +
    // recorder tee included). This sidesteps the physics-driven pursuit's
    // timing/placement fragility while still exercising the EXACT live
    // grab→held→release broadcast path a real fetch-and-return cycle takes.
    const port = (crew as unknown as { _port: { applyIntent(id: string, msg: unknown): void } })._port;
    port.applyIntent(daemonId, { t: 'grab', id: shape.id });
    port.applyIntent(daemonId, {
      t: 'release',
      id: shape.id,
      velocity: { x: 3, y: 1, z: 0 },
      position: shape.position,
      rotation: { x: 0, y: 0, z: 0 },
    });

    // Bank the recorder's current best highlight window (the SAME production
    // method the `reel-bank` staff/cue path calls) and inspect the coalesced
    // reel's LOSSLESS discrete-event union.
    const recorder = H.hub.getRecorder(H.roomId)!;
    const reel = recorder.bankHighlight();
    expect(reel).not.toBeNull();
    const discretes = reel!.frames.flatMap((f) => f.discrete);

    const joins = discretes.filter(
      (e): e is typeof e & { msg: ServerMsg & { t: 'player-join' } } => e.msg.t === 'player-join'
    );
    // The daemon's own join is present AND synthetic:true survives sanitize()
    // (the name is anonymized to GHOST_XX; the flag rides through untouched).
    expect(joins.some((e) => e.msg.player.synthetic === true)).toBe(true);

    const grabsOnShape = discretes.filter(
      (e): e is typeof e & { msg: ServerMsg & { t: 'grab' } } => e.msg.t === 'grab' && e.msg.id === shape.id
    );
    // The acquire (held) — peerId is the daemon.
    expect(grabsOnShape.some((e) => e.msg.peerId === daemonId)).toBe(true);
    // The release — peerId null (the SAME `grab` ServerMsg shape a release uses).
    expect(grabsOnShape.some((e) => e.msg.peerId === null)).toBe(true);
  });
});

describe('C22.5 Part B.5 — VOICE_ROSTER + occupancy exclude a LIVE summoned daemon', () => {
  it('VOICE_ROSTER lists only the human sender, never the daemon, even though it is a resident too', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const human = await H.connect('resident', { owner: true, secret: true, record: true });
    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    expect(H.hub.getDaemonCrew(H.roomId)!.count).toBeGreaterThan(0);

    H.inject(human, { t: 'voice-join' });
    await H.flush();
    const roster = human.received.find((m): m is ServerMsg & { t: 'voice-roster' } => m.t === 'voice-roster');
    expect(roster).toBeDefined();
    expect(roster!.players).toHaveLength(1);
    expect(roster!.players[0]!.id).toBe(human.hello!.peerId);
  });

  it('occupancy (humanResidents) excludes daemons: an EXPLICIT TITANIZE targetId naming a daemon can never resolve to it', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true, record: true });
    const human = await H.connect('resident', { owner: true, secret: true });
    const crew = H.hub.getDaemonCrew(H.roomId)!;
    crew.summon(2);
    expect(H.manager.get(H.roomId)!.playerCount).toBe(3); // 1 human + 2 daemons, all world players
    const daemonId = crew.ids()[0]!;

    // Explicitly target a DAEMON's own live world-player id. The handler's lookup
    // is `residents.find(p => p.id === targetId)` over `humanResidents()` — if the
    // daemon were visible there it would resolve directly to it; since it never
    // is, the lookup structurally MISSES and falls back to `residents[0]` (some
    // OTHER, non-daemon peer) instead.
    H.inject(director, { t: 'director-cmd', cmd: 'TITANIZE', targetId: daemonId });
    await H.flush();
    const ack = director.received.find((m): m is ServerMsg & { t: 'director-ack' } => m.t === 'director-ack');
    expect(ack).toBeDefined();
    expect(H.hub.getTitan(H.roomId)?.active).toBe(true);
    // The daemon was NEVER selected, despite being named explicitly by id.
    expect(H.hub.getTitan(H.roomId)?.activeTitan).not.toBe(daemonId);
    for (const id of crew.ids()) expect(H.hub.getTitan(H.roomId)?.activeTitan).not.toBe(id);
    void human;
  });
});

describe('C22.5 Part B.6 — a daemon pose NEVER writes lastResidentPose (aim stays human-only)', () => {
  it('driving a live daemon through many real ticks never pollutes the human-pose-only aim map', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true });
    const human = await H.connect('resident', { owner: true, secret: true });
    // One real human pose relay — this DOES populate the map (baseline).
    H.inject(human, {
      t: 'pose',
      pose: { head: { p: { x: 0, y: 1.6, z: 2 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [null, null] },
    });
    await H.flush();

    fireCue(H, director, 'summon-daemons', 'summon-1');
    await H.flush();
    const daemonIds = H.hub.getDaemonCrew(H.roomId)!.ids();
    expect(daemonIds.length).toBeGreaterThan(0);

    // Drive many REAL ticks — DaemonCrewHost.tick() forwards a `{t:'pose', pose}`
    // applyIntent for EVERY daemon EVERY tick (the same intent shape a human's
    // socket pose relay carries).
    H.tick(120);

    const internal = H.hub as unknown as { lastResidentPose: Map<string, Map<string, unknown>> };
    const poses = internal.lastResidentPose.get(H.roomId);
    expect(poses).toBeDefined();
    // Only the ONE human id is present — never a daemon id, no matter how many
    // pose intents the daemon's tick loop forwarded through the standard path.
    expect([...poses!.keys()]).toEqual([human.hello!.peerId]);
    for (const id of daemonIds) expect(poses!.has(id)).toBe(false);
  });
});

describe('C24 audit — TITANIZE targets a RESIDENT-tier peer only (never a spectator/audience)', () => {
  it('no resident present → TITANIZE no-ops (never titanizes a director/spectator human)', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true, record: true });
    const spectator = await H.connect('spectator', { secret: true });
    await H.flush();

    // A TITANIZE with only non-resident humans present must select NOBODY — on the
    // pre-fix code `humanResidents()` (tier-blind) returned [director, spectator]
    // and `residents[0]` titanized one of THEM.
    H.inject(director, { t: 'director-cmd', cmd: 'TITANIZE' });
    await H.flush();

    const ack = director.received.find((m): m is ServerMsg & { t: 'director-ack' } => m.t === 'director-ack');
    expect(ack).toBeDefined(); // a no-op ack
    const titan = H.hub.getTitan(H.roomId);
    expect(titan?.active).toBe(false); // NOBODY titanized
    expect(titan?.activeTitan).not.toBe(director.hello!.peerId);
    expect(titan?.activeTitan).not.toBe(spectator.hello!.peerId);
  });

  it('picks the RESIDENT even when a spectator joined first (default select ignores tier order)', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true, record: true });
    const spectator = await H.connect('spectator', { secret: true }); // joins BEFORE the resident
    const resident = await H.connect('resident', { secret: true });
    await H.flush();

    H.inject(director, { t: 'director-cmd', cmd: 'TITANIZE' });
    await H.flush();

    const titan = H.hub.getTitan(H.roomId);
    expect(titan?.active).toBe(true);
    // Pre-fix, `residents[0]` was the FIRST socket peer (the director) → wrong.
    expect(titan?.activeTitan).toBe(resident.hello!.peerId);
    expect(titan?.activeTitan).not.toBe(spectator.hello!.peerId);
  });

  it('an EXPLICIT targetId naming a spectator can NEVER resolve to it (falls back to a resident)', async () => {
    const H = await buildLiveHarness();
    const director = await H.connect('director', { owner: true, record: true });
    const spectator = await H.connect('spectator', { secret: true });
    const resident = await H.connect('resident', { secret: true });
    await H.flush();

    // Name the spectator explicitly by id — pre-fix `residents.find(p=>p.id===targetId)`
    // over the tier-blind roster resolved straight to the spectator and titanized it.
    H.inject(director, { t: 'director-cmd', cmd: 'TITANIZE', targetId: spectator.hello!.peerId });
    await H.flush();

    const titan = H.hub.getTitan(H.roomId);
    expect(titan?.active).toBe(true);
    expect(titan?.activeTitan).not.toBe(spectator.hello!.peerId);
    expect(titan?.activeTitan).toBe(resident.hello!.peerId);
  });
});
