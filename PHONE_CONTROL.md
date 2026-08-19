# Driving the phone from the bike

Can a handlebar button make the mounted iPhone do something — take a photo, run a shortcut, change what is on screen?

Researched 2026-08-19 against iOS 26.6. Sourced from Apple's own documentation and WebKit source where possible; forum-sourced claims are marked. **Nothing here has been tested on the bike yet.** The untested parts are listed at the bottom, because several of them are the ones that decide whether any of this works in practice.

The Pi already decodes handlebar buttons off the CAN bus in real time, joins the phone's Personal Hotspot, and has Bluetooth. So the bike side is solved; every open question is about what iOS will accept.

---

## The ceiling, stated first

**Nothing produces a photo, or opens an app, on a locked or sleeping phone.**

Apple, [Run shortcuts with Siri](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/9.0/ios/26):

> When your device is locked and you run a shortcut that opens an app, Siri asks to unlock your device before continuing.

It is not deferred and it is not silent — you get a prompt you must tap, and then unlock. In a full-face helmet Face ID will not rescue you.

**No documented way was found for a BLE HID keypress to even wake the display.** That is the single biggest unknown here and it needs a physical phone, not more searching.

So everything below assumes the phone is **mounted, unlocked and awake**, which on this bike it usually is.

---

## Options, fewest rider interactions first

### 1. Leave the Camera app open — no Shortcuts at all

Guided Access pinning Camera, Auto-Lock off, phone mounted and charging. The Pi presents as a BLE HID keyboard and sends **Volume Up**, which iOS maps to the shutter.

Zero interaction, zero latency, nothing to configure in Shortcuts, works today. **Cost:** the screen shows Camera, not the dashboard.

### 2. Bluetooth-connect automation → Take Photo

The reframe that makes most of the complexity disappear: **do not open the Camera app.** Shortcuts' **Take Photo** action has a _Show Camera Preview_ toggle, and with preview off it captures directly.

    Bluetooth connect → (Ask Before Running off) → Take Photo → Save to Album

No Camera app, no HID keyboard, no volume-up — and no connect-versus-stay- connected conflict, because there is no HID link to keep alive.

**It can run unattended.** Apple, [Enable or disable a personal automation](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/9.0/ios/26), lists Bluetooth among the automations that can run automatically, and _"The automation will not notify you when it's triggered."_ Note this **corrects a lot of older advice** — it was genuinely tap-only through roughly iOS 17, so forum posts saying otherwise are stale rather than wrong-at-the-time.

⚠️ **The device picker is buggy.** Most users see keyboards, mice and controllers, but a long-standing unfixed bug shows _audio devices only_ on some phones (reported 2022, still present May 2025 — forum-sourced). A Satechi presentation remote, i.e. exactly the BLE HID class the Pi would present as, was not listed for one reporter. "Any Device" is the documented escape hatch but fires on the helmet intercom too. Also: iOS 26 regression reports of the Bluetooth trigger not firing at all.

### 3. BLE HID _mouse_ → AssistiveTouch Hot Corners

The cleanest answer to "a connected device generates no connect events". A composite HID device is **both keyboard and mouse**, so this coexists with the volume-up shutter with **no connect/disconnect cycling at all**.

