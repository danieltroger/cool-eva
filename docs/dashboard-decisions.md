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
- long-press `btn_indicator_cancel` → save a waypoint, and say so

The recognisers in `lib/gestures.js` are pure, in the sense `src/can/decode.ts` is pure: every clock they reason about is passed in, so they read no clock, touch no DOM and hold no timers. That is what lets `scripts/check-handlebar-gestures.ts` replay press sequences through the very objects the phone runs — including the real durations measured off this bike's own bus, which is the only evidence there is for the thresholds below. The impure half (subscribing to signals, calling the actions) is `lib/handlebar-gestures.js`.

### ⚠️ The clock these take is the SERVER's, not the phone's

`nowMs` is `serverTime` from `lib/store.js` — the `ts` the Pi stamped on the message — and **not** `monotonicNow()`. That is the opposite of the rule the rest of this codebase follows for durations, so it needs its argument written down.

What these measure is how long a button was down ON THE BIKE. The phone's monotonic clock cannot answer that: it measures the gap between two WebSocket messages ARRIVING, and those are the same number only while delivery latency is constant. On a garage hotspot it is not. A 140 ms tap whose release patch is held up 1.5 s by the link looks, on the arrival clock, exactly like a 1.5 s hold — and would save a waypoint nobody asked for. Two deliberate presses a second apart, delivered back-to-back after a stall, look exactly like a double click.

The Pi stamps `ts` when it builds the patch, before the message goes anywhere, so server-side differences are immune to whatever the link does afterwards. A stall simply stops the clock advancing, and the queued release arrives carrying the time it really happened.

The one thing the server clock can do that a monotonic clock cannot is JUMP: `src/gps/clock.ts` steps it from satellite time, by at least `DRIFT_THRESHOLD_SECONDS` (60 s) when it does. `IMPLAUSIBLE_HOLD_MS` is what keeps a step from being read as a very long press.

There is deliberately no timer in `LongPressDetector`. An earlier version fired on a local `setTimeout` at the threshold, which measured the gap between two messages arriving and so counted a stalled link as a hold.

### The safety argument, which decides the shape of the file

Both buttons these watch have primary vehicle functions: `btn_cruise_set` sets the cruise speed, `btn_indicator_cancel` cancels the turn signal. Neither function is affected by anything here, and not because the code is careful — because the phone is not in the circuit. The buttons are wired to the bike's own dashboard and VCU; CAN `0x102` / `0x400` carry a _report_ of the switch state that the bike broadcasts after it has already acted. This dashboard is a passive listener on that broadcast (`src/can/socket.ts` comes up listen-only; nothing on this path ever transmits), so there is no press for it to swallow, debounce or delay. A gesture is recognised strictly downstream of the bike having done its own job.

That is also why nothing here waits to see whether a press "turns into" a gesture. A double click does not suppress the first click, and a long press does not suppress the release — the bike never asked us, and both actions have already happened by the time the frame carrying them is decoded, let alone by the time a gesture completes 1.2 s later.

### Which bit, and why it is not the obvious one

`btn_cruise_enable` is the wrong button and its name is the reason to check. It is the cruise ON/OFF switch, and `src/can/decode.ts` records that BOTH of its presses in the corpus armed cruise control 0.53 s later — it is not side-effect-free, and the owner's manual claim that activation needs a 3-second hold is contradicted by the bus (both presses were under a second). `btn_cruise_set` is the SET SPEED button next to it (`0x400` b2 bit 2), and setting a cruise speed does nothing at all unless cruise is already armed.

That leaves one honest caveat, which belongs to the button rather than to the gesture: double-tapping SET while cruise IS armed re-sets the cruise speed to the current speed. So does tapping it once, so nothing here made that worse — but a rider changing tabs while decelerating under cruise would be lowering the setpoint, and that is worth knowing rather than discovering.

`WAYPOINT_BUTTON` is `btn_indicator_cancel`, the turn-signal cancel switch pushed in (`0x102` b0 bit 5).

### `DOUBLE_CLICK_WINDOW_MS` = 700 ms

How long two presses of the same button may be apart and still count as one double click, measured between their RISING edges. Bounded on both sides by measurements rather than taste:

