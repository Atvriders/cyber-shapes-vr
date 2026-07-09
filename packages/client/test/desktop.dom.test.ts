/**
 * desktop.dom.test.ts — Task C33 (F22 Desktop Command, spec §7.22).
 *
 * The Workshop's desktop VIEW: the complete §7.22 keymap (pure keybinding→intent),
 * the 4-mode CameraRig (ORBIT/FLY/FOLLOW/AUTO) + its XR inertness, and the DOM HUD
 * (phase countdown / laws chip / roster / ballot widget / help overlay).
 *
 * TWO HARD CONSTRAINTS this file pins:
 *   (a) the AS-BUILT Phase A desktop bindings are preserved VERBATIM — `C` recolor,
 *       `V` render mode, click-spawn / drag = grab/throw are NEVER rebound (C33 layers
 *       ON TOP). The keymap's `C`/`V` intents are the REGRESSION PIN here.
 *   (b) XR inertness — with a mocked `isPresenting: true`, `CameraRig.update()` is a
 *       no-op AND the HUD is hidden (the client has ONE entry, so this code loads in
 *       the headset too — spec §7.22 "Quest inertness").
 *
 * The keymap + camera state machine are PURE (Three/DOM-free where possible); the
 * HUD tests run under jsdom. The AUTO camera reuses the C9 StageBrain over the shared
 * `events.ts` mapping (the single-source extraction).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  keymapToIntent,
  makeKeymapState,
  type KeymapState,
  type DesktopIntent,
} from '../src/desktop/input.ts';
import { CameraRig, type CameraMode } from '../src/desktop/cameras.ts';
import { DesktopHud } from '../src/desktop/hud.ts';
import { serverMsgToRoomEvent } from '../src/events.ts';
import {
  electionReducer,
  openElection,
  type ElectionState,
} from '@cyber-shapes/shared';

// ===========================================================================
// keymapToIntent — the normative §7.22 keymap (pure, edge-triggered).
// ===========================================================================

describe('keymapToIntent — §7.22 normative keymap', () => {
  let state: KeymapState;
  beforeEach(() => {
    state = makeKeymapState();
  });

  it('T → spawn (net-new, ALONGSIDE the preserved click-spawn)', () => {
    expect(keymapToIntent('t', state)).toEqual<DesktopIntent>({ kind: 'spawn' });
    expect(keymapToIntent('T', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'spawn' });
  });

  it('C → recolor (AS-BUILT Phase A intent — REGRESSION PIN)', () => {
    expect(keymapToIntent('c', state)).toEqual<DesktopIntent>({ kind: 'recolor' });
    expect(keymapToIntent('C', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'recolor' });
  });

  it('V → render-mode (AS-BUILT Phase A intent — REGRESSION PIN)', () => {
    expect(keymapToIntent('v', state)).toEqual<DesktopIntent>({ kind: 'rendermode' });
    expect(keymapToIntent('V', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'rendermode' });
  });

  it('1–4 → the four camera modes', () => {
    expect(keymapToIntent('1', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'camera', mode: 'orbit' });
    expect(keymapToIntent('2', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'camera', mode: 'fly' });
    expect(keymapToIntent('3', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'camera', mode: 'follow' });
    expect(keymapToIntent('4', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'camera', mode: 'auto' });
  });

  it('Tab → follow-next', () => {
    expect(keymapToIntent('Tab', state)).toEqual<DesktopIntent>({ kind: 'followNext' });
  });

  it('B → ballot', () => {
    expect(keymapToIntent('b', state)).toEqual<DesktopIntent>({ kind: 'ballot' });
    expect(keymapToIntent('B', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'ballot' });
  });

  it('backtick → push-to-talk (press)', () => {
    expect(keymapToIntent('`', state)).toEqual<DesktopIntent>({ kind: 'ptt', pressed: true });
  });

  it('M → mute', () => {
    expect(keymapToIntent('m', state)).toEqual<DesktopIntent>({ kind: 'mute' });
    expect(keymapToIntent('M', makeKeymapState())).toEqual<DesktopIntent>({ kind: 'mute' });
  });

  it('? → help', () => {
    expect(keymapToIntent('?', state)).toEqual<DesktopIntent>({ kind: 'help' });
  });

  it('an unknown key → null', () => {
    expect(keymapToIntent('z', state)).toBeNull();
    expect(keymapToIntent('9', state)).toBeNull();
    expect(keymapToIntent('Enter', state)).toBeNull();
  });

  it('edge-triggered: a HELD key fires its intent only ONCE per press', () => {
    // First observation of the key = the edge → intent.
    expect(keymapToIntent('t', state)).toEqual<DesktopIntent>({ kind: 'spawn' });
    // Held (no keyup between): the same call returns null (already down).
    expect(keymapToIntent('t', state)).toBeNull();
    expect(keymapToIntent('t', state)).toBeNull();
  });

  it('a re-press after a keyup fires the intent again (edge re-armed)', () => {
    expect(keymapToIntent('t', state)).toEqual<DesktopIntent>({ kind: 'spawn' });
    expect(keymapToIntent('t', state)).toBeNull();
    // Release re-arms the edge.
    state.up('t');
    expect(keymapToIntent('t', state)).toEqual<DesktopIntent>({ kind: 'spawn' });
  });

  it('PTT is a HOLD: down = pressed:true, up = pressed:false (both edges)', () => {
    expect(keymapToIntent('`', state)).toEqual<DesktopIntent>({ kind: 'ptt', pressed: true });
    // Held: no repeat.
    expect(keymapToIntent('`', state)).toBeNull();
    // Release emits the falling edge.
    const rel = state.up('`');
    expect(rel).toEqual<DesktopIntent>({ kind: 'ptt', pressed: false });
  });
});

// ===========================================================================
// CameraRig — the 4-mode state machine + follow-cycle + AUTO + XR inertness.
// ===========================================================================

/** A minimal renderer stand-in exposing only the xr.isPresenting flag the rig reads. */
function fakeRenderer(isPresenting: boolean): { xr: { isPresenting: boolean } } {
  return { xr: { isPresenting } };
}

