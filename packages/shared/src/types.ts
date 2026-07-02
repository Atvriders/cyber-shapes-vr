export type ShapeType =
  | 'cube'
  | 'sphere'
  | 'icosahedron'
  | 'torus'
  | 'torusKnot'
  | 'octahedron'
  | 'dodecahedron'
  | 'cylinder'
  | 'cone'
  | 'tetrahedron';

export type RenderMode = 'both' | 'solid' | 'wireframe';

/** Pure-data shape state. Client-only render handles (mesh, group, light) are added in shapes.ts. */
export interface Shape {
  id: string;
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  /** null = not grabbed; string = session id of the grabber. Local ownership = grabbedBy === LOCAL_ID */
  grabbedBy: string | null;
  grounded: boolean;
  bobPhase: number;
  rotSpeed: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
}

export interface World {
  shapes: Shape[];
  maxShapes: number;
}
