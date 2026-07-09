/**
 * builder/glyphSeeder.ts — glyph seeder panel (spec §7.23, C35).
 *
 * Reuses the C12 kaleidoscope canvas (drawKaleidoscope + toNormalized from
 * funnel/scribe.ts) plus a ring/slot placement preview. On SEND GLYPH the
 * stroke is submitted as a GLYPH_SEED BUILD op (bypasses the C12 inflow
 * bucket; marks `seeded: true`; refused server-side past SEEDED_GLYPH_CAP).
 *
 * DOM-only: imported only by the builder entry chunk (?mode=build). Safe to
 * import Three in the same chunk; the funnel entries never reach this file.
 */

import { BUILD_KIND, resampleStroke, type GlyphStrokePoint } from '@cyber-shapes/shared';
import { drawKaleidoscope, toNormalized, SCRIBE_COLORS } from '../funnel/scribe.js';

export interface GlyphSeederOpts {
  /** Called with the GLYPH_SEED BUILD op when the user clicks SEND GLYPH. */
  send: (msg: unknown) => void;
  /** Container's ownerDocument (injected for testability). */
  doc?: Document;
}

export interface GlyphSeederHandle {
  release(): void;
}

/**
 * Mount the glyph seeder UI into `container`.
 *
 * Provides:
 *   • kaleidoscope 2D canvas (reused from C12 scribe) for drawing the glyph.
 *   • Ring/slot placement preview (static grid showing available slots).
 *   • SEND GLYPH button (disabled until a stroke is drawn).
 */
export function mountGlyphSeeder(container: HTMLElement, opts: GlyphSeederOpts): GlyphSeederHandle {
  const doc = opts.doc ?? container.ownerDocument ?? document;

  const wrap = doc.createElement('div');
  wrap.className = 'glyph-seeder';
  wrap.dataset['role'] = 'glyph-seeder';

  // ── Title ────────────────────────────────────────────────────────────────
  const title = doc.createElement('h3');
  title.className = 'glyph-seeder-title';
  title.textContent = 'SEED GLYPH';
  wrap.appendChild(title);

  // ── Kaleidoscope canvas (C12 reuse) ──────────────────────────────────────
  const canvas = doc.createElement('canvas');
  canvas.className = 'glyph-seeder-canvas';
  canvas.dataset['role'] = 'glyph-seeder-canvas';
  canvas.width = 320;
  canvas.height = 320;
  wrap.appendChild(canvas);

  // ── Color palette ────────────────────────────────────────────────────────
  const paletteEl = doc.createElement('div');
  paletteEl.className = 'glyph-seeder-palette';
  let color = SCRIBE_COLORS[0];

  for (const c of SCRIBE_COLORS) {
    const swatch = doc.createElement('button');
    swatch.type = 'button';
    swatch.className = 'glyph-seeder-swatch';
    swatch.style.background = c;
    swatch.dataset['color'] = c;
    swatch.addEventListener('click', () => {
      color = c;
      redraw();
    });
    paletteEl.appendChild(swatch);
  }
  wrap.appendChild(paletteEl);

  // ── Ring/slot placement preview ──────────────────────────────────────────
  const preview = doc.createElement('div');
  preview.className = 'glyph-placement-preview';
  preview.dataset['role'] = 'glyph-placement-preview';

  const previewLabel = doc.createElement('span');
  previewLabel.className = 'glyph-placement-label';
  previewLabel.textContent = 'PLACEMENT: NEXT AVAILABLE SLOT';
  preview.appendChild(previewLabel);

  // Ring indicator canvas (simplified slot grid)
  const ringCanvas = doc.createElement('canvas');
  ringCanvas.className = 'glyph-ring-canvas';
  ringCanvas.dataset['role'] = 'glyph-ring-canvas';
  ringCanvas.width = 200;
  ringCanvas.height = 200;
  preview.appendChild(ringCanvas);
  wrap.appendChild(preview);

  // Draw a simple ring preview (static indicator — real slot from server ACK)
  const ringCtx = ringCanvas.getContext('2d');
  if (ringCtx) {
    ringCtx.clearRect(0, 0, 200, 200);
    ringCtx.strokeStyle = '#00ffff';
    ringCtx.lineWidth = 1;
    // Draw 3 concentric rings to represent placement zones
    for (let r = 1; r <= 3; r++) {
      ringCtx.beginPath();
      ringCtx.arc(100, 100, r * 30, 0, Math.PI * 2);
      ringCtx.stroke();
    }
    // Mark "next slot" with a neon dot on ring 1
    ringCtx.fillStyle = '#ff00ff';
    ringCtx.beginPath();
    ringCtx.arc(100 + 30, 100, 5, 0, Math.PI * 2);
    ringCtx.fill();
  }

  // ── Clear + SEND GLYPH actions ───────────────────────────────────────────
  const actions = doc.createElement('div');
  actions.className = 'glyph-seeder-actions';

  const clearBtn = doc.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'glyph-seeder-clear';
  clearBtn.textContent = 'CLEAR';
  actions.appendChild(clearBtn);

  const sendBtn = doc.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'glyph-seeder-send';
  sendBtn.dataset['role'] = 'glyph-seed-send';
  sendBtn.textContent = 'SEND GLYPH';
  sendBtn.disabled = true;
  actions.appendChild(sendBtn);

  wrap.appendChild(actions);
  container.appendChild(wrap);

  // ── Drawing logic ─────────────────────────────────────────────────────────
  const ctx = canvas.getContext('2d');
  let stroke: GlyphStrokePoint[] = [];
  let drawing = false;

  function redraw(): void {
    if (ctx) drawKaleidoscope(ctx, stroke, color, canvas.width, canvas.height);
    sendBtn.disabled = stroke.length < 2;
  }

  function canvasCoords(ev: PointerEvent | MouseEvent): { x: number; y: number } {
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
    drawing = true;
    stroke = [];
    const { x, y } = canvasCoords(ev);
    stroke.push(toNormalized(x, y, canvas.width, canvas.height));
    redraw();
  }
  function onMove(ev: PointerEvent): void {
    if (!drawing) return;
    const { x, y } = canvasCoords(ev);
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
    const points = resampleStroke(stroke);
    opts.send({ t: 'build', kind: BUILD_KIND.GLYPH_SEED, points, color });
    // Reset after send
    stroke = [];
    redraw();
    const label = preview.querySelector('.glyph-placement-label');
    if (label) label.textContent = 'GLYPH SEEDED — check the world view';
  });

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
