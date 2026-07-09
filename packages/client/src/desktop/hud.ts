/**
 * desktop/hud.ts — the F22 Desktop Command DOM HUD overlay (spec §7.22, plan C33).
 *
 * A DOM overlay (NOT in-canvas) that gives the desktop resident a first-class view:
 *   • phase + countdown — EXTRAPOLATED from `PHASE_STATE.remainingMs` (drift-proof:
 *     the countdown is `remainingMs − (now − receivedAt)`, no clock-offset dep);
 *   • laws-in-effect chip — the STANDING elected law (from `baseParams`);
 *   • roster panel — callsigns + tiers, and NEVER `rttMs` (that stays a director/
 *     spectator surface per the §5.1 footnote — residents never receive it anyway);
 *   • election BALLOT widget — VOTE_OPEN options + a live tally; a tap emits ONE
 *     SWITCHABLE VOTE_CAST (the host keys the resident on peerId — §5.1 voterKey);
 *   • showpiece / cue banner mirror (driven by ENV_STATE cue text);
 *   • `?` help overlay rendering the COMPLETE keymap (help.ts).
 *
 * ── XR INERTNESS ── `setHidden(true)` hides the whole HUD; main.ts calls it while
 * `renderer.xr.isPresenting` so nothing paints over the headset view (spec §7.22).
 *
 * DOM-only. No THREE. Testable under jsdom (desktop.dom.test.ts).
 */

import { renderHelp } from './help.js';

/** A tiny effective-physics shape the laws chip reads to describe the standing law. */
export interface LawParams {
  gravity?: { x: number; y: number; z: number };
  timescale?: number;
  freeze?: boolean;
  wind?: { x: number; y: number; z: number };
}

/**
 * A human-legible name for a STANDING law (spec §7.5 laws-in-effect). PURE — a
 * small deterministic classifier over the base PhysicsParams (mirrors the ballot's
 * `describeLaw`, kept local so the desktop HUD never statically imports the phone
 * funnel chunk into the main bundle). The default (inert) base reads NORMAL PHYSICS.
 */
export function describeLaw(params: LawParams | null | undefined): string {
  if (!params) return 'NORMAL PHYSICS';
  if (params.freeze === true) return 'FROZEN WORLD';
  const gy = params.gravity?.y ?? -5;
  if (gy > 0) return 'CEILING GRAVITY';
  if (gy > -3) return 'LOW GRAVITY';
  if ((params.timescale ?? 1) < 1) return 'SLOW-MO WORLD';
  const w = params.wind;
  if (w && (Math.abs(w.x) > 0.001 || Math.abs(w.y) > 0.001 || Math.abs(w.z) > 0.001))
    return 'NEON STORM';
  return 'NORMAL PHYSICS';
}

/** Map a dial cue id → its standing-law label (for the elected VOTE_RESULT winner). */
const DIAL_LAW_LABEL: Record<string, string> = {
  'low-g': 'LOW GRAVITY',
  'gravity-flip': 'CEILING GRAVITY',
  'bullet-time': 'SLOW-MO WORLD',
  'neon-storm': 'NEON STORM',
  singularity: 'SINGULARITY',
};

/** A short, tap-friendly label for a ballot option (dial cue id). */
function optionLabel(id: string): string {
  return DIAL_LAW_LABEL[id] ?? id.replace(/-/g, ' ').toUpperCase();
}

/** The VOTE ServerMsg kinds (mirror of shared VOTE_KIND — kept inline, no import churn). */
const VKIND = { OPEN: 0, CAST: 1, TALLY: 2, RESULT: 3 } as const;

/** A phase-state snapshot the HUD extrapolates the countdown from. */
export interface PhaseSnapshot {
  phase: string;
  remainingMs: number | null;
}

/** A roster entry the HUD renders (callsign + tier only — NO rttMs on desktop). */
export interface RosterEntry {
  id: string;
  callsign: string;
  tier: string;
  entryRoute?: string;
  joinedAt?: number;
  /** Present on the wire (director/spectator surface) but NEVER rendered here. */
  rttMs?: number;
}

/** A `vote` ServerMsg the ballot widget consumes (OPEN / TALLY / RESULT). */
export interface VoteSnapshot {
  kind: number;
  options?: string[];
  tally?: Record<string, number>;
  winner?: string | null;
}

export interface DesktopHudOpts {
  /** Called when the resident taps a ballot option — the host sends the vote-cast. */
  onVoteCast: (option: string) => void;
  /** Injectable clock (ms) for the drift-proof countdown. Defaults to performance.now. */
  now?: () => number;
}

/**
 * The desktop HUD. Construct it, append `.root` to the page overlay, then drive it
 * with the setters as server messages arrive; call `tick()` each frame to repaint
 * the extrapolated countdown.
 */
export class DesktopHud {
  readonly root: HTMLElement;
  private readonly doc: Document;
  private readonly onVoteCast: (option: string) => void;
  private readonly now: () => number;

