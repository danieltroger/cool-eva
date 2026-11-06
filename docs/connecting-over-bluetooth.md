# Connecting to the Pi over Bluetooth

How to get the dashboard on your phone over Bluetooth, for when the phone and the Pi share no wifi. This is the how-to; how it works is in [`ble-server.md`](ble-server.md), and the iOS app's own details are in [`ios-app.md`](ios-app.md).

**You do not pair the Pi in your phone's Bluetooth settings.** It will not show up there and does not need to. The connection is made from inside the dashboard, and the generated key you paste there is what authorises it.

## Pick a way in

| Phone | Use | Opens with no reception? |
| --- | --- | --- |
| iPhone | the experimental **[Cool Eva app](ios-app.md)** (`ios/`, installed from Xcode; not yet tested on a phone) | yes — the dashboard is in the app |
| iPhone | **[Bluefy](https://apps.apple.com/app/id1492822055)**, a Web Bluetooth browser | no — load the page while you have signal |
| Android | **Chrome** | no — the same |

Safari cannot do this on any iPhone: it has no Web Bluetooth.

Bluefy and Chrome use the hosted dashboard, **[https://cool-eva.athegen.com](https://cool-eva.athegen.com)**. The Pi's `http://cool-eva.local` dashboard uses wifi, so its menu has no Bluetooth section. A browser can only use Bluetooth on an https page. GitHub Pages serves the static page; subsequent dashboard data travels directly between the phone and Pi over Bluetooth.

**When moving from an old address (`cool-eva-dashboard.cool-eva.workers.dev` or `danieltroger.github.io/cool-eva`), re-enter your saved Bluetooth access code on the new address.** Browser storage is separate for each origin; the old page's saved code does not move with you. Use your recoverable copy of the Pi's current code, then you may clear the old site's data in your browser. Update your bookmark. The native app's address and saved code are unchanged.

## 1. Set up the Pi (once)

Do this with the bike parked in wifi range, over ssh.

1. **Update both the Pi and the phone page/app to protocol 2.** A fresh installation needs no branch change; for an older installation, follow the [update guide](deploy.md#running-it). The installed iOS app bundles the dashboard and must be rebuilt. The Pi and phone report a version mismatch if only one is updated. No dependency installation is needed for this code change.

2. Open **Menu → Settings → Connections → Dashboard Bluetooth** over reachable Wi-Fi. Create a New key, keep a recoverable copy, then Save. It is generated from 32 random bytes, encoded as 64 lowercase hexadecimal characters. Keep it across app rebuilds and service starts; never put it in a URL.

3. Review **Saved, not active**, then use the shared two-tap Restart. Readings and recording pause. Reconnect over Wi-Fi and confirm **Bluetooth ready**; a registration failure stays visible as Unavailable. Rotation invalidates other phones' old copies; give those phones the new key.

A second phone chooses **Use an existing access code** and **Connect this phone**. It never creates a replacement key. If rotation was saved over the tunnel, the current phone must keep the pending key before restarting, or use Wi-Fi. The Settings page offers the retained pending key for reconnecting when a restart reply was lost. No configured BLE server means Bluetooth cannot be a recovery route yet; retain Wi-Fi or use the [manual repair route](manual-install.md).

The hosted copy is deployed from `main` by `.github/workflows/pages.yml`. Only Bluefy and Chrome need it; the app bundles its own copy. See [the hosted dashboard](hosted-pages.md) for the one-time Pages and DNS setup.

## 2. Connect from the phone

Stay within about 10 m of the bike.

### Bluefy (iPhone)

1. Install [Bluefy](https://apps.apple.com/app/id1492822055) and open **[https://cool-eva.athegen.com](https://cool-eva.athegen.com)** in it.
2. Open **☰ menu → Settings → Connections → Use an existing access code**.
3. Paste the key into **Paste the Pi’s generated Bluetooth key** and tap **Connect this phone**.
4. Allow Bluetooth if Bluefy asks, then pick the Pi’s dashboard service in the list. It may appear without a name, or as **Unnamed Pi** in the app. The encrypted welcome verifies the shared key.

### Chrome (Android)

The same four steps, in Chrome. Android may ask for the **Nearby devices** permission (Location, on older Android versions) the first time — Chrome needs it to scan.

### The Cool Eva app (iPhone)

Install it from Xcode as [`ios-app.md`](ios-app.md) §"Running it" describes, then steps 2–4 above. The app shows its own list of Pis in place of the browser's.

### What connected looks like

The dot in the header turns green and reads **live**, the tiles fill in, and the Bluetooth section in **Settings → Connections** reads **Connected to …** with the Pi's name. On the Pi:

```
ble-server: phone authenticated, session started
```

### Next time

The secret is remembered by that browser or app, so you only type it once. What is not remembered is which Pi you picked: after the page is reloaded or reopened, tap **Connect** in the header and pick it again. That is a Web Bluetooth rule — a page may only open the device list in answer to a tap.

If the link drops while the page is open, it reconnects on its own and the Bluetooth section says so. When you lock the phone or switch apps, the page lets go of the stream exactly as it does on wifi, and picks it back up when you return.

In Bluefy and Chrome, open the page while you still have signal and leave the tab open; the garage has none. The app has no such problem.

## Troubleshooting

| what you see | what to do |
| --- | --- |
| **No access-code form in Settings → Connections** | The wifi copy (`cool-eva.local`) does not need a Bluetooth code to connect this phone. Open `https://cool-eva.athegen.com` instead, or use the app. |
| **This browser has no Web Bluetooth…** | You are in Safari or another browser without it. Use Bluefy or the app on iPhone, Chrome on Android. |
| Tapping **Connect** does not open the device list | No secret is saved yet. Open **Menu → Settings → Connections**, paste the saved key under **Use an existing access code** and tap **Connect this phone**. |
| **The list stays empty** | The Pi is not advertising. Check the journal for `advertising dashboard service` (step 1.3). If it shows `Operation already in progress` over and over, the Pi's Bluetooth adapter is wedged ([`ble-adapter-wedge.md`](ble-adapter-wedge.md)). Restarting the service does **not** clear that; the service power-cycles the adapter itself after a few failures, so give it a minute, and `sudo reboot` if it persists. Also check you are in range. |
| **Connection attempt refused: wrong secret** | Tick **Show key** under the key field. The line **This page sends:** is the stored key this page proves with, not whatever is typed in the field; compare it with the owner’s saved current Bluetooth key. Each address and the app keep separate copies, so a key saved elsewhere is not here. If they differ, paste the saved key and connect again. If they match, the Pi may still be running an older key: a newly saved key applies only after an explicit Restart (**Saved, not active** in Settings). A refused attempt does not blacklist the key; the connection policy retries. |
| **Connection attempt refused: another phone is connected** | The Pi serves one authenticated phone at a time. Disconnect that phone, then retry. |
| **Bluetooth needs its own address** | This page’s exact origin is not allowed. Use the configured hosted URL or the native app; fork owners configure their exclusive origin in `public/lib/ble-origin.js`. |
| **Bluetooth permission is off** (app) | iPhone Settings → Cool Eva → Bluetooth. |
| **Link lost: …** that keeps coming back | Range, or the Pi's one radio also holding the Connectivity Hub link. Leave `journalctl -u cool-eva -f` running while it happens; the `ble-server:` lines say why. |
| Live tiles work but a download crawls | BLE can be much slower than wifi; throughput on the Pi is still unmeasured. The ride log shows its progress under its button. |

## Who can connect

Only a phone that knows the generated key. Anyone in range can see the dashboard service UUID, but without the key the Pi refuses everything except the handshake, and everything it sends after that is encrypted under a key derived from the secret.

<!-- for-now: #317 -->

The key lives in the Pi’s private settings and in the browser/app or saved copy on your devices. To revoke a phone, create and save a new key in Settings, then explicitly Restart.

The dashboard has its own origin, separate from other sites. Browser storage is shared by origin, not by project path. See [the exact-origin allowlist and fork instructions](ble-server.md#hosted-pages-and-origin-isolation). Address privacy remains an optional, unverified choice: [phone reconnect and hub enrolment trade-offs](ble-server.md#address-privacy-is-optional-and-remains-off-pending-hardware-verification) explain why it stays off until hardware checks pass.

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
