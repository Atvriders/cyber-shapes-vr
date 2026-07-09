/**
 * dials.ts — Task C10 seed cues + Task C11 compound cue bank (F3 Reality Dials).
 *
 * Built ONCE on the two C10 seeds — NO id migrations, ever (spec §7.3 "built once,
 * in C11, on the two C10 seeds"). C11 adds SIX compound cues; the two seeds keep
 * their exact C10 shape.
 *
 * The bank (spec §7.3):
 *   • shape-rain   (seed) — ATTRACT workhorse; a budgeted spawn burst.
 *   • low-g        (seed) — a bare DIAL_BOUNDS + suspendDespawn overlay.
 *   • gravity-flip — ceilingY overlay (shapes pile overhead → rain down on revert).
 *   • bullet-time  — ×0.25 timescale; a kinetic PRE-ROLL auto-launches shapes ONLY
 *                    when ambient kinetic energy is below a threshold (guarantees
 *                    motion so the slow-mo reads).
 *   • time-freeze  — burst → ~1.5 s chaos → FREEZE, with a 5–8 s HARD CAP.
 *   • neon-storm   — wind + spawn bursts; HELD shapes are exempt from eviction
 *                    (the §6.4 store invariant — exercised, never re-implemented).
 *   • singularity  — an attractor accretion disk (a central pull).
 *   • supernova    — the DESTRUCTIVE drop script (pull → hold → detonate). SUPERNOVA
 *                    IS "the built-in finale cue": its `phases` INCLUDE FINALE and it
 *                    carries the showpiece-active guard (refused only while a
 *                    siege/encore overlay is live), instead of excluding FINALE.
 *
 * Every OVERLAY dial carries `DIAL_BOUNDS` + `suspendDespawn: true` (containment is
 * part of the params, not a hope — §5.6). PURE data + pure `run(room)` bodies; no
 * `ws`, no Date.now, no raw setTimeout — timed stages ride `room.schedule` /
 * `room.setCueOverlay` (both backed by the host's injected TimerApi).
 */

import {
  DIAL_BOUNDS,
  DEFAULT_PARAMS,
  mergeParams,
  type Cue,
  type CueRegistry,
  type RoomHandle,
  type PhysicsParams,
} from '@cyber-shapes/shared';

// The ambient overlay dials all EXCLUDE OVERLOAD/FINALE (the §7.16 contention
// guard — those phases are showpiece-owned). This is the shared phase list.
const AMBIENT_DIAL_PHASES: Cue['phases'] = ['ATTRACT', 'LOBBY', 'PLAY'];

/** The active containment envelope every overlay dial carries (§5.6). */
const CONTAINMENT: Pick<PhysicsParams, 'bounds' | 'suspendDespawn'> = {
  bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
  suspendDespawn: true,
};

// ---------------------------------------------------------------------------
// shape-rain — budgeted spawn burst (comfort-free; exercises §6.4 eviction).
// (SEED — unchanged from C10.)
// ---------------------------------------------------------------------------

/** How many shapes one shape-rain fire drops. Kept modest so it never floods. */
export const SHAPE_RAIN_BURST = 8;

/** The shape types the rain cycles through (deterministic; no Math.random). */
const RAIN_TYPES = ['cube', 'sphere', 'icosahedron', 'octahedron', 'tetrahedron'] as const;

function runShapeRain(room: RoomHandle): void {
  for (let i = 0; i < SHAPE_RAIN_BURST; i++) {
    const type = RAIN_TYPES[i % RAIN_TYPES.length];
    const angle = (i / SHAPE_RAIN_BURST) * Math.PI * 2;
    const radius = 3 + (i % 3);
    room.store.spawn({
      type,
      position: { x: Math.cos(angle) * radius, y: 9 + (i % 4), z: Math.sin(angle) * radius },
      colorIndex: i % 6,
    });
  }
}

export const shapeRainCue: Cue = {
  id: 'shape-rain',
  label: 'SHAPE RAIN',
  tab: 'show',
  cooldownMs: 8_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 0, // comfort-free → ATTRACT's budget-0 playlist auto-fires it
  run: runShapeRain,
};

