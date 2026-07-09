/**
 * stage.ts — the F1 Neon Director stage client (C9, spec §7.1). `?mode=stage`.
 *
 * The big-screen self-directing broadcast that runs the booth. It:
 *   • connects as a SPECTATOR-tier client carrying the staff ownerToken (§5.1 /
 *     §5.4 — the ownerToken grants DIRECTOR_CMD + staff hotkeys on any tier; it
 *     rides the join payload over wss, NEVER a URL);
 *   • maps each inbound ServerMsg → a normalized RoomEvent and feeds the pure
 *     StageBrain, then renders the brain's Shot each frame;
 *   • exposes `requestShot(shot, holdMs)` — the EXTERNAL cue→camera hook C12
 *     (GLYPH_BIRTH), C16 (crystal cam), C17 (worm's-eye) and C32 (POWERS) ride;
 *   • binds STAFF HOTKEYS 1–9/0 to force shots/targets (override the brain until
 *     release/timeout, then the brain resumes with its invariants intact);
 *   • KIOSK resilience: WS auto-reconnect (backoff), render-stall auto-reload,
 *     and a periodic health-check of the PUBLIC join URL that swaps the QR for an
 *     "ask staff" card when the tunnel is dead;
 *   • GOVERNOR: internal render capped at 1080p + upscale, half-res bloom (§6.5
 *     stage-laptop budget), validated on an integrated-GPU laptop.
 *
 * The heavy 3D render path (THREE + bloom) is LAZY-imported after the socket is
 * up (join-first, like the wisp entry) so the stage ENTRY chunk stays small and
 * the size gate never pulls three into a synchronously-loaded graph. The pure
 * orchestration below (adapter + brain + hotkeys + kiosk + overlays) has ZERO
 * three import and is the unit-testable surface.
 */

import {
  encodeText,
  decodeText,
  decodeBinary,
  OPCODES,
  PROTOCOL_VERSION,
  CYBER_COLORS,
  StageBrain,
  cueBannerText,
  VOTE_KIND,
  SHOWPIECE_KIND,
  SIEGE_WAVES,
  type ClientMsg,
  type ServerMsg,
  type Shot,
  type Vec3,
  type Reel,
} from '@cyber-shapes/shared';
import { reelToStateSource, type ReelSource } from './attract.js';

/** C32 (F21 Powers Lab): the render-layer TK tether/skeleton state (anchor+target). */
export interface TkTetherState {
  peerId: string | null;
  pulls: Array<{ hand: number; anchor: Vec3; targetId: string }>;
}
import { StageOverlays } from './overlays.js';
import { StageReplay } from './replay.js';
import { XrayController, XRAY_ROSTER_POLL_MS, XRAY_AUTO_REVERT_MS } from './xray.js';
import { serverMsgToRoomEvent } from '../events.js';
import { ClipDirector, clipRetrievalUrl } from './clips.js';

// ---------------------------------------------------------------------------
// ServerMsg → RoomEvent adapter (C0 binding 14) — SINGLE-SOURCE in `../events.ts`.
//
// C9 kept this inline with a "noted for the move" comment; C33 (spec §7.22) does
// the move: the mapping now lives in `packages/client/src/events.ts` so BOTH the
// stage AND the desktop AUTO camera consume it without the desktop main chunk
// importing stage-only code. Re-exported here so `stage/replay.ts` and the C9 stage
// tests (which import it from `./stage.js`) keep working unchanged.
// ---------------------------------------------------------------------------

export { serverMsgToRoomEvent };

// ---------------------------------------------------------------------------
// Staff hotkey map (1–9 / 0) — force a shot/target, overriding the brain.
// ---------------------------------------------------------------------------

/** How long a hotkey-forced shot holds before the brain resumes (ms). */
export const HOTKEY_HOLD_MS = 8000;

/**
 * Map a keyboard key ('1'–'9', '0') to a forced Shot, or null if unbound. Pure +
 * exported for the unit test. Targets that need a live id (FOLLOW_THROW target)
 * default to the brain's current target — passed in by the caller; here we bind
 * the SHOT KIND per key (the staff-taste override, spec §7.1). '0' = force the
 * establishing WIDE_ESTABLISH (the "cool it down" panic key).
 */
export function hotkeyToShot(key: string, currentTarget: string | undefined): Shot | null {
  switch (key) {
    case '1':
      return { kind: 'WIDE_ESTABLISH', sinceMs: 0 };
    case '2':
      return { kind: 'FOLLOW_THROW', targetId: currentTarget, sinceMs: 0 };
    case '3':
      return { kind: 'JOIN_CRANE', targetId: currentTarget, sinceMs: 0 };
    case '4':
      return { kind: 'GLYPH_BIRTH', targetId: currentTarget, sinceMs: 0 };
    case '0':
      // Panic / cool-down: hard-cut back to the safe establishing shot.
      return { kind: 'WIDE_ESTABLISH', sinceMs: 0 };
    default:
      // 5–9 are reserved for target-cycle / future shots (bound as they land);
      // an unbound key is a no-op (the brain keeps control).
      return null;
  }
}

// ---------------------------------------------------------------------------
// Kiosk config
// ---------------------------------------------------------------------------

/** Reconnect backoff schedule (ms) for the kiosk WS (capped, never gives up). */
export const RECONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000, 10000];
/** If no frame renders for this long, the kiosk auto-reloads (render-stall). */
export const RENDER_STALL_MS = 10000;
/** How often the kiosk health-checks the public join URL. */
export const HEALTH_CHECK_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// The stage orchestrator (injectable seams; the 3D render is attached lazily).
// ---------------------------------------------------------------------------

export interface StageOpts {
  /** Room id (from `/r/:roomId` or `?room=`). */
  room: string;
  /** The staff ownerToken — rides the join payload (§5.4). NEVER logged. */
  ownerToken?: string;
  /** wss endpoint. Defaults to a same-origin `/ws`. */
  wsUrl?: string;
  /** Injected WebSocket ctor (tests stub). Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Injected time source (ms). Defaults to performance.now. */
  now?: () => number;
  /** §14 flex-line gate: true iff the C2 tier fan-out harness is green. */
  flexLineGranted?: boolean;
  /** Brain config (spec §7.1). */
  brain?: { minShotMs: number; heatThreshold: number };
  /** C31: injected clipId minter for the ClipDirector (tests inject a fake). */
  clipMintId?: () => string;
}

const DEFAULT_BRAIN = { minShotMs: 2500, heatThreshold: 6 } as const;

/** How long the birth-moment stage highlight blazes (spec §7.13: 3 s). */
export const GLYPH_HIGHLIGHT_MS = 3000;
/** The GLYPH_BIRTH shot hold (spec §7.13: camera flies to the new glyph ~5 s). */
export const GLYPH_BIRTH_HOLD_MS = 5000;
/** The Meteor Siege crystal-cam hold (spec §7.6: the auto-framed crystal camera). */
export const SIEGE_CAM_HOLD_MS = 8000;
/**
 * C17 (F7 Titan Protocol, §7.7): how long the forced low-angle worm's-eye shot
 * holds on the stage when a player titanizes. Long enough to be "the shot people
 * post"; the brain resumes with its invariants intact afterward.
 */
export const TITAN_WORM_EYE_HOLD_MS = 8000;

