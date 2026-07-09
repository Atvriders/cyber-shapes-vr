/**
 * stage.dom.test.ts — the F1 Neon Director stage client wiring (C9, spec §7.1).
 * jsdom (matched by the `.dom.test.ts` glob). Covers the testable, three-free
 * surface: the ServerMsg→RoomEvent adapter, the staff hotkey map, the overlay
 * slot priority + §14 counter gating + QR health-swap, and the spectator+
 * ownerToken join payload (mock WS). Visuals (render.ts) are manual-verify.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encodeText,
  encodeBinary,
  casterSlotsToWire,
  OPCODES,
  SINGLE_KIND,
  VOTE_KIND,
  SHOWPIECE_KIND,
  SIEGE_WAVES,
} from '@cyber-shapes/shared';
import type { ServerMsg, RoomEvent } from '@cyber-shapes/shared';
import { Stage, serverMsgToRoomEvent, hotkeyToShot } from '../src/stage/stage.ts';
import { StageOverlays } from '../src/stage/overlays.ts';
import { XRAY_AUTO_REVERT_MS } from '../src/stage/xray.ts';

// ---------------------------------------------------------------------------
// Mock WebSocket (the C2 handshake surface the stage touches).
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
  /** Deliver a raw binary frame (0x33 caster path). Cast: the stage handler accepts an ArrayBuffer. */
  deliverBinary(buf: ArrayBuffer) {
    (this.onmessage as unknown as (ev: { data: ArrayBuffer }) => void)?.({ data: buf });
  }
}

