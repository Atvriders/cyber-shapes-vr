/**
 * replay.dom.test.ts — F11 Chrono Snap thin stage adapter (C21, spec §7.11).
 * jsdom. Covers the three-free, unit-testable surface of the stage replay flow:
 *   • the ~30 s ring ingests `state` frames + the ENV_STATE dial flag;
 *   • "replay last scored highlight" airs ONLY above the min-activity threshold;
 *   • the oversized "REPLAY // T-…s" chrome rides the highest-priority overlay slot;
 *   • the "RE-SIMULATED" flex line is §14-gated AND suppressed under an active dial;
 *   • replay entities are NAMESPACED (never a live shape id);
 *   • 6 s auto-return + a cooldown block a back-to-back re-fire.
 *
 * The 0.25× render + spring-orbit camera + PiP inset live in render.ts (manual-
 * verify); the pure resim/lerp + ring are proven in packages/shared/test/replay.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_PARAMS, DIAL_BOUNDS, mergeParams, SIM_DT, stepBody, isReplayId } from '@cyber-shapes/shared';
import type { ServerMsg, PhysicsBody } from '@cyber-shapes/shared';
import { StageOverlays } from '../src/stage/overlays.ts';
import { StageReplay, REPLAY_AUTO_RETURN_MS, REPLAY_COOLDOWN_MS } from '../src/stage/replay.ts';

// A tiny deterministic clock.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (dt: number) => { t += dt; } };
}

/** Build a recorded free-flight arc as a stream of `state` ServerMsgs @ 15 Hz. */
function arcStates(id: string, ticksSeen: number): { states: ServerMsg[]; wallStep: number } {
  const b: PhysicsBody = {
    position: { x: -2, y: 1.5, z: 0 },
    velocity: { x: 6, y: 5, z: 0 },
    scale: 1,
    type: 'icosahedron',
    grabbedBy: null,
    grounded: false,
  };
  const states: ServerMsg[] = [];
  for (let t = 0; t <= ticksSeen; t++) {
    if (t > 0) stepBody(b, SIM_DT, DEFAULT_PARAMS);
    if (t % 2 === 0) {
      states.push({
        t: 'state',
        seq: t,
        serverTick: t,
        shapes: [{ id, p: { ...b.position }, r: { x: 0, y: 0, z: 0 }, v: { ...b.velocity } }],
      });
    }
  }
  return { states, wallStep: 66 };
}

describe('StageReplay — ring ingest + highlight air', () => {
  let doc: Document;
  let overlays: StageOverlays;
  const clock = makeClock();

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument('t');
    overlays = new StageOverlays(doc, { flexLineGranted: true });
  });

  it('ingests state frames into the ~30 s ring', () => {
    const c2 = makeClock();
    const replay = new StageReplay({ overlays, now: c2.now });
    const { states, wallStep } = arcStates('s1', 20);
    // Each frame arrives at a later wall time (as on a real socket).
    for (const s of states) {
      replay.ingest(s);
      c2.advance(wallStep);
    }
    expect(replay.ringSpanMs()).toBeGreaterThan(0);
  });

  it('airs the last scored highlight (a hard throw) and shows the oversized REPLAY chrome', () => {
    const replay = new StageReplay({ overlays, now: clock.now });
    // A hard release → a THROW highlight above the min-activity floor.
    replay.ingest({ t: 'grab', id: 's1', peerId: null, pos: { x: 5, y: 1, z: 0 }, vel: { x: 12, y: 6, z: 0 } });
    const { states } = arcStates('s1', 20);
    for (const s of states) replay.ingest(s);

    const aired = replay.replayLastHighlight();
    expect(aired).toBe(true);
    expect(replay.isAiring()).toBe(true);
    // Oversized replay chrome on the HIGHEST-priority slot (replay > cue > …).
    expect(overlays.activeSlot()).toBe('replay');
    expect(overlays.bannerText()).toMatch(/REPLAY/);
    expect(overlays.bannerText()).toMatch(/T-/); // "REPLAY // T-4.2s" countdown
  });

  it('refuses to air an under-threshold (idle) window', () => {
    const replay = new StageReplay({ overlays, now: clock.now });
    // Only a gentle grab + tiny impact → below the min-activity floor.
    replay.ingest({ t: 'grab', id: 's1', peerId: 'p1' });
    replay.ingest({ t: 'state', seq: 1, serverTick: 1, shapes: [{ id: 's1', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, s: 1 }] });
    const aired = replay.replayLastHighlight();
    expect(aired).toBe(false);
    expect(replay.isAiring()).toBe(false);
  });
});

