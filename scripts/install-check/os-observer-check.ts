import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { quote } from "../update-check/fixture.ts";
import { observeOsCatchUp } from "./os-observer.ts";
import type { GuestSsh, sshCommand } from "./ssh.ts";

export async function checkOsObservation(parent: string): Promise<void> {
  const guest: GuestSsh = { key: "unused", knownHosts: "unused", port: 0 };
  for (const variant of [
    "progress",
    "failed",
    "nonzero-active",
    "expiry",
    "query-timeout",
    "sleep-cap",
    "late-success",
  ]) {
    const directory = join(parent, "os-observer", variant);
    const commands = join(directory, "commands");
    await mkdir(commands, { recursive: true });
    for (const name of ["timeout", "systemctl", "sleep"]) {
      await writeFile(join(commands, name), fixtureCommand(name), { mode: 0o755 });
    }
    await writeFile(join(directory, "uptime"), "1000.00 0.00\n");
    for (const name of ["queries", "sleeps", "calls"]) {
      await writeFile(join(directory, name), "");
    }
    for (const name of ["query-count", "sleep-count"]) {
      await writeFile(join(directory, name), "0\n");
    }
    await writeFile(join(directory, "marker"), "fixture\n");
    let invocations = 0;
    const execute: typeof sshCommand = async (_guest, command, timeout) => {
      invocations++;
      assert.equal(timeout, 3_050_000, "SSH transport must allow the guest budget plus 50 seconds");
      const script = command
        .replace("sudo sh -eu", "sh -eu")
        .replaceAll("/proc/uptime", quote(join(directory, "uptime")))
        .replaceAll("/etc/cool-eva-qemu-fixture", quote(join(directory, "marker")));
      const result = await promisify(execFile)("sh", ["-c", script], {
        env: {
          ...process.env,
          PATH: `${commands}:${process.env.PATH}`,
          COOL_EVA_OBSERVER_FIXTURE: directory,
          COOL_EVA_OBSERVER_CASE: variant,
        },
        timeout: 10_000,
      });
      return result.stdout;
    };
    let failure: unknown;
    try {
      await observeOsCatchUp(guest, execute);
    } catch (error) {
      failure = error;
    }
    const elapsed = Number((await readFile(join(directory, "uptime"), "utf8")).split(" ")[0]) - 1000;
    const queries = await readTimings(directory, "queries");
    const sleeps = await readTimings(directory, "sleeps");
    assert.equal(invocations, 1, "Observation must not reconnect to resubmit the job");
    const recordedCalls = (await readFile(join(directory, "calls"), "utf8")).trim();
    const calls = recordedCalls ? recordedCalls.split("\n") : [];
    assert(
      calls.every(call => call === SHOW_ARGUMENTS),
      "Only read-only status queries are allowed"
    );
    if (variant === "progress" || variant === "query-timeout") {
      assert.equal(failure, undefined);
    }
    assert(queries.length > 0);
    assert(calls.length > 0);
    for (const [started, duration] of queries) {
      assert(duration > 0 && duration <= Math.min(5, 3000 - started), "Query exceeds remaining budget");
    }
    for (const [started, duration] of sleeps) {
      assert(duration > 0 && duration <= Math.min(2, 3000 - started), "Sleep exceeds remaining budget");
    }
    if (variant === "progress" || variant === "query-timeout") {
      assert(elapsed > 2450 && elapsed < 3000, "Success must remain observable past the old cutoff");
      assert(queries.some(([started]) => started >= 2460));
    } else {
      assert(failure instanceof Error, `${variant} must fail`);
      assert(!("killed" in failure && failure.killed), "A real-time fixture timeout is not a valid failure");
      assert("stderr" in failure && typeof failure.stderr === "string");
      // execFile's message includes the entire shell script, including both outcome strings.
      assert.match(
        failure.stderr,
        variant === "failed" || variant === "nonzero-active"
          ? /^OS catch-up failed/m
          : /^OS catch-up observation exceeded 3000s/m
      );
      if (variant === "failed" || variant === "nonzero-active") {
        assert.equal(elapsed, 1, "A terminal unit failure must fail before budget expiry");
        assert.equal(sleeps.length, 0);
      } else {
        assert.equal(elapsed, 3000, "Query and sleep time count against the same budget");
      }
    }
    if (variant === "expiry") {
      assert(queries.some(([, duration]) => duration === 1));
    }
    if (variant === "sleep-cap") {
      assert(sleeps.some(([, duration]) => duration === 1));
    }
    if (variant === "late-success") {
      assert(queries.some(([, duration]) => duration === 2));
    }
  }
  let invocations = 0;
  const timeout = Object.assign(new Error("fixture SSH observation timeout"), { code: 255, killed: true });
  await assert.rejects(
    observeOsCatchUp(guest, async () => {
      invocations++;
      throw timeout;
    }),
    error => error === timeout
  );
  assert.equal(invocations, 1, "A transport timeout must not resubmit or rerun the OS job");
  console.log(
    "OS observer: late progress, terminal failure, full monotonic budget, bounded queries/sleeps and no resubmission passed"
  );
}

