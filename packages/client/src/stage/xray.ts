/**
 * xray.ts — F18 X-Ray Broadcast (C29, spec §7.18). The stage-only netcode
 * diagnostic overlay: staff taps once and the broadcast splits into TRUTH and
 * PRESENTATION — raw tick-stamped server snapshots as fading dots beside the
 * smooth interpolated world the players see, plus a red −300 ms ghost world
 * labeled "+300 ms — WHAT LAG FEELS LIKE". Visiting CS faculty watch authority-
 * vs-interpolation live; nobody's play degrades.
 *
 * ⚠ THE C0 FROZEN CONTRACT: `createInterpolator({source, now})`
 * (`packages/client/src/net/interpolation.ts`) is NEVER modified or extended
 * here. The ghost world is produced by a SECOND, independent interpolator
 * instance fed through {@link DelayFifoSource} (`packages/shared/src/replay.ts`
 * — the pure delay-FIFO shim BESIDE the ring buffer) — the exact same seam
 * `reelToStateSource` (attract.ts) and `PushStateSource` (stage/replay.ts)
 * already use to hand the frozen interpolator a non-socket source. Every x-ray
 * diagnostic (tick rate, snapshot age, interp buffer, RTT chips) is computed
 * HERE at the shim/source layer — never inside the interpolator (spec §7.18:
 * "the verified C0 Step 3 interpolator signature stays frozen").
 *
 * State guards (spec §7.18, all owned here — never server-side, never auto-cued):
 *   • allowed phases: PLAY, ATTRACT ONLY — `trigger()` refuses outside them; a
 *     live phase transition OUT of {PLAY,ATTRACT} while active auto-reverts
 *     (generalizes "any transition into OVERLOAD/FINALE" to every disallowed
 *     phase — LOBBY/STATS/RESET included; STAGE_XRAY never enters the pacing
 *     table so this is the only path a phase change touches it).
 *   • auto-revert on a 60–90 s timer ({@link XRAY_AUTO_REVERT_MS}).
 *   • refused at trigger time, and auto-cancelled mid-flight, whenever a C21
 *     replay is airing (`isReplayAiring`, injected — keeps this module socket/
 *     render-free).
 *   • ATTRACT PRECEDENCE (verified — else the quiet-hours use case is dead):
 *     firing x-ray DURING ATTRACT is ALLOWED (ATTRACT is in the allowed-phase
 *     set) and PAUSES ghost/ballet playback for the x-ray window via the
 *     OPTIONAL, attach-if-landed {@link XrayAttractHook}; attract RESUMES on
 *     revert. The pre-existing ATTRACT state is NEVER itself a refusal/cancel
 *     reason — only a replay starting, or a transition to a disallowed phase,
 *     is (spec §7.18: "never to the pre-existing ATTRACT state").
 *
 * Must-ship chrome (spec §7.18 acceptance criterion): the oversized "NETWORK
 * X-RAY // LIVE DIAGNOSTIC FEED" header + the three claim banners ("SERVER
 * TRUTH" / "WHAT PLAYERS SEE" / "+300 ms — WHAT LAG FEELS LIKE") at 5-METER
 * scale (`data-scale="5m"` — CSS hook, mirrors every other 5-m broadcast
 * banner in overlays.ts); the numeric HUD chips are close-range (the explicit
 * §7.1 exemption for a narrated 60–90 s inspection mode — `data-scale=
 * "close-range"`). Bloom-off + the ghost-shapes-only cap are render.ts/THREE
 * concerns: like every other Tier 6 3D specific in this codebase (CRYSTAL_CAM,
 * WORM_EYE, the siege/daemon/caster visuals), render.ts wiring is a deferred
 * manual-verify integration point — {@link XrayController.serverTruthDots} and
 * {@link XrayController.ghostSample} are the exposed data seam for it.
 */

import { DelayFifoSource, XRAY_GHOST_DELAY_MS } from '@cyber-shapes/shared';
import type { ServerMsg, Vec3 } from '@cyber-shapes/shared';
import {
  createInterpolator,
  type Interpolator,
  type StateSource,
  type StateFrame,
} from '../net/interpolation.js';

/** Phases in which x-ray may be triggered (spec §7.18) — nowhere else. */
export const XRAY_ALLOWED_PHASES: readonly string[] = ['PLAY', 'ATTRACT'];

/** Auto-revert window (spec §7.18: "60–90 s timer"); fixed at the midpoint. */
export const XRAY_AUTO_REVERT_MS = 75_000;

