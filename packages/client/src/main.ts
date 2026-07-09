/**
 * main.ts — application entry point (A8; multiplayer modes wired in B6).
 *
 * Ties the Phase-A refactor together AND selects between two run modes:
 *
 *   - OFFLINE (single-player, not connected): UNCHANGED Phase-A path. A single
 *     ShapeStore owns every shape; we seed 5 shapes, run local physics, and the
 *     full per-shape render update (rotation + bob + visibility).
 *   - CONNECTED (server-driven): the server is authoritative. We do NOT seed and
 *     do NOT run local physics. Each frame, for each shape, chooseTransformSource
 *     decides whether its transform comes from the server snapshot ('remote') or
 *     from the local controller ('local', the one shape this client holds — we
 *     stream its 'held' pose up). Only renderMode visibility is applied locally;
 *     the server owns rotation/bob. Spawn/impact FX still fire via store.onEvent
 *     as inbound server events are applied.
 *
 * store.onEvent is the ONE cosmetic/HUD hook AND the network replication point:
 * it runs cosmetics first (local feedback), then forwards to netClient (which
 * skips server-applied events via its _applying guard).
 */

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  MAX_SHAPES,
  SHAPE_TYPES,
  CYBER_COLORS,
  TITAN_SCALE_MS,
  createClockSyncer,
  serverNow as toServerNow,
  type ClockSyncer,
  type Pose,
} from '@cyber-shapes/shared';
import { rigTransformForScale } from './net/titanRig.js';
import { ShapeStore, type ShapeEvent } from './world.js';
import { updateShapeRender, advanceShapeBob, applyRenderModeVisibility } from './shapes.js';
import { updatePhysics } from './physics.js';
import {
  initControllers,
  updateControllers,
  getHeldShapeIds,
  rekeyHeldId,
  onPtt,
  resetPtt,
} from './controllers.js';
import { Voice } from './voice/voice.js';
import { initEnvironment, updateEnvironment, updateHudShapeCount } from './environment.js';
import {
  initEffects,
  updateEffects,
  spawnBurstParticles,
  spawnImpactParticles,
  type EffectsHandle,
} from './effects.js';
import { initAudio, type AudioApi } from './audio.js';
import { NetClient, LOCAL_PEER_ID } from './net/netClient.js';
import { Avatars } from './net/avatars.js';
import { chooseTransformSourceMulti, isServerDriven } from './net/modeSelect.js';
import { parseRoom, makeRoomId, roomUrl, parseJoinSecret } from './net/roomLink.js';
import { CameraRig, type FollowTarget } from './desktop/cameras.js';
import { DesktopHud } from './desktop/hud.js';
import { PowersHandInput } from './powers/handInput.js';
import {
  keymapToIntent,
  makeKeymapState,
  type KeymapState,
  type DesktopIntent,
} from './desktop/input.js';
import { serverMsgToRoomEvent } from './events.js';
import { StageMixer } from './stage/mixer.js';
import { ResonoraSynth } from './music/synth.js';
import { MusicScheduler } from './music/musicScheduler.js';

// Local ownership tag — shared with controllers + netClient so locally-originated
// grabs are forwarded to the server and remote grabs are not echoed.
const LOCAL_ID = LOCAL_PEER_ID;

/** Interpolation delay: render remote shapes this far in the past for smoothness. */
const INTERP_DELAY_MS = 100;

/**
 * Default avatar color INDEX (0..CYBER_COLORS.length-1) for the local player.
 * This is a colorIndex (B8 expects an index, not a raw hex) — the join message's
 * `color` field is a player/avatar color identifier, not a THREE color value.
 * Avatars (B8) flesh out per-session picks.
 */
const DEFAULT_COLOR_INDEX = 0;

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let effects: EffectsHandle;
let audio: AudioApi;
let store: ShapeStore;
let netClient: NetClient | null = null;
let avatars: Avatars | null = null;
let voice: Voice | null = null;
let controllerGroups: THREE.Group[] = [];
let prevTime = 0;
/**
 * Task C22 (C3 clock sync): the client→server clock offset syncer. It fires
 * CLOCK_PING via netClient.sendClockPing on a ~10 s cadence and consumes each
 * CLOCK_PONG (onClockPong) to keep a smoothed offset. `serverNow` (passed into the
 * NetClient) = localNow + syncer.offsetMs, so outgoing grab/spawn `clientTimestamp`
 * are server-aligned. Falls back to local now (offset 0) until the first pong.
 */
let clockSyncer: ClockSyncer | null = null;
/**
 * Task C22 (F8 Resonora): the MUSIC receive → synth scheduler + its audio graph.
 * Built lazily once connected AND the app AudioContext exists (reusing the SAME
 * `audio.ctx` as voice — never a second context). The mixer routes the synth's
 * sub-bus to the shared destination at the §6.2 Resonora priority.
 */
let musicMixer: StageMixer | null = null;
let resonora: ResonoraSynth | null = null;
let musicScheduler: MusicScheduler | null = null;
/**
 * C17 (F7 Titan Protocol): the player RIG. The camera + both controller groups are
 * parented under it so scaling the rig scales the whole player about the FLOOR
 * point (spec §7.7 — "rig scale, not world scale"). At rig scale 1 the rig is the
 * IDENTITY transform, so rendering + OrbitControls are byte-identical to Phase B
 * (the parity anchor). The XR camera inherits the rig transform via three's
 * locomotion path (camera under the rig). The environment NEVER scales.
 */
let playerRig: THREE.Group;
/**
 * C17 titan rig-scale state. `titanTarget` is the scale we're easing TOWARD (1 =
 * normal / offline / connected-non-titan; 5 or 10 = titan). `titanStartMs`/
 * `titanStartScale` drive the 1.5 s ease. When target is 1 AND the live scale has
 * reached 1, the rig is left at exact identity (parity — no per-frame rig writes).
 */
