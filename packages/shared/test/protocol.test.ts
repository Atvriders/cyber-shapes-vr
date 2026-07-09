import { describe, expect, it } from 'vitest';
import {
  VOICE_OPUS,
  VOICE_WEBM,
  VOICE_PCM,
  decodeText,
  encodeText,
  isVoiceFrame,
  isVoiceOpcode,
  voiceOpcodeOf,
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

// ---------------------------------------------------------------------------
// Phase C (Task C0) — additive protocol accommodations at the codec layer.
// ---------------------------------------------------------------------------

describe('Phase C accommodation #1 — binary opcode demux (isVoiceOpcode / voiceOpcodeOf)', () => {
  it('isVoiceOpcode is true for the three voice opcodes only', () => {
    expect(isVoiceOpcode(VOICE_OPUS)).toBe(true);
    expect(isVoiceOpcode(VOICE_WEBM)).toBe(true);
    expect(isVoiceOpcode(VOICE_PCM)).toBe(true);
  });

  it('isVoiceOpcode is false for Phase C opcodes (0x20–0x3F) and other bytes', () => {
    expect(isVoiceOpcode(0x20)).toBe(false); // TIER_HELLO (C1)
    expect(isVoiceOpcode(0x2d)).toBe(false); // GRAB_REJECTED (C1)
    expect(isVoiceOpcode(0x3f)).toBe(false); // reserved-free
    expect(isVoiceOpcode(0x00)).toBe(false);
    expect(isVoiceOpcode(0xff)).toBe(false);
  });

  it('voiceOpcodeOf reads the leading opcode byte of a voice frame', () => {
    const buf = packVoice(VOICE_OPUS, 3, 1234, 0, new Uint8Array([1, 2, 3]));
    expect(voiceOpcodeOf(buf)).toBe(VOICE_OPUS);
  });

  it('voiceOpcodeOf returns null for an empty buffer, and a non-voice byte for a foreign frame', () => {
    expect(voiceOpcodeOf(new ArrayBuffer(0))).toBeNull();
    // A hypothetical Phase C binary frame with a 0x2D first byte demuxes as non-voice.
    const foreign = new Uint8Array([0x2d, 0x00, 0xaa]).buffer;
    const op = voiceOpcodeOf(foreign);
    expect(op).toBe(0x2d);
    expect(isVoiceOpcode(op!)).toBe(false);
  });
});

describe('Phase C accommodations #2/#3/#5 — state + release message shapes round-trip', () => {
  it('a state message with serverTick and per-shape impactSpeed `s` round-trips', () => {
    const msg: ServerMsg = {
      t: 'state',
      seq: 7,
      serverTick: 42,
      shapes: [
        { id: 'r:0', p: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: -5, z: 0 }, s: 5.5 },
        { id: 'r:1', p: { x: 0, y: 1, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } },
      ],
    };
    const back = decodeText(encodeText(msg)) as ServerMsg;
    expect(back).toEqual(msg);
    if (back.t === 'state') {
      expect(back.serverTick).toBe(42);
      expect(back.shapes[0].s).toBe(5.5);
      expect(back.shapes[1].s).toBeUndefined();
    }
  });

  it('a release grab event (peerId:null) with server-computed pos/vel round-trips', () => {
    const msg: ServerMsg = {
      t: 'grab',
      id: 'r:0',
      peerId: null,
      pos: { x: 4, y: 5, z: 6 },
      vel: { x: 1, y: 2, z: 3 },
    };
    const back = decodeText(encodeText(msg)) as ServerMsg;
    expect(back).toEqual(msg);
  });

  it('a broadcastable grab-rejected event round-trips (accommodation #4)', () => {
    const msg: ServerMsg = { t: 'grab-rejected', id: 'r:0', peerId: 'p1', by: 'p0' };
    const back = decodeText(encodeText(msg)) as ServerMsg;
    expect(back).toEqual(msg);
  });
});

// ===========================================================================
// Task C1 — 0x20–0x3F opcode registry + per-family kind enums + exhaustiveness
// ===========================================================================

import {
  OPCODES,
  ALL_OPCODES,
  KIND_ENUMS,
  DIRECTOR_KIND,
  VOTE_KIND,
  WISP_KIND,
  SHOWPIECE_KIND,
  MUSIC_KIND,
  CROWD_KIND,
  GLYPH_KIND,
  REEL_KIND,
  TELEKINESIS_KIND,
  BUILD_KIND,
  encodeBinary,
  decodeBinary,
} from '../src/protocol/opcodes.js';

