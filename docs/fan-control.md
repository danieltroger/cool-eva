# Cooling-fan control (IBT-2 / BTS7960 + SPAL VA69A)

The watercooling loop's radiator fan, driven from the Pi over hardware PWM. This is the write-up the code points at: `src/fan/pwm.ts` (sysfs and `pinctrl` I/O), `src/fan/control.ts` (bring-up order and the duty rules), `src/fan/curve.ts` (the automatic curve, pure), `src/fan/auto.ts` (the loop that feeds it), `src/http/fan.ts` (the endpoint), `public/views/fan.js` (the slider and the mode toggle in the menu sheet) and `public/lib/fan-command-queue.js` (the coalescer that turns a drag into one POST in flight and one queued).

**Phase 2: the fan follows the pack temperature, and the slider takes it over.** The Pi starts in AUTOMATIC and drives the fan off `batt_temp_hi`; dragging the slider hands it to you until the bike is switched off. The curve is `src/fan/curve.ts` (pure arithmetic), the loop that feeds it is `src/fan/auto.ts`, and both are argued in §5.

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
- **The stops are 0, then 30…100 in 5 % steps**, and the slider's value is an _index into that list_ rather than a percentage. Phase 1 ran 0…100 in 5 % steps against a 30 % floor, so 5/10/15/20/25 — a quarter of the travel — all silently meant "stop". Every position now is a duty the Pi will take. A cap lowered below 100 is simply the last stop.
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

`POST /fan?duty=N` commands a duty in whole percent **and switches the fan to manual**; `POST /fan?mode=auto` hands it back to the curve, and `POST /fan?mode=manual` freezes it where it is. Passing both `duty` and `mode` is a 400 rather than a guess about which was meant. Every POST must carry **`X-Cool-Eva: fan`**. POST rather than GET for the reason `/can-restart` is a POST: this one spins a fan blade, and a prefetch or a crawler must not be able to do that by following a link. The header is there because POST alone is not enough — this server sends no `Access-Control-*` headers and has no auth, so a plain cross-origin `<form method="POST" action="http://cool-eva.local/fan?duty=100">` on any page the rider's phone opens is a _simple_ request that reaches the endpoint. CORS would only stop the attacker reading the reply. A custom header name is what forces a preflight this server never answers. Its value is `fan`, not `/vcu-write`'s `service-write`, so a caller built for that endpoint cannot reach this one.

Both are routed only when `FAN_ENABLED=1`. On any other Pi `/fan` is a 404, which is what `public/views/fan.js` reads to hide the whole section.

The slider and the Auto/Manual toggle live in the menu sheet, on one row because they are one control: the toggle says who is moving the thumb, and moving the thumb changes the toggle. ⚠️ There is **no arming** in front of either, unlike every other actuating control on this dashboard — §4 "The slider" is the argument. The mode is **in memory only and automatic on every start**; it is deliberately never written to disk, because the Pi loses power with the bike's 12 V rail, so "manual until the bike is switched off" is what not persisting it already means.

Six signals reach the dashboard and the ride log. Every one is what the Pi **commanded or decided**, never what it measured: this fan has no tacho, so nothing here can tell you the rotor is turning. All six are registered `onDemand` in `src/can/registry.ts` — a fan sitting at 60 % writes nothing for an hour, and silence is its resting state.

| Signal | Meaning |
| --- | --- |
| `fan_duty_pct` | what the bridge is being given. 100 for the length of a kick-start |
| `fan_target_pct` | what was **asked** for. It differs from the above only during a kick, which is exactly how the dashboard tells "kicking" from "settled" without a second round trip |
| `fan_driver_enabled` | 1 = both IBT-2 enables HIGH. 0 = standby, every FET off |
| `fan_auto_mode` | 1 automatic, 0 manual |
| `fan_auto_reason` | which rule set the duty — the `FAN_REASON` enum in `src/fan/curve.ts` |
| `fan_temp_input` | whether the temperature under that decision was live, held, or absent — `FAN_TEMPERATURE_INPUT` |

The last two are **codes, not text**, because a signal is a number; the sentences live in `public/lib/fan-display.js` and `scripts/check-fan-curve.ts` asserts that every code has both a sentence there and a bound in `public/lib/bounds.js`. Adding a reason without doing either goes red rather than rendering a bare integer or being drawn as a dead sensor.

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
- **Manual mode has no shutoff.** In automatic the curve takes the fan back down on its own; a duty set from the slider runs until you set another, until the mode goes back to automatic, or until the service restarts — and a restart is a return to automatic, since the mode is not persisted. A `SIGTERM` (`systemctl restart`, the dashboard's Update button) stops the loop and then idles the bridge, in that order, so a tick cannot re-command a process that is leaving. A `SIGKILL` skips both — but the unit is `Restart=on-failure` with `RestartSec=5` (`scripts/setup-service.ts`), so the process is back about **five seconds** later and `openFanPwm()` drops both enables as its first statement. The `config.txt` `gpio=` lines are the backstop for the case where it does not come back at all.
- **The automatic curve was never validated against a real pack.** Every number in §4 — 35, 48, 54, the two hysteresis gaps — is a considered choice, not a measurement of how much air this radiator needs at a given pack temperature. What exists is the arithmetic, checked; what does not exist is a ride or a DC session logged against it. The first hot DC charge with `FAN_ENABLED=1` is the datum to go and get.
- **A pack whose `batt_temp_hi` never arrives runs the fan at 30 % for ever** in automatic, one minute after boot, with the fault visible only inside the menu sheet and nowhere on the main dashboard. §4 "When the temperature goes away" argues why the floor is the right answer and not a bug, and says plainly what the fault does and does not reach.
- **The rail voltage is unmeasured**, so the duty cap is 100 % — see §4.
- **The udev race** described in §5 is unhandled.
