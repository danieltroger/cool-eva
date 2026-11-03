# Configuration reference

This configuration interface is being simplified; this section preserves the current environment-variable reference.

## Configuration

Every option is an environment variable, and every default is what the bike in the photo runs. Set them in **`/etc/default/cool-eva`**, one `NAME=value` per line:

```bash
sudo tee /etc/default/cool-eva <<'EOF'
COOLANT_ENABLED=0
EOF
sudo systemctl restart cool-eva
```

Not in the unit file — `scripts/setup-service.ts` rewrites that every time it runs, which is exactly what you do to migrate a Pi or after a Node upgrade, and anything configured there would be silently discarded.

| Variable | Default | What it does |
| --- | --- | --- |
| `COOLANT_ENABLED` | on | `0` skips the MAX31865 probes entirely. Set this on a bike with no watercooling loop. |
| `FAN_ENABLED` | **off** | `1` drives the watercooling loop's radiator fan from the Pi's hardware PWM (an IBT-2 half-bridge on GPIO18) and serves `/fan`. It starts in **automatic**, following `batt_temp_hi` up a 35 → 48 °C curve, running flat out for the whole of a DC charge, and stopping above 90 km/h — ⚠️ every one of those three numbers is a considered choice rather than a measurement of this radiator, marked as such wherever it appears ([`docs/fan-control.md`](fan-control.md) §4 and §8) — while the dashboard slider takes it over until the bike is switched off. ⚠️ One of the two opt-**in** switches here, `SERVICE_WRITE_ENABLED` being the other: almost no Eva has this fan, so unset means the Pi never opens `/sys/class/pwm`, never spawns `pinctrl` and answers 404 at `/fan`. Needs the `config.txt` lines in `INSTALL.md` §1 first. See [`docs/fan-control.md`](fan-control.md). |
| `CAN_ENABLED` | on | `0` skips CAN altogether — coolant probes only. |
| `OBD_ENABLED` | on | `0` makes the bus **listen-only**: broadcasts are decoded, nothing is ever transmitted. Costs you the OBD-II PIDs and the trouble-code list. |
| `ELOCK_ENABLED` | on | `0` skips the one-shot keys-paired read from the E-LOCK ECU at startup. |
| `WIFI_ENABLED` | on | `0` skips the wifi poller and the diagnostic dumps it writes. The poller records what the radio is doing as `wifi_*` signals and, after two minutes of _disconnected while the hotspot is in range_, writes a full state dump to `wifi-diag/` — because the Pi can only be asked about its wifi over the wifi that is failing. See [`docs/wifi.md`](wifi.md). |
| `WIFI_IFACE` | `wlan0` | Which radio the poller watches. |
| `WIFI_HOTSPOT_SSID` | **none** | ⚠️ **No default, on purpose** — this is a public repo and an SSID is a personal network identifier. Set it to the name of your phone's hotspot; it is what `wifi_hotspot_seen` and `wifi_network` are measured against. Leave it unset and the poller still records the radio's own state, says so loudly at startup, and never writes a fault dump. |
| `BLE_ENABLED` | on | `0` skips the Bluetooth link to the Connectivity Hub (torque/power, odometer, vehicle state). GPS also arrives over CAN, so you keep position either way. |
| `BLE_MAC` | discover | Pin the hub's address instead of finding it by advertised name. |
| `BLE_SECRET` | off | ⚠️ Opt in. Also serve the dashboard over BLE, to a phone that knows this secret (12+ characters) — the iOS app in `ios/` on iPhone ([`docs/ios-app.md`](ios-app.md)), or the https copy of the dashboard on GitHub Pages in a Web Bluetooth browser: Chrome on Android, Bluefy on iPhone. Unset, the Pi does not advertise. How to connect: [`docs/connecting-over-bluetooth.md`](connecting-over-bluetooth.md); how it works: [`docs/ble-server.md`](ble-server.md). |
| `GPS_TIME_SYNC` | on | `0` never steps the system clock from satellite time. The Pi has no RTC, so leave it on unless you have another time source. A step needs five consecutive satellite readings that agree — see [Clock](diagnostics-and-checks.md#clock). |
| `CUSTOM_BMS_CONFIG` | unset | Set to `1` **only** if the pack's BMS has been reflashed with the custom config — see [below](signals.md#custom_bms_config--set-this-only-if-you-flashed-the-custom-config). Leave unset on a stock bike. |
| `RIDE_LOG_PUBKEY` | `./ride-log-key.public.pem` | Where the sealing key lives. |
| `RIDE_LOG_DIR` | `./ride-logs` | Where sealed `.celog` segments are written. |
| `VCU_PARAM_DIR` | `./vcu-params` | Where service mode leaves parameter snapshots for `/vcu-params` and `/vcu-backup.csv` to serve, and where the write audit journal `service-writes.jsonl` is appended. |
| `SERVICE_MODE_ENABLED` | on | `0` forbids the dashboard from starting a VCU parameter read. That read is the only thing here that puts requests on the bike's bus on purpose; the snapshot is still served and exported either way. The safety gate applies regardless — see [Service mode](vcu-parameters.md#service-mode). |
| `SERVICE_WRITE_ENABLED` | **off** | `1` lets the dashboard **change** things on the bike: any of 269 calibration parameters, the service point, the bike's clock, and the stored trouble codes. ⚠️ One of the two opt-**in** switches here, `FAN_ENABLED` being the other — everything else defaults on and takes a `0` to disable — so a Pi nobody has told about it cannot write to a motorcycle's EEPROM. It is the only one of the two that can reach the bike at all. Separate from `SERVICE_MODE_ENABLED` on purpose. See [Changing something on the bike](vcu-parameters.md#changing-something-on-the-bike). |
