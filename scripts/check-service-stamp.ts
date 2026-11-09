// Historical source-check findings: docs/service-legacy.md.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describeStampEvidence } from "../public/lib/service-stamp.js";
import { SERVICE_STAMP_IDENTIFIERS, interpretServiceStamp } from "../src/vcu/service-actions.ts";

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

{
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

  check(
    "and NOT the implausible note, which the outcome sentence already carries",
    !lines.join(" ").includes(stamp.implausible ?? "\u0000")
  );

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

{
  const retired = ["Untr" + "ied", "identifiers has ever " + "been read", "identifiers have never " + "been read"];
  const tracked = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"])).stdout
    .split("\n")
    .filter(Boolean);
  const removed = new Set((await run("git", ["ls-files", "--deleted"])).stdout.split("\n").filter(Boolean));
  const offenders: string[] = [];
  for (const path of tracked) {
    if (!/\.(ts|js|md)$/.test(path)) {
      continue;
    }
    if (removed.has(path)) continue;
    const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const [index, text_line] of text.split("\n").entries()) {
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
console.log("\n✓ the stamp formatter preserves every raw word and the retired claim is gone");
