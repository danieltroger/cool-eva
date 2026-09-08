# The raw CAN capture, and why the service stopped bouncing `can0`

The Pi runs a `candump` alongside the service, writing every frame on `can0` to `/home/pi/ride-captures/`. That corpus is the evidence base for essentially every decode finding in this repo — `docs/can-decode-findings.md`, the ABS work, the charge-manager reconstruction, the 29 freeze-frame replies. It is also the only record that cannot be regenerated: a frame not captured is gone.

This file is why the service used to punch a hole in it on every deploy, what changed, and what a hole still looks like.

## The mechanism, measured twice

`bringUpCan()` took `can0` **down** before bringing it up, on every service start. `ip link set can0 down` ends the `candump` behind `can-capture.service`, whose unit carries `Restart=on-failure` / `RestartSec=5` — ⚠️ quoted from issue #160, not read here: the unit and `capture.sh` are tracked nowhere in this repo and PR 2 gathers them — so systemd waited five seconds and `capture.sh` opened a **new file**. The two gaps below were measured; the directives explaining them were not.

| path | gap | evidence |
| --- | --- | --- |
| the documented freeze-frame procedure | **5 s**, 13:18:44 → 13:18:49 | `capture-20260908-131849-db6cbfba.log`; components 51 and 52 completed inside the hole and were never captured |
| a routine deploy, `dd8acac` → `16a7282` | **~6 s**, 15:08:48 → 15:08:54 | `capture-20260908-150854-59eceef8.log`, two `can-capture` restart events in the window |

⚠️ It was never the `After=cool-eva.service` ordering, and stopping the service alone would not have done it. It was the interface going down. **A deploy is a service restart**, which made this the common case rather than the exotic one — and the two occasions it costs most are a deploy during a DC charge and a deploy mid-ride, which are the scarcest data this project has. Issue #160.

## Why the bounce existed — do not delete this before reading it

Two facts, and the second is the one that makes the first non-obvious:

1. **The kernel refuses to reconfigure a live CAN device.** `can_changelink()` in `drivers/net/can/dev/netlink.c` returns `-EBUSY` for bitrate, ctrlmode and `restart_ms` while `IFF_UP` is set — four `if (dev->flags & IFF_UP)` guards, near lines 315-660 depending on the tree. So taking the interface down is the _only_ way to set any of them.
2. **`listen-only` is STICKY on this adapter.** `ip link set can0 type can bitrate 500000 …` does not clear it, which is why `bringUpCan` passes the flag explicitly every time (`src/can/socket.ts`). A bring-up that assumed the flag was already right could leave the bike silently unable to transmit — the bus looks fine, and every OBD read times out.

So the down/up is not defensive habit. What makes skipping it safe is narrower than "the bounce is unnecessary": it is that **when the link already matches what the bounce would set, running it changes nothing except killing every other socket on the bus.**

## What is skipped now

`bringUpCan()` reads `ip -details -json link show can0` through a pure parser (`src/can/link-config.ts`) and skips the down/up only when **all five** hold:

| condition | why |
| --- | --- |
| `flags` contains `UP` | the admin state `ip link set … up` sets |
| controller state is one of `ERROR-ACTIVE`, `ERROR-WARNING`, `ERROR-PASSIVE` | the link is running (see below) |
| `bitrate` = 500000 | what the bounce would set |
| `restart_ms` = 100 | ditto; at 0 there is no automatic bus-off recovery, so it is not "already configured" |
| `LISTEN-ONLY` present **iff** listen-only was asked for | the sticky flag, proven present or absent, never assumed |

Anything else takes the original path, unchanged. Both branches log: the skip line names every field that was read, the bounce line names only the conditions that failed, so one line explains the verdict either way.

### Which states skip, and the one that is nearly dead

⚠️ **`ERROR-ACTIVE` is the HEALTHY state.** It means the controller is still entitled to send active error frames (`linux/can/netlink.h`: `CAN_STATE_ERROR_ACTIVE = 0, /* RX/TX error count < 96 */`). An earlier draft of this change was specified as "skip unless BUS-OFF or `ERROR-*`", which would have excluded the only state a working bus is ever in and made the feature a no-op that logs. Anyone tightening these conditions should start here.

`ERROR-WARNING` (counters ≥ 96) and `ERROR-PASSIVE` (≥ 128) also skip. They are bus **conditions**, not configuration: the counters decrement again on good traffic, `ERROR-PASSIVE` costs 16 µs of suspend-transmission per frame at 500 kbit and self-heals, and a down/up does not fix what causes them — nothing on the bus is ACKing. Bouncing there would kill the capture to achieve nothing. This matters practically: a parked bike whose poller has been transmitting into a sleeping bus can climb into one of these, and a garage deploy is the commonest deploy there is.

⚠️ **The `BUS-OFF` branch is near-unreachable, and is not a safety net.** `can_bus_off()` (`drivers/net/can/dev/dev.c`) schedules an automatic restart after `restart_ms`, and the Korlan's `usb_8dev` driver provides `do_set_mode` (`drivers/net/can/usb/usb_8dev.c`), so with `restart-ms 100` the kernel is already resetting the controller within 100 ms and `ip` will rarely catch the device in that state at all. It refuses the skip because refusing is conservative, not because it rescues anything.

### Reading the link by hand

`ip -details link show can0`, and the trap is that **`listen-only` is rendered by presence only**:

```
can <LISTEN-ONLY,TRIPLE-SAMPLING> state ERROR-ACTIVE restart-ms 100
      bitrate 500000 sample-point 0.875
```

