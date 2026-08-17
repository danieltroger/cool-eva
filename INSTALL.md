================================================================================
 Cool Eva — Raspberry Pi installation
================================================================================

Telemetry service for a watercooled Energica Eva Ribelle. This installs the
"thermometer" systemd service, which brings up can0, reads the MAX31865 coolant
probes over SPI, decodes the bike's CAN/OBD-II telemetry, and serves the live
phone dashboard on port 80. See README.md for what it does; this file is just
how to get it running on the Pi.

Everything below runs ON THE PI unless a step says "on the laptop".


--------------------------------------------------------------------------------
 0. Hardware
--------------------------------------------------------------------------------

  - Raspberry Pi Zero 2 W (or any Pi with SPI + USB).
  - 2x MAX31865 + PT100 (4-wire) boards on SPI0:
        coolant_in  -> /dev/spidev0.0  (CE0, inlet)
        coolant_out -> /dev/spidev0.1  (CE1, outlet)
    Board reference resistor is 430 ohm (Adafruit); PT100 nominal 100 ohm.
  - 8devices Korlan USB2CAN into the bike's OBD port. Uses the in-kernel
    usb_8dev driver — no driver install. 500 kbit, 11-bit. It presents as can0.
  - (Optional) Energica Connectivity Hub reached over BLE for torque/power,
    odometer, vehicle state. The Pi's onboard Bluetooth is fine.


--------------------------------------------------------------------------------
 1. Base OS setup
--------------------------------------------------------------------------------

Flash Raspberry Pi OS (64-bit, Bookworm or newer) and boot it. Then:

  # Enable SPI for the MAX31865 probes
  sudo raspi-config nonint do_spi 0
  # (or: raspi-config -> Interface Options -> SPI -> Enable, then reboot)

  # Confirm SPI came up after reboot — you want spidev0.0 and spidev0.1
  ls -l /dev/spidev0.*

  # Confirm the Korlan shows up as a CAN interface once plugged in
  ip -details link show can0
  # If it's missing, check: dmesg | grep -i usb_8dev

The app itself brings can0 up (down -> set bitrate 500000 + active -> up) at
startup, because it runs as root. You do NOT need to configure can0 in
/etc/network or systemd-networkd.


--------------------------------------------------------------------------------
 2. Node.js 24
--------------------------------------------------------------------------------

The service runs TypeScript directly via Node's --experimental-strip-types, so
you need Node 24.x. If it's not already installed:

  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node --version        # expect v24.x

Build tools for the native modules (better-sqlite3, socketcan):

  sudo apt-get install -y build-essential python3 git


--------------------------------------------------------------------------------
 3. Get the code
--------------------------------------------------------------------------------

Deploy convention is a git checkout at /home/pi/thermometer:

  git clone <this-repo-url> /home/pi/thermometer
  cd /home/pi/thermometer


--------------------------------------------------------------------------------
 4. Install dependencies
--------------------------------------------------------------------------------

  cd /home/pi/thermometer
  rm -f package-lock.json        # IMPORTANT — see note below
  npm install                    # builds better-sqlite3 + socketcan (~4 min)

  # Verify the Linux-only native CAN module actually built:
  ls node_modules/socketcan/build/Release/can.node

WHY rm the lockfile: package-lock.json is committed but generated on macOS,
where socketcan (a Linux-only optionalDependency) is skipped. Installing on the
Pi against that lockfile prunes the real native build and the service then dies
on boot with "ERR_MODULE_NOT_FOUND: socketcan". `npm install socketcan --force`
will not fix it — it insists it's already up to date. The reliable fix is
`rm package-lock.json && npm install` on the Pi.

Only re-run npm install on the Pi when a dependency actually changed; a plain
`git pull` never touches node_modules and is always safe.


--------------------------------------------------------------------------------
 5. Encrypted ride log key (do this on the laptop)
--------------------------------------------------------------------------------

The Pi is given a PUBLIC key only, so a stolen SD card yields ciphertext. On the
laptop:

  node --experimental-strip-types scripts/generate-log-key.ts   # writes both keys

  # BACK UP the PRIVATE key (password manager). It is the ONLY thing that can
  # ever decrypt the logs. Lose it and every logged ride is gone forever.

  scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/thermometer/

The service looks for ride-log-key.public.pem in the project dir by default (or
set RIDE_LOG_PUBKEY). Without it, logging still runs but is not encrypted.


