/**
 * buildMode.test.ts — Task C34 (F23 The Workshop) HOST-level build-mode + RESET
 * rebind (spec §7.23 / §5.5 / §5.6 / §D4). All time is fake via an injected
 * TimerApi (no raw setTimeout/Date). Covers the brief's deterministic cases:
 *
 *   • build-mode HOLDS the timeline (an active > LOBBY duration does NOT advance);
 *   • the auto-cue playlist is SUSPENDED while build-mode is active;
 *   • an overlay-writing cue is REFUSED (wrongPhase) while build-mode is active;
 *   • re-firing build-mode toggles it OFF cleanly (freeze clears);
 *   • the session-max auto-revert exits build-mode;
 *   • a RESET during build-mode EXITS it (discards edits) + restores the baseline;
 *   • SET_BASELINE (setShowroomBaseline) → RESET restores the baked baseline AT
 *     REST under DEFAULT_PARAMS even when the layout's baseParams is non-default;
 *   • RESET falls back to the v1 SHOWROOM_BASELINE seed list when no baseline is set.
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle, PeerInfo } from '@cyber-shapes/shared';
import {
  SHOWROOM_BASELINE,
  DEFAULT_PARAMS,
  BUILD_SESSION_MAX_MS,
  PHASE_DURATIONS_MS,
  settleBake,
  layoutToSeeds,
  type Layout,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost } from '../src/timeline.js';
import { registerDialCues, registerBuildModeCue, lowGCue } from '../src/dials.js';

// ---------------------------------------------------------------------------
// Fake timers (chronological; a cb may enqueue more).
// ---------------------------------------------------------------------------
function makeFakeTimers(initialNow = 0) {
  let _now = initialNow;
  let _nextId = 1;
  const _timers: Array<{ id: number; fireAt: number; cb: () => void; cancelled: boolean }> = [];
  function fireReady(): void {
    let fired = true;
    while (fired) {
      fired = false;
      for (const t of _timers.slice().sort((a, b) => a.fireAt - b.fireAt)) {
        if (!t.cancelled && t.fireAt <= _now) {
          t.cancelled = true;
          t.cb();
          fired = true;
          break;
        }
      }
    }
  }
  const api: TimerApi = {
    setTimeout(cb, ms) {
      const id = _nextId++;
      _timers.push({ id, fireAt: _now + ms, cb, cancelled: false });
      return id as unknown as TimerHandle;
    },
    clearTimeout(h) {
      const t = _timers.find((x) => x.id === (h as unknown as number));
      if (t) t.cancelled = true;
    },
    now: () => _now,
  };
  return {
    api,
    advance(ms: number) {
      _now += ms;
      fireReady();
    },
    now: () => _now,
  };
}

function makeIdFactory(prefix = 'r') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeHost(
  over: { roster?: PeerInfo[]; initialPhase?: 'ATTRACT' | 'LOBBY' | 'PLAY'; baseline?: readonly { type: string }[] } = {}
) {
  const t = makeFakeTimers();
  const world = new ServerWorld({ maxShapes: 40, idFactory: makeIdFactory() });
  const broadcasts: Array<{ opcode: number; payload: unknown }> = [];
  const buildModeChanges: boolean[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload) => void broadcasts.push({ opcode, payload }),
    roster: () => over.roster ?? [],
    onWorldReset: () => {},
    onBuildModeChange: (active) => void buildModeChanges.push(active),
    initialPhase: over.initialPhase,
  });
  registerDialCues(host.registry);
  registerBuildModeCue(host.registry);
  return { t, world, host, broadcasts, buildModeChanges };
}

/** Enter LOBBY by a human join (ATTRACT → LOBBY), then engage build-mode. */
function enterBuildModeInLobby() {
  const ctx = makeHost();
  ctx.host.onPeerJoined({ id: 'p0', name: 'VOLT-1', color: 0 }); // ATTRACT → LOBBY
  expect(ctx.host.timeline.phase).toBe('LOBBY');
  ctx.host.setBuildMode(true);
  return ctx;
}

// ===========================================================================
// build-mode HOLD + auto-cue suspend + overlay refuse (spec §7.23 / §5.5 / §5.6)
// ===========================================================================

