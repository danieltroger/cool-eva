// Historical source-check findings: docs/service-legacy.md.

import {
  firingSites,
  armingConsumers,
  armedWith,
  refusedBranch,
  enclosingArrowBody,
  importedFromArming,
  type FiringSite,
} from "./arming-source.ts";
import { withoutLineComments } from "./seam-scan.ts";
import { readFile } from "fs/promises";
import { declarationBody } from "./source-blocks.ts";
import { ARM_DWELL_MS, arm, armDwellElapsed, armed, refuseKeyRepeat } from "../public/lib/arming.js";
import { ARMED_KEY as CHARGE_CURRENT_KEY } from "../public/views/charge-current.js";
import { ARMED_KEY as CHARGE_SOC_LIMIT_KEY } from "../public/views/charge-soc-limit.js";
import { ARMED_KEY as CHARGE_STOP_KEY } from "../public/views/charge-stop.js";
import { ARMED_KEY as FREEZE_FRAME_READ_KEY } from "../public/views/freeze-frame-read.js";
import { SERVICE_ACTIONS } from "../public/lib/service-actions.js";
import { refreshServiceStatus } from "../public/lib/service-client.js";
import { fetchChargeWriteStatus, writeStatus } from "../public/lib/charge-write.js";

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

const STAMP = 1_000_000;

const EXPORTED_KEYS = new Map([
  ["public/views/charge-current.js", CHARGE_CURRENT_KEY],
  ["public/views/charge-soc-limit.js", CHARGE_SOC_LIMIT_KEY],
  ["public/views/charge-stop.js", CHARGE_STOP_KEY],
  ["public/views/freeze-frame-read.js", FREEZE_FRAME_READ_KEY],
]);

