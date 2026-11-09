// Historical source-check findings: docs/service-legacy.md.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";
import { parseStatusRequest } from "../src/http/vcu-write.ts";

function check(what: string, condition: boolean) {
  assert.ok(condition, what);
}

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

check("`list=0` omits the listing as null rather than as empty", listless.targets === null);
check("and still answers the detail", listless.detail?.name === named);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf-8");
check(
  `the arming refresh is a fraction of the whole: ${bytes(listless)} bytes against ${bytes(full)}`,
  bytes(listless) * 4 < bytes(full)
);
runner.stop();
await rm(directory, { recursive: true, force: true });

console.log("✓ write status remains a compact list plus one named detail");
