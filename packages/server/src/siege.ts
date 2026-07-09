/**
 * siege.ts — Task C16 F6 Meteor Siege (spec §7.6): the 90 s crowd-vs-headset
 * showpiece. Phones slingshot meteors at a server-pinned crystal; the headset
 * defender makes LAG-COMPENSATED catches and hurls them back.
 *
 * This host is composed with the {@link RoomTimelineHost} over the SAME
 * `RoomHandle` (exactly like the C15 ElectionHost). It is server-authoritative
 * throughout — the client is NEVER trusted:
 *   • meteor speed is clamped to METEOR_SPEED_CAP on spawn (never the client's power);
 *   • a catch is validated against a ~300 ms server-side rewind ring (lag-comp);
 *   • the crystal is PINNED (§6.4 — never evicted); the eviction skips grabbed+pinned.
 *
 * PURITY: no raw setTimeout / Date.now — everything via the injected TimerApi
 * (Global Constraints / spec §5.5). The connection layer wires the real broadcast
 * + system timer at the composition root; the sim loop calls `tick()` per physics
 * tick (30 Hz) to advance meteor arcs + record the rewind ring.
 *
 * The callout queue (1/2 s; catches > throwbacks > swats > hits) lives INSIDE this
 * feature and OWNS showpiece narration (§7.15) — the caster contributes only arm +
 * end-card lines.
 */

import {
  OPCODES,
  SHOWPIECE_KIND,
  METEOR_SPEED_CAP,
  METEOR_REWIND_MS,
  METEOR_CATCH_RADIUS,
  METEOR_CATCH_ASSIST_BONUS,
  METEOR_BUDGET,
  MET_LAUNCH_INTERVAL_MS,
  SIEGE_CALLOUT_INTERVAL_MS,
  SIEGE_FULL_DURATION_MS,
  SIEGE_OVERLOAD_HOLD_MS,
  SIEGE_CRYSTAL_HP_BASE,
  SIEGE_CRYSTAL_HP_PER_PARTICIPANT,
  SIEGE_BARRAGE_INTERVAL_MS,
  // C27 F16 Siege Waves — the sibling module (spec §7.16). ALL wave data + math
  // lives there; this host only reads the table + calls the pure helpers, so a
  // "Tier 6 cut" that deletes siegeWaves.ts leaves a trivial attach hole here.
  SIEGE_WAVES,
  admitMeteor,
  waveHpAdvanceFraction,
  type TimerApi,
  type TimerHandle,
  type RoomHandle,
  type Vec3,
  type StatsRow,
} from '@cyber-shapes/shared';
import { ServerWorld } from './serverWorld.js';
import type { RoomTimelineHost } from './timeline.js';

/** How the siege ended (drives the end card + stats bridge). */
export type SiegeOutcome = 'CRYSTAL_STANDS' | 'CROWD_WINS';

/** The callout kinds, highest priority first (spec §7.6). */
export type CalloutKind = 'catch' | 'throwback' | 'swat' | 'hit';

/** Priority order — a lower index announces first when several are queued. */
const CALLOUT_PRIORITY: readonly CalloutKind[] = ['catch', 'throwback', 'swat', 'hit'];

/** A queued narration line (callsign only — never a raw name, §6.1). */
interface Callout {
  kind: CalloutKind;
  callsign: string;
  /** Monotonic enqueue order — the tie-break within a priority band (FIFO). */
  seq: number;
}

/** A slingshot MET_LAUNCH intent (post-validation). Power is NEVER trusted. */
export interface LaunchIntent {
  /** The launch origin in world metres (the phone's slingshot anchor). */
  origin: Vec3;
  /** The aim direction (need not be normalised — the host normalises it). */
  aim: Vec3;
  /** The claimed power. IGNORED for the speed cap; only nudges within [min,cap]. */
  power?: number;
  /** The per-launcher color index (§7.6 per-launcher colors). */
  colorIndex?: number;
  /** The launcher's callsign (for end-card attribution). Optional. */
  callsign?: string;
}

/** The late-join / STATE snapshot (spec §7.6 — coherent HP + crystal). */
export interface SiegeSnapshot {
  active: boolean;
  hp: number;
  maxHp: number;
  crystalId: string;
  /** Absolute server time (ms) the siege self-terminates. */
  endsAt: number;
  outcome: SiegeOutcome | null;
  /** C27 F16: the current wave index into SIEGE_WAVES (−1 before any wave). */
  waveIndex: number;
  /** C27 F16: absolute server time (ms) the current wave ends (narrative countdown). */
  waveEndsAt: number;
}

/** A per-meteor ring of past positions (lag-comp rewind buffer, ~300 ms). */
interface RewindRing {
  /** Timestamped samples, oldest → newest. Bounded to METEOR_REWIND_MS. */
  samples: Array<{ t: number; p: Vec3 }>;
}

/** Options for {@link SiegeHost}. */
export interface SiegeHostOpts {
  /** Injected timer (fake in tests, systemTimerApi in prod). */
  timer: TimerApi;
  /** The authoritative world (rewind ring + catch validation read from here). */
  world: ServerWorld;
  /** The room's RoomHandle — spawn/pin/broadcast/roster (FAQ #5). */
  handle: RoomHandle;
  /** The timeline host — for `hold()`, the showpiece-overlay guard, and phase. */
  host: RoomTimelineHost;
  /**
   * Broadcast an opcode payload (SHOWPIECE family) to the room. The connection
   * layer maps this to per-tier fan-out. `tiers` narrows the audience.
   */
  broadcast(opcode: number, payload: unknown, tiers?: readonly string[]): void;
  /** Increment the day-stats 'showpiece' counter on arm (§8 / C8). Optional. */
  metricsCount?(key: string): void;
}