// ---------------------------------------------------------------------------
// low-g — a bare overlay carrying DIAL_BOUNDS + suspendDespawn, timed revert.
// (SEED — unchanged from C10.)
// ---------------------------------------------------------------------------

/** How long low-g holds before the overlay pops back to base (spec §5.6). */
export const LOW_G_REVERT_MS = 20_000;

export const LOW_G_OVERLAY: Partial<PhysicsParams> = {
  gravity: { x: 0, y: -1.2, z: 0 }, // ~¼ of the default −5: a gentle float
  ...CONTAINMENT,
};

function runLowG(room: RoomHandle): void {
  room.setCueOverlay(LOW_G_OVERLAY, LOW_G_REVERT_MS, { mode: 'LOW-G' });
}

export const lowGCue: Cue = {
  id: 'low-g',
  label: 'LOW-G',
  tab: 'show',
  cooldownMs: 30_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 1,
  writesOverlay: true,
  run: runLowG,
};

// ---------------------------------------------------------------------------
// gravity-flip — a ceiling pile that rains down on revert (spec §5.6/§7.3).
// ---------------------------------------------------------------------------

/** Short auto-revert so the ceiling pile snaps back and rains down (§7.3). */
export const GRAVITY_FLIP_REVERT_MS = 8_000;

/** The ceiling rest plane height the flipped pile settles against. */
export const GRAVITY_FLIP_CEILING_Y = 12;

/**
 * gravity-flip overlay: gravity flipped UP (shapes pile overhead) with a ceilingY
 * rest plane so they settle against the roof (the §5.6 containment — a flipped
 * gravity + REMOVE_DISTANCE would despawn the world in ~5 s otherwise). On revert
 * the overlay pops → gravity is back to the base (DOWN) and the pile rains down.
 */
export const GRAVITY_FLIP_OVERLAY: Partial<PhysicsParams> = {
  gravity: { x: 0, y: 5, z: 0 }, // flipped UP (mirror of the default −5)
  bounds: {
    ceilingY: GRAVITY_FLIP_CEILING_Y,
    softSphereR: DIAL_BOUNDS.softSphereR,
    speedCap: DIAL_BOUNDS.speedCap,
  },
  suspendDespawn: true,
};

function runGravityFlip(room: RoomHandle): void {
  room.setCueOverlay(GRAVITY_FLIP_OVERLAY, GRAVITY_FLIP_REVERT_MS, { mode: 'GRAVITY FLIP' });
}

export const gravityFlipCue: Cue = {
  id: 'gravity-flip',
  label: 'GRAVITY FLIP',
  tab: 'show',
  cooldownMs: 30_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 2, // an aggressive dial — gated out of a fresh wearer's first minute
  writesOverlay: true,
  run: runGravityFlip,
};

// ---------------------------------------------------------------------------
// bullet-time — ×0.25 timescale + a kinetic pre-roll ONLY under an energy floor.
// ---------------------------------------------------------------------------

export const BULLET_TIME_REVERT_MS = 12_000;
/** ×0.25 slow-mo. */
export const BULLET_TIME_TIMESCALE = 0.25;
/**
 * The ambient kinetic-energy floor below which the pre-roll auto-launches shapes
 * (spec §7.3: "BULLET TIME auto-launches 2–3 server shapes if ambient kinetic
 * energy is low"). Energy = Σ½|v|² over ungrabbed bodies (mass = 1).
 */
export const BULLET_TIME_ENERGY_THRESHOLD = 5;
/** How many shapes the pre-roll launches when the world is quiet. */
export const BULLET_TIME_PREROLL_COUNT = 3;

export const BULLET_TIME_OVERLAY: Partial<PhysicsParams> = {
  timescale: BULLET_TIME_TIMESCALE,
  ...CONTAINMENT,
};

