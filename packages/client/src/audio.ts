/**
 * audio.ts — Web Audio SFX module
 *
 * Creates a single 48 kHz AudioContext shared with the upcoming voice subsystem
 * (Phase B). All play* functions are safe no-ops when ctx.state !== 'running'
 * so they never throw inside the game loop before the first user gesture.
 *
 * Audit #20: AudioContext construction can throw (no Web Audio support, a locked-
 * down/hardened context, or an unsupported sampleRate). That must NOT abort the
 * whole app init() — the experience still works without sound. initAudio()
 * therefore wraps construction in try/catch and, on failure, returns a safe
 * NO-OP AudioApi (ctx=null; resume/play* never throw) so the caller can run
 * unchanged. `ctx` is nullable so downstream (voice) can detect the no-audio case.
 */

export type AudioApi = {
  ctx: AudioContext | null;
  resume(): Promise<void>;
  playSpawn(): void;
  playGrab(): void;
  playRelease(): void;
  playImpact(v?: number): void;
};

/**
 * A no-op AudioApi returned when the AudioContext cannot be constructed (audit
 * #20). Every method is a no-throw no-op; `ctx` is null so callers can detect
 * the degraded state. The app runs fully, just without sound.
 */
function noopAudio(): AudioApi {
  return {
    ctx: null,
    resume: () => Promise.resolve(),
    playSpawn: () => {},
    playGrab: () => {},
    playRelease: () => {},
    playImpact: (_v?: number) => {
      void _v;
    },
  };
}

export function initAudio(): AudioApi {
  // Audit #20: guard construction. A throw here (unsupported / hardened context)
  // must degrade to silent audio, not abort the whole app's init().
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 48000 });
  } catch (e) {
    console.warn('[audio] AudioContext construction failed; running without sound:', e);
    return noopAudio();
  }

  function resume(): Promise<void> {
    if (ctx.state === 'suspended') {
      return ctx.resume();
    }
    return Promise.resolve();
  }

  // Square wave 200->800Hz ramp, 0.15s
  function playSpawn(): void {
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.linearRampToValueAtTime(800, now + 0.15);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  // Sine 400Hz blip, 0.05s
  function playGrab(): void {
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  // Sine 400->200Hz ramp down, 0.1s
  function playRelease(): void {
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.linearRampToValueAtTime(200, now + 0.1);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  // White noise burst through lowpass filter, 0.08s
  // v: optional velocity scalar (reserved for Phase B tuning, currently unused)
  function playImpact(v?: number): void {
    void v; // reserved for Phase B — accepted in signature now so callers don't need to change
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * 0.08);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, now);
    filter.frequency.linearRampToValueAtTime(200, now + 0.08);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.08);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(now);
    source.stop(now + 0.08);
  }

  return { ctx, resume, playSpawn, playGrab, playRelease, playImpact };
}
