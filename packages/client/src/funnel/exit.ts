/**
 * funnel/exit.ts — the post-participation EXIT screen (spec §5.7 "the funnel
 * bottom", critic-mandated). Shown after a phone leaves the live room.
 *
 * Renders, DOM-only (ZERO three — this is an exit chunk that must stay tiny):
 *   • the player's server-assigned callsign,
 *   • their glyph line ("your glyph is at ring N"),
 *   • a club Discord / mailing-list QR SLOT (image wired by the kit; slot here),
 *   • the persistent room permalink + a COPY button, with the retention copy
 *     "this world stays online — your glyph is part of it",
 *   • a LAN-mode COPY VARIANT "the world goes online tonight — same link" when
 *     running a `docker-compose.lan.yml` booth day (Task C23). Detection is a
 *     `?lan=1` query-string convention on the exit-screen URL — `bootFunnel`
 *     (funnel.ts) reads it and forwards it here as `info.lan`; see
 *     `docs/booth/RUNBOOK.md` → LAN mode / QR Fallback Ladder for how staff sets
 *     it on a LAN-mode day's distributed links. Here it is simply the flag.
 *   • C31 (F20 Neon Clip Machine, spec §7.20): a clips-by-callsign line — the
 *     retrieval URL(s) for any clip(s) saved under this callsign this session
 *     (the SAME `GET /api/clips/:id` URL the stage's end-slate QR encodes).
 *     Omitted entirely when the player has no clips.
 *
 * The copy is swapped by a single `lan` boolean so C23 only has to flip a flag.
 */

import { roomUrl } from '../net/roomLink.js';

/** The two retention-copy variants (spec §5.7). */
export const EXIT_COPY = {
  /** Default: the world is permanently hosted (cloud/tunnel). */
  online: 'this world stays online — your glyph is part of it',
  /** LAN mode: the export goes live tonight at the same permalink (spec §5.7 / §10). */
  lan: 'the world goes online tonight — same link',
  /**
   * C25 (F14 The Gallery, spec §7.14): the doors-open "share it" hook — the exit
   * screen nudges a departing player to send the live watch link to friends. This
   * is how The Gallery seeds an audience (a seeding-is-an-announcement problem).
   */
  shareLive: "it's live right now — share it",
  /**
   * C31 (F20 Neon Clip Machine, spec §7.20): the clips-by-callsign nudge —
   * points a departing player at the clip(s) they saved this session.
   */
  clipsHeadline: 'your clips',
} as const;

/** Everything the exit screen needs to render. */
export interface ExitInfo {
  /** Server-assigned callsign (never free text — §6.1). */
  callsign: string;
  /** The room id, for building the permalink. */
  roomId: string;
  /** Origin for the permalink (defaults to location.origin). */
  origin?: string;
  /**
   * The ring index the player's glyph landed at (Guestbook, §6.4). Optional —
   * a wisp/voter with no glyph omits the glyph line.
   */
  glyphRing?: number;
  /**
   * LAN-mode flag (C23). When true the retention copy swaps to the "goes online
   * tonight" variant. Defaults to false (the permanent-online promise).
   */
  lan?: boolean;
  /** Optional Discord/mailing-list QR image URL for the slot. */
  discordQrSrc?: string;
  /**
   * C31 (F20 Neon Clip Machine, spec §7.20): retrieval URLs (`GET /api/clips/:id`)
   * for clip(s) saved under this callsign this session. Omitted/empty → no
   * clips line renders (a visitor who never triggered SAVE CLIP / an auto-first
   * catch sees an unchanged exit screen).
   */
  clipUrls?: string[];
}

/**
 * Build the exit-screen DOM under `root` (cleared first). Pure DOM — no network,
 * no three. Returns the constructed root for convenience/testing.
 */
