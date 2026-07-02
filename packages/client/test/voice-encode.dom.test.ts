/**
 * voice-encode.dom.test.ts — runs under jsdom (matched by vitest environmentMatchGlobs)
 *
 * Mocks all browser-only APIs (AudioEncoder, AudioDecoder, AudioData,
 * MediaRecorder, AudioWorklet, AudioWorkletNode, getUserMedia) before
 * importing the modules under test.
 *
 * Tests:
 *   1. detectVoiceMode — 4 branches
 *   2. createVoiceEncoder — opus config, encodeBlock, onFrame, onConfig
 *   3. VoiceCapture — getUserMedia constraints, worklet message→onBlock, setMuted drops blocks
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock reset helpers
// ---------------------------------------------------------------------------

/** Installs or removes a key on globalThis */
function setGlobal(key: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[key] = value;
}
function deleteGlobal(key: string) {
  delete (globalThis as unknown as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// AudioEncoder / AudioDecoder mocks
// ---------------------------------------------------------------------------

type AudioEncoderInit = {
  output: (chunk: MockEncodedAudioChunk, meta?: { decoderConfig?: object }) => void;
  error: (e: Error) => void;
};

type AudioEncoderConfig = {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
};

interface MockEncodedAudioChunk {
  byteLength: number;
  copyTo(dest: AllowSharedBufferSource): void;
  type: string;
}

let capturedEncoderInit: AudioEncoderInit | null = null;
let capturedEncoderConfig: AudioEncoderConfig | null = null;
let mockEncoderEncodeArgs: unknown[] = [];
let mockEncoderClosed = false;

class MockAudioEncoder {
  static _isConfigSupportedResult: { supported: boolean } | 'throw' = { supported: true };

  static async isConfigSupported(/* cfg: AudioEncoderConfig */): Promise<{ supported: boolean }> {
    if (MockAudioEncoder._isConfigSupportedResult === 'throw') {
      throw new Error('not supported');
    }
    return MockAudioEncoder._isConfigSupportedResult;
  }

  constructor(init: AudioEncoderInit) {
    capturedEncoderInit = init;
  }

  configure(cfg: AudioEncoderConfig) {
    capturedEncoderConfig = cfg;
  }

  encode(data: unknown) {
    mockEncoderEncodeArgs.push(data);
  }

  close() {
    mockEncoderClosed = true;
  }
}

class MockAudioDecoder {
  // Presence is enough to satisfy the feature-detect
}

// ---------------------------------------------------------------------------
// AudioData mock
// ---------------------------------------------------------------------------

type AudioDataInit = {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
};

let capturedAudioDataInits: AudioDataInit[] = [];

class MockAudioData {
  constructor(init: AudioDataInit) {
    capturedAudioDataInits.push(init);
  }

  close() {}
}

// ---------------------------------------------------------------------------
// MediaRecorder mock
// ---------------------------------------------------------------------------

let mockIsTypeSupported: (mime: string) => boolean = () => false;

class MockMediaRecorder {
  static isTypeSupported(mime: string): boolean {
    return mockIsTypeSupported(mime);
  }
}

// ---------------------------------------------------------------------------
// AudioContext / audioWorklet mock
// ---------------------------------------------------------------------------

type WorkletMessageHandler = (ev: { data: { samples: Float32Array; rms: number } }) => void;

let capturedAddModuleUrl: string | null = null;
let capturedGetUserMediaConstraints: MediaStreamConstraints | null = null;

// A mock MediaStream track
function makeMockTrack() {
  return { stop: vi.fn() };
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as WorkletMessageHandler | null,
  };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor(...args: unknown[]) {
    void args;
    // Store reference so tests can call it
    (MockAudioWorkletNode as unknown as { _lastInstance: MockAudioWorkletNode })._lastInstance =
      this;
  }
}
(MockAudioWorkletNode as unknown as { _lastInstance: null })._lastInstance = null;

function makeAudioWorkletMock() {
  return {
    addModule: vi.fn(async (url: string) => {
      capturedAddModuleUrl = url;
    }),
  };
}

let mockAudioWorkletInstance = makeAudioWorkletMock();
let capturedSourceNode: {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} | null = null;

class MockAudioContextForCapture {
  sampleRate: number;
  audioWorklet = mockAudioWorkletInstance;
  destination = {};

  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 44100;
  }

  createMediaStreamSource(...args: unknown[]) {
    void args;
    const node = { connect: vi.fn(), disconnect: vi.fn() };
    capturedSourceNode = node;
    return node;
  }

  resume = vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// getUserMedia mock
// ---------------------------------------------------------------------------

function installGetUserMedia(stream: { getTracks(): Array<{ stop(): void }> }) {
  const mock = vi.fn(async (constraints: MediaStreamConstraints) => {
    capturedGetUserMediaConstraints = constraints;
    return stream;
  });
  (globalThis as unknown as Record<string, unknown>).navigator = {
    mediaDevices: { getUserMedia: mock },
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Helper: set up full "opus capable" environment
// ---------------------------------------------------------------------------

function installOpusEnvironment() {
  setGlobal('AudioEncoder', MockAudioEncoder);
  setGlobal('AudioDecoder', MockAudioDecoder);
  setGlobal('AudioData', MockAudioData);
  MockAudioEncoder._isConfigSupportedResult = { supported: true };
  deleteGlobal('MediaRecorder');
}

function installWebmOnlyEnvironment() {
  deleteGlobal('AudioEncoder');
  deleteGlobal('AudioDecoder');
  deleteGlobal('AudioData');
  setGlobal('MediaRecorder', MockMediaRecorder);
  mockIsTypeSupported = (mime) => mime === 'audio/webm;codecs=opus';
}

function installPcmOnlyEnvironment() {
  deleteGlobal('AudioEncoder');
  deleteGlobal('AudioDecoder');
  deleteGlobal('AudioData');
  setGlobal('MediaRecorder', MockMediaRecorder);
  mockIsTypeSupported = () => false;
  // AudioWorklet and getUserMedia are present
}

function installNoneEnvironment() {
  deleteGlobal('AudioEncoder');
  deleteGlobal('AudioDecoder');
  deleteGlobal('AudioData');
  deleteGlobal('MediaRecorder');
  // No AudioWorklet either
  deleteGlobal('navigator');
}

// ---------------------------------------------------------------------------
// Lazy module imports (so globals are set BEFORE the module initialises)
// Note: vitest module caching - we use `vi.resetModules` between test groups.
// ---------------------------------------------------------------------------

// ============================================================================
// 1. detectVoiceMode
// ============================================================================

describe('detectVoiceMode', () => {
  beforeEach(() => {
    // Reset module cache so each describe block gets a fresh import
    vi.resetModules();
    capturedEncoderInit = null;
    capturedEncoderConfig = null;
    mockEncoderEncodeArgs = [];
    mockEncoderClosed = false;
    capturedAddModuleUrl = null;
    capturedGetUserMediaConstraints = null;
  });

  it('returns "opus" when AudioEncoder + AudioDecoder + isConfigSupported.supported = true', async () => {
    installOpusEnvironment();
    // Ensure AudioWorklet-like navigator presence doesn't change outcome
    (globalThis as unknown as Record<string, unknown>).navigator = {
      mediaDevices: { getUserMedia: vi.fn() },
    };
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('opus');
  });

  it('returns "webm" when only MediaRecorder with webm/opus is available', async () => {
    installWebmOnlyEnvironment();
    (globalThis as unknown as Record<string, unknown>).navigator = {
      mediaDevices: { getUserMedia: vi.fn() },
    };
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('webm');
  });

  it('returns "pcm" when AudioWorklet + getUserMedia present but no AudioEncoder/MediaRecorder webm', async () => {
    installPcmOnlyEnvironment();
    (globalThis as unknown as Record<string, unknown>).navigator = {
      mediaDevices: { getUserMedia: vi.fn() },
    };
    // Install AudioWorklet presence indicator
    setGlobal('AudioWorklet', class MockAudioWorklet {});
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('pcm');
  });

  it('returns "none" when nothing is available', async () => {
    installNoneEnvironment();
    deleteGlobal('AudioWorklet');
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('none');
  });

  it('returns "none" when isConfigSupported throws', async () => {
    installOpusEnvironment();
    MockAudioEncoder._isConfigSupportedResult = 'throw';
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('none');
  });

  it('returns "none" when isConfigSupported returns supported: false', async () => {
    installOpusEnvironment();
    MockAudioEncoder._isConfigSupportedResult = { supported: false };
    const { detectVoiceMode } = await import('../src/voice/featureDetect.ts');
    const mode = await detectVoiceMode();
    expect(mode).toBe('none');
  });
});

// ============================================================================
// 2. createVoiceEncoder
// ============================================================================

describe('createVoiceEncoder', () => {
  beforeEach(() => {
    vi.resetModules();
    installOpusEnvironment();
    capturedEncoderInit = null;
    capturedEncoderConfig = null;
    mockEncoderEncodeArgs = [];
    mockEncoderClosed = false;
    capturedAudioDataInits = [];
  });

  it('configures AudioEncoder with opus 48000 mono 24kbps voip', async () => {
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    createVoiceEncoder({ onFrame: vi.fn() });

    expect(capturedEncoderConfig).not.toBeNull();
    expect(capturedEncoderConfig!.codec).toBe('opus');
    expect(capturedEncoderConfig!.sampleRate).toBe(48000);
    expect(capturedEncoderConfig!.numberOfChannels).toBe(1);
    expect(capturedEncoderConfig!.bitrate).toBe(24000);
  });

  it('encodeBlock creates an AudioData with correct format/sampleRate/frames/channels', async () => {
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    const enc = createVoiceEncoder({ onFrame: vi.fn() });

    const block = new Float32Array(960);
    enc.encodeBlock(block, 1_000_000);

    expect(capturedAudioDataInits).toHaveLength(1);
    const init = capturedAudioDataInits[0];
    expect(init.format).toBe('f32-planar');
    expect(init.sampleRate).toBe(48000);
    expect(init.numberOfFrames).toBe(960);
    expect(init.numberOfChannels).toBe(1);
    expect(init.timestamp).toBe(1_000_000);
  });

  it('encodeBlock calls AudioEncoder.encode with the AudioData', async () => {
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    const enc = createVoiceEncoder({ onFrame: vi.fn() });

    const block = new Float32Array(960);
    enc.encodeBlock(block, 2_000_000);

    expect(mockEncoderEncodeArgs).toHaveLength(1);
    expect(mockEncoderEncodeArgs[0]).toBeInstanceOf(MockAudioData);
  });

  it('encoder output callback calls onFrame with bytes copied from the chunk', async () => {
    const onFrame = vi.fn();
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    createVoiceEncoder({ onFrame });

    // Simulate an encoded chunk coming back
    expect(capturedEncoderInit).not.toBeNull();
    const fakeBytes = new Uint8Array([0x01, 0x02, 0x03]);
    const fakeChunk: MockEncodedAudioChunk = {
      byteLength: fakeBytes.byteLength,
      type: 'key',
      copyTo(dest: AllowSharedBufferSource) {
        const arr = dest instanceof Uint8Array ? dest : new Uint8Array(dest as ArrayBuffer);
        arr.set(fakeBytes);
      },
    };
    capturedEncoderInit!.output(fakeChunk, undefined);

    expect(onFrame).toHaveBeenCalledOnce();
    const [bytes, , key] = onFrame.mock.calls[0] as [Uint8Array, number, boolean];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([0x01, 0x02, 0x03]);
    expect(key).toBe(true);
  });

  it('first chunk with meta.decoderConfig calls onConfig', async () => {
    const onConfig = vi.fn();
    const onFrame = vi.fn();
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    createVoiceEncoder({ onFrame, onConfig });

    expect(capturedEncoderInit).not.toBeNull();
    const fakeDecoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
    const fakeChunk: MockEncodedAudioChunk = {
      byteLength: 4,
      type: 'key',
      copyTo(dest: AllowSharedBufferSource) {
        const arr = dest instanceof Uint8Array ? dest : new Uint8Array(dest as ArrayBuffer);
        arr.set(new Uint8Array(4));
      },
    };
    capturedEncoderInit!.output(fakeChunk, { decoderConfig: fakeDecoderConfig });

    expect(onConfig).toHaveBeenCalledOnce();
    expect(onConfig.mock.calls[0][0]).toEqual(fakeDecoderConfig);
  });

  it('close() calls encoder.close()', async () => {
    const { createVoiceEncoder } = await import('../src/voice/encoder.ts');
    const enc = createVoiceEncoder({ onFrame: vi.fn() });
    enc.close();
    expect(mockEncoderClosed).toBe(true);
  });
});

// ============================================================================
// 3. VoiceCapture
// ============================================================================

describe('VoiceCapture', () => {
  let mockTrack: ReturnType<typeof makeMockTrack>;
  let mockStream: { getTracks(): Array<{ stop(): void }> };
  let getUserMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    installOpusEnvironment();
    capturedGetUserMediaConstraints = null;
    capturedAddModuleUrl = null;
    capturedSourceNode = null;
    mockAudioWorkletInstance = makeAudioWorkletMock();

    mockTrack = makeMockTrack();
    mockStream = { getTracks: () => [mockTrack] };
    getUserMediaMock = installGetUserMedia(mockStream);

    setGlobal('AudioWorklet', class MockAudioWorklet {});
    setGlobal('AudioContext', MockAudioContextForCapture);
    setGlobal('AudioWorkletNode', MockAudioWorkletNode);
    (MockAudioWorkletNode as unknown as { _lastInstance: null })._lastInstance = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() calls getUserMedia with correct audio constraints', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const onBlock = vi.fn();
    const vc = new VoiceCapture(ctx, { onBlock });
    await vc.start();

    expect(getUserMediaMock).toHaveBeenCalledOnce();
    const constraints = capturedGetUserMediaConstraints!.audio as MediaTrackConstraints;
    expect(constraints).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    });
  });

  it('start() loads the capture worklet module', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const vc = new VoiceCapture(ctx, { onBlock: vi.fn() });
    await vc.start();

    expect(mockAudioWorkletInstance.addModule).toHaveBeenCalledOnce();
    expect(capturedAddModuleUrl).toMatch(/capture-worklet/);
  });

  it('worklet port message forwards samples+rms to onBlock', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const onBlock = vi.fn();
    const vc = new VoiceCapture(ctx, { onBlock });
    await vc.start();

    // Get last created AudioWorkletNode instance
    const wn = (MockAudioWorkletNode as unknown as { _lastInstance: MockAudioWorkletNode })
      ._lastInstance;
    expect(wn).not.toBeNull();

    // Fire worklet message
    const fakeSamples = new Float32Array(960);
    const fakeRms = 0.05;
    wn!.port.onmessage!({ data: { samples: fakeSamples, rms: fakeRms } });

    expect(onBlock).toHaveBeenCalledOnce();
    expect(onBlock.mock.calls[0][0]).toBe(fakeSamples);
    expect(onBlock.mock.calls[0][1]).toBe(fakeRms);
  });

  it('setMuted(true) prevents onBlock from being called on worklet messages', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const onBlock = vi.fn();
    const vc = new VoiceCapture(ctx, { onBlock });
    await vc.start();

    vc.setMuted(true);

    const wn = (MockAudioWorkletNode as unknown as { _lastInstance: MockAudioWorkletNode })
      ._lastInstance;
    wn!.port.onmessage!({ data: { samples: new Float32Array(960), rms: 0.1 } });

    expect(onBlock).not.toHaveBeenCalled();
  });

  it('setMuted(false) re-enables onBlock after muting', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const onBlock = vi.fn();
    const vc = new VoiceCapture(ctx, { onBlock });
    await vc.start();

    vc.setMuted(true);
    vc.setMuted(false);

    const wn = (MockAudioWorkletNode as unknown as { _lastInstance: MockAudioWorkletNode })
      ._lastInstance;
    wn!.port.onmessage!({ data: { samples: new Float32Array(960), rms: 0.02 } });

    expect(onBlock).toHaveBeenCalledOnce();
  });

  it('stop() stops all tracks and disconnects nodes', async () => {
    const { VoiceCapture } = await import('../src/voice/capture.ts');
    const ctx = new MockAudioContextForCapture({ sampleRate: 48000 }) as unknown as AudioContext;
    (ctx as unknown as { audioWorklet: typeof mockAudioWorkletInstance }).audioWorklet =
      mockAudioWorkletInstance;

    const vc = new VoiceCapture(ctx, { onBlock: vi.fn() });
    await vc.start();
    vc.stop();

    expect(mockTrack.stop).toHaveBeenCalledOnce();
    if (capturedSourceNode) {
      expect(capturedSourceNode.disconnect).toHaveBeenCalled();
    }
  });
});
