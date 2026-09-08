import { execFile } from "child_process";
import { promisify } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

// Which commit this process is running, read once at startup.
//
// ⚠️ This exists because of a failure nothing else here could see. On 2026-09-07 three DC
// charge-current commands changed the dash's number and moved no current: the Pi was running
// `93e071a`, pulled five days earlier, from before the 0x120 commit twin landed on main. Every
// check in the repo passed the whole time — a stale deploy is not a code change. Nothing on the
// bike could say which commit it was running, so the feature looked broken rather than old.
// docs/can-0x121-charge-command.md § "the deploy, not the design".
//
// Deploy is `git pull` in a checkout (INSTALL.md), so `git` is the source of truth and there is
// no build step to stamp a version into. `package.json` says 1.0.0 and always has.

/** The running commit, or why it could not be read. Null `commit` is never fatal. */
export interface RunningVersion {
  /** Short SHA, e.g. `09c3b84`. Null when git could not answer. */
  commit: string | null;
  /** True when tracked files differ from that commit — the running code is not the committed code. */
  dirty: boolean;
  /** Already phrased for a banner or a status line: `09c3b84`, `09c3b84+dirty`, or `unknown`. */
  label: string;
}

/**
 * Reads the commit once and remembers it. Safe to call from anywhere afterwards.
 *
 * Cached because the answer cannot change without restarting the process — deploy is a pull
 * followed by `systemctl restart` — and because the status payload is fetched before every
 * write arms, which is not a place to spawn two git processes.
 */
export async function readRunningVersion(): Promise<RunningVersion> {
  if (cached) {
    return cached;
  }
  const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
  const commit = await gitOutput(repository, ["rev-parse", "--short", "HEAD"]);
  // ⚠️ `--untracked-files=no`: the question is whether the RUNNING code differs from the committed
  // code, and an untracked ride-log or scratch file is not that. Without it the Pi, which
  // accumulates both, would report `+dirty` permanently and the flag would stop meaning anything.
  const changes =
    commit === null ? null : await gitOutput(repository, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = changes !== null && changes.length > 0;
  // ⚠️ A failed `status` is NOT a clean tree. Saying `09c3b84` when we could not check would claim
  // the running code is the committed code on exactly the evidence we do not have.
  const label =
    commit === null ? "unknown" : changes === null ? `${commit}+unverified` : dirty ? `${commit}+dirty` : commit;
  cached = { commit, dirty, label };
  return cached;
}

let cached: RunningVersion | null = null;

async function gitOutput(repository: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repository, ...args]);
    return stdout.trim();
  } catch (err) {
    // Not silent, and not fatal: a Pi whose checkout git cannot read still has a bike to log.
    // Loud because "unknown" on the status line is a worse answer than a commit and someone
    // should be able to find out why they are getting it.
    console.warn(`version: could not run git ${args.join(" ")} in ${repository}:`, err);
    return null;
  }
}
