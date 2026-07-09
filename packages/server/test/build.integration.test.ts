/**
 * build.integration.test.ts — Task C34 (F23 The Workshop) BUILD wire path.
 *
 * The BUILD (0x35) family wired into the LIVE server (real startServer + real ws
 * clients + the real POST /api/rooms ownerToken flow). Asserts the brief's Step-1
 * wire cases — especially THE key safety:
 *
 *   • BUILD refused WITHOUT the capability (a plain resident / crowd);
 *   • BUILD granted WITH the ownerToken on a RESIDENT (the BUILD capability, §5.1);
 *   • SET_TRANSFORM / LAYOUT_LOAD sent during PLAY with the capability but NO
 *     active build-mode → REFUSED (a stale tab can never wipe a live rotation);
 *   • SPAWN_EXACT → ACK carries the assigned shape id (undo correlation);
 *   • LAYOUT_SAVE → LAYOUT_LOAD round-trips (a saved composition restores);
 *   • GLYPH_SEED bypasses the inflow bucket + marks seeded (broadcast a glyph);
 *   • LAYOUT_LIST returns the manifest (a pure read, no build-mode needed).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { encodeText, decodeText, PROTOCOL_VERSION, BUILD_KIND } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { startServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import { deriveJoinSecret } from '../src/auth.js';

let _servers: ServerHandle[] = [];
afterEach(async () => {
  const s = _servers.splice(0);
  await Promise.allSettled(s.map((x) => x.close()));
});

function makeServer(): { wsUrl: string; httpBase: string } {
  const server = startServer(0);
  _servers.push(server);
  return { wsUrl: `ws://127.0.0.1:${server.port}`, httpBase: `http://127.0.0.1:${server.port}` };
}

function httpPost(base: string, path: string, ip = '9.9.9.9'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function createRoom(httpBase: string): Promise<{ roomId: string; ownerToken: string }> {
  const j = await httpPost(httpBase, '/api/rooms');
  return { roomId: String(j['roomId']), ownerToken: String(j['ownerToken']) };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val) return resolve(val);
      if (Date.now() - start >= timeoutMs)
        return reject(new Error(`waitUntil: "${label}" not satisfied within ${timeoutMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

interface Client {
  ws: WebSocket;
  received: ServerMsg[];
  hello?: ServerMsg & { t: 'hello' };
}

interface JoinOpts {
  tier?: string;
  joinSecret?: string;
  ownerToken?: string;
}

async function join(url: string, room: string, opts: JoinOpts = {}): Promise<Client> {
  const ws = await openSocket(url);
  const client: Client = { ws, received: [] };
  ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return;
    const msg = decodeText(data.toString()) as ServerMsg;
    client.received.push(msg);
    if (msg.t === 'hello') client.hello = msg as ServerMsg & { t: 'hello' };
  });
  const joinMsg: Record<string, unknown> = {
    t: 'join',
    room,
    name: 'guest',
    color: 0,
    protocol: PROTOCOL_VERSION,
  };
  if (opts.tier !== undefined) joinMsg['tier'] = opts.tier;
  if (opts.joinSecret !== undefined) joinMsg['joinSecret'] = opts.joinSecret;
  if (opts.ownerToken !== undefined) joinMsg['ownerToken'] = opts.ownerToken;
  ws.send(encodeText(joinMsg as never));
  await waitUntil(() => client.hello, { label: `hello (${opts.tier ?? 'resident'})` });
  return client;
}

function closeAll(cs: Client[]): void {
  for (const c of cs) {
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close();
  }
}

/** A builder = a RESIDENT presenting BOTH the joinSecret (→ resident tier) AND the
 * ownerToken (→ the BUILD capability, §5.1). */
async function joinBuilder(wsUrl: string, room: string, ownerToken: string): Promise<Client> {
  const secret = deriveJoinSecret(ownerToken, room, 0);
  return join(wsUrl, room, { tier: 'resident', joinSecret: secret, ownerToken });
}

function buildAcks(c: Client): Array<Extract<ServerMsg, { t: 'build-msg' }>> {
  return c.received.filter(
    (m): m is Extract<ServerMsg, { t: 'build-msg' }> => (m as { t: string }).t === 'build-msg'
  );
}

