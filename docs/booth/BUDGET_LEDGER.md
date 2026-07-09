# Budget Ledger — cyber-shapes-vr (spec §13)

> **Status:** Measured (C22). C8 skeleton + Tier 6 declared rows; C22 fills the Measured column from the 30-minute deterministic soak (`packages/server/test/soak.test.ts`, `npm run test:soak`).

---

## Purpose

This ledger tracks the operational budget for each booth day: bandwidth, compute time, API costs, and any third-party service charges. It is a Tier 0 deliverable (spec §13) — the skeleton is created here so Tier 6 tasks have a place to append their rows and C22 can fill in measured values.

---

## C22 measurement method (how the Measured column was produced)

The **Measured** values below come from the **C22 deterministic soak** — 30 simulated minutes (54 000 fixed-timestep ticks) driven manually with an injected clock over the real room manager + connection hub, at cap: **8 residents + 2 spectators + 2 directors + 24 wisps + 64 crowd + 128 audience**, every landed subsystem running (timeline rotations, siege incl. the C27 3-wave arc, wisps, recorder tee, conductor, elections, encore, caster, daemons, Workshop baseline/RESET, clips). Per-tier egress is the **actual bytes sent to each socket**, measured over the clean **[15,30] min** window on the stable-at-cap viewers and divided per viewer.

- **These numbers are the SUSTAINED §6.5 worst case** (≈ 40 moving shapes + 24 wisp head-poses at 5 Hz, JSON coalesced), NOT an idle-room figure — a real booth averages lower across quiet phases.
- Rows that are **wall-clock / GPU / real-hardware** (frame rate, physics ms/s, live hand tracking, sustained Opus voice) are marked **`owner/hardware-pending`** — the sandbox has no representative GPU/CPU and the soak asserts the *logical* invariant instead (bounded ticks, plateaued memory). **They are never faked.**
- The soak is **deterministic**: no `Date.now`/`Math.random` in the harness; per-tier egress + max-tick bytes are byte-identical run-to-run.

**Soak day-export (metrics.exportDay over the 30 sim-min):** 4 rotations · 8 showpieces · 222 votes · 253 real joins · 2 synthetic (daemon) joins · peak watchers **128** (audience at cap) · siege reached **wave 3** (index 2 — the full C27 arc). **Worst single-tick egress:** ~3.5 MB (a RESET rotation boundary fanning ≤ (MAX_SHAPES despawn + baseline spawn) discrete deltas to ~225 sockets — bounded, once per rotation, never a growing backlog).

---

## Row Schema

Each row:
| Column        | Description                                                    |
|---------------|----------------------------------------------------------------|
| `Task`        | Task id that introduces this cost (e.g. C8, C25, C31).        |
| `Item`        | Human-readable name of the cost item.                         |
| `Unit`        | Unit of measurement (e.g. GB, req, min, USD).                 |
| `Est`         | Estimated value (declared by the Tier 6 task at merge time).  |
| `Measured`    | Actual value (filled in at C22 / post-event).                 |
| `Notes`       | Caveats, assumptions, links to source data.                   |

---

## Bandwidth

