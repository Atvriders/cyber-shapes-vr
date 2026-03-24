import * as THREE from 'three';

let stars;
let dustParticles;
let hudPanels = [];
let dustVelocities;

export function initEnvironment(scene) {
  // --- Grid floor ---
  const grid = new THREE.GridHelper(200, 200, 0x00ffff, 0x003333);
  grid.position.y = -1;
  scene.add(grid);

  // Dark plane underneath the grid
  const planeGeo = new THREE.PlaneGeometry(200, 200);
  const planeMat = new THREE.MeshBasicMaterial({ color: 0x050510, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -1.01;
  scene.add(plane);

  // --- Stars ---
  const starCount = 500;
  const starPositions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 40 + Math.random() * 40; // radius 40-80
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPositions[i * 3 + 2] = r * Math.cos(phi);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.3, sizeAttenuation: true });
  stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // --- Ambient dust particles ---
  const dustCount = 200;
  const dustPositions = new Float32Array(dustCount * 3);
  dustVelocities = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    dustPositions[i * 3] = (Math.random() - 0.5) * 40;
    dustPositions[i * 3 + 1] = Math.random() * 20 - 1;
    dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 40;
    dustVelocities[i] = 0.2 + Math.random() * 0.5;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustMat = new THREE.PointsMaterial({
    color: 0x00ffff,
    size: 0.08,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  dustParticles = new THREE.Points(dustGeo, dustMat);
  scene.add(dustParticles);

  // --- Lighting ---
  const ambient = new THREE.AmbientLight(0x111122, 0.3);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0x4400ff, 0.5);
  directional.position.set(0, 20, 0);
  scene.add(directional);

  const hemi = new THREE.HemisphereLight(0x0066ff, 0x000000, 0.3);
  scene.add(hemi);

  // --- HUD Panels ---
  hudPanels = [];
  hudPanels.push(createHudPanel('SYSTEM ONLINE', -3.5, 3, -5, scene));
  hudPanels.push(createHudPanel('SHAPES: 0', 3.5, 3, -5, scene));

  return { stars, dustParticles, hudPanels };
}

function createHudPanel(text, x, y, z, scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  drawHudText(ctx, text, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const geo = new THREE.PlaneGeometry(1.6, 0.8);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  return { mesh, canvas, ctx, texture };
}

function drawHudText(ctx, text, w, h) {
  ctx.clearRect(0, 0, w, h);
  // Background
  ctx.fillStyle = 'rgba(0, 20, 40, 0.4)';
  ctx.fillRect(0, 0, w, h);
  // Border
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  // Text
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 20px Courier New, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#0ff';
  ctx.shadowBlur = 10;
  ctx.fillText(text, w / 2, h / 2);
  ctx.shadowBlur = 0;
}

export function updateHudShapeCount(count) {
  if (hudPanels.length < 2) return;
  const panel = hudPanels[1];
  drawHudText(panel.ctx, `SHAPES: ${count}`, panel.canvas.width, panel.canvas.height);
  panel.texture.needsUpdate = true;
}

export function updateEnvironment(delta) {
  // Rotate stars slowly
  if (stars) {
    stars.rotation.y += delta * 0.01;
  }

  // Float dust upward and wrap
  if (dustParticles) {
    const positions = dustParticles.geometry.attributes.position.array;
    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 1] += dustVelocities[i] * delta;
      if (positions[i * 3 + 1] > 19) {
        positions[i * 3 + 1] = -1;
        positions[i * 3] = (Math.random() - 0.5) * 40;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 40;
      }
    }
    dustParticles.geometry.attributes.position.needsUpdate = true;
  }

  // Subtle HUD panel hover
  for (let i = 0; i < hudPanels.length; i++) {
    const panel = hudPanels[i];
    panel.mesh.position.y = 3 + Math.sin(Date.now() * 0.001 + i * Math.PI) * 0.05;
  }
}
