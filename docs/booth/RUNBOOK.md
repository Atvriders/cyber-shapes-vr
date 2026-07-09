# Booth Runbook — cyber-shapes-vr

> **Status:** Operational (C23). All Tiers 0–6 landed; numbers below are measured
> (C22 soak — see `BUDGET_LEDGER.md`) or cite real as-built constants. The
> companion sheet is `RUN_OF_SHOW.md` (WHEN things happen) — this file is HOW;
> neither restates the other. `CLOSING_CEREMONY.md` is the end-of-day script.

---

## Pre-Event Checklist

- [ ] Run the preflight tool: `npm run preflight` (or `node tools/preflight/cli.mjs`)
      from the booth laptop — server checks print green/red in the terminal; the
      two manual items (stage watchdog, headset battery) prompt interactively.
      The browser page (`tools/preflight/index.html`, served at whatever path the
      static host maps it to) is the same checks for a phone/tablet.
- [ ] Confirm mode: `both` (LAN + tunnel), `lan` (LAN-only, see docker-compose.lan.yml),
      or `tunnel` (cloud-only). `offline` = stop, fix connectivity first.
- [ ] Verify cert days ≥ 14 (green). If < 14, renew before the event (`cert-days` check).
- [ ] Confirm WS RTT < 300 ms to the local server (`ws-rtt` check; ok < 150 ms typical).
- [ ] Test autoplay policy in the headset browser (`autoplay` check — Chrome flag below fixes this).
- [ ] Test mic / speaker access on every audience device (`mic-speaker` check).
- [ ] **Record 3–5 hero-take reels** via the C13 reel-bank cue **days before the
      event** (never record on-site — see `RUN_OF_SHOW.md` T−45). These back the
      ATTRACT-mode Ghost Arcade fallback if the day's own auto-banker hasn't
      accumulated content yet.
- [ ] **Compose + save the showroom baseline layout + glyph seeds via the
      Workshop:** fire the `build-mode` cue (director console, resident/desktop
      tier only — spec §7.23), arrange the showroom in `?mode=build`, `LAYOUT_SAVE`
      it under a name, `SET_BASELINE` to bind it as the RESET target (falls back
      to the shared `SHOWROOM_BASELINE` seed list in `packages/shared/src/constants.ts`
      if never bound, or if the bound layout is later deleted), then place
      authored `GLYPH_SEED` glyphs (capped at `SEEDED_GLYPH_CAP` = 64,
      `packages/server/src/glyphManager.ts`). Exit build-mode (re-fire `build-mode`,
      or it auto-reverts at `BUILD_SESSION_MAX_MS` = 2 h,
      `packages/shared/src/constants.ts`).
- [ ] **Tether fallback:** if the venue Wi-Fi/LAN is unreliable, a staff phone's
      mobile hotspot is a documented uplink fallback for **~10 clients max** — know
      which phone/plan is the tether before doors open.
- [ ] **Siege ringer:** seat one experienced club member in headset 1 (the
      "ringer") with a walk-up guest in headset 2 — keeps the OVERLOAD/siege
      showpiece readable for a first-timer defender. (The C9 fame/heat fairness
      cap already limits any one resident to ≤ ~60% of FOLLOW_THROW shot time per
      rotation — halve the ringer's expectations, they will still carry more shots.)
- [ ] QR poster printed + scan test from a phone on cellular data (not the venue
      Wi-Fi) — proves the public join path actually works from outside the booth.
- [ ] Print the owner link (`roomId` + `ownerToken` from `POST /api/rooms`) and
      stow it — the paper backup if the director console session is lost.

---

## Chrome Flags (stage + headset kiosks)

Launch the stage/headset Chrome/Chromium with:

```
--autoplay-policy=no-user-gesture-required
```

Attract mode plays ambient audio/`speechSynthesis` with no prior user gesture —
without this flag the browser silently blocks it (spec §7.1). Nothing else is
required: WebXR/`getUserMedia` need a secure context (`https://`/`wss://`), which
the Cloudflare Tunnel or the LAN DNS-01 cert (see `docker-compose.lan.yml` below)
already provides — no `--unsafely-treat-insecure-origin-as-secure` workaround
needed in production.

---

## QR Fallback Ladder

The stage's docked join-QR degrades in three real, already-wired rungs (never a
dead code, `packages/client/src/stage/stage.ts` / `overlays.ts`):

1. **Normal:** the QR encodes the public join URL; a background health-check
   (`HEALTH_CHECK_INTERVAL_MS` = 30 s) polls it.
