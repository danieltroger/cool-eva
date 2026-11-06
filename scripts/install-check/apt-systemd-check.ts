import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../../src/monotonic.ts";
import { quote, REPOSITORY } from "../update-check/fixture.ts";
import { createAptFixture, readAptGuard, runAptProgram, writeAptProgram, type AptFixture } from "./apt-fixture.ts";

export async function checkPeriodicAptSystemd(
  root: string,
  control: (...arguments_: string[]) => Promise<void>,
  only?: string
): Promise<void> {
  assert(
    process.platform === "linux" && process.getuid?.() === 0 && process.env.GITHUB_ACTIONS === "true",
    "Use a disposable native systemd test runner, never a Pi"
  );
  assert(only === undefined || only === "missing-directory", "Unknown native APT fixture");
  const units: [string, string] = [
    `cool-eva-apt-test-${process.pid}.service`,
    `cool-eva-apt-upgrade-test-${process.pid}.service`,
  ];
  const target = `cool-eva-apt-test-${process.pid}.target`;
  const fixture = await createAptFixture(join(root, "guard-%n"), { real: true, units });
  await runAptProgram(fixture, "install_periodic_apt_guard");
  const worker = join(root, "worker.sh");
  const events = join(root, "events");
  await writeFile(events, "");
  await writeFile(
    worker,
    `#!/bin/sh
printf 'WORKER\\n' >> ${quote(events)}
while [ -e ${quote(join(root, "wait"))} ] && [ ! -e ${quote(join(root, "release"))} ]; do sleep 0.05; done
printf 'FINISHED\\n' >> ${quote(events)}
`
  );
  try {
    for (const unit of units) {
      await mkdir(`/run/systemd/system/${unit}.d`, { recursive: true });
      await writeFile(
        `/run/systemd/system/${unit}`,
        `[Unit]\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nExecStart=/bin/sh ${quote(worker)}\n`
      );
      await writeFile(`/run/systemd/system/${unit}.d/40-cool-eva-install.conf`, await readAptGuard(fixture, unit));
    }
    // Active references prevent completed/skipped oneshots losing recorded results to unloading.
    await writeFile(`/run/systemd/system/${target}`, `[Unit]\nWants=${units.join(" ")}\n`);
    await control("daemon-reload");
    await control("start", target);
    if (!only) {
      for (const outcome of ["success", "failure", "hangup"] as const) {
        await checkLockLifetime(fixture, units, outcome, control, events);
      }
      await checkNativeDrain(fixture, units[0], root, control, events);
      await checkCharging(root, units[1], control, events);
      await rm(join(fixture.root, "cache/install.lock"));
      for (const unit of units) {
        await assertWorkerRuns(unit, control, events);
      }
      console.log("native APT: missing lock file permits periodic work");
    }
    await rm(join(fixture.root, "cache"), { recursive: true });
    for (const unit of units) {
      await assertWorkerRuns(unit, control, events);
    }
    console.log("native APT: missing lock directory permits periodic work through the generated condition");
  } finally {
    for (const unit of units) {
      try {
        await control("stop", unit);
        await control("reset-failed", unit);
      } catch (error) {
        console.warn("APT fixture cleanup:", error);
      }
      await rm(`/run/systemd/system/${unit}`, { force: true });
      await rm(`/run/systemd/system/${unit}.d`, { recursive: true, force: true });
    }
    await control("stop", target);
    await rm(`/run/systemd/system/${target}`, { force: true });
    await control("daemon-reload");
  }
}

