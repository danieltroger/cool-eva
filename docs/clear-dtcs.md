# Clearing trouble codes: OBD Mode 04 on this bike

What is measured, what is inferred, and what was believed and is now refuted. The code is `src/vcu/service-actions.ts` (the frame and the reply decode), `src/vcu/write-session.ts` (`clearStoredDtcs`) and `src/vcu/clear-dtcs.ts`. `docs/vcu-parameters.md` §13 covers the button's place behind the gate and the fold; this file is about what the bike does.

## 1. It works — 2026-09-13, parked, nothing plugged in

✅ Proven on the bike. Press at 21:54:31.9Z through `/vcu-write?action=clear-dtcs&confirm=clear-dtcs`, service on `8306426`, gate safe (`energized` 0, speed 0, no charge evidence, no charge manager on the bus at all). The exchange, from `capture-20260913-233757-b1396e19.log` (local CEST):

```
(23:54:32.682797)  can0  7DF  [8]  01 04 00 00 00 00 00 00   request, functional address
(23:54:32.708282)  can0  7EF  [8]  01 44 00 00 00 00 00 00   positive response, +25.5 ms
```

One `01 44` in the window, no `7F 04 xx`, no second answer from another ECU. **Five** independent counters moved:

| counter                      | before             | after    | when                                    |
| ---------------------------- | ------------------ | -------- | --------------------------------------- |
| mode 03 stored list          | 46 codes           | 5 codes  | next transfer, 21:55:51Z                |
| PID 01 `dtc_count`           | 0x2E = 46          | 0x05 = 5 | 23:54:40.520                            |
| PID 31 `dist_since_clear_km` | 0x4CD7 = 19 671 km | 0        | 23:54:33.120, **438 ms after the 0x44** |
| PID 4D `time_with_mil_min`   | 0x0518 = 1 304 min | 0        | 23:54:40.660                            |
| PID 30 `warmups_since_clear` | 0xA6 = 166         | 0        | 23:54:40.694                            |

All five were still there 13.5 minutes later. **PID 31 is the cheapest proof of erasure** — it moves within half a second and no ordinary bike state resets it — which is why the button reports it.

The five codes that came straight back are all faults that are true right now: `B1001` position lights SC, `B1003` stop lights SC, `B1010` low beam SC, `B1013` high beam SC (the LED-conversion current-sense complaints) and `P0A06`, the water-pump sibling of the `P0A05` that `WATER_PUMP_MIN_CURR_TH = 0` suppresses. 41 of the 46 were historical and are gone.

🟡 The freeze frame still read `P0A06` afterwards. Since everything else mode 04 resets did reset, the likelier reading is that it cleared and was instantly re-captured by the active pump fault — but that is inference. It would take a clear with `P0A06` not active to separate the two.

❌ Modes 07 and 0A still answer nothing, before or after. Unchanged.

## 2. The two earlier presses were accepted and erased nothing

Both were audited `status: "cleared"` — _"Mode 04 accepted"_ — and both were false in the only sense that matters. From the ride log, which keeps PID 30, 31 and 4D as signals:

|  | 2026-08-08 19:04Z | 2026-09-11 11:46:02Z |
| --- | --- | --- |
| `dtc_count` | 40 before, **40** at 19:14:55Z | 42 before, **42** at 11:47:10Z, 11:50:44Z, 12:11:09Z |
| `dist_since_clear_km` | **17 476** at 19:14:45Z, climbing to 17 506 by 20:33 | **19 173** before and 19 173 at 11:50:34Z, then 19 174, 19 175 … |
| `warmups_since_clear` | 12 | 116 → 117 → 118, straight through |
| `time_with_mil_min` | 1 222 | **1 304** before and after |

