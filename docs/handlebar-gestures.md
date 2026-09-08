# Handlebar gestures, recognised on the Pi

A long press of a handlebar button as an input to this project rather than to the motorcycle. Two of them, both recognised by the service:

| Button | Hold | What it does |
| --- | --- | --- |
| `btn_mode_enter` — MODE ENTER, left pod (`0x102` b0 bit 2) | **1200 ms** | steps the cooling fan round manual 100 % → automatic → off (`docs/fan-control.md`) |
| `btn_indicator_cancel` — the turn-signal switch pushed in (`0x102` b0 bit 5) | **1000 ms** | saves a waypoint |

`src/gestures/long-press.ts` is the recogniser and is pure — samples in, an edge out, no clock read and no I/O — so `scripts/check-hold-gestures.ts` replays press sequences through the very function the bike runs. `src/gestures/runner.ts` is the half that subscribes, beats and acts.

The gestures cannot degrade the buttons they listen to, structurally: `src/can/socket.ts` comes up listen-only and nothing on this path ever transmits. `0x102` carries a _report_ of a switch the bike has already acted on.

## Why they are on the Pi and not on the phone

Both used to live in `public/lib/gestures.js`, recognised by the dashboard off the WebSocket. **`public/lib/connection.js` closes the socket whenever the page is hidden** — deliberately, because iOS suspends a hidden page and a held socket becomes a silent one — so a phone in a pocket recognised nothing at all. That is every gesture worth making: the whole point of a handlebar button is that your hands are on the handlebars.

On the Pi the recogniser also gets a better clock. The browser version measures on the _server's_ wall clock, which `src/gps/clock.ts` steps with `date -u -s`, and needs an `IMPLAUSIBLE_HOLD_MS` ceiling so a clock jump mid-press cannot read as a six-hour hold. Here every duration is `monotonicNow()`, which a `date -s` cannot move, so that guard genuinely disappears rather than being dropped.

**What did not move: the double-click on `btn_cruise_set` that changes tab.** Changing tab is something only the page can do, and `DashboardMessage` carries signals and nothing else — there is no command channel to send a tab switch over. It stays in `public/lib/gestures.js` with `scripts/check-handlebar-gestures.ts` behind it.

## The freshness rule, which is the whole design

A hold is asserted by **fresh samples** and never by a stale pressed value:

1. a real observed 0→1 opens a press, timed at the instant the _bus_ said so (`nowMs − sampleAgeMs`, the same trick `sampleTemperature()` uses in `src/fan/auto.ts`);
2. while a press is open the runner **beats** at `HOLD_BEAT_MS` = 100 ms, because a held button raises no change event — `src/can/signals.ts` notifies only when a reading moves, so between the two edges of a hold the signal is untouched;
3. a sample older than `SAMPLE_MAX_AGE_MS` = 500 ms **abandons** the press. It is over, unfired, and only a fresh 0→1 starts another;
4. the gesture fires when a fresh sample shows the threshold passed — normally with the thumb still down, within one beat.

⚠️ **It never fires on the release.** The browser version does, deliberately: on a stalling link the release is the only evidence it will ever get. Here that would be the bug. An AC charge silences the whole bus for **up to 23.7 minutes** (`docs/fan-control.md` §"Is the throttle even on the bus while charging?"), so a release delivered when the bus wakes carries a 23-minute press. The Pi is at the bus at 100 Hz and needs no such fallback.

Three sequences are planted in the check rather than argued here: a press followed by twenty minutes of silence **and the bus then coming back with the button still down** fires nothing; a press released at 300 ms fires nothing; a 1.3 s hold fires exactly once, while the button is still down. Deleting the abandon branch turns the first one red.

`SAMPLE_MAX_AGE_MS` is 500 ms because `0x102` broadcasts at ~100 Hz whenever the bus is awake at all, and **the longest gap between two of its frames inside any recorded press in the archive is 14 ms** — so the window is 35× the worst case observed, and 50 consecutive missed frames. It is the same number and the same argument as `FUN_GATE_MAX_AGE_MS` in `src/fan/fun.ts`.

## The corpus the thresholds are argued from

Every `0x102` and `0x400` frame in `~/Documents/cool-eva-archive` — 268 capture files — with each button's rising and falling edges paired into presses.

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

**`btn_mode_enter` is the only decoded handlebar bit in the archive with no long press anywhere.** Every other button that is held for anything reaches 1.2 s to 191 s — the 191 s being the jacket resting on `btn_mode_right` that `src/can/decode.ts` already records. That, rather than anything about the fan, is why the fan cycle is on ENTER and not on either MODE arrow.

⚠️ **This retires `LONGEST_ORDINARY_PRESS_MS = 920`**, which `scripts/check-handlebar-gestures.ts` carried until 2026-09-08 and which `docs/dashboard-decisions.md` argued `LONG_PRESS_MS` from. It came from 14 captures and two presses of `btn_cruise_enable`; over 36 presses that button reaches **1.125 s**. The figure was not wrong when it was written, and it is wrong now — which is the argument for recording the sample size next to every number in this table.

### Method, and where it does not hold

