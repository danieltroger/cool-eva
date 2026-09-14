import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";
import { parseStatusRequest } from "../src/http/vcu-write.ts";

// The write status is a LIST plus ONE DETAIL, and the two halves must not be confusable.
//
//   node --experimental-strip-types scripts/check-write-status-split.ts
//
// ⚠️ WHAT THIS EXISTS FOR. `summariseTarget` used to run for all 269 allowlist entries on every
// request, and `armWrite()` fetches before every arm — so #104 put a 256 582-byte round trip
// (249 878 of it the targets) into the arming gesture of the controls that change the motorcycle,
// on garage wifi, on a Pi Zero. Now the Pi sends three fields per name and everything else for the
// one target the page named.
//
// ⚠️ THE SCARY EDGE, and §2 is the whole reason this file exists. `selectedTarget()` used to find
// in an array whose entries carried their own names; it is now ONE object the Pi hands over, and
// it arrives a round trip after the selection moves. It decides `control.kind` — which chooses
// `action=bit` over `action=parameter` — and `onBike()`, which becomes the compare-and-swap
// `expected=`. A detail belonging to the previous selection would produce a coherent-looking write
// against the wrong parameter, so a detail whose name does not match the selection is no detail.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const failures: string[] = [];

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
    return;
  }
  console.error(`  ✗ ${what}`);
  failures.push(what);
}

console.log("\n──── scripts/check-write-status-split.ts ───────────────────────────────────────");
console.log("     the /vcu-write payload: a list, one detail, and the name that must match");

// ── §1 the endpoint's contract, through the real runner ───────────────────────────────
const directory = await mkdtemp(join(tmpdir(), "cool-eva-split-"));
const runner = createVcuWriteRunner({
  channel: () => null,
  busIsActive: false,
  enabled: true,
  directory,
  gate: () => ({ safe: true, blockers: [], checks: [], chargingEvidence: null }),
  latestSweep: async () => null,
  holdPoller: async () => null,
});

const full = await runner.status(parseStatusRequest(new URLSearchParams()));
check("a bare GET still answers the whole allowlist", (full.targets?.length ?? 0) > 200);
check("and no detail, because none was named", full.detail === null);
check(
  "a listing entry carries a name, an index and a micro — what a picker and a probe read need",
  Object.keys(full.targets?.[0] ?? {})
    .sort()
    .join(",") === "index,micro,name"
);

const named = full.targets?.[0].name ?? "";
const detailed = await runner.status(parseStatusRequest(new URLSearchParams({ detail: named })));
check("`detail=NAME` answers that target in full", detailed.detail?.name === named);
check(
  "with the fields the form renders",
  typeof detailed.detail?.purpose === "string" && Array.isArray(detailed.detail?.warnings)
);
check(
  "an unknown name is not an error, it is no detail",
  (await runner.status({ detailFor: "NOPE", includeList: false })).detail === null
);

const listless = await runner.status(parseStatusRequest(new URLSearchParams({ detail: named, list: "0" })));
// ⚠️ NULL, not []. The page keeps its own copy and must be able to tell "you already have it"
// from "this bike has nothing writable" — the second renders a sheet that can write nothing.
check("`list=0` omits the listing as null rather than as empty", listless.targets === null);
check("and still answers the detail", listless.detail?.name === named);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf-8");
check(
  `the arming refresh is a fraction of the whole: ${bytes(listless)} bytes against ${bytes(full)}`,
  bytes(listless) * 4 < bytes(full)
);
await rm(directory, { recursive: true, force: true });

// ── §2 the detail's name must match the selection ─────────────────────────────────────
//
// Driven through the real module with a stubbed fetch, the way check-arming.ts drives the arm.
const TABLE_TYPE = 16407;
const DETAIL = {
  name: "SECOND_PARAM",
  index: 2,
  micro: "A9",
  purpose: "the second one",
  warnings: [],
  verify: null,
  onBike: null,
  control: { kind: "number", min: 0, max: 10, minLabel: "0", maxLabel: "10" },
};
const LISTING = [
  { name: "FIRST_PARAM", index: 1, micro: "A9" },
  { name: "SECOND_PARAM", index: 2, micro: "A9" },
];