| Task | Item                          | Unit | Est | Measured | Notes |
|------|-------------------------------|------|-----|----------|-------|
| C8   | WS state delta (resident)     | KB/s per viewer | ~50 | **50.4** (≈177 MB/h) | C22 soak: full-rate ~15 Hz delta over ≤40 moving shapes at §6.5 worst case; spectator identical (50.4). The full-rate tiers — the audience/wisp coalesced tiers are ~0.27× this (the egress invariant) |
| C8   | WS wisp coalesced (~5 Hz)     | KB/s per wisp | ~9 | **12.0** (96 kbps; ≈42 MB/h) | C22 soak: shapes id+pos + 24 head-poses, serialized ONCE per 5 Hz tick, same buffer to all wisps. ABOVE the ~9 KB/s (70 kbps) §7.4 estimate — the JSON coalesced buffer at worst case (40 shapes + 24 poses). At 24 wisps ≈ 2.3 Mbps |
| C8   | Voice audio (opus)            | MB/h | TBD | owner/booth-pending | The headless soak has no sustained Opus senders (voice is headset-to-headset, §6.2) — measured at the booth: max 8 senders, ~24–40 kbps each, resident+authed-spectator fan-out only |
| C25  | Audience egress / viewer      | KB/s | ~8–10 | **13.8** ⚠ | C22 soak-at-cap (127 stable viewers). 5 Hz coalesced world buffer (serialize-ONCE, shared with wisps) + 0.2 Hz AUDIENCE_STATE + cue/glyph/phase/env/theme/stats summaries + `despawn` + the ~10 s keyframe **re-sync** (the C22 carry-#9 fix — was join-only, now a periodic re-sync so a late viewer converges on at-rest shapes; adds ~0.3 KB/s). **ABOVE the ~8–10 estimate**: the JSON coalesced buffer at the §6.5 worst case (40 moving shapes + 24 head-poses) is the driver — NOT a boundary breach (see the cap row). head-only poses only (hand poses would add ~3 KB/s — NOT taken, §7.14) |
| C25  | Audience egress at cap (×128) | Mbps | ~8–10 | **13.8** ⚠ (≈6.1 GB/h) | C22 soak: 13.8 KB/s × 128 ≈ 13.8 Mbps ≈ 6.1 GB/h cloud egress — above the ~10 Mbps / 4.6 GB/h estimate. **The egress INVARIANT HOLDS**: an audience viewer is ≈0.27× a full-rate resident (50.4 KB/s) — NEVER a full-rate delta/pose/voice; the coalesced buffer serializes ONCE per tick regardless of viewer count (marginal per-viewer = raw bytes). Backpressure soak-verified: a stalled socket was disconnected, never wedged the tick. per-IP cap 4 + join bucket cap the unauthed surface. **A binary coalesced encoding would reclaim the overage back under ~10 Mbps — recommended follow-up.** |
| C26  | Caster caption (CASTER_LINE 0x33) | KB/h | ~7 | —      | Indices-only binary frame ~20 B (never a string on the wire); rate-limited to ≤ 1 line / 10 s per room, serialized ONCE and fanned out to spectator/wisp/crowd + the audience attach (per §5.1 attach-if-landed) — negligible marginal egress (≈ 7 KB/h per stream worst case). NEVER a full-rate delta/pose/voice frame (the C25 audience boundary is unchanged) |
| C27  | Siege WAVE narrative (SHOWPIECE 0x27/0x05) | KB/h | ~0.3 | — | INDICES ONLY `{waveIndex, waveEndsAt}` (~40 B JSON; no wave NAME on the wire — resolved client-side from the shared SIEGE_WAVES table). Fires ≤ 3 waves per ≤ 90 s siege + one per late-joiner attach — a handful of tiny frames per siege, fanned out to SHOWPIECE_TIERS (resident/spectator/director) ONLY; NOT to `audience` (the C25 boundary is unchanged — wave PHYSICS + banner ride the existing ENV_STATE, no new egress). The meteor ADMISSION budget (`inFlightMeteors ≤ METEOR_BUDGET = 12`) also CAPS siege world-delta bandwidth — WAVE 3's ×0.25 slow-mo densifies the cloud from lingering, never from more spawns |
| C26  | Caster caption (CASTER_LINE 0x33) — *measured* | KB/h | ~7 | **≈ within est** | C22 soak: the caster fired during PLAY/showpieces (rate-limited ≤ 1 line / 10 s); its ~20 B indices-only frames are folded into the per-tier egress above (< 0.05 KB/s/viewer) — negligible, within estimate |
| C27  | Siege WAVE narrative — *measured* | KB/h | ~0.3 | **≈ within est** | C22 soak drove the full C27 3-wave arc (reached wave 3 / index 2); a handful of ~40 B `{waveIndex, waveEndsAt}` frames per siege, fanned to SHOWPIECE_TIERS only — negligible, within estimate |
| C31  | Clip delivery (HTTP GET, not WS) | — | n/a | **maps bounded** | C22 soak drove `getClip` under load from a rotating-IP pool + `putClip`: the per-IP `_getHits`/`_postHits` and `_roomDayCounts` maps PRUNE and PLATEAU (≤ 12 / 0 / 1 at 30 min ≈ 15-min sizes) — no unbounded growth. A clip is a one-shot HTTP download (§7.20), never sustained WS egress |
| C32  | TK tether (TELEKINESIS 0x34)  | KB/h | ~2 | owner/hardware-pending | C22 soak set the hands latch (TK_HANDS_STATE → cue-registration path exercised, latch memory plateaus at 1/room) but TK pulls are the env-gated (`POWERS_LAB_ENABLED`) hand-tracking exhibit — the tether stream is measured on Quest 2 with live hands (see the Powers Lab render row). Server → stage TETHER `{peerId, pulls:[{hand, anchor, targetId}]}` — anchor + id ONLY, **NO joint streaming** (hand joints never leave the headset; the stage draws the beam + skeleton from anchor + target). Fanned to TK_TETHER_TIERS (resident/spectator/director) ONLY — NOT `audience` (the C25 boundary is unchanged). Sent per tick only while a pull is live (≤ 2 tethers, exhibit-armed windows). Client → server TK_PULL (16 B) rides at pose rate ONLY while pinching — bounded, resident-only |

---

## Compute

| Task | Item                          | Unit | Est | Measured | Notes |
|------|-------------------------------|------|-----|----------|-------|
| C8   | Physics tick (30 Hz × rooms)  | ms/s | TBD | owner/hardware-pending (logical-bound OK) | C22 soak asserts the LOGICAL invariant — 54 000 ticks at cap: world ≤ MAX_SHAPES + pinned (max 34 observed), per-tick work bounded, second-half egress ≈ first-half (no runaway backlog). Wall-clock ms/s is CPU-dependent (sandbox has no representative CPU) — measured on the booth laptop |
| C8   | Persistence flush debounce    | ms   | 2000 | 2000 (config) | 2 s debounce window (fixed config, not load-dependent) |
| C32  | Powers Lab render (Quest hands + tether beam + neon skeleton hands) — **THE ENV-FLAG GATE** | fps | ≥ 72 | owner/hardware-pending | **`POWERS_LAB_ENABLED` STAYS OFF until the owner fills this Measured cell.** (C22 soak exercised the server-side latch + `tickPowersLab` loop only — the render fps is a Quest-2 measurement, never a sandbox number.) §6.5 / §7.21 measurement condition: **hands reported + a TK pull mid-flight + representative PLAY load** (40 shapes + 8 avatars + crowd) on **Quest 2** → **≥ 72 fps, no frame > 20 ms**. NEVER an idle-room number. Render sub-budget (§6.5 Tier-6 line): **2 instanced joint meshes** (spheres + bones per wearer hand), **ZERO dynamic lights**, + the neon tether fat-line. Hand-joint polling is per-frame in the headset only (never streamed). Server-side per-tick pull force is O(≤ 2 pulls) — a titan-class loop force, negligible tick cost. Once measured ≥ 72 fps with no frame > 20 ms, the owner sets `POWERS_LAB_ENABLED=1`; a failure keeps the exhibit OFF (degrade-not-break). |

---

## Storage

| Task | Item                          | Unit | Est | Measured | Notes |
|------|-------------------------------|------|-----|----------|-------|
| C8   | WorldBucket per room          | shapes | ≤ 40 | **≤ 34 observed** | C22 soak: world plateaus at ≤ MAX_SHAPES (40) + pinned; recycle-oldest holds it bounded (24 → 33 → 34 over t=0/15/30 min). KB = count × ~0.1 KB → ≤ ~4 KB |
| C8   | GuestbookBucket per room      | glyphs | ≤ 512 | **110 (bounded)** | C22 soak: guestbook grew 64 → 90 → 110 (seeded openers + 40 GLYPH_SEED + crowd adds), plateauing well under GLYPH_CAPACITY 512 (evict-oldest; seeded exempt). Never wiped by rotation RESET |
| C8   | DayStatsBucket per room       | KB   | small | small | leaderboard + counters only; wiped at day close after the Closing Ceremony export |

---

## Third-Party / API

| Task | Item                          | Unit | Est | Measured | Notes |
|------|-------------------------------|------|-----|----------|-------|
| —    | Cloudflare Tunnel             | USD  | $0  | —        | free tier sufficient       |
| —    | TLS cert (Let's Encrypt)      | USD  | $0  | —        | free; 90-day renewal       |

---

## Day Summary Template

*(Fill in after C22 / each event day)*

| Date | Rooms | Peak Concurrent | Total Joins | WS MB | Voice MB | Notes |
|------|-------|-----------------|-------------|-------|----------|-------|
| C22 soak (30 sim-min) | 1 | 8 residents + 128 watchers (cap) | 253 (+2 synthetic) | ~4900 (full 30-min, all tiers) | owner/booth-pending | Deterministic sandbox soak: 4 rotations · 8 showpieces · 222 votes · siege reached wave 3. Egress totals are the SUSTAINED §6.5 worst case (a real booth day averages lower) |
| —    | —     | —               | —           | —     | —        | (first real booth day) |

---

*Tier 6 tasks: append your declared Est rows to the relevant section at merge time.*
*C22: fill in the Measured column from the `metrics.exportDay()` export.*
