# Driving the phone from the bike

Can a handlebar button make the mounted iPhone do something — take a photo, run a shortcut, change what is on screen?

Researched 2026-08-19 against iOS 26.6. Sourced from Apple's own documentation and WebKit source where possible; forum-sourced claims are marked. **Nothing here has been tested on the bike yet.** The untested items are listed at the bottom, and several of them decide whether any of this is usable.

## The setup, because it rules a lot in and out

- The Pi decodes handlebar buttons off the CAN bus in real time.
- **The phone is normally UNLOCKED and mounted**, and the rider already uses Siri by voice ("open maps", "open safari"). Most advice online is organised around the lock screen; **that constraint does not apply here** and options should not be ranked by it.
- **The Pi has internet.** It joins the phone's Personal Hotspot, whose upstream is the phone's own cellular. Pi → cloud → phone works whenever there is signal.
- The Pi can present as a Bluetooth device (HID keyboard, HID mouse, or a plain BLE peripheral), and can switch a relay.
- **Anything the dashboard page can already do is solved** — the Pi→page channel exists and handlebar gestures ship today. The whole question below is only about things a _web page_ cannot do: opening a native app, taking a photo, starting a recording.

## The one hard ceiling

**Nothing produces a photo, or opens an app, on a locked or sleeping phone.** Apple, [Run shortcuts with Siri](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/9.0/ios/26): _"When your device is locked and you run a shortcut that opens an app, Siri asks to unlock your device before continuing."_ Not deferred, not silent.

**No documented way was found for a BLE HID keypress to wake the display** — the biggest untested unknown, and one only a physical phone settles.

Neither binds a rider who keeps the phone awake on the mount. They matter if you ever want this to work from a pocket.

---

## Ranked by repeatability

The rider's real requirement: press a button many times in a ride, something happens each time, promptly.

### 1. AssistiveTouch Hot Corners, driven by a composite BLE HID mouse

