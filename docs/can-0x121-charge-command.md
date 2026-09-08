# CAN 0x121 — the dash↔VCU charge-current command

`0x121` is the command channel from the dashboard to the VCU. It is **event-based**: the dash emits a frame when the rider moves the charge-current dial, then repeats it. Decode-only handling lives in `src/can/charge-setpoint.ts`; the transmit mirror is `src/can/charge-command.ts`.

## Current-limit frames

Two opcodes carry a current limit, both with the current in **b2 as whole amps (1:1)**:

| b0 opcode | meaning  | b1   | b2       | b3  | b4         | b5–7 |
| --------- | -------- | ---- | -------- | --- | ---------- | ---- |
| `0x18`    | DC limit | `ff` | amps 1:1 | 1   | ceiling 75 | 0    |
| `0x1A`    | AC limit | `ff` | amps 1:1 | 1   | ceiling 15 | 0    |

- `b1 = 0xFF` is a separator in all captured frames, opcode regardless.
- `b3 = 1` means "a limit is in force"; only these two opcodes set it.
- `b5–7` stay zero; a non-zero tail marks a different opcode's layout.

### DC ceiling (b4 = 75)

The DC ceiling is the static `fast_dc_limit_max_a` (0x625 b2 = 75), broadcast on a merely-awake bike. DC `b2` was verified 1:1 in the captured corpus.

### AC ceiling (b4 = 15) — captured 2026-08-25

AC (`0x1A`) was originally the never-decoded half; `b4` for it was a guess (32). A `--listen` capture of the **dash's own** frames while dialling the AC current settled it:

```
1a ff 02 01 0f 00 00 00   → 2 A, ceiling 15
1a ff 03 01 0f 00 00 00   → 3 A, ceiling 15
1a ff 02 01 0f 00 00 00   → 2 A
1a ff 01 01 0f 00 00 00   → 1 A
```

So AC `b2` **is** amps 1:1 (1↔1, 2↔2, 3↔3), and the AC ceiling is `b4 = 0x0f = 15`. This 15 is **not** `ac_supply_limit_a` (0x620 b1, which read 31 in the same session) — it is the pilot/cable rating the dash tracks, and is therefore **likely charger-specific**. A command should echo the dash's last observed AC `b4` rather than hardcode 15.

### AC ceiling fallback of 15 when the dash has broadcast none — 2026-09-03

The set-current control originally refused an AC command until `ac_charge_ceiling_a` had been seen — but that b4 is an EVENT the dash only emits when the rider nudges the charge-current dial on the bike's own screen. From the phone, remote from the bike, there is nobody to nudge it, so the control could never be offered. The fallback: when AC has no live ceiling this session, both the Pi (`AC_CEILING_FALLBACK_A` in `src/vcu/write-runner.ts`) and the dash (`AC_CEILING_FALLBACK_A` in `public/lib/charge-write.js`) default `b4` to **15** — the only AC ceiling ever captured on this bike. The live signal is still preferred whenever present; 15 is only the fallback, and DC never falls back (an absent DC ceiling means CAN is not being received). The risk is the same charger-specificity above: if the real pilot/cable rating is not 15, the VCU rejects the frame's b4 and settles on ~10 A — **benign** (nothing damaged, overridable on the bike), just ineffective. The control says it is using a default and points at `charge_limit_a` to confirm the command took.

## Injection is honoured — with the right b4

A Pi-injected `0x121` **is** obeyed by the VCU (the dash's charge-current SET display changes on transmit — proven 2026-08-24 on an AC session). The earlier mystery, where injecting `--amps 1` and `--amps 3` both drove the dash to a fixed **10 A**, is explained by the wrong ceiling: those frames carried `b4 = 32`, which the VCU rejected, falling back to a ~10 A default. With the correct `b4 = 15`, `b2` should be read as sent.

> ⚠️ **Superseded — the `0x121` alone changes only the DISPLAY, not the committed setpoint.** See the next section: it moves the dash's pending SET display but `charge_limit_a` (0x10A `CHG.PWR.REF`, the committed value) never follows. Reading the display change as "obeyed" was the mistake; the commit needs the `0x120` twin.

### CRACKED — set-current also needs the `0x120` commit twin — 2026-09-03

The shipped set-current control sends only the `0x121` half. On an on-bike AC session (SoC 71–74 %, ceiling live at **15** = the fallback, so b4 was never the issue) an injected `0x121: 1a ff 05 01 0f …` moved the dash's **displayed** SET value to 5 A but `charge_limit_a` (0x10A b7 ÷ 7, the VCU's committed setpoint) stayed put — 14.3 A, then 7 A after a physical nudge. The value only committed when the rider turned the dial with the key present, which was mistaken for a key/menu authorisation gate.

