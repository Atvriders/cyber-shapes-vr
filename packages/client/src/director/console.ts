/**
 * director/console.ts — the F2 Showrunner director console (C10, spec §7.2).
 * `?mode=director`. A DOM-ONLY page (no three) — the staff control surface for
 * the self-running booth show.
 *
 * DUAL CONTROL SURFACE (spec §7.2):
 *   • Big-screen laptop KEYBOARD hotkeys are PRIMARY: Space = next phase,
 *     F = fire finale, H = hold +60 s, R = reset, P = panic. (Per the C10 brief:
 *     Space/F/H/R + the panic key.)
 *   • The staff PHONE is a convenience: fully STATELESS — it re-renders purely
 *     from PHASE_STATE + the CUE_CATALOG + the roster snapshot on every
 *     (re)connect, keeps a Screen Wake Lock, and auto-reconnects.
 *
 * TWO-TIER UI (spec §7.2): the SHOW tab is three giant buttons (Next Phase /
 * Fire Finale / Hold +60 s) + the roster; everything else is behind ADVANCED.
 * Destructive cues CONFIRM; nothing else does. `wrongPhase`/`cooldown` render as
 * DISABLED states. Roster rows show tier + join provenance (+ rttMs) and expose
 * per-peer MUTE + "disconnect" (KICK). The PANIC key lives on both surfaces.
 *
 * The server FIRE HANDLER + PHASE_STATE fan-out live in the server (C10 wired the
 * live host); the server-side PANIC glyph/name suppression HANDLER lands in C12 —
 * this console wires the TRIGGER (a PANIC director-cmd).
 *
 * The render logic (tab split + confirm + disabled) is the pure `buildConsoleModel`
 * from shared; this module is the thin DOM shell + the WS transport + hotkeys.
 */

import {
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  buildConsoleModel,
  type ServerMsg,
  type ConsoleModel,
  type CueCatalogEntry,
  type StatsCard,
} from '@cyber-shapes/shared';
import { keepScreenAwake, type WakeLockHandle } from '../funnel/wakeLock.js';

// ---------------------------------------------------------------------------
// The three SHOW-tab giant buttons (spec §7.2) — timeline controls, not cues.
// ---------------------------------------------------------------------------

/** A SHOW-tab timeline control button (the three giant buttons). */
export interface ShowControl {
  key: string;
  label: string;
  cmd: string;
  /** Extra director-cmd fields (e.g. HOLD's holdMs, FIRE's cueId). */
  extra?: Record<string, unknown>;
  /** True iff this control confirms before firing (Fire Finale is destructive-ish). */
  confirm?: boolean;
}

/** The default keyboard hotkey → director-cmd map (spec §7.2 / C10 brief). */
export const HOTKEY_COMMANDS: Record<string, ShowControl> = {
  ' ': { key: 'Space', label: 'NEXT PHASE', cmd: 'ADVANCE' },
  Spacebar: { key: 'Space', label: 'NEXT PHASE', cmd: 'ADVANCE' }, // legacy key name
  f: { key: 'F', label: 'FIRE FINALE', cmd: 'FINALE', confirm: true }, // jump to FINALE
  h: { key: 'H', label: 'HOLD +60s', cmd: 'HOLD', extra: { holdMs: 60_000 } },
  r: { key: 'R', label: 'RESET', cmd: 'RESET', confirm: true },
  p: { key: 'P', label: 'PANIC', cmd: 'PANIC' },
};

/** The three giant SHOW-tab buttons (spec §7.2). */
export const SHOW_CONTROLS: readonly ShowControl[] = [
  { key: 'Space', label: 'NEXT PHASE', cmd: 'ADVANCE' },
  { key: 'F', label: 'FIRE FINALE', cmd: 'FINALE', confirm: true },
  { key: 'H', label: 'HOLD +60s', cmd: 'HOLD', extra: { holdMs: 60_000 } },
];

// ---------------------------------------------------------------------------
// Console state (all re-derivable from the server — the phone is stateless).
// ---------------------------------------------------------------------------

interface RosterEntry {
  id: string;
  callsign: string;
  tier: string;
  entryRoute: string;
  joinedAt: number;
  rttMs?: number;
}

export interface ConsoleOpts {
  /** Room id (from `/r/:roomId` or `?room=`). */
  room: string;
  /** The staff ownerToken — rides the join payload (§5.4). NEVER logged/in-URL in prod. */
  ownerToken?: string;
  /** wss endpoint. Defaults to same-origin `/ws`. */
  wsUrl?: string;
  /** Injected WebSocket ctor (tests stub). Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Injected clock (ms) for cooldown countdown + FIRE instance ids. */
  now?: () => number;
  /** Disable the Wake Lock (tests). Default false (acquire on connect). */
  noWakeLock?: boolean;
}