/** Total ambient kinetic energy of ungrabbed bodies (½Σ|v|², unit mass). */
function ambientKineticEnergy(room: RoomHandle): number {
  let e = 0;
  for (const s of room.store.shapes) {
    if (s.grabbedBy !== null) continue;
    const v = s.velocity;
    if (!v) continue;
    e += 0.5 * (v.x * v.x + v.y * v.y + v.z * v.z);
  }
  return e;
}

function runBulletTime(room: RoomHandle): void {
  // Kinetic PRE-ROLL: only when the world is too quiet for slow-mo to read.
  if (ambientKineticEnergy(room) < BULLET_TIME_ENERGY_THRESHOLD) {
    for (let i = 0; i < BULLET_TIME_PREROLL_COUNT; i++) {
      const angle = (i / BULLET_TIME_PREROLL_COUNT) * Math.PI * 2;
      room.store.spawn({
        type: RAIN_TYPES[i % RAIN_TYPES.length],
        position: { x: Math.cos(angle) * 4, y: 8, z: Math.sin(angle) * 4 },
        colorIndex: i % 6,
      });
    }
  }
  room.setCueOverlay(BULLET_TIME_OVERLAY, BULLET_TIME_REVERT_MS, {
    mode: `BULLET TIME ×${BULLET_TIME_TIMESCALE}`,
  });
}

export const bulletTimeCue: Cue = {
  id: 'bullet-time',
  label: 'BULLET TIME',
  tab: 'show',
  cooldownMs: 30_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 1,
  writesOverlay: true,
  run: runBulletTime,
};

// ---------------------------------------------------------------------------
// time-freeze — burst → ~1.5 s chaos → FREEZE, with a 5–8 s hard cap.
// ---------------------------------------------------------------------------

/** The chaos window before the freeze snaps in (spec §7.3: "→ 1.5 s chaos →"). */
export const TIME_FREEZE_CHAOS_MS = 1_500;
/** The FREEZE hard cap (spec §7.3 "5–8 s cap"). 6 s sits inside the band. */
export const TIME_FREEZE_CAP_MS = 6_000;
/** How many shapes the pre-roll burst kicks so the freeze has motion to catch. */
export const TIME_FREEZE_BURST = 4;

/** The kinetic chaos overlay: contained + suspendDespawn, high energy, NOT frozen. */
export const TIME_FREEZE_CHAOS_OVERLAY: Partial<PhysicsParams> = {
  wind: { x: 3, y: 2, z: -3 },
  ...CONTAINMENT,
};

/** The frozen overlay: a fully static world (freeze short-circuits stepBody). */
export const TIME_FREEZE_FROZEN_OVERLAY: Partial<PhysicsParams> = {
  freeze: true,
  ...CONTAINMENT,
};

function runTimeFreeze(room: RoomHandle): void {
  // Pre-roll burst: guarantee motion the freeze will catch mid-air.
  for (let i = 0; i < TIME_FREEZE_BURST; i++) {
    const angle = (i / TIME_FREEZE_BURST) * Math.PI * 2;
    room.store.spawn({
      type: RAIN_TYPES[i % RAIN_TYPES.length],
      position: { x: Math.cos(angle) * 5, y: 8, z: Math.sin(angle) * 5 },
      colorIndex: i % 6,
    });
  }
  // Stage 1 — CHAOS: a windy contained overlay for ~1.5 s (its own timed revert is
  // long enough to be superseded by the freeze; endsAt is refreshed at stage 2).
  room.setCueOverlay(TIME_FREEZE_CHAOS_OVERLAY, TIME_FREEZE_CHAOS_MS + TIME_FREEZE_CAP_MS, {
    mode: 'TIME FREEZE',
  });
  // Stage 2 — after the chaos window, snap to FREEZE with the 5–8 s hard cap. The
  // cap-length auto-revert pops back to the BASE (the elected law, never DEFAULT).
  room.schedule(() => {
    room.setCueOverlay(TIME_FREEZE_FROZEN_OVERLAY, TIME_FREEZE_CAP_MS, { mode: 'TIME FREEZE' });
  }, TIME_FREEZE_CHAOS_MS);
}

