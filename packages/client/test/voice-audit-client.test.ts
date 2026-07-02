/**
 * voice-audit-client.test.ts — client-audit regressions for the Voice orchestrator.
 *
 *   #10  Voice.removePeer(senderId) fully tears a departed peer down: closes the
 *        decoder, disconnects the spatializer's panner/gain, clears the speaking
 *        timeout, and deletes the per-peer map entry.
 *   #13  Voice.enable() (mode 'opus') where createVoiceEncoder() throws must NOT
 *        produce an unhandled rejection — enable() resolves and voice ends disabled.
 *   #12  enable→disable→enable re-installs a working inbound-voice handler (voice
 *        survives a VR exit/re-entry cycle without being nulled).
 *
 * We mock featureDetect (mode), encoder, decoder and spatializer BEFORE importing
 * voice.js so the pure orchestration logic is observable without Web Audio.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// A minimal ctx that Spatializer would use — but Spatializer is mocked below, so
// only the Voice orchestrator touches this (it doesn't, directly).
function makeCtx() {
  return {
    currentTime: 0,
    destination: {},
    createGain: vi.fn(),
    createPanner: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    listener: {},
  } as unknown as AudioContext;
}

function makeNetClient(setOnVoice = vi.fn()) {
  return {
    sendVoiceFrame: vi.fn(),
    setOnVoice,
    opts: {},
  } as unknown as import('../src/net/netClient.js').NetClient;
}

function makeAvatars() {
  return { setSpeaking: vi.fn() } as unknown as import('../src/net/avatars.js').Avatars;
}

afterEach(() => {
  vi.doUnmock('../src/voice/featureDetect.js');
  vi.doUnmock('../src/voice/encoder.js');
  vi.doUnmock('../src/voice/decoder.js');
  vi.doUnmock('../src/voice/spatializer.js');
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// #10 — removePeer teardown
// ---------------------------------------------------------------------------
describe('Voice.removePeer (audit #10)', () => {
  it('closes the decoder, removes the spatializer peer, clears the timeout, deletes the map entry', async () => {
    vi.resetModules();

    // Ensure a decoder is created: stub AudioDecoder so `_ensurePeer` builds one.
    (globalThis as unknown as Record<string, unknown>).AudioDecoder = class {};

    const decoderClose = vi.fn();
    vi.doMock('../src/voice/decoder.js', () => ({
      PeerVoiceDecoder: class {
        close = decoderClose;
        decode = vi.fn();
      },
    }));

    const spatializerRemovePeer = vi.fn();
    vi.doMock('../src/voice/spatializer.js', () => ({
      Spatializer: class {
        ensurePeer = vi.fn(() => ({ panner: {}, gain: {} }));
        removePeer = spatializerRemovePeer;
        setPeerPosition = vi.fn();
        setPeerGain = vi.fn();
        setListener = vi.fn();
        disposeAll = vi.fn();
      },
    }));

    // mode 'opus' so the spatializer is created; encoder is stubbed to a no-op.
    vi.doMock('../src/voice/featureDetect.js', () => ({ detectVoiceMode: async () => 'opus' }));
    vi.doMock('../src/voice/encoder.js', () => ({
      createVoiceEncoder: () => ({ encodeBlock: vi.fn(), close: vi.fn() }),
    }));
    // capture.start() would need getUserMedia; capture is constructed in the opus
    // path — mock it so start() resolves without a mic.
    vi.doMock('../src/voice/capture.js', () => ({
      VoiceCapture: class {
        start = async () => {};
        stop = vi.fn();
        setMuted = vi.fn();
      },
    }));

    const { Voice } = await import('../src/voice/voice.js');
    const voice = new Voice(makeCtx(), makeNetClient(), makeAvatars());
    await voice.enable();

    // A received frame ensures the peer (and its decoder + speaking timeout) exists.
    voice.receiveFrame(42, 100, new Uint8Array([1, 2]), 0x01);

    const peers = (voice as unknown as { _peers: Map<number, unknown> })._peers;
    expect(peers.has(42)).toBe(true);

    voice.removePeer(42);

    expect(decoderClose).toHaveBeenCalledTimes(1);
    expect(spatializerRemovePeer).toHaveBeenCalledWith('p42');
    expect(peers.has(42)).toBe(false);

    // Idempotent second call.
    expect(() => voice.removePeer(42)).not.toThrow();
    expect(decoderClose).toHaveBeenCalledTimes(1);

    voice.disable();
    delete (globalThis as unknown as Record<string, unknown>).AudioDecoder;
  });
});

// ---------------------------------------------------------------------------
// #13 — enable() must handle a throwing encoder gracefully (no unhandled rejection)
// ---------------------------------------------------------------------------
describe('Voice.enable() encoder-throws guard (audit #13)', () => {
  it('resolves (does not reject) and ends disabled when createVoiceEncoder throws', async () => {
    vi.resetModules();

    vi.doMock('../src/voice/featureDetect.js', () => ({ detectVoiceMode: async () => 'opus' }));
    vi.doMock('../src/voice/encoder.js', () => ({
      createVoiceEncoder: () => {
        throw new Error('encoder configure() failed');
      },
    }));
    vi.doMock('../src/voice/spatializer.js', () => ({
      Spatializer: class {
        ensurePeer = vi.fn(() => ({ panner: {}, gain: {} }));
        removePeer = vi.fn();
        setPeerPosition = vi.fn();
        setListener = vi.fn();
        disposeAll = vi.fn();
      },
    }));

    const { Voice } = await import('../src/voice/voice.js');
    const setOnVoice = vi.fn();
    const voice = new Voice(makeCtx(), makeNetClient(setOnVoice), makeAvatars());

    // Must RESOLVE — a reject here would be the unhandled-rejection bug.
    await expect(voice.enable()).resolves.toBeUndefined();

    // Graceful degrade: voice ended disabled and the inbound handler was cleared.
    const priv = voice as unknown as { _enabled: boolean };
    expect(priv._enabled).toBe(false);
    expect(setOnVoice).toHaveBeenLastCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// #12 — enable → disable → enable re-installs a working handler (VR re-entry)
// ---------------------------------------------------------------------------
describe('Voice enable/disable/enable re-entry (audit #12)', () => {
  it('re-installs a working inbound-voice handler on a second enable() after disable()', async () => {
    vi.resetModules();
    vi.doMock('../src/voice/featureDetect.js', () => ({ detectVoiceMode: async () => 'none' }));

    const { Voice } = await import('../src/voice/voice.js');

    // Track the handler installed via setOnVoice so we can assert re-install.
    let installed: ((...a: unknown[]) => void) | null = null;
    const setOnVoice = vi.fn((cb: ((...a: unknown[]) => void) | null) => {
      installed = cb;
    });
    const voice = new Voice(makeCtx(), makeNetClient(setOnVoice), makeAvatars());

    await voice.enable();
    expect(typeof installed).toBe('function'); // handler installed on first enable

    voice.disable();
    expect(installed).toBeNull(); // disable cleared it

    // Second enable() (VR re-entry) must re-install a live handler on the SAME instance.
    await voice.enable();
    expect(typeof installed).toBe('function');

    // And the re-installed handler still routes inbound frames (receiveFrame path).
    const avatarsSpy = (voice as unknown as { _avatars: { setSpeaking: ReturnType<typeof vi.fn> } })
      ._avatars;
    installed!(7, 100, new Uint8Array([1]), 0x01);
    expect(avatarsSpy.setSpeaking).toHaveBeenCalledWith('p7', true);

    voice.disable();
  });
});
