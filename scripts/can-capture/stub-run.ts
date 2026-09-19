import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { gunzip } from "zlib";
import { promisify } from "util";

// Runs the REAL scripts/can-capture/capture.sh under stubbed `ip`, `candump`, `df`,
// `stdbuf`, `timeout`, `sleep` and `split`, in a temp directory, and reports what it did.
//
// Why execute it rather than assert regexes over it: three of the properties that matter
// are orderings — the tool guard and the disk floor must both come before the file is
// created, and the can0 wait before candump — and an `indexOf` pair can only approximate
// those. It also makes the floor's fail-closed direction testable, which no regex can be.
//
// ⚠️ The capture directory and the two /proc paths are rewritten in a COPY. capture.sh
// deliberately takes none of them from the environment: an env var that could repoint the
// capture is exactly the hole the tmpfs assertion exists to keep shut.

const gunzipAsync = promisify(gunzip);

export interface StubRunOptions {
  /** What the stub `df` prints in the Available column. A string, so garbage is testable. */
  availableKb?: string;
  /** Make the stub `df` fail outright, printing nothing on stdout. */
  dfFails?: boolean;
  /** Exit code for the stub `candump`, after it has emitted two frames. */
  candumpExitCode?: number;
  /** Real binaries to leave OFF the stub PATH, e.g. `["gzip"]`. */
  omitFromPath?: string[];
  /**
   * Make the status file read back as something that is not a number, which is the one
   * way capture.sh can lose candump's exit code without any command having failed.
   */
  corruptStatus?: boolean;
  /** Replaces the script text, for mutation runs. Rewrites still apply. */
  scriptText?: string;
}

export interface StubRunResult {
  exitCode: number | null;
  /** stdout and stderr together — the journal's view. */
  output: string;
  /** Basenames created in the capture directory. */
  captureFiles: string[];
  /** The argv the stub `split` was called with, or null if it never ran. */
  splitArgv: string | null;
  /** The one capture file, decompressed, or null if none was written. */
  capturedText: string | null;
}

