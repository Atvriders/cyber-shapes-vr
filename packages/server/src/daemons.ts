/**
 * daemons.ts — F17 Daemon Crew host (spec §7.17, C28).
 *
 * The SERVER side of the Daemon Crew: it summons/dismisses server-hosted synthetic
 * resident peers (callsigns from the reserved `DMN-` namespace) and drives their
 * pure fetch-and-return behavior (the chassis in `@cyber-shapes/shared` daemons.ts)
 * each sim tick. The load-bearing design guarantees, all test-enforced:
 *
 *   • NO GOD-MODE. A daemon joins through the STANDARD path (`port.join` →
 *     manager.joinTier(room,'resident',…)) and every intent it emits flows through
 *     `port.applyIntent` → room.applyIntent — the EXACT validated path a human's
 *     grab/held/release travels. There is no privileged world write anywhere here;
 *     the port exposes only join / applyIntent / leave + read accessors + banner.
 *
 *   • SYNTHETIC-BLIND presence. Daemons have NO socket, so every socket-based
 *     presence signal (ATTRACT-exit, C13 idle, the auto-banker room-empty check,
 *     C8 metrics real-peer counts, VOICE_ROSTER, the queue bridge, occupancy) is
 *     automatically daemon-blind. This host only ADDS the daemon-specific pieces:
 *     the metric goes to the synthetic bucket, the banner is the "DMN-07 ONLINE"
 *     glitch line (never the human JOIN_CRANE), and dismissal triggers keep a
 *     daemon out of any human's way.
 *
 *   • HUMAN-FIRST GRAB DEFERENCE. A daemon never claims a shape within the defer
 *     radius of a human hand / pending human claim (the chassis) AND the host
 *     RE-CHECKS deference against the LIVE world immediately before forwarding a
 *     grab — so a contested same-window grab always resolves to the human.
 *
 *   • DISMISSAL COMPLETENESS + EVICT-FIRST. Auto-dismiss on RESET, when humans ≥ 2,
 *     and when the last human departs; each dismissal is a STANDARD disconnect
 *     (`port.leave` → releases the daemon's held shape). At the 8-resident cap a
 *     daemon is EVICTED FIRST so a real resident is never refused.
 *
 *   • SHIP GATE. Summoning is staff/cue-only at ship; the LOBBY auto-summon sits
 *     behind {@link DaemonCrewOpts.autoSummonLobby}, DEFAULT OFF (§7.17 owner gate).
 *
 * PURE-ish: the host holds only daemon minds + a counter; all time comes from the
 * injected TimerApi and all world/room effects through the injected port.
 */

import {
  makeDaemonMind,
  stepDaemon,
  shouldDeferGrab,
  daemonCallsign,
  isDaemonCallsign,
  type DaemonMind,
  type DaemonShapeView,
  type DaemonHumanTarget,
  type ClientMsg,
  type TimerApi,
} from '@cyber-shapes/shared';

/** Default crew size a `summon-daemons` cue brings online (a small game-of-catch). */
export const DEFAULT_DAEMON_CREW = 2;

/**
 * The queue-bridge prompt (spec §7.17 / §6.1) — a FIXED string, NEVER a name. This
 * is what makes a "DMN-03 NEXT IN THE HEADSET?" line IMPOSSIBLE: the queue bridge
 * renders this prompt, never a roster callsign. Exported so the stats card renders
 * it from ONE place and a test can pin that it interpolates no identity.
 */
export const QUEUE_BRIDGE_PROMPT = 'NEXT IN THE HEADSET? Scan the QR to jump the line.';

/**
 * Filter synthetic (`DMN-`) peers out of any leaderboard / queue-bridge row list
 * (spec §7.17 — daemons are excluded from the leaderboard/queue bridge). A daemon
 * that threw a fast shape never appears as a "top contributor" or a day-leaderboard
 * row; it is invisible to the human competition surface.
 */
export function excludeDaemons<T extends { callsign: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isDaemonCallsign(r.callsign));
}

/** A summoned daemon peer the avatar broadcast + banner describe. */
export interface DaemonPeerInit {
  id: string;
  callsign: string;
  color: number;
}

/**
 * The injected surface the host touches — implemented by the connection layer over
 * the STANDARD room paths (and by a thin real-Room adapter in tests). Deliberately
 * has NO privileged mutation and NO join-crane hook: a daemon CANNOT bypass grab
 * arbitration/budgets/physics, and CANNOT trigger the human join ceremony.
 */
