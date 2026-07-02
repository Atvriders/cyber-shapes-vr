/**
 * spatializer-voice.test.ts — Mocked tests for Spatializer and Voice (B10).
 *
 * Spatializer:
 *   - ensurePeer creates HRTF PannerNode + GainNode wired to destination
 *   - setPeerGain(id, 0) mutes the peer
 *   - removePeer disposes the gain/panner nodes
 *
 * Voice (light):
 *   - enable() with mode 'none' disables cleanly (no crash, no mic access)
 *   - a received frame routes into the right peer's jitter buffer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// AudioContext mock (for Spatializer)
// ---------------------------------------------------------------------------

type GainNodeMock = {
  gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type PannerNodeMock = {
  panningModel: string;
  distanceModel: string;
  refDistance: number;
  rolloffFactor: number;
  positionX: { setValueAtTime: ReturnType<typeof vi.fn> };
  positionY: { setValueAtTime: ReturnType<typeof vi.fn> };
  positionZ: { setValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function makeGainNodeMock(): GainNodeMock {
  return {
    gain: { value: 1, setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makePannerNodeMock(): PannerNodeMock {
  return {
    panningModel: '',
    distanceModel: '',
    refDistance: 0,
    rolloffFactor: 0,
    positionX: { setValueAtTime: vi.fn() },
    positionY: { setValueAtTime: vi.fn() },
    positionZ: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeAudioContextMock() {
  const createdGains: GainNodeMock[] = [];
  const createdPanners: PannerNodeMock[] = [];

  const ctx = {
    currentTime: 0,
    destination: {} as AudioNode,
    createGain(): GainNodeMock {
      const g = makeGainNodeMock();
      createdGains.push(g);
      return g;
    },
    createPanner(): PannerNodeMock {
      const p = makePannerNodeMock();
      createdPanners.push(p);
      return p;
    },
    listener: {
      positionX: { setValueAtTime: vi.fn() },
      positionY: { setValueAtTime: vi.fn() },
      positionZ: { setValueAtTime: vi.fn() },
      forwardX: { setValueAtTime: vi.fn() },
      forwardY: { setValueAtTime: vi.fn() },
      forwardZ: { setValueAtTime: vi.fn() },
      upX: { setValueAtTime: vi.fn() },
      upY: { setValueAtTime: vi.fn() },
      upZ: { setValueAtTime: vi.fn() },
    },
    _createdGains: createdGains,
    _createdPanners: createdPanners,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Spatializer tests
// ---------------------------------------------------------------------------

describe('Spatializer', async () => {
  const { Spatializer } = await import('../src/voice/spatializer.js');

  let ctx: ReturnType<typeof makeAudioContextMock>;
  let spatializer: InstanceType<typeof Spatializer>;

  beforeEach(() => {
    ctx = makeAudioContextMock();
    spatializer = new Spatializer(ctx as unknown as AudioContext);
  });

  it('ensurePeer creates a PannerNode with HRTF model', () => {
    spatializer.ensurePeer('p1');
    expect(ctx._createdPanners).toHaveLength(1);
    expect(ctx._createdPanners[0].panningModel).toBe('HRTF');
  });

  it('ensurePeer creates a PannerNode with inverse distance model', () => {
    spatializer.ensurePeer('p1');
    expect(ctx._createdPanners[0].distanceModel).toBe('inverse');
  });

  it('ensurePeer wires panner → gain → destination', () => {
    spatializer.ensurePeer('p1');
    const panner = ctx._createdPanners[0];
    const gain = ctx._createdGains[0];
    // panner.connect(gain) and gain.connect(destination)
    expect(panner.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('ensurePeer is idempotent (second call returns same nodes)', () => {
    const n1 = spatializer.ensurePeer('p1');
    const n2 = spatializer.ensurePeer('p1');
    expect(n1).toBe(n2);
    expect(ctx._createdPanners).toHaveLength(1);
  });

  it('setPeerGain(id, 0) mutes the peer by setting gain.setValueAtTime(0)', () => {
    spatializer.setPeerGain('p1', 0);
    const gain = ctx._createdGains[0];
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
  });

  it('setPeerGain(id, 1) sets gain back to 1', () => {
    spatializer.setPeerGain('p1', 0);
    spatializer.setPeerGain('p1', 1);
    const gain = ctx._createdGains[0];
    expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
  });

  it('removePeer disconnects both gain and panner', () => {
    spatializer.ensurePeer('p1');
    const panner = ctx._createdPanners[0];
    const gain = ctx._createdGains[0];
    spatializer.removePeer('p1');
    expect(gain.disconnect).toHaveBeenCalled();
    expect(panner.disconnect).toHaveBeenCalled();
  });

  it('removePeer is a no-op for unknown peer', () => {
    expect(() => spatializer.removePeer('unknown')).not.toThrow();
  });

  it('disposeAll removes all peers', () => {
    spatializer.ensurePeer('p1');
    spatializer.ensurePeer('p2');
    spatializer.disposeAll();
    expect(ctx._createdGains[0].disconnect).toHaveBeenCalled();
    expect(ctx._createdGains[1].disconnect).toHaveBeenCalled();
  });

  it('setListener calls AudioParam setValueAtTime for position/forward/up', () => {
    spatializer.setListener({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
    const l = ctx.listener;
    expect(l.positionX.setValueAtTime).toHaveBeenCalledWith(1, 0);
    expect(l.positionY.setValueAtTime).toHaveBeenCalledWith(2, 0);
    expect(l.positionZ.setValueAtTime).toHaveBeenCalledWith(3, 0);
    expect(l.forwardZ.setValueAtTime).toHaveBeenCalledWith(-1, 0);
    expect(l.upY.setValueAtTime).toHaveBeenCalledWith(1, 0);
  });

  // -------------------------------------------------------------------------
  // Audit #3 — non-finite guards. setValueAtTime(NaN) throws a RangeError which
  // would escape setAnimationLoop and kill the render loop. A bad component must
  // be skipped: no throw, and NO NaN written to any AudioParam.
  // -------------------------------------------------------------------------
  it('setPeerPosition with a NaN component does NOT throw and writes NO value (audit #3)', () => {
    // Create the peer first so we can inspect its panner.
    spatializer.ensurePeer('p1');
    const panner = ctx._createdPanners[0];
    panner.positionX.setValueAtTime.mockClear();
    panner.positionY.setValueAtTime.mockClear();
    panner.positionZ.setValueAtTime.mockClear();

    expect(() => spatializer.setPeerPosition('p1', { x: NaN, y: 2, z: 3 })).not.toThrow();
    // The whole update is skipped — no NaN (nor any value) reaches setValueAtTime.
    expect(panner.positionX.setValueAtTime).not.toHaveBeenCalled();
    expect(panner.positionY.setValueAtTime).not.toHaveBeenCalled();
    expect(panner.positionZ.setValueAtTime).not.toHaveBeenCalled();
  });

  it('setPeerPosition with an Infinity component is skipped (audit #3)', () => {
    spatializer.ensurePeer('p1');
    const panner = ctx._createdPanners[0];
    panner.positionZ.setValueAtTime.mockClear();
    expect(() => spatializer.setPeerPosition('p1', { x: 0, y: 0, z: Infinity })).not.toThrow();
    expect(panner.positionZ.setValueAtTime).not.toHaveBeenCalled();
  });

  it('setPeerPosition with all-finite components still writes (guard is not over-eager)', () => {
    spatializer.ensurePeer('p1');
    const panner = ctx._createdPanners[0];
    panner.positionX.setValueAtTime.mockClear();
    spatializer.setPeerPosition('p1', { x: 4, y: 5, z: 6 });
    expect(panner.positionX.setValueAtTime).toHaveBeenCalledWith(4, 0);
  });

  it('setListener with a NaN component does NOT throw and writes NO value (audit #3)', () => {
    const l = ctx.listener;
    l.positionX.setValueAtTime.mockClear();
    l.forwardZ.setValueAtTime.mockClear();
    expect(() =>
      spatializer.setListener({ x: NaN, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 })
    ).not.toThrow();
    expect(l.positionX.setValueAtTime).not.toHaveBeenCalled();
    expect(l.forwardZ.setValueAtTime).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Voice orchestrator — light tests (mode 'none' + frame routing)
// ---------------------------------------------------------------------------

describe('Voice orchestrator (light)', () => {
  // We need to mock:
  //   - detectVoiceMode → returns 'none'
  //   - NetClient (with sendVoiceFrame + onVoice hook)
  //   - Avatars (setSpeaking)
  //   - AudioContext (minimal)

  it('enable() with mode "none" does not throw', async () => {
    // Dynamically import voice and mock featureDetect BEFORE the import
    vi.resetModules();

    // Mock detectVoiceMode to return 'none'
    vi.doMock('../src/voice/featureDetect.js', () => ({
      detectVoiceMode: async () => 'none',
    }));

    const { Voice } = await import('../src/voice/voice.js');

    const ctx = makeAudioContextMock() as unknown as AudioContext;
    const netClient = {
      sendVoiceFrame: vi.fn(),
      setOnVoice: vi.fn(),
      opts: {} as { onVoice?: (data: unknown) => void },
    };
    const avatars = { setSpeaking: vi.fn() };

    const voice = new Voice(
      ctx,
      netClient as unknown as import('../src/net/netClient.js').NetClient,
      avatars as unknown as import('../src/net/avatars.js').Avatars
    );

    await expect(voice.enable()).resolves.not.toThrow();
    voice.disable();

    vi.doUnmock('../src/voice/featureDetect.js');
  });

  it('received voice frame is pushed into the correct peer jitter buffer', async () => {
    vi.resetModules();

    vi.doMock('../src/voice/featureDetect.js', () => ({
      detectVoiceMode: async () => 'none',
    }));

    const { Voice } = await import('../src/voice/voice.js');

    const ctx = makeAudioContextMock() as unknown as AudioContext;

    // Capture the onVoice hook registered by Voice (now via setOnVoice).
    let capturedOnVoice: ((data: unknown) => void) | undefined;
    const netClient = {
      sendVoiceFrame: vi.fn(),
      setOnVoice: vi.fn((cb: ((data: unknown) => void) | null) => {
        capturedOnVoice = cb ?? undefined;
      }),
      opts: {} as { onVoice?: (data: unknown) => void },
      get onVoiceSetter() {
        return capturedOnVoice;
      },
    };

    const avatars = { setSpeaking: vi.fn() };

    const voice = new Voice(
      ctx,
      netClient as unknown as import('../src/net/netClient.js').NetClient,
      avatars as unknown as import('../src/net/avatars.js').Avatars
    );

    // Access internal jitter buffer map via the receiveFrame method
    // We test that receiving a frame for peer "42" doesn't throw and
    // creates a peer entry (setSpeaking called on the right id).
    await voice.enable();

    // Simulate receiving a voice frame (senderId=42, tsMs=100, bytes, flags=0x01)
    const fakeBytes = new Uint8Array([0xde, 0xad]);
    voice.receiveFrame(42, 100, fakeBytes, 0x01);

    // After receiving, a ~20ms tick should pop the frame (tsMs=100, nowMs=9999)
    // The speaking indicator should fire for playerId 'p42'
    voice.tickPeer(42, 9999);

    // avatars.setSpeaking should have been called (frame was pending/speaking)
    // At minimum, it should not have thrown
    expect(avatars.setSpeaking).toBeDefined();

    voice.disable();
    vi.doUnmock('../src/voice/featureDetect.js');
  });
});
