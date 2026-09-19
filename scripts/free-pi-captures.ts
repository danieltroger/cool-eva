import { readFile, stat } from "fs/promises";
import { spawn } from "child_process";
import { dirname, isAbsolute, join } from "path";
import { homedir } from "os";
import {
  planCaptureDeletions,
  type DeletionPlan,
  type ManifestRow,
  type PlanInput,
  type RemoteFile,
} from "./free-pi-captures-plan.ts";

// Frees space on the bike's SD card by deleting captures that are provably copied
// somewhere else. Runs from the Mac, over the ssh alias. NEVER automatic.
//
//     node --experimental-strip-types scripts/free-pi-captures.ts            # dry run
//     node --experimental-strip-types scripts/free-pi-captures.ts --delete
//
//     --manifest <path>          a proof source; repeatable, defaults to the Mac's
//     --host <alias>             default cool-eva-tunnel (see pi-access.md)
//     --strict                   re-hash every candidate on the Pi before deleting it
//     --no-stored-copy-check     the proof's blobs are not on this machine (the odroid)
//     --delete                   actually delete; without it nothing is removed
//
// The decision lives in ./free-pi-captures-plan.ts and is pure. This file only fetches
// what that needs, prints, and — when asked — removes.

const DEFAULT_MANIFEST = join(homedir(), "Documents/cool-eva-route/data/ride-captures/MANIFEST.tsv");
const CAPTURE_DIRECTORY = "/home/pi/ride-captures";

export interface Options {
  manifests: string[];
  host: string;
  strict: boolean;
  requireStoredCopy: boolean;
  del: boolean;
}

const options = parseArguments(process.argv.slice(2));
const rows = await readProofSources(options.manifests);
console.log(`proof sources: ${options.manifests.length}, rows: ${rows.length}`);

const probe = await probeThePi(rows, options);
const plan = planCaptureDeletions({
  rows,
  remote: probe.remote,
  storedCopies: await measureStoredCopies(rows, options),
  nowEpochSeconds: Math.floor(Date.now() / 1000),
  currentBootId: probe.bootId,
  strict: options.strict,
  requireStoredCopy: options.requireStoredCopy,
} satisfies PlanInput);

report(plan, probe.bootId);

if (!options.del) {
  console.log("\nDRY RUN — nothing was deleted. Add --delete to act on the list above.");
  process.exit(0);
}
if (plan.deletable.length === 0) {
  console.log("\nNothing is deletable, so --delete has nothing to do.");
  process.exit(0);
}
await deleteOnThePi(plan, options);

function report(plan: DeletionPlan, bootId: string | null): void {
  const freed = plan.deletable.reduce((total, entry) => total + entry.bytes, 0);
  console.log(`\nDELETABLE — ${plan.deletable.length} files, ${(freed / 1e9).toFixed(2)} GB`);
  for (const entry of plan.deletable) {
    console.log(`  ${entry.name}  ${(entry.bytes / 1e6).toFixed(1)} MB  proof: ${entry.proofSource}`);
  }
  if (plan.refusals.length > 0) {
    console.log(`\nREFUSED — ${plan.refusals.length}`);
    for (const refusal of plan.refusals) {
      console.log(`  ${refusal.name}\n      ${refusal.reason}`);
    }
  }
  if (plan.absent.length > 0) {
    console.log(`\nalready gone from the Pi — ${plan.absent.length} (nothing to free)`);
  }
  console.log(`\nthe Pi's current boot is ${bootId ?? "UNKNOWN — the boot-id guard did not run"}`);
  if (!options.requireStoredCopy) {
    console.log(
      "⚠️  --no-stored-copy-check: this run did NOT confirm the verified copy still exists. Every deletion\n" +
        "    below rests on a manifest row alone. Use it only when the copy lives somewhere this Mac cannot see."
    );
  }
}

/** Reads the TSV proof sources in the order given; the first to name a capture wins. */
async function readProofSources(paths: string[]): Promise<ManifestRow[]> {
  const rows: ManifestRow[] = [];
  for (const path of paths) {
    const text = await readFile(path, "utf-8");
    const lines = text.split("\n").filter(line => line.trim().length > 0);
    const header = lines.shift()?.split("\t") ?? [];
    const column = (name: string): number => {
      const index = header.indexOf(name);
      if (index === -1) {
        throw new Error(`${path} has no ${name} column — its header is ${header.join(", ")}`);
      }
      return index;
    };
    const columns = {
      name: column("name"),
      rawBytes: column("raw_bytes"),
      sha256: column("sha256_on_pi"),
      storedFile: column("stored_file"),
      storedBytes: column("stored_bytes"),
      sourceState: column("source_state"),
    };
    for (const line of lines) {
      const cells = line.split("\t");
      rows.push({
        name: cells[columns.name],
        rawBytes: Number(cells[columns.rawBytes]),
        sha256OnPi: cells[columns.sha256],
        storedFile: resolveStored(path, cells[columns.storedFile]),
        storedBytes: Number(cells[columns.storedBytes]),
        sourceState: cells[columns.sourceState],
        proofSource: path,
      });
    }
  }
  return rows;
}

/** `stored_file` is recorded relative to its own manifest. */
function resolveStored(manifestPath: string, stored: string): string {
  return isAbsolute(stored) ? stored : join(dirname(manifestPath), stored);
}

