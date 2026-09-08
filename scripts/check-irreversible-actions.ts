import { readFile } from "fs/promises";
import { IRREVERSIBLE, confirmationFor } from "../public/views/vcu-write.js";
import { parseWriteRequest, utcMinute } from "../src/http/vcu-write.ts";

// What is behind the menu sheet's red fold, checked without a browser.
//
//   node --experimental-strip-types scripts/check-irreversible-actions.ts
//
// Same shape as scripts/check-tab-routing.ts, and for the same reason: public/ is ES
// modules with no build step, so a browser file whose exported constants are plain data
// imports straight into Node. public/views/vcu-write.js does nothing at module scope but
// declare van states and this list — the buttons are thunks, deliberately, so that the
// fold constructs nothing while collapsed — which is what lets this file exist with no
// jsdom and no headless browser.
//
// ⚠️ THE FOLD MAKES A PROMISE ABOUT WHAT IS INSIDE IT, to somebody standing at a bike.
// Collapsed it shows a count and three short names, and that line is what a rider reads
// to decide whether to open the drawer at all. Behind it are `31 FC` (which stamps a
// service point on the bike's own clock and odometer, with no unset), OBD Mode 04 (which
// takes the freeze frame with the codes) and a clock write that cannot be read back. A
// drawer that names the wrong three, or says three and holds four, is worse than one that
// names nothing.
//
// ⚠️ THE REAL INVARIANT SPANS TWO FILES THAT CANNOT SEE EACH OTHER: src/http/vcu-write.ts
// decides which actions demand `confirm=`, public/views/vcu-write.js decides which ones a
// thumb has to open a drawer to reach. A fourth confirm-gated action added to the Pi and
// not put behind the fold is a destructive control sitting in the open list with the
// read-only ones, and nothing else in the repo would notice. So §3 reads the actions off
// the `case` labels of parseWriteRequest's own switch and asks the server of each whether
// a complete request is still refused with no `confirm=`; §4 calls `confirmationFor`, the
// single site the page builds `confirm=` from, rather than listing what it should produce
// — a list here would be the parallel array the check exists to abolish.
//
// The drift both halves used to be able to do: docs/diagnostics-and-checks.md §11.4.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. What the drawer says it holds ----------------------------------------
//
// Written out, in the order the buttons appear. Spelled out rather than derived, for the
// same reason check-tab-routing.ts spells out the tab URLs: this list is a promise made
// to somebody who is deciding whether to open a drawer with `31 FC` in it, so changing
// one has to be a decision rather than a diff nobody looked at twice.

const EXPECTED: [name: string, action: string][] = [
  ["Service stamp", "set-service-point"],
  ["Bike clock", "sync-clock"],
  ["Clear codes", "clear-dtcs"],
];

console.log("\n1. what the fold names");

check(
  `the fold holds exactly ${EXPECTED.length} actions, in order`,
  IRREVERSIBLE.length === EXPECTED.length &&
    IRREVERSIBLE.every((entry, index) => entry.name === EXPECTED[index][0] && entry.action === EXPECTED[index][1])
);

for (const [name, action] of EXPECTED) {
  const entry = IRREVERSIBLE.find(candidate => candidate.action === action);
  check(`${action} is still behind the fold`, entry !== undefined);
  check(`${action} is still called "${name}" on the collapsed row`, entry?.name === name);
  check(`${action} still builds something`, typeof entry?.render === "function");
}

check("no action is listed twice", new Set(IRREVERSIBLE.map(entry => entry.action)).size === IRREVERSIBLE.length);
check("no two entries share a name", new Set(IRREVERSIBLE.map(entry => entry.name)).size === IRREVERSIBLE.length);

// --- 2. The sentence the collapsed row actually renders -----------------------
//
// The count and the names are two claims made in one line of type, and both are read off
// IRREVERSIBLE now — so this rebuilds that line the way the view does and compares the
// whole string, rather than checking the pieces it was built from and calling it done.

console.log("\n2. the collapsed label");

const countPhrase = `${IRREVERSIBLE.length} action${IRREVERSIBLE.length === 1 ? "" : "s"} that cannot be undone`;
const namesLine = IRREVERSIBLE.map(entry => entry.name).join("  ·  ");

check(`the row reads "${countPhrase}"`, countPhrase === "3 actions that cannot be undone");
check(`the contents line reads "${namesLine}"`, namesLine === EXPECTED.map(([name]) => name).join("  ·  "));

