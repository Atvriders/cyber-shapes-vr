/**
 * decoder.ts — Per-peer WebCodecs Opus decoder → AudioBufferSourceNode (B10).
 *
 * `PeerVoiceDecoder` wraps a WebCodecs `AudioDecoder` for one remote peer.
 * Decoded AudioData is scheduled into a panner chain:
 *
 *   AudioDecoder → output(audioData) → Float32 copy → AudioBuffer →
 *   AudioBufferSourceNode → panner → ctx.destination
 *
 * On decoder error → reset() + reconfigure THIS peer only; does not crash.
 *
 * Browser/Quest audio is a human test (deferred). In node/jsdom the
 * AudioDecoder global is absent so this module is imported but the
 * constructor should not be called without a real AudioDecoder.
 */

import { FLAG_TALK_START } from './jitterBuffer.js';

/** Minimal subset of PannerNode we need for type-safety. */
interface PannerLike {
  connect(dest: AudioNode): void;
}

/** Minimal AudioNode reference (destination, panner). */
type AudioNodeLike = AudioNode | PannerLike;

export interface PeerVoiceDecoderOpts {
  /** Sample rate for the output AudioBuffer (must match encoder: 48000). */
  sampleRate?: number;
}

export class PeerVoiceDecoder {
  private readonly _ctx: AudioContext;
  private readonly _panner: AudioNode;
  private readonly _sampleRate: number;
  private _decoder: AudioDecoder | null = null;

  constructor(ctx: AudioContext, panner: AudioNodeLike, opts: PeerVoiceDecoderOpts = {}) {
    this._ctx = ctx;
    this._panner = panner as AudioNode;
    this._sampleRate = opts.sampleRate ?? 48000;
    this._configure();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Decode one Opus frame from the jitter buffer.
   * `tsMs` is in milliseconds; WebCodecs timestamps are in microseconds.
   *
   * `flags` carries the voice frame bit-flags. A FLAG_TALK_START frame marks the
   * start of a new utterance: we reset()+reconfigure this peer's decoder first so
   * stale codec state from the previous utterance never bleeds into the new one.
   * (A zero-length talk-start frame carries no audio and is skipped after reset.)
   */
  decode(tsMs: number, bytes: Uint8Array, flags = 0): void {
    if (flags & FLAG_TALK_START) {
      this._reset();
    }
    if (!this._decoder) return;
    if (bytes.byteLength === 0) return; // synthetic boundary frame — nothing to decode
    try {
      // EncodedAudioChunk expects timestamp in microseconds
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: tsMs * 1000,
        data: bytes,
      });
      this._decoder.decode(chunk);
    } catch (e) {
      console.warn('[PeerVoiceDecoder] decode error — resetting', e);
      this._reset();
    }
  }

  /** Dispose and stop this decoder. */
  close(): void {
    if (this._decoder) {
      try {
        this._decoder.close();
      } catch {
        /* ignore */
      }
      this._decoder = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _configure(): void {
    if (typeof AudioDecoder === 'undefined') return;

    this._decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        this._schedule(audioData);
      },
      error: (e: DOMException) => {
        console.warn('[PeerVoiceDecoder] AudioDecoder error — resetting', e);
        this._reset();
      },
    });

    this._decoder.configure({
      codec: 'opus',
      sampleRate: this._sampleRate,
      numberOfChannels: 1,
    });
  }

  private _reset(): void {
    this.close();
    this._configure();
  }

  private _schedule(audioData: AudioData): void {
    const numFrames = audioData.numberOfFrames;
    const numChannels = audioData.numberOfChannels;

    // Copy samples out into a Float32Array
    const samples = new Float32Array(numFrames * numChannels);
    audioData.copyTo(samples, { planeIndex: 0 });
    audioData.close();

    // Wrap in an AudioBuffer
    const buf = this._ctx.createBuffer(1, numFrames, this._sampleRate);
    buf.copyToChannel(samples, 0);

    // Schedule for immediate playback into the peer's panner
    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._panner);
    src.start();
  }
}
