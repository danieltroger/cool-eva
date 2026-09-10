# Handlebar gestures, recognised on the Pi

A long press of a handlebar button as an input to this project rather than to the motorcycle. Two of them, both recognised by the service:

| Button | Hold | What it does |
| --- | --- | --- |
| `btn_mode_enter` — MODE ENTER, left pod (`0x102` b0 bit 2) | **1200 ms** | steps the cooling fan round manual 100 % → off → automatic (`docs/fan-control.md`). ⚠️ _Off_ is enterable up to **15 km/h** since 2026-09-11 and handed back above it — so a hold made while creeping now silences the fan, where before it could not |
| `btn_indicator_cancel` — the turn-signal switch pushed in (`0x102` b0 bit 5) | **500 ms** | saves a waypoint |

`src/gestures/long-press.ts` is the recogniser and is pure — samples in, an edge out, no clock read and no I/O — so `scripts/check-hold-gestures.ts` replays press sequences through the very function the bike runs. `src/gestures/runner.ts` is the half that subscribes, beats and acts.

The gestures cannot degrade the buttons they listen to, structurally: `src/can/socket.ts` comes up listen-only and nothing on this path ever transmits. `0x102` carries a _report_ of a switch the bike has already acted on.

## Why they are on the Pi and not on the phone

Both used to live in `public/lib/gestures.js`, recognised by the dashboard off the WebSocket. **`public/lib/connection.js` closes the socket whenever the page is hidden** — deliberately, because iOS suspends a hidden page and a held socket becomes a silent one — so a phone in a pocket recognised nothing at all. That is every gesture worth making: the whole point of a handlebar button is that your hands are on the handlebars.

On the Pi the recogniser also gets a better clock. The browser version measures on the _server's_ wall clock, which `src/gps/clock.ts` steps with `date -u -s`, and needs an `IMPLAUSIBLE_HOLD_MS` ceiling so a clock jump mid-press cannot read as a six-hour hold. Here every duration is `monotonicNow()`, which a `date -s` cannot move, so that guard genuinely disappears rather than being dropped.

**What did not move: the double-click on `btn_cruise_set` that changes tab.** Changing tab is something only the page can do, and `DashboardMessage` carries signals and nothing else — there is no command channel to send a tab switch over. It stays in `public/lib/gestures.js` with `scripts/check-handlebar-gestures.ts` behind it.

## The freshness rule, which is the whole design

A hold is asserted by **fresh samples** and never by a stale pressed value:

1. a real observed 0→1 opens a press, timed at the instant the _bus_ said so (`nowMs − sampleAgeMs`, the same trick `sampleTemperature()` uses in `src/fan/auto.ts`);
2. while a press is open the runner **beats** at `HOLD_BEAT_MS` = 50 ms, because a held button raises no change event — `src/can/signals.ts` notifies only when a reading moves, so between the two edges of a hold the signal is untouched;
3. a sample older than `SAMPLE_MAX_AGE_MS` = 500 ms **abandons** the press. It is over, unfired, and only a fresh 0→1 starts another;
4. the gesture fires when a fresh sample shows the threshold passed — normally with the thumb still down, within one beat.

⚠️ **So the threshold is not the whole duration the rider must produce, and the overshoot is not one beat's worth.** A gesture can only fire _on_ a beat, so the thumb is down for the threshold, plus a beat of quantisation, plus whatever a busy event loop adds to the timer. Measured end to end through the real runner, a 500 ms hold fires anywhere in **500–607 ms** — 107 ms over, or **2.1 beats**, of which only 50 ms is the beat itself — and a press becomes reliable at about **580 ms**. It is not a clean two-mode distribution — on an idle machine it looks like one, but under a loaded event loop the beat itself lands late and the fires smear continuously across the range. `HOLD_BEAT_MS` was halved from 100 to 50 in #192 for this reason; at 100 ms the same band ran to 630 ms. **Nothing fires early at either beat** — `observeHold()` still demands the full `holdMs`, so the beat only ever adds lateness — and a 480 ms press fired 0 times in every configuration measured.

⚠️ **It never fires on the release.** The browser version does, deliberately: on a stalling link the release is the only evidence it will ever get. Here that would be the bug. An AC charge silences the whole bus for **up to 23.7 minutes** (`docs/fan-control.md` §"Is the throttle even on the bus while charging?"), so a release delivered when the bus wakes carries a 23-minute press. The Pi is at the bus at 100 Hz and needs no such fallback.