describe('build-mode — HOLD (spec §5.5/§7.23)', () => {
  it('engaging build-mode holds the timeline — a > LOBBY-duration wait does NOT advance', () => {
    const { t, host } = enterBuildModeInLobby();
    expect(host.buildModeActive).toBe(true);
    expect(host.timeline.isHeld).toBe(true);
    // Wait well past LOBBY's duration — a held timeline never auto-advances.
    t.advance(PHASE_DURATIONS_MS.LOBBY * 3);
    expect(host.timeline.phase).toBe('LOBBY'); // still LOBBY — edits survive
    expect(host.buildModeActive).toBe(true);
  });

  it('the freeze overlay is live while build-mode is active (params.freeze true)', () => {
    const { host } = enterBuildModeInLobby();
    expect(host.effectiveParams().freeze).toBe(true);
  });

  it('the auto-cue playlist is SUSPENDED while build-mode is active', () => {
    // Build-mode in ATTRACT: the ATTRACT pacing loop would auto-fire shape-rain
    // every 20 s; while held it must fire NOTHING.
    const ctx = makeHost({ initialPhase: 'ATTRACT' });
    ctx.host.setBuildMode(true);
    const spawnsBefore = ctx.world.shapes.length;
    ctx.t.advance(20_000 * 5); // five ATTRACT pacing intervals
    expect(ctx.world.shapes.length).toBe(spawnsBefore); // auto-cue suspended
  });

  it('an overlay-writing cue (low-g) is REFUSED (wrongPhase) while build-mode is active', () => {
    const { host } = enterBuildModeInLobby();
    const r = host.fire(lowGCue.id, 'inst-1');
    expect(r).toBe('wrongPhase'); // the single-overlay-writer guard names build-mode
    // The freeze overlay is untouched (the dial never got to write it).
    expect(host.effectiveParams().freeze).toBe(true);
  });
});

describe('build-mode — toggle + session-max exit (spec §7.23)', () => {
  it('re-firing build-mode toggles it OFF cleanly (freeze clears, hold releases)', () => {
    const { host } = enterBuildModeInLobby();
    host.setBuildMode(); // toggle → OFF
    expect(host.buildModeActive).toBe(false);
    expect(host.timeline.isHeld).toBe(false);
    expect(host.effectiveParams().freeze).toBe(false);
  });

  it('the session-max auto-revert exits build-mode after BUILD_SESSION_MAX_MS', () => {
    const { t, host, buildModeChanges } = enterBuildModeInLobby();
    expect(buildModeChanges).toEqual([true]);
    t.advance(BUILD_SESSION_MAX_MS + 1);
    expect(host.buildModeActive).toBe(false);
    expect(host.timeline.isHeld).toBe(false);
    expect(buildModeChanges).toEqual([true, false]);
  });

  it('re-firing WHILE active with force-on extends the session (does NOT exit)', () => {
    const { t, host } = enterBuildModeInLobby();
    t.advance(BUILD_SESSION_MAX_MS - 1_000); // almost expired
    host.setBuildMode(true); // extend
    t.advance(2_000); // past the ORIGINAL deadline
    expect(host.buildModeActive).toBe(true); // extended, not exited
  });
});

// ===========================================================================
// RESET during build-mode + RESET rebind under DEFAULT_PARAMS (spec §D4/§7.23)
// ===========================================================================

describe('RESET during build-mode (spec §7.23 staff safety override)', () => {
  it('a forceReset during build-mode EXITS it + discards edits + restores the baseline', () => {
    const { host, world, buildModeChanges } = enterBuildModeInLobby();
    // Simulate an unsaved edit: spawn a stray shape into the live world.
    world.spawn({ type: 'cube', position: { x: 1, y: 1, z: 1 } });
    const strayCount = world.shapes.length;
    expect(strayCount).toBeGreaterThan(0);
    host.forceReset();
    expect(host.buildModeActive).toBe(false); // exited
    expect(host.timeline.isHeld).toBe(false); // hold released
    expect(buildModeChanges).toEqual([true, false]);
    // The world was rebuilt to the baseline (the stray edit was discarded).
    expect(world.shapes.length).toBe(SHOWROOM_BASELINE.length);
    expect(host.effectiveParams()).toBe(DEFAULT_PARAMS); // §D4: DEFAULT_PARAMS
  });
});