--------------------------------------------------------------------------------
 6. Configuration (environment variables — optional)
--------------------------------------------------------------------------------

Defaults are correct for a stock bike; skip this section unless you need one.
All are read by src/index.ts:

  CAN_ENABLED=0        skip CAN entirely (coolant only)
  OBD_ENABLED=0        passive/listen-only: decode broadcasts, don't TX OBD polls
  ELOCK_ENABLED=0      skip the one-shot keys-paired read from the E-LOCK ECU
  BLE_ENABLED=0        skip the Bluetooth link to the Connectivity Hub
  BLE_MAC=<addr>       pin the hub's BLE address (default: discover by name)
  GPS_TIME_SYNC=0      never step the system clock from satellite time
  CUSTOM_BMS_CONFIG=1  ONLY if the pack's LiBAL BMS is flashed with the custom
                       config. Leave UNSET on a stock Energica. See README.
  RIDE_LOG_PUBKEY=…    path to the X25519 public key (default: ./ride-log-key.public.pem)
  RIDE_LOG_DIR=…       where sealed .celog segments go (default: ./ride-logs)
  VCU_PARAM_DIR=…      where read-vcu-params.ts snapshots live (default: ./vcu-params)

The install script (next step) does NOT bake env vars into the unit. To set any,
add a systemd drop-in AFTER installing the service:

  sudo systemctl edit thermometer
  # then add, e.g.:
  #   [Service]
  #   Environment=CUSTOM_BMS_CONFIG=1
  sudo systemctl restart thermometer


--------------------------------------------------------------------------------
 7. Install and start the service
--------------------------------------------------------------------------------

  cd /home/pi/thermometer
  sudo node scripts/setup-service.ts

This writes /etc/systemd/system/thermometer.service (running as root, so it can
bring up can0), then enables it at boot and starts it. Useful commands it prints:

  sudo systemctl status thermometer    # check status
  sudo journalctl -u thermometer -f    # follow logs
  sudo systemctl stop thermometer      # stop
  sudo systemctl disable thermometer   # remove from boot

On a healthy start the logs show, roughly:
  can: can0 up @500k — ACTIVE (TX enabled)
  coolant: 2 MAX31865 probe(s) started (sensor-rate polling)
  ride-log: encrypting to …          (only if the public key is present)


--------------------------------------------------------------------------------
 8. Reach the dashboard
--------------------------------------------------------------------------------

The service serves the live dashboard on port 80. From a browser on the same
network:

  http://<pi-ip>/            or, with mDNS:   http://cool-eva.local/

For the cool-eva.local name you need the hostname set and Avahi running:

  sudo hostnamectl set-hostname cool-eva
  sudo apt-get install -y avahi-daemon

Networking note (from README): the intended setup is the Pi joining a phone's
hotspot so it's reachable at http://cool-eva.local while riding/charging.

Endpoints: /dl (sealed ride-log download), /waypoint (Siri shortcut),
/status, /vcu-params + /params.html (last VCU-param snapshot, never touches bus).


--------------------------------------------------------------------------------
 9. Deploying updates later
--------------------------------------------------------------------------------

  cd /home/pi/thermometer
  git pull
  sudo systemctl restart thermometer
  # ONLY if a dependency changed: rm package-lock.json && npm install
  #   then re-verify node_modules/socketcan/build/Release/can.node exists

Notes:
  - Restarting the service re-initialises can0, which kills any other raw-CAN
    socket (scratch scripts) with "OSError 100 Network is down". Expected.
  - The Connectivity Hub accepts one BLE connection at a time and the service
    holds it. Stop the service before running a scratch BLE probe.
  - There's no reception in the garage; the Pi is only reachable when parked in
    wifi range.


--------------------------------------------------------------------------------
 10. Optional: Grafana on the laptop (post-ride analysis)
--------------------------------------------------------------------------------

Grafana runs on the LAPTOP, not the Pi. Download a sealed log from the Pi, then:

  node --experimental-strip-types scripts/decrypt-log.ts <file>.celog --out temperatures.db
  docker compose up -d          # Grafana at http://localhost:3000

See README.md "Encrypted ride log" and "Grafana" for the datasource caveat
(temperatures.db vs rides.db) and dashboard details.


================================================================================
 Safety
================================================================================
The CAN bus is read-only here: passive broadcast decode, standard OBD-II READ
requests, and KWP 0x22 parameter reads. No writes of any kind. Only touch
hardware you own and are authorized to modify.