Apple, [Use AssistiveTouch](https://support.apple.com/guide/iphone/use-assistivetouch-iph96b21954/ios): Hot Corners can _"take a screenshot, open Control Center, activate Siri, scroll, or **use a shortcut**"_, and _"Devices: Pair or unpair devices and **customize buttons**."_

### 4. Pure HID: `Cmd+Space`, type "camera", `Return`

Uses the keyboard already emulated for the shutter. [Command-Space opens Search](https://support.apple.com/guide/iphone/use-shortcuts-iph3da414515/26/ios/26) and [Search runs shortcuts by name](https://support.apple.com/guide/shortcuts/run-shortcuts-from-the-search-screen-apd8a8ffb4ac/9.0/ios/26) are both documented. The "Return launches the top hit" half is blog-sourced — test it.

### 5. The dashboard itself → a URL scheme

Fits the existing architecture: the rider already has a page from the Pi on screen, and a WebSocket message could make it navigate.

Apple sanctions the pattern — [Run a shortcut from a URL](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios): _"URL schemes can be used anywhere a URL can be used—your own app, **in a web browser**, or in the command line."_ So `shortcuts://run-shortcut?name=X`.

**Does it need a user gesture?** Read out of WebKit `main`: `ScheduledURLNavigation` — what `location.href = …` becomes — takes its policy from `initiatingDocument.shouldOpenExternalURLsPolicyToPropagate()`, i.e. the document's **inherited** policy, not a live gesture check (`Source/WebCore/loader/FrameLoader.cpp`). A page the rider opened by tapping a link, bookmark or Home Screen icon therefore carries `ShouldAllow` for its whole lifetime, and a later gestureless navigation from a WebSocket handler passes WebCore's gate. That is **stronger than the HTML spec's "sticky activation"** — it is document-lifetime.

⚠️ That is only the WebCore gate. **Safari's UI process is closed source** and iOS is known to show an _"Open in…"_ confirmation under conditions that could not be pinned down. Test before designing around it.

---

## Negative results

Recorded so nobody re-derives them.

- **There is no `camera://` URL scheme.** Apple's reference covers `mailto`, `tel`, `facetime`, `sms`, `maps` and iTunes links only. `photos-redirect://` opens Photos, not Camera.
- **No native inbound network trigger for Shortcuts exists.** The Pi cannot simply POST at the phone.
- **NFC is a dead end here**, despite supporting Run Immediately: a _mounted_ phone cannot be tapped against a tag, and background tag reading fires on entry rather than continuously.
- **Switch Control has no "Open App" or "Run Shortcut" action.** BLE HID keyboards do register as External switches, but Siri is the only useful hook. One untested loophole survives: Switch Control runs on the Lock Screen, and Apple documents _"Open Camera: Swipe left"_ there without unlocking.
- **Full Keyboard Access** customisation is key _rebinding_ onto a fixed command set. No Open App, no Run Shortcut.
- **CarPlay** supports Run Immediately and is more reliable than Bluetooth, but wireless CarPlay needs an MFi coprocessor — not realistic for a Pi. A Pi _can_ present as a Bluetooth car kit (A2DP/HFP), which could drive Driving Focus → a Focus automation. Every link is documented; the chain is untested.
- **HomeKit / Home Assistant automations cannot open apps.**
- **`getUserMedia` in the dashboard needs a secure context**, which a plain-HTTP Pi does not have. The only fully-offline fix is a private root CA plus a `.local` name via Avahi, trusted on the phone — mDNS is link-local so it resolves over the hotspot with cellular off. Note the **825-day certificate lifetime limit applies to your own private CA too** (825 works, 826 fails in Safari), and Safari reportedly refuses WSS to a bare IP, so use a hostname.

## One correction to an assumption in the project

The hotspot has no upstream **from the Pi's side**, but **the phone has cellular** — so a cloud round-trip (Pi → hotspot → phone's cellular → APNs → phone) is available whenever there is signal. That re-opens push services as a trigger path, which had been written off.

## Coming in iOS 27

An **App Notification** automation trigger, and repeating/interval automations. Broken in beta 3 as of this writing, but it is the shape of the eventual clean answer.

---

## Untested — these decide whether any of it works

1. Whether a BLE HID keypress **wakes the display**. Biggest unknown.
2. Whether this phone's Bluetooth automation picker **lists the Pi** at all.
3. Whether Safari prompts on an app-scheme navigation, and under what conditions.
4. Bluetooth trigger latency, and whether iOS debounces rapid disconnect/reconnect. Estimated 3–10 s per shot, non-deterministic.
5. Whether `Return` launches the top Search hit.
