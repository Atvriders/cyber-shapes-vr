/**
 * daemons.test.ts — F17 Daemon Crew pure behavior chassis (spec §7.17, C28).
 *
 * TDD RED-first. The chassis is PURE + deterministic (injected RNG): no server
 * import, no Date/Math.random. These tests pin the load-bearing behavior rules —
 * fetch-and-return ONLY, catchable 3–6 m/s arcs, chest-height (never head) target,
 * and — the crux — GRAB DEFERENCE: a daemon never reaches for a shape a human hand
 * is near, and releases a carried shape the instant a human contests it.
 */

import { describe, it, expect } from 'vitest';
import {
  DAEMON_BEHAVIORS,
  DAEMON_MIN_THROW_SPEED,
  DAEMON_MAX_THROW_SPEED,
  DAEMON_CHEST_OFFSET_Y,
  DAEMON_GRAB_DEFER_RADIUS,
  chestTarget,
  shouldDeferGrab,
  nearestFetchableShape,
  computeReturnThrow,
  makeDaemonMind,
  stepDaemon,
  type DaemonShapeView,
  type DaemonHumanTarget,
  type ClientMsg,
} from '../src/index.js';

const rng = () => 0.5; // deterministic midpoint

function human(id: string, head = { x: 0, y: 1.6, z: 0 }, hands: { x: number; y: number; z: number }[] = []): DaemonHumanTarget {
  return { id, head, hands };
}
function loose(id: string, x: number, y = 1, z = 0): DaemonShapeView {
  return { id, position: { x, y, z }, grabbedBy: null };
}

describe('DAEMON_BEHAVIORS — fetch-and-return ONLY (spec §7.17)', () => {
  it('ships exactly one behavior; orbit-juggle + siege-defender are FLAGGED OFF', () => {
    expect(DAEMON_BEHAVIORS.fetchAndReturn).toBe(true);
    expect(DAEMON_BEHAVIORS.orbitJuggle).toBe(false);
    expect(DAEMON_BEHAVIORS.siegeDefender).toBe(false);
  });
});

describe('chestTarget — a chest offset BELOW the head, never AT the head', () => {
  it('is strictly below the head by DAEMON_CHEST_OFFSET_Y', () => {
    const head = { x: 2, y: 1.6, z: -1 };
    const chest = chestTarget(head);
    expect(chest.y).toBeCloseTo(head.y - DAEMON_CHEST_OFFSET_Y);
    expect(chest.y).toBeLessThan(head.y); // NEVER the head
    expect(chest.x).toBe(head.x);
    expect(chest.z).toBe(head.z);
  });
});

describe('computeReturnThrow — catchable 3–6 m/s arcing lob', () => {
  it('clamps speed into the catchable band and arcs upward', () => {
    const from = { x: 0, y: 1.2, z: 0 };
    const to = { x: 20, y: 1.2, z: 0 }; // far → would exceed cap without clamp
    const v = computeReturnThrow(from, to, rng);
    const speed = Math.hypot(v.x, v.z);
    expect(speed).toBeGreaterThanOrEqual(DAEMON_MIN_THROW_SPEED - 1e-6);
    expect(speed).toBeLessThanOrEqual(DAEMON_MAX_THROW_SPEED + 1e-6);
    expect(v.y).toBeGreaterThan(0); // an upward arc
  });
});

describe('shouldDeferGrab — grab deference (the human always wins, spec §7.17)', () => {
  it('defers when a human hand is within the deference radius', () => {
    const shape = loose('s1', 1, 1, 0);
    const near = human('h1', { x: 1, y: 1.6, z: 0 }, [{ x: 1, y: 1, z: 0 }]);
    expect(shouldDeferGrab(shape, [near], 'DMN-01')).toBe(true);
  });
  it('does NOT defer when the nearest human hand is beyond the radius', () => {
    const shape = loose('s1', 0, 1, 0);
    const far = human('h1', { x: 5, y: 1.6, z: 0 }, [{ x: 5, y: 1, z: 0 }]);
    expect(shouldDeferGrab(shape, [far], 'DMN-01')).toBe(false);
  });
  it('defers when a human already holds a pending claim on the shape', () => {
    const claimed: DaemonShapeView = { id: 's1', position: { x: 0, y: 1, z: 0 }, grabbedBy: 'p3' };
    expect(shouldDeferGrab(claimed, [], 'DMN-01')).toBe(true);
  });
  it('is NOT deferred by the daemon\'s OWN grab', () => {
    const mine: DaemonShapeView = { id: 's1', position: { x: 0, y: 1, z: 0 }, grabbedBy: 'DMN-01' };
    expect(shouldDeferGrab(mine, [], 'DMN-01')).toBe(false);
  });
});

describe('nearestFetchableShape — skips human-contested shapes', () => {
  it('picks the nearest LOOSE, uncontested shape', () => {
    const from = { x: 0, y: 1, z: 0 };
    const shapes = [loose('far', 5), loose('near', 1)];
    const pick = nearestFetchableShape(from, shapes, [], 'DMN-01');
    expect(pick?.id).toBe('near');
  });
  it('skips the nearest shape when a human hand is on it (deference)', () => {
    const from = { x: 0, y: 1, z: 0 };
    const contested = loose('near', 1, 1, 0);
    const free = loose('far', 4, 1, 0);
    const reaching = human('h1', { x: 1, y: 1.6, z: 0 }, [{ x: 1, y: 1, z: 0 }]);
    const pick = nearestFetchableShape(from, [contested, free], [reaching], 'DMN-01');
    expect(pick?.id).toBe('far'); // yielded the near one to the human
  });
});

