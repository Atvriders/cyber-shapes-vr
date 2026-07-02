/**
 * shapes.ts — render helpers for cyber shapes (migrated from shapes.js in A5).
 *
 * These helpers own NO shape array and NO id counter — that lifecycle now lives
 * in ShapeStore (world.ts). They are pure-ish builders / per-frame updaters that
 * operate on a single shape and its THREE render handles.
 *
 * SHAPE_TYPES / CYBER_COLORS come from @cyber-shapes/shared (do not redefine).
 */

import * as THREE from 'three';
import type { Shape, ShapeType, RenderMode } from '@cyber-shapes/shared';
import { SHAPE_TYPES, CYBER_COLORS, restYFor } from '@cyber-shapes/shared';

// Re-export the shape/color tables for convenience.
export { SHAPE_TYPES, CYBER_COLORS };

// ---------------------------------------------------------------------------
// Client shape types — pure-data Shape plus THREE render handles.
// ---------------------------------------------------------------------------
export type ShapeVisual = {
  group: THREE.Group;
  solidMesh: THREE.Mesh;
  wireMesh: THREE.Mesh;
  light?: THREE.PointLight;
};

export type ClientShape = Shape & ShapeVisual;

// ---------------------------------------------------------------------------
// Geometry construction — per-type params preserved from the original shapes.js.
// restYFor() in @cyber-shapes/shared is derived from exactly these params, so
// any change here must be mirrored there.
// ---------------------------------------------------------------------------

/**
 * Module-level geometry cache keyed by ShapeType.
 * All shapes of the same type share the SAME BufferGeometry instance to reduce
 * GPU memory and drawcall overhead (Quest 2 performance — A10).
 * Disposal is ONLY performed by disposeGeometryCache() on full teardown.
 */
const _geometryCache = new Map<ShapeType, THREE.BufferGeometry>();

function getOrCreateGeometry(type: ShapeType): THREE.BufferGeometry {
  let geo = _geometryCache.get(type);
  if (!geo) {
    geo = createGeometry(type);
    _geometryCache.set(type, geo);
  }
  return geo;
}

export function disposeGeometryCache(): void {
  for (const geo of _geometryCache.values()) geo.dispose();
  _geometryCache.clear();
}

function createGeometry(type: ShapeType): THREE.BufferGeometry {
  switch (type) {
    case 'cube':
      return new THREE.BoxGeometry(0.3, 0.3, 0.3);
    case 'sphere':
      return new THREE.SphereGeometry(0.18, 12, 8);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(0.2, 0);
    case 'torus':
      return new THREE.TorusGeometry(0.15, 0.06, 8, 16);
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(0.14, 0.04, 32, 6);
    case 'octahedron':
      return new THREE.OctahedronGeometry(0.2, 0);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(0.18, 0);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.15, 0.15, 0.3, 12);
    case 'cone':
      return new THREE.ConeGeometry(0.18, 0.35, 10);
    case 'tetrahedron':
      return new THREE.TetrahedronGeometry(0.22, 0);
    default:
      return new THREE.BoxGeometry(0.3, 0.3, 0.3);
  }
}

/**
 * Build the THREE render objects for a shape: a Group holding a solid mesh
 * (MeshStandardMaterial @ opacity 0.6, emissive of the shape color) and a
 * wireframe overlay mesh (MeshBasicMaterial) SHARING one geometry.
 *
 * Does NOT attach a light — ShapeStore decides on lights (MAX_LIGHTS budget).
 * Position is left at origin; the caller positions the group.
 */
export function buildShapeObject(shape: Shape): ShapeVisual {
  const color = CYBER_COLORS[shape.colorIndex] ?? CYBER_COLORS[0];
  const geometry = getOrCreateGeometry(shape.type);

  const solidMesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.3,
      metalness: 0.7,
      transparent: true,
      opacity: 0.6,
      emissive: color,
      emissiveIntensity: 0.4,
    })
  );

  const wireMesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    })
  );

  const group = new THREE.Group();
  group.add(solidMesh);
  group.add(wireMesh);
  group.scale.setScalar(shape.scale);

  return { group, solidMesh, wireMesh };
}

/**
 * Build a PointLight colored for the given colorIndex. ShapeStore attaches it
 * to the shape's group when the live-light count is under MAX_LIGHTS.
 */
export function buildLight(colorIndex: number): THREE.PointLight {
  const color = CYBER_COLORS[colorIndex] ?? CYBER_COLORS[0];
  return new THREE.PointLight(color, 0.5, 3);
}

/**
 * Set mesh visibility from a render mode.
 *   both      → both visible
 *   solid     → wire hidden
 *   wireframe → solid hidden
 */
function applyRenderMode(visual: ShapeVisual, mode: RenderMode): void {
  switch (mode) {
    case 'solid':
      visual.solidMesh.visible = true;
      visual.wireMesh.visible = false;
      break;
    case 'wireframe':
      visual.solidMesh.visible = false;
      visual.wireMesh.visible = true;
      break;
    case 'both':
    default:
      visual.solidMesh.visible = true;
      visual.wireMesh.visible = true;
      break;
  }
}

export { applyRenderMode };

/**
 * Apply ONLY the mesh visibility for a shape's current renderMode — no rotation,
 * no bob, no transform. This is the non-transform slice of updateShapeRender,
 * used by the connected (server-driven) loop where the server owns transforms
 * but the client still reflects local/remote renderMode changes visually (B6).
 */
export function applyRenderModeVisibility(shape: ClientShape): void {
  applyRenderMode(shape, shape.renderMode);
}

/**
 * Per-frame render update for a single shape:
 *  - autonomous rotation (rotation += rotSpeed * delta), SKIPPED while grabbed.
 *  - when grounded, bob around the per-shape rest height (restYFor from shared —
 *    this is where the A3 per-shape fix is applied; the old code used 0.15*scale).
 *  - mesh visibility from renderMode.
 *
 * NOTE: bobPhase advancement (bobPhase += delta * 2) is the caller's / physics'
 * job in the original loop; here we read bobPhase as-is so this stays pure w.r.t.
 * simulation state and only touches THREE render handles.
 */
export function updateShapeRender(shape: ClientShape, delta: number): void {
  if (shape.grabbedBy === null) {
    shape.group.rotation.x += shape.rotSpeed.x * delta;
    shape.group.rotation.y += shape.rotSpeed.y * delta;
    shape.group.rotation.z += shape.rotSpeed.z * delta;
  }

  if (shape.grounded) {
    shape.group.position.y = restYFor(shape.type, shape.scale) + Math.sin(shape.bobPhase) * 0.02;
  }

  applyRenderMode(shape, shape.renderMode);
}

/**
 * Apply the shape's current colorIndex to solid material color+emissive, wire
 * material color, and the light color (if present), from CYBER_COLORS.
 */
export function applyColor(shape: ClientShape): void {
  const color = CYBER_COLORS[shape.colorIndex] ?? CYBER_COLORS[0];
  const solidMat = shape.solidMesh.material as THREE.MeshStandardMaterial;
  const wireMat = shape.wireMesh.material as THREE.MeshBasicMaterial;
  solidMat.color.setHex(color);
  solidMat.emissive.setHex(color);
  wireMat.color.setHex(color);
  if (shape.light) shape.light.color.setHex(color);
}
