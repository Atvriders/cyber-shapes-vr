/**
 * controllers.ts — VR + desktop input, routed entirely through ShapeStore (A8).
 *
 * Migrated from controllers.js. Every mutation now goes through ShapeStore
 * (spawn / setGrab / setColor / setRenderMode / setScale) — no direct field
 * mutation, no legacy `grabbed` boolean, no compat shims. Setting grabbedBy via
 * store.setGrab is what fixes the A6 "grabbed shapes never skip rotation/physics"
 * gap: updateShapeRender + stepBody both key off grabbedBy.
 *
 * The file splits into three layers:
 *   1. PURE helpers (buttonEdge, intentForButtons) — Three/DOM-free, unit-tested.
 *   2. VR path (updateControllers with an XRFrame) — reads the gamepad, maps to
 *      intents, applies them through the store.
 *   3. Desktop path (mouse + keyboard) — a raycaster so desktop is genuinely
 *      interactive (click empty space = spawn, click+drag a shape = grab/throw,
 *      keys c = color, v = mode on the last-touched shape).
 */

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { SHAPE_TYPES, cycleColorIndex, cycleRenderMode, clampScale } from '@cyber-shapes/shared';
import type { ShapeStore, ClientShape } from './world.js';
import type { AudioApi } from './audio.js';
import { LOCAL_PEER_ID } from './net/netClient.js';

// The local owner id for grabs. This sentinel (shared with netClient) lets the
// store's onEvent fan-out distinguish locally-originated grabs (which must be
// forwarded to the server) from server-applied remote grabs (B6).
const LOCAL_ID = LOCAL_PEER_ID;

// ===========================================================================
// PURE helpers — Three/DOM-free, unit-tested in test/controllers.test.ts.
// ===========================================================================

/** Rising-edge detector: true only on the false→true transition (once per press). */
export function buttonEdge(prev: boolean, curr: boolean): boolean {
  return curr && !prev;
}

/**
 * Returns true when the pointer moved less than `epsilon` NDC units between
 * press and release — i.e. it was a click, not a drag.
 *
 * Both `press` and `release` are THREE.Vector2 in Normalised Device Coordinates
 * ([-1,1] each axis), so 5 client-pixels on a 1024-wide canvas ≈ 0.01 NDC.
 * Default epsilon of 0.01 (~5px on a 1024-wide canvas) matches the spec.
 */
export function isClick(
  press: { x: number; y: number },
  release: { x: number; y: number },
  epsilon = 0.01
): boolean {
  const dx = release.x - press.x;
  const dy = release.y - press.y;
  return dx * dx + dy * dy <= epsilon * epsilon;
}

/** A single frame's edge/axis snapshot for one controller. */
export interface ButtonSnapshot {
  trigger: { prev: boolean; curr: boolean };
  grip: { prev: boolean; curr: boolean };
  aButton: { prev: boolean; curr: boolean };
  bButton: { prev: boolean; curr: boolean };
  /** Thumbstick Y axis, [-1, 1]. */
  stickY: number;
}

/** The one action a controller frame maps to (highest-priority edge wins). */
export type Intent = 'grab' | 'release' | 'spawn' | 'color' | 'mode' | 'scale' | 'none';

/** Ignore stick noise below this magnitude. */
const STICK_DEADZONE = 0.15;

/**
 * Map a controller snapshot to exactly one Intent.
 *
 * Priority: grab > release > spawn > color > mode > scale > none. Grab/release
 * fire only on the grip edge (rising = grab, falling = release), so a held grip
 * produces 'none' — the caller keeps the shape stuck to the controller via
 * heldId, not via a per-frame intent.
 */
export function intentForButtons(s: ButtonSnapshot): Intent {
  if (buttonEdge(s.grip.prev, s.grip.curr)) return 'grab';
  if (buttonEdge(s.grip.curr, s.grip.prev)) return 'release'; // falling edge of grip
  if (buttonEdge(s.trigger.prev, s.trigger.curr)) return 'spawn';
  if (buttonEdge(s.aButton.prev, s.aButton.curr)) return 'color';
  if (buttonEdge(s.bButton.prev, s.bButton.curr)) return 'mode';
  if (Math.abs(s.stickY) > STICK_DEADZONE) return 'scale';
  return 'none';
}

