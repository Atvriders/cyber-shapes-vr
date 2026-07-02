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
import { MAX_SHAPES, SHAPE_TYPES, CYBER_COLORS, type Pose } from '@cyber-shapes/shared';
import { ShapeStore, type ShapeEvent } from './world.js';
import { updateShapeRender, applyRenderModeVisibility } from './shapes.js';
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
import { parseRoom, makeRoomId, roomUrl } from './net/roomLink.js';

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

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  scene.fog = new THREE.FogExp2(0x0a0020, 0.015);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 3);

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

  // Desktop orbit controls.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  // VR button.
  document.body.appendChild(VRButton.createButton(renderer));

  // --- Mode selection (B6) ------------------------------------------------
  // If the URL carries a /r/<id> room, auto-connect (server-authoritative, no
  // local seeding). Otherwise stay OFFLINE and seed 5 shapes as in Phase A.
  const room = parseRoom(location.href);
  if (room) {
    connectToRoom(room);
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
 */
function connectToRoom(room: string): void {
  if (netClient?.isConnected()) return;

  // Create (or reuse) the Avatars instance for this session.
  if (!avatars) {
    avatars = new Avatars(scene);
  }

  netClient = new NetClient(store, {
    getLocalPose,
    // B8: real avatar hooks — remote players get a neon head + 2 hands + nameplate.
    onPose: (id, pose) => {
      avatars!.updatePose(id, pose);
    },
    onPlayerJoin: (id, name, color) => {
      // PlayerInfo uses `color` as colorIndex (0..6)
      avatars!.upsert({ id, name, color });
    },
    onPlayerLeave: (id) => {
      avatars!.remove(id);
      // Audit #10: also tear down the departed peer's voice pipeline (decoder,
      // panner/gain chain, speaking timeout, jitter buffer) so it doesn't leak
      // and tick() no longer iterates it. Player ids are `p<senderId>`; the
      // numeric part is the voice senderId (see server connection.ts).
      const senderId = parseVoiceSenderId(id);
      if (senderId !== null) voice?.removePeer(senderId);
    },
    // onVoice is set by Voice.enable() — leave undefined here (Voice wires it).
    onRekey: (oldId, newId) => {
      // A locally-predicted spawn was confirmed by the server (temp id → canonical
      // id). Keep any tracked held id in sync so a spawned-then-grabbed shape stays
      // classified as locally held.
      rekeyHeldId(oldId, newId);
    },
  });

  const name = `player-${makeRoomId(String(Date.now()))}`;
  netClient.connect(wsUrl(), room, name, DEFAULT_COLOR_INDEX);

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
    for (const shape of store.shapes) {
      if (shape.grounded) shape.bobPhase += delta * 2;
      updateShapeRender(shape, delta);
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
