import type { ClientMsg, ServerMsg, Vec3 } from './types.js';
import type { ShapeType, RenderMode } from '../types.js';
import { SHAPE_TYPES, RENDER_MODES, CYBER_COLORS } from '../constants.js';

// ---------------------------------------------------------------------------
// Voice opcode constants
// ---------------------------------------------------------------------------

export const VOICE_OPUS = 0x10;
export const VOICE_WEBM = 0x11;
export const VOICE_PCM = 0x12;

// ---------------------------------------------------------------------------
// Untrusted-input validation (audit findings #2, #5, #9, #17)
//
// The server is internet-facing: untrusted clients reach it. Every numeric /
// Vec3 field on a client message is validated here BEFORE it can enter the sim
// or be persisted. A single NaN position is never grounded and never removed
// (`Math.hypot(NaN) > 50` is false) → it would broadcast at 15 Hz forever and
// be persisted. These helpers are the primary defence.
// ---------------------------------------------------------------------------

/** Longest accepted player name; longer names are clamped (finding #17). */
export const MAX_NAME_LEN = 32;
/** Hard cap on the JSON `config` string relayed via voice-config (finding #7). */
export const MAX_VOICE_CONFIG_LEN = 256;
/**
 * Max entries in a pose's `hands` array. The real client sends exactly 2 (left +
 * right). A larger all-finite hands array would otherwise pass validation and be
 * relayed 1→N to every peer (an amplification vector), so we cap it here.
 */
export const MAX_POSE_HANDS = 2;

/** True only for a real, finite JS number (rejects NaN, ±Infinity, non-numbers). */
export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** True only for a `{x,y,z}` object whose three components are finite numbers. */
export function isFiniteVec3(v: unknown): v is Vec3 {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o['x']) && isFiniteNumber(o['y']) && isFiniteNumber(o['z']);
}

function isShapeType(t: unknown): t is ShapeType {
  return typeof t === 'string' && (SHAPE_TYPES as readonly string[]).includes(t);
}

function isRenderMode(m: unknown): m is RenderMode {
  return typeof m === 'string' && (RENDER_MODES as readonly string[]).includes(m);
}

/** A valid colorIndex is an integer within the palette range. */
function isValidColorIndex(c: unknown): c is number {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < CYBER_COLORS.length;
}

/**
 * Trim + length-clamp an untrusted player name (finding #17). Non-strings
 * collapse to `''`. Always returns a safe string ≤ MAX_NAME_LEN.
 */
export function clampName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, MAX_NAME_LEN);
}

/**
 * Validate an already-decoded client message (its `t` is a known string).
 * Returns true only if every field the server will act on is well-formed:
 *  - spawn: shape.type ∈ SHAPE_TYPES, position finite Vec3, and (when present)
 *    colorIndex a palette int, renderMode ∈ RENDER_MODES, scale finite.
 *  - release / held / pose: all Vec3 fields finite.
 *  - grab / release / recolor / rendermode / scale / held: id a string.
 *  - recolor.colorIndex a palette int; rendermode.mode ∈ RENDER_MODES;
 *    scale.scale finite; voice-state booleans; voice-config.config a string.
 *  - join: room + name strings, color + protocol finite numbers.
 * Unknown `t` values pass through (they are dropped harmlessly downstream).
 *
 * NEVER mutates the message. The connection layer rejects (drop + optional
 * error) on false and does NOT touch the world.
 */
