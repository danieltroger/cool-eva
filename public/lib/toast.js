// @ts-check

import van from "../vendor/van-1.6.1.js";

// A banner that says what just happened, for things the rider started without looking.
//
// Everything else on this dashboard answers a question you went looking for. This
// answers one you cannot go looking for: a handlebar gesture gives no feedback of its
// own, so without this a long press on the bars is indistinguishable from a long press
// that did nothing, and the rider's only recourse is to stop and check.
//
// The constraints are the ones style.css opens with — read at speed, through a visor,
// in daylight — plus one more that follows from where the input came from:
//
//   • NEVER waits to be dismissed. A gesture is made with both hands on the bars, so a
//     banner needing a tap would be a banner that sits there until the next stop. It
//     times itself out, and `pointer-events: none` in style.css means it cannot
//     swallow a tap meant for whatever is underneath it either.
//   • Says WHICH way it went in colour as well as words, so the outcome is readable
//     before the sentence is.
//   • Full width at the top, over the header. Sunlight legibility is mostly area and
//     contrast, and the header carries nothing that cannot wait a few seconds.

const { div } = van.tags;

/**
 * How long a success stays up.
 *
 * A gesture is often made in the middle of something — coming to a stop, putting a
 * foot down — so this has to outlast the moment between triggering it and having a
 * glance to spare. Five seconds covers that without leaving the header buried.
 */
export const TOAST_GOOD_MS = 5000;

/**
 * How long a failure stays up.
 *
 * Longer, for two reasons: it is a longer sentence, and it is the one that asks for a
 * decision — a waypoint that was not saved is only recoverable if the rider learns
 * about it while still at the place they wanted to remember.
 */
export const TOAST_BAD_MS = 9000;

const message = van.state("");
const tone = van.state(/** @type {"good" | "bad"} */ ("good"));
const showing = van.state(false);

/** @type {ReturnType<typeof setTimeout> | undefined} */
let hideTimer;

/**
 * Shows the banner, replacing whatever was on it.
 *
 * @param {string} text what happened, in words the rider can act on
 * @param {"good" | "bad"} kind whether it worked; picks the colour and the dwell
 */
export function showToast(text, kind) {
  message.val = text;
  tone.val = kind;
  showing.val = true;
  // Restarted, not extended: the newest message is the true one, and it gets its own
  // full reading time rather than inheriting the remainder of the last one's.
  clearTimeout(hideTimer);
  hideTimer = setTimeout(
    () => {
      showing.val = false;
    },
    kind === "good" ? TOAST_GOOD_MS : TOAST_BAD_MS
  );
}

/** The banner itself. Mounted once, in app.js, so it survives every view switch. */
export function Toast() {
  return div(
    { class: () => `toast ${tone.val}${showing.val ? " on" : ""}` },
    // Bound rather than re-created so the fade-out reads the last message instead of
    // emptying to a blank bar the moment it starts to go.
    () => div({ class: "toast-text" }, message.val)
  );
}
