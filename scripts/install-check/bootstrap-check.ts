import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { commandWrapper } from "../update-check/fixture.ts";
import { createReleaseMetadata, renderReleaseManifest } from "../release/manifest.ts";
import { readBundleInputs } from "../release/inputs.ts";
import { renderInstaller } from "../release/installer.ts";
import { hashFile, writeFileInventory } from "../release/files.ts";
import { runInTerminal } from "./terminal.ts";

export async function checkBootstrap(directory: string, repository: string, only?: string): Promise<void> {
  let selected = 0;
  for (const variant of [
    "valid",
    "rerun",
    "bad-sha",
    "linked-file",
    "wrong-identity",
    "wrong-architecture",
    "pending-update",
    "cancel",
    "apt-failure",
    "activating",
    "failed",
    "inactive-no-job",
    "inactive-pending-job",
  ] as const) {
    if (only && only !== variant) {
      continue;
    }
    selected++;
    const root = join(directory, variant);
    const payload = join(root, "payload");
    const metadata = createReleaseMetadata(await readBundleInputs(repository), {
      commit: "a".repeat(40),
      channel: "main",
      branch: "main",
      epoch: "1793736000",
    });
    const tag = `cool-eva-${metadata.release}`;
    const assets = join(root, "assets", tag);
    const commands = join(root, "commands");
    for (const path of [
      assets,
      commands,
      join(payload, "runtime/bin"),
      join(payload, "src/release"),
      join(payload, "src/install"),
    ]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(root, "commands.txt"), "");
    for (const command of ["id", "stat", "mv", "curl", "realpath", "sha256sum", "flock", "sync", "cut", "sleep"]) {
      await writeFile(join(commands, command), commandWrapper(command), { mode: 0o755 });
    }
    for (const command of ["apt-get", "apt-mark", "journalctl", "git", "npm"]) {
      await writeFile(
        join(commands, command),
        `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$UPDATE_FIXTURE/commands.txt"\n${["git", "npm"].includes(command) ? "exit 99" : command === "apt-get" && variant === "apt-failure" ? "exit 42" : "exit 0"}\n`,
        { mode: 0o755 }
      );
    }
    await writeFile(
      join(root, "os-state"),
      variant === "activating" ? "activating" : variant === "failed" ? "failed" : "inactive"
    );
    await writeFile(join(root, "starts"), variant === "activating" ? "1" : "0");
    await writeFile(join(root, "clock.txt"), "100");
    await writeFile(join(root, "shows"), "0");
    await writeFile(join(root, "sleeps"), "0");
    await writeFile(
      join(commands, "sleep"),
      `#!/bin/sh
count=$(cat "$UPDATE_FIXTURE/sleeps"); count=$((count+1)); echo "$count" > "$UPDATE_FIXTURE/sleeps"
if [ "$count" -gt 10 ]; then echo 'Fixture wait budget exhausted' >&2; exit 89; fi
`,
      { mode: 0o755 }
    );
    await writeFile(
      join(commands, "systemctl"),
      `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$UPDATE_FIXTURE/commands.txt"
case "$1" in
  reset-failed)
    if [ "$(cat "$UPDATE_FIXTURE/os-state")" != failed ]; then echo 'Unit not loaded' >&2; exit 1; fi
    echo inactive > "$UPDATE_FIXTURE/os-state"
    ;;
  show)
    shows=$(cat "$UPDATE_FIXTURE/shows"); shows=$((shows+1)); echo "$shows" > "$UPDATE_FIXTURE/shows"
    if [ '${variant}' = activating ] && [ "$shows" -ge 4 ]; then echo active > "$UPDATE_FIXTURE/os-state"; fi
    cat "$UPDATE_FIXTURE/os-state"
    ;;
  list-jobs)
    if [ '${variant}' = inactive-pending-job ]; then
      echo '42 cool-eva-install-os.service start waiting'
      echo active > "$UPDATE_FIXTURE/os-state"
    else
      echo '43 unrelated.service start running'
    fi
    ;;
  start)
    starts=$(cat "$UPDATE_FIXTURE/starts"); echo "$((starts+1))" > "$UPDATE_FIXTURE/starts"
    case '${variant}' in
      inactive-no-job|inactive-pending-job) exit 0 ;;
    esac
    if /bin/sh "$UPDATE_FIXTURE/cache/os-catch-up.sh"; then echo active; else echo failed; fi > "$UPDATE_FIXTURE/os-state"
    ;;
  stop) echo inactive > "$UPDATE_FIXTURE/os-state" ;;

esac
`,
      { mode: 0o755 }
    );
    await writeFile(
      join(commands, "dpkg"),
      `#!/bin/sh\nprintf 'dpkg %s\\n' "$*" >> "$UPDATE_FIXTURE/commands.txt"\nif [ "$1" = --print-architecture ]; then echo ${variant === "wrong-architecture" ? "armhf" : "arm64"}; fi\n`,
      { mode: 0o755 }
    );
    await writeFile(join(commands, "uname"), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo aarch64; fi\n', {
      mode: 0o755,
    });
    await writeFile(
      join(payload, "runtime/bin/node"),
      `#!/bin/sh
printf 'node %s\\n' "$*" >> "$UPDATE_FIXTURE/commands.txt"
if [ -f "$UPDATE_FIXTURE/data/updater/state.json" ]; then
    sh -n "$UPDATE_FIXTURE/code/updater/current/run.sh"
    sh "$UPDATE_FIXTURE/code/updater/current/run.sh" self-test || exit 95
fi
echo BOOTSTRAP_NODE
`,
      { mode: 0o755 }
    );
    await writeFile(join(payload, "release.json"), JSON.stringify(metadata));
    await writeFile(join(payload, "src/release/preflight.ts"), "// synthetic native loader\n");
    await writeFile(join(payload, "src/install/main.ts"), "// synthetic installer entry\n");
    if (variant === "linked-file") {
      await symlink("release.json", join(payload, "linked.json"));
    }
    await cp(join(repository, "scripts/update"), join(payload, "scripts/update"), { recursive: true });
    await writeFileInventory(payload);
    const archive = join(assets, "bundle.tar.zst");
    await promisify(execFile)("tar", ["--zstd", "-cf", archive, "-C", payload, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const checksum = variant === "bad-sha" ? "0".repeat(64) : await hashFile(archive);
    let manifest = renderReleaseManifest(metadata, checksum, (await stat(archive)).size);
    if (variant === "wrong-identity") {
      manifest = manifest.replace(`release=${metadata.release}`, `release=main-${"b".repeat(40)}`);
    }
    await writeFile(join(assets, "manifest.txt"), manifest);
    if (variant === "pending-update" || variant === "rerun") {
      const target = join(root, "code/releases", metadata.release);
      await mkdir(join(root, "code/releases"), { recursive: true });
      await cp(payload, target, { recursive: true });
      await symlink(target, join(root, "code/current"));
      await mkdir(join(root, "data/updater"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, "data/updater/state.json"),
        JSON.stringify({
          format: 1,
          previous: null,
          rejected: [],
          current: metadata.release,
          pending: variant === "pending-update" ? { target: "synthetic-trial" } : null,
        })
      );
      await chmod(join(root, "data/updater/state.json"), 0o600);
    }
    let installer = renderInstaller(await readFile(join(repository, "install.sh"), "utf8"), metadata);
    for (const [source, destination] of [
      ["/var/cache/cool-eva-install", join(root, "cache")],
      ["/opt/cool-eva", join(root, "code")],
      ["/var/lib/cool-eva", join(root, "data")],
      ["/etc/systemd/system", join(root, "systemd")],
    ]) {
      installer = installer.replaceAll(source, destination);
    }
    const script = join(root, "install.sh");
    await writeFile(script, installer);
    const result = await runInTerminal(
      "/bin/sh",
      [script],
      [["Type BENCH to confirm stable bench power: ", variant === "cancel" ? "NO\n" : "BENCH\n"]],
      { ...process.env, UPDATE_FIXTURE: root, PATH: `${commands}:${process.env.PATH}` }
    );
    const calls = await readFile(join(root, "commands.txt"), "utf8");
    const nodeCalls = calls.split("\n").filter(line => line.startsWith("node "));
    if (
      variant === "valid" ||
      variant === "rerun" ||
      variant === "activating" ||
      variant === "failed" ||
      variant === "inactive-pending-job"
    ) {
      assert.equal(result.code, 0, result.output);
      assert.equal(nodeCalls.length, variant === "rerun" ? 1 : 2);
      for (const call of nodeCalls) {
        assert(call.startsWith("node --no-wasm-lazy-compilation --experimental-strip-types "));
      }
      const startCalls = calls
        .split("\n")
        .filter(line => line === "systemctl start --no-block cool-eva-install-os.service");
      const resetIndex = calls.indexOf("systemctl reset-failed cool-eva-install-os.service");
      assert.equal(
        (await readFile(join(root, "starts"), "utf8")).trim(),
        "1",
        "Exactly one job starts across original/attached setup"
      );
      assert.equal(startCalls.length, variant === "activating" ? 0 : 1);
      if (variant === "failed") {
        assert(resetIndex >= 0 && resetIndex < calls.indexOf(startCalls[0]));
      } else {
        assert.equal(resetIndex, -1);
      }
      if (variant !== "activating" && variant !== "inactive-pending-job") {
        assert(calls.includes("apt-mark manual jq"));
        assert(calls.indexOf("apt-mark manual jq") < calls.indexOf("src/install/main.ts"));
        const packageCalls = calls
          .split("\n")
          .filter(
            line =>
              line.startsWith("apt-get ") || (line.startsWith("dpkg ") && !line.startsWith("dpkg --print-architecture"))
          );
        assert.equal(packageCalls.length, 5);
        for (const call of packageCalls) {
          const prefix = call.startsWith("apt-get ") ? "-o Dpkg::Options::=" : "";
          assert(call.includes(prefix + "--force-confold"), call);
          assert(call.includes(prefix + "--force-confdef"), call);
        }
      }
      if (variant === "inactive-pending-job") {
        assert(calls.includes("systemctl list-jobs --no-legend --no-pager"));
      }
      const unit = await readFile(join(root, "systemd/cool-eva-install-os.service"), "utf8");
      assert(unit.includes("Type=oneshot\nRemainAfterExit=yes\n"));
      assert(unit.includes(`ExecStart=/bin/sh ${root}/cache/os-catch-up.sh`));
      if (variant === "valid") {
        assert(calls.indexOf("src/release/preflight.ts native") < calls.indexOf("src/install/main.ts"));
      }
      assert(!/\bgit\b|\bnpm\b/.test(calls));
    } else {
      assert.notEqual(result.code, 0, `${variant}: ${result.output}`);
      assert.equal(nodeCalls.length, 0, `${variant} reached executable payload`);
      const reason = {
        "bad-sha": /Bundle checksum failed/,
        "linked-file": /link or special file/,
        "wrong-identity": /identities differ/,
        "wrong-architecture": /64-bit userspace/,
        "pending-update": /release changed while setup was starting/,
        cancel: /cancelled before any system change/,
        "inactive-no-job": /OS catch-up did not start[\s\S]*paste the same setup line/i,
        "apt-failure": /setup stopped: OS catch-up failed[\s\S]*paste the same setup line/i,
      }[
        variant as
          | "bad-sha"
          | "linked-file"
          | "wrong-identity"
          | "wrong-architecture"
          | "pending-update"
          | "cancel"
          | "apt-failure"
          | "inactive-no-job"
      ];
      assert.match(result.output, reason);
      if (variant === "cancel") {
        assert(!calls.includes("apt-get"));
      }
    }
  }
  assert(selected > 0, "Unknown bootstrap fixture selection");
}
