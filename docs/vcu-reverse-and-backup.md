# `REVERSE_*` and `BACKUP_MODE_TRQ`: what they do, and why reverse ran out of torque on 2026-09-13

Written 2026-09-13 after the owner reported: _"when being in R gear there was too little torque at one point and I couldn't get over an asphalt thing."_ The episode is in the ride log and is reconstructed in §3. The short version is that the bike did exactly what it was configured to do, that the configuration is worth about a one-centimetre lip, and that the parameter storing that number may not be the copy the bike obeys — which is §4, and is the part that decides whether raising it is worth doing.

Sources, and what was actually opened, are listed in §9. Where a claim is measured it says so; where it is inferred it says that instead.

## 1. The four parameters

All four are `WORD S` (signed 16-bit) served by the **A9** micro, addressed `CID = 0x1000 | index`, and all four sit under a `[DRIVE_BY_WIRE]` heading in `src/vcu/param-file.ts` — 67-69 under the first one (line 193), 149 under the second (line 277), between `HALL_THROTTLE_ZERO_TH` (148) and `DBW_CONFIG_2` (150).

| index | CID | name | this bike | meaning | unit |
| --- | --- | --- | --- | --- | --- |
| 67 | `0x1043` | `REVERSE_TORQUE_LIMIT` | 600 | torque ceiling in park assist | **60.0 Nm** (0.1 Nm/count) |
| 68 | `0x1044` | `REVERSE_TORQUE_SLEWRATE_LIMIT` | 200 | how fast that torque may rise | **200 Nm/s** (1 count = 1 Nm/s) |
| 69 | `0x1045` | `REVERSE_MAX_SPD` | 45 | speed ceiling in park assist | **4.5 km/h** (0.1 km/h/count) — see §2.3 |
| 149 | `0x1095` | `BACKUP_MODE_TRQ` | 250 | torque ceiling in the degraded-throttle fallback | **25.0 Nm** |

**Where "this bike" comes from, and its date.** `obd-garage/kwp_scan_raw.txt`, the A9 dump of 2026-06-14, reads `A9 B1 0043 2 0258`, `0044 2 00c8`, `0045 2 002d`, `0095 2 00fa` → 600, 200, 45, 250. That dump is three months old. What dates the values to the incident is the log itself: a 599-count ceiling at 16:07 on 2026-09-13 (§3) says index 67 still held 600 at that moment.

**There is no factory default for any of them.** `params.ecf` is not a defaults table — `src/vcu/param-file.ts:10-13` is blunt that its values "are NOT any particular bike's" and "must never be rendered as a reading". It happens to carry the same four values this bike reads, which is worth noting and is not the same as a factory default. Nothing else on disk states one.

**Table identity.** This bike runs table **16407**, whose only delta from `params.ecf`'s 16406 is index 249 `R_BRAKE_POPUP` (`src/vcu/table-catalog.data.ts`). Indices 67-69 and 149 are untouched by that delta, so the names above are this bike's names.

## 2. The units, and how well each is established

### 2.1 Torque: 0.1 Nm per count ✅

Energica states the scale for the torque _telemetry_, in `EMsuite/2021-version/files/em_telemetry_scaling.csv`, header `id,name,unit,equation,datatype`:

```
93,V_TRQ_CMD,Nm,f(x)=x*0.1,int16_t
94,D_TRQ_CMD,Nm,f(x)=x*0.1,int16_t
95,D_TRQ_FEED,Nm,f(x)=x*0.1,int16_t
```

⚠️ That file scales telemetry, not EEPROM records. Applying it to the _parameters_ is an inference — a well-supported one, since `docs/vcu-parameters.md` §5 already makes it for `TORQUE_LIMIT` and `REGEN_TORQUE_LIMIT`, Energica's factory options write 2000/2150 into `MAP1_TORQUE` for a platform published at 200/215 Nm, and §3 below measures a 59.9 Nm plateau against a stored 600. Three independent things agreeing is why this is marked ✅ rather than 🟡, but it is agreement, not a statement about parameters.

The firmware is consistent with it and adds nothing: A9 works in raw counts throughout, with no ×0.1 anywhere, so 0.1 Nm is a display convention rather than something the code knows.

### 2.2 Slew rate: 1 count = 1 Nm/s ✅

