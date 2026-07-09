/**
 * funnel/crowdCharge.ts — the F12 Supernova Encore phone light rig + charge UI
 * (spec §5.3 / §7.13, C19).
 *
 * DOM ONLY (NO three — the crowd chunk stays < 100 KB gz, size gate enforced). A
 * TAP-to-charge surface (the PRIMARY input; a DeviceMotion SHAKE is an opt-in
 * garnish behind the iOS gesture), a rising charge meter driven by the coalesced
 * CHARGE_STATE, a max-brightness PROMPT (at join AND CHARGE_START), and the ambient
 * light rig + the SYNCHRONIZED single white flash — all driven by CROWD_CUE /
 * CHARGE_STATE binary frames decoded through the C1 golden codec (Appendix B).
 *
 * The phone NEVER computes the charge: it sends `charge-tap` (debounced client-
 * side too, to save the socket) and RENDERS the server's normalized CHARGE_STATE.
 * The single flash is scheduled at the frame's roomEpoch-relative `fireAtMs` so it
 * lands on every phone in the SAME instant (a lightweight clock-synced fire; the
 * crowd tier does not run the full C3 syncer — the fireAt lead absorbs phone
 * offset, and a late phone flashes immediately). Comfort: ONE pulse, never a
 * strobe (§6.3 ≤ 3 Hz).
 */

import {
  decodeBinary,
  encodeText,
  OPCODES,
  CROWD_KIND,
  CROWD_CUE_EFFECT,
  ambientCuePhase,
  CHARGE_MIN_TAP_INTERVAL_MS,
  CHARGE_WIRE_MAX,
} from '@cyber-shapes/shared';

/** A live socket that can send + receive (the crowd join's ws). */
export interface ChargeSocket {
  send(data: string): void;
  addEventListener?(type: string, cb: (ev: { data: unknown }) => void): void;
  removeEventListener?(type: string, cb: (ev: { data: unknown }) => void): void;
}

export interface CrowdChargeHandle {
  /** Detach listeners + free the DOM. */
  release(): void;
}

