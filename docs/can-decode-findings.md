# CAN decode findings

The long-form record behind `src/can/` — what each frame's layout rests on, which scalings are measured and which are the manufacturer's word, and the hypotheses that were tried and refuted. It is organised by CAN id, and every decoder in `src/can/` points here from the line the constraint applies to.

**Why it lives here and not in the margin.** These are findings, and CLAUDE.md's comment rule sends findings to `docs/`: forty lines above a decoder is a document wearing a comment's clothes, and it buries the one sentence the reader at that line actually needs. Nothing was shortened on the way over — a refuted hypothesis costs a session to establish and gets re-derived, sometimes as a wrong belief that ships, so match rates, sample counts and provenance are carried across intact.

**How to read the markers**, which are used consistently throughout:

| marker | meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| ✅     | confirmed by measurement on this bike                                  |
| 🟡     | inferred — plausible and consistent, but not pinned                    |
| ❓     | open question, deliberately not filled in                              |
| ❌     | refuted; recorded so it is not re-derived                              |
| 🚨     | a claim that shipped and was WRONG — do not restore it                 |
| 📘     | read off a document (schematic, vendor table) rather than off this bus |
| 🔎     | the check that would settle it, for whoever gets the chance            |

**Corpus.** Captures live in `~/Documents/cool-eva-archive/`. Figures quoted as "the garage lap" are the 2026-08-02 capture (545 882 frames, 409 s, never above 11.5 km/h); "the road captures" are `capture-20260804-035631-c8fe853f.log` and `capture-20260804-193952-4b4cdd2b.log`. Where a figure is quoted over "the whole archive" it is a rescan of every `*.log` and `*.txt` there — 245 files as of 2026-08-20.

⚠️ **A garage lap is not a characterisation.** The single most expensive lesson in this file: every quantitative claim derived from the 2026-08-02 lap about wheel speed — the scale, and a "9 % channel disagreement" — turned out to be an artefact of walking-pace manoeuvring. A frame is not characterised until it has been seen at the speeds it exists for. The same mistake cost 0x125 its scale as well.

---

## 0x020 / 0x022 — inverter and motor temperatures

`src/can/decode.ts`.

**0x020 — inverter temperatures**, four s16 LE ÷10 °C at 10 Hz. Captured 2026-08-02 parked: `10 01 10 01 10 01 10 01` → 27.2 °C on all four, against OBD ambient 28 °C on a cold bike. The three IGBT fields moved together (26.9…28.0 °C over 40 s) while the gate field held 27.2 °C throughout, which is what separates the fourth channel from the first three. A garage lap later the same day put load on them: the IGBT channel rose 27.5 → 38.1 °C while the gate rose 27.4 → 30.0 °C, so the two are decidedly different measurements and the IGBT one is the most responsive thermal signal on the bike. 🟡 min/inst/max still never separated from each other, so their order among themselves is a guess.

The `.xdbc` calls all four unsigned; they are read **signed** anyway. Every real temperature from 0…3276.7 °C decodes identically either way, so signed cannot regress anything, and a below-zero reading is right instead of wrapping to ~6553 °C — which the 0.5 °C deadband would happily log all winter, wrecking the axis of any panel these share with the s16 motor temperature from 0x022.

**0x022 — motor temperature**, b4-5 LE s16 ÷10 °C at 10 Hz. Captured 2026-08-02: `00 00 00 00 13 01 00 00` → 27.5 °C, against OBD PID 05 reading 27 °C in the same minute. ✅

Those two numbers agreeing at rest made it look like PID 05 was this same sensor at coarser resolution. The garage lap that afternoon showed it is not: under load PID 05 rose 27 → 30 °C in step with 0x020's inverter gate channel, while this one moved 27.9 → 28.5 °C. They are separate sensors that happen to sit at ambient on a cold bike, which is why this gets its own key.

The other six bytes read all-zero across the whole capture. The `.xdbc` splits them into u16 pairs but assigns no meaning, so they stay undecoded rather than invented.

---

## 0x025 / 0x10A — instantaneous consumption and residual energy

`src/can/decode.ts`.

**0x025** — `INST.CONS`, b0-1 LE ÷10 = Wh at 50 Hz. ✅

**0x10A b3-4** — LE, **bit 15 masked off**, × 2 = `RES.ENERGY` Wh (residual/available energy). Bit 15 is a FLAG, not part of the value: it toggles on ~half the frames, so reading the raw word alternated between the true value and value + 65536 — the square wave in Grafana. Confirmed on 45 k logged samples (every value showed up as a 0x8000-apart pair) and against the engineering menu at two SOCs: 4778 × 2 = 9556 vs menu 9557, and 1095 × 2 = 2190 vs menu 2190. ✅

**0x10A b7** — `CHG.PWR.REF` % → the AC charge-current setpoint; amps = b7 ÷ 7. Reverse-engineered live: 7 % → 1 A, 21 % → 3 A, 49 % → 7 A; 100 % ≈ 14.3 A AC max. ✅ That ÷ 7 is independently confirmed by 0x121's AC events — see [0x121](#0x121--the-riders-own-charge-current-limit).

---

## 0x02C — `DRIVE_TORQUE`

`src/can/drive.ts`. b0-1 LE s16 `D_TRQ_CMD`, b2-3 LE s16 `D_TRQ_FEED`, both × 0.1 Nm, at 50 Hz.

✅ **The pair identification is what makes this safe:** r(command, feedback) = **+0.9916** over all 20 429 frames of the garage lap. Two 16-bit fields that track each other that closely, in a frame Energica calls `DRIVE_TORQUE`, are a demand and its response. Supporting evidence from the same capture: r(command, 0x109 throttle) = +0.848 and r(feedback, 0x200 pack current) = −0.63, the sign being the discharge convention. Negative values are regen — the lap spent 284 frames below −2.0 Nm.

✅ **The 0.1 Nm scale has THREE independent sources**, which is unusual here and worth stating:

1. **Energica states it outright.** Their own telemetry-scaling table carries `94 D_TRQ_CMD int16_t f(x)=x*0.1 Nm` and `95 D_TRQ_FEED int16_t f(x)=x*0.1 Nm` — an explicit unit column, not an inference. (`FramesDB` itself carries no scalings at all; the two files have to be read together. See the 2024 service-tool analysis in `obd-garage/`, §6.0.)
2. **The factory Optionals** write `MAP1_TORQUE` = 2000 and 2150 for this platform's published 200 Nm and 215 Nm peaks — 0.1 Nm per count from a completely separate document.
3. **The capture rules out the neighbouring scales on physics alone.** Peak feedback was 482 counts. At ×1 that is 482 Nm, more than twice the motor's rated peak; and comparing mechanical power (torque × 0x104 motor rpm) against electrical pack power over the lap gives a ratio of 0.60 at >100 rpm and 0.85 at >250 rpm — losses dominating at walking pace, exactly as expected. At ×1 that ratio would be 6.0-8.5, a motor producing eight times more power than it consumes; at ×0.01 it would be 0.06, a 6 % efficient drive. Only ×0.1 lands anywhere physical.

**b4-7 is `D_RUN_TMR`**, a u32 that reads 0 in all 20 429 frames. Not decoded: there is nothing to decode, and recording that it is dead is more useful than a key that only ever writes 0.

---

## 0x0A0 — `ABS_INFO`

`src/can/abs.ts`. The ABS module's broadcast at 10 Hz: wheel speeds, the ABS warning lamp, front brake pressure — a quantity nothing else on this bus carries, and the reason this frame was worth chasing — and six flags.

Layout is Energica's own, out of the `FramesDB.ParseABS_INFO` handler (the 2024 service-tool analysis in `obd-garage/`, §`0x0A0` `ABS_INFO`). All ten signals it names are decoded:

```
b0-1 LE  A_F_SPD_SENS   front wheel speed
b2-3 LE  A_R_SPD_SENS   rear wheel speed
b4       A_WARN_LAMP    mask 0x0C >>2 · A_FSENS_FAIL 0x10 · A_RSENS_FAIL 0x20 · A_EVENT 0x80
b5       A_F_PRESSURE   front brake pressure
b6       A_F_PRESSURE_VALIDITY bit0 · A_F_CTRL_ACTIVE bit1 · A_R_CTRL_ACTIVE bit2
```

That layout is CONFIRMED against this bike's own 2026-08-02 garage lap (4087 frames of 0x0A0), re-derived rather than taken on trust, and re-checked on 2026-08-16 against two ROAD captures — `capture-20260804-035631-c8fe853f.log` (16 188 frames, to 98 km/h) and `capture-20260804-193952-4b4cdd2b.log` (17 435 frames). The six flags were added on 2026-08-19 against those three plus `capture-20260819-172725-178e8719.log` (8373) and `buttons-2026-08-19.log` (2840).

⚠️ **2026-08-20: the flag counts are now taken over every capture in the archive** rather than those five — 245 files, **565 376 frames** of this id, which is the number every flag count below is out of. That is 12× the old corpus and it changed three of the conclusions, including one that said a flag had never been seen when it had. The five-capture figures are kept where they are still the right ones (the GPS calibration below is a fit against two specific rides, not a census), and the flags section says explicitly where the wider scan overturned it.

### Why this frame is all there will ever be from the ABS

📘 Read off Energica's own wiring schematic (recorded 2026-08-19, from the topology and not from this bus — nothing in the captures could show it): **the ABS module is not on the bus this app taps.** The schematic puts it on the **DTB** bus; our tap is on **VDB**, and 0x0A0 reaches us only because the VCU gateways it across. That single fact explains two things that otherwise look like our bugs:

- **The ABS never answered any diagnostic sweep.** A KWP/UDS request addressed from VDB cannot reach an ECU that only listens on DTB, so the silence was the topology and not a wrong address or a missed timing window. Energica's own tool carries no ABS live-data catalogue either, which is the corroborating half: there was never anything to sweep for.
- **These ten signals are the whole interface.** Anything the ABS module knows that the VCU does not choose to re-broadcast is not merely undiscovered, it is unreachable from here. So "there is no rear brake pressure on this bus" is structural, not a gap in the search.

Consequence for everything below: a flag that has never been seen set cannot be confirmed by asking the module. It can only be confirmed by making the bike assert it. That is why the unobserved four are filed on issue #51 as on-bike experiments rather than left undecoded.

### Why the flags read through `bit()` and not the vendor's masks

The six flags read through `bit()` rather than the vendor's masks written literally (`data[4] & 0x10`), which would yield 16 rather than 1. That is not a hypothetical slip: it is the exact mistake `public/lib/bounds.js` gates the boolean groups against after `high_beam` once logged 193, and a flag arriving as 16 would be rejected as a dead sensor rather than shown. The vendor mask is named in the comment beside each so the bit index can still be checked against `ParseABS_INFO` at a glance.

**b6 keeps its own length guard** so that the four signals logged since 2026-08-16 cannot be silenced by a short frame on account of these three — the same arrangement 0x109's throttle and 0x660's offset pair already use. Every one of the 565 376 frames on disk is DLC 8, so this branch has never yet been the false one; it is there because a truncated frame decoding b6 out of CAN padding would report "pressure invalid, no channel active", which reads as a healthy answer rather than as a missing byte.

### The 0xFFFF wheel sentinel is passed through, unlike 0x10B's

⚠️ A wheel count of 0xFFFF is a sentinel and it DOES occur on the road — 10 frames across the two 2026-08-04 captures, and **120 across the whole archive**. It is passed through, arriving as 3686.34 km/h, and that is deliberate rather than an oversight: `public/lib/bounds.js` gates both wheel speeds to [0, 300], so it shows as a fault, which is what the repo wants a dead sensor to look like.

Note this resolves the same situation the OPPOSITE way to 0x10B, which drops its saturated 65000 in the decoder — and the difference is the point rather than an inconsistency to tidy away. 0x10B's sentinel decodes to 65 kWh/100 km, which `bounds.js` would ACCEPT, so nothing downstream could ever catch it and the decoder is the only place it can be stopped. 3686 km/h cannot be mistaken for a reading by anything. Dropping it here would be strictly worse: the frame would go silent exactly when a wheel sensor has failed, which is the moment the signal exists for. The replay cases in `scripts/check-can-decoders.ts` pin both behaviours.

### Wheel speed: 0.05625 km/h per count, and why the fitted pair is not shipped

Energica's own telemetry-scaling table gives `A_F_SPD_SENS` / `A_R_SPD_SENS` the equation `f(x)=x*0.05625` and the unit km/h — one of only four non-identity equations in the whole dictionary. 0.05625 = 3.6/64, i.e. a count is 1/64 m/s, which is a sane way for an ABS ECU to encode a wheel.

✅ **2026-08-16: CONFIRMED against GPS, and the constant stays exactly as Energica wrote it.**

This replaces an earlier note that called 0.05625 wrong by ~4 % and said the two wheel channels disagreed with each other by ~9 %. Both were artefacts — of the reference, and of the ride — and the working is kept here so nobody re-derives them from the same data.

**What was wrong: the reference.** That fit used 0x104 `speed_can_kmh`, which is not ground truth. `speed_can_kmh` is exactly `motor_rpm_can / 42.0` (through-origin fit 42.0012 rpm per km/h over 198 990 forward-gear frames above 20 km/h, residual sd 1.66 rpm, |max| 4 rpm — i.e. the two fields are one quantity, and the residual is just their quantisation). It is the driveline's number, geared, and it over-reads (see [the dash over-read](#the-dash-over-reads-and-by-how-much)). Calibrating wheel counts against it baked that over-read straight into the answer.

**The reference used instead** is `gps_speed_kmh` off this same bus — 0x410, hub message type 0x1A, so one capture file carries both signals and the pairing needs no clock alignment beyond the candump timestamps. Two independent checks say it can be trusted:

- against speed derived from the hub's own lat/lon track, over 241 straight (heading change < 2°), steady spans above 40 km/h: reported − track = **−0.27 km/h** mean. Worth doing because the field is whole km/h, and whether it ROUNDS or TRUNCATES is worth −0.5 km/h, which at 95 km/h is −0.53 % — the same size as the effect being measured. It rounds: chord-summing a noisy track inflates the track by roughly +0.15 km/h at these speeds, putting the true bias near −0.12, against −0.5 for a truncating field. Residual uncertainty is ~0.15 km/h, so read the fits below as carrying an extra +0.0/+0.2 % systematic on top of their CIs. Nothing here turns on it — a truncating field would raise BOTH fits by 0.53 % and leave the front/rear ratio, which is what refutes the circumference model, untouched.
- the bike's own odometer advanced 10.4 km over a window in which the GPS track measured 10.055 km — **+3.43 %**, matching the speed over-read below, from a completely separate accumulator.

