# Connecting to the Pi over Bluetooth

How to get the dashboard on your phone over Bluetooth, for when the phone and the Pi share no wifi. This is the how-to; how it works is in [`ble-server.md`](ble-server.md), and the iOS app's own details are in [`ios-app.md`](ios-app.md).

**You do not pair the Pi in your phone's Bluetooth settings.** It will not show up there and does not need to. The connection is made from inside the dashboard, and the generated key you paste there is what authorises it.

## Pick a way in

| Phone | Use | Opens with no reception? |
| --- | --- | --- |
| iPhone | the **Cool Eva app** (`ios/`, installed from Xcode) | yes — the dashboard is in the app |
| iPhone | **[Bluefy](https://apps.apple.com/app/id1492822055)**, a Web Bluetooth browser | no — load the page while you have signal |
| Android | **Chrome** | no — the same |

Safari cannot do this on any iPhone: it has no Web Bluetooth.

Bluefy and Chrome use the copy of the dashboard on GitHub Pages, **`https://danieltroger.github.io/cool-eva/`**. Not `http://cool-eva.local`: that is the copy the Pi serves over wifi, which never uses Bluetooth, so its menu has no Bluetooth section at all. A browser can only use Bluetooth on an https page, and once the page is open, everything goes straight between the phone and the Pi; GitHub never sees any of it.

## 1. Set up the Pi (once)

Do this with the bike parked in wifi range, over ssh.

1. **Update both the Pi and the phone page/app to protocol 2.** The installed iOS app bundles the dashboard and must be rebuilt. The Pi and phone report a version mismatch if only one is updated. No dependency installation is needed for this code change.

2. **Generate one random key**, rather than choosing a phrase:

   ```sh
   openssl rand -hex 32
   sudo nano /etc/default/cool-eva
   ```

   Put the generated 64-character lowercase hex value after `BLE_SECRET=`. Keep the same value across service restarts and app rebuilds. Copy it to the phone; do not put it in a URL. To revoke a phone or a previously exposed key, generate a new one and restart.

3. **Restart and check:**

   ```
   sudo systemctl restart cool-eva
   journalctl -u cool-eva -f | grep ble-server
   ```

   It is ready when you see:

   ```
   ble-server: advertising dashboard service 7c0e0001-5f3a-4c8e-9d2b-c00e7a000001
   ble-server: serving the dashboard over BLE
   ```

   | instead you see | meaning |
   | --- | --- |
   | `ble-server: off (set BLE_SECRET …)` | the secret was not read — check the file and the spelling of the name |
   | `ble-server: could not start … BLE_SECRET must be a generated 64-character lowercase-hex key …` | generate a new key as above |
   | `ble-server: registration failed, retrying in 15 s: …` | bluetoothd refused; the reason is on the same line |

The GitHub Pages copy also has to exist, once: repo **Settings → Pages → Source = "GitHub Actions"**, then a merge to `main` publishes it. Only Bluefy and Chrome need it; the app does not.

## 2. Connect from the phone

Stay within about 10 m of the bike.

### Bluefy (iPhone)

1. Install [Bluefy](https://apps.apple.com/app/id1492822055) and open **`https://danieltroger.github.io/cool-eva/`** in it.
2. Tap the **☰ menu** (top left). **Bluetooth** is the first section.
3. Paste the key into **Paste the Pi’s generated Bluetooth key** and tap **Connect to the Pi**.
4. Allow Bluetooth if Bluefy asks, then pick the Pi’s dashboard service in the list. It may appear without a name, or as **Unnamed Pi** in the app. The encrypted welcome verifies the shared key.

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
| **The list stays empty** | The Pi is not advertising. Check the journal for `advertising dashboard service` (step 1.3). If it shows `Operation already in progress` over and over, the Pi's Bluetooth adapter is wedged ([`ble-adapter-wedge.md`](ble-adapter-wedge.md)). Restarting the service does **not** clear that; the service power-cycles the adapter itself after a few failures, so give it a minute, and `sudo reboot` if it persists. Also check you are in range. |
| **Connection attempt refused: wrong secret** | Check the generated key against `BLE_SECRET` on the Pi and paste it again if needed. A refused attempt does not blacklist the key; the connection policy retries. |
| **Connection attempt refused: another phone is connected** | The Pi serves one authenticated phone at a time. Disconnect that phone, then retry. |
| **Bluetooth needs its own address** | This page’s exact origin is not allowed. Use the configured hosted URL or the native app; fork owners configure their exclusive origin in `public/lib/ble-origin.js`. |
| **Bluetooth permission is off** (app) | iPhone Settings → Cool Eva → Bluetooth. |
| **Link lost: …** that keeps coming back | Range, or the Pi's one radio also holding the Connectivity Hub link. Leave `journalctl -u cool-eva -f` running while it happens; the `ble-server:` lines say why. |
| Live tiles work but a download crawls | BLE can be much slower than wifi; throughput on the Pi is still unmeasured. The ride log shows its progress under its button. |

## Who can connect

Only a phone that knows the generated key. Anyone in range can see the dashboard service UUID, but without the key the Pi refuses everything except the handshake, and everything it sends after that is encrypted under a key derived from the secret. The secret lives in `/etc/default/cool-eva` on the Pi and in the browser or app on your phone, nowhere else. To lock out a phone, change `BLE_SECRET` and restart the service.

The hosted account must serve **no other GitHub Pages site**: storage is shared by origin, not by project path. See [the exact-origin allowlist and fork instructions](ble-server.md#hosted-pages-and-origin-isolation). Address privacy remains an optional, unverified choice: [phone reconnect and hub enrolment trade-offs](ble-server.md#address-privacy-is-optional-and-remains-off-pending-hardware-verification) explain why it stays off until hardware checks pass.
