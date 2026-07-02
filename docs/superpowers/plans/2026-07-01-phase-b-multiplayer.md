# Phase B — Multiplayer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authoritative-server multiplayer so up to 8 people who open the same link share one live world — synced shapes, avatars (head + 2 hands), spatial voice, and persistence — while single-player still works when disconnected.

**Architecture:** A Node WebSocket server (`packages/server`) holds the canonical per-room world as plain `NetShape[]` and runs `physicsCore.stepBody` at a fixed timestep. Clients send **intents** + **poses** and receive authoritative **state snapshots** + **events**, applying them to the existing client `ShapeStore` and interpolating remote transforms. Voice is Opus (WebCodecs) relayed as binary frames over the SAME socket. Protocol lives in `packages/shared` so client and server share one contract.

**Tech Stack:** TypeScript, `ws` (Node WebSocket), the existing `packages/shared` (`physicsCore`, `shapeMath`, constants), Three.js client, WebCodecs/AudioWorklet voice, Vitest (+ in-process multi-client integration harness), Docker/nginx/GHCR.

## Global Constraints

- **NO incremental commits toward the deliverable.** Transient per-task commits on branch `feature/upgrade-multiplayer`; squashed to ONE commit at the very end after full verification. (Owner rule.)
- **TypeScript everywhere.** Protocol/world/message contracts strongly typed in `packages/shared`.
- **All repos/packages/images public.**
- **Single-player must still work when disconnected** — the Phase A local-physics path is the offline fallback; connecting to a room switches the client to server-driven mode.
- **Room cap = 8** (`MAX_PLAYERS`). Rooms are per-link (`/r/<roomId>`).
- **Server trusts its own ids**, never client-supplied player/shape ids. Grab = first-claim-wins.
- **Voice: no WebRTC/STUN/TURN, no extra ports.** Opus binary frames over the same `wss`. Degrade-not-break fallback (WebCodecs → MediaRecorder → µ-law → disable).
- **Keep all 90 Phase A tests green** at every task.
- **Cosmetic stays local**: stars/dust/HUD/bloom/particles are never synced; only trigger events cross the wire.
- **Protocol v1 uses JSON** for control/state/pose messages and **binary only for voice frames**. (Binary transform packing is an explicit later optimization — fine at ≤8 players; do NOT build it now: YAGNI.)

## Shared contract (locked — all tasks build on this)

```ts
// packages/shared/src/net/types.ts
export const MAX_PLAYERS = 8;
export const PROTOCOL_VERSION = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

// Full serializable shape state (superset of Phase A Shape: adds position+rotation as plain data)
export interface NetShape {
  id: string;
  type: ShapeType;
  colorIndex: number;
  renderMode: RenderMode;
  scale: number;
  grabbedBy: string | null;
  grounded: boolean;
  bobPhase: number;
  rotSpeed: Vec3;
  position: Vec3;
  rotation: Vec3;
  velocity: Vec3;
}
export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
}
export interface Pose {
  head: { p: Vec3; q: Quat };
  hands: Array<{ p: Vec3; q: Quat } | null>;
}

// Client -> Server
export type ClientMsg =
  | { t: 'join'; room: string; name: string; color: number; protocol: number }
  | {
      t: 'spawn';
      shape: {
        type: ShapeType;
        position: Vec3;
        colorIndex?: number;
        renderMode?: RenderMode;
        scale?: number;
      };
    }
  | { t: 'grab'; id: string }
  | { t: 'release'; id: string; velocity: Vec3; position: Vec3; rotation: Vec3 }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  | { t: 'held'; id: string; position: Vec3; rotation: Vec3 } // streamed while holding (throttled)
  | { t: 'pose'; pose: Pose } // throttled
  | { t: 'voice-join' }
  | { t: 'voice-leave' }
  | { t: 'voice-state'; speaking: boolean; muted: boolean }
  | { t: 'voice-config'; config: string };

// Server -> Client
export type ServerMsg =
  | { t: 'welcome'; playerId: string; room: string; shapes: NetShape[]; players: PlayerInfo[] }
  | { t: 'player-join'; player: PlayerInfo }
  | { t: 'player-leave'; id: string }
  | { t: 'spawn'; shape: NetShape }
  | { t: 'despawn'; id: string }
  | { t: 'recolor'; id: string; colorIndex: number }
  | { t: 'rendermode'; id: string; mode: RenderMode }
  | { t: 'scale'; id: string; scale: number }
  | { t: 'grab'; id: string; peerId: string | null } // peerId null = released
  | { t: 'state'; seq: number; shapes: Array<{ id: string; p: Vec3; r: Vec3; v: Vec3 }> } // ~15-20Hz, moving shapes only
  | { t: 'pose'; id: string; pose: Pose } // relayed peer pose
  | { t: 'voice-roster'; players: Array<{ id: string; voice: boolean }> }
  | { t: 'voice-state'; id: string; speaking: boolean; muted: boolean }
  | { t: 'error'; code: string; message: string };

// Binary voice frame (the ONLY binary message): [opcode u8][senderId u8][timestampMs u32 LE][flags u8][opus bytes]
// opcodes: 0x10 VOICE_OPUS, 0x11 VOICE_WEBM, 0x12 VOICE_PCM. Server stamps senderId, fans out to room (excl sender).
```

