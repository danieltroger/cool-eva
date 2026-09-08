import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { READ_STAMP_NOTES } from "../public/views/vcu-write.js";
import { describeStampEvidence } from "../public/lib/service-stamp.js";
import { SERVICE_STAMP_IDENTIFIERS, interpretServiceStamp } from "../src/vcu/service-actions.ts";

// The last-service stamp: what the page shows, WHERE it shows it, and that the claim the
// 2026-09-08 read retired stays retired.
//
//   node --experimental-strip-types scripts/check-service-stamp.ts
//
// ⚠️ §1 and §2 are SOURCE assertions, and they are here because the bug was placement, not
// text. The read worked on the first press and the answer rendered three sections up the
// sheet (issue #154) — so a check that only exercised the formatter would have been green
// throughout the defect it exists for. Asserting placement needs a DOM; this suite has no
// browser (docs/diagnostics-and-checks.md §11.1), so it asserts the wiring instead and is
// honest about the difference: it proves the outcome node is PASSED to the control, not
// that a phone renders it. The screenshot in the PR is what covers the rest.
//
// Same idiom as scripts/check-irreversible-actions.ts, which imports public/views/vcu-write.js
// straight into Node and parses a sibling's source. Kept apart from it because that check is
// about the red fold, and this control is deliberately outside it.

const run = promisify(execFile);
let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
    return;
  }
  console.error(`  ✗ ${what}`);
  failures += 1;
}

/**
 * Which top-level function each offset falls in. Repo law forbids nested declarations, so
 * the nearest declaration above an offset is the one it belongs to.
 *
 * ⚠️ Matches `export`, `async` and both together. A pattern of just `function ` maps every
 * hit inside `export function VcuWrite()` to whatever plain function came before it, which
 * is a wrong answer rather than no answer — it went unnoticed until the names printed.
 */
function functionAt(source: string): (offset: number) => string {
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(match => ({
    at: match.index,
    name: match[1],
  }));
  return offset => {
    const found = declarations.filter(declaration => declaration.at < offset).at(-1);
    return found?.name ?? "(module scope)";
  };
}

console.log("\n──── scripts/check-service-stamp.ts ────────────────────────────────────────────");
console.log("     the last-service read: its evidence, where its answer renders, and the claim it retired");

const view = await readFile(new URL("../public/views/vcu-write.js", import.meta.url), "utf8");

// ── 1. THE REPORTED BUG: the control carries something to show the answer in ──────────
{
  // ⚠️ Asserted on the EXPORTED notes, not by parsing the call. This used to scan the
  // `ActionButton(…)` source with a 45-line state machine, which is what a positional
  // fourth argument costs — and ActionButton itself argues against that shape three lines
  // in ("derived from the prose rather than passed alongside it, so the tier a button is
  // painted and the sentence it carries cannot disagree"). The outcome now rides in the
  // notes, so both are data and this is two lines.
  check("the read-stamp control carries an outcome to render", typeof READ_STAMP_NOTES.outcome === "function");
  check("and it is the stamp outcome", READ_STAMP_NOTES.outcome?.name === "StampOutcome");
  // ⚠️ Asserting an ABSENCE, on purpose. The answer is set in `.action-note.caution`, which
  // is amber but NOT bigger, so it is only conspicuous while nothing else in the block is
  // permanently amber. Adding a caution back means deciding that trade again —
  // docs/dashboard-decisions.md §"Where an ANSWER goes".
  check("and carries no permanently amber caution to compete with it", READ_STAMP_NOTES.caution === undefined);
  check("its prose records what the read found", READ_STAMP_NOTES.does.includes("2026-09-08"));

  // ⚠️ ABOVE the prose, and bounded to ActionButton's OWN body. Unbounded, `NoteBlock(notes)`
  // matched the declaration far below instead of the call, so deleting the call from the
  // render left this green — a sixth mutation sailing past a check written for five.
  const body = view.slice(view.indexOf("function ActionButton("));
  const own = body.slice(0, body.indexOf("\nfunction ", 1));
  const slot = own.indexOf("notes.outcome ? notes.outcome() : div()");
  const notes = own.indexOf("NoteBlock(notes)");
  check("ActionButton renders whatever the notes carry", slot !== -1);
  check("and renders it ABOVE the static prose, not under it", slot !== -1 && notes !== -1 && slot < notes);
}

// ── 1b. THE WIRING EITHER END OF IT: something fills the signal, something reads it ────
{
  const outcome = view.slice(view.indexOf("function StampOutcome()"));
  const untilNext = outcome.slice(0, outcome.indexOf("\nfunction ", 1));
  // ⚠️ Deleting the assignment leaves a button that POSTs, succeeds and shows nothing —
  // issue #154 verbatim — with every other check in this suite still green. A slot handed a
  // node that is never filled is the bug wearing the fix's clothes.
  check(
    "the read fills stampOutcome with the answer and the stamp",
    /stampOutcome\.val = \{[^}]*text[^}]*stamp/.test(view)
  );
  check("and StampOutcome reads it", untilNext.includes("stampOutcome.val"));
  // ⚠️ `.caution`, never bare `.action-note`. At 11.52 px in --label the answer renders
  // byte-for-byte like the grey line above it, which is style.css:748-759's own argument
  // about the loudest sentence in a section being set as its quietest type.
  check("the answer is set in .action-note caution", untilNext.includes('"action-note caution"'));
  check("and the four raw WORDs are rendered under it", untilNext.includes("describeStampEvidence("));
}

