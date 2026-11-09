import {
  DEFAULT_TAB,
  TABS,
  ROUTES,
  RIDING_CYCLE,
  canonicalHash,
  hashForTab,
  nextViewAfter,
  tabFromHash,
} from "../public/lib/router.js";

// Bookmark compatibility and the five-stop handlebar cycle: docs/dashboard-navigation.md.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. The URLs themselves --------------------------------------------------
//
// Written out, in bar order. This list is the contract with every bookmark ever taken.

const EXPECTED_URLS: [name: string, url: string][] = [
  ["ride", "#ride"],
  ["hypermile", "#hypermile"],
  ["charge", "#charge"],
  ["faults", "#faults"],
  ["more", "#more"],
];

console.log("\n1. the tab URLs");

check(
  `the bar has exactly ${EXPECTED_URLS.length} tabs, in order`,
  TABS.length === EXPECTED_URLS.length && TABS.every((tab, index) => tab.name === EXPECTED_URLS[index][0])
);

for (const [name, url] of EXPECTED_URLS) {
  const tab = TABS.find(candidate => candidate.name === name);
  check(`${name} is still a tab`, tab !== undefined);
  if (!tab) {
    continue;
  }
  check(`${name} lives at ${url}`, hashForTab(tab.name) === url);
  check(`${url} opens ${name} again`, tabFromHash(url) === tab.name);
}

// --- 2. Where an unknown URL lands -------------------------------------------

console.log("\n2. URLs that name no tab");

check(
  `the default tab (${DEFAULT_TAB}) is a real tab`,
  TABS.some(tab => tab.name === DEFAULT_TAB)
);

// The caller pattern: `tabFromHash(location.hash) ?? DEFAULT_TAB`. Answering null is
// how this function says "you decide", so null is what each of these must produce.
const NAMES_NOTHING = [
  ["", "the bare entry URL — `/`, which is the PWA's start_url"],
  ["#", "an empty fragment"],
  ["#nope", "a tab that has never existed"],
  ["#RIDE-old", "a plausible-looking legacy name"],
  ["#%zz", "a malformed percent escape, which must not throw"],
  ["#ride?live=1", "a tab name with a query glued on"],
  ["#ride/", "a tab name with a trailing slash"],
  ["#ride#charge", "two fragments"],
  ["# ride", "a leading space"],
  ["#../../etc/passwd", "a path where a tab name should be"],
];

for (const [hash, description] of NAMES_NOTHING) {
  let answered: unknown = "threw";
  try {
    answered = tabFromHash(hash);
  } catch {
    // Left as "threw", which fails below and says so.
  }
  check(`${JSON.stringify(hash)} names no tab — ${description}`, answered === null);
}

// Case is the one thing forgiven, because a URL typed by hand or mangled by a link
// preview should still land where it says.
check("#Charge opens charge — case is forgiven", tabFromHash("#Charge") === "charge");
check("#CHARGE opens charge", tabFromHash("#CHARGE") === "charge");

// --- 3. What the URL gets rewritten to ---------------------------------------
//
// canonicalHash() is the rule showTabFromUrl() follows on arrival and on every Back
// press. Two halves, and both matter: a URL that says nothing useful must be corrected
// rather than left lying, and a URL that already says the right thing must be left
// alone — Back through ten tabs must not spend ten replaceState calls out of Safari's
// throttle bucket restating what the address bar already said.

console.log("\n3. rewriting the URL");

for (const tab of TABS) {
  const { tab: landing, rewriteTo } = canonicalHash(hashForTab(tab.name));
  check(`${hashForTab(tab.name)} is already canonical — no rewrite`, landing === tab.name && rewriteTo === null);
}

const REWRITES: [hash: string, expected: string, why: string][] = [
  ["", "#ride", "the bare entry URL becomes a link worth sharing"],
  ["#", "#ride", "an empty fragment"],
  ["#nope", "#ride", "a tab that has never existed stops claiming to be a screen"],
  ["#Charge", "#charge", "case is forgiven, then normalised away"],
  ["#%zz", "#ride", "a malformed escape"],
];

