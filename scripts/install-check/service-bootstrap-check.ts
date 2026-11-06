import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServiceControlFixture } from "./service-control-fixture.ts";
import { createUpdateFixture, fixtureEnvironment, REPOSITORY } from "../update-check/fixture.ts";
import { printInstallationFailure, ServiceRecoveryError, ServiceRestoredError } from "../../src/install/errors.ts";

export async function checkServiceBootstrap(directory: string, only?: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const savedPath = process.env.PATH;
  const savedFixture = process.env.INSTALL_SERVICE_FIXTURE;
  const savedUpdate = process.env.UPDATE_FIXTURE;
  let selected = 0;
  try {
    for (const variant of [
      "fresh",
      "legacy",
      "fresh-failure",
      "existing-failure",
      "restore-failure",
      "thermometer-failure",
    ]) {
      if (only && only !== variant) continue;
      selected++;
      const root = join(directory, variant);
      await mkdir(root);
      const update = await createUpdateFixture(root);
      await createServiceControlFixture(root);
      const fresh = variant.startsWith("fresh");
      const missingState = fresh || variant === "legacy";
      if (missingState) {
        await rm(update.state);
      }
      if (fresh) {
        await rm(join(update.code, "updater"), { recursive: true });
      }
      if (fresh || variant === "thermometer-failure") {
        await writeFile(join(root, "no-unit"), "");
      }
      await writeFile(join(root, "state"), fresh ? "inactive" : "active");
      await writeFile(join(root, "require-updater"), "");
      await writeFile(join(root, "bootstrap-helper"), join(update.code, "updater/current/run.sh"));
      await writeFile(join(root, "bootstrap-state"), update.state);
      if (variant.includes("failure")) {
        await writeFile(join(root, "bootstrap-fails"), "");
      }
      if (variant === "restore-failure") {
        await writeFile(join(root, "fail-start"), "");
      }
      process.env.PATH = `${join(root, "bin")}:${fixtureEnvironment(update).PATH}`;
      process.env.INSTALL_SERVICE_FIXTURE = root;
      process.env.UPDATE_FIXTURE = update.root;
      const install = await bootstrapInstaller(root, update);
      let failure: unknown;
      try {
        await install.installBundle(join(update.code, "releases/old"));
      } catch (error) {
        failure = error;
      }
      const calls = await readFile(join(root, "calls"), "utf8");
      if (!variant.includes("failure")) {
        assert.equal(failure, undefined);
        assert.match(calls, /UPDATER_READY_BEFORE_START/);
        assert.equal(await readFile(join(root, "state"), "utf8"), "active");
        assert.equal(await readFile(join(root, "finished"), "utf8"), "ready");
      } else {
        const messages: string[] = [];
        printInstallationFailure(failure, (...values) => messages.push(values.join(" ")));
        assert(failure instanceof Error);
        assert.match(messages.join("\n"), /synthetic bootstrap failure/);
        assert(!calls.includes("UPDATER_READY_BEFORE_START"));
        if (fresh) {
          assert.equal(Object.getPrototypeOf(failure), Error.prototype);
          assert(!calls.includes("start --no-block"), "Fresh failure must not start an unsupervised app");
          assert.match(messages.join("\n"), /paste the same setup line/);
          assert(!messages.join("\n").includes("STOPPED"));
        } else if (variant === "existing-failure") {
          assert(failure instanceof ServiceRestoredError);
          assert.equal(await readFile(join(root, "state"), "utf8"), "active");
          assert.equal(await readFile(join(root, "unit"), "utf8"), "old");
        } else {
          assert(failure instanceof ServiceRecoveryError);
          assert.match(messages.join("\n"), /STOPPED/);
          if (variant === "thermometer-failure") {
            assert.match(messages.join("\n"), /start thermometer.service/);
          }
        }
      }
      console.log(`installer bootstrap: ${variant} passed`);
    }
    assert(selected > 0, "Unknown service bootstrap case");
  } finally {
    restoreEnvironment("PATH", savedPath);
    restoreEnvironment("INSTALL_SERVICE_FIXTURE", savedFixture);
    restoreEnvironment("UPDATE_FIXTURE", savedUpdate);
  }
}

