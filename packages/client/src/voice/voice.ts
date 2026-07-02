/**
 * voice.ts — Voice orchestrator (B10).
 *
 * Wires together:
 *   detectVoiceMode → capture → encoder → netClient.sendVoiceFrame   (send path)
 *   netClient.onVoice → JitterBuffer → PeerVoiceDecoder → Spatializer (recv path)
 *
 * PTT (push-to-talk) is driven by controllers.ts thumbstick-click. Gate:
 *   - talk-start flag sent on first PTT press frame
 *   - talk-stop flag sent on PTT release frame
 *   - VU/RMS gate: blocks below VAD_RMS_THRESHOLD are not encoded
 *
 * Fallback handling:
 *   - 'opus': full path (capture → encode → send; decode → jitter → spatial)
 *   - 'webm' / 'pcm': documented stub — logs a message, voice disabled
 *   - 'none': silently disabled, no crash
 *
 * Live HRTF audio is a browser/Quest human test (deferred).
 */

import { detectVoiceMode } from './featureDetect.js';
import { VoiceCapture } from './capture.js';
import { createVoiceEncoder } from './encoder.js';
import { JitterBuffer, FLAG_KEY, FLAG_TALK_START, FLAG_TALK_STOP } from './jitterBuffer.js';
import { PeerVoiceDecoder } from './decoder.js';
import { Spatializer } from './spatializer.js';
import type { NetClient } from '../net/netClient.js';
import type { Avatars } from '../net/avatars.js';
import type { Vec3 } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** VAD gate: blocks with RMS below this are not sent (voice-silence suppression). */
const VAD_RMS_THRESHOLD = 0.01;

/** Jitter buffer target depth (ms). */
const JITTER_TARGET_MS = 60;

/** Jitter buffer max depth (ms). */
const JITTER_MAX_MS = 200;

/** Speaking indicator timeout: if no frame arrives for this many ms, clear indicator. */
const SPEAKING_TIMEOUT_MS = 300;

// ---------------------------------------------------------------------------
// Per-peer state
// ---------------------------------------------------------------------------

interface PeerState {
  jitterBuffer: JitterBuffer;
  decoder: PeerVoiceDecoder | null;
  speakingTimeoutId: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// VoiceOpts
// ---------------------------------------------------------------------------

export interface VoiceOpts {
  /**
   * Called each frame to get the local camera head position/forward/up
   * for the Web Audio listener. If omitted, the listener is not updated.
   */
  getListenerPose?: () => { pos: Vec3; forward: Vec3; up: Vec3 };

