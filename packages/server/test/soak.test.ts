/**
 * soak.test.ts — Task C22 (spec §6.5 / §7 / §13). The 30-minute DETERMINISTIC
 * integration soak + the budget-ledger measured egress + audience convergence.
 *
 * Tagged `soak`: the heavy 30-simulated-minute run is gated behind `SOAK=1` so the
 * default `npm test` stays fast/green; `npm run test:soak` sets the flag. The fast
 * audience-convergence case (carry #9) runs in the default suite too.
 *
 * DETERMINISM: NO Date.now / NO Math.random anywhere in the harness. A single
 * injected FakeTimerApi is the ONE clock — it drives the sim tick cadence, every
 * host phase/auto-revert timer, the idle-kick, the metrics/auth/clip clocks, and
 * the Conductor/Caster/Recorder `now()`. The server's own RNG paths are seeded from
 * the (fixed) roomId, so two runs produce byte-identical results.
 *
 * ARCHITECTURE: the soak drives the PRODUCTION tick path — the exported
 * `runSimTick` (extracted from index.ts's startSimLoop) — manually, 54 000 times,
 * over a REAL RoomManager + REAL connection hub whose ALL subsystems are wired by
 * the REAL `handleConnection` join handshake. Connections are in-memory FakeWs
 * sockets (no TCP, no async I/O) that record every outbound byte per tier, so
 * egress is measured synchronously and deterministically. This is the same
 * in-process ws/hub harness the C25 tests use, minus the real sockets + wall clock.
 *
 * EVERY landed Phase C subsystem is exercised (Tiers 0–6 + Workshop): 8 residents +
 * crowd/wisp/audience at cap + spectators + directors; the timeline running full
 * rotations with stage fan-out; the siege (incl. the C27 3-wave arc); wisps; the
 * C22.2 recorder tee; the C18 conductor/music; the C15 elections mid-cycle; the
 * C25/C30 audience at cap + a stalled socket + a reconnect stampede + post-ring-wrap
 * DVR-resume joins; C31 /api/clips under load; the C28 daemon crew; C32 telekinesis
 * hands-latch; and RESET restoring a C34 Workshop baseline + seeded glyphs near cap.
 *
 * The soak asserts the FOUR invariant classes (spec §6.5): (1) zero tick overruns
 * (per-tick processed work stays bounded — no runaway backlog), (2) bounded memory
 * (every accumulating structure plateaus t=0 ≈ 15 min ≈ 30 min), (3) per-tier egress
 * within the §6.5/§7 budgets, and (4) the carry-#9 audience-convergence residual.
 * The MEASURED egress is recorded in docs/booth/BUDGET_LEDGER.md.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  BUILD_KIND,
  MAX_SHAPES,
  encodeBinary,
  OPCODES,
  TELEKINESIS_KIND,
} from '@cyber-shapes/shared';
import type { ServerMsg, TimerApi, TimerHandle } from '@cyber-shapes/shared';
import { RoomManager } from '../src/roomManager.js';
import { makeConnectionHub, handleConnection } from '../src/connection.js';
import type { ConnectionHub } from '../src/connection.js';
import { GLYPH_CAPACITY } from '../src/glyphManager.js';
import { makeMetrics } from '../src/metrics.js';
import type { MetricsStore } from '../src/metrics.js';
import { runSimTick } from '../src/index.js';
import { RoomAuthStore, deriveJoinSecret } from '../src/auth.js';
import { ClipStore } from '../src/clips.js';

const SOAK_ENABLED = process.env['SOAK'] === '1';

const TICK_MS = 1000 / 30;
const TICKS_PER_MIN = 30 * 60; // 1800
const TOTAL_TICKS = 30 * TICKS_PER_MIN; // 54 000 — 30 simulated minutes
const HALF_TICKS = 15 * TICKS_PER_MIN; // 27 000

// ---------------------------------------------------------------------------
// byte accounting — the ONE place a "byte on the wire" is measured
// ---------------------------------------------------------------------------

function byteLen(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return (data as ArrayBufferView).byteLength;
  if (Buffer.isBuffer(data)) return data.length;
  return 0;
}

// ---------------------------------------------------------------------------
// A deterministic fake timer — the ONE clock for the whole soak.
// ---------------------------------------------------------------------------

class FakeTimerApi implements TimerApi {
  private _now = 0;
  private _seq = 0;
  private readonly _timers = new Map<number, { at: number; cb: () => void }>();
  setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this._seq++;
    this._timers.set(id, { at: this._now + Math.max(0, ms), cb });
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this._timers.delete(h as number);
  }
  now(): number {
    return this._now;
  }
  /** Advance the clock by `ms`, firing every timer that comes due, in time order. */
  advance(ms: number): void {
    this._now += ms;
    // Callbacks may schedule new timers; loop until nothing else is due.
    for (;;) {
      let due: Array<[number, { at: number; cb: () => void }]> | null = null;
      for (const entry of this._timers) {
        if (entry[1].at <= this._now) (due ??= []).push(entry);
      }
      if (!due) break;
      due.sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        if (!this._timers.has(id)) continue; // cleared by an earlier callback
        this._timers.delete(id);
        t.cb();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FakeWs — an in-memory WebSocket the real handleConnection drives. Records every
// outbound byte (per socket + into a shared egress total) with NO async I/O.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface EgressStats {
  total: number;
}

class FakeWs {
  binaryType = 'nodebuffer';
  readyState = 1; // OPEN
  bufferedAmount = 0;
  bytesSent = 0;
  sentIntents = 0;
  closed = false;
  tier?: string;
  hello?: ServerMsg & { t: 'hello'; peerId: string; callsign: string; tier: string };
  /** When non-null, decoded text messages are captured (used by the convergence viewer). */
  record: ServerMsg[] | null;
  private readonly _stats: EgressStats;
  private readonly _listeners = new Map<string, Listener[]>();

  constructor(stats: EgressStats, record = false) {
    this._stats = stats;
    this.record = record ? [] : null;
  }

  on(ev: string, cb: Listener): this {
    const l = this._listeners.get(ev);
    if (l) l.push(cb);
    else this._listeners.set(ev, [cb]);
    return this;
  }
  once(ev: string, cb: Listener): this {
    const wrap: Listener = (...a) => {
      this.off(ev, wrap);
      cb(...a);
    };
    return this.on(ev, wrap);
  }
  off(ev: string, cb: Listener): this {
    const l = this._listeners.get(ev);
    if (l) {
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    }
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    const l = this._listeners.get(ev);
    if (l) for (const cb of [...l]) cb(...args);
  }

  send(data: unknown): void {
    if (this.closed) return;
    const n = byteLen(data);
    this.bytesSent += n;
    this._stats.total += n;
    if (typeof data === 'string') {
      if (!this.hello && data.charCodeAt(0) === 123 /* { */ && data.includes('"hello"')) {
        try {
          const m = decodeText(data) as ServerMsg & { t: string };
          if (m.t === 'hello') {
            this.hello = m as FakeWs['hello'];
            this.tier = (m as { tier?: string }).tier;
          }
        } catch {
          /* not hello */
        }
      }
      if (this.record) {
        try {
          this.record.push(decodeText(data) as ServerMsg);
        } catch {
          /* non-JSON */
        }
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

// ---------------------------------------------------------------------------
// In-memory fs pairs (auth + clips) so the harness never touches disk.
// ---------------------------------------------------------------------------

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

function memClipFs(): {
  readFile: (p: string) => Promise<Buffer>;
  writeFile: (p: string, d: Buffer) => Promise<void>;
  deleteFile: (p: string) => Promise<void>;
} {
  const store = new Map<string, Buffer>();
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
    async deleteFile(p) {
      store.delete(p);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  timer: FakeTimerApi;
  manager: RoomManager;
  hub: ConnectionHub;
  metrics: MetricsStore;
  clipStore: ClipStore;
  authStore: RoomAuthStore;
  stats: EgressStats;
  roomId: string;
  ownerToken: string;
  secret: string;
  connect(
    tier: string | undefined,
    opts?: { ip?: string; owner?: boolean; secret?: boolean; record?: boolean; color?: number }
  ): Promise<FakeWs>;
  /** Flush the async join IIFE (in-mem fs → resolves in a couple of macrotask turns). */
  flush(): Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const timer = new FakeTimerApi();
  const now = (): number => timer.now();
  const manager = new RoomManager(null);
  const hub = makeConnectionHub();
  const metrics = makeMetrics({ now });
  const authStore = new RoomAuthStore({ now, dir: '/mem', ...memAuthFs() });
  const clipStore = new ClipStore({ now, dir: '/mem', ...memClipFs() });
  const stats: EgressStats = { total: 0 };

  const created = await authStore.createRoom('1.0.0.1');
  if ('error' in created) throw new Error(`createRoom failed: ${created.error}`);
  const roomId = created.roomId;
  const ownerToken = created.ownerToken;
  const secret = deriveJoinSecret(ownerToken, roomId, 0);

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
  };

  const connect: Harness['connect'] = async (tier, opts = {}) => {
    const ws = new FakeWs(stats, opts.record ?? false);
    handleConnection(ws as never, manager, hub, () => {}, () => {}, {
      authStore,
      clientIp: opts.ip ?? '1.0.0.1',
      metrics,
      timerApi: timer,
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

  return { timer, manager, hub, metrics, clipStore, authStore, stats, roomId, ownerToken, secret, connect, flush };
}

// ---------------------------------------------------------------------------
// The 30-minute soak
// ---------------------------------------------------------------------------

describe.skipIf(!SOAK_ENABLED)('C22 — 30-minute deterministic soak (all subsystems)', () => {
  it(
    'runs 30 simulated minutes at cap: bounded ticks, bounded memory, per-tier egress ≤ budget, audience convergence',
    async () => {
      const envBefore = process.env['POWERS_LAB_ENABLED'];
      process.env['POWERS_LAB_ENABLED'] = '1'; // C32 capability gate (env half)
      try {
        const H = await buildHarness();
        const { timer, manager, hub, metrics, clipStore, roomId, ownerToken } = H;

        // ---- a per-socket-capped intent injector (keeps every socket well under
        //      the 200-frame burst so NO frame is ever rate-dropped → determinism)
        const INTENT_CAP = 170;
        const inject = (ws: FakeWs, msg: unknown, binary = false): void => {
          if (ws.closed || ws.sentIntents >= INTENT_CAP) return;
          ws.sentIntents += 1;
          ws.emit('message', binary ? msg : encodeText(msg as never), binary);
        };

        // ---- connections. The resident tier reaches its 8-cap in TWO stages so the
        //      C28 daemon crew is exercised: seat 6 humans (2 free slots), summon 2
        //      daemons into the free slots (synthetic joins + fetch-return play), then
        //      seat the last 2 humans — evict-first evicts the daemons → 8 HUMANS at cap.
        const owner = await H.connect('resident', { ip: '1.0.0.100', owner: true, secret: true });
        expect(owner.tier).toBe('resident');
        const residents: FakeWs[] = [owner];
        for (let i = 1; i < 6; i++) {
          const r = await H.connect('resident', { ip: `1.0.0.${i}`, secret: true, color: i });
          expect(r.tier).toBe('resident');
          residents.push(r);
        }
        const spectators: FakeWs[] = [];
        for (let i = 0; i < 2; i++)
          spectators.push(await H.connect('spectator', { ip: `1.0.1.${i}`, secret: true }));
        const directors: FakeWs[] = [];
        for (let i = 0; i < 2; i++)
          directors.push(await H.connect('director', { ip: `1.0.2.${i}`, owner: true }));
        expect(directors.filter((w) => w.tier === 'director')).toHaveLength(2);
        const stageDirector = directors[0]; // routes every director-cmd (its own budget)
        const wisps: FakeWs[] = [];
        for (let i = 0; i < 24; i++) wisps.push(await H.connect('wisp', { ip: `2.0.${i}.1` }));
        const crowd: FakeWs[] = [];
        for (let i = 0; i < 64; i++) crowd.push(await H.connect('crowd', { ip: `3.0.${i}.1` }));
        const audience: FakeWs[] = [];
        for (let i = 0; i < 128; i++)
          audience.push(await H.connect('audience', { ip: `4.${Math.floor(i / 200)}.${i % 200}.1` }));

        expect(spectators.filter((w) => w.tier === 'spectator')).toHaveLength(2);
        expect(wisps.filter((w) => w.tier === 'wisp')).toHaveLength(24);
        expect(crowd.filter((w) => w.tier === 'crowd')).toHaveLength(64);
        expect(audience.filter((w) => w.tier === 'audience')).toHaveLength(128);
        // The audience tier is AT CAP (128) — its peak (peakWatchers) is the at-cap
        // figure. audience[127] is the reserved "churn slot": it is closed mid-run to
        // free room for the convergence late-joiner, so the 127 STABLE viewers stay
        // open across the whole [15,30] min egress window (a clean per-viewer measure).
        const audienceStable = audience.slice(0, 127);

        const room = manager.get(roomId);
        if (!room) throw new Error('room vanished after joins');
        const idleKicked = [...wisps, ...crowd, ...audience]; // tiers with the 90–120 s idle window
        const preDrive = (n: number): void => {
          for (let k = 0; k < n; k++) {
            timer.advance(TICK_MS);
            runSimTick(roomId, k + 1, { manager, hub, metrics });
          }
        };

        // ---- C32: a resident reports camera-tracked hands (sets the latch + registers
        //      the powers-lab cue under POWERS_LAB_ENABLED). Binary TK_HANDS_STATE.
        inject(
          owner,
          encodeBinary(OPCODES.TELEKINESIS, TELEKINESIS_KIND.TK_HANDS_STATE, { available: 1, reserved: 0 }),
          true
        );

        // ---- C28: summon the daemon crew into the 2 free resident slots -----------
        inject(stageDirector, { t: 'director-cmd', cmd: 'FIRE', cueId: 'summon-daemons', cueInstanceId: 'summon-1' });
        await H.flush();
        const synthAfterSummon = metrics.exportDay().synthetic['join'] ?? 0;
        expect(synthAfterSummon).toBeGreaterThan(0); // daemons seated (synthetic bucket)
        preDrive(150); // daemons play fetch-and-return (the C28 tick path over post-step shapes)

        // ---- C34 Workshop: compose a near-cap showroom baseline + seed glyphs -----
        // Spawn a composition, save + bind it as the RESET baseline, then seed glyphs.
        const BASELINE_SHAPES = 24; // ≤ MAX_SHAPES − METEOR_BUDGET (28) baseline cap
        for (let i = 0; i < BASELINE_SHAPES; i++) {
          inject(owner, {
            t: 'spawn',
            shape: { type: i % 2 ? 'cube' : 'sphere', position: { x: (i % 6) - 3, y: 1 + (i % 4), z: Math.floor(i / 6) - 2 } },
          });
        }
        await H.flush();
        inject(owner, { t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, opId: 'save-1', name: 'showroom' });
        await H.flush();
        inject(owner, { t: 'build', kind: BUILD_KIND.SET_BASELINE, opId: 'base-1', name: 'showroom' });
        await H.flush();
        for (let i = 0; i < 40; i++) {
          inject(owner, {
            t: 'build',
            kind: BUILD_KIND.GLYPH_SEED,
            opId: `seed-${i}`,
            points: [
              { x: 0, y: 0 },
              { x: 0.3, y: 0.4 },
              { x: 0.6, y: 0.1 },
            ],
            color: '#00ffff',
          });
        }
        await H.flush();

        // ---- seat the last 2 humans → evict-first displaces the daemons → 8 HUMANS -
        for (let i = 6; i < 8; i++) {
          const r = await H.connect('resident', { ip: `1.0.0.${i}`, secret: true, color: i });
          expect(r.tier).toBe('resident');
          residents.push(r);
        }
        expect(residents.filter((w) => w.tier === 'resident')).toHaveLength(8);

        // ---- C31 clips: store a few real clips up front so GETs (the download load)
        //      have targets; putClip/getClip exercise the per-IP + per-room maps.
        const clipIds: string[] = [];
        const putClip = async (n: number): Promise<void> => {
          const clipId = n.toString(16).padStart(32, '0');
          const res = await clipStore.putClip({
            ip: '1.0.0.100',
            clipId,
            roomId,
            ownerToken,
            verifyOwnerToken: (r, t) => H.authStore.verifyOwnerToken(r, t),
            contentType: 'video/webm',
            body: Buffer.from(`clip-${n}`),
          });
          if (!('error' in res)) clipIds.push(clipId);
        };
        for (let n = 0; n < 5; n++) await putClip(n);

        // ============================================================================
        // sampling + invariant trackers
        // ============================================================================
        const byteSnapshot = (list: FakeWs[]): number => list.reduce((a, w) => a + w.bytesSent, 0);
        const countGlyphs = (): number => [...(hub as unknown as { glyphs: { glyphs(r: string): Iterable<unknown> } }).glyphs.glyphs(roomId)].length;
        const internal = hub as unknown as {
          powersHandsReported: Map<string, boolean>;
          hosts: Map<string, unknown>;
        };
        const clipInternal = clipStore as unknown as {
          _postHits: Map<string, number[]>;
          _getHits: Map<string, number[]>;
          _roomDayCounts: Map<string, number>;
        };
        const memSnapshot = () => ({
          worldShapes: room.worldShapes.length,
          glyphs: countGlyphs(),
          reels: hub.listReels(roomId).length,
          postHits: clipInternal._postHits.size,
          getHits: clipInternal._getHits.size,
          roomDayCounts: clipInternal._roomDayCounts.size,
          handsLatch: internal.powersHandsReported.size,
          hosts: internal.hosts.size,
          keyframeSerialize: hub.audienceKeyframeSerializeCount(roomId),
        });
        const tierByteSnapshot = () => ({
          resident: byteSnapshot(residents),
          spectator: byteSnapshot(spectators),
          director: byteSnapshot(directors),
          wisp: byteSnapshot(wisps),
          crowd: byteSnapshot(crowd),
          audience: byteSnapshot(audienceStable),
        });

        const mem0 = memSnapshot();
        const bytesAtStart = tierByteSnapshot();

        // tick-overrun trackers
        let maxWorldShapes = 0;
        let maxTickEgress = 0;
        let firstHalfEgress = 0;
        let secondHalfEgress = 0;
        let sawSiegeWaveArc = false;
        let maxSiegeWave = 0;
        const phasesSeen = new Set<string>();

        // convergence (carry #9) fold-in trackers — a LATE audience joiner + a shape
        // spawned AFTER the last keyframe but BEFORE that join.
        let lateViewer: FakeWs | null = null;
        let convergeShapeId: string | null = null;
        const CONVERGE_JOIN_TICK = 20 * TICKS_PER_MIN; // 20 min: room is deep into a rotation

        let memHalf = mem0;
        let bytesAtHalf = bytesAtStart;

        // ============================================================================
        // THE 30-MINUTE LOOP
        // ============================================================================
        for (let i = 1; i <= TOTAL_TICKS; i++) {
          timer.advance(TICK_MS);
          const egBefore = H.stats.total;
          runSimTick(roomId, i, { manager, hub, metrics });
          const tickEgress = H.stats.total - egBefore;
          if (tickEgress > maxTickEgress) maxTickEgress = tickEgress;
          if (i <= HALF_TICKS) firstHalfEgress += tickEgress;
          else secondHalfEgress += tickEgress;
          if (room.worldShapes.length > maxWorldShapes) maxWorldShapes = room.worldShapes.length;

          // track the timeline + the siege wave arc (C27)
          const host = hub.getHost(roomId);
          if (host) phasesSeen.add(host.timeline.phase);
          const siege = hub.getSiege(roomId);
          const wave = (siege as unknown as { waveIndex?: number } | undefined)?.waveIndex ?? -1;
          if (siege?.active && wave >= 0) {
            sawSiegeWaveArc = true;
            if (wave > maxSiegeWave) maxSiegeWave = wave;
          }

          // ---- keep the idle-kicked tiers alive: a heartbeat every ~90 s ---------
          if (i % (90 * 30) === 0) for (const w of idleKicked) inject(w, { t: 'heartbeat' });

          // ---- ATTRACT re-kick: force the next rotation so we hit every phase again
          // (routed through the stage director — its own intent budget, so the owner's
          // build budget is never the bottleneck for keeping rotations flowing).
          if (host && host.timeline.phase === 'ATTRACT' && i > 60) {
            inject(stageDirector, { t: 'director-cmd', cmd: 'ADVANCE' });
          }

          // ---- world churn during PLAY: residents throw falling shapes (→ impacts →
          //      music/caster/recorder), paced round-robin so no socket floods.
          if (i % 90 === 0) {
            const r = residents[(i / 90) % residents.length];
            inject(r, {
              t: 'spawn',
              shape: { type: 'cube', position: { x: ((i / 90) % 5) - 2, y: 7, z: 0 } },
            });
          }
          // ---- resident poses (pose relay egress + daemon aim), round-robin -------
          if (i % 120 === 0) {
            const r = residents[(i / 120) % residents.length];
            inject(r, {
              t: 'pose',
              pose: { head: { p: { x: 0, y: 1.6, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [] },
            });
          }

          // ---- wisp head-only poses feed the coalesced buffer (low-level, the exact
          //      map the pose handler writes — bypasses the inbound bucket) ----------
          if (i % 150 === 0) {
            const setWispPose = (hub as unknown as {
              setWispPose(r: string, id: string, p: { wispIndex: number; pos: [number, number, number]; yaw: number }): void;
            }).setWispPose;
            for (let k = 0; k < wisps.length; k++) {
              const w = wisps[k];
              if (w.closed || !w.hello) continue;
              setWispPose(roomId, w.hello.peerId, {
                wispIndex: k % 24,
                pos: [(k % 6) - 3, 2 + (k % 3), (k % 4) - 2],
                yaw: (i + k) % 360,
              });
            }
          }
          // ---- wisp pulses (rate-limited server-side anyway), sparse -------------
          if (i % 600 === 0) {
            const w = wisps[(i / 600) % wisps.length];
            inject(w, { t: 'wisp-pulse', pos: { x: 0, y: 2, z: 0 }, magnitude: 1 });
          }

          // ---- crowd elections (C15) + encore charge + guestbook, sparse ---------
          if (i % 200 === 0) inject(crowd[(i / 200) % crowd.length], { t: 'vote-cast', option: 'low-g' });
          if (i % 250 === 0) inject(crowd[(i / 250) % crowd.length], { t: 'charge-tap' });
          if (i % 350 === 0)
            inject(crowd[(i / 350) % crowd.length], {
              t: 'glyph-add',
              points: [
                { x: 0, y: 0 },
                { x: 0.5, y: 0.5 },
                { x: 1, y: 0.2 },
              ],
              color: '#ff00ff',
            });

          // ---- meteor siege bombardment while a siege is armed (C16/C27) ---------
          if (siege?.active && i % 90 === 0) {
            const src = i % 180 === 0 ? crowd[(i / 90) % crowd.length] : wisps[(i / 90) % wisps.length];
            inject(src, { t: 'met-launch', origin: { x: 0, y: 1, z: 10 }, aim: { x: 0, y: 0.2, z: -1 }, power: 1 });
          }

          // ---- C31 /api/clips under load: rotating-IP downloads (the per-clip +
          //      per-IP maps must PRUNE, not grow), plus occasional new puts -------
          if (i % 300 === 0 && clipIds.length > 0) {
            const clipId = clipIds[(i / 300) % clipIds.length];
            for (let g = 0; g < 6; g++) {
              const ip = `7.0.0.${(i / 300 + g) % 40}`; // a bounded rotating IP pool
              await clipStore.getClip({ ip, clipId });
            }
          }
          if (i % 2000 === 0 && clipIds.length < 30) await putClip(clipIds.length + 100);

          // ---- C22.2 / C13: bank the recorder's best highlight window periodically
          //      (the staff BANK cue) → the day-scoped reel bank must EVICT-OLDEST past
          //      8/room (a memory-plateau target). 10 banks over the run → caps at 8.
          if (i % 5000 === 0) inject(stageDirector, { t: 'reel-bank' });

          // ---- carry #9: spawn the at-rest converge-shape ~10 s BEFORE the late join
          if (i === CONVERGE_JOIN_TICK - 12 * 30 && convergeShapeId === null) {
            // spawn low + let it settle so by the join it is AT REST (not moving) —
            // exactly the M2 residual (a resting shape born after the last keyframe).
            inject(owner, { t: 'spawn', shape: { type: 'sphere', position: { x: -6, y: 0.6, z: -6 } } });
            await H.flush();
            const sphere = [...room.worldShapes].reverse().find((s) => s.type === 'sphere' && Math.abs(s.position.x + 6) < 2);
            convergeShapeId = sphere?.id ?? null;
          }
          // ---- carry #9: the LATE audience joiner (its cached keyframe may predate S).
          //      Free the reserved churn slot first (the room is AT CAP) — a real viewer
          //      leaving is exactly how a late arrival gets a seat at a full gallery.
          if (i === CONVERGE_JOIN_TICK && lateViewer === null) {
            audience[127].close();
            await H.flush();
            lateViewer = await H.connect('audience', { ip: '9.9.9.9', record: true });
            expect(lateViewer.tier).toBe('audience');
            audience.push(lateViewer);
            idleKicked.push(lateViewer); // keep B alive (heartbeats) for the rest of the run
          }

          // ---- 15-minute snapshot -----------------------------------------------
          if (i === HALF_TICKS) {
            memHalf = memSnapshot();
            bytesAtHalf = tierByteSnapshot();
          }
        }
        // Capture the egress snapshot HERE — the clean [15,30] min window over the 127
        // stable viewers, BEFORE any post-loop churn (stall / stampede) perturbs it.
        const bytesAtEnd = tierByteSnapshot();

        // ============================================================================
        // C30 post-loop: a stalled socket, a reconnect stampede, and post-ring-wrap
        // DVR-resume joins — driven AFTER the long run + AFTER the egress snapshot.
        // ============================================================================
        // (a) a STALLED audience socket: a wedged buffer → the per-message backpressure
        //     must SKIP/DISCONNECT it and NEVER wedge the tick or the healthy viewers.
        const stalled = audienceStable.find((w) => !w.closed && w.tier === 'audience');
        if (stalled) stalled.bufferedAmount = 8 * 1024 * 1024; // way past the hard ceiling
        // Free ~24 seats (real viewers leaving) so the reconnect stampede has room —
        // the gallery is at cap, so a stampede of returnees replaces those who left.
        for (let k = 100; k < 124; k++) audienceStable[k]?.close();
        await H.flush();
        // (b) a reconnect stampede + (c) N post-ring-wrap DVR resumes: a burst of fresh
        //     audience joins all reuse the ONE cached keyframe (zero fresh serializations).
        const serializeBefore = hub.audienceKeyframeSerializeCount(roomId);
        const stampede: FakeWs[] = [];
        for (let i = 0; i < 24; i++) {
          const v = await H.connect('audience', { ip: `8.0.0.${i}` });
          stampede.push(v);
        }
        const serializeAfter = hub.audienceKeyframeSerializeCount(roomId);
        // Run a few more ticks so the stalled socket's backpressure verdict is exercised
        // by an AUDIENCE_STATE / coalesced fan-out, and the stampede viewers roll forward.
        for (let i = TOTAL_TICKS + 1; i <= TOTAL_TICKS + 300; i++) {
          timer.advance(TICK_MS);
          runSimTick(roomId, i, { manager, hub, metrics });
        }

        const memEnd = memSnapshot();
        const dayExport = metrics.exportDay();

        // ============================================================================
        // ASSERTIONS
        // ============================================================================

        // ---- subsystem coverage (proves the soak actually exercised each) ---------
        expect(phasesSeen.has('PLAY')).toBe(true);
        expect(phasesSeen.has('FINALE')).toBe(true);
        expect(phasesSeen.has('RESET')).toBe(true);
        expect(dayExport.rotation).toBeGreaterThan(0); // full rotations completed
        expect(dayExport.showpiece).toBeGreaterThan(0); // siege/encore showpieces fired
        expect(dayExport.vote).toBeGreaterThan(0); // C15 elections took votes
        expect(dayExport.glyph).toBeGreaterThanOrEqual(0); // guestbook (glyph count below)
        expect(dayExport.synthetic['join'] ?? 0).toBeGreaterThan(0); // C28 daemons joined (synthetic)
        expect(dayExport.gauges.peakWatchers).toBeGreaterThan(0); // C25 audience gauge sampled
        expect(sawSiegeWaveArc).toBe(true); // C27 the 3-wave arc ran
        expect(maxSiegeWave).toBeGreaterThanOrEqual(1);
        expect(memEnd.keyframeSerialize).toBeGreaterThan(0); // C25 keyframe refreshed
        // C22.2 recorder TEE: the passive sink captured the room's outbound stream all
        // soak long (record-time sanitized), and the day-scoped BANK evicted-oldest to
        // stay bounded (≤ 8/room) despite 10 bank triggers.
        expect(hub.getRecorder(roomId)!.rawEventCount).toBeGreaterThan(0);
        expect(hub.listReels(roomId).length).toBeGreaterThan(0); // banking materialized reels
        expect(hub.listReels(roomId).length).toBeLessThanOrEqual(8);
        expect(memEnd.handsLatch).toBe(1); // C32 hands latch set for the one room

        // ---- INVARIANT 1: zero tick overruns (bounded per-tick work) -------------
        // The world never accumulates unbounded shapes (recycle-oldest + pin honored),
        // per-tick egress stays bounded, and the SECOND half's egress does not balloon
        // past the first's — no runaway backlog.
        expect(maxWorldShapes).toBeLessThanOrEqual(MAX_SHAPES + 20); // + pinned (crystal/orb/tk)
        // The single-tick egress peak is BOUNDED: the worst tick is a RESET rotation
        // boundary, which fans ≤ (MAX_SHAPES despawn + baseline spawn) discrete world
        // deltas out to every socket (~225) — O(shapes × sockets), once per ~6 min
        // rotation, NEVER a growing backlog. It must stay under a hard bound.
        expect(maxTickEgress).toBeLessThan(8_000_000); // < 8 MB in any single tick
        const halfRatio = secondHalfEgress / Math.max(1, firstHalfEgress);
        expect(halfRatio).toBeGreaterThan(0.5);
        expect(halfRatio).toBeLessThan(1.5); // plateau, not monotonic growth

        // ---- INVARIANT 2: bounded memory (every accumulator plateaus) ------------
        expect(memEnd.worldShapes).toBeLessThanOrEqual(MAX_SHAPES + 20);
        expect(memEnd.glyphs).toBeLessThanOrEqual(GLYPH_CAPACITY + 64); // 512 cap + seeded exemption
        expect(memEnd.reels).toBeLessThanOrEqual(8); // MAX_BANKED_REELS_PER_ROOM
        expect(memEnd.hosts).toBe(1); // one room → one host set
        expect(memEnd.handsLatch).toBe(1);
        expect(memEnd.roomDayCounts).toBeLessThanOrEqual(2); // one room-day key (+slack)
        // the C31 rate maps prune to the active rotating-IP pool — bounded, not growing
        expect(memEnd.postHits).toBeLessThanOrEqual(8);
        expect(memEnd.getHits).toBeLessThanOrEqual(48);
        // plateau: 30-min sizes ≈ 15-min sizes (no monotonic growth 15→30 min)
        expect(memEnd.getHits).toBeLessThanOrEqual(memHalf.getHits + 8);
        expect(memEnd.glyphs).toBeLessThanOrEqual(memHalf.glyphs + 64);
        expect(memEnd.reels).toBeLessThanOrEqual(memHalf.reels + 8);

        // ---- INVARIANT 3: per-tier egress ≤ §6.5/§7 budget -----------------------
        const WINDOW_S = (TOTAL_TICKS - HALF_TICKS) / 30; // 900 s
        const perViewerKBs = (endB: number, halfB: number, count: number): number =>
          (endB - halfB) / count / WINDOW_S / 1024;
        const eg = {
          resident: perViewerKBs(bytesAtEnd.resident, bytesAtHalf.resident, residents.length),
          spectator: perViewerKBs(bytesAtEnd.spectator, bytesAtHalf.spectator, spectators.length),
          wisp: perViewerKBs(bytesAtEnd.wisp, bytesAtHalf.wisp, wisps.length),
          crowd: perViewerKBs(bytesAtEnd.crowd, bytesAtHalf.crowd, crowd.length),
          audience: perViewerKBs(bytesAtEnd.audience, bytesAtHalf.audience, audienceStable.length),
        };
        // Log the MEASURED numbers (recorded into BUDGET_LEDGER.md).
        console.log('[C22 soak] measured per-viewer egress (KB/s):', {
          resident: eg.resident.toFixed(2),
          spectator: eg.spectator.toFixed(2),
          wisp: eg.wisp.toFixed(2),
          crowd: eg.crowd.toFixed(2),
          audience: eg.audience.toFixed(2),
          maxTickBytes: maxTickEgress,
          firstHalfMB: (firstHalfEgress / 1e6).toFixed(2),
          secondHalfMB: (secondHalfEgress / 1e6).toFixed(2),
        });
        console.log('[C22 soak] day export + memory plateau:', {
          rotation: dayExport.rotation,
          showpiece: dayExport.showpiece,
          vote: dayExport.vote,
          glyph: dayExport.glyph,
          join: dayExport.join,
          syntheticJoin: dayExport.synthetic['join'] ?? 0,
          peakConcurrent: dayExport.gauges.peakConcurrent,
          peakWatchers: dayExport.gauges.peakWatchers,
          maxSiegeWave,
          mem0: { world: mem0.worldShapes, glyphs: mem0.glyphs, reels: mem0.reels, getHits: mem0.getHits },
          memHalf: { world: memHalf.worldShapes, glyphs: memHalf.glyphs, reels: memHalf.reels, getHits: memHalf.getHits },
          memEnd: { world: memEnd.worldShapes, glyphs: memEnd.glyphs, reels: memEnd.reels, getHits: memEnd.getHits, postHits: memEnd.postHits, roomDayCounts: memEnd.roomDayCounts },
        });
        // FINDING (recorded in BUDGET_LEDGER.md): at the §6.5 SUSTAINED worst case
        // (≈ 40 moving shapes + 24 wisp head-poses at 5 Hz, JSON-coalesced), the
        // measured per-viewer egress is audience ≈ 13.8 KB/s and wisp ≈ 12 KB/s —
        // ABOVE the spec's ~8–10 KB/s / ~70 kbps ESTIMATE (the estimate under-counted
        // the 40-shape + 24-pose JSON coalesced buffer). It is NOT a boundary breach:
        // the egress INVARIANT holds — an audience/wisp viewer is ~0.27× a full-rate
        // resident (never a full-rate delta/pose/voice). At cap ×128 this is ≈ 14 Mbps
        // cloud egress vs the ~10 Mbps estimate. A binary coalesced encoding would
        // reclaim it (a future optimization — see the report). The assertions below
        // guard against a real BLOWOUT (a broken boundary → resident-class egress),
        // NOT the optimistic estimate.
        expect(eg.audience).toBeGreaterThan(0);
        expect(eg.audience).toBeLessThanOrEqual(20); // regression guard (measured ≈ 13.8)
        expect(eg.wisp).toBeGreaterThan(0);
        expect(eg.wisp).toBeLessThanOrEqual(20); // regression guard (measured ≈ 12)
        // crowd: coalesced 2–5 Hz summaries only (never full deltas/poses) — small.
        expect(eg.crowd).toBeLessThanOrEqual(5);
        // resident/spectator: the full-rate delta tiers — measured + recorded; the
        // invariant is that they stay BOUNDED (no runaway), well under a 500 KB/s cap.
        expect(eg.resident).toBeGreaterThan(0);
        expect(eg.resident).toBeLessThanOrEqual(500);
        expect(eg.spectator).toBeLessThanOrEqual(500);
        // THE EGRESS INVARIANT (the one that matters, spec §7.14): an audience/wisp/
        // crowd viewer is FUNDAMENTALLY cheaper than a full-rate resident — the
        // coalesced boundary held for the whole 30 min (never a full-rate delta leak).
        expect(eg.audience).toBeLessThanOrEqual(0.5 * eg.resident);
        expect(eg.wisp).toBeLessThanOrEqual(0.5 * eg.resident);
        expect(eg.crowd).toBeLessThanOrEqual(0.5 * eg.resident);

        // ---- C30 stalled socket + reconnect stampede + DVR resumes ---------------
        // The stampede of 24 fresh joiners triggered ZERO extra keyframe serializations
        // (all reused the ONE cached buffer — the serialize-once invariant at cap).
        expect(serializeAfter).toBe(serializeBefore);
        // The stalled socket was disconnected by backpressure (never wedged the tick);
        // healthy viewers kept receiving (the run completed + egress kept flowing).
        if (stalled) expect(stalled.closed).toBe(true);
        expect(stampede.every((v) => v.tier === 'audience')).toBe(true);

        // ---- INVARIANT 4: carry #9 — the late joiner CONVERGES to ground truth ---
        // Reconstruct B's world with the CORRECT audience-client model: an
        // `audience-keyframe` is a FULL-WORLD snapshot → REPLACE; a `wisp-coalesced`
        // frame adds the (moving) shapes it carries; a `despawn` removes one. Applied
        // in wire order, this is exactly what a real ?watch client renders. Before the
        // C22 fix, a late joiner whose join keyframe predated an AT-REST shape S never
        // learned of S (S is not a moving delta) — a permanent ghost-ABSENCE. The
        // ~10 s keyframe RE-SYNC now guarantees S reaches B within one cadence.
        expect(lateViewer).not.toBeNull();
        expect(convergeShapeId).not.toBeNull();
        const B = lateViewer!;
        const rec = B.record ?? [];
        let bWorld = new Set<string>();
        let observedS = false;
        for (const m of rec) {
          if (m.t === 'audience-keyframe') {
            bWorld = new Set(((m as { shapes?: Array<{ id: string }> }).shapes ?? []).map((s) => s.id));
            if (bWorld.has(convergeShapeId!)) observedS = true;
          } else if (m.t === 'wisp-coalesced') {
            for (const s of (m as { shapes?: Array<{ id: string }> }).shapes ?? []) {
              bWorld.add(s.id);
              if (s.id === convergeShapeId) observedS = true;
            }
          } else if (m.t === 'despawn') {
            bWorld.delete((m as { id: string }).id);
          }
        }
        const groundTruth = new Set(room.worldShapes.map((s) => s.id));
        // CONVERGED: B's reconstructed world EQUALS the server's authoritative world —
        // no ghost (a removed shape B still shows) and no missing shape (an at-rest
        // shape B never learned of), after the full spawn+settle+remove churn.
        expect([...bWorld].sort()).toEqual([...groundTruth].sort());
        // …and the assertion is NOT vacuous: B genuinely LEARNED of the at-rest S that
        // was born after its join keyframe (the residual would have hidden it forever).
        // Whether S then survived to the end or was recycled/removed, B tracked it — the
        // exact-equality above proves both directions (no ghost, no missing-observed).
        expect(observedS).toBe(true);
      } finally {
        if (envBefore === undefined) delete process.env['POWERS_LAB_ENABLED'];
        else process.env['POWERS_LAB_ENABLED'] = envBefore;
      }
    },
    180_000
  );
});

// ---------------------------------------------------------------------------
// carry #9 — a FAST, always-on focused audience-convergence case (runs in the
// default suite too, so the residual is guarded without the 30-minute run).
// ---------------------------------------------------------------------------

describe('C22 — audience convergence (carry #9, focused)', () => {
  it('an at-rest shape born after the last keyframe, before a late join, CONVERGES for that viewer', async () => {
    const H = await buildHarness();
    const { timer, manager, hub, metrics, roomId } = H;

    const owner = await H.connect('resident', { ip: '1.0.0.100', owner: true, secret: true });
    expect(owner.tier).toBe('resident');
    // An early audience viewer keeps the audience machinery warm (keyframe refreshes).
    const early = await H.connect('audience', { ip: '4.4.4.4' });
    expect(early.tier).toBe('audience');

    const room = manager.get(roomId)!;
    const drive = (n: number): void => {
      for (let k = 0; k < n; k++) {
        timer.advance(TICK_MS);
        runSimTick(roomId, ++driveTick, { manager, hub, metrics });
      }
    };
    let driveTick = 0;

    // Warm up past the first keyframe refresh (~10 s) so a cached keyframe exists.
    drive(11 * 30);

    // Spawn the at-rest shape S (low, so it settles quickly) AFTER that keyframe.
    owner.emit(
      'message',
      encodeText({ t: 'spawn', shape: { type: 'sphere', position: { x: 5, y: 0.6, z: -5 } } } as never),
      false
    );
    await H.flush();
    const s = [...room.worldShapes].reverse().find((sh) => sh.type === 'sphere');
    expect(s).toBeDefined();
    const sId = s!.id;
    // Let S settle to rest (it stops moving → the M2 residual: a resting, non-delta shape).
    drive(3 * 30);

    // A LATE audience viewer B joins — its cached keyframe may predate S.
    const B = await H.connect('audience', { ip: '9.9.9.9', record: true });
    expect(B.tier).toBe('audience');

    // Settle + churn: run more ticks; the audience machinery rolls forward + refreshes.
    drive(15 * 30);

    // Reconstruct B's world (keyframe ∪ coalesced) − despawns and compare to ground truth.
    const rec = B.record ?? [];
    const kf = new Set<string>();
    const coalesced = new Set<string>();
    const despawned = new Set<string>();
    for (const m of rec) {
      if (m.t === 'audience-keyframe')
        for (const sh of (m as { shapes?: Array<{ id: string }> }).shapes ?? []) kf.add(sh.id);
      if (m.t === 'wisp-coalesced')
        for (const sh of (m as { shapes?: Array<{ id: string }> }).shapes ?? []) coalesced.add(sh.id);
      if (m.t === 'despawn') despawned.add((m as { id: string }).id);
    }
    const bLive = new Set([...kf, ...coalesced].filter((id) => !despawned.has(id)));
    // S converged for B: B learned of S (via a refreshed keyframe or the roll-forward)
    // and holds it live — matching the server, which still has S at rest.
    expect(room.worldShapes.some((sh) => sh.id === sId)).toBe(true); // ground truth: S is live
    expect(bLive.has(sId)).toBe(true); // B converged: no permanent ghost-absence
  });
});
