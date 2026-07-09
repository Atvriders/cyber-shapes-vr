/**
 * caster.test.ts — F15 MC NULL pure grammar (C26, spec §7.15). The Step-1 RED
 * spec for the PURE `casterGrammar.ts`: SILENCE by default, ≥3 variants per event
 * kind, the phase hype ladder, per-line character budget, self-contained callsign
 * slots (render WITHOUT a roster), label↔signal truth, the indices-only wire
 * round-trip, and determinism. The stateful host (LRU/quota/rotation-scoping/
 * single-authority/audience-attach) is covered in `packages/server/test/caster.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  CASTER_TEMPLATES,
  casterTemplate,
  casterLine,
  intensityForPhase,
  isSignificant,
  isEncodableCallsign,
  parseCallsign,
  renderCallsign,
  renderCasterLine,
  renderCasterWire,
  withinCasterBudget,
  casterSlotsToWire,
  wireToCasterSlots,
  CASTER_SCORER_CFG,
  CASTER_STREAK_MIN,
  DEFAULT_HIGHLIGHT_SCORER_CFG,
  encodeBinary,
  decodeBinary,
  OPCODES,
  SINGLE_KIND,
  type CasterEvent,
  type CasterEventKind,
  type CasterSlot,
  type Phase,
} from '../src/index.js';

/** A tiny deterministic RNG (mulberry32) so variant selection is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOLT17 = { wordIndex: 0, suffix: 17 } as const; // "VOLT-17"

// ---------------------------------------------------------------------------
// SILENCE is the default.
// ---------------------------------------------------------------------------

describe('caster — SILENCE by default', () => {
  it('a soft throw below the shared activity floor is SILENCE (null)', () => {
    const e: CasterEvent = { kind: 'throw', who: VOLT17, releaseVel: 2 };
    expect(casterLine(e, { phase: 'PLAY' }, mulberry32(1))).toBeNull();
  });

  it('a quiet impact below the floor is SILENCE', () => {
    const e: CasterEvent = { kind: 'impact', who: VOLT17, impactSpeed: 1 };
    expect(casterLine(e, { phase: 'PLAY' }, mulberry32(1))).toBeNull();
  });

  it('a sub-milestone streak is SILENCE', () => {
    const e: CasterEvent = { kind: 'streak', who: VOLT17, streakCount: CASTER_STREAK_MIN - 1 };
    expect(casterLine(e, { phase: 'PLAY' }, mulberry32(1))).toBeNull();
  });

  it('a "record" with a non-positive recordSpeed is SILENCE (superlative only on a real record)', () => {
    expect(isSignificant({ kind: 'record', who: VOLT17, recordSpeed: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ≥3 variants per event kind.
// ---------------------------------------------------------------------------

describe('caster — variety', () => {
  it('every event kind has ≥ 3 template variants', () => {
    const byKind = new Map<CasterEventKind, number>();
    for (const t of CASTER_TEMPLATES) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
    for (const [kind, n] of byKind) expect(n, `kind ${kind}`).toBeGreaterThanOrEqual(3);
  });

  it('template ids are their positional index (stable, never reordered)', () => {
    CASTER_TEMPLATES.forEach((t, i) => expect(t.id).toBe(i));
  });
});

// ---------------------------------------------------------------------------
// The phase hype ladder.
// ---------------------------------------------------------------------------

describe('caster — phase hype ladder', () => {
  it('maps phases to calm / normal / hype', () => {
    expect(intensityForPhase('LOBBY')).toBe('calm');
    expect(intensityForPhase('PLAY')).toBe('normal');
    expect(intensityForPhase('OVERLOAD')).toBe('hype');
    expect(intensityForPhase('FINALE')).toBe('hype');
    expect(intensityForPhase('STATS')).toBe('calm');
  });

  it('selects a calm variant in LOBBY, a hype variant in FINALE, for the same throw', () => {
    const e: CasterEvent = { kind: 'throw', who: VOLT17, releaseVel: 18 };
    const calm = casterLine(e, { phase: 'LOBBY' }, mulberry32(7));
    const hype = casterLine(e, { phase: 'FINALE' }, mulberry32(7));
    expect(calm).not.toBeNull();
    expect(hype).not.toBeNull();
    expect(casterTemplate(calm!.templateId)!.intensity).toBe('calm');
    expect(casterTemplate(hype!.templateId)!.intensity).toBe('hype');
  });

  it('the ladder does NOT change the significance gate (a soft throw is silent in every phase)', () => {
    const phases: Phase[] = ['LOBBY', 'PLAY', 'OVERLOAD', 'FINALE'];
    for (const phase of phases) {
      expect(casterLine({ kind: 'throw', who: VOLT17, releaseVel: 1 }, { phase }, mulberry32(3))).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

describe('caster — determinism', () => {
  it('the same event + phase + seed yields the same line', () => {
    const e: CasterEvent = { kind: 'throw', who: VOLT17, releaseVel: 18 };
    const a = casterLine(e, { phase: 'PLAY' }, mulberry32(42));
    const b = casterLine(e, { phase: 'PLAY' }, mulberry32(42));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// No-repeat (via avoidTemplateIds — the host's ~3-min LRU).
// ---------------------------------------------------------------------------

describe('caster — no-repeat via avoidTemplateIds', () => {
  it('never picks a template in the avoid set', () => {
    const e: CasterEvent = { kind: 'join', who: VOLT17 };
    // Run many seeds; every pick must avoid a chosen id.
    const first = casterLine(e, { phase: 'PLAY' }, mulberry32(1))!;
    const next = casterLine(
      e,
      { phase: 'PLAY', avoidTemplateIds: new Set([first.templateId]) },
      mulberry32(1)
    );
    if (next) expect(next.templateId).not.toBe(first.templateId);
  });

  it('avoiding EVERY variant of the phase intensity yields SILENCE (no repeat)', () => {
    const e: CasterEvent = { kind: 'join', who: VOLT17 };
    const all = new Set(CASTER_TEMPLATES.filter((t) => t.kind === 'join').map((t) => t.id));
    expect(casterLine(e, { phase: 'PLAY', avoidTemplateIds: all }, mulberry32(9))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Character budget — every template, ≤ 2 lines, ≤ budget chars.
// ---------------------------------------------------------------------------

describe('caster — 5-metre character budget', () => {
  it('every template renders within the per-line budget and ≤ 2 lines', () => {
    // Representative worst case: a long callsign (7-char word + 3-digit suffix)
    // and a large 1-decimal number.
    const long = { wordIndex: 69, suffix: 199 }; // "GRIFFIN-199"
    for (const t of CASTER_TEMPLATES) {
      const slots: CasterSlot[] = t.slots.map((s) =>
        s.type === 'callsign' ? { kind: 'callsign', who: long } : { kind: 'num', value: 199.9 }
      );
      const text = renderCasterLine(t.id, slots);
      expect(text, `template ${t.id} (${t.kind}/${t.intensity})`).not.toBeNull();
      expect(withinCasterBudget(text!), `template ${t.id}: "${text}"`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Label↔signal truth.
// ---------------------------------------------------------------------------

describe('caster — label↔signal truth', () => {
  const EXPECTED: Record<string, string> = {
    throw: 'releaseVel',
    impact: 'impactSpeed',
    streak: 'streakCount',
    record: 'recordSpeed',
    shapeRain: 'spawnCount',
    endCard: 'catches',
  };

  it('every numeric slot binds the signal named for its kind', () => {
    for (const t of CASTER_TEMPLATES) {
      for (const s of t.slots) {
        if (s.type === 'num') {
          const want = EXPECTED[t.kind];
          expect(want, `kind ${t.kind} has a numeric slot but no expected signal`).toBeDefined();
          expect(s.signal, `template ${t.id} (${t.kind}) numeric slot`).toBe(want);
        }
      }
    }
  });

  it('a throw line binds release velocity; an impact line binds impact speed', () => {
    const throwLine = casterLine({ kind: 'throw', who: VOLT17, releaseVel: 18.4 }, { phase: 'PLAY' }, mulberry32(5))!;
    const num = throwLine.slots.find((s) => s.kind === 'num') as { kind: 'num'; value: number };
    expect(num.value).toBe(18.4);
    const impactLine = casterLine({ kind: 'impact', who: VOLT17, impactSpeed: 14.2 }, { phase: 'PLAY' }, mulberry32(5))!;
    const inum = impactLine.slots.find((s) => s.kind === 'num') as { kind: 'num'; value: number };
    expect(inum.value).toBe(14.2);
  });
});

// ---------------------------------------------------------------------------
// Self-contained callsign slots — render WITHOUT a roster.
// ---------------------------------------------------------------------------

describe('caster — self-contained callsign slots', () => {
  it('renders "VOLT-17" from (wordIndex, suffix) with no roster', () => {
    expect(renderCallsign(VOLT17)).toBe('VOLT-17');
  });

  it('a rendered throw line contains the callsign text (attribution, never a raw string on the wire)', () => {
    const line = casterLine({ kind: 'throw', who: VOLT17, releaseVel: 18 }, { phase: 'PLAY' }, mulberry32(2))!;
    const text = renderCasterLine(line.templateId, line.slots)!;
    expect(text).toContain('VOLT-17');
    // The wire slots carry ONLY indices/numbers — never the string.
    for (const s of line.slots) {
      if (s.kind === 'callsign') {
        expect(typeof s.who.wordIndex).toBe('number');
        expect(typeof s.who.suffix).toBe('number');
      }
    }
  });

  it('parseCallsign is lossless-or-null', () => {
    expect(parseCallsign('VOLT-17')).toEqual({ wordIndex: 0, suffix: 17 });
    expect(parseCallsign('VOLT-042')).toBeNull(); // leading-zero 3-digit not reproducible
    expect(parseCallsign('VOLT-300')).toBeNull(); // suffix past u8
    expect(parseCallsign('NOTAWORD-12')).toBeNull(); // unknown word
    expect(parseCallsign('DMN-01')).toBeNull(); // synthetic-peer prefix (not a curated word)
  });

  it('isEncodableCallsign guards the u8-suffix / valid-index invariant', () => {
    expect(isEncodableCallsign({ wordIndex: 0, suffix: 17 })).toBe(true);
    expect(isEncodableCallsign({ wordIndex: 0, suffix: 300 })).toBe(false);
    expect(isEncodableCallsign({ wordIndex: 9999, suffix: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The indices-only wire round-trip.
// ---------------------------------------------------------------------------

describe('caster — CASTER_LINE wire round-trip (indices/fixed-point ONLY)', () => {
  it('slots → flat wire → slots is lossless for callsign + fixed-point number', () => {
    const slots: CasterSlot[] = [
      { kind: 'callsign', who: { wordIndex: 5, suffix: 200 } },
      { kind: 'num', value: -18.4 },
    ];
    const flat = casterSlotsToWire(slots);
    expect(flat).toEqual([1, 5, 200, 0, -184, 0]); // tag,a,b triples — no strings
    const back = wireToCasterSlots(flat);
    expect(back[0]).toEqual({ kind: 'callsign', who: { wordIndex: 5, suffix: 200 } });
    expect((back[1] as { value: number }).value).toBeCloseTo(-18.4, 6);
  });

  it('encodeBinary/decodeBinary round-trips a CASTER_LINE frame through the C1 codec', () => {
    const slots: CasterSlot[] = [
      { kind: 'callsign', who: VOLT17 },
      { kind: 'num', value: 22 },
    ];
    const fields = { templateId: 12, slots: casterSlotsToWire(slots) };
    const buf = encodeBinary(OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, fields);
    const dec = decodeBinary(buf);
    expect(dec.opcode).toBe(OPCODES.CASTER_LINE);
    expect(dec.fields).toEqual(fields);
    // The client renders the SAME text from the decoded wire — no roster.
    const text = renderCasterWire(dec.fields.templateId as number, dec.fields.slots as number[]);
    expect(text).toContain('VOLT-17');
  });

  it('an empty-slot frame (arm) round-trips', () => {
    const fields = { templateId: 24, slots: [] as number[] };
    const buf = encodeBinary(OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, fields);
    expect(decodeBinary(buf).fields).toEqual(fields);
  });
});

// ---------------------------------------------------------------------------
// Shared thresholds — caster and the C21 scorer agree on what counts.
// ---------------------------------------------------------------------------

describe('caster — shared significance thresholds (reuse, never reimplement)', () => {
  it('reads the SAME scorer defaults object the highlight scorer uses', () => {
    expect(CASTER_SCORER_CFG).toBe(DEFAULT_HIGHLIGHT_SCORER_CFG);
    expect(CASTER_SCORER_CFG.minActivitySpeed).toBe(DEFAULT_HIGHLIGHT_SCORER_CFG.minActivitySpeed);
  });
});