export async function runCaptureScriptWithStubs(
  scriptPath: string,
  options: StubRunOptions = {}
): Promise<StubRunResult> {
  const root = await mkdtemp(join(tmpdir(), "cool-eva-capture-stub-"));
  try {
    const context = await buildStubEnvironment(root, scriptPath, options);
    const run = await spawnScript(context);
    const captureFiles = (await readdir(context.captureDirectory)).sort();
    return {
      exitCode: run.exitCode,
      output: run.output,
      captureFiles,
      splitArgv: await readIfPresent(context.splitLog),
      capturedText: await readCapture(context.captureDirectory, captureFiles),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface StubContext {
  binDirectory: string;
  captureDirectory: string;
  scriptCopy: string;
  splitLog: string;
}

/**
 * Everything the script reaches for that is not a shell builtin.
 *
 * ⚠️ A tool missing here makes the run exit 127, which looks exactly like the script
 * failing for the reason under test. Every assertion that reads an exit code would then
 * be "passing" on a run that never happened — so a stub PATH is only as good as this list.
 */
const REAL_TOOLS = ["cut", "date", "awk", "mkdir", "gzip", "mktemp", "cat", "rm"];

async function buildStubEnvironment(root: string, scriptPath: string, options: StubRunOptions): Promise<StubContext> {
  const binDirectory = join(root, "bin");
  const captureDirectory = join(root, "captures");
  const splitLog = join(root, "split-argv.txt");
  const bootIdFile = join(root, "boot_id");
  const uptimeFile = join(root, "uptime");
  await mkdir(binDirectory);
  await mkdir(captureDirectory);
  await writeFile(bootIdFile, "7ce067a8-1111-2222-3333-444455556666\n");
  await writeFile(uptimeFile, "1234.56 9876.54\n");

  const omit = new Set(options.omitFromPath ?? []);
  const stubs = stubScripts(options, splitLog);

  // ⚠️ Stubs are written FIRST and a real tool is never symlinked over one. writeFile
  // through an existing symlink writes to the real binary's own path — /bin/cat — and
  // fails with EACCES, which reads as the script being broken rather than the harness.
  for (const [name, body] of Object.entries(stubs)) {
    if (omit.has(name)) {
      continue;
    }
    const path = join(binDirectory, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }

  for (const tool of REAL_TOOLS) {
    if (omit.has(tool) || tool in stubs) {
      continue;
    }
    const resolved = await which(tool);
    if (!resolved) {
      throw new Error(`stub-run: ${tool} is not on PATH, so the stub environment cannot be built`);
    }
    await symlink(resolved, join(binDirectory, tool));
  }

  const original = options.scriptText ?? (await readFile(scriptPath, "utf-8"));
  const rewritten = original
    .replace(/^DIRECTORY=.*$/m, `DIRECTORY=${captureDirectory}`)
    .replace("/proc/sys/kernel/random/boot_id", bootIdFile)
    .replace("/proc/uptime", uptimeFile);
  // ⚠️ Asserted, not assumed. A silent no-op here — after a rename, or after prettier
  // rewraps a line — would point the run at the real /home/pi/ride-captures and at /proc,
  // and the check would go green having tested the wrong script.
  for (const expected of [`DIRECTORY=${captureDirectory}`, bootIdFile, uptimeFile]) {
    if (!rewritten.includes(expected)) {
      throw new Error(`stub-run: rewriting the script for ${expected} did not apply — the check would test nothing`);
    }
  }
  const scriptCopy = join(root, "capture.sh");
  await writeFile(scriptCopy, rewritten);
  return { binDirectory, captureDirectory, scriptCopy, splitLog };
}

function stubScripts(options: StubRunOptions, splitLog: string): Record<string, string> {
  const dfBody = options.dfFails
    ? `#!/bin/sh\necho "df: cannot read filesystem information" >&2\n`
    : `#!/bin/sh
echo "Filesystem     1024-blocks      Used Available Capacity Mounted on"
echo "/dev/mmcblk0p2   122519444 100443596  ${options.availableKb ?? "17061320"}      86% /"
`;
  const stubs: Record<string, string> = {
    ip: `#!/bin/sh\nexit 0\n`,
    df: dfBody,
    // Two real frames and a stderr line, so the run proves 2>&1 reaches the pipe.
    candump: `#!/bin/sh
echo " (2026-09-19 21:00:00.000001)  can0  101   [8]  65 64 04 00 00 00 00 00"
echo " (2026-09-19 21:00:00.010001)  can0  102   [8]  00 01 02 03 04 05 06 07"
echo "can0: interface down" >&2
exit ${options.candumpExitCode ?? 0}
`,
    stdbuf: `#!/bin/sh\nshift\nexec "$@"\n`,
    timeout: `#!/bin/sh\nshift\nexec "$@"\n`,
    // Aborts instead of waiting: a check that sleeps 60 s to observe the floor is a check
    // nobody runs. The non-zero exit is what ends the script under `set -e`.
    sleep: `#!/bin/sh\necho "stub sleep $1" >&2\nexit 9\n`,
    // ⚠️ /bin/sh by absolute path. GNU split runs the filter through $SHELL or /bin/sh;
    // a bare `sh` here dies with 127 on the restricted PATH and looks like a script bug.
    split: `#!/bin/sh
printf '%s\\n' "$*" > ${JSON.stringify(splitLog)}
filter=""
for argument in "$@"; do
  case "$argument" in --filter=*) filter=\${argument#--filter=} ;; esac
done
if [ -z "$filter" ]; then
  echo "stub split: no --filter" >&2
  exit 1
fi
exec /bin/sh -c "$filter"
`,
  };
  if (options.corruptStatus) {
    stubs.cat = `#!/bin/sh\necho "not-a-number"\n`;
  }
  return stubs;
}

async function spawnScript(context: StubContext): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [context.scriptCopy], {
      env: { PATH: context.binDirectory, HOME: "/nonexistent" },
    });
    let output = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (output += chunk));
    child.on("error", reject);
    child.on("close", exitCode => resolve({ exitCode, output }));
  });
}

async function readCapture(directory: string, files: string[]): Promise<string | null> {
  if (files.length !== 1) {
    return null;
  }
  const body = await readFile(join(directory, files[0]));
  if (body.length === 0) {
    return "";
  }
  return (await gunzipAsync(body)).toString("utf-8");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch (error) {
    // Expected whenever the run never reached the pipeline — a refused floor, a missing
    // binary. Logged rather than swallowed so a DISAPPEARING split log is still visible.
    console.log(`  (no split argv recorded: ${(error as Error).message.split("\n")[0]})`);
    return null;
  }
}

async function which(tool: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn("/usr/bin/env", ["sh", "-c", `command -v ${tool}`]);
    let found = "";
    child.stdout.on("data", chunk => (found += chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(found.trim() || null));
  });
}
