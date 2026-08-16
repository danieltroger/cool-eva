// @ts-check

import van from "../vendor/van-1.6.1.js";
import { BAD, GOOD, MUTED, WARN } from "../lib/colors.js";

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
//  1. **You have to read the current value first.** The write button stays disabled,
//     saying so, until "Read it off the bike now" has fetched what the bike actually
//     holds. That value is sent back as `expected=`, and the Pi re-reads and refuses
//     if it has moved — so a page left open since yesterday cannot write over a value
//     it is not showing.
//  2. **The confirmation shows old → new**, spelled out in the button caption, and
//     the button changes what it says between the two taps.
//  3. **Two taps, never one.** The first arms and the second sends, and arming is
//     dropped by ANY change to the form — retyping the value, picking a different
//     parameter, or a refreshed reading. That last one matters: it means a value that
//     moved under you disarms the button rather than being written.
//  4. **The irreversible actions live in their own block**, below the parameters,
//     each with its own two taps and its own warning. They are not in a list you can
//     scroll a thumb through.
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

const state = van.state(/** @type {VcuWriteResponse | null} */ (null));
/** Which allowlist entry the form is on. Empty until the section has loaded. */
const selected = van.state("");
/** What the bike currently holds, as READ — null until "Read it now" has answered. */
const current = van.state(/** @type {number | null} */ (null));
/** The raw hex of that reading, so the page can show the bytes and not only the number. */
const currentHex = van.state("");
const wanted = van.state("");
/** Which control is armed, by a key like `write` or `action:clear-dtcs`. Empty means none. */
const armed = van.state("");
const busy = van.state(false);
const message = van.state("");

export function VcuWrite() {
  return div(div({ class: "sheet-title" }, "Change something on the bike"), Availability(), () =>
    state.val?.status.enabled ? div(ParameterForm(), ServiceActions(), Journal()) : div()
  );
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
 * ⚠️ The two blocked states are rendered DIFFERENTLY on purpose, in colour and in
 * words, because they are not the same problem:
 *
 *   mismatched (red)   the bike named a table this software does not carry. No read
 *                      helps; every parameter name on this page may belong to a
 *                      different parameter, and the fix is in the Pi's source.
 *   unread (amber)     nobody has asked the bike yet. One read clears it, and the
 *                      server's `remedy` names exactly which read — parameter, micro,
 *                      request bytes and expected answer.
 *
 * A single "writes are blocked" would send someone hunting for a software bug when the
 * answer was one frame, or the other way round. The sentences come from the Pi
 * (src/vcu/table-gate.ts) rather than being written again here: deciding what a
 * `TABLE_TYPE` reading means needs the parameter table, and a second copy of that
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
  const mismatched = table.state === "mismatched";
  return div(
    div(
      { style: `color:${mismatched ? BAD : WARN}` },
      mismatched
        ? "🚨  Parameter writes are blocked: this bike is running a parameter table this software does not have."
        : "⚠️  Parameter writes are blocked: nothing has confirmed which parameter table this bike runs."
    ),
    div({ style: `color:${MUTED}`, class: "action-note" }, table.reason),
    // The remedy is the reason this is a gate and not a wall, so it gets the emphasis
    // rather than the muted grey the reason sits in.
    div({ style: `color:${mismatched ? BAD : WARN}`, class: "action-note" }, table.remedy),
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
    div({ class: "probe-row" }, Field("On the bike", CurrentReading), Field("Change to", WantedControl)),
    ReadButton(),
    WriteButton(),
    () => (message.val ? div({ class: "action-note" }, message.val) : div())
  );
}

function ParameterSelect() {
  return select(
    {
      class: "probe-input",
      value: selected,
      onchange: (/** @type {Event} */ event) => {
        selected.val = /** @type {HTMLSelectElement} */ (event.target).value;
        // A different parameter means the reading on screen belongs to another one.
        // Cleared rather than kept, so the write button cannot appear next to a
        // number that is not this parameter's.
        forgetReading();
      },
    },
    () => {
      const targets = state.val?.status.targets ?? [];
      return div(...targets.map(target => option({ value: target.name }, `${target.name} (${target.micro})`)));
    }
  );
}

