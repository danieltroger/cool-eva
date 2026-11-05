import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, InstallerSystemctlError } from "../../src/install/commands.ts";
import { printInstallationFailure, ServiceRecoveryError } from "../../src/install/errors.ts";
import type { ServiceControlFixture } from "./service-control-fixture.ts";

export async function checkServiceRecoveryEdges(directory: string, fixture: ServiceControlFixture): Promise<void> {
  for (const job of ["", "0"]) {
    await resetFixture(directory);
    if (job === "0") {
      await writeFile(join(directory, "zero-job"), "");
    }
    const started = fixture.now();
    await assert.rejects(fixture.control.waitForRunningService("cool-eva.service"), /is stopped/);
    assert.equal(fixture.now(), started, "Inactive without a job must fail before sleeping");
  }
  await resetFixture(directory);
  await writeFile(join(directory, "state"), "active");
  await writeFile(join(directory, "queued-start"), "");
  const started = fixture.now();
  await fixture.control.waitForRunningService("cool-eva.service");
  assert.equal(fixture.now() - started, 11_000, "Allow the queued job, then require ten full seconds of stability");
  await readFile(join(directory, "queue-sampled"));
  await resetFixture(directory);
  await writeFile(join(directory, "state"), "active");
  fixture.expireDuringPoll();
  await assert.rejects(fixture.control.waitForRunningService("cool-eva.service"), /did not reach running state/);

  for (const mode of ["fresh-select", "before-backup"]) {
    await resetFixture(directory);
    await writeFile(join(directory, mode), "");
    if (mode === "fresh-select") {
      await writeFile(join(directory, "no-unit"), "");
    } else {
      await writeFile(join(directory, "state"), "active");
    }
    const started = fixture.now();
    const failure = await capturedFailure(() => fixture.recovery.prepareServiceWithRecovery("/synthetic/release"));
    assert.equal(
      Object.getPrototypeOf(failure),
      Error.prototype,
      "Preparation before a backup must keep the original error"
    );
    assert.match(failure.message, mode === "fresh-select" ? /Fresh selection failed/ : /Backup write failed/);
    assertRetryAdvice(failure);
    assert.equal(fixture.now(), started, "No service was stopped; do not wait for one");
    const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n");
    assert.equal(calls.length, 2, "Only identify the two possible existing units; do not attempt recovery");
    assert.equal(await readFile(join(directory, "state"), "utf8"), mode === "fresh-select" ? "inactive" : "active");
  }
  await resetFixture(directory);
  await writeFile(join(directory, "no-unit"), "");
  const original = new InstallerSystemctlError("enable", 1, new Error("synthetic pre-unit failure"));
  const before = fixture.now();
  const uninstalled = await capturedFailure(() => fixture.recovery.failAfterServiceRecovery(null, original));
  assert.equal(uninstalled, original, "A missing unit must retain the original pre-unit failure");
  assertRetryAdvice(uninstalled);
  assert.equal(fixture.now(), before);
  assert(
    !(await readFile(join(directory, "calls"), "utf8")).includes("--property=Job"),
    "Do not wait on an uninstalled unit"
  );

  const backup = {
    service: "cool-eva.service",
    unit: "/etc/systemd/system/cool-eva.service",
    original: "legacy fixture",
  };
  for (const mode of ["crash-loop", "pid-change", "restart-count"]) {
    await resetFixture(directory);
    await writeFile(join(directory, mode), "");
    const before = fixture.now();
    const failure = await capturedFailure(() =>
      fixture.recovery.failAfterServiceRecovery(backup, new Error("synthetic activation failure"))
    );
    assert(failure instanceof ServiceRecoveryError, mode);
    const output: string[] = [];
    printInstallationFailure(failure, (...values) => output.push(values.join(" ")));
    assert.match(output.join("\n"), /STOPPED/);
    assert(!output.join("\n").includes("running again"));
    assert(fixture.now() - before < 10_000, "An observed restart must reject recovery immediately");
    if (mode === "crash-loop") {
      const next = await command("systemctl", ["show", "cool-eva.service"]);
      assert.match(next, /MainPID=456/);
      assert.match(next, /NRestarts=1/);
    }
  }
  console.log(
    "service recovery edges: empty/zero Job fast-fail, queued job, untouched installs retry, stable PID/restart-count window and crash-loop STOPPED passed"
  );
}

async function resetFixture(directory: string): Promise<void> {
  for (const name of [
    "fail-new",
    "fail-restore",
    "fail-start",
    "fail-select",
    "migration-fault",
    "no-unit",
    "fresh-select",
    "before-backup",
    "queued-start",
    "queue-sampled",
    "zero-job",
    "crash-loop",
    "pid-change",
    "restart-count",
    "sample",
  ]) {
    await rm(join(directory, name), { force: true });
  }
  await writeFile(join(directory, "calls"), "");
  await writeFile(join(directory, "state"), "inactive");
  await writeFile(join(directory, "unit"), "new");
}

async function capturedFailure(operation: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error, "The operation must fail");
  return failure;
}

function assertRetryAdvice(failure: unknown): void {
  const output: string[] = [];
  printInstallationFailure(failure, (...values) => output.push(values.join(" ")));
  assert.match(output.join("\n"), /paste the same setup line/);
  assert(!output.join("\n").includes("STOPPED"));
  assert(!output.join("\n").includes("running again"));
}
