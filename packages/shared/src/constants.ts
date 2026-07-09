import type { ShapeType, RenderMode } from './types.js';

// ---------------------------------------------------------------------------
// Shape types — source: packages/client/src/shapes.js lines 3-6
// ---------------------------------------------------------------------------
export const SHAPE_TYPES: readonly ShapeType[] = [
  'cube',
  'sphere',
  'icosahedron',
  'torus',
  'torusKnot',
  'octahedron',
  'dodecahedron',
  'cylinder',
  'cone',
  'tetrahedron',
] as const;

// ---------------------------------------------------------------------------
// Render modes — source: packages/client/src/shapes.js lines 133-136
// ---------------------------------------------------------------------------
export const RENDER_MODES: readonly RenderMode[] = ['both', 'solid', 'wireframe'] as const;

// ---------------------------------------------------------------------------
// Colors (hex integers) — source: packages/client/src/shapes.js lines 8-10
// ---------------------------------------------------------------------------
export const CYBER_COLORS: readonly number[] = [
  0x00ffff, 0xff00ff, 0xff0066, 0x0066ff, 0x00ff66, 0x9900ff, 0xff6600,
] as const;

// ---------------------------------------------------------------------------
// World constants — source: packages/client/src/main.js line 34 (maxShapes: 40)
//                          packages/client/src/shapes.js line 59 (first 20 shapes get a light)
// ---------------------------------------------------------------------------
export const MAX_SHAPES = 40;
export const MAX_LIGHTS = 6;

// ---------------------------------------------------------------------------
// Physics constants — source: packages/client/src/physics.js lines 1-5
// ---------------------------------------------------------------------------
export const GRAVITY = -5;
export const BOUNCE = 0.5;
export const FRICTION = 0.98;
export const REST_THRESHOLD = 0.05;
export const REMOVE_DISTANCE = 50;

// ---------------------------------------------------------------------------
// Task C5 — the curated "showroom baseline" the RESET handler restores (§5.5,
// §6.4, §7.23). v1 is a hand-authored constants list; the Workshop (C34) makes it
// visual and adds a named-layouts bucket, but **RESET always falls back to THIS
// seed list whenever the layouts bucket has no baseline** (spec §7.23 line: "RESET
// falls back to the v1 shared-constants seed list") — C5 is Tier 0 and never
// depends on the Workshop.
//
// Kept small (well under MAX_SHAPES − METEOR_BUDGET) so the first meteor volley or
// a siege admission never starves it. Positions are a tidy ring on the floor plane
// (restY handled by the world); each entry is a SpawnInit for ServerWorld.spawn.
// ---------------------------------------------------------------------------
export interface ShowroomSeed {
  type: ShapeType;
  position: { x: number; y: number; z: number };
  colorIndex: number;
  renderMode?: RenderMode;
  scale?: number;
}

export const SHOWROOM_BASELINE: readonly ShowroomSeed[] = [
  { type: 'cube', position: { x: -4, y: 1, z: -4 }, colorIndex: 0 },
  { type: 'sphere', position: { x: 0, y: 1, z: -5 }, colorIndex: 1 },
  { type: 'icosahedron', position: { x: 4, y: 1, z: -4 }, colorIndex: 2 },
  { type: 'torus', position: { x: -5, y: 1, z: 0 }, colorIndex: 3 },
  { type: 'torusKnot', position: { x: 5, y: 1, z: 0 }, colorIndex: 4 },
  { type: 'octahedron', position: { x: -4, y: 1, z: 4 }, colorIndex: 5 },
  { type: 'dodecahedron', position: { x: 0, y: 1, z: 5 }, colorIndex: 6 },
  { type: 'cone', position: { x: 4, y: 1, z: 4 }, colorIndex: 0 },
] as const;

// ---------------------------------------------------------------------------
// Task C16 — F6 Meteor Siege constants (spec §7.6 / §7.16). The cross-constant
// tie (spec §7.23): a Workshop BASELINE layout is capped at MAX_SHAPES −
// METEOR_BUDGET so the first meteor volley (or a siege admission) never starves
// it. SHOWROOM_BASELINE above (8 shapes) is well under that bound.
// ---------------------------------------------------------------------------

/**
 * The headroom the siege reserves for in-flight meteors on top of the baseline
 * world. `MAX_SHAPES − METEOR_BUDGET = 28` is the baseline layout ceiling (spec
 * §7.16 "= 12 at current constants"). The store's recycle-oldest cap (§6.4) still
 * governs the absolute MAX_SHAPES total; this is the layout-validation reservation.
 */
