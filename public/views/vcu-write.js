// @ts-check

import van from "../vendor/van-1.6.1.js";
import { BAD, GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { ageInWords } from "../lib/format.js";

const { button, div, h2, h3, input, option, select, span } = van.tags;

// Service mode's WRITE section: change one allowlisted VCU parameter, or run one of
// the four service actions.
//
// ── ⚠️ Nothing on this page decides anything ────────────────────────────────
// The allowlist, the ranges, the compare-and-swap and the read-back all live on the
// Pi, in pure modules (src/vcu/write-targets.ts, src/vcu/write-session.ts). This page
// cannot widen any of them and does not try: it renders what GET /vcu-write says is
// writable and reports what POST /vcu-write says happened. If it and the server ever
// disagree, the server wins and the page shows the server's reason.
//
// ── How an accidental write is made hard ────────────────────────────────────
// Four things, in the order they are met:
//
//  1. **A write is always against a value that was READ off this bike.** The number on
//     screen is sent back as `expected=`, the Pi re-reads the parameter and refuses if
//     it has moved, so a page left open since yesterday cannot write over a value it is
//     not showing. The button stays disabled while nothing has read it at all.
//
//     ⚠️ That reading may come from the last parameter SWEEP rather than from this
//     page's own read button, and this is the one lock whose shape changed (2026-08-19).
//     It used to insist on a per-parameter read here, which meant a completed 277/277
//     sweep — which had just read every one of these — left the form saying "not read
//     yet" and demanding one of them again. The property that matters was never the
//     tap: it is the compare-and-swap, and that is enforced on the Pi against a read
//     taken DURING the write (src/vcu/write-session.ts), not against anything this page
//     believes. So an older reading is not a weaker precondition — it is a likelier
//     refusal, which is the safe direction. What the page owes in exchange is honesty
//     about where its number came from and how old it is, which is the caption under it.
//  2. **The confirmation shows old → new**, spelled out in the button caption, and
//     the button changes what it says between the two taps.
//  3. **Two taps, never one — and never one gesture.** The first arms and the second
//     sends, and arming is dropped by ANY change to the form — retyping the value,
//     picking a different parameter, a refreshed reading, or a refreshed status. That
//     last one matters: it means a value that moved under you disarms the button rather
//     than being written.
//
//     ⚠️ And the second tap is refused for ARM_DWELL_MS after the first, because until
//     2026-08-19 "two taps" was satisfied by a double-tap: two synchronous clicks on
//     "Say a service was performed NOW" really did POST `31 FC`. That was the single
//     most likely accidental gesture on a phone — tap, see nothing change fast enough,
//     tap again — arriving at the one action with no unset.
//  4. **The irreversible actions are behind a fold**, below the parameters, each with
//     its own two taps and its own warning — and, collapsed, not on screen at all. They
//     are not in a list you can scroll a thumb through, and since 2026-08-19 they are
//     not in a list at all until somebody asks for one. Toggling the fold disarms, and
//     the fold re-collapses whenever the sheet is opened.
//
// ── The three risk tiers ────────────────────────────────────────────────────
// The page contains three kinds of thing and is painted so that it looks like it does,
// because a rider glancing at this on a handlebar-mounted phone should be able to tell
// them apart BEFORE reading any text. The colours and the left-edge gutter that carries
// them are defined once in public/style.css; this file only says which control is which.
//
//   read (grey)         the probe read, the parameter read, the service-stamp read.
//                       Cannot change the bike — and it is the DEFAULT, so a control
//                       acquires risk by being marked, never by being forgotten.
//   write (amber)       the parameter write. Changes the bike and can be written back,
//                       which is what makes it a middle tier rather than a red one.
//   irreversible (red)  31 FC, Mode 04, the clock. Behind the fold, and each carries in
//                       red the one thing it cannot take back.
//
// ── Where each sentence belongs ─────────────────────────────────────────────
// The allowlist carries three kinds of prose about each entry and they are read at
// three different moments, so they are shown at three different ones — and the service
// actions below are split the same three ways (see the `ActionNotes` typedef):
//
//   purpose   what this parameter IS. Always visible, in grey: it is how you know you
//             are on the right one.
//   warnings  why you might not want to. Amber, behind one tap, because there are up to
//             four of them per parameter and stacking four amber paragraphs above the
//             input is how a phone in a garage becomes unusable — and how warnings stop
//             being read at all. The toggle says how many there are and stays amber
//             while they are collapsed; nothing is dropped.
//   verify    how to check the bike afterwards. Shown AFTER the write, next to the
//             outcome, because that is when it is actionable.
//
// The service actions add a fourth kind that no parameter has: what this cannot take
// back. Red, never more than one short line, and it leads the other three.
//
// ── ⚠️ And one lock that is not about care at all ───────────────────────────
// The table-type gate (src/vcu/table-gate.ts) disables the write button outright until
// the bike has said which of Energica's 28 parameter tables it runs, because a
// parameter is written BY INDEX and a name is only a claim about a table. It disables
// the WRITE button and nothing else: the read button and the service actions stay live,
// deliberately, because the way out of the blocked state is a READ. See `canWrite`.
//
// `confirm()` is deliberately not used, here or anywhere in this dashboard — it is a
// browser dialog that lands in the wrong place on a phone, and it cannot show a
// two-line before/after.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */
/** @typedef {import("../../src/http/vcu-probe.ts").VcuProbeResponse} VcuProbeResponse */
/** @typedef {import("../../src/vcu/write-runner.ts").WriteTargetSummary} WriteTargetSummary */
/** @typedef {import("../../src/vcu/write-audit.ts").AuditRecord} AuditRecord */

/**
 * @typedef {{ value: number, rawHex: string | null, label: string | null,
 *   source: "bus" | "sweep", readAt: number | null, complete: boolean }} OnBike
 */

const state = van.state(/** @type {VcuWriteResponse | null} */ (null));
/** Which allowlist entry the form is on. Empty until the section has loaded. */
const selected = van.state("");
/**
 * The freshest value this PAGE has had off the bus — a probe read, or the read-back at
 * the end of a write — and which parameter it belongs to.
 *
 * ⚠️ The name rides along rather than the reading being cleared when the parameter
 * changes, which is what the previous shape did. A reading and a `selected` that can
 * drift apart is the bug this prevents: `onBike()` below only ever hands out a reading
 * whose name matches the parameter the form is on, so there is no ordering in which a
 * number belonging to one parameter can be shown — or sent as `expected=` — against
 * another.
 */
const reading = van.state(/** @type {{ name: string, value: number, rawHex: string | null } | null} */ (null));
const wanted = van.state("");
/** Which control is armed, by a key like `write` or `action:clear-dtcs`. Empty means none. */
const armed = van.state("");
/**
 * ⚠️ LOAD-BEARING, and not a debounce. How long an armed control refuses its own
 * second tap — i.e. the minimum separation that makes two taps two taps.
 *
 * Measured in a browser at 390x844 on 2026-08-19, before this existed: two synchronous
 * clicks on "Say a service was performed NOW" produced a real
 * `POST /vcu-write?action=set-service-point&confirm=set-service-point`, and the same on
 * `clear-dtcs`. One gesture both primed and fired `31 FC`. `armed` was set
 * synchronously, so nothing whatsoever separated the two clicks.
 *
 * ⚠️ The parameter write and the clock sync passed that same test BY ACCIDENT, and that
 * is the part worth writing down. armWrite() and armClockSync() `await fetchStatus()`
 * between arming and firing, which raises `busy` and disables the button, so the second
 * click landed on a disabled control and was swallowed. A refresh was doing safety work
 * as a side effect — so making it faster, cached, conditional or optional would remove
 * the protection from two of the three irreversible controls without touching a line
 * that looks like a guard. All three now hold this deliberately.
 *
 * ⚠️ Why a dwell and not one of the obvious alternatives:
 *
 *   a dblclick / event.detail guard   only a mouse raises `detail` past 1. Two taps
 *                                     from a gloved thumb a few pixels apart are two
 *                                     ordinary clicks, and that is the actual gesture.
 *   disabling the button for a beat   `.action:disabled` is visibly dimmed, so the
 *                                     control would flash "off" in the one moment its
 *                                     caption is asking to be read — and "it went grey
 *                                     and nothing happened" is the very stimulus that
 *                                     produces the extra tap.
 *   press-and-hold                    a gesture to learn, on controls nobody presses
 *                                     often enough to learn it.
 *
 * 400 ms because it must cost the INTENDED flow nothing. The armed caption is ~45
 * characters ("⚠️ Tap again — STAMP A SERVICE NOW. There is no unset") and has to be
 * found, read and acted on; nothing does that in under 400 ms. What 400 ms does cover,
 * with margin, is every platform's own idea of two taps being one gesture — iOS and
 * Android recognise a double-tap inside ~300 ms.
 *
 * ⚠️ A tap inside the dwell is IGNORED, never treated as a disarm. The button stays
 * armed and goes on saying "Tap again", so an impatient double-tapper's next tap does
 * what they meant; silently disarming would put them back at the start without saying
 * so, which is a worse answer to the same gesture and invites a fourth tap.
 */
const ARM_DWELL_MS = 400;
/**
 * When the armed control armed itself.
 *
 * `performance.now()`, never `Date.now()`, for the reason CLAUDE.md gives for
 * `monotonicNow()` on the Pi: this page has a button on it that STEPS A CLOCK, and the
 * Pi steps its own from GPS. A wall clock that jumps backwards mid-gesture hands out a
 * dwell that never elapses; one that jumps forwards hands out none at all.
 *
 * Deliberately not a van.state — nothing renders from it, and making it one would
 * re-run every caption binding on each arm to no visible effect.
 */
let armedAt = 0;
/** Whether the selected parameter's warnings are unfolded. Collapsed by default; see the header. */
const warningsOpen = van.state(false);
/**
 * Whether the three irreversible service actions are unfolded.
 *
 * Collapsed by default and re-collapsed on every sheet open, for the same reason
 * `armed` is cleared there: the state a sheet opens in is the state a thumb finds when
 * it is reaching for something else, and that state must not contain `31 FC`.
 */
const dangerOpen = van.state(false);
/**
 * The last write attempt made from this page, so the outcome and the verification hint
 * can be shown against the parameter they belong to rather than to whatever is selected
 * when the answer lands.
 */
const lastWrite = van.state(/** @type {{ name: string, status: string, succeeded: boolean } | null} */ (null));
const busy = van.state(false);
/**
 * True only while a write's own POST is in flight.
 *
 * ⚠️ Separate from `busy`, which is also raised by the probe read and by the refresh
 * the write button's first tap does. This page must not say "Writing…" while it is
 * doing something else: a caption claiming a write is in progress when none is would be
 * a lie about the one thing on this page that cannot be taken back.
 */
const writing = van.state(false);
const message = van.state("");

export function VcuWrite() {
  return div(
    // A level-1 heading, and the only amber one: this is the line the sheet's read
    // half ends at, and the rule above it is the widest single piece of separation
    // in the whole panel. ./service-mode.js has carried the boundary as a comment
    // since it was written; this is the same statement, where a rider can see it.
    //
    // ⚠️ The amber and the line under it are governed by `hasControls()` — THE SAME
    // condition that decides whether the controls render at all, three lines below.
    // That is the point of it being one function: a warning about what is under a
    // heading must appear and disappear with the thing it is warning about, and it
    // cannot be made to disagree by any state this page can be in.
    //
    // Two states have nothing under the heading and so get no warning: writing off on
    // this Pi (SERVICE_WRITE_ENABLED=0), and nothing answered yet — which is not a
    // moment of "we don't know, assume the worst", it is a section that is EMPTY,
    // and it lasts as long as an unreachable Pi lasts because nothing re-polls
    // /vcu-write while the sheet is open. An amber warning standing over an empty
    // section until the sheet is reopened is a wolf cried permanently.
    h2({ class: () => `sheet-heading${hasControls() ? " writes" : ""}` }, "Change something on the bike"),
    // ⚠️ "Everything below here can change the motorcycle" was FALSE and had to go:
    // of the next four controls, the parameter picker reads, the value on the left is
    // a read-out, "Read it off the bike again" reads, and the service-stamp action is
    // labelled read-only. A section heading that lies is worse than none.
    //
    // What it says instead is the section's risk PROFILE, and it says it here rather
    // than only at the fold 600 px further down — which is the honest answer to
    // "a panel must never conceal what it is capable of". The fold hides the buttons
    // from a wandering thumb; it does not get to hide that they exist.
    () =>
      hasControls()
        ? div(
            { class: "sheet-heading-note" },
            `Can change the bike — including ${IRREVERSIBLE_COUNT} things that cannot be undone.`
          )
        : div(),
    Availability(),
    // ⚠️ The one thing that MUST render when there are no controls: why there are
    // none. `message` is where fetchStatus() puts "could not reach /vcu-write", and
    // its only other home is Outcome(), which lives inside ParameterForm() — i.e.
    // inside the branch `hasControls()` has just switched off. So the loudest failure
    // this section has was being written to a node that does not exist whenever it
    // happened, and an unreachable Pi rendered as a heading, an ellipsis and silence.
    //
    // ⚠️ `.failure`, not the bare `.action-note` it first landed in. Rendering it was
    // only half the fix: at --label / 11.52 px it came out byte-for-byte identical to
    // "Reads four identifiers on the A8" — this section's own thesis, that prose is
    // ranked by consequence, not applied to the one sentence saying the section is
    // dead. Availability() stands its ellipsis down for the same reason: "loading" and
    // "the fetch failed" are mutually exclusive and only one of them was ever true.
    () => (!hasControls() && message.val ? div({ class: "action-note failure" }, message.val) : div()),
    () => (hasControls() ? div(ParameterForm(), ServiceActions(), Journal()) : div())
  );
}

/**
 * Whether this section is actually rendering controls.
 *
 * Deliberately `=== true` rather than truthiness, and deliberately one function used
 * by the heading, the warning under it and the controls themselves — see the heading.
 */
function hasControls() {
  return state.val?.status.enabled === true;
}

/**
 * Arms one control, and stamps when.
 *
 * ⚠️ The ONLY way `armed` is set to a non-empty key. All three arming sites go through
 * here — ActionButton's own onclick, armWrite() and armClockSync() — so no control can
 * be armed without also being subject to the dwell. Disarming stays a plain
 * `armed.val = ""` and needs no stamp: every firing site tests `armed.val` first, and
 * an empty key matches none of them.
 *
 * @param {string} key
 */
function arm(key) {
  armed.val = key;
  armedAt = performance.now();
}

/**
 * Whether the armed control may fire yet — whether the tap now arriving is a second
 * gesture rather than the tail of the one that armed it.
 *
 * ⚠️ Checked at every site that acts on a second tap, and it is the whole of what stops
 * a double-tap running `31 FC`. See ARM_DWELL_MS for what was measured and why this is
 * not something to fold back into `disabled:`.
 */
function armDwellElapsed() {
  return performance.now() - armedAt >= ARM_DWELL_MS;
}

/**
 * Refuses a key AUTO-REPEAT, so one sustained keypress cannot arm and then fire.
 *
 * ⚠️ The one hole ARM_DWELL_MS does not close, and it does not close it by arithmetic:
 * macOS repeats a held key at about 500 ms, which is on the far side of the 400 ms
 * dwell, so Enter held down on an armed button would arm on the first event and fire on
 * the repeat. Raising the dwell past 500 ms would be the wrong answer — it would slow
 * the gesture that actually happens (a thumb) to close a hole that only a keyboard has,
 * and the repeat interval is a per-machine setting that can go slower still.
 *
 * `event.repeat` is the browser saying "this is the same press continuing", which is
 * precisely the distinction wanted, so the guard is exact rather than timed. Enter's
 * activation of a `<button>` is the default action of the keydown, so preventing it
 * there is what stops it; Space activates on keyup and so repeats harmlessly already.
 *
 * There is no keyboard on a handlebar-mounted phone. This is here for the same reason
 * `.sheet` gained `visibility: hidden` — the argument for the fold is that an
 * irreversible action must not be reachable by accident, and "the hardware makes it
 * unlikely" is a different claim from "the page does not allow it".
 *
 * @param {KeyboardEvent} event
 */
function refuseKeyRepeat(event) {
  // Qualified by key, or this cancels every held key on these five buttons — a held
  // ArrowDown, PageDown or Tab would stop scrolling dead after one line, which is a
  // real cost on a phone paid to prevent something only a keyboard can do. The
  // paragraph above already reasons that Enter is the only key that needs it; this
  // is that reasoning written into the condition rather than left beside it.
  if (event.repeat && event.key === "Enter") {
    event.preventDefault();
  }
}

/**
 * Whether writing is possible at all, and why not when it is not.
 *
 * Leads the section for the same reason the gate note leads the read section: a
 * disabled button with no reason given is indistinguishable from a broken one.
 */
function Availability() {
  return div({ class: "action-note" }, () => {
    const status = state.val?.status;
    if (!status) {
      // ⚠️ The ellipsis means "waiting for an answer", and it must stand down the
      // moment one kind of answer arrives. `status` stays null for ever after a failed
      // GET — nothing re-polls /vcu-write while the sheet is open — so with the Pi
      // unreachable this section read as loading and failed at the same time, with the
      // loading claim the more visible of the two. The failure line VcuWrite() renders
      // just below is the true one; this one goes quiet and lets it speak.
      return message.val ? div() : div({ style: `color:${MUTED}` }, "…");
    }
    if (!status.enabled) {
      return div(
        { style: `color:${MUTED}` },
        "🔒  Writing is off on this Pi. It is off by default — set SERVICE_WRITE_ENABLED=1 in the service's environment to allow it. Reading is unaffected."
      );
    }
    if (!status.gate.safe) {
      // ⚠️ The table note is rendered HERE TOO, not only in the safe branch. It is the
      // same person on the same trip: the reason they cannot write this second is the
      // vehicle-state gate, and the reason they still will not be able to once they
      // park is this one. Showing them one at a time means a second walk out to the
      // bike — and the write button below is rendered whenever writing is enabled, so
      // it would otherwise be saying "see above" with nothing above it.
      return div(
        div(
          "🚫  Nothing can be written:",
          ...status.gate.blockers.map(blocker => div({ style: `color:${MUTED}` }, `· ${blocker}`))
        ),
        TableTypeNote()
      );
    }
    return div(
      div(
        { style: `color:${GOOD}` },
        status.gate.chargingEvidence === null
          ? "✅  Stationary and out of drive."
          : `🔌  Stationary and charging (${status.gate.chargingEvidence}) — which is deliberately allowed, because the DC charge parameters cannot be tested unplugged.`
      ),
      TableTypeNote()
    );
  });
}

/**
 * Whether the bike has said which parameter table it runs — and what to do when it
 * has not.
 *
 * ⚠️ The blocked states are rendered DIFFERENTLY on purpose, in colour and in words,
 * because they are not the same problem:
 *
 *   no read will help (red)   the bike named a table this software does not carry, the
 *                             two micros named different tables, or the table is carried
 *                             and an allowlisted parameter is not called that on it.
 *                             Every parameter name on this page may belong to a different
 *                             parameter, and the fix is a table or a change in the Pi's
 *                             source — the server's `remedy` says which.
 *   a read will (amber)       nobody has asked the bike yet, or a reply was malformed.
 *                             One read clears it, and the `remedy` names exactly which —
 *                             parameter, micro and request bytes.
 *
 * ⚠️ The branch is on `noReadWillHelp` rather than on `state`, deliberately. It used to
 * test `state === "mismatched"`, which quietly made every state added later render as
 * amber "nobody has asked yet" with an instruction that leads nowhere — and two such
 * states have since been added (`split`, `unwritable`). The server decides which kind of
 * blocked this is; this file only decides what colour that is.
 *
 * A single "writes are blocked" would send someone hunting for a software bug when the
 * answer was one frame, or the other way round. The sentences come from the Pi
 * (src/vcu/table-gate.ts) rather than being written again here: deciding what a
 * `TABLE_TYPE` reading means needs all 28 parameter tables, and a second copy of that
 * reasoning in a file the checks cannot reach is the exact drift this gate exists to
 * catch — the same argument /vcu-params makes for computing its banner server-side.
 */
function TableTypeNote() {
  const table = state.val?.status.tableGate;
  if (!table || table.writesAllowed) {
    // Silent when confirmed. The line above already says writing is available, and a
    // green "table confirmed" badge would be one more thing to read past every time.
    return div();
  }
  const stuck = table.noReadWillHelp;
  return div(
    div(
      { style: `color:${stuck ? BAD : WARN}` },
      stuck
        ? "🚨  Parameter writes are blocked: this bike's parameter table is not one this software can write against."
        : "⚠️  Parameter writes are blocked: nothing has confirmed which parameter table this bike runs."
    ),
    div({ style: `color:${MUTED}`, class: "action-note" }, table.reason),
    // The remedy is the reason this is a gate and not a wall, so it gets the emphasis
    // rather than the muted grey the reason sits in.
    div({ style: `color:${stuck ? BAD : WARN}`, class: "action-note" }, table.remedy),
    div(
      { style: `color:${MUTED}`, class: "action-note" },
      "Reading is unaffected — a read under the wrong table shows a wrong name and changes nothing, and the way out of this is a read. The service actions below are unaffected too: none of them addresses a parameter by index."
    )
  );
}

function ParameterForm() {
  return div(
    div({ class: "probe-row" }, Field("Parameter", ParameterSelect)),
    TargetNote(),
    ChangeRow(),
    ValueNote(),
    ReadButton(),
    WriteButton(),
    Outcome()
  );
}

/**
 * The allowlist as a picker.
 *
 * ⚠️ The whole `<select>` is rebuilt by the binding, and the options are its DIRECT
 * children. That is not a style preference — it is the fix for two real faults, both
 * caused by the options previously being wrapped in a `<div>` because a VanJS binding
 * function may only return ONE node (see van-1.6.1.d.ts's `ValidChildDomValue`):
 *
 *   • A `<div>` is not in `<select>`'s content model. Whether the options inside one
 *     are collected at all is up to the engine — Chrome ≥135 does, older engines and
 *     the phone this dashboard is actually used on showed an EMPTY dropdown with the
 *     five parameters unreachable.
 *   • Even where it renders, `select.value = …` set before that div is appended does
 *     not stick, so any status refresh that rebuilt the list — every write does one —
 *     silently snapped the picker back to the first parameter while the rest of the
 *     form stayed on the one that was chosen. A write UI whose dropdown names a
 *     different parameter from the one being written to is exactly the kind of quiet
 *     mismatch everything else here is built to avoid.
 *
 * Which option is current is therefore set on the OPTION (`selected`), never on the
 * select afterwards: it survives being rebuilt and does not depend on props and
 * children being applied in a particular order.
 */
function ParameterSelect() {
  return div(() => {
    const targets = state.val?.status.targets ?? [];
    return select(
      {
        class: "probe-input",
        onchange: (/** @type {Event} */ event) => {
          selected.val = /** @type {HTMLSelectElement} */ (event.target).value;
          // A different parameter means a different value, a different range and a
          // different set of warnings. Everything the form holds about the old one goes.
          forgetSelection();
        },
      },
      ...targets.map(target =>
        option({ value: target.name, selected: target.name === selected.val }, `${target.name} (${target.micro})`)
      )
    );
  });
}

/**
 * What the selected parameter is, and one tap to what is wrong with changing it.
 *
 * The warnings are collapsed rather than dropped, and the toggle is amber and counts
 * them so a collapsed block still says there is something to read. See the header for
 * why they are not all stacked above the input any more.
 */
function TargetNote() {
  return div({ class: "action-note" }, () => {
    const target = selectedTarget();
    if (!target) {
      return div();
    }
    const notes = warningsOf(target);
    return div(
      div({ style: `color:${MUTED}` }, target.purpose),
      notes.length === 0
        ? div()
        : button(
            {
              class: "code-toggle",
              style: `color:${WARN}`,
              onclick: () => {
                warningsOpen.val = !warningsOpen.val;
              },
            },
            () =>
              warningsOpen.val
                ? "⚠️  hide what is wrong with changing it"
                : `⚠️  ${notes.length} thing${notes.length === 1 ? "" : "s"} to know before changing it  ▾`
          ),
      // `caution`, the same class the service actions' why-you-might-not-want-to lines
      // use, rather than an inline WARN: these are the same tier of sentence and there
      // is now one place that decides what that tier looks like. The toggle above keeps
      // its inline colour — it is a control, and the tiers are about prose.
      () => (warningsOpen.val ? div(...notes.map(note => div({ class: "action-note caution" }, note))) : div())
    );
  });
}

/**
 * Everything the allowlist says against changing this parameter, in one list.
 *
 * The per-bit caveats are folded in rather than kept in a block of their own: they are
 * warnings about the same act, and two separately-headed lists of amber paragraphs was
 * half the problem.
 * @param {WriteTargetSummary} target
 */
function warningsOf(target) {
  return target.control.kind === "bits"
    ? [...target.warnings, ...target.control.bits.map(bit => `⚠️ ${bit.label}: ${bit.caveat}`)]
    : target.warnings;
}

/**
 * Old → new, on one line, because that is the sentence the two taps agree to.
 *
 * The arrow is a character between two fields rather than a caption anywhere, so the
 * relationship survives being read at arm's length in a garage.
 */
function ChangeRow() {
  return div(
    { class: "probe-row", style: "align-items:flex-end" },
    Field("On the bike", CurrentReading),
    div({ style: `color:${MUTED}; padding-bottom:0.6rem` }, "→"),
    Field("Change to", WantedControl)
  );
}

function CurrentReading() {
  // ⚠️ `readout`, so it does not look typeable. This is the only field-shaped thing
  // in the sheet that cannot be edited, and it sat immediately left of "Change to"
  // in identical chrome — a read/write pair rendered as two of the same thing, which
  // is the exact confusion the rest of this page is built to remove. The number here
  // is also what gets sent as `expected=`, so "where did this come from" is a
  // question worth the box answering by its shape.
  return div({ class: "probe-input readout", style: "display:flex; align-items:center" }, () => {
    const known = onBike();
    if (!known) {
      return span({ style: `color:${MUTED}` }, "not read yet");
    }
    const target = selectedTarget();
    if (target?.control.kind === "bits") {
      // The WORD is what gets written and what the compare-and-swap is against, so it
      // is what is shown — but what is being changed is one bit of it, and "is that bit
      // on right now" is the question in front of somebody about to toggle it.
      return span(describeBits(target, known.value));
    }
    return span(String(known.value));
  });
}

/**
 * `0x1113 · Heated handlebars OFF`. The word, then what its writable bits say.
 * @param {WriteTargetSummary} target @param {number} value
 */
function describeBits(target, value) {
  if (target.control.kind !== "bits") {
    return String(value);
  }
  const bits = target.control.bits.map(bit => `${bit.label} ${(value & bit.mask) === 0 ? "OFF" : "ON"}`);
  return [hexWord(value), ...bits].join(" · ");
}

/** `0x1113`. Four digits, because these words are quoted that way everywhere else. @param {number} value */
function hexWord(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Where the number to the left came from, and what may be typed to the right.
 *
 * ⚠️ The provenance is not decoration. A value the last sweep read an hour ago and a
 * value read off the bus ten seconds ago are both legitimate preconditions — the Pi
 * re-reads either way — but they are not equally likely to still be true, and the one
 * thing the page must never do is present them as the same thing.
 *
 * ⚠️ The age is computed at RENDER, and nothing polls /vcu-write while the sheet is
 * open, so a sheet left untouched shows the age it had when something last re-rendered
 * it. That is why the write button's first tap refreshes before it arms (`armWrite`):
 * the caption is re-rendered from the Pi's answer at the moment somebody starts to
 * commit, which is the moment its accuracy is load-bearing. A timer ticking this every
 * minute for a phone sitting on a workbench would be the wrong trade.
 */
function ValueNote() {
  return div({ class: "action-note", style: `color:${MUTED}` }, () => {
    const target = selectedTarget();
    if (!target) {
      return div();
    }
    const known = onBike();
    const range =
      target.control.kind === "number"
        ? `Whole number, ${target.control.min}…${target.control.max} (${target.control.minLabel}…${target.control.maxLabel}).`
        : "";
    if (!known) {
      return div(`Nothing here has read this parameter yet. ${range}`);
    }
    const bytes = known.rawHex ? ` (${known.rawHex})` : "";
    // A config word is written and read as hex everywhere else on this page, so a
    // decimal 4375 here would be a third rendering of the same number to reconcile.
    const asShown = target.control.kind === "bits" ? hexWord(known.value) : String(known.value);
    const where =
      known.source === "bus"
        ? `${asShown}${bytes} — read off the bike by this page.`
        : `${known.label ?? known.value}${bytes} — from the parameter sweep ${ageInWords(known.readAt)}` +
          `${known.complete ? "" : ", which did not finish"}. The Pi re-reads it before writing.`;
    return div(`${where} ${range}`);
  });
}

/**
 * A number box for a value, a picker for a bit.
 *
 * The bit case is the point: there is no way here to type a word into VSM_CONFIG_1,
 * because the same word carries the PSU type and the Bluetooth variant and a
 * fat-fingered word would reconfigure both. The server would refuse it too — the
 * allowlist has no number control for that parameter — but the form should not offer
 * a shape the server will only reject.
 */
function WantedControl() {
  return div(() => {
    const target = selectedTarget();
    if (target?.control.kind === "bits") {
      const bits = target.control.bits;
      // `selected` on the option rather than `value` on the select, for the reason
      // ParameterSelect() sets out at length: this binding re-runs whenever the status
      // does, and a `value` applied before the options exist is silently dropped —
      // which would put the picker back on "choose…" while `wanted` still held a bit.
      return select(
        {
          class: "probe-input",
          onchange: (/** @type {Event} */ event) => {
            wanted.val = /** @type {HTMLSelectElement} */ (event.target).value;
            armed.val = "";
          },
        },
        option({ value: "", selected: wanted.val === "" }, "choose…"),
        ...bits.flatMap(bit => [
          option({ value: `${bit.key}:1`, selected: wanted.val === `${bit.key}:1` }, `${bit.label} — ON`),
          option({ value: `${bit.key}:0`, selected: wanted.val === `${bit.key}:0` }, `${bit.label} — OFF`),
        ])
      );
    }
    return input({
      class: "probe-input",
      type: "text",
      inputmode: "numeric",
      placeholder: target?.control.kind === "number" ? `${target.control.min}…${target.control.max}` : "",
      value: wanted,
      oninput: (/** @type {Event} */ event) => {
        wanted.val = /** @type {HTMLInputElement} */ (event.target).value;
        // Retyping disarms. Otherwise the second tap could send a different number
        // from the one the first tap agreed to.
        armed.val = "";
      },
    });
  });
}

/**
 * Reads the selected parameter off the bike, through the read path's probe endpoint.
 *
 * Deliberately the PROBE and not a new read: /vcu-probe already reads one identifier
 * off one micro, it is already gated and single-flighted, and adding a second way to
 * read one value would be two things to keep in step.
 */
function ReadButton() {
  return button(
    {
      class: "action",
      disabled: () => busy.val || !canReach() || !selectedTarget(),
      onclick: () => void readCurrent(),
    },
    () => {
      if (busy.val) {
        return "⏳  Reading…";
      }
      // Two captions, because the button is answering two different questions. With
      // nothing read it is the way to get a value at all; with a sweep's value already
      // on screen it is how you find out whether that value is still true, which is a
      // thing you may want and no longer something you are made to do.
      return onBike() === null ? "🔎  Read it off the bike now" : "🔎  Read it off the bike again";
    }
  );
}

function WriteButton() {
  return div(
    button(
      {
        // The middle tier, and the only control in it. A parameter write changes the
        // bike and can be written back — which is why it is amber and on screen,
        // rather than red and behind the fold with the three that cannot.
        class: "action writes",
        // One held Enter must not arm and then fire. See refuseKeyRepeat.
        onkeydown: refuseKeyRepeat,
        // Unavailable until a value has been read off this bike, until something has
        // been chosen to write, and until the bike has named its parameter table. The
        // server enforces all three — the compare-and-swap, the allowlist and the table
        // gate — and the page simply does not offer a button whose request would be
        // refused.
        disabled: () => busy.val || !canWrite() || onBike() === null || wanted.val.trim().length === 0,
        onclick: () => {
          if (armed.val !== "write") {
            void armWrite();
            return;
          }
          // Same dwell, same reason as the irreversible three. This one is reversible,
          // which is why it is amber — but a write nobody meant is still a write, and
          // one rule for every second tap on this page is one rule to keep true.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performWrite();
        },
      },
      () => {
        if (writing.val) {
          return "⏳  Writing…";
        }
        if (busy.val) {
          // The first tap's refresh, or a read running in the section above. Neither is
          // a write, and neither may be captioned as one.
          return "⏳  Checking what the bike holds…";
        }
        const table = state.val?.status.tableGate;
        if (table && !table.writesAllowed) {
          // Ahead of the "read it first" caption: reading the value would not help
          // here, and a button that asks for a reading it will then refuse to act on is
          // worse than one that says what is actually wrong. The full sentence and the
          // remedy are in TableTypeNote() above; this is the short form on the control.
          return table.noReadWillHelp
            ? "🚨  Blocked — this bike's parameter table is not one this software can write against"
            : // Deliberately "sweep", not "read": the probe shows the answer and stores
              // nothing, so a caption saying "read 277" sends people round a loop that
              // never ends. The full sentence is in TableTypeNote() above.
              "⚠️  Blocked until a sweep has recorded the A8's TABLE_TYPE (277) — see above";
        }
        if (onBike() === null) {
          return "✏️  Read it off the bike first — a write is compared against what is there now";
        }
        // Each disabled state says which of the two things is missing rather than
        // sharing one caption: "nothing has read it" and "you have not said what to
        // write" are fixed by different taps in different places.
        if (wanted.val.trim().length === 0) {
          return selectedTarget()?.control.kind === "bits"
            ? "✏️  Pick what to set the bit to"
            : "✏️  Type the value to write";
        }
        const change = describeChange();
        return armed.val === "write" ? `⚠️  Tap again to write  ${change}` : `✏️  Write  ${change}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      onBike() === null
        ? "Every write is a compare-and-swap: the Pi re-reads the parameter and refuses if it has moved since it was read."
        : "The Pi will re-read this parameter, write, and read it back — and say so loudly if the read-back disagrees, or if the bike does not hold what is shown on the left."
    )
  );
}

/**
 * `MAX_DC_CHG_CURRENT: 75 → 80`, or `VSM_CONFIG_1: Heated handlebars → ON`. What the
 * two taps are agreeing to.
 *
 * ⚠️ The PARAMETER NAME is in here and must stay. This caption is the one place a
 * person commits, and it is the only thing besides the picker that names what is about
 * to be written — so a picker showing the wrong parameter is contradicted here rather
 * than agreed with. `75 → 80` alone reads identically for four of the five entries at
 * plausible values, which is exactly the reading a bare number cannot survive.
 */
function describeChange() {
  const target = selectedTarget();
  const known = onBike();
  if (!target || !known) {
    return "";
  }
  if (target.control.kind === "bits") {
    const [key, on] = wanted.val.split(":");
    const bit = target.control.bits.find(candidate => candidate.key === key);
    return bit ? `${target.name}: ${bit.label} → ${on === "1" ? "ON" : "OFF"}` : "";
  }
  return `${target.name}: ${known.value} → ${wanted.val}`;
}

/**
 * What the last write did, and — only once it has been done — how to check the bike
 * for yourself.
 *
 * ⚠️ The verification hint is deliberately not shown before the write. It is an
 * instruction for afterwards ("0x625 b2 should now read…"), it was one of four amber
 * paragraphs competing with the ones that argue against pressing the button at all, and
 * standing in a garage the moment it becomes useful is the moment the write has landed.
 */
function Outcome() {
  return div({ class: "action-note" }, () => {
    const done = lastWrite.val;
    const target = selectedTarget();
    const verify =
      // Both the clean write and the read-back mismatch get it: the mismatch is exactly
      // the case where an independent check is worth most. A refusal or a stale
      // precondition changed nothing, so there is nothing to go and look at.
      done && target && done.name === target.name && (done.succeeded || done.status === "read-back-mismatch")
        ? target.verify
        : null;
    return div(
      message.val ? div(message.val) : div(),
      verify ? div({ style: `color:${WATCH}`, class: "action-note" }, `🔍  ${verify}`) : div()
    );
  });
}

/**
 * The four service actions — one read, three that cannot be undone.
 *
 * ⚠️ They used to be four identical grey rectangles in a row, so "read the
 * last-service date and odometer" and "clear the stored trouble codes" looked the
 * same until you had read both. Now only the read one is on screen; the other three
 * are behind a fold, in the red tier, with the sentence each of them cannot take
 * back in red under it.
 *
 * Each still arms independently, and arming one disarms the others — so a thumb
 * travelling down the list cannot walk its way through two of them.
 *
 * ⚠️ That is NOT what stops a double-tap, and this comment used to say it was. Arming
 * one control says nothing about the same control being hit twice, and until it was
 * measured (2026-08-19, 390x844) that was exactly what happened: two synchronous clicks
 * on "Say a service was performed NOW" POSTed `31 FC` for real. What stops it is the
 * dwell between arming and firing — see ARM_DWELL_MS.
 */
function ServiceActions() {
  return div(
    h3({ class: "sheet-title" }, "Service actions"),
    // Outside the fold, deliberately: it changes nothing, and it is the action you
    // want BEFORE the service point below — which stamps the bike's own clock and
    // odometer over whatever this one shows you.
    ActionButton("read-service-stamp", () => "📖  Read the last-service date and odometer", {
      confirm: "ask the A8 for the service stamp",
      does: "Reads four identifiers on the A8 that no sweep covers. Read-only.",
      caution:
        "⚠️ Untried: nothing has ever read these off this bike, so a refusal may simply mean it does not carry a service stamp.",
    }),
    IrreversibleActions()
  );
}

/**
 * The three actions with no undo, behind one fold.
 *
 * ⚠️ The fold is the safety part of this section, not the decoration. This dashboard
 * is used on a handlebar-mounted phone, and the sheet is a long scroll: styling alone
 * still leaves `31 FC` and Mode 04 as things a thumb can arrive at while trying to
 * reach something else. Collapsed, there is nothing there to arrive at.
 *
 * The same idiom as the parameter warnings' toggle — counted, caret-ended, coloured
 * for what is behind it — rather than a second kind of disclosure, and the count is in
 * the label so the fold says what it is hiding without being opened.
 *
 * ⚠️ Toggling DISARMS. Otherwise collapsing the fold over a half-confirmed action
 * would leave a primed button waiting off screen for its second tap; re-opening the
 * sheet already resets both (see refreshVcuWrite), and this closes the same hole for
 * the fold itself.
 */
function IrreversibleActions() {
  return div(
    // ⚠️ The wrapper carries the closing rule, so it is there whether the fold is open
    // or shut. On the opened group it existed only while open, which left "Recently
    // written" hanging under the red panel with no divider in the state the sheet
    // spends most of its life in — while every other section boundary had one.
    { class: "risk-group" },
    button(
      {
        class: "code-toggle risk-fold",
        // The fold hides `31 FC` and Mode 04, so a screen reader has to be told it is
        // a disclosure and which way it is currently pointing. The caret cannot say
        // that; it is a glyph.
        "aria-expanded": () => String(dangerOpen.val),
        onclick: () => {
          dangerOpen.val = !dangerOpen.val;
          armed.val = "";
        },
      },
      // ⚠️ The SENTENCE does not change between states — only the caret turns. It
      // used to grow a "hide the" in front of itself, which changed the width and the
      // grammar of the one control standing between a thumb and Mode 04, so the eye
      // had to re-find it after every tap. And no glyph: 🚨 at this size is an
      // anonymous red blob, and the row is already red and full width.
      () =>
        `${IRREVERSIBLE_COUNT} action${IRREVERSIBLE_COUNT === 1 ? "" : "s"} that cannot be undone  ` +
        `${dangerOpen.val ? "▴" : "▾"}`,
      // The contents, under the caveat rather than instead of it. Somebody at the bike
      // who came for the clock should not have to open the drawer to learn the clock
      // is in it — but why it is shut is still the first thing worth reading.
      //
      // Only while SHUT: open, the three buttons are spelled out directly underneath,
      // and a list naming them a few pixels above is the same information twice.
      () =>
        dangerOpen.val
          ? span()
          : span({ class: "risk-fold-contents" }, IRREVERSIBLE.map(entry => entry.name).join("  ·  "))
    ),
    () => (dangerOpen.val ? div({ class: "danger-zone" }, ...IRREVERSIBLE.map(entry => entry.render())) : div())
  );
}

/**
 * One entry behind the fold: what it is called, what it asks the Pi for, and how to
 * build it.
 *
 * @typedef {{ name: string, action: "set-service-point" | "sync-clock" | "clear-dtcs",
 *   render: () => Element }} IrreversibleAction
 */

/**
 * The irreversible actions — ONE list, not a list and a parallel array beside it.
 *
 * ⚠️ Everything the page says about this drawer is read off here: how many there are
 * (the fold's label and the section's risk line), and what they are called (the fold's
 * contents line). A literal 3, or a hand-written list of names kept alongside, fails in
 * the direction that matters — the drawer goes on promising three things while holding
 * a fourth, or naming the wrong three, and it does it silently.
 *
 * ⚠️ The names used to be a parallel array checked against this one FOR LENGTH, and
 * reported by `console.warn` — on a page whose deployment target is a handlebar-mounted
 * phone, where nobody has a console open, ever. Reordering the list or swapping an
 * action left the fold confidently naming things it did not hold, with the guard green.
 * Both halves are fixed here: the names cannot drift because they are not stored twice,
 * and what CANNOT be made structural — that these are exactly the actions the Pi
 * refuses without a confirmation, in this order — is asserted in
 * scripts/check-irreversible-actions.ts, under `npm test`, where a red build says it.
 *
 * `render` is a thunk, not a node, for two reasons: the fold rebuilds its contents on
 * every open, and — the safety one — nothing behind the fold is CONSTRUCTED while it is
 * collapsed, so "there is nothing there to arrive at" stays literally true of the DOM.
 * The clock is not an `ActionButton` because its second tap agrees to a fact ("is it
 * 14:03?") rather than to an intention, so it writes its own confirmation.
 *
 * @type {IrreversibleAction[]}
 */
export const IRREVERSIBLE = [
  {
    name: "Service stamp",
    action: "set-service-point",
    render: () =>
      ActionButton("set-service-point", () => "🔧  Say a service was performed NOW", {
        confirm: "STAMP A SERVICE NOW. There is no unset",
        noUndo: "There is no unset.",
        does: "Runs 31 FC on the A8. It takes no parameters — the bike stamps its OWN clock and odometer.",
        caution:
          "⚠️ Read the stamp above first, and make sure the bike's clock is right — the bike's clock is what it stamps.",
      }),
  },
  { name: "Bike clock", action: "sync-clock", render: ClockAction },
  {
    name: "Clear codes",
    action: "clear-dtcs",
    render: () =>
      ActionButton("clear-dtcs", () => "🧹  Clear the stored trouble codes", {
        confirm: "WIPE the stored codes and their freeze frame",
        noUndo: "The freeze frame goes with the codes.",
        does: "OBD Mode 04 — clears every code the bike currently holds stored.",
        caution:
          "⚠️ This bike's stored list has been accumulating since before anyone started looking. Codes whose faults are still active come straight back.",
      }),
  },
];

const IRREVERSIBLE_COUNT = IRREVERSIBLE.length;

/**
 * The clock sync, which needs its own button because its confirmation is a question
 * about a fact rather than about an intention.
 *
 * The caption IS the dialog the owner asked for — "Is it <date and time>?" — and the
 * time in it is echoed back to the Pi, which refuses if that minute has passed. So
 * the two taps are not just two taps: the second one asserts that the time shown in
 * the first is still true.
 */
/**
 * ⚠️ Starts with the same shouted token as the other two, on purpose: the red line is
 * one slot in three cards, and a slot that holds a token on two of them and a sentence
 * on the third is not a slot. What comes AFTER the dash is where this one differs, and
 * it differs in the direction that matters — you can set the clock again, but nothing
 * can tell you what it held before or that this landed at all.
 */
const CLOCK_NO_UNDO = "The bike's clock cannot be read back, so nothing can confirm this landed.";

function ClockAction() {
  return div(
    { class: "action-block" },
    // Above the button, for the reason ActionButton sets out: on a phone the thumb
    // arrives before the eye does. Shown only when the button can actually do
    // something — a Pi whose clock is not fit to copy has a disabled button and
    // nothing that cannot be undone, and its own red line is below instead.
    // Through NoUndoLine, not hand-rolled: rendering the div here meant this one card
    // was the only one whose red line had no IRREVERSIBLE badge, which is exactly the
    // inconsistent-slot problem the badge exists to remove.
    () => (state.val?.status.clock.trustworthy === true ? NoUndoLine({ noUndo: CLOCK_NO_UNDO, does: "" }) : div()),
    button(
      {
        class: "action irreversible",
        disabled: () => busy.val || !canReach() || state.val?.status.clock.trustworthy !== true,
        // One held Enter must not arm and then fire. See refuseKeyRepeat.
        onkeydown: refuseKeyRepeat,
        onclick: () => {
          if (armed.val !== "action:sync-clock") {
            // ⚠️ The FIRST tap refreshes before it arms, so the time the caption then
            // shows is the Pi's time now rather than the Pi's time when the sheet was
            // opened. Without this the owner could be asked "Is it 09:15 UTC?" at
            // 10:20 and truthfully answer no useful question at all.
            void armClockSync();
            return;
          }
          // The same dwell as every other second tap. This control happened to survive
          // a double-tap already, because armClockSync() awaits a refresh that disables
          // the button in between — but that was the refresh's side effect, not a
          // guard, and it would go the moment the refresh did. See ARM_DWELL_MS.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          // ⚠️ The minute CONFIRMED is derived from the one that was DISPLAYED, never
          // from the phone's own clock. They are two different clocks: sending
          // `new Date()` would mean the Pi checked the phone's freshness while the
          // owner had agreed to a statement about the Pi — so a stale caption would
          // sail through, and a phone a minute out of step could never sync at all.
          void performAction("sync-clock", confirmedMinute());
        },
      },
      () => {
        const clock = state.val?.status.clock;
        if (!clock) {
          return "🕒  …";
        }
        if (!clock.trustworthy) {
          return "🕒  This Pi's clock cannot be copied to the bike";
        }
        return armed.val === "action:sync-clock"
          ? `⚠️  Is it ${clock.iso.slice(0, 19).replace("T", " ")} UTC?  Tap again to send`
          : "🕒  Set the bike's clock from this Pi";
      }
    ),
    () => {
      const clock = state.val?.status.clock;
      if (!clock) {
        return div();
      }
      if (!clock.trustworthy) {
        // Every reason, not the first. "No satellite time AND the clock reads 2060"
        // is a different situation from either alone, and the second one is how you
        // find out the GPS decode is broken rather than the sky being blocked.
        //
        // Red, but NOT the `no-undo` class: the button is disabled, so there is
        // nothing here that cannot be undone. This is red because something is
        // broken, and `no-undo` means one specific thing that this is not.
        return div(
          div({ class: "action-note", style: `color:${BAD}` }, `The Pi reads ${clock.iso}, and it is not fit to copy:`),
          ...clock.reasons.map(reason => div({ class: "action-note", style: `color:${MUTED}` }, `· ${reason}`))
        );
      }
      // No `noUndo` here — it is rendered above the button, where the thumb passes it.
      return NoteBlock({
        does:
          `Checked against satellite time (${clock.offsetFromGpsSeconds.toFixed(1)} s apart). ` +
          "The bike's clock is what the service point stamps.",
      });
    }
  );
}

/**
 * The three kinds of sentence a control carries, which are read at three different
 * moments and are therefore ranked rather than run together.
 *
 * They were one undifferentiated amber block, and it flattened the distance between
 * "it will probably do nothing" and "IRREVERSIBLE. There is no unset." — the same
 * colour, the same size, the same paragraph.
 *
 * @typedef {{ noUndo?: string, does: string, caution?: string }} ActionNotes
 */

/**
 * The prose plus the tail of the caption the SECOND tap agrees to.
 *
 * `confirm` is not prose — it is on the control, not under it — but it is declared
 * alongside so the two cannot drift apart. Separate from `ActionNotes` because the
 * clock action writes its own confirmation (it asks a question about the time rather
 * than about an intention) while still rendering the same three ranked sentences.
 *
 * @typedef {ActionNotes & { confirm: string }} ConfirmableAction
 */

/**
 * @param {"read-service-stamp" | "set-service-point" | "clear-dtcs"} action
 * @param {() => string} caption
 * @param {ConfirmableAction} notes
 */
function ActionButton(action, caption, notes) {
  const key = `action:${action}`;
  // Derived from the prose rather than passed alongside it, so the tier a button is
  // painted and the sentence it carries cannot disagree: a red button with no line
  // saying what it cannot take back is now unexpressible.
  const irreversible = notes.noUndo !== undefined;
  return div(
    // `action-block` is one control and the prose that belongs to it. It exists so the
    // gap BETWEEN two actions can be bigger than the gap between an action and its own
    // notes — otherwise "read the stamp above first" sits as close to the next button
    // as to the one it is about, which on this list is a sentence attached to the
    // wrong irreversible action.
    { class: "action-block" },
    // ⚠️ ABOVE the button, not under it. On a phone, reading order IS tap order: with
    // the consequence underneath, the thumb reaches a 55 px target before the eye
    // reaches the sentence saying the target cannot be undone. The one line that could
    // stop somebody has to be crossed on the way to the control, not found after it.
    // Everything that is not a consequence — what it does, what to check first — stays
    // below, where it is read once you have decided to look properly.
    NoUndoLine(notes),
    button(
      {
        class: `action${irreversible ? " irreversible" : ""}`,
        disabled: () => busy.val || !canReach(),
        // One held Enter must not arm and then fire. See refuseKeyRepeat.
        onkeydown: refuseKeyRepeat,
        onclick: () => {
          if (armed.val !== key) {
            arm(key);
            return;
          }
          // ⚠️ This is the line that stops a double-tap running `31 FC`, and it is the
          // only thing between these two taps — everything else on this control is
          // synchronous. Before it existed, two clicks 0 ms apart POSTed
          // `action=set-service-point&confirm=set-service-point` for real. Ignored, not
          // disarmed: the caption still says "Tap again" and still means it.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performAction(action, confirmationFor(action));
        },
      },
      // ⚠️ The confirmation NAMES WHAT IS PRIMED, and that is not decoration. It used
      // to be one shared sentence — "Tap again — this cannot be undone" — on all
      // three, so an armed button said only that something irreversible was armed,
      // never which. The parameter write has named its target in this exact spot
      // since #81 for the same reason (see describeChange): the caption is the one
      // place a person commits, and a thumb that landed on the wrong control is
      // exactly the case it exists to catch.
      () => (armed.val === key ? `⚠️  Tap again — ${notes.confirm}` : caption())
    ),
    NoteBlock(notes)
  );
}

/**
 * The one line that has to be read before the button underneath it is pressed.
 *
 * ⚠️ Bigger and heavier than the other two kinds of note, not just redder. Red is the
 * dimmest ink this palette has — #f87171 measures 6.5:1 on the sheet where a heading
 * measures 14.5:1 — so a page that carries severity in hue alone puts its most
 * consequential sentence at the BOTTOM of its own contrast ranking, under every
 * throwaway grey line on the screen. Weight and size are the channels that survive
 * that, and they are also the two that survive daylight through a visor.
 *
 * No glyph: at this size 🚨 renders as an anonymous red smudge, and the line is
 * already red and already begins with the word IRREVERSIBLE.
 *
 * @param {ActionNotes} notes
 */
function NoUndoLine(notes) {
  if (notes.noUndo === undefined) {
    return div();
  }
  // ⚠️ The category is a BADGE and the consequence is the sentence, rather than both
  // being one shouted string. "IRREVERSIBLE" appeared five times in a screen and a
  // half — section deck, fold label, and once per card — at which point it stops being
  // read at all, while the only new information on each card is what came after the
  // dash. The badge is identical on all three because the category is; what differs
  // gets the weight.
  return div({ class: "action-note no-undo" }, span({ class: "no-undo-badge" }, "IRREVERSIBLE"), notes.noUndo);
}

/**
 * What it does, and why you might not want to — the two that belong AFTER the control.
 *
 * Neither is a consequence. `does` is how you confirm you are on the right button and
 * `caution` is the argument against pressing it, and both are read at leisure by
 * somebody who has already decided to look properly. The consequence went above the
 * button; see NoUndoLine.
 *
 * @param {ActionNotes} notes
 */
function NoteBlock(notes) {
  return div(
    div({ class: "action-note" }, notes.does),
    notes.caution === undefined ? div() : div({ class: "action-note caution" }, notes.caution)
  );
}

/**
 * The last few journal lines. The record of what has been done to this motorcycle.
 *
 * ⚠️ The lines are a SIBLING of the heading, not children of it. They were children,
 * which put every one of them inside a `.sheet-title` — so the record of what has been
 * done to the bike rendered as tiny grey SMALL CAPS WITH WIDE TRACKING, because
 * `text-transform`, `letter-spacing` and `color` all inherit. The `.action-note` on
 * them only ever overrode the font size.
 */
function Journal() {
  return div(
    h3({ class: "sheet-title" }, "Recently written"),
    div({ class: "action-note" }, () => {
      const recent = state.val?.status.recent ?? [];
      if (recent.length === 0) {
        return div({ style: `color:${MUTED}` }, "Nothing has been written from this Pi.");
      }
      return div(...recent.map(JournalLine));
    })
  );
}

/** @param {AuditRecord} record */
function JournalLine(record) {
  const when = new Date(record.at).toISOString().slice(0, 16).replace("T", " ");
  const what = record.name ? `${record.name} ${record.before ?? "?"} → ${record.after ?? "?"}` : record.action;
  return div(
    {
      style: `color:${record.status === "written" || record.status === "started" || record.status === "cleared" || record.status === "sent" ? MUTED : WARN}`,
    },
    // The clock caveat rides on every line rather than being explained once at the
    // top: these lines get read one at a time, months apart, and a timestamp this Pi
    // could not vouch for should say so where it is read.
    `${when}${record.clockTrustworthy ? "" : " (clock unverified)"} · ${what} · ${record.status}`
  );
}

function selectedTarget() {
  return state.val?.status.targets.find(target => target.name === selected.val) ?? null;
}

function canReach() {
  const status = state.val?.status;
  return status !== undefined && status.enabled && status.gate.safe;
}

/**
 * `canReach` plus the table-type gate. Used by the write button ONLY.
 *
 * ⚠️ Kept separate from `canReach` rather than folded into it, and the separation is
 * the whole design. `canReach` still governs the read button and the four service
 * actions, so an unconfirmed table blocks writing by index and leaves everything else
 * exactly as it was — including the read that clears it. Folding this in would produce
 * a page that refuses to let you fix the thing it is refusing over.
 *
 * The server enforces the same precondition twice more regardless (the runner refuses
 * the request, and src/vcu/write-codec.ts refuses to encode the frame). This is the
 * page declining to offer a button whose request would be refused, which is the same
 * relationship it has to the allowlist and the compare-and-swap.
 */
function canWrite() {
  return canReach() && state.val?.status.tableGate.writesAllowed === true;
}

/**
 * What the bike holds for the selected parameter, and where that number came from.
 *
 * ⚠️ TWO sources, ranked, and the ranking is the point:
 *
 *   bus    a value this page read itself — the probe button, or the read-back at the end
 *          of a write. Always wins: it is the newest thing anybody here knows, and after
 *          a write it is the only one that is right, because the sweep's snapshot still
 *          says what the parameter used to be.
 *   sweep  what the last recorded parameter sweep found (server-side, per allowlist
 *          entry). This is what stops the form saying "not read yet" to somebody who
 *          has just read all 277 parameters.
 *
 * Null when neither has it, which is a real state — a Pi that has never swept — and the
 * write button stays disabled saying so.
 *
 * The reading is only handed back when it belongs to the selected parameter, so no
 * ordering of events can show one parameter's value against another's name.
 * @returns {OnBike | null}
 */
function onBike() {
  const target = selectedTarget();
  if (!target) {
    return null;
  }
  const fresh = reading.val;
  if (fresh && fresh.name === target.name) {
    return { value: fresh.value, rawHex: fresh.rawHex, label: null, source: "bus", readAt: null, complete: true };
  }
  const swept = target.onBike;
  if (!swept) {
    return null;
  }
  return {
    value: swept.value,
    rawHex: swept.rawHex,
    label: swept.label,
    source: "sweep",
    readAt: swept.readAt,
    complete: swept.complete,
  };
}

/**
 * Everything the form holds about the parameter that was selected. Called when the
 * selection changes, and on every sheet open.
 *
 * The arming goes with it, always: a value typed for one parameter must not stay armed
 * against another.
 */
function forgetSelection() {
  reading.val = null;
  wanted.val = "";
  armed.val = "";
  lastWrite.val = null;
  message.val = "";
  // Collapsed again for the newly selected parameter. Its warnings are not the ones
  // that were just read, and an unfolded block would look like they are.
  warningsOpen.val = false;
}

/**
 * What the second tap sends as `confirm=` — the Pi's precondition for every action it
 * will not perform on one request.
 *
 * ⚠️ PROTOCOL, not prose. `notes.confirm` is the caption tail and may be rewritten
 * freely; this is the string src/http/vcu-write.ts compares against, and getting it
 * wrong does not read wrong — it makes `31 FC` and Mode 04 refuse on every press with
 * a 400 nobody expected.
 *
 * One function rather than the rule living at each `performAction` call site, because
 * scripts/check-irreversible-actions.ts asserts these against the server's own parser
 * and a check holding its own copy of the rule would agree with itself while the page
 * had moved. It is the same parallel-array shape this section removed from the fold's
 * contents list, and it does not get to come back in the check that guards it.
 *
 * @param {string} action
 * @param {string} displayedIso the Pi's `clock.iso` exactly as the caption showed it
 */
export function confirmationFor(action, displayedIso = "") {
  if (action === "sync-clock") {
    // The minute the button is currently SHOWING, in the shape the server checks:
    // `2026-08-16T14:03Z`. Sliced out of the Pi's own `clock.iso`, so the value
    // confirmed and the value displayed are the same string from the same clock. If the
    // sheet has gone stale the server refuses and names both minutes — the intended
    // behaviour, and the refusal itself refreshes the state so the next attempt shows
    // the right time.
    return `${displayedIso.slice(0, 16)}Z`;
  }
  // Everything else confirms by naming itself. The server wants `confirm=clear-dtcs`
  // for `action=clear-dtcs`: the point is that a request cannot be built by guessing
  // the action name alone, not that the token is unguessable.
  return action;
}

/** The clock's confirmation, from the reading currently on screen. See confirmationFor. */
function confirmedMinute() {
  return confirmationFor("sync-clock", state.val?.status.clock.iso ?? "");
}

/** Refreshes the Pi's clock reading, then arms — so the time in the caption is its time now. */
async function armClockSync() {
  busy.val = true;
  try {
    await fetchStatus();
  } finally {
    busy.val = false;
  }
  // Only arms if the refreshed verdict still allows it. A clock that has drifted out
  // of GPS agreement since the sheet opened must not leave a primed button behind.
  if (state.val?.status.clock.trustworthy === true) {
    arm("action:sync-clock");
  }
}

async function readCurrent() {
  const target = selectedTarget();
  if (!target) {
    return;
  }
  busy.val = true;
  message.val = "";
  try {
    const query = new URLSearchParams({ target: target.micro, bank: "1", index: String(target.index) });
    const response = await fetch(`/vcu-probe?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    // Typed off the server's own source, like every other fetch in this dashboard —
    // an untyped `json()` here would let a renamed field through silently, and the
    // field in question is the one a write is compared against.
    const payload = /** @type {VcuProbeResponse} */ (await response.json());
    const answer = payload.reading;
    if (!answer || answer.status !== "read" || answer.value === null) {
      // No fallback to `unsigned`, deliberately. A write is compared against the
      // TYPED value, and using a differently-typed number as the precondition is how
      // a signed parameter gets written from an unsigned reading of itself.
      //
      // ⚠️ And the failed read does NOT clear a value the sweep already had. It failed;
      // that says nothing about what the parameter holds, and dropping a good older
      // reading on the strength of a timeout would be inventing information. The
      // message below says the read failed, and the caption under the value goes on
      // saying where it came from.
      message.val = `Could not read ${target.name}: ${answer?.note ?? payload.message ?? "no answer"}`;
      return;
    }
    reading.val = { name: target.name, value: answer.value, rawHex: answer.rawHex ?? null };
    // A fresh reading disarms whatever was armed: the number the first tap agreed to
    // may not be the number on screen any more.
    armed.val = "";
  } catch (error) {
    message.val = `could not reach the Pi — ${error instanceof Error ? error.message : String(error)}`;
    console.warn("vcu-write: read failed", error);
  } finally {
    busy.val = false;
  }
}

/**
 * Refreshes, THEN arms — so the number the second tap agrees to is the Pi's answer now.
 *
 * ⚠️ Exactly what armClockSync() does one section below, for the same reason and it is
 * the same failure: a sheet opened in the kitchen and used at the bike twenty minutes
 * later was showing an age computed when it opened. Nothing polls /vcu-write while the
 * sheet is open — deliberately — so without this the caption "from the parameter sweep
 * just now" could still be on screen long after it stopped being true, and the age is
 * the entire basis on which an old reading is an acceptable precondition.
 *
 * ⚠️ And if the value MOVED across that refresh, this does not arm. The caption now
 * shows a different number from the one that was tapped, and a second tap must agree to
 * what is on screen rather than to what was. (fetchStatus() disarms on its own for the
 * same reason; this function is what re-arms deliberately, and only when nothing moved.)
 */
async function armWrite() {
  const before = onBike();
  const name = selectedTarget()?.name;
  busy.val = true;
  try {
    await fetchStatus();
  } finally {
    busy.val = false;
  }
  const after = onBike();
  if (after && before && after.value === before.value && selectedTarget()?.name === name && canWrite()) {
    arm("write");
  }
}

async function performWrite() {
  const target = selectedTarget();
  const known = onBike();
  if (!target || !known) {
    return;
  }
  // `expected` is the number that was ON SCREEN, whichever source it came from. The Pi
  // re-reads the parameter and refuses if the bike disagrees with it, so this is a
  // claim being checked rather than a claim being trusted.
  const query = new URLSearchParams({ name: target.name, expected: String(known.value) });
  if (target.control.kind === "bits") {
    const [bit, on] = wanted.val.split(":");
    query.set("action", "bit");
    query.set("bit", bit);
    query.set("on", on);
  } else {
    query.set("action", "parameter");
    query.set("value", wanted.val.trim());
  }
  const name = target.name;
  writing.val = true;
  let payload;
  try {
    payload = await send(query);
  } finally {
    writing.val = false;
  }
  armed.val = "";

  // ⚠️ THE ANSWER IS TAKEN FROM THIS REQUEST'S OWN RESPONSE, never from `state.val`.
  // `send()` leaves the state alone when the request does not come back, so reading the
  // verdict out of the state would attribute the LAST write's result — including its
  // "written", its read-back and the verification hint — to an attempt that may have
  // reached the bike and may have done anything at all.
  if (!payload) {
    // The worst case, and it stays the worst case: nothing is claimed about the
    // parameter, and the reading goes, because the frame may well have gone out. The
    // message send() set says so at length. The next write has to read first.
    lastWrite.val = null;
    reading.val = null;
    return;
  }
  if (!payload.result) {
    // 400 or 409: refused BEFORE the bus — a malformed query, a busy bus, a closed
    // gate. Nothing was read and nothing was written, so the reading on screen is
    // exactly as true as it was a second ago and is kept, along with what was typed:
    // the answer to "the sweep is using the bus" is to wait and press it again, not to
    // start over. `message` carries the server's reason.
    return;
  }
  const result = payload.result;
  lastWrite.val = { name, status: result.status, succeeded: result.succeeded };
  // What the bike holds NOW, from the read-back the write itself did — so the value on
  // screen is the one that is true afterwards rather than the one the sweep recorded
  // before. Cleared when the attempt reached the bus and produced no reading (refused
  // at the session or security step, or a failure partway): the write may have landed,
  // so the page falls back to the sweep's older value, correctly labelled as old, and
  // the Pi re-reads before any second attempt exactly as it did before this one.
  reading.val = result.onBike
    ? { name: result.onBike.name, value: result.onBike.value, rawHex: result.onBike.rawHex }
    : null;
  wanted.val = "";
}

/**
 * @param {string} action
 * @param {string} confirmation
 */
async function performAction(action, confirmation) {
  await send(new URLSearchParams({ action, confirm: confirmation }));
}

/**
 * POSTs one action and hands back what came of it.
 *
 * ⚠️ Returns the payload, or **null when the request did not come back at all** — and
 * the difference is the whole reason it returns anything. A caller that instead read
 * the verdict out of `state.val` would find the PREVIOUS action's result sitting there,
 * because the transport-failure branch below deliberately leaves the state alone, and
 * would report that action's success as this one's.
 *
 * @param {URLSearchParams} query
 * @returns {Promise<VcuWriteResponse | null>}
 */
async function send(query) {
  busy.val = true;
  message.val = "";
  try {
    const response = await fetch(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      // A DIFFERENT value from the read endpoints' `service-mode`, so a caller built
      // for those cannot reach this one. See src/http/vcu-write.ts.
      headers: { "X-Cool-Eva": "service-write" },
    });
    // The body carries the status and the journal on every code this endpoint
    // returns, including 400 and 409, so it is read before the status is judged.
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    state.val = payload;
    message.val = payload.result?.message ?? payload.message ?? "";
    return payload;
  } catch (error) {
    // ⚠️ The worst case on this page, and it is said as such. A write request that
    // did not come back may still have reached the bike — the frame goes out before
    // the response comes back — so "it failed" would be a claim nothing supports.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "⚠️ This does NOT mean nothing was written: the request may have reached the bike. Read the value back before trying again.";
    console.warn("vcu-write: request failed", error);
    return null;
  } finally {
    busy.val = false;
  }
}

/** @param {string} label @param {() => Element} control */
function Field(label, control) {
  return div({ class: "probe-field" }, div({ class: "probe-label" }, label), control());
}

/** Called by ./service-mode.js whenever the sheet opens. Refreshes, disarms and re-folds everything. */
export async function refreshVcuWrite() {
  armed.val = "";
  // Not in forgetSelection(): that also runs when the PARAMETER changes, and the
  // irreversible actions have nothing to do with which parameter is selected. This is
  // the sheet-opening reset, and re-folding belongs to it alone.
  dangerOpen.val = false;
  forgetSelection();
  await fetchStatus();
}

/**
 * Just the state — no disarming, no forgetting the reading.
 *
 * Kept apart from `refreshVcuWrite` because arming the clock sync needs a fresh
 * `clock.iso` and must not wipe a parameter reading somebody took thirty seconds ago;
 * `refreshVcuWrite` is the sheet-opening reset and deliberately does both.
 */
async function fetchStatus() {
  try {
    const response = await fetch("/vcu-write", { cache: "no-store" });
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    // ⚠️ Disarmed BEFORE the new status lands, always. A refresh can bring a different
    // value for the selected parameter — a sweep that finished while the sheet was open
    // rewrites `onBike` under it — and a button armed against 75 must not fire against
    // 80 because a second tap happened to come after the refresh. The clock sync arms
    // itself again immediately afterwards, deliberately and from the refreshed reading;
    // see armClockSync().
    armed.val = "";
    state.val = payload;
    if (selected.val === "" && payload.status.targets.length > 0) {
      selected.val = payload.status.targets[0].name;
    }
  } catch (error) {
    // Loud. A section that silently renders nothing looks like a bike with nothing
    // writable, which is a different claim from "the Pi did not answer".
    message.val = `could not reach /vcu-write — ${error instanceof Error ? error.message : String(error)}`;
    console.warn("vcu-write: status fetch failed", error);
  }
}
