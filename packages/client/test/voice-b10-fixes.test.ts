/**
 * voice-b10-fixes.test.ts — regression tests for the B10 voice-receive audit.
 *
 * Each test in this file is written to FAIL against the pre-fix code and PASS
 * after the fix. Findings covered:
 *
 *   B1  ws.binaryType='arraybuffer' + unpackVoice routing → inbound voice reaches onVoice
 *   B2  opcode validation: non-voice binary opcodes are ignored
 *   B3  FLAG_TALK_STOP is emitted on PTT release
 *   B4  decoder.decode(flags): FLAG_TALK_START triggers a decoder reset
 *   Q5  resetPtt() clears the PTT rising-edge state across XR sessions
 *   Q6  a late enable() continuation must not install a handler over a disable()
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ShapeStore } from '../src/world.ts';
import { NetClient, LOCAL_PEER_ID } from '../src/net/netClient.ts';
import { packVoice, VOICE_OPUS } from '@cyber-shapes/shared';
import { FLAG_TALK_START, FLAG_TALK_STOP } from '../src/voice/jitterBuffer.ts';

// ===========================================================================
// StubWebSocket — captures binaryType and can deliver binary frames.
// ===========================================================================
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  readyState = 1; // OPEN
  binaryType = 'blob'; // browser default — the real WS also defaults to 'blob'
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sent: unknown[] = [];

  constructor(public url: string) {
    StubWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver a binary voice frame (as the browser would once binaryType='arraybuffer'). */
  deliverBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
}

// ===========================================================================
// B1 + B2 — inbound voice receive path (netClient)
// ===========================================================================

