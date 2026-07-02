/**
 * featureDetect.ts — Runtime voice mode detection.
 *
 * Detection ladder (in order, never UA-sniffs):
 *   1. WebCodecs AudioEncoder + AudioDecoder + isConfigSupported → 'opus'
 *   2. MediaRecorder with audio/webm;codecs=opus → 'webm'
 *   3. AudioWorklet + navigator.mediaDevices.getUserMedia → 'pcm'
 *   4. Otherwise → 'none'
 *
 * Never throws — any error results in 'none'.
 */

export type VoiceMode = 'opus' | 'webm' | 'pcm' | 'none';

export async function detectVoiceMode(): Promise<VoiceMode> {
  try {
    // 1. WebCodecs Opus path
    if (typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined') {
      try {
        const result = await AudioEncoder.isConfigSupported({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 1,
          bitrate: 24000,
        });
        if (result.supported) {
          return 'opus';
        }
      } catch {
        // isConfigSupported threw → fall through to next mode
      }
    }

    // 2. MediaRecorder WebM+Opus path
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ) {
      return 'webm';
    }

    // 3. PCM via AudioWorklet + getUserMedia
    const hasWorklet =
      typeof AudioWorklet !== 'undefined' ||
      (typeof AudioContext !== 'undefined' &&
        typeof (AudioContext.prototype as { audioWorklet?: unknown }).audioWorklet !== 'undefined');
    const hasGetUserMedia =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function';

    if (hasWorklet && hasGetUserMedia) {
      return 'pcm';
    }

    return 'none';
  } catch {
    return 'none';
  }
}