describe('StageReplay — the RE-SIMULATED flex line (§14 + dial suppression)', () => {
  let doc: Document;
  const clock = makeClock();
  beforeEach(() => { doc = document.implementation.createHTMLDocument('t'); });

  it('claims "RE-SIMULATED" for a free-flight, dial-free window WHEN the flex line is granted', () => {
    const overlays = new StageOverlays(doc, { flexLineGranted: true });
    const replay = new StageReplay({ overlays, now: clock.now });
    replay.ingest({ t: 'grab', id: 's1', peerId: null, pos: { x: 5, y: 1, z: 0 }, vel: { x: 12, y: 6, z: 0 } });
    for (const s of arcStates('s1', 20).states) replay.ingest(s);
    replay.replayLastHighlight();
    expect(replay.claimingResim()).toBe(true);
    expect(overlays.bannerText()).toMatch(/RE-?SIMULATED/i);
  });

  it('SUPPRESSES the resim line under an active dial (bullet-time), even when granted', () => {
    const overlays = new StageOverlays(doc, { flexLineGranted: true });
    const replay = new StageReplay({ overlays, now: clock.now });
    replay.ingest({ t: 'grab', id: 's1', peerId: null, pos: { x: 5, y: 1, z: 0 }, vel: { x: 12, y: 6, z: 0 } });
    // A bullet-time ENV_STATE marks the window dial-active.
    replay.ingest({
      t: 'env-state',
      serverTimestamp: 0,
      mode: 'BULLET TIME',
      params: mergeParams(DEFAULT_PARAMS, { timescale: 0.25, bounds: DIAL_BOUNDS, suspendDespawn: true }),
      endsAt: null,
    });
    for (const s of arcStates('s1', 20).states) replay.ingest(s);
    replay.replayLastHighlight();
    expect(replay.claimingResim()).toBe(false); // dial → no false claim
    expect(overlays.bannerText()).not.toMatch(/RE-?SIMULATED/i);
    expect(overlays.bannerText()).toMatch(/REPLAY/); // still airs (lerped)
  });

  it('never renders the resim line when the flex line is WITHHELD (§14)', () => {
    const overlays = new StageOverlays(doc, { flexLineGranted: false });
    const replay = new StageReplay({ overlays, now: clock.now });
    replay.ingest({ t: 'grab', id: 's1', peerId: null, pos: { x: 5, y: 1, z: 0 }, vel: { x: 12, y: 6, z: 0 } });
    for (const s of arcStates('s1', 20).states) replay.ingest(s);
    replay.replayLastHighlight();
    // Even though this IS a resim-eligible window, the ungranted line never renders.
    expect(overlays.bannerText()).not.toMatch(/RE-?SIMULATED/i);
  });
});

describe('StageReplay — namespacing, auto-return + cooldown', () => {
  let doc: Document;
  let overlays: StageOverlays;
  const clock = makeClock();
  beforeEach(() => {
    doc = document.implementation.createHTMLDocument('t');
    overlays = new StageOverlays(doc, { flexLineGranted: true });
  });

  function airOne(replay: StageReplay) {
    replay.ingest({ t: 'grab', id: 's1', peerId: null, pos: { x: 5, y: 1, z: 0 }, vel: { x: 12, y: 6, z: 0 } });
    for (const s of arcStates('s1', 20).states) replay.ingest(s);
    return replay.replayLastHighlight();
  }

  it('replay entity ids are NAMESPACED (never collide with the live shape id)', () => {
    const replay = new StageReplay({ overlays, now: clock.now });
    airOne(replay);
    const ids = replay.replayEntityIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(isReplayId(id)).toBe(true);
      expect(id).not.toBe('s1'); // never the LIVE id
    }
  });

  it('auto-returns after ~6 s and clears the replay chrome', () => {
    const replay = new StageReplay({ overlays, now: clock.now });
    expect(airOne(replay)).toBe(true);
    expect(replay.isAiring()).toBe(true);
    // Drive the flow past the auto-return window.
    replay.update(REPLAY_AUTO_RETURN_MS + 100);
    expect(replay.isAiring()).toBe(false);
    expect(overlays.activeSlot()).not.toBe('replay'); // chrome cleared
  });

  it('a cooldown blocks a back-to-back re-fire until it elapses', () => {
    const replay = new StageReplay({ overlays, now: clock.now });
    expect(airOne(replay)).toBe(true);
    replay.update(REPLAY_AUTO_RETURN_MS + 100); // finish + enter cooldown
    // Immediately re-firing is refused while cooling down.
    expect(airOne(replay)).toBe(false);
    // After the cooldown a fresh highlight airs again.
    replay.update(REPLAY_COOLDOWN_MS + 100);
    expect(airOne(replay)).toBe(true);
  });
});