// --- 3. The fold and the Pi's confirmation gates agree ------------------------
//
// The one assertion that spans the two files, and the reason this check is worth a
// process: nothing derives the fold's membership from the server.
//
// ⚠️ THE VOCABULARY IS READ OFF THE `case` LABELS of parseWriteRequest's own switch, by
// parsing the source — NOT off the English sentence in that switch's `default:` arm,
// which is what the first version did and which INVERTED the check (green when you were
// wrong, red when you were right; docs/diagnostics-and-checks.md §11.4). The `case`
// labels cannot drift from the dispatch because they ARE the dispatch, and the sentence
// is now checked against them (§3a) rather than trusted.
//
// Reading a sibling module's source is preferred here over exporting a list from
// src/http/vcu-write.ts: an exported list would be a second place the actions are
// written down — the parallel array this whole check exists to abolish.

console.log("\n3. the fold against the Pi's confirmation gates");

const NOW = Date.UTC(2026, 7, 19, 14, 3, 30);

const SERVER_SOURCE = await readFile(new URL("../src/http/vcu-write.ts", import.meta.url), "utf8");

/**
 * Every action parseWriteRequest dispatches on, read off its switch.
 *
 * Scoped to the one `switch (action) {` block so a `case` belonging to some later
 * switch cannot wander in, and asserted non-empty below — a regex that silently matched
 * nothing would take the polarity with it and put us back where we started.
 */
function serverActions(source: string): string[] {
  const start = source.indexOf("switch (action) {");
  const end = source.indexOf("\n}", start);
  if (start === -1 || end === -1) {
    return [];
  }
  // `[^"]+`, not `[a-z-]+`. A narrower class is the inversion coming back through a
  // smaller door: a label carrying a digit, capital or underscore would be invisible to
  // the parser, so a new confirm-gated action spelled `case "mode04-wipe":` would go
  // unseen and the check would pass while it sat in the open list. That is not a
  // hypothetical spelling in a file that says "OBD Mode 04" four times. Over-matching is
  // safe by construction — an action this finds but has no fixture for is already a hard
  // failure that names it.
  return [...source.slice(start, end).matchAll(/^\s*case "([^"]+)":/gm)].map(match => match[1]);
}

const accepted = serverActions(SERVER_SOURCE);

console.log(`\n3a. what parseWriteRequest dispatches on: ${accepted.join(", ")}`);

check("the switch was found and names at least the four actions this page uses", accepted.length >= 4);
check("no action is dispatched twice", new Set(accepted).size === accepted.length);

// The refusal for an unknown action is a sentence a person reads when something has
// gone wrong, and it lists the vocabulary. Checked against the switch rather than used
// as the source of it: an action added to the dispatch and left out of that sentence is
// a message that lies at exactly the moment it is being read.
const refusal = parseWriteRequest(new URLSearchParams({ action: "no-such-action" }), NOW);
const namedInProse = refusal.ok ? [] : (refusal.reason.match(/one of (.+?) — not/)?.[1] ?? "").split(", ");

