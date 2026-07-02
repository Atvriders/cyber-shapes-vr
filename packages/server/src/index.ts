/**
 * index.ts — WebSocket server entry point (Task B3).
 *
 * startServer(port) creates an HTTP server with /healthz + a WebSocketServer
 * sharing the same port. Manages per-room sim loops.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { encodeText } from '@cyber-shapes/shared';
import { RoomManager } from './roomManager.js';
import { RoomPersistence } from './persistence.js';
import { handleConnection, makeConnectionHub, MAX_PAYLOAD_BYTES } from './connection.js';

export { ServerWorld } from './serverWorld.js';
export type { ServerWorldOpts } from './serverWorld.js';
export { Room } from './room.js';
export { RoomManager } from './roomManager.js';
export { RoomPersistence } from './persistence.js';

// ---------------------------------------------------------------------------
// Sim loop constants
// ---------------------------------------------------------------------------

/** Physics tick interval (ms). 30 Hz. */
const TICK_MS = 1000 / 30;

/** Broadcast every N ticks (~15 Hz). */
const BROADCAST_EVERY = 2;

/**
 * Hard cap on concurrent WebSocket connections per server (finding #6). Beyond
 * this, a new socket is rejected (error + close) before it can join a room.
 * MAX_ROOMS × MAX_PLAYERS is the theoretical live-player ceiling; this is a
 * looser socket-count backstop against a connection flood.
 */
const MAX_CONNECTIONS = 2000;

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export interface ServerHandle {
  /** Actual bound port (useful when started on port 0). */
  port: number;
  /** Graceful shutdown: close new connections, drain existing ones. */
  close(): Promise<void>;
}

/**
 * Finding #4: top-level backstop so a stray throw / rejected promise anywhere
 * in the process logs and is swallowed rather than killing Node (which would
 * take down EVERY room). Installed once, idempotently (multiple startServer()
 * calls in one process — e.g. tests — do not stack duplicate listeners).
 */
let _crashGuardsInstalled = false;
export function installProcessCrashGuards(): void {
  if (_crashGuardsInstalled) return;
  _crashGuardsInstalled = true;
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException (kept alive):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection (kept alive):', reason);
  });
}

export function startServer(port: number): ServerHandle {
  installProcessCrashGuards();
  // Only enable persistence when DATA_DIR is explicitly set (avoids shared ./data in tests)
  const dataDir = process.env['DATA_DIR'];
  const persistence = dataDir ? new RoomPersistence({ dir: dataDir }) : null;
  const manager = new RoomManager(persistence);

  // Per-server connection hub — isolated state; no module-level globals.
  const hub = makeConnectionHub();

  // Per-room sim intervals: roomId → interval handle.
  // tickCount is tracked via the closure variable inside startSimLoop; the
  // map value is only the interval so there is one source of truth.
  const simIntervals = new Map<string, ReturnType<typeof setInterval>>();

  function startSimLoop(roomId: string): void {
    if (simIntervals.has(roomId)) return; // already running
    let tickCount = 0;
    const interval = setInterval(() => {
      const room = manager.get(roomId);
      if (!room) {
        // Room dropped (shouldn't happen normally, but guard)
        stopSimLoop(roomId);
        return;
      }
      const events = room.tick(TICK_MS / 1000);
      tickCount++;
      // Discrete events (despawn, etc.) are always broadcast immediately —
      // never held back by the BROADCAST_EVERY throttle. Only `state` snapshots
      // are throttled (they carry interpolation data, not lifecycle changes).
      // This prevents out-of-bounds despawns from being silently dropped when
      // they land on an odd tick that would otherwise be skipped.
      for (const evt of events) {
        if (evt.t !== 'state') {
          hub.broadcastToRoom(roomId, evt);
        }
      }
      if (tickCount % BROADCAST_EVERY === 0) {
        for (const evt of events) {
          if (evt.t === 'state') {
            hub.broadcastToRoom(roomId, evt);
          }
        }
      }
    }, TICK_MS);
    simIntervals.set(roomId, interval);
  }

  function stopSimLoop(roomId: string): void {
    const interval = simIntervals.get(roomId);
    if (interval !== undefined) {
      clearInterval(interval);
      simIntervals.delete(roomId);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP server with /healthz
  // ---------------------------------------------------------------------------

  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  // ---------------------------------------------------------------------------
  // WebSocket server (shares the HTTP server)
  // ---------------------------------------------------------------------------

  // Finding #1: cap the max frame size so ws rejects (and closes) oversized
  // frames before they reach us — ws's default is 100 MiB, a DoS vector.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on('connection', (ws) => {
    // Finding #6: reject new sockets past the connection cap before any handling.
    // Use >= : the just-connected socket is ALREADY in wss.clients when this
    // fires, so `> MAX_CONNECTIONS` would admit MAX_CONNECTIONS+1 (off-by-one).
    if (wss.clients.size >= MAX_CONNECTIONS) {
      try {
        ws.send(encodeText({ t: 'error', code: 'server-full', message: 'too many connections' }));
      } catch {
        /* socket may already be gone */
      }
      ws.close(1013, 'server-full');
      return;
    }
    handleConnection(
      ws,
      manager,
      hub,
      (roomId) => startSimLoop(roomId),
      (roomId) => stopSimLoop(roomId)
    );
  });

  // ---------------------------------------------------------------------------
  // Bind
  // ---------------------------------------------------------------------------

  httpServer.listen(port);

  // Resolve the actual bound port synchronously via address()
  const getPort = (): number => {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') return addr.port;
    return port;
  };

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------

  const handle: ServerHandle = {
    get port() {
      return getPort();
    },

    async close(): Promise<void> {
      // Stop all sim loops
      for (const [roomId] of simIntervals) {
        stopSimLoop(roomId);
      }

      // Flush pending persistence writes before closing
      if (persistence) await persistence.flush();

      // Close all WS connections and servers
      await new Promise<void>((resolve, reject) => {
        // Close all WS connections
        for (const ws of wss.clients) {
          ws.terminate();
        }

        wss.close((wsErr) => {
          if (wsErr) return reject(wsErr);
          httpServer.close((httpErr) => {
            if (httpErr) return reject(httpErr);
            resolve();
          });
        });
      });
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Entrypoint guard
// ---------------------------------------------------------------------------

// `import.meta.url` main-module check (Node ESM)
const isMain = process.argv[1]
  ? new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname
  : false;

if (isMain) {
  // Default DATA_DIR for production; keep unset in tests so persistence is skipped.
  if (!process.env['DATA_DIR']) process.env['DATA_DIR'] = './data';
  const port = Number(process.env['PORT']) || 3030;
  const handle = startServer(port);
  // Bind is synchronous on port 0, but we wait one event-loop turn for determinism
  setImmediate(() => {
    console.log(`cyber-shapes-vr server listening on port ${handle.port}`);
  });
}
