/**
 * funnel/funnel.ts — the funnel ROUTER (spec §5.7 "the QR resolves to one funnel
 * page that … negotiates tier by intent").
 *
 * The QR points at `/r/:roomId` → this page. It shows the entry CHOICES and, on
 * selection, DYNAMICALLY imports the chosen entry chunk. Keeping the entries
 * behind dynamic imports is what preserves the code-split: choosing BALLOT never
 * pulls the wisp/three chunk, and the initial router payload is DOM-only.
 *
 * Routes / intents:
 *   • `?watch`            → WATCH (C25 F14 The Gallery). The receive-only remote
 *                           `audience` viewer. During LIVE occupancy the permalink
 *                           is audience-ONLY (wisp/crowd/ballot entry is reachable
 *                           only via the booth-QR variant — a distinct path the
 *                           Discord post never carries); full entry returns when
 *                           the room is idle.
 *   • `?mode=ballot`      → the VOTER entry (crowd tier).
 *   • `?mode=crowd`       → the CROWD entry (crowd tier).
 *   • `?mode=wisp`        → the WISP entry (wisp tier, join-first + lazy 3D).
 *   • (no mode)           → the CHOICE screen (fly / vote / cheer / watch).
 */

import { parseRoom } from '../net/roomLink.js';

export type FunnelMode = 'ballot' | 'crowd' | 'wisp' | 'watch' | 'exit' | 'choose';

/** Parse the funnel intent from a URL's search string. Pure. */
export function parseFunnelMode(search: string): FunnelMode {
  const params = new URLSearchParams(search);
  if (params.has('watch')) return 'watch';
  const mode = params.get('mode');
  if (mode === 'ballot' || mode === 'crowd' || mode === 'wisp' || mode === 'exit') return mode;
  return 'choose';
}

/**
 * C25 (F14 The Gallery, spec §7.14): is this the BOOTH-QR variant of the funnel
 * URL? Only the booth QR carries an explicit entry marker (`?booth` or a `?mode=`
 * choice); the public Discord `?watch` permalink never does. wisp/crowd/ballot
 * entry is reachable ONLY on the booth path — a remote viewer must not consume a
 * booth cap or the queue bridge. Pure.
 */
export function isBoothEntry(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('booth') || params.has('mode');
}

/**
 * C25 (spec §7.14): may a `?watch` page expose live-room ENTRY (wisp/crowd/ballot)?
 * ONLY when it is the booth-QR variant OR the room is idle — during live occupancy
 * a public permalink is audience-only (the invariant the plan test pins: "the
 * permalink page during occupancy exposes no wisp/crowd join"). Pure.
 */
export function watchExposesEntry(opts: { booth: boolean; occupied: boolean }): boolean {
  return opts.booth || !opts.occupied;
}

/** Build the "choose your presence" screen. Returns the buttons for wiring. */
function renderChoice(
  root: HTMLElement,
  onPick: (mode: Exclude<FunnelMode, 'choose'>) => void,
  watchHint = false
): void {
  const doc = root.ownerDocument;
  root.textContent = '';
  root.className = 'funnel-choose';

  const title = doc.createElement('div');
  title.className = 'funnel-title';
  title.textContent = watchHint ? 'THE WORLD IS IDLE — ENTER OR WATCH' : 'SCAN TO ENTER THE VOID';
  root.appendChild(title);

  const choices: Array<{ mode: Exclude<FunnelMode, 'choose'>; label: string }> = [
    { mode: 'wisp', label: 'FLY AS A WISP' },
    { mode: 'ballot', label: 'VOTE ON PHYSICS' },
    { mode: 'crowd', label: 'JOIN THE CROWD' },
    { mode: 'watch', label: 'WATCH' },
  ];
  for (const { mode, label } of choices) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'funnel-choice';
    b.dataset['role'] = 'choice';
    b.dataset['mode'] = mode;
    b.textContent = label;
    b.addEventListener('click', () => onPick(mode));
    root.appendChild(b);
  }
}

/** Handles the watch case wires the live viewer to. */
interface WatchChrome {
  /** Update the "N WATCHING · 0 VIDEO FRAMES SENT" counter (renders only at N ≥ 5). */
  setCounter(n: number): void;
  /** Reflect the viewer status (connecting/live/attract/paused/at-capacity). */
  setStatus(status: string): void;
  /** Register the one-tap "click to rejoin" handler. */
  onRejoin(cb: () => void): void;
}

/** The N ≥ 5 threshold for the "N WATCHING" flex (mirrors StageOverlays). */
const WATCH_COUNTER_MIN = 5;