/** SHOWPIECE fans out to the resident-class receive set + director (+ audience C25). */
export const SHOWPIECE_TIERS: readonly string[] = ['resident', 'spectator', 'director'];

/** The crystal sits at world centre, floating above the floor. */
const CRYSTAL_POSITION: Vec3 = { x: 0, y: 6, z: 0 };

/** The minimum meteor speed (the low end of the 6–8 m/s band, spec §7.6). */
const METEOR_SPEED_MIN = 6;

/**
 * The C16 SiegeHost: one per room, armed by the timeline (OVERLOAD auto-arm or
 * FINALE/staff-arm). Owns the pinned crystal, the meteor swarm + rewind rings,
 * the lag-compensated catch validation, the callout queue, and self-termination.
 */
export class SiegeHost {
  private readonly _timer: TimerApi;
  private readonly _world: ServerWorld;
  private readonly _handle: RoomHandle;
  private readonly _host: RoomTimelineHost;
  private readonly _opts: SiegeHostOpts;

  private _active = false;
  private _crystalId: string | null = null;
  private _hp = 0;
  private _maxHp = 0;
  private _endsAt = 0;
  private _outcome: SiegeOutcome | null = null;
  /** Whether this arm claimed the phase hold (OVERLOAD auto-arm) — released at end. */
  private _acquiredHold = false;

  /** Meteor ids (Set for O(1) membership; a shape may be evicted underneath us). */
  private readonly _meteors = new Set<string>();
  /** Per-meteor rewind ring, keyed by shape id. */
  private readonly _rings = new Map<string, RewindRing>();
  /** Per-launcher last-launch time (rate-limit, 1 per MET_LAUNCH_INTERVAL_MS). */
  private readonly _lastLaunchAt = new Map<string, number>();
  /** Bombardier launch counts by callsign (end-card top-3). */
  private readonly _bombardiers = new Map<string, number>();
  /**
   * Defender successful-catch counts by callsign (C26 — the caster end-card
   * summary, spec §7.15). Reset each `arm()` so a fresh siege starts at zero; read
   * on the showpiece falling edge to name the top defender.
   */
  private readonly _defenderCatches = new Map<string, number>();

  /** The rate-limited callout queue (drained 1 per SIEGE_CALLOUT_INTERVAL_MS). */
  private readonly _callouts: Callout[] = [];
  private _calloutSeq = 0;
  private _lastCalloutAt = -Infinity;

  private _terminateHandle: TimerHandle | null = null;
  /** Recurring callout-drain timer (1 per SIEGE_CALLOUT_INTERVAL_MS). */
  private _calloutHandle: TimerHandle | null = null;
  /** Recurring no-uplink barrage timer (fires a server meteor crowd-less). */
  private _barrageHandle: TimerHandle | null = null;

  // ---- C27 F16 Siege Waves (spec §7.16) — the escalating wave arc -----------
  /**
   * The current wave index into SIEGE_WAVES. −1 is the "no active wave" sentinel:
   * BEFORE arm, AND in the post-arc tail once the wave arc completes (§7.16). The
   * arc-complete branch collapses to −1 (never `SIEGE_WAVES.length`) so the tail
   * snapshot/late-join stays coherent — never an out-of-range index that would
   * render a phantom "WAVE 4" splash + an expired countdown.
   */
  private _waveIndex = -1;
  /** Absolute server time (ms) the current wave ends (timer-advance deadline). */
  private _waveEndsAt = 0;
  /** The per-wave deterministic admission-throttle accumulator (reset each wave). */
  private _admissionCredit = 0;
  /** The current wave's timer-advance handle (HP-advance can fire earlier → shorten). */
  private _waveHandle: TimerHandle | null = null;

  private _disposed = false;

  constructor(opts: SiegeHostOpts) {
    this._timer = opts.timer;
    this._world = opts.world;
    this._handle = opts.handle;
    this._host = opts.host;
    this._opts = opts;
  }

  // -------------------------------------------------------------------------
  // Read accessors
  // -------------------------------------------------------------------------

  get active(): boolean {
    return this._active;
  }
  get crystalId(): string | null {
    return this._crystalId;
  }
  get hp(): number {
    return this._hp;
  }
  get maxHp(): number {
    return this._maxHp;
  }
  get outcome(): SiegeOutcome | null {
    return this._outcome;
  }
  /** C27 F16: the live wave index into SIEGE_WAVES (−1 before arm). */
  get waveIndex(): number {
    return this._waveIndex;
  }
  /** True iff `id` is a live siege meteor. */
  isMeteor(id: string): boolean {
    return this._meteors.has(id);
  }

  // -------------------------------------------------------------------------
  // Arming (spec §7.6 arming semantics)
  // -------------------------------------------------------------------------

