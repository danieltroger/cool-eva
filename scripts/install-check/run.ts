import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { generateKeyPair } from "node:crypto";
import { runCommand } from "../release/commands.ts";
import { readBundleInputs } from "../release/inputs.ts";
import { serveBundle } from "./assets.ts";
import { prepareImage } from "./prepare-image.ts";
import { createGuestDisk, extractPiBootFiles } from "./image.ts";
import { prepareQemuDeviceTree } from "./device-tree.ts";
import { bootGuest, seedGuest } from "./boot.ts";
import { guestSeed } from "./seed.ts";
import { runInstaller, sshCommand, waitForSsh } from "./ssh.ts";
import type { GuestConsole } from "./console.ts";
import { verifyEncryptedFixture } from "./encryption.ts";
import { hashFile } from "../release/files.ts";
import { interruptSshDuringApt } from "./interrupt.ts";
import { verifyUpdaterRecovery } from "./recovery.ts";
import { verifyLegacyMigration } from "./legacy.ts";
import { captureGuestInspection, verifyGuestDiagnostics } from "./inspection.ts";
import { setTimeout as delay } from "node:timers/promises";

export async function checkInstallerInQemu(
  bundle: string,
  directory: string,
  executable: string,
  cache: string
): Promise<void> {
  await mkdir(directory, { recursive: false });
  const inputs = await readBundleInputs(process.cwd());
  const archiveSha256 = await hashFile(join(bundle, "bundle.tar.zst"));
  const metadata = JSON.parse(await readFile(join(bundle, "release.json"), "utf8")) as {
    release: string;
    testedImage: { sha256: string };
  };
  assert.equal(metadata.testedImage.sha256, inputs.testedImage.sha256);
  const image = await prepareImage(cache, inputs.testedImage);
  await createGuestDisk(image, join(directory, "guest.img"));
  const boot = join(directory, "boot");
  await extractPiBootFiles(image, boot);
  await prepareQemuDeviceTree(join(boot, "board.dtb"), join(boot, "qemu.dtb"));
  await runCommand(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "cool-eva-qemu", "-f", join(directory, "ssh-key")],
    {
      cwd: process.cwd(),
    }
  );
  const publicSsh = await readFile(join(directory, "ssh-key.pub"), "utf8");
  const port = await freePort();
  const guest = { key: join(directory, "ssh-key"), knownHosts: join(directory, "known-hosts"), port };
  await writeFile(join(directory, "guest-ssh.json"), JSON.stringify(guest), { mode: 0o600 });
  const assets = await serveBundle(bundle);
  let console_: GuestConsole | null = null;
  try {
    console.log(
      "Booting the pinned Lite image under QEMU raspi3ap (512 MiB, four A53 cores). No bike/radios are attached."
    );
    console_ = bootGuest(executable, directory, port, "seed");
    await seedGuest(console_, guestSeed(publicSsh, assets.port, `cool-eva-${metadata.release}`));
    await waitForSsh(guest);
    await verifyGuestDiagnostics(guest, "first SSH login", sshCommand);
    const pair = await promisify(generateKeyPair)("x25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    console.log(
      "Running the actual released installer over SSH: bench confirmation, apt catch-up, networks, public key, units and health checks."
    );
    await interruptSshDuringApt(guest, join(directory, "interrupted-ssh.log"));
    const result = await runInstaller(guest, publicKey, join(directory, "install.log"));
    assert.match(result, /Encrypted ride recording ready/);
    await verifyNoRuntimeFaults(guest);
    console.log("Fresh install passed. Verifying permissions, updater, real NetworkManager and security policy.");
    await sshCommand(
      guest,
      'sudo sh -eu -c \'test -e /etc/cool-eva-qemu-fixture; apt-mark showmanual | grep -qx jq; systemctl is-active --quiet cool-eva; grep -azq -- --no-wasm-lazy-compilation /proc/"$(systemctl show cool-eva --property=MainPID --value)"/cmdline; systemctl is-enabled --quiet cool-eva; test -x /usr/local/libexec/cool-eva-update; test ! -e /etc/systemd/system/can-capture.service; test "$(stat -c %a /var/lib/cool-eva/state/settings.json)" = 600; test "$(stat -c %a /var/lib/cool-eva/updater/state.json)" = 600; test "$(stat -c %a /etc/NetworkManager/system-connections/cool-eva-hotspot.nmconnection)" = 600; /usr/bin/curl -fsS http://127.0.0.1/os-update-ready | jq -e .ok==false; nmcli connection show\'',
      90_000
    );
    await verifyUpdaterRecovery(guest);
    const packageList = await sshCommand(guest, "dpkg-query -W '-f=${binary:Package}\\t${Version}\\n'");
    await writeFile(join(directory, "installed-os-packages.txt"), packageList);
    console.log("Rerunning the same line; existing network profiles and public key must survive.");
    await verifyGuestDiagnostics(guest, "before rerun", sshCommand);
    await captureGuestInspection(guest, join(directory, "before-rerun.inspection.log"), sshCommand);
    await runInstaller(guest, publicKey, join(directory, "rerun.log"), "rerun");
    await verifyGuestDiagnostics(guest, "after rerun", sshCommand);
    await verifyNoRuntimeFaults(guest);
    await verifyEncryptedFixture(guest, pair.privateKey, pair.publicKey);
    await sshCommand(guest, "sudo sync");
    try {
      await sshCommand(guest, "sudo systemctl poweroff", 30_000);
    } catch (error) {
      console.log("Guest poweroff closed SSH:", error instanceof Error ? error.name : "connection closed");
    }
    await console_.wait(/Power down|systemd-shutdown.*(unmount|detach)|Kernel panic/, 90_000);
    await console_.stop();
    await extractPiBootFiles(join(directory, "guest.img"), boot);
    await prepareQemuDeviceTree(join(boot, "board.dtb"), join(boot, "qemu.dtb"));
    console_ = bootGuest(executable, directory, port, null);
    await waitForSsh(guest);
    await waitForApp(guest, metadata.release);
    await verifyNoRuntimeFaults(guest);
    await verifyLegacyMigration(guest, directory, publicKey);
    await verifyNoRuntimeFaults(guest);
    await verifyAccessoryFiles(guest);
    assert.equal(
      await hashFile(join(bundle, "bundle.tar.zst")),
      archiveSha256,
      "Served archive changed during the gate"
    );
    await writeFile(
      join(directory, "qemu-receipt.txt"),
      `Pinned image ${inputs.testedImage.url}\nsha256 ${inputs.testedImage.sha256}\nRelease ${metadata.release}\nSSH killed during apt, detached job completion, resumed fresh install, hidden passwords, public key, native preflight, persistent profiles, settings permissions, updater recovery, rerun and reboot: passed.\nNo CAN/BLE/GPIO/SPI/PWM/Wi-Fi association/firmware boot/SD power-cut claim.\n`
    );
    await writeFile(
      join(directory, "qemu-result.json"),
      JSON.stringify({
        ok: true,
        release: metadata.release,
        archiveSha256,
        testedImage: inputs.testedImage,
        machine: "raspi3ap",
        qemu: "11.1.3",
      }) + "\n"
    );
    console.log("QEMU installer check passed (fresh, rerun, reboot). Receipt:", join(directory, "qemu-receipt.txt"));
  } catch (error) {
    await captureGuestInspection(guest, join(directory, "failure.inspection.log"), sshCommand);
    const pause = Number(process.env.COOL_EVA_QEMU_PAUSE_ON_FAILURE_SECONDS ?? "0");
    if (Number.isInteger(pause) && pause > 0 && pause <= 900) {
      console.error(`Local inspection pause: guest remains live for ${pause} seconds; see guest-ssh.json.`);
      await delay(pause * 1000);
    }
    throw error;
  } finally {
    await console_?.stop();
    await assets.close();
  }
}