// ---------------------------------------------------------------------------
// ServerMsg → RoomEvent adapter (C0 binding 14)
// ---------------------------------------------------------------------------
describe('C9 stage — serverMsgToRoomEvent adapter (binding 14)', () => {
  it('maps a RELEASE (grab peerId:null + vel) to a release event with |vel| speed', () => {
    const ev = serverMsgToRoomEvent({
      t: 'grab',
      id: 's1',
      peerId: null,
      vel: { x: 3, y: 4, z: 0 }, // |vel| = 5
    });
    expect(ev).toEqual({ kind: 'release', id: 's1', peerId: '', speed: 5 });
  });

  it('maps a GRAB (peerId non-null) to a grab event (ordinary — no cut)', () => {
    const ev = serverMsgToRoomEvent({ t: 'grab', id: 's1', peerId: 'p3' });
    expect(ev).toEqual({ kind: 'grab', id: 's1', peerId: 'p3' });
  });

  it('maps player-join → join and player-leave → leave', () => {
    expect(serverMsgToRoomEvent({ t: 'player-join', player: { id: 'p9', name: 'X', color: 0 } })).toEqual(
      { kind: 'join', peerId: 'p9' }
    );
    expect(serverMsgToRoomEvent({ t: 'player-leave', id: 'p9' })).toEqual({ kind: 'leave', peerId: 'p9' });
  });

  it('returns null for messages with no brain trigger (state/pose/welcome/…)', () => {
    expect(serverMsgToRoomEvent({ t: 'state', seq: 1, serverTick: 1, shapes: [] })).toBeNull();
    expect(serverMsgToRoomEvent({ t: 'pose', id: 'p1', pose: { head: { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }, hands: [null, null] } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hotkey map
// ---------------------------------------------------------------------------
describe('C9 stage — staff hotkey map', () => {
  it("'2' forces FOLLOW_THROW on the current target; '0' forces the safe WIDE_ESTABLISH", () => {
    expect(hotkeyToShot('2', 's7')).toEqual({ kind: 'FOLLOW_THROW', targetId: 's7', sinceMs: 0 });
    expect(hotkeyToShot('0', 's7')).toEqual({ kind: 'WIDE_ESTABLISH', sinceMs: 0 });
  });
  it('an unbound key is a no-op (brain keeps control)', () => {
    expect(hotkeyToShot('7', undefined)).toBeNull();
    expect(hotkeyToShot('x', undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overlay slot priority + §14 gating + QR health-swap
// ---------------------------------------------------------------------------
describe('C9 stage — overlay slot priority (§7.1)', () => {
  it('replay chrome outranks cue > caster > ticker in the shared banner', () => {
    const ov = new StageOverlays(document);
    ov.setTicker('...events...');
    expect(ov.activeSlot()).toBe('ticker');
    ov.setCasterCaption('NULL: nice throw');
    expect(ov.activeSlot()).toBe('caster');
    ov.setCueBanner('GRAVITY FLIP');
    expect(ov.activeSlot()).toBe('cue');
    ov.setReplayChrome('INSTANT REPLAY');
    expect(ov.activeSlot()).toBe('replay');
    // Clearing the top slot falls back to the next-highest retained slot.
    ov.clearSlot('replay');
    expect(ov.activeSlot()).toBe('cue');
  });
});

describe('C9 stage — §14 player counter gating', () => {
  it('is WITHHELD (hidden, no-op) when the flex-line gate is not granted', () => {
    const ov = new StageOverlays(document, { flexLineGranted: false });
    expect(ov.counterEnabled).toBe(false);
    ov.setPlayerCount(12);
    const el = ov.root.querySelector('[data-role="counter"]') as HTMLElement;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
  });
  it('renders "N PLAYERS — 1 WORLD — 1 SOCKET" once the gate is granted', () => {
    const ov = new StageOverlays(document, { flexLineGranted: true });
    expect(ov.counterEnabled).toBe(true);
    ov.setPlayerCount(12);
    const el = ov.root.querySelector('[data-role="counter"]') as HTMLElement;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('12 PLAYERS — 1 WORLD — 1 SOCKET');
  });
});

describe('C9 stage — lower-third pattern redundancy (§6.1)', () => {
  it('renders callsign + color swatch + a PATTERN so color is never the only signal', () => {
    const ov = new StageOverlays(document);
    ov.setLowerThird({ callsign: 'VOLT-17', color: '#00ffff', pattern: 'stripe' });
    const swatch = ov.root.querySelector('.lower-third-swatch') as HTMLElement;
    const name = ov.root.querySelector('.lower-third-callsign') as HTMLElement;
    expect(swatch.dataset.pattern).toBe('stripe');
    expect(name.textContent).toBe('VOLT-17');
  });
});

describe('C13 stage — F10 attract-mode chrome (§7.10 / §6.1)', () => {
  it('enters attract mode: emphasizes the QR + shows the recording-notice sign', () => {
    const ov = new StageOverlays(document);
    ov.setQr('https://x/r/r1');
    expect(ov.attractActive).toBe(false);
    ov.setAttractMode(true);
    expect(ov.attractActive).toBe(true);
    const qr = ov.root.querySelector('[data-role="qr"]') as HTMLElement;
    expect(qr.dataset.emphasis).toBe('attract');
    const sign = ov.root.querySelector('[data-role="attract-sign"]') as HTMLElement;
    expect(sign.hidden).toBe(false);
    // §6.1 disclosure copy (covers reels + §7.20 clips).
    expect(sign.textContent).toMatch(/RECORDED AND PUBLISHED/);
    // Leaving attract restores live chrome + hides the sign.
    ov.setAttractMode(false);
    expect(ov.attractActive).toBe(false);
    expect(sign.hidden).toBe(true);
  });

  it('venue-brightness toggle flips the high-exposure palette flag', () => {
    const ov = new StageOverlays(document);
    ov.setVenueBright(true);
    expect(ov.root.dataset.venue).toBe('bright');
    ov.setVenueBright(false);
    expect(ov.root.dataset.venue).toBe('normal');
  });
});

describe('C9 stage — kiosk QR health-swap', () => {
  let stage: Stage;
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
    stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws', flexLineGranted: true });
  });
  afterEach(() => stage.dispose());

  it('swaps the QR for an "ask staff" card when the join URL is unreachable', async () => {
    const ok = await stage.checkJoinUrlHealth('https://x/r/r1', async () => ({ ok: false }));
    expect(ok).toBe(false);
    const qr = stage.overlays.root.querySelector('[data-role="qr"]') as HTMLElement;
    expect(qr.dataset.askStaff).toBe('true');
    expect(qr.textContent).toContain('ASK STAFF');
  });

  it('restores the QR when the join URL recovers', async () => {
    await stage.checkJoinUrlHealth('https://x/r/r1', async () => ({ ok: false }));
    const ok = await stage.checkJoinUrlHealth('https://x/r/r1', async () => ({ ok: true }));
    expect(ok).toBe(true);
    const qr = stage.overlays.root.querySelector('[data-role="qr"]') as HTMLElement;
    expect(qr.dataset.askStaff).toBeUndefined();
    expect(qr.dataset.url).toBe('https://x/r/r1');
  });
});

// ---------------------------------------------------------------------------
// Spectator + ownerToken join + brain wiring
// ---------------------------------------------------------------------------
describe('C9 stage — connects as spectator carrying the ownerToken (§5.1/§5.4)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  it('sends an explicit spectator join with the ownerToken (never in a URL)', async () => {
    const stage = new Stage(document, {
      room: 'r1',
      ownerToken: 'SECRET_TOKEN',
      wsUrl: 'ws://x/ws',
    });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const join = JSON.parse(ws.sent[0]);
    expect(join.t).toBe('join');
    expect(join.tier).toBe('spectator');
    expect(join.ownerToken).toBe('SECRET_TOKEN');
    stage.dispose();
  });

  it('feeds inbound RoomEvents to the brain: a hard throw cuts to FOLLOW_THROW', async () => {
    const stage = new Stage(document, {
      room: 'r1',
      wsUrl: 'ws://x/ws',
      brain: { minShotMs: 2000, heatThreshold: 6 },
    });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    // Establish first.
    expect(stage.update(16).kind).toBe('WIDE_ESTABLISH');
    // A release with |vel| = 20 arrives over the wire.
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 20, y: 0, z: 0 } });
    const shot = stage.update(16);
    expect(shot.kind).toBe('FOLLOW_THROW');
    expect(shot.targetId).toBe('s9');
    stage.dispose();
  });

  it('requestShot() forces an external shot (C12/C16/C17/C32 hook) that wins over the brain', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    stage.requestShot({ kind: 'GLYPH_BIRTH', targetId: 'g1', sinceMs: 0 }, 3000);
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 50, y: 0, z: 0 } });
    const shot = stage.update(1000);
    expect(shot.kind).toBe('GLYPH_BIRTH'); // forced shot wins the whole hold
    stage.dispose();
  });

  it('C17 §7.7: a PLAYER_SCALE grow forces the WORM_EYE shot + TITAN PROTOCOL banner', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'player-scale', peerId: 'p7', scale: 5, durationMs: 1500 } as ServerMsg);
    const shot = stage.update(16);
    expect(shot.kind).toBe('WORM_EYE');
    expect(shot.targetId).toBe('p7');
    const banner = stage.overlays.root.querySelector('[data-role="banner"]') as HTMLElement;
    expect(banner.textContent).toContain('TITAN PROTOCOL');
    stage.dispose();
  });

  it('C17 §7.7: a PLAYER_SCALE revert (scale → 1) does NOT force the worm\'s-eye shot', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'player-scale', peerId: 'p7', scale: 1, durationMs: 1500 } as ServerMsg);
    const shot = stage.update(16);
    expect(shot.kind).not.toBe('WORM_EYE');
    stage.dispose();
  });

  it('C32 §7.21: a TK tether forces the POWERS shot + "NO CONTROLLERS" lower-third; clears on release', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    // rising edge: a committed pull tether (server anchor + target — no joints)
    ws.deliver({
      t: 'tk-tether',
      peerId: 'p3',
      pulls: [{ hand: 1, anchor: { x: 0, y: 1.2, z: 0 }, targetId: 's9' }],
    } as ServerMsg);
    const shot = stage.update(16);
    expect(shot.kind).toBe('POWERS');
    expect(shot.targetId).toBe('s9');
    expect(stage.powersActive).toBe(true);
    expect(stage.powersTethers[0].targetId).toBe('s9');
    const banner = stage.overlays.root.querySelector('[data-role="banner"]') as HTMLElement;
    expect(banner.textContent).toContain('NO CONTROLLERS');
    // falling edge: the pull ended → the banner clears
    ws.deliver({ t: 'tk-tether', peerId: null, pulls: [] } as ServerMsg);
    stage.update(16);
    expect(stage.powersActive).toBe(false);
    expect(banner.textContent ?? '').not.toContain('NO CONTROLLERS');
    stage.dispose();
  });

  it('the §14 counter tracks welcome/join/leave when the gate is granted', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws', flexLineGranted: true });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'welcome', playerId: 'p1', room: 'r1', shapes: [], players: [{ id: 'p1', name: 'A', color: 0 }, { id: 'p2', name: 'B', color: 1 }] });
    ws.deliver({ t: 'player-join', player: { id: 'p3', name: 'C', color: 2 } });
    const el = stage.overlays.root.querySelector('[data-role="counter"]') as HTMLElement;
    expect(el.textContent).toBe('3 PLAYERS — 1 WORLD — 1 SOCKET');
    ws.deliver({ t: 'player-leave', id: 'p3' });
    expect(el.textContent).toBe('2 PLAYERS — 1 WORLD — 1 SOCKET');
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C12 — the Neon Guestbook birth moment on the stage (spec §7.13)
// ---------------------------------------------------------------------------
describe('C12 stage — Neon Guestbook birth moment', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  const glyph = {
    id: 'g1',
    callsign: 'VOLT-17',
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
    ],
    color: '#00ffff',
    slotIndex: 3,
  };

  it('a `glyph` message forces GLYPH_BIRTH, sets the callsign lower-third, and feeds the sink', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    // Register a fake sink (the real one imports three; here we spy the calls).
    const calls: { add: unknown[]; highlight: unknown[]; setGlyphs: unknown[]; hide: unknown[]; remove: unknown[] } = {
      add: [],
      highlight: [],
      setGlyphs: [],
      hide: [],
      remove: [],
    };
    stage.registerGlyphSink({
      setGlyphs: (g) => calls.setGlyphs.push(g),
      add: (g) => calls.add.push(g),
      remove: (id) => calls.remove.push(id),
      hide: (ids) => calls.hide.push(ids),
      highlight: (id) => calls.highlight.push(id),
    });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];

    ws.deliver({ t: 'glyph', glyph } as ServerMsg);

    // The birth moment: the glyph reaches the sink + a GLYPH_BIRTH shot is forced.
    expect(calls.add).toHaveLength(1);
    expect(calls.highlight[0]).toBe('g1');
    const shot = stage.update(16);
    expect(shot.kind).toBe('GLYPH_BIRTH');
    expect(shot.targetId).toBe('g1');
    // The callsign lower-third is lit (callsign only — §6.1).
    const lt = stage.overlays.root.querySelector('[data-role="lower-third"]') as HTMLElement;
    expect(lt?.dataset['callsign']).toBe('VOLT-17');
    stage.dispose();
  });

  it('the 3 s highlight expires (spotlight + lower-third clear)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    const highlights: (string | null)[] = [];
    stage.registerGlyphSink({
      setGlyphs: () => {},
      add: () => {},
      remove: () => {},
      hide: () => {},
      highlight: (id) => highlights.push(id),
    });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'glyph', glyph } as ServerMsg);
    expect(highlights).toContain('g1');
    // Advance past the 3 s highlight window → the spotlight clears (highlight(null)).
    stage.update(3100);
    expect(highlights[highlights.length - 1]).toBeNull();
    const lt = stage.overlays.root.querySelector('[data-role="lower-third"]') as HTMLElement;
    expect(lt?.hidden).toBe(true);
    stage.dispose();
  });

  it('a `glyph-snapshot` feeds the backfill, `glyph-remove`/`glyph-hide` reach the sink', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    const calls: { setGlyphs: unknown[]; remove: unknown[]; hide: unknown[] } = { setGlyphs: [], remove: [], hide: [] };
    stage.registerGlyphSink({
      setGlyphs: (g) => calls.setGlyphs.push(g),
      add: () => {},
      remove: (id) => calls.remove.push(id),
      hide: (ids) => calls.hide.push(ids),
      highlight: () => {},
    });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'glyph-snapshot', glyphs: [glyph] } as ServerMsg);
    ws.deliver({ t: 'glyph-remove', id: 'g1' } as ServerMsg);
    ws.deliver({ t: 'glyph-hide', ids: ['g2', 'g3'] } as ServerMsg);
    expect(calls.setGlyphs).toHaveLength(1);
    expect(calls.remove).toEqual(['g1']);
    expect(calls.hide).toEqual([['g2', 'g3']]);
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C26 — the 0x33 CASTER_LINE receive path is throw-safe on a truncated frame
// (the stage AND the 128 unauthed audience screens decode UNTRUSTED binary).
// ---------------------------------------------------------------------------
describe('C26 stage — 0x33 decode is throw-safe + renders a valid caption', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  async function connected(): Promise<{ stage: Stage; ws: MockWS }> {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    return { stage, ws: MockWS.instances[0] };
  }

  it('a VALID 0x33 frame renders a caption (the positive wire path)', async () => {
    const { stage, ws } = await connected();
    const frame = encodeBinary(OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, {
      templateId: 2, // throw-normal: "{cs} RIPS IT · {n} M/S"
      slots: casterSlotsToWire([
        { kind: 'callsign', who: { wordIndex: 0, suffix: 17 } },
        { kind: 'num', value: 18.4 },
      ]),
    });
    ws.deliverBinary(frame);
    expect(stage.overlays.activeSlot()).toBe('caster');
    expect(stage.overlays.bannerText()).toContain('VOLT-17');
    stage.dispose();
  });

  it('a TRUNCATED 0x33 frame (slotCount claims 2, slot bytes missing) is ignored — never throws, no caption', async () => {
    const { stage, ws } = await connected();
    // A well-formed HEADER claiming 2 slots, but the slot payload is absent (only
    // the 6-byte header is present — the codec needs 6 + 2×7 = 20 B).
    const header = new Uint8Array([OPCODES.CASTER_LINE, SINGLE_KIND.ONLY, 2, 0, /*slotCount*/ 2, 0]);
    expect(() => ws.deliverBinary(header.buffer)).not.toThrow();
    expect(stage.overlays.activeSlot()).not.toBe('caster');
    expect(stage.overlays.bannerText()).toBe('');
    // A garbage 1-byte and a 0-byte frame are likewise swallowed.
    expect(() => ws.deliverBinary(new Uint8Array([OPCODES.CASTER_LINE]).buffer)).not.toThrow();
    expect(() => ws.deliverBinary(new ArrayBuffer(0))).not.toThrow();
    expect(stage.overlays.bannerText()).toBe('');
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C15 — the F5 Reality Referendum drama wiring (spec §7.5 "big screen owns drama")
// ---------------------------------------------------------------------------
describe('C15 stage — Reality Referendum drama wiring (§7.5)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  it('serverMsgToRoomEvent: vote RESULT maps to {kind:vote} RoomEvent (brain money-shot)', () => {
    const ev = serverMsgToRoomEvent({
      t: 'vote',
      kind: VOTE_KIND.RESULT,
      winner: 'gravity-flip',
      tally: {},
      cooldownMs: 30000,
      serverTimestamp: 1000,
    });
    expect(ev).toEqual({ kind: 'vote', peerId: 'election' });
  });

  it('serverMsgToRoomEvent: vote OPEN/TALLY return null (no brain cut on ballot events)', () => {
    expect(
      serverMsgToRoomEvent({ t: 'vote', kind: VOTE_KIND.OPEN, options: ['a', 'b'], openedAtMs: 0, deadlineMs: 30000 })
    ).toBeNull();
    expect(
      serverMsgToRoomEvent({
        t: 'vote',
        kind: VOTE_KIND.TALLY,
        options: ['a', 'b'],
        tally: { a: 2, b: 1 },
        voterCount: 3,
        deadlineMs: 25000,
        serverTimestamp: 1000,
      })
    ).toBeNull();
  });

  it('vote OPEN → setReferendumTally + setReferendumCountdown called', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];

    const tallySetSpy = vi.spyOn(stage.overlays, 'setReferendumTally');
    const countdownSpy = vi.spyOn(stage.overlays, 'setReferendumCountdown');

    ws.deliver({
      t: 'vote',
      kind: VOTE_KIND.OPEN,
      options: ['gravity-flip', 'bullet-time'],
      openedAtMs: 0,
      deadlineMs: 30000,
    } as ServerMsg);

    expect(tallySetSpy).toHaveBeenCalledOnce();
    const tallyArg = tallySetSpy.mock.calls[0][0];
    expect(tallyArg.options).toEqual(['gravity-flip', 'bullet-time']);
    expect(tallyArg.voterCount).toBe(0);

    expect(countdownSpy).toHaveBeenCalledOnce();
    // countdown should be 30 s (deadlineMs - openedAtMs = 30000 ms)
    expect(countdownSpy.mock.calls[0][0]).toBeCloseTo(30, 0);

    stage.dispose();
  });

  it('vote TALLY → setReferendumTally updates dueling bars with live vote counts', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];

    const tallySetSpy = vi.spyOn(stage.overlays, 'setReferendumTally');

    ws.deliver({
      t: 'vote',
      kind: VOTE_KIND.TALLY,
      options: ['gravity-flip', 'bullet-time'],
      tally: { 'gravity-flip': 7, 'bullet-time': 3 },
      voterCount: 10,
      deadlineMs: 20000,
      serverTimestamp: 5000,
    } as ServerMsg);

    expect(tallySetSpy).toHaveBeenCalledOnce();
    const arg = tallySetSpy.mock.calls[0][0];
    expect(arg.tally['gravity-flip']).toBe(7);
    expect(arg.tally['bullet-time']).toBe(3);
    expect(arg.voterCount).toBe(10);

    // Verify the bars DOM was updated with both options
    const bars = stage.overlays.root.querySelectorAll('[data-role="referendum-bar"]');
    expect(bars.length).toBe(2);

    stage.dispose();
  });

  it('vote RESULT → showCrowdDecreed invoked AND brain receives a vote RoomEvent (money-shot)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];

    const decreeSpy = vi.spyOn(stage.overlays, 'showCrowdDecreed');
    const countdownSpy = vi.spyOn(stage.overlays, 'setReferendumCountdown');
    // Spy on brain.feed to verify vote RoomEvent is delivered.
    const feedSpy = vi.spyOn(stage.brain, 'feed');

    ws.deliver({
      t: 'vote',
      kind: VOTE_KIND.RESULT,
      winner: 'gravity-flip',
      tally: { 'gravity-flip': 7, 'bullet-time': 3 },
      cooldownMs: 30000,
      serverTimestamp: 1000,
    } as ServerMsg);

    // showCrowdDecreed was invoked with the winner label.
    expect(decreeSpy).toHaveBeenCalledOnce();
    expect(decreeSpy.mock.calls[0][0]).toBe('gravity-flip');

    // Decree text appears in the referendum-decree region.
    const decreeEl = stage.overlays.root.querySelector('[data-role="referendum-decree"]') as HTMLElement;
    expect(decreeEl.textContent).toContain('CROWD DECREED');
    expect(decreeEl.textContent).toContain('gravity-flip');

    // The cue banner is taken over by the decree.
    expect(stage.overlays.activeSlot()).toBe('cue');

    // Countdown cleared.
    expect(countdownSpy).toHaveBeenCalledWith(null);

    // Brain fed a vote RoomEvent (the wide money-shot activity signal).
    const voteEvents = feedSpy.mock.calls.map((c) => c[0] as RoomEvent).filter((e) => e.kind === 'vote');
    expect(voteEvents).toHaveLength(1);
    expect(voteEvents[0]).toEqual({ kind: 'vote', peerId: 'election' });

    // The brain was also forced to WIDE_ESTABLISH for the money-shot window.
    const shot = stage.update(16);
    expect(shot.kind).toBe('WIDE_ESTABLISH');

    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C27 (F16 Siege Waves, §7.16) — the REAL stage reducer's SHOWPIECE WAVE handling.
// These drive the actual `Stage.handleMessage` decode/render path off the wire
// (not a hand-written toy reducer), so they catch the post-arc phantom "WAVE 4"
// bug AND prove the unknown-kind-ignore degrade rung on the real client.
// ---------------------------------------------------------------------------
describe('C27 stage — SHOWPIECE WAVE splash (real reducer, §7.16)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  const banner = (stage: Stage): HTMLElement =>
    stage.overlays.root.querySelector('[data-role="banner"]') as HTMLElement;

  it('an out-of-range waveIndex (≥ SIEGE_WAVES.length — the post-arc tail) renders NO phantom "WAVE 4" splash', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    // A coherent siege arms — START puts the HP bar in the cue banner.
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.START, crystalId: 'c1', hp: 40, maxHp: 40, endsAt: 90000 } as ServerMsg);
    const afterStart = el.textContent;
    expect(afterStart).not.toBe(''); // the HP bar is up
    expect(el.textContent).not.toContain('WAVE');
    // The out-of-range post-arc WAVE index arrives (== SIEGE_WAVES.length). The OLD
    // bug rendered a full-screen "WAVE 4" from `idx + 1`; the fix renders NO splash
    // and leaves the plain siege banner untouched (the §7.16 fallback).
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.WAVE, waveIndex: SIEGE_WAVES.length, waveEndsAt: 0 } as ServerMsg);
    expect(el.textContent).not.toContain('WAVE'); // no phantom "WAVE 4"
    expect(el.dataset['siegeWave']).toBeUndefined(); // no wave-splash marker was set
    expect(el.textContent).toBe(afterStart); // the plain siege banner is unchanged
    stage.dispose();
  });

  it('a −1 "no active wave" sentinel index renders NO splash', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.WAVE, waveIndex: -1, waveEndsAt: 0 } as ServerMsg);
    expect(el.dataset['siegeWave']).toBeUndefined();
    expect(el.textContent).not.toContain('WAVE');
    stage.dispose();
  });

  it('a real in-range waveIndex STILL slams up the correct splash (no regression)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.WAVE, waveIndex: 2, waveEndsAt: 90000 } as ServerMsg);
    expect(el.textContent).toBe(SIEGE_WAVES[2].name); // "WAVE 3 — BULLET TIME"
    expect(el.dataset['siegeWave']).toBe('2');
    stage.dispose();
  });

  it('the REAL reducer IGNORES an unknown SHOWPIECE kind and still renders a coherent siege from START/STATE/END', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.START, crystalId: 'c1', hp: 40, maxHp: 40, endsAt: 90000 } as ServerMsg);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.STATE, hp: 30, maxHp: 40 } as ServerMsg);
    const midSiege = el.textContent;
    // An UNKNOWN future SHOWPIECE kind (0x63) the real reducer does not decode — it
    // must fall through every branch as a no-op (no throw, the banner is unchanged).
    expect(() =>
      ws.deliver({ t: 'showpiece', kind: 0x63, waveIndex: 7, foo: 'bar' } as unknown as ServerMsg)
    ).not.toThrow();
    expect(el.textContent).toBe(midSiege); // ignored — the coherent siege is intact
    // The END card still reads cleanly from the known kinds alone.
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.END, outcome: 'CRYSTAL_STANDS', hp: 30, maxHp: 40, topBombardiers: [] } as ServerMsg);
    expect(el.textContent).toBe('CRYSTAL STANDS');
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C22.5 §6.1 audit — meteor siege CALLOUT narration (spec §7.6/§7.15). The
// callout queue never rides color at all (it is a pure text narration line —
// "INTERCEPT BY VOLT-17"), so it structurally cannot rely on color alone; this
// closes a real coverage gap — no existing test previously exercised `msg.callout`
// on a live SHOWPIECE STATE message, so a dropped callsign in the template would
// have gone unnoticed.
// ---------------------------------------------------------------------------
describe('C22.5 §6.1 audit — meteor callout narration carries the callsign as TEXT', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  const banner = (stage: Stage): HTMLElement =>
    stage.overlays.root.querySelector('[data-role="banner"]') as HTMLElement;

  it('a STATE callout renders "<VERB> <CALLSIGN>" in the banner — never color-only', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.START, crystalId: 'c1', hp: 40, maxHp: 40, endsAt: 90000 } as ServerMsg);
    ws.deliver({
      t: 'showpiece',
      kind: SHOWPIECE_KIND.STATE,
      hp: 38,
      maxHp: 40,
      callout: { kind: 'catch', callsign: 'VOLT-17' },
    } as ServerMsg);
    // The callout is plain narration text — the callsign is legible sound-off and
    // colorblind (no color/swatch is ever attached to a callout).
    expect(el.textContent).toContain('VOLT-17');
    expect(el.textContent).toContain('INTERCEPT BY');
    stage.dispose();
  });

  it('a swat callout attributes the DEFENDER callsign distinctly from a catch', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const el = banner(stage);
    ws.deliver({ t: 'showpiece', kind: SHOWPIECE_KIND.START, crystalId: 'c1', hp: 40, maxHp: 40, endsAt: 90000 } as ServerMsg);
    ws.deliver({
      t: 'showpiece',
      kind: SHOWPIECE_KIND.STATE,
      hp: 36,
      maxHp: 40,
      callout: { kind: 'swat', callsign: 'NEON-04' },
    } as ServerMsg);
    expect(el.textContent).toContain('NEON-04');
    expect(el.textContent).toContain('DEFLECTED BY');
    stage.dispose();
  });
});

