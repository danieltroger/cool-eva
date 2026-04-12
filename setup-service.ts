import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname);
const nodePath = execSync('which node').toString().trim();

const unit = `[Unit]
Description=PT100 Temperature Logger
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectDir}
ExecStart=${nodePath} ${projectDir}/index.ts
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;

const serviceName = 'thermometer';
const servicePath = `/etc/systemd/system/${serviceName}.service`;

if (process.getuid?.() !== 0) {
  console.error('Must run as root: sudo node setup-service.ts');
  process.exit(1);
}

writeFileSync(servicePath, unit);
console.log(`Wrote ${servicePath}`);

execSync('systemctl daemon-reload');
execSync(`systemctl enable ${serviceName}`);
execSync(`systemctl start ${serviceName}`);

console.log('Service installed, enabled at boot, and started.');
console.log('');
console.log(`  sudo systemctl status ${serviceName}   — check status`);
console.log(`  sudo journalctl -u ${serviceName} -f   — follow logs`);
console.log(`  sudo systemctl stop ${serviceName}      — stop`);
console.log(`  sudo systemctl disable ${serviceName}   — remove from boot`);
