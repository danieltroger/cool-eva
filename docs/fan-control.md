# Cooling-fan control (IBT-2 / BTS7960 + SPAL VA69A)

The watercooling loop's radiator fan, driven from the Pi over hardware PWM. This is the write-up the code points at: `src/fan/pwm.ts` (sysfs and `pinctrl` I/O), `src/fan/control.ts` (bring-up order and the duty rules), `src/fan/curve.ts` (the automatic curve, pure), `src/fan/auto.ts` (the loop that feeds it and owns the mode), `src/fan/fun.ts` and `src/fan/fun-runner.ts` (fun mode's gate and mapping, and the half that reads the bus), `src/http/fan.ts` (the endpoint), `public/views/fan.js` (the slider and the mode toggle in the menu sheet) and `public/lib/fan-command-queue.js` (the coalescer that turns a drag into one POST in flight and one queued).

**Phase 2: the fan follows the pack temperature, and the slider takes it over.** The Pi starts in AUTOMATIC and drives the fan off `batt_temp_hi`; dragging the slider hands it to you until the bike is switched off. The curve is `src/fan/curve.ts` (pure arithmetic), the loop that feeds it is `src/fan/auto.ts`, and both are argued in §4.

**Phase 3: with the bike parked, the throttle can drive the fan.** A third mode, offered only while `go` is clear and the bike is stationary, and dropped the instant either stops being true. §4 "Fun mode" is the gate, the mapping and the measurements behind both.

Off by default: nothing here happens unless `FAN_ENABLED=1`. See §7.

## 1. Hardware

| Part   | What                                                                  |
| ------ | --------------------------------------------------------------------- |
| Fan    | SPAL VA69A-A101-87S, 12 V brushed axial                               |
| Driver | IBT-2 module — two BTS7960B half-bridges plus a 74HC244 input buffer  |
| Host   | Raspberry Pi Zero 2 W (the same one running the rest of this service) |

Fan current. **Two of these three rows are SPAL's and one is not**, which matters enough to be in the table rather than under it:

| Condition | Current | Provenance |
| --- | --- | --- |
| Free flow (0 Pa static pressure) | 3.8 A | SPAL's own current curve for this fan, at spal.com |
| Against 351 Pa of static pressure | 5.2 A | the same curve, at its blocked-airflow end |
| Locked rotor | ~15–25 A | ⚠️ **ESTIMATE.** Not SPAL's, not measured on this fan, not measured at all |

⚠️ **The locked-rotor row is a guess, and the whole of §4 leans on it.** SPAL publishes current against static pressure; 5.2 A is that curve's far end, which is a fan working hard against a blocked _duct_ **with the rotor still turning**. A stalled rotor is a different quantity altogether — 12 V across the armature resistance with no back-EMF to oppose it — and nothing in SPAL's data addresses it. (A retailer listing quoting 4.2 A free-flow is also in circulation; it is not the manufacturer and is not used here.)

Note how close 3.8 A and 5.2 A are: the difference between a healthy fan and one working against a completely blocked duct is 1.4 A, which no protection device can be asked to tell apart. A locked rotor would be the unambiguous one — if anybody knew what it drew.

## 2. Pin map

| IBT-2 | Pi header pin | GPIO   | Notes                          |
| ----- | ------------- | ------ | ------------------------------ |
| VCC   | 17            | 3V3    | **3.3 V, not 5 V** — see below |
| GND   | 14            | GND    |                                |
| RPWM  | 12            | GPIO18 | hardware PWM0                  |
| R_EN  | 11            | GPIO17 |                                |
| L_EN  | 13            | GPIO27 |                                |

`LPWM`, `R_IS` and `L_IS` are left unconnected. The board carries 1 kΩ pulldowns on all of them, so an unconnected `LPWM` sits low and the reverse half never switches; the two current-sense pins are outputs we do not read.

Only one direction is wired. A radiator fan has no use for a reverse, and giving the bridge no way to be commanded into one is worth more than the feature.

### Why VCC is 3.3 V and not 5 V

The IBT-2's inputs go through an on-board 74HC244 buffer, whose logic threshold is **0.7 × VCC**. Powered from 5 V that is 3.5 V, and the Pi's GPIO high is 3.3 V — under the threshold, so the buffer's input sits in the indeterminate region. It may read the pin as high, as low, or oscillate, and it can do different things on different boards and at different temperatures.

Powering the buffer from the Pi's own 3V3 rail moves the threshold to 2.31 V, which 3.3 V clears with margin. The BTS7960 half-bridges themselves are powered from the fan's 12 V supply and do not care; only the buffer sees VCC.

This is a wiring mistake that "works" on the bench and then stops working in a hot garage, so it is the first thing to re-check if the fan behaves erratically.

## 3. Why idling pulls the enables LOW

Both enables HIGH activates the bridge. Both LOW is standby: every FET off, the outputs floating, the rotor free to windmill.

**Enables HIGH with the PWM at 0 % is not "off".** With the high side never switching, the BTS7960 leaves **both low sides on**, which shorts the motor winding across ground. A shorted brushed DC motor is a generator into a dead short — it brakes, hard, and dumps the energy in its own windings.

That is a real hazard here rather than a theoretical one, because this fan sits in a radiator duct on a motorcycle capable of 270 km/h. At speed the airstream drives the rotor whether or not the fan is powered, and braking it against that airflow means dissipating the ram air's energy in a stalled winding. So:

- **Idle is always both enables LOW**, never merely `duty_cycle = 0`.
- The bring-up order in `beginKickStart()` is duty → PWM output → enables, so the bridge is never enabled while the output is still at zero.
- The shutdown order in `goIdle()` is the mirror: enables first, then the output, then the duty.
- **The mirror rule has a third case: a failed enable-drop.** If `setBridgeEnabled(false)` throws — a missing `pinctrl`, or `execFile` failing to fork on a 512 MB Zero 2 W under memory pressure — pressing on and dropping the output anyway _constructs_ the braked state out of the error path. So `goIdle()` drops the output only once `context.bridgeEnabled` is genuinely false, reports the failure, and leaves the fan running. A fan still spinning is strictly safer than a fan braked.
- `openFanPwm()` pulls both enables LOW as its **first** statement, before it has even looked for the chip, because bring-up can begin under a live bridge: a `SIGKILL` leaves the enables HIGH and the unit restarts the process five seconds later (§8).

The orderings are the whole safety property of `src/fan/control.ts`. If you edit that file, that is the thing not to break — and `scripts/check-fan-ordering.ts` is what notices, by driving a recording fake `FanPwm` through `startFanControl()`.

## 4. The policy

### Kick-start: 100 % for 1500 ms from rest

Every start from rest goes to **100 % for `KICK_START_MS` (1500 ms)** before dropping to the commanded duty. A free rotor spins up inside that window and the kick is invisible; a stiff one gets full torque to break away with instead of a duty it can sit and hum at.

**That is what the kick is: an anti-stiction measure.** It was introduced as fuse protection, and that claim does not survive being checked — this section is the retraction, kept here rather than deleted so nobody re-derives it.

#### What was claimed, and why it does not hold

SPAL's usage recommendations for this fan family include, as clause f, that **the supply must interrupt on a blockage**. The bike's fan circuit is on a 10 A blade fuse, which is the only interrupter there is. The argument was that PWM defeats it at low duty, and that a 1500 ms burst at 100 % restores it by pulling locked-rotor current and blowing the fuse. Three things are wrong with it:

1. **A fuse responds to I²t, not to average current.** The old text said a stalled rotor at 30 % duty "averages about 6 A". That is the wrong quantity. What heats a fuse element is the RMS current, which under a hard-switched duty _D_ is `I_stall · √D`, not `I_stall · D`. At 30 % duty an estimated 20 A stall presents about **11 A**, not 6 — the 110 % row. It still never opens (135 % is the must-not-open-in-an-hour point), so the conclusion stands, but the arithmetic understated it by nearly a factor of two and would have gone on understating it at every other duty.

2. **1500 ms at 100 % does not clear a 10 A fuse anywhere in the estimated 15–25 A range.** Littelfuse's own time-current table for ATO/ATC blade fuses — the type this bike uses — gives these **maximum** opening times at a 10 A rating:

   | Overload | Current | Opens within (max) |
   | -------- | ------- | ------------------ |
   | 150 %    | 15 A    | ~166 s             |
   | 200 %    | 20 A    | 5.0 s              |
   | 250 %    | 25 A    | ~2.0 s             |

   1500 ms is only guaranteed at roughly **268 %, i.e. about 27 A** — which is _above the top_ of §1's own 15–25 A band. At the bottom of that band the fuse would need nearly three minutes. So the kick does not blow the fuse at 15 A, does not blow it at 20 A, and does not reliably blow it at 25 A either.

3. **The 15–25 A itself is an estimate** (§1). Even if the fuse curve said yes, the current going into it was never measured.

#### What would settle it

Measure the fan's **armature resistance** with the rotor held still — a four-wire reading across the motor terminals, no supply connected. Locked-rotor current is then `12 / R` directly, with no back-EMF term, and it is the one number this whole argument turns on.

The kick is fuse protection only if that comes out **below roughly 0.48 Ω**, and even that is marginal: 0.48 Ω is 25 A, the 250 % row, whose _maximum_ opening time is ~2.0 s — longer than the kick. Comfortably inside 1500 ms wants about 0.45 Ω or less. Anything above ~0.8 Ω is under 15 A and the fuse is not part of the story at any duty.

Until that measurement exists, **`KICK_START_MS` is not protection and nothing should be built on top of it as if it were.** The honest statement of the hazard is in §8.

Two consequences of the kick worth stating anyway:

- The kick duty is deliberately **not** `MAX_DUTY_PERCENT`. If the cap is ever lowered to hold an average voltage (below), the kick must stay at 100 %: whatever a stiff rotor needs to break away, it needs at full torque, and the retraction above does not change that.
- A command arriving mid-kick only moves the target. The kick runs its full length or it is not a kick, and the timer lands on whatever the target is by then. Its length is checked with `since()` from `src/monotonic.ts` rather than trusted from the timer, because this process steps its own wall clock from GPS.

### Minimum running duty: 30 %

A command below 30 % stops the fan — enables LOW — rather than commanding a crawl. Below roughly there the fan may not start at all from rest, and a fan that has been told to run and is silently stalled is the state the kick-start above exists to make less likely. "Off" is an honest answer; "3 %" is not.

### Duty cap: 100 % today

`MAX_DUTY_PERCENT` exists as a named constant, currently 100, because **the 12 V rail has not been measured.** The SPAL VA69A is specified at a nominal 12 V ±10 %. If the rail turns out to sit at a charging-system 13.8 V, running at 100 % duty is 15 % over nominal and outside the tolerance; holding the average at 12 V wants roughly 87 %.

Measure the rail at the IBT-2's 12 V terminal under load, then set the cap to `12 / measured × 100`. Until that measurement exists, guessing a number would be worse than the honest 100 — it would look like a decision.

### The automatic curve

Two straight lines, both leaving the 30 % floor at 35 °C and differing only in where they reach 100 %. `batt_temp_hi` is the input to both; `src/fan/curve.ts` is the arithmetic and it is pure, so `scripts/check-fan-curve.ts` replays every point of it with no bike.

⚠️ **Every temperature in the table below is a considered choice and none of them is a measurement.** 35, 48 and 54 have never been checked against how much air this radiator needs at a given pack temperature — §8 says so, and this is the table a reader takes the numbers from, so it says so here too. The datum that would settle them is one hot DC session logged with `FAN_ENABLED=1`. The same marker as §1's locked-rotor row, for the same reason.

| Condition | The fan runs when | 30 % at | 100 % at |
| --- | --- | --- | --- |
| **DC charging** — `charge_manager_state` = `0x23` | **always.** The floor is unconditional | ≤ 35 °C | 54 °C |
| **Everything else** — riding, parked, **and AC charging** | `batt_temp_hi` > 35 °C **and** `speed_can_kmh` < 90 | 35 °C | 48 °C |

So 48 °C is **100 % riding and 78 % on DC**: the second curve is not the first one extended, it is a shallower line to a higher top, and the check asserts the two disagree at that point on purpose.

**AC charging takes the ordinary curve, and that is a choice rather than an oversight.** Our AC charge is a couple of kW into a ~21 kWh pack; a DC session is thirty times that and is the only case where the pack gets hot enough, fast enough, to want a curve that keeps climbing to 54 °C. The owner picked it. If an AC session is ever measured pushing the pack past 48 °C, this is the line to revisit.

**The DC floor is unconditional and answers to nothing** — not the pack temperature, not the speed gate, not `batt_temp_hi` having gone missing. A DC session with a cold pack still gets 30 %, because the cheapest moment to move air through that radiator is before the pack needs it.

**Above 90 km/h the fan stops.** The airstream through the duct is already doing the work, and a fan motor driven backwards by ram air is not something to add current to. The gate is on speed alone: a hot pack at 120 km/h is a hot pack that is being cooled anyway.

### Hysteresis: 35/33 °C and 90/93 km/h

⚠️ **The two gaps are chosen, not measured, and so is the speed gate itself.** What follows the table is a solid argument for _why there is hysteresis at all_ — both bare thresholds provably chatter. It is not an argument for 2 °C and 3 km/h rather than 1 and 5, and no measurement has been made that would be. Same §8 caveat as the curve above.

| Threshold        | Starts the fan    | Keeps it running  |
| ---------------- | ----------------- | ----------------- |
| Pack temperature | above **35 °C**   | above **33 °C**   |
| Road speed       | below **90 km/h** | below **93 km/h** |

⚠️ **Nobody asked for this and it is load-bearing anyway.** Both bare thresholds chatter, for two different reasons:

- `batt_temp_hi` is a **signed byte — whole degrees** (`decode-bms.ts`, `signedByte(data[3])`). A pack drifting between 35 and 36 crosses a bare `> 35` on every sample, and at 20 Hz that is a fan starting and stopping twenty times a second. 2 °C means it has to fall two whole counts before it stops, which a pack does over minutes.
- `speed_can_kmh` is `motor_rpm_can / 42.0` at 100 Hz — about 0.02 km/h per count. Riding at an indicated 90 in traffic would cross a bare gate at frame rate. 3 km/h is a second or so of ordinary deceleration.

Each start also costs a 1500 ms kick-start at 100 % and two `pinctrl` spawns, so chatter is not merely ugly.

**One memory, not two.** The hysteresis is a single "is the fan running now" flag — read off the bridge's own enables, not off the previous decision, so a duty set by hand before the mode went back to automatic still counts as a running fan. The consequence to know about: a fan stopped by the SPEED gate at 34 °C then needs 35 °C to restart, not 33, because it is no longer running. That is the conservative direction and it costs one degree.

### What the curve reads

Three signals, each one keystroke away from a near-miss that would be wrong only sometimes — which on a fan with no tacho and no current sense is the worst kind of wrong.

