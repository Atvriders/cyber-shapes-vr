// ---------------------------------------------------------------------------
// tools/gen-goldens.mjs — golden-vector generator for Phase C hot binary families
//
// Task C1. Hand-assembled hex is FORBIDDEN (spec Appendix B). This script is the
// SINGLE machine authority for the golden (hex, fields) pairs: it owns the byte
// layout (a plain DataView writer per family, mirroring spec Appendix B exactly)
// and emits, deterministically:
//   1. packages/shared/test/protocol.golden.ts   — the TS golden table consumed
//      by protocol.test.ts (both-direction round-trip against the opcodes.ts
//      codec) and by the markdown-extraction test.
//   2. Appendix B markdown blocks (to stdout with `--print`, or spliced into the
//      spec with `--write-spec`) — the ```golden fenced blocks the extraction
//      test regex-pulls and byte-compares against protocol.golden.ts.
//
// The loop that keeps spec ≡ code ≡ generator:
//   • opcodes.ts encode(fields) must equal these hex     → protocol.test.ts
//   • opcodes.ts decode(hex)     must equal these fields → protocol.test.ts
//   • spec Appendix B hex         must equal these hex     → markdown-extraction test
// If opcodes.ts drifts from this layout, the round-trip test fails; if the spec
// drifts, the extraction test fails. Re-run: `node tools/gen-goldens.mjs --write`.
//
// Usage:
//   node tools/gen-goldens.mjs            # write protocol.golden.ts + print md
//   node tools/gen-goldens.mjs --print    # only print the Appendix B md blocks
//   node tools/gen-goldens.mjs --write-spec  # also splice blocks into the spec
// ---------------------------------------------------------------------------

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const GOLDEN_TS = join(REPO, 'packages/shared/test/protocol.golden.ts');
const SPEC = join(
  REPO,
  'docs/superpowers/specs/2026-07-01-phase-c-neon-broadcast-design.md'
);

// --- opcode / kind bytes (mirror opcodes.ts; this file is the hex authority) ---
const OP = {
  WISP: 0x26,
  MUSIC: 0x29,
  CROWD_CUE: 0x2a,
  CLOCK_PING: 0x30,
  CLOCK_PONG: 0x31,
  CASTER_LINE: 0x33,
  TELEKINESIS: 0x34,
};
const KIND = {
  SINGLE: 0x00,
  WISP_POSE: 0x02,
  MUSIC_CLOCK: 0x00,
  MUSIC_NOTE: 0x01,
  CROWD_CUE: 0x00,
  CROWD_CHARGE: 0x01,
  TK_PULL: 0x00,
  TK_RELEASE: 0x01,
  TK_HANDS_STATE: 0x02,
};

