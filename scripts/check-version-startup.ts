import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../src/monotonic.ts";
import type { RunningVersion } from "../src/version.ts";

export async function checkVersionStartup(): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), ".preview-shots/version-startup-"));
  const savedEnvironment = { PATH: process.env.PATH, VERSION_STARTUP_FIXTURE: process.env.VERSION_STARTUP_FIXTURE };
  try {
    for (const outcome of [0, 1, 2, "priority-failure"] as const) {
      await checkOutcome(join(directory, String(outcome)), outcome);
    }
    const entrypoint = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(
      entrypoint,
      /server\.listen\(PORT, "0\.0\.0\.0", \(\) => \{[^}]*?\$\{PORT\}[^;]*;\s*beginRunningVersionChecks\(\);/,
      "Background verification must start inside the HTTP listening callback"
    );
    console.log(
      "version startup: pending identity, nonblocking HTTP during hash/OS checks, priorities and honest labels passed"
    );
  } finally {
    for (const name of ["PATH", "VERSION_STARTUP_FIXTURE"] as const) {
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

type InventoryOutcome = 0 | 1 | 2 | "priority-failure";
type VersionModule = typeof import("../src/version.ts");

async function checkOutcome(directory: string, outcome: InventoryOutcome): Promise<void> {
  const commands = join(directory, "bin");
  const updaterDirectory = join(directory, "updater");
  await mkdir(commands, { recursive: true });
  await mkdir(updaterDirectory);
  const commit = "a".repeat(40);
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({
      format: 1,
      updaterProtocol: 1,
      platform: "linux-arm64",
      release: `main-${commit}`,
      commit,
      channel: "main",
      branch: "main",
      settingsSchemaVersion: 1,
    })
  );
  await writeFile(
    join(updaterDirectory, "state.json"),
    JSON.stringify({ osPackages: { [basename(directory)]: "bluez\t1\n" } })
  );
  await writeFile(join(directory, "commands"), "");
  for (const name of ["nice", "ionice", "sha256sum", "dpkg-query"]) {
    await writeFile(join(commands, name), commandFixture(name, outcome), { mode: 0o755 });
  }
  process.env.PATH = `${commands}:/usr/bin:/bin`;
  process.env.VERSION_STARTUP_FIXTURE = directory;
  const reporter: VersionModule = await import(`../src/version.ts?startup=${encodeURIComponent(directory)}`);
  const completedInventories: string[] = [];
  const savedLog = console.log;
  console.log = (...arguments_: unknown[]) => {
    const message = arguments_[0];
    if (typeof message === "string" && message.startsWith("version: release inventory check completed:")) {
      completedInventories.push(message);
    }
    savedLog(...arguments_);
  };
  let server: Server | null = null;
  try {
    const initial = await bounded(reporter.readRunningVersion(directory, updaterDirectory));
    assert.equal(initial.label, "main@aaaaaaa+unverified");
    assert.equal(initial.trustworthy, false, "An unchecked bundle must never be reported clean");
    assert.equal(await readFile(join(directory, "commands"), "utf8"), "", "Identity must not launch diagnostics");
    server = createServer((_request, response) => {
      void reporter.readRunningVersion(directory, updaterDirectory).then(
        version => response.end(JSON.stringify(version)),
        error => {
          console.error("version fixture HTTP failed:", error);
          response.writeHead(500).end();
        }
      );
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    reporter.beginRunningVersionChecks();
    reporter.beginRunningVersionChecks();
    if (outcome !== "priority-failure") {
      await waitUntil(async () => (await readFile(join(directory, "commands"), "utf8")).includes("sha256sum started"));
      const pendingHash = await requestVersion(url);
      assert.equal(pendingHash.label, "main@aaaaaaa+unverified", "A pending hash must not block HTTP or claim clean");
      await waitUntil(async () => (await readFile(join(directory, "commands"), "utf8")).includes("dpkg-query started"));
    }
    await writeFile(join(directory, "hash-ready"), "");
    await waitUntil(async () => completedInventories.length === 1);
    const suffix = outcome === 0 ? "" : outcome === 1 ? "+edited" : "+unverified";
    await waitUntil(async () => {
      const version = await requestVersion(url);
      const commands = await readFile(join(directory, "commands"), "utf8");
      return version.label === `main@aaaaaaa${suffix}` && commands.includes("ionice");
    });
    if (outcome !== "priority-failure") {
      const beforeOs = await requestVersion(url);
      assert.equal(beforeOs.label, `main@aaaaaaa${suffix}`, "A pending OS comparison must not block HTTP");
      assert.equal(beforeOs.dirty, outcome === 1);
      assert.equal(beforeOs.trustworthy, outcome !== 2);
      await writeFile(join(directory, "packages-ready"), "");
      await waitUntil(async () =>
        (await requestVersion(url)).label.endsWith("OS updated since this release was tested")
      );
      const commands = await readFile(join(directory, "commands"), "utf8");
      assert.equal(commands.split("sha256sum started").length - 1, 1, "Repeated reads/start calls must not rehash");
      assert.equal(commands.split("dpkg-query started").length - 1, 1, "Pending notice refreshes must coalesce");
    } else {
      const version = await requestVersion(url);
      assert.equal(version.trustworthy, false, "A priority setup failure must remain unverified, never edited");
      assert.equal(version.dirty, false);
    }
  } finally {
    await writeFile(join(directory, "hash-ready"), "");
    await writeFile(join(directory, "packages-ready"), "");
    if (server !== null) {
      await new Promise<void>((resolve, reject) => server!.close(error => (error ? reject(error) : resolve())));
    }
    await delay(30);
    console.log = savedLog;
  }
}

function commandFixture(name: string, outcome: InventoryOutcome): string {
  const header = `#!/bin/sh\nset -eu\nprintf '%s\\n' '${name}' >> "$VERSION_STARTUP_FIXTURE/commands"\n`;
  if (name === "nice") {
    return header + 'test "$1" = -n\ntest "$2" = 19\nshift 2\nexec "$@"\n';
  }
  if (name === "ionice") {
    return (
      header +
      'test "$1" = -c\ntest "$2" = 3\ntest "$3" = -p\n' +
      (outcome === "priority-failure" ? "exit 1\n" : "exit 0\n")
    );
  }
  const marker = name === "sha256sum" ? "hash-ready" : "packages-ready";
  const argumentCheck = name === "sha256sum" ? 'test "$*" = "--check --strict --quiet files.sha256"\n' : "";
  return (
    header +
    argumentCheck +
    `printf '%s\\n' '${name} started' >> "$VERSION_STARTUP_FIXTURE/commands"
attempt=0
while [ ! -e "$VERSION_STARTUP_FIXTURE/${marker}" ]; do
  attempt=$((attempt+1))
  test "$attempt" -lt 500 || exit 70
  sleep 0.01
done
` +
    (name === "sha256sum" ? `exit ${outcome}\n` : "printf 'bluez\\t2\\n'\n")
  );
}

async function requestVersion(url: string): Promise<RunningVersion> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  assert.equal(response.status, 200);
  return (await response.json()) as RunningVersion;
}

async function bounded<Value>(pending: Promise<Value>): Promise<Value> {
  const timeout = delay(1_000, undefined, { ref: false }).then(() => {
    throw new Error("Identity read waited for diagnostics");
  });
  return Promise.race([pending, timeout]);
}

async function waitUntil(ready: () => Promise<boolean>): Promise<void> {
  const started = monotonicNow();
  while (!(await ready())) {
    assert(since(started) < 2_000, "Version diagnostics did not reach the expected state");
    await delay(10);
  }
}

await checkVersionStartup();
