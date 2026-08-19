// @ts-check

import van from "../vendor/van-1.6.1.js";
import { BAD, GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { ageInWords } from "../lib/format.js";

const { button, div, input, option, select, span } = van.tags;

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
//  3. **Two taps, never one.** The first arms and the second sends, and arming is
//     dropped by ANY change to the form — retyping the value, picking a different
//     parameter, a refreshed reading, or a refreshed status. That last one matters: it
//     means a value that moved under you disarms the button rather than being written.
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
    // ⚠️ Both the amber and the line under it drop when SERVICE_WRITE_ENABLED=0,
    // because there is then nothing below to warn about — the section renders one
    // sentence saying the switch is off, and "everything below here can change the
    // motorcycle" directly above it would be false. Amber is the default while
    // nothing has answered yet: an unknown answer should look like the dangerous
    // one, not like the safe one.
    div({ class: () => `sheet-heading${writesAreOff() ? "" : " writes"}` }, "Change something on the bike"),
    () =>
      writesAreOff()
        ? div()
        : div({ class: "sheet-heading-note" }, "Writes. Everything below here can change the motorcycle."),
    Availability(),
    () => (state.val?.status.enabled ? div(ParameterForm(), ServiceActions(), Journal()) : div())
  );
}

/** Explicitly off, as opposed to not yet answered. See the heading above. */
function writesAreOff() {
  return state.val?.status.enabled === false;
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
      return div({ style: `color:${MUTED}` }, "…");
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
  return div({ class: "probe-input", style: "display:flex; align-items:center" }, () => {
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
 * Each still arms independently — arming one disarms the others, so a thumb
 * travelling down the list cannot double-tap its way through two of them.
 */
function ServiceActions() {
  return div(
    div({ class: "sheet-title" }, "Service actions"),
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
    button(
      {
        class: "code-toggle risk-fold",
        onclick: () => {
          dangerOpen.val = !dangerOpen.val;
          armed.val = "";
        },
      },
      () =>
        dangerOpen.val ? "🚨  hide the 3 actions that cannot be undone  ▴" : "🚨  3 actions that cannot be undone  ▾"
    ),
    () =>
      dangerOpen.val
        ? div(
            { class: "danger-zone" },
            ActionButton("set-service-point", () => "🔧  Say a service was performed NOW", {
              confirm: "STAMP A SERVICE NOW. There is no unset",
              noUndo: "IRREVERSIBLE — there is no unset.",
              does: "Runs 31 FC on the A8. It takes no parameters — the bike stamps its OWN clock and odometer.",
              caution:
                "⚠️ Read the stamp above first, and make sure the bike's clock is right — the bike's clock is what it stamps.",
            }),
            ClockAction(),
            ActionButton("clear-dtcs", () => "🧹  Clear the stored trouble codes", {
              confirm: "WIPE the stored codes and their freeze frame",
              noUndo: "IRREVERSIBLE — the freeze frame goes with the codes.",
              does: "OBD Mode 04.",
              caution:
                "⚠️ This bike's stored list has been accumulating since before anyone started looking. Codes whose faults are still active come straight back.",
            })
          )
        : div()
  );
}

/**
 * The clock sync, which needs its own button because its confirmation is a question
 * about a fact rather than about an intention.
 *
 * The caption IS the dialog the owner asked for — "Is it <date and time>?" — and the
 * time in it is echoed back to the Pi, which refuses if that minute has passed. So
 * the two taps are not just two taps: the second one asserts that the time shown in
 * the first is still true.
 */
function ClockAction() {
  return div(
    { class: "action-block" },
    button(
      {
        class: "action irreversible",
        disabled: () => busy.val || !canReach() || state.val?.status.clock.trustworthy !== true,
        onclick: () => {
          if (armed.val !== "action:sync-clock") {
            // ⚠️ The FIRST tap refreshes before it arms, so the time the caption then
            // shows is the Pi's time now rather than the Pi's time when the sheet was
            // opened. Without this the owner could be asked "Is it 09:15 UTC?" at
            // 10:20 and truthfully answer no useful question at all.
            void armClockSync();
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
      return NoteBlock({
        // Not the word IRREVERSIBLE, because this one is subtly worse than the other
        // two: you can set the clock again, but nothing can tell you what it held
        // before or that this landed at all. That is the fact worth having in red.
        noUndo: "No read-back: nothing can confirm this landed, or say what the clock said before.",
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
    button(
      {
        class: `action${irreversible ? " irreversible" : ""}`,
        disabled: () => busy.val || !canReach(),
        onclick: () => {
          if (armed.val !== key) {
            armed.val = key;
            return;
          }
          armed.val = "";
          void performAction(action, action);
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
 * The prose under one control, in the order it is worth reading.
 *
 * The no-undo line LEADS rather than following. Inside an opened fold every button is
 * irreversible, so what separates them is precisely what each one cannot take back —
 * "there is no unset", "the freeze frame goes with the codes", "nothing can confirm
 * this landed" — and that is the line a rider needs first, not third.
 *
 * @param {ActionNotes} notes
 */
function NoteBlock(notes) {
  return div(
    // No glyph in front of the red line, unlike the amber one's ⚠️. At 0.72rem 🚨
    // renders as an unreadable red smudge, and it would be leading a line that is
    // already red and already starts with the word IRREVERSIBLE. The fold's label
    // keeps its 🚨, where it is the only red thing on screen and has work to do.
    notes.noUndo === undefined ? div() : div({ class: "action-note no-undo" }, notes.noUndo),
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
    div({ class: "sheet-title" }, "Recently written"),
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
 * The minute the button is currently SHOWING, in the shape src/http/vcu-write.ts
 * checks against: `2026-08-16T14:03Z`.
 *
 * Sliced out of the Pi's own `clock.iso`, so the value confirmed and the value
 * displayed are the same string from the same clock. If the sheet has gone stale the
 * server refuses and names both minutes — which is the intended behaviour, and the
 * refusal itself refreshes the state so the next attempt shows the right time.
 */
function confirmedMinute() {
  const iso = state.val?.status.clock.iso ?? "";
  return `${iso.slice(0, 16)}Z`;
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
    armed.val = "action:sync-clock";
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
    armed.val = "write";
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
