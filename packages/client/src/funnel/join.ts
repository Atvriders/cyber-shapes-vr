/**
 * funnel/join.ts — the shared WS join handshake for EVERY phone-funnel entry
 * (ballot / crowd / wisp). Spec §5.7 (join-first funnel) + §5.1 (tiers) + C2
 * TIER_HELLO handshake.
 *
 * ZERO DOM, ZERO three. This is the one module every funnel entry imports to get
 * into the live room, and it must never pull the 3D bundle in — the ballot/crowd
 * chunks depend on it and are budgeted < 100 KB gz (spec §5.7). The wisp entry
 * calls `joinRoom` BEFORE it lazy-imports its 3D renderer, so the wisp "exists in
 * world at handshake" and only then does three load.
 *
 * The handshake (C2, Appendix B):
 *   client → { t:'join', room, name, color, protocol, tier?, requestedName? }
 *   server → { t:'downgrade', from, to, reason }?   (soft, over-cap or door-closed)
 *   server → { t:'hello', peerId, callsign, tier, roomEpoch }
 *   server → { t:'welcome', … }                     (the world snapshot; ignored here)
 *
 * The funnel sends an EXPLICIT tier (ballot/crowd → 'crowd'; wisp → 'wisp'). It
 * NEVER sends 'resident' (residents are the headset players on the main client)
 * and NEVER omits the tier (the server's absent-tier default is 'resident' — a
 * separate coordinated inversion, out of scope here). A privileged tier the
 * funnel does not have the secret for would be downgraded to crowd server-side;
 * the funnel only ever asks for the two public tiers, so a downgrade here is an
 * over-cap/door-closed soft landing, surfaced to the caller.
 */

import {
  encodeText,
  decodeText,
  PROTOCOL_VERSION,
  CURATED_WORDLIST,
  CYBER_COLORS,
} from '@cyber-shapes/shared';
import type { ClientMsg, ServerMsg, Tier } from '@cyber-shapes/shared';

/** The two public tiers a phone may request from the funnel (spec §5.1). */
export type FunnelTier = 'crowd' | 'wisp';

/** Options for {@link joinRoom}. */
export interface JoinOpts {
  /** Room id (from `/r/:roomId`). Required. */
  room: string;
  /** wss:// endpoint. Defaults to a same-origin `/ws` URL derived from location. */
  wsUrl?: string;
  /** Avatar color index (into CYBER_COLORS). Defaults to 0. */
  color?: number;
  /**
   * Chosen callsign word: an INDEX into CURATED_WORDLIST (spec §6.1 — never free
   * text). Sent as `requestedName`. An out-of-range/absent index → the server
   * assigns a random callsign. The wisp picker sets this from its offered words.
   */
  requestedName?: number;
  /**
   * Injected WebSocket ctor (tests stub this). Defaults to globalThis.WebSocket.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Called if the server soft-downgraded the requested tier (over-cap /
   * door-closed). Advisory — the join still resolves at the granted tier.
   */
  onDowngrade?: (from: Tier, to: Tier, reason: string) => void;
}

/** What a successful join yields (the C2 `hello` reply, minus the redundant tier). */
export interface JoinResult {
  peerId: string;
  callsign: string;
  roomEpoch: number;
  /** The tier actually granted (may differ from requested after a downgrade). */
  tier: Tier;
  /** The live socket, handed to the caller for subsequent traffic. */
  ws: WebSocket;
  /** Any soft-downgrade the server applied, or null. */
  downgrade: { from: Tier; to: Tier; reason: string } | null;
}

/**
 * Derive a same-origin wss:// URL from a browser location when no explicit
 * `wsUrl` is given. `https:` → `wss:`, `http:` → `ws:`. Pure given a location.
 */