- **Above a gloved double tap.** A bare-handed double click runs 150–300 ms; a thick glove on a vibrating bar roughly doubles that, so the gesture has to stay comfortably reachable at ~500 ms. The 2026-08-19 MODE-button measurements put a single deliberate press at 120–260 ms, so two of them plus the gap between is already most of half a second before a glove is anywhere near it.
- **Below two presses that were meant to be separate.** `lib/press.js` puts the gap between deliberate presses of the same button at ~1 s, and that is the number this must not reach — two ordinary cruise-set presses a second apart must read as two, not as a tab switch.

700 ms sits between the two with ~200 ms of headroom either side.

Rising edge to rising edge, not release to press, because a cruise-set press is not short: the only one in the corpus was held 1.794 s. Measured that way a long press can never pair with the press after it, which is the behaviour we want — a double click is two quick taps, and a held press is not a tap.

The detector clears `#lastRiseAt` rather than replacing it when a pair completes, so three quick taps are one switch and a fresh start — not two switches, which would make a fumbled double tap overshoot. It also requires a real observed 0→1: loading the page mid-press is not a press we watched, and `app.js`'s high-beam gesture draws the line in the same place.

### `LONG_PRESS_MS` = 1200 ms

How long `btn_indicator_cancel` must be held before it saves a waypoint. The corpus is the argument. Across 14 candump captures the median handlebar press is 140 ms and the shortest 30 ms, and indicator-cancel is 63 of the ~70 presses in it, so that median is essentially the median cancel tap. The longest ordinary press ever recorded on any handlebar button is 920 ms (`btn_cruise_enable`, which was not being held for effect — a short press already arms cruise).

Corroborated since, and independently: the MODE buttons and `btn_set_back` were confirmed on 2026-08-19 by instructed presses, 8/8 each, as clean momentary 0→1→0 pulses of 120–260 ms. A deliberate press of a handlebar button made on purpose, by a rider being asked to press it, is a quarter of a second at the outside — which is the same story the corpus median tells, told by a different measurement.

1200 ms is therefore ~8.5× a normal cancel tap and clears the longest ordinary press of any button by 280 ms, while staying short enough to hold through a corner without thinking about it. Riders do not hold the cancel switch in: it stops the lamp the instant it closes and there is no reason to keep pressing.

The cost of being wrong is deliberately asymmetric, which is why this is not set even higher. A false positive saves a waypoint nobody wanted — a row in the log and a banner. A false negative is a stop you meant to remember and did not. Neither touches the indicator, which cancelled on the closing edge 1.2 s earlier.

`LongPressDetector` fires as soon as the evidence arrives that the button WAS down for long enough — usually while it still is, because `lib/store.js` is fed a patch on every signal change and those run at ~5 Hz even on a parked bike (measured over the 90 s capture in `obd-garage/captures`). So the banner normally appears about a tenth of a second after the threshold, with the thumb still on the button, and holding longer is self-correcting. When the bus goes quiet the evidence can instead arrive with the RELEASE, whose timestamp says how long the press really was. Firing then is late feedback for a gesture that was genuinely made, which is far better than dropping it — and it is the same rule, not a special case: fire when the server's own timeline shows the threshold was passed.

### `IMPLAUSIBLE_HOLD_MS` = 30 s

An apparent hold longer than this is not a hold, and is abandoned without firing. The server clock these run on is the one `src/gps/clock.ts` steps from satellite time. A forward step during a press would otherwise land as "held for six hours" and save a waypoint the rider never asked for, in the seconds after a cold boot — which is exactly when they are least likely to be watching for it.

30 s separates the two cases cleanly and needs no maintenance. Above: the smallest step the gate will ever make is `DRIFT_THRESHOLD_SECONDS`, 60 s, and a real one is hours. Below: the slowest the phone can learn that a button is still down is the 5 s WebSocket heartbeat, on a bus where nothing else is changing at all.

How the two derives are paced — signal-bound for the double click, `serverTime`-bound for the long press — is argued at each `van.derive` in `lib/handlebar-gestures.js`, because the pacing is what the detector's correctness rests on. The high-beam flash in `app.js` is the third of these and the only one that works with a full-face helmet and winter gloves without moving a hand.

---

## Momentary buttons on a phone screen — `lib/press.js`, `lib/flasher.js`, `views/all.js`

