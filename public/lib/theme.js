// @ts-check

import van from "../vendor/van-1.6.1.js";
import { ageOf, chartTick, valueOf } from "./store.js";

// Dark or light, resolved from three inputs and stamped on <html> as `data-theme`.
//
// The dark screen washes out in direct sun, which is the whole reason this exists.
// The values of both palettes, and the contrast measurements behind them, are in
// style.css; docs/dashboard-decisions.md has why the light ramp is shaped as it is.
//
// ⚠️ This is the ONLY resolver; style.css deliberately has no `prefers-color-scheme`
// media query, and the note there says why.

/** @typedef {"auto" | "light" | "dark"} ThemePreference */

const STORAGE_KEY = "coolEva.theme";

/**
 * How long the bike's own day/night flag counts for after it last arrived.
 *
 * 0x400 is the highest-rate frame on this bus at ~100 Hz, so while the bike is awake
 * this window is unreachable and CANNOT delay a flip — which is the requirement: the
 * phone switches in step with the dash, with no smoothing. It only decides when the
 * bike has gone quiet and the phone's own setting should take back over, which is why
 * it is generous. Same shape as CHARGER_LIVE_MS / CONTACTOR_LIVE_MS in charge-mode.js.
 */
const DASH_LIVE_MS = 10_000;

/**
 * The rider's choice. "auto" — the default — follows the bike, then the phone.
 * The only writer is setThemePreference().
 */
export const themePreference = van.state(/** @type {ThemePreference} */ (loadPreference()));

/** The phone's own setting, kept live so a change to it while the page is open lands. */
const prefersLight = van.state(matchMediaLight()?.matches === true);

/**
 * The theme actually being shown.
 *
 * The fall-through is the whole design: an explicit choice is never overruled by the
 * bus; otherwise the bike while it is talking; otherwise the phone.
 */
const activeTheme = van.derive(() => {
  const preference = themePreference.val;
  if (preference !== "auto") {
    return preference;
  }
  // valueOf() and not peek(): a flip has to repaint on the frame it arrives. This is
  // the one subscription in here that must be a subscription.
  const dayMode = valueOf("dash_day_mode");
  // …and this is what ages that reading OUT when the bike stops broadcasting. Paced
  // rather than subscribed for the reason ageOf() gives — reading serverTime directly
  // would re-run this derive at the WebSocket's rate. tiles.js:141 does the same thing
  // for its fault notice. It never delays a flip; see DASH_LIVE_MS.
  chartTick.val;
  if (dayMode !== null && ageOf("dash_day_mode") < DASH_LIVE_MS) {
    return dayMode === 1 ? "light" : "dark";
  }
  // ⚠️ This ages out a SLEEPING bike, not a dropped link. serverTime freezes with the
  // messages, so while the socket is down the age stops growing and the theme holds its
  // last value rather than falling through to here — deliberately, and it is the same
  // property that stops a twelve-second blip repainting the whole screen. Gating on
  // `connection` as well would reintroduce that snap. dashboard-decisions.md has the
  // four-state table.
  return prefersLight.val ? "light" : "dark";
});

/**
 * Set and persist the rider's choice.
 * @param {ThemePreference} preference
 */
export function setThemePreference(preference) {
  themePreference.val = preference;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch (error) {
    // Private-mode Safari throws on any localStorage write; the choice just won't
    // persist past this session, which is a far smaller problem than a dead page.
    console.warn("theme: could not persist preference", error);
  }
}

/**
 * Starts applying the theme to the document. Idempotent in effect — VanJS derives are
 * the only thing driving it — and called once, from app.js.
 */
export function startTheming() {
  const media = matchMediaLight();
  if (media) {
    media.addEventListener("change", event => {
      prefersLight.val = event.matches;
    });
  }
  van.derive(() => {
    const theme = activeTheme.val;
    document.documentElement.dataset.theme = theme;
    // The browser chrome around the page, which our CSS does not reach. ⚠️ Only
    // index.html: params.html loads params-page.js alone, never app.js, so it keeps the
    // dark defaults — which is fine, it is the page you read beside a parked bike.
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", ground);
  });
}

/**
 * Guarded because `window` is absent under Node, not because `matchMedia` is: it has
 * shipped in every mobile browser for a decade, and claiming otherwise would be the one
 * unmeasured assertion in this file. Several checks import modules out of public/
 * (bounds.js into check-button-decode.ts), so a module-scope throw here would be a
 * build failure rather than a missing colour.
 * @returns {MediaQueryList | null}
 */
function matchMediaLight() {
  try {
    return window.matchMedia("(prefers-color-scheme: light)");
  } catch (error) {
    console.warn("theme: matchMedia unavailable, falling back to dark", error);
    return null;
  }
}

/** @returns {ThemePreference} */
function loadPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch (error) {
    console.warn("theme: could not read stored preference", error);
    return "auto";
  }
}
