# Cyber Shapes VR

**Multiplayer cyberpunk WebXR shape playground for Meta Quest 2 and desktop.**

Grab, throw, spawn, and play with neon geometric shapes in shared private rooms. Up to 8 players join the same room by sharing a link. An authoritative Node server runs physics; clients interpolate. Spatial voice chat runs over the same WebSocket connection (Opus/WebCodecs — no WebRTC, no TURN, no extra ports). Works offline too: if the server is unreachable the app falls back to single-player mode.

## Features

- **10 shape types** — cube, sphere, icosahedron, torus, torus knot, octahedron, dodecahedron, cylinder, cone, tetrahedron
- **Grab / throw** — grip picks up the nearest shape; release flings it with physics
- **Spawn** — trigger creates a new random shape at your controller (or click empty space on desktop)
- **Resize** — thumbstick Y scales a held shape up/down
- **Recolor** — A/X cycles through 7 cyberpunk neon colors
- **Render mode** — B/Y toggles wireframe / solid / both
- **Multiplayer rooms** — share a `/r/<id>` link; everyone on that link is in the same private room (≤ 8 players)
- **Avatars** — head + two hands with nameplates and a speaking-ring indicator
- **Spatial voice** — push-to-talk via thumbstick-click; Opus encoded over WebSocket; HRTF spatialization per peer
- **Room persistence** — server saves room state to disk (`DATA_DIR`); shapes survive a server restart
- **Offline fallback** — single-player mode when the WebSocket server is unreachable
- **Cyberpunk environment** — infinite neon grid floor, starfield, floating dust, purple fog, holographic HUD
- **Bloom glow** — emissive materials glow (desktop mode; direct render in VR for performance)
- **Procedural audio** — synth sounds for spawn, grab, release, impact

## Monorepo Layout

```
packages/
  shared/   — protocol types, pure physics core, constants (shared by client + server)
  client/   — Three.js 0.185 WebXR app, Vite 8, TypeScript
  server/   — Node.js authoritative game server (ws, file persistence, /healthz)
```

## Quick Start (dev)

```bash
git clone https://github.com/Atvriders/cyber-shapes-vr.git
cd cyber-shapes-vr
npm install
```

Start the game server (default port 3030):

```bash
node packages/server/src/index.ts
# or after building: node packages/server/dist/index.js
```

> The server package has no `dev` script. Build it first (`npm run -w packages/server build`), then run `node packages/server/dist/index.js`. For quick iteration you can run the TypeScript source directly via `tsx` or `ts-node` if installed.

Start the client dev server (https://localhost:3020):

```bash
npm run -w packages/client dev
```

Open **https://localhost:3020** in a WebXR-capable browser (Quest 2 browser, or desktop Chrome/Edge). Accept the self-signed certificate from Vite's `@vitejs/plugin-basic-ssl`. WebXR requires HTTPS — the dev plugin provides it automatically.

To join a multiplayer room, open a URL with a `/r/<id>` path (e.g. `https://localhost:3020/r/mygame`), or use the in-app **Share** button to copy the current room link.

## Controls

### VR (Quest 2)

| Input            | Action                             |
| ---------------- | ---------------------------------- |
| Grip             | Grab nearest shape / release+throw |
| Trigger          | Spawn new random shape             |
| Thumbstick Y     | Resize held shape (up = bigger)    |
| A / X button     | Cycle color of held shape          |
| B / Y button     | Toggle wireframe / solid / both    |
| Thumbstick click | Push-to-talk (voice)               |

### Desktop

| Input             | Action                                   |
| ----------------- | ---------------------------------------- |
| Click shape       | Grab (drag to move, release to throw)    |
| Click empty space | Spawn shape                              |
| `C` key           | Cycle color of last-touched shape        |
| `V` key           | Toggle render mode of last-touched shape |
| Orbit drag        | Rotate camera                            |

## Multiplayer and Voice

Sharing any `/r/<id>` URL puts everyone on that URL into the same private room. The server is the authority: it runs physics at 30 Hz and broadcasts state snapshots at ~15 Hz. Clients interpolate between snapshots.

**Voice:** push-to-talk is thumbstick-click (right hand). Audio is captured, Opus-encoded via WebCodecs, sent over the WebSocket, decoded, and spatialized per-peer with Web Audio HRTF. Voice requires a modern Chromium-based browser or Quest browser with WebCodecs support. If the feature is unavailable the voice system disables itself gracefully — the game still works fully.

Rooms hold up to 8 players. Each player's avatar (head + two hands, nameplate, speaking ring) is updated from the server-side player state.

## Build and Deploy

### Build

```bash
npm run build --workspaces
```

Builds all three packages. Client output goes to `packages/client/dist/`; server output to `packages/server/dist/`.

### Docker Compose (recommended for production)

```bash
docker compose up --build
```

Two services:

- **server** — Node WS + HTTP server, internal only (port 3030), health-checked at `/healthz`
- **web** — nginx serves the static client on host port **3020**; proxies `/ws` to the server

Set `DATA_DIR` (defaults to `./data` inside the container) to a named volume path for room persistence:

```yaml
# in docker-compose.yml — already wired to the `cyber-shapes-data` named volume
environment:
  DATA_DIR: /data
volumes:
  - cyber-shapes-data:/data
```

### GHCR Images

CI builds two multi-arch images (amd64, arm64, arm/v7) on every push to `master`:

| Image          | Registry                                          |
| -------------- | ------------------------------------------------- |
| Client (nginx) | `ghcr.io/atvriders/cyber-shapes-vr:latest`        |
| Server (Node)  | `ghcr.io/atvriders/cyber-shapes-vr-server:latest` |

To use prebuilt images, replace the `build:` stanzas in `docker-compose.yml` with `image:` lines pointing to the GHCR tags.

### TLS / WSS (Cloudflare Tunnel)

The containers serve plain HTTP. TLS is terminated externally by a Cloudflare Tunnel, which provides `https://` and `wss://` to browsers. nginx forwards the WebSocket `Upgrade` header to the server. No TLS certificates are needed inside the containers.

## Testing

```bash
npm test          # Vitest — 351 tests across 23 files (unit + integration + e2e)
npm run typecheck # tsc -b (full project references build check)
npm run lint      # ESLint
npm run format    # Prettier (write mode)
```

The test suite includes:

- Protocol / physics / math unit tests (`packages/shared`)
- Controller, interpolation, jitter-buffer, room-link, avatar, voice unit tests (`packages/client`)
- Server world, room, persistence, and WebSocket integration tests (`packages/server`)
- Headless multi-client integration harness (`multiclient.integration.test.ts`, `e2e.integration.test.ts`)

## Tech Stack

- **Three.js 0.185** — WebGL + WebXR rendering
- **Vite 8** — client dev server and production build
- **TypeScript** — end-to-end (client, server, shared)
- **Node.js + ws** — authoritative WebSocket game server
- **WebCodecs (Opus)** — in-browser voice encoding/decoding; no WebRTC
- **Vitest** — test runner (unit + headless integration)

## Owner-Verified Items (not verified in the build environment)

The following were not tested during development (no headset or Docker available in the build environment) and require the deploy owner to confirm:

- **Quest 2 in-VR comfort** — frame budget, controller latency, mic capture in immersive mode, HRTF head-turn feel
- **Live TLS domain + Cloudflare Tunnel** — wss:// upgrade through the tunnel, certificate, latency
- **`docker compose up`** — full container startup, named volume persistence, nginx → server proxy

---

_Built with [Claude Code](https://claude.ai/claude-code)_
