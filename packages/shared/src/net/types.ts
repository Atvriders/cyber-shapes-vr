import type { ShapeType, RenderMode } from '../types.js';

export const MAX_PLAYERS = 8;
export const PROTOCOL_VERSION = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

// Full serializable shape state (superset of Phase A Shape: adds position+rotation as plain data)
export interface NetShape {
  id: string;
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  grabbedBy: string | null;
  grounded: boolean;
  bobPhase: number;
  rotSpeed: Vec3;
  position: Vec3;
  rotation: Vec3;
  velocity: Vec3;
}
export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
}
export interface Pose {
  head: { p: Vec3; q: Quat };
  hands: Array<{ p: Vec3; q: Quat } | null>;
}

// Client -> Server
export type ClientMsg =
  | { t: 'join'; room: string; name: string; color: number; protocol: number }
  | {
      t: 'spawn';
      shape: {
        type: ShapeType;
        position: Vec3;
        colorIndex?: number;
        renderMode?: RenderMode;
        scale?: number;
      };
      tempId?: string;
    }
  | { t: 'grab'; id: string }
  | { t: 'release'; id: string; velocity: Vec3; position: Vec3; rotation: Vec3 }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  | { t: 'held'; id: string; position: Vec3; rotation: Vec3 } // streamed while holding (throttled)
  | { t: 'pose'; pose: Pose } // throttled
  | { t: 'voice-join' }
  | { t: 'voice-leave' }
  | { t: 'voice-state'; speaking: boolean; muted: boolean }
  | { t: 'voice-config'; config: string };

// Server -> Client
export type ServerMsg =
  | { t: 'welcome'; playerId: string; room: string; shapes: NetShape[]; players: PlayerInfo[] }
  | { t: 'player-join'; player: PlayerInfo }
  | { t: 'player-leave'; id: string }
  | { t: 'spawn'; shape: NetShape; tempId?: string } // tempId: opaque echo of the client's local id for prediction reconciliation
  | { t: 'despawn'; id: string }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  | { t: 'grab'; id: string; peerId: string | null } // peerId null = released
  | { t: 'state'; seq: number; shapes: Array<{ id: string; p: Vec3; r: Vec3; v: Vec3 }> } // ~15-20Hz, moving shapes only
  | { t: 'pose'; id: string; pose: Pose } // relayed peer pose
  | { t: 'voice-roster'; players: Array<{ id: string; voice: boolean }> }
  | { t: 'voice-state'; id: string; speaking: boolean; muted: boolean }
  | { t: 'error'; code: string; message: string };

// Binary voice frame (the ONLY binary message): [opcode u8][senderId u8][timestampMs u32 LE][flags u8][opus bytes]
// opcodes: 0x10 VOICE_OPUS, 0x11 VOICE_WEBM, 0x12 VOICE_PCM. Server stamps senderId, fans out to room (excl sender).
