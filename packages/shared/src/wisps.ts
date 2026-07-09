/**
 * wisps.ts — Task C14 (F4 Wisp Protocol), the PURE, deterministic shared model.
 *
 * NO Three.js, NO DOM, NO `Date.now()`, NO `Math.random()` — every function here
 * is a pure function of its inputs (the token bucket takes an injected clock).
 * This is the single authority both the SERVER (pulse validation) and the CLIENT
 * (slot placement, render budget) import, so the two can never disagree.
 *
 * Owns:
 *   • `WISP_CAP` (24, mirrors TIER_CAPS.wisp) + `WISP_SLOT_POSITIONS` — the fixed
 *     orbit-slot layout the allocator ranks.
 *   • `WISP_DRAW_CALL_BUDGET = 4` — the spec §6.5 render-ledger line (one
 *     InstancedMesh billboard + one nameplate atlas + ≤ 2 pulse-feedback objects).
 *   • `allocateSlot(occupied, headsetFrustum, stageDir)` — deterministic slot pick
 *     biased INTO the headset's view frustum and TOWARD the stage camera (§7.4).
 *   • The pulse token-bucket constants (2/s, spec §5.1) + `WispPulseBucket`.
 *   • `clampPulseMagnitude` — the server anti-cheat impulse clamp (never trust the
 *     client-sent magnitude, §7.4).
 */

import { TIER_CAPS } from './tiers.js';

/** A 3-vector (structurally identical to the shared `Vec3`; kept local to stay pure). */
export interface WispVec3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Caps + render budget (spec §5.1 / §6.5)
// ---------------------------------------------------------------------------

/** Per-room wisp cap (spec §5.1). Mirrors TIER_CAPS.wisp so the two never drift. */
export const WISP_CAP = TIER_CAPS.wisp;

/**
 * The §6.5 render-ledger line for the wisp tier: the whole tier renders in at most
 * FOUR draw calls no matter how many wisps are present —
 *   1) ONE InstancedMesh (all wisp billboards),
 *   2) ONE nameplate atlas mesh,
 *   3) the pre-allocated pulse tracer,
 *   4) the pre-allocated shockwave ring,
 * and ZERO dynamic lights. The client's structural render test asserts this.
 */
export const WISP_DRAW_CALL_BUDGET = 4;

// ---------------------------------------------------------------------------
// Orbit slot layout — the fixed set of WISP_CAP placement points (spec §7.4).
//
// Wisps ride "a server-assigned orbit slot" around the stage. The layout is a
// pair of rings in front of the headset booth (toward −Z, the stage) at two
// heights, so every slot naturally sits within a forward-facing view cone. The
// allocator ranks these by how well they sit inside the headset frustum + stage
// direction; the ring geometry guarantees at least the front slots qualify.
// ---------------------------------------------------------------------------

/** Radius of the wisp orbit rings (metres from the stage centre). */
const ORBIT_RADIUS = 6;

function buildSlotPositions(): readonly WispVec3[] {
  const out: WispVec3[] = [];
  // Two rings (heights) × 12 = 24 slots. We sweep the FRONT-facing arc first
  // (angles centred on −Z) so lower slot indices are the most in-view — this makes
  // the deterministic "first acceptable" pick also the most stage-forward.
  const perRing = WISP_CAP / 2;
  const heights = [2.2, 3.4];
  for (let ring = 0; ring < heights.length; ring++) {
    for (let i = 0; i < perRing; i++) {
      // Fan the arc symmetrically around straight-ahead (−Z): 0, +step, −step, …
      const half = Math.floor(i / 2);
      const sign = i % 2 === 0 ? 1 : -1;
      const step = Math.PI / (perRing + 1); // never a full wrap-around to the back
      const angle = -Math.PI / 2 + sign * (half + 1) * step; // centred on −Z (angle −π/2)
      out.push({
        x: Math.cos(angle) * ORBIT_RADIUS,
        y: heights[ring],
        z: Math.sin(angle) * ORBIT_RADIUS,
      });
    }
  }
  return out;
}

/** The fixed WISP_CAP-length orbit slot layout the allocator ranks. Immutable. */
export const WISP_SLOT_POSITIONS: readonly WispVec3[] = Object.freeze(
  buildSlotPositions().map((p) => Object.freeze(p))
) as readonly WispVec3[];

// ---------------------------------------------------------------------------
// allocateSlot — deterministic, frustum + stage-direction biased (spec §7.4)
// ---------------------------------------------------------------------------

/** The headset's view frustum, as a cone: origin, forward dir, and cone cos. */
export interface WispFrustum {
  pos: WispVec3;
  dir: WispVec3;
  /** cos(half-angle) of the view cone — a slot is "in frustum" when its dot ≥ this. */
  halfAngleCos: number;
}

function normalize(v: WispVec3): WispVec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: WispVec3, b: WispVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Score a free slot: HIGHER is better. The score blends two biases (spec §7.4):
 *   • how deep inside the headset's view frustum the slot sits (dot with the head
 *     forward dir — a new wisp should appear where the wearer is already looking);
 *   • how aligned the slot's placement is with the stage-camera direction (so the
 *     big-screen shot frames the wisp too).
 * Pure + deterministic — no time, no random.
 */