// --- little-endian byte writer (DataView is LE-explicit everywhere) ---
class W {
  constructor(len) {
    this.buf = new ArrayBuffer(len);
    this.dv = new DataView(this.buf);
    this.o = 0;
  }
  u8(v) {
    this.dv.setUint8(this.o, v);
    this.o += 1;
    return this;
  }
  i8(v) {
    this.dv.setInt8(this.o, v);
    this.o += 1;
    return this;
  }
  u16(v) {
    this.dv.setUint16(this.o, v, true);
    this.o += 2;
    return this;
  }
  i16(v) {
    this.dv.setInt16(this.o, v, true);
    this.o += 2;
    return this;
  }
  i32(v) {
    this.dv.setInt32(this.o, v, true);
    this.o += 4;
    return this;
  }
  u32(v) {
    this.dv.setUint32(this.o, v >>> 0, true);
    this.o += 4;
    return this;
  }
  hex() {
    return [...new Uint8Array(this.buf, 0, this.o)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

const pre = (w, op, kind) => w.u8(op).u8(kind);

// ---------------------------------------------------------------------------
// The golden set. Each entry: { name, opcode, kind, fields, hex }.
// Field values are chosen deterministically to exercise every field, signed
// ranges (pan i8 negative, pos i16 negative), and byte-order (multi-byte values
// with distinct bytes so an endianness slip is caught).
// ---------------------------------------------------------------------------

function build() {
  const g = [];

  // CLOCK_PING (0x30/0x00): clientSendMs u32 · lastRttMs u16 · reserved u8
  g.push({
    name: 'CLOCK_PING',
    opcode: OP.CLOCK_PING,
    kind: KIND.SINGLE,
    fields: { clientSendMs: 0x11223344, lastRttMs: 0x00c8, reserved: 0 },
    hex: pre(new W(9), OP.CLOCK_PING, KIND.SINGLE)
      .u32(0x11223344)
      .u16(0x00c8)
      .u8(0)
      .hex(),
  });
  // CLOCK_PING with unknown RTT sentinel (0xFFFF)
  g.push({
    name: 'CLOCK_PING_UNKNOWN_RTT',
    opcode: OP.CLOCK_PING,
    kind: KIND.SINGLE,
    fields: { clientSendMs: 1000, lastRttMs: 0xffff, reserved: 0 },
    hex: pre(new W(9), OP.CLOCK_PING, KIND.SINGLE)
      .u32(1000)
      .u16(0xffff)
      .u8(0)
      .hex(),
  });

  // CLOCK_PONG (0x31/0x00): clientSendMs u32 · serverTimeMs u32 · reserved u8
  g.push({
    name: 'CLOCK_PONG',
    opcode: OP.CLOCK_PONG,
    kind: KIND.SINGLE,
    fields: { clientSendMs: 0x11223344, serverTimeMs: 0x0a0b0c0d, reserved: 0 },
    hex: pre(new W(11), OP.CLOCK_PONG, KIND.SINGLE)
      .u32(0x11223344)
      .u32(0x0a0b0c0d)
      .u8(0)
      .hex(),
  });

  // WISP_POSE (0x26/POSE): wispIndex u8 · pos i16[3] · yaw i16 · reserved u8
  g.push({
    name: 'WISP_POSE',
    opcode: OP.WISP,
    kind: KIND.WISP_POSE,
    fields: { wispIndex: 7, pos: [1000, -500, 250], yaw: 16384, reserved: 0 },
    hex: pre(new W(12), OP.WISP, KIND.WISP_POSE)
      .u8(7)
      .i16(1000)
      .i16(-500)
      .i16(250)
      .i16(16384)
      .u8(0)
      .hex(),
  });

  // MUSIC_CLOCK (0x29/CLOCK): bpm u16 · beatIndex u32 · gridOriginMs u32 · reserved u16
  g.push({
    name: 'MUSIC_CLOCK',
    opcode: OP.MUSIC,
    kind: KIND.MUSIC_CLOCK,
    fields: { bpm: 128, beatIndex: 4096, gridOriginMs: 0x00abcdef, reserved: 0 },
    hex: pre(new W(14), OP.MUSIC, KIND.MUSIC_CLOCK)
      .u16(128)
      .u32(4096)
      .u32(0x00abcdef)
      .u16(0)
      .hex(),
  });

  // MUSIC_NOTE (0x29/NOTE): noteId u32 · playAtMs u32 · pitch u8 · timbre u8 ·
  //                         velocity u8 · pan i8 · reserved u16
  g.push({
    name: 'MUSIC_NOTE',
    opcode: OP.MUSIC,
    kind: KIND.MUSIC_NOTE,
    fields: {
      noteId: 0xdeadbeef,
      playAtMs: 0x01020304,
      pitch: 60,
      timbre: 3,
      velocity: 200,
      pan: -42,
      reserved: 0,
    },
    hex: pre(new W(16), OP.MUSIC, KIND.MUSIC_NOTE)
      .u32(0xdeadbeef)
      .u32(0x01020304)
      .u8(60)
      .u8(3)
      .u8(200)
      .i8(-42)
      .u16(0)
      .hex(),
  });

  // CROWD_CUE (0x2A/CUE): effect u8 · colorIndex u8 · intensity u8 ·
  //                       durationMs u16 · seed u32 · fireAtMs u32 · reserved u8
  g.push({
    name: 'CROWD_CUE',
    opcode: OP.CROWD_CUE,
    kind: KIND.CROWD_CUE,
    fields: {
      effect: 2,
      colorIndex: 5,
      intensity: 180,
      durationMs: 1500,
      seed: 0xcafef00d,
      fireAtMs: 0x00030d40,
      reserved: 0,
    },
    hex: pre(new W(16), OP.CROWD_CUE, KIND.CROWD_CUE)
      .u8(2)
      .u8(5)
      .u8(180)
      .u16(1500)
      .u32(0xcafef00d)
      .u32(0x00030d40)
      .u8(0)
      .hex(),
  });

  // CHARGE_STATE (0x2A/CHARGE): charge u8 · crowdSize u8 · fireAtMs u32 · reserved u16
  g.push({
    name: 'CHARGE_STATE',
    opcode: OP.CROWD_CUE,
    kind: KIND.CROWD_CHARGE,
    fields: { charge: 150, crowdSize: 42, fireAtMs: 0x000493e0, reserved: 0 },
    hex: pre(new W(10), OP.CROWD_CUE, KIND.CROWD_CHARGE)
      .u8(150)
      .u8(42)
      .u32(0x000493e0)
      .u16(0)
      .hex(),
  });

  // CASTER_LINE (0x33/0x00) — C26 MC NULL, VARIABLE-LENGTH: templateId u16 ·
  // slotCount u8 · reserved u8 · then slotCount slots each `tag u8 · a i32 · b i16`.
  // `slots` is the flat [tag,a,b,…] triple array. This golden exercises: a callsign
  // slot (tag 1, wordIndex 5, suffix 200) + a fixed-point number slot with a NEGATIVE
  // i32 (tag 0, value×10 = -184 → -18.4), a 2-byte templateId (byte-order), slotCount=2.
  g.push({
    name: 'CASTER_LINE',
    opcode: OP.CASTER_LINE,
    kind: KIND.SINGLE,
    fields: { templateId: 258, slots: [1, 5, 200, 0, -184, 0] },
    hex: pre(new W(20), OP.CASTER_LINE, KIND.SINGLE)
      .u16(258)
      .u8(2)
      .u8(0)
      .u8(1)
      .i32(5)
      .i16(200)
      .u8(0)
      .i32(-184)
      .i16(0)
      .hex(),
  });

  // TK_PULL (0x34/0x00) — C32 F21 Powers Lab: hand u8 · anchor i16[3] (1 unit =
  // 4 mm) · dir i16[3] (1 unit = 1/32767 normalized) · reserved u8. This golden
  // exercises: hand=1 (right), a NEGATIVE anchor component (byte order / sign),
  // and a normalized −z-ish cone axis (dir ≈ (0,0,−1) → z = −32767).
  g.push({
    name: 'TK_PULL',
    opcode: OP.TELEKINESIS,
    kind: KIND.TK_PULL,
    fields: { hand: 1, anchor: [250, 400, -1250], dir: [0, 0, -32767], reserved: 0 },
    hex: pre(new W(16), OP.TELEKINESIS, KIND.TK_PULL)
      .u8(1)
      .i16(250)
      .i16(400)
      .i16(-1250)
      .i16(0)
      .i16(0)
      .i16(-32767)
      .u8(0)
      .hex(),
  });

  // TK_RELEASE (0x34/0x01) — the throw: hand u8 · vel i16[3] (1 unit = 1 mm/s) ·
  // reserved u8. Exercises a hand=0 (left) release with a NEGATIVE x throw.
  g.push({
    name: 'TK_RELEASE',
    opcode: OP.TELEKINESIS,
    kind: KIND.TK_RELEASE,
    fields: { hand: 0, vel: [-3200, 1500, 0], reserved: 0 },
    hex: pre(new W(10), OP.TELEKINESIS, KIND.TK_RELEASE)
      .u8(0)
      .i16(-3200)
      .i16(1500)
      .i16(0)
      .u8(0)
      .hex(),
  });

  // TK_HANDS_STATE (0x34/0x02) — the capability signal: available u8 · reserved u8.
  g.push({
    name: 'TK_HANDS_STATE',
    opcode: OP.TELEKINESIS,
    kind: KIND.TK_HANDS_STATE,
    fields: { available: 1, reserved: 0 },
    hex: pre(new W(4), OP.TELEKINESIS, KIND.TK_HANDS_STATE).u8(1).u8(0).hex(),
  });

  return g;
}

// ---------------------------------------------------------------------------
// Emit protocol.golden.ts
// ---------------------------------------------------------------------------
function goldenTs(g) {
  const rows = g
    .map(
      (e) =>
        `  {\n    name: '${e.name}',\n    opcode: 0x${e.opcode
          .toString(16)
          .padStart(2, '0')},\n    kind: 0x${e.kind
          .toString(16)
          .padStart(2, '0')},\n    fields: ${JSON.stringify(
          e.fields
        )},\n    hex: '${e.hex}',\n  },`
    )
    .join('\n');
  return `// GENERATED by tools/gen-goldens.mjs — DO NOT EDIT BY HAND.
// Re-run: \`node tools/gen-goldens.mjs --write\`. Hand-assembled hex is forbidden
// (spec Appendix B). Each row is a normative (fields, hex) pair for a hot Phase C
// binary family; protocol.test.ts asserts BOTH directions against the opcodes.ts
// codec, and the markdown-extraction test asserts these hex equal the spec.

export interface GoldenVector {
  name: string;
  opcode: number;
  kind: number;
  fields: Record<string, number | number[]>;
  hex: string;
}

export const GOLDEN_VECTORS: GoldenVector[] = [
${rows}
];
`;
}

// ---------------------------------------------------------------------------
// Emit Appendix B markdown golden blocks. The extraction test pulls fenced
// ```golden blocks and reads `NAME <hex>` lines.
// ---------------------------------------------------------------------------
function markdownBlock(g) {
  const lines = g.map((e) => `${e.name} ${e.hex}`).join('\n');
  return '```golden\n' + lines + '\n```';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const g = build();

if (!args.has('--print')) {
  writeFileSync(GOLDEN_TS, goldenTs(g));
  console.error(`wrote ${GOLDEN_TS}`);
}

const md = markdownBlock(g);

if (args.has('--write-spec')) {
  const src = readFileSync(SPEC, 'utf8');
  const START = '<!-- GOLDENS:START -->';
  const END = '<!-- GOLDENS:END -->';
  if (!src.includes(START) || !src.includes(END)) {
    console.error(
      `spec is missing ${START}/${END} markers around the golden block; add them in Appendix B first`
    );
    process.exit(1);
  }
  const out = src.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`),
    `${START}\n${md}\n${END}`
  );
  writeFileSync(SPEC, out);
  console.error(`spliced golden block into ${SPEC}`);
} else {
  console.log(md);
}
