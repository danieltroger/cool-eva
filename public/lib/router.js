// @ts-check

import van from "../vendor/van-1.6.1.js";

// The tab bar, in the URL.
//
// Until this existed the tab lived in a module-level state and nowhere else, so the
// phone's Back button had nothing to walk back through: it left the dashboard from
// whichever screen you were on, which on a bike is the one moment you are least able
// to find your way back.
//
// ## Why the hash rather than a path
//
// `/#charge`, not `/charge`. The server answers from a Map keyed by URL path
// (src/http/static.ts) and src/index.ts replies 404 to anything that is not a file in
// it, so `/charge` would be `not found` in plain text — a deep link, a bookmark and a
// reload would all miss the dashboard entirely. Path routing therefore needs a
// fallback route added to the server, and that is not free here: `/dl`, `/status`,
// `/waypoint`, `/dtc-table`, `/fault-infokeys`, `/stored-dtcs`, `/vcu-params`,
// `/vcu-read`, `/vcu-probe`, `/vcu-write` and `/vcu-backup.csv` are all real endpoints
// at the root, so the fallback would be a rule with eleven exceptions that a future
// tab name could silently collide with.
//
// The hash costs the server nothing. `/#charge` *is* a request for `/` — the fragment
// never leaves the browser — so deep links, bookmarks and reloads work against the Pi
// exactly as it is deployed today, with no service restart and no way for a tab to
// shadow an endpoint.
//
// ## What Back does
//
// Every tab change is a pushState, so Back returns to the tab you were looking at
// before. Note what that means when you flip between two screens: ride → charge →
// ride leaves two entries behind and Back walks back through both, rather than
// collapsing the repeat visit onto its earlier entry. That is deliberate. Collapsing
// would make Back skip screens you really did look at — you glance at Charge from
// Ride, glance back, press Back and land somewhere you have not been in ten minutes —
// and that is the version that feels broken. The depth of the stack costs nothing to
// escape either: leaving a web app on a phone is the app switcher or closing the tab,
// one gesture however deep it goes.
//
// The one thing that is not a navigation is re-tapping the tab you are already on, and
// showTab() drops that rather than stacking an entry that Back cannot tell from a real
// one.
//
// ## A switch the rider did not ask for pushes too
//
// autoFocus() in app.js moves the tab when the bike's state changes — plugging in,
// the pack going critical. It would be reasonable to think those should replaceState
// rather than pushState, on the grounds that the rider did not choose them. They push,
// and the reason is what replaceState would actually do.
//
// You are reading Faults, having gone ride → faults. The bike starts charging.
//
//   push:     ride, faults, charge   →  Back returns you to Faults, then Ride.
//   replace:  ride, charge           →  Back returns you to Ride. Faults is GONE.
//
// replaceState does not decline to add an entry; it OVERWRITES the entry the rider
// made. So the "the rider did not choose this" instinct, followed honestly, argues
// for pushing: an action the rider did not choose should be undoable, and must not
// destroy one they did. Pushing gives both, replacing gives neither.
//
// It also keeps Back meaning one thing. Push for a tap and replace for the bike would
// make Back sometimes step back a screen and sometimes skip one, with the difference
// turning on something the rider cannot see.
//
// This matters more since #72 than it did before it: autoFocus now fires on a DC fast
// charge, which it never used to, because the BMS reports Idle throughout one. A rapid
// charger is exactly where the rider is most likely to be part-way through reading
// something else when the screen is taken away from them.
//
// ## What is deliberately not routed
//
// The sheet behind the ☰ button is not a tab and does not get a URL. It is a control
// panel over whatever screen you were on, half of it fetches when it opens, and a
// shared link that reopened it would show one section's stale numbers next to
// another's. If Back should close it, that is its own change, in views/sheet.js.

/**
 * The bottom tab bar, in order — and, since this module exists, the routing table
 * too. A tab's `name` is its URL: renaming one breaks every bookmark that pointed at
 * it, which is what scripts/check-tab-routing.ts pins down.
 */
