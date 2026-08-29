# Cool Eva — Raspberry Pi installation

Telemetry service for a watercooled Energica Eva Ribelle. This installs the `cool-eva` systemd service, which brings up can0, reads the MAX31865 coolant probes over SPI, decodes the bike's CAN/OBD-II telemetry, and serves the live phone dashboard on port 80. See `README.md` for what it does; this file is just how to get it running on the Pi.

Everything below runs **ON THE PI** unless a step says "on the laptop".

## 0. Hardware

- Raspberry Pi Zero 2 W (or any Pi with SPI + USB).
- 2x MAX31865 + PT100 (4-wire) boards on SPI0:
  - `coolant_in` -> `/dev/spidev0.0` (CE0, inlet)
  - `coolant_out` -> `/dev/spidev0.1` (CE1, outlet)
  - Board reference resistor is 430 ohm (Adafruit); PT100 nominal 100 ohm.
- (Optional) Radiator fan: SPAL VA69A-A101-87S on an IBT-2 / BTS7960 half-bridge, driven from hardware PWM0. Off unless `FAN_ENABLED=1`. Pin map, the `config.txt` lines and the udev rule are in §1 below; the wiring reasoning (why VCC is 3.3 V and not 5 V, why idling pulls both enables low) is in `docs/fan-control.md`.
- 8devices Korlan USB2CAN into the bike's OBD port. Uses the in-kernel `usb_8dev` driver — no driver install. 500 kbit, 11-bit. It presents as can0.
- (Optional) Energica Connectivity Hub reached over BLE for torque/power, odometer, vehicle state. The Pi's onboard Bluetooth is fine.

## 1. Base OS setup

Flash Raspberry Pi OS (64-bit, Bookworm or newer) and boot it. Then:

```sh
# Enable SPI for the MAX31865 probes
sudo raspi-config nonint do_spi 0
# (or: raspi-config -> Interface Options -> SPI -> Enable, then reboot)

# Confirm SPI came up after reboot — you want spidev0.0 and spidev0.1
ls -l /dev/spidev0.*

# Confirm the Korlan shows up as a CAN interface once plugged in
ip -details link show can0
# If it's missing, check:
dmesg | grep -i usb_8dev
```

The app itself brings can0 up (down -> set bitrate 500000 + active -> up) at startup, because it runs as root. You do NOT need to configure can0 in `/etc/network` or systemd-networkd.

**Cooling fan (skip unless you wired the IBT-2 — §0).** Unlike SPI, this needs `/boot/firmware/config.txt` edited by hand:

```sh
sudo tee -a /boot/firmware/config.txt <<'EOF'
dtoverlay=pwm,pin=18,func=2
gpio=17,op,dl
gpio=27,op,dl
EOF
sudo apt-get install -y raspi-utils   # provides `pinctrl`, which drives the two enables
sudo reboot                           # an overlay is not applied at runtime

# After the reboot — a PWM chip should exist. The NUMBER varies by kernel; the app
# discovers it and logs which it picked, so do not hardcode 0 anywhere.
ls /sys/class/pwm
```

The two `gpio=` lines pull the IBT-2's enables low at boot, so a Pi that is booting or has crashed leaves the bridge in standby rather than driving the fan. They are not optional.

**No `dtparam=audio=off` is needed on a Zero 2 W**, whose device tree declares `audio_pins` empty — `dtparam=audio` there toggles HDMI audio only. §0 invites any Pi with SPI and USB, though, and on a Pi with an analogue audio jack (3, 4) `audio_pins` is `<40 41>` at Alt0, which _is_ PWM0/PWM1: on those, add `dtparam=audio=off` to the block above. `docs/fan-control.md` §5.

`/sys/class/pwm` is root-only and the service runs as root, so nothing more is needed for it. To drive the fan as `pi` (or if you ever run the service unprivileged) add the udev rule in `docs/fan-control.md` §5 — including its second stanza, without which the exported channel's own files stay owned by root.

## 2. Node.js 24

