/**
 * encore.ts — Task C19 F12 Supernova Encore (spec §5.3 / §7.13): the crowd
 * charges a supernova; at 100 % a PINNED orb spawns beside the headset player;
 * its first impact (or a 10 s auto-launch if unthrown) fires a drop timeline at a
 * CLOCK-SYNCED `fireAtServerTime` (500 ms–1 s lead) so a SINGLE white flash lands
 * on every phone in the SAME instant.
 *
 * This host is composed with the {@link RoomTimelineHost} over the SAME
 * `RoomHandle` (exactly like the C16 SiegeHost). It is server-authoritative:
 *   • taps are ≤ 5/s debounced PER PHONE (never trust a flood) — §5.1 crowd cell;
 *   • the charge is NORMALIZED by the live crowd size (5 phones vs 30 comparable);
 *   • the orb is PINNED (§6.4 — never evicted); the eviction skips grabbed+pinned;
 *   • the drop timeline (impulse + arp + flash) fires on the SAME server tick via
 *     the C3 `scheduleAt(fireAt, offset, 'fireNow', cb)` — late phones fire NOW.
 *
 * The synchronized drop's THREE effects (a pure `applyRadialImpulse`, a seeded arp
 * as the PRIMARY drop audio, and a single ≤ 3 Hz white flash with a staff-disable)
 * all run in ONE scheduled callback so they are one server-time event. The F9
 * `themeCut?` and F8 `melodySource?` are ATTACH-IF-LANDED hooks (spec §7.13 —
 * F9 builds AFTER F12): the feature works fully with NEITHER, and the no-sibling
 * climax visual is a room-wide palette flash via CROWD_CUE + ENV_STATE. Encore core
 * NEVER depends on a sibling (FAQ #5).
 *
 * PURITY: no raw setTimeout / Date.now / Math.random — everything via the injected
 * TimerApi (Global Constraints / spec §5.5) and the C3 scheduleAt. The connection
 * layer wires the real broadcast + system timer + roomEpoch at the composition root.
 */

import {
  OPCODES,
  applyRadialImpulse,
  scheduleAt,
  crowdNormalizedCharge,
  chargeToWire,
  isFullyCharged,
  createChargeDebounce,
  seededArp,
  crowdCueFrame,
  chargeStateFrame,
  CROWD_CUE_EFFECT,
  ENCORE_MAX_MS,
  ORB_AUTOLAUNCH_MS,
  DROP_LEAD_MS,
  ENCORE_COOLDOWN_MS,
  type ChargeDebounce,
  type PhysicsBody,
  type RoomHandle,
  type TimerApi,
  type TimerHandle,
  type Vec3,
} from '@cyber-shapes/shared';
import type { ServerWorld } from './serverWorld.js';
import type { RoomTimelineHost } from './timeline.js';

/** SHOWPIECE/CROWD_CUE fan out to the resident-class receive set + director. */
export const ENCORE_TIERS: readonly string[] = ['crowd', 'resident', 'spectator', 'director'];

/** The orb spawns beside the headset player, floating at head height. */
const ORB_POSITION: Vec3 = { x: 0, y: 5, z: -2 };
/** The detonation epicenter (matches the SUPERNOVA drop core). */
const DROP_EPICENTER: Vec3 = { x: 0, y: 4, z: 0 };
/** The radial-impulse magnitude — a wide, hard outward blast (the climax). */
const DROP_IMPULSE_MAGNITUDE = 180;
/** The palette-flash color index + the fallback ENV_STATE mode label. */
const FLASH_COLOR_INDEX = 6; // a bright near-white palette slot (0..6 valid).
const ENCORE_MODE = 'SUPERNOVA';
/** The ambient light-rig pulse cadence during the charge window (ms). */
const AMBIENT_PULSE_INTERVAL_MS = 1_500;
/** The coalesced CHARGE_STATE cadence (2–5 Hz → ~4 Hz). */
const CHARGE_PUBLISH_INTERVAL_MS = 250;

