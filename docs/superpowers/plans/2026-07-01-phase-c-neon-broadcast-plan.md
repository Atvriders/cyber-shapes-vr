# Phase C — "The Neon Broadcast" — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Every task subagent MUST read Global Constraints + the FAQ section below before starting its task.**
>
> **Handoff note:** This plan was authored outside the repo while Phase A/B were in flight, adversarially reviewed (v1: 4 reviewers, 59 findings; v2 upgrade round: 41 proposals → 16 accepted, 32 skeptic verdicts — all fixes folded in; see spec Appendix C). On receipt: (1) copy this file to `docs/superpowers/plans/`, the spec to `docs/superpowers/specs/`, and RUN_OF_SHOW.md to `docs/booth/`, (2) execute Task C0 FIRST — it re-binds every contract this plan consumes against the as-built Phase B code and records deviations in the plan file before any other task runs.

**Goal:** Turn the Phase B multiplayer playground into a self-running university-booth show — a self-directing big-screen broadcast with procedural commentary, tiered phone participation, remote data-plane spectating, staff-triggerable showpieces, a persistent crowd-built world, a complete desktop view + world-builder (the Workshop), and full booth-ops — per the approved spec v2.1 at `docs/superpowers/specs/2026-07-01-phase-c-neon-broadcast-design.md` (spec §refs below point there).

**Architecture:** One Tier-0 chassis (connection tiers + tier auth, 0x20–0x3F opcode registry + Appendix B wire formats, clock sync, staff auth, cue/timeline engine, PhysicsParams, persistence buckets, code-split phone funnel) built first and consumed by all 23 features. Features land in 6 cut-safe tiers plus the Workshop group (W); every feature ships its standalone fallback and treats sibling wiring as an attach-if-landed upgrade. Server stays authoritative; all new state rides the existing single wss:// port.

**Tech Stack:** Existing monorepo (TypeScript 5, Vite, Three.js latest, Vitest, npm workspaces, Node `ws` server, Docker/GHCR/Cloudflare Tunnel). No new runtime dependencies without a task saying so.

## Global Constraints

- **NO incremental commits.** Every task ends at "verify green + `git add`". ONE commit at the very end (Task C24), after full verification. (Owner rule.)
- **Rails:** one `wss://` port, opcode-multiplexed; no WebRTC/STUN/TURN; server-authoritative; in-browser clients + one Node server only; all repos/packages public.
- **Opcodes & kinds:** Phase C uses `0x20–0x3F` ONLY, minted ONLY in `packages/shared/src/protocol/opcodes.ts` (spec §5.2) — including per-family `kind` byte enums. Byte layouts for hot binary families are normative in spec Appendix B; never invent an encoding locally.
- **Timers:** shared/server code takes injected timers per C3's `TimerApi`/`scheduleAt`; raw `setTimeout` in shared code is a review reject. Tests use fake timers everywhere.
- **Names:** free text NEVER reaches any screen; server-assigned unique callsigns everywhere (spec §6.1); any `requestedName` is a validated curated-wordlist index.
- **Audio:** room voice NEVER on booth speakers; the stage owns one priority-ducking mixer (spec §6.2, built in C9). Headset-local audio never routes through it.
- **Comfort:** effects never move camera/rig/horizon/grid; flashes ≤ 3 Hz; headset glitches ≤ 500 ms (spec §6.3).
- **Perf ledger:** sub-budgets per spec §6.5; Tier 6 features record their ledger rows before their cues are advertised.
- **Quest 2 + desktop Chromium stay working after every task**; `npm test`, `npm run typecheck`, `npm run -w packages/client build` green at the end of every task.
- **Bundle sizes:** from C7 onward, EVERY task that touches `packages/client` runs `npm run size` in its verify step (ballot/crowd chunks < 100 KB gz; wisp entry < 300 KB gz initial — spec §5.7).
- **Tier 6 discipline (spec §8 Flex rules):** no Tier ≤5 module may import a Tier 6 module (dependency-direction tested); every Tier 6 feature declares its §6.6 rung + §6.5 ledger line before build; Tier 6 cues are Advanced-tab/staff-only and never enter the pacing table; Tier 6 adds ZERO new Phase B accommodation requests.

## FAQ for task subagents

*Style rule: every answer POINTS into normative text; C0 fixes any pointer its rebinding invalidates. Hard cap ~15 entries.*

