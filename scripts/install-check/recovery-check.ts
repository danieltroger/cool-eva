import assert from "node:assert/strict";
import { chmod, symlink, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createUpdateFixture, fixtureEnvironment } from "../update-check/fixture.ts";
import { verifyUpdaterRecovery } from "./recovery.ts";

export async function checkRecoveryAssertion(directory: string, only?: RecoveryFault): Promise<void> {
  const fixture = await createUpdateFixture(directory);
  const guest = { key: "unused", knownHosts: "unused", port: 0 };
  let environment = fixtureEnvironment(fixture);
  const execute = async (_guest: typeof guest, command: string): Promise<string> => {
    const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command.replaceAll("sudo sh ", "/bin/sh ")], {
      env: environment,
      timeout: 15_000,
    });
    return stdout;
  };
  const verify = () => verifyUpdaterRecovery(guest, execute, join(fixture.helpers, "run.sh"), fixture.configuration);
  await verify();
  const state = await readFile(fixture.state);
  const noJq = join(fixture.root, "no-jq");
  await mkdir(noJq);
  await symlink("/usr/bin/dirname", join(noJq, "dirname"));
  const faults: RecoveryFault[] = only ? [only] : ["wrong-mode", "damaged-state", "missing-jq"];
  for (const fault of faults) {
    if (fault === "wrong-mode") {
      await chmod(fixture.state, 0o644);
      await assert.rejects(verify, /Unsafe updater state/);
    } else if (fault === "damaged-state") {
      await writeFile(fixture.state, "{damaged");
      await assert.rejects(verify, /Invalid updater state/);
    } else {
      environment = { ...environment, PATH: noJq };
      await assert.rejects(verify);
    }
    await chmod(fixture.state, 0o600);
    await writeFile(fixture.state, state);
    environment = fixtureEnvironment(fixture);
    await verify();
    console.log(`Updater gate: ${fault} fails closed; restored baseline passes.`);
  }
}

type RecoveryFault = "wrong-mode" | "damaged-state" | "missing-jq";
