import type { IncomingMessage, ServerResponse } from "http";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UpdateReply } from "../src/http/update.ts";
import {
  PULL_ARGS,
  asOwnerCommand,
  deployHint,
  describePullFailure,
  findForeignOwnedPaths,
  handleUpdateEndpoint,
  pullCommandFor,
} from "../src/http/update.ts";

// The Update button's endpoint, against a real git and no Pi.
//
//   node --experimental-strip-types scripts/check-update-endpoint.ts
//
// ⚠️ THIS CHECK MUST NEVER RESTART THE SERVICE. handleUpdateEndpoint arms the restart on
// the response's "finish" event, so a real http.ServerResponse here would spawn
// `sudo systemctl restart cool-eva` on whatever machine ran `npm test`. The fake below
// RECORDS the listener and never emits it — and §1 asserts one was armed, so "we avoided
// the restart" is a checked property rather than a hope.
//
// §6 is the one that would have saved a ride: the pull must run as the checkout's OWNER,
// because a root pull leaves root-owned files in .git and the next pull as pi fails
// silently, leaving the service restarting on stale code.
//
// The other half is what the rider is told when it fails. A pull that timed out and a
// pull that exited non-zero arrive at describePullFailure looking almost identical —
// `killed`/`signal` read the same — and the one thing that separates them is elapsed
// time, which is why it is a parameter and why this can test it without waiting 60 s.

const run = promisify(execFile);
let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

interface FakeResponse {
  res: ServerResponse;
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  finishListeners: number;
}

/**
 * A response that records instead of writing, and in particular never emits "finish".
 * `as unknown as ServerResponse` rather than an `any`, the same way
 * scripts/check-ride-log-status.ts fakes one.
 */
function fakeResponse(): FakeResponse {
  const recorded: FakeResponse = {
    res: null as unknown as ServerResponse,
    statusCode: null,
    headers: {},
    body: "",
    finishListeners: 0,
  };
  recorded.res = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      recorded.statusCode = statusCode;
      Object.assign(recorded.headers, headers ?? {});
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        recorded.body = chunk.toString();
      }
    },
    once(event: string) {
      if (event === "finish") {
        recorded.finishListeners += 1;
      }
    },
  } as unknown as ServerResponse;
  return recorded;
}

function postRequest(): IncomingMessage {
  return { method: "POST" } as unknown as IncomingMessage;
}

function parseReply(recorded: FakeResponse): UpdateReply {
  return JSON.parse(recorded.body) as UpdateReply;
}

const DEPLOY = { directory: "/home/pi/cool-eva", ownerUid: 1000 };

/** git needs an identity to commit, and CI checkouts have no global one. */
const GIT_IDENTITY = ["-c", "user.email=check@cool-eva.invalid", "-c", "user.name=cool-eva check"];

const workDir = await mkdtemp(join(tmpdir(), "cool-eva-update-check-"));