The service runs TypeScript directly via Node's `--experimental-strip-types`, so you need Node 24.x. If it's not already installed:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version # expect v24.x
```

Build tools for the native modules (better-sqlite3, socketcan):

```sh
sudo apt-get install -y build-essential python3 git
```

## 3. Get the code

Deploy convention is a git checkout at `/home/pi/cool-eva`, owned by `pi`:

```sh
git clone <this-repo-url> /home/pi/cool-eva
cd /home/pi/cool-eva
```

**SSH deploy key (needed for the dashboard's Update button).** With an SSH remote (`git@github.com:…`), a `git pull` needs a key GitHub accepts. The service runs as **root**, but the Update button pulls with `HOME=/home/pi` so it uses `pi`'s key, config and `known_hosts` — so put the deploy key in `pi`'s `~/.ssh` and confirm it works as `pi`:

```sh
# generate a key if there isn't one, add the .pub as a deploy key on GitHub, then:
sudo -u pi git -C /home/pi/cool-eva ls-remote origin   # must succeed, not "Permission denied (publickey)"
```

(If you'd rather not use SSH, point `origin` at the HTTPS URL — only anonymous-friendly for a public repo.)

## 4. Install dependencies

```sh
cd /home/pi/cool-eva
rm -f package-lock.json # IMPORTANT — see note below
npm install             # builds better-sqlite3 + socketcan (~4 min)

# Verify the Linux-only native CAN module actually built:
ls node_modules/socketcan/build/Release/can.node
```

**WHY rm the lockfile:** `package-lock.json` is committed but generated on macOS, where socketcan (a Linux-only optionalDependency) is skipped. Installing on the Pi against that lockfile prunes the real native build and the service then dies on boot with `ERR_MODULE_NOT_FOUND: socketcan`. `npm install socketcan --force` will not fix it — it insists it's already up to date. The reliable fix is `rm package-lock.json && npm install` on the Pi.

Only re-run `npm install` on the Pi when a dependency actually changed; a plain `git pull` never touches `node_modules` and is always safe.

## 5. Encrypted ride log key (do this on the laptop)

The Pi is given a PUBLIC key only, so a stolen SD card yields ciphertext. On the laptop:

```sh
node --experimental-strip-types scripts/generate-log-key.ts # writes both keys

# BACK UP the PRIVATE key (password manager). It is the ONLY thing that can
# ever decrypt the logs. Lose it and every logged ride is gone forever.

scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

The service looks for `ride-log-key.public.pem` in the project dir by default (or set `RIDE_LOG_PUBKEY`). Without it, logging still runs but is not encrypted.

## 6. Configuration (environment variables — optional)

Defaults are correct for a stock bike; skip this section unless you need one. All are read by `src/index.ts`:

- `FAN_ENABLED=1` — drive the IBT-2 cooling fan and serve `/fan`. **Opt IN**, unlike every other flag here: unset means no `/sys/class/pwm`, no `pinctrl`, no endpoint. With it set the fan follows the pack temperature automatically from boot. Needs the §1 `config.txt` lines first. See `docs/fan-control.md`
- `CAN_ENABLED=0` — skip CAN entirely (coolant only)
- `OBD_ENABLED=0` — passive/listen-only: decode broadcasts, don't TX OBD polls
- `ELOCK_ENABLED=0` — skip the one-shot keys-paired read from the E-LOCK ECU
- `BLE_ENABLED=0` — skip the Bluetooth link to the Connectivity Hub
- `BLE_MAC=<addr>` — pin the hub's BLE address (default: discover by name)
- `GPS_TIME_SYNC=0` — never step the system clock from satellite time
- `CUSTOM_BMS_CONFIG=1` — ONLY if the pack's LiBAL BMS is flashed with the custom config. Leave UNSET on a stock Energica. See README.
- `RIDE_LOG_PUBKEY=…` — path to the X25519 public key (default: `./ride-log-key.public.pem`)
- `RIDE_LOG_DIR=…` — where sealed `.celog` segments go (default: `./ride-logs`)
- `VCU_PARAM_DIR=…` — where read-vcu-params.ts snapshots live (default: `./vcu-params`)

The install script (next step) does NOT bake env vars into the unit. To set any, add a systemd drop-in AFTER installing the service:

```sh
sudo systemctl edit cool-eva
# then add, e.g.:
# [Service]
# Environment=CUSTOM_BMS_CONFIG=1
sudo systemctl restart cool-eva
```

## 7. Install and start the service

```sh
cd /home/pi/cool-eva
sudo node scripts/setup-service.ts
```

This writes `/etc/systemd/system/cool-eva.service` (running as root, so it can bring up can0), then enables it at boot and starts it. Useful commands it prints (if you see `thermometer.service`, rename it to `cool-eva.service`):

