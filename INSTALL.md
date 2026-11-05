# Cool Eva — Raspberry Pi setup

For a **fresh install** using Windows PowerShell or macOS Terminal, follow the [complete setup guide](docs/manual-install.md) or [short README setup](README.md#setup). The installer handles swap, package setup, the bundled Node/native modules, service installation/start and health checks; no Git/npm/compiler or laptop Node is needed.

## 0. Hardware

Use a Raspberry Pi Zero 2 W, microSD card, stable mains Pi supply for setup, and the [Korlan USB-CAN data connection](docs/hardware.md#connections). Coolant probes and the radiator fan are optional; see [cooling hardware](docs/cooling-hardware.md). A stock motorcycle needs neither.

## 1. Base OS setup

Use Raspberry Pi Imager's current **Lite 64-bit** image for the Zero 2 W. Set username `pi`, hostname `cool-eva`, SSH and an internet-connected 2.4 GHz network. Keep the computer on the same network. Have both home and phone-hotspot credentials ready. [Detailed flashing and connection steps](docs/manual-install.md#1-prepare-the-phone-and-card--on-your-computer).

Optional cooling hardware must be wired before enabling it. Fresh setup asks about wired probes/fan, installs the SPI/PWM boot settings and checks them after reboot. The [checkout guide](docs/checkout-install.md#1-base-os-setup) retains manual kernel commands for developers; ordinary bundle setup does not need them.

## 2. Install and start — on your computer

Generate and back up recording keys at [the key page](https://cool-eva-keys.cool-eva.workers.dev). Only the public PEM is accepted by setup; never paste or copy the private key to the Pi. Read [what can change the motorcycle](README.md#what-can-change-the-bike), then paste:

```sh
ssh -tt pi@cool-eva.local "sudo install -d -m 700 /var/cache/cool-eva-install && sudo curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/danieltroger/cool-eva/releases/latest/download/install.sh -o /var/cache/cool-eva-install/install.sh && sudo sh /var/cache/cool-eva-install/install.sh"
```

Keep mains power connected, type **BENCH**, and answer the prompts. **Do not unplug during OS catch-up. If SSH closes, paste the same line again to resume.** A failed legacy migration asks you to stop and get help; leave its data and migration service intact.

Setup prints the dashboard address, bundle version, service/recording result and CAN status. No key means **NOT SAVING RIDES**, while the dashboard still works. Raw CAN capture stays off for new riders. [Results and help](docs/manual-install.md#5-results-and-help).

## 3. Existing installations and updates

Keep your existing checkout and its Update button until the migration route is announced. [Daniel's first bundle migration](docs/bundle-installation.md#daniels-first-real-migration--go-at-the-bike) requires off-card backups and his GO at the bike. Never re-image to migrate: that erases the card's settings and ride data.

Bundle installs use the dashboard Update button for the same CI-built runtime/dependencies, with atomic selection and automatic rollback. Updates cannot be blocked by a checkout lockfile. OS/kernel/firmware updates are separate and require qualifying charging power; bundle rollback cannot repair the OS or SD card. [Update behavior and limits](docs/bundle-updater.md).

## Developer checkout recipes

The former detailed installation, swap/native build, Git ownership, manual hardware and troubleshooting recipes are preserved in [checkout installation](docs/checkout-install.md). [Development](docs/development.md) covers laptop work. Those commands are not part of the rider bundle path.
