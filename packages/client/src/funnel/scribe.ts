/**
 * funnel/scribe.ts — the phone Neon Guestbook scribe surface (spec §7.13, C12).
 *
 * DOM + 2D-canvas ONLY (NO three — the crowd chunk must stay < 100 KB gz, size
 * gate enforced). A touch/mouse draw surface with a LIVE 6-fold kaleidoscope
 * preview while drawing; on SEND the stroke is resampled (shared, pure) to ≤ 32
 * normalised points and submitted as a `glyph-add`. The scribe is an ephemeral
 * crowd guest: it joined on the crowd tier (never a resident slot).
 *
 * Coordinate space: the draw surface is normalised to [-1, 1] (center origin) so
 * the server's `validateGlyph` bounds check and `spiralSlot` placement agree with
 * every other screen.
 */

import { resampleStroke, encodeText, type GlyphStrokePoint } from '@cyber-shapes/shared';

/** How many mirror wedges the kaleidoscope preview draws (spec §7.13: 6-fold). */
export const KALEIDO_FOLDS = 6;

/** The neon palette the scribe offers (mirrors CYBER_COLORS hex, §6.1). */
export const SCRIBE_COLORS: readonly string[] = [
  '#00ffff',
  '#ff00ff',
  '#ff0066',
  '#0066ff',
  '#00ff66',
  '#9900ff',
  '#ff6600',
];

/** Map a canvas (px) point to the normalised [-1, 1] draw space (center origin). */
export function toNormalized(
  px: number,
  py: number,
  width: number,
  height: number
): GlyphStrokePoint {
  const size = Math.min(width, height);
  return {
    x: ((px - width / 2) / (size / 2)),
    y: ((py - height / 2) / (size / 2)),
  };
}

/**
 * Render the kaleidoscope preview of a raw stroke into a 2D context (spec §7.13
 * "live 6-fold kaleidoscope preview"). Pure-ish: draws `KALEIDO_FOLDS` rotated +
 * mirrored copies of the polyline. Exported so it is unit-testable (the DOM test
 * asserts it draws without throwing on an empty / one-point stroke).
 */
