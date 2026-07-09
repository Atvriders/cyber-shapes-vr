// @vitest-environment jsdom
/**
 * xray.test.ts — F18 X-Ray Broadcast (C29, spec §7.18). State-guard coverage +
 * the CORE EQUIVALENCE proof.
 *
 * The `@vitest-environment jsdom` docblock forces jsdom for this file (the
 * `.test.ts` naming — not `.dom.test.ts` — is the brief's exact requested
 * filename; the directive gets a real `document` regardless of the filename-
 * based glob in vitest.config.ts).
 *
 * Covers the brief's Step-1 RED cases:
 *   • delay-shim EQUIVALENCE — the ghost (delayed) interpolator's rendered
 *     state at time t is EQUAL to the live interpolator's state at t − 300 ms
 *     on a synthetic stream, using the REAL frozen `createInterpolator` fed by
 *     the shared `DelayFifoSource` (the one place both may be imported
 *     together — shared/test/replay.test.ts stays client-import-free).
 *   • phase-guard — x-ray fired in PLAY auto-reverts on an OVERLOAD transition
 *     (generalized: any transition outside {PLAY, ATTRACT}).
 *   • state exclusion — refused while a replay is airing (at trigger time AND
 *     mid-flight).
 *   • ATTRACT precedence — x-ray fired during ATTRACT pauses ghost playback
 *     AND attract resumes on revert; the pre-existing ATTRACT state is NEVER
 *     itself a refusal/cancel reason.
 *
 * Post-review fold-ins (C29 fix):
 *   • the must-ship 5-meter chrome CSS actually exists (parses `index.html`'s
 *     `<style>` block — a regression here means the chrome renders unstyled).
 *   • a re-trigger never leaks a stale ghost frame from the prior activation.
 *   • a wall-clock (RAF-independent) revert safety net.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DelayFifoSource } from '@cyber-shapes/shared';
import type { ServerMsg } from '@cyber-shapes/shared';
import { createInterpolator, type StateSource, type StateFrame } from '../src/net/interpolation.js';
import {
  XrayController,
  XRAY_AUTO_REVERT_MS,
  XRAY_DOT_HISTORY,
  XRAY_HEADER,
  XRAY_BANNER_SERVER_TRUTH,
  XRAY_BANNER_WHAT_PLAYERS_SEE,
  XRAY_BANNER_GHOST,
} from '../src/stage/xray.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// A manual, immediate StateSource (mirrors interpolation.test.ts's helper) —
// the LIVE side of the equivalence proof.
// ---------------------------------------------------------------------------
function makeManualSource(): { source: StateSource; emit: (f: StateFrame) => void } {
  let cb: ((f: StateFrame) => void) | null = null;
  return {
    source: {
      onState(fn) {
        cb = fn;
        return () => {
          if (cb === fn) cb = null;
        };
      },
    },
    emit(f) {
      cb?.(f);
    },
  };
}

function stateMsg(
  serverTick: number,
  shapes: Array<{ id: string; p: { x: number; y: number; z: number } }>
): Extract<ServerMsg, { t: 'state' }> {
  return {
    t: 'state',
    seq: serverTick,
    serverTick,
    shapes: shapes.map((s) => ({ id: s.id, p: s.p, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } })),
  };
}

// ===========================================================================
// THE CORE EQUIVALENCE PROOF (spec §7.18 / the C0 frozen-interpolator seam).
// ===========================================================================

describe('C29 X-Ray — delay-shim equivalence (the FROZEN interpolator, unmodified)', () => {
  it('ghost.sample(t) === live.sample(t − 300ms) on a synthetic stream (a SECOND interpolator instance, never an extended one)', () => {
    const DELAY = 300;
    let clock = 0;
    const now = () => clock;

    // The LIVE path: the REAL createInterpolator, fed by an immediate source —
    // exactly what netClient.ts wires for "what players see".
    const { source: liveSource, emit } = makeManualSource();
    const liveInterp = createInterpolator({ source: liveSource, now });

    // The GHOST path: a SECOND, independent createInterpolator instance, fed by
    // the shared DelayFifoSource. Same `now`, same frozen factory — no new
    // params, no subclass, no monkey-patch. This IS the C29 architecture.
    const delay = new DelayFifoSource<StateFrame>(DELAY);
    const ghostInterp = createInterpolator({ source: delay as unknown as StateSource, now });

    // A synthetic trajectory, pushed to BOTH paths at identical wall times.
    const schedule = new Map<number, { x: number; y: number; z: number }>([
      [0, { x: 0, y: 0, z: 0 }],
      [133, { x: 5, y: 2, z: -1 }],
      [266, { x: 12, y: 4, z: -3 }],
      [399, { x: 20, y: 1, z: -6 }],
      [532, { x: 28, y: -3, z: -9 }],
    ]);

    // Step the clock in fine (1 ms) increments — like a render loop calling
    // `update(dtMs)` every frame — so DelayFifoSource emits EXACTLY at each
    // frame's due time (never a coarse catch-up batch that would collapse
    // several frames onto one `now()` stamp).
    for (clock = 0; clock <= 900; clock += 1) {
      const p = schedule.get(clock);
      if (p) {
        const frame: StateFrame = { shapes: [{ id: 'shape-1', p, r: { x: 0, y: 0, z: 0 } }] };
        emit(frame);
        delay.push(frame, clock);
      }
      delay.tick(clock);
    }

    for (const t of [200, 350, 450, 600, 700, 832, 900]) {
      const ghost = ghostInterp.sample('shape-1', t);
      const live = liveInterp.sample('shape-1', t - DELAY);
      expect(ghost).toEqual(live);
    }

    liveInterp.dispose();
    ghostInterp.dispose();
  });

  it('the ghost world is produced via the delay-FIFO SOURCE seam — createInterpolator itself takes no new parameters', () => {
    // Structural proof the frozen signature is untouched: createInterpolator's
    // options are exactly {source, now?} — passing a DelayFifoSource typechecks
    // as a plain StateSource with ZERO interpolator-side change.
    const delay = new DelayFifoSource<StateFrame>(300);
    const interp = createInterpolator({ source: delay as unknown as StateSource, now: () => 0 });
    expect(typeof interp.sample).toBe('function');
    expect(typeof interp.ingest).toBe('function');
    expect(typeof interp.dispose).toBe('function');
    interp.dispose();
  });
});

// ===========================================================================
// XrayController — state guards.
// ===========================================================================

describe('C29 X-Ray — phase guard (spec §7.18: phases PLAY/ATTRACT only)', () => {
  it('refuses to trigger outside PLAY/ATTRACT (e.g. LOBBY)', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('LOBBY');
    expect(ctrl.trigger()).toBe(false);
    expect(ctrl.active).toBe(false);
  });

  it('fires cleanly in PLAY', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(true);
    expect(ctrl.active).toBe(true);
  });

  it('PHASE-GUARD: x-ray fired in PLAY auto-reverts on a transition into OVERLOAD', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(true);
    ctrl.setPhase('OVERLOAD');
    expect(ctrl.active).toBe(false);
  });

  it('auto-reverts on a transition into FINALE too (never in the pacing table — every disallowed phase reverts)', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    ctrl.setPhase('FINALE');
    expect(ctrl.active).toBe(false);
  });

  it('auto-reverts on a transition into LOBBY/STATS/RESET as well (the full disallowed set, not just OVERLOAD/FINALE)', () => {
    for (const phase of ['LOBBY', 'STATS', 'RESET']) {
      const ctrl = new XrayController(document);
      ctrl.setPhase('PLAY');
      ctrl.trigger();
      ctrl.setPhase(phase);
      expect(ctrl.active, `phase=${phase}`).toBe(false);
    }
  });

  it('is idempotent — triggering while already active is a no-op that stays active', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(true);
    expect(ctrl.trigger()).toBe(true);
    expect(ctrl.active).toBe(true);
  });

  it('auto-reverts on the 60–90 s timer', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    ctrl.update(XRAY_AUTO_REVERT_MS - 1);
    expect(ctrl.active).toBe(true);
    ctrl.update(2);
    expect(ctrl.active).toBe(false);
  });
});

describe('C29 X-Ray — state exclusion (spec §7.18: refused while a replay is airing)', () => {
  it('refuses to trigger while a C21 replay is airing', () => {
    let airing = true;
    const ctrl = new XrayController(document, { isReplayAiring: () => airing });
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(false);
    expect(ctrl.active).toBe(false);
    airing = false;
    expect(ctrl.trigger()).toBe(true);
  });

  it('auto-cancels mid-flight when a replay STARTS airing (the C21-replay-starting case)', () => {
    let airing = false;
    const ctrl = new XrayController(document, { isReplayAiring: () => airing });
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(true);
    airing = true; // a replay just started
    ctrl.update(16);
    expect(ctrl.active).toBe(false);
  });
});

describe('C29 X-Ray — ATTRACT precedence (spec §7.18, verified)', () => {
  it('the pre-existing ATTRACT state is never itself a refusal reason (ATTRACT is an allowed phase)', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('ATTRACT');
    expect(ctrl.trigger()).toBe(true);
  });

  it('firing DURING ATTRACT pauses ghost/ballet playback; revert RESUMES it', () => {
    const ctrl = new XrayController(document);
    let paused = 0;
    let resumed = 0;
    ctrl.registerAttractHook({ pause: () => paused++, resume: () => resumed++ });
    ctrl.setPhase('ATTRACT');
    expect(ctrl.trigger()).toBe(true);
    expect(paused).toBe(1);
    expect(resumed).toBe(0);
    ctrl.revert();
    expect(resumed).toBe(1);
  });

  it('firing DURING ATTRACT and reverting via the auto-revert timer also resumes ghost playback', () => {
    const ctrl = new XrayController(document);
    let paused = 0;
    let resumed = 0;
    ctrl.registerAttractHook({ pause: () => paused++, resume: () => resumed++ });
    ctrl.setPhase('ATTRACT');
    ctrl.trigger();
    ctrl.update(XRAY_AUTO_REVERT_MS + 1);
    expect(ctrl.active).toBe(false);
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
  });

  it('entering ATTRACT WHILE already active (fired during PLAY) pauses ghosts WITHOUT reverting x-ray; leaving ATTRACT resumes them', () => {
    const ctrl = new XrayController(document);
    let paused = 0;
    let resumed = 0;
    ctrl.registerAttractHook({ pause: () => paused++, resume: () => resumed++ });
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    expect(ctrl.active).toBe(true);

    ctrl.setPhase('ATTRACT'); // the room went idle mid-inspection
    expect(ctrl.active).toBe(true); // NEVER auto-cancelled by entering ATTRACT
    expect(paused).toBe(1);
    expect(resumed).toBe(0);

    ctrl.setPhase('PLAY'); // a human woke the room
    expect(ctrl.active).toBe(true); // still running — PLAY is allowed too
    expect(resumed).toBe(1);
  });

  it('works correctly with NO attract hook registered (attach-if-landed — never required)', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('ATTRACT');
    expect(() => ctrl.trigger()).not.toThrow();
    expect(ctrl.active).toBe(true);
    expect(() => ctrl.revert()).not.toThrow();
  });
});

// ===========================================================================
// Toggle — the single entry point for BOTH the stage-LOCAL hotkey and the
// STAGE_XRAY director-console relay (spec §7.18).
// ===========================================================================

describe('C29 X-Ray — toggle() (the hotkey + console-relay entry point)', () => {
  it('toggles on then off', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    expect(ctrl.toggle()).toBe(true);
    expect(ctrl.active).toBe(true);
    expect(ctrl.toggle()).toBe(false);
    expect(ctrl.active).toBe(false);
  });

  it('toggle-on is refused outside the allowed phases (same guard as trigger())', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('LOBBY');
    expect(ctrl.toggle()).toBe(false);
    expect(ctrl.active).toBe(false);
  });
});

// ===========================================================================
// Split-truth data: raw "server truth" dots + the ghost world only warms up
// while active.
// ===========================================================================

describe('C29 X-Ray — split-truth data (server-truth dots + the ghost shim)', () => {
  it('serverTruthDots tracks a bounded, fading trail of raw tick-stamped positions', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    for (let i = 0; i < 20; i++) {
      t = i * 33;
      ctrl.ingestState(stateMsg(i, [{ id: 's1', p: { x: i, y: 0, z: 0 } }]));
    }
    const dots = ctrl.serverTruthDots('s1');
    expect(dots.length).toBe(XRAY_DOT_HISTORY);
    expect(dots[dots.length - 1].tick).toBe(19);
    expect(dots[dots.length - 1].p.x).toBe(19);
  });

  it('tracks dots even while inactive (always-on truth trail; the GHOST shim is what gates on active)', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.ingestState(stateMsg(0, [{ id: 's1', p: { x: 1, y: 0, z: 0 } }]));
    expect(ctrl.serverTruthDots('s1').length).toBe(1);
    expect(ctrl.active).toBe(false);
  });

  it('the ghost delay shim only receives frames while x-ray is ACTIVE (a clean window every activation)', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.ingestState(stateMsg(0, [{ id: 's1', p: { x: 1, y: 0, z: 0 } }]));
    // Not active yet — nothing fed the ghost world.
    expect(ctrl.ghostSample('s1', 10_000)).toBeNull();

    ctrl.setPhase('PLAY');
    ctrl.trigger();
    t = 100;
    ctrl.ingestState(stateMsg(1, [{ id: 's1', p: { x: 2, y: 0, z: 0 } }]));
    t = 500;
    ctrl.update(400); // flushes the delay-FIFO (frame due at 100+300=400 <= 500)
    expect(ctrl.ghostSample('s1', 500)).not.toBeNull();
  });
});

// ===========================================================================
// HUD strip — tick rate, snapshot age, interp buffer, "client-reported" RTT.
// ===========================================================================

describe('C29 X-Ray — HUD strip (spec §7.18)', () => {
  it('rtt chips reflect the roster verbatim, labeled client-reported', () => {
    const ctrl = new XrayController(document);
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    ctrl.ingestRoster([
      { id: 'p0', callsign: 'ALPHA', tier: 'resident', entryRoute: 'qr', joinedAt: 0, rttMs: 42 },
      { id: 'p1', callsign: 'BRAVO', tier: 'resident', entryRoute: 'qr', joinedAt: 0 },
    ] as Extract<ServerMsg, { t: 'roster' }>['entries']);
    const h = ctrl.hud();
    expect(h.rtt).toEqual([
      { id: 'p0', callsign: 'ALPHA', rttMs: 42 },
      { id: 'p1', callsign: 'BRAVO', rttMs: null },
    ]);
    const hudEl = ctrl.root.querySelector('[data-role="xray-hud"]') as HTMLElement;
    expect(hudEl.textContent).toContain('client-reported');
    expect(hudEl.textContent).toContain('ALPHA 42ms');
  });

  it('reports tick rate + snapshot age + a shim-layer interp-buffer diagnostic', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    t = 0;
    ctrl.ingestState(stateMsg(0, [{ id: 's1', p: { x: 0, y: 0, z: 0 } }]));
    t = 33; // ~30 Hz
    ctrl.ingestState(stateMsg(1, [{ id: 's1', p: { x: 1, y: 0, z: 0 } }]));
    const h = ctrl.hud();
    expect(h.tickRateHz).toBeGreaterThan(0);
    expect(h.interpBufferMs).toBe(300);
    t = 133;
    expect(ctrl.hud().snapshotAgeMs).toBeCloseTo(100, 0);
  });
});

// ===========================================================================
// Must-ship chrome (spec §7.18 acceptance criterion) + the §7.1 5-m exemption.
// ===========================================================================

describe('C29 X-Ray — must-ship chrome (5-meter banners; close-range HUD chips)', () => {
  it('ships the header + the three claim banners VERBATIM at 5-meter scale', () => {
    const ctrl = new XrayController(document);
    const q = (role: string) => ctrl.root.querySelector(`[data-role="${role}"]`) as HTMLElement;
    expect(q('xray-header').textContent).toBe(XRAY_HEADER);
    expect(q('xray-header').dataset['scale']).toBe('5m');
    expect(q('xray-banner-truth').textContent).toBe(XRAY_BANNER_SERVER_TRUTH);
    expect(q('xray-banner-sees').textContent).toBe(XRAY_BANNER_WHAT_PLAYERS_SEE);
    expect(q('xray-banner-ghost').textContent).toBe(XRAY_BANNER_GHOST);
    for (const role of ['xray-banner-truth', 'xray-banner-sees', 'xray-banner-ghost']) {
      expect(q(role).dataset['scale'], role).toBe('5m');
    }
  });

  it('the numeric HUD chips are close-range (the explicit §7.1 exemption) — never 5-meter', () => {
    const ctrl = new XrayController(document);
    const hud = ctrl.root.querySelector('[data-role="xray-hud"]') as HTMLElement;
    expect(hud.dataset['scale']).toBe('close-range');
  });

  it('the overlay root is hidden until triggered, shown while active, hidden again on revert', () => {
    const ctrl = new XrayController(document);
    expect(ctrl.root.hidden).toBe(true);
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    expect(ctrl.root.hidden).toBe(false);
    ctrl.revert();
    expect(ctrl.root.hidden).toBe(true);
  });
});

describe('C29 X-Ray — teardown', () => {
  it('dispose() detaches the root and stops the ghost interpolator (no throw)', () => {
    const parent = document.createElement('div');
    const ctrl = new XrayController(document);
    parent.appendChild(ctrl.root);
    expect(() => ctrl.dispose()).not.toThrow();
    expect(parent.contains(ctrl.root)).toBe(false);
  });
});

// ===========================================================================
// C29 fix (post-review) — MUST-FIX 1: the must-ship 5-meter chrome CSS.
//
// The controller ships the classes (`.stage-xray-header` etc.) + the
// `data-scale` hook, but the STYLESHEET is the ONLY place the actual 5-meter
// typography/positioning lives (index.html's <style> block — this app has no
// other stylesheet). The prior test suite (above) only asserted textContent/
// dataset, which is blind to a missing-CSS regression: this suite parses the
// real stylesheet text and would FAIL if the `.stage-xray*` rules were absent
// (as they were before this fix — unstyled ~16px body text, spec §7.18: "else
// it reads as a debug overlay left on").
// ===========================================================================

describe('C29 X-Ray — the chrome CSS is REAL (spec §7.18 must-ship acceptance)', () => {
  const html = readFileSync(resolve(HERE, '../src/stage/index.html'), 'utf8');
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  const css = styleMatch ? styleMatch[1] : '';

  /** Every non-nested `selector-list { body }` rule whose selector list contains `needle`. */
  function ruleBodiesFor(needle: string): string[] {
    const bodies: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(css)) !== null) {
      if (m[1].includes(needle)) bodies.push(m[2]);
    }
    return bodies;
  }

  it('the stage stylesheet was actually found and is non-trivial (a broken extraction would false-pass every case below)', () => {
    expect(css.length).toBeGreaterThan(500);
  });

  it.each([
    ['.stage-xray-header', 1.8],
    ['.stage-xray-truth', 1.8],
    ['.stage-xray-sees', 1.8],
    ['.stage-xray-ghost', 1.8],
  ])(
    '%s ships a REAL 5-meter-scale font-size rule (>= %svw) — not left at the unstyled 16px default',
    (selector, minVw) => {
      const bodies = ruleBodiesFor(selector);
      expect(bodies.length, `no CSS rule found for ${selector}`).toBeGreaterThan(0);
      const withFontSize = bodies.find((b) => /font-size\s*:/.test(b));
      expect(withFontSize, `no font-size declaration for ${selector}`).toBeTruthy();
      const sizeMatch = /font-size\s*:\s*([\d.]+)vw/.exec(withFontSize ?? '');
      expect(sizeMatch, `${selector}'s font-size is not a viewport-scaled (5-meter) value`).toBeTruthy();
      expect(Number(sizeMatch?.[1])).toBeGreaterThanOrEqual(minVw);
    }
  );

  it('the 5-meter chrome is explicitly positioned (absolute layout) — never left in normal document flow', () => {
    for (const selector of [
      '.stage-xray-header',
      '.stage-xray-truth',
      '.stage-xray-sees',
      '.stage-xray-ghost',
    ]) {
      const positioned = ruleBodiesFor(selector).some((b) => /position\s*:\s*absolute/.test(b));
      expect(positioned, `${selector} is not absolutely positioned`).toBe(true);
    }
  });

  it('SERVER TRUTH / WHAT PLAYERS SEE / +300ms sit in 3 DISTINCT horizontal slots — a coherent labeled layout, not one overlapping blob', () => {
    const anchored = ['.stage-xray-truth', '.stage-xray-sees', '.stage-xray-ghost'].map((sel) => {
      const body = ruleBodiesFor(sel).join('\n');
      return /left\s*:|right\s*:|transform\s*:/.test(body);
    });
    expect(anchored.every(Boolean), 'every split-truth banner must declare its own horizontal anchor').toBe(
      true
    );
  });

  it('the split-truth chrome declares its own vertical band (never relies on default static-flow placement, which is what caused the original overlap-with-.stage-banner bug)', () => {
    // Sanity: the pre-existing .stage-banner rule (top 4vh) must still exist —
    // this test is meaningless if the base stylesheet regressed too.
    expect(
      ruleBodiesFor('.stage-banner').some((b) => /top\s*:\s*4vh/.test(b)),
      'sanity: .stage-banner top:4vh rule must still exist'
    ).toBe(true);
    for (const selector of ['.stage-xray-header', '.stage-xray-truth', '.stage-xray-sees', '.stage-xray-ghost']) {
      const body = ruleBodiesFor(selector).join('\n');
      // Every x-ray chrome piece must declare ITS OWN top/height (never rely on
      // the default static-flow position, which is what caused the overlap bug).
      expect(/top\s*:|height\s*:/.test(body), `${selector} declares no explicit vertical placement`).toBe(true);
    }
  });

  it('the numeric HUD chip strip stays close-range scale — strictly smaller than the 5-meter banner floor', () => {
    const hudBody = ruleBodiesFor('.stage-xray-hud').find((b) => /font-size\s*:/.test(b));
    expect(hudBody, 'no .stage-xray-hud font-size rule found').toBeTruthy();
    const hudSize = Number(/font-size\s*:\s*([\d.]+)vw/.exec(hudBody ?? '')?.[1] ?? '0');
    expect(hudSize).toBeGreaterThan(0);
    expect(hudSize).toBeLessThan(1.8);
  });
});

