import { execFileSync, execSync } from "child_process";
import { PULL_ARGS, asOwnerCommand, deployHint, findForeignOwnedPaths } from "../src/http/update.ts";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

// Installs the systemd unit that runs the telemetry app on the Pi.
//
// This is also the last place to catch the two setup mistakes that otherwise only
// show up hours later, and quietly: a Node too old to run TypeScript directly (the
// unit then restart-loops forever on `bad option: --experimental-strip-types`, with
// nothing on the dashboard to say why), and a missing ride-log public key (the
// dashboard works perfectly and not one reading is persisted). Both are cheap to
// check here and expensive to discover on the road.

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..");

const SERVICE_NAME = "cool-eva";

/**
 * What the unit was called before 2026-08. An install predating the rename leaves it
 * behind, still enabled — and two copies of this app fight over port 80 and over
 * can0, which the second one loses in a way that looks like a dead CAN adapter.
 */
const LEGACY_SERVICE_NAME = "thermometer";

/**
 * The release where `--experimental-strip-types` appeared. Nothing in src/ or
 * scripts/ uses a TypeScript construct that needs transforming rather than erasing
 * (no enums, no namespaces, no parameter properties), so erasure alone is enough and
 * this really is the floor. 24 is what CI and the bike run, and what the README asks
 * for; between the two the app runs but is untested.
 */
const MINIMUM_NODE = { major: 22, minor: 6 };

const RIDE_LOG_PUBLIC_KEY = join(projectDir, "ride-log-key.public.pem");

/**
 * Where the service's environment lives, and deliberately NOT the unit file.
 *
 * This script rewrites the unit every time it runs — which is the advertised way to
 * migrate an existing Pi, and the natural thing to do after a Node upgrade. Anything
 * configured inside the unit would be silently discarded by that, taking
 * COOLANT_ENABLED=0 and CUSTOM_BMS_CONFIG=1 with it; the second one changes what
 * 0x200's temperature bytes are taken to mean, so losing it quietly is the worst
 * kind of regression. The `-` prefix on EnvironmentFile makes a missing file fine,
 * so a fresh install needs nothing here.
 */
const ENV_FILE = "/etc/default/cool-eva";

/**
 * How long to spend proving the remote is readable. Short on purpose: a Pi with no
 * reception is the common case, and this is advisory — the service is already running by
 * the time it fires.
 */
const LS_REMOTE_TIMEOUT_MS = 10_000;

// `process.execPath`, NOT `which node`: under sudo the PATH is root's, so a Node
// installed with nvm as the pi user is not on it at all ("sudo: node: command not
// found"), and where a system Node also exists `which` silently picks that older one
// and bakes it into ExecStart. execPath is the binary already running this script,
// which is by definition one that can strip types.
const nodePath = process.execPath;

requireSupportedNode();

if (process.getuid?.() !== 0) {
  console.error(`Must run as root: sudo ${nodePath} --experimental-strip-types scripts/setup-service.ts`);
  process.exit(1);
}

removeLegacyService();

// bluetooth.service must be up before we try to reach the Connectivity Hub over
// BLE. The app additionally clears the rfkill soft block itself at startup (see
// src/ble/adapter.ts), so installs predating this still recover.
const unit = `[Unit]
Description=Cool Eva — Energica telemetry
After=network.target bluetooth.service
Wants=bluetooth.service

[Service]
Type=simple
WorkingDirectory=${projectDir}
EnvironmentFile=-${ENV_FILE}
ExecStart=${nodePath} --experimental-strip-types ${projectDir}/src/index.ts
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;

const servicePath = `/etc/systemd/system/${SERVICE_NAME}.service`;

writeFileSync(servicePath, unit);
console.log(`Wrote ${servicePath} (node: ${nodePath})`);

execSync("systemctl daemon-reload");
execSync(`systemctl enable ${SERVICE_NAME}`);
execSync(`systemctl restart ${SERVICE_NAME}`);

console.log("Service installed, enabled at boot, and started.");
console.log("");
console.log(`  sudo systemctl status ${SERVICE_NAME}   — check status`);
console.log(`  sudo journalctl -u ${SERVICE_NAME} -f   — follow logs`);
console.log(`  sudo systemctl stop ${SERVICE_NAME}     — stop`);
console.log(`  sudo systemctl disable ${SERVICE_NAME}  — remove from boot`);
console.log(`  sudo nano ${ENV_FILE}                   — set COOLANT_ENABLED=0 and friends`);

warnIfNodeIsUserWritable();
warnIfNoRideLogKey();
// Local and offline, so it runs unconditionally — the poisoned-.git warning is the one
// this exists for, and a garage Pi usually fails the network check below.
await warnIfGitIsWronglyOwned();
warnIfRemoteUnreadable();

/**
 * Refuse to install a unit that cannot start. Without this the only symptom is
 * `systemctl status` showing a restart loop, and the message it loops on names a
 * flag rather than a Node version.
 */
function requireSupportedNode(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor)) {
    return;
  }
  console.error(`This needs Node ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer — you have ${process.version}.`);
  console.error("");
  console.error("The app is TypeScript run directly, via --experimental-strip-types, which older");
  console.error("Node does not have. Raspberry Pi OS's apt `nodejs` is far too old for this.");
  console.error(
    `Install Node 24 — what this is tested on, though anything from ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} runs. ` +
      "See the README's Setup section, then run this again."
  );
  process.exit(1);
}

/** Stop, disable and delete the pre-rename unit, so it cannot come back at boot. */
function removeLegacyService(): void {
  const legacyPath = `/etc/systemd/system/${LEGACY_SERVICE_NAME}.service`;
  if (!existsSync(legacyPath)) {
    return;
  }
  console.log(`Found the old ${LEGACY_SERVICE_NAME} service — removing it so the two cannot both run.`);
  try {
    execSync(`systemctl stop ${LEGACY_SERVICE_NAME}`, { stdio: "ignore" });
  } catch (error) {
    // Fatal, unlike the disable below. Deleting the unit file while the old process
    // is still up leaves it holding port 80 and can0 with no name left to stop it
    // by — and `systemctl restart` on a Type=simple unit returns 0 the moment the
    // new process forks, so this script would print success over a bind-failure
    // restart loop that looks for all the world like a dead CAN adapter.
    console.error(`Could not stop the old ${LEGACY_SERVICE_NAME} service: ${(error as Error).message}`);
    console.error(`Stop it by hand (sudo systemctl stop ${LEGACY_SERVICE_NAME}), then run this again.`);
    process.exit(1);
  }
  try {
    execSync(`systemctl disable ${LEGACY_SERVICE_NAME}`, { stdio: "ignore" });
  } catch (error) {
    // Genuinely harmless — it was installed but never enabled at boot. Said out loud
    // anyway rather than swallowed.
    console.log(`  \`systemctl disable\` failed (probably never enabled): ${(error as Error).message}`);
  }
  unlinkSync(legacyPath);
  execSync("systemctl daemon-reload");
}

