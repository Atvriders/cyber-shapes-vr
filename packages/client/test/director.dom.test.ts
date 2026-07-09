/**
 * director.dom.test.ts — the F2 Showrunner director console (C10, spec §7.2).
 * jsdom. Covers the testable, three-free surface:
 *   • the two-tab UI (SHOW giant buttons + cues / ADVANCED everything else);
 *   • destructive cues CONFIRM; non-destructive never confirm;
 *   • wrongPhase / cooldown render as DISABLED states;
 *   • roster rows show tier + provenance (+ rttMs) and expose mute / disconnect;
 *   • the laptop hotkeys (Space=advance, F, H=hold+60, R=reset, P=panic);
 *   • the panic trigger + FIRE (idempotent instance id) + stateless re-render.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encodeText } from '@cyber-shapes/shared';
import type { ServerMsg, CueCatalogEntry } from '@cyber-shapes/shared';
import { DirectorConsole, HOTKEY_COMMANDS } from '../src/director/console.ts';

// ---------------------------------------------------------------------------
// Mock WebSocket (the console's handshake + command surface).
// ---------------------------------------------------------------------------
class MockWS {
  static instances: MockWS[] = [];
  readyState = 1;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWS.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  deliver(msg: ServerMsg) {
    this.onmessage?.({ data: encodeText(msg) });
  }
  lastCmd(): Record<string, unknown> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = JSON.parse(this.sent[i]) as Record<string, unknown>;
      if (m['t'] === 'director-cmd') return m;
    }
    return undefined;
  }
  cmds(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m['t'] === 'director-cmd');
  }
}

const SEED_CATALOG: CueCatalogEntry[] = [
  {
    id: 'shape-rain',
    label: 'SHAPE RAIN',
    tab: 'show',
    destructive: false,
    cooldownMs: 8000,
    phases: ['ATTRACT', 'LOBBY', 'PLAY'],
    comfortCost: 0,
  },
  {
    id: 'low-g',
    label: 'LOW-G',
    tab: 'show',
    destructive: false,
    cooldownMs: 30000,
    phases: ['ATTRACT', 'LOBBY', 'PLAY'],
    comfortCost: 1,
  },
  // A synthetic ADVANCED-tab DESTRUCTIVE cue (a stub — the compound bank is C11).
  {
    id: 'stub-purge',
    label: 'PURGE',
    tab: 'advanced',
    destructive: true,
    cooldownMs: 0,
    phases: ['ATTRACT', 'PLAY'],
    comfortCost: 0,
  },
  // A synthetic ADVANCED-tab FINALE-only cue → wrongPhase in ATTRACT (DISABLED).
  {
    id: 'stub-finale-only',
    label: 'FINALE ONLY',
    tab: 'advanced',
    destructive: false,
    cooldownMs: 0,
    phases: ['FINALE'],
    comfortCost: 0,
  },
];

function makeConsole(): { c: DirectorConsole; ws: () => MockWS } {
  MockWS.instances = [];
  const c = new DirectorConsole(document, {
    room: 'booth',
    ownerToken: 'tok',
    WebSocketImpl: MockWS as unknown as typeof WebSocket,
    now: () => 1000,
    noWakeLock: true,
  });
  document.body.appendChild(c.root);
  c.connect();
  return { c, ws: () => MockWS.instances[0] };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('C10 director console — connect + stateless re-render', () => {
  it('sends a director-tier join carrying the ownerToken', async () => {
    const { ws } = makeConsole();
    await Promise.resolve();
    const join = JSON.parse(ws().sent[0]) as Record<string, unknown>;
    expect(join['t']).toBe('join');
    expect(join['tier']).toBe('director');
    expect(join['ownerToken']).toBe('tok');
  });

  it('renders the phase header + catalog from PHASE_STATE + CATALOG (stateless)', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'PLAY', endsAt: 5000, remainingMs: 4000 });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    expect(c.currentPhase).toBe('PLAY');
    const phaseText = c.root.querySelector('[data-role="phase"]')!.textContent!;
    expect(phaseText).toContain('PLAY');
    // The two seed cues render on the SHOW tab.
    const showBtns = c.root.querySelectorAll('[data-role="show-tab"] .dc-cue-btn');
    expect([...showBtns].map((b) => (b as HTMLElement).dataset['cueId'])).toEqual([
      'shape-rain',
      'low-g',
    ]);
  });
});

describe('C10 director console — two-tab split + confirm + disabled', () => {
  it('splits SHOW (giant buttons + show cues) vs ADVANCED (everything else)', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    // Three GIANT timeline buttons on the SHOW tab.
    const giant = c.root.querySelectorAll('.dc-giant-btn');
    expect(giant.length).toBe(3);
    // ADVANCED cues.
    const adv = c.root.querySelectorAll('[data-role="advanced-tab"] .dc-cue-btn');
    expect([...adv].map((b) => (b as HTMLElement).dataset['cueId'])).toEqual([
      'stub-purge',
      'stub-finale-only',
    ]);
  });

  it('a DESTRUCTIVE cue confirms before firing (declined = no FIRE)', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    const purgeBtn = c.root.querySelector('[data-cue-id="stub-purge"]') as HTMLButtonElement;
    expect(purgeBtn.dataset['destructive']).toBe('true');

    // Decline the confirm → NO FIRE command is sent.
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    purgeBtn.click();
    expect(ws().cmds().some((m) => m['cmd'] === 'FIRE')).toBe(false);

    // Accept the confirm → a FIRE is sent.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    purgeBtn.click();
    const fire = ws().cmds().find((m) => m['cmd'] === 'FIRE');
    expect(fire).toBeDefined();
    expect(fire!['cueId']).toBe('stub-purge');
  });

  it('a NON-destructive cue fires WITHOUT a confirm', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    (c.root.querySelector('[data-cue-id="shape-rain"]') as HTMLButtonElement).click();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ws().cmds().find((m) => m['cmd'] === 'FIRE')!['cueId']).toBe('shape-rain');
  });

  it('a wrongPhase cue renders DISABLED and does not fire', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    const finaleBtn = c.root.querySelector('[data-cue-id="stub-finale-only"]') as HTMLButtonElement;
    expect(finaleBtn.disabled).toBe(true);
    expect(finaleBtn.dataset['disabled']).toBe('wrongPhase');
  });
});

describe('C10 director console — FIRE idempotency (client instance id)', () => {
  it('FIRE carries a client-generated cueInstanceId (server dedupes on it)', () => {
    const { c, ws } = makeConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    c.fireCue('shape-rain');
    const fire = ws().cmds().find((m) => m['cmd'] === 'FIRE')!;
    expect(typeof fire['cueInstanceId']).toBe('string');
    expect((fire['cueInstanceId'] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C22 carry #6 — the cooldown pill (previously never rendered: the `cooldowns`
// Map was declared but never `.set()`, so `(id) => this.cooldowns.get(id) ?? 0`
// always read 0 and the pill/disabled state never appeared).
// ---------------------------------------------------------------------------
describe('C10 director console — cooldown pill (carry #6)', () => {
  /** A console with a MUTABLE injected clock (makeConsole()'s now() is frozen). */
  function makeTickingConsole(): { c: DirectorConsole; ws: () => MockWS; advance: (ms: number) => void } {
    MockWS.instances = [];
    let clock = 1000;
    const c = new DirectorConsole(document, {
      room: 'booth',
      ownerToken: 'tok',
      WebSocketImpl: MockWS as unknown as typeof WebSocket,
      now: () => clock,
      noWakeLock: true,
    });
    document.body.appendChild(c.root);
    c.connect();
    return { c, ws: () => MockWS.instances[0], advance: (ms) => (clock += ms) };
  }

  it('after a dial fires, the console model shows the pill with remaining time + the button disabled; it clears when the cooldown elapses', () => {
    const { c, ws, advance } = makeTickingConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    const btn = () => c.root.querySelector('[data-cue-id="shape-rain"]') as HTMLButtonElement;

    // Before firing: enabled, no pill.
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).not.toContain('(');

    // Fire it, then the server ACKs ok (shape-rain's catalog cooldownMs = 8000).
    btn().click();
    ws().deliver({ t: 'director-msg', kind: 'ACK', cueId: 'shape-rain', fireResult: 'ok' });

    // The pill renders (~8s) and the button disables — the SERVER signal (the
    // FIRE ACK) populated the cooldown, not a client-side guess.
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain('(8s)');

    // 5s elapse; a fresh PHASE_STATE (the ~1 Hz heartbeat) re-renders — the pill
    // ticks DOWN (recomputed from fired-at + the catalog's cooldownMs).
    advance(5000);
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain('(3s)');

    // Past the full cooldown window: the pill clears + the button re-enables.
    advance(4000); // 9s total elapsed > 8000ms cooldownMs
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).not.toContain('(');
  });

  it('a cooldown/wrongPhase FIRE result does NOT start (or reset) the cooldown timer', () => {
    const { c, ws, advance } = makeTickingConsole();
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    ws().deliver({ t: 'director-msg', kind: 'CATALOG', catalog: SEED_CATALOG as never });
    const btn = () => c.root.querySelector('[data-cue-id="shape-rain"]') as HTMLButtonElement;

    // A rejected fire (e.g. an ACK the client never actually caused, or a race)
    // must never arm a cooldown countdown on its own.
    ws().deliver({ t: 'director-msg', kind: 'ACK', cueId: 'shape-rain', fireResult: 'wrongPhase' });
    expect(btn().disabled).toBe(false);

    // A real fire arms it; a SECOND (deduped) ACK for the same cue must not
    // rewind the clock — the remaining time keeps counting from the FIRST fire.
    btn().click();
    ws().deliver({ t: 'director-msg', kind: 'ACK', cueId: 'shape-rain', fireResult: 'ok' });
    advance(6000);
    ws().deliver({ t: 'director-msg', kind: 'ACK', cueId: 'shape-rain', fireResult: 'deduped' });
    ws().deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null });
    expect(btn().textContent).toContain('(2s)');
  });
});