  /**
   * Arm the siege. In OVERLOAD (auto-arm) it extends the phase via `hold(60_000)`
   * so the barrage window survives; the FINALE/staff-armed path runs the full 90 s.
   * Idempotent (a second arm while active is a no-op). Counts a `showpiece` metric.
   */
  arm(opts: { staffArmed: boolean } = { staffArmed: false }): void {
    if (this._disposed || this._active) return;
    this._active = true;
    this._outcome = null;
    // C26: a fresh siege starts the defender-catch tally at zero (the caster
    // end-card summarizes THIS siege, not a cumulative career).
    this._defenderCatches.clear();

    // HP scales with the live participant count (spec §7.6). Roster = all tiers;
    // a crowd-only room still gets a floor of base HP so it terminates on the clock.
    const participants = this._handle.roster().length;
    this._maxHp = SIEGE_CRYSTAL_HP_BASE + participants * SIEGE_CRYSTAL_HP_PER_PARTICIPANT;
    this._hp = this._maxHp;

    // Spawn the crystal at world centre and PIN it (§6.4 — never evicted). It is a
    // 'dodecahedron' rendered solid so it reads as the objective.
    const res = this._handle.store.spawn({
      type: 'dodecahedron',
      position: { ...CRYSTAL_POSITION },
      colorIndex: 5,
      renderMode: 'solid',
      scale: 2,
    });
    this._crystalId = res ? res.id : null;
    if (this._crystalId) this._handle.pin(this._crystalId);

    // Claim the single-overlay-writer guard (§7.15/§7.16) — the FIRST real caller
    // of the C11 hook. While active, overlay-writing dials are refused (wrongPhase).
    this._host.beginShowpieceOverlay();

    // OVERLOAD auto-arm extends the phase via hold(60_000); FINALE/staff-arm runs
    // the full 90 s. Either way the siege self-terminates on its own clock.
    if (!opts.staffArmed && this._host.timeline.phase === 'OVERLOAD') {
      this._host.timeline.hold(SIEGE_OVERLOAD_HOLD_MS);
      this._acquiredHold = true;
    }

    this._endsAt = this._timer.now() + SIEGE_FULL_DURATION_MS;
    this._terminateHandle = this._timer.setTimeout(() => {
      this._terminateHandle = null;
      this._terminate(); // timer expiry → CRYSTAL_STANDS (survived the clock)
    }, SIEGE_FULL_DURATION_MS);

    // Arm the recurring narration + barrage loops (self-scheduled, TimerApi-pure —
    // they never depend on the sim loop calling tick()).
    this._armCalloutLoop();
    this._armBarrageLoop();

    this._opts.metricsCount?.('showpiece');

    // SHOWPIECE_START — the arm announcement (banner treatment, not the callout
    // queue). Carries the crystal + HP so a client renders the crystal cam + bar.
    this._broadcast(SHOWPIECE_KIND.START, {
      crystalId: this._crystalId,
      hp: this._hp,
      maxHp: this._maxHp,
      endsAt: this._endsAt,
    });

    // C27 F16: run the escalating wave table (spec §7.16). This runs on BOTH arm
    // paths — the OVERLOAD auto-arm (the zero-volunteer marquee) and the FINALE
    // staff-arm override. Wave 0 applies its ENV overlay + broadcasts the WAVE
    // narrative; the timer advances the arc (HP-advance can only shorten a wave).
    this._startWave(0);
  }

  // -------------------------------------------------------------------------
  // Meteor launch (server-spawned, speed-capped, per-launcher colored)
  // -------------------------------------------------------------------------

  /**
   * A launcher fires a meteor. Rate-limited to one per MET_LAUNCH_INTERVAL_MS per
   * launcher (spec §7.6). The server spawns the meteor via the store (recycle-oldest
   * cap honoured — §6.4) with a speed CLAMPED to the 6–8 m/s band (the client's
   * `power` is never trusted). Returns false if rate-limited or the spawn failed.
   */
  launch(launcherId: string, intent: LaunchIntent): boolean {
    if (!this._active || this._disposed) return false;
    const now = this._timer.now();
    const last = this._lastLaunchAt.get(launcherId);
    if (last !== undefined && now - last < MET_LAUNCH_INTERVAL_MS) return false;

    // C27 F16 (spec §7.16 — the math fix): the meteor in-flight ADMISSION budget.
    // Never admit past METEOR_BUDGET in-flight meteors; at ×4 flight time (WAVE 3
    // slow-mo) the swarm lingers, so the budget fills and admission drops
    // proportionally — the frozen cloud is dense because meteors LINGER, not
    // because more launch. This is SERVER-SIDE only: the client cooldown UI is
    // untouched and the crowd keeps firing (a silent drop → ZERO funnel diffs).
    if (!this._admitMeteor()) return false;

    const vel = this._clampedLaunchVelocity(intent.aim, intent.power);
    if (vel === null) return false;

    // Spawn a light-less meteor (renderMode 'wireframe' → the client's first-20
    // solid-light rule never lights it; spec §6.5 "meteors get zero dynamic lights").
    const res = this._handle.store.spawn({
      type: 'octahedron',
      position: { ...intent.origin },
      colorIndex: intent.colorIndex ?? 0,
      renderMode: 'wireframe',
      scale: 0.7,
    });
    if (!res) return false;

    this._registerMeteor(res.id, vel);
    this._lastLaunchAt.set(launcherId, now);
    if (intent.callsign) this.recordLaunchFor(intent.callsign);

    // A live MET_LAUNCH ticker line (banner texture; never load-bearing).
    this._broadcast(SHOWPIECE_KIND.MET_LAUNCH, { meteorId: res.id, colorIndex: intent.colorIndex ?? 0 });
    return true;
  }

  /** True iff the in-flight meteor count is under the admission budget (§7.16). */
  private _hasMeteorBudget(): boolean {
    return this._meteors.size < METEOR_BUDGET;
  }

