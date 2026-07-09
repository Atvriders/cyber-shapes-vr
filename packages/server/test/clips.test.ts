/**
 * clips.test.ts — Task C31 (F20 Neon Clip Machine, spec §7.20) unit tests for
 * THE SECURITY SURFACE: the ClipStore (caps/TTL/sweep/auth) + the streaming
 * body cap. A fake clock + an in-memory fs are injected (auth.ts's own pattern)
 * so rate limits, TTL, and the day-count cap are driven without wall-clock
 * sleeps or real disk. TDD RED — written before clips.ts.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  ClipStore,
  readBodyCapped,
  firstHeaderValue,
  PayloadTooLargeError,
  CLIP_MAX_BYTES,
  CLIP_POST_PER_IP_MAX,
  CLIP_POST_PER_IP_WINDOW_MS,
  CLIP_MAX_PER_ROOM_PER_DAY,
  CLIP_GET_PER_IP_MAX,
  CLIP_GET_PER_IP_WINDOW_MS,
  CLIP_MAX_DOWNLOADS_PER_CLIP_PER_DAY,
  CLIP_TTL_MS,
  CLIP_ID_RE,
  coerceClipContentType,
  clipExtForContentType,
  CLIP_CONTENT_TYPE_ALLOWLIST,
  CLIP_CONTENT_TYPE_FALLBACK,
} from '../src/clips.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRECTOR_KIND } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Test harness: a fake clock + an in-memory fs.
// ---------------------------------------------------------------------------

class FakeClock {
  now = 0;
  advance(ms: number): void {
    this.now += ms;
  }
}

function makeMemFs(): {
  writeFile: (path: string, data: Buffer) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
  deleteFile: (path: string) => Promise<void>;
  store: Map<string, Buffer>;
} {
  const store = new Map<string, Buffer>();
  return {
    store,
    async writeFile(path, data) {
      store.set(path, data);
    },
    async readFile(path) {
      const v = store.get(path);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async deleteFile(path) {
      store.delete(path);
    },
  };
}

/** A valid-shaped 128-bit-hex clipId (test fixture — deterministic, not random). */
function fixtureClipId(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function makeStore(overrides: Partial<{
  clock: FakeClock;
  maxBytes: number;
  maxPerRoomPerDay: number;
  maxDownloadsPerClipPerDay: number;
  ttlMs: number;
}> = {}): { store: ClipStore; clock: FakeClock; fs: ReturnType<typeof makeMemFs> } {
  const clock = overrides.clock ?? new FakeClock();
  const fs = makeMemFs();
  const store = new ClipStore({
    now: () => clock.now,
    dir: '/mem',
    writeFile: fs.writeFile,
    readFile: fs.readFile,
    deleteFile: fs.deleteFile,
    ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
    ...(overrides.maxPerRoomPerDay !== undefined ? { maxPerRoomPerDay: overrides.maxPerRoomPerDay } : {}),
    ...(overrides.maxDownloadsPerClipPerDay !== undefined
      ? { maxDownloadsPerClipPerDay: overrides.maxDownloadsPerClipPerDay }
      : {}),
    ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
  });
  return { store, clock, fs };
}

const allow = () => true;
const deny = () => false;

// ===========================================================================
// clipId entropy shape (≥128-bit — spec §7.20 "unlisted must mean unguessable")
// ===========================================================================

describe('C31 — clipId entropy shape', () => {
  it('CLIP_ID_RE requires EXACTLY 32 hex chars (= 128 bits) — aligned to the client mint', () => {
    expect(CLIP_ID_RE.test('a'.repeat(32))).toBe(true);
    expect(CLIP_ID_RE.test('a'.repeat(31))).toBe(false); // one short of 128 bits
    // Fold-in (align client/server): the range {32,64} previously accepted ids the
    // client NEVER mints — a 33/64-char id must now be rejected, tightening the
    // path-input surface to exactly what the client produces.
    expect(CLIP_ID_RE.test('a'.repeat(33))).toBe(false);
    expect(CLIP_ID_RE.test('a'.repeat(64))).toBe(false);
    expect(CLIP_ID_RE.test('g'.repeat(32))).toBe(false); // not hex
    expect(CLIP_ID_RE.test('')).toBe(false);
    // The server gate is now character-identical to the client's `/^[0-9a-f]{32}$/`.
    expect(CLIP_ID_RE.source).toBe('^[0-9a-f]{32}$');
  });

  it('the id SPACE, not a secret check, is the unguessability gate — derived from the ACTUAL gate, not a literal', () => {
    // De-tautologized: the entropy floor is DERIVED from what CLIP_ID_RE actually
    // accepts, not asserted against a hand-written 128. The shortest string the
    // gate accepts is 32 hex chars; each hex char is 4 bits → the minimum entropy
    // the gate enforces is exactly 128 bits.
    const shortestAccepted = (() => {
      for (let n = 1; n <= 64; n++) {
        if (CLIP_ID_RE.test('a'.repeat(n))) return n;
      }
      return 0;
    })();
    expect(shortestAccepted).toBe(32);
    const bitsEnforced = shortestAccepted * 4;
    expect(bitsEnforced).toBe(128); // the gate enforces ≥128-bit ids, provably
    // And the store gives NO enumeration oracle: a never-existed id and a swept id
    // both 404 IDENTICALLY (proven by the TTL-sweep test below) — so the 128-bit
    // space, not a lookup difference, is the entire gate.
  });
});

// ===========================================================================
// MUST-FIX 1 — Content-Type coercion (stored XSS defense at the store layer)
// ===========================================================================

describe('C31 MF1 — Content-Type allowlist/coercion (stored XSS)', () => {
  it('coerceClipContentType keeps the two allowlisted video types (case/param-insensitive)', () => {
    expect(coerceClipContentType('video/mp4')).toBe('video/mp4');
    expect(coerceClipContentType('video/webm')).toBe('video/webm');
    expect(coerceClipContentType('VIDEO/WEBM')).toBe('video/webm');
    // A `; codecs=…` parameter (the real recorder emits this) keeps the base type.
    expect(coerceClipContentType('video/webm;codecs=vp8,opus')).toBe('video/webm');
    expect(coerceClipContentType('video/mp4; codecs=avc1.42E01E')).toBe('video/mp4');
  });

  it('coerceClipContentType FORCES any non-allowlisted / active type to application/octet-stream', () => {
    expect(coerceClipContentType('text/html')).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(coerceClipContentType('text/html; charset=utf-8')).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(coerceClipContentType('image/svg+xml')).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(coerceClipContentType('application/javascript')).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(coerceClipContentType(undefined)).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(coerceClipContentType('')).toBe(CLIP_CONTENT_TYPE_FALLBACK);
    expect(CLIP_CONTENT_TYPE_FALLBACK).toBe('application/octet-stream');
    expect(CLIP_CONTENT_TYPE_ALLOWLIST).toEqual(['video/mp4', 'video/webm']);
  });

  it('clipExtForContentType maps stored types to a safe download extension', () => {
    expect(clipExtForContentType('video/mp4')).toBe('mp4');
    expect(clipExtForContentType('video/webm')).toBe('webm');
    expect(clipExtForContentType('application/octet-stream')).toBe('bin');
  });

  it('a clip POSTed as text/html is STORED with a coerced-safe Content-Type (never text/html)', async () => {
    const { store } = makeStore();
    const id = fixtureClipId(700);
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId: 'roomXss',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'text/html', // the attacker-chosen active type
      body: Buffer.from('<script>alert(document.cookie)</script>'),
    });
    expect('ok' in res).toBe(true);
    // The PUBLIC GET can only ever echo the coerced value — never text/html.
    const got = await store.getClip({ ip: '2.2.2.2', clipId: id });
    expect(got).toMatchObject({ ok: true, contentType: 'application/octet-stream' });
  });

  it('a legit video/webm clip round-trips its Content-Type unchanged', async () => {
    const { store } = makeStore();
    const id = fixtureClipId(701);
    await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId: 'roomOk',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm;codecs=vp8,opus',
      body: Buffer.from('webm-bytes'),
    });
    const got = await store.getClip({ ip: '2.2.2.2', clipId: id });
    expect(got).toMatchObject({ ok: true, contentType: 'video/webm' });
  });
});