let served: { detail: unknown; targets: unknown; tableType: number | null } = {
  detail: null,
  targets: LISTING,
  tableType: TABLE_TYPE,
};
const asked: string[] = [];
globalThis.fetch = (async (input: string) => {
  asked.push(String(input));
  const url = new URL(String(input), "http://eva.local/");
  return new Response(
    JSON.stringify({
      status: {
        enabled: true,
        targets: url.searchParams.get("list") === "0" ? null : served.targets,
        detail: served.detail,
        tableGate: { tableType: served.tableType },
        clock: { trustworthy: true, iso: "2026-09-14T00:00:00.000Z" },
        recent: [],
      },
      result: null,
      message: null,
    }),
    { headers: { "content-type": "application/json" } }
  );
}) as unknown as typeof fetch;

const { fetchStatus, parameterListing, refreshVcuWrite, selectTarget, selectedTarget } =
  await import("../public/views/vcu-write.js");

served = { detail: DETAIL, targets: LISTING, tableType: TABLE_TYPE };
await refreshVcuWrite();
check("§2 the sheet opening loads the listing", parameterListing().length === 2);
check(
  "§2 and asks for the listing on the first request, then for a detail on the second",
  asked.length === 2 && !asked[0].includes("list=0") && asked[1].includes("detail=FIRST_PARAM")
);

// The Pi answers with the detail for a DIFFERENT parameter — an out-of-order reply, or a selection
// that moved while the request was in flight.
served = { detail: DETAIL, targets: LISTING, tableType: TABLE_TYPE };
await fetchStatus();
check("§2 ⚠️ a detail whose name is not the selection is no detail", selectedTarget() === null);

// ── §3 a list=0 refresh does not empty the picker ─────────────────────────────────────
asked.length = 0;
served = { detail: null, targets: LISTING, tableType: TABLE_TYPE };
await fetchStatus();
check(
  "§3 a refresh that already holds the names says so",
  asked.length > 0 && asked.every(url => url.includes("list=0"))
);
check("§3 and the picker still has them", parameterListing().length === 2);

// ── §4 a sweep naming a different table discards the names ────────────────────────────
//
// ⚠️ writeTargets() is derived from the ACTIVE parameter table, and a sweep finishing under this
// very sheet selects a new one (src/vcu/snapshot-store.ts). The names would otherwise stay on
// screen after the Pi stopped accepting them.
asked.length = 0;
served = { detail: null, targets: [{ name: "ONLY_PARAM", index: 9, micro: "A8" }], tableType: 20000 };
await fetchStatus();
check(
  "§4 a response naming a different table re-asks WITH the listing",
  asked.some(url => !url.includes("list=0"))
);
check(
  "§4 and the picker is replaced rather than left stale",
  parameterListing().length === 1 && parameterListing()[0].name === "ONLY_PARAM"
);
// ⚠️ The sheet must not be left asking for a name the new table has not got. Without the re-point
// `selectedTarget()` is null for ever, every later request keeps asking `detail=FIRST_PARAM`, and
// the form sits on "Reading this parameter's notes…" — which reopening the sheet does not clear,
// because forgetSelection() deliberately keeps the selection.
check(
  "§4 the selection is re-pointed at a name the new table HAS",
  asked.at(-1)?.includes("detail=ONLY_PARAM") === true
);

// ── §4b an answer that arrives out of order is dropped ────────────────────────────────
//
// The `<select>` starts a request on every change, so two can be in flight and the OLDER one
// carries a detail for a parameter the form has already left. Applied, it lands a detail
// selectedTarget() refuses with nothing on its way to replace it — the stuck sheet of §4 by a
// different route. The stub below answers the first request slowly and the second at once, so the
// replies really do arrive in the wrong order rather than being asserted about in the abstract.
served = { detail: { ...DETAIL, name: "ONLY_PARAM", index: 9, micro: "A8" }, targets: null, tableType: 20000 };
await fetchStatus();
check("§4b a matching detail is adopted", selectedTarget()?.name === "ONLY_PARAM");

