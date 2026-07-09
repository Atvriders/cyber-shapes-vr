/**
 * events.ts — the SINGLE-SOURCE ServerMsg → RoomEvent adapter (C0 binding 14).
 *
 * Extracted from the C9 stage entry (spec §7.22, plan C33) so BOTH the stage
 * (`stage/stage.ts`) and the desktop AUTO camera (`desktop/cameras.ts`) consume
 * the identical message→RoomEvent mapping WITHOUT the desktop main chunk having to
 * import stage-only code (the "no stage-entry import into the main chunk"
 * invariant — verified by the size gate). This resolves C9's noted deferral: the
 * function lived in stage.ts with a "kept here for C9, noted for the move" comment.
 *
 * PURE — no THREE, no DOM, no I/O. The one normalization point from the wire union
 * residents/spectators receive to the brain-facing `RoomEvent`. Returns null for
 * messages that carry no brain-relevant event.
 */

import type { ServerMsg, RoomEvent } from '@cyber-shapes/shared';
import { VOTE_KIND } from '@cyber-shapes/shared';

/** |v| of a 3-vector, or 0 if absent. */
function vmag(v: { x: number; y: number; z: number } | undefined): number {
  if (!v) return 0;
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Map one ServerMsg to a RoomEvent for the shot brain, or null if irrelevant. */
export function serverMsgToRoomEvent(msg: ServerMsg): RoomEvent | null {
  switch (msg.t) {
    case 'player-join':
      return { kind: 'join', peerId: msg.player.id };
    case 'player-leave':
      return { kind: 'leave', peerId: msg.id };
    case 'spawn':
      return { kind: 'spawn', id: msg.shape.id };
    case 'despawn':
      return { kind: 'despawn', id: msg.id };
    case 'grab':
      // peerId non-null = grabbed; null = released (accommodation #5 carries the
      // server-computed final {pos,vel} — |vel| is the FOLLOW_THROW trigger).
      if (msg.peerId === null) {
        return { kind: 'release', id: msg.id, peerId: '', speed: vmag(msg.vel) };
      }
      return { kind: 'grab', id: msg.id, peerId: msg.peerId };
    case 'vote':
      // C15 §7.5 "big screen owns the drama": the RESULT triggers the WIDE_ESTABLISH
      // money-shot. Map to an ordinary `vote` RoomEvent so the brain treats it as
      // activity (no cut by itself — the stage calls requestShot for WIDE_ESTABLISH).
      if (msg.kind === VOTE_KIND.RESULT) {
        return { kind: 'vote', peerId: 'election' };
      }
      return null;
    default:
      // welcome / recolor / rendermode / scale / state / pose / voice-* / hello /
      // downgrade / roster / director-ack / grab-rejected / wisp-coalesced / error
      // carry no v1 shot-brain trigger. (impact rides `state.shapes[].s`; C13/C21
      // consume the fuller stream — the brain treats those as ordinary activity.)
      return null;
  }
}
