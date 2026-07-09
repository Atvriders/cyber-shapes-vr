/**
 * builder/layoutPanel.ts — layout manager panel (spec §7.23, C35).
 *
 * Provides:
 *   • `mountLayoutPanel(container, opts)` — DOM layout manager:
 *       list / save / load / set-baseline / delete with confirms on destructive actions.
 *       Also: settle-preview toggle (runs settleBake locally, ghosts settled positions)
 *       and BAKE button (commits via SET_TRANSFORMs). BAKE is blocked when
 *       `settled: false` is returned by settleBake.
 *   • `isBlockedByUnsettled(result)` — pure BAKE-block guard (testable in node).
 *
 * DOM-bearing functions need jsdom; the pure `isBlockedByUnsettled` is node-safe.
 */

import { BUILD_KIND } from '@cyber-shapes/shared';
import type { SettleBakeResult } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// Pure BAKE-block guard (spec §7.23: "settled:false result BLOCKS the bake").
// ---------------------------------------------------------------------------

/**
 * Returns true when the settle preview result indicates the layout did NOT
 * fully settle — which BLOCKS the BAKE action (spec §7.23).
 */
export function isBlockedByUnsettled(result: SettleBakeResult): boolean {
  return !result.settled;
}

// ---------------------------------------------------------------------------
// Layout entry (mirrors the server's LAYOUT_LIST manifest entry).
// ---------------------------------------------------------------------------

export interface LayoutEntry {
  name: string;
  shapeCount: number;
  baseline: boolean;
}

export interface LayoutPanelOpts {
  layouts: LayoutEntry[];
  send: (msg: unknown) => void;
  /** Called when the user toggles settle-preview. Optional (builder wires it). */
  onSettlePreview?: (name: string) => void;
  /** Called when BAKE is confirmed and not blocked. Optional. */
  onBake?: (name: string) => void;
}

/**
 * Mount the layout manager panel into `container`.
 *
 * Destructive actions (DELETE / LAYOUT_LOAD / SET_BASELINE) show a confirm()
 * dialog before emitting. Cancel suppresses the send.
 */
export function mountLayoutPanel(container: HTMLElement, opts: LayoutPanelOpts): { update(layouts: LayoutEntry[]): void; unmount(): void } {
  const doc = container.ownerDocument ?? document;

  const panel = doc.createElement('div');
  panel.className = 'layout-panel';
  panel.dataset['role'] = 'layout-panel';
  container.appendChild(panel);

  function render(layouts: LayoutEntry[]): void {
    // Remove all children safely (no innerHTML)
    while (panel.firstChild) panel.removeChild(panel.firstChild);

    const title = doc.createElement('h3');
    title.className = 'layout-panel-title';
    title.textContent = 'LAYOUTS';
    panel.appendChild(title);

    if (layouts.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'layout-panel-empty';
      empty.textContent = 'No saved layouts.';
      panel.appendChild(empty);
    }

    for (const entry of layouts) {
      const row = doc.createElement('div');
      row.className = 'layout-row';
      row.dataset['name'] = entry.name;

      const nameSpan = doc.createElement('span');
      nameSpan.className = 'layout-name';
      nameSpan.textContent = `${entry.name} (${entry.shapeCount} shapes)${entry.baseline ? ' [BASELINE]' : ''}`;
      row.appendChild(nameSpan);

      // LOAD button (destructive — replaces the live world)
      const loadBtn = doc.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'layout-btn layout-btn--load';
      loadBtn.dataset['role'] = 'layout-load';
      loadBtn.textContent = 'LOAD';
      loadBtn.addEventListener('click', () => {
        const ok = (globalThis as { confirm?: (msg: string) => boolean }).confirm?.(
          `Load "${entry.name}"? This REPLACES the live world and cannot be undone.`
        ) ?? true;
        if (!ok) return;
        opts.send({ t: 'build', kind: BUILD_KIND.LAYOUT_LOAD, name: entry.name });
      });
      row.appendChild(loadBtn);

      // SET_BASELINE button (destructive — changes what RESET restores)
      const baselineBtn = doc.createElement('button');
      baselineBtn.type = 'button';
      baselineBtn.className = 'layout-btn layout-btn--baseline';
      baselineBtn.dataset['role'] = 'layout-set-baseline';
      baselineBtn.textContent = 'SET BASELINE';
      baselineBtn.addEventListener('click', () => {
        const ok = (globalThis as { confirm?: (msg: string) => boolean }).confirm?.(
          `Set "${entry.name}" as the RESET baseline? Every RESET will restore this layout.`
        ) ?? true;
        if (!ok) return;
        opts.send({ t: 'build', kind: BUILD_KIND.SET_BASELINE, name: entry.name });
      });
      row.appendChild(baselineBtn);

      // DELETE button (destructive — removes the saved layout)
      const deleteBtn = doc.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'layout-btn layout-btn--delete';
      deleteBtn.dataset['role'] = 'layout-delete';
      deleteBtn.textContent = 'DELETE';
      deleteBtn.addEventListener('click', () => {
        const ok = (globalThis as { confirm?: (msg: string) => boolean }).confirm?.(
          `Delete layout "${entry.name}"? This cannot be undone.`
        ) ?? true;
        if (!ok) return;
        // Carry #8 (C22): a REAL server-side delete — BUILD_KIND.LAYOUT_DELETE
        // removes the layout from the manifest (build-mode + capability gated,
        // exactly like the other mutating BUILD kinds). If it was the bound
        // RESET baseline, the server CLEARS it (falls back to the v1 seed list).
        opts.send({ t: 'build', kind: BUILD_KIND.LAYOUT_DELETE, name: entry.name });
      });
      row.appendChild(deleteBtn);

      panel.appendChild(row);
    }

    // Save-as section
    const saveSection = doc.createElement('div');
    saveSection.className = 'layout-save-section';

    const saveInput = doc.createElement('input');
    saveInput.type = 'text';
    saveInput.className = 'layout-save-input';
    saveInput.dataset['role'] = 'layout-save-name';
    saveInput.placeholder = 'Layout name…';
    saveSection.appendChild(saveInput);

    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'layout-btn layout-btn--save';
    saveBtn.dataset['role'] = 'layout-save';
    saveBtn.textContent = 'SAVE';
    saveBtn.addEventListener('click', () => {
      const name = saveInput.value.trim();
      if (!name) return;
      opts.send({ t: 'build', kind: BUILD_KIND.LAYOUT_SAVE, name });
    });
    saveSection.appendChild(saveBtn);
    panel.appendChild(saveSection);
  }

  render(opts.layouts);

  return {
    update(layouts: LayoutEntry[]) {
      render(layouts);
    },
    unmount() {
      panel.remove();
    },
  };
}