// ── 2. THE ANSWER HAS ONE HOME, AND IS DROPPED WHEN IT STOPS BEING TRUE ────────────────
{
  // ⚠️ `message`'s two rendering homes are Outcome(), three sections up the sheet, and
  // VcuWrite()'s !hasControls() branch — NOT the pair it is easy to assume. Getting that
  // wrong is what made an unconditional clear look safe, and it emptied the failure line
  // on the one answer that unmounts everything else. docs/dashboard-decisions.md.
  const whereIs = functionAt(view);
  const homes = [...view.matchAll(/message\.val/g)].map(match => whereIs(match.index));
  // Capitalised names only: those are the components. `send`, `performAction` and the rest
  // WRITE it, which is not the property here.
  const touchedByComponents = [...new Set(homes.filter(name => /^[A-Z]/.test(name)))].sort();
  check(
    `message.val reaches no component but the three that may touch it (${touchedByComponents.join(", ") || "none"})`,
    touchedByComponents.join(",") === "Availability,Outcome,VcuWrite"
  );
  check(
    "the read's answer is dropped when the sheet reopens",
    /function refreshVcuWrite\(\)[\s\S]*?stampOutcome\.val = null/.test(view)
  );
  check(
    "and when 31 FC overwrites the block it reports",
    /set-service-point[\s\S]{0,600}?stampOutcome\.val = null/.test(view)
  );
  check(
    "and `message` is only cleared while the node that replaces it is still mounted",
    /if \(hasControls\(\)\) \{\s*message\.val = "";/.test(view)
  );
}

// ── 3. THE EVIDENCE — the four WORDs, and the payload that was really read ────────────
{
  // The 2026-09-08 reading, as the journal recorded it: all four WORDs zero.
  const stamp = interpretServiceStamp(
    { dateLow: 0, dateHigh: 0, odometerLow: 0, odometerHigh: 0 },
    Date.UTC(2026, 8, 8, 12, 17, 6)
  );
  const lines = describeStampEvidence(stamp);
  check("the real 2026-09-08 payload renders as two lines", lines.length === 2);
  check(
    "every raw WORD is shown, in hex",
    lines[0] === "A8 answered dateLow 0x0000 · dateHigh 0x0000 · odometerLow 0x0000 · odometerHigh 0x0000"
  );
  check(
    "with the decoded seconds, date and odometer",
    lines[1].includes("0 s since 2000-01-01") && lines[1].includes("odometer 0")
  );
  // ⚠️ NOT repeated here: `implausible` is already the tail of the server's own sentence
  // (describeStamp in write-runner.ts), and the first draft printed it twice.
  check(
    "and NOT the implausible note, which the outcome sentence already carries",
    !lines.join(" ").includes(stamp.implausible ?? " ")
  );

  // ⚠️ Structural, so a fifth WORD cannot silently drop out of the evidence: the fields the
  // formatter walks ARE the identifiers the read asks for. Compared as key sets rather than
  // by building the fixture from them, which the four-field literal type refuses.
  check(
    "the fields shown are exactly the identifiers that are read",
    Object.keys(stamp.raw).join(",") === Object.keys(SERVICE_STAMP_IDENTIFIERS).join(",")
  );

  const plausible = interpretServiceStamp(
    { dateLow: 0x8800, dateHigh: 0x31af, odometerLow: 0xa410, odometerHigh: 0x0000 },
    Date.UTC(2026, 8, 8)
  );
  check("a plausible stamp shows its real words", describeStampEvidence(plausible)[0].includes("dateHigh 0x31AF"));
  check("and its decoded odometer", describeStampEvidence(plausible)[1].includes("odometer 42000"));
}

// ── 4. THE RETIRED CLAIM STAYS RETIRED ────────────────────────────────────────────────
{
  // ⚠️ On 2026-09-08 A8 answered all four of these, so "nothing has ever read them" is false
  // wherever it appears — and it appeared in FIVE places, one of them a refusal message a
  // rider reads at the bike. A grep found four; a reviewer found the fifth, which is the
  // argument for making it a rule. Split literals so this file does not match itself, the
  // way scripts/check-vendor-names.ts does and for the same reason.
  //
  // ⚠️ THREE NEEDLES FOR FIVE SITES, and the first version got that wrong twice over. It
  // pinned whole sentences and caught three of the five — the README carried only the bare
  // word, and service-actions.ts a different tense — so restoring either to its old wording
  // left this green. Widening to "read off this bike" then caught five INNOCENT lines: that
  // phrase is ordinary English here (an infokey table, a parameter reading, a capture's
  // provenance). What is distinctive is the word, and the subject-verb pair either tense of
  // the claim needs.
  const retired = ["Untr" + "ied", "identifiers has ever " + "been read", "identifiers have never " + "been read"];
  const tracked = (await run("git", ["ls-files"])).stdout.split("\n").filter(Boolean);
  const offenders: string[] = [];
  for (const path of tracked) {
    if (!/\.(ts|js|md)$/.test(path)) {
      continue;
    }
    const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const [index, text_line] of text.split("\n").entries()) {
      // A line that quotes the old claim AND dates its retirement is the doc doing its job.
      if (text_line.includes("2026-09-08")) {
        continue;
      }
      for (const needle of retired) {
        if (text_line.toLowerCase().includes(needle.toLowerCase())) {
          offenders.push(`${path}:${index + 1}`);
        }
      }
    }
  }
  check(
    `no tracked file re-asserts that these four were unread${offenders.length > 0 ? ` — ${offenders.join(", ")}` : ""}`,
    offenders.length === 0
  );
  check(
    "and the fact that replaced it is written down",
    (await readFile(new URL("../docs/service-stamp.md", import.meta.url), "utf8")).includes("1788869826358")
  );
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\n✓ the answer is wired to the control, the words are shown, and the retired claim is gone");