export function drawKaleidoscope(
  ctx: CanvasRenderingContext2D,
  stroke: readonly GlyphStrokePoint[],
  color: string,
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(2, 6, 20, 1)';
  ctx.fillRect(0, 0, width, height);
  if (stroke.length < 2) return;

  const cx = width / 2;
  const cy = height / 2;
  const size = Math.min(width, height) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = color;
  for (let f = 0; f < KALEIDO_FOLDS; f++) {
    const angle = (f / KALEIDO_FOLDS) * Math.PI * 2;
    for (const mirror of [1, -1]) {
      ctx.save();
      ctx.rotate(angle);
      ctx.scale(1, mirror);
      ctx.beginPath();
      for (let i = 0; i < stroke.length; i++) {
        const p = stroke[i];
        const x = p.x * size;
        const y = p.y * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

/** The message a scribe sends to submit its glyph (mirrors the ClientMsg). */
export function makeGlyphAddMessage(
  rawStroke: readonly GlyphStrokePoint[],
  color: string
): { t: 'glyph-add'; points: GlyphStrokePoint[]; color: string } {
  return {
    t: 'glyph-add',
    points: resampleStroke(rawStroke),
    color,
  };
}

/** A live socket that can send + listen (the crowd join's ws). */
export interface ScribeSocket {
  send(data: string): void;
  addEventListener?(type: string, cb: (ev: { data: unknown }) => void): void;
}

export interface ScribeHandle {
  /** Detach listeners + free the canvases. */
  release(): void;
}

/**
 * Mount the scribe UI into `container` and wire it to `ws` (the crowd join). The
 * `onAck` callback fires with {callsign, ring} when the server acks the glyph
 * (closes the loop even with no projector). Returns a handle to release it.
 */
export function mountScribe(
  container: HTMLElement,
  ws: ScribeSocket,
  opts: { onAck?: (callsign: string, ring: number) => void; doc?: Document } = {}
): ScribeHandle {
  const doc = opts.doc ?? container.ownerDocument;

  const wrap = doc.createElement('div');
  wrap.className = 'scribe';

  const prompt = doc.createElement('div');
  prompt.className = 'scribe-prompt';
  prompt.textContent = 'DRAW YOUR MARK';
  wrap.appendChild(prompt);

  const canvas = doc.createElement('canvas');
  canvas.className = 'scribe-canvas';
  canvas.width = 320;
  canvas.height = 320;
  canvas.dataset['role'] = 'scribe-canvas';
  wrap.appendChild(canvas);

  // Color palette (curated neon — never free text on any surface, §6.1).
  const palette = doc.createElement('div');
  palette.className = 'scribe-palette';
  let color = SCRIBE_COLORS[0];
  for (const c of SCRIBE_COLORS) {
    const swatch = doc.createElement('button');
    swatch.type = 'button';
    swatch.className = 'scribe-swatch';
    swatch.style.background = c;
    swatch.dataset['color'] = c;
    swatch.addEventListener('click', () => {
      color = c;
      redraw();
    });
    palette.appendChild(swatch);
  }
  wrap.appendChild(palette);

  const actions = doc.createElement('div');
  actions.className = 'scribe-actions';
  const clearBtn = doc.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'scribe-clear';
  clearBtn.textContent = 'CLEAR';
  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'scribe-send';
  sendBtn.dataset['role'] = 'scribe-send';
  sendBtn.textContent = 'SEND TO THE VOID';
  sendBtn.disabled = true;
  actions.appendChild(clearBtn);
  actions.appendChild(sendBtn);
  wrap.appendChild(actions);

  container.appendChild(wrap);

  const ctx = canvas.getContext('2d');
  let stroke: GlyphStrokePoint[] = [];
  let drawing = false;

  function redraw(): void {
    if (ctx) drawKaleidoscope(ctx, stroke, color, canvas.width, canvas.height);
    sendBtn.disabled = stroke.length < 2;
  }

  function pointerPos(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : ({ left: 0, top: 0, width: canvas.width, height: canvas.height } as DOMRect);
    const sx = canvas.width / (rect.width || canvas.width);
    const sy = canvas.height / (rect.height || canvas.height);
    return { x: ((ev as MouseEvent).clientX - rect.left) * sx, y: ((ev as MouseEvent).clientY - rect.top) * sy };
  }

  function onDown(ev: PointerEvent): void {
    drawing = true;
    stroke = [];
    const { x, y } = pointerPos(ev);
    stroke.push(toNormalized(x, y, canvas.width, canvas.height));
    redraw();
  }
  function onMove(ev: PointerEvent): void {
    if (!drawing) return;
    const { x, y } = pointerPos(ev);
    stroke.push(toNormalized(x, y, canvas.width, canvas.height));
    redraw();
  }
  function onUp(): void {
    drawing = false;
    redraw();
  }

  canvas.addEventListener('pointerdown', onDown as EventListener);
  canvas.addEventListener('pointermove', onMove as EventListener);
  canvas.addEventListener('pointerup', onUp as EventListener);
  canvas.addEventListener('pointerleave', onUp as EventListener);

  clearBtn.addEventListener('click', () => {
    stroke = [];
    redraw();
  });

  sendBtn.addEventListener('click', () => {
    if (stroke.length < 2) return;
    ws.send(encodeText(makeGlyphAddMessage(stroke, color) as never));
    prompt.textContent = 'SENT — FIND YOUR GLYPH ON THE BIG SCREEN';
    stroke = [];
    redraw();
    sendBtn.disabled = true;
  });

  // Listen for the private glyph-ack ({callsign, ring}) — closes the loop.
  const onMsg = (ev: { data: unknown }): void => {
    if (typeof ev.data !== 'string') return;
    let msg: { t?: string; callsign?: string; ring?: number };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === 'glyph-ack' && typeof msg.callsign === 'string' && typeof msg.ring === 'number') {
      const ringText = msg.ring < 0 ? 'landing shortly' : `ring ${msg.ring}`;
      prompt.textContent = `YOU ARE ${msg.callsign} — your glyph is at ${ringText}`;
      opts.onAck?.(msg.callsign, msg.ring);
    }
  };
  ws.addEventListener?.('message', onMsg);

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