let titanTarget = 1;
let titanStartMs = 0;
let titanStartScale = 1;
/** The live eased rig scale (1 when no titan is or has been active). */
let titanScale = 1;
/**
 * C11 freeze render-pause (Tier 1): true while the world is frozen (the effective
 * PhysicsParams.freeze via ENV_STATE). While set, the gameLoop SKIPS autonomous
 * rotation + bob advance so a frozen world is fully static (spec §5.6/§7.3). When
 * false, rendering is byte-identical to Phase B.
 */
let worldFrozen = false;

// ---------------------------------------------------------------------------
// C33 (F22 Desktop Command) — the desktop VIEW surface (spec §7.22).
//
// A first-class desktop resident: the 4-mode CameraRig, the DOM HUD, and the
// §7.22 keymap (LAYERED ON TOP of the AS-BUILT Phase A mouse path in
// controllers.ts — click-spawn / drag = grab/throw / C = recolor / V = render
// mode are NEVER rebound here). XR-INERT: the rig update() + keymap + HUD are all
// off while renderer.xr.isPresenting; the camera is restored to ORBIT on
// sessionstart. Constructed lazily in init() AFTER the camera + controls exist.
// ---------------------------------------------------------------------------
let cameraRig: CameraRig | null = null;
let desktopHud: DesktopHud | null = null;
/**
 * C32 (F21 Powers Lab, §7.21): the camera-tracked-hands → TELEKINESIS input seam.
 * Constructed in init() and attached on sessionstart; INERT off-XR and when no
 * hands are reported. Cut-safe (its own `powers/` module).
 */
let powersHands: PowersHandInput | null = null;
let keymapState: KeymapState;
/** FLY input accumulated between frames (WASD held-state + mouse-look deltas). */
const flyKeys = { forward: 0, back: 0, left: 0, right: 0, up: 0, down: 0, fast: false };
let flyYaw = 0;
let flyPitch = 0;
/** Desktop mute state (the §7.22 `M` toggle; drives voice.setMuted when connected). */
let desktopMuted = false;
/**
 * The desktop HUD roster (callsign per peer), built from welcome/join/leave. A plain
 * resident does not receive the director ROSTER (that carries rttMs — a director/
 * spectator surface); the HUD renders callsigns + a `resident` tier from this map.
 * A staff (ownerToken) desktop's richer `onRoster` overrides it (still NO rttMs).
 */
const desktopRoster = new Map<string, string>();

/** Rebuild the desktop HUD roster from the tracked peers (callsigns + tier only). */
function refreshDesktopRoster(): void {
  if (!desktopHud) return;
  const entries = [...desktopRoster.entries()].map(([id, callsign]) => ({
    id,
    callsign,
    tier: 'resident',
    entryRoute: 'desktop',
    joinedAt: 0,
  }));
  desktopHud.setRoster(entries);
}

// Reusable scratch objects for getListenerPose — this runs every render frame
// (72fps in VR), so allocating fresh Vector3/Quaternion per call would create
// steady GC pressure on Quest. THREE's getWorld* accept a target to fill in place.
const _lpPos = new THREE.Vector3();
const _lpFwd = new THREE.Vector3();
const _lpUp = new THREE.Vector3();
const _lpQuat = new THREE.Quaternion();
const _peerPos = new THREE.Vector3();

function colorFor(colorIndex: number): number {
  return CYBER_COLORS[colorIndex] ?? CYBER_COLORS[0];
}

/**
 * Parse the numeric voice senderId from a `p<N>` player id (audit #10). Returns
 * null if the id isn't of that form (so we never call removePeer with NaN).
 */
function parseVoiceSenderId(playerId: string): number | null {
  const m = /^p(\d+)$/.exec(playerId);
  return m ? Number(m[1]) : null;
}