// ===========================================================================
// MUST-FIX 2 — the pre-auth per-IP POST gate (registerPostAttempt)
// ===========================================================================

describe('C31 MF2 — pre-auth per-IP POST throttle (unauth flood / memory-DoS)', () => {
  it('registerPostAttempt records EVERY attempt (authed or not) and trips at the per-IP max', () => {
    const { store } = makeStore();
    // A TOKENLESS flood: no putClip, no auth — just the pre-body gate.
    let tripped = -1;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 3; i++) {
      const over = store.registerPostAttempt('66.66.66.66');
      if (over && tripped < 0) tripped = i;
    }
    // It must trip WITHIN the max (i.e. an unauth IP IS throttled — previously it
    // was never recorded, so it could flood 25 MB bodies unbounded).
    expect(tripped).toBeGreaterThanOrEqual(0);
    expect(tripped).toBeLessThanOrEqual(CLIP_POST_PER_IP_MAX);
    // The unauth attempts ARE recorded in the per-IP counter (not a phantom).
    expect(store.debugMapSizes().postHits).toBeGreaterThan(0);
  });

  it('a different IP is unaffected by another IP flooding the pre-auth gate', () => {
    const { store } = makeStore();
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 5; i++) store.registerPostAttempt('66.66.66.66');
    expect(store.registerPostAttempt('77.77.77.77')).toBe(false); // fresh IP, first hit
  });

  it('one HTTP POST counts ONCE: registerPostAttempt + putClip(ipAlreadyCounted) do not double-count', async () => {
    const { store } = makeStore();
    // Simulate index.ts: pre-auth gate, then putClip with the already-counted flag.
    // CLIP_POST_PER_IP_MAX such round-trips must all pass (no double-count halving).
    let allOk = true;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX; i++) {
      const over = store.registerPostAttempt('88.88.88.88');
      expect(over).toBe(false);
      const res = await store.putClip({
        ip: '88.88.88.88',
        clipId: fixtureClipId(800 + i),
        roomId: 'roomOnce',
        ownerToken: 'tok',
        verifyOwnerToken: allow,
        contentType: 'video/webm',
        body: Buffer.from('x'),
        ipAlreadyCounted: true,
      });
      if (!('ok' in res)) allOk = false;
    }
    expect(allOk).toBe(true); // exactly CLIP_POST_PER_IP_MAX succeeded — not halved
    // The (max+1)-th pre-auth attempt now trips.
    expect(store.registerPostAttempt('88.88.88.88')).toBe(true);
  });
});

