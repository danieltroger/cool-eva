import { readFile, readdir } from "fs/promises";
import { ARM_DWELL_MS, arm, armDwellElapsed, armed, refuseKeyRepeat } from "../public/lib/arming.js";
import { ARMED_KEY as CHARGE_CURRENT_KEY } from "../public/views/charge-current.js";
import { ARMED_KEY as CHARGE_STOP_KEY } from "../public/views/charge-stop.js";
import { IRREVERSIBLE, refreshVcuWrite } from "../public/views/vcu-write.js";
import { fetchChargeWriteStatus, writeStatus } from "../public/lib/charge-write.js";

// public/lib/arming.js — the two-tap arm/dwell in front of every control that writes to the
// motorcycle, checked without a browser.
//
//   node --experimental-strip-types scripts/check-arming.ts
//
// ⚠️ This module had no coverage at all until 2026-08-30, and it is the whole of what stands
// between a double-tap and a write to a calibration EEPROM. The three surfaces behind it —
// views/vcu-write.js (a parameter write, `31 FC`, Mode 04 and the bike's own clock),
// views/charge-current.js and views/charge-stop.js — each spell the gate out again at their own
// `onclick`, so half of what is asserted here is that all five firing sites still spell it the
// same way (§7). A gate one site forgot is exactly as absent as one that was deleted.
//
// The dwell is time-based, so `arm()` and `armDwellElapsed()` take an optional reading and this
// check hands one in: 399 ms and 400 ms are asserted rather than slept through, and nothing here
// can be flaked by a loaded machine. scripts/virtual-clock.ts is deliberately NOT used — this
// module arms no timers, it only compares two readings — and §9 runs the gate with nothing
// injected, since the two `performance.now()` defaults are the lines that actually ship. ⚠️ That
// reading is a BYPASS as much as a seam, so §7 asserts that no call site on the dashboard hands
// one in: a back-dated stamp arms a control whose dwell has already elapsed.
//
// Same shape as scripts/check-irreversible-actions.ts, and for the same reason: public/ is ES
// modules with no build step, so a browser file imports straight into Node. What needs a DOM is
// the five `onclick` bodies, which is why §7 and §8 read them rather than running them.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** A clock that has been running a while, the way a phone's has by the time a thumb arrives. */
const STAMP = 1_000_000;

/** The key names a view's ARMED_KEY export holds, for resolving a site's `armed.val !== ARMED_KEY`. */
const EXPORTED_KEYS = new Map([
  ["public/views/charge-current.js", CHARGE_CURRENT_KEY],
  ["public/views/charge-stop.js", CHARGE_STOP_KEY],
]);

