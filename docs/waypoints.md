# Waypoints

"I am here, now", stamped into the ride log from the handlebar's indicator-cancel long press, the phone's own button, or a Siri Shortcut. Related: `src/gps/waypoint.ts` (the gates and the counters), `src/http/waypoint.ts` (the HTTP shell), `docs/handlebar-gestures.md` (the long press that saves without HTTP), `docs/route-map.md` (the dashboard it is drawn on), `public/lib/bounds.js` (the client gate), issues #157 and #165.

No coordinates appear in this file, for the reason `docs/route-map.md` gives under _No coordinates anywhere_. Where one is unavoidable — the corrupt longitude below — it is quoted because it is the evidence, and it is not a place this bike has ever been.

## What a waypoint is on the wire

Three ordinary signals written together with one timestamp, so nothing about the log format or `scripts/decrypt-log.ts` needs a special case:

| signal         | what                                                      |
| -------------- | --------------------------------------------------------- |
| `waypoint_seq` | which waypoint this is **since the service last started** |
| `waypoint_lat` | latitude, copied from the live fix                        |
| `waypoint_lon` | longitude, copied from the live fix                       |

The position is **copied** rather than left implicit in whatever `gps_lat`/`gps_lon` row happens to sit nearby, because those carry a ~3 m deadband: at a standstill the last logged fix can be minutes old while the live one is current. That copying is also what makes the gate below subtle, so it is worth holding on to.

**`waypoint_seq` restarts at 1 with the service.** `lastLogged` in `src/can/signals.ts` is per key _and_ per process, so the counter starts over on every restart and the log contains repeats — three rows carry `1` in the 2026-08-09 → 2026-09-07 archive, from three different boots. It is a marker, not a key. The sheet's tile shows it as `#N` next to the time, and the route map's table repeats it without apology.

**A repeat of the same position logs nothing but the sequence.** `record()` suppresses a value equal to the last one it logged, and `waypoint_lat`/`waypoint_lon` carry no deadband, so two saves from the same live fix — two presses inside one GPS gap, which is guaranteed while the fix is under `FIX_MAX_AGE_MS` and no new sample has arrived — write only `waypoint_seq`. Anything reading waypoints back must therefore resolve each coordinate as _the last value logged at or before that timestamp_ rather than pivoting the three signals on their shared millisecond. That recovery is exact, not approximate: the coordinate was suppressed precisely because it was equal.

⚠️ That lookup has **no lower time bound**, and it cannot have one — a suppressed coordinate matches a save that may be hours earlier in the same boot. In a complete log it can only ever reach the suppressed row's twin, because the first `record()` of any key after a restart always logs (`lastLogged` starts empty). In an **incomplete** one — a partial decrypt, a truncated download — it can reach across that boundary and pair a sequence with an older boot's position. The `no position logged` verdict is therefore effectively unreachable and exists as a guard rather than as a state anyone has seen.

**The deeper fix, not taken here.** All of the above — the carry-back rule, its cross-boot hazard, and the fact that every future reader of waypoints has to reimplement it — exists because `record()` suppresses an equal value for a signal whose repeats are the point. `SignalDef` already carries `onDemand`; not suppressing for those signals, or an explicit `alwaysLog`, would make every waypoint self-contained in the log and delete the rule from this query and from anything else that ever reads them back. It is a change to the logging path for every on-demand signal, so it wants its own issue rather than a corner of a dashboard PR.

## The 2026-08-09 waypoint, and why nothing on the bike could tell

Of the six waypoints in the archive, one sits about 7 000 km from where the bike stood. The chain:

| time (UTC)   | what                                                                  |
| ------------ | --------------------------------------------------------------------- |
| 15:37:04.595 | `gps_lon` logs `130.303698…` — the decoder's own value                |
| 15:37:04.743 | the endpoint copies the live fix into `waypoint_lat` / `waypoint_lon` |
| 15:37:05.136 | `gps_lon` logs `13.037036…` — corrected, 541 ms after the corrupt row |

**The endpoint did exactly what it promises**: it copied the live fix, and the live fix was wrong for about half a second. The corruption is a longitude carrying an extra leading digit, the same failure `docs/route-map.md` records for the track; the archive holds eleven such single-fix excursions, five in `gps_lon` and six in `gps_lat`.

**Nothing the server could see said anything was wrong.** At that moment `gps_fix` was 1, `gps_satellites` 11, and `gps_speed_kmh` 0 — a parked bike with a healthy fix. There is no quality flag to gate on, and `130.3` is a perfectly legal longitude, so no range test can see it either. The only witness that the fix was wrong is _another fix_.

## What each gate can see

Four gates now exist, and they are not interchangeable.