/**
 * The director console. Constructing it builds the DOM shell; `connect()` opens
 * the socket. Everything renders from server messages — a kill/rejoin resumes
 * with zero local state (the stateless-phone requirement).
 */
export class DirectorConsole {
  readonly root: HTMLElement;

  private readonly doc: Document;
  private readonly opts: ConsoleOpts;
  private readonly now: () => number;

  private ws: WebSocket | null = null;
  private disposed = false;
  private reconnectAttempt = 0;
  private wakeLock: WakeLockHandle | null = null;

  // Server-derived state (the stateless snapshot).
  private phase = 'ATTRACT';
  private remainingMs: number | null = null;
  private catalog: CueCatalogEntry[] = [];
  /**
   * cueId → the `now()` timestamp of the last SERVER-ACKNOWLEDGED successful FIRE
   * (a `director-msg` ACK with `fireResult: 'ok'`). The remaining cooldown is
   * recomputed on every render from `catalog[id].cooldownMs − (now() − firedAt)`
   * — never a locally-guessed duration, and never rewound by a duplicate/rejected
   * ACK (cooldown/wrongPhase/deduped) for the same cue (carry #6).
   */
  private firedAt = new Map<string, number>();
  private roster: RosterEntry[] = [];
  private lastStats: StatsCard | null = null;

  // DOM regions.
  private readonly tabBar: HTMLElement;
  private readonly showTabEl: HTMLElement;
  private readonly advancedTabEl: HTMLElement;
  private readonly rosterEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private activeTab: 'show' | 'advanced' = 'show';

  constructor(doc: Document, opts: ConsoleOpts) {
    this.doc = doc;
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());

    this.root = doc.createElement('div');
    this.root.className = 'director-console';
    this.root.setAttribute('data-role', 'director-console');

    this.phaseEl = this.mk('dc-phase', 'phase');
    this.statusEl = this.mk('dc-status', 'status');
    this.tabBar = this.mk('dc-tabbar', 'tabbar');
    this.showTabEl = this.mk('dc-tab dc-show', 'show-tab');
    this.advancedTabEl = this.mk('dc-tab dc-advanced', 'advanced-tab');
    this.statsEl = this.mk('dc-stats', 'stats');
    this.rosterEl = this.mk('dc-roster', 'roster');