/** The late-join charge snapshot (spec §7.13 — coherent mid-charge). */
export interface EncoreSnapshot {
  /** 0–200 = 0–100.0 % (the Appendix B wire unit). */
  charge: number;
  crowdSize: number;
  /** The drop schedule (roomEpoch-relative), or 0 until armed for a drop. */
  fireAtMs: number;
}

/** Options for {@link EncoreHost}. */
export interface EncoreHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /** The authoritative world (orb spawn/pin + the impulse targets). */
  world: ServerWorld;
  /** The room's RoomHandle — spawn/pin/broadcast/roster (FAQ #5). */
  handle: RoomHandle;
  /** The timeline host — for `hold()`, the showpiece-overlay guard, and phase. */
  host: RoomTimelineHost;
  /** roomEpoch (ms) — fireAt is roomEpoch-relative; serverNow = timer.now() − epoch. */
  roomEpoch: number;
  /** The estimated clock offset for scheduleAt (server host runs local, so ~0). */
  offsetMs?: number;
  /** Broadcast an opcode payload (CROWD_CUE binary / ENV_STATE / SHOWPIECE JSON). */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** Increment the day-stats 'showpiece' counter on arm (§8 / C8). Optional. */
  metricsCount?(key: string): void;
  /**
   * ATTACH-IF-LANDED (spec §7.13): the F8 Resonora 16-bar melody REPLAY. Invoked
   * at the drop `fireAtServerTime` with the drop seed so the replay lands on the
   * same instant as the arp. ABSENT = no-op (the seeded arp is the primary audio).
   */
  melodySource?(fireAtServerTime: number, seed: number): void;
  /**
   * ATTACH-IF-LANDED (spec §7.13): the F9 `THEME_SET` HARD-CUT. Invoked at the drop
   * `fireAtServerTime` so the theme flips on the same instant. ABSENT = no-op (the
   * no-sibling fallback is the room-wide palette flash via CROWD_CUE + ENV_STATE).
   */
  themeCut?(fireAtServerTime: number): void;
}

/**
 * The C19 EncoreHost: one per room, armed by the timeline (FINALE auto-arm or
 * staff-fire). Owns the ambient light rig, the crowd charge (debounced +
 * normalized), the pinned orb + its 10 s auto-launch, and the synchronized drop
 * timeline (impulse + arp + flash on ONE server tick).
 */
export class EncoreHost {
  private readonly _timer: TimerApi;
  private readonly _world: ServerWorld;
  private readonly _handle: RoomHandle;
  private readonly _host: RoomTimelineHost;
  private readonly _opts: EncoreHostOpts;
  private readonly _roomEpoch: number;
  private readonly _offsetMs: number;
  private readonly _debounce: ChargeDebounce;

  private _active = false;
  /** Whether the live arm was staff-fired (audit only — no behavior change). */
  private _staffFired = false;
  private _taps = 0;
  private _orbId: string | null = null;
  private _flashDisabled = false;
  private _acquiredHold = false;
  /** The most recent normalized charge fraction (0..1). Non-decreasing until full. */
  private _chargeFrac = 0;
  /** The seed for THIS encore's arp + flash + light rig (deterministic per arm). */
  private _seed = 0;
  /** Cooldown gate: the earliest server time a re-arm is allowed. */
  private _cooldownUntil = -Infinity;

  // Drop state ---------------------------------------------------------------
  private _dropScheduled = false;
  private _dropFireAt: number | null = null;
  private _dropSeed = 0;
  private _dropFiredAt: number | null = null;
  private _arpFired = false;

  // Timers -------------------------------------------------------------------
  private _terminateHandle: TimerHandle | null = null;
  private _autoLaunchHandle: TimerHandle | null = null;
  private _ambientHandle: TimerHandle | null = null;
  private _lastPublishAt = -Infinity;
  private _dropHandle: { cancel(): void } | null = null;
  private _disposed = false;

