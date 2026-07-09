/**
 * auth.test.ts — Task C4 unit tests for the room auth store.
 *
 * Pure/injected: a fake clock, a deterministic RNG, and an in-memory fs are
 * injected so rate limits, TTL eviction, and exponential backoff are driven
 * without wall-clock sleeps or real disk. TDD RED — written before auth.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  RoomAuthStore,
  deriveJoinSecret,
  hashToken,
  ROOM_CREATE_PER_IP_WINDOW_MS,
  ROOM_CREATE_PER_IP_MAX,
  MAX_ACTIVE_ROOMS,
  ROOM_TTL_MS,
  BACKOFF_BASE_MS,
  ROTATE_LINK_MOVED_PAGE,
} from '../src/auth.js';

// ---------------------------------------------------------------------------
// Test harness: a fake clock + deterministic byte source + in-memory fs.
// ---------------------------------------------------------------------------

class FakeClock {
  now = 0;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** Deterministic 32-byte token source: a monotonically increasing counter. */
function makeTokenSource(): () => Buffer {
  let n = 0;
  return () => {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(n++, 0);
    // fill the rest so distinct tokens differ across all bytes
    for (let i = 4; i < 32; i++) b[i] = (n * 31 + i) & 0xff;
    return b;
  };
}

/** In-memory fs stub matching the auth store's injectable persistence port. */
function makeMemFs(): {
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<void>;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async read(path: string): Promise<string> {
      const v = store.get(path);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async write(path: string, data: string): Promise<void> {
      store.set(path, data);
    },
  };
}

function makeStore(overrides?: {
  clock?: FakeClock;
  fs?: ReturnType<typeof makeMemFs>;
  tokenSource?: () => Buffer;
}): { store: RoomAuthStore; clock: FakeClock; fs: ReturnType<typeof makeMemFs> } {
  const clock = overrides?.clock ?? new FakeClock();
  const fs = overrides?.fs ?? makeMemFs();
  const tokenSource = overrides?.tokenSource ?? makeTokenSource();
  const store = new RoomAuthStore({
    now: () => clock.now,
    randomBytes32: tokenSource,
    dir: '/data',
    readFile: fs.read,
    writeFile: fs.write,
  });
  return { store, clock, fs };
}

// ---------------------------------------------------------------------------
// createRoom — distinct token per room + persistence
// ---------------------------------------------------------------------------

describe('C4 auth — createRoom', () => {
  it('returns a distinct roomId and ownerToken per room', async () => {
    const { store } = makeStore();
    const a = await store.createRoom('1.1.1.1');
    const b = await store.createRoom('1.1.1.1');
    expect('roomId' in a && 'roomId' in b).toBe(true);
    if (!('roomId' in a) || !('roomId' in b)) throw new Error('unreachable');
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.ownerToken).not.toBe(b.ownerToken);
    // Tokens are long random hex (≥ 256 bit → ≥ 64 hex chars).
    expect(a.ownerToken.length).toBeGreaterThanOrEqual(64);
  });

  it('persists a token HASH + epoch beside the room file (never the plaintext token)', async () => {
    const { store, fs } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('createRoom failed');
    // The auth record lives beside the room file and survives restart.
    const path = `/data/rooms/${r.roomId}.auth.json`;
    expect(fs.store.has(path)).toBe(true);
    const rec = JSON.parse(fs.store.get(path)!);
    expect(rec.epoch).toBe(0);
    expect(typeof rec.tokenHash).toBe('string');
    // The plaintext token must NEVER be persisted.
    const persisted = fs.store.get(path)!;
    expect(persisted.includes(r.ownerToken)).toBe(false);
    expect(rec.tokenHash).toBe(hashToken(r.ownerToken));
  });
});

// ---------------------------------------------------------------------------
// Per-IP rate limit → 429
// ---------------------------------------------------------------------------