In park assist the torque command's rate of change is limited. The per-frame step (CAN `0x02C` arrives every 20 ms) piles up on **+4.0 Nm** rising and **−2.0 Nm** falling, i.e. **+200 / −100 Nm/s**, against ordinary riding above 30 km/h where the same signal moves at up to **+4170 / −3245 Nm/s**. The contrast is the first finding: this limiter belongs to the park-assist path.

⚠️ On the wire alone that is a _mode_, not a hard wall — of 232 up-steps between rows exactly 20 ms apart, 3 exceed +4.0 (max +4.5); widening to 19-21 ms gives 6 above, to +6.5. So the wire on its own cannot pin a unit, and an earlier draft of this document withdrew the claim for exactly that reason.

**The firmware settles it, and the argument is the asymmetry.** In §4's block, the up limit is `REVERSE_TORQUE_SLEWRATE_LIMIT × 10000` (`0x2A744`: `movw r1, #0x2710`; `0x2A748`: `muls`) = **2 000 000** at 200 counts. The down limit is the literal **−1 000 000**, loaded at `0x2A844` (`=0xFFF0BDC0`) and passed through the identical helper and the identical `/100` reciprocal (`0x51EB851F`). Ratio exactly **2 : 1**. Measured on the wire, independently and before any of this was disassembled: up ≈ +200 Nm/s, down exactly −100 Nm/s. **Also 2 : 1** — and the down side carries no calibration at all, because it is a constant in the code.

So the internal unit is 10 000 per Nm/s, `−1 000 000` is −100 Nm/s, and `200 × 10 000` is +200 Nm/s: **one count of `REVERSE_TORQUE_SLEWRATE_LIMIT` is one Nm/s**, equivalently 0.1 Nm per 100 ms. That is anchored on a hard-coded constant rather than on a 1:1 numeric coincidence.

The falling mode is the clean one on the wire too: 166 of 529 down-steps land on exactly −2.0 Nm, and the ladder is visible unbroken in the log — 34.7, 32.7, 30.7, 28.7, 26.7, … each 20 ms apart.

### 2.3 `REVERSE_MAX_SPD`: 0.1 km/h per count 🟡

The A9 firmware **clamps this parameter to 20…275 before use** and takes its absolute value, direction being carried in the sign (`0x2A488`, `0x2B58C`). A 20…275 window reads naturally as **2.0…27.5 km/h at 0.1 km/h per count**, making 45 = **4.5 km/h**. Medium confidence: it comes from the clamp bounds, not from a statement or from an observed comparison.

⚠️ **Do not conclude that 45 never binds.** Reverse tops out at about **2.9 km/h** every single time in the log, which is what a governor looks like rather than evidence against one — and the command visibly backs off as the bike rolls: at 16:07:09.45, at 2.1 km/h with the throttle still at 98.8 %, the command _falls_ 51.8 → 50.7 → 48.2 → 44.0 Nm over 60 ms. Whether that fade is `REVERSE_MAX_SPD` acting below its limit is **open**. What §3 does establish is narrower and is enough for the incident: at 0.3 km/h nothing speed-shaped can be clipping 599 counts.

## 3. The episode, 2026-09-13 16:07:09-16:07:20 Z

Reconstructed from `cool-eva-2026-09-13.celog` decrypted to a scratch DB: 39 258 150 readings, 21 255 segments, 63 unreadable (62 bad-magic resyncs plus one GCM failure at byte 81 211 736 — a `/dl` blob is cumulative, so these are the same 63 an earlier lane reported).

**The park-assist classifier, stated because the alternative is circular:** episodes are selected as `throttle_pct ≥ 99 % while speed_can_kmh ≤ 3 km/h for ≥ 300 ms`, forward-filled. It never mentions torque, so "the ceiling is 60 Nm" is a result rather than a restatement of the selection. ⚠️ `reverse_gear` is deliberately not used — §5 of `docs/can-decode-findings.md` and issue #216 explain why it cannot carry this weight.

What happened, at 200 ms resolution:

| t (16:07)  | throttle % | torque cmd Nm | km/h | rpm |
| ---------- | ---------- | ------------- | ---- | --- |
| :13.4      | 74.1       | 41.1          | 0.2  | 0   |
| :13.8      | 90.6       | 52.7          | 0.2  | 0   |
| :14.2      | **100.0**  | 58.6          | 0.2  | 0   |
| :14.4-15.2 | **100.0**  | 58.0          | 0.2  | 0   |
| :16.8      | **100.0**  | 59.7          | 0.2  | 0   |
| :18.0-18.8 | 99.5       | **59.9**      | 0.3  | 12  |
| :19.2      | 1.8        | 36.7          | 0.3  | 12  |
| :19.8-20.4 | **100.0**  | 59.8          | 0.3  | 12  |

Six or seven separate attempts above 54 Nm in nine seconds, each one pinned at the same ceiling, the bike never exceeding 0.3 km/h. **`REVERSE_TORQUE_LIMIT = 600` is what stopped the bike**, measured, not inferred.

⚠️ 59.9 rather than 60.0 because `drive_torque_cmd_nm` carries `deadband: 0.5` (`src/can/registry.ts:767`): the plateau is a logged sample with up to half a Nm of unlogged headroom above it, so this pins the ceiling to 600 counts only to within ±0.5 Nm.

### Three things that were NOT the constraint

- **Not the motor, not pack current, not traction.** `drive_torque_feedback_nm` tracks the command through the whole plateau — 59.6, 60.6, 59.6, 60.2, 60.3, 60.4, 59.7, 60.3 against a 59.9 command. The drivetrain delivered everything it was asked for. The binding constraint is the **command**.
- **Not "low speed" in general.** In ordinary forward riding below 3 km/h the command reaches **175.6 Nm at only 84.4 % throttle** (2026-09-09 07:44:38 Z). Three times the park-assist ceiling at a fifth less throttle, so the ceiling belongs to the _path_, not to the speed.
- **Not backup mode.** That caps at 25.0 Nm (§5) and the bike was making 59.9.

⚠️ 600 counts does not identify index 67 _by value alone_: `REGEN_TORQUE_LIMIT` (49) is also 600 on this bike, raised from 500 on 2026-08-09. The sign settles it — the command was **+**59.9 Nm, and regen is negative.

### The ceiling never moved, in 25 days of data

Screened across the whole decrypted history, every full-throttle park-assist episode peaks between **58.5 and 59.9 Nm**, with **zero** above 60.5. ⚠️ "Whole history" is 25 days, not the whole log: `drive_torque_cmd_nm`'s first row is 2026-08-19, while throttle and speed go back to 2026-08-02, so nothing can be said about the fortnight before the `0x02C` decode landed.

## 4. What the firmware does with these numbers

The owner raised `REVERSE_TORQUE_LIMIT` to **750** through the dashboard's `/vcu-write` and rebooted the bike, and still could not climb the lip. Two VCU firmware images were disassembled to find out why (ARM Cortex-M, Thumb-2, load base `0x8100`).

**A9's parameter table is at `0x00034A94`** — 20-byte entries, EEPROM offset at +0x02, storage type at +0x04, RAM shadow at +0x0C, parameter index at +0x12. Index 67 → EEPROM `0x023E`, shadow `0x200011F6`, working global `0x2000032A`; index 68 → global `0x2000032C`. Verified independently against eight checkpoint indices. That `vcu_control.bin` is the A9 image and not the A8 one is checkable rather than assumed: its table holds 233 entries, none of them an A8 index, with 233/233 storage-width agreement against `params.ecf`.

⚠️ **An earlier draft of this document claimed that A9 never uses these parameters and that enforcement must be downstream. That was wrong, and it was wrong because the tool used to find it followed only PC-relative literal loads and stopped at the first store.** The A9 image contains the reverse torque law in one contiguous block at **`0x2A6EC`-`0x2A850`**, and it consumes all of `REVERSE_TORQUE_LIMIT`, `REVERSE_TORQUE_SLEWRATE_LIMIT` and the demand. Disassembled and read:

```
0002a6ec  ldr     r0, [pc, …]      ; =0x2000032A   REVERSE_TORQUE_LIMIT
0002a6ee  ldrsh.w r1, [r0]
0002a6f4  str.w   r1, [r0, #0x460]
0002a6f8  ldr     r0, [pc, …]      ; =0x2000032C   REVERSE_TORQUE_SLEWRATE_LIMIT
0002a700  str.w   r1, [r0, #0x464]
…
0002a740  ldr.w   r0, [r0, #0x464] ; the slew rate back out
0002a744  movw    r1, #0x2710      ; 10000
0002a748  muls    r0, r1, r0       ; -> 2 000 000 at 200 counts
0002a774  bl      #0x33cc6         ; (r2 = 7)
0002a77a  ldr     r1, [pc, …]      ; =0x51EB851F   the /100 reciprocal
0002a784  str.w   r0, [r1, #0x478] ; -> the per-tick step limit
…
0002a78e  ldr.w   r0, [r0, #0x460] ; REVERSE_TORQUE_LIMIT
0002a796  ldrsh.w r1, [r0, #0x7a6] ; a second copy
0002a7a0  cmp     r0, r1
0002a7a2  bge     #0x2a7a8         ; -> [+0x47c] = min(the two)
0002a7bc  mov.w   r1, #0x3e8       ; 1000
0002a7c6…7ea                       ; -> [+0x480] = clamp(factor, 0, 1000)
0002a7fa  muls    r0, r1, r0       ; [+0x484] = min(RTL, RTL') x clamp(factor, 0, 1000)
…
0002a812  ldr.w   r1, [r0, #0x484] ; target
0002a816  ldr.w   r0, [r0, #0x488] ; current
0002a81a  subs    r1, r1, r0       ; error
0002a826  ldr.w   r0, [r0, #0x478] ; the slew-derived step limit
0002a82a  cmp     r1, r0           ; the rate limiter measured in §2.2
0002a844  ldr     r0, [pc, …]      ; =0xFFF0BDC0 = -1 000 000, the DOWN limit
```

So: **raising index 67 does reach the torque law.** The demand is scaled by `REVERSE_TORQUE_LIMIT` and then rate-limited by a step computed from `REVERSE_TORQUE_SLEWRATE_LIMIT`, all inside A9, in the micro that stores them.

🟡 **Open, and deliberately not over-claimed: whether `REVERSE_TORQUE_LIMIT` acts as a gain or as a ceiling.** The multiply at `0x2A7FA` reads as a gain — a demand between 0 and 1000 scaled by the limit — rather than a `min` against a ceiling, and the 75 non-rate-limited park-assist samples in the log cannot separate the two (residual sd 3.17 Nm). It matters little for the recommendation, because at full throttle both readings put the ceiling at the parameter's value, which is what §3 measured. It matters for _partial_ throttle, where a gain would scale the whole range and a ceiling would only clip the top. **The experiment that settles it:** a slow, deliberate throttle ramp in park assist against a fixed resistance, logged — a gain bends the whole curve, a ceiling only flattens its top.

🟡 Also not established: that this block is what executes in the reverse path. It exists, it reads those parameters, and the behaviour it implements is the behaviour §2.2 and §3 measured on the wire — but no reachability proof was attempted.

⚠️ **The images may not be the build running in this bike.** They are Energica's shipped files and nothing has confirmed they match what is flashed. `0x1A ReadEcuIdentification` is observed working on these micros (`obd-garage/DIAG_ADDRESSES.md` §9) and would settle it in one read.

### The inverter is not the enforcing copy

Checked because it was the leading hypothesis while §4 was wrong, and recorded so nobody re-runs it. `PRE-EMCE Configuration_Inverter_FW6701_rev3` — both the folder and its `.zip`, unzipped to scratch, originals untouched — contains an upgrade-instructions PDF, the C2Prog programming tool, one RMS firmware `.hex`, and two 96-line parameter files. **Those parameter files carry no reverse torque limit, no reverse speed limit and no backup torque.** A case-insensitive grep of the entire unzipped tree for `revers|backup|park` returns **zero hits**. What they do carry is the inverter's own ceilings — `Motor_Torque_Limit_EEPROM_(Nm)_x_10 = 2300`, `Regen_Torque_Limit = 900`, `Braking_Torque_Limit = 900`, `Torque_Rate_Limit_EEPROM_(Nm)_x_10 = 75`, `Max_Speed_EEPROM_(RPM) = 11000` — none of which is 600, and the 2300 matching the VCU's `TORQUE_LIMIT = 2300` is a useful independent corroboration of the Nm×10 convention.

⚠️ And it would not be this bike's inverter in any case: the folder is **PRE-**EMCE, and the owner has confirmed he runs the **EMCE**. It is cited in this document for the Nm×10 convention only, never as this bike's configuration.

## 5. Backup mode