export interface DaemonPort {
  /**
   * STANDARD resident join (manager.joinTier(room,'resident',callsign,color)).
   * Returns the assigned peer id, or null if the room is at the 8-resident cap
   * (a `room-full` — daemons are counted inside the cap). NO god-mode.
   */
  join(callsign: string, color: number): string | null;
  /** STANDARD validated intent path (room.applyIntent + broadcast). NO privilege. */
  applyIntent(playerId: string, msg: ClientMsg): void;
  /**
   * STANDARD disconnect (manager.leave) — releases the daemon's held shape via the
   * same force-release path a departing human uses, and broadcasts player-leave.
   */
  leave(playerId: string): void;
  /** Broadcast the daemon avatar presence (player-join, `synthetic:true`) — NOT a crane. */
  announceAvatar(peer: DaemonPeerInit): void;
  /** Emit the distinct "DMN-07 ONLINE" glitch banner (NEVER the human JOIN_CRANE). */
  banner(callsign: string): void;
  /** Count this join in the metrics store's SYNTHETIC bucket (never the club export). */
  countSyntheticJoin(callsign: string): void;
  /** Read the live world shapes the daemons may fetch. */
  shapes(): DaemonShapeView[];
  /** Read the live human-resident targets (head + hands) for aim + deference. */
  humanTargets(): DaemonHumanTarget[];
}

export interface DaemonCrewOpts {
  port: DaemonPort;
  timer: TimerApi;
  /** Deterministic RNG in [0,1). Defaults to a per-host seeded stream (no Math.random). */
  rng?: () => number;
  /**
   * Ship gate (spec §7.17): the LOBBY auto-summon flag. DEFAULT **false** — at ship
   * daemons are staff/cue-summoned ONLY. Enabled only after the owner acceptance
   * pass of the recorded fetch-and-return script on the real stage. When false,
   * {@link onHumanCountChanged} NEVER summons on a lone-visitor transition.
   */
  autoSummonLobby?: boolean;
  /** Avatar color index assigned to daemons (cosmetic). Default 0. */
  color?: number;
}

export class DaemonCrewHost {
  private readonly _port: DaemonPort;
  private readonly _timer: TimerApi;
  private readonly _rng: () => number;
  private readonly _color: number;
  /** The ship gate — LOBBY auto-summon (default OFF). */
  readonly autoSummonLobby: boolean;

  /** Live daemon minds, keyed by peer id, in summon order (oldest first). */
  private readonly _daemons = new Map<string, DaemonMind>();
  /** Monotonic index for DMN- callsign assignment (never reused, avoids churn). */
  private _nextIndex = 1;
  private _disposed = false;

