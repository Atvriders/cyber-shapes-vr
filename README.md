# Cyber Shapes VR

**A self-directing cyberpunk VR booth broadcast for Meta Quest 2 and desktop.**

At a VR booth, twenty people watch while two wear headsets — so this makes the
whole booth the product. The big screen runs a self-directing broadcast with
procedural play-by-play and instant replays. Anyone in line scans a QR and is
inside the world in ten seconds — leaving a permanent neon glyph, voting on the
laws of physics, flying as a wisp, or bombarding the headset players with
meteors. Every impact lands on-beat in a generative synthwave score, rotations
end with a crowd-charged supernova that flashes every phone in the room in the
same instant, visitors take home a clip of their own catch, anyone anywhere can
watch the live broadcast rendered from an ~8–14 KB/s data stream — and when the
booth goes quiet, ghosts of the day's best players keep playing under a
"SCAN TO ENTER THE VOID" sign.

It's built on the Phase A+B chassis: an authoritative Node server runs physics
for shared private rooms (grab/throw/spawn neon shapes, spatial voice over the
same WebSocket, room persistence, offline single-player fallback) — Phase C
("The Neon Broadcast") layers the booth show on top: tiered participation
(resident/spectator/wisp/crowd/audience), a cue/timeline engine, and 21
features across 6 cut-safe tiers plus a desktop Workshop group.