export const TABS = /** @type {const} */ ([
  { name: "ride", label: "Ride" },
  { name: "hypermile", label: "Hypermile" },
  { name: "charge", label: "Charge" },
  { name: "all", label: "All" },
  { name: "faults", label: "Faults" },
]);

/** @typedef {(typeof TABS)[number]["name"]} TabName */

/**
 * Where a URL that names no tab lands, and where one that names something unknown
 * lands too. The riding screen, because that is what the bare entry URL — the PWA's
 * `start_url`, and every bookmark taken before tabs were in the URL at all — has
 * always opened.
 */
export const DEFAULT_TAB = /** @type {TabName} */ ("ride");

/**
 * The tab on screen.
 *
 * Deliberately not exported, which leaves exactly two writers, both in this file:
 * showTab(), which moves the tab and the URL together, and showTabFromUrl(), which
 * follows a URL the browser has already moved. Nothing outside can set one without the
 * other, so "the screen and the URL agree" holds by construction rather than by
 * everyone remembering. Read it through currentTab() or peekTab() below.
 */
const tab = van.state(DEFAULT_TAB);

/**
 * The tab on screen. Calling this inside a binding subscribes that binding to tab
 * changes, which for a binding that draws the current view is exactly right.
 */
export function currentTab() {
  return tab.val;
}

/**
 * The same, without subscribing — the peek() of this module, and for the same reason
 * (see public/lib/store.js). app.js's rules run inside the chartTick timer and inside
 * the high-beam binding; reading `.val` from either would add the tab to that
 * binding's dependencies and re-run it on every tab change, which is precisely the
 * silent re-pacing CLAUDE.md warns about.
 */
export function peekTab() {
  return tab.rawVal;
}

/**
 * Show a tab, and leave a history entry behind so Back comes back to where you were.
 *
 * **This is the way to change tabs from anywhere** — a tap on the bar, a gesture on
 * the bars, or the bike deciding for you. It is safe to call from inside a VanJS
 * binding: it samples the current tab rather than subscribing to it.
 *
 * @param {TabName} name
 */
export function showTab(name) {
  // rawVal, not val: this is reachable from inside bindings (see peekTab).
  if (name === tab.rawVal) {
    // Re-tapping the tab you are on is not a navigation, and an entry for it would be
    // a Back press that appears to do nothing.
    return;
  }
  try {
    history.pushState(null, "", hashForTab(name));
  } catch (error) {
    // Safari refuses more than about a hundred pushState calls in thirty seconds. No
    // hand can tap that fast, but this is reachable from a handlebar gesture, and a
    // switch that is bounced by a rough road can be. A refused history entry must cost
    // the URL and nothing else — never the screen the rider asked for.
    console.warn("router: could not add a history entry", error);
  }
  tab.val = name;
}

/**
 * Move one tab along, wrapping at the end. What the high-beam gesture does, and the
 * other half of what a handlebar gesture might want from this module.
 */
export function advanceTab() {
  showTab(nextTabAfter(tab.rawVal));
}

/**
 * Point the app at the URL, and keep the two in step from here on.
 *
 * Call this before the first render: it sets the tab, so a deep link draws its own
 * screen once rather than drawing the riding screen and then replacing it.
 *
 * Answers whether the URL actually named a tab, as opposed to being the bare entry
 * URL or naming something this app does not have. That is the difference between "the
 * rider asked for this screen" and "nobody said", which app.js needs in order to know
 * whether the bike may overrule the screen it opened on.
 *
 * @returns {boolean}
 */
export function startRouting() {
  const named = showTabFromUrl();
  // Two listeners, because these are two different events and browsers disagree about
  // which of them a fragment change deserves. `popstate` is the history cursor moving:
  // Back, Forward, and the edge-swipe that stands in for both in an iOS home-screen
  // app. `hashchange` is the fragment changing by any other route — a URL edited by
  // hand, or a link to #charge from another page of this app. Chrome sends both for
  // that second case; Safari has never been relied upon to.
  //
  // Neither event is sent for our own pushState or replaceState, which is what makes
  // listening for both safe rather than circular — and showTabFromUrl() landing on the
  // tab that is already up is a no-op regardless, so the overlap costs nothing.
  addEventListener("popstate", showTabFromUrl);
  addEventListener("hashchange", showTabFromUrl);
  return named;
}