## File Structure (target after Phase B)

```
packages/shared/src/net/
  types.ts        # the contract above
  protocol.ts     # encode/decode: JSON.stringify/parse for text msgs; voice frame pack/unpack; validators
packages/server/src/
  index.ts        # entrypoint: create WS server, wire RoomManager, HTTP health
  room.ts         # class Room: NetShape[] world, players, fixed-timestep sim, intents, snapshots, grab arbitration
  roomManager.ts  # rooms by id, join/leave, capacity, id assignment
  connection.ts   # per-socket: parse msg, route to room, voice fan-out, backpressure drop-oldest
  persistence.ts  # save/load room world (file-based, debounced)
  serverWorld.ts  # pure world ops over NetShape[] using physicsCore (no THREE) — unit-tested
packages/client/src/net/
  netClient.ts    # WS connection, send intents/poses, receive+apply to ShapeStore, interpolation buffer
  interpolation.ts# per-shape snapshot buffer + interpolate at (now - delay)
  avatars.ts      # remote player head+2hands render objects, nameplates, speaking ring
  roomLink.ts     # parse /r/<id> from URL, generate a room id, "share link" UI
packages/client/src/voice/
  capture.ts capture-worklet.ts encoder.ts decoder.ts jitterBuffer.ts spatializer.ts voice.ts featureDetect.ts
packages/client/src/main.ts   # add net mode: connected -> server-driven; disconnected -> local physics (Phase A)
Dockerfile.server nginx.conf docker-compose.yml .github/workflows/*  # infra
test/  (integration multi-client harness)
```

---

### Task B0: Protocol module in shared (TDD)

**Files:** Create `packages/shared/src/net/types.ts`, `packages/shared/src/net/protocol.ts`; export from `index.ts`. Test `packages/shared/test/protocol.test.ts`.

**Interfaces:**

- Produces the `types.ts` contract above. `protocol.ts`: `encodeText(msg: ClientMsg|ServerMsg): string` (JSON), `decodeText(s: string): ClientMsg|ServerMsg` (parse + shape-validate, throws on bad), `packVoice(opcode, senderId, tsMs, flags, opus: Uint8Array): ArrayBuffer`, `unpackVoice(buf: ArrayBuffer): {opcode,senderId,tsMs,flags,opus:Uint8Array}`, `isVoiceFrame(data): boolean`.

