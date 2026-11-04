# Manual installation

<!-- for-now: #324 -->

For now, this is the full manual route behind the [short README setup](../README.md#setup). The planned installer in [#324](https://github.com/danieltroger/cool-eva/issues/324) will handle installation, swap, service startup and checks.

These steps use the existing installer. Commands run either **on your computer** or **on the Pi**, as labelled. Choose the username **`pi`** below to use the commands unchanged.

## 1. Prepare the phone and card — on your computer

The Zero 2 W supports **2.4 GHz Wi-Fi only**. On an iPhone, enable **Settings → Personal Hotspot → Maximize Compatibility** if available. When the Pi boots, leave the Personal Hotspot settings page visible for about 20 seconds so it can join.

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to flash **64-bit Raspberry Pi OS**. In its OS customization settings, set:

- Hostname: **`cool-eva`**.
- Username: **`pi`**, with a password or your SSH public key.
- **SSH enabled**; this is how you install and maintain a Pi with no screen.
- Wi-Fi: your phone hotspot's name and password. Do not put these in this repository.

Insert the card, connect the Korlan and power the Pi. Keep the hotspot available while it starts.

## 2. Connect — on your computer

Join your computer to the **same phone hotspot as the Pi**. Open **PowerShell on Windows**, or **Terminal on macOS/Linux**, and run:

```sh
ssh pi@cool-eva.local
```

Accept the host key for your new Pi and enter the password you chose. You are now typing commands on the Pi. If the name does not resolve, find the Pi's IP address in the hotspot/router's connected-device list and use `ssh pi@<pi-ip>` instead. If it never joins, check the hotspot's 2.4 GHz compatibility and discoverability before continuing.

## 3. Install the software — on the Pi

### Prepare Node and swap

```sh
sudo apt update
sudo apt install -y build-essential python3 git curl avahi-daemon
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

`python3` is required by [node-gyp](https://github.com/nodejs/node-gyp/blob/v13.0.0/README.md#on-unix) to build native Node modules. The last command should report **v24.x**. Before the next commands, follow the [Bookworm/Trixie swap instructions](pi-install-prerequisites.md#manual-swap-setup). Native modules can run out of memory on the Zero 2 W without additional swap. Allow several minutes for installation.

### Install Cool Eva

```sh
git clone https://github.com/danieltroger/cool-eva.git /home/pi/cool-eva
cd /home/pi/cool-eva
rm package-lock.json
npm install
git checkout -- package-lock.json
ls node_modules/socketcan/build/Release/can.node
```

Removing the lockfile is for this first Linux installation; [why it is needed](deploy.md#running-it). `git checkout -- package-lock.json` restores the tracked file while leaving the freshly built `node_modules` in place, so Menu → Update can pull later lockfile changes. The final command must find `can.node`. See [build troubleshooting](pi-install-prerequisites.md) if it fails. Do not use `sudo` for the clone or `npm install`.

## 4. Enable saved ride history — on your computer

For browser generation and the phone-only file handoff, see [recording key setup](hosted-pages.md#make-recording-keys). Until its hosted address is published, use the laptop route below.

Keep your Pi session open. Install **Node 24** from [nodejs.org](https://nodejs.org/en/download) on the computer if needed.

On your computer, open the [GitHub repository](https://github.com/danieltroger/cool-eva), choose **Code → Download ZIP**, and extract it (on Windows, use **Extract All**). Find the extracted project folder containing `README.md` and `scripts/`. Open a **second computer terminal** and change to that folder, replacing the example path with its actual location:

```sh
cd "path/to/extracted/cool-eva-main"
```

If Git is already installed, you can instead run `git clone https://github.com/danieltroger/cool-eva.git` followed by `cd cool-eva`. An existing checkout also works. From the project folder, run:

```sh
node --experimental-strip-types scripts/generate-log-key.ts
```

**Back up `ride-log-key.private.pem` in a password manager before continuing.** It is the only way to read your saved rides; losing it makes them permanently unreadable. Keep it off the Pi. After starting the service below, open Settings → Ride recording on the dashboard and choose the public-key file. Save, explicitly Restart, then verify its active fingerprint and recording state.

Without that public key, the live dashboard still works but **no ride history is saved**. The [ride-log guide](ride-log.md) explains downloads and encryption's limits.

## 5. Before the first service start

Selecting a motorcycle in Settings → Connections and restarting enrolls the Pi with its Bluetooth hub. The hub remembers **one authorized device**, so this can replace the pairing you already use. To pair a previous device again, clear the stored device from the bike's own dashboard first.

<!-- for-now: #317 -->

Fresh settings leave the motorcycle unselected. Open Settings → Connections → Motorcycle connection to select your own bike before enrolment. To disconnect a migrated discover-once install, Forget the saved motorcycle and explicitly restart.

Manual bike changes require deliberate dashboard actions. Automatic DC charge management can act without asking each time; read [what can change the bike](bike-changes.md) before starting. Stock bikes need no coolant probes, fan or SPI enablement.

## 6. Start and check — on the Pi

Back in your **Pi terminal**:

```sh
cd /home/pi/cool-eva
printf '{}\n' | sudo "$(command -v node)" --experimental-strip-types scripts/configure-settings.ts
sudo "$(command -v node)" --experimental-strip-types scripts/setup-service.ts
sudo systemctl status cool-eva
sudo journalctl -u cool-eva -f
```

The installer starts the service and enables it for future boots. Press **q** to leave the status viewer; press **Ctrl+C** to stop following logs. Neither stops the service.

With the **motorcycle awake and parked**, check for a started CAN channel and live readings. For saved history, look for **`ride-log: encrypting to …`**. A **`NO PUBLIC KEY`** message means the key-copy step did not land; fix it and restart with `sudo systemctl restart cool-eva`.

A missing optional `candump`/`can-utils` warning concerns raw developer captures; it does not prevent the phone dashboard or encrypted ride logging. Do not enable SPI unless you have wired the optional probes.
