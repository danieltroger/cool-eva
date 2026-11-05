# Set up the Pi from Windows or macOS

Source-tree `install.sh` is a release template; use the pasted line below for a fresh card.

## Before installing

Read [what can change the bike](../README.md#what-can-change-the-bike). Setup starts telemetry; diagnostic reads transmit requests, and automatic DC charge management can act without a per-adjustment prompt. Fresh settings leave the motorcycle's Bluetooth hub unselected and optional cooling hardware off. Selecting a hub later can replace its remembered pairing. Install and use controls with the motorcycle parked.

Keep the Pi on a stable **mains USB supply throughout setup**. Have a microSD/card reader, internet-connected 2.4 GHz Wi-Fi, your computer, both home/hotspot credentials, and an optional recording public key ready. Stock bikes need no probes, fan, SPI enablement or BMS modification.

## 1. Prepare the phone and card — on your computer

The Zero 2 W uses **2.4 GHz Wi-Fi**. On iPhone, enable **Personal Hotspot → Maximize Compatibility** if available; leave the hotspot settings page visible for about 20 seconds when the Pi boots.

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) with the **Zero 2 W** selected and its current **Raspberry Pi OS Lite (64-bit)** image. Set:

- Hostname **`cool-eva`**, username **`pi`**, and a password (or your SSH public key).
- **SSH enabled**.
- An internet-connected Wi-Fi network and its country setting. Home Wi-Fi is convenient; a compatible phone hotspot also works.

Insert the card, connect the [Korlan to the USB data port](hardware.md#connections), and power the Pi from mains. Keep that network available while it boots. Each software release records the image/package versions it was tested on; setup catches up OS packages on bench power. A different OS version warns and proceeds through native/service checks.

## 2. Connect — on your computer

Join the computer to the same network as the Pi. Use **Windows PowerShell** or **macOS Terminal**. The line in step 4 makes the SSH connection and runs setup; there is no separate Pi terminal or laptop package installation.

On Windows, **"ssh is not recognized"** means you need to add **OpenSSH Client** under **Settings → Optional features**.

After re-imaging this card, run `ssh-keygen -R cool-eva.local` on your computer before reconnecting; use the IP instead if that is how you connect. This removes the old card's saved host key.

If `cool-eva.local` does not resolve, find the Pi's address in the router/hotspot's connected-device list and replace `pi@cool-eva.local` with `pi@<pi-ip>` in the line. Replace `pi` too if Imager used another username. Accept the host key for this new Pi and enter the Imager password when prompted. If the Pi never joins, check the 2.4 GHz network, credentials and hotspot discoverability before continuing.

## 3. Recording key — on your computer

Open [the recording key page](https://cool-eva-keys.cool-eva.workers.dev). Generate keys, download `ride-log-key.private.pem`, make a recoverable backup away from the Pi, acknowledge that backup and download `ride-log-key.public.pem`. Existing owners can keep their current pair.

Open the **public** file in a text editor and copy the complete `BEGIN PUBLIC KEY` through `END PUBLIC KEY` block for setup. Never paste the private file. No Node installation, project ZIP or key-generation command is needed on the computer. [Key-page details and phone-only handoff](hosted-pages.md#make-recording-keys).

You may leave the public-key prompt blank and configure it later in Settings → Ride recording. The live dashboard works without it, but **no rides are saved**. Losing the private key makes old recordings unreadable; making another pair does not recover them.

## 4. Install and start — on your computer

Paste the same single line into PowerShell or Terminal:

```sh
ssh -tt pi@cool-eva.local "sudo install -d -m 700 /var/cache/cool-eva-install && sudo curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/danieltroger/cool-eva/releases/latest/download/install.sh -o /var/cache/cool-eva-install/install.sh && sudo sh /var/cache/cool-eva-install/install.sh"
```

Only type **BENCH** with stable mains power and the bike parked. Enter both network names/passwords. Passwords and the public-key paste are not shown on screen: type or paste once and press Enter. Paste only the public key and confirm its backup. Enable optional probes/fan only when already wired. Otherwise press Enter for off.

Setup repairs/catches up OS packages, checks swap, downloads and verifies its prebuilt bundle, installs/starts/enables the service, and checks it for a continuous healthy minute. It saves both networks and the hotspot name without disconnecting the current setup link. It does not clone Git, rebuild native modules or ask you to edit a unit, set up swap, or run a separate start/check command. [Every absorbed manual step](bundle-installation.md#what-the-installer-absorbs).

On a bundle install, to change saved network credentials, rerun the line and enter the new network name and password, or press Enter at a network-name prompt to keep its saved profile.

**Do not unplug during OS catch-up.** That job keeps running if SSH closes; keep power on and paste the same line again to resume. After an ordinary download/package error, fix the network/power problem and rerun the line. If migration says **stop and ask for help**, do that instead; do not repeatedly retry, start an old writer or erase the card.

## 5. Results and help

A successful run prints **Dashboard ready** with the hostname/IP, the bundle version, service result, and either an encrypted-recording fingerprint or **NOT SAVING RIDES**. No CAN adapter is a concrete USB/data-cable check; a connected but sleeping motorcycle may show waiting/missing readings. Optional coolant/cell data can be absent on a stock bike. Setup can finish without a motorcycle attached; actual CAN, BLE and optional hardware still need checking while parked.

Open `http://cool-eva.local` or the printed IP on the same network. With the bike awake and parked, check live readings. Add/change settings through the [dashboard configuration guide](configuration.md). [Bluetooth access](connecting-over-bluetooth.md) needs its own configured key; viewing over Wi-Fi needs no internet after installation. Setup/Update downloads do need internet.

Raw CAN capture is off for riders because it is unencrypted. Back up downloaded ride logs and the private key separately. Re-imaging erases settings/history on that SD card; bundle rollback only restores software and cannot repair boot firmware, OS drift or card damage. [Help and private diagnostic details](support.md).

## Existing checkout or Daniel's bike

Keep your existing checkout and its Update button until the migration route is announced. **Never re-image to migrate.** The service owns the one-time settings/data migration and journal; setup verifies it, never moves the data itself, and retains the checkout. Daniel's first migration is a separate [GO-at-the-bike acceptance](bundle-installation.md#daniels-first-real-migration--go-at-the-bike), with off-card backups and a named branch prerelease. No lane may deploy or contact his Pi without that GO.

For an intentional developer checkout, the full [checkout/build recipes](checkout-install.md) remain available. Bundle owners use the dashboard **Update** button; [update/rollback behavior](bundle-updater.md) covers refusals and recovery.