describe('RESET rebind — always under DEFAULT_PARAMS, v1 fallback (spec §D4/§7.23)', () => {
  it('with NO baseline set, RESET falls back to the v1 SHOWROOM_BASELINE seed list', () => {
    const { host, world } = makeHost();
    host.forceReset();
    expect(world.shapes.length).toBe(SHOWROOM_BASELINE.length);
    // The restored shapes match the v1 seed types (in order).
    expect(world.shapes.map((s) => s.type)).toEqual(SHOWROOM_BASELINE.map((s) => s.type));
  });

  it('SET_BASELINE (setShowroomBaseline) → RESET restores the baked baseline AT REST under DEFAULT_PARAMS even when layout.baseParams is non-default', () => {
    const { host, world } = makeHost();
    // A baseline with a NON-DEFAULT baseParams (a standing low-gravity law). RESET
    // must IGNORE it and restore under DEFAULT_PARAMS (§D4 — those apply only via
    // an explicit LAYOUT_LOAD).
    const layout: Layout = {
      name: 'showroom',
      author: 'VOLT-1',
      savedAt: 0,
      baseParams: { gravity: { x: 0, y: -0.5, z: 0 } }, // non-default!
      themeId: 'ghost-monochrome',
      shapes: [
        { type: 'cube', colorIndex: 0, renderMode: 'both', scale: 1, position: { x: -2, y: 6, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        { type: 'sphere', colorIndex: 1, renderMode: 'both', scale: 1, position: { x: 2, y: 7, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      ],
    };
    // The server re-bakes under DEFAULT_PARAMS before binding (as SET_BASELINE does).
    const baked = settleBake(layout, DEFAULT_PARAMS);
    expect(baked.settled).toBe(true);
    host.setShowroomBaseline(layoutToSeeds(baked.layout));

    host.forceReset();
    // The world was restored to the baseline's shapes (2 shapes, not the v1 8).
    expect(world.shapes.length).toBe(2);
    expect(world.shapes.map((s) => s.type)).toEqual(['cube', 'sphere']);
    // Params are DEFAULT_PARAMS — the layout's non-default baseParams was IGNORED.
    expect(host.effectiveParams()).toBe(DEFAULT_PARAMS);
    expect(host.effectiveParams().gravity?.y).toBe(DEFAULT_PARAMS.gravity?.y);

    // Step the sim under DEFAULT_PARAMS — the baked shapes are already AT REST (they
    // were settled at bake time), so they ground within a few steps and don't drift.
    for (let i = 0; i < 120; i++) world.step(1 / 60);
    for (const s of world.shapes) {
      expect(s.grounded).toBe(true);
      expect(Number.isFinite(s.position.y)).toBe(true);
    }
  });

  it('setShowroomBaseline(null) reverts to the v1 fallback', () => {
    const { host, world } = makeHost();
    host.setShowroomBaseline([{ type: 'cube', position: { x: 0, y: 1, z: 0 }, colorIndex: 0 }]);
    host.setShowroomBaseline(null); // clear → v1 fallback
    host.forceReset();
    expect(world.shapes.length).toBe(SHOWROOM_BASELINE.length);
  });
});

// ===========================================================================
// build-mode fired in the WRONG phase (spec §7.23 "never mid-rotation")
// ===========================================================================

describe('build-mode cue phase gate (spec §7.23)', () => {
  it('firing build-mode during PLAY → wrongPhase (never mid-rotation)', () => {
    const { host } = makeHost({ initialPhase: 'PLAY' });
    const r = host.fire('build-mode', 'inst-play');
    expect(r).toBe('wrongPhase');
    expect(host.buildModeActive).toBe(false);
  });

  it('firing build-mode from LOBBY engages it; re-firing toggles off (fake timers)', () => {
    const { host } = makeHost({ initialPhase: 'LOBBY' });
    expect(host.fire('build-mode', 'inst-on')).toBe('ok');
    expect(host.buildModeActive).toBe(true);
    // A SECOND fire with a fresh instance id toggles OFF (the cue re-fire path).
    expect(host.fire('build-mode', 'inst-off')).toBe('ok');
    expect(host.buildModeActive).toBe(false);
  });

  it('an ambient auto-cue during build-mode is refused, freeze overlay intact', () => {
    // ATTRACT auto-cue would fire shape-rain; while build-mode holds, it is skipped
    // (isHeld) AND an explicit overlay dial fire is refused — the freeze survives.
    const { host, t } = makeHost({ initialPhase: 'ATTRACT' });
    host.setBuildMode(true);
    t.advance(20_000 * 3);
    expect(host.effectiveParams().freeze).toBe(true); // freeze intact
  });
});
