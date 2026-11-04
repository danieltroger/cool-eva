# Cool Eva — Raspberry Pi installation

Telemetry service for a watercooled Energica Eva Ribelle. This installs the `cool-eva` systemd service, which brings up can0, reads the MAX31865 coolant probes over SPI, decodes the bike's CAN/OBD-II telemetry, and serves the live phone dashboard on port 80. See `README.md` for what it does; this file is just how to get it running on the Pi.

Everything below runs **ON THE PI** unless a step says "on the laptop".

For a first installation, follow the [README Setup](README.md#setup), including hotspot compatibility and Bluetooth pairing **before the first service start**. This file keeps the detailed OS/build recipes; [optional cooling hardware](docs/cooling-hardware.md) is not required on a stock bike.

## 0. Hardware

- Raspberry Pi Zero 2 W (or any Pi with SPI + USB).
- (Optional) 2x MAX31865 + PT100 (4-wire) boards on SPI0:
  - `coolant_in` -> `/dev/spidev0.0` (CE0, inlet)
  - `coolant_out` -> `/dev/spidev0.1` (CE1, outlet)
  - Board reference resistor is 430 ohm (Adafruit); PT100 nominal 100 ohm.
- (Optional) Radiator fan: SPAL VA69A-A101-87S on an IBT-2 / BTS7960 half-bridge, driven from hardware PWM0. Off unless enabled in Settings → Bike setup. Pin map, the `config.txt` lines and the udev rule are in §1 below; the wiring reasoning (why VCC is 3.3 V and not 5 V, why idling pulls both enables low) is in `docs/fan-control.md`.
- 8devices Korlan USB2CAN into the bike's OBD port. Uses the in-kernel `usb_8dev` driver — no driver install. 500 kbit, 11-bit. It presents as can0.
  - ⚠️ **`sudo apt install can-utils`** if you want the raw capture (`can-capture.service`, installed by the setup script). It is not a default package; without it the installer refuses to enable the unit and says so. The capture is what every decode finding in `docs/` was derived from — see [`docs/can-capture.md`](docs/can-capture.md).
- (Optional) Energica Connectivity Hub reached over BLE for torque/power, odometer, vehicle state. The Pi's onboard Bluetooth is fine.

## 1. Base OS setup

Flash Raspberry Pi OS (64-bit, Bookworm or newer) and boot it. Skip the SPI commands below unless probes are wired; a stock bike needs no enabled SPI interface. Then:

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

The app itself brings can0 up (down -> set bitrate 500000 + active -> up) at startup, because it runs as root. You do NOT need to configure can0 in `/etc/network` or systemd-networkd. It **skips** that down/up when the interface is already running at 500 kbit with `restart-ms 100` and the mode it wants, because the down kills every other socket on the bus — see [`docs/can-capture.md`](docs/can-capture.md). The startup log line says which path it took and why; ⚠️ that the skip fires on this hardware is unconfirmed until you have read that line once.

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

Build tools for the native modules (`better-sqlite3`, `socketcan`, `spi-device`):

```sh
sudo apt-get install -y build-essential python3 git
```

## 2.5. Swap — do this before the install, not after it

<!-- for-now: #324 -->

For now, follow the [manual swap setup](docs/pi-install-prerequisites.md#manual-swap-setup) before installing dependencies on a Zero 2 W. The planned installer will handle this.

## 3. Get the code

Deploy convention is a git checkout at `/home/pi/cool-eva`, owned by `pi`:

```sh
# Public fork — nothing to configure, the Pi only ever pulls:
git clone https://github.com/<your-fork>/cool-eva.git /home/pi/cool-eva

# Private fork — keep the ssh remote and see the note below:
git clone git@github.com:<your-fork>/cool-eva.git /home/pi/cool-eva

cd /home/pi/cool-eva
```

**⚠️ Never `sudo git pull` in this checkout.** A pull as root leaves root-owned files in `.git`, and the next pull as `pi` then fails — _silently_, so the service restarts on the old commit while the journal looks healthy. If it has already happened: `sudo chown -R pi:pi /home/pi/cool-eva`. The dashboard's Update button pulls as the checkout's owner for exactly this reason, even though the service itself is root.

**Which remote.** Because the pull runs as the owner, `pi`'s own ssh setup is in reach and there is nothing special to configure: a **private** fork keeps its `git@github.com:…` remote and uses `pi`'s deploy key at `/home/pi/.ssh/id_ed25519` the ordinary way. A **public** fork can use the https URL and needs no key at all. What does _not_ work is pulling as root with `HOME` pointed at `/home/pi` — OpenSSH expands `~` from the effective uid, not `$HOME` — which is why the button used to fail with `Host key verification failed.` while a pull as `pi` worked fine. `scripts/setup-service.ts` checks both the ownership and the remote at install time.

[`docs/deploy.md`](docs/deploy.md) has the full reasoning, the 2026-09-08 incident it comes from, and the measurements behind it.

## 4. Install dependencies

```sh
cd /home/pi/cool-eva
rm -f package-lock.json # IMPORTANT — see note below
npm install             # builds better-sqlite3 + socketcan + spi-device (~4 min)
git checkout -- package-lock.json # restore the tracked file; keep the native builds

# Verify the Linux-only native CAN module actually built:
ls node_modules/socketcan/build/Release/can.node
```

**Nothing extra is needed to let those compiles run.** npm has an allowlist for install-time lifecycle scripts, and on this project those scripts _are_ the native builds: **npm 12 and newer refuse to run them** unless they are allowlisted, leaving a tree with no `.node` files and a service that dies on `require`. The repo therefore **ships an `.npmrc`** with the four names. ⚠️ Its one cost: on npm older than 11.16.0 the key does not exist yet, so every npm command in this directory prints a cosmetic `npm warn Unknown project config "allow-scripts"`. Harmless — that band runs the scripts regardless.

⚠️ **You already have an `.npmrc` here?** `git pull` refuses to overwrite an untracked file, **even one whose contents are identical** — so the dashboard's Update button will abort with "would be overwritten by merge" until you `rm .npmrc` (or merge your own lines into the committed one and commit them).

⚠️ **Did the modules build?** npm warns either way and the difference is the phrase, not the tense: "install scripts **not yet covered** by allowScripts" — they **ran**, nothing is wrong. "install scripts **blocked** because they are not covered" — they did **not**.

**If the modules did not build** — an install from a checkout predating the `.npmrc` — one command fixes it. A second `npm install` would say `up to date` and run nothing; `npm rebuild` is what runs the skipped builds:

```sh
npm rebuild
```

Only if you cannot get the `.npmrc` in place, fall back to the command from #136 and then rebuild:

```sh
npm approve-scripts better-sqlite3 socketcan spi-device usocket
npm rebuild
```

⚠️ Second choice for a reason: `approve-scripts` writes a **version-pinned** `allowScripts` into `package.json`, which is tracked. That makes the Update button (`git pull --ff-only`) refuse on any commit changing a dependency range, and `package.json#allowScripts` then **silently supersedes** the repo's `.npmrc` for good — pinning that Pi to the versions it had that day. The version boundaries and the measurements are in [`docs/pi-install-prerequisites.md`](docs/pi-install-prerequisites.md) §1.

**WHY rm the lockfile:** `package-lock.json` is committed but generated on macOS, where socketcan (a Linux-only optionalDependency) is skipped. Installing on the Pi against that lockfile prunes the real native build and the service then dies on boot with `ERR_MODULE_NOT_FOUND: socketcan`. `npm install socketcan --force` will not fix it — it insists it's already up to date. The reliable fix is `rm package-lock.json && npm install` on the Pi.

After the build, `git checkout -- package-lock.json` restores the repository's lockfile without changing `node_modules`. Leaving a regenerated lockfile modified can make Menu → Update refuse when an upstream commit changes that file; see [deploying updates](docs/deploy.md#running-it).

Only re-run `npm install` on the Pi when a dependency actually changed; a plain `git pull` never touches `node_modules` and is always safe.

## 5. Encrypted ride log key (do this on the laptop)

You can generate the same PEM pair at [the recording key page](https://cool-eva-keys.cool-eva.workers.dev). See [recording key setup](docs/hosted-pages.md#make-recording-keys) for backup and the phone-only handoff; phone acceptance remains outstanding. The manual laptop route below remains available.

The Pi is given a PUBLIC key only, so a stolen SD card yields ciphertext. On the laptop:

```sh
node --experimental-strip-types scripts/generate-log-key.ts # writes both keys

# BACK UP the PRIVATE key (password manager). It is the ONLY thing that can
# ever decrypt the logs. Lose it and every logged ride is gone forever.

scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

Upload the public half in Settings → Ride recording. The legacy filename is imported once on an existing installation. Without it, the live dashboard works but **nothing is persisted**. See the [ride-log guide](docs/ride-log.md#encrypted-ride-log).

## 6. Settings

Use the [dashboard settings reference](docs/configuration.md). On a fresh Pi, initialise fresh settings with JSON on stdin before installing the unit:

```sh
printf '{}\n' | sudo "$(command -v node)" --experimental-strip-types scripts/configure-settings.ts
```

On an existing installation, leave its unit, environment file and drop-ins intact until the migration-capable service has captured their effective values. The setup script waits for that migration before replacing the unit. A settings fault must be repaired before release cleanup.

## 7. Install and start the service

```sh
cd /home/pi/cool-eva
sudo "$(command -v node)" --experimental-strip-types scripts/setup-service.ts
```

This writes `/etc/systemd/system/cool-eva.service` (running as root, so it can bring up can0), then enables it at boot and starts it. Upgrading a Pi from before the 2026-08 rename needs nothing by hand — the script stops, disables and deletes the old `thermometer` unit itself. Useful commands it prints:

```sh
sudo systemctl status cool-eva     # check status
sudo journalctl -u cool-eva -f     # follow logs
sudo systemctl stop cool-eva       # stop
sudo systemctl disable cool-eva    # remove from boot
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

**Adding a second network (home Wi-Fi, an Airbnb) while sshed in over the first.** Don't use `nmcli device wifi connect` for this: it activates what it creates, which drops the session you are typing into. `nmcli connection add` only creates:

```sh
sudo nmcli connection add type wifi ifname wlan0 con-name "<ssid>" ssid "<ssid>" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "<pw>" connection.autoconnect no
sudo nmcli connection modify "<ssid>" connection.autoconnect yes   # once you're off this link
```

⚠️ The password is on the command line, so it lands in your shell history and is briefly visible in `ps`. Prefix the command with a space if your shell is set to skip those, or clear it from the history afterwards.

`wpa-psk` is WPA2; a WPA3-only network wants `sae`. See [`docs/pi-install-prerequisites.md`](docs/pi-install-prerequisites.md) §3.

Endpoints: `/dl` (sealed ride-log download), `/waypoint` (Siri shortcut), `/status`, `/vcu-params` + `/params.html` (last VCU-param snapshot, never touches bus), `/fan` (cooling-fan duty and mode — only with an installed fan enabled in Settings, otherwise a 404; a POST needs `X-Cool-Eva: fan`).

## 9. Deploying updates later

The dashboard menu's **Update** button does this for you: it runs `git pull --ff-only` in `/home/pi/cool-eva` **as the checkout's owner, not as root** (see §3), shows git's output, then restarts the service so the new code takes effect. The WebSocket drops on restart and the dashboard reconnects on its own. It does **not** run `npm install`, so use it only for code changes.

By hand (or when a dependency changed):

```sh
cd /home/pi/cool-eva
git pull
sudo systemctl restart cool-eva

# ONLY if a dependency changed:
rm package-lock.json && npm install
git checkout -- package-lock.json
# then re-verify node_modules/socketcan/build/Release/can.node exists
```

Notes:

- Restarting the service leaves a correctly configured CAN link alone. When it needs to reconfigure the link, other raw-CAN sockets lose it; see [CAN bring-up and capture](docs/can-capture.md#what-is-skipped-now).
- The Connectivity Hub accepts one BLE connection at a time and the service holds it. Stop the service before running a scratch BLE probe.
- There's no reception in the garage; the Pi is only reachable when parked in wifi range.

## 10. Changing settings later

Open Menu → Settings. Pi choices apply after an explicit confirmed restart; Screen and Units are immediate on this phone. Do not edit the generated unit. Existing environment sources are imported once, then ignored; keep them for rollback. See [configuration](docs/configuration.md) and [recovery](docs/settings.md).

## 11. Quick tips on bringing CAN back online

If you are troubleshooting and rebooted the Pi but the can0 interface looks down, you need to bring it back up manually or reboot the bike:

```sh
ip -details link show can0
ip link set can0 type can bitrate 500000
ip link set can0 up
ip -details link show can0
```

## 12. Optional: Grafana on the laptop (post-ride analysis)

Grafana runs on the laptop, not the Pi. Follow [Grafana and the ride-log import](docs/grafana.md#grafana) to build `rides.db`, recover waypoints and materialise its route track before starting Grafana. The [encrypted ride-log guide](docs/ride-log.md#encrypted-ride-log) covers the key and download; the datasource is configured for `rides.db`.

## Safety

Diagnostic reads transmit requests. Manual charging and service actions can change the motorcycle, and automatic DC current management can act without a per-adjustment prompt. Read [what can change the bike](README.md#what-can-change-the-bike) before starting the service. Only touch hardware you own and are authorized to modify.

Once enabled, the optional fan starts **on its own** whenever the pack is warm, and the dashboard can start it from a phone with one drag — there is no two-tap arm on it (`docs/fan-control.md` §4 "The slider"), only the `X-Cool-Eva: fan` header a POST needs. Keep fingers out of the duct while the Pi is powered: a `SIGKILL` leaves the bridge driving until the service restarts itself, which `Restart=on-failure` / `RestartSec=5` makes about **five seconds** later — long enough to matter with a hand in the duct, and only that long because the unit restarts (`docs/fan-control.md` §8).
