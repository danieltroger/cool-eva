# Driving the phone from the bike

Can a handlebar button make the mounted iPhone do something — take a photo, run a shortcut, change what is on screen?

Researched 2026-08-19 against iOS 26.6. Sourced from Apple's own documentation and WebKit source where possible; forum-sourced claims are marked. **Nothing here has been tested on the bike yet.** The untested items are listed at the bottom, and several of them decide whether any of this is usable.

## The setup, because it rules a lot in and out

- The Pi decodes handlebar buttons off the CAN bus in real time.
- **The phone is normally UNLOCKED and mounted**, and the rider already uses Siri by voice ("open maps", "open safari"). Most advice online is organised around the lock screen; **that constraint does not apply here** and options should not be ranked by it.
- **The Pi has internet.** It joins the phone's Personal Hotspot, whose upstream is the phone's own cellular. Pi → cloud → phone works whenever there is signal.
- The Pi can present as a Bluetooth device (HID keyboard, HID mouse, or a plain BLE peripheral), and can switch a relay.
- **Anything the dashboard page can already do is solved** — the Pi→page channel exists and handlebar gestures ship today. The whole question below is only about things a _web page_ cannot do: opening a native app, taking a photo, starting a recording.

## Ranked by repeatability

The rider's real requirement: press a button many times in a ride, something happens each time, promptly. Ranked by how well documented that repeatability is, which is not the same as how good each one would be if it works.

### 1. Charger trigger, both edges, via a Pi-switched relay

The structural fact that makes this work: **Bluetooth and Wi-Fi are the only connect-type triggers Apple gives no disconnect edge to. Charger has both.** That asymmetry is exactly why Bluetooth feels un-repeatable.

Bind _Is Connected_ and _Is Disconnected_ to the same shortcut and **every relay toggle produces exactly one run** — no re-arm, no cloud, no cellular, no per-message cost, ~1–2 s. The phone is already mounted and charging.

Unknowns, both stated: whether iOS debounces fast cycles, and a mild battery-health cost from repeated charge interruption.

This is first because both of its edges are documented and its unknowns are bounded, not because it is the nicest. If option 2's latency turns out to be what it looks like, option 2 is better — it is below this one because its repeatability rests on behaviour Apple does not document, and the ranking is by documented repeatability.

### 2. AssistiveTouch Hot Corners, driven by a composite BLE HID mouse