// ===========================================================================
// Shared helpers (Three, but store-only mutations)
// ===========================================================================

function randomType() {
  return SHAPE_TYPES[Math.floor(Math.random() * SHAPE_TYPES.length)];
}

/** Nearest un-grabbed shape within `maxDist` metres of `pos`, or null. */
function findNearestShape(
  pos: THREE.Vector3,
  store: ShapeStore,
  maxDist = 0.5
): ClientShape | null {
  let nearest: ClientShape | null = null;
  let nearestDist = maxDist;
  for (const shape of store.shapes) {
    if (shape.grabbedBy !== null) continue;
    const dist = pos.distanceTo(shape.group.position);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = shape;
    }
  }
  return nearest;
}

/** Spawn through the store at `pos`, positioning the new group there. */
function spawnAt(store: ShapeStore, pos: THREE.Vector3): ClientShape {
  const shape = store.spawn({ type: randomType() });
  shape.group.position.copy(pos);
  return shape;
}

/** Write a throw velocity (plain {x,y,z}) from a THREE.Vector3, scaled. */
function applyThrow(shape: ClientShape, worldVel: THREE.Vector3, factor: number): void {
  shape.velocity.x = worldVel.x * factor;
  shape.velocity.y = worldVel.y * factor;
  shape.velocity.z = worldVel.z * factor;
  shape.grounded = false;
}

// ===========================================================================
// PTT (push-to-talk) state
// thumbstick-click = buttons[3] — unused by existing controls
// ===========================================================================

/** Registered PTT callback: called on press (true) and release (false). */
let _pttCallback: ((pressed: boolean) => void) | null = null;

/** Last known PTT button state (for edge detection). */
let _prevPtt = false;

/**
 * Register a callback for PTT (thumbstick-click) edge events.
 * Called with `true` on press, `false` on release.
 * Only one callback is supported at a time.
 */
export function onPtt(cb: ((pressed: boolean) => void) | null): void {
  _pttCallback = cb;
}

/**
 * Reset the PTT edge-detection state (call on XR session start/end).
 *
 * Without this, if the user exits VR with the thumbstick-click held, `_prevPtt`
 * stays true; on re-entry the false→true rising edge is never observed and PTT
 * silently breaks (the press is swallowed). Resetting on the session boundary
 * guarantees the next real press produces a rising edge.
 */
export function resetPtt(): void {
  _prevPtt = false;
}

// ===========================================================================
// Controller (VR) state
// ===========================================================================

interface ControllerState {
  controller: THREE.Group;
  grip: THREE.Group;
  ray: THREE.Line;
  heldId: string | null;
  prevPosition: THREE.Vector3;
  velocity: THREE.Vector3;
  prev: { trigger: boolean; grip: boolean; aButton: boolean; bButton: boolean };
}

const controllerStates: ControllerState[] = [];

// ===========================================================================
// Desktop (mouse + keyboard) state
// ===========================================================================

interface DesktopState {
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  camera: THREE.Camera | null;
  domElement: HTMLElement | null;
  heldId: string | null;
  lastTouchedId: string | null;
  /** Plane the held shape is dragged along (parallel to view, through the shape). */
  dragPlane: THREE.Plane;
  /** Position of the held shape last frame, for throw velocity. */
  prevDragPos: THREE.Vector3;
  dragVelocity: THREE.Vector3;
  pressPointer: THREE.Vector2;
  pressedShapeId: string | null;
  isPointerDown: boolean;
}

let desktop: DesktopState | null = null;

// ===========================================================================
// initControllers
// ===========================================================================

export interface ControllerApi {
  /** The XR controller groups (for tests / external inspection). */
  controllers: THREE.Group[];
}

/**
 * Set up the two XR controllers (models, rays) and, on the desktop side, the
 * mouse/keyboard raycaster listeners. `store` and `audio` are captured so the
 * desktop listeners can mutate + play SFX directly (the VR path receives them
 * per-frame through updateControllers callbacks instead).
 */