> **Honesty note (read before a demo):** most of the booth's *logic* — the
> auto-director's shot selection, the cue/timeline engine, the physics dials,
> the scorer, the caster grammar, the glyph constellation data — is built and
> unit/integration-tested. The big-screen `?mode=stage` kiosk's **3D render**
> of that logic (world shapes, avatars, meteors, titans, and the Tier 6 3D
> payoffs: x-ray split-truth, DVR rewound poses, crystal-cam, worm's-eye,
> caster/daemon visuals) is a **documented, deferred owner/hardware-wiring
> seam** — see [Owner-verified items](#owner-verified-items-hardwaredeploy)
> below. Do not claim the big screen already renders the self-directing world
> until that seam is closed and look-approved on real hardware.

## Features

Grouped by tier (spec `docs/superpowers/specs/2026-07-01-phase-c-neon-broadcast-design.md`
§7); the minimum shippable booth is Tier 0+1, every tier above is cut-safe from
the top down. 21 numbered features (F1–F21) plus the Workshop group (F22–F23).

### Tier 0 — chassis (every feature plugs into this)

- **Authoritative server + shared physics core** — 30 Hz tick, per-link private
  rooms (≤ 8 residents), Opus-over-WebSocket voice, room persistence, offline
  single-player fallback (unchanged from Phase A/B).
- **Tiered participation** — `resident` / `spectator` / `wisp` / `crowd` /
  `audience` / `director`, each with its own receive-set, join path, and caps.
- **Cue/timeline engine** (`packages/shared/src/cues.ts`) — the show's phase
  ring `ATTRACT → LOBBY → PLAY → OVERLOAD → FINALE → STATS → RESET`, the
  `CueRegistry`/`RoomHandle` every feature plugs into, and the auto-cue pacing
  table.
- **Callsigns, clock sync, HMAC join auth, PhysicsParams dial engine,
  persistence buckets, metrics/preflight, the phone funnel** — the protocol
  and ops substrate the 21 features above build on.

### Tier 1 — minimum shippable booth

- **F1 Neon Director** — the `?mode=stage` big-screen client + a deterministic
  3-rule auto-director (`stageBrain.ts`: FOLLOW_THROW / WIDE_ESTABLISH /
  JOIN_CRANE), staff hotkey overrides, kiosk auto-reconnect/reload.
- **F2 Showrunner** — the `?mode=director` staff console: phase control,
  roster (mute/kick), stats card, two-tab SHOW/Advanced cue UI.
- **F3 Reality Dials** — compound physics-law cues (GRAVITY FLIP, LOW-G, BULLET
  TIME, TIME FREEZE, NEON STORM, SINGULARITY, SUPERNOVA) with a hard-cut cue
  banner.

### Tier 2 — phones join the world

- **F4 Wisp Protocol** — phones join as a named, colored neon presence
  (`wisp` tier) with touch/gyro aim and a clamped radial-impulse pulse.
- **F5 Reality Referendum** — crowd phone elections (open → tally → enact →
  cooldown) that write standing physics laws.
- **F6 Meteor Siege** — a 90 s crowd-vs-headset showpiece: phones slingshot
  meteors, the headset player catches them with server-side lag-compensated
  rewind.

### Tier 3 — spectacle

- **F7 Titan Protocol** — a headset player's rig scales 1→5×(10×); titan hands
  apply radial impulses to nearby shapes; auto-revert + worm's-eye camera.
- **F8 Resonora** — the world is the instrument: impacts/spawns/grabs quantize
  to a beat grid and become a generative synthwave score, with a big-screen
  causality visualization (beat ring + per-note flash).
- **F9 Reality Channels** — procedural realities (3+ shipped themes: palette,
  sky, grid, music retune) switched by staff cue or an ordinary election.

### Tier 4 — the world remembers

- **F10 Ghost Arcade** — ATTRACT mode replays real recorded sessions (a
  coalescing `ReelRecorder` tee) as translucent ghosts, never video/bots.
- **F11 Chrono Snap** — jumbotron instant replay with camera orbit, driven by
  a shared ~30 s ring buffer + micro-resimulation between keyframes.
- **F12 Supernova Encore** — the crowd-charged finale: phones tap-to-charge,
  the pinned orb detonates on a server-synced fire-at timestamp, every phone
  flashes white in the same instant.
- **F13 Neon Guestbook** — phone-drawn glyph strokes crystallize into a
  persistent constellation (expanding-spiral placement, evict-oldest at 512,
  50 pre-seeded so hour one is never empty).

### Tier 5 — the world is honest

- (F1–F13 above already ship; Tier 5 hardens the shared replay substrate that
  F11/F19/F20 depend on — the micro-resimulation parity keystone.)

### Tier 6 — "The Impossible Broadcast" (staff-gated, never auto-cued)

- **F14 The Gallery** — a remote `audience` tier (cap 128, `?watch` permalink):
  anyone anywhere watches the live booth rendered from their own GPU off an
  ~8–14 KB/s data stream, never a video frame.
- **F15 MC NULL** — a procedural play-by-play caster (`casterGrammar.ts`, pure
  + golden-transcript tested); stage-caption-only by default, silence is the
  baseline, TTS is opt-in garnish.
- **F16 Siege Waves** — an escalating 3-wave arc on top of F6 (bullet-time
  wave 3, budget-capped meteor admission, elected laws survive the siege).
- **F17 Daemon Crew** — server-hosted synthetic `DMN-` peers that play catch
  with a lone visitor during quiet hours; synthetic-blind everywhere that
  matters (attract-exit, idle detection, metrics), never steals a contested
  grab from a human.
- **F18 X-Ray Broadcast** — a staff-triggered split-truth netcode overlay:
  raw server dots, the interpolated world, and a +300 ms delayed ghost —
  "what lag feels like," narrated for CS-literate visitors.
- **F19 Pocket DVR** — every viewer's own scrub/rewind/orbit control over the
  live broadcast, independent per viewer, auto-yields to live on a showpiece.
- **F20 Neon Clip Machine** — a compositor-canvas recording of a scored
  highlight, delivered via an unguessable `GET /api/clips/:id` QR-scan URL.
- **F21 Powers Lab** — Quest hand-tracking telekinesis (pinch-pull a shape
  across the room); off by default, gated on a `BUDGET_LEDGER.md`-recorded
  ≥ 72 fps measurement on real hardware.

### The Workshop (desktop group, cut after Tier 6)

- **F22 Desktop Command** — the complete desktop resident surface: 4-mode
  camera rig (ORBIT/FLY/FOLLOW/AUTO), full DOM HUD (phase, laws, roster,
  ballot, help), the complete keymap — the as-built Phase A bindings
  (click-spawn, drag-grab, `C`/`V`) are preserved verbatim.
- **F23 The Workshop** — a `?mode=build` desktop world-builder: transform
  gizmos, undo/redo, named layouts, a `SET_BASELINE` every RESET restores,
  and an authored-glyph seeder — the tool the showroom baseline is composed
  with before doors open.

## Test count

```
npm test
```

**2030 tests passed, 1 skipped, across 116 files** (unit + integration +
headless multi-client e2e). The 1 skip is the 30-minute deterministic soak,
gated behind an env var so the default `npm test` run stays fast:

```
npm run test:soak   # SOAK=1 vitest run soak.test.ts — the 30-min deterministic
                     # soak (packages/server/test/soak.test.ts) at booth cap:
                     # 8 residents + 2 spectators + 2 directors + 24 wisps +
                     # 64 crowd + 128 audience, every landed subsystem live.
                     # Fills docs/booth/BUDGET_LEDGER.md's Measured column.
```

## Booth quickstart

1. **Create a room:** `POST /api/rooms` → `{roomId, ownerToken}`. The
   `ownerToken` is the staff/owner secret — keep it off any public surface;
   print it as the runbook's paper backup (`docs/booth/RUNBOOK.md`).
2. **Share the join link:** `/r/<roomId>` is the public room URL; a staff
   join carries the HMAC secret as `?k=<secret>` (from `POST /api/rooms`) to
   authenticate as `resident`.
3. **Client entry modes** (each is its own code-split bundle):
   - `?mode=stage` — the big-screen kiosk (`packages/client/src/stage/`):
     the `spectator`-tier auto-director client, carries the `ownerToken` for
     staff hotkeys.
   - `?mode=director` — the Showrunner staff console
     (`packages/client/src/director/`): phase control, roster, cue bank.
   - `?mode=build` — the Workshop world-builder
     (`packages/client/src/builder/`), staff/resident-only (needs the
     `ownerToken`-derived `BUILD` capability).
   - `?watch` — the remote audience permalink (`packages/client/src/funnel/`):
     routes to the `audience` tier while the room is live-occupied, or the
     entry funnel when idle.
   - The **funnel** (`packages/client/src/funnel/`) is the phone QR landing
     page: ballot (crowd vote), crowd (cheer/pulse), wisp (join as a phone
     presence), or watch — chosen by the visitor.
4. **Preflight before doors:** `npm run preflight` (or
   `node tools/preflight/cli.mjs`) — checks LAN/tunnel reachability, cert
   days remaining, WS RTT, autoplay policy, mic/speaker access.
5. See `docs/booth/RUNBOOK.md` → **Startup Sequence** for the full
   room-creation-to-QR-on-screen walkthrough.

## Docs pointers

- [`docs/booth/RUNBOOK.md`](docs/booth/RUNBOOK.md) — the HOW: pre-event
  checklist, Chrome kiosk flags, QR fallback ladder, panic key, rotation
  (RESET), day close, incident controls, auth/TTL, monitoring, rollback.
- [`docs/booth/RUN_OF_SHOW.md`](docs/booth/RUN_OF_SHOW.md) — the WHEN: a
  laminated one-pager, minute-by-minute rotation timing.
- [`docs/booth/BUDGET_LEDGER.md`](docs/booth/BUDGET_LEDGER.md) — measured
  bandwidth/compute/storage budgets from the C22 30-minute deterministic soak
  (per-tier egress, world/glyph/reel plateaus); the Powers Lab fps row is
  `owner/hardware-pending`.
- [`docs/booth/CLOSING_CEREMONY.md`](docs/booth/CLOSING_CEREMONY.md) — the
  end-of-day script: final Encore, attract glyph tour, day-total stats card,
  export + permalink + Discord post.

## Deploy

### Cloud (GHCR + Cloudflare Tunnel) — `docker-compose.yml`

```bash
docker compose up --build
```

Two services: `server` (Node WS+HTTP, internal-only) and `web` (nginx serving
the static client + reverse-proxying `/ws` and `/api/*` on host port 3020).
TLS/WSS is terminated externally by a Cloudflare Tunnel — the containers only
ever speak plain HTTP/WS. To use prebuilt CI images instead of building from
source, point the `image:` lines at `ghcr.io/atvriders/cyber-shapes-vr:latest`
(client) and `ghcr.io/atvriders/cyber-shapes-vr-server:latest` (server).

### LAN fallback (no internet dependency) — `docker-compose.lan.yml`

```bash
cp .env.lan.example .env.lan   # LAN_URL / TUNNEL_URL / STAFF_KEY / etc.
docker compose -f docker-compose.lan.yml --env-file .env.lan up --build
```

The booth's rehearsed fallback topology (spec §12): server + nginx run on the
booth laptop, headsets/stage/phones join over a travel router's Wi-Fi. nginx
terminates **real** TLS itself (WebXR/`getUserMedia` require a secure
context) via a DNS-01 ACME cert for the same domain the cloud deploy answers
to — see the file's header comments for the full DNS-01 + split-horizon-DNS
walkthrough. This is a **documented, owner-executed setup** (a real domain +
DNS provider + certbot run days before the event) — not yet verified against
real docker/nginx outside the sandbox.

### nginx routing (both configs)

`nginx.conf` / `nginx-lan.conf` proxy `/ws` (with the `Upgrade` header) to the
server AND `/api/*` (rooms, preflight, clips, metrics) — the `/api/*` proxy
was a C23-found gap (it previously 404'd through the SPA fallback) that is
now fixed in both configs. Both also append the real client IP to
`X-Forwarded-For` and strip any inbound `CF-Connecting-IP` so per-IP rate
limits can't be bypassed by a forged header (see Config flags below).

## Config flags (env vars, all safe-default)

| Flag | Default | Effect |
|---|---|---|
| `POWERS_LAB_ENABLED` | unset (**off**) | Set to `1` to advertise the F21 Powers Lab hand-tracking cue. Gate this ONLY after recording a real ≥ 72 fps / no-frame->20ms measurement in `BUDGET_LEDGER.md` — a perf/taste failure must degrade to "feature off," never "bug on the big screen." |
| `DAEMON_AUTOSUMMON_LOBBY` | unset (**off**) | Set to `1` to auto-summon F17 Daemon Crew constructs in LOBBY. Gate this ONLY after an owner acceptance pass of the recorded fetch-and-return script on the real stage. |
| `TRUSTED_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops in front of the server, for `X-Forwarded-For` per-IP keying. Cloud compose sets `1` (nginx); LAN compose sets `0` (nginx is the sole hop, keyed differently — see its comment). |
| `TRUST_CF_CONNECTING_IP` | `true` (unset) | Whether the server trusts an inbound `CF-Connecting-IP` header for per-IP keying. Both `docker-compose.yml` and `docker-compose.lan.yml` set this to `'false'` — nginx already strips/rewrites the header, and origin-direct traffic (bypassing Cloudflare) must not be able to forge it. |
| `STAFF_KEY` | unset | An optional back-compat bearer-token gate for `/api/preflight` and `/api/metrics/day` from off-LAN callers (both also accept a same-LAN/loopback caller with no key). |
| `LAN_URL` | `http://192.168.1.1/` | The LAN reachability target the preflight tool checks (LAN-mode topology detection). |
| `TUNNEL_URL` | `https://example.cloudflare.com/healthz` | The tunnel reachability target the preflight tool checks. |
| `CERT_DAYS_REMAINING` | `30` | Reported cert-expiry days for the preflight `cert-days` check (LAN mode; real cert monitoring is a manual/external step — see `docker-compose.lan.yml`). |
| `DATA_DIR` | `./data` | Room/bucket persistence root (world, guestbook, day-stats, layouts, clips). Both composes mount a named volume here. |
| `PORT` | `3030` | Server listen port. |
| — (`ROTATE_SECRET`, `ownerToken`) | n/a | Not env vars — `ROTATE_SECRET` is a director command (rotates a room's HMAC join secret); `ownerToken` is the per-room owner secret minted by `POST /api/rooms`, presented at join to gain director capability (any tier). |

## Architecture (tier fan-out)

The authoritative Node server owns one `ServerWorld` per room (per-link,
private, ≤ 8 residents) and runs the shared, pure `physicsCore` at 30 Hz.
Every connection joins at one of six tiers, each with its own receive-set and
send whitelist (`packages/shared/src/tiers.ts`):

```
              ┌─────────────────────────── authoritative server ───────────────────────────┐
              │   ServerWorld (physics, 30 Hz) · RoomTimeline/CueRegistry · persistence     │
              └───────┬──────────┬──────────┬───────────┬───────────┬──────────┬───────────┘
                      │          │          │           │           │          │
                 resident   spectator     wisp        crowd     audience   director
              (headset/    (stage/     (phone,      (phone,     (remote,     (staff
               desktop,     watch,      full 3D,   DOM-only     ≤128,       console;
               full-rate)   full-rate)  5 Hz coal.) ballot)     5 Hz coal.,  any tier
                                                                  never a     w/ ownerToken)
                                                                  video frame)
```

`resident`/`spectator` get the full-rate delta+pose stream; `wisp` and
`audience` share a single serialize-once ~5 Hz coalesced world buffer
(marginal cost is bytes, not serialization); `crowd` never receives world
state or poses at all — only family-specific summaries (votes, showpiece,
phase) over a DOM-only ballot/pulse page. The cue/timeline engine
(`RoomHandle`) is the one seam every one of the 21 features writes through —
no feature reaches a sibling directly (spec FAQ #5).

## Owner-verified items (hardware/deploy)

The following are **built and tested in the sandbox but not yet verified on
real hardware/deploy**, and require the deploy owner to confirm before a live
event:

- **Quest 2 in-VR comfort + Powers Lab fps gate** — frame budget, controller
  latency, mic capture in immersive mode; the F21 Powers Lab hand-tracking
  cue specifically requires a real ≥ 72 fps / no-frame->20ms measurement
  (hands + a TK pull mid-flight + representative PLAY load) recorded in
  `docs/booth/BUDGET_LEDGER.md` before `POWERS_LAB_ENABLED=1` is ever set.
- **The `?mode=stage` big-screen WORLD-RENDER seam.** The director logic,
  camera-shot brain, overlays, highlight scorer, and glyph constellation data
  are built and unit/integration-tested — but the stage's **3D render** of
  the live world (shapes, avatars, meteors, titans) and the Tier 6 3D
  payoffs (F18 x-ray split-truth, F19 DVR rewound poses, the F6/F7 crystal-
  cam/worm's-eye camera framing, F15 caster and F17 daemon visuals) are a
  **documented, deferred render-driver wiring seam** — `render.ts` currently
  renders only the glyph constellation + HUD on `?mode=stage`. This is not a
  bug being hidden: it is the single largest remaining owner/hardware item
  flagged at the C24 whole-branch audit. **Do not claim the big screen
  already renders the self-directing world** until this is wired and
  look-approved on the actual stage hardware.
- **MediaRecorder clip capture (F20 Neon Clip Machine, C31)** — the
  compositor-canvas + codec-probe + upload/delivery pipeline is unit-tested
  end to end except the actual `MediaRecorder` capture, which cannot run
  under Vitest; manual acceptance = a produced clip opens and plays in a
  second browser with the chyron visible and audio present, and the QR
  end-slate scans and downloads from a phone.
- **Remote audience / tunnel scale** — the C22 soak validates the `audience`
  tier's fan-out logic and backpressure at 128 simulated viewers, but real
  Cloudflare Tunnel egress at that scale (~14 KB/s × 128 ≈ 14 Mbps) is
  unverified outside the sandbox.
- **LAN-mode DNS-01 TLS cert + split-horizon DNS** — `docker-compose.lan.yml`
  documents the full DNS-01 ACME + router DNS-override procedure, but it is
  an owner-executed, pre-event setup step, not yet run against a real
  domain/router in this environment.
- **The origin-direct `:3020` firewall-to-Cloudflare step** — the cloud
  compose's `web` port is reachable origin-direct (bypassing the tunnel);
  the header-rewrite hardening (C24 SECFIX) closes the per-IP-key bypass,
  but a *complete* fix (firewalling `:3020` to Cloudflare IP ranges, or
  enabling Authenticated Origin Pulls) is an operator network-layer step
  outside this repo.

## Testing

```bash
npm test          # Vitest — 2030 tests + 1 soak-gated skip, 116 files
npm run test:soak # SOAK=1 — the 30-min deterministic booth-cap soak
npm run typecheck # tsc -b (full project references build check)
npm run lint      # ESLint
npm run format    # Prettier (write mode)
npm run size      # bundle-size budgets (funnel/desktop/builder chunks)
npm run preflight # booth pre-event connectivity/cert/autoplay checks
```

## Tech stack

- **Three.js** — WebGL + WebXR rendering (headset/desktop/stage/builder)
- **Vite** — multi-entry client build (main, funnel, stage, director, builder
  — each its own code-split bundle with an enforced size budget)
- **TypeScript** — end-to-end (client, server, shared)
- **Node.js + ws** — authoritative WebSocket game server
- **WebCodecs (Opus)** — in-browser voice encoding/decoding; no WebRTC
- **Web Audio API** — the generative synthwave conductor/synth (F8 Resonora)
- **Vitest** — test runner (unit + headless integration + the deterministic soak)

## Monorepo layout

```
packages/
  shared/   — protocol types, pure physics core, cue/timeline engine, caster
              grammar, replay/reels, siege waves, telekinesis math, constants
  client/   — Three.js WebXR app: headset/desktop entry, stage (?mode=stage),
              director console (?mode=director), builder (?mode=build),
              phone funnel (ballot/crowd/wisp/watch), voice, music, powers
  server/   — Node authoritative game server: rooms, timeline, siege, encore,
              caster, daemons, clips, glyphs, persistence buckets, preflight
docs/
  booth/    — RUNBOOK, RUN_OF_SHOW, BUDGET_LEDGER, CLOSING_CEREMONY
tools/
  preflight/             — the pre-event connectivity/cert/autoplay CLI + page
  check-bundle-size.mjs  — the size-gate script (npm run size)
  gen-goldens.mjs        — protocol golden-vector generator (binary families)
  import-layout.mjs      — Workshop layout JSON import (no-builder-UI rung)
```

---

_Built with [Claude Code](https://claude.ai/claude-code)_
