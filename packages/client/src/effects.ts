import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------------------
// Particle ShaderMaterial (pure builder — no WebGL context required)
// ---------------------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
attribute float size;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (300.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, 1.0 - d * 2.0);
}
`;

/** Pure builder — creates a per-vertex-size ShaderMaterial for the particle pool. */
export function createParticleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Module-level particle pool state
// ---------------------------------------------------------------------------

let composer: EffectComposer | null = null;
let scene: THREE.Scene | null = null;
let isVR = false;

const MAX_POOL = 300;
let poolMesh: THREE.Points | null = null;
let poolPositions: Float32Array;
let poolColors: Float32Array;
let poolSizes: Float32Array;

interface ParticleState {
  active: boolean;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

const particleStates: ParticleState[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EffectsHandle {
  composer: EffectComposer;
  isVR(): boolean;
  setSize(w: number, h: number): void;
  renderFrame(): void;
}

export function initEffects(
  renderer: THREE.WebGLRenderer,
  sceneRef: THREE.Scene,
  camera: THREE.Camera
): EffectsHandle {
  scene = sceneRef;

  // --- Post-processing (non-VR only) ---
  const size = renderer.getSize(new THREE.Vector2());
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    1.2, // strength
    0.4, // radius
    0.1 // threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Track VR state
  renderer.xr.addEventListener('sessionstart', () => {
    isVR = true;
  });
  renderer.xr.addEventListener('sessionend', () => {
    isVR = false;
  });

  // --- Particle pool geometry ---
  poolPositions = new Float32Array(MAX_POOL * 3);
  poolColors = new Float32Array(MAX_POOL * 3);
  poolSizes = new Float32Array(MAX_POOL);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(poolPositions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(poolColors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(poolSizes, 1));

  const mat = createParticleMaterial();

  poolMesh = new THREE.Points(geo, mat);
  poolMesh.frustumCulled = false;
  scene.add(poolMesh);

  // Init particle states (only on first call — guard against hot-reload)
  if (particleStates.length === 0) {
    for (let i = 0; i < MAX_POOL; i++) {
      particleStates.push({ active: false, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0 });
    }
  }

  // Capture local reference to composer for the returned handle
  const localComposer = composer;

  return {
    composer: localComposer,
    isVR(): boolean {
      return isVR;
    },
    setSize(w: number, h: number): void {
      localComposer.setSize(w, h);
    },
    renderFrame(): void {
      if (isVR) {
        renderer.render(sceneRef, camera);
      } else {
        localComposer.render();
      }
    },
  };
}

function allocateParticle(): number {
  for (let i = 0; i < MAX_POOL; i++) {
    if (!particleStates[i].active) {
      particleStates[i].active = true;
      return i;
    }
  }
  return -1; // pool exhausted
}

export function spawnBurstParticles(
  position: THREE.Vector3Like,
  color: THREE.ColorRepresentation
): void {
  const col = new THREE.Color(color);
  for (let i = 0; i < 20; i++) {
    const idx = allocateParticle();
    if (idx === -1) return;

    const s = particleStates[idx];
    const speed = 2 + Math.random() * 4;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    s.vx = speed * Math.sin(phi) * Math.cos(theta);
    s.vy = speed * Math.sin(phi) * Math.sin(theta);
    s.vz = speed * Math.cos(phi);
    s.life = 0.8;
    s.maxLife = 0.8;

    const i3 = idx * 3;
    poolPositions[i3] = (position as THREE.Vector3).x;
    poolPositions[i3 + 1] = (position as THREE.Vector3).y;
    poolPositions[i3 + 2] = (position as THREE.Vector3).z;
    poolColors[i3] = col.r;
    poolColors[i3 + 1] = col.g;
    poolColors[i3 + 2] = col.b;
    poolSizes[idx] = 0.15;
  }
  markDirty();
}

export function spawnImpactParticles(
  position: THREE.Vector3Like,
  color: THREE.ColorRepresentation
): void {
  const col = new THREE.Color(color);
  for (let i = 0; i < 10; i++) {
    const idx = allocateParticle();
    if (idx === -1) return;

    const s = particleStates[idx];
    s.vx = (Math.random() - 0.5) * 2;
    s.vy = 2 + Math.random() * 3;
    s.vz = (Math.random() - 0.5) * 2;
    s.life = 0.5;
    s.maxLife = 0.5;

    const i3 = idx * 3;
    poolPositions[i3] = (position as THREE.Vector3).x;
    poolPositions[i3 + 1] = (position as THREE.Vector3).y;
    poolPositions[i3 + 2] = (position as THREE.Vector3).z;
    poolColors[i3] = col.r;
    poolColors[i3 + 1] = col.g;
    poolColors[i3 + 2] = col.b;
    poolSizes[idx] = 0.12;
  }
  markDirty();
}

function markDirty(): void {
  if (!poolMesh) return;
  poolMesh.geometry.attributes.position.needsUpdate = true;
  poolMesh.geometry.attributes.color.needsUpdate = true;
  poolMesh.geometry.attributes.size.needsUpdate = true;
  poolMesh.geometry.setDrawRange(0, MAX_POOL);
}

export function updateEffects(delta: number): void {
  let dirty = false;
  for (let i = 0; i < MAX_POOL; i++) {
    const s = particleStates[i];
    if (!s.active) continue;

    s.life -= delta;
    if (s.life <= 0) {
      s.active = false;
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

    // Delta-scaled friction (was frame-rate-dependent `*= 0.97`)
    const k = Math.pow(0.97, delta * 60);
    s.vx *= k;
    s.vy *= k;
    s.vz *= k;

    dirty = true;
  }

  if (dirty) {
    markDirty();
  }
}