const unsaid = accepted.filter(action => !namedInProse.includes(action));
const overSaid = namedInProse.filter(action => !accepted.includes(action));
check(
  unsaid.length === 0 && overSaid.length === 0
    ? `the default arm's sentence names every action the switch dispatches (${namedInProse.join(", ")})`
    : "the default arm's sentence has drifted from the switch — " +
        [
          unsaid.length > 0 ? `it does not name ${unsaid.join(", ")}` : "",
          overSaid.length > 0 ? `it still names ${overSaid.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(", and "),
  unsaid.length === 0 && overSaid.length === 0
);

/**
 * A request that is complete apart from `confirm=`, one per action.
 *
 * Hand-written, because "complete" means something different for each action and there
 * is nothing to derive it from. An action the server dispatches and this map has never
 * heard of is a HARD FAILURE below rather than a silent omission — that is the polarity
 * that matters: a new action stops the build and names itself, instead of quietly not
 * being asked about.
 */
const UNCONFIRMED: Record<string, URLSearchParams> = {
  parameter: new URLSearchParams({ action: "parameter", name: "MAX_DC_CHG_CURRENT", value: "80", expected: "75" }),
  bit: new URLSearchParams({
    action: "bit",
    name: "VSM_CONFIG_1",
    bit: "heated-handlebars",
    on: "1",
    expected: "4371",
  }),
  // Complete: one valid w=NAME:VALUE:EXPECTED triple (the batch is repeated `w=`). Like
  // parameter and bit it carries no confirm — it is many reversible parameter writes, not one
  // of the irreversible ones — so it parses OK here, never enters the gated set below, and
  // belongs out in the open rather than behind the fold.
  parameters: new URLSearchParams({ action: "parameters", w: "MAX_DC_CHG_CURRENT:80:75" }),
  "read-service-stamp": new URLSearchParams({ action: "read-service-stamp" }),
  "set-service-point": new URLSearchParams({ action: "set-service-point" }),
  "sync-clock": new URLSearchParams({ action: "sync-clock" }),
  "clear-dtcs": new URLSearchParams({ action: "clear-dtcs" }),
  // Complete: it carries the amps. Missing only the confirm, so the server refuses it
  // FOR the confirmation — which is what §3c reads off it.
  "charge-current": new URLSearchParams({ action: "charge-current", amps: "6" }),
  // Complete on its own — stop takes no fields. Missing only the confirm, so it too is
  // refused FOR the confirmation.
  "charge-stop": new URLSearchParams({ action: "charge-stop" }),
  // Complete on its own — reset takes no fields either. Refused only for the confirmation.
  "reset-vcu": new URLSearchParams({ action: "reset-vcu" }),
};

const unknown = accepted.filter(action => UNCONFIRMED[action] === undefined);
check(
  unknown.length === 0
    ? "every action the Pi dispatches has a fixture here"
    : `the Pi dispatches ${unknown.join(", ")}, which this check has never been told about — ` +
        "add a complete-but-unconfirmed request above, then decide whether it belongs behind the fold",
  unknown.length === 0
);
check(
  "and no fixture here names an action the Pi has dropped",
  Object.keys(UNCONFIRMED).every(action => accepted.includes(action))
);

// Whatever is still refused with a complete request and no `confirm=` is refused FOR the
// confirmation and nothing else. That is the definition of "destructive" this page paints
// red, taken from the server rather than from a list here.
//
// ⚠️ Only actions with a fixture are compared below. An action with none has not been
// ASKED, and a bare request for it would be refused for whichever parameter it is missing
// — indistinguishable from a confirmation gate without reading the refusal's prose, which
// is the mistake this section already made once. So an unfixtured action is reported by
// the hard failure above, which names it and says what to do, and is not silently
// assigned a verdict here that neither direction of the comparison could justify.
const probed = accepted.filter(action => UNCONFIRMED[action] !== undefined);
const gated = probed.filter(action => !parseWriteRequest(UNCONFIRMED[action], NOW).ok);

console.log(`\n3b. the Pi refuses ${gated.length} of those without a confirmation: ${gated.join(", ")}`);

// Widened to string on purpose. The other side of every comparison below is a name read
// out of the server's source at run time, so keeping the union here would only let tsc
// pre-agree with the thing this check exists to test.
const behindTheFold: string[] = IRREVERSIBLE.map(entry => entry.action);

// ⚠️ THE THIRD CATEGORY, added when charge-current arrived: confirm-gated but REVERSIBLE.
//
// The fold's promise is "cannot be undone", and until now that was the same set as "needs
// a confirm=". charge-current breaks the tie. It is gated because `curl` can reach the
// endpoint and a page showing 6 A must not be able to POST 30 — the number is the owner's
// to say out loud — but it undoes itself: the setpoint is transient (unplugging the
// charger clears it), the VCU clamps anything above the cable's ceiling, and the rider
// overrides it on the bike's own screen. Behind a fold that says "cannot be undone" that
// row would lie, so the control lives in the charge menu, not the red drawer.
//
// This set is the ONE place that exemption is written down, and adding to it is the same
// weight of decision as adding to the fold: an action here is one a reviewer has agreed is
// reversible. An action that is confirm-gated, absent from the fold AND absent here is
// still the hard failure §3b was built to catch — the exemption is explicit, never a gap.
// charge-stop joins for the same reason: it is confirm-gated (curl can reach the endpoint, so a
// deliberate word is required), but ending a charge undoes itself — the rider simply re-plugs or
// restarts the charge on the bike's own screen. Behind a "cannot be undone" fold that row would lie.
// reset-vcu joins too: it is confirm-gated (curl can reach it, and it drops the bike off the bus), but
// a key-cycle restart erases nothing and reverts nothing — the bike reboots and comes back exactly as
// it was. Behind a "cannot be undone" fold that row would lie, so it lives out in the open like the two above.
const REVERSIBLE_CONFIRMED = new Set(["charge-current", "charge-stop", "reset-vcu"]);

const gatedNotHidden = gated.filter(action => !behindTheFold.includes(action) && !REVERSIBLE_CONFIRMED.has(action));
check(
  gatedNotHidden.length === 0
    ? "every action the Pi confirm-gates is behind the fold or named reversible"
    : `the Pi confirm-gates ${gatedNotHidden.join(", ")}, which the fold does not hold and REVERSIBLE_CONFIRMED does not name — ` +
        "a destructive control is sitting in the open list with the read-only ones",
  gatedNotHidden.length === 0
);

const hiddenNotGated = behindTheFold.filter(action => probed.includes(action) && !gated.includes(action));
check(
  hiddenNotGated.length === 0
    ? "and every action behind the fold is one the Pi confirm-gates — nothing merely scary is hidden there"
    : `the fold holds ${hiddenNotGated.join(", ")}, which the Pi performs on one request`,
  hiddenNotGated.length === 0
);

// The other direction of the same fact, and the one that keeps the read-only action
// OUTSIDE the drawer where it belongs: it is the one you want BEFORE the service point
// overwrites what it shows you, so hiding it behind the same fold would be a real cost.
check(
  "read-service-stamp needs no confirmation and is NOT behind the fold",
  parseWriteRequest(UNCONFIRMED["read-service-stamp"], NOW).ok && !behindTheFold.includes("read-service-stamp")
);

// --- 3c. The reversible-confirmed actions earn their exemption -----------------
//
// The exemption above is only honest if each action it names is actually gated (so it is
// not smuggling an ungated write past §3b), actually out of the fold (so the drawer's
// count stays true), and actually accepted once the confirmation the owner's page will
// send is attached. The confirm token is charge-current-<amps>, built here inline only
// because the charge-menu control that will send it does not exist yet — when it does,
// this should call that builder the way §4 calls confirmationFor, not restate the format.

console.log("\n3c. confirm-gated but reversible, so out in the open on purpose");

for (const action of REVERSIBLE_CONFIRMED) {
  check(`${action} has a fixture to reason about`, UNCONFIRMED[action] !== undefined);
  check(`${action} is confirm-gated — refused without confirm=`, gated.includes(action));
  check(`${action} is NOT behind the fold`, !behindTheFold.includes(action));
}

const chargeConfirmed = new URLSearchParams(UNCONFIRMED["charge-current"]);
chargeConfirmed.set("confirm", `charge-current-${chargeConfirmed.get("amps")}`);
const chargeAnswer = parseWriteRequest(chargeConfirmed, NOW);
check(
  chargeAnswer.ok
    ? "charge-current is accepted with confirm=charge-current-<amps>"
    : `charge-current is REFUSED with its own confirmation — ${chargeAnswer.reason}`,
  chargeAnswer.ok
);

const stopConfirmed = new URLSearchParams(UNCONFIRMED["charge-stop"]);
stopConfirmed.set("confirm", "charge-stop");
const stopAnswer = parseWriteRequest(stopConfirmed, NOW);
check(
  stopAnswer.ok
    ? "charge-stop is accepted with confirm=charge-stop"
    : `charge-stop is REFUSED with its own confirmation — ${stopAnswer.reason}`,
  stopAnswer.ok
);

const resetConfirmed = new URLSearchParams(UNCONFIRMED["reset-vcu"]);
resetConfirmed.set("confirm", "reset-vcu");
const resetAnswer = parseWriteRequest(resetConfirmed, NOW);
check(
  resetAnswer.ok
    ? "reset-vcu is accepted with confirm=reset-vcu"
    : `reset-vcu is REFUSED with its own confirmation — ${resetAnswer.reason}`,
  resetAnswer.ok
);

// --- 4. The confirmations the page really sends ------------------------------
//
// ⚠️ Called, not copied. `confirmationFor` is the single site the page builds `confirm=`
// from — both `performAction` call sites go through it — so changing what the page sends
// changes what is tested here in the same edit. A table of expected strings in this file
// would be exactly the parallel array §1 exists to abolish, and it would stay green
// while `31 FC` and Mode 04 were refused with a 400 on every press.
//
// The clock is fed the Pi's own displayed `clock.iso`, since its confirmation is the
// minute it showed rather than its own name; utcMinute is the server's formatter for
// the same instant, so agreement here is the two halves of that handshake meeting.

console.log("\n4. the confirmation the page sends against the one the Pi wants");

for (const action of behindTheFold.filter(candidate => probed.includes(candidate))) {
  const params = new URLSearchParams(UNCONFIRMED[action]);
  params.set("confirm", confirmationFor(action, new Date(NOW).toISOString()));
  const answer = parseWriteRequest(params, NOW);
  check(
    answer.ok
      ? `${action} is accepted with the confirmation the page sends`
      : `${action} is REFUSED with the confirmation the page sends — ${answer.reason}`,
    answer.ok
  );
}

check(
  "the clock's confirmation is the minute the Pi formats",
  confirmationFor("sync-clock", new Date(NOW).toISOString()) === utcMinute(NOW)
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fold names what it holds, and holds exactly what the Pi refuses without a confirmation");
}