/** Options for {@link mountCrowdCharge}. */
export interface CrowdChargeOpts {
  /** The peer's callsign — seeds the per-phone ambient phase offset (ripple). */
  callsign: string;
  doc?: Document;
  /** Injected `now` (ms since epoch) — tests pass a fake; defaults to Date.now. */
  now?: () => number;
  /** Injected setTimeout — tests pass a fake; defaults to the global. */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

/**
 * Build the `charge-tap` intent (the crowd charge tap; the shake garnish maps to
 * the SAME intent — the server debounces + normalizes; the phone never sends a
 * charge value).
 */
export function makeChargeTapMessage(): { t: 'charge-tap' } {
  return { t: 'charge-tap' };
}

/**
 * Mount the encore charge UI + light rig into `container` and wire it to `ws`.
 * Returns a handle to release it. The charge UI is idle (no meter movement) until
 * a CHARGE_STATE arrives, so it ships always-mounted (the server no-ops taps when
 * no encore is armed — like the always-mounted slingshot).
 */
export function mountCrowdCharge(
  container: HTMLElement,
  ws: ChargeSocket,
  opts: CrowdChargeOpts
): CrowdChargeHandle {
  const doc = opts.doc ?? container.ownerDocument;
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // A stable base seed for the per-phone ambient ripple offset (folded with the
  // callsign). The live cue frames carry the real per-arm seed; this base only
  // needs to spread phones apart, which the callsign fold does deterministically.
  const AMBIENT_BASE_SEED = 0x5c0f_e19a;
  const phase = ambientCuePhase(AMBIENT_BASE_SEED, opts.callsign); // 0..1 ripple offset

  const root = doc.createElement('div');
  root.className = 'crowd-charge';
  root.dataset['role'] = 'charge';
  // The per-phone ambient ripple offset (CSS animation-delay reads this).
  root.style.setProperty('--ripple', String(phase));

  // The max-brightness prompt (shown at join; re-emphasized at CHARGE_START).
  const prompt = doc.createElement('div');
  prompt.className = 'charge-prompt';
  prompt.dataset['role'] = 'brightness-prompt';
  prompt.textContent = 'TURN YOUR BRIGHTNESS UP — you are part of the show';
  root.appendChild(prompt);

  // The charge meter (0..100 %). Hidden until the first CHARGE_STATE.
  const meter = doc.createElement('div');
  meter.className = 'charge-meter';
  meter.dataset['role'] = 'charge-meter';
  meter.hidden = true;
  const meterFill = doc.createElement('div');
  meterFill.className = 'charge-meter-fill';
  meterFill.dataset['role'] = 'charge-fill';
  meter.appendChild(meterFill);
  root.appendChild(meter);

  // The TAP button (the PRIMARY charge input).
  const tapBtn = doc.createElement('button');
  tapBtn.type = 'button';
  tapBtn.className = 'charge-tap';
  tapBtn.dataset['role'] = 'charge-tap';
  tapBtn.textContent = 'TAP TO CHARGE';
  root.appendChild(tapBtn);

  // The flash surface — a full-screen white overlay pulsed ONCE at the drop.
  const flash = doc.createElement('div');
  flash.className = 'charge-flash';
  flash.dataset['role'] = 'charge-flash';
  flash.hidden = true;
  root.appendChild(flash);

  container.appendChild(root);

  // --- client-side tap debounce (≤ 5/s — saves the socket; server re-debounces) -
  let lastTapAt = -Infinity;
  function sendTap(): void {
    const t = now();
    if (t - lastTapAt < CHARGE_MIN_TAP_INTERVAL_MS) return; // ≤ 5/s
    lastTapAt = t;
    ws.send(encodeText(makeChargeTapMessage() as never));
    // Local haptic-ish feedback (phones are muted by default — visual feedback).
    root.dataset['tapped'] = String((Number(root.dataset['tapped'] ?? 0) + 1) % 2);
  }
  tapBtn.addEventListener('click', sendTap);

  // --- DeviceMotion SHAKE garnish (opt-in behind the iOS gesture) --------------
  let motionHandler: ((e: DeviceMotionEvent) => void) | null = null;
  function enableShake(): void {
    if (motionHandler) return;
    motionHandler = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const mag = Math.abs(a.x ?? 0) + Math.abs(a.y ?? 0) + Math.abs(a.z ?? 0);
      if (mag > 25) sendTap(); // a shake maps to the SAME charge-tap (debounced)
    };
    (globalThis as unknown as { addEventListener?: (t: string, cb: unknown) => void })
      .addEventListener?.('devicemotion', motionHandler as unknown as EventListener);
  }
  // iOS 13+ requires a user-gesture permission request; wire it to the tap button
  // (the gesture) so shake stays behind the iOS gesture (never auto-requested).
  tapBtn.addEventListener('click', () => {
    const DM = (globalThis as unknown as {
      DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceMotionEvent;
    if (DM && typeof DM.requestPermission === 'function') {
      DM.requestPermission().then((s) => { if (s === 'granted') enableShake(); }).catch(() => {});
    } else {
      enableShake(); // non-iOS: DeviceMotion needs no permission
    }
  });

  // --- the single synchronized flash (scheduled at the frame's fireAtMs) --------
  let flashHandle: unknown = null;
  let lastFlashAt = -Infinity;
  function fireFlash(fireAtMs: number): void {
    // Comfort: ONE pulse only, never a strobe (≤ 3 Hz — reject a flash within
    // 334 ms of the last). fireAtMs is roomEpoch-relative; we schedule against the
    // local delta from the FIRST charge frame (see epoch tracking below). A late
    // phone (delay ≤ 0) flashes immediately (the fireNow semantics).
    const t = now();
    if (t - lastFlashAt < 334) return;
    const localFireAt = epochBase !== null ? epochBase + fireAtMs : t;
    const delay = Math.max(0, localFireAt - t);
    if (flashHandle !== null) clearT(flashHandle);
    flashHandle = setT(() => {
      lastFlashAt = now();
      flash.hidden = false;
      flash.dataset['on'] = '1';
      setT(() => {
        flash.dataset['on'] = '0';
        flash.hidden = true;
      }, 400); // a single 400 ms pulse
    }, delay);
  }

  // --- decode CROWD_CUE / CHARGE_STATE binary frames on the crowd socket --------
  // Track the local↔roomEpoch delta from the first frame carrying a fireAtMs so a
  // scheduled flash lands in perceptual sync (a lightweight clock offset; the lead
  // absorbs jitter, and late phones fire immediately — §7.13).
  let epochBase: number | null = null;
  function onMsg(ev: { data: unknown }): void {
    if (!(ev.data instanceof ArrayBuffer)) return;
    let decoded;
    try {
      decoded = decodeBinary(ev.data);
    } catch {
      return; // not a CROWD_CUE/CHARGE frame we handle
    }
    if (decoded.opcode !== OPCODES.CROWD_CUE) return;
    if (decoded.kind === CROWD_KIND.CHARGE) {
      const charge = decoded.fields.charge as number;
      const fireAtMs = decoded.fields.fireAtMs as number;
      // Learn the epoch base from the first frame that carries a drop schedule.
      if (fireAtMs > 0 && epochBase === null) epochBase = now() - fireAtMs;
      meter.hidden = false;
      const pct = Math.max(0, Math.min(1, charge / CHARGE_WIRE_MAX));
      meterFill.style.width = `${Math.round(pct * 100)}%`;
      meter.dataset['charge'] = String(Math.round(pct * 100));
      if (pct >= 1) meter.dataset['full'] = '1';
      return;
    }
    if (decoded.kind === CROWD_KIND.CUE) {
      const effect = decoded.fields.effect as number;
      const fireAtMs = decoded.fields.fireAtMs as number;
      if (fireAtMs > 0 && epochBase === null) epochBase = now() - fireAtMs;
      if (effect === CROWD_CUE_EFFECT.BRIGHTNESS_PROMPT) {
        // Re-emphasize the max-brightness prompt at CHARGE_START.
        prompt.dataset['emphasis'] = '1';
        meter.hidden = false;
      } else if (effect === CROWD_CUE_EFFECT.PALETTE_FLASH) {
        fireFlash(fireAtMs);
      } else if (effect === CROWD_CUE_EFFECT.AMBIENT_PULSE) {
        // The ambient light rig — a soft per-phone-offset pulse (CSS ripples it).
        root.dataset['pulse'] = String((Number(root.dataset['pulse'] ?? 0) + 1) % 2);
      }
      return;
    }
  }
  ws.addEventListener?.('message', onMsg);

  return {
    release(): void {
      tapBtn.removeEventListener('click', sendTap);
      ws.removeEventListener?.('message', onMsg);
      if (motionHandler) {
        (globalThis as unknown as { removeEventListener?: (t: string, cb: unknown) => void })
          .removeEventListener?.('devicemotion', motionHandler as unknown as EventListener);
        motionHandler = null;
      }
      if (flashHandle !== null) {
        clearT(flashHandle);
        flashHandle = null;
      }
      root.parentNode?.removeChild(root);
    },
  };
}