  /**
   * The full crowd-launch admission gate (§7.16): the in-flight budget cap AND the
   * current wave's deterministic `meteorRateMult` throttle. WAVE 3 cuts the mult to
   * ~0.3 so — on top of the budget — the crowd's excess launches are silently
   * dropped server-side (the client keeps its cadence; zero funnel diffs). Advances
   * the throttle accumulator only when the budget has headroom.
   */
  private _admitMeteor(): boolean {
    if (!this._hasMeteorBudget()) return false;
    const wave = this._waveIndex >= 0 ? SIEGE_WAVES[this._waveIndex] : undefined;
    const mult = wave ? wave.meteorRateMult : 1;
    const decided = admitMeteor(this._admissionCredit, mult);
    this._admissionCredit = decided.credit;
    return decided.admit;
  }

  /** Register a freshly-spawned shape as a meteor with an initial velocity + ring. */
  private _registerMeteor(id: string, vel: Vec3): void {
    const shape = this._world.get(id);
    if (!shape) return;
    shape.velocity = { ...vel };
    // Arc, not free-fall: meteors are given an initial velocity and step under
    // the world's physics. Give a mild upward bias for a visible arc.
    this._meteors.add(id);
    this._rings.set(id, { samples: [{ t: this._timer.now(), p: { ...shape.position } }] });
  }

  /**
   * Compute the clamped launch velocity from an aim direction + a claimed power.
   * The SPEED is always inside [METEOR_SPEED_MIN, METEOR_SPEED_CAP] — the client's
   * `power` only interpolates within that band (never trusted to exceed it).
   * Returns null on a degenerate (zero-length / non-finite) aim.
   */
  private _clampedLaunchVelocity(aim: Vec3, power?: number): Vec3 | null {
    const len = Math.hypot(aim.x, aim.y, aim.z);
    if (!isFinite(len) || len < 1e-6) return null;
    // Normalise the aim, add a mild upward bias so the trajectory arcs.
    const nx = aim.x / len;
    const ny = aim.y / len + 0.25;
    const nz = aim.z / len;
    const blen = Math.hypot(nx, ny, nz);
    if (blen < 1e-6) return null;
    // Map power → [MIN, CAP]; a hostile huge/NaN power saturates to CAP.
    let p = typeof power === 'number' && isFinite(power) ? power : 1;
    if (p < 0) p = 0;
    const t = Math.min(1, p); // power ∈ [0,1] scales within the band; >1 saturates
    const speed = METEOR_SPEED_MIN + (METEOR_SPEED_CAP - METEOR_SPEED_MIN) * t;
    return { x: (nx / blen) * speed, y: (ny / blen) * speed, z: (nz / blen) * speed };
  }

  // -------------------------------------------------------------------------
  // Per-tick update (called from the sim loop, 30 Hz). Records rewind rings +
  // clamps meteor speed each tick + runs the no-uplink barrage + the callout drain.
  // -------------------------------------------------------------------------

  /**
   * Advance the siege by `dt` seconds — called from the sim loop AFTER the world
   * physics step (30 Hz). Records each live meteor's post-step position into its
   * rewind ring (bounded to METEOR_REWIND_MS — the lag-comp buffer) and re-clamps
   * any meteor whose speed drifted above the cap (a bounce could accelerate it).
   * Also checks meteors that reached the crystal and damages it. `dt` is accepted
   * for sim-loop call symmetry but unused (positions are read post-step from the
   * world, not integrated here).
   */
  tick(dt = 0): void {
    void dt;
    if (!this._active || this._disposed) return;
    const now = this._timer.now();

    for (const id of [...this._meteors]) {
      const shape = this._world.get(id);
      if (!shape) {
        // The store evicted this meteor (recycle-oldest) — drop its bookkeeping.
        this._meteors.delete(id);
        this._rings.delete(id);
        continue;
      }
      // Re-clamp speed each tick (physics / a bounce could exceed the cap).
      this._clampShapeSpeed(shape.velocity);
      // Record the rewind sample (the post-step authoritative position).
      const ring = this._rings.get(id);
      if (ring) {
        ring.samples.push({ t: now, p: { x: shape.position.x, y: shape.position.y, z: shape.position.z } });
        const cutoff = now - METEOR_REWIND_MS;
        while (ring.samples.length > 2 && ring.samples[0].t < cutoff) ring.samples.shift();
      }
      // A free-flying meteor that reached the crystal damages it, then despawns.
      if (shape.grabbedBy === null && this._crystalId && this._reachedCrystal(shape.position)) {
        this._meteors.delete(id);
        this._rings.delete(id);
        this._handle.store.remove(id);
        this.damage(1);
      }
    }
  }

  /** True iff a position is within the crystal's hit radius. */
  private _reachedCrystal(p: Vec3): boolean {
    return this._within(p, CRYSTAL_POSITION, 2.0);
  }

  /** Arm the recurring callout drain (1 per SIEGE_CALLOUT_INTERVAL_MS). */
  private _armCalloutLoop(): void {
    const tick = (): void => {
      if (this._disposed || !this._active) return;
      this._drainCallout(this._timer.now());
      this._calloutHandle = this._timer.setTimeout(tick, SIEGE_CALLOUT_INTERVAL_MS);
    };
    this._calloutHandle = this._timer.setTimeout(tick, SIEGE_CALLOUT_INTERVAL_MS);
  }