export const METEOR_BUDGET = 12;

/** Server-side meteor speed cap (m/s). The arcing trajectory is clamped to this
 * regardless of what a client claims (spec §7.6: "capped 6–8 m/s"). */
export const METEOR_SPEED_CAP = 8;

/** The lag-comp rewind window (ms). Each meteor keeps a ~300 ms ring of past
 * positions; a grab intent validates against the rewound position (spec §7.6). */
export const METEOR_REWIND_MS = 300;

/** The catch radius (m). A generous radius plus catch-assist lets a 100 ms-late
 * grab land against the rewound position (spec §7.6: "~0.5 m radius"). */
export const METEOR_CATCH_RADIUS = 0.5;

/** The extra radius catch-assist adds during a showpiece (spec §7.6 defender
 * skill floor: "enlarged radius"). Applied on top of METEOR_CATCH_RADIUS. */
export const METEOR_CATCH_ASSIST_BONUS = 0.35;

/** One launch per launcher per this interval (spec §7.6: "one MET_LAUNCH/3 s"). */
export const MET_LAUNCH_INTERVAL_MS = 3_000;

/** The callout queue drains one line per this interval (spec §7.6: "1 per 2 s"). */
export const SIEGE_CALLOUT_INTERVAL_MS = 2_000;

/** Full siege duration when FINALE / staff-armed (spec §7.6: "full 90 s"). */
export const SIEGE_FULL_DURATION_MS = 90_000;

/** The OVERLOAD auto-arm extends its phase by this via hold() (spec §7.6). */
export const SIEGE_OVERLOAD_HOLD_MS = 60_000;

/** Crystal HP scales with participant count: base + per-participant (spec §7.6). */
export const SIEGE_CRYSTAL_HP_BASE = 40;
export const SIEGE_CRYSTAL_HP_PER_PARTICIPANT = 20;

/** The barrage cadence (ms) for the no-uplink rung: with zero phones the server
 * self-fires a meteor this often so the spectacle survives crowd-less (§7.6). */
export const SIEGE_BARRAGE_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Task C17 — F7 Titan Protocol constants (spec §7.7). "Rig scale, not world
// scale": the rig grows 1→5 (10 behind a second button) about the floor point.
// The server clamps titan throws + recalls out-of-bounds shapes (scoped to the
// titan-active window ONLY — baseline throws keep the Phase B despawn at
// REMOVE_DISTANCE, spec §7.7). All math lives in the pure `titanMath.ts`.
// ---------------------------------------------------------------------------

/** Default titan rig scale (1→5 ease over TITAN_SCALE_MS). Spec §7.7. */
export const TITAN_SCALE_DEFAULT = 5;
/** The bigger titan scale, behind a second staff button (spec §7.7: "10"). */
export const TITAN_SCALE_MAX = 10;
/** The rig-scale ease duration (ms) — 1→scale over 1.5 s (spec §7.7). */
export const TITAN_SCALE_MS = 1_500;
/** Hard auto-revert: a titan lasts at most this long, incl. on disconnect (§7.7). */
export const TITAN_DURATION_MS = 30_000;
/**
 * The velocity cap (m/s) the server clamps a titan-imparted throw/impulse to
 * (spec §7.7 `TITAN_THROW_MAX`) — a giant's sweep must not fling a shape at
 * infinite speed. Generous (a titan hits hard) but bounded.
 */
export const TITAN_THROW_MAX = 25;
/**
 * The titan's per-hand impulse reach (m) at rig scale 1; the effective reach is
 * this × the live rig scale (a scaled hand sweeps a scaled volume, spec §7.7
 * "within the scaled hand radius"). The impulse falls off linearly to zero at
 * the edge of this reach.
 */
export const TITAN_HAND_REACH = 1.2;
/**
 * The base impulse strength (m/s) a titan hand imparts, scaled by the hand speed
 * and the falloff. Clamped to TITAN_THROW_MAX at the call site.
 */
export const TITAN_IMPULSE_STRENGTH = 6;
/**
 * Where an out-of-bounds shape is recalled TO while a titan is active (spec §7.7
 * "respawn at origin"). A small floating radius so the recalled shape lands back
 * in the playfield rather than exactly on the origin point.
 */
export const TITAN_RECALL_RADIUS = 6;

