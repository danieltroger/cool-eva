import { DEFAULT_TAB, TABS, hashForTab, nextTabAfter, tabFromHash } from "../public/lib/router.js";

// The dashboard's tab URLs, checked without a browser.
//
//   node --experimental-strip-types scripts/check-tab-routing.ts
//
// public/lib/router.js puts the bottom tab bar in the URL, and splits itself so the
// parts worth checking need no DOM: hashForTab / tabFromHash / nextTabAfter are pure,
// and only showTab() and startRouting() touch `history` and `location`. That is the
// whole reason this file can exist alongside the other checks — no jsdom, no headless
// browser, no dependency. (VanJS itself imports fine under Node; the router's state
// lives in a van.state and nothing here reads it.)
//
// ## What this is guarding
//
// **A tab's name is a URL.** `/#charge` is what a bookmark on the phone's home screen
// holds, and what a link sent to somebody else holds. Renaming a tab in TABS silently
// breaks every one of them, and nothing else in the repo would notice: the dashboard
// would still build, still typecheck and still work perfectly for anyone who opened it
// fresh. So the names are pinned here by hand, spelled out rather than derived from
// TABS, which is what makes changing one a decision rather than an accident.
//
// **A URL that names nothing must still open something.** tabFromHash runs before the
// first render, so anything it threw on would be a blank screen rather than a wrong
// one — a bookmark with a stray `%` in it must land on the riding screen, not on
// nothing at all. Half the cases below are malformed on purpose.
//
// **The ring must close.** Three flashes of the high beam advance one tab, and that
// gesture is the only input this dashboard has that works with both hands on the bars.
// A ring that skipped or stuck would make it useless.

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
  ["all", "#all"],
  ["faults", "#faults"],
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

// --- 3. The high-beam ring ---------------------------------------------------

console.log("\n3. the ring the high-beam gesture rides on");

let walked: (typeof TABS)[number]["name"] = TABS[0].name;
const visited: string[] = [walked];
for (let step = 1; step < TABS.length; step += 1) {
  walked = nextTabAfter(walked);
  visited.push(walked);
}

check(
  `${TABS.length} advances from ${TABS[0].name} visit every tab exactly once`,
  new Set(visited).size === TABS.length && visited.every((name, index) => name === TABS[index].name)
);
check(`one more comes back to ${TABS[0].name}`, nextTabAfter(walked) === TABS[0].name);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ tab URLs, their fallbacks and the tab ring all hold");
}
