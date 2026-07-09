// ---------------------------------------------------------------------------
// daemons.ts — F17 Daemon Crew behavior chassis (spec §7.17, C28). PURE.
//
// A DAEMON is a server-hosted synthetic resident peer (callsign from the reserved
// `DMN-` namespace, §6.1) that plays a game of catch with a lone visitor so the
// booth is never an empty solo sandbox during quiet hours. This module is the
// PURE behavior state machine + pose-synth — NO server import, NO I/O, NO Date /
// Math.random (an injected RNG + clock make it deterministic). It is ALSO the
// load-generator chassis C22 drives (honest framing, §7.17): it emits the same
// validated game intents a human client would, which the server host (`packages/
// server/src/daemons.ts`) forwards through the STANDARD room.applyIntent path —
// there is no god-mode, no privileged world mutation here.
//
// v1 ships **fetch-and-return ONLY** (spec §7.17): seek the nearest loose shape,
// grab it (DEFERRING to any human reaching for it), carry it to a chest-height
// offset below the nearest human head — never AT the head — and lob it back as a
// catchable 3–6 m/s arc (the server wires C16 catch-assist to the return throw).
// orbit-juggle + siege-co-defender are FLAGGED OFF ({@link DAEMON_BEHAVIORS}).
// ---------------------------------------------------------------------------

import type { Vec3, Pose, ClientMsg } from './net/types.js';

// ---------------------------------------------------------------------------
// Behavior flags — v1 ships exactly ONE behavior (spec §7.17: "one polished
// fetch-and-return"). The other two are named but OFF; a test pins this so a
// future task cannot silently ship orbit-juggle / siege-defender without flipping
// the flag AND passing an owner acceptance gate.
// ---------------------------------------------------------------------------
export const DAEMON_BEHAVIORS = {
  /** The ONLY v1 behavior: seek → grab (human-deferred) → carry → catchable lob. */
  fetchAndReturn: true,
  /** FLAGGED OFF (spec §7.17 — behind a flag until owner-accepted). */
  orbitJuggle: false,
  /** FLAGGED OFF (spec §7.17 — behind a flag until owner-accepted). */
  siegeDefender: false,
} as const;

// ---------------------------------------------------------------------------
// Tunables (all spec §7.17 values).
// ---------------------------------------------------------------------------

/** Min / max catchable return-throw speed (m/s) — "catchable 3–6 m/s arcing lobs". */
export const DAEMON_MIN_THROW_SPEED = 3;
export const DAEMON_MAX_THROW_SPEED = 6;

/** The return target is this far BELOW the human head — chest height, NEVER the head. */
export const DAEMON_CHEST_OFFSET_Y = 0.45;

/**
 * Grab-deference radius (m): a daemon NEVER claims a shape within this radius of a
 * HUMAN hand, and RELEASES a held shape the instant a human hand enters it (spec
 * §7.17 — "release immediately if contested"). The load-bearing anti-"zero-RTT
 * god-mode" rule: a contested same-window grab always resolves to the human.
 */
export const DAEMON_GRAB_DEFER_RADIUS = 0.6;

/** How close (m) the daemon's hand must be to a loose shape before it grabs. */
export const DAEMON_REACH_RADIUS = 0.35;

/** Daemon movement speed (m/s) while seeking / carrying (a gentle drone glide). */
export const DAEMON_MOVE_SPEED = 2.5;

/** Upward arc bias added to a return lob so it reads as a gentle catchable toss. */
const DAEMON_ARC_UP = 1.6;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** The daemon's fetch-and-return state. */
export type DaemonState = 'idle' | 'seeking' | 'carrying';

/** A read-only view of a world shape the daemon may act on. */
export interface DaemonShapeView {
  id: string;
  position: Vec3;
  /** null = loose; a peer id = held by that peer (a human id ⇒ off-limits). */
  grabbedBy: string | null;
}

/** A human target the daemon aims at (head + live hand positions). */
export interface DaemonHumanTarget {
  id: string;
  head: Vec3;
  /** Live hand world positions (0–2). Used for both aiming AND grab-deference. */
  hands: Vec3[];
}

/** The per-daemon mind (its whole mutable state; the host owns one per daemon). */
export interface DaemonMind {
  /** The daemon's peer id (a `DMN-` callsign is assigned by the host/server). */
  readonly id: string;
  state: DaemonState;
  /** The daemon's current world position (drives its synthesized pose). */
  pos: Vec3;
  /** The shape id being sought / carried, or null when idle. */
  targetShapeId: string | null;
}

/** The world + timing context a daemon step reads (pure inputs). */
export interface DaemonStepCtx {
  shapes: DaemonShapeView[];
  humans: DaemonHumanTarget[];
  /** Seconds since the previous step (movement integration). */
  dt: number;
  /** Deterministic RNG in [0,1) — injected, never Math.random. */
  rng: () => number;
}

