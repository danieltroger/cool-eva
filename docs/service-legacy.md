# Service implementation before the approved sketch

Historical notes preserved from the removed Service and raw-signal views and their source-based checks. They describe the earlier UI, including controls and routing that no longer exist. Use the current implementation and [Service parameter rules](service-parameters.md) for present behavior.

## public/views/service-mode.js

Original line 17:

```text
Service mode: read the VCU's calibration parameters off the bike on demand, and
hand the result over as the file another owner's the external backup writer reads.

The page LEADS with what the read gate currently says (src/vcu/service-gate.ts),
because a button disabled with no reason given is indistinguishable from one that is
broken. The server is still the authority: this page only reports what the Pi said.

Nothing here blocks. A sweep is ~300 reads over a link that drops as routine, so the
button starts it and returns; progress comes from polling /vcu-read once a second
while the sheet is open AND there is something to watch. The sweep runs on the Pi.

⚠️ The button ARMS first: ~300 requests compete with the OBD poller for the scarce
resource, and since #219 the sweep also PARKS that poller for 25 of them, so speed,
rpm and the temperatures stop updating 25 times during one — which is why the arm
line says so. It is NOT the only control that reaches the bus (#129) — the list of the
others lives in docs/dashboard-decisions.md §"Why the sweep button arms first" rather than
here, so there is one copy of it to rot rather than two. It is the longest. Why two taps
and no modal, and why this is not a tab: that same file.
```

Original line 42:

```text
⚠️ The sweep used to declare an `armed` of its own here, with no dwell and no
key-repeat refusal, and `scripts/check-arming.ts` scoped its scan AWAY from this file
to avoid reading two different states as one. Importing ../lib/arming.js for the
lifetime read below joins this file to ARMING_CONSUMERS automatically, which is what
forced the migration — and the sweep gains the 400 ms dwell it never had.
docs/dashboard-decisions.md § "The other `armed`".
```

Original line 53:

```text
Bumped once a second while a sweep runs, purely so the elapsed line re-renders.
```

Original line 56:

```text
Phone-side monotonic mark for when we first SAW a sweep running.

Not `run.startedAt`, which is the Pi's wall clock: the Pi has no RTC and steps
its own clock from GPS, so subtracting it from `Date.now()` here is arithmetic
across two clocks that disagree — the thing ../lib/clock.js exists to forbid.
The cost is that the timer reads from when the page noticed rather than from the
true start, which is why it is labelled "watching for" and not "running for".
```

Original line 85:

```text
⚠️ Everything above this line reads. Everything below it can CHANGE the
motorcycle, and it is behind its own switch (SERVICE_WRITE_ENABLED, off by
default) and fetches its own state. It is last on the sheet on purpose: the
things you do most often should not be underneath the things you cannot undo.

This comment used to be the only place that boundary existed. It is now on
screen as well — an amber level-1 heading with a rule above it, and a line
under the "Service mode" heading in ./sheet.js saying it is coming.
```

Original line 97:

```text
What the safety gate currently says, above the button rather than instead of it.

Every blocker is listed rather than only the first, because "speed unknown AND
the bike is in drive" is a different situation from either alone — and because
one of them naming a signal that has never arrived is how you find out that the
CAN side is not running at all, rather than that the bike is moving.
```

Original line 112:

```text
A charging bike is allowed in, and it is worth saying so explicitly rather
than letting "out of drive" stand next to a bike whose drive is plainly
energized. The evidence is named because this is the one place the gate
relaxes a check, and a relaxation nobody can see is one nobody can audit.
```

Original line 130:

```text
Starts a sweep, or stops the one that is running. One button rather than two:
while a sweep is running, stopping it is the only thing you can usefully do to
it, and a dead "Read" button next to a live "Stop" is a worse thing to hit.
```

Original line 141:

```text
Disabled only for STARTING — a sweep already running must stay stoppable
whether the flag was set or the bike started moving, which is why this
reads `isRunning()` first. Both reasons to be disabled are the server's,
read off the last response; the page decides nothing here.
```

Original line 146:

```text
One held Enter must not arm and then fire. See ../lib/arming.js.
```

Original line 175:

```text
🔎, not 🔧. The wrench was on this button AND on "say a service was
performed NOW", i.e. on the safest control in the sheet and on one of the
three that cannot be undone — the one glyph collision that actively
mislead. 🔎 now means "this reads the bike" everywhere in the sheet, and
🔧 is left to mean the service point and nothing else.
```

Original line 187:

```text
What the sweep is doing, or what the last one did.

Every branch names WHICH micro answered and HOW MANY parameters came back,
because those are the two facts that tell a silent bike apart from a silent
micro apart from a sweep that never started. A bare "failed" would leave all
three looking the same.
```

Original line 232:

```text
The non-`read` outcomes, by name.

Shown rather than summed into one "failed" count because the codec draws
distinctions a rider needs: `no-session` means the micro never woke up,
`no-response` means it was awake and said nothing to that particular parameter,
`refused` means it answered by name, and `not-sent` is our own socket rather
than the bike. Collapsing them would put our dead CAN interface on screen as the
motorcycle refusing to talk.

@param {VcuReadTally} tally
```

Original line 252:

```text
Downloads the snapshot in the external backup writer's own backup format.
```

Original line 263:

```text
./lib/transport.js download(): a navigation on wifi, so the browser's own
download UI puts the file somewhere the phone can share it from — the entire
point of exporting it — and a tunnelled blob over BLE, where there is no URL.
```

Original line 286:

```text
The AGE leads, because this button does not export what the progress line
above it just said. It exports `latest.json`, and the script deliberately
leaves that file alone when a run reads nothing — so a sweep that found the
bike asleep leaves "0 of 302 read" directly above "Export 233 parameters",
both true, and the natural reading of the second one wrong. An age is what
makes it obvious the file is from another day, and this is a file people
send to other owners as their bike's calibration.
```

Original line 301:

```text
Fetches the current state, and starts or stops a sweep.

Every outcome lands in the UI, including the refusals: a POST while one is
already running comes back 409 with the reason, which is a thing the page should
say rather than a thing to retry.

@param {"GET" | "POST" | "DELETE"} method
```

Original line 315:

```text
Not a secret and not authentication. A header a CORS-simple request cannot
set is what stops some other page in this browser starting a sweep on the
bike's bus without the owner — see the header of src/http/vcu-read.ts. Our
own page is same-origin, so it costs no preflight.
```

Original line 321:

```text
The body carries the state on every status this endpoint returns, including
409 and 202, so it is read before the status is judged.
```

Original line 335:

```text
Loud. The usual cause is the phone having dropped off the bike's hotspot,
and a button that silently does nothing is the worst version of that.
```

Original line 342:

```text
Polls while the sheet is open and there is something to watch.

Self-scheduling rather than a standing `setInterval`, so the loop ends by simply
not scheduling itself again — there is no timer left behind to leak, and no
traffic at all once there is nothing to see. `sheetOpen` is passed in rather than
imported to keep this module free of a circular import with ./sheet.js.
```

Original line 351:

```text
Checked before the first timer is armed, not only inside the loop: called after
every response, this would otherwise cost one wasted request each time the sheet
is opened on an idle, parked bike — the common case.
```

Original line 374:

```text
One second: fast enough that a ~300-read sweep visibly moves, slow enough to be nothing on a Pi Zero.
```

Original line 380:

```text
The sweep's firing site. Named so scripts/check-arming.ts can find and scan it.
```

Original line 385:

```text
Called once by ./sheet.js when the sheet opens: refresh, and let this module
know how to tell whether it is still open.

@param {() => boolean} isOpen
```

Original line 397:

```text
The write section keeps its own state and its own endpoint, so it is refreshed
alongside rather than folded in — and its refresh DISARMS every button it has,
which is the property that matters here: re-opening the sheet must never find a
half-confirmed irreversible action waiting for its second tap.
```

Original line 404:

```text
Two things are worth following, and neither of them is "the sheet is open".

A running sweep, obviously. And a gate that is currently refusing — because the
bike being wheeled into the garage is exactly the moment someone is standing here
waiting for the button to come alive, and making them close and re-open the sheet
to find out would be silly. An idle, safe service mode polls nothing: that is the
state a phone forgotten on the workbench is in.
```

## public/views/vcu-write.js

Original line 13:

```text
Service mode's WRITE section: change one allowlisted VCU parameter, or run one of
the four service actions.

⚠️ Nothing on this page decides anything. The allowlist, the ranges, the
compare-and-swap and the read-back all live on the Pi (src/vcu/write-targets.ts,
src/vcu/write-session.ts). This page cannot widen any of them and does not try; where
it and the server disagree, the server wins and the page shows the server's reason.

Four things make an accidental write hard, in the order they are met: a write is
always against a value READ off this bike, the confirmation shows old → new, it takes
two taps separated by ARM_DWELL_MS, and the three irreversible actions are behind a
fold. A fifth lock is not about care at all — the table-type gate, see `canWrite`.

What each of those cost, what was measured, and the three risk tiers this page is
painted in: docs/dashboard-decisions.md §"Service mode: writing".
```

Original line 39:

```text
@typedef {{ value: number, rawHex: string | null, label: string | null,
  source: "bus" | "sweep", readAt: number | null, complete: boolean }} OnBike
```

Original line 44:

```text
A single parameter read off the bike: the typed value, or why the read failed. Named so
the `ok: true`/`ok: false` literals survive as a discriminated union across both readers
— an inline union in one `@returns` and a bare inference in the other widen `ok` to
`boolean`, and then `if (!read.ok)` no longer narrows to the value branch.
@typedef {{ ok: true, value: number } | { ok: false, reason: string }} ReadResult
```

Original line 53:

```text
The 269 names the dropdown is built from, held HERE rather than read off `state`.

⚠️ Every refresh but the sheet-opening one asks for `list=0` (14 397 bytes the page already
has), so `status.targets` is null on most responses — null meaning NOT ASKED FOR, never "this
bike has nothing writable". Keeping the list in its own state is what makes those two
impossible to confuse: it is replaced only from a response that carries one, so a pre-arm
refresh cannot empty the picker under a thumb.

@type {import("../vendor/van-1.6.1.js").State<WriteTargetListing[]>}
```

Original line 65:

```text
Which parameter table the listing was fetched under, or null when no listing is held yet.

⚠️ `writeTargets()` is derived from the ACTIVE parameter table, and `writeSnapshot()` selects a
new one (src/vcu/snapshot-store.ts) — from this very sheet, which is where sweeps are started.
So a listing can go stale under an open sheet: a response whose tableType differs from the one
the names came from discards them and asks again, rather than offering a picker of names the
Pi would no longer accept. Wrapped in an object so "no listing" and "a listing taken under an
unknown table" stay different things.
```

Original line 76:

```text
Which status read has spoken most recently, so a slow answer cannot overwrite a newer one.

⚠️ The selection can move while a read is in flight — the `<select>` starts one on every change
— and the reply carries a `detail` for whatever was selected when it was ASKED. Applied out of
order it lands a detail the form refuses, with nothing left on its way to replace it. Same
counter, same reason, as views/charge-auto.js's `latestRead`.
```

Original line 85:

```text
How many times one fetchStatus() may re-ask before it is a loop rather than a correction.
```

Original line 87:

```text
Which allowlist entry the form is on. Empty until the section has loaded.
```

Original line 89:

```text
The freshest value this PAGE has had off the bus — a probe read, or the read-back at
the end of a write — and which parameter it belongs to.

⚠️ The name rides along rather than the reading being cleared when the parameter
changes, which is what the previous shape did. A reading and a `selected` that can
drift apart is the bug this prevents: `onBike()` below only ever hands out a reading
whose name matches the parameter the form is on, so there is no ordering in which a
number belonging to one parameter can be shown — or sent as `expected=` — against
another.
```

Original line 102:

```text
The two-tap arm/dwell (`armed`, `arm`, `armDwellElapsed`, `refuseKeyRepeat`) lives in
../lib/arming.js now, shared with the charge tab's charge-current control so there is one
dwell rule for the whole dashboard. What was measured and why 400 ms: see that file.
```

Original line 105:

```text
Whether the selected parameter's warnings are unfolded. Collapsed by default — see TargetNote.
```

Original line 107:

```text
Whether the three irreversible service actions are unfolded.

Collapsed by default and re-collapsed on every sheet open, for the same reason
`armed` is cleared there: the state a sheet opens in is the state a thumb finds when
it is reaching for something else, and that state must not contain `31 FC`.
```

Original line 115:

```text
The last clear made from this page — the Pi's sentence and the Pi's verdict — or null.

Its own state rather than read off `state.val.result` for the reason StampOutcome has one: a
request that never comes back leaves the PREVIOUS answer in `state`, and a stale green proof
under a button whose press just vanished is the worst thing this card could say.
```

Original line 123:

```text
The last write attempt made from this page, so the outcome and the verification hint
can be shown against the parameter they belong to rather than to whatever is selected
when the answer lands.
```

Original line 131:

```text
WHICH control is mid-request, or "" when none is.

`busy` alone disables every button, which is right; it cannot say which one is working,
and a spinner caption on all four would claim three actions are running that are not.
```

Original line 138:

```text
True only while a write's own POST is in flight.

⚠️ Separate from `busy`, which is also raised by the probe read and by the refresh
the write button's first tap does. This page must not say "Writing…" while it is
doing something else: a caption claiming a write is in progress when none is would be
a lie about the one thing on this page that cannot be taken back.
```

Original line 148:

```text
What the last-service read came back with, held apart from `message` so it can be shown at
the button that asked for it.

⚠️ `message` is CLEARED when this is filled — but only while this node is mounted. Its two
homes are Outcome(), three sections up, and VcuWrite's failure line, which renders exactly
when this one does not. docs/dashboard-decisions.md §"Reading the outcome".

⚠️ Cleared, not refilled, when `31 FC` runs: that routine overwrites the block this read
reports, and it is two taps away inside the same fold. Why nothing else touches it, and
why the new stamp is not shown here: docs/dashboard-decisions.md §"Reading the outcome".
```

Original line 161:

```text
Which circuit an all-lights run is on, e.g. `Disabling stop / brake… (4 of 5)`. Shown
under the two all-lights buttons while `writing` holds them disabled — one run is five
sequential writes, and a single "Writing…" would hide which one a partial run stopped at.
```

Original line 168:

```text
The headlight-off control's fixed parameter and its two fixed values.

⚠️ NOT a new action. This is the ordinary allowlisted parameter write — a fresh read,
the compare-and-swap, the read-back — on ONE parameter and two fixed values, wrapped
in two buttons so nobody has to know the name or the number. The mechanism and its
on-bike proof are in docs/headlight-beam-threshold.md: the beam's over-current
threshold, written below the beam's real draw, makes the VCU fault the beam OPEN
CIRCUIT at its next initialisation and bring it up dark. Persistent, and reversible by
writing the threshold back to factory.

⚠️ The off value is FIXED, not measured. The proven route reads the live beam sense
(control 18) and writes half of it — but that read is on the banned 0x2F diagnostic
path, so this ships a constant below any real beam draw instead. 1810 mA sits well
under this bike's ~3600 mA beam and above zero; a beam drawing less than 1810 mA would
not fault, which is the one case where the button does nothing.
```

Original line 187:

```text
params.ecf's factory value for BEAM_MAX_CURR_TH — what “restore” puts back.
```

Original line 190:

```text
Every VCU-current-sensed light: the MAX threshold that writes it OFF (below the circuit's
real draw, so the VCU faults it dark at the next key-cycle), and the params.ecf CATALOGUE
MAX. The beam row IS the headlight above — the all-lights buttons are a superset of it.

⚠️ `catalogue` is the restore FALLBACK, not the value normally written. Restore prefers
this bike's OWN healthy MAX, read off the bus and saved the moment the light was disabled
(savedLightValues) — the two differ, and not harmlessly: this bike's indicators run 2000 mA
where the catalogue says 500, and 500 is also the indicator's off value, so a catalogue
"restore" of the blinkers writes them straight back off. The catalogue is only reached for
when nothing was saved, and the run says so. On-bike values: docs/headlight-beam-threshold.md.

@typedef {{ label: string, param: string, off: number, catalogue: number }} LightCircuit
@type {LightCircuit[]}
```

Original line 213:

```text
localStorage key for this bike's saved healthy light MAX values, a name→mA map. See savedLightValues.
```

Original line 216:

```text
The BEAM_MAX_CURR_TH value the first tap read off the bike, held for the second tap to
send as `expected=`. Cleared on every sheet open and after every attempt, so a value
read for one gesture can never be sent as the precondition of a later one.
```

Original line 225:

```text
The only amber heading: the line the sheet's read half ends at.

⚠️ The amber and the rule under it are governed by `hasControls()` — THE SAME
condition that decides whether the controls render at all, three lines below, so
a warning about what is under a heading cannot be made to disagree with what is
actually there. See docs/dashboard-decisions.md §"The section heading and its note".
```

Original line 232:

```text
The section's risk PROFILE, said here rather than only at the fold 600 px down.
It does not say "everything below here can change the motorcycle" — that was
false of four of the controls, and a section heading that lies is worse than none.
```

Original line 243:

```text
⚠️ The one thing that MUST render when there are no controls: why there are none.
`message`'s only other home is Outcome(), inside the branch hasControls() has just
switched off, so the loudest failure this section has was being written to a node
that did not exist. `.failure`, not `.action-note`, and Availability() stands its
ellipsis down beside it — docs/dashboard-decisions.md §"The section heading".
```

Original line 249:

```text
⚠️ `write-controls` is a NAME, not a style — nothing in style.css selects it. It is
here because the design preview's close-ups have to find this block, and counting
siblings to reach it is what broke them for twelve days when the section grew from
three blocks to six: docs/diagnostics-and-checks.md §11.6. On BOTH branches, so the
block is findable before the Pi has answered as well as after.
```

Original line 269:

```text
Whether this section is actually rendering controls.

Deliberately `=== true` rather than truthiness, and deliberately one function used
by the heading, the warning under it and the controls themselves — see the heading.
```

Original line 279:

```text
Whether writing is possible at all, and why not when it is not.

Leads the section for the same reason the gate note leads the read section: a
disabled button with no reason given is indistinguishable from a broken one.
```

Original line 289:

```text
⚠️ The ellipsis means "waiting for an answer", and it must stand down the
moment one kind of answer arrives. `status` stays null for ever after a failed
GET — nothing re-polls /vcu-write while the sheet is open — so with the Pi
unreachable this section read as loading and failed at the same time, with the
loading claim the more visible of the two. The failure line VcuWrite() renders
just below is the true one; this one goes quiet and lets it speak.
```

Original line 307:

```text
⚠️ The table note is rendered HERE TOO, not only in the safe branch. It is the
same person on the same trip: the reason they cannot write this second is the
vehicle-state gate, and the reason they still will not be able to once they
park is this one. Showing them one at a time means a second walk out to the
bike — and the write button below is rendered whenever writing is enabled, so
it would otherwise be saying "see above" with nothing above it.
```

Original line 335:

```text
Which commit the Pi is running, on every branch of the status block.

⚠️ Not decoration. On 2026-09-07 the charge-current feature changed the dash's number and
moved no current, and the cause was that the Pi had been running a five-day-old build since
before the fix landed — indistinguishable, from the garage, from a feature that does not
work. This is the line that tells those two apart before anyone starts debugging the wrong
one. `+dirty` means tracked files differ from that commit, so the running code is not the
committed code; `+unverified` means git could not say, which is flagged the same way rather than
shown as clean. src/version.ts.

@param {VcuWriteStatus} status
```

Original line 353:

```text
Whether the bike has said which parameter table it runs — and what to do when it
has not.

⚠️ The two blocked states are rendered DIFFERENTLY on purpose, in colour and in
words: red when no read will help (a table this software cannot write against) and
amber when one will (nobody has asked the bike yet). A single "writes are blocked"
would send someone hunting for a software bug when the answer was one frame.

⚠️ The branch is on `noReadWillHelp`, not on `state` — testing `state === "mismatched"`
quietly rendered every later-added state as the amber one. The sentences come from
the Pi (src/vcu/table-gate.ts) rather than being written again here.
See docs/dashboard-decisions.md §"the table-type gate".
```

Original line 370:

```text
Silent when confirmed. The line above already says writing is available, and a
green "table confirmed" badge would be one more thing to read past every time.
```

Original line 383:

```text
The remedy is the reason this is a gate and not a wall, so it gets the emphasis
rather than the muted grey the reason sits in.
```

Original line 396:

```text
The count comes from the same array the dropdown renders, so the sentence cannot
disagree with the options above it. It reads 269 — every parameter in the bike's
table except four duplicated names. The first five are the RESEARCHED ones; the
rest carry the datatype's full range and a warning saying nobody established a
safe value. That distinction is what the old five-name allowlist used to enforce
by absence, and it is why `purpose` renders uncollapsed.
```

Original line 422:

```text
The allowlist as a picker.

⚠️ The whole `<select>` is rebuilt by the binding and the options are its DIRECT
children, never wrapped in a `<div>`. That wrapper is not in `<select>`'s content
model and produced two real faults: an EMPTY dropdown on the phone this dashboard is
used on, and a picker that snapped back to the first parameter on every status
refresh while the rest of the form stayed put. Which option is current is therefore
set on the OPTION (`selected`), never on the select afterwards.
See docs/dashboard-decisions.md §"The `<select>` is rebuilt whole".
```

Original line 439:

```text
See the note on the bits picker below for why this is a name rather than an id.
```

Original line 453:

```text
What the selected parameter is, and one tap to what is wrong with changing it.

The warnings are collapsed rather than dropped, and the toggle is amber and counts
them so a collapsed block still says there is something to read. Why they are not all
stacked above the input: docs/dashboard-decisions.md §"Where each sentence belongs".
```

Original line 464:

```text
A selection whose detail has not landed yet — the round trip the `<select>` starts. Said
rather than left blank: an empty space under a parameter name reads as "there is nothing
to know about changing this one", which is the opposite of what it means.
```

Original line 487:

```text
`caution`, the same class the service actions' why-you-might-not-want-to lines
use, rather than an inline WARN: these are the same tier of sentence and there
is now one place that decides what that tier looks like. The toggle above keeps
its inline colour — it is a control, and the tiers are about prose.
```

Original line 496:

```text
Everything the allowlist says against changing this parameter, in one list.

The per-bit caveats are folded in rather than kept in a block of their own: they are
warnings about the same act, and two separately-headed lists of amber paragraphs was
half the problem.
@param {WriteTargetSummary} target
@param {string | null} chargingEvidence what says the bike is on a charger, or null
```

Original line 513:

```text
What writing THIS parameter mid-charge does to the session in progress.

⚠️ Two different claims, and they are not interchangeable. The config word is READ AT
BOOT — that is in the allowlist's own `verify` line and is a fact about the firmware. For
everything else nothing establishes whether a running session re-negotiates, so this says
that rather than inventing a rule: docs/vcu-parameters.md §5 goes as far as "change ONE
parameter per charge session" and no further.
@param {WriteTargetSummary} target
```

Original line 529:

```text
Old → new, on one line, because that is the sentence the two taps agree to.

The arrow is a character between two fields rather than a caption anywhere, so the
relationship survives being read at arm's length in a garage.
```

Original line 545:

```text
⚠️ `readout`, so it does not look typeable. This is the only field-shaped thing
in the sheet that cannot be edited, and it sat immediately left of "Change to"
in identical chrome — a read/write pair rendered as two of the same thing, which
is the exact confusion the rest of this page is built to remove. The number here
is also what gets sent as `expected=`, so "where did this come from" is a
question worth the box answering by its shape.
```

Original line 558:

```text
The WORD is what gets written and what the compare-and-swap is against, so it
is what is shown — but what is being changed is one bit of it, and "is that bit
on right now" is the question in front of somebody about to toggle it.
```

Original line 567:

```text
`0x1113 · Heated handlebars OFF`. The word, then what its writable bits say.
@param {WriteTargetSummary} target @param {number} value
```

Original line 579:

```text
Where the number to the left came from, and what may be typed to the right.

⚠️ The provenance is not decoration. A value the last sweep read an hour ago and a
value read off the bus ten seconds ago are both legitimate preconditions — the Pi
re-reads either way — but they are not equally likely to still be true, and the one
thing the page must never do is present them as the same thing.

⚠️ The age is computed at RENDER, and nothing polls /vcu-write while the sheet is
open, so a sheet left untouched shows the age it had when something last re-rendered
it. That is why the write button's first tap refreshes before it arms (`armWrite`):
the caption is re-rendered from the Pi's answer at the moment somebody starts to
commit, which is the moment its accuracy is load-bearing. A timer ticking this every
minute for a phone sitting on a workbench would be the wrong trade.
```

Original line 609:

```text
A config word is written and read as hex everywhere else on this page, so a
decimal 4375 here would be a third rendering of the same number to reconcile.
```

Original line 621:

```text
A number box for a value, a picker for a bit.

The bit case is the point: there is no way here to type a word into VSM_CONFIG_1,
because the same word carries the PSU type and the Bluetooth variant and a
fat-fingered word would reconfigure both. The server would refuse it too — the
allowlist has no number control for that parameter — but the form should not offer
a shape the server will only reject.
```

Original line 635:

```text
`selected` on the option rather than `value` on the select, for the reason
ParameterSelect() gives above: this binding re-runs whenever the status does,
and a `value` applied before the options exist is silently dropped —
which would put the picker back on "choose…" while `wanted` still held a bit.
```

Original line 642:

```text
⚠️ `name`, not `id`, and this is the reason: the annotated design sheet mounts a
separate instance of this module per panel, so up to seven of these exist in one
document and unique ids are not available. A name satisfies the same DevTools issue
("a form field element should have an id or name attribute") with no uniqueness
contract to break. `autocomplete="off"` because a name is also what Chrome keys
autofill history on, and a remembered value offered on a control that writes to the
motorcycle is a suggestion nobody asked for.
```

Original line 667:

```text
See the note on the picker above for why this is a name rather than an id.
```

Original line 674:

```text
Retyping disarms. Otherwise the second tap could send a different number
from the one the first tap agreed to.
```

Original line 682:

```text
Reads the selected parameter off the bike, through the read path's probe endpoint.

Deliberately the PROBE and not a new read: /vcu-probe already reads one identifier
off one micro, it is already gated and single-flighted, and adding a second way to
read one value would be two things to keep in step.
```

Original line 700:

```text
⚠️ Only when the READ is what is running. `busy` is global, so this said "Reading…"
through a clear, a service stamp and a clock sync — claiming an operation that was not
happening, which is the exact thing `working` was added for one screen away.
```

Original line 705:

```text
Two captions, because the button is answering two different questions. With
nothing read it is the way to get a value at all; with a sweep's value already
on screen it is how you find out whether that value is still true, which is a
thing you may want and no longer something you are made to do.
```

Original line 723:

```text
The middle tier, and the only control in it. A parameter write changes the
bike and can be written back — which is why it is amber and on screen,
rather than red and behind the fold with the three that cannot.
```

Original line 727:

```text
One held Enter must not arm and then fire. See refuseKeyRepeat.
```

Original line 729:

```text
Unavailable until a value has been read off this bike, until something has
been chosen to write, and until the bike has named its parameter table. The
server enforces all three — the compare-and-swap, the allowlist and the table
gate — and the page simply does not offer a button whose request would be
refused.
```

Original line 740:

```text
Same dwell, same reason as the irreversible three. This one is reversible,
which is why it is amber — but a write nobody meant is still a write, and
one rule for every second tap on this page is one rule to keep true.
```

Original line 755:

```text
The first tap's refresh, or a read running in the section above. Neither is
a write, and neither may be captioned as one.
```

Original line 761:

```text
Ahead of the "read it first" caption: reading the value would not help
here, and a button that asks for a reading it will then refuse to act on is
worse than one that says what is actually wrong. The full sentence and the
remedy are in TableTypeNote() above; this is the short form on the control.
```

Original line 768:

```text
nothing, so a caption saying "read 277" sends people round a loop that
never ends. The full sentence is in TableTypeNote() above.
```

Original line 775:

```text
Each disabled state says which of the two things is missing rather than
sharing one caption: "nothing has read it" and "you have not said what to
write" are fixed by different taps in different places.
```

Original line 797:

```text
`MAX_DC_CHG_CURRENT: 75 → 80`, or `VSM_CONFIG_1: Heated handlebars → ON`. What the
two taps are agreeing to.

⚠️ The PARAMETER NAME is in here and must stay. This caption is the one place a
person commits, and it is the only thing besides the picker that names what is about
to be written — so a picker showing the wrong parameter is contradicted here rather
than agreed with. `75 → 80` alone reads identically for four of the five entries at
plausible values, which is exactly the reading a bare number cannot survive.
```

Original line 821:

```text
What the last write did, and — only once it has been done — how to check the bike
for yourself.

⚠️ The verification hint is deliberately not shown before the write. It is an
instruction for afterwards ("0x625 b2 should now read…"), it was one of four amber
paragraphs competing with the ones that argue against pressing the button at all, and
standing in a garage the moment it becomes useful is the moment the write has landed.
```

Original line 835:

```text
Both the clean write and the read-back mismatch get it: the mismatch is exactly
the case where an independent check is worth most. A refusal or a stale
precondition changed nothing, so there is nothing to go and look at.
```

Original line 848:

```text
Two buttons that turn the headlight off and back on, over the bus.

⚠️ Nothing here is a new lever on the bike. Both buttons POST the SAME
`action=parameter` write the form above sends, on `BEAM_MAX_CURR_TH` and a fixed
value — so the allowlist, the compare-and-swap, the read-back, the table gate and the
audit journal all apply exactly as they do to any other parameter write. What this
adds is the fixed parameter, the two fixed values, and the caveat a person needs.

⚠️ Hidden entirely when the bike's table has no BEAM_MAX_CURR_TH — a parameter write
by index against a bike that does not carry it is exactly what the table gate exists
to refuse, so the page does not offer the button.
```

Original line 876:

```text
⚠️ Above the button, on the way to the thumb: this is the one thing about it a
person will not expect. It is NOT a live switch — the light stays on until the
bike is keyed off and on again.
```

Original line 899:

```text
Reset the VCU — restarts both micros with ECUReset (11 02), a key-cycle restart.

Placed right under the light controls because that is the reason it exists: a parameter
change like the headlight and all-lights ones above comes up OFF/ON only at the next
key-cycle, and this is the key-cycle without walking to the bike.

⚠️ Reversible — the bike reboots and comes back — so it is the plain tier, NOT behind
the irreversible fold. It is still gated: the server refuses it mid-charge and, through
the shared safety gate, while the bike could move. Both nodes always restart together;
resetting one alone latches a fault on its partner.
```

Original line 927:

```text
One of the two headlight buttons. `off` picks which: the amber “writes” tier for
disabling (it changes the bike), the plain tier for restoring.

The first tap READS BEAM_MAX_CURR_TH off the bike and arms; the second, after the
shared dwell, writes the fixed value with that reading as `expected=`. Same two-tap
shape, same dwell and same key-repeat guard as the parameter write above.

@param {boolean} off
```

Original line 944:

```text
One held Enter must not arm and then fire. See refuseKeyRepeat.
```

Original line 946:

```text
Same gate as the parameter write — it IS a parameter write by index, so the
table gate applies. The server enforces all of it regardless.
```

Original line 970:

```text
The short form; the full sentence and remedy are in TableTypeNote() above.
```

Original line 985:

```text
Two buttons that turn EVERY light off and back on — the headlight section's move applied
to all five circuits in LIGHT_CIRCUITS at once.

⚠️ Not a new lever on the bike: it sends `action=parameters`, a batch of the same gated
parameter writes the form and the headlight buttons make. The server opens ONE session and
unlocks ONCE, then compare-and-swaps, writes and reads back each circuit and gives it its own
audit line — so the allowlist, the table gate and all the per-parameter safety apply to each
exactly as to a lone write; only the authenticated session is shared. That sharing is the point:
five separate unlocks cannot fit inside the server's SecurityAccess cooldown, so a per-circuit
loop had to wait one out between each (~25 s) — one session writes them back-to-back.

Hidden when the bike's table has no BEAM_MAX_CURR_TH, for the reason HeadlightSection is:
a write by index against a table that lacks these params is what the gate exists to refuse.
```

Original line 1015:

```text
Both cautions ABOVE the button, on the way to the thumb — the same placement the
headlight's "not immediate" line uses. The road-legal one leads: it is the whole
reason not to press this, and it is reversible, so it is caution (amber) and NOT
the red no-undo tier, which means something this is not.
```

Original line 1041:

```text
The per-circuit progress of a run in flight, and where a partial run stopped. Muted:
the outcome summary lands in `message` (Outcome, above) when the run finishes.
```

Original line 1048:

```text
One of the two all-lights buttons. `off` picks the amber “writes” tier and the disable
run; restore is the plain tier. First tap arms; the second, after the shared dwell, runs
performAllLights. Unlike the headlight button there is no first-tap read — performAllLights
reads every circuit's value inline, then writes the survivors in one batched session.

@param {boolean} off
```

Original line 1063:

```text
One held Enter must not arm and then fire. See refuseKeyRepeat.
```

Original line 1065:

```text
`writing` as well as `busy`: the batch's send() drops `busy` on its way out while the
run is still finishing, and a second tap must not start a second run into the first.
```

Original line 1089:

```text
The short form; the full sentence and remedy are in TableTypeNote() above.
```

Original line 1104:

```text
Disable or restore every circuit in LIGHT_CIRCUITS in ONE authenticated session. First reads
each circuit off the bike — to seed the compare-and-swap's `expected=`, to skip a circuit
already at target, and (when disabling) to save its healthy value — then sends the survivors
as a single `action=parameters` batch. The server opens one session, unlocks once, and
compare-and-swaps + writes + reads back each parameter with its own audit line; the shared
unlock is the whole reason this is one POST rather than five spaced past a SecurityAccess
cooldown. Each circuit's outcome comes back in `result.writes`, mapped by name; the run is
summed into `message` (rendered by Outcome, up the sheet).

@param {boolean} off
```

Original line 1118:

```text
Held for the WHOLE run — the per-circuit reads AND the batch. readTargetValue does not touch
`busy`; the single send() drops it on its way out, but result-handling after it is
synchronous, so `writing` is what keeps every button on the sheet disabled to the finally.
```

Original line 1123:

```text
Restore reads this bike's own healthy values, saved when the lights were disabled; the
catalogue is only the fallback. Snapshot once so the whole run sees a consistent map.
```

Original line 1132:

```text
Circuits restored from the params.ecf catalogue because nothing was saved for them.
```

Original line 1135:

```text
The survivors of the read-and-decide phase — what actually gets written, one `w=` each.
```

Original line 1139:

```text
── Read each circuit and decide what, if anything, to write ────────────
```

Original line 1153:

```text
On restore, trust a saved value only if it is above the off threshold — a healthy MAX
always is (off sits below the draw, below the healthy MAX). Anything else is stale or
corrupt, so fall back to the catalogue as if nothing were saved for this circuit.
```

Original line 1159:

```text
The catalogue can't always restore. This bike's indicators run 2000 mA but the catalogue
MAX (500) equals their off value, so writing it would leave them off — say so rather than
claim a restore that didn't happen. The rider sets the real value with the parameter form.
```

Original line 1172:

```text
Capture the live healthy MAX before pulling it down, so a later restore has this bike's
own value. Guard on `> off` so an already-disabled circuit is never saved as "healthy".
```

Original line 1180:

```text
── One batch POST for the survivors — one session, one unlock ──────────
```

Original line 1183:

```text
Repeated `w=NAME:VALUE:EXPECTED`, one per survivor. URLSearchParams.append keeps them all,
and the server pairs each name with its own value and compare-and-swap `expected`.
```

Original line 1191:

```text
The request did not come back. Every write in the batch is unconfirmed — the frames may
have gone out — so none is claimed done. send() set the "read it back" message already.
```

Original line 1198:

```text
400/409: the whole batch was refused before the bus (a bad value, a busy bus, a gate
that has closed). Nothing was written; `payload.message` carries the server's reason.
```

Original line 1204:

```text
One row per parameter the server was given, in order — so every survivor has exactly
one row here, matched back by name (never by position, which a reorder could shift).
```

Original line 1229:

```text
One line for the outcome of a whole run. A partial run has to name which circuits are in
which state, because the bike is now in a mixed state and the rider needs to know it.

@param {boolean} off @param {string[]} done @param {string[]} skipped
@param {string[]} failed @param {string[]} fellBack @param {boolean} unreachable
```

Original line 1268:

```text
This bike's saved healthy light MAX values (param name → mA), read from localStorage — what a
restore prefers over the factory catalogue. Per-device and losable (a different phone, cleared
storage): a miss just falls back to the catalogue. Never throws — corrupt or absent storage
yields an empty map so a restore can still run, and only finite numbers survive the parse.

@returns {Record<string, number>}
```

Original line 1300:

```text
Save one circuit's healthy MAX (mA) under its parameter name, merged into whatever is already
stored, so a later restore can reuse this bike's own value. Best-effort — a storage failure is
logged and swallowed, because losing the save only costs us the catalogue fallback on restore.

@param {string} param @param {number} value
```

Original line 1317:

```text
The four service actions — one read, three that cannot be undone. Only the read one
is on screen; the other three are behind a fold, in the red tier.

Each arms independently, and arming one disarms the others, so a thumb travelling
down the list cannot walk its way through two of them.

⚠️ That is NOT what stops a double-tap, and this comment used to say it was. Arming
one control says nothing about the same control being hit twice. What stops it is
the dwell between arming and firing — see ARM_DWELL_MS.
```

Original line 1331:

```text
Outside the fold, deliberately: it changes nothing, and it is the action you
want BEFORE the service point below — which stamps the bike's own clock and
odometer over whatever this one shows you.
```

Original line 1339:

```text
The read-stamp control's prose, and the node that shows what came back.

⚠️ Exported so scripts/check-service-stamp.ts can assert this control's shape as DATA
rather than by parsing the call that builds it — the same reason `IRREVERSIBLE` and
`confirmationFor` are exported. `caution` is deliberately absent: see StampOutcome.

@type {ConfirmableAction}
```

Original line 1359:

```text
What the bike answered, under the button that asked.

⚠️ This node is the whole point of the control. The sentence used to go only to
`message`, whose only home on a sheet with controls is Outcome(), three sections up an
`overflow-y: auto` sheet — so pressing the button changed nothing a thumb could see, and
the report was "it doesn't seem to change anything". See issue #154.

`.caution`, never bare `.action-note`: at 11.52 px in `--label` it would render
identically to the grey line above it, which is the argument style.css:748-759 makes
about the loudest sentence in a section being set as its quietest type.
```

Original line 1379:

```text
The four WORDs as they came off the bus. `.output` is the machine-output class —
this is A8 talking, not prose we wrote — and its overflow-wrap keeps a long line
from pushing a 390 px sheet sideways.
```

Original line 1389:

```text
The three actions with no undo, behind one fold.

⚠️ The fold is the safety part of this section, not the decoration. The sheet is a
long scroll on a handlebar-mounted phone, and styling alone still leaves `31 FC` and
Mode 04 as things a thumb can arrive at while reaching for something else.
Collapsed, there is nothing there to arrive at.

⚠️ Toggling DISARMS. Otherwise collapsing the fold over a half-confirmed action would
leave a primed button waiting off screen for its second tap; re-opening the sheet
already resets both (see refreshVcuWrite), and this closes the same hole for the fold.

Why this shape of disclosure, and what each line of it is for:
docs/dashboard-decisions.md §"The fold in front of the irreversible three".
```

Original line 1406:

```text
The wrapper carries the closing rule, so it is there whether the fold is open or
shut — it used to exist only while open, leaving "Recently written" hanging under
the red panel with no divider in the state the sheet spends most of its life in.
```

Original line 1413:

```text
The fold hides `31 FC` and Mode 04, so a screen reader has to be told it is
a disclosure and which way it is currently pointing. The caret cannot say
that; it is a glyph.
```

Original line 1420:

```text
⚠️ The only re-poll of /vcu-write while the sheet is open, and the Clear card's cable
caution is why it exists: the gate the browser holds is otherwise the one fetched when
the sheet was opened, so plugging the bike in after opening it produced no warning at
all. Opening this fold is the last deliberate act before an irreversible tap, which
makes it the right moment — and it is one request that touches nothing on the bike.
```

Original line 1430:

```text
⚠️ The SENTENCE does not change between states — only the caret turns, so the
eye does not have to re-find the one control standing between a thumb and
Mode 04 after every tap.
```

Original line 1435:

```text
The contents, under the caveat rather than instead of it — and only while SHUT,
since open the three buttons are spelled out directly underneath.
```

Original line 1446:

```text
One entry behind the fold: what it is called, what it asks the Pi for, and how to
build it.

@typedef {{ name: string, action: "set-service-point" | "sync-clock" | "clear-dtcs",
  render: () => Element }} IrreversibleAction
```

Original line 1454:

```text
The irreversible actions — ONE list, not a list and a parallel array beside it.

⚠️ Everything the page says about this drawer is read off here: how many there are,
and what they are called. The names used to be a parallel array checked FOR LENGTH
and reported by `console.warn`, on a page nobody ever has a console open on; what
cannot be made structural is asserted in scripts/check-irreversible-actions.ts.

`render` is a thunk, not a node — the safety half being that nothing behind the fold
is CONSTRUCTED while it is collapsed, so "there is nothing there to arrive at" stays
literally true of the DOM. See docs/dashboard-decisions.md §`IRREVERSIBLE` is ONE list.

@type {IrreversibleAction[]}
```

Original line 1498:

```text
Is a charger attached RIGHT NOW, as the gate sees it?

Two ways, because the gate reports two different facts: `chargingEvidence` is a witnessed
charge session, and the veto row reaching `ok` means the charge manager is on the bus,
fresh, and reporting a cable in the inlet (src/vcu/service-gate.ts `inletCheck` — `ok` is
unreachable when the sample is stale, absent, or says the inlet is empty).

⚠️ Read off the served gate rather than by re-testing the bit here. The inlet mask lives in
src/vcu/charge-session.ts and is not exported; a copy of it in a browser file would be a
constant that can drift from the one the Pi actually vetoes on.

@param {ServiceGateVerdict | undefined} gate
```

Original line 1519:

```text
The key is `CHARGE_INLET_VETO.key` on the Pi (src/vcu/charge-session.ts). Spelled out here
because public/ has no build step and cannot import a `.ts` at runtime; the Pi's own copy is
`verdictSeesACable`, and scripts/check-clear-dtcs.ts §8 drives both through the same cases.
```

Original line 1525:

```text
The argument against pressing Clear, which grows a paragraph when a cable is in.

⚠️ The added paragraph states two logged cases and refuses to generalise from them, because
two is what there is. It also says what cannot be known: the ride log is log-on-change while
the gate's freshness budget is 5 s, so the log cannot say what THIS gate would have read on
those days — the cable bit is recorded, the gate's own verdict is not. docs/clear-dtcs.md.
```

Original line 1549:

```text
What the bike answered — the Pi's own sentence, styled by the Pi's own verdict.

⚠️ THE WORDS ARE THE SERVER'S. This used to rebuild the sweep and the proof line from
`result.clear`, which put that prose in three places (here, src/vcu/clear-dtcs.ts and the
preview template) with only the VERDICT cross-checked — so the two sentences could drift while
every check stayed green, and a refused clear rendered an empty div because it carries no
counts. StampOutcome states the rule this now follows: take the message, do not recompute it.

⚠️ Reads `clearOutcome`, not `state.val.result`. A second press that never comes back leaves
the previous answer in `state` — `send()`'s catch deliberately does not touch it — so reading
the result directly left a green "erased" proof under a button whose request had vanished.
```

Original line 1569:

```text
⚠️ `.action-note.failure`, which is WEIGHT as well as hue — --bad and --warn are the
closest adjacent pair in the ramp, so in light theme a red line between two amber
cautions read as a third near-identical paragraph. NoUndoLine spells the argument out.
No badge: the Pi's own sentence already opens "AND THE BIKE ERASED NOTHING" in caps, and
a badge above it said the same words twice in a row.
```

Original line 1582:

```text
⚠️ Starts with the same shouted token as the other two, on purpose: the red line is
one slot in three cards, and a slot that holds a token on two of them and a sentence
on the third is not a slot. What comes AFTER the dash is where this one differs.
```

Original line 1589:

```text
The clock sync, which needs its own button because its confirmation is a question
about a fact rather than about an intention: the caption IS the dialog — "Is it
<date and time>?" — and the time in it is echoed back to the Pi, which refuses if
that minute has passed. So the second tap asserts that the time shown in the first
is still true. See docs/dashboard-decisions.md §"The confirm token".
```

Original line 1599:

```text
Above the button, for the reason ActionButton sets out: on a phone the thumb
arrives before the eye does. Shown only when the button can actually do
something, and through NoUndoLine rather than hand-rolled, so this card is not
the only one whose red line lacks the IRREVERSIBLE badge.
```

Original line 1610:

```text
One held Enter must not arm and then fire. See refuseKeyRepeat.
```

Original line 1614:

```text
⚠️ The FIRST tap refreshes before it arms, so the time the caption then
shows is the Pi's time now rather than the Pi's time when the sheet was
opened. Without this the owner could be asked "Is it 09:15 UTC?" at
10:20 and truthfully answer no useful question at all.
```

Original line 1621:

```text
The same dwell as every other second tap. This control happened to survive
a double-tap already, because armClockSync() awaits a refresh that disables
the button in between — but that was the refresh's side effect, not a
guard, and it would go the moment the refresh did. See ARM_DWELL_MS.
```

Original line 1629:

```text
⚠️ The minute CONFIRMED is derived from the one that was DISPLAYED, never
from the phone's own clock. They are two different clocks: sending
`new Date()` would mean the Pi checked the phone's freshness while the
owner had agreed to a statement about the Pi — so a stale caption would
sail through, and a phone a minute out of step could never sync at all.
```

Original line 1658:

```text
Every reason, not the first. "No satellite time AND the clock reads 2060"
is a different situation from either alone, and the second one is how you
find out the GPS decode is broken rather than the sky being blocked.

Red, but NOT the `no-undo` class: the button is disabled, so there is
nothing here that cannot be undone. This is red because something is
broken, and `no-undo` means one specific thing that this is not.
```

Original line 1670:

```text
No `noUndo` here — it is rendered above the button, where the thumb passes it.
```

Original line 1680:

```text
The three kinds of sentence a control carries, which are read at three different
moments and are therefore ranked rather than run together.

They were one undifferentiated amber block, and it flattened the distance between
"it will probably do nothing" and "IRREVERSIBLE. There is no unset." — the same
colour, the same size, the same paragraph.

`caution` may be a THUNK rather than a string, for the one control whose argument
against pressing it depends on the live gate: clearing the codes with a cable in the
inlet. A string is still the normal case and still what the other controls pass.

@typedef {{ noUndo?: string, does: string, caution?: string | (() => string) }} ActionNotes
```

Original line 1695:

```text
The prose plus the tail of the caption the SECOND tap agrees to.

`confirm` is not prose — it is on the control, not under it — but it is declared
alongside so the two cannot drift apart. Separate from `ActionNotes` because the
clock action writes its own confirmation (it asks a question about the time rather
than about an intention) while still rendering the same three ranked sentences.

`outcome` is the node that shows what the bike ANSWERED, and it rides in here rather than
beside the prose for the reason `irreversible` is derived rather than passed: what a
control is and what it renders cannot then disagree. It is a thunk, so nothing is built
for a control that has no answer to show.

@typedef {ActionNotes & { confirm: string, outcome?: () => Element }} ConfirmableAction
```

Original line 1711:

```text
@param {"read-service-stamp" | "set-service-point" | "clear-dtcs" | "reset-vcu"} action
@param {() => string} caption
@param {ConfirmableAction} notes
```

Original line 1718:

```text
Derived from the prose rather than passed alongside it, so the tier a button is
painted and the sentence it carries cannot disagree: a red button with no line
saying what it cannot take back is now unexpressible.
```

Original line 1723:

```text
`action-block` is one control and the prose that belongs to it. It exists so the
gap BETWEEN two actions can be bigger than the gap between an action and its own
notes — otherwise "read the stamp above first" sits as close to the next button
as to the one it is about, which on this list is a sentence attached to the
wrong irreversible action.
```

Original line 1729:

```text
⚠️ ABOVE the button, not under it. On a phone, reading order IS tap order: with
the consequence underneath, the thumb reaches a 55 px target before the eye
reaches the sentence saying the target cannot be undone. The one line that could
stop somebody has to be crossed on the way to the control, not found after it.
Everything that is not a consequence — what it does, what to check first — stays
below, where it is read once you have decided to look properly.
```

Original line 1747:

```text
One held Enter must not arm and then fire. See refuseKeyRepeat.
```

Original line 1754:

```text
⚠️ This is the line that stops a double-tap running `31 FC`, and it is the
only thing between these two taps — everything else on this control is
synchronous. Before it existed, two clicks 0 ms apart POSTed
`action=set-service-point&confirm=set-service-point` for real. Ignored, not
disarmed: the caption still says "Tap again" and still means it.
```

Original line 1766:

```text
⚠️ The confirmation NAMES WHAT IS PRIMED, and that is not decoration. It used
to be one shared sentence — "Tap again — this cannot be undone" — on all
three, so an armed button said only that something irreversible was armed,
never which. The parameter write has named its target in this exact spot
since #81 for the same reason (see describeChange): the caption is the one
place a person commits, and a thumb that landed on the wrong control is
exactly the case it exists to catch.
⚠️ Three captions, not two. A clear now parks the OBD poller and reads the bike back on
both sides of the frame, so its POST takes up to ~11 s where it used to take 0.6 — and a
55 px control that looks identical for eleven seconds in a garage gets pressed again.
`disabled` already refuses the second press; this is what says why. Deliberately generic:
all four ActionButtons share it and two of them read nothing back.
```

Original line 1796:

```text
⚠️ ABOVE the prose. The prose is static and says what the button is FOR; this is what
it just did. docs/dashboard-decisions.md §"Where an ANSWER goes".
```

Original line 1803:

```text
The one line that has to be read before the button underneath it is pressed.

⚠️ Bigger and heavier than the other two kinds of note, not just redder. Red is the
dimmest ink this palette has — #f87171 measures 6.5:1 on the sheet where a heading
measures 14.5:1 — so a page that carries severity in hue alone puts its most
consequential sentence at the BOTTOM of its own contrast ranking, under every
throwaway grey line on the screen. Weight and size are the channels that survive
that, and they are also the two that survive daylight through a visor.

No glyph: at this size 🚨 renders as an anonymous red smudge, and the line is
already red and already begins with the word IRREVERSIBLE.

@param {ActionNotes} notes
```

Original line 1822:

```text
⚠️ The category is a BADGE and the consequence is the sentence, rather than both
being one shouted string. "IRREVERSIBLE" appeared five times in a screen and a
half — section deck, fold label, and once per card — at which point it stops being
read at all, while the only new information on each card is what came after the
dash. The badge is identical on all three because the category is; what differs
gets the weight.
```

Original line 1831:

```text
What it does, and why you might not want to — the two that belong AFTER the control.

Neither is a consequence. `does` is how you confirm you are on the right button and
`caution` is the argument against pressing it, and both are read at leisure by
somebody who has already decided to look properly. The consequence went above the
button; see NoUndoLine.

@param {ActionNotes} notes
```

Original line 1845:

```text
A thunk, so a caution that reads the gate re-renders when the gate moves. VanJS
binds on the function, not on the string it returned when this node was built.
```

Original line 1850:

```text
argument against pressing, not a continuation of the first, and run together as one
block it read as "…come straight back. ⚠️ The charge manager reports…" — two warnings
sharing a sentence, which is how the more urgent one gets skipped.
```

Original line 1859:

```text
One `<div>` per paragraph, so a multi-part caution reads as multiple warnings.

@param {string} text
```

Original line 1868:

```text
The last few journal lines. The record of what has been done to this motorcycle.

⚠️ The lines are a SIBLING of the heading, not children of it. They were children,
which put every one of them inside a `.sheet-title` — so the record of what has been
done to the bike rendered as tiny grey SMALL CAPS WITH WIDE TRACKING, because
`text-transform`, `letter-spacing` and `color` all inherit. The `.action-note` on
them only ever overrode the font size.
```

Original line 1898:

```text
The clock caveat rides on every line rather than being explained once at the
top: these lines get read one at a time, months apart, and a timestamp this Pi
could not vouch for should say so where it is read.
```

Original line 1906:

```text
⚠️ The NAME MUST MATCH. The detail is one object the Pi hands over for the target the page
asked about, and it arrives a round trip after the selection moves — so without this the form
would render the previous parameter's purpose, warnings and range against the new name, and
`control.kind` and `onBike()` are what choose `action=bit` over `action=parameter` and what
becomes the compare-and-swap `expected=`. A detail that does not match is no detail.
```

Original line 1920:

```text
`canReach` plus the table-type gate. Used by the write button ONLY.

⚠️ Kept separate from `canReach` rather than folded into it, and the separation is
the whole design. `canReach` still governs the read button and the four service
actions, so an unconfirmed table blocks writing by index and leaves everything else
exactly as it was — including the read that clears it. Folding this in would produce
a page that refuses to let you fix the thing it is refusing over.

The server enforces the same precondition twice more regardless (the runner refuses
the request, and src/vcu/write-codec.ts refuses to encode the frame). This is the
page declining to offer a button whose request would be refused, which is the same
relationship it has to the allowlist and the compare-and-swap.
```

Original line 1938:

```text
What the bike holds for the selected parameter, and where that number came from.

⚠️ TWO sources, RANKED: a value this page read itself off the bus always wins over
the last recorded sweep's, because after a write the sweep's snapshot still says what
the parameter used to be. Null when neither has it — a real state, a Pi that has
never swept, and the write button stays disabled saying so.

The reading is only handed back when it belongs to the selected parameter, so no
ordering of events can show one parameter's value against another's name.
See docs/dashboard-decisions.md §"Where the number on the left comes from".
@returns {OnBike | null}
```

Original line 1974:

```text
Everything the form holds about the parameter that was selected. Called when the
selection changes, and on every sheet open.

The arming goes with it, always: a value typed for one parameter must not stay armed
against another.
```

Original line 1987:

```text
Collapsed again for the newly selected parameter. Its warnings are not the ones
that were just read, and an unfolded block would look like they are.
```

Original line 1992:

```text
What the second tap sends as `confirm=` — the Pi's precondition for every action it
will not perform on one request.

⚠️ PROTOCOL, not prose. `notes.confirm` is the caption tail and may be rewritten
freely; this is the string src/http/vcu-write.ts compares against, and getting it
wrong does not read wrong — it makes `31 FC` and Mode 04 refuse on every press with
a 400 nobody expected. One function rather than the rule at each call site, so that
scripts/check-irreversible-actions.ts asserts it against the server's own parser and
not against a second copy. See docs/dashboard-decisions.md §"The confirm token".

@param {string} action
@param {string} displayedIso the Pi's `clock.iso` exactly as the caption showed it
```

Original line 2008:

```text
The minute the button is currently SHOWING, in the shape the server checks:
`2026-08-16T14:03Z`. Sliced out of the Pi's own `clock.iso`, so the value
confirmed and the value displayed are the same string from the same clock. If the
sheet has gone stale the server refuses and names both minutes — the intended
behaviour, and the refusal itself refreshes the state so the next attempt shows
the right time.
```

Original line 2016:

```text
Everything else confirms by naming itself. The server wants `confirm=clear-dtcs`
for `action=clear-dtcs`: the point is that a request cannot be built by guessing
the action name alone, not that the token is unguessable.
```

Original line 2022:

```text
The clock's confirmation, from the reading currently on screen. See confirmationFor.
```

Original line 2027:

```text
Refreshes the Pi's clock reading, then arms — so the time in the caption is its time now.
```

Original line 2035:

```text
Only arms if the refreshed verdict still allows it. A clock that has drifted out
of GPS agreement since the sheet opened must not leave a primed button behind.
```

Original line 2056:

```text
Typed off the server's own source, like every other fetch in this dashboard —
an untyped `json()` here would let a renamed field through silently, and the
field in question is the one a write is compared against.
```

Original line 2062:

```text
No fallback to `unsigned`, deliberately. A write is compared against the
TYPED value, and using a differently-typed number as the precondition is how
a signed parameter gets written from an unsigned reading of itself.

⚠️ And the failed read does NOT clear a value the sweep already had. It failed;
that says nothing about what the parameter holds, and dropping a good older
reading on the strength of a timeout would be inventing information. The
message below says the read failed, and the caption under the value goes on
saying where it came from.
```

Original line 2075:

```text
A fresh reading disarms whatever was armed: the number the first tap agreed to
may not be the number on screen any more.
```

Original line 2086:

```text
Refreshes, THEN arms — so the number the second tap agrees to is the Pi's answer now.
Nothing polls /vcu-write while the sheet is open, deliberately, and the age of the
reading is the entire basis on which an old one is an acceptable precondition.

⚠️ And if the value MOVED across that refresh, this does not arm: a second tap must
agree to what is on screen rather than to what was. (fetchStatus() disarms on its own
for the same reason; this is what re-arms, and only when nothing moved.)
See docs/dashboard-decisions.md §"Where the number on the left comes from".
```

Original line 2107:

```text
⚠️ `refreshed` first, and it is not belt-and-braces. A superseded reply applies NOTHING, so
without it `after === before` holds because nothing happened, and this arms on the state the
tap started with — the one case the comparison cannot tell from "the Pi says what it said".
Opening the red fold or changing the picker during the round trip is enough to cause it.
```

Original line 2116:

```text
A refresh that was superseded rather than failed leaves no message of its own, and a tap that
silently does nothing reads as a broken button on a sheet where the next tap writes.
```

Original line 2128:

```text
`expected` is the number that was ON SCREEN, whichever source it came from. The Pi
re-reads the parameter and refuses if the bike disagrees with it, so this is a
claim being checked rather than a claim being trusted.
```

Original line 2151:

```text
⚠️ THE ANSWER IS TAKEN FROM THIS REQUEST'S OWN RESPONSE, never from `state.val`.
`send()` leaves the state alone when the request does not come back, so reading the
verdict out of the state would attribute the LAST write's result — including its
"written", its read-back and the verification hint — to an attempt that may have
reached the bike and may have done anything at all.
```

Original line 2157:

```text
The worst case, and it stays the worst case: nothing is claimed about the
parameter, and the reading goes, because the frame may well have gone out. The
message send() set says so at length. The next write has to read first.
```

Original line 2165:

```text
400 or 409: refused BEFORE the bus — a malformed query, a busy bus, a closed
gate. Nothing was read and nothing was written, so the reading on screen is
exactly as true as it was a second ago and is kept, along with what was typed:
the answer to "the sweep is using the bus" is to wait and press it again, not to
start over. `message` carries the server's reason.
```

Original line 2174:

```text
What the bike holds NOW, from the read-back the write itself did — so the value on
screen is the one that is true afterwards rather than the one the sweep recorded
before. Cleared when the attempt reached the bus and produced no reading (refused
at the session or security step, or a failure partway): the write may have landed,
so the page falls back to the sweep's older value, correctly labelled as old, and
the Pi re-reads before any second attempt exactly as it did before this one.
```

Original line 2186:

```text
The allowlist entry for BEAM_MAX_CURR_TH on this bike's table, or null when it has none.
```

Original line 2191:

```text
Reads one parameter off the bike through the read path's probe — the same endpoint,
header and typing readCurrent() uses. Returns the TYPED value (never the unsigned
reading), which is the number a write is compared against.

@param {WriteTargetListing} target the name/micro/index a probe read addresses by — a listing
  entry or a detail, since a detail carries all three.
@returns {Promise<ReadResult>}
```

Original line 2219:

```text
BEAM_MAX_CURR_TH off the bike, or why not — the headlight buttons' read. See readTargetValue.
@returns {Promise<ReadResult>}
```

Original line 2231:

```text
The first tap: read BEAM_MAX_CURR_TH off the bike, then arm — so the second tap's
compare-and-swap is against a value read seconds ago, not the sweep's older one. Only
arms if the read succeeded and writing is still allowed.

@param {string} key
```

Original line 2256:

```text
The second tap: write the fixed value with the first tap's reading as `expected=`,
through the very same POST the parameter form uses. The server re-reads, compares,
writes and reads back; `send()` sets the shared message and refreshes the journal.

@param {boolean} off
```

Original line 2285:

```text
@param {string} action
@param {string} confirmation
```

Original line 2295:

```text
In a `finally` because `send` resolves null rather than throwing, but a bug that made
it throw would otherwise leave every button on the sheet captioned "Working" for good.
```

Original line 2300:

```text
Taken from `message` rather than recomputed: send() composes the transport-failure
sentence itself, and a refusal arrives as `payload.message` — so whatever send()
decided is exactly what this control has to show, for every ending.
```

Original line 2305:

```text
⚠️ Cleared ONLY while this node is still on screen. `send()` has just replaced the
state, and an answer that says writing is off unmounts the whole controls branch —
StampOutcome with it — on the same update. Clearing unconditionally therefore
emptied the failure line at VcuWrite's `!hasControls()` branch, which is the ONE
thing that must render when there are no controls, and the section collapsed to a
heading and an ellipsis. The condition is "is the node that renders this still
there", which is what hasControls() answers.
```