ACTIVE is what you see when there is **no** `LISTEN-ONLY` between those angle brackets — very often no `<…>` group at all. An absent group is the good case, not a missing answer. iproute2 prints the array only when at least one control mode is set (`print_ctrlmode()` returns early on zero flags), which is exactly the inference `src/can/link-config.ts` has to guard: an `ip` too old to render CAN details would produce the same absence, and reading _that_ as "listen-only is off" is how the bike ends up mute. The parser therefore demands `info_kind`, `state` and `restart_ms` first, as positive evidence that this `ip` renders the CAN block at all. Deliberately **not** the bitrate: the kernel omits that until one is set, so demanding it would classify every cold boot as unreadable.

⚠️ **A Pi running `OBD_ENABLED=0` really is left listen-only** — `src/index.ts` passes that flag straight through to `bringUpCan` — so after stopping the service there, nothing transmits and every read times out silently. That is when `scripts/read-freeze-frame.ts`'s three commands are what you need:

```bash
sudo ip link set can0 down
sudo ip link set can0 type can bitrate 500000 restart-ms 100 listen-only off
sudo ip link set can0 up
```

Stopping the service on an ordinary (`OBD_ENABLED=1`) Pi does **not** take the link down — `shutdown()` stops the channel and nothing else — so there the link is normally still up ACTIVE and those three commands are unnecessary.

### If you want the old behaviour back

There is deliberately **no environment variable** for it. An env var set during a debug session and forgotten is a silent, permanent regression that no check here can catch. The gesture is two commands instead of one, and after the `down` the skip correctly refuses:

```bash
sudo ip link set can0 down && sudo systemctl restart cool-eva
```

The dashboard's **CAN bus restart** button is unchanged and still there (`src/http/can-restart.ts` → `restartCanLink()`, which never downs the link).

## The residual hole

- **A deploy onto a link that already matches: no hole at all.** No down, no `candump` restart, no file boundary.
- **A genuine reconfigure** — cold boot, stuck listen-only, wrong bitrate, `BUS-OFF` — really does take the interface down, and **nothing can capture through that**. That is physics, not a bug. What it costs is the interface's actual down-time plus whatever the capture side needs to notice.
- **An unreadable `ip`** costs exactly today's behaviour plus one `console.warn`. The skip fails safe, never silent.

⚠️ **The biggest remaining hole is not an accident, it is a scheduled one — and it lands on the scarcest data in the project.** `scripts/capture-charge-stop.ts` and `scripts/probe-charge-command.ts` call `bringUpCan("can0", false)`; the service leaves the bus ACTIVE, so the listen-only condition **always** fails and those runs **always** bounce, then the service restart afterwards bounces back. Two guaranteed holes and two file boundaries per run of the script whose entire job is investigating DC charge stops — the case named at the top of this file as the data this project has least of. Nothing in this half of the change can reach that: the interface genuinely has to be reconfigured. Only making the capture survive a bounce (`candump -D`, the other half) closes it.

Worth recording the other direction too, because it is not written down anywhere else: **eight scratch scripts** ask for an ACTIVE bus — `beam-threshold`, `dash-command-sweep`, `dash-command-write`, `headlight-off`, `lpr-mode`, `probe-charge-command`, `probe-charge-stop`, `reboot-vcu` — and every one of them now skips on a bus the service already left ACTIVE. The garage-scripting path gets the same benefit as the deploy path, for free.

### Why the app configures `can0` at all, rather than systemd-networkd

The obvious deeper fix is to stop the service owning the interface: a `systemd-networkd` `[CAN]` stanza (`BitRate=`, `RestartSec=`, `ListenOnly=`) applied once when the device appears would mean no service start ever reconfigures anything, and this whole read-compare-skip mechanism would be unnecessary. `INSTALL.md` §1 says the app brings up `can0` itself so that no `/etc/network` or networkd configuration is needed, which reads like a convenience choice.

**It is not taken, and the reason is that `bringUpCan` is also the runtime mode flip.** Nine scripts call it across ten call sites, two of them asking for listen-only, to move the bus between modes for the duration of a run; networkd configures a link at appearance and has no answer for that. Owning the interface in the app is what makes those scripts possible, so the cost is this decision function. Recorded here so the next person to ask does not have to re-derive it.

## What the first deploy settles

⚠️ **Until it runs, "no hole on a deploy" is a prediction with an argument behind it, not a measurement.** Three things are unverified as this ships, all on the same event — the bike being powered up again:

1. **That `ip -details -json` is available and shaped as assumed on this Pi.** The fixtures in `scripts/check-can-bringup.ts` are **synthetic**, written from the iproute2 output format rather than captured, because the bike was off. If a field name is wrong the parser reads "unreadable", warns, and bounces — safe, but inert. The journal line says which.
2. **Which controller state this bike sits in when parked.** If it is `ERROR-ACTIVE`/`WARNING`/`PASSIVE` the skip fires; the widened state set exists so that a parked bike is not excluded by construction, but that it is _needed_ is reasoning, not evidence.
3. **Whether `ctrlmode_supported` is populated.** `usb_8dev` sets it including `LISTEN-ONLY`, and iproute2 prints it from inside the same `if (tb[IFLA_CAN_CTRLMODE])` block the kernel fills unconditionally, while `print_ctrlmode()` early-returns on zero flags. So a healthy ACTIVE link should show `ctrlmode_supported` **with no `ctrlmode`** — positive proof that this `ip` renders ctrlmode arrays at all, which does not depend on any flag being set. That is what turns the absence inference above into evidence, and why it is logged.

The expected line is:

```
can: can0 is already up @500k ACTIVE (TX enabled) — skipping the down/up (state=ERROR-ACTIVE operstate=UP bitrate=500000 restart_ms=100 ctrlmode=[] ctrlmode_supported=[…])
```

with **no** `can-capture` restart in `journalctl -u can-capture` around it, and the same capture file still growing.
