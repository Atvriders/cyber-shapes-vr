# RUN OF SHOW — one laminated sheet, two sides

*WHEN things happen. HOW lives in `RUNBOOK.md` — each links the other, neither restates it. Narration lines appear by LABEL only; text lives in the runbook. Ships to `docs/booth/RUN_OF_SHOW.md` via plan C23; C24 Step 2 executes the rotation table once per topology. Rows naming a Tier ≥ 2 feature carry an `[if landed → fallback]` annotation — skipped, not failed, under any cut depth.*

## FRONT — the day skeleton (relative anchors; fill in venue times: doors open ___ , doors close ___ )

| T | Action |
|---|---|
| T−60 | Boot per RUNBOOK order. Preflight ALL GREEN (LAN + tunnel, cert, RTT, autoplay, mic/speaker policy). Note topology: tunnel / LAN. |
| T−45 | Verify hero-reel bank loaded (recorded pre-event per RUNBOOK checklist — never record-on-site); attract ballet fallback plays; optionally bank one venue take. **Trigger one RESET: confirm the showroom baseline restores [Workshop layout if C34 → constants seed list] and seeded glyphs render.** |
| T−30 | QR poster up + scan test from a phone on cell data; speaker level set; headsets A+B charged, covers stocked; staff phone console paired; print owner link stowed. |
| T−15 | Idle in ATTRACT [reels if landed → ballet]. Walk the 5-meter check: QR scannable, type legible. |
| T−0 | **Doors.** Post the watch link to club Discord + department channel [if C25 landed]. Booth runs itself; staff works the line. |
| hourly | Rhythm: rotation ≈ 6.4 min + ~45 s headset handoff ⇒ **~8–9 rotations/hour (2 volunteers, A/B sanitize overlapped)**, **~7/hour solo** (sanitize serialized during STATS+RESET). Visitors: **~8–9/hour with the A/B one-always-charging rotation; up to ~16–18/hour with both headsets in service** (charge at lulls/lunch). Derivation: Σ `PHASE_DURATIONS_MS` = 45+180+30+90+30+10 s = **385 s** — if C5's constants retune, this sheet is stale (C23 Step 5 reconciles). |
| lunch lull | Drop to ATTRACT + Guestbook pitch ("leave your mark — 10 seconds, no app") [glyphs if C12 landed]; one staff break at a time; headsets both on charge. |
| T_close−15 | **Closing Ceremony** per `CLOSING_CEREMONY.md`: final Encore [if C19 → built-in finale cue] → glyph tour [if C12] → day-total stats card → permalink posted to Discord. |
| T+15 | `metrics.exportDay()`; tunnel day: done. LAN day: bucket export → cloud import (world + guestbook + day-stats + clips [if C31] + layouts [if C34]) so the permalink promise survives; verify the booth roomId survived TTL/eviction (RUNBOOK post-event step). |

**Solo-volunteer delta:** sanitize during STATS+RESET; expect ~7/hour; skip narration labels `ghost-reveal` and `re-sim-flex`; auto-cues and auto-arm carry the show — your job is helmets, hygiene, and the panic key.

## BACK — the canonical rotation (time = elapsed from LOBBY start; wall clock lives on the front)

| Elapsed | Phase (C5 constant) | World & screen | Crowd/phones | Staff (labels → RUNBOOK) |
|---|---|---|---|---|
| −0:45→0:00 | ATTRACT → handoff | Ghosts/ballet + QR CTA | Scan → glyph [if C12] / ballot [if C15] / wisp [if C14] | Helmet the next visitor; **Space when helmeted** (ATTRACT exits on first human resident join) |
| 0:00 | LOBBY (45 s) | Join ceremony; wisp fanfares [if C14 → join banner only] | Wisps materialize [if C14] | Greet; `one-socket` label for CS visitors |
| 0:45 | PLAY (180 s) | Free play; auto-cue ≈ every 90 s; Resonora score [if C18]; replay interrupts [if C21]; captions [if C26]; x-ray on request [if C29, label `x-ray`] | Pulses [if C14], votes [if C15], glyphs [if C12] | Nothing required. Optional: hotkeys 1–9/0 shot override |
| 3:45 | OVERLOAD (30 s, +60 s hold if siege auto-arms) | Klaxon build; red pulse in-headset | Siege slingshots [if C16; waves if C27 → dial cue fallback] | Watch comfort; VETO available |
| 4:15* | FINALE (90 s) | Encore charge → orb → drop [if C19 → SUPERNOVA, the built-in finale cue]; Titan alternative [if C17, label `titanize`] | TAP-to-charge; phones flash [if C19] | `phones-up!` label; fire override F if needed |
| 5:45* | STATS (30 s) | Stats card + "NEXT IN THE HEADSET?"; clip QR [if C31, label `take-your-clip`] | Scan clip QR; exit screen | Begin headset swap + sanitize |
| 6:15* | RESET (10 s) | World → showroom baseline (glyphs persist) | — | Finish swap |
| 6:25* | → ATTRACT | Ghosts return | Line resets | Next visitor forward |

\* these rows shift **+60 s later** when the OVERLOAD siege hold engages (FINALE at ~5:15).

**RUSH PROTOCOL (staff override, never the default):** Space-skip STATS after the clip QR beat; H to hold a hot rotation; shortens cycle to ~5 min. Use for long lines only — the stats/clip beat is the recruitment close.

**Panic key** (console + stage): hides all names/newest glyphs/captions instantly. **VETO** reverts any physics law. Both always available; see RUNBOOK.
