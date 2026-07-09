# Closing Ceremony — cyber-shapes-vr

> The end-of-day script (spec design doc §2 "The World That Remembers": *"the day
> ends with a scripted Closing Ceremony"*). This is the SCRIPT; the operational
> checklist underneath each beat (file paths, TTL verification, bucket export)
> lives in `RUNBOOK.md` → **Day Close (post-event)** — this file does not
> restate that. Run it at `T_close−15` per `RUN_OF_SHOW.md` FRONT.

---

## 1. Staff Cue

With the current rotation's visitor still in-headset (or just after their
FINALE), staff announces the booth is closing for the day. Let the CURRENT
rotation finish its natural STATS/RESET — do not cut it short.

## 2. Final Encore

Fire the finale cue one last time for the day. As-built this is the `supernova`
cue (`packages/server/src/dials.ts`, label **SUPERNOVA** — the built-in finale
cue per `RUN_OF_SHOW.md`'s `[if C19 → SUPERNOVA]` annotation; C19 landed, so this
IS the finale on every rotation, not just the closer). Let it run its full
pull → hold → detonate script (`SUPERNOVA_PULL_MS` + `SUPERNOVA_HOLD_MS` +
`SUPERNOVA_DETONATE_MS` = 2.5s + 0.8s + 3s ≈ 6.3s) and land the
`you-all-just-wrote-that` narration line (see `RUNBOOK.md` → Staff Narration
One-Liners) — same beat as every rotation, just make it the LAST one.

## 3. Attract Glyph Tour

Drop the room to ATTRACT. **Honesty note:** there is no dedicated
"scripted camera walk through every glyph" shot built (no `GLYPH_TOUR` kind
exists in `packages/client/src/stage/stage.ts`'s `Shot` union — only
`WIDE_ESTABLISH` / `FOLLOW_THROW` / `JOIN_CRANE` / `GLYPH_BIRTH` /
`CRYSTAL_CAM` / `WORM_EYE` / `POWERS`). What IS real and already wired: ATTRACT's
own auto-director fires a `GLYPH_BIRTH` camera shot toward the newest glyph as
part of its ambient rotation, and the Ghost Arcade replay plays alongside it.
Let ATTRACT run for **60–90 s** while staff narrates over it — this doubles as
the day's glyph showcase even though it is the ambient behavior, not a bespoke
walkthrough:

> *"Every glyph you see scattered around this room is something a real visitor
> left today — hundreds of people came through, and every one of them is still
> here."*

(A dedicated glyph-by-glyph tour is a reasonable Phase D follow-up — flagged,
not built here.)

## 4. Day-Total Stats Card

Fire the room's STATS phase (or let the last rotation's STATS stand) so the
**`StatsCard`** (`packages/shared/src/cues.ts`) renders once more with the
`dayLeaderboard` populated from the persisted `DayStatsBucket` — this is the
"day total" the crowd sees on the big screen: total shapes thrown, fastest
throw of the day, top contributor of the day (callsigns only, spec §6.1).

## 5. Export + Permalink Instructions

1. Pull the day counters: `GET /api/metrics/day` (see `RUNBOOK.md` → Monitoring
   / Day Close) → save the JSON. This is the `metrics.exportDay()` snapshot —
   a pure read, safe to call before or after the stats card above.
2. Follow `RUNBOOK.md` → **Day Close (post-event)** steps 2–8 in order
   (`onDayClose`, TTL/eviction verification, LAN-day bucket export → cloud
   import if applicable, `metrics.resetDay()`, clip sweep).
3. **Post the permalink** to the club Discord: *"Today's world is still live at
   `<permalink>` — it stays online, come see what everyone built."* This is the
   promise the exit screen's retention copy makes to every departing visitor
   (spec §5.7 `EXIT_COPY.online` / `.lan`) — the Closing Ceremony is where staff
   makes good on it publicly.
4. **Clips Discord post (C31, F20 Neon Clip Machine):** if today ran the
   no-uplink rung at any point (clips banked locally because `POST /api/clips`
   failed), this is the manual post the "your clip posts to the club Discord
   tonight" copy promises — see `RUNBOOK.md` → Neon Clip Machine → "No-uplink
   rung". Attach/re-upload the banked clip(s) alongside the permalink post from
   step 3 so it reads as one announcement.

---

*Ships alongside `RUNBOOK.md` (HOW during the day) and `RUN_OF_SHOW.md` (WHEN) —
none of the three restates another.*