/** A stub camera exposing just the position/lookAt the rig writes (Three-free). */
function fakeCamera(): {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
  _look: { x: number; y: number; z: number };
} {
  const pos = {
    x: 0,
    y: 1.6,
    z: 3,
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };
  return {
    position: pos,
    _look: { x: 0, y: 0, z: 0 },
    lookAt(x: number, y: number, z: number) {
      this._look = { x, y, z };
    },
  };
}

describe('CameraRig — mode state machine', () => {
  it('defaults to ORBIT (the Phase A default)', () => {
    const rig = new CameraRig({ renderer: fakeRenderer(false), camera: fakeCamera() });
    expect(rig.mode).toBe<CameraMode>('orbit');
  });

  it('setMode transitions between all four modes', () => {
    const rig = new CameraRig({ renderer: fakeRenderer(false), camera: fakeCamera() });
    for (const m of ['fly', 'follow', 'auto', 'orbit'] as CameraMode[]) {
      rig.setMode(m);
      expect(rig.mode).toBe(m);
    }
  });

  it('ORBIT mode leaves OrbitControls enabled; FLY/FOLLOW/AUTO disable it', () => {
    let enabled = true;
    const rig = new CameraRig({
      renderer: fakeRenderer(false),
      camera: fakeCamera(),
      controls: { get enabled() { return enabled; }, set enabled(v: boolean) { enabled = v; }, update() {} },
    });
    rig.setMode('fly');
    expect(enabled).toBe(false);
    rig.setMode('orbit');
    expect(enabled).toBe(true);
    rig.setMode('auto');
    expect(enabled).toBe(false);
  });

  it('FOLLOW: followNext() cycles through the target list and WRAPS', () => {
    const targets = [
      { id: 'a', pos: { x: 1, y: 1, z: 1 } },
      { id: 'b', pos: { x: 2, y: 2, z: 2 } },
      { id: 'c', pos: { x: 3, y: 3, z: 3 } },
    ];
    const rig = new CameraRig({
      renderer: fakeRenderer(false),
      camera: fakeCamera(),
      followTargets: () => targets,
    });
    rig.setMode('follow');
    expect(rig.followTargetId).toBe('a');
    rig.followNext();
    expect(rig.followTargetId).toBe('b');
    rig.followNext();
    expect(rig.followTargetId).toBe('c');
    rig.followNext(); // wrap
    expect(rig.followTargetId).toBe('a');
  });

  it('FOLLOW with no targets is inert (followTargetId null, update no-op)', () => {
    const rig = new CameraRig({
      renderer: fakeRenderer(false),
      camera: fakeCamera(),
      followTargets: () => [],
    });
    rig.setMode('follow');
    expect(rig.followTargetId).toBeNull();
    expect(() => rig.update(0.016)).not.toThrow();
  });
});