- [ ] **Step 1:** Write failing tests: text round-trip for a representative message of each `t` (encode→decode deep-equals); `decodeText` throws on malformed JSON and on a missing `t`; voice pack→unpack round-trips opcode/senderId/tsMs/flags/opus bytes exactly (including a 0-length and a 200-byte payload); `isVoiceFrame` true for ArrayBuffer, false for string.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Voice frame uses a `DataView` (little-endian) with header `[u8 opcode][u8 senderId][u32 tsMs][u8 flags]` then opus bytes.
- [ ] **Step 4:** Run → PASS; typecheck/lint clean.
- [ ] **Step 5: Stage.**

---

### Task B1: Pure server world over NetShape[] (TDD)

**Files:** Create `packages/server/src/serverWorld.ts`; extend server `package.json`/`tsconfig` to import `@cyber-shapes/shared`. Test `packages/server/test/serverWorld.test.ts`.

**Interfaces:** `class ServerWorld` (no THREE):

- `constructor(opts:{maxShapes:number; idFactory:()=>string})`
- `spawn(init:{type;position;colorIndex?;renderMode?;scale?; bobPhase?; rotSpeed?}): NetShape` — assign id, seed bobPhase/rotSpeed, enforce maxShapes (evict oldest), return NetShape.
- `remove(id)`, `get(id)`, `get shapes(): NetShape[]`
- `setColor/setRenderMode/setScale(id,...)`, `grab(id, peerId): boolean` (first-claim-wins: returns false + no-op if already grabbed by another; sets grabbedBy + grounded=false), `release(id, peerId, velocity, position, rotation)` (only if owner), `setHeld(id, peerId, position, rotation)` (owner only, updates transform)
- `step(dt): { impacts: Array<{id,speed}>; removed: string[] }` — for each shape run `physicsCore.stepBody` (build PhysicsBody from NetShape, write back position/velocity/grounded), collect impacts + removed ids, remove the removed.

- [ ] **Step 1:** Write failing tests: spawn assigns id + caps at maxShapes; `grab` first-claim-wins (second grabber gets false); `release` by non-owner is rejected; `step` integrates gravity and reports `removed` for out-of-bounds; a grabbed shape isn't integrated by `step`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement using `stepBody` + `restYFor` from shared. NetShape.rotation is advanced here too (rotSpeed*dt) so server holds full transform.
- [ ] **Step 4:** Run → PASS; typecheck/lint clean.
- [ ] **Step 5: Stage.**

---

### Task B2: Room + RoomManager (TDD)

**Files:** Create `packages/server/src/room.ts`, `packages/server/src/roomManager.ts`. Test `packages/server/test/room.test.ts`.

**Interfaces:**

- `class Room` wraps a `ServerWorld`, a `Map<playerId, PlayerInfo>`, a monotonic snapshot `seq`. Methods: `addPlayer(info): boolean` (false if full, `MAX_PLAYERS`), `removePlayer(id)` (also releases any shapes that player grabbed → emit grab-null), `applyIntent(playerId, msg: ClientMsg): ServerMsg[]` (validates ownership/capacity, mutates world, returns the authoritative events to broadcast), `tick(dt): {broadcasts: ServerMsg[]}` (runs `world.step`, builds a `state` snapshot of moving shapes + despawn events + impact events), `snapshotFor(playerId): ServerMsg` (the `welcome` payload).
- `class RoomManager`: `getOrCreate(roomId): Room`, `join(roomId, socketId, name, color): {room, playerId} | {error}`, `leave(roomId, playerId)`, server-assigned player ids (`p0,p1,...` per room) and shape ids (`<roomId>:<n>` — globally unique).

- [ ] **Step 1:** Write failing tests: room rejects the 9th player; `applyIntent` grab is arbitrated; removing a player releases their grabbed shapes; shape ids are unique across two rooms; `tick` emits a `state` for a moving shape and a `despawn` for an out-of-bounds one.
- [ ] **Step 2-4:** RED → implement → GREEN; typecheck/lint clean.
- [ ] **Step 5: Stage.**