  /**
   * Arm the recurring no-uplink barrage (§7.6 — survives crowd-less). It only
   * self-fires when the crowd is QUIET (no client launch within the last barrage
   * window) — an active crowd carries the barrage itself, so the server steps back.
   */
  private _armBarrageLoop(): void {
    const tick = (): void => {
      if (this._disposed || !this._active) return;
      const now = this._timer.now();
      if (!this._crowdActive(now)) this._fireBarrageMeteor(now);
      this._barrageHandle = this._timer.setTimeout(tick, SIEGE_BARRAGE_INTERVAL_MS);
    };
    this._barrageHandle = this._timer.setTimeout(tick, SIEGE_BARRAGE_INTERVAL_MS);
  }

  /**
   * True iff any launcher fired within the last launch interval (crowd carries the
   * barrage itself). A launcher's cadence is 1 per MET_LAUNCH_INTERVAL_MS, so a
   * launch keeps the crowd "active" for that whole window — the server barrage only
   * kicks in once the crowd truly falls silent (the no-uplink rung).
   */
  private _crowdActive(now: number): boolean {
    for (const at of this._lastLaunchAt.values()) {
      if (now - at < MET_LAUNCH_INTERVAL_MS) return true;
    }
    return false;
  }

  /** Clamp a velocity vector's magnitude to METEOR_SPEED_CAP in place. */
  private _clampShapeSpeed(v: Vec3): void {
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed > METEOR_SPEED_CAP && speed > 1e-9) {
      const k = METEOR_SPEED_CAP / speed;
      v.x *= k;
      v.y *= k;
      v.z *= k;
    }
  }

  /** Self-fire one server meteor from a deterministic ring position (barrage rung). */
  private _fireBarrageMeteor(now: number): void {
    // C27 §7.16: the barrage honours the SAME in-flight admission budget (never past
    // METEOR_BUDGET). It is NOT wave-throttled — the barrage is the crowd-less
    // fallback that keeps the spectacle alive, bounded only by the hard cap.
    if (!this._hasMeteorBudget()) return;
    // Deterministic angle from the barrage clock — no Math.random.
    const angle = (now / SIEGE_BARRAGE_INTERVAL_MS) * 1.3;
    const r = 9;
    const origin: Vec3 = { x: Math.cos(angle) * r, y: 2 + (Math.floor(now / 1000) % 3), z: Math.sin(angle) * r };
    // Aim at the crystal.
    const aim: Vec3 = { x: -origin.x, y: CRYSTAL_POSITION.y - origin.y, z: -origin.z };
    const vel = this._clampedLaunchVelocity(aim, 1);
    if (!vel) return;
    const res = this._handle.store.spawn({
      type: 'octahedron',
      position: origin,
      colorIndex: 6,
      renderMode: 'wireframe',
      scale: 0.7,
    });
    if (!res) return;
    this._registerMeteor(res.id, vel);
    this._broadcast(SHOWPIECE_KIND.MET_LAUNCH, { meteorId: res.id, colorIndex: 6, barrage: true });
  }

  // -------------------------------------------------------------------------
  // Lag-compensated catch (the marquee moment — spec §7.6).
  // -------------------------------------------------------------------------

  /**
   * The meteor's server position `atMs` ago, reconstructed from the rewind ring
   * (linear interpolation between the bracketing samples). Returns null if the
   * meteor is unknown or the ring has no samples. Clamps to the ring's bounds.
   */
  rewoundPositionAt(meteorId: string, atMs: number): Vec3 | null {
    const ring = this._rings.get(meteorId);
    if (!ring || ring.samples.length === 0) return null;
    const s = ring.samples;
    if (atMs <= s[0].t) return { ...s[0].p };
    if (atMs >= s[s.length - 1].t) return { ...s[s.length - 1].p };
    for (let i = 1; i < s.length; i++) {
      if (s[i].t >= atMs) {
        const a = s[i - 1];
        const b = s[i];
        const span = b.t - a.t;
        const f = span > 1e-9 ? (atMs - a.t) / span : 0;
        return {
          x: a.p.x + (b.p.x - a.p.x) * f,
          y: a.p.y + (b.p.y - a.p.y) * f,
          z: a.p.z + (b.p.z - a.p.z) * f,
        };
      }
    }
    return { ...s[s.length - 1].p };
  }

  /**
   * The NAIVE (no-rewind) catch check: the grab point vs the meteor's CURRENT
   * position. This is the check that BREAKS at 50–150 ms RTT — kept so the test can
   * prove the rewind version accepts a catch the naive version rejects.
   */
  validateCatchNaive(meteorId: string, grabPoint: Vec3): boolean {
    const shape = this._world.get(meteorId);
    if (!shape) return false;
    return this._within(grabPoint, shape.position, METEOR_CATCH_RADIUS);
  }

  /**
   * The REWIND catch check (server-authoritative lag-comp): validate the grab point
   * against the meteor's position `clientTimestamp` ago (what the DEFENDER SAW),
   * within a catch radius enlarged by catch-assist (§7.6 defender skill floor).
   */
  validateCatch(meteorId: string, grabPoint: Vec3, clientTimestamp: number): boolean {
    if (!this._meteors.has(meteorId)) return false;
    const rewound = this.rewoundPositionAt(meteorId, clientTimestamp);
    if (!rewound) return false;
    const radius = METEOR_CATCH_RADIUS + METEOR_CATCH_ASSIST_BONUS; // catch-assist
    return this._within(grabPoint, rewound, radius);
  }

  /**
   * Attempt a lag-compensated catch. On success attaches the meteor to the defender
   * (grabbedBy set — the store then never evicts it), enqueues a `catch` callout,
   * and returns true. On a failed rewind validation returns false (the client rolls
   * back its predicted attach). The `callsign` (if given) attributes the callout.
   */
  catch(
    defenderId: string,
    meteorId: string,
    grabPoint: Vec3,
    clientTimestamp: number,
    callsign?: string
  ): boolean {
    if (!this._active) return false;
    if (!this.validateCatch(meteorId, grabPoint, clientTimestamp)) return false;
    const ok = this._world.grab(meteorId, defenderId);
    if (!ok) return false;
    const who = callsign ?? defenderId;
    this.enqueueCallout('catch', who);
    // C26: credit the defender's catch for the caster end-card summary (§7.15).
    this._defenderCatches.set(who, (this._defenderCatches.get(who) ?? 0) + 1);
    return true;
  }

  /**
   * A client-claimed swat (MET_HIT): a hand sweep deflects a meteor. Plausibility-
   * checked against the SAME rewind buffer (the hand was near the meteor at the
   * claimed timestamp). On success nudges the meteor away, damages the crystal path
   * (a swat that misses the crystal saves HP → we credit a small deflect), and
   * enqueues a `swat` callout. Returns false when the plausibility check fails.
   */
  swat(meteorId: string, handPoint: Vec3, clientTimestamp: number, callsign?: string): boolean {
    if (!this._active) return false;
    // Plausibility: the hand must have been near the meteor at the claimed time.
    const rewound = this.rewoundPositionAt(meteorId, clientTimestamp);
    if (!rewound) return false;
    if (!this._within(handPoint, rewound, METEOR_CATCH_RADIUS + METEOR_CATCH_ASSIST_BONUS)) {
      return false;
    }
    const shape = this._world.get(meteorId);
    if (!shape || shape.grabbedBy !== null) return false;
    // Reflect the meteor's velocity away from the crystal (a deflection).
    shape.velocity = { x: -shape.velocity.x, y: shape.velocity.y, z: -shape.velocity.z };
    this._clampShapeSpeed(shape.velocity);
    this.enqueueCallout('swat', callsign ?? 'DEFENDER');
    return true;
  }

  private _within(a: Vec3, b: Vec3, radius: number): boolean {
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    return isFinite(d) && d <= radius;
  }

  // -------------------------------------------------------------------------
  // Damage + termination
  // -------------------------------------------------------------------------

  /**
   * Apply `amount` damage to the crystal (a meteor that reached it, or a scripted
   * hit). Depleting HP ends the siege with CROWD_WINS. Enqueues a `hit` callout on
   * a real hit (amount > 0). Idempotent once terminated.
   */
  damage(amount: number): void {
    if (!this._active || amount <= 0) return;
    this._hp = Math.max(0, this._hp - amount);
    this.enqueueCallout('hit', 'CROWD');
    if (this._hp <= 0) {
      this._terminate('CROWD_WINS');
      return;
    }
    // C27 F16: a wave can also advance on an HP threshold. The threshold is the
    // TIMER's max, so an HP cross only ever fires EARLIER → it SHORTENS a wave
    // (never extends it). The last wave never HP-advances — depleting it terminates.
    this._maybeHpAdvance();
  }

  // -------------------------------------------------------------------------
  // C27 F16 Siege Waves (spec §7.16) — the escalating wave arc. All wave DATA +
  // math lives in the shared `siegeWaves.ts` sibling; this host only drives the
  // arc (timer/HP advance + the ENV/SHOWPIECE wire).
  // -------------------------------------------------------------------------

  /**
   * Begin wave `i` (spec §7.16). Applies the wave's ENV overlay through the C11
   * two-layer `setCueOverlay` (physics rides ENV_STATE — an elected law survives
   * because the overlay merges OVER `baseParams` and pops back to it; the ENV mode =
   * the wave name → the cue banner for free + late-join coherence), broadcasts the
   * SHOWPIECE WAVE narrative ({waveIndex, waveEndsAt} — indices only, no name on the
   * wire), and schedules the TIMER-advance. The HP-advance path can only fire
   * earlier, so a wave is only ever SHORTENED.
   */
  private _startWave(i: number): void {
    if (this._disposed || !this._active) return;
    if (i < 0 || i >= SIEGE_WAVES.length) return;
    const wave = SIEGE_WAVES[i];
    const now = this._timer.now();
    this._waveIndex = i;
    this._admissionCredit = 0; // a fresh throttle accumulator per wave
    this._waveEndsAt = now + wave.durationMs;

    // Physics rides ENV_STATE via the C11 two-layer overlay (NOT a new wire form).
    // The overlay merges over baseParams (an elected law survives) and its own
    // auto-revert pops it back to base — the "between-wave pop" (§7.16). The mode
    // label is the wave name → the big-screen cue-banner treatment.
    this._handle.setCueOverlay(wave.dialOverlay ?? {}, wave.durationMs, { mode: wave.name });

    // Narrative rides SHOWPIECE_STATE (indices/fixed-point ONLY — no names on the
    // wire; the client resolves the splash name from the shared SIEGE_WAVES table).
    this._broadcast(SHOWPIECE_KIND.WAVE, { waveIndex: i, waveEndsAt: this._waveEndsAt });

    // Schedule the timer-advance. HP-advance may pre-empt this (shorten only).
    if (this._waveHandle !== null) this._timer.clearTimeout(this._waveHandle);
    this._waveHandle = this._timer.setTimeout(() => {
      this._waveHandle = null;
      this._advanceWave(i + 1);
    }, wave.durationMs);
  }

  /**
   * Advance to wave `next` (idempotent — a timer/HP double-fire is a no-op). Past
   * the last wave the arc is done: the last overlay's own auto-revert pops physics
   * back to `baseParams` and the siege runs out its remaining clock/HP under the
   * base (elected) law — no new overlay.
   */
  private _advanceWave(next: number): void {
    if (this._disposed || !this._active) return;
    if (next <= this._waveIndex) return; // already advanced (idempotent)
    if (this._waveHandle !== null) {
      this._timer.clearTimeout(this._waveHandle);
      this._waveHandle = null;
    }
    if (next >= SIEGE_WAVES.length) {
      // Past the final wave — the arc is complete. The last wave's setCueOverlay
      // auto-revert (scheduled at its durationMs) pops the overlay back to base.
      // C27 §7.16 (post-arc coherence fix): collapse to the −1 "no active wave"
      // sentinel (NOT `SIEGE_WAVES.length`) and drop the now-past waveEndsAt, so a
      // late-join in the ~8 s tail (waves sum to 82 s, the siege runs 90 s) emits a
      // COHERENT wave field — never an out-of-range index or a stale past countdown
      // that renders a phantom full-screen "WAVE 4" splash. The siege runs out its
      // remaining clock/HP under the base (elected) law with no active wave.
      this._waveIndex = -1;
      this._waveEndsAt = 0;
      return;
    }
    this._startWave(next);
  }

  /**
   * Advance the wave EARLY when the crowd's cumulative damage crosses the current
   * wave's HP-advance fraction (spec §7.16 — HP thresholds shorten a wave). No-op on
   * the last wave (depleting it terminates via CROWD_WINS, not an advance) and when
   * maxHp is degenerate. Because the fraction crossing can only happen at-or-before
   * the timer, this NEVER extends a wave.
   */
  private _maybeHpAdvance(): void {
    if (!this._active) return;
    if (this._waveIndex < 0 || this._waveIndex >= SIEGE_WAVES.length - 1) return;
    if (this._maxHp <= 0) return;
    const damageFrac = (this._maxHp - this._hp) / this._maxHp;
    if (damageFrac >= waveHpAdvanceFraction(this._waveIndex)) {
      this._advanceWave(this._waveIndex + 1);
    }
  }

  /**
   * End the siege. `forced` (null → survived-the-clock CRYSTAL_STANDS) drives the
   * outcome. Un-pins + despawns the crystal, clears meteors, releases the phase
   * hold + the showpiece-overlay guard, and broadcasts the END card with the top-3
   * bombardier callsigns (→ STATS_CARD + queue bridge).
   */
  private _terminate(forced?: SiegeOutcome): void {
    if (!this._active) return;
    this._active = false;
    this._outcome = forced ?? 'CRYSTAL_STANDS';

    if (this._terminateHandle !== null) {
      this._timer.clearTimeout(this._terminateHandle);
      this._terminateHandle = null;
    }
    if (this._calloutHandle !== null) {
      this._timer.clearTimeout(this._calloutHandle);
      this._calloutHandle = null;
    }
    if (this._barrageHandle !== null) {
      this._timer.clearTimeout(this._barrageHandle);
      this._barrageHandle = null;
    }
    // C27: cancel the wave-advance timer.
    if (this._waveHandle !== null) {
      this._timer.clearTimeout(this._waveHandle);
      this._waveHandle = null;
    }
    this._waveIndex = -1;
    this._waveEndsAt = 0;
    // C27 §7.16 (early-terminate overlay-leak fix): pop the wave ENV overlay back
    // to the elected base IMMEDIATELY. A CROWD_WINS / forceEnd mid-wave used to
    // leave the wave's own setCueOverlay auto-revert running for the rest of its
    // `durationMs` — up to ~11 s of room-wide WAVE 3 ×0.25 slow-mo (or WAVE 2 wind)
    // applied AFTER the END card. An empty overlay merges to base
    // (mergeParams(base, {}) === base), so physics reverts to the elected law the
    // instant the siege ends; the mode-less broadcast also clears the wave banner
    // and its now+0 revert supersedes the stale long auto-revert.
    this._handle.setCueOverlay({}, 0);

    // Un-pin + despawn the crystal (a rotation boundary would also clear it).
    if (this._crystalId) {
      this._handle.unpin(this._crystalId);
      this._handle.store.remove(this._crystalId);
    }
    // Clear meteors (leave the shapes to the store's normal eviction; just drop
    // our siege bookkeeping so they are no longer treated as meteors).
    this._meteors.clear();
    this._rings.clear();

    // Release the phase hold + the showpiece-overlay guard.
    if (this._acquiredHold) {
      // A `hold()` extends the phase deadline; there is no un-hold, but releasing
      // the overlay guard is the load-bearing bit (dials fire again).
      this._acquiredHold = false;
    }
    this._host.endShowpieceOverlay();

    const top3 = this.topBombardiers(3);
    this._broadcast(SHOWPIECE_KIND.END, {
      outcome: this._outcome,
      hp: this._hp,
      maxHp: this._maxHp,
      topBombardiers: top3,
    });
  }

  /** Force-end the siege now (staff override / RESET boundary). */
  forceEnd(): void {
    this._terminate(this._outcome ?? 'CRYSTAL_STANDS');
  }

  // -------------------------------------------------------------------------
  // Callout queue (1/2 s; catches > throwbacks > swats > hits). OWNS narration.
  // -------------------------------------------------------------------------

  /** Enqueue a narration callout (drained ≤ 1 per SIEGE_CALLOUT_INTERVAL_MS). */
  enqueueCallout(kind: CalloutKind, callsign: string): void {
    if (!this._active) return;
    this._callouts.push({ kind, callsign, seq: this._calloutSeq++ });
  }

  /** Drain at most one callout (highest priority, FIFO within a band) per window. */
  private _drainCallout(now: number): void {
    if (this._callouts.length === 0) return;
    if (now - this._lastCalloutAt < SIEGE_CALLOUT_INTERVAL_MS) return;
    // Pick the highest-priority callout; break ties by FIFO enqueue order.
    let bestIdx = 0;
    for (let i = 1; i < this._callouts.length; i++) {
      const a = this._callouts[i];
      const b = this._callouts[bestIdx];
      const pa = CALLOUT_PRIORITY.indexOf(a.kind);
      const pb = CALLOUT_PRIORITY.indexOf(b.kind);
      if (pa < pb || (pa === pb && a.seq < b.seq)) bestIdx = i;
    }
    const [pick] = this._callouts.splice(bestIdx, 1);
    this._lastCalloutAt = now;
    // The callout rides a SHOWPIECE_STATE broadcast (the callout queue OWNS
    // showpiece narration — §7.15). Carries the live HP for the oversized bar.
    this._broadcast(SHOWPIECE_KIND.STATE, {
      hp: this._hp,
      maxHp: this._maxHp,
      callout: { kind: pick.kind, callsign: pick.callsign },
    });
  }

  // -------------------------------------------------------------------------
  // End card / stats bridge
  // -------------------------------------------------------------------------

  /** Attribute one launch to a callsign (end-card bombardier count). */
  recordLaunchFor(callsign: string): void {
    this._bombardiers.set(callsign, (this._bombardiers.get(callsign) ?? 0) + 1);
  }

  /** The top-N bombardier callsigns by launch count (STATS_CARD bridge, §7.6). */
  topBombardiers(n: number): StatsRow[] {
    return [...this._bombardiers.entries()]
      .map(([callsign, value]) => ({ callsign, value }))
      .sort((a, b) => b.value - a.value || a.callsign.localeCompare(b.callsign))
      .slice(0, n);
  }

  /**
   * The top defender by successful catches this siege (C26 caster end-card, §7.15),
   * or null if nobody caught anything. Ties break by callsign for determinism.
   * Read on the showpiece falling edge to feed the caster's `endCard` summary.
   */
  topDefender(): { callsign: string; catches: number } | null {
    let best: { callsign: string; catches: number } | null = null;
    for (const [callsign, catches] of this._defenderCatches) {
      if (
        !best ||
        catches > best.catches ||
        (catches === best.catches && callsign.localeCompare(best.callsign) < 0)
      ) {
        best = { callsign, catches };
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Late-join snapshot
  // -------------------------------------------------------------------------

  /** The coherent SHOWPIECE snapshot for a late joiner, or null if no siege. */
  snapshot(): SiegeSnapshot | null {
    if (!this._active || this._crystalId === null) return null;
    // C27 §7.16 (post-arc coherence): a late joiner in the ~8 s post-arc tail (or
    // any moment with no live wave) must NOT receive an out-of-range index or a
    // stale past countdown — that renders a phantom "WAVE 4" splash + an expired
    // timer. Collapse anything that is not a live, still-running wave to the −1
    // "no active wave" sentinel so `snapshot()`/late-join stays coherent; the
    // wire (connection.ts) + client (stage.ts) both treat −1/out-of-range as "no
    // splash — plain siege" (the unknown-kind-ignore contract).
    const liveWave =
      this._waveIndex >= 0 &&
      this._waveIndex < SIEGE_WAVES.length &&
      this._waveEndsAt > this._timer.now();
    return {
      active: true,
      hp: this._hp,
      maxHp: this._maxHp,
      crystalId: this._crystalId,
      endsAt: this._endsAt,
      outcome: this._outcome,
      // A late joiner lands on the LIVE wave (index + end) so the wave splash +
      // countdown render coherently mid-arc; a non-live wave collapses to −1 / 0.
      waveIndex: liveWave ? this._waveIndex : -1,
      waveEndsAt: liveWave ? this._waveEndsAt : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Broadcast helper + teardown
  // -------------------------------------------------------------------------

  private _broadcast(kind: number, payload: Record<string, unknown>): void {
    if (this._disposed) return;
    this._opts.broadcast(OPCODES.SHOWPIECE, { kind, ...payload }, SHOWPIECE_TIERS);
  }

  dispose(): void {
    this._disposed = true;
    for (const hndl of [
      this._terminateHandle,
      this._calloutHandle,
      this._barrageHandle,
      this._waveHandle,
    ]) {
      if (hndl !== null) this._timer.clearTimeout(hndl);
    }
    this._terminateHandle = null;
    this._calloutHandle = null;
    this._barrageHandle = null;
    this._waveHandle = null;
    if (this._active) {
      this._active = false;
      this._host.endShowpieceOverlay();
    }
    this._meteors.clear();
    this._rings.clear();
  }
}
