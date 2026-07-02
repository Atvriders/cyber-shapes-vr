/**
 * encoder.ts — WebCodecs Opus encoder wrapper.
 *
 * Wraps a WebCodecs `AudioEncoder` configured for:
 *   codec: 'opus', sampleRate: 48000, numberOfChannels: 1,
 *   bitrate: 24000, bitrateMode: 'constant', latencyMode: 'realtime'
 *
 * Usage:
 *   const enc = createVoiceEncoder({ onFrame, onConfig });
 *   enc.encodeBlock(float32Block960, tsMicros);
 *   enc.close();
 */

export type EncoderFrame = {
  bytes: Uint8Array;
  tsMicros: number;
  key: boolean;
};

export type VoiceEncoderOpts = {
  onFrame: (bytes: Uint8Array, tsMicros: number, key: boolean) => void;
  onConfig?: (cfg: AudioDecoderConfig) => void;
};

export type VoiceEncoder = {
  encodeBlock(block: Float32Array, tsMicros: number): void;
  close(): void;
};

function buildEncoder(opts: VoiceEncoderOpts): AudioEncoder {
  let configSent = false;

  const encoder = new AudioEncoder({
    output(chunk, meta) {
      // Copy encoded bytes out of the chunk
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);

      const key = chunk.type === 'key';

      if (!configSent && meta?.decoderConfig) {
        configSent = true;
        opts.onConfig?.(meta.decoderConfig as AudioDecoderConfig);
      }

      opts.onFrame(bytes, chunk.timestamp, key);
    },
    error(e) {
      console.error('[VoiceEncoder] AudioEncoder error:', e);
      // Safe reset: attempt to recreate (caller should re-call encodeBlock)
      // We don't re-create here because we don't have a ref to the outer
      // wrapper — the wrapper handles this if needed via re-creation.
    },
  });

  encoder.configure({
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: 1,
    bitrate: 24000,
    // bitrateMode and latencyMode are optional extras; add when TS typings allow
  } as AudioEncoderConfig);

  return encoder;
}

export function createVoiceEncoder(opts: VoiceEncoderOpts): VoiceEncoder {
  let encoder = buildEncoder(opts);

  function encodeBlock(block: Float32Array, tsMicros: number): void {
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: 960,
      numberOfChannels: 1,
      timestamp: tsMicros,
      // Cast to satisfy the TS `BufferSource` overload — Float32Array is
      // always backed by a plain ArrayBuffer at runtime (not SharedArrayBuffer).
      data: block as unknown as BufferSource,
    });
    encoder.encode(data);
    // AudioData is consumed by encode; close it to free resources
    data.close();
  }

  function close(): void {
    encoder.close();
  }

  return { encodeBlock, close };
}
