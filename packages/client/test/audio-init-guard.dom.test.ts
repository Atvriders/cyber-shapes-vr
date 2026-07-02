/**
 * audio-init-guard.dom.test.ts — regression for audit #20.
 *
 * initAudio() must not let an AudioContext construction failure abort the app.
 * When `new AudioContext(...)` throws, initAudio() returns a safe NO-OP AudioApi
 * (ctx=null; resume/play* are no-throw no-ops) so the whole app still runs
 * without sound.
 *
 * Runs under jsdom (AudioContext is not defined there by default) — we install a
 * THROWING AudioContext so this test would FAIL against the pre-fix code (which
 * constructed the context unguarded and let the throw propagate out of initAudio).
 */

import { describe, expect, it, vi } from 'vitest';

describe('initAudio() — construction-failure guard (audit #20)', () => {
  it('returns a no-op API (does NOT throw) when AudioContext construction throws', async () => {
    vi.resetModules();
    // Install an AudioContext whose constructor throws.
    class ThrowingAudioContext {
      constructor() {
        throw new Error('AudioContext unsupported / hardened');
      }
    }
    (globalThis as unknown as Record<string, unknown>).AudioContext = ThrowingAudioContext;

    const { initAudio } = await import('../src/audio.ts');

    // Pre-fix: this call threw. Post-fix: it resolves to a no-op API.
    let audio!: ReturnType<typeof initAudio>;
    expect(() => {
      audio = initAudio();
    }).not.toThrow();

    // ctx is null in the degraded state.
    expect(audio.ctx).toBeNull();

    // Every play*/resume is a no-throw no-op.
    expect(() => audio.playSpawn()).not.toThrow();
    expect(() => audio.playGrab()).not.toThrow();
    expect(() => audio.playRelease()).not.toThrow();
    expect(() => audio.playImpact()).not.toThrow();
    expect(() => audio.playImpact(0.9)).not.toThrow();
    await expect(audio.resume()).resolves.toBeUndefined();
  });

  it('returns a working API (ctx non-null) when AudioContext constructs fine', async () => {
    vi.resetModules();
    let constructed = false;
    class OkAudioContext {
      state = 'suspended';
      constructor() {
        constructed = true;
      }
    }
    (globalThis as unknown as Record<string, unknown>).AudioContext = OkAudioContext;

    const { initAudio } = await import('../src/audio.ts');
    const audio = initAudio();
    expect(constructed).toBe(true);
    expect(audio.ctx).not.toBeNull();
  });
});