  // Sub-elements.
  private readonly phaseEl: HTMLElement;
  private readonly countdownEl: HTMLElement;
  private readonly lawsEl: HTMLElement;
  private readonly rosterEl: HTMLElement;
  private readonly cueBannerEl: HTMLElement;
  private readonly voteWidget: HTMLElement;
  private readonly voteOptions: HTMLElement;
  private readonly helpEl: HTMLElement;

  // State for the drift-proof countdown extrapolation.
  private phase = '';
  private remainingAtReceiptMs: number | null = null;
  private receivedAtMs = 0;

  // Ballot state (one switchable vote).
  private currentOptions: string[] = [];
  private myVote: string | null = null;

  private helpOpen = false;

  constructor(doc: Document, opts: DesktopHudOpts) {
    this.doc = doc;
    this.onVoteCast = opts.onVoteCast;
    this.now = opts.now ?? (() => performance.now());

    const root = doc.createElement('div');
    root.className = 'desktop-hud';
    root.dataset['role'] = 'desktop-hud';
    this.root = root;

    // --- Top bar: phase + countdown + laws chip + cue banner. ---------------
    const topbar = doc.createElement('div');
    topbar.className = 'desktop-hud-topbar';

    this.phaseEl = doc.createElement('span');
    this.phaseEl.className = 'desktop-hud-phase';
    this.phaseEl.dataset['role'] = 'phase';
    topbar.appendChild(this.phaseEl);

    this.countdownEl = doc.createElement('span');
    this.countdownEl.className = 'desktop-hud-countdown';
    this.countdownEl.dataset['role'] = 'countdown';
    this.countdownEl.dataset['seconds'] = '';
    topbar.appendChild(this.countdownEl);

    this.lawsEl = doc.createElement('span');
    this.lawsEl.className = 'desktop-hud-laws';
    this.lawsEl.dataset['role'] = 'laws';
    this.lawsEl.textContent = 'LAW: NORMAL PHYSICS';
    topbar.appendChild(this.lawsEl);

    root.appendChild(topbar);

    this.cueBannerEl = doc.createElement('div');
    this.cueBannerEl.className = 'desktop-hud-cue';
    this.cueBannerEl.dataset['role'] = 'cue-banner';
    this.cueBannerEl.textContent = '';
    root.appendChild(this.cueBannerEl);

    // --- Roster panel. ------------------------------------------------------
    this.rosterEl = doc.createElement('div');
    this.rosterEl.className = 'desktop-hud-roster';
    this.rosterEl.dataset['role'] = 'roster';
    root.appendChild(this.rosterEl);

    // --- Ballot widget. -----------------------------------------------------
    this.voteWidget = doc.createElement('div');
    this.voteWidget.className = 'desktop-hud-vote';
    this.voteWidget.dataset['role'] = 'vote-widget';
    this.voteWidget.hidden = true;
    const voteHeading = doc.createElement('div');
    voteHeading.className = 'desktop-hud-vote-heading';
    voteHeading.textContent = 'CHANGE THE LAW — CLICK YOUR VOTE';
    this.voteWidget.appendChild(voteHeading);
    this.voteOptions = doc.createElement('div');
    this.voteOptions.className = 'desktop-hud-vote-options';
    this.voteWidget.appendChild(this.voteOptions);
    root.appendChild(this.voteWidget);

    // --- Help overlay. ------------------------------------------------------
    this.helpEl = doc.createElement('div');
    this.helpEl.className = 'desktop-hud-help';
    this.helpEl.dataset['role'] = 'help';
    this.helpEl.hidden = true;
    renderHelp(doc, this.helpEl);
    root.appendChild(this.helpEl);
  }

  // -------------------------------------------------------------------------
  // Phase + countdown (drift-proof extrapolation from remainingMs).
  // -------------------------------------------------------------------------

  /** Record a fresh PHASE_STATE; the countdown extrapolates from remainingMs. */
  setPhaseState(snap: PhaseSnapshot): void {
    this.phase = snap.phase;
    this.remainingAtReceiptMs = snap.remainingMs;
    this.receivedAtMs = this.now();
    this.phaseEl.textContent = snap.phase;
    this.repaintCountdown();
  }

  /** Repaint the extrapolated countdown (call each frame). */
  tick(): void {
    this.repaintCountdown();
  }

  private repaintCountdown(): void {
    if (this.remainingAtReceiptMs === null) {
      this.countdownEl.textContent = '';
      this.countdownEl.dataset['seconds'] = '';
      return;
    }
    const elapsed = this.now() - this.receivedAtMs;
    const remaining = Math.max(0, this.remainingAtReceiptMs - elapsed);
    const seconds = Math.floor(remaining / 1000);
    this.countdownEl.dataset['seconds'] = String(seconds);
    this.countdownEl.textContent = `T−${seconds}s`;
  }

  // -------------------------------------------------------------------------
  // Laws-in-effect chip (from the STANDING baseParams / elected winner).
  // -------------------------------------------------------------------------

  /** Repaint the laws chip from the standing (elected) baseParams. */
  setBaseParams(params: LawParams | null | undefined): void {
    this.lawsEl.textContent = `LAW: ${describeLaw(params)}`;
  }