const SECOND = { ...DETAIL, name: "SECOND_ONLY", index: 10, micro: "A8" };
// Initialised to a no-op rather than null: assigned only inside a promise executor, TypeScript's
// control flow narrows a `null` start to `never` at the call below.
let releaseHeldRequest = () => {};
globalThis.fetch = (async (input: string) => {
  asked.push(String(input));
  const wanted = new URL(String(input), "http://eva.local/").searchParams.get("detail");
  const body = JSON.stringify({
    status: {
      enabled: true,
      targets: null,
      detail: wanted === "SECOND_ONLY" ? SECOND : { ...DETAIL, name: "ONLY_PARAM", index: 9, micro: "A8" },
      tableGate: { tableType: 20000 },
      clock: { trustworthy: true, iso: "2026-09-14T00:00:00.000Z" },
      recent: [],
    },
    result: null,
    message: null,
  });
  if (wanted === "ONLY_PARAM") {
    await new Promise<void>(resolve => {
      releaseHeldRequest = resolve;
    });
  }
  return new Response(body, { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const stale = fetchStatus();
await new Promise(resolve => setTimeout(resolve, 10));
// The real `<select>` handler, not a copy of it.
selectTarget("SECOND_ONLY");
await new Promise(resolve => setTimeout(resolve, 10));
check("§4b the newer answer lands", selectedTarget()?.name === "SECOND_ONLY");
// ⚠️ Green with the counter removed too — the re-ask rule repairs it on the next request. What the
// counter buys is below: no wasted round trip, and no flash of a detail the form has left.
releaseHeldRequest();
await stale;
check(
  "§4b the form still ends on the newer parameter — TRUE WITH OR WITHOUT the counter, because the " +
    "re-ask rule repairs it on the next request; §4c is what the counter itself is asserted by",
  selectedTarget()?.name === "SECOND_ONLY"
);

// ── §4c THE COUNTER: a superseded reply is dropped rather than applied and repaired ───
//
// What the counter buys over the re-ask rule alone: no wasted round trip, and no flash of a detail
// the form has already left. One request for the new parameter, not two.
check(
  "§4c ⚠️ the superseded reply is dropped rather than applied and then repaired",
  asked.filter(url => url.includes("SECOND_ONLY")).length === 1
);

// ── §5 the pre-arm refresh still raises busy ──────────────────────────────────────────
//
// ⚠️ #107's warning, kept alive: the refresh before arming exists to raise `busy`, and that is the
// double-tap guard on the controls that change the bike. A payload fix that removed it would look
// like an improvement. check-charge-write-visibility.ts §5 holds the two charge views; this one
// holds the sheet, whose function is named differently and whose refresh is fetchStatus().
const source = await readFile(join(ROOT, "public", "views", "vcu-write.js"), "utf-8");
const armStart = source.indexOf("async function armWrite()");
const armBody = armStart < 0 ? "" : source.slice(armStart, source.indexOf("\n}", armStart));
const refreshAt = armBody.indexOf("fetchStatus(");
check("§5 armWrite() was found at all", armStart >= 0 && refreshAt > 0);
check(
  "§5 and it raises busy BEFORE the refresh it arms behind",
  armBody.slice(0, refreshAt).includes("busy.val = true")
);

// ── §5b a POST reply is adopted the same way a GET's is ───────────────────────────────
//
// ⚠️ A POST answers the same payload, and a sweep can finish across one — so `send()` must take
// the listing through the same door `fetchStatus()` does, or a reply adopted without the check
// leaves the picker offering names the Pi has stopped accepting. Asserted on the source because
// send() is reached only from a button press, and the rule is that BOTH call sites go through it.
const sendStart = source.indexOf("async function send(query)");
const sendBody = sendStart < 0 ? "" : source.slice(sendStart, source.indexOf("\n}", sendStart));
check("§5b send() was found at all", sendStart >= 0 && sendBody.length > 0);
check("§5b and it adopts the listing the way fetchStatus does", sendBody.includes("adoptListing("));

// ── §5c armWrite does not arm behind a refresh that did not happen ────────────────────
//
// ⚠️ The hole the ordering counter opened, and the reason fetchStatus() reports whether it applied.
// A superseded reply applies NOTHING, so `armWrite()`'s before/after comparison compares the same
// untouched state, finds it unchanged, and arms — on the value the tap started with rather than on
// the Pi's answer now, which is the entire contract of refreshing before arming. Opening the red
// fold or changing the picker during that round trip is enough, and `busy` disables neither.
// Behavioural first: the scrape below cannot see a fetchStatus() that starts reporting `true` for
// a reply it dropped, which is the same hole one layer down.
const pending: (() => void)[] = [];
globalThis.fetch = (async (input: string) => {
  asked.push(String(input));
  await new Promise<void>(resolve => {
    pending.push(resolve);
  });
  return new Response(
    JSON.stringify({
      status: {
        enabled: true,
        targets: null,
        detail: { ...DETAIL, name: "SECOND_ONLY", index: 10, micro: "A8" },
        tableGate: { tableType: 20000 },
        clock: { trustworthy: true, iso: "2026-09-14T00:00:00.000Z" },
        recent: [],
      },
      result: null,
      message: null,
    }),
    { headers: { "content-type": "application/json" } }
  );
}) as unknown as typeof fetch;
const heldRead = fetchStatus();
await new Promise(resolve => setTimeout(resolve, 10));
const newerRead = fetchStatus();
await new Promise(resolve => setTimeout(resolve, 10));
for (const release of pending) {
  release();
}
check("§5c a superseded read reports that it did NOT apply", (await heldRead) === false);
check("§5c and the newest one reports that it did", (await newerRead) === true);
check("§5c armWrite reads whether its refresh applied", /=\s*await fetchStatus\(\)/.test(armBody));
check("§5c and will not arm without it", /if \(refreshed &&/.test(armBody));

// ── §5d a Pi that renames its table AND its listing every reply is given up on ───────
//
// ⚠️ THE CASE THAT ONCE DELETED A GUARD. `adoptListing` cannot say yes twice running, and an
// earlier version of this section proved exactly that and concluded the re-ask was one hop by
// construction — so the bound was removed as dead code. It is not dead: adoptListing ALTERNATES
// with the selection re-ask, which asks WITH the listing and hands `listingHeldFor` straight back.
// The stub below is the one that shows it, and the earlier one could not: a different tableType
// AND a different listing every reply, so the selection is re-pointed each time. Against an
// unbounded reader this ran to 41 requests and was still going.
let flip = 0;
asked.length = 0;
globalThis.fetch = (async (input: string) => {
  asked.push(String(input));
  flip += 1;
  const wantsList = !String(input).includes("list=0");
  return new Response(
    JSON.stringify({
      status: {
        enabled: true,
        targets: wantsList ? [{ name: `PARAM_${flip}`, index: flip, micro: "A9" }] : null,
        detail: null,
        tableGate: { tableType: 30000 + flip },
        clock: { trustworthy: true, iso: "2026-09-14T00:00:00.000Z" },
        recent: [],
      },
      result: null,
      message: null,
    }),
    { headers: { "content-type": "application/json" } }
  );
}) as unknown as typeof fetch;
const loopWarnings: string[] = [];
const realWarnForLoop = console.warn;
console.warn = (...args: unknown[]) => void loopWarnings.push(args.map(String).join(" "));
const gaveUp = await fetchStatus();
console.warn = realWarnForLoop;
check(`§5d it stops in a handful of requests rather than looping (${asked.length})`, asked.length <= 8);
check("§5d and reports that it gave up rather than answering as if it had worked", gaveUp === false);
check(
  "§5d loudly, because this cannot happen on a settled bike",
  loopWarnings.some(entry => entry.includes("gave up re-asking"))
);

// ── §5e send() is in the same queue and under the same re-ask rule ────────────────────
//
// Structural, like §5b's: send() is reached only from a button press. A POST answers the same
// payload, so a picker change while one is in flight lands a detail for the parameter the form has
// left — the stuck sheet of §4, through the one path §4 does not cover.
check("§5e send() applies its status only while it is the newest read", sendBody.includes("read === latestStatusRead"));
check("§5e and re-asks when the selection moved under it", sendBody.includes("selected.val !== askedFor"));

// ── §6 the seams stay seams ───────────────────────────────────────────────────────────
//
// ⚠️ The WHOLE of public/, not a list of files somebody has to remember to extend — a hard-coded
// three would have said nothing about the fourth view that imported it.
const readers: string[] = [];
for (const entry of await readdir(join(ROOT, "public"), { recursive: true })) {
  if (!entry.endsWith(".js") || entry.startsWith("vendor")) {
    continue;
  }
  const text = await readFile(join(ROOT, "public", entry), "utf-8");
  if (entry !== join("views", "vcu-write.js") && text.includes("parameterListing")) {
    readers.push(entry);
  }
}
check(`§6 parameterListing is read nowhere else in public/ (${readers.join(", ") || "none"})`, readers.length === 0);

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log(
  "\n✓ the status splits into a list and one detail, `list=0` never empties the picker, a sweep that " +
    "renames the table discards it, a detail that is not the selection's is refused, and armWrite still raises busy"
);