async function bootstrapInstaller(
  root: string,
  update: Awaited<ReturnType<typeof createUpdateFixture>>
): Promise<typeof import("../../src/install/main.ts")> {
  const fileUrl = (name: string): string => JSON.stringify(pathToFileURL(join(root, name)).href);
  const commands = JSON.stringify(pathToFileURL(join(REPOSITORY, "src/install/commands.ts")).href);
  await writeFile(
    join(root, "updater-adapter.ts"),
    `import {access,copyFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {command as execute} from ${commands};
export function settingsPaths(){return {dataRoot:${JSON.stringify(update.data)},updaterDirectory:${JSON.stringify(join(update.data, "updater"))}};}
export async function exists(path){try{await access(path);return true;}catch(error){if(error.code!=='ENOENT'){throw error;}return false;}}
export async function installFile(source,destination){await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);}
export async function writeRootFile(path,contents){await writeFile(path,contents,{mode:0o600});}
export async function command(executable,args){
  if(executable==='sh'&&await exists(${JSON.stringify(join(root, "bootstrap-fails"))})){throw new Error('synthetic bootstrap failure');}
  if(executable==='sh'&&args[1]==='initialise'){args=[...args,'--config',${JSON.stringify(update.configuration)}];}
  return execute(executable,args);
}
`
  );
  const updater = (await readFile(join(REPOSITORY, "src/install/updater.ts"), "utf8"))
    .replaceAll('"./commands.ts"', fileUrl("updater-adapter.ts"))
    .replaceAll('"../settings/paths.ts"', fileUrl("updater-adapter.ts"))
    .replaceAll("/usr/local/libexec/", `${root}/libexec/`)
    .replaceAll("/etc/cool-eva/update.json", update.configuration)
    .replaceAll("/opt/cool-eva", update.code);
  await mkdir(join(root, "libexec"));
  await writeFile(join(root, "updater.ts"), updater);
  const backup = {
    service: root.endsWith("thermometer-failure") ? "thermometer.service" : "cool-eva.service",
    unit: "/etc/systemd/system/cool-eva.service",
    original: "legacy fixture",
  };
  await writeFile(
    join(root, "main-adapter.ts"),
    `import {readFile,writeFile} from 'node:fs/promises';
export {readFile,realpath} from 'node:fs/promises';
export {resolve} from 'node:path'; export {fileURLToPath} from 'node:url';
export {command} from ${commands};
export {exists} from ${fileUrl("updater-adapter.ts")};
export {prepareBundleUpdater} from ${fileUrl("updater.ts")};
export {installBundleUnits} from ${fileUrl("service.ts")};
export {failAfterServiceRecovery} from ${fileUrl("failure-recovery.ts")};
export {printInstallationFailure} from ${JSON.stringify(pathToFileURL(join(REPOSITORY, "src/install/errors.ts")).href)};
export function settingsPaths(){return {settingsFile:${JSON.stringify(update.settings)}};}
export async function readReleaseMetadata(directory){return JSON.parse(await readFile(directory+'/release.json','utf8'));}
export async function prepareServiceWithRecovery(){${root.endsWith("fresh") || root.endsWith("fresh-failure") ? "return null;" : `await writeFile(${JSON.stringify(join(root, "state"))},'inactive');return ${JSON.stringify(backup)};`}}
export async function readInstallChoices(){return {accessories:{},hotspot:null,rideLogPublicKeyPem:null};}
export async function findInstalledService(){return null;}
export async function preserveCaptureChoice(){return false;}
export async function configureAccessories(){return false;}
export function parseSettingsDocument(){return {document:{values:{}}};}
export async function checkInstalledApp(){return {};}
export async function printInstallResults(){await writeFile(${JSON.stringify(join(root, "finished"))},'ready');}
export async function setReleaseGroup(){} export async function installSecurityUpdates(){}
export async function installNetworks(){} export async function ensureSwap(){}
export async function configureSettings(){} export async function verifyReleaseStorage(){}
export async function installCaptureChoice(){}
`
  );
  let main = (await readFile(join(REPOSITORY, "src/install/main.ts"), "utf8"))
    .replaceAll("process.getuid?.()", "0")
    .replace('"/opt/cool-eva/releases/"', JSON.stringify(join(update.code, "releases") + "/"));
  main = main.replace(/from "[^"]+"/g, `from ${fileUrl("main-adapter.ts")}`);
  await writeFile(join(root, "main.ts"), main);
  return import(pathToFileURL(join(root, "main.ts")).href);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
