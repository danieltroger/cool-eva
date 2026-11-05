# Main CAN transmit results

Every main-channel transmit checks the return from socketcan. A refused frame must produce a failed operation, never a successful "sent" result. The channel also enables `non_block_send` as defence in depth. This is a return-value fix, not a fix for a reproduced event-loop stall on this adapter.

## What the sources establish

The captured Pi link in [check-can-bringup.ts](../scripts/check-can-bringup.ts) uses `usb_8dev`, `pfifo_fast` and `txqlen 10`. A full device queue returns `ENOBUFS` immediately in both blocking and nonblocking modes. It does not wait for space in that device queue. The reachable bug was that all callers ignored the resulting `-1`, so RTC sync, charge current, Stop and the SOC-limit write could report "sent" for a refused frame.

The source trace, read against Linux v6.6:

- [`usb_8dev_start_xmit` and its USB completion callback](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/drivers/net/can/usb/usb_8dev.c?h=v6.6#n558) hold a bounded number of transmit URBs and stop the network queue at the limit. Echo buffers are released at USB completion.
- [`pfifo_fast_enqueue`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/net/sched/sch_generic.c?h=v6.6#n721) drops a new packet when its ring is full; [`qdisc_drop`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/include/net/sch_generic.h?h=v6.6#n1201) returns `NET_XMIT_DROP`.
- [`can_send`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/net/can/af_can.c?h=v6.6#n199) maps the queue result through [`net_xmit_errno`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/include/linux/netdevice.h?h=v6.6#n123), producing `-ENOBUFS`. [`raw_sendmsg`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/net/can/raw.c?h=v6.6#n826) returns that error. Its separate socket-buffer allocation receives `MSG_DONTWAIT`; enabling this flag is protection for other socket-buffer or link configurations, not evidence of a device-queue stall here.

In the published [socketcan 4.2.1 package](https://registry.npmjs.org/socketcan/-/socketcan-4.2.1.tgz), `native/can.cc`, `RawChannel::Send` passes a complete `struct can_frame` to the syscall and returns its number directly. Success is **16**, the Linux [`CAN_MTU` structure size](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/include/uapi/linux/can.h?h=v6.6#n120), including the header and padding. Eight payload bytes do not mean a return of eight. Failure is **-1**; this binding discards errno, so the app cannot identify EAGAIN, ENOBUFS or a down interface from that return. Native argument/channel checks throw before the syscall. Upstream's `src/can.d.ts` declares `void`, but the app's shim correctly declares a number.

Sixteen means the frame was handed to the kernel. It does not prove that the bike received or acknowledged it. For example, [`noop_enqueue`](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/net/sched/sch_generic.c?h=v6.6#n628) can discard a packet with `NET_XMIT_CN`, which `net_xmit_errno` maps to success. Queued frames may also be discarded later. Existing command acknowledgements and read-backs remain necessary.

The SOC-limit read keeps its 500 ms budget. The [charge-limit capture's latency measurements](dash-command-0x2c-charge-limit.md#reply-latency-and-where-the-slow-first-read-actually-was) include 1.586, 3.252 and 7.664 ms request-to-reply intervals, while the cold path took 83 ms from the JS stamp before transmit to the frame on the wire. That last interval measures the whole path, not time blocked inside the native syscall. The read's mark precedes transmit, so its budget includes that path as well as the reply; `MSG_DONTWAIT` does not eliminate wire latency.

## Boundary and policy

[transmit.ts](../src/can/transmit.ts) accepts exactly 16 and throws `CanTransmitError` for every other return. Native exceptions keep their original cause and follow the same caller catch paths. Payloads longer than eight bytes are refused before calling socketcan: the native implementation copies into its eight-byte buffer before kernel validation.

[channel-factory.ts](../src/can/channel-factory.ts) sets timestamps and `non_block_send: true`. It imports only socketcan types so a fake factory can exercise it on macOS without the optional native addon. [socket.ts](../src/can/socket.ts) uses this factory. Scratch scripts that already call `openChannel` inherit the nonblocking option; changing their pre-existing unchecked sends is outside this change.

| Sender | On rejected send |
| --- | --- |
| OBD PID polls | Clear the pending PID and timer. Skip the rest of the round and retain the next round's monotonic pacing. One-shot PID reads return null. |
| DTC initial request | Clear the transfer and return `not-sent`; do not retry. |
| DTC reply flow control | Log and settle `truncated`. Retain the existing idempotent read recovery: at most four retries, separated by 120 ms. If the next initial request is refused, its `not-sent` ends recovery. |
| E-LOCK startup | Clear pending state and log the failure. Keep the existing one-time diagnostic-session fallback and null result. No recurring loop is added. |
| SOC-limit write/read | A refused write returns failed and does not read back. A refused read uses the existing null path; after an accepted write this means unverified, never verified success. |
| RTC / Stop | Use the existing failed result; never retry the command. |
| Charge-current pair | Stop at the first failure and return failed. The runner retains `mayHaveSent: true`, so HTTP `chargeCurrentAttempt` remains `unknown` for any sender failure, even on the first frame. Existing pre-send refusals are the only `not-sent` producers. Never retry the pair or its second half. |
| KWP session/read exchange | Clear the pending slot and return the existing failure. A rejected parameter read is terminal; the sweep can retry failed rows on resume. |
| KWP multi-frame exchange | A rejected first frame is `not-sent`. A failed consecutive frame or reply flow control after an accepted request is `abandoned`. Clear the timer, pacer and reassembler; ignore late replies. Do not continue or retry a partial/stateful request. |
| VCU write-session exchange | Use the existing failed stage and stop the operation, including subsequent batch writes. Do not read back or claim success after a rejected write. These requests are single frames today. |

Typed OBD transmit rejections and DTC transmit errors log immediately, then at most once per five seconds per class, using a monotonic clock and reporting the suppressed count on the next log. Other poller errors retain the ordinary poll-error label and are not suppressed by the transmit limiter. The DTC recovery loop also retains its existing capped stall messages. Commands continue to surface failures through their existing logs, result and audit paths.

This changes no bitrate, restart timing, queue length or link configuration. The PSU hold uses its own channel and policy; combining the sockets remains separate work.

## Transmit inventory

These are the pre-change native call locations at `5d239bc`, retained so the audit is reproducible. Each now uses the boundary. WebSocket and BLE sends are unrelated.

| File and baseline line            | Purpose                            |
| --------------------------------- | ---------------------------------- |
| `src/can/obd.ts:213`              | PID request                        |
| `src/can/obd-dtc.ts:281`          | DTC read request                   |
| `src/can/obd-dtc.ts:362`          | DTC flow control                   |
| `src/can/elock.ts:91`             | E-LOCK read/session requests       |
| `src/vcu/charge-soc-limit.ts:191` | SOC-limit write                    |
| `src/vcu/charge-soc-limit.ts:217` | SOC-limit read                     |
| `src/vcu/kwp-client.ts:576`       | Multi-frame sender callback        |
| `src/vcu/kwp-client.ts:862`       | KWP session/read/keepalive         |
| `src/vcu/write-session.ts:937`    | RTC sync                           |
| `src/vcu/write-session.ts:983`    | Charge-current pair                |
| `src/vcu/write-session.ts:1014`   | Stop gesture                       |
| `src/vcu/write-session.ts:1312`   | Diagnostic write-session exchanges |

`src/vcu/multiframe-transfer.ts:455` is the additional callback edge. It checks its callback's numeric result and counts accepted frames to distinguish an initial rejection from a partial exchange.

## Checks and limits

`scripts/check-can-transmit.ts`, registered in `npm test`, uses a scripted channel that separately records attempts and accepted frames. The fakes return the **literal 16**, independent of production constants. It exercises -1 and thrown errors, unexpected returns, an oversized payload, factory options, OBD round pacing, bounded logs, capped DTC recovery, E-LOCK cleanup, command results, SOC read-back failures, KWP partial transfers and VCU batch aborts. `check-charge-attempt.ts` additionally exercises first- and second-frame rejection through real HTTP and preserves #348's existing assertions.

Mutation verification must reject restoring the blocking factory, accepting eight instead of sixteen, ignoring a native rejection, swallowing DTC flow-control failure, reporting a partial transfer as successful or wholly unsent, and reporting charge-current `not-sent` after an accepted frame.

These are synthetic checks of application behavior. They do not fill a real kernel queue, load the native addon on macOS, prove bike acknowledgement, or establish a reproduced stall. No live bus or Pi test is part of this verification. A ride can expose failed-transmit diagnostics; it cannot establish that a stall was fixed.
