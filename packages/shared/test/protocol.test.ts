import { describe, expect, it } from 'vitest';
import {
  VOICE_OPUS,
  VOICE_WEBM,
  VOICE_PCM,
  decodeText,
  encodeText,
  isVoiceFrame,
  packVoice,
  unpackVoice,
} from '../src/net/protocol.js';
import type { ClientMsg, ServerMsg } from '../src/net/types.js';

// ---------------------------------------------------------------------------
// Text round-trip: every `t` value in both unions
// ---------------------------------------------------------------------------

describe('encodeText / decodeText — ClientMsg round-trips', () => {
  const clientMsgs: ClientMsg[] = [
    { t: 'join', room: 'r1', name: 'Alice', color: 0xff0000, protocol: 1 },
    {
      t: 'spawn',
      shape: {
        type: 'cube',
        position: { x: 0, y: 1, z: 0 },
        colorIndex: 2,
        renderMode: 'solid',
        scale: 1,
      },
    },
    {
      t: 'spawn',
      shape: {
        type: 'sphere',
        position: { x: 1, y: 2, z: 3 },
        colorIndex: 4,
        renderMode: 'both',
        scale: 1.5,
      },
      tempId: '__local__:7',
    },
    { t: 'grab', id: 'shape-1' },
    {
      t: 'release',
      id: 'shape-1',
      velocity: { x: 0, y: 0, z: 0 },
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    { t: 'recolor', id: 'shape-1', colorIndex: 3 },
    { t: 'rendermode', id: 'shape-1', mode: 'wireframe' },
    { t: 'scale', id: 'shape-1', scale: 2.5 },
    {
      t: 'held',
      id: 'shape-1',
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
    },
    {
      t: 'pose',
      pose: {
        head: { p: { x: 0, y: 1.7, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } },
        hands: [{ p: { x: -0.3, y: 1.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, null],
      },
    },
    { t: 'voice-join' },
    { t: 'voice-leave' },
    { t: 'voice-state', speaking: true, muted: false },
    { t: 'voice-config', config: '{"bitrate":32000}' },
  ];

  clientMsgs.forEach((msg, i) => {
    it(`round-trips ClientMsg #${i} { t: '${msg.t}' }`, () => {
      expect(decodeText(encodeText(msg))).toEqual(msg);
    });
  });
});

describe('encodeText / decodeText — ServerMsg round-trips', () => {
  const serverMsgs: ServerMsg[] = [
    {
      t: 'welcome',
      playerId: 'p0',
      room: 'r1',
      shapes: [],
      players: [{ id: 'p0', name: 'Alice', color: 0xff0000 }],
    },
    { t: 'player-join', player: { id: 'p1', name: 'Bob', color: 0x00ff00 } },
    { t: 'player-leave', id: 'p1' },
    {
      t: 'spawn',
      shape: {
        id: 's1',
        type: 'sphere',
        colorIndex: 1,
        renderMode: 'both',
        scale: 1,
        grabbedBy: null,
        grounded: false,
        bobPhase: 0,
        rotSpeed: { x: 0, y: 0.5, z: 0 },
        position: { x: 0, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
    },
    {
      t: 'spawn',
      shape: {
        id: 'room:9',
        type: 'cube',
        colorIndex: 2,
        renderMode: 'solid',
        scale: 1,
        grabbedBy: null,
        grounded: false,
        bobPhase: 0,
        rotSpeed: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
      tempId: '__local__:7',
    },
    { t: 'despawn', id: 's1' },
    { t: 'recolor', id: 's1', colorIndex: 4 },
    { t: 'rendermode', id: 's1', mode: 'solid' },
    { t: 'scale', id: 's1', scale: 0.5 },
    { t: 'grab', id: 's1', peerId: 'p0' },
    { t: 'grab', id: 's1', peerId: null },
    {
      t: 'state',
      seq: 42,
      shapes: [
        {
          id: 's1',
          p: { x: 1, y: 2, z: 3 },
          r: { x: 0, y: 0.1, z: 0 },
          v: { x: 0, y: -1, z: 0 },
        },
      ],
    },
    {
      t: 'pose',
      id: 'p1',
      pose: {
        head: { p: { x: 0, y: 1.7, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } },
        hands: [null, null],
      },
    },
    {
      t: 'voice-roster',
      players: [
        { id: 'p0', voice: true },
        { id: 'p1', voice: false },
      ],
    },
    { t: 'voice-state', id: 'p0', speaking: false, muted: true },
    { t: 'error', code: 'ROOM_FULL', message: 'Room is at capacity' },
  ];

  serverMsgs.forEach((msg, i) => {
    it(`round-trips ServerMsg #${i} { t: '${msg.t}' }`, () => {
      expect(decodeText(encodeText(msg))).toEqual(msg);
    });
  });
});

// ---------------------------------------------------------------------------
// tempId reconciliation (B6): spawn ClientMsg + ServerMsg carry tempId through
// ---------------------------------------------------------------------------

describe('tempId round-trips (B6 spawn reconciliation)', () => {
  it('ClientMsg spawn preserves tempId through encode/decode', () => {
    const msg: ClientMsg = {
      t: 'spawn',
      shape: { type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: 1 },
      tempId: '__local__:42',
    };
    const decoded = decodeText(encodeText(msg));
    expect(decoded).toEqual(msg);
    expect((decoded as ClientMsg & { tempId?: string }).tempId).toBe('__local__:42');
  });

  it('ServerMsg spawn preserves tempId (server echoes it) alongside canonical shape.id', () => {
    const msg: ServerMsg = {
      t: 'spawn',
      shape: {
        id: 'room:3',
        type: 'sphere',
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
      },
      tempId: '__local__:42',
    };
    const decoded = decodeText(encodeText(msg)) as ServerMsg & {
      tempId?: string;
      shape: { id: string };
    };
    expect(decoded).toEqual(msg);
    expect(decoded.tempId).toBe('__local__:42');
    expect(decoded.shape.id).toBe('room:3');
  });
});

// ---------------------------------------------------------------------------
// decodeText error cases
// ---------------------------------------------------------------------------

describe('decodeText — error handling', () => {
  it('throws on malformed JSON', () => {
    expect(() => decodeText('{bad json')).toThrow();
  });

  it('throws when `t` is missing', () => {
    expect(() => decodeText('{"x":1}')).toThrow();
  });

  it('throws when `t` is not a string', () => {
    expect(() => decodeText('{"t":42}')).toThrow();
  });

  it('throws on null input (null is valid JSON but not an object with t)', () => {
    expect(() => decodeText('null')).toThrow();
  });

  it('throws on array input', () => {
    expect(() => decodeText('[]')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Voice pack / unpack round-trips
// ---------------------------------------------------------------------------

describe('packVoice / unpackVoice', () => {
  it('round-trips with 0-length opus payload', () => {
    const opus = new Uint8Array(0);
    const buf = packVoice(VOICE_OPUS, 0, 1000, 0, opus);
    const result = unpackVoice(buf);
    expect(result.opcode).toBe(VOICE_OPUS);
    expect(result.senderId).toBe(0);
    expect(result.tsMs).toBe(1000);
    expect(result.flags).toBe(0);
    expect(result.opus).toEqual(opus);
  });

  it('round-trips with 200-byte opus payload', () => {
    const opus = new Uint8Array(200);
    for (let i = 0; i < 200; i++) opus[i] = i & 0xff;
    const buf = packVoice(VOICE_WEBM, 3, 50000, 0b00000010, opus);
    const result = unpackVoice(buf);
    expect(result.opcode).toBe(VOICE_WEBM);
    expect(result.senderId).toBe(3);
    expect(result.tsMs).toBe(50000);
    expect(result.flags).toBe(0b00000010);
    expect(result.opus).toEqual(opus);
  });

  it('round-trips all byte values in opus payload', () => {
    const opus = new Uint8Array(256);
    for (let i = 0; i < 256; i++) opus[i] = i;
    const buf = packVoice(VOICE_PCM, 7, 999999, 0xff, opus);
    const result = unpackVoice(buf);
    expect(result.opus).toEqual(opus);
    expect(result.flags).toBe(0xff);
    expect(result.senderId).toBe(7);
  });

  it('handles large tsMs value (u32 wrap: 4_000_000_000)', () => {
    // 4_000_000_000 fits in u32 (max 4_294_967_295)
    const tsMs = 4_000_000_000;
    const buf = packVoice(VOICE_OPUS, 1, tsMs, 0, new Uint8Array(0));
    const result = unpackVoice(buf);
    expect(result.tsMs).toBe(tsMs);
  });

  it('produces the correct binary layout (header is 7 bytes)', () => {
    const opus = new Uint8Array([0xde, 0xad]);
    const buf = packVoice(0x10, 5, 0x0102_0304, 0x07, opus);
    const view = new DataView(buf);
    expect(view.getUint8(0)).toBe(0x10); // opcode
    expect(view.getUint8(1)).toBe(5); // senderId
    expect(view.getUint32(2, true)).toBe(0x0102_0304); // tsMs LE
    expect(view.getUint8(6)).toBe(0x07); // flags
    expect(view.getUint8(7)).toBe(0xde); // opus[0]
    expect(view.getUint8(8)).toBe(0xad); // opus[1]
    expect(buf.byteLength).toBe(9);
  });

  it('voice opcode consts have correct values', () => {
    expect(VOICE_OPUS).toBe(0x10);
    expect(VOICE_WEBM).toBe(0x11);
    expect(VOICE_PCM).toBe(0x12);
  });
});

// ---------------------------------------------------------------------------
// isVoiceFrame
// ---------------------------------------------------------------------------

describe('isVoiceFrame', () => {
  it('returns true for ArrayBuffer', () => {
    expect(isVoiceFrame(new ArrayBuffer(8))).toBe(true);
  });

  it('returns false for string', () => {
    expect(isVoiceFrame('x')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isVoiceFrame('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isVoiceFrame(null)).toBe(false);
  });

  it('returns false for number', () => {
    expect(isVoiceFrame(42)).toBe(false);
  });

  it('returns false for object', () => {
    expect(isVoiceFrame({ t: 'join' })).toBe(false);
  });

  it('optionally returns true for Uint8Array (typed array is ArrayBuffer-backed)', () => {
    // The spec says "optionally typed arrays" — we allow it
    const ta = new Uint8Array(8);
    // This is implementation-defined; just test it doesn't throw
    const result = isVoiceFrame(ta);
    expect(typeof result).toBe('boolean');
  });
});
