# The charge manager — CAN 0x600, 0x605, 0x610, 0x615, 0x620, 0x625

Findings for `src/can/charge-manager.ts`. The decoder carries a pointer here and one sentence per byte; everything that is evidence rather than instruction lives in this file.

This ECU is only on the bus while a charge cable is live, which is why none of it was decoded until 2026-08-19: every parked sweep found silence (`obd-garage/CHARGE_MANAGER.md` §3.5). The standing assumption was that this meant DC only. It does not — the whole group broadcasts on AC too, and AC is where most of the corpus is, so the AC-vs-DC contrast is what identifies these bytes rather than any single session. The one exception is `0x625`, which broadcasts whenever the bike is awake, parked and unplugged included.

## Provenance

**The corpus.** 29 charge sessions found by scanning every capture in `~/Documents/cool-eva-archive` (16 GB, 325 `.log` files plus the differently-formatted `can_log-2026-06-14.txt`): 18 AC and 11 DC, 2026-06-14 → 2026-08-09, at several different chargers. Match rates below are over the whole corpus at full frame rate, deduplicated on (timestamp, id, payload) because several captures overlap in time:

    0x600   964 526      0x605   967 865      0x610   968 629
    0x615   941 765      0x620   968 618      0x625 1 571 614

**The factory files.** On 2026-08-20 a community member (**thimo**) cross-checked the decode against Energica's own DBC and PCAN `.sym` for this bus, which define five of these six frames with factory signal names — [PR #77 comment](https://github.com/danieltroger/cool-eva/pull/77#issuecomment-5348305440). Everything below that is a _name_ comes from those files; everything that is a _number_ comes from the corpus.