describe('CameraRig — AUTO consumes a synthetic RoomEvent stream deterministically', () => {
  it('a high-velocity release drives the shared StageBrain to FOLLOW_THROW', () => {
    const rig = new CameraRig({
      renderer: fakeRenderer(false),
      camera: fakeCamera(),
      brain: { minShotMs: 2500, heatThreshold: 6 },
    });
    rig.setMode('auto');
    // Feed the SAME synthetic RoomEvent the C9 mapping would produce for a fast release.
    rig.feedAuto(serverMsgToRoomEvent({ t: 'grab', id: 's7', peerId: null, vel: { x: 12, y: 0, z: 0 } } as never));
    rig.update(0.016);
    expect(rig.currentShot?.kind).toBe('FOLLOW_THROW');
    expect(rig.currentShot?.targetId).toBe('s7');
  });

  it('a join event drives JOIN_CRANE (deterministic — same stream, same shot)', () => {
    const mk = () => {
      const r = new CameraRig({
        renderer: fakeRenderer(false),
        camera: fakeCamera(),
        brain: { minShotMs: 2500, heatThreshold: 6 },
      });
      r.setMode('auto');
      r.feedAuto(serverMsgToRoomEvent({ t: 'player-join', player: { id: 'p9' } } as never));
      r.update(0.016);
      return r.currentShot?.kind;
    };
    expect(mk()).toBe('JOIN_CRANE');
    expect(mk()).toBe('JOIN_CRANE'); // determinism
  });
});

describe('CameraRig — XR inertness (spec §7.22 Quest inertness)', () => {
  it('update() is a NO-OP while renderer.xr.isPresenting', () => {
    const cam = fakeCamera();
    const rig = new CameraRig({ renderer: fakeRenderer(true), camera: cam });
    rig.setMode('fly');
    // Simulate a held-forward key that FLY would integrate.
    rig.setFlyInput({ forward: 1, right: 0, up: 0, fast: false, yaw: 0, pitch: 0 });
    const before = { ...cam.position };
    rig.update(0.5);
    expect(cam.position.x).toBe(before.x);
    expect(cam.position.y).toBe(before.y);
    expect(cam.position.z).toBe(before.z);
  });

  it('FLY update() DOES move the camera when NOT presenting (proves the no-op is XR-gated)', () => {
    const cam = fakeCamera();
    const rig = new CameraRig({ renderer: fakeRenderer(false), camera: cam });
    rig.setMode('fly');
    rig.setFlyInput({ forward: 1, right: 0, up: 0, fast: false, yaw: 0, pitch: 0 });
    const before = { ...cam.position };
    rig.update(0.5);
    const moved =
      cam.position.x !== before.x || cam.position.y !== before.y || cam.position.z !== before.z;
    expect(moved).toBe(true);
  });

  it('onSessionStart restores a SANE default (ORBIT) so VR is never left in FLY/AUTO', () => {
    const rig = new CameraRig({ renderer: fakeRenderer(true), camera: fakeCamera() });
    rig.setMode('auto');
    rig.onSessionStart();
    expect(rig.mode).toBe('orbit');
  });
});

// ===========================================================================
// DesktopHud — countdown extrapolation, laws chip, roster (NO rttMs), ballot.
// ===========================================================================

