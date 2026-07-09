// ---------------------------------------------------------------------------
// Task C3 — Server CLOCK_PING → CLOCK_PONG handler + per-connection rttMs store.
//
// Spec §5.1 footnote: CLOCK_PING carries an additive `lastRttMs` field that
// the server stores per connection (quantized 5–10 ms) for the C4 roster
// (director + spectator tiers only, ≤1 Hz on material change).
//
// This module is PURE (no WS imports) so it is independently testable.
// Wiring into handleBinary in connection.ts follows in the same task.
// ---------------------------------------------------------------------------

import { encodeBinary, OPCODES, SINGLE_KIND } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// CLOCK_PING field shape (mirrors decodeBinary(CLOCK_PING).fields)
// ---------------------------------------------------------------------------

export interface ClockPingFields {
  clientSendMs: number;
  lastRttMs: number; // 0xFFFF = unknown (first ping has no prior RTT)
  reserved: number;
}

// ---------------------------------------------------------------------------
// handleClockPing — produce a CLOCK_PONG binary frame
// ---------------------------------------------------------------------------

/**
 * Produce the CLOCK_PONG binary frame for a given decoded CLOCK_PING.
 *
 * CLOCK_PONG (Appendix B, golden codec):
 *   [0x31][0x00][clientSendMs u32 LE][serverTimeMs u32 LE][reserved u8]
 *
 * The `serverTimeMs` is a roomEpoch-relative timestamp; callers must supply
 * the correct `serverNowMs = Date.now() − roomEpoch` (or the injected clock
 * equivalent). The golden codec in opcodes.ts is used for both directions.
 */
export function handleClockPing(fields: ClockPingFields, serverNowMs: number): ArrayBuffer {
  return encodeBinary(OPCODES.CLOCK_PONG, SINGLE_KIND.ONLY, {
    clientSendMs: fields.clientSendMs,
    serverTimeMs: serverNowMs,
    reserved: 0,
  });
}

// ---------------------------------------------------------------------------
// quantizeRtt — round lastRttMs to the nearest 5 ms bucket
// ---------------------------------------------------------------------------

/** The 0xFFFF wire sentinel meaning "no prior RTT measurement available". */
export const RTT_UNKNOWN_SENTINEL = 0xffff;

/** Quantization bucket size (ms) — spec §5.1 footnote: "quantized 5–10 ms". */
export const RTT_QUANTIZE_MS = 5;

/**
 * Quantize a raw `lastRttMs` wire value to the nearest 5 ms bucket.
 * Returns `null` for the 0xFFFF "unknown" sentinel (first ping has no prior RTT).
 */
export function quantizeRtt(lastRttMs: number): number | null {
  if (lastRttMs === RTT_UNKNOWN_SENTINEL) return null;
  return Math.round(lastRttMs / RTT_QUANTIZE_MS) * RTT_QUANTIZE_MS;
}

// ---------------------------------------------------------------------------
// createRttStore — per-connection rttMs store for the C4 roster
// ---------------------------------------------------------------------------

/**
 * A simple map-backed store for per-connection quantized RTT values.
 *
 * Values are stored as `number | null`:
 *   number — quantized RTT in ms (from `quantizeRtt`).
 *   null   — "unknown" (first ping, or 0xFFFF sentinel received).
 *
 * The `get` method returns `undefined` for connections that have never pinged —
 * distinct from `null` (pinged but RTT is unknown).
 *
 * C4 reads this store to populate the `rttMs?: number` roster field
 * (rebroadcast ≤1 Hz on material change to director + spectator only).
 */
export interface RttStore {
  /** Store (or update) the quantized rttMs for a connection. */
  set(connId: string, lastRttMs: number): void;
  /**
   * Get the stored quantized rttMs for a connection.
   * Returns `undefined` if the connection has never called `set`.
   * Returns `null` if the last received lastRttMs was the 0xFFFF sentinel.
   */
  get(connId: string): number | null | undefined;
  /** Remove a connection's RTT entry (on disconnect). */
  delete(connId: string): void;
  /** Return a read-only snapshot of all stored entries. */
  all(): ReadonlyMap<string, number | null>;
}

export function createRttStore(): RttStore {
  const _map = new Map<string, number | null>();

  return {
    set(connId: string, lastRttMs: number): void {
      _map.set(connId, quantizeRtt(lastRttMs));
    },
    get(connId: string): number | null | undefined {
      if (!_map.has(connId)) return undefined;
      return _map.get(connId) ?? null;
    },
    delete(connId: string): void {
      _map.delete(connId);
    },
    all(): ReadonlyMap<string, number | null> {
      return _map;
    },
  };
}
