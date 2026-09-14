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

⚠️ **Index 67 no longer reads 600.** The owner raised it to 750 on 2026-09-13 (§8) and a live probe on **2026-09-14** read it back as `rawHex 02 EE` = **750**, so that is the value in the bike today. The table's 600 is the factory-matching value the incident happened on, kept because the whole of §3 is measured against it.

**There is no factory default for any of them, and that statement now has a caveat.** `params.ecf` is not a defaults table — `src/vcu/param-file.ts:10-13` is blunt that its values "are NOT any particular bike's" and "must never be rendered as a reading". It happens to carry the same four values this bike reads, which is not the same as a factory default.

⚠️ **But the firmware's parameter table carries an unidentified 16-bit field at +0x08 that nobody has examined**, and an earlier draft asserted "nothing else on disk states one" without looking at it — in a table §4 was already walking. It reads **300 / 12000 / 125 / 250** for indices 67 / 68 / 69 / 149, and equals the `params.ecf` value on **141 of 232** A9 rows. It is **not** simply a defaults column (it disagrees on the other 91, including three of these four), and it is **not** a maximum either — it is _below_ the live value at index 49 (400 against 600) and index 67 (300 against 600). `TORQUE_LIMIT`'s entry reads 1950, which is this bike's `MAP1_TORQUE`. Unidentified, and worth its own investigation rather than a guess here.

**Table identity.** This bike runs table **16407**, whose only delta from `params.ecf`'s 16406 is index 249 `R_BRAKE_POPUP` (`src/vcu/table-catalog.data.ts`). Indices 67-69 and 149 are untouched by that delta, so the names above are this bike's names.

## 2. The units, and how well each is established

### 2.1 Torque: 0.1 Nm per count ✅

Energica states the scale for the torque _telemetry_ in **the manufacturer's telemetry-scaling table**, header `id,name,unit,equation,datatype`:

```
93,V_TRQ_CMD,Nm,f(x)=x*0.1,int16_t
94,D_TRQ_CMD,Nm,f(x)=x*0.1,int16_t
95,D_TRQ_FEED,Nm,f(x)=x*0.1,int16_t
```

⚠️ That file scales telemetry, not EEPROM records. Applying it to the _parameters_ is an inference — a well-supported one, since `docs/vcu-parameters.md` §5 already makes it for `TORQUE_LIMIT` and `REGEN_TORQUE_LIMIT`, Energica's factory options write 2000/2150 into `MAP1_TORQUE` for a platform published at 200/215 Nm, and §3 below measures a 59.9 Nm plateau against a stored 600. Three independent things agreeing is why this is marked ✅ rather than 🟡, but it is agreement, not a statement about parameters.

The firmware is consistent with it and adds nothing: A9 works in raw counts throughout, so 0.1 Nm is a display convention rather than something the code knows. ⚠️ Method for that negative, since it is a universal one: the image carries no `0.1f` or double-precision 0.1 constant and no divide-by-10 reciprocal magic; the only reciprocal constant in the reverse block is `0x51EB851F`, which is `/100` and belongs to the slew-rate arithmetic in §2.2.

### 2.2 Slew rate: 1 count = 1 Nm/s ✅

In park assist the torque command's rate of change is limited. The per-frame step (CAN `0x02C` arrives every 20 ms) piles up on **+4.0 Nm** rising and **−2.0 Nm** falling, i.e. **+200 / −100 Nm/s**, against ordinary riding above 30 km/h where the same signal moves at up to **+4170 / −3245 Nm/s**. The contrast is the first finding: this limiter belongs to the park-assist path.

⚠️ On the wire alone that is a _mode_, not a hard wall — of 232 up-steps between rows exactly 20 ms apart, 3 exceed +4.0 (max +4.5); widening to 19-21 ms gives 6 above, to +6.5. So the wire on its own cannot pin a unit, and an earlier draft of this document withdrew the claim for exactly that reason.

