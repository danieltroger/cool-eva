export function guestSeed(publicKey: string, assetPort: number, tag: string): string {
  if (
    !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [a-zA-Z0-9.-]+)?$/.test(publicKey.trim()) ||
    !Number.isInteger(assetPort) ||
    assetPort < 1024 ||
    assetPort > 65535 ||
    !/^cool-eva-(main|branch-[a-z0-9.-]+)-[a-f0-9]{40}$/.test(tag)
  ) {
    throw new Error("Invalid QEMU fixture identity");
  }
  return `#!/bin/sh
set -eu
mount -t proc proc /proc || mountpoint -q /proc
mount -t sysfs sysfs /sys || mountpoint -q /sys
if [ -e /proc/sys/kernel/print-fatal-signals ]; then echo 1 > /proc/sys/kernel/print-fatal-signals; fi
resize2fs /dev/mmcblk0p2
existing_user=$(getent passwd 1000 | cut -d: -f1)
if [ -n "$existing_user" ]; then
  usermod --login cool-eva-test --home /home/cool-eva-test --move-home --shell /bin/bash "$existing_user"
  usermod --append --groups sudo cool-eva-test
else
  useradd --create-home --uid 1000 --shell /bin/bash --groups sudo cool-eva-test
fi
passwd -d cool-eva-test
install -d -m 700 -o 1000 -g 1000 /home/cool-eva-test/.ssh
cat > /home/cool-eva-test/.ssh/authorized_keys <<'PUBLIC_KEY'
${publicKey.trim()}
PUBLIC_KEY
chown 1000:1000 /home/cool-eva-test/.ssh/authorized_keys
chmod 600 /home/cool-eva-test/.ssh/authorized_keys
printf '%s\\n' 'cool-eva-test ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/cool-eva-test
chmod 440 /etc/sudoers.d/cool-eva-test
mkdir -p /etc/cloud /etc/NetworkManager/system-connections
touch /etc/cloud/cloud-init.disabled
touch /etc/cool-eva-qemu-fixture
printf '%s\\n' cool-eva > /etc/hostname
sed -i 's/raspberrypi/cool-eva/g' /etc/hosts
# These are fixtures for Imager customisation and hardware QEMU does not model.
for unit in userconfig.service rpi-usb-gadget-ics.service rpi-eeprom-update.service fstrim.service fstrim.timer; do
  ln -sf /dev/null /etc/systemd/system/$unit
done
cat > /etc/NetworkManager/system-connections/qemu-nat.nmconnection <<'NETWORK'
[connection]
id=QEMU USB Ethernet fixture
type=ethernet
interface-name=usb0
autoconnect=true
[ipv4]
method=manual
address1=10.0.2.15/24,10.0.2.2
dns=10.0.2.3;
[ipv6]
method=disabled
NETWORK
chmod 600 /etc/NetworkManager/system-connections/qemu-nat.nmconnection
cat > /usr/local/bin/curl <<'CURL_FIXTURE'
#!/bin/bash
set -eu
transport_arguments=()
local_asset=false
for argument in "$@"; do
  case "$argument" in
    https://github.com/danieltroger/cool-eva/releases/latest/download/install.sh)
      argument='http://10.0.2.2:${assetPort}/${tag}/install.sh'; local_asset=true ;;
    https://github.com/danieltroger/cool-eva/releases/download/${tag}/bundle.tar.zst|https://github.com/danieltroger/cool-eva/releases/download/${tag}/manifest.txt)
      argument="http://10.0.2.2:${assetPort}/${tag}/\${argument##*/}"; local_asset=true ;;
  esac
  transport_arguments+=("$argument")
done
if $local_asset; then
  for ((index=0;index<\${#transport_arguments[@]};index++)); do
    if [ "\${transport_arguments[index]}" = '=https' ]; then transport_arguments[index]='=http'; fi
  done
fi
exec /usr/bin/curl "\${transport_arguments[@]}"
CURL_FIXTURE
chmod 755 /usr/local/bin/curl
systemctl enable ssh.service
sync
echo COOL_EVA_SEED_COMPLETE
exec /sbin/init
`;
}
