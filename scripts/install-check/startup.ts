import assert from "node:assert/strict";
import { sshCommand, type GuestSsh } from "./ssh.ts";

export async function startupCursor(guest: GuestSsh): Promise<string> {
  const output = await sshCommand(guest, "sudo journalctl --no-pager -n 0 --show-cursor");
  const cursor = /^-- cursor: ([a-zA-Z0-9=;_-]+)$/m.exec(output)?.[1];
  assert(cursor, "A journal cursor must scope the installer start assertion");
  return cursor;
}

export async function verifySupervisedStartup(guest: GuestSsh, cursor: string): Promise<void> {
  const output = await sshCommand(
    guest,
    `sudo journalctl --no-pager --output=cat -u cool-eva.service --after-cursor='${cursor}'`
  );
  assertSupervisedStartup(output);
}

export function assertSupervisedStartup(journal: string): void {
  assert.match(
    journal,
    /^Starting (cool-eva\.service - )?Cool Eva telemetry/m,
    "The startup journal must not be empty"
  );
  assert(!journal.includes("cool-eva update:"), "A supervised bootstrap must not emit helper/dispatcher failures");
}
