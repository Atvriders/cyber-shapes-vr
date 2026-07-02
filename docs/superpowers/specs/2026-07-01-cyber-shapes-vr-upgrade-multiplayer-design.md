# Cyber Shapes VR — Complete Upgrade + Multiplayer (Design Spec)

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation
**Owner:** Atvriders

## 1. Goal

Take `cyber-shapes-vr` from a static, single-player WebXR toy to a **robust, multiplayer, link-shared** cyberpunk playground where up to **8 people per room** join the same live world — seeing each other (avatars), sharing/synced shapes, and talking (spatial voice) — on a modern, tested, upgraded codebase.

Two epics, sequenced:

- **Phase A — Upgrade & Stabilize** (no networking): make the base modern, tested, and bug-free.
- **Phase B — Multiplayer**: authoritative server, netcode, avatars, voice, persistence.

Ends with: deploy-ready containers/CI, full test + audit + `/debug`, updated README, then a **single commit** once everything is green.

## 2. Locked decisions

| Decision        | Choice                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Netcode         | **Authoritative Node WebSocket game server** (server owns world + runs physics)                   |
| Rooms           | **Per-link private rooms**, ~8 players max                                                        |
| Sequencing      | **Upgrade first**, then multiplayer                                                               |
| Presence        | **Avatars (head + 2 hands) + nameplates/colors + voice + world persistence**                      |
| Language        | **TypeScript** across shared + server + client (locks the protocol/world contracts)               |
| Voice transport | **Opus over the SAME WebSocket** (WebCodecs). **No WebRTC, no STUN/TURN/coturn, no extra ports.** |
| Persistence     | **File-based** to start (swappable to Redis)                                                      |
| Deploy          | Atvriders **GHCR + Cloudflare Tunnel** pattern; repo public                                       |
| Commit policy   | **One commit at the very end**, after full verification (no incremental commits)                  |

## 3. Current-state facts (from read-only audit)

- Entire shared state today is `world.shapes[]`; everything else (stars, dust, HUD, bloom, particles, audio) is per-client cosmetic and must NOT sync.
- Structural blockers for multiplayer that must be fixed:
  - Physics is **non-deterministic** (per-client wall-clock Euler + `Math.random` seeds) → no lockstep; needs authority + interpolation.
  - `shapeIdCounter` starts at 0 on every client → **id collisions**. Needs server-assigned ids.
  - `grabbed` is an **owner-less boolean** → two players can grab the same shape. Needs `grabbedBy(peerId)` + arbitration.
  - Deletion emits **no event** → ghost shapes. Needs an explicit despawn event (two call sites).
  - `maxShapes`, seed-5 loop, and "first 20 get a light" all key off **local** `world.shapes.length` → divergence. Must be authoritative.
  - **No server, no TLS, no persistence** — both WebXR and WS/voice require a secure context.
- Latent bugs in the "working" build (fix in Phase A): desktop has zero interaction (`updateControllers` early-returns on `!frame`); HUD shape-counter stuck at 0 (`updateHudShapeCount` never called); bloom render-targets don't resize (`composer.setSize` missing); per-particle size-fade is a no-op (PointsMaterial ignores per-vertex size); duplicated deletion path; wrong `restY` for non-cube shapes; frame-rate-dependent damping.

## 4. Target architecture

```
  Quest 2 / desktop client (Three.js WebXR, TypeScript)
        │  wss:// (ONE port: game intents + poses + voice frames, multiplexed by opcode)
        ▼
  Node authoritative game server (TypeScript)
   • per-link rooms (≤8), capacity, late-join full snapshot
   • canonical world.shapes per room, FIXED-timestep physics (shared core)
   • server-assigned ids, grab arbitration (first-claim-wins), despawn authority
   • avatar head/hand pose relay; voice binary fan-out; file-based persistence
```

### 4.1 Repo structure (monorepo workspace)

