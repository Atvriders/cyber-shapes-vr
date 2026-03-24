import * as THREE from 'three';

export const SHAPE_TYPES = [
  'cube', 'sphere', 'icosahedron', 'torus', 'torusKnot',
  'octahedron', 'dodecahedron', 'cylinder', 'cone', 'tetrahedron'
];

export const CYBER_COLORS = [
  0x00ffff, 0xff00ff, 0xff0066, 0x0066ff, 0x00ff66, 0x9900ff, 0xff6600
];

let shapeIdCounter = 0;

function createGeometry(type) {
  switch (type) {
    case 'cube':         return new THREE.BoxGeometry(0.3, 0.3, 0.3);
    case 'sphere':       return new THREE.SphereGeometry(0.18, 12, 8);
    case 'icosahedron':  return new THREE.IcosahedronGeometry(0.2, 0);
    case 'torus':        return new THREE.TorusGeometry(0.15, 0.06, 8, 16);
    case 'torusKnot':    return new THREE.TorusKnotGeometry(0.14, 0.04, 32, 6);
    case 'octahedron':   return new THREE.OctahedronGeometry(0.2, 0);
    case 'dodecahedron': return new THREE.DodecahedronGeometry(0.18, 0);
    case 'cylinder':     return new THREE.CylinderGeometry(0.15, 0.15, 0.3, 12);
    case 'cone':         return new THREE.ConeGeometry(0.18, 0.35, 10);
    case 'tetrahedron':  return new THREE.TetrahedronGeometry(0.22, 0);
    default:             return new THREE.BoxGeometry(0.3, 0.3, 0.3);
  }
}

export function createShape(type, position, color, world) {
  if (world.shapes.length >= world.maxShapes) return null;

  const colorIndex = CYBER_COLORS.indexOf(color);
  const geometry = createGeometry(type);

  const solidMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color,
    roughness: 0.3,
    metalness: 0.7,
    transparent: true,
    opacity: 0.6,
    emissive: color,
    emissiveIntensity: 0.15
  }));

  const wireMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity: 0.8
  }));

  const group = new THREE.Group();
  group.add(solidMesh);
  group.add(wireMesh);
  group.position.copy(position);

  let light = null;
  if (world.shapes.length < 20) {
    light = new THREE.PointLight(color, 0.5, 3);
    group.add(light);
  }

  world.scene.add(group);

  const shape = {
    id: shapeIdCounter++,
    group,
    solidMesh,
    wireMesh,
    light,
    type,
    colorIndex: colorIndex >= 0 ? colorIndex : 0,
    renderMode: 'both',
    velocity: new THREE.Vector3(0, 0, 0),
    scale: 1,
    bobPhase: Math.random() * Math.PI * 2,
    rotSpeed: new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2
    ),
    grabbed: false,
    grounded: false
  };

  world.shapes.push(shape);
  return shape;
}

export function updateShapeAnimations(delta, world) {
  for (const shape of world.shapes) {
    if (shape.grabbed) continue;

    shape.group.rotation.x += shape.rotSpeed.x * delta;
    shape.group.rotation.y += shape.rotSpeed.y * delta;
    shape.group.rotation.z += shape.rotSpeed.z * delta;

    if (shape.grounded) {
      shape.bobPhase += delta * 2;
      shape.group.position.y = 0.15 * shape.scale + Math.sin(shape.bobPhase) * 0.02;
    }

    switch (shape.renderMode) {
      case 'solid':
        shape.solidMesh.visible = true;
        shape.wireMesh.visible = false;
        break;
      case 'wireframe':
        shape.solidMesh.visible = false;
        shape.wireMesh.visible = true;
        break;
      case 'both':
      default:
        shape.solidMesh.visible = true;
        shape.wireMesh.visible = true;
        break;
    }
  }
}

export function cycleColor(shape) {
  shape.colorIndex = (shape.colorIndex + 1) % CYBER_COLORS.length;
  const color = CYBER_COLORS[shape.colorIndex];

  shape.solidMesh.material.color.setHex(color);
  shape.solidMesh.material.emissive.setHex(color);
  shape.wireMesh.material.color.setHex(color);
  if (shape.light) shape.light.color.setHex(color);
}

export function cycleRenderMode(shape) {
  const modes = ['both', 'solid', 'wireframe'];
  const idx = modes.indexOf(shape.renderMode);
  shape.renderMode = modes[(idx + 1) % modes.length];
}

export function setShapeScale(shape, scale) {
  shape.scale = Math.max(0.2, Math.min(3, scale));
  shape.group.scale.setScalar(shape.scale);
}

export function removeShape(shape, world) {
  world.scene.remove(shape.group);

  shape.solidMesh.geometry.dispose();
  shape.solidMesh.material.dispose();
  shape.wireMesh.material.dispose();

  const idx = world.shapes.indexOf(shape);
  if (idx !== -1) world.shapes.splice(idx, 1);
}
