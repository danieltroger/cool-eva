import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command, InstallerSystemctlError } from "../src/install/commands.ts";
import {
  printInstallationFailure,
  MigrationNeedsHelpError,
  ServiceRecoveryError,
  ServiceRestoredError,
} from "../src/install/errors.ts";
import { waitForRunningService } from "../src/install/service-control.ts";
import { createServiceControlFixture } from "./install-check/service-control-fixture.ts";
import { monotonicNow, since } from "../src/monotonic.ts";
import { checkServiceRecoveryEdges } from "./install-check/service-recovery-cases.ts";

export async function checkInstallerService(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-service-control-"));
  const savedEnvironment = { PATH: process.env.PATH, INSTALL_SERVICE_FIXTURE: process.env.INSTALL_SERVICE_FIXTURE };
  const messages: string[] = [];
  const savedError = console.error;
  console.error = (...values: unknown[]) => {
    messages.push(values.join(" "));
    savedError(...values);
  };
  try {
    const fixture = await createServiceControlFixture(directory);
    process.env.PATH = `${join(directory, "bin")}:/usr/bin:/bin`;
    process.env.INSTALL_SERVICE_FIXTURE = directory;
    if (process.argv.includes("--edges-only")) {
      await checkServiceRecoveryEdges(directory, fixture);
      return;
    }
    if (!process.argv.includes("--failures-only")) {
      await writeFile(join(directory, "slow-reload"), "");
      await writeFile(join(directory, "slow-enable"), "");
      const started = monotonicNow();
      await fixture.service.installBundleUnits("/synthetic/release", "main");
      await waitForRunningService("cool-eva.service");
      assert(since(started) >= 62_000, "Both synchronous manager operations really exceeded 30 seconds");
      const calls = await readFile(join(directory, "calls"), "utf8");
      assert.match(calls, /enable cool-eva.service\nstart --no-block cool-eva.service/);
      await rm(join(directory, "slow-reload"));
      await rm(join(directory, "slow-enable"));
    }
    for (const operation of ["fail", "signal", "timeout-probe"]) {
      let failure: unknown;
      try {
        await command(
          "systemctl",
          [operation, "SYNTHETIC-CREDENTIAL"],
          operation === "timeout-probe" ? 100 : undefined
        );
      } catch (error) {
        failure = error;
      }
      assert(failure instanceof InstallerSystemctlError);
      assert(failure.durationMs > 0);
      assert.equal(failure.code, operation === "fail" ? 23 : null);
      assert.equal(failure.signal, operation === "fail" ? null : "SIGTERM");
      assert.equal(failure.killed, operation === "timeout-probe");
      assert.match(failure.message, /exit=.*signal=.*killed=.*duration=\d+ ms/);
      assert(messages.includes(failure.message), "Lifecycle details must also be logged");
      assert(!failure.message.includes("SYNTHETIC-CREDENTIAL"));
    }
    const backup = {
      service: "cool-eva.service",
      unit: "/etc/systemd/system/cool-eva.service",
      original: "legacy fixture",
    };
    for (const mode of ["restore-running", "restore-reload-fails", "restore-start-fails", "fresh-stopped"]) {
      await writeFile(join(directory, "state"), "inactive");
      await writeFile(join(directory, "unit"), "new");
      for (const marker of ["fail-new", "fail-restore", "fail-start"]) {
        await rm(join(directory, marker), { force: true });
      }
      await writeFile(join(directory, "fail-new"), "");
      if (mode === "restore-reload-fails") {
        await writeFile(join(directory, "fail-restore"), "");
      }
      if (mode === "restore-start-fails") {
        await writeFile(join(directory, "fail-start"), "");
      }
      let activationFailure: unknown;
      try {
        await fixture.service.installBundleUnits("/synthetic/release", "main");
      } catch (error) {
        activationFailure = error;
      }
      assert(activationFailure instanceof InstallerSystemctlError);
      let failure: unknown;
      try {
        await fixture.recovery.failAfterServiceRecovery(mode === "fresh-stopped" ? null : backup, activationFailure);
      } catch (error) {
        failure = error;
      }
      const output: string[] = [];
      printInstallationFailure(failure, (...values) => output.push(values.join(" ")));
      if (mode === "restore-running") {
        assert(failure instanceof ServiceRestoredError);
        assert.equal(await readFile(join(directory, "state"), "utf8"), "active");
        assert.equal(await readFile(join(directory, "unit"), "utf8"), "old");
        assert.match(output.join("\n"), /service is running again/);
      } else {
        assert(failure instanceof ServiceRecoveryError, mode);
        assert.notEqual(await readFile(join(directory, "state"), "utf8"), "active");
        assert.match(output.join("\n"), /STOPPED.*sudo systemctl daemon-reload.*sudo systemctl start cool-eva.service/);
        assert(!output.join("\n").includes("paste the same setup line"));
      }
    }
    for (const marker of ["fail-new", "fail-restore", "fail-start"]) {
      await rm(join(directory, marker), { force: true });
    }
    await writeFile(join(directory, "fail-select"), "");
    await assert.rejects(fixture.recovery.prepareServiceWithRecovery("/synthetic/release"), ServiceRestoredError);
    assert.equal(
      await readFile(join(directory, "state"), "utf8"),
      "active",
      "A selection failure after stop must restore the old service"
    );
    await rm(join(directory, "fail-select"));
    await writeFile(join(directory, "migration-fault"), "");
    await assert.rejects(fixture.recovery.prepareServiceWithRecovery("/synthetic/release"), MigrationNeedsHelpError);
    assert.equal(
      await readFile(join(directory, "state"), "utf8"),
      "inactive",
      "An unfinished data move must remain quiescent for repair"
    );
    const main = await readFile(new URL("../src/install/main.ts", import.meta.url), "utf8");
    assert.match(main, /const backup = await prepareServiceWithRecovery\(directory\)/);
    let corrupt: unknown;
    try {
      JSON.parse('{"dashboardBluetoothSecret":SYNTHETIC-SECRET}');
    } catch (error) {
      corrupt = error;
    }
    assert(corrupt instanceof SyntaxError);
    for (const error of [
      new ServiceRestoredError(corrupt),
      new ServiceRecoveryError("cool-eva.service", { cause: corrupt }),
    ]) {
      const output: string[] = [];
      printInstallationFailure(error, (...values) => output.push(values.join(" ")));
      assert(!output.join("\n").includes("SYNTHETIC"));
      assert.match(output.join("\n"), /Stored configuration could not be read/);
    }
    assert.match(main, /catch \(error\) \{\s*return failAfterServiceRecovery\(backup, error\);/);
    assert.match(main, /view = await checkInstalledApp\(metadata.release\)/);
    await checkServiceRecoveryEdges(directory, fixture);
    console.log(
      "installer service: slow manager operations, nonblocking start, lifecycle evidence, restored running service or explicit STOPPED advice passed"
    );
  } finally {
    console.error = savedError;
    for (const name of ["PATH", "INSTALL_SERVICE_FIXTURE"] as const) {
      const original = savedEnvironment[name];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

await checkInstallerService();
