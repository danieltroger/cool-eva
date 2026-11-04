import assert from "node:assert/strict";
import { join } from "node:path";
import { sshCommand, runInstaller, type GuestSsh } from "./ssh.ts";

export async function verifyLegacyMigration(guest: GuestSsh, directory: string, publicKey: string): Promise<void> {
  const seed = `#!/bin/sh
set -eu
test -e /etc/cool-eva-qemu-fixture
systemctl stop cool-eva.service
test "$(readlink -f /opt/cool-eva/current)" != /opt/cool-eva/current
if [ -e /var/lib/cool-eva ]; then find -P /var/lib/cool-eva -xdev -depth -delete; fi
find -P /var/cache/cool-eva-install -xdev -mindepth 1 -depth -delete
if [ -e /home/cool-eva-test/legacy ]; then find -P /home/cool-eva-test/legacy -xdev -depth -delete; fi
install -d -o 1000 -g 1000 /home/cool-eva-test/legacy
cp -a /opt/cool-eva/current/src /home/cool-eva-test/legacy/src
for name in ride-logs vcu-params wifi-diag; do
  install -d -o 1000 -g 1000 /home/cool-eva-test/legacy/$name
  printf '%s\\n' "synthetic-$name" > /home/cool-eva-test/legacy/$name/fixture.txt
done
install -d /home/pi/ride-captures
printf '%s\\n' synthetic-capture > /home/pi/ride-captures/fixture.txt
cat > /home/cool-eva-test/legacy/ride-log-key.public.pem <<'PUBLIC_KEY'
${publicKey}
PUBLIC_KEY
cat > /etc/cool-eva-qemu-legacy.env <<'ENVIRONMENT'
COOLANT_ENABLED=0
FAN_ENABLED=0
CUSTOM_BMS_CONFIG=1
CHARGE_AUTO_ENABLED=0
WIFI_HOTSPOT_SSID=SyntheticLegacy
BLE_SECRET=synthetic-legacy-secret
ENVIRONMENT
chmod 600 /etc/cool-eva-qemu-legacy.env
cat > /etc/systemd/system/cool-eva.service <<'SERVICE'
[Unit]
Description=Synthetic legacy checkout fixture; no hardware or telemetry
[Service]
WorkingDirectory=/home/cool-eva-test/legacy
EnvironmentFile=/etc/cool-eva-qemu-legacy.env
ExecStart=/bin/sleep infinity
User=root
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl start cool-eva.service
`;
  const encoded = Buffer.from(seed).toString("base64");
  await sshCommand(guest, `printf '%s' '${encoded}' | base64 -d | sudo sh`, 120_000);
  let refused = false;
  try {
    await sshCommand(
      guest,
      "sudo /opt/cool-eva/current/runtime/bin/node --no-wasm-lazy-compilation --experimental-strip-types /opt/cool-eva/current/src/install/migrate-service.ts /home/cool-eva-test/legacy cool-eva.service"
    );
  } catch (error) {
    refused = error instanceof Error && error.message.includes("Only the installed service");
  }
  assert(refused, "Direct installer-side migration must be refused even as root");
  console.log(
    "Migrating the synthetic legacy service through its original systemd environment; installer never moves the data."
  );
  await runInstaller(guest, publicKey, join(directory, "legacy-install.log"), "legacy");
  const verification = `set -eu
test -e /etc/cool-eva-qemu-fixture
jq -e '.migration.complete and .migration.source=="legacy" and .values.customBmsConfigurationFlashed and (.values.automaticDcChargingEnabled|not) and .values.dashboardBluetoothSecret=="synthetic-legacy-secret"' /var/lib/cool-eva/state/settings.json
jq -e .complete /var/lib/cool-eva/state/data-move.json
for name in ride-logs vcu-params wifi-diag; do
  grep -qx "synthetic-$name" /var/lib/cool-eva/$name/fixture.txt
  test -L /home/cool-eva-test/legacy/$name
  test "$(stat -c %g /var/lib/cool-eva/$name/fixture.txt)" = 1000
  test "$(stat -c %a /var/lib/cool-eva/$name/fixture.txt)" = 640
done
grep -qx synthetic-capture /var/lib/cool-eva/captures/fixture.txt
test -d /home/cool-eva-test/legacy/src
test ! -e /etc/systemd/system/cool-eva.service.d/zz-cool-eva-install-migration.conf
systemctl is-active --quiet cool-eva
`;
  await sshCommand(
    guest,
    `printf '%s' '${Buffer.from(verification).toString("base64")}' | base64 -d | sudo sh`,
    90_000
  );
}