async function measureStoredCopies(rows: ManifestRow[], options: Options): Promise<Map<string, number | null>> {
  const sizes = new Map<string, number | null>();
  if (!options.requireStoredCopy) {
    return sizes;
  }
  for (const row of rows) {
    if (sizes.has(row.storedFile)) {
      continue;
    }
    try {
      sizes.set(row.storedFile, (await stat(row.storedFile)).size);
    } catch (error) {
      // Expected for a manifest whose blobs are elsewhere; the planner turns a null into
      // a refusal naming the file. Logged so a whole missing directory is visible as one.
      console.log(`  (no local copy of ${row.storedFile}: ${(error as Error).message.split("\n")[0]})`);
      sizes.set(row.storedFile, null);
    }
  }
  return sizes;
}

/**
 * One ssh for the whole batch: the Pi's boot id, then a size and mtime per name.
 *
 * ⚠️ Names go over STDIN and are never interpolated into the remote command. They are
 * validated against the capture pattern by the planner too — this is the second line of
 * defence, not the only one — but a name is attacker-shaped data the moment a manifest is
 * written by something other than us.
 */
async function probeThePi(
  rows: ManifestRow[],
  options: Options
): Promise<{ remote: Map<string, RemoteFile>; bootId: string | null }> {
  const hash = options.strict ? 'printf "\\t%s" "$(sha256sum "$name" | cut -d" " -f1)"' : ":";
  const script = `set -eu
cd ${CAPTURE_DIRECTORY}
printf 'BOOT\\t%s\\n' "$(cut -c1-8 /proc/sys/kernel/random/boot_id)"
while IFS= read -r name; do
  if [ -f "$name" ]; then
    printf 'FILE\\t%s\\t%s\\t%s' "$name" "$(stat -c %s "$name")" "$(stat -c %Y "$name")"
    ${hash}
    printf '\\n'
  else
    printf 'GONE\\t%s\\n' "$name"
  fi
done`;
  const answer = await ssh(options.host, script, rows.map(row => row.name).join("\n") + "\n");

  const remote = new Map<string, RemoteFile>();
  let bootId: string | null = null;
  for (const line of answer.split("\n")) {
    const cells = line.split("\t");
    if (cells[0] === "BOOT") {
      bootId = cells[1];
    } else if (cells[0] === "FILE") {
      remote.set(cells[1], { bytes: Number(cells[2]), mtimeEpochSeconds: Number(cells[3]), sha256: cells[4] });
    }
  }
  return { remote, bootId };
}

/** Deletes, then proves each file is gone before counting the bytes as freed. */
async function deleteOnThePi(plan: DeletionPlan, options: Options): Promise<void> {
  const names = plan.deletable.map(entry => entry.name);
  console.log(`\ndeleting ${names.length} files on ${options.host}…`);
  const script = `set -eu
cd ${CAPTURE_DIRECTORY}
while IFS= read -r name; do
  rm -f -- "$name"
  if [ -e "$name" ]; then printf 'STILL\\t%s\\n' "$name"; else printf 'GONE\\t%s\\n' "$name"; fi
done
df -Pk . | tail -1`;
  const answer = await ssh(options.host, script, names.join("\n") + "\n");

  const gone = new Set<string>();
  for (const line of answer.split("\n")) {
    const cells = line.split("\t");
    if (cells[0] === "GONE") {
      gone.add(cells[1]);
    } else if (cells[0] === "STILL") {
      console.error(`  ✗ ${cells[1]} is still on the Pi`);
    }
  }
  const freed = plan.deletable.filter(entry => gone.has(entry.name)).reduce((total, entry) => total + entry.bytes, 0);
  console.log(`\nfreed ${(freed / 1e9).toFixed(2)} GB across ${gone.size} files (confirmed absent, not assumed)`);
  console.log(
    answer
      .split("\n")
      .filter(line => line.includes("/"))
      .pop() ?? ""
  );
  if (gone.size !== names.length) {
    console.error(`⚠ ${names.length - gone.size} files were NOT removed — see above`);
    process.exit(1);
  }
}

/**
 * Runs `script` on the Pi with `input` on its stdin.
 *
 * ⚠️ The script goes as ssh's remote COMMAND, not down stdin, because the remote loop
 * reads the capture names from stdin — piping both would have the shell eat the names as
 * script text and the loop would process nothing while exiting 0.
 */
async function ssh(host: string, script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host, script]);
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (errors += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`ssh ${host} exited ${code}: ${errors.trim() || "(no stderr)"}`));
        return;
      }
      if (errors.trim().length > 0) {
        console.log(`  (ssh stderr: ${errors.trim().split("\n")[0]})`);
      }
      resolve(output);
    });
    child.stdin.end(input, "utf-8");
  });
}

function parseArguments(argv: string[]): Options {
  const manifests: string[] = [];
  let host = "cool-eva-tunnel";
  let strict = false;
  let requireStoredCopy = true;
  let del = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      manifests.push(argv[(index += 1)]);
    } else if (argument === "--host") {
      host = argv[(index += 1)];
    } else if (argument === "--strict") {
      strict = true;
    } else if (argument === "--no-stored-copy-check") {
      requireStoredCopy = false;
    } else if (argument === "--delete") {
      del = true;
    } else {
      console.error(`free-pi-captures: unknown argument ${argument}`);
      process.exit(1);
    }
  }
  return { manifests: manifests.length > 0 ? manifests : [DEFAULT_MANIFEST], host, strict, requireStoredCopy, del };
}
