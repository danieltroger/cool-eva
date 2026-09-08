# 0x400 byte 5 bit 7 — the dashboard's day/night flag

`src/can/decode.ts` decodes it as `dash_day_mode`. `public/lib/theme.js` is what reads it: the phone dashboard's light theme follows this bit directly, with no smoothing, on the owner's instruction.

Everything below is measured over **the whole capture archive** in `~/Documents/cool-eva-archive`: 255 candump files, of which **97 carry `0x400`, for 14 069 994 frames**. That is 12.8× the 1 099 357-frame / 14-capture corpus the `0x400` section of `can-decode-findings.md` was written on.

---

## 1. Where the name comes from, and what it is worth

Energica's own free-frame IO table, decompiled out of the service tool and written up in `obd-garage/HEATED_GRIPS.md` §3.0, carries two rows nobody had decoded:

| title                      | code    | frame   | byte | bit   | mask     |
| -------------------------- | ------- | ------- | ---- | ----- | -------- |
| `DBS LIGHT SENS CALIB STS` | FF_D013 | `0x400` | 2    | 4     | 0x10     |
| `DBS DAY/NIGHT MODE`       | FF_D014 | `0x400` | 5    | **7** | **0x80** |

`HEATED_GRIPS.md` §3.5 independently proves `0x400` is the dashboard broadcasting its own digital inputs — every bit of byte 2 lands on a wired J8 pin on the dashboard connector, four bits and four pins with no leftovers, from a decompiled service-tool resource and an Altium schematic that had never been compared. "DBS" is the dashboard. So a day/night flag and a light-sensor calibration bit sharing that frame is exactly where they belong.

⚠️ **A name off that table is not a measurement.** `charging` on `0x102` b2 bit 0 came off a third-party table the same way and is really the high beam. Everything from §2 on is what the captures show, independently of what the table calls it.

## 2. A full byte census of the frame

Over all 14 069 994 frames:

| byte           | every value it has ever held                                          |
| -------------- | --------------------------------------------------------------------- |
| b0             | `0x02`                                                                |
| b1             | `0x01`                                                                |
| b2             | `0x00` (14 052 153) · `0x01` (310) · `0x02` (3 392) · `0x04` (14 139) |
| b3, b4, b6, b7 | `0x00`                                                                |
| **b5**         | **`0x00` (10 381 041) · `0x80` (3 688 953 = 26.2 %)**                 |

Two results beyond b5 itself. `b2` now takes four values rather than the three `can-decode-findings.md` recorded (`0x01` is the `btn_set_back` press of 2026-08-19). And **`DBS LIGHT SENS CALIB STS` — b2 bit 4 — has never been set once**, which is expected for a service-tool calibration state but is now a measured never rather than an unexamined one. **Only bit 7 of b5 has ever moved**; the other seven bits of that byte are dead.

## 3. The clock, which has to come before any claim about time of day

🚨 **Read this before quoting a timestamp out of these captures for anything.**

The Pi has no RTC. On a boot with no network its clock starts wherever the filesystem left it, and `src/gps/clock.ts` steps it — mid-capture — once enough satellite frames agree. So a candump stamp is only worth what the satellite fix beside it is worth.

Satellite UTC can be decoded straight out of the `0x410` GPS sub-`0xFE` records, the same fields `src/gps/decode.ts#decodeUtc` reads. Doing that for every file and tracking the live offset against the candump stamp splits the corpus in two:

|                                                   | frames    | with b5 set | share of corpus |
| ------------------------------------------------- | --------- | ----------- | --------------- |
| clock satellite-validated (offset = +7200 ± 60 s) | 6 833 554 | 3 534 803   | 48.6 %          |
| quarantined — no fix, or an offset that disagrees | 7 236 440 | 154 150     | **51.4 %**      |

**More than half of the archive's `0x400` frames sit on a clock with nothing behind it.** Only **24 of the 97** files contain a validated span at all. The capture clock, where it _is_ validated, is local time — satellite UTC + 2 h (Europe/Stockholm) — not UTC.

This section is about the whole archive rather than about this bit, and it is the reason the first version of this document was wrong. Two events were written up as "flipped nine minutes before sunset" and "mid-twilight"; both were pre-step artefacts, and they were 100 % of the apparent night-time anomaly. `capture-20260802-210358` reads `sats=0` at 21:04 and then `satUTC=2026-08-03 15:53:54` at candump `21:07:41` — so the Pi's clock was **20 h 46 m BEHIND** real time (its stamps run _earlier_ than reality, which is why the real times in §4.3 are all later than the stamps), and the flip really happened at about **17:53 local on a bright August afternoon**. `capture-20260807-213359` has `sats=0` on every GPS record in the window; its true time is simply unknown.

## 4. What the bit does

