let audioCtx = null;

function getContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

export function initAudio() {
  return {
    playSpawn,
    playGrab,
    playRelease,
    playImpact,
    resume
  };
}

function resume() {
  const ctx = getContext();
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
}

// Square wave 200->800Hz ramp, 0.15s
function playSpawn() {
  const ctx = getContext();
  if (ctx.state === 'suspended') return;

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
function playGrab() {
  const ctx = getContext();
  if (ctx.state === 'suspended') return;

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
function playRelease() {
  const ctx = getContext();
  if (ctx.state === 'suspended') return;

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
function playImpact() {
  const ctx = getContext();
  if (ctx.state === 'suspended') return;

  const now = ctx.currentTime;
  const bufferSize = ctx.sampleRate * 0.08;
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
