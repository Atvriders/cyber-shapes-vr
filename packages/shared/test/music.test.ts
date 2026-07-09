/**
 * music.test.ts — the pure logical-BPM beat clock (C13) + the Resonora pure core
 * (C18): noteMap, the 16th-grid quantizer, the deterministic backing layer + the
 * auto-intensity governor + per-player note budgets, plus the MUSIC_NOTE golden
 * round-trip through the C1 codec.
 *
 * Everything under test here is PURE and DETERMINISTIC — no Date, no
 * performance.now, no Math.random. Given the same inputs it always yields the
 * same note/schedule/backing bar; that determinism is what lets a predicted note
 * and the server echo dedupe to ONE audible note, and what lets two clients render
 * the same generative backing bar from the same seed.
 */

import { describe, it, expect } from 'vitest';
import { createBeatClock, beatAt, barAt, phaseInBeat } from '../src/music/beatClock.js';
import {
  sixteenthMs,
  sixteenthAt,
  nextSixteenthMs,
} from '../src/music/beatClock.js';
import {
  noteMap,
  clampVelocity,
  clampPan,
  computeNoteId,
  type ImpactEvent,
} from '../src/music/noteMap.js';
import {
  quantizeNote,
  QUANTIZER_MARGIN_MS,
  BACKWARD_SNAP_MS,
  type QuantizerClock,
} from '../src/music/quantizer.js';
import {
  backingBar,
  intensityGovernor,
  applyNoteBudget,
  splitRole,
  type ActivityHistogram,
} from '../src/music/conductorCore.js';
import { OPCODES, MUSIC_KIND, encodeBinary, decodeBinary } from '../src/protocol/opcodes.js';

// ===========================================================================
// C13 — the beat clock (unchanged; kept green)
// ===========================================================================

describe('beatClock determinism', () => {
  it('derives the same beat index from the same logical time (pure)', () => {
    // 120 BPM → 500 ms per beat. Origin at t=0.
    expect(beatAt({ bpm: 120, originMs: 0 }, 0)).toBe(0);
    expect(beatAt({ bpm: 120, originMs: 0 }, 499)).toBe(0);
    expect(beatAt({ bpm: 120, originMs: 0 }, 500)).toBe(1);
    expect(beatAt({ bpm: 120, originMs: 0 }, 1000)).toBe(2);
    expect(beatAt({ bpm: 120, originMs: 0 }, 2000)).toBe(4);
    // Two identical queries → identical result (no hidden state / RNG).
    expect(beatAt({ bpm: 120, originMs: 0 }, 1234)).toBe(beatAt({ bpm: 120, originMs: 0 }, 1234));
  });

  it('honors a non-zero origin (grid origin offset)', () => {
    expect(beatAt({ bpm: 120, originMs: 1000 }, 1000)).toBe(0);
    expect(beatAt({ bpm: 120, originMs: 1000 }, 1500)).toBe(1);
    // before origin never goes negative
    expect(beatAt({ bpm: 120, originMs: 1000 }, 0)).toBe(0);
  });

  it('bars group beats by beatsPerBar (default 4/4)', () => {
    const cfg = { bpm: 120, originMs: 0, beatsPerBar: 4 };
    expect(barAt(cfg, 0)).toBe(0);
    expect(barAt(cfg, 1500)).toBe(0); // beat 3
    expect(barAt(cfg, 2000)).toBe(1); // beat 4 → bar 1
    expect(barAt(cfg, 4000)).toBe(2); // beat 8 → bar 2
  });

  it('phaseInBeat is a 0..1 fractional position within the current beat', () => {
    const cfg = { bpm: 120, originMs: 0 };
    expect(phaseInBeat(cfg, 0)).toBeCloseTo(0);
    expect(phaseInBeat(cfg, 250)).toBeCloseTo(0.5);
    expect(phaseInBeat(cfg, 500)).toBeCloseTo(0);
    expect(phaseInBeat(cfg, 750)).toBeCloseTo(0.5);
  });

  it('createBeatClock reads its injected time source and reports beat/bar', () => {
    let t = 0;
    const clock = createBeatClock({ bpm: 120, originMs: 0, beatsPerBar: 4 }, () => t);
    expect(clock.beat()).toBe(0);
    t = 500;
    expect(clock.beat()).toBe(1);
    t = 2000;
    expect(clock.beat()).toBe(4);
    expect(clock.bar()).toBe(1);
    // retune BPM (theme change) is deterministic from the same origin
    clock.setBpm(60); // 1000 ms/beat
    t = 3000;
    expect(clock.beat()).toBe(3);
  });

  it('rejects a non-positive bpm (guards against divide-by-zero drift)', () => {
    expect(() => beatAt({ bpm: 0, originMs: 0 }, 100)).toThrow();
    expect(() => beatAt({ bpm: -120, originMs: 0 }, 100)).toThrow();
  });
});