/**
 * C32 (F21 Powers Lab, §7.21): how long the forced POWERS shot holds when a TK
 * pull begins — a medium on the player + the shape tearing across the room.
 */
export const POWERS_SHOT_HOLD_MS = 6000;
/**
 * C32: the mandated lower-third for the moment (spec §7.21). Renders while a TK
 * pull is live so the audience reads "this is bare hands, not a physics bug".
 */
export const POWERS_LOWER_THIRD = 'NO CONTROLLERS — CAMERA-TRACKED HANDS';

/** Render the oversized HP-bar banner text (spec §7.6). Undefined HP → blank bar. */
function hpBarText(hp?: number, maxHp?: number): string {
  if (typeof hp !== 'number' || typeof maxHp !== 'number' || maxHp <= 0) return 'CRYSTAL SIEGE';
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  const cells = 20;
  const filled = Math.round(pct * cells);
  return `CRYSTAL ${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${hp}/${maxHp}`;
}

/** Map a callout kind → its big-screen narration verb (§7.6 priority order). */
function calloutLine(kind: string): string {
  switch (kind) {
    case 'catch':
      return 'INTERCEPT BY';
    case 'throwback':
      return 'RETURN TO SENDER —';
    case 'swat':
      return 'DEFLECTED BY';
    case 'hit':
      return 'CRYSTAL STRUCK —';
    default:
      return '';
  }
}

/**
 * The sink the LAZY 3D glyph field (glyphRender.ts) registers so the pure Stage
 * can drive the constellation without importing three. A birthed glyph, the
 * backfill snapshot, a staff remove, and the panic hide all flow through here.
 */
export interface GlyphSink {
  /** Backfill: the full guestbook snapshot (chunked render is the field's job). */
  setGlyphs(glyphs: StageGlyph[]): void;
  /** A live birth — add + spotlight it for the highlight window. */
  add(glyph: StageGlyph): void;
  /** A staff despawn / evict-oldest — drop it. */
  remove(id: string): void;
  /** The panic-key result — hide these ids on every screen. */
  hide(ids: string[]): void;
  /** Spotlight (or clear) the birth-moment highlight. */
  highlight(id: string | null): void;
}

/** The stage-side glyph shape (mirrors GlyphNet — callsign only, §6.1). */
export interface StageGlyph {
  id: string;
  callsign: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  slotIndex: number;
  seeded?: boolean;
}

/**
 * The Neon Director. Constructing it wires the brain + overlays; call `connect()`
 * to open the socket. The 3D render loop attaches via `attachRenderer()` (lazy)
 * so the pure logic here is testable without a WebGL context.
 */
export class Stage {
  readonly brain: StageBrain;
  readonly overlays: StageOverlays;
  /** C21 F11 Chrono Snap: the ~30 s replay ring + flow (thin adapter). */
  readonly replay: StageReplay;
  /** C29 F18 X-Ray Broadcast: the split-truth netcode diagnostic overlay. */
  readonly xray: XrayController;
  /** C31 F20 Neon Clip Machine: auto-first-per-rotation + SAVE CLIP gating (pure). */
  readonly clips: ClipDirector;

  private readonly opts: StageOpts;
  private readonly now: () => number;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  /** Last shot the render loop consumed (drives hotkey target defaulting). */
  private lastShot: Shot;
  /** Live participant count (from welcome/join/leave) for the §14 counter. */
  private playerCount = 0;
  /** C12: the 3D glyph field sink (registered by the lazy renderer), or null. */
  private glyphSink: GlyphSink | null = null;
  /** C12: the id currently birth-highlighted, and ms remaining on the highlight. */
  private highlightId: string | null = null;
  private highlightRemainingMs = 0;
  /** C12: a fired-once hook per birth (toast + chord) for the render/audio layer. */
  private onGlyphBirthCb: ((glyph: StageGlyph) => void) | null = null;
  /**
   * C32 (F21 Powers Lab, §7.21): true while a TK pull is live (a committed pull
   * tether present), the ≤ 2 live tethers, and the render-layer beam sink. The
   * server sends only the anchor + target id (NO joint streaming); the neon tether
   * beam + skeleton hands are drawn by the render layer (owner/hardware-verified).
   */
  private tkPullActive = false;
  private tkTethers: Array<{ hand: number; anchor: Vec3; targetId: string }> = [];
  private tkTetherSink: ((t: TkTetherState) => void) | null = null;
  /** C29: ms remaining before the next ROSTER re-poll while x-ray is live. */
  private xrayRosterPollRemainingMs = 0;
  /**
   * C29 fix (post-review): true while the brain is force()-pinned to
   * WIDE_ESTABLISH for the x-ray diagnostic window. Edge-detected off
   * `xray.active` by {@link syncXrayCameraPin} so the pin is engaged exactly
   * once per activation and released exactly once per revert, regardless of
   * which of the several revert paths (manual toggle, the 60–90 s timer, the
   * phase guard, the replay-airing auto-cancel) fired.
   */
  private xrayPinned = false;
  /** C31: the last observed phase-state phase, for edge-detecting LOBBY/STATS entry. */
  private lastPhase: string | null = null;
  /**
   * C31: fired with a freshly-minted clipId whenever a SAVE CLIP trigger (auto-
   * first at FINALE→STATS, or the hotkey/console override) fires. The actual
   * capture (compositor canvas + MediaRecorder + upload) is owned by the lazy
   * render layer, which binds here via {@link onSaveClip} — real Web APIs stage.ts
   * itself never touches, so the pure orchestration above stays render-free.
   */
  private onSaveClipCb: ((clipId: string, trigger: 'auto' | 'manual') => void) | null = null;

  /**
   * C22 (F10 Ghost Arcade): the ATTRACT reel playback SOURCE. The server's
   * Showrunner OWNS the ATTRACT phase (authoritative `phase-state`); on ATTRACT the
   * stage requests a banked reel (`reel-play`) and, on the `reel-data` reply, wraps
   * it in a {@link reelToStateSource} — the SAME frozen interpolator adapter live
   * play uses. The heavy ghost RENDER (70 % opacity + GHOST_XX nameplates) is owned
   * by the lazy render layer, which binds via {@link onAttractReel}; the played
   * ghosts are sanitized server-side (callsign only, §6.1). `null` reel → the render
   * layer shows the scripted day-one shape-ballet.
   */
  private attractReel: ReelSource | null = null;
  private attractReelId: string | null = null;
  private onAttractReelCb: ((source: ReelSource | null, reelId: string | null) => void) | null =
    null;

  constructor(doc: Document, opts: StageOpts) {
    this.opts = opts;
    this.now = opts.now ?? (() => performance.now());
    const cfg = opts.brain ?? DEFAULT_BRAIN;
    this.brain = new StageBrain(cfg);
    this.overlays = new StageOverlays(doc, { flexLineGranted: opts.flexLineGranted });
    this.replay = new StageReplay({ overlays: this.overlays, now: this.now });
    this.clips = new ClipDirector(opts.clipMintId ? { mintId: opts.clipMintId } : {});
    this.xray = new XrayController(doc, {
      now: this.now,
      // C29 state exclusion (spec §7.18): refused/auto-cancelled while a C21
      // replay is airing. Injected (never imported) so xray.ts stays render/
      // socket-free — this is the ONLY coupling point, and it is READ-only.
      isReplayAiring: () => this.replay.isAiring(),
    });
    this.lastShot = { kind: 'WIDE_ESTABLISH', sinceMs: 0 };
  }

