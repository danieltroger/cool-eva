# The USB2CAN probe that fails at boot

**Symptom:** the Pi boots, `can0` does not exist, and the service runs coolant-only for the whole session (`can: init failed — continuing with coolant only: … Cannot find device "can0"`). Intermittent. A `sudo systemctl restart cool-eva` does **not** fix it on its own, because the problem is a level below the service: the kernel never finished binding the adapter.

**Recovery, since this doc:** `ensureCanAdapter()` in `src/can/adapter-rebind.ts` runs at the top of `bringUpCan()`. When `can0` is missing and the USB2CAN is on the bus with no driver bound, it writes the interface to `/sys/bus/usb/drivers/usb_8dev/bind`, which re-runs the probe. Decision table replayed by `scripts/check-can-adapter-rebind.ts`.

## What was observed, 2026-11-01

Pi Zero 2 W, kernel `6.12.47+rpt-rpi-v8`, 8devices Korlan USB2CAN (`0483:1234`, serial `4CDD3E16`, firmware 2.4, hardware 2.0) directly on the OTG port, no hub. ⚠️ The journal stamps that boot **Aug 24 19:34 PDT**: that is the clock restored from `/var/lib/systemd/timesync/clock` before any GPS lock (no RTC, see `src/gps/clock.ts`), not the date it happened.

```
[    2.582952] usb 1-1: Product: USB2CAN converter        ← enumerates fine
[   11.045833] CAN device driver interface                 ← can_dev loads, usb_8dev probe starts ~11.15
[   12.158566] usb_8dev 1-1:1.0 can0: no command message answer
[   12.158598] usb_8dev 1-1:1.0 can0: can't get firmware version
[   12.188814] usb_8dev 1-1:1.0: probe with driver usb_8dev failed with error -110
[   12.189032] usbcore: registered new interface driver usb_8dev
```

`lsusb -t` then showed the interface with `Driver=[none]`, and `ip link show can0` said `Device "can0" does not exist`. The service started at about 14 s, found no `can0`, and gave up for the boot.

**The dongle was not wedged.** Writing `1-1:1.0` to `/sys/bus/usb/drivers/usb_8dev/bind` six minutes later probed first time (`firmware: 2.4, hardware: 2.0`). Then 20 de-authorise/re-authorise cycles (`/sys/bus/usb/devices/1-1/authorized` 0 → 1, which re-enumerates and re-probes) succeeded 20 out of 20 on the idle Pi. Restarting the service after the manual bind brought `can0` up at 500k ACTIVE as normal.

## What the kernel does (rpi-6.12.y source, read 2026-11-01)

- **`usb_8dev_probe()`** (`drivers/net/can/usb/usb_8dev.c`) calls `register_candev(netdev)` and only **then** `usb_8dev_cmd_version()`. On error it logs `can't get firmware version`, goes to `cleanup_unregister_candev` and returns the error. There is no retry. The command is one `usb_bulk_msg()` out and one in, each with `USB_8DEV_CMD_TIMEOUT` = `1000` ms; `no command message answer` is the read side timing out, hence `-110` (`ETIMEDOUT`).
- **`really_probe()`** (`drivers/base/dd.c`) calls `driver_sysfs_add(dev)`, which creates the interface's `driver` symlink, **before** `call_driver_probe(dev, drv)`, and removes it on `probe_failed`.
- Put together: **mid-probe, `can0` exists and the interface looks bound**, and both can disappear a second later. Neither is evidence of a working adapter. `decideAdapterAction()` waits instead on the one signal that does separate them: the boot-time probe runs inside module init, because `usb_8dev` is `module_usb_driver(usb_8dev_driver)`, `usb_register_driver()` calls `driver_register()` before printing `registered new interface driver` (matching the dmesg order above), and `do_init_module()` (`kernel/module/main.c`) only sets `mod->state = MODULE_STATE_LIVE` after `do_one_initcall(mod->init)` returns. Until then `/sys/module/usb_8dev/initstate` reads `coming`.
- **`bind_store()`** (`drivers/base/bus.c`) calls `device_driver_attach()`, which runs `__driver_probe_device()` → `really_probe()` synchronously under the device lock and turns a positive probe error back into a negative errno. So the `write()` to `bind` returns only once the probe is over, and fails with the probe's own error when it fails. That is why `ensureCanAdapter()` can re-read straight after a successful bind. A `bind` for an interface that already has a driver fails with `-EBUSY` (`__driver_probe_device()` checks `dev->driver`) rather than probing again. How a `bind` written _during_ the boot-time probe would interleave with it is not read here; `ensureCanAdapter()` never writes one while `initstate` is `coming`.

