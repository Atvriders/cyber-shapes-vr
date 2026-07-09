/**
 * mixer.test.ts — the stage priority-ducking mixer (C9, spec §6.2).
 *
 * The §6.2 ladder: higher-priority sources DUCK lower ones via gain ramps.
 * Room VOICE is PERMANENTLY excluded (co-located mics + speakers = feedback);
 * a voice-tagged source is REFUSED. A master-bus GainNode is exposed (C31's
 * clip machine taps it via createMediaStreamDestination).
 *
 * Uses a mocked AudioContext with recording GainNodes — no Web Audio needed.
 * These are the Step-1 RED tests (brief C9 Step 1).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StageMixer } from '../src/stage/mixer.ts';

// ---------------------------------------------------------------------------
// Mock AudioContext / AudioNode / GainNode — records connections + gain ramps.
// ---------------------------------------------------------------------------

interface RampCall {
  value: number;
  atTime: number;
}

class MockAudioParam {
  value = 1;
  ramps: RampCall[] = [];
  setValueAtTime(v: number, t: number): this {
    this.value = v;
    this.ramps.push({ value: v, atTime: t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.value = v;
    this.ramps.push({ value: v, atTime: t });
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class MockAudioNode {
  connectedTo: MockAudioNode[] = [];
  connect(dest: MockAudioNode): MockAudioNode {
    this.connectedTo.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connectedTo = [];
  }
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockAudioContext {
  currentTime = 0;
  destination = new MockAudioNode();
  createGain(): MockGainNode {
    return new MockGainNode();
  }
}

function makeCtx(): AudioContext {
  return new MockAudioContext() as unknown as AudioContext;
}
function makeSource(): AudioNode {
  return new MockAudioNode() as unknown as AudioNode;
}

// ---------------------------------------------------------------------------

describe('StageMixer — construction + master bus', () => {
  let ctx: AudioContext;
  let mixer: StageMixer;
  beforeEach(() => {
    ctx = makeCtx();
    mixer = new StageMixer(ctx);
  });

  it('exposes a master-bus GainNode (C31 taps it)', () => {
    const bus = mixer.masterBus;
    expect(bus).toBeDefined();
    expect(bus.gain).toBeDefined();
  });

  it('routes the master bus to the context destination', () => {
    const bus = mixer.masterBus as unknown as MockGainNode;
    const dest = (ctx as unknown as MockAudioContext).destination;
    expect(bus.connectedTo).toContain(dest);
  });
});

describe('StageMixer — priority ducking (§6.2)', () => {
  let ctx: AudioContext;
  let mixer: StageMixer;
  beforeEach(() => {
    ctx = makeCtx();
    mixer = new StageMixer(ctx);
  });

  it('registering a source returns a per-source GainNode wired to the master bus', () => {
    const g = mixer.register(makeSource(), 3) as unknown as MockGainNode;
    expect(g.gain).toBeDefined();
    const bus = mixer.masterBus as unknown as MockAudioNode;
    expect(g.connectedTo).toContain(bus);
  });

  it('a priority-1 (highest) active source ducks priorities 2–5', () => {
    const p2 = mixer.register(makeSource(), 2) as unknown as MockGainNode;
    const p3 = mixer.register(makeSource(), 3) as unknown as MockGainNode;
    const p4 = mixer.register(makeSource(), 4) as unknown as MockGainNode;
    const p5 = mixer.register(makeSource(), 5) as unknown as MockGainNode;
    const p1 = mixer.register(makeSource(), 1) as unknown as MockGainNode;

    // Nothing is ducked before p1 becomes active.
    mixer.setActive(p1 as unknown as GainNode, true);

    // Every lower-priority source is now ducked below unity.
    for (const lower of [p2, p3, p4, p5]) {
      expect(lower.gain.value).toBeLessThan(1);
    }
    // The ducker itself stays at full gain.
    expect(p1.gain.value).toBe(1);
  });

  it('deactivating the top source un-ducks the lower ones (ramps back toward unity)', () => {
    const p3 = mixer.register(makeSource(), 3) as unknown as MockGainNode;
    const p1 = mixer.register(makeSource(), 1) as unknown as MockGainNode;

    mixer.setActive(p1 as unknown as GainNode, true);
    expect(p3.gain.value).toBeLessThan(1);

    mixer.setActive(p1 as unknown as GainNode, false);
    expect(p3.gain.value).toBe(1);
  });

  it('a lower-priority source never ducks a higher-priority one', () => {
    const p1 = mixer.register(makeSource(), 1) as unknown as MockGainNode;
    const p4 = mixer.register(makeSource(), 4) as unknown as MockGainNode;

    mixer.setActive(p4 as unknown as GainNode, true);
    // p1 (higher priority) is NOT ducked by an active p4.
    expect(p1.gain.value).toBe(1);
  });

  it('ducking is applied via a scheduled gain ramp (not an instantaneous jump)', () => {
    const p3 = mixer.register(makeSource(), 3) as unknown as MockGainNode;
    const p1 = mixer.register(makeSource(), 1) as unknown as MockGainNode;
    mixer.setActive(p1 as unknown as GainNode, true);
    expect(p3.gain.ramps.length).toBeGreaterThan(0);
  });
});

describe('StageMixer — room voice is PERMANENTLY excluded (§6.2)', () => {
  let ctx: AudioContext;
  let mixer: StageMixer;
  beforeEach(() => {
    ctx = makeCtx();
    mixer = new StageMixer(ctx);
  });

  it('a voice-tagged source is REFUSED (throws, never connected)', () => {
    expect(() => mixer.register(makeSource(), 3, { voice: true })).toThrow();
  });

  it('the refused voice source is never wired to the master bus', () => {
    const src = makeSource() as unknown as MockAudioNode;
    try {
      mixer.register(src as unknown as AudioNode, 3, { voice: true });
    } catch {
      /* expected */
    }
    const bus = mixer.masterBus as unknown as MockAudioNode;
    expect(src.connectedTo).not.toContain(bus);
  });

  it('a normal (non-voice) source at the same priority IS accepted', () => {
    expect(() => mixer.register(makeSource(), 3)).not.toThrow();
  });
});