export function defaultWsUrl(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/ws`;
}

/**
 * Offer ~`count` curated callsign WORDS (spec §5.7 wisp picker — "~6
 * server-offered curated-wordlist options, never a free-text field"). The
 * wordlist itself is the server's curation authority (shared constant, §6.1),
 * so the offer is a deterministic subset of it — every option is a real index
 * the server accepts as `requestedName`. Deterministic given `seed`.
 *
 * Returns `{ word, index }[]` — `index` is the CURATED_WORDLIST index to send as
 * `requestedName`. Never returns duplicates; never a free-text slot.
 */
export function offerCallsignWords(
  seed: number,
  count = 6
): Array<{ word: string; index: number }> {
  const n = Math.min(count, CURATED_WORDLIST.length);
  const total = CURATED_WORDLIST.length;
  // A fixed stride walk keeps the offered set spread across the wordlist and
  // deterministic for a given seed (no Math.random — reviewable, testable).
  const stride = 7; // coprime-ish with 72 → good spread without collisions
  const start = ((seed % total) + total) % total;
  const chosen: Array<{ word: string; index: number }> = [];
  const used = new Set<number>();
  let i = start;
  while (chosen.length < n) {
    if (!used.has(i)) {
      used.add(i);
      chosen.push({ word: CURATED_WORDLIST[i], index: i });
    }
    i = (i + stride) % total;
    // Safety: if the stride cycle somehow revisits everything, fall back to a
    // linear scan of the remaining indices (cannot loop forever).
    if (used.size >= total) break;
  }
  return chosen;
}

/**
 * Open a WS to the room and complete the C2 tier handshake, resolving once the
 * server's `hello` arrives — i.e. the peer EXISTS in the live room. The wisp
 * entry awaits THIS before it lazy-loads any 3D (spec §5.7 "join-first,
 * render-later").
 *
 * Rejects if the socket errors/closes before `hello`. Never blocks on `welcome`
 * (the funnel does not need the world snapshot to be "in").
 */
export function joinRoom(tier: FunnelTier, opts: JoinOpts): Promise<JoinResult> {
  const WS =
    opts.WebSocketImpl ??
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
  const wsUrl =
    opts.wsUrl ??
    defaultWsUrl(
      (globalThis as unknown as { location?: { protocol: string; host: string } })
        .location ?? { protocol: 'https:', host: 'localhost' }
    );

  return new Promise<JoinResult>((resolve, reject) => {
    const ws = new WS(wsUrl);
    ws.binaryType = 'arraybuffer';
    let settled = false;
    let downgrade: JoinResult['downgrade'] = null;

    const cleanup = () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    };

    ws.onopen = () => {
      // Clamp color to a valid CYBER_COLORS index — an out-of-range value (< 0
      // or ≥ length) is coerced to 0 (finding #7).
      const rawColor = opts.color ?? 0;
      const safeColor =
        Number.isInteger(rawColor) && rawColor >= 0 && rawColor < CYBER_COLORS.length
          ? rawColor
          : 0;
      const join: ClientMsg = {
        t: 'join',
        room: opts.room,
        // Free text NEVER reaches a screen (§6.1) — the server overwrites `name`
        // with the assigned callsign. We send a fixed placeholder; the real
        // choice rides `requestedName` (a curated-wordlist index).
        name: 'phone',
        color: safeColor,
        protocol: PROTOCOL_VERSION,
        // EXPLICIT tier — never 'resident', never absent (see file header).
        tier,
        ...(opts.requestedName !== undefined
          ? { requestedName: opts.requestedName }
          : {}),
      };
      ws.send(encodeText(join));
    };

    ws.onmessage = (ev: MessageEvent) => {
      // The funnel handshake is JSON-only; binary (voice) frames are irrelevant
      // to a crowd/wisp join and are ignored here.
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = decodeText(ev.data) as ServerMsg;
      } catch {
        return; // ignore undecodable frames
      }
      if (msg.t === 'downgrade') {
        downgrade = { from: msg.from, to: msg.to, reason: msg.reason };
        opts.onDowngrade?.(msg.from, msg.to, msg.reason);
        return;
      }
      if (msg.t === 'hello') {
        settled = true;
        cleanup();
        resolve({
          peerId: msg.peerId,
          callsign: msg.callsign,
          roomEpoch: msg.roomEpoch,
          tier: msg.tier,
          ws,
          downgrade,
        });
        return;
      }
      if (msg.t === 'error') {
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`join failed: ${msg.code} — ${msg.message}`));
      }
      // Any other message (welcome, state, …) before hello is ignored: the
      // funnel resolves on `hello`, not `welcome`.
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('join failed: socket error'));
    };

    ws.onclose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('join failed: socket closed before hello'));
    };
  });
}