/** Raw "server truth" dot-trail depth per shape (a fading tick-stamped trail). */
export const XRAY_DOT_HISTORY = 8;

/** How often the stage re-requests the roster while x-ray is live (RTT chip refresh). */
export const XRAY_ROSTER_POLL_MS = 3_000;

/** Must-ship chrome text (spec §7.18, verbatim — never paraphrased). */
export const XRAY_HEADER = 'NETWORK X-RAY // LIVE DIAGNOSTIC FEED';
export const XRAY_BANNER_SERVER_TRUTH = 'SERVER TRUTH';
export const XRAY_BANNER_WHAT_PLAYERS_SEE = 'WHAT PLAYERS SEE';
export const XRAY_BANNER_GHOST = '+300 ms — WHAT LAG FEELS LIKE';

/** One raw, tick-stamped "server truth" dot (a fading trail point). */
export interface XrayDot {
  tick: number;
  wallTime: number;
  p: Vec3;
}

/** A per-resident RTT chip — ALWAYS labeled "client-reported" (spec §7.18). */
export interface XrayRttChip {
  id: string;
  callsign: string;
  /** null when the roster hasn't reported an RTT for this peer yet. */
  rttMs: number | null;
}

/** The HUD strip data (spec §7.18: tick rate, snapshot age, interp buffer, RTT). */
export interface XrayHudStrip {
  tickRateHz: number;
  snapshotAgeMs: number;
  /** The ghost delay-FIFO's configured buffering (ms) — a shim-layer diagnostic. */
  interpBufferMs: number;
  rtt: XrayRttChip[];
  closesInMs: number;
}

/**
 * ATTRACT precedence (spec §7.18): the OPTIONAL, attach-if-landed driver x-ray
 * pauses/resumes ghost/ballet playback through — the same idiom as `GlyphSink`
 * (stage.ts). Absent a registration, x-ray still runs correctly during ATTRACT;
 * it simply has nothing to pause (no render.ts ghost driver exists yet on this
 * branch — attract.ts's `AttractMachine`/`reelToStateSource` are not wired into
 * a render loop; see the C29 report).
 */
export interface XrayAttractHook {
  /** Pause ghost/ballet playback for the x-ray inspection window. */
  pause(): void;
  /** Resume ghost/ballet playback (x-ray reverted, still in ATTRACT). */
  resume(): void;
}

export interface XrayOpts {
  /** Injected clock (ms). Defaults to performance.now. */
  now?: () => number;
  /** The ghost delay (ms). Defaults to XRAY_GHOST_DELAY_MS (spec §7.18: 300). */
  delayMs?: number;
  /**
   * True while a C21 replay is airing. Injected (rather than importing
   * StageReplay) so this module stays render/socket-free and independently
   * testable. Defaults to `() => false`.
   */
  isReplayAiring?: () => boolean;
}

/**
 * The X-Ray controller: pure state + guards + the ghost interpolator/delay
 * shim + the must-ship DOM chrome. Owns no socket — `Stage` feeds it `state` /
 * `roster` / phase transitions and drives `update(dtMs)` each frame (mirrors
 * `StageReplay`'s seam exactly).
 */
export class XrayController {
  readonly root: HTMLElement;
  private readonly doc: Document;
  private readonly now: () => number;
  private readonly isReplayAiring: () => boolean;

  private readonly headerEl: HTMLElement;
  private readonly truthBannerEl: HTMLElement;
  private readonly seesBannerEl: HTMLElement;
  private readonly ghostBannerEl: HTMLElement;
  private readonly hudEl: HTMLElement;

  private _active = false;
  private phase = 'LOBBY';
  private remainingMs = 0;
  private attractHook: XrayAttractHook | null = null;
  private attractPaused = false;

  /** Per-shape fading "server truth" dot trail (capped at XRAY_DOT_HISTORY). */
  private readonly dots = new Map<string, XrayDot[]>();
  /** Per-resident roster RTT snapshot (spec §7.18 "client-reported" chips). */
  private readonly rosterRtt = new Map<string, { callsign: string; rttMs?: number }>();

  private lastStateWallMs = -Infinity;
  private lastTick = -1;
  private tickRateHz = 0;