export function renderExitScreen(root: HTMLElement, info: ExitInfo): HTMLElement {
  const doc = root.ownerDocument;
  const origin =
    info.origin ??
    (globalThis as unknown as { location?: { origin: string } }).location?.origin ??
    '';
  const permalink = roomUrl(origin, info.roomId);
  const copy = info.lan ? EXIT_COPY.lan : EXIT_COPY.online;

  root.textContent = '';
  root.className = 'funnel-exit';

  // Callsign headline.
  const callsignEl = doc.createElement('div');
  callsignEl.className = 'exit-callsign';
  callsignEl.dataset['role'] = 'callsign';
  callsignEl.textContent = info.callsign;
  root.appendChild(callsignEl);

  const thanks = doc.createElement('div');
  thanks.className = 'exit-thanks';
  thanks.textContent = 'YOU WERE HERE';
  root.appendChild(thanks);

  // Glyph line (only when the player left a glyph).
  if (info.glyphRing !== undefined) {
    const glyphEl = doc.createElement('div');
    glyphEl.className = 'exit-glyph';
    glyphEl.dataset['role'] = 'glyph';
    glyphEl.textContent = `your glyph is at ring ${info.glyphRing}`;
    root.appendChild(glyphEl);
  }

  // C31 (F20 Neon Clip Machine): clips-by-callsign line — only when there's at
  // least one saved clip this session.
  if (info.clipUrls && info.clipUrls.length > 0) {
    const clipsWrap = doc.createElement('div');
    clipsWrap.className = 'exit-clips';
    clipsWrap.dataset['role'] = 'clips';

    const headline = doc.createElement('div');
    headline.className = 'exit-clips-headline';
    headline.textContent = EXIT_COPY.clipsHeadline;
    clipsWrap.appendChild(headline);

    for (const url of info.clipUrls) {
      const a = doc.createElement('a');
      a.className = 'exit-clip-link';
      a.dataset['role'] = 'clip-link';
      a.href = url;
      a.textContent = url;
      clipsWrap.appendChild(a);
    }
    root.appendChild(clipsWrap);
  }

  // Club Discord / mailing-list QR slot.
  const qrSlot = doc.createElement('div');
  qrSlot.className = 'exit-discord-qr';
  qrSlot.dataset['role'] = 'discord-qr';
  if (info.discordQrSrc) {
    const img = doc.createElement('img');
    img.src = info.discordQrSrc;
    img.alt = 'Club Discord QR';
    qrSlot.appendChild(img);
  } else {
    qrSlot.textContent = '[ CLUB DISCORD QR ]';
  }
  root.appendChild(qrSlot);

  // Permalink + retention copy + copy button.
  const permaWrap = doc.createElement('div');
  permaWrap.className = 'exit-permalink';

  const copyLine = doc.createElement('div');
  copyLine.className = 'exit-copy';
  copyLine.dataset['role'] = 'copy';
  copyLine.textContent = copy;
  permaWrap.appendChild(copyLine);

  const linkEl = doc.createElement('a');
  linkEl.className = 'exit-link';
  linkEl.dataset['role'] = 'permalink';
  linkEl.href = permalink;
  linkEl.textContent = permalink;
  permaWrap.appendChild(linkEl);

  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'exit-copy-btn';
  copyBtn.dataset['role'] = 'copy-btn';
  copyBtn.textContent = 'COPY LINK';
  copyBtn.addEventListener('click', () => {
    const clip = (
      globalThis as unknown as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }
    ).navigator?.clipboard;
    if (clip) {
      void clip.writeText(permalink).then(
        () => {
          copyBtn.textContent = 'COPIED';
        },
        () => {
          /* ignore */
        }
      );
    }
  });
  permaWrap.appendChild(copyBtn);

  // C25 (F14 The Gallery): the "it's live right now — share it" hook. A one-tap
  // button copies the WATCH permalink (`?watch`) so a departing player seeds the
  // remote audience (spec §7.14 doors-open announcement). The watch link routes to
  // the receive-only audience viewer during live occupancy.
  const shareLine = doc.createElement('div');
  shareLine.className = 'exit-share-copy';
  shareLine.dataset['role'] = 'share-live';
  shareLine.textContent = EXIT_COPY.shareLive;
  permaWrap.appendChild(shareLine);

  const watchLink = `${permalink}${permalink.includes('?') ? '&' : '?'}watch`;
  const shareBtn = doc.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'exit-share-btn';
  shareBtn.dataset['role'] = 'share-btn';
  shareBtn.dataset['watchLink'] = watchLink;
  shareBtn.textContent = 'SHARE WATCH LINK';
  shareBtn.addEventListener('click', () => {
    const clip = (
      globalThis as unknown as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }
    ).navigator?.clipboard;
    if (clip) {
      void clip.writeText(watchLink).then(
        () => {
          shareBtn.textContent = 'WATCH LINK COPIED';
        },
        () => {
          /* ignore */
        }
      );
    }
  });
  permaWrap.appendChild(shareBtn);

  root.appendChild(permaWrap);

  return root;
}
