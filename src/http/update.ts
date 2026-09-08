import type { IncomingMessage, ServerResponse } from "http";
import { execFile, spawn } from "child_process";
import { lstat, readdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { monotonicNow, since } from "../monotonic.ts";

const execFileAsync = promisify(execFile);

// POST /update — `git pull` the checkout on the Pi, then restart the service so the new
// code takes effect. The menu's "Update" button.
//
// Returns git's own output so the rider sees exactly what moved — or why nothing did. On
// a successful pull it restarts cool-eva; the service IS this process, so the restart can
// only fire AFTER the reply has flushed (the response's "finish" event), otherwise the
// button hangs on a killed connection. See scheduleServiceRestart for why it is detached.
//
// ⚠️ The pull runs as the checkout's OWNER, never as root, and is --ff-only. A root pull
// poisons .git with root-owned files and the next pull as the owner then fails silently.
// That incident, and why this shape deletes safe.directory and GIT_SSH_COMMAND rather
// than adding to them, is docs/deploy.md.

/**
 * What the endpoint says, for the caller that acts on it. A named type imported through
 * JSDoc in public/views/sheet.js — the dashboard has no build step, so this is what
 * stops the two ends drifting, the same as DashboardMessage in CLAUDE.md.
 */
export interface UpdateReply {
  ok: boolean;
  message: string;
}

/** git pull can hang on bad garage wifi; don't leave the button spinning forever. */
const PULL_TIMEOUT_MS = 60_000;

export async function handleUpdateEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  directory: string
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("POST to pull the latest code\n");
    return;
  }
  const startedAt = monotonicNow();
  // Falls back to our own uid only so a failing stat() still has something to name in the
  // reply; the pull itself never runs on that guess.
  const currentUid = process.getuid?.() ?? 0;
  let ownerUid = currentUid;
  try {
    const pull = await pullCommandFor(directory, currentUid);
    ownerUid = pull.ownerUid;
    const { stdout, stderr } = await execFileAsync(pull.command, pull.args, { timeout: PULL_TIMEOUT_MS });
    const output = `${stdout}${stderr}`.trim();
    console.log(`update: git pull in ${directory}:\n${output}`);
    const summary = output || "Already up to date.";
    respond(res, 200, { ok: true, message: `${summary}\n\nRestarting cool-eva…` });
    // The restart kills this process, so wait for the reply to leave the socket first.
    res.once("finish", scheduleServiceRestart);
  } catch (err) {
    // A non-zero git exit (merge conflict, no network, detached head) lands here with
    // its output carried on the error; surface that rather than a bare "failed".
    const detail = describePullFailure(err, since(startedAt), { directory, ownerUid });
    console.warn(`update: git pull in ${directory} failed:\n${detail}`);
    respond(res, 500, { ok: false, message: detail });
  }
}

/**
 * The argv that runs a git command as `ownerUid`, from a process running as `currentUid`.
 *
 * Pure, so the check can assert the user-switch on a machine with no second user; the uid
 * is derived from the checkout rather than a hardcoded `pi`, and `-H` is for git's own
 * ~/.gitconfig rather than for ssh. Both of those are load-bearing and neither is obvious:
 * docs/deploy.md §"What matching the user to the owner bought".
 *
 * `#1000` is sudo's syntax for a numeric uid. `-n` so a sudo needing a password fails at
 * once instead of hanging until the timeout on a prompt no phone can answer. When we are
 * already the owner there is nothing to switch to, so sudo is skipped entirely.
 */
export function asOwnerCommand(
  gitArgs: string[],
  ownerUid: number,
  currentUid: number
): { command: string; args: string[] } {
  if (ownerUid === currentUid) {
    return { command: "git", args: gitArgs };
  }
  return { command: "sudo", args: ["-n", "-u", `#${ownerUid}`, "-H", "git", ...gitArgs] };
}

/** The pull itself, so the endpoint and the installer cannot describe it differently. */
export const PULL_ARGS = ["pull", "--ff-only"];

/**
 * The pull, aimed at a real checkout: the owner uid comes from the directory itself.
 *
 * ⚠️ This one line — where the uid comes from — IS the 2026-09-08 bug, which is why it is
 * exported rather than inlined: a check that only exercises asOwnerCommand() with literal
 * uids passes on a build that pulls as root, because on any machine running the suite the
 * checkout is owned by whoever runs it and the sudo branch is never taken.
 *
 * ⚠️ It stats the WORKTREE root, while the invariant is about the object store; they
 * diverge in a linked `git worktree` and in a checkout whose .git was chowned separately.
 * docs/deploy.md §"Other decisions".
 */
export async function pullCommandFor(
  directory: string,
  currentUid: number
): Promise<{ command: string; args: string[]; ownerUid: number }> {
  const { uid } = await lstat(directory);
  return { ...asOwnerCommand(["-C", directory, ...PULL_ARGS], uid, currentUid), ownerUid: uid };
}

