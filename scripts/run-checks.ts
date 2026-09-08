import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// `npm test` — runs every self-check in the repo, in order, and exits non-zero if any
// of them does. A runner, not a framework: the checks predate it and are top-level
// scripts that report failure with `process.exit(1)`, so each gets its OWN PROCESS.
// Imported into one, the first failure would take the runner down and leave every later
// check unreported — the opposite of what a red build should tell you.
//
// ⚠️ Only checks that pass or fail on their own, with no bike and no local-only files,
// belong here. The rest of scripts/ is left out on purpose, and one exclusion matters
// more than the others: scripts/read-freeze-frame.ts TALKS TO THE BIKE. It is the only
// thing in the repo that opens a socket outside the service, so it must never appear in
// CHECKS. Which others are out, and why each: docs/diagnostics-and-checks.md §11.2.
//
// ⚠️ Nothing below opens a CAN socket, and CHECK_TIMEOUT_MS is the guard against that
// quietly changing: a check that DID reach for hardware would mostly not fail — it
// would sit waiting on a bus that is not there — so a check that stops producing a
// verdict is counted as one that failed.
//
// Why there is no test framework here: docs/diagnostics-and-checks.md §11.1.

/**
 * Per-check wall-clock limit. The whole suite runs in about 25 s today, much of which is
 * check-fan-curve.ts sitting still: it replays a 1500 ms kick-start and two
 * signal-staleness windows in real time, on about a tenth of a second of CPU. So this is
 * not a performance budget — it is only here to turn a hang into a red build instead of
 * an Actions job that runs until the six-hour ceiling.
 */
const CHECK_TIMEOUT_MS = 120_000;

interface SelfCheck {
  /** Path from the repo root — the same thing you would type to run it by hand. */
  script: string;
  /**
   * Fixed flags this script needs to be a check at all. Not argument forwarding — see
   * runCheck() for why the runner's own argv never reaches a script — but part of the
   * entry, so what runs here is what the `covers` line claims and cannot drift with
   * however the suite happens to be invoked.
   *
   * generate-grafana-dtc.ts is why this exists: with no flag it REWRITES the dashboard
   * and exits 0, which under `npm test` would be a check that silently edits a tracked
   * file and never fails. `--check` is what makes it report instead of act.
   */
  args?: string[];
  /** What it covers. Printed as a header, so a red log names what went rather than a path. */
  covers: string;
}

