# The raw CAN capture, and why the service stopped bouncing `can0`

The Pi runs a `candump` alongside the service, writing every frame on `can0` to `/home/pi/ride-captures/`. That corpus is the evidence base for essentially every decode finding in this repo — `docs/can-decode-findings.md`, the ABS work, the charge-manager reconstruction, the 29 freeze-frame replies. It is also the only record that cannot be regenerated: a frame not captured is gone.

This file is why the service used to punch a hole in it on every deploy, what changed, and what a hole still looks like.

> ⚠️ **Calibration.** Nearly everything below cites kernel, iproute2, systemd or can-utils source, and several of those citations were wrong at some point in this file's short life — mostly because they were relayed from a review comment and repeated without anyone opening the file, and once because a fetch was asked to _characterise_ code rather than quote it and answered confidently backwards, overwriting a true sentence. Fetching and reading is what fixed them. `CLAUDE.md` carries the rule; this note is here because it is this file that earned it. Treat a citation you have not opened as a lead.

## The mechanism, measured twice

`bringUpCan()` took `can0` **down** before bringing it up, on every service start. `ip link set can0 down` ends the `candump` behind `can-capture.service`, whose unit carries `Restart=on-failure` / `RestartSec=5` — ⚠️ quoted from issue #160, not read here: the unit and `capture.sh` are tracked nowhere in this repo and PR 2 gathers them — so systemd waited five seconds and `capture.sh` opened a **new file**. The two gaps below were measured; the directives explaining them were not.

| path | gap | evidence |
| --- | --- | --- |
| the documented freeze-frame procedure | **5 s**, 13:18:44 → 13:18:49 | `capture-20260908-131849-db6cbfba.log`; components 51 and 52 completed inside the hole and were never captured |
| a routine deploy, `dd8acac` → `16a7282` | **~6 s**, 15:08:48 → 15:08:54 | `capture-20260908-150854-59eceef8.log`, two `can-capture` restart events in the window |

⚠️ Those two rows are the one thing in this file that cannot be checked from a laptop: they were measured on the Pi against the capture archive, and are reproduced from issue #160 rather than re-derived here.

⚠️ It was never the `After=cool-eva.service` ordering, and stopping the service alone would not have done it. It was the interface going down. **A deploy is a service restart**, which made this the common case rather than the exotic one — and the two occasions it costs most are a deploy during a DC charge and a deploy mid-ride, which are the scarcest data this project has. Issue #160.

## Why the bounce existed — do not delete this before reading it

Two facts, and the second is the one that makes the first non-obvious:

1. **The kernel refuses to reconfigure a live CAN device.** `can_changelink()` in `drivers/net/can/dev/netlink.c` returns `-EBUSY` while `IFF_UP` is set, in four guards: ctrlmode, arbitration bittiming, data bittiming (one guard covering both the FD and XL phases), and `restart_ms` — where the kernel states the rule in English, `/* Do not allow changing restart delay while running */`. So taking the interface down is the _only_ way to set any of them, and **all three arguments `canConfigureArgs()` sets — bitrate, restart-ms, listen-only — need it down.**
2. **`listen-only` is STICKY on this adapter.** `ip link set can0 type can bitrate 500000 …` does not clear it, which is why `bringUpCan` passes the flag explicitly every time (`src/can/socket.ts`). A bring-up that assumed the flag was already right could leave the bike silently unable to transmit — the bus looks fine, and every OBD read times out.

**Why `restartCanLink()` needs no `down` is the bitrate guard, read the other way.** The dashboard's CAN-restart button sends a bitrate, which _requires_ the device to be down — and it is pressed precisely when the link already is. ⚠️ And when it is not, the bitrate returns `-EBUSY` and the call fails loudly, changing nothing; that is what makes the button safe rather than merely usually-right. `src/can/socket.ts` has said this since long before this issue.

⚠️ A fifth guard points the other way — `IFLA_CAN_RESTART` returns `-EINVAL` unless `IFF_UP` (`/* Do not allow a restart while not running */`) — but **nothing in this repo sends that attribute**, so it explains nothing here. Recorded only so nobody reaches for `ip link set can0 type can restart` as a recovery and finds it refused on a down link.

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

⚠️ **A cold boot never takes the skip, and that is correct.** `can0` is down and unconfigured then, so **four conditions fail at once** and the first of them is the link not being up — `restart_ms` is present and reads 0 (the kernel emits it unconditionally), and no bitrate has been set, which `bitrateOf()` reads as 0. The journal line is:

```
can: can0 needs configuring — link is not UP (operstate DOWN); controller state is STOPPED; bitrate is 0, not 500000; restart-ms is 0, not 100; bringing it down and up
```

⚠️ The one cold-boot shape that _does_ read unreadable is `can0` not having enumerated yet: the `ip` call itself fails, `bringUpCan` warns and bounces. That is the bring-up half's path, not the capture's.