/**
 * The service persists nothing without a public key — it says so loudly in its own
 * log, but nobody reads journalctl on a first install. Say it here, with the two
 * commands already filled in, at the moment it can still be acted on.
 *
 * The keypair is deliberately NOT generated here. The whole point of the sealed log
 * is that the bike holds a public key only, so a stolen SD card is worthless; a Pi
 * that generated the pair would have had the private half on that card, and "only
 * briefly" is not a promise anyone can keep about flash storage.
 */
function warnIfNoRideLogKey(): void {
  // The same path the service will resolve (src/index.ts), env file included —
  // otherwise someone who keeps the key off the repo directory, which is a sensible
  // thing to do given that directory gets `git pull`ed, is told nothing is being
  // saved while logging works fine. A banner that is wrong sometimes is a banner
  // people learn to scroll past.
  const configuredKey = readEnvFile()["RIDE_LOG_PUBKEY"] ?? process.env.RIDE_LOG_PUBKEY ?? RIDE_LOG_PUBLIC_KEY;
  if (existsSync(configuredKey)) {
    console.log(`ride-log: sealing key found at ${configuredKey}`);
    return;
  }
  const hostname = readHostname();
  console.log("");
  console.log("=".repeat(72));
  console.log("NO RIDE-LOG KEY YET — the dashboard will work and NOTHING will be saved.");
  console.log("");
  console.log("Generate the pair on your laptop (never on the Pi) and copy the public");
  console.log("half over. Back the private half up first: it is the only thing that can");
  console.log("ever read your logs, and there is no recovery path.");
  console.log("");
  console.log("  node --experimental-strip-types scripts/generate-log-key.ts");
  console.log(`  scp ride-log-key.public.pem ${process.env.SUDO_USER ?? "pi"}@${hostname}:${projectDir}/`);
  console.log(`  ssh ${process.env.SUDO_USER ?? "pi"}@${hostname} 'sudo systemctl restart ${SERVICE_NAME}'`);
  console.log("=".repeat(72));
}