describe('C10 director console — roster (tier + provenance + rttMs + mute/disconnect)', () => {
  it('renders roster rows with callsign + tier + provenance + rttMs', () => {
    const { c, ws } = makeConsole();
    ws().deliver({
      t: 'roster',
      entries: [
        { id: 'p0', callsign: 'VOLT-07', tier: 'resident', entryRoute: 'staff', joinedAt: 10, rttMs: 42 },
        { id: 'p1', callsign: 'NEON-03', tier: 'crowd', entryRoute: 'phase-b', joinedAt: 20 },
      ],
    });
    const rows = c.root.querySelectorAll('.dc-roster-row');
    expect(rows.length).toBe(2);
    const first = (rows[0] as HTMLElement).textContent!;
    expect(first).toContain('VOLT-07');
    expect(first).toContain('resident');
    expect(first).toContain('staff');
    expect(first).toContain('42ms');
  });

  it('mute + disconnect buttons send the MUTE / KICC (disconnect) director-cmds', () => {
    const { c, ws } = makeConsole();
    ws().deliver({
      t: 'roster',
      entries: [{ id: 'p0', callsign: 'VOLT-07', tier: 'resident', entryRoute: 'staff', joinedAt: 10 }],
    });
    (c.root.querySelector('.dc-roster-mute') as HTMLButtonElement).click();
    (c.root.querySelector('.dc-roster-kick') as HTMLButtonElement).click();
    const cmds = ws().cmds();
    expect(cmds.find((m) => m['cmd'] === 'MUTE')!['targetId']).toBe('p0');
    // "disconnect" is the KICK cmd (UI copy = disconnect).
    expect(cmds.find((m) => m['cmd'] === 'KICK')!['targetId']).toBe('p0');
    // The kick button's label is literally "disconnect" (spec §7.2 copy).
    expect((c.root.querySelector('.dc-roster-kick') as HTMLElement).textContent).toBe('disconnect');
  });
});

