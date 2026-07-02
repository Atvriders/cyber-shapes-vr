/**
 * e2e.integration.test.ts — Real-client-stack end-to-end convergence (B7)
 *
 * Uses the REAL NetClient + ShapeStore against the REAL server (startServer).
 * This is the coverage gap the raw-protocol harness cannot close: it exercises
 * the client netcode itself — _applying guard, spawn reconciliation (rekey),
 * SnapshotBuffer keying, and the full welcome/spawn/recolor apply path.
 *
 * WebSocket polyfill: the `ws` library is injected into globalThis.WebSocket
 * so NetClient (which reads `globalThis.WebSocket`) works in Node without a
 * browser environment. THREE.Scene constructs fine headless.
 *
 * Properties verified:
 *  - After A spawns: storeA has EXACTLY ONE shape (local temp id rekeyed to
 *    canonical — no duplicate), with a server-namespaced canonical id.
 *  - storeB CONVERGES: exactly one shape with the SAME canonical id (remote
 *    spawn applied correctly).
 *  - A recolors the shape: storeB's shape colorIndex converges to the new value.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { ShapeStore } from '../src/world.js';
import { NetClient } from '../src/net/netClient.js';
import { startServer } from '@cyber-shapes/server';
import type { ServerHandle } from '@cyber-shapes/server';
import { MAX_SHAPES } from '@cyber-shapes/shared';

// ---------------------------------------------------------------------------
// WebSocket polyfill — inject ws into globalThis before NetClient uses it.
// ws exports { WebSocket } as a named export from wrapper.mjs (ESM).
// We set this up once for the entire file.
// ---------------------------------------------------------------------------

let _wsOriginal: unknown;
let _server: ServerHandle;
let _wsUrl: string;

beforeAll(async () => {
  // Polyfill globalThis.WebSocket with the `ws` library's WebSocket class.
  const wsModule = await import('ws');
  _wsOriginal = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = wsModule.WebSocket;

  // Start the real server on an ephemeral port.
  _server = startServer(0);
  _wsUrl = `ws://127.0.0.1:${_server.port}/ws`;
});

afterAll(async () => {
  await _server.close();
  (globalThis as Record<string, unknown>).WebSocket = _wsOriginal;
});

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

function waitUntil<T>(
  predicate: () => T | false | null | undefined,
  { timeoutMs = 4000, intervalMs = 30, label = 'condition' } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const val = predicate();
      if (val) {
        resolve(val);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`waitUntil: "${label}" not satisfied within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Real-client-stack e2e test
// ---------------------------------------------------------------------------

describe('real-client-stack e2e convergence', () => {
  it('(E2E) spawn from A rekeyed to canonical id; storeB converges; recolor converges', async () => {
    const room = 'e2e-room';

    // Build client A
    let localA = 0;
    const sceneA = new THREE.Scene();
    let netA!: NetClient;
    const storeA = new ShapeStore(sceneA, {
      maxShapes: MAX_SHAPES,
      idFactory: () => `__localA__:${localA++}`,
      onEvent: (e) => netA.onLocalStoreEvent(e),
    });
    netA = new NetClient(storeA, {});
    netA.connect(_wsUrl, room, 'Alice', 0);

    // Build client B
    let localB = 0;
    const sceneB = new THREE.Scene();
    let netB!: NetClient;
    const storeB = new ShapeStore(sceneB, {
      maxShapes: MAX_SHAPES,
      idFactory: () => `__localB__:${localB++}`,
      onEvent: (e) => netB.onLocalStoreEvent(e),
    });
    netB = new NetClient(storeB, {});
    netB.connect(_wsUrl, room, 'Bob', 1);

    try {
      // Wait for both clients to receive their welcome (playerId assigned)
      await waitUntil(() => netA.playerId !== null, { label: 'A welcome' });
      await waitUntil(() => netB.playerId !== null, { label: 'B welcome' });

      // A spawns a shape using the optimistic path through the real store.
      // The store calls idFactory → '__localA__:0', emits spawn event, which
      // onLocalStoreEvent picks up and sends {t:'spawn', tempId:'__localA__:0'} to the server.
      storeA.spawn({ type: 'cube', position: { x: 0, y: 2, z: 0 } } as Parameters<
        typeof storeA.spawn
      >[0]);

      // Immediately after spawn, storeA has the temp shape: ONE shape
      // (before server echo arrives, to prove no duplicate is created later).

      // Wait until the server confirms the spawn (rekeyed to canonical id).
      // The canonical id will be 'e2e-room:N' (server-namespaced).
      const canonicalId = await waitUntil(
        () => {
          const shapes = storeA.shapes;
          if (shapes.length !== 1) return undefined;
          const id = shapes[0].id;
          // After rekey, id switches from temp '__localA__:0' to 'e2e-room:N'
          if (id.startsWith('e2e-room:')) return id;
          return undefined;
        },
        { label: 'A spawn rekeyed to canonical id', timeoutMs: 4000 }
      );

      // Assert: storeA has EXACTLY ONE shape — no duplicate from temp + canonical
      expect(storeA.shapes.length, 'storeA has duplicate after rekey').toBe(1);
      expect(canonicalId, 'canonical id not server-namespaced').toMatch(/^e2e-room:\d+$/);
      expect(storeA.shapes[0].id, 'storeA shape id mismatch').toBe(canonicalId);

      // Assert: storeB converges — exactly ONE shape with the SAME canonical id
      await waitUntil(() => storeB.shapes.length === 1 && storeB.shapes[0].id === canonicalId, {
        label: 'B converges on canonical shape',
        timeoutMs: 4000,
      });
      expect(storeB.shapes.length, 'storeB should have exactly 1 shape').toBe(1);
      expect(storeB.shapes[0].id, 'storeB shape id mismatch').toBe(canonicalId);

      // A recolors the shape. This goes through the real NetClient → server → storeB.
      const newColor = 3;
      storeA.setColor(canonicalId, newColor);

      // storeA should reflect immediately (local mutation)
      expect(storeA.shapes[0].colorIndex, 'storeA colorIndex not updated').toBe(newColor);

      // storeB should converge to the new colorIndex via server broadcast
      await waitUntil(
        () => storeB.shapes.length === 1 && storeB.shapes[0].colorIndex === newColor,
        { label: 'B converges on recolor', timeoutMs: 4000 }
      );
      expect(storeB.shapes[0].colorIndex, 'storeB colorIndex did not converge').toBe(newColor);
    } finally {
      netA.disconnect();
      netB.disconnect();
    }
  });
});