/**
 * The `KEY=value` pairs systemd will hand the service, so this script sees the same
 * configuration the unit does. Deliberately minimal — systemd's own parser handles
 * quoting and line continuations that nothing here needs to set.
 */
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) {
    return values;
  }
  try {
    for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && !line.trimStart().startsWith("#")) {
        values[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (error) {
    console.log(`(could not read ${ENV_FILE}: ${(error as Error).message})`);
  }
  return values;
}

/**
 * Prove the Update button will be able to pull, at the one moment someone is sitting in
 * front of the Pi to fix it — rather than months later, in a garage, from a phone.
 *
 * Run exactly as the button will: as the checkout's OWNER, via the same asOwnerCommand()
 * the endpoint uses. That is what makes this a proof rather than an approximation — root
 * can reach remotes the owner cannot (and leaves root-owned files in .git when it pulls,
 * which is the bug this whole path exists to prevent).
 *
 * The remote's scheme is deliberately not the test. https and ssh are both correct
 * (INSTALL.md §3); the only question is whether origin is readable as that user.
 */
function warnIfRemoteUnreadable(): void {
  const ownerUid = statSync(projectDir).uid;
  const currentUid = process.getuid?.() ?? ownerUid;
  let remoteUrl: string;
  try {
    const { command, args } = asOwnerCommand(["-C", projectDir, "remote", "get-url", "origin"], ownerUid, currentUid);
    remoteUrl = execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (error) {
    // A checkout with no `origin` exits non-zero too, and that must not fail an install
    // that has already written the unit and started the service.
    console.log(`(could not read this checkout's origin: ${(error as Error).message})`);
    return;
  }
  try {
    const { command, args } = asOwnerCommand(
      ["-C", projectDir, "ls-remote", "--exit-code", "origin", "HEAD"],
      ownerUid,
      currentUid
    );
    execFileSync(command, args, { timeout: LS_REMOTE_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe"] });
    // ⚠️ Readable, and nothing more: ls-remote writes nothing into .git, so it cannot tell
    // you the pull will succeed. warnIfGitIsWronglyOwned covers the other half.
    console.log(`deploy: ${remoteUrl} is readable as the checkout's owner (uid ${ownerUid})`);
  } catch (error) {
    reportUnreadableRemote(remoteUrl, error as Error & { stderr?: Buffer | string }, ownerUid);
  }
}

/**
 * Split a real failure from "this Pi is simply offline", because the second is the NORMAL
 * case here — CLAUDE.md: there is no reception in the garage, and re-running this script is
 * the documented way to migrate a Pi. A warning that shouts on every offline install is one
 * people learn to scroll past.
 *
 * ⚠️ Quiet is the default side of that split, so it must not become a catch-all: anything
 * deployHint() recognises — a refused key, an unknown host, a sudo that cannot switch user,
 * an https remote asking for a login — is a real failure in an offline costume, and is said
 * out loud.
 */
function reportUnreadableRemote(
  remoteUrl: string,
  error: Error & { stderr?: Buffer | string },
  ownerUid: number
): void {
  const stderr = (error.stderr ?? "").toString().trim();
  const hint = deployHint(stderr, { directory: projectDir, ownerUid });
  if (!hint) {
    console.log("");
    console.log(`(could not verify ${remoteUrl} as the checkout's owner — expected if this Pi is offline.`);
    console.log(` git said: ${stderr.split("\n")[0] || error.message})`);
    return;
  }
  console.warn("");
  console.warn(`\u26a0 The Update button (git ${PULL_ARGS.join(" ")}) will NOT be able to pull from ${remoteUrl}.`);
  console.warn(`  ${stderr.split("\n")[0]}`);
  console.warn("");
  console.warn(`  ${hint}`);
  console.warn("");
}

/**
 * The state an earlier root pull leaves behind: an owner-owned worktree whose .git belongs
 * to root, so the pull fails writing nothing and the service restarts on the old commit
 * with a healthy-looking journal. docs/deploy.md §"What went wrong".
 *
 * This is the one moment someone is standing in front of the Pi, and it is offline, so
 * unlike the ls-remote check it runs on a garage Pi.
 */
async function warnIfGitIsWronglyOwned(): Promise<void> {
  const ownerUid = statSync(projectDir).uid;
  const gitPath = join(projectDir, ".git");
  // logs/ and refs/ are where a pull writes, and both are small. NOT objects/, and not
  // .git itself: a pull never rewrites those, so they always look innocent.
  const offenders = await findForeignOwnedPaths(
    [join(gitPath, "logs"), join(gitPath, "refs"), join(gitPath, "FETCH_HEAD")],
    ownerUid
  );
  if (offenders.length === 0) {
    return;
  }
  console.warn("");
  console.warn(`\u26a0 Files under ${gitPath} are not owned by the checkout's owner (uid ${ownerUid}).`);
  console.warn("  Something ran `sudo git pull` here. The Update button pulls as the owner, so it");
  console.warn("  cannot write refs — the pull silently does nothing and the service restarts on");
  console.warn("  the OLD commit, with a healthy-looking journal.");
  for (const offender of offenders) {
    console.warn(`    ${offender.path} is owned by uid ${offender.uid}`);
  }
  console.warn(`  Repair: sudo chown -R ${ownerUid} ${projectDir}`);
  console.warn("");
}

/**
 * A root-run unit executing a binary out of a user-writable directory means anything
 * that can write as that user gets root at the next boot. nvm installs exactly there,
 * and nvm is the likeliest way someone gets a new enough Node — so say so rather than
 * quietly baking it into ExecStart.
 */
function warnIfNodeIsUserWritable(): void {
  if (!/^\/(usr|opt|bin|sbin)\//.test(nodePath)) {
    console.warn("");
    console.warn(`⚠ ${nodePath} is outside a root-owned prefix (nvm, or a home directory).`);
    console.warn("  This unit runs as root, so anyone who can write there gains root at the next boot.");
    console.warn("  Prefer a system-wide install: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -");
    console.warn("");
  }
}

/** The Pi's own name, so the scp line above is copy-pasteable rather than a template. */
function readHostname(): string {
  try {
    return `${execSync("hostname").toString().trim()}.local`;
  } catch (error) {
    console.log(`(could not read hostname: ${(error as Error).message})`);
    return "cool-eva.local";
  }
}