/**
 * Point the screen at whatever the URL says now, and make the URL say something this
 * app actually has. The only place here that reads `location`; the rule it acts on is
 * canonicalHash() below, where it can be checked without a browser.
 *
 * @returns {boolean} whether the fragment named a tab, rather than falling back to one.
 */
function showTabFromUrl() {
  const { tab: landing, rewriteTo, named } = canonicalHash(location.hash);
  if (rewriteTo !== null) {
    try {
      history.replaceState(null, "", rewriteTo);
    } catch (error) {
      // The same throttle showTab() guards against, sharing the same bucket — and
      // unguarded it would cost more here than there. startRouting() runs before the
      // first van.add(), so a throw would abort module evaluation and leave a blank
      // dashboard rather than a wrong tab; and on a popstate it would skip the tab
      // write below, leaving the screen and the URL disagreeing, which is the one
      // thing this module is built not to allow.
      console.warn("router: could not rewrite the URL to", rewriteTo, error);
    }
  }
  tab.val = landing;
  return named;
}

/**
 * What to do about a fragment: the tab it lands on, what the URL should be rewritten
 * to — null when it already says the right thing — and whether the fragment named that
 * tab or merely fell back to it.
 *
 * The three are independent. `#Charge` names a tab *and* wants rewriting; `#ride` names
 * one and does not; `#nope` names none and wants rewriting; `#ride` after a Back press
 * is all three settled already.
 *
 * Pure, so the rule can be checked without a browser; the same split as
 * headroomMvWith() in lib/derive.js, and for the same reason.
 *
 * Rewriting is what stops `/` from being a link nobody can share and stops a fragment
 * naming a tab this app does not have from going on claiming to be a screen it is not.
 * Rewriting only when it would change something matters as much: showTabFromUrl() runs
 * on every popstate, and Back through ten tabs must not spend ten replaceState calls
 * out of Safari's bucket restating what the URL already said.
 *
 * Note there is no pushState here or anywhere it is called from. Arriving is not
 * navigating away from somewhere, and on a popstate the browser has already moved the
 * cursor — pushing would strand it and turn one Back press into two.
 *
 * @param {string} hash
 * @returns {{ tab: TabName, rewriteTo: string | null, named: boolean }}
 */
export function canonicalHash(hash) {
  const named = tabFromHash(hash);
  const landing = named ?? DEFAULT_TAB;
  const wanted = hashForTab(landing);
  return { tab: landing, rewriteTo: hash === wanted ? null : wanted, named: named !== null };
}

/**
 * The URL fragment for a tab, `#` included — the whole of what this app puts in a URL.
 * @param {TabName} name
 */
export function hashForTab(name) {
  return `#${name}`;
}

/**
 * The tab a fragment names, or null when it names nothing this app has.
 *
 * Total, and deliberately so: this runs before the first render, so anything it threw
 * on would be a blank screen rather than a wrong one. Hence no decodeURIComponent —
 * tab names are plain lowercase words that need no escaping, and a bookmark carrying a
 * stray `%` would only be a way for a malformed URL to take the dashboard down.
 *
 * @param {string} hash
 * @returns {TabName | null}
 */
export function tabFromHash(hash) {
  const name = hash.replace(/^#/, "").toLowerCase();
  return TABS.some(candidate => candidate.name === name) ? /** @type {TabName} */ (name) : null;
}

/**
 * The tab after this one, wrapping. Pure, so the ring the high-beam gesture rides on
 * can be checked without a browser.
 *
 * A name that is not in the bar answers with the first tab: findIndex returns -1 and
 * the wrap turns that into 0. That cannot happen through TabName, but it is the right
 * answer if it ever does.
 *
 * @param {TabName} name
 * @returns {TabName}
 */
export function nextTabAfter(name) {
  const index = TABS.findIndex(candidate => candidate.name === name);
  return TABS[(index + 1) % TABS.length].name;
}