export function initControllers(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  store: ShapeStore,
  camera: THREE.Camera,
  audio: AudioApi
): ControllerApi {
  const factory = new XRControllerModelFactory();
  controllerStates.length = 0;

  const controllers: THREE.Group[] = [];
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    scene.add(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    scene.add(grip);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -3),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.6,
    });
    const ray = new THREE.Line(lineGeo, lineMat);
    controller.add(ray);
    controllers.push(controller);

    controllerStates.push({
      controller,
      grip,
      ray,
      heldId: null,
      prevPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      prev: { trigger: false, grip: false, aButton: false, bButton: false },
    });
  }

  initDesktop(renderer, camera, store, audio);

  return { controllers };
}

/**
 * The shape id this client is currently holding, or null (B6).
 *
 * Used by the connected (server-driven) loop to decide, per shape, whether its
 * transform comes from the local controller or the server snapshot. VR can hold
 * one shape per hand; we return the first held id (a single held id is
 * sufficient for the mode decision in this app). The desktop drag counts too.
 */
export function getHeldShapeId(): string | null {
  for (const state of controllerStates) {
    if (state.heldId) return state.heldId;
  }
  if (desktop && desktop.heldId) return desktop.heldId;
  return null;
}

/**
 * ALL shape ids this client is currently holding (audit #14).
 *
 * VR can hold one shape per hand (two controllers), and the desktop drag can hold
 * one more. The connected loop must treat EVERY held shape as 'local'
 * (controller-driven) and stream each one up via sendHeld — otherwise a shape
 * grabbed by the SECOND hand is classified 'remote', the server freezes it, and
 * peers (and this client) see it teleport. Returns a de-duplicated list (a shape
 * can't be held by two hands at once, but we de-dup defensively).
 */
export function getHeldShapeIds(): string[] {
  const ids = new Set<string>();
  for (const state of controllerStates) {
    if (state.heldId) ids.add(state.heldId);
  }
  if (desktop && desktop.heldId) ids.add(desktop.heldId);
  return [...ids];
}

/**
 * Re-point any tracked held id from `oldId` to `newId` (B6 spawn reconciliation).
 *
 * When a locally-predicted shape is grabbed the instant it spawns, its heldId is
 * the temp id (`__local__:N`). When the server's spawn echo re-keys the shape to
 * the canonical id (`room:N`), the store object is the same but its id changed;
 * this keeps the controller/desktop heldId in sync so the connected loop still
 * classifies it as 'local' (held) rather than 'remote'.
 */
export function rekeyHeldId(oldId: string, newId: string): void {
  for (const state of controllerStates) {
    if (state.heldId === oldId) state.heldId = newId;
  }
  if (desktop && desktop.heldId === oldId) desktop.heldId = newId;
}

// ===========================================================================
// updateControllers — per-frame entry point.
//   frame present  → VR path.
//   frame absent   → desktop drag integration (mouse/keyboard handled via events).
// ===========================================================================

export interface ControllerCallbacks {
  audio: AudioApi;
}