/** In script-name order; they are independent, so nothing depends on which runs first. */
const CHECKS: SelfCheck[] = [
  {
    script: "scripts/check-can-decoders.ts",
    covers:
      "the broadcast frame decoders against frames captured 2026-08-02, plus three properties of the decoder set as a whole: that every id which decodes is in the kernel RX filter, that every emitted key is declared in the registry, and that no 1/0 flag carries a deadband big enough to swallow its own transitions",
  },
  {
    script: "scripts/check-charge-ack.ts",
    covers:
      "whether the Pi can tell that a charge-current command took, against the 2026-09-07 session where three " +
      "commands provably moved nothing and two provably worked: that all seven adjudicate as their known outcomes, " +
      "that the real trace still supplies at least two true negatives and one true positive and that no verdict " +
      "comes from an empty window, that five constructed shapes cover what that day did not produce, that the naive " +
      "first-crossing test really would have scored two of the failures as successes (which is why the envelope " +
      "exists), that the settle grace changes no verdict, that a binding command still reads waiting halfway " +
      "through its window, that the ride-log codes are distinct, and that nothing in the adjudicator reads pack_a",
  },
  {
    script: "scripts/check-charge-command.ts",
    covers:
      "the charge-current transmitter against the dash's OWN frames, captured off the bus during a real DC fast " +
      "charge on 2026-09-07: that buildChargeCurrentCommand reproduces all twelve dial changes byte for byte with " +
      "the 0x120 commit twin first, that it never again produces the 0x121-only frame the bike really sent that " +
      "day and that moved no current, that both decoders read the captured commands back, that the opcode gate " +
      "emits nothing for the real non-command frames sharing the id, and that the transmit spacing sits inside the " +
      "dash's own measured 4.2-10.1 ms",
  },
  {
    script: "scripts/check-charge-write-visibility.ts",
    covers:
      "why the charge tab's write controls used to flicker: that the browser's staleness window for " +
      "charge_manager_state stays above ws.ts's heartbeat, since a signal that never changes is refreshed only by " +
      "that heartbeat and any window at or below it unmounts the whole set-current tile on a late timer; that " +
      "neither charge view reaches serverTime through liveChargeType or isStale, which would replace its DOM node " +
      "on every message; that visibility does not ride on the /vcu-write payload's identity; and that both arm " +
      "paths still raise busy around the pre-arm refresh, which is the double-tap guard (#107)",
  },
  {
    script: "scripts/check-pack-resistance.ts",
    covers:
      "the pack-resistance estimator that replaced the BMS's own unusable 0x206 figure, driven by real 0x200 " +
      "frames re-encoded from the 2026-09-07 ride: that a genuine load window fits the resistance those same " +
      "frames were measured to have, that an at-rest window falls back to the modelled curve instead of " +
      "reporting a stale measurement, that the hold expires on the stated interval, that only pairs from ONE " +
      "frame enter the buffer (a missing half, a stamp skew and the 5 s heartbeat's repeat are each refused), " +
      "that the modelled curve is monotone and holds its endpoints, that the answer is never null so no " +
      "consumer needs a null branch, and that store.js hands the buffer only readings which passed the same " +
      "plausibility gate the rest of the dashboard uses — the sign of the slope and the same-frame rule are " +
      "the two ways this can be silently wrong, and a wrong sign yields a plausible-looking ~1 mOhm",
  },
  {
    script: "scripts/check-charge-mode.ts",
    covers:
      "the dashboard's one charge rule, driven by real frames through the real decoders: that a parked bike and a " +
      "ridden one are not a charge however the AC charger's frames are behaving, that an AC session reads AC, that " +
      "a DC session reads DC even though the BMS reports Idle for the whole of one and survives the late heartbeat " +
      "a steady boolean's freshness depends on, that the same Idle at the tail of an AC session is not mistaken " +
      "for a fast charge, and that no answer ever names DC without the contactor bit under it — plus that every " +
      "signal the rule consults is still a registered stream signal, since a renamed one would leave it answering " +
      "'not charging' for ever in silence",
  },
  {
    script: "scripts/check-ride-log-status.ts",
    covers:
      "what /status reports about the ride log, and about the CAN sources: that the log count is read " +
      "off the directory rather than capped or hardcoded (13 files, sized, past the 10 that was reported as stuck), " +
      "that five real seals through src/storage/encrypted-log.ts still land in one day file — so a file is not a " +
      "segment, and a caption that comes back may not call it one — that a group nothing has ever been heard from " +
      "reads [0, n] rather than being left out of the payload, that a group is dropped from the summary only when " +
      "every signal in it is written on request, that a group which does reach the payload is one the check names " +
      "on purpose, and that a talking bus counts each key once — plus that a sealed segment opens with the matching " +
      "private key and with no other, which is the only security property anything here is allowed to claim",
  },
  {
    script: "scripts/check-vcu-params.ts",
    covers:
      "VCU parameter table — including that it is Energica's table 16407, the one the bike itself names at " +
      "parameter 276, and that a bike naming any other one is shouted about rather than silently mislabelled — " +
      "request encoding and the read-only guard, framing against frames captured 2026-08-08, " +
      "the live bank-1 reads, interpretation, the snapshot diff, the KWP transport against a simulated micro, and — " +
      "since the service-write PR — the write allowlist and its per-parameter ranges, the refusal of every " +
      "non-allowlisted identifier, the table-type gate that refuses a parameter write until the bike has itself " +
      "named a table this software encodes (refused when never read, refused when mismatched, permitted when " +
      "confirmed — in the codec as well as the runner, and not applied to the service actions, which address no " +
      "index), the seed→key algorithm against four seed/key pairs captured off this bike's own " +
      "bus, the 0x120 clock frame against two frames that really went out, the service-stamp decode, Mode 04 and the bus lease",
  },
  {
    script: "scripts/check-button-decode.ts",
    covers:
      "the handlebar-button bits on 0x102 b0 and 0x400 b2, the day/night flag on 0x400 b5 and the fast-charge contactor monitor on 0x102 b3, against frames captured 2026-08-04, plus the RX filter, short frames, and the registry and bounds entries a button needs to reach the dashboard",
  },
  {
    script: "scripts/check-theme-contrast.ts",
    covers:
      "both of style.css's palettes, parsed out of the file itself rather than restated: every ink colors.js and " +
      "svg.js draw with exists in both, values clear 11:1 and text and status inks 6:1 against both the page and " +
      "the tile they land on, and no two steps of the good→watch→warn→bad ramp are closer than 15 in the a*b* " +
      "plane — the light theme buys its contrast by compressing that ramp, so the trade is pinned at both ends",
  },
  {
    script: "scripts/check-all-view-tiles.ts",
    covers:
      "which tile each signal gets on the dashboard's ALL page: that every key public/lib/latched.js names is a real " +
      "signal, is not already in the buttons group, carries no deadband and is gated to 0…1 by bounds.js, that the " +
      "two momentary signals outside that group (`horn` and `ignition_button`) and every member of the group do get " +
      "the latched tile — a raw 1/0 readout of a 30 ms press cannot be watched at all — and that the beam lamps, the " +
      'vehicle states and the brake-pressure measurement do NOT, since that tile says "PRESSED" and "3 presses"',
  },
  {
    script: "scripts/check-brake-lane.ts",
    covers:
      "the ride-summary dashboard's Brake lane, run out of the dashboard JSON against a database built by the real " +
      "src/db.ts writer, over three windows: that the retired `brake` rows still feed it up to the day " +
      "front_brake/rear_brake started, that the eleven-day overlap where both exist is read once rather than twice, " +
      "that a release under a still-held second circuit stays yes — the carry-forward the OR needs, since both " +
      "halves are log-on-change — that the lane comes back down at all, which the obvious running-MAX spelling " +
      "never does, that a window OPENING MID-APPLICATION opens at yes rather than drawing `no` over a squeezed " +
      "lever, that a half nobody ever logged does not read as a held brake, and that every signal key the query " +
      "names still exists",
  },
  {
    script: "scripts/check-derived-signals.ts",
    covers:
      "that no broadcast decoder emits a flag computed from other flags on the same frame — the rule `brake` = " +
      "front_brake | rear_brake broke from June until 2026-08-30. Every stream id is decoded over every value of " +
      "every byte at every DLC, against both a 0x00 and a 0xFF background, plus 2000 seeded random frames, and each " +
      "moving 0/1 signal is tested against every identity, inverse, OR and AND of the others on its frame. The " +
      "payload count, the number of flags that moved and the number of combinations tried each have to clear a " +
      "floor, so a sweep that reaches nothing fails instead of reporting zero hits out of zero tries",
  },
  {
    script: "scripts/check-handlebar-gestures.ts",
    covers:
      "the two handlebar gestures — double-click cruise-set for the next tab, long-press indicator-cancel to save a waypoint — replayed through the recognisers the phone runs, including the deadline wakeup without which a hold could only ever fire on release. Most cases are real durations that must fire NOTHING: the 140 ms median press, the 30 ms shortest, the 920 ms longest ordinary press on any handlebar button, and the only 1794 ms cruise-set press in the corpus. Plus the threshold margins and the binding itself — registered, deadband-free, and not the cruise-arm switch, whose every recorded press armed cruise control",
  },
  {
    script: "scripts/check-connection.ts",
    covers:
      "when the dashboard has a WebSocket open and what it does when it should not: that hiding the page closes the " +
      "socket and unhiding opens exactly one new one, that the messages queued while it was hidden are refused " +
      "rather than replayed as live telemetry, that lock/unlock/lock/unlock never costs more than one socket at a " +
      "time however the abandoned ones' events arrive afterwards, that a socket which stops carrying data is torn " +
      "down and replaced with NO close event ever delivered — but not one second before 12 s, so a parked bike " +
      "cannot churn sockets — that the 2 s backoff still gates every retry and none is queued while hidden, that " +
      "isStale() calls every reading stale while the link is not live so nothing frozen is shown at full " +
      "brightness — while the view rules hold their edges across the same gap, so a dropout during a DC charge " +
      "cannot throw the rider off the Charge tab and back — and that the Pi skips a client past the backlog cap " +
      "and hangs up on one still past it a heartbeat later, with the cap still holding several full snapshots — " +
      "and, against real servers on loopback ports, that neither an oversized frame nor a malformed one can end " +
      "the process — which is what a missing `error` listener turns a rejected frame into — while a bind that " +
      "FAILS still does end it, rather than leaving a live process with nothing listening for systemd to call healthy",
  },
  {
    script: "scripts/check-fan-curve.ts",
    covers:
      "the automatic cooling-fan curve, which is pure so that three things nobody can stage in a garage are one " +
      "function call: the riding curve's endpoints and midpoints, the DC rule's flat 100 % asserted at the two " +
      "temperatures the retired ramp answered 65 and 30 at, so a resurrected curve cannot pass, and asserted to " +
      "answer to neither gate nor the hysteresis, the speed gate and BOTH hysteresis pairs asserted at the same input " +
      "in both directions, and the three staleness tiers — live, held for 60 s, then the floor plus a fault, because " +
      "a dead batt_temp_hi reads exactly like a cold pack and this fan has no tacho to contradict it. And that the DC " +
      "rule does NOT swallow that fault: four ways of losing the temperature mid-session each give 100 % AND reason " +
      "2, the code the dashboard paints red, since a rule that named itself there would hide a broken sensor until " +
      "the next ride. Plus the near-misses each signal has: that charge_type's DC value 2 does not select the DC " +
      "rule, that an absent or impossible speed opens the gate rather than holding the fan off over a hot pack, that " +
      "the Pi's own bounds on batt_temp_hi are the dashboard's, that every reason code has both a bound and a " +
      "sentence, and that no slider stop lands in the dead band under the floor. Every threshold is pinned to a " +
      "LITERAL — an assertion phrased in the constant it is checking passes for every value of that constant, which " +
      "is how a stop gate at 110 km/h and a one-hour speed-staleness window were both green here. The last two " +
      "sections drive the real controller through a recording FanPwm — the only place the running-phase duty change " +
      "issue #119 reports as unreached is reached — and then a controller that THROWS, since the loop discards each " +
      "tick's promise and an escaped rejection would end the whole service every two seconds",
  },
  {
    script: "scripts/check-fan-fun.ts",
    covers:
      "fun mode — the rider's throttle driving the radiator fan — and above all the gate in front of it, which is " +
      "the one place in this repo where the throttle of a 145 hp motorcycle is wired to something that is not the " +
      "motor. That the gate FAILS CLOSED: a bike in Go is refused, a bike moving at 0.1 km/h is refused, and an " +
      "absent, stale or non-finite `go` or `speed_can_kmh` is refused rather than read as the parked bike it " +
      "resembles — the exact opposite polarity to src/fan/curve.ts's speed gate, where a missing speed OPENS the " +
      "gate, and both are asserted here so the contrast cannot be flattened by someone tidying the two to match. " +
      "That the 500 ms staleness window is the SHIPPED one, waited out for real rather than injected, because two " +
      "earlier PRs added a seam and moved production's default out of coverage. That `go` going true takes the " +
      "throttle off the fan inside 50 ms — a fifth of the watchdog, so deleting the change subscription and " +
      "leaving the poll is caught — that leaving goes to AUTOMATIC rather than to manual holding a wrist's duty, " +
      "and that nothing survives a restart. Then the mapping: 0 % throttle is the 30 % floor and 100 % is the cap, " +
      "as literals; no input anywhere in 0…100 lands below the floor, which is what makes the bridge enables a " +
      "once-on-entry / once-on-exit affair and keeps `pinctrl` out of a throttle sweep; and every one of " +
      "`throttle_pct`'s 1000 raw steps reaches the bridge as a DIFFERENT duty_cycle in nanoseconds, since hearing " +
      "where the resolution runs out is the whole point of the mode and a duty rounded to whole percent would " +
      "throw away fourteen steps in fifteen",
  },
  {
    script: "scripts/check-fan-endpoint.ts",
    covers:
      "both ends of the /fan wire: that the X-Cool-Eva header stands in front of every POST — the only thing " +
      "between a cross-origin form on any page the rider's phone opens and a spinning blade, since a custom header " +
      "name is what makes the request non-simple — refusing a missing one, a wrong one, the service-write value, " +
      "and a duplicated one that joins to `fan, fan`, with each refusal shown to have commanded nothing, while a " +
      "GET needs no header because it touches no hardware; every branch of parseFanRequest(), including the " +
      "duty-and-mode-together 400 the endpoint refuses rather than guesses at and the 1e2 / 0x40 notations it does " +
      "accept; and the page's half, public/lib/fan-command-queue.js, driven with a recording sender: that a " +
      "five-move drag reaches the Pi as TWO POSTs with the last value intact, that the first move goes at once " +
      "from a clock of any origin including zero, that a send slower than the interval never overlaps the next " +
      "one, and that one that throws does not wedge the slider for the rest of the session — plus §4, the queue " +
      "run with NO clock and NO timer injected, since the two `??` defaults are what actually ships and " +
      "everything above replaces them",
  },
  {
    script: "scripts/check-fan-ordering.ts",
    covers:
      "the two orderings docs/fan-control.md §3 calls the whole safety property of src/fan/control.ts, driven " +
      "through startFanControl() with a fake FanPwm that records its call sequence: that a start from rest writes " +
      "the duty and enables the PWM output BEFORE the IBT-2's enables go HIGH, that a stop and the shutdown path " +
      "both drop the enables BEFORE the output and the duty, and — the case that produced the check — that an " +
      "enable-drop which FAILS leaves the PWM driving rather than zeroing it under a live bridge, since enables " +
      "HIGH at 0 % turns both low sides on and brakes a rotor in a 270 km/h airstream. Nothing here needs a Pi: " +
      "the fan has no tacho, so every one of these is invisible on the bike",
  },
  {
    script: "scripts/check-service-preview.ts",
    covers:
      "that scripts/build-service-preview.ts produces a file whose script blocks actually parse — the one failure mode nothing else here can see, since no other check executes generated output",
  },
  {
    script: "scripts/check-freeze-frame.ts",
    covers:
      "the 120 infokey fields and 155 per-fault shortlists against dtc-table.ts, the 0x17 request encoding and its read-only guard, extended-addressed ISO-TP reassembly and the freeze-frame layout against CONSTRUCTED transfers (no 0x17 payload has ever been captured), plus the refused, wrong-component, gapped, short, oversized, truncated, surplus and foreign replies they must reject — and that every rejection still carries the bytes that caused it",
  },
  {
    script: "scripts/check-gps-clock.ts",
    covers:
      "the GPS clock gate against the four corrupt frames in rides.db and two real cold boots, replayed again ten years on to prove the rule has no expiry date, plus the recoverable cooldown, the week-rollover floor, the two's-complement altitude and the blended-fix guard",
  },
  {
    script: "scripts/check-arming.ts",
    covers:
      "the two-tap arm/dwell in front of every control that writes to the bike — public/lib/arming.js, which had no " +
      "coverage at all until 2026-08-30 and is the whole of what stands between a double-tap and a write to a " +
      "calibration EEPROM. On a clock the check hands in: that one tap arms and cannot also fire, that a second at " +
      "399 ms is refused and one at exactly 400 ms is not, that a refused tap is IGNORED rather than disarming — " +
      "the distinction the caption depends on — that arming a second control re-stamps rather than inheriting a " +
      "dwell that elapsed ten seconds ago, that a clock which jumped backwards hands out no dwell, and that a held " +
      "Enter is cancelled while a held ArrowDown is not. Then the parts no single module holds: that the charge " +
      "tab's two now CO-VISIBLE controls do not share a key, that a status refresh landing under an armed button " +
      "disarms it (run for real against a stubbed fetch), that all five firing sites still test their own key, then " +
      "the dwell, then clear, then act — in that order, with the refused branch doing nothing but return — and " +
      "that no module outside arming.js ever sets `armed` to a non-empty key, which is what makes the dwell " +
      "unskippable. Plus the production defaults nothing else exercises: the same gate on the real performance.now()",
  },
  {
    script: "scripts/check-irreversible-actions.ts",
    covers:
      "what is behind the menu sheet's red fold — that the collapsed row's count and its three names are read off " +
      "the list of actions rather than written a second time beside it, and, across the two files that cannot see " +
      "each other, that the fold holds EXACTLY the actions src/http/vcu-write.ts refuses without a confirmation: a " +
      "fourth confirm-gated action on the Pi that nobody put behind the fold would otherwise be a destructive " +
      "control sitting in the open list with the read-only ones, and nothing else in the repo would notice",
  },
  {
    script: "scripts/check-kwp-multiframe.ts",
    covers:
      "the multi-frame half of the VCU's custom-KWP channel: the five read services and the guard that keeps every write unexpressible, ISO-TP segmentation against the 0x35 request frame captured 2026-08-08 and flow control in both directions, the one multi-frame reply with real bytes behind it (A8 bank-2 0x2001, reconstructed from two independent live records), the gapped / short / oversized / foreign / flooding replies the transport must abandon rather than complete, and the whole 0x35/0x36/0x37 bulk sequence with its block cap, cancellation and bus lease",
  },
  {
    script: "scripts/check-power-bar.ts",
    covers:
      "the riding screen's power bar, every part of which is a direction that looks deliberate when it is " +
      "backwards: that regen reads green and a pull never does — inverted from 2026-08-03 until 2026-09-08, under " +
      "a doc comment that said the right thing throughout — that drive is WHITE at every load, the ramp by " +
      "magnitude having been retired, and that the dashed derate rule keeps a 3:1 contrast floor over that fill, " +
      "computed rather than restated, since it is drawn on top of it. That both BMS ceilings convert to kW through the MEASURED pack " +
      "voltage with a 0 A derate surviving as a real limit and a 0 V reading rejected as a missing one, that both " +
      "go quiet while a charge is up — the BMS zeroes them there, and believing them would hatch the whole bar " +
      "away under a fill showing 24 kW of charge — and that each ceiling hatches its own side's far end against " +
      "its OWN scale, hatches nothing at or past full scale, hatches the whole half at zero, and still draws for " +
      "a derate of 1 kW, since a minimum width that swallowed small ones made a blank end mean two things. " +
      "Walked end to end as well as at each end, because covering both ends left a crossed pair between them green",
  },
  {
    script: "scripts/check-power-cut-durability.ts",
    covers:
      "the four things the service writes, against the power cut this Pi takes every ride: that appendDurably " +
      "keeps fs/promises appendFile's full-write behaviour while flushing the file, and flushes the DIRECTORY " +
      "only on the call that created it; that replaceFileDurably swaps latest.json by rename rather than " +
      "rewriting it in place — proved against an in-place writeFile mutant by holding an fd open across the " +
      "write, where in-place hands the held reader the new bytes through the same inode and a rename leaves it " +
      "on the complete old file; that the readers still behave on the shapes a cut actually leaves (a NUL run " +
      "over a whole line of the audit journal and of the resume file, a truncated latest.json, one that parses " +
      "but is not a snapshot), which is the FIRST coverage those readers have had; that the real writers move the " +
      "flush counters, so a call site reverted to appendFile or writeFile turns this red — though NOT that the " +
      "syscall happened, since deleting the datasync() and leaving the counter beside it is invisible from " +
      "userspace, one of two gaps the check names in its own header; that a 1710-byte hole punched into a " +
      "real sealed .celog costs exactly the segments whose bytes it touches and nothing on either side of it, " +
      "measured through scripts/decrypt-log.ts itself as a subprocess because check-ride-log-status.ts only has " +
      "a MIRRORED copy of its segment reader; that the resume file flushes its directory entry on " +
      "creation and its rows once at close but never per row, and that clearPartialSweep flushes " +
      "the removal; and that syncFilesystems reports a missing command as a sentence " +
      "rather than throwing into the update endpoint. ⚠️ macOS fsync is not F_FULLFSYNC, so a green run here " +
      "proves the code path and the ordering — the durability claim is an ext4-on-Linux one",
  },
  {
    script: "scripts/check-tab-routing.ts",
    covers:
      "the dashboard's tab URLs — that each tab still lives at the address every bookmark holds, that a fragment naming no tab (empty, unknown, malformed, or a path) lands on the riding screen instead of throwing before the first render, and that the tab ring the high-beam gesture advances through closes",
  },
  {
    script: "scripts/check-update-endpoint.ts",
    covers:
      "the menu's Update button against real git repos and no Pi: that it pulls AS THE CHECKOUT'S OWNER rather " +
      "than as root — the 2026-09-08 bug, where a root pull left root-owned files in .git and the next pull as pi " +
      "died silently, restarting the service on stale code — with the owner uid read from the checkout itself and " +
      "not from whoever is asking, which is the one line a test of the argv-builder alone cannot see. Plus " +
      "--ff-only against a genuinely diverged checkout, the 405 guard, git's own words reaching the phone, a " +
      "timeout named only when the kill is at the deadline (an earlier one is an OOM), and one hint per failure " +
      "shape — poisoned .git, refused key, unknown host, divergence, https login, sudo — none of them naming a " +
      "user called pi. \u26a0 The restart is asserted ARMED and never fired: a real ServerResponse would emit " +
      "'finish' and run `sudo systemctl restart cool-eva` on whatever machine ran npm test. \u26a0 The " +
      "end-to-end sections never take the sudo branch — the temp checkout belongs to whoever runs the suite — so " +
      "the user switch is proved on the argv, which is the only part testable without a second uid",
  },
  {
    script: "scripts/check-virtual-clock.ts",
    covers:
      "scripts/virtual-clock.ts itself, against real setTimeout as the oracle: that same-instant timers fire in " +
      "arm order, that a promise chain resumed by one timer runs before the next fires, and that a nested or " +
      "async callback orders the same way — the properties check-fan-endpoint.ts §3 rests on and which could all " +
      "be deleted while it stayed green. Plus the divergence that is deliberate (a callback reads its OWN " +
      "deadline, not the end of the step) and the three inputs that would silently corrupt the clock: a NaN " +
      "delay, a self-rearming zero-delay timer, and two advance() calls in flight at once",
  },
  {
    script: "scripts/check-vendor-names.ts",
    covers:
      "that no tracked file names the manufacturer's service-tool product, its executable, its libraries or the " +
      "tables extracted from it — in its contents or in its own path. The gitignored obd-garage/ notes use those " +
      "names legitimately and are where they keep being copied from, so this is the check that stops a fact " +
      "arriving with a product name still attached to it",
  },
  {
    script: "scripts/decode-dtc-response.ts",
    covers:
      "ISO-TP reassembly and the OBD-II mode-03 decoder, against a real 80-byte transfer captured 2026-08-04, plus the gapped, oversized, refused and foreign replies they must reject",
  },
  {
    script: "scripts/generate-grafana-dtc.ts",
    args: ["--check"],
    covers:
      "the copy of the DTC table embedded in grafana/dashboards/trouble-codes.json as a SQL VALUES list, its NULL-MIL arm and the queryText that claims to mirror it, plus every prose sentence that states how many codes there are",
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");

const failures: string[] = [];

for (const check of CHECKS) {
  console.log(`\n──── ${check.script} ${"─".repeat(Math.max(0, 74 - check.script.length))}`);
  console.log(`     ${check.covers}\n`);
  const outcome = await runCheck(check);
  if (!outcome.passed) {
    failures.push(`${check.script} — ${outcome.reason}`);
  }
}

console.log("");
if (failures.length > 0) {
  console.error(`FAILED — ${failures.length} of ${CHECKS.length} checks:`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  // Not process.exit(): Node's stdio is asynchronous whenever it is a pipe, which it
  // always is under Actions, and exit() abandons whatever is still queued — here, the
  // list naming which check broke, i.e. the only part of a red run worth reading.
  process.exitCode = 1;
} else {
  console.log(`✓ all ${CHECKS.length} checks passed — no bike, no can0, no local-only files`);
}

type CheckOutcome = { passed: true } | { passed: false; reason: string };

/**
 * Runs one check to completion and reports how it went.
 *
 * Output is inherited rather than captured. These scripts print the evidence for what
 * they verified — the 39 decoded trouble codes, the parameters that differ from the
 * variant file — and that is worth having in the log of a run that passed, not only in
 * one that failed.
 */
async function runCheck(check: SelfCheck): Promise<CheckOutcome> {
  // Deliberately no forwarding of *this* process's argv. The checks take different
  // flags, and one of them takes bare arguments: check-vcu-params.ts has --dump <path>,
  // while decode-dtc-response.ts reads its arguments as CAN frames to decode *instead
  // of* the committed capture — which would skip the assertions that make it a check at
  // all. A shared argv would therefore mean something different, and wrong, to each.
  // Run a script directly when you want to pass it something. check.args is the
  // opposite of that: fixed per entry, written down next to what the entry claims to
  // cover, and the same on every run.
  const child = spawn(process.execPath, ["--experimental-strip-types", check.script, ...(check.args ?? [])], {
    cwd: projectDir,
    stdio: "inherit",
  });

  let timedOut = false;
  return await new Promise<CheckOutcome>(resolve => {
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: what this catches is a check blocked on hardware that is
      // not there. It has nothing to unwind, and a process stuck in a bus read is not
      // necessarily in a state to act on a polite signal.
      child.kill("SIGKILL");
    }, CHECK_TIMEOUT_MS);

    child.on("error", error => {
      clearTimeout(timer);
      resolve({ passed: false, reason: `could not be started: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ passed: false, reason: `no verdict within ${CHECK_TIMEOUT_MS / 1000} s — killed` });
        return;
      }
      if (signal !== null) {
        resolve({ passed: false, reason: `killed by ${signal}` });
        return;
      }
      resolve(code === 0 ? { passed: true } : { passed: false, reason: `exited ${code}` });
    });
  });
}
