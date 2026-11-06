import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { quote, REPOSITORY } from "../update-check/fixture.ts";

export async function createAptFixture(
  root: string,
  options: { real?: boolean; units?: [string, string] } = {}
): Promise<AptFixture> {
  const commands = join(root, "commands");
  const units = options.units ?? ["apt-daily.service", "apt-daily-upgrade.service"];
  for (const directory of [commands, join(root, "cache"), join(root, "units")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(root, "cache/install.lock"), "");
  await writeFile(join(root, "uptime"), "0 0\n");
  await writeFile(join(commands, "sync"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(commands, "systemctl"),
    '#!/bin/sh\ncase "$1" in daemon-reload) exit 0 ;; show) printf "LoadState=loaded\\nActiveState=inactive\\nJob=\\n" ;; *) exit 91 ;; esac\n',
    { mode: 0o755 }
  );
  let source = (await readFile(join(REPOSITORY, "install.sh"), "utf8"))
    .replaceAll("/var/cache/cool-eva-install", join(root, "cache"))
    .replaceAll("/etc/systemd/system", join(root, "units"));
  if (options.units) {
    source = source.replaceAll("apt-daily.service", units[0]).replaceAll("apt-daily-upgrade.service", units[1]);
  }
  if (!options.real) {
    source = source
      .replaceAll("/proc/uptime", quote(join(root, "uptime")))
      .replaceAll("/usr/bin/flock", join(commands, "flock"));
    await writeFile(join(commands, "flock"), '#!/bin/sh\nexit "${APT_FLOCK_STATUS:-0}"\n', { mode: 0o755 });
    await writeFile(
      join(commands, "sleep"),
      '#!/bin/sh\nread elapsed idle < "$APT_FIXTURE_ROOT/uptime"\nprintf "%s 0\\n" "$((elapsed + 15))" > "$APT_FIXTURE_ROOT/uptime"\n',
      { mode: 0o755 }
    );
    await writeFile(
      join(commands, "timeout"),
      '#!/bin/sh\nprintf "%s\\n" "$1" >> "$APT_FIXTURE_ROOT/query-budgets"\nshift\nexec "$@"\n',
      { mode: 0o755 }
    );
  }
  return {
    root,
    commands,
    units,
    source,
    script: join(root, "fixture.sh"),
    environment: { ...process.env, APT_FIXTURE_ROOT: root, PATH: `${commands}:${process.env.PATH}` },
  };
}

export async function runAptProgram(fixture: AptFixture, program: string): Promise<string> {
  await writeAptProgram(fixture, program);
  const { stdout } = await promisify(execFile)("/bin/sh", [fixture.script], {
    env: fixture.environment,
    timeout: 15_000,
  });
  return stdout;
}

export async function writeAptProgram(fixture: AptFixture, program: string): Promise<void> {
  if (!fixture.source.includes('\nmain "$@"')) {
    throw new Error("Installer fixture could not find the real entry point");
  }
  await writeFile(fixture.script, fixture.source.replace('\nmain "$@"', "\n" + program));
}

export async function readAptGuard(fixture: AptFixture, unit: string): Promise<string> {
  return readFile(join(fixture.root, "units", unit + ".d/40-cool-eva-install.conf"), "utf8");
}

export interface AptFixture {
  root: string;
  commands: string;
  units: [string, string];
  source: string;
  script: string;
  environment: NodeJS.ProcessEnv;
}
