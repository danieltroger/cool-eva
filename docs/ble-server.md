# The dashboard over BLE

To connect a phone, follow [connecting-over-bluetooth.md](connecting-over-bluetooth.md). The Pi's GATT server carries the existing dashboard HTTP endpoints and live `DashboardMessage` stream. Endpoint header gates, confirmation tokens, write locks, and audit behavior remain in the existing handlers because requests go through loopback HTTP.

## Why a tunnel

The Pi does not reimplement endpoints over GATT. `src/ble-server/tunnel.ts` forwards each authenticated request to this process's HTTP server on loopback and streams its response back. The existing `X-Cool-Eva` header gates, service-data availability, confirmation tokens, write locks, table gate and audit behavior apply because the handler receives an actual HTTP request. Adding an endpoint therefore needs no separate BLE handler.

Live telemetry deliberately bypasses the tunnel: `stream.ts` subscribes directly to `src/can/signals.ts`, as `src/ws.ts` does, instead of opening a loopback WebSocket. The tunnel owns hop-by-hop headers, including `Host`, `Content-Length`, `Connection` and transfer encoding; the phone cannot supply them or receive loopback-specific values. Uploads are capped at 16 KiB. At most six concurrent requests cover the dashboard's opening burst while bounding the loopback sockets they retain, and the socket inactivity timeout is 180 seconds.

## Why seal

The endpoint's `X-Cool-Eva` headers prevent cross-origin requests; they are not secrets. Anything in radio range can reach GATT, so authentication must precede operations such as `/vcu-write`. A login gate alone cannot protect the responses: BlueZ sends notifications to every subscriber, including devices that never authenticated. Both directions therefore seal every post-handshake message with AES-256-GCM over deflate-raw.

The characteristics deliberately omit `encrypt-*` flags. Application sealing supplies confidentiality and integrity; requiring a BLE bond would add an OS pairing prompt on first connection. The generated HMAC key is the access control. These unpaired links do not give the phone the Pi's IRK; the consequences for optional address privacy are documented below.

## Key and protocol