**The firmware settles it, and the argument is the asymmetry.** In §4's block, the up limit is `REVERSE_TORQUE_SLEWRATE_LIMIT × 10000` (`0x2A744`: `movw r1, #0x2710`; `0x2A748`: `muls`) = **2 000 000** at 200 counts. The down limit is the literal **−1 000 000**, loaded at `0x2A844` (`=0xFFF0BDC0`) and passed through the identical helper and the identical `/100` reciprocal (`0x51EB851F`). Ratio exactly **2 : 1**. Measured on the wire, independently and before any of this was disassembled: up ≈ +200 Nm/s, down exactly −100 Nm/s. **Also 2 : 1** — and the down side carries no calibration at all, because it is a constant in the code.

So the internal unit is 10 000 per Nm/s, `−1 000 000` is −100 Nm/s, and `200 × 10 000` is +200 Nm/s: **one count of `REVERSE_TORQUE_SLEWRATE_LIMIT` is one Nm/s**, equivalently 0.1 Nm per 100 ms. That is anchored on a hard-coded constant rather than on a 1:1 numeric coincidence.

The falling mode is the clean one on the wire too: 166 of 529 down-steps land on exactly −2.0 Nm, and the ladder is visible unbroken in the log — 34.7, 32.7, 30.7, 28.7, 26.7, … each 20 ms apart.

### 2.3 `REVERSE_MAX_SPD`: 0.1 km/h per count 🟡

The A9 firmware **clamps this parameter to 20…275 before use** (`0x2A488`, `0x2B58C`). ⚠️ There is an `rsbs` after the clamp that would take an absolute value, but the clamp's lower bound is 20, so the negative branch can never execute — it is dead code, and an earlier draft of this document read it as evidence that direction is carried in the sign. It is not evidence of anything. A 20…275 window reads naturally as **2.0…27.5 km/h at 0.1 km/h per count**, making 45 = **4.5 km/h**. Medium confidence: it comes from the clamp bounds, not from a statement or from an observed comparison.

⚠️ **Do not conclude that 45 never binds.** Reverse tops out at about **2.9 km/h** every single time in the log, which is what a governor looks like rather than evidence against one — and the command visibly backs off as the bike rolls: at 16:07:09.45, at 2.1 km/h, the command _falls_ 51.8 → 50.7 → 48.2 → 44.0 Nm over 60 ms — ⚠️ though the throttle was releasing across that same interval, 99.0 → 95.0 %, so this example does not isolate speed from throttle and is offered as something to look at rather than as evidence. Whether that fade is `REVERSE_MAX_SPD` acting below its limit is **open**. What §3 does establish is narrower and is enough for the incident: at 0.3 km/h nothing speed-shaped can be clipping 599 counts.

## 3. The episode, 2026-09-13 16:07:09-16:07:20 Z

Reconstructed from `cool-eva-2026-09-13.celog` decrypted to a scratch DB: 39 258 150 readings, 21 255 segments, 63 unreadable (62 bad-magic resyncs plus one GCM failure at byte 81 211 736 — a `/dl` blob is cumulative, so these are the same 63 an earlier lane reported).

**The park-assist classifier, stated because the alternative is circular:** episodes are selected as `throttle_pct ≥ 99 % while speed_can_kmh ≤ 3 km/h for ≥ 300 ms`, forward-filled. It never mentions torque, so "the ceiling is 60 Nm" is a result rather than a restatement of the selection. ⚠️ It is also **direction-free** — it cannot tell reverse from slow-forward park assist, and strictly it selects "full throttle while barely moving". It works here only because no forward launch on the ride maps holds ≥ 99 % throttle below 3 km/h; the forward-creep control below is what shows that. ⚠️ `reverse_gear` is deliberately not used — §5 of issue #216 and `docs/can-decode-findings.md:685` explain why it cannot carry this weight.

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

Six or seven separate attempts above 54 Nm in nine seconds, each one pinned at the same ceiling. ⚠️ The bike did move between attempts — speed reaches 2.1, 2.9 and 2.1 km/h elsewhere in the same window; what the table above shows is the stalled part of it, where speed sits at 0.2-0.3 km/h and rpm at 0-12. **`REVERSE_TORQUE_LIMIT = 600` is what stopped the bike**, measured, not inferred.

⚠️ 59.9 rather than 60.0 because `drive_torque_cmd_nm` carries `deadband: 0.5` (`src/can/registry.ts:767`): the plateau is a logged sample with up to half a Nm of unlogged headroom above it, so this pins the ceiling to 600 counts only to within ±0.5 Nm.

