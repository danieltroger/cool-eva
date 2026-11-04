# Configuration reference

Open **Menu → Settings** on the dashboard. Screen and Units apply immediately on this phone. Choices stored on the Pi say **Saved. Applies after restart**: review the pending list and use Restart, then confirm the active state after reconnecting. Restart pauses readings and recording and may disconnect Bluetooth. It is refused while fresh motorcycle signals show motion or a service operation holds the bus.

| Settings section | Choices and defaults |
| --- | --- |
| This phone | Screen (Auto / Light / Dark), Units (Metric / Imperial); stored on this phone only. |
| Bike setup | Coolant probes OFF; radiator fan installed OFF; custom BMS configuration NO. Enable only hardware/configuration actually installed. An enabled fan can start automatically after restart. See [fan wiring](fan-control.md) and [BMS explanation](bms-config.md). |
| Charging | **Allow automatic current reduction ON**. This permits requests through the existing current controller; the Charge screen shows its temporary override and actual outcome. The stock BMS already derates: the controller still sends the DC current request displayed on the dash. |
| Connections | Hotspot name for connection checks; dashboard Bluetooth key; motorcycle hub; CAN adapter state; who can reach the controls. The hotspot monitoring name does not configure Wi-Fi credentials. Add/change network management is a later phase; use the [manual installation route](manual-install.md) meanwhile. |
| Ride recording | X25519 public key, active fingerprint and recorder status. Keep and back up the private half on your own devices. Without a configured key, live readings work but rides are not recorded. |
| Cool Eva | Running version and Update. Update uses the running checkout's owner and the same confirmed restart flow. |
| Advanced | Display-only data root, capture and Wi-Fi diagnostic locations. Recording and service directories are editable persistent absolute paths outside code; changing one leaves existing history in its former folder. |

CAN, OBD, E-LOCK, Wi-Fi monitoring, GPS clock discipline and service read/write availability no longer have configuration switches. The radio is `wlan0`; Update operates on the running checkout. CAN health is observational. Restart CAN retains its separate confirmation and does not reopen the service's CAN channel.

There is no dashboard login. Anyone on the same network, or holding the shared Bluetooth key, can use the endpoints and reach service writes. Existing stationary checks, two-tap confirmations, the bus lease, table checks and audit history still apply. Use the dashboard while parked.

## Existing installations

The running service captures its own effective environment once, before starting writers or moving data. This includes the old environment file and systemd drop-ins. Do not delete that wiring before the migration completes. `setup-service.ts` first starts the migration-capable service under the unchanged old unit and waits; a failed migration leaves that unit intact. Existing explicit choices, recording recipient and Bluetooth key carry over. An unset coolant choice intentionally becomes OFF; first open announces that change and points to Bike setup.

The old files remain available for rollback. After migration they are ignored with one warning per start listing names, never values. Change settings in the dashboard. See [settings storage and recovery](settings.md) and [data layout](data-layout.md).

## Fresh/manual installations

Before the first service start, create fresh settings on the Pi with Cool Eva stopped:

```sh
printf '{}\n' | sudo "$(command -v node)" --experimental-strip-types scripts/configure-settings.ts
sudo "$(command -v node)" --experimental-strip-types scripts/setup-service.ts
```

An empty object permits setup later over reachable Wi-Fi: optional probes, fan, Bluetooth and motorcycle hub are off/unselected; automatic DC current reduction is allowed. Choose your motorcycle explicitly under Connections before it enrols the Pi. Recording needs a public key supplied in Settings. The offline writer also accepts the named settings fields as JSON on stdin for the installer; credentials never belong in command arguments or environment variables. It takes the service's writer lock and refuses while that service is running.

Retain a working home-LAN or phone-hotspot profile. Client-isolated hotspots may require home Wi-Fi for the initial dashboard connection. There is no recovery AP. Once Dashboard Bluetooth is configured, a supported client can still reach the dashboard over its BLE tunnel when Wi-Fi is wrong. Otherwise use a reachable existing network, the manual installation/repair route, or card reconfiguration/re-image after complete first-boot loss.
