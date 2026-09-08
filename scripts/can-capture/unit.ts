// The systemd unit that runs the raw CAN capture, as text.
//
// Pure, and separate from scripts/setup-service.ts on purpose: that file installs a
// service the moment it is imported, so nothing can drive it from a check. This function
// is what scripts/check-can-capture.ts asserts against and what the installer writes —
// the same shape src/http/update.ts uses so check-update-endpoint.ts can reach it.
//
// Reproduced from the unit that was running untracked on the Pi (issue #160, gather of
// 2026-09-08), with exactly one change: ExecStart points at the tracked script instead of
// /home/pi/ride-captures/capture.sh. Everything else — the ordering, Restart=on-failure,
// RestartSec=5, User=root — is what has been running, and is deliberately left alone.
//
// ⚠️ `/bin/sh <script>` rather than executing the script directly, so the file's mode
// cannot break the unit: nothing else tracked in this repo is executable, and a lost exec
// bit would fail at boot with 203/EXEC and nothing on the dashboard to say why.

export function canCaptureUnitText(projectDir: string): string {
  return `[Unit]
Description=Raw CAN capture for diagnostics
After=cool-eva.service
Wants=cool-eva.service

[Service]
Type=simple
ExecStart=/bin/sh ${projectDir}/scripts/can-capture/capture.sh
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;
}

/** Where the unit is installed, and what the installer backs up before overwriting. */
export const CAN_CAPTURE_UNIT_PATH = "/etc/systemd/system/can-capture.service";

/** The unit's name, for systemctl. */
export const CAN_CAPTURE_SERVICE = "can-capture";