describe('C1 OPCODES registry', () => {
  const values = Object.values(OPCODES) as number[];

  it('every opcode lies within the Phase C 0x20–0x3F window', () => {
    for (const [name, v] of Object.entries(OPCODES)) {
      expect(v, name).toBeGreaterThanOrEqual(0x20);
      expect(v, name).toBeLessThanOrEqual(0x3f);
    }
  });

  it('opcodes are unique (exhaustive over the whole map)', () => {
    expect(new Set(values).size).toBe(values.length);
  });

  it('never collides with Phase A game (0x00–0x0F) or Phase B voice (0x10–0x1F)', () => {
    for (const v of values) expect(v).toBeGreaterThan(0x1f);
  });

  it('mints the exact expected assignments (spec §5.2 / brief)', () => {
    expect(OPCODES).toMatchObject({
      TIER_HELLO: 0x20,
      PHASE_STATE: 0x21,
      DIRECTOR: 0x22,
      ENV_STATE: 0x23,
      THEME_SET: 0x24,
      VOTE: 0x25,
      WISP: 0x26,
      SHOWPIECE: 0x27,
      PLAYER_SCALE: 0x28,
      MUSIC: 0x29,
      CROWD_CUE: 0x2a,
      GLYPH: 0x2b,
      REEL: 0x2c,
      GRAB_REJECTED: 0x2d,
      STATS_CARD: 0x2e,
      METRICS_PING: 0x2f,
      CLOCK_PING: 0x30,
      CLOCK_PONG: 0x31,
      AUDIENCE_STATE: 0x32,
      CASTER_LINE: 0x33,
      TELEKINESIS: 0x34,
      BUILD: 0x35,
    });
  });

  it('0x36–0x3F stay reserved-free (no opcode is minted there)', () => {
    for (let b = 0x36; b <= 0x3f; b++) {
      expect(values.includes(b), `0x${b.toString(16)} must be unminted`).toBe(false);
    }
  });

  it('ALL_OPCODES is the sorted set of minted opcode bytes', () => {
    expect(ALL_OPCODES).toEqual([...values].sort((a, b) => a - b));
  });
});