// ⚠️ DISCOVERED, never listed. §7 reads the firing sites out of these files, and a list here
// would be the one place a new arming surface could fail to appear: a sixth control in a NEW
// view would simply not be looked at, and every count below would stay green without it.
const ARMING_CONSUMERS = await armingConsumers();
const SOURCES = new Map<string, string>();
for (const path of ARMING_CONSUMERS) {
  SOURCES.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

// --- 1. before anything has ever been armed ----------------------------------

console.log("\n1. a page that has armed nothing");

check("nothing is armed when the module loads", armed.val === "");
check(
  "⚠️  and the dwell already reads ELAPSED — `armedAt` starts at 0, so the gate is open on a fresh page and is " +
    "held shut only by `armed.val` being empty and matching no control's key",
  armDwellElapsed(500) === true
);

// --- 2. the first tap --------------------------------------------------------

console.log("\n2. one tap arms, and does nothing else");

arm("write", STAMP);
check("the key the tap named is what is armed", armed.val === "write");
check(
  "⚠️  and that same tap cannot also fire: at the instant it armed, no dwell has passed",
  armDwellElapsed(STAMP) === false
);

// --- 3. the dwell ------------------------------------------------------------
//
// Pinned to LITERALS. An assertion phrased as `ARM_DWELL_MS - 1` passes for every value of
// ARM_DWELL_MS including zero, which is one of the mutations this section exists to catch.

console.log("\n3. the dwell, in milliseconds rather than in the constant's own terms");

check("ARM_DWELL_MS is still 400 ms — docs/dashboard-decisions.md §`ARM_DWELL_MS`", ARM_DWELL_MS === 400);
check(
  "⚠️  a second tap 0 ms after the first is refused — the double-tap that really did POST `31 FC` on 2026-08-19",
  armDwellElapsed(STAMP) === false
);
check("…one 399 ms after it is still refused", armDwellElapsed(STAMP + 399) === false);
check(
  '⚠️  and neither refusal DISARMED: the caption still says "Tap again" and still means it, so an impatient ' +
    "thumb's next tap does what it meant rather than silently starting over",
  armed.val === "write"
);
check("…and at exactly 400 ms the gate opens", armDwellElapsed(STAMP + 400) === true);
check(
  "⚠️  a clock that jumped BACKWARDS mid-gesture hands out a dwell that never elapses — the safe direction, and " +
    "why the stamp is performance.now() and never Date.now()",
  armDwellElapsed(STAMP - 5_000) === false
);

arm("action:set-service-point", STAMP + 10_000);
check(
  "⚠️  arming a SECOND control re-stamps — otherwise it would inherit a dwell that elapsed ten seconds ago and " +
    "fire on its own double-tap",
  armDwellElapsed(STAMP + 10_000) === false
);

// --- 4. a held Enter ---------------------------------------------------------
//
// The one hole the dwell does not close, and it does not close it by arithmetic: macOS repeats a
// held key at about 500 ms, on the far side of the 400 ms dwell.

console.log("\n4. the key repeat the dwell cannot see");

check(
  "⚠️  a REPEATED Enter is cancelled — one sustained press must not arm on the first event and fire on the repeat",
  pressed("Enter", true).prevented
);
check(
  "…while the first Enter of that press goes through, or these buttons could not be operated by keyboard at all",
  !pressed("Enter", false).prevented
);
for (const key of ["ArrowDown", "PageDown", "Tab", " "]) {
  check(
    `…and a held ${key === " " ? "Space" : key} is left alone — cancelling every repeat on these buttons would ` +
      "stop a phone scrolling dead after one line",
    !pressed(key, true).prevented
  );
}

// --- 5. the key --------------------------------------------------------------
//
// ⚠️ `armed` is ONE key for the whole dashboard and the surfaces are NOT mutually exclusive:
// set-current and stop are on the charge tab together for the whole of a live charge. That is
// safe because every firing site tests its own key — which is only true while the keys differ.

console.log("\n5. the key: one control armed at a time, and no tap fires another");

// ⚠️ ONE ENTRY PER CONTROL, and read off the `!==` refusal alone rather than off every
// comparison: each key is also spelled `===` in its caption, and de-duplicating the two spellings
// would de-duplicate exactly what the count below is looking for. Two controls that came to share
// a key have to survive as two entries here, or both sides of `new Set(ALL_KEYS).size ===
// ALL_KEYS.length` shrink together and a real collision reports green.
const literalKeys = [...sourceOf("public/views/vcu-write.js").matchAll(/armed\.val !== "([^"]+)"/g)].map(
  match => match[1]
);
console.log(`   keys vcu-write.js names: ${literalKeys.join(", ")}`);
check(
  "the comparisons were found at all — a pattern matching nothing would pass the rest of this section in silence",
  literalKeys.length >= 2
);

// One entry per CONTROL, so two controls that came to share a key collapse the count and go
// red. The clock sync is deliberately not taken from IRREVERSIBLE even though it is in the
// fold: it writes its own confirmation instead of going through ActionButton, so it is already
// in `literalKeys` above, and taking it from both lists would be one control counted twice.
const ALL_KEYS = [
  CHARGE_CURRENT_KEY,
  CHARGE_STOP_KEY,
  ...literalKeys,
  // The read-only action, spelled out because nothing exports it — it is the one ActionButton
  // outside the fold, so IRREVERSIBLE does not name it.
  "action:read-service-stamp",
  ...IRREVERSIBLE.filter(entry => entry.action !== "sync-clock").map(entry => `action:${entry.action}`),
];
check(`no two of the ${ALL_KEYS.length} controls share a key`, new Set(ALL_KEYS).size === ALL_KEYS.length);
check(
  "the written-down read-service-stamp button is still there, so its key above is a control and not a leftover",
  sourceOf("public/views/vcu-write.js").includes('ActionButton("read-service-stamp"')
);
check(
  '⚠️  and no control\'s key is "" — that is what makes `armed.val = ""` a disarm rather than the name of something',
  ALL_KEYS.every(key => key !== "")
);