function init(): void {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.xr.enabled = true;
  renderer.xr.setFoveation(1);
  document.body.appendChild(renderer.domElement);

  // Controls hint (#controls in index.html): stays fully readable ~20s via CSS,
  // but clears the instant the player starts interacting so it's never in the
  // way. First pointer/key input dismisses it; press ? for the full keymap.
  const controlsHint = document.getElementById('controls');
  if (controlsHint) {
    const dismissHint = (): void => {
      controlsHint.classList.add('dismissed');
      window.removeEventListener('pointerdown', dismissHint);
      window.removeEventListener('keydown', dismissHint);
    };
    window.addEventListener('pointerdown', dismissHint);
    window.addEventListener('keydown', dismissHint);
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  scene.fog = new THREE.FogExp2(0x0a0020, 0.015);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 3);

  // C17 (F7 Titan Protocol): the player RIG. The camera lives UNDER the rig so the
  // rig can scale the whole player about the floor point (spec §7.7). The rig starts
  // at the IDENTITY transform (scale 1, position origin), so the camera's world pose
  // is byte-identical to Phase B: `camera.position (0,1.6,3)` under an identity rig
  // is world (0,1.6,3), exactly as before. OrbitControls binds the camera and reads/
  // writes camera.position (rig-local) — identical while the rig is identity. In XR,
  // three's WebXR path applies the rig's world matrix to `renderer.xr.getCamera()`,
  // so the XR camera + controllers inherit the rig scale (the locomotion pattern).
  playerRig = new THREE.Group();
  playerRig.name = 'player-rig';
  scene.add(playerRig);
  playerRig.add(camera);

  initEnvironment(scene);
  effects = initEffects(renderer, scene, camera);
  audio = initAudio();

  // --- ShapeStore: the single lifecycle + mutation API. -------------------
  // onEvent is the ONE place cosmetics + HUD react to shape changes, AND the
  // network replication hook (fan-out below).
  let idCounter = 0;
  const idFactory = () => `${LOCAL_ID}:${idCounter++}`;

  store = new ShapeStore(scene, {
    maxShapes: MAX_SHAPES,
    idFactory,
    onEvent,
  });

  // Controllers (VR + desktop). Capture the controller groups for pose reporting.
  const controllerApi = initControllers(renderer, scene, store, camera, audio);
  controllerGroups = controllerApi.controllers;

  // C17: re-parent the controller groups UNDER the rig so a titan scale grows the
  // hands with the head (spec §7.7 — "camera + both controllers/grips" scale). At
  // rig scale 1 the controllers' world poses are unchanged (the rig is identity),
  // so Phase B input/pose reporting is byte-identical. `.add` moves each group from
  // the scene to the rig (Object3D.add removes from the prior parent first).
  for (const grp of controllerGroups) playerRig.add(grp);

  // Desktop orbit controls.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  // C33 (F22 Desktop Command): the desktop VIEW surface — the 4-mode CameraRig, the
  // DOM HUD, and the §7.22 keymap. Layered ON TOP of the Phase A mouse path (never
  // rebinds it). XR-inert (rig + HUD off in VR; camera restored on sessionstart).
  initDesktopCommand();

  // C32 (F21 Powers Lab, §7.21): the camera-tracked-hands → TELEKINESIS input seam.
  // The net sink forwards to the LIVE netClient (a no-op when offline). INERT until
  // a session reports hands (attachSession on sessionstart) — a controller session
  // never sends TK. Cut-safe: deleting `powers/` removes it with no other change.
  powersHands = new PowersHandInput({
    renderer,
    net: {
      sendTkHandsState: (a) => netClient?.sendTkHandsState(a),
      sendTkPull: (h, anc, d) => netClient?.sendTkPull(h, anc, d),
      sendTkRelease: (h, v) => netClient?.sendTkRelease(h, v),
    },
    makeVec3: () => new THREE.Vector3(),
  });

  // VR button. C32 (F21 Powers Lab, §7.21): request `hand-tracking` as an OPTIONAL
  // feature so the Quest camera-tracked hands become available for the telekinesis
  // exhibit. It is INERT when unused (a controller session ignores it) and cut-safe
  // — VRButton merges it into its optionalFeatures list; a headset without hand
  // tracking simply never reports hands, so the powers-lab cue never advertises.
  document.body.appendChild(
    VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] })
  );

  // --- Mode selection (B6) ------------------------------------------------
  // If the URL carries a /r/<id> room, auto-connect (server-authoritative, no
  // local seeding). Otherwise stay OFFLINE and seed 5 shapes as in Phase A.
  // Also extract the optional join secret from the `?k=<secret>` query param:
  // staff-distributed booth links carry the HMAC key so the VR client joins as
  // resident without requiring a separate UI.
  const room = parseRoom(location.href);
  if (room) {
    const joinSecret = parseJoinSecret(location.href) ?? undefined;
    connectToRoom(room, joinSecret);
  } else {
    seedOfflineShapes();
  }

  wireShareButton();

  renderer.setAnimationLoop(gameLoop);
  window.addEventListener('resize', onResize);

  // Overlay toggling on XR session boundaries.
  renderer.xr.addEventListener('sessionstart', () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = 'none';
    void audio.resume();
    // C33 (F22 Desktop Command) — Quest inertness (spec §7.22): hide the DOM HUD and
    // restore the CameraRig to a SANE default (ORBIT) so a desktop that had FLY/AUTO
    // active never carries a camera offset or overlay into the headset. The rig's
    // update() also early-returns while presenting; this guarantees the state, not
    // just the per-frame no-op.
    desktopHud?.setHidden(true);
    cameraRig?.onSessionStart();
    // C32 (F21 Powers Lab): attach the inputsourceschange listener now a session
    // exists — it reports TK_HANDS_STATE when camera-tracked hands appear. INERT
    // when the session has no hands (a controller session never reports).
    powersHands?.attachSession();
    // Reset PTT edge state so a press held across the previous session boundary
    // doesn't swallow the first rising edge of this session.
    resetPtt();
    // Enable voice from within the user gesture that entered VR.
    // The AudioContext is already unlocked by audio.resume().
    // Audit #12: this re-enables the SAME Voice instance on every entry (we no
    // longer null it on sessionend), so voice works after headset off/on cycles.
    // Audit #13: enable() may reject (encoder configure() throws) — catch it here
    // so it never becomes an unhandled rejection; voice simply degrades to off.
    if (voice) {
      voice.enable().catch((e: unknown) => {
        console.warn('[main] voice.enable() failed; continuing without voice:', e);
      });
    }
  });
  renderer.xr.addEventListener('sessionend', () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = '';
    // C33: restore the desktop HUD when leaving VR (the rig is already back in ORBIT
    // from the sessionstart guard — the Phase A default). XR-inertness is symmetric.
    desktopHud?.setHidden(false);
    // Clear PTT edge state on exit so a held button can't leak into re-entry.
    resetPtt();
    // Audit #12: DISABLE but do NOT null the Voice instance. The B10 disable()
    // is idempotent and sets _enabled=false + wires setOnVoice(null); the next
    // sessionstart re-runs voice.enable() on this same (re-usable) instance.
    voice?.disable();
  });

  // Dispose remote avatars on page unload (disconnecting from the room).
  window.addEventListener('beforeunload', () => {
    voice?.disable();
    avatars?.disposeAll();
    netClient?.disconnect();
    // C22: stop clock re-sampling + cancel any armed MUSIC note timers so nothing
    // fires after the socket is gone.
    clockSyncer?.stop();
    musicScheduler?.clear();
  });
}