`BACKUP_MODE_TRQ` is real control, not a placeholder. At A9 `0x29D18`:

```
r0 = [0x2000271E+0x32]        ; a torque demand
r1 = BACKUP_MODE_TRQ (= 250)  ; 25.0 Nm
result = min(r0, r1)          ; cmp / bge selects the smaller
```

So backup mode caps a torque demand at **min(demand, 25.0 Nm)**, gated by a flag.

**What turns it on.** The enable flag is driven at `0x23BB8` from a 2-bit state field in `[0x20002380+0x24C]` bits 16-17, and the transition is gated on `[0x200026C0+0x3E] == -1` — a sensor reading sitting at the **−1 invalid sentinel**, in the input/sensor struct whose throttle sits at +0x1C. That is the degraded-throttle-fallback shape: a throttle channel reads invalid, and the bike keeps moving at 25 Nm. 🟡 Confirmed in shape; the exact sensor is not pinned.

**What it caps.** `DBW_CONFIG_2` bit 0 selects between two torque sources at `0x26F80` and the chosen one is what gets capped.

⚠️ Energica's own material says **nothing** about backup mode. "backup" appears in none of `em_fault_codes.csv`, `em_parameter_dictionary.csv`, the Ribelle owner manual, the Ribelle workshop manual, or any file in the `VCU/firmware` folder. Everything in this section comes from the binary.

It did not act on 2026-09-13 — the bike made 59.9 Nm, not 25.0. It is in this document because it is the one mechanism able to make a raised `REVERSE_TORQUE_LIMIT` irrelevant: if backup mode ever engages, **every value above 250 is moot**.

## 6. The recommendation

### What the numbers buy

Taking the reduction as **4.997** and the rear rolling radius as **0.3156 m** — ⚠️ both from `docs/can-decode-findings.md:347`, which carries an explicit **❓ NOT SETTLED** about where the driveline's 3.5 % over-read lives, and where the 1983 mm circumference is `SPEED_ODO_REARWHEEL_C`, an **A8 `otherBikeValue` that has never been read from this bike** (there is no A8 dump; read index 254 next time it is awake) — and assuming 370 kg of bike, rider and luggage:

| index 67            | torque      | thrust    | grade it holds | rigid step it clears |
| ------------------- | ----------- | --------- | -------------- | -------------------- |
| 250 (backup mode)   | 25.0 Nm     | 396 N     | 11 %           | ~0.2 cm              |
| **600 (today)**     | **60.0 Nm** | **950 N** | **26 %**       | **~1.0 cm**          |
| 750 (already tried) | 75.0 Nm     | 1187 N    | 33 %           | ~1.6 cm              |
| 900                 | 90.0 Nm     | 1425 N    | 39 %           | ~2.2 cm              |
| 1100                | 110.0 Nm    | 1742 N    | 48 %           | ~3.1 cm              |

⚠️ The step column is a rigid-step model, `F/W = √(2Rh − h²)/(R − h)`, with all the weight on the driven wheel and no help from rocking the bike or from momentum. It is a guide to the order of magnitude, not a prediction. Thrust ignores rolling resistance and driveline loss, so it is an upper bound. But the shape of the answer survives all of that: **the factory setting is worth about a centimetre, and 750 was worth about a centimetre and a half.** An asphalt lip that stops a motorcycle is usually two to three, which needs 900-1100 counts. That is the honest reason 750 did not help, and it is a different reason from "the write failed".

### The exact write, if one is made

```
parameter  REVERSE_TORQUE_LIMIT
index      67
CID        0x1043          (bank 1, 0x1000 | 67)
micro      A9
storage    WORD S          (two bytes, two's complement)
table      16407
from       600   (60.0 Nm)
to         900   (90.0 Nm)      — see the reasoning below
```

**900, not 1100.** 900 is +50 % on today's value, the same step `REGEN_TORQUE_LIMIT` already took on this bike, and it is the smallest number with a plausible chance of clearing a real lip. 1100 clears more and is an 83 % increase on a limit whose entire job is to stop the bike climbing out of a walking rider's hands. Start at 900, confirm it takes and that the plateau moves, and only then consider more.

**This is expected to work.** §4 finds the torque law inside A9, reading this parameter — so a write to index 67 reaches the arithmetic that produced the 59.9 Nm plateau. That is a change from an earlier draft, which had it enforced somewhere unreachable; the correction is in §4.

