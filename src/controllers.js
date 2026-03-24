import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { createShape, cycleColor, cycleRenderMode, setShapeScale, SHAPE_TYPES, CYBER_COLORS } from './shapes.js';

const controllerStates = [];

export function initControllers(renderer, scene, world) {
  const factory = new XRControllerModelFactory();

  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    scene.add(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(factory.createControllerModel(grip));
    scene.add(grip);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -3)
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.6 });
    const ray = new THREE.Line(lineGeo, lineMat);
    controller.add(ray);

    controllerStates.push({
      controller,
      grip,
      ray,
      heldShape: null,
      prevPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      prevButtons: []
    });
  }
}

function buttonEdge(current, prev, index) {
  return current[index] && current[index].pressed && !(prev[index] && prev[index].pressed);
}

function findNearestShape(controllerPos, world) {
  let nearest = null;
  let nearestDist = 0.5;

  for (const shape of world.shapes) {
    if (shape.grabbed) continue;
    const dist = controllerPos.distanceTo(shape.group.position);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = shape;
    }
  }
  return nearest;
}

export function updateControllers(frame, delta, world, callbacks) {
  if (!frame) return;

  const session = frame.session;
  if (!session) return;

  const sources = session.inputSources;
  if (!sources) return;

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

    // Grip (buttons[1]) — grab / release
    const gripPressed = buttons[1] && buttons[1].pressed;
    const gripWasPressed = state.prevButtons[1] && state.prevButtons[1].pressed;

    if (gripPressed && !gripWasPressed) {
      const nearest = findNearestShape(pos, world);
      if (nearest) {
        state.heldShape = nearest;
        nearest.grabbed = true;
        nearest.grounded = false;
        nearest.velocity.set(0, 0, 0);
        if (callbacks.onGrab) callbacks.onGrab(nearest);
      }
    }

    if (!gripPressed && gripWasPressed && state.heldShape) {
      const shape = state.heldShape;
      shape.grabbed = false;
      shape.velocity.copy(state.velocity).multiplyScalar(1.5);
      if (callbacks.onRelease) callbacks.onRelease(shape);
      state.heldShape = null;
    }

    // Move held shape with controller
    if (state.heldShape) {
      state.heldShape.group.position.copy(pos);
    }

    // Trigger (buttons[0]) edge — spawn
    if (buttonEdge(buttons, state.prevButtons, 0)) {
      const type = SHAPE_TYPES[Math.floor(Math.random() * SHAPE_TYPES.length)];
      const color = CYBER_COLORS[Math.floor(Math.random() * CYBER_COLORS.length)];
      const shape = createShape(type, pos.clone(), color, world);
      if (shape && callbacks.onSpawn) callbacks.onSpawn(shape);
    }

    // Thumbstick Y (axes[3]) — resize held shape
    if (state.heldShape && axes[3]) {
      const scaleChange = -axes[3] * 2 * delta;
      setShapeScale(state.heldShape, state.heldShape.scale + scaleChange);
    }

    // A/X button (buttons[4]) edge — cycle color
    if (state.heldShape && buttonEdge(buttons, state.prevButtons, 4)) {
      cycleColor(state.heldShape);
    }

    // B/Y button (buttons[5]) edge — cycle render mode
    if (state.heldShape && buttonEdge(buttons, state.prevButtons, 5)) {
      cycleRenderMode(state.heldShape);
    }

    // Store previous button state
    state.prevButtons = [];
    for (let b = 0; b < buttons.length; b++) {
      state.prevButtons.push({ pressed: buttons[b].pressed, touched: buttons[b].touched });
    }
  }
}