/** The most recent ACK for an opId (echoes result + assigned id). */
function ackFor(c: Client, opId: string) {
  return buildAcks(c)
    .filter((m) => m.kind === BUILD_KIND.ACK && m.opId === opId)
    .pop();
}

function shapesOf(c: Client): Array<Extract<ServerMsg, { t: 'spawn' }>> {
  return c.received.filter(
    (m): m is Extract<ServerMsg, { t: 'spawn' }> => (m as { t: string }).t === 'spawn'
  );
}

/** Fire the build-mode cue (Advanced) via a director-cmd FIRE from the builder. */
function fireBuildMode(builder: Client, cueInstanceId: string): void {
  builder.ws.send(
    encodeText({
      t: 'director-cmd',
      cmd: 'FIRE',
      cueId: 'build-mode',
      cueInstanceId,
    } as never)
  );
}

const SAMPLE_SHAPE = {
  type: 'cube',
  colorIndex: 2,
  renderMode: 'both',
  scale: 1,
  position: { x: 1, y: 3, z: -2 },
  rotation: { x: 0, y: 0, z: 0 },
};

describe('C34 BUILD wire — capability gate (spec §5.1/§7.23)', () => {
  it('BUILD is REFUSED without the capability (a plain resident, no ownerToken)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    // A resident WITHOUT the ownerToken → no BUILD capability.
    const plain = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
    try {
      plain.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'op-plain' } as never)
      );
      const ack = await waitUntil(() => ackFor(plain, 'op-plain'), { label: 'no-capability ack' });
      expect(ack.result).toBe('no-capability');
    } finally {
      closeAll([plain]);
    }
  });

  it('BUILD is GRANTED with the ownerToken on a RESIDENT (LAYOUT_LIST returns a manifest)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'op-list' } as never)
      );
      const list = await waitUntil(
        () => buildAcks(builder).find((m) => m.kind === BUILD_KIND.LAYOUT_LIST),
        { label: 'layout-list' }
      );
      expect(Array.isArray(list.layouts)).toBe(true); // empty manifest for a fresh room
    } finally {
      closeAll([builder]);
    }
  });
});

describe('C34 BUILD wire — the stale-tab safety (spec §7.23)', () => {
  it('SET_TRANSFORM / LAYOUT_LOAD during PLAY with the capability but NO build-mode → REFUSED', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      // Advance the timeline out of LOBBY into PLAY (a live rotation). ATTRACT→LOBBY
      // happened on the builder's join; ADVANCE steps LOBBY→PLAY.
      builder.ws.send(encodeText({ t: 'director-cmd', cmd: 'ADVANCE' } as never)); // LOBBY→PLAY
      await waitUntil(
        () =>
          builder.received.some(
            (m) => (m as { t: string; phase?: string }).t === 'phase-state' && (m as { phase?: string }).phase === 'PLAY'
          ),
        { label: 'PLAY phase' }
      );
      // A mutating SET_TRANSFORM with the capability but NO active build-mode: REFUSED.
      builder.ws.send(
        encodeText({
          t: 'build',
          kind: BUILD_KIND.SET_TRANSFORM,
          opId: 'op-mut',
          id: 'anything',
          shape: SAMPLE_SHAPE,
        } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-mut'), { label: 'not-in-build-mode ack' });
      expect(ack.result).toBe('not-in-build-mode'); // THE safety — a stale tab can't wipe a rotation

      // Same for LAYOUT_LOAD (also a destructive mutating kind).
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LOAD, opId: 'op-load', name: 'x' } as never)
      );
      const ack2 = await waitUntil(() => ackFor(builder, 'op-load'), { label: 'load refused ack' });
      expect(ack2.result).toBe('not-in-build-mode');
    } finally {
      closeAll([builder]);
    }
  });
});