// ---------------------------------------------------------------------------
// Task C32 — F21 Powers Lab constants (spec §7.21). Hand-tracking telekinesis:
// a strength-capped, min-radius-softened pull toward the bare-hand anchor,
// applied as a per-tick LOOP FORCE (the titan-hands pattern — NOT a
// PhysicsParams change). Every TK-specific number lives here so a Tier-6 cut
// leaves NO residue in Tier ≤5 constants (the pull/cone math is in the pure,
// sibling `tkMath.ts`). All safety-rail thresholds are constants so the harness
// tests pin them.
// ---------------------------------------------------------------------------

/**
 * The base pull acceleration (m/s per second) the server applies toward the hand
 * anchor each tick while a TK pull is live (spec §7.21 "strength-capped … pull
 * toward the hand anchor each tick"). The per-tick velocity delta = this × dt,
 * softened near the anchor and capped to {@link TK_PULL_SPEED_MAX}.
 */
export const TK_PULL_STRENGTH = 22;
/**
 * The per-pull SPEED CAP (m/s) — the safety-rail clamp on a TK-pulled shape's
 * velocity so the loop force can never fling a shape at unbounded speed (spec
 * §7.21 "per-pull speed cap"). Shares the titan throw ceiling's spirit but is a
 * distinct TK number (a bare-hand pull is gentler than a giant's sweep).
 */
export const TK_PULL_SPEED_MAX = 12;
/**
 * The MIN-RADIUS softening distance (m): within this radius of the anchor the
 * pull force eases to zero (spec §7.21 "min-radius-softened"), so a shape decays
 * to rest in the palm instead of oscillating through / overshooting the hand.
 */
export const TK_MIN_RADIUS = 0.35;
/**
 * The GRAB RADIUS (m): once the pulled shape is within this of the anchor the
 * pull CONVERTS to a normal Phase B first-claim-wins grab (spec §7.21). A little
 * larger than the min-radius so conversion happens as the shape settles into the
 * palm, not before the softening kicks in.
 */
export const TK_GRAB_RADIUS = 0.45;
/**
 * The DEAD-MAN'S SWITCH window (ms): a live pull EXPIRES if no fresh TK_PULL
 * arrives within this window (spec §7.21 "~250 ms"). Tracking loss / a dropped
 * hand thus releases the shape rather than freezing a stale force forever.
 */
export const TK_DEADMAN_MS = 250;
/**
 * The sustained-hold commit window (ms): a cone target must be held continuously
 * for this long before the pull commits (spec §7.21 "300 ms sustained-hold
 * cone-select") — a glance across a shape never yanks it.
 */
export const TK_SELECT_HOLD_MS = 300;
/**
 * The cone-select half-angle (radians) around the pointing direction; a candidate
 * shape must lie within this of the cone axis to be selectable (spec §7.21
 * cone-select). ~14° — tight enough to pick one shape, forgiving of hand jitter.
 */
export const TK_CONE_HALF_ANGLE = 0.25;
/** The maximum cone-select range (m): a shape past this is out of reach. */
export const TK_CONE_RANGE = 30;
/**
 * The auto-revert (ms) for the Powers Lab EXHIBIT: firing the staff cue arms TK
 * for at most this long, after which it auto-disarms (spec §7.21 "~10 min
 * auto-revert or RESET"). A forgotten quiet-period exhibit cannot run forever.
 */
export const TK_EXHIBIT_MS = 10 * 60 * 1000; // 10 min
/** Max concurrent pulls — one per hand (spec §7.21 "≤ 2 concurrent pulls"). */
export const TK_MAX_PULLS = 2;

// ---------------------------------------------------------------------------
// Task C34 — F23 The Workshop constants (spec §7.23).
// ---------------------------------------------------------------------------

/**
 * The build-mode freeze session hard cap (spec §7.23: "~2 h; re-fire extends;
 * re-fire WHILE ACTIVE toggles OFF"). The build-mode cue applies the freeze
 * overlay with `revertAfterMs = BUILD_SESSION_MAX_MS`; a composition session runs
 * held indefinitely (the timeline HOLDS) up to this cap, after which the freeze
 * auto-reverts and build-mode exits (a forgotten session cannot freeze forever).
 */
export const BUILD_SESSION_MAX_MS = 2 * 60 * 60 * 1000; // 2 h

/** The named-layout count cap per room (spec §7.23 ~32; refuse + manual delete). */
export const LAYOUT_COUNT_CAP = 32;
