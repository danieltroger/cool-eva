# Turning the headlight off — the diagnostic IO-control route

> There are **two** confirmed diagnostic ways to switch the beam off. This file covers the immediate-but-decaying io_set force. The other — a **persistent** write to the beam current threshold — is in [headlight-beam-threshold.md](headlight-beam-threshold.md), and is the better match for a rider seeing the light off after a restart with a beam-fault on the dash.

The headlight _can_ be switched off over the bus, just not by any broadcast frame. It is a UDS **InputOutputControlByLocalID (`0x2F`)** command to the **VCU-Safety** node, the same channel the manufacturer's own service tool uses in its guided actuator tests. This corrects the general claim in [headlight-charge-interlock.md](headlight-charge-interlock.md) — that "there is no CAN message whose assertion turns the headlights off." That is true of the charge frames and the `0x102` status bits (which are read-only telemetry the VCU broadcasts), and false of the diagnostic channel.

## Provenance

Independent reimplementation of service tool's **lights actuator page**, which drives each output by hand.

## The recipe

| Piece | Value |
| --- | --- |
| Service | `0x2F` InputOutputControlByLocalID, sub-command `0x07` (shortTermAdjustment / set) |
| Node | VCU-Safety `0xA8` — request id `0x7C0`, response `0x7E0`, targeted (node byte leads the frame) |
| Control id | **17** = "Low + high beam" — the headlight output. Low and high share one output; id 241 is only the low/high split threshold. There is no separate high-beam output. |
| Off value | `0` (`inactiveValue`). On is `255` (`activeValue`). |
| Off frame | `7C0: A8 05 2F 00 11 07 00 00` (id 17 = `0x0011`, sub `0x07`, value `0x00`) |
| Confirm | current-sense is control **18** (`io_get_reading`, sub `0x01`); off reads 0–5 mA, on 2000–3000 mA |

Frame layout is `[node][pci][sid][data…]`. `io_set` builds the data as `<id_hi> <id_lo> <sub> <value>` = `00 11 07 00`; a _get_ omits the value byte (3 data bytes, not 4).

### Preconditions — a held diagnostic session

IO-control is refused without SecurityAccess, even for a read. The full sequence the service tool runs:

1. **StartDiagnosticSession** `0x10` type `0x81` → `7C0: A8 02 10 81 …`
2. **SecurityAccess `0x27`** — request seed (`A8 02 27 01`), compute the key, send it (`A8 06 27 02 <key>`). VCU-Safety's key is `calc_key`, a 4-byte exchange: swap adjacent bits of the seed, then subtract `0x3E5F4542` (≡ add `0xC1A0BABE`). Fixed per module — no firmware version in the decision, and no per-device constant table for the VCU family (only PSU/BMS use the separate generator).
3. **Force off** — the `0x2F` frame above.
4. **Hold it** — by re-sending the `0x2F` force itself every few milliseconds, **not** with TesterPresent. On-bike the override is a short pulse that decays in well under 40 ms (see the results below); TesterPresent keeps the session but lets the output snap back. There is **no returnControlToECU** (sub `0x00` is a getter), so release is either stopping the re-assert — the VCU resumes driving after the pulse decays — or `StopDiagnosticSession 0x20`. So "headlight off" = force 17 → 0 on a tight (~5 ms) loop; "headlight back" = stop the loop or end the session.

## On-bike results (2026-08-27, this Eva Ribelle) — CONFIRMED WORKING

Run from the Pi with `scripts/headlight-off.ts` (a scratch probe that speaks `0x2F`/`0x27` directly — it exists **because** the app cannot). Bike parked, key on, headlight on, not charging. **The headlight can be switched off this way — verified by eye.**

**The access chain works end to end.**