arm(CHARGE_CURRENT_KEY, STAMP);
arm(CHARGE_STOP_KEY, STAMP);
check(
  "⚠️  arming one of the two CO-VISIBLE charge controls disarms the other — one key, so a tap on set-current now " +
    "finds a key that is not its own and re-arms instead of commanding a current",
  armedKeyIs(CHARGE_STOP_KEY) && !armedKeyIs(CHARGE_CURRENT_KEY)
);

// --- 6. what disarms, run for real -------------------------------------------
//
// The refreshes are the disarm-on-change path that can be executed without a DOM, and they are
// the load-bearing pair: all five controls refresh BEFORE they arm, so a status that lands under
// an already-armed button has to take the arming with it. Armed AFTER the call and before its
// answer, which is the ordering that matters — a button armed against 75 must not fire against
// the 80 the refresh brought with it.

console.log("\n6. a refresh landing under an armed button");

const STATUS_PAYLOAD = { status: { enabled: true, targets: [] } };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(STATUS_PAYLOAD), { headers: { "content-type": "application/json" } })) as typeof fetch;
try {
  const sheetOpening = refreshVcuWrite();
  arm("write", STAMP);
  await sheetOpening;
  check("⚠️  a /vcu-write status that lands under an armed write button disarms it", armed.val === "");

  const firstTap = fetchChargeWriteStatus();
  arm(CHARGE_CURRENT_KEY, STAMP);
  await firstTap;
  check("…and the charge tab's own refresh, shared by set-current and stop, does the same", armed.val === "");
  check(
    "both really reached their disarm — a fetch that threw would have left the key alone, so neither of the two " +
      "above passed by failing early",
    writeStatus.val !== null
  );
} finally {
  globalThis.fetch = realFetch;
}

// --- 7. every firing site on the dashboard, read off its own source ----------
//
// ⚠️ THE GATE IS NOT IN ONE PLACE. arming.js holds the dwell; the RULE — test my key, then the
// dwell, then clear, then act — is spelled out at each `onclick`, and those bodies need a DOM to
// run. So they are read instead, the way check-irreversible-actions.ts reads the `switch` in
// src/http/vcu-write.ts rather than trusting a sentence about it. A sixth firing site, or one
// that drops a line of the rule, is what this section exists to make loud.

console.log("\n7. the five firing sites, and the rule each of them repeats");

const SITES = ARMING_CONSUMERS.flatMap(path => firingSites(path, sourceOf(path)));
console.log(`   found: ${SITES.map(site => shortName(site)).join(", ")}`);

// Named rather than counted, so a sixth site has to be ADDED here rather than absorbed by a
// number — and so the red line says which one arrived. ActionButton is one call site serving
// five keyed controls, which is why this is a list of firing sites and §5's is a list of keys.
const EXPECTED_SITES = [
  "charge-current.js → performChargeCurrent",
  "charge-stop.js → performChargeStop",
  "vcu-write.js → performAction",
  "vcu-write.js → performAction",
  "vcu-write.js → performWrite",
];
check(
  `the ${EXPECTED_SITES.length} firing sites are exactly the ones written down here`,
  SITES.map(site => shortName(site))
    .sort()
    .join(" · ") === EXPECTED_SITES.join(" · ")
);

