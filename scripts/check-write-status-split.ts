import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
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

const { fetchStatus, parameterListing, refreshVcuWrite, selectedTarget } = await import("../public/views/vcu-write.js");

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
  asked.every(url => url.includes("list=0"))
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

// ── §6 the seams stay seams ───────────────────────────────────────────────────────────
const viewFiles = ["public/views/vcu-write.js", "public/views/charge-current.js", "public/views/charge-stop.js"];
for (const file of viewFiles) {
  const text = await readFile(join(ROOT, file), "utf-8");
  if (file !== "public/views/vcu-write.js" && text.includes("parameterListing")) {
    failures.push(`§6 ${file} imports parameterListing, which exists only for this check`);
  }
}
check("§6 parameterListing is not read anywhere in public/", !failures.some(entry => entry.startsWith("§6")));

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log(
  "\n✓ the status splits into a list and one detail, `list=0` never empties the picker, a sweep that " +
    "renames the table discards it, a detail that is not the selection's is refused, and armWrite still raises busy"
);
