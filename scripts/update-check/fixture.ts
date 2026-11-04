import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { settingsPaths } from "../../src/settings/paths.ts";
import { freshSettings } from "../../src/settings/schema.ts";
import { createReleaseMetadata, renderReleaseManifest } from "../release/manifest.ts";
import { hashFile, writeFileInventory } from "../release/files.ts";
import { readBundleInputs } from "../release/inputs.ts";

export async function createUpdateFixture(parent: string): Promise<UpdateFixture> {
  const root = await mkdtemp(join(parent, "update-"));
  const fixture: UpdateFixture = {
    root,
    code: join(root, "code"),
    data: join(root, "data"),
    settings: join(root, "data/state/settings.json"),
    state: join(root, "data/updater/state.json"),
    configuration: join(root, "configuration.json"),
    helpers: join(root, "helpers"),
    commandDirectory: join(root, "commands"),
  };
  for (const directory of [
    "code/releases",
    "data/state",
    "data/updater",
    "commands",
    "run",
    "assets/cool-eva-channels",
  ]) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  }
  for (const directory of ["ride-logs", "vcu-params", "wifi-diag", "captures"]) {
    await mkdir(join(fixture.data, directory));
  }
  await cp(join(REPOSITORY, "scripts/update"), fixture.helpers, { recursive: true });
  await writeFile(fixture.settings, JSON.stringify(freshSettings(settingsPaths(fixture.data))), { mode: 0o600 });
  await writeFile(
    join(fixture.data, "state/installed.json"),
    JSON.stringify({ installed: true, archiveGroupId: process.getgid?.() ?? 0 }),
    { mode: 0o600 }
  );
  await writeFile(
    fixture.configuration,
    JSON.stringify({
      format: 1,
      releaseRoot: fixture.code,
      dataRoot: fixture.data,
      settingsLock: join(root, "run/settings.lock"),
      service: "synthetic-cool-eva.service",
      channel: "main",
      healthUrl: "http://127.0.0.1/release-health",
    }),
    { mode: 0o600 }
  );
  await writeFile(join(root, "Result.txt"), "start-limit-hit");
  await writeFile(join(root, "SubState.txt"), "failed");
  await writeFile(join(root, "SystemState.txt"), "running");
  await writeFile(join(root, "os-packages.txt"), "bluez\t1\nsystemd\t1\n");
  await writeFile(join(root, "NRestarts.txt"), "3");
  await writeFile(join(root, "clock.txt"), "10");
  await writeFile(join(root, "commands.txt"), "");
  for (const command of [
    "id",
    "stat",
    "mv",
    "systemctl",
    "dpkg-query",
    "curl",
    "cut",
    "sleep",
    "sync",
    ...(process.platform === "linux" ? [] : ["realpath", "readlink", "sha256sum", "flock"]),
  ]) {
    await writeFile(join(fixture.commandDirectory, command), commandWrapper(command), { mode: 0o755 });
  }
  await createFixtureRelease(fixture, "old", "a".repeat(40));
  await symlink("releases/old", join(fixture.code, "current"));
  await invokeUpdater(fixture, "initialise");
  return fixture;
}

export interface UpdateFixture {
  root: string;
  code: string;
  data: string;
  settings: string;
  state: string;
  configuration: string;
  helpers: string;
  commandDirectory: string;
}

export const REPOSITORY = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const execFileAsync = promisify(execFile);

export function commandWrapper(command: string): string {
  const trace = `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$UPDATE_FIXTURE/commands.txt"\n`;
  if (command === "id") return trace + "printf '0\\n'\n";
  if (command === "dpkg-query") return trace + 'cat "$UPDATE_FIXTURE/os-packages.txt"\n';
  if (command === "mv" && process.platform === "linux") return trace + 'exec /usr/bin/mv "$@"\n';
  if (["sleep", "sync", "flock"].includes(command)) return trace + "exit 0\n";
  if (command === "stat")
    return (
      trace +
      `for argument do last=$argument; done\nexec /usr/bin/stat ${process.platform === "linux" ? "-c '0:%a'" : "-f '0:%Lp'"} "$last"\n`
    );
  if (command === "cut")
    return (
      trace +
      'seconds=$(cat "$UPDATE_FIXTURE/clock.txt")\nseconds=$((seconds+30))\nprintf "%s" "$seconds" > "$UPDATE_FIXTURE/clock.txt"\nprintf "%s\\n" "$seconds"\n'
    );
  if (command === "systemctl")
    return (
      trace +
      'if [ "$1" = is-system-running ]; then state=$(cat "$UPDATE_FIXTURE/SystemState.txt"); printf "%s\\n" "$state"; [ "$state" = running ]; exit; fi\n' +
      'if [ "$1" = reset-failed ]; then\n' +
      'if [ -e "$UPDATE_FIXTURE/reset-unloaded" ]; then printf "Unit %s not loaded.\\n" "$2" >&2; exit 1; fi\n' +
      'if [ -e "$UPDATE_FIXTURE/reset-denied" ]; then printf "Access denied\\n" >&2; exit 1; fi\nfi\n' +
      'if [ "$1" = show ]; then\nfor argument do\ncase "$argument" in --property=*) property=${argument#--property=}; cat "$UPDATE_FIXTURE/$property.txt"; printf "\\n" ;; esac\ndone\nfi\n'
    );
  return `#!/bin/sh\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(join(REPOSITORY, "scripts/update-check/command.ts"))} ${quote(command)} "$@"\n`;
}

