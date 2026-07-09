/**
 * overlays.ts — the stage overlay package (C9, spec §7.1).
 *
 * DOM/CSS chrome drawn OVER the WebGL canvas (never in-canvas — DOM overlays are
 * captured by neither WebXR nor `captureStream`, so C31 composites its own; here
 * they are the big-screen broadcast chrome). Everything is 5-METER LEGIBLE
 * (oversized type, high contrast, redundancy) per §7.1.
 *
 * The pieces (spec §7.1):
 *   • neon LOWER-THIRDS  — callsign + color swatch + PATTERN redundancy (color is
 *                          never the only signal — §6.1 accessibility).
 *   • ambient TICKER     — event texture, NEVER load-bearing (decorative only).
 *   • docked static QR   — glow may pulse; the code itself never scales/warps.
 *   • the §14 COUNTER    — "N PLAYERS — 1 WORLD — 1 SOCKET". GATED: shown ONLY
 *                          when its flex-line test is green (C2 tier fan-out
 *                          harness). The stage passes `flexLineGranted` from that
 *                          gate; absent it, the counter is structurally hidden.
 *
 * Explicit OVERLAY SLOT PRIORITY (spec §7.1, verified):
 *   replay chrome > cue banner > caster caption > ambient ticker
 * Only the highest-priority ACTIVE slot occupies the shared banner region; a
 * lower slot is suppressed while a higher one is live (its content is retained
 * and re-shown when the higher slot clears). Lower-thirds / QR / counter live in
 * their own regions and are not part of the shared-banner contention.
 *
 * Pure-ish: no THREE. Takes a Document so it is test/SSR-safe (jsdom).
 */

import { themeStageLine, renderCasterWire, withinCasterBudget, casterTemplate } from '@cyber-shapes/shared';
import { CLIP_TAKE_HOME_HEADLINE, CLIP_TAKE_HOME_CARD_MS } from './clips.js';

/** The four contended banner slots, HIGH → LOW priority (spec §7.1). */
export type OverlaySlot = 'replay' | 'cue' | 'caster' | 'ticker';

/** HIGH → LOW. The first slot in this list with content wins the banner region. */
export const SLOT_PRIORITY: readonly OverlaySlot[] = ['replay', 'cue', 'caster', 'ticker'];

/** A lower-third payload (spec §7.1 — callsign + color + PATTERN redundancy). */
export interface LowerThird {
  callsign: string;
  /** CSS color for the swatch (the stage resolves CYBER_COLORS[idx] → hex). */
  color: string;
  /**
   * A pattern name rendered ALONGSIDE the color so color is never the sole
   * signal (§6.1). One of a small fixed set; unknown → 'solid'.
   */
  pattern?: 'solid' | 'stripe' | 'dot' | 'grid';
}

/** Options for {@link StageOverlays}. */
export interface StageOverlaysOpts {
  /**
   * True iff the §14 "N PLAYERS — 1 WORLD — 1 SOCKET" flex-line gate is GREEN
   * (C2 tier fan-out harness). The counter is NEVER rendered while this is false
   * — a gated claim must not air (§14). Default false (fail-closed).
   */
  flexLineGranted?: boolean;
}

/**
 * The stage overlay manager. Owns a root <div> of positioned regions; the caller
 * mounts `root` over the canvas. Every setter is idempotent and never throws on a
 * missing DOM (the whole app degrades to canvas-only if the overlay can't mount).
 */
export class StageOverlays {
  readonly root: HTMLElement;
  private readonly doc: Document;
  private readonly flexLineGranted: boolean;

  private readonly bannerEl: HTMLElement;
  private readonly lowerThirdEl: HTMLElement;
  private readonly qrEl: HTMLElement;
  private readonly counterEl: HTMLElement;
  /** C25 (F14 The Gallery): the "N WATCHING · 0 VIDEO FRAMES SENT" watcher line. */
  private readonly watcherCounterEl: HTMLElement;
  /** C13: the F10 attract-mode recording-notice sign (§6.1 kit-list copy). */
  private readonly attractSignEl: HTMLElement;
  /** C20: the F9 Reality Channels attract flex line ("N REALITIES · 0 ASSETS …"). */
  private readonly themeLineEl: HTMLElement;
  /** C15: the F5 Reality Referendum region (dueling tally bars + countdown). */
  private readonly referendumEl: HTMLElement;
  private readonly referendumBarsEl: HTMLElement;
  private readonly referendumCountdownEl: HTMLElement;
  private readonly referendumDecreeEl: HTMLElement;
  /** C18: the F8 Resonora big-screen causality layer (beat ring + note flashes). */
  private readonly beatRingEl: HTMLElement;
  private readonly noteFlashEl: HTMLElement;
  /** Toggles each beat so CSS re-triggers the ring pulse animation. */
  private _beatPulseToggle = 0;
  /** C19: the F12 Supernova Encore constellation mirror (stars + charge bar). */
  private readonly constellationEl: HTMLElement;
  private readonly constellationStarsEl: HTMLElement;
  private readonly constellationChargeEl: HTMLElement;
  /** C31 (F20 Neon Clip Machine, §7.20): the STATS/RESET "take your clip home" card. */
  private readonly clipTakeHomeEl: HTMLElement;
  private readonly clipTakeHomeHeadlineEl: HTMLElement;
  private readonly clipTakeHomeUrlEl: HTMLElement;
  /** Auto-hide timer handle for the take-home card (cleared on re-show / hide). */
  private _clipTakeHomeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Retained content per contended slot ('' = empty). */
  private readonly slots: Record<OverlaySlot, string> = {
    replay: '',
    cue: '',
    caster: '',
    ticker: '',
  };