describe('DesktopHud (jsdom)', () => {
  let hud: DesktopHud;
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    hud?.dispose();
    root.remove();
  });

  it('mounts a HUD overlay into the host element', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    expect(root.querySelector('[data-role="desktop-hud"]')).toBeTruthy();
  });

  it('countdown EXTRAPOLATES from PHASE_STATE.remainingMs with no drift', () => {
    let clock = 10_000;
    hud = new DesktopHud(document, { onVoteCast: () => {}, now: () => clock });
    root.appendChild(hud.root);
    // A phase-state snapshot arrives at t=10s saying 30s remain.
    hud.setPhaseState({ phase: 'PLAY', remainingMs: 30_000 });
    // 12 seconds of wall-clock elapse with NO new phase-state (only the clock moves).
    clock = 22_000;
    hud.tick();
    const el = hud.root.querySelector('[data-role="countdown"]') as HTMLElement;
    // 30s − 12s = 18s remaining (extrapolated from remainingMs, drift-proof).
    expect(el.dataset['seconds']).toBe('18');
    expect(hud.root.querySelector('[data-role="phase"]')?.textContent).toContain('PLAY');
  });

  it('countdown clamps at 0 (never negative)', () => {
    let clock = 0;
    hud = new DesktopHud(document, { onVoteCast: () => {}, now: () => clock });
    hud.setPhaseState({ phase: 'OVERLOAD', remainingMs: 5_000 });
    clock = 99_000;
    hud.tick();
    const el = hud.root.querySelector('[data-role="countdown"]') as HTMLElement;
    expect(el.dataset['seconds']).toBe('0');
  });

  it('laws chip reflects a baseParams change (from ENV_STATE base)', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    const chip = () => hud.root.querySelector('[data-role="laws"]') as HTMLElement;
    // Default inert base → NORMAL PHYSICS.
    hud.setBaseParams(null);
    expect(chip().textContent).toContain('NORMAL');
    // A low-gravity elected law → the chip repaints.
    hud.setBaseParams({ gravity: { x: 0, y: -1, z: 0 } });
    expect(chip().textContent).toContain('LOW GRAVITY');
  });

  it('roster panel renders callsigns + tiers and NEVER shows rttMs (§5.1 footnote)', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    hud.setRoster([
      { id: 'p1', callsign: 'VOLT-17', tier: 'resident', entryRoute: 'headset', joinedAt: 0, rttMs: 42 },
      { id: 'p2', callsign: 'NEON-3', tier: 'spectator', entryRoute: 'stage', joinedAt: 0 },
    ]);
    const roster = hud.root.querySelector('[data-role="roster"]') as HTMLElement;
    expect(roster.textContent).toContain('VOLT-17');
    expect(roster.textContent).toContain('RESIDENT');
    expect(roster.textContent).toContain('NEON-3');
    // The rttMs value must NEVER be rendered on the desktop HUD (director/spectator surface).
    expect(roster.textContent).not.toContain('42');
    expect(roster.innerHTML.toLowerCase()).not.toContain('rtt');
  });

  it('ballot widget renders VOTE_OPEN options and emits ONE switchable VOTE_CAST', () => {
    const casts: string[] = [];
    hud = new DesktopHud(document, { onVoteCast: (opt) => casts.push(opt) });
    root.appendChild(hud.root);
    hud.setVote({ kind: 0 /* OPEN */, options: ['low-g', 'gravity-flip'] });
    const opts = hud.root.querySelectorAll('[data-role="vote-option"]');
    expect(opts.length).toBe(2);
    (opts[0] as HTMLButtonElement).click();
    expect(casts).toEqual(['low-g']);
    // Switch: a second tap replaces the choice (switchable, one vote).
    (opts[1] as HTMLButtonElement).click();
    expect(casts).toEqual(['low-g', 'gravity-flip']);
    // The widget marks only ONE option as mine (the latest).
    expect((opts[0] as HTMLElement).dataset['mine']).toBe('false');
    expect((opts[1] as HTMLElement).dataset['mine']).toBe('true');
  });

  it('a VOTE_RESULT closes the live ballot and updates the laws chip', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    hud.setVote({ kind: 0, options: ['low-g', 'gravity-flip'] });
    expect(hud.root.querySelector('[data-role="vote-widget"]')?.hasAttribute('hidden')).toBe(false);
    hud.setVote({ kind: 3 /* RESULT */, winner: 'low-g' });
    expect(hud.root.querySelector('[data-role="vote-widget"]')?.hasAttribute('hidden')).toBe(true);
    expect((hud.root.querySelector('[data-role="laws"]') as HTMLElement).textContent).toContain('LOW GRAVITY');
  });

  it('showpiece/cue banner mirror renders the cue text', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    hud.setCueBanner('BULLET TIME ×0.25');
    expect((hud.root.querySelector('[data-role="cue-banner"]') as HTMLElement).textContent).toContain('BULLET TIME');
    hud.setCueBanner('');
    expect((hud.root.querySelector('[data-role="cue-banner"]') as HTMLElement).textContent).toBe('');
  });

  it('? help overlay renders the FULL keymap and toggles', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    const help = hud.root.querySelector('[data-role="help"]') as HTMLElement;
    expect(help.hasAttribute('hidden')).toBe(true);
    hud.toggleHelp();
    expect(help.hasAttribute('hidden')).toBe(false);
    // The full keymap: every §7.22 binding label is present.
    const txt = help.textContent ?? '';
    for (const label of ['T', 'C', 'V', 'Tab', 'B', 'M', '?']) {
      expect(txt).toContain(label);
    }
    hud.toggleHelp();
    expect(help.hasAttribute('hidden')).toBe(true);
  });

  it('setHidden(true) hides the whole HUD (the XR-inertness surface)', () => {
    hud = new DesktopHud(document, { onVoteCast: () => {} });
    root.appendChild(hud.root);
    hud.setHidden(true);
    expect(hud.root.hasAttribute('hidden')).toBe(true);
    hud.setHidden(false);
    expect(hud.root.hasAttribute('hidden')).toBe(false);
  });
});