describe('C4 auth — per-IP create rate limit', () => {
  it('K rapid creations from one IP → 429, a different IP is unaffected', async () => {
    const { store } = makeStore();
    for (let i = 0; i < ROOM_CREATE_PER_IP_MAX; i++) {
      const r = await store.createRoom('9.9.9.9');
      expect('roomId' in r).toBe(true);
    }
    const over = await store.createRoom('9.9.9.9');
    expect('error' in over && over.error).toBe('rate-limited');
    if ('status' in over) expect(over.status).toBe(429);

    // A different IP is not throttled.
    const other = await store.createRoom('8.8.8.8');
    expect('roomId' in other).toBe(true);
  });

  it('the per-IP window slides: after the window a new create is allowed', async () => {
    const { store, clock } = makeStore();
    for (let i = 0; i < ROOM_CREATE_PER_IP_MAX; i++) await store.createRoom('9.9.9.9');
    expect('error' in (await store.createRoom('9.9.9.9'))).toBe(true);
    clock.advance(ROOM_CREATE_PER_IP_WINDOW_MS + 1);
    expect('roomId' in (await store.createRoom('9.9.9.9'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global active-room cap
// ---------------------------------------------------------------------------

describe('C4 auth — global active-room cap', () => {
  it('refuses creation past the global cap with a 503', async () => {
    // Small cap store so the test is fast.
    const clock = new FakeClock();
    const fs = makeMemFs();
    const store = new RoomAuthStore({
      now: () => clock.now,
      randomBytes32: makeTokenSource(),
      dir: '/data',
      readFile: fs.read,
      writeFile: fs.write,
      maxActiveRooms: 3,
    });
    // Distinct IPs so the per-IP limiter never fires.
    for (let i = 0; i < 3; i++) {
      const r = await store.createRoom(`10.0.0.${i}`);
      expect('roomId' in r).toBe(true);
    }
    const over = await store.createRoom('10.0.0.99');
    expect('error' in over && over.error).toBe('at-capacity');
    if ('status' in over) expect(over.status).toBe(503);
  });

  it('MAX_ACTIVE_ROOMS is a sane positive integer', () => {
    expect(Number.isInteger(MAX_ACTIVE_ROOMS)).toBe(true);
    expect(MAX_ACTIVE_ROOMS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TTL eviction of never-joined / empty rooms
// ---------------------------------------------------------------------------

describe('C4 auth — TTL eviction', () => {
  it('a never-joined room is GC-eligible after TTL and its creation slot is reclaimed', async () => {
    const clock = new FakeClock();
    const fs = makeMemFs();
    const store = new RoomAuthStore({
      now: () => clock.now,
      randomBytes32: makeTokenSource(),
      dir: '/data',
      readFile: fs.read,
      writeFile: fs.write,
      maxActiveRooms: 1,
    });
    const first = await store.createRoom('10.0.0.1');
    if (!('roomId' in first)) throw new Error('create failed');
    // Cap of 1 → a second create is refused while the first is alive.
    expect('error' in (await store.createRoom('10.0.0.2'))).toBe(true);

    // Advance past TTL WITHOUT the room ever being joined → it is evicted.
    clock.advance(ROOM_TTL_MS + 1);
    store.sweep();
    expect(store.isKnown(first.roomId)).toBe(false);
    // Slot reclaimed: a new room can now be created.
    expect('roomId' in (await store.createRoom('10.0.0.3'))).toBe(true);
  });

  it('a room that WAS joined and is now empty is evicted after TTL from last-empty', async () => {
    const { store, clock } = makeStore();
    const r = await store.createRoom('10.0.0.1');
    if (!('roomId' in r)) throw new Error('create failed');
    store.markJoined(r.roomId); // first join
    clock.advance(ROOM_TTL_MS * 10); // long-lived while occupied
    store.sweep();
    expect(store.isKnown(r.roomId)).toBe(true); // occupied → survives
    store.markEmpty(r.roomId); // last participant left
    clock.advance(ROOM_TTL_MS + 1);
    store.sweep();
    expect(store.isKnown(r.roomId)).toBe(false);
  });

  it('a currently-occupied room is NOT evicted regardless of age', async () => {
    const { store, clock } = makeStore();
    const r = await store.createRoom('10.0.0.1');
    if (!('roomId' in r)) throw new Error('create failed');
    store.markJoined(r.roomId);
    clock.advance(ROOM_TTL_MS * 100);
    store.sweep();
    expect(store.isKnown(r.roomId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Join secret = HMAC(ownerToken, roomId + epoch) + constant-time verify
// ---------------------------------------------------------------------------

describe('C4 auth — HMAC join secret', () => {
  it('deriveJoinSecret is HMAC(ownerToken, roomId+epoch): deterministic, epoch- and room-bound', () => {
    const s0 = deriveJoinSecret('owner-abc', 'room1', 0);
    expect(deriveJoinSecret('owner-abc', 'room1', 0)).toBe(s0); // deterministic
    expect(deriveJoinSecret('owner-abc', 'room1', 1)).not.toBe(s0); // epoch-bound
    expect(deriveJoinSecret('owner-abc', 'room2', 0)).not.toBe(s0); // room-bound
    expect(deriveJoinSecret('owner-xyz', 'room1', 0)).not.toBe(s0); // token-bound
  });

  it('verifyJoinSecret accepts the derived secret and rejects a bad/absent one', async () => {
    const { store } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    const good = deriveJoinSecret(r.ownerToken, r.roomId, 0);
    expect(store.verifyJoinSecret(r.roomId, good)).toBe(true);
    expect(store.verifyJoinSecret(r.roomId, 'not-the-secret')).toBe(false);
    expect(store.verifyJoinSecret(r.roomId, undefined)).toBe(false);
    expect(store.verifyJoinSecret('no-such-room', good)).toBe(false);
  });

  it('verifyOwnerToken constant-time-compares the token against the stored hash', async () => {
    const { store } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    expect(store.verifyOwnerToken(r.roomId, r.ownerToken)).toBe(true);
    expect(store.verifyOwnerToken(r.roomId, 'wrong')).toBe(false);
    expect(store.verifyOwnerToken(r.roomId, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failed-auth limiter per (IP, roomId) with exponential backoff
// ---------------------------------------------------------------------------

describe('C4 auth — failed-join backoff per (IP, roomId)', () => {
  it('backs off exponentially and clears after the window; a different (IP,room) is independent', async () => {
    const { store, clock } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    const roomId = r.roomId;

    // Initially not throttled.
    expect(store.isJoinThrottled('2.2.2.2', roomId)).toBe(false);

    // Record a few failed auths → backoff grows.
    store.recordFailedJoin('2.2.2.2', roomId);
    expect(store.isJoinThrottled('2.2.2.2', roomId)).toBe(true);
    const firstDelay = store.throttleRemainingMs('2.2.2.2', roomId);
    expect(firstDelay).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);

    // Wait out the first backoff, then fail again → the NEXT backoff is longer.
    clock.advance(firstDelay + 1);
    expect(store.isJoinThrottled('2.2.2.2', roomId)).toBe(false);
    store.recordFailedJoin('2.2.2.2', roomId);
    const secondDelay = store.throttleRemainingMs('2.2.2.2', roomId);
    expect(secondDelay).toBeGreaterThan(firstDelay);

    // A different IP against the same room is independent.
    expect(store.isJoinThrottled('3.3.3.3', roomId)).toBe(false);
    // The same IP against a different room is independent.
    expect(store.isJoinThrottled('2.2.2.2', 'other-room')).toBe(false);
  });

  it('a successful join resets the (IP, roomId) backoff', async () => {
    const { store } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    store.recordFailedJoin('2.2.2.2', r.roomId);
    expect(store.isJoinThrottled('2.2.2.2', r.roomId)).toBe(true);
    store.recordSuccessfulJoin('2.2.2.2', r.roomId);
    expect(store.isJoinThrottled('2.2.2.2', r.roomId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ROTATE_SECRET — epoch bump, old secret dies, new secret works, survives restart
// ---------------------------------------------------------------------------

describe('C4 auth — ROTATE_SECRET', () => {
  it('bumps the epoch so the OLD join secret stops validating and a re-issued one works', async () => {
    const { store } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    const oldSecret = deriveJoinSecret(r.ownerToken, r.roomId, 0);
    expect(store.verifyJoinSecret(r.roomId, oldSecret)).toBe(true);

    // Rotate (authenticated by presenting the ownerToken).
    const rot = await store.rotateSecret(r.roomId, r.ownerToken);
    expect(rot.ok).toBe(true);
    expect(rot.ok && rot.epoch).toBe(1);

    // Old secret now downgrades (fails); the epoch-1 secret validates.
    expect(store.verifyJoinSecret(r.roomId, oldSecret)).toBe(false);
    const newSecret = deriveJoinSecret(r.ownerToken, r.roomId, 1);
    expect(store.verifyJoinSecret(r.roomId, newSecret)).toBe(true);
  });

  it('ROTATE_SECRET requires the ownerToken (a wrong token is refused, epoch unchanged)', async () => {
    const { store } = makeStore();
    const r = await store.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    const bad = await store.rotateSecret(r.roomId, 'not-the-owner-token');
    expect(bad.ok).toBe(false);
    // Epoch unchanged → the original secret still validates.
    expect(store.verifyJoinSecret(r.roomId, deriveJoinSecret(r.ownerToken, r.roomId, 0))).toBe(true);
  });

  it('the epoch (and thus the rotated secret) survives a restart via persistence', async () => {
    const fs = makeMemFs();
    const clock = new FakeClock();
    const src = makeTokenSource();
    const s1 = new RoomAuthStore({
      now: () => clock.now,
      randomBytes32: src,
      dir: '/data',
      readFile: fs.read,
      writeFile: fs.write,
    });
    const r = await s1.createRoom('1.1.1.1');
    if (!('roomId' in r)) throw new Error('create failed');
    await s1.rotateSecret(r.roomId, r.ownerToken); // epoch → 1

    // "Restart": a fresh store over the SAME fs, empty in-memory maps.
    const s2 = new RoomAuthStore({
      now: () => clock.now,
      randomBytes32: makeTokenSource(),
      dir: '/data',
      readFile: fs.read,
      writeFile: fs.write,
    });
    await s2.loadRoom(r.roomId);
    // epoch-1 secret still validates; epoch-0 does not.
    expect(s2.verifyJoinSecret(r.roomId, deriveJoinSecret(r.ownerToken, r.roomId, 1))).toBe(true);
    expect(s2.verifyJoinSecret(r.roomId, deriveJoinSecret(r.ownerToken, r.roomId, 0))).toBe(false);
    // The ownerToken still grants director on the reloaded store.
    expect(s2.verifyOwnerToken(r.roomId, r.ownerToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ROTATE_LINK — the "moved" page discloses no new roomId
// ---------------------------------------------------------------------------

describe('C4 auth — ROTATE_LINK moved page', () => {
  it('the static moved page references Discord and NEVER any room identifier', () => {
    const page = ROTATE_LINK_MOVED_PAGE;
    expect(page.toLowerCase()).toContain('discord');
    expect(page.toLowerCase()).toContain('moved');
    // It is a constant — it structurally cannot embed a specific new roomId.
    expect(page).not.toMatch(/room[_-]?id/i);
  });
});