const ARMING_CONSUMERS = await armingConsumers();
const SOURCES = new Map<string, string>();
for (const path of ARMING_CONSUMERS) {
  SOURCES.set(path, await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

console.log("\n1. a page that has armed nothing");

check("nothing is armed when the module loads", armed.val === "");
check(
  "⚠️  and the dwell already reads ELAPSED — `armedAt` starts at 0, so the gate is open on a fresh page and is " +
    "held shut only by `armed.val` being empty and matching no control's key",
  armDwellElapsed(500) === true
);

console.log("\n2. one tap arms, and does nothing else");

arm("write", STAMP);
check("the key the tap named is what is armed", armed.val === "write");
check(
  "⚠️  and that same tap cannot also fire: at the instant it armed, no dwell has passed",
  armDwellElapsed(STAMP) === false
);

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

console.log("\n5. the key: one control armed at a time, and no tap fires another");

const ALL_KEYS = [
  CHARGE_CURRENT_KEY,
  CHARGE_SOC_LIMIT_KEY,
  CHARGE_STOP_KEY,
  FREEZE_FRAME_READ_KEY,
  ...SERVICE_ACTIONS.map(entry => `service:${entry.action}`),
  "service:lights-off",
  "service:lights-restore",
  ...["public/views/pi-actions.js", "public/views/settings-restart.js"].flatMap(path =>
    [...sourceOf(path).matchAll(/const \w+_KEY = "([^"]+)"/g)].map(match => match[1])
  ),
];
check(
  "each persistent write control has a distinct nonempty key",
  new Set(ALL_KEYS).size === ALL_KEYS.length && ALL_KEYS.every(Boolean)
);

arm(CHARGE_CURRENT_KEY, STAMP);
arm(CHARGE_STOP_KEY, STAMP);
check(
  "⚠️  arming one of the two CO-VISIBLE charge controls disarms the other — one key, so a tap on set-current now " +
    "finds a key that is not its own and re-arms instead of commanding a current",
  armedKeyIs(CHARGE_STOP_KEY) && !armedKeyIs(CHARGE_CURRENT_KEY)
);

console.log("\n6. a refresh landing under an armed button");

const STATUS_PAYLOAD = { status: { enabled: true, targets: [], detail: null, tableGate: { tableType: 16407 } } };
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(STATUS_PAYLOAD), { headers: { "content-type": "application/json" } })) as typeof fetch;
try {
  const sheetOpening = refreshServiceStatus();
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

check(
  "⚠️  re-opening the menu sheet disarms — the only disarm tied to the two Pi actions' own lifecycle",
  declarationBody(sourceOf("public/views/sheet.js"), "export function openSheet()").includes('armed.val = ""')
);

console.log("\n7. the confirmed firing sites, and the rule each of them repeats");

const SITES = ARMING_CONSUMERS.flatMap(path => firingSites(path, sourceOf(path)));
console.log(`   found: ${SITES.map(site => shortName(site)).join(", ")}`);

const EXPECTED_SITES = [
  "charge-current.js → performChargeCurrent",
  "charge-soc-limit.js → performSocLimit",
  "charge-stop.js → performChargeStop",
  "freeze-frame-read.js → performFreezeFrameRead",
  "pi-actions.js → performCanRestart",
  "pi-actions.js → performUpdate",
  "settings-restart.js → performRestart",
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

  const refusedKey = refusedKeyOf(site);
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

const refusedKeys = SITES.map(refusedKeyOf);
const resolvedKeys = refusedKeys.filter(key => !key.startsWith("<"));
console.log(`   keys the sites refuse on: ${refusedKeys.join(", ")}`);
const unresolved = refusedKeys.filter(key => key.startsWith("<"));
check(
  `⚠️  the ${unresolved.length} sites whose key does not resolve use keyed action-button factories — a control ` +
    "that stopped resolving would silently leave the comparison below rather than fail it",
  unresolved.every(key => key === "<key>")
);
check(
  "the sites' keys resolved at all — everything reading back as an identifier would pass the one below in silence",
  resolvedKeys.length === 7
);
check(
  `⚠️  no two of the ${resolvedKeys.length} resolved firing sites refuse on the SAME key — two that did would each ` +
    "fire on the other's first tap",
  new Set(resolvedKeys).size === resolvedKeys.length
);

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

for (const path of ARMING_CONSUMERS) {
  const named = importedFromArming(sourceOf(path));
  if (!named.includes("arm")) {
    continue;
  }
  check(`${path} arms, so it takes the shared dwell`, named.includes("armDwellElapsed"));
  const separatedViews = new Map([
    ["public/lib/service-actions.js", "public/views/service-actions.js"],
    ["public/lib/service-lights.js", "public/views/service-actions.js"],
    ["public/lib/service-edits.js", "public/views/service-parameters.js"],
  ]);
  const view = separatedViews.get(path);
  check(
    `${path} refuses repeated Enter at its rendered control`,
    view ? sourceOf(view).includes("onkeydown: refuseKeyRepeat") : named.includes("refuseKeyRepeat")
  );
}

console.log("\n8. disarm-on-change, at the handlers that cannot be run without a DOM");

const body = enclosingArrowBody(
  sourceOf("public/views/charge-current.js"),
  "amps.val = /** @type {HTMLInputElement} */ (event.target).value;"
);
check("retyping charge amps disarms", body !== "" && body.includes('armed.val = ""'));

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
  console.log("  all confirmed firing sites still spelling the same rule — on the injected clock and on the real one");
}

function armedKeyIs(key: string): boolean {
  return armed.val === key;
}

function sourceOf(path: string): string {
  const source = SOURCES.get(path);
  if (source === undefined) {
    throw new Error(
      `check-arming: ${path} does not import the shared gate, so nothing read it — see armingConsumers()`
    );
  }
  return source;
}

function refusedKeyOf(site: FiringSite): string {
  return keyOf(site.file, site.body.match(/armed\.val !== (\w+|"[^"]*")/)?.[1]);
}

function shortName(site: FiringSite): string {
  return `${site.file.replace("public/views/", "")} → ${site.name}`;
}

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

  const declared = sourceOf(file).match(new RegExp(`const ${expression} = "([^"]+)"`));
  if (declared !== null) {
    return declared[1];
  }
  return `<${expression}>`;
}

interface RecordedKeyEvent {
  repeat: boolean;
  key: string;
  prevented: boolean;
  preventDefault(): void;
}

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
