// @ts-check

import van from "../vendor/van-1.6.1.js";
import { armed } from "./arming.js";

// The tab bar, in the URL, so the phone's Back button has something to walk back
// through instead of leaving the dashboard from whichever screen you were on.
//
// `/#charge`, not `/charge`: the hash never leaves the browser, so a deep link, a
// bookmark and a reload all work against the Pi exactly as deployed. A path would need
// a server fallback with eleven exceptions, one per real endpoint at the root.
//
// Every tab change is a pushState — including the ones the bike makes for you, which
// is the decision most likely to look wrong: replaceState would OVERWRITE the entry the
// rider made rather than decline to add one. The sheet behind ☰ is deliberately not
// routed.
//
// The full argument for each of those, and for what Back does across a repeat visit:
// docs/dashboard-decisions.md §Routing.

/** Bookmark names are pinned by check-tab-routing.ts; rationale: docs/dashboard-routing.md. */
export const TABS = /** @type {const} */ ([
  { name: "ride", label: "Ride" },
  { name: "hypermile", label: "Range" },
  { name: "charge", label: "Charge" },
  { name: "all", label: "All" },
  { name: "faults", label: "Faults" },
]);

/** @typedef {(typeof TABS)[number]["name"]} TabName */

export const ROUTES = /** @type {const} */ ([
  { name: "ride", tab: "ride", label: "Ride", hash: "#ride" },
  { name: "cooling", tab: "ride", label: "Cooling", hash: "#ride/cooling" },
  { name: "hypermile", tab: "hypermile", label: "Range", hash: "#hypermile" },
  { name: "cells", tab: "hypermile", label: "Cells", hash: "#hypermile/cells" },
  { name: "charge", tab: "charge", label: "Charge", hash: "#charge" },
  { name: "charge-pack", tab: "charge", label: "Pack & cooling", hash: "#charge/pack-cooling" },
  { name: "charge-controls", tab: "charge", label: "Controls", hash: "#charge/controls" },
  { name: "all", tab: "all", label: "All", hash: "#all" },
  { name: "faults", tab: "faults", label: "Faults", hash: "#faults" },
  { name: "fault-report", tab: "faults", label: "Fault report", hash: "#faults/report" },
]);
/** @typedef {(typeof ROUTES)[number]["name"]} ViewName */

export const RIDING_CYCLE = /** @type {const} */ (["ride", "cooling", "hypermile", "charge", "all", "faults"]);

/**
 * Where a URL that names no tab lands, and where one that names something unknown
 * lands too. The riding screen, because that is what the bare entry URL — the PWA's
 * `start_url`, and every bookmark taken before tabs were in the URL at all — has
 * always opened.
 */
export const DEFAULT_TAB = /** @type {TabName} */ ("ride");

/** Only explicit navigation and URL restoration write these states; why private: docs/dashboard-routing.md. */
const tab = van.state(DEFAULT_TAB);
const view = van.state(/** @type {ViewName} */ (DEFAULT_TAB));

export function currentView() {
  return view.val;
}

export function peekView() {
  return view.rawVal;
}

export function currentViewLabel() {
  return ROUTES.find(route => route.name === view.rawVal)?.label ?? "Ride";
}

/**
 * The tab on screen. Calling this inside a binding subscribes that binding to tab
 * changes, which for a binding that draws the current view is exactly right.
 */
export function currentTab() {
  return tab.val;
}

/**
 * The same, without subscribing — the peek() of this module, and for the same reason
 * (see public/lib/store.js). The view rules (lib/view-rules.js, spent by app.js's
 * autoFocus) run inside the chartTick timer, and the high-beam gesture runs inside its
 * own binding; reading `.val` from either would add the tab to that binding's
 * dependencies and re-run it on every tab change, which is precisely the silent
 * re-pacing CLAUDE.md warns about.
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
  showView(name);
}

/** @param {ViewName} name */
export function showView(name) {
  // rawVal, not val: this is reachable from inside bindings (see peekTab).
  if (name === view.rawVal) {
    // Re-tapping the tab you are on is not a navigation, and an entry for it would be
    // a Back press that appears to do nothing.
    return;
  }
  // Only a real view change loses confirmation context; a repeated tab tap is a no-op.
  armed.val = "";
  try {
    history.pushState(
      name === "cells" || name === "fault-report" ? { coolEvaSubview: true, backName: currentViewLabel() } : null,
      "",
      hashForView(name)
    );
  } catch (error) {
    // Safari refuses more than about a hundred pushState calls in thirty seconds. No
    // hand can tap that fast, but this is reachable from a handlebar gesture, and a
    // switch that is bounced by a rough road can be. A refused history entry must cost
    // the URL and nothing else — never the screen the rider asked for.
    console.warn("router: could not add a history entry", error);
  }
  view.val = name;
  tab.val = ROUTES.find(route => route.name === name)?.tab ?? DEFAULT_TAB;
  if (typeof window !== "undefined") {
    window.scrollTo(0, 0);
  }
}

/**
 * Move one tab along, wrapping at the end. What the high-beam gesture does, and the
 * other half of what a handlebar gesture might want from this module.
 */
export function advanceTab() {
  showView(nextViewAfter(view.rawVal));
}

/** @param {ViewName} name @returns {ViewName} */
export function nextViewAfter(name) {
  // Deliberate details advance from their parent; Cooling is itself a cycle stop.
  const route = ROUTES.find(route => route.name === name);
  const from = RIDING_CYCLE.some(stop => stop === name) ? name : route?.tab;
  const index = RIDING_CYCLE.findIndex(stop => stop === from);
  return RIDING_CYCLE[(index + 1) % RIDING_CYCLE.length];
}

/** @param {ViewName} name */
export function hashForView(name) {
  return ROUTES.find(route => route.name === name)?.hash ?? "#ride";
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
  // Back and direct hash changes bypass showView(), so URL restoration must also disarm.
  armed.val = "";
  const { tab: landing, view: landingView, rewriteTo, named } = canonicalHash(location.hash);
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
  view.val = landingView;
  return named;
}

/** Normalise known view URLs once; constraints and history behaviour: docs/dashboard-routing.md.
 * @param {string} hash
 * @returns {{tab:TabName,view:ViewName,rewriteTo:string|null,named:boolean}}
 */
export function canonicalHash(hash) {
  const route = ROUTES.find(candidate => candidate.hash === hash.toLowerCase());
  const landing = route?.tab ?? DEFAULT_TAB;
  const landingView = route?.name ?? DEFAULT_TAB;
  const wanted = hashForView(landingView);
  return { tab: landing, view: landingView, rewriteTo: hash === wanted ? null : wanted, named: route !== undefined };
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
  return ROUTES.find(route => route.hash === hash.toLowerCase())?.tab ?? null;
}