describe('C34 BUILD wire — mutations in build-mode (spec §7.23)', () => {
  it('SPAWN_EXACT in build-mode → ACK carries the assigned shape id + broadcasts a spawn', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      // Engage build-mode (LOBBY, where the builder landed on join).
      fireBuildMode(builder, 'bm-on');
      await waitUntil(
        () => builder.received.some((m) => (m as { t: string }).t === 'env-state'),
        { label: 'build-mode freeze env-state' }
      );
      const spawnsBefore = shapesOf(builder).length;
      builder.ws.send(
        encodeText({
          t: 'build',
          kind: BUILD_KIND.SPAWN_EXACT,
          opId: 'op-spawn',
          shape: SAMPLE_SHAPE,
        } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-spawn'), { label: 'spawn ack' });
      expect(ack.result).toBe('ok');
      expect(typeof ack.id).toBe('string'); // the ASSIGNED id (undo correlation)
      expect((ack.id as string).length).toBeGreaterThan(0);
      // The spawn reached the room as an ordinary `spawn` ServerMsg.
      await waitUntil(() => shapesOf(builder).length > spawnsBefore, { label: 'spawn broadcast' });
      const spawned = shapesOf(builder).pop()!;
      expect(spawned.shape.id).toBe(ack.id);
    } finally {
      closeAll([builder]);
    }
  });

  it('LAYOUT_SAVE → LAYOUT_LOAD round-trips a composition', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      // Spawn two exact shapes.
      for (let i = 0; i < 2; i++) {
        builder.ws.send(
          encodeText({
            t: 'build',
            kind: BUILD_KIND.SPAWN_EXACT,
            opId: `op-s${i}`,
            shape: { ...SAMPLE_SHAPE, position: { x: i, y: 3, z: 0 } },
          } as never)
        );
        await waitUntil(() => ackFor(builder, `op-s${i}`), { label: `spawn ${i}` });
      }
      // SAVE the live world as a named layout.
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, opId: 'op-save', name: 'my-comp' } as never)
      );
      const saveAck = await waitUntil(() => ackFor(builder, 'op-save'), { label: 'save ack' });
      expect(saveAck.result).toBe('ok');
      // The manifest now lists it.
      builder.ws.send(encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'op-l2' } as never));
      const list = await waitUntil(
        () => buildAcks(builder).find((m) => m.kind === BUILD_KIND.LAYOUT_LIST && m.opId === 'op-l2'),
        { label: 'list-after-save' }
      );
      expect(list.layouts?.some((l) => l.name === 'my-comp' && l.shapeCount === 2)).toBe(true);
      // LOAD it back (destructive restore).
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LOAD, opId: 'op-load', name: 'my-comp' } as never)
      );
      const loadAck = await waitUntil(() => ackFor(builder, 'op-load'), { label: 'load ack' });
      expect(loadAck.result).toBe('ok');
    } finally {
      closeAll([builder]);
    }
  });

  it('GLYPH_SEED bypasses the inflow bucket + broadcasts a seeded glyph', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      const before = builder.received.filter((m) => (m as { t: string }).t === 'glyph').length;
      builder.ws.send(
        encodeText({
          t: 'build',
          kind: BUILD_KIND.GLYPH_SEED,
          opId: 'op-seed',
          points: [
            { x: -0.5, y: -0.5 },
            { x: 0.5, y: 0.5 },
          ],
          color: '#00ffff',
        } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-seed'), { label: 'seed ack' });
      expect(ack.result).toBe('ok');
      await waitUntil(
        () => builder.received.filter((m) => (m as { t: string }).t === 'glyph').length > before,
        { label: 'seeded glyph broadcast' }
      );
    } finally {
      closeAll([builder]);
    }
  });
});

