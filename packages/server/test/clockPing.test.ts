/**
 * Task C3 — Server CLOCK_PING → CLOCK_PONG handler tests.
 *
 * Verifies:
 * 1. A binary CLOCK_PING frame (golden codec) produces a correct CLOCK_PONG.
 * 2. The server stores the quantized lastRttMs per connection for C4 roster.
 * 3. lastRttMs=0xFFFF ("unknown") is stored as null.
 * 4. Round-trip: encode ping → handleClockPing → decode pong → verify fields.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeBinary,
  decodeBinary,
  OPCODES,
  SINGLE_KIND,
} from '@cyber-shapes/shared';
import { handleClockPing, quantizeRtt, createRttStore } from '../src/clockSync.js';

// ---------------------------------------------------------------------------
// Golden codec round-trip
// ---------------------------------------------------------------------------

describe('CLOCK_PING → CLOCK_PONG via golden codec', () => {
  it('round-trips CLOCK_PING encode→decode correctly (golden vector)', () => {
    const fields = { clientSendMs: 0x11223344, lastRttMs: 200, reserved: 0 };
    const buf = encodeBinary(OPCODES.CLOCK_PING, SINGLE_KIND.ONLY, fields);
    const decoded = decodeBinary(buf);
    expect(decoded.opcode).toBe(OPCODES.CLOCK_PING);
    expect(decoded.kind).toBe(SINGLE_KIND.ONLY);
    expect(decoded.fields.clientSendMs).toBe(fields.clientSendMs);
    expect(decoded.fields.lastRttMs).toBe(fields.lastRttMs);
    expect(decoded.fields.reserved).toBe(0);
  });

  it('round-trips CLOCK_PONG encode→decode correctly (golden vector)', () => {
    const fields = { clientSendMs: 0x11223344, serverTimeMs: 0x0A0B0C0D, reserved: 0 };
    const buf = encodeBinary(OPCODES.CLOCK_PONG, SINGLE_KIND.ONLY, fields);
    const decoded = decodeBinary(buf);
    expect(decoded.opcode).toBe(OPCODES.CLOCK_PONG);
    expect(decoded.kind).toBe(SINGLE_KIND.ONLY);
    expect(decoded.fields.clientSendMs).toBe(fields.clientSendMs);
    expect(decoded.fields.serverTimeMs).toBe(fields.serverTimeMs);
  });
});

// ---------------------------------------------------------------------------
// handleClockPing — correct CLOCK_PONG
// ---------------------------------------------------------------------------

describe('handleClockPing — produces correct CLOCK_PONG', () => {
  it('echoes clientSendMs and fills serverTimeMs from serverNowMs', () => {
    const serverNowMs = 50_000;
    const clientSendMs = 0x11223344;

    const pongBuf = handleClockPing(
      { clientSendMs, lastRttMs: 100, reserved: 0 },
      serverNowMs
    );

    const decoded = decodeBinary(pongBuf);
    expect(decoded.opcode).toBe(OPCODES.CLOCK_PONG);
    expect(decoded.kind).toBe(SINGLE_KIND.ONLY);
    expect(decoded.fields.clientSendMs).toBe(clientSendMs);
    expect(decoded.fields.serverTimeMs).toBe(serverNowMs);
    expect(decoded.fields.reserved).toBe(0);
  });

  it('uses the EXACT golden hex for CLOCK_PING lastRttMs=200', () => {
    // Golden vector from protocol.golden.ts: clientSendMs=0x11223344, lastRttMs=200
    const goldenHex = '300044332211c80000';
    const bytes = Buffer.from(goldenHex, 'hex');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const decoded = decodeBinary(buf);
    expect(decoded.fields.clientSendMs).toBe(0x11223344);
    expect(decoded.fields.lastRttMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// quantizeRtt — 5 ms bucket quantization
// ---------------------------------------------------------------------------

describe('quantizeRtt', () => {
  it('returns null for the 0xFFFF "unknown" sentinel', () => {
    expect(quantizeRtt(0xffff)).toBeNull();
  });

  it('rounds to the nearest multiple of 5 ms', () => {
    expect(quantizeRtt(0)).toBe(0);
    expect(quantizeRtt(3)).toBe(5);
    expect(quantizeRtt(5)).toBe(5);
    expect(quantizeRtt(7)).toBe(5);
    expect(quantizeRtt(8)).toBe(10);
    expect(quantizeRtt(10)).toBe(10);
    expect(quantizeRtt(23)).toBe(25);
    expect(quantizeRtt(200)).toBe(200);
  });

  it('clamps zero to 0', () => {
    expect(quantizeRtt(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createRttStore — per-connection rttMs store
// ---------------------------------------------------------------------------

describe('createRttStore — per-connection rttMs store', () => {
  it('stores quantized rttMs per connection ID', () => {
    const store = createRttStore();

    store.set('conn1', 23); // 23 → rounds to 25
    store.set('conn2', 0xffff); // unknown → null

    expect(store.get('conn1')).toBe(25);
    expect(store.get('conn2')).toBeNull();
    expect(store.get('conn3')).toBeUndefined(); // never set
  });

  it('updates when called again with a new value', () => {
    const store = createRttStore();

    store.set('conn1', 20);
    expect(store.get('conn1')).toBe(20);

    store.set('conn1', 50);
    expect(store.get('conn1')).toBe(50);
  });

  it('delete removes the entry', () => {
    const store = createRttStore();

    store.set('conn1', 30);
    store.delete('conn1');
    expect(store.get('conn1')).toBeUndefined();
  });

  it('all() returns all stored entries', () => {
    const store = createRttStore();
    store.set('a', 10);
    store.set('b', 20);
    store.set('c', 0xffff); // null

    const all = store.all();
    expect(all.get('a')).toBe(10);
    expect(all.get('b')).toBe(20);
    expect(all.get('c')).toBeNull();
  });
});
