/**
 * themeChannel.test.ts — Task C20 F9 Reality Channels SERVER host.
 *
 * The ThemeChannelHost owns the room's ACTIVE THEME + the THEME_SET broadcast
 * (OPCODES.THEME_SET 0x24 {themeId, transitionAtServerTime}). Transitions are
 * SCHEDULED via the C3 `scheduleAt` (comfort-bounded); a LATE THEME_SET snaps
 * with a mini-glitch (fireNow policy). The active theme PERSISTS via a snapshot/
 * restore round-trip (the room/bucket seam).
 *
 * Theme votes ride the SAME C15 election pool: the ElectionHost's enact routes a
 * THEME-namespaced winner to `enactTheme` (→ setTheme / THEME_SET), NOT to
 * `setBaseParams` — there is no second vote path.
 *
 * All time is fake via an injected TimerApi (no raw setTimeout/Date).
 */

import { describe, it, expect } from 'vitest';
import type { TimerApi, TimerHandle } from '@cyber-shapes/shared';
import {
  OPCODES,
  DEFAULT_PARAMS,
  DEFAULT_THEME_ID,
  SHIP_THEMES,
  themeOptionFor,
  themeElectionOptions,
  THEME_TRANSITION_MAX_LEAD_MS,
} from '@cyber-shapes/shared';
import { ServerWorld } from '../src/serverWorld.js';
import { RoomTimelineHost, ElectionHost, ThemeChannelHost } from '../src/timeline.js';

// ---------------------------------------------------------------------------
// Fake timers (chronological; cb may enqueue more)
// ---------------------------------------------------------------------------

interface FakeEntry {
  id: number;
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}

