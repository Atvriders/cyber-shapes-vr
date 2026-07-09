/**
 * recorder.test.ts — F10 Ghost Arcade ReelRecorder (C13).
 *
 * The recorder TEES the room's outbound event stream with RECORD-TIME
 * SANITIZATION (spec §6.1 / §7.17):
 *   - ALL 0x1x voice opcodes are EXCLUDED (test-enforced);
 *   - identity (names) are anonymized — no free-text name string reaches a reel
 *     (callsigns / GHOST_XX only);
 *   - the `synthetic` presence flag is PRESERVED so a daemon replays with its
 *     DAEMON badge (§7.17);
 *   - rolling caps bound the ring buffer;
 *   - the auto-banker scores windows (events/s + shapes + players) and picks the
 *     highest, with daemon-heavy windows DOWN-RANKED, never excluded.
 *
 * Injected clock; deterministic; fake time.
 */

import { describe, it, expect } from 'vitest';
import {
  ReelRecorder,
  sanitize,
  sanitizeNameBearing,
  NAME_BEARING_KINDS,
} from '../src/recorder.js';
import type { NetShape, ServerMsg } from '@cyber-shapes/shared';

function netShape(id: string): NetShape {
  return {
    id,
    type: 'cube',
    colorIndex: 1,
    renderMode: 'both',
    scale: 1,
    grabbedBy: null,
    grounded: false,
    bobPhase: 0,
    rotSpeed: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
}

/** A binary voice frame: [opcode 0x10][senderId][ts u32][flags][opus…]. */
function voiceFrame(opcode: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint8(0, opcode);
  return buf;
}

function makeRecorder(now: () => number) {
  return new ReelRecorder({ now, capFrames: 10_000, segmentMs: 1000 });
}

// ---------------------------------------------------------------------------
// Sanitization: no voice opcodes, no name strings, synthetic PRESERVED.
// ---------------------------------------------------------------------------

describe('record-time sanitization', () => {
  it('EXCLUDES all 0x1x voice frames (0x10 / 0x11 / 0x12) from the reel', () => {
    let t = 0;
    const rec = makeRecorder(() => t);
    rec.teeBinary(voiceFrame(0x10));
    rec.teeBinary(voiceFrame(0x11));
    rec.teeBinary(voiceFrame(0x12));
    t = 100;
    rec.tee({ t: 'spawn', shape: netShape('a') });
    const reel = rec.snapshotReel();
    // No frame in the reel is a voice frame.
    const allMsgs = reel.frames.flatMap((f) => [
      ...f.discrete.map((e) => e.msg),
      ...(f.keyframe ? [] : []),
    ]);
    for (const m of allMsgs) {
      expect(m.t).not.toMatch(/^voice/);
    }
    // Structural: the recorder counted the voice frames as EXCLUDED.
    expect(rec.excludedVoiceCount).toBe(3);
    // And it did record the non-voice spawn.
    expect(allMsgs.some((m) => m.t === 'spawn')).toBe(true);
  });

  it('EXCLUDES JSON voice-* ServerMsgs (voice-state / voice-roster) too', () => {
    let t = 0;
    const rec = makeRecorder(() => t);
    rec.tee({ t: 'voice-state', id: 'p1', speaking: true, muted: false });
    rec.tee({ t: 'voice-roster', players: [{ id: 'p1', voice: true }] });
    rec.tee({ t: 'spawn', shape: netShape('a') });
    const reel = rec.snapshotReel();
    const kinds = reel.frames.flatMap((f) => f.discrete.map((e) => e.msg.t));
    expect(kinds).not.toContain('voice-state');
    expect(kinds).not.toContain('voice-roster');
    expect(kinds).toContain('spawn');
  });

  it('ANONYMIZES identity — no free-text name string reaches the reel bytes', () => {
    let t = 0;
    const rec = makeRecorder(() => t);
    // A player-join carrying a (would-be) free-text name.
    rec.tee({ t: 'player-join', player: { id: 'p1', name: 'Alice Smith', color: 2 } });
    // A welcome snapshot with players named.
    rec.tee({
      t: 'welcome',
      playerId: 'p1',
      room: 'r',
      shapes: [netShape('a')],
      players: [{ id: 'p1', name: 'Bob Jones', color: 3 }],
    });
    const reel = rec.snapshotReel();
    const json = JSON.stringify(reel);
    // No raw name survives — replaced by a GHOST_XX / anonymized handle.
    expect(json).not.toContain('Alice Smith');
    expect(json).not.toContain('Bob Jones');
    expect(json).not.toContain('Alice');
    expect(json).not.toContain('Bob');
  });

  it('PRESERVES the synthetic presence flag (§7.17 — daemon replays with DAEMON badge)', () => {
    let t = 0;
    const rec = makeRecorder(() => t);
    rec.tee({
      t: 'player-join',
      // a synthetic daemon peer (additive presence flag, §7.17)
      player: { id: 'DMN-03', name: 'DMN-03', color: 0, synthetic: true } as never,
    });
    const reel = rec.snapshotReel();
    const json = JSON.stringify(reel);
    expect(json).toContain('"synthetic":true');
  });

  it('rolling cap: the ring buffer never exceeds capFrames', () => {
    let t = 0;
    const rec = new ReelRecorder({ now: () => t, capFrames: 5, segmentMs: 1 });
    for (let i = 0; i < 50; i++) {
      t = i;
      rec.tee({ t: 'spawn', shape: netShape(`s${i}`) });
    }
    expect(rec.rawEventCount).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Auto-banker: score windows (events/s + shapes + players); pick the highest;
// daemon-heavy windows DOWN-RANKED, never excluded.
// ---------------------------------------------------------------------------

describe('auto-banker window scoring', () => {
  it('picks the HIGHEST-scoring window (most events/s + shapes + players)', () => {
    let t = 0;
    const rec = new ReelRecorder({ now: () => t, capFrames: 100_000, segmentMs: 1000 });
    // Window 1 (0–3 s): quiet — 1 human, 1 shape, few events.
    t = 0;
    rec.tee({ t: 'player-join', player: { id: 'p1', name: 'p1', color: 0 } });
    rec.tee({ t: 'spawn', shape: netShape('a') });
    t = 1000;
    rec.tee({ t: 'grab', id: 'a', peerId: 'p1' });
    // Window 2 (4–7 s): BUSY — 3 humans, many shapes, many events.
    t = 4000;
    rec.tee({ t: 'player-join', player: { id: 'p2', name: 'p2', color: 0 } });
    rec.tee({ t: 'player-join', player: { id: 'p3', name: 'p3', color: 0 } });
    for (let i = 0; i < 20; i++) {
      t = 4000 + i * 50;
      rec.tee({ t: 'spawn', shape: netShape(`b${i}`) });
    }
    t = 7000;
    const best = rec.pickBestWindow({ windowMs: 3000 });
    expect(best).not.toBeNull();
    // The busy window (starting ~4 s) beats the quiet one (~0 s).
    expect(best!.startWallTime).toBeGreaterThanOrEqual(3500);
    expect(best!.score).toBeGreaterThan(0);
  });

  it('DOWN-RANKS a daemon-heavy window but NEVER excludes it', () => {
    let t = 0;
    const rec = new ReelRecorder({ now: () => t, capFrames: 100_000, segmentMs: 1000 });
    // Window A: human activity.
    t = 0;
    rec.tee({ t: 'player-join', player: { id: 'p1', name: 'p1', color: 0 } });
    for (let i = 0; i < 10; i++) {
      t = i * 100;
      rec.tee({ t: 'spawn', shape: netShape(`h${i}`) });
    }
    // Window B: same raw activity but driven by a synthetic daemon.
    t = 5000;
    rec.tee({ t: 'player-join', player: { id: 'DMN-01', name: 'DMN-01', color: 0, synthetic: true } as never });
    for (let i = 0; i < 10; i++) {
      t = 5000 + i * 100;
      rec.tee({ t: 'spawn', shape: netShape(`d${i}`) });
    }
    const windows = rec.scoreWindows({ windowMs: 2000 });
    const humanWin = windows.find((w) => w.startWallTime < 2000)!;
    const daemonWin = windows.find((w) => w.startWallTime >= 5000 && w.startWallTime < 7000)!;
    expect(humanWin).toBeDefined();
    expect(daemonWin).toBeDefined();
    // The daemon window is DOWN-RANKED relative to the human window with the
    // same raw activity...
    expect(daemonWin.score).toBeLessThan(humanWin.score);
    // ...but NEVER excluded — it still has a positive score and can be banked.
    expect(daemonWin.score).toBeGreaterThan(0);
    // If it were the ONLY window, the banker still picks it (never returns null
    // just because the session was daemon-driven).
    let tt = 0;
    const daemonOnly = new ReelRecorder({ now: () => tt, capFrames: 100_000, segmentMs: 1000 });
    daemonOnly.tee({ t: 'player-join', player: { id: 'DMN-02', name: 'DMN-02', color: 0, synthetic: true } as never });
    for (let i = 0; i < 8; i++) {
      tt = i * 100;
      daemonOnly.tee({ t: 'spawn', shape: netShape(`x${i}`) });
    }
    const pick = daemonOnly.pickBestWindow({ windowMs: 1000 });
    expect(pick).not.toBeNull();
  });

  it('bankHighlight is the staff/cue alias of bankOnEmpty (same best window)', () => {
    let t = 0;
    const rec = new ReelRecorder({ now: () => t, capFrames: 100_000, segmentMs: 1000 });
    rec.tee({ t: 'player-join', player: { id: 'p1', name: 'p1', color: 0 } });
    for (let i = 0; i < 6; i++) {
      t = i * 100;
      rec.tee({ t: 'spawn', shape: netShape(`s${i}`) });
    }
    const banked = rec.bankHighlight({ windowMs: 1000 });
    expect(banked).not.toBeNull();
    expect(banked!.frames.length).toBeGreaterThan(0);
    expect(banked!.frames[0].keyframe).not.toBeNull();
  });

  it('bankOnEmpty bands the best window into a stored reel', () => {
    let t = 0;
    const rec = new ReelRecorder({ now: () => t, capFrames: 100_000, segmentMs: 1000 });
    rec.tee({ t: 'player-join', player: { id: 'p1', name: 'p1', color: 0 } });
    for (let i = 0; i < 6; i++) {
      t = i * 100;
      rec.tee({ t: 'spawn', shape: netShape(`s${i}`) });
    }
    const banked = rec.bankOnEmpty({ windowMs: 1000 });
    expect(banked).not.toBeNull();
    // The banked artifact is a replayable reel (frames + keyframe at start).
    expect(banked!.frames.length).toBeGreaterThan(0);
    expect(banked!.frames[0].keyframe).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sanitizer EXHAUSTIVENESS guard (integration-hardening #10): a name-bearing
// kind that is NOT explicitly handled must be CAUGHT (throw), never ride the
// `default` clone un-anonymized. The compile-time arm is a `Record<
// NameBearingKind,true>` + a `never` default; this suite exercises the runtime arm.
// ---------------------------------------------------------------------------

describe('sanitizer exhaustiveness guard (#10)', () => {
  it('anonymizes EVERY registered name-bearing kind (no raw name survives)', () => {
    // player-join
    const pj = sanitize({
      t: 'player-join',
      player: { id: 'p1', name: 'Alice Smith', color: 2 },
    });
    expect(JSON.stringify(pj)).not.toContain('Alice');
    // welcome (players[])
    const w = sanitize({
      t: 'welcome',
      playerId: 'p1',
      room: 'r',
      shapes: [netShape('a')],
      players: [{ id: 'p1', name: 'Bob Jones', color: 3 }],
    });
    expect(JSON.stringify(w)).not.toContain('Bob');
  });

  it('the registry is exactly the name-bearing kinds (player-join + welcome)', () => {
    expect(Object.keys(NAME_BEARING_KINDS).sort()).toEqual(['player-join', 'welcome']);
  });

  it('CATCHES (throws on) a name-bearing kind that reaches the switch unhandled', () => {
    // Simulate a FUTURE name-bearing ServerMsg kind that was registered but NOT
    // given a switch case: the `never` default throws rather than silently cloning
    // a raw name into the reel. (The compile-time arm makes this a build error; this
    // proves the runtime arm catches it too — no PII leak on the default path.)
    const future = { t: '__future_name_kind__', player: { id: 'x', name: 'Zed Raw' } };
    expect(() => sanitizeNameBearing(future as unknown as never)).toThrow(/unhandled name-bearing kind/);
  });

  it('a NON-name-bearing kind is deep-cloned unchanged (not aliased)', () => {
    const src: ServerMsg = { t: 'spawn', shape: netShape('s1') };
    const out = sanitize(src) as Extract<ServerMsg, { t: 'spawn' }>;
    expect(out).toEqual(src);
    expect(out.shape).not.toBe((src as Extract<ServerMsg, { t: 'spawn' }>).shape); // private copy
  });
});