  // -------------------------------------------------------------------------
  // Roster (callsigns + tiers — NO rttMs).
  // -------------------------------------------------------------------------

  /** Repaint the roster panel. rttMs is deliberately NEVER rendered (§5.1 footnote). */
  setRoster(entries: RosterEntry[]): void {
    this.rosterEl.textContent = '';
    const heading = this.doc.createElement('div');
    heading.className = 'desktop-hud-roster-heading';
    heading.textContent = `ROSTER (${entries.length})`;
    this.rosterEl.appendChild(heading);
    for (const e of entries) {
      const row = this.doc.createElement('div');
      row.className = 'desktop-hud-roster-row';
      row.dataset['tier'] = e.tier;

      const cs = this.doc.createElement('span');
      cs.className = 'desktop-hud-roster-callsign';
      cs.textContent = e.callsign;
      row.appendChild(cs);

      const tier = this.doc.createElement('span');
      tier.className = 'desktop-hud-roster-tier';
      tier.textContent = e.tier.toUpperCase();
      row.appendChild(tier);
      // NOTE: e.rttMs is intentionally NOT rendered (director/spectator surface only).

      this.rosterEl.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Ballot widget (VOTE_OPEN → one switchable VOTE_CAST; RESULT closes it).
  // -------------------------------------------------------------------------

  /** Apply a `vote` ServerMsg (OPEN / TALLY / RESULT). */
  setVote(snap: VoteSnapshot): void {
    if (snap.kind === VKIND.OPEN && snap.options) {
      this.renderOptions(snap.options);
    } else if (snap.kind === VKIND.TALLY) {
      if (snap.options && this.voteWidget.hidden) this.renderOptions(snap.options);
      if (snap.tally) this.renderTally(snap.tally);
    } else if (snap.kind === VKIND.RESULT) {
      this.renderElectedLaw(snap.winner ?? null);
    }
  }

  private renderOptions(options: string[]): void {
    this.currentOptions = options;
    this.voteWidget.hidden = false;
    this.voteOptions.textContent = '';
    for (const id of options) {
      const btn = this.doc.createElement('button');
      btn.className = 'desktop-hud-vote-option';
      btn.dataset['role'] = 'vote-option';
      btn.dataset['option'] = id;
      btn.dataset['mine'] = 'false';
      btn.dataset['count'] = '0';
      btn.textContent = optionLabel(id);
      btn.addEventListener('click', () => this.castVote(id));
      this.voteOptions.appendChild(btn);
    }
    this.repaintSelection();
  }

  private renderTally(tally: Record<string, number>): void {
    for (const id of this.currentOptions) {
      const btn = this.voteOptions.querySelector(
        `[data-role="vote-option"][data-option="${cssEscape(id)}"]`
      ) as HTMLElement | null;
      if (btn) btn.dataset['count'] = String(tally[id] ?? 0);
    }
  }

  private castVote(option: string): void {
    // One SWITCHABLE vote: record the choice, repaint, and emit to the host (which
    // keys the resident on peerId — the §5.1 voterKey). No token needed on desktop.
    this.myVote = option;
    this.repaintSelection();
    this.onVoteCast(option);
  }

  private repaintSelection(): void {
    const btns = this.voteOptions.querySelectorAll('[data-role="vote-option"]');
    btns.forEach((b) => {
      const el = b as HTMLElement;
      el.dataset['mine'] = el.dataset['option'] === this.myVote ? 'true' : 'false';
    });
  }

  private renderElectedLaw(winner: string | null): void {
    const label = winner ? (DIAL_LAW_LABEL[winner] ?? optionLabel(winner)) : 'NORMAL PHYSICS';
    this.lawsEl.textContent = `LAW: ${label}`;
    // A fresh decree closes the live ballot until the next OPEN.
    this.voteWidget.hidden = true;
    this.myVote = null;
  }

  // -------------------------------------------------------------------------
  // Cue banner mirror + help overlay + visibility.
  // -------------------------------------------------------------------------

  /** Mirror the big-screen cue banner text (from ENV_STATE / showpiece). */
  setCueBanner(text: string): void {
    this.cueBannerEl.textContent = text;
  }

  /** Toggle the `?` help overlay. */
  toggleHelp(): void {
    this.helpOpen = !this.helpOpen;
    this.helpEl.hidden = !this.helpOpen;
  }

  /** Whether the ballot widget is currently showing an open election. */
  isBallotOpen(): boolean {
    return !this.voteWidget.hidden;
  }

  /** Focus / reveal the ballot (the `B` key) — no-op if there is no open election. */
  focusBallot(): void {
    if (this.currentOptions.length > 0) this.voteWidget.hidden = false;
  }

  /** Show / hide the WHOLE HUD (the XR-inertness surface — main.ts drives it). */
  setHidden(hidden: boolean): void {
    this.root.hidden = hidden;
  }

  /** Tear down (page unload). Removes the root from the DOM. */
  dispose(): void {
    this.root.remove();
  }
}

/** Escape a value for a CSS attribute selector (dial ids are simple, but safe). */
function cssEscape(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}