  constructor(opts: EncoreHostOpts) {
    this._timer = opts.timer;
    this._world = opts.world;
    this._handle = opts.handle;
    this._host = opts.host;
    this._opts = opts;
    this._roomEpoch = opts.roomEpoch;
    this._offsetMs = opts.offsetMs ?? 0;
    this._debounce = createChargeDebounce();
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  get active(): boolean {
    return this._active;
  }
  /** Whether the live arm was staff-fired vs auto-armed (audit only). */
  get staffFired(): boolean {
    return this._staffFired;
  }
  get orbId(): string | null {
    return this._orbId;
  }
  /** True once the drop has been scheduled (impact or auto-launch). */
  get dropScheduled(): boolean {
    return this._dropScheduled;
  }
  /** The absolute (roomEpoch-relative) server time the drop is scheduled to fire. */
  get dropFireAt(): number | null {
    return this._dropFireAt;
  }
  /** The server time the drop actually fired (for the same-tick assertions). */
  get dropFiredAt(): number | null {
    return this._dropFiredAt;
  }
  /** The seed the drop used (the melody hook echoes this). */
  get dropSeed(): number {
    return this._dropSeed;
  }
  /** True once the seeded arp broadcast fired. */
  get arpFired(): boolean {
    return this._arpFired;
  }

  /** roomEpoch-relative server time. */
  private serverNow(): number {
    return Math.max(0, this._timer.now() - this._roomEpoch);
  }

  // -------------------------------------------------------------------------
  // Arming (spec §7.13) — CHARGE_START + max-brightness prompt + light rig
  // -------------------------------------------------------------------------

  /**
   * Arm the encore. Broadcasts the max-brightness PROMPT (a CROWD_CUE) at
   * CHARGE_START, starts the ambient light rig, and begins the ≤ 90 s cap timer.
   * Idempotent (a second arm while active is a no-op). Refused during cooldown.
   * Counts a `showpiece` metric on a real arm.
   *
   * @returns true iff the encore actually armed.
   */
  arm(opts: { staffFired?: boolean } = {}): boolean {
    if (this._disposed || this._active) return false;
    if (this._timer.now() < this._cooldownUntil) return false;
    // A staff-fired arm and an auto-arm run the identical sequence; the flag is
    // recorded only so a later audit can tell the two apart (no behavior change).
    this._staffFired = opts.staffFired === true;
    this._active = true;
    this._taps = 0;
    this._chargeFrac = 0;
    this._orbId = null;
    this._dropScheduled = false;
    this._dropFireAt = null;
    this._dropFiredAt = null;
    this._arpFired = false;
    this._debounce.reset();
    // A deterministic per-arm seed (roomEpoch-relative time folded) drives the
    // arp, the flash color ripple, and the ambient rig — no Math.random.
    this._seed = (this.serverNow() * 2654435761) >>> 0;

    // Claim the single-overlay-writer guard (§5.6/§7.16) — while the encore is
    // live, overlay-writing dials are refused (wrongPhase), just like the siege.
    this._host.beginShowpieceOverlay();

    // Extend the FINALE phase so the charge window survives (spec §5.5 hold clause:
    // "an active showpiece/encore … holds phase advance until its END event").
    this._host.timeline.hold(ENCORE_MAX_MS);
    this._acquiredHold = true;

    this._opts.metricsCount?.('showpiece');

    // Max-brightness PROMPT at CHARGE_START (spec §7.13 "prompt at join AND
    // CHARGE_START"). A CROWD_CUE with the BRIGHTNESS_PROMPT effect.
    this.broadcastCue(CROWD_CUE_EFFECT.BRIGHTNESS_PROMPT, 255, 2_000, 0);
    // An initial CHARGE_STATE (0 %) so a joiner already sees a live meter.
    this.publishCharge(true);

    // The ambient light rig — slow latency-tolerant pulses with seeded per-phone
    // phase offsets (the phase offsets are applied CLIENT-side from the cue seed).
    this.armAmbientRig();

    // The ≤ 90 s cap: the encore self-terminates even if the crowd never charges.
    this._terminateHandle = this._timer.setTimeout(() => {
      this._terminateHandle = null;
      this.terminate();
    }, ENCORE_MAX_MS);

    return true;
  }

  // -------------------------------------------------------------------------
  // Charge (spec §7.13) — TAP primary, ≤ 5/s debounce, crowd-size normalization
  // -------------------------------------------------------------------------

  /**
   * Record one phone charge TAP (the PRIMARY input; shake is an opt-in client
   * garnish that maps to the same intent). Debounced to ≤ 5/s per phone (a flood
   * cannot cheat the meter, and cannot starve a slow tapper — the window is
   * per-phone). At 100 % normalized charge the pinned orb spawns + the 10 s
   * auto-launch arms. No-op when inactive.
   */
  tap(peerId: string): void {
    if (!this._active || this._disposed) return;
    if (this._dropScheduled) return; // charge is done; ignore late taps.
    if (!this._debounce.accept(peerId, this._timer.now())) return; // ≤ 5/s
    this._taps++;
    const crowdSize = this.crowdSize();
    const frac = crowdNormalizedCharge(this._taps, crowdSize);
    // Charge is non-decreasing (never regress the meter if crowdSize shrinks).
    if (frac > this._chargeFrac) this._chargeFrac = frac;
    if (isFullyCharged(this._chargeFrac) && this._orbId === null) {
      this.spawnOrb();
    }
  }

  /** The live crowd tier size (the normalization divisor; §7.13). */
  private crowdSize(): number {
    return this._handle
      .roster()
      .filter((p) => (p as { tier?: string }).tier === 'crowd').length;
  }

  /**
   * Publish a coalesced CHARGE_STATE (2–5 Hz — NEVER per-tap). The crowd meter +
   * the stage constellation bar read this. Rate-limited unless `force`.
   */
  publishCharge(force = false): void {
    if (!this._active) return;
    const now = this._timer.now();
    if (!force && now - this._lastPublishAt < CHARGE_PUBLISH_INTERVAL_MS) return;
    this._lastPublishAt = now;
    const frame = chargeStateFrame({
      charge: chargeToWire(this._chargeFrac),
      crowdSize: this.crowdSize(),
      fireAtMs: this._dropFireAt ?? 0,
    });
    this._opts.broadcast(OPCODES.CROWD_CUE, frame, ENCORE_TIERS);
  }

  // -------------------------------------------------------------------------
  // The pinned orb (spec §7.13) — spawns at 100 %, auto-launches at 10 s
  // -------------------------------------------------------------------------

  private spawnOrb(): void {
    const res = this._handle.store.spawn({
      type: 'sphere',
      position: { ...ORB_POSITION },
      colorIndex: FLASH_COLOR_INDEX,
      renderMode: 'solid',
      scale: 1.5,
    });
    this._orbId = res ? res.id : null;
    if (this._orbId) this._handle.pin(this._orbId); // §6.4 — never evicted.
    // A final full CHARGE_STATE so every meter reads 100 %.
    this.publishCharge(true);
    // Auto-launch: if the orb is UNTHROWN after 10 s (or there is no headset to
    // throw it), the drop fires anyway — the no-headset degrade rung.
    this._autoLaunchHandle = this._timer.setTimeout(() => {
      this._autoLaunchHandle = null;
      if (!this._dropScheduled) this.scheduleDrop();
    }, ORB_AUTOLAUNCH_MS);
  }

  /**
   * Notify the host that a shape impacted (from the sim loop / room). If it is the
   * orb (thrown by the headset player), the drop timeline fires. A no-op for any
   * other shape or before the orb exists.
   */
  notifyImpact(shapeId: string): void {
    if (!this._active || this._disposed) return;
    if (this._orbId === null || shapeId !== this._orbId) return;
    if (this._dropScheduled) return;
    this.scheduleDrop();
  }

  /**
   * STAFF override: force the drop directly (the no-crowd rung — a staff-fired
   * encore with an empty crowd still detonates). No-op if already dropping.
   */
  forceDrop(): void {
    if (!this._active || this._disposed || this._dropScheduled) return;
    this.scheduleDrop();
  }

  // -------------------------------------------------------------------------
  // The synchronized DROP timeline (spec §7.13) — impulse + arp + flash ONE tick
  // -------------------------------------------------------------------------

  private scheduleDrop(): void {
    this._dropScheduled = true;
    // Cancel the auto-launch (impact beat it, or this IS the auto-launch).
    if (this._autoLaunchHandle !== null) {
      this._timer.clearTimeout(this._autoLaunchHandle);
      this._autoLaunchHandle = null;
    }
    this._dropSeed = this._seed;
    const fireAt = this.serverNow() + DROP_LEAD_MS;
    this._dropFireAt = fireAt;
    // Republish the charge so the drop schedule (fireAtMs) reaches late joiners.
    this.publishCharge(true);
    // The clock-synced single flash: scheduleAt fires the WHOLE drop on the SAME
    // server tick at `fireAt`; a late phone (already past fireAt) fires NOW.
    this._dropHandle = scheduleAt(fireAt, this._offsetMs, 'fireNow', () => this.fireDrop(fireAt), this._timer);
  }

  /**
   * The drop moment — ALL THREE effects on ONE server tick (spec §7.13):
   *   1) radial impulse (pure applyRadialImpulse — the physical climax);
   *   2) the seeded arp (the PRIMARY drop audio);
   *   3) the synchronized single white flash (≤ 3 Hz, staff-disable).
   * PLUS the attach-if-landed hooks (themeCut/melodySource) ONLY when wired, and
   * the no-sibling fallback (ENV_STATE + palette flash) always. Then the encore
   * winds down (END + cooldown).
   */
  private fireDrop(fireAt: number): void {
    if (this._disposed) return;
    this._dropFiredAt = this.serverNow();

    // (1) IMPULSE — a pure, seeded radial blast over the live bodies. NetShapes
    // expose position/velocity/grabbedBy, exactly the PhysicsBody view the pure
    // fn mutates in place (held bodies are exempt — §7.13).
    const bodies = this._world.shapes as unknown as PhysicsBody[];
    applyRadialImpulse(bodies, DROP_EPICENTER, DROP_IMPULSE_MAGNITUDE, this._dropSeed);

    // (2) ARP — the deterministic seeded arpeggio (PRIMARY drop audio). The stage
    // synth resolves the notes from the seed; we broadcast the seed + the fireAt on
    // a CROWD_CUE so every client generates the IDENTICAL arp locally. (seededArp
    // is computed here too so the payload can carry a note count if needed.)
    void seededArp(this._dropSeed);
    this._opts.broadcast(
      OPCODES.CROWD_CUE,
      crowdCueFrame({
        effect: CROWD_CUE_EFFECT.AMBIENT_PULSE, // an arp-cue rides the AMBIENT rig channel
        colorIndex: FLASH_COLOR_INDEX,
        intensity: 255,
        durationMs: 900,
        seed: this._dropSeed,
        fireAtMs: fireAt,
      }),
      ENCORE_TIERS
    );
    this._arpFired = true;

    // (3) FLASH — the synchronized single white flash. Suppressed when the flash is
    // staff-disabled (§6.3 comfort) — the physical drop still runs; only the
    // photosensitive flash is withheld.
    if (!this._flashDisabled) {
      this._opts.broadcast(
        OPCODES.CROWD_CUE,
        crowdCueFrame({
          effect: CROWD_CUE_EFFECT.PALETTE_FLASH,
          colorIndex: FLASH_COLOR_INDEX,
          intensity: 255,
          durationMs: 400, // a SINGLE short pulse (≤ 3 Hz — one flash, no strobe)
          seed: this._dropSeed,
          fireAtMs: fireAt,
        }),
        ENCORE_TIERS
      );
    }

    // The NO-SIBLING fallback climax visual: a room-wide ENV_STATE palette flash
    // (spec §7.13). Always fired (independent of the theme hook) so the climax
    // reads even with NO F9/F8 sibling wired. `endsAt` gives a coherent revert.
    this._opts.broadcast(
      OPCODES.ENV_STATE,
      {
        t: 'env-state',
        serverTimestamp: fireAt,
        mode: ENCORE_MODE,
        params: this._host.effectiveParams(),
        endsAt: fireAt + 600,
      },
      ENCORE_TIERS
    );

    // ATTACH-IF-LANDED hooks — invoked ONLY when wired (absent = no-op). Both land
    // on the SAME fireAt so the theme cut + melody replay are one instant with the
    // flash + arp (spec §7.13; F9 builds AFTER F12 — cut from the critical path).
    this._opts.themeCut?.(fireAt);
    this._opts.melodySource?.(fireAt, this._dropSeed);

    // Wind down shortly after the blast — unpin + terminate (cooldown starts).
    this._timer.setTimeout(() => this.terminate(), 1_500);
  }

  // -------------------------------------------------------------------------
  // Comfort — the staff flash-disable (§6.3)
  // -------------------------------------------------------------------------

  /** Staff toggle: disable the synchronized flash (photosensitivity, §6.3). */
  setFlashDisabled(disabled: boolean): void {
    this._flashDisabled = disabled;
  }
  get flashDisabled(): boolean {
    return this._flashDisabled;
  }

  // -------------------------------------------------------------------------
  // The ambient light rig (spec §7.13) — slow CROWD_CUE pulses, seeded phases
  // -------------------------------------------------------------------------

  private armAmbientRig(): void {
    const pulse = (): void => {
      if (!this._active || this._disposed) return;
      this.broadcastCue(CROWD_CUE_EFFECT.AMBIENT_PULSE, 160, AMBIENT_PULSE_INTERVAL_MS, 0);
      this._ambientHandle = this._timer.setTimeout(pulse, AMBIENT_PULSE_INTERVAL_MS);
    };
    pulse();
  }

  /** Broadcast a CROWD_CUE (0x2A/CUE) with THIS encore's seed (per-phone ripple). */
  private broadcastCue(effect: number, intensity: number, durationMs: number, fireAtMs: number): void {
    this._opts.broadcast(
      OPCODES.CROWD_CUE,
      crowdCueFrame({ effect, colorIndex: FLASH_COLOR_INDEX, intensity, durationMs, seed: this._seed, fireAtMs }),
      ENCORE_TIERS
    );
  }

  // -------------------------------------------------------------------------
  // Late-join snapshot (spec §7.13) — a mid-charge joiner lands coherent
  // -------------------------------------------------------------------------

  /** The coherent charge snapshot for a late joiner, or null when no encore. */
  snapshot(): EncoreSnapshot | null {
    if (!this._active) return null;
    return {
      charge: chargeToWire(this._chargeFrac),
      crowdSize: this.crowdSize(),
      fireAtMs: this._dropFireAt ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Termination + cooldown + dispose
  // -------------------------------------------------------------------------

  /** End the encore: unpin the orb, release the hold + overlay guard, cooldown. */
  terminate(): void {
    if (!this._active) return;
    this._active = false;
    if (this._orbId) {
      this._handle.unpin(this._orbId);
      this._orbId = null;
    }
    if (this._terminateHandle !== null) {
      this._timer.clearTimeout(this._terminateHandle);
      this._terminateHandle = null;
    }
    if (this._ambientHandle !== null) {
      this._timer.clearTimeout(this._ambientHandle);
      this._ambientHandle = null;
    }
    if (this._autoLaunchHandle !== null) {
      this._timer.clearTimeout(this._autoLaunchHandle);
      this._autoLaunchHandle = null;
    }
    if (this._acquiredHold) {
      this._host.timeline.releaseHold();
      this._host.endShowpieceOverlay();
      this._acquiredHold = false;
    }
    this._cooldownUntil = this._timer.now() + ENCORE_COOLDOWN_MS;
  }

  /** Full teardown (last socket left / room dispose). */
  dispose(): void {
    this._disposed = true;
    if (this._dropHandle) {
      this._dropHandle.cancel();
      this._dropHandle = null;
    }
    this.terminate();
  }
}