  /**
   * Wall-clock activation stamp (post-review fold-in — RAF-independent revert
   * safety). `remainingMs`/`update(dtMs)` is the PRIMARY auto-revert clock, but
   * it only advances from the stage RAF loop; if that loop stalls (a
   * backgrounded/throttled kiosk tab) the timer never fires and x-ray would
   * stay stuck on. `checkWallClockRevert` (driven by `ingestState`/
   * `ingestRoster` — ticks fed directly off the WS message stream, NEVER the
   * RAF loop) is the safety net. -Infinity while inactive.
   */
  private activatedAtMs = -Infinity;

  // The ghost world: a SECOND, INDEPENDENT createInterpolator instance fed by
  // the pure delay-FIFO shim. The C0 signature is consumed verbatim — NEVER
  // touched (no new params, no subclassing, no monkey-patch).
  private readonly delaySource: DelayFifoSource<StateFrame>;
  private readonly ghostInterpolator: Interpolator;

  constructor(doc: Document, opts: XrayOpts = {}) {
    this.doc = doc;
    this.now = opts.now ?? (() => performance.now());
    this.isReplayAiring = opts.isReplayAiring ?? (() => false);

    this.delaySource = new DelayFifoSource<StateFrame>(opts.delayMs ?? XRAY_GHOST_DELAY_MS);
    // DelayFifoSource is STRUCTURALLY a StateSource (onState(cb): unsub over an
    // opaque frame) — no client type import happened in shared/replay.ts; the
    // structural match is asserted by this call type-checking at all.
    this.ghostInterpolator = createInterpolator({
      source: this.delaySource as unknown as StateSource,
      now: this.now,
    });

    this.root = doc.createElement('div');
    this.root.className = 'stage-xray';
    this.root.dataset['role'] = 'stage-xray';
    this.root.hidden = true;

    this.headerEl = this.mk('stage-xray-header', 'xray-header');
    this.headerEl.textContent = XRAY_HEADER;
    this.headerEl.dataset['scale'] = '5m';

    this.truthBannerEl = this.mk('stage-xray-truth', 'xray-banner-truth');
    this.truthBannerEl.textContent = XRAY_BANNER_SERVER_TRUTH;
    this.truthBannerEl.dataset['scale'] = '5m';

    this.seesBannerEl = this.mk('stage-xray-sees', 'xray-banner-sees');
    this.seesBannerEl.textContent = XRAY_BANNER_WHAT_PLAYERS_SEE;
    this.seesBannerEl.dataset['scale'] = '5m';

    this.ghostBannerEl = this.mk('stage-xray-ghost', 'xray-banner-ghost');
    this.ghostBannerEl.textContent = XRAY_BANNER_GHOST;
    this.ghostBannerEl.dataset['scale'] = '5m';

    // The numeric HUD chips are close-range (spec §7.1's explicit exemption for
    // this narrated inspection mode) — NEVER 5-meter scale.
    this.hudEl = this.mk('stage-xray-hud', 'xray-hud');
    this.hudEl.dataset['scale'] = 'close-range';
  }