Three sequences are planted in the check rather than argued here: a press followed by twenty minutes of silence **and the bus then coming back with the button still down** fires nothing; a press released at 300 ms fires nothing; a 1.3 s hold fires exactly once, while the button is still down. Deleting the abandon branch turns the first one red.

`SAMPLE_MAX_AGE_MS` is 500 ms because `0x102` broadcasts at ~100 Hz whenever the bus is awake at all, and **the longest gap between two of its frames inside any recorded press in the archive is 14 ms** — so the window is 35× the worst case observed, and 50 consecutive missed frames. It is the same number and the same argument as `FUN_GATE_MAX_AGE_MS` in `src/fan/fun.ts`.

## The corpus the thresholds are argued from

Every `0x102` and `0x400` frame in `~/Documents/cool-eva-archive` — **268 top-level files, 266 `.log` + 2 `.txt`** — with each button's rising and falling edges paired into presses.

⚠️ **98 of the 268 carry `0x102`, and only 97 of those are candump `-tA` text.** The 98th is `can_log-2026-06-14.txt`, 453 MB in `<epoch> <id> <hex>` form (`1781428137.328 102 8010…` — no `can0`, no `[8]`), which a `can0`-anchored `grep` silently drops every line of. It holds **980 976 frames of `0x102` and 14 presses**: 4 cancel at 0.170–0.229 s and 10 ENTER at up to 0.250 s, on 2026-06-14. No `capture-*.log` covers June at all — they begin 2026-08-02 — so those presses dedupe against nothing and are absent from any sweep that misses the file.

⚠️ **And a second file goes missing for an unrelated reason.** `capture-20260807-213342-1e1b5c60.log` ends in 488 NUL bytes, so `grep` calls it binary and prints nothing without `-a` — 177 frames of `0x102`, dropped in silence by exactly the sweep that was written to catch the first omission. **Use `grep -a`.** Two files, two different ways of being invisible, and neither announces itself; a sweep that reports a file count rather than a frame count cannot tell you it happened.

| button                 | presses | median  | max           | ≥ 1.2 s |
| ---------------------- | ------- | ------- | ------------- | ------- |
| `btn_mode_enter`       | 160     | 0.140 s | **0.290 s**   | **0**   |
| `btn_indicator_cancel` | 779     | 0.180 s | 5.771 s       | 3       |
| `btn_mode_left`        | 324     | 0.140 s | 2.590 s       | 16      |
| `btn_mode_right`       | 552     | 0.130 s | **191.241 s** | 39      |
| `btn_set_back`         | 15      | 0.145 s | 0.300 s       | 0       |
| `btn_cruise_enable`    | 36      | 0.995 s | 1.125 s       | 0       |
| `btn_cruise_set`       | 78      | 1.198 s | 6.225 s       | 38      |
| `btn_heated_grip`      | 0       | —       | —             | —       |

**At the 500 ms threshold this switch has been held to since 2026-09-09, the count for `btn_indicator_cancel` is 4 rather than 3.** The fourth is the 0.940 s press below. The ≥ 1.2 s column is kept as it was because it is what the fan's threshold is argued from; it is **not** a guide to what a 500 ms threshold would catch on any other button — `btn_cruise_enable`, whose column reads 0, has a median of 0.995 s and would cross 500 ms on nearly every press. Only `btn_indicator_cancel` carries a 500 ms gesture, so only its count is re-derived here.

**`btn_mode_enter` is the only decoded handlebar bit in THIS archive with no long press anywhere.** Every other button that is held for anything reaches 1.2 s to 191 s — the 191 s being the jacket resting on `btn_mode_right` that `src/can/decode.ts` already records. That, rather than anything about the fan, is why the fan cycle is on ENTER and not on either MODE arrow. ⚠️ The **ride log** is a second archive and it does not agree — four ENTER presses at or past 1.2 s, the longest 4.260 s — which changes no threshold and does change the sentence: §"Long ENTER presses in the ride log".

⚠️ **This retires `LONGEST_ORDINARY_PRESS_MS = 920`**, which `scripts/check-handlebar-gestures.ts` carried until 2026-09-08 and which `docs/dashboard-decisions.md` argued `LONG_PRESS_MS` from. It came from 14 captures and two presses of `btn_cruise_enable`; over 36 presses that button reaches **1.125 s**. The figure was not wrong when it was written, and it is wrong now — which is the argument for recording the sample size next to every number in this table.

