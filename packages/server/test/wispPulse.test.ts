/**
 * Task C14 — Server WISP_PULSE validation tests (spec §7.4).
 *
 * The server NEVER trusts the client-sent impulse magnitude: `applyWispPulse`
 * clamps it to `WISP_PULSE_MAX_IMPULSE` (anti-cheat) and applies the resulting
 * radial impulse to the live world via the shared, seeded `applyRadialImpulse`.
 * The unclamped cosmetic feedback (tracer / flash / shockwave) is a CLIENT
 * concern and is not modelled here.
 *
 * Also asserts the WISP_POSE golden round-trip through the C1 codec (Appendix B),
 * never a local byte layout.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeBinary,
  decodeBinary,
  OPCODES,
  WISP_KIND,
  WISP_PULSE_MAX_IMPULSE,
} from '@cyber-shapes/shared';
import { Room } from '../src/room.js';
import { applyWispPulse } from '../src/room.js';

let idc = 0;
const idFactory = () => `s${++idc}`;

function makeRoomWithShapeAt(x: number, y: number, z: number): { room: Room; id: string } {
  idc = 0;
  const room = new Room('R', idFactory);
  const spawned = room.world.spawn({ type: 'cube', position: { x, y, z }, colorIndex: 0 });
  return { room, id: spawned!.shape.id };
}

describe('WISP_POSE golden round-trip (Appendix B via the C1 codec)', () => {
  it('encodes → decodes the WISP_POSE golden fields byte-for-byte', () => {
    const fields = { wispIndex: 7, pos: [1000, -500, 250], yaw: 16384, reserved: 0 };
    const buf = encodeBinary(OPCODES.WISP, WISP_KIND.POSE, fields);
    // The Appendix B golden hex: 260207e8030cfefa00004000
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('260207e8030cfefa00004000');
    const decoded = decodeBinary(buf);
    expect(decoded.opcode).toBe(OPCODES.WISP);
    expect(decoded.kind).toBe(WISP_KIND.POSE);
    expect(decoded.fields.wispIndex).toBe(7);
    expect(decoded.fields.pos).toEqual([1000, -500, 250]);
    expect(decoded.fields.yaw).toBe(16384);
  });
});

describe('applyWispPulse — server-clamped radial impulse', () => {
  it('CLAMPS a huge client magnitude to the server max, regardless of the client value', () => {
    const { room, id } = makeRoomWithShapeAt(2, 3, 0);
    const before = room.world.get(id)!;
    before.velocity = { x: 0, y: 0, z: 0 };
    before.grounded = false;

    // A cheating client claims a colossal magnitude.
    applyWispPulse(room, { x: 0, y: 3, z: 0 }, 1e9, 42);
    const cheatSpeed = Math.hypot(
      room.world.get(id)!.velocity.x,
      room.world.get(id)!.velocity.y,
      room.world.get(id)!.velocity.z
    );

    // The SAME geometry with the clamp value applied directly must match — proving
    // the applied impulse used the clamp, not the client's 1e9.
    const ctrl = makeRoomWithShapeAt(2, 3, 0);
    const cb = ctrl.room.world.get(ctrl.id)!;
    cb.velocity = { x: 0, y: 0, z: 0 };
    cb.grounded = false;
    applyWispPulse(ctrl.room, { x: 0, y: 3, z: 0 }, WISP_PULSE_MAX_IMPULSE, 42);
    const clampSpeed = Math.hypot(cb.velocity.x, cb.velocity.y, cb.velocity.z);

    expect(cheatSpeed).toBeCloseTo(clampSpeed, 6);
    // And the resulting speed is bounded — never the 1e9 the client asked for.
    expect(cheatSpeed).toBeLessThanOrEqual(WISP_PULSE_MAX_IMPULSE + 1e-6);
    expect(cheatSpeed).toBeGreaterThan(0);
  });

  it('never trusts a negative client magnitude (no suction impulse)', () => {
    const { room, id } = makeRoomWithShapeAt(2, 3, 0);
    const b = room.world.get(id)!;
    b.velocity = { x: 0, y: 0, z: 0 };
    b.grounded = false;
    applyWispPulse(room, { x: 0, y: 3, z: 0 }, -1e6, 7);
    const speed = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);
    expect(speed).toBe(0); // clamped to 0 → no velocity change
  });

  it('is deterministic given the same seed (seeded jitter, no Math.random)', () => {
    const a = makeRoomWithShapeAt(1, 4, -2);
    const av = a.room.world.get(a.id)!;
    av.velocity = { x: 0, y: 0, z: 0 };
    av.grounded = false;
    applyWispPulse(a.room, { x: 0, y: 2, z: 0 }, 5, 99);

    const b = makeRoomWithShapeAt(1, 4, -2);
    const bv = b.room.world.get(b.id)!;
    bv.velocity = { x: 0, y: 0, z: 0 };
    bv.grounded = false;
    applyWispPulse(b.room, { x: 0, y: 2, z: 0 }, 5, 99);

    expect(av.velocity).toEqual(bv.velocity);
  });

  it('leaves grabbed shapes untouched (applyRadialImpulse skips held bodies)', () => {
    const { room, id } = makeRoomWithShapeAt(2, 3, 0);
    const b = room.world.get(id)!;
    b.velocity = { x: 0, y: 0, z: 0 };
    b.grounded = false;
    b.grabbedBy = 'p1';
    applyWispPulse(room, { x: 0, y: 3, z: 0 }, WISP_PULSE_MAX_IMPULSE, 1);
    expect(Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)).toBe(0);
  });
});