  // ---- C26 (F15 MC NULL) caster caption state ------------------------------
  /** True once the staff panic key fired — every further caster line is suppressed. */
  private _casterPanicked = false;
  /** The Advanced-tab caster-mute cue — suppresses captions + voice while true. */
  private _casterMuted = false;
  /** TTS garnish toggle. DEFAULT OFF (spec §7.15 — acceptance never references TTS). */
  private _casterTtsOn = false;
  /** Injected duck hook (music/voice ducks 3–5 while a low-priority line speaks). */
  private _casterDuck: (on: boolean) => void = () => {};

  constructor(doc: Document, opts: StageOverlaysOpts = {}) {
    this.doc = doc;
    this.flexLineGranted = opts.flexLineGranted ?? false;

    this.root = doc.createElement('div');
    this.root.className = 'stage-overlays';
    this.root.setAttribute('data-role', 'stage-overlays');

    this.bannerEl = this.mk('stage-banner', 'banner');
    this.lowerThirdEl = this.mk('stage-lower-third', 'lower-third');
    this.qrEl = this.mk('stage-qr', 'qr');
    this.counterEl = this.mk('stage-counter', 'counter');
    // C25 (F14 The Gallery): the remote-audience counter — hidden until N ≥ 5.
    this.watcherCounterEl = this.mk('stage-watcher-counter', 'watcher-counter');
    this.watcherCounterEl.hidden = true;
    // C13: the attract recording-notice sign — hidden until attract engages.
    this.attractSignEl = this.mk('stage-attract-sign', 'attract-sign');
    this.attractSignEl.hidden = true;
    // C20: the Reality Channels attract flex line — hidden until attract engages.
    this.themeLineEl = this.mk('stage-theme-line', 'theme-line');
    this.themeLineEl.hidden = true;

    // C15: the Reality Referendum region — dueling tally bars + a countdown
    // takeover + the "THE CROWD DECREED" splash. Hidden until an election runs.
    this.referendumEl = this.mk('stage-referendum', 'referendum');
    this.referendumEl.hidden = true;
    this.referendumBarsEl = this.doc.createElement('div');
    this.referendumBarsEl.className = 'referendum-bars';
    this.referendumBarsEl.dataset['role'] = 'referendum-bars';
    this.referendumEl.appendChild(this.referendumBarsEl);
    this.referendumCountdownEl = this.doc.createElement('div');
    this.referendumCountdownEl.className = 'referendum-countdown';
    this.referendumCountdownEl.dataset['role'] = 'referendum-countdown';
    this.referendumCountdownEl.hidden = true;
    this.referendumEl.appendChild(this.referendumCountdownEl);
    this.referendumDecreeEl = this.mk('stage-referendum-decree', 'referendum-decree');
    this.referendumDecreeEl.hidden = true;

    // C18: the Resonora causality layer — a beat ring + a note-flash region. The
    // beat ring is hidden until the first pulse; the note-flash region hosts the
    // per-note flashes drawn ON the impacting shapes (color-coded per player).
    this.beatRingEl = this.mk('stage-beat-ring', 'beat-ring');
    this.beatRingEl.hidden = true;
    this.noteFlashEl = this.mk('stage-note-flashes', 'note-flashes');

    // C19: the Supernova Encore constellation mirror — a field of stars that
    // "completes" at 5 phones (§7.13) + a charge bar that fills as the crowd
    // charges. Hidden until the encore arms (the first constellation update).
    this.constellationEl = this.mk('stage-constellation', 'constellation');
    this.constellationEl.hidden = true;
    this.constellationStarsEl = this.doc.createElement('div');
    this.constellationStarsEl.className = 'constellation-stars';
    this.constellationStarsEl.dataset['role'] = 'constellation-stars';
    this.constellationEl.appendChild(this.constellationStarsEl);
    this.constellationChargeEl = this.doc.createElement('div');
    this.constellationChargeEl.className = 'constellation-charge';
    this.constellationChargeEl.dataset['role'] = 'constellation-charge';
    this.constellationEl.appendChild(this.constellationChargeEl);

    // C31 (F20, §7.20): the STATS/RESET "SCAN TO TAKE YOUR CLIP HOME" card — the
    // on-stage CTA that sends the visitor's clip home. Hidden until STATS/RESET;
    // shown for ~CLIP_TAKE_HOME_CARD_MS then auto-cleared. Its own region (not part
    // of the shared-banner contention). The headline is the load-bearing copy; the
    // QR/URL raster is drawn by CSS/booth-ops off the `data-url` attr (the SAME
    // "drawn by the caller" seam setQr() uses — no bundled QR dependency).
    this.clipTakeHomeEl = this.mk('stage-clip-take-home', 'clip-take-home');
    this.clipTakeHomeEl.hidden = true;
    this.clipTakeHomeHeadlineEl = this.doc.createElement('div');
    this.clipTakeHomeHeadlineEl.className = 'clip-take-home-headline';
    this.clipTakeHomeHeadlineEl.dataset['role'] = 'clip-take-home-headline';
    this.clipTakeHomeEl.appendChild(this.clipTakeHomeHeadlineEl);
    this.clipTakeHomeUrlEl = this.doc.createElement('div');
    this.clipTakeHomeUrlEl.className = 'clip-take-home-url';
    this.clipTakeHomeUrlEl.dataset['role'] = 'clip-take-home-url';
    this.clipTakeHomeEl.appendChild(this.clipTakeHomeUrlEl);

    // The counter is §14-GATED: only mount its content when the gate is green.
    if (this.flexLineGranted) {
      this.counterEl.dataset['gated'] = 'granted';
    } else {
      this.counterEl.dataset['gated'] = 'withheld';
      this.counterEl.hidden = true;
    }
  }