/**
 * What the rider is shown when the pull failed, git's own output included.
 *
 * Pure, and elapsed time arrives as an argument rather than off a clock, so the timeout
 * case is checkable without waiting a minute for it (scripts/check-update-endpoint.ts).
 */
export function describePullFailure(err: unknown, elapsedMs: number, deploy: DeployContext): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const failure = err as Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null };
  const streams = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
  // Prepended, never substituted: the streams are the evidence and this is only the
  // frame to read them in. On a partial transfer they are the whole diagnostic value.
  const lines = wasKilledByTimeout(failure, elapsedMs)
    ? [`Stopped after ${Math.round(PULL_TIMEOUT_MS / 1000)} s — bad wifi, or a remote that never answered.`]
    : [];
  lines.push(streams || err.message);
  const hint = deployHint(streams, deploy);
  if (hint) {
    lines.push(hint);
  }
  return lines.join("\n\n");
}

/**
 * Elapsed time is the only thing that separates a timeout from any other kill: `killed`
 * and `signal` read identically either way. A kill at or past the deadline is exec's own
 * timer; a kill before it is something else, most likely an OOM on a Pi Zero, and calling
 * that "bad wifi" would be a confident wrong answer.
 *
 * No skew margin: `startedAt` is taken before the spawn and elapsed is read after the
 * rejection propagates, so it is necessarily past libuv's deadline already. A margin could
 * only widen the window in which an OOM gets misreported.
 */
function wasKilledByTimeout(failure: { killed?: boolean; signal?: string | null }, elapsedMs: number): boolean {
  const killed = failure.killed === true || typeof failure.signal === "string";
  return killed && elapsedMs >= PULL_TIMEOUT_MS;
}

/** Where the deploy lives, so a hint can name the real path and user rather than `pi`. */
export interface DeployContext {
  directory: string;
  ownerUid: number;
}

/** A path that does not belong to the checkout's owner, and who owns it instead. */
export interface ForeignPath {
  path: string;
  uid: number;
}

/**
 * Walk `roots` and return what is not owned by `ownerUid` — the fingerprint a root pull
 * leaves behind.
 *
 * ⚠️ Sampling `.git` and `.git/logs/refs` does NOT work, which is how the first version of
 * this was wrong: a pull neither creates nor rewrites them, so they keep the cloner's
 * ownership no matter who pulls. What a root pull creates is the LEAVES —
 * `.git/logs/refs/remotes/origin/<branch>`, `FETCH_HEAD`, the per-ref files — which is
 * exactly what the Pi's error named. Verified by inode: the two parents survive a pull
 * unchanged while the leaf appears only after one. So this recurses.
 *
 * Cheap because the caller passes only `logs/` and `refs/` — tens of small files — never
 * `objects/`. Stops at `limit`, since the repair is the same whether 3 files or 3000 are
 * wrong and a warning nobody can read is not a better warning.
 */
export async function foreignOwner(path: string, ownerUid: number): Promise<ForeignPath | null> {
  try {
    const entry = await lstat(path);
    return entry.uid === ownerUid ? null : { path, uid: entry.uid };
  } catch (error) {
    // Absent is normal: FETCH_HEAD before the first fetch, logs/ with reflogs disabled,
    // and all three roots in a linked `git worktree`. Anything else is worth a line.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`deploy: could not stat ${path}: ${(error as Error).message}`);
    }
    return null;
  }
}

export async function findForeignOwnedPaths(roots: string[], ownerUid: number, limit = 8): Promise<ForeignPath[]> {
  const found: ForeignPath[] = [];
  const pending = [...roots];
  while (pending.length > 0 && found.length < limit) {
    const current = pending.shift() as string;
    const foreign = await foreignOwner(current, ownerUid);
    if (foreign) {
      found.push(foreign);
    }
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      // foreignOwner has already reported anything that matters about this path.
      continue;
    }
    if (entry.isDirectory()) {
      try {
        const children = await readdir(current);
        pending.push(...children.map(child => join(current, child)));
      } catch (error) {
        // ⚠️ Never rethrow. An unreadable directory is a LIKELY SYMPTOM of the state this
        // is looking for, and this runs at the end of an install that has already started
        // the service — throwing here would fail a good install on the evidence it was
        // called to report. lstat above already recorded the directory if it is foreign.
        console.warn(`deploy: could not list ${current}: ${(error as Error).message}`);
      }
    }
  }
  return found;
}