2. **Auto health-swap:** on a failed poll the kiosk hides the QR and shows a
   static **"SCAN OFFLINE — ASK STAFF"** card (`showAskStaffCard()`) — it never
   displays a QR that points at a dead link. Recovery auto-restores the QR.
3. **Staff manual fallback:** hand out the printed owner link (see Pre-Event
   Checklist) or, if the tunnel is down for the day, switch to LAN mode
   (`docker-compose.lan.yml`) and distribute the LAN-mode QR/URL instead.

The render-stall watchdog (`RENDER_STALL_MS` = 10 s) is a separate, lower-level
safety net: if the stage tab itself freezes (not just the join URL), the kiosk
auto-reloads.

---

## Panic Key

**Trigger:** the `PANIC` director-cmd — the `P` hotkey on the director console
(`packages/client/src/director/console.ts`) or the console's PANIC button. Any
staffer with `ownerToken` can fire it from any tier.

**Effect (spec §6.1, server-enforced in `connection.ts`):** hides the newest
`GLYPH_PANIC_HIDE_COUNT` (= 12) glyphs, suppresses live callsign/name surfaces
(lower-thirds, wisp nameplates, caster captions incl. `speechSynthesis.cancel()`),
and reaches the `audience` tier's remote viewers too — not just the booth screen.
Use it immediately for anything identity-adjacent going wrong (a bad callsign
collision edge case, a caster line reading oddly, etc.) — it is non-destructive
and instant.

**VETO** (separate director-cmd) reverts any active physics-law dial/election
back to the standing baseline — use for a runaway/uncomfortable physics state.

---

## Startup Sequence

1. Start the server: `npm run dev` (or `docker compose up` — see `docker-compose.yml`
   for tunnel mode, `docker-compose.lan.yml` for LAN mode — in production).
