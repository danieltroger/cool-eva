import { sshCommand, type GuestSsh } from "./ssh.ts";

export async function verifyUpdaterRecovery(
  guest: GuestSsh,
  execute = sshCommand,
  helper = "/opt/cool-eva/updater/current/run.sh",
  configuration = "/etc/cool-eva/update.json"
): Promise<void> {
  await execute(
    guest,
    `sudo sh ${shellArgument(helper)} self-test && sudo sh ${shellArgument(helper)} recover --config ${shellArgument(configuration)}`,
    90_000
  );
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