- `packages/shared` — **pure, Three-free** physics integrator + protocol message types + constants. Imported by client AND server. The single source of truth for the world contract.
- `packages/client` — the Three.js WebXR app (today's `src/`, migrated to TS).
- `packages/server` — Node WS server: room manager, authoritative loop, persistence, voice fan-out.

### 4.2 State & sync tiers

- **Identity (send once on spawn):** id (server-assigned), type, bobPhase, rotSpeed — random seeds MUST be sent or autonomous motion diverges.
- **Discrete (send on change):** colorIndex, renderMode, scale (throttled), grabbedBy, grounded (re-derivable locally).
- **Continuous (throttled stream ~15–20 Hz, owned shapes only):** position, rotation, velocity (velocity sent with the release/throw event).
- **Presence (per player):** peerId, head pose, 2 hand poses, color, name, held-shape id. Remote avatars are new render objects.

### 4.3 Authority & netcode

- Server runs physics at a **fixed timestep** on the shared core; clients send **intents** and **poses**, receive **state deltas**, and **interpolate** remote transforms.
- Only the owning peer's intents move a grabbed shape; server arbitrates grabs first-claim-wins and rejects the loser.
- Client applies inbound events **before** local physics; non-owned shapes are interpolated, not integrated.
- Late-join = server sends full room snapshot. Disconnect = release grabbed shapes, remove avatar, notify room.

## 5. Voice subsystem (WS-relayed Opus, zero extra infra)

- **Capture:** `getUserMedia` (mono 48 kHz, echoCancellation/noiseSuppression/autoGainControl on) → `AudioWorklet` batches 128-sample quanta into 20 ms (960-sample) blocks + RMS for VAD.
- **Encode/relay/decode:** WebCodecs `AudioEncoder` (Opus, ~24 kbps VoIP) → tagged **binary WS frame** `[opcode 0x10][senderId u8 (server-stamped)][timestampMs u32][flags u8][opus bytes]` → server fans out to other room peers (excludes sender, drop-oldest on backpressure, never decodes/persists) → `AudioDecoder` → Web Audio graph.
- **Spatialization:** one `PannerNode`/`PositionalAudio` (HRTF) per peer, positioned each frame from the avatar head-pose the server already broadcasts; listener = local XR camera. No extra pose traffic.
- **UX:** push-to-talk on the **unused thumbstick-click button** (open-mic/VAD toggle available), self-mute, per-peer mute, neon speaking-indicator ring on avatars. Gesture-unlock reuses `audio.js` context + Enter-VR button.
- **Resilience:** small adaptive **jitter buffer** (mitigates TCP head-of-line), Opus in-band FEC, per-peer decoder reset on error, loudest-N cap on Quest if CPU-bound.
- **Fallback ladder (degrade-not-break, all reuse the same fan-out → still zero infra):** WebCodecs Opus (0x10) → MediaRecorder Opus/WebM (0x11) → µ-law PCM for tiny rooms (0x12) → clean disable with HUD message. The app never crashes.
- **Protocol control messages:** `VOICE_JOIN`, `VOICE_LEAVE`, `VOICE_CONFIG`, `VOICE_STATE`, `VOICE_ROSTER` (+ the binary `VOICE_FRAME` variants).
- **Bandwidth:** ~26 kbps up per talker; ~180 kbps down worst-case in a full room. Trivial.

Voice reuses the SAME wss connection, port, room membership, and authoritative playerIds as the game channel — multiplexed by a leading opcode byte (`0x00–0x0F` game, `0x1x` voice). Server trusts its own id, never the client-supplied one.

## 6. Phase A — Upgrade & Stabilize (work list)

1. **Safety net:** ESLint + Prettier + **Vitest**; TypeScript migration; CI lint/test gate.
2. **TLS/secure context:** Vite dev HTTPS (basic-ssl/mkcert); prod behind reverse-proxy / Cloudflare Tunnel.
3. **Dependency bumps:** Three r0.168 → latest (watch `effects.js` post-processing churn + addon paths), Vite → latest, pin Docker digests.
4. **Bug fixes:** composer resize, HUD counter, desktop interaction, particle size shader, unify deletion path, per-shape `restY` (bounding box/sphere), delta-scaled damping.
5. **Quest 2 perf:** cap/bake point lights, drop double transparent draw (opaque solids), geometry caching/`InstancedMesh`, `setFoveation`, DPR clamp, WebXR-compatible glow (bloom is missing in-headset today).
6. **Refactor shape lifecycle behind one clean API** (create/remove/mutators) to prepare network hooks; extract shared constants.
7. **Gate:** deep `/debug` + full audit; hold commit.

## 7. Phase B — Multiplayer (work list)

1. Extract **shared physics core** into `packages/shared`; unit-test parity vs. Phase A behavior.
2. **Protocol + identity:** server-assigned ids; `grabbedBy`; full message set (join/leave/snapshot/spawn/despawn/grab/release/recolor/mode/scale/transform/pose/voice-*).
3. **Server:** room manager (per-link, ≤8, capacity), authoritative per-room world, fixed-timestep loop, intent validation, grab arbitration, despawn + budget + seed authority, delta broadcast, persistence, voice fan-out.
4. **Client net layer:** connect on room link; emit intents from existing callback hooks + throttled owned-transforms + poses; drain inbound queue before physics; interpolate remote transforms; reconcile.
5. **Avatars:** remote head + 2 hands from poses; nameplates + per-player neon colors; speaking-indicator.
6. **Voice:** as §5.
7. **Persistence:** save/restore room world; late-join snapshot; disconnect cleanup.
8. **Infra:** second Docker image (server); compose gains server + WS-upgrade reverse-proxy; CI builds both images with sha/semver tags (drop mutable-`latest`-only).
9. **Gate:** deep `/debug` + full multi-client audit; hold commit.

## 8. Testing & audit strategy

- **Unit:** shared physics-core parity, protocol (de)serialization, id/owner logic, grab arbitration, clamp/cycle math, voice framing, jitter buffer (in-order/reorder/drop/overflow/flush).
- **Integration (headless):** multi-client harness (in-process `ws` sockets) — N players spawn/grab/throw → assert world convergence, zero ghosts, zero id collisions, grab-conflict resolution, room isolation (>8 rejected, other-room isolation), backpressure drop-oldest, clean disconnect.
- **Manual/e2e:** desktop multi-tab (bidirectional voice, PTT, mute, distance panning, speaking indicators). **Quest hardware pass is the owner's** (comfort, mic-in-immersive, HRTF head-turn, frame budget).
- Both phases end with an explicit deep-`/debug` + audit gate.

## 9. Out of scope / deferred

- Redis persistence (file-based first), full-body avatars, text chat, teleport locomotion, PWA/offline install, non-VR mobile touch controls, server-side voice transcoding (explicitly avoided — breaks zero-infra rule).

## 10. Risks

- No server/TLS/persistence exists today — a whole backend + secure-context + reverse-proxy story is built from scratch.
- Physics non-determinism → must land authority + interpolation before any sync works.
- TCP head-of-line blocking is the one real downside of voice-over-WS (mitigated: small frames + adaptive jitter buffer + FEC).
- Quest 2 is the weakest CPU: 1 encoder + up to 7 decoders + WebXR render on one SoC → needs VAD gating + loudest-N cap + the Phase-A perf work first.
- Zero tests today on a codebase about to be heavily refactored → the safety net (Phase A step 1) lands first.
- `audio.js` uses a default-rate AudioContext; voice needs 48 kHz end-to-end.
- **Owner-verified only:** Quest hardware behavior and live-infra deploy.
