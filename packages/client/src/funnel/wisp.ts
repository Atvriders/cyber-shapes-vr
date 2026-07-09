/**
 * funnel/wisp.ts — the WISP entry (spec §7.4, join-first funnel §5.7). A separate
 * Vite entry chunk.
 *
 * Flow (spec §5.7 "join-first, render-later"):
 *   1. Show a CALLSIGN PICKER — ~6 SERVER-OFFERED curated-wordlist options
 *      (offerCallsignWords, §6.1 — NEVER a free-text field) + a COLOR PICKER.
 *   2. On confirm: `joinRoom('wisp', …)` with the chosen `requestedName` — the
 *      wisp EXISTS in-world at the handshake; the phone shows "YOU ARE IN — look
 *      at the big screen".
 *   3. ONLY THEN lazy-load the 3D magic window (`import('./wisp3d.js')`), so the
 *      `joined` state is reached BEFORE any three loads (asserted in
 *      funnel.test.ts) and three stays out of the ENTRY chunk (< 300 KB gz).
 *
 * The entry module itself imports NO three; the only three import is the dynamic
 * `./wisp3d.js` chunk, loaded post-join.
 */

import { parseRoom } from '../net/roomLink.js';
import { CYBER_COLORS } from '@cyber-shapes/shared';
import { joinRoom, offerCallsignWords } from './join.js';
import { keepScreenAwake, type WakeLockHandle } from './wakeLock.js';
import type { WispView, PocketDvrHandle } from './wisp3d.js';

/** Injectable dynamic-import of the 3D chunk (tests observe join-before-3D). */
export type Import3d = () => Promise<typeof import('./wisp3d.js')>;

const defaultImport3d: Import3d = () => import('./wisp3d.js');

export interface WispEntryOpts {
  room?: string;
  wsUrl?: string;
  WebSocketImpl?: typeof WebSocket;
  /** Seed for the offered callsign words (defaults to a time-derived value). */
  offerSeed?: number;
  /** Override the 3D dynamic import (tests inject a spy to assert ordering). */
  import3d?: Import3d;
  /** Notified the instant the wisp is IN-world (before 3D loads). */
  onJoined?: (info: { callsign: string; peerId: string }) => void;
}

/** Handle for a live wisp entry (dispose stops the 3D view + wake lock). */
export interface WispEntryHandle {
  dispose(): void;
}

/**
 * Render the wisp picker into `root`. The user picks a callsign word + color,
 * then taps ENTER; that joins the room and (after `onJoined`) lazy-loads the 3D
 * window.
 */
