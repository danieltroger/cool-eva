import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { installerRemoteCommand } from "../release/installer.ts";
import { sshArguments, sshCommand, type GuestSsh } from "./ssh.ts";
import { observeOsCatchUp } from "./os-observer.ts";

export async function interruptSshDuringApt(guest: GuestSsh, log: string): Promise<void> {
  const child = spawn("ssh", ["-tt", ...sshArguments(guest), installerRemoteCommand()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let answered = false;
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    if (!answered && output.includes("Type BENCH to confirm stable bench power: ")) {
      answered = true;
      child.stdin.write("BENCH\n");
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    const pid = await sshCommand(
      guest,
      `sudo sh -eu -c '
for attempt in $(seq 1 150); do
  group=$(systemctl show cool-eva-install-os.service --property=ControlGroup --value)
  if [ -n "$group" ] && [ -f "/sys/fs/cgroup$group/cgroup.procs" ]; then
    for process in $(cat "/sys/fs/cgroup$group/cgroup.procs"); do
      if [ -r "/proc/$process/comm" ] && [ "$(cat "/proc/$process/comm")" = apt-get ]; then
        printf "%s\\n" "$process"
        exit 0
      fi
    done
  fi
  sleep 2
done
exit 1'`,
      320_000
    );
    assert.match(pid.trim(), /^\d+$/, "Kill SSH only after real apt belongs to the independent OS unit");
    assert(answered);
    console.log(`Killing the SSH client while real apt PID ${pid.trim()} runs under systemd.`);
    assert(child.kill("SIGKILL"));
    await exited;
    output += `\nSSH client killed while detached apt PID ${pid.trim()} was running.\n`;
    await writeFile(log, output, { mode: 0o600 });
    await observeOsCatchUp(guest);
    console.log("Killed SSH during real apt; the independent OS job finished successfully. Resuming the same line.");
  } finally {
    await writeFile(log, output, { mode: 0o600 });
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}
