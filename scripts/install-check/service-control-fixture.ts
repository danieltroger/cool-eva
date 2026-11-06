import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function createServiceControlFixture(directory: string): Promise<ServiceControlFixture> {
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "bin/systemctl"), systemctlFixture(), { mode: 0o755 });
  await writeFile(join(directory, "state"), "inactive");
  await writeFile(join(directory, "unit"), "new");
  const adapter = join(directory, "adapter.ts");
  const commands = new URL("../../src/install/commands.ts", import.meta.url).href;
  await writeFile(
    adapter,
    `import {writeFile,access,rm} from 'node:fs/promises';
export {command,unitLoadState} from ${JSON.stringify(commands)};
const directory=${JSON.stringify(directory)};
async function marked(name){try{await access(directory+'/'+name);return true;}catch(error){if(error.code!=='ENOENT'){throw error;}return false;}}
export async function readFile(path){return path.endsWith('settings.json')?'{}':'legacy fixture';}
export function settingsPaths(){return {dataRoot:directory,settingsFile:directory+'/settings.json'};}
export function parseSettingsDocument(){return {document:{migration:{complete:true}}};}
export async function exists(path){return (path.endsWith('settings.json')||path==='/etc/systemd/system/cool-eva.service')?await marked('fail-select'):path.endsWith('src/index.ts')&&await marked('migration-fault')||path==='/etc/systemd/system/thermometer.service'&&await marked('before-backup');}
export async function selectInitialRelease(){if(await marked('fresh-select')){throw new Error('Fresh selection failed');}if(await marked('fail-select')){throw new Error('Release selection failed after stop');}}
export async function verifyReleaseStorage(){}
export async function installFile(source,destination){if(destination==='/etc/systemd/system/cool-eva.service'){await writeFile(directory+'/unit','new');await rm(directory+'/no-unit',{force:true});}}
export async function writeRootFile(path,contents){if(path.endsWith('.previous')&&await marked('before-backup')){throw new Error('Backup write failed');}if(path==='/etc/systemd/system/cool-eva.service'){await writeFile(directory+'/unit',contents==='legacy fixture'?'old':'new');}}
export async function removeOwnFile(){}
`
  );
  const clockPath = join(directory, "clock.ts");
  await writeFile(
    clockPath,
    `let elapsed=0,expireAt=Infinity;
export function monotonicNow(){return elapsed;}
export function since(started){const duration=elapsed-started;if(elapsed>=expireAt){elapsed+=180000;expireAt=Infinity;}return duration;}
export async function setTimeout(duration){elapsed+=duration;}
export function expireDuringPoll(){expireAt=elapsed+1000;}
`
  );
  const controlPath = join(directory, "service-control.ts");
  const controlSource = (await readFile(new URL("../../src/install/service-control.ts", import.meta.url), "utf8"))
    .replaceAll('"node:timers/promises"', JSON.stringify(pathToFileURL(clockPath).href))
    .replaceAll('"../monotonic.ts"', JSON.stringify(pathToFileURL(clockPath).href))
    .replaceAll('"./commands.ts"', JSON.stringify(commands));
  await writeFile(controlPath, controlSource);
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
  serviceSource = serviceSource.replaceAll('"./service-control.ts"', JSON.stringify(pathToFileURL(controlPath).href));
  for (const dependency of ["./errors.ts"]) {
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
    control: await import(pathToFileURL(controlPath).href),
    now: ((await import(pathToFileURL(clockPath).href)) as ObservationClock).monotonicNow,
    expireDuringPoll: ((await import(pathToFileURL(clockPath).href)) as ObservationClock).expireDuringPoll,
  };
}

export interface ServiceControlFixture {
  service: typeof import("../../src/install/service.ts");
  recovery: typeof import("../../src/install/failure-recovery.ts");
  control: typeof import("../../src/install/service-control.ts");
  now: () => number;
  expireDuringPoll: () => void;
}

interface ObservationClock {
  monotonicNow: () => number;
  expireDuringPoll: () => void;
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
  if [ -e "$fixture/require-updater" ] && [ "$(cat "$fixture/unit")" = new ]; then
    test -f "$(cat "$fixture/bootstrap-state")"
    sh -n "$(cat "$fixture/bootstrap-helper")"
    sh "$(cat "$fixture/bootstrap-helper")" self-test
    printf 'UPDATER_READY_BEFORE_START\\n' >> "$fixture/calls"
  fi
  if [ -e "$fixture/fail-start" ]; then printf failed > "$fixture/state"; else printf active > "$fixture/state"; fi
  ;;
 stop) if [ -e "$fixture/no-unit" ]; then exit 5; fi; printf inactive > "$fixture/state";;
 show)
  case "$*" in
   *--property=ExecStart*) printf /usr/local/libexec/cool-eva-launch;;
   *--property=WorkingDirectory*) printf /synthetic/checkout;;
   *--property=LoadState*)
    if [ -e "$fixture/no-unit" ] || { [ -e "$fixture/before-backup" ] && [ "$2" = cool-eva.service ]; }; then printf not-found; else printf loaded; fi;;
   *--value*) cat "$fixture/state";;
   *)
    state=$(cat "$fixture/state"); process_id=0; restarts=0; job=
    if [ "$state" = active ]; then process_id=123; fi
    if [ -e "$fixture/zero-job" ]; then job=0; fi
    if [ -e "$fixture/queued-start" ] && [ ! -e "$fixture/queue-sampled" ]; then
      state=inactive; process_id=0; job=42; touch "$fixture/queue-sampled"
    fi
    if [ -e "$fixture/crash-loop" ] || [ -e "$fixture/pid-change" ] || [ -e "$fixture/restart-count" ]; then
      sample=0; if [ -e "$fixture/sample" ]; then sample=$(cat "$fixture/sample"); fi
      printf '%s' "$((sample+1))" > "$fixture/sample"
      if [ "$sample" -ge 1 ]; then
        if [ -e "$fixture/crash-loop" ] && [ "$sample" = 1 ]; then state=activating; process_id=0; job=43
        elif [ ! -e "$fixture/restart-count" ]; then process_id=456; fi
        if [ ! -e "$fixture/pid-change" ]; then restarts=1; fi
      fi
    fi
    printf 'ActiveState=%s\\nMainPID=%s\\nNRestarts=%s\\nJob=%s\\n' "$state" "$process_id" "$restarts" "$job";;
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
