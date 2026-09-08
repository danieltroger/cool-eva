import type { IncomingMessage, ServerResponse } from "http";
import { execFile, spawn } from "child_process";
import { stat } from "fs/promises";
import { promisify } from "util";
import { monotonicNow, since } from "../monotonic.ts";

const execFileAsync = promisify(execFile);

// POST /update — `git pull` the checkout on the Pi, then restart the service so the new
// code takes effect.
//
// The menu's "Update" button. Pulls the deploy directory and returns git's own output
// so the rider sees exactly what moved — or why nothing did. On a successful pull it then
// restarts cool-eva; the service IS this process, so the restart can only fire AFTER the
// reply has flushed (the request's response "finish" event) — otherwise the button hangs
// on a killed connection. See scheduleServiceRestart for why it must be detached.
//
// ⚠️ THE PULL RUNS AS THE CHECKOUT'S OWNER, NOT AS ROOT, and that is the whole of why
// this file is shaped the way it is. A root `git pull` over a pi-owned checkout leaves
// root-owned files behind in .git — refs, reflogs, objects — and the NEXT pull as pi then
// dies on "unable to append to '.git/logs/refs/remotes/origin/<branch>': Permission
// denied". That failure is quiet in the worst way: the fast-forward does not happen, the
// service restarts on the old commit, and the journal looks healthy. It happened on the
// bike on 2026-09-08 and had to be repaired with chown -R.
//
// Matching the user to the owner also retires two workarounds. `-c safe.directory` was
// only ever needed because the uid did not match the owner, and ssh credentials stop
// needing a GIT_SSH_COMMAND: OpenSSH resolves ~/.ssh from the EFFECTIVE UID's passwd
// entry, so switching user is by itself enough to put pi's key and known_hosts in reach.
// Measured, because the distinction matters below: `sudo -u '#N' ssh -G` reads the target
// user's known_hosts with or without -H. One mechanism, not three.
//
// --ff-only so a diverged checkout fails loudly instead of quietly building a merge
// commit on the bike, which nobody is there to review.

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
  let ownerUid = process.getuid?.() ?? 0;
  try {
    const pull = await pullCommandFor(directory, process.getuid?.() ?? 0);
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
 * Pure and exported so scripts/setup-service.ts verifies the remote exactly the way the
 * button will pull it, and so the check can assert the user-switch without a `pi` on the
 * machine running the test.
 *
 * The uid is taken from the checkout rather than hardcoding `pi`, because the invariant
 * that matters is "the puller IS the owner" — a hardcoded name reintroduces the same bug
 * mirrored the moment a checkout belongs to anyone else. `#1000` is sudo's own syntax for
 * a numeric uid. `-n` so a sudo that would need a password fails at once instead of
 * hanging until the timeout on a prompt no phone can answer — verified: it exits
 * immediately with "sudo: a password is required".
 *
 * ⚠️ `-H` is NOT what fixes ssh, which is easy to assume and wrong: ssh follows the
 * effective uid, and without -H sudo leaves HOME pointing at the INVOKING user's home
 * (root's). -H is here for what genuinely does read $HOME — git's own ~/.gitconfig and
 * any credential helper — so the pull sees the owner's git config rather than root's.
 *
 * When we already ARE the owner there is nothing to switch to, so sudo is skipped
 * entirely — which is also what lets the check drive the real path in CI.
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
 * ⚠️ This one line — where the uid comes from — IS the bug from 2026-09-08, and it is why
 * this is exported rather than inlined. A check that only exercises asOwnerCommand() with
 * literal uids passes on a build that pulls as root, because on any machine running the
 * suite the checkout is owned by whoever runs it and the sudo branch is never taken.
 *
 * ⚠️ It stats the WORKTREE root. The invariant is really about the object store, and the
 * two diverge in a linked `git worktree` (where .git is a file pointing elsewhere) and in
 * a checkout whose .git was chowned separately — which is exactly the poisoned state this
 * branch is about. deployHint() names that state when git reports it; the installer
 * checks for it directly.
 */
export async function pullCommandFor(
  directory: string,
  currentUid: number
): Promise<{ command: string; args: string[]; ownerUid: number }> {
  const { uid } = await stat(directory);
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
 * A kill at or past the deadline is exec's own timer firing — once it has elapsed there
 * is no other explanation. No skew margin: `startedAt` is taken before the spawn and the
 * elapsed time is read after the rejection has propagated, so it is necessarily past
 * libuv's deadline already. A margin could only widen the window in which an OOM kill
 * gets misreported as a timeout, which is the very thing this exists to prevent. A kill BEFORE it is something else (an OOM on a Pi Zero is
 * the likely one) and must not be called a timeout. Elapsed time is the only thing that
 * separates the two: `killed` and `signal` read identically either way.
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

/**
 * Turn a git failure into the one sentence that fixes it, or null when we have nothing
 * useful to add. Shared with scripts/setup-service.ts so the installer and the button
 * never give different advice about the same state.
 *
 * ⚠️ Nothing here hardcodes `pi` or `/home/pi`. The hint for a wrongly-owned checkout that
 * told you to run `sudo -u pi ssh-keyscan … >> /home/pi/.ssh/known_hosts` would create a
 * ROOT-OWNED file in pi's ~/.ssh, because `>>` is performed by the invoking shell — the
 * same ownership bug this branch exists to fix, one directory over, caused by the repair
 * instruction. The commands below run the redirect inside the target user's own shell.
 *
 * ⚠️ The ssh arms match OpenSSH's words, not git's: OpenSSH ships no NLS at all, so they
 * are byte-identical under every locale, while git's `fatal:`/`error:` lines move with
 * LC_ALL. The method list in `Permission denied (publickey,password)` varies with what the
 * server offered, so that match stops before the closing paren.
 */
export function deployHint(streams: string, deploy: DeployContext): string | null {
  const owner = `'#${deploy.ownerUid}'`;
  if (/insufficient permission|unable to (append to|create|write)[^\n]*\.git\/|cannot update the ref/.test(streams)) {
    return (
      `Files under ${deploy.directory}/.git belong to another user — something ran ` +
      `\`sudo git pull\` here. The pull cannot write refs, so it silently does not happen. ` +
      `Repair: sudo chown -R ${deploy.ownerUid} ${deploy.directory}. See INSTALL.md §3.`
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
    return (
      "The checkout has commits the remote does not — this pull is --ff-only and will not " +
      `merge them on the bike. To discard them: sudo -u ${owner} git -C ${deploy.directory} ` +
      "fetch origin && sudo -u " +
      `${owner} git -C ${deploy.directory} reset --hard origin/HEAD.`
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
      "runs as root, which needs no password — if this is not root, that is the problem."
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
  const restart = spawn("sudo", ["systemctl", "restart", "--no-block", "cool-eva"], {
    detached: true,
    stdio: "ignore",
  });
  restart.on("error", err => {
    console.warn("update: could not spawn service restart:", err);
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