Original line 2318:

```text
Null on a transport failure too: `send()` leaves `state` alone there, and the previous
press's proof must not stand under a request that never came back.
```

Original line 2322:

```text
⚠️ Cleared for the same reason read-service-stamp clears it: the sentence is now rendered
AT the button, and leaving it in `message` too showed the same verdict twice, three
sections apart. Only when the card is actually showing it — a refusal has no `clear`, and
for that ending `message` is the only home the answer has.
```

Original line 2332:

```text
⚠️ `31 FC` overwrote the block the read reports, and it is two taps away in the same
fold. What was on screen is now false. Cleared rather than refilled with the routine's
own `after`: that stamp is absent whenever the routine could not read it back, and its
sentence is already being rendered by Outcome(). docs/dashboard-decisions.md.
```

Original line 2340:

```text
What a request that never came back means for a READ.

⚠️ Not send()'s sentence, which says "this does NOT mean nothing was written — the
request may have reached the bike. Read the value back before trying again". That is
true of every write on this page and false of this one: the read changes nothing, so
there is nothing to read back and nothing to worry about having landed.
```

Original line 2355:

```text
POSTs one action and hands back what came of it.

⚠️ Returns the payload, or **null when the request did not come back at all** — and
the difference is the whole reason it returns anything. A caller that instead read
the verdict out of `state.val` would find the PREVIOUS action's result sitting there,
because the transport-failure branch below deliberately leaves the state alone, and
would report that action's success as this one's.

@param {URLSearchParams} query
@returns {Promise<VcuWriteResponse | null>}
```

Original line 2370:

```text
⚠️ In the same queue as the GETs. A POST answers the same payload, and the picker can move
while one is in flight — widest window on the five-circuit batch — so without this its reply
lands a detail for the parameter the form has left, with nothing on its way to replace it.
```

Original line 2375:

```text
The reply carries a fresh status, so it must carry the same slice of it the page is holding:
without this a POST would answer `detail: null` and collapse the form it just wrote through.
```

Original line 2385:

```text
A DIFFERENT value from the read endpoints' `service-mode`, so a caller built
for those cannot reach this one. See src/http/vcu-write.ts.
```

Original line 2389:

```text
The body carries the status and the journal on every code this endpoint
returns, including 400 and 409, so it is read before the status is judged.
```

Original line 2401:

```text
⚠️ Returned whether or not it was applied: the caller reads its OWN request's verdict from
here and never from `state`, which is the whole reason this returns anything.
```

Original line 2405:

```text
⚠️ The worst case on this page, and it is said as such. A write request that
did not come back may still have reached the bike — the frame goes out before
the response comes back — so "it failed" would be a claim nothing supports.
```

Original line 2423:

```text
Called by ./service-mode.js whenever the sheet opens. Refreshes, disarms and re-folds everything.
```

Original line 2426:

```text
Not in forgetSelection(): that also runs when the PARAMETER changes, and neither the
irreversible actions nor the headlight buttons have anything to do with which
parameter is selected. This is the sheet-opening reset, and re-folding — and dropping
any beam reading a half-finished headlight gesture left behind — belongs to it alone.
```

Original line 2433:

```text
An answer read through a previous sheet-opening must not be read as this one's.
```

Original line 2437:

```text
The one fetch that asks for the 269 names. Everything else passes `list=0`.
```

Original line 2441:

```text
Moves the form to another parameter — the selection, everything the old one held, and the round
trip for the new one's notes.

⚠️ A different parameter means a different value, a different range and a different set of
warnings, so everything the form holds about the old one goes. Until the detail lands
`selectedTarget()` is null, so the form says it is reading and Read and Write stay disabled;
nothing renders the old parameter's warnings under the new parameter's name.

The `<select>`'s handler is this and nothing else, so a check driving it drives the real path.
@param {string} name
```

Original line 2459:

```text
The dropdown's entries, exported ONLY so scripts/check-write-status-split.ts can assert that a
`list=0` refresh does not empty it. Nothing in public/ reads it; §4 of that check asserts so.
```

Original line 2467:

```text
Just the state — no disarming, no forgetting the reading.

Kept apart from `refreshVcuWrite` because arming the clock sync needs a fresh
`clock.iso` and must not wipe a parameter reading somebody took thirty seconds ago;
`refreshVcuWrite` is the sheet-opening reset and deliberately does both.
```

Original line 2476:

```text
⚠️ MEASURED, not defensive — and it was deleted once on the strength of a check too weak to
reach it. `adoptListing` cannot say yes twice running, but it does not have to: it ALTERNATES
with the re-ask below, which asks WITH the listing and so hands `listingHeldFor` back. A Pi
answering a different tableType and a different listing every time then loops for ever; that
takes a sweep landing between back-to-back requests, so it is not reachable from a settled
bike — which is exactly why it must be loud rather than silent when it happens.
```

Original line 2490:

```text
The listing is fetched when the sheet opens and never again — 14 397 of the 22 490 bytes
this asks for, against a page that already has it. See the `listing` state.
```

Original line 2501:

```text
A newer read was issued while this one was in flight, so its answer is at least as fresh —
and this one's `detail` may belong to a parameter the form has already left. Dropped rather
than applied: `selectedTarget()` refuses a mismatched detail, so applying it would leave
the form stuck reading its notes forever with nothing on its way. charge-auto.js does the
same for the same reason. ⚠️ The caller is TOLD: a superseded reply applies nothing, so
armWrite()'s before/after comparison would find the state unchanged because nothing
happened, and arm on the value the tap started with. See armWrite().
```

Original line 2510:

```text
⚠️ Disarmed BEFORE the new status lands, always. A refresh can bring a different
value for the selected parameter — a sweep that finished while the sheet was open
rewrites `onBike` under it — and a button armed against 75 must not fire against
80 because a second tap happened to come after the refresh. The clock sync arms
itself again immediately afterwards, deliberately and from the refreshed reading;
see armClockSync().
```

Original line 2525:

```text
The selection MOVED while this request was in flight — either it was empty and the listing
has just named one, or a new listing did not contain the old name and `adoptListing` moved
it. Either way this reply describes a different parameter, so ask again for the one the
form is on. It cannot recur: a re-entry only fires when the selection moves during ITS own
request, and nothing below moves it.
```

Original line 2534:

```text
Loud. A section that silently renders nothing looks like a bike with nothing
writable, which is a different claim from "the Pi did not answer".
```

Original line 2542:

```text
Takes what a reply says about the allowlist. True when the listing must be fetched again.

⚠️ Shared by `fetchStatus()` and `send()`, because a POST answers the same payload and a sweep
can finish across one: a reply the page adopted without this check would leave the picker
offering names the Pi has stopped accepting.

⚠️ A NEW listing re-points the selection when the old name is not in it. Without that the form
asks for a detail that no longer exists, gets null for ever, and sits on "Reading this
parameter's notes…" with no way back — reopening the sheet does not clear it, because
`forgetSelection()` deliberately keeps `selected`.

@param {VcuWriteResponse} payload
```

Original line 2568:

```text
A sweep finished under the open sheet and named a different table, so the names the
picker is showing are no longer the names the Pi would accept. Ask again, with the list.
```

## public/views/all.js

Original line 8:

```text
A 30 ms press is one frame of a 60 Hz display, so a signal whose edges are the event
cannot be watched as a raw 1/0. getsLatchedTile() picks the tile below, per KEY rather
than per group. The sections themselves — that they exist, where they sort, what they
count — still fall out of the registry's `group` field, as every other group here does.
```

Original line 20:

```text
Snapshot, raw groups and lifetime/filter constraints: docs/fault-report.md.
```

Original line 25:

```text
Fetched here rather than at module scope: it is one request, and it should happen
when somebody looks at this tab rather than on every page load.
```

Original line 35:

```text
Named for the same DevTools issue as the two write controls; there is nothing to
autofill a signal filter from, and a remembered list over it would only be in the way.
```

Original line 62:

```text
groupOf(), not signalState(key).val: reading the state here would
subscribe this one binding to all ~230 signals, so any patch — pack_a
arrives at frame rate with no deadband — would tear down and rebuild
the entire grid, losing any text selection with it.
```

Original line 90:

```text
Stored statistics are separate from live signals; rationale: docs/fault-report.md.
```

Original line 101:

```text
Not an error: most Pis have never taken one. Says how — and since #177 that is a
button on this same phone, so the in-app path leads and the shell command is a
footnote for a Pi whose service is stopped. It read the other way round from
#177 until #187.
```

Original line 132:

```text
One lifetime number, in the same tile the grid uses.

The note is the load-bearing half for two of these rows — `charge moved` carries a
raw count and the reason it is not an amount of charge — so it is rendered at the
same weight as a rejected reading rather than tucked away.

@param {import("../../src/diagnostics/lifetime-stats.ts").LifetimeRow} row
```

Original line 151:

```text
One signal, rendered generically. Values are shown with whatever precision they
need rather than a fixed number of decimals — coordinates are useless at two, and
a pack current of 123.456 A is noise at three.
@param {string} key
```

Original line 173:

```text
Only worth showing once a good value exists too — otherwise the line above
already says the only thing known about this signal.
```

Original line 182:

```text
What the VCU's state machine is doing, in words, under the two 0x101 tiles that have a
vocabulary. `null` for every other key, so the ~230 other tiles gain no binding at all.

Both halves or nothing: the phrase belongs to the PAIR, so a tile whose partner has not
arrived prints no line rather than a verdict about a number the bike never sent. Reading
both signals through `.val` is a real subscription and is meant to be — they are 100 Hz
frames, but signals.ts logs on change and the whole archive holds 214 state rows and 803
substate rows, so these bindings repaint a handful of times a ride.

A pair in neither table takes `.raw-fault` rather than `.raw-sub`: catching a state nobody
has captured is the reason the state machine is logged raw, and a second grey line is not
how you notice one. docs/can-0x101.md §"The vocabulary the dashboard renders".
@param {string} key
```

Original line 209:

```text
Named fields and the per-key choice both belong to lib/state-labels.js — see labelFor().
```

Original line 215:

```text
One control a person presses — the whole `buttons` group, plus the per-key exceptions in
../lib/latched.js. Same card as RawTile, but built to be watched rather than read.

Three readouts, in decreasing order of how much you should trust them: the press
COUNT, how long ago the last press was, and the lit state. ⚠️ Never trust the light
alone — a bit never seen high but whose count climbs is a working button whose flash
the browser dropped — and never trust a LIT tile alone either, which is the newer
trap: once the bit has been down longer than press.js's threshold the second line
reports the hold rather than the count, so a squeezed brake lever and a stuck bit look
identical until you read the duration under it.

See docs/dashboard-decisions.md §"The button tile's three readouts", and
../lib/flasher.js for why the two blinkers are a named exception.
@param {string} key
```

Original line 235:

```text
The blinkers are the lamp outputs of a 1.46 Hz flasher, so every word this tile
would otherwise use is wrong about them: nobody "presses" a turn signal for eight
seconds. Same tile, same classes, same layout — only the nouns change.
```

Original line 244:

```text
Three different nothings, and they must not look alike. A REJECTED reading
is shown as the fault it is: bounds.js gates this group to 0/1 precisely so
that a decoder returning the masked byte (`handlebar & 0x20` is 32, not 1)
cannot pass for a button at rest, and swallowing it here would undo that.
A plain "–" means the frame has never arrived at all — which on 0x400's four
bits is also what a missing RX filter looks like, and is worth telling apart
from a button nobody has pressed.
```

Original line 260:

```text
chartTick paces both counters below: nothing arrives to mark the passing of a
second — these signals log on change and a held brake sends nothing at all —
so without this the age would freeze at whatever it was when the last press
repainted the tile, and a hold would never tick past its first reading.
```

Original line 265:

```text
Read through the state, not just the sampled helper, so that the line also
repaints the instant the bit drops rather than up to 500 ms later.
```

Original line 277:

```text
"12 uses" for an indicator: one use is one signalled turn, however many times
the flasher blinked during it. press.js is what makes that a use and not 89.
```

Original line 299:

```text
@param {string} key
@param {number} value
```

Original line 308:

```text
Ten digits of decimal overflow the cell, and hex is what you would compare
against the E-LOCK's paired-key list anyway.
```

Original line 315:

```text
../lib/format.js, so the pinned lifetime block above this grid and the grid itself
cannot disagree about what "precise" means a centimetre apart.
```

## public/views/all-landing.js

Original line 1:

```text
@ts-check
The snapshot stays above the parked raw grid and its filter: docs/fault-report.md.
```

## public/lib/params-page.js

Original line 11:

```text
The VCU parameter table, searchable by name. Plain DOM, no VanJS: this is a
static list you read once in a garage, not a live gauge, so there is nothing to
bind to and a page that renders once is the whole job.

It is a page of its own rather than a sixth tab. Every tab in the dashboard is
something you look at while riding or charging; 277 calibration constants are a
question you ask standing next to the bike with a laptop, and putting them in the
tab bar would cost a thumb-sized target on a screen read through a visor at
speed. /params.html is one tap from the same wifi and costs the riding views
nothing.

The types above come from the server's own source. There is no build step, so
they are JSDoc-only — the browser never sees them, but `npm run typecheck` does,
which is what stops this page and src/http/vcu-params.ts drifting apart.
```

Original line 47:

```text
Loud rather than an empty table: an empty table looks like a bike with no
parameters, which is never the truth.
```

Original line 72:

```text
Which of Energica's parameter tables the names in the table below came from.

⚠️ This line is the only way to tell. A wrong table is invisible in every other way —
routing and record widths are identical across all 28 of them, so a bike on the wrong
one reads and writes perfectly and merely means something else by every name. Not
hypothetical: the table embedded here was one revision out for two months, silently
wrong about one name in 277, and on somebody else's bike the same silence would be
worth 25. See docs/dashboard-decisions.md §"Which parameter table the names came from".

The verdict is computed on the Pi (src/vcu/snapshot.ts, `reportTableType`) so there
is exactly one copy of "which table are we".

@param {TableTypeReport} report
```

Original line 89:

```text
Three states, three appearances. "A micro never answered" must not render
identically to "both agree" with only an emoji between them — that is the state
this bike is in today, and rendering it as normal is the whole failure this line
was added to stop.
`split` counts as alarming: two micros naming different tables means some of the
names on this page are one table's and some are the other's, which is worse than
either being wrong on its own.
```

Original line 99:

```text
Also into the console, because this is the one finding on this page worth
pasting into a bug report verbatim.
```

Original line 105:

```text
How old the reading is, and whether it is all of it.

The age comes from ./format.js's `ageInWords`, which is where the phone-clock
reasoning lives now — three pages were computing it inline off the same
`readAt`, with thresholds that had already drifted apart: this one said
"73 h ago" where the same snapshot on the service sheet said "3 days ago".

@param {VcuParameterSnapshot} snapshot
```

Original line 131:

```text
@param {VcuParameterRow} row
@param {string} query
```

Original line 145:

```text
A parameter that did not answer is marked as such and shows its reason instead
of a number, because a blank cell in a table of numbers reads as a zero.
```

Original line 165:

```text
`value` is null when the name table has no honest opinion — an identifier it
does not describe, or a width that contradicts it. The raw reading is still
real, so it is shown as what it is rather than as a typed number it is not.
```

Original line 171:

```text
⚠️ This column is ANOTHER BIKE'S — the variant file params.ecf came from, not
this motorcycle. The header says so and so does this function's name; nothing
here may ever present it as a reading. It earns its place because it is the
comparison that established the whole mapping, and because 21 of 233 values
genuinely differ.

@param {VcuParameterRow} row
```

Original line 189:

```text
@param {HTMLElement} parent
@param {string} text
@param {string} [className]
```

Original line 207:

```text
The page and this module ship together, so a missing element is a broken
deploy rather than a condition to handle.
```

## scripts/check-arming.ts

Original line 13:

```text
public/lib/arming.js — the two-tap arm/dwell in front of every control that writes to the
motorcycle, checked without a browser.

  node --experimental-strip-types scripts/check-arming.ts

⚠️ This module had no coverage at all until 2026-08-30, and it is the whole of what stands
between a double-tap and a write to a calibration EEPROM. The surfaces behind it —
views/vcu-write.js (a parameter write, `31 FC`, Mode 04 and the bike's own clock),
views/charge-current.js, views/charge-stop.js, views/service-mode.js, views/lifetime-read.js
and views/pi-actions.js — each spell the gate out again at their own `onclick`, so half of
what is asserted here is that all confirmed firing sites still spell it the same way (§7). A gate
one site forgot is exactly as absent as one that was deleted.

The dwell is time-based, so `arm()` and `armDwellElapsed()` take an optional reading and this
check hands one in: 399 ms and 400 ms are asserted rather than slept through, and nothing here
can be flaked by a loaded machine. scripts/virtual-clock.ts is deliberately NOT used — this
module arms no timers, it only compares two readings — and §9 runs the gate with nothing
injected, since the two `performance.now()` defaults are the lines that actually ship. ⚠️ That
reading is a BYPASS as much as a seam, so §7 asserts that no call site on the dashboard hands
one in: a back-dated stamp arms a control whose dwell has already elapsed.

Same shape as scripts/check-irreversible-actions.ts, and for the same reason: public/ is ES
modules with no build step, so a browser file imports straight into Node. What needs a DOM is
the confirmed `onclick` bodies, which is why §7 and §8 read them rather than running them.
```

Original line 49:

```text
A clock that has been running a while, the way a phone's has by the time a thumb arrives.
```

Original line 52:

```text
The key names a view's ARMED_KEY export holds, for resolving a site's `armed.val !== ARMED_KEY`.
```

Original line 61:

```text
⚠️ DISCOVERED, never listed. §7 reads the firing sites out of these files, and a list here
would be the one place a new arming surface could fail to appear: an eighth control in a NEW
view would simply not be looked at, and every count below would stay green without it.
```

Original line 70:

```text
--- 1. before anything has ever been armed ----------------------------------
```

Original line 81:

```text
--- 2. the first tap --------------------------------------------------------
```

Original line 92:

```text
--- 3. the dwell ------------------------------------------------------------

Pinned to LITERALS. An assertion phrased as `ARM_DWELL_MS - 1` passes for every value of
ARM_DWELL_MS including zero, which is one of the mutations this section exists to catch.
```

Original line 124:

```text
--- 4. a held Enter ---------------------------------------------------------

The one hole the dwell does not close, and it does not close it by arithmetic: macOS repeats a
held key at about 500 ms, on the far side of the 400 ms dwell.
```

Original line 147:

```text
--- 5. the key --------------------------------------------------------------

⚠️ `armed` is ONE key for the whole dashboard and the surfaces are NOT mutually exclusive:
set-current and stop are on the charge tab together for the whole of a live charge. That is
safe because every firing site tests its own key — which is only true while the keys differ.
```

Original line 155:

```text
⚠️ ONE ENTRY PER CONTROL, and read off the `!==` refusal alone rather than off every
comparison: each key is also spelled `===` in its caption, and de-duplicating the two spellings
would de-duplicate exactly what the count below is looking for. Two controls that came to share
a key have to survive as two entries here, or both sides of `new Set(ALL_KEYS).size ===
ALL_KEYS.length` shrink together and a real collision reports green.
```

Original line 169:

```text
One entry per CONTROL, so two controls that came to share a key collapse the count and go
red. The clock sync is deliberately not taken from IRREVERSIBLE even though it is in the
fold: it writes its own confirmation instead of going through ActionButton, so it is already
in `literalKeys` above, and taking it from both lists would be one control counted twice.
```

Original line 178:

```text
The read-only action, spelled out because nothing exports it — it is the one ActionButton
outside the fold, so IRREVERSIBLE does not name it.
```

Original line 182:

```text
⚠️ The service sheet's two and the menu's two, which §5 could not see until they were
added here — and the first pair is the one that most needs it: the lifetime read's button
sits directly under the sweep's on one screen, which is exactly the co-visibility this
section is about. ⚠️ Hand-maintained, unlike ARMING_CONSUMERS, and it cannot simply be
derived from that list: charge-current.js and charge-stop.js export `ARMED_KEY`, which
matches `\w+_KEY` too and would double-count into ALL_KEYS against its own uniqueness test.
Scraped the way vcu-write.js's are a few lines above, rather than imported: this
file is a check OVER the shipped modules, not a consumer of them.
```

Original line 197:

```text
⚠️ Whitespace-tolerant, not a literal substring. Prettier broke this call across lines
the day it grew a fourth argument (the outcome node, #154), and an exact match then
reported the control as DELETED — a red build about a button that was still there.
```

Original line 215:

```text
--- 6. what disarms, run for real -------------------------------------------

The refreshes are the disarm-on-change path that can be executed without a DOM, and they are
the load-bearing pair: every control that HAS a status refreshes BEFORE it arms, so a status
landing under an already-armed button has to take the arming with it. ⚠️ views/pi-actions.js's
two fetch no status OF THEIR OWN — nothing about `git pull` or `ip link` is asked first — so
none of these refreshes is theirs. What is tied to their own lifecycle is openSheet(), asserted
at the end of this section. (Other modules' refreshes still disarm them: one key, one
dashboard.) Armed AFTER the call and before its answer, which is the ordering that matters —
a button armed against 75 must not fire against the 80 the refresh brought with it.
```

Original line 228:

```text
⚠️ `tableGate` is here because fetchStatus() reads its tableType to decide whether the picker's
names are still the Pi's (#107). A stub missing it throws inside the very call this section is
timing an arm against, and the disarm assertion would pass by failing early.
```

Original line 254:

```text
⚠️ Read rather than run: openSheet() mounts a sheet and needs a DOM. It is the only disarm
views/pi-actions.js's two do not get through another module's internals — refreshServiceMode()
disarms first thing and openSheet() calls it, which is precisely why the explicit line is worth
asserting: that one moves and this one does not. ⚠️ It is also why views/sheet.js imports the
gate at all now the buttons live elsewhere: drop it and sourceOf() throws instead of going red.
```

Original line 264:

```text
--- 7. every firing site on the dashboard, read off its own source ----------

⚠️ THE GATE IS NOT IN ONE PLACE. arming.js holds the dwell; the RULE — test my key, then the
dwell, then clear, then act — is spelled out at each `onclick`, and those bodies need a DOM to
run. So they are read instead, the way check-irreversible-actions.ts reads the `switch` in
src/http/vcu-write.ts rather than trusting a sentence about it. An eighth firing site, or one
that drops a line of the rule, is what this section exists to make loud.
```

Original line 277:

```text
Named rather than counted, so an eighth site has to be ADDED here rather than absorbed by a
number — and so the red line says which one arrived. ActionButton is one call site serving
four keyed controls, which is why this is a list of firing sites and §5's is a list of keys.
```

Original line 282:

```text
The SOC read loads on entry; its single Set control retains confirmation.
```

Original line 285:

```text
Both arrived with the in-service lifetime read. `performSweep` is the OLDER control:
it had two taps of its own with no dwell and no key-repeat refusal, and §3's scan
used to be scoped away from this file for that reason. Importing arming.js for the
lifetime read brought the sweep with it, which is the migration this check forced.
```

Original line 291:

```text
The menu sheet's two Pi-maintenance actions (#130). They fired on a SINGLE tap until
then — `/update` pulls new code and restarts the service, `/can-restart` drops the bus
— while the read-only sweep above them already took two.
```

Original line 321:

```text
⚠️ ITS OWN key, pinned to the key rather than to the shape. `armed.val !== ` alone proves
only that SOME key is tested: point charge-stop at "charge-current" and the shape still
holds, while Stop fires on a SINGLE tap and its caption never says "Tap again". The two are
co-visible for the whole of a live charge and one file is a copy of the other, so that
mis-scoping is one wrong constant away — a likelier edit than dropping the test altogether.
```

Original line 346:

```text
⚠️ NO TWO SITES MAY REFUSE ON THE SAME KEY, which is a different question from §5's "no two
declared keys collide": §5 reads the CONSTANTS and passes while two controls both point at one
of them. `armed` is a single key, so two sites sharing it means arming either one fires the
other on the next tap — one tap on "CAN bus restart" and one on "Update" would pull and restart.

⚠️ The only sites allowed NOT to resolve are ActionButton's, which is one call site built around
a `key` parameter serving four keyed controls — "distinct per site" is not a question about it,
and §5's ALL_KEYS is where those four are held apart. Asserted as that exact set rather than as
a count: `key => !key.startsWith("<")` exempts anything keyOf() merely FAILED on, so spelling a
control's key `let` instead of `const` would drop it out of the comparison below and re-open the
hole this section exists for — one keyword, and the count floor only catches it while the margin
happens to be zero.
```

Original line 377:

```text
⚠️ THE SEAM IS A BYPASS AS WELL AS A TEST HOOK, and this is the only thing standing on it.
`arm(key, performance.now() - 10_000)` at any call site arms a control whose dwell has already
elapsed, so its very next tap fires — the dwell defeated outright, by one extra argument. Until
the optional reading existed that was impossible by construction; now it is impossible only by
convention, and a convention nothing asserts is a comment. This check is the only caller
allowed to hand one in, and this check is not among the files scanned.
```

Original line 406:

```text
⚠️ `arm()` is the ONLY way `armed` becomes a non-empty key, and that is what makes the dwell
unskippable: a key set by hand carries whatever stamp the last arming left behind, so its
control fires on the very next tap. Every assignment outside arming.js has to be the empty one.

⚠️ Scoped to the modules that import the SHARED gate — which is now all of them. It used to
exclude public/views/service-mode.js, which declared an `armed` of its own: a plain boolean
with no dwell and no key-repeat guard, in front of the parameter sweep. That second arming
surface was a recorded finding rather than this check's subject until the in-service lifetime
read needed a button on the same sheet; importing arming.js for it joined this file to
ARMING_CONSUMERS and made the sweep's own two taps this check's business.
docs/dashboard-decisions.md §"The other `armed`".
```

Original line 432:

```text
A new surface that imported `arm` alone would be a control with two taps and no dwell.
```

Original line 444:

```text
--- 8. what drops the arming when the form moves under it -------------------

Spelled out rather than derived, the way check-irreversible-actions.ts spells out the fold's
contents: each of these is a promise that a second tap sends what is on screen NOW.
```

Original line 479:

```text
⚠️ Two hops since #107 split the payload: the `<select>`'s handler is `selectTarget()` and
nothing else — extracted so the round trip that fetches the new parameter's notes has one home —
and that is where forgetSelection() is called. Both hops are asserted, because a handler that
stopped calling selectTarget and a selectTarget that stopped forgetting are the same bug: a
button armed against one parameter still armed against the next.
```

Original line 497:

```text
--- 9. the same gate with PRODUCTION's clock --------------------------------

⚠️ Everything above hands in a reading, which leaves the two `performance.now()` defaults as
the only lines in arming.js nothing runs — and they are the lines the phone runs. The refusal
below needs no margin at all (two readings microseconds apart, against 400 ms); the elapsed one
sleeps 60 ms past the dwell, and load can only push it the safe way.
```

Original line 523:

```text
The prose above them says "never Date.now()", so the ban has to be read off the CODE.
```

Original line 540:

```text
What a firing site asks on a tap: is the key that is armed MINE? A function rather than the
comparison inline, because the compiler narrows `armed.val` to whatever it was last compared
with and would then call the second question unanswerable — while at a tap it is the shared
state that gets read, and it can hold any control's key.
```

Original line 550:

```text
One gate consumer's source, which §5 onwards read more than once.
```

Original line 563:

```text
The `perform…` it calls, so a red line names the control rather than a byte offset.
```

Original line 565:

```text
The `onclick` body with its comments stripped, or "" when it could not be found.
```

Original line 567:

```text
The whole of the button's props object, comments stripped, wherever `onkeydown` sits in it.
```

Original line 569:

```text
Where the perform call sits inside `body`.
```

Original line 573:

```text
Every control in one gate consumer that ACTS on a second tap, found from the action rather
than from the gate: a site that skipped the gate entirely would be invisible to a search for
the gate. ⚠️ Found by the `void perform…()` naming convention, so what §7 guarantees is "no
ungated `void perform*()` in a module that imports arming.js" — not "no ungated control".

⚠️ Comments come out of both bodies before anything reads them, in BOTH directions: prose
beside a guard must not break an assertion, and prose describing a guard must not satisfy one.
Deleting a whole dwell test and leaving `// enforced by armDwellElapsed()` behind used to pass.
```

Original line 588:

```text
The whole props object, not the source ahead of `onclick:` — otherwise moving `onkeydown`
below the handler, which changes nothing, goes red claiming the guard was removed.
```

Original line 599:

```text
Re-found in the STRIPPED body: an offset taken from the raw source would sit past every
index the ordering assertion compares it with, and that assertion is an ordering.
```

Original line 606:

```text
The key one firing site refuses a tap on. Spelled once: §7 asks it per site and §7b asks it of
all firing sites, and a regex that lived in both places would be widened in one of them.
```

Original line 618:

```text
What key one `armed.val !== …` or `arm(…)` expression names, as a string that can be compared
with another. A quoted literal is its own contents and a module's `ARMED_KEY` is resolved
through its export; anything else — `key`, the parameter ActionButton is built around — stays
the identifier, so a site that armed one variable and refused on another still goes red.
```

Original line 638:

```text
⚠️ A module-local `const SOMETHING_KEY = "…"`, resolved out of the file that names it. Until
this existed every such key read back as its own identifier, which made the per-site "refuses
on what it arms" assertion trivially true and let TWO controls in ONE module point at the
SAME constant undetected — a mutation that survived on 2026-09-14 and would have fired an
Update off one tap on the CAN restart beside it. The distinctness test below is the other half.
```

Original line 650:

```text
The key a site's FIRST tap arms with — its first argument only, so a call that also injected a
clock still reports the key it arms and the assertion above it stays about keys. The injected
clock is its own red line. Followed one hop through the `void armSomething()` the branch calls,
because only ActionButton arms inline — the other four refresh the Pi's answer first and arm at
the end of that, which is where the key they commit to actually is.
```

Original line 671:

```text
What a firing site does with a tap the dwell refused, trimmed so it can be compared whole.
```

Original line 678:

```text
The body of the arrow function `marker` sits in, or "" if it is not there at all.
```

Original line 686:

```text
Every dashboard module that imports the shared gate, found by reading them rather than from a
list here — a list would be one more place a new arming surface could fail to appear.
```

Original line 700:

```text
readdir order is the filesystem's, so it is sorted before anything counts or prints it.
```

Original line 704:

```text
What one module takes from arming.js, by name. Empty for a module that does not import it.
```

Original line 717:

```text
One keydown put through the guard, reporting whether its default action was cancelled.
```

## scripts/check-irreversible-actions.ts

Original line 5:

```text
What is behind the menu sheet's red fold, checked without a browser.

  node --experimental-strip-types scripts/check-irreversible-actions.ts