export const timeFreezeCue: Cue = {
  id: 'time-freeze',
  label: 'TIME FREEZE',
  tab: 'show',
  cooldownMs: 45_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 2,
  writesOverlay: true,
  run: runTimeFreeze,
};

// ---------------------------------------------------------------------------
// neon-storm — wind + spawn bursts; HELD shapes exempt from eviction (§6.4).
// ---------------------------------------------------------------------------

export const NEON_STORM_REVERT_MS = 15_000;
export const NEON_STORM_BURST = 6;

export const NEON_STORM_OVERLAY: Partial<PhysicsParams> = {
  wind: { x: 6, y: 1, z: 4 },
  ...CONTAINMENT,
};

function runNeonStorm(room: RoomHandle): void {
  // Spawn bursts through the store — at MAX_SHAPES the store recycles the oldest
  // UNGRABBED + UNPINNED body (§6.4). A defender's held shape is grabbed → never
  // evicted (the invariant is exercised, never re-implemented here).
  for (let i = 0; i < NEON_STORM_BURST; i++) {
    const angle = (i / NEON_STORM_BURST) * Math.PI * 2;
    room.store.spawn({
      type: RAIN_TYPES[i % RAIN_TYPES.length],
      position: { x: Math.cos(angle) * 6, y: 7 + (i % 3), z: Math.sin(angle) * 6 },
      colorIndex: (i + 2) % 6,
    });
  }
  room.setCueOverlay(NEON_STORM_OVERLAY, NEON_STORM_REVERT_MS, { mode: 'NEON STORM' });
}

export const neonStormCue: Cue = {
  id: 'neon-storm',
  label: 'NEON STORM',
  tab: 'show',
  cooldownMs: 30_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 2,
  writesOverlay: true,
  run: runNeonStorm,
};

// ---------------------------------------------------------------------------
// singularity — an attractor accretion disk (a central pull, §5.6 attractors).
// ---------------------------------------------------------------------------

export const SINGULARITY_REVERT_MS = 12_000;
/** Central attractor strength (capped + min-radius softened in physicsCore). */
export const SINGULARITY_STRENGTH = 40;
export const SINGULARITY_MIN_RADIUS = 2;

export const SINGULARITY_OVERLAY: Partial<PhysicsParams> = {
  attractors: [
    { pos: { x: 0, y: 4, z: 0 }, strength: SINGULARITY_STRENGTH, minRadius: SINGULARITY_MIN_RADIUS },
  ],
  ...CONTAINMENT,
};

function runSingularity(room: RoomHandle): void {
  room.setCueOverlay(SINGULARITY_OVERLAY, SINGULARITY_REVERT_MS, { mode: 'SINGULARITY' });
}

export const singularityCue: Cue = {
  id: 'singularity',
  label: 'SINGULARITY',
  tab: 'show',
  cooldownMs: 30_000,
  phases: [...AMBIENT_DIAL_PHASES],
  comfortCost: 2,
  writesOverlay: true,
  run: runSingularity,
};

// ---------------------------------------------------------------------------
// supernova — the DESTRUCTIVE drop script (pull → hold → detonate). THE built-in
// finale cue: `phases` INCLUDE FINALE + the showpiece-active guard (§7.3/§7.16).
// ---------------------------------------------------------------------------

/** The pull phase: a strong central attractor draws every shape into the core. */
export const SUPERNOVA_PULL_MS = 2_500;
/** The hold at the core before the detonation. */
export const SUPERNOVA_HOLD_MS = 800;
/** The detonation blast window (a repulsive attractor + wide bounce). */
export const SUPERNOVA_DETONATE_MS = 3_000;
/** Total overlay lifetime → auto-revert to BASE (never DEFAULT). */
export const SUPERNOVA_REVERT_MS = SUPERNOVA_PULL_MS + SUPERNOVA_HOLD_MS + SUPERNOVA_DETONATE_MS;

export const SUPERNOVA_PULL_OVERLAY: Partial<PhysicsParams> = {
  attractors: [{ pos: { x: 0, y: 4, z: 0 }, strength: 90, minRadius: 1.5 }],
  ...CONTAINMENT,
};