describe('B10-B1/B2 — inbound binary voice receive (netClient)', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  function connect(net: NetClient): StubWebSocket {
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();
    return ws;
  }

  it('B1: connect() sets ws.binaryType = "arraybuffer"', () => {
    const net = new NetClient(store, { now: () => 0 });
    const ws = connect(net);
    // Pre-fix this stays 'blob', so all binary voice arrives as Blob and is dropped.
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('B1: a delivered binary voice frame reaches opts.onVoice with unpacked values', () => {
    const onVoice = vi.fn();
    const net = new NetClient(store, { now: () => 0, onVoice });
    const ws = connect(net);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const tsMs = 123456;
    const flags = FLAG_TALK_START | 0x01; // key + talk-start
    // senderId=7 as the server would stamp it.
    const frame = packVoice(VOICE_OPUS, 7, tsMs, flags, bytes);

    ws.deliverBinary(frame);

    expect(onVoice).toHaveBeenCalledTimes(1);
    const [sId, ts, gotBytes, gotFlags] = onVoice.mock.calls[0];
    expect(sId).toBe(7);
    expect(ts).toBe(tsMs);
    expect(Array.from(gotBytes as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(gotFlags).toBe(flags);
  });

  it('B2: a binary frame with a NON-voice opcode is ignored (not routed to onVoice)', () => {
    const onVoice = vi.fn();
    const net = new NetClient(store, { now: () => 0, onVoice });
    const ws = connect(net);

    // Hand-build a frame with opcode 0x99 (not VOICE_OPUS/WEBM/PCM).
    const buf = new ArrayBuffer(7 + 2);
    const view = new DataView(buf);
    view.setUint8(0, 0x99); // bogus opcode
    view.setUint8(1, 3); // senderId
    view.setUint32(2, 42, true); // tsMs
    view.setUint8(6, 0); // flags

    ws.deliverBinary(buf);

    expect(onVoice).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Q6 — NetClient.setOnVoice + enable/disable race guard
// ===========================================================================

describe('B10-Q6 — setOnVoice + enable/disable race', () => {
  let scene: THREE.Scene;
  let store: ShapeStore;
  let originalWS: unknown;

  beforeEach(() => {
    scene = new THREE.Scene();
    let c = 0;
    store = new ShapeStore(scene, {
      maxShapes: 40,
      idFactory: () => `${LOCAL_PEER_ID}:${c++}`,
    });
    originalWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
    StubWebSocket.instances = [];
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWS;
  });

  it('setOnVoice(null) stops inbound frames from being routed', () => {
    const onVoice = vi.fn();
    const net = new NetClient(store, { now: () => 0 });
    net.connect('ws://test/ws', 'room1', 'tester', 0);
    const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
    ws.onopen?.();

    net.setOnVoice(onVoice);
    ws.deliverBinary(packVoice(VOICE_OPUS, 1, 10, 0, new Uint8Array([9])));
    expect(onVoice).toHaveBeenCalledTimes(1);

    net.setOnVoice(null);
    ws.deliverBinary(packVoice(VOICE_OPUS, 1, 20, 0, new Uint8Array([9])));
    expect(onVoice).toHaveBeenCalledTimes(1); // no new call
  });

  it('Voice.enable() that resolves AFTER disable() does NOT install a handler or start a pipeline', async () => {
    vi.resetModules();

    // detectVoiceMode resolves only when we tell it to — lets disable() land first.
    // Use a mode ('webm') whose post-await continuation has an observable side
    // effect (_startSpatializer creates a Spatializer). With the guard the
    // continuation bails; without it, it installs a pipeline on a dead Voice.
    let resolveDetect!: (mode: string) => void;
    vi.doMock('../src/voice/featureDetect.js', () => ({
      detectVoiceMode: () =>
        new Promise<string>((res) => {
          resolveDetect = res;
        }),
    }));

    const { Voice } = await import('../src/voice/voice.js');

    const setOnVoice = vi.fn();
    const netClient = {
      sendVoiceFrame: vi.fn(),
      setOnVoice,
      opts: {},
    };
    const avatars = { setSpeaking: vi.fn() };
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn(),
      createPanner: vi.fn(),
      listener: {},
    };

    const voice = new Voice(
      ctx as unknown as AudioContext,
      netClient as unknown as import('../src/net/netClient.js').NetClient,
      avatars as unknown as import('../src/net/avatars.js').Avatars
    );

    // enable() installs the handler synchronously, then awaits detectVoiceMode().
    const enablePromise = voice.enable();
    expect(setOnVoice).toHaveBeenCalledTimes(1); // handler installed (the fn)

    // disable() runs while detectVoiceMode() is still pending: clears the handler
    // and tears down the spatializer (leaving _spatializer === null).
    voice.disable();
    expect(setOnVoice).toHaveBeenLastCalledWith(null);
    const callsAfterDisable = setOnVoice.mock.calls.length;

    // NOW the in-flight enable() resolves as 'webm'.
    resolveDetect('webm');
    await enablePromise;

    // The post-await continuation must NOT re-install a handler on the dead Voice.
    expect(setOnVoice.mock.calls.length).toBe(callsAfterDisable);
    expect(setOnVoice).toHaveBeenLastCalledWith(null);

    // And it must NOT have started a pipeline (spatializer) on the dead Voice.
    const priv = voice as unknown as { _spatializer: unknown; _enabled: boolean };
    expect(priv._spatializer).toBeNull();
    expect(priv._enabled).toBe(false);

    vi.doUnmock('../src/voice/featureDetect.js');
  });
});

// ===========================================================================
// B3 — FLAG_TALK_STOP emitted on PTT release
// ===========================================================================

describe('B10-B3 — talk-stop on PTT release', () => {
  it('setPtt(false) after setPtt(true) sends a frame with FLAG_TALK_STOP set', async () => {
    vi.resetModules();
    vi.doMock('../src/voice/featureDetect.js', () => ({
      detectVoiceMode: async () => 'none',
    }));

    const { Voice } = await import('../src/voice/voice.js');

    const sendVoiceFrame = vi.fn();
    const netClient = { sendVoiceFrame, setOnVoice: vi.fn(), opts: {} };
    const avatars = { setSpeaking: vi.fn() };
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn(),
      createPanner: vi.fn(),
      listener: {},
    };

    const voice = new Voice(
      ctx as unknown as AudioContext,
      netClient as unknown as import('../src/net/netClient.js').NetClient,
      avatars as unknown as import('../src/net/avatars.js').Avatars
    );

    // talk-start (press) → ... → release. On release a talk-stop frame must fire.
    voice.setPtt(true);
    voice.setPtt(false);

    expect(sendVoiceFrame).toHaveBeenCalledTimes(1);
    const [, , flags] = sendVoiceFrame.mock.calls[0];
    expect(flags & FLAG_TALK_STOP).toBe(FLAG_TALK_STOP);

    vi.doUnmock('../src/voice/featureDetect.js');
  });

  it('setPtt(false) with no prior press does NOT send a stray talk-stop', async () => {
    vi.resetModules();
    vi.doMock('../src/voice/featureDetect.js', () => ({
      detectVoiceMode: async () => 'none',
    }));

    const { Voice } = await import('../src/voice/voice.js');
    const sendVoiceFrame = vi.fn();
    const netClient = { sendVoiceFrame, setOnVoice: vi.fn(), opts: {} };
    const avatars = { setSpeaking: vi.fn() };
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain: vi.fn(),
      createPanner: vi.fn(),
      listener: {},
    };

    const voice = new Voice(
      ctx as unknown as AudioContext,
      netClient as unknown as import('../src/net/netClient.js').NetClient,
      avatars as unknown as import('../src/net/avatars.js').Avatars
    );

    voice.setPtt(false); // no-op: was already not pressed

    expect(sendVoiceFrame).not.toHaveBeenCalled();
    vi.doUnmock('../src/voice/featureDetect.js');
  });
});

// ===========================================================================
// B4 — decoder reset on FLAG_TALK_START
// ===========================================================================

describe('B10-B4 — decoder resets on FLAG_TALK_START', () => {
  it('decode() with FLAG_TALK_START calls _reset() before decoding', async () => {
    const { PeerVoiceDecoder } = await import('../src/voice/decoder.js');

    // In node/jsdom there's no AudioDecoder, so _configure() no-ops and _decoder
    // stays null — but the reset path runs regardless of that. Spy on _reset.
    const panner = { connect: vi.fn() };
    const ctx = { createBuffer: vi.fn(), createBufferSource: vi.fn() };
    const dec = new PeerVoiceDecoder(
      ctx as unknown as AudioContext,
      panner as unknown as AudioNode
    );

    const resetSpy = vi.spyOn(dec as unknown as { _reset: () => void }, '_reset');

    // A talk-start frame (audio bytes present) must reset the decoder first.
    dec.decode(1000, new Uint8Array([1, 2, 3]), FLAG_TALK_START);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('decode() WITHOUT FLAG_TALK_START does not reset', async () => {
    const { PeerVoiceDecoder } = await import('../src/voice/decoder.js');
    const panner = { connect: vi.fn() };
    const ctx = { createBuffer: vi.fn(), createBufferSource: vi.fn() };
    const dec = new PeerVoiceDecoder(
      ctx as unknown as AudioContext,
      panner as unknown as AudioNode
    );

    const resetSpy = vi.spyOn(dec as unknown as { _reset: () => void }, '_reset');

    dec.decode(1000, new Uint8Array([1, 2, 3]), 0);
    expect(resetSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Q5 — resetPtt() clears the PTT rising-edge state
// ===========================================================================

describe('B10-Q5 — resetPtt clears the PTT edge state', () => {
  /** Build a fake XRFrame that reports the thumbstick-click (buttons[3]) state. */
  function fakeFrame(pttPressed: boolean): XRFrame {
    const gamepad = {
      buttons: [
        { pressed: false }, // 0 trigger
        { pressed: false }, // 1 grip
        { pressed: false }, // 2
        { pressed: pttPressed }, // 3 thumbstick-click = PTT
      ],
      axes: [0, 0, 0, 0],
    };
    return {
      session: { inputSources: [{ gamepad }] },
    } as unknown as XRFrame;
  }

  it('without resetPtt, a press held across sessions swallows the next rising edge; resetPtt restores it', async () => {
    const { updateControllers, onPtt, resetPtt } = await import('../src/controllers.ts');

    const store = new ShapeStore(new THREE.Scene(), {
      maxShapes: 40,
      idFactory: () => 'x',
    });
    const audio = {
      resume: () => Promise.resolve(),
    } as unknown as import('../src/audio.js').AudioApi;

    const events: boolean[] = [];
    onPtt((pressed) => events.push(pressed));

    // Session A: press PTT — rising edge fires true. _prevPtt is now true.
    updateControllers(fakeFrame(true), 0.016, store, { audio });
    expect(events).toEqual([true]);

    // User exits VR WITH the button still held (no release edge observed).
    // Simulate re-entry (session B) with the button STILL pressed.
    updateControllers(fakeFrame(true), 0.016, store, { audio });
    // No new edge — the stale _prevPtt=true swallows it. PTT is broken.
    expect(events).toEqual([true]);

    // resetPtt() (called on sessionstart) clears the edge state.
    resetPtt();

    // Now the same held-button frame produces a fresh rising edge.
    updateControllers(fakeFrame(true), 0.016, store, { audio });
    expect(events).toEqual([true, true]);

    onPtt(null); // cleanup shared module state
  });

  it('resetPtt is a no-op when no callback is registered (no throw)', async () => {
    const { resetPtt } = await import('../src/controllers.ts');
    expect(() => resetPtt()).not.toThrow();
  });
});