  private mk(className: string, role: string): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = className;
    el.dataset['role'] = role;
    this.root.appendChild(el);
    return el;
  }

  // ---- Contended banner slots (spec §7.1 priority) ------------------------

  /** Set (or clear, with '') a contended banner slot's content. Re-resolves. */
  setSlot(slot: OverlaySlot, text: string): void {
    this.slots[slot] = text;
    this.resolveBanner();
  }

  /** Clear a slot (equivalent to setSlot(slot, '')). */
  clearSlot(slot: OverlaySlot): void {
    this.setSlot(slot, '');
  }

  /** Which slot currently OWNS the banner region ('' when all empty). */
  activeSlot(): OverlaySlot | null {
    for (const s of SLOT_PRIORITY) {
      if (this.slots[s]) return s;
    }
    return null;
  }

  /** Render the highest-priority non-empty slot into the shared banner region. */
  private resolveBanner(): void {
    const active = this.activeSlot();
    if (active === null) {
      this.bannerEl.textContent = '';
      this.bannerEl.hidden = true;
      delete this.bannerEl.dataset['slot'];
      return;
    }
    this.bannerEl.hidden = false;
    this.bannerEl.dataset['slot'] = active;
    this.bannerEl.textContent = this.slots[active];
  }

  // ---- Convenience wrappers for the named slots ---------------------------

  /** Replay chrome (highest priority — e.g. "INSTANT REPLAY", "RE-SIMULATED"). */
  setReplayChrome(text: string): void {
    this.setSlot('replay', text);
  }
  /** The cue banner (dial/showpiece name — second priority). */
  setCueBanner(text: string): void {
    this.setSlot('cue', text);
  }
  /** The caster caption (C26 — third priority; ≤ 2 lines for 5-m legibility). */
  setCasterCaption(text: string): void {
    this.setSlot('caster', text);
  }

  /**
   * C27 (F16 Siege Waves, spec §7.16): the full-screen wave SPLASH ("WAVE 3 —
   * BULLET TIME" slams across the screen). It rides the CUE-BANNER treatment (the
   * shared banner region at the `cue` slot) — NEVER the callout queue. `name` is
   * resolved CLIENT-SIDE from the shared SIEGE_WAVES table by the caller (no wave
   * NAME on the wire — only the numeric waveIndex rides SHOWPIECE_STATE). A
   * `data-siege-wave` marker lets CSS give the splash its slam-in treatment.
   */
  showSiegeWave(waveIndex: number, name: string): void {
    this.setCueBanner(name);
    this.bannerEl.dataset['siegeWave'] = String(waveIndex);
  }

  // ---- C26 (F15 MC NULL) — render a CASTER_LINE (0x33) into the caption ----

  /**
   * Render a decoded CASTER_LINE (templateId + flat wire slots) into the caster
   * caption slot. THE STAGE NEVER GENERATES A LINE — it only resolves the authored
   * template via the shared grammar ({@link renderCasterWire}). Returns the rendered
   * text (for tests) or null when the line is unknown / suppressed (panic / mute /
   * over budget). §6.1 attribution redundancy: the callsign is rendered as TEXT
   * (never color-only) so the attribution reads sound-off + colour-blind.
   */
  setCasterLine(templateId: number, slots: readonly number[]): string | null {
    if (this._casterPanicked || this._casterMuted) return null;
    const text = renderCasterWire(templateId, slots);
    if (text === null || !withinCasterBudget(text)) return null; // never air a malformed / over-budget line
    this.setCasterCaption(text);
    // TTS is a garnish (default OFF): a priority-1 line cancels current speech;
    // low-priority (3–5) lines duck the mix with fast release. Never load-bearing.
    const priority = casterTemplate(templateId)?.priority ?? 3;
    this.speakCaster(text, priority);
    return text;
  }

  /**
   * The staff PANIC key (spec §6.1/§7.15): clear the caption, suppress every
   * further caster line, and cancel any in-flight TTS utterance. Idempotent. The
   * panic behavior extends to the audience tier's 128 anonymous screens (they
   * render the SAME renderer, so their captions clear on the panic-cleared frame).
   */
  panicCaster(): void {
    this._casterPanicked = true;
    this.clearSlot('caster');
    this.cancelCasterSpeech();
  }

  /** Lift a panic suppression (e.g. a fresh rotation / staff resume). */
  resumeCaster(): void {
    this._casterPanicked = false;
  }

  /** The Advanced-tab caster-mute cue: suppress captions + voice while muted. */
  setCasterMuted(on: boolean): void {
    this._casterMuted = on;
    if (on) {
      this.clearSlot('caster');
      this.cancelCasterSpeech();
    }
  }

  /** Enable/disable the TTS garnish (DEFAULT OFF — a staff toggle, spec §7.15). */
  setCasterTts(on: boolean): void {
    this._casterTtsOn = on;
    if (!on) this.cancelCasterSpeech();
  }

  /** Inject the duck hook the low-priority TTS shim toggles (music/voice ducking). */
  setCasterDuck(fn: (on: boolean) => void): void {
    this._casterDuck = fn;
  }

  /** True iff caster captions are currently suppressed (panic or mute). */
  get casterSuppressed(): boolean {
    return this._casterPanicked || this._casterMuted;
  }

  /**
   * The TTS duck-shim (spec §7.15 — `speechSynthesis` exposes no AudioNode). A
   * priority-1 line CANCELS any in-flight utterance (the money moment barges in);
   * a low-priority (3+) line ducks the mix on start and releases fast on end. No-op
   * when TTS is off or `speechSynthesis` is unavailable (jsdom / older browsers).
   */
  private speakCaster(text: string, priority: number): void {
    if (!this._casterTtsOn) return; // garnish, default OFF
    const win = this.doc.defaultView as (Window & typeof globalThis) | null;
    const synth = win?.speechSynthesis;
    const Utter = (win as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance } | null)
      ?.SpeechSynthesisUtterance;
    if (!synth || typeof Utter !== 'function') return;
    // A priority-1 line barges in — cancel whatever is currently speaking.
    if (priority <= 1) synth.cancel();
    const u = new Utter(text);
    if (priority >= 3) {
      // Low-priority lines duck the mix with fast release (onstart → onend).
      u.onstart = () => this._casterDuck(true);
      u.onend = () => this._casterDuck(false);
    }
    try {
      synth.speak(u);
    } catch {
      /* speech is best-effort garnish — never throw into the render path */
    }
  }

  /** Cancel any in-flight caster TTS + release the duck. */
  private cancelCasterSpeech(): void {
    this._casterDuck(false);
    const synth = (this.doc.defaultView as (Window & typeof globalThis) | null)?.speechSynthesis;
    try {
      synth?.cancel();
    } catch {
      /* best-effort */
    }
  }
  /** The ambient event ticker (lowest — decorative, NEVER load-bearing). */
  setTicker(text: string): void {
    this.setSlot('ticker', text);
  }

  // ---- Lower-third (its own region; not part of banner contention) --------

  /**
   * Show a neon lower-third (callsign + color swatch + PATTERN redundancy). The
   * pattern is drawn ALONGSIDE the swatch so a color-blind viewer still reads the
   * player identity (§6.1). Pass null to hide.
   */
  setLowerThird(lt: LowerThird | null): void {
    if (!lt) {
      this.lowerThirdEl.hidden = true;
      this.lowerThirdEl.textContent = '';
      return;
    }
    this.lowerThirdEl.hidden = false;
    this.lowerThirdEl.textContent = '';
    this.lowerThirdEl.dataset['callsign'] = lt.callsign;

    const swatch = this.doc.createElement('span');
    swatch.className = 'lower-third-swatch';
    swatch.style.backgroundColor = lt.color;
    // Pattern redundancy: encode it as a data attr the CSS renders + expose it
    // for tests / accessibility so color is never the ONLY signal.
    const pattern = lt.pattern ?? 'solid';
    swatch.dataset['pattern'] = pattern;

    const name = this.doc.createElement('span');
    name.className = 'lower-third-callsign';
    name.textContent = lt.callsign;

    this.lowerThirdEl.appendChild(swatch);
    this.lowerThirdEl.appendChild(name);
  }

  // ---- Docked QR (static geometry — never scales/warps; glow may pulse) ----

  /**
   * Set the docked join-QR (the code payload = the public join URL). The element
   * carries the URL; the actual QR raster is drawn by the caller/CSS. The code is
   * STATIC geometry — only the glow animates; the code never scales or warps
   * (spec §7.1). Pass null to hide (e.g. the kiosk "ask staff" health-swap).
   */
  setQr(url: string | null): void {
    if (!url) {
      this.qrEl.hidden = true;
      delete this.qrEl.dataset['url'];
      this.qrEl.textContent = '';
      return;
    }
    this.qrEl.hidden = false;
    this.qrEl.dataset['url'] = url;
    // Static geometry marker — the health-swap replaces the WHOLE element with an
    // "ask staff" card rather than warping the code.
    this.qrEl.dataset['static'] = 'true';
  }

  /**
   * The kiosk health-swap (spec §7.1): when the public join URL is unreachable,
   * hide the QR and show an "ask staff" card in its place (the code never shows a
   * dead link). Idempotent.
   */
  showAskStaffCard(): void {
    this.qrEl.hidden = false;
    delete this.qrEl.dataset['url'];
    this.qrEl.dataset['askStaff'] = 'true';
    this.qrEl.textContent = 'SCAN OFFLINE — ASK STAFF';
  }

  /** Restore the QR after an ask-staff card (health recovered). */
  restoreQr(url: string): void {
    delete this.qrEl.dataset['askStaff'];
    this.setQr(url);
  }

  // ---- §14 player counter (GATED) -----------------------------------------

  /**
   * Update the "N PLAYERS — 1 WORLD — 1 SOCKET" counter (spec §7.1 / §14). No-op
   * (and stays hidden) unless the §14 flex-line gate was granted at construction
   * — a gated claim never airs. `n` is the live player/participant count.
   */
  setPlayerCount(n: number): void {
    if (!this.flexLineGranted) return; // §14: withheld — never render the claim
    this.counterEl.hidden = false;
    this.counterEl.dataset['count'] = String(n);
    this.counterEl.textContent = `${n} PLAYERS — 1 WORLD — 1 SOCKET`;
  }

  /** True iff the §14 counter is allowed to render (gate granted). */
  get counterEnabled(): boolean {
    return this.flexLineGranted;
  }

  // ---- C25 (F14 The Gallery) — remote-audience "N WATCHING" counter --------

  /** The audience count at/above which the watcher counter renders (spec §7.14). */
  static readonly WATCHER_COUNTER_MIN = 5;

  /**
   * Update the "N WATCHING · 0 VIDEO FRAMES SENT" remote-audience counter (spec
   * §7.14 / §14 gate table). It renders ONLY at N ≥ 5 (a tiny watch count is not a
   * flex — a single dorm viewer must not put "1 WATCHING" on the big screen). The
   * "0 VIDEO FRAMES SENT" half is the load-bearing claim: the world is rendered by
   * each viewer's own GPU from the data stream, never streamed as video. Below the
   * threshold the counter is hidden. Driven off AUDIENCE_STATE (0.2 Hz).
   */
  setWatcherCount(n: number): void {
    const count = Math.max(0, Math.floor(n));
    if (count < StageOverlays.WATCHER_COUNTER_MIN) {
      this.watcherCounterEl.hidden = true;
      this.watcherCounterEl.textContent = '';
      delete this.watcherCounterEl.dataset['count'];
      return;
    }
    this.watcherCounterEl.hidden = false;
    this.watcherCounterEl.dataset['count'] = String(count);
    this.watcherCounterEl.textContent = `${count} WATCHING · 0 VIDEO FRAMES SENT`;
  }

  /** The rendered watcher-counter text ('' when hidden). For tests. */
  watcherCounterText(): string {
    return this.watcherCounterEl.hidden ? '' : this.watcherCounterEl.textContent ?? '';
  }

  /**
   * True iff §14 flex-line CLAIMS may render (e.g. "N PLAYERS…", the C21 replay
   * "RE-SIMULATED, NOT RECORDED" line). A gated claim never airs when false.
   */
  get flexClaimsGranted(): boolean {
    return this.flexLineGranted;
  }

  /** The text currently rendered in the shared banner region ('' when empty). */
  bannerText(): string {
    return this.bannerEl.textContent ?? '';
  }

  // ---- C13 F10 Ghost Arcade attract-mode chrome ---------------------------

  /**
   * The recording-notice sign shown in attract mode (spec §6.1 kit list —
   * "anonymized gameplay may be recorded and published as short clips"; the copy
   * covers both reels and §7.20 clips). Reels/ghosts are ANONYMOUS (GHOST_XX,
   * §6.1) so no consent identity is ever surfaced — this is disclosure only.
   */
  static readonly RECORDING_NOTICE =
    'ANONYMIZED GAMEPLAY MAY BE RECORDED AND PUBLISHED AS SHORT CLIPS';

  /**
   * Enter / leave F10 attract mode. In attract the join QR is EMPHASIZED (the
   * 5-m hook is motion + giant QR + typography — §7.10) and the recording-notice
   * sign is shown. Leaving restores the normal broadcast chrome. The `data-mode`
   * flag lets CSS scale the QR block up and dim the live-broadcast overlays.
   */
  setAttractMode(on: boolean): void {
    this.root.dataset['mode'] = on ? 'attract' : 'live';
    this.qrEl.dataset['emphasis'] = on ? 'attract' : 'normal';
    this.attractSignEl.hidden = !on;
    if (on) this.attractSignEl.textContent = StageOverlays.RECORDING_NOTICE;
    // C20: the Reality Channels flex line rides attract mode alongside the notice.
    this.themeLineEl.hidden = !on;
    if (on) this.setThemeLine();
  }

  /**
   * C20 (F9 Reality Channels): the §14 attract flex line
   * "N REALITIES · 0 ASSETS · 100% PROCEDURAL" (spec §14 gate table). `count`
   * defaults to the full advertised pool; pass an explicit count to show only the
   * ship gate. 5-meter legible — a decorative sign, never load-bearing.
   */
  setThemeLine(count?: number): void {
    this.themeLineEl.textContent = themeStageLine(count);
  }

  /**
   * The venue-brightness toggle (spec §7.10): a high-exposure palette for a
   * bright hall (a TV in daylight). Sets a `data-venue` flag CSS reads to swap to
   * the high-contrast/high-exposure palette. Idempotent.
   */
  setVenueBright(on: boolean): void {
    this.root.dataset['venue'] = on ? 'bright' : 'normal';
  }

  /** True iff attract-mode chrome is currently shown. */
  get attractActive(): boolean {
    return this.root.dataset['mode'] === 'attract';
  }

  // ---- C15 F5 Reality Referendum (dueling bars + countdown + decree) ------

  /**
   * Render the dueling tally bars (spec §7.5 "Big screen owns the drama"). One
   * bar per option with its share width; the leading option is flagged for CSS
   * emphasis. 5-meter legible: oversized, high contrast, redundant count text (a
   * bar is never the ONLY signal — the numeric count is always drawn). Reads the
   * 2 Hz coalesced tally the election host broadcasts (never per-vote).
   */
  setReferendumTally(t: {
    options: string[];
    tally: Record<string, number>;
    voterCount: number;
  }): void {
    this.referendumEl.hidden = false;
    this.referendumBarsEl.textContent = '';
    const total = Object.values(t.tally).reduce((a, b) => a + b, 0) || 1;
    // The leading option (for the takeover emphasis) — deterministic first-max.
    let lead: string | null = null;
    let leadCount = -1;
    for (const o of t.options) {
      const c = t.tally[o] ?? 0;
      if (c > leadCount) {
        leadCount = c;
        lead = o;
      }
    }
    for (const o of t.options) {
      const c = t.tally[o] ?? 0;
      const row = this.doc.createElement('div');
      row.className = 'referendum-row';

      const bar = this.doc.createElement('div');
      bar.className = 'referendum-bar';
      bar.dataset['role'] = 'referendum-bar';
      bar.dataset['option'] = o;
      bar.dataset['count'] = String(c);
      bar.dataset['leading'] = o === lead && leadCount > 0 ? 'true' : 'false';
      bar.style.width = `${Math.round((c / total) * 100)}%`;
      // Redundant legible label — color/width is never the sole signal (§6.1).
      bar.textContent = `${o.replace(/-/g, ' ').toUpperCase()} · ${c}`;
      row.appendChild(bar);
      this.referendumBarsEl.appendChild(row);
    }
    this.referendumEl.dataset['voters'] = String(t.voterCount);
  }

  /** The countdown takeover (spec §7.5). Pass null to clear. Seconds to close. */
  setReferendumCountdown(seconds: number | null): void {
    if (seconds === null) {
      this.referendumCountdownEl.hidden = true;
      this.referendumCountdownEl.textContent = '';
      return;
    }
    this.referendumEl.hidden = false;
    this.referendumCountdownEl.hidden = false;
    this.referendumCountdownEl.textContent = `${Math.max(0, Math.ceil(seconds))}s TO VOTE`;
  }

  /**
   * The "THE CROWD DECREED" enactment splash (spec §7.5 — the money-shot moment).
   * Shows the winning law name + owns the shared banner region (a takeover) at the
   * CUE slot priority (below replay, above caster/ticker) so it wins the banner.
   */
  showCrowdDecreed(lawName: string): void {
    this.referendumEl.hidden = false;
    this.referendumDecreeEl.hidden = false;
    this.referendumDecreeEl.textContent = `THE CROWD DECREED: ${lawName}`;
    // Take over the shared banner region so the decree reads on the big screen.
    this.setCueBanner(`THE CROWD DECREED: ${lawName}`);
  }

  /** Clear the whole referendum region (election over / rotation boundary). */
  clearReferendum(): void {
    this.referendumEl.hidden = true;
    this.referendumBarsEl.textContent = '';
    this.referendumCountdownEl.hidden = true;
    this.referendumCountdownEl.textContent = '';
    this.referendumDecreeEl.hidden = true;
    this.referendumDecreeEl.textContent = '';
  }

  /** True iff the referendum region is currently shown. */
  get referendumActive(): boolean {
    return !this.referendumEl.hidden;
  }

  // ---- C18 F8 Resonora causality visualization (spec §7.8 — hard deliverable) --

  /**
   * Pulse the stage BEAT RING on beat `beatIndex` (spec §7.8 — the big-screen
   * causality cue that survives sound-off). `data-beat` carries the beat index
   * and `data-pulse` toggles each call so CSS can re-trigger the pulse animation.
   * Idempotent per beat; the caller drives it off the C13 beat clock.
   */
  pulseBeatRing(beatIndex: number): void {
    this.beatRingEl.hidden = false;
    this.beatRingEl.dataset['beat'] = String(beatIndex);
    // Toggle a marker so a repeated animation re-fires (a boolean flip is enough).
    this._beatPulseToggle ^= 1;
    this.beatRingEl.dataset['pulse'] = String(this._beatPulseToggle);
  }

  /** True iff the beat ring is currently shown (at least one pulse fired). */
  get beatRingActive(): boolean {
    return !this.beatRingEl.hidden;
  }

  /**
   * Schedule a per-note FLASH drawn ON the impacting shape at `playAtServerTime`
   * (spec §7.8 — color-coded per player; the note lands on-screen at the SAME
   * server time the note sounds). The flash is scheduled through the injected
   * `schedule` (C3 `scheduleAt`-shaped: `(fireAtServerTime, cb) → { cancel }`) so
   * it appears exactly when the note plays — not on receipt. Returns the handle so
   * the caller can cancel (e.g. on a late/dropped note). The flash element is
   * appended when the callback fires and auto-removed after a short lifetime.
   *
   * §6.1 attribution redundancy audit (C22.5): the note is attributed to the
   * IMPACTING SHAPE (never a raw player callsign — MUSIC_NOTE carries no player
   * id on the wire; see the C18 report concern that impacts are attributed to
   * `shapeId` when no grabber is present), so `shapeId` is the per-entity identity
   * token here (rendered as `data-shape`, the same identity the stage already maps
   * to a screen position). `pattern` is an EXPLICIT token (defaults 'solid', mirrors
   * {@link LowerThird}'s vocabulary) that always accompanies the color via
   * `data-pattern` — the color is never the only signal, even for two simultaneous
   * flashes sharing a `colorHex`.
   */
  flashNoteOnShape(
    note: {
      shapeId: string;
      colorHex: string;
      playAtServerTime: number;
      /** §6.1: a pattern token alongside color (never omitted — defaults 'solid'). */
      pattern?: 'solid' | 'stripe' | 'dot' | 'grid';
    },
    schedule: (fireAtServerTime: number, cb: () => void) => { cancel(): void },
    lifetimeMs = 220
  ): { cancel(): void } {
    return schedule(note.playAtServerTime, () => {
      const flash = this.doc.createElement('div');
      flash.className = 'note-flash';
      flash.dataset['role'] = 'note-flash';
      // Per-entity identity (§6.1): the shape id the flash rides ON — a colorblind
      // viewer can identify WHICH note fired without relying on color at all.
      flash.dataset['shape'] = note.shapeId;
      // Color-coded per player: expose the color as a data attr AND as inline
      // color so CSS can position/animate it OVER the shape (the stage maps the
      // shape id → screen position; the color is never the ONLY signal — the
      // flash geometry/motion reads sound-off).
      flash.dataset['color'] = note.colorHex;
      flash.style.color = note.colorHex;
      flash.style.backgroundColor = note.colorHex;
      // Pattern redundancy (§6.1): an explicit token CSS renders alongside the
      // color (same convention as the lower-third swatch) — always present.
      flash.dataset['pattern'] = note.pattern ?? 'solid';
      this.noteFlashEl.appendChild(flash);
      // Auto-remove after the flash lifetime (best-effort; jsdom has setTimeout).
      const g = (this.doc.defaultView ?? globalThis) as { setTimeout?: typeof setTimeout };
      if (typeof g.setTimeout === 'function') {
        g.setTimeout(() => flash.parentNode?.removeChild(flash), lifetimeMs);
      }
    });
  }

  // ---- C19 F12 Supernova Encore constellation mirror (spec §7.13) ----------

  /** The phone count at which the constellation is "complete" (spec §7.13). */
  static readonly CONSTELLATION_COMPLETE_AT = 5;

  /**
   * Update the big-screen constellation mirror (spec §7.13): a field of stars —
   * one per participating phone — that COMPLETES at 5 phones, plus a charge bar
   * driven by the coalesced CHARGE_STATE (0–100 %). Idempotent; renders exactly
   * `phoneCount` stars (capped for legibility) and sets `data-complete` at ≥ 5.
   *
   * @param phoneCount  live charging phones (crowd size).
   * @param chargePct   0..100 normalized charge (from CHARGE_STATE / 200 × 100).
   */
  updateConstellation(phoneCount: number, chargePct: number): void {
    this.constellationEl.hidden = false;
    const stars = Math.max(0, Math.floor(phoneCount));
    const capped = Math.min(stars, 64); // legibility cap — never a starfield DoS
    // Re-render the star field to match the live phone count (cheap: ≤ 64 nodes).
    if (this.constellationStarsEl.childElementCount !== capped) {
      this.constellationStarsEl.textContent = '';
      for (let i = 0; i < capped; i++) {
        const star = this.doc.createElement('div');
        star.className = 'constellation-star';
        star.dataset['role'] = 'constellation-star';
        // A deterministic spread so the mirror looks like a constellation, not a
        // grid (pure — no Math.random; a golden-angle walk spreads the points).
        const angle = (i * 137.5) % 360;
        const radius = 20 + ((i * 13) % 30);
        star.style.left = `${50 + radius * Math.cos((angle * Math.PI) / 180)}%`;
        star.style.top = `${50 + radius * Math.sin((angle * Math.PI) / 180)}%`;
        this.constellationStarsEl.appendChild(star);
      }
    }
    this.constellationEl.dataset['phones'] = String(stars);
    this.constellationEl.dataset['complete'] =
      stars >= StageOverlays.CONSTELLATION_COMPLETE_AT ? '1' : '0';
    const pct = Math.max(0, Math.min(100, Math.round(chargePct)));
    this.constellationChargeEl.style.width = `${pct}%`;
    this.constellationChargeEl.dataset['charge'] = String(pct);
  }

  /** True iff the constellation mirror is currently shown (encore armed). */
  get constellationActive(): boolean {
    return !this.constellationEl.hidden;
  }

  /** Hide the constellation mirror (encore END). */
  hideConstellation(): void {
    this.constellationEl.hidden = true;
  }

  // ---- C31 (F20 Neon Clip Machine, §7.20) — STATS/RESET take-home card ------

  /** The take-home card copy exposed for callers/tests (spec §7.20). */
  static readonly CLIP_TAKE_HOME_HEADLINE = CLIP_TAKE_HOME_HEADLINE;
  /** The take-home card on-screen duration exposed for callers/tests (spec §7.20 ~20 s). */
  static readonly CLIP_TAKE_HOME_CARD_MS = CLIP_TAKE_HOME_CARD_MS;

  /**
   * Show the "SCAN TO TAKE YOUR CLIP HOME" card at STATS/RESET (spec §7.20 — the
   * on-stage CTA that the §7.20 review found was NEVER wired). Renders the mandated
   * headline (+ the optional retrieval URL for the QR raster) and auto-clears after
   * `CLIP_TAKE_HOME_CARD_MS`. Idempotent: a re-show resets the timer. The auto-hide
   * uses the document's own view timer so it works under jsdom.
   *
   * @param url  optional GET /api/clips/:id retrieval URL the QR encodes.
   * @param durationMs  override the on-screen duration (defaults to the spec ~20 s).
   */
  showClipTakeHomeCard(url?: string | null, durationMs: number = CLIP_TAKE_HOME_CARD_MS): void {
    if (this._clipTakeHomeTimer !== null) {
      this._clearClipTakeHomeTimer();
    }
    this.clipTakeHomeEl.hidden = false;
    this.clipTakeHomeHeadlineEl.textContent = CLIP_TAKE_HOME_HEADLINE;
    if (url) {
      this.clipTakeHomeUrlEl.hidden = false;
      this.clipTakeHomeUrlEl.textContent = url;
      this.clipTakeHomeEl.dataset['url'] = url;
    } else {
      this.clipTakeHomeUrlEl.hidden = true;
      this.clipTakeHomeUrlEl.textContent = '';
      delete this.clipTakeHomeEl.dataset['url'];
    }
    const g = (this.doc.defaultView ?? globalThis) as { setTimeout?: typeof setTimeout };
    if (typeof g.setTimeout === 'function' && durationMs > 0) {
      this._clipTakeHomeTimer = g.setTimeout(() => this.hideClipTakeHomeCard(), durationMs);
    }
  }

  /** Hide + reset the take-home card (rotation boundary / manual clear). Idempotent. */
  hideClipTakeHomeCard(): void {
    this._clearClipTakeHomeTimer();
    this.clipTakeHomeEl.hidden = true;
    this.clipTakeHomeHeadlineEl.textContent = '';
    this.clipTakeHomeUrlEl.textContent = '';
    delete this.clipTakeHomeEl.dataset['url'];
  }

  /** True iff the take-home card is currently shown. */
  get clipTakeHomeActive(): boolean {
    return !this.clipTakeHomeEl.hidden;
  }

  /** The take-home card headline text ('' when hidden). For tests. */
  clipTakeHomeText(): string {
    return this.clipTakeHomeEl.hidden ? '' : this.clipTakeHomeHeadlineEl.textContent ?? '';
  }

  private _clearClipTakeHomeTimer(): void {
    if (this._clipTakeHomeTimer !== null) {
      const g = (this.doc.defaultView ?? globalThis) as { clearTimeout?: typeof clearTimeout };
      if (typeof g.clearTimeout === 'function') g.clearTimeout(this._clipTakeHomeTimer);
      this._clipTakeHomeTimer = null;
    }
  }

  /** Detach the overlay root from its parent (kiosk teardown / reload). */
  dispose(): void {
    this.root.parentNode?.removeChild(this.root);
  }
}