A passive sniff of `0x120`/`0x121` (`scripts/sniff-charge-commit.ts`, a second read-only `RawChannel` that does not touch the interface) during the rider's own dial change caught the dash emitting a **pair**, `0x120` first, ~5 ms before the `0x121`:

```
0x120  9a ff 05 00 00 00 00 00   ← request-twin (0x1A | 0x80 = 0x9A), b3=0 b4=0 — the COMMIT
0x121  1a ff 05 01 0f 00 00 00   ← the command we were already sending (b3=1, b4=ceiling)
```

Replaying that pair (`scripts/inject-charge-pair.ts 5 15`) with **no key touched and no dial moved** committed `charge_limit_a` to **5 A**. So set-current is the exact mirror of the stop command: the commit rides on the `0x120` request-twin, and the `0x121` alone only sets the dash's pending display. The `0x9A` twin's tail differs from the `0x121` (b3=0, b4=0 vs b3=1, b4=ceiling); replicate the bytes as captured. Whether `0x120` alone commits (as it does for stop) was not isolated — the faithful pair is proven, so `buildChargeCurrentCommand` should emit both, `0x120` first. The key was never the gate; the feature was sending half the sequence.

## Not a current-limit frame

`16 ff 01 00 00 00 00 00` (opcode `0x16`, `b3 = 0`) appeared once at the end of a listen capture. It is a different `0x121` action (menu/apply/toggle), unrelated to setting the current — noted here so it is not mistaken for one. Stop-charging is likewise a different opcode (`b3 = 0` on `0x02/0x1D/0x1E/0x2C`, per `charge-setpoint.ts`), not a current-limit frame with a flag cleared.

## Stopping a charge is NOT a dash command — captured 2026-08-25

The earlier guess that "stop" is some other `0x121` opcode is **refuted by observation.** A listen-only whole-bus capture (`scripts/capture-charge-stop.ts`) was taken across a live AC charge while the rider **held the Mode button to stop it.** Result: **no `0x121` or `0x120` frame appeared on the bus at all** — not the current-limit opcodes, not `0x16`, nothing on the dash↔VCU command channel. What the capture shows is only the VCU and charger _broadcasting their own reaction_, in this order:

1. `0x620` → `ac_supply_limit_a = 0`, `fast_dc_limit_a = 0` (first "off" indicator)
2. `0x300` → `charger_enabled = 0`; `0x10a` → `charge_limit_a = 0`
3. `0x306` mains voltage decays ~205 V → 0 V over ~2 s
4. `0x201` → `charge_state 16 → 1`, `bms_state_charge → 0`; `0x605` b0 flips `0e → 02`

All four are frames the VCU/charger send _about themselves_, never a command _into_ the VCU. The strong inference: **the Mode button is a direct hardware input to the VCU, not a CAN message** — pressing it puts nothing on the bus, the same as the key switch. So there is no "stop" frame to capture and replay, which is what makes this fundamentally different from charge-_current_ (a real `0x121` command the dash sends and the Pi can mirror).

Whether the VCU will _accept_ a Pi-originated `0x121` that commands a stop — as opposed to reflecting a button — is a separate, open question. Injection of `0x121` current-limit frames is proven honoured (above), but no captured frame tells us the stop opcode, so the only way left to find one is transmit-and-observe: inject a candidate and watch for the four broadcasts above.

### Opcode 0x16 IS the stop command, and it must be HELD — 2026-08-25

Transmit-and-observe (`scripts/probe-charge-stop.ts`) settled it: injecting **`16 ff 01 00 00 00 00 00`** (opcode `0x16`) during a live AC charge **reached the VCU** — the dash immediately showed **"charge interruption in progress."** So the VCU _does_ accept a Pi-originated stop on `0x121`, and `0x16` is that command (the "menu/apply/toggle" guess above was the stop all along).

But a **single** frame left the dash hanging in "interruption in progress" — still charging. This matches the bike's own **two-stage** UX, described by the rider: one Mode _press_ arms the stop and shows a "press and hold the Mode button to disrupt charging" prompt, then a **~1.5 s hold** commits it. Our single 0x16 shot reproduced stage one exactly — "charge interruption in progress" _is_ that prompt, waiting for the hold. So the command must be **held**: streaming 0x16 continuously covers both stages — the first frame arms the prompt, and ~1.5 s of sustained frames is the hold that commits.

