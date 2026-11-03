# Cool Eva

Cool Eva puts an Energica's battery temperature, battery percentage, charging, speed and faults on your phone. A Raspberry Pi reads the bike through a Korlan USB-CAN adapter and serves a live dashboard. You can also save encrypted ride history for later, or add temperature probes and a fan to a custom coolant loop.

It is developed on a **2021 Eva Ribelle**. Other models need checking: some displays assume its 81-cell pack and current limits. An Experia or another motorcycle is an untested adaptation. **A stock Energica needs no watercooling hardware or BMS modification.**

## What to buy

| Item | What you need it for |
| --- | --- |
| Raspberry Pi Zero 2 W | Runs the dashboard; other Pi models need their power and connector requirements checked. |
| microSD card and a card reader | Raspberry Pi OS and the software; leave room for ride history and temporary installation swap. |
| [8devices Korlan USB2CAN](https://www.8devices.com/products/korlan) | Connects the Pi to the bike's CAN network. Choose the OBD2 or DB9 version to match your verified cable. |
| Micro-USB OTG adapter/cable | Connects the Korlan's USB plug to the Pi's **USB** data port. A charge-only cable will not work. |
| A matching motorcycle diagnostic lead, if needed | The connector and wiring must match your bike and Korlan version; check before buying. |
| Pi power supply, wiring and enclosure | A regulated micro-USB supply suitable for the Pi, with protection and mounting suitable for the bike. Start setup with a mains USB supply. |
| A computer and a phone hotspot | The computer flashes the card and installs the software. The phone provides the network for the dashboard. |

**Optional cooling hardware:** MAX31865/PT100 coolant probes and a radiator fan with its motor driver. See [parts, Pi connections and mechanical fittings](docs/cooling-hardware.md). Skip these on a stock bike.

## Connect the hardware

With the motorcycle switched off, connect these two separate paths:

```text
Bike's diagnostic CAN connection → matching lead → Korlan → Pi USB data port
Bike's suitable low-voltage accessory supply → protected regulator → Pi PWR IN
```

The Zero 2 W has separate micro-USB data and power ports. The Korlan gets its power from USB. **Never connect the motorcycle's 12 V supply directly to the Pi, its GPIO pins or a USB port.** Keep this installation away from the traction battery and its high-voltage wiring.

The [hardware guide](docs/hardware.md#connections) gives the verified **Korlan-side** CAN high, CAN low and ground pins. **The bike-side connector pin map, accessory power feed and regulator installation are not yet documented here.** Have those checked for your exact motorcycle before making a lead or tapping power; a matching plug alone does not establish the wiring. The software uses 500 kbit/s CAN and brings the adapter up itself.

Leave SPI disabled on a bike without coolant probes. Cool Eva continues without them. The [cooling hardware guide](docs/cooling-hardware.md) covers the optional GPIO wiring.

<!-- for-now: #317 -->

For now, `COOLANT_ENABLED=0` in `/etc/default/cool-eva` also skips the probe attempts; it is optional on a stock bike with SPI off.

## Setup

These steps use the existing installer. Commands run either **on your computer** or **on the Pi**, as labelled. Choose the username **`pi`** below to use the commands unchanged.

### 1. Prepare the phone and card — on your computer

The Zero 2 W supports **2.4 GHz Wi-Fi only**. On an iPhone, enable **Settings → Personal Hotspot → Maximize Compatibility** if available. When the Pi boots, leave the Personal Hotspot settings page visible for about 20 seconds so it can join.

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to flash **64-bit Raspberry Pi OS**. In its OS customization settings, set:

- Hostname: **`cool-eva`**.
- Username: **`pi`**, with a password or your SSH public key.
- **SSH enabled**; this is how you install and maintain a Pi with no screen.
- Wi-Fi: your phone hotspot's name and password. Do not put these in this repository.

Insert the card, connect the Korlan and power the Pi. Keep the hotspot available while it starts.

### 2. Connect — on your computer

Join your computer to the **same phone hotspot as the Pi**. Open **PowerShell on Windows**, or **Terminal on macOS/Linux**, and run:

```sh
ssh pi@cool-eva.local
```

Accept the host key for your new Pi and enter the password you chose. You are now typing commands on the Pi. If the name does not resolve, find the Pi's IP address in the hotspot/router's connected-device list and use `ssh pi@<pi-ip>` instead. If it never joins, check the hotspot's 2.4 GHz compatibility and discoverability before continuing.

### 3. Install the software — on the Pi

```sh
sudo apt update
sudo apt install -y build-essential python3 git curl avahi-daemon
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

The last command should report **v24.x**. Before the next commands, follow the [Bookworm/Trixie swap instructions](INSTALL.md#25-swap--do-this-before-the-install-not-after-it). Native modules can run out of memory on the Zero 2 W without additional swap. Allow several minutes for installation.

```sh
git clone https://github.com/danieltroger/cool-eva.git /home/pi/cool-eva
cd /home/pi/cool-eva
rm package-lock.json
npm install
git checkout -- package-lock.json
ls node_modules/socketcan/build/Release/can.node
```

Removing the lockfile is for this first Linux installation; [why it is needed](docs/deploy.md#running-it). `git checkout -- package-lock.json` restores the tracked file while leaving the freshly built `node_modules` in place, so Menu → Update can pull later lockfile changes. The final command must find `can.node`. See [build troubleshooting](docs/pi-install-prerequisites.md) if it fails. Do not use `sudo` for the clone or `npm install`.

### 4. Enable saved ride history — on your computer

Keep your Pi session open. Install **Node 24** from [nodejs.org](https://nodejs.org/en/download) on the computer if needed.

On your computer, open the [GitHub repository](https://github.com/danieltroger/cool-eva), choose **Code → Download ZIP**, and extract it (on Windows, use **Extract All**). Find the extracted project folder containing `README.md` and `scripts/`. Open a **second computer terminal** and change to that folder, replacing the example path with its actual location:

```sh
cd "path/to/extracted/cool-eva-main"
```

If Git is already installed, you can instead run `git clone https://github.com/danieltroger/cool-eva.git` followed by `cd cool-eva`. An existing checkout also works. From the project folder, run:

```sh
node --experimental-strip-types scripts/generate-log-key.ts
```

**Back up `ride-log-key.private.pem` in a password manager before continuing.** It is the only way to read your saved rides; losing it makes them permanently unreadable. Keep it off the Pi. Copy only the public half:

```sh
scp ride-log-key.public.pem pi@cool-eva.local:/home/pi/cool-eva/
```

Without that public key, the live dashboard still works but **no ride history is saved**. The [ride-log guide](docs/ride-log.md) explains downloads and encryption's limits.

### 5. Before the first service start

Cool Eva enrolls the Pi with the motorcycle's Bluetooth hub. The hub remembers **one authorized device**, so this can replace the pairing you already use. To pair a previous device again, clear the stored device from the bike's own dashboard first.

<!-- for-now: #317 -->

For now, you can prevent that enrollment by adding `BLE_ENABLED=0` to `/etc/default/cool-eva` **before the next step**; edit the file with `sudo nano /etc/default/cool-eva` in your Pi terminal.

Manual bike changes require deliberate dashboard actions. Automatic DC charge management can act without asking each time; read [what can change the bike](#what-can-change-the-bike) before starting. Stock bikes need no coolant probes, fan or SPI enablement.

### 6. Start and check — on the Pi

Back in your **Pi terminal**:

```sh
cd /home/pi/cool-eva
sudo "$(command -v node)" --experimental-strip-types scripts/setup-service.ts
sudo systemctl status cool-eva
sudo journalctl -u cool-eva -f
```

The installer starts the service and enables it for future boots. Press **q** to leave the status viewer; press **Ctrl+C** to stop following logs. Neither stops the service.

With the **motorcycle awake and parked**, check for a started CAN channel and live readings. For saved history, look for **`ride-log: encrypting to …`**. A **`NO PUBLIC KEY`** message means the key-copy step did not land; fix it and restart with `sudo systemctl restart cool-eva`.

A missing optional `candump`/`can-utils` warning concerns raw developer captures; it does not prevent the phone dashboard or encrypted ride logging. Do not enable SPI unless you have wired the optional probes.

## Open the dashboard

On the phone hosting the hotspot, or another device on the same network, open **[http://cool-eva.local](http://cool-eva.local)**. If the name fails, use `http://<pi-ip>/`, with the address from the earlier SSH step. The dashboard runs on the Pi; internet access is not needed to view it.

- **Ride:** speed, power, battery temperature and charge.
- **Charge:** charging current, voltage, power and battery condition.
- **Faults:** named active and stored trouble codes.
- **Hypermile / All:** battery headroom and a fuller view of the available readings.

Coolant temperatures need the optional probes. Detailed individual cell/module readings need a custom BMS configuration; their absence on a stock bike is normal. Keep your phone interaction for when you are parked.

For later software updates, use **Menu → Update**. [Updating and troubleshooting the installation](docs/deploy.md#running-it) explains dependency changes and manual recovery. Do not routinely run `npm install` on an already working Pi.

## What can change the bike

Reading telemetry includes transmitting diagnostic **read requests**; this is not a completely silent tap. Bluetooth enrollment changes the hub's pairing as explained before first start.

Manual charging and service actions use a two-tap arm and vehicle-state checks. They can change charge limits, stop charging, write calibration parameters, set a service point, sync the bike's clock, clear trouble codes or **Reset the VCU** (restart both processors). Parameter writes also require a matching parameter table. Some actions are irreversible; the gates do not establish that a calibration value is suitable for your motorcycle.

<!-- for-now: #317 -->

For now, state-changing CAN commands also require `SERVICE_WRITE_ENABLED=1`; leave it unset for a first installation.

**Automatic DC charge management starts in automatic mode** and can adjust the requested current without a confirmation for each adjustment. When the dashboard setting **"Allow automatic current reduction"** is available, it defaults **on**. On a stock BMS configuration, it only changes the maximum-current figure the bike's dash shows; it does not control the actual DC charging current. See [Daniel's stock-bike observation](docs/charge-auto.md#stock-bms-configuration) and the [automatic charging details](docs/charge-auto.md).

<!-- for-now: #317 -->

For now, use the DC Charge tab's **"Automatic charge current"** tile (visible when writes are enabled) for session controls, or set `CHARGE_AUTO_ENABLED=0` in `/etc/default/cool-eva` to disable the controller across boots.

The optional fan can start by itself once enabled. Keep hands clear while it has power; see the [cooling hardware guide](docs/cooling-hardware.md).

<!-- for-now: #317 -->

For now, a fitted fan is enabled with `FAN_ENABLED=1`, after the hardware and boot configuration in that guide are complete.

## Get help

If the page will not open, check the hotspot steps first. If it opens without bike readings, check the adapter, wake the parked bike, and look at `sudo journalctl -u cool-eva -n 50`. Missing saved history usually means the public key is absent.

[Open a GitHub issue](https://github.com/danieltroger/cool-eva/issues/new) with the bike's model/year, Pi model, OS version, running version shown in the dashboard, and the relevant error text. Remove personal identifiers before posting: ride logs, diagnostic dumps, network names, keys and GPS traces do not belong in a public issue. Useful references: [CAN adapter startup](docs/can-adapter-probe.md), [Wi-Fi](docs/wifi.md), and [Bluetooth connections](docs/connecting-over-bluetooth.md).

## Going further

| You want to… | Read |
| --- | --- |
| Check wiring or add cooling hardware | [Hardware](docs/hardware.md) · [Probes, fan and fittings](docs/cooling-hardware.md) |
| Change configuration | [Configuration reference](docs/configuration.md) |
| Download and use ride history | [Encrypted ride logs](docs/ride-log.md) · [Grafana and `rides.db`](docs/grafana.md) |
| View rides on a laptop map | [Run the map viewer](map/README.md) · [Map findings](docs/ride-map.md) |
| Save a waypoint or connect by Bluetooth | [Waypoints / Siri](docs/waypoints.md#saving-a-waypoint-from-siri) · [Phone Bluetooth guide](docs/connecting-over-bluetooth.md) |
| Use service mode or add a parameter table | [VCU parameters and writes](docs/vcu-parameters.md) · [Adding your bike's VCU parameter table](docs/vcu-parameters.md#adding-your-bikes-vcu-parameter-table) |
| Understand readings and their limitations | [Signal reference](docs/signals.md) · [CAN findings](docs/can-decode-findings.md) · [Trouble codes and checks](docs/diagnostics-and-checks.md) |
| Develop or replay data without the bike | [Development](docs/development.md) · [Dashboard decisions](docs/dashboard-decisions.md) |

## Licence

AGPL-3.0 — see [`LICENSE`](LICENSE). It reverse-engineers a vehicle you own and talks to safety-relevant hardware; there is no warranty of any kind, and what you plug into your own motorcycle is your responsibility.
