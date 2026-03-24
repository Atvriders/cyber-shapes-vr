import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createShape, updateShapeAnimations, SHAPE_TYPES, CYBER_COLORS } from './shapes.js';
import { updatePhysics } from './physics.js';
import { initControllers, updateControllers } from './controllers.js';
import { initEnvironment, updateEnvironment } from './environment.js';
import { initEffects, updateEffects, spawnBurstParticles, spawnImpactParticles, renderFrame } from './effects.js';
import { initAudio } from './audio.js';

let renderer, scene, camera, world, controls, composer, audio;
let prevTime = 0;

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);
  scene.fog = new THREE.FogExp2(0x0a0020, 0.015);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 3);

  world = {
    scene,
    camera,
    shapes: [],
    maxShapes: 40
  };

  initEnvironment(scene);
  composer = initEffects(renderer, scene, camera);
  initControllers(renderer, scene, world);
  audio = initAudio();

  // Desktop orbit controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  // VR button
  document.body.appendChild(VRButton.createButton(renderer));

  // Spawn 5 initial shapes in a semicircle
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI / 4) + (Math.PI / 2) * (i / 4);
    const x = Math.cos(angle) * 1.5;
    const z = -2 + Math.sin(angle) * 0.5;
    const type = SHAPE_TYPES[i % SHAPE_TYPES.length];
    const color = CYBER_COLORS[i % CYBER_COLORS.length];
    createShape(type, new THREE.Vector3(x, 1.5, z), color, world);
  }

  renderer.setAnimationLoop(gameLoop);

  window.addEventListener('resize', onResize);

  // Handle VR session overlay
  renderer.xr.addEventListener('sessionstart', () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = 'none';
  });
  renderer.xr.addEventListener('sessionend', () => {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = '';
  });
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
}

function gameLoop(timestamp, frame) {
  const time = timestamp / 1000;
  let delta = time - prevTime;
  if (delta > 0.05) delta = 0.05;
  prevTime = time;

  updatePhysics(delta, world, (shape) => {
    spawnImpactParticles(shape.group.position, CYBER_COLORS[shape.colorIndex]);
    audio.playImpact();
  });

  updateShapeAnimations(delta, world);

  updateControllers(frame, delta, world, {
    onSpawn: (shape) => {
      spawnBurstParticles(shape.group.position, CYBER_COLORS[shape.colorIndex]);
      audio.playSpawn();
    },
    onGrab: () => {
      audio.playGrab();
    },
    onRelease: () => {
      audio.playRelease();
    },
  });

  updateEffects(delta);
  updateEnvironment(delta);

  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  } else {
    if (controls) controls.update();
    renderFrame(renderer, scene, camera);
  }
}

init();