### Three things that were NOT the constraint

- **Not the motor, not pack current, not traction.** `drive_torque_feedback_nm` tracks the command through the whole plateau — sampled across 16:07:18.04-18.97 it reads 59.6, 60.6, 59.6, 60.2, 60.3, 60.4, 59.7, 60.3 against a 59.9 command (an abridged sample of the run, not consecutive frames). The drivetrain delivered everything it was asked for. The binding constraint is the **command**.
- **Not "low speed" in general.** In ordinary forward riding below 3 km/h the command reaches **175.6 Nm at only 84.4 % throttle** (2026-09-09 07:44:38 Z). Three times the park-assist ceiling at a fifth less throttle, so the ceiling belongs to the _path_, not to the speed.
- **Not backup mode.** That caps at 25.0 Nm (§5) and the bike was making 59.9.

⚠️ 600 counts does not identify index 67 _by value alone_: `REGEN_TORQUE_LIMIT` (49) is also 600 on this bike, raised from 500 on 2026-08-09. The sign settles it — the command was **+**59.9 Nm, and regen is negative.

### The ceiling never moved, in 25 days of data

Screened across the whole decrypted history, every full-throttle park-assist episode peaks between **58.5 and 59.9 Nm**, with **zero** above 60.5. ⚠️ "Whole history" is 25 days, not the whole log: `drive_torque_cmd_nm`'s first row is 2026-08-19, while throttle and speed go back to 2026-08-02, so nothing can be said about the fortnight before the `0x02C` decode landed.

## 4. What the firmware does with these numbers

The owner raised `REVERSE_TORQUE_LIMIT` to **750** through the dashboard's `/vcu-write` and rebooted the bike, and still could not climb the lip. The VCU firmware was disassembled to find out why — `VCU_Control_CRP.mot` (the A9 image, referred to below as `vcu_control.bin` once converted) and `VCU_Safety_CRP (5).mot`, plus both `ULTIMI` builds as a cross-check; all ARM Cortex-M, Thumb-2, load base `0x8100`.

**A9's parameter table is at `0x00034A94`** — 20-byte entries, EEPROM offset at +0x02, storage type at +0x04, RAM shadow at +0x0C, parameter index at +0x12. Index 67 → EEPROM `0x023E`, shadow `0x200011F6`, working global `0x2000032A`; index 68 → global `0x2000032C`. Verified independently against eight checkpoint indices. That `vcu_control.bin` is the A9 image and not the A8 one is checkable rather than assumed: its table holds 233 entries, none of them an A8 index, with 233/233 storage-width agreement against `params.ecf`.

⚠️ **An earlier draft of this document claimed that A9 never uses these parameters and that enforcement must be downstream. That was wrong, and it was wrong because the tool used to find it followed only PC-relative literal loads and stopped at the first store.** The A9 image contains the reverse torque law in one contiguous block at **`0x2A6EC`-`0x2A850`**, and it consumes all of `REVERSE_TORQUE_LIMIT`, `REVERSE_TORQUE_SLEWRATE_LIMIT` and the demand. Disassembled and read:

```
        ; --- the two parameters are copied into the working struct at 0x20001B30 ---
0002a6ec  ldr     r0, [pc, #0x288]   ; =0x2000032A  REVERSE_TORQUE_LIMIT (working global)
0002a6ee  ldrsh.w r1, [r0]
0002a6f2  ldr     r0, [pc, #0x274]   ; =0x20001B30  struct base
0002a6f4  str.w   r1, [r0, #0x460]
0002a6f8  ldr     r0, [pc, #0x280]   ; =0x2000032C  REVERSE_TORQUE_SLEWRATE_LIMIT
0002a6fa  ldrsh.w r1, [r0]
0002a6fe  ldr     r0, [pc, #0x268]   ; =0x20001B30
0002a700  str.w   r1, [r0, #0x464]
        ;   … 0x2a704-0x2a73e: an unrelated demand term, scaled by 1000 and divided …
        ; --- the slew rate becomes a per-tick step limit ---
0002a740  ldr.w   r0, [r0, #0x464]   ; the slew rate back out
0002a744  movw    r1, #0x2710        ; 10000
0002a748  muls    r0, r1, r0         ; -> 2 000 000 at 200 counts
0002a74a  ldr     r1, [pc, #0x21c]   ; =0x20001B30
0002a74c  str.w   r0, [r1, #0x474]
        ;   … 0x2a750-0x2a772: fetch the tick term and marshal both into the helper …
0002a774  bl      #0x33cc6           ; (r2 = 7)
0002a778  movs    r2, #0x1e
0002a77a  ldr     r1, [pc, #0x208]   ; =0x51EB851F  the /100 reciprocal
0002a77e  bl      #0x33c12
0002a782  ldr     r1, [pc, #0x1e4]   ; =0x20001B30
0002a784  str.w   r0, [r1, #0x478]   ; -> the per-tick step limit
        ; --- the torque limit: min against a second copy, then a gain ---
0002a78e  ldr.w   r0, [r0, #0x460]   ; REVERSE_TORQUE_LIMIT
0002a796  ldrsh.w r1, [r0, #0x7a6]   ; a second copy, stored at 0x2a314
0002a7a0  cmp     r0, r1
0002a7a2  bge     #0x2a7a8           ; -> [+0x47c] = min(the two)
0002a7bc  mov.w   r1, #0x3e8         ; 1000
        ;   … 0x2a7c6-0x2a7ea: three-way clamp of the demand into [0, 1000] -> [+0x480] …
0002a7f0  ldr.w   r0, [r0, #0x47c]
0002a7f6  ldr.w   r1, [r1, #0x480]
0002a7fa  muls    r0, r1, r0         ; [+0x484] = min(RTL, RTL') x clamp(demand, 0, 1000)
        ; --- and the two meet in the rate limiter measured in §2.2 ---
0002a812  ldr.w   r1, [r0, #0x484]   ; target
0002a816  ldr.w   r0, [r0, #0x488]   ; current
0002a81a  subs    r1, r1, r0         ; error
0002a826  ldr.w   r0, [r0, #0x478]   ; the slew-derived step limit
0002a82a  cmp     r1, r0
0002a844  ldr     r0, [pc, #0x140]   ; =0xFFF0BDC0 = -1 000 000, the DOWN limit
0002a846  bl      #0x33cc6           ; same helper, same /100 at 0x2a850
```

⚠️ Lines marked `…` are elided for length; everything else is verbatim and contiguous, including the `ldr rN, =0x20001B30` struct-base reloads that an earlier draft dropped. Individual `ldr`/`str` pairs within a group are adjacent in the image.

So: **raising index 67 does reach the torque law.** The demand is scaled by `REVERSE_TORQUE_LIMIT` and then rate-limited by a step computed from `REVERSE_TORQUE_SLEWRATE_LIMIT`, all inside A9, in the micro that stores them.

✅ **`REVERSE_TORQUE_LIMIT` is a GAIN, not a ceiling — settled by the bike's own log, not by the firmware.** The multiply at `0x2A7FA` reads as a gain (a demand between 0 and 1000 scaled by the limit) rather than a `min` against a ceiling, and the firmware alone cannot distinguish the two. The owner's own write settled it: he raised 600 → 750 at **16:09:15.935 Z on 2026-09-13**, two minutes after the stall (§8), which makes the same day a controlled before/after on one bike.

Park-assist samples below 3 km/h, binned by throttle in 5 % steps so the two periods are compared at like throttle — a gain scales **every** bin by 750/600 = 1.25, a ceiling would move only the saturated top:

| throttle % | median Nm before | median Nm after | ratio    |
| ---------- | ---------------- | --------------- | -------- |
| 5-10       | 6.8              | 7.3             | 1.07     |
| 10-15      | 11.8             | 12.0            | 1.02     |
| 15-20      | 5.7              | 6.0             | 1.05     |
| 30-35      | 13.1             | 16.6            | **1.27** |
| 35-40      | 16.0             | 20.7            | **1.29** |
| 40-45      | 18.6             | 24.3            | **1.31** |
| 45-50      | 21.6             | 27.7            | **1.29** |
| 50-55      | 25.8             | 32.0            | **1.24** |
| 55-60      | 29.4             | 37.6            | **1.28** |
| 60-65      | 33.8             | 39.9            | 1.18     |

