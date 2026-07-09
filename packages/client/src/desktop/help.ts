/**
 * desktop/help.ts — the F22 Desktop Command help overlay content (spec §7.22).
 *
 * The `?` help overlay renders the COMPLETE normative keymap (§7.22). Keeping the
 * rows in one exported table means the help overlay and the keymap can never drift:
 * a new binding is added here and in `input.ts` together (a test asserts the full
 * set is present in the rendered overlay).
 *
 * DOM-free data + one tiny renderer. No THREE, no network — pure presentation.
 */

/** One help row: the key label + what it does. */
export interface HelpRow {
  key: string;
  label: string;
}

/**
 * The COMPLETE §7.22 keymap, including the AS-BUILT Phase A mouse path (LMB/RMB/
 * wheel) and bindings so the overlay is a real reference, not just the new keys.
 */
export const HELP_ROWS: readonly HelpRow[] = [
  { key: 'LMB', label: 'select / grab-drag (release throws — Phase A)' },
  { key: 'RMB / drag', label: 'look (mode-dependent)' },
  { key: 'Wheel', label: 'zoom / scale held shape' },
  { key: 'Click empty', label: 'spawn a shape (Phase A)' },
  { key: 'T', label: 'spawn a shape' },
  { key: 'C', label: 'recolor the held / last-touched shape' },
  { key: 'V', label: 'cycle render mode' },
  { key: '1', label: 'camera: ORBIT' },
  { key: '2', label: 'camera: FLY (WASD + mouse-look, Shift = fast)' },
  { key: '3', label: 'camera: FOLLOW (Tab cycles residents / wisps)' },
  { key: '4', label: 'camera: AUTO (the auto-director)' },
  { key: 'Tab', label: 'follow next resident / wisp' },
  { key: 'B', label: 'open / focus the ballot' },
  { key: '`', label: 'push-to-talk (hold)' },
  { key: 'M', label: 'mute / unmute' },
  { key: '?', label: 'toggle this help' },
] as const;

/** The overlay title. */
export const HELP_TITLE = 'DESKTOP COMMAND — KEYMAP';

/**
 * Render the help rows into a container element. Pure DOM construction (no styling
 * beyond data attributes; the host stylesheet owns the look). Idempotent: clears
 * `container` first.
 */
export function renderHelp(doc: Document, container: HTMLElement): void {
  container.textContent = '';
  const title = doc.createElement('div');
  title.className = 'desktop-help-title';
  title.textContent = HELP_TITLE;
  container.appendChild(title);

  const table = doc.createElement('div');
  table.className = 'desktop-help-table';
  for (const row of HELP_ROWS) {
    const r = doc.createElement('div');
    r.className = 'desktop-help-row';

    const k = doc.createElement('span');
    k.className = 'desktop-help-key';
    k.textContent = row.key;
    r.appendChild(k);

    const l = doc.createElement('span');
    l.className = 'desktop-help-label';
    l.textContent = row.label;
    r.appendChild(l);

    table.appendChild(r);
  }
  container.appendChild(table);
}