// ===========================================================================
// C29 stage wiring — F18 X-Ray Broadcast (spec §7.18). The pure guard logic
// lives in xray.test.ts (XrayController, unit-level); this covers the STAGE
// integration: the hotkey/console-relay entry points, phase tracking, roster
// feed, and the auto-cancel-under-replay poll.
// ===========================================================================

describe('C29 stage — X-Ray Broadcast wiring (spec §7.18)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  it('the hotkey trigger works even with NO socket at all (spec: "zero protocol, works when the tunnel is sad")', () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    // Never connect() — the resilience case: the room already reached PLAY
    // before the tunnel died (phase is tracked independently of the socket).
    stage.xray.setPhase('PLAY');
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    stage.onHotkey('X');
    expect(stage.xray.active).toBe(false);
    stage.dispose();
  });

  it('the hotkey TRIGGER itself never sends a STAGE_XRAY wire message — only an opportunistic ROSTER chip-refresh', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    const sentBefore = ws.sent.length;
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    expect(ws.sent.length).toBe(sentBefore + 1); // the ONE extra send is the roster poll
    const sent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(sent).toMatchObject({ t: 'director-cmd', cmd: 'ROSTER' });
    stage.dispose();
  });

  it('a director-console STAGE_XRAY relay (director-msg) toggles the SAME local x-ray state as the hotkey', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    expect(stage.xray.active).toBe(false);
    ws.deliver({ t: 'director-msg', kind: 'STAGE_XRAY' } as ServerMsg);
    expect(stage.xray.active).toBe(true);
    ws.deliver({ t: 'director-msg', kind: 'STAGE_XRAY' } as ServerMsg);
    expect(stage.xray.active).toBe(false);
    stage.dispose();
  });

  it('an UNRELATED director-msg kind is ignored (never accidentally toggles x-ray)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'director-msg', kind: 'PANIC' } as ServerMsg);
    expect(stage.xray.active).toBe(false);
    stage.dispose();
  });

  it('PHASE_STATE tracking auto-reverts x-ray on a live transition into OVERLOAD', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    ws.deliver({ t: 'phase-state', phase: 'OVERLOAD', endsAt: null, remainingMs: null } as ServerMsg);
    expect(stage.xray.active).toBe(false);
    stage.dispose();
  });

  it('a `roster` reply feeds the "client-reported" RTT chips (never re-measured by the stage)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    ws.deliver({
      t: 'roster',
      entries: [{ id: 'p0', callsign: 'ALPHA', tier: 'resident', entryRoute: 'qr', joinedAt: 0, rttMs: 55 }],
    } as ServerMsg);
    expect(stage.xray.hud().rtt).toEqual([{ id: 'p0', callsign: 'ALPHA', rttMs: 55 }]);
    stage.dispose();
  });

  it('feeds raw `state` frames into the split-truth server-truth dot trail', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({
      t: 'state',
      seq: 0,
      serverTick: 0,
      shapes: [{ id: 's1', p: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    } as ServerMsg);
    expect(stage.xray.serverTruthDots('s1')).toHaveLength(1);
    expect(stage.xray.serverTruthDots('s1')[0].p).toEqual({ x: 1, y: 2, z: 3 });
    stage.dispose();
  });

  it('auto-cancels while a C21 replay is airing (state exclusion, spec §7.18) — via Stage.update()', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    // Two state frames spanning ticks 0..30 (≈1 s at 30 Hz) so the extracted
    // replay segment has REAL duration (a single-tick segment auto-finishes on
    // its first `advance()` — this must still be airing when `update()` polls).
    ws.deliver({
      t: 'state',
      seq: 0,
      serverTick: 0,
      shapes: [{ id: 's1', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    } as ServerMsg);
    ws.deliver({
      t: 'state',
      seq: 1,
      serverTick: 30,
      shapes: [{ id: 's1', p: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    expect(stage.replay.replayLast(1000)).toBe(true); // force a replay airing
    expect(stage.replay.isAiring()).toBe(true);
    stage.update(16); // Stage.update() drives xray.update(), which polls isReplayAiring()
    expect(stage.xray.active).toBe(false);
    stage.dispose();
  });

  it('is refused while a replay is ALREADY airing at trigger time', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({
      t: 'state',
      seq: 0,
      serverTick: 0,
      shapes: [{ id: 's1', p: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }],
    } as ServerMsg);
    expect(stage.replay.replayLast(1000)).toBe(true);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(false); // refused — a replay owns the stage
    stage.dispose();
  });

  it('the xray overlay root is its own DOM region, distinct from the shared banner slot system', () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    expect(stage.xray.root).not.toBe(stage.overlays.root);
    expect(stage.xray.root.dataset['role']).toBe('stage-xray');
    stage.dispose();
  });

  it('dispose() tears down the x-ray controller too (no dangling DOM/interpolator)', () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    const parent = document.createElement('div');
    parent.appendChild(stage.xray.root);
    expect(() => stage.dispose()).not.toThrow();
    expect(parent.contains(stage.xray.root)).toBe(false);
  });
});

// ===========================================================================
// C29 fix (post-review) — MUST-FIX 2: x-ray activation pins the brain to
// WIDE_ESTABLISH via force() (brief: "brain pinned WIDE_ESTABLISH via
// force()"). Without this, the StageBrain kept auto-cutting
// (FOLLOW_THROW/GLYPH_BIRTH/JOIN_CRANE) over the 60–90 s x-ray window and the
// camera swung instead of holding the stable wide comparison the split-truth
// diagnostic needs. The pin must ALSO release on every revert path — else the
// camera sticks on WIDE_ESTABLISH long after x-ray ends.
// ===========================================================================

describe('C29 stage — x-ray pins the brain to WIDE_ESTABLISH via force() (post-review fix, spec §7.18)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  it('activating x-ray force()-pins the brain to WIDE_ESTABLISH — a hard throw during the window never cuts the camera away', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    // Without the pin this exact sequence cuts to FOLLOW_THROW (proven by the
    // sibling non-xray test "feeds inbound RoomEvents to the brain" above —
    // identical trigger, no x-ray involved).
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 20, y: 0, z: 0 } });
    const shot = stage.update(16);
    expect(shot.kind).toBe('WIDE_ESTABLISH');
    stage.dispose();
  });

  it('a manual revert (hotkey toggle off) releases the pin — the brain resumes cutting normally, not stuck wide', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    stage.onHotkey('x'); // manual revert, well before the 75 s auto-revert window
    expect(stage.xray.active).toBe(false);
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 20, y: 0, z: 0 } });
    const shot = stage.update(16);
    expect(shot.kind).toBe('FOLLOW_THROW');
    expect(shot.targetId).toBe('s9');
    stage.dispose();
  });

  it('a phase-guard auto-revert (a live transition into OVERLOAD) also releases the pin', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    ws.deliver({ t: 'phase-state', phase: 'OVERLOAD', endsAt: null, remainingMs: null } as ServerMsg);
    expect(stage.xray.active).toBe(false);
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 20, y: 0, z: 0 } });
    const shot = stage.update(16);
    expect(shot.kind).toBe('FOLLOW_THROW');
    stage.dispose();
  });

  it('the 60–90 s auto-revert timer also releases the pin (the camera never stays stuck wide after the window ends)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    stage.onHotkey('x');
    expect(stage.xray.active).toBe(true);
    stage.update(XRAY_AUTO_REVERT_MS + 1); // exhaust the whole auto-revert window in one frame
    expect(stage.xray.active).toBe(false);
    ws.deliver({ t: 'grab', id: 's9', peerId: null, vel: { x: 20, y: 0, z: 0 } });
    const shot = stage.update(16);
    expect(shot.kind).toBe('FOLLOW_THROW');
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C31 stage — F20 Neon Clip Machine wiring (spec §7.20)
// ---------------------------------------------------------------------------
describe('C31 stage — SAVE CLIP + auto-first wiring', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  it('the "c"/"C" hotkey mints a fresh clipId and fires onSaveClip with trigger "manual" — zero protocol (works with no socket)', () => {
    let n = 0;
    const stage = new Stage(document, {
      room: 'r1',
      wsUrl: 'ws://x/ws',
      clipMintId: () => `clip-${n++}`.padEnd(32, '0').slice(0, 32),
    });
    const seen: Array<{ clipId: string; trigger: string }> = [];
    stage.onSaveClip((clipId, trigger) => seen.push({ clipId, trigger }));
    stage.onHotkey('c');
    stage.onHotkey('C');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.trigger).toBe('manual');
    expect(seen[1]!.trigger).toBe('manual');
    expect(seen[0]!.clipId).not.toBe(seen[1]!.clipId); // a fresh mint every trigger
    stage.dispose();
  });

  it('a director-console SAVE_CLIP relay (director-msg) fires the SAME onSaveClip hook as the hotkey', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const seen: Array<{ clipId: string; trigger: string }> = [];
    stage.onSaveClip((clipId, trigger) => seen.push({ clipId, trigger }));
    ws.deliver({ t: 'director-msg', kind: 'SAVE_CLIP' } as ServerMsg);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trigger).toBe('manual');
    stage.dispose();
  });

  it('an UNRELATED director-msg kind never fires SAVE CLIP', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    let fired = false;
    stage.onSaveClip(() => (fired = true));
    ws.deliver({ t: 'director-msg', kind: 'PANIC' } as ServerMsg);
    expect(fired).toBe(false);
    stage.dispose();
  });

  it('FINALE→STATS with NO highlight aired fires NEITHER the replay NOR SAVE CLIP (min-activity gate — no scored data)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    let fired = false;
    stage.onSaveClip(() => (fired = true));
    ws.deliver({ t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);
    expect(stage.replay.isAiring()).toBe(false); // nothing scored → nothing aired
    expect(fired).toBe(false);
    stage.dispose();
  });

  it('FINALE→STATS auto-first fires onSaveClip with trigger "auto" when a highlight replay airs (stubbed C21 trigger — the SAME reuse the spec mandates)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    // Stub the C21 primary trigger to simulate "a highlight cleared min-activity
    // and aired" without fabricating a full physics fixture (replay.dom.test.ts
    // already proves the scorer/gate itself) — this test proves the WIRING: the
    // STATS transition calls the SAME entry point the '5' hotkey uses, and a
    // truthy return mints exactly one auto clipId.
    vi.spyOn(stage.replay, 'replayLastHighlight').mockReturnValue(true);
    const seen: Array<{ clipId: string; trigger: string }> = [];
    stage.onSaveClip((clipId, trigger) => seen.push({ clipId, trigger }));

    ws.deliver({ t: 'phase-state', phase: 'PLAY', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.trigger).toBe('auto');
    stage.dispose();
  });

  it('ONLY ONE auto-clip per rotation: a second STATS re-delivery in the same rotation does NOT re-fire; a fresh rotation (LOBBY) re-arms it', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    vi.spyOn(stage.replay, 'replayLastHighlight').mockReturnValue(true);
    const seen: Array<{ clipId: string; trigger: string }> = [];
    stage.onSaveClip((clipId, trigger) => seen.push({ clipId, trigger }));

    ws.deliver({ t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);
    expect(seen).toHaveLength(1);

    // A same-phase re-delivery (no edge) never re-fires.
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);
    expect(seen).toHaveLength(1);

    // A fresh rotation: RESET → ATTRACT → LOBBY → ... → FINALE → STATS re-arms + re-fires.
    ws.deliver({ t: 'phase-state', phase: 'RESET', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'LOBBY', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.clipId).not.toBe(seen[1]!.clipId);
    stage.dispose();
  });

  it('the SAVE CLIP hotkey override still works even after auto-first already consumed the rotation slot', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    vi.spyOn(stage.replay, 'replayLastHighlight').mockReturnValue(true);
    const seen: Array<{ clipId: string; trigger: string }> = [];
    stage.onSaveClip((clipId, trigger) => seen.push({ clipId, trigger }));

    ws.deliver({ t: 'phase-state', phase: 'FINALE', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'phase-state', phase: 'STATS', endsAt: null, remainingMs: null } as ServerMsg);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trigger).toBe('auto');

    stage.onHotkey('c');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.trigger).toBe('manual');
    stage.dispose();
  });
});

