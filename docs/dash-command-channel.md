# The VCU dashboard command channel (0x120/0x121) — on-bike id map

The `0x120`/`0x121` pair is the non-diagnostic command channel: we transmit a request on `0x120` (`VCU_COMMAND_REQ`), the VCU answers on `0x121` (`VCU_COMMAND_RES`). It already carries the RTC clock (`0x14`, written by cool-eva), charge-stop (`0x16`), and charge-current (`0x18`/`0x1A`). Frame byte 0 is a 7-bit command id plus bit 7 (set = write, clear = read); byte 1 is the `0xFF` separator; bytes 2.. are the payload.

This channel matters to the headlight hunt because it is **injectable without a diagnostic session** — no `0x10`/`0x27` handshake, unlike the `0x2F` route in [headlight-diagnostic-control.md](headlight-diagnostic-control.md). If a general beam control existed here, turning the light off would not need the safety-node unlock.

## The sweep — this Eva Ribelle, 2026-08-27

Read-only sweep of all 128 ids (`scripts/dash-command-sweep.ts`, bit 7 always clear — documented non-mutating), key on, headlight on, not charging, service stopped. **19 live, 109 unsupported, 0 silent** — the same live count the service-tool analysis found on an SS9.

| id     | reply bytes         | meaning                                     |
| ------ | ------------------- | ------------------------------------------- |
| `0x01` | `01 ff 9d 02 03 00` | Ride map                                    |
| `0x02` | `03 ff 9d 02 03 00` | Regen map                                   |
| `0x04` | `02 03 00 …`        | unlabelled                                  |
| `0x05` | `00 …`              | unlabelled                                  |
| `0x06` | `00 …`              | unlabelled                                  |
| `0x15` | `00 …`              | **LPR mode (0=off/1=on)** — reads 0         |
| `0x17` | `64 …`              | unlabelled (`0x64` = 100 — looks like a %)  |
| `0x18` | `3c 01 4b …`        | DC charge current (value 60, min 1, max 75) |
| `0x1A` | `01 01 0f …`        | AC charge current (value 1, min 1, max 15)  |
| `0x1B` | `55 …`              | unlabelled (`0x55` = 85)                    |
| `0x1C` | `55 …`              | unlabelled (`0x55` = 85)                    |
| `0x1F` | `62 02 0f …`        | unlabelled                                  |
| `0x20` | `ff 9d …`           | unlabelled                                  |
| `0x2A` | `00 …`              | **Light in charge (0=off/1=on)** — reads 0  |
| `0x2B` | `00 …`              | Fan limit % (30-100)                        |
| `0x2C` | `00 …`              | Charge limit % (0 = no limit)               |
| `0x2D` | `00 …`              | unlabelled                                  |
| `0x2E` | `00 …`              | unlabelled                                  |
| `0x7E` | `0f 2c …`           | unlabelled                                  |

## Verdict for the headlight hunt

**No general "headlight on/off" command exists on this channel.** The only two light-labelled ids are both live but neither is a beam switch:

- **`0x2A` "Light in charge"** reads `0`. This is a _charge-scoped setting_ — whether the headlight stays on while a charger is plugged in — not a general switch. It already reads 0 (light off during charge), and writing it would only change charge-time behaviour, not the beam while riding. This is the CAN-visible cousin of the physical charge interlock in [headlight-charge-interlock.md](headlight-charge-interlock.md), not a replacement for it.
- **`0x15` "LPR mode"** — **write-tested on-bike 2026-08-27, and it is NOT a light.** Writing `0x15 = 1` makes the dash read "LPR mode active" (confirmed from a known `0`→`1`), and `= 0` clears it; no beam, lamp, or DRL moved either way. So it is a genuine, working non-diagnostic dash toggle — just not the one we want. "LPR" has **no expansion anywhere** in the vendor tool; its ordering near the light/charge cluster was a red herring. Tooling: `scripts/lpr-mode.ts` (`--on`/`--off`/read). The write is a _stored setting_ — it persisted across the script exiting, unlike the `0x2F` diagnostic force that decays in <40 ms.

None of the 11 unlabelled live ids looks like a beam control; their values read as config/percentages (`0x17`=100, `0x1B`/`0x1C`=85). **Caution:** these dash ids collide numerically with the `0xA9` calibration/parameter table (e.g. param `0x1C` = "charger fan on temp") — that is a _different address space_, and the collision is coincidence, not a label for the dash command. Do not import those meanings here.

## What's left on CAN — nothing _non-diagnostic_. But the diagnostic side has two routes.

The write probe is done. `0x15` was the last candidate, and it drives LPR mode, not a light (above). `0x2A` is charge-scoped. No unlabelled id looks light-like. There is **no non-diagnostic CAN control for the headlight** on this bike.

⚠️ **This is a verdict about the _non-diagnostic_ channel only — do not read it as "the headlight can't be switched off."** Two diagnostic routes are now confirmed on-bike, both behind the `0x10`/`0x27` VCU-Safety session:

1. **io_set force** (`0x2F` control 17 → 0) — immediate but decays in <40 ms, so it needs a ~5 ms re-assert to hold ([headlight-diagnostic-control.md](headlight-diagnostic-control.md)).
2. **Beam current-threshold write** (`0x2E` `BEAM_MAX_CURR_TH` below the real draw) — **persistent** across power cycles, takes effect at the next beam init with a `B1012`/`B1009` open-circuit DTC ([headlight-beam-threshold.md](headlight-beam-threshold.md)). This is what a rider means by "turned the headlight off and it complained about low circuit amps."

What the probe _did_ establish, worth keeping: **dash-command writes work by injection and are the same class cool-eva already ships** (RTC `0x14`, charge `0x16`/`0x18`/`0x1A`) — b0 = `id | 0x80`, b1 = `0xFF`, b2 = value, on `0x120` alone, **no diagnostic session**, and the value is _stored_ (persists across the sender exiting). This does **not** cross the `0x2F`/`0x27` ban. The service-tool analysis had left these writes untested; `scripts/dash-command-write.ts` (guarded to the light-labelled ids unless `--force-id`) and `scripts/lpr-mode.ts` are the first live writes of a non-charge dash id.

So the only confirmed headlight-off is still the diagnostic `0x2F` route ([headlight-diagnostic-control.md](headlight-diagnostic-control.md)). A true no-diagnostic, works-while-riding "off" now points at hardware — a tap on the low-beam switch _input_ line (cleaner than cutting lamp power, which the VCU current-senses and would fault on).