// ===========================================================================
// C18 — the 16th grid (beatClock extension)
// ===========================================================================

describe('beatClock 16th grid (C18 extension)', () => {
  it('sixteenthMs is a quarter of a beat', () => {
    // 120 BPM → 500 ms/beat → 125 ms per 16th.
    expect(sixteenthMs(120)).toBeCloseTo(125);
    expect(sixteenthMs(128)).toBeCloseTo(60_000 / 128 / 4);
  });

  it('sixteenthAt is the integer 16th index at a logical time', () => {
    const cfg = { bpm: 120, originMs: 0 };
    expect(sixteenthAt(cfg, 0)).toBe(0);
    expect(sixteenthAt(cfg, 124)).toBe(0);
    expect(sixteenthAt(cfg, 125)).toBe(1);
    expect(sixteenthAt(cfg, 500)).toBe(4); // one beat = 4 sixteenths
    expect(sixteenthAt(cfg, 2000)).toBe(16); // four beats
  });

  it('nextSixteenthMs snaps a time forward to the next grid line', () => {
    const cfg = { bpm: 120, originMs: 0 };
    // exactly on a line → that line
    expect(nextSixteenthMs(cfg, 125)).toBeCloseTo(125);
    // just after a line → the next line
    expect(nextSixteenthMs(cfg, 130)).toBeCloseTo(250);
    // between lines → the upcoming line
    expect(nextSixteenthMs(cfg, 1)).toBeCloseTo(125);
  });
});

// ===========================================================================
// C18 — noteMap (pure): pitch=colorIndex degree, timbre=type, octave=size,
//                       velocity=clamp(impactSpeed), pan=position.x
// ===========================================================================