An earlier draft of this paragraph said `restart_ms` was absent and that the bitrate failed first. Both were wrong, and the first one re-introduced exactly the confusion `src/can/link-config.ts` was changed to remove: an absent `restart_ms` would make the link **unreadable**, not mismatched. On this bike every boot is a cold boot, because the Pi loses power with the ignition. **The skip therefore only ever fires on a service restart onto a bus that is already up**, which is precisely the deploy case issue #160 was opened about, and nothing is lost at boot because `can-capture.service` is ordered `After=cool-eva.service` and has not bound its socket yet.

Anything else takes the original path, unchanged. Both branches log: the skip line names every field that was read, the bounce line names only the conditions that failed, so one line explains the verdict either way.

### Which states skip, and the one that is nearly dead

⚠️ **`ERROR-ACTIVE` is the HEALTHY state.** It means the controller is still entitled to send active error frames (`linux/can/netlink.h`: `CAN_STATE_ERROR_ACTIVE = 0, /* RX/TX error count < 96 */`). An earlier draft of this change was specified as "skip unless BUS-OFF or `ERROR-*`", which would have excluded the only state a working bus is ever in and made the feature a no-op that logs. Anyone tightening these conditions should start here.

`ERROR-WARNING` (counters ≥ 96) and `ERROR-PASSIVE` (≥ 128) also skip. They are bus **conditions**, not configuration: the counters decrement again on good traffic, `ERROR-PASSIVE` costs a suspend-transmission of 8 bit times — 16 µs at 500 kbit, which is arithmetic rather than a measurement — and self-heals, and a down/up does not fix what causes them — nothing on the bus is ACKing. Bouncing there would kill the capture to achieve nothing.

✅ **This is the condition the whole change turns on, and it is now measured.** The gather of 2026-09-08 — bus awake, four minutes after a cold boot — reads **`state: ERROR-WARNING`** with `berr_counter {tx: 0, rx: 1}`. An ordinary working bus on this bike is not `ERROR-ACTIVE`. So the version of this feature that was originally specified, skipping only on `ERROR-ACTIVE`, would have refused every time and been a no-op that logs. The captured body is committed in `scripts/check-can-bringup.ts` and both polarities are asserted against it.

⚠️ An earlier draft justified the widening with "a parked bike whose poller has been transmitting into a sleeping bus can climb into one of these". **That example is wrong on this bike** and is corrected rather than deleted, because it is the reasoning someone would otherwise re-derive: the Pi is powered by the bike and loses power at key-off, so it is not running to see a parked bus at all. A deploy happens with the bike awake, or on an AC charge. The justification stands on the measured awake reading instead.

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

## The capture unit itself

`can-capture.service` runs `capture.sh`, which `exec`s one long-lived `candump -D -tA can0` per boot into `/home/pi/ride-captures/capture-<date>-<boot_id8>.log`. Both files are tracked under `scripts/can-capture/` and installed by `scripts/setup-service.ts`.

⚠️ **Until 2026-09 neither was in this repo.** They existed as one copy on one SD card, with no revert path and no review, while producing the corpus that essentially every decode finding in `docs/` rests on. That is the finding, and it is why they are here now.

**One guard was added that the Pi's copy did not have.** `capture.sh` now checks `command -v candump` before it does anything else. `exec … > "$OUTPUT"` is set up by the shell and truncates the file **before** exec'ing, so on a Pi without `can-utils` — not a default Raspberry Pi OS package, and this PR is the first thing to install the unit automatically — every restart would leave an empty capture in the directory the archive is swept from. `scripts/setup-service.ts` also refuses to enable the unit when candump is missing, and says how to install it.

**`-D` is the whole behavioural change.** `Don't exit if a "detected" can device goes down`: candump keeps the socket, keeps the open file, and keeps writing. The kernel half is `raw_notify()` in `net/can/raw.c` — `NETDEV_DOWN` sets `sk_err = ENETDOWN` and does nothing else, leaving the socket bound with its filters registered, so frames resume by themselves and there is no `NETDEV_UP` case to need. Only `NETDEV_UNREGISTER` (the adapter unplugged) unbinds and reports `ENODEV`, which still exits and still gets a restart — that failure should be loud. `raw_bind()` on a device that **exists but is DOWN** sets the same `ENETDOWN` and returns success, so `-D` also survives _starting_ while the interface is down.