2. Confirm `/healthz` returns `ok`.
3. Run `npm run preflight` (or open the preflight page) and confirm all checks green.
4. Launch stage/headset Chrome with the flag above.
5. Create a room via `POST /api/rooms` → note `roomId` + `ownerToken`.
6. QR-encode the room join URL and display it on the booth screen.
7. Staff connects with `ownerToken` to become director.
8. Trigger one RESET and confirm the showroom baseline + seeded glyphs render
   (the Pre-Event Checklist's Workshop step, verified end-to-end).

---

## Show Pacing

The full show-pacing table (phase-by-phase timing, staff labels, rotation
throughput) lives in `RUN_OF_SHOW.md` — print it double-sided and laminate it;
this file does not restate it. Phase durations are the shared
`PHASE_DURATIONS_MS` constant (`packages/shared/src/cues.ts`) — if that constant
ever retunes, re-derive `RUN_OF_SHOW.md`'s BACK table (elapsed-time column) from
it (C23 Step 5 already reconciled the two as of this writing).

---

## Staff Narration One-Liners (by label)

`RUN_OF_SHOW.md` references these by LABEL only — the actual lines live here.

- **`ghost-reveal`** (F10 Ghost Arcade, ATTRACT close-range beat): *"Those are
  real recordings of people who played today — not video, not bots. Scan the QR
  and you're next."* Use when a visitor gets close enough to notice the ghosts
  are translucent.
- **`re-sim-flex`** (C21-gated — only say this once the micro-resim parity test
  is green, which it is as of C21/C22): *"That replay was re-simulated, not
  recorded — the physics ran again from the same inputs."*
- **`you-all-just-wrote-that`** (FINALE/Encore fire-at-sync beat, spec §5.3):
  *"You all just wrote that."* — say it the instant the SUPERNOVA/Encore drop
  lands and every phone in the room flashes together.
- **`one-socket`** (LOBBY, for a CS-literate visitor — the devtools-survivable
  line, spec §10): *"Open devtools on any phone in line — one WebSocket. Every
  phone, both headsets, the big screen: one Node process, one port, no WebRTC,
  no TURN."*
- **`x-ray`** (F18 X-Ray Broadcast, C29 — if landed): while the stage shows
  **"NETWORK X-RAY // LIVE DIAGNOSTIC FEED"** with the three claim banners
  ("SERVER TRUTH" / "WHAT PLAYERS SEE" / "+300 ms — WHAT LAG FEELS LIKE"),
  narrate: *"This is the actual network truth — the raw dots are real server
  ticks, the smooth world is what players see, and the red ghost is running 300
  milliseconds behind — that's what lag feels like."*
- **`daemon`** (F17 Daemon Crew, C28 — if landed, `DMN-` callsigns): *"Those
  agents run through the same validated intent path as the humans — no
  god-mode, they just can't lose a contested grab."*

**Solo-volunteer delta:** skip `ghost-reveal` and `re-sim-flex` when solo (see
`RUN_OF_SHOW.md` FRONT) — auto-cues carry the show; your job is helmets, hygiene,
and the panic key.

---

## Rotation (RESET)

1. Director sends `DIRECTOR_CMD: DOOR_CLOSE` to stop new public joins.
2. Director sends `DIRECTOR_CMD: ROTATE_SECRET` to rotate the join secret.
3. Staff clears the world: `onRoomReset(roomId)` (wipes WorldBucket; guestbook + dayStats survive).
4. Director sends `DIRECTOR_CMD: DOOR_OPEN`.
5. Distribute the new join QR.

---

## A/B Headset Hygiene Rotation

Two headsets, labeled A/B, one **always charging**:

1. As the outgoing player's rotation reaches STATS, begin swapping in the OTHER
   headset (already sanitized + charged) for the next visitor — the swap happens
   during STATS + RESET (60 s combined), never blocking the line.
2. Wipe the outgoing headset with a disposable face cover change + a quick wipe;
   set it on its charger.
3. Repeat next rotation with the headsets swapped.

**Two volunteers** (one runs the line/helmets, one sanitizes) sustain ≈ 8–9
rotations/hour. **Solo** staff serializes sanitize into STATS+RESET → ≈ 7/hour
(see `RUN_OF_SHOW.md` FRONT for the full derivation). If only one headset is
available, hygiene still applies between every visitor — the loop just runs at
single-headset throughput.

---

## Kit List

TV/monitor (bigger beats projector for booth lighting) · powered speaker ·
travel router (LAN-mode fallback / tether backup) · link cables + battery packs
· chargers for both headsets · printed room-owner link (Pre-Event Checklist) ·
printed recording/clips notice — **the sign covers BOTH Ghost Arcade reels and
Neon Clip Machine take-home clips** ("anonymized gameplay may be recorded and
published as short clips" — see the Neon Clip Machine section below for the
full kit-sign copy) · disposable face covers (A/B hygiene rotation).

---

## Doors-Open

Once the booth is live and the first rotation is running:

- **Post the watch link** (`<permalink>?watch`) to the club Discord **and** the
  department channel — this is how the C25 remote-audience Gallery gets its
  first viewers (spec §7.14 "seeding is an announcement" problem). The exit
  screen's own "SHARE WATCH LINK" button (spec §5.7) lets departing visitors
  re-seed it throughout the day too.

---

## Day Close (post-event)

> Full script (staff cue → Encore → glyph tour → stats card → export): see
> `CLOSING_CEREMONY.md`. This section is the OPERATIONAL checklist underneath it.

1. Run the Closing Ceremony export: `GET /api/metrics/day` (Task C23 — LAN/loopback
   source or `Authorization: Bearer <STAFF_KEY>`; wraps `metrics.exportDay()`, a
   pure read) → save the JSON to disk (includes the `clip` counter — clips
   delivered today, §11, and the day's `join`/`glyph`/`vote`/`rotation`/`showpiece`
   totals + `peakConcurrent`/`peakWatchers` gauges).
2. Call `onDayClose(roomId)` (wipes WorldBucket + DayStatsBucket; GuestbookBucket
   survives) — currently an OPERATOR action taken by whoever has process access
   to the running server (no director-console button exists yet for this step;
   flagged as a follow-up wiring gap, not a fake claim).
3. Archive the guestbook JSON if desired.
4. **Verify the deployed TTL/eviction config spared the booth roomId.** The room's
   auth record (`<DATA_DIR>/rooms/<roomId>.auth.json`, see Auth / TTL below) is
   evicted `ROOM_TTL_MS` (30 min, `packages/server/src/auth.ts`) after it goes
   EMPTY (every peer disconnects) — occupied rooms are never evicted. For a
   **same-day** close this is moot (you're about to restart/end the process
   anyway); for a **multi-day booth**, either (a) keep ONE peer connected
   overnight (e.g. leave the director console open) so the room stays
   "occupied", or (b) restart the server and re-join well inside the 30-minute
   window the NEXT morning — a fresh process reloads the auth record on first
   join (`RoomAuthStore.loadRoom`) and restarts its occupancy clock from that
   moment, so the record survives even though it sat unswept on disk overnight.
   If in doubt, confirm the file above still exists before doors-open on day 2.
5. **LAN-day bucket export → cloud import** (LAN-mode days only): copy the
   booth laptop's whole `<DATA_DIR>` tree (`rooms/` — world + auth,
   `buckets/{world,guestbook,dayStats,layouts}/` — the layouts bucket carries
   Workshop compositions if C34 landed, `clips/` if C31 landed) to the cloud
   deploy's `DATA_DIR` volume, then restart the cloud server so it picks up the
   copied files under the SAME `roomId` — this is a manual file copy today (no
   scripted export/import tool exists yet); it is what makes the exit screen's
   "this world stays online" / "goes online tonight" promise (spec §5.7/§10) true.