export function startWispEntry(
  root: HTMLElement,
  opts: WispEntryOpts = {}
): void {
  const doc = root.ownerDocument;
  const room =
    opts.room ??
    parseRoom(
      (globalThis as unknown as { location?: { href: string } }).location?.href ?? ''
    ) ??
    '';
  const seed =
    opts.offerSeed ??
    ((globalThis as unknown as { Date?: { now(): number } }).Date?.now?.() ?? 0);

  root.textContent = '';
  root.className = 'funnel-wisp';

  // ── Picker ────────────────────────────────────────────────────────────────
  const picker = doc.createElement('div');
  picker.className = 'wisp-picker';
  picker.dataset['role'] = 'picker';

  const title = doc.createElement('div');
  title.className = 'wisp-title';
  title.textContent = 'CHOOSE YOUR CALLSIGN';
  picker.appendChild(title);

  // ~6 server-offered curated-wordlist options — rendered as BUTTONS, never a
  // free-text <input> (spec §6.1). Each carries its CURATED_WORDLIST index.
  const offered = offerCallsignWords(seed, 6);
  const wordRow = doc.createElement('div');
  wordRow.className = 'wisp-words';
  wordRow.dataset['role'] = 'words';
  let chosenNameIndex = offered[0]?.index ?? 0;
  const wordButtons: HTMLButtonElement[] = [];
  for (const { word, index } of offered) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'wisp-word';
    b.dataset['role'] = 'word';
    b.dataset['wordIndex'] = String(index);
    b.textContent = word;
    if (index === chosenNameIndex) b.dataset['selected'] = 'true';
    b.addEventListener('click', () => {
      chosenNameIndex = index;
      for (const other of wordButtons) delete other.dataset['selected'];
      b.dataset['selected'] = 'true';
    });
    wordButtons.push(b);
    wordRow.appendChild(b);
  }
  picker.appendChild(wordRow);

  // Color picker (index into CYBER_COLORS).
  const colorRow = doc.createElement('div');
  colorRow.className = 'wisp-colors';
  colorRow.dataset['role'] = 'colors';
  let chosenColor = 0;
  const colorButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < CYBER_COLORS.length; i++) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'wisp-color';
    b.dataset['role'] = 'color';
    b.dataset['colorIndex'] = String(i);
    b.style.background = `#${CYBER_COLORS[i].toString(16).padStart(6, '0')}`;
    if (i === chosenColor) b.dataset['selected'] = 'true';
    b.addEventListener('click', () => {
      chosenColor = i;
      for (const other of colorButtons) delete other.dataset['selected'];
      b.dataset['selected'] = 'true';
    });
    colorButtons.push(b);
    colorRow.appendChild(b);
  }
  picker.appendChild(colorRow);

  const enter = doc.createElement('button');
  enter.type = 'button';
  enter.className = 'wisp-enter';
  enter.dataset['role'] = 'enter';
  enter.textContent = 'ENTER THE VOID';
  picker.appendChild(enter);

  root.appendChild(picker);

  // ── In-world panel (revealed at handshake, before 3D loads) ─────────────────
  const inPanel = doc.createElement('div');
  inPanel.className = 'wisp-in';
  inPanel.dataset['role'] = 'in';
  inPanel.hidden = true;
  const inMsg = doc.createElement('div');
  inMsg.className = 'wisp-in-msg';
  inMsg.dataset['role'] = 'in-msg';
  inPanel.appendChild(inMsg);
  const canvas = doc.createElement('canvas');
  canvas.className = 'wisp-canvas';
  canvas.dataset['role'] = 'canvas';
  inPanel.appendChild(canvas);
  root.appendChild(inPanel);

  const import3d = opts.import3d ?? defaultImport3d;
  let wake: WakeLockHandle | null = null;
  let view: WispView | null = null;
  // C30 (F19 Pocket DVR): the scrub/rewind handle — constructed INSIDE the lazy
  // wisp3d chunk (never imported into this entry) so it never bloats the funnel.
  let dvr: PocketDvrHandle | null = null;

  enter.addEventListener('click', () => {
    enter.disabled = true;
    void enterWorld();
  });

  async function enterWorld(): Promise<void> {
    // Reset to CONNECTING at the TOP of every attempt so a retry never shows
    // a stale error message during the handshake (finding #4).
    inMsg.textContent = 'CONNECTING…';
    inMsg.dataset['joined'] = '';
    inPanel.hidden = false;
    picker.hidden = true;

    let res;
    try {
      res = await joinRoom('wisp', {
        room,
        wsUrl: opts.wsUrl,
        WebSocketImpl: opts.WebSocketImpl,
        color: chosenColor,
        requestedName: chosenNameIndex,
      });
    } catch {
      inMsg.textContent = 'COULD NOT CONNECT — ASK STAFF';
      inPanel.hidden = false;
      picker.hidden = true;
      enter.disabled = false;
      return;
    }

    // === IN-WORLD at handshake — BEFORE any 3D loads (spec §5.7). ===
    wake = keepScreenAwake();
    picker.hidden = true;
    inPanel.hidden = false;
    inMsg.dataset['callsign'] = res.callsign;
    inMsg.dataset['joined'] = 'true';
    opts.onJoined?.({ callsign: res.callsign, peerId: res.peerId });
    res.ws.addEventListener?.('close', () => {
      wake?.release();
    });

    // OVER-CAP (spec §7.4): the wisp room is full, so the server soft-downgraded
    // this join (granted tier is NOT 'wisp', reason names over-cap). Render the
    // DOM-only SPECTATE page with the queue position instead of the 3D window —
    // an over-cap phone never pays the three download.
    const overCap = res.tier !== 'wisp' || /over-cap/i.test(res.downgrade?.reason ?? '');
    if (overCap) {
      inMsg.textContent = `${res.callsign} — the void is full`;
      const mod = await import3d();
      const queuePosition = deriveQueuePosition(res.downgrade?.reason);
      mod.renderSpectatePage(inPanel, { queuePosition, callsign: res.callsign });
      return;
    }

    inMsg.textContent = `YOU ARE ${res.callsign} — look at the big screen`;

    // Render-later: lazy-load the 3D magic window AFTER we are already in.
    try {
      const mod = await import3d();
      // C30 MF4: the 3D window draws the DVR's rewound poses while scrubbed. The DVR
      // is created just below (startPocketDvr), so the window reads it LAZILY via
      // getDvr — mounting the view FIRST preserves the join-first render order.
      view = mod.mountWispView(canvas, chosenColor, { getDvr: () => dvr?.dvr });
      // C30 (F19 Pocket DVR): mount the scrub/rewind DVR — lazy-loaded WITH the 3D
      // chunk (spec §7.19 bundle hygiene). Fed by the live socket's text frames;
      // a non-spectator (wisp) tier, so resume drains the buffered ring forward.
      dvr = mod.startPocketDvr(inPanel, { tier: 'wisp', ws: res.ws });
    } catch {
      // 3D failed to load — the phone stays "in" with the DOM panel only.
    }
  }

  // Expose a disposer on the root for callers/tests (best-effort).
  (root as unknown as { __wispDispose?: () => void }).__wispDispose = () => {
    dvr?.dispose();
    view?.dispose();
    wake?.release();
  };
}

/**
 * Derive the spectate queue position from the downgrade reason. The C2 downgrade
 * reason for a full wisp room is `wisp-over-cap`; if a future server embeds a
 * numeric position (e.g. `wisp-over-cap:3`), surface it — otherwise default to 1
 * (next in line). Kept tiny + pure so the DOM path stays testable.
 */
function deriveQueuePosition(reason: string | undefined): number {
  if (!reason) return 1;
  const m = /(\d+)/.exec(reason);
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.(
    'funnel-root'
  ) ?? null;
if (bootRoot) {
  startWispEntry(bootRoot);
}
