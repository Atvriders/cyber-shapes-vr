/**
 * capture-worklet.ts — AudioWorkletProcessor for voice capture.
 *
 * Accumulates mono 128-sample render quanta into 960-sample (20 ms @48 kHz)
 * blocks.  For each complete block it computes RMS and transfers the buffer
 * via the port so the main thread receives zero-copy Float32Array blocks.
 *
 * This file is loaded via `audioWorklet.addModule(...)` at runtime inside the
 * AudioWorklet global scope.  It must be self-contained (no imports) and
 * register the processor as a side-effect.
 *
 * NOTE: Because this runs inside the AudioWorklet global scope (not the main
 * thread), TypeScript DOM lib typings may not be 100 % complete here.  The
 * cast below silences the TS mismatch for `registerProcessor`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BLOCK_SAMPLES = 960; // 20 ms at 48 kHz

// The AudioWorklet global scope exposes AudioWorkletProcessor and
// registerProcessor.  Because this file is compiled in the normal DOM
// TypeScript environment these names are not in scope, so we reference them
// through `globalThis` to keep the compiler happy.
const _AudioWorkletProcessor: { new (): { port: MessagePort } } =
  (globalThis as any).AudioWorkletProcessor ?? class {};

const _registerProcessor: (name: string, ctor: unknown) => void =
  (globalThis as any).registerProcessor ?? (() => {});

class VoiceCaptureProcessor extends _AudioWorkletProcessor {
  private _buffer = new Float32Array(BLOCK_SAMPLES);
  private _offset = 0;

  process(inputs: Float32Array[][]): boolean {
    // inputs[0][0] = mono channel (or first channel if stereo source)
    const input = inputs[0]?.[0];
    if (!input) return true;

    let i = 0;
    while (i < input.length) {
      const remaining = BLOCK_SAMPLES - this._offset;
      const toCopy = Math.min(remaining, input.length - i);
      this._buffer.set(input.subarray(i, i + toCopy), this._offset);
      this._offset += toCopy;
      i += toCopy;

      if (this._offset === BLOCK_SAMPLES) {
        // Compute RMS
        let sumSq = 0;
        for (let s = 0; s < BLOCK_SAMPLES; s++) {
          sumSq += this._buffer[s] * this._buffer[s];
        }
        const rms = Math.sqrt(sumSq / BLOCK_SAMPLES);

        // Transfer the buffer (zero-copy) and reset with a fresh one
        const samples = this._buffer;
        this._buffer = new Float32Array(BLOCK_SAMPLES);
        this._offset = 0;

        this.port.postMessage({ samples, rms }, [samples.buffer]);
      }
    }

    return true; // keep alive
  }
}

_registerProcessor('voice-capture', VoiceCaptureProcessor);