### Method, and where it does not hold

Presses are paired per file and then **deduped by absolute press instant**, because two `candump` instances recorded some of the same seconds — the artefact `src/can/decode.ts` warns about, which turns one hold into hundreds of 10 ms toggles if the files are concatenated first. It caught two duplicated ENTER presses across two files.

⚠️ **Two independent parsers do not agree on the counts to better than ~6 %**, and 2026-09-09 found out why for one of the two buttons. A second implementation, written from this description without seeing the first, got 150 ENTER presses to 160 and 775 cancel presses to 779. Every _derived_ figure matched exactly — the same longest ENTER press at 0.290 s, the same three cancel presses over 1000 ms, the same five presses above 3 km/h, the hazard timings to the microsecond.

🚨 **The explanation recorded here — "edge pairing at file boundaries and dedupe tolerance" — is retired for `btn_indicator_cancel`.** A third sweep, run for #192, reproduced the second implementation's 775 exactly and then found the missing 4 in `can_log-2026-06-14.txt`, the second log format above. **775 + 4 = 779**, closing the cancel gap to zero. It was never a tolerance question; it was one parser reading a format the other silently dropped.

⚠️ **ENTER is not closed, and the two sweeps run for #192 do not agree on it either.** One counted 147 presses in the candump half, the other 150; adding the June file's 10 gives **157 or 160** against the 160 recorded here, so the residual is somewhere between **3 and 0** depending on whose edge pairing you take. **Neither was forced to agree with the other**, because a reconciliation nobody can reproduce is worth less than a disagreement with both rules written down. The 147 sweep's rule, stated so it can be re-run: read every top-level `.log`/`.txt` with `grep -a`; per file, emit the first `0x102` frame as a baseline and every subsequent change as an edge; open a press only on a **watched** 0→1, so a file whose first frame already has the bit set contributes no press from it; discard a press still open at end of file; then dedupe across files by absolute press start instant at 10 ms. The 150 sweep's file-boundary handling is not recorded here, which is precisely the gap — and `docs/can-decode-findings.md` shows the same 10 ms-here / 50 ms-there tolerance question producing the same size of gap elsewhere. The format explains most of the ENTER gap and possibly all of it, and the honest position is that nobody has yet produced two sweeps that agree on this button — which is the original ~6 % observation, narrowed to one button and one small remainder rather than retired.

⚠️ **A warning about this method, paid for twice on 2026-09-09.** Both errors were the same shape: a sweep that silently omits input and then gets explained rather than checked. The first was the two invisible files above. The second was worse — a pairing script assumed its extractor always emitted the file's first frame as a baseline, which was true of one extractor and false of the other, so the June file's first _rising edge_ was eaten as a baseline and the count came out one short. That produced a confident sentence in an earlier draft of this section claiming the file "opens mid-press on ENTER". **It does not**: its first `0x102` frame is byte 0 = `0x00` and 83 551 frames pass with ENTER released before the first rise. The number was wrong and the explanation invented to fit it was wrong; both survived because they were mutually consistent. **Check `rises == falls` before believing any press count**, and state which end of the file the baseline came from.