/** Detonate: a NEGATIVE-strength attractor is a repulsor — the core blows outward. */
export const SUPERNOVA_DETONATE_OVERLAY: Partial<PhysicsParams> = {
  attractors: [{ pos: { x: 0, y: 4, z: 0 }, strength: -140, minRadius: 1.5 }],
  ...CONTAINMENT,
};

function runSupernova(room: RoomHandle): void {
  // Stage 1 — PULL: draw everything into the core (overlay lives the full script).
  room.setCueOverlay(SUPERNOVA_PULL_OVERLAY, SUPERNOVA_REVERT_MS, { mode: 'SUPERNOVA' });
  // Stage 2 — HOLD then DETONATE: after the pull+hold, flip to the repulsor blast.
  room.schedule(() => {
    room.setCueOverlay(SUPERNOVA_DETONATE_OVERLAY, SUPERNOVA_DETONATE_MS, { mode: 'SUPERNOVA' });
  }, SUPERNOVA_PULL_MS + SUPERNOVA_HOLD_MS);
}

export const supernovaCue: Cue = {
  id: 'supernova',
  label: 'SUPERNOVA',
  tab: 'advanced', // destructive → lives behind Advanced; the console confirms it
  destructive: true, // the confirm-flow's real cue (§7.3)
  cooldownMs: 60_000,
  // SUPERNOVA IS the finale cue: its phases INCLUDE FINALE (+ PLAY for a staff
  // drop). It is NOT excluded from FINALE like the ambient dials — instead it
  // carries the showpiece-active guard (refused only while a siege/encore overlay
  // is live), enforced by the host's fire() single-overlay-writer guard.
  phases: ['PLAY', 'FINALE'],
  comfortCost: 3,
  writesOverlay: true,
  run: runSupernova,
};

// ---------------------------------------------------------------------------
// build-mode — Task C34 (F23 The Workshop, spec §7.23). The desktop world-builder
// freeze cue. Advanced tab; phases ['ATTRACT','LOBBY'] ONLY (never mid-rotation).
// Firing it TOGGLES build-mode: engaging HOLDS the timeline (a composition session
// never rotates), SUSPENDS the auto-cue playlist, applies the freeze overlay
// (revertAfterMs = BUILD_SESSION_MAX_MS, re-fire extends), and claims the single
// overlay writer so ambient overlay dials are refused (§5.6). Re-firing WHILE
// ACTIVE toggles it OFF. Exits: toggle-off, session-max, or a staff RESET.
//
// The cue body just calls `room.setBuildMode()` (toggle) — ALL of the hold /
// auto-cue-suspend / overlay-writer / freeze mechanics live in the host's
// setBuildMode so the cue stays pure data. The WIRE gate (only a resident with the
// BUILD capability may fire it) is the connection layer's job — the cue is only
// advertised/fired for such a connection.
// ---------------------------------------------------------------------------

function runBuildMode(room: RoomHandle): void {
  // Toggle build-mode. The host does the hold + freeze + overlay-writer claim (or
  // the clean toggle-off). A host that never landed the Workshop leaves this absent.
  room.setBuildMode?.();
}

export const buildModeCue: Cue = {
  id: 'build-mode',
  label: 'BUILD MODE',
  tab: 'advanced', // the desktop world-builder lives behind Advanced
  cooldownMs: 0, // re-fire toggles OFF / extends — never cooldown-blocked
  // ATTRACT/LOBBY only (spec §7.23 "never mid-rotation"). A builder joining is a
  // human resident, so ATTRACT exits to LOBBY; firing build-mode there holds it.
  phases: ['ATTRACT', 'LOBBY'],
  comfortCost: 0,
  // NOT `writesOverlay` in the ambient-dial sense: the freeze overlay is applied by
  // setBuildMode which claims the single overlay writer directly. Marking it here
  // would make the host's fire() guard refuse the toggle-OFF re-fire while the
  // build overlay is live — build-mode must always be re-fireable to toggle off.
  run: runBuildMode,
};

// ---------------------------------------------------------------------------
// The seed set (C10) + the FULL C11 bank + registration helpers.
// ---------------------------------------------------------------------------