---

### Task B3: WebSocket server wiring + voice fan-out

**Files:** Create `packages/server/src/connection.ts`, rewrite `packages/server/src/index.ts`. Add `ws` dep. Test `packages/server/test/wsServer.test.ts` (in-process ws clients).

**Interfaces:** `startServer(port): { close() }` — creates `ws` server (+ a tiny HTTP health endpoint on the same server for `/healthz`), one `Room` per link via `RoomManager`. Per connection: parse text→`decodeText`→`room.applyIntent`→broadcast returned events to the room; binary→`isVoiceFrame`→stamp senderId, fan out to other voice-enabled room members, **drop-oldest when `socket.bufferedAmount` exceeds a cap**. A server sim interval per active room (fixed dt, e.g. 1/30) calls `room.tick` and broadcasts snapshots at ~15-20Hz (send every Nth tick). On disconnect: `room.removePlayer` + broadcast player-leave + release events.

- [ ] **Step 1:** Write failing integration test: start server on an ephemeral port; connect 2 in-process `ws` clients to the same room; client A `spawn` → both A and B receive a `spawn` with a server id; A `grab` then B `grab` same id → B gets no grab (arbitration); a binary voice frame from A is received by B (server-stamped sender) and NOT echoed to A; a 9th joiner is rejected.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Guard the sim interval so empty rooms stop ticking. No voice persistence.
- [ ] **Step 4:** Run → PASS; typecheck/lint clean; `npm run -w packages/server build` (add a build/start script).
- [ ] **Step 5: Stage.**

---

### Task B4: Persistence (TDD)

**Files:** Create `packages/server/src/persistence.ts`; wire into `Room`/`RoomManager`. Test `packages/server/test/persistence.test.ts` (temp dir).

**Interfaces:** `savePeriodic(room)` (debounced write of `{shapes: NetShape[]}` to `data/rooms/<roomId>.json`), `load(roomId): NetShape[] | null` (restore on room create), `deleteIfEmptyAndStale` optional. Room restores its world on first create; late-joiners get the current snapshot (already covered by `welcome`).

- [ ] **Step 1:** Failing tests: save then load round-trips the shape set; loading a missing room returns null; debounce coalesces rapid saves (assert one write for N rapid calls with a fake clock/injected writer).
- [ ] **Step 2-4:** RED→GREEN; typecheck/lint clean.
- [ ] **Step 5: Stage.**

---

### Task B5: Client net layer + interpolation (TDD for pure parts)

**Files:** Create `packages/client/src/net/interpolation.ts`, `packages/client/src/net/netClient.ts`, `packages/client/src/net/roomLink.ts`. Test `packages/client/test/interpolation.test.ts`, `packages/client/test/roomLink.test.ts`.

**Interfaces:**

- `interpolation.ts` (pure): `class SnapshotBuffer` — `push(t:number, p:Vec3, r:Vec3)`; `sample(renderTime:number): {p:Vec3;r:Vec3}` (linear interp between the two surrounding snapshots; clamp to ends). Unit-tested with a synthetic sequence.
- `roomLink.ts` (pure): `parseRoom(url:string): string|null` (`/r/<id>`), `makeRoomId(seed:string): string` (deterministic from a seed string — pass a seed in; no Math.random at module load), `roomUrl(origin, id): string`. Unit-tested.
- `netClient.ts`: `class NetClient(store: ShapeStore, opts)` — `connect(roomId, name, color)`, sends intents (subscribe to `store` `onEvent`: spawn/grab/color/render/scale → corresponding ClientMsg; but SUPPRESS re-emitting events that were themselves applied from the server — use an "applying" guard), sends throttled `held` transforms for the locally-grabbed shape and throttled `pose`. On inbound: `welcome`→populate store from snapshot; `spawn/despawn/recolor/rendermode/scale/grab`→apply to store (inside the applying-guard); `state`→push transforms into per-shape `SnapshotBuffer`s; `pose`→feed avatars; exposes `sampleRemote(shapeId, renderTime)` for the loop. Provides `isConnected()`.