| Used | Not used, and why not |
| --- | --- |
| **`batt_temp_hi`** — the TRUE pack temperature whichever frame supplies it (`registry.ts:37`, `pack-temperature.ts`) | ⚠️ **not `batt_temp_hi_vcu`**, which carries the BMS config's offset. Under the 15-bounded clamp it reads 0 below 35 °C and (true − 35) from 35 to 54 — i.e. exactly the band this curve lives in, reported as something else |
| **`speed_can_kmh`** — broadcast, `source: "stream"`, 0.5 km/h deadband | ⚠️ **not `speed_kmh`**, which is `source: "poll"` on the OBD group: it can be stale, and on a Pi with `OBD_ENABLED=0` it never arrives at all, which would open the gate permanently |
| **`charge_manager_state`** (`0x610` b7) — `0x23` DC, `0x02` AC | ⚠️ **not `charge_type`** (`0x605` b2), which flaps 1↔0 _within one plug-in_ as the charger pauses delivery — fourteen times in one measured AC session, reading 0 for up to eight minutes at a stretch (`docs/charge-manager.md`). That exact behaviour already made the charge-current tile vanish mid-session. Keying the DC curve on it would drop the fan out of DC mode every time the charger paused |

`speed_can_kmh` reads about 3.5 % high against GPS, and that is left alone: it makes the gate fire at a true ~87 km/h, which is the safe side of the one it is protecting.

**A stale signal is not its last value.** Speed older than 3 s (300 missed frames at 100 Hz) reads as _no speed_, which **opens** the gate — a parked bike stops broadcasting `0x104` entirely, and a hot pack in a garage is what the fan is for. A `charge_manager_state` older than 5 s ends the session, the same 5 s `src/vcu/write-runner.ts` uses, because `0x610` simply stops when the cable comes out and nothing ever writes a "not charging" value to notice. An impossible speed — the signal has no `bounds.js` entry, so nothing else gates it — is treated the same way, because the failure that matters is a garbage _high_ reading holding the fan off.

### When the temperature goes away

`batt_temp_hi` has sentinels behind it: this project has `coolant_in` at −242 °C in 59 450 logged rows, which is why `public/lib/bounds.js` exists at all. So the Pi applies **its own** bounds check — `[-30, 90] °C`, the same range the dashboard uses, asserted equal by the check rather than shared through a module the Pi would then depend on the browser code for. A reading outside it is not remembered.

| Since the last **in-bounds** reading | What the fan does |
| --- | --- |
| under 5 s | follows the curve on it |
| 5 s → 60 s | follows the curve on the **last in-bounds reading**, and says so on the dashboard |
| over 60 s | runs at the **30 % floor** and raises a fault |

⚠️ **The third row is the whole point: it is a floor, never an off.** A dead sensor and a cold pack produce the identical observation — no temperature above 35 — and this fan has no tacho, no current sense and no way to be contradicted. "Off" on no evidence is the one answer that can cook a pack while the dashboard looks healthy. 30 % is quiet, costs almost nothing, and is wrong in the survivable direction.

Two consequences worth stating plainly:

- **A bike whose BMS config never emits `batt_temp_hi` runs the fan at 30 % for ever**, one minute after boot. That is the same rule seen from its worst angle, and it is still the right answer: a floor is survivable and "off" on no evidence is not.

  ⚠️ **The fault is _available_, not _shown_.** `fan_auto_reason` is rendered by `public/views/fan.js` and by nothing else, and that section lives behind the menu sheet — there is no fan tile on the main dashboard. So the rider who most needs to see it is the one with no reason to open the sheet, and from the outside a fan at 30 % on a warm day is indistinguishable from a fan at 30 % on the curve. An earlier draft of this section argued for the floor _because_ the fault is on screen; that was doing work the dashboard does not currently do. Surfacing reason 2 on the main view the way a sensor fault is surfaced would make the argument true as written, and is a change to make deliberately rather than a claim this page gets to make today.

- Before the _first_ reading has ever arrived the fan waits rather than running — reason `NO_READING_YET` — because a restart is not a dead sensor. That grace is the same 60 s, so a Pi that never hears from the BMS still ends at the floor.

### The slider, and why there is no arming any more

Phase 1 put the slider behind the same two-tap arm/dwell as every control that writes to the motorcycle. That was a copy of the wrong pattern. This one drives a GPIO on the Pi, cannot reach the bus, and the next command takes it straight back — so:

- **`oninput`, live.** Dragging changes the fan as you drag. Watching the duct while you move the thumb is the whole reason the control exists.
- **Dragging switches to manual**, because otherwise the next automatic tick — at most 2 s away — would put the curve's own duty back and the drag would look broken.
- **The stops are 0, then every whole percent from 30 to 100**, and the slider's value is an _index into that list_ rather than a percentage. (It was 5 % steps until fun mode; §4 "The mapping" has why the finer grid, and why the old justification for the coarse one was false.) Phase 1 ran 0…100 in 5 % steps against a 30 % floor, so 5/10/15/20/25 — a quarter of the travel — all silently meant "stop". Every position now is a duty the Pi will take. A cap lowered below 100 is simply the last stop.
- **The wire is coalesced, the feel is not.** `oninput` fires about twenty times a second; the thumb, the caption and the local duty move on every one of them, while the POSTs are held to one in flight and one queued, at most one per 150 ms. Superseded values are overwritten in the queue and never sent. A Pi Zero 2 W does not want twenty POSTs and forty `pinctrl` spawns out of one gesture.

A command arriving mid-kick still only moves the target, exactly as before — the kick runs its full length or it is not a kick.

#### Why the queue takes `now` and `setTimer` as a pair

`createFanCommandQueue()` accepts both or neither. That is not symmetry for its own sake: injecting the clock alone still leaves the gap between it and the real timer for a loaded machine to widen, and the assertion the seam exists for is an assertion about an _interval_.

The history is worth keeping, because it argues against the fix that looks obvious. `scripts/check-fan-endpoint.ts` §3 used to assert that two coalesced POSTs landed at least `interval - 1` ms apart, with both marks read off `performance.now()`. That millisecond of tolerance was already spent before any load arrived:

- **libuv rounds loop time down.** Loop time is whole milliseconds and `performance.now()` is not, so a `setTimeout` answers its deadline up to ~1 ms _early_ against that clock. Measured on an idle laptop, a `setTimeout(_, 48)` came back **0.835 ms** before its nominal deadline, 2 runs in 400 earlier than the deadline at all.
- **The two marks were not taken symmetrically.** `flush()` stamps `lastSentAt` and the sender reads the clock one async call later, so a deschedule between those two statements came off the first mark only.