/** The two — and only two — C10 seed cues (ids frozen; C11 keeps them exactly). */
export const SEED_CUES: readonly Cue[] = [shapeRainCue, lowGCue];

/**
 * The six compound cues C11 adds on top of the two seeds (spec §7.3). Kept as a
 * named export so a test can assert the bank is exactly the seeds + these.
 */
export const COMPOUND_CUES: readonly Cue[] = [
  gravityFlipCue,
  bulletTimeCue,
  timeFreezeCue,
  neonStormCue,
  singularityCue,
  supernovaCue,
];

/** The FULL Reality-Dials bank (the two seeds + the six compound cues). */
export const ALL_DIAL_CUES: readonly Cue[] = [...SEED_CUES, ...COMPOUND_CUES];

/** Register the C10 seed cues (shape-rain + low-g) only. Used where the compound
 * bank is out of scope (kept for the C10 tests / minimal rooms). */
export function registerSeedCues(registry: CueRegistry): void {
  for (const cue of SEED_CUES) registry.register(cue);
}

/**
 * Register the Task C34 build-mode cue (F23 The Workshop, spec §7.23). Separate
 * from the dial bank so a room that never wants the desktop world-builder simply
 * never registers it (cut-safe). The connection layer registers it once per room
 * and CAPABILITY-GATES firing it (only a resident presenting the ownerToken fires
 * it) — the catalog advertisement is harmless (a non-owner's fire is refused).
 */
export function registerBuildModeCue(registry: CueRegistry): void {
  registry.register(buildModeCue);
}

// ---------------------------------------------------------------------------
// Task C15 — the Reality Referendum ballot: dial-cue-id options → standing laws.
// ---------------------------------------------------------------------------

/**
 * The dial overlays that make sensible STANDING laws when elected (spec §7.5 —
 * "options reference dial cue ids"). ONLY the STABLE ambient overlays are ballot
 * options: a scripted/transient cue (time-freeze burst→freeze, supernova's
 * pull→detonate) is NOT a law you would want to stand indefinitely, so they are
 * excluded. `low-g` is the neutral floor. Theme options are appended by C20.
 *
 * The elected LAW = the dial's overlay merged over DEFAULT_PARAMS (a full
 * PhysicsParams the election host writes into `baseParams`). Because a law is a
 * FULL base, a later dial firing reverts back to it (the C11 two-layer loop).
 */
const ELECTION_DIAL_LAW_OVERLAYS: Record<string, Partial<PhysicsParams>> = {
  'low-g': LOW_G_OVERLAY,
  'gravity-flip': GRAVITY_FLIP_OVERLAY,
  'bullet-time': BULLET_TIME_OVERLAY,
  'neon-storm': NEON_STORM_OVERLAY,
  'singularity': SINGULARITY_OVERLAY,
};

/** The default ballot options (dial cue ids ONLY; theme ids appended by C20). */
export const ELECTION_DIAL_OPTIONS: readonly string[] = Object.keys(ELECTION_DIAL_LAW_OVERLAYS);

/**
 * Resolve a winning ballot dial id → the STANDING law PhysicsParams (its overlay
 * merged over DEFAULT_PARAMS). Returns undefined for an id that is not a ballot
 * law option (the election host skips the enact — a defensive guard; the reducer
 * only ever produces a listed option as a winner). C20 widens this for theme ids.
 */
export function dialLaw(id: string): PhysicsParams | undefined {
  const overlay = ELECTION_DIAL_LAW_OVERLAYS[id];
  if (!overlay) return undefined;
  return mergeParams(DEFAULT_PARAMS, overlay);
}

/**
 * Register the FULL C11 Reality-Dials bank (the two seeds + six compound cues)
 * into a room's CueRegistry — each id EXACTLY once (fires CUE_CATALOG rebroadcast).
 * The live room host uses this so the director console advertises the whole bank.
 */
export function registerDialCues(registry: CueRegistry): void {
  for (const cue of ALL_DIAL_CUES) registry.register(cue);
}
