/**
 * funnel/crowd.ts — the CROWD entry (Guestbook scribe / Meteor Siege slingshot /
 * Encore charge — spec §5.1 crowd tier). A separate Vite entry chunk (§5.7/§5.8).
 *
 * DOM-ONLY. Joins the live room on the `crowd` tier with ZERO permissions and
 * NEVER imports three (asserted by the size gate < 100 KB gz + the import-graph
 * test). Later tasks (C12 scribe, C16 slingshot, C19 charge) layer their UIs onto
 * this entry; C7 ships the entry scaffold: join-on-crowd + a live "you're in"
 * panel + a tap-to-cheer button + Screen Wake Lock.
 */

import { parseRoom } from '../net/roomLink.js';
import { joinRoom } from './join.js';
import { keepScreenAwake, type WakeLockHandle } from './wakeLock.js';
import { mountScribe, type ScribeHandle } from './scribe.js';
import { mountSlingshot, type SlingshotHandle } from './slingshot.js';
import { mountCrowdCharge, type CrowdChargeHandle } from './crowdCharge.js';

/** Render the crowd entry into `root` and join the room on the crowd tier. */
export async function startCrowdEntry(
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

  root.textContent = '';
  root.className = 'funnel-crowd';

  const title = doc.createElement('div');
  title.className = 'crowd-title';
  title.textContent = 'JOIN THE CROWD';
  root.appendChild(title);

  const status = doc.createElement('div');
  status.className = 'crowd-status';
  status.dataset['role'] = 'status';
  status.textContent = 'CONNECTING…';
  root.appendChild(status);

  const cheer = doc.createElement('button');
  cheer.type = 'button';
  cheer.className = 'crowd-cheer';
  cheer.dataset['role'] = 'cheer';
  cheer.textContent = 'CHEER';
  cheer.disabled = true;
  root.appendChild(cheer);

  let wake: WakeLockHandle | null = null;
  let scribe: ScribeHandle | null = null;
  let slingshot: SlingshotHandle | null = null;
  let charge: CrowdChargeHandle | null = null;

  /** Release the wake lock from any path (ws close, ws error, page hide, caller). */
  function release(): void {
    wake?.release();
    wake = null;
    scribe?.release();
    scribe = null;
    slingshot?.release();
    slingshot = null;
    charge?.release();
    charge = null;
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
    wake = keepScreenAwake();
    cheer.disabled = false;
    status.dataset['joined'] = 'true';
    status.dataset['callsign'] = res.callsign;
    status.textContent = `YOU ARE ${res.callsign} — look at the big screen`;
    // C12: mount the Neon Guestbook scribe (draw surface + live 6-fold
    // kaleidoscope preview). DOM-only — no three (the crowd chunk stays < 100 KB).
    // The scribe submits a `glyph-add` on the SAME crowd socket; the private
    // glyph-ack updates the status line with the ring the glyph landed at.
    scribe = mountScribe(root, res.ws as unknown as { send(d: string): void; addEventListener?: (t: string, cb: (e: { data: unknown }) => void) => void }, {
      onAck: (callsign, ring) => {
        status.dataset['ring'] = String(ring);
        status.textContent =
          ring < 0
            ? `YOU ARE ${callsign} — your glyph lands shortly`
            : `YOU ARE ${callsign} — your glyph is at ring ${ring}`;
      },
    });
    // C16: the Meteor Siege slingshot (drag = aim + power → met-launch). DOM-only —
    // no three (the crowd chunk stays < 100 KB). The server no-ops a launch when no
    // siege is armed, so the slingshot ships always-mounted (the barrage rung means
    // there is always something to fire at during a siege). The launcher's color is
    // derived from the callsign so meteors are per-launcher colored (§7.6).
    const colorIndex = colorFromCallsign(res.callsign);
    slingshot = mountSlingshot(root, res.ws as unknown as { send(d: string): void }, { colorIndex });
    // C19: the F12 Supernova Encore light rig + charge UI (TAP to charge; shake
    // opt-in behind the iOS gesture; a max-brightness prompt at join AND
    // CHARGE_START; the ambient light rig + the SYNCHRONIZED single flash). DOM-
    // only — no three (the crowd chunk stays < 100 KB). Always-mounted: the server
    // no-ops taps + emits no CHARGE_STATE until an encore is armed, so the meter is
    // idle until the finale (exactly like the always-mounted slingshot).
    charge = mountCrowdCharge(
      root,
      res.ws as unknown as {
        send(d: string): void;
        addEventListener?: (t: string, cb: (e: { data: unknown }) => void) => void;
        removeEventListener?: (t: string, cb: (e: { data: unknown }) => void) => void;
      },
      { callsign: res.callsign }
    );
    // Release the wake lock on socket close, socket error (silent TCP drop), and
    // page navigation — avoids re-acquiring the lock on every screen unlock after
    // a silent mobile TCP drop.
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

/** Deterministic per-launcher meteor color from a callsign (§7.6, 7 palette slots). */
function colorFromCallsign(callsign: string): number {
  let h = 0;
  for (let i = 0; i < callsign.length; i++) h = (h * 31 + callsign.charCodeAt(i)) >>> 0;
  return h % 7;
}

const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.(
    'funnel-root'
  ) ?? null;
if (bootRoot) {
  void startCrowdEntry(bootRoot).catch(() => {
    /* surfaced in the status line */
  });
}