⚠️ **The DBC carries names only.** Every signal in it is factor 1, offset 0, with placeholder min/max. It says what a byte _is_, never how it scales — and a name is a claim by whoever wrote the file, not a measurement. Each factory name below was re-tested against the corpus before being adopted, and where the two disagree this document says so rather than deferring to the DBC. Two names did not survive: [`CM_EVSE_CHG_ENABLED`](#0x620-cm_evse_fdb) and [`CM_TEMP_DC`](#0x600-cm_wd).

## Direction: three of these frames are the VCU talking, not the charge manager

The factory naming convention is `V_*` for signals the VCU transmits and `CM_*` for signals the charge manager transmits. That reframes half the group:

| id      | factory name   | direction | what it carries                                      |
| ------- | -------------- | --------- | ---------------------------------------------------- |
| `0x600` | `CM_WD`        | CM → bus  | watchdog, firmware version                           |
| `0x605` | `V_CM_COM`     | VCU → CM  | charge mode, inlet lock, IMD command                 |
| `0x610` | `CM_V_COM`     | CM → VCU  | state machine, error code, firmware version          |
| `0x615` | `V_CM_CHG`     | VCU → CM  | **the DC request**: target V, target I, reported SOC |
| `0x620` | `CM_EVSE_FDB`  | CM → VCU  | what the station offers                              |
| `0x625` | `VCU_CM_LIMIT` | VCU → CM  | the vehicle's own configured limits                  |

`0x615` is the one that changes a reading rather than a label: its three bytes are what the vehicle **asks for**, not what it measures.

## How AC and DC are told apart here

Not by `0x201`: the BMS reports Idle (`0x10`) through most of a DC charge because the DC path bypasses it, and it reports Charge (`0x02`) through parts of session 27, a DC session at 99 % SOC. So "`0x201` = `0x02` means AC" is false in both directions. Ground truth throughout is `0x615` b2 > 0 for DC and `0x305` mains current > 0.5 A for AC.

⚠️ **Both are imperfect in the same place, and it matters for every rate below.** `0x615` b2 is — on this PR's own thesis — what the vehicle _asks for_, not what flows, so "DC ground truth" is really "the VCU is requesting DC current". The two diverge by 0.5-2.4 s at the start of a session and again through a taper, which is exactly where every exception in this document lives. And the AC threshold of 0.5 A is below the floor of "charging" (see `0x625` b4). Rates are also sensitive to the alignment window used to pair two frames of different rates: the `dc_charging` exception count moves from 435 to 457 between a 50 ms and a 200 ms window. Where a percentage is close to 100, read the exceptions rather than the percentage.

---

## 0x605 `V_CM_COM`

VCU → CM. b4-6 are `00` and b3 is a byte-for-byte copy of b2, both in 100.000 % of 967 865 frames, so only one of the b2/b3 pair is emitted.

| byte        | factory             | corpus                                   |
| ----------- | ------------------- | ---------------------------------------- |
| b0 bit 0    | `V_EV_READY_TO_CHG` | 1 in 97.32 %                             |
| b0 bit 1    | `V_INL_LCKCTRL`     | 1 in 83.77 %                             |
| b0 bit 2    | `V_INL_LCKSET`      | 1 in 80.99 %                             |
| b0 bits 3-4 | `V_CHGMODE_FDB`     | {0, 1, 2}; **never 3** in 967 865 frames |
| b0 bits 5-7 | _not in the DBC_    | `0` in 100.000 %                         |
| b1          | `V_EV_ERROR`        | `0` in 100.000 % — never fired           |
| b2          | _not in the DBC_    | **decoded as `charge_type`**             |
| b7          | `V_IMD_DISABLE`     | **decoded as `bms_leak_detect_inhibit`** |

**b0 is not the two-valued byte the 2026-08-19 pass recorded.** "0x0F on AC and 0x11 on DC (99.93 %)" is 97.19 % at full rate, and the byte takes ten values: `0x0F` 783 865, `0x11` 156 765, `0x02` 25 704, `0x0B` 1 080, `0x00` 196, `0x01` 148, `0x0E` 53, `0x06` 28, `0x03` 24, `0x0A` 2. The DBC explains why: it is four fields, and the two-valued reading was `0x0F` = ready + lock control + lock set + mode 1 against `0x11` = ready + mode 2.

**`V_CHGMODE_FDB` and `charge_type` are the same fact — measured, not assumed.** `(b0 >> 3) & 3` equals b2 in **99.822 %** of 967 865 frames, and every disagreement is a mode transition where one of the two is briefly 0 while the other is not (the disagreeing pairs are (2,0) 898, (1,0) 480, (0,1) 274, (0,2) 70 — there is no frame where they name _different_ modes). So b2 is a wider echo of the 2-bit field, and 1 = AC / 2 = DC applies to both. b2 is what is decoded because a whole byte survives a bit-position error and a 2-bit field does not.

**b2 `charge_type`** — 1 = AC, 2 = DC. 99.991 % of the 151 200 frames where DC current is flowing read 2 (the 2026-08-19 figure was 99.975 % of a 43 994-frame sample). ⚠️ It is a property of the SESSION, not of current flowing: in the aborted DC attempt of 2026-08-09 14:42 it reads 2 for the whole 139.3 s (⚠️ not 155 s — see §The fault corpus, "An artefact that contaminates any analysis timed across a Pi restart") while not one amp moves. For "is charge actually flowing", use `dc_charging` / `ac_charging`.

**b7 `V_IMD_DISABLE` → `bms_leak_detect_inhibit`** (IMD = insulation monitoring device; BMS memory 2122). The factory name is our name almost verbatim, with one direction correction: this is the **VCU commanding** the monitor off, not the BMS reporting that it is off. The BMS's isolation monitor cannot run against a station-driven DC bus, so the vehicle switches it off for the duration of a DC session. Match rates, all at full frame rate:

    b7 = 1 while 0x645 is on the bus (a DC session exists)   99.933 % of 156 931
    b7 = 0 while 0x645 is absent                            100.000 % of 810 934
    b7 = 1 while DC current flows                            99.991 % of 151 200
    b7 = 0 while AC mains current flows                      99.998 % of 784 537

Note the first pair is the tighter statement: it tracks the SESSION, so through the aborted attempt it reads 1 in 3 521 of 3 562 frames while the current is zero for 1 439 of them.

### ❌ `V_IMD_DISABLE` is NOT visible on `0x102` bit 27

The DBC also places `V_IMD_DISABLE` at bit 27 of `0x102 VCU_DIGITALS`, which would put the same fact on the always-on bus without a charge session. **Refuted on this bike.** Frame bit 27 is byte 3 bit 3, and it is clear in **15 716 143 of 15 716 143** `0x102` frames in the archive — including the 1 572 636 frames that align with a `0x605` saying the VCU is commanding the monitor off. Byte 3 bits 3, 4, 5 and 7 are all 0.000 %.

The bit that _does_ track it is **b3 bit 0, frame bit 24 — `fast_dc_contactor`, already decoded** (`V_FASTDC_MON_SW` in `src/can/decode.ts`), which agrees with `0x605` b7 in 99.39 % of 9 890 746 aligned frames. That is the same fact arriving by the physical route rather than the command route, and it is the one to use if you want the DC state without the charge group awake.

🟡 Incidental correction to `src/can/decode.ts`: its note that `0x102` b3 bit 2 "is never once clear in 1 103 000 frames" is true of its 14-capture sample and not of the archive — b3 reads `0x40`/`0x41` in 278 frames, so bit 2 is set in 99.998 %, not 100 %.

### Why this frame has no invariant gate

It is the one frame in the group without one, and that is a measurement rather than a preference. There is no invariant left: b4-6 are `00` and unnamed in the DBC, b1 is `V_EV_ERROR` which is legitimately 0, b3 = b2 holds trivially, and every remaining byte takes 0 in real traffic — b0 = `0x00` in 196 frames, b2 = 0 in 27 134, b7 = 0 in 811 039. **The bus itself sends a completely zero `0x605` payload 126 times in the archive**, so any gate that rejected that shape would drop real frames.

That is tolerable here and would not be on `0x620`, for a reason worth keeping: this frame's all-zero decode is FAIL-SAFE. `charge_type` = 0 says "no path live" and `bms_leak_detect_inhibit` = 0 says "the isolation monitor is running" — both the safe reading of a charge manager that has gone away. The all-ones shape is caught by `bounds.js` (255 fails both `charge_type`'s [0, 2] and `bms_leak_detect_inhibit`'s [0, 1]). `0x620`'s all-zero decode claims two ceilings, which is a measurement, and that is why it is gated and this is not.

---

## 0x610 `CM_V_COM`

CM → VCU. Both decoded bytes are logged RAW and are deliberately bounded only to [0, 255] in `bounds.js` — the point of a raw state byte is to catch a state nobody has seen yet, and a bound drawn round today's set would reject exactly that.

| byte        | factory                       | corpus                                                      |
| ----------- | ----------------------------- | ----------------------------------------------------------- |
| b0 bits 0-1 | `CM_CHGMODE_REQ`              | {0, 1, 2}; **never 3** in 968 629 frames                    |
| b0 bit 2    | `CM_RELAY_REQ`                | 1 in 99.941 % of DC-current frames, 0 in 99.967 % otherwise |
| b0 bit 3    | `CM_INL_STS` (inlet present)  | 1 in 99.957 %                                               |
| b0 bit 4    | `CM_INL_LKSTS` (inlet locked) | 1 in 96.73 %                                                |
| b0 bits 5-6 | `WAIT_AUTH`                   | {0, 1, 2}; **never 3**. 2 in 99.941 % of DC-current frames  |
| b0 bit 7    | _not in the DBC_              | `0` in 100.000 %                                            |
| b1          | `CM_ERROR_SRC`                | **newly decoded**                                           |
| b2-3        | `CM_ERROR_CODE`, signed 16 LE | **newly decoded**                                           |
| b4-6        | `TMS_Version`                 | `F1 05 01` in 100.000 % — **per-bike**                      |
| b7          | _not in the DBC_              | **decoded as `charge_manager_state`**                       |

**b0 is a set of fields, not a bitfield.** Our reading was "bit 0 set ⟺ AC, bit 1 set ⟺ DC, in 99.989 %", which is the 2-bit `CM_CHGMODE_REQ` enum read as two flags. The corpus tells the two readings apart: **the pair is never 3**, in 968 629 frames. Nor is `WAIT_AUTH` ever 3, and `V_CHGMODE_FDB` on `0x605` is never 3 either. Three independent 2-bit fields that never reach their fourth value is what an enum looks like and not what two independent flags look like.

The DC value `0x5E` decodes as mode 2 + relay + inlet + locked + `WAIT_AUTH` = 2; the AC `0x19` as mode 1 + inlet + locked, `WAIT_AUTH` = 0. thimo's AC-only captures never set `WAIT_AUTH` and had it flagged "untested for DC" — this corpus tests it: it is a DC-path field.

**b7 `charge_manager_state`** — the single cleanest AC/DC discriminator on this bus: `0x23` while DC current flows (**99.974 %** of 151 096 frames) and `0x02` while AC mains current flows (**99.999 %** of 784 599). ⚠️ Re-measured at full rate; the 2026-08-19 figure was 100.000 % of a 44 444-frame sample, and the sample was what made it exceptionless — it still reads the other mode's value in fewer than 40 frames in a million. (`0x102` b3 bit 0, the fast-DC contactor, is the other clean one and is already decoded — they agree.) ❌ **The handshake is NOT one fixed sequence, and this line said it was.** It read "b7 steps `0x02` → `0x14` → `0x04` → `0x07` → `0x0D` → `0x11` → `0x12` → `0x23` over the ~3 s of a DC handshake" until 2026-08-20. Three sessions replayed through the ride log take three different paths out of `0x02`:

| session | path out of `0x02` | span |
| --- | --- | --- |
| 2026-08-04 19:58 | `0x14` `0x04` `0x07` `0x0D` `0x11` `0x12` `0x11` `0x23` | 4.70 s (19:58:19.252 → 23.951) |
| 2026-08-09 14:41, the aborted attempt | `0x14` `0x04` `0x07` `0x09` `0x23` | 3.70 s |
| 2026-08-08 13:00, 46 min, completed | `0x14` `0x04` `0x07` `0x09` `0x11` `0x12` `0x11` `0x23` | 4.70 s |
| 2026-08-09 14:42, its retry 66 s later | `0x14` `0x04` `0x23` | 2.10 s |

The first is nine steps and not eight — `0x11` sits on both sides of `0x12` — and two of the four pass through an `0x09`. ⚠️ An earlier version of this paragraph said the aborted attempt "passes through an `0x09` neither other session shows", and read it as a marker of the abort. **It is not.** The 2026-08-08 13:00 session is 46 minutes long, completed normally, took 13.66 kWh from 21 % to 90 % SOC — and passes through `0x09` as well. It is 2026-08-04's path with `0x09` substituted for `0x0D`. Whatever `0x09` means, it is not failure. ⚠️ These come off the log at the 10 Hz frame rate, so a step held for less than ~100 ms would not appear: that the paths DIFFER is established, the complete step list for any one session is not. So the individual steps have no established names, the DBC does not name this byte at all, and a state table inferred from the order they appear in would have been wrong about the order itself. Keeping it raw was right.

### b1-3 are a fault code, and it has fired three times

The 2026-08-19 pass recorded these as "00 in every frame of every completed session… non-zero in exactly one place in the whole corpus". **The second half is wrong.** At full rate they are non-zero in 500 frames across **three** episodes:

| window | n | raw payload | `CM_ERROR_SRC` | `CM_ERROR_CODE` | b7 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-02 18:55:15.848 → 16.548 | 8 | `0x?? 07 4D 04 F1 05 01 23` | 7 | 1101 | `0x23` |
| 2026-08-08 17:41:32.250 → 37.550 | 54 | `0x?? 08 4D 04 F1 05 01 23` | 8 | 1101 | `0x23` |
| 2026-08-09 14:41:46.078 → 14:42:29.781 | 438 | `0x?? 07 55 03 F1 05 01 23` | 7 | 853 | `0x23` |

b0 is `0x08` or `0x0A` in the first and third and `0x28` or `0x2A` in the second; all three sit at b7 = `0x23`, the DC substate. The raw bytes `07 55 03` that the 2026-08-19 note recorded belong to the **third** episode, the aborted DC attempt — which is also the frame the replay fixture in `scripts/check-can-decoders.ts` carries. The 2026-08-08 episode is 44 minutes before that day's DC session and was never noticed at all.

✅ **The contingency is what makes this two fields rather than one 24-bit number.** Source 7 emits both codes, and sources 7 and 8 both emit 1101: the three observed pairs are (7, 853), (7, 1101) and (8, 1101), so neither field determines the other. Decoding them separately is not just the DBC's word for it — the data cannot be read any other way.

Both fields are now decoded, because the DBC supplies exactly the evidence that was missing before: the reason they were left alone was "one aborted session is not enough to decode a fault code", and a factory name is not a second session but it does settle _what the bytes are_. Two sources and two codes is not a table anyone can name yet; the values are logged raw so a future fault can be matched against them.

🟡 This also corrects `src/can/vcu-flags.ts`, whose header says the charge manager's "own `CM_ERROR` / `CM_ERROR_SOURCE` / `CM_ERROR_CODE_*` telemetry is not broadcast anywhere and needs a diagnostic session". It is broadcast, on this frame, at 10 Hz. ❌ **The next sentence used to read "`vcu_err_charge_manager` (`0x100` b7 bit 1) … remains 0 in every captured frame — including all three windows above". That is wrong.** The bit fires in all three, 0.162 s after the first error frame each time, and in a fourth failure that published no code at all. §The fault corpus below has the measurement; it is the best corroboration these two bytes have.

Energica's own service tool carries five DTC titles for this ECU (`CM INTERNAL ERROR`, `CM APPLICATION LAYER ERROR`, `CM-VEHICLE COMMUNICATION ERROR`, two unclassified), served through the VCU. So the fault path exists; what these two codes map to is unknown.

🔍 **Where the next pass should start.** `src/diagnostics/dtc-table.ts` already carries seven charge-path codes under ECU group 54, decoded from the same service tool: `C1003` unspecified CM error, `C1006` CM-to-vehicle communication error, `C1008` EVSE emergency shutdown, `C1010` protocol error, `C1012` SLAC process error, `C1014` unclassified CM error, plus `P1045` error inlet. Neither 853 nor 1101 is any of those numbers, and neither is their group/index pair, so the mapping is not the obvious one — but a bike that produces a stored DTC and a live `charge_manager_error_code` in the same minute would settle it in one reading, and that is now a thing this project logs rather than a thing it would have to be running a diagnostic session to see.

### The gate is `b4 = 0xF1`, and why it is not the whole triple

b4-6 read `F1 05 01` in 100.000 % of 968 629 frames — every raw frame of this id in the archive. It was the gate until 2026-08-20. **The DBC says it is `TMS_Version`, and thimo's bike reads `F1 04 60`** — two bikes disagreeing in exactly the version bytes while agreeing everywhere else is good evidence it is one, and it means a gate on all three bytes decodes this ECU on precisely one motorcycle. Since the point of publishing is that someone else can run it, the gate is now b4 alone: `0xF1` is shared by both bikes, and it still rejects all three shapes `scripts/check-can-decoders.ts` sweeps with — all-zero, all-ones, and the `55 AA` alternation.

⚠️ The trade-off, which `0x625` accepts too. A decoder is pure, so a gate that DROPS is silent by construction: if a firmware update ever moves b4, these two bytes go quiet rather than loud, and quiet looks exactly like a charge manager that never woke up. That is the right way round — `0x610` b7 is the cleanest AC/DC discriminator on this bus, so a wrong value for it is worse than no value — but it is the first thing to suspect if the state bytes ever vanish.

The gate deliberately does NOT read b1-3: gating on them would drop the aborted DC session of 2026-08-09 14:42, which is the most interesting DC data this project has.

---

## 0x615 `V_CM_CHG` — a request, not a measurement

VCU → CM. b4-7 are `00` in 100.000 % of 941 765 frames.

| bytes | factory                      | decoded as           |
| ----- | ---------------------------- | -------------------- |
| b0-1  | `V_CMDC_TARGET_V`, 16-bit LE | `fast_dc_target_v`   |
| b2    | `V_CMDC_TARGET_I`            | `fast_dc_target_a`   |
| b3    | `V_CMDC_SOC`                 | `charge_manager_soc` |

### The 242.5 offset dissolves

The 2026-08-19 decode read b0 as a voltage with a fixed offset (`pack_v ≈ b0 + 242.5`) and b1 as a constant `0x01`. The DBC says they are **one 16-bit little-endian value**, and the corpus agrees without qualification: b1 = `0x01` in 941 765 of 941 765 frames, so the value is `256 + b0` and spans **284…350 V**. The offset was never a property of the field — 256 − 242.5 = 13.5, and the "mysterious" 242.5 was just 256 minus the gap between target and pack.

What the corpus adds, which the DBC does not state:

    target16 − pack_v (0x200), 941 765 aligned pairs
      median 13.40 V   p5 12.70   p25 13.00   p75 14.00   p95 14.60
      DC frames only:  median 13.40   p5 12.60   p95 14.90   (n = 151 186)
      no DC current:   median 13.40   p5 12.70   p95 14.50   (n = 790 579)
      fit: pack_v = 0.9942 × target16 − 11.71,  r = 0.9988

🟡 **The target sits a constant ≈ 13.4 V above the pack in every mode**, including AC sessions and the handshake before any current flows. That is inference from our numbers, not a DBC statement, and the constancy is the interesting part: it does not widen with current, so it is not a cable or contactor drop. A charge target computed as "pack + a fixed headroom" is what it looks like. Nothing here should assume more than that.

⚠️ The old writeup's careful derivation of 242.5 (median 242.6, p5 241.4, p95 243.3, least squares `0.9943 × b0 + 242.79`) was all correct arithmetic on the wrong model, and its speculation that 242.5 might come from 81 series cells at the 3.0 V under-voltage limit (= 243.0 V) is now moot. It also superseded `CAN_MAP.md`'s "242 and 245 both fit" by ruling out 245; that stands, for whatever it is still worth.

**Consequence for the key.** `charge_manager_pack_v` was renamed to `fast_dc_target_v` and its value changed from `b0 + 242.5` to `256 + b0` — 13.5 V higher. The rename is not cosmetic: the old key was documented as "the SAME QUANTITY as `pack_v`… a second witness" (now `docs/dashboard-decisions.md` §"The charge manager's numeric bounds"), and it is not. It is the VCU's request. Rows logged under the old key before 2026-08-20 are still correct readings of b0; they are just 13.5 V below what the same byte now logs, which is exactly why they must not share a series.

### b2 — the current the vehicle asks for

`V_CMDC_TARGET_I`, 1 A/count. Zero in 100.000 % of the 783 310 AC-mains frames — no leakage at all, which is what makes it DC-specific rather than a general charge current.

Against `0x200`'s pack current on DC frames: r = **+0.9951**, median difference **+0.30 A** (p25 −0.30, p75 +0.30). The sign matters: the byte reads a median 0.30 A _more_ than the pack draws, which is a request the station follows just short of. 75 % of samples agree within 1.0 A and 85 % within 2.0 A, the tail being ramps where a 10 Hz frame and a 20 Hz one disagree about a current moving at tens of amps per second.

✅ **Two positive tests that a delivery readback cannot pass**, run because the DBC name is a claim and this is what would falsify it:

- **It leads the first amp in all 8 DC sessions whose ramp is captured**, by +0.03 s to +2.40 s (2026-08-04 19:58:45.511 +0.50, 2026-08-08 13:00:55.831 +2.30, 15:09:57.639 +1.00, 17:44:58.023 +0.80, 2026-08-09 14:43:17.121 +0.03, 15:23:41.078 +0.50, 16:55:49.543 +2.40, 17:51:34.114 +2.20). The search window is symmetric ±120 s, so a delivery-first session would have shown as a negative number. None did. Frame skew between two 20 Hz senders is ~50 ms; a 2.4 s lead is not skew.
- **Lag cross-correlation is asymmetric in the request-first direction.** Smoothing both series to 0.5 s and correlating their differences: r = +0.849 at lag 0, +0.831 at lag +1 (request half a second earlier), but only +0.471 at lag −1. Peak between 0 and +0.5 s, leaning positive.

⚠️ At raw frame rate without smoothing the same test is nearly flat (peak r = 0.157 at +5 frames) because both signals are quantised — 1 A here, 0.1 A on `0x200`. Do not quote the raw version as the evidence; it is the smoothed one that separates the hypotheses.

A third measurement agrees, and **nothing arrives early.** Over the 2 636 steps in the request where the delivery actually had to move, the pack current reaches the new value a **median 0.60 s later** (p5 0.20 s, p95 2.50 s), and not one reaches it before the step. A further 860 steps (23.0 %) were already at the new value when it arrived — the request catching up to the delivery in a taper, not the delivery anticipating the request — and 237 never got there within 5 s.

⚠️ An earlier draft of this section reported 1 678 steps "arriving early". That was an artefact of searching a window that began **3 s before** the step, so any taper frame already past the threshold counted as an early arrival. Searching forward from the step instant, as above, the effect disappears entirely. Recorded because the mistake is invisible in the summary statistic and only shows in the window definition.

### 🔍 Where the request comes from — open, and the sharpest lead here

The request is not a free choice. Whenever the station's power is what binds, it is very close to

    request == min(73, round(b3 × 1000 / 348))

— the station's available kilowatts (`0x620` b3) divided by a **fixed voltage near 348**, and capped at 73 A. As an upper bound it holds hard: the request exceeds that prediction in **0.562 % of 151 125 frames**, and in three of eight DC sessions not once. As an equality it is conditional: exact-integer match is 99.56 % and 99.16 % in two sessions, 87.5 %, 63.7 %, 63.5 %, 56.2 % in four more, 30.1 % and **0.00 %** in the two high-SOC sessions at the 320 kW site — 57.2 % pooled. In six of the eight the median `request ÷ prediction` is exactly 1.000; in the other two it is 0.356 and 0.137, which is a pack-side taper binding first and has nothing to do with the formula.

🟡 **The divisor is not the present pack voltage — it is a constant.** Scanning it against the corpus, exact match peaks flat at 0.5721 for 348.0-348.5 and falls away on both sides: 0.2129 at 344, 0.2898 at 346, 0.5708 at 349-350, 0.3910 at 352, 0.2013 at 355. The ceiling test agrees from the other end, jumping from 0.69 % violations at 350 to 18.7 % at 352. So the bike divides by roughly 348 V regardless of where the pack actually is — and **81 series cells at this pack's 4 300 mV `CELL_OVERVOLTAGE` limit is 348.3 V**, which sits inside the interval. Suggestive, and not a derivation: nothing has been read out of the VCU that says this is the number it uses.

🟡 **The 73 A cap is real and is not 75.** The request reads 73 in 30 265 frames and has never once read 74 or 75, across all 941 765 frames — while `fast_dc_limit_max_a` is 75 and the station was offering exactly 75 in 30 262 of those 30 265. So the vehicle holds back 2 A from its own configured maximum, for a reason nothing here explains. Anyone chasing why DC charging caps below the advertised 75 A should start at that gap.

Nothing in the decoder changes for any of this: b2 is still the requested current in amps at 1 A/count. What it adds is where the number comes from, which is `0x620` b3 and a constant, not a measurement of anything.

**Consequence for the key.** `fast_dc_a` was renamed to `fast_dc_target_a`. The number is unchanged. The name was the problem: sitting in the `charge` group next to `pack_a` and `dc_a` it read as a measured current, and this project's signature failure mode is a name that asserts the wrong thing (`charging` was the high beam at 1 103 000/1 103 000). It is still the only DC-side current on this bus — `0x305`/`0x306` do not exist during a DC session at all and `0x10A` b7 reads 0 — so every "am I charging" test built on the AC charger's frames still silently says no at a fast charger, and this is still what answers that question.

### b3 `V_CMDC_SOC` — the SOC reported outward

The SOC the VCU sends to the station for its ramp planning, which is free to disagree with the BMS's own. Equal to `0x200`'s SOC in **99.008 %** of the 847 644 frames from 2026-08-02 20:48 onward (89.259 % over the whole corpus, which is the same fact plus the skew below). The 2026-08-19 figure was 99.372 % of a 42 979-frame sample.

⚠️ Before that date it is NOT equal: it runs 2 % low in the three 2026-06-14 sessions and 4 % low in the two early 2026-08-02 ones, consistently, for every frame. The BMS config was reflashed that evening, which brackets the change, but what the older value was is unidentified — the corpus was searched exhaustively for another byte carrying it and nothing matched (`0x10A` b2 matches in one session and 53 % overall, i.e. by coincidence). The DBC's direction makes this easier to believe than it was: a figure the VCU composes for the charger is exactly the kind of number a VCU-side change moves. Kept under its own key rather than folded into `soc`, because two SOC estimates that can disagree must stay separable.

### The two gates

**Frame gate: `b1 = 0x01` and `b4-7 = 00`.** This frame is the worst-exposed of the group, because two of its three keys are measurements rather than requests-of-a-flag. An all-ones payload decodes to a 511 V target, 255 A and 255 %, and only the SOC is caught by `bounds.js`.

⚠️ Under the 16-bit reading `b1 = 0x01` is no longer a check on filler — it is a check on the high byte of a value we decode, which is the thing the `0x620` note below argues against. It is kept deliberately, because what it excludes is physically unreachable: it accepts targets in 256…511 V, and an 81-series pack cannot be charged below its 243 V under-voltage floor or above 340 V of full cells. The observed span is 284…350. The rule "gate on bytes you do not read" is the right default and this is a stated exception, not an oversight.

**Value guard: `b0 ≠ 0`.** ⚠️ Its original justification is gone. It was written because `b0 = 0` decoded to exactly 242.5 V — the offset showing through as a plausible pack voltage. Under the 16-bit reading `b0 = 0` is simply a 256 V target, no more special than 257. It is kept because 256 V is still round, still plausible, still inside `bounds.js`, and still has never occurred: b0 spans 28…94 across all 941 765 frames and is never 0, including through the ~3 s DC handshake before any current flows. It should be dead code, and the one way to find out that it is not would otherwise be a plausible voltage in the log.

---

## 0x620 `CM_EVSE_FDB`

CM → VCU. b4-7 are `00` in 100.000 % of 968 618 frames.

| byte     | factory               | decoded as               |
| -------- | --------------------- | ------------------------ |
| b0       | `CM_DC_MAX_CURR`      | `fast_dc_limit_a`        |
| b1       | `CM_AC_MAX_CURR`      | `ac_supply_limit_a`      |
| b2 bit 0 | `CM_EVSE_CHG_ENABLED` | — see below, not decoded |
| b3       | `CM_DC_MAX_PWR`       | — see below, not decoded |

**The frame name closes a question the 2026-08-19 pass left open.** `fast_dc_limit_a` was known to be "the limit in force" but not _whose_ — vehicle-advertised and station-granted look identical from this port. `CM_EVSE_FDB` is EVSE **feedback**: the charge manager relaying what the station offers. That is the station side, and it explains the ladder shape, the headroom, why it _reacts_ to a derate rather than commanding it, and why it never touches delivered current. The name `fast_dc_limit_a` stays correct — it says which limit (the live one) and not whose — and the "whose" now has a factory answer rather than a coin flip.

The two ceilings are mutually exclusive and that is the argument for reading them as a pair: across all 968 618 frames b0 and b1 are **never both non-zero**. b0 alone in 152 581, b1 alone in 784 508, both zero in 31 529 — no frame at all in the fourth cell.

### b0 `CM_DC_MAX_CURR` — a limit, put on trial and kept

🧨 #79 read this byte as "not a limit at all — it follows the delivered current", having watched it ramp 0 → 22 → 44 → 66 → 75 → 66 → 44 and read 44 while only 10 A flowed. Re-measured at full frame rate over 151 202 aligned (`0x620`, `0x615`) samples with current actually flowing, across all 11 DC sessions:

    b0 − b2 == 0 (hugging the delivery):     0.005 %      ← an echo would live here
    b0 − b2 >= 5 A of headroom:               79.2 %
    b0 − b2 median 12 A, p75 28 A, p95 41 A
    b2 > b0 (the bound broken):               0.033 %

The 44-while-10-A reading is the headroom case, not a contradiction: session 27's median gap is 35 A because the pack was at 99 % and taking almost nothing.

🟡 Headroom is a NEGATIVE and cannot separate a raw echo from a SCALED one — `b0 ≈ 1.2 × b2` would show the same never-touching. The ratio kills that: b0 ÷ b2 has p5 1.03, median 1.19, p95 7.33, max 75.0, and a per-session median from 1.03 to 9.20. No scale, offset or quantisation of a delivered current produces that.

✅ Two positive tests, which is what makes it a limit rather than merely not-an-echo:

- **b0 steps while the delivery is flat.** Of the 884 b0 steps in the DC sessions, 396 happen with b2 unchanged to within ±2 A for two seconds either side. 2026-08-04 20:13:29 b0 75 → 64 while b2 held 55 A; 2026-08-08 13:37:47 b0 75 → 66 while b2 held 43-44 A, and back up 66 → 75 two seconds later with b2 still at 43-44.
- **b0 leads the first amp.** In all eight DC sessions whose ramp-up is captured, b0 goes 0 → 75 between 13.0 and 19.1 s BEFORE b2 leaves zero — e.g. 2026-08-04 19:58:28.65 against a first amp at 19:58:45.51. Much longer than the ~3 s handshake.

⚠️ What it is NOT is a command, and #79 is right about the direction of causation. On 2026-08-04 it dropped 75 → 64 eleven seconds AFTER the delivered current had already fallen to 55.6 A. It reacts to the station.

⚠️ And "in force" must NOT be read as "binding". `b0 − b2 == 0` in 0.005 % says the corpus contains essentially no observation of this byte ever CONSTRAINING anything. The defensible claim is "a ceiling the delivery has never violated", not "the constraint doing the limiting" — there are at least three candidates for that: a pack-temperature or SOC derate, the rider's own `0x121` setting, and the station's own envelope.

The 50 frames where b2 > b0 are not counter-evidence: 49 fall within 1.00 s of a b0 step and the fiftieth is exactly 1.00 s from one, so all are the 10 Hz/20 Hz skew across an edge, none is a sustained violation, and the overshoot never exceeds 12 A.

**The three DC current limits, which are genuinely three different numbers:**

    dc_charge_limit_selected_a  0x121 b2   what the RIDER picked (charge-setpoint.ts)
    fast_dc_limit_max_a         0x625 b2   the configured ceiling, a static 75
    fast_dc_limit_a             0x620 b0   what is in force this second

### b1 `CM_AC_MAX_CURR` — the AC ceiling

The factory name confirms the reading exactly: supply-side, and 8/10/13 A are standard cable/pilot ratings. b1 takes four values across the corpus — 13 (770 985), 0 (184 110), 8 (13 446), 10 (77).

It is a ceiling on the AC setpoint: `0x10A` b7 ÷ 7 (the CHG.PWR.REF setpoint, decoded in `decode.ts`) never once exceeds it — 100.000 % of all 784 508 frames where b1 is non-zero, up from a 33 357-frame sample. And it LEADS: on 2026-08-08 19:40:13.9 it stepped 10 → 13 and the setpoint followed 9.1 → 11.9 A 120 ms later, with the mains current behind that.

🟡 It is not the mains current — b1 == floor(`0x305` mains A) in only 12 % of frames, and it sits at 13 through a 6.8 h session drawing 1.4 A. Nor is it the bike's own maximum, which is ~14.3 A.

### ❌ b2 bit 0 `CM_EVSE_CHG_ENABLED` — the name does not survive

This was the most promising of the three "one corpus query away" items: a cleaner "station says go" than anything else on the frame. **It is not that.** b2 takes only {0, 1} and bits 1-7 are 0 in 100.000 % of 968 618 frames, so the DBC is right that b2 bit 0 is the whole byte. But:

    bit 0 set while DC current flows:      0.000 % of 151 118 frames
    bit 0 set while AC mains current flows: 99.821 % of 784 586 frames
    bit 0 set with neither flowing:         4.035 % of  32 914 frames

A station delivering 73 A with its "charge enabled" bit reading 0 is not a charge-enable signal. And the byte is not independent information at all:

    (b2 bit 0) == (b1 != 0)   in 968 618 of 968 618 frames — 100.000 %

It is exactly `ac_supply_limit_a > 0`, restated as a bit. Nothing is emitted for it.

🟡 The charitable reading of the name, which cannot be told apart from the above with this data: in IEC 61851 "EVSE" means specifically the AC-side supply equipment with a control pilot, so an AC-only enable flag is coherent and the name is narrower than it sounds rather than wrong. Either way it answers nothing about a DC station, and either way it duplicates b1.

### 🟡 b3 `CM_DC_MAX_PWR` — a power ceiling, but not the station's rating

`0xFF` in 100.000 % of 807 907 AC frames. On DC it spans 9…82 over 31 distinct values, and also reads `0xFF` in 4 604 DC frames — seven of the nine DC sessions that contain any put all of them before the first real value, 2026-08-09 17:51 has 40 of its 173 interleaved after that, and the aborted attempt of 2026-08-09 14:42 has 952 of its 1 911 after the last real value as well. So `0xFF` reads as "no DC figure", covering both not-yet and never.

✅ **The DBC name passes the test it predicts and our data can run.** Over the 151 005 DC frames with a real b3 and current flowing:

    delivered kW (pack_v × pack_a) > b3 :      0.000 %
    b3 − delivered kW: median 16.96, p5 2.58, p25 3.28, p75 68.10, p95 79.09
    max(delivered kW ÷ b3) = 0.9771,  p99.9 = 0.9258

Delivered power never once exceeds it, and at the tightest point comes within 2.3 % of it. That also **bounds the scaling the DBC does not carry**: at 0.5 kW/count the "ceiling" would be violated in 48.2 % of frames and at 0.25 kW/count in 68.1 %, so the unit cannot be smaller than ≈ 0.98 kW/count. 1 kW/count is the smallest round unit that works, and a larger one would mean the ceiling is never approached within 51 %. **kW is supported, not merely plausible.**

❌ **What stays refuted is "b3 is the station's nameplate rating".** Retracted 2026-08-19 by identifying each session's charger from its own GPS track, the coordinates read out of the hub's `0x410` fixes while current flowed:

    mode  range  n        coordinates          station
      81  35-82  73 378   57.10599, 13.03703   320 kW
      20  19-20   9 394   56.50180, 12.95666   225 kW
      22   9-50  27 583   56.65757, 12.90713   400 kW
      20  20-50  21 625   56.28432, 13.33884   300 or 400 kW
      23  19-50  10 372   57.71368, 11.89764   NOT IDENTIFIED

b3 is not monotone in station power — the 400 kW site reads 22 while the 320 kW one reads 81 — and the ratios (station kW over modal b3) are 4.0, 11.3 and 18.2. No rounding, quantisation or unit choice reconciles that. `CM_DC_MAX_PWR` and "the nameplate rating" are not the same claim, and only the second is refuted: a _currently offered_ power that moves with what the station is willing to give this session fits both the name and the numbers.

⚠️ WHERE THE RATINGS COME FROM — the weakest link in that refutation and its only external input. The owner identified each charger from its coordinates on 2026-08-19, from memory plus a map: no network name, no site name, no database, no rating plate. One row is hedged across a 100 kW range and a fifth site could not be identified at all. Everything else above is a measurement; re-checking this is where any attempt to overturn the retraction starts.

❌ Also refuted, and recorded so it is not re-derived: **b3 = SOC − 18**, suggested by two replay frames (22 at 40 %, 81 at 99 %), holds in 8.14 % of samples — coincidence. And **r(b3, DC current) = −0.333** over 152 612 aligned samples, the OPPOSITE SIGN to the +0.72 the 2026-08-19 note recorded; per session it runs −0.97 to +0.78, which is what a pooled r over a quantity that is not a function of current looks like. Withdrawn, not corrected.

### ❌ `b3 == ceil(fast_dc_limit_a × pack_v / 1000)` — an artefact, not a decode

This was carried as "the strongest relation in the corpus" and an open question. It is neither. The relation is real — exact-integer match per site 92.7 % (225 kW), 82.3 % (300/400 kW), 69.8 % (400 kW), 59.5 % (unidentified), 0.00 % at the 320 kW site, 35.3 % pooled, and 99.98 % over 68 974 frames at the four sites if ±1 count is allowed — but the causality runs the other way, and one session settles it. The operator, for anyone re-deriving: `ceil`, not `floor`, which scores the same frames at 7-40 %.

🧨 **`0x620` reads `4B 00 00 1E` — b0 pinned at 75 A, b3 pinned at 30 — for 572 consecutive seconds on 2026-08-08 17:44:59, while pack voltage climbs 272.2 → 293.7 V.** `ceil(b0 × pack_v / 1000)` would have walked 21 → 23 across that window. b3 does not move at all. A second run of the same payload on 2026-08-08 18:02:34 holds another 44 s while the voltage falls 293.7 → 289.2. If b3 were a function of b0 and the pack voltage, those 6 166 frames could not exist.

What produces the identity at the other sites is that **b0 is derived from b3, not the other way round.** Where the station's available power is what binds, its current offer necessarily is that power divided by the present voltage — so `b0 ≈ b3 × 1000 / pack_v`, and inverting it recovers b3 by construction. The sites where the identity scores highest are exactly the power-limited ones; the `4B 00 00 1E` window is where b0 is clamped at the vehicle's 75 A instead, and there the identity has room to fail and does.

#### 🟡 The forward fit, and the warning that has to travel with it

The 2026-08-19 file recorded that forward relation and hedged it carefully. Both the fit and the hedge are restored here, with corrected numbers — an earlier draft of this document dropped them while promoting the mechanism above to a conclusion, which is exactly the trap the hedge exists to describe.

Over the **56 321** frames where b3-as-kW would ask for less than 75 A, `|b0 − b3 × 1000 / pack_v| ≤ 2 A` holds in **83.209 %**. ⚠️ Against a chance baseline of **25.3 % ± 0.1** (b0 shuffled within the same subset over 20 trials, which keeps both marginals and destroys only the pairing) — not the "roughly 7 %" the old file estimated, and the fit itself is 83 %, not the 98.4 % it claimed. Tightening to ±1 A drops it to 25.5 %; widening to ±3 A gives 100.000 %, which is the tell that the residual is one count of an integer-kW b3 (1 kW is ~3.3 A at these voltages) rather than a fitted error.

⚠️ **And it is a conditional fit, not a test of the model over the data, because the subset is selected on the model's own predictor.** b0 never exceeds 75, so wherever b3-as-kW implies more than 75 A the model degenerates to "b0 = 75" and cannot be wrong; excluding that region excludes precisely where a refutation could come from. The other **94 684** samples are duly consistent and prove nothing — b0 is 75 in 57.3 % of them and lower in the rest, and "lower" is what a pack-side taper produces too. Both b3 = 30 sessions (2026-08-08 17:44 and 18:02) are entirely in that region: 30 kW is ~102 A at their pack voltage, so they never enter the testable subset at all — which is why the counter-example above had to come from the untestable side, and why finding it there is evidence rather than an escape.

✅ That reconciles the factory name with the nameplate refutation: **b3 is the power presently available to this outlet, in whole kW** — which is what `CM_EVSE_FDB` / `CM_DC_MAX_PWR` says, and which need not be the cabinet's rating (the 400 kW site reads 22, the 225 kW site 20, the 320 kW site 80). Nothing is emitted for it, because "presently available power" is still an inference from behaviour rather than a measured scaling, and the kW unit is bounded from below rather than pinned.

Per-session b3, for whoever picks this up:

    2026-08-04 19:58  n=10 372  modal 23  range 19..50
    2026-08-08 13:00  n=27 339  modal 80  range 59..81
    2026-08-08 15:09  n=21 624  modal 20  range 20..50
    2026-08-08 17:44  n= 5 732  modal 30  range 30..50
    2026-08-08 18:02  n=   442  modal 30  range 30..30
    2026-08-09 14:43  n=11 940  modal 20  range 19..21   (⚠️ NOT the aborted attempt — mislabelled, see §The fault corpus)
    2026-08-09 15:23  n=27 582  modal 22  range  9..50
    2026-08-09 16:55  n=29 276  modal 81  range 35..82
    2026-08-09 17:51  n=16 811  modal 81  range 64..81

### The gate: `b3 ≠ 0` and `b4-7 = 00`

This frame's dead-sender decode is the hardest in the group to spot. An all-zero payload decodes to `fast_dc_limit_a` = 0 and `ac_supply_limit_a` = 0, and both are LEGITIMATE — every DC frame reads b1 = 0, every AC frame reads b0 = 0, and 31 529 real frames read both as 0 between sessions. So `bounds.js` cannot help, and the frame reads as "plugged in, both ceilings at zero" rather than as a missing sender.

b4-7 = `00` catches all-ones and the alternation. b3 is what separates the all-zero shape, and the argument for it is stronger than "never observed at 0": **this byte already has a "nothing to report" encoding and it is `0xFF`** — 100.000 % of AC frames plus the DC frames before a handshake completes. A field that spells "no figure" as `0xFF` is unlikely to also spell it as 0. That argument survives both the kilowatts refutation and the `CM_DC_MAX_PWR` name. The observation that b3 is never 0 across 968 618 frames (lowest 9) is the confirmation rather than the whole case.

The gate is the minimal `=== 0` and NOT the observed {0xFF} ∪ [9, 82], deliberately: baking 9…82 in would harden a range this same corpus already moved once. Values 1-8 and 83-254 pass, and should.

⚠️ Still the weakest of the gates in this file, because b3 is the one byte here whose meaning is open. If a station ever advertises zero available power, this frame goes silent at the moment it gets interesting. Judged the better risk than a decoder reporting "no ceiling on either path" for a sender that has stopped talking — but if the limits ever vanish from a live session, look here first.

🟡 One invariant is deliberately NOT used, so that it is visibly a decision. b0 and b1 are never both non-zero across all 968 618 frames — a 100.000 % invariant on the two bytes actually decoded, which would catch a byte-shifted frame that slipped past b3 and the zero tail. It is left out because it gates on the DECODE rather than on filler: a firmware that ever granted both paths at once would go silent instead of showing the single most interesting frame this ECU could produce.

---

## 0x625 `VCU_CM_LIMIT`

VCU → CM, and the one frame in this group that is NOT gated on a charge cable: it broadcasts whenever the bike is awake, parked and unplugged included, at 10 Hz. b5-7 are `00` in 100.000 % of 1 571 614 frames.

| bytes | factory                   | decoded as                     |
| ----- | ------------------------- | ------------------------------ |
| b0-1  | `V_CM_V_LIMIT`, 16-bit LE | `fast_dc_limit_max_v`          |
| b2    | `V_CMDC_I_LIMIT`          | `fast_dc_limit_max_a`          |
| b3    | `V_CMDC_P_LIMIT`          | — constant `0xFF`, not decoded |
| b4    | _not in the DBC_          | `dc_charging` / `ac_charging`  |

### b0-1 `V_CM_V_LIMIT` — the undecoded byte was a voltage's low byte

Same 16-bit shape as `0x615`: b1 = `0x01` in 100.000 % of 1 571 614 frames, so the value is `256 + b0`. b0 was on the undecoded list as "0x6B everywhere until 2026-08-09 17:55 and 0x73 in every capture after, a one-way change that no charge event in the corpus lines up with". As a 16-bit value that is **363 V → 371 V**, and both halves of the old note need correcting:

- It is a _voltage ceiling_, and it behaves like one. Highest pack voltage ever recorded on this bike: **336.7 V** (p99.9 335.5). Highest `0x615` target ever sent: **350 V**. The target is above 363 in **0 of 941 765 frames**. So `V_CM_V_LIMIT` sits 13 V above the largest request and 26 V above the largest measurement, which is what a limit looks like from underneath.
- ⚠️ A charge event lines up with it exactly. The change is at **2026-08-09 17:53:05.861, 91 seconds into the DC session that began at 17:51:34**, with 5 A flowing. It then toggles 363 ↔ 371 at frame rate for 15.5 s, holds 363 for two minutes, and settles on 371 from 17:55:22.462 after a 74 s gap in the frame. A value that flickers between old and new for fifteen seconds and then commits is the signature of something writing it, not of a reboot. (The 7 972 later frames reading 363 are all in the 2060-dated captures — see the clock artefact below — and are earlier data, not a reversion.)

Decoded for the same reason `fast_dc_limit_max_a` is: it is a configured ceiling, and the point of logging one is to notice the day it changes. This one already has.

### b2 `V_CMDC_I_LIMIT` → `fast_dc_limit_max_a`

The configured maximum DC charge current, 75 A. Static in 100.000 % of 1 571 614 frames — through DC sessions, AC sessions and parked alike — and equal to `MAX_DC_CHG_CURRENT` read from the VCU's own parameter block. The factory name confirms it is vehicle-side, which is the anchor every other current-like byte here is calibrated against.

### b3 `V_CMDC_P_LIMIT`

`0xFF` in 100.000 % of 1 571 614 frames. 🟡 Reading `0xFF` as "no power limit set" is inference from the value (and from `0x620` b3 using the same sentinel on the same bus), not from the DBC. Nothing is emitted; it is part of the frame gate instead.

### b4 — genuinely ours

**Not in the DBC at all.** `dc_charging` and `ac_charging` are genuinely this project's, and thimo's files have nothing to check them against. Re-measured at full rate, against the mode ground truth:

    bit 5 (0x20) CLEAR ⟺ DC current is flowing — 99.713 % of 151 621 frames
    bit 2 (0x04) SET   ⟺ AC current is flowing — 99.356 % of 381 060 frames

The byte takes `0x32` parked or idle, `0x12` while DC flows, `0x2C` while AC flows. Note the inverted sense of bit 5: it is asserted when NOT DC charging, so a frame that never arrives cannot be mistaken for a DC charge.

⚠️ **Both figures are below the 100.000 % / 99.995 % the 2026-08-19 pass recorded off a 43 911-frame sample, and the reasons differ.**

For bit 2 the ground truth moved, not the bit. At the original ">0.5 A of mains current" threshold the rate is 97.632 % over 802 311 frames — but a plugged-in bike sits at a steady 1.4-1.5 A mains without charging anything (the `0x10A` setpoint reads 0 in 20 530 such frames, and mains is 1.5 A at both p25 and the median with bit 2 clear). 0.5 A is below the floor of "charging". Above 2 A the rate is 99.356 % and stops moving with the threshold, which is what says the bit is fine and the threshold was not.

For bit 5 there are real exceptions, all `b4 = 0x32` — the idle value — while DC current still flows. **457 frames in eight clusters** at a 200 ms alignment window (435 in three at 50 ms, which is what an earlier draft of this section reported; the count is a property of the pairing window as much as of the bike):

    2026-08-08 13:46:29.306    0.1 s    2 frames    1 A requested
    2026-08-08 15:45:59.972    0.1 s    2 frames    1 A
    2026-08-08 18:03:18.307    0.1 s    2 frames    1 A
    2026-08-09 15:06:36.025    0.1 s    2 frames    1 A
    2026-08-09 16:09:39.345    0.1 s    2 frames    2 A
    2026-08-09 17:42:22.752   15.6 s  157 frames    5 A
    2026-08-09 17:53:05.861   12.7 s  128 frames    5 A
    2026-08-09 18:18:42.795   16.1 s  162 frames    5-6 A

The five two-frame clusters are frame skew at the very end of a taper and carry nothing. 🔍 The middle long one begins at the same instant to the millisecond as the `V_CM_V_LIMIT` change on b0-1 above, which is a genuine coincidence between two independent fields of this frame.

⚠️ **But the re-initialisation reading is weaker than that coincidence makes it sound, and the full list is why.** All three long clusters fall inside a single 36-minute stretch of one charging stop on 2026-08-09, all at 5-6 A, all at the flat end of a taper. Three isolated events across the corpus would be evidence of a repeatable state; three events in one session at one current are as easily one station's behaviour, or one taper's. Whatever the middle cluster coincides with, the other two do not coincide with anything. Recorded as an observation, not a mechanism.

⚠️ Those three are the COMMON values, not the whole set, and the difference decides how this frame is gated. Over all 1 571 614 frames b4 takes nine values:

    0x2C 748 103   0x32 542 723   0x12 151 187   0x29  76 724   0x6C  36 564
    0x72  15 466   0x2D     495   0x2E     347   0x52       5

All nine satisfy both bit rules, so the decode is unaffected — but a whitelist of {0x12, 0x2C, 0x32} as the frame's sanity check would have thrown away 129 601 real frames, 8.2 % of them. That is why the gate reads b1/b3, which are genuinely constant, rather than the byte whose meaning we are trying to read. Anyone hardening this frame further will look at the three named values and reach for the whitelist; this is the note saying it was tried and is wrong.

These are "current is flowing", not "a session exists" — through the 139.3 s aborted DC attempt of 2026-08-09 14:42 b4 stays `0x32` while `0x605` b2 says DC and `0x610` says the session is established. That is the right split, and it is why both are logged.

### The gate: `b1 = 0x01` and `b3 = 0xFF`

Trusting b4 blindly is actively dangerous, because b4's DC bit is read INVERTED. An all-zero payload has bit 5 clear and would decode to "DC charging"; an all-ones payload has bit 2 set and would decode to "AC charging". Those are precisely the two shapes `check-can-decoders.ts` calls out as what a dead or disconnected sender produces, and because both keys are legitimately 0/1, `bounds.js` cannot reject either — a false charge claim would reach the log and the dashboard looking like an ordinary flag.

⚠️ b1 is now known to be the high byte of `V_CM_V_LIMIT`, so like `0x615`'s gate this one reads a byte we decode. Same justification: it accepts limits in 256…511 V, and this pack's ceiling cannot sit outside that.

---

## 0x600 `CM_WD` — and the temperature that is not one

CM → bus, 10 Hz, 964 526 frames. Nothing is decoded from it.

| bytes    | factory                 | corpus                                                      |
| -------- | ----------------------- | ----------------------------------------------------------- |
| b0 bit 0 | `CM_WD_SIGNAL`          | 1 in 964 421, 0 in 105                                      |
| b1-3     | `MSP_Version`           | constant `01 06 11`                                         |
| b4-5     | _not in the DBC_        | a free-running 10 ms tick, +10 per frame, wraps every 655 s |
| b6-7     | `CM_TEMP_DC`, 16-bit LE | ❌ see below                                                |

b4-5 is genuinely decoded and genuinely useless to log: a wrapping counter with no epoch is noise in a time series. The DBC leaves it undefined, which is consistent.

### ❌ `CM_TEMP_DC` does not survive the corpus

This looked like the answer to a refuted decode. The 2026-08-19 pass had tested "b6-7 × 5 mV = the 12 V rail" — `psu_12v_mv ÷ b6-7` has a median of 4.93, and 2530 → 12.65 V, 2750 → 13.75 V is the right rest-to-charging span — and refuted it with r(b6-7, `psu_12v_mv`) = −0.023 on DC and −0.003 on AC over 255 843 aligned samples. A temperature would explain that r ≈ 0, and 2530-2750 raw is 25.3-27.5 °C at 0.01 °C/count, the right magnitude for a charge session.

**It is not a temperature, at 0.01 °C/count or at any other scale.** Three measurements, none of which a physical temperature can produce:

1.  **It jitters far faster than it drifts.** Between consecutive frames 100 ms apart, |Δ| has median **35 counts**, p95 161, p99 224, max 2 656; 67.3 % of consecutive frames move by more than 20 counts and only 6.9 % do not move at all. At 0.01 °C that is 0.35 °C every 100 ms. A raw slice from 2026-08-04 00:33:16, one frame per line:

        01 01 06 11 D4 C2 FF 09   -> 2559
        01 01 06 11 DE C2 77 0A   -> 2679
        01 01 06 11 E8 C2 20 0A   -> 2592
        01 01 06 11 F2 C2 3F 0A   -> 2623
        01 01 06 11 FC C2 00 0A   -> 2560
        01 01 06 11 06 C3 70 0A   -> 2672

2.  **Its slow component is flat everywhere.** 60-second medians across the whole corpus span p5 2581, p50 2585, p95 2591 — ten counts, 0.1 °C. Per DC session, the 60 s medians barely move at all:

        2026-08-04 19:58  63 A median   2589 2591 2585 2589 2575 2587 2585 2583 2583
        2026-08-08 13:00  73 A median   2591 2591 2589 2589 2589 2589 2589 2587 2589 2590
        2026-08-08 15:09  57 A median   2583 2589 2589 2589 2589 2589 2587 2583 2587
        2026-08-09 16:55  26 A median   2589 2587 2581 2583 2583 2587 2585 2589 2583

3.  **A 73 A DC charge is statistically indistinguishable from a 1 A AC one.** Median 2587 on DC-current frames (n = 149 581) against 2585 on AC-mains frames (n = 781 148); p5 2495 and p95 2688 in both. r(b6-7, DC current) = +0.0029. r against the pack temperatures is −0.017 raw and −0.043 on 60 s medians.

Whatever the field is, either the DC path does not heat measurably during a fast charge — which would make the signal useless even if the name is right — or the bytes are not carrying a temperature. It stays undecoded.

🔍 One structural lead for whoever tries again, recorded because it is not what an NTC looks like. The value is confined to 2304…2816 with the high byte only ever 9 or 10, and the low byte clusters hard on multiples of 32 and one below them: the commonest b6 values are `FF` (163 841), `00` (106 486), `40`, `1F`, `1D`, `20`, `80`, `01`, `BF`, `1B`, `7F`, `3F`, `60`. Read as 8.8 fixed point the whole thing is ≈ 10.0 with a 1/8 step. 287 distinct values in 964 526 frames. The 12 V-rail reading is dead for a second reason now as well: the rail moves 8.7 % between rest and charging while this field's 60 s median moves 0.4 %, so no scaling relates them.

---

## The four frames in neither factory file

`0x630`, `0x631`, `0x635` and `0x645` appear in neither the DBC nor the `.sym`, consistent with this project finding them undocumented. Nothing is decoded from any of them.

### 0x630 — DLC 3, and a poll addressed per ECU

The only DLC-3 frame on a bus where almost everything is 8. 1 964 694 frames. b0 takes {`0xA1`, `0xA2`, `0xA3`, `0xA5`, `0xA9`, `0xEA`} — the first five are precisely Energica's own `MotorbikeECU` node ids (BMSuControl `0xA1`, Logo `0xA2`, CNode `0xA3`, DCDC `0xA5`, VCUControl `0xA9`), which says `0x630` is addressed per-ECU. `0xEA` is not in that enum and appears 18 times.

thimo's observation that "byte 2 sometimes echoes byte 0" holds, and the corpus makes it sharper — **the echo is per node and total**, not occasional:

    b0    n         b1                      b2
    0xA1  968 698   0xFF always             0x1B (AC) / 0x07 (DC) / 0x00 / 0x11
    0xA2   26 893   0xFF always             0x01 (26 725) / 0x00 (168)
    0xA3      293   0x00/0x01/0x04/0x05     0xA3 in 276 of 293  ← echo
    0xA5  968 623   0x01 always             0xA5 in 968 623 of 968 623  ← echo
    0xA9      169   0xFF always             0x04 / 0x05 / 0x00
    0xEA       18   0x00 always             0xEA in 18 of 18  ← echo

b0 does not "walk" A1…A9 either: A1 and A5 each arrive at 10 Hz and account for 98.6 % of the traffic, while A3, A9 and EA are rare. It smells like an address/value poll, with the echoing nodes answering their own id and the others answering something else. What b1/b2 mean per node is not established; the A1 entry's `0x1B` on AC against `0x07` on DC is a real difference with no interpretation behind it.

### 0x631

b4's bit 0 alternates on every frame at 20 Hz, which `CAN_MAP.md` recorded as "b4 twitches 50 ↔ 51". It is a toggle and NOT a multiplex selector: split the frames on it and the two halves are byte-identical in every other position, in all three DC sessions checked (b0 = 04, b1 = 00, b2 = 11, b3 = 23, b5 = 00, b6 = 05, b7 = 02 in both). On AC the toggle does not happen at all — b4 is `0x00` in 12 280 of 12 280 frames of the 6.8 h overnight session — so it is DC-only. `b4 & 0xFE` is mostly `0x32` on DC and `0x00` on AC, though at full rate it also takes `0x1A` (1 976 frames) and `0x18` (1 950), which the sampled pass missed.

b3 is a mirror of `0x610` b7: equal in **99.970 %** of 1 912 889 aligned frames (the sampled figure was 99.860 % of 326 075). Not decoded, precisely because it is a duplicate — a second key for the same quantity whose 0.14 % of disagreements would read as a bug rather than as the frame skew it is. b0 is 3 on AC and 4 on DC, and b2 is 0 on AC and `0x11` on DC; neither is decoded, as `0x610` already carries that distinction with a better-evidenced byte.

### 0x635

b0-2 are the constant `DC DD 24` (100.000 % of 968 595 frames). b3-5 take exactly two values: `FF FF FF` in 811 282 frames and `F2 3D 0E` in 157 313, resolving to the second about 2.7 s into a DC handshake.

❌ `CAN_MAP.md`'s standing guess, "station / session / transaction identifier … needs a second session at a different charger to test", is REFUTED: `F2 3D 0E` is byte-identical in all eleven DC sessions, across three days and several different chargers. Whatever it is, it is a constant the vehicle learns at handshake, not anything about the station.

### 0x645

All eight bytes are `00` in 100.000 % of 157 441 frames, so only its presence carries anything — and that presence is a clean DC-session flag: it appears in all 11 DC sessions and in none of the 18 AC ones. It tracks the SESSION, not the current: it is there for all 139.3 s of the aborted DC attempt of 2026-08-09 14:42, during which not one amp flowed. That is what makes it the ground truth for `bms_leak_detect_inhibit`'s session-level match rate above. Nothing is emitted, because a decoder returning a value for an all-zero frame would be logging "this id exists", which `STREAM_IDS` already says.

---

## The fault corpus

### 🟡 Is `CM_ERROR_SRC` the DTC symptom number? Probably not, and here is the timing

Energica's `dtcodes.emsd` gives component **54 = CM ERROR** fourteen named symptoms, C1003…C1018 — all fourteen already in `src/diagnostics/dtc-table.ts` from an independent source, which is why a stored `C1010` renders as PROTOCOL ERROR on the Faults tab today. All fourteen store the same five info-keys, including **118 `CM_ERROR_SOURCE`, 119 `CM_ERROR_CODE_MSB`, 120 `CM_ERROR_CODE_LSB`** — the same two fields `0x610` carries live.

That invites an obvious identification: our live sources are **7 and 8**, and symptoms 7 and 8 are `PROTOCOL ERROR` and `CM APPLICATION LAYER ERROR`, both layer names, which is the sort of thing a "source" holds. ⚠️ **Do not adopt it.** The corpus argues against it, and the timing is what makes the argument bite:

|                         |                                                              |
| ----------------------- | ------------------------------------------------------------ |
| E2 fires `src 8`        | 2026-08-08 **17:41:32**                                      |
| the stored list is read | 2026-08-08 **18:21**, forty minutes later                    |
| symptom 8 is `C1011`    | **not in the stored list**                                   |
| symptom 7 is `C1010`    | **is** in the stored list, matching src-7 episodes E1 and E3 |

So "the DTC had not latched yet" does not explain the miss — C1011 had forty minutes. Stored symptoms are `{0, 3, 5, 7, 9, 11}`; observed sources are `{0, 7, 8}`. One clean match, one clean miss, and four stored symptoms whose number has never appeared as a source.

Two readings survive and this corpus cannot separate them: the source is not the symptom, **or** it is and E2 never latched a DTC at all — E2 ends with the capture, so how it resolved is unknown.

⚠️ **The code is a separate question and is not named by anything.** 853 (`0x0355`) and 1101 (`0x044D`) are not C-numbers, there is no `VAL_` table for `CM_ERROR_CODE` in the factory DBC, no `/e:` enum in the `.sym`, and neither value appears in the manufacturer's service tool's resource bundle. Two values is a list, not a pattern.

**What would settle it**, in order of cost: read a stored component-54 DTC whose `118` is non-zero and compare it against the symptom it was filed under. We have exactly one component-54 freeze frame — `(54, 11)` `C1014` UNCLASSIFIED CM ERROR — and its `118/119/120` triple is **`0, 0, 0`**. 🟡 That is itself a lead: `C1014` UNCLASSIFIED may be precisely the symptom stored _when there is no source and code to store_, in which case the informative freeze frames are the other thirteen and this one never could have helped.

— every charge failure in the archive, and what it decodes to

Written 2026-08-20 from a fresh sweep, to answer one question: **with every fault the archive contains, what can actually be decoded about `charge_manager_error_src` and `charge_manager_error_code`?** The short answer is at the top of §"What the failures share", and it is mostly negative. The useful results are elsewhere: a second, independent frame that agrees with these bytes, a fourth failure the error bytes did not report at all, a step-path split that is clean but tiny, and two things in this document that were wrong.

### The sweep, and what it covers

Every `.log` in `~/Documents/cool-eva-archive` over 1 024 bytes — **116 files**, the other 209 being 0- or 22-byte service stubs with no frames in them — plus `can_log-2026-06-14.txt` in its own format, grepped for `0x610` with a non-zero `data[1]`. That is 100 % of the raw CAN on this disk; `.celog` files are this project's own derived output and are not raw.

    0x610 frames, raw:      850 361 in the 116 .log files + 71 027 in the .txt = 921 388
    with data[1] != 0:      500, in 3 files
    in can_log-2026-06-14:  0 of 71 027

🟡 The 500 matches the count already in this document exactly, and the three windows are the same three. Nothing new was found by looking harder, which is the first thing worth saying. ⚠️ But 921 388 raw is **fewer** than the 968 629 "deduplicated" this document records above, and deduplication can only remove frames. One of the two counts is wrong; the fault conclusions do not depend on which, because the sweep here reads every file and the fault frames are 500 either way. Recorded so the next person recounting does not think they have found a new discrepancy.

⚠️ **There is a third number, and the mechanism has a name: `~/Documents/cool-eva-archive/ride-captures3/` is a duplicate directory.** All 59 of its `.log` files share a basename with a file at the archive root, and the ones compared are byte-identical (`capture-20260804-035625-c8fe853f.log`, same SHA at both paths). A RECURSIVE sweep therefore counts them twice: 906 305 raw `0x610` frames instead of 850 361, and 339 intermediate b7 frames instead of 319 — the difference is exactly the duplicate contribution. **No fault conclusion moves**: all 500 fault frames and all 3 563 VCU-flag frames live in three non-duplicated root files. But "that is 100 % of the raw CAN on this disk" is the sentence every coverage claim rests on, so how the file set was enumerated has to be stated with it.

⚠️ **And segmenting by capture file is necessary, not sufficient.** `capture-20260809-144317-edcdcf23.log` carries **62 frames stamped `2060-02-09`** out of roughly 7 million, producing an apparent −3600.8 s jump in the middle of one file. Negligible here, and the same failure family as the cross-file clock skew above: a bad clock inside a single file is not caught by "segment by capture file first".

Every frame of `0x610` in the archive is DLC 8, so no fault frame can have been missed by a length mismatch.

### There are FOUR failed charge attempts, not three — and the fourth has no code

The three `0x610` error episodes are not the whole set of charge failures, because **the VCU has its own rollup and it fires in a fourth place where the charge manager published nothing.**

A second archive-wide sweep, for `0x100` byte 7 bit 1 — `vcu_err_charge_manager`, Energica's `ERR_ChargeCM_Out` — finds it set in **3 563 frames, in exactly three capture files, all within four events**:

| # | when | where | `0x610` code | duration of the VCU bit |
| --- | --- | --- | --- | --- |
| E0 | 2026-08-09 14:37:09.720 | 56.50178, 12.95665 | **none — src and code stay 0** | 269.7 s |
| E1 | 2026-08-02 18:55:16.011 | no GPS fix | (7, 1101) | ≥ 17.3 s, capture ends |
| E2 | 2026-08-08 17:41:32.413 | no fix in either capture † | (8, 1101) | ≥ 6.5 s, capture ends |
| E3 | 2026-08-09 14:41:46.240 | 56.50178, 12.95665 | (7, 853) | 62.6 s |

⚠️ **Durations here are the frame span plus one 10 Hz tick**, on the reading that the last frame holds for its own period. So E1's eight error frames span 0.700 s and are reported as 0.80. Defensible, but it must be stated or anyone re-deriving gets a different number: E3 43.70 → 43.80, E0's VCU window 269.62 → 269.7, E3's 62.51 → 62.6.

† E2 has **no position**. Its own capture carries no `0x410` at all, and the next capture has no fix until 18:03:28 — after its session had ended. An earlier draft filled the gap with 55.72463, 13.14987 "from the capture two minutes later, at the same stop"; that is one sample at 18:05:18 on a moving track, ~24 minutes later and about 1 km away. E1 has no fix either — the hub reports 0, 0 — and nor does the capture that follows it.

✅ **The two fields corroborate each other, and this is the strongest single result here.** In all three episodes that have a code, the VCU raises its rollup bit **0.162, 0.163 and 0.162 s** after the charge manager's first error frame — one 10 Hz tick plus change, three times, to the millisecond. Two ECUs on two frames agreeing on the same event that precisely is what says `data[1]`/`data[2:3]` really are the fault path and not a coincidence of bytes.

❌ **This corrects §0x610 above and `src/can/vcu-flags.ts` together.** This document said "`vcu_err_charge_manager` … remains 0 in every captured frame — including all three windows above". `src/can/vcu-flags.ts` says "⚠️ `ERR_ChargeCM_Out` reads 0 in all 105 736 — a NEGATIVE and nothing more … **This decode has never been seen to fire.**" Both are wrong, and the 105 736-frame sample is why: the bit is set in 3 563 frames out of an archive with millions, all inside four short windows. **The decode has fired, four times.** It was decoded on Energica's word alone, before anything had ever exercised it, and that is the case for having decoded it. 🔍 The note in `vcu-flags.ts` pointing at "the one window where the charge manager did complain (2026-08-09 12:38-12:42)" is chasing a window that has no local raw CAN; the confirmation was in the archive the whole time, at 14:37 and 14:41 on the same day.

⚠️ **The two are not equivalent, and E0 is why.** At 14:37 the VCU raised the bit and held it for 269.7 s — through the whole gap to the next attempt — while `0x610` b1-b3 stayed `00 00 00` throughout. It cleared at 14:41:39.440, the instant the charge manager woke for E3, and came back 6.8 s later with E3's own error. E0 never became a DC session at all: `0x615` was never transmitted, `0x645` never appeared, `0x605` b2 never reached 2, and `0x610` b0 sat at `0x00` — no inlet present, no lock — for 12.4 of the 14.8 s the charge manager was on the bus. So the VCU's rollup covers charge failures the charge manager's own code does not report, and **an "any charge fault" alarm must read both**. It is also the counterexample to any hope that a fault always publishes a code: the most likely diagnosis for E0 is an inlet or plug-detection failure, and it produced no `CM_ERROR_SRC` at all.

### The three (src, code) pairs

    (7, 1101)   E1   2026-08-02 18:55:15.849 → 16.548     8 frames    0.80 s
    (8, 1101)   E2   2026-08-08 17:41:32.250 → 37.550    54 frames    5.40 s
    (7, 853)    E3   2026-08-09 14:41:46.078 → 14:42:29.781   438 frames   43.80 s

Three episodes, two sources, two codes, and the pairing is not one-to-one in either direction — source 7 emits both codes and sources 7 and 8 both emit 1101. That is already in this document and the sweep confirms it exhaustively rather than adding to it. **`src` never takes a third value; `code` never takes a third value.** Two samples of each is a corpus that cannot support a table, and no amount of care changes that.

The values `data[1]` takes archive-wide are only `0`, `7` and `8`. `data[2:3]` takes only `0`, `853` and `1101`.

### Episode by episode, and the 30 seconds before

Reconstructed at full frame rate from the raw captures. Pack state comes from `0x200`, BMS flags from `0x201`, position from `0x410`.

**E1 — 2026-08-02 18:55, (7, 1101), the shortest.** The charge manager wakes at 18:55:12.913 (first `0x605`). `0x610` b0 walks `0x10` → `0x08` → `0x0A`; at 18:55:14.313 the VCU declares a DC session (`0x605` b0 = `0x11`, `charge_type` = 2, `bms_leak_detect_inhibit` = 1) and `0x645` appears. At 18:55:15.849 — **2.94 s after the charge manager first spoke** — one frame carries the error and `b7` = `0x23` together. Eight frames later the entire charge-manager group leaves the bus for 2.6 s and comes back with `0x630`'s `0xA1` slot reading `0x1B`, the value §0x630 records for AC. Pack: SOC 38 %, 288.0 V, −0.2 A, 13/14 °C, `0x201` state `0x01` Discharge, error and warning words both zero. No GPS fix (0, 0), and the capture that follows also has no fix, so this one is indoors. No `0x305`/`0x306` anywhere in the capture — nothing was charging before it.

**E2 — 2026-08-08 17:41, (8, 1101), the one with a dead bus in front of it.** The capture opens at 17:39:43 with the session already at `b7` = `0x23`, b0 = `0x2A`, SOC 9 %, 272.2 V, 35 °C. Then **the entire bus goes silent for 92.72 s** — not one frame of any of the 62 ids, `0x101`/`0x102`/`0x104` included, from 17:39:59.003 to 17:41:31.720, in the middle of one continuous capture file. 0.53 s after traffic resumes the error appears; it holds 5.4 s; the file ends 1.4 s later and the next capture carries a new boot id. ⚠️ A hole this shape has two readings and this capture cannot separate them: the bus was down, or the Pi's `can0` was. The `thermometer` service re-initialising the interface is a documented way to kill a reader (`CAPTURES.md` §Gotchas), which argues for the second; a reader that died would normally not resume inside the same file, which argues for the first.

**E3 — 2026-08-09 14:41, (7, 853), the one with the most in it.** Charge manager wakes 14:41:39.441; the handshake steps `0x02` → `0x14` → `0x04` → `0x07` → `0x09`; at 14:41:46.078 the same frame carries `0x23` and the error. **6.64 s after the charge manager first spoke.** The error holds 43.80 s and clears at 14:42:32.481. Pack: SOC 9 %, 269.9-271.1 V, −0.1 A, 35/35 °C, BMS error word zero. Position 56.50178, 12.95665 — the same station as E0 four minutes earlier.

🔍 **One concrete thing E3 shows that the others cannot.** `0x605` and `0x615` — the two VCU→CM frames — **stop entirely for 46.00 s**, from 14:41:46.142 to 14:42:32.145 — beginning 0.064 s after the first error frame and ending 0.336 s before the error clears. `0x625` keeps broadcasting throughout, so this is the VCU dropping the session conversation specifically, not the VCU going quiet. E1 does the same for 3.00 s. In both cases the last VCU frame is **0.063 s after** the charge manager's first error frame — inside one 100 ms tick, so the capture cannot say which caused which, and it would be wrong to read it as either.

Both readings are worth writing down because they point opposite ways: a CM that raises an error and a VCU that then withdraws, or a VCU that withdraws and a CM that reports the withdrawal. The second would sit naturally with `C1006 CM-VEHICLE COMMUNICATION ERROR`, whose factory description is "Charging Manager is not communicating with the motorcycle". 🟡 That is a hypothesis on two samples with a 63 ms ordering that resolves neither way, and nothing here promotes it further.

### Mode A or Mode B — classified from the bus, and they do split

The owner describes two failure modes that feel different from the saddle: **Mode A**, the bike drops out of charging and the charger errors, and a retry works without a restart; **Mode B**, the bike hangs about a minute on a "DC fast charging initialisation" screen, cannot be switched off, and has to be waited out. Mode B implies something power-cycled or hung; Mode A does not. The test is whether the bus keeps running, using `0x101`/`0x102`/`0x104` at 100 Hz as the pulse.

|               | bus gaps > 0.2 s in the window        | reading                                    |
| ------------- | ------------------------------------- | ------------------------------------------ |
| E0            | **0**, over 2.5 min at 100 Hz         | Mode A                                     |
| E1            | **0**, over 2.5 min at 100 Hz         | Mode A                                     |
| E2            | **one, of 92.72 s**, every id at once | **Mode B, or a capture artefact**          |
| E3            | **0**, over 6.2 min at 100 Hz         | Mode A (agrees with the owner's own check) |
| 15:23 success | 0                                     | —                                          |

So three of the four look like Mode A on the one test available: 15 099 (E0), 15 333 (E1) and 36 819 (E3) consecutive frames of `0x101` with no gap over half a second, straight through the fault, the clear and the retry. **The one that is not is E2** — and E2 is also the only one of the four whose capture file ends within 1.4 s of the last error frame, with the next capture carrying a new boot id 9 s later.

⚠️ **This is suggestive and it is not proof, for the reason in §E2 above**: a 92.7 s hole in a single continuous candump is what a dead bus looks like and also what a re-initialised `can0` looks like. What can be said without hedging is that the bus-continuity test **works** and **separates** — it is not a test that says the same thing about every episode.

🟡 If the split is real, the pairing so far is `(7, 853)` and `(7, 1101)` with Mode A, and `(8, 1101)` with Mode B — i.e. **`src` 8 with the hang and `src` 7 with the clean drop-out**, on one sample of each. That is exactly the shape of claim this project has shipped wrong before, so it is recorded as the thing to check on the next fault and nothing more. The prediction it makes is cheap to falsify: a Mode A failure reporting src 8, or a Mode B failure reporting src 7, kills it.

### What the failures share that the successes do not

**Mostly nothing, and the honest answer is that for two of the three episodes there is no "before" to compare.** E1 faults 2.94 s after the charge manager first speaks and E3 6.64 s. The 30 seconds before each is 27 and 23 seconds of a parked bike with the charge manager asleep — which is byte-for-byte the same thing as the 30 seconds before every successful session.

Everything measurable was compared against the successful 2026-08-09 15:23 session (47 min, 69 A) and against the corpus's other DC sessions. **None of it separates:**

|                | E1           | E2               | E3               | success 15:23    |
| -------------- | ------------ | ---------------- | ---------------- | ---------------- |
| SOC            | 38 %         | 9 %              | 9 %              | 25 %             |
| pack V         | 288.0        | 272.2            | 269.9            | 282.4            |
| pack temp      | 13/14 °C     | 35/35 °C         | 35/35 °C         | 35/35 °C         |
| `0x201` state  | `0x01`       | `0x01`           | `0x01`           | `0x01`           |
| BMS error word | 0            | 0                | 0                | 0                |
| `0x625` limits | 363 V / 75 A | 363 V / 75 A     | 363 V / 75 A     | 363 V / 75 A     |
| station        | no fix       | 55.7246, 13.1499 | 56.5018, 12.9567 | 56.6576, 12.9072 |

SOC, pack voltage, both pack temperatures, the BMS state byte, the BMS error and warning words, the vehicle's own configured limits, the `0x615` target voltage — every one of them is inside the range the successful sessions cover. **There is no pack-side or configuration-side precondition in this data.** That is a real answer and it is the answer.

🧨 **And the station is not it either, which one visit settles on its own.** E0 failed at 56.50178, 12.95665 at 14:37 with no code. E3 failed at the same coordinates at 14:41 with (7, 853). Then, at the same coordinates, in the same visit, the bike charged for **19.9 minutes at up to 60 A** — the session that runs 14:46:47 → 15:06:38 in `capture-20260809-144317-edcdcf23.log`, whose own `0x410` fixes read 56.50178, 12.95665. Same charger, same cable, same pack at 9 % and 35 °C, minutes apart, two failures and then a success. Whatever `(7, 853)` is, it is not "this station does not work with this bike".

⚠️ **E2 has no position, and an earlier draft gave one to five decimals.** It said 55.72463, 13.14987, "from the capture two minutes later, at the same stop". E2's own capture has zero `0x410` frames, and the next capture has no fix at all until 18:03:28 — after its session had ended. That coordinate is a single sample at 18:05:18 on a continuous MOVING track (~100 m every 4 s, ≈ 90 km/h), roughly 24 minutes later and about **1 km** from where the bike actually stood; the last stationary fixes are near 55.7158-55.7169, 13.1560. The substance is unaffected and was re-derived: E2 fails, and the same stop delivers 73 A two minutes later.

**And E2's stop does the same thing independently.** E2 fails at 17:41:32; at 17:43:40 — the same stop — the bike starts the session that delivers **73 A** for the next 11 minutes. Two stops, two failure-then-success pairs, on two different days at two different chargers.

❌ **"The station never offered anything" is NOT the discriminator, and this is the trap.** `0x620` reads `00 00 00 FF` for the whole of all three episodes, which looks decisive until it is timed. The successful 15:23 session **also** reads `00 00 00 FF` for its first **25.04 s** — and E1 faults at 2.94 s and E3 at 6.64 s, both well inside that. Across the corpus, in the six sessions captured from the charge manager's first frame, the first real offer arrives at **+9.5, +9.6, +10.6, +10.7, +13.5 and +25.0 s**. (A seventh, 2026-08-08 17:43, reads +64.2 s, but its capture opens mid-session so its zero is the capture start rather than a wake — an upper bound, not a measurement.) At the instant either fault fires, "no offer yet" is the normal state. It is confirmed that no offer ever came in any failed attempt, and that is a description of the failure, not a precondition of it.

🟡 One lead that is not nothing and is also not much: **`0x630` with b0 = `0xA1`, byte 2.** It reads `0x07` through a live DC session and `0x00` otherwise (this document's §0x630 records `0x1B` on AC against `0x07` on DC). In E1 and E2 it drops `0x07` → `0x00` **0.387 s and 0.387 s before the first error frame**; in E3 it does not, staying `0x07` for the whole 43.8 s of the fault and only dropping at teardown. Two identical numbers out of three tries, and no control was run over how often that byte drops without a fault, so this is recorded as an observation for whoever has more faults, not as a signal.

### `b7` step semantics — a clean split on nine samples

Every `0x610` `b7` path in the archive, computed **per capture file** so that no path is stitched across two files with different clocks (see the artefact note below). Nine handshakes begin at `0x02` and are therefore complete:

| when             | path out of `0x02`                    | outcome                              |
| ---------------- | ------------------------------------- | ------------------------------------ |
| 2026-08-04 19:58 | `14 04 07 0D 11 12 11 23`             | delivered 66 A                       |
| 2026-08-08 13:00 | `14 04 07 09 11 12 11 23`             | delivered 73 A                       |
| 2026-08-08 15:09 | `14 04 07 0D 11 12 23`                | delivered 66 A                       |
| 2026-08-09 15:22 | `14 04 07 0D 11 12 11 12 11 23`       | delivered 69 A                       |
| 2026-08-09 16:55 | `14 04 05 07 09 0D 11 12 11 12 11 23` | delivered 73 A                       |
| 2026-08-09 17:51 | `14 04 07 09 11 12 11 12 11 23`       | delivered 11 A                       |
| 2026-08-02 18:55 | `23`                                  | **fault (7, 1101)**                  |
| 2026-08-09 14:41 | `14 04 07 09 23`                      | **fault (7, 853)**                   |
| 2026-08-09 14:42 | `14 04 23`                            | no fault, nothing delivered in 139 s |

Plus one partial that starts mid-path at `0x04` (2026-08-09 17:55, `04 05 07 09 12 11 12 11 12 11 23`, delivered 66 A) and eleven fragments that open already at `0x23`.

✅ **What can be concluded.** All **six** complete handshakes that delivered current pass through both `0x11` and `0x12`; the seventh delivery, the partial, does too. All **three** that delivered nothing reach `0x23` without either. Seven for seven and three for three — and the split does not depend on the fault bytes, since the third no-delivery case has none. On this corpus, **`0x11`/`0x12` is where a DC handshake either completes or does not**, and `0x23` on its own says nothing about whether charging will start.

⚠️ **What cannot.** Nine samples, six of one outcome and three of the other. And the split is partly circular for E1 and E3: in both, `0x23` and the error arrive in the same 10 Hz frame, so "reached `0x23` without `0x11`" and "faulted" are one observation described twice, not two agreeing observations. The 2026-08-09 14:42 retry is the case that rescues it from being circular — no error bytes at all, no `0x11`/`0x12`, no current — and it is one sample.

⚠️ **And the step vocabulary is far thinner than the paths make it look.** Across all 850 361 raw `0x610` frames, `b7` reads:

    02  693 029      23  157 013      04  180      11   89      07   16
    12   12          14    9          09    7      0D    4      05    2

**Every intermediate step in every table above rests on 319 frames in total, 0.0375 % of the id.** `0x05` has been seen twice ever, `0x0D` four times. A step held for under ~100 ms cannot appear at 10 Hz at all, so no path here is known to be complete, and two paths differing is established while either path being the whole truth is not. The DBC does not name this byte; nothing here names it either.

✅ Consistent with PR #105, and worth restating from a second direction: **`0x09` is not an abort marker.** It appears in four of the seven paths that delivered current (13:00, 16:55, 17:51, 17:55) and in one that faulted.

### The code value itself — no structure recoverable from two numbers

`853` = `0x0355`, `1101` = `0x044D`. Everything below was checked and none of it produced anything:

- **Not a DTC number.** `src/diagnostics/dtc-table.ts` carries fourteen charge-manager codes under component 54, `C1003`…`C1018`. Neither 853 nor 1101 is any of those numerals, nor a component/symptom pair (`853` → 3/85 and `1101` → 4/77 under a byte split; symptoms only run 0-15), nor a decimal split that lands in range.
- **Not a subsystem in the high byte, on two samples.** The high bytes are 3 and 4 and the low bytes 0x55 and 0x4D. With one code per high byte there is nothing to test.
- **Nothing on disk carries either number** in a charge-manager context — `obd-garage/`, the service-tool extracts, the factory PDFs and the community repos were all searched.
- 1101 − 853 = 248, which is not 256 and not anything else.

🟡 **One coincidence that is worth naming precisely so it is not mistaken for a finding.** `CM_ERROR_SRC` takes the values 7 and 8, and component 54's symptoms run 0…13, so both land in range — and (54, 7) is `C1010 PROTOCOL ERROR`, (54, 8) is `C1011 CM APPLICATION LAYER ERROR`, both plausible for a failed CCS handshake. **It is very likely a coincidence.** Energica's freeze-frame shortlist for every one of `C1003`…`C1018` is `[VEHICLE_SUBSTATE, VCU_CM_COM_BYTE0, CM_ERROR_SOURCE, CM_ERROR_CODE_MSB, CM_ERROR_CODE_LSB]` — the source is captured _alongside_ the symptom, in all fourteen. A field that is stored next to the symptom is not the symptom. Two values in a fourteen-wide range is also a 1-in-... nothing: any two values would have landed in it.

⚠️ **A real risk in the current decode, from the factory side.** Every factory artefact on this machine describes these as **three independent `uint8_t`** — `CM_ERROR_SOURCE` (118), `CM_ERROR_CODE_MSB` (119), `CM_ERROR_CODE_LSB` (120) — with no equation and no combination rule. The "signed 16-bit little-endian" reading comes from thimo's DBC alone. The two agree on the observed data (`b3` is the MSB, `b2` the LSB, so `i16le` and `MSB×256 + LSB` give the same 853 and 1101), and they diverge only above 32 767, where `i16le` returns a negative. `bounds.js` admits −32 768…32 767 so nothing would be dropped, but a code of 40 000 would be logged as −25 536. Left as is, because changing a decode on a hypothetical is worse than recording the exposure — but if a negative `charge_manager_error_code` ever appears in the log, it is this and not a bike fault.

### The factory files, re-checked specifically for an enumeration

**There is no enumeration of `CM_ERROR_SOURCE` or `CM_ERROR_CODE` values anywhere on this machine.** Checked and negative: the manufacturer's telemetry-scaling table (ids 92, 118, 119, 120 — `unit` and `equation` columns empty), a byte-level scan of the service tool's shared library, the manufacturer's CAN signal database and the service tool's network library (zero occurrences of the strings at all), the embedded JSON resource inside the service-tool executable (the signals are there, `"equation": ""`), the rider-supplied `.xdbc`, the type-approval PDF, the Ribelle workshop and owner manuals, `Component and diagnosis information`, and the three community repos. thimo's own report says the same from the DBC side: names only, factor 1, offset 0.

Two things the search did turn up that this document did not have:

🟡 **`0x610` is in no factory CAN database on this disk.** The manufacturer's CAN signal database, extracted from a 2024 service-tool build, has no entry for id `0x610` — its highest is `0x501` — and the 2022 type-approval PDF reaches `CM_V_COM_BYTE0` as a diagnostic freeze-frame info-key over KWP2000, not as a broadcast frame. **The `CM_V_COM` / `CM_ERROR_SRC` / `CM_ERROR_CODE` naming of this frame rests on thimo's DBC and on nothing else available here.** That is not a reason to doubt it — the type-approval PDF independently names `VCU_CM_COM_BYTE0`, `V_EV_ERROR`, `CM_V_COM_BYTE0` and `CM_ERROR` as the VCU↔CM signal set, which is exactly the naming convention thimo describes, and the 0.162 s agreement with `0x100` is a measurement rather than a name. It is a reason to say "one source" out loud wherever this decode is quoted.

🧨 **The charge-manager error triple HAS been captured, and it reads zero.** `src/diagnostics/fault-infokeys.ts` says at (54, 13): "The charge-manager error triple this project has never captured." It has — in `scripts/captured-freeze-frames.ts`, which carries a component-54 freeze frame the bike actually sent on 2026-08-08:

    component 54, symptom 11 → C1014 UNCLASSIFIED CM ERROR
    57 01 00 36 B5 22 0A 00 00 00 FF
      VEHICLE_SUBSTATE   34
      VCU_CM_COM_BYTE0   0x0A
      CM_ERROR_SOURCE     0
      CM_ERROR_CODE_MSB   0
      CM_ERROR_CODE_LSB   0

Decoded through `decodeFreezeFrameResponse()` itself, not by hand. **A stored charge-manager DTC's own freeze frame preserved the error triple as all zeros** — so the freeze-frame route, which the service-tool file analysis in obd-garage/ §3.4 and this project's own notes both nominate as the way to see these values without a live fault, did not preserve them on the one occasion it was read. Whether that is because the fault was recorded before the triple was populated, because the record is stale, or because the VCU stores zero when the CM did not supply a value, this capture cannot say. It does mean the freeze-frame route is not the shortcut it looked like.

🔍 And the corresponding positive: **six charge-manager DTCs are stored on this bike.** The mode-03 list captured 2026-08-04 (39 codes, in `scripts/captured-dtc-transfer.ts`) decodes to `C1003`, `C1006`, `C1008`, `C1010`, `C1012` and `C1014` among others — unspecified CM error, CM-vehicle communication error, EVSE emergency shutdown, protocol error, SLAC process error, unclassified CM error. So the charge manager's fault path has fired in at least six distinct ways on this motorcycle over its life, while the entire live capture corpus caught three episodes carrying two codes. **The live corpus is a small and probably unrepresentative sample of this ECU's failure modes**, and any table built from it would be built from the wrong end.

### ❌ Refuted: the `0x400` rate change is not a fault signal

A lead worth testing and worth writing down as dead. `0x400` — the dashboard's own digital inputs — was observed running at 120 Hz for ~11 s during the 2026-08-09 14:41 episode, spanning exactly the gap between the fault clearing at 14:42:32.481 and the retry starting at 14:42:48.845, against a flat 80 Hz through the successful 15:23 handshake. Byte-identical payload throughout, so a real second cyclic slot rather than a button press: gaps are bimodal at ~5/10 ms (three frames per 25 ms cycle) at 120 Hz and ~10/15 ms (two per cycle) at 80 Hz.

**It fails its control by a wide margin.** In the same capture file, `0x400` runs at 120 Hz continuously from 08:02 to 14:41:38 — **6.6 hours, with no fault anywhere in it** — and drops to 80 Hz for exactly the 12 s at 14:36:59-14:37:10 when the charge manager was on the bus during E0. The 11-second "bump" is one instance of the state the bike sits in for most of its life:

    E1 window: 120 Hz for 148 s while 0x610 absent,  80 Hz for 6 s while present
    E3 window: 120 Hz for 175 s while 0x610 absent,  80 Hz for 194 s while present

⚠️ **And it is not simply "charge manager present" either**, which is the tidy explanation that also fails. In `capture-20260809-144317-edcdcf23.log` the rate is 80 Hz for the entire capture including the 16 minutes between sessions when the charge manager is asleep. Two captures of the same bike on the same day have different `0x400` baselines. What drives the third slot is unresolved; **what is settled is that it is not a fault indicator**, and a rule built on it would fire for hours a day.

### ⚠️ An artefact that contaminates any analysis timed across a Pi restart

Found while reconciling the fault windows, and it affects more than the faults. **When the capture service restarts with a new boot id, the new file's clock can be minutes behind the old file's, so the two overlap in wall-clock time while recording different moments.** Three instances, all confirmed by content rather than by inference:

- **2026-08-09.** `capture-20260809-080235-cd40b535.log` at 14:45:00 reads 271.1 V and −0.1 A; `capture-20260809-144317-edcdcf23.log` at "14:43:17" reads 275.6 V and **+59.7 A**. A pack cannot be at rest and taking 60 A at the same instant, and the higher voltage belongs to the loaded one, so edcdcf23's clock lags by at least two minutes.
- **2026-08-02.** `capture-20260802-184638-1c8fc1e2.log` at 18:55:14 reads −0.1 A with no `0x305`/`0x306` in the file at all; `capture-20260802-185513-563dd217.log` at "18:55:15" reads +2.1 A with 17 632 frames of `0x305`/`0x306`. Same conclusion.
- **2026-08-08 17:42-17:44** is the same shape and the two files happen not to contradict each other, which is luck rather than a different mechanism.

🧨 **This document already has a casualty of it.** §0x620 lists "2026-08-09 14:43 n = 11 940 modal 20 range 19..21 **(the aborted attempt)**" and §0x615 lists "2026-08-09 14:43:17.121 +0.03" as one of the eight captured ramp-ups. Those are the same session, and it is a **successful** one at 60 A in edcdcf23 — not the aborted attempt, which is in cd40b535 and never saw an amp. The related "155 s aborted DC attempt of 2026-08-09 14:42" in §0x605, §0x625 and §0x645 also comes from merging the two: what is actually captured is **139.3 s**, from 14:42:48.846 to the end of cd40b535 at 14:45:08, with `0x620` at `00 00 00 FF` and `0x615` b2 at 0 throughout. What happened after that is in a file with an unknown clock offset, and the retry may well have succeeded there.

**The rule for anyone pairing frames across captures: dedupe on `(timestamp, id, payload)` is not enough.** Two files can carry different payloads at the same timestamp, and the merge then produces state sequences that never happened — the first run of this analysis "found" `b7` flapping `02` ⇄ `23` at frame rate for 0.8 s on 2026-08-02 and again for many seconds on 2026-08-09, and both were two files disagreeing, not the bike. Segment by capture file first, then reconcile by content.

### What all of this leaves decodable

- ✅ `data[1]` and `data[2:3]` are the fault path, corroborated by `0x100` b7 bit 1 at a fixed +0.162 s in 3 of 3.
- ✅ Non-zero here means a charge attempt failed, in 3 of 3 — but not the converse: E0 failed with these bytes at zero.
- ✅ The full observed value set: src ∈ {7, 8}, code ∈ {853, 1101}, pairs {(7,853), (7,1101), (8,1101)}.
- ❌ What either number **means**: unknown, with no factory enumeration in existence on this disk and no structure derivable from two values.
- ❌ Which of `C1003`…`C1018` a given pair maps to: unknown. Six of them are stored on this bike, the one freeze frame that was read carries zeros, and nothing correlates.
- 🔍 The reading that would settle it, unchanged and now sharper: a fault where the live `charge_manager_error_src`/`_code` and a **freshly cleared then re-read** stored DTC list are captured in the same minute. Clear the codes first — six are already stored, so a post-fault read without a clear cannot attribute anything.

---

## What actually reaches the ride log, and why `rides.db` had none of it

On 2026-08-20 `SELECT COUNT(*) FROM signal WHERE key='fast_dc_target_a'` against `rides.db` returned 0, and so did every other key in this group. **Nothing in the logging path drops them.** The path was traced and then run end to end: `decodeFrame()` routes the five ids off `CHARGE_MANAGER_CAN_IDS` (`src/can/decode.ts`), the same exported list is what puts them in the kernel RX filter, all fifteen keys are declared in `src/can/registry.ts` and bounded in `public/lib/bounds.js`, `record()` seals them through `src/storage/encrypted-log.ts`, and `scripts/decrypt-log.ts` rebuilds them into `signal`/`reading`. There is no allowlist anywhere on that path.

**The file simply predates the decoder.** `rides.db` was rebuilt on 2026-08-16; this group was decoded on 2026-08-19 and reconciled against the DBC on 2026-08-20. No segment on that disk was ever written by a Pi carrying this code, and no query recovers what was never sealed. 55 other non-DTC keys added in the same window are missing for exactly the same reason — the ABS block, the handlebar buttons, the IMU attitude pair, the PSU rail, drive torque, both VCU flag words — which is what rules out anything charge-manager-specific. What this needs is a deploy and a re-decrypt, not a code change.

**The canary after a deploy is `0x625`.** `fast_dc_limit_max_v`, `fast_dc_limit_max_a`, `dc_charging` and `ac_charging` write one row each on the first frame after boot, parked and unplugged included, because `lastLogged` starts empty. Those four appearing and the other eleven not means the charge manager is asleep, which is its normal state. None of the fifteen appearing on a bike that has been awake means something else, and the first thing to suspect is the `b4 = 0xF1` gate and the `b1`/`b3` gates above: a gate that drops is silent by construction, and quiet looks exactly like an ECU that never woke up.

### Replayed through the real path, 2026-08-20

Four captures were replayed frame by frame through `decodeFrame` → `record` → a sealed `.celog` → `decrypt-log.ts` → SQLite — every step the Pi and the laptop actually run, with the capture's own wall clock passed to `record()` in place of `Date.now()`. All fifteen keys land, with the units, group and source the registry declares.

The **2026-08-04 DC session** (`capture-20260804-193952-4b4cdd2b.log`, 3 834 783 frames), 19:58:19 → 20:16:05, SOC 30 → 57 %. Rows written INSIDE that window, with the value span each covers — first and last are called out separately where they are not the extremes:

    fast_dc_target_a         93   spans 0…66 A, ends at 0        dc_charging               2   1 then 0
    charge_manager_soc       28   30 → 57 %                      charge_type               2   0 then 2, no closing row
    fast_dc_target_v         22   spans 298…319 V, ends at 317   bms_leak_detect_inhibit   2   0 then 1, no closing row
    charge_manager_status    10   spans 0x08…0x5E, 0x10 → 0x48   ac_supply_limit_a         1   0
    charge_manager_state      9   0x02 → 0x23                    error_src, error_code     1 each, 0
    fast_dc_limit_a           5   0, 75, 64, 65, 0

⚠️ **Two scopes, and they must not be added together.** **176 rows inside the session, from 12 of the 15 keys.** The other three — `ac_charging`, `fast_dc_limit_max_a`, `fast_dc_limit_max_v` — wrote their only row at 19:39:52.898, the capture's first `0x625` frame, 18 minutes before the session started; `dc_charging` wrote one there too as well as its two inside. So the whole 47-minute capture holds **180 rows across all 15 keys**, against 267 890 rows from every signal in it. Either way there is no flood, and nothing here wants a deadband. The `0x610` b7 handshake came out of the log as `0x02` → `0x14` → `0x04` → `0x07` → `0x0D` → `0x11` → `0x12` → `0x11` → `0x23` over 4.70 s — nine steps, not the eight over "~3 s" this document claimed until 2026-08-20, and §0x610 b7 above is corrected with the two other sessions that take other paths again. `fast_dc_target_a` peaked at 66 A against a `pack_a` of 66.3 A, and at 20:05:19-20 the request read 63 A against 63.1-63.2 A delivered — the same instant the fixture in `scripts/check-can-decoders.ts` is taken from.

⚠️ **Do not read a per-sample agreement off the LOG the way it can be read off the raw frames.** Pairing each of the 23 post-ramp request rows with the last `pack_a` row before it gives a mean gap of +0.53 A, which is close to the corpus's +0.30 A — but the individual pairs run from −5.4 to +6.2 A. Both series are logged on change and step at different instants, so a carry-forward pair straddling a step compares a new request against an old measurement. The corpus figures above (r = +0.9951, median 0.30 A) come from aligned raw frames at full rate; the log is a different, coarser thing and the two must not be quoted as if they were the same measurement.

⚠️ **Through that entire session, `dc_a`, `dc_v`, `mains_a` and `mains_v` logged zero rows.** The onboard charger's frames are not merely uninformative during a fast charge, they are absent, which is the measurement behind "these are the only signals that see a DC fast charge at all".

The **2026-08-09 14:41 aborted attempt** (`capture-20260809-080235-cd40b535.log`) puts the fault pair in the log for the first time: `charge_manager_error_src` = 7 and `charge_manager_error_code` = 853 at 14:41:46, both back to 0 at 14:42:32, with a successful retry reaching `0x23` at 14:42:53. The **2026-08-08 AC session** (`capture-20260808-182129-600daf87.log`) gives `ac_supply_limit_a` = 8 A, `ac_charging` = 1, status `0x19` and substate `0x02`. The **2026-08-09 18:10 taper** (`capture-20260809-181059-551bae3b.log`) gives `fast_dc_limit_max_v` = 371 V, the post-change value.

### The gap this leaves, which is a reader's problem and not the logger's

Four of the five frames stop when the cable comes out, and the log stores a row only on change, so **eleven of the fifteen keys have no closing row at all** in the 2026-08-04 capture — every one except `0x625`'s `fast_dc_limit_max_v`, `fast_dc_limit_max_a`, `dc_charging` and `ac_charging`. Anything that step-holds the other eleven carries their last value onwards indefinitely: `charge_type`'s last row is at 19:58:20 and it still reads DC when the capture ends at 20:26:42, ten minutes after the session finished, and would a week later.

That is not something to fix in the logger. A timer-driven keepalive is the wrong answer here for the same reason it is wrong for `dc_charge_limit_selected_a` (`src/can/charge-setpoint.ts`), and `record()` deliberately refreshes `liveState` on every sample so the phone dashboard can grey a stale tile without any row being written. **`0x625` is what closes the picture**: it broadcasts at 10 Hz whenever the bike is awake, so `dc_charging` and `ac_charging` genuinely do write a 0 when the current stops — 20:16:03 in the session above, three rows in total. Read the held state bytes next to those two, never instead of them. `grafana/dashboards/charge-manager.json` is built round exactly that division and says so on every panel that holds.

---

## Method notes, and two artefacts of the archive rather than the bike

**Where the percentages come from.** The counts added on 2026-08-19 (44 262, 44 862, 47 642, …) came from a change-plus-keepalive scanner — a row per payload CHANGE plus one every 2 s, not a row per frame. Every later pass re-ran the invariants over EVERY raw frame, at roughly 20× the resolution. Every invariant re-checked came out at the same 100.000 %, which is the reassuring part, **but the sampling is NOT uniform and one percentage moved twelvefold because of it.** A keepalive scanner over-represents frames that are CHANGING, so any statistic about transients is inflated: `0x620`'s "b2 > b0 in 0.4 %" is 0.033 % at full rate. Treat a sampled percentage about a steady state as sound and one about an edge as suspect, and re-derive before leaning on it.

**Every frame of all six ids is DLC 8** (except `0x630`, which is always 3) — the `data.length < 8` guards in the decoder have never fired on real data. There is one apparent exception and it is not a frame:

    capture-20260807-211634-0541697e.log ends
     (2026-08-07 21:17:38.503667)  can0  625   [8]  6B 01

candump was killed mid-write, so the line says DLC 8 and carries two bytes. A truncated capture is indistinguishable from a truncated frame to anything that parses these logs by counting fields, and it would have "shown" that this bus produces short frames. **Any scan of the archive should drop a final line whose byte count disagrees with its own DLC.**

**The 2060 clock.** The Pi has no RTC, so it boots to 2060 without a GPS fix (the archive has `capture-20600808-*.log` to prove it). An earlier draft claimed session 24 was a DC session with no `0x645` at all, and concluded that presence implied DC but absence implied nothing. That was an artefact of the analysis scanner: it emitted a row per payload CHANGE plus a keepalive every 2 s, and one 2060-dated line pushed its "last emitted" mark into the far future — after which every real frame looked negatively aged, the keepalive never fired again, and any id with a CONSTANT payload silently stopped being recorded. `0x645` is the most constant frame on the bus, so it vanished first. Re-grepping the raw capture put 28 009 frames of `0x645` against 27 987 of `0x615` in exactly that window, in lockstep. The same artefact is why 7 972 `0x625` frames appear to read the old `V_CM_V_LIMIT` after the change.