async function checkLockLifetime(
  fixture: AptFixture,
  units: string[],
  outcome: "success" | "failure" | "hangup",
  control: (...arguments_: string[]) => Promise<void>,
  events: string
): Promise<void> {
  const owner = { ...fixture, script: join(fixture.root, `owner-${outcome}.sh`) };
  const lock = /    exec 9>>[^\n]+\n    flock -xn 9[^\n]+/.exec(fixture.source);
  assert(lock, "Run the installer's real descriptor acquisition");
  await writeAptProgram(owner, `${lock[0]}\nprintf 'LOCK-READY\\n'\nread action\n[ "$action" != fail ]`);
  const child = spawn(
    "python3",
    [fileURLToPath(new URL("./pty-driver.py", import.meta.url)), "/bin/sh", owner.script],
    {
      env: owner.environment,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }
  );
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  try {
    await waitFor(async () => output.includes("LOCK-READY"), "fixture lock owner ready");
    for (const unit of units) {
      const before = await readFile(events, "utf8");
      await control("start", unit);
      const shown = (await execute("systemctl", ["show", unit, "--property=Result", "--property=ExecCondition"]))
        .stdout;
      assert.match(shown, /Result=exec-condition/);
      assert.match(shown, /status=1(?:[ ;}])/);
      assert.equal(await readFile(events, "utf8"), before);
    }
    if (outcome === "hangup") {
      assert(child.kill("SIGKILL"), "Closing the PTY master must hang up its shell");
    } else {
      child.stdin.write(outcome === "failure" ? "fail\n" : "ok\n");
    }
    const code = await closed;
    if (outcome !== "hangup") {
      assert.equal(code, outcome === "failure" ? 1 : 0, output);
    }
    await waitFor(async () => {
      try {
        await execute("flock", ["--nonblock", join(fixture.root, "cache/install.lock"), "/bin/true"]);
        return true;
      } catch (error) {
        assert(error instanceof Error && "code" in error && error.code === 1, String(error));
        return false;
      }
    }, "installer descriptor released");
    for (const unit of units) {
      await assertWorkerRuns(unit, control, events);
    }
    console.log(`native APT: actual condition skips while held; ${outcome} releases the lock and permits workers`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}

async function checkNativeDrain(
  fixture: AptFixture,
  unit: string,
  root: string,
  control: (...arguments_: string[]) => Promise<void>,
  events: string
): Promise<void> {
  await writeFile(join(root, "wait"), "");
  await control("start", "--no-block", unit);
  await waitFor(
    async () => (await execute("systemctl", ["show", unit, "--property=MainPID", "--value"])).stdout.trim() !== "0",
    "pre-admitted worker"
  );
  await rm(join(fixture.commands, "systemctl"));
  await symlink("/usr/bin/systemctl", join(fixture.commands, "systemctl"));
  const drain = { ...fixture, script: join(fixture.root, "drain.sh") };
  const lock = /    exec 9>>[^\n]+\n    flock -xn 9[^\n]+/.exec(fixture.source);
  assert(lock);
  await writeAptProgram(drain, `${lock[0]}\ndrain_periodic_apt\nprintf 'ACTIVATED\\n' >> ${quote(events)}`);
  const drainCompletion = execute("/bin/sh", [drain.script], { env: drain.environment });
  try {
    await delay(150);
    assert(!(await readFile(events, "utf8")).includes("ACTIVATED"));
    await access(join(root, "wait"));
    await writeFile(join(root, "release"), "");
    const result = await drainCompletion;
    assert.match(result.stdout, /Waiting for scheduled package jobs/);
    const output = await readFile(events, "utf8");
    assert(output.lastIndexOf("FINISHED") < output.lastIndexOf("ACTIVATED"));
    await rm(join(root, "wait"));
    console.log("native APT: pre-admitted systemd worker finished naturally before activation");
  } finally {
    await writeFile(join(root, "release"), "");
    await drainCompletion;
  }
}

async function checkCharging(
  root: string,
  unit: string,
  control: (...arguments_: string[]) => Promise<void>,
  events: string
): Promise<void> {
  const source = await readFile(join(REPOSITORY, "src/install/security.ts"), "utf8");
  const literal = /"\[Service\]\\nExecCondition=[^"]+"/.exec(source);
  assert(literal, "Use the real charging condition definition");
  const contents: unknown = JSON.parse(literal[0]);
  assert.equal(typeof contents, "string");
  const check = join(root, "charging.sh");
  await writeFile(check, `#!/bin/sh\nprintf 'POWER_CHECK\\n' >> ${quote(events)}\nexit 1\n`, { mode: 0o755 });
  const path = `/run/systemd/system/${unit}.d/50-cool-eva-power.conf`;
  await writeFile(path, (contents as string).replace("/usr/local/libexec/cool-eva-os-update-ready", check));
  try {
    await control("daemon-reload");
    const before = await readFile(events, "utf8");
    await control("start", unit);
    assert.equal(await readFile(events, "utf8"), before + "POWER_CHECK\n");
    assert.match((await execute("systemctl", ["show", unit, "--property=Result"])).stdout, /exec-condition/);
    console.log("native APT: the existing 50 charging condition still refuses after the installer lock is free");
  } finally {
    await rm(path);
    await control("daemon-reload");
  }
}

async function assertWorkerRuns(
  unit: string,
  control: (...arguments_: string[]) => Promise<void>,
  events: string
): Promise<void> {
  const before = await readFile(events, "utf8");
  await control("start", unit);
  assert.equal(await readFile(events, "utf8"), before + "WORKER\nFINISHED\n", unit);
  assert.match((await execute("systemctl", ["show", unit, "--property=Result"])).stdout, /Result=success/);
}

async function waitFor(condition: () => Promise<boolean>, description: string): Promise<void> {
  const started = monotonicNow();
  while (!(await condition())) {
    assert(since(started) < 5_000, description);
    await delay(25);
  }
}

const execute = promisify(execFile);