| gate | catches | cannot see |
| --- | --- | --- |
| `src/gps/fix-plausibility.ts`, ±90 / ±180 | a decode that leaves the planet | anything that is still a legal coordinate |
| `public/lib/bounds.js`, the same four signals | the same, on the dashboard, as a visible fault | the same |
| `src/gps/fix-plausibility.ts`, the implied-speed test | a legal coordinate the bike cannot have got to | a bad FIRST fix, which has nothing to be compared against |
| the route map's corroboration test | a position the surrounding track contradicts | excursions under 0.5°, and unwitnessed saves |

**The bike can now refuse the 2026-08-09 case itself.** #165's gate landed with the server-side handlebar gestures: the fix is measured against the one before it, and anything implying more than 300 km/h — `bounds.js`'s own ceiling for `gps_speed_kmh`, read from it rather than copied — is refused before the save. Two things bound it, both of them lessons this repo had already paid for: the two fixes must be at least 1 s apart, because `docs/route-map.md` records an implied-speed test with a short denominator reading 7 m in 1 ms as 25 000 km/h; and one spike costs **two** refusals, itself and the good fix after it, which is the right side to fail on.

⚠️ The range gate moved out of `src/http/waypoint.ts` with it. The endpoint is a shell now: `src/gps/waypoint.ts` owns every gate and both counters, because a handlebar hold saves without going through HTTP at all. `docs/handlebar-gestures.md` has that half.

### How a refusal reaches the rider

It used to be the reply to the request the phone had made. A hold on the bars asks nobody, so a refusal now travels as two signals — `waypoint_refused_seq`, a monotonic count, and `waypoint_refusal`, one of the seven `WAYPOINT_REFUSAL` codes — and `public/lib/announce.js` turns the code back into the sentence that used to come off the reply. A **counter**, because `record()` seals a row only when a value moves: two identical refusals in a row would otherwise be one banner, and the second hold at the same spot with the same stale fix would look like it had worked.

### The corroboration test

A waypoint is a **copy of a fix**, so the nearest logged fix on each side of it must agree with it. Per axis, because `gps_lat` and `gps_lon` are deadbanded independently — on 2026-08-09 the latitude's nearest witness was 19 minutes old while the longitude's was 148 ms. A witness that does not exist raises no objection.

**The skew is the whole gate.** A waypoint copies liveState, and the coordinates carry a 3 m deadband, so _the fix logged immediately before a waypoint is the fix the waypoint copied_. On 2026-08-09 the previous `gps_lon` row is byte-identical to the waypoint. Comparing against it is not a weak test, it is not a test at all.

Precisely what the skew buys, because a first draft of this paragraph overstated it: **over the whole archive the 2026-08-09 row is caught either way**, since the corrected fix 393 ms later objects on its own. It is at the **end of data** that the skew is the only thing left — a bike switched off straight after a corrupt fix has no later fix at all, and the before-side witness is then the entire gate. Measured on the archive truncated at that waypoint's own millisecond: with the skew, `contradicted` from a witness 1 690 s old; without it, `on track` from a witness 0 s old, which is the corrupt fix vouching for itself. With the skew the five good waypoints keep witnesses 5 s away on either side.

The two constants:

- **Skew, 5 s.** Above the lifetime of a corrupt fix — one row, corrected after 541 ms, and a value can only be copied while it is still live — and far below any distance that matters: 5 s at 200 km/h is 278 m against a threshold of tens of kilometres.
- **Window, 30 min.** Bounded **below by the archive**: catching the corrupt waypoint from the _before_ side needs a witness 1 690 s old. That is what makes the gate work at the end of data — a bike switched off straight after a corrupt fix has no later fix to be caught by, and truncating the archive at the waypoint's own millisecond still yields `contradicted`. ⚠️ The margin is 6.5 %: at 28 minutes that case is lost, and it rests on a single row. Bounded **above** by the only way a witness gets that stale — at a 3 m deadband and roughly 1 Hz, no logged fix for 30 minutes means the bike did not move, _or_ the hub slept. Only the second can hide real movement, and a bike carried more than 0.5° inside a sub-30-minute sleep is the residual false positive. It lands in the table as `contradicted` rather than silently on the map.
- **Threshold, 0.5°** — 55.7 km in latitude everywhere, and 30–41 km in longitude across the 42.6–57.9°N this archive spans, since a degree of longitude shortens with the cosine. A waypoint copies a fix at most `FIX_MAX_AGE_MS` old, so at 200 km/h it is under 2 km from the truth and a witness within the window adds at most a few more.

**Each axis needs its own witness.** An axis with no witness in the band is an axis that is not gated at all: its comparisons resolve against the waypoint's own value and object to nothing, so the other axis alone would carry the row to `on track`. The archive holds the case — at the 2026-08-08 03:16:58 latitude spike (2.016°, about 224 km) there are **0 latitude witnesses and 5 longitude witnesses** inside the 5 s…30 min band. Run through the verdict logic, a waypoint saved on that fix reads `on track` under an all-four-missing rule and `no witness` under the per-axis one. So the rule is per axis, and it costs the six real waypoints nothing: still five `on track` and the 2026-08-09 row `contradicted`.

