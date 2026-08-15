import { execSync } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
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

warnIfNoRideLogKey();

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
  console.error("Install Node 24 (see the README's Setup section), then run this again.");
  process.exit(1);
}

/** Stop, disable and delete the pre-rename unit, so it cannot come back at boot. */
function removeLegacyService(): void {
  const legacyPath = `/etc/systemd/system/${LEGACY_SERVICE_NAME}.service`;
  if (!existsSync(legacyPath)) {
    return;
  }
  console.log(`Found the old ${LEGACY_SERVICE_NAME} service — removing it so the two cannot both run.`);
  for (const command of [`systemctl stop ${LEGACY_SERVICE_NAME}`, `systemctl disable ${LEGACY_SERVICE_NAME}`]) {
    try {
      execSync(command, { stdio: "ignore" });
    } catch (error) {
      // Already stopped, or never enabled. Worth a line either way: if it is still
      // running after this, the new unit will not get port 80 and the reason needs
      // to be visible here rather than inferred from a bind error at 2 am.
      console.log(`  \`${command}\` failed (probably already done): ${(error as Error).message}`);
    }
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
  if (existsSync(RIDE_LOG_PUBLIC_KEY)) {
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

/** The Pi's own name, so the scp line above is copy-pasteable rather than a template. */
function readHostname(): string {
  try {
    return `${execSync("hostname").toString().trim()}.local`;
  } catch (error) {
    console.log(`(could not read hostname: ${(error as Error).message})`);
    return "cool-eva.local";
  }
}