### 4.1 It follows daylight

Over **validated frames only**:

| local time  | frames    | with b5 set |              |
| ----------- | --------- | ----------- | ------------ |
| 08:00–18:59 | 4 575 319 | 3 534 803   | **77.3 %**   |
| 19:00–00:59 | 2 258 235 | **0**       | **not once** |

⚠️ Scoped honestly: **01:00–07:59 has no satellite-validated frames at all**, because the bike sleeps in a garage where the GPS never gets a fix. The claim this table supports is "never set in the validated evening", not "never set overnight".

### 4.2 It is not the beam

Cross-tabbed over all 14 069 994 frames, sampling `0x102`'s lamp bits at each `0x400` frame:

|                  | b5 = `0x80` | b5 = `0x00` | % set  |
| ---------------- | ----------- | ----------- | ------ |
| low beam **off** | 1 001 802   | 6 546 406   | 13.3 % |
| low beam **on**  | 2 687 145   | 3 834 593   | 41.2 % |

The two rows sum to 14 069 946 rather than the full 14 069 994: **48 frames arrived before any `0x102` in their own capture**, so no beam state was known for them, and they are excluded rather than guessed.

Both values of b5 occur in **millions** of frames with the beam both on and off; neither implies the other in either direction. High beam is too rare across the corpus (32 771 frames) to say anything either way, and does not separate them either.

### 4.3 The garage, which is the actual evidence

Per-minute, `b5on` = share of that minute's `0x400` frames with the bit set, speed from `0x0A0`. This trace is the one worth keeping, because the correction in §3 **removed a confound** rather than damaging it — the sun does not move across it, only the bike does:

```
21:04 (really ~17:50)  b5on=  0.0%  lowbeam=100%  moving=  0.0%  vmax=  0.0   parked, dark garage
21:05 (really ~17:51)  b5on=  0.0%  lowbeam=100%  moving= 83.2%  vmax= 36.0   wheels turn
21:06 (really ~17:53)  b5on=  4.3%  lowbeam=100%  moving=100.0%  vmax= 71.0   the flip
21:07 (really ~17:54)  b5on=100.0%  lowbeam=100%  moving= 96.3%  vmax=114.7   out on the road
```

The reverse at the end of the same ride, and this half **is** satellite-validated (`16:05:22Z`, +2 h): the bit drops to `0` at **18:05:24** as the bike coasts in, `moving` falling 100 % → 67 % → 10 % over the following two minutes. The low beam is on throughout both halves.

A bike in a dark garage on a bright afternoon reads `0`; the same bike outdoors two minutes later reads `1`. That is a light sensor.

### 4.4 It flips far more often than a "mode" plausibly would

On the single continuous **5 h 32 min daytime ride of 2026-08-08** (11:22:29 → 16:54:56, 60–130 km/h, one capture, no gaps):

> **55 transitions. Median run 136.6 s. Shortest run 32.9 s. 23 of 54 runs under two minutes.**

Archive-wide: 94 transitions, median run 130.1 s dark / 190.3 s light, shortest 13.2 s.

(Medians are the standard mid-point of an even-sized sample. An earlier draft quoted 138 s and 132 s, which are the upper of the two middle values — the same runs, a different convention, and worth naming because the numbers appear in `docs/dashboard-decisions.md` too.)

## 5. What is still open

1. **Whether `0x80` means the dash's SCREEN is in day mode.** Nobody has photographed the dash beside a capture. What is measured is that the bit tracks ambient light at the bike.
2. **Polarity is inferred**, from §4.3's garage exits — strong, but an inference about which way the sensor reads rather than an observation of the screen.
3. **Whether the bit is the dash's filtered mode or the raw sensor.** The owner's report is that the dash _"doesn't really strobe that much"_, which §4.4 says the bit does — so the dash is filtering more than this bit is, and the bit is more likely the raw sensor. That also means **the phone flips more often than the bike's own screen does**, which is understood and was the owner's explicit choice (`public/lib/theme.js` has no hysteresis).

⚠️ These three are why the key keeps the vendor's name and this document exists. If a photograph of the dash beside a capture ever settles (1) and (3), that is the measurement to add here — and if it settles them the other way, `dash_day_mode` should be renamed `dash_light_sensor` and this file should say why.

## 6. Reproducing any of it

The archive is not in the repo, so none of the above is a CI check — it is provenance. `scripts/check-button-decode.ts` pins what the _decoder_ does with the byte, including that a `b5` with its low bits alive (which has never occurred) still reads bit 7 alone. The scans behind §2–§4 are single-pass `awk` over the candump files; macOS ships the one-true-awk, so they use a hex lookup table rather than `strtonum`, and a full pass over the ~14 GB takes a few minutes at `xargs -P 6`.