⚠️ **It does not survive starting before the device exists at all — and it fails earlier than the bind.** For a named interface candump resolves the ifindex first, so a missing `can0` dies at `ioctl(SIOCGIFINDEX)` with `SIOCGIFINDEX: No such device` and `exit(1)`. No socket is ever bound, `raw_bind()` never runs, and `-D` cannot apply even in principle. That path is reachable: the wait loop gives up after 120×2 s and `exec`s anyway, so a Pi whose adapter never enumerates gets a loud restart roughly every 240 s — which is the behaviour you want, and why the wait loop is **not redundant** with `-D` rather than merely overlapping it. ⚠️ Grep the journal for `SIOCGIFINDEX`, not `bind`: successive drafts of this paragraph named the wrong layer more than once, so check it against `candump.c` before relying on it.

### ⚠️ `-D` invalidates a forensic rule that is written down elsewhere

`docs/charge-manager.md` §E2 dates a DC-charge fault partly on this reasoning:

> a reader that died would normally not resume inside the same file, which argues for the first

That was true **only because candump exited**. From this change onward a reader that "dies" on an interface bounce _does_ resume inside the same file, so the rule separates nothing.

**The cutover is this commit.** For captures written before it the rule still holds and E2's reading is unaffected; for captures written after it, a gap inside one file no longer implies the bus went quiet. What replaces the rule is the in-band marker below.

### Why `2>&1` stays, and must

The script folds candump's stderr into the capture file. That is inherited behaviour, and with `-D` it becomes load-bearing: the file boundary that used to mark a gap is gone, so candump's own `can0: interface down` line is the **only** evidence inside the file that one happened — and the file is what gets archived to the laptop, while the journal stays on an SD card that gets reflashed. Removing it would make post-`-D` captures silently gappy, which is worse than what came before. `scripts/replay-capture.ts` skips any line that is not a frame, so it costs nothing to read.

### The unit is left almost exactly as it was found

Only `ExecStart` changes, to run the tracked script through `/bin/sh` (so a lost exec bit cannot fail the unit at boot with `203/EXEC`). `Restart=on-failure`, `RestartSec=5`, `User=root` and the `cool-eva` ordering are what has been running and are deliberately untouched.

⚠️ **If a `StartLimit*` key is ever added here, it belongs in `[Unit]`** — and the trap is worse than "it gets ignored". systemd's `load-fragment-gperf.gperf.in` accepts `StartLimitInterval=`, `StartLimitBurst=` and `StartLimitAction=` in `[Service]` as legacy compatibility aliases pointing at the `Unit` offsets, but there is **no `Service.StartLimitIntervalSec`**. So writing `StartLimitIntervalSec=0` next to `StartLimitBurst=5` in `[Service]` gives you a **half-applied** rate limit: the burst is honoured, the interval silently is not, and the default 10 s window stays in force while you believe the limit is off. An earlier draft here said both keys were ignored in `[Service]`; only the newer spelling is. There is none today and `scripts/check-can-capture.ts` keeps it that way.

⚠️ **And there is no brake, which is worth knowing rather than assuming.** With `RestartSec=5` and systemd's defaults (`StartLimitBurst=5` in `StartLimitIntervalSec=10s`), five restarts span 25 s, so the burst is never reached: a unit that fails every time **restart-loops indefinitely at 0.2 Hz** rather than stopping in `failed`. An earlier draft of this change set `RestartSec=1` and disabled the limit to save ~12 s a day at the 8 h rotation; it was dropped because it quintuples that loop's rate for a saving nobody asked for, not because the default limit would have caught anything. What actually bounds the damage is the `command -v candump` guard in `capture.sh`: the loop then writes no files, because `exec … > "$OUTPUT"` never runs.

## The residual hole

- **A deploy onto a link that already matches: no hole at all.** No down, no `candump` restart, no file boundary.
- **A genuine reconfigure** — cold boot, stuck listen-only, wrong bitrate, `BUS-OFF` — really does take the interface down, and **nothing can capture through that**. That is physics, not a bug. What it costs is the interface's actual down-time plus whatever the capture side needs to notice.
- **An unreadable `ip`** costs exactly today's behaviour plus one `console.warn`. The skip fails safe, never silent.
- **The 8 h rotation** still opens a new file and still costs `RestartSec=5`, three times a day. Unchanged, and deliberately so.
- **`-D` makes a wedged-down interface quiet.** Before it, an interface left down produced a visible 5 s restart loop; now it produces one stderr line and silence. `can_link` on the dashboard (`src/can/link-status.ts`, polled every 15 s) is the instrument that replaces the noise.
- **A candump killed by hand exits 0**, so `Restart=on-failure` leaves the unit `inactive (dead)` rather than restarting it, and nothing on the dashboard says so — `can_link` reports the _interface_, not the capture. Pre-existing, but worth knowing now that this unit is deliberately quieter.