/** What one step produced: the (mutated) mind, the daemon's pose, its intents. */
export interface DaemonStep {
  mind: DaemonMind;
  /** The synthesized daemon pose (head + one hand) to relay as its avatar pose. */
  pose: Pose;
  /**
   * The ordered game intents this step emits — plain `ClientMsg`es the server host
   * forwards VERBATIM through the standard validated room.applyIntent path (no
   * god-mode). Empty on a step that only moved/aimed.
   */
  intents: ClientMsg[];
}

// ---------------------------------------------------------------------------
// Tiny pure vector helpers (local — shared has no general Vec3 math export).
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}
function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
/** Unit vector of `a` (zero vector → {0,0,0}). */
function unit(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-6 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}
/** True iff every component of `v` is finite. */
function allFinite(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// ---------------------------------------------------------------------------
// Pure behavior primitives (exported — unit-tested independently + reused by C22).
// ---------------------------------------------------------------------------

/** The chest-height aim point for a human: a fixed offset BELOW the head (never AT it). */
export function chestTarget(head: Vec3): Vec3 {
  return { x: head.x, y: head.y - DAEMON_CHEST_OFFSET_Y, z: head.z };
}

/**
 * True iff a daemon must DEFER grabbing `shape` — i.e. a HUMAN hand is within
 * {@link DAEMON_GRAB_DEFER_RADIUS} of it, OR a human already holds a pending claim
 * on it. `selfId` is the daemon's own id (its own grab is never "contested").
 * The single rule that makes a contested same-window grab resolve to the HUMAN
 * (spec §7.17 — the daemon simply never reaches for a shape a human is going for).
 */
export function shouldDeferGrab(
  shape: DaemonShapeView,
  humans: DaemonHumanTarget[],
  selfId: string,
  radius: number = DAEMON_GRAB_DEFER_RADIUS
): boolean {
  // A pending/active human claim (anyone that isn't THIS daemon) ⇒ defer.
  if (shape.grabbedBy !== null && shape.grabbedBy !== selfId) return true;
  // A human HAND inside the deference radius ⇒ defer (they are reaching for it).
  for (const h of humans) {
    for (const hand of h.hands) {
      if (dist(hand, shape.position) <= radius) return true;
    }
  }
  return false;
}

/**
 * Pick the nearest LOOSE, non-deferred shape to `from`, or null if none is
 * available. Shapes a human is holding/reaching for are skipped (grab deference).
 */
export function nearestFetchableShape(
  from: Vec3,
  shapes: DaemonShapeView[],
  humans: DaemonHumanTarget[],
  selfId: string
): DaemonShapeView | null {
  let best: DaemonShapeView | null = null;
  let bestD = Infinity;
  for (const s of shapes) {
    if (!allFinite(s.position)) continue;
    if (shouldDeferGrab(s, humans, selfId)) continue;
    const d = dist(from, s.position);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * Compute a catchable return-throw velocity from `from` toward the chest `target`.
 * Horizontal aim toward the target + a gentle upward arc, with speed CLAMPED into
 * [{@link DAEMON_MIN_THROW_SPEED}, {@link DAEMON_MAX_THROW_SPEED}] (spec §7.17). A
 * tiny deterministic jitter (from `rng`) keeps repeated lobs from looking robotic.
 */
export function computeReturnThrow(from: Vec3, target: Vec3, rng: () => number): Vec3 {
  const toTarget = sub(target, from);
  const dir = unit({ x: toTarget.x, y: 0, z: toTarget.z });
  // Speed scales gently with horizontal distance, clamped to the catchable band.
  const horizontal = Math.hypot(toTarget.x, toTarget.z);
  const jitter = (rng() - 0.5) * 0.4; // ±0.2 m/s
  const speed = clamp(
    DAEMON_MIN_THROW_SPEED + horizontal * 0.5 + jitter,
    DAEMON_MIN_THROW_SPEED,
    DAEMON_MAX_THROW_SPEED
  );
  return {
    x: dir.x * speed,
    y: DAEMON_ARC_UP, // the arc: a gentle upward toss (chest-catchable)
    z: dir.z * speed,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ---------------------------------------------------------------------------
// The daemon state machine — one step.
// ---------------------------------------------------------------------------

/** Create a fresh idle daemon mind at an initial position. */
export function makeDaemonMind(id: string, pos: Vec3 = { x: 0, y: 1.4, z: 0 }): DaemonMind {
  return { id, state: 'idle', pos: { ...pos }, targetShapeId: null };
}

/** Synthesize the daemon's avatar pose from its position (head + one hand). */
function synthPose(pos: Vec3): Pose {
  const q = { x: 0, y: 0, z: 0, w: 1 };
  return {
    head: { p: { ...pos }, q },
    // One hand slightly below the head "core" (a single drone claw).
    hands: [{ p: { x: pos.x, y: pos.y - 0.2, z: pos.z }, q }, null],
  };
}

/** Move `pos` toward `goal` by up to DAEMON_MOVE_SPEED·dt; returns the new pos. */
function glideToward(pos: Vec3, goal: Vec3, dt: number): Vec3 {
  const to = sub(goal, pos);
  const d = len(to);
  const step = DAEMON_MOVE_SPEED * dt;
  if (d <= step || d < 1e-6) return { ...goal };
  return add(pos, scale(unit(to), step));
}

/** The nearest human to a point (for aim), or null if the room has no humans. */
function nearestHuman(from: Vec3, humans: DaemonHumanTarget[]): DaemonHumanTarget | null {
  let best: DaemonHumanTarget | null = null;
  let bestD = Infinity;
  for (const h of humans) {
    const d = dist(from, h.head);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/**
 * Advance ONE daemon by one step (spec §7.17 fetch-and-return). Mutates + returns
 * `mind`, synthesizes its pose, and emits the game intents to forward through the
 * validated path. Deterministic given `ctx.rng`. NEVER grabs a human-contested
 * shape; RELEASES a carried shape the instant a human contests it.
 *
 *   idle    → find nearest fetchable loose shape → seeking
 *   seeking → glide to it; within reach & uncontested → GRAB → carrying
 *           → (target vanished / a human took it) → idle
 *   carrying→ glide the held shape to the nearest human's chest offset; in range
 *             → RELEASE as a catchable lob → idle
 *           → (contested by a human hand) → RELEASE immediately → idle
 */
export function stepDaemon(mind: DaemonMind, ctx: DaemonStepCtx): DaemonStep {
  const { shapes, humans, dt, rng } = ctx;
  const intents: ClientMsg[] = [];
  const shapeById = new Map(shapes.map((s) => [s.id, s]));

  switch (mind.state) {
    case 'idle': {
      const target = nearestFetchableShape(mind.pos, shapes, humans, mind.id);
      if (target) {
        mind.state = 'seeking';
        mind.targetShapeId = target.id;
      }
      break;
    }

    case 'seeking': {
      const shape = mind.targetShapeId ? shapeById.get(mind.targetShapeId) : undefined;
      // Target gone, or a human grabbed/started reaching for it → yield, re-idle.
      if (!shape || shouldDeferGrab(shape, humans, mind.id)) {
        mind.state = 'idle';
        mind.targetShapeId = null;
        break;
      }
      mind.pos = glideToward(mind.pos, shape.position, dt);
      // Within reach AND still uncontested → GRAB (the standard validated intent).
      if (dist(mind.pos, shape.position) <= DAEMON_REACH_RADIUS) {
        intents.push({ t: 'grab', id: shape.id });
        mind.state = 'carrying';
      }
      break;
    }

    case 'carrying': {
      const shape = mind.targetShapeId ? shapeById.get(mind.targetShapeId) : undefined;
      // Lost the grab (evicted / stolen) → re-idle, nothing to release.
      if (!shape || (shape.grabbedBy !== null && shape.grabbedBy !== mind.id)) {
        mind.state = 'idle';
        mind.targetShapeId = null;
        break;
      }
      const human = nearestHuman(mind.pos, humans);
      // No human left to lob to → drop it gently at rest (re-idle).
      if (!human) {
        intents.push(releaseIntent(shape.id, mind.pos, { x: 0, y: 0, z: 0 }));
        mind.state = 'idle';
        mind.targetShapeId = null;
        break;
      }
      // A human HAND reaching for the carried shape → release IMMEDIATELY (contested).
      const contested = human.hands.some(
        (hand) => dist(hand, shape.position) <= DAEMON_GRAB_DEFER_RADIUS
      );
      const chest = chestTarget(human.head);
      if (contested) {
        intents.push(releaseIntent(shape.id, shape.position, { x: 0, y: 0, z: 0 }));
        mind.state = 'idle';
        mind.targetShapeId = null;
        break;
      }
      // Carry the shape toward a lob position (a bit back from the human), streaming
      // its held transform each step so peers see it move with the daemon.
      const lobFrom = pullbackFrom(chest, mind.pos);
      mind.pos = glideToward(mind.pos, lobFrom, dt);
      intents.push({ t: 'held', id: shape.id, position: { ...mind.pos }, rotation: { x: 0, y: 0, z: 0 } });
      // In lob position → throw the catchable arc back to the human's chest.
      if (dist(mind.pos, lobFrom) <= DAEMON_REACH_RADIUS) {
        const vel = computeReturnThrow(mind.pos, chest, rng);
        intents.push(releaseIntent(shape.id, mind.pos, vel));
        mind.state = 'idle';
        mind.targetShapeId = null;
      }
      break;
    }
  }

  return { mind, pose: synthPose(mind.pos), intents };
}

/** A lob launch point: pulled back ~1.2 m from the chest target toward the daemon. */
function pullbackFrom(chest: Vec3, daemonPos: Vec3): Vec3 {
  const back = unit(sub(daemonPos, chest));
  return add(chest, scale(back, 1.2));
}

/** Build a release ClientMsg (position/rotation/velocity — the standard shape). */
function releaseIntent(id: string, position: Vec3, velocity: Vec3): ClientMsg {
  return { t: 'release', id, velocity, position: { ...position }, rotation: { x: 0, y: 0, z: 0 } };
}