  private mk(className: string, role: string): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = className;
    el.dataset['role'] = role;
    this.root.appendChild(el);
    return el;
  }

  /** True while x-ray is live (drives the render layer's mode switch — bloom off). */
  get active(): boolean {
    return this._active;
  }

  /** The current tracked phase (for tests / diagnostics). */
  get currentPhase(): string {
    return this.phase;
  }

  /**
   * ATTRACT precedence (spec §7.18): register the OPTIONAL ghost/ballet pause-
   * resume driver (attach-if-landed, like `GlyphSink`). Safe to call before or
   * after construction; a re-registration replaces the prior hook.
   */
  registerAttractHook(hook: XrayAttractHook): void {
    this.attractHook = hook;
  }

  // ---------------------------------------------------------------------------
  // Phase tracking — the PLAY/ATTRACT guard + the OVERLOAD/FINALE (and every
  // other disallowed phase) auto-revert + the ATTRACT pause/resume precedence.
  // ---------------------------------------------------------------------------

  /**
   * Feed the live PHASE_STATE phase. While x-ray is active: a transition OUT of
   * {PLAY, ATTRACT} auto-reverts (spec §7.18 "any transition into OVERLOAD/
   * FINALE", generalized to the full disallowed set); staying/entering ATTRACT
   * engages the attract-pause hook, staying/entering PLAY resumes it if it was
   * paused. Merely BEING (or becoming) ATTRACT is never itself a revert reason.
   */
  setPhase(phase: string): void {
    this.phase = phase;
    if (!this._active) return;
    if (!XRAY_ALLOWED_PHASES.includes(phase)) {
      this.revert();
      return;
    }
    this.syncAttractPause();
  }

  private syncAttractPause(): void {
    const isAttract = this.phase === 'ATTRACT';
    if (isAttract && !this.attractPaused) {
      this.attractHook?.pause();
      this.attractPaused = true;
    } else if (!isAttract && this.attractPaused) {
      this.attractHook?.resume();
      this.attractPaused = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Trigger / revert / toggle.
  // ---------------------------------------------------------------------------

  /**
   * Fire x-ray. Refused (returns false, no state change) unless the CURRENT
   * phase is PLAY or ATTRACT AND no replay is currently airing (spec §7.18
   * state exclusion). Idempotent while already active.
   */
  trigger(): boolean {
    if (this._active) return true;
    if (!XRAY_ALLOWED_PHASES.includes(this.phase)) return false;
    if (this.isReplayAiring()) return false;
    this._active = true;
    this.remainingMs = XRAY_AUTO_REVERT_MS;
    this.activatedAtMs = this.now();
    this.root.hidden = false;
    this.delaySource.clear(); // a clean ghost window every activation
    // Post-review fold-in: the delay-FIFO's QUEUE is clear, but the persistent
    // ghostInterpolator's SnapshotBuffer (createInterpolator's OWN clear() —
    // never modified here, just called) still holds whatever it last ingested.
    // Without this, a re-trigger's ghostSample() clamps to the PRIOR
    // activation's stale last-known pose until enough new frames flow through
    // the fresh 300 ms delay — a "clean window every activation" that wasn't
    // actually clean. Reset on BOTH sides (trigger + revert) so no ordering
    // assumption is load-bearing.
    this.ghostInterpolator.clear();
    this.syncAttractPause();
    this.renderHud();
    return true;
  }

  /** Cancel x-ray (manual, timer, or an auto-revert guard). Idempotent. */
  revert(): void {
    if (!this._active) return;
    this._active = false;
    this.activatedAtMs = -Infinity;
    this.root.hidden = true;
    if (this.attractPaused) {
      this.attractHook?.resume();
      this.attractPaused = false;
    }
    this.delaySource.clear();
    this.ghostInterpolator.clear(); // clean window: see trigger()'s comment
  }

  /** Toggle — the stage-LOCAL hotkey AND the STAGE_XRAY console relay both call this. */
  toggle(): boolean {
    if (this._active) {
      this.revert();
      return false;
    }
    return this.trigger();
  }

  // ---------------------------------------------------------------------------
  // Ingest — `state` (raw dots + the ghost delay shim + tick-rate/snapshot-age)
  // and `roster` (the "client-reported" RTT chips).
  // ---------------------------------------------------------------------------

  /**
   * RAF-independent revert safety (post-review fold-in, spec §7.18 "60–90 s
   * timer"): a wall-clock backstop alongside the frame-quantized `remainingMs`
   * countdown. Called from `ingestState`/`ingestRoster` — ticks driven
   * directly by the WS message stream, never by the stage RAF loop — so a
   * stalled/throttled render loop cannot leave x-ray stuck on past its window.
   * No-op while inactive or still within the window.
   */
  private checkWallClockRevert(): void {
    if (!this._active) return;
    if (this.now() - this.activatedAtMs >= XRAY_AUTO_REVERT_MS) this.revert();
  }

  /** Feed one `state` ServerMsg. Raw dots always tracked; the ghost shim only while active. */
  ingestState(msg: Extract<ServerMsg, { t: 'state' }>): void {
    this.checkWallClockRevert();
    const wall = this.now();
    if (this.lastStateWallMs !== -Infinity) {
      const dt = wall - this.lastStateWallMs;
      if (dt > 0) this.tickRateHz = 1000 / dt;
    }
    this.lastStateWallMs = wall;
    this.lastTick = msg.serverTick;

    for (const s of msg.shapes) {
      let trail = this.dots.get(s.id);
      if (!trail) {
        trail = [];
        this.dots.set(s.id, trail);
      }
      trail.push({ tick: msg.serverTick, wallTime: wall, p: { ...s.p } });
      if (trail.length > XRAY_DOT_HISTORY) trail.shift();
    }

    if (!this._active) return;
    const frame: StateFrame = { shapes: msg.shapes.map((s) => ({ id: s.id, p: s.p, r: s.r })) };
    this.delaySource.push(frame, wall);
    this.renderHud();
  }

  /** Feed a `roster` ServerMsg's entries — the RTT chip source (spec §7.18). */
  ingestRoster(entries: Extract<ServerMsg, { t: 'roster' }>['entries']): void {
    this.checkWallClockRevert();
    this.rosterRtt.clear();
    for (const e of entries) this.rosterRtt.set(e.id, { callsign: e.callsign, rttMs: e.rttMs });
    this.renderHud();
  }

  // ---------------------------------------------------------------------------
  // Update — the auto-revert timer, the replay-airing auto-cancel poll, and
  // flushing the delay-FIFO ghost shim.
  // ---------------------------------------------------------------------------

  /** Advance by `dtMs` of real time. No-op while inactive. */
  update(dtMs: number): void {
    if (!this._active) return;
    // State exclusion (spec §7.18): a replay STARTING mid-flight auto-cancels.
    if (this.isReplayAiring()) {
      this.revert();
      return;
    }
    this.delaySource.tick(this.now());
    this.remainingMs -= dtMs;
    this.renderHud();
    if (this.remainingMs <= 0) this.revert();
  }

  // ---------------------------------------------------------------------------
  // Read-outs — the server-truth dot trail + the ghost pose sample. The render
  // layer (deferred, like every other Tier 6 3D specific) consumes these.
  // ---------------------------------------------------------------------------

  /** The fading "server truth" dot trail for a shape (newest last). */
  serverTruthDots(id: string): readonly XrayDot[] {
    return this.dots.get(id) ?? [];
  }

  /** Every shape id with a tracked dot trail. */
  trackedShapeIds(): string[] {
    return [...this.dots.keys()];
  }

  /** Sample the −300 ms ghost world for `id` at `renderTimeMs` (via the FROZEN interpolator). */
  ghostSample(id: string, renderTimeMs: number): { p: Vec3; r: Vec3 } | null {
    return this.ghostInterpolator.sample(id, renderTimeMs);
  }

  /** ms remaining before the auto-revert timer fires (0 when inactive). */
  remainingRevertMs(): number {
    return this._active ? Math.max(0, this.remainingMs) : 0;
  }

  /** The HUD strip data (spec §7.18: tick rate, snapshot age, interp buffer, RTT). */
  hud(): XrayHudStrip {
    const snapshotAgeMs =
      this.lastStateWallMs === -Infinity ? -1 : Math.max(0, Math.round(this.now() - this.lastStateWallMs));
    const rtt: XrayRttChip[] = [...this.rosterRtt.entries()].map(([id, r]) => ({
      id,
      callsign: r.callsign,
      rttMs: typeof r.rttMs === 'number' ? r.rttMs : null,
    }));
    return {
      tickRateHz: Math.round(this.tickRateHz * 10) / 10,
      snapshotAgeMs,
      interpBufferMs: this.delaySource.delay,
      rtt,
      closesInMs: this.remainingRevertMs(),
    };
  }

  /** Paint the close-range HUD chip text (5-m banners never change — set once). */
  private renderHud(): void {
    const h = this.hud();
    this.hudEl.dataset['tickRate'] = String(h.tickRateHz);
    this.hudEl.dataset['snapshotAge'] = String(h.snapshotAgeMs);
    this.hudEl.dataset['interpBuffer'] = String(h.interpBufferMs);
    this.hudEl.dataset['closesIn'] = String(h.closesInMs);
    const rttText =
      h.rtt.length === 0
        ? '—'
        : h.rtt.map((r) => `${r.callsign} ${r.rttMs === null ? '—' : `${r.rttMs}ms`}`).join(' · ');
    this.hudEl.dataset['lastTick'] = String(this.lastTick);
    this.hudEl.textContent =
      `TICK ${h.tickRateHz.toFixed(1)} Hz (#${this.lastTick}) · SNAPSHOT AGE ${Math.max(0, h.snapshotAgeMs)} ms · ` +
      `INTERP BUFFER ${h.interpBufferMs} ms · CLOSES IN ${Math.ceil(h.closesInMs / 1000)}s · ` +
      `RTT (client-reported): ${rttText}`;
  }

  /** Tear down (kiosk reload / page unload). */
  dispose(): void {
    this._active = false;
    this.ghostInterpolator.dispose();
    this.root.parentNode?.removeChild(this.root);
  }
}

// Re-export the delay for callers that want the raw constant without pulling
// in the whole shared barrel (mirrors XRAY_GHOST_DELAY_MS's shared home).
export { XRAY_GHOST_DELAY_MS };
