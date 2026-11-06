import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../src/monotonic.ts";
import { injectRecoveryFault, RECOVERY_FAULTS } from "./update-check/availability.ts";
import { readUpdateStatus } from "../src/release/update-status.ts";
import { checkRequestedStop } from "./update-check/requested-stop.ts";
import { checkPeriodicAptSystemd } from "./install-check/apt-systemd-check.ts";
import {
  createUpdateFixture,
  fixtureEnvironment,
  publishFixtureRelease,
  readState,
  quote,
  REPOSITORY,
} from "./update-check/fixture.ts";

export async function checkUpdaterSystemd(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Run this check as root in its disposable Linux Actions runner, never on the bike or host laptop");
  }
  const parent = join(REPOSITORY, ".preview-shots");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "systemd-updater-"));
  const fixture = await createUpdateFixture(root);
  const service = `cool-eva-test-${process.pid}.service`;
  const rollbackService = `cool-eva-test-${process.pid}-rollback.service`;
  const updateService = `cool-eva-test-${process.pid}-update.service`;
  const repairService = `cool-eva-test-${process.pid}-repair.service`;
  const port = await freePort();
  const units: string[] = [];
  try {
    await checkPeriodicAptSystemd(join(root, "periodic-apt"), control);
    for (const command of ["systemctl", "dpkg-query", "cut", "sleep", "sync", "stat", "id"]) {
      await unlink(join(fixture.commandDirectory, command));
    }
    const configuration = JSON.parse(await readFile(fixture.configuration, "utf8"));
    configuration.service = service;
    configuration.healthUrl = `http://127.0.0.1:${port}/release-health`;
    await writeFile(fixture.configuration, JSON.stringify(configuration));
    const environment = fixtureEnvironment(fixture);
    const dispatcher = join(fixture.root, "dispatch.sh");
    await writeFile(
      dispatcher,
      (await readFile(join(REPOSITORY, "scripts/update/dispatch.sh"), "utf8")).replace(
        "helper_root=/opt/cool-eva/updater",
        `helper_root=${quote(join(fixture.code, "updater"))}`
      )
    );
    const unitEnvironment = `Environment=PATH=${environment.PATH}\nEnvironment=UPDATE_FIXTURE=${fixture.root}\nEnvironment=UPDATE_FIXTURE_REAL_HEALTH=1`;
    const updaterCommand = `/bin/sh ${dispatcher}`;
    const replayFile = join(fixture.root, "replay-can.txt");
    const unit = (await readFile(join(REPOSITORY, "scripts/update/cool-eva.service"), "utf8"))
      .replace("OnFailure=cool-eva-rollback.service", `OnFailure=${rollbackService}`)
      .replace("WorkingDirectory=/opt/cool-eva", `WorkingDirectory=${fixture.code}\n${unitEnvironment}`)
      .replace("RuntimeDirectory=cool-eva", `RuntimeDirectory=cool-eva-test-${process.pid}`)
      .replace("RestartSec=5", "RestartSec=5\nTimeoutStopSec=2")
      .replace(
        "ExecStartPre=-/usr/local/libexec/cool-eva-update recover",
        `ExecStartPre=-${updaterCommand} recover --config ${fixture.configuration}`
      )
      .replace(
        "ExecStart=/usr/local/libexec/cool-eva-launch",
        `ExecStart=${process.execPath} --experimental-strip-types ${join(REPOSITORY, "scripts/update-check/can-app.ts")} ${fixture.code} ${replayFile} ${port}`
      );
    const rollbackUnit = `[Unit]\nDescription=Synthetic updater rollback\n[Service]\nType=oneshot\n${unitEnvironment}\nExecStart=${updaterCommand} failure --config ${fixture.configuration}\n`;
    const repairUnit = `[Unit]\nDescription=Synthetic interrupted updater repair\n[Service]\nType=oneshot\n${unitEnvironment}\nExecStart=${updaterCommand} repair --config ${fixture.configuration}\n`;
    const updateUnit = (await readFile(join(REPOSITORY, "scripts/update/cool-eva-update.service"), "utf8"))
      .replace("OnFailure=cool-eva-update-repair.service", `OnFailure=${repairService}`)
      .replace(
        "ExecStart=/usr/local/libexec/cool-eva-update update",
        `${unitEnvironment}\nExecStart=${updaterCommand} update --config ${fixture.configuration}`
      );
    for (const [name, contents] of [
      [service, unit],
      [rollbackService, rollbackUnit],
      [updateService, updateUnit],
      [repairService, repairUnit],
    ]) {
      const path = `/run/systemd/system/${name}`;
      await writeFile(path, contents);
      units.push(path);
    }
    await control("daemon-reload");
    await control("start", service);
    await waitFor(async () => await healthy(configuration.healthUrl), 15_000, "initial app HTTP");
    for (const fault of RECOVERY_FAULTS) {
      await control("reset-failed", service);
      await control("stop", service);
      const restore = await injectRecoveryFault(fixture, fault);
      try {
        await control("start", service);
        await waitFor(async () => await healthy(configuration.healthUrl), 15_000, `app HTTP with ${fault}`);
        const journal = await execFileAsync("journalctl", ["-u", service, "--no-pager", "-n", "50"]);
        assert.match(journal.stdout, /RECOVERY FAILED; starting the complete current release/);
        console.log(`real systemd: app still starts with ${fault}`);
      } finally {
        await restore();
      }
    }
    await control("reset-failed", service);
    await control("stop", service);
    const absentDispatcher = join(fixture.root, "dispatch.unavailable");
    await rename(dispatcher, absentDispatcher);
    try {
      await control("start", service);
      await waitFor(async () => await healthy(configuration.healthUrl), 15_000, "app HTTP without its dispatcher");
      console.log("real systemd: app still starts when its dispatcher is unavailable");
    } finally {
      await rename(absentDispatcher, dispatcher);
    }
    const quietTag = await publishFixtureRelease(fixture, "quiet-release", "b".repeat(40));
    const appUrl = `http://127.0.0.1:${port}`;
    await fetch(`${appUrl}/test/confirm-update`);
    for (const refusal of ["moving", "busy"]) {
      const before = (await execFileAsync("systemctl", ["show", service, "--property=InvocationID", "--value"])).stdout;
      await fetch(`${appUrl}/test/${refusal}`);
      await control("start", updateService);
      assert.equal((await readState(fixture)).current, "old");
      assert.equal((await readState(fixture)).pending, null);
      const refusalMessage = (await readUpdateStatus(join(fixture.data, "updater"))).message;
      assert.match(refusalMessage, refusal === "moving" ? /Park and try again/ : /Busy: synthetic service write/);
      if (refusal === "busy") {
        assert(!refusalMessage.includes("Park and try again"));
      }
      assert.equal(
        (await execFileAsync("systemctl", ["show", service, "--property=InvocationID", "--value"])).stdout,
        before
      );
      assert(await healthy(configuration.healthUrl));
      assert((await stat(join(fixture.data, "updater/cached-bundle.tar.zst"))).size > 0);
      await fetch(`${appUrl}/test/parked`);
      console.log(
        `real systemd: stop-time ${refusal} refusal left the same app running and cached the verified bundle`
      );
    }
    await fetch(`${appUrl}/test/confirm-update`);
    await control("start", "--no-block", updateService);
    await waitFor(async () => (await readState(fixture)).pending !== null, 20_000, "interrupted trial intent");
    await waitFor(
      async () => await healthy(configuration.healthUrl, quietTag.slice("cool-eva-".length)),
      20_000,
      "candidate HTTP before killing the updater"
    );
    await control("kill", "--signal=KILL", updateService);
    await waitFor(async () => (await readState(fixture)).pending === null, 20_000, "killed updater OnFailure repair");
    assert.equal((await readState(fixture)).current, "old");
    assert.deepEqual((await readState(fixture)).rejected, []);
    assert.equal((await readState(fixture)).lastRollback?.reason, "interrupted");
    await waitFor(async () => await healthy(configuration.healthUrl), 15_000, "app after killed updater");
    await control("reset-failed", updateService);
    console.log("real systemd: killing the updater mid-trial repaired the old release without rejecting the candidate");
    await fetch(`${appUrl}/test/confirm-update`);
    const trialStarted = monotonicNow();
    await control("start", "--no-block", updateService);
    await waitFor(async () => (await readState(fixture)).pending !== null, 20_000, "trial intent");
    await control("start", "--no-block", rollbackService);
    await waitFor(
      async () => {
        const status = await readState(fixture);
        return status.pending === null && status.current !== "old";
      },
      110_000,
      "quiet promotion"
    );
    await waitFor(
      async () =>
        (
          await execFileAsync("systemctl", ["show", updateService, "--property=ActiveState", "--value"])
        ).stdout.trim() === "inactive",
      10_000,
      "helper promotion complete"
    );
    assert(since(trialStarted) >= 60_000, "the full production trial must run");
    const promoted = await readState(fixture);
    assert.equal(promoted.previous, "old");
    assert.notEqual(promoted.current, "old");
    console.log("real systemd: a quiet release survived the complete 60s promotion trial");

    // Four manual/app restarts exhaust the same limiter, without automatic crash evidence.
    await control("reset-failed", service);
    await writeFile(
      join(fixture.commandDirectory, "journalctl"),
      "#!/bin/sh\nprintf 'synthetic unavailable journal\\n' >&2\nexit 1\n",
      { mode: 0o755 }
    );
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await control("restart", service);
      } catch (error) {
        console.log("manual restart reached the expected unit start limit:", String(error));
      }
    }
    await waitFor(async () => await healthy(configuration.healthUrl), 20_000, "manual-limit reset and current restart");
    assert.equal((await readState(fixture)).current, promoted.current);
    assert.equal((await readState(fixture)).previous, "old");
    console.log("real systemd: four manual restarts restarted CURRENT without consuming its rollback target");

    await checkRequestedStop({
      fixture,
      service,
      rollbackService,
      appUrl,
      control,
      waitFor,
      healthy: () => healthy(configuration.healthUrl),
    });

    await control("reset-failed", service);
    await fetch(`${appUrl}/test/crash-once`);
    await waitFor(
      async () =>
        (await execFileAsync("systemctl", ["show", service, "--property=NRestarts", "--value"])).stdout.trim() ===
          "1" && (await healthy(configuration.healthUrl)),
      15_000,
      "automatic restart before slow manual stop"
    );
    assert.equal(
      (await execFileAsync("systemctl", ["show", service, "--property=NRestarts", "--value"])).stdout.trim(),
      "1"
    );
    await fetch(`${appUrl}/test/hold-stop`);
    await control("stop", "--no-block", service);
    await waitFor(
      async () =>
        (await execFileAsync("systemctl", ["show", service, "--property=SubState", "--value"])).stdout.trim() ===
        "failed",
      10_000,
      "manual stop SIGKILL timeout"
    );
    await control("start", rollbackService);
    assert.equal((await readState(fixture)).current, promoted.current);
    assert.equal((await readState(fixture)).previous, "old");
    assert.equal(
      (await execFileAsync("systemctl", ["show", service, "--property=Result", "--value"])).stdout.trim(),
      "timeout"
    );
    console.log("real systemd: manual stop SIGKILL timeout did not roll back despite a previous automatic restart");
    await control("reset-failed", service);
    await control("start", service);
    await waitFor(async () => await healthy(configuration.healthUrl), 15_000, "app after slow manual stop");

    await control("reset-failed", service);
    const response = await fetch(`http://127.0.0.1:${port}/replay-can`, { method: "POST" });
    assert.equal(response.status, 200);
    await waitFor(async () => (await readState(fixture)).current === "old", 45_000, "CAN crash-loop rollback");
    await waitFor(async () => await healthy(configuration.healthUrl), 15_000, "previous app HTTP after rollback");
    const recovered = await readState(fixture);
    assert.equal(recovered.previous, null);
    assert.equal(recovered.lastRollback?.reason, "start-limit-hit");
    assert.equal(recovered.pending, null);
    const journal = await execFileAsync(
      "journalctl",
      ["-u", service, "-u", rollbackService, "--no-pager", "-n", "140"],
      { maxBuffer: 1024 * 1024 }
    );
    console.log(journal.stdout);
    assert.match(journal.stdout, /first.*CAN frame/i);
    assert.match(journal.stdout, /Rolled back from/);
    console.log("real systemd: first CAN frame after promotion caused StartLimit/OnFailure and an offline rollback");

    // The next good update must remain possible, with the old rollback consumed.
    await publishFixtureRelease(fixture, "next-good", "c".repeat(40));
    await fetch(`${appUrl}/test/confirm-update`);
    await control("start", "--no-block", updateService);
    await waitFor(async () => (await readState(fixture)).pending !== null, 20_000, "next update trial");
    await waitFor(
      async () => (await readState(fixture)).pending === null && (await readState(fixture)).current !== "old",
      110_000,
      "next good promotion"
    );
    assert.notEqual((await readState(fixture)).current, "old");
    console.log("real systemd: the next good release promoted after rollback");
  } catch (error) {
    await printSystemdDiagnostics([service, rollbackService, updateService, repairService]);
    console.error("updater state at failure:", await readFile(fixture.state, "utf8"));
    throw error;
  } finally {
    for (const name of [updateService, repairService, service, rollbackService]) {
      try {
        await control("stop", name);
        await control("reset-failed", name);
      } catch (error) {
        console.warn("test unit cleanup:", String(error));
      }
    }
    for (const path of units) {
      await unlink(path);
    }
    await control("daemon-reload");
    await rm(root, { recursive: true, force: true });
  }
}