⚠️ **The biggest remaining hole is not an accident, it is a scheduled one — and it lands on the scarcest data in the project.** `scripts/capture-charge-stop.ts` and `scripts/probe-charge-command.ts` call `bringUpCan("can0", false)`; the service leaves the bus ACTIVE, so the listen-only condition **always** fails and those runs **always** bounce, then the service restart afterwards bounces back. Two guaranteed holes and two file boundaries per run of the script whose entire job is investigating DC charge stops — the case named at the top of this file as the data this project has least of. Nothing in this half of the change can reach that: the interface genuinely has to be reconfigured. Only making the capture survive a bounce (`candump -D`, the other half) closes it.

Worth recording the other direction too, because it is not written down anywhere else: **eight scratch scripts** ask for an ACTIVE bus — `beam-threshold`, `dash-command-sweep`, `dash-command-write`, `headlight-off`, `lpr-mode`, `probe-charge-command`, `probe-charge-stop`, `reboot-vcu` — and every one of them now skips on a bus the service already left ACTIVE. The garage-scripting path gets the same benefit as the deploy path, for free.

### Why the app configures `can0` at all, rather than systemd-networkd

The obvious deeper fix is to stop the service owning the interface: a `systemd-networkd` `[CAN]` stanza (`BitRate=`, `RestartSec=`, `ListenOnly=`) applied once when the device appears would mean no service start ever reconfigures anything, and this whole read-compare-skip mechanism would be unnecessary. `INSTALL.md` §1 says the app brings up `can0` itself so that no `/etc/network` or networkd configuration is needed, which reads like a convenience choice.

**It is not taken, and the reason is that `bringUpCan` is also the runtime mode flip.** Nine scripts call it across ten call sites, two of them asking for listen-only, to move the bus between modes for the duration of a run; networkd configures a link at appearance and has no answer for that. Owning the interface in the app is what makes those scripts possible, so the cost is this decision function. Recorded here so the next person to ask does not have to re-derive it.

## What the first deploy settles

⚠️ **Until it runs, "no hole on a deploy" is a prediction with an argument behind it, not a measurement.** Three things are unverified as this ships, all on the same event — the bike being powered up again:

✅ **Settled by the 2026-09-08 gather** (issue #160), which is committed as `CAPTURED_PI_LINK`:

1. **`ip -details -json` works and every field name is right** — `linkinfo.info_kind`, `info_data.state`, `restart_ms`, `bittiming.bitrate`, top-level `flags`/`operstate`. The parser reads the real body and returns `skip=true`.
2. **`ctrlmode` is absent while `ctrlmode_supported` is present** (`LOOPBACK`, `LISTEN-ONLY`, `ONE-SHOT`, `CC-LEN8-DLC`). `can_print_ctrlmode_ext()` is called **inside** `if (tb[IFLA_CAN_CTRLMODE])`, on the line immediately after `print_ctrlmode(PRINT_ANY, cm->flags, "ctrlmode")`. So `ctrlmode_supported` appearing in the gather proves the call that would have printed the flags **ran and printed nothing** — `print_ctrlmode()` early-returns on zero flags. That is not an inference about this build; it is the same code path, three lines apart. The riskiest inference in the design is evidence now, not argument.
3. **The controller state is `ERROR-WARNING`**, which is what makes the widened state set load-bearing rather than defensive.

⚠️ **Still open, and the PR says so:**

- **The live journal line from the service itself.** Everything above is the parser agreeing with a captured string; it is not the service agreeing with its own bus. The run has _happened_ — the 2026-09-08 22:14 rollout restarted the service onto `caea7e7` with the bus awake and `can0` in `ERROR-WARNING`, so the decision executed for real exactly once — but the Pi was keyed off before the journal could be read, so the lines are sitting in its persistent journal under boot `e2609b98` awaiting a `journalctl -b -1`. **Until that paste lands this is UNOBSERVED**, and no claim here rests on it.
- **What the bus reports during an AC charge.** This Pi loses power at key-off, so a quiet bus with the Pi up happens only while AC charging, and none was running. If a charging bus reports `BUS-OFF`, a deploy during an AC charge still bounces — one of the two cases issue #160 names as costing most. Nothing in the capture half depends on that answer, which is why `-D` is the more durable fix.
- **The filename can carry a pre-GPS-lock time.** The gather was stamped 20:13 at an uptime of 249 s while journald put the boot at 16:35 — a ~3.6 h clock step mid-boot, which this Pi does because it has no RTC (`src/gps/clock.ts`). The name is chosen once at script start, so under `-D`'s single file per boot it is routinely stamped before the step. The `boot_id` suffix is what keeps it unambiguous — which is exactly what `capture-20600808-220827-0887e861.log`, sitting in that directory from the 2060 incident, exists to demonstrate.

The expected line is:

```
can: can0 is already up @500k ACTIVE (TX enabled) — skipping the down/up (state=ERROR-ACTIVE operstate=UP bitrate=500000 restart_ms=100 ctrlmode=[] ctrlmode_supported=[…])
```

with **no** `can-capture` restart in `journalctl -u can-capture` around it, and the same capture file still growing.