Across all 12 bins with at least 8 samples each side the median ratio is **1.233** against a predicted 1.250. The whole partial-throttle curve moved; a ceiling would have left 30-65 % untouched. ⚠️ The bottom three bins do **not** scale, which is what a dead zone below the gain looks like (`DEAD_ZONE` = 30 sits in the same `[DRIVE_BY_WIRE]` block) — so "gain" describes the working range, not the first few percent of throttle.

⚠️ The write and the reboot that followed it are not separable in time, and do not need to be: a calibration value takes effect at boot, so the reboot is the mechanism rather than a rival explanation. The only known change to the bike between the two periods is this parameter.

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

⚠️ Energica's own material says **nothing** about backup mode. "backup" appears in none of **the manufacturer's fault-code table**, **the manufacturer's parameter dictionary**, the Ribelle owner manual, the Ribelle workshop manual, or any file in the `VCU/firmware` folder. Everything in this section comes from the binary.

It did not act on 2026-09-13 — the bike made 59.9 Nm, not 25.0. It is in this document because it is the one mechanism able to make a raised `REVERSE_TORQUE_LIMIT` irrelevant: if backup mode ever engages, **every value above 250 is moot**.

## 6. The recommendation

### What the numbers buy

**Thrust does not depend on the wheel circumference.** Writing the measured 42.0 motor rpm per indicated km/h as `N/v = 16.667 G / (2πR)` gives `G/R = 42.0 × 2π / 16.667 = 15.834 per metre`, and the circumference cancels exactly. So `SPEED_ODO_REARWHEEL_C` — which two earlier drafts carried warnings about, first for being an unread `otherBikeValue` and then for being the wrong thing to warn about — **does not enter this calculation at all**. It is still needed for the step geometry below, where the wheel radius does matter, and ✅ **it has now been read off this bike**: index 254 on **A8**, probed live on 2026-09-14, `rawHex 07 BF` = **1983**, matching `params.ecf`. So `R = 0.3156 m` is this motorcycle's number rather than another bike's, and the last `otherBikeValue` in this document is retired.

⚠️ What _does_ move it is the over-read: 42.0 is rpm per **indicated** km/h and `speed_can_kmh` reads ~3.5 % high (`docs/can-decode-findings.md:755`), so the true `G/R` is ~3.5 % larger and every thrust below is the **corrected** figure, 16.388 per metre. ⚠️ `docs/can-decode-findings.md:347` still marks the driveline decomposition **❓ NOT SETTLED**; that ❓ is about _where_ the 3.5 % lives, which does not affect this ratio.

⚠️⚠️ **The mass assumption dominates everything in this table, and it is not a measurement.** Park assist is normally used with the rider **walking beside** the bike, which is the ~280 kg column; it can also be used astride, which adds a rider and luggage. The published kerb weight for this model is around 280 kg and no figure for this specific bike has been weighed. Both columns are given because the honest answer changes between them.

| index 67 | torque | thrust | 280 kg — walking beside |  | 370 kg — astride |  |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  | grade | step | grade | step |
| 250 (backup mode) | 25.0 Nm | 410 N | 15 % | 0.3 cm | 11 % | 0.2 cm |
| 600 (factory) | 60.0 Nm | 983 N | 38 % | 1.8 cm | 28 % | 1.1 cm |
| **750 (in the bike now)** | **75.0 Nm** | **1229 N** | **50 %** | **2.8 cm** | **36 %** | **1.7 cm** |
| 900 | 90.0 Nm | 1475 N | 64 % | 3.8 cm | 44 % | 2.3 cm |
| 1100 | 110.0 Nm | 1803 N | 87 % | 5.2 cm | 57 % | 3.3 cm |

Grade is `tan θ`, the ordinary road convention, computed from `F/W = sin θ`. The step column is a rigid-step model, `F/W = √(2Rh − h²)/(R − h)` with `R = 0.3156 m`, **all** the weight on the driven wheel, no help from rocking the bike and no momentum. It is a guide to the order of magnitude, not a prediction — a real lip is chamfered, a real rider shoves, and a real tyre deforms into the step, all of which help.

