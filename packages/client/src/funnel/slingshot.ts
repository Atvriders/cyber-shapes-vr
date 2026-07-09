/**
 * funnel/slingshot.ts — the phone Meteor Siege slingshot (spec §7.6, C16).
 *
 * DOM + 2D-canvas ONLY (NO three — the crowd chunk must stay < 100 KB gz, size
 * gate enforced). A drag surface: pull back to aim + charge, release to fire a
 * `met-launch` at the crystal. A recharge ring shows the 1-per-3 s cooldown. The
 * slingshot is an ephemeral crowd guest (joined on the crowd tier).
 *
 * The server NEVER trusts the power — the meteor speed is clamped to 6–8 m/s
 * server-side (anti-cheat). The drag distance only maps to a [0,1] power hint.
 */

import { encodeText } from '@cyber-shapes/shared';

/** The 1-per-3 s recharge window (mirrors MET_LAUNCH_INTERVAL_MS server-side). */
export const SLINGSHOT_COOLDOWN_MS = 3_000;

/** A live socket that can send (the crowd join's ws). */
export interface SlingshotSocket {
  send(data: string): void;
}

export interface SlingshotHandle {
  /** Detach listeners + free the canvas. */
  release(): void;
}

/**
 * Build the `met-launch` message a slingshot sends. `aim` is a unit-ish direction
 * from the drag (dx,dy on the phone → an aim toward the crystal); `power` ∈ [0,1]
 * is the normalised pull distance (the server clamps the actual speed). colorIndex
 * is the launcher's assigned palette slot (per-launcher meteor colors, §7.6).
 */
export function makeMetLaunchMessage(
  aim: { x: number; y: number; z: number },
  power: number,
  colorIndex: number
): { t: 'met-launch'; origin: { x: number; y: number; z: number }; aim: { x: number; y: number; z: number }; power: number; colorIndex: number } {
  return {
    t: 'met-launch',
    // The origin is a ring position around the crystal; the exact point is not
    // load-bearing (the server re-derives an arc), so a fixed launch ring is fine.
    origin: { x: aim.x * -9, y: 2, z: aim.z * -9 },
    aim,
    power: Math.max(0, Math.min(1, power)),
    colorIndex,
  };
}

/**
 * Map a drag vector (dx, dy in canvas px, from the anchor) to an aim direction in
 * world space + a power. Pulling DOWN-LEFT slings UP-RIGHT toward the crystal (a
 * classic slingshot invert). The aim is in the XZ plane with a fixed upward bias
 * baked server-side; we send a horizontal aim + a small vertical component.
 */
export function dragToLaunch(
  dx: number,
  dy: number,
  maxPull: number
): { aim: { x: number; y: number; z: number }; power: number } {
  const pull = Math.min(maxPull, Math.hypot(dx, dy));
  const power = maxPull > 0 ? pull / maxPull : 0;
  // Invert: the sling fires OPPOSITE the pull. Map phone-screen y → world z.
  const len = Math.hypot(dx, dy) || 1;
  const aim = { x: -dx / len, y: 0.3, z: -dy / len };
  return { aim, power };
}

/**
 * Mount the slingshot UI into `container` and wire it to `ws` (the crowd join).
 * `colorIndex` is the launcher's assigned meteor color. Returns a release handle.
 */
export function mountSlingshot(
  container: HTMLElement,
  ws: SlingshotSocket,
  opts: { colorIndex?: number; doc?: Document; now?: () => number } = {}
): SlingshotHandle {
  const doc = opts.doc ?? container.ownerDocument;
  const now = opts.now ?? (() => Date.now());
  const colorIndex = opts.colorIndex ?? 0;

  const wrap = doc.createElement('div');
  wrap.className = 'slingshot';

  const prompt = doc.createElement('div');
  prompt.className = 'slingshot-prompt';
  prompt.textContent = 'DRAG BACK — SLING AT THE CRYSTAL';
  wrap.appendChild(prompt);

  const canvas = doc.createElement('canvas');
  canvas.className = 'slingshot-canvas';
  canvas.width = 320;
  canvas.height = 320;
  canvas.dataset['role'] = 'slingshot-canvas';
  wrap.appendChild(canvas);

  container.appendChild(wrap);

  const ctx = canvas.getContext('2d');
  const maxPull = 140;
  const anchor = { x: canvas.width / 2, y: canvas.height / 2 };
  let dragging = false;
  let cur = { x: anchor.x, y: anchor.y };
  let lastFireAt = -Infinity;

  function cooldownRemaining(): number {
    return Math.max(0, SLINGSHOT_COOLDOWN_MS - (now() - lastFireAt));
  }

  function redraw(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(2, 6, 20, 1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The crystal marker (up-right, the target).
    ctx.fillStyle = '#9900ff';
    ctx.shadowColor = '#9900ff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y - 90, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // The recharge ring.
    const rem = cooldownRemaining();
    const frac = rem > 0 ? rem / SLINGSHOT_COOLDOWN_MS : 0;
    ctx.strokeStyle = rem > 0 ? '#ff6600' : '#00ff66';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, 22, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2);
    ctx.stroke();
    // The pull band.
    if (dragging) {
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.stroke();
    }
  }

  function pointerPos(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : ({ left: 0, top: 0, width: canvas.width, height: canvas.height } as DOMRect);
    const sx = canvas.width / (rect.width || canvas.width);
    const sy = canvas.height / (rect.height || canvas.height);
    return {
      x: ((ev as MouseEvent).clientX - rect.left) * sx,
      y: ((ev as MouseEvent).clientY - rect.top) * sy,
    };
  }

  function onDown(ev: PointerEvent): void {
    dragging = true;
    cur = pointerPos(ev);
    redraw();
  }
  function onMove(ev: PointerEvent): void {
    if (!dragging) return;
    cur = pointerPos(ev);
    redraw();
  }
  function onUp(): void {
    if (!dragging) return;
    dragging = false;
    const dx = cur.x - anchor.x;
    const dy = cur.y - anchor.y;
    if (cooldownRemaining() <= 0 && Math.hypot(dx, dy) > 12) {
      const { aim, power } = dragToLaunch(dx, dy, maxPull);
      ws.send(encodeText(makeMetLaunchMessage(aim, power, colorIndex) as never));
      lastFireAt = now();
      prompt.textContent = 'FIRED — RELOADING…';
    }
    cur = { x: anchor.x, y: anchor.y };
    redraw();
  }

  canvas.addEventListener('pointerdown', onDown as EventListener);
  canvas.addEventListener('pointermove', onMove as EventListener);
  canvas.addEventListener('pointerup', onUp as EventListener);
  canvas.addEventListener('pointerleave', onUp as EventListener);

  redraw();

  return {
    release(): void {
      canvas.removeEventListener('pointerdown', onDown as EventListener);
      canvas.removeEventListener('pointermove', onMove as EventListener);
      canvas.removeEventListener('pointerup', onUp as EventListener);
      canvas.removeEventListener('pointerleave', onUp as EventListener);
      wrap.remove();
    },
  };
}
