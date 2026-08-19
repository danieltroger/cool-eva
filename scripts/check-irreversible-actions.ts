import { IRREVERSIBLE } from "../public/views/vcu-write.js";
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
// ## What this is guarding
//
// **The fold makes a promise about what is inside it, to somebody standing at a bike.**
// Collapsed, all it shows is a count and three short names — "3 actions that cannot be
// undone / Service stamp · Bike clock · Clear codes" — and that line is what a rider
// reads to decide whether to open the drawer at all. Behind it are `31 FC` (which stamps
// a service point on the bike's own clock and odometer, with no unset), OBD Mode 04
// (which takes the freeze frame with the codes) and a clock write that cannot be read
// back. A drawer that names the wrong three, or says three and holds four, is worse than
// one that names nothing.
//
// Both halves of that used to be able to drift. The count was derived, but the names
// were a second hand-written array kept alongside, and the guard between them compared
// their LENGTHS — so reordering the list or swapping one action for another left the
// label wrong and the guard green. And it reported by `console.warn`, on a page whose
// entire deployment target is a phone clamped to a handlebar, where nobody has a console
// open, ever. The names are now read off the list itself, so that class of drift is
// gone; what remains is what no data structure can enforce, and it is what is below.
//
// **The fold must hold exactly the actions the Pi refuses without a confirmation.**
// That is the real invariant, and it spans two files that cannot see each other:
// src/http/vcu-write.ts decides which actions are dangerous enough to demand
// `confirm=`, and public/views/vcu-write.js decides which ones a thumb has to open a
// drawer to reach. A fourth confirm-gated action added to the Pi and not put behind the
// fold is a destructive control sitting in the open list with the read-only ones — the
// exact state this PR existed to end — and nothing else in the repo would notice.
//
// So §3 does not take a list of dangerous actions on trust. It asks the server which
// actions it accepts at all (its own refusal names them), then asks it of each one
// whether a complete request is still refused with no `confirm=`, and compares that set
// against the fold. Adding an action to either side alone fails this check.

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
// process. Nothing derives the fold's membership from the server, so this is where the
// two are made to answer the same question.
//
// The server's own refusal for an unknown action names every action it accepts, so the
// list below is read out of src/http/vcu-write.ts rather than copied from it. Each one
// is then offered a request that is COMPLETE except for `confirm=`: whatever is still
// refused at that point is refused for the confirmation and nothing else, and that is
// the definition of "destructive" this page is painting red.

console.log("\n3. the fold against the Pi's confirmation gates");

const NOW = Date.UTC(2026, 7, 19, 14, 3, 30);

/**
 * A request that is complete apart from `confirm=`. Hand-written, because "complete"
 * means something different for each action and there is nothing to derive it from —
 * but a wrong one here fails loudly below rather than passing quietly, since an action
 * refused for a MISSING NAME would be misread as confirm-gated and would then have to be
 * behind the fold to pass §3b.
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
  "read-service-stamp": new URLSearchParams({ action: "read-service-stamp" }),
  "set-service-point": new URLSearchParams({ action: "set-service-point" }),
  "sync-clock": new URLSearchParams({ action: "sync-clock" }),
  "clear-dtcs": new URLSearchParams({ action: "clear-dtcs" }),
};

/** The confirmation each gated action's page really sends. See ActionButton / ClockAction. */
const CONFIRMATION: Record<string, string> = {
  "set-service-point": "set-service-point",
  "clear-dtcs": "clear-dtcs",
  "sync-clock": utcMinute(NOW),
};

// The server names its own vocabulary when it refuses something it has never heard of:
// "action must be one of parameter, bit, read-service-stamp, set-service-point,
// sync-clock, clear-dtcs — not …". Parsed rather than copied, so an action added to the
// Pi arrives here on its own.
const refusal = parseWriteRequest(new URLSearchParams({ action: "no-such-action" }), NOW);
const named = refusal.ok ? [] : (refusal.reason.match(/one of (.+?) — not/)?.[1] ?? "").split(", ").filter(Boolean);

check("the server's refusal still names the actions it accepts", named.length > 0);
check(
  `every action the server names has a fixture here (${named.join(", ")})`,
  named.every(action => UNCONFIRMED[action] !== undefined)
);
check(
  "and no fixture here names an action the server has dropped",
  Object.keys(UNCONFIRMED).every(action => named.includes(action))
);

const gated = named.filter(action => {
  const params = UNCONFIRMED[action];
  return params !== undefined && !parseWriteRequest(params, NOW).ok;
});

console.log(`\n3b. the server refuses ${gated.length} actions without a confirmation: ${gated.join(", ")}`);

// Widened to string on purpose. The other side of every comparison below is a name
// PARSED out of the server's refusal at runtime, so keeping the union here would only
// let tsc pre-agree with the thing this check exists to test at run time.
const behindTheFold: string[] = IRREVERSIBLE.map(entry => entry.action);

check(
  "every action the Pi confirm-gates is behind the fold",
  gated.every(action => behindTheFold.includes(action))
);
check(
  "and every action behind the fold is one the Pi confirm-gates — nothing merely scary is hidden there",
  behindTheFold.every(action => gated.includes(action))
);

// The other direction of the same fact, and the one that keeps the read-only action
// OUTSIDE the drawer where it belongs: it is the one you want BEFORE the service point
// overwrites what it shows you, so hiding it behind the same fold would be a real cost.
check(
  "read-service-stamp needs no confirmation and is NOT behind the fold",
  parseWriteRequest(UNCONFIRMED["read-service-stamp"], NOW).ok && !behindTheFold.includes("read-service-stamp")
);

// And that the confirmations the page sends are the ones the Pi wants. The captions are
// prose and may be rewritten freely; these strings are protocol and may not.
for (const action of behindTheFold) {
  const params = new URLSearchParams(UNCONFIRMED[action]);
  params.set("confirm", CONFIRMATION[action] ?? "");
  check(`${action} is accepted with the confirmation the page sends`, parseWriteRequest(params, NOW).ok);
}

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fold names what it holds, and holds exactly what the Pi refuses without a confirmation");
}
