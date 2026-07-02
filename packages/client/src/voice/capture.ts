/**
 * capture.ts — Microphone capture via AudioWorklet.
 *
 * `VoiceCapture` manages:
 *   • getUserMedia (echoCancellation/noiseSuppression/autoGainControl, mono 48kHz)
 *   • MediaStreamSource → AudioWorkletNode('voice-capture')
 *   • Worklet message → onBlock(samples, rms) callback
 *   • setMuted() gate: when muted, blocks are discarded
 *   • stop(): disconnect nodes, stop tracks
 *
 * The mic source is NOT connected to ctx.destination (no local monitoring).
 *
 * PTT / open-mic gating lives in the B10 orchestrator. This layer exposes
 * setMuted() only.
 */

// URL to the worklet processor — Vite resolves this as a static asset URL
// when using `new URL('...', import.meta.url)` at build time.  The path must
// match the actual file location relative to this source file.
const WORKLET_URL = new URL('./capture-worklet.ts', import.meta.url).href;

export type CaptureoOpts = {
  onBlock: (block: Float32Array, rms: number) => void;
};

export class VoiceCapture {
  private _ctx: AudioContext;
  private _opts: CaptureoOpts;
  private _muted = false;
  private _stream: MediaStream | null = null;
  private _sourceNode: MediaStreamAudioSourceNode | null = null;
  private _workletNode: AudioWorkletNode | null = null;

  constructor(ctx: AudioContext, opts: CaptureoOpts) {
    this._ctx = ctx;
    this._opts = opts;
  }

  async start(): Promise<void> {
    // Request microphone with voice-optimised constraints
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    this._stream = stream;

    // Load the worklet processor (no-op if already loaded)
    await this._ctx.audioWorklet.addModule(WORKLET_URL);

    // Wire: source → worklet (NOT connected to destination)
    this._sourceNode = this._ctx.createMediaStreamSource(stream);
    this._workletNode = new AudioWorkletNode(this._ctx, 'voice-capture');

    this._workletNode.port.onmessage = (
      ev: MessageEvent<{ samples: Float32Array; rms: number }>
    ) => {
      if (this._muted) return;
      this._opts.onBlock(ev.data.samples, ev.data.rms);
    };

    this._sourceNode.connect(this._workletNode);
    // Intentionally NOT connecting workletNode to ctx.destination
  }

  stop(): void {
    this._workletNode?.disconnect();
    this._sourceNode?.disconnect();
    this._stream?.getTracks().forEach((t) => t.stop());
    this._workletNode = null;
    this._sourceNode = null;
    this._stream = null;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
  }
}