/** What the selected parameter is for, and everything worth knowing before touching it. */
function TargetNote() {
  return div({ class: "action-note" }, () => {
    const target = selectedTarget();
    if (!target) {
      return div();
    }
    return div(
      div({ style: `color:${MUTED}` }, target.purpose),
      // Every warning, always, not behind a "details" toggle. They are the reason
      // this list is five entries long instead of 277.
      ...target.warnings.map(warning => div({ style: `color:${WARN}`, class: "action-note" }, warning)),
      target.control.kind === "bits"
        ? div(
            ...target.control.bits.map(bit => div({ style: `color:${WARN}`, class: "action-note" }, `⚠️ ${bit.caveat}`))
          )
        : div()
    );
  });
}

function CurrentReading() {
  return div({ class: "probe-input", style: "display:flex; align-items:center" }, () => {
    if (current.val === null) {
      return span({ style: `color:${MUTED}` }, "not read yet");
    }
    const target = selectedTarget();
    if (target?.control.kind === "bits") {
      return span(`0x${current.val.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    return span(String(current.val));
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
      return select(
        {
          class: "probe-input",
          value: wanted,
          onchange: (/** @type {Event} */ event) => {
            wanted.val = /** @type {HTMLSelectElement} */ (event.target).value;
            armed.val = "";
          },
        },
        option({ value: "" }, "choose…"),
        ...bits.flatMap(bit => [
          option({ value: `${bit.key}:1` }, `${bit.label} — ON`),
          option({ value: `${bit.key}:0` }, `${bit.label} — OFF`),
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
    () => (busy.val ? "⏳  Reading…" : "🔎  Read it off the bike now")
  );
}

function WriteButton() {
  return div(
    button(
      {
        class: "action",
        // Unavailable until there is a fresh reading, and until the bike has named its
        // parameter table. The server enforces both — the compare-and-swap and the
        // table gate — and the page simply does not offer a button whose request would
        // be refused.
        disabled: () => busy.val || !canWrite() || current.val === null || wanted.val.trim().length === 0,
        onclick: () => {
          if (armed.val !== "write") {
            armed.val = "write";
            return;
          }
          armed.val = "";
          void performWrite();
        },
      },
      () => {
        const table = state.val?.status.tableGate;
        if (table && !table.writesAllowed) {
          // Ahead of the "read it first" caption: reading the value would not help
          // here, and a button that asks for a reading it will then refuse to act on is
          // worse than one that says what is actually wrong. The full sentence and the
          // remedy are in TableTypeNote() above; this is the short form on the control.
          return table.state === "mismatched"
            ? "🚨  Blocked — this bike's parameter table is not the one this software has"
            : // Deliberately "sweep", not "read": the probe shows the answer and stores
              // nothing, so a caption saying "read 277" sends people round a loop that
              // never ends. The full sentence is in TableTypeNote() above.
              "⚠️  Blocked until a sweep has recorded the A8's TABLE_TYPE (277) — see above";
        }
        if (current.val === null) {
          return "✏️  Read it first — a write needs to know what is there now";
        }
        const change = describeChange();
        return armed.val === "write" ? `⚠️  Tap again to write  ${change}` : `✏️  Write  ${change}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      current.val === null
        ? "Every write is a compare-and-swap: the Pi re-reads the parameter and refuses if it has moved since you read it."
        : `Currently ${currentHex.val || "?"} on the bike. The Pi will re-read it, write, and read it back — and say so loudly if the read-back disagrees.`
    )
  );
}

/** `75 → 80`, or `Heated handlebars → ON`. What the two taps are agreeing to. */
function describeChange() {
  const target = selectedTarget();
  if (!target || current.val === null) {
    return "";
  }
  if (target.control.kind === "bits") {
    const [key, on] = wanted.val.split(":");
    const bit = target.control.bits.find(candidate => candidate.key === key);
    return bit ? `${bit.label} → ${on === "1" ? "ON" : "OFF"}` : "";
  }
  return `${target.name}: ${current.val} → ${wanted.val}`;
}

/**
 * The four service actions.
 *
 * Below the parameter form and visually separate, because two of them cannot be
 * undone and one of them has no read-back at all. Each arms independently — arming
 * one disarms the others, so a thumb travelling down the list cannot double-tap its
 * way through two of them.
 */
function ServiceActions() {
  return div(
    div({ class: "sheet-title" }, "Service actions"),
    ActionButton(
      "read-service-stamp",
      () => "📖  Read the last-service date and odometer",
      "Reads four identifiers on the A8 that no sweep covers. Read-only. ⚠️ Untried: nothing has ever read these off this bike, so a refusal may simply mean it does not carry a service stamp.",
      false
    ),
    ActionButton(
      "set-service-point",
      () => "🔧  Say a service was performed NOW",
      "⚠️ IRREVERSIBLE. Runs 31 FC on the A8. It takes no parameters — the bike stamps its OWN clock and odometer, so read the stamp above first and make sure the bike's clock is right. There is no unset.",
      true
    ),
    ClockAction(),
    ActionButton(
      "clear-dtcs",
      () => "🧹  Clear the stored trouble codes",
      "⚠️ IRREVERSIBLE. OBD Mode 04. This bike's stored list has been accumulating since before anyone started looking, and the freeze frame goes with it. Codes whose faults are still active come straight back.",
      true
    )
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
    button(
      {
        class: "action",
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
    div({ class: "action-note" }, () => {
      const clock = state.val?.status.clock;
      if (!clock) {
        return div();
      }
      if (!clock.trustworthy) {
        // Every reason, not the first. "No satellite time AND the clock reads 2060"
        // is a different situation from either alone, and the second one is how you
        // find out the GPS decode is broken rather than the sky being blocked.
        return div(
          div({ style: `color:${BAD}` }, `The Pi reads ${clock.iso}, and it is not fit to copy:`),
          ...clock.reasons.map(reason => div({ style: `color:${MUTED}` }, `· ${reason}`))
        );
      }
      return div(
        { style: `color:${MUTED}` },
        `Checked against satellite time (${clock.offsetFromGpsSeconds.toFixed(1)} s apart). ` +
          "The bike's clock is what the service point stamps. ⚠️ There is no way to read the bike's clock back, so this is the one action here that nothing can confirm."
      );
    })
  );
}

/**
 * @param {"read-service-stamp" | "set-service-point" | "clear-dtcs"} action
 * @param {() => string} caption
 * @param {string} note
 * @param {boolean} irreversible
 */
function ActionButton(action, caption, note, irreversible) {
  const key = `action:${action}`;
  return div(
    button(
      {
        class: "action",
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
      () =>
        armed.val === key
          ? `⚠️  Tap again — ${irreversible ? "this cannot be undone" : "this asks the bike"}`
          : caption()
    ),
    div({ class: "action-note", style: `color:${irreversible ? WARN : MUTED}` }, note)
  );
}

/** The last few journal lines. The record of what has been done to this motorcycle. */
function Journal() {
  return div({ class: "sheet-title" }, "Recently written", () =>
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

/** Drops the reading AND the arming. The two must never be out of step. */
function forgetReading() {
  current.val = null;
  currentHex.val = "";
  wanted.val = "";
  armed.val = "";
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
    const reading = payload.reading;
    if (!reading || reading.status !== "read" || reading.value === null) {
      // No fallback to `unsigned`, deliberately. A write is compared against the
      // TYPED value, and using a differently-typed number as the precondition is how
      // a signed parameter gets written from an unsigned reading of itself.
      current.val = null;
      message.val = `Could not read ${target.name}: ${reading?.note ?? payload.message ?? "no answer"}`;
      return;
    }
    current.val = reading.value;
    currentHex.val = reading.rawHex ?? "";
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

async function performWrite() {
  const target = selectedTarget();
  if (!target || current.val === null) {
    return;
  }
  const query = new URLSearchParams({ name: target.name, expected: String(current.val) });
  if (target.control.kind === "bits") {
    const [bit, on] = wanted.val.split(":");
    query.set("action", "bit");
    query.set("bit", bit);
    query.set("on", on);
  } else {
    query.set("action", "parameter");
    query.set("value", wanted.val.trim());
  }
  await send(query);
  // The value on screen is now stale whatever happened — written, refused or
  // unknown. Dropping it forces another read before another write, which is the
  // property the compare-and-swap depends on.
  forgetReading();
}

/**
 * @param {string} action
 * @param {string} confirmation
 */
async function performAction(action, confirmation) {
  await send(new URLSearchParams({ action, confirm: confirmation }));
}

/** @param {URLSearchParams} query */
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
  } catch (error) {
    // ⚠️ The worst case on this page, and it is said as such. A write request that
    // did not come back may still have reached the bike — the frame goes out before
    // the response comes back — so "it failed" would be a claim nothing supports.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "⚠️ This does NOT mean nothing was written: the request may have reached the bike. Read the value back before trying again.";
    console.warn("vcu-write: request failed", error);
  } finally {
    busy.val = false;
  }
}

/** @param {string} label @param {() => Element} control */
function Field(label, control) {
  return div({ class: "probe-field" }, div({ class: "probe-label" }, label), control());
}

/** Called by ./service-mode.js whenever the sheet opens. Refreshes and disarms everything. */
export async function refreshVcuWrite() {
  armed.val = "";
  forgetReading();
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