// ===========================================================================
// Harness — a resident VOTE_CAST reaches the C15 reducer (one switchable vote
// per peerId). The HUD emits an option; the host keys it on the resident peerId.
// ===========================================================================

describe('resident VOTE_CAST → C15 reducer (one switchable vote per peerId)', () => {
  it('the HUD ballot tap → a vote-cast → the reducer keyed on the resident peerId', () => {
    // The election host at the server keys residents on peerId (§5.1 voterKey).
    let state: ElectionState = openElection({ options: ['low-g', 'gravity-flip'], nowMs: 0 });
    const peerId = 'p1';

    let sentOption: string | null = null;
    const hud = new DesktopHud(document, { onVoteCast: (opt) => (sentOption = opt) });
    hud.setVote({ kind: 0, options: ['low-g', 'gravity-flip'] });
    const opts = hud.root.querySelectorAll('[data-role="vote-option"]');

    // The resident taps low-g → the HUD emits the option → the host applies it
    // keyed on peerId (the desktop resident's voterKey).
    (opts[0] as HTMLButtonElement).click();
    expect(sentOption).toBe('low-g');
    state = electionReducer(state, { type: 'CAST', token: peerId, option: sentOption!, nowMs: 10 });
    expect(state.tally['low-g']).toBe(1);
    expect(state.voterCount).toBe(1);

    // The resident SWITCHES to gravity-flip → still ONE vote (per peerId).
    (opts[1] as HTMLButtonElement).click();
    expect(sentOption).toBe('gravity-flip');
    state = electionReducer(state, { type: 'CAST', token: peerId, option: sentOption!, nowMs: 20 });
    expect(state.tally['low-g']).toBe(0);
    expect(state.tally['gravity-flip']).toBe(1);
    expect(state.voterCount).toBe(1); // still one voter — switchable, never double-counts

    hud.dispose();
  });
});

// ===========================================================================
// events.ts — the single-source serverMsgToRoomEvent (extracted from C9 stage).
// ===========================================================================

describe('events.ts — serverMsgToRoomEvent (single-source, shared by stage + desktop)', () => {
  it('a high-velocity release maps to a `release` RoomEvent with the |vel| speed', () => {
    const ev = serverMsgToRoomEvent({ t: 'grab', id: 's1', peerId: null, vel: { x: 3, y: 4, z: 0 } } as never);
    expect(ev).toEqual({ kind: 'release', id: 's1', peerId: '', speed: 5 });
  });
  it('a join maps to a `join` RoomEvent', () => {
    expect(serverMsgToRoomEvent({ t: 'player-join', player: { id: 'p2' } } as never)).toEqual({
      kind: 'join',
      peerId: 'p2',
    });
  });
  it('an irrelevant message maps to null', () => {
    expect(serverMsgToRoomEvent({ t: 'pose', id: 'p1', pose: {} } as never)).toBeNull();
  });
});