## The recovery on the hardware, 2026-11-01

`ensureCanAdapter("can0")` run as root from a copy of the branch's module, with `cool-eva` stopped, on the same Pi and dongle, bike awake:

| State set up | Journal line(s) | Returned after |
| --- | --- | --- |
| Healthy: `can0` up, interface bound | none | 25 ms |
| Failed-probe state: `1-1:1.0` written to `usb_8dev/unbind` (no `can0`, no `driver` link) | `binding usb_8dev again, attempt 1`, then `can0 is back after re-binding the USB2CAN (1 bind attempt(s))`; `can0` present, `driver` link back | 91 ms |
| Dongle gone: `0` written to the device's `authorized` (no interfaces on the bus) | `no USB2CAN converter on the USB bus. Is the dongle plugged in?` | 63 ms |

The service then started normally (`can0 up @500k — ACTIVE`). ⚠️ The **unbind is a stand-in** for the boot failure: it produces the same end state (driver live, interface unbound, no `can0`) but not the timed-out probe itself, and the "still initialising" wait was not exercised. A real failed boot is still unobserved under the recovery.

**A second command the dongle did not answer cleanly.** Unbinding while `can0` was still UP logged `can0: couldn't stop device`. That is `usb_8dev_close()` warning that `usb_8dev_cmd_close()` failed. It runs when `usb_8dev_disconnect()` calls `unregister_netdev()` on an interface that is up. The warning does not print the error, so a timeout cannot be told from a malformed reply (`-EPROTO` in `usb_8dev_send_cmd()`). It happened with bus traffic flowing; the boot failure happened with the controller closed. Not investigated; recorded because "the dongle sometimes misses a command reply" may be the general case and the boot probe one instance of it.

## Ruled out, and not

- **USB autosuspend:** `power/control` on the device read `on`.
- **Undervoltage, as the Pi sees it:** `vcgencmd get_throttled` = `0x0` after the failure. This covers the Pi's own rail and its sampling, not a sub-millisecond dip at the dongle.
- **State carried over a warm reboot:** a Zero 2 W does not cut USB power on `reboot`, so that was a candidate, but this boot was cold. The root filesystem needed `orphan cleanup on readonly fs`, i.e. the previous shutdown was a power cut.
- **Not ruled out:** the probe window (~11.15–12.16 s) sits exactly on the busiest stretch of the boot, with `brcmfmac` loading the Wi-Fi firmware (11.44 s) and the BT patch download (11.25–12.01 s). That fits a supply dip or contention on the shared 5 V, but **one boot is a coincidence, not a finding.**

## Still open

- **How often it happens.** Journald is `Storage=volatile` (`docs/power-cuts.md`), so no earlier boots were on record. The recovery logs `can: can0 is missing and USB2CAN … has no driver (its probe failed); binding usb_8dev again` at WARN, so a persistent journal, or a look at `journalctl -u cool-eva -b` after a bad boot, now counts occurrences.
- **Why the dongle missed the reply.** Next time, before anything rebinds: `sudo dmesg | grep -E "usb_8dev|usb 1-1"`, `vcgencmd get_throttled`, and whether the boot was cold (`orphan cleanup` in `dmesg`) or a `reboot`.
- **Not covered by the recovery:** a dongle that drops off the bus mid-ride (the service does not reopen the channel), and one that fails every probe (after four rounds it gives up and the service runs coolant-only, as before).
