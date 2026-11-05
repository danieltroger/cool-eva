import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readState, type UpdateFixture } from "./fixture.ts";

export async function checkRequestedStop(options: RequestedStopOptions): Promise<void> {
  const { fixture, service, rollbackService, appUrl, control, waitFor, healthy } = options;
  await control("reset-failed", service);
  await fetch(`${appUrl}/test/crash-once`);
  await waitFor(
    async () => (await serviceProperty(service, "NRestarts")) === "1" && (await healthy()),
    15_000,
    "one automatic restart before a failing manual stop"
  );
  assert.equal(await serviceProperty(service, "NRestarts"), "1");
  const before = await readState(fixture);
  assert.notEqual(before.previous, null, "The regression must have a live rollback target");
  await fetch(`${appUrl}/test/fail-stop`);
  await control("stop", service);
  // Wait for an already queued handler too, then outlast RestartSec=5. An
  // instantaneous inactive check can miss the unwanted asynchronous restart.
  await control("start", rollbackService);
  await delay(6_000);
  assert.equal(await serviceProperty(service, "ActiveState"), "inactive", "A requested stop must stay stopped");
  assert.equal(await serviceProperty(service, "Result"), "success");
  assert.equal(await serviceProperty(service, "ExecMainStatus"), "0");
  const after = await readState(fixture);
  assert.equal(after.current, before.current);
  assert.equal(after.previous, before.previous);
  assert.deepEqual(after.rejected, before.rejected);
  assert.equal(after.pending, null);
  const journal = await execFileAsync("journalctl", ["-u", service, "--no-pager", "-n", "80"]);
  assert.match(journal.stdout, /synthetic app attempts exit 1 on SIGTERM/);
  assert.match(journal.stdout, /requested stop overrides exit status 1/);
  console.log(journal.stdout);
  console.log(
    "real systemd: NRestarts=1 then exit 1 on SIGTERM stayed stopped, with current/previous/rejected unchanged"
  );
  await control("start", service);
  await waitFor(healthy, 15_000, "app after failing manual stop");
}

interface RequestedStopOptions {
  fixture: UpdateFixture;
  service: string;
  rollbackService: string;
  appUrl: string;
  control: (...arguments_: string[]) => Promise<void>;
  waitFor: (condition: () => Promise<boolean>, timeout: number, description: string) => Promise<void>;
  healthy: () => Promise<boolean>;
}

const execFileAsync = promisify(execFile);

async function serviceProperty(service: string, name: string): Promise<string> {
  return (await execFileAsync("systemctl", ["show", service, `--property=${name}`, "--value"])).stdout.trim();
}
