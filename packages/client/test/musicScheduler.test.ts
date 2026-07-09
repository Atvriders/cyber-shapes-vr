/**
 * musicScheduler.test.ts — the client MUSIC receive → synth scheduler (C22, F8).
 *
 * The scheduler takes decoded MUSIC frames (a CLOCK grid + per-impact NOTES) and
 * SCHEDULES each note to fire on its server-aligned grid line via the shared
 * fire-at-server-time scheduler. Tested against a MOCK synth + a FAKE timer — no
 * real AudioContext (real Web Audio playback is owner/hardware-verified):
 *   • a CLOCK updates the shared grid (bpm/beat/origin);
 *   • a NOTE fires synth.play at (playAtMs − offset) local time, right pitch;
 *   • a past-deadline note is DROPPED ('skip'), never fired off-beat;
 *   • a runaway-future note is DROPPED by the lookahead guard;
 *   • the audio gate + clear() suppress / cancel scheduling.
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi } from '@cyber-shapes/shared';
import { MusicScheduler, type NoteSink } from '../src/music/musicScheduler.ts';
import type { PlayNote } from '../src/music/synth.ts';

// ---- Fake timer (controllable now + fire-on-advance) ------------------------
function makeFakeTimer() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const api: TimerApi = {
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimeout: (h: unknown) => {
      timers.delete(h as number);
    },
  };
  return {
    api,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
      // Fire all due timers in chronological order.
      const due = [...timers.entries()]
        .filter(([, x]) => x.at <= t)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, x] of due) {
        if (timers.delete(id)) x.cb();
      }
    },
  };
}

// ---- Mock synth (records what was played) -----------------------------------
class MockSynth implements NoteSink {
  played: PlayNote[] = [];
  play(note: PlayNote): boolean {
    this.played.push(note);
    return true;
  }
}

describe('MusicScheduler — CLOCK grid + NOTE scheduling (C22)', () => {
  it('a CLOCK frame updates the shared grid (bpm/beat/origin)', () => {
    const timer = makeFakeTimer();
    const sched = new MusicScheduler(new MockSynth(), { timerApi: timer.api });
    expect(sched.hasClock).toBe(false);
    sched.onFrame({ kind: 'clock', bpm: 120, beatIndex: 42, gridOriginMs: 1000 });
    expect(sched.hasClock).toBe(true);
    expect(sched.bpm).toBe(120);
    expect(sched.beatIndex).toBe(42);
    expect(sched.gridOriginMs).toBe(1000);
  });

  it('schedules a NOTE to fire at (playAtMs − offset) local time with the right pitch', () => {
    const timer = makeFakeTimer();
    timer.set(1000);
    const synth = new MockSynth();
    // offset = 500 → server time = local + 500. A note at server playAtMs=2000
    // fires at local 1500 (500 ms from now).
    const sched = new MusicScheduler(synth, { timerApi: timer.api, offsetMs: () => 500 });
    sched.onFrame({ kind: 'clock', bpm: 120, beatIndex: 0, gridOriginMs: 0 });
    sched.onFrame({
      kind: 'note',
      noteId: 7,
      playAtMs: 2000,
      pitch: 69,
      timbre: 0,
      velocity: 100,
      pan: 0,
    });

    // Not fired yet — armed 500 ms out.
    expect(synth.played).toHaveLength(0);
    expect(sched.pendingCount).toBe(1);

    timer.advance(499);
    expect(synth.played).toHaveLength(0);
    timer.advance(1); // now local 1500 == the grid line
    expect(synth.played).toHaveLength(1);
    expect(synth.played[0].pitch).toBe(69);
    expect(synth.played[0].noteId).toBe(7);
    expect(sched.pendingCount).toBe(0);
  });

  it('DROPS a NOTE whose grid line already passed (skip — never off-beat)', () => {
    const timer = makeFakeTimer();
    timer.set(3000); // local now well past the note's local fire time (1500)
    const synth = new MockSynth();
    const sched = new MusicScheduler(synth, { timerApi: timer.api, offsetMs: () => 500 });
    sched.onFrame({
      kind: 'note',
      noteId: 8,
      playAtMs: 2000, // local fire = 1500 < now 3000 → skip
      pitch: 60,
      timbre: 0,
      velocity: 80,
      pan: 0,
    });
    timer.advance(10_000);
    expect(synth.played.find((n) => n.noteId === 8)).toBeUndefined();
  });

  it('DROPS a runaway-future NOTE beyond the lookahead horizon', () => {
    const timer = makeFakeTimer();
    timer.set(0);
    const synth = new MockSynth();
    const sched = new MusicScheduler(synth, {
      timerApi: timer.api,
      offsetMs: () => 0,
      maxLookaheadMs: 5000,
    });
    sched.onFrame({
      kind: 'note',
      noteId: 9,
      playAtMs: 100_000, // 100 s out ≫ 5 s horizon → dropped, never armed
      pitch: 60,
      timbre: 0,
      velocity: 80,
      pan: 0,
    });
    expect(sched.pendingCount).toBe(0);
    timer.advance(200_000);
    expect(synth.played.find((n) => n.noteId === 9)).toBeUndefined();
  });

  it('the audio gate (isEnabled=false) suppresses scheduling', () => {
    const timer = makeFakeTimer();
    timer.set(0);
    const synth = new MockSynth();
    let enabled = false;
    const sched = new MusicScheduler(synth, {
      timerApi: timer.api,
      offsetMs: () => 0,
      isEnabled: () => enabled,
    });
    sched.onFrame({ kind: 'note', noteId: 10, playAtMs: 500, pitch: 60, timbre: 0, velocity: 80, pan: 0 });
    expect(sched.pendingCount).toBe(0);
    timer.advance(1000);
    expect(synth.played).toHaveLength(0);

    // Once enabled, a fresh note schedules + fires.
    enabled = true;
    timer.set(0);
    sched.onFrame({ kind: 'note', noteId: 11, playAtMs: 500, pitch: 64, timbre: 0, velocity: 80, pan: 0 });
    timer.advance(500);
    expect(synth.played.map((n) => n.noteId)).toContain(11);
  });

  it('clear() cancels every armed note timer', () => {
    const timer = makeFakeTimer();
    timer.set(0);
    const synth = new MockSynth();
    const sched = new MusicScheduler(synth, { timerApi: timer.api, offsetMs: () => 0 });
    sched.onFrame({ kind: 'note', noteId: 12, playAtMs: 1000, pitch: 60, timbre: 0, velocity: 80, pan: 0 });
    expect(sched.pendingCount).toBe(1);
    sched.clear();
    expect(sched.pendingCount).toBe(0);
    timer.advance(5000);
    expect(synth.played).toHaveLength(0);
  });
});
