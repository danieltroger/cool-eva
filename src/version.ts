import { execFile } from "child_process";
import { lstat } from "fs/promises";
import { promisify } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { asOwnerCommand } from "./http/update.ts";
import { readReleaseMetadata, type RuntimeRelease } from "./release/metadata.ts";
import { readBundleNotices, readBundleVersion } from "./release/version.ts";
import { settingsPaths } from "./settings/paths.ts";

const execFileAsync = promisify(execFile);

// Which commit this process is running; expensive bundle diagnostics start after HTTP listens.
//
// ⚠️ Exists because of a failure nothing else here could see. On 2026-09-07 three DC charge-current
// commands changed the dash's number and moved no current: the Pi was running a build from five
// days before the 0x120 commit twin landed. Every check in the repo passed the whole time — a stale
// deploy is not a code change — and nothing on the bike could say which commit it was running, so
// the feature looked broken rather than old. docs/can-0x121-charge-command.md.
//
// Checkouts use Git, since package.json's 1.0.0 identifies no commit. Bundles carry their
// identity and file inventory; their OS/rollback notices refresh separately. docs/release-startup.md.

/** The running commit, or why it could not be read. A null `commit` is never fatal. */
export interface RunningVersion {
  /** Short SHA, e.g. `09c3b84`. Null when git could not answer. */
  commit: string | null;
  /** True when tracked checkout files or inventoried release files differ from their recorded commit. */
  dirty: boolean;
  /**
   * ⚠️ False when git could not say whether the tree is clean, NOT when it said it is dirty. The
   * banner and the page key their warning on this, so the one state this module goes out of its way
   * not to call clean is not then rendered as clean.
   */
  trustworthy: boolean;
  /** Commit/branch, edit or verification suffix, and plain bundle notices when applicable. */
  label: string;
}

/**
 * Reads the commit once and remembers it. Bundles remain unverified until background checks finish.
 *
 * `directory` is the checkout the Update button pulls (`UPDATE_DIR`), passed by src/index.ts at
 * startup rather than re-derived here — a Pi with `UPDATE_DIR` set would otherwise pull one
 * checkout and report another's commit, which is the pair of facts this exists to correlate.
 * Later callers pass nothing and get the cache.
 *
 * The PROMISE is cached, not the value: two callers racing the first read would otherwise each
 * spawn their own pair of git processes.
 */
export function readRunningVersion(
  directory?: string,
  updaterDirectory = settingsPaths().updaterDirectory
): Promise<RunningVersion> {
  cached ??= readVersion(directory ?? join(dirname(fileURLToPath(import.meta.url)), ".."), updaterDirectory);
  return cached.then(version => {
    if (bundle === null) return version;
    if (bundle.started) {
      refreshNotices(bundle);
    }
    return { ...version, label: [version.label, ...bundle.notices].join(" · ") };
  });
}

/** Call after HTTP is listening; diagnostic subprocesses must not gate startup or a settings response. */
export function beginRunningVersionChecks(): void {
  if (bundle === null || bundle.started) return;
  const current = bundle;
  current.started = true;
  setImmediate(() => {
    void readBundleVersion(current.directory, current.metadata).then(
      version => {
        cached = Promise.resolve(version);
        console.log(`version: release inventory check completed: ${version.label}`);
      },
      error => console.warn("version: background release check failed; retaining +unverified:", error)
    );
    refreshNotices(current);
  });
}

let cached: Promise<RunningVersion> | null = null;
let bundle: BundleVersionState | null = null;

interface BundleVersionState {
  directory: string;
  updaterDirectory: string;
  metadata: RuntimeRelease;
  started: boolean;
  notices: string[];
  refreshing: Promise<void> | null;
}

function refreshNotices(current: BundleVersionState): void {
  if (current.refreshing !== null) return;
  current.refreshing = Promise.resolve()
    .then(() => readBundleNotices(current.directory, current.updaterDirectory))
    .then(
      notices => {
        current.notices = notices;
      },
      error => console.warn("version: background OS/rollback notice refresh failed:", error)
    )
    .finally(() => {
      current.refreshing = null;
    });
}

async function readVersion(directory: string, updaterDirectory: string): Promise<RunningVersion> {
  try {
    const metadata = await readReleaseMetadata(directory);
    if (metadata) {
      bundle = { directory, updaterDirectory, metadata, started: false, notices: [], refreshing: null };
      return {
        commit: metadata.commit.slice(0, 7),
        dirty: false,
        trustworthy: false,
        label: `${metadata.branch}@${metadata.commit.slice(0, 7)}+unverified`,
      };
    }
  } catch (error) {
    console.warn("version: could not read release metadata:", error);
    return { commit: null, dirty: false, trustworthy: false, label: "unknown+unverified" };
  }
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