const execFileAsync = promisify(execFile);

async function printSystemdDiagnostics(units: string[]): Promise<void> {
  const commands = [
    {
      executable: "systemctl",
      arguments: ["show", ...units, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,Job"],
    },
    { executable: "systemctl", arguments: ["list-jobs", "--no-pager"] },
    { executable: "journalctl", arguments: [...units.flatMap(unit => ["-u", unit]), "--no-pager", "-n", "180"] },
  ];
  for (const command of commands) {
    try {
      console.error((await execFileAsync(command.executable, command.arguments, { maxBuffer: 1024 * 1024 })).stdout);
    } catch (error) {
      console.warn(`could not collect ${command.executable} diagnostics:`, error);
    }
  }
}

async function control(...arguments_: string[]): Promise<void> {
  await execFileAsync("systemctl", arguments_, { timeout: 20_000 });
}

async function healthy(url: string, release?: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    if (release === undefined) return true;
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" && "release" in body && body.release === release;
  } catch (error) {
    console.log("waiting for synthetic HTTP:", String(error));
    return false;
  }
}

async function waitFor(condition: () => Promise<boolean>, timeout: number, description: string): Promise<void> {
  const started = monotonicNow();
  while (!(await condition())) {
    if (since(started) > timeout) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await delay(200);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("No test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
  return address.port;
}

await checkUpdaterSystemd();
