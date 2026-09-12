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

The position is **copied** rather than left implicit in whatever `gps_lat`/`gps_lon` row happens to sit nearby, because those carry a ~3 m deadband and the last logged fix can therefore be older than the save. That copying is also what makes the gate below subtle, so it is worth holding on to. ⚠️ This used to read "minutes old at a standstill — exactly when you stop to save a waypoint"; the handlebar hold inverted that premise and the staleness implies no position error anyway. Both, measured: §"Recovering the holds the phone dropped" below.

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

## Recovering the holds the phone dropped

`scripts/recover-waypoints.ts` reconstructs, from a decoded ride log on the laptop, the waypoints a handlebar hold asked for and never got. It never runs on the Pi, never opens a socket, and is `--dry-run` by default with a read-only handle until `--commit`. The rules are pure and live in `src/gps/recover-holds.ts`; `scripts/check-recover-waypoints.ts` drives every one of them from synthetic rows.

**It reproduces what the bike would have done, gate for gate** — the gates are imported from `src/gps/waypoint.ts` and `src/gps/fix-plausibility.ts` rather than restated. A recovery stricter than the bike invents refusals the rider never had; one that is looser invents waypoints.

### Two different losses, and they are not the same bug

| day | holds ≥ 500 ms | already live | refused | recoverable | why they were lost |
| --- | --- | --- | --- | --- | --- |
| 2026-09-07 | 14 | 5 | 1 (stale fix) | **8** | the phone recognised the hold and a hidden page dropped it (#166) |
| 2026-09-08 | 0 | — | — | **0** | one 0.250 s tap all day; nothing to recover |
| 2026-09-09 | 32 | 28 | — | **4** | the Pi recognised it, and the **beat** dropped it |

⚠️ **The 09-09 losses are #197's defect, caught in the field before it was diagnosed on the bench.** Recognition had already moved to the Pi, so these are not the phone's fault. All 28 waypoints the bike did save that day pair to a hold with a fire delay in **1000–1145 ms**, bimodal at 17 × 1000–1024 and 11 × 1100–1145 — the two beats of the 100 ms cadence then in force. The four that fired nothing are **1.030, 1.019, 0.930 and 0.714 s**: every one a press that ended _before_ the beat that would have fired it. The band is the finding. There are **zero** `waypoint_refused_seq` and `waypoint_refusal` rows in the whole day, so these never fired rather than firing and being refused.

⚠️ **That pairing was got wrong twice before it was got right**, both times by matching a waypoint to the _nearest_ hold rather than forward in time — which lets one waypoint excuse several holds. It first reported 3 losses, then 4 with the wrong fourth. The fire delays are their own proof: a wrong pairing does not produce a tight bimodal band at the beat.

### The five rules, each of which was a wrong answer first

1. **Pair presses within one `session_id`, ordered by `(session_id, seq)`** — not by `ts`, which is wall clock the Pi steps (`src/db.ts`).
2. **A press opens only on a watched 0→1.** `record()` always logs a key's first value in a process, so a restart-heavy day writes one baseline row per boot; a session whose first row is already `1` never watched the press begin. This is `src/gestures/long-press.ts`'s own `state.previous === 0`, and enforcing it moved 2026-09-07 from 15 holds to 14.
3. **A press still open when a session ends is discarded**, not closed by the next boot's first row.
4. **Freshness is witnessed by `gps_epoch_s`, never by the position rows** — see below.
5. **The position is the last `gps_lat`/`gps_lon` row at or before the fire instant.**

### Why carry-back is exact, and why the obvious gate was wrong

`src/can/signals.ts` logs a sample when `Math.abs(value - prev) > deadband` where `prev` is the **last logged** value. So the live fix can never differ from the carried-back row by more than one deadband — **at any row age at all**. That is ≤ 3.34 m in latitude everywhere; in longitude it grows towards the equator, so the latitude-free 2-D ceiling is **≤ 4.72 m**, and **4.14 m** across the 41–44°N the calibration ride spans. (An earlier draft quoted 3.85 m, which is the figure at 55°N — a latitude this ride never reached, and wrong in the unsafe direction.)

Measured against the 28 waypoints the bike really saved on 2026-09-09 — the only ground truth there is, since each was written from the live fix — carry-back reproduces **22 of 28 exactly, worst 3.5 m**, inside that bound.

### ⚠️ But carry-back is not the error a recovered point carries

🚨 **The number above flatters the result and two drafts quoted it alone.** Carry-back fidelity asks _"at the instant the bike wrote this, does the last logged row reproduce it?"_ A recovered waypoint has no such instant — the script has to **choose** one, and that choice is the dominant error, an order above the carry-back bound.

**Two populations, and one rule for both is wrong for one of them.**

- A hold that **cleared the 1000 ms threshold then in force** was already recognisable when it was made. The phone's hidden page, or the beat, is what lost it — so the place it belongs is where the bike would have written it.
- A hold **shorter than that** was never going to be saved by anything then in force, has no such instant, and belongs where the **new** 500 ms rule fires.

`fireInstant()` splits on exactly that, and the ground truth discriminates sharply. All 28 waypoints the bike really saved on 2026-09-09 came from holds of **1141 ms or longer**, so they test the first population directly:

| fire instant                                         | exact        | median    | worst  |
| ---------------------------------------------------- | ------------ | --------- | ------ |
| `pressStart + 1000` — where the old rule fired       | **21 of 28** | **0.0 m** | 15.0 m |
| `pressStart + 500 + beat` — where the new rule fires | 3 of 28      | 10.6 m    | 19.6 m |

⚠️ **A draft shipped the second rule for both populations and put seven of the twelve recovered points 11–19 m adrift.** It survived review once because `--validate` measured carry-back at each live waypoint's _own_ timestamp and so was structurally incapable of seeing a placement error at all. Both numbers are printed now, with the larger named as the real bound.

⚠️ **And a `beatMs` parameter added in between changed nothing.** `+500` and `+600` agree to the digit on every statistic, because the deadband only logs a fix about every 550 ms — a 100 ms shift lands on the same row for 12 of 14 holds. A knob that moves no point is not a fix.

**What a recovered point is actually worth:** for a hold past the old threshold, the same ~4 m as a live one. For a shorter hold — three of the twelve — about **20 m**, which is the honest cost of recovering a press that no rule then in force would have caught.

🚨 **An earlier draft gated on `rowAge × speedAtThatTime` above 50 m. That was wrong in kind and is deleted.** The two axes are deadbanded independently, so an old `gps_lat` row means latitude is not changing — it multiplies a speed in one axis by an age in the other. Worse, at a 3 m deadband a bike at 100 km/h forces a row every ~0.11 s, so **a large row age is evidence of low speed**, and the gate fired hardest exactly where it was most wrong. It refused two of the bike's own 28 waypoints (estimating 97.1 m and 57.2 m against true errors of 3.5 m and 1.5 m) and one real candidate at an estimated 73.8 m. It was invented for a failure that cannot happen.

What the deadband bound **cannot** see is a receiver that went silent while the bike kept moving — and that is the one gate kept: `gps_epoch_s` age ≤ `FIX_MAX_AGE_MS`. It is what refuses the 2026-09-07 09:02:20 hold, which sits inside an 85-minute GPS silence.

⚠️ **The premise this corrects, which had been in `src/can/registry.ts` since the phone era.** That file argued the position is copied into its own signals because the last logged fix "can be minutes stale at a standstill — exactly when you stop to save a waypoint". The handlebar hold **inverted** that: **13 of 14** holds on 09-07 and **4 of 4** recoverable on 09-09 were made at **30–119 km/h**, because the whole point of a bar button is that your hands stay on the bars. `docs/handlebar-gestures.md` already recorded the same fact from the other side — 749 of 779 cancel presses above 3 km/h. The copying is still right; the reason was not. And "stale" implied an error that does not exist: the one waypoint of the 28 saved at a standstill had a `gps_lat` row **21.8 s** old and a carry-back **3.5 m** from what the bike wrote.

**Three reporting additions are outstanding**, tracked in #212: each recovered point's corroboration verdict in the report, a "both axes stale while the speedo says moving" line, and a per-waypoint fixture for the 28-row calibration. None changes a written coordinate.

### ⚠️ The jump gate mostly declines to judge

`implausibleJumpKmh()` returns `null` below `MIN_FIX_INTERVAL_MS` = 1 s, and this hub delivers fixes at ~1.8 Hz: **32 576 of 33 833 fix pairs on 2026-09-09 (96.3 %) are closer together than the gate's own floor**, and all four candidates sit in gaps of 546–915 ms. The gate fails open on every one of them.

That is faithful — the bike ran the same gate against the same cadence — but a report that printed "cleared the jump gate" would be claiming a test that never ran. So the verdict carries `jumpGateJudged` and the report prints **not judged** rather than _passed_. Fix pairs are also formed the way `onFixChanged()` forms them — a pair at every `gps_lat` **or** `gps_lon` row with the other axis carried back — because pairing consecutive rows of one axis feeds the gate pairs the bike never held.

The gate that does cover this class is downstream and already exists: the route map's corroboration verdict, which is why inserting and then _looking at the map_ is part of the check rather than a nicety.

### Provenance: the session, not a new key

Recovered rows are ordinary `waypoint_seq`/`_lat`/`_lon` written under a session uid of `recovered-192-<runId>`, and the route map's two panels gained a `LEFT JOIN session` and a `Source` column that reads `live` or `recovered`.

Distinct `waypoint_recovered_*` keys were the first design and were dropped: both panels select the literal `'waypoint_seq'`, so new keys would have been invisible to the map without a second copy of a sixty-line query — for eleven points. The session is per-reading, already joinable, and makes a whole run reversible with one `DELETE`.

⚠️ **The cost, stated rather than discovered:** a reader that ignores sessions sees a recovered waypoint as a live one.

### Not losing the ride log

`rides.db` is backed up and the copy verified by **size and md5** before a writable handle is opened at all; every pre-existing signal is checksummed before and after, **inside the transaction**, so a mismatch rolls the write back rather than reporting it once it is too late. ⚠️ It did not always: the first version checked after the transaction had committed _and_ after the handle had closed, which left a bad write in place and swallowed the undo statement the caller prints only on success. The three signals the recovery writes are checked too — they must have grown by **exactly** the number of waypoints claimed — where the first version skipped them entirely and echoed the caller's own count back as if it had verified it. A count would not do — it catches an added or deleted row and **misses a modified one**. SQLite has no `md5()`, so the checksum streams the rows and hashes them in JS.

⚠️ Two things worth knowing before running this: `rides.db.bak-20260816-155629` and `rides.db.bak-20260908` are **both 269 234 176 bytes and both dated 16 August**, against a live file of 755 228 672 — the second is misnamed and neither is current. And there is **no 2026-09-07 `.celog` on the laptop**, so `rides.db` is the only copy of the day being recovered: rows inserted into it do not survive a rebuild from logs, because the logs for that day are not here.

## An open question worth not losing

The one corrupt waypoint is an unlikely coincidence. Eleven corrupt fixes across 132 319 awake seconds is 8.3 × 10⁻⁵ per second; six waypoints have ever been saved, and one of them landed on one — about **1 in 2 000** if the two are independent.

The obvious mechanism is that pressing the handlebar button disturbs the GPS decode. **The archive does not support it.** Counting spikes within ±5 s of a `buttons`-group row: 2 of 11 over the whole archive against a 6.75 % background (p ≈ 0.17), or — honestly, since the buttons were only decoded from 2026-08-19 and 8 of the 11 spikes predate that — 2 of 3 over the buttons era against a 20.1 % background (p ≈ 0.105), which at millisecond rather than whole-second resolution is 1 of 3 (p ≈ 0.49). Nothing there.

So: one suggestive number and one refuted explanation. Two mechanisms nobody has tested are whether the spikes cluster with `/waypoint` requests (no signal records an HTTP request, so this needs a log line added first) and whether they cluster with the ride log's fsync or the WebSocket's snapshot heartbeat. Both are cheap to instrument next time the Pi is in reach.
