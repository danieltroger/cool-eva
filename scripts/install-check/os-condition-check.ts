import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { securityPolicy } from "../../src/install/security.ts";

export async function checkOsUpdateCondition(directory: string, repository: string): Promise<void> {
  const policy = securityPolicy("trixie");
  assert(policy.includes('Unattended-Upgrade::InstallOnShutdown "false";'));
  assert(policy.includes('Unattended-Upgrade::Automatic-Reboot "false";'));
  assert(policy.includes("origin=Raspberry Pi Foundation,codename=trixie"));
  assert(policy.includes("#clear Unattended-Upgrade::Allowed-Origins;"));
  assert.throws(() => securityPolicy('trixie"; malicious'), /Invalid/);
  await mkdir(directory);
  await writeFile(join(directory, "curl"), '#!/bin/sh\nprintf \'%s\' "$POWER_CURL_BODY"\nexit "$POWER_CURL_STATUS"\n', {
    mode: 0o755,
  });
  for (const [body, status, allowed] of [
    ['{"ok":true}', 0, true],
    ['{"ok":false}', 0, false],
    ['{"ok":"true"}', 0, false],
    ["", 0, false],
    ["", 22, false],
    ['{"ok":true}', 22, false],
    ['{"ok":true}\n{"ok":false}', 0, false],
    ['{"ok":false}\n{"ok":true}', 0, false],
    ["{", 0, false],
  ] as const) {
    let succeeded = true;
    try {
      await promisify(execFile)("sh", [join(repository, "scripts/update/os-update-ready.sh")], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          POWER_CURL_BODY: body,
          POWER_CURL_STATUS: String(status),
        },
      });
    } catch (error) {
      assert(error instanceof Error, "Condition must return a visible command error");
      succeeded = false;
    }
    assert.equal(succeeded, allowed, `OS condition: ${status} / ${body}`);
  }
}