```sh
sudo systemctl status cool-eva     # check status
sudo journalctl -u cool-eva -f     # follow logs
sudo systemctl stop thermometer    # stop
sudo systemctl disable thermometer # remove from boot
```

On a healthy start the logs show, roughly:

```
can: can0 up @500k — ACTIVE (TX enabled)
coolant: 2 MAX31865 probe(s) started (sensor-rate polling)
ride-log: encrypting to … (only if the public key is present)
```

## 8. Reach the dashboard

The service serves the live dashboard on port 80. From a browser on the same network:

```
http://<pi-ip>/
# or, with mDNS:
http://cool-eva.local/
```

For the `cool-eva.local` name you need the hostname set and Avahi running:

```sh
sudo hostnamectl set-hostname cool-eva
sudo apt-get install -y avahi-daemon
```

Networking note (from README): the intended setup is the Pi joining a phone's hotspot so it's reachable at http://cool-eva.local while riding/charging.

Endpoints: `/dl` (sealed ride-log download), `/waypoint` (Siri shortcut), `/status`, `/vcu-params` + `/params.html` (last VCU-param snapshot, never touches bus), `/fan` (cooling-fan duty and mode — only with `FAN_ENABLED=1`, otherwise a 404; a POST needs `X-Cool-Eva: fan`).

## 9. Deploying updates later

The dashboard menu's **Update** button does this for you: it runs `git pull` in `/home/pi/cool-eva` (as root, using `pi`'s SSH key — see §3), shows git's output, then restarts the service so the new code takes effect. The WebSocket drops on restart and the dashboard reconnects on its own. It does **not** run `npm install`, so use it only for code changes.

By hand (or when a dependency changed):

```sh
cd /home/pi/cool-eva
git pull
sudo systemctl restart cool-eva

# ONLY if a dependency changed:
rm package-lock.json && npm install
# then re-verify node_modules/socketcan/build/Release/can.node exists
```

Notes:

- Restarting the service re-initialises can0, which kills any other raw-CAN socket (scratch scripts) with `OSError 100 Network is down`. Expected.
- The Connectivity Hub accepts one BLE connection at a time and the service holds it. Stop the service before running a scratch BLE probe.
- There's no reception in the garage; the Pi is only reachable when parked in wifi range.

## 10. Setting up config file for cool-eva

On my Raspberry Pi, ensure `EnvironmentFile` is set up in the service unit:

```ini
[Service]
Type=simple
WorkingDirectory=/home/pi/cool-eva
EnvironmentFile=/etc/default/cool-eva
ExecStart=/usr/bin/node --experimental-strip-types /home/pi/cool-eva/src/index.ts
Restart=on-failure
RestartSec=5
User=root
```

Then create `/etc/default/cool-eva`:

```sh
COOLANT_ENABLED=0
BLE_MAC=<mac address>
SERVICE_WRITE_ENABLED=1
CUSTOM_BMS_CONFIG=0
```

## 11. Quick tips on bringing CAN back online

If you are troubleshooting and rebooted the Pi but the can0 interface looks down, you need to bring it back up manually or reboot the bike:

```sh
ip -details link show can0
ip link set can0 type can bitrate 500000
ip link set can0 up
ip -details link show can0
```

## 12. Optional: Grafana on the laptop (post-ride analysis)

Grafana runs on the LAPTOP, not the Pi. Download a sealed log from the Pi, then:

```sh
node --experimental-strip-types scripts/decrypt-log.ts <file>.celog --out temperatures.db
docker compose up -d # Grafana at http://localhost:3000
```

See `README.md` "Encrypted ride log" and "Grafana" for the datasource caveat (temperatures.db vs rides.db) and dashboard details.

## Safety

The CAN bus is read-only here: passive broadcast decode, standard OBD-II READ requests, and KWP 0x22 parameter reads. No writes of any kind. Only touch hardware you own and are authorized to modify.

With `FAN_ENABLED=1` the fan starts **on its own** whenever the pack is warm, and the dashboard can start it from a phone with one drag — there is no two-tap arm on it (`docs/fan-control.md` §4 "The slider"), only the `X-Cool-Eva: fan` header a POST needs. Keep fingers out of the duct while the Pi is powered: a `SIGKILL` leaves the bridge driving until the service restarts itself, which `Restart=on-failure` / `RestartSec=5` makes about **five seconds** later — long enough to matter with a hand in the duct, and only that long because the unit restarts (`docs/fan-control.md` §8).