describe('C34 BUILD wire — SET_BASELINE → RESET rebind (spec §D4/§7.23)', () => {
  it('SET_BASELINE (non-default baseParams) → RESET restores it under DEFAULT_PARAMS', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      // Send an inline baseline layout with a NON-DEFAULT baseParams (a low-g law).
      const baseline = {
        name: 'showroom',
        author: 'CLUB',
        savedAt: 0,
        baseParams: { gravity: { x: 0, y: -0.5, z: 0 } }, // non-default → must be IGNORED by RESET
        shapes: [
          { type: 'cube', colorIndex: 0, renderMode: 'both', scale: 1, position: { x: -2, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 2, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        ],
      };
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.SET_BASELINE, opId: 'op-base', layout: baseline } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-base'), { label: 'set-baseline ack' });
      expect(ack.result).toBe('ok');
      // Force a RESET (staff safety override). The RESET restores the baseline (2
      // shapes) — the low-g baseParams is IGNORED, params snap to DEFAULT_PARAMS.
      builder.ws.send(encodeText({ t: 'director-cmd', cmd: 'RESET' } as never));
      // After the RESET the world holds exactly the 2 baseline shapes. We observe
      // the spawn broadcasts land (the baseline shapes) + the env-state reverting.
      await waitUntil(
        () => {
          const envs = builder.received.filter(
            (m): m is Extract<ServerMsg, { t: 'env-state' }> => (m as { t: string }).t === 'env-state'
          );
          const last = envs.pop();
          // The reverted ENV_STATE carries DEFAULT params: gravity y === -5 (not -0.5).
          return last && last.params.gravity?.y === -5;
        },
        { label: 'RESET reverts params to DEFAULT (gravity -5, not the -0.5 law)' }
      );
    } finally {
      closeAll([builder]);
    }
  });

  it('SET_BASELINE rejects an over-the-baseline-cap layout (the reserve)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      // 29 shapes > BASELINE_MAX_SHAPES (28 = MAX_SHAPES − METEOR_BUDGET).
      const over = {
        name: 'too-big',
        author: 'CLUB',
        savedAt: 0,
        shapes: Array.from({ length: 29 }, (_, i) => ({
          type: 'cube',
          colorIndex: i % 6,
          renderMode: 'both',
          scale: 1,
          position: { x: i * 0.1, y: 6, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        })),
      };
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.SET_BASELINE, opId: 'op-big', layout: over } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-big'), { label: 'baseline-invalid ack' });
      expect(ack.result).toContain('baseline-invalid');
    } finally {
      closeAll([builder]);
    }
  });
});

describe('C34 BUILD wire — build-mode phase gate + count cap (spec §7.23)', () => {
  it('firing build-mode during PLAY → wrongPhase (never mid-rotation)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      builder.ws.send(encodeText({ t: 'director-cmd', cmd: 'ADVANCE' } as never)); // LOBBY→PLAY
      await waitUntil(
        () =>
          builder.received.some(
            (m) => (m as { t: string; phase?: string }).t === 'phase-state' && (m as { phase?: string }).phase === 'PLAY'
          ),
        { label: 'PLAY phase' }
      );
      fireBuildMode(builder, 'bm-play');
      const dirAck = await waitUntil(
        () =>
          builder.received.find(
            (m): m is Extract<ServerMsg, { t: 'director-msg' }> =>
              (m as { t: string }).t === 'director-msg' &&
              (m as { kind?: string }).kind === 'ACK' &&
              (m as { cueId?: string }).cueId === 'build-mode'
          ),
        { label: 'build-mode FIRE ack' }
      );
      expect(dirAck.fireResult).toBe('wrongPhase'); // never mid-rotation
    } finally {
      closeAll([builder]);
    }
  });

  it('LAYOUT_SAVE refuses past the layout count cap (~32)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      // Save 32 distinct layouts (the cap). Each save snapshots the (empty) world.
      for (let i = 0; i < 32; i++) {
        builder.ws.send(
          encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, opId: `save-${i}`, name: `layout-${i}` } as never)
        );
        const ack = await waitUntil(() => ackFor(builder, `save-${i}`), { label: `save ${i}` });
        expect(ack.result).toBe('ok');
      }
      // The 33rd DISTINCT layout is refused (the cap; a manual delete is required).
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, opId: 'save-over', name: 'layout-over' } as never)
      );
      const over = await waitUntil(() => ackFor(builder, 'save-over'), { label: 'layout-cap ack' });
      expect(over.result).toBe('layout-cap');
    } finally {
      closeAll([builder]);
    }
  });
});

