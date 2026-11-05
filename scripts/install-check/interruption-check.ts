import assert from "node:assert/strict";
import { readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUpdateFixture, commandWrapper, invokeUpdater, fixtureEnvironment } from "../update-check/fixture.ts";
import { verifyUpdaterRecovery } from "./recovery.ts";
import type { GuestSsh } from "./ssh.ts";

export async function checkBootstrapInterruption(directory: string): Promise<void> {
  const fixture = await createUpdateFixture(directory);
  await rm(fixture.state);
  await rm(join(fixture.code, "updater"), { recursive: true });
  const move = join(fixture.commandDirectory, "mv");
  await writeFile(
    move,
    `#!/bin/sh
for argument do destination=$argument; done
if [ "$destination" = '${fixture.state}' ]; then echo 'synthetic state publication interruption' >&2; exit 77; fi
${commandWrapper("mv").replace("#!/bin/sh\n", "")}`,
    { mode: 0o755 }
  );
  await assert.rejects(invokeUpdater(fixture, "initialise"), /synthetic state publication interruption/);
  await assert.rejects(readFile(fixture.state), /ENOENT/, "No state may be published before helpers");
  const helper = await readlink(join(fixture.code, "updater/current"));
  assert.match(await readFile(join(fixture.code, "updater", helper, "run.sh"), "utf8"), /self-test/);
  await writeFile(move, commandWrapper("mv"), { mode: 0o755 });
  await invokeUpdater(fixture, "initialise");
  assert.equal(
    await readlink(join(fixture.code, "updater/current")),
    helper,
    "Resume should reuse the validated generation"
  );
  const execute = async (_guest: GuestSsh, command: string): Promise<string> => {
    const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command.replaceAll("sudo sh ", "/bin/sh ")], {
      env: fixtureEnvironment(fixture),
      timeout: 10_000,
    });
    return stdout;
  };
  await verifyUpdaterRecovery(
    { key: "unused", knownHosts: "unused", port: 0 },
    execute,
    join(fixture.code, "updater/current/run.sh"),
    fixture.configuration
  );
  console.log("updater bootstrap: durable helper before state interruption, then idempotent initialise/recover passed");
}
