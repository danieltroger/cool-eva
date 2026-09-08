import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { CAN_CAPTURE_SERVICE, CAN_CAPTURE_UNIT_PATH, canCaptureUnitText } from "./unit.ts";

// Installs the raw-CAN-capture unit. Split out of scripts/setup-service.ts, which was
// past 400 lines and had grown this second responsibility (CLAUDE.md).
//
// ⚠️ It does NOT restart a capture that is already running. Restarting is the one thing
// that punches the hole this unit exists to avoid (issue #160), and an install is exactly
// when nobody wants it — so a running instance keeps the old script until the operator
// picks a quiet moment, and the printed line says so.

export function installCanCaptureUnit(projectDir: string): void {
  const unitText = canCaptureUnitText(projectDir);
  backUpExistingUnit(unitText);
  writeFileSync(CAN_CAPTURE_UNIT_PATH, unitText);
  execSync("systemctl daemon-reload");
  console.log(`Wrote ${CAN_CAPTURE_UNIT_PATH} (raw CAN capture -> /home/pi/ride-captures)`);

  // ⚠️ Enabled only once candump is known to exist. can-utils is not a default Raspberry
  // Pi OS package, and a unit enabled without it restart-loops from the next boot — the
  // script refuses before creating a file, so the loop is empty rather than destructive,
  // but it is still a red unit nobody asked for. Say it here, where it is cheap to fix.
  if (!hasCandump()) {
    console.warn("");
    console.warn(`⚠ candump is not installed, so ${CAN_CAPTURE_SERVICE} was NOT enabled or started.`);
    console.warn("  The raw capture is the evidence base for every decode finding in docs/. To get it:");
    console.warn(`    sudo apt install can-utils && sudo systemctl enable --now ${CAN_CAPTURE_SERVICE}`);
    console.warn("");
    return;
  }
  execSync(`systemctl enable ${CAN_CAPTURE_SERVICE}`);
  if (isActive(CAN_CAPTURE_SERVICE)) {
    console.log(`  ${CAN_CAPTURE_SERVICE} is already running and was NOT restarted — it keeps the old script until`);
    console.log(`  you restart it, which costs one capture gap: sudo systemctl restart ${CAN_CAPTURE_SERVICE}`);
    return;
  }
  execSync(`systemctl start ${CAN_CAPTURE_SERVICE}`);
  console.log(`  ${CAN_CAPTURE_SERVICE} started.`);
}

/**
 * Keep the unit this replaces, once.
 *
 * ⚠️ Two guards, and both matter because re-running the installer is the documented way to
 * migrate a Pi (CLAUDE.md). Backing up unconditionally would, on the second run, copy the
 * unit we just wrote over the only surviving copy of the one it replaced — a backup that
 * destroys what it protects. And there is nothing to keep when the file already matches.
 */
function backUpExistingUnit(unitText: string): void {
  if (!existsSync(CAN_CAPTURE_UNIT_PATH)) {
    return;
  }
  const backup = `${CAN_CAPTURE_UNIT_PATH}.superseded`;
  if (existsSync(backup) || readFileSync(CAN_CAPTURE_UNIT_PATH, "utf-8") === unitText) {
    return;
  }
  copyFileSync(CAN_CAPTURE_UNIT_PATH, backup);
  console.log(`Backed up the existing capture unit to ${backup}`);
}

/** Whether candump is on PATH at all. `command -v` is what the script itself uses. */
function hasCandump(): boolean {
  try {
    execSync("command -v candump", { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch (error) {
    console.log(`  (candump not found: ${(error as Error).message.split("\n")[0]})`);
    return false;
  }
}

/** Whether systemd considers a unit active. A non-zero exit is the documented "no". */
function isActive(unit: string): boolean {
  try {
    execSync(`systemctl is-active --quiet ${unit}`);
    return true;
  } catch (error) {
    // Inactive, failed and not-installed all exit non-zero and all mean "do not skip the
    // start". Logged rather than swallowed: a systemctl that cannot run at all would
    // otherwise look identical to a stopped unit.
    console.log(`  (${unit} is not active: ${(error as Error).message.split("\n")[0]})`);
    return false;
  }
}