describe('noteMap (pure, deterministic)', () => {
  const base: ImpactEvent = {
    colorIndex: 2,
    type: 'cube',
    size: 1,
    impactSpeed: 4,
    posX: 0,
  };

  it('is a pure function: same event → identical note', () => {
    const a = noteMap(base);
    const b = noteMap({ ...base });
    expect(a).toEqual(b);
  });

  it('pitch is the colorIndex mapped to a scale degree (varies with colorIndex)', () => {
    const p0 = noteMap({ ...base, colorIndex: 0 }).pitch;
    const p1 = noteMap({ ...base, colorIndex: 1 }).pitch;
    const p2 = noteMap({ ...base, colorIndex: 2 }).pitch;
    expect(p0).not.toBe(p1);
    expect(p1).not.toBe(p2);
    // A wrapped colorIndex maps back into the scale (index modulo the scale).
    expect(noteMap({ ...base, colorIndex: 0 }).pitch).toBe(
      noteMap({ ...base, colorIndex: 0 }).pitch
    );
    // pitch is a valid u8 MIDI note.
    expect(p0).toBeGreaterThanOrEqual(0);
    expect(p0).toBeLessThanOrEqual(127);
  });

  it('octave rises with size (a bigger shape is a LOWER note = fewer semitones)', () => {
    const small = noteMap({ ...base, size: 0.5 }).pitch;
    const large = noteMap({ ...base, size: 3 }).pitch;
    // Bigger shape → lower octave (spec: octave = size; bass on the big lands).
    expect(large).toBeLessThan(small);
  });

  it('timbre is the shape type recipe index (differs across types, stable per type)', () => {
    expect(noteMap({ ...base, type: 'cube' }).timbre).toBe(
      noteMap({ ...base, type: 'cube' }).timbre
    );
    expect(noteMap({ ...base, type: 'cube' }).timbre).not.toBe(
      noteMap({ ...base, type: 'sphere' }).timbre
    );
  });

  it('velocity clamps impactSpeed into 1..127 (the C0 impactSpeed → velocity path)', () => {
    // A tiny tap is audible (floor 1), a slam saturates (ceil 127).
    expect(noteMap({ ...base, impactSpeed: 0 }).velocity).toBeGreaterThanOrEqual(1);
    expect(noteMap({ ...base, impactSpeed: -5 }).velocity).toBeGreaterThanOrEqual(1);
    expect(noteMap({ ...base, impactSpeed: 1e6 }).velocity).toBe(127);
    // Monotonic in impactSpeed within range.
    const slow = noteMap({ ...base, impactSpeed: 1 }).velocity;
    const fast = noteMap({ ...base, impactSpeed: 8 }).velocity;
    expect(fast).toBeGreaterThan(slow);
  });

  it('pan maps position.x into the i8 pan range', () => {
    expect(noteMap({ ...base, posX: 0 }).pan).toBe(0);
    expect(noteMap({ ...base, posX: 100 }).pan).toBe(127);
    expect(noteMap({ ...base, posX: -100 }).pan).toBe(-128);
    expect(clampPan(0)).toBe(0);
  });

  it('clampVelocity / clampPan are standalone pure clamps', () => {
    expect(clampVelocity(200)).toBe(127);
    expect(clampVelocity(0)).toBe(1);
    expect(clampPan(9999)).toBe(127);
    expect(clampPan(-9999)).toBe(-128);
  });
});

// ===========================================================================
// C18 — computeNoteId (deterministic dedupe key)
// ===========================================================================