Presses are paired per file and then **deduped by absolute press instant**, because two `candump` instances recorded some of the same seconds — the artefact `src/can/decode.ts` warns about, which turns one hold into hundreds of 10 ms toggles if the files are concatenated first. It caught two duplicated ENTER presses across two files.

⚠️ **Two independent parsers do not agree on the counts to better than ~6 %.** A second implementation, written from this description without seeing the first, got 150 ENTER presses to 160, 775 cancel presses to 779, and 15.68 M frames of `0x102` to 15.99 M. Every _derived_ figure matched exactly — the same longest ENTER press at 0.290 s, the same three cancel presses over 1000 ms, the same five presses above 3 km/h, the hazard timings to the microsecond. The gap is edge pairing at file boundaries and dedupe tolerance (10 ms here, 50 ms there), and it is recorded because a method that promises reproducibility should say how reproducible it actually was.

⚠️ The dedupe assumes the wall clock is right on both sides of a duplicated pair. The archive contains at least one capture whose clock is wrong by decades (`capture-20600808-220833-0887e861.log`, epochs in 2060 — issue #59's corrupt hub frame) and which steps mid-file. It moved none of the numbers above, but a method recorded without its failure mode is a method that gets reused where it does not hold.

## Why 1000 ms on the cancel switch and 1200 ms on ENTER

Different buttons, different things the bike does with a long press.

**ENTER: 1200 ms** clears the longest ENTER press ever recorded by **4.1×** and every one of the 160 by at least 910 ms.

**Indicator-cancel: 1000 ms**, because **holding that switch turns the HAZARD LIGHTS on** (below). It clears the longest press of that switch outside one afternoon's experiment — **0.330 s** — by 3.0×, and fires a full second before the earliest hazard activation ever observed.

The experiment is a **single minute** — 18:51 on 2026-08-03, bike stationary — and it holds **9** of the 779 presses: 0.159, 0.210, 0.249, 0.250, 0.409, 0.940, 1.320, 4.331 and 5.771 s. **The other 770 top out at 0.330 s and not one of them reaches 0.4 s.** That minute is not ordinary riding; it is somebody deliberately holding the button to find out what it does, and the trace below is what they found — two hazard activations and two cancellations, inside the same minute.

⚠️ Read without that exclusion the nearest press is 0.940 s and the margin is 60 ms; count the 0.409 s one as ordinary and it is 2.4×. Both are stated rather than buried, because the exclusion is the load-bearing step in the argument for 1000 ms and it should be attacked rather than assumed. It is the reason the hold is not trimmed any further.

Replaying the whole archive through the shipped recogniser fires the fan gesture **0 times** and the waypoint gesture **3 times** — the 1.320 s, 4.331 s and 5.771 s presses from that one afternoon, sixteen days before the gesture existed.

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

It is survivable rather than solved, on the two facts above: the hazards announce themselves (dash tell-tale, and the relay is audible on a stationary bike), and a tap puts them out. It is also the argument against trimming the hold below 1000 ms — a shorter hold would fire sooner but leave the same gap between firing and the rider knowing.

**Still to measure:** whether the hold-to-hazard behaves the same rolling as parked. 749 of the 779 cancel presses in the archive were made above 3 km/h and not one of them was held long enough to find out.

## ⚠️ Holding ENTER opens the dash's own reset mode

Reported by the owner, 2026-09-08: holding MODE ENTER **while parked** puts the dash into a reset mode, where one further ENTER click resets the trip meter. **The hold length that triggers it has not been measured.**

It bites because consecutive holds are ordinary here: parked, going from automatic to a full fan is two holds, and the press that begins the second one may be the click the dash is waiting for.

No mitigation is built, deliberately. An upper bound — fire only if released before X — is the only thing that could keep the dash out of reset mode, it works only if the dash's threshold is longer than ours, and choosing X today means choosing it from no measurement at all. It would also cost the property that makes the gesture usable with gloves: the fan answers **under the thumb**. A minimum gap between holds does nothing, because the trip meter is reset by the rider's thumb reaching the bike's own dash, not by our recogniser.

The cost is bounded: it is the bike's own trip counter. `odometer_can_km` is logged continuously off `0x104` and the dashboard computes its own trip (`public/lib/trip.js`), so nothing in the ride log or on the phone is lost.

**The measurement that settles it** — parked, key on, about 30 seconds: hold ENTER and release at roughly 1 s, then 2 s, then 4 s, noting for each whether the dash enters reset mode; whether reset mode leaves on its own and after how long; and whether the _press_ that starts a second hold is enough to confirm the reset or whether it takes a full short click. If the answer is "more than ~2 s", an upper bound becomes one constant and one branch. If it is "under 1.2 s", the choice is between accepting it and moving the fan cycle to another bit, and that is the owner's.

## What the rider hears about

Nothing is transmitted to the bike, so the feedback is whatever the gesture itself produces:

- **the fan** is audible — the 1.5 s kick-start from rest is unmistakable — except in the two cases `docs/fan-control.md` names, where manual 100 % and automatic command the same duty;
- **the phone** raises a banner off the live signals (`public/lib/announce.js`), which needs the page to be open and the socket up. That is exactly the rider this feature was moved to the Pi for not having.