export function fixtureEnvironment(fixture: UpdateFixture): NodeJS.ProcessEnv {
  return { ...process.env, UPDATE_FIXTURE: fixture.root, PATH: `${fixture.commandDirectory}:${process.env.PATH}` };
}

export async function invokeUpdater(fixture: UpdateFixture, action: string, tag?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "sh",
    [join(fixture.helpers, "run.sh"), action, "--config", fixture.configuration, ...(tag ? [tag] : [])],
    {
      env: fixtureEnvironment(fixture),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
  return stdout;
}

export async function createFixtureRelease(
  fixture: UpdateFixture,
  name: string,
  commit: string,
  schemas = [1]
): Promise<string> {
  const directory = join(fixture.code, "releases", name);
  await mkdir(join(directory, "runtime/bin"), { recursive: true });
  await mkdir(join(directory, "src/release"), { recursive: true });
  await cp(join(REPOSITORY, "scripts/update"), join(directory, "scripts/update"), { recursive: true });
  const metadata = createReleaseMetadata(await readBundleInputs(REPOSITORY), {
    commit,
    channel: "main",
    branch: "main",
    epoch: "1793736000",
  });
  await writeFile(join(directory, "release.json"), JSON.stringify({ ...metadata, readableSchemas: schemas }));
  await writeFile(join(directory, "runtime/bin/node"), commandWrapper("fixture-node"), { mode: 0o755 });
  await writeFile(join(directory, "src/release/preflight.ts"), "// synthetic release reader\n");
  await writeFile(join(directory, "src/index.ts"), "// synthetic release app\n");
  await writeFile(join(directory, "tested-os-packages.txt"), "ii  bluez 1 arm64\n");
  await writeFileInventory(directory);
  return metadata.release;
}

export async function publishFixtureRelease(fixture: UpdateFixture, name: string, commit: string): Promise<string> {
  const release = await createFixtureRelease(fixture, name, commit);
  const tag = `cool-eva-${release}`;
  const assetDirectory = join(fixture.root, "assets", tag);
  await mkdir(assetDirectory);
  await copyFile(join(fixture.code, "releases", name, "release.json"), join(assetDirectory, "release.json"));
  await repackFixtureRelease(fixture, name, tag);
  await writeFile(join(fixture.root, "assets/cool-eva-channels/main.txt"), `${tag}\n`);
  await writeFile(join(fixture.root, "health.txt"), JSON.stringify({ ok: true, release }));
  return tag;
}

export async function repackFixtureRelease(fixture: UpdateFixture, name: string, tag: string): Promise<void> {
  const directory = join(fixture.code, "releases", name);
  const assetDirectory = join(fixture.root, "assets", tag);
  const archive = join(assetDirectory, "bundle.tar.zst");
  await execFileAsync("tar", ["--zstd", "-cf", archive, "-C", directory, "."]);
  await updateFixtureManifest(fixture, tag);
}

export async function updateFixtureManifest(fixture: UpdateFixture, tag: string): Promise<void> {
  const assetDirectory = join(fixture.root, "assets", tag);
  const archive = join(assetDirectory, "bundle.tar.zst");
  const metadata = JSON.parse(await readFile(join(assetDirectory, "release.json"), "utf8"));
  const { size } = await stat(archive);
  await writeFile(join(assetDirectory, "manifest.txt"), renderReleaseManifest(metadata, await hashFile(archive), size));
}

export async function readState(fixture: UpdateFixture): Promise<FixtureState> {
  return JSON.parse(await readFile(fixture.state, "utf8"));
}

export interface FixtureState {
  format: number;
  current: string;
  previous: string | null;
  snapshot: string | null;
  osPackages?: Record<string, string>;
  pending: null | {
    target: string;
    rollback: string;
    snapshot: string;
    phase: string;
    policy?: string;
    reason?: string;
    reject?: boolean;
  };
  rejected: string[];
  lastRollback: null | { from: string; reason: string; settingsRestored: boolean };
}

export async function saveState(fixture: UpdateFixture, state: FixtureState): Promise<void> {
  await writeFile(fixture.state, JSON.stringify(state), { mode: 0o600 });
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