Same shape as scripts/check-tab-routing.ts, and for the same reason: public/ is ES
modules with no build step, so a browser file whose exported constants are plain data
imports straight into Node. public/views/vcu-write.js does nothing at module scope but
declare van states and this list — the buttons are thunks, deliberately, so that the
fold constructs nothing while collapsed — which is what lets this file exist with no
jsdom and no headless browser.

⚠️ THE FOLD MAKES A PROMISE ABOUT WHAT IS INSIDE IT, to somebody standing at a bike.
Collapsed it shows a count and three short names, and that line is what a rider reads
to decide whether to open the drawer at all. Behind it are `31 FC` (which stamps a
service point on the bike's own clock and odometer, with no unset), OBD Mode 04 (which
takes the freeze frame with the codes) and a clock write that cannot be read back. A
drawer that names the wrong three, or says three and holds four, is worse than one that
names nothing.

⚠️ THE REAL INVARIANT SPANS TWO FILES THAT CANNOT SEE EACH OTHER: src/http/vcu-write.ts
decides which actions demand `confirm=`, public/views/vcu-write.js decides which ones a
thumb has to open a drawer to reach. A fourth confirm-gated action added to the Pi and
not put behind the fold is a destructive control sitting in the open list with the
read-only ones, and nothing else in the repo would notice. So §3 reads the actions off
the `case` labels of parseWriteRequest's own switch and asks the server of each whether
a complete request is still refused with no `confirm=`; §4 calls `confirmationFor`, the
single site the page builds `confirm=` from, rather than listing what it should produce
— a list here would be the parallel array the check exists to abolish.

The drift both halves used to be able to do: docs/diagnostics-and-checks.md §11.4.
```

Original line 47:

```text
--- 1. What the drawer says it holds ----------------------------------------

Written out, in the order the buttons appear. Spelled out rather than derived, for the
same reason check-tab-routing.ts spells out the tab URLs: this list is a promise made
to somebody who is deciding whether to open a drawer with `31 FC` in it, so changing
one has to be a decision rather than a diff nobody looked at twice.
```

Original line 78:

```text
--- 2. The sentence the collapsed row actually renders -----------------------

The count and the names are two claims made in one line of type, and both are read off
IRREVERSIBLE now — so this rebuilds that line the way the view does and compares the
whole string, rather than checking the pieces it was built from and calling it done.
```

Original line 92:

```text
--- 3. The fold and the Pi's confirmation gates agree ------------------------

The one assertion that spans the two files, and the reason this check is worth a
process: nothing derives the fold's membership from the server.

⚠️ THE VOCABULARY IS READ OFF THE `case` LABELS of parseWriteRequest's own switch, by
parsing the source — NOT off the English sentence in that switch's `default:` arm,
which is what the first version did and which INVERTED the check (green when you were
wrong, red when you were right; docs/diagnostics-and-checks.md §11.4). The `case`
labels cannot drift from the dispatch because they ARE the dispatch, and the sentence
is now checked against them (§3a) rather than trusted.

Reading a sibling module's source is preferred here over exporting a list from
src/http/vcu-write.ts: an exported list would be a second place the actions are
written down — the parallel array this whole check exists to abolish.
```

Original line 114:

```text
Every action parseWriteRequest dispatches on, read off its switch.

Scoped to the one `switch (action) {` block so a `case` belonging to some later
switch cannot wander in, and asserted non-empty below — a regex that silently matched
nothing would take the polarity with it and put us back where we started.
```

Original line 127:

```text
`[^"]+`, not `[a-z-]+`. A narrower class is the inversion coming back through a
smaller door: a label carrying a digit, capital or underscore would be invisible to
the parser, so a new confirm-gated action spelled `case "mode04-wipe":` would go
unseen and the check would pass while it sat in the open list. That is not a
hypothetical spelling in a file that says "OBD Mode 04" four times. Over-matching is
safe by construction — an action this finds but has no fixture for is already a hard
failure that names it.
```

Original line 144:

```text
The refusal for an unknown action is a sentence a person reads when something has
gone wrong, and it lists the vocabulary. Checked against the switch rather than used
as the source of it: an action added to the dispatch and left out of that sentence is
a message that lies at exactly the moment it is being read.
```

Original line 166:

```text
A request that is complete apart from `confirm=`, one per action.

Hand-written, because "complete" means something different for each action and there
is nothing to derive it from. An action the server dispatches and this map has never
heard of is a HARD FAILURE below rather than a silent omission — that is the polarity
that matters: a new action stops the build and names itself, instead of quietly not
being asked about.
```

Original line 184:

```text
Complete: one valid w=NAME:VALUE:EXPECTED triple (the batch is repeated `w=`). Like
parameter and bit it carries no confirm — it is many reversible parameter writes, not one
of the irreversible ones — so it parses OK here, never enters the gated set below, and
belongs out in the open rather than behind the fold.
```

Original line 193:

```text
Complete: it carries the amps. Missing only the confirm, so the server refuses it
FOR the confirmation — which is what §3c reads off it.
```

Original line 196:

```text
Complete on its own — stop takes no fields. Missing only the confirm, so it too is
refused FOR the confirmation.
```

Original line 199:

```text
Complete: it carries the percentage. Missing only the confirm, which for this action carries
the value the way charge-current's carries the amps.
```

Original line 202:

```text
Complete on its own and NEVER confirmed: bit 7 is clear, so it is a read. It parses straight
through, so it never enters the gated set below — the same shape as read-service-stamp.
```

Original line 205:

```text
Complete on its own — reset takes no fields either. Refused only for the confirmation.
```

Original line 222:

```text
Whatever is still refused with a complete request and no `confirm=` is refused FOR the
confirmation and nothing else. That is the definition of "destructive" this page paints
red, taken from the server rather than from a list here.

⚠️ Only actions with a fixture are compared below. An action with none has not been
ASKED, and a bare request for it would be refused for whichever parameter it is missing
— indistinguishable from a confirmation gate without reading the refusal's prose, which
is the mistake this section already made once. So an unfixtured action is reported by
the hard failure above, which names it and says what to do, and is not silently
assigned a verdict here that neither direction of the comparison could justify.
```

Original line 237:

```text
Widened to string on purpose. The other side of every comparison below is a name read
out of the server's source at run time, so keeping the union here would only let tsc
pre-agree with the thing this check exists to test.
```

Original line 242:

```text
⚠️ THE THIRD CATEGORY, added when charge-current arrived: confirm-gated but REVERSIBLE.