- [ ] **Step 1:** Failing tests for `SnapshotBuffer` (interpolates midpoint, clamps before first/after last) and `roomLink` (parse valid/invalid, deterministic id from seed). (netClient itself is integration-tested in B7.)
- [ ] **Step 2-4:** RED→GREEN; typecheck/lint clean.
- [ ] **Step 5: Stage.**

---

### Task B6: Wire client modes into main.ts (server-driven vs offline)

**Files:** Modify `packages/client/src/main.ts`; add a small `net/roomLink` UI hook in `index.html` overlay (a "Share" button that copies `roomUrl`).

**Interfaces:** On load, `parseRoom(location.href)`: if a room id is present (or the user clicks "Join/Share"), construct `NetClient` and `connect`. Loop change:

- **Offline (not connected):** unchanged Phase A path — `updatePhysics(dt, store, onImpact)` locally.
- **Connected (server-driven):** do NOT run local authoritative physics. Instead, each frame: for shapes NOT locally grabbed, set `group.position/rotation` from `netClient.sampleRemote(id, now - INTERP_DELAY)`; for the locally-grabbed shape, keep controller-driven local movement and stream `held`. Still run `updateShapeRender` for visual bob/rotation of grounded/ungrabbed? No — when server-driven, transforms come from snapshots; keep only non-transform visuals (mesh visibility from renderMode). Seed-5 is host/server authority (client does NOT seed when connected). Impact/spawn FX driven by inbound events via the store `onEvent` (already wired in A8) so remote actions are seen+heard.
- Add a `LOCAL_ID` = server-assigned `playerId` once connected (replaces the offline `'local'`).

- [ ] **Step 1:** Because this is integration-heavy and hard to unit-test in isolation, add a focused test only for any new pure helper you extract (e.g. `chooseTransformSource(shape, localId): 'local'|'remote'`). RED→GREEN.
- [ ] **Step 2:** Manually verify offline mode still builds+runs (Phase A behavior preserved). Connected mode is exercised by the B7 harness + human browser test.
- [ ] **Step 3:** typecheck/lint/build/test green.
- [ ] **Step 4: Stage.**

---

### Task B7: Headless multi-client integration harness (the audit backbone)

**Files:** Create `packages/server/test/multiclient.integration.test.ts` (or a `test/` at root). Uses the real server + multiple `ws` clients driving the real protocol (client-side logic can be exercised via `NetClient` with a stub store, or raw protocol messages).

**Interfaces / assertions:** Spin the server; connect N=4 clients to one room; script: each spawns shapes, grabs/throws, recolors; then assert **world convergence** (all clients' shape sets + final transforms agree within tolerance after settling), **zero ghost shapes** (despawn propagates), **zero id collisions**, **grab conflicts resolved** (two grabbers → exactly one owner), **capacity** (9th rejected), **room isolation** (a second room's shapes never leak), **clean disconnect** (a leaver's grabbed shapes released; avatar removed), **voice fan-out** (binary frame reaches peers, not sender). Include a **backpressure** case (flood frames, assert drop-oldest doesn't crash).

- [ ] **Step 1-2:** Write the harness; run → iterate until all assertions pass.
- [ ] **Step 3:** typecheck/lint green; whole suite green.
- [ ] **Step 4: Stage.**

---

### Task B8: Avatars (head + 2 hands, nameplates, speaking ring)

**Files:** Create `packages/client/src/net/avatars.ts`; wire into `main.ts` (pose send + remote render). Test `packages/client/test/avatars.test.ts` (construction/update over a stub scene).