  /** Derive a same-origin wss:// URL when none is given. */
  private resolveWsUrl(): string {
    if (this.opts.wsUrl) return this.opts.wsUrl;
    const loc = (globalThis as unknown as { location?: { protocol: string; host: string } })
      .location ?? { protocol: 'https:', host: 'localhost' };
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc.host}/ws`;
  }

  /** Open the spectator socket and start the handshake (idempotent). */
  connect(): void {
    if (this.disposed || this.ws) return;
    const WS =
      this.opts.WebSocketImpl ??
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    const ws = new WS(this.resolveWsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      const join: ClientMsg = {
        t: 'join',
        room: this.opts.room,
        name: 'stage',
        color: 0,
        protocol: PROTOCOL_VERSION,
        // The stage is a SPECTATOR carrying the ownerToken (§5.1 / §5.4).
        tier: 'spectator',
        ...(this.opts.ownerToken !== undefined ? { ownerToken: this.opts.ownerToken } : {}),
      };
      ws.send(encodeText(join));
      this.reconnectAttempt = 0; // a clean open resets the backoff ladder
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        // C26 (F15 MC NULL): a binary CASTER_LINE (0x33) renders a caption. Every
        // other binary frame (voice 0x1x, MUSIC 0x29) is not stage-consumed here.
        if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data);
        return;
      }
      let msg: ServerMsg;
      try {
        msg = decodeText(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // A silent drop closes soon after; the close handler drives reconnect.
    };
  }

  /**
   * Apply one binary Phase-C frame. Only CASTER_LINE (0x33) is stage-consumed: it
   * renders a caption via the shared grammar renderer (the stage NEVER generates a
   * line). A malformed frame is swallowed — a bad byte never kills the socket bus.
   */
  private handleBinary(buf: ArrayBuffer): void {
    try {
      const bytes = new Uint8Array(buf);
      // Defensive bounds (C26): the stage AND the 128 unauthed audience screens
      // decode UNTRUSTED 0x33 frames off the wire. Reject anything shorter than the
      // CASTER_LINE length header (preamble 2 + header 4 = 6 B), or not a caster
      // caption, BEFORE decoding. The decode itself is length-checked too —
      // decodeBinary validates the full slot span against the declared slotCount and
      // THROWS on a truncated frame (slotCount claims N but the buffer is short), so
      // a corrupt frame is swallowed here and NEVER crashes the socket bus.
      if (bytes.length < 6 || bytes[0] !== OPCODES.CASTER_LINE) return;
      const { fields } = decodeBinary(buf);
      this.overlays.setCasterLine(fields['templateId'] as number, fields['slots'] as number[]);
    } catch {
      /* a malformed / truncated binary frame is ignored — never throws out of onmessage */
    }
  }

  /** Apply one decoded ServerMsg: track counts + feed the brain. */
  private handleMessage(msg: ServerMsg): void {
    // C21 F11 Chrono Snap: feed every message into the ~30 s replay ring + the
    // shared highlight-scorer window (state frames, ENV_STATE dial flag, throws).
    this.replay.ingest(msg);

    // C29 F18 X-Ray Broadcast (spec §7.18): raw tick-stamped "server truth" dots
    // + the −300 ms ghost delay shim are fed from the SAME `state` stream every
    // other stage feature already consumes (C2 spectator streamRate:'full').
    if (msg.t === 'state') {
      this.xray.ingestState(msg);
    }

    // C29: phase tracking drives the PLAY/ATTRACT trigger guard + the auto-revert
    // on any transition OUT of {PLAY, ATTRACT} (OVERLOAD/FINALE included) + the
    // ATTRACT pause/resume precedence.
    if (msg.t === 'phase-state') {
      this.xray.setPhase(msg.phase);
      this.syncXrayCameraPin(); // a phase-guard auto-revert must release the pin too

      // C31 (F20 Neon Clip Machine, spec §7.20): "auto-first" — at the
      // FINALE→STATS transition, fire the SAME primary replay trigger C21's '5'
      // hotkey uses (reusing its scorer + min-activity gate, never duplicated
      // here). If a highlight actually aired, the ClipDirector mints ONE clipId
      // per rotation and the render layer's recorder rides the replay that is
      // already airing as dead-time STATS content (spec: "the replay airing
      // during STATS is good dead-time content and the recorder rides it").
      if (msg.phase === 'STATS' && this.lastPhase !== 'STATS') {
        const aired = this.replay.replayLastHighlight();
        const clipId = this.clips.maybeAutoClip(aired);
        if (clipId) this.onSaveClipCb?.(clipId, 'auto');
        // C31 (§7.20): the on-stage "SCAN TO TAKE YOUR CLIP HOME" CTA card — the
        // §7.20-mandated take-home prompt (previously dead copy). Shown at STATS
        // for ~CLIP_TAKE_HOME_CARD_MS; if an auto-clip was minted, its retrieval
        // URL rides the card for the QR raster.
        const loc = (globalThis as unknown as { location?: { origin: string } }).location;
        const url = clipId && loc?.origin ? clipRetrievalUrl(loc.origin, clipId) : null;
        this.overlays.showClipTakeHomeCard(url);
      }
      // A fresh rotation (LOBBY entry) re-arms the auto-first gate + clears the card.
      if (msg.phase === 'LOBBY' && this.lastPhase !== 'LOBBY') {
        this.clips.onRotationStart();
        this.overlays.hideClipTakeHomeCard();
      }
      // C22 (F10 Ghost Arcade, §7.10): on ATTRACT entry, request a banked reel so
      // the big screen plays "ghosts of the day's best players" under SCAN TO ENTER
      // THE VOID — not an empty room. Leaving ATTRACT tears the ghost source down.
      if (msg.phase === 'ATTRACT' && this.lastPhase !== 'ATTRACT') {
        this.overlays.setAttractMode(true);
        this.sendReelPlay();
      } else if (msg.phase !== 'ATTRACT' && this.lastPhase === 'ATTRACT') {
        this.overlays.setAttractMode(false);
        this.clearAttractReel();
      }
      this.lastPhase = msg.phase;
    }

    // C22: the banked reel reply — wrap it in the frozen interpolator adapter and
    // hand the ghost source to the render layer (owner-verified visuals).
    if (msg.t === 'reel-data') {
      this.applyReelData(msg.reel, msg.reelId);
    }

    // C29: the roster reply (director/spectator only, C3/C4) — the "client-
    // reported" RTT chip source. The stage polls ROSTER while x-ray is live
    // (see `update()`); any other unsolicited roster push also feeds it.
    if (msg.t === 'roster') {
      this.xray.ingestRoster(msg.entries);
    }

    // C29: the director-console x-ray trigger relay (0x22 DIRECTOR family,
    // STAGE_XRAY kind — spec §7.18). Functionally identical to the stage-LOCAL
    // hotkey: both call the SAME toggle. NEVER auto-cued — only a staff hotkey
    // or this explicit console relay reaches here.
    if (msg.t === 'director-msg' && msg.kind === 'STAGE_XRAY') {
      this.toggleXray();
    }

    // C31: the director-console SAVE CLIP relay (0x22 DIRECTOR family, SAVE_CLIP
    // kind). Functionally identical to the stage-LOCAL hotkey: both call the
    // SAME trigger. NEVER auto-cued — only the hotkey, this console relay, or
    // the FINALE→STATS auto-first path (above) reaches here.
    if (msg.t === 'director-msg' && msg.kind === 'SAVE_CLIP') {
      this.triggerSaveClip();
    }

    // Participant-count bookkeeping for the §14 counter.
    if (msg.t === 'welcome') this.playerCount = msg.players.length;
    else if (msg.t === 'player-join') this.playerCount += 1;
    else if (msg.t === 'player-leave') this.playerCount = Math.max(0, this.playerCount - 1);
    this.overlays.setPlayerCount(this.playerCount);

    // C25 (F14 The Gallery): the AUDIENCE_STATE {viewerCount} 0.2 Hz counter drives
    // the big-screen "N WATCHING · 0 VIDEO FRAMES SENT" line (renders only at N ≥ 5).
    if (msg.t === 'audience-state') {
      this.overlays.setWatcherCount(msg.viewerCount);
    }

    // C11 cue banner (spec §7.3, hard deliverable): the big-screen "BULLET TIME
    // ×0.25" line, driven by ENV_STATE. cueBannerText('' when no dial) clears the
    // slot so the §7.1 banner contention re-resolves (replay > CUE > caster > ticker).
    if (msg.t === 'env-state') {
      this.overlays.setCueBanner(
        cueBannerText({
          serverTimestamp: msg.serverTimestamp,
          mode: msg.mode,
          params: msg.params,
          endsAt: msg.endsAt,
        })
      );
    }

    // C12: the Neon Guestbook. The birth moment IS the product (spec §7.13): a
    // new glyph flies the camera to it (requestShot GLYPH_BIRTH ~5 s), lights a
    // callsign lower-third, spotlights the glyph for 3 s, and rings a spawn chord
    // + an in-rotation HUD toast (both via the render/audio layer's onGlyphBirth).
    if (msg.t === 'glyph-snapshot') {
      this.glyphSink?.setGlyphs(msg.glyphs);
    } else if (msg.t === 'glyph') {
      const g = msg.glyph;
      this.glyphSink?.add(g);
      // The birth moment: fly to the glyph + spotlight it + callsign lower-third.
      this.requestShot({ kind: 'GLYPH_BIRTH', targetId: g.id, sinceMs: 0 }, GLYPH_BIRTH_HOLD_MS);
      this.overlays.setLowerThird({ callsign: g.callsign, color: g.color, pattern: 'solid' });
      this.glyphSink?.highlight(g.id);
      this.highlightId = g.id;
      this.highlightRemainingMs = GLYPH_HIGHLIGHT_MS;
      this.onGlyphBirthCb?.(g);
    } else if (msg.t === 'glyph-remove') {
      this.glyphSink?.remove(msg.id);
    } else if (msg.t === 'glyph-hide') {
      this.glyphSink?.hide(msg.ids);
    }

    // C15 §7.5 "big screen owns the drama": the three VOTE kinds drive the referendum
    // chrome (tally bars / countdown / THE CROWD DECREED) on the stage overlay.
    //   OPEN  (kind=0): a fresh ballot → show initial tally bars + countdown.
    //   TALLY (kind=2): 2 Hz coalesced tally → update the dueling bars.
    //   RESULT(kind=3): the enacted winner → "THE CROWD DECREED" splash + wide money-shot.
    if (msg.t === 'vote') {
      if (msg.kind === VOTE_KIND.OPEN) {
        const options = msg.options ?? [];
        const tally: Record<string, number> = {};
        for (const o of options) tally[o] = 0;
        this.overlays.setReferendumTally({ options, tally, voterCount: 0 });
        const deadlineMs = msg.deadlineMs;
        const openedAtMs = msg.openedAtMs;
        const secondsRemaining =
          deadlineMs !== undefined && openedAtMs !== undefined
            ? Math.max(0, (deadlineMs - openedAtMs) / 1000)
            : null;
        this.overlays.setReferendumCountdown(secondsRemaining);
      } else if (msg.kind === VOTE_KIND.TALLY) {
        const options = msg.options ?? [];
        const tally = msg.tally ?? {};
        const voterCount = msg.voterCount ?? 0;
        this.overlays.setReferendumTally({ options, tally, voterCount });
        // Countdown update: remaining time from now to deadline.
        const deadlineMs = msg.deadlineMs;
        const serverTimestamp = msg.serverTimestamp;
        const secondsRemaining =
          deadlineMs !== undefined && serverTimestamp !== undefined
            ? Math.max(0, (deadlineMs - serverTimestamp) / 1000)
            : null;
        this.overlays.setReferendumCountdown(secondsRemaining);
      } else if (msg.kind === VOTE_KIND.RESULT) {
        const winner = msg.winner ?? null;
        if (winner !== null) {
          this.overlays.showCrowdDecreed(winner);
        }
        // Clear the live ballot chrome (countdown + bars) — the decree splash owns the
        // moment; the cue-banner slot carries it via showCrowdDecreed.
        this.overlays.setReferendumCountdown(null);
        // The wide money-shot: cut to WIDE_ESTABLISH so the camera frames the full world
        // as the new law snaps in (spec §7.5 "big-screen money shot").
        this.requestShot({ kind: 'WIDE_ESTABLISH', sinceMs: 0 }, 8000);
      }
    }

    // C16 §7.6 Meteor Siege: the built-in auto-framed crystal camera + oversized HP
    // bar + narration callouts ride the SHOWPIECE family.
    //   START (kind=0): the siege armed → cut the CRYSTAL_CAM to the crystal + show
    //                   the HP bar banner (the crystal cam ships INSIDE this feature).
    //   STATE (kind=1): the live HP + at most one narration callout per 2 s (the
    //                   callout queue OWNS showpiece narration, §7.15).
    //   END   (kind=2): the end card — "CRYSTAL STANDS"/"CROWD WINS" + top-3.
    if (msg.t === 'showpiece') {
      if (msg.kind === SHOWPIECE_KIND.START) {
        if (typeof msg.crystalId === 'string') {
          this.requestShot({ kind: 'CRYSTAL_CAM', targetId: msg.crystalId, sinceMs: 0 }, SIEGE_CAM_HOLD_MS);
        }
        this.overlays.setCueBanner(hpBarText(msg.hp, msg.maxHp));
      } else if (msg.kind === SHOWPIECE_KIND.STATE) {
        // Re-frame the crystal cam and refresh the HP bar; a callout (if any) is the
        // narration line for the big screen.
        const callout = msg.callout ? `${calloutLine(msg.callout.kind)} ${msg.callout.callsign}` : '';
        this.overlays.setCueBanner(`${hpBarText(msg.hp, msg.maxHp)}${callout ? '  ·  ' + callout : ''}`);
      } else if (msg.kind === SHOWPIECE_KIND.END) {
        const outcome = msg.outcome === 'CROWD_WINS' ? 'CROWD WINS' : 'CRYSTAL STANDS';
        this.overlays.setCueBanner(outcome);
        this.requestShot({ kind: 'WIDE_ESTABLISH', sinceMs: 0 }, 6000);
      } else if (msg.kind === SHOWPIECE_KIND.WAVE) {
        // C27 §7.16 Siege Waves: the full-screen wave SPLASH ("WAVE 3 — BULLET
        // TIME"). The name resolves CLIENT-SIDE from the shared SIEGE_WAVES table by
        // the numeric waveIndex — no wave string ever rides the wire. Rides the
        // cue-banner treatment (never the callout queue). An older client that does
        // not know this kind simply ignores it (the §7.16 unknown-kind-ignore
        // degrade rung) and still shows the wave banner via ENV_STATE's mode.
        //
        // Post-arc coherence (§7.16): an index that does NOT resolve to a real wave
        // row — the −1 "no active wave" sentinel, or any out-of-range/future index —
        // renders NO splash (never a fabricated "WAVE N" from `idx + 1`). We fall
        // back to the plain siege, exactly as the unknown-kind-ignore contract does,
        // so a tail late-join / stale snapshot can never slam up a phantom "WAVE 4".
        const idx = typeof msg.waveIndex === 'number' ? msg.waveIndex : -1;
        const wave = idx >= 0 ? SIEGE_WAVES[idx] : undefined;
        if (wave) this.overlays.showSiegeWave(idx, wave.name);
      }
    }

    // C17 §7.7 Titan Protocol: a PLAYER_SCALE that GROWS a player (scale > 1) forces
    // the hardcoded low-angle worm's-eye shot + the "TITAN PROTOCOL" glitch banner —
    // the camera ships WITH the feature (spec §7.7: "the trigger cue also forces the
    // stage into a hardcoded low-angle worm's-eye shot"). A revert (scale → 1) does
    // NOT re-force it; the brain resumes with its invariants intact after the hold.
    if (msg.t === 'player-scale' && msg.scale > 1) {
      this.requestShot(
        { kind: 'WORM_EYE', targetId: msg.peerId, sinceMs: 0 },
        TITAN_WORM_EYE_HOLD_MS
      );
      this.overlays.setCueBanner('TITAN PROTOCOL');
    }

    // C32 §7.21 Powers Lab: the server → stage TK TETHER (the stage beat ships
    // INSIDE this feature). The server knows each live pull's hand ANCHOR + pulled
    // shape id (NO joint streaming). On the RISING edge (idle → a committed pull)
    // force the POWERS shot (medium on the player + the shape) + the mandated
    // "NO CONTROLLERS — CAMERA-TRACKED HANDS" lower-third; on the FALLING edge
    // (all pulls gone) clear the banner. The neon tether beam + the wearer's neon
    // skeleton hands are drawn by the render layer from THIS data (instanced,
    // zero-lights, §6.5 sub-budget — owner/hardware-verified). The pure Stage only
    // stores the tethers + drives the beat, so a Tier-6 cut is residue-free.
    if (msg.t === 'tk-tether') {
      const active = msg.pulls.length > 0;
      if (active && !this.tkPullActive) {
        this.requestShot(
          { kind: 'POWERS', targetId: msg.pulls[0].targetId, sinceMs: 0 },
          POWERS_SHOT_HOLD_MS
        );
        this.overlays.setCueBanner(POWERS_LOWER_THIRD);
      } else if (!active && this.tkPullActive) {
        this.overlays.setCueBanner('');
      }
      this.tkPullActive = active;
      this.tkTethers = msg.pulls;
      this.tkTetherSink?.({ peerId: msg.peerId, pulls: msg.pulls });
      return;
    }

    const ev = serverMsgToRoomEvent(msg);
    if (ev) this.brain.feed(ev);
  }

  /**
   * C32: register the render-layer TK tether/skeleton sink (the neon beam + the
   * wearer's instanced neon skeleton hands). Called by the renderer once three is
   * loaded so the pure Stage stays three-free; a cut removes the sink cleanly.
   */
  registerTkTetherSink(sink: (t: TkTetherState) => void): void {
    this.tkTetherSink = sink;
  }

  /** C32: the live TK tethers (anchor + target per hand) — for tests / the renderer. */
  get powersTethers(): ReadonlyArray<{ hand: number; anchor: Vec3; targetId: string }> {
    return this.tkTethers;
  }
  /** C32: true while a TK pull is live (a committed tether present). */
  get powersActive(): boolean {
    return this.tkPullActive;
  }

  /**
   * C12: register the LAZY 3D glyph field + an optional birth hook (toast/chord).
   * Called by the renderer once three is loaded so the pure Stage stays three-free.
   */
  registerGlyphSink(sink: GlyphSink, onGlyphBirth?: (glyph: StageGlyph) => void): void {
    this.glyphSink = sink;
    this.onGlyphBirthCb = onGlyphBirth ?? null;
  }

  /** Advance the brain by `dtMs` and return the shot to render this frame. */
  update(dtMs: number): Shot {
    // C12: expire the 3 s birth highlight (spec §7.13) — clear the spotlight +
    // the callsign lower-third when the window elapses.
    if (this.highlightRemainingMs > 0) {
      this.highlightRemainingMs -= dtMs;
      if (this.highlightRemainingMs <= 0) {
        this.highlightRemainingMs = 0;
        this.glyphSink?.highlight(null);
        this.overlays.setLowerThird(null);
        this.highlightId = null;
      }
    }
    // C21: advance the replay flow (0.25× playback, countdown chrome, auto-return
    // + cooldown). No-op while live; drives the "REPLAY // T-…s" chrome while airing.
    this.replay.update(dtMs);

    // C29: advance the x-ray auto-revert timer + the replay-airing state-exclusion
    // poll + flush the −300 ms ghost delay-FIFO shim. No-op while inactive. While
    // active, re-poll the roster (director/spectator-only, C3/C4) so the
    // "client-reported" RTT chips stay live.
    this.xray.update(dtMs);
    // C29 fix (post-review): release the WIDE_ESTABLISH pin the instant x-ray
    // reverts via the 60–90 s timer or the replay-airing auto-cancel (both
    // resolve inside `xray.update` above) — BEFORE the brain advances this
    // same frame, so control hands back with zero stuck-wide frames.
    this.syncXrayCameraPin();
    if (this.xray.active) {
      this.xrayRosterPollRemainingMs -= dtMs;
      if (this.xrayRosterPollRemainingMs <= 0) {
        this.xrayRosterPollRemainingMs = XRAY_ROSTER_POLL_MS;
        this.sendDirectorCmd('ROSTER');
      }
    } else {
      this.xrayRosterPollRemainingMs = 0; // poll immediately on the next activation
    }

    this.lastShot = this.brain.update(dtMs);
    return this.lastShot;
  }

  /**
   * C21 PRIMARY hotkey: "replay the last SCORED highlight" (min-activity gated —
   * staff can never air 6 s of idle bobbing). Returns whether a replay aired.
   */
  replayLastHighlight(): boolean {
    return this.replay.replayLastHighlight();
  }

  /**
   * The EXTERNAL cue→camera hook (spec §7.1). C12/C16/C17/C32 call this to force
   * a shot for `holdMs`; the brain is overridden for that window and resumes with
   * its invariants intact afterward. Returns the forced shot for the caller.
   */
  requestShot(shot: Shot, holdMs: number): void {
    this.brain.force(shot, holdMs);
  }

  /**
   * Handle a staff hotkey ('1'–'9' / '0'): force the bound shot, defaulting a
   * missing target to the current shot's target. No-op for an unbound key.
   *
   * C21: '5' is the PRIMARY Chrono Snap hotkey — "replay the last scored
   * highlight" (min-activity gated). It is a FLOW trigger, not a camera force, so
   * it is handled before the shot-force map.
   *
   * C29: 'x'/'X' is the PRIMARY X-Ray Broadcast trigger (spec §7.18) — the
   * stage-LOCAL hotkey (zero protocol, works when the tunnel is sad). Also a
   * FLOW trigger, handled before the shot-force map.
   *
   * C31: 'c'/'C' is the PRIMARY SAVE CLIP trigger (spec §7.20) — the stage-
   * LOCAL override that mints a fresh clipId any time, no rotation gate. Also a
   * FLOW trigger, handled before the shot-force map.
   */
  onHotkey(key: string): void {
    if (key === '5') {
      this.replayLastHighlight();
      return;
    }
    if (key === 'x' || key === 'X') {
      this.toggleXray();
      return;
    }
    if (key === 'c' || key === 'C') {
      this.triggerSaveClip();
      return;
    }
    const shot = hotkeyToShot(key, this.lastShot.targetId);
    if (shot) this.requestShot(shot, HOTKEY_HOLD_MS);
  }

  /**
   * C31 (F20 Neon Clip Machine, spec §7.20): SAVE CLIP — the stage-LOCAL hotkey
   * ('c'/'C', zero protocol) and the director-console relay (a `director-msg`
   * with `kind: 'SAVE_CLIP'`) both call THIS SAME entry point. Mints a fresh
   * clipId (always allowed — no rotation gate, unlike auto-first) and hands it
   * to whatever the render layer bound via {@link onSaveClip}.
   */
  private triggerSaveClip(): void {
    const clipId = this.clips.saveClip();
    this.onSaveClipCb?.(clipId, 'manual');
  }

  /**
   * Bind the render layer's real capture start (compositor canvas + MediaRecorder
   * + upload — real Web APIs, owner/manual-verified). Called with a fresh clipId
   * + which trigger fired it, for both the auto-first FINALE→STATS path and the
   * SAVE CLIP hotkey/console override.
   */
  onSaveClip(cb: (clipId: string, trigger: 'auto' | 'manual') => void): void {
    this.onSaveClipCb = cb;
  }

  // ---- C22 (F10 Ghost Arcade) — ATTRACT ghost playback --------------------

  /**
   * Bind the render layer's ghost-arcade playback. Called on every ATTRACT
   * `reel-data` reply with a {@link ReelSource} to replay (the SAME frozen
   * interpolator adapter live play uses) + its id, or `null` when the bank is
   * empty (the render layer then shows the scripted day-one shape-ballet). The
   * played ghosts are anonymized server-side — callsigns/GHOST_XX only (§6.1).
   */
  onAttractReel(cb: (source: ReelSource | null, reelId: string | null) => void): void {
    this.onAttractReelCb = cb;
  }

  /** True iff the stage is in ATTRACT (server phase) with a live ghost reel source. */
  get attractPlaying(): boolean {
    return this.lastPhase === 'ATTRACT' && this.attractReel !== null;
  }

  /** The current ATTRACT ghost reel source (null when none banked / not attract). */
  get attractReelSource(): ReelSource | null {
    return this.attractReel;
  }

  /** Request the day's most-recent banked reel to drive ATTRACT ghost playback. */
  private sendReelPlay(reelId?: string): void {
    if (this.ws?.readyState === 1) {
      const req: ClientMsg = reelId ? { t: 'reel-play', reelId } : { t: 'reel-play' };
      this.ws.send(encodeText(req));
    }
  }

  /**
   * Apply a `reel-data` reply: wrap the reel in the frozen {@link reelToStateSource}
   * adapter (or clear the source when the bank is empty) and notify the render
   * layer. The AttractMachine is nudged into ATTRACT so its play head advances.
   */
  private applyReelData(reel: Reel | null, reelId: string | null): void {
    this.attractReel = reel ? reelToStateSource(reel) : null;
    this.attractReelId = reel ? reelId : null;
    this.onAttractReelCb?.(this.attractReel, this.attractReelId);
  }

  /** Tear down the ghost reel source (leaving ATTRACT / dispose). */
  private clearAttractReel(): void {
    if (this.attractReel === null && this.attractReelId === null) return;
    this.attractReel = null;
    this.attractReelId = null;
    this.onAttractReelCb?.(null, null);
  }

  /**
   * C29 (F18 X-Ray Broadcast, spec §7.18): toggle x-ray. The stage-LOCAL hotkey
   * ('x'/'X', zero protocol) and the director-console relay (a `director-msg`
   * with `kind: 'STAGE_XRAY'`, C1 registry + connection.ts) both call THIS SAME
   * entry point — one guarded state machine, two independent triggers. On a
   * fresh activation, immediately (re)requests the staff roster so the RTT chips
   * aren't stale for a full poll interval.
   */
  private toggleXray(): void {
    const wasActive = this.xray.active;
    this.xray.toggle();
    if (this.xray.active && !wasActive) {
      this.xrayRosterPollRemainingMs = XRAY_ROSTER_POLL_MS;
      this.sendDirectorCmd('ROSTER');
    }
    this.syncXrayCameraPin();
  }

  /**
   * C29 fix (post-review): pin the brain to WIDE_ESTABLISH via `force()` for
   * the WHOLE x-ray window on activation — the split-truth comparison needs a
   * stable wide frame; without this the brain kept auto-cutting
   * (FOLLOW_THROW/GLYPH_BIRTH/JOIN_CRANE) under the diagnostic, swinging the
   * camera exactly when staff need it to hold still (brief: "brain pinned
   * WIDE_ESTABLISH via force()"). Released the instant x-ray reverts, via
   * WHICHEVER path fired (manual toggle, the 60–90 s timer, the phase guard,
   * the replay-airing auto-cancel) — `force(shot, 0)` is the only "unforce"
   * the frozen `force(shot, holdMs)` signature offers: holdMs=0 means
   * `forcedRemainingMs` is already 0 when the NEXT `brain.update()` runs, so
   * the override branch is skipped and the brain resumes deciding
   * immediately (spec: never leave the camera "stuck wide" after the window
   * ends). Edge-detected off `xray.active` — call after every site that can
   * change it (the hotkey/console toggle, the phase-guard auto-revert, and
   * the RAF-pumped `update()` timer/replay-auto-cancel paths).
   */
  private syncXrayCameraPin(): void {
    const active = this.xray.active;
    if (active && !this.xrayPinned) {
      this.xrayPinned = true;
      this.requestShot({ kind: 'WIDE_ESTABLISH', sinceMs: 0 }, XRAY_AUTO_REVERT_MS);
    } else if (!active && this.xrayPinned) {
      this.xrayPinned = false;
      this.requestShot({ kind: 'WIDE_ESTABLISH', sinceMs: 0 }, 0);
    }
  }

  /** Send a staff director-cmd verb (the stage carries the ownerToken — §5.4). */
  private sendDirectorCmd(cmd: string): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(encodeText({ t: 'director-cmd', cmd } as ClientMsg));
    }
  }

  // ---- Kiosk resilience ---------------------------------------------------

  /** Backoff-reconnect after a socket close (never gives up; caps the delay). */
  private scheduleReconnect(): void {
    if (this.disposed) return;
    const i = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[i];
    this.reconnectAttempt += 1;
    const timer = (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout;
    timer(() => this.connect(), delay);
  }

  /**
   * Health-check the public join URL; on failure swap the QR for an "ask staff"
   * card, on recovery restore it. Injectable `fetchImpl` for tests. Returns the
   * reachability boolean.
   */
  async checkJoinUrlHealth(
    joinUrl: string,
    fetchImpl?: (u: string) => Promise<{ ok: boolean }>
  ): Promise<boolean> {
    const f =
      fetchImpl ??
      ((u: string) =>
        (globalThis as unknown as { fetch: (u: string) => Promise<{ ok: boolean }> }).fetch(u));
    try {
      const res = await f(joinUrl);
      if (res.ok) {
        this.overlays.restoreQr(joinUrl);
        return true;
      }
      this.overlays.showAskStaffCard();
      return false;
    } catch {
      this.overlays.showAskStaffCard();
      return false;
    }
  }

  /** True iff the socket is currently open. */
  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  /** Tear down (kiosk reload / page unload). */
  dispose(): void {
    this.disposed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.clearAttractReel();
    this.overlays.dispose();
    this.xray.dispose();
  }

  /**
   * The join URL a phone would scan (public permalink). Same-origin `/r/:room`.
   */
  joinUrl(): string {
    const loc = (globalThis as unknown as { location?: { origin: string } }).location;
    const origin = loc?.origin ?? '';
    return `${origin}/r/${this.opts.room}`;
  }

  /** Resolve a CYBER_COLORS index → CSS hex for a lower-third swatch. */
  static colorHex(colorIndex: number): string {
    const c = CYBER_COLORS[colorIndex] ?? CYBER_COLORS[0];
    return `#${c.toString(16).padStart(6, '0')}`;
  }
}

