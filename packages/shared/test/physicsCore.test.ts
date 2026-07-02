import { describe, it, expect } from 'vitest';
import { BOUNCE, FRICTION, REMOVE_DISTANCE } from '@cyber-shapes/shared';
import { stepBody, type PhysicsBody } from '@cyber-shapes/shared';

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
