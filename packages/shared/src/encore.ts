// ---------------------------------------------------------------------------
// encore.ts — F12 Supernova Encore PURE core (spec §5.3 / §7.13, plan C19).
//
// The crowd charges a supernova; at 100 % a pinned orb spawns; its first impact
// (or a 10 s auto-launch) fires a drop timeline at a clock-synced `fireAtServerTime`
// so a SINGLE white flash lands on every phone in the same instant (C3 scheduleAt,
// late = fireNow). This module is 100 % PURE (no Date/Math.random/three/DOM/timer):
//   • crowdNormalizedCharge  — 5 phones vs 30 reach a comparable charge (§5.3).
//   • ChargeDebounce         — ≤ 5 taps/s per phone (§5.1 crowd cell).
//   • seededArp              — the deterministic drop arpeggio (primary audio).
//   • crowdCueFrame / chargeStateFrame — the Appendix B wire builders (C1 codec).
//   • ambientCuePhase        — seeded per-phone phase offsets for the light rig.
//   • ENCORE_* constants     — the timeline windows the host + tests share.
//
// The wire builders route through the C1 golden codec ONLY (never a local layout).
// The HOST (packages/server/src/encore.ts) drives these with an injected TimerApi /
// C3 scheduleAt; the CLIENT light rig + stage constellation reuse the pure helpers
// (F12 is Tier ≤5 §7.13 — freely shared; no Tier 6 import-direction concern).
// ---------------------------------------------------------------------------

import { encodeBinary, OPCODES, CROWD_KIND } from './protocol/opcodes.js';

// ---------------------------------------------------------------------------
// Timeline constants (ms) — the host + tests read these by name (never magic).
// ---------------------------------------------------------------------------

/** The full encore sequence self-terminates by this cap (spec §7.13: ≤ 90 s). */
export const ENCORE_MAX_MS = 90_000;
/** The pinned orb auto-launches if unthrown after this long (spec §7.13: 10 s). */
export const ORB_AUTOLAUNCH_MS = 10_000;
/** The synchronized-flash lead: fireAt = now + this (spec §7.13: 500 ms–1 s). */
export const DROP_LEAD_MS = 700;
/** Per-phone tap debounce: ≤ 5 taps/s ⇒ one tap per 200 ms (spec §5.1 crowd cell). */
export const CHARGE_MIN_TAP_INTERVAL_MS = 200;
/** Cooldown before the encore can re-fire (spec §7.13). */
export const ENCORE_COOLDOWN_MS = 60_000;
/** The single-flash comfort cap: at MOST one flash per this window (≤ 3 Hz, §6.3). */
export const FLASH_MIN_INTERVAL_MS = 334; // 3 Hz ⇒ ≥ 1/3 s between flashes.

/** The wire `charge` unit: 0–200 maps to 0–100.0 % (Appendix B CHARGE_STATE). */
export const CHARGE_WIRE_MAX = 200;

// ---------------------------------------------------------------------------
// crowdNormalizedCharge — crowd-size normalization (§5.3: 5 vs 30 comparable)
// ---------------------------------------------------------------------------

/**
 * The number of taps ONE fully-participating phone would contribute over the
 * charge window — the normalization divisor's per-phone quota. A small crowd of 5
 * enthusiastic tappers and a big crowd of 30 casual tappers reach a COMPARABLE
 * normalized charge because the divisor scales with the live crowd size.
 */
export const TAPS_PER_PHONE_TO_FULL = 12;

/**
 * Normalize a raw tap total to a 0..1 charge fraction, divided by the CROWD SIZE
 * (spec §5.3 — "server-normalized by crowd size" so 5 phones and 30 reach a
 * comparable charge). The divisor is `crowdSize × TAPS_PER_PHONE_TO_FULL`, clamped
 * to a floor of one phone so a solo tester can still charge (and staff-fire covers
 * the empty-crowd rung). Result is clamped to [0, 1].
 *
 * Determinism: pure integer/float math, no Date/RNG. Given the same (taps,
 * crowdSize) it always returns the same fraction — the property the "5 vs 30
 * comparable" test asserts.
 */
