import { execFile } from "child_process";
import { lstat, open, readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { syncDirectory } from "../storage/durable.ts";
import { NetworkRefusal } from "./network-types.ts";

export async function verifyNetworkPersistence(
  uuid: string,
  filename: string | null,
  netplan: boolean,
  absent = false
): Promise<void> {
  if (netplan) {
    const result = await promisify(execFile)("/usr/bin/python3", ["-I", "-c", NETPLAN_UUID_PROBE, uuid], {
      timeout: 5_000,
      maxBuffer: 1024,
    });
    if (result.stdout.trim() !== (absent ? "absent" : "present")) {
      throw new NetworkRefusal(
        "The image's Netplan backend could not persist this profile. Use installation help; the old network remains saved."
      );
    }
    if (!absent) {
      for (const name of await readdir("/etc/netplan")) {
        if (/\.ya?ml$/.test(name)) {
          await flushProtectedFile(join("/etc/netplan", name));
        }
      }
    }
    await syncDirectory("/etc/netplan");
    return;
  }
  const directory = "/etc/NetworkManager/system-connections";
  const files = filename ? [filename] : (await readdir(directory)).map(name => join(directory, name));
  let found = false;
  for (const path of files) {
    if (dirname(path) !== directory) {
      throw new NetworkRefusal("This network has an unsupported persistent backend.");
    }
    const contents = await readFile(path, "utf8");
    if (new RegExp(`^uuid=${uuid}$`, "m").test(contents)) {
      found = true;
      if (!absent) {
        await flushProtectedFile(path);
      }
    }
  }
  if (found === absent) {
    throw new NetworkRefusal(
      "The saved network file did not match the requested change. Read the network state again."
    );
  }
  await syncDirectory(directory);
}

async function flushProtectedFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0) {
    throw new NetworkRefusal("Network credentials need a root-owned private regular file. Use installation help.");
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

// Parse authoritative YAML without exposing it in subprocess output, errors or argv.
const NETPLAN_UUID_PROBE = `
import pathlib, sys, yaml
def contains(value, identity):
    if isinstance(value, dict):
        return any(contains(item, identity) for item in value.values())
    if isinstance(value, list):
        return any(contains(item, identity) for item in value)
    return value == identity
try:
    found = any(contains(yaml.safe_load(path.read_text()), sys.argv[1])
                for path in pathlib.Path('/etc/netplan').iterdir()
                if path.suffix in ('.yaml', '.yml'))
    print('present' if found else 'absent')
except Exception:
    print('unreadable')
    sys.exit(1)
`;