describe('C10 director console — laptop hotkeys (Space/F/H/R/P) + panic', () => {
  it('the hotkey map binds Space=ADVANCE, F=FINALE, H=HOLD, R=RESET, P=PANIC', () => {
    expect(HOTKEY_COMMANDS[' '].cmd).toBe('ADVANCE');
    expect(HOTKEY_COMMANDS['f'].cmd).toBe('FINALE');
    expect(HOTKEY_COMMANDS['h'].cmd).toBe('HOLD');
    expect(HOTKEY_COMMANDS['r'].cmd).toBe('RESET');
    expect(HOTKEY_COMMANDS['p'].cmd).toBe('PANIC');
  });

  it('F (fire finale) CONFIRMS then sends FINALE', () => {
    const { c, ws } = makeConsole();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    c.onKey('f');
    expect(ws().lastCmd()!['cmd']).toBe('FINALE');
  });

  it('Space sends ADVANCE (next phase)', () => {
    const { c, ws } = makeConsole();
    expect(c.onKey(' ')).toBe('ADVANCE');
    expect(ws().lastCmd()!['cmd']).toBe('ADVANCE');
  });

  it('H sends HOLD with a +60s holdMs', () => {
    const { c, ws } = makeConsole();
    c.onKey('h');
    const cmd = ws().lastCmd()!;
    expect(cmd['cmd']).toBe('HOLD');
    expect(cmd['holdMs']).toBe(60_000);
  });

  it('R (reset) CONFIRMS before sending RESET', () => {
    const { c, ws } = makeConsole();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    c.onKey('r');
    expect(ws().cmds().some((m) => m['cmd'] === 'RESET')).toBe(false);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    c.onKey('r');
    expect(ws().cmds().some((m) => m['cmd'] === 'RESET')).toBe(true);
  });

  it('P (panic) sends the PANIC trigger (server handler is C12)', () => {
    const { c, ws } = makeConsole();
    c.onKey('p');
    expect(ws().lastCmd()!['cmd']).toBe('PANIC');
  });

  it('an unbound key is a no-op (returns null)', () => {
    const { c } = makeConsole();
    expect(c.onKey('z')).toBeNull();
  });
});