The transmitter must therefore **stream `0x16` for the duration of the hold** (the probe's `--hold` streams at ~10 Hz; `--hold 3` gives margin over the ~1.5 s the bike needs) — [PENDING: confirm on-bike that streaming completes the stop, and whether any byte increments across the hold].

### The stop is TWO PRESSES, not a hold — and injecting 0x16 only arms it — 2026-08-25

Three on-bike results overturned the "hold" model:

1. **Streaming a static `16 ff 01 …` for 3 s did nothing** — the dash stayed at "interruption in progress"; no watched key moved (`probe-charge-stop.ts --hold 3`).
2. **The rider corrected the gesture:** the real stop is **two discrete Mode presses, no holding** — press once to _unlock_, press _again_ to interrupt and prompt "disconnect cable." So `--hold` was emulating the wrong action; a 10 Hz stream reads as one continuous press (press-down only, never a release + second press).
3. **`--taps 2` (two 250 ms bursts, 700 ms silent gap) also did not commit** — still just the armed prompt.

The successful **manual** two-press stop _was_ caught in the ride log at 04:12:01Z (service was running): `ac_supply_limit_a 31→0`, `charger_enabled 1→0`, `bms_state_charge 1→0`, `charge_state 2→16→1`, `charge_type 1→0`, `charge_manager_status 9→8→0`, `ac_charging 1→0`. This confirms the stop **signature** but carries **no decoded `0x121`** — as expected, since a stop is never decoded (b3≠1 dropped) and the Mode button is a direct VCU input.

**Open gap:** every whole-bus listen capture so far was of a Mode-_hold_; the two-_press_ gesture has never been captured raw. The next experiment is `capture-charge-stop.ts` run while doing the two presses — to settle whether the presses put any `0x121`/new frame on the bus (→ replayable) or nothing (→ commit is hardware-only, and injected `0x16` can only _arm_ the prompt, never complete it, meaning a dashboard stop is not reachable by this route).

### CRACKED — the stop is a `0x120` + `0x121` PAIR — 2026-08-25

The two-press capture settled it: the manual stop puts **two command-channel frames** on the bus, **once each**, at the moment of the second press:

```
0x120  96 ff 01 00 00 00 00 00
0x121  16 ff 01 00 00 00 00 00
```

`0x96 = 0x16 | 0x80` — the `0x120` request-twin carries the same opcode with the high bit set. The charge then tore down exactly on cue (`0x306` mains voltage decaying, `0x620 → 0`, `0x300 → 0`, `0x605 0e→02`), completing ~10 s later at the end of the "interruption in progress" countdown.

This explains everything: injecting **only** the `0x121` half (`16 ff 01`) armed the prompt but never completed, because the `0x120` companion was missing. It also reconciles the earlier "hold puts nothing on the bus" result — a Mode _hold_ genuinely emits nothing; only the two-_press_ gesture emits this pair. `probe-charge-stop.ts --pair` replays both in bus order.

### CONFIRMED and SHIPPED — the stop pair ends the charge, and there is a button — 2026-08-25

Injecting the pair with `probe-charge-stop.ts --pair --send` during a live AC charge **stopped it on-bike** — the four teardown broadcasts above followed within seconds. So the feature is built, mirroring charge-current:

- `buildChargeStopCommand()` (`src/can/charge-command.ts`) returns the two frames — `0x120: 96 ff 01 …` then `0x121: 16 ff 01 …` — source-agnostic, since the same pair ends AC and DC.
- `sendChargeStopCommand()` (`src/vcu/write-session.ts`) transmits both, 20 ms apart, fire-and-forget.
- The `charge-stop` write action (`src/vcu/write-runner.ts` `performChargeStop`) requires only a fresh `charge_manager_state` (a live session, AC 0x02 / DC 0x23) and is EXEMPT from the stationary service gate, like charge-current.
- `POST /vcu-write?action=charge-stop&confirm=charge-stop` (header `X-Cool-Eva: service-write`).
- UI: a two-tap "Stop charging" button (`public/views/charge-stop.js`) — **not** press-and-hold, because the command is a discrete pair sent once, not a sustained stream. Shares session/status machinery with the set-current control via `public/lib/charge-write.js`.

### 0x120 ALONE commits the stop — the 0x121 half is redundant — 2026-08-25

An isolation test (`probe-charge-stop.ts --request-only --send`, which injects only `0x120: 96 ff 01 …` with no 0x121) **stopped a live AC charge on-bike** — the teardown broadcasts followed on cue. This is the mirror of the earlier 0x121-only test, which only armed the "interruption in progress" prompt and never completed. So of the pair the dash emits, **the commit rides on the 0x120 request-twin; the 0x121 companion does nothing on its own and adds nothing to the 0x120.**

`buildChargeStopCommand()` now emits the **single 0x120 frame** (still an array of one, so `sendChargeStopCommand`'s transmit loop is unchanged). Why the dash sends both anyway is unknown — likely the 0x121 is the dash echoing its own display state, not a required command — but we do not need to reproduce it. `--pair` is kept in the probe for reference.