The handlebar buttons are momentary and short: measured across 14 candump captures the median press is ~140 ms and the shortest is 30 ms. The logging path handles that fine — `0x102` arrives every 10 ms, the signals carry no deadband, so both edges of even the shortest press are decoded and sealed. Nothing in `lib/press.js` changes that, and nothing there is logged: it is display state only, computed on the phone, the same rule `lib/derive.js` follows.

What log-on-change cannot fix is that 30 ms is one or two frames of a 60 Hz display. A tile that rendered the raw 1 would flicker for a frame and be gone before the eye registered it, which would make the buttons group useless for the one job it exists to do — press a button on the bars and see which key moved.

So each button gets three things the raw value doesn't give you:

- a **latch**. The tile is lit while the bit is 1 and for `LATCH_MS` after it drops, so the briefest tap is still a clearly visible flash.
- a **count** and a timestamp. These are what survive if a flash is missed entirely — a backgrounded tab, a dropped WebSocket frame, a press that lands during a reconnect. Watching a number go 3 → 4 is a slower but strictly more reliable way to identify a button than watching for a light, and it is the one to trust when the two disagree.
- a **held-since** stamp, for the group's other half.

`LATCH_MS` is 600 ms: comfortably above the ~200 ms it takes to notice a change and well under the ~1 s gap between deliberate presses of the same button, so two taps still read as two.

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

The case that settles it landed the same day, in `lib/handlebar-gestures.js`: holding `btn_indicator_cancel` for `LONG_PRESS_MS` = 1200 ms now saves a waypoint. So a key whose name, prefix and 762 recorded presses all say "momentary" is deliberately held past a second as a designed input — and the tile says "held 1 s" while it happens, which is the useful thing to see while you are waiting for the toast. Any list of held-state keys written yesterday would have been wrong about it today.

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

### The button tile's three readouts — `views/all.js`

`ButtonTile` is the same card as `RawTile`, but built to be watched rather than read. Three readouts, in decreasing order of how much you should trust them:

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

## Plausibility bounds — `lib/bounds.js`

The gate exists because the real data is not clean. Across 7.6 M logged readings (Apr–Aug 2026) the bike has produced `coolant_in` at −242 °C in 59 450 rows and `coolant_out` at 988 °C in 40 351 rows — an open/flaky PT100, not noise — plus rarer `0xFFFF` sentinels on the cell voltages, −32767 on GPS altitude, and `high_beam` briefly reading 193. Rendering those raw is how you end up watching "−242 °C" on a coolant tile at 90 km/h, and a single one of them destroys a sparkline's autoscale for as long as it stays in the window.

The gate **rejects rather than clamps**. Clamping invents a plausible number and hides a real fault; dropping the sample keeps the last good value on screen and lets the tile say "fault" — which is the actionable thing, because on this bike an out-of-range coolant probe is a wire to go and wiggle.

Order of consultation in `boundsFor()`: `BY_KEY`, then the cell-voltage pattern, then `COUNTER_KEYS`, then `BOOLEAN_GROUPS` (flags before units, because their unit is `""` — which would otherwise fall through to unbounded and let `high_beam=193` render as "on"), then `BY_UNIT`.

### Why cell voltages are gated no tighter than the decoder

`CELL_VOLTAGE_PATTERN` gets `[1000, 5000]`, the same band the decoder uses (`MIN`/`MAX_PLAUSIBLE_CELL_MV` in `src/can/decode-bms.ts`), and deliberately not tighter. A tighter client gate is actively harmful here. The decoder's band is wide on purpose — "far wider than this pack's own configured limits, so no real cell, even a badly damaged one, can fall outside it" — and anything this rejects does not reach `signalState`, so `CellStrip` goes on drawing the last good bar. A cell collapsing to 1400 mV would then be invisible on the one screen whose premise is that a single cell out of 81 ends the ride. The server has already dropped the `0xFFFF` sentinel and the 8192 mV pad; this is defence in depth, so it should agree rather than second-guess.

### The charge manager's numeric bounds (2026-08-20)

The same miss `dc_charge_limit_selected_a` had, arrived at from the other direction: these signals do reach a rule, but the rule is `BY_UNIT`'s "A" fallback of `[-1000, 1000]`, and every one of them is a plain u8. No value a byte can hold is rejectable, so the gate was decorative. Each bound is derived from something, not guessed:

- **127** is `MAX_DC_CHG_CURRENT`'s FIELD range. Parameter 258 is a BYTE S that Energica's own option data masks with 0x7F (`src/vcu/write-targets.ts`), so the value field is 0…127 whatever the sign column says, and `fast_dc_limit_max_a` is that parameter read back off `0x625`. This bike holds 75.

  **⚠️ NOT 80.** 80 is this project's WRITE POLICY — the highest value Energica ever shipped a variant at, which is why `scripts/check-vcu-params.ts` refuses to write 81 and annotates 127 as "the datatype's own ceiling is NOT the policy's". A plausibility gate is about what the field can legitimately carry, not about what we are willing to write into it. Bounding at 80 would render a dealer write, or a differently-optioned bike, as a dead SENSOR rather than as the new value — defeating the one reason this key is logged, which is to notice the day the parameter changes. It would also have this key disagree with `dc_charge_limit_selected_a` about what counts as a fault for the same underlying parameter, which is the mistake `charge_manager_pack_v` is named to avoid.

- `fast_dc_limit_a` is `0x620` b0, bounded by that configured max, so it inherits the 127.
- `fast_dc_a` is the current actually delivered, bounded in turn by the live limit — but the two frames run at 10 Hz and 20 Hz, so across a step edge the delivery reads up to 12 A above the limit for a frame or two (50 such frames in the corpus, all within 1 s of a step). 150 covers 127 plus that skew and still rejects the 255 an all-ones payload decodes to, which is what these entries were added for.
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

`COUNTER_KEYS` exists because `dtc_count` (0…127, PID 01) and `warmups_since_clear` (0…255, PID 30) share the `diag` group with the 154 generated `dtc_*` flags but are counts, not flags — the group-wide 1/0 rule would reject every value above 1 as a sensor fault, gating out exactly the stored-code count that the sheet's OBD cross-check exists to show, precisely when there is something to cross-check. `dtc_stored_count` reads 39 on this bike today.

`buttons` joined `BOOLEAN_GROUPS` on 2026-08-16. Today their decoder can only emit 0 or 1 (it returns `bit()`), so the gate rejects nothing — it is there for the same reason `controls` is, which is that `high_beam` once read 193. A decoder that later returned the masked byte instead of the bit (`handlebar & 0x20` is 32, not 1) would otherwise paint a pressed button as an ordinary number, and a button tile that lights on 32 but not on 1 is exactly the kind of quiet wrong answer this file exists to stop.

### `km_per_kwh_can` — why not the same band as the hub's pair

`0x10B` carries the VCU's own consumption: the same two quantities as `km_per_kwh` / `kwh_per_100km`, down a different path, and deliberately NOT given the same band. The hub's pair is smoothed; this one is instantaneous at 10 Hz, and an instantaneous km/kWh is unbounded above by construction — coast or regen for a moment and you cover distance on no net energy at all. Replaying the 2026-08-02 lap through this gate at the hub's `[0.5, 200]` rejected 159 of 448 readings, a third of a healthy signal drawn as a dead sensor, which is this file's own failure mode.

Those readings are real, not decode noise: the peak, 3379.3 km/kWh, pairs with 0.030 kWh/100 km in the same frame, and 3379.3 × 0.0296 = 100 exactly as the reciprocal requires. So the honest bound is the whole range the field can still express once the decoder has dropped the ≥ 65000 saturation clamp — 6499.9 and 64.999. Wide, but a narrower one here would be a guess about the bike rather than about the decode, and only the decode is knowable from this side. The 100 m averages get the same band, read unsigned and saturation-guarded the same way.

---

## Derived numbers and charts — `lib/derive.js`, `lib/ring.js`, `lib/svg.js`, `lib/tiles.js`, `lib/dwell.js`

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

Caveat worth keeping in mind when reading it: `pack_resistance_mohm` is the BMS's own estimate and includes cabling and contactors, so some of these watts are shed outside the cells. It is an upper bound on cell heating, not a measurement of it. Below a few hundred watts of output the loss _percentage_ is dominated by its own rounding and swings between nothing and everything while parked, so it reports null instead.

### The under-voltage dwell — `lib/dwell.js`

The BMS does not cut discharge the moment a cell dips below the cut-off — its `DischargeModeUnderVoltageCutOffTimer` is 60 s, and the minimum cell has to stay under for that whole minute before the contactors open. That single fact is the difference between a useful display and one that panics: a hard pull drags the weakest cell under the floor routinely, and a naive alarm would fire on every overtake.