function makeFakeTimers(initialNow = 0) {
  let _now = initialNow;
  let _nextId = 1;
  const _timers: FakeEntry[] = [];
  function fireReady(): void {
    let fired = true;
    while (fired) {
      fired = false;
      for (const t of _timers.slice().sort((a, b) => a.fireAt - b.fireAt)) {
        if (!t.cancelled && t.fireAt <= _now) {
          t.cancelled = true;
          t.cb();
          fired = true;
          break;
        }
      }
    }
  }
  const api: TimerApi = {
    setTimeout(cb: () => void, ms: number): TimerHandle {
      const id = _nextId++;
      _timers.push({ id, fireAt: _now + ms, cb, cancelled: false });
      return id as unknown as TimerHandle;
    },
    clearTimeout(h: TimerHandle): void {
      const id = h as unknown as number;
      const t = _timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    now: () => _now,
  };
  return {
    api,
    advance(ms: number) {
      _now += ms;
      fireReady();
    },
    now: () => _now,
  };
}

interface Broadcast {
  opcode: number;
  payload: unknown;
  tiers?: readonly string[];
}

function themeSets(broadcasts: Broadcast[]) {
  return broadcasts
    .filter((b) => b.opcode === OPCODES.THEME_SET)
    .map((b) => b.payload as { themeId: string; transitionAtServerTime: number });
}

function makeChannel(over: { initialTheme?: string } = {}) {
  const t = makeFakeTimers();
  const broadcasts: Broadcast[] = [];
  const channel = new ThemeChannelHost({
    timer: t.api,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    ...(over.initialTheme ? { initialTheme: over.initialTheme } : {}),
  });
  return { t, channel, broadcasts };
}

// ===========================================================================
// The active theme + the THEME_SET broadcast
// ===========================================================================

describe('C20 ThemeChannelHost — active theme + THEME_SET', () => {
  it('starts on the default theme', () => {
    const { channel } = makeChannel();
    expect(channel.activeTheme).toBe(DEFAULT_THEME_ID);
  });

  it('setTheme with no lead snaps NOW: broadcasts THEME_SET and flips the active theme', () => {
    const { channel, broadcasts } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    channel.setTheme(target); // immediate
    const sets = themeSets(broadcasts);
    expect(sets.length).toBe(1);
    expect(sets[0].themeId).toBe(target);
    expect(channel.activeTheme).toBe(target);
  });

  it('an UNKNOWN theme id is ignored (no broadcast, theme unchanged)', () => {
    const { channel, broadcasts } = makeChannel();
    channel.setTheme('no-such-theme');
    expect(themeSets(broadcasts).length).toBe(0);
    expect(channel.activeTheme).toBe(DEFAULT_THEME_ID);
  });

  it('THEME_SET rides the audience-union receive set (resident-class + director)', () => {
    const { channel, broadcasts } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    channel.setTheme(target);
    const set = broadcasts.find((b) => b.opcode === OPCODES.THEME_SET)!;
    expect(set.tiers).toContain('resident');
    expect(set.tiers).toContain('director');
  });
});

// ===========================================================================
// Scheduled transitions (C3 scheduleAt, comfort-bounded) + late-snap
// ===========================================================================

describe('C20 ThemeChannelHost — scheduled transition honors the offset', () => {
  it('a future transitionAtServerTime defers the flip until that server time', () => {
    const { t, channel, broadcasts } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const now = t.now();
    channel.setTheme(target, now + 800); // 800 ms lead (within the comfort bound)
    // Not yet flipped: the scheduled callback has not fired.
    expect(channel.activeTheme).toBe(DEFAULT_THEME_ID);
    expect(themeSets(broadcasts).length).toBe(0);
    // Advance to the scheduled server time → the transition fires.
    t.advance(800);
    expect(channel.activeTheme).toBe(target);
    const sets = themeSets(broadcasts);
    expect(sets.length).toBe(1);
    expect(sets[0].themeId).toBe(target);
    expect(sets[0].transitionAtServerTime).toBe(now + 800);
  });

  it('clamps an over-long lead to the comfort bound (never schedules far out)', () => {
    const { t, channel } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const now = t.now();
    channel.setTheme(target, now + 60_000); // absurd 60 s lead
    // Advancing just past the comfort bound flips it (the lead was clamped).
    t.advance(THEME_TRANSITION_MAX_LEAD_MS + 1);
    expect(channel.activeTheme).toBe(target);
  });

  // IMPORTANT 2 fix — the broadcast payload must carry the CLAMPED fireAt, not
  // the original transitionAtServerTime, so clients do not schedule a transition
  // far later than the server actually flipped.
  it('IMPORTANT 2 (fix): clamped lead → broadcast payload transitionAtServerTime equals clamped fire time, NOT original', () => {
    const { t, channel, broadcasts } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const now = t.now();
    const absurdLead = 60_000;
    channel.setTheme(target, now + absurdLead); // 60 s is way over the max lead
    // Advance to just past the clamped fireAt so the callback fires.
    t.advance(THEME_TRANSITION_MAX_LEAD_MS + 1);
    const sets = themeSets(broadcasts);
    expect(sets.length).toBe(1);
    // The payload must carry the CLAMPED time, NOT now + 60_000.
    expect(sets[0].transitionAtServerTime).not.toBe(now + absurdLead);
    expect(sets[0].transitionAtServerTime).toBe(now + THEME_TRANSITION_MAX_LEAD_MS);
  });

  it('a LATE transitionAtServerTime → snap NOW with a mini-glitch flag', () => {
    const { t, channel, broadcasts } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const now = t.now();
    channel.setTheme(target, now - 5_000); // already past → snap
    // Fired immediately (fireNow policy), and the payload carries the glitch flag.
    expect(channel.activeTheme).toBe(target);
    const sets = broadcasts.filter((b) => b.opcode === OPCODES.THEME_SET);
    expect(sets.length).toBe(1);
    expect((sets[0].payload as { glitch?: boolean }).glitch).toBe(true);
  });
});

// ===========================================================================
// Persistence round-trip (the active theme survives via the room/bucket)
// ===========================================================================

describe('C20 ThemeChannelHost — persistence round-trip', () => {
  it('snapshot() captures the active theme; restore() re-applies it (no re-broadcast storm)', () => {
    const { channel } = makeChannel();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    channel.setTheme(target);
    const snap = channel.snapshot();
    expect(snap.themeId).toBe(target);

    // A fresh channel restores the persisted theme.
    const revived = makeChannel();
    revived.channel.restore(snap);
    expect(revived.channel.activeTheme).toBe(target);
  });

  it('restore() of an unknown snapshot theme falls back to the default (never crashes)', () => {
    const { channel } = makeChannel();
    channel.restore({ themeId: 'gone-theme' });
    expect(channel.activeTheme).toBe(DEFAULT_THEME_ID);
  });
});

// ===========================================================================
// Election-pool registration — theme votes go through the SAME C15 machinery
// ===========================================================================

function makeIdFactory(prefix = 'w') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A room with a timeline host + a theme channel + an election whose pool includes theme options. */
function makeElectionWithThemes() {
  const t = makeFakeTimers();
  const world = new ServerWorld({ maxShapes: 40, idFactory: makeIdFactory('w') });
  for (let i = 0; i < 25; i++) {
    world.spawn({ type: 'cube', position: { x: i, y: 5, z: 0 }, colorIndex: i % 6 });
  }
  const broadcasts: Broadcast[] = [];
  const host = new RoomTimelineHost({
    timer: t.api,
    world,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    roster: () => [],
  });
  const channel = new ThemeChannelHost({
    timer: t.api,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
  });
  const themeOpts = themeElectionOptions();
  const dialOpts = ['low-g', 'gravity-flip'];
  const election = new ElectionHost({
    timer: t.api,
    handle: host.handle,
    // The pool GAINS the theme options alongside the dial ids.
    options: [...dialOpts, ...themeOpts],
    dialLaw: (id) => (id === 'low-g' ? { ...DEFAULT_PARAMS, gravity: { x: 0, y: -1.2, z: 0 } } : undefined),
    // The theme-vote enactment hook: a THEME-namespaced winner sets the theme.
    enactTheme: (themeId) => channel.setTheme(themeId),
    readBaseParams: () => host.baseParams,
    broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
  });
  return { t, host, channel, election, broadcasts, themeOpts, dialOpts };
}

describe('C20 elections — the C15 pool GAINS the theme options', () => {
  it('a fresh election ballot carries BOTH the dial ids and the theme options', () => {
    const { election, themeOpts, dialOpts } = makeElectionWithThemes();
    election.open(0);
    const opts = election.state.options;
    for (const d of dialOpts) expect(opts).toContain(d);
    for (const th of themeOpts) expect(opts).toContain(th);
  });

  it('an enacted THEME vote SETS THE THEME and does NOT write baseParams', () => {
    const { t, host, channel, election } = makeElectionWithThemes();
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const winning = themeOptionFor(target);
    election.open(0);
    // Four voters all pick the theme option → a clear theme win.
    election.cast('t1', winning, 1_000);
    election.cast('t2', winning, 1_100);
    election.cast('t3', winning, 1_200);
    election.cast('t4', winning, 1_300);
    const baseBefore = host.baseParams;
    t.advance(90_000);
    // The theme flipped …
    expect(channel.activeTheme).toBe(target);
    // … and baseParams was NOT rewritten by the theme enact (distinct from a dial law).
    expect(host.baseParams).toBe(baseBefore);
    expect(host.baseParams).toBe(DEFAULT_PARAMS);
  });

  it('a DIAL vote in the same pool still writes baseParams (theme options don\'t break dial votes)', () => {
    const { t, host, channel, election } = makeElectionWithThemes();
    election.open(0);
    election.cast('t1', 'low-g', 1_000);
    election.cast('t2', 'low-g', 1_100);
    election.cast('t3', 'low-g', 1_200);
    election.cast('t4', 'low-g', 1_300);
    t.advance(90_000);
    // A dial win writes baseParams (the C15 machinery is untouched) …
    expect(host.baseParams.gravity?.y).toBe(-1.2);
    // … and the theme is UNTOUCHED by a dial enact.
    expect(channel.activeTheme).toBe(DEFAULT_THEME_ID);
  });
});

// ===========================================================================
// LATENT 3 (fix) — coordinate consistency: broadcast vs late-join THEME_SET
// Both must use the SAME coordinate system (absolute server ms from timer.now()).
// ===========================================================================

describe('C20 ThemeChannelHost — THEME_SET coordinate system (LATENT 3 fix)', () => {
  it('an immediate setTheme broadcast carries transitionAtServerTime as ABSOLUTE server ms', () => {
    const t = makeFakeTimers(50_000); // start at an arbitrary non-zero server time
    const broadcasts: Broadcast[] = [];
    const channel = new ThemeChannelHost({
      timer: t.api,
      broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    });
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    channel.setTheme(target); // immediate snap (no lead)
    const sets = themeSets(broadcasts);
    expect(sets.length).toBe(1);
    // transitionAtServerTime must be absolute server ms (timer.now() = 50_000),
    // NOT a small roomEpoch-relative value (which would be near 0).
    expect(sets[0].transitionAtServerTime).toBe(50_000);
  });

  it('a scheduled setTheme broadcast carries the clamped ABSOLUTE fire time (not epoch-relative)', () => {
    const t = makeFakeTimers(100_000); // server time starts at 100 s
    const broadcasts: Broadcast[] = [];
    const channel = new ThemeChannelHost({
      timer: t.api,
      broadcast: (opcode, payload, tiers) => void broadcasts.push({ opcode, payload, tiers }),
    });
    const target = SHIP_THEMES.find((th) => th.id !== DEFAULT_THEME_ID)!.id;
    const now = t.now(); // 100_000
    const lead = 500;
    channel.setTheme(target, now + lead); // 500 ms ahead
    t.advance(lead + 1);
    const sets = themeSets(broadcasts);
    expect(sets.length).toBe(1);
    // Must be absolute server time: 100_000 + 500, NOT 500 (roomEpoch-relative).
    expect(sets[0].transitionAtServerTime).toBe(now + lead);
    // Double-check: it is not a small relative value.
    expect(sets[0].transitionAtServerTime).toBeGreaterThan(1_000);
  });
});