// ---------------------------------------------------------------------------
// C22 (F10 Ghost Arcade): the ATTRACT ghost playback wiring — the stage requests
// a banked reel on ATTRACT and plays the sanitized `reel-data` through the frozen
// interpolator adapter (the render layer binds via onAttractReel).
// ---------------------------------------------------------------------------
describe('C22 stage — ATTRACT ghost playback (reel-play → reel-data)', () => {
  beforeEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = MockWS;
    MockWS.instances = [];
  });

  function tinyReel() {
    return {
      durationMs: 1000,
      frames: [
        {
          tick: 0,
          wallTime: 0,
          transforms: [
            { id: 's1', p: { x: 1, y: 2, z: 3 }, r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, order: 0 },
          ],
          discrete: [],
          keyframe: { shapes: [] },
        },
      ],
    };
  }

  it('requests a banked reel (reel-play) when the server enters ATTRACT', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    ws.deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null } as ServerMsg);
    const reelPlays = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'reel-play');
    expect(reelPlays).toHaveLength(1);
    stage.dispose();
  });

  it('plays the sanitized reel-data through the frozen interpolator adapter (onAttractReel)', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const seen: Array<{ hasSource: boolean; reelId: string | null }> = [];
    const frames: unknown[] = [];
    stage.onAttractReel((source, reelId) => {
      seen.push({ hasSource: source !== null, reelId });
      if (source) {
        source.onState((f) => frames.push(f));
        source.advanceTo(source.durationMs); // drive the play head to emit frames
      }
    });

    ws.deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'reel-data', reelId: 'reel-1', reel: tinyReel() } as ServerMsg);

    expect(seen).toEqual([{ hasSource: true, reelId: 'reel-1' }]);
    expect(stage.attractPlaying).toBe(true);
    expect(stage.attractReelSource).not.toBeNull();
    // The reel actually feeds StateFrames through the shared interpolator adapter.
    expect(frames.length).toBeGreaterThan(0);
    stage.dispose();
  });

  it('an EMPTY bank (reel-data null) leaves the render layer to fall back to the ballet', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const seen: Array<boolean> = [];
    stage.onAttractReel((source) => seen.push(source !== null));

    ws.deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'reel-data', reelId: null, reel: null } as ServerMsg);

    expect(seen).toEqual([false]); // null source → the render layer shows the ballet
    expect(stage.attractPlaying).toBe(false);
    stage.dispose();
  });

  it('leaving ATTRACT tears the ghost source down (onAttractReel(null))', async () => {
    const stage = new Stage(document, { room: 'r1', wsUrl: 'ws://x/ws' });
    stage.connect();
    await Promise.resolve();
    const ws = MockWS.instances[0];
    const seen: Array<boolean> = [];
    stage.onAttractReel((source) => seen.push(source !== null));

    ws.deliver({ t: 'phase-state', phase: 'ATTRACT', endsAt: null, remainingMs: null } as ServerMsg);
    ws.deliver({ t: 'reel-data', reelId: 'reel-1', reel: tinyReel() } as ServerMsg);
    expect(stage.attractPlaying).toBe(true);
    // A human arrives → LOBBY. The ghosts dissolve.
    ws.deliver({ t: 'phase-state', phase: 'LOBBY', endsAt: null, remainingMs: null } as ServerMsg);
    expect(seen).toEqual([true, false]);
    expect(stage.attractPlaying).toBe(false);
    expect(stage.attractReelSource).toBeNull();
    stage.dispose();
  });
});
