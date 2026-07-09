/**
 * mixer.ts — the stage priority-ducking audio mixer (C9, spec §6.2).
 *
 * ONE global priority ladder, owned by the stage client. Higher-priority sources
 * DUCK lower ones via gain ramps; when the ducker goes quiet the lower sources
 * ramp back to unity. The §6.2 ladder (1 = highest / ducks everything):
 *   1. Showrunner klaxon / stingers
 *   2. Encore riser / drop
 *   3. Resonora quantized mix (or standalone theme) — TTS caption duck-shim rides here
 *   4. Ghost Arcade attract loop
 *   5. Ambient SFX
 *
 * ROOM VOICE IS PERMANENTLY EXCLUDED (§6.2): co-located booth mics + speakers =
 * feedback. A voice-tagged source is REFUSED (throws) — it is structurally
 * impossible to route room voice through the stage bus, which is also why C31's
 * clip machine can tap the master bus without ever capturing voice.
 *
 * A master-bus GainNode is exposed (`masterBus`) — C31 taps it via
 * `createMediaStreamDestination` (the confirmed one-line master-bus tap, §7.20).
 *
 * No THREE, no DOM. Web Audio only; unit-tested with a mocked AudioContext.
 */

/** The five §6.2 priority rungs. 1 = highest (ducks all lower). */
export type MixPriority = 1 | 2 | 3 | 4 | 5;

/** Options for {@link StageMixer.register}. */
export interface RegisterOpts {
  /**
   * True iff this source carries ROOM VOICE. Voice is PERMANENTLY excluded from
   * the stage bus (§6.2) — a voice-tagged source is REFUSED (register throws).
   * This is the structural guarantee behind C31's "room voice is absent because
   * the mixer never contains it".
   */
  voice?: boolean;
}

/** How far a ducked source is attenuated (linear gain) while a higher rung is active. */
const DUCK_GAIN = 0.15;
/** Ramp time (seconds) for duck / un-duck transitions — fast enough to feel live. */
const RAMP_S = 0.12;

interface Channel {
  gain: GainNode;
  priority: MixPriority;
  /** Whether this channel is currently producing sound (drives ducking of lower rungs). */
  active: boolean;
}

/**
 * The stage audio mixer. Construct with the stage AudioContext; register each
 * source with its §6.2 priority; toggle a source active via {@link setActive} so
 * it ducks everything below it. Read {@link masterBus} for the C31 tap.
 */
export class StageMixer {
  private readonly ctx: AudioContext;
  /** The single authoritative master bus (C31 taps this GainNode). */
  readonly masterBus: GainNode;

  /** Every registered channel, keyed by its per-source gain node. */
  private readonly channels = new Map<GainNode, Channel>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.masterBus = ctx.createGain();
    this.masterBus.gain.value = 1;
    this.masterBus.connect(ctx.destination);
  }

  /**
   * Register `source` at §6.2 `priority`, returning its per-source GainNode (the
   * handle the caller keeps to {@link setActive} / adjust). The source is wired
   * `source → gain → masterBus`. A voice-tagged source is REFUSED (throws) and is
   * NEVER connected to the bus (§6.2 permanent exclusion).
   */
  register(source: AudioNode, priority: MixPriority, opts: RegisterOpts = {}): GainNode {
    if (opts.voice) {
      throw new Error(
        'StageMixer: room voice is permanently excluded from the stage bus (§6.2 — mic/speaker feedback). Refused.'
      );
    }
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterBus);
    this.channels.set(gain, { gain, priority, active: false });
    return gain;
  }

  /**
   * Mark a registered channel active/inactive. Activating it ducks every
   * lower-priority (higher-number) channel; deactivating re-evaluates ducking so
   * lower channels ramp back to unity if nothing else is holding them down.
   */
  setActive(gain: GainNode, active: boolean): void {
    const ch = this.channels.get(gain);
    if (!ch) throw new Error('StageMixer.setActive: node is not a registered channel');
    ch.active = active;
    this.applyDucking();
  }

  /**
   * Remove a channel from the mixer (disconnect + drop). Re-evaluates ducking.
   */
  unregister(gain: GainNode): void {
    const ch = this.channels.get(gain);
    if (!ch) return;
    try {
      ch.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    this.channels.delete(gain);
    this.applyDucking();
  }

  /**
   * Recompute every channel's target gain: a channel is DUCKED iff any HIGHER-
   * priority (lower number) channel is currently active; otherwise it rides at
   * unity. Applied as a scheduled ramp (never an instantaneous jump).
   */
  private applyDucking(): void {
    // The highest active priority anywhere (lowest number). null = nothing active.
    let topActive: MixPriority | null = null;
    for (const ch of this.channels.values()) {
      if (ch.active && (topActive === null || ch.priority < topActive)) {
        topActive = ch.priority;
      }
    }
    for (const ch of this.channels.values()) {
      // A channel ducks iff something strictly HIGHER-priority is active.
      const ducked = topActive !== null && ch.priority > topActive;
      this.ramp(ch.gain, ducked ? DUCK_GAIN : 1);
    }
  }

  /** Ramp a gain param to `target` over RAMP_S from the current context time. */
  private ramp(gain: GainNode, target: number): void {
    const now = this.ctx.currentTime;
    const p = gain.gain;
    // Anchor the current value so the ramp is continuous, then ramp to target.
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(target, now + RAMP_S);
  }
}
