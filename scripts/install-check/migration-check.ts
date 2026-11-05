import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MigrationNeedsHelpError, printInstallationFailure } from "../../src/install/errors.ts";

export async function checkMigrationFailures(directory: string, repository: string): Promise<void> {
  const source = await readFile(join(repository, "src/install/service.ts"), "utf8");
  for (const [mode, reason, needsHelp] of [
    ["fresh-failure", "Fresh release selection failed", false],
    ["completed-storage", "Storage verification failed", false],
    ["completed-stop", "Service stop timed out", false],
    ["completed-corrupt", "Stored configuration could not be read.", false],
    ["legacy-checkout", "checkout could not be identified", true],
    ["legacy-conflict", "Destination conflict; preserve both folders", true],
    ["legacy-corrupt", "Stored configuration could not be read.", true],
  ] as const) {
    const fixture = join(directory, mode);
    await mkdir(fixture);
    const adapter = join(fixture, "adapter.ts");
    await writeFile(adapter, preparationAdapter(mode));
    let module = source;
    for (const dependency of [
      "node:fs/promises",
      "./commands.ts",
      "../settings/schema.ts",
      "../settings/paths.ts",
      "../http/release-health.ts",
    ]) {
      assert(module.includes(JSON.stringify(dependency)));
      module = module.replaceAll(JSON.stringify(dependency), JSON.stringify(pathToFileURL(adapter).href));
    }
    module = module.replace(
      '"./errors.ts"',
      JSON.stringify(pathToFileURL(join(repository, "src/install/errors.ts")).href)
    );
    const entry = join(fixture, "service.ts");
    await writeFile(entry, module);
    const service = (await import(pathToFileURL(entry).href)) as {
      prepareExistingService: (directory: string) => Promise<unknown>;
    };
    let failure: unknown;
    try {
      await service.prepareExistingService("/synthetic/release");
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error, mode);
    assert.equal(failure instanceof MigrationNeedsHelpError, needsHelp, mode);
    const messages: string[] = [];
    printInstallationFailure(failure, (...values) => messages.push(values.join(" ")));
    const output = messages.join("\n");
    if (mode === "legacy-corrupt" || mode === "completed-corrupt") {
      const cause = failure instanceof MigrationNeedsHelpError ? failure.cause : failure;
      assert(cause instanceof SyntaxError);
      assert.match(cause.message, /SYNTHETIC/, "The parser excerpt must contain the synthetic secret");
      assert(!output.includes("SYNTHETIC"), "Migration parse errors must hide synthetic secret fragments");
    }
    assert(output.includes(reason), output);
    assert.equal(output.includes("Stop and ask for help"), needsHelp, output);
    assert.equal(output.includes("paste the same setup line"), !needsHelp, output);
  }
  console.log(
    "Migration advice: fresh/completed failures resume; legacy failures ask for help, with parser excerpts redacted."
  );
}

function preparationAdapter(mode: string): string {
  return `const mode=${JSON.stringify(mode)};
export async function readFile(){return mode==='completed-corrupt'?'{"dashboardBluetoothSecret":SYNTHETIC-SECRET}':'{}';}
export function settingsPaths(){return {settingsFile:'/synthetic/settings.json'};}
export function parseSettingsDocument(){return {document:{migration:{complete:true}}};}
export async function exists(path){return path.endsWith('settings.json') ? mode.startsWith('completed') : path.endsWith('src/index.ts') && (mode==='legacy-conflict'||mode==='legacy-corrupt');}
export async function unitLoadState(unit){return mode==='fresh-failure'||unit!=='cool-eva.service'?'not-found':'loaded';}
export async function selectInitialRelease(){if(mode==='fresh-failure'){throw new Error('Fresh release selection failed');}}
export async function verifyReleaseStorage(){
 if(mode==='completed-storage'){throw new Error('Storage verification failed');}
 if(mode==='legacy-corrupt'){JSON.parse('{"dashboardBluetoothSecret":SYNTHETIC-SECRET}');}
}
export async function command(name,args){
 if(args[0]==='show'){return mode==='legacy-checkout'?'relative':'/synthetic/checkout';}
 if(args[0]==='stop'&&mode==='completed-stop'){throw new Error('Service stop timed out');}
 if(args[0]==='restart'&&mode==='legacy-conflict'){throw new Error('Destination conflict; preserve both folders');}
 return '';
}
export async function installFile(){}
export async function writeRootFile(){}
export async function removeOwnFile(){}
`;
}