/** Seed 5 shapes in a semicircle (single-player / offline only). */
function seedOfflineShapes(): void {
  for (let i = 0; i < 5; i++) {
    const angle = Math.PI / 4 + (Math.PI / 2) * (i / 4);
    const x = Math.cos(angle) * 1.5;
    const z = -2 + Math.sin(angle) * 0.5;
    const type = SHAPE_TYPES[i % SHAPE_TYPES.length];
    const colorIndex = i % CYBER_COLORS.length;
    const shape = store.spawn({ type, colorIndex });
    shape.group.position.set(x, 1.5, z);
  }
}

// ---------------------------------------------------------------------------
// C33 (F22 Desktop Command) — the desktop VIEW surface (spec §7.22)
// ---------------------------------------------------------------------------

/** A random shape type (for the §7.22 `T` spawn — mirrors controllers' randomType). */
function randomShapeType() {
  return SHAPE_TYPES[Math.floor(Math.random() * SHAPE_TYPES.length)];
}

/** Spawn a shape a couple metres in front of the desktop camera (the `T` intent). */
function desktopSpawnInFront(): void {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const p = new THREE.Vector3();
  camera.getWorldPosition(p);
  const pos = p.add(dir.multiplyScalar(2.5));
  const shape = store.spawn({ type: randomShapeType() });
  shape.group.position.copy(pos);
}

/** The FOLLOW target list: live remote residents (avatar heads). Wisps are not
 * rendered in the desktop client, so residents are the honest desktop target set. */
function desktopFollowTargets(): FollowTarget[] {
  if (!avatars) return [];
  const out: FollowTarget[] = [];
  const p = new THREE.Vector3();
  for (const id of avatars.ids()) {
    const head = scene.getObjectByName(`avatar-head-${id}`);
    if (!head) continue;
    head.getWorldPosition(p);
    out.push({ id, pos: { x: p.x, y: p.y, z: p.z } });
  }
  return out;
}

/** Build + wire the CameraRig, the DOM HUD, and the §7.22 keymap listeners. */
function initDesktopCommand(): void {
  keymapState = makeKeymapState();

  cameraRig = new CameraRig({
    renderer,
    camera,
    controls,
    followTargets: desktopFollowTargets,
    brain: { minShotMs: 2500, heatThreshold: 6 },
  });

  desktopHud = new DesktopHud(document, {
    onVoteCast: (option) => netClient?.sendVoteCast(option),
  });
  const overlay = document.getElementById('overlay');
  // The HUD is pointer-interactive (ballot buttons), so it must catch events even
  // though the ambient #overlay has pointer-events:none — the HUD sets its own.
  (overlay ?? document.body).appendChild(desktopHud.root);
  // Start hidden until we know we're NOT in XR (the sessionstart/end guards toggle
  // it); a desktop session shows it immediately after this frame's first tick.
  desktopHud.setHidden(renderer.xr.isPresenting);

  if (typeof window === 'undefined') return; // headless / test env

  // The §7.22 keymap. Edge-triggered; INERT while presenting (Quest inertness).
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (renderer.xr.isPresenting) return; // XR inertness — keymap is off in VR
    // Track FLY held-state for the WASD movement integrator (independent of the
    // edge-triggered command intents; these keys are NOT §7.22 command bindings).
    if (updateFlyKeyState(e.key, true)) {
      // A FLY movement key: consume so it never scrolls the page, but do not
      // classify it as a command intent.
      return;
    }
    const intent = keymapToIntent(e.key, keymapState);
    if (!intent) return;
    // Tab would move focus; a bound command key should not.
    if (e.key === 'Tab') e.preventDefault();
    applyDesktopIntent(intent);
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    updateFlyKeyState(e.key, false);
    const rel = keymapState.up(e.key);
    if (rel && rel.kind === 'ptt') voice?.setPtt(false); // PTT falling edge
  });

  // FLY mouse-look: pointer movement while in FLY mode rotates the facing. The
  // Phase A OrbitControls own the mouse in ORBIT (untouched); FLY reads raw deltas.
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (renderer.xr.isPresenting || !cameraRig || cameraRig.mode !== 'fly') return;
    // Only look while a button is held (drag-look), matching the §7.22 "RMB/drag look".
    if (e.buttons === 0) return;
    flyYaw += -e.movementX * 0.0025;
    flyPitch += -e.movementY * 0.0025;
  });
}

/**
 * Update the FLY WASD/space/shift held-state. Returns true iff `key` is a FLY
 * movement key (so the keydown handler can skip command classification for it).
 * These are deliberately SEPARATE from the §7.22 command bindings (which are
 * edge-triggered); FLY movement is a continuous held-state.
 */
function updateFlyKeyState(key: string, down: boolean): boolean {
  const k = key.length === 1 ? key.toLowerCase() : key;
  switch (k) {
    case 'w':
      flyKeys.forward = down ? 1 : 0;
      return true;
    case 's':
      flyKeys.back = down ? 1 : 0;
      return true;
    case 'a':
      flyKeys.left = down ? 1 : 0;
      return true;
    case 'd':
      flyKeys.right = down ? 1 : 0;
      return true;
    case 'e':
    case ' ':
      flyKeys.up = down ? 1 : 0;
      return true;
    case 'q':
      flyKeys.down = down ? 1 : 0;
      return true;
    case 'Shift':
      flyKeys.fast = down;
      return true;
    default:
      return false;
  }
}

/** Route one §7.22 desktop intent to its effect. As-built C/V flow through the
 * Phase A controllers.ts handler — this only handles the NET-NEW bindings. */
