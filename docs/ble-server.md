# The dashboard over BLE

To connect a phone, follow [connecting-over-bluetooth.md](connecting-over-bluetooth.md). The Pi's GATT server carries the existing dashboard HTTP endpoints and live `DashboardMessage` stream. Endpoint header gates, confirmation tokens, write locks, and audit behavior remain in the existing handlers because requests go through loopback HTTP.

## Key and protocol

`BLE_SECRET` is a generated **32-byte key encoded as 64 lowercase hexadecimal characters**. Generate it once with `openssl rand -hex 32`, store it on the Pi, and paste it into the phone. Onboarding (#317) uses `generateBleSecret()` from `public/lib/ble-secret.js` and persists it; restarting the service or rebuilding the app must not change it. A format validator cannot prove random provenance. Human phrases are rejected before BLE starts, while the rest of telemetry continues.

Unset, BLE stays off and the Pi does not advertise. Keys are never put in URLs or diagnostic messages. Changing the Pi's key and restarting revokes old copies. The phone trims surrounding whitespace and normalizes hex case before validating and saving an entered key; invalid input cannot replace a saved key.

**Protocol 2 requires updating both the Pi and the page/app.** The iOS app bundles `public/` and must be rebuilt; refreshing a hosted page does not update an installed bundle. A version mismatch fails before HELLO.

1. Read INFO: `{ version, serverNonce }`.
2. Send a clear HELLO: `{ version, clientNonce, proof }`. Each nonce is exactly 16 bytes encoded as 32 lowercase hex characters. The proof is HMAC-SHA256 over `"cool-eva/hello" ‖ serverNonce ‖ clientNonce`.
3. Verify the proof without changing any session state. A successful commit derives the AES key with the separate `"cool-eva/session"` HMAC label, rotates the server nonce, and returns a sealed WELCOME. A captured successful HELLO cannot establish another session after `end()`.
4. Later messages use AES-256-GCM over deflate-raw. Direction-specific IVs and strictly increasing authenticated counters reject reflection/replay. There is no forward secrecy.

BlueZ broadcasts notifications to every subscribed device, so possession of the key separates the intended phone from other listeners. The GATT characteristics remain unpaired (`read`, `write`, `notify`, without `encrypt-*`). A clear REFUSED includes the HELLO's client nonce; it is an advisory for that pending attempt, never proof that a key is invalid. An established phone ignores clear refusals. There is no credential blacklist or wrong-HELLO lockout; generated keys remove the reason to tolerate guessable phrases. Existing browser connection policy paces retries, and requests that might have written are never automatically resent by the BLE transport.

## Hosted pages and origin isolation

The hosted dashboard is enabled at **`https://danieltroger.github.io/cool-eva/`**. This is safe for persisted keys only while **no other GitHub Pages site is served from that account**. The account currently serves only Cool Eva. Browser localStorage is shared by **origin**, not by project path: another Pages project on `https://danieltroger.github.io` could read the stored key. Keep that other-site condition true; if it changes, move the dashboard to an exclusive origin and rotate previously exposed keys.

The exact HTTPS origin allowlist is committed in **`public/lib/ble-origin.js`**. Fork owners add their own exact origin (for example, `https://your-exclusive-host.example`) only when that whole origin is dedicated to the dashboard. Use `new URL(yourDashboardURL).origin` to identify it; do not include `/cool-eva/` or use a wildcard. An account Pages origin is suitable only when that account has no other Pages site. No build step or runtime environment variable is involved.

On an unlisted HTTPS host the page says **“Bluetooth needs its own address”**, offers no BLE connection or key form, and removes the legacy key from that origin without reading it. Namespacing a storage key or using a different project path does not isolate it. The genuine bundled `cooleva://app/` URL with its native bridge is allowed separately; custom-scheme origins may serialize as `null`, so protocol and host are checked directly. Explicit `?transport=ble` on localhost is supported for development. A native-bridge object on an unlisted HTTPS page cannot bypass the gate.

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

Notifications use **`min(owner MTU − 5, 512)`** bytes per value: 18 at MTU 23, 180 at MTU 185, and 512 at MTU 517. MTU−5 accounts for BlueZ's multiple-notification format as well as ordinary notifications. Clear refusals use the default-MTU bound without changing the owner's MTU.

| resource                               | bound                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| queued output, including frame headers | 128 KiB; whole-envelope rejection                        |
| pending seals                          | 32                                                       |
| ordered owner inbound work             | 32 envelopes / 128 KiB                                   |
| independent HELLO work                 | 32 envelopes / 128 KiB; each frame ≤512 bytes            |
| concurrent loopback requests           | 6                                                        |
| response body chunk                    | 4 KiB                                                    |
| loopback response timeout              | 180 s                                                    |
| phone request inactivity deadline      | 195 s                                                    |
| clear refusals                         | burst of 4 per 2 s, only while TX is notifying           |
| rejected-input diagnostics             | one summary per 2 s, with final suppressed count on stop |

Response producers await sealing/enqueue and pause above a 32 KiB output high-water mark. Output overflow ends that session rather than emitting a partial envelope. Unsubscribe/stop clears output and stops pacing even if no phone authenticated. There is no unauthenticated refusal backlog to replay when a subscriber appears.

The 24 kB/s pacing is an **unmeasured** starting value. It bounds application emission, not bluetoothd's hidden radio backlog. Framing checks at MTU 23 do not establish achievable throughput. WiFi and the existing hub connection share the adapter.

Telemetry still coalesces patches over 100 ms, sheds them above 16 KiB queued, and enqueues a heartbeat snapshot every 5 seconds. Those are enqueue intervals; a slow radio can delay their arrival. Authenticated response messages therefore count toward liveness independently of snapshots.

The GATT service is `7c0e0001-5f3a-4c8e-9d2b-c00e7a000001`. RX, TX, and INFO use the same UUID with the first group ending `0002`, `0003`, and `0004`, respectively. RX accepts writes, TX notifies, and INFO is read-only. BlueZ registration calls are bounded at 10 seconds; a 15-second supervisor retries failed registration, alongside explicit adapter/daemon lifecycle signals.

## Existing deployment limits

- Android/Bluefy hosted loading still needs reception before entering the garage: there is no service worker. Load the page while online and keep it open. The [iOS app](ios-app.md) has a bundled dashboard for offline loading.
- `params.html` is a separate page load and does not inherit the current BLE connection; fetching the parameter table there over BLE remains unsupported.
- Simultaneous hub-central and dashboard-peripheral roles on the Zero 2 W, throughput with WiFi, and real phone behavior remain unverified. The existing adapter wedge/recovery history is in [ble-adapter-wedge.md](ble-adapter-wedge.md).

## Owner and recovery

A valid proof selects the device owner and its MTU. Foreign data frames cannot change either or interrupt assembly. A foreign HELLO's proof is checked **before** any owner-liveness read. Wrong proofs issue no read and cannot release the owner. Only a correct proof can trigger the single bounded `Device1.Connected` read (3 s). A live owner yields a correlated “another phone is connected” advisory. An absent/disconnected owner, read error, or timeout releases stale ownership; generations are rechecked before committing the new session. Same-path re-HELLO supports a page reload.

Device disconnection/removal, adapter loss, bluetoothd name-owner changes, and registration replacement invalidate ownership. Aggregate StopNotify is insufficient: another subscriber can keep it from firing when the owner leaves. Old async proof/decryption/response work cannot commit into a new generation.

The phone's 12-second silence check counts **all successfully authenticated messages**, including download responses, not only telemetry. If none arrives, it drops crypto/session state while retaining the selected device and GATT link. Fresh read/write chains prevent a stuck old write from blocking the next HELLO. The existing connection retry reads fresh INFO and re-authenticates; this also recovers when a service restart leaves the radio connection up.

Each request's 195-second inactivity deadline advances only on matching authenticated HEAD/BODY progress. Unrelated telemetry cannot keep a missing END pending forever; a progressing download can last longer than 195 seconds overall. END/error/disconnect/timeout releases the entry, parts, and timer. A lost response means a write's outcome may be unknown: check status before repeating it. The transport never replays that operation.

## Address privacy is optional and remains off pending hardware verification

Removing LocalName reduces advertised identifying text; the fixed service UUID still identifies the application class. This does not make the bike untrackable. Address privacy is **not a setup prerequisite**, and the service neither enables nor probes it or presents its absence as a fault.

BlueZ's optional `Privacy = device` mode uses resolvable private addresses. Linux's default RPA expiry is **15 minutes**. These unpaired phone links do not distribute the Pi's IRK to the phone, so a rotated address can strand the saved device selection. The current reconnect has no connect deadline; after losing the selected device, Connect retries it rather than reopening the chooser. A reload/app restart and a new selection may be needed. This reconnect trade-off must be tested in both the iOS app and Chrome.

Privacy also changes the Pi's outbound address when connecting to the Connectivity Hub. Whether the hub's single authorised-device slot accepts that rotation is unverified. The existing enrolment fallback may replace the slot, and undoing that requires clearing it from the bike's physical dashboard. Keep privacy **off** until a separately authorised hardware test confirms both phone reconnection after a forced/waited rotation and hub reconnect/session confirmation across rotation **without re-enrolment fallback**. This lane makes no adapter/configuration writes and performs no hardware test.

Source read for these constraints: BlueZ [long-write aggregation and notification construction](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/src/shared/gatt-server.c), [notification fan-out and aggregate subscription lifecycle](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/src/gatt-database.c), Linux v6.12 [advertising/connection address selection](https://github.com/torvalds/linux/blob/v6.12/net/bluetooth/hci_sync.c) and [default RPA expiry](https://github.com/torvalds/linux/blob/v6.12/include/net/bluetooth/hci_core.h#L329), and this repo's `src/ble/client.ts` enrolment path. Installed Pi behavior, address rotation, and simultaneous radio roles remain unmeasured.

## Local checks

`scripts/check-ble-wire.ts`, `check-ble-server.ts`, `check-ble-hardening.ts`, `check-ble-client.ts`, and `check-ble-gatt.ts` run without D-Bus, a physical radio, or a bike. They exercise real server/browser/session/watcher/export code through fake platform boundaries, with synthetic keys, bytes, device paths, and loopback handlers. Mutation receipts demonstrate that the security assertions reject their intended regressions. Physical throughput, iPhone behavior, and radio coexistence still require separately authorised deployment verification.
