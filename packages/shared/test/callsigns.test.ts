import { describe, expect, it } from 'vitest';
import {
  CURATED_WORDLIST,
  DMN_PREFIX,
  WORLD_RADIUS,
  CALLSIGN_RE,
  generateCallsign,
  daemonCallsign,
  isDaemonCallsign,
} from '../src/callsigns.js';

// A tiny deterministic PRNG (mulberry32) so tests are reproducible and never
// depend on Math.random. generateCallsign takes an injected `() => number`.
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

// A denylist used to prove the curated wordlist was screened. This is NOT the
// authoritative screen (that lives in the source's construction) — it is an
// independent tripwire: if a slur/profanity substring ever creeps into the
// list, this test fails. Kept intentionally small + substring-based.
const DENYLIST = [
  'ASS',
  'SEX',
  'FUK',
  'FUC',
  'CUM',
  'NAZI',
  'RAPE',
  'KILL',
  'DIE',
  'SHIT',
  'PISS',
  'COCK',
  'DICK',
  'TIT',
  'FAG',
  'CUNT',
  'SLUT',
  'WHORE',
  'NIG',
  'JEW',
  'HELL',
  'DAMN',
  'ANAL',
  'ANUS',
];

describe('CURATED_WORDLIST', () => {
  it('has at least 64 words', () => {
    expect(CURATED_WORDLIST.length).toBeGreaterThanOrEqual(64);
  });

  it('words are all-uppercase A–Z, 3–10 chars (matches the callsign word slot)', () => {
    for (const w of CURATED_WORDLIST) {
      expect(w).toMatch(/^[A-Z]{3,10}$/);
    }
  });

  it('has no duplicate words', () => {
    expect(new Set(CURATED_WORDLIST).size).toBe(CURATED_WORDLIST.length);
  });

  it('is denylist-screened (no profanity/slur substrings)', () => {
    for (const w of CURATED_WORDLIST) {
      for (const bad of DENYLIST) {
        expect(w.includes(bad)).toBe(false);
      }
    }
  });

  it('never begins with the DMN- synthetic-peer prefix word', () => {
    // DMN- is reserved for synthetic peers; no curated word may equal DMN.
    for (const w of CURATED_WORDLIST) {
      expect(w).not.toBe('DMN');
    }
  });
});

describe('DMN- namespace reservation (spec §7.17, C28)', () => {
  it('daemonCallsign builds a well-formed DMN- callsign (matches the frozen format)', () => {
    expect(daemonCallsign(7)).toBe('DMN-07');
    expect(daemonCallsign(3)).toBe('DMN-03');
    expect(daemonCallsign(0)).toBe('DMN-00');
    expect(daemonCallsign(150)).toBe('DMN-150');
    for (let i = 0; i < 300; i++) {
      expect(daemonCallsign(i)).toMatch(CALLSIGN_RE);
      expect(isDaemonCallsign(daemonCallsign(i))).toBe(true);
    }
  });

  it('the DMN- namespace is DISJOINT from the human wordlist — no human is ever a daemon', () => {
    const rng = mulberry32(2024);
    const taken = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const cs = generateCallsign(rng, taken);
      expect(isDaemonCallsign(cs)).toBe(false); // a human is NEVER DMN-
      taken.add(cs);
    }
    // …and every daemon callsign IS reserved (the mirror image of the disjointness).
    for (let i = 0; i < 300; i++) {
      expect(taken.has(daemonCallsign(i))).toBe(false); // never collides with a human
    }
  });

  it('isDaemonCallsign is false for a curated human word', () => {
    expect(isDaemonCallsign('VOLT-17')).toBe(false);
    expect(isDaemonCallsign('DMN-01')).toBe(true);
  });
});

describe('constants', () => {
  it('WORLD_RADIUS is 20', () => {
    expect(WORLD_RADIUS).toBe(20);
  });
  it('DMN_PREFIX is "DMN-"', () => {
    expect(DMN_PREFIX).toBe('DMN-');
  });
  it('CALLSIGN_RE is the frozen format /^[A-Z]{3,10}-\\d{2,3}$/', () => {
    expect(CALLSIGN_RE.source).toBe('^[A-Z]{3,10}-\\d{2,3}$');
  });
});

describe('generateCallsign', () => {
  it('always matches /^[A-Z]{3,10}-\\d{2,3}$/', () => {
    const rng = mulberry32(1);
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const cs = generateCallsign(rng, taken);
      expect(cs).toMatch(CALLSIGN_RE);
      taken.add(cs);
    }
  });

  it('is deterministic: same rng seed + same taken set → same callsign', () => {
    const a = generateCallsign(mulberry32(42), new Set());
    const b = generateCallsign(mulberry32(42), new Set());
    expect(a).toBe(b);
  });

  it('produces 5,000 unique callsigns across sequential assignments', () => {
    const rng = mulberry32(12345);
    const taken = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const cs = generateCallsign(rng, taken);
      expect(taken.has(cs)).toBe(false); // never collides with an assigned one
      taken.add(cs);
    }
    expect(taken.size).toBe(5000);
  });

  it('never emits a DMN- callsign for humans (reserved namespace)', () => {
    const rng = mulberry32(777);
    const taken = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const cs = generateCallsign(rng, taken);
      expect(cs.startsWith(DMN_PREFIX)).toBe(false);
      taken.add(cs);
    }
  });

  it('respects a pre-seeded taken set (never returns an already-taken value)', () => {
    const rng = mulberry32(9);
    const taken = new Set<string>();
    // Pre-fill with the first N it would otherwise pick, then confirm avoidance.
    const first = generateCallsign(rng, taken);
    taken.add(first);
    for (let i = 0; i < 200; i++) {
      const cs = generateCallsign(mulberry32(9), taken);
      expect(cs).not.toBe(first);
      expect(taken.has(cs)).toBe(false);
      taken.add(cs);
    }
  });

  it('uses a ReadonlySet without mutating it', () => {
    const rng = mulberry32(3);
    const taken: ReadonlySet<string> = new Set(['ALPHA-01']);
    const before = taken.size;
    generateCallsign(rng, taken);
    expect(taken.size).toBe(before); // generator does not add to the caller's set
  });
});