function slotScore(slotPos: WispVec3, headset: WispFrustum, stageDir: WispVec3): number {
  const toSlot = normalize({
    x: slotPos.x - headset.pos.x,
    y: slotPos.y - headset.pos.y,
    z: slotPos.z - headset.pos.z,
  });
  const headForward = normalize(headset.dir);
  const stage = normalize(stageDir);
  const frustumDot = dot(toSlot, headForward); // ∈ [−1, 1]
  const stageDot = dot(toSlot, stage); // alignment with the stage shot
  // Weight the frustum bias highest (the wearer wow), stage as a tiebreak.
  return frustumDot * 2 + stageDot;
}

/**
 * Pick the best FREE orbit slot for a joining wisp, biased into the headset's view
 * frustum and toward the stage camera (spec §7.4). Deterministic: the same
 * (occupied, headset, stageDir) always yields the same slot.
 *
 * @param occupied per-slot occupancy, length ≤ WISP_CAP (index = slot id).
 * @returns the chosen slot index, or `null` when every slot is taken (over-cap →
 *          the spectate/queue page).
 */
export function allocateSlot(
  occupied: readonly boolean[],
  headset: WispFrustum,
  stageDir: WispVec3
): number | null {
  let best: number | null = null;
  let bestScore = -Infinity;
  // Prefer slots INSIDE the frustum; among those, the highest score. If none are
  // in-frustum (headset looking away), fall back to the overall best score so a
  // slot is still assigned. A stable scan + strict `>` keeps ties deterministic
  // (the lowest index wins a tie — and low indices are the most stage-forward).
  let bestInFrustum: number | null = null;
  let bestInFrustumScore = -Infinity;
  for (let i = 0; i < WISP_SLOT_POSITIONS.length; i++) {
    if (occupied[i]) continue;
    const pos = WISP_SLOT_POSITIONS[i];
    const score = slotScore(pos, headset, stageDir);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    // Frustum membership: the direction to the slot is within the view cone.
    const toSlot = normalize({
      x: pos.x - headset.pos.x,
      y: pos.y - headset.pos.y,
      z: pos.z - headset.pos.z,
    });
    if (dot(toSlot, normalize(headset.dir)) >= headset.halfAngleCos - 1e-9) {
      if (score > bestInFrustumScore) {
        bestInFrustumScore = score;
        bestInFrustum = i;
      }
    }
  }
  return bestInFrustum ?? best;
}

// ---------------------------------------------------------------------------
// Pulse rate limiting + impulse clamp (spec §5.1 / §7.4 — the anti-cheat surface)
// ---------------------------------------------------------------------------

/** WISP_PULSE token-bucket refill rate: 2 pulses / second (spec §5.1). */
export const WISP_PULSE_RATE_PER_SEC = 2;
/** Bucket burst size: 2 (a wisp may fire twice back-to-back, then must wait). */
export const WISP_PULSE_BURST = 2;

/**
 * The server-side maximum radial-impulse magnitude a single WISP_PULSE may apply
 * (spec §7.4 "server-clamped radial impulse"). The client's cosmetic feedback is
 * unclamped, but the WORLD only ever feels a magnitude ≤ this, no matter what the
 * client sends. Chosen well under the finale/dial impulses so a wisp can nudge,
 * not launch the whole room.
 */
export const WISP_PULSE_MAX_IMPULSE = 6;

/**
 * Clamp a CLIENT-SENT pulse magnitude to the server-trusted range (spec §7.4).
 * The server NEVER trusts the client value: a huge/Infinity magnitude → the max;
 * a negative/NaN magnitude → 0 (no suction, no garbage impulse).
 */
export function clampPulseMagnitude(clientMagnitude: number): number {
  if (!Number.isFinite(clientMagnitude) || clientMagnitude <= 0) {
    // Infinity → treat as an over-the-max cheat; NaN/negative → floor to 0.
    return clientMagnitude === Number.POSITIVE_INFINITY ? WISP_PULSE_MAX_IMPULSE : 0;
  }
  return Math.min(clientMagnitude, WISP_PULSE_MAX_IMPULSE);
}

/**
 * A deterministic 2/s token bucket for WISP_PULSE (spec §5.1). Fake-time
 * friendly: the caller injects a `now()` clock. The 3rd pulse inside 1 s is
 * rejected; a token refills at WISP_PULSE_RATE_PER_SEC.
 */
export class WispPulseBucket {
  private _tokens = WISP_PULSE_BURST;
  private _last: number;

  constructor(private readonly _now: () => number = () => Date.now()) {
    this._last = _now();
  }

  /** Try to consume one pulse token. Returns true if admitted, false if throttled. */
  tryPulse(): boolean {
    const now = this._now();
    const elapsedSec = Math.max(0, (now - this._last) / 1000);
    this._last = now;
    this._tokens = Math.min(
      WISP_PULSE_BURST,
      this._tokens + elapsedSec * WISP_PULSE_RATE_PER_SEC
    );
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return true;
    }
    return false;
  }
}