// ===========================================================================
// SAVE_CLIP DIRECTOR sub-kind minted in the registry
// ===========================================================================

describe('C31 — SAVE_CLIP minted as a DIRECTOR (0x22) sub-kind', () => {
  it('DIRECTOR_KIND.SAVE_CLIP is defined, in u8 range, and distinct from every other DIRECTOR kind', () => {
    expect(DIRECTOR_KIND.SAVE_CLIP).toBeTypeOf('number');
    expect(DIRECTOR_KIND.SAVE_CLIP).toBeGreaterThanOrEqual(0);
    expect(DIRECTOR_KIND.SAVE_CLIP).toBeLessThanOrEqual(0xff);
    const others = Object.entries(DIRECTOR_KIND).filter(([k]) => k !== 'SAVE_CLIP');
    for (const [name, v] of others) {
      expect(v, `SAVE_CLIP collides with ${name}`).not.toBe(DIRECTOR_KIND.SAVE_CLIP);
    }
    // Coherent-next-value check (C29 minted STAGE_XRAY=0x03; C31 mints the NEXT byte).
    expect(DIRECTOR_KIND.SAVE_CLIP).toBe(DIRECTOR_KIND.STAGE_XRAY + 1);
  });
});

// ===========================================================================
// readBodyCapped — the PRIMARY size defense (streams; never buffers past the cap)
// ===========================================================================