Replaying the drag 200 times on an idle machine put the minimum at **59.112 ms against a threshold of 59** — 0.2 % of the interval. It was not flaky by bad luck; it was arithmetically doomed, and it went red on `main` in [run 33280494693](https://github.com/danieltroger/cool-eva/actions/runs/33280494693). Widening the tolerance would have hidden the next real regression along with the noise. Stepping a clock the check owns takes the machine out of the measurement instead, and lets the assertion be an exact equality. `scripts/virtual-clock.ts` is that clock; `scripts/check-virtual-clock.ts` is what keeps it honest, differentially against real `setTimeout`.

`public/views/fan.js` passes neither and keeps `performance.now()` and `setTimeout`. Those two `??` defaults are the only lines in the module that ship, so §4 of the check runs the queue with nothing injected — a seam that leaves production's own path unexercised has traded one blind spot for another.

#### `lastSentAt` starts at −∞, not at 0

"The first move goes at once" is a property of the queue, and with `lastSentAt = 0` it was only a property of the _page_: it held because `performance.now()` is already past one interval by the time a thumb reaches the slider. A drag begun within 150 ms of page load had its first move held.

That was unreachable by a human thumb while the clock was hard-wired. The injection seam made it reachable by any caller who hands the queue a clock relative to its own creation — the most natural clock anyone writes — so the seed is `Number.NEGATIVE_INFINITY`, which makes `Math.max(0, intervalMs - (now() - lastSentAt))` zero from every origin. The check drives the same drag from an origin of 0 as well as from 10 s; with `0` back in the seed, the zero-origin drag is what goes red.

How narrow the old margin really was is worth recording. Instrumenting `main`, `performance.now()` at the top of §3 read **63.4–76.0 ms** across three runs — against the 60 ms interval the check uses. `main` cleared its own precondition by about three milliseconds, and on a faster machine would not have. The same measurement explains a claim this PR originally got wrong: doubling the interval on `main` went red not because any interval assertion caught it, but because 120 ms is more than 76, so the _first_ send was held and three assertions about coalescing collapsed. `public/lib/arming.js:41` carries the same `armedAt = 0` idiom, where it is safe only because every firing site gates on `armed.val` first.

### Fun mode: the throttle drives the fan

> _"a 'fun' mode that only shows up with the bike in park where the throttle controls fan speed — super funny to play around with when bored at charging."_

A third mode beside automatic and manual. While it runs, `throttle_pct` off `0x109` **is** the fan's speed control: closed throttle is the 30 % floor, wide open is the cap, and the fan runs for the whole session. It is entered from the dashboard and it is offered there **only while the bike provably cannot move**.

It is server-side, and that is not an implementation detail. `throttle_pct` arrives at ~100 Hz with `deadband: 0`; routing it out over the WebSocket and back in as HTTP POSTs would be a hundred round trips a second to move a GPIO the Pi is already holding. The dashboard selects the mode; the Pi maps the throttle.

Three files, split the way the temperature curve already is:

| File | What |
| --- | --- |
| `src/fan/fun.ts` | the gate and the mapping, **pure** — values in, an answer out, no I/O and no clock |
| `src/fan/fun-runner.ts` | the half that reads the bus and drives the bridge |
| `src/fan/auto.ts` | owns the mode and **every transition between the three**, so "what can take the fan out of fun mode" is one function in one file |

#### Is the throttle even on the bus while charging?

The whole point is playing with it while plugged in, which is typically key-off, and `0x109` is a drive frame. The owner says it is always there and that he has tested it. The archive agrees, and it settles the two things his answer does not: whether `go` is live at the same time (a gate is worthless if the signal it reads is absent exactly when the mode is wanted) and whether the throttle actually varies while parked.

**`~/Documents/cool-eva-archive/capture-20260808-182129-600daf87.log`**, the 2026-08-08 AC session. The window **opens** on the first `0x610` carrying the AC substate b7 = `0x02` — which in this file is simply the first `0x610`, since b7 reads `0x02` in all 13 410 of them — and the table below **holds it to end of capture**: 4 600.1 s. ⚠️ That is a looser end than the DC scan below uses, and the same file under the DC rule is in "The same rule at both ends". Every figure in the next two tables is the held window:

|                                           |                                                                 |
| ----------------------------------------- | --------------------------------------------------------------- |
| `0x109` frames                            | **317 785**                                                     |
| `0x102` frames                            | **317 785**                                                     |
| `0x104` frames                            | **317 780**                                                     |
| wall-seconds containing ≥ 1 frame of each | **3 181, 3 181, 3 181**                                         |
| awake stretches                           | 23.5 s, then 3 154.6 s, split by **1 422.1 s** of total silence |
| rate inside the awake stretches           | **~100.0 Hz** for all three                                     |

The identical per-second coverage is the load-bearing number. **`go` is exactly as live as the throttle is**: the three frames arrive together and go quiet together, so there is no state in which the throttle can be read and the gate cannot. When the bus sleeps mid-charge — 23.7 minutes of it here — all three vanish, the gate closes, and fun mode is unavailable. That is the correct answer, because a sleeping bus is also a throttle that produces nothing.

What the bits read across all 317 785 frames of `0x102` in that window:

| Signal          | Reading                                         |                                             |
| --------------- | ----------------------------------------------- | ------------------------------------------- |
| `go`            | **1 in 0 frames**                               | the drive is disabled for the whole session |
| `go_request`    | 1 in 0 frames                                   |                                             |
| `moving`        | 1 in 0 frames                                   |                                             |
| `stand_up`      | 1 in 0 frames                                   | on the side stand throughout                |
| `speed_can_kmh` | **exactly 0 in 317 780 of 317 780 (100.000 %)** |                                             |
| `key_on`        | 1 in 234 885 (**73.9 %**)                       | ⚠️ **not** reliably set — 38.2 % bounded    |
| `energized`     | 1 in 132 739 (41.8 %)                           |                                             |
| `throttle_on`   | 1 in 744 (0.234 %)                              | ~7.4 s of somebody twisting it              |

And the throttle itself: **329 distinct raw values**, 734 frames above zero, peaking at raw 743 = **74.3 %**. It is live and it moves. A closed throttle does not read 0 — it reads raw 22–29, i.e. **2.2–2.9 %** — which is why fun mode's floor is a range endpoint rather than a special case.

#### The DC session says the same thing, once the window is bounded properly

The first scan of `capture-20260804-193952-4b4cdd2b.log` reported `go` = 1 in 31.5 % of the window and was **contaminated**, for the reason `docs/charge-manager.md` §"segmenting by capture file" warns about: it held the last-seen `0x610` b7, and that byte persists after the charge manager leaves the bus, so the "session" ran on into the ride that followed.

**The fix is the freshness discipline the gate itself uses — bound the window by the last _fresh_ `0x610`, not by the last-seen byte.** The last `0x610` frame of any kind is at 20:16:05.139; the first `go` = 1 frame in the file is at 20:17:02.756, **57.6 s later**. Every `go` = 1 frame in the window was outside the session, and that is the whole 31.5 %.

Re-scanned with the window opened on the first `0x610` b7 = `0x23` — the DC substate, `CHARGE_MANAGER_STATE_DC` in `src/fan/curve.ts` — and closed on the last `0x610` frame:

|  | held window (the contaminated scan) | bounded by the last `0x610` |
| --- | --- | --- |
| span | 1 698.6 s | **1 061.2 s** |
| `0x102` / `0x104` / `0x109` frames | 169 846 / 169 844 / 169 845 | **106 100 / 106 098 / 106 099** at 99.98 Hz |
| wall-seconds containing ≥ 1 frame of each | 1 700 / 1 700 / 1 700 | **1 063 / 1 063 / 1 063** |
| `go` | 53 657 (31.6 %) | **0** |
| `go_request` / `moving` / `stand_up` | 53 657 / 45 786 / 54 462 | **0 / 0 / 0** |
| `speed_can_kmh` exactly 0 | 123 125 / 169 844 (72.5 %) | **106 098 / 106 098 (100.000 %)** |
| `key_on` | 138 193 (81.4 %) | 74 447 — **70.2 %** |
| `energized` | — | 103 789 (97.8 %) |
| `throttle_on` | — | 63 (0.059 %) |

**So every conclusion above holds on a second and independent session type.** Identical per-second coverage of all three frames, `go` never set, the speed exactly 0 in every frame, and no silence longer than a second in the whole 1 061 s — DC does not sleep mid-charge the way this AC session did. The throttle varies here too: 50 distinct raw values, 61 frames above zero, peaking at raw 404 = **40.4 %**.

#### The same rule at both ends

The correction above fixed how the DC window **opens**. The two scans still closed differently — DC on the last `0x610`, AC on end of capture — and a rule that is strict at one end and loose at the other is how the DC scan got contaminated in the first place. The last `0x610` in the AC file is at 19:07:55.025, and the capture runs on for a further **1 837.0 s**: half an hour of bike after the charge manager left the bus. Bounded the way the DC window now is:

|                                             | AC, held to end of capture  | AC, bounded by the last `0x610`   |
| ------------------------------------------- | --------------------------- | --------------------------------- |
| span                                        | 4 600.1 s                   | **2 763.1 s**                     |
| `0x102` / `0x104` / `0x109` frames          | 317 785 / 317 780 / 317 785 | **134 090 / 134 088 / 134 090**   |
| wall-seconds containing ≥ 1 frame of each   | 3 181 / 3 181 / 3 181       | **1 344 / 1 344 / 1 344**         |
| `go` / `go_request` / `moving` / `stand_up` | 0 / 0 / 0 / 0               | **0 / 0 / 0 / 0**                 |
| `speed_can_kmh` exactly 0                   | 317 780 / 317 780           | **134 088 / 134 088 (100.000 %)** |
| `key_on`                                    | 234 885 — 73.9 %            | 51 190 — **38.2 %**               |
| `energized`                                 | 132 739 — 41.8 %            | 132 739 — **99.0 %**              |
| longest `0x102` silence                     | 1 422.1 s                   | **1 422.1 s**                     |

**Everything the gate rests on is unchanged, and the one figure that matters moves the helpful way.** All four state bits are still 0 in every frame, the speed is still exactly 0 in every frame, and the 1 422.1 s silence is inside the bounded window too — so "the bus sleeps mid-charge, and the gate closes with it" survives untouched. `key_on` is **38.2 %** of the session it was supposed to identify, rather than 73.9 % of a window that outlasts it by half an hour: bounded honestly, plan B is _deader_ than the held figure said, not less dead.

⚠️ `energized` moves the other way, and that is why this correction was worth making rather than a technicality. Its 41.8 % was diluted by the tail — all 132 739 energized frames are inside the bounded window, so it is **99.0 %** of the actual session and **97.8 %** of the DC one. Availability was never the ground for rejecting it and cannot be: see "The alternatives, and why each is not in the gate" below, where it is rejected on what it means.

Both bounded windows are strict subsets of their held ones, so nothing here is a bike that was ridden between two figures — every frame that differs is a frame outside the session.

So, under one rule at both ends of both files: `key_on` is unreliable on **both**, **38.2 %** on AC and **70.2 %** on DC. Two sessions killing plan B rather than one.

#### The gate: what "cannot move" means

Two conditions, both of which must hold, both of which must be **fresh**:

1. **`go` (`0x102` b1 bit 3) is 0.** This is the VCU's own "the drive is enabled" bit. It is the condition, not a proxy for one.
2. **`speed_can_kmh` (`0x104`) is exactly 0.** A second, independently-framed witness, so one frame stalling cannot manufacture a pass on its own. Both witnesses still originate in the VCU — §8 records the count that says there is nothing better on this bus to add, and `scripts/check-fan-fun.ts` §6 is what asserts that `refreshGate()` really hands the gate this signal rather than a constant.

Plus one that is not about safety but about function: **`throttle_pct` (`0x109`) is fresh**, because a stale throttle would leave the fan on the last duty a wrist happened to be holding.

No tolerance band on the speed. `speed_can_kmh` is `motor_rpm_can / 42.0`, so a wheel that is turning is a non-zero reading, and it read exactly 0 in all 317 780 frames above. A bike being rolled by hand therefore drops fun mode — which is right, it is moving. ⚠️ Note that a slow roll raises **no change event**: `speed_can_kmh` carries `deadband: 0.5` in `src/can/registry.ts`, so a reading of 0.4 km/h updates the live value and is never logged, and it is the 250 ms watchdog beat rather than the event path that applies the gate to it. Both are asserted.

**The alternatives, and why each is not in the gate:**

- **`key_on`** — measured at **38.2 %** through the AC session above once the window is bounded to it (73.9 % of the window held to end of capture), dropping to 0 for whole stretches: all 82 900 frames of the vehicle-state byte `0x02`, energized only, fall inside the bounded window. A gate on `key_on` would make the mode unavailable for well over half of exactly the situation it exists for. It is also not a safety property: key on with `go` clear still cannot move.
- **`stand_up`** — 0 for the entire AC session (**all 317 785** frames) and for the whole bounded DC one (**all 106 100**), and it is tempting, because a deployed side stand is a _physical_ interlock the Energica will not enter Go against. Rejected **for the hazard of the fan running while the bike moves**, which `go` covers completely and in milliseconds. ⚠️ That is not the only hazard this mode creates, and the other one is the reason `stand_up` stays on the table: the mode trains a rider to sit twisting the throttle of a parked motorcycle for minutes at a time, and `go` is a **lagging** indicator of that — it reads 1 only once the bike already can move, by which time the wrist is on the grip. `stand_up` is the only signal on this bus that speaks to whether the bike can be _put into_ that state while a session runs. Two independent charges say it costs nothing in availability, unlike `key_on` (**38.2 %** AC / 70.2 % DC, both bounded). **What stops it being added today** is that `stand_up` has never been observed as 1 anywhere in this archive, so nothing distinguishes "the bit means the stand is up" from "the bit is stuck at 0" — and adding a never-1 signal to a fail-closed gate either works or makes fun mode permanently unavailable, silently. The measurement to take: put the bike on the stand, lift it upright, watch the bit. Then decide.
- **`moving`** (`0x102` b2 bit 7) — derived by the VCU from road speed, from the same frame as `go`, and decoded from a third party's `.xdbc` rather than measured here. It duplicates the speed condition without adding an independent witness, and every extra condition is another way for the mode to be silently unavailable.
- **`energized`** — **99.0 %** of the bounded AC session and 97.8 % of the DC one, so availability is not the objection (the 41.8 % of the held AC window was the half-hour tail diluting it). It says the HV system is up, not that the bike can move, and that is the objection.

⚠️ **The failure this gate is against is not subtle.** It maps the throttle of a 145 hp motorcycle onto something that is not the motor. If it is wrong in the permissive direction, somebody twists a throttle expecting a fan.

#### Fail-closed, and why its polarity is the opposite of the speed gate next door

`src/fan/fun.ts`'s `funGate()` returns a refusal from every branch except its last line. Absent, stale, `NaN`, negative, or a value nobody anticipated — all refusals. The only route to `READY` is three signals present, fresh, and reading the specific values that mean a stationary bike with the drive disabled.

⚠️ **This is the exact opposite of `src/fan/curve.ts`'s speed gate, and the two must not be tidied to match.** There, a missing `speed_can_kmh` **opens** the gate, because a parked bike stops broadcasting `0x104` and a hot pack in a garage is the case the fan exists for; holding the fan off on a stale 120 km/h reading is the dangerous direction. Here, a missing anything **closes** the gate, because this one has to _prove_ the bike cannot move and a signal nobody is refreshing proves nothing. Same signal, opposite default, both correct — `scripts/check-fan-fun.ts` §3 asserts both so that flattening one into the other goes red.

Freshness is **500 ms** (`FUN_GATE_MAX_AGE_MS`), which at the measured ~100 Hz is 50 consecutive missed frames. Deliberately far tighter than the curve's 3 s, because this is an interlock in front of a throttle rather than a hint about airflow.

#### Dropping out is immediate, not at the next tick

`go` going true is a **change event**. `src/can/signals.ts` already batches changed signals into a microtask for the WebSocket, and fun mode subscribes to the same stream, so the drop-out runs on the same event that carries the bit — single-digit milliseconds after the frame decodes, not at a poll boundary. The fan is handed back to the temperature curve, which re-evaluates at once.

⚠️ That subscription is why `onChange()` became a **list** rather than one slot. It held a single listener that each call replaced; with a second subscriber, whichever registered last would have silently switched the other off — either a dashboard that never updates, or a fun mode that never sees the throttle.

⚠️ And widening it is why each listener now runs inside its own `try`/`catch`. With one slot a listener that threw was a self-inflicted wound; with two, `src/ws.ts` and `src/fan/auto.ts` could take each other down — the loop runs inside a `queueMicrotask` callback, so an escaped throw is an `uncaughtException` with no handler registered anywhere in `src/index.ts`, and the process ends with the CAN logging and the WebSocket inside it. A toy fan mode must not be able to do that to the dashboard's feed.

**Both of fun mode's own entry points are guarded the same way, through `runFunPass()`.** They are the two paths in `src/fan/` that the timer's `runTick()` does not cover: the change listener **discards** its promise at ~100 Hz, and `enterFun`'s travels out through `switchMode` → `setMode` → `src/http/fan.ts` into `src/index.ts`'s `createServer(async …)`, which Node does not await either. A rejection on either would be unhandled. Nothing in `src/fan/control.ts` rejects today — which is exactly the argument `scripts/check-fan-curve.ts` §11 already declined to accept for the timer, since it is a property of another file. A failed pass is logged, the commanded duty is forgotten so the next pass commands rather than matches, and entry answers `/fan` with a refusal that names the call that failed rather than crashing the request.

⚠️ **The in-flight flag reads the gate before it returns.** `funCommandInFlight` is what keeps ~100 Hz of throttle events from queueing writes without bound, and its early return sits _below_ a gate read on purpose. Above one, a `setDutyPercent()` that **hangs** rather than rejects would leave the flag true for ever and every route out of the session would end at `driveFun`'s first line — the throttle events, and the 250 ms watchdog beat too, since that beat is also just `driveFun`. The one mechanism meant to end the session when the bus goes quiet could not run, while `fan_fun_gate` went on publishing `GO_SET` to the dashboard. Handing the fan back does not need the bridge to be free. Nothing in `control.ts` can wedge it today — `runExclusively` chains on settlement — so this is the same class of guard as the two above.

Events cannot cover everything: **a bus that goes silent raises no event**, so the fan would otherwise sit on the throttle's last duty for ever. `FUN_WATCHDOG_MS` is 250 ms, and while fun mode runs the loop's own timer is re-armed at that instead of the curve's 2 s. So:

- the **duty** follows the throttle on events — as fast as the frames arrive, and no work at all while the throttle is still;
- the **gate** is re-checked on those same events _and_ four times a second regardless.

Hand-back goes to **automatic**, never to manual. Manual would leave the fan on whatever duty the throttle was holding for the rest of the ride with nothing watching the pack; automatic puts it back on the curve — including the road-speed gate — before the rider is out of the bay.

And like manual, the mode is **in memory only**. Nothing is written to disk, so every start is automatic. A mode that put the throttle on the fan and survived a reboot would be waiting for a rider who did not ask for it.

#### The mapping, and the resolution you can hear

Throttle 0…100 % onto duty **30…100 %** — `MIN_RUNNING_DUTY_PERCENT` to `MAX_DUTY_PERCENT`, linear, nothing else. Closed throttle is the floor, not a stop.

**That the bottom of the range is the floor and not 0 is the design, not a rounding.** No duty the throttle can produce crosses `src/fan/control.ts`'s stop threshold, which means:

- the bridge enables are set **once on entry and cleared once on exit**. A throttle sweep never spawns `pinctrl`, so there is no enable-thrash to defend against and **no hysteresis and no hold-at-the-bottom** — neither exists here, deliberately;
- every throttle movement is one `duty_cycle` write to sysfs and nothing else;
- there is no "fun mode but the fan is off" state to reason about. You leave the mode to stop the fan.

Entry still **kick-starts** — 100 % for 1500 ms — because the fan is starting from rest like any other start, and it is not special-cased. A throttle moved during the kick moves the target only; the kick runs its full length or it is not a kick. Exit still stops the fan properly: enables LOW first, then the output, then the duty, which is §3's mirror rule and the reason a stop is never a duty of 0 under a live bridge.

**The duty is a fractional percent, end to end, and rounding it would destroy the thing the mode is for.** The arithmetic:

|  |  |
| --- | --- |
| `throttle_pct` | `u16le(b0, b1) / 10` off `0x109` — **0.1 % resolution**, confirmed on the wire by consecutive raw values (22, 23, 24, 25, 26, 27, 28, 29) |
| one throttle step through the mapping | 0.1 % × 0.70 = **0.07 % of duty** |
| …as nanoseconds of the 50 000 ns period | **35 ns** |
| the full sweep | 1 000 steps → **35 000 ns**, 70 % of the period |
| …in PWM counts, at a 50 MHz clock (2 500 counts of 20 ns) | **~1.75 counts per throttle step**, ~1 750 across the travel |

🟡 The 50 MHz figure is the clock the overlay is understood to leave in place; it has **not** been measured on this Pi. The conclusion does not depend on it: one throttle step is 35 ns, so any PWM clock at or above **28.6 MHz** resolves every step. Rounding the duty to whole percent would collapse roughly fourteen steps in fifteen — `scripts/check-fan-fun.ts` §2 asserts that all 1 000 raw steps reach the bridge as different `duty_cycle` values, and a `Math.round` anywhere on the path goes red.

The slider's grid moved from 5 % to **1 %** in the same change, and the old constant's stated reason — _"finer is not a duty this fan resolves"_ — was simply false: the bridge resolves ~0.04 %. The real reason for a coarse grid was thumb precision on a phone, and that has now been traded away on purpose. Nobody cares whether it is 47 or 48 %; sliding it and hearing the fan change immediately is worth more.

#### What it costs the log and the socket

`fan_duty_pct` has **no deadband**, and does not get one. In fun mode it therefore tracks `throttle_pct` at the full frame rate, and that is the point: comparing how fast the throttle moves against how fast the fan responds is a measurement the log can only make if the output half is not filtered. `throttle_pct` is already `deadband: 0` at ~100 Hz and contributed 1 038 747 rows over seven days, so this is not a new class of load — roughly one more signal of the same size, on a card with ~108 GB free and a compressed log.

⚠️ One consequence to know about rather than to fix: `MAX_CLIENT_BACKLOG_BYTES` (`src/ws.ts`) is 256 kB, described there as "ten seconds of riding". A second ~100 Hz signal roughly halves that in wall time — **while fun mode is running**. It does not touch the riding figure, because fun mode cannot run while the bike can move. A suspended phone hitting the cap is existing, understood behaviour: it is dropped and resynchronises from the next 5 s snapshot.

#### What is not verified

- **The gate has never run against a real bike.** Every assertion is against the archive and against replayed values.
- **No fun-mode session has ever driven the real bridge.** The end-to-end check drives a recording `FanPwm`, not a Pi.
- **The 50 MHz PWM clock is assumed, not measured** — see above for why nothing rests on it.
- **`stand_up` is decoded but unused here.** It reads 0 through both charges, which is consistent with the decode and does not establish it as an interlock — the bit has never been seen as 1 anywhere in this archive, so "the stand is down" and "the bit is stuck" are indistinguishable from the data. That is a measurement to go and take rather than a reason to leave it out for ever; §4's rejected-alternatives list says what it would buy and what it would cost.

## 5. Kernel setup on the Pi

### `/boot/firmware/config.txt`

```
dtoverlay=pwm,pin=18,func=2
gpio=17,op,dl
gpio=27,op,dl
```

The overlay puts GPIO18 on the SoC's PWM0 channel. The two `gpio=` lines drive the enables low **at boot, before this service starts**, so a Pi that is booting, crashed, or running an old build leaves the bridge in standby rather than in whatever state the pins powered up in. After a `SIGKILL`, which skips the shutdown handler in `src/index.ts`, the enables are put back by the restarted process about five seconds later (§8); these lines are the backstop for a Pi that does not come back.

Reboot after editing; an overlay is not applied at runtime.

**`dtparam=audio` is not part of this on a Zero 2 W**, and there is deliberately no `dtparam=audio=off` above. The overlay README warns that the onboard analogue audio output uses both PWM channels — true on a Pi 3 or 4, whose device tree puts `audio_pins` at `<40 41>` in Alt0, i.e. PWM0/PWM1. `bcm2710-rpi-zero-2-w.dts` declares `audio_pins { brcm,pins = <>; }` — empty — so there is nothing to conflict with and `dtparam=audio` there only toggles HDMI audio. `INSTALL.md` invites any Pi with SPI and USB, so: **if you are on a Pi with analogue audio out, the conflict is real and `dtparam=audio=off` is what resolves it.**

### Which `pwmchipN`?

**The chip number moves with the kernel version and with what else is loaded.** It is not reliably 0 — newer kernels have numbered the same peripheral 1 or 2 — so `src/fan/pwm.ts` discovers it: it lists `/sys/class/pwm`, keeps the chips that offer channel 0 according to their `npwm`, and prefers one whose `device` symlink names an SoC `.pwm` block. It logs which it picked, warns if it had to guess between several, and fails with the `dtoverlay` line quoted if there is nothing to pick.

By hand, the sequence is:

```sh
ls /sys/class/pwm                       # pwmchip0, pwmchip2, …
readlink /sys/class/pwm/pwmchip0/device # …/3f20c000.pwm on a Zero 2 W
echo 0     | sudo tee /sys/class/pwm/pwmchip0/export
echo 50000 | sudo tee /sys/class/pwm/pwmchip0/pwm0/period      # ns → 20 kHz
echo 25000 | sudo tee /sys/class/pwm/pwmchip0/pwm0/duty_cycle  # ns → 50 %
echo 1     | sudo tee /sys/class/pwm/pwmchip0/pwm0/enable
```

**`period` first on a channel you have just exported.** A fresh export has `period = 0`, and `__pwm_apply()` rejects _any_ `duty_cycle` write against a zero period with `EINVAL` — the check sits ahead of its "nothing changed, return 0" early return, so even `echo 0 > duty_cycle` fails. `pwm-bcm2835` defines no `.get_state`, so that zero is never refreshed from the hardware; it stays until something writes a period.

The opposite order — `duty_cycle` first — is only right when the period is _shrinking_ under a live duty, since the kernel also rejects a duty longer than the period it is written against. That case cannot arise here: `PWM_PERIOD_NS` is a constant, so a channel an earlier run left exported already holds exactly it. `src/fan/pwm.ts` reads the period it gets back from the export check (below) and picks the order from it.

Nothing here ever unexports the channel. Re-exporting an already-exported channel returns `EBUSY`, which the code treats as the routine restart case.

### The udev rule

`/sys/class/pwm` is root-only by default. The service currently runs as root (see `INSTALL.md` §7), so it works without this — but if you ever run it unprivileged, or want to poke the files as `pi`, install:

```sh
sudo tee /etc/udev/rules.d/99-pwm.rules <<'EOF'
SUBSYSTEM=="pwm", ACTION=="add", \
  RUN+="/bin/chgrp -R gpio /sys%p", RUN+="/bin/chmod -R g=u /sys%p"
SUBSYSTEM=="pwm", ACTION=="change", ENV{EXPORT}=="*", \
  RUN+="/bin/chgrp -R gpio /sys%p/pwm%E{EXPORT}", RUN+="/bin/chmod -R g=u /sys%p/pwm%E{EXPORT}"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

The second stanza matters: the per-channel `pwmN/` directory does not exist until it is exported, so a rule that only fires on `add` chowns the chip and leaves the channel's own `period`, `duty_cycle` and `enable` owned by root. `src/fan/pwm.ts` reads `period` right after exporting for exactly this reason, and says so when it comes back `EACCES`.

**This repo does not install the rule.** Writing udev rules into a user's `/etc` from a telemetry service is not a thing a telemetry service should do.

There is a known race even with the rule in place: udev chowns the new directory some milliseconds after the export returns. Nothing here retries; if this ever bites, that is where to add it.

### `pinctrl`

The enables are driven with `pinctrl set 17 op dh` / `op dl` (Bookworm's `raspi-utils`), spawned per change through a promisified `execFile`. They change twice a session, so a process is cheap — cheaper than the native GPIO module CLAUDE.md's deploy notes exist to avoid.

If `pinctrl` is missing the driver says so by name (`sudo apt install raspi-utils`) and fails the command. That failure is safe: with no way to drive the enables, they stay in the low state the `config.txt` lines put them in, so the fan does not spin.

## 6. Endpoint and dashboard

`GET /fan` reports the driver's state, its `fault` if it has one, and the limits it enforces. It touches no hardware.

`POST /fan?duty=N` commands a duty in whole percent **and switches the fan to manual**; `POST /fan?mode=auto` hands it back to the curve, `POST /fan?mode=manual` freezes it where it is, and `POST /fan?mode=fun` (or `mode=play`) puts the rider's throttle on it. Passing both `duty` and `mode` is a 400 rather than a guess about which was meant. A fun-mode request the gate refuses answers **503** with the reason in `message` — the same status an unusable driver gets, and deliberately so: "the request was fine, the bike is in Go, ask again when it is parked" is the same shape of answer. Every POST must carry **`X-Cool-Eva: fan`**. POST rather than GET for the reason `/can-restart` is a POST: this one spins a fan blade, and a prefetch or a crawler must not be able to do that by following a link. The header is there because POST alone is not enough — this server sends no `Access-Control-*` headers and has no auth, so a plain cross-origin `<form method="POST" action="http://cool-eva.local/fan?duty=100">` on any page the rider's phone opens is a _simple_ request that reaches the endpoint. CORS would only stop the attacker reading the reply. A custom header name is what forces a preflight this server never answers. Its value is `fan`, not `/vcu-write`'s `service-write`, so a caller built for that endpoint cannot reach this one.

Both are routed only when `FAN_ENABLED=1`. On any other Pi `/fan` is a 404, which is what `public/views/fan.js` reads to hide the whole section.

The slider and the Auto/Manual toggle live in the menu sheet, on one row because they are one control: the toggle says who is moving the thumb, and moving the thumb changes the toggle. **The Fun button is a third control on that row and it is bound to `fan_fun_available` — the live signal, not the last `/fan` reply — so it appears and vanishes with the gate rather than at the next time somebody reloads.** It is hidden while fun mode is running, because the mode toggle then reads "🎢 Fun" and is how you leave. The page cannot _enter_ the mode, only ask: the Pi re-reads the gate off the bus before it agrees, so the button appearing is a display of permission and never the permission itself. ⚠️ There is **no arming** in front of either, unlike every other actuating control on this dashboard — §4 "The slider" is the argument. The mode is **in memory only and automatic on every start**; it is deliberately never written to disk, because the Pi loses power with the bike's 12 V rail, so "manual until the bike is switched off" is what not persisting it already means.

Eight signals reach the dashboard and the ride log. Every one is what the Pi **commanded or decided**, never what it measured: this fan has no tacho, so nothing here can tell you the rotor is turning. All six are registered `onDemand` in `src/can/registry.ts` — a fan sitting at 60 % writes nothing for an hour, and silence is its resting state.

| Signal | Meaning |
| --- | --- |
| `fan_duty_pct` | what the bridge is being given. 100 for the length of a kick-start |
| `fan_target_pct` | what was **asked** for. It differs from the above only during a kick, which is exactly how the dashboard tells "kicking" from "settled" without a second round trip |
| `fan_driver_enabled` | 1 = both IBT-2 enables HIGH. 0 = standby, every FET off |
| `fan_auto_mode` | `FAN_MODE_CODE` in `src/fan/auto.ts` — 0 manual, 1 automatic, **2 fun**. 0 and 1 keep the meaning every row already in a ride log has |
| `fan_auto_reason` | which rule set the duty — the `FAN_REASON` enum in `src/fan/curve.ts` |
| `fan_temp_input` | whether the temperature under that decision was live, held, or absent — `FAN_TEMPERATURE_INPUT` |
| `fan_fun_available` | 1 while the gate is satisfied. This is what the sheet shows and hides the Fun button on |
| `fan_fun_gate` | which condition failed — the `FUN_GATE` enum in `src/fan/fun.ts`, so "why did the button not appear" is answerable from the ride log rather than from a guess |

The last four are **codes, not text**, because a signal is a number; the sentences live in `public/lib/fan-display.js` and `scripts/check-fan-curve.ts` and `scripts/check-fan-fun.ts` assert that every code has both a sentence there and a bound in `public/lib/bounds.js`. Adding a reason without doing either goes red rather than rendering a bare integer or being drawn as a dead sensor.

⚠️ Widening `fan_auto_mode`'s bound to `[0, 2]` was **not** bookkeeping. At `[0, 1]` the new code 2 is rejected as a sentinel, `public/lib/store.js` keeps the previous value, and the sheet reads "Manual" over a fan taking its orders from a throttle.

## 7. Running it

```sh
sudo systemctl edit cool-eva
# [Service]
# Environment=FAN_ENABLED=1
sudo systemctl restart cool-eva
```

`FAN_ENABLED` is **opt in** — `=== "1"`, deliberately the opposite of `COOLANT_ENABLED` and `OBD_ENABLED`, which are opt out. Almost no Eva has this fan, so the default has to be a Pi that never opens `/sys/class/pwm`, never spawns `pinctrl` and never serves `/fan`.

A healthy start logs:

```
fan: PWM ready on /sys/class/pwm/pwmchip0/pwm0 at 50000 ns, bridge in standby
fan: duty control ready — 30…100 %, 1500 ms kick-start from rest, POST /fan?duty=N
fan: automatic on 2000 ms ticks — batt_temp_hi drives the curve, speed_can_kmh gates it, charge_manager_state 0x23 switches to the DC curve
```

Without the variable it logs one line and does nothing else:

```
fan: disabled (set FAN_ENABLED=1 on a bike with the IBT-2 fan driver wired up)
```

Bring-up failures do not kill the service — the fan is not what the rest of this process is for — so a missing overlay or a missing `pinctrl` becomes the `fault` string that `/fan` and the sheet report.

## 8. Known gaps

- **The locked-rotor current has never been measured**, so the kick-start is not demonstrated fuse protection and §4 no longer says it is. The measurement that would settle it — armature resistance, giving locked-rotor current as `12 / R` — is written up there. Until then the kick is an anti-stiction measure and nothing more.
- **No feedback of any kind.** No tacho, no current sense (`R_IS`/`L_IS` are unconnected), so "commanded 60 %" is the only claim this software can make. That cuts both ways, and the second way is the easier one to miss:
  - a stalled rotor after a successful kick is invisible until the coolant temperature says so;
  - **a fuse that _does_ clear is equally invisible.** The Pi goes on writing duty cycles into a dead circuit and the dashboard goes on rendering "Running at 60 %", because that is what was commanded. Nothing here can tell a spinning fan from an open fuse — which is why the fuse argument in §4 could never have been self-checking even if the numbers had held.
- **Fun mode has never run on the bike.** The gate, the mapping and the drop-out are asserted against the capture archive and against a recording `FanPwm`; no session has driven the real bridge. §4 "What is not verified" lists what that leaves open.
- **Manual mode has no shutoff.** In automatic the curve takes the fan back down on its own; a duty set from the slider runs until you set another, until the mode goes back to automatic, or until the service restarts — and a restart is a return to automatic, since the mode is not persisted. A `SIGTERM` (`systemctl restart`, the dashboard's Update button) stops the loop and then idles the bridge, in that order, so a tick cannot re-command a process that is leaving. A `SIGKILL` skips both — but the unit is `Restart=on-failure` with `RestartSec=5` (`scripts/setup-service.ts`), so the process is back about **five seconds** later and `openFanPwm()` drops both enables as its first statement. The `config.txt` `gpio=` lines are the backstop for the case where it does not come back at all.
- **The automatic curve was never validated against a real pack.** Every number in §4 — 35, 48, 54, the two hysteresis gaps — is a considered choice, not a measurement of how much air this radiator needs at a given pack temperature. What exists is the arithmetic, checked; what does not exist is a ride or a DC session logged against it. The first hot DC charge with `FAN_ENABLED=1` is the datum to go and get.
- **A pack whose `batt_temp_hi` never arrives runs the fan at 30 % for ever** in automatic, one minute after boot, with the fault visible only inside the menu sheet and nowhere on the main dashboard. §4 "When the temperature goes away" argues why the floor is the right answer and not a bug, and says plainly what the fault does and does not reach.
- **The rail voltage is unmeasured**, so the duty cap is 100 % — see §4.
- **The udev race** described in §5 is unhandled.
- **Fun mode's second gate condition is the same frame's neighbour, not an independent sensor.** `go` and `speed_can_kmh` come off different CAN ids (`0x102` and `0x104`), which is real independence at the frame level, but both originate in the VCU. Nothing here cross-checks the VCU against anything, and an all-zero `0x102` payload would read as "everything off" and pass the `go` half. The freshness window is what stands against that — a stuck frame stops being refreshed — and it is the weakest joint in the gate.

  **There is measurably no better third witness, and that is now a measurement rather than an absence of ideas.** Per-second coverage of every non-VCU frame inside the AC charge window of `capture-20260808-182129-600daf87.log`, **held to end of capture** — §4 "The same rule at both ends" has both windows — against `0x102`'s own 3 181 seconds:

  | frame | frames | seconds | coverage |
  | --- | --- | --- | --- |
  | `0x0A0` ABS — wheel speeds, a genuine second speed sensor | **0** | **0** | **0 %** |
  | `0x610` / `0x605` / `0x615` charge manager | 13 410 / 13 402 / 13 391 | 1 344 / 1 343 / 1 341 | **~42 %** |
  | `0x645` | 0 | 0 | 0 % |
  | `0x200` BMS | 63 472 | 3 181 | **100 %** |

  The one genuinely independent speed measurement on this bus — `wheel_speed_front_kmh` / `_rear_kmh` off the ABS module — is **completely absent during a charge**. That is not a gap in the tap or in the decoder, and the same file settles it: in the DC capture `0x0A0` is 0 frames inside the bounded charge window and **6 371 frames across 638 wall-seconds** of the ride that follows it in the same file, at 9.99 Hz — the 10 Hz `src/can/abs.ts` documents. Present when riding, absent when charging, same tap and same decoder. Consistent with `abs.ts`'s note that the module is on DTB and reaches us only because the VCU gateways it across: no ride, no gateway.

  The charge manager is present for less than half the held window, which makes it a worse `key_on`. ⚠️ The held window is the one that can answer this question at all: bound it by the last `0x610` and the charge manager covers 1 344 of 1 344 seconds **by construction**, which measures the window's own definition rather than the frame's availability. `0x0A0` is 0 under either window, and that is the load-bearing row. The BMS is live throughout and has nothing to say about mobility. So **the 500 ms freshness window standing alone against a stuck VCU frame is the right conclusion**, not a compromise — there is nothing else on this bus to add.