/** Human copy per viewer status (5-metre-plain; the "share it" hook is §7.14). */
const WATCH_STATUS_COPY: Record<string, string> = {
  connecting: 'CONNECTING TO THE VOID…',
  live: 'WATCHING LIVE',
  attract: 'THE BOOTH IS QUIET — GHOSTS ARE PLAYING',
  paused: 'PAUSED — CLICK TO REJOIN',
  'at-capacity': 'AT CAPACITY — THE WORLD REOPENS TONIGHT',
};

/**
 * C25 (F14 The Gallery): the WATCH permalink chrome. Renders (DOM-only, three is
 * lazy) the viewer-count line, the "it's live right now — share it" affordance,
 * and a one-tap pause/rejoin card. Live-room ENTRY choices (wisp/crowd/ballot)
 * are rendered ONLY when `exposeEntry` — during live occupancy a public permalink
 * exposes NONE (the §7.14 invariant). Returns the wiring the live viewer drives.
 */
function renderWatchScreen(
  root: HTMLElement,
  { exposeEntry, onPick }: { exposeEntry: boolean; onPick: (m: Exclude<FunnelMode, 'choose'>) => void }
): WatchChrome {
  const doc = root.ownerDocument;
  root.textContent = '';
  root.className = 'funnel-watch';
  root.dataset['exposeEntry'] = exposeEntry ? 'true' : 'false';

  const title = doc.createElement('div');
  title.className = 'funnel-title';
  title.dataset['role'] = 'watch-title';
  title.textContent = 'THE GALLERY';
  root.appendChild(title);

  const status = doc.createElement('div');
  status.className = 'watch-status';
  status.dataset['role'] = 'watch-status';
  status.textContent = WATCH_STATUS_COPY['connecting'];
  root.appendChild(status);

  // The "N WATCHING · 0 VIDEO FRAMES SENT" counter — hidden until N ≥ 5.
  const counter = doc.createElement('div');
  counter.className = 'watch-counter';
  counter.dataset['role'] = 'watch-counter';
  counter.hidden = true;
  root.appendChild(counter);

  // The render viewport the lazy 3D magic-window renderer mounts into.
  const viewport = doc.createElement('div');
  viewport.className = 'watch-viewport';
  viewport.dataset['role'] = 'watch-viewport';
  root.appendChild(viewport);

  // The one-tap rejoin card (shown while paused / after a hidden-tab drop).
  const rejoinBtn = doc.createElement('button');
  rejoinBtn.type = 'button';
  rejoinBtn.className = 'watch-rejoin';
  rejoinBtn.dataset['role'] = 'watch-rejoin';
  rejoinBtn.textContent = 'CLICK TO REJOIN';
  rejoinBtn.hidden = true;
  root.appendChild(rejoinBtn);

  // "it's live right now — share it" (spec §7.14 doors-open announcement hook).
  const share = doc.createElement('button');
  share.type = 'button';
  share.className = 'watch-share';
  share.dataset['role'] = 'watch-share';
  share.textContent = "IT'S LIVE RIGHT NOW — SHARE IT";
  share.addEventListener('click', () => {
    const loc = (globalThis as unknown as { location?: { href: string } }).location;
    const href = loc?.href ?? '';
    const clip = (
      globalThis as unknown as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }
    ).navigator?.clipboard;
    if (clip) {
      void clip.writeText(href).then(
        () => {
          share.textContent = 'LINK COPIED — SHARE IT';
        },
        () => {
          /* ignore */
        }
      );
    }
  });
  root.appendChild(share);

  // Live-room ENTRY is exposed ONLY off the booth path / when idle (§7.14). During
  // live occupancy a public `?watch` permalink renders NO wisp/crowd/ballot join.
  if (exposeEntry) {
    const entry = doc.createElement('div');
    entry.className = 'watch-entry';
    entry.dataset['role'] = 'watch-entry';
    const enterChoices: Array<{ mode: Exclude<FunnelMode, 'choose'>; label: string }> = [
      { mode: 'wisp', label: 'FLY AS A WISP' },
      { mode: 'ballot', label: 'VOTE ON PHYSICS' },
      { mode: 'crowd', label: 'JOIN THE CROWD' },
    ];
    for (const { mode, label } of enterChoices) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'funnel-choice';
      b.dataset['role'] = 'choice';
      b.dataset['mode'] = mode;
      b.textContent = label;
      b.addEventListener('click', () => onPick(mode));
      entry.appendChild(b);
    }
    root.appendChild(entry);
  }

  return {
    setCounter(n: number): void {
      const count = Math.max(0, Math.floor(n));
      if (count < WATCH_COUNTER_MIN) {
        counter.hidden = true;
        counter.textContent = '';
        return;
      }
      counter.hidden = false;
      counter.dataset['count'] = String(count);
      counter.textContent = `${count} WATCHING · 0 VIDEO FRAMES SENT`;
    },
    setStatus(s: string): void {
      status.dataset['status'] = s;
      status.textContent = WATCH_STATUS_COPY[s] ?? WATCH_STATUS_COPY['live'];
      // The rejoin card is the pause affordance — shown only while paused.
      rejoinBtn.hidden = s !== 'paused';
    },
    onRejoin(cb: () => void): void {
      rejoinBtn.addEventListener('click', cb);
    },
  };
}