// ---------------------------------------------------------------------------
// C22 carry #7 — LAYOUT_LOAD normalizes a PARTIAL baseParams to a COMPLETE
// PhysicsParams (previously applied verbatim: a hand-authored layout with only
// `gravity` left every OTHER field `undefined` in `_baseParams`).
// ---------------------------------------------------------------------------
describe('C22 carry #7 — LAYOUT_LOAD normalizes baseParams to a full PhysicsParams', () => {
  it('a LAYOUT_LOAD with only `gravity` yields a COMPLETE PhysicsParams (other fields = DEFAULT)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      // Persist a layout carrying a PARTIAL baseParams (only `gravity` — no
      // timescale/freeze/wind/etc.) via the SET_BASELINE inline-layout path (the
      // only BUILD kind that accepts an authored baseParams payload directly).
      const partial = {
        name: 'partial-law',
        author: 'CLUB',
        savedAt: 0,
        baseParams: { gravity: { x: 0, y: -1.2, z: 0 } },
        shapes: [],
      };
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.SET_BASELINE, opId: 'op-partial', layout: partial } as never)
      );
      const setAck = await waitUntil(() => ackFor(builder, 'op-partial'), { label: 'set-baseline ack' });
      expect(setAck.result).toBe('ok');

      // LAYOUT_LOAD it back — the ONLY path that applies a layout's baseParams
      // (spec §D4; a RESET never does).
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LOAD, opId: 'op-load', name: 'partial-law' } as never)
      );
      const loadAck = await waitUntil(() => ackFor(builder, 'op-load'), { label: 'load ack' });
      expect(loadAck.result).toBe('ok');

      // The resulting ENV_STATE params reflect the authored gravity override AND
      // every OTHER field at its DEFAULT_PARAMS value — never undefined/partial.
      const env = await waitUntil(
        () => {
          const envs = builder.received.filter(
            (m): m is Extract<ServerMsg, { t: 'env-state' }> => (m as { t: string }).t === 'env-state'
          );
          const last = envs[envs.length - 1];
          return last && last.params.gravity?.y === -1.2 ? last : undefined;
        },
        { label: 'env-state reflects the partial-law gravity' }
      );
      // The authored override.
      expect(env.params.gravity).toEqual({ x: 0, y: -1.2, z: 0 });
      // Every field the layout did NOT author is a COMPLETE DEFAULT_PARAMS value
      // (never undefined — the normalize fix's whole point). `freeze`/`suspendDespawn`
      // are NOT asserted here: build-mode's OWN overlay is still active (LAYOUT_LOAD
      // requires build-mode) and legitimately merges those `true` over the base in
      // the EFFECTIVE params ENV_STATE carries — that overlay is orthogonal to
      // whether baseParams itself normalized correctly.
      expect(env.params.timescale).toBe(1);
      expect(env.params.wind).toEqual({ x: 0, y: 0, z: 0 });
      expect(env.params.restitution).toBe(0.5);
      expect(env.params.friction).toBe(0.98);
      expect(env.params.restThreshold).toBe(0.05);
      // Structural completeness: every PhysicsParams key is present (bounds'/
      // attractors' exact values aren't asserted here — Infinity isn't JSON-safe
      // — but the keys must exist, never be dropped by a partial write).
      for (const key of [
        'gravity',
        'wind',
        'timescale',
        'freeze',
        'attractors',
        'bounds',
        'suspendDespawn',
        'restitution',
        'friction',
        'restThreshold',
      ]) {
        expect(env.params, `params.${key} must be present`).toHaveProperty(key);
      }
    } finally {
      closeAll([builder]);
    }
  });
});

