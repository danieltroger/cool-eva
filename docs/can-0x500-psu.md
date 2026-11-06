# Keep PSU on — did not retain power through an A8 reset (CAN 0x500)

The experimental **Keep PSU on** feature was removed on 2026-11-06. Repeating the correct CAN request did not retain power through an A8 reset, even at the normal 20 ms rate, while an independent transmitter was still sending. A key-off test with the application's repeat also lost power, though it did not prove that transmission continued. The analyzed A8 firmware clears a separate hardware DCDC enable in its sleep path regardless of `0x500`, which points to a non-CAN enable condition; the wiring and the reset-time waveform were not measured. This document preserves the protocol findings and failed tests rather than offering a control to repeat them.

## Request format and timeout

**Observed bus traffic:** the normal vehicle request is standard CAN ID **0x500**, non-RTR, DLC **8**, payload **`01 00 00 00 00 00 00 00`**, normally repeated every **20 ms**.

**PSU firmware analysis, for a different model:** byte 0 bit 0 requests MAIN. The analyzed receive paths need no application checksum, counter, toggle or preliminary handshake. Repeating an identical request refreshes its receive timestamp. Ordinary CAN link CRC is separate from an application checksum. The parsers also consume request bits for additional outputs; their physical purposes are not established and they are not substitute enable controls.

The analyzed firmware's nominal freshness budget is **`1500 + 10 × setting` milliseconds**, with compiled setting **10**, hence approximately **1.6 s**. Runtime settings and operating modes can affect expiry handling. This is a request-freshness finding for those builds, **not a measured timeout or guaranteed rail-drop delay for the installed PSU**. Neither the timestamp check nor healthy telemetry proves that a receiver will retain hardware permission to convert power.

A continuing **150 ms**, conservative repeat rate supplies about ten requests per nominal freshness window. The failed **20 ms** test below also rules out simply substituting the normal vehicle cadence as a fix for the observed reset loss.

## A8's separate hardware enable

**A8 firmware analysis:** the output catalogued as **DCDC En** is separate from the CAN request. Boot initializes its output and command shadow to 1. The sleep path explicitly writes 0 to that hardware output, then reconfigures subsystems and enters deep sleep. This clear does not consult `0x500`; the analyzed A8 receive-object tables have no receiver for that ID.

**PSU firmware analysis, for a different model:** hardware input and permission paths exist independently of CAN freshness and can prevent the output remaining active. A correct, fresh MAIN request therefore does not override all enable or protection conditions.

The A8 ECUReset path requests a system reset; it is distinct from the explicit sleep clear. The exact connector, polarity, reset-time enable waveform and installed PSU's complete electrical contract were not measured by this software work. The sleep clear is established by the analyzed firmware; assigning the reset loss to a particular pin waveform would go beyond that evidence.

## Three on-bike tests, 2026-11-06

| Test | Observation |
| --- | --- |
| Key-off with the application's 150 ms repeat active | Power was lost after a few seconds. The visible running countdown established that the feature had started; it did not prove transmission continuity after power loss. |
| Independent raw 150 ms transmitter, key ON, then Reset VCU | Power fell about **0.3 s after the A8 reset** while the external transmitter was still sending. The last PSU monitor reported approximately **12.76 V**, and `0x502` byte 0 was **`03`**, about **70 ms before the capture ended**. |
| Independent **20 ms** transmitter, key ON, then Reset VCU | Power dropped again. Matching the normal request cadence did not retain power. No more precise fall timing was established for this run. |

These are the live test reports and capture findings supplied for the removal decision. An earlier application-driven Reset VCU test had stopped the repeater on bus acquisition and was confounded. The independent-transmitter tests remove that particular software explanation: no application lease could stop those transmitters.

In the analyzed PSU firmware, `0x502` byte 0 bit 0 reports the MAIN request and bit 1 an active/output-state flag, so **`03`** is consistent with request-on and active. Applying those semantics to the installed PSU is supported by matching healthy traffic, not a complete firmware match. The flag is **not a measured hardware-enable input**. A final healthy rail value and `03` do not prove continued power after telemetry ends, and they do not measure the timeout after requests stop.

## Retired software and retained telemetry

The removed implementation used a separate nonblocking socket to repeat exactly the eight-byte request every **150 ms**, a conservative repeat rate. Its monotonic scheduler skipped missed slots rather than sending bursts. State was never persisted; it started off after each service boot. On, Off and Extend used arm/confirm controls, with an explicit **60-minute** auto-off and locally displayed remaining time. A confirmed Off ignored stale revision/boot metadata.

The implementation enforced service-write permission, the service-write header and JSON mutation guard. Stops covered owner Off, expiry, shutdown, CAN down/bus-off, three consecutive TX failures, permission loss and another bus lease. A later exception preserved an existing repeat during Reset VCU only; Start and Extend still required an idle bus. Neither that exception nor the software safeguards could override the physical enable path. The service, endpoint, socket, dashboard state/card/header notice, reset exception and their dedicated fixtures/checks were deleted together.

Stopping the old sender meant **no new frames**, not removal of frames already accepted into kernel/device queues. It sent no guessed OFF payload. A successful socket send did not prove PSU acceptance. `candump -x` distinguishes local TX from received traffic with identical bytes; plain captures cannot identify a sender from the payload alone. Capture loss on a bike-powered logger and buffered tail loss limit conclusions about the final electrical transition.

There is **no 12 V battery**. The Pi loses power when the main rail drops, so an HTTP reply, reset audit line or shutdown cleanup may never complete. The separate socket's `0x500` frames could not satisfy a reset exchange on request `0x7C0` / reply `0x7E0`. At 500 kbit/s, a conservative 160-bit frame budget gives 0.32 ms serialization and about 0.22% added load at 150 ms, against a 300 ms diagnostic reply window. That protocol isolation and small bus-load budget did not establish retained electrical power.

The ordinary **0x501** telemetry decoder remains: bytes 0–1 are the little-endian main rail `psu_12v_mv`, bytes 2–3 the lower/standby rail `psu_12v_lowpower_mv`, and bytes 4–5 the load-current reading. The lower rail is observed around **9 V**; that does not prove its consumers or persistence after key-off. Existing **[0, 20000] mV** rail bounds and logging remain unchanged; rejected readings remain faults rather than plausible clamped voltages. These regulated rails do not measure traction-pack reserve. The two rail readings have no replacement dashboard card.

## Hardware options, not implemented

- **Independent external 12 V power** for the equipment that must survive the bike's shutdown.
- **Independently holding the hardware enable line**, subject to establishing the actual circuit, polarity, power sequencing and shutdown/fault behavior.

These are options for separate hardware work, not wiring instructions or implemented features. No alternative CAN message, enable override or firmware change is provided here.
