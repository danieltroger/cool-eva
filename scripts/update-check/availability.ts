import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createUpdateFixture, fixtureEnvironment, quote, REPOSITORY, type UpdateFixture } from "./fixture.ts";

export async function checkUpdaterAvailability(parent: string): Promise<void> {
  const fixture = await createUpdateFixture(parent);
  const dispatcher = join(fixture.root, "dispatch.sh");
  await writeFile(
    dispatcher,
    (await readFile(join(REPOSITORY, "scripts/update/dispatch.sh"), "utf8")).replace(
      "helper_root=/opt/cool-eva/updater",
      `helper_root=${quote(join(fixture.code, "updater"))}`
    )
  );
  const execute = promisify(execFile);
  for (const fault of RECOVERY_FAULTS) {
    const restore = await injectRecoveryFault(fixture, fault);
    try {
      const result = await execute("sh", [dispatcher, "recover", "--config", fixture.configuration], {
        env: fixtureEnvironment(fixture),
        timeout: 30_000,
      });
      assert.match(result.stderr, /RECOVERY FAILED; starting the complete current release/);
      assert.equal(await readlink(join(fixture.code, "current")), "releases/old");
      await execute(join(fixture.code, "current/runtime/bin/node"), ["src/index.ts"], {
        env: fixtureEnvironment(fixture),
      });
      await assert.rejects(
        execute("sh", [dispatcher, "update", "--config", fixture.configuration], {
          env: fixtureEnvironment(fixture),
          timeout: 30_000,
        }),
        `${fault}: explicit updates must still fail closed`
      );
    } finally {
      await restore();
    }
  }
}

export const RECOVERY_FAULTS = ["jq missing", "mode drift", "damaged state"] as const;

export async function injectRecoveryFault(
  fixture: UpdateFixture,
  fault: (typeof RECOVERY_FAULTS)[number]
): Promise<() => Promise<void>> {
  if (fault === "jq missing") {
    const command = join(fixture.commandDirectory, "jq");
    await writeFile(command, "#!/bin/sh\nprintf 'synthetic jq unavailable\\n' >&2\nexit 127\n", { mode: 0o755 });
    return () => unlink(command);
  }
  if (fault === "mode drift") {
    await chmod(fixture.configuration, 0o644);
    return () => chmod(fixture.configuration, 0o600);
  }
  const original = await readFile(fixture.state, "utf8");
  await writeFile(fixture.state, "damaged updater state\n");
  return () => writeFile(fixture.state, original);
}