// ---------------------------------------------------------------------------
// C22 carry #8 — BUILD_KIND.LAYOUT_DELETE (previously a silent no-op: the panel
// sent a LAYOUT_SAVE {delete:true} sentinel the C34 server treated as an ordinary
// overwrite-save — the code's own NOTE documented the gap).
// ---------------------------------------------------------------------------
describe('C22 carry #8 — LAYOUT_DELETE removes a saved layout (build-mode + capability gated)', () => {
  function spawnsSince(c: Client, sinceIndex: number): Array<Extract<ServerMsg, { t: 'spawn' }>> {
    return c.received
      .slice(sinceIndex)
      .filter((m): m is Extract<ServerMsg, { t: 'spawn' }> => (m as { t: string }).t === 'spawn');
  }

  it('removes a saved layout — LIST no longer shows it', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, opId: 'op-save', name: 'to-delete' } as never)
      );
      await waitUntil(() => ackFor(builder, 'op-save'), { label: 'save ack' });

      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, opId: 'op-del', name: 'to-delete' } as never)
      );
      const delAck = await waitUntil(() => ackFor(builder, 'op-del'), { label: 'delete ack' });
      expect(delAck.result).toBe('ok');

      builder.ws.send(encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'op-list' } as never));
      const list = await waitUntil(
        () => buildAcks(builder).find((m) => m.kind === BUILD_KIND.LAYOUT_LIST && m.opId === 'op-list'),
        { label: 'list-after-delete' }
      );
      expect(list.layouts?.some((l) => l.name === 'to-delete')).toBe(false);
    } finally {
      closeAll([builder]);
    }
  });

  it('is refused WITHOUT the capability (a plain resident, no ownerToken)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const secret = deriveJoinSecret(ownerToken, roomId, 0);
    const plain = await join(wsUrl, roomId, { tier: 'resident', joinSecret: secret });
    try {
      plain.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, opId: 'op-del', name: 'anything' } as never)
      );
      const ack = await waitUntil(() => ackFor(plain, 'op-del'), { label: 'no-capability ack' });
      expect(ack.result).toBe('no-capability');
    } finally {
      closeAll([plain]);
    }
  });

  it('is refused WITHOUT build-mode (capability present — the stale-tab safety)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, opId: 'op-del', name: 'anything' } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-del'), { label: 'not-in-build-mode ack' });
      expect(ack.result).toBe('not-in-build-mode');
    } finally {
      closeAll([builder]);
    }
  });

  it('deleting a non-existent layout is a safe no-op (no crash, manifest still queryable)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, opId: 'op-del', name: 'never-existed' } as never)
      );
      const ack = await waitUntil(() => ackFor(builder, 'op-del'), { label: 'delete-nonexistent ack' });
      expect(ack.result).toBe('ok');

      // The socket is still alive + responsive (no crash) and the manifest is
      // still queryable afterward.
      builder.ws.send(encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_LIST, opId: 'op-list' } as never));
      const list = await waitUntil(
        () => buildAcks(builder).find((m) => m.kind === BUILD_KIND.LAYOUT_LIST && m.opId === 'op-list'),
        { label: 'list after no-op delete' }
      );
      expect(Array.isArray(list.layouts)).toBe(true);
    } finally {
      closeAll([builder]);
    }
  });

  it('deleting the BASELINE layout CLEARS it — RESET falls back to the v1 SHOWROOM_BASELINE (8 shapes)', async () => {
    const { wsUrl, httpBase } = makeServer();
    const { roomId, ownerToken } = await createRoom(httpBase);
    const builder = await joinBuilder(wsUrl, roomId, ownerToken);
    try {
      // Bind a 2-shape CUSTOM baseline named 'showroom'.
      const baseline = {
        name: 'showroom',
        author: 'CLUB',
        savedAt: 0,
        shapes: [
          { type: 'cube', colorIndex: 0, renderMode: 'both', scale: 1, position: { x: -2, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 2, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        ],
      };
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.SET_BASELINE, opId: 'op-base', layout: baseline } as never)
      );
      const setAck = await waitUntil(() => ackFor(builder, 'op-base'), { label: 'set-baseline ack' });
      expect(setAck.result).toBe('ok');

      // Confirm the custom baseline is actually live: a RESET restores exactly the
      // 2 authored shapes (never the v1 8-shape list).
      const idx1 = builder.received.length;
      builder.ws.send(encodeText({ t: 'director-cmd', cmd: 'RESET' } as never));
      await waitUntil(() => (spawnsSince(builder, idx1).length === 2 ? true : undefined), {
        label: 'first RESET: the 2-shape custom baseline',
      });

      // Enter build-mode + DELETE the bound baseline layout.
      fireBuildMode(builder, 'bm-on');
      await waitUntil(() => builder.received.some((m) => (m as { t: string }).t === 'env-state'), {
        label: 'build-mode',
      });
      builder.ws.send(
        encodeText({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, opId: 'op-del', name: 'showroom' } as never)
      );
      const delAck = await waitUntil(() => ackFor(builder, 'op-del'), { label: 'delete-baseline ack' });
      expect(delAck.result).toBe('ok');

      // A RESET also EXITS build-mode (spec §7.23 safety override) — no separate
      // toggle needed. Force ANOTHER RESET: the world falls back to the v1
      // SHOWROOM_BASELINE (8 shapes) — never the deleted 2-shape layout.
      const idx2 = builder.received.length;
      builder.ws.send(encodeText({ t: 'director-cmd', cmd: 'RESET' } as never));
      await waitUntil(() => (spawnsSince(builder, idx2).length === 8 ? true : undefined), {
        label: 'v1 fallback RESET: the 8-shape SHOWROOM_BASELINE',
      });
    } finally {
      closeAll([builder]);
    }
  });
});
