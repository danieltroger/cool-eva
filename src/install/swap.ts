import { command, exists, removeOwnFile, writeRootFile } from "./commands.ts";
import { rename } from "node:fs/promises";

export async function ensureSwap(): Promise<void> {
  const active = (await command("swapon", ["--noheadings", "--show=NAME"])).split(/\s+/).filter(Boolean);
  if (active.length) {
    console.log("Memory/swap checked: keeping the existing active OS swap configuration.");
    return;
  }
  const path = "/var/lib/cool-eva-swap";
  if (!(await exists(path))) {
    const temporary = path + ".install-next";
    await removeOwnFile(temporary);
    await command("fallocate", ["-l", "512M", temporary]);
    await command("chmod", ["600", temporary]);
    await command("mkswap", [temporary]);
    await command("sync", []);
    await rename(temporary, path);
    await command("sync", []);
  } else if ((await command("blkid", ["-p", "-s", "TYPE", "-o", "value", path])) !== "swap") {
    throw new Error("The setup swap path already holds another file; it was not changed.");
  }
  const unit = await command("systemd-escape", ["--path", "--suffix=swap", path]);
  await writeRootFile(
    `/etc/systemd/system/${unit}`,
    `[Unit]\nDescription=Cool Eva fallback swap\n[Swap]\nWhat=${path}\n[Install]\nWantedBy=swap.target\n`,
    0o644
  );
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", ["enable", "--now", unit]);
  if (!(await command("swapon", ["--noheadings", "--show=NAME"]))) {
    throw new Error("Fallback swap could not start.");
  }
  console.log(
    "Memory/swap checked: 512 MiB disk swap is active alongside any OS zram. Existing OS swap-manager files were preserved."
  );
}
