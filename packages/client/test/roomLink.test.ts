/**
 * roomLink.test.ts — TDD RED→GREEN for parseRoom / makeRoomId / roomUrl (Task B5)
 *
 * Pure unit tests: no I/O, no randomness.
 */

import { describe, expect, it } from 'vitest';
import { parseRoom, makeRoomId, roomUrl, parseJoinSecret } from '../src/net/roomLink.js';

describe('parseRoom', () => {
  it('extracts id from a valid /r/<id> path', () => {
    expect(parseRoom('https://x/r/ab12')).toBe('ab12');
  });

  it('extracts id from a full URL with origin + trailing content', () => {
    expect(parseRoom('https://example.com/r/my-room_01')).toBe('my-room_01');
  });

  it('returns null when there is no /r/ segment', () => {
    expect(parseRoom('https://x/')).toBeNull();
    expect(parseRoom('https://x/other/path')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseRoom('')).toBeNull();
  });

  it('rejects ids with path traversal sequences', () => {
    // URL-encoded ../ should be rejected
    expect(parseRoom('https://x/r/..%2f')).toBeNull();
    expect(parseRoom('https://x/r/../secret')).toBeNull();
  });

  it('rejects ids with invalid characters (spaces, slashes, special chars)', () => {
    expect(parseRoom('https://x/r/bad id')).toBeNull();
    expect(parseRoom('https://x/r/bad/nested')).toBeNull();
    expect(parseRoom('https://x/r/')).toBeNull(); // empty id
  });

  it('rejects an id longer than 64 characters', () => {
    const longId = 'a'.repeat(65);
    expect(parseRoom(`https://x/r/${longId}`)).toBeNull();
  });

  it('accepts an id exactly 64 characters long', () => {
    const maxId = 'a'.repeat(64);
    expect(parseRoom(`https://x/r/${maxId}`)).toBe(maxId);
  });

  it('accepts ids with valid chars: letters, digits, underscore, hyphen', () => {
    expect(parseRoom('https://x/r/Az09_-')).toBe('Az09_-');
  });
});

describe('makeRoomId', () => {
  it('returns a non-empty string for any seed', () => {
    const id = makeRoomId('hello');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('is deterministic: same seed always produces the same id', () => {
    expect(makeRoomId('seed')).toBe(makeRoomId('seed'));
    expect(makeRoomId('cyber-shapes')).toBe(makeRoomId('cyber-shapes'));
  });

  it('different seeds produce different ids', () => {
    expect(makeRoomId('seed-a')).not.toBe(makeRoomId('seed-b'));
  });

  it('produces an id that passes the parseRoom validation pattern', () => {
    const id = makeRoomId('test-seed');
    // should match ^[A-Za-z0-9_-]{1,64}$
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('roomUrl', () => {
  it('combines origin and id into /r/<id> URL', () => {
    expect(roomUrl('https://x', 'ab')).toBe('https://x/r/ab');
  });

  it('works with a full origin including port', () => {
    expect(roomUrl('https://example.com:3000', 'room1')).toBe('https://example.com:3000/r/room1');
  });
});

// ---------------------------------------------------------------------------
// parseJoinSecret — C7 security fix: extract ?k=<secret> from the room URL
// so the VR client can forward the HMAC join key to the server.
// ---------------------------------------------------------------------------
describe('parseJoinSecret', () => {
  it('returns the k param from a URL with ?k=<secret>', () => {
    expect(parseJoinSecret('https://example.com/r/abc123?k=myhmacsecret')).toBe('myhmacsecret');
  });

  it('returns null when there is no k param', () => {
    expect(parseJoinSecret('https://example.com/r/abc123')).toBeNull();
  });

  it('returns null when k param is empty', () => {
    expect(parseJoinSecret('https://example.com/r/abc123?k=')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseJoinSecret('')).toBeNull();
  });

  it('returns null for a malformed URL (no scheme)', () => {
    // A relative path with no origin — URL constructor throws, returns null.
    expect(parseJoinSecret('/r/room?k=secret')).toBeNull();
  });

  it('returns k even when other query params are present', () => {
    expect(parseJoinSecret('https://x.com/r/room?foo=bar&k=thekey&baz=1')).toBe('thekey');
  });
});