function applyDesktopIntent(intent: DesktopIntent): void {
  switch (intent.kind) {
    case 'spawn':
      // T — a net-new spawn ALONGSIDE the preserved click-spawn (Phase A).
      desktopSpawnInFront();
      break;
    case 'recolor':
    case 'rendermode':
      // AS-BUILT: C/V are handled by the Phase A controllers.ts keydown listener
      // on the last-touched shape. C33 NEVER rebinds them — this case is a no-op
      // so the pinned intent semantics stay documented without a second handler.
      break;
    case 'camera':
      cameraRig?.setMode(intent.mode);
      break;
    case 'followNext':
      cameraRig?.followNext();
      break;
    case 'ballot':
      desktopHud?.focusBallot();
      break;
    case 'ptt':
      voice?.setPtt(intent.pressed);
      break;
    case 'mute':
      desktopMuted = !desktopMuted;
      voice?.setMuted(desktopMuted);
      break;
    case 'help':
      desktopHud?.toggleHelp();
      break;
  }
}

// ---------------------------------------------------------------------------
// C17 (F7 Titan Protocol) — local rig scaling (spec §7.7)
// ---------------------------------------------------------------------------

/**
 * Begin easing the LOCAL rig toward `target` (1 = revert, 5 / 10 = titan) over
 * TITAN_SCALE_MS. Captures the current live scale as the ease start so a revert
 * mid-grow (or a re-titanize) is smooth. The actual per-frame apply is
 * updateTitanRig() below.
 */
function beginTitanScale(target: number): void {
  titanTarget = Number.isFinite(target) && target > 0 ? target : 1;
  titanStartScale = titanScale;
  titanStartMs = prevTime * 1000; // prevTime is seconds; ease math is in ms
}

/**
 * Ease the live rig scale toward the target and apply it to the rig, scaling ABOUT
 * THE FLOOR POINT (directly below the camera). While the live scale is exactly 1
 * AND the target is 1, the rig is left at the EXACT identity — no per-frame writes,
 * so the offline / connected-non-titan render + OrbitControls path is byte-identical
 * to Phase B (the rig-scale-1 parity guarantee). The environment never scales.
 */
function updateTitanRig(nowMs: number): void {
  // Ease from the captured start scale toward the target over TITAN_SCALE_MS. We
  // reuse the shared titanRigScale ease shape by mapping start→target onto its 1→T
  // curve, then blending: eased = start + (target-start)·f(t).
  const elapsed = nowMs - titanStartMs;
  if (titanStartScale === titanTarget) {
    titanScale = titanTarget;
  } else {
    // titanRigScale(elapsed, T) returns 1→T; normalize its progress f = (v-1)/(T-1)
    // when T>1, else derive progress from elapsed directly for a revert to 1.
    const t = Math.min(1, Math.max(0, elapsed / TITAN_SCALE_MS));
    const f = t * t * (3 - 2 * t); // smoothstep (same curve as shared titanRigScale)
    titanScale = titanStartScale + (titanTarget - titanStartScale) * f;
  }

  // Parity fast-path: identity rig when fully reverted. Only touch the rig when it
  // actually differs from identity (a non-titan session never enters the else).
  if (titanScale === 1) {
    if (playerRig.scale.x !== 1) playerRig.scale.setScalar(1);
    if (playerRig.position.lengthSq() !== 0) playerRig.position.set(0, 0, 0);
    return;
  }

  // The floor anchor is the head's RIG-LOCAL XZ — i.e. camera.position (its value
  // under an identity rig). Using the local XZ keeps the anchor STABLE across frames
  // as the rig scales (a world-XZ anchor would drift because it already includes the
  // rig transform), so the giant grows cleanly from where the player stands. In XR
  // the XR camera rides this same rig, so the head-relative floor point tracks it.
  const floorX = camera.position.x;
  const floorZ = camera.position.z;
  const rig = rigTransformForScale(titanScale, floorX, floorZ);
  playerRig.scale.setScalar(rig.scale);
  playerRig.position.set(rig.position.x, rig.position.y, rig.position.z);
}

// ---------------------------------------------------------------------------
// Networking (B6)
// ---------------------------------------------------------------------------

/** ws(s)://<host>/ws — same-origin WebSocket endpoint. */
function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/**
 * Construct a NetClient and connect to `room`. The server becomes authoritative:
 * the welcome message clears the local store and repopulates from the server
 * snapshot, so we must NOT have seeded (callers gate on parseRoom).
 *
 * @param joinSecret Optional HMAC join secret extracted from `?k=<secret>` in
 *   the room URL. Forwarded to the server so a booth-room client can join as
 *   resident. If absent, the server grants resident for dev/Phase-B rooms and
 *   downgrades to crowd for secret-configured booth rooms.
 */