async function readTimings(directory: string, name: string): Promise<number[][]> {
  const contents = (await readFile(join(directory, name), "utf8")).trim();
  return contents ? contents.split("\n").map(line => line.split(" ").map(Number)) : [];
}

function fixtureCommand(name: string): string {
  const prelude = `#!/bin/sh
set -eu
root=$COOL_EVA_OBSERVER_FIXTURE
read current idle < "$root/uptime"
current=\${current%%.*}
elapsed=$((current - 1000))
`;
  if (name === "timeout") {
    return (
      prelude +
      `[ "$1" = --signal=KILL ]
shift
printf '%s %s\\n' "$elapsed" "$1" >> "$root/queries"
export COOL_EVA_QUERY_SECONDS=$1
shift
exec "$@"
`
    );
  }
  if (name === "sleep") {
    return (
      prelude +
      `printf '%s %s\\n' "$elapsed" "$1" >> "$root/sleeps"
read count < "$root/sleep-count"
count=$((count + 1))
printf '%s\\n' "$count" > "$root/sleep-count"
next=$((current + $1))
case "$COOL_EVA_OBSERVER_CASE:$count" in
  progress:1|query-timeout:1) next=3460 ;;
  progress:2) next=3700 ;;
  expiry:1) next=3999 ;;
  sleep-cap:1) next=3997 ;;
  late-success:1) next=3998 ;;
  failed:*|nonzero-active:*) next=4000 ;;
esac
printf '%s.00 0.00\\n' "$next" > "$root/uptime"
`
    );
  }
  assert.equal(name, "systemctl");
  return (
    prelude +
    `printf '%s\\n' "$*" >> "$root/calls"
[ "$*" = '${SHOW_ARGUMENTS}' ] || exit 91
read count < "$root/query-count"
count=$((count + 1))
printf '%s\\n' "$count" > "$root/query-count"
duration=1
case "$COOL_EVA_OBSERVER_CASE:$count" in
  query-timeout:1) duration=$COOL_EVA_QUERY_SECONDS ;;
  expiry:2|sleep-cap:2|late-success:2) duration=2 ;;
esac
[ "$duration" -le "$COOL_EVA_QUERY_SECONDS" ] || duration=$COOL_EVA_QUERY_SECONDS
printf '%s.00 0.00\\n' "$((current + duration))" > "$root/uptime"
case "$COOL_EVA_OBSERVER_CASE:$count" in
  failed:*) printf 'ActiveState=failed\\nResult=exit-code\\nExecMainStatus=100\\n' ;;
  nonzero-active:*) printf 'ActiveState=active\\nResult=success\\nExecMainStatus=42\\n' ;;
  query-timeout:1) exit 124 ;;
  progress:3|query-timeout:2|late-success:2) printf 'ActiveState=active\\nResult=success\\nExecMainStatus=0\\n' ;;
  *) printf 'ActiveState=activating\\nResult=success\\nExecMainStatus=0\\n' ;;
esac
`
  );
}

const SHOW_ARGUMENTS =
  "show cool-eva-install-os.service --property=ActiveState --property=Result --property=ExecMainStatus";
