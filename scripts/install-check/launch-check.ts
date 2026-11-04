import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export async function checkBundleLauncher(directory: string, repository: string): Promise<void> {
  const payload = join(directory, "launch-payload");
  await mkdir(join(payload, "runtime/bin"), { recursive: true });
  const argumentsFile = join(directory, "launch-arguments.txt");
  await writeFile(join(payload, "runtime/bin/node"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$LAUNCH_ARGUMENTS"\n', {
    mode: 0o755,
  });
  const script = join(directory, "launch.sh");
  await writeFile(
    script,
    (await readFile(join(repository, "scripts/update/launch.sh"), "utf8")).replace("/opt/cool-eva/current", payload)
  );
  await promisify(execFile)("sh", [script], {
    env: { ...process.env, LAUNCH_ARGUMENTS: argumentsFile },
  });
  assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), [
    "--no-wasm-lazy-compilation",
    "--experimental-strip-types",
    "./src/index.ts",
  ]);
}