function connectToRoom(room: string, joinSecret?: string): void {
  if (netClient?.isConnected()) return;

  // Create (or reuse) the Avatars instance for this session.
  if (!avatars) {
    avatars = new Avatars(scene);
  }

  netClient = new NetClient(store, {
    getLocalPose,
    // C22 (C3 clock sync): server-time estimate for outgoing lag-comp timestamps.
    // = localNow + smoothed offset; falls back to local now (offset 0) until the
    // first CLOCK_PONG lands. Gameplay is server-authoritative, so a pre-sync grab
    // still round-trips a coherent (local-time) anchor.
    serverNow: () => toServerNow(clockSyncer?.offsetMs ?? 0, performance.now()),
    // C22 (F8 Resonora): route decoded MUSIC (0x29) CLOCK/NOTE frames to the synth
    // scheduler (built below once the AudioContext exists). Safe no-op pre-audio.
    onMusic: (frame) => musicScheduler?.onFrame(frame),
    // C22 (C3 clock sync): feed each CLOCK_PONG to the offset syncer.
    onClockPong: (fields) => clockSyncer?.onPong(fields),
    // C22: start clock sync once the server welcome confirms the socket is joined
    // (the server answers CLOCK_PING for any tier). The syncer fires the first ping
    // immediately, then re-samples ~every 10 s (spec §5.3).
    // C22 (carry #1, laws-chip-on-join): the welcome's ADDITIVE baseParams field
    // is the room's STANDING law — paint the desktop laws chip from it immediately
    // on join, rather than leaving it at the inert default until the next
    // VOTE_RESULT (which may never arrive this session on a tie/no-vote re-open).
    onWelcome: (baseParams) => {
      clockSyncer?.start();
      desktopHud?.setBaseParams(baseParams ?? null);
    },
    // B8: real avatar hooks — remote players get a neon head + 2 hands + nameplate.
    onPose: (id, pose) => {
      avatars!.updatePose(id, pose);
    },
    onPlayerJoin: (id, name, color, synthetic) => {
      // PlayerInfo uses `color` as colorIndex (0..6). Task C28: a synthetic DAEMON
      // renders as a drone + DAEMON badge (§7.17).
      avatars!.upsert({ id, name, color, ...(synthetic ? { synthetic: true } : {}) });
      // C33: track the callsign for the desktop HUD roster + feed AUTO (JOIN_CRANE).
      desktopRoster.set(id, name);
      refreshDesktopRoster();
      // Task C28: a DAEMON join NEVER fires the JOIN_CRANE ceremony — it gets the
      // distinct "DMN-07 ONLINE" banner instead (onDaemonBanner). Skip feedAuto here.
      if (!synthetic) {
        cameraRig?.feedAuto(serverMsgToRoomEvent({ t: 'player-join', player: { id, name, color } }));
      }
    },
    onDaemonBanner: (callsign) => {
      // Task C28 (F17 Daemon Crew): surface the distinct "DMN-07 ONLINE" glitch banner
      // on the operator HUD — never the human join-crane (§7.17). Safe no-op in VR.
      desktopHud?.setCueBanner(`DMN // ${callsign} ONLINE`);
    },
    onPlayerLeave: (id) => {
      avatars!.remove(id);
      // Audit #10: also tear down the departed peer's voice pipeline (decoder,
      // panner/gain chain, speaking timeout, jitter buffer) so it doesn't leak
      // and tick() no longer iterates it. Player ids are `p<senderId>`; the
      // numeric part is the voice senderId (see server connection.ts).
      const senderId = parseVoiceSenderId(id);
      if (senderId !== null) voice?.removePeer(senderId);
      // C33: drop from the desktop roster + feed AUTO the leave (ordinary activity).
      desktopRoster.delete(id);
      refreshDesktopRoster();
      cameraRig?.feedAuto(serverMsgToRoomEvent({ t: 'player-leave', id }));
    },
    // onVoice is set by Voice.enable() — leave undefined here (Voice wires it).
    onRekey: (oldId, newId) => {
      // A locally-predicted spawn was confirmed by the server (temp id → canonical
      // id). Keep any tracked held id in sync so a spawned-then-grabbed shape stays
      // classified as locally held.
      rekeyHeldId(oldId, newId);
    },
    onEnvState: (env) => {
      // C11 freeze render-pause: the effective params carry the freeze flag. While
      // frozen the gameLoop skips autonomous rotation + bob (spec §5.6/§7.3).
      worldFrozen = env.params.freeze === true;
      // C33: mirror the big-screen cue banner (spec §7.22 "showpiece/cue banner
      // mirror") — the human `mode` label ("BULLET TIME ×0.25"). The laws chip is
      // NOT repainted from ENV_STATE: a transient dial overlay must never repaint
      // the STANDING elected law (§7.5) — only a VOTE_RESULT winner moves it.
      desktopHud?.setCueBanner(env.mode ?? '');
    },
    // C17 (F7 Titan Protocol): a PLAYER_SCALE broadcast. If it targets THIS client
    // we ease the LOCAL rig (camera + controllers) 1→scale about the floor point;
    // otherwise it scales the REMOTE avatar (presence playerScale). A non-titan
    // session never fires this, so the rig stays at exact identity (Phase B parity).
    onPlayerScale: (peerId, scale, durationMs, isSelf) => {
      if (isSelf) {
        beginTitanScale(scale);
      } else {
        avatars?.setPlayerScale(peerId, scale);
      }
    },
    // C33 (F22 Desktop Command): the DOM HUD surfaces. Residents receive PHASE_STATE
    // + VOTE broadcasts (§5.1 widen); the roster arrives only for a staff (ownerToken)
    // desktop. The HUD renders callsigns + tiers (NEVER rttMs — §5.1 footnote).
    onPhaseState: (phase, _endsAt, remainingMs) => {
      desktopHud?.setPhaseState({ phase, remainingMs });
    },
    onVote: (msg) => {
      desktopHud?.setVote(msg);
      // AUTO camera: a VOTE_RESULT is brain-relevant activity (the money-shot).
      cameraRig?.feedAuto(serverMsgToRoomEvent(msg));
    },
    onRoster: (entries) => {
      desktopHud?.setRoster(entries);
    },
  });

  const name = `player-${makeRoomId(String(Date.now()))}`;
  netClient.connect(wsUrl(), room, name, DEFAULT_COLOR_INDEX, joinSecret);

  // C22 (C3 clock sync): build the offset syncer. `sendPing` encodes + sends a
  // CLOCK_PING via the netClient (echoing the last measured RTT); `onPong` (wired
  // above) feeds each CLOCK_PONG back in. Started on `onWelcome`. Recreated per
  // connect so a reconnect gets a fresh sample window.
  clockSyncer = createClockSyncer({
    sendPing: (clientSendMs) => netClient?.sendClockPing(clientSendMs, clockSyncer?.rttMs ?? 0),
  });

  // C22 (F8 Resonora): build the MUSIC synth + scheduler on the SAME AudioContext
  // as voice (never a second one). The StageMixer routes the synth sub-bus →
  // audio.ctx.destination at the §6.2 Resonora priority; the scheduler fires each
  // NOTE on its server-aligned grid line (offset from the clock syncer) and is
  // GATED on the AudioContext being 'running' (the gesture unlock the app already
  // uses for voice) — a suspended/pre-gesture context schedules nothing.
  if (!musicScheduler && audio.ctx) {
    const ctx = audio.ctx;
    musicMixer = new StageMixer(ctx);
    resonora = new ResonoraSynth(ctx, musicMixer);
    musicScheduler = new MusicScheduler(resonora, {
      offsetMs: () => clockSyncer?.offsetMs ?? 0,
      isEnabled: () => ctx.state === 'running',
    });
  }

  // B10: Construct Voice orchestrator once connected.
  // voice.enable() is called from the XR sessionstart gesture (or pointerdown
  // on desktop — see the pointerdown listener above).
  // Audit #20: audio.ctx is null when AudioContext construction failed (no Web
  // Audio). Voice needs a real context for capture + spatialization, so skip it
  // entirely — the rest of the app (shapes, physics, avatars, pose sync) still
  // runs; only voice is unavailable.
  if (!voice && audio.ctx) {
    voice = new Voice(audio.ctx, netClient, avatars!, {
      getListenerPose: () => {
        const src: THREE.Object3D = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
        // Fill pre-allocated scratch in place (no per-frame allocation).
        src.getWorldPosition(_lpPos);
        src.getWorldDirection(_lpFwd);
        // Up vector: extract from quaternion.
        src.getWorldQuaternion(_lpQuat);
        _lpUp.set(0, 1, 0).applyQuaternion(_lpQuat);
        return {
          pos: { x: _lpPos.x, y: _lpPos.y, z: _lpPos.z },
          forward: { x: _lpFwd.x, y: _lpFwd.y, z: _lpFwd.z },
          up: { x: _lpUp.x, y: _lpUp.y, z: _lpUp.z },
        };
      },
      getPeerPosition: (playerId: string) => {
        // Get the avatar head position for this peer from the scene.
        const headMesh = scene.getObjectByName(`avatar-head-${playerId}`);
        if (!headMesh) return null;
        headMesh.getWorldPosition(_peerPos);
        return { x: _peerPos.x, y: _peerPos.y, z: _peerPos.z };
      },
    });

    // Wire PTT: thumbstick-click edge → voice.setPtt()
    onPtt((pressed) => voice?.setPtt(pressed));
  }
}