try {
  // --- 1. a real pull, through the real handler ------------------------------

  console.log("\n1. a pull that succeeds");

  const upstream = join(workDir, "upstream");
  const checkout = join(workDir, "checkout");
  // A normal repo, not a bare one: the second commit below needs a work tree.
  await run("git", ["-c", "init.defaultBranch=main", "init", upstream]);
  await writeFile(join(upstream, "README.md"), "first\n");
  await run("git", ["-C", upstream, ...GIT_IDENTITY, "add", "-A"]);
  await run("git", ["-C", upstream, ...GIT_IDENTITY, "commit", "-m", "first"]);
  await run("git", ["-c", "init.defaultBranch=main", "clone", upstream, checkout]);

  await writeFile(join(upstream, "ARRIVED.md"), "the file the pull should name\n");
  await run("git", ["-C", upstream, ...GIT_IDENTITY, "add", "-A"]);
  await run("git", ["-C", upstream, ...GIT_IDENTITY, "commit", "-m", "second"]);

  const pulled = fakeResponse();
  await handleUpdateEndpoint(postRequest(), pulled.res, checkout);
  const pulledReply = parseReply(pulled);
  check("a successful pull answers 200", pulled.statusCode === 200);
  check("and says ok", pulledReply.ok === true);
  check(
    "and the message carries git's own output, naming the file that arrived",
    pulledReply.message.includes("ARRIVED.md")
  );
  check("the restart is armed on finish — and this check never fires it", pulled.finishListeners === 1);

  // --- 2. a pull that fails ---------------------------------------------------

  console.log("\n2. a pull that fails, seen from the phone");

  await run("git", ["-C", checkout, "remote", "set-url", "origin", join(workDir, "no-repo-here")]);
  const failed = fakeResponse();
  await handleUpdateEndpoint(postRequest(), failed.res, checkout);
  const failedReply = parseReply(failed);
  check("a failed pull answers 500", failed.statusCode === 500);
  check("and says not-ok, which is what paints the note red", failedReply.ok === false);
  check("and the message is git's own words, not a bare 'failed'", /fatal:/.test(failedReply.message));
  check("so it is never only the exec wrapper's 'Command failed:'", !failedReply.message.startsWith("Command failed:"));
  check("nothing is armed to restart the service on a failure", failed.finishListeners === 0);

  // --- 3. the method guard ----------------------------------------------------

  console.log("\n3. the method guard");

  const got = fakeResponse();
  await handleUpdateEndpoint({ method: "GET" } as unknown as IncomingMessage, got.res, checkout);
  check("GET is refused with 405", got.statusCode === 405);
  check("and says what to use instead", got.headers["Allow"] === "POST");
  check("a GET never arms a restart", got.finishListeners === 0);

  // --- 4. describePullFailure, pure -------------------------------------------

  console.log("\n4. what the rider is told, per failure shape");

  // The two kills below are the SAME rejection shape — killed, SIGTERM — and differ only
  // in elapsed time. Measured on Node 24: a timeout kill carries stdout/stderr whenever
  // the command wrote any before it was stopped, so the non-empty case is real and is
  // the one an earlier draft of this endpoint would have missed.
  const timedOutQuiet = Object.assign(new Error("Command failed: git pull"), {
    killed: true,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
  });
  const quietText = describePullFailure(timedOutQuiet, 60_000, DEPLOY);
  check("a kill at the deadline with no output is named as a timeout", /Stopped after 60 s/.test(quietText));

  const timedOutNoisy = Object.assign(new Error("Command failed: git pull"), {
    killed: true,
    signal: "SIGTERM",
    stdout: "",
    stderr: "remote: Enumerating objects: 41, done.\n",
  });
  const noisyText = describePullFailure(timedOutNoisy, 61_000, DEPLOY);
  check("a kill at the deadline WITH output is also named as a timeout", /Stopped after 60 s/.test(noisyText));
  check(
    "and keeps what git managed to say — the sentence is prepended, never substituted",
    noisyText.includes("remote: Enumerating objects")
  );

  const killedEarly = Object.assign(new Error("Command failed: git pull"), {
    killed: true,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
  });
  check(
    "a kill well BEFORE the deadline is not called a timeout — that is an OOM, and a confident wrong answer is worse than none",
    !/Stopped after/.test(describePullFailure(killedEarly, 900, DEPLOY))
  );

  const plainExit = Object.assign(new Error("Command failed: git pull"), {
    killed: false,
    signal: null,
    stdout: "",
    stderr: "error: Your local changes would be overwritten.\n",
  });
  const plainText = describePullFailure(plainExit, 120, DEPLOY);
  check("an ordinary non-zero exit is not a timeout either", !/Stopped after/.test(plainText));
  check("and is reported as git wrote it", plainText.includes("would be overwritten"));

  // --- 5. the ssh hint --------------------------------------------------------

  console.log("\n5. the two ssh failures, each with its own fix");

  // ⚠️ The two have DIFFERENT fixes — one is a known_hosts entry, the other is the key
  // itself — so a hint that named one cause for both would be wrong half the time.
  const hostKey = "Host key verification failed.\nfatal: Could not read from remote repository.\n";
  const hostKeyHint = deployHint(hostKey, DEPLOY) ?? "";
  check("'Host key verification failed' is about known_hosts", /known_hosts/.test(hostKeyHint));
  check("and gives the command that fixes it", /ssh-keyscan/.test(hostKeyHint));
  // ⚠️ The redirect must happen INSIDE the owner's shell. `sudo -u pi ssh-keyscan … >>
  // /home/pi/.ssh/known_hosts` from a root shell writes a ROOT-OWNED known_hosts — the
  // same ownership bug this branch exists to fix, caused by the repair instruction.
  check("run as the owner, with the redirect inside their shell, not the caller's", /sh -c '.*>>.*'/.test(hostKeyHint));
  check("and names nobody called pi — the owner is whoever owns the checkout", !/pi/.test(hostKeyHint));
  check("and does not blame the key, which is a different failure", !/deploy key/.test(hostKeyHint));

  // OpenSSH prints the METHODS THE SERVER OFFERED, so the real string is often
  // `(publickey,password)`. Matching through the closing paren would miss every
  // multi-method server — which is most of them.
  const refused = "git@github.com: Permission denied (publickey,password).\n";
  const refusedHint = deployHint(refused, DEPLOY) ?? "";
  check("'Permission denied (publickey,password)' is matched, not just the bare (publickey)", refusedHint !== "");
  check("and is about the key, naming both ways out", /deploy key/.test(refusedHint) && /https/.test(refusedHint));
  check("and does not tell you to run ssh-keyscan, which would not help", !/ssh-keyscan/.test(refusedHint));

  // ⚠️ THE INCIDENT ITSELF, 2026-09-08. A Pi that pressed the old button is in exactly this
  // state, and after the fix the pull correctly runs as the owner and correctly fails —
  // so this is the message the phone shows on every Pi that was ever poisoned.
  const poisoned =
    "error: cannot update the ref 'refs/remotes/origin/main': unable to append to " +
    "'.git/logs/refs/remotes/origin/main': Permission denied\n";
  const poisonedHint = deployHint(poisoned, DEPLOY) ?? "";
  check("a .git poisoned by an earlier root pull is recognised", poisonedHint !== "");
  check("and names the chown that repairs it, with the owner's uid", /chown -R 1000/.test(poisonedHint));
  check("and is not mistaken for an ssh problem", !/ssh|deploy key/.test(poisonedHint));

  const httpsAuth =
    deployHint("fatal: could not read Username for 'https://github.com': No such device\n", DEPLOY) ?? "";
  check("an https remote asking for a login says the fork is private", /private/.test(httpsAuth));

  const sudoFailure = deployHint("sudo: a password is required\n", DEPLOY) ?? "";
  check("and a sudo that cannot switch user is explained rather than shown raw", /uid 1000/.test(sudoFailure));

  check(
    "an unrelated failure gets no ssh advice — a hint that fires on everything is noise",
    deployHint("fatal: couldn't find remote ref main\n", DEPLOY) === null
  );

  const carried = Object.assign(new Error("Command failed: git pull"), {
    killed: false,
    signal: null,
    stdout: "",
    stderr: hostKey,
  });
  check(
    "and the hint reaches the phone, appended to git's own words",
    /ssh-keyscan/.test(describePullFailure(carried, 300, DEPLOY))
  );

  // --- 6. WHO the pull runs as ------------------------------------------------

  console.log("\n6. the user the pull runs as");

  // ⚠️ THE REGRESSION THIS SECTION EXISTS FOR. A root pull over a pi-owned checkout
  // leaves root-owned files in .git, and the NEXT pull as pi dies on "unable to append
  // to '.git/logs/refs/remotes/origin/<branch>': Permission denied" — silently, with the
  // service restarting on the old commit. Found on the bike 2026-09-08.
  const switched = asOwnerCommand(["-C", "/home/pi/cool-eva", ...PULL_ARGS], 1000, 0);
  check("a root service pulls THROUGH sudo, never as itself", switched.command === "sudo");
  check("as the checkout's owner by uid, not a hardcoded name", switched.args.slice(0, 3).join(" ") === "-n -u #1000");
  // ⚠️ -H is for git's own ~/.gitconfig, NOT for ssh: ssh follows the effective uid, and
  // without -H sudo leaves HOME pointing at root's home. Measured both ways.
  check("with -H, so git reads the owner's config rather than root's", switched.args.includes("-H"));
  check("and sudo never waits for a password no phone can type", switched.args.includes("-n"));
  check("git is what sudo runs", switched.args[switched.args.indexOf("-H") + 1] === "git");

  // ⚠️ THE ASSERTION THAT WAS MISSING, and the reason this file exists. Everything above
  // calls asOwnerCommand() with literal uids, which passes on a build whose CALL SITE
  // hands it the wrong ones — and that one line, between the stat and the argv, IS the
  // bug from the bike. On any machine running this suite the checkout is owned by whoever
  // runs it, so §1 and §7 never take the sudo branch and cannot see it either.
  const checkoutUid = statSync(checkout).uid;
  const forRoot = await pullCommandFor(checkout, 0);
  check("the owner uid is read from the CHECKOUT, not from whoever is asking", forRoot.ownerUid === checkoutUid);
  check("so a root service goes through sudo for a checkout it does not own", forRoot.command === "sudo");
  check("naming that checkout's owner", forRoot.args.includes(`#${checkoutUid}`));
  const forOwner = await pullCommandFor(checkout, checkoutUid);
  check("and runs git directly when it already is the owner", forOwner.command === "git");

  // --- 7. --ff-only against a real divergence ---------------------------------

  console.log("\n7. a checkout that has diverged");

  await run("git", ["-C", checkout, "remote", "set-url", "origin", upstream]);
  await run("git", ["-C", checkout, ...GIT_IDENTITY, "fetch", "origin"]);
  await run("git", ["-C", checkout, ...GIT_IDENTITY, "reset", "--hard", "HEAD~1"]);
  await writeFile(join(checkout, "LOCAL.md"), "a commit the Pi made that upstream does not have\n");
  await run("git", ["-C", checkout, ...GIT_IDENTITY, "add", "-A"]);
  await run("git", ["-C", checkout, ...GIT_IDENTITY, "commit", "-m", "local divergence"]);

  const diverged = fakeResponse();
  await handleUpdateEndpoint(postRequest(), diverged.res, checkout);
  const divergedReply = parseReply(diverged);
  check("a diverged checkout is refused rather than merged", diverged.statusCode === 500);
  check("and says so in git's words", /Not possible to fast-forward|diverg/i.test(divergedReply.message));
  check("and does not restart the service on code it did not pull", diverged.finishListeners === 0);
  check(
    "and tells the rider how to get out of it, since this repo force-pushes branches",
    /reset --hard/.test(divergedReply.message)
  );
  // ⚠️ origin/HEAD is pinned at clone time to the DEFAULT branch. A Pi parked on a test
  // branch (CLAUDE.md documents doing that) would have its tree replaced with main's.
  check("naming the tracked branch, not origin/HEAD", /@\{u\}/.test(divergedReply.message));
  check("and never origin/HEAD, which is a different branch", !/origin\/HEAD/.test(divergedReply.message));

  // --- 8. what a root pull actually leaves behind -----------------------------

  console.log("\n8. finding a checkout an earlier root pull poisoned");

  // ⚠️ THE ASSERTION THE FIRST VERSION OF THIS PROBE FAILED. A pull neither creates nor
  // rewrites .git or .git/logs/refs — verified by inode — so they keep the CLONER's
  // ownership however the pull ran, and sampling them finds nothing. What a root pull
  // creates is the leaf: .git/logs/refs/remotes/origin/<branch>, exactly the path the
  // Pi's error named.
  const gitDir = join(checkout, ".git");
  const ownUid = statSync(checkout).uid;
  const leaf = join(gitDir, "logs", "refs", "remotes", "origin", "main");
  const refRoots = [join(gitDir, "logs"), join(gitDir, "refs")];
  check("the leaf a pull creates is really there to be checked", existsSync(leaf));
  check("a correctly-owned checkout reports nothing", (await findForeignOwnedPaths(refRoots, ownUid)).length === 0);
  // Everything is "foreign" to a uid nobody owns, so this proves the walk REACHES the
  // leaf rather than stopping at the parents the old version sampled.
  const foreign = await findForeignOwnedPaths(refRoots, ownUid + 1, 50);
  check(
    "and a poisoned one is found by walking to the leaves",
    foreign.some(entry => entry.path === leaf)
  );
  check(
    "reporting who owns each",
    foreign.every(entry => entry.uid === ownUid)
  );
  check(
    "a missing path is skipped, not thrown — FETCH_HEAD before the first fetch",
    (await findForeignOwnedPaths([join(gitDir, "no-such-file")], ownUid + 1)).length === 0
  );
  check(
    "and the report is capped, since the repair is the same at 3 files or 3000",
    (await findForeignOwnedPaths(refRoots, ownUid + 1, 2)).length === 2
  );
} finally {
  await rm(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll update-endpoint checks passed.");