**What that means, stated honestly rather than tidily.** At the walking-beside mass, 750 already clears ~2.8 cm and the lip that stopped him was simply bigger, or the geometry worse than a clean step. At the astride mass, 750 is ~1.7 cm and clearly short. The model cannot tell those apart without knowing the lip and how he was using the bike. What both columns agree on: **600 was never going to do it, 750 is marginal, and 900 is the next step that changes the answer rather than nudging it.**

### The exact write, if one is made

```
parameter  REVERSE_TORQUE_LIMIT
index      67
CID        0x1043          (bank 1, 0x1000 | 67)
micro      A9
storage    WORD S          (two bytes, two's complement)
table      16407
from       750   (75.0 Nm)     — already written 2026-09-13, see §8
to         900   (90.0 Nm)      — see the reasoning below
```

**900, not 1100.** From today's 750 that is +20 %, a smaller step than the +25 % already taken and lived with. 1100 clears the 3 cm case the arithmetic points at, but it is +47 % on a limit whose entire job is to stop the bike climbing out of a walking rider's hands, and nobody has yet ridden 900. Take 900, use it, then decide — and note that §4's matched-bin method can confirm the next change from ordinary riding, with no test needed.

**This works, and it is measured rather than expected.** §4 finds the torque law inside A9 reading this parameter, and the owner's own 600 → 750 write on 2026-09-13 scaled the whole partial-throttle park-assist curve by 1.233 against a predicted 1.25. So index 67 is operative, it is a gain rather than a ceiling, and the bike is running **750 right now** (§8).

⚠️ **Which means the question is no longer "did it work" but "how much is enough".** 750 buys about 1.6 cm of step against 600's 1.0 cm — real, and still short of the 2-3 cm an asphalt lip usually is. The table above is the guide: **900 from today's 750** is a further +20 %, and 1100 is what the arithmetic says a 3 cm lip actually needs.

**No write is made by this repo.** The 750 already in the bike is the owner's own, recorded in §8.

### The risks, which are not theoretical

- ⚠️ **Park assist is the mode where a person is walking beside 280 kg of motorcycle, often on a slope, often with one hand on the bars.** This limit exists so the bike cannot climb out of your grip. 90 Nm is 1425 N at the contact patch — around 145 kgf, comfortably more than a person can hold against.
- ⚠️ **The slew rate is unchanged at 200 Nm/s**, so a raised limit takes proportionally _longer_ to reach — 0.45 s to 90 Nm against 0.375 s to 75. The arrival is not more sudden; the destination is higher.
- ⚠️ **Reverse is used blind, looking over a shoulder, usually with the front wheel pointed somewhere.** More thrust over a lip is also more thrust when the wheel finally frees.
- A dealer visit reverts it: the service tool reinstalls parameter values from Energica's server, keyed by VIN.

## 7. Which allowlist it would have to join

