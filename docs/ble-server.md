# The dashboard over BLE

The Pi can serve the whole dashboard over Bluetooth Low Energy as well as over wifi. That covers the live telemetry, every endpoint, and the service-mode writes. It's for a phone that shares no network with the Pi. Wifi is unchanged; BLE is a second door into the same service.

Code: `src/ble-server/` (Pi), `public/lib/ble-wire.js` (the wire format, imported by **both** ends), `public/lib/ble-link.js` and `public/lib/transport.js` (phone). Checks: `scripts/check-ble-wire.ts`, `scripts/check-ble-server.ts`.

## Turning it on

Put a secret in `/etc/default/cool-eva` and restart:

```
BLE_SECRET=some long phrase you will type into the phone once
```

At least 12 characters. Unset, the Pi does not advertise at all, and the journal says `ble-server: off`. It needs no `npm install`: `dbus-next` was already installed as node-ble's dependency and is now only declared directly.

Safari has no Web Bluetooth, so on **iPhone** there are two ways in: the app in `ios/` ([`docs/ios-app.md`](ios-app.md)), which carries the dashboard with it and so also opens with no reception, or the https copy of the dashboard (below) in **[Bluefy](https://apps.apple.com/app/id1492822055)**, a browser with Web Bluetooth. On **Android**, open the https copy in Chrome. Either way, open the menu, enter the secret under _Bluetooth_, and tap _Connect_. The secret is stored in `localStorage`; the device has to be chosen again after each page load. Web Bluetooth will only open its chooser from a tap, which is why the header shows a _Connect_ button until the link is up.

## Where the page comes from

Web Bluetooth only exists on a secure origin. The Pi serves the dashboard over plain `http://cool-eva.local`, and that copy can never open a BLE link. So BLE needs a second copy of `public/` served over https: GitHub Pages, published as-is because there is no build step. The page only _comes from_ GitHub; once it is open, every byte goes straight between the phone and the Pi over BLE, and GitHub never sees any of it.

`.github/workflows/pages.yml` publishes it on every push to `main` (or by hand from the Actions tab), to `https://<owner>.github.io/cool-eva/`. It needs one setting first: repo **Settings → Pages → Source = "GitHub Actions"**. Loading it from that `/cool-eva/` subpath was checked in headless Chrome: every module, the stylesheet and the manifest resolved under the subpath, nothing was requested outside it, and the page came up in BLE mode with its Connect button.

The secret is kept in the browser's `localStorage` for that origin, and `<owner>.github.io` is **one origin for every Pages site on the account**. Only the account owner can publish there, so this is a note rather than a hole — but a page from any of your other Pages repos could read it.

Which transport a page uses is fixed by where it was loaded from (`BLE_MODE` in `public/lib/ble-link.js`). An `http:` page was served by a Pi and uses `fetch` and the WebSocket, exactly as before. An `https:` page has no Pi behind its origin and uses BLE for everything, and so does the copy inside the iOS app, which it recognises by `window.coolEvaNative`. `?transport=ble` forces BLE, for development on `localhost`, which browsers treat as secure.

To make one tree work at both origins, asset paths in `index.html` / `params.html` / the manifest are relative. Every endpoint call goes through `request()` in `public/lib/transport.js` rather than `fetch`. A stray `fetch` would work on wifi and 404 on Pages.

**Open questions, to verify on the phones:**

- **Offline loading** (Android). In the garage there is no reception, so the Pages copy has to already be loaded or cached. There is no service worker yet. Until there is one, load the page while you have signal and keep the tab open. The iOS app does not have this problem: the page is in its bundle.
- **`params.html`** is a separate page load and does not inherit the BLE link. Over BLE it currently cannot fetch the parameter table.

## Why a tunnel

The Pi does not reimplement any endpoint over GATT. Each BLE request is replayed as an HTTP request to the service's own server on `127.0.0.1:80` (`src/ble-server/tunnel.ts`), and the response is streamed back. Everything an endpoint enforces therefore applies over BLE unchanged, because by the time a handler sees the request it **is** an HTTP request. That includes the `X-Cool-Eva` header gates, `SERVICE_WRITE_ENABLED`, the write runner's locks and audit lines, and the table gate. Adding an endpoint needs no BLE work.

The live stream is the exception. It subscribes directly to `src/can/signals.ts`, the way `src/ws.ts` does, rather than looping a WebSocket back through the tunnel.

The tunnel owns the hop-by-hop headers (`Host`, `Content-Length`, `Connection`, …); a phone cannot set them. Request bodies are capped at 16 kB, at most 6 requests may be in flight, and each has 180 s to answer.

## Why seal

The `X-Cool-Eva` headers stop cross-origin requests; they are not secrets. BLE is reachable by anything in radio range, so the link needs real authentication before it carries `/vcu-write`.

A login gate alone would not be enough. BlueZ delivers a GATT server's notification to **every** subscribed device, so a stranger who subscribed and never authenticated would still receive the phone's responses. So every message after the handshake is **sealed**: AES-256-GCM over deflate-raw, in both directions.

1. The phone reads the `info` characteristic: `{ version, serverNonce }`.
2. It sends a clear `HELLO`: `{ version, clientNonce, proof = HMAC-SHA256(secret, "cool-eva/hello" ‖ serverNonce ‖ clientNonce) }`.
3. The Pi checks the proof in constant time. If it matches, both ends derive `key = HMAC-SHA256(secret, "cool-eva/session" ‖ serverNonce ‖ clientNonce)` and the Pi answers with a **sealed** `WELCOME`. That is the Pi proving it knows the secret too. The server nonce rotates on success, so a recorded `HELLO` is useless afterwards.
4. Every later envelope carries a 64-bit counter. The counter goes into the GCM IV with a direction byte, so the two directions never share an IV, and it is authenticated as additional data. Each end drops any counter not above the last one it accepted, which blocks replays.

There is one session at a time; a new successful `HELLO` replaces the old one. A wrong secret arms a 2 s cooldown during which every `HELLO` is refused unchecked, so a short typed secret cannot be guessed at radio speed. The nonce rotates only on success; rotating on failure would let anyone knock the real phone's `HELLO` off its nonce by sending garbage first.

The characteristics deliberately carry no `encrypt-*` flags. The sealing already gives confidentiality and integrity, and requiring a BLE bond would add an OS pairing prompt to every first connection.

## Wire format

Three layers, all in `public/lib/ble-wire.js`:

| layer    | shape                                                                     |
| -------- | ------------------------------------------------------------------------- |
| frame    | `[flags: FIRST=1 \| LAST=2][messageId u8][payload…]`, one per GATT value  |
| envelope | `[0][message]` clear, or `[1][counter u64 BE][AES-GCM(deflate(message))]` |
| message  | `[kind u8][headerLength u32 BE][header JSON][body bytes]`                 |

Kinds: phone → Pi `HELLO`, `REQUEST {id, method, path, headers}` + body, `SUBSCRIBE`, `UNSUBSCRIBE`. Pi → phone `REFUSED {reason}` (clear), `WELCOME`, `RESPONSE_HEAD {id, status, headers}`, `RESPONSE_BODY {id}` + ≤ 4 kB of body, `RESPONSE_END {id, error?}`, `STREAM` (a `DashboardMessage` as the header).

GATT, service `7c0e0001-5f3a-4c8e-9d2b-c00e7a000001`:

| characteristic | UUID suffix | flags  | carries                                       |
| -------------- | ----------- | ------ | --------------------------------------------- |
| `rx`           | `…0002…`    | write  | phone → Pi frames, ≤ 180 bytes                |
| `tx`           | `…0003…`    | notify | Pi → phone frames, ≤ MTU − 3                  |
| `info`         | `…0004…`    | read   | `{ version, serverNonce }` JSON, never secret |

Phone writes are 180 bytes, under the 185-byte MTU iOS negotiates, so no write needs the long-write procedure. The Pi learns the real MTU from the `mtu` option BlueZ passes to each `WriteValue`, and starts at 23 until the first write arrives.

## Pacing

A notification from a BlueZ GATT server is a `PropertiesChanged` signal with no flow control. If the Pi emits faster than the radio drains, bluetoothd queues it out of our sight. So `src/ble-server/outbound.ts` paces itself, at **24 kB/s by default**. That figure is a guess, not a measurement; tune it on the bike. Its own queue is the one backlog this process can see, and two things read it:

- **Telemetry** sheds patches while more than 16 kB is queued. The 5 s heartbeat snapshot always goes out, and it resynchronises the dashboard on its own, as on wifi. Patches are also coalesced into 100 ms windows, under the dashboard's 2 Hz chart tick, rather than sealed one change at a time.
- **Response bodies** wait while more than 32 kB is queued. The tunnel pulls the loopback response with `for await`, so this is real backpressure from the radio back to the HTTP handler: a multi-megabyte `/dl` is never read into memory ahead of the link.

At 24 kB/s a sealed ride log moves at about 1.4 MB a minute. Ciphertext does not compress.

## BlueZ objects

`src/ble-server/gatt-app.ts` exports an `ObjectManager` application at `/org/cooleva/ble`, holding one service with the three characteristics above, plus an `LEAdvertisement1` (`peripheral`, the service UUID, local name `cool-eva`). It registers both through `GattManager1` / `LEAdvertisingManager1` on `hci0`. Every call to bluetoothd is bounded at 10 s, because dbus-next has no call timeout of its own.

Both registrations die with the adapter: an rfkill toggle, the wedge power-cycle in `src/ble/adapter.ts`, or a bluetoothd restart. The server watches `Adapter1.Powered` and re-registers when it comes back, and a 15 s supervisor retries whenever it is unregistered for any other reason.

## Not yet verified on the Pi

- **Both roles on one radio.** The Pi Zero 2 W's adapter is already the Connectivity Hub's central and is known to wedge (`docs/ble-adapter-wedge.md`). Advertising and serving a phone at the same time is untested there. Watch the journal for `Operation already in progress` becoming more frequent with `BLE_SECRET` set.
- **Throughput** with wifi sharing the radio, and so the right pacing figure.
- **The iOS app** on a real iPhone, end to end ([`docs/ios-app.md`](ios-app.md) §"Known gaps").
