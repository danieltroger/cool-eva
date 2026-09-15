# 0x7C4 / 0x7E4 — the instrument cluster's diagnostic channel

Nothing in this repo transmits on `0x7C4`. This file exists so that nobody has to find out the hard way what is on it.

## 🚨 Two services, and one of them reboots the cluster

The cluster's CAN receive path has exactly one software id comparison — `0x0007E95C` reads mailbox 1's id field (`rlwinm r0, r0, 0xe, 0x15, 0x1f`, i.e. `id >> 18`) and compares it against `0x7C4`. It calls the dispatcher at `0x0007E6F8` from that one place.

The dispatcher is thirty instructions. It matches **the first two payload bytes as one big-endian halfword**:

| request | behaviour |
| --- | --- |
| `02 11 02` — ECUReset, sub-function 2 | positive response, then `bl 0x89508` — **software reset into the bootloader** |
| `02 11 xx`, xx ≠ 02 | negative, NRC `0x12` subFunctionNotSupported |
| `01 3E` — TesterPresent (byte 2 is **not** examined) | positive response |
| anything else | negative, NRC `0x11` serviceNotSupported |

**No ReadEcuIdentification, no `0x21`/`0x22`, no DTC services, no live data, no IO control, no routines.** The cluster cannot be interrogated the way the VCU is, and it cannot be told to light a lamp or drive an output. Everything else on this id pair lives in the bootloader below `0x20000`, which is not in the firmware images we hold.

⚠️ **`02 11 02` is not a probe.** A one-byte slip in the sub-function is the difference between a negative response and a reboot of the instrument cluster.

The reply builder at `0x0007E644`: a **positive** response is the request echoed word for word with `data[1] |= 0x40` and **the request's own DLC**; a **negative** one is a hard-coded DLC 4, `03 7F <service> <NRC>`.

## Confirmed on the bike, 2026-09-15

Read-only probe, bike parked on AC, `0x101` b0 = `0x65` re-read immediately before each send. Three frames, one at a time, `candump -x` throughout:

```
 (2026-09-15 18:44:56.479963)  can0  TX - -  7C4   [8]  01 3E 00 00 00 00 00 00
 (2026-09-15 18:44:56.480589)  can0  RX - -  7E4   [8]  01 7E 00 00 00 00 00 00
 (2026-09-15 18:44:57.548944)  can0  TX - -  7C4   [8]  02 1A 80 00 00 00 00 00
 (2026-09-15 18:44:57.549483)  can0  RX - -  7E4   [4]  03 7F 1A 11
 (2026-09-15 18:44:58.623329)  can0  TX - -  7C4   [8]  03 22 F1 90 00 00 00 00
 (2026-09-15 18:44:58.626390)  can0  RX - -  7E4   [4]  03 7F 22 11
```

Round trips 626 µs, 539 µs, 3.06 ms. Every prediction above held, **in both branches of the reply builder** — the positive answer came back at the request's own DLC 8, not as a minimal reply, and both reads were refused with NRC `0x11`.

❓ **This does not identify the build.** A positive answer would have proved a cluster firmware we do not hold; a refusal proves only that the running build shares this dispatcher, and all three images we have share it byte for byte. It is a mild point against the "fourth build" candidate in [can-0x400-day-night.md](can-0x400-day-night.md) and nothing more.

## Why the OBD poller was not held, and why that is not a general licence

`0x7E4` is inside the OBD response filter — `src/index.ts` accepts `0x7E0` with mask `0x7F0` — so all three replies reached `handleResponse` with the 2 Hz poller running. That was safe **because the disassembly predicted the exact bytes first**: `01 7E 00 …` fails the mode-01 PCI/`0x41` check and `03 7F …` is not part of a trouble-code transfer, so both fall through. The journal over the probe window is empty and the service stayed up.

⚠️ Read that as "the replies were known in advance", not as "diagnostic probes do not need the poller held". Anything whose reply shape is not already derived from firmware should hold it (`withObdPollerHold`, `src/can/obd-hold.ts`).

## What is left

Nothing on this channel. The remaining unknowns are in the bootloader, reached only by the one service this project will not send.

For what this means for dropping the Bluetooth link, see issue #58: the cluster's whole CAN command surface is these two services, neither of which relays anything to the hub, so there is no CAN path that can carry the hub's active-fault request.