/**
 * Local head + hand pose for the server (throttled inside NetClient.sendPose).
 * In XR: head = XR camera world pose, hands = the two controller groups' world
 * poses. On desktop there are no tracked hands, so both are null and head falls
 * back to the desktop camera.
 */
function getLocalPose(): Pose {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();

  let headSource: THREE.Object3D = camera;
  if (renderer.xr.isPresenting) {
    headSource = renderer.xr.getCamera();
  }
  headSource.getWorldPosition(p);
  headSource.getWorldQuaternion(q);
  const head = { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };

  const hands: Array<{
    p: { x: number; y: number; z: number };
    q: { x: number; y: number; z: number; w: number };
  } | null> = [];
  if (renderer.xr.isPresenting) {
    for (let i = 0; i < 2; i++) {
      const grp = controllerGroups[i];
      if (!grp) {
        hands.push(null);
        continue;
      }
      const hp = new THREE.Vector3();
      const hq = new THREE.Quaternion();
      grp.getWorldPosition(hp);
      grp.getWorldQuaternion(hq);
      hands.push({
        p: { x: hp.x, y: hp.y, z: hp.z },
        q: { x: hq.x, y: hq.y, z: hq.z, w: hq.w },
      });
    }
  } else {
    hands.push(null, null);
  }

  return { head, hands };
}

// ---------------------------------------------------------------------------
// Share / Play together (B6)
// ---------------------------------------------------------------------------

/** Wire the "Share / Play together" overlay button, if present. */
function wireShareButton(): void {
  const btn = document.getElementById('shareBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    void onShareClick(btn);
  });
}

async function onShareClick(btn: HTMLButtonElement): Promise<void> {
  // Reuse the existing room if we're already in one; otherwise mint a fresh id
  // from a browser-side random/time seed (main.ts MAY use Date.now/Math.random).
  const existing = parseRoom(location.href);
  const id = existing ?? makeRoomId(`${Date.now()}-${Math.random()}`);
  const url = roomUrl(location.origin, id);

  // Reflect the room in the address bar without a full reload.
  if (!existing) {
    history.pushState({ room: id }, '', url);
  }

  // Connect (no-op if already connected to this room).
  connectToRoom(id);

  // Copy the shareable link to the clipboard (best-effort).
  try {
    await navigator.clipboard?.writeText(url);
    flashButton(btn, 'LINK COPIED');
  } catch {
    flashButton(btn, 'SHARE THIS URL');
  }
}

function flashButton(btn: HTMLButtonElement, msg: string): void {
  const prev = btn.textContent;
  btn.textContent = msg;
  window.setTimeout(() => {
    btn.textContent = prev;
  }, 2000);
}

// ---------------------------------------------------------------------------
// Store event fan-out — cosmetics FIRST, then network send (B6).
// ---------------------------------------------------------------------------

/** The single cosmetic/HUD reaction surface for store mutations, plus net fan-out. */
function onEvent(e: ShapeEvent): void {
  // 1) Local cosmetics + HUD (immediate feedback, mode-agnostic).
  switch (e.kind) {
    case 'spawn':
      audio.playSpawn();
      spawnBurstParticles(e.shape.group.position, colorFor(e.shape.colorIndex));
      updateHudShapeCount(store.shapes.length);
      break;
    case 'despawn':
      updateHudShapeCount(store.shapes.length);
      break;
    case 'grab':
      if (e.peerId !== null) audio.playGrab();
      else audio.playRelease();
      break;
    case 'color':
    case 'render':
    case 'scale':
      // No cosmetic needed — the store already applied the visual change.
      break;
  }

  // 2) Network replication. netClient skips server-applied events (_applying
  //    guard) and no-ops when disconnected, so this is safe in every mode.
  netClient?.onLocalStoreEvent(e);
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  effects.setSize(window.innerWidth, window.innerHeight);
}

