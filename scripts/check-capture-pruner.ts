import assert from "assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { capturePruneSudoers, CAPTURE_PRUNE_HELPER } from "./can-capture/install-prune.ts";
import { captureDirectoryCommand, deleteCaptureCommand } from "./can-capture/remote-directory.ts";

await checkPruner();
console.log("capture pruner checks passed");

async function checkPruner(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-pruner-check-"));
  try {
    const captureDirectory = join(directory, "captures");
    const bin = join(directory, "bin");
    await mkdir(captureDirectory);
    await chmod(captureDirectory, 0o2750);
    await mkdir(bin);
    await writeExecutable(join(bin, "id"), '#!/bin/sh\nprintf "0\\n"\n');
    await writeExecutable(
      join(bin, "stat"),
      `#!${process.execPath}
const {statSync} = require('node:fs');
const metadata = statSync(process.argv[4]);
process.stdout.write(process.argv[3] === '%u' ? '0\\n' : (metadata.mode & 0o7777).toString(8)+'\\n');
`
    );
    await writeExecutable(
      join(bin, "cut"),
      '#!/bin/sh\ncase "$*" in *"/proc/sys/kernel/random/boot_id"*) printf "feedface\\n" ;; *) exec /usr/bin/cut "$@" ;; esac\n'
    );
    await writeExecutable(
      join(bin, "unlink"),
      `#!${process.execPath}
require('node:fs/promises').unlink(process.argv.at(-1)).catch(error => { console.error(error); process.exitCode = 1; });
`
    );
    const source = await readFile(new URL("./can-capture/prune-helper.sh", import.meta.url), "utf-8");
    assert.equal(source.split("DIRECTORY=/var/lib/cool-eva/captures").length, 2);
    assert.ok(source.includes("PATH=/usr/sbin:/usr/bin:/sbin:/bin"));
    assert.ok(source.includes("for parent in /var /var/lib /var/lib/cool-eva; do"));
    const helper = join(directory, "prune.sh");
    await writeFile(
      helper,
      source
        .replace("DIRECTORY=/var/lib/cool-eva/captures", `DIRECTORY='${captureDirectory}'`)
        .replace("PATH=/usr/sbin:/usr/bin:/sbin:/bin", `PATH='${bin}:${process.env.PATH ?? ""}'`)
        .replace("for parent in /var /var/lib /var/lib/cool-eva; do", `for parent in '${directory}'; do`)
    );
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const old = "capture-20200101-010203-00000001-00000010.log.gz";
    const active = "capture-20200101-010203-feedface-00000010.log.gz";
    await writeFile(join(captureDirectory, old), "synthetic old capture");
    await writeFile(join(captureDirectory, active), "synthetic active capture");
    const removed = await runHelper(helper, `${old}\n`, environment);
    assert.equal(removed.code, 0, removed.errors);
    assert.equal(removed.output, `GONE\t${old}\n`);
    await assert.rejects(lstat(join(captureDirectory, old)));
    assert.equal((await runHelper(helper, `${active}\n`, environment)).code, 2);
    assert.equal(await readFile(join(captureDirectory, active), "utf-8"), "synthetic active capture");
    for (const bad of ["../outside", "--help", "not-a-capture", "capture-20200101-010203-00000001.log.gz;touch-x"]) {
      assert.equal((await runHelper(helper, `${bad}\n`, environment)).code, 2);
    }
    const outside = join(directory, "outside");
    await writeFile(outside, "must survive");
    const linked = "capture-20200101-010203-00000002.log";
    await symlink(outside, join(captureDirectory, linked));
    assert.equal((await runHelper(helper, `${linked}\n`, environment)).code, 2);
    assert.equal(await readFile(outside, "utf-8"), "must survive");
    await chmod(captureDirectory, 0o2770);
    assert.equal((await runHelper(helper, `${active}\n`, environment)).code, 2);
    await chmod(captureDirectory, 0o2750);
    await chmod(directory, 0o770);
    assert.equal((await runHelper(helper, `${old}\n`, environment)).code, 2);
    await chmod(directory, 0o700);
    assert.equal((await runHelper(helper, "", environment, ["--directory", outside])).code, 2);
    assert.equal(capturePruneSudoers("archive"), `%archive ALL=(root) NOPASSWD: ${CAPTURE_PRUNE_HELPER} ""\n`);
    assert.throws(() => capturePruneSudoers("archive ALL=(root) ALL"));
    assert.ok(deleteCaptureCommand().includes(`sudo -n ${CAPTURE_PRUNE_HELPER}`));
    assert.ok(captureDirectoryCommand().includes("/var/lib/cool-eva/captures"));
    assert.ok(deleteCaptureCommand().includes("/home/pi/ride-captures"));
    console.log(
      "  no-argument sudo rule, current-boot/link/name refusal, protected directory and noninteractive legacy-compatible client"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function runHelper(
  helper: string,
  input: string,
  environment: NodeJS.ProcessEnv,
  helperArguments: string[] = []
): Promise<{ code: number; output: string; errors: string }> {
  const { spawn } = await import("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [helper, ...helperArguments], { env: environment });
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
    });
    child.stderr.on("data", chunk => {
      errors += String(chunk);
    });
    child.once("error", reject);
    child.once("close", code => resolve({ code: code ?? -1, output, errors }));
    child.stdin.end(input);
  });
}