/**
 * Turn a git failure into the one sentence that fixes it, or null when we have nothing
 * useful to add. Shared with scripts/setup-service.ts so the installer and the button
 * never give different advice about the same state.
 *
 * ⚠️ Nothing here hardcodes `pi` or `/home/pi`, and the shell redirects run inside the
 * target user's own shell — advice that writes a root-owned file into the owner's ~/.ssh
 * would be this branch's own bug, one directory over. The ssh arms match OpenSSH's words
 * rather than git's, which are localised. docs/deploy.md has the why for both.
 */
export function deployHint(streams: string, deploy: DeployContext): string | null {
  const owner = `'#${deploy.ownerUid}'`;
  // ⚠️ The create case REQUIRES "Permission denied" on the same line. A blind match on
  // `Unable to create '…/.git/…'` also catches `index.lock': File exists`, which is a
  // stale lock from a bike that lost power mid-pull — handled below, and wanting the
  // opposite advice. Capital U because git emits both spellings.
  if (
    /insufficient permission|cannot update the ref/.test(streams) ||
    /[Uu]nable to (append to|create|write)[^\n]*Permission denied/.test(streams)
  ) {
    return (
      `Files under ${deploy.directory}/.git belong to another user — something ran ` +
      `\`sudo git pull\` here. The pull cannot write refs, so it silently does not happen. ` +
      `Repair: sudo chown -R ${deploy.ownerUid} ${deploy.directory}. See INSTALL.md §3.`
    );
  }
  if (/[Uu]nable to create '[^']*\.lock': File exists/.test(streams)) {
    return (
      "A previous git command was interrupted and left a lock file behind — switching the " +
      "bike off mid-pull does this. Nothing is broken: delete the .lock file named above " +
      "and press Update again."
    );
  }
  if (/Permission denied \(publickey/.test(streams)) {
    return (
      "GitHub refused the checkout owner's ssh key. Add their ~/.ssh/id_*.pub as a deploy " +
      "key on the fork, or use an https remote — a public fork needs no key at all. " +
      "See INSTALL.md §3."
    );
  }
  if (/Host key verification failed/.test(streams)) {
    return (
      "github.com is not in the checkout owner's known_hosts. Add it AS THAT USER, so the " +
      `file is theirs: sudo -u ${owner} sh -c 'ssh-keyscan github.com >> ~/.ssh/known_hosts'.`
    );
  }
  if (/Not possible to fast-forward/.test(streams)) {
    // ⚠️ @{u}, never origin/HEAD: origin/HEAD is pinned at clone time to the DEFAULT
    // branch, so on a Pi parked on a test branch (CLAUDE.md documents doing that) this
    // sentence would silently replace the tree with main's content.
    return (
      "The checkout has commits the remote does not — this pull is --ff-only and will not " +
      `merge them on the bike. To discard them: sudo -u ${owner} git -C ${deploy.directory} ` +
      `fetch origin && sudo -u ${owner} git -C ${deploy.directory} reset --hard '@{u}'.`
    );
  }
  if (/could not read Username|Authentication failed/.test(streams)) {
    return (
      "The https remote wants a login, so this fork is private. Give the Pi an ssh remote " +
      "and a deploy key on the owner's account instead — there is no terminal here to type " +
      "a password into. See INSTALL.md §3."
    );
  }
  if (/^sudo:/m.test(streams)) {
    return (
      `sudo could not switch to the checkout's owner (uid ${deploy.ownerUid}). The service ` +
      "runs as root, which needs no password, so this means it is not running as root — " +
      `check \`User=\` in the unit, or give that user a NOPASSWD line for \`git\`.`
    );
  }
  return null;
}

// Restart the service the moment the reply has flushed. `--no-block` hands the job to
// systemd (PID 1) and returns, so it is queued before systemd tears down our cgroup mid-
// restart; detached + unref + ignored stdio means this child does not keep the dying
// process pinned open waiting on it. sudo because the button may be reached as a non-root
// user, and it is a no-op passthrough when the service already runs as root.
function scheduleServiceRestart(): void {
  // -n and the exit listener for the same reason the pull has them: a sudo that wants a
  // password must fail visibly rather than sit on a prompt, and a non-zero exit here used
  // to be silent — the reply has already promised the rider a restart by this point.
  const restart = spawn("sudo", ["-n", "systemctl", "restart", "--no-block", "cool-eva"], {
    detached: true,
    stdio: "ignore",
  });
  restart.on("error", err => {
    console.warn("update: could not spawn service restart:", err);
  });
  restart.on("exit", code => {
    // ⚠️ null means signalled, which is the SUCCESS path here: the restart we just queued
    // tears down our own cgroup. Only a real non-zero exit is a failure.
    if (code !== 0 && code !== null) {
      console.warn(`update: service restart exited ${code} — the new code is on disk but not running`);
    }
  });
  restart.unref();
}

function respond(res: ServerResponse, statusCode: number, reply: UpdateReply): void {
  const body = Buffer.from(JSON.stringify(reply), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