describe('C1 per-family kind enums', () => {
  it('every registered family kind enum has unique kind bytes within itself', () => {
    for (const [family, enumObj] of Object.entries(KIND_ENUMS)) {
      const ks = Object.values(enumObj) as number[];
      expect(new Set(ks).size, `${family} has duplicate kind bytes`).toBe(ks.length);
      for (const k of ks) {
        expect(k, `${family} kind out of u8 range`).toBeGreaterThanOrEqual(0);
        expect(k, `${family} kind out of u8 range`).toBeLessThanOrEqual(0xff);
      }
    }
  });

  it('single-kind families use kind 0x00 (Appendix B rule)', () => {
    // Families with exactly one kind must name it 0x00.
    for (const [family, enumObj] of Object.entries(KIND_ENUMS)) {
      const entries = Object.entries(enumObj);
      if (entries.length === 1) {
        expect(entries[0][1], `${family} single kind`).toBe(0x00);
      }
    }
  });

  it('multi-kind families expose the spec-named kinds', () => {
    expect(DIRECTOR_KIND).toMatchObject({ CMD: 0, CATALOG: 1, ACK: 2 });
    expect(VOTE_KIND).toMatchObject({ OPEN: 0, CAST: 1, TALLY: 2, RESULT: 3 });
    expect(WISP_KIND).toMatchObject({ JOIN: 0, LEAVE: 1, POSE: 2, PULSE: 3, ROSTER: 4 });
    expect(SHOWPIECE_KIND).toMatchObject({
      START: 0,
      STATE: 1,
      END: 2,
      MET_LAUNCH: 3,
      MET_HIT: 4,
    });
    expect(MUSIC_KIND).toMatchObject({ CLOCK: 0, NOTE: 1 });
    expect(CROWD_KIND).toMatchObject({ CUE: 0, CHARGE: 1 });
    expect(GLYPH_KIND).toMatchObject({ ADD: 0, ACK: 1, REMOVE: 2, HIDE: 3 });
    expect(REEL_KIND).toMatchObject({ REEL: 0, REQUEST_SNAPSHOT: 1 });
    expect(TELEKINESIS_KIND).toMatchObject({ TK_PULL: 0, TK_RELEASE: 1, TK_HANDS_STATE: 2 });
    // BUILD kinds land with C34 — the enum exists (single-kind placeholder) now.
    expect(Object.keys(BUILD_KIND).length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// C1 — golden vectors: BOTH directions against the opcodes.ts codec
// ===========================================================================

import { GOLDEN_VECTORS } from './protocol.golden.js';

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}
function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('C1 golden vectors — round-trip both directions', () => {
  for (const g of GOLDEN_VECTORS) {
    it(`${g.name}: decode(hex) ≡ fields`, () => {
      const decoded = decodeBinary(hexToBuf(g.hex));
      expect(decoded.opcode).toBe(g.opcode);
      expect(decoded.kind).toBe(g.kind);
      expect(decoded.fields).toEqual(g.fields);
    });

    it(`${g.name}: encode(fields) ≡ hex`, () => {
      const buf = encodeBinary(g.opcode, g.kind, g.fields);
      expect(bufToHex(buf)).toBe(g.hex);
    });
  }

  it('covers the hot families named in Appendix B (incl. the C32 TK family)', () => {
    const names = new Set(GOLDEN_VECTORS.map((g) => g.name));
    for (const required of [
      'CLOCK_PING',
      'CLOCK_PONG',
      'WISP_POSE',
      'MUSIC_CLOCK',
      'MUSIC_NOTE',
      'CROWD_CUE',
      'CHARGE_STATE',
      'CASTER_LINE',
      'TK_PULL',
      'TK_RELEASE',
      'TK_HANDS_STATE',
    ]) {
      expect(names.has(required), `missing golden for ${required}`).toBe(true);
    }
  });
});

// ===========================================================================
// C1 — markdown-extraction test: the spec Appendix B ```golden block must equal
// protocol.golden.ts byte-for-byte (the doc cannot drift from the code).
// ===========================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('C1 markdown-extraction — spec Appendix B ≡ protocol.golden.ts', () => {
  const specPath = fileURLToPath(
    new URL(
      '../../../docs/superpowers/specs/2026-07-01-phase-c-neon-broadcast-design.md',
      import.meta.url
    )
  );

  it('every golden hex in the spec matches the generated golden table', () => {
    const md = readFileSync(specPath, 'utf8');
    const block = md.match(/```golden\n([\s\S]*?)\n```/);
    expect(block, 'spec Appendix B must contain a ```golden fenced block').not.toBeNull();
    const specPairs = new Map<string, string>();
    for (const line of block![1].trim().split('\n')) {
      const [name, hex] = line.trim().split(/\s+/);
      specPairs.set(name, hex);
    }
    // Every generated vector must appear in the spec with identical hex.
    for (const g of GOLDEN_VECTORS) {
      expect(specPairs.get(g.name), `spec missing golden for ${g.name}`).toBe(g.hex);
    }
    // And the spec block must not carry extra/stale rows.
    expect(specPairs.size).toBe(GOLDEN_VECTORS.length);
  });
});

// ===========================================================================
// C1 — tiers: TIER_CAPS / TIER_POLICY exhaustive over Tier + whitelist
// ===========================================================================

import {
  TIERS,
  TIER_CAPS,
  TIER_POLICY,
  SPECTATOR_SEND_WHITELIST,
  AUDIENCE_RECV_FAMILIES,
  AUDIENCE_RECV_BINARY_OPCODES,
  AUDIENCE_MAX_PER_IP,
} from '../src/tiers.js';

describe('C1 tiers', () => {
  it('TIERS lists the six Phase C tiers (audience landed with C25)', () => {
    expect([...TIERS].sort()).toEqual(
      ['audience', 'crowd', 'director', 'resident', 'spectator', 'wisp'].sort()
    );
  });

  it('TIER_CAPS is exhaustive over Tier with the spec §5.1 caps', () => {
    expect(Object.keys(TIER_CAPS).sort()).toEqual([...TIERS].sort());
    expect(TIER_CAPS).toMatchObject({
      resident: 8,
      spectator: 2,
      director: 2,
      wisp: 24,
      crowd: 64,
      audience: 128,
    });
  });

  it('TIER_POLICY is exhaustive over Tier and carries authRequired + voiceRecv', () => {
    expect(Object.keys(TIER_POLICY).sort()).toEqual([...TIERS].sort());
    for (const tier of TIERS) {
      const p = TIER_POLICY[tier];
      expect(typeof p.authRequired, `${tier}.authRequired`).toBe('boolean');
      expect(typeof p.voiceRecv, `${tier}.voiceRecv`).toBe('boolean');
    }
  });

  it('encodes the spec §5.1 auth + voice matrix', () => {
    // resident/spectator require the join secret; the rest are public.
    expect(TIER_POLICY.resident.authRequired).toBe(true);
    expect(TIER_POLICY.spectator.authRequired).toBe(true);
    expect(TIER_POLICY.wisp.authRequired).toBe(false);
    expect(TIER_POLICY.crowd.authRequired).toBe(false);
    expect(TIER_POLICY.audience.authRequired).toBe(false); // permalink-public (C25)
    // voice frames fan out to authed resident + spectator only.
    expect(TIER_POLICY.resident.voiceRecv).toBe(true);
    expect(TIER_POLICY.spectator.voiceRecv).toBe(true);
    expect(TIER_POLICY.wisp.voiceRecv).toBe(false);
    expect(TIER_POLICY.crowd.voiceRecv).toBe(false);
    expect(TIER_POLICY.director.voiceRecv).toBe(false);
    // C25: audience is NEVER a voice receiver/sender (the egress invariant).
    expect(TIER_POLICY.audience.voiceRecv).toBe(false);
    expect(TIER_POLICY.audience.voiceSend).toBe(false);
  });

  it('C25: the audience tier is additive + receive-only (spec §5.1/§7.14)', () => {
    const a = TIER_POLICY.audience;
    // Strictly less than a spectator: no intents, idle-kicked, its own receive class.
    expect(a.canSendIntents).toBe(false);
    expect(a.idleKick).toBe(true);
    expect(a.receive).toBe('audience');
    expect(a.cap).toBe(128);
    // The additive per-family receive field IS the §5.1 audience-row union.
    expect(a.receiveFamilies).toBe(AUDIENCE_RECV_FAMILIES);
    // Tier ≤5 must NOT have gained the additive field (shape unchanged for them).
    for (const t of ['resident', 'spectator', 'director', 'wisp', 'crowd'] as const) {
      expect(TIER_POLICY[t].receiveFamilies, `${t}.receiveFamilies`).toBeUndefined();
    }
  });

  it('C25: AUDIENCE_RECV_FAMILIES is the §5.1 union — includes the enumerated set, excludes full-rate/voice', () => {
    // The union VERBATIM (state-sync + summaries + glyphs + counter + keyframe).
    for (const fam of [
      'phase-state',
      'env-state',
      'theme-set',
      'stats-card',
      'vote',
      'showpiece',
      'glyph',
      'glyph-remove',
      'glyph-hide',
      'audience-state',
      'audience-keyframe',
    ]) {
      expect(AUDIENCE_RECV_FAMILIES.has(fam), `union should include ${fam}`).toBe(true);
    }
    // The egress/security invariant: NEVER a full-rate delta, pose, or snapshot.
    for (const fam of ['state', 'pose', 'welcome', 'voice-state', 'voice-roster']) {
      expect(AUDIENCE_RECV_FAMILIES.has(fam), `union must exclude ${fam}`).toBe(false);
    }
  });

  it('C25: AUDIENCE_RECV_BINARY_OPCODES = MUSIC + CROWD_CUE, never a voice opcode', () => {
    expect(AUDIENCE_RECV_BINARY_OPCODES.has(OPCODES.MUSIC)).toBe(true);
    expect(AUDIENCE_RECV_BINARY_OPCODES.has(OPCODES.CROWD_CUE)).toBe(true);
    // Voice opcodes (0x10–0x1F) are never audience-admitted.
    for (let op = 0x10; op <= 0x1f; op++) {
      expect(AUDIENCE_RECV_BINARY_OPCODES.has(op), `voice op ${op} must be excluded`).toBe(false);
    }
    expect(AUDIENCE_MAX_PER_IP).toBe(4);
  });

  it('C26: CASTER_LINE (0x33) attaches to the audience binary allowlist WITHOUT weakening the C25 boundary', () => {
    // The attach-if-landed addition — the 128 watch screens get captions.
    expect(AUDIENCE_RECV_BINARY_OPCODES.has(OPCODES.CASTER_LINE)).toBe(true);
    // The C25 receive-only boundary is INTACT: still never a voice frame …
    for (let op = 0x10; op <= 0x1f; op++) {
      expect(AUDIENCE_RECV_BINARY_OPCODES.has(op), `voice op ${op} still excluded`).toBe(false);
    }
    // … and the JSON union still excludes every full-rate / snapshot family.
    for (const fam of ['state', 'pose', 'welcome', 'voice-state', 'voice-roster']) {
      expect(AUDIENCE_RECV_FAMILIES.has(fam), `audience union must still exclude ${fam}`).toBe(false);
    }
  });

  it('SPECTATOR_SEND_WHITELIST allows heartbeat + CLOCK_PING + REEL family + stream-subscription control', () => {
    expect(SPECTATOR_SEND_WHITELIST.has(OPCODES.CLOCK_PING)).toBe(true);
    expect(SPECTATOR_SEND_WHITELIST.has(OPCODES.REEL)).toBe(true);
    // Not an intent-carrying opcode — a spectator may not spawn/grab.
    expect(SPECTATOR_SEND_WHITELIST.has(OPCODES.WISP)).toBe(false);
  });
});
