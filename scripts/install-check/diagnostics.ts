export function guestDiagnosticsSeed(): string {
  return `install -d -m 755 /usr/local/libexec
install -m 600 /dev/null /var/log/cool-eva-qemu-diagnostics.log
ln -sf /dev/null /etc/systemd/system/serial-getty@ttyS0.service
ln -sf /dev/null /etc/systemd/system/getty@ttyS0.service
cat > /usr/local/libexec/cool-eva-qemu-diagnostics <<'GUEST_DIAGNOSTICS'
#!/bin/sh
set -eu
test -e /etc/cool-eva-qemu-fixture
journalctl --follow --no-pager --output=short-monotonic --lines=100 \\
  --unit=ssh.service --unit=ssh.socket --unit=cool-eva.service \\
  --unit=cool-eva-rollback.service --unit='cool-eva-update*.service' \\
  --unit=cool-eva-install-os.service --unit=cool-eva-qemu-verify.service --unit=apt-daily.service \\
  --unit=apt-daily-upgrade.service --unit=unattended-upgrades.service \\
  --unit=systemd-oomd.service --unit=NetworkManager.service &
journalctl --dmesg --follow --no-pager --output=short-monotonic --lines=100 &
while :; do
  printf '\\nCOOL_EVA_QEMU_GUEST %s uptime=' "$(date -u +%FT%TZ)"
  cat /proc/uptime
  printf 'boot_id='; cat /proc/sys/kernel/random/boot_id
  awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {print}' /proc/meminfo
  awk '$1 == "oom_kill" || $1 == "pswpin" || $1 == "pswpout" {print}' /proc/vmstat
  awk '$1 == "cpu" || $1 == "procs_running" {print}' /proc/stat
  if [ -r /proc/pressure/memory ]; then cat /proc/pressure/memory; fi
  ps -eo pid,ppid,stat,etimes,pcpu,rss,comm:40 | awk 'NR == 1 || /apt|dpkg|unattended|needrestart|node|sshd|systemd/'
  if ! timeout 5 systemctl --no-pager show ssh.service ssh.socket cool-eva.service cool-eva-install-os.service \\
    cool-eva-rollback.service cool-eva-update.service cool-eva-update-repair.service cool-eva-qemu-verify.service \\
    apt-daily.service apt-daily-upgrade.service unattended-upgrades.service cool-eva-qemu-diagnostics.service cool-eva-qemu-console.service \\
    --property=Id --property=ActiveState --property=SubState --property=MainPID \\
    --property=NRestarts --property=Result --property=ExecMainStartTimestampMonotonic \\
    --property=ActiveEnterTimestampMonotonic --property=ExecMainExitTimestampMonotonic \\
    --property=ExecMainCode --property=ExecMainStatus --property=CPUUsageNSec \\
    --property=MemoryCurrent --property=MemoryPeak; then
    printf 'COOL_EVA_QEMU_GUEST unit query failed or timed out; memory sampling continues\\n'
  fi
  printf 'COOL_EVA_QEMU_HEALTH uptime='; cat /proc/uptime
  if ! curl --silent --show-error --noproxy '*' --max-time 2 --output /dev/null \\
    --write-out 'http=%{http_code} seconds=%{time_total}\\n' http://127.0.0.1/release-health; then
    printf 'COOL_EVA_QEMU_HEALTH request failed\\n'
  fi
  sleep 5
done
GUEST_DIAGNOSTICS
chmod 755 /usr/local/libexec/cool-eva-qemu-diagnostics
cat > /etc/systemd/system/cool-eva-qemu-diagnostics.service <<'DIAGNOSTICS_UNIT'
[Unit]
Description=QEMU-only installer diagnostics independent of SSH
After=systemd-journald.service
[Service]
ExecStart=/usr/local/libexec/cool-eva-qemu-diagnostics
MemoryAccounting=yes
StandardOutput=append:/var/log/cool-eva-qemu-diagnostics.log
StandardError=inherit
[Install]
WantedBy=multi-user.target
DIAGNOSTICS_UNIT
cat > /etc/systemd/system/cool-eva-qemu-console.service <<'CONSOLE_UNIT'
[Unit]
Description=Forward persistent QEMU diagnostics to the serial artifact
After=cool-eva-qemu-diagnostics.service
Requires=cool-eva-qemu-diagnostics.service
[Service]
ExecStart=/usr/bin/tail --lines=+1 --follow=name --retry /var/log/cool-eva-qemu-diagnostics.log
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyS0
TTYReset=no
TTYVHangup=no
[Install]
WantedBy=multi-user.target
CONSOLE_UNIT
systemctl enable cool-eva-qemu-diagnostics.service cool-eva-qemu-console.service
`;
}