  /**
   * Called to get a peer's current head world position for spatialization.
   * If omitted, positions default to {0,0,0}.
   */
  getPeerPosition?: (playerId: string) => Vec3 | null;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export class Voice {
  private readonly _ctx: AudioContext;
  private readonly _netClient: NetClient;
  private readonly _avatars: Avatars;
  private readonly _opts: VoiceOpts;

  private _spatializer: Spatializer | null = null;
  private _capture: VoiceCapture | null = null;
  private _encoder: ReturnType<typeof createVoiceEncoder> | null = null;
  private _peers = new Map<number, PeerState>();

  /** Self-mute: when true, captured blocks are not sent. */
  private _selfMuted = false;

  /** PTT state: true while the thumbstick-click is held. */
  private _pttActive = false;

  /** Whether we're in an active talk window (between talk-start and talk-stop). */
  private _talking = false;

  /**
   * True until the first encoded frame of the current utterance has been sent
   * (that frame carries FLAG_KEY | FLAG_TALK_START). Reset to true after a
   * talk-stop so the next press begins a fresh utterance.
   */
  private _firstFrame = true;

  /** Timestamp (ms) to stamp on a synthetic talk-stop frame at release. */
  private _lastFrameTsMs = 0;

  /** Whether voice has been enabled. */
  private _enabled = false;

  constructor(ctx: AudioContext, netClient: NetClient, avatars: Avatars, opts: VoiceOpts = {}) {
    this._ctx = ctx;
    this._netClient = netClient;
    this._avatars = avatars;
    this._opts = opts;
  }

  // -------------------------------------------------------------------------
  // enable / disable
  // -------------------------------------------------------------------------

  /**
   * Detect voice mode and start the send + receive pipelines.
   * Must be called from a user gesture so getUserMedia / AudioContext resume work.
   */
  async enable(): Promise<void> {
    if (this._enabled) return;
    this._enabled = true;

    // Wire inbound voice frames from netClient via the dedicated setter (NOT by
    // mutating opts) so we never clobber a concurrent disable()'s clear.
    this._netClient.setOnVoice(
      (senderId: number, tsMs: number, bytes: Uint8Array, flags: number) => {
        this.receiveFrame(senderId, tsMs, bytes, flags);
      }
    );

    const mode = await detectVoiceMode();

    // Guard the post-await continuation: if disable() ran while detectVoiceMode()
    // was in flight, _enabled is now false. Bail out so we don't start capture on
    // a dead Voice or (via _startOpusPath) install anything over the cleared state.
    if (!this._enabled) return;

    // Audit #13: guard the whole pipeline start. createVoiceEncoder()/configure()
    // (or capture.start()) can throw synchronously or reject; without this the
    // caller's `void voice.enable()` would produce an unhandled rejection and, in
    // the worst case, leave _enabled=true on a half-started Voice. On any failure
    // we degrade gracefully: log, mark disabled, and resolve.
    try {
      if (mode === 'opus') {
        await this._startOpusPath();
      } else if (mode === 'webm' || mode === 'pcm') {
        console.info(
          `[Voice] mode='${mode}' — full encode/send path not implemented; ` +
            'voice TX disabled. RX spatialization still active.'
        );
        this._startSpatializer();
      } else {
        // 'none' — silently disable
        console.info('[Voice] no voice capability detected — voice disabled.');
      }
    } catch (e) {
      console.warn('[Voice] failed to start voice pipeline; voice disabled:', e);
      // Tear down anything partially started and return to a clean disabled state.
      this.disable();
    }
  }

  /** Stop all voice activity and release resources. */
  disable(): void {
    this._enabled = false;
    this._pttActive = false;
    this._talking = false;

    // Remove inbound hook (via the setter, not by mutating opts).
    this._netClient.setOnVoice(null);

    // Stop capture + encoder
    this._capture?.stop();
    this._encoder?.close();
    this._capture = null;
    this._encoder = null;

    // Dispose all peers
    for (const [, state] of this._peers) {
      state.decoder?.close();
      if (state.speakingTimeoutId !== null) clearTimeout(state.speakingTimeoutId);
    }
    this._peers.clear();

    this._spatializer?.disposeAll();
    this._spatializer = null;
  }

  // -------------------------------------------------------------------------
  // PTT control (called from controllers.ts per-frame)
  // -------------------------------------------------------------------------

  /**
   * Called from the controller per-frame PTT edge detection.
   * `pressed` = true on press (rising edge), false on release (falling edge).
   */
  setPtt(pressed: boolean): void {
    if (pressed === this._pttActive) return;
    this._pttActive = pressed;
    if (pressed) {
      this._talking = true;
    } else {
      // Falling edge: guarantee a talk-stop frame is emitted so receivers flush
      // their jitter buffers and reset their decoders at the utterance boundary.
      // The old design set a `pendingStop` flag inside onBlock, but onBlock
      // early-returns once _pttActive is false, so the stop was never produced.
      // Here we emit an explicit zero-length talk-stop frame on the release edge.
      if (this._talking) {
        this._sendTalkStop();
      }
      this._talking = false;
    }
  }

  /**
   * Emit a synthetic zero-length frame carrying FLAG_TALK_STOP. Called on the
   * PTT falling edge (and open-mic VAD stop) so the utterance is cleanly closed
   * even when no more audio blocks will be captured.
   */
  private _sendTalkStop(): void {
    // Only meaningful while sending is active. Skip if never sent a frame.
    this._netClient.sendVoiceFrame(new Uint8Array(0), this._lastFrameTsMs, FLAG_TALK_STOP);
    // Next press begins a fresh utterance (talk-start + key on its first frame).
    this._firstFrame = true;
  }

  // -------------------------------------------------------------------------
  // Peer lifecycle
  // -------------------------------------------------------------------------

  /**
   * Fully tear down a departed peer (audit #10 leak fix).
   *
   * `onPlayerLeave` used to only remove the avatar; the peer's AudioDecoder,
   * PannerNode/GainNode chain, speaking-indicator timeout and JitterBuffer all
   * leaked and `tick()` kept iterating them every frame. Call this from
   * main.ts's onPlayerLeave (alongside avatars.remove) so:
   *   - the decoder is closed,
   *   - the spatializer's audio nodes for the peer are disconnected + dropped,
   *   - any pending speaking timeout is cleared,
   *   - the per-peer map entry is deleted.
   * Idempotent: a second call for the same id is a no-op.
   */
  removePeer(senderId: number): void {
    const peer = this._peers.get(senderId);
    if (!peer) return;

    peer.decoder?.close();
    if (peer.speakingTimeoutId !== null) {
      clearTimeout(peer.speakingTimeoutId);
      peer.speakingTimeoutId = null;
    }

    const playerId = `p${senderId}`;
    this._spatializer?.removePeer(playerId);

    this._peers.delete(senderId);
  }

  // -------------------------------------------------------------------------
  // Self-mute
  // -------------------------------------------------------------------------

  setMuted(muted: boolean): void {
    this._selfMuted = muted;
    this._capture?.setMuted(muted);
  }

  // -------------------------------------------------------------------------
  // Per-peer mute / gain
  // -------------------------------------------------------------------------

  setPeerMuted(senderId: number, muted: boolean): void {
    const playerId = `p${senderId}`;
    this._spatializer?.setPeerGain(playerId, muted ? 0 : 1);
  }

  // -------------------------------------------------------------------------
  // Inbound frame routing (public so tests can call directly)
  // -------------------------------------------------------------------------

  receiveFrame(senderId: number, tsMs: number, bytes: Uint8Array, flags: number): void {
    const peer = this._ensurePeer(senderId);
    peer.jitterBuffer.push(tsMs, bytes, flags);

    // Reset speaking indicator timeout
    const playerId = `p${senderId}`;
    if (peer.speakingTimeoutId !== null) clearTimeout(peer.speakingTimeoutId);
    this._avatars.setSpeaking(playerId, true);
    peer.speakingTimeoutId = setTimeout(() => {
      this._avatars.setSpeaking(playerId, false);
      peer.speakingTimeoutId = null;
    }, SPEAKING_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Per-peer jitter pop + decode tick (public for tests; called from per-frame loop)
  // -------------------------------------------------------------------------

  tickPeer(senderId: number, nowMs: number): void {
    const peer = this._peers.get(senderId);
    if (!peer) return;
    const frame = peer.jitterBuffer.pop(nowMs);
    if (frame && peer.decoder) {
      peer.decoder.decode(frame.tsMs, frame.bytes, frame.flags);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update (called from main.ts game loop)
  // -------------------------------------------------------------------------

  /**
   * Call once per render frame.
   *   - Updates the Web Audio listener from the XR camera pose.
   *   - Updates each peer's panner from its avatar head pose.
   *   - Pops + decodes each peer's jitter buffer.
   */
  tick(nowMs: number): void {
    // Update listener
    if (this._spatializer && this._opts.getListenerPose) {
      const { pos, forward, up } = this._opts.getListenerPose();
      this._spatializer.setListener(pos, forward, up);
    }

    // Per-peer: update position + pop jitter
    for (const [senderId, peer] of this._peers) {
      const playerId = `p${senderId}`;

      // Update panner position from avatar pose
      if (this._spatializer && this._opts.getPeerPosition) {
        const pos = this._opts.getPeerPosition(playerId);
        if (pos) this._spatializer.setPeerPosition(playerId, pos);
      }

      // Pop + decode
      const frame = peer.jitterBuffer.pop(nowMs);
      if (frame && peer.decoder) {
        peer.decoder.decode(frame.tsMs, frame.bytes, frame.flags);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async _startOpusPath(): Promise<void> {
    this._startSpatializer();

    // Reset the per-utterance send state for a fresh capture session.
    this._firstFrame = true;

    this._encoder = createVoiceEncoder({
      onFrame: (bytes, tsMicros /* key */) => {
        // Only send while actively pressing PTT (talk-stop is emitted separately
        // on the release edge via _sendTalkStop, since no more blocks arrive
        // once PTT is released).
        if (this._selfMuted || !this._pttActive) return;

        const tsMs = Math.round(tsMicros / 1000);
        this._lastFrameTsMs = tsMs;
        let flags = 0;
        if (this._firstFrame) {
          flags |= FLAG_KEY | FLAG_TALK_START;
          this._firstFrame = false;
        }
        this._netClient.sendVoiceFrame(bytes, tsMs, flags);
      },
    });

    try {
      this._capture = new VoiceCapture(this._ctx, {
        onBlock: (block: Float32Array, rms: number) => {
          if (this._selfMuted) return;
          if (!this._pttActive) return;
          if (rms < VAD_RMS_THRESHOLD) return; // VAD gate (only while talking)

          const tsMicros = Math.round(performance.now() * 1000);
          this._encoder?.encodeBlock(block, tsMicros);
        },
      });
      await this._capture.start();
    } catch (e) {
      console.warn('[Voice] failed to start capture:', e);
      this._capture = null;
    }
  }

  private _startSpatializer(): void {
    if (!this._spatializer) {
      this._spatializer = new Spatializer(this._ctx);
    }
  }

  private _ensurePeer(senderId: number): PeerState {
    let peer = this._peers.get(senderId);
    if (!peer) {
      const playerId = `p${senderId}`;
      const jitterBuffer = new JitterBuffer({
        targetDepthMs: JITTER_TARGET_MS,
        maxDepthMs: JITTER_MAX_MS,
      });

      // Create panner for this peer via spatializer
      let decoder: PeerVoiceDecoder | null = null;
      if (this._spatializer) {
        const { panner } = this._spatializer.ensurePeer(playerId);
        if (typeof AudioDecoder !== 'undefined') {
          decoder = new PeerVoiceDecoder(this._ctx, panner);
        }
      }

      peer = { jitterBuffer, decoder, speakingTimeoutId: null };
      this._peers.set(senderId, peer);
    }
    return peer;
  }
}