The fold's promise is "cannot be undone", and until then that was the same set as "needs a
confirm=". These four are gated because `curl` can reach the endpoint and a page showing 6 A must
not be able to POST 30 — the number is the owner's to say out loud — but none of them is
irreversible, and behind a fold that says otherwise every one of those rows would lie. Each undoes
itself differently: charge-current is TRANSIENT (unplugging clears it, the VCU clamps above the
cable's ceiling, the rider overrides on the bike); charge-stop is re-plugging or restarting the
charge; reset-vcu is a key-cycle restart that erases and reverts nothing. ⚠️ charge-soc-limit rests
on a different floor — the setting is STORED, so "the cable comes out and it forgets" is not
available; what is, and what no other action here has, is a real read-back
(docs/dash-command-0x2c-charge-limit.md).

This set is the ONE place that exemption is written down; adding to it weighs the same as adding
to the fold, and confirm-gated-but-absent-from-both is still the hard failure §3b catches.
```

Original line 276:

```text
The other direction of the same fact, and the one that keeps the read-only action
OUTSIDE the drawer where it belongs: it is the one you want BEFORE the service point
overwrites what it shows you, so hiding it behind the same fold would be a real cost.
```

Original line 284:

```text
--- 3c. The reversible-confirmed actions earn their exemption -----------------

The exemption above is only honest if each action it names is actually gated (so it is
not smuggling an ungated write past §3b), actually out of the fold (so the drawer's
count stays true), and actually accepted once the confirmation the owner's page will
send is attached. The confirm token is charge-current-<amps>, built here inline only
because the charge-menu control that will send it does not exist yet — when it does,
this should call that builder the way §4 calls confirmationFor, not restate the format.
```

Original line 331:

```text
--- 4. The confirmations the page really sends ------------------------------

⚠️ Called, not copied. `confirmationFor` is the single site the page builds `confirm=`
from — both `performAction` call sites go through it — so changing what the page sends
changes what is tested here in the same edit. A table of expected strings in this file
would be exactly the parallel array §1 exists to abolish, and it would stay green
while `31 FC` and Mode 04 were refused with a 400 on every press.

The clock is fed the Pi's own displayed `clock.iso`, since its confirmation is the
minute it showed rather than its own name; utcMinute is the server's formatter for
the same instant, so agreement here is the two halves of that handshake meeting.
```

## scripts/check-write-status-split.ts

Original line 8:

```text
The write status is a LIST plus ONE DETAIL, and the two halves must not be confusable.

  node --experimental-strip-types scripts/check-write-status-split.ts

⚠️ WHAT THIS EXISTS FOR. `summariseTarget` used to run for all 269 allowlist entries on every
request, and `armWrite()` fetches before every arm — so #104 put a 256 582-byte round trip
(249 878 of it the targets) into the arming gesture of the controls that change the motorcycle,
on garage wifi, on a Pi Zero. Now the Pi sends three fields per name and everything else for the
one target the page named.

⚠️ THE SCARY EDGE, and §2 is the whole reason this file exists. `selectedTarget()` used to find
in an array whose entries carried their own names; it is now ONE object the Pi hands over, and
it arrives a round trip after the selection moves. It decides `control.kind` — which chooses
`action=bit` over `action=parameter` — and `onBike()`, which becomes the compare-and-swap
`expected=`. A detail belonging to the previous selection would produce a coherent-looking write
against the wrong parameter, so a detail whose name does not match the selection is no detail.
```

Original line 42:

```text
── §1 the endpoint's contract, through the real runner ───────────────────────────────
```

Original line 77:

```text
⚠️ NULL, not []. The page keeps its own copy and must be able to tell "you already have it"
from "this bike has nothing writable" — the second renders a sheet that can write nothing.
```

Original line 89:

```text
── §2 the detail's name must match the selection ─────────────────────────────────────

Driven through the real module with a stubbed fetch, the way check-arming.ts drives the arm.
```

Original line 145:

```text
The Pi answers with the detail for a DIFFERENT parameter — an out-of-order reply, or a selection
that moved while the request was in flight.
```

Original line 151:

```text
── §3 a list=0 refresh does not empty the picker ─────────────────────────────────────
```

Original line 161:

```text
── §4 a sweep naming a different table discards the names ────────────────────────────

⚠️ writeTargets() is derived from the ACTIVE parameter table, and a sweep finishing under this
very sheet selects a new one (src/vcu/snapshot-store.ts). The names would otherwise stay on
screen after the Pi stopped accepting them.
```

Original line 177:

```text
⚠️ The sheet must not be left asking for a name the new table has not got. Without the re-point
`selectedTarget()` is null for ever, every later request keeps asking `detail=FIRST_PARAM`, and
the form sits on "Reading this parameter's notes…" — which reopening the sheet does not clear,
because forgetSelection() deliberately keeps the selection.
```

Original line 186:

```text
── §4b an answer that arrives out of order is dropped ────────────────────────────────

The `<select>` starts a request on every change, so two can be in flight and the OLDER one
carries a detail for a parameter the form has already left. Applied, it lands a detail
selectedTarget() refuses with nothing on its way to replace it — the stuck sheet of §4 by a
different route. The stub below answers the first request slowly and the second at once, so the
replies really do arrive in the wrong order rather than being asserted about in the abstract.
```

Original line 198:

```text
Initialised to a no-op rather than null: assigned only inside a promise executor, TypeScript's
control flow narrows a `null` start to `never` at the call below.
```

Original line 226:

```text
The real `<select>` handler, not a copy of it.
```

Original line 230:

```text
⚠️ Green with the counter removed too — the re-ask rule repairs it on the next request. What the
counter buys is below: no wasted round trip, and no flash of a detail the form has left.
```

Original line 240:

```text
── §4c THE COUNTER: a superseded reply is dropped rather than applied and repaired ───

What the counter buys over the re-ask rule alone: no wasted round trip, and no flash of a detail
the form has already left. One request for the new parameter, not two.
```

Original line 249:

```text
── §5 the pre-arm refresh still raises busy ──────────────────────────────────────────

⚠️ #107's warning, kept alive: the refresh before arming exists to raise `busy`, and that is the
double-tap guard on the controls that change the bike. A payload fix that removed it would look
like an improvement. check-charge-write-visibility.ts §5 holds the two charge views; this one
holds the sheet, whose function is named differently and whose refresh is fetchStatus().
```

Original line 265:

```text
── §5b a POST reply is adopted the same way a GET's is ───────────────────────────────

⚠️ A POST answers the same payload, and a sweep can finish across one — so `send()` must take
the listing through the same door `fetchStatus()` does, or a reply adopted without the check
leaves the picker offering names the Pi has stopped accepting. Asserted on the source because
send() is reached only from a button press, and the rule is that BOTH call sites go through it.
```

Original line 276:

```text
── §5c armWrite does not arm behind a refresh that did not happen ────────────────────

⚠️ The hole the ordering counter opened, and the reason fetchStatus() reports whether it applied.
A superseded reply applies NOTHING, so `armWrite()`'s before/after comparison compares the same
untouched state, finds it unchanged, and arms — on the value the tap started with rather than on
the Pi's answer now, which is the entire contract of refreshing before arming. Opening the red
fold or changing the picker during that round trip is enough, and `busy` disables neither.
Behavioural first: the scrape below cannot see a fetchStatus() that starts reporting `true` for
a reply it dropped, which is the same hole one layer down.
```

Original line 319:

```text
── §5d a Pi that renames its table AND its listing every reply is given up on ───────

⚠️ THE CASE THAT ONCE DELETED A GUARD. `adoptListing` cannot say yes twice running, and an
earlier version of this section proved exactly that and concluded the re-ask was one hop by
construction — so the bound was removed as dead code. It is not dead: adoptListing ALTERNATES
with the selection re-ask, which asks WITH the listing and hands `listingHeldFor` straight back.
The stub below is the one that shows it, and the earlier one could not: a different tableType
AND a different listing every reply, so the selection is re-pointed each time. Against an
unbounded reader this ran to 41 requests and was still going.
```

Original line 362:

```text
── §5e send() is in the same queue and under the same re-ask rule ────────────────────

Structural, like §5b's: send() is reached only from a button press. A POST answers the same
payload, so a picker change while one is in flight lands a detail for the parameter the form has
left — the stuck sheet of §4, through the one path §4 does not cover.
```

Original line 370:

```text
── §6 the seams stay seams ───────────────────────────────────────────────────────────

⚠️ The WHOLE of public/, not a list of files somebody has to remember to extend — a hard-coded
three would have said nothing about the fourth view that imported it.
```

## scripts/check-service-stamp.ts

Original line 8:

```text
The last-service stamp: what the page shows, WHERE it shows it, and that the claim the
2026-09-08 read retired stays retired.

  node --experimental-strip-types scripts/check-service-stamp.ts

⚠️ §1 and §2 are SOURCE assertions, and they are here because the bug was placement, not
text. The read worked on the first press and the answer rendered three sections up the
sheet (issue #154) — so a check that only exercised the formatter would have been green
throughout the defect it exists for. Asserting placement needs a DOM; this suite has no
browser (docs/diagnostics-and-checks.md §11.1), so it asserts the wiring instead and is
honest about the difference: it proves the outcome node is PASSED to the control, not
that a phone renders it. The screenshot in the PR is what covers the rest.

Same idiom as scripts/check-irreversible-actions.ts, which imports public/views/vcu-write.js
straight into Node and parses a sibling's source. Kept apart from it because that check is
about the red fold, and this control is deliberately outside it.
```

Original line 37:

```text
Which top-level function each offset falls in. Repo law forbids nested declarations, so
the nearest declaration above an offset is the one it belongs to.

⚠️ Matches `export`, `async` and both together. A pattern of just `function ` maps every
hit inside `export function VcuWrite()` to whatever plain function came before it, which
is a wrong answer rather than no answer — it went unnoticed until the names printed.
```

Original line 61:

```text
── 1. THE REPORTED BUG: the control carries something to show the answer in ──────────
```

Original line 63:

```text
⚠️ Asserted on the EXPORTED notes, not by parsing the call. This used to scan the
`ActionButton(…)` source with a 45-line state machine, which is what a positional
fourth argument costs — and ActionButton itself argues against that shape three lines
in ("derived from the prose rather than passed alongside it, so the tier a button is
painted and the sentence it carries cannot disagree"). The outcome now rides in the
notes, so both are data and this is two lines.
```

Original line 71:

```text
⚠️ Asserting an ABSENCE, on purpose. The answer is set in `.action-note.caution`, which
is amber but NOT bigger, so it is only conspicuous while nothing else in the block is
permanently amber. Adding a caution back means deciding that trade again —
docs/dashboard-decisions.md §"Where an ANSWER goes".
```

Original line 78:

```text
⚠️ ABOVE the prose, and bounded to ActionButton's OWN body. Unbounded, `NoteBlock(notes)`
matched the declaration far below instead of the call, so deleting the call from the
render left this green — a sixth mutation sailing past a check written for five.
```

Original line 89:

```text
── 1b. THE WIRING EITHER END OF IT: something fills the signal, something reads it ────
```

Original line 93:

```text
⚠️ Deleting the assignment leaves a button that POSTs, succeeds and shows nothing —
issue #154 verbatim — with every other check in this suite still green. A slot handed a
node that is never filled is the bug wearing the fix's clothes.
```

Original line 101:

```text
⚠️ `.caution`, never bare `.action-note`. At 11.52 px in --label the answer renders
byte-for-byte like the grey line above it, which is style.css:748-759's own argument
about the loudest sentence in a section being set as its quietest type.
```

Original line 108:

```text
── 2. THE ANSWER HAS ONE HOME, AND IS DROPPED WHEN IT STOPS BEING TRUE ────────────────
```

Original line 110:

```text
⚠️ `message`'s two rendering homes are Outcome(), three sections up the sheet, and
VcuWrite()'s !hasControls() branch — NOT the pair it is easy to assume. Getting that
wrong is what made an unconditional clear look safe, and it emptied the failure line
on the one answer that unmounts everything else. docs/dashboard-decisions.md.
```

Original line 116:

```text
Capitalised names only: those are the components. `send`, `performAction` and the rest
WRITE it, which is not the property here.
```

Original line 137:

```text
── 3. THE EVIDENCE — the four WORDs, and the payload that was really read ────────────
```

Original line 139:

```text
The 2026-09-08 reading, as the journal recorded it: all four WORDs zero.
```

Original line 154:

```text
⚠️ NOT repeated here: `implausible` is already the tail of the server's own sentence
(describeStamp in write-runner.ts), and the first draft printed it twice.
```

Original line 161:

```text
⚠️ Structural, so a fifth WORD cannot silently drop out of the evidence: the fields the
formatter walks ARE the identifiers the read asks for. Compared as key sets rather than
by building the fixture from them, which the four-field literal type refuses.
```

Original line 177:

```text
── 4. THE RETIRED CLAIM STAYS RETIRED ────────────────────────────────────────────────
```

Original line 179:

```text
⚠️ On 2026-09-08 A8 answered all four of these, so "nothing has ever read them" is false
wherever it appears — and it appeared in FIVE places, one of them a refusal message a
rider reads at the bike. A grep found four; a reviewer found the fifth, which is the
argument for making it a rule. Split literals so this file does not match itself, the
way scripts/check-vendor-names.ts does and for the same reason.

⚠️ THREE NEEDLES FOR FIVE SITES, and the first version got that wrong twice over. It
pinned whole sentences and caught three of the five — the README carried only the bare
word, and service-actions.ts a different tense — so restoring either to its old wording
left this green. Widening to "read off this bike" then caught five INNOCENT lines: that
phrase is ordinary English here (an infokey table, a parameter reading, a capture's
provenance). What is distinctive is the word, and the subject-verb pair either tense of
the claim needs.
```

Original line 201:

```text
A line that quotes the old claim AND dates its retirement is the doc doing its job.
```

## scripts/check-clear-dtcs.ts

Original line 21:

```text
node --experimental-strip-types scripts/check-clear-dtcs.ts

OBD Mode 04, and the read-back that is the only thing separating "the bike said 44" from
"the bike erased its fault memory".

⚠️ WHY THIS FILE EXISTS. On 2026-08-08 and 2026-09-11 this bike answered Mode 04 with a
positive `44` and erased nothing — the stored count never moved and PID 31 kept counting
from 19 173 km — and both presses were journalled "Mode 04 accepted". Nothing on the screen
or in the audit log could have told anyone. On 2026-09-13 the same button worked and swept
41 codes. The difference is now measured rather than assumed: the poller is parked, the
counters are read either side of the frame, and PID 31 returning zero is the verdict.
docs/clear-dtcs.md has the captures and the numbers.

No bike and no can0: a fake channel answers the frames, dispatched exactly as src/can/receive.ts
dispatches real ones, so the transport, the ISO-TP reassembly and the runner all run for real.
```

Original line 39:

```text
Runs `body` with console.warn captured, restoring it on every path out.
```

Original line 62:

```text
Every audit directory this run made, removed at the end rather than left in /tmp.
```

Original line 65:

```text
write-session.ts's own reply window for the one Mode 04 frame.
```

Original line 71:

```text
PID → the two data bytes it answers with, before and after the clear. Absent = silent.
```

Original line 76:

```text
Mode-03 frames to replay. Default: none, which is what most sections want.
```

Original line 78:

```text
Default BEFORE / AFTER_ERASED — the 2026-09-13 numbers.
```

Original line 81:

```text
How long a mode-01 reply takes to arrive. Default 0.

⚠️ Only the PID replies, and only up to 200 ms — obd.ts's own per-PID timeout. The
mode-03 frames must NOT be slowed: the transport gives a whole transfer 400 ms, so a
per-frame delay there fails the transfer instead of pacing it.
```

Original line 89:

```text
How long the Mode 04 reply takes. Default 0; used to hold `context.running` across a tick.
```

Original line 91:

```text
Called the instant the Mode 04 REQUEST is seen on the bus, before any reply.
```

Original line 93:

```text
Called the instant the mode-03 list request is seen — i.e. the read-back has begun.
```

Original line 95:

```text
Called for each mode-01 request, with how many have been sent so far (1-based).
```

Original line 101:

```text
Every frame we transmitted, in order, as `<id> <hex>`.
```

Original line 106:

```text
A bus that answers the four exchanges a clear performs.

Replies are delivered on a macrotask, never synchronously inside `send`: the real bus is
never faster than the caller's own `await`, and a synchronous answer would let a client
that registers its waiter AFTER sending pass here and hang on the bike.
```

Original line 125:

```text
Exactly src/index.ts's order: the in-flight service action gets first refusal, and
whatever it does not claim falls through to the always-on OBD side.
```

Original line 139:

```text
A flow control for the multi-frame list. The transport addresses it to the
responder, not to 0x7DF, which is why the id test above is not an equality.
```

Original line 210:

```text
A gate that says the bike is ROLLING. One wording, so four sections stop spelling it out.
```

Original line 215:

```text
A gate that says the bike is safe, with the charge-manager row in a state we choose.
```

Original line 235:

```text
Called the moment the hold is granted, so a section can turn the bike unsafe during the park.
```

Original line 237:

```text
Called each time the gate is sampled, so a section can turn the bike unsafe mid-action.
```

Original line 245:

```text
How many frames had been sent at the moment the hold was granted. Must be zero.
```

Original line 281:

```text
PID 01 packs the count into the low 7 bits of A; PID 31 is a 16-bit A:B.
```

Original line 295:

```text
The after-read is the before-read: nothing moved. Aliased so §2 says that rather than repeats it.
```

Original line 298:

```text
--- 1. The clear that works, read back on the same parked bus ----------------
```

Original line 332:

```text
⚠️ THE CACHE FIX, asserted where it broke: /stored-dtcs serves this snapshot, and before
this change it kept serving the PRE-clear list for up to 79 s after the button.
```

Original line 361:

```text
--- 2. The clear the bike accepts and ignores ---------------------------------

The 2026-08-08 and 2026-09-11 shape, which used to be indistinguishable from §1.
```

Original line 384:

```text
--- 3. Refusals, silence, and a poller that will not park ---------------------
```

Original line 424:

```text
⚠️ H1: the gate is sampled once in checkPreconditions, and parking the poller can take up to
HOLD_WAIT_MS. Nothing is in flight through any of it, so the watchdog cannot cover it — the
re-checks inside performClearDtcs are the only thing standing between that one reading and an
irreversible frame. A bike rolled while the poller parks must not get its memory erased.
```

Original line 448:

```text
⚠️ And again one step later. The two before-PIDs take 400 ms of their own, so a re-check that
only runs when the hold is granted still leaves that window between the last gate reading and
the frame. This case flips the bike unsafe after the counters are read and before the transmit.
```

Original line 476:

```text
--- 4. A clear whose read-back cannot answer ----------------------------------
```

Original line 499:

```text
--- 5. The gate watchdog: teeth while the frame is in flight, silence afterwards ----

⚠️ TWO SECTIONS, AND THE FIRST IS THE POSITIVE CONTROL. `context.running` is cleared as soon as
the Mode 04 outcome settles, and the watchdog returns early when it is null — so "no ABORTING
was logged" is worthless on its own: with an instant bus `running` is non-null for about a
millisecond and no 200 ms tick ever lands inside it, and the whole warn/abort body could be
deleted with both assertions still green. §5a holds the exchange open across a tick and asserts
the watchdog DOES cut it short; §5b then asserts it stays quiet once the frame has landed.
```

Original line 525:

```text
The reply is held for 500 ms — longer than the 200 ms watchdog interval — so the tick
lands while `context.running` is genuinely set. This is the only window in which the
watchdog has anything to abort, and before this section nothing exercised it.
```

Original line 543:

```text
Exactly one: `fired` short-circuits every later tick before it reads the gate again. One is
all that is needed, and it is one more than the previous version of this section ever got.
```

Original line 555:

```text
⚠️ Not `status !== "cleared"` alone — a plain 300 ms timeout gives that too, so the previous
version of this assertion passed with the watchdog's teeth removed. An abort settles the
pending request as an EMPTY payload (write-session.ts's stop()), which decodes as
"unrecognised" with this reason; a timeout says "no reply within the 300 ms window".
```

Original line 570:

```text
⚠️ The mirror. A bike that rolls AFTER the frame has landed finds nothing to abort — the
actuating half is over and what remains is four OBD reads, byte for byte what the always-on
poller emits at 2 Hz with no gate over it at all. What must NOT happen is the journal recording
an abort that never occurred, which is what it did before `context.running` was cleared early.
```

Original line 591:

```text
⚠️ 150 ms per PID reply so the read-back OUTLASTS the 200 ms watchdog interval, and the
tick count below is asserted so this section cannot go vacuous the way it first did.
150 and not more: obd.ts gives a PID 200 ms, and the mode-03 frames must not be paced at
all — the transport gives a whole transfer 400 ms.
```

Original line 596:

```text
⚠️ Flipped on the THIRD PID request — the first of the after-reads — rather than on a
sample index or on the list. The read-back is PID 01, PID 31, PID 02, then the list, so
anchoring on the list would put the flip at the very end and leave almost no read-back
for the watchdog to tick through. The phase is still read off the bus, not counted in
wall-clock, so reordering the read-back again cannot silently make this vacuous.
```

Original line 624:

```text
--- 6. The three PIDs the runner asks for are PIDs this repo can decode -------

`pollPidNow` warns and answers false for a PID that is not in obd.ts's table, so a constant
drifting from that table would degrade to "the bike said nothing" rather than failing.
```

Original line 642:

```text
⚠️ `false` is also what a silent bus returns, so the verdict alone says nothing. What
distinguishes "not in the table" is that the request never went out at all.
```

Original line 647:

```text
⚠️ pollPidNow shares the module-level `pending` map with the always-on loop, and PID 31 is
polled every round, so an unparked loop asking for the same PID crosses the two replies. It is
warned rather than refused — the hold is capped BY THE LOOP, so a read-back that overruns finds
the poller back underneath it, and a silent refusal there would look like a bike that said
nothing. Asserted so the implication is checkable rather than merely argued, the way
troubleCodeTransferInFlight() is for the sibling case.
```

Original line 671:

```text
--- 7. The verdict the Pi reaches, and the sentence it sends ------------------

⚠️ ONE COMPOSER. The page used to rebuild the sweep and the proof line from these numbers,
which put the prose in three places with only the verdict compared — so the wordings could
drift while this check stayed green. The browser now styles `result.message` by
`result.clear.verdict`, so what is worth asserting here is the verdict and the Pi's words.
```

Original line 695:

```text
⚠️ THE RETRY. Five codes came back within a second on 2026-09-13, so pressing again a
minute later is the expected gesture — and on that press PID 31 reads 0 on BOTH sides.
Keying on the after-value alone called that "erased" in green, which is the exact claim
the two failed presses make, on the press that most needs an honest verdict.
```

Original line 706:

```text
--- 8. When the cable warning appears -------------------------------------------

⚠️ `ok` on the veto row is the ONLY state that means "fresh charge manager, cable present":
src/vcu/service-gate.ts's inletCheck returns `inlet-empty` for an empty inlet, `stale` past
the 5 s budget and `missing` when the charge manager has never spoken. `stale` is the shape
the 2026-09-11 ride log leaves behind, and it must NOT warn — the log cannot say what the
gate read that day, and inventing a warning from a stale row would be inventing that answer.
```

Original line 716:

```text
⚠️ BOTH copies, every case. The Pi's `verdictSeesACable` decides whether the audit journal
advises unplugging; the browser's `chargerIsAttached` decides whether the caution shows. They
cannot import each other — no build step in public/ — so this is what stops them drifting.
```

Original line 739:

```text
--- 9. The hold budget is arithmetic, not a sentence in a comment ---------------

⚠️ docs/clear-dtcs.md §5 calls this margin load-bearing and then states it as a number nothing
verifies. Past obd-hold.ts's cap the poller resumes UNDERNEATH the read-back and its own 0x7DF
traffic makes the VCU abandon the transfer, so adding a PID or raising RETRY_ATTEMPTS has to go
red here rather than in a garage.
```

Original line 749:

```text
⚠️ The PID count is COUNTED off a real run, not written down. `5 * PID_TIMEOUT_MS` was a copy
of the action's shape, so adding a sixth read left this green while the budget grew.
```