async function verifyNoRuntimeFaults(guest: { key: string; knownHosts: string; port: number }): Promise<void> {
  const restarts = await sshCommand(guest, "systemctl show cool-eva.service --property=NRestarts --value");
  assert.equal(restarts.trim(), "0", "Automatic app restarts must not hide a runtime fault in the installer gate");
  const kernel = await sshCommand(guest, "sudo dmesg");
  const faults = kernel.split("\n").filter(line => /\bnode:.*fatal signal/.test(line));
  assert.deepEqual(faults, [], "A Node fatal signal fails the gate without retry");
}

export async function verifyAccessoryFiles(guest: { key: string; knownHosts: string; port: number }): Promise<void> {
  const program = `import {readFile} from 'node:fs/promises'; import {configureAccessories} from './src/install/accessories.ts';
const settings=JSON.parse(await readFile('/var/lib/cool-eva/state/settings.json','utf8')).values;
settings.coolantProbesEnabled=true;settings.radiatorFanEnabled=true;
if(!await configureAccessories(settings)){throw new Error('Missing reboot preparation');}
const config=await readFile('/boot/firmware/cool-eva-accessories.txt','utf8');
for(const line of ['dtparam=spi=on','gpio=17,op,dl','gpio=27,op,dl','dtoverlay=pwm,pin=18,func=2']){if(!config.includes(line+'\\n')){throw new Error('Missing accessory boot line');}}
const unit=await readFile('/etc/systemd/system/cool-eva-install-finish.service','utf8');
if(!unit.includes('runtime/bin/node --no-wasm-lazy-compilation --experimental-strip-types')){throw new Error('Post-boot Node omitted the Wasm guard');}
console.log('Accessory boot-file writes passed; physical SPI/PWM/GPIO remain untested.');`;
  await sshCommand(
    guest,
    `cd /opt/cool-eva/current && printf '%s' '${Buffer.from(program).toString("base64")}' | base64 -d | sudo runtime/bin/node --no-wasm-lazy-compilation --experimental-strip-types --input-type=module`,
    90_000
  );
}

export async function waitForApp(
  guest: { key: string; knownHosts: string; port: number },
  release: string
): Promise<void> {
  const program = `import {checkInstalledApp} from './src/install/health.ts'; await checkInstalledApp(${JSON.stringify(release)}); console.log('Service healthy after reboot.');`;
  await sshCommand(
    guest,
    `cd /opt/cool-eva/current && printf '%s' '${Buffer.from(program).toString("base64")}' | base64 -d | sudo runtime/bin/node --no-wasm-lazy-compilation --experimental-strip-types --input-type=module`,
    240_000
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No available VM SSH port");
  }
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bundle, directory, executable, cache] = process.argv.slice(2);
  if (!bundle || !directory || !executable || !cache) {
    throw new Error("Usage: run.ts BUNDLE_DIR NEW_GUEST_DIR QEMU_BINARY IMAGE_CACHE");
  }
  await checkInstallerInQemu(resolve(bundle), resolve(directory), resolve(executable), resolve(cache));
}