// ===========================================================================
// C25 (F14 The Gallery) — the remote `?mode=watch` viewer.
//
// The desktop/phone render path MINUS input: a receive-only `audience` socket +
// a camera-mode switcher (free-orbit ⇄ follow-a-player) + the viewer counter +
// pause/rejoin. It reuses the pure Stage orchestration seams (overlays, the
// events adapter) WITHOUT the staff ownerToken / hotkeys / kiosk QR — a viewer
// can never drive the room. The heavy 3D render attaches lazily (three stays out
// of the entry graph); the class below is the three-free, unit-testable surface.
//
// Auto-director STRETCH (spec §7.14 / §14): running the local StageBrain here is
// an explicit stretch behind its event-adapter parity test. It is left SEAMED
// (feedEventsToBrain below is the documented hook) and OFF by default — the "the
// StageBrain runs anywhere" line stays forbidden until that parity test is green.
// ===========================================================================

/** The remote viewer's camera modes (spec §7.14 core: free-orbit + follow). */
export const WATCH_CAMERA_MODES = ['orbit', 'follow'] as const;
export type WatchCameraMode = (typeof WATCH_CAMERA_MODES)[number];

/** Cycle to the next viewer camera mode (pure — the switcher's state machine). */
export function nextWatchCameraMode(mode: WatchCameraMode): WatchCameraMode {
  const i = WATCH_CAMERA_MODES.indexOf(mode);
  return WATCH_CAMERA_MODES[(i + 1) % WATCH_CAMERA_MODES.length];
}