// ===========================================================================
// C29 fix (post-review) — FOLD-IN: clean ghost window on re-trigger.
//
// `trigger()`/`revert()` already cleared the delay-FIFO QUEUE, but the
// persistent `ghostInterpolator`'s SnapshotBuffer retained whatever it last
// ingested — so a re-trigger's `ghostSample()` clamped to the PRIOR
// activation's stale pose instead of returning null until fresh data arrived.
// ===========================================================================

describe('C29 X-Ray — clean ghost window on re-trigger (fold-in)', () => {
  it('a revert -> re-trigger never leaks a stale ghost frame from the PRIOR activation', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    t = 100;
    ctrl.ingestState(stateMsg(0, [{ id: 's1', p: { x: 7, y: 0, z: 0 } }]));
    t = 500;
    ctrl.update(400); // flushes the delay-FIFO — the ghost buffer now holds a REAL sample
    expect(ctrl.ghostSample('s1', 500)).not.toBeNull(); // sanity: the ghost world DID warm up

    ctrl.revert();
    t = 600;
    expect(ctrl.trigger()).toBe(true); // a fresh activation, same PLAY phase

    // BEFORE any new state is fed THIS activation, the ghost world must be
    // completely empty — a stale sample from the prior activation must not
    // survive the revert/re-trigger boundary.
    expect(ctrl.ghostSample('s1', 600)).toBeNull();
  });
});

