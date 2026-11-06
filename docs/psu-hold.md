# Keep PSU on

Advanced service → **Change something on the bike → Keep PSU on** repeats an observed PSU-on request. Arm **On**, then confirm with a separate tap. The repeat is a request, not proof that the PSU accepted it or that it will retain power after key-off. Watch both live rail readings while testing.

The request is standard CAN ID **0x500**, non-RTR, DLC **8**, data **`01 00 00 00 00 00 00 00`**. It repeats at **150 ms, a conservative repeat rate**. A delayed callback skips missed slots rather than sending a catch-up burst. No VCU diagnostic write or other PSU command is sent.

## Time limit and stopping

The hold has a **60 minute** monotonic limit, with remaining time shown on the card. **Extend** needs its own new arm-and-confirm and sets another 60 minutes from that confirmation. Refreshing the page, reconnecting or repeating an already completed request does not extend it. The hold is never persisted: every service boot starts **off**.

**Off** also arms before it confirms, because dropping the rail can stop the Pi. A confirmed Off ignores revision and boot changes, so another viewer's extension cannot prevent stopping. The hold stops on its deadline, a requested service shutdown, CAN down/channel stop or bus-off, three consecutive failed transmissions, loss of write permission, or another operation acquiring the bus lease, **except Reset VCU**. Parameter writes, sweeps, other service operations, CAN restart and automatic DC charge-current commands still stop it. Releasing a lease or recovering CAN does not restart the hold. Each start, explicit extension and stop is logged with its reason.

After stop there are **no new frames** from the repeater. Frames already accepted into the kernel/device queue may still leave it. Stop does not send a guessed OFF payload: the PSU's timeout determines when MAIN drops, and that timeout/key-off behavior still needs the on-bike test.

There is **no 12 V battery**. The Pi runs from the PSU's main rail and loses power when that rail drops. That is expected; an HTTP reply or later shutdown cleanup may not complete. Do not rely on this hold to power the Pi through a service stop, restart or an out-of-process operation that stops Cool Eva.

## Reset VCU while holding the PSU

An already-active hold keeps repeating during **Reset VCU**. Its original deadline stays unchanged. Start and Extend remain refused while any operation holds the bus, including this reset. The reset still requires its existing confirmation and stationary/not-charging checks, and all CAN fault, permission, timeout, Off and shutdown stops remain active.

The exception belongs to that reset's lease and ends when it releases the bus. It permits only the independent PSU repeat; diagnostic operations remain exclusive. The observed reset exchange uses requests on `0x7C0` and replies on `0x7E0`, with target addressing. A `0x500` PSU request cannot satisfy that reply filter. The separate nonblocking sockets share no pending reply or pacing state.

At the configured 500 kbit/s, a conservative 160-bit budget for an eight-byte standard frame is 0.32 ms and about 0.22% added load at 150 ms. The physical bus is shared: higher-priority `0x500` may briefly delay a diagnostic frame, against the reset's 300 ms reply window. This protocol isolation does not establish ECU power retention or explain the reported power loss after key-off.

The VCU may resume its own `0x500` requests after reboot. The repeater does not arbitrate the meaning of competing payloads; inspect local TX and received frames separately with `candump -x`. TX errors and bus-off still stop the hold. If power drops during the reset, the Pi can lose both the HTTP reply and that reset's audit line, which is written after the exchange. On the next service boot the hold is off.

## Permission and telemetry

Starting or extending needs the existing service-write permission, the `X-Cool-Eva: service-write` header, the JSON mutation guard and an available bus. A separate nonblocking SocketCAN channel is opened on start and stopped/released on stop; its narrow RX filter must succeed before any listener is installed or request sent. A rejected start explains why and sends nothing.

An active hold replaces the header brand with **PSU on** and the total notice count. Tap it to open Advanced service at the Off control. Other notices retain their full text and repair/reload access in Settings. The header gains no row or height. The existing five-second system snapshot and each action's reply carry authoritative state; the countdown between them uses the phone's monotonic clock. An unavailable connection means last-known state, never proof that power stayed on or turned off.

The existing observed **0x501** monitor supplies `psu_12v_mv` (bytes 0–1, little-endian main rail mV) and `psu_12v_lowpower_mv` (bytes 2–3, little-endian standby rail mV, normally about 9 V). Both use the existing physical bounds `[0, 20000]` mV. Missing, stale or rejected readings are shown explicitly; a rejected reading is a fault, not a plausible clamped voltage. These regulated rails do not measure traction-pack reserve.

## Capturing the test

Use **`candump -x`** for the on-bike test, so the local TX/RX direction distinguishes the Pi's own 0x500 requests (150 ms) from the VCU's requests (observed around 20 ms). For example, on the Pi's local interface:

```sh
candump -x -tA can0
```

The usual capture helper omits `-x`; identical 0x500 payloads there cannot reliably identify the sender by their bytes alone. Keep captures private and synthetic examples free of identifiers. Test retention after key-off and the PSU timeout with someone at the bike; the software checks exercise fake CAN channels and do not establish either hardware behavior.
