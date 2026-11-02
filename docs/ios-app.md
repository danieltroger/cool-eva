# The iOS app

A small native shell for the iPhone: the dashboard in `public/`, bundled into the app so it opens with no reception, talking to the Pi over Bluetooth. It is the iPhone's answer to [the dashboard over BLE](ble-server.md). Safari has no Web Bluetooth, and a page cannot be loaded over BLE in the first place, so a browser can only reach the Pi's BLE server from a page it already got over a network. The app removes both problems.

It is **not** a second dashboard. Every view, the wire protocol and the session crypto are the same `public/` files the Pi serves over wifi. The app adds three things: a way to load them from its own bundle, Bluetooth for the page, and a share sheet for saved files. Change the dashboard and the app picks the change up at its next build.

Source: `ios/`. Open `ios/CoolEva.xcodeproj` in Xcode 26 or later.

## Running it

1. **Signing.** Create `ios/Config/Signing.local.xcconfig` (gitignored) with your team:

   ```
   DEVELOPMENT_TEAM = ABCDE12345
   // Free Apple accounts: bundle ids are claimed per account, so pick your own
   PRODUCT_BUNDLE_IDENTIFIER = com.yourname.cool-eva
   ```

   Your team id is in Xcode → Settings → Accounts, or at developer.apple.com → Membership. Do **not** set it in the target's _Signing & Capabilities_ pane: that writes it into `project.pbxproj`, which is committed to a public repo.

2. Plug the iPhone in, choose it as the run destination, and press Run. The first install needs the phone's _Settings → General → VPN & Device Management_ to trust your developer certificate, and _Developer Mode_ on.

3. In the app, open the menu, enter the Pi's `BLE_SECRET` under _Bluetooth_, and tap _Connect_. A sheet lists every Pi advertising the dashboard service; pick yours. iOS asks for Bluetooth permission the first time.

**Free vs paid account.** A free Apple ID works, but the app it installs expires after **7 days** and must be re-run from Xcode. A paid developer account ($99/yr) makes installs last a year and allows TestFlight, so updates need no cable. Nothing in the project depends on which you use; only `Signing.local.xcconfig` changes.

**Updating the dashboard on the phone** means rebuilding the app: `public/` is copied in at build time, as a folder reference to `../public`. A `git pull` on the Pi updates the Pi, not the app.

## How it works

| file | does |
| --- | --- |
| `ios/CoolEva/BundleSchemeHandler.swift` | serves the bundled `public/` as `cooleva://app/…` |
| `ios/CoolEva/web-bluetooth-shim.js` | the slice of `navigator.bluetooth` that `public/lib/ble-link.js` uses, plus `window.coolEvaNative`; injected before any module runs |
| `ios/CoolEva/BleBridge.swift` | CoreBluetooth behind the shim: scan, connect, read, write-with-response, notify; and the share sheet |
| `ios/CoolEva/DevicePickerView.swift` | the stand-in for Chrome's device chooser |
| `ios/CoolEva/Diagnostics.swift` | logs what the page can do, and forwards page errors to the device log |

### Loading the page

From a **custom scheme**, not `loadFileURL`. WebKit gives a `file://` page an opaque origin, and an opaque origin refuses ES module imports; the dashboard is nothing but ES modules. Under `cooleva://` the page is a **secure context** with `crypto.subtle` and `CompressionStream`, which the BLE session's sealing needs. This was measured, not assumed: the simulator's capability line reads `"secureContext":true,"subtle":true,"compression":true`. The handler serves `.js` as `text/javascript`, because WebKit refuses a module script with any other type.

### Bluetooth for the page

`public/lib/ble-link.js` runs **unchanged**. The shim gives it a `navigator.bluetooth` with exactly the shape its typedefs describe. Every call goes to Swift through a reply-capable `WKScriptMessageHandlerWithReply`, so each one is a promise. Swift rejects with `"<ErrorName>: <message>"`, which the shim rethrows as a `DOMException` of that name. That is how `ble-link.js` still tells a dismissed chooser (`NotFoundError`) from a fault. Notifications come back through `callAsyncJavaScript` as `characteristicvaluechanged` events on the same characteristic object every time, because `ble-link.js` keys its listener on identity.

The page knows it is in the app because `window.coolEvaNative` exists. That puts it in BLE mode (`BLE_MODE` in `ble-link.js`), and `download()` in `public/lib/transport.js` hands files to `coolEvaNative.saveFile`. WKWebView ignores `<a download>` on a blob, so the ride log and the parameter CSV go to the iOS share sheet instead: Save to Files, or AirDrop to the laptop.

## Diagnostics

Every page load prints one line to the device log:

```
cool-eva: capabilities {"href":"cooleva://app/index.html","secureContext":true,"subtle":true,"compression":true,"bluetooth":true,"nativeShell":true}
```

Any `false` there explains a link that never connects. Uncaught page errors and failed module loads are printed as `cool-eva[page]: …`. In a Debug build the web view is inspectable from Safari → Develop on the Mac.

In the **simulator**, which has no Bluetooth, the app also calls `requestDevice` once and logs the answer. It must read `NotSupportedError: Bluetooth is unavailable (state 2)`, which proves the JS → Swift → JS round trip and the error-name mapping without a phone.

## Known gaps

- **Untested on a phone.** Everything Bluetooth-side has only been exercised as far as the simulator allows. The first real run is the test.
- **`params.html`** is a separate page load. The native side keeps the peripheral connected, but the page's session and device choice reset, so the parameter table cannot load over BLE yet.
- **No background link.** When the app is backgrounded the page goes hidden and unsubscribes, exactly as on wifi; nothing streams while the phone is locked.
- **The ☰ menu icon** rendered as a missing-glyph box in the simulator, so does the same in the plain dashboard there. It is probably a simulator font gap; check it on the phone.
