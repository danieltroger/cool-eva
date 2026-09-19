# The BLE adapter wedge: `Operation already in progress` forever

The Pi's Bluetooth adapter gets stuck in a state where every scan is refused, BLE telemetry stops for the rest of the boot, and restarting `cool-eva` does not help. This is what it is, how it was established, and what clears it. Issue #299.

Sources are pinned, because these line numbers move: BlueZ `bluez/bluez@0efa20cbf3fb5693c7c2f14ba8cf67053ca029e5` (tag 5.82, the version the Pi runs) and the kernel `raspberrypi/linux@9c40c75f681b0b8882db9b624dfec8f81ff492f2` (`rpi-6.12.y` as read on 2026-09-19). The Pi actually runs `6.12.47+rpt-rpi-v8`, `Debian 1:6.12.47-1+rpt1 (2025-09-16)` — a Debian build, not that branch head, so treat the line numbers as addresses into the tree that was read, not into the running binary.

## What it looks like

```
Sep 19 18:28:52  ble: no frames for 30 s — reconnecting
Sep 19 18:28:57  ble: session failed: Operation already in progress
Sep 19 18:29:02  ble: session failed: Operation already in progress
      … every ~5 s, for hours, across a `systemctl restart` …
```

## How often, and how it ends

From the journal export in `cool-eva-route/data/pi-journals/` (2026-09-15 04:12 → 09-19 17:55, 138 911 lines): **20 632 occurrences — 14.9 % of every line in the export** — over 1 779 of those 6 583 wall-clock minutes (27 %).

Fourteen episodes. **Not one ever recovered.** In thirteen the last storm line _is_ the boot's last journal line; the fourteenth misses by three seconds, a shutdown.

| boot start (CEST) | storm                     | lines |
| ----------------- | ------------------------- | ----- |
| 09-17T18:42:47    | 18:53:36 → 09-18T06:36:02 | 8 206 |
| 09-16T20:24:30    | 20:29:11 → 09-17T06:06:01 | 6 740 |
| 09-17T06:09:51    | 09:49:37 → 11:57:29       | 1 493 |
| 09-16T12:25:05    | 13:07:33 → 14:41:53       | 1 102 |
| ten more          |                           | 3 091 |

Two numbers the fix turns on, both measured across all fourteen:

- **The wedge forms 35-57 s after a good connect** (35, 56, 35, 35, 56, 57, 36, 57, 57, 57, 35, 57, 35, 35 — mean 46 s). One churn cycle: connect, 30 s silence, reconnect, wedged. It is not a slow drift.
- **Retry spacing while wedged is 5 s** — 20 618 consecutive gaps, median 5.0 s, mean 5.1 s, 86.2 % between 5.0 and 5.5 s. That is `RECONNECT_DELAY_MS` and nothing else: the throw is immediate.

## What it costs

`motor_power_kw` (BLE) against `motor_power_can_kw` (CAN 0x410) minute by minute, 2026-09-16 09:25 → 09-19 14:36 CEST. An episode is a maximal run of consecutive wall-clock minutes with **no** BLE reading and **at least one** CAN reading, trimmed to its awake extent, bridging minutes with neither:

```sql
WITH win(a,b) AS (VALUES(
  CAST(strftime('%s','2026-09-16 09:25:00','utc') AS INTEGER)*1000,
  CAST(strftime('%s','2026-09-19 14:36:59','utc') AS INTEGER)*1000)),
can AS (SELECT DISTINCT ts/60000 AS m FROM reading, win
        WHERE signal_id=380 AND ts BETWEEN a AND b),   -- motor_power_can_kw, CAN 0x410
ble AS (SELECT DISTINCT ts/60000 AS m FROM reading, win
        WHERE signal_id=93  AND ts BETWEEN a AND b)    -- motor_power_kw, BLE
SELECT m, (SELECT 1 FROM can WHERE can.m=u.m), (SELECT 1 FROM ble WHERE ble.m=u.m)
FROM (SELECT m FROM can UNION SELECT m FROM ble) u ORDER BY m;
```