⚠️ **Then why did 750 not help?** On the arithmetic above, 750 buys about 1.6 cm of step against 600's 1.0 cm — a real improvement and still short of an asphalt lip that stops a motorcycle. The log cannot say whether the bike was even running 750 at the time, because the ceiling was never approached again at full throttle (§8). Both explanations are live, and one read-back separates them.

**No write is made by this repo.**

### The risks, which are not theoretical

- ⚠️ **Park assist is the mode where a person is walking beside 280 kg of motorcycle, often on a slope, often with one hand on the bars.** This limit exists so the bike cannot climb out of your grip. 90 Nm is 1425 N at the contact patch — around 145 kgf, comfortably more than a person can hold against.
- ⚠️ **The slew rate is unchanged**, so torque still arrives at ~200 Nm/s; a raised ceiling means it arrives at a higher value in the same time.
- ⚠️ **Reverse is used blind, looking over a shoulder, usually with the front wheel pointed somewhere.** More thrust over a lip is also more thrust when the wheel finally frees.
- A dealer visit reverts it: the service tool reinstalls parameter values from Energica's server, keyed by VIN.

## 7. Which allowlist it would have to join

⚠️ **The premise of the question has moved, and the issue that asked it predates the change.** Since `dab0f70` (#104, 2026-08-21) the five researched parameters are no longer the only writable ones. `writeTargets()` (`src/vcu/write-targets.ts:304-326`) returns `[...CURATED_WRITE_TARGETS, ...generated]`, generating a target for every uniquely-named row of the bike's table, and `planWrite()` resolves through `writeTargetNamed()` over that whole list. **`REVERSE_TORQUE_LIMIT` is already writable today** — which is how the 750 was written — at the datatype's full range, **−32768…32767**, carrying the four "⚠️ NOT researched" warnings.

The per-parameter table gate did run: `write-runner.ts:635` calls `writeTargetProblemIn` for every named target, curated or generated. Only `allowlistProblemsIn` is curated-only, for the reason its own comment gives.

So the list it would join is **`CURATED_WRITE_TARGETS`** — today `MAX_DC_CHG_CURRENT`, `FCHG_CURRENT_GAIN`, `TORQUE_LIMIT`, `REGEN_TORQUE_LIMIT`, `VSM_CONFIG_1` — and promotion would buy **no reachability at all**. What it would add is `min`/`max`, `warnings` and `verify`. Of those, `verify` would have to be `null`: nothing broadcasts index 67, unlike `MAX_DC_CHG_CURRENT` whose entry leans on `0x625` b2. And `min`/`max` are precisely the numbers §4 says are unknown.

**Recommendation: do not promote it yet.** A curated entry whose bounds are defended with "we guessed" is worse than no entry, and `docs/vcu-parameters.md` §5 calls that friction the point of the file. Promote it once §8's test says whether the VCU's copy is the operative one — at which point the bound has a reason behind it.

## 8. What is open, and the one test that closes most of it

**The state of the 750 write: UNVERIFIED.** The owner wrote it through `/vcu-write` and rebooted. The ride log cannot confirm it, and it now says exactly why rather than leaving it open: across all 47 low-speed torque windows in every session after the stall, **the throttle never exceeded 61.8 %**. The 60 Nm clamp was never approached again, so a raised ceiling had nothing to show itself against. This is "never retested at full throttle", not "the write failed".

⚠️ Session boundaries here are read off `session_id` and `bms_uptime_min` (which resets to 0 at each power-up), **never off timestamps**: the Pi boots with a stale clock and `gps/clock.ts` steps it afterwards, so session 143's first row is stamped _before_ session 142's last.

**What settles it, in order of cost:**

1. **The Pi's own journal.** `src/vcu/write-audit.ts` appends every attempt — including refusals — to `service-writes.jsonl`, with the name, the value asked for, the value read before and the value after. If the 750 went through `/vcu-write` it is in there with a timestamp.
2. **One bank-1 read of `CID 0x1043`.** Read-only, no SecurityAccess, the same service the sweep already uses. Says whether the VCU currently holds 600 or 750.
3. 🔥 **The test that closes it**, and it needs no Pi: with the VCU confirmed reading 750, go to **full throttle in reverse** against something solid and watch the plateau. Plateau at ~75 Nm ⇒ the parameter is operative and is simply worth raising further. Plateau still ~60 ⇒ the copy the bike obeys is not the one being written, and §4's firmware reading needs re-opening — most likely because the bike is not running the build that was disassembled.

⚠️ **A debt, stated rather than hidden.** The audit journal in (1) was not read, because the Pi was out of reach on the night this was written and the owner answered from memory instead. Memory supplies the route (`/vcu-write`, then a reboot) but not the timestamp, the value read before the write, or the post-write read-back — all three of which `AuditRecord` carries (`src/vcu/write-audit.ts`, written from `write-runner.ts:755`). Read it before treating §8 as settled.

Also open, and smaller: whether `REVERSE_TORQUE_LIMIT` is a gain or a ceiling (§4, with the experiment that settles it); whether park-assist _slow forward_ uses the same limits (one set of parameters, and the speed's absolute value is taken, so probably yes — 🟡 inference); whether the fade in §2.3 is `REVERSE_MAX_SPD` acting; and which sensor's −1 sentinel arms backup mode.

## 9. What was read

Opened and used: `obd-garage/kwp_scan_raw.txt` · `obd-garage/EMSUITE_2024.md` (§3.3, §6.0, §6.4, Appendix A) · `obd-garage/VCU_PARAM_CHANGES.md` · `obd-garage/DIAG_ADDRESSES.md` §9 · `src/vcu/param-file.ts`, `write-targets.ts`, `write-runner.ts` · `src/can/decode.ts`, `registry.ts`, `drive.ts` · `docs/vcu-parameters.md` §5, §9 · `docs/can-decode-findings.md:150, :347, :755` · `EMsuite/2021-version/files/em_telemetry_scaling.csv` · `Energica_Manuals/VCU/firmware/FILE VCU/VCU_Control_CRP.mot` and `VCU_Safety_CRP (5).mot` and both `ULTIMI` builds, disassembled · the whole of `PRE-EMCE Configuration_Inverter_FW6701_rev3`, folder and `.zip` both, unzipped to scratch with the originals untouched — `Inverter Upgrade Instructions_REV3.pdf`, `3. Parameters_6701_Energica/*.txt`, and the file listing of the programming tool and the RMS firmware `.hex` (a different inverter; cited for the Nm×10 convention only, see §4).

Opened and **empty on this question**, recorded so nobody repeats the search: `em_fault_codes.csv` (0 hits for "backup") · `em_parameter_dictionary.csv` (only `156,Reverse_Switch,uint16_t,,,-1,` with an empty description column; no `BACKUP_*` row) · the three `.ecuparams.ems` files in `FILE VCU` (600-byte JSON arrays carrying only lighting-current parameters) · `EVA Ribelle Owner Manual (END006918 rev01).pdf` (describes PARK ASSISTANCE mode and its slow-forward/reverse toggle, states no speed or torque) · `Workshop Manual - Eva Ribelle EMCE.pdf` (one mention: "Green light flashing: the motorcycle is in Park Assistance mode") · a grep of all three firmware folders for `BACKUP_MODE|REVERSE_TORQUE|REVERSE_MAX`: zero hits.

## 10. Method and data-quality notes

- The scratch DB is `evidence/scratch-2026-09-13.db`, gitignored, rebuildable with `scripts/decrypt-log.ts`. ⚠️ That script **runs out of memory** on a 322 MB log at Node's default heap — it accumulates every record before writing — and needs `--max-old-space-size=24576`.
- **49 772 rows (0.127 %) across 254 signals carry impossible timestamps**, a contiguous block dated August 2060. They decoded successfully into rows with a broken epoch, which is a different failure from the 63 unreadable segments. Nothing above 60 Nm hides in them; screens in §3 are unaffected either way.
- `drive_torque_cmd_nm` and `drive_torque_feedback_nm` carry `deadband: 0.5`, applied against the last logged value. Consequences the analysis relies on: rows 20 ms apart really are adjacent `0x02C` frames, so per-frame deltas are valid; the step histogram in §2.2 is censored below ±0.5; and the ceiling is pinned only to within half a Nm.
- Counts here and in the review on issue #214 differ where the screens differ (9 episodes against 53, 232 steps against 367). Both screens reach the same conclusion; where a number is method-dependent the method is printed beside it.