export function updateControllers(
  frame: XRFrame | null,
  delta: number,
  store: ShapeStore,
  callbacks: ControllerCallbacks
): void {
  if (!frame) {
    updateDesktop(delta, store);
    return;
  }

  const session = frame.session;
  if (!session) return;
  const sources = session.inputSources;
  if (!sources) return;

  void callbacks; // audio SFX for grab/release/spawn is emitted via store.onEvent

  for (let i = 0; i < controllerStates.length; i++) {
    const state = controllerStates[i];
    const source = sources[i];
    if (!source || !source.gamepad) continue;

    const buttons = source.gamepad.buttons;
    const axes = source.gamepad.axes;

    const pos = new THREE.Vector3();
    state.controller.getWorldPosition(pos);
    state.velocity.copy(pos).sub(state.prevPosition).divideScalar(Math.max(delta, 0.001));
    state.prevPosition.copy(pos);

    const curr = {
      trigger: buttons[0]?.pressed ?? false,
      grip: buttons[1]?.pressed ?? false,
      aButton: buttons[4]?.pressed ?? false,
      bButton: buttons[5]?.pressed ?? false,
    };
    const stickY = axes[3] ?? 0;

    const snapshot: ButtonSnapshot = {
      trigger: { prev: state.prev.trigger, curr: curr.trigger },
      grip: { prev: state.prev.grip, curr: curr.grip },
      aButton: { prev: state.prev.aButton, curr: curr.aButton },
      bButton: { prev: state.prev.bButton, curr: curr.bButton },
      stickY,
    };
    const intent = intentForButtons(snapshot);

    switch (intent) {
      case 'grab': {
        const nearest = findNearestShape(pos, store);
        if (nearest) {
          state.heldId = nearest.id;
          store.setGrab(nearest.id, LOCAL_ID); // grab SFX via store.onEvent
        }
        break;
      }
      case 'release': {
        if (state.heldId) {
          const shape = store.get(state.heldId);
          if (shape) applyThrow(shape, state.velocity, 1.5);
          store.setGrab(state.heldId, null); // release SFX via store.onEvent
          state.heldId = null;
        }
        break;
      }
      case 'spawn': {
        const shape = spawnAt(store, pos.clone());
        void shape; // spawn SFX + burst handled by ShapeStore onEvent in main.ts
        break;
      }
      case 'color': {
        if (state.heldId) {
          const shape = store.get(state.heldId);
          if (shape) store.setColor(state.heldId, cycleColorIndex(shape.colorIndex));
        }
        break;
      }
      case 'mode': {
        if (state.heldId) {
          const shape = store.get(state.heldId);
          if (shape) store.setRenderMode(state.heldId, cycleRenderMode(shape.renderMode));
        }
        break;
      }
      case 'scale': {
        if (state.heldId) {
          const shape = store.get(state.heldId);
          // stick up (negative Y) grows the shape, matching the old mapping.
          if (shape) store.setScale(state.heldId, clampScale(shape.scale + -stickY * 2 * delta));
        }
        break;
      }
      case 'none':
      default:
        break;
    }

    // Keep a held shape stuck to the controller.
    if (state.heldId) {
      const shape = store.get(state.heldId);
      if (shape) shape.group.position.copy(pos);
      else state.heldId = null; // shape was evicted/removed while held
    }

    state.prev = curr;
  }

  // PTT: thumbstick-click = buttons[3] on controller 0 (right hand)
  // Only fire once per rising/falling edge (not once per controller per frame).
  if (_pttCallback) {
    const source0 = sources[0];
    const pttCurr = source0?.gamepad?.buttons[3]?.pressed ?? false;
    if (pttCurr !== _prevPtt) {
      _prevPtt = pttCurr;
      _pttCallback(pttCurr);
    }
  }
}

// ===========================================================================
// Desktop path
// ===========================================================================