**Interfaces:** `class Avatars(scene)` — `upsert(playerId, info)`, `updatePose(playerId, pose)` (position/orient a neon head mesh + 2 hand meshes), `setSpeaking(playerId, on)` (emissive ring pulse), `remove(playerId)`, `disposeAll()`. `main.ts`: send local `pose` (head from XR camera, hands from controllers) throttled; feed inbound `pose` to `Avatars`. Per-player `color` from `PlayerInfo`; nameplate via a canvas texture (reuse HUD text pattern).

- [ ] **Step 1:** Failing tests: `upsert` adds head+2 hands to the scene; `updatePose` moves them; `remove` disposes + detaches; `setSpeaking` toggles the ring. (Real THREE objects, stub/real Scene.)
- [ ] **Step 2-4:** RED→GREEN; typecheck/lint/build green.
- [ ] **Step 5: Stage.**

---

### Task B9: Voice capture + encode + fallback detection (TDD pure parts)

**Files:** Create `packages/client/src/voice/featureDetect.ts`, `capture.ts`, `capture-worklet.ts`, `encoder.ts`. Test `packages/client/test/voice-encoder.dom.test.ts` (mock WebCodecs/getUserMedia/AudioWorklet).

**Interfaces:** `detectVoiceMode(): Promise<'opus'|'webm'|'pcm'|'none'>` (feature-detect `AudioEncoder`/`isConfigSupported`, then MediaRecorder, then PCM; else none). `class VoiceCapture(voiceCtx, onFrame:(opcode,tsMs,flags,bytes)=>void, opts)` — getUserMedia (echoCancellation/noiseSuppression/autoGainControl, mono 48k) → AudioWorklet → 20ms blocks → WebCodecs `AudioEncoder` (opus 48k mono ~24kbps) → `onFrame`; VAD/PTT gate; mute. The worklet accumulates 128→960 samples + RMS.

- [ ] **Step 1:** Failing tests (mock globals): `detectVoiceMode` returns 'opus' when AudioEncoder+isConfigSupported ok, 'webm' when only MediaRecorder, 'none' when nothing; capture constructs AudioContext@48000 and requests the right getUserMedia constraints; muted → emits no frames.
- [ ] **Step 2-4:** RED→GREEN; typecheck/lint/build green.
- [ ] **Step 5: Stage.**

---

### Task B10: Voice decode + jitter buffer + spatialization + UX (TDD pure parts)

**Files:** Create `packages/client/src/voice/jitterBuffer.ts`, `decoder.ts`, `spatializer.ts`, `voice.ts`. Wire into `main.ts` + `netClient` (voice frames) + `controllers.ts` (PTT on the unused thumbstick-click button) + `Avatars` (speaking ring). Test `packages/client/test/jitterBuffer.test.ts`.

**Interfaces:** `class JitterBuffer` (pure): `push(tsMs, bytes, flags)`, `pop(nowMs): frame|null` (in-order, target depth ~40-60ms, drop-oldest on overflow, flush on talk-stop). `class VoiceDecoder` per peer (WebCodecs `AudioDecoder`, per-peer reset on error). `Spatializer`: PannerNode(HRTF) per peer, position from that peer's avatar head pose each frame, listener = local camera. `voice.ts` orchestrates: mode from `featureDetect`, capture→send via netClient, inbound frames→jitter→decode→panner. UX: PTT press/release → voice-state + gate; self-mute; per-peer mute (GainNode); speaking indicator.

- [ ] **Step 1:** Failing tests for `JitterBuffer`: in-order pop, reordered insert then in-order pop, overflow drop-oldest, talk-stop flush, missing-frame conceal (advance clock, no stall).
- [ ] **Step 2-4:** RED→GREEN; typecheck/lint/build green. (Live audio is a human/browser test — note it.)
- [ ] **Step 5: Stage.**

---

### Task B11: Infra — server image, compose, reverse-proxy, CI