/** The viewer's lifecycle status (drives the DOM chrome). */
export type WatchStatus = 'connecting' | 'live' | 'attract' | 'paused' | 'at-capacity';

export interface WatchViewerOpts {
  room: string;
  wsUrl?: string;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  /** Injected setInterval/clearInterval (tests use fake timers). */
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (h: ReturnType<typeof setInterval>) => void;
  /** Heartbeat cadence (ms). Under the ~100 s Cloudflare idle-WS timeout. */
  heartbeatMs?: number;
  /** Notified on every status change (chrome renderer). */
  onStatus?: (status: WatchStatus) => void;
  /** Notified on every viewer-count update (the "N WATCHING" counter). */
  onViewerCount?: (n: number) => void;
  /** Notified on every camera-mode change. */
  onCameraMode?: (mode: WatchCameraMode, followTarget: string | null) => void;
}

/** Default heartbeat: 45 s — well under the ~100 s free-plan idle-WS timeout. */
export const WATCH_HEARTBEAT_MS = 45_000;

export class WatchViewer {
  private readonly opts: WatchViewerOpts;
  private readonly now: () => number;
  private ws: WebSocket | null = null;
  private disposed = false;
  private _status: WatchStatus = 'connecting';
  private _viewerCount = 0;
  private _camera: WatchCameraMode = 'orbit';
  private _followTarget: string | null = null;
  /** Known followable player/shape ids (from the coalesced buffer + keyframe). */
  private readonly _followables: string[] = [];
  private _heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;