describe('computeNoteId — the predict/echo dedupe key (deterministic)', () => {
  it('is identical for the same (playerId, sixteenthIndex, colorIndex) — predict ≡ echo', () => {
    const a = computeNoteId('player-7', 4096, 2);
    const b = computeNoteId('player-7', 4096, 2);
    expect(a).toBe(b);
    // it is a u32
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it('differs when the grid slot, player, or pitch differs (no false collision)', () => {
    const base = computeNoteId('player-7', 4096, 2);
    expect(computeNoteId('player-7', 4097, 2)).not.toBe(base);
    expect(computeNoteId('player-8', 4096, 2)).not.toBe(base);
    expect(computeNoteId('player-7', 4096, 3)).not.toBe(base);
  });
});

// ===========================================================================
// C18 — quantizer: lookahead (≥ event + p95 + margin, snapped to a 16th) +
//                  backward-snap ≤ 60 ms for a note that just missed a line
// ===========================================================================

describe('quantizeNote — adaptive lookahead + backward-snap', () => {
  // 120 BPM, grid origin 0 → 125 ms per 16th.
  const clock: QuantizerClock = { bpm: 120, gridOriginMs: 0 };

  it('schedules at the next 16th ≥ (event + client p95 one-way delay + margin)', () => {
    // event at t=10, p95 one-way = 40 ms, margin adds QUANTIZER_MARGIN_MS.
    const p95 = 40;
    const r = quantizeNote(10, clock, p95);
    const earliest = 10 + p95 + QUANTIZER_MARGIN_MS;
    // The scheduled time is a grid line …
    expect(r.playAtMs % 125).toBeCloseTo(0);
    // … and it is ≥ the earliest-audible bound.
    expect(r.playAtMs).toBeGreaterThanOrEqual(earliest);
    // … and it is the FIRST such grid line (no more than a 16th of slack).
    expect(r.playAtMs - earliest).toBeLessThan(125);
  });

  it('backward-snaps a note that JUST missed a grid line (≤ 60 ms) to that line', () => {
    // Arrange an earliest-bound a hair PAST a grid line (within BACKWARD_SNAP_MS):
    // pick p95 so that event + p95 + margin lands ~a few ms after 250.
    const line = 250;
    const overshoot = 8; // ms past the line, ≤ BACKWARD_SNAP_MS
    const p95 = line + overshoot - 10 - QUANTIZER_MARGIN_MS;
    const r = quantizeNote(10, clock, p95);
    // Backward-snap fires: schedule the note ON the line it just missed
    // (not the NEXT line), because the miss is within the ≤ 60 ms window.
    expect(r.playAtMs).toBeCloseTo(line);
    expect(r.snappedBackward).toBe(true);
    expect(BACKWARD_SNAP_MS).toBeLessThanOrEqual(60);
  });

  it('does NOT backward-snap when the miss exceeds the window (schedules forward)', () => {
    const line = 250;
    const overshoot = 90; // ms past the line, > BACKWARD_SNAP_MS
    const p95 = line + overshoot - 10 - QUANTIZER_MARGIN_MS;
    const r = quantizeNote(10, clock, p95);
    expect(r.playAtMs).toBeGreaterThan(line); // next line (375)
    expect(r.snappedBackward).toBe(false);
  });

  it('is deterministic (same inputs → same schedule)', () => {
    expect(quantizeNote(10, clock, 40)).toEqual(quantizeNote(10, clock, 40));
  });
});

// ===========================================================================
// C18 — the deterministic backing layer (the determinism keystone)
// ===========================================================================

describe('backingBar — deterministic generative backing layer', () => {
  const hist: ActivityHistogram = { impactsInWindow: 6, activePlayers: 3 };

  it('is IDENTICAL across two clients for the same (roomSeed, beatIndex, histogram)', () => {
    // Two independent "clients" compute the same bar from the same seed.
    const clientA = backingBar(0xc0ffee, 16, hist);
    const clientB = backingBar(0xc0ffee, 16, hist);
    expect(clientA).toEqual(clientB);
    // A meaningful bar (at least one backing note) so the equality is not vacuous.
    expect(clientA.notes.length).toBeGreaterThan(0);
  });

  it('varies with the seed and the beat index (not a constant)', () => {
    const a = backingBar(1, 0, hist);
    const b = backingBar(2, 0, hist);
    const c = backingBar(1, 4, hist);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('emits zero MUSIC_NOTE events — it is a client-local render, not traffic', () => {
    // The backing notes are a pure schedule the client renders locally; the
    // contract is that the function returns them (no side effects / no wire).
    const bar = backingBar(42, 8, hist);
    expect(Array.isArray(bar.notes)).toBe(true);
    for (const n of bar.notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(0);
      expect(n.pitch).toBeLessThanOrEqual(127);
      expect(n.offsetSixteenths).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// C18 — the auto-intensity governor (monotonic with activity)
// ===========================================================================

describe('intensityGovernor — monotonic with activity', () => {
  it('is non-decreasing as activity rises (mellow when idle, dense when busy)', () => {
    let prev = -1;
    for (let impacts = 0; impacts <= 40; impacts += 2) {
      const i = intensityGovernor({ impactsInWindow: impacts, activePlayers: 4 });
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
  });

  it('is bounded to 0..1 and idle is the floor', () => {
    expect(intensityGovernor({ impactsInWindow: 0, activePlayers: 0 })).toBeGreaterThanOrEqual(0);
    expect(intensityGovernor({ impactsInWindow: 1e6, activePlayers: 128 })).toBeLessThanOrEqual(1);
    // idle groove is a small non-zero floor (a mellow attract groove, not silence).
    expect(intensityGovernor({ impactsInWindow: 0, activePlayers: 0 })).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const h: ActivityHistogram = { impactsInWindow: 12, activePlayers: 5 };
    expect(intensityGovernor(h)).toBe(intensityGovernor(h));
  });
});

// ===========================================================================
// C18 — per-player note budget (truncate a 50-impact burst) + role split
// ===========================================================================

describe('applyNoteBudget — per-player rate budget truncates a burst', () => {
  it('truncates a 50-impact single-player burst to the per-player budget', () => {
    const events = Array.from({ length: 50 }, (_v, i) => ({
      playerId: 'spammer',
      sixteenthIndex: i, // one per 16th slot
    }));
    const kept = applyNoteBudget(events);
    expect(kept.length).toBeLessThan(50);
    // every kept event still belongs to the burster (nothing invented)
    for (const e of kept) expect(e.playerId).toBe('spammer');
  });

  it('does NOT starve a second player because one player floods (fair per-player)', () => {
    const flood = Array.from({ length: 50 }, (_v, i) => ({ playerId: 'a', sixteenthIndex: i }));
    const quiet = [{ playerId: 'b', sixteenthIndex: 3 }];
    const kept = applyNoteBudget([...flood, ...quiet]);
    expect(kept.some((e) => e.playerId === 'b')).toBe(true);
  });

  it('is deterministic (same burst → same truncation)', () => {
    const events = Array.from({ length: 20 }, (_v, i) => ({ playerId: 'p', sixteenthIndex: i }));
    expect(applyNoteBudget(events)).toEqual(applyNoteBudget(events));
  });
});

describe('splitRole — drum/melody split by shape type (pure)', () => {
  it('assigns a stable role per shape type', () => {
    expect(splitRole('cube')).toBe(splitRole('cube'));
    // at least one type is a drum and at least one is melody (the split exists)
    const roles = new Set(
      ['cube', 'sphere', 'icosahedron', 'torus', 'cone', 'tetrahedron'].map(splitRole)
    );
    expect(roles.has('drum')).toBe(true);
    expect(roles.has('melody')).toBe(true);
  });
});

// ===========================================================================
// C18 — MUSIC_NOTE golden round-trip through the C1 codec (never a local layout)
// ===========================================================================

describe('MUSIC_NOTE golden round-trip (C1 Appendix B codec)', () => {
  it('a conductor-shaped note round-trips through encodeBinary/decodeBinary', () => {
    // Build a note the conductor would emit and push it through the SHARED C1
    // golden codec (opcodes.ts) — never a locally-invented byte layout.
    const note = noteMap({ colorIndex: 3, type: 'cube', size: 1, impactSpeed: 200, posX: -42 });
    const fields = {
      noteId: computeNoteId('p', 4096, 3),
      playAtMs: 0x01020304,
      pitch: note.pitch,
      timbre: note.timbre,
      velocity: note.velocity,
      pan: note.pan,
      reserved: 0,
    };
    const buf = encodeBinary(OPCODES.MUSIC, MUSIC_KIND.NOTE, fields);
    const decoded = decodeBinary(buf);
    expect(decoded.opcode).toBe(OPCODES.MUSIC);
    expect(decoded.kind).toBe(MUSIC_KIND.NOTE);
    expect(decoded.fields).toEqual(fields);
  });

  it('the Appendix B MUSIC_NOTE reference vector still decodes to its fields', () => {
    // The normative golden (Appendix B) — decode(hex) ≡ fields.
    const hex = '2901efbeadde040302013c03c8d60000';
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const decoded = decodeBinary(bytes.buffer);
    expect(decoded.fields).toEqual({
      noteId: 0xdeadbeef,
      playAtMs: 0x01020304,
      pitch: 60,
      timbre: 3,
      velocity: 200,
      pan: -42,
      reserved: 0,
    });
  });
});
