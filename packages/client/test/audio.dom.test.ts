/**
 * audio.dom.test.ts — runs under jsdom (matched by vitest environmentMatchGlobs)
 *
 * AudioContext does not exist in jsdom, so we install a mock on globalThis
 * before importing the module under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock AudioContext ──────────────────────────────────────────────────────────

interface MockNode {
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  frequency: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  type: string;
  buffer: unknown;
}

interface MockAudioContext {
  state: 'suspended' | 'running' | 'closed';
  sampleRate: number;
  currentTime: number;
  destination: object;
  constructorOptions: AudioContextOptions | undefined;
  oscillatorsCreated: number;
  gainNodesCreated: number;
  bufferSourcesCreated: number;
  biquadFiltersCreated: number;
  resume: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createBiquadFilter: ReturnType<typeof vi.fn>;
}

let mockCtxInstance: MockAudioContext;
let capturedConstructorOptions: AudioContextOptions | undefined;

function makeMockNode(): MockNode {
  return {
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    type: 'sine',
    buffer: null,
  };
}

class MockAudioContextClass {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  constructorOptions: AudioContextOptions | undefined;
  oscillatorsCreated = 0;
  gainNodesCreated = 0;
  bufferSourcesCreated = 0;
  biquadFiltersCreated = 0;
  resume = vi.fn().mockResolvedValue(undefined);

  constructor(options?: AudioContextOptions) {
    capturedConstructorOptions = options;
    this.constructorOptions = options;
    mockCtxInstance = this as unknown as MockAudioContext;
  }

  createOscillator() {
    this.oscillatorsCreated++;
    return makeMockNode();
  }
  createGain() {
    this.gainNodesCreated++;
    return makeMockNode();
  }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    return {
      getChannelData: vi.fn(() => new Float32Array(length)),
      numberOfChannels: _ch,
      sampleRate,
    };
  }
  createBufferSource() {
    this.bufferSourcesCreated++;
    return makeMockNode();
  }
  createBiquadFilter() {
    this.biquadFiltersCreated++;
    return makeMockNode();
  }
}

// Install mock before any module import
(globalThis as unknown as Record<string, unknown>).AudioContext = MockAudioContextClass;

// ── Import module under test ───────────────────────────────────────────────────

// Dynamic import so the mock is installed first (static imports are hoisted)
const { initAudio } = await import('../src/audio.ts');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('initAudio()', () => {
  let audio: ReturnType<typeof initAudio>;

  beforeEach(() => {
    capturedConstructorOptions = undefined;
    // Re-create fresh instance per test by resetting module state
    audio = initAudio();
    // Reset counters on the shared instance
    mockCtxInstance.oscillatorsCreated = 0;
    mockCtxInstance.gainNodesCreated = 0;
    mockCtxInstance.bufferSourcesCreated = 0;
    mockCtxInstance.biquadFiltersCreated = 0;
  });

  it('constructs AudioContext with sampleRate: 48000', () => {
    expect(capturedConstructorOptions).toEqual({ sampleRate: 48000 });
  });

  it('returns ctx with the constructed AudioContext instance', () => {
    expect(audio.ctx).toBe(mockCtxInstance);
  });

  it('exposes resume, playSpawn, playGrab, playRelease, playImpact', () => {
    expect(typeof audio.resume).toBe('function');
    expect(typeof audio.playSpawn).toBe('function');
    expect(typeof audio.playGrab).toBe('function');
    expect(typeof audio.playRelease).toBe('function');
    expect(typeof audio.playImpact).toBe('function');
  });

  describe('when ctx.state === "suspended" (before user gesture)', () => {
    beforeEach(() => {
      mockCtxInstance.state = 'suspended';
    });

    it('playSpawn() does NOT throw and creates no oscillator', () => {
      expect(() => audio.playSpawn()).not.toThrow();
      expect(mockCtxInstance.oscillatorsCreated).toBe(0);
    });

    it('playGrab() does NOT throw and creates no oscillator', () => {
      expect(() => audio.playGrab()).not.toThrow();
      expect(mockCtxInstance.oscillatorsCreated).toBe(0);
    });

    it('playRelease() does NOT throw and creates no oscillator', () => {
      expect(() => audio.playRelease()).not.toThrow();
      expect(mockCtxInstance.oscillatorsCreated).toBe(0);
    });

    it('playImpact() does NOT throw and creates no buffer source', () => {
      expect(() => audio.playImpact()).not.toThrow();
      expect(mockCtxInstance.bufferSourcesCreated).toBe(0);
    });

    it('playImpact(v) with argument does NOT throw', () => {
      expect(() => audio.playImpact(0.9)).not.toThrow();
      expect(mockCtxInstance.bufferSourcesCreated).toBe(0);
    });
  });

  describe('when ctx.state === "running"', () => {
    beforeEach(() => {
      mockCtxInstance.state = 'running';
    });

    it('playSpawn() creates an oscillator and gain node', () => {
      audio.playSpawn();
      expect(mockCtxInstance.oscillatorsCreated).toBe(1);
      expect(mockCtxInstance.gainNodesCreated).toBeGreaterThanOrEqual(1);
    });

    it('playGrab() creates an oscillator and gain node', () => {
      audio.playGrab();
      expect(mockCtxInstance.oscillatorsCreated).toBe(1);
      expect(mockCtxInstance.gainNodesCreated).toBeGreaterThanOrEqual(1);
    });

    it('playRelease() creates an oscillator and gain node', () => {
      audio.playRelease();
      expect(mockCtxInstance.oscillatorsCreated).toBe(1);
      expect(mockCtxInstance.gainNodesCreated).toBeGreaterThanOrEqual(1);
    });

    it('playImpact() creates a buffer source node', () => {
      audio.playImpact();
      expect(mockCtxInstance.bufferSourcesCreated).toBe(1);
    });

    it('playImpact(v) accepts optional velocity argument without throwing', () => {
      expect(() => audio.playImpact(0.5)).not.toThrow();
      expect(mockCtxInstance.bufferSourcesCreated).toBe(1);
    });
  });

  describe('resume()', () => {
    it('calls ctx.resume() when state is suspended', async () => {
      mockCtxInstance.state = 'suspended';
      await audio.resume();
      expect(mockCtxInstance.resume).toHaveBeenCalled();
    });

    it('returns a Promise', () => {
      const result = audio.resume();
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