  constructor(opts: WatchViewerOpts) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  get status(): WatchStatus {
    return this._status;
  }
  get viewerCount(): number {
    return this._viewerCount;
  }
  get cameraMode(): WatchCameraMode {
    return this._camera;
  }
  get followTarget(): string | null {
    return this._followTarget;
  }
  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  private setStatus(s: WatchStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.opts.onStatus?.(s);
  }

  private resolveWsUrl(): string {
    if (this.opts.wsUrl) return this.opts.wsUrl;
    const loc = (globalThis as unknown as { location?: { protocol: string; host: string } })
      .location ?? { protocol: 'https:', host: 'localhost' };
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc.host}/ws`;
  }

  /** Open the receive-only audience socket + start the handshake (idempotent). */
  connect(): void {
    if (this.disposed || this.ws) return;
    // A viewer that hit the room cap is a terminal state — never reconnect.
    if (this._status === 'at-capacity') return;
    this.setStatus('connecting');
    const WS =
      this.opts.WebSocketImpl ??
      (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    const ws = new WS(this.resolveWsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // Join as the `audience` tier — NO ownerToken, NO join secret (public
      // permalink; a viewer can never be granted resident/spectator/director).
      const join: ClientMsg = {
        t: 'join',
        room: this.opts.room,
        name: 'watch',
        color: 0,
        protocol: PROTOCOL_VERSION,
        tier: 'audience',
      };
      ws.send(encodeText(join));
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return; // audience never receives voice binary
      let msg: ServerMsg;
      try {
        msg = decodeText(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      // A cap rejection / explicit pause is terminal here — do not auto-reconnect.
      if (this.disposed || this._status === 'at-capacity' || this._status === 'paused') return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close handler drives the reconnect */
    };
  }

  private handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello':
        this.setStatus('live');
        break;
      case 'error':
        // Over-cap → the SOFT static "at capacity" card (spec §7.14). Terminal:
        // no socket, no reconnect — viewer #129 gets the card, never a third mode.
        if (msg.code === 'at-capacity') {
          this.setStatus('at-capacity');
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
          this.ws = null;
          this.stopHeartbeat();
        }
        break;
      case 'audience-state':
        this._viewerCount = msg.viewerCount;
        this.opts.onViewerCount?.(msg.viewerCount);
        break;
      case 'phase-state':
        // ATTRACT → reuse the C13 attract ghost playback (the after-hours permalink
        // shows ghosts, not an empty room). Live phases → the live render.
        if (this._status === 'live' || this._status === 'attract') {
          this.setStatus(msg.phase === 'ATTRACT' ? 'attract' : 'live');
        }
        break;
      case 'audience-keyframe':
        // The cached late-join snapshot: seed the followable set + the render.
        this.ingestFollowables(msg.shapes.map((s) => s.id));
        break;
      case 'wisp-coalesced':
        // Roll-forward: the 5 Hz coalesced world buffer (positions + head poses).
        this.ingestFollowables(msg.shapes.map((s) => s.id));
        break;
      default:
        break;
    }
  }

  private ingestFollowables(ids: string[]): void {
    for (const id of ids) if (!this._followables.includes(id)) this._followables.push(id);
    // Default the follow target to the first known entity if none is chosen yet.
    if (this._camera === 'follow' && this._followTarget === null && this._followables.length > 0) {
      this._followTarget = this._followables[0];
    }
  }

  /** Switch camera mode (free-orbit ⇄ follow-a-player). Returns the new mode. */
  cycleCamera(): WatchCameraMode {
    this._camera = nextWatchCameraMode(this._camera);
    if (this._camera === 'follow' && this._followTarget === null && this._followables.length > 0) {
      this._followTarget = this._followables[0];
    }
    if (this._camera === 'orbit') this._followTarget = null;
    this.opts.onCameraMode?.(this._camera, this._followTarget);
    return this._camera;
  }

  /** Follow the next known entity (only meaningful in follow mode). */
  followNext(): void {
    if (this._followables.length === 0) return;
    this._camera = 'follow';
    const i = this._followTarget ? this._followables.indexOf(this._followTarget) : -1;
    this._followTarget = this._followables[(i + 1) % this._followables.length];
    this.opts.onCameraMode?.(this._camera, this._followTarget);
  }

  // ---- Hidden-tab pause (spec §7.14) --------------------------------------

  /**
   * The `visibilitychange` handler: on HIDDEN, EXPLICITLY stop the heartbeat and
   * close the socket → the server drops the idle viewer (Chrome timer-clamping
   * would otherwise keep a hidden-tab heartbeat alive past the idle window and
   * pin a cap slot). The viewer shows "paused — click to rejoin"; a one-tap
   * {@link rejoin} reopens. On becoming visible again we do NOT auto-reconnect —
   * the tap is the explicit user gesture (spec §7.14 one-tap rejoin).
   */
  setHidden(hidden: boolean): void {
    if (this.disposed) return;
    if (hidden) {
      this.setStatus('paused');
      this.stopHeartbeat();
      try {
        this.ws?.close(1000, 'hidden-tab');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** The one-tap rejoin from the "paused — click to rejoin" card. */
  rejoin(): void {
    if (this.disposed || this.ws) return;
    if (this._status === 'at-capacity') return;
    this._status = 'connecting';
    this.connect();
  }

  // ---- Heartbeat (audience sends heartbeat + CLOCK_PING only) --------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const set = this.opts.setIntervalImpl ??
      ((cb: () => void, ms: number) =>
        (globalThis as unknown as { setInterval: typeof setInterval }).setInterval(cb, ms));
    const ms = this.opts.heartbeatMs ?? WATCH_HEARTBEAT_MS;
    this._heartbeat = set(() => {
      // The audience keep-alive: a plain `heartbeat` text frame (the ONE thing an
      // audience socket sends besides CLOCK_PING). It is not a typed ClientMsg
      // (it carries no fields), so it is sent as a raw string; the server treats
      // ANY inbound frame as activity + accepts `{t:'heartbeat'}` as a no-op.
      if (this.ws?.readyState === 1) this.ws.send('{"t":"heartbeat"}');
    }, ms);
  }

  private stopHeartbeat(): void {
    if (this._heartbeat === null) return;
    const clear = this.opts.clearIntervalImpl ??
      ((h: ReturnType<typeof setInterval>) =>
        (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval(h));
    clear(this._heartbeat);
    this._heartbeat = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const i = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[i];
    this.reconnectAttempt += 1;
    const timer = (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout;
    timer(() => this.connect(), delay);
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Boot (real page only). The 3D render governor attaches lazily AFTER connect so
// three is code-split out of the stage ENTRY chunk (join-first — spec §5.7/§6.5).
// Skipped under tests / SSR (no #stage-root or no document).
// ---------------------------------------------------------------------------

function parseStageParams(href: string): { room: string; ownerToken?: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // Room from /r/:id or ?room=
  const m = /\/r\/([^/?#]+)/.exec(url.pathname);
  const room = m ? decodeURIComponent(m[1]) : url.searchParams.get('room') ?? '';
  if (!room) return null;
  // The ownerToken may be provided via a same-origin config input; the URL query
  // is a dev convenience only (production rides a staff-entered field, never a
  // shared link — §5.4). We read it but never log it.
  const ownerToken = url.searchParams.get('ownerToken') ?? undefined;
  return { room, ownerToken };
}

const bootRoot =
  (globalThis as unknown as { document?: Document }).document?.getElementById?.('stage-root') ??
  null;

if (bootRoot) {
  const doc = (globalThis as unknown as { document: Document }).document;
  const href =
    (globalThis as unknown as { location?: { href: string } }).location?.href ?? '';
  const params = parseStageParams(href);
  if (params) {
    // §14: the "N PLAYERS — 1 WORLD — 1 SOCKET" counter is unlocked ONLY when the
    // C2 tier fan-out harness is green (verified in this build — see the C9
    // report). The stage entry passes it through; the overlay module fail-closes.
    const stage = new Stage(doc, {
      room: params.room,
      ownerToken: params.ownerToken,
      flexLineGranted: true,
    });
    bootRoot.appendChild(stage.overlays.root);
    // C29 (F18 X-Ray Broadcast, spec §7.18): the split-truth overlay root — its
    // own chrome region, hidden until triggered (never a shared-banner slot).
    bootRoot.appendChild(stage.xray.root);
    stage.overlays.setQr(stage.joinUrl());
    stage.connect();

    // Staff hotkeys 1–9/0 (spec §7.1): force shots/targets, overriding the brain
    // until the hold elapses. The big-screen laptop keyboard is the primary
    // surface; a bound key forces, an unbound key is a no-op. 'x'/'X' (spec
    // §7.18) is the PRIMARY X-Ray Broadcast trigger — zero protocol, works when
    // the tunnel is sad.
    doc.addEventListener('keydown', (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key) || e.key === 'x' || e.key === 'X' || e.key === 'c' || e.key === 'C') {
        stage.onHotkey(e.key);
      }
    });

    // Periodic public-join-URL health check → QR "ask staff" health-swap.
    const win = doc.defaultView ?? (globalThis as unknown as Window);
    win.setInterval(() => {
      void stage.checkJoinUrlHealth(stage.joinUrl());
    }, HEALTH_CHECK_INTERVAL_MS);

    win.addEventListener('beforeunload', () => stage.dispose());

    // Attach the heavy render governor lazily (three code-split like wisp). The
    // module drives update()/requestShot into the render loop; kept out of the
    // entry graph so `npm run size` never sees three in a static import.
    void import('./render.js')
      .then((m) => m.attachStageRenderer(stage, doc))
      .catch((e: unknown) => {
        console.warn('[stage] render governor failed to attach; overlays-only:', e);
      });
  }
}