    this.buildTabBar();
    this.render();
  }

  private mk(className: string, role: string): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = className;
    el.dataset['role'] = role;
    this.root.appendChild(el);
    return el;
  }

  private buildTabBar(): void {
    for (const tab of ['show', 'advanced'] as const) {
      const btn = this.doc.createElement('button');
      btn.className = 'dc-tab-btn';
      btn.dataset['tab'] = tab;
      btn.textContent = tab === 'show' ? 'SHOW' : 'ADVANCED';
      btn.addEventListener('click', () => {
        this.activeTab = tab;
        this.render();
      });
      this.tabBar.appendChild(btn);
    }
  }

  // ---- WS transport -------------------------------------------------------

  private resolveWsUrl(): string {
    if (this.opts.wsUrl) return this.opts.wsUrl;
    const loc = (globalThis as unknown as { location?: { protocol: string; host: string } })
      .location ?? { protocol: 'https:', host: 'localhost' };
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc.host}/ws`;
  }

  /** Open the director socket + start the (stateless) handshake. Idempotent. */
  connect(): void {
    if (this.disposed || this.ws) return;
    const WS =
      this.opts.WebSocketImpl ??
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    const ws = new WS(this.resolveWsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      const join: Record<string, unknown> = {
        t: 'join',
        room: this.opts.room,
        name: 'director',
        color: 0,
        protocol: PROTOCOL_VERSION,
        tier: 'director',
      };
      if (this.opts.ownerToken !== undefined) join['ownerToken'] = this.opts.ownerToken;
      ws.send(encodeText(join as never));
      this.reconnectAttempt = 0;
      // Staff phone convenience: keep the screen awake (best-effort, degrades).
      if (!this.opts.noWakeLock && !this.wakeLock) {
        this.wakeLock = keepScreenAwake();
      }
      this.setStatus('CONNECTED');
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return; // no binary on the console bus
      let msg: ServerMsg;
      try {
        msg = decodeText(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.setStatus('RECONNECTING…');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close follows; reconnect from there */
    };
  }

  /** Apply one server message (the stateless re-render source). */
  handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'phase-state':
        this.phase = msg.phase;
        this.remainingMs = msg.remainingMs;
        this.render();
        break;
      case 'director-msg':
        if (msg.kind === 'CATALOG' && msg.catalog) {
          this.catalog = msg.catalog as unknown as CueCatalogEntry[];
          this.render();
        } else if (msg.kind === 'ACK' && typeof msg.cueId === 'string') {
          // A FIRE echo: flash the result (a cooldown/wrongPhase disables the button
          // until the next catalog/phase-state refresh).
          this.setStatus(`FIRE ${msg.cueId}: ${msg.fireResult ?? 'ok'}`);
          // Carry #6: a SUCCESSFUL fire (the real server signal) arms the cooldown
          // pill — record the fired-at instant so the disabled state + countdown
          // re-derive on every render. A rejected/deduped echo (cooldown/wrongPhase/
          // deduped) must NEVER (re)arm it — that would rewind an already-running
          // countdown or fake one for a fire that never actually happened.
          if (msg.fireResult === 'ok') this.firedAt.set(msg.cueId, this.now());
          this.render();
        } else if (msg.kind === 'PANIC') {
          this.setStatus('PANIC — name/glyph surfaces hidden');
        }
        break;
      case 'roster':
        this.roster = msg.entries;
        this.render();
        break;
      case 'stats-card':
        this.lastStats = {
          shapesThrown: msg.shapesThrown,
          fastestThrow: msg.fastestThrow,
          topContributor: msg.topContributor,
          dayLeaderboard: msg.dayLeaderboard,
          nextInHeadset: msg.nextInHeadset,
        };
        this.render();
        break;
      default:
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delays = [500, 1000, 2000, 5000, 10000];
    const i = Math.min(this.reconnectAttempt, delays.length - 1);
    this.reconnectAttempt += 1;
    const timer = (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout;
    timer(() => this.connect(), delays[i]);
  }

  // ---- Commands -----------------------------------------------------------

  /** Send a raw director-cmd (used by hotkeys, buttons, roster ops). */
  sendCmd(cmd: string, extra: Record<string, unknown> = {}): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(encodeText({ t: 'director-cmd', cmd, ...extra } as never));
  }

  /**
   * Fire a CUE_CATALOG cue. Generates a client-side cueInstanceId (the server
   * dedupes on it — a double-tap is idempotent). A DESTRUCTIVE cue must be
   * pre-confirmed by the caller (the button/hotkey path calls confirmThenFire).
   */
  fireCue(cueId: string): void {
    this.sendCmd('FIRE', { cueId, cueInstanceId: `dir:${cueId}:${this.now()}` });
  }

  /** The window.confirm gate a destructive control passes through before firing. */
  private confirmGate(label: string): boolean {
    const win = this.doc.defaultView ?? (globalThis as unknown as Window);
    const c = (win as unknown as { confirm?: (m: string) => boolean }).confirm;
    // No confirm() available (SSR/test) → treat as confirmed only when explicitly
    // driven; here default to false so a destructive action never fires silently.
    if (typeof c !== 'function') return false;
    return c(`Confirm: ${label}?`);
  }

  /** Fire a cue, confirming first iff it is destructive (spec §7.2). */
  fireCueWithConfirm(entry: CueCatalogEntry): void {
    if (entry.destructive && !this.confirmGate(entry.label)) return;
    this.fireCue(entry.id);
  }

  /** Run a SHOW/hotkey control, confirming first iff it is a destructive control. */
  runControl(control: ShowControl): void {
    if (control.confirm && !this.confirmGate(control.label)) return;
    this.sendCmd(control.cmd, control.extra ?? {});
  }

  // ---- Keyboard hotkeys (laptop primary surface) --------------------------

  /**
   * Handle a keydown: map it to a director-cmd (Space/F/H/R/P). Returns the
   * command run, or null for an unbound key. Exported behavior for the test.
   */
  onKey(key: string): string | null {
    const control = HOTKEY_COMMANDS[key] ?? HOTKEY_COMMANDS[key.toLowerCase()];
    if (!control) return null;
    this.runControl(control);
    return control.cmd;
  }

  /** Bind the keyboard hotkeys to the document (call once on the real page). */
  bindHotkeys(): void {
    this.doc.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ignore keystrokes while typing in an input (defensive; the console has none).
      const cmd = this.onKey(e.key);
      if (cmd) e.preventDefault();
    });
  }

  // ---- Roster ops (per-peer mute / disconnect) ----------------------------

  mutePeer(peerId: string): void {
    this.sendCmd('MUTE', { targetId: peerId });
  }
  unmutePeer(peerId: string): void {
    this.sendCmd('UNMUTE', { targetId: peerId });
  }
  /** "Disconnect" is the KICK cmd (the UI copy is "disconnect" — spec §7.2). */
  disconnectPeer(peerId: string): void {
    this.sendCmd('KICK', { targetId: peerId });
  }
  refreshRoster(): void {
    this.sendCmd('ROSTER');
  }

  // ---- Panic (both surfaces) ----------------------------------------------

  /** The staff PANIC trigger (console key + stage hotkey). Server handler = C12. */
  panic(): void {
    this.sendCmd('PANIC');
  }

  // ---- Render -------------------------------------------------------------

  /** Build the pure console model from the advertised catalog + live phase. */
  model(): ConsoleModel {
    return buildConsoleModel(this.catalog, this.phase as never, (id) => this.cooldownRemainingMs(id));
  }

  /**
   * The LIVE remaining cooldown (ms) for a cue: `catalog[id].cooldownMs − (now() −
   * firedAt)`, clamped to 0. Recomputed fresh on every call — never a stale stored
   * number — so it naturally ticks down (and clears) across the ~1 Hz PHASE_STATE
   * re-renders with no separate interval/timer (carry #6).
   */
  private cooldownRemainingMs(id: string): number {
    const firedAt = this.firedAt.get(id);
    if (firedAt === undefined) return 0;
    const cooldownMs = this.catalog.find((c) => c.id === id)?.cooldownMs ?? 0;
    return Math.max(0, cooldownMs - (this.now() - firedAt));
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private render(): void {
    // Phase header.
    const remain =
      this.remainingMs === null ? '∞' : `${Math.max(0, Math.ceil(this.remainingMs / 1000))}s`;
    this.phaseEl.textContent = `${this.phase} — ${remain}`;
    this.phaseEl.dataset['phase'] = this.phase;

    // Active tab styling.
    for (const btn of Array.from(this.tabBar.querySelectorAll<HTMLElement>('.dc-tab-btn'))) {
      btn.dataset['active'] = String(btn.dataset['tab'] === this.activeTab);
    }
    this.showTabEl.hidden = this.activeTab !== 'show';
    this.advancedTabEl.hidden = this.activeTab !== 'advanced';

    this.renderShowTab();
    this.renderAdvancedTab();
    this.renderStats();
    this.renderRoster();
  }

  /**
   * Render the STATS_CARD (spec §7.2) — CALLSIGNS ONLY. Shown during STATS; the
   * numeric stats are fine on the console (a staff surface); the in-headset
   * countdown is the environmental red-pulse+klaxon (that lives on the headset,
   * not here). No raw name is ever rendered — only server-assigned callsigns.
   */
  private renderStats(): void {
    this.statsEl.textContent = '';
    const s = this.lastStats;
    // Only surface the card during the STATS phase (it's the STATS-phase payload).
    if (!s || this.phase !== 'STATS') {
      this.statsEl.hidden = true;
      return;
    }
    this.statsEl.hidden = false;
    const line = (label: string, value: string): void => {
      const el = this.doc.createElement('div');
      el.className = 'dc-stat-line';
      el.textContent = `${label}: ${value}`;
      this.statsEl.appendChild(el);
    };
    line('SHAPES THROWN', String(s.shapesThrown));
    if (s.topContributor) line('TOP', `${s.topContributor.callsign} (${s.topContributor.value})`);
    if (s.fastestThrow) line('FASTEST', `${s.fastestThrow.callsign} (${s.fastestThrow.value} m/s)`);
    if (s.nextInHeadset) line('QUEUE', s.nextInHeadset);
    for (const row of s.dayLeaderboard) line('DAY', `${row.callsign} (${row.value})`);
  }

  private renderShowTab(): void {
    this.showTabEl.textContent = '';
    // The three GIANT timeline buttons (spec §7.2).
    const controls = this.doc.createElement('div');
    controls.className = 'dc-show-controls';
    for (const c of SHOW_CONTROLS) {
      const btn = this.doc.createElement('button');
      btn.className = 'dc-giant-btn';
      btn.dataset['cmd'] = c.cmd;
      if (c.confirm) btn.dataset['confirm'] = 'true';
      btn.textContent = `${c.label} (${c.key})`;
      btn.addEventListener('click', () => this.runControl(c));
      controls.appendChild(btn);
    }
    this.showTabEl.appendChild(controls);

    // SHOW-tab cues (the seed shape-rain / low-g land here) rendered as big buttons.
    const model = this.model();
    for (const row of model.show) {
      this.showTabEl.appendChild(this.cueButton(row));
    }
  }

  private renderAdvancedTab(): void {
    this.advancedTabEl.textContent = '';
    const model = this.model();
    for (const row of model.advanced) {
      this.advancedTabEl.appendChild(this.cueButton(row));
    }
  }

  /** Render one cue button with its disabled/confirm/cooldown state. */
  private cueButton(row: ConsoleModel['show'][number]): HTMLElement {
    const btn = this.doc.createElement('button');
    btn.className = 'dc-cue-btn';
    btn.dataset['cueId'] = row.id;
    btn.disabled = row.disabled;
    if (row.disabled) btn.dataset['disabled'] = row.disabledReason ?? 'true';
    if (row.destructive) btn.dataset['destructive'] = 'true';
    const cd =
      row.cooldownRemainingMs > 0 ? ` (${Math.ceil(row.cooldownRemainingMs / 1000)}s)` : '';
    const tag = row.disabled ? ` [${row.disabledReason}]` : '';
    btn.textContent = `${row.label}${cd}${tag}`;
    btn.addEventListener('click', () => {
      const entry = this.catalog.find((c) => c.id === row.id);
      if (entry) this.fireCueWithConfirm(entry);
    });
    return btn;
  }

  private renderRoster(): void {
    this.rosterEl.textContent = '';
    for (const p of this.roster) {
      const rowEl = this.doc.createElement('div');
      rowEl.className = 'dc-roster-row';
      rowEl.dataset['peerId'] = p.id;
      rowEl.dataset['tier'] = p.tier;

      const label = this.doc.createElement('span');
      label.className = 'dc-roster-label';
      const rtt = typeof p.rttMs === 'number' ? ` · ${p.rttMs}ms` : '';
      // Callsign + tier + provenance (+ rttMs) — callsign only, never a raw name.
      label.textContent = `${p.callsign} · ${p.tier} · ${p.entryRoute}${rtt}`;
      rowEl.appendChild(label);

      const mute = this.doc.createElement('button');
      mute.className = 'dc-roster-mute';
      mute.textContent = 'mute';
      mute.addEventListener('click', () => this.mutePeer(p.id));
      rowEl.appendChild(mute);

      const kick = this.doc.createElement('button');
      kick.className = 'dc-roster-kick';
      kick.textContent = 'disconnect';
      kick.addEventListener('click', () => this.disconnectPeer(p.id));
      rowEl.appendChild(kick);

      this.rosterEl.appendChild(rowEl);
    }
  }

  // ---- Accessors (tests) --------------------------------------------------

  get currentPhase(): string {
    return this.phase;
  }
  get currentCatalog(): CueCatalogEntry[] {
    return this.catalog;
  }
  get currentRoster(): RosterEntry[] {
    return this.roster;
  }
  get currentStats(): StatsCard | null {
    return this.lastStats;
  }
  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.wakeLock?.release();
    this.wakeLock = null;
    this.root.parentNode?.removeChild(this.root);
  }
}

// ---------------------------------------------------------------------------
// Boot (real page only). Skipped under tests / SSR (no #director-root).
// ---------------------------------------------------------------------------

function parseConsoleParams(href: string): { room: string; ownerToken?: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const m = /\/r\/([^/?#]+)/.exec(url.pathname);
  const room = m ? decodeURIComponent(m[1]) : url.searchParams.get('room') ?? '';
  if (!room) return null;
  const ownerToken = url.searchParams.get('ownerToken') ?? undefined;
  return { room, ownerToken };
}

const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.(
    'director-root'
  ) ?? null;

if (bootRoot) {
  const doc = (globalThis as unknown as { document: Document }).document;
  const href = (globalThis as unknown as { location?: { href: string } }).location?.href ?? '';
  const params = parseConsoleParams(href);
  if (params) {
    const console_ = new DirectorConsole(doc, {
      room: params.room,
      ownerToken: params.ownerToken,
    });
    bootRoot.appendChild(console_.root);
    console_.bindHotkeys();
    console_.connect();
    const win = doc.defaultView ?? (globalThis as unknown as Window);
    win.addEventListener('beforeunload', () => console_.dispose());
  }
}
