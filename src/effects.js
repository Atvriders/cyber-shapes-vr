import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

let composer;
let scene;
let isVR = false;

// Particle pool
const MAX_POOL = 300;
const particlePool = [];
let poolMesh = null;
let poolPositions;
let poolColors;
let poolSizes;
let activeCount = 0;

// Per-particle state
const particleStates = [];

export function initEffects(renderer, sceneRef, camera) {
  scene = sceneRef;

  // --- Post-processing (non-VR only) ---
  const size = renderer.getSize(new THREE.Vector2());
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    1.2,   // strength
    0.4,   // radius
    0.1    // threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Track VR state
  renderer.xr.addEventListener('sessionstart', () => { isVR = true; });
  renderer.xr.addEventListener('sessionend', () => { isVR = false; });

  // --- Particle pool geometry ---
  poolPositions = new Float32Array(MAX_POOL * 3);
  poolColors = new Float32Array(MAX_POOL * 3);
  poolSizes = new Float32Array(MAX_POOL);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(poolPositions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(poolColors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(poolSizes, 1));

  const mat = new THREE.PointsMaterial({
    size: 0.1,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true
  });

  poolMesh = new THREE.Points(geo, mat);
  poolMesh.frustumCulled = false;
  scene.add(poolMesh);

  // Init particle states
  for (let i = 0; i < MAX_POOL; i++) {
    particleStates.push({
      active: false,
      vx: 0, vy: 0, vz: 0,
      life: 0,
      maxLife: 0
    });
  }

  return { composer, get isVR() { return isVR; } };
}

function allocateParticle() {
  for (let i = 0; i < MAX_POOL; i++) {
    if (!particleStates[i].active) {
      particleStates[i].active = true;
      activeCount++;
      return i;
    }
  }
  return -1; // pool exhausted
}

export function spawnBurstParticles(position, color) {
  const col = new THREE.Color(color);
  for (let i = 0; i < 20; i++) {
    const idx = allocateParticle();
    if (idx === -1) return;

    const s = particleStates[idx];
    // Random outward velocity
    const speed = 2 + Math.random() * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    s.vx = speed * Math.sin(phi) * Math.cos(theta);
    s.vy = speed * Math.sin(phi) * Math.sin(theta);
    s.vz = speed * Math.cos(phi);
    s.life = 0.8;
    s.maxLife = 0.8;

    const i3 = idx * 3;
    poolPositions[i3] = position.x;
    poolPositions[i3 + 1] = position.y;
    poolPositions[i3 + 2] = position.z;
    poolColors[i3] = col.r;
    poolColors[i3 + 1] = col.g;
    poolColors[i3 + 2] = col.b;
    poolSizes[idx] = 0.15;
  }
  markDirty();
}

export function spawnImpactParticles(position, color) {
  const col = new THREE.Color(color);
  for (let i = 0; i < 10; i++) {
    const idx = allocateParticle();
    if (idx === -1) return;

    const s = particleStates[idx];
    // Upward with slight spread
    s.vx = (Math.random() - 0.5) * 2;
    s.vy = 2 + Math.random() * 3;
    s.vz = (Math.random() - 0.5) * 2;
    s.life = 0.5;
    s.maxLife = 0.5;

    const i3 = idx * 3;
    poolPositions[i3] = position.x;
    poolPositions[i3 + 1] = position.y;
    poolPositions[i3 + 2] = position.z;
    poolColors[i3] = col.r;
    poolColors[i3 + 1] = col.g;
    poolColors[i3 + 2] = col.b;
    poolSizes[idx] = 0.12;
  }
  markDirty();
}

function markDirty() {
  poolMesh.geometry.attributes.position.needsUpdate = true;
  poolMesh.geometry.attributes.color.needsUpdate = true;
  poolMesh.geometry.attributes.size.needsUpdate = true;
  poolMesh.geometry.setDrawRange(0, MAX_POOL);
}

export function updateEffects(delta) {
  let dirty = false;
  for (let i = 0; i < MAX_POOL; i++) {
    const s = particleStates[i];
    if (!s.active) continue;

    s.life -= delta;
    if (s.life <= 0) {
      s.active = false;
      activeCount--;
      // Move off-screen
      const i3 = i * 3;
      poolPositions[i3] = 0;
      poolPositions[i3 + 1] = -1000;
      poolPositions[i3 + 2] = 0;
      poolSizes[i] = 0;
      dirty = true;
      continue;
    }

    const i3 = i * 3;
    poolPositions[i3] += s.vx * delta;
    poolPositions[i3 + 1] += s.vy * delta;
    poolPositions[i3 + 2] += s.vz * delta;

    // Fade size based on remaining life
    const t = s.life / s.maxLife;
    poolSizes[i] = 0.15 * t;

    // Slow down
    s.vx *= 0.97;
    s.vy *= 0.97;
    s.vz *= 0.97;

    dirty = true;
  }

  if (dirty) {
    markDirty();
  }
}

export function renderFrame(renderer, scene, camera) {
  if (isVR) {
    renderer.render(scene, camera);
  } else {
    composer.render();
  }
}