  constructor(opts: DaemonCrewOpts) {
    this._port = opts.port;
    this._timer = opts.timer;
    this._color = opts.color ?? 0;
    this.autoSummonLobby = opts.autoSummonLobby ?? false; // ship gate: DEFAULT OFF
    // A dependency-free deterministic default stream (mulberry32-ish from now()).
    let s = (Math.floor(this._timer.now()) >>> 0) || 0x9e3779b9;
    this._rng =
      opts.rng ??
      (() => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      });
  }

  /** The number of live daemons in the room. */
  get count(): number {
    return this._daemons.size;
  }

  /** The live daemon peer ids (summon order). */
  ids(): string[] {
    return [...this._daemons.keys()];
  }

  // -------------------------------------------------------------------------
  // Summon / dismiss.
  // -------------------------------------------------------------------------

  /**
   * Summon up to `count` daemons through the STANDARD join path. Each successful
   * join gets a `DMN-` callsign, a synthetic avatar broadcast, the "DMN-07 ONLINE"
   * banner, and a synthetic metric — then its fetch-and-return mind is registered.
   * A join refused at the 8-resident cap (`port.join` → null) simply stops the run
   * (daemons never displace a human). Returns the ids actually summoned.
   */
  summon(count = DEFAULT_DAEMON_CREW): string[] {
    if (this._disposed) return [];
    const summoned: string[] = [];
    for (let i = 0; i < count; i++) {
      const callsign = daemonCallsign(this._nextIndex);
      const id = this._port.join(callsign, this._color);
      if (id === null) break; // at cap — never displace a human to seat a daemon
      this._nextIndex++;
      this._daemons.set(id, makeDaemonMind(id));
      this._port.announceAvatar({ id, callsign, color: this._color });
      this._port.banner(callsign); // the DMN-07 glitch banner — NOT the join-crane
      this._port.countSyntheticJoin(callsign); // synthetic metric bucket only
      summoned.push(id);
    }
    return summoned;
  }

  /** Dismiss ALL daemons (RESET / humans≥2 / last-human-departs). Releases held shapes. */
  dismiss(): void {
    for (const id of [...this._daemons.keys()]) this._dismissOne(id);
  }

  /**
   * Evict the OLDEST daemon so a real resident can seat at the 8-cap (spec §7.17:
   * "evicted FIRST when a real resident joins at cap — never block a human").
   * Returns true if a daemon was evicted (the caller should retry the human join).
   */
  evictOneForHuman(): boolean {
    const oldest = this._daemons.keys().next();
    if (oldest.done) return false;
    this._dismissOne(oldest.value);
    return true;
  }

  private _dismissOne(id: string): void {
    if (!this._daemons.has(id)) return;
    this._daemons.delete(id);
    // STANDARD disconnect: manager.leave force-releases the daemon's held shape and
    // broadcasts player-leave (the avatar vanishes) — identical to a human leaving.
    this._port.leave(id);
  }

  // -------------------------------------------------------------------------
  // Dismissal / summon triggers (wired from the connection presence hooks).
  // -------------------------------------------------------------------------

  /**
   * React to a change in the HUMAN resident count (spec §7.17 dismissal triggers):
   *   • ≥ 2 humans → dismiss ALL (a crowd arrived; daemons step aside).
   *   • 0 humans   → dismiss ALL (the last human departed — no one to play with).
   *   • exactly 1  → the lone-visitor case: auto-summon a crew ONLY when the ship
   *                  gate {@link autoSummonLobby} is ON (default OFF → no-op; staff
   *                  summon the crew via the cue instead).
   */
  onHumanCountChanged(humanCount: number): void {
    if (this._disposed) return;
    if (humanCount >= 2 || humanCount <= 0) {
      this.dismiss();
      return;
    }
    // Exactly one human — the fetch-and-return use case.
    if (humanCount === 1 && this.autoSummonLobby && this._daemons.size === 0) {
      this.summon();
    }
  }

  /** RESET dismissal trigger (spec §7.17): a rotation boundary clears the crew. */
  onReset(): void {
    this.dismiss();
  }

  // -------------------------------------------------------------------------
  // Per-tick behavior — the fetch-and-return drive.
  // -------------------------------------------------------------------------

  /**
   * Advance every daemon by one step and forward its synthesized pose + game
   * intents through the STANDARD validated path. Grab deference is enforced TWICE:
   * once inside the pure step (it never targets a human-contested shape) and again
   * here against the LIVE world immediately before a grab is forwarded — so a
   * contested same-window grab is dropped and resolves to the human.
   */
  tick(dt: number): void {
    if (this._disposed || this._daemons.size === 0) return;
    const shapes = this._port.shapes();
    const humans = this._port.humanTargets();
    const shapeById = new Map(shapes.map((s) => [s.id, s]));

    for (const mind of this._daemons.values()) {
      const { pose, intents } = stepDaemon(mind, { shapes, humans, dt, rng: this._rng });
      // Relay the daemon's pose so its drone avatar animates (a standard pose intent).
      this._port.applyIntent(mind.id, { t: 'pose', pose });
      for (const intent of intents) {
        // Belt-and-suspenders human-first deference on the LIVE world: never forward
        // a grab for a shape a human is now holding/reaching for (the human wins).
        if (intent.t === 'grab') {
          const shape = shapeById.get(intent.id);
          if (shape && shouldDeferGrab(shape, humans, mind.id)) {
            // Yield: the daemon re-idles (its next step re-plans on a free shape).
            mind.state = 'idle';
            mind.targetShapeId = null;
            continue;
          }
        }
        this._port.applyIntent(mind.id, intent);
      }
    }
  }

  /** Dispose: dismiss the whole crew (release held + player-leave) and go inert. */
  dispose(): void {
    if (this._disposed) return;
    this.dismiss();
    this._disposed = true;
  }
}