for (const site of SITES) {
  const where = shortName(site);
  const keyTest = site.body.indexOf("armed.val !== ");
  const dwellTest = site.body.indexOf("if (!armDwellElapsed())");
  const disarm = site.body.indexOf('armed.val = ""');
  check(
    `${where}: tests its own key, then the dwell, then clears it, then acts — in that order`,
    keyTest >= 0 && keyTest < dwellTest && dwellTest < disarm && disarm < site.callAt
  );
  const armingBranch = keyTest >= 0 && dwellTest > keyTest ? site.body.slice(keyTest, dwellTest) : "";
  // ⚠️ ITS OWN key, pinned to the key rather than to the shape. `armed.val !== ` alone proves
  // only that SOME key is tested: point charge-stop at "charge-current" and the shape still
  // holds, while Stop fires on a SINGLE tap and its caption never says "Tap again". The two are
  // co-visible for the whole of a live charge and one file is a copy of the other, so that
  // mis-scoping is one wrong constant away — a likelier edit than dropping the test altogether.
  const refusedKey = keyOf(site.file, site.body.match(/armed\.val !== (\w+|"[^"]*")/)?.[1]);
  const armedKey = keyOf(site.file, armedWith(armingBranch, sourceOf(site.file)));
  check(
    `${where}: ⚠️  the key it refuses on is the key its own first tap arms — ${refusedKey}`,
    refusedKey !== "" && refusedKey === armedKey
  );
  check(
    `${where}: ⚠️  the tap the dwell refuses does nothing but return — it must not disarm`,
    refusedBranch(site.body) === "return;"
  );
  check(
    `${where}: the FIRST tap arms and nothing else — nothing is performed on that branch`,
    /\barm[A-Za-z]*\(/.test(armingBranch) && !armingBranch.includes("perform")
  );
  check(
    `${where}: ⚠️  its button refuses a held Enter — one press must not arm and then fire`,
    site.props.includes("onkeydown: refuseKeyRepeat")
  );
}

// ⚠️ THE SEAM IS A BYPASS AS WELL AS A TEST HOOK, and this is the only thing standing on it.
// `arm(key, performance.now() - 10_000)` at any call site arms a control whose dwell has already
// elapsed, so its very next tap fires — the dwell defeated outright, by one extra argument. Until
// the optional reading existed that was impossible by construction; now it is impossible only by
// convention, and a convention nothing asserts is a comment. This check is the only caller
// allowed to hand one in, and this check is not among the files scanned.

const gateCalls: { where: string; name: string; args: string }[] = [];
for (const path of ARMING_CONSUMERS) {
  for (const call of withoutLineComments(sourceOf(path)).matchAll(/\b(arm|armDwellElapsed)\(([^)]*)\)/g)) {
    gateCalls.push({ where: path, name: call[1], args: call[2].trim() });
  }
}
const injecting = gateCalls.filter(call =>
  call.name === "arm" ? call.args === "" || call.args.includes(",") : call.args !== ""
);
for (const call of injecting) {
  console.error(`      ${call.where}: ${call.name}(${call.args})`);
}
check(
  "the gate's call sites were found at all — a pattern matching nothing would pass the one below in silence",
  gateCalls.length >= 8
);
check(
  `⚠️  none of the ${gateCalls.length} arm()/armDwellElapsed() calls outside arming.js injects a clock — every one ` +
    "takes the reading production takes, so no site can hand itself a dwell that has already elapsed",
  injecting.length === 0
);

// ⚠️ `arm()` is the ONLY way `armed` becomes a non-empty key, and that is what makes the dwell
// unskippable: a key set by hand carries whatever stamp the last arming left behind, so its
// control fires on the very next tap. Every assignment outside arming.js has to be the empty one.
//
// ⚠️ Scoped to the modules that import the SHARED gate, and it has to be: public/views/
// service-mode.js declares an `armed` of its own — a plain boolean with no dwell and no
// key-repeat guard, in front of the parameter sweep — so an unscoped scan would be reading two
// different states as one. That second arming surface is a finding, not this check's subject:
// docs/dashboard-decisions.md §"The other `armed`".

const assignments: string[] = [];
for (const path of ARMING_CONSUMERS) {
  for (const match of sourceOf(path).matchAll(/armed\.val\s*=(?!=)\s*([^;\n]*)/g)) {
    assignments.push(`${path}: armed.val = ${match[1]}`);
  }
}
for (const assignment of assignments.filter(entry => !entry.endsWith('= ""'))) {
  console.error(`      ${assignment}`);
}
check(
  `all ${assignments.length} \`armed.val =\` assignments outside arming.js DISARM — arm() is the only way to arm`,
  assignments.length >= 15 && assignments.every(assignment => assignment.endsWith('= ""'))
);

// A new surface that imported `arm` alone would be a control with two taps and no dwell.
for (const path of ARMING_CONSUMERS) {
  const named = importedFromArming(sourceOf(path));
  if (!named.includes("arm")) {
    continue;
  }
  check(
    `${path} arms, so it also takes the dwell and the key-repeat guard`,
    named.includes("armDwellElapsed") && named.includes("refuseKeyRepeat")
  );
}

// --- 8. what drops the arming when the form moves under it -------------------
//
// Spelled out rather than derived, the way check-irreversible-actions.ts spells out the fold's
// contents: each of these is a promise that a second tap sends what is on screen NOW.

console.log("\n8. disarm-on-change, at the handlers that cannot be run without a DOM");

const DISARMS: [path: string, what: string, marker: string][] = [
  [
    "public/views/charge-current.js",
    "retyping the amps",
    "amps.val = /** @type {HTMLInputElement} */ (event.target).value;",
  ],
  [
    "public/views/vcu-write.js",
    "retyping the value",
    "wanted.val = /** @type {HTMLInputElement} */ (event.target).value;",
  ],
  [
    "public/views/vcu-write.js",
    "choosing a different bit",
    "wanted.val = /** @type {HTMLSelectElement} */ (event.target).value;",
  ],
  [
    "public/views/vcu-write.js",
    "toggling the red fold over the irreversible three",
    "dangerOpen.val = !dangerOpen.val;",
  ],
];

for (const [path, what, marker] of DISARMS) {
  const body = enclosingArrowBody(sourceOf(path), marker);
  check(`${what} disarms`, body !== "" && body.includes('armed.val = ""'));
}

const selectHandler = enclosingArrowBody(
  sourceOf("public/views/vcu-write.js"),
  "selected.val = /** @type {HTMLSelectElement} */ (event.target).value;"
);
const forgetSelectionBody = declarationBody(sourceOf("public/views/vcu-write.js"), "function forgetSelection()");
check(
  "choosing a different parameter disarms, through the forgetSelection() the sheet-open reset also calls",
  selectHandler.includes("forgetSelection()") && forgetSelectionBody.includes('armed.val = ""')
);

// --- 9. the same gate with PRODUCTION's clock --------------------------------
//
// ⚠️ Everything above hands in a reading, which leaves the two `performance.now()` defaults as
// the only lines in arming.js nothing runs — and they are the lines the phone runs. The refusal
// below needs no margin at all (two readings microseconds apart, against 400 ms); the elapsed one
// sleeps 60 ms past the dwell, and load can only push it the safe way.

console.log("\n9. the defaults nothing else exercises: the real performance.now()");

arm("write");
check("⚠️  with no clock injected, a second tap in the same instant is still refused", armDwellElapsed() === false);
await new Promise(resolve => void setTimeout(resolve, ARM_DWELL_MS + 60));
check("…and one after the dwell has really passed fires", armDwellElapsed() === true);

const ARMING_SOURCE = await readFile(new URL("../public/lib/arming.js", import.meta.url), "utf8");
const stampDefault = ARMING_SOURCE.match(/export function arm\(key, nowMs = (.*)\) \{/);
const readingDefault = ARMING_SOURCE.match(/export function armDwellElapsed\(nowMs = (.*)\) \{/);
check(
  "both default expressions were found at all — a pattern that matched nothing would pass the one below in silence",
  stampDefault !== null && readingDefault !== null
);
check(
  "⚠️  the stamp and the reading are both performance.now(), never Date.now() — this dashboard has a button on it " +
    "that STEPS A CLOCK, and the Pi steps its own from GPS",
  stampDefault?.[1] === "performance.now()" &&
    readingDefault?.[1] === "performance.now()" &&
    // The prose above them says "never Date.now()", so the ban has to be read off the CODE.
    !ARMING_SOURCE.split("\n")
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n")
      .includes("Date.now")
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "s" : ""}`);
  process.exitCode = 1;
} else {
  console.log("✓ two taps 400 ms apart, the second ignored rather than disarmed inside the dwell, one key for the");
  console.log("  whole dashboard with no two controls sharing it, every refresh disarming what it lands under, and");
  console.log("  all five firing sites still spelling the same rule — on the injected clock and on the real one");
}

/**
 * What a firing site asks on a tap: is the key that is armed MINE? A function rather than the
 * comparison inline, because the compiler narrows `armed.val` to whatever it was last compared
 * with and would then call the second question unanswerable — while at a tap it is the shared
 * state that gets read, and it can hold any control's key.
 */
function armedKeyIs(key: string): boolean {
  return armed.val === key;
}

/** One gate consumer's source, which §5 onwards read more than once. */
function sourceOf(path: string): string {
  const source = SOURCES.get(path);
  if (source === undefined) {
    throw new Error(
      `check-arming: ${path} does not import the shared gate, so nothing read it — see armingConsumers()`
    );
  }
  return source;
}

interface FiringSite {
  file: string;
  /** The `perform…` it calls, so a red line names the control rather than a byte offset. */
  name: string;
  /** The `onclick` body with its comments stripped, or "" when it could not be found. */
  body: string;
  /** The whole of the button's props object, comments stripped, wherever `onkeydown` sits in it. */
  props: string;
  /** Where the perform call sits inside `body`. */
  callAt: number;
}

/**
 * Every control in one gate consumer that ACTS on a second tap, found from the action rather
 * than from the gate: a site that skipped the gate entirely would be invisible to a search for
 * the gate. ⚠️ Found by the `void perform…()` naming convention, so what §7 guarantees is "no
 * ungated `void perform*()` in a module that imports arming.js" — not "no ungated control".
 *
 * ⚠️ Comments come out of both bodies before anything reads them, in BOTH directions: prose
 * beside a guard must not break an assertion, and prose describing a guard must not satisfy one.
 * Deleting a whole dwell test and leaving `// enforced by armDwellElapsed()` behind used to pass.
 */
function firingSites(file: string, source: string): FiringSite[] {
  return [...source.matchAll(/\bvoid (perform[A-Za-z]*)\(/g)].map(match => {
    const callIndex = match.index;
    const handlerAt = source.lastIndexOf("onclick:", callIndex);
    const block = handlerAt === -1 ? null : blockAt(source, handlerAt);
    // The whole props object, not the source ahead of `onclick:` — otherwise moving `onkeydown`
    // below the handler, which changes nothing, goes red claiming the guard was removed.
    const buttonAt = handlerAt === -1 ? -1 : source.lastIndexOf("button(", handlerAt);
    const props = buttonAt === -1 ? null : blockAt(source, buttonAt);
    const found = block !== null && block.end > callIndex;
    const body = found ? withoutLineComments(source.slice(block.start, block.end + 1)) : "";
    return {
      file,
      name: match[1],
      body,
      props: props === null ? "" : withoutLineComments(source.slice(props.start, props.end + 1)),
      // Re-found in the STRIPPED body: an offset taken from the raw source would sit past every
      // index the ordering assertion compares it with, and that assertion is an ordering.
      callAt: body.indexOf(`void ${match[1]}(`),
    };
  });
}

function shortName(site: FiringSite): string {
  return `${site.file.replace("public/views/", "")} → ${site.name}`;
}

/**
 * What key one `armed.val !== …` or `arm(…)` expression names, as a string that can be compared
 * with another. A quoted literal is its own contents and a module's `ARMED_KEY` is resolved
 * through its export; anything else — `key`, the parameter ActionButton is built around — stays
 * the identifier, so a site that armed one variable and refused on another still goes red.
 */
function keyOf(file: string, expression: string | undefined): string {
  if (expression === undefined || expression === "") {
    return "";
  }
  if (expression.startsWith('"')) {
    return expression.slice(1, -1);
  }
  if (expression === "ARMED_KEY") {
    const exported = EXPORTED_KEYS.get(file);
    if (exported === undefined) {
      throw new Error(`check-arming: ${file} names ARMED_KEY and EXPORTED_KEYS does not import it`);
    }
    return exported;
  }
  return `<${expression}>`;
}

/**
 * The key a site's FIRST tap arms with — its first argument only, so a call that also injected a
 * clock still reports the key it arms and the assertion above it stays about keys. The injected
 * clock is its own red line. Followed one hop through the `void armSomething()` the branch calls,
 * because only ActionButton arms inline — the other four refresh the Pi's answer first and arm at
 * the end of that, which is where the key they commit to actually is.
 */
function armedWith(armingBranch: string, source: string): string | undefined {
  const inline = armingBranch.match(/\barm\(([^),]*)/);
  if (inline !== null) {
    return inline[1].trim();
  }
  const helper = armingBranch.match(/\bvoid ([A-Za-z_$][\w$]*)\(/);
  if (helper === null) {
    return undefined;
  }
  return declarationBody(source, `function ${helper[1]}(`)
    .match(/\barm\(([^),]*)/)?.[1]
    .trim();
}

/**
 * `source` with its `//` comments removed. Quote-aware only far enough to leave a `//` inside a
 * string alone, and per line, so an unterminated quote cannot swallow the rest of a file.
 */
function withoutLineComments(source: string): string {
  return source
    .split("\n")
    .map(line => {
      let quote = "";
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote !== "") {
          if (character === "\\") {
            index += 1;
          } else if (character === quote) {
            quote = "";
          }
        } else if (character === '"' || character === "'" || character === "`") {
          quote = character;
        } else if (character === "/" && line[index + 1] === "/") {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

/** What a firing site does with a tap the dwell refused, trimmed so it can be compared whole. */
function refusedBranch(body: string): string {
  const at = body.indexOf("if (!armDwellElapsed()) {");
  const block = at === -1 ? null : blockAt(body, at);
  return block === null ? "" : body.slice(block.start + 1, block.end).trim();
}

/** The `{ … }` starting at or after `from`, brace-matched. */
function blockAt(source: string, from: number): { start: number; end: number } | null {
  const start = source.indexOf("{", from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index };
      }
    }
  }
  return null;
}

/** The body of the arrow function `marker` sits in, or "" if it is not there at all. */
function enclosingArrowBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  const arrow = at === -1 ? -1 : source.lastIndexOf("=> {", at);
  const block = arrow === -1 ? null : blockAt(source, arrow);
  return block === null || block.end < at ? "" : source.slice(block.start, block.end + 1);
}

/** The body of a named function declaration, or "" if it is not there at all. */
function declarationBody(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  const block = at === -1 ? null : blockAt(source, at);
  return block === null ? "" : source.slice(block.start, block.end + 1);
}

/**
 * Every dashboard module that imports the shared gate, found by reading them rather than from a
 * list here — a list would be one more place a new arming surface could fail to appear.
 */
async function armingConsumers(): Promise<string[]> {
  const entries = await readdir(new URL("../public/", import.meta.url), { recursive: true });
  const modules = entries.filter(entry => entry.endsWith(".js") && !entry.startsWith("vendor"));
  const consumers: string[] = [];
  for (const entry of modules) {
    const source = await readFile(new URL(`../public/${entry}`, import.meta.url), "utf8");
    if (importedFromArming(source).length > 0) {
      consumers.push(`public/${entry}`);
    }
  }
  // readdir order is the filesystem's, so it is sorted before anything counts or prints it.
  return consumers.sort();
}

/** What one module takes from arming.js, by name. Empty for a module that does not import it. */
function importedFromArming(source: string): string[] {
  const clause = source.match(/import \{([^}]*)\} from "[^"]*\/arming\.js"/);
  return clause === null ? [] : clause[1].split(",").map(entry => entry.trim());
}

interface RecordedKeyEvent {
  repeat: boolean;
  key: string;
  prevented: boolean;
  preventDefault(): void;
}

/** One keydown put through the guard, reporting whether its default action was cancelled. */
function pressed(key: string, repeat: boolean): RecordedKeyEvent {
  const event: RecordedKeyEvent = {
    key,
    repeat,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  refuseKeyRepeat(event as unknown as KeyboardEvent);
  return event;
}