export function crowdNormalizedCharge(taps: number, crowdSize: number): number {
  const phones = Math.max(1, Math.floor(crowdSize));
  const needed = phones * TAPS_PER_PHONE_TO_FULL;
  const frac = taps / needed;
  if (!Number.isFinite(frac) || frac < 0) return 0;
  return frac > 1 ? 1 : frac;
}

/** Convert a 0..1 charge fraction to the Appendix B wire `charge` u8 (0–200). */
export function chargeToWire(frac: number): number {
  const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return Math.round(clamped * CHARGE_WIRE_MAX);
}

/** True iff the normalized charge has reached 100 % (the orb-spawn trigger). */
export function isFullyCharged(frac: number): boolean {
  return frac >= 1;
}

// ---------------------------------------------------------------------------
// ChargeDebounce — per-phone ≤ 5 taps/s (spec §5.1 crowd cell)
// ---------------------------------------------------------------------------

/**
 * A pure per-phone tap debouncer. `accept(peerId, nowMs)` returns true iff this
 * tap is at least CHARGE_MIN_TAP_INTERVAL_MS after the phone's previous ACCEPTED
 * tap (⇒ ≤ 5 accepted taps/s). Rejected taps do NOT reset the clock (a flood
 * cannot starve a slow tapper — the window is per-phone). No timers; the caller
 * passes the injected clock's `now`.
 */
export interface ChargeDebounce {
  /** Accept-or-reject this phone's tap at `nowMs`. */
  accept(peerId: string, nowMs: number): boolean;
  /** Forget a phone (on disconnect). */
  forget(peerId: string): void;
  /** Reset all state (on encore end / RESET). */
  reset(): void;
}