1. **Where do I mint an opcode or kind byte?** Only in `protocol/opcodes.ts` via the C1 registry (spec §5.2). The exhaustiveness tests are the tripwire.
2. **Where do byte layouts live?** Spec Appendix B + the golden pairs in `protocol.golden.ts` (C1). Never invent; JSON-after-preamble for unlisted messages.
3. **How do I touch time?** Inject `TimerApi`/use `scheduleAt` (C3). Fake timers in tests. Timestamps are roomEpoch-relative u32 (Appendix B).
4. **How does my cue affect physics?** `RoomHandle.setBaseParams` (standing laws) vs `setCueOverlay` (timed dials) — C10 seeds the minimal single-overlay host; C11 completes the two-layer baseParams/cueOverlay state; revert pops to base (spec §5.6/D4).
5. **May my feature call a sibling feature?** No — RoomHandle only; sibling wiring is an attach-if-landed hook (C19's `themeCut?` is the pattern).
6. **Which tier receives message X?** `TIER_POLICY` (C1/C2) + the spec §5.1 table. Crowd gets cue/summary only; audience gets the §5.1 union.
7. **How do I move the stage camera?** `stage.requestShot(shot, holdMs)` (C9). Never drive the camera directly from a feature.
8. **Stage audio?** Register with the C9 mixer at your spec §6.2 priority. Never create a second AudioContext on the stage.
9. **New dependency?** No, unless your task text says so explicitly.
10. **The as-built code contradicts my task?** Stop; read the **"C0 BINDINGS (as-built)"** block under Task C0 in this file (the 15 bound contracts + the `rooms.ts` rebind note in the File Structure) — it is the authoritative map of what actually exists. C0 is the only task that edits the plan.
11. **Names on screens?** Callsigns only (§6.1); caster slots are indices, never strings (§7.15).
12. **What counts as a "human" for timeline/idle/attract logic?** `humanResidents()` — synthetic peers are invisible to presence signals (§7.17).
13. **Building Tier 6 or the Workshop (group W)?** No Tier ≤5 module may import a Tier 6 module (the dependency-direction test asserts the Tier 6 set; W modules are exempt — Tier ≤5 modules MAY import W shared modules where a task says so, e.g. timeline.ts → layouts.ts with the constants fallback preserving cut-safety); declare your §6.6 rung + §6.5 ledger line first; your cues are Advanced-tab-only and never auto-cued.
14. **Can my feature promise a flex line?** Only if §14 shows its gating test green.
15. **Where do Phase D notes go?** Nowhere in your task — blockquoted "Phase D note — NO Phase C action:" notes are read-only context.

## File Structure (target after Phase C; paths relative to repo root)

```
packages/shared/src/
  protocol/opcodes.ts        # 0x20–0x3F registry + per-family kind enums (single source of truth)
  tiers.ts                   # Tier enum, TIER_CAPS, TIER_POLICY, spectator send-whitelist
  callsigns.ts               # generateCallsign(rng, taken); DMN- namespace reserved
  clock.ts                   # offset estimator + fire-at scheduler (0x30/0x31; lastRttMs field)
  cues.ts                    # Cue, RoomHandle, CueRegistry, RoomTimeline, PHASE_DURATIONS_MS, pacing table
  physicsCore.ts             # (modify) PhysicsParams, DEFAULT_PARAMS (inert), DIAL_BOUNDS, mergeParams,
                             #   stepBody(body, dt, params), applyRadialImpulse
  wisps.ts                   # allocateSlot, WISP_DRAW_CALL_BUDGET, pulse token-bucket constants
  titanMath.ts               # titan hand-impulse + radius/clamp math
  tkMath.ts                  # TK pull-force + cone-select math (Tier 6, C32)
  replay.ts                  # ring buffer + replay player (pure; created by C21, consumed by C29/C30/C31)
  reels.ts                   # coalescing recorder frame types + reducer (pure)
  stageBrain.ts              # shot state machine + RoomEvent union + fame tiebreak + highlight scorer (shared)
  casterGrammar.ts           # pure caster templates (Tier 6, C26)
  siegeWaves.ts              # WaveDef table (Tier 6, C27 — own module: cutting Tier 6 leaves no Tier ≤5 residue)
  daemons.ts                 # daemon behavior + pose-synth, pure (Tier 6, C28; consumed by C22 load generators)
  music/beatClock.ts         # logical-BPM clock (created C13; extended C18)
  music/{quantizer,noteMap}.ts   # Resonora pure core (C18)
  themes.ts / glyphs.ts / elections.ts
  layouts.ts                 # Layout schema + validators + settleBake (Workshop, C34)
packages/server/src/
  rooms.ts                   # (modify) tiered room manager + tier auth, per-tier fan-out, idle-kick
  # ⚠ C0 REBIND (applies to EVERY task that names `packages/server/src/rooms.ts`, incl. C3/C14/C21/C25/C28/C30/C35):
  #   there is NO `rooms.ts` as-built. The Phase B equivalent is the module SET
  #   { roomManager.ts (caps + join + player-id), room.ts (per-room state/intent/tick/snapshot),
  #     connection.ts (WS handshake + tier gate + voice fan-out + roster), index.ts (sim loop) }.
  #   Apply each `rooms.ts` change to whichever of those owns the surface (join/tier → connection.ts+roomManager.ts;
  #   fan-out/roster/voice → connection.ts; tick/state/intent → room.ts; sim cadence → index.ts).
  #   A task MAY still CREATE a new `rooms.ts` facade if it prefers — but must not assume one exists to modify.
  auth.ts                    # CREATE_ROOM, ownerToken + join secret (HMAC, epoch), ROTATE_SECRET/DOOR_CLOSE/ROTATE_LINK
  buckets.ts                 # world / guestbook / dayStats persistence buckets
  timeline.ts                # RoomTimeline host + PHASE_STATE + auto-cue playlist + RESET handler + election host
  conductor.ts               # Resonora server conductor
  caster.ts                  # MC NULL stateful host (Tier 6, C26)
  recorder.ts                # ReelRecorder (tee + sanitize + rotate + auto-banker)
  siege.ts / titan.ts / encore.ts / dials.ts / metrics.ts
  daemons.ts                 # daemon host + summon/dismiss cues (Tier 6, C28)
  clips.ts                   # clip store endpoints (Tier 6, C31)
packages/client/src/
  stage/{stage.ts,overlays.ts,mixer.ts,replay.ts(adapter),attract.ts,xray.ts,clips.ts}   # ?mode=stage
  director/console.ts        # ?mode=director (DOM-only)
  funnel/{index.html,ballot.ts,crowd.ts,wisp.ts,exit.ts}  # code-split entries (+ ?watch route)
  wisps.ts / glyphRender.ts / envTheme.ts
  desktop/{cameras.ts,input.ts,hud.ts,help.ts}    # F22 Desktop Command (Workshop, C33)
  builder/{builder.ts,gizmos.ts,palette.ts,undo.ts,layoutPanel.ts,glyphSeeder.ts}  # ?mode=build (Workshop, C35)
  music/themeSynth.ts        # standalone 2-osc drone + attract/theme music (C13)
  music/synth.ts             # Resonora note voice pool + local prediction (C18)
tools/preflight/  ·  tools/check-bundle-size.mjs  ·  tools/gen-goldens.mjs  ·  tools/import-layout.mjs
docs/booth/{RUNBOOK.md, RUN_OF_SHOW.md, BUDGET_LEDGER.md, CLOSING_CEREMONY.md}
```

**Tier map:** C0–C8 = Tier 0 · C9–C11 = Tier 1 (minimum shippable booth) · C12–C13 = Tier 2 · C14–C15 = Tier 3 · C16–C17 = Tier 4 · C18–C21 = Tier 5 · **C25–C32 = Tier 6** · **C33–C35 = Workshop (group W)** · C22–C24 = hardening/ops/gate.
**Execution order:** C0…C21, then **C33–C35 (Workshop — Tier 6 content benefits from a composed showroom)**, then C25–C32, then C22–C24 — post-C21 tasks execute BEFORE the soak/ops/gate tasks regardless of numbering, so C24 remains the terminal single-commit gate.
**Cut ladder:** cut Tier 6 top-down first (C32 → C31 → C30 → C29 → C28 → C27 → C26 → C25), **then the Workshop top-down (C35 → C34 → C33 — owner-prioritized to outlive Tier 6)**, then C21 backward; never below C11. C22/C24 include each subsystem conditionally on its task having landed (their mandatory core is Tier ≤ 1).

---

### Task C0: As-built contract audit + Phase B protocol coordination

**Files:**
- Read (no modify): everything under `packages/shared/src`, `packages/server/src`, `packages/client/src` as built by Phase A/B
- Modify: THIS plan file (record deviations inline per task; sweep the FAQ and Appendix A annotations)
- Modify (small, coordinated): Phase B protocol files — see Step 2

**Interfaces:**
- Produces: a verified binding, written into this plan file, for every contract the plan consumes:
  1. exact `stepBody` signature + return shape; 2. ShapeStore event union; 3. delta/pose message shapes; 4. **server physics tick rate AND server→client delta broadcast cadence (both numbers)**; 5. late-join snapshot serializer name; 6. interpolation module entry points; 7. room-manager join path; 8. opcode dispatch table (+ first-byte demux compatibility for Appendix B); 9. persistence file layout; 10. client camera/controller scene-graph structure (rig `Group` present or absent) + where C17 introduces one; 11. remote-avatar renderer module + nameplate entry point + presence-message extension point for `playerScale`/`synthetic`; 12. voice-roster membership API + voice fan-out function (+ confirm `permessage-deflate` disabled on the fan-out path — spec §7.14); 13. client intent-emission path (grab/release message construction — C16 adds timestamps here); 14. the concrete event stream a spectator receives (C9 defines `RoomEvent` from this); 15. presence `name` field write path (C2 overwrites it with callsigns).
- [x] **Step 1:** Read the as-built Phase B code and bind all 15 contracts above. Where reality differs from any task's text, edit the affected task in this plan file NOW; sweep the FAQ (rebind or strike any invalidated pointer) and resolve every `<bind in C0>` marker in spec Appendix A/B (annotation/rename edits only — never restructure diagrams). **DONE — see the "C0 BINDINGS (as-built)" block below; task/FAQ edits applied inline; spec Appendix A markers + Appendix B templates resolved.**
- [x] **Step 2:** Confirm the four Phase B accommodations (spec §3): unknown-opcode-ignore (and unknown-KIND-ignore within known families); `u32 serverTick` in delta headers; `impactSpeed` in the physics-step broadcast; grab-rejection broadcastability (enable broadcast of the existing Phase B rejection **alongside** the unicast; the 0x2D message is minted in C1 and wired by C9/C21). Also request the §3 fifth additive field — release events carry server-computed `{pos, vel}` (needed by C30; harmless earlier). For each: if present, note it; if absent, add it as a small additive change WITH a test. **DONE — all 5 landed additively (details in the bindings block).**
- [x] **Step 3:** Verify the interpolation layer accepts an injected clock + message source (socket or buffer). If it doesn't, refactor to `createInterpolator({source, now})` with a parity test against existing behavior (required by C13/C21/C29/C30 replay). This signature then FREEZES — later tasks (C29) compute their diagnostics at the source/shim layer, never by extending it. **DONE — refactored; signature FROZEN (details below).**
- [x] **Step 4: Verify** full existing suite green: `npm test`, `npm run typecheck`; run the Phase B headless multi-client harness. **DONE — 485 tests pass (460 prior + 25 new), typecheck + lint clean, client build green, harness green.**
- [x] **Step 5: Stage.** **DONE (transient commit `feat(C0): rebind contracts + Phase B protocol accommodations`).**

---

### C0 BINDINGS (as-built) — authoritative for every downstream task

> **Owner note:** this block is the single source of truth for the 15 consumed contracts as they actually exist in Phase A/B code. Where a later task's prose named a not-yet-existing module or shape, that task's text has ALSO been edited inline; this block is the index. All paths are repo-relative.

**Package layout as-built:** shared has NO `net/` split beyond `packages/shared/src/net/{types.ts,protocol.ts}`; the plan's target `protocol/opcodes.ts`, `tiers.ts`, etc. are all NEW (created by C1+). Server modules are `packages/server/src/{index.ts,connection.ts,room.ts,roomManager.ts,serverWorld.ts,persistence.ts}` — there is **no `rooms.ts`**; the plan's `rooms.ts` maps to this set (see rebind 7/12/15 below). Client net lives in `packages/client/src/net/{interpolation.ts,netClient.ts,avatars.ts,modeSelect.ts,roomLink.ts}`.

1. **`stepBody` signature + return shape** — `packages/shared/src/physicsCore.ts`: `stepBody(body: PhysicsBody, dt: number): StepResult` where `StepResult = { impact: boolean; impactSpeed: number; removed: boolean }`. `PhysicsBody = { position, velocity, scale, type, grabbedBy, grounded }`. Grabbed → early-return no-op. **C6** adds the 3rd `params` arg with `= DEFAULT_PARAMS` default (backward-compatible). Constants: `GRAVITY/BOUNCE/FRICTION/REST_THRESHOLD/REMOVE_DISTANCE` in `constants.ts`; `REMOVE_DISTANCE = 50`.
2. **ShapeStore event union** — CLIENT `packages/client/src/world.ts`: `ShapeEvent = spawn | despawn | color | render | scale | grab` (grab carries `peerId: string|null`). SERVER authoritative world is `packages/server/src/serverWorld.ts` (`ServerWorld` — spawn/grab/release/setHeld/step; evicts oldest UNGRABBED on cap). **C5's `pin()`/`unpin()` + the §6.4 eviction invariant land in `serverWorld.ts`** (the existing eviction already skips grabbed; C5 adds the pinned-skip + pin/unpin). The client store's eviction is offline-only (`_serverAuthoritative` gate).
3. **Delta / pose message shapes** — SERVER→CLIENT JSON (`net/types.ts` `ServerMsg`). Delta = `{ t:'state', seq, serverTick, shapes:[{id,p,r,v,s?}] }` (`serverTick`+`s?` are C0-added, accommodations #2/#3). Pose relay = `{ t:'pose', id, pose }` with `pose = { head:{p,q}, hands:[{p,q}|null,…] }`. Late-join = `{ t:'welcome', playerId, room, shapes:NetShape[], players:PlayerInfo[] }`. `NetShape` (full serializable shape) is the snapshot element.
4. **Physics tick rate AND delta broadcast cadence (BOTH numbers)** — `packages/server/src/index.ts`: **physics tick = 30 Hz** (`TICK_MS = 1000/30`); **`state` broadcast = every 2nd tick ≈ 15 Hz** (`BROADCAST_EVERY = 2`). Discrete events (spawn/despawn/grab) broadcast EVERY tick (never throttled). `resident full-rate` in spec §5.1 / Appendix A = this cadence.
5. **Late-join snapshot serializer** — `Room.snapshotFor(playerId): ServerMsg` in `packages/server/src/room.ts` (returns the `welcome` message). There is no separate serializer function; `Room.worldShapes` getter exposes the `NetShape[]`.
6. **Interpolation module entry points** — `packages/client/src/net/interpolation.ts`: the primitive `SnapshotBuffer` (push/sample) is UNCHANGED. **C0 added the FROZEN `createInterpolator({source, now}): Interpolator`** (`StateSource.onState(cb)→unsub`; `Interpolator.sample/ingest/has/rekey/drop/clear/dispose`). `netClient` is now a `StateSource` and owns one `Interpolator` (per-shape buffers live inside it); `sampleRemote` delegates to it. **This signature is FROZEN** — C29 computes diagnostics at the source/shim layer, never by extending it.
7. **Room-manager join path** — `packages/server/src/roomManager.ts` `RoomManager.join(roomId, name, color) → {room, playerId} | {error}` (async; assigns `p0,p1,…`; `getOrCreate` restores persisted shapes first). WS entry is `packages/server/src/connection.ts` `handleConnection` → the `join` branch (validates protocol/room-id, `clampName`, calls `manager.join`). **C2's tiered handshake extends the `join` branch here; the plan's `rooms.ts` = `{roomManager.ts + room.ts + connection.ts}` as-built.**
8. **Opcode dispatch table + first-byte demux** — TODAY messages are a discriminated union on `t` (JSON via `encodeText`/`decodeText`), NOT numbered opcodes; C1 introduces 0x20–0x3F. Binary = voice only: `[opcode u8][senderId u8][tsMs u32LE][flags u8][opus]`, opcodes `VOICE_OPUS=0x10/WEBM=0x11/PCM=0x12`. **First-byte demux is Appendix-B-compatible:** C0 added `isVoiceOpcode(byte)`/`voiceOpcodeOf(buf)` to `net/protocol.ts` and gated `connection.ts handleBinary` on them — any non-voice binary first byte (future 0x20–0x3F) is DROPPED, never mis-decoded as voice. Unknown text `t` is already ignored (`decodeText` requires a string `t`; `GAME_INTENTS` gate + client `default:` case). **Accommodation #1 — DONE.**
9. **Persistence file layout** — `packages/server/src/persistence.ts`: ONE flat file per room, `<DATA_DIR>/rooms/<roomId>.json` → `{ shapes: NetShape[] }` (debounced writes; `ROOM_ID_RE` path-safety; `isValidPersistedShape` load filter). **C8's world/guestbook/dayStats buckets are NEW — there is no bucket layer yet.** Persistence enabled only when `DATA_DIR` env is set.
10. **Client camera/controller scene-graph (rig Group?)** — `packages/client/src/main.ts`: **NO rig Group.** The `PerspectiveCamera` is created and positioned directly (`camera.position.set(0,1.6,3)`); it is NOT added to a parent `Group` and NOT added to the scene as a child of a rig. Desktop uses `OrbitControls(camera, …)`; XR uses `renderer.xr.getCamera()`. Controllers are `THREE.Group[]` (`controllerGroups`) from `initControllers`. **C17 must CREATE the rig `Group` in `main.ts`** (parent the camera + controller groups under it and scale the rig about the floor point) — its Files line already says "CREATE the rig Group if C0 found none": confirmed none.
11. **Remote-avatar renderer + nameplate + presence extension point** — `packages/client/src/net/avatars.ts` `Avatars` class (`upsert/updatePose/setSpeaking/remove/disposeAll`; head+2 hands+ring+canvas nameplate). Nameplate = per-avatar `CanvasTexture` plane (`makeNameplateCanvas`/`drawNameplateText`). **Presence extension point for `playerScale`/`synthetic` = `PlayerInfo` (`net/types.ts`, `{id,name,color}`) + the `player-join`/`welcome.players` messages** — add optional fields there (C17 `playerScale`, C28 `synthetic`); `Avatars.upsert` takes `PlayerInfo`. The headset HUD toast module referenced by C12 does NOT exist yet (create it).
12. **Voice-roster membership API + voice fan-out** — `packages/server/src/connection.ts`: roster = `hub.getVoiceSet(roomId)` (a `Set<playerId>`), broadcast via `broadcastVoiceRoster` as `{t:'voice-roster', players:[{id,voice}]}`. Fan-out = `handleBinary` (stamps senderId, loops room sockets, sends only to voice-enabled peers excl. sender, per-peer `bufferedAmount` backpressure at 256 KiB). **`permessage-deflate` is DISABLED on the fan-out path — CONFIRMED:** `packages/server/src/index.ts` constructs `new WebSocketServer({ server, maxPayload })` with NO `perMessageDeflate` option → `ws` defaults it to OFF. (spec §7.14 requirement met with zero change.)
13. **Client intent-emission path (grab/release construction)** — `packages/client/src/net/netClient.ts` `onLocalStoreEvent` (grab → `{t:'grab',id}`; release → reads `shape.velocity`+group transform → `{t:'release',id,velocity,position,rotation}`). Held streaming = `sendHeld` (throttled `{t:'held',…}`). Desktop input bindings (C33/C16 preserve verbatim): click-empty = spawn, drag = grab/throw, `C` = recolor, `V` = render mode, `X`/`Backspace`/`Delete` per controllers.ts. **C16 adds `clientTimestamp` to the grab construction HERE.**
14. **Concrete event stream a spectator receives (C9 `RoomEvent` source)** — the `ServerMsg` union a resident/spectator gets today: `welcome, player-join, player-leave, spawn, despawn, recolor, rendermode, scale, grab (+pos/vel on release), grab-rejected (opt-in), state (seq/serverTick/s?), pose, voice-roster, voice-state, error`. **C9 defines `RoomEvent` in `stageBrain.ts` from THIS union** (throw/impact = `state.s` impactSpeed + velocity; join = `player-join`; grab-duel = `grab-rejected` when enabled).
15. **Presence `name` write path (C2 overwrites with callsign)** — TWO points: (a) `connection.ts` join branch computes `safeName = clampName(msg.name)` and passes it to `manager.join(room, safeName, safeColor)`; (b) `roomManager.join` calls `room.addPlayer({id, name, color})`. **C2 overwrites `name` with the server-assigned callsign at (a)/(b)** — every nameplate/roster renderer reads `PlayerInfo.name`, so callsigns display with zero client change (spec §3 change 4 / §6.1).

**Accommodations landed (all additive, all tested; Phase B behavior bit-preserved):**
- **#1 unknown-opcode/kind ignore** — binary hardened via `isVoiceOpcode`/`voiceOpcodeOf` + `connection.ts` drop; text already covered. Tests: `packages/shared/test/protocol.test.ts` (opcode demux), `packages/server/test/wsServer.test.ts` ("a NON-voice binary frame is dropped…").
- **#2 `serverTick`** — ADDED as a distinct u32 physics-tick counter on `state` (NOT `seq`, which stays the ~15 Hz broadcast counter). `Room._serverTick` bumps every `tick()`. Tests: `packages/server/test/room.test.ts` (accommodation #2), `protocol.test.ts` round-trip.
- **#3 `impactSpeed`** — `serverWorld.step()` already computed `impacts:[{id,speed}]`; `Room.tick()` now carries it as per-shape optional `s` on `state` (present only on the contact tick). Tests: `room.test.ts` (accommodation #3), `protocol.test.ts`.
- **#4 grab-rejection broadcastability** — ADDED `{t:'grab-rejected',id,peerId,by}` + `Room.setBroadcastGrabRejections(on)` (OFF by default; the losing-grab path still returns `[]` unless opted in — NEVER replaces Phase B). Tests: `room.test.ts` (accommodation #4).
- **#5 release `{pos,vel}`** — release `grab` event now carries server-computed `pos`/`vel` (read back from the world post-release). Tests: `room.test.ts` (accommodation #5), `protocol.test.ts`.

---

### Task C1: Opcode registry + tiers + callsigns + shared constants + golden vectors

**Files:**
- Create: `packages/shared/src/protocol/opcodes.ts`, `packages/shared/src/tiers.ts`, `packages/shared/src/callsigns.ts`, `tools/gen-goldens.mjs`; export from `packages/shared/src/index.ts`
- Test: `packages/shared/test/protocol.test.ts`, `packages/shared/test/protocol.golden.ts`, `packages/shared/test/callsigns.test.ts`

**Interfaces:**
- Produces:
  - `export const OPCODES = { TIER_HELLO: 0x20, PHASE_STATE: 0x21, DIRECTOR: 0x22, ENV_STATE: 0x23, THEME_SET: 0x24, VOTE: 0x25, WISP: 0x26, SHOWPIECE: 0x27, PLAYER_SCALE: 0x28, MUSIC: 0x29, CROWD_CUE: 0x2A, GLYPH: 0x2B, REEL: 0x2C, GRAB_REJECTED: 0x2D, STATS_CARD: 0x2E, METRICS_PING: 0x2F, CLOCK_PING: 0x30, CLOCK_PONG: 0x31, AUDIENCE_STATE: 0x32, CASTER_LINE: 0x33, TELEKINESIS: 0x34, BUILD: 0x35 } as const` — 0x32–0x35 minted now for registry stability; they carry no traffic until C25/C26/C32/C34 land (C34 adds the BUILD kind enum); 0x36–0x3F reserved-free.
  - **Per-family kind enums in this same file** (e.g. `DIRECTOR_KIND = { CMD: 0, CATALOG: 1, ACK: 2 }`; later tasks ADD kinds here — C29 adds `STAGE_XRAY`, C31 adds `SAVE_CLIP`, C27 adds `WAVE` to SHOWPIECE, C32 adds `TK_PULL/TK_RELEASE/TK_HANDS_STATE`); single-kind families use 0x00.
  - Encode/decode pairs per spec Appendix B for the hot families (CLOCK_PING/PONG, WISP_POSE, MUSIC_CLOCK/NOTE, CROWD_CUE, CHARGE_STATE); `tools/gen-goldens.mjs` generates the (hex, fields) golden pairs and they are pasted back into Appendix B (hand-assembled hex forbidden).
  - `export type Tier = 'resident'|'spectator'|'director'|'wisp'|'crowd'` (the `audience` member is ADDED by C25 — spec §5.1 annotation) with `TIER_CAPS`, `TIER_POLICY` (fields per spec §5.1 incl. `authRequired`, `voiceRecv`), `SPECTATOR_SEND_WHITELIST` (heartbeat, CLOCK_PING, 0x2C family, stream-subscription control).
  - `export function generateCallsign(rng, taken: ReadonlySet<string>): string`; `CURATED_WORDLIST` (≥ 64 words, denylist-screened, pronounceable — TTS review criterion); `DMN-` prefix reserved for synthetic peers; `WORLD_RADIUS = 20`.
  - **`export interface TimerApi { setTimeout(cb, ms): Handle; clearTimeout(h): void; now(): number }`** — the injected-timer contract the Global Constraints reference; C2's idle-kick uses it from day one, C3's `scheduleAt` consumes it.
- [ ] **Step 1: Write failing tests:** OPCODES unique within 0x20–0x3F (exhaustive); kind uniqueness per family; TIER_CAPS/TIER_POLICY exhaustive over Tier; golden pairs round-trip BOTH directions (decode(hex) ≡ fields; encode(fields) ≡ hex); the markdown-extraction test (regex-pull hex blocks from the spec Appendix B file, assert byte-equality with protocol.golden.ts); `generateCallsign` deterministic, `/^[A-Z]{3,10}-\d{2,3}$/`, no duplicates across 5,000 sequential assignments, never emits `DMN-` for humans, wordlist denylist-screened.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (+ run gen-goldens, paste pairs into Appendix B). **Step 4:** Run → PASS, typecheck clean. **Step 5: Stage.**

---

### Task C2: Tiered room manager + tier auth + per-tier fan-out + idle-kick

**Files:**
- Modify: **`packages/server/src/{roomManager.ts, room.ts, connection.ts}`** (C0 binding 7/12/15 — there is NO single `rooms.ts`; the join handshake + tier gate live in `connection.ts`'s join branch, caps + player-id assignment in `roomManager.ts`, per-room state in `room.ts`; voice fan-out + roster stay in `connection.ts`). Callsign overwrite of `PlayerInfo.name` happens where `connection.ts` calls `manager.join(...)` → `room.addPlayer({id,name,color})` (C0 binding 15).
- Test: extend the Phase B headless multi-client harness (`packages/server/test/{multiclient.integration.test.ts, wsServer.test.ts, connectionCaps.test.ts}`)

**Interfaces:**
- Consumes: C1 tiers/callsigns/whitelist/OPCODES; Phase B join path + voice fan-out + presence `name` write path (C0 bindings 7, 12, 15).
- Produces:
  - Join handshake accepts `{tier, joinSecret?, requestedName?}` → replies `{peerId, callsign, tier, roomEpoch}` (Appendix B). **Tier auth:** `resident`/`spectator` require the room's join secret (provisionally `STAFF_KEY` env; C4 rebinds to ownerToken-derived HMAC); an unauthed privileged `TIER_HELLO` is **downgraded to `crowd`**, never rejected.
  - `requestedName` = curated-wordlist INDEX validated server-side (invalid → random); callsigns unique per room+day (roster ∪ day-stats ∪ guestbook via C8 buckets — roster-only until C8, noted); server **overwrites the Phase B presence `name` with the callsign at join** (spec §3 change 4).
  - Per-tier fan-out per TIER_POLICY (residents full rate; spectator full + optional `streamRate:'full'`; wisps ONE shared 5 Hz coalesced buffer — serialize once; crowd = family-specific only). **Voice frames fan out to authed resident + authed spectator only; VOICE_ROSTER (senders) = residents only.**
  - Spectator sends whitelist-filtered; idle-kick (90–120 s) for wisp/crowd; over-cap → `{downgrade}` payloads.

> Phase D note — NO Phase C action: the client heartbeat cadence here must stay under Cloudflare's ~100 s free-plan idle-WS timeout; D1's standing-world hibernation leans on this constant.

- [ ] **Step 1: Write failing harness tests:** (a) 9th resident rejected; unauthed `TIER_HELLO{tier:'resident'}` downgraded to `crowd`; 9th crowd accepted (">8 non-privileged rejected"); (b) each tier cap; (c) wisp ~5 Hz vs resident full rate; (d) same serialized buffer object to all wisps (spy); (e) crowd never receives a delta/pose; (f) wisp gets neither VOICE_ROSTER entry nor frames; authed spectator gets frames but no roster entry; (g) spectator spawn intent dropped, spectator REEL request answered; (h) idle wisp disconnected (fake timers); (i) over-cap wisp → spectatePage downgrade; (j) free-text `requestedName` never appears in the callsign; (k) 100 joins → 100 unique callsigns; (l) wisp grab intent rejected server-side.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; full suite green. **Step 5: Stage.**

---

### Task C3: Clock sync + fire-at scheduler

**Files:**
- Create: `packages/shared/src/clock.ts`; server `CLOCK_PING`→`CLOCK_PONG` handler in `packages/server/src/rooms.ts`
- Test: `packages/shared/test/clock.test.ts`

**Interfaces:**
- Consumes: C1 `OPCODES.CLOCK_PING/CLOCK_PONG` + Appendix B layouts (CLOCK_PING carries the additive `lastRttMs` field — server stores it per connection, quantized 5–10 ms, for the C4 roster; spec §5.1 footnote).
- Produces: `PingSample`, `estimateOffset(samples)` (min-RTT-filtered EMA), `serverNow(offsetMs, localNow)`, `scheduleAt(fireAtServerTime, offsetMs, latePolicy: 'fireNow'|'skip', cb, timer?)`; client helper re-samples on `visibilitychange` **and every ~10 s on resident/spectator clients** (spec §5.3 — keeps offsets and rttMs live).
- [ ] **Step 1: Write failing tests** (fake timers, injected TimerApi): symmetric samples → offset ±1 ms; constructed asymmetric-jitter set where naive mean errs > 20 ms but filtered errs < 5 ms; `scheduleAt` past-deadline honors both late policies + a roomEpoch-relative fireAt case; cancel; periodic re-sample fires on schedule.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement pure. **Step 4:** Run → PASS. **Step 5: Stage.**

---

### Task C4: Rooms, staff auth, security

**Files:**
- Create: `packages/server/src/auth.ts`; wire into server HTTP + join path
- Test: harness + `packages/server/test/auth.test.ts`

**Interfaces:**
- Consumes: C1 tiers + DIRECTOR_KIND, C2 handshake + provisional join secret, C3 rttMs store.
- Produces:
  - `POST /api/rooms` → `{roomId, ownerToken}`; per-IP rate limit + global active-room cap + TTL eviction of never-joined/empty rooms; token hash + **epoch** persisted beside the room file; constant-time compare; failed-auth limiter per (IP, roomId) with exponential backoff.
  - **Join secret = `HMAC(ownerToken, roomId + epoch)`** (spec §5.4) — rebinds C2's provisional secret. **ownerToken grants `DIRECTOR_CMD` on ANY tier.**
  - Incident controls per spec §5.4: `ROTATE_SECRET` (primary — bumps epoch, old staff URLs downgrade to crowd, permalinks untouched), `DOOR_CLOSE` (pauses NEW joins except authed resident/spectator), `ROTATE_LINK` (confirm-twice last resort; old id serves a static "check the club Discord for this world's new home" page that never discloses/forwards the new roomId).
  - Roster entries carry provenance `{entryRoute, joinedAt}` + `rttMs?` (rebroadcast ≤1 Hz on material change, director+spectator tiers only). Mute = drop senderId's 0x1x at fan-out; kick = disconnect (UI copy in C10).

> Phase D note — NO Phase C action: §10's permalink promise assumes the booth room outlives TTL eviction — the C23 runbook post-event step verifies the deployed TTL config spares the booth roomId; Phase D formalizes this as a `standing` room flag.

- [ ] **Step 1: Write failing tests:** distinct token per room; K rapid creations from one source → 429; empty room GC'd after TTL; bad-token join → not director + (IP, roomId) backoff; `DIRECTOR_CMD` rejected from an unauthed resident, accepted from a spectator carrying ownerToken; **ROTATE_SECRET: post-rotation the old secret downgrades to crowd, a re-issued bookmark joins as resident, public wisp/crowd joins and the permalink are unaffected, epoch survives restart**; DOOR_CLOSE: new wisp refused (downgrade payload) while an authed resident still joins; ROTATE_LINK: old-id response contains no new-room identifier and joins on it fail; muted peer's frames not fanned; token survives restart.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5: Stage.**

---

### Task C5: Cue engine + RoomTimeline + PHASE_STATE + RESET + pacing table

**Files:**
- Create: `packages/shared/src/cues.ts`, `packages/server/src/timeline.ts`
- Modify: **`packages/server/src/serverWorld.ts`** (C0 binding 2 — the authoritative eviction path; the existing `spawn()` already evicts the oldest UNGRABBED shape, so C5 adds the PINNED-skip + `pin()`/`unpin()` here) — the §6.4 eviction invariant lands HERE; `RoomHandle.store` wraps `ServerWorld` (there is no server-side "ShapeStore" class — that name is the CLIENT `world.ts`).
- Test: `packages/shared/test/cues.test.ts`, harness

**Interfaces:**
- Consumes: C1 OPCODES/kinds, C4 director gate, C8 buckets (RESET isolation — wire when C8 lands).
- Produces:
  - `type Phase = 'ATTRACT'|'LOBBY'|'PLAY'|'OVERLOAD'|'FINALE'|'STATS'|'RESET'`
  - **`interface RoomHandle { store: ShapeStore; setBaseParams(p: PhysicsParams): void; setCueOverlay(p: Partial<PhysicsParams>, revertAfterMs: number): void; broadcast(opcode, payload, tiers?): void; timeline: RoomTimeline; roster(): PeerInfo[]; humanResidents(): PeerInfo[]; pin(shapeId): void; unpin(shapeId): void }`** — the parameter every cue handler receives (exact members reconciled in C0). `humanResidents()` excludes `synthetic` peers (consumed by §7.17; identical to `roster()` filtered until then).
  - `interface Cue { id, label, tab: 'show'|'advanced', destructive?, cooldownMs, phases: Phase[], comfortCost, run(room: RoomHandle) }`
  - `class CueRegistry { register/unregister; catalog(); fire(id, cueInstanceId): 'ok'|'cooldown'|'deduped'|'wrongPhase'|'unknown' }` — `CUE_CATALOG` re-broadcast to director tier on registry change (capability-gated cues, §7.21).
  - `class RoomTimeline` — complete transition table: ATTRACT indefinite, exits via `advance()` on first **human** resident join; timed phases auto-advance: **`export const PHASE_DURATIONS_MS = {LOBBY: 45_000, PLAY: 180_000, OVERLOAD: 30_000, FINALE: 90_000, STATS: 30_000, RESET: 10_000}`** (RUN_OF_SHOW.md cites this constant by name); `advance()` override; `hold(ms)`; an active showpiece/encore holds phase advance until its END event or a hard cap.
  - `PHASE_STATE {phase, endsAt, remainingMs}` at 1 Hz + on change.
  - **RESET handler**: despawn world shapes, revert base AND overlay to `DEFAULT_PARAMS`, respawn the curated showroom baseline (authored seed list in shared constants), `metrics.count('rotation')`; world persistence never captures mid-showpiece forces.
  - **§6.4 eviction invariant (owned here, spec §3 change 2):** `MAX_SHAPES` recycle-oldest and every eviction path skip `grabbedBy !== null` and pinned bodies; `pin()`/`unpin()` implemented in the store/rooms module. C10 (shape-rain) and C16 (siege) exercise it; they never implement it.
  - **Pacing table** (data): PLAY = one ambient cue ≈ every 90 s (cooldowns + per-rotation comfortBudget; aggressive cues blocked in PLAY's first 60 s); **ATTRACT = continuous ambient cueing, comfort-free cues only, cooldown-aware rotation that tolerates a 2-cue catalog without stalling** *(verified)*. Tier 6 cues never enter this table.
- [ ] **Step 1: Write failing tests:** full rotation in fake time hits all 7 phases and loops (ATTRACT exits on simulated human join; synthetic join does NOT advance); `hold` extends; showpiece-active holds FINALE until END; `fire` returns each of the 5 values under the right conditions; pacing respects comfort budget + first-60 s gate AND fires continuously during ATTRACT with a 2-cue catalog; after RESET the world equals the showroom baseline while guestbook/day-stats buckets are untouched; catalog marks destructive cues; CUE_CATALOG re-broadcasts on register/unregister; **eviction invariant: at MAX_SHAPES, spawning evicts the oldest UNGRABBED UNPINNED body — a grabbed and a pinned body both survive**.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement pure; host in server loop. **Step 4:** Run → PASS. **Step 5: Stage.**

---

### Task C6: PhysicsParams + containment (the shared-core change)

**Files:**
- Modify: `packages/shared/src/physicsCore.ts` (+ its server call site)
- Test: extend `packages/shared/test/physicsCore.test.ts`

**Interfaces:**
- Consumes: as-built `stepBody` (C0 binding 1).
- Produces (spec §5.6): `PhysicsParams` (incl. `suspendDespawn`), **`DEFAULT_PARAMS` with INERT bounds** (`softSphereR: Infinity, speedCap: Infinity`, `suspendDespawn: false`), **`DIAL_BOUNDS = { softSphereR: 18, speedCap: 30 }`**, `mergeParams(base, overlay)`, `stepBody(body, dt, params = DEFAULT_PARAMS)` (freeze short-circuits; clamps per spec; ceiling rest plane; soft-sphere clamp+bounce; despawn skipped iff `suspendDespawn`), `applyRadialImpulse(bodies, epicenter, magnitude, seed)`.
- [ ] **Step 1: Write failing tests:** parity — 1000 random bodies (incl. beyond r=18, faster than 30 m/s) × 100 steps with DEFAULT_PARAMS bit-identical to pre-change goldens (capture BEFORE modifying), **including bodies past r=50 still reporting `removed: true`**; `suspendDespawn: true` → `removed: false` beyond REMOVE_DISTANCE; freeze bit-exact conservation; flip + ceilingY + DIAL_BOUNDS: rises, rests on ceiling, never removed; wind; attractor stable orbit 10 s; speedCap under detonation; bodies inside softSphereR after impulse + 5 s; release-during-freeze banks velocity; two grab claims during freeze arbitrate first-claim-wins (harness); `mergeParams` field-wise overlay-wins + identity on null; impulse goldens.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; Phase B harness green. **Step 5: Stage.**

---

### Task C7: Phone funnel (code-split entries) + exit screen

**Files:**
- Create: `packages/client/src/funnel/{index.html,ballot.ts,crowd.ts,wisp.ts,exit.ts}` (separate Vite entry chunks); `tools/check-bundle-size.mjs`; root script `"size"`
- Test: `packages/client/test/funnel.test.ts` (jsdom) + the size script

**Interfaces:**
- Consumes: C1 tiers/wordlist, C2 handshake, C3 clock helper.
- Produces: `/r/:roomId` funnel (DOM-only): ballot/crowd path joins with zero permissions (< 100 KB gz); wisp path = **callsign picker (~6 server-offered curated-wordlist options — never a free-text field)** + color picker, WS join before 3D lazy-load (< 300 KB gz initial); a WATCH option routes to the `audience` viewer when C25 lands (`?watch` param; until then it shows the live-room entry choices); Screen Wake Lock; `exit.ts`: callsign, glyph line, club Discord QR slot, room permalink ("this world stays online — your glyph is part of it") with the LAN-mode copy variant ("the world goes online tonight — same link"). `joinRoom(tier, opts): Promise<{peerId, callsign, roomEpoch}>` shared by all entries.
- [ ] **Step 1: Write failing tests (jsdom):** ballot entry joins (mock WS) without importing `three` (build-graph assertion); wisp entry emits `joined` before the 3D dynamic import resolves; wisp picker renders only server-offered options (no text input element); exit screen renders callsign + permalink + swaps copy on the LAN flag.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement + multi-entry Vite config + size script (fails over budget). **Step 4:** Tests + build + `npm run size` → PASS. **Step 5: Stage.**

---

### Task C8: Persistence buckets + metrics + preflight/runbook skeleton

**Files:**
- Create: `packages/server/src/buckets.ts`, `packages/server/src/metrics.ts`, `tools/preflight/index.html` (+ `/api/preflight`), `docs/booth/RUNBOOK.md` (skeleton), `docs/booth/BUDGET_LEDGER.md` (**skeleton — the ledger is a Tier 0 deliverable per spec §13; Tier 6 tasks append their declared rows to it and C22 records the measured numbers**)
- Test: `packages/server/test/buckets.test.ts`, `packages/server/test/metrics.test.ts`

**Interfaces:**
- Produces: **`getBucket(name: 'world'|'guestbook'|'dayStats')`** with spec §6.4 reset semantics; `metrics.count(event: 'scan'|'join'|'glyph'|'vote'|'rotation'|'showpiece', tier?)` (synthetic peers excluded or keyed separately — §7.17; **the union gains `'clip'` with C31 and the gauge set gains `'peakWatchers'` with C25 — conditional keys, noted here so the export schema anticipates them**), `metrics.gauge('peakConcurrent', n)` sampled in the room tick, `exportDay()` (JSON, counters only); preflight page (LAN + tunnel reachability, cert days, WS RTT, autoplay, mic/speaker policy, per-check green/red + LAN/tunnel mode flag). Rebind C2's callsign-uniqueness and C5's RESET-isolation tests to real buckets.

> Phase D note — NO Phase C action: the bucket name union will gain `'league'` in Phase D — keep the union in one place.

- [ ] **Step 1: Write failing tests:** bucket reset semantics (world resets; guestbook survives; dayStats until day close); counters per tier; peak gauge; export schema counts-only; day reset zeroes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; wire `count('join')` into C2 + `count('scan')` funnel beacon. **Step 4:** Run → PASS. **Step 5: Stage.**

---

### Task C9: F1 Neon Director — stage client + shot brain + overlays + mixer

**Files:**
- Create: `packages/shared/src/stageBrain.ts`, `packages/client/src/stage/{stage.ts,overlays.ts,mixer.ts}` (`?mode=stage`)
- Test: `packages/shared/test/stageBrain.test.ts`, `packages/client/test/mixer.test.ts`

**Interfaces:**
- Consumes: C2 spectator tier (stage connection carries ownerToken per C4), C0 binding 14, C5 PHASE_STATE.
- Produces:
  - **`type RoomEvent`** (defined here from the C0 binding; consumed by C13/C21/C26).
  - `type Shot = { kind: 'FOLLOW_THROW'|'WIDE_ESTABLISH'|'JOIN_CRANE'|'GLYPH_BIRTH', targetId?, sinceMs }`
  - `class StageBrain { constructor(cfg: {minShotMs, heatThreshold}); feed(e); update(dtMs): Shot; force(shot, holdMs): void }` — v1 = 3 conservative hard-cut rules (FOLLOW_THROW damped-lookahead / WIDE_ESTABLISH dead-air default + QR CTA / JOIN_CRANE); hysteresis + min-shot invariants. (C26 later adds the `fame` tiebreak — the determinism test treats fame bumps as ordinary input events.)
  - **`stage.requestShot(shot, holdMs)`** external hook (C12 GLYPH_BIRTH, C16 crystal cam, C17 worm's-eye, C32 POWERS framing).
  - **Staff hotkeys 1–9/0** force shots/targets, overriding the brain until release/timeout; brain resumes with invariants intact.
  - **`mixer.ts`** — spec §6.2 priority-ducking mixer: `register(source: AudioNode, priority: 1|2|3|4|5)`; higher ducks lower via gain ramps; room voice permanently excluded; exposes a master-bus GainNode (tapped by C31).
  - Overlays: lower-thirds (callsign + color + pattern), ambient ticker, docked static-geometry QR, "N PLAYERS — 1 WORLD — 1 SOCKET" counter (§14-gated), **overlay slot priority: replay chrome > cue banner > caster caption > ambient ticker**; 5-meter type.
  - Kiosk: WS auto-reconnect, render-stall auto-reload, public-join-URL health check → "ask staff" card. Governor: 1080p internal cap, half-res bloom.

> Phase D note — NO Phase C action: D3's hallway kiosk adds `webglcontextlost` → reload as a watchdog trigger; the reload-not-restore semantics live here when Phase D lands.

- [ ] **Step 1: Write failing tests:** (brain) FOLLOW_THROW on velocity spike; min-shot under spam; WIDE_ESTABLISH on silence; JOIN_CRANE then fallback; `force()` wins + invariants on resume; determinism. (mixer) priority-1 source ducks 2–5 (mocked AudioContext gains); a voice-tagged source is refused; master-bus node exists.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: cuts + overlays + hotkey override + QR health-swap. **Step 5: Stage.**

---

### Task C10: F2 Showrunner — console + seed cues + stats card

**Files:**
- Create: `packages/client/src/director/console.ts` (`?mode=director`), `packages/server/src/dials.ts` (**containing ONLY the two seed cues** — C11 expands it)
- Modify: `packages/client/src/envTheme.ts` (create if absent) + client audio module — countdown red-pulse + klaxon cue handlers
- Test: harness + `packages/shared/test/cues.test.ts` extensions

**Interfaces:**
- Consumes: C4 auth + provenance + rttMs roster, C5 RoomHandle/CueRegistry/RoomTimeline, C6 params, C8 metrics + buckets.
- Produces:
  - Console: renders `CUE_CATALOG` (SHOW tab: Next Phase / Fire Finale / Hold+60 s + roster; Advanced tab: everything else; destructive cues confirm; `wrongPhase`/`cooldown` = disabled states); roster rows show tier + provenance (+ rttMs) and per-peer mute / "disconnect"; **panic key on console + stage hotkey** (server handler lands in C12; trigger wiring HERE).
  - Dual surface (laptop hotkeys Space/F/H/R primary; staff phone stateless resume + Wake Lock).
  - **Two seed cues, built once in final form *(verified — v2 cue-bank collapse)*:** `shape-rain` (budgeted spawn burst via RoomHandle.store, exercising C5's §6.4 eviction invariant, comfort-free — ATTRACT's workhorse) and `low-g` (bare overlay carrying DIAL_BOUNDS + `suspendDespawn: true` with timed auto-revert — exactly its final C11 form). **No other cues in C10; no id migrations ever.** **Overlay-host split *(verified)*:** C10 implements the minimal single-overlay host (apply one overlay over an implicit base = `DEFAULT_PARAMS`, timed revert); C11 extends it to the two-layer `baseParams`/`cueOverlay` state with revert-to-base — FAQ 4 states this split.
  - STATS phase `STATS_CARD` (server-computed; callsigns only; "NEXT IN THE HEADSET?" queue bridge); day-leaderboard via `getBucket('dayStats')`. In-headset countdown = environmental red pulse + klaxon; numeric only on stage.
- [ ] **Step 1: Write failing tests:** seed shape-rain spawns via RoomHandle.store respecting MAX_SHAPES/eviction invariant and is comfort-free; seed low-g applies DIAL_BOUNDS overlay + auto-reverts (fake time); **console destructive-confirm + disabled-state rendering tested via harness-registered STUB cues (a synthetic destructive cue + synthetic wrongPhase/cooldown cues)** *(verified — the compound bank isn't built yet)*; STATS_CARD carries callsigns never raw names; day-leaderboard survives restart; double-fire same `cueInstanceId` fires once; mute/disconnect round-trip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: full rotation, console kill/rejoin resumes. **Step 5: Stage.**

---

### Task C11: F3 Reality Dials — the compound cue bank (built once) + params layering + ENV_STATE + banner

**Files:**
- Modify: `packages/server/src/dials.ts` (expand — creation stays in C10), `packages/client/src/envTheme.ts` (cosmetic tweens), `packages/client/src/stage/overlays.ts` (cue banner), **the client render/animate path (C0 binding: `packages/client/src/shapes.ts` `updateShapeRender(shape, delta)` does `rotation += rotSpeed*delta`; `packages/client/src/main.ts` gameLoop advances `bobPhase += delta*2` — the freeze render-pause gates BOTH)**
- Test: `packages/server/test/dials.test.ts` + `packages/client/test/freezePause.test.ts` + harness

**Interfaces:**
- Consumes: C5 RoomHandle, C6 params/DIAL_BOUNDS/mergeParams, C3 clock, C9 overlays, C10 seed cues.
- Produces:
  - **Params layering host:** room state holds `baseParams` + timed `cueOverlay`; loop steps with `mergeParams`; **auto-revert pops the overlay to `baseParams` — never to DEFAULT_PARAMS**.
  - **Six new compound cues + the two adopted seeds (unchanged ids)** *(verified)*: GRAVITY-FLIP (ceilingY; rain-down revert), BULLET-TIME ×0.25 (kinetic pre-roll auto-launch under energy threshold), TIME-FREEZE (burst → 1.5 s chaos → freeze; 5–8 s cap), NEON-STORM (held shapes exempt), SINGULARITY, SUPERNOVA drop script (destructive-flagged — the confirm-flow's real cue). All envelopes carry DIAL_BOUNDS + `suspendDespawn: true`. **Phase scoping *(verified — the finale must stay fireable under cuts)*:** the ambient overlay-writing dials exclude OVERLOAD/FINALE (the §7.16 contention guard); **SUPERNOVA includes FINALE in its `phases` and carries the showpiece-active guard instead — SUPERNOVA IS "the built-in finale cue"** that RUN_OF_SHOW and C24 reference when C19 is cut.
  - `ENV_STATE {serverTimestamp, mode, params, endsAt}` + snapshot inclusion; stage cue banner (hard deliverable).
  - **Client freeze render-pause (owned HERE — Tier 1, so TIME-FREEZE has it even if the Workshop is cut):** while `effectiveParams.freeze` is active, clients skip autonomous rotation + bob advance (gate `shapes.ts updateShapeRender`'s `rotation += rotSpeed*delta` AND `main.ts` gameLoop's `bobPhase += delta*2` — C0 binding 10/11 area, both named in this task's Files). Test: frozen ENV_STATE ⇒ rotation/bobPhase unchanged over simulated frames. `npm run size` joins this task's verify step (packages/client touched).
- [ ] **Step 1: Write failing tests:** each cue's envelope over fake time — apply → hold → **revert to the ACTIVE BASE (an elected law survives a dial firing)**; kinetic pre-roll only under threshold; freeze ≤ 8 s; held shape never evicted by storm; **every cue id in the catalog is registered exactly once** (subsumes one-gravity-flip); SUPERNOVA destructive-flagged AND fireable in FINALE (refused only while a siege/encore overlay is live); ambient dial fired during OVERLOAD → `wrongPhase`; late-join snapshot carries active ENV_STATE + endsAt.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: fire each cue; banner; grid never moves. **Step 5: Stage.**

---

### Task C12: F13 Neon Guestbook

**Files:**
- Create: `packages/shared/src/glyphs.ts`, `packages/client/src/glyphRender.ts`
- Modify: `packages/client/src/funnel/crowd.ts` (scribe mode), **`packages/server/src/{room.ts,connection.ts}`** (glyph handling — NOT `rooms.ts`; per C0 binding 7 that module set is the join/intent path), `packages/client/src/stage/{stage.ts,attract.ts if present}` (birth moment via `requestShot`), **headset HUD toast module — C0 CONFIRMS none exists; CREATE it (a small in-headset toast panel)** (per C0 binding 11)
- Test: `packages/shared/test/glyphs.test.ts`, harness

**Interfaces:**
- Consumes: C2 crowd tier (ephemeral guests), C1 callsigns, C7 funnel, C8 buckets + `count('glyph')`, C9 `requestShot` + Shot kind `GLYPH_BIRTH`, C10 panic-key trigger.
- Produces: `resampleStroke(≤32)`, `validateGlyph`, `spiralSlot` (deterministic shell outside play volume); server `GLYPH_ADD` → validate → id + slot + callsign → guestbook bucket (512 cap evict-oldest; never wiped by world RESET) → broadcast + ack `{callsign, ring}`; `count('glyph')`. Rate limiting: localStorage token + server-wide inflow token bucket (overflow queued) + lifetime cap 3; NEVER per-IP. Rendering per spec §6.5 (Quest nearest 32–48 batch + impostors; stage full fidelity; chunked backfill). Moderation: staff despawn cue; approval-queue flag; **panic-key server handler** (hide newest N + all name surfaces incl. caster captions when landed). Pre-seed 50 authored glyphs. Birth moment: attract `requestShot(GLYPH_BIRTH, 5000)` + crystallize + lower-third + chord; in-rotation HUD toast + 3 s stage highlight. Phone: live kaleidoscope preview.

> Phase D note — NO Phase C action: Phase D's exit.ts greeting will persist the `{callsign, ring}` ack — do not add localStorage persistence now.

- [ ] **Step 1: Write failing tests:** resample/validate/spiral determinism; inflow bucket queues overflow; lifetime cap; evict-oldest at 512; guestbook survives world RESET (real buckets); ephemeral guest never counts against resident cap; panic key hides newest N.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: phone draw → mandala on desktop + stage flies to it. **Step 5: Stage.**

---

### Task C13: F10 Ghost Arcade — recorder + reels + attract + theme synth

**Files:**
- Create: `packages/shared/src/reels.ts`, `packages/server/src/recorder.ts`, `packages/client/src/stage/attract.ts`, `packages/shared/src/music/beatClock.ts`, `packages/client/src/music/themeSynth.ts`
- Modify: `packages/client/src/stage/overlays.ts`
- Test: `packages/shared/test/reels.test.ts`, `packages/shared/test/music.test.ts` (beatClock part), harness

**Interfaces:**
- Consumes: **C0 Step 3 injectable interpolator (`createInterpolator({source, now})` in `client/src/net/interpolation.ts` — FROZEN; feed reels via a `StateSource` adapter, NOT by extending the signature) + snapshot serializer (C0 binding 5: `Room.snapshotFor(playerId)` in `server/src/room.ts` returns the `welcome` payload; `Room.worldShapes` exposes `NetShape[]`)**, C2 tiers + activity signals, C9 stage shell + mixer + RoomEvent, C5 ATTRACT phase.
- Produces: `coalesceFrame` (last-write-wins continuous; lossless union discrete; {tick, wallTime} stamps; keyframes at segment start + ~10 s; crossfade loop); recorder tee with **record-time sanitization** (identity opcodes anonymized, ALL 0x1x excluded — test-enforced; the `synthetic` presence flag is PRESERVED, §7.17) + rolling caps + auto-banker (score by events/s + shapes + players; **daemon-heavy windows down-ranked, never excluded**); **`beatClock.ts`** (pure logical-BPM clock — created HERE for attract choreography; C18 extends); **`themeSynth.ts`** (2-osc drone + attract loop, driven by beatClock, registered with the C9 mixer at priority 4); `attract.ts`: **activity-based idle detection over HUMAN intents/poses only** (never connection count; synthetic-blind per §7.17), reel fetch over WS, replay through injected-source interpolator at 70 % opacity + GHOST_XX nameplates, dissolve on first meaningful human activity, `REQUEST_SNAPSHOT` resync, day-one scripted shape-ballet, venue-brightness toggle, standalone windowed rung.
- [ ] **Step 1: Write failing tests:** coalesced replay reproduces the IDENTICAL final ShapeStore state as full-rate (keystone); reel bytes contain no voice opcodes and no name strings but DO preserve the synthetic flag; keyframe cadence; auto-banker picks highest-scoring window and down-ranks daemon-heavy ones; attract triggers on human-activity silence despite zombie connections AND despite an active daemon; attract→live resync converges; beatClock determinism.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: record → empty room → ghosts + QR; zero-reel ballet. **Step 5: Stage.**

---

### Task C14: F4 Wisp Protocol

**Files:**
- Create: `packages/shared/src/wisps.ts`, `packages/client/src/wisps.ts`
- Modify: `packages/client/src/funnel/wisp.ts`, `packages/server/src/rooms.ts` (pulse validation)
- Test: `packages/shared/test/wisps.test.ts`, `packages/client/test/wispRender.test.ts` (jsdom), harness

**Interfaces:**
- Consumes: C2 wisp tier, C6 params, C7 funnel (callsign picker), C1 callsigns + Appendix B WISP_POSE, C9 JOIN_CRANE + overlays.
- Produces: `allocateSlot(slots, headsetFrustum, stageDir)` (frustum + stage bias), `WISP_DRAW_CALL_BUDGET = 4`, pulse token-bucket constants; `WISP_PULSE` server-validated (2/s bucket, clamped impulse) with unclamped feedback (tracer + 300 ms flash + shockwave); join fanfare; Quest renderer = ONE InstancedMesh + ONE nameplate atlas, zero lights; aim = touch-drag + auto-aim default, gyro progressive enhancement (camera-relative, double-tap recenter, event-gated ≤ 1 s post-grant, `requestPermission()` in the tap handler); slot recycling; over-cap spectate page with queue position.
- [ ] **Step 1: Write failing tests:** slot allocator determinism + frustum bias; 3rd pulse in 1 s rejected; impulse clamped regardless of client magnitude; 24 wisps at max rate never exceed budgets or drop a tick; **structural render test: 24 wisps against a stubbed scene add ≤ WISP_DRAW_CALL_BUDGET renderable objects and zero Lights**; WISP_POSE golden round-trip (Appendix B).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (wisp < 300 KB gz initial); manual: phone-window join < 10 s → wisp + fanfare. **Step 5: Stage.**

---

### Task C15: F5 Reality Referendum

**Files:**
- Create: `packages/shared/src/elections.ts`
- Modify: `packages/client/src/funnel/ballot.ts`, `packages/server/src/timeline.ts` (election host), `packages/client/src/stage/overlays.ts` (tally)
- Test: `packages/shared/test/elections.test.ts`, harness

**Interfaces:**
- Consumes: C11 dials + params layering (hard prerequisite), C5 cues/pacing, C2 crowd tier, C8 `count('vote')`, C9 stage.
- Produces: `electionReducer` (open → tally → enact → cooldown; tie → re-open); options = dial cue ids ONLY (theme options registered by C20); enactments write `baseParams` via RoomHandle; adaptive cadence 45–90 s (deadline auto-shortens < 4 voters); never-dead ballot (laws-in-effect from `baseParams` + charge-next meter, interactive ≤ 2 s); legibility floor (auto-top-up 20–30 shapes; first change ≤ 300 ms; cascade after); `VOTE_TALLY` 2 Hz; stage bars + takeover + "THE CROWD DECREED"; phase-gated curation; staff REVERT/VETO restores previous `baseParams`; localStorage token (best-effort).
- [ ] **Step 1: Write failing tests:** reducer full cycle + tie + cooldown; one switchable vote per token; adaptive deadline; enactment writes baseParams and tops up shapes first (spy order); **a dial fired during a standing law reverts to the law; ballot laws-in-effect reflect base not overlay; staff REVERT restores pre-enactment params**; crowd at cap casting ballots — tally correct, egress within budget.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; **`npm run size` green (ballot < 100 KB)**; manual: two phone windows vote → bars + enactment. **Step 5: Stage.**

---

### Task C16: F6 Meteor Siege

**Files:**
- Create: `packages/server/src/siege.ts`
- Modify: `packages/client/src/funnel/crowd.ts` (slingshot UI), `packages/client/src/stage/stage.ts` (crystal cam via `requestShot`), **client intent/net layer + controllers (C0 binding 13: grab construction is `net/netClient.ts` `onLocalStoreEvent` grab/release; input in `controllers.ts`) — add grab-intent `clientTimestamp`, predict-attach + rollback, catch-assist flag; server siege lives in the new `server/src/siege.ts` + the C0 join/intent module set (not `rooms.ts`)**
- Test: `packages/server/test/siege.test.ts`, harness

**Interfaces:**
- Consumes: C2 tiers, C5 cues + `hold()` + `pin`/`unpin`, C6 physics, C14 aim machinery, C1 callsigns, C8 `count('showpiece')`, C9 `requestShot`.
- Produces: siege mode (pinned crystal, HP by participant count; **auto-armed in OVERLOAD extends via `hold(60_000)`; full 90 s = FINALE/staff-armed**; self-terminating; `count('showpiece')` on arm); `MET_LAUNCH` (1/3 s ring) → server-spawned arcing meteors (6–8 m/s cap, per-launcher colors, zero lights; **eviction honors §6.4: skip grabbed + pinned**); lag-compensated catches (~300 ms rewind ring; client timestamps; ~0.5 m radius; predict + rollback; catch-assist); `MET_HIT` plausibility-checked swat (cut if over budget); built-in crystal cam + oversized HP bar + callout queue (1/2 s; catches > throwbacks > swats > hits — owns showpiece narration per §7.15); end card top-3 callsigns → STATS_CARD + queue bridge; auto-arm ≥ N phones or idle timer; no-uplink barrage rung.
- [ ] **Step 1: Write failing tests:** rewind catch validation (100 ms-latency catch: naive rejects, rewind accepts); grab intent round-trips `clientTimestamp`; meteor speed cap; **defender holding a meteor + pinned crystal survive 24 launchers at max rate; cap holds**; callout rate/priority; HP scaling; OVERLOAD auto-arm extends via hold (fake time); 90 s self-termination; **late-joiner mid-siege receives SHOWPIECE state + coherent HP**; barrage with zero phones.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; **`npm run size` green (crowd < 100 KB)**; manual: 3 phone windows + 1 desktop defender. **Step 5: Stage.**

---

### Task C17: F7 Titan Protocol

**Files:**
- Create: `packages/server/src/titan.ts`, `packages/shared/src/titanMath.ts`
- Modify: `packages/client/src/main.ts` (player rig — **C0 CONFIRMED there is NO rig Group today: the camera is created/positioned directly and OrbitControls binds it; CREATE the rig `Group`, parent the camera + `controllerGroups` under it, scale the rig about the floor point; XR uses `renderer.xr.getCamera()`**), remote-avatar renderer `packages/client/src/net/avatars.ts` (C0 binding 11; scale via `PlayerInfo.playerScale`), `packages/client/src/stage/stage.ts` (worm's-eye via `requestShot`)
- Test: `packages/server/test/titan.test.ts`, `packages/shared/test/titanMath.test.ts`, harness

**Interfaces:**
- Consumes: C5 cues + RoomHandle, C6 impulses, C1 `WORLD_RADIUS`, C9 `requestShot`, C14 magic-window (else cutaway card), C8 `count('showpiece')`.
- Produces: rig scale 1→5 (10 behind second button) over 1.5 s about the floor point (world-matrix poses — netcode untouched; remote avatar scale via presence `playerScale`; nameplate clamp; OrbitControls verified; fog noted); `titanMath.ts` (hand-impulse + clamps — pure); `PLAYER_SCALE` staff cue "Titanize current headset player"; one-titan invariant; 30 s auto-revert incl. disconnect; `TITAN_THROW_MAX`; **OOB recall scoped to titan-active** (server tick checks `|pos| > WORLD_RADIUS` BEFORE honoring `removed`; baseline throws keep Phase B despawn); stage worm's-eye + banner; phone vaporize beat; titan pose smoothing; denser grid LOD; environment never scales.
- [ ] **Step 1: Write failing tests:** titanMath impulse inside/outside radius + clamps; one-titan; auto-revert timeout AND disconnect; throw clamp; **titan-active OOB recall respawns while the same trajectory without titan despawns at REMOVE_DISTANCE**; presence carries playerScale to avatar-rendering tiers.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: titan run on desktop + second client + stage cut. **Step 5: Stage.**

---

### Task C18: F8 Resonora

**Files:**
- Create: `packages/shared/src/music/{quantizer,noteMap}.ts`, `packages/server/src/conductor.ts`, `packages/client/src/music/synth.ts`
- Modify: `packages/shared/src/music/beatClock.ts` (extend), `packages/client/src/stage/overlays.ts` (beat ring + note flashes)
- Test: `packages/shared/test/music.test.ts`

**Interfaces:**
- Consumes: C3 clock, C0 impactSpeed broadcast, C13 beatClock + mixer (registers at priority 3), C9 overlays, C1 Appendix B MUSIC_NOTE/CLOCK layouts.
- Produces: `noteMap` (pitch = colorIndex degree, timbre = type, octave = size, velocity = clamp(impactSpeed)); `quantizeNote` (next 16th ≥ client p95 one-way delay + margin; backward-snap ≤ 60 ms); server Conductor; local prediction (deterministic noteId; dedupe on echo; instant SFX stays the causal transient); ≤ 12 equal-power Quest voices (HRTF = voice only); stage heavy mix + Convolver; deterministic backing layer (roomSeed, beatIndex, histogram); auto-intensity governor; per-player note budgets + role split; **stage beat ring + per-note flash ON the shape at `playAtServerTime` (hard deliverable)**; **owner acceptance gate: reference mix on real hardware**.
- [ ] **Step 1: Write failing tests:** noteMap determinism + clamps; quantizer lookahead + backward-snap; noteId dedupe (predict-then-echo plays once); rate budget truncates a 50-impact burst; backing layer identical across two clients per seed; governor monotonic; MUSIC_NOTE golden round-trip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: two desktop clients jam on-key; flashes align; owner mix gate. **Step 5: Stage.**

---

### Task C19: F12 Supernova Encore

**Files:**
- Create: `packages/server/src/encore.ts`
- Modify: `packages/client/src/funnel/crowd.ts` (light rig + charge UI), `packages/client/src/stage/overlays.ts` (constellation mirror)
- Test: `packages/server/test/encore.test.ts`, harness

**Interfaces:**
- Consumes: C2 crowd tier, C3 scheduler (`fireNow` for the flash), C5 FINALE + `pin`, C6 `applyRadialImpulse`, C9 mixer (riser priority 2), C8 `count('showpiece')`, C1 Appendix B CROWD_CUE/CHARGE layouts. **Attach-if-landed hooks: `melodySource?` (C18), `themeCut?` (C20).**
- Produces: ambient `CROWD_CUE` light rig (seeded phase offsets); charge sequence (TAP primary, shake opt-in garnish behind the iOS gesture, ≤ 5/s debounce, crowd-size normalization; **max-brightness prompt at join AND CHARGE_START**); pinned orb (auto-launch 10 s); **drop timeline at `fireAtServerTime` (500 ms–1 s lead): radial impulse + seeded arp (primary audio) + synchronized single flash (≤ 3 Hz, staff disable, late = fireNow); theme hard-cut + melody replay ONLY via hooks; no-sibling fallback = room-wide palette flash via CROWD_CUE + ENV_STATE**; stage constellation mirror (complete at 5 phones); sequence ≤ 90 s; cooldown; degrade rungs (no headset → auto-detonate; no crowd → staff; no projector → phones are the display); `count('showpiece')`.
- [ ] **Step 1: Write failing tests:** charge normalization (5 vs 30 phones comparable); debounce; orb auto-launch; **drop ordering at exact fireAt: impulse + arp + flash same server tick; theme hook invoked ONLY when wired**; late-join mid-charge gets charge state; flash respects staff disable; seeded arp deterministic; orb pinned survives a spawn storm; CROWD_CUE/CHARGE golden round-trips.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; **`npm run size` green (crowd < 100 KB)**; manual: 3 phone windows charge + flash in perceptual sync; each rung exercised. **Step 5: Stage.**

---

### Task C20: F9 Reality Channels

**Files:**
- Create: `packages/shared/src/themes.ts`
- Modify: `packages/client/src/envTheme.ts`, `packages/client/src/music/themeSynth.ts` (per-theme retune), `packages/server/src/timeline.ts` (register theme options into the C15 pool), `packages/server/src/encore.ts` (wire `themeCut`)
- Test: `packages/shared/test/themes.test.ts` + manual Quest gate

**Interfaces:**
- Consumes: C11 ENV lane, C3 clock, C15 vote machinery, **C13 themeSynth (the standalone music target)**, C18 optional bar alignment.
- Produces: `ThemeDef` table — ship-gate 3 themes (+2 stretch); custom shader grid (counted work); `THEME_SET {themeId, transitionAtServerTime}`; Quest path per §6.5 (uber-shader/prewarm; baked cubemap ≤ 4 Hz; flat-gradient fallback; acceptance: first in-headset switch has no frame > 20 ms); transitions comfort-bounded; stepped-curve "bit-crush" via wet/dry gain; late THEME_SET → snap + mini-glitch; **theme-vote options registered into C15's pool** (ordinary elections — no second vote path); avatar colors exempt from LUT; stage line "N REALITIES · 0 ASSETS · 100% PROCEDURAL"; 5-meter test acceptance.
- [ ] **Step 1: Write failing tests:** ThemeDef schema completeness; helpers; transition scheduling vs offset; LUT never touches avatar channel; persistence round-trip; election pool gains theme options after registration.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual theme surf; **owner Quest pass**. **Step 5: Stage.**

---

### Task C21: F11 Chrono Snap

**Files:**
- Create: `packages/shared/src/replay.ts` (pure ring buffer + replay player — its tests already live in shared), `packages/client/src/stage/replay.ts` (thin stage adapter)
- Modify: `packages/shared/src/stageBrain.ts` (highlight scorer — **factored into shared with a reduced-signal-set subset consumable by C26; extract/reuse, never reimplement**), `packages/server/src/rooms.ts` (spectator `streamRate:'full'` if not landed in C2)
- Test: `packages/shared/test/replay.test.ts`

**Interfaces:**
- Consumes: C13 reels/keyframes + injectable interpolator, C2 spectator full-rate stream (cadence bound in C0), C0 serverTick + impactSpeed, C6 physicsCore (micro-resim), C9 stage + RoomEvent, C10 console hotkeys.
- Produces: ~30 s ring buffer (deltas/poses + ~1 s self-snapshotted keyframes); highlight scorer over REAL signals (top-decile floor slams, shape-rain bursts, long-arc throws; grab duels iff `GRAB_REJECTED`); replay: live → bloom-free ≤ 480p inset → 0.25× through the interpolator with **micro-resim of free-flight segments via shared physicsCore ("re-simulated, not recorded" is FORBIDDEN until this parity test passes — §14; segments under active dials fall back to lerp and suppress the line)** + spring-orbit camera + oversized "REPLAY // T-4.2s" chrome (must-ship) → 6 s auto-return + stinger; primary hotkey = "replay last scored highlight" (min-activity threshold); cooldowns; replay entities namespaced.
- [ ] **Step 1: Write failing tests:** seek-to-keyframe + roll-forward reconstructs state; micro-resim of a recorded parabolic flight matches endpoints within ε with ≥ 4× intermediate frames; scorer picks a constructed slam over noise and refuses under-threshold windows; shared-thresholds test (scorer subset agrees with the full scorer on what counts); namespacing (replay ids never collide with live).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; manual: hard throw → auto-replay + chrome + return. **Step 5: Stage.**

---

## Tier 6 — "The Impossible Broadcast" (C25–C32; spec §7.14–§7.21, §8 Flex rules)

*Execute after C21 and the Workshop tasks (C33–C35), before C22–C24. Cut top-down: C32 first, C25 last. Each task declares its §6.6 rung + §6.5 ledger line before build; cues are Advanced-tab/staff-only; no Tier ≤5 module imports these.*

### Task C25: F14 The Gallery — remote audience tier

**Files:**
- Modify: `packages/shared/src/tiers.ts` (**adds the `audience` member + TIER_CAPS/TIER_POLICY rows + the additive per-family receive field — exhaustiveness tests amended; existing broadcast call sites must not need editing, which is the acceptance criterion proving composition**), `packages/server/src/rooms.ts` (audience fan-out branch + backpressure + cached-keyframe late-join + per-IP caps), `packages/client/src/funnel/{index.html,exit.ts}` (`?watch` route + "share it" copy + occupancy routing), `packages/client/src/stage/stage.ts` (**`?mode=watch` viewer branch — Modify, stage.ts exists from C9**), `packages/client/src/stage/overlays.ts` (the "N WATCHING · 0 VIDEO FRAMES SENT" counter), `docs/booth/BUDGET_LEDGER.md` (append the audience egress row)
- Test: harness + `packages/client/test/funnel.test.ts` extension

**Interfaces:**
- Consumes: C1 registry (0x32 already minted), C2 fan-out + wisp buffer, C13 recorder keyframes + attract ghost playback, C9 render modules, C3 clock.
- Produces (spec §7.14, all *(verified)* mods folded): audience tier cap 128 (≤ 4 per IP + a per-IP join-attempt token bucket that also throttles cached-keyframe sends); **receive set = the §5.1 audience-row union verbatim (that cell is the single normative enumeration — includes PHASE_STATE/ENV_STATE/THEME_SET/SHOWPIECE/STATS_CARD/MUSIC_CLOCK; CASTER_LINE attach-if-landed)**; sends heartbeat + CLOCK_PING only; `metrics.gauge('peakWatchers')`; **permalink routing: `?watch` → audience-only during live occupancy (wisp/crowd entry only via the booth-QR funnel path; full entry when idle)**; **decide and record whether the audience pose subset includes hand poses (default head-only; ~+3 KB/s per viewer if taken) — consumed by C30's copy scope**; **explicit heartbeat stop on `visibilitychange: hidden`** → server drop → "paused — click to rejoin"; **backpressure**: skip sends past ~64–128 KB `bufferedAmount`, disconnect past a hard ceiling; **late-join from the recorder's most recent ~10 s keyframe + roll-forward** (zero fresh snapshot serializations — same-buffer spy test); viewer core = free-orbit + follow-a-player + counter + pause/rejoin (local auto-director = stretch behind its event-adapter parity test, §14); `AUDIENCE_STATE` 0.2 Hz; stage counter renders at N ≥ 5 only; over-cap = static "at capacity" card; ATTRACT → viewer reuses ghost playback; audience never counts as occupancy (asserted); panic-key coverage extends to this tier; LAN-day rung (cloud page detects booth-offline server-side).
- [ ] **Step 1: Write failing harness tests:** audience cap + downgrade card; audience receives the §5.1 union (incl. PHASE_STATE/ENV_STATE/THEME_SET) and NEVER a full-rate delta or voice frame; same-buffer spy across 32 simulated viewers; one stalled socket at cap → no tick overrun, others unaffected; reconnect stampede (128 simultaneous rejoins) → zero fresh snapshot serializations; **one IP opening 64 sockets → capped at 4 + keyframe sends throttled, others unaffected**; **the permalink page during occupancy exposes no wisp/crowd join**; hidden-tab: explicit pause → drop → one-tap rejoin (fake timers); panic-key hides names/glyphs on an audience client; occupancy: ATTRACT-exit and idle detection ignore audience.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (watch route within phone budgets); manual: desktop viewer orbits a live room; C22 gains the audience-at-cap soak scenario + C23 gains the doors-open Discord watch-link step + Cloudflare idle-timeout/fair-use runbook notes. **Step 5: Stage.**

---

### Task C26: F15 MC NULL — procedural caster + camera fame

**Files:**
- Create: `packages/shared/src/casterGrammar.ts`, `packages/server/src/caster.ts`
- Modify: `packages/shared/src/stageBrain.ts` (fame tiebreak — an ordinary input-event consumer; the cfg key stays `heatThreshold`, no rename churn in a Tier ≤5 module), `packages/client/src/stage/overlays.ts` (caption renderer), `packages/shared/src/protocol/opcodes.ts` (CASTER kind enum), the spec's Appendix B (CASTER_LINE row + generated golden paste-back), `docs/booth/BUDGET_LEDGER.md` (append row)
- Test: `packages/shared/test/caster.test.ts` (golden transcripts), harness

**Interfaces:**
- Consumes: C9 RoomEvent + overlays + slot priority, C21's shared highlight-scorer subset, C1 callsigns + 0x33, C5 PHASE_STATE, C8 day-stats, C10 STATS flow. **Attach-if-landed: 0x33 fan-out to audience (C25) / clip captions (C31).** Shipping target = stage-caption-only.
- Produces (spec §7.15, all mods folded): pure `casterLine(event, ctx, rng): CasterLine | null` (SILENCE default); **server host** `caster.ts` (streaks, ~3 min LRU, per-rotation quota, phase hype ladder, day-stats reads) emitting `CASTER_LINE {templateId, slots}` — indices/fixed-point only, never strings; stage renders from 0x33 (never generates; spectator whitelist untouched); **fame** (renamed from heat) is stage-local, FOLLOW_THROW tiebreak only, ≤ ~60 % shot time per resident per rotation, cleared on RESET with decay ≤ 180 s; **all caster memory rotation-scoped** (cross-rotation via day-stats only); single caption authority (showpiece-active → only `arm`/`endCard` kinds); label↔signal truth (THROW = release velocity; IMPACT = impactSpeed; superlatives only on actual record); per-line character budget + max 2 lines; panic key clears caption + suppresses + `speechSynthesis.cancel()`; caster-mute cue (Advanced); TTS = duck-shim garnish (onstart/onend ducks 3–5 fast-release; priority-1 cancels; default OFF).
- [ ] **Step 1: Write failing golden-transcript tests:** deterministic transcripts per seed; silence-on-quiet-stream; no-repeat LRU; quota; **≥ 3 variants per event kind**; the phase hype ladder (spec §7.15: a line-intensity tier keyed off PHASE_STATE selecting among variants — quota unchanged) picks calm/normal/hype variants per phase; max 1/10 s; **self-contained callsign slots (wordlist index u16 + suffix u8) render without a roster**; **two-rotation transcript never references a rotation-1 callsign after RESET unless it holds a day-stats record**; **no CASTER_LINE during SHOWPIECE except arm/endCard**; label↔signal bindings; character budget for every template; fame ≤ 60 % + rule-priority-unchanged + JOIN_CRANE/WIDE_ESTABLISH-never-starved invariants; panic + mute tests; CASTER_LINE golden round-trip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (+ club-written template variants as repo-reviewed authored copy). **Step 4:** Run → PASS; `npm run size` green; **owner acceptance: full golden-transcript read-through**; manual: captions fire on real throws, showpiece yields. **Step 5: Stage.**

---

### Task C27: F16 Siege Waves

**Files:**
- Create: `packages/shared/src/siegeWaves.ts` (**the sibling module is the requirement — "Tier 6 is cut" must leave no residue in Tier ≤5 files**)
- Modify: `packages/server/src/siege.ts` (wave advance + admission budget), `packages/client/src/stage/overlays.ts` (wave banner), `packages/shared/src/protocol/opcodes.ts` (WAVE kind), `docs/booth/BUDGET_LEDGER.md` (append row)
- Test: `packages/server/test/siege.test.ts` extensions, harness

**Interfaces:**
- Consumes: C16 siege (attach-if-landed), C11 overlay layering, C6 DIAL_BOUNDS, C5 ENV lane + `wrongPhase` path, C9 cue-banner treatment.
- Produces (spec §7.16, all mods folded): `WaveDef {name, durationMs, meteorRateMult, hpBonusMult, dialOverlay?, comfortCost}`; **meteor admission budget** (`inFlightMeteors ≤ METEOR_BUDGET ≈ 28`; WAVE 3 rateMult ≈ **0.25–0.35** server-side — at ×4 flight time admission drops proportionally; client cooldown UI untouched, zero funnel diffs); **data-driven table test:** every row satisfies `rate × mult × flightTime(timescale, gravity) ≤ budget`; bullet-time window ≤ 10–15 s inside the wave (tested invariant: no overlay with timescale < 0.5 exceeds 15 s); waves ride ENV_STATE for physics (late-join + banner for free) and `SHOWPIECE_STATE {waveIndex, waveEndsAt}` for narrative (no strings on the wire); banner = full-screen cue-banner treatment, never the callout queue; **OVERLOAD auto-armed siege runs the wave table once `hold(60_000)` engages** (the marquee fires on the zero-volunteer path); Σ durations ≤ 90 s; HP-advance only shortens; dial contention: dial `phases` exclude OVERLOAD/FINALE + showpiece-active guard for forced fires; unknown-kind-ignore asserted for 0x27.
- [ ] **Step 1: Write failing tests:** wave-table budget invariant over all rows; wave 3 window cap; dial fired mid-wave → rejected, wave overlay intact, elected law survives the siege and the between-wave pop; held meteor + pinned crystal survive a wave transition at 24-launcher max rate; late-joiner mid-wave gets coherent {waveIndex, waveEndsAt}; unknown-kind client renders a coherent siege.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (overlays.ts touched); manual: 3-wave arc with banners; C22 conditional soak gains the wave-active siege. **Step 5: Stage.**

---

### Task C28: F17 Daemon Crew

**Files:**
- Create: `packages/shared/src/daemons.ts` (behavior state machine + pose-synth, pure — consumed by C22's load generators), `packages/server/src/daemons.ts` (host + cues `summon-daemons`/`dismiss-daemons`)
- Modify: `packages/server/src/rooms.ts` (synthetic flag + evict-first + `humanResidents()` rebinds), remote-avatar renderer (drone styling + DAEMON badge — packages/client), `packages/shared/src/callsigns.ts` (DMN namespace reservation test)
- Test: `packages/server/test/daemon.test.ts`, harness

**Interfaces:**
- Consumes: C5 RoomHandle (`humanResidents()`), C2 resident tier (daemons need grab rights), C16 catch-assist (guaranteed landed), C13 recorder/attract (synthetic-blind), C8 metrics.
- Produces (spec §7.17, all mods folded): server-hosted resident-tier peers flagged `synthetic: true` through the standard join path (normal intent validation — no god-mode); fetch-and-return ONLY (chest-height offset target, 3–6 m/s arcs, C16 catch-assist on return throws; orbit-juggle/siege-defender flagged off); **synthetic-blind presence signals, all test-enforced:** ATTRACT-exit = first HUMAN join; C13 idle + auto-banker room-empty ignore daemons; metrics exclude synthetic; dismissal on RESET + humans ≥ 2 + last-human-departs; evict-first at cap; held-shape release on dismissal; grab deference (never claim near a human hand/pending claim; contested same-window grab → human wins); exclusions: VOICE_ROSTER, leaderboard/queue bridge, JOIN_CRANE (distinct "DMN-07 ONLINE" banner); reels preserve the synthetic flag (DAEMON badge on replay); **ship gate = staff/cue-summoned only; LOBBY auto-summon behind a config flag enabled after the owner acceptance pass** of the recorded fetch-and-return script on the real stage.
- [ ] **Step 1: Write failing tests:** daemon-only room enters ATTRACT on human silence; daemon join never advances the timeline; contested grab resolves to the human; daemon at cap evicted when a human joins; dismissal releases held shapes; no banked reel window is daemon-heavy-top-ranked; metrics unpolluted; DMN reserved out of the human wordlist; DMN banner ≠ JOIN_CRANE; "DMN-03 NEXT IN THE HEADSET?" impossible (queue-bridge filter).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (avatar renderer touched); **owner acceptance: recorded fetch-and-return script approved on the stage feed** (auto-summon flag stays off otherwise); C22 Step 1 consumes this chassis if landed (else the Phase B harness clients as originally planned); C23 runbook gains the daemon narration line; C24 smoke gains "daemon catch loop, if landed". **Step 5: Stage.**

---

### Task C29: F18 X-Ray Broadcast

**Files:**
- Create: `packages/client/src/stage/xray.ts`; the pure delay-FIFO message source lands in `packages/shared/src/replay.ts` (Modify — a source variant beside the ring buffer, so the shared test imports no client code)
- Modify: `packages/shared/src/protocol/opcodes.ts` (`STAGE_XRAY` kind on 0x22), `packages/server/src/auth.ts` (roster rttMs already landed via C3/C4 — verify), `packages/client/src/stage/stage.ts` (hotkey + state exclusion)
- Test: `packages/shared/test/replay.test.ts` extension (delay-shim), `packages/client/test/xray.test.ts` (state guards)

**Interfaces:**
- Consumes: C2 `streamRate:'full'`, C0 serverTick + frozen interpolator signature, C3 lastRttMs + 10 s re-sample, C4 roster rttMs, C9 hotkeys + `force()` + overlays, C21 ring buffer (soft — standalone delay-FIFO shim otherwise), C10 Advanced tab.
- Produces (spec §7.18, all mods folded): stage-LOCAL hotkey primary (console path = `STAGE_XRAY` kind); `phases: ['PLAY','ATTRACT']`, auto-revert on 60–90 s timer AND any transition into OVERLOAD/FINALE; auto-cancel while replay/attract owns the stage; split-truth rendering (raw tick-stamped dots + normal render + −300 ms ghost world via a second interpolator instance on a delay shim; ghost = shapes only; bloom off, presented as a mode switch); **diagnostics computed at the shim/source layer — the C0 interpolator signature stays frozen**; HUD strip (tick rate, snapshot age, interp buffer, rttMs chips labeled "client-reported"); **must-ship chrome:** "NETWORK X-RAY // LIVE DIAGNOSTIC FEED" + "SERVER TRUTH" / "WHAT PLAYERS SEE" / "+300 ms — WHAT LAG FEELS LIKE" banners at 5-meter scale (numeric chips close-range; explicit §7.1 exemption); brain pinned WIDE_ESTABLISH via `force()`; never auto-cued.
- [ ] **Step 1: Write failing tests:** delay-shim — delayed instance's rendered state at t ≡ live instance's state at t−300 ms on a synthetic stream; phase-guard — x-ray fired in PLAY auto-reverts on OVERLOAD transition; state exclusion — refused while a replay is airing; **ATTRACT precedence — x-ray fired during ATTRACT pauses ghost playback and attract resumes on revert** (spec §7.18).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; **owner acceptance: x-ray look approved on the actual stage laptop**; C23 runbook gains the narration line + when-to-fire note + hotkey card; C24 smoke gains the toggle. **Step 5: Stage.**

---

### Task C30: F19 Pocket DVR

**Dependency gate:** hard on C21; audience half attach-if-landed on C25. If C25 was cut, ship the stage scrub bar + wisp-tier DVR only.

**Files:**
- Modify: `packages/shared/src/replay.ts` (already shared per C21), `packages/client/src/funnel/wisp.ts` + viewer mode (scrub UI, lazy-loaded with the 3D chunk), `packages/server/src/rooms.ts` (only if Step 0 finds the decimated stream drops release events)
- Test: `packages/shared/test/replay.test.ts` extensions

**Interfaces:**
- Consumes: C21 replay module + micro-resim, C13 coalescer, C25 audience stream (attach-if-landed), C3 gap semantics, C6 effectiveParams.
- Produces (spec §7.19, all mods folded): scrub + 0.25×/1× + orbit + mandatory "REWOUND // T-6.2s" badge (frozen surface; no in-headset DVR); default 1×, 0.25× only inside resimmed ballistic segments; **resume = drain-the-buffered-ring-forward ONLY for non-spectator tiers** (client buffers while paused; jump-to-live; ring-cap eviction trims from the back; timeline shades §5.3 gaps; heartbeats continue while paused); **yield-to-live:** SHOWPIECE_START/CHARGE_START/VOTE_OPEN auto-snaps to live with a banner + ~10 s idle auto-return; stage scrub bar = secondary/Advanced (C21 hotkey stays the one-volunteer path); copy scoped to shape trajectories (catch-centric copy requires hand poses in the audience subset — an explicit C25 negotiation item).
- [ ] **Step 0 (C0-style substrate binding):** verify the decimated stream wisps/audience receive preserves release events with `{pos, vel}` (the §3 fifth field); if not, rebase that fan-out onto `reels.ts` `coalesceFrame` as a small additive server change — declared here, not discovered mid-task.
- [ ] **Step 1: Write failing tests:** **keystone — a 5 Hz-decimated synthetic throw fixture contains the release event AND micro-resim endpoint-ε passes on it ("rewind the broadcast" copy is FORBIDDEN until green — §14)**; paused client keeps buffering and resume converges to live without a server round-trip; ring-cap eviction trims scrub range; yield-to-live within one frame of SHOWPIECE_START; namespace-leak extension (scrubbed replay never leaks into live inset/scene); 60 s ring at wisp rates < ~1 MB.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (DVR lazy-loads with the wisp 3D chunk); manual: scrub on a phone window while a desktop client plays; C22 soak gains N simultaneous post-ring-wrap resumes (if C25 landed). **Step 5: Stage.**

---

### Task C31: F20 Neon Clip Machine

**Files:**
- Create: `packages/client/src/stage/clips.ts` (compositor + recorder state machine), `packages/server/src/clips.ts` (store endpoints beside C4's auth)
- Modify: `packages/shared/src/protocol/opcodes.ts` (`SAVE_CLIP` kind on 0x22), `packages/client/src/funnel/exit.ts` (clips-by-callsign line), `docs/booth/RUNBOOK.md` (sweep + sign copy)
- Test: `packages/client/test/clips.test.ts` (pure parts), `packages/server/test/clips.test.ts`

**Interfaces:**
- Consumes: C21 replay (the recording source), C9 mixer master-bus GainNode (`createMediaStreamDestination` tap), C21 scorer, C5 STATS phase, C4 hardening patterns. **Attach-if-landed: C26 caption in the compositor.**
- Produces (spec §7.20, all mods folded): **1280×720 2D compositor canvas** (per frame: drawImage(stage WebGL canvas) + canvas-drawn chyron + caster line + replay chrome + QR end-slate 2–3 s) — `captureStream(30)` runs on the COMPOSITOR (DOM overlays are never captured); **codec probe order (pure fn):** `video/mp4` (Chrome 126+ HW) → `webm;codecs=vp8,opus`@720p → vp9 only if explicitly enabled; **delivery loop:** clipId pre-minted (**≥ 128-bit random**); end-slate QR IS the retrieval URL (`GET /api/clips/:id` — per-IP GET rate limit + per-clip daily download cap, TTL day-close, sweep); `POST /api/clips` ownerToken-in-header + ~25 MB cap + per-day count cap + rate limit; `metrics.count('clip')` on delivery; STATS/RESET "TAKE YOUR CLIP HOME" card ~20 s; **auto-first:** one auto-clip per rotation at FINALE→STATS (top scored highlight; min-activity threshold; the replay airs during STATS and the recorder rides it); SAVE CLIP = stage-local hotkey override + `SAVE_CLIP` console kind; console keep/discard; no-uplink rung (bank locally; "posts to the club Discord tonight" copy; Closing Ceremony gains the post step); 9:16/any-camera re-renders = post-event batch only; WebCodecs live-ring = out of scope (§12).
- [ ] **Step 1: Write failing tests (pure parts):** codec probe order function; clip state machine (idle→recording→finalizing→delivered); server store cap/TTL/sweep + auth + **clipId entropy (≥ 128-bit) + per-IP GET rate limit + per-clip daily download cap**; compositor layout draw list includes chyron + end-slate; SAVE_CLIP kind minted in the registry.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; **manual acceptance: the produced file opens and PLAYS in a second browser with the chyron VISIBLE and an audio track present; the end-slate QR scanned from a phone downloads and plays the clip**; C22 soak conditionally includes /api/clips under load; C24 loop verifies scan-to-clip end-to-end. **Step 5: Stage.**

---

### Task C32: F21 Powers Lab (TOP of Tier 6 — cut first)

**Files:**
- Create: `packages/shared/src/tkMath.ts`, client hand-input path (per Step 0 binding), server tick force in `packages/server/src/` (own module or titan-adjacent)
- Modify: `packages/shared/src/protocol/opcodes.ts` (TK kinds), `packages/client/src/stage/{stage.ts,overlays.ts}` (POWERS shot + lower-third + tether), remote/desktop renderers (tether beam), `docs/booth/RUNBOOK.md` (Flex section), the spec's Appendix B (TK family rows + generated golden paste-back), `docs/booth/BUDGET_LEDGER.md` (append rows)
- Test: `packages/shared/test/tkMath.test.ts`, harness

**Interfaces:**
- Consumes: C5 cues + `pin`/`unpin` + CUE_CATALOG re-broadcast, C6 loop-force pattern (like titan hands — NOT a PhysicsParams change), C9 `requestShot` + overlays, Phase B grab arbitration, C22 ledger.
- Produces (spec §7.21, all mods folded): `optionalFeatures: ['hand-tracking']` (inert when unused); pinch = standard `selectstart` + 300 ms sustained-hold cone-select (no custom gesture recognition); `TK_PULL` at pose rate → server strength-capped min-radius-softened pull each tick; grab-radius conversion to Phase B first-claim-wins; release-throw from pose history; **safety rails:** ~250 ms dead-man's switch; pulled shape `pin()`ned (unpin on convert/release/timeout/RESET); cone-select excludes grabbed + pinned; ≤ 2 pulls (one per hand); one-TK-player invariant + revert-on-disconnect; per-pull speed cap; **stage beat ships inside this feature:** POWERS `requestShot` framing + "NO CONTROLLERS — CAMERA-TRACKED HANDS" lower-third + **neon tether beam** (server knows anchor + target — no joint streaming); **wearer neon skeleton hands** (instanced joints, zero lights, §6.5 sub-budget); capability gating: `TK_HANDS_STATE {available}` on `inputsourceschange` → cue registers only when (hands ∧ `POWERS_LAB_ENABLED` env) → CUE_CATALOG re-broadcast; env flag set only after the `BUDGET_LEDGER.md` row (hands + TK pull mid-flight + representative PLAY load, ≥ 72 fps, no frame > 20 ms); phases PLAY/LOBBY (never ATTRACT); ~10 min auto-revert; runbook Flex section (staff-demoed quiet-period exhibit; Quest "Hand Tracking + Auto Switch" setting; controller set-down spot; in-headset one-tap self-test reporting pass/fail to the console; Enter-VR consent note).
- [ ] **Step 0 (read-only binding — C0 stays untouched; cutting C32 is residue-free):** bind the as-built XR session-request call site, `inputsourceschange` handling, and the grab/throw anchor source; verify whether Quest Browser hands expose `gripSpace` — else anchor = wrist or middle-finger-metacarpal via `fillPoses` (throw velocity from that joint's history).
- [ ] **Step 1: Write failing tests:** tkMath pull-force + cone-select determinism + clamps; dead-man expiry; TK targeting a held/pinned shape is a no-op; contested TK-vs-human-grab → human wins at grab radius; ≤ 2 pulls; one-TK-player + disconnect revert; cue absent from CUE_CATALOG until hands reported ∧ flag set; TK kinds golden round-trip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green; **owner Quest measurement recorded in BUDGET_LEDGER.md before the env flag is documented ON**; manual: pinch-pull on hardware with the stage tether visible. **Step 5: Stage.**

---

## The Workshop — desktop view & build (C33–C35; spec §7.22–§7.23, §8 group W)

*Execute after C21 and BEFORE the Tier 6 tasks (a composed showroom benefits every Tier 6 feature). Cut after Tier 6, top-down: C35 first, C33 last. C33 is pure additive UI over verified contracts; C34/C35 are staff tooling behind the ownerToken.*

### Task C33: F22 Desktop Command — cameras + HUD + complete input map

**Files:**
- Create: `packages/client/src/desktop/{cameras.ts,input.ts,hud.ts,help.ts}`, `packages/client/src/events.ts` (**the message→RoomEvent mapping extracted from C9's stage entry — shared by stage and desktop so no stage-only code enters the main chunk**)
- Modify: the main desktop entry (`packages/client/src/main.ts` — wire the rig + HUD without regressing the Phase A mouse path), `packages/client/src/stage/stage.ts` (import the extracted events module), `packages/client/vite.config.ts` + `tools/check-bundle-size.mjs` (desktop chunk soft-budget row)
- Test: `packages/client/test/desktop.test.ts` (jsdom + pure functions), harness (resident vote)

**Interfaces:**
- Consumes: **as-built Phase A desktop bindings (C0 binding 13 — preserved verbatim: click-empty-space = spawn, drag = grab/throw, `C` = recolor, `V` = render mode)**, C5 `PHASE_STATE`, C9 `stageBrain` (shared — AUTO mode) via the extracted `events.ts`, C15 election reducer (ballot; the reducer keys on an opaque voterKey — device token on phones, peerId on residents; §5.1 resident Sends includes votes), C11 `baseParams` (laws chip), C4 roster (callsigns + tiers — **no rttMs on the desktop HUD**; that stays a director/spectator surface per §5.1).
- Produces (spec §7.22):
  - `class CameraRig { setMode('orbit'|'fly'|'follow'|'auto'): void; update(dt): void; followNext(): void }` — ORBIT = Phase A default; FLY = WASD + mouse-look + shift-fast; FOLLOW = Tab cycles residents/wisps; AUTO = shared StageBrain over `events.ts` (stage overlays stay stage-only). **XR inertness:** `update()` and the keymap are inert and the HUD hidden while `renderer.xr.isPresenting`; camera restored to a sane default on `sessionstart`.
  - `keymapToIntent(key, state): Intent | null` — pure, the normative §7.22 keymap: `T` spawn (net-new, alongside preserved click-spawn), `C` recolor (as-built), `V` render mode (as-built), `1–4` cameras, `Tab` follow, **`B` ballot**, backtick PTT, `M` mute, `?` help. Edge-triggered like the Phase A handling; as-built bindings never rebound.
  - Desktop HUD (DOM overlay): phase + countdown (extrapolated from `remainingMs`), laws-in-effect chip, roster panel (callsigns + tiers), ballot widget, showpiece/cue banner mirror, `?` help overlay rendering the full keymap.
- [ ] **Step 1: Write failing tests:** `keymapToIntent` — every §7.22 binding maps to its intent, edges fire once, unknown keys → null, **`C`/`V` map to their as-built Phase A intents (regression pin)**; camera-mode state machine — transitions + follow-cycle wrap + AUTO consumes a synthetic RoomEvent stream deterministically (reuse C9's fixtures); **XR inertness — with a mocked `isPresenting: true`, `update()` is a no-op and the HUD is hidden**; HUD (jsdom) — countdown extrapolates from `PHASE_STATE {remainingMs}` without drift, ballot widget renders VOTE_OPEN and emits one switchable VOTE_CAST, laws chip reflects a `baseParams` change; **harness — a resident VOTE_CAST reaches the reducer (one switchable vote per peerId)**.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (Phase A interactions untouched — regression-check their existing tests). **Step 4:** Run → PASS; `npm run size` green (funnel chunks unchanged; desktop chunk within its soft budget — which also bounds the headset entry); manual: two desktop windows — fly/follow/auto cameras, vote from the HUD, PTT between them; **Quest smoke: enter VR from the modified entry — no camera offset, no HUD, Phase A interactions intact**. **Step 5: Stage.**

---

### Task C34: F23 The Workshop core — BUILD ops + layouts bucket + RESET rebind

**Files:**
- Create: `packages/shared/src/layouts.ts`, `tools/import-layout.mjs` (the no-UI rung)
- Modify: `packages/shared/src/protocol/opcodes.ts` (BUILD kind enum on the C1-minted 0x35 row), `packages/server/src/rooms.ts` (BUILD capability grant + op validation + build-mode gating), `packages/server/src/buckets.ts` (union gains `'layouts'`), `packages/server/src/timeline.ts` (RESET rebind with fallback; build-mode timeline hold + auto-cue suspension), `packages/shared/src/glyphs.ts` + the C12 glyph handling in `packages/server/src/rooms.ts` (as-built — wherever the 512-cap evict-oldest landed: `seeded: true` exemption + caps), `packages/server/src/dials.ts` (the `build-mode` cue)
- Test: `packages/shared/test/layouts.test.ts`, harness

**Interfaces:**
- Consumes: C1 registry + `TimerApi`, C2 tier auth (ownerToken → BUILD on resident, per §5.1), C5 RoomHandle + RESET handler + CueRegistry + hold clause, C6 physicsCore + DIAL_BOUNDS, C8 buckets, C11 freeze render-pause (client side — owned by C11, reused here), C12 glyph pipeline.
- Produces (spec §7.23, all *(verified)* mods folded):
  - `interface Layout { name, shapes: LayoutShape[], themeId?, baseParams?, savedAt, author }` (schema normative in §7.23; `LayoutShape { type, colorIndex, renderMode, scale, position, rotation, bobPhase?, rotSpeed? }`); `validateLayout(l, isBaseline): Ok|Err` — ≤ MAX_SHAPES for play layouts, **≤ MAX_SHAPES − METEOR_BUDGET (= 12) for baselines** (cross-constant test: `baselineCap + METEOR_BUDGET ≤ MAX_SHAPES`).
  - **`settleBake(layout, params, maxIterations) → {layout, settled: boolean, warnings}`** — pure deterministic settle via shared `stepBody`; runs with `suspendDespawn: true` + DIAL_BOUNDS containment; **strips wind/freeze/attractors**; baseline bakes run under `DEFAULT_PARAMS`; unsettled at the bound → `settled: false`.
  - BUILD kinds `{SET_TRANSFORM, SPAWN_EXACT, DELETE, ACK, LAYOUT_SAVE, LAYOUT_LOAD, LAYOUT_LIST, SET_BASELINE, GLYPH_SEED}` — JSON payloads; capability-gated; **mutating kinds (SET_TRANSFORM/SPAWN_EXACT/DELETE/LAYOUT_LOAD) additionally refused unless build-mode is active** (server-side — a stale tab can never wipe a live rotation); `ACK` echoes the client `opId` with the assigned shape id (undo correlation); `LAYOUT_LOAD` destructive-flagged; layout count cap ~32 + light rate limit (C4 pattern).
  - **`build-mode` cue** (Advanced, `phases: ['ATTRACT','LOBBY']`): freeze overlay with `revertAfterMs = BUILD_SESSION_MAX_MS` (~2 h; re-fire extends; re-fire while active toggles OFF); **while active the timeline HOLDS (the §5.5 clause names build-mode) and the auto-cue playlist is suspended; overlay-writing cues are refused (the §5.6 guard names build-mode)**; exits = toggle-off, session-max, or staff-forced RESET (discards unsaved edits — the safety, not the workflow).
  - **RESET rebind:** restores the baseline layout from `getBucket('layouts')` **always under `DEFAULT_PARAMS`, ignoring `layout.baseParams`/`themeId`** (C5's params invariant unchanged; those fields apply only via explicit `LAYOUT_LOAD` as a baseParams write + THEME_SET); **falls back to the v1 shared-constants seed list when no baseline exists**. `SET_BASELINE` validates/re-bakes the layout under `DEFAULT_PARAMS`.
  - Glyph seeds: `GLYPH_SEED` bypasses the inflow bucket, marks `seeded: true`; evict-oldest skips seeded; **`SEEDED_GLYPH_CAP = 64`** (past it → refuse); all-glyphs-seeded `GLYPH_ADD` → refuse via the overflow-queue feedback; **C12's 50 pre-seeded glyphs are marked `seeded: true`**.
- [ ] **Step 1: Write failing tests:** BUILD op refused without capability, granted with ownerToken on a resident (harness); **SET_TRANSFORM/LAYOUT_LOAD sent during PLAY with the capability but no active build-mode → refused** (harness); SET_TRANSFORM round-trips an exact transform; SPAWN_EXACT → ACK carries the assigned id; LAYOUT_SAVE/LOAD round-trip; `validateLayout` rejects > 12 shapes for a baseline and > MAX_SHAPES for any layout; SET_BASELINE → RESET restores the layout at rest under DEFAULT_PARAMS even when `layout.baseParams` is non-default; **RESET falls back to the constants seed list when the bucket has no baseline**; `settleBake` deterministic; all baked bodies `grounded` on a DEFAULT_PARAMS fixture; a never-settling fixture returns `settled: false`; **build-mode: fired during PLAY → `wrongPhase`; active for > LOBBY duration → phase does NOT advance and edits survive; ambient auto-cue during build-mode → refused, freeze overlay intact; re-fire toggles off (fake timers)**; RESET during build mode exits + discards (harness); seeded glyph survives evict-oldest at 512, unseeded evicted; SEEDED_GLYPH_CAP refusal + all-seeded GLYPH_ADD refusal; layout count cap; `tools/import-layout.mjs` imports hand-written JSON (integration).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; full suite green. **Step 5: Stage.**

---

### Task C35: F23 The Workshop UI — gizmos, palette, undo, settle preview, glyph seeder

**Files:**
- Create: `packages/client/src/builder/{builder.ts,gizmos.ts,palette.ts,undo.ts,layoutPanel.ts,glyphSeeder.ts}` (`?mode=build` desktop-only entry chunk)
- Modify: `packages/client/vite.config.ts` + `tools/check-bundle-size.mjs` (builder entry chunk + soft-budget row)
- Test: `packages/client/test/builder.test.ts` (pure + jsdom)

**Interfaces:**
- Consumes: C34 BUILD ops (incl. `ACK` id echo) + Layout schema + settleBake, C33 CameraRig (orbit/fly while building), Three.js `TransformControls` (stock addon), C12 kaleidoscope canvas (reused for the seeder).
- Produces (spec §7.23):
  - Gizmo editing: `TransformControls` with grid snap 0.1 m + angle snap 15° + numeric transform inputs; click-select with outline; palette (10 types × 7 colors × 3 render modes) → `SPAWN_EXACT`; duplicate (Ctrl+D).
  - **Undo/redo:** `class OpStack { push(op, inverseOp); undo(); redo() }` — client-side inverse-op stack (~50 deep; undo emits the inverse BUILD op; server stays authoritative). **Id correlation:** undo-of-DELETE re-spawns via `SPAWN_EXACT` and remaps the stack's stale references to the new id from the `ACK` echo; the stack clears on `LAYOUT_LOAD` **and on build-mode exit/RESET**.
  - Layout manager panel: list/save/load/set-baseline/delete with confirms on destructive actions; **settle preview**: toggle runs `settleBake` locally and ghosts the settled positions; BAKE commits them via `SET_TRANSFORM`s; a `settled: false` result surfaces "did not settle" and blocks the bake.
  - Glyph seeder: kaleidoscope canvas + ring/slot placement preview → `GLYPH_SEED`.
  - Read-only fallback: without the BUILD capability the mode renders view-only with a "staff link required" notice (never a dead page).
- [ ] **Step 1: Write failing tests:** OpStack — undo emits the inverse op, redo replays, depth cap evicts oldest, `LAYOUT_LOAD` AND build-mode-exit clear it, **undo-of-DELETE remaps ids from the ACK echo (redo chain stays valid)**; snap math (0.1 m / 15° quantization, pure); palette→`SPAWN_EXACT` payload mapping; settle-preview ghosts match `settleBake` output for a fixture layout (pure) and the `settled: false` path blocks BAKE; layout panel (jsdom) confirms destructive actions; capability-absent → read-only notice rendered.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run size` green (funnel chunks unchanged; builder chunk within its soft budget); manual: compose a layout with gizmos, settle-preview + BAKE, save as baseline, trigger RESET → the built showroom returns; draw + place a seeded glyph. **Step 5: Stage.**

---

### Task C22: Integration hardening — soak + budget ledger + accessibility audit

**Files:**
- Create: `packages/server/test/soak.test.ts` (tagged `soak`, `npm run test:soak`)
- Modify: `docs/booth/BUDGET_LEDGER.md` (created as a skeleton in C8; Tier 6 rows appended by C25–C32; C22 records the measured numbers)

- [ ] **Step 1:** Write the soak harness — **mandatory core: 8 residents + crowd at cap + timeline + stage fan-out; every other subsystem joins CONDITIONALLY on its task having landed** (siege incl. the 3-wave arc if C27; wisps; recorder; conductor; elections mid-cycle; audience at cap + one stalled socket + a reconnect stampede + N post-ring-wrap DVR resumes if C25/C30; /api/clips under load if C31; daemons via the C28 chassis if landed, else Phase B harness clients; **RESET restoring a max-size Workshop baseline + seeded glyphs near cap, if C34 landed**) — 30 simulated minutes: zero tick overruns, bounded memory, per-tier egress within spec §6.5/§7 budgets.
- [ ] **Step 2:** Run → fix whatever breaks. Record measured worst-case numbers in `BUDGET_LEDGER.md` (incl. Tier 6 rows: audience egress at cap; TK/hand-joint measurements arrive via C32's owner gate).
- [ ] **Step 3:** Accessibility/attribution audit: every attribution surface (lower-thirds, wisp nameplates, meteor callouts, caster captions, tally bars, note flashes) carries callsign+pattern redundancy alongside color (spec §6.1).
- [ ] **Step 4:** Full suite + typecheck + build + `npm run size` green. **Step 5: Stage.**

---

### Task C23: Booth ops finalization

**Files:**
- Modify: `docs/booth/RUNBOOK.md`, `tools/preflight/`, `packages/client/src/funnel/exit.ts` (LAN copy wiring)
- Create: `docs/booth/CLOSING_CEREMONY.md`, `docker-compose.lan.yml`; ship `RUN_OF_SHOW.md` to `docs/booth/`

- [ ] **Step 1:** Finish preflight: LAN + tunnel reachability, cert days, WS RTT, autoplay, mic/speaker policy, stage watchdog alive, headset battery reminder; green/red per item; exposes the LAN/tunnel mode flag.
- [ ] **Step 2:** Write the runbook (ONE page): boot order, Chrome flags, QR fallback ladder, panic key, show-pacing table, A/B hygiene rotation, staff narration one-liners by LABEL (ghost reveal; C21-gated re-sim flex; "you all just wrote that"; the devtools-survivable one-socket line; + x-ray/daemon lines conditional on C29/C28), kit list (+ amended recording/clips sign copy), **pre-event checklist: record 3–5 hero-take reels via the C13 bank cue days before; compose + save the showroom baseline layout and glyph seeds via the Workshop [if C34/C35 → hand-author the constants seed list]; tether fallback ~10 clients; siege ringer in headset 1**, **doors-open step: post the watch link to club Discord + department channel (if C25)**, **post-event step: verify the deployed TTL/eviction config spared the booth roomId; LAN-day bucket export→cloud import (+ clips if C31, + layouts if C34); Discord permalink post**. Ship `RUN_OF_SHOW.md` to `docs/booth/` and **reconcile its table against the as-built `PHASE_DURATIONS_MS`**.
- [ ] **Step 3:** LAN mode: `docker-compose.lan.yml`; split-horizon DNS + DNS-01 cert steps; preflight detects mode.
- [ ] **Step 4:** Closing Ceremony script: staff cue → final Encore → attract glyph tour → day-total stats card → `metrics.exportDay()` + permalink instructions (+ clips Discord post if C31).
- [ ] **Step 5:** Full suite + typecheck + `npm run size` green (exit.ts touched). Dry-run the runbook top to bottom **from a pristine copy of the current working tree (git worktree or rsync including staged changes — a fresh clone has nothing until C24's commit)** → booth-ready; verify RUN_OF_SHOW's cited constant names against `packages/shared/src/cues.ts` as built; fix any step that fails as written. **Stage.**

---

### Task C24: Phase C gate — full verification + the single commit

- [ ] **Step 1:** `npm run lint` clean; `npm run typecheck` clean; `npm test` green; `npm run test:soak` green; `npm run -w packages/client build` + `npm run size` green; Docker images build.
- [ ] **Step 2:** Manual full-loop smoke — **exercising each subsystem that actually landed (cut tiers are skipped, not failed), following RUN_OF_SHOW's rotation table once per topology (tunnel + LAN)**: ATTRACT (ballet or reel; daemon catch loop if landed) → phone QR (scribe + ballot + wisp; watch link if landed) → LOBBY ceremony → PLAY with auto-cues (+ Resonora + replay interrupt + captions + x-ray toggle, as landed) → showpiece (Siege ± waves, or Titan) → FINALE (Encore or built-in finale cue) → STATS (+ clip QR scan-to-phone if landed) + exit screen → **RESET (restores the Workshop-built showroom baseline if C34 landed, else the constants list)** → ATTRACT. Desktop pass: one full rotation driven from a desktop resident (C33 cameras + ballot + PTT, if landed).
- [ ] **Step 3:** **Owner-verified on Quest 2 hardware:** comfort (dials/titan/theme glitches), worst-case frame budget, strap-speaker mix, full booth loop (+ Powers Lab measurement if C32 landed).
- [ ] **Step 4:** Deep `/debug` + full audit per house convention.
- [ ] **Step 5:** `git add -A`; **single commit** for the whole of Phase C; update README (features, booth quickstart, runbook pointer, Appendix A/D2 mermaid as the architecture section).

---

## Self-Review (v2, against spec v2)

- **Spec §5 chassis** → C1 (registry+kinds+goldens/tiers/callsigns/WORLD_RADIUS), C2 (tiered rooms + tier auth + roomEpoch + presence-callsign), C3 (clock + lastRttMs + 10 s re-sample), C4 (auth/ROTATE_SECRET/provenance/rttMs roster), C5 (RoomHandle incl. humanResidents/pin, cues, timeline + PHASE_DURATIONS_MS, RESET, pacing incl. ATTRACT), C6 (params, inert defaults, DIAL_BOUNDS, mergeParams), C7 (funnel + watch + exit), C8 (buckets/metrics/preflight). ✔
- **§7 features** → F1:C9 … F13:C12 (Tiers 1–5, per v1 mapping); **F14:C25, F15:C26, F16:C27, F17:C28, F18:C29, F19:C30, F20:C31, F21:C32** (Tier 6); **F22:C33, F23:C34+C35** (Workshop). ✔ Workshop dependency direction: C33 consumes Tier ≤3 contracts (C4/C5/C9/C11/C15 — safe because the cut ladder removes W before any Tier ≤5 cut); C34 consumes Tier 0–2 (all below it); C35 consumes C33/C34; cutting W strands nothing (RESET's constants fallback is preserved in C5, rebound additively by C34; the freeze render-pause lives in C11, not W). ✔
- **§8 tiers/cut ladder/Flex rules** → tier map + execution order + top-down Tier 6 cut ladder stated; Flex rules in Global Constraints + FAQ 13. ✔
- **§14 flex-line inventory** → gates referenced at C21 (re-sim), C25 (watch counter, adapter parity), C30 (rewind copy), C32 (hands lower-third), C26 (transcript gate), C20 (procedural line). ✔
- **Appendix B** → C1 goldens + markdown-extraction test; C14/C18/C19 reference rows; Tier 6 rows arrive with their tasks. **C0 resolved the Appendix B Delta-header + VOICE_FRAME templates** (delta stays JSON: `{t:'state',seq,serverTick,shapes:[{id,p,r,v,s?}]}`; voice = 7-byte LE header). **Appendix A** → **C0 annotation sweep DONE (both `<bind in C0>` cadence markers resolved to "resident full-rate = state ~15Hz @ 30Hz tick" in the ASCII + mermaid twins)**; C24 README. **Appendix D** → forward hooks at C2/C4/C8/C9/C12 as non-normative blockquotes only. ✔
- **Dependency order:** no task consumes a later task's product; Tier 6 sibling wiring is attach-if-landed throughout (0x33 fan-out, themeCut/melodySource, C26 captions in C31, C25 stream in C30); C13 creates beatClock/themeSynth for C18/C20; C21 creates shared replay for C29/C30/C31; cue bank built once (C10 seeds + C11 bank — no migrations). ✔
- **Blockers from both review rounds resolved:** tier auth (join secret; downgrade-not-reject; voice to authed only); DEFAULT_PARAMS inert; Encore standalone; C19/C20 order fixed via hooks; C6 suspendDespawn flag; RoomHandle defined; RTT mechanism real (CLOCK_PING piggyback — ws.ping forbidden); compositor canvas; caster host server-side; synthetic-blind presence; meteor admission budget; C0 interpolator signature frozen. ✔
- **Placeholder scan:** no TBDs; every test step names concrete assertions; C0 is the binding/variance mechanism; C30 Step 0 and C32 Step 0 are their own read-only binding steps so C0 stays untouched by Tier 6. ✔
