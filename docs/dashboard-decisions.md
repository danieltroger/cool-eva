# Dashboard decisions (`public/`)

Where the long-form reasoning behind the phone dashboard lives. The code in `public/` keeps a sentence and a pointer at each decision; the measurements, the refuted alternatives and the arguments that were reversed are here, so a future editor can find out _why_ without a forty-line block sitting between them and the line they came to read. See CLAUDE.md, "Findings belong in documents, not in the margin".

One rule survives the move: a comment saying that something is **load-bearing for safety** stays at the code. The arm-to-fire dwell, the confirm token and the visibility teardown are all met at the line, and this file only carries the evidence behind them.

Related documents: `README.md` (overview), `HYPERMILING.md` (the pack model the derived numbers use), `obd-garage/CAN_MAP.md` (the reverse-engineered CAN map), `PHONE_CONTROL.md` (what the phone will and will not accept from the bike).

---

## Routing — `lib/router.js`, `app.js`

The tab bar is in the URL. Until that existed the tab lived in a module-level state and nowhere else, so the phone's Back button had nothing to walk back through: it left the dashboard from whichever screen you were on, which on a bike is the one moment you are least able to find your way back.

### Why the hash rather than a path

`/#charge`, not `/charge`. The server answers from a Map keyed by URL path (`src/http/static.ts`) and `src/index.ts` replies 404 to anything that is not a file in it, so `/charge` would be `not found` in plain text — a deep link, a bookmark and a reload would all miss the dashboard entirely.

Path routing therefore needs a fallback route added to the server, and that is not free here: `/dl`, `/status`, `/waypoint`, `/dtc-table`, `/fault-infokeys`, `/stored-dtcs`, `/vcu-params`, `/vcu-read`, `/vcu-probe`, `/vcu-write` and `/vcu-backup.csv` are all real endpoints at the root, so the fallback would be a rule with eleven exceptions that a future tab name could silently collide with.

The hash costs the server nothing. `/#charge` _is_ a request for `/` — the fragment never leaves the browser — so deep links, bookmarks and reloads work against the Pi exactly as it is deployed today, with no service restart and no way for a tab to shadow an endpoint.

### What Back does

Every tab change is a pushState, so Back returns to the tab you were looking at before. Note what that means when you flip between two screens: ride → charge → ride leaves two entries behind and Back walks back through both, rather than collapsing the repeat visit onto its earlier entry.

That is deliberate. Collapsing would make Back skip screens you really did look at — you glance at Charge from Ride, glance back, press Back and land somewhere you have not been in ten minutes — and that is the version that feels broken. The depth of the stack costs nothing to escape either: leaving a web app on a phone is the app switcher or closing the tab, one gesture however deep it goes.

The one thing that is not a navigation is re-tapping the tab you are already on, and `showTab()` drops that rather than stacking an entry that Back cannot tell from a real one.

### A switch the rider did not ask for pushes too

The view rules (`lib/view-rules.js`, spent by `autoFocus()` in `app.js`) move the tab when the bike's state changes — plugging in, the pack going critical. A dropout is deliberately **not** such a change, which is the same distinction in a different place: it would otherwise push two entries the rider never made, every screen lock.

It would be reasonable to think those should `replaceState` rather than `pushState`, on the grounds that the rider did not choose them. They push, and the reason is what `replaceState` would actually do.

You are reading Faults, having gone ride → faults. The bike starts charging.

```
push:     ride, faults, charge   →  Back returns you to Faults, then Ride.
replace:  ride, charge           →  Back returns you to Ride. Faults is GONE.
```

`replaceState` does not decline to add an entry; it OVERWRITES the entry the rider made. So the "the rider did not choose this" instinct, followed honestly, argues for pushing: an action the rider did not choose should be undoable, and must not destroy one they did. Pushing gives both, replacing gives neither.

It also keeps Back meaning one thing. Push for a tap and replace for the bike would make Back sometimes step back a screen and sometimes skip one, with the difference turning on something the rider cannot see.

This matters more since #72 than it did before it: `autoFocus` now fires on a DC fast charge, which it never used to, because the BMS reports Idle throughout one. A rapid charger is exactly where the rider is most likely to be part-way through reading something else when the screen is taken away from them.

### Rewriting the fragment — `canonicalHash()`

`canonicalHash()` answers three independent things: the tab a fragment lands on, what the URL should be rewritten to (null when it already says the right thing), and whether the fragment named that tab or merely fell back to it. `#Charge` names a tab _and_ wants rewriting; `#ride` names one and does not; `#nope` names none and wants rewriting; `#ride` after a Back press is all three settled already.

Rewriting is what stops `/` from being a link nobody can share, and stops a fragment naming a tab this app does not have from going on claiming to be a screen it is not. Rewriting **only when it would change something** matters as much: `showTabFromUrl()` runs on every popstate, and Back through ten tabs must not spend ten `replaceState` calls out of Safari's bucket restating what the URL already said.

There is no `pushState` in `canonicalHash()` or anywhere it is called from. Arriving is not navigating away from somewhere, and on a popstate the browser has already moved the cursor — pushing would strand it and turn one Back press into two.

The function is pure so the rule can be checked without a browser — the same split as `headroomMvWith()` in `lib/derive.js`, and for the same reason. `tabFromHash()` is total for a related reason: it runs before the first render, so anything it threw on would be a blank screen rather than a wrong one. Hence no `decodeURIComponent` — tab names are plain lowercase words that need no escaping, and a bookmark carrying a stray `%` would only be a way for a malformed URL to take the dashboard down.

`startRouting()` listens for both `popstate` and `hashchange`; the reason those are two events rather than one is at `startRouting()` in the code.

### What is deliberately not routed

The sheet behind the ☰ button is not a tab and does not get a URL. It is a control panel over whatever screen you were on, half of it fetches when it opens, and a shared link that reopened it would show one section's stale numbers next to another's. If Back should close it, that is its own change, in `views/sheet.js`.

### A deep link buys exactly one pass — `viewRuleMemory` in `app.js`

The view rules are edge-triggered ("the moment charging starts"), but a page load has no previous moment, and seeding from `false` makes the first reading that says "charging" look like charging having just _started_. On the bare entry URL that is worth keeping: it is why opening the dashboard at a charger lands on Charge.

It is not worth keeping when a link, a bookmark or an iOS reload asked for a screen by name. The bike would move you off it a second later and — now that the tab is in the URL — rewrite the address with it, so reloading the link would no longer reach the screen the link names. A shared link that quietly overwrites its own address is worse than one the bike is allowed to overrule.

So a URL that named a tab buys exactly one pass: the first readings are taken as the state the bike was already in rather than as a change into it. Every edge after that is a real change and moves the view as it always did.

---

## Handlebar gestures — `lib/gestures.js`, `lib/handlebar-gestures.js`, `app.js`

What the dashboard has instead of a touchscreen while riding:

- flash the high beam three times → next tab (`app.js`)
- double-click `btn_cruise_set` → next tab

⚠️ **The HOLD gestures left this page on 2026-09-08 and are now the Pi's** — a 1200 ms hold of MODE ENTER steps the cooling fan, a 500 ms hold of `btn_indicator_cancel` saves a waypoint (1000 ms until 2026-09-09), both recognised in `src/gestures/`. They had to move: `lib/connection.js` closes the socket whenever the page is hidden, so a phone in a pocket recognised nothing, which is every gesture worth making. `docs/handlebar-gestures.md` has the recogniser, the thresholds and the corpus behind them, and it is where the `LONG_PRESS_MS` argument that used to be in this section now lives — corrected, because part of it had gone stale (see below).

**What could not follow them is the two that change TAB**, and the reason is structural rather than a preference: the Pi has no idea which tab is showing and no channel to say so — `DashboardMessage` carries signals and nothing else. So `DoubleClickDetector` stays here.

The recogniser in `lib/gestures.js` is pure, in the sense `src/can/decode.ts` is pure: every clock it reasons about is passed in, so it reads no clock, touches no DOM and holds no timers. That is what lets `scripts/check-handlebar-gestures.ts` replay press sequences through the very object the phone runs. The impure half (subscribing to signals, calling the actions) is `lib/handlebar-gestures.js`.

### ⚠️ The clock these take is the SERVER's, not the phone's

`nowMs` is `serverTime` from `lib/store.js` — the `ts` the Pi stamped on the message — and **not** `monotonicNow()`. That is the opposite of the rule the rest of this codebase follows for durations, so it needs its argument written down.

What this measures is the gap between two presses ON THE BIKE. The phone's monotonic clock cannot answer that: it measures the gap between two WebSocket messages ARRIVING, and those are the same number only while delivery latency is constant. On a garage hotspot it is not — two deliberate presses a second apart, delivered back-to-back after a stall, look exactly like a double click on the arrival clock.

The Pi stamps `ts` when it builds the patch, before the message goes anywhere, so server-side differences are immune to whatever the link does afterwards. A stall simply stops the clock advancing, and the queued press arrives carrying the time it really happened.

⚠️ This whole argument is why the hold gestures are better off on the Pi, where `monotonicNow()` is available and cannot be stepped — see `docs/handlebar-gestures.md`. It is also why the ceiling this section used to describe, `IMPLAUSIBLE_HOLD_MS`, is gone with them: it existed to stop `src/gps/clock.ts` stepping the server clock mid-hold and landing as a six-hour press, and a monotonic clock cannot do that.

### The safety argument, which decides the shape of the file

The button this watches has a primary vehicle function: `btn_cruise_set` sets the cruise speed. It is not affected by anything here, and not because the code is careful — because the phone is not in the circuit. The buttons are wired to the bike's own dashboard and VCU; CAN `0x102` / `0x400` carry a _report_ of the switch state that the bike broadcasts after it has already acted. This dashboard is a passive listener on that broadcast (`src/can/socket.ts` comes up listen-only; nothing on this path ever transmits), so there is no press for it to swallow, debounce or delay. A gesture is recognised strictly downstream of the bike having done its own job.

That is also why nothing here waits to see whether a press "turns into" a gesture. A double click does not suppress the first click — the bike never asked us, and the press has already happened by the time the frame carrying it is decoded.

### Which bit, and why it is not the obvious one

`btn_cruise_enable` is the wrong button and its name is the reason to check. It is the cruise ON/OFF switch, and `src/can/decode.ts` records that BOTH of its presses in the corpus armed cruise control 0.53 s later — it is not side-effect-free, and the owner's manual claim that activation needs a 3-second hold is contradicted by the bus (both presses were under a second). `btn_cruise_set` is the SET SPEED button next to it (`0x400` b2 bit 2), and setting a cruise speed does nothing at all unless cruise is already armed.

That leaves one honest caveat, which belongs to the button rather than to the gesture: double-tapping SET while cruise IS armed re-sets the cruise speed to the current speed. So does tapping it once, so nothing here made that worse — but a rider changing tabs while decelerating under cruise would be lowering the setpoint, and that is worth knowing rather than discovering.

### `DOUBLE_CLICK_WINDOW_MS` = 700 ms

How long two presses of the same button may be apart and still count as one double click, measured between their RISING edges. Bounded on both sides by measurements rather than taste:

- **Above a gloved double tap.** A bare-handed double click runs 150–300 ms; a thick glove on a vibrating bar roughly doubles that, so the gesture has to stay comfortably reachable at ~500 ms. The 2026-08-19 MODE-button measurements put a single deliberate press at 120–260 ms, so two of them plus the gap between is already most of half a second before a glove is anywhere near it.
- **Below two presses that were meant to be separate.** `lib/press.js` puts the gap between deliberate presses of the same button at ~1 s, and that is the number this must not reach — two ordinary cruise-set presses a second apart must read as two, not as a tab switch.

700 ms sits between the two with ~200 ms of headroom either side.

Rising edge to rising edge, not release to press, because a cruise-set press is not short: the only one in the corpus was held 1.794 s. Measured that way a long press can never pair with the press after it, which is the behaviour we want — a double click is two quick taps, and a held press is not a tap.

The detector clears `#lastRiseAt` rather than replacing it when a pair completes, so three quick taps are one switch and a fresh start — not two switches, which would make a fumbled double tap overshoot. It also requires a real observed 0→1: loading the page mid-press is not a press we watched, and `app.js`'s high-beam gesture draws the line in the same place.

### The two thresholds that left, and one correction they took with them

`LONG_PRESS_MS` (1200 ms) and `IMPLAUSIBLE_HOLD_MS` (30 s) were here until 2026-09-08. The first is now two constants on the Pi — 1200 ms for the fan cycle on MODE ENTER, **500 ms** for the waypoint on the cancel switch (1000 ms until 2026-09-09, trimmed because the rider was releasing early rather than risk the hazard lights that switch turns on at about two seconds). The second is gone entirely: it guarded against `src/gps/clock.ts` stepping the server clock mid-press, and the Pi measures on a monotonic clock that cannot be stepped. Both arguments, in full: `docs/handlebar-gestures.md`.

⚠️ **One number in the argument they took with them was wrong by the time they left.** This section said "the longest ordinary press ever recorded on any handlebar button is 920 ms (`btn_cruise_enable`)". That came from 14 captures and two presses of that button; across the 268-capture archive it has 36 presses and reaches **1.125 s**. It was not wrong when it was written, and it is why the table in the new document records the sample size beside every number.

How the surviving derive is paced — signal-bound rather than tick-bound — is argued at the `van.derive` in `lib/handlebar-gestures.js`, because the pacing is what the detector's correctness rests on. The high-beam flash in `app.js` is the other one that works with a full-face helmet and winter gloves without moving a hand.

---

## Momentary buttons on a phone screen — `lib/press.js`, `lib/latched.js`, `lib/flasher.js`, `views/all.js`

The handlebar buttons are momentary and short: measured across 14 candump captures the median press is ~140 ms and the shortest is 30 ms. The logging path handles that fine — `0x102` arrives every 10 ms, the signals carry no deadband, so both edges of even the shortest press are decoded and sealed. Nothing in `lib/press.js` changes that, and nothing there is logged: it is display state only, computed on the phone, the same rule `lib/derive.js` follows.

What log-on-change cannot fix is that 30 ms is one or two frames of a 60 Hz display. A tile that rendered the raw 1 would flicker for a frame and be gone before the eye registered it, which would make the buttons group useless for the one job it exists to do — press a button on the bars and see which key moved.

So each button gets three things the raw value doesn't give you:

- a **latch**. The tile is lit while the bit is 1 and for `LATCH_MS` after it drops, so the briefest tap is still a clearly visible flash.
- a **count** and a timestamp. These are what survive if a flash is missed entirely — a backgrounded tab, a dropped WebSocket frame, a press that lands during a reconnect. Watching a number go 3 → 4 is a slower but strictly more reliable way to identify a button than watching for a light, and it is the one to trust when the two disagree.
- a **held-since** stamp, for the group's other half.

`LATCH_MS` is 600 ms: comfortably above the ~200 ms it takes to notice a change and well under the ~1 s gap between deliberate presses of the same button, so two taps still read as two.

### Which signals get the tile — `lib/latched.js`

Two ways in, and until 2026-08-30 there was only one.

The registry group `buttons` is the first: everything in it gets the latched tile, and the ALL page's sections still come from `groupOf(key)` and nothing else, so a group is a group and needs no code here. The second is `LATCHED_KEYS`, a set of keys **outside** that group, and it exists because a signal's group is not free to change. `db.ts` writes the `signal` table with `ON CONFLICT(key) DO NOTHING`, so `rides.db` keeps whatever group a key was FIRST seen under, for ever, and `grafana/dashboards/explore.json` reads `signal.grp`. The repo already spent that on 2026-08-19 for `high_beam` and four others and wrote down that it did; there is no reason to spend it again to change a tile.

`horn` (`0x102` b2 0x10) and `ignition_button` (b1 bit6, the red button on the right bar) are what is in the set. Both are worked by a thumb, both are in `controls` with the vehicle-state bits, and both were rendering as a raw 1/0 — which for a ~30 ms event is not a readout at all, it is a tile that never visibly changes. That was the owner's report: _"once super simple 0 or 1 and once with a nice UI"_.

**⚠️ "Latched" is a claim about the tile, not about the signal.** It is deliberately not called "momentary", because that word already means the opposite of _held_ everywhere else in this file, and `high_beam` is in the group and has been held for 67.9 s. What the set asserts is only that this signal's EDGES are the event worth seeing.

What may not go in it is anything nobody operates. The tile's vocabulary is "PRESSED", "3 presses", "held for", and those words have to stay true: the beam lamps are outputs and `high_beam` is the switch that drives them (the pair is kept precisely so a failed bulb shows up as a disagreement); `cruise_active` is a vehicle state the registry argues about at its entry. The interesting boundary case is an ABS intervention — 1-2 frames, as invisible as a press and for the same reason — which `src/can/registry.ts` had recorded as "deliberately not fixed, and the shape of the fix is known: a per-key momentary set". That mechanism now exists, so `abs_event` is one line away; what stops it is the wording, since nothing presses an ABS intervention. That is a decision about nouns, not a missing switch, and the note there now says so.

`scripts/check-all-view-tiles.ts` is the guard. It cannot import `views/all.js` or `lib/press.js` (both pull in `van`, which needs a DOM), which is exactly why the rule lives in a file of its own that imports nothing — the same split, for the same reason, as `lib/flasher.js`.

### The group stopped being all momentary on 2026-08-19

The owner asked for the indicators, the high beam and the brake in this section, and none of those three is a tap. "4 presses · 2 min ago" is a true sentence that answers the wrong question about a brake lever being squeezed RIGHT NOW.

Every duration below is MEASURED, by replaying all 14 650 573 frames of `0x102` in the 248 captures in `~/Documents/cool-eva-archive` and pairing each rising edge with the falling edge after it:

| key                    | applications | median ON | longest ON | under 1 s |
| ---------------------- | -----------: | --------: | ---------: | --------- |
| front brake (b2 0x20)  |          491 |    2.24 s |     47.2 s | —         |
| `high_beam` (b0 bit 6) |          180 |    0.27 s |     67.9 s | 163/180   |
| `btn_mode_enter`       |          142 |    0.14 s |      0.3 s | 142/142   |
| `btn_mode_left`        |          310 |    0.14 s |      2.6 s | 293/310   |
| `btn_mode_right`       |          525 |    0.13 s |    191.2 s | 484/525   |
| `btn_indicator_cancel` |          762 |    0.18 s |      5.8 s | 759/762   |

Which is the whole argument against sorting these into "momentary" and "held" BY KEY. Every column of that table crosses over: the high beam is a 0.27 s flash-to-pass 163 times out of 180 and a held state the other 17, and a `btn_` key nobody would call a held state has sat down for three minutes. A hand-written list would be wrong about both, in opposite directions, and would go quietly stale besides.

The tile therefore does not classify signals; it READS THE CLOCK. Anything currently down for longer than `HOLD_MS` is described by how long it has been down, and everything else by its press count. Nothing to keep in sync, and the day the brake bit sticks on it says so instead of quietly adding a press.

`HOLD_MS` is 1000 ms, where the corpus is thinnest: 1 678 of the 1 739 `btn_` presses ever recorded are under it, against a front-brake application whose median is 2.24 s. Nothing is MISLABELLED by landing on the wrong side — a button really held for a second was really held for a second, and the tile then says so, which is the point. The threshold only decides which of two true sentences is the more useful one.

The case that used to settle it was the waypoint gesture: holding `btn_indicator_cancel` saves a waypoint, so a key whose name, prefix and 762 recorded presses all say "momentary" was deliberately held past a second as a designed input, and the tile said "held 1 s" while it happened.