describe('C10 director console — STATS_CARD (callsigns only)', () => {
  it('captures the stats card with callsigns and never a raw name', () => {
    const { c, ws } = makeConsole();
    ws().deliver({
      t: 'stats-card',
      shapesThrown: 12,
      fastestThrow: { callsign: 'VOLT-07', value: 9.1 },
      topContributor: { callsign: 'NEON-03', value: 5 },
      dayLeaderboard: [{ callsign: 'NEON-03', value: 20 }],
      nextInHeadset: 'NEXT IN THE HEADSET?',
    });
    const card = c.currentStats!;
    expect(card.topContributor?.callsign).toBe('NEON-03');
    expect(JSON.stringify(card)).not.toMatch(/"name"/);
  });

  it('renders the STATS_CARD (callsigns only) during the STATS phase', () => {
    const { c, ws } = makeConsole();
    ws().deliver({
      t: 'stats-card',
      shapesThrown: 12,
      fastestThrow: { callsign: 'VOLT-07', value: 9.1 },
      topContributor: { callsign: 'NEON-03', value: 5 },
      dayLeaderboard: [{ callsign: 'NEON-03', value: 20 }],
      nextInHeadset: 'NEXT IN THE HEADSET?',
    });
    // Not shown outside STATS.
    expect((c.root.querySelector('[data-role="stats"]') as HTMLElement).hidden).toBe(true);
    // Enter STATS → the card renders with callsigns.
    ws().deliver({ t: 'phase-state', phase: 'STATS', endsAt: 1, remainingMs: 30000 });
    const statsEl = c.root.querySelector('[data-role="stats"]') as HTMLElement;
    expect(statsEl.hidden).toBe(false);
    expect(statsEl.textContent).toContain('NEON-03');
    expect(statsEl.textContent).toContain('VOLT-07');
    // No raw-name field ever renders.
    expect(statsEl.textContent).not.toMatch(/name/i);
  });
});