**What it cannot see.** 0.5° is a coarse instrument — 30 km at worst. `docs/route-map.md` records single fixes that jump 0.3 km, 1.4 km, 4.8 km and 420 km out and back; **only the last of those is visible here.** A waypoint built on one of the small ones is drawn as `on track` and looks perfectly ordinary. Likewise, an axis with no witness inside the window is an axis that is not gated at all — which is why `no witness` is a verdict of its own rather than silence, why it is decided per axis, and why the map draws only `on track`.

**A refuted alternative, so it is not re-derived.** Witnessing against the route query's own despiked `clean` CTE looks stronger and is not. It still returns `on track` on the end-of-data case at both ±30 min and ±6 h spans, because a corrupt fix with no successor cannot be shown to be a spike and so survives into the witness set to vouch for itself; it costs 0.77 s / 2.01 s against 0.022 s; and its `LAG`/`LEAD` over a union of per-waypoint neighbourhoods makes a row's successor depend on which _other_ waypoints are in the window — at ±6 h one row's successor was a fix 28.5 days later. The skew guard needs no window functions at all.

**A refuted window derivation, for the same reason.** A first draft justified a 60 s window with a measured near-miss: a corrupt fix 110 s after a good waypoint, which at ±120 s would have destroyed it. That number is real and it constrains nothing, because the query takes the _nearest_ witness and something closer always lies between. Swept from 1 s to 24 h, the verdicts are identical at every window size in this archive. What the window actually decides is how stale a witness may be before it stops being evidence.

## Where a waypoint can be seen

- **The route map** (`grafana/dashboards/route-map.json`, uid `cool-eva-route-map`) — stars on the map, and a table under it listing every waypoint in the window with its verdict.
- **The dashboard's menu sheet** — the Waypoints tile shows the last saved position and the time, with `#N` for the count so far. Because `waypoint_*` live only in the server's `liveState`, a service restart empties them: the tile then reads **"none since restart"**, which is the thing the old bare `0` got wrong — it claimed a ride had saved none when the truth was that nobody could tell. A page reload keeps it (`src/ws.ts` sends the full snapshot on connect); a service restart does not.
- **The ALL tab** — `waypoint_lat` / `waypoint_lon` to six decimals, and a rejected coordinate as a fault rather than a position.

There is still no GPX export.

## The refusals, and what the rider hears

`GET /waypoint` always answers **200**, refusal included: Siri surfaces a non-2xx as a generic shortcut failure and never speaks the body, which is the one outcome where being told matters most. Five branches, five sentences — two branches share the first one:

| when                                             | what it says                                                 |
| ------------------------------------------------ | ------------------------------------------------------------ |
| no fix has ever arrived                          | "No GPS fix yet"                                             |
| the signals are present but never marked as seen | the same sentence — it cannot happen, and is loud if it does |
| the fix is not a position on Earth               | "GPS fix is not a real position (…)"                         |
| the fix is older than 30 s                       | "GPS fix is N seconds old"                                   |
| the clock has never synced, or is contested      | two sentences, worded apart: one is waited out, one is not   |

`scripts/check-waypoint-endpoint.ts` asserts three of the five sentences. The 30-second one is out because its age comes from a monotonic mark taken inside `record()`, so reaching it means waiting 31 real seconds against a suite that runs in ten; "the clock disagrees" is out because it needs the gate to reach `contested`, which takes a corroborated time contradicting one already trusted — `scripts/check-gps-clock.ts` drives that gate directly and is the place for it.

## An open question worth not losing

The one corrupt waypoint is an unlikely coincidence. Eleven corrupt fixes across 132 319 awake seconds is 8.3 × 10⁻⁵ per second; six waypoints have ever been saved, and one of them landed on one — about **1 in 2 000** if the two are independent.

The obvious mechanism is that pressing the handlebar button disturbs the GPS decode. **The archive does not support it.** Counting spikes within ±5 s of a `buttons`-group row: 2 of 11 over the whole archive against a 6.75 % background (p ≈ 0.17), or — honestly, since the buttons were only decoded from 2026-08-19 and 8 of the 11 spikes predate that — 2 of 3 over the buttons era against a 20.1 % background (p ≈ 0.105), which at millisecond rather than whole-second resolution is 1 of 3 (p ≈ 0.49). Nothing there.

So: one suggestive number and one refuted explanation. Two mechanisms nobody has tested are whether the spikes cluster with `/waypoint` requests (no signal records an HTTP request, so this needs a log line added first) and whether they cluster with the ride log's fsync or the WebSocket's snapshot heartbeat. Both are cheap to instrument next time the Pi is in reach.
