import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAptFixture, readAptGuard, runAptProgram } from "./apt-fixture.ts";

export async function checkPeriodicApt(directory: string): Promise<void> {
  const guard = await createAptFixture(join(directory, "guard"));
  await runAptProgram(guard, "install_periodic_apt_guard");
  for (const unit of guard.units) {
    const contents = await readAptGuard(guard, unit);
    const command = contents.trim().split("ExecCondition=/bin/sh -c '")[1]?.slice(0, -1);
    assert(command, unit);
    assert(!contents.includes("ExecCondition=\n"), "Do not reset charging conditions");
    for (const [status, expected] of [
      [0, 0],
      [75, 1],
      [66, 0],
      [64, 0],
    ] as const) {
      let code = 0;
      try {
        await promisify(execFile)("/bin/sh", ["-c", command.replaceAll("$$", "$").replaceAll("%%", "%")], {
          env: { ...guard.environment, APT_FLOCK_STATUS: String(status) },
        });
      } catch (error) {
        assert(error instanceof Error && "code" in error && typeof error.code === "number");
        code = error.code;
      }
      assert.equal(code, expected, `${unit}: flock ${status}`);
    }
  }
  for (const variant of [
    "idle",
    "zero-job",
    "not-found",
    "admitted",
    "queued",
    "expiry",
    "query-error",
    "final-query",
  ] as const) {
    const fixture = await createAptFixture(join(directory, variant));
    const first = variant === "admitted" ? "activating" : "inactive";
    await writeFile(
      join(fixture.commands, "systemctl"),
      `#!/bin/sh
read elapsed idle < "$APT_FIXTURE_ROOT/uptime"
case '${variant}' in
  query-error) exit 124 ;;
  final-query)
    printf '300 0\\n' > "$APT_FIXTURE_ROOT/uptime"
    exit 124 ;;
esac
state=${first}
job=
if [ '${variant}' = not-found ]; then printf 'LoadState=not-found\\nActiveState=inactive\\nJob=\\n'; exit 0; fi
if [ '${variant}' = zero-job ]; then job=0; fi
if [ '${variant}' = expiry ]; then state=activating; job=42; fi
if [ '${variant}' = queued ] && [ "$elapsed" -lt 30 ]; then job=42; fi
if [ '${variant}' = admitted ] && [ "$elapsed" -ge 30 ]; then state=inactive; fi
printf 'LoadState=loaded\\nActiveState=%s\\nJob=%s\\n' "$state" "$job"
`,
      { mode: 0o755 }
    );
    const output = await runAptProgram(
      fixture,
      'drain_periodic_apt\nprintf "health reached\\n" > "$APT_FIXTURE_ROOT/activated"'
    );
    await access(join(fixture.root, "activated"));
    const elapsed = Number((await readFile(join(fixture.root, "uptime"), "utf8")).split(" ")[0]);
    assert.equal(
      elapsed,
      ["expiry", "query-error", "final-query"].includes(variant)
        ? 300
        : ["admitted", "queued"].includes(variant)
          ? 30
          : 0,
      variant
    );
    assert.match(output, /Waiting for scheduled package jobs \(0s\)/);
    if (elapsed === 300) {
      assert.match(output, /A scheduled package job.*300s.*Continuing setup/);
      assert.match(output, /keep power on and paste the same line again/);
      assert(output.includes("apt-daily.service=") && output.includes("apt-daily-upgrade.service="));
      if (variant !== "expiry") {
        assert.match(output, /unknown\/query-exit=124/);
      }
    } else {
      assert(!output.includes("Continuing setup"));
    }
    if (elapsed > 0 && variant !== "final-query") {
      assert.match(output, /Waiting for scheduled package jobs \(15s\)/);
    }
    const budgets = (await readFile(join(fixture.root, "query-budgets"), "utf8")).trim().split("\n").map(Number);
    assert(budgets.every(value => value > 0 && value <= 5));
  }
  await rm(join(guard.root, "cache"), { recursive: true });
  console.log(
    "periodic APT: generated conflict-only guards; idle/queued/admitted jobs; query errors and expiry continue to health"
  );
}