`dist_since_clear_km` has never once reset in the whole logged history — the only decreases are 1-2 km of rounding and one 115 km glitch. `time_with_mil_min` has exactly two decreases and neither is at a press (a 2-minute wobble, and 1 304 → 1 222 at the bogus-2060 boot, which is the Pi's clock jumping). `warmups_since_clear` shows one 255 → 0, on 2026-08-04, which is the PID's 8-bit ceiling wrapping — there is no clear that day.

⚠️ Neither earlier press has capture coverage. The only other capture on the Pi (`capture-20600808-220833-0887e861.log`, which starts under a bogus 2060 clock and steps to real time mid-file) spans 2026-08-08 20:08–20:37Z, an hour _after_ the 08-08 press, and holds zero `7DF … 01 04` frames. So we know what the bike did, not what it said.

## 3. 🟡 The charger hypothesis — n = 2 against 1

A charger was involved in both failures and in neither the success:

- **08-08 19:04Z** — SOC climbing 40 → 43 % across 18:56–19:10Z. Mid-charge.
- **09-11 11:46Z** — SOC 100 %, and `charge_manager_status` = 88 = `0x58` at 11:44:17Z. Bit 3 is `INLET_PRESENT_MASK` in `src/vcu/charge-session.ts`, i.e. **the charge manager saw a cable in the inlet** 1 m 45 s before the press, with no later row to say it left.
- **09-13 21:54Z** — `charge_manager_status` never seen at all that service run. No cable.

That reads as: _this VCU answers the standard positive `44` but declines to erase its fault memory while a cable is in the inlet._ It is consistent with all three data points and with mode 04 being a key-on-engine-off operation by convention. **It is three data points.** Stated as a hypothesis, and the button says so in those words rather than presenting it as a rule.

**What would settle it:** one press with the cable in and a session live, one press ten minutes after unplugging, watching PID 31 either time. The reset is instant and unambiguous, so it is a two-minute test the next time the bike is on a charger.

## 4. Why "accepted yet nothing dropped" got written down twice

Partly the bike, and partly us. `/stored-dtcs` serves whatever the mode-03 poller last read and never touches the bus, and that read happens once every `STORED_DTC_ROUND_DIVISOR` poll rounds. Measured on the night it worked:

- press **21:54:31.9Z**
- `/stored-dtcs` at 21:54:50.4Z answered **46 codes**, its own `readAt` = 21:53:47.2Z, `ageMs` = 63 493 — a list read **44.7 s before the press**
- next mode-03 read **21:55:51.2Z**; fetched at 21:56:29.2Z it answered **5**, `ageMs` 38.4 s

**79 seconds of showing the pre-press list under a button that had just said the list was gone.** That is the window a human presses in. It did not cause the two failures — `dtc_count` is a 10-second poll with no such cache and it did not move on either occasion — but it is why the screen could not have told anyone the difference. The clear path now re-reads the list itself, on the parked bus, before it answers — see §5. `/stored-dtcs` still never touches the bus.

## 5. What the button does now

Since this change, `performClearDtcs` (`src/vcu/clear-dtcs.ts`) parks the OBD poller before it sends anything, and reads the bike back on the same quiet bus:

```
holdPoller  →  PID 01, PID 31  →  Mode 04  →  mode 03 list, PID 02, PID 01, PID 31  →  release
```

Three things follow from that shape, and each of them is one of the failures above:

- **The poller is parked first, and nothing is sent if it will not park.** A mode-03 transfer already in flight when the Mode 04 goes out would resolve _after_ it and file a pre-clear list as the "after" — reporting "erased nothing" for a clear that worked. The bus lease does not cover the poller (`src/vcu/service-actions.ts`, above `isClearDtcsReply`), so this hold is the only thing that makes the two reads describe the same moment.
- **The verdict is PID 31, not the reply byte.** `succeeded` is false when distance-since-clear was read and did _not_ reset, whatever the ECU answered. A counter that could not be read leaves it true and says so in words: "we did not check" and "we checked and it did nothing" are different claims, and they were the same pixel until 2026-09-13.
- **The list re-read is what fixes §4.** It lands before the response does, so `/stored-dtcs` cannot serve the pre-clear list afterwards — and the endpoint still never touches the bus itself.

The whole parked window is ≈5.3 s against `obd-hold.ts`'s 15 s cap. The margin is load-bearing: past the cap the poller resumes underneath the transfer and its own `0x7DF` traffic makes the VCU abandon it.

⚠️ **The gate watchdog stops watching when the frame lands, not when the action returns.** `context.running` is cleared as soon as the Mode 04 outcome settles, and the watchdog only warns and aborts while it is set. What remains after that point is four OBD reads — byte for byte what the always-on poller emits at 2 Hz on a moving bike with no gate over it at all — so there is nothing there for the gate to protect, and the actuating half is already done and irreversible. Leaving `running` set through the read-back made the watchdog announce aborts it never performed, into the only witness this bike has. `src/vcu/read-runner.ts`'s equivalent watchdog is deliberately NOT changed: its `onUnsafe` has teeth for its whole window, because `client.stop()` refuses every subsequent transmit, so it is not making a claim it cannot keep.

Covered by `scripts/check-clear-dtcs.ts`, whose §5 pays 150 ms per PID reply for a reason: with an instant fake bus the whole action finishes inside one 200 ms watchdog tick and the section passes whatever the code does. It asserts the tick count so that a future edit cannot quietly make it vacuous again.

## 6. Why `pollPidNow` returns the decode and not the bytes

An earlier draft of that export handed back the raw frame and let the caller pick the value out of it. That silently dropped PID 01's second signal — it decodes to `mil_on` **and** `dtc_count`, and a caller reading byte A gets only one of them — and skipped `recordFreezeFrameDtc` for PID 02 entirely, which is the hook the freeze-frame question in §1 depends on. Everything that files a PID now files it through `fileResponse`, shared with the poll loop, so the two cannot diverge.

⚠️ It also warns when the poller is not parked. It shares the module-level `pending` map with `pollOnce`, and PID 31 is polled every round, so an unparked loop asking for the same PID collides: the first timer deletes the second's entry and both sides time out. Warned rather than refused because the hold is capped **by the loop** — a read-back that overruns 15 s finds the poller back underneath it, and a silent refusal there would look like a bike that said nothing.
