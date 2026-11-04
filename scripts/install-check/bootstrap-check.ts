import assert from "node:assert/strict";
import { cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { commandWrapper } from "../update-check/fixture.ts";
import { createReleaseMetadata, renderReleaseManifest } from "../release/manifest.ts";
import { readBundleInputs } from "../release/inputs.ts";
import { renderInstaller } from "../release/installer.ts";
import { hashFile, writeFileInventory } from "../release/files.ts";
import { runInTerminal } from "./terminal.ts";

export async function checkBootstrap(directory: string, repository: string): Promise<void> {
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
  ] as const) {
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
    for (const command of ["id", "mv", "curl", "realpath", "sha256sum", "flock", "sync"]) {
      await writeFile(join(commands, command), commandWrapper(command), { mode: 0o755 });
    }
    for (const command of ["apt-get", "apt-mark", "journalctl", "git", "npm"]) {
      await writeFile(
        join(commands, command),
        `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$UPDATE_FIXTURE/commands.txt"\n${["git", "npm"].includes(command) ? "exit 99" : command === "apt-get" && variant === "apt-failure" ? "exit 42" : "exit 0"}\n`,
        { mode: 0o755 }
      );
    }
    await writeFile(join(root, "os-state"), "inactive");
    await writeFile(
      join(commands, "systemctl"),
      `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$UPDATE_FIXTURE/commands.txt"
case "$1" in
  reset-failed)
    if [ "$(cat "$UPDATE_FIXTURE/os-state")" != failed ]; then echo 'Unit not loaded' >&2; exit 1; fi
    ;;
  show) cat "$UPDATE_FIXTURE/os-state" ;;
  start)
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
      '#!/bin/sh\nprintf \'node %s\\n\' "$*" >> "$UPDATE_FIXTURE/commands.txt"\necho BOOTSTRAP_NODE\n',
      { mode: 0o755 }
    );
    await writeFile(join(payload, "release.json"), JSON.stringify(metadata));
    await writeFile(join(payload, "src/release/preflight.ts"), "// synthetic native loader\n");
    await writeFile(join(payload, "src/install/main.ts"), "// synthetic installer entry\n");
    if (variant === "linked-file") {
      await symlink("release.json", join(payload, "linked.json"));
    }
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
      await mkdir(join(root, "data/updater"), { recursive: true });
      await writeFile(
        join(root, "data/updater/state.json"),
        JSON.stringify({
          current: metadata.release,
          pending: variant === "pending-update" ? { target: "synthetic-trial" } : null,
        })
      );
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
    if (variant === "valid" || variant === "rerun") {
      assert.equal(result.code, 0, result.output);
      assert.equal(nodeCalls.length, variant === "valid" ? 2 : 1);
      for (const call of nodeCalls) {
        assert(call.startsWith("node --no-wasm-lazy-compilation --experimental-strip-types "));
      }
      assert(calls.includes("apt-mark manual jq"));
      assert(calls.includes("systemctl start --no-block cool-eva-install-os.service"));
      assert(calls.indexOf("apt-mark manual jq") < calls.indexOf("src/install/main.ts"));
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
        "apt-failure": /setup stopped: OS catch-up failed[\s\S]*paste the same setup line/i,
      }[variant];
      assert.match(result.output, reason);
      if (variant === "cancel") {
        assert(!calls.includes("apt-get"));
      }
    }
  }
}
