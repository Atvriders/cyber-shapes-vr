/**
 * builder/builder.ts — ?mode=build desktop-only entry (spec §7.23, C35).
 *
 * This module is the TOP-LEVEL entry for the builder chunk (?mode=build). It:
 *   1. Detects BUILD capability (resident + ownerToken present in the URL/WS).
 *   2. If absent: renders the read-only fallback ("staff link required") — NEVER
 *      a dead/blank page (spec §7.23 "read-only fallback").
 *   3. If present: mounts the full builder UI:
 *        • Three.js scene with GizmoRig (TransformControls + snap)
 *        • PalettePanel (10 × 7 × 3 → SPAWN_EXACT)
 *        • OpStack wired to the WS send callback
 *        • LayoutPanel (list/save/load/set-baseline/delete + settle preview)
 *        • GlyphSeeder (kaleidoscope canvas → GLYPH_SEED)
 *      reusing C33 CameraRig (orbit/fly while building).
 *
 * BUNDLE ISOLATION: this file is the dynamic entry for the builder chunk. It
 * is NOT statically imported by main.ts / funnel / stage — it lives behind
 * `?mode=build` routing so Rollup keeps it in its own output chunk.
 *
 * READ-ONLY FALLBACK and FULL BUILDER are both exported so builder.dom.test.ts
 * can test the fallback without instantiating a WebGL context.
 *
 * TOP-LEVEL BOOTSTRAP: at the BOTTOM of this file, a DOMContentLoaded-guarded
 * block auto-runs when the module is loaded in a real browser against
 * `#builder-root` (the element in index.html). This side-effect is what
 * prevents Rollup from tree-shaking the entire builder module graph away.
 * The guard (`#builder-root` must exist) ensures the auto-run does NOT fire
 * when the module is imported by tests (jsdom creates a clean document with no
 * `#builder-root` element).
 */

import { BUILD_KIND, settleBake, DEFAULT_PARAMS } from '@cyber-shapes/shared';
import type { SettleBakeResult, Layout, LayoutShape } from '@cyber-shapes/shared';
import { OpStack, paletteToSpawnPayload, type BuildOp } from './undo.js';
import { mountLayoutPanel, isBlockedByUnsettled, type LayoutEntry } from './layoutPanel.js';
import { mountGlyphSeeder } from './glyphSeeder.js';
import { PALETTE_TYPES, PALETTE_RENDER_MODES, PALETTE_COLOR_COUNT } from './palette.js';

// ---------------------------------------------------------------------------
// Read-only fallback (capability-absent path, spec §7.23 — NEVER a dead page).
// ---------------------------------------------------------------------------

/**
 * Mount the capability-absent read-only notice into `container`.
 * Exported so builder.dom.test.ts can test it without a WebGL context.
 */
export function mountBuilderFallback(container: HTMLElement): void {
  const doc = container.ownerDocument ?? document;

  const el = doc.createElement('div');
  el.className = 'builder-fallback';
  el.dataset['role'] = 'builder-fallback';

  const title = doc.createElement('h2');
  title.className = 'builder-fallback-title';
  title.textContent = 'WORKSHOP — VIEW ONLY';
  el.appendChild(title);

  const notice = doc.createElement('p');
  notice.className = 'builder-fallback-notice';
  notice.textContent =
    'Staff link required to enter build mode. ' +
    'Open the Workshop with the owner link to compose, save, and bake layouts.';
  el.appendChild(notice);

  const badge = doc.createElement('span');
  badge.className = 'builder-fallback-badge';
  badge.textContent = 'STAFF LINK REQUIRED';
  el.appendChild(badge);

  container.appendChild(el);
}

// ---------------------------------------------------------------------------
// BuilderSession — the full builder UI (BUILD capability present).
// ---------------------------------------------------------------------------

export interface BuilderSendFn {
  (msg: { t: 'build'; kind: number; [key: string]: unknown }): void;
}

export interface BuilderSessionOpts {
  container: HTMLElement;
  send: BuilderSendFn;
  /** Called when the WS receives a BUILD ACK (echoes opId + assigned id). */
  onReady?: () => void;
  /**
   * The initial live shape list (id + shape data). The session tracks this list
   * internally — the host wires updates via `updateLiveShapes`. The settle-preview
   * runs `settleBake` over this list; BAKE emits SET_TRANSFORM with the real ids.
   * Defaults to [] (empty world) when absent.
   */
  initialShapes?: Array<{ id: string; shape: LayoutShape }>;
}