export function createChargeDebounce(
  minIntervalMs: number = CHARGE_MIN_TAP_INTERVAL_MS
): ChargeDebounce {
  const last = new Map<string, number>();
  return {
    accept(peerId: string, nowMs: number): boolean {
      const prev = last.get(peerId);
      if (prev !== undefined && nowMs - prev < minIntervalMs) return false;
      last.set(peerId, nowMs);
      return true;
    },
    forget(peerId: string): void {
      last.delete(peerId);
    },
    reset(): void {
      last.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// seededArp — the deterministic drop arpeggio (primary drop audio, §7.13)
// ---------------------------------------------------------------------------

/** mulberry32 — the shared seeded PRNG (matches physicsCore / callsigns). */
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

/** One arp step: a MIDI note + the ms offset from the drop start it plays at. */
export interface ArpStep {
  /** MIDI note number (0–127). */
  midi: number;
  /** ms after `fireAtServerTime` this step sounds. */
  offsetMs: number;
}

/**
 * A minor-pentatonic degree set (semitone offsets) — the synthwave arp scale,
 * matching the F8 Resonora minor-pentatonic palette so the encore stays on-key
 * even with NO melody-source hook wired (cut-safety — the arp is the primary
 * drop audio; §7.13). Root A2 = MIDI 45.
 */
const PENTATONIC = [0, 3, 5, 7, 10] as const;
const ARP_ROOT_MIDI = 45;
/** The number of ascending arp steps in the drop (a short rising run). */
export const ARP_STEPS = 8;
/** Milliseconds between successive arp steps (a fast rising 16th-ish run). */
export const ARP_STEP_MS = 90;

/**
 * The deterministic seeded drop arpeggio — a rising minor-pentatonic run whose
 * octave jumps + degree walk are driven ONLY by the seed (mulberry32). IDENTICAL
 * for the same seed on every client (the "seeded arp deterministic" test asserts
 * this); varies with the seed. Pure — no Date/Math.random. This is the PRIMARY
 * drop audio (the melody-replay hook is optional garnish layered ON TOP, §7.13).
 */
export function seededArp(seed: number, steps: number = ARP_STEPS): ArpStep[] {
  const rng = mulberry32(seed);
  const out: ArpStep[] = [];
  for (let i = 0; i < steps; i++) {
    // Walk up the scale; the seed picks each step's degree + occasional octave.
    const degree = PENTATONIC[Math.floor(rng() * PENTATONIC.length) % PENTATONIC.length];
    const octave = Math.floor(i / PENTATONIC.length) + (rng() < 0.35 ? 1 : 0);
    const midi = ARP_ROOT_MIDI + degree + octave * 12 + i; // +i ⇒ a rising contour
    out.push({ midi: Math.min(127, midi), offsetMs: i * ARP_STEP_MS });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ambientCuePhase — seeded per-phone phase offsets for the light rig (§7.13)
// ---------------------------------------------------------------------------

/**
 * A deterministic per-phone phase offset (0..1) so the ambient CROWD_CUE light
 * rig RIPPLES across the crowd instead of pulsing in lockstep (spec §7.13 —
 * "per-phone seed phase offsets ripple the crowd"). Folds the cue seed with a
 * per-phone hash; pure + deterministic (the same seed+peer ⇒ the same offset).
 */
export function ambientCuePhase(seed: number, peerId: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < peerId.length; i++) h = (Math.imul(h, 31) + peerId.charCodeAt(i)) >>> 0;
  // mulberry32 one-shot on the folded hash → a stable 0..1 offset.
  return mulberry32(h)();
}

// ---------------------------------------------------------------------------
// Wire builders — Appendix B CROWD_CUE / CHARGE_STATE via the C1 golden codec
// ---------------------------------------------------------------------------

/** The ambient/fallback CROWD_CUE effect ids (u8 `effect` field). */
export const CROWD_CUE_EFFECT = {
  /** Ambient light-rig pulse (the charge-window rig). */
  AMBIENT_PULSE: 0,
  /** The room-wide palette FLASH (the no-sibling fallback climax visual, §7.13). */
  PALETTE_FLASH: 1,
  /** The max-brightness PROMPT (join + CHARGE_START — "turn brightness up"). */
  BRIGHTNESS_PROMPT: 2,
} as const;

/** The fields a CROWD_CUE frame carries (mirrors the Appendix B row). */
export interface CrowdCueFields {
  effect: number;
  colorIndex: number;
  intensity: number;
  durationMs: number;
  seed: number;
  /** roomEpoch-relative fire time (0 = immediate). */
  fireAtMs: number;
}

/**
 * Build a CROWD_CUE (0x2A/CUE) binary frame via the C1 golden codec (Appendix B).
 * `reserved` is fixed 0. NEVER hand-assembles bytes — the codec is the single
 * source of the layout (the golden round-trip test asserts byte equality).
 */
export function crowdCueFrame(f: CrowdCueFields): ArrayBuffer {
  return encodeBinary(OPCODES.CROWD_CUE, CROWD_KIND.CUE, {
    effect: f.effect,
    colorIndex: f.colorIndex,
    intensity: f.intensity,
    durationMs: f.durationMs,
    seed: f.seed >>> 0,
    fireAtMs: f.fireAtMs >>> 0,
    reserved: 0,
  });
}

/** The fields a CHARGE_STATE frame carries (mirrors the Appendix B row). */
export interface ChargeStateFields {
  /** 0–200 = 0–100.0 % (the wire unit; use {@link chargeToWire}). */
  charge: number;
  crowdSize: number;
  /** roomEpoch-relative drop schedule once armed (0 until armed). */
  fireAtMs: number;
}

/**
 * Build a CHARGE_STATE (0x2A/CHARGE) binary frame via the C1 golden codec. The
 * coalesced 2–5 Hz charge summary the crowd meter + stage bar read. `reserved` 0.
 */
export function chargeStateFrame(f: ChargeStateFields): ArrayBuffer {
  return encodeBinary(OPCODES.CROWD_CUE, CROWD_KIND.CHARGE, {
    charge: Math.max(0, Math.min(CHARGE_WIRE_MAX, Math.round(f.charge))),
    crowdSize: Math.max(0, Math.min(255, Math.floor(f.crowdSize))),
    fireAtMs: (f.fireAtMs >>> 0) as number,
    reserved: 0,
  });
}