- **VCU-Safety (`0xA8`) grants the session.** Despite the service-tool analysis calling it "the one node known to refuse," `StartDiagnosticSession 10 81` succeeded every attempt.
- **The `calc_key` SecurityAccess algorithm is correct on this bike.** Several different seeds (`0xEC4D4650`, `0x0F79C27E`, `0x2A985C9F`, …) were each unlocked by the swap-adjacent-bits-then-subtract-`0x3E5F4542` key. Measured, not inferred.
- **IO reads work**, and `StopDiagnosticSession 20` hands control back cleanly.

**`io_set 17 → 0` does force the beam off — but the override is a short pulse that decays in well under 40 ms.** A single force gives a positive `6F` response and the beam visibly drops, then it snaps back on within tens of milliseconds. TesterPresent (and every other frame) keeps the _session_ alive but **not** the override. So holding the light off means re-asserting `io_set 17 → 0` faster than it decays — `--cadence <ms>` in the probe controls this:

- **At 40 ms re-assert: the beam strobes.** `sense 18` chops between ~1.8 A and ~3.5 A and the headlight visibly flickers — the override wins during each pulse and the beam recovers in the gap before the next one.
- **At 5 ms re-assert: the beam holds steadily dark** for the whole hold. With the in-hold sense read left on (`--watch`) it blinks every few seconds — that blink is an artifact of the probe, not the bike: reading `sense 18` pauses the re-assert for two blocking round-trips, long enough for the override to lapse. With the read off (the default now), the beam stays **fully dark, no blink** for the entire hold — confirmed by eye.

So the earlier reading of this — "`0` = release to normal, and normal is on, so force-off can't work" — was **wrong**, an artifact of re-asserting too slowly (150 ms) and reading the recovery blips. `0` genuinely forces the output off.

**Actuation confirmed independently on the brake light too.** Forcing an output that is normally _off_ — the brake, out 11 / sense 12 (0 mA at rest) — to `255` drove `sense 12` to 73–74 mA, inside the service tool's `BRAKE_LIGHT` active window (50–100 mA). Same pulse behaviour: at a 150 ms re-assert it alternated 73 mA / 0. So `io_set` drives outputs in both directions; the only trick is out-running the decay.

The get-output register interpretation still holds: a read-only sweep of ids 1–48 (`--sweep`) shows **every output's commanded state reads `0`** whether the load is on or off, so sub `0x00` is the _diagnostic-override register_ (0 = "not overridden"), **not** the physical output state. Physical state is read from the current _sense_ (sub `0x01`), not the commanded value.

Sweep map worth keeping (VCU-Safety, key-on, headlight-on, one AC-idle bike): outputs are **odd** ids 1–31 (all `cmd=0`), senses are **even** ids plus 33–43. Live current senses: id 18 = 3479 mA (beam pair), 28 = 4719, 40 = 3426, 41 = 3419, 36 = 3772, 33 = 3767, 39 = 2653; id 42 = 4095 (`0x0FFF`, an ADC full-scale — treat as unused/sentinel), id 10 = 60 mA (front position).

## Confidence — access verified, force-off CONFIRMED on-bike

Both halves are now measured on this bike (above): the access chain grants and IO-control physically actuates the beam off. The historical caveats, for provenance:

- **The service-tool analysis never ran this on a bike.** It marks its lights page `UNTESTED` — exercised only through its recording fake. The on-bike session it _did_ run (27–28 Aug 2026) was the Routines page — Set Service Point and node restarts — not IO-control. So the "force off" frame was our first live test of it, and it did not behave as the table implied.

Also model-dependent: later test tables split `LOW_BEAM (Except SS9)` from `LOW_BEAM (Only SS9)` with different current windows. Control 17 on `0xA8` is constant across every table; only the sense window varies, so which table this Eva Ribelle reports matters for the _verdict_ thresholds, not for the command.

## Relation to this repo's `0x2F` ban

cool-eva walls `0x2F` off everywhere on purpose (`src/vcu/param-codec.ts`, `write-codec.ts`, the read client, the sweep runner) — forcing the safety node's outputs is exactly what that ban exists to prevent. Reproducing this is therefore a deliberate crossing of that line, not a small addition. This doc records how the headlight is controlled; it does not implement it.