export interface BuilderSession {
  /** Call when a BUILD ACK arrives from the server (opId + assigned id). */
  onBuildAck(opId: string, newId: string, result: string): void;
  /** Call when a LAYOUT_LIST is received from the server. */
  onLayoutList(layouts: LayoutEntry[]): void;
  /** Call when build-mode exit / RESET fires — clears the undo stack. */
  onBuildExit(): void;
  /** Call when LAYOUT_LOAD is received — clears the undo stack. */
  onLayoutLoad(): void;
  /**
   * Update the live shape list (e.g. after a LAYOUT_LOAD or server-push). The
   * settle-preview and BAKE handlers derive the current layout from this list.
   */
  updateLiveShapes(shapes: Array<{ id: string; shape: LayoutShape }>): void;
  /** Unmount and release all resources. */
  unmount(): void;
}

/**
 * Mount the full builder session (BUILD capability confirmed) into `container`.
 * Returns a handle for server-event wiring and cleanup.
 */
export function mountBuilderSession(opts: BuilderSessionOpts): BuilderSession {
  const { container, send } = opts;
  const doc = container.ownerDocument ?? document;

  // ── Live shape registry ───────────────────────────────────────────────────
  // Tracks the current live shapes (id + authored data). The settle-preview
  // derives a Layout from this list; BAKE emits SET_TRANSFORM with real ids.
  // The host wires updates via session.updateLiveShapes().
  let liveShapes: Array<{ id: string; shape: LayoutShape }> = opts.initialShapes
    ? [...opts.initialShapes]
    : [];

  /** Build a Layout snapshot from the current live shape list. */
  function currentLayout(): Layout {
    return {
      name: '__preview__',
      author: 'builder',
      savedAt: 0,
      shapes: liveShapes.map((s) => ({ ...s.shape })),
    };
  }

  // Wrap raw send into the opaque BuildOp dispatcher.
  // Also accepts `unknown` for layout-panel / glyph-seeder which emit pre-built
  // objects directly (they carry the `t:'build'` key internally).
  const sendOp = (op: BuildOp | unknown): void => {
    const msg = op as Record<string, unknown>;
    send({ t: 'build', ...msg } as Parameters<BuilderSendFn>[0]);
  };

  // ── OpStack ──────────────────────────────────────────────────────────────
  const stack = new OpStack(sendOp);

  // ── Root shell ────────────────────────────────────────────────────────────
  const shell = doc.createElement('div');
  shell.className = 'builder-shell';
  shell.dataset['role'] = 'builder-shell';
  container.appendChild(shell);

  // ── Sidebar (palette + layout panel + glyph seeder) ───────────────────────
  const sidebar = doc.createElement('div');
  sidebar.className = 'builder-sidebar';
  shell.appendChild(sidebar);

  // Palette panel
  const paletteSec = doc.createElement('section');
  paletteSec.className = 'builder-palette-section';
  const paletteTitle = doc.createElement('h3');
  paletteTitle.textContent = 'PALETTE';
  paletteSec.appendChild(paletteTitle);

  // Render palette grid (10 types × 7 colors × 3 render modes)
  const paletteGrid = doc.createElement('div');
  paletteGrid.className = 'builder-palette-grid';
  paletteGrid.dataset['role'] = 'builder-palette-grid';

  let selectedTypeIdx = 0;
  let selectedColorIdx = 0;
  let selectedRenderIdx = 0;

  // Type buttons
  for (let i = 0; i < PALETTE_TYPES.length; i++) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `palette-type-btn${i === 0 ? ' selected' : ''}`;
    btn.dataset['typeIndex'] = String(i);
    btn.dataset['role'] = 'palette-type';
    btn.textContent = PALETTE_TYPES[i];
    btn.addEventListener('click', () => { selectedTypeIdx = i; });
    paletteGrid.appendChild(btn);
  }
  paletteSec.appendChild(paletteGrid);

  // Color swatches (7 colors)
  const colorRow = doc.createElement('div');
  colorRow.className = 'palette-color-row';
  for (let i = 0; i < PALETTE_COLOR_COUNT; i++) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `palette-color-btn${i === 0 ? ' selected' : ''}`;
    btn.dataset['colorIndex'] = String(i);
    btn.dataset['role'] = 'palette-color';
    btn.textContent = String(i);
    btn.addEventListener('click', () => { selectedColorIdx = i; });
    colorRow.appendChild(btn);
  }
  paletteSec.appendChild(colorRow);

  // Render mode buttons
  const renderRow = doc.createElement('div');
  renderRow.className = 'palette-render-row';
  for (let i = 0; i < PALETTE_RENDER_MODES.length; i++) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `palette-render-btn${i === 0 ? ' selected' : ''}`;
    btn.dataset['renderIndex'] = String(i);
    btn.dataset['role'] = 'palette-render';
    btn.textContent = PALETTE_RENDER_MODES[i];
    btn.addEventListener('click', () => { selectedRenderIdx = i; });
    renderRow.appendChild(btn);
  }
  paletteSec.appendChild(renderRow);

  // SPAWN button
  const spawnBtn = doc.createElement('button');
  spawnBtn.type = 'button';
  spawnBtn.className = 'palette-spawn-btn';
  spawnBtn.dataset['role'] = 'palette-spawn';
  spawnBtn.textContent = 'SPAWN AT ORIGIN';
  spawnBtn.addEventListener('click', () => {
    const op = paletteToSpawnPayload({
      typeIndex: selectedTypeIdx,
      colorIndex: selectedColorIdx,
      renderModeIndex: selectedRenderIdx,
      position: { x: 0, y: 2, z: 0 },
    });
    // Inverse of SPAWN_EXACT is DELETE. The DELETE's target id is unknown until
    // the server ACKs the spawn. We store the spawn opId in the inverse op so
    // onBuildAck can remap via stack.onAck(op.opId, newId) → undo emits the
    // correct id.
    //
    // NOTE (C35 Minor): id:'__pending__' is a sentinel. If the user undoes before
    // the server ACK arrives, the stack emits DELETE('__pending__') which is a
    // server no-op (no shape has that id). This is acceptable: undo-before-ack
    // races are silently dropped. Once the ACK arrives, onAck() remaps the id
    // so subsequent undo/redo correctly targets the real server-assigned id.
    const inv: BuildOp = { kind: BUILD_KIND.DELETE, id: '__pending__', opId: `del-inv-${Date.now()}` };
    // Push records the entry; send actually dispatches the op to the server.
    stack.push(op, inv);
    sendOp(op);
  });
  paletteSec.appendChild(spawnBtn);
  sidebar.appendChild(paletteSec);

  // Undo/redo buttons
  const undoRow = doc.createElement('div');
  undoRow.className = 'builder-undo-row';
  const undoBtn = doc.createElement('button');
  undoBtn.type = 'button';
  undoBtn.dataset['role'] = 'builder-undo';
  undoBtn.textContent = 'UNDO (Ctrl+Z)';
  undoBtn.addEventListener('click', () => stack.undo());
  const redoBtn = doc.createElement('button');
  redoBtn.type = 'button';
  redoBtn.dataset['role'] = 'builder-redo';
  redoBtn.textContent = 'REDO (Ctrl+Y)';
  redoBtn.addEventListener('click', () => stack.redo());
  undoRow.appendChild(undoBtn);
  undoRow.appendChild(redoBtn);
  sidebar.appendChild(undoRow);

  // Settle preview section
  const settleSec = doc.createElement('section');
  settleSec.className = 'builder-settle-section';
  const settleTitle = doc.createElement('h3');
  settleTitle.textContent = 'SETTLE PREVIEW';
  settleSec.appendChild(settleTitle);

  const settleStatus = doc.createElement('p');
  settleStatus.className = 'builder-settle-status';
  settleStatus.dataset['role'] = 'builder-settle-status';
  settleStatus.textContent = 'No preview yet.';
  settleSec.appendChild(settleStatus);

  const settlePreviewBtn = doc.createElement('button');
  settlePreviewBtn.type = 'button';
  settlePreviewBtn.dataset['role'] = 'builder-settle-preview';
  settlePreviewBtn.textContent = 'PREVIEW SETTLE';
  let lastSettleResult: SettleBakeResult | null = null;

  settlePreviewBtn.addEventListener('click', () => {
    const layout = currentLayout();
    if (layout.shapes.length === 0) {
      settleStatus.textContent = 'No shapes in the world to preview.';
      bakeBtn.disabled = true;
      return;
    }
    // Run the PURE local settleBake — no WebGL needed. This assigns lastSettleResult
    // so the BAKE handler has real settled positions to commit.
    const result = settleBake(layout, DEFAULT_PARAMS);
    lastSettleResult = result;
    if (result.settled) {
      settleStatus.textContent =
        `Settled OK — ${result.layout.shapes.length} shape(s). Click BAKE to commit.`;
      bakeBtn.disabled = false;
    } else {
      settleStatus.textContent =
        `Did not settle within iteration bound (${result.warnings.join('; ')}). ` +
        'BAKE blocked — adjust the layout and try again.';
      bakeBtn.disabled = true;
    }
  });
  settleSec.appendChild(settlePreviewBtn);

  const bakeBtn = doc.createElement('button');
  bakeBtn.type = 'button';
  bakeBtn.dataset['role'] = 'builder-bake';
  bakeBtn.textContent = 'BAKE';
  bakeBtn.disabled = true; // enabled only after a successful settle preview

  bakeBtn.addEventListener('click', () => {
    const sr: SettleBakeResult | null = lastSettleResult;
    if (!sr || isBlockedByUnsettled(sr)) {
      settleStatus.textContent = 'ERROR: layout did not fully settle — BAKE blocked.';
      return;
    }
    // sr.settled === true: emit one SET_TRANSFORM per shape with the REAL live shape id.
    // liveShapes[i].id is the server-assigned id (from ACK); sr.layout.shapes[i] has
    // the settled position. The parallel index is guaranteed because settleBake
    // preserves the input order and currentLayout() builds shapes[] from liveShapes[].
    for (let i = 0; i < sr.layout.shapes.length; i++) {
      const realId = liveShapes[i]?.id;
      if (!realId) continue; // guard: liveShapes mutated between preview and bake
      const s = sr.layout.shapes[i];
      send({
        t: 'build',
        kind: BUILD_KIND.SET_TRANSFORM,
        id: realId,
        shape: s,
      });
    }
  });
  settleSec.appendChild(bakeBtn);
  sidebar.appendChild(settleSec);

  // Layout panel
  const layoutSec = doc.createElement('section');
  layoutSec.className = 'builder-layout-section';
  const layoutPanel = mountLayoutPanel(layoutSec, { layouts: [], send: sendOp });
  sidebar.appendChild(layoutSec);

  // Glyph seeder
  const glyphSec = doc.createElement('section');
  glyphSec.className = 'builder-glyph-section';
  mountGlyphSeeder(glyphSec, { send: sendOp });
  sidebar.appendChild(glyphSec);

  return {
    onBuildAck(opId: string, newId: string, result: string): void {
      if (result === 'ok') {
        // Remap the stack so undo-of-DELETE targets the correct new id
        stack.onAck(opId, newId);
      }
    },
    onLayoutList(layouts: LayoutEntry[]): void {
      layoutPanel.update(layouts);
    },
    onBuildExit(): void {
      stack.clearOnBuildExit();
    },
    onLayoutLoad(): void {
      stack.clearOnLayoutLoad();
    },
    updateLiveShapes(shapes: Array<{ id: string; shape: LayoutShape }>): void {
      liveShapes = [...shapes];
      // Invalidate the stale settle preview when the world changes.
      lastSettleResult = null;
      bakeBtn.disabled = true;
      settleStatus.textContent = 'No preview yet.';
    },
    unmount(): void {
      layoutPanel.unmount();
      shell.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Entry bootstrap — called from index.html when ?mode=build is in the URL.
// ---------------------------------------------------------------------------

/**
 * Detect BUILD capability from URL params (ownerToken presence signals the
 * staff link was used; the server confirms at join — this gates the UI eagerly
 * so the page renders instantly without a round-trip).
 */
export function hasBuildCapability(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.has('ownerToken') || params.get('mode') === 'build';
}

/**
 * Bootstrap the builder page. Called from the builder entry HTML.
 * Checks for BUILD capability and mounts either the full builder or
 * the read-only fallback.
 */
export function bootstrapBuilder(container: HTMLElement, send: BuilderSendFn): BuilderSession | null {
  if (!hasBuildCapability()) {
    mountBuilderFallback(container);
    return null;
  }
  return mountBuilderSession({ container, send });
}

// ---------------------------------------------------------------------------
// AUTO-RUN: top-level bootstrap side-effect (RETAINS the builder module graph).
//
// This block runs when the module is loaded as an ES module in a real browser
// (i.e. from index.html's `<script type="module" src="./builder.ts">`). It is
// the LIVE SIDE-EFFECT that prevents Rollup from tree-shaking the entire builder
// module graph away (Critical 1 fix — without this, the page renders a dead
// #builder-root because every exported function is dead code from Rollup's view).
//
// GUARD: only auto-run when `#builder-root` exists in the document. This element
// is present in src/builder/index.html but NOT in jsdom's clean document, so tests
// that import this module will NOT trigger the auto-bootstrap. This is the standard
// "only if the mount element exists" pattern for ESM entry points.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const _autoRun = (): void => {
    const root = document.getElementById('builder-root');
    if (!root) return; // not the builder page (e.g. imported in a test) — skip

    // No-op WS send until a real connection is established. The host page wires
    // the real send callback once the WS handshake completes. For now, bootstrap
    // the UI immediately so the page is responsive from the first paint.
    let _send: BuilderSendFn = () => { /* no-op until WS is wired */ };
    const sendProxy: BuilderSendFn = (msg) => _send(msg);

    // Mount either the full builder or the read-only fallback.
    const session = bootstrapBuilder(root, sendProxy);

    // Expose the session on the window so the WS bootstrap code (injected by
    // the host page at runtime) can wire the real send callback and call
    // session.onBuildAck / session.onLayoutList / session.updateLiveShapes.
    const w = window as unknown as Record<string, unknown>;
    w['__builderSession__'] = session;
    w['__wireBuilderSend__'] = (realSend: BuilderSendFn) => {
      _send = realSend;
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoRun);
  } else {
    _autoRun();
  }
}
