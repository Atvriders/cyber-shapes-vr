/**
 * roomLink.ts — room URL helpers (B5)
 *
 * Pure: no I/O, no Date, no Math.random. Deterministic and unit-testable.
 *
 * parseRoom(url)     — extract <id> from /r/<id> path; validates charset; null on failure
 * makeRoomId(seed)   — deterministic id from a seed string (hash → base36, no randomness)
 * roomUrl(origin,id) — `${origin}/r/${id}`
 */

/** Valid room id: 1–64 chars of [A-Za-z0-9_-]. */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Extract the room id from a URL with a `/r/<id>` path segment.
 * Returns null if:
 *  - the path has no `/r/` segment
 *  - the extracted segment does not match ^[A-Za-z0-9_-]{1,64}$
 *  - the URL contains encoded characters that expand to path separators
 */
export function parseRoom(url: string): string | null {
  if (!url) return null;

  // Decode percent-encoded characters before pattern matching so that
  // tricks like /r/..%2f are caught by the charset check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // malformed encoding → reject
    return null;
  }

  // Extract the pathname from the decoded URL.
  // We need the path to be exactly /r/<id> (optionally followed by ?query or #hash,
  // but NOT by additional path segments like /r/id/extra).
  // We parse via URL constructor when the string looks like an absolute URL,
  // then fall back to a simple regex for relative paths.
  let pathname: string;
  try {
    const parsed = new URL(decoded);
    pathname = parsed.pathname;
  } catch {
    // Not an absolute URL — try to extract the path portion directly.
    const pathMatch = decoded.match(/^([^?#]*)/);
    pathname = pathMatch ? pathMatch[1] : decoded;
  }

  // Require path to be exactly /r/<id> (no additional segments).
  const match = pathname.match(/^(?:.*\/)?r\/([^/]+)$/);
  if (!match) return null;

  const id = match[1];
  if (!ROOM_ID_RE.test(id)) return null;

  return id;
}

/**
 * Derive a deterministic room id from `seed`.
 * Implementation: FNV-1a 32-bit hash → base36 string.
 * Same seed always produces the same id; no randomness or time dependency.
 */
export function makeRoomId(seed: string): string {
  const hash = fnv1a32(seed);
  // Convert the unsigned 32-bit hash to base36 for a compact alphanumeric id.
  return (hash >>> 0).toString(36);
}

/**
 * Build the canonical room URL from an `origin` and a room `id`.
 */
export function roomUrl(origin: string, id: string): string {
  return `${origin}/r/${id}`;
}

/**
 * Extract the optional `?k=<secret>` join secret from a room URL.
 * Returns null if the param is absent, empty, or the URL is malformed.
 *
 * The `k` param is appended to staff-distributed booth links:
 *   `https://example.com/r/<roomId>?k=<hmac-join-secret>`
 * The resident VR client forwards this so the server can authorize the
 * privileged tier without requiring a separate login UI.
 */
export function parseJoinSecret(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const k = parsed.searchParams.get('k');
    return typeof k === 'string' && k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash (public domain)
// https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
// ---------------------------------------------------------------------------

function fnv1a32(s: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // 32-bit multiply: split into 16-bit halves to avoid JS precision issues
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // ensure unsigned 32-bit
}