6. **Discord permalink post:** post the room permalink to the club Discord — this
   is the C31 no-uplink completion step (**"your clip posts to the club Discord
   tonight"**): if any clips banked LOCALLY in a visitor's browser today because
   `POST /api/clips` failed (server down / offline LAN booth), this post is where
   staff manually shares them (screen-record or re-upload from the banked
   blob) alongside the permalink.
7. `metrics.resetDay()` to zero counters for the next day (call AFTER step 1's export).
8. `clipStore.sweep()` (or wait for the periodic sweep) to reclaim expired clip blobs before the next event.
9. Restart the server if required for memory reclamation.

---

## Incident Controls (Director Commands)

| Command           | Effect                                          |
|-------------------|-------------------------------------------------|
| `DOOR_CLOSE`      | Block new public (wisp/crowd) joins.            |
| `DOOR_OPEN`       | Re-open the room to the public.                 |
| `ROTATE_SECRET`   | Rotate the join HMAC secret (confirm once).     |
| `ROTATE_LINK`     | Retire the room id + issue a new one (confirm twice — last resort). |
| `MUTE targetId`   | Server-side mute a peer's audio.                |
| `UNMUTE targetId` | Un-mute.                                        |
| `KICK targetId`   | Disconnect a peer.                              |
| `ROSTER`          | Fetch the live peer roster with join provenance.|
| `NOOP`            | Health-check the director channel.              |

---

## Auth / TTL

- Room auth records persist at `<DATA_DIR>/rooms/<roomId>.auth.json` (token hash
  + epoch — `RoomAuthStore._authPath`, `packages/server/src/auth.ts`).
- `ROOM_TTL_MS` = 30 min. TTL sweep runs every `min(ROOM_TTL_MS, 5 min)`, evicting
  a room that is **never-joined** OR has been **empty since its last peer left**
  for longer than `ROOM_TTL_MS`. **Occupied rooms (≥ 1 connected peer) are never
  evicted** — see the Day Close post-event step above for the multi-day
  implication.
- `authStore.sweep()` can be called manually from the runbook tooling (also runs
  automatically on every `POST /api/rooms` and on the periodic interval above).

---

## Neon Clip Machine (F20, C31)

- **Kit sign:** print/post the small "anonymized gameplay may be recorded and
  published as short clips" sign at the booth entrance (spec §6.1 — the SAME
  sign covers Ghost Arcade reels and take-home clips). A visitor who declines
  should be pointed to staff before joining.
- **What gets saved:** ONE auto-clip per rotation (the top-scored highlight,
  min-activity gated — a quiet rotation saves nothing) PLUS any visitor-
  triggered SAVE CLIP (stage hotkey `c`/`C`, or the director-console SAVE_CLIP
  relay). Every clip is a 1280×720 re-composited replay — camera feed only,
  never a raw room recording, and room voice is never captured (the mixer
  structurally never contains it, §6.2).
- **Retrieval:** the STATS/RESET "SCAN TO TAKE YOUR CLIP HOME" card (~20 s)
  shows a QR that IS the `GET /api/clips/:id` retrieval URL — clipIds are
  128-bit random (unguessable; nothing to browse/list). The exit screen also
  prints the same URL(s) under "your clips".
- **No-uplink rung:** if `POST /api/clips` fails (server down / offline LAN
  booth without the tunnel), the clip banks LOCALLY in the browser and the
  card copy switches to "your clip posts to the club Discord tonight" — added
  to the Closing Ceremony checklist as the manual post step.
- **Day-close sweep:** clips TTL at `CLIP_TTL_MS` (~24 h) from creation; the
  server's periodic sweep (the SAME interval as the C4 auth sweep,
  `min(ROOM_TTL_MS, 5 min)`) deletes expired blobs — `clipStore.sweep()` can
  also be called manually from runbook tooling. A swept id 404s exactly like
  one that never existed (no "used to exist" signal to a scraper).
