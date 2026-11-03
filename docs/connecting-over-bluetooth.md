# Connecting to the Pi over Bluetooth

How to get the dashboard on your phone over Bluetooth, for when the phone and the Pi share no wifi. This is the how-to; how it works is in [`ble-server.md`](ble-server.md), and the iOS app's own details are in [`ios-app.md`](ios-app.md).

**You do not pair the Pi in your phone's Bluetooth settings.** It will not show up there and does not need to. The connection is made from inside the dashboard, and the secret you type there is what authorises it.

## Pick a way in

| Phone | Use | Opens with no reception? |
| --- | --- | --- |
| iPhone | the experimental **[Cool Eva app](ios-app.md)** (`ios/`, installed from Xcode; not yet tested on a phone) | yes — the dashboard is in the app |
| iPhone | **[Bluefy](https://apps.apple.com/app/id1492822055)**, a Web Bluetooth browser | no — load the page while you have signal |
| Android | **Chrome** | no — the same |

Safari cannot do this on any iPhone: it has no Web Bluetooth.

Bluefy and Chrome use the copy of the dashboard on GitHub Pages, **[https://danieltroger.github.io/cool-eva/](https://danieltroger.github.io/cool-eva/)**. Not `http://cool-eva.local`: that is the copy the Pi serves over wifi, which never uses Bluetooth, so its menu has no Bluetooth section at all. A browser can only use Bluetooth on an https page, and once the page is open, everything goes straight between the phone and the Pi; GitHub never sees any of it.

## 1. Set up the Pi (once)

Do this with the bike parked in wifi range, over ssh.

1. **Use the current software.** The BLE server is already on `main`; a fresh installation needs no branch change. For an older installation, follow the [update guide](deploy.md#running-it).

2. **Choose a secret** of at least 12 characters. You will type it on the phone once, so a phrase you can type is better than random characters.

   <!-- for-now: #317 -->

   For now, add it to the service's environment file:

   ```
   sudo nano /etc/default/cool-eva
   ```

   ```
   BLE_SECRET=pick a phrase you can type on a phone
   ```

3. **Restart and check:**

   ```
   sudo systemctl restart cool-eva
   journalctl -u cool-eva -f | grep ble-server
   ```

   It is ready when you see:

   ```
   ble-server: advertising as "cool-eva" (service 7c0e0001-5f3a-4c8e-9d2b-c00e7a000001)
   ble-server: serving the dashboard over BLE
   ```

   | instead you see | meaning |
   | --- | --- |
   | `ble-server: off (set BLE_SECRET …)` | the secret was not read — check the file and the spelling of the name |
   | `ble-server: could not start … BLE_SECRET must be at least 12 characters` | make it longer |
   | `ble-server: registration failed, retrying in 15 s: …` | bluetoothd refused; the reason is on the same line |

The GitHub Pages copy also has to exist, once: repo **Settings → Pages → Source = "GitHub Actions"**, then a merge to `main` publishes it. Only Bluefy and Chrome need it; the app does not.

## 2. Connect from the phone

Stay within about 10 m of the bike.

### Bluefy (iPhone)

1. Install [Bluefy](https://apps.apple.com/app/id1492822055) and open **[https://danieltroger.github.io/cool-eva/](https://danieltroger.github.io/cool-eva/)** in it.
2. Tap the **☰ menu** (top left). **Bluetooth** is the first section.
3. Type the secret into **BLE secret (BLE_SECRET on the Pi)** and tap **Connect to the Pi**.
4. Allow Bluetooth if Bluefy asks, then pick **cool-eva** in the list. It may show as the Pi's hostname instead once iOS has seen it before.

### Chrome (Android)

The same four steps, in Chrome. Android may ask for the **Nearby devices** permission (Location, on older Android versions) the first time — Chrome needs it to scan.

### The Cool Eva app (iPhone)

Install it from Xcode as [`ios-app.md`](ios-app.md) §"Running it" describes, then steps 2–4 above. The app shows its own list of Pis in place of the browser's.

### What connected looks like

The dot in the header turns green and reads **live**, the tiles fill in, and the menu's Bluetooth section reads **Connected to …** with the Pi's name. On the Pi:

```
ble-server: phone authenticated, session started
```

### Next time

The secret is remembered by that browser or app, so you only type it once. What is not remembered is which Pi you picked: after the page is reloaded or reopened, tap **Connect** in the header and pick it again. That is a Web Bluetooth rule — a page may only open the device list in answer to a tap.

If the link drops while the page is open, it reconnects on its own and the menu says so. When you lock the phone or switch apps, the page lets go of the stream exactly as it does on wifi, and picks it back up when you return.

In Bluefy and Chrome, open the page while you still have signal and leave the tab open; the garage has none. The app has no such problem.

## Troubleshooting

| what you see | what to do |
| --- | --- |
| **No Bluetooth section in the menu** | You are on the wifi copy (`cool-eva.local`). Open `https://danieltroger.github.io/cool-eva/` instead, or use the app. |
| **This browser has no Web Bluetooth…** | You are in Safari or another browser without it. Use Bluefy or the app on iPhone, Chrome on Android. |
| Tapping **Connect** opens the menu instead of the list | No secret is saved yet. Type it in the highlighted field and tap **Connect to the Pi**. |
| **The list stays empty** | The Pi is not advertising. Check the journal for `advertising as` (step 1.3). If it shows `Operation already in progress` over and over, the Pi's Bluetooth adapter is wedged ([`ble-adapter-wedge.md`](ble-adapter-wedge.md)). Restarting the service does **not** clear that; the service power-cycles the adapter itself after a few failures, so give it a minute, and `sudo reboot` if it persists. Also check you are in range. |
| **Refused by the Pi: wrong secret** | The secret differs from `BLE_SECRET` on the Pi. Retype it in the menu and tap **Connect to the Pi** again; it reconnects to the Pi you already picked. |
| **Refused by the Pi: too soon after a failed attempt** | After a wrong secret the Pi refuses everything for 2 s. Wait a moment and tap again. |
| **Bluetooth permission is off** (app) | iPhone Settings → Cool Eva → Bluetooth. |
| **Link lost: …** that keeps coming back | Range, or the Pi's one radio also holding the Connectivity Hub link. Leave `journalctl -u cool-eva -f` running while it happens; the `ble-server:` lines say why. |
| Live tiles work but a download crawls | Expected: Bluetooth moves a ride log at roughly 1.4 MB a minute. The ride log shows its progress under its button. |

## Who can connect

Only a phone that knows the secret. Anyone in range can see that a `cool-eva` is advertising, but without the secret the Pi refuses everything except the handshake, and everything it sends after that is encrypted under a key derived from the secret.

<!-- for-now: #317 -->

For now, the secret lives in `/etc/default/cool-eva` on the Pi and in the browser or app on your phone, nowhere else; to lock out a phone, change `BLE_SECRET` and restart the service.

## Earlier branch instructions

<details>
<summary>Before the BLE server merged (superseded)</summary>

The current `main` already includes the server. These earlier instructions are preserved for history; use the setup above.

1. **Run a version with the BLE server.** Until the `ble-server` branch is merged, check it out — as the `pi` user, **never with `sudo`**:

   ```
   cd /home/pi/cool-eva
   git fetch origin && git checkout ble-server && git pull
   ```

   After it merges, a plain `git pull` on `main` is enough. Neither needs `npm install`.

</details>
