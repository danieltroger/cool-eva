// @ts-check

import van from "../vendor/van-1.6.1.js";

// The two-tap arm/dwell that stands between a thumb and anything that touches the bus.
//
// Extracted from views/vcu-write.js so the charge tab's controls reuse the SAME dwell rather
// than growing a second copy of it: one rule for every second tap that can reach the bus,
// asserted in one place — scripts/check-arming.ts. ⚠️ Not every second tap on the dashboard:
// views/service-mode.js still has an arm/fire of its own, with no dwell, in front of the
// read-only parameter sweep. docs/dashboard-decisions.md §"The other `armed`".
//
// ⚠️ `armed` is ONE key for the whole dashboard, and the surfaces are NOT mutually exclusive:
// the charge tab shows set-current and stop side by side for the whole of a live charge. The
// single key is still right — arming anything disarms everything, and every firing site tests
// its OWN key before it acts, so no tap can fire another control. What it costs is that arming
// one of two co-visible controls silently disarms the other, whose caption drops back from
// "Tap again" without saying why. docs/dashboard-decisions.md §`ARM_DWELL_MS`.

/** Which control is armed, by a key like `write`, `action:clear-dtcs` or `charge-current`. Empty means none. */
export const armed = van.state("");

/**
 * ⚠️ LOAD-BEARING, and not a debounce: the minimum separation that makes two taps two
 * taps, and the whole of what stops a double-tap running `31 FC`. Measured 2026-08-19 at
 * 390x844, two synchronous clicks on "Say a service was performed NOW" POSTed it for real.
 *
 * ⚠️ A tap inside the dwell is IGNORED, never a disarm: the caption still says "Tap again"
 * and still means it. Why 400 ms, and why a dwell rather than a dblclick guard, a disabled
 * beat or press-and-hold: docs/dashboard-decisions.md §`ARM_DWELL_MS` = 400 ms.
 */
export const ARM_DWELL_MS = 400;

/**
 * When the armed control armed itself.
 *
 * `performance.now()`, never `Date.now()`: this dashboard has a button on it that STEPS A
 * CLOCK, and a wall clock that jumps backwards mid-gesture hands out a dwell that never
 * elapses. Deliberately not a van.state — nothing renders from it.
 */
let armedAt = 0;

/**
 * Arms one control, and stamps when.
 *
 * ⚠️ The ONLY way `armed` is set to a non-empty key. Every arming site goes through here,
 * so no control can be armed without also being subject to the dwell. Disarming stays a
 * plain `armed.val = ""` and needs no stamp: every firing site tests `armed.val` first, and
 * an empty key matches none of them.
 *
 * @param {string} key
 * @param {number} [nowMs] the stamp. Every site on the dashboard passes nothing and gets
 *   `performance.now()`; scripts/check-arming.ts hands one in so the dwell can be asserted
 *   at 399 ms and at 400 ms rather than slept through. ⚠️ It is a BYPASS as well as a seam —
 *   `arm(key, performance.now() - 10_000)` arms a control whose dwell has already elapsed —
 *   so §7 of that check asserts that no call site here passes a second argument at all.
 */
export function arm(key, nowMs = performance.now()) {
  armed.val = key;
  armedAt = nowMs;
}

/**
 * Whether the armed control may fire yet — whether the tap now arriving is a second
 * gesture rather than the tail of the one that armed it.
 *
 * ⚠️ Checked at every site that acts on a second tap, and it is the whole of what stops
 * a double-tap running an irreversible action. See ARM_DWELL_MS for what was measured.
 *
 * @param {number} [nowMs] the reading to test the stamp against, injected by the check for
 *   the same reason `arm()` takes one.
 */
export function armDwellElapsed(nowMs = performance.now()) {
  return nowMs - armedAt >= ARM_DWELL_MS;
}

/**
 * Refuses a key AUTO-REPEAT, so one sustained keypress cannot arm and then fire.
 *
 * ⚠️ The one hole ARM_DWELL_MS does not close, and it does not close it by arithmetic:
 * macOS repeats a held key at about 500 ms, on the far side of the 400 ms dwell, so
 * Enter held down on an armed button would arm on the first event and fire on the
 * repeat. `event.repeat` is the browser saying "this is the same press continuing", so
 * the guard is exact where a longer dwell would be a race against a per-machine setting
 * — docs/dashboard-decisions.md §"Why `event.repeat` rather than a longer dwell".
 *
 * @param {KeyboardEvent} event
 */
export function refuseKeyRepeat(event) {
  // Qualified by key, or this cancels every held key on these buttons — a held
  // ArrowDown, PageDown or Tab would stop scrolling dead after one line.
  if (event.repeat && event.key === "Enter") {
    event.preventDefault();
  }
}