**Files:** Create `Dockerfile.server`; rewrite `Dockerfile` (client build path → `packages/client/dist`, fixing the A1 stale COPY), `nginx.conf` (serve client + reverse-proxy `/ws` with `Upgrade`/`Connection` headers + TLS-ready), `docker-compose.yml` (client(nginx) + server services, shared network, server `data/` volume for persistence). Update `.github/workflows` to build BOTH images (client + server) with sha + semver tags (drop mutable-`latest`-only), add a lint/test/typecheck gate job.

- [ ] **Step 1:** Write `Dockerfile.server` (node:20-alpine build → run `packages/server`), fix client Dockerfile COPY path.
- [ ] **Step 2:** `nginx.conf`: static client + `location /ws { proxy_pass http://server:PORT; proxy_http_version 1.1; Upgrade/Connection headers; }`; security headers.
- [ ] **Step 3:** `docker-compose.yml`: both services + volume + network + healthchecks.
- [ ] **Step 4:** CI: matrix/two build-push jobs (client, server) with `sha` + version tags; a `test` job (`npm ci && npm run typecheck && npm run lint && npm test`) gating the builds.
- [ ] **Step 5: Verify** `docker compose build` succeeds; `docker compose up` boots both containers; `curl` the client + the server `/healthz`; a `wscat`/node ws smoke connects through nginx `/ws`. (If docker is unavailable in the sandbox, validate configs by lint/parse and note the live boot is deferred.)
- [ ] **Step 6: Stage.**

---

### Task B12: Phase B gate + README

**Files:** Modify `README.md` (multiplayer usage, share-link, voice, controls, deploy, architecture); repo-wide.

- [ ] **Step 1:** Update README: how to run server+client locally, share a link, voice PTT, deploy (GHCR + Cloudflare Tunnel), architecture diagram, and the owner-verified items (Quest hardware, live TLS).
- [ ] **Step 2:** `npm run format`, `npm run lint`, `npm run typecheck`, `npm test` (incl. integration harness), `npm run -w packages/client build`, `npm run -w packages/server build` — ALL green.
- [ ] **Step 3: Stage.** (Squash + `/debug` + audit happen after this in the controller's finalization.)

---

## Self-Review (against the spec)

- **Netcode = authoritative WS server** → B1/B2/B3 (ServerWorld + Room + ws). ✔
- **Per-link rooms ≤8** → B2 (`MAX_PLAYERS`, roomId), B5 `roomLink`. ✔
- **Server-assigned ids, grab first-claim-wins, despawn/seed/budget authority** → B1/B2. ✔
- **Client interpolation + offline fallback** → B5/B6. ✔
- **Avatars (head+2 hands) + nameplates/colors + speaking** → B8. ✔
- **Voice: WS-relayed Opus, fallback ladder, jitter buffer, HRTF spatialization, PTT/mute** → B3 (fan-out) + B9 + B10. ✔
- **Persistence (file-based) + late-join snapshot** → B4 (+ `welcome` in B2). ✔
- **Infra: 2 images, reverse-proxy WS, CI two-image + gate, fix stale COPY** → B11. ✔
- **Headless multi-client audit** (convergence, no ghosts, no id collisions, grab conflicts, isolation, disconnect, voice, backpressure) → B7. ✔
- **Type consistency:** `NetShape`/`ClientMsg`/`ServerMsg`/`Pose` defined B0, consumed B1-B10; `ServerWorld` API B1 → `Room` B2 → ws B3; `SnapshotBuffer` B5 → main B6; voice frame layout B0 → B3 fan-out → B9 encode → B10 decode. ✔
- **Placeholder scan:** none; server skeleton from Phase A is replaced in B3. ✔
- **Deferred (owner-verified):** Quest hardware (VR poses/voice/HRTF/frame budget), live TLS domain + Cloudflare Tunnel, `docker compose up` if docker absent in sandbox — all explicitly noted, not silently skipped.