function gameLoop(timestamp: number, frame: XRFrame | null): void {
  const time = timestamp / 1000;
  let delta = time - prevTime;
  if (delta > 0.05) delta = 0.05;
  prevTime = time;

  const connected = netClient?.isConnected() ?? false;
  // Audit #22: only hand transform authority to the server once the 'welcome'
  // snapshot has arrived. In the OPEN-before-welcome gap `serverDriven` is false,
  // so seeded/offline shapes keep running local physics instead of freezing.
  const serverDriven = isServerDriven(connected, netClient?.welcomeReceived() ?? false);

  if (!serverDriven) {
    // ---- OFFLINE (or connected-but-pre-welcome): Phase-A authoritative path. -
    // 1) Physics — impacts fire particles + audio.
    updatePhysics(delta, store, (shape, speed) => {
      spawnImpactParticles(shape.group.position, colorFor(shape.colorIndex));
      audio.playImpact(speed);
    });

    // 2) Per-shape render update (rotation/bob; skips rotation while grabbed).
    //    C11 freeze render-pause: while frozen, BOTH the bob advance and the
    //    autonomous rotation are gated (a frozen world is fully static — §5.6/§7.3).
    //    Un-frozen, this is byte-identical to Phase B.
    for (const shape of store.shapes) {
      advanceShapeBob(shape, delta, worldFrozen);
      updateShapeRender(shape, delta, worldFrozen);
    }
  } else {
    // ---- CONNECTED: server-driven. No local physics, no seeding. ----------
    const renderTime = timestamp - INTERP_DELAY_MS;
    // Audit #14: EVERY locally-held shape (one per hand + desktop drag) is
    // controller-driven and must be streamed up; a single first-held id would
    // freeze a second-hand-held shape server-side and teleport it for peers.
    const heldIds = new Set(getHeldShapeIds());

    for (const shape of store.shapes) {
      if (chooseTransformSourceMulti(shape.id, heldIds, true) === 'remote') {
        // Server owns the transform — sample the interpolated snapshot.
        const s = netClient!.sampleRemote(shape.id, renderTime);
        if (s) {
          shape.group.position.set(s.p.x, s.p.y, s.p.z);
          shape.group.rotation.set(s.r.x, s.r.y, s.r.z);
        }
      } else {
        // A shape this client holds (either hand / desktop drag): controllers
        // drive its transform; stream the held pose up (throttled in netClient).
        netClient!.sendHeld(
          shape.id,
          {
            x: shape.group.position.x,
            y: shape.group.position.y,
            z: shape.group.position.z,
          },
          {
            x: shape.group.rotation.x,
            y: shape.group.rotation.y,
            z: shape.group.rotation.z,
          }
        );
      }
      // Non-transform visuals still reflect local/remote renderMode changes.
      applyRenderModeVisibility(shape);
    }
  }

  // 3) Input — VR when a frame is present, desktop otherwise. SFX/burst for
  //    spawns and grabs are emitted through the store's onEvent (and fanned out
  //    to the network there).
  updateControllers(frame, delta, store, { audio });

  // 3b) Stream local head/hand pose (throttled inside netClient) when connected.
  if (connected) netClient!.sendPose();

  // 3b-tk) C32 (F21 Powers Lab, §7.21): stream TK_PULL from a pinching bare hand
  // (throttled inside the seam). INERT off-XR / when no hand is pinching; the seam
  // reads the palm-joint anchor + cone axis each XR frame (the owner/hardware path).
  if (connected && renderer.xr.isPresenting) powersHands?.update(timestamp);

  // 3c) Voice: update listener + peer positions + pop jitter buffers.
  //     Wrapped so a bad pose/audio value can never throw out of the render
  //     loop (audit #3 defence-in-depth — the spatializer/avatars already skip
  //     non-finite values, this is the last-resort guard for setAnimationLoop).
  if (connected && voice) {
    try {
      voice.tick(timestamp);
    } catch (e) {
      console.warn('[main] voice.tick threw (ignored to protect render loop):', e);
    }
  }

  // 3d) C17 (F7 Titan Protocol): ease the local rig toward its titan target and
  //     apply the scale-about-the-floor transform. A no-op (exact identity rig) in
  //     the offline / connected-non-titan case — Phase B render parity holds.
  updateTitanRig(timestamp);

  // 3e) C33 (F22 Desktop Command): advance the desktop CameraRig + HUD. BOTH are
  //     INERT while presenting (the rig.update() early-returns; the HUD is hidden
  //     by the sessionstart guard) — Quest inertness, spec §7.22. Off-XR, feed FLY
  //     input, step the active mode, and repaint the extrapolated HUD countdown.
  if (cameraRig) {
    cameraRig.setFlyInput({
      forward: flyKeys.forward - flyKeys.back,
      right: flyKeys.right - flyKeys.left,
      up: flyKeys.up - flyKeys.down,
      fast: flyKeys.fast,
      yaw: flyYaw,
      pitch: flyPitch,
    });
    // Consume the accumulated mouse-look deltas this frame.
    flyYaw = 0;
    flyPitch = 0;
    cameraRig.update(delta);
  }
  desktopHud?.tick();

  // 4) Effects + environment.
  updateEffects(delta);
  updateEnvironment(delta);

  // 5) Single render path.
  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  } else {
    controls.update();
    effects.renderFrame(); // bloom composer (non-VR)
  }
}

init();
