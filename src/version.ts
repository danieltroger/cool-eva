import { execFile } from "child_process";
import { lstat } from "fs/promises";
import { promisify } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { asOwnerCommand } from "./http/update.ts";

const execFileAsync = promisify(execFile);

// Which commit this process is running, read once at startup.
//
// ⚠️ Exists because of a failure nothing else here could see. On 2026-09-07 three DC charge-current
// commands changed the dash's number and moved no current: the Pi was running a build from five
// days before the 0x120 commit twin landed. Every check in the repo passed the whole time — a stale
// deploy is not a code change — and nothing on the bike could say which commit it was running, so
// the feature looked broken rather than old. docs/can-0x121-charge-command.md.
//
// Deploy is `git pull` in a checkout (INSTALL.md), so git is the source of truth: there is no build
// step to stamp a version into and `package.json` has said 1.0.0 since the beginning.

/** The running commit, or why it could not be read. A null `commit` is never fatal. */
export interface RunningVersion {
  /** Short SHA, e.g. `09c3b84`. Null when git could not answer. */
  commit: string | null;
  /** True when tracked files differ from that commit — the running code is not the committed code. */
  dirty: boolean;
  /**
   * ⚠️ False when git could not say whether the tree is clean, NOT when it said it is dirty. The
   * banner and the page key their warning on this, so the one state this module goes out of its way
   * not to call clean is not then rendered as clean.
   */
  trustworthy: boolean;
  /** Already phrased: `09c3b84`, `09c3b84+dirty`, `09c3b84+unverified`, or `unknown`. */
  label: string;
}

/**
 * Reads the commit once and remembers it. Safe to call from anywhere afterwards.
 *
 * `directory` is the checkout the Update button pulls (`UPDATE_DIR`), passed by src/index.ts at
 * startup rather than re-derived here — a Pi with `UPDATE_DIR` set would otherwise pull one
 * checkout and report another's commit, which is the pair of facts this exists to correlate.
 * Later callers pass nothing and get the cache.
 *
 * The PROMISE is cached, not the value: two callers racing the first read would otherwise each
 * spawn their own pair of git processes.
 */
export function readRunningVersion(directory?: string): Promise<RunningVersion> {
  cached ??= readVersion(directory ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  return cached;
}

let cached: Promise<RunningVersion> | null = null;

async function readVersion(directory: string): Promise<RunningVersion> {
  // ⚠️ Run as the checkout's OWNER, exactly as the Update button's pull does. The service is
  // `User=root` (scripts/setup-service.ts) over a `pi`-owned checkout, and git refuses to operate on
  // a repository it considers someone else's — so a plain `git -C` here answers nothing and this
  // reports `unknown` for ever, on the one machine the feature exists for. Why a user switch rather
  // than `safe.directory`: docs/deploy.md §"Other decisions".
  const currentUid = process.getuid?.() ?? 0;
  let ownerUid = currentUid;
  try {
    ownerUid = (await lstat(directory)).uid;
  } catch (err) {
    console.warn(`version: could not stat ${directory}, running git as this user:`, err);
  }
  // Independent, so concurrently: two sequential fork/execs plus an index refresh over every tracked
  // file costs a few hundred ms on a Pi Zero, and this sits ahead of CAN bring-up.
  const [commit, changes] = await Promise.all([
    gitOutput(directory, ["rev-parse", "--short", "HEAD"], ownerUid, currentUid),
    // ⚠️ `--untracked-files=no`: the question is whether the RUNNING code differs from the COMMITTED
    // code. An untracked ride-log or scratch file is not that, and without this the Pi would report
    // `+dirty` permanently and the flag would stop meaning anything.
    gitOutput(directory, ["status", "--porcelain", "--untracked-files=no"], ownerUid, currentUid),
  ]);
  const dirty = changes !== null && changes.length > 0;
  const label =
    commit === null ? "unknown" : changes === null ? `${commit}+unverified` : dirty ? `${commit}+dirty` : commit;
  return { commit, dirty, trustworthy: commit !== null && changes !== null, label };
}

async function gitOutput(
  directory: string,
  args: string[],
  ownerUid: number,
  currentUid: number
): Promise<string | null> {
  const { command, args: argv } = asOwnerCommand(["-C", directory, ...args], ownerUid, currentUid);
  try {
    const { stdout } = await execFileAsync(command, argv);
    return stdout.trim();
  } catch (err) {
    // Not silent, and not fatal: a Pi whose checkout git cannot read still has a bike to log. Loud
    // because `unknown` on the status line is a worse answer than a commit, and someone should be
    // able to find out why they are getting it.
    console.warn(`version: could not run git ${args.join(" ")} in ${directory}:`, err);
    return null;
  }
}
