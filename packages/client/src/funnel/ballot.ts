/**
 * funnel/ballot.ts — the VOTER entry (F5 Reality Referendum, spec §7.5). A
 * separate Vite entry chunk (spec §5.7 / §5.8).
 *
 * DOM-ONLY. Joins the live room on the `crowd` tier (spec §5.1 — "Ballots ride
 * crowd tier") with ZERO permissions and NEVER imports three. This is asserted by
 * the bundle-size gate (< 100 KB gz) AND the import-graph test in funnel.dom.test.ts.
 *
 * C7 shipped the entry scaffold (join-on-crowd + a "you're in" panel + Screen
 * Wake Lock). C15 lands the FULL ballot:
 *   • the NEVER-DEAD ballot (spec §7.5): between elections it shows the LAWS IN
 *     EFFECT (the standing elected law) + a tap-to-charge-next-election meter, so
 *     there is always something to press within ~2 s of scanning;
 *   • when an election OPENS, the dueling dial-id options + a live 2 Hz tally bar;
 *   • the laws-in-effect reflect the BASE (elected) law — a transient dial ENV_STATE
 *     never repaints "the law" (only the elected VOTE_RESULT winner does);
 *   • a localStorage device token (best-effort anti-stuff, documented as such).
 */

import { parseRoom } from '../net/roomLink.js';
import { joinRoom } from './join.js';
import { keepScreenAwake, type WakeLockHandle } from './wakeLock.js';

/** localStorage key for the best-effort anti-stuff device token (spec §7.5). */
const BALLOT_TOKEN_KEY = 'csv-ballot-token';

/** A tiny effective-physics shape the ballot reads to describe the standing law. */
export interface LawParams {
  gravity?: { x: number; y: number; z: number };
  timescale?: number;
  freeze?: boolean;
  wind?: { x: number; y: number; z: number };
}

/**
 * A human-legible name for a STANDING law (spec §7.5 laws-in-effect). PURE — a
 * small deterministic classifier over the base PhysicsParams. It reads the ELECTED
 * base, never a transient overlay (the caller only ever passes the base here). The
 * default (inert) base reads as "NORMAL PHYSICS"; a low gravity floats; a flipped
 * gravity is a ceiling pile; ×timescale is slow-mo.
 */
export function describeLaw(params: LawParams | null | undefined): string {
  if (!params) return 'NORMAL PHYSICS';
  const gy = params.gravity?.y ?? -5;
  if (params.freeze === true) return 'FROZEN WORLD';
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
  'singularity': 'SINGULARITY',
};

/** A short, tap-friendly label for a ballot option (dial cue id). */
function optionLabel(id: string): string {
  return DIAL_LAW_LABEL[id] ?? id.replace(/-/g, ' ').toUpperCase();
}

/** Read (or mint + persist) the best-effort device token. Never throws. */
function ensureDeviceToken(): string {
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    if (!ls) return mintToken();
    const existing = ls.getItem(BALLOT_TOKEN_KEY);
    if (existing && existing.length > 0) return existing;
    const t = mintToken();
    ls.setItem(BALLOT_TOKEN_KEY, t);
    return t;
  } catch {
    return mintToken(); // storage blocked (private mode) → ephemeral token
  }
}

/** A non-crypto device token (best-effort — the server keys on peerId anyway). */
function mintToken(): string {
  // No Math.random dependency for testability: mix time + a counter-ish salt.
  const now =
    (globalThis as unknown as { performance?: { now(): number } }).performance?.now?.() ??
    Date.now();
  return `t${Math.floor(now).toString(36)}${(now % 1).toString(36).slice(2, 6)}`;
}

/** The VOTE ServerMsg kinds (mirror of shared VOTE_KIND — kept inline, no import churn). */
const KIND = { OPEN: 0, CAST: 1, TALLY: 2, RESULT: 3 } as const;

