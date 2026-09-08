import type { IncomingMessage, ServerResponse } from "http";
import { execFile, spawn } from "child_process";
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
// Run with -c safe.directory so a root service (systemd) is not refused by git's
// dubious-ownership check over a pi-owned checkout. ⚠️ Files git rewrites then become
// root-owned; a later by-hand pull as `pi` may want its own safe.directory or a chown.
// Deploying only through this button keeps ownership consistent.
//
// This service runs as root, so pi's ssh setup is not automatically in reach: OpenSSH
// expands ~ from the effective uid's passwd entry, not from $HOME, which is why the
// HOME=/home/pi this used to carry did nothing. A public fork pulls over https and needs
// no credentials at all; a private one keeps its ssh remote and DEPLOY_SSH_COMMAND names
// pi's key and known_hosts explicitly, which is what HOME= was pretending to do.
// INSTALL.md §3 has both paths; credentialHint says it to whoever hits it.

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

/**
 * How early a kill may arrive and still be counted as the timeout. `since()` reads
 * performance.now() while exec's deadline is a libuv timer, so the two disagree by a
 * hair at the boundary — the margin is for that skew, not for slop. What a zero-margin
 * comparison between two clocks does under load is on the record in
 * scripts/check-fan-endpoint.ts §3.
 */
const TIMEOUT_SKEW_MS = 250;

/**
 * How the pull reaches an SSH remote — for a PRIVATE fork; a public one pulls over https
 * and never invokes ssh at all, so this is inert there.
 *
 * Naming the key and the known_hosts file is the only thing that redirects a root git to
 * pi's credentials, since $HOME cannot (see the header). IdentitiesOnly so a root agent
 * or a stray /root/.ssh key cannot be offered ahead of this one, and BatchMode so an
 * encrypted key fails immediately instead of sitting on an askpass prompt nobody can
 * answer until PULL_TIMEOUT_MS.
 *
 * Overridable: set GIT_SSH_COMMAND in /etc/default/cool-eva for another user, key path
 * or key type, and pullEnvironment leaves it alone.
 */
export const DEPLOY_SSH_COMMAND =
  "ssh -i /home/pi/.ssh/id_ed25519 -o IdentitiesOnly=yes " +
  "-o UserKnownHostsFile=/home/pi/.ssh/known_hosts -o BatchMode=yes";

/**
 * The environment the deploy pull runs in, and the same one setup-service.ts verifies the
 * remote with — so what the installer proves is what the button will do.
 *
 * ⚠️ Spreading the caller's environment is load-bearing: without it git loses PATH and
 * cannot exec git-remote-https at all. GIT_TERMINAL_PROMPT=0 turns a remote that wants
 * credentials into git's own "terminal prompts disabled" rather than its attempt to open
 * /dev/tty, which a systemd service does not have.
 */
export function pullEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: environment.GIT_SSH_COMMAND ?? DEPLOY_SSH_COMMAND,
  };
}

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
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", directory, "-c", `safe.directory=${directory}`, "pull"],
      {
        timeout: PULL_TIMEOUT_MS,
        env: pullEnvironment(process.env),
      }
    );
    const output = `${stdout}${stderr}`.trim();
    console.log(`update: git pull in ${directory}:\n${output}`);
    const summary = output || "Already up to date.";
    respond(res, 200, { ok: true, message: `${summary}\n\nRestarting cool-eva…` });
    // The restart kills this process, so wait for the reply to leave the socket first.
    res.once("finish", scheduleServiceRestart);
  } catch (err) {
    // A non-zero git exit (merge conflict, no network, detached head) lands here with
    // its output carried on the error; surface that rather than a bare "failed".
    const detail = describePullFailure(err, since(startedAt));
    console.warn(`update: git pull in ${directory} failed:\n${detail}`);
    respond(res, 500, { ok: false, message: detail });
  }
}

/**
 * What the rider is shown when the pull failed, git's own output included.
 *
 * Pure, and elapsed time arrives as an argument rather than off a clock, so the timeout
 * case is checkable without waiting a minute for it (scripts/check-update-endpoint.ts).
 */
export function describePullFailure(err: unknown, elapsedMs: number): string {
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
  const hint = credentialHint(streams);
  if (hint) {
    lines.push(hint);
  }
  return lines.join("\n\n");
}

/**
 * A kill at or past the deadline is exec's own timer firing — once it has elapsed there
 * is no other explanation. A kill BEFORE it is something else (an OOM on a Pi Zero is
 * the likely one) and must not be called a timeout. Elapsed time is the only thing that
 * separates the two: `killed` and `signal` read identically either way.
 */
function wasKilledByTimeout(failure: { killed?: boolean; signal?: string | null }, elapsedMs: number): boolean {
  const killed = failure.killed === true || typeof failure.signal === "string";
  return killed && elapsedMs >= PULL_TIMEOUT_MS - TIMEOUT_SKEW_MS;
}

/**
 * The two ssh failures this deploy path actually produces, each with its own fix — a hint
 * that named one cause for both would be wrong half the time. Shared with
 * scripts/setup-service.ts so the installer and the button give the same advice.
 *
 * ⚠️ Matched on OpenSSH's words rather than git's: OpenSSH ships no NLS at all, so these
 * are byte-identical under every locale, while git has a full message catalog and its
 * `fatal:` lines move with LC_ALL. The method list in `Permission denied (publickey,
 * password)` varies with what the server offered, so the match stops before it.
 */
export function credentialHint(streams: string): string | null {
  if (/Host key verification failed/.test(streams)) {
    return (
      "github.com is not in the known_hosts the pull reads (by default pi's, since this " +
      "runs as root): sudo -u pi ssh-keyscan github.com >> /home/pi/.ssh/known_hosts. " +
      "See INSTALL.md §3."
    );
  }
  if (/Permission denied \(publickey/.test(streams)) {
    return (
      "The deploy key was refused (by default /home/pi/.ssh/id_ed25519): add it as a " +
      "deploy key on the fork, or set GIT_SSH_COMMAND in /etc/default/cool-eva to point " +
      "at another key. A public fork can use an https remote and skip keys entirely. " +
      "See INSTALL.md §3."
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
