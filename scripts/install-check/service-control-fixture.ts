import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function createServiceControlFixture(directory: string): Promise<{
  service: typeof import("../../src/install/service.ts");
  recovery: typeof import("../../src/install/failure-recovery.ts");
}> {
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "bin/systemctl"), systemctlFixture(), { mode: 0o755 });
  await writeFile(join(directory, "state"), "inactive");
  await writeFile(join(directory, "unit"), "new");
  const adapter = join(directory, "adapter.ts");
  const commands = new URL("../../src/install/commands.ts", import.meta.url).href;
  await writeFile(
    adapter,
    `import {writeFile,access} from 'node:fs/promises';
export {command,unitLoadState} from ${JSON.stringify(commands)};
const directory=${JSON.stringify(directory)};
async function marked(name){try{await access(directory+'/'+name);return true;}catch(error){if(error.code!=='ENOENT'){throw error;}return false;}}
export async function readFile(path){return path.endsWith('settings.json')?'{}':'legacy fixture';}
export function settingsPaths(){return {dataRoot:directory,settingsFile:directory+'/settings.json'};}
export function parseSettingsDocument(){return {document:{migration:{complete:true}}};}
export async function exists(path){return (path.endsWith('settings.json')||path==='/etc/systemd/system/cool-eva.service')?await marked('fail-select'):path.endsWith('src/index.ts')&&await marked('migration-fault');}
export async function selectInitialRelease(){if(await marked('fail-select')){throw new Error('Release selection failed after stop');}}
export async function verifyReleaseStorage(){}
export async function installFile(source,destination){if(destination==='/etc/systemd/system/cool-eva.service'){await writeFile(directory+'/unit','new');}}
export async function writeRootFile(path,contents){if(path==='/etc/systemd/system/cool-eva.service'){await writeFile(directory+'/unit',contents==='legacy fixture'?'old':'new');}}
export async function removeOwnFile(){}
`
  );
  let serviceSource = await readFile(new URL("../../src/install/service.ts", import.meta.url), "utf8");
  for (const dependency of [
    "node:fs/promises",
    "./commands.ts",
    "../settings/schema.ts",
    "../settings/paths.ts",
    "../http/release-health.ts",
  ]) {
    serviceSource = serviceSource.replaceAll(JSON.stringify(dependency), JSON.stringify(pathToFileURL(adapter).href));
  }
  for (const dependency of ["./errors.ts", "./service-control.ts"]) {
    serviceSource = serviceSource.replaceAll(
      JSON.stringify(dependency),
      JSON.stringify(new URL("../../src/install/" + dependency.slice(2), import.meta.url).href)
    );
  }
  const servicePath = join(directory, "service.ts");
  await writeFile(servicePath, serviceSource);
  const recoverySource = (await readFile(new URL("../../src/install/failure-recovery.ts", import.meta.url), "utf8"))
    .replaceAll('"./service.ts"', JSON.stringify(pathToFileURL(servicePath).href))
    .replaceAll('"./errors.ts"', JSON.stringify(new URL("../../src/install/errors.ts", import.meta.url).href));
  const recoveryPath = join(directory, "failure-recovery.ts");
  await writeFile(recoveryPath, recoverySource);
  return {
    service: await import(pathToFileURL(servicePath).href),
    recovery: await import(pathToFileURL(recoveryPath).href),
  };
}

function systemctlFixture(): string {
  return `#!/bin/sh
set -eu
fixture="$INSTALL_SERVICE_FIXTURE"
printf '%s\\n' "$*" >> "$fixture/calls"
case "$1" in
 daemon-reload)
  if [ -e "$fixture/slow-reload" ]; then sleep 31; fi
  if [ -e "$fixture/fail-restore" ] && [ "$(cat "$fixture/unit")" = old ]; then exit 19; fi
  ;;
 enable)
  case " $* " in *' --now '*) exit 92;; esac
  if [ -e "$fixture/slow-enable" ]; then sleep 31; fi
  if [ -e "$fixture/fail-new" ] && [ "$(cat "$fixture/unit")" = new ]; then exit 17; fi
  ;;
 start)
  test "$2" = --no-block || exit 91
  if [ -e "$fixture/fail-start" ]; then printf failed > "$fixture/state"; else printf active > "$fixture/state"; fi
  ;;
 stop) printf inactive > "$fixture/state";;
 show)
  case "$*" in
   *--property=ExecStart*) printf /usr/local/libexec/cool-eva-launch;;
   *--property=WorkingDirectory*) printf /synthetic/checkout;;
   *--value*) cat "$fixture/state";;
   *) printf 'ActiveState=%s\\nMainPID=%s\\nJob=0\\n' "$(cat "$fixture/state")" "$(test "$(cat "$fixture/state")" = active && echo 123 || echo 0)";;
  esac
  ;;
 fail) exit 23;;
 signal) kill -TERM "$$";;
 timeout-probe) exec sleep 31;;
 reset-failed) :;;
 restart) printf inactive > "$fixture/state"; exit 18;;
 *) exit 90;;
esac
`;
}