🚨 **That argument expired on 2026-09-09, when the waypoint hold was trimmed to 500 ms (#192).** The designed input is now shorter than this tile's threshold, so a waypoint save reads on the tile as a **press count**, not as a hold — the rider watching the tile while they wait for the toast sees the count tick, not "held 1 s". `HOLD_MS` stays at 1000 ms anyway, and deliberately: it is argued from 1 739 `btn_` presses against a front-brake median of 2.24 s, which is a different corpus answering a different question, and following the gesture threshold down would move a display constant to match a decision that has nothing to do with what reads well on a phone. **The two numbers were never the same number; they only briefly agreed.** The lasting lesson is the original one — any list of held-state keys written from today's thresholds will be wrong about them soon enough.

`secondsSincePress()` measures from the RELEASE, not the press. For the 140 ms taps this was written for the two are the same number; for a 47 s brake hold they are not, and stamping the rising edge would have the tile read "1 press · 49 s ago" two seconds after the lever came back. "Ago" has to mean "since this last stopped being true", or it disagrees with the hold line rendered directly above it.

### …except that a flasher is not a finger — `lib/flasher.js`

One thing the clock alone cannot fix, and it is the reason `lib/flasher.js` exists. `blinker_left` / `blinker_right` are `0x102` b2 bits 2/3, and they are the LAMP OUTPUTS rather than the switches — so while an indicator runs, they toggle. Measured off this bike's own ride log (`rides.db`, Apr–Aug 2026), the blink is **333 ms on, 349 ms off**, i.e. 1.46 Hz. Every one of those is a real rising edge on the wire, so anything counting edges gets an answer that is wrong by a factor rather than by a little:

```
blinker_left    1881 rising edges  →   323 actual uses   (5.8× over)
blinker_right   2693 rising edges  →   436 actual uses   (6.2× over)
```

No hold ever reaches `HOLD_MS` either, so a turn would read "89 presses" and never "on".

The rest of the bike's 1/0 signals are pressed and released by a person, and for those a 0 means what it says. These two are the exception, and it is a hardware fact about this vehicle rather than a display preference — which is why it is stated as data in `lib/flasher.js` and consumed as a rule in `lib/press.js`.

The two constants live in a file of their own for the same reason `lib/gestures.js` is split from `lib/handlebar-gestures.js`: `lib/press.js` imports `van`, which needs a DOM, so nothing in it can be reached from Node — and these two constants are exactly the kind that has to be checkable from Node. `FLASHER_KEYS` names registry keys by string, and a rename that missed this file would switch the coalescing off silently and inflate the blinker count 5.8× with every test still green. `scripts/check-button-decode.ts` imports both and asserts the names are real, registered, and in the group whose tiles use them.

#### `FLASHER_GAP_MS` = 700 ms, and why the set is closed

How long a flasher signal has to stay at 0 before a reader believes the rider cancelled rather than the relay opening. 700 ms sits in an empty valley, and the distribution really is two humps with almost nothing between them. Of the 1875 gaps between `blinker_left` flashes in `rides.db`:

```
≤ 400 ms   1556   the relay's own off phase
0.4-1.5 s     8   ← the valley the threshold has to land in
1.5-3 s       9
> 3 s       302   the rider genuinely finished and signalled again later
```

So anywhere from 0.4 s to 1.5 s classifies all but eight of them identically; 700 ms is the middle of that. The eight are the cost, and they are ambiguous by nature — a cancel-and-immediately-re-signal is not distinguishable from a dropped blink.

**⚠️ This number happens to equal `lib/gestures.js`'s `DOUBLE_CLICK_WINDOW_MS`, and the coincidence is a warning rather than a shared constant.** That file uses 700 ms to say "two presses this close are one gesture"; this one uses it to say "a gap this short was never a release". Applied to `btn_cruise_set` the rule here would erase the second click the tab gesture is built on, and applied to `high_beam` it would collapse the three-flash gesture in `app.js` to one press. Hence the set is closed to the two blinker lamps, and no `btn_` key may join it.

What `lib/press.js` does with it: for a key in `FLASHER_KEYS`, a falling edge is not believed until the bit has stayed at 0 for `FLASHER_GAP_MS`. Everything downstream — the count, `downSince`, the latch — then treats one indicator use as one event without knowing anything about flashers. The edge's timestamp is captured when it happens, not inside the timer: for a flasher the edge really happened then, and the 700 ms is how long it takes to be sure of it. Charging that delay to the rider would make every finished indicator read 0.7 s staler than it is.

### ⚠️ ONE derive, at module scope, watching every button — not one per tile

This placement is the whole reason the feature keeps working, and it is not obvious. VanJS decides a listener's lifetime from where it was created:

```js
listener._dom = dom ?? curNewDerives?.push(listener) ?? alwaysConnectedDom;
//                                                     (van-1.6.1.js:78)
```

At module scope `curNewDerives` is undefined, so the listener gets `alwaysConnectedDom` and lives for the life of the page. Created _inside_ a binding — which is what a `van.derive` in a tile factory would be, since `views/all.js` builds its grid in a function child — it is pushed onto `curNewDerives` and then pinned to that render's DOM node (`for (let l of curNewDerives) l._dom = newDom`, line 71). The next time the grid re-renders, `dom.replaceWith(newDom)` disconnects that node and `keepConnected()` drops the listener permanently.

The ALL grid re-renders on any of: typing in the filter box (which is exactly what you do to watch these — filter to `btn`), any new key arriving, or switching tabs away and back. So a per-tile derive would stop counting on the first keystroke, in total silence, and every tile would sit at `idle` with a frozen count — with the README's "trust the count over the light" advice quietly no longer true. This is the fourth way the feature could switch itself off without failing anything, and unlike the other three it cannot be checked from Node.

The same rule is why `installHandlebarGestures()` must be called at module top level and never from inside a view or a binding, and why `app.js` calls it next to `connect()`.

Reading `signalState(key).val` inside that derive subscribes it to each button. That costs nothing elsewhere: the grid keeps binding per tile, so a `0x400` frame still touches only the one tile whose key it carries. Coalescing is not a risk either — VanJS flushes with `queueMicrotask`, and the rise and fall of a press arrive in different WebSocket messages, i.e. different macrotasks, so a press can never be folded into a single re-run and lost.

`rawVal` is used when incrementing the count: reading `.val` of a state the same derive assigns to would make the derive depend on itself, and VanJS would then re-run it until its 100-iteration ceiling stopped it.

### A guarded derive, and the three ways to lose the change

A **guarded derive** is the shape used wherever a WebSocket signal has to trigger something expensive — an HTTP fetch, most often. `lib/charge-write.js` and `views/charge-auto.js` both have one. The guard is needed because `ws.ts` heartbeats a **full snapshot** every `HEARTBEAT_MS` and `lib/store.js:311` assigns a freshly parsed object each message, so a signal's _identity_ churns at 0.2 Hz whether or not its number moved. Bind naively and the derive is a poll of an HTTP endpoint, on a phone strapped to a handlebar. So the derive keeps a module-level `last…` of the **value** it last acted on and returns when nothing moved.

That shape has three traps. Two of them have shipped here, both in `views/charge-auto.js`, and both put a wrong number about the motorcycle on the screen — see `docs/charge-auto.md` § "What wakes this tile" for what each one looked like to the rider.

**1. A read behind an early `return` registers no listener at all.** VanJS collects a derive's dependencies from the reads it _actually performs_ on each run (`runAndCaptureDeps` at `van-1.6.1.js:12-23`, reached again through the `derive(l.f, l.s, l._dom)` at `:128` in `updateDoms`, via `derive` at `:79`), by intercepting the `val` getter. So in

```js
const a = valueOf("first");
if (a === last) return; // ← the run stops here
const b = valueOf("second"); // ← never read, so `second` gets no listener
```

the second signal can never wake the derive, and the omission is invisible: the code reads as if it watches both. **Read every signal the derive cares about before any guard can return.** One derive reading two states is still one listener object, and `updateDoms` de-duplicates through a `Set` (`van-1.6.1.js:127`), so both moving in one batch costs one run, not two.

**2. A guard consumed on a run that did not act throws the change away for good.** This is the subtle one. If the `last…` is advanced _above_ the gate that decides whether to do the work —

```js
last = value; // ← consumed unconditionally
if (chargeType.val === "dc" && writesEnabled()) {
  void refresh();
}
```

— then every run where the gate is shut eats a real change. It is not deferred; nothing will ever re-deliver it, because the guard now agrees with the signal. The window is not hypothetical: `lib/charge-write.js:121` clears the write status the moment a session ends and the reopening `fetchChargeWriteStatus()` at `:117` is an async round trip, so anything landing across a session boundary is swallowed. **Advance the guard only on the path that acts**, and let an unacted run cost the two comparisons it costs.

**3. Some state changes with no signal behind it, and no guard can see those.** A guarded derive can only ever notice what the bus says. When the thing on screen depends on Pi state that changes _without_ a `record()` — `forgetSession()` in `src/charge/auto.ts:262-267` is the case here, nulling the controller's commanded amps on a `charge_manager_state` edge and recording nothing — there is nothing to guard on and nothing to wake.

The answer is not a third mechanism, and reaching for one is the mistake to avoid: `views/charge-auto.js` carried a `wasCommandable` flag for exactly one release, and because it re-read the Pi on any reopening of the gate it silently **compensated for trap #2** — with it in place, moving the guard back above the gate broke nothing any check could see. Instead, make trap #2's rule do the work. **The guard is the answer currently on screen, and anything that cannot act forgets it** — a shut gate, a failed read, a session that ended. A reopened gate then finds a guard it no longer holds and re-reads, with no flag and no second code path.

⚠️ **The one case that leaves is a guard forgotten over signals that were never recorded at all** — a controller that has not yet ticked, so both signals are `null` and `null === null` says "unchanged". Nothing on the bus can wake that, by construction. The view's own `if (!loaded.val) { void refresh(); }` render branch is what covers it, so that fetch is not redundant with the derive and must not be deleted as duplication; the price is one extra read on a session edge, which the read counter below discards.

`scripts/check-charge-auto-live.ts` holds all three, without a browser: it drives the real view against the real store and asserts on the text the tile's binding renders.

### The button tile's three readouts — `views/all.js`

`ButtonTile` is the same card as `RawTile`, but built to be watched rather than read. Which signals reach it is `lib/latched.js`'s question — the whole `buttons` group plus the keys named there — and `views/all.js` asks it per KEY, not per group. Three readouts, in decreasing order of how much you should trust them:

- the press COUNT, which cannot be missed by looking away, by a backgrounded tab or by a reconnect;
- how long ago the last press was, so a count that moved while you were looking at the bars is still attributable to the button you just pressed;
- the lit state, which is the fastest to read and the easiest to miss.

Never trust the light alone: a bit that is never seen high but whose count climbs is a working button whose flash the browser dropped.

…with one substitution, for the members of this group that are not momentary. The brake, and the high beam on a dark road, stay down for seconds or minutes, and "3 presses · 2 min ago" is a true sentence that answers the wrong question about a lever that is being pulled RIGHT NOW. So once the bit has been down longer than `HOLD_MS`, the second line reports the hold instead of the count.

**⚠️ That substitution retired a diagnostic worth knowing about, because the old wording is now a trap.** It said "a bit stuck high with a count of 1 is a wiring fault, not a press" — which was true when every signal here was momentary, and is exactly what a squeezed brake lever looks like today. The hold line is what tells them apart: a lever reads "held 4 s" and climbs while you watch, and a stuck bit reads "held 20 min" on a bike nobody is sitting on. So the lit tile is no longer evidence of anything by itself; the duration under it is.

---

## The link, staleness and charge mode — `lib/connection.js`, `lib/store.js`, `lib/charge-mode.js`

`lib/connection.js` is its own module with no imports, like `lib/charge-mode.js` and for the same two reasons: there can only be one answer to "should we be connected right now", and the answer has to be checkable without a browser — `scripts/check-connection.ts` drives every case against a stand-in socket and a fake clock. The `connection` state the header's dot binds to lives in `lib/store.js`; `lib/connection.js` is what moves it.

### ⚠️ Do not hold a socket while the page is hidden

The dashboard is handlebar-mounted, so the phone spends much of a ride with the screen off or with another app in front of it. iOS suspends this page's JavaScript for all of that. What was actually observed on this bike is that the socket SURVIVES the suspension — nothing closes — and the messages the Pi sent meanwhile are delivered in a burst when the page comes back. The rider unlocks the phone and watches roughly thirty seconds of the last few minutes replayed at speed, on tiles that look exactly like live telemetry.

The bike's own ride log says why it takes that long. Across its 6.2 M readings a patch is 152 bytes and riding produces 120–170 of them per second (p90–p99), so 19–27 kB/s; five minutes in a pocket is ~45 000 messages and ~6.8 MB. Each one arrives as its own event and re-renders whatever it touches, so the catch-up is paced by rendering rather than by how long 6.8 MB takes over wifi — which is what makes it tens of seconds rather than one.

So the rule is: **do not hold a socket while the page is hidden.** Closed on the way out, opened again on the way back in, and the Pi answers a new connection with one full snapshot of current values (`src/ws.ts`). The rider gets now, in one round trip, instead of a recording of the last five minutes.

`visibilitychange` is the hook the whole fix hangs on — iOS runs it before it suspends the page. `pagehide` is its second, for the case where that one does not arrive: it fires on the way into the back/forward cache and on the way out of the document altogether, both of which stop this page reading its socket, and it fires in cases where `document.hidden` is still false. A hash change does not unload the document, so the tab bar cannot trigger it.

### Why `close` is treated as news rather than as the trigger

Nothing waits for a close event to decide anything. Two independent things drive reconnection — the page becoming visible, and silence past `SILENCE_LIMIT_MS` — and either alone is enough. That is deliberate: a socket can stop carrying data without ever firing `close` (a hotspot dropping out mid-ride is the case to have in mind, and iOS Safari is documented as reaching the same state with `readyState` still reading OPEN), and a reconnect path that only runs from `onclose` would sit there for ever. `closed()` is still honoured — it just makes recovery faster, never possible.

The same rule is applied to `visibilitychange` itself, in both directions, because a trigger with no second is a trigger that can be missed:

- **hidden** — `pagehide` as well, and `tick()` drops any socket it finds on a hidden page. This is the direction that matters most: a socket nobody told us about is not silent, it is filling up, so the silence watchdog is no help and the header goes on saying "live" over a page that is not reading anything.
- **visible** — `tick()` opens one when it finds a visible page with no socket and no retry queued. Closing the socket on hide is also what made this page eligible for Safari's back/forward cache, which is exactly where a visibility transition is least dependable.

Both are one branch each and the poll they ride on is running anyway.

### The three constants

- `RECONNECT_DELAY_MS` = 2000. How long to wait after a socket dies before opening the next one. There is no delay in front of a wake, though: the rider is looking at the screen right now, and the socket was not lost to a failure worth backing off from — we closed it ourselves, on purpose.
- `SILENCE_LIMIT_MS` = 12 000. A socket that has produced nothing for this long is dead, whatever `readyState` says. `src/ws.ts` pushes a full snapshot every 5 s whether or not the bus has anything to say, so this measures the LINK and never a quiet bike: 12 s is two missed heartbeats plus margin, which is why it cannot churn sockets while the bike sits parked and silent. It is also the number `lib/charge-mode.js`'s `CONTACTOR_LIVE_MS` is pinned to, so moving one moves both.
- `POLL_MS` = 1000. A poll rather than a timer per deadline, so there is exactly one way a reconnect can be scheduled and no way to end up with two of them racing. 1 s costs nothing next to the 2 Hz chart tick the page already runs, and it is the granularity of both deadlines: a retry lands 2.0–3.0 s after a close, and silence is noticed within a second of 12 s.

### Sockets we have given up on still deliver events

All three handlers take the socket they belong to, because a socket this module has given up on can still deliver events afterwards. iOS delivers a suspended page's queued events when it resumes, so events out of order with the decisions taken about them is the normal case here, not a theoretical one.

- `opened` from a stale socket closes it. Acting on a stale `closed` would take down the healthy replacement and schedule a second reconnect on top of the running one — which is how a wake-lock-lock-wake sequence ends up with several sockets.
- `received` answers `false` for a stale socket, and the caller must DROP the message rather than apply it. That is not bookkeeping: those are precisely the queued messages that produce the fast-forward — closing a socket does not guarantee the frames already in flight are never delivered — so applying them would replay the very backlog abandoning the socket was meant to discard.
- A successful handshake does not claim "live". It only proves the Pi accepted the socket; `src/ws.ts` sends the snapshot the instant it does, and "live" is claimed when that ARRIVES. The gap is a round trip on wifi and rather more over a hotspot in a garage, and for all of it every value on screen is from before the gap.
- "live" is reported on every message, not only on the first. This is the fix for the old dashboard's stuck "reconnecting" label: its watchdog could latch the disconnected state and only the equivalent of `onopen` ever cleared it, so one throttled interval in a backgrounded tab left the header lying about a link that was streaming fine.

The `WebSocket` constructor refusing the URL outright — mixed content, or a SecurityError on a page not allowed to open it — is caught and logged loudly, then dropped onto the backoff: left to escape, it would be one uncaught error per `POLL_MS` for ever, retrying ten times faster than every other failure path.

The liveness watchdog used to live in `lib/store.js`. Noticing that nothing has arrived for twelve seconds and doing nothing about the socket was only ever half the job: it relabelled the header and left a link nobody believed in open. It now tears that socket down and opens the next one, and the label is a consequence rather than the whole response.

### Why the link's own state is part of freshness — `isStaleWith()`

`now` is the server clock from the LAST MESSAGE, and it stops when the messages do. So on its own the age comparison freezes the instant the link goes away: a pack current sampled 200 ms before the phone was pocketed keeps reading 200 ms old for the whole five minutes it is in there, and the tile it sits in stays at full brightness. That is the one lie this dashboard must not tell — a rider glancing down at a number presented as current is entitled to have it be current.

There is no honest arithmetic available for the gap: the phone's clock and the Pi's are different clocks and must never be subtracted from one another (`lib/clock.js`), and the Pi has no RTC. But there is an honest answer, and it is simpler than arithmetic — while the link is not live, nothing on the page is being refreshed, so nothing on it is current. Whatever is on screen is at least as old as the dropout.

That makes `lib/connection.js`'s status the pacing too, which is the other half of the problem: a binding that reads only the signal and `serverTime` cannot re-run while both are frozen, so it could not grey itself out however clever the sum was. The status is a state, it changes the moment the link does, and the bindings are already subscribed to it through this function.

A signal that has never arrived counts as stale, which is what makes freshness usable as evidence about the bike — see `chargeMode()`.

### `seenKeys`, and why the sample time is the reading's own

`seenKeys` is tracked separately from `states`, because `states` is not a record of what the bike has sent: `signalState()` is also called while a view is being built (every `valueOf()` does it), so a key can be in `states` before a single message mentions it. Keying off that would file those signals under "misc" forever and list never-seen keys in the ALL view.

It is recorded before the plausibility gate, not after. A signal that only ever produces rejected readings — `coolant_in` stuck at −242 °C for 59 450 rows is the real case — must still count as seen exactly once, or `added` latches true and `knownKeys` is rebuilt on every message, re-running everything bound to it; and the fault-only branch in `views/all.js` never gets a key to render.

Ring samples are pushed at `monotonicNow() - (message.ts - reading.ts)`: a monotonic base, placed at the moment the reading was actually taken rather than at the moment it arrived. `message.ts - reading.ts` is the reading's age _on the server_, so it is server-vs-server arithmetic and involves no cross-clock comparison; applying it to the local monotonic clock lands the sample where it belongs on the axis.

This also restores a dedupe that stamping on arrival silently lost. `src/ws.ts` heartbeats a FULL snapshot every 5 s and `liveState` never drops a key, so every heartbeat re-delivers all ~230 signals whether or not they changed. Stamped on arrival, each of those is a fresh sample, and a signal that has stopped arriving — hub down, poller stalled, probe unplugged on a plausible last value — draws a flat line forever on a tile `isStale()` is greying out. Placed this way a repeated reading gets the same sample time every heartbeat (its age grows exactly as fast as the clock advances), so `MIN_INTERVAL_MS` drops it and the trace ends where the data ended.

The clamp at 0 is only for a backwards server clock step, which would otherwise place a sample in the future and pin it to the newest end of the window. A large positive age is left alone: that IS an old reading, and it falling out of the chart window is the correct outcome.

### What `0x201` byte 0 actually says — `lib/charge-mode.js`

One rule, asked by everything that needs the answer: the charging screen's hero, its delivery tiles, and the view rules in `app.js`. Its own module with no imports precisely so there can only be one — the arrangement this replaces had the hero working out AC-vs-DC for itself, and a parked bike read "DC charging" directly above a card correctly saying the pack was delivering 0.1 kW.

The trap underneath that is worth stating on its own, because it caught two separate readers of this bus: `0x201` byte 0 does NOT answer "is it charging". Across ~24 M frames it takes exactly three values — 0x01, 0x02, 0x10 — and what they mean is whether the BMS is CHARGE-MANAGING, which is a narrower question:

```
0x01  not charging. Parked at −0.2 A and riding at −166 A alike.
0x02  AC charging. The BMS is running the charge.
0x10  the BMS is not charge-managing. That covers a whole DC session, where the
      current bypasses the BMS charge path — and also the last ~2 s of every AC
      session, at −0.1 A. So it is not "DC", and reading it as DC would call a
      parked bike a fast charge twice a day.
```

Which leaves DC with no evidence in this frame at all. It has plenty in `0x102` — see the contactor below.

`chargeMode()` answers four values rather than three because the source is a separate fact from whether a charge is happening, and only one of them always has evidence. "Not AC" is not evidence of DC — inferring it that way is precisely how a parked bike came to read "DC charging" — and "not DC" is no more evidence of AC, so `"charging"` exists to be honest about the case where the bus says a charge is running but nothing says what kind. Callers naming a source to the rider may only name it for `"ac"` and `"dc"`.

`bms_state_*` is read as the bitfield it is: 1 = discharge, 2 = charge, 4 balancing, 8 trickle, 16 idle, 32 charge-complete, 64 maintenance. Testing it against a single value flags Idle as charging, which is what the old dashboard's `!== 1` did. Charge-complete is deliberately excluded: current is no longer going in.

### `CHARGER_LIVE_MS` = 6 s, `CONTACTOR_LIVE_MS` = 12 s

Freshness rather than value is the whole point: the store keeps the last reading of every signal for ever, so `dc_v` reads 400 V until the next reboot whether or not anything is plugged in. Six seconds is thirty frames of margin on `0x305`/`0x306` at 5 Hz, and those four signals are analog and carry no deadband, so every sample of a charger that is actually running reaches the phone as its own patch.

The contactor bit needs a longer answer, because a steady BOOLEAN does not reach the phone the way a moving analog value does. `fast_dc_contactor` sits at 1 for the whole of a fast charge — 1038 s in the one captured session — and `src/can/signals.ts` patches a signal only when its value moves, so nothing refreshes this one's timestamp except `src/ws.ts`'s 5 s full-snapshot heartbeat, while `serverTime` advances on every 20 Hz `pack_a` patch. Its apparent age therefore sawtooths 0 → ~5 s, and `CHARGER_LIVE_MS` would leave a single second of heartbeat jitter between a healthy fast charge and this rule falling all the way to "none" — the BMS reports Idle throughout a DC session, so there is nothing behind it to catch the fall. That tears down the DC tiles and their sparklines and, through `autoFocus()`, throws the rider off the charge tab and back again on the next heartbeat.

12 s is `lib/connection.js`'s own `SILENCE_LIMIT_MS`: past that the dashboard has already decided the whole link is down — it says so in the header, drops the socket and opens another — so nothing is claimed here that the page is not already disowning. It costs nothing at the other end of a session either: unplugging moves the bit 1 → 0, which patches immediately, so this gate is only ever the backstop against a store that never forgets.

**⚠️** `stale` is answered by `lib/store.js`'s `isStale()`, which reports true for EVERY signal while the link is not live. So this rule does not merely age out during a dropout — it collapses to "none" the moment one starts, since the BMS's Idle leaves nothing behind the contactor bit. That is the right answer for anything DISPLAYING a charge, which is what this rule is for, and the wrong one for an edge detector; which is why `lib/view-rules.js` holds its edges across a dropout instead of asking this.

### The DC evidence that exists and is deliberately not used yet

`fast_dc_contactor` (`0x102` b3 bit 0) is unambiguous by a wide margin: across the whole 1.1 M-frame corpus it is set in exactly one interval, that interval is a DC fast charge, and it reads 0 through all four AC sessions — including a 48-minute one at 14 A mains. It also LEADS the charge, rising 190 ms before `charger_enabled` and ~470 ms before the first positive pack amp, which is what a contactor monitor should do. The full argument and the timestamps are in `src/can/decode.ts`.

"The only unambiguous DC evidence" stopped being true on 2026-08-19, when the charge manager was decoded (`src/can/charge-manager.ts`). There are now three more, all measured across 29 charge sessions rather than the single interval above: `charge_manager_state` (`0x610` b7) reads 0x23 on DC and 0x02 on AC in 100.000 % of 44 444 frames, `charge_type` (`0x605` b2) is 1/2, and `dc_charging` / `ac_charging` (`0x625` b4) say whether current is actually flowing rather than whether a session exists — a distinction `chargeMode()` currently cannot make. That last pair would also retire the freshness dance above, since they go to 0 by themselves instead of needing `CONTACTOR_LIVE_MS` to decide a stale 1 is over.

`dcContactorClosed()` is deliberately NOT changed in the same commit that decoded its replacement: the new signals have never been through a real charge on the bike, only through captures, and swapping the screen's one charge rule onto them before that is exactly the kind of change that should wait for evidence it cannot get from a laptop.

`isOnboardChargerLive()` reads `mains_v`, `mains_a`, `dc_v`, `dc_a`. `0x300`, `0x305`, `0x306` and `0x10a`'s AC setpoint are silent on DC fast charging — verified across a full 40-minute DC session on 2026-08-09, where every one of `mains_v`, `mains_a`, `dc_v`, `dc_a`, `charger_max_dc_v`, `charger_max_dc_a`, `charger_enabled` and `charge_limit_a` logged exactly zero readings. So anything sourced from them has to be hidden on DC rather than left showing the last AC value.

---

## The lifetime block — `views/all.js`, `lib/lifetime.js`

The bike's lifetime battery statistics sit above the All tab's filter box, pinned, in the grid's own tiles.

### Why pinned rather than a section of the grid

Not layout: **they are not signals.** Every tile below comes from `knownKeys` and is drawn by `groupOf(key)` with `isStale(key, STALE_MS)` deciding whether it has gone quiet. A lifetime statistic has no arrival time and no staleness — nothing broadcasts it (`obd-garage/DC_CHARGE_LIMITS.md` §10.6) — so making it a `groupOf()` section would mean lying to `isStale` about a number that was true a week ago and still is. It would also sort alphabetically, between `gps` and `motor`, where only somebody who already knew it existed would find it.

### …but it obeys the filter

The one interaction this view has is the filter box, and a pinned block that ignored it would be the first thing on screen that does not respond to typing. So the block filters its own rows by the same needle and disappears when none match. Type `cell` and you get the lifetime cell spread above the live cell voltages, which is the comparison worth having.

### Seven tiles, not eleven

The first version gave every decoded field its own tile and pushed the signal grid off the bottom of a 414 px screen — on the tab whose whole purpose is going to look at a raw number. The charge counters became one tile carrying `969 AC · 17 DC · 32 neither`, and the four cell readings became a spread with its bounds and ids underneath. Rows carry a `detail` array for exactly this, formatted in `src/diagnostics/lifetime-rows.ts` rather than in the browser: what belongs with what, and what a rejected constituent should look like, is the same judgement as the row itself.

### The empty block tells the rider what to do NEXT, not what an agent would do

A Pi that has never taken a reading shows one instruction, and after [#177](https://github.com/danieltroger/cool-eva/issues/177) it was still `node --experimental-strip-types scripts/read-freeze-frame.ts --lifetime --save, with the service stopped` — a shell command, on a phone, held one-handed at the bike. #177 had already made the read a button in the service sheet; the sentence just never moved. It stood that way from #177 to #187 the following evening. It now leads with the in-app path and keeps the command as a footnote for the case it is still the answer to, a Pi whose service is stopped.

⚠️ **It says "parked with the drive down", NOT "not charging".** The safety gate deliberately excuses `energized` while a charge session is confirmed (`src/vcu/service-gate.ts`, and §12 of `docs/vcu-parameters.md` for why servicing a charging bike is reasonable) — so an instruction to unplug first would invent a rule the code does not have, which is the same class of error as the flag that never existed. What the gate actually requires is the drive down and the bike stationary, and the sheet prints whichever check is blocking, which is the thing worth pointing at.

`scripts/check-lifetime-stats.ts` §7b parses the footnote through the script's own argument parser — it always did, because the first version of that string named `--components 51,52`, a flag that has never existed — and now also asserts that the headline is **not** a command, since a revert would otherwise look exactly like what used to be correct.

### The notes are the feature, not decoration

Two of these numbers are shown **unscaled** — `TotalExchangedAh` because its scale is refused, `AvgDOD` because Energica's equation for it is malformed — so the line underneath is what makes the number mean anything at all. It renders at the same weight as a rejected reading rather than tucked away, and it carries the thing a person standing at the bike can act on: what would settle it. `docs/lifetime-battery-statistics.md`.

## Plausibility bounds — `lib/bounds.js`

The gate exists because the real data is not clean. Across 7.6 M logged readings (Apr–Aug 2026) the bike has produced `coolant_in` at −242 °C in 59 450 rows and `coolant_out` at 988 °C in 40 351 rows — an open/flaky PT100, not noise — plus rarer `0xFFFF` sentinels on the cell voltages, −32767 on GPS altitude, and `high_beam` briefly reading 193. Rendering those raw is how you end up watching "−242 °C" on a coolant tile at 90 km/h, and a single one of them destroys a sparkline's autoscale for as long as it stays in the window.

The gate **rejects rather than clamps**. Clamping invents a plausible number and hides a real fault; dropping the sample keeps the last good value on screen and lets the tile say "fault" — which is the actionable thing, because on this bike an out-of-range coolant probe is a wire to go and wiggle.

Order of consultation in `boundsFor()`: `BY_KEY`, then the cell-voltage pattern, then `COUNTER_KEYS`, then `BOOLEAN_GROUPS` (flags before units, because their unit is `""` — which would otherwise fall through to unbounded and let `high_beam=193` render as "on"), then `BY_UNIT`.

### Why cell voltages are gated no tighter than the decoder

`CELL_VOLTAGE_PATTERN` gets `[1000, 5000]`, the same band the decoder uses (`MIN`/`MAX_PLAUSIBLE_CELL_MV` in `src/can/decode-bms.ts`), and deliberately not tighter. A tighter client gate is actively harmful here. The decoder's band is wide on purpose — "far wider than this pack's own configured limits, so no real cell, even a badly damaged one, can fall outside it" — and anything this rejects does not reach `signalState`, so `CellStrip` goes on drawing the last good bar. A cell collapsing to 1400 mV would then be invisible on the one screen whose premise is that a single cell out of 81 ends the ride. The server has already dropped the `0xFFFF` sentinel and the 8192 mV pad; this is defence in depth, so it should agree rather than second-guess.

### The charge manager's numeric bounds (2026-08-20)

The same miss `dc_charge_limit_selected_a` had, arrived at from the other direction: these signals do reach a rule, but the rule is `BY_UNIT`'s "A" fallback of `[-1000, 1000]`, and every one of them is a plain u8. No value a byte can hold is rejectable, so the gate was decorative. Each bound is derived from something, not guessed:

- **127** is `MAX_DC_CHG_CURRENT`'s FIELD range. Parameter 258 is a BYTE S that Energica's own option data masks with 0x7F (`src/vcu/write-targets.ts`), so the value field is 0…127 whatever the sign column says, and `fast_dc_limit_max_a` is that parameter read back off `0x625`. This bike holds 75.

  **⚠️ NOT 80.** 80 is this project's WRITE POLICY — the highest value Energica ever shipped a variant at, which is why `scripts/check-vcu-params.ts` refuses to write 81 and annotates 127 as "the datatype's own ceiling is NOT the policy's". A plausibility gate is about what the field can legitimately carry, not about what we are willing to write into it. Bounding at 80 would render a dealer write, or a differently-optioned bike, as a dead SENSOR rather than as the new value — defeating the one reason this key is logged, which is to notice the day the parameter changes. It would also have this key disagree with `dc_charge_limit_selected_a` about what counts as a fault for the same underlying parameter, which is the mistake the two DC voltages below are given identical bands to avoid.

- `fast_dc_limit_a` is `0x620` b0, bounded by that configured max, so it inherits the 127.
- `fast_dc_target_a` is the current the VEHICLE ASKS FOR, bounded in turn by the live limit the station offers — but the two frames run at 10 Hz and 20 Hz, so across a step edge the request reads up to 12 A above the limit for a frame or two (50 such frames in the corpus, all within 1 s of a step). 150 covers 127 plus that skew and still rejects the 255 an all-ones payload decodes to, which is what these entries were added for.

  ⚠️ **Renamed from `fast_dc_a` on 2026-08-20**, when `0x615` turned out to be the VCU's request frame rather than the charge manager reporting. The bound is unchanged; only the reason it is 150 rather than 127 is now stated in terms of a request. See `docs/charge-manager.md`.

- `fast_dc_target_v` and `fast_dc_limit_max_v` (`0x615` b0-1 and `0x625` b0-1) are 16-bit DC voltages whose decoders gate the high byte to `0x01`, so each can only emit 256…511 V while `BY_UNIT`'s "V" fallback is `[-50, 900]`. Both take `pack_v`'s `[0, 450]`: all three are voltages for the same 81-series pack, and a second witness must not be looser or the two disagree about what counts as a fault. ⚠️ `fast_dc_target_v` **replaced `charge_manager_pack_v`, and its value changed** — that key was documented as "the SAME QUANTITY as `pack_v`" and it is not, it is a request running a median 13.4 V above the pack.

- `charge_manager_error_src` and `charge_manager_error_code` (`0x610` b1 and b2-3) are a fault SOURCE and a fault CODE, so like `freeze_frame_dtc` they are identifiers and the whole field is legitimate — `[0, 255]` and the full signed 16 including the negative half, whose sign is the manufacturer's rather than ours. Only two of each have ever been seen; bounding round those would reject every fault this bike has not had yet, which is the entire reason the pair is logged.
- `ac_supply_limit_a` is SUPPLY-side — a cable or EVSE rating, not the bike's. It has only ever read 8, 10 and 13 A here and the bike's own AC charger stops at ~14.3 A, but a bound drawn round either of those would reject a legitimate reading at a bigger outlet. The ceiling comes from the STANDARD rather than from this bike: IEC 61851's control pilot cannot encode more than 80 A, so above that it is not a supply rating at all.

These are the second line of defence, not the first. `src/can/charge-manager.ts` checks frame invariants on `0x610`, `0x615`, `0x620` and `0x625`, so an all-ones payload still REACHES those decoders and they refuse it — the value never gets as far as this file. Both layers are wanted, because they fail differently: the invariant catches a sender that has stopped talking, and these catch a decode that is wrong in a way no invariant can see, since a byte read at the wrong offset still arrives in a frame with a perfectly good b1 = 0x01.

### The blank-unit trap, in three variations

A signal with a blank unit in a group that is not a `BOOLEAN_GROUP` reaches no rule at all and renders whatever arrives — the one outcome this file exists to prevent. Three keys were caught by it separately and each needs its own `BY_KEY` line:

- `fast_dc_contactor` — a 1/0 flag in `charge`, which is not a `BOOLEAN_GROUP` and must not become one, because `mains_v` and `dc_a` live there. Its unit is `""` precisely so it cannot fall into `BY_UNIT`'s numeric ranges.
- The charge manager's flags and raw state bytes (`dc_charging`, `ac_charging`, `bms_leak_detect_inhibit`, `charge_type`, `charge_manager_status`, `charge_manager_state`) — same group, same blank unit. The two raw state bytes are gated to a byte rather than to the values they have been seen to take: `0x610` b0 has produced seven values and b7 nine across 29 sessions, and the point of logging them raw is to catch a state nobody has seen yet; a bound drawn round today's set would reject exactly that.
- `speed_redundant_a_raw` / `_b_raw` (`0x125`) — raw counts, blank unit, non-boolean group. There is no scale to bound them by (see `src/can/drive.ts`), so the bound is derived from the one thing that is known: at the measured ~109-117 counts per km/h this bike's 200 km/h top speed is at most ~23 400 counts, so 40 000 cannot reject a real reading and does reject the wild value a wrong offset or width would produce.

The opposite failure, a unit fallback that is too tight, has its own examples. `psu_12v_mv` and `psu_12v_lowpower_mv` are in mV, and `BY_UNIT`'s mV fallback is `[0, 5000]` because it was written for cell voltages — a healthy 12 704 mV rail would fall straight through it and be drawn as a dead sensor. 20 000 mV is well above anything a 12 V system produces and well below the 65 535 a decode failure would show. `dc_charge_limit_selected_a` is named because `BY_UNIT`'s "A" fallback of `[-1000, 1000]` would happily draw a misread opcode byte as 147 A.

`abs_warning_lamp` is the reverse again: **⚠️ not** a 1/0 flag, despite living in `diag` with a blank unit. Energica's `A_WARN_LAMP` is `byte 4 mask 0x0C >> 2` — TWO bits, so 0…3 — and the mask is kept as the vendor wrote it rather than narrowed to the one bit this bike has been seen to use. Without the `BY_KEY` entry the group-wide boolean rule would gate it to `[0, 1]` and reject lamp states 2 and 3 as a dead sensor, precisely when the lamp has something to say.

`freeze_frame_dtc` is an IDENTIFIER, not a measurement, so the whole 16-bit space is legitimate (P0514 is 0x0514 = 1300, and a U-code reaches 0xFFFF). 0 is meaningful too: it is the bike's own way of saying no freeze frame is stored.

`COUNTER_KEYS` exists because `dtc_count` (0…127, PID 01) and `warmups_since_clear` (0…255, PID 30) share the `diag` group with the 154 generated `dtc_*` flags but are counts, not flags — the group-wide 1/0 rule would reject every value above 1 as a sensor fault, gating out exactly the stored-code count that the Faults tab's OBD cross-check exists to show, precisely when there is something to cross-check. (The service sheet carried a tile until 2026-08-20 that put the Hub's ACTIVE `dtc_*` flags beside PID 01's STORED count — two numbers `Counters()` says measure different things and always disagree — and left the reader to make of that what they would. It was removed as a duplicate of the Faults tab, which is strictly more: it names the codes, carries their history, and runs a real cross-check of PID 01's counter against the length of mode 03's list, saying so when those two disagree. Note that is a DIFFERENT pair of numbers, so nothing was 'moved' — the tile's juxtaposition simply had no reading worth keeping.) `dtc_stored_count` reads 39 on this bike today.

`buttons` joined `BOOLEAN_GROUPS` on 2026-08-16. Today their decoder can only emit 0 or 1 (it returns `bit()`), so the gate rejects nothing — it is there for the same reason `controls` is, which is that `high_beam` once read 193. A decoder that later returned the masked byte instead of the bit (`handlebar & 0x20` is 32, not 1) would otherwise paint a pressed button as an ordinary number, and a button tile that lights on 32 but not on 1 is exactly the kind of quiet wrong answer this file exists to stop.

### `km_per_kwh_can` — why not the same band as the hub's pair

`0x10B` carries the VCU's own consumption: the same two quantities as `km_per_kwh` / `kwh_per_100km`, down a different path, and deliberately NOT given the same band. The hub's pair is smoothed; this one is instantaneous at 10 Hz, and an instantaneous km/kWh is unbounded above by construction — coast or regen for a moment and you cover distance on no net energy at all. Replaying the 2026-08-02 lap through this gate at the hub's `[0.5, 200]` rejected 159 of 448 readings, a third of a healthy signal drawn as a dead sensor, which is this file's own failure mode.

Those readings are real, not decode noise: the peak, 3379.3 km/kWh, pairs with 0.030 kWh/100 km in the same frame, and 3379.3 × 0.0296 = 100 exactly as the reciprocal requires. So the honest bound is the whole range the field can still express once the decoder has dropped the ≥ 65000 saturation clamp — 6499.9 and 64.999. Wide, but a narrower one here would be a guess about the bike rather than about the decode, and only the decode is knowable from this side. The 100 m averages get the same band, read unsigned and saturation-guarded the same way.

---

## Derived numbers and charts — `lib/derive.js`, `lib/power-limits.js`, `lib/ring.js`, `lib/svg.js`, `lib/tiles.js`, `lib/dwell.js`

Everything the dashboard shows that the bike does not itself measure is computed on the phone, and none of it is logged: the ride log holds measurements only, so a derivation that later turns out to be wrong can be redone against the raw data instead of poisoning it. The formulas come from the BMS's own configuration — see `HYPERMILING.md`.

Sign convention, read off 7.6 M logged samples: `pack_a` and `pack_kw` are NEGATIVE under discharge (observed minima −407 A and −116.6 kW, against the Ribelle's 126 kW peak) and positive on regen and charge. Getting this backwards silently inverts sag compensation.

`positiveOrNull()` exists because several BMS fields sit at exactly 0 when the BMS is not producing them — the 1 Wh remaining-energy field reads 0 until the extended config has something to report, and pack resistance reads 0 while the pack is idle and not being estimated. `??` does not catch that, because 0 is not nullish, so a naive fallback chain picks the zero over the good value behind it and the screen says "0.0 kWh left" on a pack that has 4.8 kWh in it.

### Wh/km: why the integral rather than the counter

The energy term is integrated from `pack_kw` rather than differenced from a remaining-energy counter, which is what the first version did and why the readout kept going blank mid-ride. Measured across the seven rides of 2026-08-04: `residual_energy_wh` moves in ~158 Wh steps — roughly one step per kilometre — so a five-minute window often held fewer than the two samples a difference needs, and the tile showed nothing between 23% and 100% of the time depending on the ride. `bms_remaining_energy_wh`, which has the 1 Wh resolution this wants, reads a constant 0 on this pack.

`pack_kw` has no such problem: it is pushed to the ring at up to 2 Hz, so the window is never short of samples while the bike is moving. Cross-checked against an independent source on the same rides — Δ`remaining_ah` × pack voltage — the integral agrees to within ~5% on every one of them.

Differencing `residual_energy_wh` lands 25-35% below both, but that is not evidence of a bad decode: it is validated against the bike's own menu (see `decode.ts` `0x10a`) and is an estimate of energy _available to the cut-off_, which is legitimately less than the charge the pack still holds. It is simply the wrong quantity for "what did the last five minutes cost", which is energy drawn.

Still preferred over the bike's own average because the horizon is known and stated on screen; a single averaged number with no stated window invites false precision.

`rollingConsumption()` returns a state rather than a bare number, because "nothing to show yet" and "you are net regenerating" are different things and the tile should not report a descent as though it were waiting for you to start moving.

#### Both terms are measured over the DISTANCE window, not the power window

They are not the same stretch of time. `pack_kw` keeps arriving while the bike stands still; the odometer does not tick, so it contributes no ring samples at all. Integrating the full power window against a distance window that covers only the moving part charges four minutes of DC-DC and coolant pump at a red light to the 500 m you actually rode — the tile would read ~100 Wh/km over a stretch that cost ~60, under a label that says "over the last 0.5 km".

Clipping to the distance window is the deliberate choice: it makes the number mean "what a kilometre of riding costs", which is what the label claims and what riding style is judged by. The cost is that standing-still draw is excluded, so `rollingRangeKm()` is slightly optimistic in traffic — the honest trade, since the alternative misreports the thing the screen exists for.

`0x104`'s odometer is preferred to the hub's: it is on the CAN bus, so it is there whenever the bike is awake, while the Bluetooth one needs the hub link to be up. Both are logged separately on purpose, so this picks rather than merges.

#### Zero-order hold, and where it stops being safe — `integrateWh()`

Each sample stands until the next one. That is right for a signal pushed on change — `pack_kw` carries a 0.05 kW deadband, so a value that has not been re-sent has not moved — but only while samples are actually arriving. A gap in the ring has two indistinguishable causes: the value genuinely held, or nothing arrived at all (WebSocket drop, `systemctl restart cool-eva`, wifi fading at the edge of the garage, iOS suspending a backgrounded tab while the monotonic clock keeps running).

Holding across the second case invents energy, and does it worst exactly when it hurts: a 30 s dropout beginning during a −60 kW overtake would credit 500 Wh to a five-minute window that really spent ~300, so the tile reads ~160 Wh/km instead of ~60 and the range estimate divides by it. So an interval longer than `MAX_HOLD_MS` (3 s) is dropped rather than held, and the caller checks `MIN_COVERAGE` (0.7) before trusting the total.

Discharge is negative on this bike, so the sum is negated to make consumption positive. Regen keeps its own sign and correctly reduces the total.

### The cross-check from the hub

`bikeConsumptionWhPerKm()` reads `kwh_per_100km` off the Bluetooth hub. Of the three consumption fields the hub sends it is the only usable one: `avg_consumption_wh_km` reads a constant 0 (bytes 4-5 of sub-frame 0x01 are never populated on this bike), and `km_per_kwh` is quantised to whole km/kWh, so inverting it gives Wh/km that jump 125 → 250 → 500 — the two disagree with each other by a median 1.69×.

Median rather than mean, and windowed rather than instantaneous, because the raw signal is violently noisy: it swung between 1 and 495 Wh/km inside a single 20-minute ride on 2026-08-04. A median over the window sits within ~15 Wh/km of the integral on every ride that day, which is the agreement worth showing.

Not used as the primary reading: it arrives at ~5/min against `pack_kw`'s 2 Hz, and it stops entirely whenever the Bluetooth link is down, which CAN never is.

### Coolant flow is specified, not measured

`COOLANT_FLOW_LPH` = 850. Bosch PAD 12 V, part 0 392 023 004: 850 dm³/h at 0.1 bar and 13 V. There is no flow sensor on this bike, so this is the one number in `lib/derive.js` that is specified rather than measured, and it is an UPPER bound — the datasheet's characteristic curve falls away as back-pressure rises, and a cold plate plus hoses plus a radiator is more restrictive than 0.1 bar. Glycol is also thicker than the water it is rated with.

Independently supported, which is why it is worth showing at all: an energy balance over the 40-minute DC charge of 2026-08-09 — I²R heat in against the integral of coolant ΔT — implies ~15.4 L/min if the loop were removing all of it, against the datasheet's 14.2. Two unrelated routes agreeing to 8% is about as good as this gets without a flow meter. Everything computed from it inherits the caveat; ΔT itself is measured, and it is the term that actually moves.

### Resistive loss

I²R is simultaneously the range you are throwing away and the heat the coolant loop has to carry off, which is why it earns a place on the riding screen and not just the hypermiling one. Because it goes as current squared, halving the current quarters it: the most direct possible argument for a gentle throttle. Squaring drops the sign, so it is correct for regen too.

Caveat worth keeping in mind when reading it: R covers cabling and contactors as well as the cells, so some of these watts are shed outside them. It is an upper bound on cell heating, not a measurement of it. R itself is measured live by regression where the current is varying enough to fit one, and modelled off pack temperature otherwise — the tile says which, and `docs/pack-resistance.md` says why the BMS's own `pack_resistance_mohm` is not used. Below a few hundred watts of output the loss _percentage_ is dominated by its own rounding and swings between nothing and everything while parked, so it reports null instead.

### The under-voltage dwell — `lib/dwell.js`

The BMS does not cut discharge the moment a cell dips below the cut-off — its `DischargeModeUnderVoltageCutOffTimer` is 60 s, and the minimum cell has to stay under for that whole minute before the contactors open. That single fact is the difference between a useful display and one that panics: a hard pull drags the weakest cell under the floor routinely, and a naive alarm would fire on every overtake.

So instead of a threshold light, this tracks the timer itself — filling while under, draining while above — and the view shows how much of the minute is used. "You have 40 seconds of this left" is something a rider can act on.

The drain is symmetric with the fill because the BMS's own reset behaviour is not documented in the config and has never been observed on this bike (no capture has ever come near the floor). Symmetric is the middle assumption: an instant reset would understate a cell bouncing in and out of the cut-off, and no drain at all would leave the bar stuck full after a single dip.

The per-tick step is clamped to 2 s: a tab that was backgrounded for a minute must not credit the whole minute to the timer in one step — we have no idea what the cell did while we weren't looking, and inventing a full cut-out is worse than under-reporting.

### Pairing two rings by time — `differenceByTime()` in `lib/ring.js`

Index pairing looks right and is not: two signals only line up by index if they were sampled together, and nothing here guarantees that. `coolant_in` and `coolant_out` are read from separate awaited calls and each is gated by its own 0.05 °C deadband before it is pushed, so the two rings hold different numbers of samples taken at different moments — on this bike `coolant_in` has roughly ten times the rows of `coolant_out`. Subtracting by index would drift further into the past the further along the window you look, and produce a plausible-looking trace of the rate mismatch rather than of the quantity being measured.

For each sample of `primary`, the function takes the newest `reference` sample at or before it — a zero-order hold, which is the correct reading of "what was the inlet doing when the outlet was measured". Primary samples older than anything in the reference window are skipped: there is nothing to hold from, and extrapolating backwards would invent the value.

### The power meter — `lib/power-limits.js`, `lib/power-bar.js`

A thin vertical strip down the left edge of the speed hero: **drive grows up from the origin, regen grows down**, on a fixed scale that never re-ranges — 130 kW at the top and 36 kW at the bottom (`POWER_SCALE_KW` in `views/ride.js`). What the BMS has taken away is drawn as the same grey **dashed**, so the strip answers "how much is left" without the rider measuring anything.

It is vertical because that is what the owner's own bike does — the Model 3/Y meter is a strip at the left edge beside the speed — and because vertical costs no row. The horizontal bar it replaces spent one row on itself and another on a `REGEN / DRIVE` legend naming its ends; the strip runs beside a numeral that is already that tall and needs no legend, because up-and-blue against down-and-green is the whole of it.

⚠️ **Which end is which is an inference, not a measurement.** The reference photos show a regen segment low in the strip in one frame and mid-high in another, with different panel layouts, so zero cannot be fixed from them. Up-is-more is what every other vertical meter a rider has used does, and it puts green where the clearest photo has it. `originY()` is one line and `check-power-bar.ts` §3 pins the direction, so flipping it is a deliberate act rather than a drift.

#### The two halves are not the same size, and pretending they were wasted one of them

`POWER_SCALE_KW` is `{ drive: 130, regen: 36 }` — 400 A at 325 V and 120 A at 300 V, each direction's configured current limit at a representative pack voltage.

The machine is asymmetric. Discharge reaches −117.3 kW in the archive against the Ribelle's 126 kW peak; regen reaches **40.9 kW** with a p99 of 22.6 kW. So on a symmetric meter the regen half could never fill more than a third of its travel on the best day the pack has ever had. It was a single 130 for both until the derate started being drawn, and drawing it is what made the mismatch impossible to ignore: as a plain meter the wasted travel was merely wasteful, but the unreachable two-thirds is by the rule _unavailable_, so **~70% of the regen half would mark itself permanently on a perfectly healthy pack** — which teaches the eye that the mark means nothing, exactly where it is the signal.

⚠️ The obvious reason for that — "120 A cannot make more than ~41 kW" — is _not_ sound, and it is worth recording as refuted rather than quietly dropping. `allowed_regen_a` really is capped at 120.0 A over 598 rows, and 120 A × the highest `pack_v` ever logged (341.2 V) really is 40.944 kW. But the largest positive `pack_a` outside a charge window is **130.2 A** — the same sample as the 40.883 kW peak — so regen current has been measured 8.5% _over_ the allowance. The allowance bounds the ceiling, not the current.

##### …and the first fix for that reproduced the same fault at a fifth of the size

`regen` was 45 before it was 36, sized to leave a tenth of headroom over the 40.9 kW regen has been recorded at. That is the wrong quantity to size against, and the error is instructive: **a half that marks a derate must be sized against the CEILING it has to be able to clear, not against the power recorded in it.** The regen ceiling is `allowed_regen_a × pack_v` and cannot pass 40.944 kW, so a 45 kW half could never come clean — **0.00% of 1054 minutes of moving time**, a permanent floor of marks at one end on a perfectly healthy pack.

Sized against the ceiling instead, the two halves come out even. Over moving time, the drive half is clean for **20.1%** of the time the BMS is allowing its full 400 A and the regen half for **23.0%** of the time it is allowing its full 120 A, so neither is systematically noisier than the other. 36 does _not_ contain regen's largest ever sample and is not meant to: 4 of 57 443 positive samples exceed 38 kW, and clamping that tail costs far less than a half that can never come clean.

#### Each direction gets the share of the LENGTH its scale has of the total

`originY()` puts zero at `drive / (drive + regen)` down the strip — 78.313% — so **one viewBox unit is 1.66 kW above the origin and below it**. `check-power-bar.ts` §3 asserts the two are equal rather than trusting the arithmetic.

⚠️ This retires a cost the horizontal bar accepted and this doc used to defend: _"a given distance from the centre means different kilowatts to left and right… this is what Tesla's own power meter does for the same reason."_ **The second half of that sentence is wrong, and the owner's photographs are what refuted it.** Tesla's origin is visibly off-centre, which is exactly how you get one scale across a whole meter. The citation supports the geometry here and contradicts the claim it was attached to.

- **The BMS pair, not the inverter's `current_max_out_a` / `current_max_regen_a`.** `pack_kw` is `pack_v × pack_a` — a pack-side quantity — so a pack-side limit is the one that sits on the same axis with nothing assumed. The inverter's pair is a second opinion about a different node and is deliberately kept as one.
- **Measured volts, not nominal.** The ceiling really does fall as the pack sags under load, and that is exactly when a rider wants to see it; a limit computed against a nominal 350 V would be frozen for the reason it most needs to move. It also means the mark answers "what can I not reach right now" rather than "is the BMS derating me" — sag counts, and should: at 250 V you cannot have 130 kW however healthy the pack is.
- **They earn the space because they move.** Over 1054 minutes of moving time the discharge ceiling averages **91.3 kW** against the bike's 126 kW peak, and the regen ceiling 25.3 kW with a maximum of 39.2. So most of the time a meter that looks like it has a quarter of its travel left has nothing of the sort, and the marking is the difference between reading headroom and reading a derate. Of the discharging `pack_kw` samples only ~0.4% ever exceed the ceiling drawn against them: it really is a wall the meter approaches and rarely crosses, which is what makes it worth drawing.

#### ⚠️ How those numbers are weighted, because the first attempt got it wrong

The figures above are **time-weighted**, and the ones that shipped in the first draft of this section were not. That draft quoted a mean of 84.6 kW and "past 130 kW for 0.83% of covered time", both computed over `allowed_discharge_a`'s own 697 log-on-change rows, the second holding each row for at most 30 s.

That estimator is biased, and biased in the direction that flattered the design. `allowed_discharge_a` carries a 1 A deadband, so it emits densely while it is _derating_ and emits almost nothing across the long stretches where it sits pinned at its configured 400 A. Counting its rows counts derate events; capping their hold at 30 s throws away the pins. The tell is the sensitivity: that figure moves from 0.83% to **11.4%** on the hold cap alone.

The estimator used now samples on the bike's own clock instead. Each `pack_v` reading (no deadband, so it arrives densely whenever the pack is talking) carries its gap to the next within the same session, capped at 5 s, with both limits held from their last reading:

| over moving time (`speed_can_kmh > 5`) | first draft | measured    |
| -------------------------------------- | ----------- | ----------- |
| discharge ceiling, mean                | 84.6 kW     | **91.3 kW** |
| discharge ceiling above 130 kW         | 0.83%       | **6.2%**    |
| regen ceiling, mean                    | 22.3 kW     | 25.3 kW     |
| regen ceiling above the drive scale    | never       | never       |

Unlike the one it replaces this is stable under its own knobs: across hold caps from 1 s to 5 min the mean moves 92.6 → 90.0 kW and the share 5.5% → 8.0%, and swapping the definition of "moving" between `speed_can_kmh`, `speed_kmh` and `gps_speed_kmh` moves the share only 5.4% → 6.2%. An independent re-measurement during review landed at 94.3 kW and 10.9%. Every route agrees the share is somewhere between one minute in twenty and one in nine, and none is anywhere near 0.83%. The extremes are unaffected, being extremes rather than time claims: the discharge ceiling has been seen from 0 to 134.7 kW and the regen ceiling from 0 to 38.5.

#### What the derate looks like, and the four designs that did not work

A ceiling wider than its half reaches that half's end and takes nothing away, which is exactly true — the pack is not what is limiting you. A ceiling of zero collapses that side onto the origin. Both fall out of the arithmetic in `reachable()` with nothing to special-case.

⚠️ **There is no minimum width, and there was.** `MIN_HATCH_WIDTH` dropped any stretch under 7% of a half, on the reasoning that a sliver is a smudge rather than a pattern. Measured, that swallowed every drive ceiling in (120.9, 130] kW — **a derate of up to 9.1 kW drawn pixel-identically to a healthy pack**, for 10.4% of moving time, against the 6.2% where a blank end is honest. So a blank end meant "nothing is limiting you" 37% of the time it appeared and "the pack has taken up to 9.1 kW" the other 63%: an _absence with two meanings_. A derate too small to see renders as a change too small to see, which is the truthful picture and needs no rule. It was also, once the halves stopped sharing a scale, one threshold in viewBox units standing for two different physical quantities — 9.1 kW of drive and 2.5 kW of regen — while its comment justified itself in kW. `originY()` retires that second objection by making one unit the same power on both sides, which is worth recording as retired rather than dropping.

**Four designs preceded this one, and each failed in a way only a render showed.** They are kept because each is a live trap:

1. **Full-height blocks in a lighter slate, alternating with the track.** The gaps between the blocks were the track's own colour, so a gap and the still-available stretch beside it were literally the same pixels.
2. **A single line at the ceiling.** It answers "where is the limit" and leaves the rider to measure the gap at 90 km/h. It also had two end cases with no honest option: dropped past full scale it was indistinguishable from "`0x202` has not arrived" (5–11% of moving time); pinned to the end it was indistinguishable from a ceiling _at_ full scale.
3. **A short dashed rule down the middle of the derated stretch**, which shipped, and which is what retired the CALM → WATCH → WARN → BAD ramp `colors.js` used to run on drive: the rule was drawn ON the fill, and over the old BAD red it sat at **1.72:1** in the one state where reaching into unreachable power matters most, where white took it to **3.9:1**. It reads at rest and the visor takes it: measured through the scatter-plus-veil simulation on a delivered render, those dashes average **1.48:1** against their track, and their brightest dash reaches 1.85:1.
4. **Inverting the tones** — drawing the still-allowed stretch bright and the taken stretch dim. This was proposed and rejected in review, and it is the most instructive of the four: it bought the derate edge 0.23 and sold the **fill** edge, which is the reading a rider takes every second, from 4.33:1 to **1.64:1** through the same simulation. It also inverted the alarm, making "the pack allows nothing" the faintest thing on the meter and "no ceiling has arrived yet" the boldest.

What ships instead is the owner's own specification, taken from his photographs of the bike he was asking us to copy: **the track is a grey, and the stretch the pack has taken is that same grey dashed against the tile showing through.** One colour, one texture, and the dash-against-gap contrast _is_ the track-against-tile contrast — so there is a single knob, and raising it makes a derate clearer and the fill's edge weaker. It is set at the point where the drive fill still clears its 4:1 floor: 1.53:1 dark and 1.66:1 light.

⚠️ **That leaves the derate carried by a texture rather than by a step in tone, and the number is not flattering.** "No ceiling has arrived" and "the pack allows nothing" differ in average brightness by **1.18:1**, and **1.09:1** through the visor simulation; what a rider actually sees is the pattern, which still swings 0.04 in luminance. This is a knowingly accepted trade, not an oversight — the alternative that measures better (a solid band at 2.96:1) is design 4 above, which costs the fill's edge. Whether the dashes read in real daylight is the one judgement no simulation here can make, and it is the owner's to make on the bike.

⚠️ **The dashes are the one stroke in the dashboard deliberately NOT `vector-effect: non-scaling-stroke`**, unlike every hairline in `lib/svg.js`. Both the dash period and the stroke width are fractions of the strip's own dimensions, on a `preserveAspectRatio="none"` element, so the pattern keeps its proportions from a 380 px phone to a 1000 px laptop. Adding the property that every other stroke here wants is what would break them. The trap moved with the code from the horizontal bar; the warning nearly did not.

**The ceiling mark survives being crossed.** `ceilingMark()` returns where to draw a one-unit mark, or `null` while the fill has not reached the ceiling, and `barLayers()` paints it **after** the fill. A mark for the wall that vanishes the instant you go through it hides the one reading that needed it — which is what design 2 got wrong from the other direction, and what an early draft of _this_ design reintroduced by painting the fill last. ⚠️ It is clamped inside the **fill**, not merely inside the reachable stretch: a ceiling under one unit's worth of scale — 1.66 kW, which includes the 0 A derate `power-limits.js` calls the most important thing the meter can say — leaves less than a unit of reachable stretch, and an unclamped mark lands on the far side of zero.

**Zero is a gap in the track**, not a mark on it, so nothing is painted in a colour assumed for the ground. ⚠️ A fifth failed design belongs with the four above and is the direct argument for the gap: a 1-unit slate rect at the centre. Nothing needed it — the meter spans the whole card, so zero is the middle of a shape the eye already has, and the fill grows _from_ it. What it did instead was get in the way: once the derate was drawn it had to be painted _after_ the marking to survive a 0 A ceiling at all, and it then read as a slate block interrupting a run of marks — one more thing to work out, in the state with the least to say. It is the only thing saying where zero is while the meter is empty; once there is power the fill grows from that point and marks it itself.

**Nothing is claimed at all while a charge is up.** The BMS zeroes _both_ limits during a DC session — rightly, since neither the drive nor the regen path is carrying that current — in 6293 of the 6296 archived `pack_kw` samples inside one, while `pack_kw` itself runs to +23.98 kW. Riding is a tab and charging is another, and `views/view-rules.js` deliberately lets the rider come back to this one mid-charge, so without a gate the meter reads _"the pack allows nothing in either direction and you are 24 kW past it"_. Staleness does not save it, because 0 A is a perfectly fresh reading. Ask `chargeMode()`, and show no ceiling rather than a wrong one.

**0 A is a real limit; 0 V is a missing reading.** A BMS derated all the way to zero is the single most important thing this meter can say, so the guard in `limitKw()` is deliberately not the `positiveOrNull()` shape used elsewhere in `lib/derive.js` — that one would drop the most alarming value on the floor as "no data".

**Drive has its own colour rather than the text ink.** It was `colors.CALM` — `--fg` — which drew the meter's fill in the same colour as the numerals beside it, so the two loudest things on the hero were one colour. `--flow` is a blue, because green is regen and red and amber mean a fault here; the kW figure takes it too, so the number and the strip read as one instrument. That makes `--flow` **ink** as well as a fill, so it carries the 6:1 text floor, and `check-theme-contrast.ts` holds it apart from `--cold` — the only other blue on this dashboard, and nothing was holding the two before.

**The colour was inverted for five weeks and nothing noticed.** From the dashboard rebuild of 2026-08-03 (#33) until 2026-09-08, `colors.power()` tested `kilowatts < -0.5` for its green — the sign convention read backwards, since `pack_kw` is negative under discharge. So a 100 kW pull was painted green and a 20 kW recovery amber, under a doc comment that had said the opposite correctly the whole time. Neither colour looks wrong on its own, which is the entire problem. `scripts/check-power-bar.ts` §1 asserts the direction against literal kilowatt values rather than against anything imported from `colors.js`.

**The pairs travel as objects**, `PowerLimitsKw` and `SplitBarScale`, from `powerLimitsKw()` through `powerBar()` to `reachable()`. Two same-typed parameters side by side would be a pair a caller can cross, and a crossed pair draws a screen that looks entirely deliberate — the BMS allowing 96 kW of regen and 38 kW of drive. The first version had exactly that shape, and a check covering both _ends_ of the path stayed green with the sides swapped at the call site between them.

⚠️ **`barLayers()` is pure, exported and ordered, and that is not tidiness.** The order IS the design — the fill over the track so its own edge is the loudest thing on the meter, the ceiling mark over the fill so crossing the wall does not erase it. Left inside `powerBar()` that ordering would be the one part of the file nothing in Node could reach, and the bug it prevents is one this design has already had once. §7 walks it.

⚠️ **`check-power-bar.ts`'s contrast floor did nothing at all from the day it was written until 2026-09-08.** `TRACK` and the fills are `var(--token)` strings — they have been since the palette moved to custom properties — and the check's `contrast()` did `parseInt("ar", 16)`, so every ratio was `NaN` and `NaN < floor` is false. It printed `rule over NaN, NaN, NaN:1` on every run of `npm test` and nobody read the line. It is the guard that would have caught design 4 above, and its silence is why that design reached a page of screenshots with measured numbers on it. It resolves its tokens against `style.css` now, the way `check-theme-contrast.ts` always has.

### The heatmap — `lib/svg.js`

Rows are modules and columns are the sensors or cells within one, so the shape on screen is the shape of the pack. That is the whole point over the flat 81-bar strip: a strip shows that something is drifting, a grid shows _which module_, and during a fast charge that is the difference between a curiosity and something you can act on.

**Three cell states, and the outline means only one of them.** A cell with no reading is drawn as an empty outline rather than skipped, so the grid keeps its geometry — a hole must not look like a shifted row. But an outline is now reserved for a sensor that is EXPECTED and not arriving, which is a probe worth going and wiggling: 0x663/0x664 have been observed never sampling some modules, and `decode-bms.ts` drops a battery byte outside [−40, 100] °C, the 122 °C pad a module reports when the BMCU has not polled it. Modules 6 and 8 are not that. They have `BattTemp1Enabled = False` and no thermistor at all, so their cell keeps the outline — the geometry argument is unchanged — and carries **a centred dot** inside it, and the caption says which two they are: `31 of 31 · modules 6 & 8 have no battery sensor`. It read `${seen} sensors` until #187, which counted whatever turned up and so could never be short of anything.

⚠️ **The dot is a round-capped `<path>` with `vector-effect: non-scaling-stroke`, not a `<circle>`.** The viewBox is stretched horizontally (below), so a circle arrives as an ellipse — measured 9.8 × 6.1 px at 390 px. `sparkline()` uses the same property against the same stretch.

⚠️⚠️ **And the path is `l 0.01 0`, not `l 0 0` — WebKit ignores `non-scaling-stroke` on a zero-length subpath.** This is the trap that nearly shipped: `l 0 0` is how a dot wants to be written, it renders a true 3 px-radius round dot in Blink, and it was designed, measured and gated there. `public/index.html` says iOS is the only platform this page is ever opened on. Four cases in one stretched viewBox (`0 0 100 88` at 800 × 352, anisotropy 2.0), rendered in Blink and in WebKit via `qlmanage -t`:

|  | mark | Blink | WebKit |
| --- | --- | --- | --- |
| A | `l 0 0`, round cap, **with** `vector-effect` | round dot, hit-tests 3/3/3/3 | **flat ellipse** |
| D | the same path **without** `vector-effect` | ellipse, 24/24 × 12/12 | flat ellipse — **pixel-identical to A** |
| E | `l 0.01 0`, **with** `vector-effect` | round dot, 3/3/3/3 | **round dot** |
| B/C | a real `<line>` with / without it | thin / 4× thicker | thin / 4× thicker |

B against C proves the property works in WebKit at all; A against D proves the zero-length subpath is what it refuses to apply it to. On the real grid that costs `scaleX` 3.256 against `scaleY` 2.045, so an un-scaled 6-unit stroke paints **19.5 × 12.3 px** in a cell 106.6 × 15.1 px — a lopsided blob at exactly the 1.59:1 the `<circle>` was rejected for, filling 81 % of the row. 0.01 user units is 0.03 device px: invisible in both engines, degenerate in neither.

⚠️ The lesson outlives the mark. This dashboard is gated with screenshots from **Blink** and read on **WebKit**, and `lib/svg.js`'s header has warned since it was written that "WebKit is untested and this page is only ever read on a phone". A measurement in one engine written up as a property of the code is the shape of mistake CLAUDE.md's citation bullet is about — it _was_ measured, and the sentence said "at any width" when it meant "in Chrome".

**The count is against 31, not against 33 and not against whatever arrived.** `moduleTemperatureGrid()` in `lib/cells.js` decides all three states, and `moduleTemperatureKey()` returning `null` is the only thing in `public/` that knows a sensor does not exist — so the distinction is drawn where that knowledge is, rather than at the drawing code, which sees only a `null`. `scripts/check-module-heatmap.ts` holds the expected set against `registry.ts` and the two module numbers against `decode-bms.ts`'s `LMUS_WITHOUT_BATTERY_TEMP`, a mirror this repo had only ever asked for in a comment.

Row labels are HTML beside the SVG, not `<text>` inside it. The grid stretches to the tile width with `preserveAspectRatio="none"` so the cells stay big enough to read, and that stretch would render glyphs noticeably wider than tall.

⚠️ **How much wider is not a constant, and this paragraph claimed one for a year.** `scaleY` is pinned — `.heatmap` is `height: 180px` over a viewBox 88 units tall, so it is always 2.045 — while `scaleX` is just the tile width, which is the viewport's. Measured: **1.59 at the 390 px this screen is designed for** (svg 325.61 × 180), and **2.13 at 500 px**. The figure this paragraph used to give, 1.9, is neither, and back-solves to a ~453 px viewport that nothing here targets; it could not be sourced and has been replaced by the mechanism plus one anchored measurement. The claim beside it — that the two grids stretch by different amounts "since the two grids have different viewBox heights" — was simply false: `heatmap()` computes `height = rows.length * 8` and both grids build `MODULE_COUNT` rows, so both are `0 0 100 88`.

### Tile pacing — `lib/tiles.js`

`trace()` is bound to `chartTick`, not to the signal: redrawing a polyline on every frame of a 20 Hz signal is pure battery drain for motion no eye can use. The colour is sampled off the ring rather than read from the signal state for the same reason — reading `.val` there would re-subscribe the binding to the signal and cancel the throttle entirely. It is shared by `SignalTile` and `PairTile` so the pacing rule has one home; it is exactly the kind of thing that gets fixed in one copy and not the other.

`SignalTile` is where the plausibility gate becomes visible: a rejected reading shows as "sensor fault" instead of silently freezing, because on this bike that means a probe worth going and wiggling. Never-seen is not the same as faulted — a signal that arrived and then went out of range keeps its tile and shows the fault.

The fault notice compares `peekServerTime()` against `active.ts`. Server time, not `Date.now()`: `active.ts` is stamped by the Pi, and comparing it against this device's clock measures the gap between two machines rather than the age of the fault. Peeked, not read through `.val`: `apply()` sets `serverTime` on every message including 20 Hz patches, so subscribing would rebuild the div at frame rate. The `chartTick` read above it is what makes the notice expire on its own instead of hanging around until the next fault.

`PairTile` shows two related numbers — "28 / 29", min over max — wherever the pair means more together than either does alone: pack temperature extremes, coolant in and out.

### The derate knee — `views/charge.js`

`DERATE_KNEE_C` = 55. This is the number that decides how long you stand at the charger, and it was invisible on this screen.

The knee is exact rather than fitted, because it is what the BMS config does: the pack reports a flat 35 °C to the VCU and only starts telling the truth once a cell reaches 55 °C, at which point the VCU sees the real number and throttles. Visible in the log — across every sample where the true `batt_temp_hi` read 50, 51, 52, 53 or 54 °C, `batt_temp_hi_vcu` was exactly 35.0; at 55 °C it jumps to the real value.

The DC session of 2026-08-09 shows the consequence: 18.5-18.9 kW steady from 50-53 °C, dipping at 54, and 8.7 kW average at 55 — less than half.

So the tile counts down against the TRUE temperature (`batt_temp_hi`, sourced from `0x660`), not the clamped one the VCU reads, which is flat at 35 and would show no approach at all.

---

## Light and dark — `lib/theme.js`, `style.css`

The dark screen washes out in direct sun. `lib/theme.js` resolves one of two palettes and stamps it on `<html>` as `data-theme`; `style.css` carries both under the same token names.

**The bike chooses it.** `0x400` b5 bit 7 is the dashboard's own day/night flag (`docs/can-0x400-day-night.md`), and the phone follows it directly, with **no hysteresis** — the owner's explicit call: _"it doesn't really strobe that much on the bike, I think it's cooler if they switch in tandem."_ That is worth knowing rather than discovering: the bit changed **55 times on one 5 h 32 min ride**, so the phone flips more often than the bike's own dash appears to — §4.4 there has the run-length distribution. No smoothing layer was needed to build this and none should be added without asking him — `signals.ts` is log-on-change, so a patch only goes out when the bit actually flips and the repaint lands on that frame.

**The fall-through is the design:** an explicit choice from the menu sheet is never overruled by the bus; otherwise the bike while it is talking; otherwise the phone's own `prefers-color-scheme`. The middle branch is gated on the reading's own age (`ageOf`, 10 s) rather than on `isStale()`, because `isStale` folds in link liveness and would repaint the whole screen over a twelve-second socket blip. `0x400` is 100 Hz, so that window is unreachable while the bus is live and cannot delay a flip; it only decides when a sleeping bike hands the question back to the phone.

There are four states, and the age test only covers three of them:

| state | what happens |
| --- | --- |
| never connected, or the bike has never sent `0x400` | `valueOf` is `null` → the phone decides |
| bike awake | the flag is milliseconds old → the bike decides, and a flip lands on the frame |
| bike asleep, socket up | heartbeats advance `serverTime` while the flag's `ts` does not, so it ages out → the phone decides |
| **socket down** | **`serverTime` freezes with the messages, so the age stops growing and the theme HOLDS its last value** |

That last row is deliberate rather than an oversight, and it is the same property that stops a twelve-second blip repainting the screen: while nothing is arriving there is no new evidence about the light outside, and holding is better than snapping on the strength of a dropout. It is also why this is not additionally gated on `connection` — that would reintroduce exactly the snap the age test was chosen to avoid. A link that stays down leaves the theme on the bike's last word until the rider touches the toggle, which is what the toggle is for.

⚠️ **`style.css` deliberately has no `prefers-color-scheme` media query.** A media query would be a second answer to the same question, and the two would disagree the moment the bike says one thing and the phone says another. The cost is that the first paint is dark until `theme.js` runs.

**Why light rather than a higher-contrast dark.** The mechanism is that reflected ambient light adds a roughly constant luminance to ink and ground alike, which compresses a dark theme's ratio far more than a light one's. ⚠️ Stated as the reasoning, **not** as a measurement — nobody has measured this screen in sunlight, and the kickoff named high-contrast dark as a first-class alternative. If it turns out to be wrong, the toggle is right there.

**The light ramp costs separation to buy contrast, and the trade is measured.** Today's accents are 1.2–2.8:1 on white, so a light theme needs its own ink ladder rather than a background swap. On `#f1f5f9` — the light **ground** now, and the tile colour before the two surfaces swapped — the Tailwind 800 step is the FIRST that clears 6:1; the 700 step tops out at 5.91, and darkening yellow and orange that far walks them towards the same brown:

|             | min contrast             | worst adjacent separation (Δa\*b\*) |
| ----------- | ------------------------ | ----------------------------------- |
| dark, today | 5.29 (`--bad` on a tile) | **38.7**                            |
| light       | **6.25**                 | **16.0**                            |

The light palette _beats_ the dark one on contrast and loses more than half the hue separation. For a theme whose whole purpose is direct sun — where glare degrades hue discrimination anyway and luminance is the binding constraint — that is the right side of the trade, but it is a real cost and `scripts/check-theme-contrast.ts` pins both ends of it so the next person can argue with it instead of rediscovering it.

**No transition on the flip, and that is measured rather than taste** — a cross-fade on the ground alone leaves the ink already switched over it, i.e. blank for the whole fade. `style.css` carries the argument at the point where someone would add one back.

### The cards, and why light gets an edge where dark gets a ground

Tile against background measured **1.22:1** dark and **1.10:1** light, and under a scatter-plus-veil simulation the light theme's cards disappeared altogether. The two themes need different answers:

- **Dark darkens the ground** (`#0f172a` → `#090f1c`), 1.22 → **1.31**. Nothing can drop, because no ink is measured against the ground it leaves — in particular `--bad` on a tile stays at exactly the 5.29:1 that is this file's one exemption. Lightening the _tile_ instead would have taken it to 4.90.
- **Light cannot buy separation at all.** The status inks are the first Tailwind step clearing 6:1 on `#f1f5f9`, so the ground cannot go below about L = 0.87 without re-deriving the whole ramp — which caps tile-against-ground at about 1.12:1 against today's 1.10. So light **swaps** its two surfaces (ground `#f1f5f9`, tiles white). Every ink ratio moves to the other column and both columns already passed, so this is free; what it buys is polarity, cards brighter than the page rather than recessed into it.
- **The separation comes from an edge instead.** `.tile` and `.hero` take a 1 px `var(--tile-edge)` border: **1.69:1 clean and 1.35:1 veiled** in light, against 1.10 and 1.06 for an area difference. `--tile-edge` is not an ink and is measured against no floor, so this costs nothing in the ramp.

### The type is thin, not low-contrast

The speed measured 11.9:1 dark and 16.3:1 light — far past any floor — and was still hard to read at speed. Contrast says how far the ink is from the ground and nothing about **how much ink there is**: at weight 200 the 64 px numeral put a **3.33 px stem** on the glass, and scatter through a dirty visor is a low-pass filter that takes thin strokes first. Weight, not colour, was the binding constraint.

Values are 500, labels and section headings 600, sub-lines and units and tabs 500, the active tab 600. Measured on the rendered page rather than from the palette: the speed's stem goes **3.33 → 6.83 px**, a tile value's **2.33 → 3.83**, a label's **1.00 → 1.50**.

⚠️ One weight ladder serves both themes. Light was expected to need a heavier one (white-on-dark blooms, dark-on-light does not) and the difference did not justify two ladders to keep in step.

⚠️ `.tab` takes its weight **after** `font: inherit`, not before it. The shorthand resets `font-weight`, so a declaration above it is silently thrown away — measured on the render, where the tabs stayed at 400 while every other weight had taken.

## The toast banner — `lib/toast.js`

Everything else on this dashboard answers a question you went looking for. This answers one you cannot go looking for: a handlebar gesture gives no feedback of its own, so without it a long press on the bars is indistinguishable from a long press that did nothing, and the rider's only recourse is to stop and check.

The constraints are the ones `style.css` opens with — read at speed, through a visor, in daylight — plus one more that follows from where the input came from:

- **Never waits to be dismissed.** A gesture is made with both hands on the bars, so a banner needing a tap would be a banner that sits there until the next stop. It times itself out, and `pointer-events: none` in `style.css` means it cannot swallow a tap meant for whatever is underneath it either.
- **Says WHICH way it went in colour as well as words**, so the outcome is readable before the sentence is.
- **Full width at the top, over the header.** Sunlight legibility is mostly area and contrast, and the header carries nothing that cannot wait a few seconds.

`TOAST_GOOD_MS` = 5000: a gesture is often made in the middle of something — coming to a stop, putting a foot down — so this has to outlast the moment between triggering it and having a glance to spare. Five seconds covers that without leaving the header buried.

`TOAST_BAD_MS` = 9000, longer for two reasons: it is a longer sentence, and it is the one that asks for a decision — a waypoint that was not saved is only recoverable if the rider learns about it while still at the place they wanted to remember.

The timer is restarted, not extended: the newest message is the true one, and it gets its own full reading time rather than inheriting the remainder of the last one's.

### What raises one, now that the gestures are the Pi's — `lib/announce.js`

The banner used to be raised by the code that had just recognised a gesture and called an endpoint. That code is on the Pi now, so this page finds out the way it finds out about anything else: off the live signals. `lib/announce.js` watches two things and raises a banner when either moves.

- **The fan**, keyed on `fan_auto_mode` plus whether `fan_target_pct` is above zero **while manual** — four states: automatic, fun, manual-running, manual-stopped. ⚠️ The key is deliberately coarser than the sentence it prints. A thumb dragging the slider from 40 % to 60 % must raise nothing, where a key carrying the duty would raise one banner per command at up to seven a second; and the zero-crossing is scoped to manual because in automatic the curve takes the duty through zero on temperature several times an hour on a warm pack.

  ⚠️ **The two signals are a PAIR, and they must arrive duty-first.** The mode picks the sentence and the duty fills in the number, so a mode that reaches the phone in an earlier patch than its own duty is worded from the duty of the mode before it — which said "Fan: manual 68 %" over a fan at 100 %, and "Fan: off" over a fan going to full. The ordering that prevents it lives in `src/fan/auto.ts`, the eleven measured instances and the argument are `docs/fan-control.md` §"The two fan signals must reach the phone duty-first", and `scripts/check-fan-banner.ts` replays the real patch sequence through `foldFanAnnouncement()` so a re-ordering goes red rather than quiet.

  ⚠️ **A third signal words two of the four sentences without entering the key.** `fan_off_state` says whose _off_ the fan is in — the handlebar gesture's, which ends at 15 km/h, or the slider's, which does not — so the gesture's step reads **"Fan: off until 15 km/h"** and the slider's still reads a plain **"Fan: off"**. The same signal marks the watchdog's hand-back, which reads **"Fan: automatic (moving)"** rather than a bare "automatic", because that one is a thing the bike did and the rider did not ask for, which is the whole reason this banner exists. It is read with `peek()` and never with `valueOf()`, and it is deliberately kept OUT of `fanAnnouncementKey()`: a key carrying it would raise a banner on a bare disarm — the fan unchanged, the sentence changing — and would break the four-distinct-keys rule the cycle depends on. `docs/fan-control.md` §"What the phone says about it".

- **Waypoints**, off `waypoint_seq` and `waypoint_refused_seq` — counters, not values, because `record()` seals a row only when the value MOVES, so two identical refusals in a row would otherwise be one banner and the second hold at the same spot with the same stale fix would look like it had worked. The refusal codes are `WAYPOINT_REFUSAL` in `src/gps/waypoint.ts` and their sentences are in `lib/announce.js`, the same arrangement `FUN_GATE_TEXT` uses.

The first reading after load is adopted **silently**, and so is the first after the link returns to `live`. `lib/connection.js` closes the socket while the page is hidden, so a phone taken out of a pocket reconnects to a full snapshot — and announcing that would be announcing ten-minute-old news as if it had just happened. Same rule as "a hold we never saw begin is not a gesture".

⚠️ **It does not try to tell a gesture from a tap on this phone's own controls, and that is a decision.** The WebSocket patch normally arrives BEFORE the HTTP reply that would register "this was me", so suppressing self-originated changes would have to be a time window rather than a match — and a window that misfires swallows the banner for a real gesture, which is the one failure the banner exists to prevent. A redundant banner over a control you are already looking at is the cheaper wrong. The cost is one extra banner when the rider taps Auto or saves a waypoint from the sheet; `views/sheet.js`'s "no banner from here" still holds for that button's own inline note.

---

## The menu sheet — `views/sheet.js`

### Headings are `h2` / `h3`, and that is the whole of what makes the hierarchy real

`sheet-heading` for the sheet's own sections, `sheet-title` for the subsections inside one of them. Nine headings all rendered as small grey caps is what "there is zero visual hierarchy in the menu" was mostly about: "Service actions" announced itself as loudly as "This session" and nothing said which was inside which.

**⚠️ `h2` and `h3`, not divs.** Everything else about the hierarchy — size, weight, colour, the rule above — is paint, and paint reaches exactly one kind of reader. Until this change there was not a single heading element anywhere in `public/`, so VoiceOver's rotor listed nothing and this sheet was one flat run of text to it: no way to jump to "Change something on the bike", and no way to hear that "Service actions" is INSIDE it. A risk hierarchy that only the sighted can navigate is half a hierarchy.

The levels are relative, and start at 2 because the sheet is a section of a page rather than a document of its own. Both classes set font-size, weight, colour and padding explicitly, and the reset at the top of `style.css` zeroes UA margins, so nothing renders differently — checked by measuring every heading before and after.

Only two sections carry a one-line "what can this do to the bike" subtitle, and they are the two either side of the read/write boundary, where the bit is not obvious. "Actions" has none: three sections carrying that sentence was one sentence too many for a single bit of information, and both controls in it are in the grey tier, which says the same thing without a sentence.

The "Service mode" subtitle used to end "…the section that can change it is further down", which was prose apologising for the layout — if a sentence has to tell you where the other section is, the boundary is not doing its job. The boundary now does it: the write section has a rule in the one colour nothing else on this sheet uses for a rule, and states its own risk under its own heading.

### There is no "Link" section, deliberately

A per-source liveness readout was here in two shapes and neither could be read: a grid of sixteen fractions needed the reader to know sixteen normal denominators (BATTERY 17/46 is a HEALTHY parked bike), and collapsing it to "what is dark" cried wolf instead.

`security` is the case that was actually measured, over the 246 archived captures (14.4 GB). Its liveness rests entirely on `0x480`, the other signal in the group being the one-shot E-LOCK read at startup — and `0x480` comes in bursts, so with `FRESH_MS` at 10 s the group reads dark for most of the wall clock even in captures where the frame is there. It reads live for 24.8 % of a 19.5 h capture (173 224 frames, and a 13.6 h hole in the middle of it), 28.3 % of a 6.7 h one, and 0.04 % of a 69 h one whose 917 frames arrive in two bursts — 174 in 17 s at the start, then nothing for 1 h 44 min, then 743 in 74 s — and nothing after. Two more multi-hour captures have no `0x480` at all. Those spans include parked and charging time, so this is % of wall clock rather than of riding — the two cannot be told apart from a candump.

`obd` under `OBD_ENABLED=0`, `coolant` on a probe-init failure and `gps` without a fix are the same shape, unmeasured because none of them reaches a candump. Every exemption is individually defensible and the list only grows, which is the tell: a widget that always names something teaches the rider to skip the name, which is the failure it exists to prevent.

The per-group numbers stay in `/status`, and are more correct there than they were: `summariseGroups()` is seeded from the registry, so a source that has never spoken reads `[0, n]` instead of vanishing. One group did leave the payload — `waypoint`, excluded by design now (see `onDemandOnlyGroups()` in `src/http/status.ts`), where before it appeared once a waypoint had been saved this boot. This is a decision about what belongs on a phone at the handlebars, not a retreat from measuring liveness.

---

## Service mode: reading the VCU — `views/service-mode.js`, `lib/params-page.js`

### Why the sweep lives in the sheet, and the table is a page of its own

Service mode reads the VCU's calibration parameters off the bike on demand, and hands the result over as the file another owner's `energica_tool.py` reads. It lives in the menu sheet rather than the tab bar for the same reason `/params.html` does: every tab in the dashboard is something you look at while riding or charging, and 277 calibration constants are a question you ask standing next to a parked bike with a laptop. Putting them in the tab bar would cost a thumb-sized target on a screen read through a visor at speed. The sheet is already where the actions worth having when you stop live — the waypoint, the ride-log download — and `/params.html` is one tap from the same wifi and costs the riding views nothing.

`/params.html` is plain DOM with no VanJS: it is a static list you read once in a garage, not a live gauge, so there is nothing to bind to and a page that renders once is the whole job.

### The gate is shown, not just enforced

The read only starts with the bike stationary and out of drive, and it stops by itself the moment that changes (`src/vcu/service-gate.ts`). The page leads with what the gate currently says, because a button that is disabled with no reason given is indistinguishable from one that is broken — and the reason is specific enough to act on ("the bike is not in drive — it reads 1" tells you to switch the bike off, not to reload the page). The server is still the authority: the page never decides that a read may start, it only reports what the Pi said.

### Nothing here blocks

A sweep is ~277 reads over a link that drops as routine, so the button starts it and returns. Progress comes from polling `/vcu-read` once a second while the sheet is open AND there is something to watch — a sweep running, or a gate that is refusing and might stop refusing. Idle and safe, it does not poll at all: a dashboard left open on a workbench must not poll the Pi for the rest of the day. Closing the sheet, locking the phone or walking out of wifi range does not stop a sweep; it runs on the Pi, and re-opening the sheet picks the story back up.

The elapsed timer counts from a phone-side monotonic mark taken when the page first SAW a sweep running, not from `run.startedAt`, which is the Pi's wall clock: the Pi has no RTC and steps its own clock from GPS, so subtracting it from `Date.now()` on the phone is arithmetic across two clocks that disagree. The cost is that the timer reads from when the page noticed rather than from the true start, which is why it is labelled "watching for" and not "running for".

### Why the sweep button arms first

It is the only control in the dashboard that causes traffic on the bike's bus. It cannot write anything — the read-only argument is in `src/vcu/param-codec.ts` and nothing on the page could widen it — but ~277 requests do compete with the OBD poller for a bus that is already the scarce resource, so it should not be reachable by a thumb landing in the wrong place while the sheet scrolls. Two taps, no modal.

`confirm()` is deliberately not used anywhere in this dashboard: it is a browser dialog that lands in the wrong place on a phone, and it cannot show a two-line before/after.

### The other `armed` — and what the sweep's two taps do not have

⚠️ **Resolved 2026-09-08, and not by anyone deciding to.** The in-service lifetime read (#156) needed a button on this same sheet, and importing `lib/arming.js` for it put `service-mode.js` into `check-arming.ts`'s `ARMING_CONSUMERS` automatically — at which point the sweep's own `armed.val = true` failed the "every assignment outside arming.js disarms" scan. So the sweep moved onto the shared gate too, and gained the 400 ms dwell and the key-repeat refusal it never had. The section below is kept because the argument for tolerating it — that the worst an unmeant double-tap bought was 277 read requests — is exactly the argument that stopped applying when a control on the same sheet also parks the OBD poller.

⚠️ **This button did not use `public/lib/arming.js`** (past tense since the paragraph above — kept because the argument for tolerating it is what stopped applying). `views/service-mode.js` declares an `armed` of its own — `van.state(false)`, a boolean rather than a key — and its `onclick` is the arm/fire pattern as it stood before 2026-08-19: `if (!armed.val) { armed.val = true; return; }` and then straight into the request. So the sweep has **no `ARM_DWELL_MS`** (two synchronous clicks arm it and fire it, which is exactly the gesture measured against `31 FC`), **no `refuseKeyRepeat`** on the button, and no shared key — arming it disarms nothing else, and arming anything else does not disarm it.

Found 2026-08-30 while writing `scripts/check-arming.ts`, which is why that check scopes its "every `armed.val =` disarms" scan to the modules that import the shared gate: unscoped, it reads two different states as one.

It is recorded here rather than fixed in the same breath because the consequence is not the same. This control cannot write: the worst an unmeant double-tap buys is ~277 read requests competing with the OBD poller, on a bike the server-side gate has already established is parked and out of drive, and stopping it is one tap. The claim it does falsify is the one in `arming.js` — that there is "one rule for every second tap on this dashboard" — which was never true of this button. Moving it onto the shared gate is a behaviour change to a control and belongs in its own PR; what it costs is the boolean, since the shared state is keyed.

### Which parameter table the names came from — `lib/params-page.js`

Every name on `/params.html` comes from the table THE BIKE ITSELF named at 276/277 — the Pi re-names the stored snapshot from it before serving it — or from a default when the bike has named none. The table-type line is the thing that says which, and there is no other way to tell: a wrong table is invisible in every other way, because routing and record widths are identical across all 28 of Energica's tables, so a bike on the wrong one reads and writes perfectly and merely means something else by every name.

That is not hypothetical. This bike was asked on 2026-06-14, the answer sat unread in a dump for two months, and the table embedded here was one revision out the whole time — right about 276 of 277 names and silently wrong about the 277th. And on 20 of the 28 tables ids 70–94 are a regen fade curve where the other 8 have the battery cell block, so on somebody else's bike the same silence would be worth 25 names rather than one.

The verdict is computed on the Pi (`src/vcu/snapshot.ts`, `reportTableType`) so there is exactly one copy of "which table are we".

Three states, three appearances. "A micro never answered" must not render identically to "both agree" with only an emoji between them — that is the state this bike is in today, and rendering it as normal is the whole failure this line was added to stop. `split` counts as alarming: two micros naming different tables means some of the names on the page are one table's and some are the other's, which is worse than either being wrong on its own. An alarming verdict also goes to the console, because it is the one finding on the page worth pasting into a bug report verbatim.

`ageInWords` in `lib/format.js` is where the phone-clock reasoning lives now — three pages were computing it inline off the same `readAt`, with thresholds that had already drifted apart: `/params.html` said "73 h ago" where the same snapshot on the service sheet said "3 days ago".

### The probe form — REMOVED 2026-08, was `views/vcu-probe.js`

⚠️ **The form is gone; the `/vcu-probe` endpoint is not.** The panel was removed from the service sheet as clutter — a handful of uses ever, sitting in the scroll on every visit — and what it was wanted for is recorded on issue #51. The route stays live (`src/index.ts`) and stays exercised: the write flow's "read it off the bike again" calls it. Reach it with `curl -X POST -H 'X-Cool-Eva: service-mode' '<pi>/vcu-probe?target=A9&bank=2&index=258'`. Everything below describes what the form did, and is kept because the ENDPOINT still behaves this way.

"Probe index N" read ONE identifier off ONE ECU, from the phone. It is the replacement for `scripts/read-vcu-params.ts --index N`, which went away when the sweep moved into the service, and it reaches further than that flag did: the identifier is `(bank << 12) | index`, the sweep reads bank 1 (the calibration EEPROM), and **bank 2 is live data** — the running values rather than the stored settings — which nothing in this project had ever read.

**⚠️ It offered a CHARGE MANAGER target for part of 2026-08-16 and no longer does.** The id pair it was given, `0x7C3`/`0x7E3`, is not the charge manager's: **`0x7E3` is the dashboard's request id**, so that option could have questioned the dashboard while the page said otherwise. The real charge manager is 29-bit ISO-TP and needs transport work this form cannot fake. See `src/vcu/param-codec.ts` above `VcuTarget`.

**Why it is a form and not a link.** Because you do not know what you want until you are standing there. The whole use is "the manual mentions an address, what does this bike say about it", and that is three fields and a button — not a route, not a saved list, and not something to design a schema for before anyone has read a single bank-2 value.

**Why the result shows two numbers.** Outside bank 1 nothing here knows a record's width or whether it is signed. So the raw bytes lead, and BOTH the unsigned and the signed reading are shown, neither called "the value". Picking one would be inventing the half of the answer that was not read off the bus. Where the name table does have an opinion — a bank-1 index it describes — the typed value is shown as well, with its name.

---

## Service mode: writing — `views/vcu-write.js`

### ⚠️ Nothing on this page decides anything

The allowlist, the ranges, the compare-and-swap and the read-back all live on the Pi, in pure modules (`src/vcu/write-targets.ts`, `src/vcu/write-session.ts`). This page cannot widen any of them and does not try: it renders what `GET /vcu-write` says is writable and reports what `POST /vcu-write` says happened. If it and the server ever disagree, the server wins and the page shows the server's reason.

### How an accidental write is made hard

Four things, in the order they are met:

1. **A write is always against a value that was READ off this bike.** The number on screen is sent back as `expected=`, the Pi re-reads the parameter and refuses if it has moved, so a page left open since yesterday cannot write over a value it is not showing. The button stays disabled while nothing has read it at all.

   ⚠️ That reading may come from the last parameter SWEEP rather than from this page's own read button, and this is the one lock whose shape changed (2026-08-19). It used to insist on a per-parameter read here, which meant a completed 277/277 sweep — which had just read every one of these — left the form saying "not read yet" and demanding one of them again. The property that matters was never the tap: it is the compare-and-swap, and that is enforced on the Pi against a read taken DURING the write (`src/vcu/write-session.ts`), not against anything this page believes. So an older reading is not a weaker precondition — it is a likelier refusal, which is the safe direction. What the page owes in exchange is honesty about where its number came from and how old it is, which is the caption under it.

2. **The confirmation shows old → new**, spelled out in the button caption, and the button changes what it says between the two taps.

3. **Two taps, never one — and never one gesture.** The first arms and the second sends, and arming is dropped by ANY change to the form — retyping the value, picking a different parameter, a refreshed reading, or a refreshed status. That last one matters: it means a value that moved under you disarms the button rather than being written.

   ⚠️ And the second tap is refused for `ARM_DWELL_MS` after the first, because until 2026-08-19 "two taps" was satisfied by a double-tap: two synchronous clicks on "Say a service was performed NOW" really did POST `31 FC`. That was the single most likely accidental gesture on a phone — tap, see nothing change fast enough, tap again — arriving at the one action with no unset.

4. **The irreversible actions are behind a fold**, below the parameters, each with its own two taps and its own warning — and, collapsed, not on screen at all. They are not in a list you can scroll a thumb through, and since 2026-08-19 they are not in a list at all until somebody asks for one. Toggling the fold disarms, and the fold re-collapses whenever the sheet is opened.

### `ARM_DWELL_MS` = 400 ms — what was measured, and the alternatives

Measured in a browser at 390x844 on 2026-08-19, before the dwell existed: two synchronous clicks on "Say a service was performed NOW" produced a real `POST /vcu-write?action=set-service-point&confirm=set-service-point`, and the same on `clear-dtcs`. One gesture both primed and fired `31 FC`. `armed` was set synchronously, so nothing whatsoever separated the two clicks.

⚠️ The parameter write and the clock sync passed that same test BY ACCIDENT, and that is the part worth writing down. `armWrite()` and `armClockSync()` `await fetchStatus()` between arming and firing, which raises `busy` and disables the button, so the second click landed on a disabled control and was swallowed. A refresh was doing safety work as a side effect — so making it faster, cached, conditional or optional would remove the protection from two of the three irreversible controls without touching a line that looks like a guard. All three now hold the dwell deliberately. That statement stays at the constant, in the code.

Why a dwell and not one of the obvious alternatives:

| alternative | why not |
| --- | --- |
| a `dblclick` / `event.detail` guard | Only a mouse raises `detail` past 1. Two taps from a gloved thumb a few pixels apart are two ordinary clicks, and that is the actual gesture. |
| disabling the button for a beat | `.action:disabled` is visibly dimmed, so the control would flash "off" in the one moment its caption is asking to be read — and "it went grey and nothing happened" is the very stimulus that produces the extra tap. |
| press-and-hold | A gesture to learn, on controls nobody presses often enough to learn it. |

400 ms because it must cost the INTENDED flow nothing. The armed caption is ~45 characters ("⚠️ Tap again — STAMP A SERVICE NOW. There is no unset") and has to be found, read and acted on; nothing does that in under 400 ms. What 400 ms does cover, with margin, is every platform's own idea of two taps being one gesture — iOS and Android recognise a double-tap inside ~300 ms.

⚠️ A tap inside the dwell is IGNORED, never treated as a disarm. The button stays armed and goes on saying "Tap again", so an impatient double-tapper's next tap does what they meant; silently disarming would put them back at the start without saying so, which is a worse answer to the same gesture and invites a fourth tap.

`armedAt` is `performance.now()`, never `Date.now()`, for the reason CLAUDE.md gives for `monotonicNow()` on the Pi: this page has a button on it that STEPS A CLOCK, and the Pi steps its own from GPS. A wall clock that jumps backwards mid-gesture hands out a dwell that never elapses; one that jumps forwards hands out none at all. It is deliberately not a `van.state` — nothing renders from it, and making it one would re-run every caption binding on each arm to no visible effect.

`arm()` is the ONLY way `armed` is set to a non-empty key. Every arming site goes through it — `ActionButton`'s own `onclick`, `armWrite()`, `armClockSync()`, and `armChargeCurrent()` and `armChargeStop()` in the charge tab — so no control can be armed without also being subject to the dwell. Disarming stays a plain `armed.val = ""` and needs no stamp: every firing site tests `armed.val` first, and an empty key matches none of them. `scripts/check-arming.ts` §7 asserts it by reading every `armed.val =` assignment in the modules that import this gate: a control armed without a stamp inherits whatever the last one left behind, and fires on the tap after it.

`arm()`, `armDwellElapsed()`, `refuseKeyRepeat()`, `ARM_DWELL_MS` and the `armed` state moved to `public/lib/arming.js` on 2026-08-24, when the charge tab grew a bus-writing control of its own. They are shared so there is ONE dwell rule for the whole dashboard rather than a second copy that could drift.

⚠️ **That move was argued on the grounds that the surfaces are only ever visible one at a time, and that is no longer true.** The charge tab gained a second armed control the next day (`charge-stop`, 2026-08-25), so set-current and stop are on screen together for the whole of a live charge — and the sentence claiming otherwise stood in both this file and `public/lib/arming.js` until 2026-08-30. One shared key is still the right shape: every firing site tests its own key before it acts, so a tap on either of those two cannot fire the other however the arming went. What co-visibility costs is a UX detail rather than a safety one, and it is now the honest reason to keep the key distinct per control: arming one of the pair silently disarms the other, whose caption drops back from "Tap again" with nothing said. Both halves — the key test and the single shared state — are pinned by `scripts/check-arming.ts`.

### Why `event.repeat` rather than a longer dwell — `refuseKeyRepeat()`

The one hole `ARM_DWELL_MS` does not close, and it does not close it by arithmetic: macOS repeats a held key at about 500 ms, which is on the far side of the 400 ms dwell, so Enter held down on an armed button would arm on the first event and fire on the repeat. Raising the dwell past 500 ms would be the wrong answer — it would slow the gesture that actually happens (a thumb) to close a hole that only a keyboard has, and the repeat interval is a per-machine setting that can go slower still.

`event.repeat` is the browser saying "this is the same press continuing", which is precisely the distinction wanted, so the guard is exact rather than timed. Enter's activation of a `<button>` is the default action of the keydown, so preventing it there is what stops it; Space activates on keyup and so repeats harmlessly already.

The guard is qualified by key, or it would cancel every held key on these five buttons — a held ArrowDown, PageDown or Tab would stop scrolling dead after one line, which is a real cost on a phone paid to prevent something only a keyboard can do.

There is no keyboard on a handlebar-mounted phone. This is here for the same reason `.sheet` gained `visibility: hidden` — the argument for the fold is that an irreversible action must not be reachable by accident, and "the hardware makes it unlikely" is a different claim from "the page does not allow it".

### The confirm token — `confirmationFor()`

`confirm=` is the Pi's precondition for every action it will not perform on one request. It is PROTOCOL, not prose: `notes.confirm` is the caption tail and may be rewritten freely; this is the string `src/http/vcu-write.ts` compares against, and getting it wrong does not read wrong — it makes `31 FC` and Mode 04 refuse on every press with a 400 nobody expected. That statement stays at the function, in the code.

It is one function rather than the rule living at each `performAction` call site, because `scripts/check-irreversible-actions.ts` asserts these against the server's own parser, and a check holding its own copy of the rule would agree with itself while the page had moved. It is the same parallel-array shape the fold's contents list had to lose, and it does not get to come back in the check that guards it.

The clock's token is the minute the button is currently SHOWING, in the shape the server checks: `2026-08-16T14:03Z`. Sliced out of the Pi's own `clock.iso`, so the value confirmed and the value displayed are the same string from the same clock. If the sheet has gone stale the server refuses and names both minutes — the intended behaviour, and the refusal itself refreshes the state so the next attempt shows the right time.

Everything else confirms by naming itself. The server wants `confirm=clear-dtcs` for `action=clear-dtcs`: the point is that a request cannot be built by guessing the action name alone, not that the token is unguessable.

The clock action's second tap therefore agrees to a fact ("is it 14:03?") rather than to an intention, which is why it is not an `ActionButton` and writes its own confirmation. The minute CONFIRMED is derived from the one that was DISPLAYED, never from the phone's own clock: they are two different clocks, so sending `new Date()` would mean the Pi checked the phone's freshness while the owner had agreed to a statement about the Pi — a stale caption would sail through, and a phone a minute out of step could never sync at all.

### The three risk tiers

The page contains three kinds of thing and is painted so that it looks like it does, because a rider glancing at this on a handlebar-mounted phone should be able to tell them apart BEFORE reading any text. The colours and the left-edge gutter that carries them are defined once in `public/style.css`; `views/vcu-write.js` only says which control is which.

| tier | what is in it |
| --- | --- |
| **read** (grey) | The probe read, the parameter read, the service-stamp read. Cannot change the bike — and it is the DEFAULT, so a control acquires risk by being marked, never by being forgotten. |
| **write** (amber) | The parameter write. Changes the bike and can be written back, which is what makes it a middle tier rather than a red one. |
| **irreversible** (red) | `31 FC`, Mode 04, the clock. Behind the fold, and each carries in red the one thing it cannot take back. |

### Where each sentence belongs

The allowlist carries three kinds of prose about each entry and they are read at three different moments, so they are shown at three different ones — and the service actions are split the same three ways (see the `ActionNotes` typedef):

- **purpose** — what this parameter IS. Always visible, in grey: it is how you know you are on the right one.
- **warnings** — why you might not want to. Amber, behind one tap, because there are up to four of them per parameter and stacking four amber paragraphs above the input is how a phone in a garage becomes unusable — and how warnings stop being read at all. The toggle says how many there are and stays amber while they are collapsed; nothing is dropped. The per-bit caveats are folded into the same list rather than kept in a block of their own: they are warnings about the same act, and two separately-headed lists of amber paragraphs was half the problem.
- **verify** — how to check the bike afterwards. Shown AFTER the write, next to the outcome, because that is when it is actionable. Deliberately not before: it is an instruction for afterwards ("`0x625` b2 should now read…"), it was one of four amber paragraphs competing with the ones that argue against pressing the button at all, and standing in a garage the moment it becomes useful is the moment the write has landed. Both the clean write and the read-back mismatch get it — the mismatch is exactly the case where an independent check is worth most. A refusal or a stale precondition changed nothing, so there is nothing to go and look at.

The service actions add a fourth kind that no parameter has: **what this cannot take back**. Red, never more than one short line, and it leads the other three.

`NoUndoLine` is bigger and heavier than the other two kinds of note, not just redder. Red is the dimmest ink this palette has — `#f87171` measures 6.5:1 on the sheet where a heading measures 14.5:1 — so a page that carries severity in hue alone puts its most consequential sentence at the BOTTOM of its own contrast ranking, under every throwaway grey line on the screen. Weight and size are the channels that survive that, and they are also the two that survive daylight through a visor. No glyph: at this size 🚨 renders as an anonymous red smudge, and the line is already red and already begins with the word IRREVERSIBLE.

The category is a BADGE and the consequence is the sentence, rather than both being one shouted string. "IRREVERSIBLE" appeared five times in a screen and a half — section deck, fold label, and once per card — at which point it stops being read at all, while the only new information on each card is what came after the dash. The badge is identical on all three because the category is; what differs gets the weight. `CLOCK_NO_UNDO` starts with the same shouted token for the same reason: the red line is one slot in three cards, and a slot that holds a token on two of them and a sentence on the third is not a slot. What comes AFTER the dash is where the clock differs, and it differs in the direction that matters — you can set the clock again, but nothing can tell you what it held before or that this landed at all.

The consequence goes ABOVE the button, not under it. On a phone, reading order IS tap order: with the consequence underneath, the thumb reaches a 55 px target before the eye reaches the sentence saying the target cannot be undone. The one line that could stop somebody has to be crossed on the way to the control, not found after it. Everything that is not a consequence — what it does, what to check first — stays below, where it is read once you have decided to look properly.

`action-block` is one control and the prose that belongs to it. It exists so the gap BETWEEN two actions can be bigger than the gap between an action and its own notes — otherwise "read the stamp above first" sits as close to the next button as to the one it is about, which on this list is a sentence attached to the wrong irreversible action.

The tier a button is painted is derived from the prose rather than passed alongside it (`notes.noUndo !== undefined`), so a red button with no line saying what it cannot take back is unexpressible.

### ⚠️ One lock that is not about care at all — the table-type gate

The table-type gate (`src/vcu/table-gate.ts`) disables the write button outright until the bike has said which of Energica's 28 parameter tables it runs, because a parameter is written BY INDEX and a name is only a claim about a table. It disables the WRITE button and nothing else: the read button and the service actions stay live, deliberately, because the way out of the blocked state is a READ.

`canWrite()` is kept separate from `canReach()` rather than folded into it, and the separation is the whole design. `canReach()` still governs the read button and the four service actions, so an unconfirmed table blocks writing by index and leaves everything else exactly as it was — including the read that clears it. Folding this in would produce a page that refuses to let you fix the thing it is refusing over. The server enforces the same precondition twice more regardless (the runner refuses the request, and `src/vcu/write-codec.ts` refuses to encode the frame); the page is declining to offer a button whose request would be refused, which is the same relationship it has to the allowlist and the compare-and-swap.

The blocked states are rendered DIFFERENTLY on purpose, in colour and in words, because they are not the same problem:

- **no read will help (red)** — the bike named a table this software does not carry, the two micros named different tables, or the table is carried and an allowlisted parameter is not called that on it. Every parameter name on this page may belong to a different parameter, and the fix is a table or a change in the Pi's source — the server's `remedy` says which.
- **a read will (amber)** — nobody has asked the bike yet, or a reply was malformed. One read clears it, and the `remedy` names exactly which: parameter, micro and request bytes.

The branch is on `noReadWillHelp` rather than on `state`, deliberately. It used to test `state === "mismatched"`, which quietly made every state added later render as amber "nobody has asked yet" with an instruction that leads nowhere — and two such states have since been added (`split`, `unwritable`). The server decides which kind of blocked this is; this file only decides what colour that is.

A single "writes are blocked" would send someone hunting for a software bug when the answer was one frame, or the other way round. The sentences come from the Pi (`src/vcu/table-gate.ts`) rather than being written again here: deciding what a `TABLE_TYPE` reading means needs all 28 parameter tables, and a second copy of that reasoning in a file the checks cannot reach is the exact drift this gate exists to catch — the same argument `/vcu-params` makes for computing its banner server-side.

The note is rendered in the blocked branch TOO, not only in the safe one. It is the same person on the same trip: the reason they cannot write this second is the vehicle-state gate, and the reason they still will not be able to once they park is this one. Showing them one at a time means a second walk out to the bike — and the write button is rendered whenever writing is enabled, so it would otherwise be saying "see above" with nothing above it. It is silent when confirmed: the line above already says writing is available, and a green "table confirmed" badge would be one more thing to read past every time.

### The section heading and its note

A level-1 heading, and the only amber one: this is the line the sheet's read half ends at, and the rule above it is the widest single piece of separation in the whole panel. `views/service-mode.js` has carried the boundary as a comment since it was written; the heading is the same statement, where a rider can see it.

⚠️ The amber and the line under it are governed by `hasControls()` — THE SAME condition that decides whether the controls render at all. That is the point of it being one function: a warning about what is under a heading must appear and disappear with the thing it is warning about, and it cannot be made to disagree by any state this page can be in. Two states have nothing under the heading and so get no warning: writing off on this Pi (`SERVICE_WRITE_ENABLED=0`), and nothing answered yet — which is not a moment of "we don't know, assume the worst", it is a section that is EMPTY, and it lasts as long as an unreachable Pi lasts because nothing re-polls `/vcu-write` while the sheet is open. An amber warning standing over an empty section until the sheet is reopened is a wolf cried permanently.

⚠️ "Everything below here can change the motorcycle" was FALSE and had to go: of the next four controls, the parameter picker reads, the value on the left is a read-out, "Read it off the bike again" reads, and the service-stamp action is labelled read-only. A section heading that lies is worse than none. What it says instead is the section's risk PROFILE, and it says it here rather than only at the fold 600 px further down — which is the honest answer to "a panel must never conceal what it is capable of". The fold hides the buttons from a wandering thumb; it does not get to hide that they exist.

⚠️ The one thing that MUST render when there are no controls is why there are none. `message` is where `fetchStatus()` puts "could not reach /vcu-write", and its only other home is `Outcome()`, which lives inside `ParameterForm()` — i.e. inside the branch `hasControls()` has just switched off. So the loudest failure this section has was being written to a node that does not exist whenever it happened, and an unreachable Pi rendered as a heading, an ellipsis and silence.

It is `.failure`, not the bare `.action-note` it first landed in. Rendering it was only half the fix: at `--label` / 11.52 px it came out byte-for-byte identical to "Reads four identifiers on the A8" — this section's own thesis, that prose is ranked by consequence, not applied to the one sentence saying the section is dead. `Availability()` stands its ellipsis down for the same reason: "loading" and "the fetch failed" are mutually exclusive and only one of them was ever true. `status` stays null for ever after a failed GET, so with the Pi unreachable this section read as loading and failed at the same time, with the loading claim the more visible of the two.

### The fold in front of the irreversible three

⚠️ The fold is the safety part of the section, not the decoration. This dashboard is used on a handlebar-mounted phone, and the sheet is a long scroll: styling alone still leaves `31 FC` and Mode 04 as things a thumb can arrive at while trying to reach something else. Collapsed, there is nothing there to arrive at.

The same idiom as the parameter warnings' toggle — counted, caret-ended, coloured for what is behind it — rather than a second kind of disclosure, and the count is in the label so the fold says what it is hiding without being opened.

⚠️ Toggling DISARMS. Otherwise collapsing the fold over a half-confirmed action would leave a primed button waiting off screen for its second tap; re-opening the sheet already resets both (`refreshVcuWrite`), and this closes the same hole for the fold itself.

The SENTENCE does not change between states — only the caret turns. It used to grow a "hide the" in front of itself, which changed the width and the grammar of the one control standing between a thumb and Mode 04, so the eye had to re-find it after every tap. And no glyph: 🚨 at this size is an anonymous red blob, and the row is already red and full width.

The contents line sits under the caveat rather than instead of it: somebody at the bike who came for the clock should not have to open the drawer to learn the clock is in it — but why it is shut is still the first thing worth reading. It is shown only while SHUT; open, the three buttons are spelled out directly underneath, and a list naming them a few pixels above is the same information twice.

The wrapper carries the closing rule, so it is there whether the fold is open or shut. On the opened group it existed only while open, which left "Recently written" hanging under the red panel with no divider in the state the sheet spends most of its life in — while every other section boundary had one.

The fold is a disclosure, so it carries `aria-expanded`: a screen reader has to be told it is one and which way it is currently pointing. The caret cannot say that; it is a glyph.

The read-only service-stamp action is outside the fold deliberately: it changes nothing, and it is the action you want BEFORE the service point below — which stamps the bike's own clock and odometer over whatever this one shows you.

### `IRREVERSIBLE` is ONE list, not a list and a parallel array beside it

Everything the page says about the drawer is read off it: how many there are (the fold's label and the section's risk line), and what they are called (the fold's contents line). A literal 3, or a hand-written list of names kept alongside, fails in the direction that matters — the drawer goes on promising three things while holding a fourth, or naming the wrong three, and it does it silently.

⚠️ The names used to be a parallel array checked against this one FOR LENGTH, and reported by `console.warn` — on a page whose deployment target is a handlebar-mounted phone, where nobody has a console open, ever. Reordering the list or swapping an action left the fold confidently naming things it did not hold, with the guard green. Both halves are fixed: the names cannot drift because they are not stored twice, and what CANNOT be made structural — that these are exactly the actions the Pi refuses without a confirmation, in this order — is asserted in `scripts/check-irreversible-actions.ts`, under `npm test`, where a red build says it.

`render` is a thunk, not a node, for two reasons: the fold rebuilds its contents on every open, and — the safety one — nothing behind the fold is CONSTRUCTED while it is collapsed, so "there is nothing there to arrive at" stays literally true of the DOM.

Arming one action disarms the others, so a thumb travelling down the list cannot walk its way through two of them. **⚠️ That is NOT what stops a double-tap, and this comment used to say it was.** Arming one control says nothing about the same control being hit twice, and until it was measured (2026-08-19, 390x844) that was exactly what happened. What stops it is the dwell.

The armed caption NAMES WHAT IS PRIMED, and that is not decoration. It used to be one shared sentence — "Tap again — this cannot be undone" — on all three, so an armed button said only that something irreversible was armed, never which. The parameter write has named its target in this exact spot since #81 for the same reason: the caption is the one place a person commits, and a thumb that landed on the wrong control is exactly the case it exists to catch. `describeChange()` keeps the PARAMETER NAME for the same reason — `75 → 80` alone reads identically for four of the five entries at plausible values.

### The `<select>` is rebuilt whole, with `selected` on the option

The whole `<select>` is rebuilt by the binding, and the options are its DIRECT children. That is not a style preference — it is the fix for two real faults, both caused by the options previously being wrapped in a `<div>` because a VanJS binding function may only return ONE node (see `van-1.6.1.d.ts`'s `ValidChildDomValue`):

- A `<div>` is not in `<select>`'s content model. Whether the options inside one are collected at all is up to the engine — Chrome ≥135 does, older engines and the phone this dashboard is actually used on showed an EMPTY dropdown with the five parameters unreachable.
- Even where it renders, `select.value = …` set before that div is appended does not stick, so any status refresh that rebuilt the list — every write does one — silently snapped the picker back to the first parameter while the rest of the form stayed on the one that was chosen. A write UI whose dropdown names a different parameter from the one being written to is exactly the kind of quiet mismatch everything else here is built to avoid.

Which option is current is therefore set on the OPTION (`selected`), never on the select afterwards: it survives being rebuilt and does not depend on props and children being applied in a particular order. `WantedControl` does the same, for the same reason.

The bit case in `WantedControl` is the point of it: there is no way to type a word into `VSM_CONFIG_1`, because the same word carries the PSU type and the Bluetooth variant and a fat-fingered word would reconfigure both. The server would refuse it too — the allowlist has no number control for that parameter — but the form should not offer a shape the server will only reject.

### Where the number on the left comes from — `onBike()` and `ValueNote()`

TWO sources, ranked, and the ranking is the point:

- **bus** — a value this page read itself: the probe button, or the read-back at the end of a write. Always wins. It is the newest thing anybody here knows, and after a write it is the only one that is right, because the sweep's snapshot still says what the parameter used to be.
- **sweep** — what the last recorded parameter sweep found (server-side, per allowlist entry). This is what stops the form saying "not read yet" to somebody who has just read all 277 parameters.

Null when neither has it, which is a real state — a Pi that has never swept — and the write button stays disabled saying so. The reading is only handed back when it belongs to the selected parameter, so no ordering of events can show one parameter's value against another's name. The name rides along with the reading rather than the reading being cleared when the parameter changes, which is what the previous shape did: a reading and a `selected` that can drift apart is the bug this prevents.

⚠️ The provenance is not decoration. A value the last sweep read an hour ago and a value read off the bus ten seconds ago are both legitimate preconditions — the Pi re-reads either way — but they are not equally likely to still be true, and the one thing the page must never do is present them as the same thing.

⚠️ The age is computed at RENDER, and nothing polls `/vcu-write` while the sheet is open, so a sheet left untouched shows the age it had when something last re-rendered it. That is why the write button's first tap refreshes before it arms (`armWrite`): the caption is re-rendered from the Pi's answer at the moment somebody starts to commit, which is the moment its accuracy is load-bearing. A timer ticking this every minute for a phone sitting on a workbench would be the wrong trade.

`armWrite()` refreshes, THEN arms — exactly what `armClockSync()` does, for the same reason and it is the same failure: a sheet opened in the kitchen and used at the bike twenty minutes later was showing an age computed when it opened. And if the value MOVED across that refresh, it does not arm: the caption now shows a different number from the one that was tapped, and a second tap must agree to what is on screen rather than to what was. `fetchStatus()` disarms on its own for the same reason — always BEFORE the new status lands, because a refresh can bring a different value for the selected parameter (a sweep that finished while the sheet was open rewrites `onBike` under it) and a button armed against 75 must not fire against 80 because a second tap happened to come after the refresh. `armClockSync()` re-arms itself immediately afterwards, deliberately and from the refreshed reading, and only if the refreshed verdict still allows it.

The current-reading box is `.readout`, so it does not look typeable. It is the only field-shaped thing in the sheet that cannot be edited, and it sat immediately left of "Change to" in identical chrome — a read/write pair rendered as two of the same thing, which is the exact confusion the rest of the page is built to remove. The number in it is also what gets sent as `expected=`, so "where did this come from" is a question worth the box answering by its shape. For a bits parameter the WORD is what is shown, because the word is what gets written and what the compare-and-swap is against — but what is being changed is one bit of it, so the bit states are spelled out beside it. A config word is written and read as hex everywhere else on the page, so a decimal 4375 would be a third rendering of the same number to reconcile.

The arrow between the two fields is a character rather than a caption anywhere, so the relationship survives being read at arm's length in a garage.

### The read button, and what a failed read does not do

The read goes through `/vcu-probe`, deliberately, and not a new endpoint: `/vcu-probe` already reads one identifier off one micro, it is already gated and single-flighted, and adding a second way to read one value would be two things to keep in step. The response is typed off the server's own source, like every other fetch in this dashboard — an untyped `json()` would let a renamed field through silently, and the field in question is the one a write is compared against.

There is no fallback to `unsigned`: a write is compared against the TYPED value, and using a differently-typed number as the precondition is how a signed parameter gets written from an unsigned reading of itself.

⚠️ A failed read does NOT clear a value the sweep already had. It failed; that says nothing about what the parameter holds, and dropping a good older reading on the strength of a timeout would be inventing information. The message says the read failed, and the caption under the value goes on saying where it came from.

Two captions on the button, because it answers two different questions. With nothing read it is the way to get a value at all; with a sweep's value already on screen it is how you find out whether that value is still true, which is a thing you may want and no longer something you are made to do.

### Where an ANSWER goes, which is not where the prose goes

`action-block` holds a control and the prose that belongs to it, in the order a thumb meets them: the consequence above the button, what it does and why you might not want to below. An **answer** is a fifth thing and it goes _between_ — under the control, above the prose.

The prose is static and says what the button is FOR; the answer is what it just did, and it is the newest thing on the card. Putting it under three lines that never change buries it, and the alternative — appending it to the shared `message` signal — is what produced issue #154: the read-service-stamp outcome rendered three sections up the sheet, at the same 11.52 px as the line describing the button, and pressing the button appeared to do nothing at all.

⚠️ **The read-stamp control now carries no `caution` key**, so the only amber under it is its answer. That is load-bearing rather than incidental: `.action-note.caution` is amber but **not** bigger — `style.css:733` sets `color` and nothing else — so an answer set in `.caution` is only conspicuous while it is not competing with a permanently amber sentence in the same block. The caveat it used to carry ("⚠️ Untried…") was retired by the 2026-09-08 read, which is what freed the colour. If a `caution` is ever added back to that control, this trade has to be decided again, and `scripts/check-service-stamp.ts` asserts the absence so the decision cannot be made by accident.

### Reading the outcome — `send()` and `performWrite()`

⚠️ THE ANSWER IS TAKEN FROM THIS REQUEST'S OWN RESPONSE, never from `state.val`. `send()` leaves the state alone when the request does not come back, so reading the verdict out of the state would attribute the LAST write's result — including its "written", its read-back and the verification hint — to an attempt that may have reached the bike and may have done anything at all. That is why `send()` returns the payload, or null.

The three outcomes:

- **no response at all** — the worst case, and it stays the worst case. Nothing is claimed about the parameter, and the reading goes, because the frame may well have gone out. The next write has to read first. A write request that did not come back may still have reached the bike — the frame goes out before the response comes back — so "it failed" would be a claim nothing supports, and the message says so at length.
- **400 or 409** — refused BEFORE the bus: a malformed query, a busy bus, a closed gate. Nothing was read and nothing was written, so the reading on screen is exactly as true as it was a second ago and is kept, along with what was typed: the answer to "the sweep is using the bus" is to wait and press it again, not to start over.
- **a result** — the reading is replaced from the read-back the write itself did, so the value on screen is the one that is true afterwards rather than the one the sweep recorded before. Cleared when the attempt reached the bus and produced no reading (refused at the session or security step, or a failure partway): the write may have landed, so the page falls back to the sweep's older value, correctly labelled as old, and the Pi re-reads before any second attempt exactly as it did before this one.

The body carries the status and the journal on every code this endpoint returns, including 400 and 409, so it is read before the status is judged. `X-Cool-Eva: service-write` is a DIFFERENT value from the read endpoints' `service-mode`, so a caller built for those cannot reach this one.

#### `stampOutcome` — a second signal, not a third binding on `message`

The last-service read fills its own state rather than sharing `message`, and `message` is **cleared** when it does.

`message` has exactly two rendering homes, and they are **not** the pair it is easy to assume. One is `Outcome()`, the last child of `ParameterForm()`, three sections up the sheet. The other is `VcuWrite()`'s `!hasControls()` branch — the red `.action-note.failure` line that is the only thing on screen when the section cannot render its controls at all.

A third binding, at the service-actions control, would render the same sentence twice on one screen — so the read's answer gets a signal of its own, filled in `performAction()` from the payload `send()` already returns for exactly this kind of reason.

⚠️ **`message` is cleared only while the node that replaces it is still mounted.** `send()` replaces the state before `performAction()` runs, so an answer carrying `enabled: false` unmounts the whole controls branch — `StampOutcome` with it — on the same update. Clearing unconditionally therefore emptied the failure line, and a Pi that answered "writing is off" showed a heading, an ellipsis, and nothing else. `hasControls()` is the condition, because it is the same question the two nodes are branched on. An earlier version of this section said both homes were in `ParameterForm()`; that sentence is what made the bug look safe.

The four endings all land in it: a 200 with a stamp, a **409** refusal (`payload.message` — a failed read is never a 200, so `write-session.ts`'s refusal sentence is literally what renders under the button), a 400, and a request that never came back, whose sentence `send()` composes itself.

⚠️ **`31 FC` clears it.** Set Service Point overwrites the block the read reports and sits two taps away inside the same fold, so what was on screen becomes false the moment it runs. It is cleared rather than refilled with the routine's own `after` for two reasons: that stamp is `undefined` unless the routine reached `started` and `null` whenever the read-back failed, so "refill" is often "refill with nothing"; and its sentence is already being rendered by `Outcome()`, so copying it here would reintroduce the double render this design exists to avoid. **Nothing else clears it** — a parameter write addresses an index, Mode 04 addresses codes, `reset-vcu` restarts the micros, and the clock sync changes the clock a _future_ stamp would use, not the stored one.

`writing` is separate from `busy`, which is also raised by the probe read and by the refresh the write button's first tap does. This page must not say "Writing…" while it is doing something else: a caption claiming a write is in progress when none is would be a lie about the one thing on this page that cannot be taken back. Each disabled state says which of the two things is missing rather than sharing one caption — "nothing has read it" and "you have not said what to write" are fixed by different taps in different places. The blocked caption deliberately says "sweep", not "read": the probe shows the answer and stores nothing, so a caption saying "read 277" sends people round a loop that never ends.

`fetchStatus()` failing is loud. A section that silently renders nothing looks like a bike with nothing writable, which is a different claim from "the Pi did not answer".

### The journal

The record of what has been done to this motorcycle. The lines are a SIBLING of the heading, not children of it. They were children, which put every one of them inside a `.sheet-title` — so the record rendered as tiny grey SMALL CAPS WITH WIDE TRACKING, because `text-transform`, `letter-spacing` and `color` all inherit. The `.action-note` on them only ever overrode the font size.

The clock caveat rides on every line rather than being explained once at the top: these lines get read one at a time, months apart, and a timestamp this Pi could not vouch for should say so where it is read.

### The clock action's disabled state

Every reason is listed, not the first. "No satellite time AND the clock reads 2060" is a different situation from either alone, and the second one is how you find out the GPS decode is broken rather than the sky being blocked.

Red, but NOT the `no-undo` class: the button is disabled, so there is nothing there that cannot be undone. It is red because something is broken, and `no-undo` means one specific thing that this is not.

The no-undo line is rendered through `NoUndoLine`, not hand-rolled: rendering the div inline meant this one card was the only one whose red line had no IRREVERSIBLE badge, which is exactly the inconsistent-slot problem the badge exists to remove. It is shown only when the button can actually do something — a Pi whose clock is not fit to copy has a disabled button and nothing that cannot be undone.

### Resetting on open

`refreshVcuWrite()` is called by `views/service-mode.js` whenever the sheet opens: it refreshes, disarms, re-folds everything, and drops `stampOutcome` — an answer read through a previous sheet-opening must not be read as this one's, the same rule `headlightExpected` and `lightsProgress` follow. Re-folding is not in `forgetSelection()`, which also runs when the PARAMETER changes — the irreversible actions have nothing to do with which parameter is selected. The `dangerOpen` reset belongs to the sheet-opening reset alone, for the same reason `armed` is cleared there: the state a sheet opens in is the state a thumb finds when it is reaching for something else, and that state must not contain `31 FC`.

`fetchStatus()` is kept apart from `refreshVcuWrite()` because arming the clock sync needs a fresh `clock.iso` and must not wipe a parameter reading somebody took thirty seconds ago.

## Commanding charge current from the charge tab — `views/charge-current.js`

The one control that changes the bike from OUTSIDE the service-mode sheet (added 2026-08-24). It commands the charge-current limit on `0x121` while a charge is live — see `docs/can-0x121-charge-command.md` for the frame and how the injection was proven.

### It carries the sheet's whole safety model into the charge tab

The command still goes through `POST /vcu-write?action=charge-current` — so `SERVICE_WRITE_ENABLED` and the audit journal apply exactly as they do to a parameter write, and the runner (`performChargeCurrent` in `src/vcu/write-runner.ts`) makes every real decision. The control reuses the shared two-tap dwell (`lib/arming.js`), and `armChargeCurrent()` refreshes the status before it arms — whether writes are still enabled and the session still live must be the Pi's answer now.

⚠️ **One thing does NOT carry over: the stationary service gate.** That gate (`speed=0`, drive down, not energized) is right for a parameter write and wrong for a charging operation — a charging bike is energized by definition and tethered by definition, and the gate only excuses `energized` while it sees fresh charger frames, which flap with the trickle, so applying it refuses a legitimate command mid-charge. `write-runner.ts` exempts `charge-current` from it (its real precondition, a live session, is checked off `charge_manager_state`), and the control does the same — `commandable()` and visibility never read `gate.safe`.

### Session presence rides on `charge_manager_state`, NOT `charge_type`

⚠️ The signal that says "there is a live charge to command into" is `charge_manager_state` (`0x610` b7: `0x02` AC, `0x23` DC), the cleanest AC/DC discriminator on the bus (`docs/charge-manager.md`). It is emphatically **not** `charge_type` (`0x605` b2), which the first cut used and which made the tile vanish mid-charge: `charge_type` tracks whether AC current is flowing _at this instant_, not whether a session exists, so it flaps 1↔0 as the charger pauses delivery — measured on 2026-08-25 dropping to 0 for an 8-minute stretch mid-trickle while mains were still ~210 V/1.5 A. Each flip fired the old `charge_type`-keyed derive's "session ended" branch and removed the tile. `charge_manager_state` held a steady `0x02` for the whole two-hour plug-in. `0x610` broadcasts continuously, so `isStale(charge_manager_state, 5000)` catches only a real unplug.

### Hidden, not merely disabled — but once shown, it stays put

`ChargeCurrentControl()` returns an empty node unless a session is live (`sessionLive`) AND `GET /vcu-write` reports `enabled === true`. `enabled` is what keeps it off a normal phone: the charge tab is the one screen a phone on the garage wifi sits on unattended, and a bus-writing control there by default is wrong. Once it has appeared for a live charge it stays put across a current pause (the button just disables while the ceiling/session is momentarily unresolved), rather than vanishing — a tile that disappears reads as "it broke". Visibility is `sessionLive && enabled` — two plain `van.state`s, deliberately no `serverTime`.

### The status fetch is lazy, and `sessionLive` is a state so the render stays off `serverTime`

Nothing polls `/vcu-write` for a phone that is not charging; the read-only screen stays a pure WebSocket consumer. A module-level `van.derive` fetches once when a charge appears and clears when it ends. ⚠️ Unlike the first cut, this derive DOES subscribe to `serverTime` (through `liveChargeType() → isStale`), on purpose: the cable coming out is a staleness event with _no value change_, and nothing else would notice it. It is allowed to because it writes the result into the `sessionLive` STATE, and the tile's visibility binding reads that state — so the render never subscribes to `serverTime` and cannot recreate the `<input>` under the cursor. The derive is one equality check per tick; the fetch fires only on the session edge.

### The `<input>` is created once, so a live signal cannot eat the cursor

The amps box is built directly, not inside a binding — its `placeholder` and `disabled` are reactive ATTRIBUTE thunks, which VanJS updates in place. A binding that re-ran on `fast_dc_limit_max_a` (a 10 Hz broadcast) or on `serverTime` would REPLACE the `<input>` element mid-keystroke and take the cursor and focus with it. The service-mode write form dodges this only because its input's bindings key on `selected`/`state`, which do not tick; this control is next to signals that do, so the element has to be stable by construction.

### The AC/DC label and ceiling are echoed, not decided

The runner reads `charge_manager_state` live to pick the opcode (`0x02` → AC, `0x23` → DC) and the ceiling byte (`b4`) itself — DC from the always-broadcast `fast_dc_limit_max_a`, AC from `ac_charge_ceiling_a`, the dash's own last-observed ceiling (an EVENT, only broadcast when the dial moves). The page shows the same signals so the button says what the Pi will do, but it decides nothing: a wrong `b4` on an AC command makes the VCU ignore the value and settle on a ~10 A default, so AC is refused — on the page and again on the Pi — until that ceiling has been seen this session, with the remedy ("nudge the dial") shown where it is actionable rather than after a 409.

### Confirm-gated but reversible — NOT behind the irreversible fold

`charge-current` needs `confirm=charge-current-<amps>` because `curl` can reach `/vcu-write` and a page showing 6 A must not be able to POST 30 — the number is the owner's to say out loud. But it is transient (unplugging resets it), VCU-clamped, and overridable on the bike's own screen, so it is the amber/reversible tier, not one of the three "cannot be undone" actions. `scripts/check-irreversible-actions.ts` was taught this third category (`REVERSIBLE_CONFIRMED`) so the fold's promise stays exactly the three irreversible actions while the check still catches any confirm-gated action that is neither behind the fold nor named reversible.

## Stopping a charge from the charge tab — `views/charge-stop.js`

The second bus-writing control on the charge tab (added 2026-08-25), sitting beside the set-current one. It ends an active charge by replaying the two-frame Mode-button stop the dash emits — `0x120: 96 ff 01 …` then `0x121: 16 ff 01 …`, cracked and proven on-bike (see `docs/can-0x121-charge-command.md` § "CRACKED"). It carries the same safety model as set-current: `POST /vcu-write?action=charge-stop`, `SERVICE_WRITE_ENABLED` + audit journal, the shared two-tap dwell, hidden unless writes are on AND a charge is live, and exempt from the stationary service gate (a charging bike is energized+tethered; the benign direction regardless — worst case a charge halts).

### Two taps, not press-and-hold — even though the bike's gesture is a hold

The rider stops a charge on the bike with two Mode presses (unlock, then interrupt), and the second is described as a ~1.5 s hold. It is tempting to mirror that with a press-and-hold button. We don't, because the real command on the bus is a **discrete pair of frames sent once**, not a sustained stream — a hold would only re-send the same two frames. So the dashboard uses the same arm-then-fire two-tap as every other write here: the first tap arms, the second (after the dwell) fires the pair once. One shared arming rule for the whole dashboard beats a second gesture that would exist only to imitate the bike's UI rather than the bus.

### Source-agnostic, so no opcode or ceiling to choose

Unlike set-current, stop takes no fields and makes no AC/DC decision: the same pair ends both. The runner (`performChargeStop`) needs only a live session — `charge_manager_state` present, fresh, and a settled AC (`0x02`) / DC (`0x23`) — and the page's `commandable()` is just "writes on and a charge is live". `confirm=charge-stop` is a fixed word (no value to embed), gated only because `curl` can reach the endpoint.

### Shared machinery — `lib/charge-write.js`

Adding a second charge-tab write control was the moment to lift the session/status machinery out of `charge-current.js` (which was at the ~400-line split line) into `lib/charge-write.js`: the `writeStatus`/`sessionLive` states, the one lazy `serverTime`-subscribing session derive, `liveChargeType()`/`liveCeiling()`, `fetchChargeWriteStatus()`, and an `onChargeSessionEnd()` hook each control registers to clear its own form. One derive, one status fetch, one definition of "a charge is live" — so the two controls cannot disagree about when a command may be offered.