⚠️ The dedupe assumes the wall clock is right on both sides of a duplicated pair. The archive contains at least one capture whose clock is wrong by decades (`capture-20600808-220833-0887e861.log`, epochs in 2060 — issue #59's corrupt hub frame) and which steps mid-file. It moved none of the numbers above, but a method recorded without its failure mode is a method that gets reused where it does not hold.

## Why 500 ms on the cancel switch and 1200 ms on ENTER

Different buttons, different things the bike does with a long press.

**ENTER: 1200 ms** clears the longest ENTER press _in the capture corpus_ by **4.1×** and every one of the 160 by at least 910 ms. It does **not** clear the four deliberate holds in the ride log, and is not meant to: those are made for the bike's own dash menu, and no hold length can tell them from a fan gesture (§"Long ENTER presses in the ride log").

**Indicator-cancel: 500 ms since 2026-09-09**, down from 1000. The reason is the rider, not the archive: _"some waypoints didn't register cuz I was afraid of turning on hazards"_ — **holding that switch turns the HAZARD LIGHTS on** (below), so a thumb that is unsure comes off early and the save never happens. It still clears the longest press of that switch outside one afternoon's experiment — **0.330 s**, over 770 of the 779 — by **1.5×**.

⚠️ **The margin is 1.5× where the fan's is 4.1×, and that is deliberate, because the two failures do not cost the same.** A false fire writes one waypoint that can be deleted. A missed hold loses a place you were standing in and are not going back to. Where the fan's threshold is set to make a spurious step impossible, this one is set to make a missed save unlikely, and the asymmetry is the whole argument for accepting a margin that would be too thin on any other button.

**What it costs, measured over the whole archive: one press.** At 500 ms the recogniser fires on **4** of the 779 cancel presses against 1000 ms's **3** — the extra being the 0.940 s press below — and all four fall within 15 seconds of one another (press starts `18:51:02.680` to `18:51:13.501`, 10.8 s apart). **Not one ordinary press fires at either threshold.**

⚠️ **The nearest press in the archive to the new threshold is 0.409 s, 91 ms below it.** That figure is stated rather than buried, but it is not what the margin rests on, because that press is not a press ordinary riding can produce: the trace below shows the hazards flashing before it and out at its press edge. It is a **hazard-cancelling tap**, and reaching the state that makes one requires having already held the switch to ~2 s. The exclusion is by class, not by clock — which is the part of the old 1000 ms argument that was worth keeping and the part that was worth attacking.

The experiment is a **single minute** — 18:51 on 2026-08-03, bike stationary — and it holds **9** of the 779 presses: 0.159, 0.210, 0.249, 0.250, 0.409, 0.940, 1.320, 4.331 and 5.771 s. **The other 770 top out at 0.330 s and not one of them reaches 0.4 s.** That minute is not ordinary riding; it is somebody deliberately holding the button to find out what it does, and the trace below is what they found — two hazard activations and two cancellations, inside the same minute.

⚠️ Read without that exclusion the threshold sits **below** two of the minute's presses rather than above them, which is exactly what the count of 4-versus-3 above already says out loud. The exclusion was the load-bearing step in the argument for 1000 ms and it is still the load-bearing step at 500 ms — which is why it is now argued by class (a hazard-cancelling tap) rather than by the clock, and why the whole minute is listed here for attacking.

Replaying the whole archive through the shipped recogniser fires the fan gesture **0 times** and the waypoint gesture **4 times** — the 0.940 s, 1.320 s, 4.331 s and 5.771 s presses from that one afternoon, sixteen days before the gesture existed. At the old 1000 ms it was 3; the 0.940 s press is the entire difference.

## ⚠️ Holding the cancel switch turns on the hazard lights

Measured from the archive, in `capture-20260803-185035-86cbb463.log`, by tracking b0 bit 5 against the two lamp outputs b2 bit 2 and bit 3. **Both lamps on together is hazards; one side is a turn signal.**

|                            |                                               |
| -------------------------- | --------------------------------------------- |
| press edge                 | `18:51:05.380695`                             |
| both lamps first on        | `18:51:07.391965` — **2.011 s** into the hold |
| press edge, second episode | `18:51:13.501277`                             |
| both lamps first on        | `18:51:15.861371` — **2.360 s** into the hold |
| flash cadence              | on-edges every 0.700 s, on-phase 0.350 s      |

**The switch threshold is at or before 2.011 s, and the lower bound is unknown.** These are lamp _outputs_, so the switch closed at or before the first flash. An earlier draft of this document inferred a tight 1.66–2.01 s band from the 0.349 s difference between the two episodes being exactly one half flash period — that inference is **withdrawn**: the two episodes' grids are 69 ms out of phase with each other, the grid is disturbed again at the release, and the pre-hazard indicator grid is a third phase, so there is no single free-running oscillator to reason from. With two activations, "one half-period" is a coincidence. `docs/fan-control.md` §4's retracted kick-start claim is the precedent for why the conservative form is the one that ships.

Two more things the same trace shows, and both matter to the rider:

- **The lamps latch on after the release** — cancel drops at `17.832416` and they go on flashing.
- **A press while they are flashing puts them out, at the press edge.** The 1.320 s press at `11.511690` killed them immediately: no lamp transition anywhere inside it, where a still-running hazard would have toggled four times. The 0.409 s press at `37.473` did the same. So the recovery is an ordinary tap.

### ⚠️ The limitation this creates, and it is not worked around

**A rider with the phone in a pocket gets no confirmation that the waypoint saved**, and the banner is the only confirmation there is. So the natural thing to do — keep holding to be sure — walks into the hazards at ~2 s. This is a failure the move to the Pi _creates_: while the phone recognised the hold it also showed the banner, and it now does neither until it is next looked at.

It is survivable rather than solved, on the two facts above: the hazards announce themselves (dash tell-tale, and the relay is audible on a stationary bike), and a tap puts them out.

🚨 **This section used to end "it is also the argument against trimming the hold below 1000 ms". The rider has overruled that, and the reasoning was wrong anyway.** Daniel, 2026-09-09: _"some waypoints didn't register cuz I was afraid of turning on hazards"_. The old argument was that a shorter hold fires sooner but leaves the same gap between firing and the rider knowing — true, and beside the point. The gap it protects is a gap in _confirmation_; what it was costing was the _save itself_. A rider who has already decided the hold is not worth the risk gets no confirmation of anything, because there is nothing to confirm. **500 ms does not close the confirmation gap and is not meant to; it makes the save happen before the thumb gives up.** The hazards remain where they were; what changed is the margin to them, measured from the _worst-case fire_ rather than from the threshold — 2011 ÷ 607 = **3.3×**, against 2011 ÷ 1130 = 1.8× at the old hold and beat.

**Still to measure:** whether the hold-to-hazard behaves the same rolling as parked. 749 of the 779 cancel presses in the archive were made above 3 km/h and not one of them was held long enough to find out.

## Long ENTER presses in the ride log

⚠️ **The per-button table above is the 268-capture corpus, and it is not the only archive on this bike.** Re-measured on 2026-09-10 against `rides.db` — a different corpus, written by the service itself rather than by `candump` — `btn_mode_enter` has **94 press→release pairs, 100 ms to 4 260 ms**, and four of them clear the fan gesture's 1 200 ms:

| press began (UTC)       | held         | session |
| ----------------------- | ------------ | ------- |
| 2026-08-29 20:53:25.601 | **4 260 ms** | 31      |
| 2026-09-07 11:49:45.463 | **3 000 ms** | 41      |
| 2026-09-07 11:49:48.832 | **1 910 ms** | 41      |
| 2026-09-07 11:49:53.851 | **1 691 ms** | 41      |

(Method: `lag()` partitioned by `session_id`, so no pair spans a restart. A fifth press, 2026-08-19 16:24:25 at 821 ms, clears nothing but is the longest of the rest.)

⚠️ **Checked against §"A warning about this method" before being believed, and it does not balance at first glance:** 237 edges, **94 rises against 143 falls**. The 49-edge difference is not unpaired releases — it is the boot baseline `record()` seals for every signal on the first sample after a restart, one `btn_mode_enter = 0` per session across 49 of the 50 sessions. Pairing per session on a _watched_ 1→0 ignores those, and all three sessions holding a long press open on a `0`, so none of them opens mid-press — the exact artefact that produced a confident wrong sentence on 2026-09-09. A press still open at a session's end is discarded, which can only undercount.

**This does not move `FAN_HOLD_MS`, and the reason matters more than the number.** The threshold's job is that an _ordinary_ press never fires, and none of these is ordinary: every one is a thumb held on purpose. They are held for the **bike's** dash menu, not for the fan — which is exactly why no hold length can separate the two, and why §"Holding ENTER opens the dash's own reset mode" below is a collision to be lived with rather than tuned away. What they do refute is the _sentence_: "the only decoded handlebar bit in the whole archive with no long press anywhere" is true of the captures and false of the ride log, and `src/fan/gesture.ts`, `src/can/decode.ts`, `docs/can-decode-findings.md` and `docs/diagnostics-and-checks.md` now each name which archive they mean.

The three on 2026-09-07 are eight presses in 12.27 s — 180, 129, **3 000**, **1 910**, 130, 160, 269, **1 691** ms — with **nothing else touched between the first press and the last release**; the six `btn_mode_right` edges are three presses landing 2.0–4.8 s _after_ the bout (11:49:57.501 → 11:50:00.363), and the previous one is 4 min 35 s back. They _look_ like the measurement §"Holding ENTER opens the dash's own reset mode" asks for, but the ride log cannot say what the dash did: nothing the reset mode touches is decoded, and no trip or odometer signal moves in that window. So that measurement is still owed, and it still wants a person at the bike. ⚠️ They also predate the fan gesture (7f6dbcd, 2026-09-08), so nothing fired then — but on today's code that bout is **three fires, three whole steps round the cycle**, which is the leading explanation for Daniel's "sometimes it just kicks on in auto". `docs/fan-control.md` §"What is left of 'the long press never reaches _off_'" ranks it against the alternatives.

## ⚠️ Holding ENTER opens the dash's own reset mode

Reported by the owner, 2026-09-08: holding MODE ENTER **while parked** puts the dash into a reset mode, where one further ENTER click resets the trip meter. **The hold length that triggers it has not been measured.**

It bites because consecutive holds happen: the press that begins a second hold may be the click the dash is waiting for. The cycle's direction was reversed on 2026-09-08 partly for this — the rider's own commonest step, manual 100 % to quiet, is one hold rather than two — but any two holds in a row still reach it.

No mitigation is built, deliberately. An upper bound — fire only if released before X — is the only thing that could keep the dash out of reset mode, it works only if the dash's threshold is longer than ours, and choosing X today means choosing it from no measurement at all. It would also cost the property that makes the gesture usable with gloves: the fan answers **under the thumb**. A minimum gap between holds does nothing, because the trip meter is reset by the rider's thumb reaching the bike's own dash, not by our recogniser.

The cost is bounded: it is the bike's own trip counter. `odometer_can_km` is logged continuously off `0x104` and the dashboard computes its own trip (`public/lib/trip.js`), so nothing in the ride log or on the phone is lost.

**The measurement that settles it** — parked, key on, about 30 seconds: hold ENTER and release at roughly 1 s, then 2 s, then 4 s, noting for each whether the dash enters reset mode; whether reset mode leaves on its own and after how long; and whether the _press_ that starts a second hold is enough to confirm the reset or whether it takes a full short click. If the answer is "more than ~2 s", an upper bound becomes one constant and one branch. If it is "under 1.2 s", the choice is between accepting it and moving the fan cycle to another bit, and that is the owner's.

## A waypoint the bike refuses

The hold asks nobody, so a refusal that only existed in the reply to a request is a refusal the rider never learns about — they hold the button, see nothing, and ride away from a place they meant to keep. Two signals carry it instead: `waypoint_refused_seq`, a monotonic count, and `waypoint_refusal`, the reason code (`WAYPOINT_REFUSAL` in `src/gps/waypoint.ts`; the sentences are in `public/lib/announce.js`).

⚠️ A **counter** and not a flag, for the reason `docs/can-decode-findings.md` gives about re-selecting a value you already had: `record()` seals a row only when the value moves, so two identical refusals in a row would write one row, raise one change and put up one banner — and the second hold at the same spot with the same stale fix would look like it had worked.

The reasons are the endpoint's original gates — no fix, a fix that is not a position on Earth at all (#167), a fix older than 30 s, a clock that is not satellite-backed — plus one added 2026-09-08: **a fix too far from the one before it to have been ridden to.** That is a real defect rather than a hypothetical: a waypoint saved on 2026-08-09 carried longitude 130.30 while the next `gps_lon` row read 13.04, about 8 000 km away. Nothing about 130.30 is out of range on its own, so only the distance from the previous fix can catch it.

`src/gps/fix-plausibility.ts` is that gate, and it is pure. It is the gate `docs/waypoints.md` named as #165's and could not yet point at; it now sits beside the range gate that came in with #167, because the two answer different questions about the same coordinates. Two guards, both argued from things this repo has already paid for: the implied speed must exceed **300 km/h**, which is `public/lib/bounds.js`'s own ceiling on `gps_speed_kmh` rather than a second opinion about how fast the bike goes; and the two fixes must be at least **1 s** apart, because `docs/route-map.md` records that an implied-speed test with a short denominator reads 7 m in 1 ms as 25 000 km/h and rejected 4 718 steps that were all timing artefact.

Known and accepted: one spike costs **two** refusals — itself, and the good fix after it, which is measured against the spike. Both are loud, and the one after next is judged against a good pair again. A bad **first** fix of a boot cannot be caught at all; an absolute-region rule is a follow-up issue's.

## What the rider hears about

Nothing is transmitted to the bike, so the feedback is whatever the gesture itself produces:

- **the fan** is audible — the 1.5 s kick-start from rest is unmistakable — except in the two cases `docs/fan-control.md` names, where manual 100 % and automatic command the same duty;
- **the phone** raises a banner off the live signals (`public/lib/announce.js`), which needs the page to be open and the socket up. That is exactly the rider this feature was moved to the Pi for not having.