So instead of a threshold light, this tracks the timer itself — filling while under, draining while above — and the view shows how much of the minute is used. "You have 40 seconds of this left" is something a rider can act on.

The drain is symmetric with the fill because the BMS's own reset behaviour is not documented in the config and has never been observed on this bike (no capture has ever come near the floor). Symmetric is the middle assumption: an instant reset would understate a cell bouncing in and out of the cut-off, and no drain at all would leave the bar stuck full after a single dip.

The per-tick step is clamped to 2 s: a tab that was backgrounded for a minute must not credit the whole minute to the timer in one step — we have no idea what the cell did while we weren't looking, and inventing a full cut-out is worse than under-reporting.

### Pairing two rings by time — `differenceByTime()` in `lib/ring.js`

Index pairing looks right and is not: two signals only line up by index if they were sampled together, and nothing here guarantees that. `coolant_in` and `coolant_out` are read from separate awaited calls and each is gated by its own 0.05 °C deadband before it is pushed, so the two rings hold different numbers of samples taken at different moments — on this bike `coolant_in` has roughly ten times the rows of `coolant_out`. Subtracting by index would drift further into the past the further along the window you look, and produce a plausible-looking trace of the rate mismatch rather than of the quantity being measured.

For each sample of `primary`, the function takes the newest `reference` sample at or before it — a zero-order hold, which is the correct reading of "what was the inlet doing when the outlet was measured". Primary samples older than anything in the reference window are skipped: there is nothing to hold from, and extrapolating backwards would invent the value.

### The heatmap — `lib/svg.js`

Rows are modules and columns are the sensors or cells within one, so the shape on screen is the shape of the pack. That is the whole point over the flat 81-bar strip: a strip shows that something is drifting, a grid shows _which module_, and during a fast charge that is the difference between a curiosity and something you can act on.

Cells with no reading are drawn as an empty outline rather than skipped, so the grid keeps its geometry — modules 6 and 8 have no battery sensor, and a hole there should look like a missing sensor, not like a shifted row.

Row labels are HTML beside the SVG, not `<text>` inside it. The grid stretches to the tile width with `preserveAspectRatio="none"` so the cells stay big enough to read, and that stretch would render glyphs about 1.9× wider than tall — by a different amount in each mode, since the two grids have different viewBox heights.

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

## The toast banner — `lib/toast.js`

Everything else on this dashboard answers a question you went looking for. This answers one you cannot go looking for: a handlebar gesture gives no feedback of its own, so without it a long press on the bars is indistinguishable from a long press that did nothing, and the rider's only recourse is to stop and check.

The constraints are the ones `style.css` opens with — read at speed, through a visor, in daylight — plus one more that follows from where the input came from:

- **Never waits to be dismissed.** A gesture is made with both hands on the bars, so a banner needing a tap would be a banner that sits there until the next stop. It times itself out, and `pointer-events: none` in `style.css` means it cannot swallow a tap meant for whatever is underneath it either.
- **Says WHICH way it went in colour as well as words**, so the outcome is readable before the sentence is.
- **Full width at the top, over the header.** Sunlight legibility is mostly area and contrast, and the header carries nothing that cannot wait a few seconds.

`TOAST_GOOD_MS` = 5000: a gesture is often made in the middle of something — coming to a stop, putting a foot down — so this has to outlast the moment between triggering it and having a glance to spare. Five seconds covers that without leaving the header buried.

`TOAST_BAD_MS` = 9000, longer for two reasons: it is a longer sentence, and it is the one that asks for a decision — a waypoint that was not saved is only recoverable if the rider learns about it while still at the place they wanted to remember.

The timer is restarted, not extended: the newest message is the true one, and it gets its own full reading time rather than inheriting the remainder of the last one's.

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

## Service mode: reading the VCU — `views/service-mode.js`, `views/vcu-probe.js`, `lib/params-page.js`

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

### Which parameter table the names came from — `lib/params-page.js`

Every name on `/params.html` comes from the table THE BIKE ITSELF named at 276/277 — the Pi re-names the stored snapshot from it before serving it — or from a default when the bike has named none. The table-type line is the thing that says which, and there is no other way to tell: a wrong table is invisible in every other way, because routing and record widths are identical across all 28 of Energica's tables, so a bike on the wrong one reads and writes perfectly and merely means something else by every name.