/**
 * Boot the funnel into `root` for the given `location`. DOM-only entrypoint; the
 * chosen entry chunk is dynamically imported so the code-split holds.
 */
export async function bootFunnel(
  root: HTMLElement,
  loc: { href: string; search: string } = (
    globalThis as unknown as { location: { href: string; search: string } }
  ).location
): Promise<void> {
  const room = parseRoom(loc.href) ?? '';
  const mode = parseFunnelMode(loc.search);

  const go = async (m: Exclude<FunnelMode, 'choose'>) => {
    switch (m) {
      case 'ballot': {
        const { startBallotEntry } = await import('./ballot.js');
        await startBallotEntry(root, { room });
        break;
      }
      case 'crowd': {
        const { startCrowdEntry } = await import('./crowd.js');
        await startCrowdEntry(root, { room });
        break;
      }
      case 'wisp': {
        const { startWispEntry } = await import('./wisp.js');
        startWispEntry(root, { room });
        break;
      }
      case 'exit': {
        // The souvenir/exit screen (spec §5.7 "the funnel bottom"). Rendered
        // from the permalink's query params so a returning phone still gets its
        // callsign + glyph line + permalink after the socket has closed.
        const { renderExitScreen } = await import('./exit.js');
        const params = new URLSearchParams(loc.search);
        const ringRaw = params.get('ring');
        // Treat an empty-string ring param as absent — `Number('')` would yield 0
        // which is indistinguishable from a real ring 0 (finding #6).
        const glyphRing =
          ringRaw !== null && ringRaw !== '' && /^\d+$/.test(ringRaw)
            ? Number(ringRaw)
            : undefined;
        renderExitScreen(root, {
          callsign: params.get('cs') ?? '',
          roomId: room,
          glyphRing,
          lan: params.get('lan') === '1',
        });
        break;
      }
      case 'watch': {
        // C25 (F14 The Gallery): the receive-only remote `audience` viewer. During
        // live occupancy this permalink is audience-ONLY (no wisp/crowd entry); the
        // booth-QR variant (or an idle room) exposes full entry. Live-occupancy
        // detection is server-side (C23 wires it); a bare `?watch` permalink defaults
        // to OCCUPIED (the live-event common case) — only the booth path opens entry.
        const booth = isBoothEntry(loc.search);
        const occupied = !booth;
        const exposeEntry = watchExposesEntry({ booth, occupied });
        const chrome = renderWatchScreen(root, {
          exposeEntry,
          onPick: (picked) => void go(picked),
        });
        // Boot the receive-only viewer LAZILY (three stays code-split out of the
        // funnel entry — the WatchViewer + its render governor load on demand).
        try {
          const { WatchViewer } = await import('../stage/stage.js');
          const viewer = new WatchViewer({
            room,
            onViewerCount: (n) => chrome.setCounter(n),
            onStatus: (s) => chrome.setStatus(s),
          });
          chrome.onRejoin(() => viewer.rejoin());
          const doc = root.ownerDocument;
          const win = doc.defaultView ?? (globalThis as unknown as Window);
          doc.addEventListener('visibilitychange', () => viewer.setHidden(doc.hidden === true));
          win.addEventListener('beforeunload', () => viewer.dispose());
          viewer.connect();
        } catch {
          // The viewer chunk failed to load — the chrome still shows the share/idle
          // affordances (the after-hours souvenir survives, spec §7.14).
        }
        break;
      }
    }
  };

  if (mode === 'choose') {
    renderChoice(root, (picked) => void go(picked));
  } else {
    await go(mode);
  }
}

// Auto-boot on a real page (index.html provides #funnel-root). No-op under tests.
const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.(
    'funnel-root'
  ) ?? null;
if (bootRoot) {
  void bootFunnel(bootRoot).catch(() => {
    /* the entry surfaces its own error state */
  });
}