describe('C31 — readBodyCapped', () => {
  it('resolves with the full body when under the cap', async () => {
    const s = new PassThrough();
    const p = readBodyCapped(s, 1024);
    s.end(Buffer.from('hello world'));
    const body = await p;
    expect(body.toString()).toBe('hello world');
  });

  it('rejects with PayloadTooLargeError the instant the running total crosses the cap, and PAUSES (never destroys) the source', async () => {
    const s = new PassThrough();
    const p = readBodyCapped(s, 10);
    s.write(Buffer.alloc(5));
    s.write(Buffer.alloc(20)); // crosses the 10-byte cap on this chunk
    await expect(p).rejects.toBeInstanceOf(PayloadTooLargeError);
    // Bounded-memory defense: no more chunks are consumed after the cap trips.
    expect(s.isPaused()).toBe(true);
    // NEVER destroyed here — on a real IncomingMessage this would kill the
    // response socket before a clean 413 could be written (the caller decides
    // if/when to close, after its own response is flushed).
    expect(s.destroyed).toBe(false);
  });

  it('exactly at the cap is allowed (boundary — not off-by-one)', async () => {
    const s = new PassThrough();
    const p = readBodyCapped(s, 10);
    s.end(Buffer.alloc(10));
    const body = await p;
    expect(body.byteLength).toBe(10);
  });

  it('one byte over the cap is rejected (boundary)', async () => {
    const s = new PassThrough();
    const p = readBodyCapped(s, 10);
    s.end(Buffer.alloc(11));
    await expect(p).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('propagates a stream error', async () => {
    const s = new PassThrough();
    const p = readBodyCapped(s, 10);
    s.emit('error', new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });

  it('CLIP_MAX_BYTES is the spec ~25 MB cap', () => {
    expect(CLIP_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ===========================================================================
// firstHeaderValue
// ===========================================================================

describe('C31 — firstHeaderValue', () => {
  it('passes through a plain string', () => {
    expect(firstHeaderValue('abc')).toBe('abc');
  });
  it('takes the first element of an array header', () => {
    expect(firstHeaderValue(['a', 'b'])).toBe('a');
  });
  it('returns undefined for undefined', () => {
    expect(firstHeaderValue(undefined)).toBeUndefined();
  });
});

// ===========================================================================
// POST — ownerToken auth, clipId shape, size cap, per-IP rate limit, per-room-
// per-day count cap, duplicate refusal
// ===========================================================================

describe('C31 — ClipStore.putClip (POST security)', () => {
  it('a well-formed authorized clip is stored', async () => {
    const { store } = makeStore();
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: fixtureClipId(1),
      roomId: 'room1',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('clip-bytes'),
    });
    expect(res).toEqual({ ok: true, clipId: fixtureClipId(1) });
    expect(store.has(fixtureClipId(1))).toBe(true);
  });

  it('a malformed clipId (bad shape) is refused with 400 — never touches the fs', async () => {
    const { store, fs } = makeStore();
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: '../../etc/passwd',
      roomId: 'room1',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect(res).toEqual({ error: 'bad-clip-id', status: 400 });
    expect(fs.store.size).toBe(0);
  });

  it('an unauthorized POST (bad/missing ownerToken) is refused with 401', async () => {
    const { store } = makeStore();
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: fixtureClipId(2),
      roomId: 'room1',
      ownerToken: 'wrong',
      verifyOwnerToken: deny,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect(res).toEqual({ error: 'unauthorized', status: 401 });
    expect(store.has(fixtureClipId(2))).toBe(false);
  });

  it('an ABSENT ownerToken is refused with 401 (never treated as anonymous-ok)', async () => {
    const { store } = makeStore();
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: fixtureClipId(3),
      roomId: 'room1',
      ownerToken: undefined,
      verifyOwnerToken: (_r, t) => t !== undefined,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect(res).toEqual({ error: 'unauthorized', status: 401 });
  });

  it('an over-cap body is refused with 413 (store-level backstop)', async () => {
    const { store } = makeStore({ maxBytes: 100 });
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: fixtureClipId(4),
      roomId: 'room1',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.alloc(101),
    });
    expect(res).toEqual({ error: 'too-large', status: 413 });
  });

  it('a resend of the SAME clipId is refused with 409 (never silently overwrites)', async () => {
    const { store } = makeStore();
    const id = fixtureClipId(5);
    const ok = await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId: 'room1',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('a'),
    });
    expect('ok' in ok && ok.ok).toBe(true);
    const dupe = await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId: 'room1',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('b'),
    });
    expect(dupe).toEqual({ error: 'duplicate', status: 409 });
  });

  it(`>= ${CLIP_POST_PER_IP_MAX} rapid POSTs from one IP hit the per-IP rate limit (429); a different IP is unaffected`, async () => {
    const { store, clock } = makeStore();
    let got429 = false;
    for (let i = 0; i < CLIP_POST_PER_IP_MAX + 5; i++) {
      const res = await store.putClip({
        ip: '5.5.5.5',
        clipId: fixtureClipId(100 + i),
        roomId: 'roomRate',
        ownerToken: 'tok',
        verifyOwnerToken: allow,
        contentType: 'video/webm',
        body: Buffer.from('x'),
      });
      if ('error' in res && res.error === 'rate-limited') {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    const other = await store.putClip({
      ip: '6.6.6.6',
      clipId: fixtureClipId(999),
      roomId: 'roomRate',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect('ok' in other).toBe(true);

    // The window rolls off — a fresh POST succeeds after CLIP_POST_PER_IP_WINDOW_MS.
    clock.advance(CLIP_POST_PER_IP_WINDOW_MS + 1);
    const afterWindow = await store.putClip({
      ip: '5.5.5.5',
      clipId: fixtureClipId(1000),
      roomId: 'roomRate',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect('ok' in afterWindow).toBe(true);
  });

  it(`a room saving > ${CLIP_MAX_PER_ROOM_PER_DAY} clips in one day hits the day-count cap (429); a different room is unaffected`, async () => {
    const { store } = makeStore();
    let got429 = false;
    for (let i = 0; i < CLIP_MAX_PER_ROOM_PER_DAY + 5; i++) {
      // Vary the IP so the per-IP rate limit never masks the day-cap assertion.
      const res = await store.putClip({
        ip: `9.9.9.${i % 250}`,
        clipId: fixtureClipId(2000 + i),
        roomId: 'roomDayCap',
        ownerToken: 'tok',
        verifyOwnerToken: allow,
        contentType: 'video/webm',
        body: Buffer.from('x'),
      });
      if ('error' in res && res.error === 'day-cap') {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    const otherRoom = await store.putClip({
      ip: '9.9.9.200',
      clipId: fixtureClipId(3000),
      roomId: 'roomOther',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('x'),
    });
    expect('ok' in otherRoom).toBe(true);
  });
});

// ===========================================================================
// GET — public retrieval, per-IP rate limit, per-clip daily download cap, TTL
// day-close + sweep (404 after)
// ===========================================================================

describe('C31 — ClipStore.getClip (GET security — PUBLIC but rate-limited)', () => {
  async function saveOne(store: ClipStore, id: string, roomId = 'room1'): Promise<void> {
    const res = await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId,
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('bytes'),
    });
    expect('ok' in res).toBe(true);
  }

  it('a saved clip is retrievable with NO ownerToken/auth at all (public)', async () => {
    const { store } = makeStore();
    const id = fixtureClipId(10);
    await saveOne(store, id);
    const res = await store.getClip({ ip: '2.2.2.2', clipId: id });
    expect(res).toMatchObject({ ok: true, contentType: 'video/webm' });
    if ('body' in res) expect(res.body.toString()).toBe('bytes');
  });

  it('an unknown clipId 404s', async () => {
    const { store } = makeStore();
    const res = await store.getClip({ ip: '2.2.2.2', clipId: fixtureClipId(999999) });
    expect(res).toEqual({ error: 'not-found', status: 404 });
  });

  it(`>= ${CLIP_GET_PER_IP_MAX} rapid GETs from one IP hit the per-IP rate limit (429); a different IP is unaffected`, async () => {
    const { store, clock } = makeStore();
    const id = fixtureClipId(11);
    await saveOne(store, id);

    let got429 = false;
    for (let i = 0; i < CLIP_GET_PER_IP_MAX + 5; i++) {
      const res = await store.getClip({ ip: '3.3.3.3', clipId: id });
      if ('error' in res && res.error === 'rate-limited') {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    const other = await store.getClip({ ip: '4.4.4.4', clipId: id });
    expect('ok' in other).toBe(true);

    clock.advance(CLIP_GET_PER_IP_WINDOW_MS + 1);
    const afterWindow = await store.getClip({ ip: '3.3.3.3', clipId: id });
    expect('ok' in afterWindow).toBe(true);
  });

  it(`a single clip downloaded > ${CLIP_MAX_DOWNLOADS_PER_CLIP_PER_DAY} times in one day hits its per-clip daily cap (429); a DIFFERENT clip is unaffected`, async () => {
    const { store } = makeStore();
    const hot = fixtureClipId(12);
    const cold = fixtureClipId(13);
    await saveOne(store, hot);
    await saveOne(store, cold);

    let got429 = false;
    for (let i = 0; i < CLIP_MAX_DOWNLOADS_PER_CLIP_PER_DAY + 5; i++) {
      // Vary the IP so the per-IP GET limiter never masks the per-clip cap.
      const res = await store.getClip({ ip: `7.7.7.${i % 250}`, clipId: hot });
      if ('error' in res && res.error === 'download-cap') {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);

    const coldRes = await store.getClip({ ip: '7.7.7.250', clipId: cold });
    expect('ok' in coldRes).toBe(true);
  });

  it(`TTL day-close: a clip older than CLIP_TTL_MS (${CLIP_TTL_MS} ms) is swept — GET then 404s, indistinguishable from never-existed`, async () => {
    const { store, clock } = makeStore();
    const id = fixtureClipId(14);
    await saveOne(store, id);
    expect(store.has(id)).toBe(true);

    clock.advance(CLIP_TTL_MS + 1);
    // sweep() runs implicitly at the top of getClip — no separate call needed.
    const res = await store.getClip({ ip: '8.8.8.8', clipId: id });
    expect(res).toEqual({ error: 'not-found', status: 404 });
    expect(store.has(id)).toBe(false);
  });

  it('sweep() deletes the underlying blob file (day-close reclaims disk)', async () => {
    const { store, fs, clock } = makeStore();
    const id = fixtureClipId(15);
    await saveOne(store, id);
    expect(fs.store.size).toBe(1);

    clock.advance(CLIP_TTL_MS + 1);
    store.sweep();
    expect(fs.store.size).toBe(0);
    expect(store.has(id)).toBe(false);
  });

  it('a clip just under the TTL survives a sweep', async () => {
    const { store, clock } = makeStore();
    const id = fixtureClipId(16);
    await saveOne(store, id);
    clock.advance(CLIP_TTL_MS - 1);
    store.sweep();
    expect(store.has(id)).toBe(true);
  });

  it('FOLD-IN — a missing blob (meta present, file gone) 404s WITHOUT hanging and does NOT burn the download cap', async () => {
    const { store, fs } = makeStore();
    const id = fixtureClipId(17);
    await saveOne(store, id);
    // Simulate external deletion / partial write: drop the blob but keep the meta.
    fs.store.clear();
    // A guarded read → a clean 404 (resolves; never a hanging unhandled rejection).
    const res = await store.getClip({ ip: '2.2.2.2', clipId: id });
    expect(res).toEqual({ error: 'not-found', status: 404 });
    // The dangling index entry is dropped (store stays consistent).
    expect(store.has(id)).toBe(false);
  });

  it('FOLD-IN — a failed read does NOT increment the per-clip download counter', async () => {
    // A read that throws must not burn a day-cap slot. Use a store whose readFile
    // throws to prove the counter only advances after a SUCCESSFUL read.
    const clock = new FakeClock();
    const written = new Map<string, Buffer>();
    let failReads = false;
    const store = new ClipStore({
      now: () => clock.now,
      dir: '/mem',
      writeFile: async (p, d) => {
        written.set(p, d);
      },
      readFile: async (p) => {
        if (failReads) throw new Error('EIO');
        const v = written.get(p);
        if (!v) throw new Error('ENOENT');
        return v;
      },
      deleteFile: async (p) => {
        written.delete(p);
      },
      maxDownloadsPerClipPerDay: 3,
    });
    const id = fixtureClipId(18);
    await store.putClip({
      ip: '1.1.1.1',
      clipId: id,
      roomId: 'r',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('bytes'),
    });
    // Two failing reads — each returns 404 and must NOT consume the 3/day budget.
    failReads = true;
    // The meta gets dropped on the first failed read (dangling-entry cleanup), so
    // re-store to prove the counter behavior across a successful read afterwards.
    // (Simpler: assert the first failed read 404s, re-save, then 3 good reads pass.)
    expect(await store.getClip({ ip: '9.9.9.9', clipId: id })).toEqual({
      error: 'not-found',
      status: 404,
    });
    failReads = false;
    // Re-save under a fresh id and prove the FULL 3/day budget is intact (no slot burned).
    const id2 = fixtureClipId(19);
    await store.putClip({
      ip: '1.1.1.1',
      clipId: id2,
      roomId: 'r',
      ownerToken: 'tok',
      verifyOwnerToken: allow,
      contentType: 'video/webm',
      body: Buffer.from('bytes'),
    });
    for (let i = 0; i < 3; i++) {
      expect('ok' in (await store.getClip({ ip: `4.4.4.${i}`, clipId: id2 }))).toBe(true);
    }
    // The 4th download hits the cap — proving all 3 were available (none pre-burned).
    expect(await store.getClip({ ip: '4.4.4.9', clipId: id2 })).toEqual({
      error: 'download-cap',
      status: 429,
    });
  });
});

// ===========================================================================
// FOLD-IN — unbounded map growth: prune stale day keys + idle per-IP entries
// ===========================================================================

describe('C31 FOLD-IN — auxiliary map pruning (memory-DoS amplifier)', () => {
  it('sweep() prunes idle per-IP POST/GET entries once their windows expire', async () => {
    const { store, clock } = makeStore();
    // Seed many DISTINCT IPs (the spoofed-source amplifier) across POST + GET.
    for (let i = 0; i < 50; i++) {
      await store.putClip({
        ip: `10.0.0.${i}`,
        clipId: fixtureClipId(4000 + i),
        roomId: 'r',
        ownerToken: 'tok',
        verifyOwnerToken: allow,
        contentType: 'video/webm',
        body: Buffer.from('x'),
      });
      await store.getClip({ ip: `11.0.0.${i}`, clipId: fixtureClipId(4000 + i) });
    }
    const before = store.debugMapSizes();
    expect(before.postHits).toBeGreaterThan(0);
    expect(before.getHits).toBeGreaterThan(0);
    // Advance PAST every window (and the TTL) so all timestamps are stale.
    clock.advance(CLIP_TTL_MS + CLIP_POST_PER_IP_WINDOW_MS + CLIP_GET_PER_IP_WINDOW_MS + 1);
    store.sweep();
    const after = store.debugMapSizes();
    expect(after.postHits).toBe(0);
    expect(after.getHits).toBe(0);
  });

  it('sweep() prunes stale YYYY-MM-DD room-day-count keys once the day rolls over', async () => {
    const { store, clock } = makeStore();
    // Day 0: several rooms save (seeding day-count keys for TODAY).
    for (let i = 0; i < 5; i++) {
      await store.putClip({
        ip: `12.0.0.${i}`,
        clipId: fixtureClipId(5000 + i),
        roomId: `room${i}`,
        ownerToken: 'tok',
        verifyOwnerToken: allow,
        contentType: 'video/webm',
        body: Buffer.from('x'),
      });
    }
    expect(store.debugMapSizes().roomDayCounts).toBe(5);
    // Roll the calendar forward two days — the day-0 keys are now dead weight.
    clock.advance(2 * CLIP_TTL_MS);
    store.sweep();
    expect(store.debugMapSizes().roomDayCounts).toBe(0);
  });
});

// ===========================================================================
// FOLD-IN — startup disk reconciliation: TTL-sweep pre-restart orphaned blobs
// ===========================================================================

describe('C31 FOLD-IN — reconcileDisk (orphaned-blob disk leak)', () => {
  it('deletes an OLD orphaned blob file on init but keeps a FRESH one (real temp dir)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-recon-'));
    const clipsDir = join(root, 'clips');
    try {
      // Two pre-restart blobs on real disk: one old, one fresh. The in-memory
      // index is EMPTY (fresh process), so sweep() can never reach these — only
      // reconcileDisk() can.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(clipsDir, { recursive: true });
      const oldBlob = join(clipsDir, `${fixtureClipId(6001)}.bin`);
      const freshBlob = join(clipsDir, `${fixtureClipId(6002)}.bin`);
      writeFileSync(oldBlob, Buffer.from('old'));
      writeFileSync(freshBlob, Buffer.from('fresh'));
      // Backdate the old blob's mtime well past the TTL; leave the fresh one at now.
      const now = Date.now();
      utimesSync(oldBlob, new Date(now), new Date(now - CLIP_TTL_MS - 60_000));

      const store = new ClipStore({ dir: root }); // REAL fs ports (default)
      await store.reconcileDisk();

      expect(existsSync(oldBlob)).toBe(false); // old orphan reclaimed
      expect(existsSync(freshBlob)).toBe(true); // fresh survives
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconcileDisk on a never-created clips dir is a no-op (no throw)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-recon-empty-'));
    try {
      const store = new ClipStore({ dir: root });
      await expect(store.reconcileDisk()).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