export function validateClientMsg(msg: unknown): boolean {
  if (msg === null || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (typeof m['t'] !== 'string') return false;

  switch (m['t']) {
    case 'join':
      return (
        typeof m['room'] === 'string' &&
        typeof m['name'] === 'string' &&
        isFiniteNumber(m['color']) &&
        isFiniteNumber(m['protocol'])
      );

    case 'spawn': {
      const shape = m['shape'];
      if (shape === null || typeof shape !== 'object') return false;
      const s = shape as Record<string, unknown>;
      if (!isShapeType(s['type'])) return false;
      if (!isFiniteVec3(s['position'])) return false;
      if (s['colorIndex'] !== undefined && !isValidColorIndex(s['colorIndex'])) return false;
      if (s['renderMode'] !== undefined && !isRenderMode(s['renderMode'])) return false;
      if (s['scale'] !== undefined && !isFiniteNumber(s['scale'])) return false;
      // Spawn-poison guard (finding #2 via a different field): raw JSON can carry
      // rotSpeed/bobPhase (not declared on ClientMsg but present at runtime).
      // `1e999` parses to Infinity — a valid JSON literal — and serverWorld.spawn
      // would store it verbatim, so `step()` does `rotation += Infinity*dt` → a
      // non-finite rotation broadcast at 15Hz forever + persisted. Reject here.
      if (s['rotSpeed'] !== undefined && !isFiniteVec3(s['rotSpeed'])) return false;
      if (s['bobPhase'] !== undefined && !isFiniteNumber(s['bobPhase'])) return false;
      // tempId is an opaque echo — only require it be a string when present.
      if (m['tempId'] !== undefined && typeof m['tempId'] !== 'string') return false;
      return true;
    }

    case 'grab':
      return typeof m['id'] === 'string';

    case 'release':
      return (
        typeof m['id'] === 'string' &&
        isFiniteVec3(m['velocity']) &&
        isFiniteVec3(m['position']) &&
        isFiniteVec3(m['rotation'])
      );

    case 'recolor':
      return typeof m['id'] === 'string' && isValidColorIndex(m['colorIndex']);

    case 'rendermode':
      return typeof m['id'] === 'string' && isRenderMode(m['mode']);

    case 'scale':
      return typeof m['id'] === 'string' && isFiniteNumber(m['scale']);

    case 'held':
      return (
        typeof m['id'] === 'string' &&
        isFiniteVec3(m['position']) &&
        isFiniteVec3(m['rotation'])
      );

    case 'pose':
      return isValidPose(m['pose']);

    case 'voice-join':
    case 'voice-leave':
      return true;

    case 'voice-state':
      return typeof m['speaking'] === 'boolean' && typeof m['muted'] === 'boolean';

    case 'voice-config':
      return typeof m['config'] === 'string';

    default:
      // Unknown message type — not our job to reject here (dropped downstream).
      return true;
  }
}

/** A pose is `{ head:{p,q}, hands:[{p,q}|null,...] }` with all Vec3s finite. */
function isValidPose(pose: unknown): boolean {
  if (pose === null || typeof pose !== 'object') return false;
  const p = pose as Record<string, unknown>;
  const head = p['head'];
  if (head === null || typeof head !== 'object') return false;
  const h = head as Record<string, unknown>;
  if (!isFiniteVec3(h['p']) || !isFiniteVec3(h['q'])) return false;
  const hands = p['hands'];
  if (!Array.isArray(hands)) return false;
  // Cap the array length: the real client always sends exactly 2 hands. A large
  // all-finite hands array would otherwise be relayed 1→N (amplification).
  if (hands.length > MAX_POSE_HANDS) return false;
  for (const hand of hands) {
    if (hand === null) continue;
    if (typeof hand !== 'object') return false;
    const hd = hand as Record<string, unknown>;
    if (!isFiniteVec3(hd['p']) || !isFiniteVec3(hd['q'])) return false;
  }
  return true;
}

/**
 * Validate a single persisted shape loaded from disk (finding #9). A snapshot
 * hand-edited or corrupted on disk must not poison the world with NaN. Requires
 * a string id, a valid ShapeType, and finite position/rotation/velocity/rotSpeed
 * Vec3s. Optional-ish fields (colorIndex/renderMode/scale/bobPhase) are
 * tolerated loosely — only the sim-critical ones are hard-required.
 */
export function isValidPersistedShape(shape: unknown): boolean {
  if (shape === null || typeof shape !== 'object') return false;
  const s = shape as Record<string, unknown>;
  if (typeof s['id'] !== 'string') return false;
  if (!isShapeType(s['type'])) return false;
  if (!isFiniteVec3(s['position'])) return false;
  if (!isFiniteVec3(s['rotation'])) return false;
  if (!isFiniteVec3(s['velocity'])) return false;
  if (!isFiniteVec3(s['rotSpeed'])) return false;
  if (s['scale'] !== undefined && !isFiniteNumber(s['scale'])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Text codec (JSON)
// ---------------------------------------------------------------------------

/** Encode any protocol message to a JSON string. */
export function encodeText(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

/**
 * Decode a JSON string to a protocol message.
 * Throws an `Error` if:
 *  - `s` is not valid JSON
 *  - the parsed value is not a plain object
 *  - the parsed value does not have a string `t` field
 */
export function decodeText(s: string): ClientMsg | ServerMsg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(`decodeText: invalid JSON — ${s}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`decodeText: expected a plain object, got ${JSON.stringify(parsed)}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['t'] !== 'string') {
    throw new Error(
      `decodeText: missing or non-string 't' field — got ${JSON.stringify(obj['t'])}`
    );
  }
  return parsed as ClientMsg | ServerMsg;
}

// ---------------------------------------------------------------------------
// Voice binary frame
//
// Layout: [u8 opcode][u8 senderId][u32 tsMs LE][u8 flags][...opus bytes]
//          byte 0     byte 1       bytes 2-5    byte 6    bytes 7+
// Header size: 7 bytes
// ---------------------------------------------------------------------------

const HEADER_SIZE = 7;

/** Pack a voice frame into an ArrayBuffer. */
export function packVoice(
  opcode: number,
  senderId: number,
  tsMs: number,
  flags: number,
  opus: Uint8Array
): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + opus.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, opcode);
  view.setUint8(1, senderId);
  view.setUint32(2, tsMs, true /* little-endian */);
  view.setUint8(6, flags);
  // Copy opus bytes after header
  if (opus.byteLength > 0) {
    const dest = new Uint8Array(buf, HEADER_SIZE);
    dest.set(opus);
  }
  return buf;
}

/** Unpack a voice frame from an ArrayBuffer. */
export function unpackVoice(buf: ArrayBuffer): {
  opcode: number;
  senderId: number;
  tsMs: number;
  flags: number;
  opus: Uint8Array;
} {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`unpackVoice: buffer too short (${buf.byteLength} < ${HEADER_SIZE})`);
  }
  const view = new DataView(buf);
  const opcode = view.getUint8(0);
  const senderId = view.getUint8(1);
  const tsMs = view.getUint32(2, true /* little-endian */);
  const flags = view.getUint8(6);
  const opus = new Uint8Array(buf.slice(HEADER_SIZE));
  return { opcode, senderId, tsMs, flags, opus };
}

// ---------------------------------------------------------------------------
// isVoiceFrame — discriminate binary vs text messages
// ---------------------------------------------------------------------------

/**
 * Returns true if `data` is a binary voice frame (ArrayBuffer or TypedArray),
 * false for text strings and everything else.
 */
export function isVoiceFrame(data: unknown): boolean {
  if (data instanceof ArrayBuffer) return true;
  // Optionally treat typed arrays as binary frames too
  if (ArrayBuffer.isView(data)) return true;
  return false;
}