- **Caps (booth-safe defaults, `packages/server/src/clips.ts`):** ~25 MB per
  clip; ≤ 40 saves per room per day; ≤ 60 downloads/IP/min; ≤ 500 downloads per
  clip per day. If a viral clip hits its daily cap, re-save it the next day or
  raise `maxDownloadsPerClipPerDay` for a planned high-traffic event.

---

## Powers Lab — Hand Telekinesis (F21, C32) — FLEX EXHIBIT

> **This is a staff-demoed / 30-second-coached QUIET-PERIOD exhibit — NEVER part
> of walk-up rotations.** Controllers are the reliable walk-up choice; hand
> tracking is fragile in booth lighting, so it runs opt-in with instant
> auto-fallback. The whole feature is OFF by default (`POWERS_LAB_ENABLED` unset).

- **Gate to turn it ON (once, per venue):** the cue is advertised ONLY when
  `POWERS_LAB_ENABLED=1` **and** a headset has reported camera-tracked hands. Set
  the env flag ONLY after the owner records the Quest fps row in
  `BUDGET_LEDGER.md` (hands + a TK pull mid-flight + representative PLAY load →
  **≥ 72 fps, no frame > 20 ms**, never an idle-room number). A perf/taste failure
  keeps the exhibit OFF (degrade-not-break) — no bug reaches the big screen.
- **Headset prep (the browser cannot read device settings — a runbook line):**
  in Quest **Settings → Movement/Hand Tracking, enable "Hand Tracking" +
  "Auto Switch"** so setting the controllers down flips to hands automatically.
  Mark a **controller SET-DOWN SPOT** next to the headset (a small tray/pad) so
  the demoer always knows where they are for the hand-off back to a walk-up.
- **In-headset one-tap SELF-TEST (what actually gates advertisement):** the wearer
  sets the controllers down and holds out an empty hand; the neon **skeleton
  hands** should appear within a couple of seconds. That "hands appeared" report
  is exactly the `TK_HANDS_STATE` signal that (with the flag) registers the
  `powers-lab` cue — watch the director console: **`Powers Lab (Hand Telekinesis)`
  appears in the Advanced tab** = PASS; if it never appears, hand tracking is not
  reporting (lighting / setting) = FAIL, stay on controllers.
- **Enter-VR CONSENT note:** the Enter-VR prompt will mention hand tracking (the
  `hand-tracking` optional feature is requested at session init). Mention it in the
  30-second coaching: the headset camera tracks the visitor's bare hands locally;
  **only the pull's ANCHOR + target shape leave the headset** (the tether) — the
  hand joints are never streamed.
- **Running it:** fire the **Powers Lab** cue from the director console (Advanced
  tab, PLAY/LOBBY only — never ATTRACT). It arms TK for **~10 min** (auto-reverts;
  re-fire toggles OFF; a RESET also clears it). The demoer pinches at a distant
  shape (a 300 ms sustained hold) and it tears into their palm under a
  **"NO CONTROLLERS — CAMERA-TRACKED HANDS"** lower-third + a neon tether beam on
  the stage. Safety rails are automatic: tracking loss > ~250 ms drops the pull,
  a human grabbing the shape always wins, at most 2 pulls (one per hand), one TK
  player at a time, and a disconnect reverts instantly.
- **Hand back to a walk-up:** pick the controllers up off the set-down spot (or
  let the ~10 min window lapse / RESET); TK disarms and the room returns to the
  ordinary controller path with nothing left pinned.

---

## Monitoring

- `/healthz` — liveness probe.
- `/api/preflight` — full preflight JSON (used by the preflight page + `npm run preflight`).
- `/api/metrics/day` — Task C23: the day-counters export (counters-only JSON, no
  PII) — same LAN/loopback-or-staff-key gate as `/api/preflight`. See Day Close.

---

## Rollback / Emergency Stop

1. `DOOR_CLOSE` all rooms.
2. `KICK` any problematic peers.
3. If the room link must change: `ROTATE_LINK` (confirm twice).
4. If full restart needed: `Ctrl-C` / `docker compose down && docker compose up`.
5. Rooms with `DATA_DIR` set will reload from disk on restart.

---

*Measured numbers (connection counts, timing, egress budgets) live in
`BUDGET_LEDGER.md` (C22 soak). This runbook was dry-run top-to-bottom against
the working tree at C23 — every file/command/constant cited above exists as
written; see `.superpowers/sdd/task-C23-report.md` for the reconciliation notes.*