for (const [hash, expected, why] of REWRITES) {
  const { tab: landing, rewriteTo } = canonicalHash(hash);
  check(
    `${JSON.stringify(hash)} → ${expected} on ${landing} — ${why}`,
    rewriteTo === expected && hashForTab(landing) === expected
  );
}

// The property behind both halves: whatever comes out is canonical, and running the
// rule again changes nothing. showTabFromUrl() is called from two events that can both
// fire for one hash change, so a rule that was not idempotent would rewrite twice.
const EVERY_HASH_TRIED = new Set([
  ...TABS.map(tab => hashForTab(tab.name)),
  ...REWRITES.map(([hash]) => hash),
  ...NAMES_NOTHING.map(([hash]) => hash),
]);

for (const hash of EVERY_HASH_TRIED) {
  const once = canonicalHash(hash);
  const twice = canonicalHash(once.rewriteTo ?? hash);
  check(`${JSON.stringify(hash)} settles in one rewrite`, twice.rewriteTo === null && twice.tab === once.tab);
}

// --- 3b. Did the fragment NAME its tab, or only land on it? ------------------
//
// `named` is what app.js spends to decide whether the bike may overrule the screen the
// page opened on: a link that asked for Faults keeps it through the first readings,
// while the bare entry URL is left to the bike exactly as it always was. So the line
// between the two is behaviour, not bookkeeping.
//
// It is independent of `rewriteTo`, which is the part easy to get wrong: `#Charge`
// names its tab *and* wants rewriting, so deriving one from the other would quietly
// hand the bike a link that did ask for a screen.

console.log("\n3b. which fragments count as asking for a tab");

for (const tab of TABS) {
  check(`${hashForTab(tab.name)} asks for ${tab.name}`, canonicalHash(hashForTab(tab.name)).named);
}
check("#Charge asks for charge even though it is rewritten", canonicalHash("#Charge").named);

for (const [hash, description] of NAMES_NOTHING) {
  check(`${JSON.stringify(hash)} asks for nothing — ${description}`, canonicalHash(hash).named === false);
}

// --- 4. The high-beam ring ---------------------------------------------------

console.log("\n4. the ring the high-beam gesture rides on");

let walked: (typeof ROUTES)[number]["name"] = ROUTES[0].name;
const visited: string[] = [walked];
for (let step = 1; step < RIDING_CYCLE.length; step += 1) {
  walked = nextViewAfter(walked);
  visited.push(walked);
}

check(
  `${RIDING_CYCLE.length} advances from ${ROUTES[0].name} visit every view exactly once`,
  new Set(visited).size === RIDING_CYCLE.length && visited.join(",") === "ride,cooling,hypermile,charge,faults"
);
check(`one more comes back to ${ROUTES[0].name}`, nextViewAfter(walked) === ROUTES[0].name);
check(
  "Cooling has a pinned subview bookmark",
  canonicalHash("#ride/cooling").view === "cooling" && canonicalHash("#ride/cooling").rewriteTo === null
);

check(
  "Cells has a pinned subview bookmark",
  canonicalHash("#hypermile/cells").view === "cells" &&
    canonicalHash("#hypermile/cells").tab === "hypermile" &&
    canonicalHash("#hypermile/cells").rewriteTo === null
);
for (const hash of ["#charge/pack-cooling", "#charge/controls"]) {
  check(
    `${hash} restores the single Charge page`,
    canonicalHash(hash).view === "charge" && canonicalHash(hash).rewriteTo === "#charge"
  );
}
check(
  "Cells advances to Charge, outside the five-stop cycle",
  nextViewAfter("cells") === "charge" && RIDING_CYCLE.length === 5
);
check(
  "Fault report is a pinned Faults subview and advances to Ride",
  canonicalHash("#faults/report").view === "faults" &&
    canonicalHash("#faults/report").tab === "faults" &&
    canonicalHash("#faults/report").rewriteTo === "#faults" &&
    nextViewAfter("faults") === "ride"
);
check(
  "Legacy All bookmark opens inside More",
  canonicalHash("#all").view === "all" && canonicalHash("#all").tab === "more"
);
check(
  "The handlebar cycle excludes More",
  !RIDING_CYCLE.some(view => String(view) === "more") && nextViewAfter("more") === "ride"
);
console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ tab URLs, their fallbacks and the tab ring all hold");
}