**Method.** Steady-state only, because GPS speed lags and wheel speed does not, so a transient fits a slope that is neither. A sample is kept only if, over a ±3 s window (≥ 8 GPS fixes at the hub's ~1.8 Hz): GPS speed spans ≤ 2 km/h, both wheel counts drift < 6 counts/s (≈ 0.34 km/h/s), heading moves < 4°, and speed ≥ 40 km/h. Fits are through the origin, per wheel, against the mean of the ~10 ABS frames within ±0.5 s of each fix.

**Sample budget**, both captures together: 7514 GPS sub-frame cycles reconstructed, 5 dropped as incomplete; 591 rejected for `gps_fix` = 0 (the ride starts indoors) and 12 for < 4 satellites, leaving 6911 valid fixes; 4975 of those had enough ABS frames alongside them; **274 survived the steady-state filter**, falling into 15 contiguous stretches. 10 ABS frames carrying the 0xFFFF sentinel on a wheel count were dropped. The two GPS defects known from `rides.db` — the 9-bit 256 rollover and course ≥ 360 — are gated for explicitly and did NOT occur in either capture: 0 of each.

**Result.** Each stretch is one independent observation (samples inside one are autocorrelated, so pooling them raw would overstate n by ~18×):

```
front  0.05685 km/h per count   95 % CI [0.05675, 0.05696]   +1.07 % vs 0.05625
rear   0.05657 km/h per count   95 % CI [0.05650, 0.05664]   +0.56 % vs 0.05625
```

Both wheels land within ~1 % of the manufacturer's constant, and the two captures — different boots, different roads, one 22 min and one 47 min — agree to the fourth decimal (front 0.05685 vs 0.05686, rear 0.05653 vs 0.05659). Moving any filter threshold moves the front fit only between +0.93 % and +1.32 %: speed floor 25→70 km/h, window ±2→±5 s, heading gate 2°→off, drift gate 2→12 counts/s. It is a measurement, not a choice of filter.

⚠️ **So why keep 0.05625 rather than ship the fitted pair?** Because 0.05625 = 3.6/64 is a WIRE ENCODING — one count is 1/64 m/s — not a calibration, and the ~1 % residual is not in the encoding. It is this bike's tyres against the circumferences the ABS ECU has stored: a fitted scale > nominal means the tyre is rolling slightly LARGER than the ECU assumes, which is what tyre wear, pressure and temperature do, at about this size. Both captures are from the SAME DAY, so they establish that the measurement repeats — not that 1.07 % survives a new front tyre. Baking a one-day tyre state into a frame decoder makes it silently drift with the tyres, and drops the property that makes this frame useful at all: front and rear counts are directly comparable to each other, which is exactly what an ABS module needs and exactly what per-wheel curve-fits would break. This repo already declined the same trade for 0x125's ~109 counts per km/h and the reasoning is the same one.

If you want GPS-true speed from these counts, multiply front by **1.0107** and rear by **1.0056** — and re-measure after a tyre change, because that is what those numbers are about.

### ⚠️ The "9 % channel disagreement" was steering geometry, not the channels

The garage-lap figure reproduces exactly (median front/rear = 1.0900, n = 363), but it is a property of that lap and not of this frame: over the road captures the same ratio is **0.9955** and **0.9967**, and — the part that settles it — inside the SAME 100-200 count band the garage lap gives 1.092 while the road captures give 1.000 and 1.006. Same wheel speed, different ratio, so it cannot be the sensors. A garage lap is walking-pace U-turns, and in a turn the front wheel traces the longer arc: front path = √(R² + L²) with L = 1465 mm of wheelbase, so 1.090 against the road baseline of 0.995 needs R = 3.3 m. That is a bike being turned around in a garage, measured to the metre.

### ❌ REFUTED: raw pulse rates against one nominal circumference

Worth recording because it is the obvious hypothesis: that the ECU broadcasts raw per-wheel pulse rates against one nominal circumference, so the true scale would be `0.05625 × C_wheel / C_nom` from the VCU's `SPEED_ODO_FRONTWHEEL_C` = 1852 and `SPEED_ODO_REARWHEEL_C` = 1983 (see `src/vcu/param-table.ts`).

**It predicts the ratio BACKWARDS.** A smaller front wheel spins faster, so that model needs front/rear scales in the ratio 1852/1983 = **0.9339**. Measured is **1.0061** — that one is the ratio of the POOLED through-origin fits over all 274 samples (0.05690 / 0.05656), not of the per-stretch means published above, which give 1.0049; the two differ because a stretch at 97 km/h and one at 48 km/h carry equal weight in the second and not the first. Either reading is above 1 where the model needs 0.934, so it is backwards by 7.6-7.7 % whichever is used. Given its best possible `C_nom` (1904 mm, fitted) it is three times worse than doing nothing — RMS error against GPS over the 274 steady samples, km/h:

```
model                                     front RMS  front bias   rear RMS  rear bias
0.05625 single constant (what ships)          0.975      −0.814      0.567     −0.392
GPS-fitted per wheel                          0.410      +0.045      0.377     +0.020
circumference-derived, best-fit C_nom         2.989      −2.832      2.775     +2.689
0x104-fitted (0.05393 / 0.05862, withdrawn)   4.040      −3.860      2.824     +2.738
```

The physical reason it fails is the same reason the constant is fine: **the ABS ECU has ALREADY applied each wheel's circumference before it broadcasts.** It has to — comparing front against rear is what the module is for, and channels 7 % apart at a steady cruise would make every motorway kilometre look like a locked wheel. The measured 0.6 % is what "already applied" looks like, and it widens with speed (0.998 at ~31 km/h, 0.993 at ~98 km/h), which is tyre growth and load transfer rather than anything a constant could fix.

So: these ARE km/h, good to about 1 % against GPS across 40-100 km/h, which is better than the previous note claimed and now measured rather than assumed. Still not a certified speedometer, and still not a reason to trust them below ~25 km/h, where the garage lap shows what manoeuvring does to them.

### `A_F_PRESSURE` (b5) — the FRONT circuit, by measurement

✅ CONFIRMED as the front brake, by the switch, over the 2026-08-02 lap:

- b5 is **EXACTLY 0** — mean 0.000, max 0 — in all 3948 frames where 0x102 b2 bit5 (front brake) is clear. Not "near zero": no frame has a single count in it.
- With that bit set (n = 139) it means 2.60 and peaks at 17, and 33 of those 139 read 0 — the lever closing its switch before line pressure builds, which is what a real brake does and what a coincidence would not.

Over the whole lap b5 takes 15 distinct values, 0…17, in single-count steps.

⚠️ **Caveat 1, and the capture cannot lift it: the unit is Energica's word, not a measurement.** Their dictionary calls `A_F_PRESSURE` a pressure in bar with an identity equation, so 1 count = 1 bar, and 0…17 bar over a slow garage lap is the right order of magnitude for a front brake. But nothing on this bus carries a second pressure to check it against, so if the true scale is some other constant every number here is wrong by that factor while still looking entirely plausible. The key says `_bar` because that is the manufacturer's stated unit; it is not a measured one.

~~**Caveat 2: "front" rests on the name too.**~~ **CLOSED 2026-08-19.** ✅ It used to say that 0x102's REAR brake bit was never set once in the whole 545 k-frame garage lap, so that lap could not separate "front brake pressure" from "brake pressure", and that a ride using the rear brake alone was the measurement that would close it. Three separate readings now close it, and they were arrived at independently:

- The corpus DOES contain rear-only braking: across all 14 650 573 frames of 0x102 in the archive the rear bit fires **18 times on its own**, median 0.46 s.
- The owner rode the other half deliberately and reported that **pressing the rear pedal alone leaves b5 at 0 bar** while the front lever drives it to 5.
- That report reproduces off the captures, cross-tabulating b5 against 0x102 b2 in the two 2026-08-19 files: rear pedal alone (`buttons-2026-08-19.log`, b2 0x40 set and 0x20 clear) gives **b5 = 0 in all 434 frames**, not one count in any of them; front lever alone (`capture-20260819-172725-178e8719.log`, b2 0x20 set) gives 0…8 bar over 110 frames, 35 of which read 0 — the lever closing its switch before line pressure builds, the same shape the garage lap showed. (The peak is 8 rather than the reported 5; the owner was watching a screen rather than counting frames, and 0 vs non-zero is the part that carries the argument either way.)

So b5 is the FRONT circuit by measurement rather than by its name. The **434-frame zero is the load-bearing half**: a combined brake pressure that Energica merely named `A_F_PRESSURE` could not sit at exactly 0 through 434 frames of rear braking.

🟡 **The weaker half of the old sentence survives:** that the rear brake has no pressure channel AT ALL. That is a universal negative and it is not measured — the evidence is that this frame has no `A_R_PRESSURE` field and that Energica's own signal database names none, which is an absence in two documents rather than an observation. Treat it as "none is known", not "none exists". The DTB note above bounds how much better that can ever get FROM HERE: anything the ABS knows and the VCU does not re-broadcast is unreachable from our bus, so "none is known" will not be improved by more searching on VDB, only by the schematic or a DTB tap. Caveat 1 stands too: the SCALE is still Energica's word.

### `A_WARN_LAMP` (b4, mask 0x0C >> 2) — a two-bit field, not a flag

✅ Set in 3564 of 3601 standstill frames (99.0 %) and in **0 of 192 frames above 6 km/h**, which is the ABS self-test — it needs road speed to clear, and cannot clear on a bike that never moved.

⚠️ **It is a TWO-BIT field.** Energica's mask is 0x0C >> 2, so the range is 0…3, and the mask is kept as the vendor wrote it rather than narrowed to the one bit this bike has been seen to use — b4 takes exactly two values in the whole lap, 0x00 and 0x04, so bit 2 is the only bit of the PAIR ever observed set. (The wider corpus adds a third b4 value, 0x80, but that is `A_EVENT` rather than a lamp state; the two lamp bits are still only ever 0 or 1 between them.) Narrowing it to `? 1 : 0` would throw away whatever a second lamp state means the first time this bike produces one, on a signal whose entire purpose is to be read when something is wrong.

Two consequences are handled elsewhere and are worth knowing about here: `public/lib/bounds.js` names it at [0, 3] so the `diag` group's boolean rule cannot reject a 2 or a 3 as a dead sensor, and it carries **no deadband**, because at 1 the logging rule would pass |2 − 0| while failing |1 − 0| and log transitions inconsistently.

### The bytes that are not dead, and the one that is

**b1 and b3, the wheel-speed high bytes, are NOT dead** — the garage lap simply never went fast enough to reach 256 counts (14.4 km/h). They are non-zero in 10 241 and 10 242 of `capture-20260804-035631`'s frames, peaking at 1748 and 1766 counts, so the LE u16 read is exercised across its real range and not just its low byte. The replay case in `scripts/check-can-decoders.ts` covers a 1697/1719-count frame for exactly that reason.

**b7 is 0x00 in all 565 376 frames** and Energica's handler names nothing in it. Nothing to decode.

### The six flags, and exactly how much each one is worth

Added 2026-08-19, completing the ten signals `ParseABS_INFO` names. Three of them have been watched firing; three never have. That split is the whole content of this section, and it is kept explicit because "reads 0" means something completely different in the two cases.

⚠️ **Rewritten 2026-08-20 against a corpus 12× larger, and it overturned three claims that stood here.** The five captures above were the five that had been LOOKED at, not the five that exist. Re-scanning every `*.log` and `*.txt` in the archive — 245 files, **565 376 frames of 0x0A0** — finds interventions in **15 distinct captures**, not two. What changed:

- `abs_front_control_active` **HAS fired** — 27 frames, three captures. It was recorded as never observed, and issue #51 item 14 asked for a deliberate front-brake ABS stop to produce one. That stop is not needed; the archive already had it.
- **b6 takes four values, not two:** 0x00, 0x02, 0x04, 0x06.
- `abs_event` and `abs_rear_control_active` are **not** the same 25 frames. `A_EVENT` fires with the FRONT channel too. The true invariant is stronger and simpler: **`A_EVENT` is set in exactly the frames where b6 ≠ 0, 162 of 162, both directions.**

The whole-archive census of the two flag bytes, which every claim below is a reading of:

```
b4    b6    frames   what it is
0x00  0x00  421 162  quiet
0x04  0x00  144 052  A_WARN_LAMP — the standstill self-test
0x80  0x04      135  A_EVENT + rear channel
0x80  0x02       14  A_EVENT + FRONT channel
0x80  0x06       13  A_EVENT + both channels
```

(plus one truncated final line in `capture-20260808-223321`, where the capture was cut mid-write. b4 is never 0x84 and b6 never carries bit0 — see below.)

#### ✅ `abs_event` (b4 0x80), `abs_rear_control_active` (b6 0x04), `abs_front_control_active` (b6 0x02) — all three observed, and coherent

**162 `A_EVENT` frames in 61 bursts across 15 captures**, 148 carrying the rear channel, 27 the front, 13 both at once. Bursts are 1-17 frames, median 2, i.e. 0.1-1.6 s. Three independently named bits in two different bytes that never contradict each other across 15 rides are not a coincidence, and that is the strongest evidence these positions are right.

- **The lamp bits are clear in all 162** (b4 is 0x80, never 0x84), so an intervention is not a fault and does not light the warning lamp. Anything alerting on these must not treat them as a fault condition.
- Speeds run **6.1 to 80.7 km/h**, median 36.1 — ordinary riding, not one unusual moment.
- **The rear pedal was never used at a single one.** 0 of 162, across all 15 captures. That generalises what two rides had shown and is now about as solid as a negative gets here.
- ⚠️ **"No brake was applied in any of them" does NOT survive the wider corpus.** It was true of the 25 frames from 2026-08-04, and reading a cause out of it was the mistake. Across all 162, the FRONT brake switch is on in **35**, with real line pressure — 1 to 21 bar — in the same 35. Both front-channel captures are ordinary front-braked stops.

#### 🟡→ What causes them: NOT what this file used to say

This section used to carry a 🟡 reading that the interventions were rear-wheel slip under regen, "which is what an e-motorcycle's rear wheel does on a closed throttle". That was an inference from the missing brake signal in 25 frames. Against 162 frames with throttle, torque and brake aligned to each one, it is **wrong about the majority case**, and the shape of the answer is a genuine split rather than a single cause:

- **The throttle is OPEN at most of them.** `throttle_on` is set in **117 of 162**; above 15 km/h the inverter's own torque feedback (0x02C, the cleaner discriminator — it measures what the motor is doing rather than what the rider asked for) is **positive in 90 of 142**, negative in 44, near zero in 8. So a closed throttle is the minority condition, not the rule.
- **But that majority is a base-rate artefact, and correcting for it flips the emphasis.** This bike is ridden at positive torque 81 % of the time above 15 km/h. Per unit of riding, interventions are **~3× MORE likely under regen** and **~29× more likely with the front brake on**. ⚠️ Every row below is restricted to frames with both wheels above 15 km/h, which is why the front brake shows 32 here against the 35 quoted above over all 162 — three of the 35 are below that floor. The four band rows sum to 344 222, the whole >15 km/h baseline:

```
band                 baseline frames   events   per 10 000 frames
drive  (T > +1 Nm)           277 512       90                3.24
coast  (|T| ≤ 1 Nm)           25 288        8                3.16
regen  (T < −1 Nm)            41 422       44               10.62
front brake applied            3 366       32               95.07
front brake not applied      340 856      110                3.23
```

##### ❌ Traction control is REFUTED as the explanation for the throttle-open population

Two independent measurements say so, and the second is the decisive one.

**(a) The bike never cuts torque at them.** If these were interventions on drive slip, the demanded torque would be cut. Measured with one method applied identically to event and non-event frames — mean `drive_torque_cmd_nm` over the 0.5 s before against its extreme over −0.05…+0.35 s — **0 of 90** drive-band interventions above 15 km/h show a cut the throttle does not explain. The full accounting, because the filter discards cases and that matters: of those 90, **83** had enough neighbouring 0x02C frames to test and **7** did not. Of the 83, **24 did** move > 5 Nm toward zero — and every one of the 24 had the rider closing the throttle at the same moment, monotonically so, from −32.4 Nm with −15.8 % throttle down to −5.1 Nm with −2.4 %. That is a hand coming off the throttle, not a controller cutting it. The 7 untestable ones were checked by inspection and none shows a cut either: the minimum commanded torque in the window is at or above the frame's own value in 6 of them, and the 7th moves 3.4 Nm, below threshold. So the result is **0 of 83 tested and 0 of 7 by hand**, not a subset that quietly dropped its inconvenient cases. Two further checks agree: `drive_torque_cmd_nm − drive_torque_feedback_nm` sits at its ordinary +0.10 Nm through them, so the inverter is not clipping the demand, and 0x109's `current_max_out_a` does not dip.

**(b) The bike has a traction-control event flag, it fires often, and it is not set at these.** 0x109 b6 bit7 is `V_TC_EVENT` in Energica's own `ParseVCU_DRIVEBYWIRE`, and it is confirmed by behaviour rather than by its name — median throttle 77.2 % and torque +137.6 Nm when set against 15.6 % and +11.9 Nm when clear, and within the ≥ 60 % throttle band alone it still separates +146.2 Nm from +109.9 Nm, so it is not a throttle comparator. (This is the field the repo used to log as `current_other_a`.) Cross-tabulated against every `A_EVENT` frame:

```
V_TC_EVENT   set at    4 of 162 interventions   (baseline rate 0.302 %)
V_eABS_EVENT set at   10 of 162 interventions   (baseline rate 0.004 %)
neither      set at  148 of 162
```

and in the drive band specifically, **94 of the 100 throttle-open interventions have neither flag**. Conversely `V_TC_EVENT` fires 1326 times in these captures, of which 4 coincide with an ABS intervention. So traction control on this bike is a real, frequent, separately-broadcast event that looks nothing like these — it happens at three-quarters throttle and near peak torque, where the interventions happen at about 15 %. **The bike's own answer to "was that traction control?" is no.**

🟡 `V_eABS_EVENT` is the interesting residue: only 26 frames in the whole set, but 10 of them land on an `A_EVENT`, which against a 0.004 % baseline is an enrichment of **~1600×**. So the VCU's eABS event and the ABS module's intervention ARE strongly associated — the sample is just far too small to build on, and it does not cover the throttle-open majority either.

##### ✅ The braking/regen population is the one with real lockup signatures

The three largest wheel divergences in the whole corpus — rear **15.81, 9.62 and 8.49 km/h BELOW** the front — are all closed-throttle, front-brake-applied frames, and all are sustained across consecutive frames rather than single samples. The clearest is 2026-08-09 18:55:56 in `capture-20260809-181842`: entered at 77 km/h, throttle shut, regen −41.7 Nm, front brake rising through 12-16 bar and peaking at 21, rear collapses 68.2 → 48.4 km/h and both channels flag. It is the one event in the corpus that looks like the textbook picture.

##### ❓ What the throttle-open events are is UNRESOLVED

Left that way rather than filled in. Refuting traction control does not identify a replacement. Road-surface transients (a bump unloading a wheel), slip too brief for a 10 Hz broadcast to resolve, and wheel-speed sampling artefacts all remain live and this corpus cannot separate them.

#### 🟡 The wheel-speed divergence does NOT corroborate the throttle

The obvious cross-check on all of the above — rear faster than front means drive slip, rear slower means braking slip — **does not agree with the throttle reading, and is not allowed to be quietly dropped for it.** The reason the old note's version of this looked convincing is that it had no matched baseline. Against one (non-event frames in the same torque band and the same 10 km/h speed bin, 344 222 of them), the rear wheel already reads FASTER than the front during ordinary drive, and by more as speed rises: median rear − front is +0.06 km/h in the 10s, +0.23 in the 30s, +0.39 in the 50s, +0.73 in the 80s. Against that, the throttle-open events sit only just above their own baseline (+0.39 against +0.23 in the 30s, +0.56 against +0.28 in the 40s), and **0 of the 12 above 50 km/h fall outside the baseline's 1st-99th percentile at all**.

Worse for the slip reading: the LARGEST throttle-open divergences point the **wrong way** — −4.56, −3.99, −3.38, −2.59, −2.47 km/h, i.e. the rear SLOWER while the motor is driving it — and 8 of them are one-sample spikes with both neighbouring frames back inside ±0.6 km/h. A rear wheel carrying +19.7 Nm cannot shed 4.56 km/h in 100 ms and take it back in the next 100 ms; whatever those are, they are not a wheel accelerating away under power. In the regen band the picture is the opposite and consistent: the baseline median is ≈ −0.06, and 80 % of the events in the 40s bin fall outside p1-p99.

⚠️ **Why that is not two standards for one shape**, since a one-sample excursion IS read as a real lockup in the braking case (the 16:53:18 replay frame in `scripts/check-can-decoders.ts`, where the front wheel reads 6.13 km/h for exactly one frame and 20.48 the next). **The asymmetry is physical, not a convenience:**

- **Under brake, both directions are available.** A caliper can put far more retarding torque into a wheel than the tyre can hold, so a lockup is near-instant; and when the modulator releases, the road — still passing at 20 km/h — spins a wheel of a few tenths of a kg·m² back up in well under 100 ms. A 14 km/h drop and full recovery inside two frames is what that looks like sampled at 10 Hz.
- **Under power, one direction is missing.** Shedding 4.56 km/h in 100 ms needs roughly 28 Nm of retarding torque at the wheel, and it has to overcome the +19.7 Nm the motor is pushing the other way — about 48 Nm net, with no brake applied and the tyre gripping. Nothing on the bike supplies that. A wheel LOSING speed under drive torque is the part that does not add up, and it is why those spikes are discounted while the braking one is not.

**The test that separates them is the sign against the applied torque, not the duration.** A one-frame excursion is credible in the direction the available forces can produce and not in the other.

So: throttle/torque and wheel divergence **agree for the braking population and disagree for the throttle-open one**, and no winner is picked. What would settle it is named on issue #51 rather than guessed at.

#### ⚠️ `abs_front_sensor_fault` (b4 0x10), `abs_rear_sensor_fault` (b4 0x20) — never observed set, and that is the expected reading

0 in all 565 376 frames. On a bike with no wheel-sensor fault, that is what a correct decode looks like: there was nothing to report. It is NOT evidence the positions are wrong, and it is NOT evidence they are right — **it is no evidence either way**, which is precisely why they are decoded now rather than after the fact. A flag that only matters when it fires is worth having decoded BEFORE it fires; the alternative is discovering the first real wheel-sensor failure by finding it absent from the log. Same reasoning, and the same corpus-wide zero, as the eleven never-seen flags in `src/can/vcu-flags.ts`.

The positions are Energica's word alone. Treat either reading 1 as a lead to check against the mode-03 stored list, the dash's own ABS lamp and `abs_warning_lamp` — not as a confirmed fault. Confirming them needs a real sensor fault, or a sensor unplugged deliberately. Filed on issue #51.

🔎 **The two `*SENS_FAIL` bits have exact counterparts in this repo's own DTC table**, which is what makes them cheap to confirm the day the bike produces one: component 61 is `P0500` front wheel speed sensor failure (`dtc_0061_0`), `P2158` rear (`dtc_0061_1`), `C0065` both (`dtc_0061_2`) and `P2162` coherency (`dtc_0061_3`), all already logged as 1/0 signals by `src/diagnostics/record.ts`. So `abs_front_sensor_fault` reading 1 in the same window the bike stores `P0500` confirms b4 0x10 outright, from two independent paths, with no extra instrumentation — the ride log already carries both sides of that comparison.

#### ❓ `abs_front_pressure_validity` (b6 bit0) — decoded as a flag, polarity UNESTABLISHED

0 in all 565 376 frames — including **13 635 frames archive-wide where b5 is reporting a non-zero pressure**, which is the load-bearing part and is now two orders of magnitude better evidenced than the 181 frames this note used to rest on. So the bit is 0 while the pressure demonstrably works, and there are two readings that cannot be told apart from this side:

- the name is literal, 1 means valid, and this module simply never asserts it; or
- the polarity is inverted from the name — 1 would mean INVALID — and 0 is the healthy state we have been watching all along.

The name argues for the first; the fact that the pressure reading plainly works while the bit sits at 0 argues for the second. Nothing here settles it, so nothing here pretends to. The key is `abs_front_pressure_validity` rather than `..._valid` for that reason: the vendor's noun claims a subject, not a truth value.

⚠️ **`front_brake_pressure_bar` is therefore NOT gated on this bit, and must not be.** Under the second reading, gating would blank a working pressure display in every frame — the signal would simply never appear, and it would look like a decoder bug rather than a policy. Under the first, gating would blank it too, since the bit is never 1. Both readings make gating wrong today; only watching the bit move can make it right. **Do not add a validity check from the vendor DB before then.**

### The dash over-reads, and by how much

Recorded here because it is what the wheel-speed calibration above was originally, and wrongly, measured against.

Over the same 274 steady samples, 0x104 `speed_can_kmh` reads **+3.6 % and +3.5 %** above GPS in the two captures (per-stretch mean gps/speed_can 0.9653 ± 0.0013 and 0.9658 ± 0.0018, 2 SE) — about +3.4 km/h at an indicated 100. The bike's odometer agrees from a separate accumulator: **+3.43 %** over a 10 km window. So the whole VCU speed/odometer chain runs ~3.5 % fast.

That is real but it is **four times smaller** than the "10-20 km/h over" this bike's owner and the Energica community report, which at 100 km/h would be 10-20 %. Two honest caveats before anyone changes a sprocket over it: this measures the CAN signal, not the glass — nothing in these captures says the dash renders `speed_can_kmh` unmodified, and a display is free to add its own margin on top — and 3.5 % is comfortably inside UNECE R39, which forbids under-reading and allows roughly +10 % +4 km/h, so a speedometer reading high is the design working.

❓ **Where the 3.5 % lives is NOT settled.** `speed_can_kmh` = `motor_rpm_can` / 42.0 exactly, and 42.0 rpm/km/h implies a total reduction of 4.997 against `SPEED_ODO_REARWHEEL_C` = 1983 mm (or 4.667 against the front's 1852). Neither reconciles with `SPEED_ODO_FINALGEAR` = 4140 and `SPEED_ODO_PRIMARYGEAR` = 18268 under any obvious scaling — 18268/4140 = 4.4126, and no power-of-ten reading of the pair lands on 4.997 — so the parameters' units are unknown and the chain is not decomposed here rather than fudged into agreeing. What can be said without them: the error is a single multiplicative 3.5 %, and the only rider-accessible terms in that chain are the `SPEED_ODO_*` parameters.

---

## 0x100 — `VCU_VEHICLE_FLAGS`

`src/can/vcu-flags.ts`. The VCU's error and status bitfield at 10 Hz.

Energica's `FramesDB.ParseVCU_VEHICLE_FLAGS` names all 64 bits of it — byte 0 bit 0 through byte 7 bit 7, one named flag each, no multi-byte fields at all (the 2024 service-tool analysis in `obd-garage/`, §`0x100` `VCU_VEHICLE_FLAGS`). That makes it the VCU's counterpart to the BMS's own error/warning words on 0x201, and it is handled the same way this repo already handles those: log the raw words so no flag can ever be lost, then break out only the ones worth an alert.

**The reason it is worth having at all is `ERR_ChargeCM_Out`, byte 7 bit 1.** The charge manager has never been read on this bike — its own `CM_ERROR` / `CM_ERROR_SOURCE` / `CM_ERROR_CODE_*` telemetry is not broadcast anywhere and needs a diagnostic session with an ECU that was only recently located. This summary bit IS broadcast, so a charge-manager fault becomes visible passively, which matters directly to the open question of why DC fast charging caps below the bike's advertised 75 A.

**Why the raw halves are logged as two 32-bit words.** So a flag this file does not break out is still recorded and a future reader can go back through the log for it. Two 32-bit words rather than one 64-bit number because JavaScript's bitwise operators truncate to 32 bits, so a single value would be unusable for exactly the thing it exists for. Little-endian within each half, which makes bit N of the word byte N>>3, bit N&7 — the same convention every other multi-byte field on this bus uses. Nothing reads meaning out of the words themselves; they are a lossless record, not a measurement.

### What the captures on disk say, checked 2026-08-16

0x100 was scanned across every raw capture there is: the 2026-08-02 garage lap (4087 frames), the 2026-08-02 AC charge (18 509), and all 59 files of the 2026-08-04 session including the complete CCS DC fast charge (83 140). **105 736 frames, four distinct payloads.**

```
00 00 80 00 00 00 00 01   riding, and most of the 08-04 session
00 00 00 00 00 00 00 01   the whole AC charge, and the later 08-04 files
00 00 80 00 00 00 10 01   from 20:25:49 on 08-04 onward
00 00 00 00 08 00 00 01   two short bursts, 39 frames total
```

✅ **Byte 7 bit 1, `ERR_ChargeCM_Out`, is 0 in all 105 736 of them** — including every frame of the 2026-08-04 DC session, which ran to 20.04 kW and 66.2 A and completed cleanly. So the bit is well-formed and the charge manager was not complaining. ⚠️ That is a NEGATIVE and nothing more: no capture on this disk contains a charge-manager fault. The only time this bike's charge manager has ever complained is 2026-08-09 12:38:35-12:42:35, and no raw CAN for that window exists locally. **This decode has never been seen to fire.**

🔎 **For whoever recovers those 2026-08-09 captures** — this is the check that would confirm it outright in one pass. The bit should go **1 → 0 → 1 → 0 at 12:38:35 / 12:39:36 / 12:41:36 / 12:42:35**, i.e. byte 7 stepping 0x03 → 0x01 → 0x03 → 0x01 against a payload that is otherwise `00 00 ?? 00 00 00 ?? 01`. Four edges at four known seconds is not something a wrong bit position produces.

✅ **What the corpus DOES confirm** is that this frame is the named bitfield it claims to be, because three of its bits move and every one of them moves when the vendor's name says it should:

1. **`ERR_CheckModules` (b2 bit7)** is set through both rides and clear through the whole AC charge. It matches the mode-03 stored list exactly — `B1000` position lights, `B1002` stop, `B1004`/`B1006` indicators, `B1009` low beam, `B1012` high beam, all open-circuit body modules — and it is the rolled-up version of the per-module round robin on 0x105.
2. **`CheckModulesSts` (b4 bit3)** sets at **20:16:05.508 on 2026-08-04 and clears 2.5 s later**. The DC session's unplug is at 20:16:05, established from an entirely different frame. A bit transition landing on the second of a known event is the strongest single piece of evidence here: it is the VCU re-running its module check as the session tears down, and a wrong bit position does not coincide with anything.
3. **`WARN_SocMisaligned` (b6 bit4)** first appears at 20:25:49, nine minutes after that same DC session ended at 57 % SOC — which is exactly when a coulomb-counted SOC estimate gets flagged after a partial fast charge. 🟡 Suggestive rather than proof.

**`V_PGood12V` (b7 bit0)** is constant 1 everywhere, and worth logging for that: it is the VCU's own verdict on the 12 V supply, and 0x501 reports that rail's actual millivolts. Two independent readings of one thing, which is the arrangement that catches a wrong one.

⚠️ **The other 57 bits, including all eleven broken out beyond those three and `V_PGood12V`, read 0 in every frame of every capture.** Their positions come from Energica's database and nothing on this bike has ever exercised them. Treat any of them reading 1 as a lead to check against `0x201`, the mode-03 list and the bike's own dash — not as a confirmed fault. That is also why both raw words are logged: if a position turns out to be wrong, the log still holds the byte it came from.

---

## 0x102 — body, lights, vehicle state and attitude

`src/can/decode.ts` (bytes 0-3) and `src/can/attitude.ts` (bytes 4-7). 100 Hz.

### Bytes 0 and 2: switches vs outputs

b0 bit6 (0x40) = high beam (bit7 0x80 = low beam). b2 mixes lamps and state: 0x04 L blinker, 0x08 R blinker, 0x10 horn, 0x20 front brake, 0x40 rear brake. Those five were found by working the switches on this bike and diffing the log. ✅

⚠️ **The blinkers are a known conflict with the `.xdbc`**, which puts L/R at b0 bits 3/4 and calls b2 bits 2/3 unknown. Both can be true — b0 the handlebar switch, b2 the lamp output — but only ours was measured here, so ours stands and the `.xdbc` is not allowed to overwrite it. **Do not "fix" this from the third-party file.**

🚨 **b2 bits 0 and 1 were `charging` and `charge_port_unlocked` until 2026-08-16. THEY ARE THE BEAM LAMPS.** Both names came off the `.xdbc` — a rider's file, not a manufacturer database — and both were wrong. **Do not restore them.** The measurement, over all 1 103 000 frames of 0x102 in the 14 candump captures:

```
b2 bit 0 vs b0 bit 6 (high beam):  1 103 000 / 1 103 000 agree, 0 disagreements
b2 bit 1 vs b0 bit 7 (low beam):   1 103 000 / 1 103 000 agree, 0 disagreements
```

Not an artefact of both being nearly constant, because the cross-pairs fall apart: b2 bit 0 against b0 bit 7 agrees only **49.35 %** of the time. And `charging` reads 0 through every real charge in the corpus — four AC sessions including 48 minutes at 14 A, plus the DC session — while the bit it does track is the flash-to-pass.

Energica's own VCU digital list, recovered from the service-tool executable, names both families and separates them exactly the way this frame does:

```
V_HIGH_BEAM_SW, V_LOW_BEAM_SW, V_L_TURN_SW, V_R_TURN_SW …   ← the switches
V_HIGH_BEAM,    V_LOW_BEAM,    V_LEFT_TURN, V_RIGHT_TURN …  ← the outputs
```

So byte 0 is the switch byte and byte 2 the output byte, which is the same split this repo already worked out for the indicators from the wire alone — b0 bits 3/4 are 0.2 s presses while b2 bits 2/3 flash at 1.4 Hz. 🟡 For the beams that split is not directly observable here: a beam switch and its lamp only differ when the bulb is out, which is exactly why it is worth logging both.

**b2 now accounts for exactly, with no bit claimed twice:** 0/1 beam lamps (measured here, 2026-08-16), 2/3 blinkers (measured), 4 horn (measured), 5/6 brake (measured), 7 moving (`.xdbc`).

**`front_brake` and `rear_brake` are NOT redundant with each other** and must not be folded back together. Measured over all 14 650 573 frames of 0x102 in the archive: the front bit accounts for **491 applications** (median 2.24 s, longest 47.2 s) and the rear **18** (median 0.46 s, longest 43.5 s) — and **1 899 frames carry both at once**, so neither implies the other in either direction. The combined `brake` key (front OR rear) stays exactly as it is: it has logged since June and `grafana/dashboards/ride-summary.json` selects it by name.

That 18 is also what closed 0x0A0's open question about `A_F_PRESSURE` — see [`A_F_PRESSURE`](#a_f_pressure-b5--the-front-circuit-by-measurement).

### Byte 1: vehicle state

Everything in b1 comes from the `.xdbc` and matched a parked bike on 2026-08-02 (`80 10 02 44 99 FF D8 FF`): `key_on` 1, `energized` / `go` / `go_request` / `ignition_button` / `throttle_on` 0, `stand_up` 0 (it is on the sidestand), `moving` 0, low beam on. The garage lap that afternoon then caught `energized`, `go_request`, `go`, `stand_up`, `ignition_button`, `throttle_on` and `moving` all toggling with the rider's actions, so those are confirmed against real transitions rather than one parked sample. ✅ `key_on` stayed 1 throughout both, so it rests on the parked sample alone — a key-off capture is what would confirm it.

### Byte 0's low bits — the left pod's momentary buttons

Added 2026-08-16. These four are the ones Energica's free-frame table names `Left/Right/Enter Mode Switch` and `RST Switch`.

Of the other two: **bit 6 is `high_beam`** (set in 137 of the 1 103 000 frames — it is a flash-to-pass, which is what the dashboard's own gesture counts). **Bit 7 is the LOW BEAM SWITCH**, set in 50.64 % of frames — settled on 2026-08-16 by the byte-2 work above, since it agrees with b2 bit 1 in all 1 103 000 frames and Energica's own list pairs `V_LOW_BEAM_SW` with `V_LOW_BEAM`. It gets no key of its own: `low_beam_lamp` already carries the same information and a third beam key earns nothing. Named here so the next person does not re-derive it.

Evidence is 1 103 000 frames of 0x102 across the same 14 captures as 0x400. What makes these more than "the bit moves" is that the six low bits split cleanly into two behaviours, and the split is the one the owner's manual predicts:

```
bit  presses  median  pressed above 3 km/h
0     76      0.140 s     0 / 76     ← menu: the manual says the menu is locked
1    141      0.120 s     4 / 141      out above 3 km/h, so it can only be
2     40      0.131 s     0 / 40       operated stationary, and it is
3     41      0.210 s    41 / 41     ← indicators: only ever used while riding
4     24      0.180 s    23 / 24
5     63      0.181 s    63 / 63
```

Nothing about "a bit toggles" forces that pattern; it is what a speed-locked menu and a set of turn signals actually look like, from opposite ends of the same byte.

#### bits 0 and 1 — the MODE pair

✅ CONFIRMED as menu buttons (76 of 76 presses at a standstill for bit 0, 137 of 141 for bit 1, both transient at ~0.13 s).

✅ **LEFT-vs-RIGHT CONFIRMED 2026-08-19, by instructed press rather than by ride context** — no recorded ride can separate ◀ from ▶, because both do the same thing to the same menu, so one had to be staged. The owner pressed one named button eight times in a row, and each block was fenced by a COUNTED number of indicator-cancel clicks (1 before ENTER, 2 before ◀, 3 before ▶): cancel is the best-identified bit on the byte, so the capture times and labels its own blocks and needs neither a synchronised clock nor a narration to read back. Result: **bit 0 fired 8/8 inside the ◀ block and never outside it, bit 1 fired 8/8 inside the ▶ block and never outside it**, neither moved during any fence, and across the whole capture no two of the low six bits were ever set in the same frame. That agrees with Energica's table, which is all the mapping had rested on before. The anchor is the rider's own ◀/▶ identification of the pod, so a pair of mislabelled CAPS would still read as confirmed here; nothing else depends on the order.

**bit 1 has two behaviours bit 0 does not.** Both were filed as unexplained until 2026-08-19; both were then measured, and the first turns out to be a second FUNCTION rather than a fault. The old advice — "treat bit 1 as the less trustworthy of the pair" — was a reasonable reading of an unexplained hold and is **withdrawn**.

**1. Two 0.81 s holds at 88 km/h**, 2026-08-04 18:04:44.975 and 18:04:46.005. This is **▶ adjusting the cruise set speed**, not a menu press. The sequence, measured in `capture-20260804-035631-c8fe853f.log`:

```
18:04:42.270  cruise ON/OFF held 877 ms    (0x400 b2 bit 1)
18:04:42.796  cruise_active → 1            (0x102 b3 bit 1, 0.53 s later)
18:04:44.975  ▶ held 810 ms                ← cruise ALREADY armed
18:04:45.055  cruise SET held 1794 ms      ← overlaps that hold
18:04:46.005  ▶ held 809 ms
```

Speed decays 87.9 → 83.6 km/h until 18:04:45.4, then climbs back and sits at 85.5-86.2 km/h for the rest of the window. ▶ is pressed only while cruise is armed, in long holds rather than taps, at a speed where the menu it otherwise drives is unreachable — the menu is stationary-only, > 3 km/h exits it (`obd-garage/CAN_MAP.md` §Connectivity). The owner confirms he was working the cruise control. One arming event, so this is the best explanation rather than a settled second key function; a second armed ride watching this bit closes it.

**2. Held 191.2 s from 2026-08-04 21:00:31.712 while the bike was AC charging** — something resting on the button, not a press. In `capture-20260804-210015-b406ea70.log`, across the whole 191 s NOTHING else on the bars moves: mode ◀ and ENTER, both indicator switches, cancel, high beam, horn, both brakes, SET|BACK and both cruise buttons record zero transitions each, and the bike is stationary. Then 0.1 s after the bit releases, six ordinary presses land within 1.7 s (170, 170, 170, 30, 120, 150 ms) — someone lifting the object off and carrying straight on. The owner's account is that his jacket lay on the bar while the bike charged unattended, which is what this looks like; the measurement shows an object, not which object.

⚠️ **The consequence for anything downstream:** a multi-minute HOLD is a state this bit really reaches, so code that counts presses or assumes momentary must not treat a long assertion as impossible. The 2026-08-19 fenced session supplies the ordinary case: 8 presses, 120-160 ms each, nothing held.

⚠️ **Both files above are single captures. Do NOT concatenate the archive's overlapping captures before measuring:** two candump instances recorded the same seconds, so a merged file interleaves duplicate frames and turns one hold into hundreds of 10 ms toggles. That artefact was produced and discarded while measuring this.

#### bit 2 — MODE ENTER

✅ The cleanest of the three: 40 presses, all 0.08-0.29 s, every one below 3 km/h, no outliers at all. Re-confirmed 2026-08-19 by instructed press: 8/8 inside its own fenced block, 170-260 ms, nothing else on the byte moving.

#### bits 3 and 4 — the turn-indicator SWITCHES, left undecoded

Which side is which is no longer an open question, so it is written down.

🚨 **BIT 3 IS RIGHT AND BIT 4 IS LEFT**, the opposite of the `.xdbc`'s order, which puts them left-then-right. Measured 2026-08-19 over all 14 650 573 frames of 0x102 in the 248 captures in the archive, by taking every rising edge of each switch and asking which blinker lamp (b2 bits 2/3) was dark in the 3 s before it and lit in the 3 s after:

```
b0 bit 3, 464 presses → started the RIGHT lamp 437×, the left lamp 5×
b0 bit 4, 361 presses → started the LEFT  lamp 328×, the right lamp 2×
```

The remaining 53 started nothing: 47 changed no lamp at all and 6 stopped one, which is what a cancelled thought and a re-press look like. Two consecutive frames, 10 ms apart on 2026-08-02 at 21:05:47, make the same point with no statistics at all:

```
.339152  88 BE 82 04 FA FF 34 00   ← b0 bit3 down, b2 has no blinker bit
.349109  88 BE 8A 04 FA FF 28 00   ← next frame, b2 bit3 (RIGHT lamp) lit
```

**Do not "fix" this from the third-party file** — that file was already caught calling the high beam `charging`.

**They stay undecoded because nothing reads them:** the dashboard's buttons section was given the LAMPS (`blinker_left` / `blinker_right`, b2 bits 2/3) on 2026-08-19, since what a rider means by "is my indicator on" is the lamp and not the thumb. Two more keys would put four tiles on screen for two indicators. If something ever wants the switches — telling a failed bulb from a missed press is the obvious one — they are `bit(handlebar, 3)` for right and `bit(handlebar, 4)` for left, and the measurement above is the evidence.

#### bit 5 — the indicator-cancel press

✅ CONFIRMED, and this is **the strongest identification of the seven**: all 63 presses happened with an indicator lamp actually flashing, **63 out of 63**, and in 28 of them the lamp stopped within 3 s. Indicators were running for a few hundred seconds out of hours of capture, so 63/63 is not a coincidence. The 41 + 24 = 65 indicator switch presses on bits 3/4 against 63 cancels is the same story counted twice.

### Byte 3 — the fast-charge contactor monitor and cruise state

Added 2026-08-16. This byte was written off as "a constant 0x44" when 0x102 was first decoded, which is true of a parked bike and false of a charging one: across the 14 captures it takes five values — 0x44 (88.4 %), 0x45 (9.4 %), 0x46 (1.2 %), 0x04 (1.0 %) and 0x06 (0.02 %). **Bit 2 is set in all five and is never once clear in 1 103 000 frames**, so it is left undecoded rather than logged as a constant 1. Bit 6 moves constantly and is not understood; bits 3, 4, 5 and 7 are never set.

**bit 0 — `V_FASTDC_MON_SW`**, the DC fast-charge contactor state monitor, and the analog wire `A020_FCHG_MON` it corresponds to. ✅ CONFIRMED, and it is the best-evidenced bit in that change:

- Set in **EXACTLY ONE interval in the whole corpus** — 2026-08-04 19:58:45.489 → 20:16:03.587, 1038.1 s, which is 103 790 of the 1 103 000 frames. Zero everywhere else: all riding, all parking, all key-off.
- That interval is a DC fast charge, from the pack's own frames: 0x200 shows current going from −0.1 A to +63.2 A within 4.6 s of the rise, and SOC climbing 30 % → 42 % over the window. No 0x305/0x306 appear at all, which is right — a DC charger bypasses the onboard AC charger that sends them.
- **It leads the charge:** it rises 190 ms before `charger_enabled` (0x300 byte 0) and ~470 ms before the first positive pack amp. A contactor monitor should lead, because the contactor closes before anything can flow through it.
- It reads 0 through **every AC charge in the corpus** — four separate sessions, one of them 48 minutes at 14 A mains. So it discriminates DC from AC rather than just meaning "plugged in", which is the whole reason to want it.

**bit 1 — cruise control armed.** 🟡 Not in any vendor table; inferred here, and inferred from exactly two events, which is why it keeps the 🟡. Both are clean: it came up 0.525 s and 0.546 s after the only two presses of `btn_cruise_enable` on 0x400, held for 51.4 s and 82.3 s, and never moved otherwise. It is logged because it is the evidence for those two buttons — with this on the dashboard the owner can press cruise ON/OFF and watch the state follow, which is the check that would otherwise need a laptop and candump.

### Bytes 4-7 — the attitude sensor's two angles. NOT accelerations.

`src/can/attitude.ts`.

Until 2026-08-15 these two int16s were logged as `accel_lateral_raw` and `accel_frontal_raw` — raw counts, blank unit — on the `.xdbc`'s word that 0x102 carries accelerations "in g" with no multiplier given. **That reading is wrong.** The fields are the VCU attitude block's two DERIVED angles, in units of 0.1°:

```
b4-5 LE int16 = roll,  Energica's AttitudeSensor_Phi.    Positive = leaning RIGHT.
b6-7 LE int16 = pitch, Energica's AttitudeSensor_Thete.  Positive = nose-down, i.e. decelerating.
```

✅ **Four independent things establish that**, all from stored data — the bike itself was not touched, it was out of reach for about a week from 2026-08-15.

1. **The bytes match Energica's own block.** The parked side-stand capture of 2026-08-02, `80 10 02 44 99 FF D8 FF`, has b4-5 = 0xFF99 = **−103**. The KWP dump of 2026-06-14 (`obd-garage/kwp_scan_raw.txt`) reads A9 bank 2 id 0x8A — `AttitudeSensor_Phi` — as the _same bytes_, `ff99` = −103. That same block's gravity vector (Gx 53, Gy −179, Gz 982 mg, |G| = 999.6 mg) independently gives atan2(Gy, Gz) = **−10.33°**. So −103 is −10.3° of roll: the bike leaning left on its side stand, which is where it was.
2. **The values lie on an arctangent lattice.** Across the 15 455 rows logged under the old keys the pair only ever takes values whose spacing SHRINKS with magnitude — ~5.7 apart near zero, ~3.4 apart near 400. A count scaled by a constant cannot do that; round(A·atan(k·q)) does exactly that. Fitting A and q freely over the 80 distinct positive values gives **A = 576.9 units per radian**, against 572.958 for 0.1°/radian — 0.7 % off, and a factor of ten away from either 1° or 0.01°.
3. **Roll tracks the side stand and nothing else.** Median −10.8° with the stand down (`stand_up` = 0), −0.6° with it up and the bike moving, and — outside the one 230 ms transient described below — it never left ±17.9° across the other 488 of its 494 moving samples, on rides that reached 186 km/h. A _true_ lean angle would pass 30° on any roundabout. A gravity-referenced one reads ≈ 0 in a steady corner, because the bike leans into the resultant — which is what this does.
4. **Pitch tracks longitudinal acceleration, and gives the sign convention:** median +13.1° while the brake bit is set against −5.2° while it is not, +9.2° at closed throttle (regen) and −12.5° above 25 % throttle. Same apparent-vertical effect on the other axis.

**The range confirms the unit from the other end.** On 2026-08-08 12:30:19 one 40 ms burst read −184, −1703, −1506, −425, −215, −108, −6 at 100 Hz. −170.3° is atan2 wrapping toward ±180° on a hard hit, which is only possible if the field is an angle scaled at 0.1°; **±1800 is then the entire range**, and nothing in the seven days of ride log that exist lies outside it. That bound is what the module checks on every frame.

⚠️ **THIS IS APPARENT ATTITUDE, NOT LEAN ANGLE.** The block is Gx/Gy/Gz/Phi/Thete/Mag and nothing else — three accelerometers and what is derived from them, **no gyro**. Both angles are the direction of the measured vertical, so they answer "which way is down as far as the bike can tell", not "how far over is the bike". Cornering hides itself almost completely (point 3); braking shows up as pitch (point 4). Anything wanting real lean needs a rate gyro the bike does not publish here.

🟡 **Inferred, not proven:** that the broadcast pair IS the bank-2 block rather than an independent copy of the same sensor. Bit-identical Phi bytes on the side stand is strong, but the two were read on different days over different transports. Reading A9 bank 2 ids 0x87-0x8C live while tilting the bike settles it, and is the outstanding experiment (see the service-tool analysis in `obd-garage/`). Also inferred: the pitch sign convention above is measured off this bike's brake and throttle bits, not read out of any document.

**Why the out-of-range warning needs five consecutive frames.** A bare inequality would spend the warning on noise. This bike emits occasional junk samples on plenty of signals — `high_beam` reading 193, 0xFFFF cell voltages, −32767 GPS altitude, the whole reason `public/lib/bounds.js` exists — and one of those landing in b4-7 must not silence the diagnostic for the rest of the boot, because the thing it is there to catch (a frame layout change) arrives later and lasts forever. 0x102 is 100 Hz, so five frames is 50 ms: nothing a real layout change would survive, and far more than a single corrupted sample can fake. `pack-temperature.ts` guards its warnings the same way at 3, against frames that arrive at 1-20 Hz rather than 100. The journal line is rationed to once per axis per process for the same reason: at 100 Hz a layout change would otherwise fill the journal at 200 lines a second and push out whatever else went wrong at the same moment. The sample itself is dropped on every out-of-range frame regardless.

---

## 0x104 — odometer / speed / rpm

`src/can/decode.ts`. LE and not byte-aligned, at 100 Hz.

**The odometer is the solid part:** `8D 99 02 00 …` → 170381 × 0.1 = 17038.1 km. ✅ It gets its own key rather than overwriting the BLE hub's `odometer_km`, because the bike publishes three odometer-ish numbers and they do not all agree. Read within the same minute on 2026-08-02, parked: CAN 17038.1 km · BLE `odometer_km` 17038 km · OBD PID 31 `dist_since_clear_km` 17042 km. So CAN and BLE agree to within their resolution and PID 31 sits 4 km above both — which is what you'd expect, since PID 31 counts distance since the last DTC clear rather than lifetime distance, and evidently started from a non-zero odometer. Keeping them as separate signals means a ride can settle it; merging them would just make one value flap between writers.

**Speed and rpm** read 0 for the whole parked capture, so the offsets started as the `.xdbc`'s word alone. A garage lap on 2026-08-02 (545 k frames, full bus, OBD polling in the same file) settled them against ground truth: ✅

```
5F 00 32 00 → speed 95  → 9.5 km/h  (OBD PID 0D: 10)   rpm 400 (PID 0C: 411)
67 00 36 00 → speed 103 → 10.3 km/h (OBD PID 0D: 10)   rpm 432 (PID 0C: 427)
```

Both track their PIDs to within ~1-2 % across the lap, which fixes speed as a **u13 at bit 32** and rpm as a **u15 at bit 45**. rpm's start bit in particular is pinned to the bit: 44 would decode 800/864 and 46 would decode 200/216 against a PID reading 411/427, so only 45 reproduces it. The reverse bit is real as well: b7 = 0x80 on 1122 frames, with 0x40 on another 406 belonging to the tachometer field at bits 60-62. So the `.xdbc`'s own C fragment (`data[4] | (data[5] << 7)` — a shift of 7, not 8) is the thing that doesn't reconcile, not the normalised layout used here.

**The lap only reached ~10 km/h / ~430 rpm**, so the top of both fields was never exercised — but that residual announces itself instead of hiding. 200 km/h needs 11 of speed's 13 bits and 11 000 rpm needs 14 of rpm's 15, so bits 43/44 and 59 can never be set by the quantity itself. If something else lives there the value is impossible rather than plausible: speed jumps by 204.8 or 409.6 km/h, rpm by 16 384. Seeing either is the signal that the field is narrower than assumed.

⚠️ **The bit layout is right; the NUMBER is the bike's, and the bike's is optimistic.** Against GPS over two 2026-08-04 road captures, `speed_can_kmh` reads +3.5 % and the odometer accumulates +3.4 % — about +3.4 km/h at an indicated 100. `speed_can_kmh` is exactly `motor_rpm_can` / 42.0, so it is geared driveline speed and not a wheel measurement, whatever the dashboard labels it. Full working in [the dash over-read](#the-dash-over-reads-and-by-how-much); **do not re-derive it against 0x104 itself, which is how the ABS scale went wrong.**

---

## 0x109 — `VCU_DRIVEBYWIRE`

`src/can/decode.ts`. Throttle plus the inverter's current limits, four u16 LE at 100 Hz.

- **b0-1 ÷10 = throttle %** (0 idle … 100). 🟡
- **b4-5** read 1200 parked → 120.0 A, exactly the `allowed_regen_a` the BMS publishes in 0x202 at the same moment. That agreement is what pins the ÷10 scale for all three fields. ✅ The `.xdbc` marks regen as flowing the other way and so gives it a negative scale; it is logged positive here to match `allowed_regen_a`, the signal it was validated against — one physical quantity under two keys with opposite signs plots as mirror images and makes a difference-of-the-two check read 240 instead of 0.
- **b2-3** read 100 → 10.0 A while the BMS was allowing 386.7 A of discharge, so this is the inverter's currently permitted output rather than the pack ceiling. Only ever seen at rest, so unverified against ground truth. 🟡

### 🚨 b6-7 was `current_other_a`. IT IS NOT A CURRENT.

Removed 2026-08-20. The `.xdbc`'s unidentified "Current other" gave 153.8 A parked under that scaling. Read as a u16 it produces **5069.0 A in 490 165 frames of one capture alone**, which is an order of magnitude past anything this pack can deliver, and it takes a handful of discrete values rather than varying the way a measured current does. The name came off the `.xdbc`, a rider's file — the same source that gave 0x102 `charging` when the bit was the high beam.

Energica's own `FramesDB.ParseVCU_DRIVEBYWIRE` (the 2024 service-tool analysis in `obd-garage/`, §`0x109` `VCU_DRIVEBYWIRE`) says **b6 is a bitfield**:

```
bit0     V_MAP_CHANGING
bits1-5  V_ACTIVE_MAP
bit6     V_eABS_EVENT
bit7     V_TC_EVENT
```

and b7 the same shape for the regen map plus two fault bits.

✅ **b6's two event bits are CONFIRMED by behaviour, not just by the name**, over 438 228 frames of 0x109 sampled alongside 0x0A0 across the 15 captures that carry ABS interventions. `V_TC_EVENT` is set in 1326 of them and the picture is exactly traction control:

- median throttle **77.2 %** and median torque **+137.6 Nm** when set, against **15.6 %** and **+11.9 Nm** when clear;
- the rate climbs monotonically with throttle — 0.00 % below 20 %, then 0.05 %, 1.24 %, 12.08 %, then **14.89 % above 80 %**;
- and it is **NOT merely a throttle threshold**: inside the ≥ 60 % throttle band alone, frames with the bit set carry +146.2 Nm median against +109.9 Nm without it. At the same rider demand it fires when torque is higher, which is what a traction controller does and what a throttle comparator could not.

b6 takes only 0x02, 0x42 and 0x82 in these captures, i.e. ride map 1 throughout with the two event bits toggling — which is the layout above and is not a 16-bit anything.

⚠️ **b7 is deliberately NOT decoded.** Its top two bits are set in 490 165 frames of `capture-20260807-213359`, which is not what a fault bit does, and those spans do not overlap the ABS broadcast so nothing here can say what state they mark. **The map fields in b6 bits 0-5 are left alone too:** `V_ACTIVE_MAP` is 1 in every frame on record, so there is nothing to validate the position against yet. Only the two bits the data actually pins are decoded.

⚠️ **`tc_event` is NOT `abs_rear_control_active`**, and the whole point of having both is that they disagree. This is the VCU's traction control, firing at 77 % throttle and +138 Nm median; that is the ABS module's rear channel, firing at ~15 % throttle. Of the 162 ABS interventions in the archive, `tc_event` is set at 4. They are different events and a dashboard must not present one as the other.

---

## 0x10B — `VCU_VEHICLE_CONSUMPTION`

`src/can/consumption.ts`. 10 Hz. Layout is Energica's, from `FramesDB.ParseVCU_VEHICLE_CONSUMPTION` (the 2024 service-tool analysis in `obd-garage/`, §`0x10B`):

```
b0-1 LE u16  V_INST_KM_KWH        instantaneous, km/kWh
b2-3 LE u16  V_INST_KWH_100KM     instantaneous, kWh/100 km
b4-5 LE s16  V_AVG100M_KM_KWH     averaged over the last 100 m
b6-7 LE s16  V_AVG100M_KWH_100KM  averaged over the last 100 m
```

Worth knowing against issue #39, which measures consumption by integrating pack power: **the bike broadcasts its own answer at 10 Hz and has done all along.**

### ✅ The frame proves its own layout AND both scalings with no bike involved

Which is why it could be shipped from a capture taken two weeks earlier. The two instantaneous fields are exact algebraic reciprocals of each other: 34.5 km/kWh IS 2.899 kWh/100 km. Under the scalings above that means `b0-1 × b2-3 ≈ 1 000 000`, and over the 2026-08-02 garage lap it holds on **ALL 448 frames** where neither field is saturated — 448 ok, 0 bad — once the 0.1 km/kWh quantisation of the first field is allowed for. Median product **1 000 051**.

```
b0-1  ⇒ km/kWh   100 ÷ that   b2-3 observed
 345      34.5      2.899          2900
 230      23.0      4.348          4350
 690      69.0      1.449          1450
2529     252.9      0.3954          395
3448     344.8      0.2900          290
4023     402.3      0.2486          249
```

⚠️ **CORRECTION, 2026-08-16.** The consolidated analysis on issue #21 states this relation in prose as `b2-3 == 100000 / (b0-1)`. **That is off by a factor of ten and matches ZERO of the 448 frames**; the constant is 1 000 000, which is what the ×0.1 and ×0.001 scalings force (100 ÷ (0.1 × 0.001) = 10⁶). The table in that same comment is right — only the formula beside it is wrong. Written down because it is exactly the kind of thing that gets copied into a check and then "fixed" by loosening the check.

### ✅ Which field is which is pinned by the saturated states, not by the reciprocal

The reciprocal test is symmetric under swapping the two scalings and cannot tell them apart. The capture can:

- `(0, 65000)` occurs in **3603 frames, and the bike is at EXACTLY 0 km/h in all 3603** of them.
- `(65000, 0)` occurs in 36 frames, all of them moving, mean 7.3 km/h — coasting.
- Everything in between occurs only while moving: 0 of 449 at a standstill.

Standing still means zero distance per kWh and infinite kWh per km, so b0-1 must be the km/kWh one. Read the other way round it would claim the parked bike is using no energy per km and returning 6500 km/kWh, which is backwards.

### The saturation guard, and why nothing is emitted rather than clamped

The VCU clamps at **65000** rather than using 0xFFFF, so the two states it can be in are `(0, 65000)` and `(65000, 0)`; either field hitting either end means the whole pair is undefined, because the two fields are reciprocals of one quantity. When consumption is undefined there is no honest number to log, so nothing is: the series is sparse by design, the same shape `batt_temp_lo`/`batt_temp_hi` already have. Clamping or passing the sentinel through would put 65 kWh/100 km on the chart every time the bike stands still, and `bounds.js` would accept it, because 65 kWh/100 km is not an impossible number — just a false one.

### 🟡 The 100 m averages, and why they are read UNSIGNED

They carry the same scalings by position, and get the same saturation guard, for the same reason: they are the same two quantities over a different window, so the state where consumption is undefined has to exist for them too. This lap never showed it — but a clamped 65000 arriving unguarded is worse here than in the instantaneous pair, because it is small enough to look like an ordinary reading rather than an obvious sentinel.

⚠️ **They are read UNSIGNED, and this is the one place this file disagrees with Energica**, which declares them `short` where the instantaneous pair is `ushort`. A signed read is tempting — it is the call `src/can/decode.ts` already makes for 0x020's temperatures, where the argument is that signed "cannot regress anything" because no real temperature reaches 3276.7 °C. **That argument does NOT carry over:** km/kWh × 10 demonstrably does exceed 32767, because the instantaneous field on this very frame reached **33793** (3379.3 km/kWh) during the garage lap, paired with 0.030 kWh/100 km exactly as the reciprocal requires. So a signed read here would turn a real high-coasting average into a large negative — a plausible-looking regen figure — which is precisely the failure the unsigned read cannot produce.

The residual announces itself instead of hiding, which is why unsigned is the safe direction: if these fields really are signed and a 100 m window of net regen ever occurs, it shows up as a value near 6553.5 km/kWh. That is impossible rather than plausible, and it is the signal to revisit this. A quietly negative number would not be.

**The other reason to keep them 🟡:** this lap only ever produced TWO values, 1392/741 held for 3833 frames and 133/7500 for 255 — one change in seven minutes. 133/7500 is reciprocal-consistent under these scalings and 1392/741 is not, which is what two independently averaged quantities do, and also what a wrong scale would do. Two samples is not a confirmation. They are logged (at one row per capture they cost nothing) so a real ride settles them; **do not build anything on them yet.**

---

## 0x121 — the rider's own charge-current limit

`src/can/charge-setpoint.ts`. Opcode 0x18.

The bike's TFT lets the rider pick a DC fast-charge current on the charging screen, anywhere from 1 A up to a ceiling. **Two different numbers were being conflated:**

|  |  |
| --- | --- |
| **the CEILING** | VCU calibration parameter 258 `MAX_DC_CHG_CURRENT`, 75 on this bike. Changed only with the manufacturer's service tool, which sells it as the "Fast Charge 60/75/80 Amps" options — all three write this one byte. |
| **the SETTING** | what the rider actually dialled in, ≤ the ceiling. This frame. |

**The setting is not a calibration parameter.** All 277 rows of this bike's own VCU parameter export were searched and there is no second charge-current entry — 258 is the only one, and the `[EVSE]` block's spare slots (`EE_EVSE_DUMMY_1/2/3`, `EVSE_DUMMY_WORD4`) all read 0. The same holds across all 28 of Energica's parameter tables, and none of the 120 telemetry infokeys is a charge-current setpoint either. So WHERE the bike keeps it is not known — only that 0x121 is the one place it is ever stated on this bus. Whether it survives a power cycle is an open question; see the event note below.

### 0x121 is a dash↔VCU command channel, not a broadcast

0x120 and 0x121 carry a request/reply pair sharing one opcode byte: **0x120 b0 is always 0x121 b0 | 0x80** (596 frames across 22 captures, no exception). Nine opcodes were seen, and only the two current-limit ones put amps in b2:

```
b0    what it is                       b2            b3         b4
0x18  DC current limit changed         amps, 1..75   1          0x4B = 75  ← decoded
0x1A  AC current limit changed         amps, 1..15   1          0x0F = 15
0x16  charge stop                      1             0          0
0x1B  a query; the answer is in b3      0xAA          40..145    0
0x1D  a query; the answer is in b2      45..147       0          0
0x02 / 0x14 / 0x1E / 0x2C              other traffic, none of it amps
```

**The opcode gate is load-bearing, not defensive tidiness:** of the 298 captured 0x121 frames only 18 are ours, and 0x1D alone accounts for 204 of them and reaches b2 = 147, which would read as a wild charge current if the opcode were not checked. Worse, **opcode 0x2C has been seen carrying b2 = 0x4B = 75** — the exact number a wrong decode would most easily be believed.

**0x120 is deliberately NOT decoded** — it is the truncated half of the pair (b3/b4 are 0 there, so it carries no ceiling), and it is also the id this project TRANSMITS the RTC sync on (`src/vcu/service-actions.ts`).

### b4 is the ceiling — checked here, published elsewhere

b4 read 0x4B = 75 in all 18 DC events and 0x0F = 15 in all 8 AC events — exactly `MAX_DC_CHG_CURRENT` and `MAX_AC_CHG_CURRENT` as read from this bike's VCU. So the frame is self-describing, and **b2 ≤ b4 is a real invariant** worth gating on. It is NOT emitted as a signal: 0x625 b2 carries the identical number continuously while this frame carries it only when the dial moves, so the ceiling belongs to the charge-manager decoder and the setting belongs here.

### Evidence that b2 really is the rider's setting

From the archive, 10 DC sessions (0x645 present) and 8 AC ones:

- **26/26 events satisfy every structural invariant** — b1 = 0xFF, b3 = 1, b2 ≥ 1, b2 ≤ b4, b5-7 = 0, DLC 8, and a matching 0x120 twin within 50 ms.
- Opcode 0x18 fired **18/18 inside a DC session** and opcode 0x1A **0/8** — the two never cross, which is what says b4 is the mode's ceiling rather than a coincidence.
- **THE CURRENT OBEYS IT.** Whenever the rider dialled DOWN below what was flowing, the measured DC current (0x615 b2) settled on the commanded value EXACTLY, **9 times out of 9**, in 0.31-2.25 s. 2026-08-09 walks 1 → 5 → 10 → 15 → 20 → 35 A and the current lands on each one in turn.
- Over the 15 plateaus that follow an event — **53 268 measured-current samples** — the delivered current NEVER ONCE exceeded the commanded setpoint. **100.000 %.**

**Dialling UP is not obeyed the same way, and that is the point of having the signal:** set 75 and the current stops at 66, 73, 53 or 36 depending on the session. Something else is binding (station envelope, VCU pack-temperature derate — see `obd-garage/DC_CHARGE_LIMITS.md`). So this signal answers "did I cap it myself?", which is exactly the question that was unanswerable while the two numbers were conflated.

**The AC twin (0x1A)** is decoded far enough to be rejected, and deliberately emits nothing: `charge_limit_a` already carries the AC setting continuously off 0x10A b7 ÷ 7. The 0x1A events are what **CONFIRM that ÷ 7 scale** — on 2026-08-08 23:49:59 a commanded 9 A put 0x10A b7 at 63 within 0.09 s, and 8 A put it at 56 — so the two agree to the amp and there is no reason to log the same number twice.

### Why all six structural invariants are gated, not a subset

This is a COMMAND frame whose byte layout is chosen by the opcode. A future 0x18 meaning something else would more plausibly show up as a changed length or a non-zero tail than as a changed b1, and decoding it anyway would put a fabricated amp figure on a charging screen. Every captured frame on both ids is DLC 8, and b5-7 are zero on every opcode but 0x14 — which is precisely the point: **a tail in use marks a different layout.**

- **b1** is 0xFF in all 596 captured frames of both ids, opcode regardless — a separator.
- **b3 = 1** means "a limit is in force", and ONLY the two limit-change opcodes ever set it: the charge stop sends b3 = 0, as do 0x02/0x1D/0x1E/0x2C. The other two are not 0 but are not 1 either — 0x1B answers a query in this byte (40..145) and 0x14 reads 138 — so this is a genuine second discriminator rather than a restatement of the opcode.
- **1 ≤ b2 ≤ b4** held in every captured event. A frame that breaks it is not this message, and passing it through would put a setting on the dashboard contradicting the ceiling drawn next to it — the one reading worse than showing nothing at all. A zero ceiling needs no clause of its own: b2 is ≥ 1 by then, so b2 > b4 already catches it.

⚠️ **The price of that strictness is the direction it fails in:** a firmware update that starts using b5-7, or shortens the frame, makes this signal go **SILENT rather than wrong**. If it ever stops appearing after an update, look at the guard first.

### ⚠️ THIS FRAME IS AN EVENT

It fires when the rider moves the dial and at no other time — **5 of the 10 captured DC sessions contain no 0x121 setpoint event at all**, because the dial was never touched. Nothing rebroadcasts the value, and it is not mirrored anywhere on the bus: every byte and 16-bit pair of every id was scanned across three known plateaus and the only field tracking the setting was 0x615 b2, the MEASURED current. On AC there is a continuous echo (0x10A b7); on DC that byte reads 0 for the whole session (1300/1300 frames checked). Consequences worth knowing before relying on this:

- **The value is the LAST SETTING SEEN, not a poll.** After a service restart it is absent until the rider next touches the dial.
- **Its dashboard tile greys out 8 s after arriving**, like `waypoint_seq` and for the same reason. That is not a bug and must not be papered over by re-asserting it on a timer — `record()` refreshing `liveState` is how "this signal stopped arriving" stays honest everywhere else.
- ⚠️ **A consequence of log-on-change that bites HERE and nowhere else:** `record()` seals a row only when the value differs from `lastLogged` by more than the deadband, so **re-selecting the value you already had writes no row** — and `notifyChange`, inside the same branch, does not fire either. Dial 5 A, then dial 5 A again on the next charge in the same process lifetime, and the second one leaves no trace in the ride log. The dashboard is fine (the 5 s snapshot heartbeat refreshes `ts`, so the tile un-greys), but an absent row means "not touched OR re-picked the same number", not "not touched". `waypoint_seq` escapes this by being a monotonic counter; a setting cannot. Setting a deadband here would make it strictly worse, which is why there is none.
- ❓ **Whether the setting survives a power cycle is UNKNOWN** and not answerable from this bus, because the bike never announces it at session start. Issue #51 carries the on-bike check.

### Three different "DC current limits", and they really are three numbers

The ALL view renders them together, so read the qualifier and not just the prefix:

```
dc_charge_limit_selected_a  0x121 b2  what the RIDER picked on the bike's own screen
fast_dc_limit_max_a         0x625 b2  the configured ceiling the dial runs up to, 75
fast_dc_limit_a             0x620 b0  the limit in force this second, 0…75 in a session
```

`charger_max_dc_a` is a fourth thing again — the ON-BOARD AC charger's own register, which reads 0.0 A throughout a DC session.

---

## 0x125 / 0x127 — redundant road speed and the throttle position sensor

`src/can/drive.ts`. Neither is in Energica's `FramesDB`; both are settled by the capture alone.

### 0x127 — the dual throttle position sensor, 4 Hz

✅ b0-1 and b2-3 as LE u16 correlate with 0x109's throttle at **r = +0.9982 and +0.9980** over all 1523 frames, and with each other at **r = +0.99946**. Ranges 0-4023 and 0-4050, so 12-bit ADC counts. `b0-1 − b2-3` stays inside **[−143, 0]** for the entire lap: two channels tracking each other within a tolerance, never crossing, which is precisely the arrangement `P0120` (throttle fault, physical error) and `P0121` (logic error) exist to police. A divergence here is a real diagnostic, and it is the reason to log both rather than one.

**Deliberately RAW counts, not a percentage.** Fitting them against 0x109 gives `throttle_pct ≈ counts × 0.0201`, and 0x109's own throttle scale is itself only 🟡 in this repo — converting would stack an unverified scale on an unverified scale and produce a second, slightly different `throttle_pct` for the dashboard to disagree with itself about. The counts are what the diagnostic needs.

The frame is a steady 4 Hz (median gap 0.2501 s), not event-driven, which is why it is cheap. b5 is constant 0x33 and b6-7 constant 0.

❓ **b4 ∈ {0,1} is NOT the throttle-on bit it looks like:** it is 1 while mean throttle is 0.10 % and 0 while mean throttle is 26.2 %, i.e. inverted, and it agrees with 0x102's `throttle_on` in only 24 of 1523 frames. Something like "throttle at its rest stop", but one capture at one operating point is not a decode, so it stays out.

### 0x125 — two redundant road-speed channels, 55 Hz

✅ b0-1 and b2-3 as LE u16 correlate with 0x104's confirmed `speed_can_kmh` at **r = +0.9966 and +0.9976** over 22 480 frames, and are BYTE-IDENTICAL to each other in 19 823 of them. A pair that agrees exactly 88 % of the time and lags into agreement the rest is a redundant pair, almost certainly the safety micro's own view of road speed — the same micro whose firmware identity block sits on 0x147.

⚠️ **NO SCALE**, and that is why these are logged as counts with a blank unit rather than km/h. Fitting through the origin against `speed_can_kmh` gives ~109 counts per km/h, which is not a round constant under any reading — not ×100, not the motor's 42.0 rpm/km/h, not the ABS front-wheel scale (105.2 counts per ABS km/h). Publishing that as km/h would put a made-up divisor on the dashboard next to a speed that IS calibrated.

⚠️ **2026-08-16: that ~109 came from the garage lap fitted against `speed_can_kmh`, and BOTH halves of that are now known to be bad** — 0x104 reads 3.5 % fast against GPS, and the garage lap never passed 11.5 km/h, which is enough to distort a fit on its own (the same two mistakes cost the ABS scale 4 % and invented a 9 % channel disagreement). Re-fitted against `gps_speed_kmh` over 199 steady-state samples at 40-100 km/h from the two 2026-08-04 road captures: **105.1 and 103.7 counts per true km/h**, IQR 104.7-105.5 and 103.3-104.0. Note that is **NOT** 109 × 1.035 = 113 — the garage-lap number was not merely biased by the reference, it was wrong in the other direction too, so it cannot be rescued by scaling.

**The conclusion survives unchanged:** 105.1 is no rounder than 109 was, so these still log as raw counts. Two claims do NOT survive and are corrected here rather than left standing:

- "BYTE-IDENTICAL in 19 823 of 22 480" is garage-lap-only. At road speed (both channels above 4000 counts, n = 36 195) they are identical in **15 frames — 0.04 %** — and otherwise sit a steady **+112 counts apart**, b0-1 above b2-3 by 1.5 %. A fixed offset at steady state, not a lag: the gap is the same in the steady-state windows as in the raw frames.
- The 108.8-116.8 interquartile spread is also garage-lap-only; against GPS the spread is under 1 %, so these channels are far better behaved than that range suggested.

Still not converted to km/h, and now **for a better reason than "no scale is known": there are two channels 1.5 % apart, and picking one to publish would be picking which to believe.**

❓ **b4-7 is left alone:** two more 16-bit channels, both always EVEN (all 22 480 frames), ranging to 65530, correlating with speed at only r = +0.67 and stepping by neither 1 nor 2 between consecutive frames — so not the counter that shape suggests. Unidentified.

---

## 0x200 / 0x660 — pack temperature, and the clamp

`src/can/decode-bms.ts` and `src/can/pack-temperature.ts`. The BMS layouts are **not** reverse-engineered: they were read out of the bike's decrypted BMS configuration file (`stockconfig_eva_ribelle_2021.bms`) cross-referenced with the memory map and flag tables in the LiBAL Application Engineering Manual. Where that disagreed with notes taken off the wire, the config wins — see the "Corrections" section of `obd-garage/CAN_MAP.md`. Everything the BMS sends is big-endian except 0x207 and 0x300, which the config marks little-endian. 0x660-0x665 only exist once the extended config is flashed; until then they simply never arrive.

### Why 0x200 b0/b3 are `batt_temp_*_vcu` and not `batt_temp_*`

What they mean depends on which BMS config is flashed. The VCU derates DC charging from **36 °C** reported pack temperature, which is far too early for a watercooled pack, so the custom configs lower these two bytes to push that knee later. Only what is transmitted changes — every BMS protection threshold, the regen shaping curve and `allowed_regen_a` are still computed from the raw internal values.

**The size of that shift is NOT fixed, and assuming it is has already produced one false alarm.** Four configs have been flashed:

| config | behaviour |
| --- | --- |
| `5-custom-p32b-vcu-offset` | a flat −15 °C. **RETIRED** — it broke charging. |
| `11-full-conditional-offset` | a no-op: its postprocessor line never ran (verified over 1900 samples, 0x660 b3/b4 identical to 0x200). |
| `14-signbit-clamp` | pinned the reported value at 35 °C for ANY true temperature above 35, and passed the true value through below it. **SUPERSEDED.** |
| `15-bounded-clamp` | built 2026-08-09, **NOT YET FLASHED**. Bounds that clamp at the top: below 35 °C it passes the truth through, from 35 to 54 °C it reports 35, and at **55 °C and above it reports the TRUTH again**. |

So under the live config the difference `batt_temp_hi − batt_temp_hi_vcu` is 0 below 35 °C, `(true − 35)` from 35 to 54 °C, and 0 again from 55 °C up. **A constant 15 is the one thing it is NOT**, and it is not even monotonic in temperature. Do not treat any particular difference as a health check.

**The upper bound exists because the VCU enters limp mode at 55 °C** (`LIMP_B_TEMP` = 55 in the A9 parameter block — `obd-garage/DC_CHARGE_LIMITS.md` §7 puts it plainly: pinned at 35, the unbounded clamp does not delay that protection, it **disables** it). Not hypothetical: this bike's own log has the pack at a true 55 °C on 2026-08-08 13:45 UTC with `clamp_amount` = 20 and `batt_temp_hi_vcu` last logged at 35.

So these bytes are always "what the VCU and the dash see", which is honest under every config; the true temperature comes from 0x660 when one of these is loaded. Measured 2026-08-02 under the retired flat-offset config: 0x200 reported 13/14 °C while 0x660 b3/b4 reported 28/29 °C. Measured 2026-08-04 under the clamp: 0x200 reported 35/35 while 0x660 b3/b4 reported 36/36.

### The routing rule: which frame may write `batt_temp_lo` / `batt_temp_hi`

`src/can/pack-temperature.ts`. Those two keys have years of history behind them and **must keep meaning the TRUE pack temperature**. On a stock Energica that is 0x200 bytes 0/3, full stop. Once the custom config is flashed those bytes carry the VCU's lowered view instead and the truth moves to the long 0x660. This routing is the ONLY config-dependent decode in the repo; every other frame and correction is right on both.

No single frame announces which config is flashed, so it has to be established from what arrives:

- a **long 0x660** (DLC ≥ `OFFSET_CONFIG_MIN_DLC`) proves the offset config, and carries the true temperatures itself;
- **two consecutive short 0x660s** prove the extended config WITHOUT the offset, so 0x200 is true;
- **no 0x660 at all**, while the BMS is demonstrably transmitting, means a stock pack.

**Until one of those holds, `batt_temp_lo`/`batt_temp_hi` are not emitted AT ALL.** That is the rule the module exists to enforce, and it is deliberately asymmetric: a gap in a log-on-change series costs nothing and reads as "not known yet", whereas a lowered value under the true-temperature key reads as a plunge indistinguishable from a failing sensor — up to 19 °C under the bounded clamp, and it was 15 °C flat under the retired offset config — **and the ride log is sealed, so it can never be corrected afterwards.** There is no such thing as a safe fallback here; going quiet IS the fallback.

`CUSTOM_BMS_CONFIG` says which config to expect, but the frames say what actually arrived and **the frames win**. The flag by itself decides nothing that could corrupt data: it decides how the one case the bus can't answer (no 0x660 at all) is read, and which mismatch gets warned about. This is routing, not deriving: no value is computed, and a measured byte is either passed through under its historical key or left alone.

**Why the wait window is timed from the first 0x200** — not from startup, and not from the first frame of any id. 0x200 and 0x660 sit in the same BMS TX table, so a 0x200 on the wire is the proof that the transmitter is alive and that a configured 0x660 would follow within a second. Timing from startup would spend the window while the Pi waits hours for a sleeping bike; timing from any frame would spend it on VCU traffic while the BMS is still asleep. Both leave the window already expired at the moment the first 0x200 lands, which is precisely when it has to be full. 0x660 is 1 Hz, so five seconds is five chances to see one.

**Why promotion to 0x200 needs two consecutive short frames and promotion to 0x660 needs none.** Handing 0x200 the true keys is the only transition that can ever write a wrong value — it is what starts feeding bytes to `batt_temp_lo`/`batt_temp_hi` (0x200 is 20 Hz with deadband 0), and if the pack is really on the offset config those bytes are the 15 °C-shifted view. So it needs corroboration, in every state and not just when a long frame has already claimed the keys: a lone short 0x660 from some other transmitter on the same id must not be able to move the routing on its own. The other way needs none — a long 0x660 carries the true values itself, so acting on the first one is never wrong, and a reflash into the offset config still recovers within a second. Two frames is ~2 s at 1 Hz, well inside the wait window, so the cost is a second of extra silence in a log-on-change series. The one rough edge: if 0x660 only starts about 4 s after 0x200, the wait window can expire between the two short frames and log its "no 0x660 arrived" line just before they settle it. The routing that results is the same either way — only the wording of a one-shot log is briefly wrong.

### 0x660 b5-7 — the clamp instrumentation

They used to be a single 16-bit read of postprocessor slot `Output3` spanning b5-6, which answered a one-off question (a 1-byte result lands in the LOW byte of a 16-bit slot — confirmed 2026-08-02, word 0x000E with b3 = 29 °C). The unconditional-offset config that used that layout is retired; it broke charging. **Every config from 11 on declares b5, b6 and b7 as three separate 1-byte signals**, so the 16-bit decode would now silently pair two unrelated bytes: it reported 0x0202 on 2026-08-04 and was read as "the offset is not applied", when in fact diff = 2 and amount = 2 at a true 37 °C was the clamp working.

Read out of `15-bounded-clamp.bms` (`CANTX_Frame_10`, DLC 8):

```
clamp_gate   (b5, mem 2103) = the gate that decides which regime is in force.
               255 = closed, the clamp may subtract; 0 = open, the true
               temperature is going out untouched. Called `mask2` in the config,
               because it is an all-ones/all-zeroes byte ANDed over the amount.
clamp_amount (b6, mem 2087) = how much the clamp WOULD subtract, before the gate
batt_temp_hi_vcu_echo (b7, mem 2075) = the result the VCU is actually shown
```

and the identity that ties all three to b3, checkable from this frame alone:

```
batt_temp_hi_vcu_echo === batt_temp_hi − (clamp_amount & clamp_gate)
```

⚠️ **b6 is the PRE-gate amount, not "how much is being subtracted"** — that changed with config 15 even though the byte's address did not. At 55 °C and up the gate opens, so `clamp_amount` reads `(true − 35)` ≥ 20 while nothing at all is subtracted. The two only coincide while the gate is closed, which is every ordinary temperature. Under `11-full-conditional-offset` it is a flat 9 °C offset, and on 2026-08-04 that config's postprocessor line never ran at all, so b5 and b6 both read 0x00 through a whole DC charge while b7 carried the true temperature. So these two keys mean "whatever the live config feeds those slots"; **only b7 is the same quantity in every config that has ever sent a long 0x660.**

**The echo is not merely the same value as 0x200 b3, it is the same memory** (mem 2075, in configs 11 through 15 — verified against the decrypted XML), so a disagreement between the two means a repointing error in the config rather than a decode error. `pack-temperature.ts` watches for it and warns once per run.

#### ❌ Why b5 is decoded as the gate and not as `14-signbit-clamp`'s `clamp_diff`

**There is no reliable way to tell 14 from 15 apart at runtime, and this decoder does not try.** Both send 0x660 at DLC 8 with the same eight fields; only b5's source memory moved (2079 → 2103). Under 14, b5 was `true − 35` wrapped, which takes 255 at a true 34 °C and 0 at 35 °C — so a single frame at either of those temperatures is literally indistinguishable from a healthy config 15, and the two configs' visible behaviour only diverges above 54 °C.

**A per-frame discriminator does exist on paper** (config 14 predicts `b5 = (b3 − 35) mod 256`, config 15 predicts 255 below 55 °C and 0 above; those differ at every temperature except exactly 34 °C) **and it is deliberately NOT used. It is circular:** it assumes the postprocessor chain is healthy in order to decide what the byte means, and telling us the chain is NOT healthy is the entire reason this byte is on the bus. It would mislabel precisely the frames it exists to catch. A statistical "b5 has only ever been 0 or 255" test is worse — it converges slowly and a pack parked at 34 °C fakes it indefinitely.

So the honest answer is that **the operator declares the config by flashing it**, and this decoder is written for the config that is flashed. That is acceptable here, and would NOT be under `batt_temp_lo`/`batt_temp_hi`, for two reasons:

- b3/b4 are identical under both configs, so the true-temperature keys — the ones with years of history that `pack-temperature.ts` exists to protect — cannot be corrupted by getting this wrong. Only diagnostic instrumentation can.
- **Being wrong is recoverable rather than silent.** Config 14's b5 was exactly `(batt_temp_hi − 35) mod 256`, verified across all **198 same-timestamp pairs** in the ride log (true 28…55 °C, zero exceptions), so if this decode is applied to a bike still on 14 the rows can be reconstructed from `batt_temp_hi` in the same frame — nothing is destroyed. And it will not be quiet about it: `pack-temperature.ts` warns once on any b5 that is not a mask.

**`clamp_gate` is decoded UNSIGNED**, unlike the `clamp_diff` it replaces. 255 is a mask of all ones, not minus one; signing it would render the normal, healthy, everything-is-working state as "−1" on every chart and invite exactly the arithmetic (`gate − 1`, `gate + 35`) that the byte no longer supports.

#### What a bad `clamp_gate` means, in the order worth suspecting

0x660 b5 under `15-bounded-clamp` is a mask the postprocessor builds by dividing a byte by 128 and multiplying by 255, so **the only values it can hold are 255 and 0**. Anything else means the arithmetic is not doing what the config was written against, and — unlike the clamp itself — that is invisible from every other signal on the bus, because a wrong mask still produces a temperature that looks perfectly reasonable. Worth checking because b5 is the one byte whose meaning is not settled by the frame itself.

- **not 0 or 255** → the bike is almost certainly still on `14-signbit-clamp`, where this byte is `(true_hi − 35)` wrapped. Cheap to confirm: it will equal `batt_temp_hi − 35` exactly.
- **254 specifically** → the Divide operator rounds instead of truncating. Then the mask drops bit 0 of the amount and the reported temperature is up to 1 °C off — a ±1 °C error is the whole symptom, which is why it needs saying out loud rather than being left to be noticed.
- **0 while the pack sits in the clamped band** → the Divide operator is signed, so the gate never closes and the clamp never applies. Fails safe (the VCU sees the truth, and its 55 °C limp protection works), but the DC-charge derate relief the config exists for is simply not happening.

Only the third needs the temperature for context, and it uses a band that config 14 cannot produce: between the clamp floor and limp threshold, exclusive, 14's b5 is 1…19 and never 0. So that warning means "the gate failed to close", never "you are on the old config" — that is the first warning's job, and the two stay separable.

---

## 0x661 / 0x662-0x664 / 0x665 — the BMS extended frames

`src/can/decode-bms.ts`.

### 0x661 — high-resolution remaining energy + BMCU hour meter (1 Hz, DLC 6)

`bms_remaining_energy_wh` is the BMS's own figure in 1 Wh steps; `residual_energy_wh` from 0x10A is the VCU's, in 2 Wh steps. `bms_uptime_min` counts BMCU power-up minutes and is monotonic, so it doubles as an hour meter for the pack.

**Deliberately 6 bytes:** cells connected (mem 2034) used to sit in b6-7, but 0x205 already carries it. Two frames feeding one signal turns any disagreement into a value that flaps every frame instead of an obvious decode error, so the duplicate was removed from the config rather than given a second key.

**Unconfirmed:** the energy field read 0 Wh at 38 % SOC on 2026-08-02, five minutes after a BMS reboot. Most likely not yet computed that soon after boot.

### 0x662 / 0x663 / 0x664 — the per-module cell multiplex (20 Hz)

Each carries three, three and two of one module's cells, with the module number repeated in byte 0 of all three. **Every frame is decoded on its own and keyed off the LMU number in that SAME frame:** decoders are pure (no cross-frame state), and these are three separate messages, so the module can advance between 0x662 and 0x664.

**The multiplexing itself is confirmed by the manual** — from v6.11 the BMCU polls the LMUs one by one and overwrites mem [2129]-[2149] with each one's data, which is also why 20 Hz matters: the manual's recommended broadcast interval for the block is 50 ms, and sampling slower than the BMCU's poll silently skips modules.

The range check on byte 0 still earns its keep: if it ever came back static or out of range we would keep re-logging one module rather than smear its values across the others' keys.

⚠️ **KNOWN GAP (config-side, not a decode fault):** 0x662 samples all 11 modules evenly, but **0x663 and 0x664 never sampled LMU 1 or 2 across 499 frames each on 2026-08-02**, and the rest is heavily skewed. All three frames read the same mem 2129 at the same 20 Hz, so the fixed CAN transmit order is phase-locked to the BMCU's LMU poll. Consequence: cells 4-8 of LMU 1 and 2 were unobtainable, and it was a **systematic zero rather than sparse sampling** — a longer capture would not have filled it in. Keying every value off the LMU number in its own frame is what made this show up as missing data instead of as another module's cells being silently overwritten.

Fixed config-side in `6-custom-p32b-lmu-phase.bms` by slowing 0x663 to 150 ms and 0x664 to 250 ms so they no longer march in step with the poll. **No decoder change was needed, which is the whole point of keying off the in-frame module number.**

**The `lmu_cell_mux` selector is logged** so that "byte 0 isn't the LMU number after all" is distinguishable from "the frames never arrived": with no per-cell signals and no mux row, they never arrived; with a mux row and no cells, the selector is out of range and the assumption is wrong. The one shape the guard can't see is a **0-BASED selector** — modules 0…10 would drop module 0 and shift the rest onto the wrong keys, with healthy-looking cells. That is ruled out by measurement, not by the guard: the config-5 capture saw all eleven LMUs on 0x662, which a 0-based scheme could not produce.

It is also **the only signal written by three frames, and safe precisely because they all read the same memory (2129)** — unlike a duplicated measurement, they can't disagree in a way that would make the value flap.

### 0x665 — the cell limits the BMS is configured with (1 Hz)

So nothing downstream has to hardcode them. These four are **LITERAL CONSTANTS in the frame definition, not memory reads**: the CAN memory map is 82 entries of live measurements and command registers, and none of them exposes the configuration, so a constant is the only way to get the limits onto the bus. The frame is therefore **static by design — an unchanging value here is not a stuck signal** — and it goes stale if someone edits the limits in the Diagnostic Software without regenerating the frame.

Reading `cell_min_mv` (0x203) against `cell_cutoff_mv` gives "how close am I to cutting out", but **two things stop that from being a cliff edge**: `DischargeModeUnderVoltageCutOffTimer` is 60 s, so the minimum cell has to stay under the threshold for a full minute before the BMS opens the contactors; and `allowed_discharge_a` (0x202) is derated toward zero before the voltage limit is reached at all, which makes it both the earlier warning and the one signal here that can never go stale.

---

## 0x305 / 0x306 — the onboard AC charger

`src/can/decode.ts`. Present only while charging, at 5 Hz. 🟡 throughout.

- **0x305** — b1 ÷10 = mains A, b3-4 LE ÷10 = DC A, b5-6 LE ÷10 = DC V.
- **0x306** — b2 = mains voltage.

⚠️ **Neither appears during a DC fast charge at all** — a DC charger bypasses the onboard AC charger that sends them. So every `charge` signal fed from these reads "nothing happening" at a fast charger while 20 kW goes in. That is what the charge-manager group (0x605/0x610/0x615/0x620/0x625) exists to cover.

---

## 0x400 — the dashboard's own digital inputs

`src/can/decode.ts`. Byte 2 is a button bitfield; every other byte is either constant or a slow mode flag.

Measured over **1 099 357 frames across 14 candump captures** (2026-08-02 and 2026-08-04; see `CAPTURES.md`): b0 is `0x02` and b1 is `0x01` in every single frame, b3/b4/b6/b7 are `0x00` in every single frame, b5 only ever holds `0x00` or `0x80`, and b2 only ever holds `0x00`, `0x02` or `0x04`. So the whole frame carries four static bytes, one slow flag and this one button byte. ✅

⚠️ **The bit NAMES are Energica's, not ours:** they come from a free-frame IO table inside the service-tool executable (`obd-garage/HEATED_GRIPS.md` §3.0), and that table describes every model the tool serves rather than this one. **A name off a table is not a measurement** — the `charging` key on 0x102 b2 bit 0 came off a third-party table the same way and is really the high beam. So each bit carries what the captures show about it, separately, and the ones the captures cannot speak to say so.

**bit 0, `BUTTON [SET|BACK] (LeftBack)`.** ✅ SEEN AT LAST, 2026-08-19: eight presses at 18:31:51-53, 120-160 ms each, one payload (`02 01 01 00 00 00 00 00`) in 132 frames. Until that afternoon it had never been set in one frame of the 1.1 M, and was decoded on the vendor table's word alone. The bit is now real and is where the table said. **What is STILL the table's word is what it DOES:** the owner pressed "the button below the high beam flash" on the left pod, and a press parked produces nothing visible, so `SET|BACK` as a FUNCTION remains unverified — only the bit's existence and its pod position are measured.

**bit 1, cruise ON/OFF (right pod, front).** ✅ CONFIRMED by what it causes: pressed exactly twice in the corpus (2026-08-04 18:04:42.270 for 0.877 s at 88 km/h, and 19:45:47.924 for 0.920 s at 39 km/h) and **BOTH times 0x102 b3 bit 1** — the cruise-armed state — came up 0.53 s later and stayed up for the next 51 s / 82 s. A bit that only ever moves while riding and whose every press arms cruise control is the cruise button.

⚠️ **…which also kills the plan `HEATED_GRIPS.md` §9 recommends it for.** That section calls a short press inert because the owner's manual says activation needs a 3-second hold. **It does not:** both presses were under one second and both armed cruise. This is NOT a side-effect-free button.

**bit 2, cruise SET SPEED.** ✅ CONFIRMED by context: pressed exactly once in the corpus, 2026-08-04 18:04:45.055 for 1.794 s — 2.8 s after cruise was armed, at a steady 87.6 km/h, after which speed held 89-91 km/h for the remaining 45 s of the arming. That is what setting a cruise speed looks like, and there is no other press anywhere in 1.1 M frames to compete.

**bit 3, `BUTTON [HEATED.GRP] (RightBack)`.** ❓ Never set, which is **EXPECTED rather than evidence**: this bike has no heated grips, and the wiring diagram says the dashboard derives this bit by sensing +12 V on `Monitor_Heated Knobs` (J8 pin 5), a wire that currently goes nowhere. Decoded anyway because it is the readout for `HEATED_GRIPS.md` §7.0 — jumper J109a pin 1 to pin 3 and this is the signal that says whether the idea works.

---

## 0x410 — the Connectivity Hub's mirror

`src/can/gps.ts` (the GPS multiplex) and `src/can/hub-mirror.ts` (the diagnostics types).

**The hub echoes its own Bluetooth messages onto the VDB bus, byte-for-byte:** byte 0 is the message type and byte 1 the sub-index, exactly as on the notify characteristic. Confirmed in `obd-garage/captures/2026-08-02_bms_90s.log`, which carries `1A 00`/`1A 01`/`1A FE` (GPS), `02 00`…`02 FE` (vehicle status), `04 00`/`04 FE` (odometer) and `00 FF` (the handshake seed) on that id while the service held the link.

That makes it **a second, passive way to read anything the hub sends** — including a diagnostics list, which only appears once something has asked for it over Bluetooth. Useful precisely because it needs no BLE connection of its own: the hub accepts one at a time and the service already holds it, so `candump can0,410:7ff` is the way to watch a reply arrive without disturbing anything.

**Only the two diagnostics types are handled in `hub-mirror.ts`, on purpose.** Everything else on this id either duplicates a value already taken from the Bluetooth link or a broadcast frame — two sources for one signal can only disagree — or is the GPS multiplex, which `src/can/gps.ts` decodes off these same frames. So 0x410 is one id with two readers, and the id constant is `GPS_CAN_ID` over in `gps.ts` rather than being declared a second time; `src/index.ts` hands every 0x410 frame to both, which is why its dispatch deliberately does not return after calling the mirror.

✅ Framing and rate (~1.8 Hz unsolicited for the GPS multiplex) confirmed on the bus; the payload is all-zero in the garage, so the coordinates themselves are still BLE-verified only. (The old note that b4 here is a high-beam switch was reading one byte of this multiplex; 0x102 is the real lights frame and supersedes it.)

---

## 0x480 — E-LOCK / keyless status

`src/can/decode.ts`. 10 Hz, present key-on/parked. b2-5 LE uint32 = ID of the key fob currently present; it matches slot 1 of the 3 fobs paired in the E-LOCK ECU (b0 = 05, b6 = 01 constant). 🟡

**The one-shot "keys paired" read** lives in `src/can/elock.ts` (see `obd-garage/CAN_MAP.md` §E-LOCK). Plain KWP2000 over ISO-TP single frames: request on 0x791, response on 0x790. Byte 0 of every frame is the payload length, the rest is zero padding — e.g. `21 99` goes out as `02 21 99 00 00 00 00 00` and comes back as `02 61 03 …` (3 keys paired). The bare read is tried first; a diagnostic session is only opened (and then closed immediately) if the ECU won't answer without one.

⚠️ **This is the immobilizer ECU**, so that module is deliberately minimal:

- it runs **ONCE at startup**, never on a timer and never in a retry loop;
- the only services it may ever send are `0x21` (ReadDataByLocalIdentifier), `0x10 0x81` (start diagnostic session) and `0x20` (stop diagnostic session). **Nothing that writes, resets or runs a routine** (`0x2E` / `0x27` / `0x31` / `0x11` / `0x14` / `0x3B`) belongs there;
- it is fully non-fatal — a timeout or a negative response just skips the signal and logs a line. It never throws and never blocks app startup.

---

## 0x501 — `PSU_MONITOR`

`src/can/psu.ts`. The PSU / DC-DC converter's monitor frame at 10 Hz.

This was `CAN_MAP.md`'s "best remaining stimulus target" — _"four narrow channels with two constant separators"_. **There are no separators:** it is four little-endian 16-bit channels whose high bytes barely move, and Energica's `FramesDB.ParsePSU_MONITOR` names all four (the 2024 service-tool analysis in `obd-garage/`, §`0x501` `PSU_MONITOR`):

```
b0-1 LE u16  P_12V     the 12 V rail
b2-3 LE u16  P_12VLP   a second, lower rail
b4-5 LE u16  P_I12     12 V load current
b6-7 LE s16  P_TEMP    left undecoded
```

Re-derived from this bike's own 2026-08-02 garage lap on 2026-08-16 (4088 frames of 0x501).

✅ **`P_12V` is the one channel whose scale is nailed independently:** it read 12704 over the lap (range 12700-12764) against the bike's own engineering menu showing **12.78 V**. Millivolts, and that is what fixes the shape of the frame — a PSU monitor reporting one rail in mV is reporting all of them in the units its siblings imply.

✅ **`P_I12` IS the 12 V load current.** Every consumer that switched during the lap shows up as a step in the right direction and a sane size, measured by splitting the 0x501 frames on the matching 0x102 bit:

```
high beam (0x102 b0 bit6)   +1788 mA   (n = 13 on / 4075 off)
left blinker (b2 bit2)      +1030 mA   (n = 26)
brake light  (b2 bits 5/6)   +693 mA   (n = 140)
```

Three separate loads, three separate steps, all positive, all of a plausible size for LED lighting (21 W / 12 W / 8 W at 12.7 V). Nothing else in the frame does that.

🟡 **The mA SCALE, though, is inference** — the manufacturer's dictionary states units for only 120 of its 245 signals and this is not one of them. It rests on two things: the sibling rail in the same frame being proven millivolts, and the resulting wattages being right for this bike's lighting. A different constant would move all three steps together and still look plausible, so **a clamp meter on the 12 V feed is what would settle it**. The full-scale argument is worth having too: at mA a u16 tops out at 65.5 A, which is the right order for a motorcycle DC-DC; at 0.1 mA it would top out at 6.5 A, below the 10.56 A already measured.

❓ **`P_12VLP`** — millivolts by the same argument as `P_12V`, but it reads 9008-9055 mV, i.e. ~9.03 V, which is not 12 V whatever "LP" stands for. Logged because it is a direct read of PSU health and a rail that drifts is worth seeing; **do NOT read the name as a promise about what it feeds.** It is rock steady across the whole lap, so a real move in it means something.

⚠️ **`P_TEMP` (b6-7) is deliberately NOT decoded.** The service tool's dictionary equation for it is `f(x)=x*0.1 °C`; the field reads 3900-4000 raw with only five distinct values across 4088 frames, so that would be **390 °C**. It looks like an ADC count (×0.01 would give 39.0-40.0 °C, which is at least plausible, and 0x503 b4-5 sits in a 43-46 °C band correlating with it at r = +0.945) — but **"plausible" is not a decode, and a temperature is exactly the kind of number that gets believed.** Recorded so nobody implements the documented equation from the dictionary.

---

## OBD-II mode 03 / 07 / 0A — the transport, measured 2026-08-04

`src/can/obd-dtc.ts` drives the ISO-TP reassembler and answers a First Frame with flow control; decoding lives in `src/diagnostics/obd-dtc.ts` and reassembly in `src/can/iso-tp.ts`, both pure.

⚠️ **READ-ONLY BY CONSTRUCTION.** The only service bytes that module can put on the bus are 0x03, 0x07 and 0x0A — all three are "tell me what is wrong", none of them changes anything in an ECU, and `requestTroubleCodeList()` throws on anything else rather than trusting its caller. **Mode 04 (clear DTCs) is deliberately absent and must stay absent there:** it would erase the very history this exists to read, and on a bike whose stored list has been accumulating since before we started looking that is not recoverable. SecurityAccess (0x27) is likewise absent. Same standing rule as `src/can/elock.ts` keeps for the immobilizer ECU.

⚠️ Since 2026-08-16 Mode 04 does exist in the repository, in `src/vcu/service-actions.ts`, reachable only from service mode's write path. That changes nothing about the poller and the rule above is unchanged in the way that matters: **the poller runs unattended at 2 Hz while the bike is being ridden**, and a service that can erase diagnostic memory on a timer is a different thing from one an owner runs deliberately with the bike parked, behind a safety gate, an off-by-default switch and a two-tap confirmation. The distinction is between what runs by itself and what a person asks for — not between services.

### What the bus actually does

The request goes out functionally on 0x7DF; **the VCU answers on 0x7EF**, not the 0x7E8 a car would use. Mode 03's reply is 80 bytes, so it arrives as a First Frame plus eleven Consecutive Frames with a flow-control frame from us in between:

```
→  7DF  01 03 00 00 00 00 00 00     one payload byte: service 03
←  7EF  10 50 43 27 05 62 10 00     First Frame, 0x050 = 80 bytes to come
→  7E7  30 00 00 00 00 00 00 00     our flow control: send it all, no delay
←  7EF  21 10 03 05 14 C1 11 C1     … eleven of these, ~5 ms apart
```

⚠️ **THE FLOW-CONTROL FRAME DRAWS A SPURIOUS NEGATIVE RESPONSE, and misreading it is what made this look impossible.** Sent to 0x7E7 — the physical request address paired with the 0x7EF the VCU answers on — _something_ on the bus replies `03 7F 00 33`: a refusal of "service 0x00" with NRC 0x33 securityAccessDenied. **There is no service 0x00 and we never sent one**; it is an artefact of an ECU reading our flow-control frame as a request. It arrives whether or not the transfer then succeeds — transfers that completed produced it too. So a negative response naming a service we did not ask for is IGNORED rather than ending the wait. `obd-garage/CAN_MAP.md` recorded that NRC as mode 03 being locked behind SecurityAccess; **it never was**, and the note there is now dated and corrected.

⚠️ **THE TRANSFER IS NOT RELIABLE**, and the failure mode is always the same: the First Frame arrives, we answer it, and the Consecutive Frames never come. It is never a refusal and never a partial payload — **it is all 80 bytes or nothing.** Measured per-attempt success, sharing the bus with the 2 Hz mode-01 poller:

```
flow control → 0x7E7   2/8, 7/10, 7/10, and 4-5/12 across the latency sweep
flow control → 0x7DF   2/8, 5/10
no flow control        0/8, 0/5   ← so the flow control is genuinely required
```

Somewhere between **25 % and 70 % per attempt**, run to run, with no input of ours that reliably moves it. Deliberately not dressed up as better than that: three separate runs of ten-plus attempts disagree with each other, so retries are the only honest answer and `RETRY_ATTEMPTS` is sized for the low end.

**One input does measurably matter, in the bad direction.** Delaying the flow control on purpose gave 4/12 at 0 ms, 5/12 at 10 ms, 3/12 at 20 ms and 1/12 at 40 ms — so **the VCU's patience runs out fast, and NOTHING may sit between the First Frame and its answer.** The flow control is sent synchronously from the frame handler, before the frame is even decoded. Seen from the other side: a completed transfer had ZERO mode-01 replies interleaved and a failed one 50+, i.e. it finishes inside one gap in the poller's own traffic or it does not finish at all.

---

## The signal registry — deadbands, groups and row rates

`src/can/registry.ts`. Every row-rate figure here is **MEASURED**, by replaying the 2026-08-02 garage lap (409 s, 545 882 frames) through the same log-on-change rule `signals.ts` applies and counting what came out. Two caveats on reading them: that lap is mostly at a standstill, so a real ride writes more; and each frame's own rate is the hard ceiling (10 Hz = 36 000 rows/h).

**The 2026-08-16 batch cost 3820 rows over that lap — 33 700 rows/h of bike-on time**, against 64 100/h for the 224 signals already logged from the same capture. So that was a **~53 % increase** in the ride log's row rate while riding, for the 31 signals it added, and the three biggest contributors are the torque pair and the 12 V load current: between them they are more than half of it, and 0x100's fourteen flags are 14 rows in total. (0x0A0's six flags joined on 2026-08-19 and are NOT in that measurement; they cost ~52 rows a ride.) **That is the number to argue with if the SD card starts complaining**, and every deadband was chosen off a measured curve rather than a round number.

### ⚠️ The rule that makes a deadband on a 0/1 signal a silent bug

`signals.ts` logs when `Math.abs(value - lastLogged) > deadband`, so **a deadband of 1 on a 0/1 signal makes `|1 − 0| > 1` false and the signal is never logged again after its first sample** — silently, with no error, forever. That is why every flag in the registry carries none. It is enforced rather than merely intended: `scripts/check-can-decoders.ts` asks `bounds.js` which signals are gated to 0/1 and fails the build for any of them carrying a deadband.

The chatter a deadband would exist to tame does not exist for the buttons anyway: the busiest of those bits moved 141 times in twelve hours of capture. The shortest press measured is 30 ms and the median ~140 ms, against a 10 ms frame period, so every real press is sampled by at least three frames and both its edges are logged. What log-on-change cannot do is make a 30 ms press VISIBLE — see `public/lib/press.js`, which latches it for the display without touching the log.

### Measured deadband choices

**0x0A0 wheel speeds — 0.25 km/h**, rather than the 0.5 `speed_can_kmh` uses. They are the finer measurement (0.05625 km/h per count against 0.1 for 0x104) and the one a video overlay wants next to brake pressure, and 0.25 measured **1348 and 1163 rows/h against 3057 and 2802** at log-on-change — so the deadband is already doing most of the work available.

**`front_brake_pressure_bar` — none.** Whole bar, so log-on-change is one row per bar of change: 50 rows for the lap's braking, 441/h. Nothing to smooth, and a deadband of 1 would swallow every single-bar step, which on a 0-17 signal is most of it.

**`abs_warning_lamp` — none, and not a 1/0 flag.** At a deadband of 1 the logging rule would be **inconsistent** rather than merely silent (`|2 − 0| > 1` passes where `|1 − 0| > 1` does not), so a lamp stepping 0 → 1 → 2 would log some transitions and drop others. It moved ONCE in the whole lap, 2 rows, so there is nothing to tame anyway.

**0x127 throttle channels — none.** The frame is only 4 Hz (1330 and 1815 rows/h at log-on-change), and the whole reason to log both is to catch the two channels diverging, which is the P0120/P0121 fault. **A deadband is a filter on exactly the small persistent offset that fault looks like.**

**0x02C torque pair — 0.5 Nm**, the same deadband `motor_torque_nm` carries, deliberately: the BLE hub's torque and the inverter's own feedback are two paths to one quantity, and comparing them is only honest if they are logged at the same fidelity. Measured 6881 and 6872 rows/h against 14 537 and 15 982 at log-on-change. ⚠️ **The ceiling is the thing to watch before anyone tightens this** — 50 Hz across two signals is 360 000 rows/h if a ride ever keeps both moving continuously, where the BMS pair this borrows its reasoning from is 10 Hz.

**0x501 — all three channels need one** or they are the chattiest thing on the bus after the BMS cells (23 806, 30 846 and 34 872 rows/h at log-on-change, i.e. essentially the frame rate).

- **The two rails: 30 mV**, measured 2493 and 405 rows/h. ⚠️ There is a **cliff just past that** worth knowing about before anyone tunes it — the rails only moved 64 and 47 mV across the WHOLE lap, so a 50 mV deadband logs exactly one row each and then goes silent, and what these exist to catch is a rail sagging. 30 mV resolves a 0.24 % drift on a 12.7 V rail, which is early-warning territory; hundreds of millivolts is what an actually failing converter does, and either band sees that.
- **400 mA on the load current**, measured 2229 rows/h against 34 872 (250 mA would be 9110 — the cliff is between 300 and 400 here too). Sized against the **smallest load step actually identified** on this bike, the brake light at +693 mA: 400 is 58 % of it, so every switching event still crosses with margin while the 10 Hz measurement dither does not. The high beam (+1788 mA) and blinker (+1030 mA) clear it by 4.5× and 2.6×.

**`inst_consumption_wh` — 10 Wh.** Chattiest signal on the bus by far (~291 k rows/day at deadband 0.5, ~49 % of all rows) and not worth that fidelity — 10 Wh still tracks the curve on a ~200-330 Wh signal while cutting the row count by well over an order of magnitude.

**`bms_remaining_energy_wh` — 5 Wh.** 1 Wh out of a ~21 kWh pack is far below anything we can act on, and the frame arrives every second.

**`lmu_cell_mux` — 100**, which deliberately stops it after the first row per boot. It rotates at 20 Hz, so log-on-change would be ~1.7 M rows/day for a number that never carries new information once you've seen it move. ⚠️ **What keeps the rotation observable is the 5 s full-snapshot heartbeat in `ws.ts`**, which broadcasts `liveState` — `liveState` updates on every sample, but `notifyChange` sits inside the deadband branch, so the patch path never fires for this signal. **That heartbeat is load-bearing here: drop it as "redundant" and this becomes invisible.**

**The attitude pair — 1.0°**, replacing an old 100 counts which under the wrong scale was believed to be ~0.5 g and is really 10° — coarse enough to quantise a lean trace into three or four levels, which is what made the Grafana panel unreadable. The old comment's objection was row rate, so here is the measured answer: summing |Δ| across the rows already logged puts a 1.0° deadband at **≥ 161 000 rows for pitch and ≥ 6 600 for roll** over the seven days of ride log that exist; over that same window `throttle_pct` logged 1 038 747 rows, `speed_can_kmh` 828 304 and `inst_consumption_wh` 1 745 373. Those floors are floors — they cannot see the movement the old 10° deadband hid — but the headroom is an order of magnitude, and the instantaneous ceiling is still the 100 Hz frame rate. **Count a real ride's rows before tightening further.**

**0x0A0's six flags — free to log, and this is measured rather than assumed.** Three of the six have never been seen set in 565 376 captured frames, so they are one row each at boot and nothing after. The three that do fire do so in 162 frames total across 15 captures — 61 bursts of 1-17 frames, median 2, so a few hundred edges spread over many hours of riding. Against 33 700 rows/h that is nothing, and there is no deadband that could reduce it without hiding the whole signal.

### Units and groups that are load-bearing

**`clamp_gate` and `clamp_amount` carry NO unit on purpose, and for two different reasons.** `clamp_gate` is not a quantity at all, it is a byte of all ones or all zeroes. `clamp_amount` happens to be degrees under the current config but is a raw config-dependent slot — under `11-full-conditional-offset` it was a flag × 9. Tagging either "°C" would also opt it into `bounds.js`'s `BY_UNIT["°C"] = [-40, 200]` fallback, **which would reject 255 as a dead sensor and draw the healthy state as a fault.** Same treatment as `bms_post_processor_1` and the `iso_test_*` signals. Neither gets a deadband either: they are small integers whose whole purpose is to show the clamp's arithmetic, so smoothing would hide it.

**`clamp_gate` REPLACES `clamp_diff`**, which 206 rows have already shipped under (Aug 2026, `14-signbit-clamp`) meaning "true pack temp high − 35 °C, signed". It is **retired rather than repurposed**: −1 under the old meaning is a pack at 34 °C, and −1 is also what a signed read of a closed gate would say, so reusing the key would put two unrelated meanings in one series with nothing in the data to mark where one ends. Retiring it costs nothing, because `clamp_diff` was exactly `batt_temp_hi − 35` and always was — verified over all 198 same-timestamp pairs in the log, true 28…55 °C, no exceptions — so every old row can still be reconstructed from `batt_temp_hi`, which is in the same frame. The units and group of those rows live in the sealed log segments themselves (`scripts/decrypt-log.ts` prefers them over the registry), so dropping the entry does not orphan them.

**`batt_temp_hi_vcu_echo` keeps "°C"** — it is genuinely a temperature. Unlike the `pp_output3_raw` diagnostic it replaces, this is **permanent instrumentation**: it guards an invariant that can break on any future config edit, so there is no point at which it has "served its purpose" and can be retired.

**`fast_dc_contactor` must NOT get a unit.** "A" or "V" would opt it into `bounds.js`'s `BY_UNIT` fallback and there is no sensible range for a flag, while anything numeric-looking invites a Grafana panel to plot it against real amps.

**`eabs_event` / `tc_event` live in `controls`, not `drive`** — beside the ABS flags, which is where they belong twice over: they are the same kind of thing (a rider aid saying "I just acted"), and `controls` is a `BOOLEAN_GROUP` so `bounds.js` gates them to [0, 1] with no entry needed. Cheap despite 0x109 being 100 Hz, because they are events: `tc_event` is set in 1326 of 438 228 frames (0.3 %) and `eabs_event` in 26.

**The beam lamps moved group "charge" → "controls" with their meaning.** That is not cosmetic: `controls` is a `BOOLEAN_GROUP` in `public/lib/bounds.js`, so they now get the 0/1 plausibility gate that "charge" never applied to them. 🚨 They shipped as `charging` and `charge_port_unlocked` from the `.xdbc`'s word and rows already exist under both old keys. **The old rows are not garbage:** they are correct readings of these bits under a wrong name, so `grafana/dashboards/ride-summary.json` UNIONs the old key into each new lane and the history stays continuous, the same way the attitude rename did in #49. The attitude pair did the same — `accel_lateral_raw` / `accel_frontal_raw` keep their 15 455 rows, still correct but in units of 0.1° under a wrong name, and the Grafana panel reads old and new together, scaling the old ones by ÷10.

**The two `*SENS_FAIL` bits go in `diag`** beside the warning lamp they would light. The event and the two channel-active bits go in `controls`, next to `front_brake_pressure_bar` and the combined `brake` switch, because that is where you look when watching the brakes rather than hunting a fault — and `diag` is 170 signals deep with the generated `dtc_*` flags, which would bury them. **`abs_event` sits with `abs_rear_control_active` deliberately:** they fire in the same frame, always, and splitting them across two sections of the All tab would hide that.

⚠️ **`abs_rear_control_active` is NOT `rear_brake`**, and now that both are on the All tab the names are close enough to be worth separating explicitly. `rear_brake` (0x102 b2 0x40, `buttons` group) is the pedal switch — the rider's foot. `abs_rear_control_active` (0x0A0 b6 bit2) is the ABS module modulating the rear channel.

### The `buttons` group, and what the owner asked for

The buttons got their own group so the ALL view lists them together and the owner can press things and watch them move. `buttons` is registered in `public/lib/bounds.js`'s `BOOLEAN_GROUPS`, which gates them to 0/1.

The rest of the rider's controls joined on 2026-08-19, asked for by the owner: _"the buttons section should also get indicator and highbeam IMO, maybe also brake since that's technically a button?"_. **Nothing but the `group` field does this.** `views/all.js` picks the buttons section by `groupOf(key) === "buttons"` and nothing else, its header count is `groupKeys.length`, and `controls` and `buttons` are both `BOOLEAN_GROUPS` — so the 0/1 gate the moved keys already had is unchanged and the section reads "buttons · 13" on its own. None of these five is momentary, which the tile had to learn: see `public/lib/press.js` for the measured hold durations, the 1.46 Hz flasher, and why the answer is a clock reading rather than a list of held-state keys.

**`high_beam` is 0x102 b0 bit 6, the SWITCH** — not `high_beam_lamp`, which is b2 bit 0 and stays in `controls`. Two reasons for the switch over the lamp, given they agreed in all 1 103 000 frames ever captured and so cannot be told apart by measurement: a BUTTONS section should show the thing the rider's thumb moves, and this is also the bit `public/app.js`'s own three-flash tab gesture reads, so the tile shows exactly what the dashboard is reacting to. **The day they disagree is the day the bulb has failed, and having both keys is what makes that visible.**

**The blinkers are the LAMP outputs (b2 bits 2/3)**, which is deliberate: "is my indicator on" is a question about the lamp. They are the flashers `press.js` has to coalesce.

**`front_brake` and `rear_brake` are two keys because they are two circuits.** Merging them into one "brake" tile would hide which lever is being used, which is most of what there is to see. ⚠️ These are on the OUTPUT byte, so strictly they are the brake-light lines rather than lever switches — there is no lever-switch bit on b0 to prefer, and they track braking closely (front: 491 applications, median 2.24 s). The bar-valued `front_brake_pressure_bar` from 0x0A0 is the front circuit's analogue partner and stays in `controls`, where a number belongs: **a measurement in a grid of on/off tiles would read as a fault, not a feature.**

**`cruise_active` is a vehicle state, not a button**, so it goes with the other 0x102 state bits in `controls` rather than in `buttons`.

⚠️ **One loose end, deliberately left:** `db.ts` writes the `signal` table with `ON CONFLICT(key) DO NOTHING`, so `rides.db` keeps `grp = 'controls'` for the three moved keys forever. The live dashboard reads the group off the registry and is right immediately; `grafana/dashboards/explore.json` reads `signal.grp` and will keep filing them under controls. That is cosmetic there, and fixing it means an UPDATE against the owner's live database.

### ⚠️ The ABS flags are LOG-FIRST — do not rely on the All tab's flash

A typical intervention is 1-2 frames, 100-200 ms (median 2 frames over 61 bursts; the longest in the archive is 17 frames / 1.6 s), which is at the edge of what a person notices — the same problem `public/lib/press.js` was written for, and it chose a 600 ms latch because ~200 ms is roughly the threshold. `controls` gets the plain `RawTile`, which renders the live value with no latch, so on screen an intervention is a brief flip to 1 and back. **The RIDE LOG is unaffected:** no deadband, so both edges are sealed, and that is where an intervention is meant to be read from.

Deliberately not fixed rather than overlooked, and the shape of the fix is known: `views/all.js` picks its latching tile by `groupOf(key) === BUTTON_GROUP` and `press.js`'s derive tracks that one group, so the change is to generalise that switch from a single group to a per-key momentary SET, and add these two to it. **Moving them into `buttons` instead would be wrong** — nothing presses an ABS intervention, and that tile's whole vocabulary is "PRESSED", "3 presses", "held for". A separate momentary path in `views/all.js` would be worse still.

---

## `STREAM_IDS` — the kernel RX filter list

`src/can/decode.ts`. CAN ids decoded from the broadcast stream, used to set the kernel RX filters, **so an id missing here never reaches `decodeFrame` at all, however good its decoder is.**

⚠️ **This list is the single easiest thing in the project to get silently wrong**, because a missing entry has no symptom: the decoder is fine, the tests pass, and the signal simply never appears. **It has already happened once** — 0x400 was being dropped while a decoder waited for it. `scripts/check-can-decoders.ts` now closes that hole from the other side: it probes `decodeFrame` across the whole 11-bit id space and fails the build if any id that answers is missing from `STREAM_IDS`. Add a decoder without adding it there and `npm test` says so.

**The charge-manager group is routed off an exported id list rather than five `case` labels**, which a switch cannot do with a computed set. That is deliberate: the same list sets the RX filter, so a sixth id added to the module reaches the filter AND the decoder together. Spelling the ids out twice would let them drift, and it would drift silently in the direction this repo has already been bitten by — the check's probe is one-directional on purpose, so an id in `STREAM_IDS` with no decoder never goes red. Four of the five are silent unless a charge cable is live; 0x625 is the exception and broadcasts whenever the bike is awake, which is why it was mis-filed for so long as an unrelated always-on frame.

**0x121 joined on 2026-08-19 and is the one entry that is NOT periodic.** It fires when the rider moves the charge-current dial and never otherwise, so it costs nothing to filter in — 298 frames of it in the entire 16 GB archive, of which 18 are the DC limit changes. **It also cannot be found by watching for a while**, which is why it sat unfiltered for so long: the note it replaced said "neither appeared in 40 s of live capture (parked, unplugged), so there is nothing yet to decode", and that was true and permanently unfixable by looking harder. You have to be changing the current while capturing. 0x120, its truncated request twin, stays out — it carries no ceiling, and it is the id this project transmits the RTC sync on.

**0x400 joined on 2026-08-16 and is the one entry that costs something.** It is the highest-frame-rate id on this bus and it carries almost no information: **its payload changed six times in 1 099 357 frames.** Worse, the rate is padding — every one of the 77 355 sub-7 ms gaps measured in one capture repeated the previous frame's eight bytes EXACTLY, with no exceptions, and the frame count per second swings between 0.8× and 1.2× of 0x102's steady 100 Hz depending on what the dashboard is doing (80 Hz through the DC charge, ~120 Hz while riding). So this buys ~100 RX wakeups a second on a Pi Zero for a button byte, plus four `record()` calls per frame. It is worth it only because the buttons cannot be read any other way, and log-on-change means an unpressed button still writes exactly one row per boot.

🚨 **If that ever does show up on the Pi, the obvious lever — skip a frame whose payload is identical to the last one seen for that id — is a trap**, so it is written down here rather than discovered the expensive way. `record()` is what refreshes `liveState[key].ts` and `lastSeenMonotonic`, and it is deliberately outside the deadband branch for exactly that reason. Skip the repeats and a button that nobody is pressing stops being refreshed: the dashboard greys its tile out as stale and `ageMs()` reports it as missing, **on a bike where "this signal stopped arriving" is a real diagnosis we do not want to fake.**

---

## Sources, and how much each is worth

Three sources feed `src/can/`, and they are not equal:

1. **This bike's own captures** — the only thing that CONFIRMS anything. Replayed through the real decoder before a signal is wired up.
2. **Energica's own material** — `FramesDB` handlers, the telemetry-scaling table, the VCU digital list, the free-frame IO table (all via the 2024 service-tool analysis in `obd-garage/`). Names and equations, describing every model the tool serves rather than this one. A name off a table is not a measurement.
3. **Another rider's `energica_can_mappings.xdbc`**, which joined 2026-08-02 and names 0x020, 0x022, 0x104 and most of 0x102's bitfield. **One owner's reverse engineering of a different bike, not a manufacturer document.** Nothing from it is wired up without a live capture replayed through the decoder first, and where it contradicts something measured on this bike, ours wins.

🚨 **The `.xdbc` has been caught twice**, which is why the rule above is a rule: it called the high beam `charging` (1 103 000 / 1 103 000 frames say otherwise), and it called 0x109 b6-7 a current that reads 5069 A. It also has the blinker bits and the indicator-switch sides the wrong way round. **Do not "fix" a measured decode from the third-party file.**

**Decoders stay pure** — bytes in, values out, no I/O, no clock reads, no cross-frame state — which is what makes them testable by replaying a capture when the bike is out of reach. Two frames cannot be stateless and neither keeps its state in `decode.ts`: 0x410, where a GPS fix spans three sub-frames (`gps.ts`), and 0x102's attitude pair, whose out-of-range warning fires once per axis per process rather than at the frame rate (`attitude.ts`). Each exports a reset so replaying a second capture starts clean.