No cloud and no trigger to arm, and potentially the lowest latency of anything here. A composite HID device is **both keyboard and mouse**, so this coexists with a volume-up shutter with no connect/disconnect cycling. Apple, [Use AssistiveTouch on iPhone](https://support.apple.com/guide/iphone/use-assistivetouch-iph96b21954/ios), under the heading **Set up Dwell Control**:

> **Hot Corners:** Perform a selected action—such as take a screenshot, open Control Center, activate Siri, scroll, or use a shortcut—when the cursor dwells in a corner of the screen.

⚠️ Read that heading and that verb before building on this. Three things follow, and an earlier draft of this file got all three wrong:

- **The latency is a dwell interval, not milliseconds.** The action fires when the cursor _dwells_, and the same page carries a separate setting, _"Time needed to initiate a dwell action"_. Whatever that is set to is the floor on response time.
- **There is re-arm, it is just spatial.** Firing twice needs the cursor to leave the corner and come back. A relative-motion mouse can do that on its own, so it is workable — but "no re-arm" was wrong.
- **Dwell Control has to be on phone-wide**, which makes the cursor perform an action wherever it comes to rest, on a phone the rider is also using for Maps. That side effect is the real cost of this option and it is not local to the corner.

Also untested: whether this phone will accept the Pi as a BLE HID pointer at all. Option 5 records iOS showing _audio devices only_ in the Bluetooth automation picker and failing to list a presentation remote of exactly the Pi's class — a different picker, but the same family of doubt.

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

## The limits, for the pocket case

Below the ranking on purpose: the phone is normally awake and unlocked on the mount, so neither of these binds the actual rider. They decide whether this could ever work from a pocket.

**A shortcut that opens an app will not run on a locked phone.** Apple, [Use Siri to run shortcuts with your voice](https://support.apple.com/guide/shortcuts/run-shortcuts-with-siri-apd07c25bb38/9.0/ios/26): _"When your device is locked and you run a shortcut that opens an app, Siri asks to unlock your device before continuing."_ Not deferred, not silent.

⚠️ **That is the whole of what the source supports, and it is narrower than it looks.** The sentence is about a shortcut that _opens an app_, run _with Siri_. It says nothing about a shortcut that opens no app — and §6 above argues that `Take Photo` with preview off is exactly that. So the cited sentence does not reach the question in this file's title, and an earlier draft that stretched it to _"nothing produces a photo, or opens an app, on a locked or sleeping phone"_ was asserting the photo half without evidence. **Whether `Take Photo` with preview off runs on a locked phone is unknown, and by the reframe it is now the decisive unknown** — it is item 1 in the untested list.

**No documented way was found for a BLE HID keypress to wake the display.** Only a physical phone settles it, and it sits upstream of everything else in the pocket case: a shortcut that runs on a sleeping phone is still no use if nothing wakes the screen for the parts that need one.

---

## ⚠️ The fetch trap that kills the email path mid-ride

Apple, [support.apple.com/en-us/102578](https://support.apple.com/en-us/102578):

> "If Push isn't available as a setting, your account will default to Fetch." … "**Automatically** is set by default. Your device will fetch new data in the background **only when your device is charging and connected to Wi-Fi**."

On the bike the phone is **on cellular, acting as the access point**. It is not a Wi-Fi _client_ and cannot be while hotspotting over Wi-Fi, so that condition is never satisfied mid-ride even though the phone is charging. **On a fetch-based mailbox the Email trigger will not fire during the ride at all** — the mail arrives in a batch when the phone next sees Wi-Fi at home.

The escape is a **push-capable mailbox set to Push** (iCloud being the obvious one), where APNs delivers over cellular with no fetch involved.

## Pushover: no on iOS 26.6

Three independent ways:

- **No notification-based trigger exists** among the **21** personal-automation triggers Apple documents for iOS 26, and there is no API for a third-party app to register one. Counted off Apple's **five** trigger pages, all served at version `9.0/ios/26`: [Event](https://support.apple.com/guide/shortcuts/event-triggers-apd932ff833f/9.0/ios/26) (5 — Time of Day, Alarm, Sleep, Apple Watch Workout, Sound Recognition), [Travel](https://support.apple.com/guide/shortcuts/travel-triggers-apd8ebfc4e8e/9.0/ios/26) (4 — Arrive, Leave, Before I Commute, CarPlay), [Communication](https://support.apple.com/guide/shortcuts/communication-triggers-apdd711f9dff/9.0/ios/26) (2 — Email, Message), [Transaction](https://support.apple.com/guide/shortcuts/transaction-trigger-apd65c67538a/9.0/ios/26) (1 — When I tap, selecting a card), [Setting](https://support.apple.com/guide/shortcuts/setting-triggers-apde31e9638b/9.0/ios/26) (9 — Wi-Fi, Bluetooth, Focus, Low Power Mode, Battery Level, Charger, NFC, App, Airplane Mode).

  ⚠️ A draft of this file said 21 unsourced, a revision "corrected" it to 20 **with the four page links above as the audit trail**, and the original was right — the Transaction page was simply missed, though the guide's own table of contents lists it and its footer reads _"Previous: Communication triggers / Next: Setting triggers"_. Worth recording because the sourced-but-wrong version was the more dangerous one: showing the working is exactly what stops the next reader checking it. The Transaction trigger is a wallet tap, so it changes no conclusion here — but nothing about the sourcing would have revealed that.

- Pushover's only Shortcuts integration is [_sending_ notifications **from** Shortcuts](https://support.pushover.net/i44-sending-pushover-notifications-from-shortcuts-on-ios) — an **action**, one-directional.
- **Pushcut**, which gets closest, is ruled out by its own docs: _"the Pushcut Automation server can only process requests while in the foreground (ie: the Pushcut app must be visible on the screen)… intended to run on a dedicated, always-on iOS device."_ A phone showing the dashboard or Maps cannot run it. Also 100 requests/day free, sequential, 5-minute expiry.

**On the iOS 27 beta: probably yes, but do not install a beta on the bike's phone for it.** The trigger is real — Apple's beta-4 feature list includes _"Screenshot and notification automations in Shortcuts"_, filtering on App plus Title/Message. It was broken in developer beta 1 (blog-sourced). Apple's own **beta 6 release notes** contain one automation entry (a Focus-migration fix) and **no open Known Issue for Shortcuts automations**, which is evidence the early breakage is no longer tracked but is _not_ positive confirmation the chain works. Apple has published no iOS 27 Shortcuts guide, so there is no statement on whether it supports Run Immediately. iOS 27 ships in weeks and the same outcome is available on 26.6 today.

## When the confirmation tap went away

⚠️ **An earlier draft dated this to iOS 17 from two Wayback snapshots of Apple's page — 5 Sept 2023 and 10 Nov 2023 — and that dating does not survive being re-checked. It is withdrawn.** What the archive actually holds for [create-a-new-personal-automation](https://support.apple.com/guide/shortcuts/create-a-new-personal-automation-apdfbdbd7123/ios):

- There is **no snapshot near 5 Sept 2023.** Between June 2023 and January 2024 the CDX index returns only [`20230628204304`](https://web.archive.org/web/20230628204304/https://support.apple.com/guide/shortcuts/create-a-new-personal-automation-apdfbdbd7123/ios), [`20231106133411`](https://web.archive.org/web/20231106133411/https://support.apple.com/guide/shortcuts/create-a-new-personal-automation-apdfbdbd7123/ios), `20231125133912`, `20231204062258` and `20231208191936`. Both cited dates resolve to the **same** 6 Nov capture, so no comparison between them is possible.
- **Neither capture contains a can/cannot-run-automatically list at all**, and neither does the [intro page](https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios) — its 4 Sept 2023 capture is word-for-word identical to today's live text. The only sentence on the subject, then and now, is: _"After you create a new personal automation, when an event occurs you'll receive a notification asking you to run the automation. You can also edit a personal automation to run without asking."_
- The one thing that _did_ change between the June and November 2023 captures is a single line about the editor ("An empty automation appears" → "Options appear for creating a blank automation, a suggested automation, or use an existing shortcut").

So: **which iOS version dropped the confirmation tap is unknown from Apple's documentation**, and the file no longer claims it. What stands is the behaviour, from the corrections section above — a Bluetooth-connect automation runs without confirmation on iOS 26, and forum advice saying otherwise is stale. That is the part anyone building this needs; the version number was never load-bearing, only satisfying.

**"iOS 26 added no new personal-automation triggers" is likewise unsourced** and stays marked as such: the 21 triggers above are what Apple documents _now_, and no archived list was found to diff them against.

_Before I Commute_ is the one trigger still widely reported as unable to run automatically — **forum-sourced, and not confirmed in Apple's documentation**, which carries no such list. It does not affect anything ranked above.

---

## Negative results

Recorded so nobody re-derives them.

- **Apple documents no `camera://` URL scheme.** [Apple URL Scheme Reference](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/Introduction/Introduction.html) covers `mailto`, `tel`, `facetime`, `sms`, Map, iTunes and YouTube links, and nothing camera-shaped. Stated that way rather than "there is no such scheme", because absence from a list is not nonexistence and this particular list says so itself: _"this document does not describe all URL schemes supported on different Apple platforms."_ It is also an archived document, last updated 2017, so it is weak evidence about iOS 26 specifically. `photos-redirect://` opens Photos, not Camera.
- **NFC is a dead end here** despite supporting Run Immediately: a _mounted_ phone cannot be tapped against a tag, and background tag reading fires on entry rather than continuously.
- **Switch Control has no "Open App" or "Run Shortcut" action.** BLE HID keyboards do register as External switches, but Siri is the only useful hook. ⚠️ An earlier draft added a "Switch Control runs on the Lock Screen" loophole here, citing Apple's _"Open Camera: Swipe left"_. **That was a conflation and is withdrawn.** The quote is real but comes from [Access features from the Lock Screen](https://support.apple.com/guide/iphone/access-features-from-the-lock-screen-iphcd5c65ccf/ios), a page about ordinary gestures which never mentions Switch Control. Going the other way, none of the three Switch Control pages in the iPhone User Guide, nor [the standalone article](https://support.apple.com/en-us/119835), mentions the Lock Screen anywhere in its body. No documentation was found either way, so there is no loophole here to test — only an absence.
- **Full Keyboard Access** customisation is key _rebinding_ onto a fixed command set.
- **CarPlay** supports Run Immediately but wireless CarPlay needs an MFi coprocessor. A Pi _can_ present as a Bluetooth car kit (A2DP/HFP), which could drive Driving Focus → a Focus automation. Documented links, untested chain.
- **HomeKit / Home Assistant automations cannot open apps.**
- **The Wi-Fi trigger is useless here** — it fires on _joining_ a network, and the phone is the access point, not a client.
- **`getUserMedia` in the dashboard needs a secure context**, which a plain-HTTP Pi does not have. The only fully-offline fix is a private root CA plus a `.local` name via Avahi, trusted on the phone — mDNS is link-local, so it resolves over the hotspot with cellular off. Note the **825-day certificate lifetime limit applies to your own private CA too** (825 works, 826 fails in Safari), and Safari reportedly refuses WSS to a bare IP, so use a hostname.

### One negative result that was wrong

An earlier version of this file said _"No native inbound network trigger for Shortcuts exists. The Pi cannot simply POST at the phone."_ **That is wrong.** **Email and Message are inbound-network triggers in all but name** — both documented Run-Immediately, both with sender filtering. The Pi cannot POST directly at the phone, but it can cause a message to arrive, which is the same thing with a cloud hop and the conditions above.

## The dashboard → URL scheme path

Apple sanctions it — [Run a shortcut from a URL](https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios): _"URL schemes can be used anywhere a URL can be used—your own app, **in a web browser**, or in the command line."_ So `shortcuts://run-shortcut?name=X` from the page the rider already has open.

**Does it need a user gesture?** Read out of WebKit at commit [`6131f14`](https://github.com/WebKit/WebKit/blob/6131f147456111c0c430607b0c94c11fdb53eaf6/Source/WebCore/loader/NavigationScheduler.cpp#L134) (pinned, because `main` moves): `ScheduledURLNavigation` — which `ScheduledLocationChange`, what `location.href = …` becomes, extends at `:248` — takes its policy from `initiatingDocument.shouldOpenExternalURLsPolicyToPropagate()` at `:137`, i.e. the document's **inherited** policy, not a live gesture check. The file is `Source/WebCore/loader/NavigationScheduler.cpp`; an earlier draft of this line said `FrameLoader.cpp`, which contains no such symbol. The other half is [`Source/WebCore/dom/Document.cpp:10351`](https://github.com/WebKit/WebKit/blob/6131f147456111c0c430607b0c94c11fdb53eaf6/Source/WebCore/dom/Document.cpp#L10351), which reads the policy off the `DocumentLoader` and falls back to `ShouldNotAllow` only when there is no loader. So a page opened by tapping a link, bookmark or Home Screen icon carries `ShouldAllow` for its whole lifetime, and a later gestureless navigation from a WebSocket handler passes WebCore's gate. That is **stronger than the HTML spec's sticky activation** — it is document-lifetime.

⚠️ That is only the WebCore gate. **Safari's UI process is closed source** and iOS is known to show an _"Open in…"_ confirmation under conditions that could not be pinned down.

## Coming in iOS 27

An **App Notification** automation trigger and repeating/interval automations. That is the eventual clean answer to the Pushover question.

---

## Untested — these decide whether any of it works

1. **Does `Take Photo` with preview off run on a locked phone?** By this file's own reframe this is the decisive unknown for the question in the title, and no source reaches it — see "The limits, for the pocket case".
2. Does iOS **debounce rapid Charger connect/disconnect**, and what is the minimum reliable toggle period? Decides option 1, the top-ranked path.
3. **Hot Corners (option 2) — four at once, because none of them is documented.** What _"Time needed to initiate a dwell action"_ bottoms out at, since that interval _is_ the option's latency; whether a relative-motion mouse can leave and re-enter the corner reliably enough to fire on every button press; whether having Dwell Control on phone-wide is tolerable while the rider is also using Maps; and whether this phone will pair with and accept the Pi as a BLE HID **pointer** at all.
4. **Does the Message trigger fire on a plain SMS** (not iMessage)? Decides the best cloud path available today.
5. Whether a BLE HID keypress **wakes the display**. Only binds the pocket case — but there it decides everything downstream of it.
6. Whether this phone's Bluetooth automation picker **lists the Pi** at all (option 5, and distinct from the HID-pointer question in 3).
7. Message-trigger end-to-end latency on cellular while hotspotting.
8. Whether the **Email** trigger fires promptly with iCloud Push while hotspotting.
9. Whether Safari prompts on an app-scheme navigation, and under what conditions.
10. iOS 27 only: whether a Pushover notification actually fires the notification automation, whether title/body filtering works, and whether quiet delivery, Scheduled Summary or a Focus suppress it.