⚠️ **The premise of the question has moved, and the issue that asked it predates the change.** Since `dab0f70` (#104, 2026-08-21) the five researched parameters are no longer the only writable ones. `writeTargets()` (`src/vcu/write-targets.ts:304-326`) returns `[...CURATED_WRITE_TARGETS, ...generated]`, generating a target for every uniquely-named row of the bike's table, and `planWrite()` resolves through `writeTargetNamed()` over that whole list. **`REVERSE_TORQUE_LIMIT` is already writable today** — which is how the 750 was written — at the datatype's full range, **−32768…32767**, carrying the four "⚠️ NOT researched" warnings.

The per-parameter table gate did run: `write-runner.ts:635` calls `writeTargetProblemIn` for every named target, curated or generated. Only `allowlistProblemsIn` is curated-only, for the reason its own comment gives.

So the list it would join is **`CURATED_WRITE_TARGETS`** — today `MAX_DC_CHG_CURRENT`, `FCHG_CURRENT_GAIN`, `TORQUE_LIMIT`, `REGEN_TORQUE_LIMIT`, `VSM_CONFIG_1` — and promotion would buy **no reachability at all**. What it would add is `min`/`max`, `warnings` and `verify`. Of those, `verify` would have to be `null`: nothing broadcasts index 67, unlike `MAX_DC_CHG_CURRENT` whose entry leans on `0x625` b2. And `min`/`max` are precisely the numbers §4 says are unknown.

**Recommendation: do not promote it yet.** A curated entry whose bounds are defended with "we guessed" is worse than no entry, and `docs/vcu-parameters.md` §5 calls that friction the point of the file. Promote it once §8's test says whether the VCU's copy is the operative one — at which point the bound has a reason behind it.

## 8. What is open, and the one test that closes most of it

✅ **The state of the 750 write: WRITTEN AND READ BACK.** The Pi's own audit journal settles it. `evidence/service-writes.jsonl` line 89, quoted whole:

```json
{
  "at": 1789315755935,
  "clockTrustworthy": true,
  "action": "parameter-write",
  "status": "written",
  "name": "REVERSE_TORQUE_LIMIT",
  "identifier": 4163,
  "micro": "A9",
  "before": 600,
  "after": 750,
  "requested": 750,
  "rawHex": "02 EE",
  "note": "REVERSE_TORQUE_LIMIT: 600 → 750 — written and read back as 750 (02 EE).",
  "runningVersion": "8306426"
}
```

`identifier` 4163 is `0x1043`, `rawHex` `02 EE` is 750 big-endian on the wire, and `at` is **2026-09-13 16:09:15.935 Z** — two minutes after the stall and before the reboot, with the clock marked trustworthy. The VCU took the value and read it back. §4 then shows, from the ride log, that it also _acted_: the whole partial-throttle torque curve scaled by 1.25.

**So the 750 was live, and it was simply not enough.** That is the answer to "would more have helped": yes, more is exactly what was needed — §6's arithmetic puts 75.0 Nm at about a 1.6 cm step against the 2-3 cm an asphalt lip usually is.

**Why the log alone could not show it**, which is worth keeping because it is a trap: after the reboot the throttle never exceeded **61.8 %** in any of the 47 low-speed torque windows on record, so the _ceiling_ was never demanded again **in park assist**. ⚠️ Torque does exceed 60 Nm after the reboot — 109.0 Nm at ≤ 3 km/h in session 143 — but that is a forward launch on the ride maps, not the park-assist path, which is the distinction §3's forward-creep control exists to draw. Only the matched-bin comparison at partial throttle in §4 could see the change, and only because the parameter turned out to be a gain.

**What would still be worth reading, and what is now closed:**

1. ~~The Pi's own journal~~ — **read, and quoted above.** `src/vcu/write-audit.ts` appends every attempt including refusals; line 89 is the record.
2. ~~One bank-1 read of `CID 0x1043`~~ — ✅ **done, 2026-09-14, keyed on and parked**: `target=A9 bank=1 index=67` returned `status: read`, `rawHex 02 EE`, value **750**. The journal said it was written; this says it is still there after a day's riding. **§8 is now closed.**
3. ~~The full-throttle plateau test~~ — **no longer needed to prove the parameter works.** §4 proves it from data already logged. It would still be the cleanest single confirmation that a _new_ value took, and costs nothing next time the bike is in reverse.

✅ **Park-assist slow forward and reverse share one torque limit — measured, 2026-09-14.** Energica's `0x101 VCU_VEHICLE_STS` carries a state machine (`V_VEHICLE_STATE` byte 1, `V_VEHICLE_SUBSTATE` byte 0) and park assist is **state 40, substate 52 or 53**, the two alternating exactly as the owner manual describes the START-ENGINE direction toggle. 985 098 frames of `0x101` from the boot containing the stall settle it:

| substate | when (Z)             | max throttle | max torque |
| -------- | -------------------- | ------------ | ---------- |
| 52       | 13:27:56             | **100.0 %**  | 58.5 Nm    |
| 53       | 13:28:04             | **100.0 %**  | 59.2 Nm    |
| 52       | 16:07:03 (the stall) | **100.0 %**  | 59.9 Nm    |

Two back-to-back runs eight seconds apart, one in each substate, both wound to full throttle, **both capped at the same ~59 Nm**. So the `REVERSE_*` parameters govern both directions of park assist, not just reverse — which is what the single parameter set and the absolute-value handling suggested, now measured rather than inferred. The stall itself is substate **52**, and since the owner reported being in reverse, 52 is reverse and 53 is slow forward (🟡 that last attribution is the weakest link in the chain; the shared ceiling does not depend on it).

Also open, and smaller: whether the fade in §2.3 is `REVERSE_MAX_SPD` acting; and which sensor's −1 sentinel arms backup mode.

## 9. What was read

Opened and used: `obd-garage/kwp_scan_raw.txt` · the 2024 service-tool analysis in `obd-garage/` (§3.3, §6.0, §6.4, Appendix A) · `obd-garage/VCU_PARAM_CHANGES.md` · `obd-garage/DIAG_ADDRESSES.md` §9 · `src/vcu/param-file.ts`, `write-targets.ts`, `write-runner.ts` · `src/can/decode.ts`, `registry.ts`, `drive.ts` · `docs/vcu-parameters.md` §5, §9 · `docs/can-decode-findings.md:150, :347, :755` · `evidence/probes-20260914.txt` (five live read-only probes, 2026-09-14) · `evidence/captures/frames-0x101-capture-20260913-150718-04632ecc.txt` (985 098 frames) · `evidence/service-writes.jsonl` line 89 · the manufacturer's telemetry-scaling table · `Energica_Manuals/VCU/firmware/FILE VCU/VCU_Control_CRP.mot` and `VCU_Safety_CRP (5).mot` and both `ULTIMI` builds, disassembled · the whole of `PRE-EMCE Configuration_Inverter_FW6701_rev3`, folder and `.zip` both, unzipped to scratch with the originals untouched — `Inverter Upgrade Instructions_REV3.pdf`, `3. Parameters_6701_Energica/*.txt`, and the file listing of the programming tool and the RMS firmware `.hex` (a different inverter; cited for the Nm×10 convention only, see §4).

Opened and **empty on this question**, recorded so nobody repeats the search: the manufacturer's fault-code table (0 hits for "backup") · the manufacturer's parameter dictionary (only `156,Reverse_Switch,uint16_t,,,-1,` with an empty description column; no `BACKUP_*` row) · the three `.ecuparams.ems` files in `FILE VCU` (600-byte JSON arrays carrying only lighting-current parameters) · `EVA Ribelle Owner Manual (END006918 rev01).pdf` (describes PARK ASSISTANCE mode and its slow-forward/reverse toggle, states no speed or torque) · `Workshop Manual - Eva Ribelle EMCE.pdf` (one mention: "Green light flashing: the motorcycle is in Park Assistance mode") · a grep of all three firmware folders for `BACKUP_MODE|REVERSE_TORQUE|REVERSE_MAX`: zero hits.

## 10. Method and data-quality notes

- The scratch DB is `evidence/scratch-2026-09-13.db`, gitignored, rebuildable with `scripts/decrypt-log.ts`. ⚠️ That script **runs out of memory** on a 322 MB log at Node's default heap — it accumulates every record before writing — and needs `--max-old-space-size=24576`.
- **49 772 rows (0.127 %) across 254 signals carry impossible timestamps**, a contiguous block dated August 2060. They decoded successfully into rows with a broken epoch, which is a different failure from the 63 unreadable segments. Nothing above 60 Nm hides in them; screens in §3 are unaffected either way.
- `speed_can_kmh` carries `deadband: 0.5` and `motor_rpm_can` carries **`deadband: 50`** (`src/can/registry.ts:487-488`), so the rpm column in §3 cannot distinguish 0 from 62 and the speed column is quantised to half a km/h. Neither carries any weight in the conclusions; the torque column does.
- `drive_torque_cmd_nm` and `drive_torque_feedback_nm` carry `deadband: 0.5`, applied against the last logged value. Consequences the analysis relies on: rows 20 ms apart really are adjacent `0x02C` frames, so per-frame deltas are valid; the step histogram in §2.2 is censored below ±0.5; and the ceiling is pinned only to within half a Nm.
- Counts here and in the review on issue #214 differ where the screens differ (9 episodes against 53, 232 steps against 367). Both screens reach the same conclusion; where a number is method-dependent the method is printed beside it.
