import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOUNCE, FRICTION, REMOVE_DISTANCE } from '@cyber-shapes/shared';
import {
  stepBody,
  type PhysicsBody,
  DEFAULT_PARAMS,
  DIAL_BOUNDS,
  mergeParams,
  applyRadialImpulse,
  type PhysicsParams,
} from '@cyber-shapes/shared';
import type { ShapeType } from '../src/types.js';

function makeBody(overrides: Partial<PhysicsBody> = {}): PhysicsBody {
  return {
    position: { x: 0, y: 5, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    scale: 1,
    type: 'cube',
    grabbedBy: null,
    grounded: false,
    ...overrides,
  };
}

describe('stepBody — gravity', () => {
  it('airborne body gains downward velocity and y decreases', () => {
    const body = makeBody({ position: { x: 0, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
    const dt = 1 / 60;
    stepBody(body, dt);
    expect(body.velocity.y).toBeLessThan(0);
    expect(body.position.y).toBeLessThan(5);
    expect(body.grounded).toBe(false);
  });
});

describe('stepBody — bounce', () => {
  it('fast downward body at floor: velocity.y flips and scales by BOUNCE, impact===true', () => {
    const restY = 0.15; // cube, scale=1
    const incomingSpeed = 5;
    const body = makeBody({
      position: { x: 0, y: restY, z: 0 },
      velocity: { x: 0, y: -incomingSpeed, z: 0 },
    });
    const result = stepBody(body, 1 / 60);
    expect(result.impact).toBe(true);
    expect(result.impactSpeed).toBeGreaterThan(0);
    // velocity.y should have been negated and scaled by BOUNCE
    // After bounce: velocity.y = incomingSpeed * BOUNCE (positive, bouncing up)
    expect(body.velocity.y).toBeGreaterThan(0);
    expect(body.velocity.y).toBeCloseTo(incomingSpeed * BOUNCE, 0);
    expect(result.removed).toBe(false);
  });
});

describe('stepBody — settle', () => {
  it('body at floor with near-zero velocity becomes grounded with velocity.y === 0', () => {
    // Start just at restY with a tiny downward nudge that, combined with gravity,
    // results in a post-bounce velocity below REST_THRESHOLD — settling the body.
    // velocity.y = -0.001: after gravity (-5/60 ≈ -0.083) = -0.084;
    // after bounce (*-BOUNCE) = +0.042; 0.042 < REST_THRESHOLD(0.05) → velocity.y zeroed → grounded.
    const restY = 0.15; // cube, scale=1
    const body = makeBody({
      position: { x: 0, y: restY, z: 0 },
      velocity: { x: 0, y: -0.001, z: 0 },
    });
    const result = stepBody(body, 1 / 60);
    expect(body.grounded).toBe(true);
    expect(body.velocity.y).toBe(0);
    expect(result.impact).toBe(false);
  });
});

describe('stepBody — removal', () => {
  it('body at position magnitude > REMOVE_DISTANCE returns removed===true without mutating a store', () => {
    const farDist = REMOVE_DISTANCE + 1;
    // Place the body far along x axis
    const body = makeBody({
      position: { x: farDist, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    });
    const result = stepBody(body, 1 / 60);
    expect(result.removed).toBe(true);
    // stepBody is pure — no external store side effects possible (only the body is mutated)
  });

  it('body within REMOVE_DISTANCE is not flagged for removal', () => {
    const body = makeBody({ position: { x: 1, y: 5, z: 1 } });
    const result = stepBody(body, 1 / 60);
    expect(result.removed).toBe(false);
  });
});

describe('stepBody — grabbed body does not move', () => {
  it('position and velocity unchanged when grabbedBy is set', () => {
    const body = makeBody({
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0.5, y: -1, z: 0.5 },
      grabbedBy: 'peer-abc',
    });
    const before = {
      px: body.position.x,
      py: body.position.y,
      pz: body.position.z,
      vx: body.velocity.x,
      vy: body.velocity.y,
      vz: body.velocity.z,
    };
    const result = stepBody(body, 1 / 60);
    expect(body.position.x).toBe(before.px);
    expect(body.position.y).toBe(before.py);
    expect(body.position.z).toBe(before.pz);
    expect(body.velocity.x).toBe(before.vx);
    expect(body.velocity.y).toBe(before.vy);
    expect(body.velocity.z).toBe(before.vz);
    expect(result.impact).toBe(false);
    expect(result.removed).toBe(false);
  });
});

describe('stepBody — delta-scaled friction (frame-rate independence)', () => {
  it('one step at dt=1/30 leaves velocity.x within tolerance of two steps at dt=1/60', () => {
    const vx0 = 2.0;
    // One step at 1/30
    const body30 = makeBody({ position: { x: 0, y: 5, z: 0 }, velocity: { x: vx0, y: 0, z: 0 } });
    stepBody(body30, 1 / 30);
    const vxAfter30 = body30.velocity.x;

    // Two steps at 1/60
    const body60 = makeBody({ position: { x: 0, y: 5, z: 0 }, velocity: { x: vx0, y: 0, z: 0 } });
    stepBody(body60, 1 / 60);
    stepBody(body60, 1 / 60);
    const vxAfter60 = body60.velocity.x;

    // With proper delta-scaling, these should be very close
    expect(Math.abs(vxAfter30 - vxAfter60)).toBeLessThan(0.001);
  });

  it('naive per-frame FRICTION multiplication would fail: constant FRICTION^2 !== FRICTION^(dt*60) at dt=1/30', () => {
    // This test documents WHY delta-scaling matters:
    // naive: FRICTION applied once per step regardless of dt
    // At dt=1/30: one multiply by FRICTION = 0.98
    // At dt=1/60: two multiplies by FRICTION = 0.98^2 = 0.9604
    // These differ by more than 0.01 — proving the old code was frame-rate-dependent.
    const naiveAt30 = FRICTION; // one frame at 30fps
    const naiveAt60 = FRICTION * FRICTION; // two frames at 60fps
    expect(Math.abs(naiveAt30 - naiveAt60)).toBeGreaterThan(0.01);
  });
});

// ===========================================================================
// Task C6 — PhysicsParams + containment. PARITY IS SACRED.
// ===========================================================================

// A tiny deterministic PRNG (mulberry32) — identical to the capture harness so
// the parity test regenerates the EXACT same 1000-body set the goldens came from.
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

const PARITY_TYPES: ShapeType[] = [
  'cube', 'sphere', 'icosahedron', 'torus', 'torusKnot',
  'octahedron', 'dodecahedron', 'cylinder', 'cone', 'tetrahedron',
];

function makeParityBodies(rng: () => number): PhysicsBody[] {
  const bodies: PhysicsBody[] = [];
  for (let i = 0; i < 1000; i++) {
    const px = (rng() - 0.5) * 120;
    const py = rng() * 40;
    const pz = (rng() - 0.5) * 120;
    const vx = (rng() - 0.5) * 80;
    const vy = (rng() - 0.5) * 80;
    const vz = (rng() - 0.5) * 80;
    const type = PARITY_TYPES[Math.floor(rng() * PARITY_TYPES.length)]!;
    const scale = 0.2 + rng() * 2.8;
    const grabbedBy = rng() < 0.1 ? `peer-${i}` : null;
    bodies.push({
      position: { x: px, y: py, z: pz },
      velocity: { x: vx, y: vy, z: vz },
      scale,
      type,
      grabbedBy,
      grounded: false,
    });
  }
  return bodies;
}

interface GoldenRecord {
  final: { px: number; py: number; pz: number; vx: number; vy: number; vz: number; grounded: boolean };
  removedAt: number;
  trace: Array<{ i: boolean; s: number; r: boolean }>;
}
interface GoldenFile {
  dt: number;
  steps: number;
  seed: number;
  records: GoldenRecord[];
}

describe('C6 PARITY — DEFAULT_PARAMS ≡ Phase B (bit-identical)', () => {
  const golden = JSON.parse(
    readFileSync(fileURLToPath(new URL('./physicsParity.golden.json', import.meta.url)), 'utf8')
  ) as GoldenFile;

  it('1000 seeded bodies × 100 steps under DEFAULT_PARAMS reproduce the pre-change goldens bit-for-bit', () => {
    const rng = mulberry32(golden.seed);
    const bodies = makeParityBodies(rng);
    const { dt, steps } = golden;
    expect(bodies.length).toBe(golden.records.length);

    let removedTrue = 0;
    let pastR50WithRemoved = 0;

    for (let b = 0; b < bodies.length; b++) {
      const body = bodies[b]!;
      const rec = golden.records[b]!;
      let removedAt = -1;
      for (let step = 0; step < steps; step++) {
        // NEW signature with explicit DEFAULT_PARAMS third arg.
        const res = stepBody(body, dt, DEFAULT_PARAMS);
        const g = rec.trace[step]!;
        // Bit-identical result flags, EVERY step.
        expect(res.impact).toBe(g.i);
        expect(Object.is(res.impactSpeed, g.s)).toBe(true);
        expect(res.removed).toBe(g.r);
        if (res.removed) {
          removedTrue++;
          if (removedAt === -1) removedAt = step;
        }
      }
      expect(removedAt).toBe(rec.removedAt);
      // Bit-identical final body state.
      expect(Object.is(body.position.x, rec.final.px)).toBe(true);
      expect(Object.is(body.position.y, rec.final.py)).toBe(true);
      expect(Object.is(body.position.z, rec.final.pz)).toBe(true);
      expect(Object.is(body.velocity.x, rec.final.vx)).toBe(true);
      expect(Object.is(body.velocity.y, rec.final.vy)).toBe(true);
      expect(Object.is(body.velocity.z, rec.final.vz)).toBe(true);
      expect(body.grounded).toBe(rec.final.grounded);

      const dist = Math.hypot(rec.final.px, rec.final.py, rec.final.pz);
      if (dist > 50 && rec.removedAt >= 0) pastR50WithRemoved++;
    }

    // The set genuinely exercises the removal path (bodies past r=50).
    expect(removedTrue).toBeGreaterThan(0);
    expect(pastR50WithRemoved).toBeGreaterThan(0);
  });

  it('DEFAULT_PARAMS third arg is optional: stepBody(body, dt) === stepBody(body, dt, DEFAULT_PARAMS)', () => {
    const rng = mulberry32(0xdefacc);
    const bodies = makeParityBodies(rng);
    for (let b = 0; b < 50; b++) {
      const a: PhysicsBody = structuredClone(bodies[b]!);
      const c: PhysicsBody = structuredClone(bodies[b]!);
      for (let step = 0; step < 30; step++) {
        const ra = stepBody(a, 1 / 60); // default arg
        const rc = stepBody(c, 1 / 60, DEFAULT_PARAMS); // explicit
        expect(ra).toEqual(rc);
      }
      expect(a).toEqual(c);
    }
  });

  it('a body past r>50 still reports removed:true under DEFAULT_PARAMS', () => {
    const body: PhysicsBody = {
      position: { x: 55, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    expect(stepBody(body, 1 / 60, DEFAULT_PARAMS).removed).toBe(true);
  });
});

describe('C6 — DEFAULT_PARAMS + DIAL_BOUNDS shape', () => {
  it('DEFAULT_PARAMS bounds are inert (Infinity) and suspendDespawn false', () => {
    expect(DEFAULT_PARAMS.bounds?.softSphereR).toBe(Infinity);
    expect(DEFAULT_PARAMS.bounds?.speedCap).toBe(Infinity);
    expect(DEFAULT_PARAMS.suspendDespawn).toBe(false);
    expect(DEFAULT_PARAMS.freeze).toBe(false);
    expect(DEFAULT_PARAMS.bounds?.ceilingY).toBeUndefined();
  });

  it('DIAL_BOUNDS carries the active clamp limits', () => {
    expect(DIAL_BOUNDS.softSphereR).toBe(18);
    expect(DIAL_BOUNDS.speedCap).toBe(30);
  });

  it('DEFAULT_PARAMS.gravity.y matches Phase B GRAVITY (-5)', () => {
    expect(DEFAULT_PARAMS.gravity?.y).toBe(-5);
    expect(DEFAULT_PARAMS.gravity?.x).toBe(0);
    expect(DEFAULT_PARAMS.gravity?.z).toBe(0);
  });
});

describe('C6 — suspendDespawn', () => {
  it('suspendDespawn:true → removed:false even beyond REMOVE_DISTANCE', () => {
    const body: PhysicsBody = {
      position: { x: REMOVE_DISTANCE + 20, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    const params = mergeParams(DEFAULT_PARAMS, { suspendDespawn: true });
    const res = stepBody(body, 1 / 60, params);
    expect(res.removed).toBe(false);
  });

  it('suspendDespawn:false (default) still removes beyond REMOVE_DISTANCE', () => {
    const body: PhysicsBody = {
      position: { x: REMOVE_DISTANCE + 20, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    expect(stepBody(body, 1 / 60, DEFAULT_PARAMS).removed).toBe(true);
  });
});

describe('C6 — freeze short-circuit', () => {
  it('frozen body: bit-exact state conservation over many steps (no drift, no result flags)', () => {
    const params = mergeParams(DEFAULT_PARAMS, { freeze: true });
    const body: PhysicsBody = {
      position: { x: 1.5, y: 7.25, z: -3.125 },
      velocity: { x: 2.5, y: -4.0, z: 0.75 },
      scale: 1.3,
      type: 'sphere',
      grabbedBy: null,
      grounded: false,
    };
    const before = structuredClone(body);
    for (let i = 0; i < 500; i++) {
      const res = stepBody(body, 1 / 60, params);
      expect(res.impact).toBe(false);
      expect(res.impactSpeed).toBe(0);
      expect(res.removed).toBe(false);
    }
    expect(body).toEqual(before); // bit-exact conservation
  });

  it('freeze conserves a body that would otherwise be removed (no removal while frozen)', () => {
    const params = mergeParams(DEFAULT_PARAMS, { freeze: true });
    const body: PhysicsBody = {
      position: { x: 100, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    const res = stepBody(body, 1 / 60, params);
    expect(res.removed).toBe(false);
    expect(body.position.x).toBe(100);
  });

  it('release-during-freeze banks velocity: unfreezing resumes from the conserved velocity', () => {
    const frozen = mergeParams(DEFAULT_PARAMS, { freeze: true });
    const body: PhysicsBody = {
      position: { x: 0, y: 10, z: 0 },
      velocity: { x: 3, y: 5, z: -2 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    // Freeze for a while — velocity is banked, not integrated.
    for (let i = 0; i < 100; i++) stepBody(body, 1 / 60, frozen);
    expect(body.velocity).toEqual({ x: 3, y: 5, z: -2 });
    // Unfreeze: gravity now applies to the banked velocity.
    const res = stepBody(body, 1 / 60, DEFAULT_PARAMS);
    expect(res.removed).toBe(false);
    expect(body.velocity.y).toBeCloseTo(5 + -5 / 60, 10); // banked 5 then gravity
    expect(body.velocity.x).toBeLessThan(3); // friction now applies
  });
});

describe('C6 — gravity flip + ceiling rest plane (DIAL_BOUNDS)', () => {
  it('flipped gravity + ceilingY: a body rises, rests on the ceiling plane, never removed', () => {
    const ceilingY = 8;
    const params = mergeParams(DEFAULT_PARAMS, {
      gravity: { x: 0, y: 5, z: 0 }, // flipped (upward)
      bounds: { ...DIAL_BOUNDS, ceilingY },
      suspendDespawn: true,
    });
    const body: PhysicsBody = {
      position: { x: 0, y: 1, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      scale: 1,
      type: 'cube',
      grabbedBy: null,
      grounded: false,
    };
    let everRemoved = false;
    // 10 s of steps — it should rise and settle at the ceiling.
    for (let i = 0; i < 600; i++) {
      const res = stepBody(body, 1 / 60, params);
      if (res.removed) everRemoved = true;
    }
    expect(everRemoved).toBe(false);
    // The ceiling rest plane mirrors the floor: rest at ceilingY - restY(type).
    const restY = 0.15; // cube scale 1
    expect(body.position.y).toBeLessThanOrEqual(ceilingY);
    expect(body.position.y).toBeCloseTo(ceilingY - restY, 2);
    expect(body.grounded).toBe(true);
  });
});

describe('C6 — speedCap', () => {
  it('a big impulse is clamped so |v| ≤ speedCap after a step', () => {
    const params = mergeParams(DEFAULT_PARAMS, {
      bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
      suspendDespawn: true,
    });
    const body: PhysicsBody = {
      position: { x: 0, y: 10, z: 0 },
      velocity: { x: 100, y: 80, z: -60 }, // way over 30 m/s
      scale: 1,
      type: 'sphere',
      grabbedBy: null,
      grounded: false,
    };
    const res = stepBody(body, 1 / 60, params);
    void res;
    const speed = Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z);
    expect(speed).toBeLessThanOrEqual(DIAL_BOUNDS.speedCap + 1e-9);
  });
});

describe('C6 — soft-sphere containment', () => {
  it('bodies stay inside softSphereR through impulse + 5 s of steps', () => {
    const params = mergeParams(DEFAULT_PARAMS, {
      bounds: { softSphereR: DIAL_BOUNDS.softSphereR, speedCap: DIAL_BOUNDS.speedCap },
      suspendDespawn: true,
    });
    const rng = mulberry32(0x50f7);
    const bodies: PhysicsBody[] = [];
    for (let i = 0; i < 40; i++) {
      bodies.push({
        position: { x: (rng() - 0.5) * 10, y: 2 + rng() * 6, z: (rng() - 0.5) * 10 },
        velocity: { x: 0, y: 0, z: 0 },
        scale: 1,
        type: 'cube',
        grabbedBy: null,
        grounded: false,
      });
    }
    // A supernova-style radial ejection from origin.
    applyRadialImpulse(bodies, { x: 0, y: 4, z: 0 }, 200, 7);
    for (let step = 0; step < 300; step++) {
      for (const b of bodies) stepBody(b, 1 / 60, params);
    }
    // Every body remains within the soft sphere (small tolerance for the bounce step).
    for (const b of bodies) {
      const r = Math.hypot(b.position.x, b.position.y, b.position.z);
      expect(r).toBeLessThanOrEqual(DIAL_BOUNDS.softSphereR + 0.5);
    }
  });
});

describe('C6 — mergeParams', () => {
  it('field-wise overlay-wins', () => {
    const base: PhysicsParams = { gravity: { x: 0, y: -5, z: 0 }, timescale: 1, freeze: false };
    const overlay: Partial<PhysicsParams> = { gravity: { x: 0, y: 2, z: 0 }, freeze: true };
    const merged = mergeParams(base, overlay);
    expect(merged.gravity).toEqual({ x: 0, y: 2, z: 0 }); // overlay wins
    expect(merged.freeze).toBe(true); // overlay wins
    expect(merged.timescale).toBe(1); // base preserved (overlay absent)
  });

  it('identity on null/undefined overlay', () => {
    const base = DEFAULT_PARAMS;
    expect(mergeParams(base, null)).toEqual(base);
    expect(mergeParams(base, undefined)).toEqual(base);
  });

  it('does not mutate base', () => {
    const base: PhysicsParams = { gravity: { x: 0, y: -5, z: 0 }, suspendDespawn: false };
    const before = structuredClone(base);
    mergeParams(base, { suspendDespawn: true });
    expect(base).toEqual(before);
  });
});

describe('C6 — applyRadialImpulse (deterministic, seeded)', () => {
  it('pushes bodies radially away from the epicenter', () => {
    const bodies: PhysicsBody[] = [
      { position: { x: 5, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, scale: 1, type: 'cube', grabbedBy: null, grounded: false },
      { position: { x: -5, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, scale: 1, type: 'cube', grabbedBy: null, grounded: false },
    ];
    applyRadialImpulse(bodies, { x: 0, y: 0, z: 0 }, 10, 1);
    expect(bodies[0]!.velocity.x).toBeGreaterThan(0); // +x body pushed +x
    expect(bodies[1]!.velocity.x).toBeLessThan(0); // -x body pushed -x
  });

  it('is deterministic: same seed → identical velocity goldens', () => {
    function run(seed: number): PhysicsBody[] {
      const bodies: PhysicsBody[] = [];
      for (let i = 0; i < 5; i++) {
        bodies.push({
          position: { x: i - 2, y: 1, z: (i % 2) - 0.5 },
          velocity: { x: 0, y: 0, z: 0 },
          scale: 1,
          type: 'cube',
          grabbedBy: null,
          grounded: false,
        });
      }
      applyRadialImpulse(bodies, { x: 0, y: 0, z: 0 }, 12, seed);
      return bodies;
    }
    const a = run(99);
    const b = run(99);
    expect(a.map((x) => x.velocity)).toEqual(b.map((x) => x.velocity));
    // Different seed → different result (jitter is seeded, not constant).
    const c = run(100);
    expect(a.map((x) => x.velocity)).not.toEqual(c.map((x) => x.velocity));
  });

  it('does not move grabbed bodies', () => {
    const bodies: PhysicsBody[] = [
      { position: { x: 5, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, scale: 1, type: 'cube', grabbedBy: 'peer-1', grounded: false },
    ];
    applyRadialImpulse(bodies, { x: 0, y: 0, z: 0 }, 10, 1);
    expect(bodies[0]!.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('uses no Math.random (seeded goldens are stable across runs)', () => {
    const bodies: PhysicsBody[] = [
      { position: { x: 3, y: 2, z: 1 }, velocity: { x: 0, y: 0, z: 0 }, scale: 1, type: 'sphere', grabbedBy: null, grounded: false },
    ];
    applyRadialImpulse(bodies, { x: 0, y: 0, z: 0 }, 8, 42);
    const v = bodies[0]!.velocity;
    // Golden values are captured after implementation; here we assert finiteness
    // + radial sign (stable, seed-independent for a single on-axis-ish body).
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(Number.isFinite(v.z)).toBe(true);
    expect(v.x).toBeGreaterThan(0);
  });
});
