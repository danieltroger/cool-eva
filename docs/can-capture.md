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

**Why `restartCanLink()` needs no `down` is the bitrate guard, read the other way.** The dashboard's CAN-restart button sends a bitrate, which _requires_ the device to be down — and it is pressed precisely when the link already is. ⚠️ And when it is not, the bitrate returns `-EBUSY` and the call fails loudly, changing nothing; that is what makes the button safe rather than merely usually-right. `src/can/restart.ts` has said this since long before this issue (it was in `socket.ts` until #240 split it out).

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

`can-capture.service` runs `capture.sh`, which runs one long-lived `candump -D -tA can0` per boot into `/home/pi/ride-captures/capture-<date>-<boot_id8>-<uptime>.log.gz`, through `split -C 65536 --filter='gzip -1 -c >> …'`. Both files are tracked under `scripts/can-capture/` and installed by `scripts/setup-service.ts`. Why it is compressed, and what that costs: §"Why the capture is compressed, and what a power cut now costs".

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

## Why the capture is compressed, and what a power cut now costs

`candump` writes **394 MB/h** of text into `/home/pi/ride-captures/`. On 2026-09-19 that directory held 625 files and 88.9 GiB against 16.3 GiB free (17.5 GB — `df -Pk` said 17 081 612 kB, and `df -h`'s "17G" is GiB) — about **43 powered-on hours** of headroom before the capture, the `.celog` ride log and journald would be fighting over the last gigabytes, and the ride log is the one that must not lose. Compressing the stream at 7.6:1 turns those 43 hours into **~320**. Issue #289.

The cost is the tail. Everything below is measured on the Pi, feeding a real capture into each candidate at 112 kB/s — the archive's own average rate — and snapshotting the output file after 25 s.

| writer | raw capture in flight when the 12 V dies | ratio, 200 MB sample of a real capture |
| --- | --- | --- |
| plain text, `stdbuf -oL` (what this replaces) | **0 B** — the control run | 1.00 |
| `gzip -1` | 799 kB = **7.1 s** | 7.92 |
| `gzip -1 --rsyncable` | 1 047 kB = **9.4 s** | 7.08 |
| `zstd -1` | 824 kB = **7.4 s** | 10.23 |
| **`split -C 65536 \| gzip -1`** | see below | **7.60** at 131072; ~7.35 at 65536 |

⚠️ **A naive `\| gzip -1` costs seven seconds of bus per power cut, and every capture here ends in a power cut.** The mechanism is deflate's block size measured in _input_: zlib emits a block when its 16 384-symbol buffer fills, and on text this repetitive one match covers dozens of bytes, so the first output byte does not appear until **786 432 B** of input has gone in (reproduced independently on a second machine). `--rsyncable` makes it worse, not better. `zstd` is no better and has a fatal reader problem — see below.

### The chunk size is derived, not chosen

`split -C 65536` starts a fresh gzip **member** every 64 kB, and members concatenate: `gzip -dc`, `zcat`, Node's `zlib.createGunzip()` and Python's `gzip` module all read a multi-member file as one stream. So the in-flight quantity stops being "gzip's whole deflate block" and becomes "how much of the current chunk `split` has handed over", which is uniform on 0…CHUNK.

    worst-case loss  =  CHUNK / 112000        (the chunk not yet compressed)
                     +  5.6 kB × 7.6 / 112000 (the compressed tail ext4 had not written back)

`docs/power-cuts.md` §7 measures that second term on the existing archive: the file tail a cut costs is **≤ ~5.6 kB** — one 4096-byte page plus the longest trailing NUL run it observed, 1 527 bytes. That is a **filesystem** quantity, about pages that never reached the card, so it is the same number of _file_ bytes whatever those bytes encode; on a `.gz` they are compressed, and at 7.6:1 they carry ~43 kB of frames, ≈ 0.38 s. Then:

| CHUNK     | typical loss | worst-case loss |
| --------- | ------------ | --------------- |
| 131072    | ~0.96 s      | **1.55 s**      |
| **65536** | **~0.57 s**  | **0.97 s**      |

The bound is 1.367 s — the longest of the three complete shutdown walks in `docs/power-cuts.md` §7, which end 0.000 / 0.184 / 1.367 s after the bike's last `0x101` substate change. Solving for the chunk gives `(1.367 − 0.38) × 112000` ≈ **110 kB**, and **65536 is the largest power of two under it**. (Not "the largest chunk" — 110 592 would also fit. A power of two is the conventional choice and leaves margin, which is worth having because the 0.38 s term is a bound rather than a measurement.) At 131072 the worst case is 1.55 s and a power cut could swallow the measurement whole; at 65536 it is 0.97 s. The ratio cost of the smaller chunk is **3.4 %**, measured on the same window.

⚠️ **Say what this does and does not cost — and do not overstate the second half.** Park-lead measurements — the 10.03–442.11 s between entering state 60 and the end of the boot, which is what `src/storage/seal-on-park.ts` is built on — are untouched; §7 already treats them as lower bounds that tail loss only makes more conservative.

The shutdown-walk class is a different matter, and an earlier draft of this paragraph was too kind to itself. **A 0.97 s worst case does not preserve a 0.000 s or a 0.184 s walk; it erases them, and it shortens the 1.367 s one.** What the chunk size buys is that such a walk is not swallowed _whole_ — the last `0x101` substate change stays inside the file rather than falling off the end of it, which a 1.55 s worst case could not promise. A shutdown walk measured off a compressed capture is a **lower bound on the lead, not a measurement of the ending**, and should be written down as one. Nothing moves retroactively: all three files behind the existing figures are in the uncompressed archive on the laptop.

### Truncated captures are the normal case, and every reader must survive one

The Pi takes its power from the bike, so almost every capture ends mid-stream. Measured on a real 37.9 MB capture, cut, and then cut and NUL-padded (the ext4 delayed-allocation signature `evidence/keyoff/tail-shape.py` measures):

| reader                                | truncated multi-member `.gz`  | + a trailing NUL run                  |
| ------------------------------------- | ----------------------------- | ------------------------------------- |
| `gzip -dc` (GNU 1.13, on the Pi)      | 388 134 B of 400 000, exit 1  | prefix, exit 1                        |
| `gzip -dc` (Apple gzip 479, on a Mac) | **327 551 B** — 60 kB less    | prefix, exit 1                        |
| Node `zlib.createGunzip()`            | 388 134 B, then `Z_BUF_ERROR` | 390 754 B, then **`Z_BUF_ERROR` too** |
| Python `gzip.open()`                  | 388 134 B, then `EOFError`    | same                                  |

⚠️ **How much a CLI recovers from a cut member is implementation-dependent** — Apple's gzip gives up 53 kB earlier than GNU's on the identical file — so `scripts/check-capture-reader.ts` asserts against **Node's** number, which is the same on both platforms because it is the same zlib. What every reader agrees on is that the recovered bytes are a **byte-exact prefix**, and that the last line is routinely a partial one. `scripts/replay-capture.ts` counts an unparseable line as `framesSkipped` and `evidence/keyoff/reduce-captures.awk` guards with `NF < 6`, so a partial final line costs a reader nothing.

`scripts/capture-lines.ts` is the one place that opens a capture: it treats **`Z_BUF_ERROR` only** as end-of-data, warns once with the line count, and re-throws everything else — so a missing file, an unreadable one, or a corrupt one is still a fault and not a short capture.

⚠️ **`Z_DATA_ERROR` is deliberately NOT in that set, and an earlier version of this section had it wrong.** Both power-cut shapes give `Z_BUF_ERROR` — the clean cut and the NUL-tailed one, measured above. What gives `Z_DATA_ERROR` is corruption: one flipped byte 20 000 into the _intact_ 400 000 B fixture returns **147 456 B**, one warning and exit 0. Accepting that code as truncation silently loses 63 % of a capture that was entirely there — the same silent-truncation failure this file rejects zstd for, reproduced in gzip by a too-generous error test. Found by the diff reviewer on #302.

⚠️ **The `grep -a` trap has a sibling.** `docs/handlebar-gestures.md` records that a NUL-tailed capture reads as binary to `grep`. A `.gz` is binary to `grep` _always_: it is `gzip -dc file.log.gz | grep …`, never `grep … file.log.gz`, and a cut capture is binary **and** truncated, so the pipe's exit status will be non-zero even when the grep found what you wanted.

### ❌ Why not zstd, which is better at everything except the thing that matters

`zstd -1` is installed on the Pi, compresses these captures **10.23:1** against gzip's 7.92, and is cheaper on a Zero 2 W (20.0 MB/s against gzip's 13.3). Chunked the same way it ties on tail loss exactly. It was still rejected:

> Three concatenated `zstd -1` frames, 852 000 B of capture text. `zstd -dc` → 852 000 B ✓. Node 24 `zlib.createZstdDecompress()` → **284 000 B**, which is frame 1 and nothing else.

Node's zstd decompressor **stops at the first frame of a concatenated file**, and in one of the two reproductions it did so with a clean `end` event and **no error at all** — a silent one-third. `scripts/replay-capture.ts` is a Node reader, so a `.zst` capture would replay the first 64 kB of a 3 GB file and report success. `createGunzip()` walks concatenated members natively. That single difference is the whole reason these files are gzip.

(An earlier draft of this decision argued from Python instead — that 3.13 has no stdlib zstd and `evidence/keyoff/` is Python. That argument is **wrong and withdrawn**: `capture-figures.py` never opens a capture, it reads the reduction's output. The Node defect is the real reason.)

### `split` waits for each filter before starting the next — from the source, not from behaviour

Two `gzip … >> "$OUTPUT"` alive at once would interleave their members' bytes and leave the file unreadable past the splice. `create()` in `coreutils/src/split.c` keeps an `open_pipes[]` array and a comment about _"holding a write-pipe that will prevent the earlier process from reading an EOF"_, which makes concurrent filters look possible. They are not, on this path. `cwrite()`:

```c
  if (new_file_flag)
    {
      if (!bp && bytes == 0 && elide_empty_files)
        return true;
      closeout (NULL, output_desc, filter_pid, outfile);
      next_file_name ();
      output_desc = create (outfile);
```

and `closeout()` blocks:

```c
  if (pid > 0)
    {
      int wstatus;
      if (waitpid (pid, &wstatus, 0) < 0)
        error (EXIT_FAILURE, errno, _("waiting for child process"));
```

`closeout` — closing the write end and **blocking in `waitpid`** — runs before `create` spawns the next filter, and `line_bytes_split` (the `-C` path) writes only through `cwrite`. So the previous `gzip` has exited, and flushed its complete member and trailer, before the next one starts. Confirmed on the Pi: 207 samples over a 20 s paced run, **max concurrent `gzip` = 1**, and the output decompressed to a byte-exact copy of the input.

That same `closeout` turns a filter's non-zero exit into `error (ex, 0, "with FILE=%s, exit %d from command: %s")`, so **a gzip that dies makes `split` exit non-zero** — and `split` is the pipeline's last command, so that status is the pipeline's and `set -e` restarts the unit rather than quietly writing nothing.

### ⚠️ Why candump's exit status travels in a file, and not through `pipefail`

`candump` used to be the unit's main process, so its exit status was the unit's. In a pipeline the status is `split`'s — so a `candump` that dies (`SIOCGIFINDEX: No such device` after the 240 s wait loop gives up, `ENODEV` on an unplugged adapter) would exit **0**, systemd would call the unit cleanly finished, and the capture would stop until the next boot. The loud 240 s restart loop described above would become silence.

`set -o pipefail` fixes that and **is not portable enough to be trusted with it**, which was learned the expensive way: the first version of this change used it behind a `(set -o pipefail) 2>/dev/null` guard, and CI went red because that runner's `/bin/sh` has no such option — dash gained it only in 0.5.12 — so the fallback fired and the script exited 0 on a dead candump. The exact failure the line exists to prevent, reintroduced by depending on an optional feature to prevent it.

So the status goes into a file and out through an explicit exit:

```sh
STATUS_FILE=$(mktemp)
{
  echo "# boot $BOOT_ID uptime $UPTIME"
  if stdbuf -oL timeout 28800 candump -D -tA can0; then
    echo 0 > "$STATUS_FILE"
  else
    echo $? > "$STATUS_FILE"
  fi
} 2>&1 | split -C 65536 --filter='gzip -1 -c >> "$OUTPUT"'

CANDUMP_STATUS=$(cat "$STATUS_FILE")
rm -f "$STATUS_FILE"
exit "$CANDUMP_STATUS"
```

The `if` is what stops `set -e` killing the group before the status is written; a status that reads back as anything but a number exits 1 loudly rather than reporting success; and `mktemp`, `cat` and `rm` joined the `command -v` guard because they are now load-bearing. `set -o pipefail` reappearing in the script is itself a check failure, with the reason attached, so it does not come back as a tidy-up.

### The disk floor waits; it does not exit

`capture.sh` refuses to start a capture under **10 GiB free**, rechecking every 60 s and logging every 5 minutes. It never touches the ride log or the journal — it only declines to open a capture.

- `exit 1` would restart-loop at 0.2 Hz forever; `exit 0` would leave the unit dead with nothing to restart it when space appeared. Waiting keeps the unit `active` and starts capturing within a minute of `scripts/free-pi-captures.ts` freeing space.
- ⚠️ **An unreadable `df` fails CLOSED.** Not knowing the free space is not permission to fill the card.
- A start-time check is enough: at 7.6:1 an 8 h capture is ~415 MB, where it used to be 3.15 GB, so no single capture can eat the floor.
- `freeBytes` in `/status` is `statfs().bavail`, the same number `df -Pk` reports in Available — measured on the Pi as root at 17 081 612 kB against statfs's 17 081 476 kB, while `bfree` reads 22 096 004 kB. Mixing up `bavail` and `bfree` would put 5 GB between the floor and the dashboard.

### ❌ The alternative that was rejected, with its best case on the record

Compress each finished capture at the **next boot** instead of streaming. It costs no tail at all, which is its real argument, and its strongest form is more elegant than the obvious one: the `boot_id` already in every filename makes _"not my boot"_ an exact, **clock-free** liveness test, strictly better than `mtime > N minutes` on a Pi with no RTC.

It was not taken because Daniel asked for the stream (_"if you can stream to a gzipped file, go on that too so future writes need less data"_) and the condition turned out to be meetable at ~0.6 s; because it writes ~1.13× as much to the card rather than 0.13×; and because it holds an uncompressed 3.15 GB capture _plus_ the previous boot's file on the card at once — which is what the 10 GiB floor would then be spending itself on.

### ⚠️ Still open: the loss figures are arithmetic plus one evening

The 0.57 s / 0.97 s above are a measured chunk distribution plus §7's `≤ 5.6 kB` scaled by the compression ratio. They are **not** a corpus. `evidence/keyoff/tail-shape.py` grew a `.gz` mode to settle them — member count, last-member raw size, and whether the last complete line parses — and it wants a week of real `.log.gz` captures before any of these numbers should be quoted as measured rather than derived.

### How the committed fixtures were made

`scripts/fixtures/capture-pipeline-{clean,truncated}.log.gz` came off the Pi, through the real pipeline, so that `scripts/check-capture-reader.ts` tests GNU `split`'s actual output on a Mac that has no GNU `split`:

```sh
export OUTPUT=clean.log.gz; : > "$OUTPUT"
head -c 400000 /home/pi/ride-captures/capture-20260919-165030-dcf59758-00000024.log \
  | split -C 65536 --filter='gzip -1 -c >> "$OUTPUT"'
head -c $(( $(stat -c %s clean.log.gz) - 2000 )) clean.log.gz > truncated.log.gz
```

7 members and 400 000 B, `cmp`-clean against the input; the truncated one keeps 5 whole members plus the cut one, and Node recovers 388 134 B of byte-exact prefix from it — which is the shape `evidence/keyoff/tail-shape.py` reports for it. The clean fixture's own last line is partial because `head -c` cut it there — deliberately, so a reader that mishandles a partial final line cannot pass.