1 283 awake minutes, 345 BLE-dead. Seven episodes are 100 % storm minutes, spanning 338 minutes of which **317 are minutes the bike was demonstrably awake — 5 h 17 m**. Each ended only at the next reboot. (Queried 2026-09-19T20:32Z against a `rides.db` with mtime 18:15 CEST; other tracks re-import it, so re-run before quoting.)

**What a BLE outage actually loses is narrower than it looks.** Of the ten signals `src/ble/protocol.ts` emits, eight have a CAN twin — `km_per_kwh`, `kwh_per_100km`, `vehicle_state`, `vehicle_substate`, `motor_power_kw`, `motor_torque_nm`, `odometer_km` (3.4 % long) and `range_km`. Only **`trip_km` and `avg_consumption_wh_km`** do not, plus the type-25 active-fault list, which cannot be requested over CAN at all (`docs/can-0x7c4.md`, #58). Generate that list rather than trusting this paragraph — it has been written wrong three times:

```sh
grep -oE 'key: "[a-z0-9_]+"' src/ble/protocol.ts | sed 's/key: //;s/"//g' | sort -u
grep -n '_can' src/can/registry.ts
```

## The cause

### It is not the hub, and not a pending `Connect()`

The error _string_ settles it. BlueZ `src/error.c:35-39` and `:65-69`:

```c
DBusMessage *btd_error_busy(DBusMessage *msg)
{
	return g_dbus_create_error(msg, ERROR_INTERFACE ".InProgress",
					"Operation already in progress");
}
...
DBusMessage *btd_error_in_progress(DBusMessage *msg)
{
	return g_dbus_create_error(msg, ERROR_INTERFACE ".InProgress",
					"In Progress");
}
```

Two different texts on one interface name. `Device1.Connect()` raises the _second_ — `src/device.c` calls `btd_error_in_progress()` and never `btd_error_busy()`. Of the interfaces node-ble touches (`Adapter1`, `Device1`, GATT), only `Adapter1` can produce the first. (`btd_error_busy` also appears at `profiles/network/connection.c:296` for PAN, which node-ble never speaks.) node-ble's own string for this would be `Discovery already in progress` — a different sentence.

Corroborated by the journal: across the 8 206-line episode the client logged no `ble: discovered hub` and no `ble: connected to`, so it never reached `discoverHubAddress()`. It throws at `adapter.startDiscovery()`.

### It is the kernel's discovery state machine

`btmon` on the Pi, 2026-09-19 22:07 CEST, while wedged:

```
bluetoothd[496]: @ MGMT Command: S.. (0x003a) plen 4  {0x0001} [hci0] 13.468196
@ MGMT Event: Command Complete (0x0001) plen 4        {0x0001} [hci0] 13.468221
      Start Service Discovery (0x003a) plen 1
        Status: Busy (0x0a)
```

Rejected in **25 µs with no HCI command emitted** — so not the controller, not the radio, not the peer. `start_service_discovery()` (`net/bluetooth/mgmt.c:6176-6190`) returns `MGMT_STATUS_BUSY` when `hdev->discovery.state != DISCOVERY_STOPPED || HCI_PERIODIC_INQ`, or when `hdev->discovery_paused`. `discovery_paused` is set only at `hci_sync.c:6217` inside `hci_pause_discovery_sync()` (defined `:6202`), which only `hci_suspend_sync()` calls (`:6337`) — and the journal records **zero** suspends. So `discovery.state` is stuck.

bluetoothd relays that MGMT status to the pending D-Bus caller as `btd_error_busy` in `discovery_complete()` (`src/adapter.c:1790-1812`, reply at `:1807`). Not the same-sender guard at `:2510`: `createBluetooth()` opens a fresh system bus per session and `destroy()` disconnects it, so every attempt is a new sender with no discovery of its own. bluetoothd is a pass-through here; the state is kernel-side.

**Which** stuck state: `busctl` reads `Discovering=false` at bluetoothd while the kernel says busy, and `hci_discovery_set_state()` emits `mgmt_discovering(1)` only on entering `DISCOVERY_FINDING` (`hci_core.c:137-141`) — so `DISCOVERY_STARTING` is the only state with that signature. The kernel has a named route into a permanent one: `start_discovery_complete()` (`mgmt.c:6042-6057`) returns early on `err == -ECANCELED || !mgmt_pending_valid(hdev, cmd)` **before** the `hci_discovery_set_state(hdev, err ? DISCOVERY_STOPPED : DISCOVERY_FINDING)` at `:6055`, while `start_service_discovery()` already set `DISCOVERY_STARTING` at `:6262`. Nothing is left to move it. Which invalidation fires is not established — `discovery.state` is not readable without instrumenting the kernel.

## What clears it, and what does not

**A `systemctl restart` does not.** Measured: 2026-09-19, the storm ran from 18:28:57 under pid 673 and was still running at 22:04:47 under pid 24234 — 3 h 53 min and a restart later. Nothing in userspace writes `discovery.state`.

**Powering the adapter off and on does.** Verified on the bike, 2026-09-19 22:21:46: `bluetoothctl power off; sleep 1; bluetoothctl power on` after 2 642 consecutive failures → `ble: discovered hub` at 22:21:48, `ble: connected to` at 22:21:50, and zero further busy replies. Two seconds, after nearly four hours.

`set_powered(0)` has **two** routes to `DISCOVERY_STOPPED` and that run does not discriminate between them:

1. `mgmt.c:1413-1417` runs `hci_cmd_sync_cancel_sync(hdev, -EHOSTDOWN)` _before_ queueing the power-off. `-EHOSTDOWN` is not `-ECANCELED`, so it passes the guard in `start_discovery_complete()` and reaches the STOPPED write at `:6055` — the controller need never go down.
2. `hci_set_powered_sync()` (`hci_sync.c:5898`) → `hci_power_off_sync()` (`:5861`) → `hci_dev_close_sync()` (called at `:5891`), whose STOPPED write is at `:5415`.

The command works either way. Do not assert which one fired.

### ⚠️ It does not disturb wifi, and here is why that was safe to assume

The Pi Zero 2 W has one Broadcom die, so the question is fair. It is answered by the call path, not by luck: `hci_ldisc.c:697` sets `hdev->close = hci_uart_close`, and `hci_uart_close()` (`:282-289`) is only `hci_uart_flush(hdev); hdev->flush = NULL;`. The function that drives BT*REG_ON low and disables the LPO/TXCO clocks is `bcm_close()` (`hci_bcm.c:527-568`), reached through `hu->proto->close` at `hci_ldisc.c:206/590/736` — line-discipline and serdev \_teardown*, not MGMT power-off. `hci_bcm.c` never assigns `hdev->shutdown`. The radios also sit on separate host buses with separately loaded firmware: BT is `hci_uart_bcm serial0-0` (`brcm/BCM43430B0.raspberrypi,model-zero-2-w.hcd`), wifi is `brcmfmac` over SDIO (`brcm/brcmfmac43430b0-sdio`), and the BT driver's supplies are dummy regulators on this board (`supply vbat not found, using dummy regulator`).

Measured through the 22:21:46 bounce: `wlan0` still connected, same address, default-gateway ping 2/2 with 0 % loss, and **zero** `wlan0` / `brcmfmac` / `NetworkManager` / `Bluetooth: hci0` / `hci_uart` kernel lines. It did not even produce a log line.

### ⚠️ A manual bounce is undone within ~5 s unless you stop the service first

`ensureBluetoothAdapterUp()` runs `bluetoothctl power on` at the top of every `runSession()`, which during a storm is every ~5 s. That is very likely why the verification transcript read `Powered=true` one second after `power off`. `CLAUDE.md` already says to stop `cool-eva` before a scratch BLE probe; this is the sharper reason.

## What the service now does

`src/ble/recovery.ts` decides, `src/ble/client.ts` acts, `scripts/check-ble-retry-policy.ts` holds it to it.

1. **Rate-limited log** — one line per minute while the message repeats, carrying the suppressed count. Nothing is dropped; `stop()` flushes the tail, which matters because thirteen of fourteen episodes ended at a reboot.
2. **Backoff** — 5 → 10 → 20 → 30 s, reset by a connect.
3. **Power-cycle**, gated on the busy reply specifically and after three consecutive ones. Three because no episode has ever self-recovered, so waiting buys nothing; not one, because a single busy reply could race a legitimate concurrent scan. The ten-minute floor applies only between bounces with **no connect in between** — a remedy being retried. A bounce followed by a connect clears it: that is what the floor means, and a bounce a connect followed did not need retrying. ⚠️ An earlier draft justified this with "an unconditional floor would park the adapter wedged ~92 % of the time". **That number was wrong** and is retracted — it multiplied the 35-57 s figure, which says _when_ a wedge forms **given that one forms**, as though a wedge re-formed after every recovery. Nothing measures that: across the export `ble: connected to` appears 2 550 times against 14 wedges, so P(wedge | connect) ≈ **0.55 %**, and the one recovery ever observed (the 22:21:46 bounce) ran ~12 minutes without re-wedging. What survives is the asymmetry: a wedge costs the rest of the boot today, so if a second one does form the floor must not be what stands between the bike and the remedy.

Three other failures reach the same catch and none is cured by a power-cycle, which is why the gate is on the string and not on a bare failure count: `le-connection-abort-by-local` (×11 in the archive), ATT error 0x0e (×3), and `discoverHubAddress()`'s 40 s "no Energica hub found while scanning".

## The open question, and what would answer it

When `startDiscovery()` fails busy, the log line now also reports whether BlueZ still holds a name-matching device object. It did on 2026-09-19 22:30 — `dev_…` with its GATT tree already resolved — but discovery was _running_ at the time, so the wedged case is unobserved. `discovery_cleanup()` (`adapter.c:1700-1727`) only reaps temporaries that are not connectable, and the hub advertises connectably, so it plausibly survives.

If it does, `discoverHubAddress()` needs no live scan at all — it enumerates `adapter.devices()`, BlueZ's object tree — and a wedge might cost nothing if the failure were made non-fatal.

⚠️ **A surviving object is necessary but not sufficient, and the difference is a whole second chokepoint.** `hci_update_passive_scan_sync()` (`hci_sync.c:3300-3302`):

```c
	/* If discovery is active don't interfere with it */
	if (hdev->discovery.state != DISCOVERY_STOPPED)
		return 0;
```

and `hci_connect_le_scan()` (`hci_conn.c:1581`) delegates to `hci_update_passive_scan(hdev)` at `:1631` having issued no connect itself. **The same stuck variable gates the connect path.** So do not reinstate a non-fatal `startDiscovery()` on the strength of "the object survived": the evidence needed is a successful `connect()` _while wedged_. Two further traps if you try it — the swallowed busy reply must not become what the retry policy sees (it gates the power-cycle on that string), and the object-gone branch then spends 40 s in `discoverHubAddress()` rather than 5 s, delaying the one remedy that is known to work.

## Not this issue: the churn that precedes it

Every wedge follows a run of `connected → "Not connected" → "no frames for 30 s" → reconnect`. **That is normal for a charging bike, not a fault.** BLE session confirm rate by vehicle state, from the same journal: riding **97.0 %** (1 158/1 194), parked and not charging 66.8 %, DC charging 3.0 %, **AC charging 0.2 % (1/418)**. Corroborated on `archive-all.db` over four weeks by BLE-frame presence per awake minute — AC **9/4 111 = 0.2 %** across 26 windows and 78 hours. See #261.

So on a charging bike a journal full of `Not connected` is the expected log, and chasing it is chasing the vehicle's own power management. The line that is _not_ expected is `Operation already in progress`.