No cloud, no re-arm, no trigger, latency in milliseconds. A composite HID device is **both keyboard and mouse**, so this coexists with a volume-up shutter with no connect/disconnect cycling. Apple, [Use AssistiveTouch](https://support.apple.com/guide/iphone/use-assistivetouch-iph96b21954/ios): Hot Corners can _"take a screenshot, open Control Center, activate Siri, scroll, or **use a shortcut**"_.

**Nothing in the trigger inventory beats this.**

### 2. Charger trigger, both edges, via a Pi-switched relay

The structural fact that makes this work: **Bluetooth and Wi-Fi are the only connect-type triggers Apple gives no disconnect edge to. Charger has both.** That asymmetry is exactly why Bluetooth feels un-repeatable.

Bind _Is Connected_ and _Is Disconnected_ to the same shortcut and **every relay toggle produces exactly one run** — no re-arm, no cloud, no cellular, no per-message cost, ~1–2 s. The phone is already mounted and charging.

Unknowns: whether iOS debounces fast cycles, and a mild battery-health cost from repeated charge interruption.

### 3. Message trigger via an SMS API

Apple documents **Sender** and **Message Contains** filters, ANDed, and it runs unattended. Apple's wording says "message" with **no iMessage qualifier**, and the trigger belongs to Messages, which also receives SMS/MMS/RCS — so an SMS from a Twilio/Vonage/46elks number should fire it. _Medium-high confidence; this is the single most valuable thing to test on a real phone._

That makes the Pi's inability to send iMessage irrelevant. Discrete event per press, no re-arm, filters by sender. Latency seconds to tens of seconds; per-message cost; carrier A2P filtering may throttle repeated identical bodies, so vary them; dead in a coverage hole.

### 4. Email trigger — only with a push mailbox

Same shape, but conditional on a mailbox property, which makes it strictly worse than SMS. See the fetch trap below.

### 5. Bluetooth connect

Works and runs unattended, but **one edge only**, so re-arming needs a disconnect/reconnect and iOS reconnect backoff makes the interval non-deterministic. ⚠️ The device picker is also buggy — a long-standing unfixed bug shows _audio devices only_ on some phones (forum-sourced, reported 2022, still seen May 2025), and a presentation remote of exactly the class the Pi would present as was not listed for one reporter.

### 6. Take Photo without opening Camera

Not a trigger but a reframe worth keeping: Shortcuts' **Take Photo** action has a _Show Camera Preview_ toggle, and with preview off it captures directly. `<trigger> → Take Photo → Save to Album` needs no Camera app, no HID keyboard and no volume-up.

---

## ⚠️ The fetch trap that kills the email path mid-ride

Apple, [support.apple.com/en-us/102578](https://support.apple.com/en-us/102578):

> "If Push isn't available as a setting, your account will default to Fetch." … "**Automatically** is set by default. Your device will fetch new data in the background **only when your device is charging and connected to Wi-Fi**."

On the bike the phone is **on cellular, acting as the access point**. It is not a Wi-Fi _client_ and cannot be while hotspotting over Wi-Fi, so that condition is never satisfied mid-ride even though the phone is charging. **On a fetch-based mailbox the Email trigger will not fire during the ride at all** — the mail arrives in a batch when the phone next sees Wi-Fi at home.

The escape is a **push-capable mailbox set to Push** (iCloud being the obvious one), where APNs delivers over cellular with no fetch involved.

## Pushover: no on iOS 26.6

Three independent ways:

- **No notification-based trigger exists** among the 21 personal-automation triggers, and there is no API for a third-party app to register one.
- Pushover's only Shortcuts integration is [_sending_ notifications **from** Shortcuts](https://support.pushover.net/i44-sending-pushover-notifications-from-shortcuts-on-ios) — an **action**, one-directional.
- **Pushcut**, which gets closest, is ruled out by its own docs: _"the Pushcut Automation server can only process requests while in the foreground (ie: the Pushcut app must be visible on the screen)… intended to run on a dedicated, always-on iOS device."_ A phone showing the dashboard or Maps cannot run it. Also 100 requests/day free, sequential, 5-minute expiry.

**On the iOS 27 beta: probably yes, but do not install a beta on the bike's phone for it.** The trigger is real — Apple's beta-4 feature list includes _"Screenshot and notification automations in Shortcuts"_, filtering on App plus Title/Message. It was broken in developer beta 1 (blog-sourced). Apple's own **beta 6 release notes** contain one automation entry (a Focus-migration fix) and **no open Known Issue for Shortcuts automations**, which is evidence the early breakage is no longer tracked but is _not_ positive confirmation the chain works. Apple has published no iOS 27 Shortcuts guide, so there is no statement on whether it supports Run Immediately. iOS 27 ships in weeks and the same outcome is available on 26.6 today.

## When the confirmation tap went away

Dated from Apple's own page via the Wayback Machine, because a lot of stale advice hangs on this. In the **5 Sept 2023** snapshot, _Arrive, Leave, Before I Commute, Email, Message, Wi-Fi and Bluetooth_ were all in the **cannot run automatically** list. By **10 Nov 2023** all except _Before I Commute_ had moved to **can**. So the change is **iOS 17**, and the list has been unchanged from Nov 2023 through today. **iOS 26 added no new personal-automation triggers.**

_Before I Commute_ remains the only trigger that cannot run automatically.

---

## Negative results

Recorded so nobody re-derives them.

- **There is no `camera://` URL scheme.** Apple's reference covers `mailto`, `tel`, `facetime`, `sms`, `maps` and iTunes links only. `photos-redirect://` opens Photos, not Camera.
- **NFC is a dead end here** despite supporting Run Immediately: a _mounted_ phone cannot be tapped against a tag, and background tag reading fires on entry rather than continuously.
- **Switch Control has no "Open App" or "Run Shortcut" action.** BLE HID keyboards do register as External switches, but Siri is the only useful hook. One untested loophole: Switch Control runs on the Lock Screen, and Apple documents _"Open Camera: Swipe left"_ there without unlocking.
- **Full Keyboard Access** customisation is key _rebinding_ onto a fixed command set.
- **CarPlay** supports Run Immediately but wireless CarPlay needs an MFi coprocessor. A Pi _can_ present as a Bluetooth car kit (A2DP/HFP), which could drive Driving Focus → a Focus automation. Documented links, untested chain.
- **HomeKit / Home Assistant automations cannot open apps.**
- **The Wi-Fi trigger is useless here** — it fires on _joining_ a network, and the phone is the access point, not a client.
- **`getUserMedia` in the dashboard needs a secure context**, which a plain-HTTP Pi does not have. The only fully-offline fix is a private root CA plus a `.local` name via Avahi, trusted on the phone — mDNS is link-local, so it resolves over the hotspot with cellular off. Note the **825-day certificate lifetime limit applies to your own private CA too** (825 works, 826 fails in Safari), and Safari reportedly refuses WSS to a bare IP, so use a hostname.

### One negative result that was wrong

An earlier version of this file said _"No native inbound network trigger for Shortcuts exists. The Pi cannot simply POST at the phone."_ **That is wrong.** **Email and Message are inbound-network triggers in all but name** — both documented Run-Immediately, both with sender filtering. The Pi cannot POST directly at the phone, but it can cause a message to arrive, which is the same thing with a cloud hop and the conditions above.

## The dashboard → URL scheme path

Apple sanctions it — [Run a shortcut from a URL](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios): _"URL schemes can be used anywhere a URL can be used—your own app, **in a web browser**, or in the command line."_ So `shortcuts://run-shortcut?name=X` from the page the rider already has open.

**Does it need a user gesture?** Read out of WebKit `main`: `ScheduledURLNavigation` — what `location.href = …` becomes — takes its policy from `initiatingDocument.shouldOpenExternalURLsPolicyToPropagate()`, i.e. the document's **inherited** policy, not a live gesture check (`Source/WebCore/loader/FrameLoader.cpp`). A page opened by tapping a link, bookmark or Home Screen icon carries `ShouldAllow` for its whole lifetime, so a later gestureless navigation from a WebSocket handler passes WebCore's gate. That is **stronger than the HTML spec's sticky activation** — it is document-lifetime.

⚠️ That is only the WebCore gate. **Safari's UI process is closed source** and iOS is known to show an _"Open in…"_ confirmation under conditions that could not be pinned down.

## Coming in iOS 27

An **App Notification** automation trigger and repeating/interval automations. That is the eventual clean answer to the Pushover question.

---

## Untested — these decide whether any of it works

1. **Does the Message trigger fire on a plain SMS** (not iMessage)? Decides the best cloud path available today.
2. Does iOS **debounce rapid Charger connect/disconnect**, and what is the minimum reliable toggle period? Decides the best local path.
3. Whether a BLE HID keypress **wakes the display**.
4. Whether this phone's Bluetooth automation picker **lists the Pi** at all.
5. Message-trigger end-to-end latency on cellular while hotspotting.
6. Whether the **Email** trigger fires promptly with iCloud Push while hotspotting.
7. Whether Safari prompts on an app-scheme navigation, and under what conditions.
8. iOS 27 only: whether a Pushover notification actually fires the notification automation, whether title/body filtering works, and whether quiet delivery, Scheduled Summary or a Focus suppress it.