/** Render the ballot entry into `root` and join the room on the crowd tier. */
export async function startBallotEntry(
  root: HTMLElement,
  opts: { room?: string; wsUrl?: string; WebSocketImpl?: typeof WebSocket } = {}
): Promise<{ release(): void }> {
  const doc = root.ownerDocument;
  const room =
    opts.room ??
    parseRoom(
      (globalThis as unknown as { location?: { href: string } }).location?.href ?? ''
    ) ??
    '';

  const token = ensureDeviceToken();

  root.textContent = '';
  root.className = 'funnel-ballot';

  const title = doc.createElement('div');
  title.className = 'ballot-title';
  title.textContent = 'VOTE ON THE LAWS OF PHYSICS';
  root.appendChild(title);

  const status = doc.createElement('div');
  status.className = 'ballot-status';
  status.dataset['role'] = 'status';
  status.textContent = 'CONNECTING…';
  root.appendChild(status);

  // --- Laws-in-effect (never-dead): the STANDING elected law ------------------
  const laws = doc.createElement('div');
  laws.className = 'ballot-laws';
  laws.dataset['role'] = 'laws';
  laws.textContent = 'CURRENT LAW: NORMAL PHYSICS';
  root.appendChild(laws);

  // --- Charge-next meter (something to press ≤ 2 s) ---------------------------
  const charge = doc.createElement('button');
  charge.className = 'ballot-charge';
  charge.dataset['role'] = 'charge';
  charge.dataset['charge'] = '0';
  charge.textContent = 'TAP TO CHARGE THE NEXT VOTE';
  root.appendChild(charge);

  // --- The live ballot (options + dueling bars) -------------------------------
  const ballot = doc.createElement('div');
  ballot.className = 'ballot-live';
  ballot.dataset['role'] = 'ballot';
  ballot.hidden = true;
  root.appendChild(ballot);

  let ws: WebSocket | null = null;
  let wake: WakeLockHandle | null = null;
  let chargeVal = 0;
  let currentOptions: string[] = [];
  let myVote: string | null = null;

  // The charge meter is interactive IMMEDIATELY (before any election) so the
  // recruitment hook is real: something to press within 2 s of scanning.
  charge.addEventListener('click', () => {
    chargeVal = Math.min(100, chargeVal + 20);
    charge.dataset['charge'] = String(chargeVal);
    charge.textContent =
      chargeVal >= 100 ? 'CHARGED — WAITING FOR THE NEXT VOTE' : 'TAP TO CHARGE THE NEXT VOTE';
  });

  /** Send a vote-cast for a dial-id option (one switchable vote per token). */
  function castVote(option: string): void {
    if (!ws) return;
    myVote = option;
    repaintSelection();
    try {
      ws.send(JSON.stringify({ t: 'vote-cast', option, token }));
    } catch {
      /* socket gone — surfaced on the next status update */
    }
  }

  /** Render the option buttons for an open election. */
  function renderOptions(options: string[]): void {
    currentOptions = options;
    ballot.hidden = false;
    ballot.textContent = '';
    const heading = doc.createElement('div');
    heading.className = 'ballot-heading';
    heading.textContent = 'CHANGE THE LAW — TAP YOUR VOTE';
    ballot.appendChild(heading);
    for (const id of options) {
      const row = doc.createElement('div');
      row.className = 'ballot-row';

      const btn = doc.createElement('button');
      btn.className = 'ballot-option';
      btn.dataset['role'] = 'option';
      btn.dataset['option'] = id;
      btn.textContent = optionLabel(id);
      btn.addEventListener('click', () => castVote(id));
      row.appendChild(btn);

      const bar = doc.createElement('div');
      bar.className = 'ballot-bar';
      bar.dataset['role'] = 'bar';
      bar.dataset['option'] = id;
      bar.dataset['count'] = '0';
      row.appendChild(bar);

      ballot.appendChild(row);
    }
    repaintSelection();
  }

  /** Repaint the dueling bars from a tally. */
  function renderTally(tally: Record<string, number>): void {
    const total = Object.values(tally).reduce((a, b) => a + b, 0) || 1;
    for (const id of currentOptions) {
      const bar = ballot.querySelector(
        `[data-role="bar"][data-option="${cssEscape(id)}"]`
      ) as HTMLElement | null;
      if (!bar) continue;
      const c = tally[id] ?? 0;
      bar.dataset['count'] = String(c);
      bar.style.width = `${Math.round((c / total) * 100)}%`;
    }
  }

  /** Mark the option this device backs (switchable — only one highlighted). */
  function repaintSelection(): void {
    const btns = ballot.querySelectorAll('[data-role="option"]');
    btns.forEach((b) => {
      const el = b as HTMLElement;
      el.dataset['mine'] = el.dataset['option'] === myVote ? 'true' : 'false';
    });
  }

  /** Show the elected standing law (from a VOTE_RESULT winner — the BASE, not overlay). */
  function renderElectedLaw(winner: string | null): void {
    const label = winner ? (DIAL_LAW_LABEL[winner] ?? optionLabel(winner)) : 'NORMAL PHYSICS';
    laws.textContent = `CURRENT LAW: ${label}`;
    laws.dataset['law'] = label;
    // A fresh decree closes the previous ballot until the next OPEN.
    ballot.hidden = true;
    myVote = null;
  }

  /** Handle a `vote` ServerMsg (OPEN / TALLY / RESULT). */
  function onVote(msg: {
    kind: number;
    options?: string[];
    tally?: Record<string, number>;
    winner?: string | null;
  }): void {
    if (msg.kind === KIND.OPEN && msg.options) {
      renderOptions(msg.options);
    } else if (msg.kind === KIND.TALLY && msg.tally) {
      if (msg.options && ballot.hidden) renderOptions(msg.options);
      renderTally(msg.tally);
    } else if (msg.kind === KIND.RESULT) {
      renderElectedLaw(msg.winner ?? null);
    }
  }

  /** Release the wake lock + drop listeners from any path. */
  function release(): void {
    wake?.release();
    wake = null;
    (globalThis as unknown as { removeEventListener?: typeof window.removeEventListener })
      .removeEventListener?.('pagehide', release);
    (globalThis as unknown as { removeEventListener?: typeof window.removeEventListener })
      .removeEventListener?.('beforeunload', release);
  }

  try {
    const res = await joinRoom('crowd', {
      room,
      wsUrl: opts.wsUrl,
      WebSocketImpl: opts.WebSocketImpl,
    });
    ws = res.ws;
    wake = keepScreenAwake();
    status.dataset['joined'] = 'true';
    status.dataset['callsign'] = res.callsign;
    status.textContent = `YOU ARE ${res.callsign} — VOTE FROM YOUR PHONE`;

    // Listen for live vote + env-state traffic. The ballot NEVER repaints "the
    // law" from an env-state (that carries the transient effective params); only a
    // VOTE_RESULT winner moves the laws-in-effect (the elected BASE).
    res.ws.addEventListener?.('message', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== 'string') return;
      let m: { t?: string; kind?: number } & Record<string, unknown>;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.t === 'vote')
        onVote(
          m as unknown as {
            kind: number;
            options?: string[];
            tally?: Record<string, number>;
            winner?: string | null;
          }
        );
      // env-state is intentionally IGNORED for the laws-in-effect panel (§7.5):
      // a transient dial overlay must not repaint the standing law.
    });

    res.ws.addEventListener?.('close', release);
    res.ws.addEventListener?.('error', release);
    (globalThis as unknown as { addEventListener?: typeof window.addEventListener })
      .addEventListener?.('pagehide', release);
    (globalThis as unknown as { addEventListener?: typeof window.addEventListener })
      .addEventListener?.('beforeunload', release);
  } catch (err) {
    status.dataset['joined'] = 'false';
    status.textContent = 'COULD NOT CONNECT — ASK STAFF';
    throw err;
  }

  return { release };
}

/** Escape a value for use in a CSS attribute selector (dial ids are simple, but safe). */
function cssEscape(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

// Auto-boot when loaded as a real page (a #funnel-root exists). Skipped under
// tests / SSR where the caller drives startBallotEntry directly.
const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.(
    'funnel-root'
  ) ?? null;
if (bootRoot) {
  void startBallotEntry(bootRoot).catch(() => {
    /* surfaced in the status line */
  });
}