function initDesktop(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  store: ShapeStore,
  audio: AudioApi
): void {
  desktop = {
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    camera,
    domElement: renderer.domElement ?? null,
    heldId: null,
    lastTouchedId: null,
    dragPlane: new THREE.Plane(),
    prevDragPos: new THREE.Vector3(),
    dragVelocity: new THREE.Vector3(),
    pressPointer: new THREE.Vector2(),
    pressedShapeId: null,
    isPointerDown: false,
  };

  if (typeof window === 'undefined') return; // headless / test env — listeners skipped

  const dom = renderer.domElement;

  const setPointerFromEvent = (e: PointerEvent) => {
    const rect = dom.getBoundingClientRect();
    desktop!.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    desktop!.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };

  const pickShape = (): ClientShape | null => {
    if (!desktop!.camera) return null;
    desktop!.raycaster.setFromCamera(desktop!.pointer, desktop!.camera);
    const groups = store.shapes.map((s) => s.group);
    const hits = desktop!.raycaster.intersectObjects(groups, true);
    if (hits.length === 0) return null;
    // Walk up to the group that a store shape owns.
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        const shape = store.shapes.find((s) => s.group === obj);
        if (shape) return shape;
        obj = obj.parent;
      }
    }
    return null;
  };

  dom.addEventListener('pointerdown', (e: PointerEvent) => {
    void audio.resume(); // first-gesture unlock
    setPointerFromEvent(e);
    desktop!.isPointerDown = true;
    desktop!.pressPointer.copy(desktop!.pointer);
    const shape = pickShape();
    desktop!.pressedShapeId = shape ? shape.id : null;

    if (shape) {
      // Begin a grab-drag.
      desktop!.heldId = shape.id;
      desktop!.lastTouchedId = shape.id;
      store.setGrab(shape.id, LOCAL_ID); // grab SFX via store.onEvent
      desktop!.prevDragPos.copy(shape.group.position);
      desktop!.dragVelocity.set(0, 0, 0);
      // Drag plane: faces the camera, through the shape.
      const camDir = new THREE.Vector3();
      desktop!.camera!.getWorldDirection(camDir);
      desktop!.dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), shape.group.position);
    }
  });

  dom.addEventListener('pointermove', (e: PointerEvent) => {
    if (!desktop!.isPointerDown || !desktop!.heldId || !desktop!.camera) return;
    setPointerFromEvent(e);
    desktop!.raycaster.setFromCamera(desktop!.pointer, desktop!.camera);
    const hit = new THREE.Vector3();
    if (desktop!.raycaster.ray.intersectPlane(desktop!.dragPlane, hit)) {
      const shape = store.get(desktop!.heldId);
      if (shape) shape.group.position.copy(hit);
    }
  });

  const endDrag = (e: PointerEvent) => {
    setPointerFromEvent(e);
    if (desktop!.heldId) {
      // Throw with the drag velocity accumulated in updateDesktop.
      const shape = store.get(desktop!.heldId);
      if (shape) applyThrow(shape, desktop!.dragVelocity, 1.5);
      store.setGrab(desktop!.heldId, null); // release SFX via store.onEvent
      desktop!.heldId = null;
    } else if (desktop!.isPointerDown && desktop!.pressedShapeId === null) {
      // Empty-space release: only spawn on a TRUE CLICK (pointer barely moved).
      // A large move on empty space means the user was rotating the camera via
      // OrbitControls — do NOT spawn in that case.
      if (isClick(desktop!.pressPointer, desktop!.pointer)) {
        const spawnPos = desktopSpawnPoint();
        if (spawnPos) spawnAt(store, spawnPos); // spawn SFX/burst via onEvent
      }
    }
    desktop!.isPointerDown = false;
    desktop!.pressedShapeId = null;
  };

  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointerleave', () => {
    // Cancel a drag that leaves the canvas (release without throw impulse).
    if (desktop!.heldId) {
      store.setGrab(desktop!.heldId, null); // release SFX via store.onEvent
      desktop!.heldId = null;
    }
    desktop!.isPointerDown = false;
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const id = desktop!.heldId ?? desktop!.lastTouchedId;
    if (!id) return;
    const shape = store.get(id);
    if (!shape) return;
    if (e.key === 'c' || e.key === 'C') {
      store.setColor(id, cycleColorIndex(shape.colorIndex));
    } else if (e.key === 'v' || e.key === 'V') {
      store.setRenderMode(id, cycleRenderMode(shape.renderMode));
    }
  });
}

/** Raycast the desktop pointer against the ground plane (y = groundY) for spawning. */
function desktopSpawnPoint(groundY = 1.2): THREE.Vector3 | null {
  if (!desktop || !desktop.camera) return null;
  desktop.raycaster.setFromCamera(desktop.pointer, desktop.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY);
  const hit = new THREE.Vector3();
  if (desktop.raycaster.ray.intersectPlane(plane, hit)) return hit;
  return null;
}

/** Per-frame desktop integration: track drag velocity for throws. */
function updateDesktop(delta: number, store: ShapeStore): void {
  if (!desktop || !desktop.heldId) return;
  const shape = store.get(desktop.heldId);
  if (!shape) {
    desktop.heldId = null;
    return;
  }
  const cur = shape.group.position;
  desktop.dragVelocity.copy(cur).sub(desktop.prevDragPos).divideScalar(Math.max(delta, 0.001));
  desktop.prevDragPos.copy(cur);
}
