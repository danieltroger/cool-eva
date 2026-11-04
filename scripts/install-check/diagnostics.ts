export function guestDiagnosticsSeed(): string {
  return `install -d -m 755 /usr/local/libexec
cat > /usr/local/libexec/cool-eva-qemu-diagnostics <<'GUEST_DIAGNOSTICS'
#!/bin/sh
set -eu
test -e /etc/cool-eva-qemu-fixture
journalctl --follow --no-pager --output=short-monotonic --lines=100 \\
  --unit=ssh.service --unit=ssh.socket --unit=cool-eva.service \\
  --unit=cool-eva-install-os.service --unit=apt-daily.service \\
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
  if ! systemctl --no-pager show ssh.service ssh.socket cool-eva.service cool-eva-install-os.service \\
    apt-daily.service apt-daily-upgrade.service unattended-upgrades.service cool-eva-qemu-diagnostics.service \\
    --property=Id --property=ActiveState --property=SubState --property=MainPID \\
    --property=NRestarts --property=Result --property=ExecMainStartTimestampMonotonic \\
    --property=MemoryCurrent --property=MemoryPeak; then
    printf 'COOL_EVA_QEMU_GUEST some diagnostic units are not loaded yet\\n'
  fi
  sleep 15
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
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyS0
[Install]
WantedBy=multi-user.target
DIAGNOSTICS_UNIT
systemctl enable cool-eva-qemu-diagnostics.service
`;
}