That is not hypothetical. This bike was asked on 2026-06-14, the answer sat unread in a dump for two months, and the table embedded here was one revision out the whole time — right about 276 of 277 names and silently wrong about the 277th. And on 20 of the 28 tables ids 70–94 are a regen fade curve where the other 8 have the battery cell block, so on somebody else's bike the same silence would be worth 25 names rather than one.

The verdict is computed on the Pi (`src/vcu/snapshot.ts`, `reportTableType`) so there is exactly one copy of "which table are we".

Three states, three appearances. "A micro never answered" must not render identically to "both agree" with only an emoji between them — that is the state this bike is in today, and rendering it as normal is the whole failure this line was added to stop. `split` counts as alarming: two micros naming different tables means some of the names on the page are one table's and some are the other's, which is worse than either being wrong on its own. An alarming verdict also goes to the console, because it is the one finding on the page worth pasting into a bug report verbatim.

`ageInWords` in `lib/format.js` is where the phone-clock reasoning lives now — three pages were computing it inline off the same `readAt`, with thresholds that had already drifted apart: `/params.html` said "73 h ago" where the same snapshot on the service sheet said "3 days ago".

### The probe form — `views/vcu-probe.js`

"Probe index N" reads ONE identifier off ONE ECU, from the phone. It is the replacement for `scripts/read-vcu-params.ts --index N`, which went away when the sweep moved into the service, and it reaches further than that flag did: the identifier is `(bank << 12) | index`, the sweep reads bank 1 (the calibration EEPROM), and **bank 2 is live data** — the running values rather than the stored settings — which nothing in this project had ever read.

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

`arm()` is the ONLY way `armed` is set to a non-empty key. All three arming sites go through it — `ActionButton`'s own `onclick`, `armWrite()` and `armClockSync()` — so no control can be armed without also being subject to the dwell. Disarming stays a plain `armed.val = ""` and needs no stamp: every firing site tests `armed.val` first, and an empty key matches none of them.

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

### Reading the outcome — `send()` and `performWrite()`

⚠️ THE ANSWER IS TAKEN FROM THIS REQUEST'S OWN RESPONSE, never from `state.val`. `send()` leaves the state alone when the request does not come back, so reading the verdict out of the state would attribute the LAST write's result — including its "written", its read-back and the verification hint — to an attempt that may have reached the bike and may have done anything at all. That is why `send()` returns the payload, or null.

The three outcomes:

- **no response at all** — the worst case, and it stays the worst case. Nothing is claimed about the parameter, and the reading goes, because the frame may well have gone out. The next write has to read first. A write request that did not come back may still have reached the bike — the frame goes out before the response comes back — so "it failed" would be a claim nothing supports, and the message says so at length.
- **400 or 409** — refused BEFORE the bus: a malformed query, a busy bus, a closed gate. Nothing was read and nothing was written, so the reading on screen is exactly as true as it was a second ago and is kept, along with what was typed: the answer to "the sweep is using the bus" is to wait and press it again, not to start over.
- **a result** — the reading is replaced from the read-back the write itself did, so the value on screen is the one that is true afterwards rather than the one the sweep recorded before. Cleared when the attempt reached the bus and produced no reading (refused at the session or security step, or a failure partway): the write may have landed, so the page falls back to the sweep's older value, correctly labelled as old, and the Pi re-reads before any second attempt exactly as it did before this one.

The body carries the status and the journal on every code this endpoint returns, including 400 and 409, so it is read before the status is judged. `X-Cool-Eva: service-write` is a DIFFERENT value from the read endpoints' `service-mode`, so a caller built for those cannot reach this one.

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

`refreshVcuWrite()` is called by `views/service-mode.js` whenever the sheet opens: it refreshes, disarms and re-folds everything. Re-folding is not in `forgetSelection()`, which also runs when the PARAMETER changes — the irreversible actions have nothing to do with which parameter is selected. The `dangerOpen` reset belongs to the sheet-opening reset alone, for the same reason `armed` is cleared there: the state a sheet opens in is the state a thumb finds when it is reaching for something else, and that state must not contain `31 FC`.

`fetchStatus()` is kept apart from `refreshVcuWrite()` because arming the clock sync needs a fresh `clock.iso` and must not wipe a parameter reading somebody took thirty seconds ago.
