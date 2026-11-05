import { appendFile, writeFile } from "node:fs/promises";
import type { GuestSsh } from "./ssh.ts";

export async function captureGuestInspection(guest: GuestSsh, path: string, execute: GuestCommand): Promise<void> {
  try {
    const output = await execute(guest, INSPECTION_COMMAND, 120_000);
    await writeFile(path, output, { mode: 0o600 });
    console.log(`Guest inspection saved: ${path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Cannot collect guest inspection:", message);
    await appendFile(path, `Guest inspection failed: ${message}\n`, { mode: 0o600 });
  }
}

export async function verifyGuestDiagnostics(guest: GuestSsh, phase: string, execute: GuestCommand): Promise<void> {
  const output = await execute(guest, DIAGNOSTIC_LIVENESS_COMMAND, 60_000);
  console.log(`Independent guest diagnostics alive at ${phase}: ${output.trim()}`);
}

type GuestCommand = (guest: GuestSsh, command: string, timeout?: number) => Promise<string>;

const DIAGNOSTIC_LIVENESS_COMMAND = `sudo sh -eu <<'QEMU_LIVENESS'
test -e /etc/cool-eva-qemu-fixture
systemctl is-active --quiet cool-eva-qemu-diagnostics.service
systemctl is-active --quiet cool-eva-qemu-console.service
test "$(systemctl is-enabled serial-getty@ttyS0.service)" = masked
before=$(awk '/^COOL_EVA_QEMU_GUEST [0-9]/ {count++} END {print count+0}' /var/log/cool-eva-qemu-diagnostics.log)
read started idle < /proc/uptime
started=\${started%%.*}
while :; do
  after=$(awk '/^COOL_EVA_QEMU_GUEST [0-9]/ {count++} END {print count+0}' /var/log/cool-eva-qemu-diagnostics.log)
  if [ "$after" -gt "$before" ]; then
    printf 'guest diagnostic samples %s -> %s\\n' "$before" "$after"
    exit 0
  fi
  read current idle < /proc/uptime
  test "$((\${current%%.*} - started))" -lt 30 || exit 1
  sleep 2
done
QEMU_LIVENESS`;

const INSPECTION_COMMAND = `sudo sh -u <<'QEMU_INSPECTION'
test -e /etc/cool-eva-qemu-fixture || exit 1
record() {
  printf '\nINSPECTION %s uptime=' "$*"; cat /proc/uptime
  if timeout 15 "$@"; then :; else printf 'INSPECTION command failed: %s (exit %s)\n' "$*" "$?"; fi
}
record date -u +%FT%TZ
record journalctl --no-pager --output=short-monotonic -b -u cool-eva.service -u cool-eva-install-os.service -u cool-eva-qemu-diagnostics.service -u cool-eva-qemu-console.service -u ssh.service -u apt-daily.service -u apt-daily-upgrade.service -u unattended-upgrades.service
record systemctl --no-pager --full status cool-eva.service cool-eva-install-os.service cool-eva-qemu-diagnostics.service cool-eva-qemu-console.service ssh.service apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
record systemctl --no-pager show cool-eva.service --property=ActiveState --property=SubState --property=Result --property=MainPID --property=NRestarts --property=ExecMainCode --property=ExecMainStatus --property=ExecMainStartTimestampMonotonic --property=ActiveEnterTimestampMonotonic --property=MemoryCurrent --property=MemoryPeak
record free -m
record ps -eo pid,ppid,stat,etimes,pcpu,rss,comm:40
record dmesg
record journalctl --sync
record tail -3000 /var/log/cool-eva-qemu-diagnostics.log
QEMU_INSPECTION`;