The dashboard Bluetooth key is **32 random bytes encoded as 64 lowercase hexadecimal characters**. Create it in Settings → Connections → Dashboard Bluetooth, keep a recoverable copy, Save, then explicitly Restart. A second phone imports the existing code; it does not rotate it. Onboarding (#317) uses `generateBleSecret()` from `public/lib/ble-secret.js` and persists it; restarting the service or rebuilding the app must not change it. A format validator cannot prove random provenance. Human phrases are rejected before BLE starts, while the rest of telemetry continues.

Unset, BLE stays off and the Pi does not advertise. Keys are never put in URLs or diagnostic messages. Changing the Pi's key and restarting revokes old copies. The phone trims surrounding whitespace and normalizes hex case before validating and saving an entered key; invalid input cannot replace a saved key.

**Protocol 2 requires updating both the Pi and the page/app.** The iOS app bundles `public/` and must be rebuilt; refreshing a hosted page does not update an installed bundle. A version mismatch fails before HELLO.

1. Read INFO: `{ version, serverNonce }`.
2. Send a clear HELLO: `{ version, clientNonce, proof }`. Each nonce is exactly 16 bytes encoded as 32 lowercase hex characters. The proof is HMAC-SHA256 over `"cool-eva/hello" ‖ serverNonce ‖ clientNonce`.
3. Verify the proof without changing any session state. A successful commit derives the AES key with the separate `"cool-eva/session"` HMAC label, rotates the server nonce, and returns a sealed WELCOME. A captured successful HELLO cannot establish another session after `end()`.
4. Later messages use AES-256-GCM over deflate-raw. Each direction has a strictly increasing 64-bit counter; direction and counter form the IV, and the envelope prefix containing the counter is authenticated as additional data. Separate direction bytes prevent IV reuse between the two directions, and accepted counters must exceed the previous one to reject reflection/replay. There is no forward secrecy.

The proof comparison does not short-circuit. Sealed WELCOME proves that the Pi knows the shared key too: the browser keeps the derived key as pending so it can decrypt WELCOME, but no request uses it before confirmation. The server nonce rotates **only after a successful commit**. Rotating it on failure would let a stranger invalidate a rider's in-flight HELLO by sending garbage first. A failed or stale proof cannot rotate the challenge or replace a session.

Both server chains exist for **ordering**, independently of the work budgets. Inbound envelopes open in arrival order so asynchronous decryption cannot race the previous authenticated counter. Outbound sealing and enqueue run in the order counters are allocated; otherwise concurrent crypto work could reverse two valid envelopes and make the phone reject one as replayed. The browser applies the same ordering to decryption and outbound sealing. Its write chain also ensures one GATT write at a time: Web Bluetooth rejects a second write while one is pending.

BlueZ broadcasts notifications to every subscribed device, so possession of the key separates the intended phone from other listeners. The GATT characteristics remain unpaired (`read`, `write`, `notify`, without `encrypt-*`). A clear REFUSED includes the HELLO's client nonce; it is an advisory for that pending attempt, never proof that a key is invalid. An established phone ignores clear refusals. There is no credential blacklist or wrong-HELLO lockout; generated keys remove the reason to tolerate guessable phrases. Existing browser connection policy paces retries, and requests that might have written are never automatically resent by the BLE transport.

## Where the page comes from

Web Bluetooth requires a secure context. The ordinary Pi dashboard at `http://cool-eva.local` cannot open Web Bluetooth, so browser BLE needs a second copy of `public/` over HTTPS. `.github/workflows/workers.yml` publishes those files as-is to the `cool-eva-dashboard` Worker on pushes to `main` or manual dispatch on `main`. The iOS app instead bundles `public/`, the native bridge and a file-sharing interface, so it can load without reception. There is one BLE link per loaded page. A browser device chooser requires a tap, which is why initial selection is an explicit Connect action rather than an automatic retry.

After a reload or relaunch the page first asks `navigator.bluetooth.getDevices()` for devices this origin was already allowed to use. If there is exactly one and a key is stored, it reuses that device and the ordinary connection policy connects with no tap (`restoreDevice` in `public/lib/ble-link.js`). No `getDevices`, no permitted device, more than one, or a refusal all leave Connect as the way in. The iOS app's shim has no `getDevices`, so this changes nothing there. ⚠️ Whether Bluefy implements `getDevices` has not been confirmed on a phone.

`BLE_MODE` is fixed by the page's source: Pi HTTP uses fetch/WebSocket; HTTPS and the native app have no Pi at their origin and use BLE. Explicit localhost `?transport=ble` supports development. The hosted page comes from Cloudflare; subsequent dashboard data travels directly between phone and Pi over BLE.

Assets in `index.html`, `params.html` and the manifest use relative paths. The Worker serves them at its root. The original BLE-server documentation recorded a headless Chrome check of the former Pages `/cool-eva/` path: modules, stylesheet and manifest resolved below that path, nothing escaped it, and the page entered BLE mode. That remains historical validation. The current local checks and hardware/deployment limits are listed below.

Every endpoint call must go through **`request()` in `public/lib/transport.js`**. A stray `fetch` works on the Pi's Wi-Fi origin but requests the wrong server, typically returning 404 on the static Worker. The transport preserves the Pi handler's HTTP status; a rejected tunnel promise means transport failure, not an endpoint refusal. An error response with headers and no body can be complete, while an error after BODY data is a truncated download and must never be saved as a whole file.

## Hosted pages and origin isolation

The hosted dashboard is enabled at **`https://cool-eva-dashboard.cool-eva.workers.dev`**. Its exact origin is dedicated to this dashboard; the key page has a different Worker origin. Browser localStorage is shared by **origin**, not by project path. Riders must **re-enter their saved Bluetooth access code** at the new address; storage cannot move across origins. Update bookmarks and keep a recoverable copy.

Unpublishing leaves riders' saved Bluetooth codes in browser storage under `danieltroger.github.io`, so do not publish another GitHub Pages site on that account unless the Pi's Bluetooth code has been rotated first. After re-entering the code at the new address, riders may clear the old site's data in their browser.

The dashboard can use Bluetooth on any page where the browser provides Web Bluetooth.

The Pi's ordinary HTTP dashboard continues to use fetch/WebSocket. Hosted HTTPS and the native app use BLE. The browser chooser is filtered by the common service UUID; it need not find an advertised name. Native discovery falls back to **Unnamed Pi**. An unnamed device does not establish its identity; the sealed WELCOME verifies the shared key.

## Framing and resource bounds

The shared wire module is `public/lib/ble-wire.js`:

| layer    | shape                                                                     |
| -------- | ------------------------------------------------------------------------- |
| frame    | `[flags: FIRST=1 \| LAST=2][messageId u8][payload…]`                      |
| envelope | `[0][clear message]`, or `[1][counter u64 BE][AES-GCM(deflate(message))]` |
| message  | `[kind u8][headerLength u32 BE][header JSON][body bytes]`                 |

Phone → Pi kinds are HELLO, REQUEST, SUBSCRIBE, UNSUBSCRIBE. Pi → phone kinds are REFUSED, WELCOME, RESPONSE_HEAD/BODY/END, and STREAM. REFUSED carries `{ reason, clientNonce }`; successful authentication is established by sealed WELCOME, not a clear message.

Before authentication only a complete single FIRST|LAST frame, at most 512 bytes, containing HELLO is considered. No partial assembly or per-peer MTU table is retained. The browser's HELLO fits one 180-byte application frame; at smaller ATT MTUs, write-with-response long writes are assembled by BlueZ before WriteValue. Only the authenticated device path can contribute to the one 20 KiB inbound assembler. Zero-payload continuations reset it, bounding fragment storage separately from the payload-byte ceiling without imposing a transfer-duration limit.

The 180-byte phone write frame fits the usual 185-byte iOS ATT MTU without needing a long write. The frame-layer message ID need only differ from its neighbour; crypto counters provide replay protection. Browser responses are split into small messages, so its 256 KiB inbound-envelope ceiling identifies a fault rather than limiting the total size of a progressing download.

Notifications use **`min(owner MTU − 5, 512)`** bytes per value: 18 at MTU 23, 180 at MTU 185, and 512 at MTU 517. MTU−5 accounts for BlueZ's multiple-notification format as well as ordinary notifications. Clear refusals use the default-MTU bound without changing the owner's MTU.

| resource                               | bound                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| queued output, including frame headers | 128 KiB; whole-envelope rejection                           |
| pending seals                          | 32                                                          |
| ordered owner inbound work             | 32 envelopes / 128 KiB                                      |
| independent HELLO work                 | 32 envelopes / 128 KiB; each frame ≤512 bytes               |
| concurrent loopback requests           | 6                                                           |
| response body chunk                    | 4 KiB                                                       |
| loopback response timeout              | 180 s                                                       |
| phone request inactivity deadline      | 195 s                                                       |
| clear refusals                         | burst of 4 per 2 s, only while TX is notifying              |
| rejected-input diagnostics             | one summary per 2 s, with a tail-flush timer and stop flush |

The rejection limiter is only for peer input. Internal HELLO, inbound handling, tunnel and sealing exceptions log immediately under their own operation and context; a stranger's flood cannot hide them behind the last bad-frame reason. The summary's timer flushes a quiet tail at the next window even if no later frame arrives, and shutdown cancels that timer while flushing its final count.

## Pacing

A BlueZ server notification is a `PropertiesChanged` signal without radio flow control. Emitting faster than the radio drains lets bluetoothd queue data outside this process's view. `outbound.ts` therefore paces emission; its own byte queue is the backlog telemetry shedding and response backpressure can observe.

Response producers await sealing/enqueue and pause above a 32 KiB output high-water mark. Output overflow ends that session rather than emitting a partial envelope. Unsubscribe/stop clears output and stops pacing even if no phone authenticated. There is no unauthenticated refusal backlog to replay when a subscriber appears.

The tunnel pulls the loopback response with `for await` and awaits the body sink. Above the high-water mark the sink yields on a 25 ms drain poll, then rechecks the session generation. This propagates backpressure from the visible radio queue to the HTTP socket rather than reading a multi-megabyte `/dl` into memory ahead of the link. Session loss aborts that wait instead of draining a file for a phone that no longer owns it.

The 24 kB/s pacing is an **unmeasured** starting value. It bounds application emission, not bluetoothd's hidden radio backlog. Framing checks at MTU 23 do not establish achievable throughput. WiFi and the existing hub connection share the adapter.

Already-encrypted ride-log ciphertext does not compress meaningfully; the JSON stream's compression savings do not predict download throughput. Byte pacing alone is not a bound on notification rate at small MTUs. Both throughput and simultaneous radio roles still need separately authorised hardware verification.

Telemetry still coalesces patches over 100 ms, sheds them above 16 KiB queued, and enqueues a heartbeat snapshot every 5 seconds. Those are enqueue intervals; a slow radio can delay their arrival. Authenticated response messages therefore count toward liveness independently of snapshots.

## BlueZ objects

`gatt-app.ts` exports an ObjectManager application at `/org/cooleva/ble`, one `GattService1`, three `GattCharacteristic1` objects and an `LEAdvertisement1`. The advertisement is `peripheral`, carries the service UUID and deliberately omits LocalName and `local-name` includes. Both application and advertisement register through `GattManager1` / `LEAdvertisingManager1` on `/org/bluez/hci0`.

The GATT service is `7c0e0001-5f3a-4c8e-9d2b-c00e7a000001`. RX, TX, and INFO use the same UUID with the first group ending `0002`, `0003`, and `0004`, respectively. RX accepts write-with-response frames, TX notifies, and INFO is read-only JSON that never contains the key. BlueZ supplies the WriteValue MTU; only a successfully authenticated owner's HELLO commits it to notification framing, starting at ATT's 23-byte floor.

BlueZ calls are bounded because dbus-next has no application-level call timeout of its own: registration uses 10 seconds, owner lookup 3 seconds. Adapter power loss, the existing adapter recovery power-cycle and bluetoothd restarts invalidate registrations. The device/daemon watcher releases ownership and re-registers when BlueZ returns; a 15-second supervisor also retries while unregistered. Registration generation checks keep an old callback from reviving replaced state.

## Existing deployment limits

- Android/Bluefy hosted loading still needs reception before entering the garage: there is no service worker. Load the page while online and keep it open. The [iOS app](ios-app.md) has a bundled dashboard for offline loading.
- `params.html` is a separate page load and does not inherit the current BLE connection; fetching the parameter table there over BLE remains unsupported.
- Simultaneous hub-central and dashboard-peripheral roles on the Zero 2 W, throughput with WiFi, and real phone behavior remain unverified. The existing adapter wedge/recovery history is in [ble-adapter-wedge.md](ble-adapter-wedge.md).

## Owner and recovery

A valid proof selects the device owner and its MTU. Foreign data frames cannot change either or interrupt assembly. A foreign HELLO's proof is checked **before** any owner-liveness read. Wrong proofs issue no read and cannot release the owner. Only a correct proof can trigger the single bounded `Device1.Connected` read (3 s). A live owner yields a correlated “another phone is connected” advisory. An absent/disconnected owner, read error, or timeout releases stale ownership; generations are rechecked before committing the new session. Same-path re-HELLO supports a page reload.

Device disconnection/removal, adapter loss, bluetoothd name-owner changes, and registration replacement invalidate ownership. Aggregate StopNotify is insufficient: another subscriber can keep it from firing when the owner leaves. Old async proof/decryption/response work cannot commit into a new generation.

There is one HELLO path through the server's complete-frame handler. The owner cannot smuggle a multipart clear HELLO through the sealed-message receiver: accepting it there would skip ownership, stream and queue bookkeeping. A successful replacement stops the old stream and clears frames encrypted under the old key before queuing the new WELCOME.

Chrome can return the same characteristic object on reconnect, so the browser's WeakSet attaches one notification listener per object; duplicates would feed every frame through the assembler twice. Stream close is idempotent and also reports an attempt that never opened, keeping the connection policy on one cleanup path. With no chosen device it reports close asynchronously, in the same order as a failed socket connection. The phone's 12-second silence check counts **all successfully authenticated messages**, including download responses, not only telemetry. If none arrives, it drops crypto/session state while retaining the selected device and GATT link. Fresh read/write chains prevent a stuck old write from blocking the next HELLO. The existing connection retry reads fresh INFO and re-authenticates; this also recovers when a service restart leaves the radio connection up.

Each request's 195-second inactivity deadline advances only on matching authenticated HEAD/BODY progress. Unrelated telemetry cannot keep a missing END pending forever; a progressing download can last longer than 195 seconds overall. END/error/disconnect/timeout releases the entry, parts, and timer. A lost response means a write's outcome may be unknown: check status before repeating it. The transport never replays that operation.

## Address privacy is optional and remains off pending hardware verification

Removing LocalName reduces advertised identifying text; the fixed service UUID still identifies the application class. This does not make the bike untrackable. Address privacy is **not a setup prerequisite**, and the service neither enables nor probes it or presents its absence as a fault.

BlueZ's optional `Privacy = device` mode uses resolvable private addresses. Linux's default RPA expiry is **15 minutes**. These unpaired phone links do not distribute the Pi's IRK to the phone, so a rotated address can strand the saved device selection. The current reconnect has no connect deadline; after losing the selected device, Connect retries it rather than reopening the chooser. A reload/app restart and a new selection may be needed. This reconnect trade-off must be tested in both the iOS app and Chrome.

Privacy also changes the Pi's outbound address when connecting to the Connectivity Hub. Whether the hub's single authorised-device slot accepts that rotation is unverified. The existing enrolment fallback may replace the slot, and undoing that requires clearing it from the bike's physical dashboard. Keep privacy **off** until a separately authorised hardware test confirms both phone reconnection after a forced/waited rotation and hub reconnect/session confirmation across rotation **without re-enrolment fallback**. This lane makes no adapter/configuration writes and performs no hardware test.

Source read for these constraints: BlueZ [long-write aggregation and notification construction](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/src/shared/gatt-server.c), [notification fan-out and aggregate subscription lifecycle](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/src/gatt-database.c), Linux v6.12 [advertising/connection address selection](https://github.com/torvalds/linux/blob/v6.12/net/bluetooth/hci_sync.c) and [default RPA expiry](https://github.com/torvalds/linux/blob/v6.12/include/net/bluetooth/hci_core.h#L329), and this repo's `src/ble/client.ts` enrolment path. Installed Pi behavior, address rotation, and simultaneous radio roles remain unmeasured.

## Local checks

`scripts/check-ble-wire.ts`, `check-ble-server.ts`, `check-ble-hardening.ts`, `check-ble-client.ts`, and `check-ble-gatt.ts` run without D-Bus, a physical radio, or a bike. They exercise real server/browser/session/watcher/export code through fake platform boundaries, with synthetic keys, bytes, device paths, and loopback handlers. Mutation receipts demonstrate that the security assertions reject their intended regressions. Physical throughput, iPhone behavior, and radio coexistence still require separately authorised deployment verification.