describe('stepDaemon — fetch-and-return state machine', () => {
  function grabIntent(intents: ClientMsg[]): Extract<ClientMsg, { t: 'grab' }> | undefined {
    return intents.find((i): i is Extract<ClientMsg, { t: 'grab' }> => i.t === 'grab');
  }
  function releaseIntent(intents: ClientMsg[]): Extract<ClientMsg, { t: 'release' }> | undefined {
    return intents.find((i): i is Extract<ClientMsg, { t: 'release' }> => i.t === 'release');
  }

  it('idle → seeking when a loose shape exists; never grabs from far away', () => {
    const mind = makeDaemonMind('DMN-01', { x: 0, y: 1.4, z: 0 });
    const shapes = [loose('s1', 5, 1, 0)];
    const step = stepDaemon(mind, { shapes, humans: [human('h1')], dt: 0.05, rng });
    expect(step.mind.state).toBe('seeking');
    expect(step.mind.targetShapeId).toBe('s1');
    expect(grabIntent(step.intents)).toBeUndefined(); // too far to grab yet
  });

  it('grabs once within reach, then carries and lobs a catchable arc back', () => {
    // Daemon starts ON the shape so a single step reaches → grabs.
    const mind = makeDaemonMind('DMN-01', { x: 1, y: 1, z: 0 });
    const shapes: DaemonShapeView[] = [loose('s1', 1, 1, 0)];
    const humans = [human('h1', { x: -2, y: 1.6, z: 0 })];
    const s1 = stepDaemon(mind, { shapes, humans, dt: 0.05, rng });
    expect(s1.mind.state).toBe('seeking');
    // (idle→seeking happened; a second step from reach grabs)
    const s2 = stepDaemon(s1.mind, { shapes, humans, dt: 0.05, rng });
    expect(grabIntent(s2.intents)?.id).toBe('s1');
    expect(s2.mind.state).toBe('carrying');

    // Now the shape is held by the daemon; drive carrying until it lobs.
    shapes[0].grabbedBy = 'DMN-01';
    let mm = s2.mind;
    let lob: Extract<ClientMsg, { t: 'release' }> | undefined;
    for (let i = 0; i < 200 && !lob; i++) {
      const s = stepDaemon(mm, { shapes, humans, dt: 0.1, rng });
      // mirror the held transform into the world view so deference/nearest are coherent
      shapes[0].position = mm.pos;
      mm = s.mind;
      lob = releaseIntent(s.intents);
    }
    expect(lob).toBeDefined();
    const speed = Math.hypot(lob!.velocity.x, lob!.velocity.z);
    expect(speed).toBeGreaterThanOrEqual(DAEMON_MIN_THROW_SPEED - 1e-6);
    expect(speed).toBeLessThanOrEqual(DAEMON_MAX_THROW_SPEED + 1e-6);
    expect(lob!.velocity.y).toBeGreaterThan(0);
  });

  it('RELEASES a carried shape the instant a human hand contests it', () => {
    const mind = makeDaemonMind('DMN-01', { x: 0, y: 1, z: 0 });
    mind.state = 'carrying';
    mind.targetShapeId = 's1';
    const shapes: DaemonShapeView[] = [{ id: 's1', position: { x: 0, y: 1, z: 0 }, grabbedBy: 'DMN-01' }];
    // A human hand lands right on the carried shape.
    const contesting = human('h1', { x: 0, y: 1.6, z: 0 }, [{ x: 0, y: 1, z: 0 }]);
    const step = stepDaemon(mind, { shapes, humans: [contesting], dt: 0.1, rng });
    expect(releaseIntent(step.intents)?.id).toBe('s1');
    expect(step.mind.state).toBe('idle');
  });

  it('yields a sought shape if a human reaches for it mid-seek (contested → human)', () => {
    const mind = makeDaemonMind('DMN-01', { x: 0, y: 1, z: 0 });
    mind.state = 'seeking';
    mind.targetShapeId = 's1';
    const shapes = [loose('s1', 0.5, 1, 0)];
    const human1 = human('h1', { x: 0.5, y: 1.6, z: 0 }, [{ x: 0.5, y: 1, z: 0 }]);
    const step = stepDaemon(mind, { shapes, humans: [human1], dt: 0.1, rng });
    expect(step.mind.state).toBe('idle'); // yielded
    expect(step.intents.find((i) => i.t === 'grab')).toBeUndefined();
  });

  it('a daemon within grab-defer radius of a human never emits a grab (contested same-window)', () => {
    // Two peers reach for the same loose shape in the same window; deference means
    // the daemon emits NO grab — so the human's grab is the only claim (human wins).
    const mind = makeDaemonMind('DMN-01', { x: 0.5, y: 1, z: 0 });
    const shape = loose('s1', 0.5, 1, 0);
    const handOn = human('h1', { x: 0.5, y: 1.6, z: 0 }, [{ x: 0.5 + DAEMON_GRAB_DEFER_RADIUS / 2, y: 1, z: 0 }]);
    // idle step: should refuse to target the contested shape at all.
    const step = stepDaemon(mind, { shapes: [shape], humans: [handOn], dt: 0.1, rng });
    expect(step.intents.some((i) => i.t === 'grab')).toBe(false);
  });
});