// ===========================================================================
// C29 fix (post-review) — FOLD-IN: RAF-independent revert safety.
//
// `remainingMs` only advances from `update(dtMs)`, which the stage RAF loop
// pumps. If that loop stalls (a backgrounded/throttled kiosk tab), the timer
// never fires and x-ray would stay stuck on. `ingestState`/`ingestRoster` are
// driven directly off the WS message stream — NOT the RAF loop — so a
// wall-clock check there catches a stalled-RAF window the frame timer alone
// would miss.
// ===========================================================================

describe('C29 X-Ray — RAF-independent revert safety (fold-in)', () => {
  it('reverts on a wall-clock timeout via a `state` tick even if update(dtMs) — the RAF-pumped timer — never fires again', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.setPhase('PLAY');
    expect(ctrl.trigger()).toBe(true);
    // Simulate a stalled RAF loop: update(dtMs) is never called again. Only
    // ingestState — fed directly by the server's `state` broadcast, ~30 Hz,
    // independent of the client's own render loop — ticks.
    t = XRAY_AUTO_REVERT_MS + 1;
    ctrl.ingestState(stateMsg(1, [{ id: 's1', p: { x: 0, y: 0, z: 0 } }]));
    expect(ctrl.active).toBe(false);
  });

  it('a `roster` tick also catches the wall-clock timeout (not just state)', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    t = XRAY_AUTO_REVERT_MS + 1;
    ctrl.ingestRoster([]);
    expect(ctrl.active).toBe(false);
  });

  it('does NOT revert early — a message tick still within the window leaves x-ray active', () => {
    let t = 0;
    const ctrl = new XrayController(document, { now: () => t });
    ctrl.setPhase('PLAY');
    ctrl.trigger();
    t = XRAY_AUTO_REVERT_MS - 1;
    ctrl.ingestState(stateMsg(1, [{ id: 's1', p: { x: 0, y: 0, z: 0 } }]));
    expect(ctrl.active).toBe(true);
  });
});
