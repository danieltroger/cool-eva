import { mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";
import { replaceFileDurably } from "../storage/durable.ts";
import { collectWifiState } from "./collect.ts";
import { buildWifiDump } from "./diag.ts";

// Writes a wifi dump to disk and keeps the directory from growing without end.
// ./collect.ts runs the commands, ./diag.ts makes the text, this puts it somewhere.

/**
 * ⚠️ NOT /tmp. That is tmpfs on this Pi, and the bike cuts 12 V at key-off — so a dump
 * taken at a charger would be gone by the time anyone could read it, which is the one
 * situation it exists for. Under the checkout, where `wifi-diag/` is in .gitignore
 * because a dump carries SSIDs and BSSIDs and this is a public repo.
 */
export const WIFI_DIAG_DIRNAME = "wifi-diag";

/** How many dumps survive. A fault that never clears must not fill the card. */
export const WIFI_DIAG_KEEP = 20;

/**
 * Takes a dump and writes it. Answers with where it went, or null if it could not.
 *
 * ⚠️ The failure is LOGGED as well as returned: the caller is a fault timer with nobody
 * watching a terminal, and a diagnostic that fails silently is worse than none. The
 * dump's own header already lists which commands went wrong, so nothing counts them twice.
 */
export async function writeWifiDump(directory: string, iface: string, uptimeSeconds: number): Promise<string | null> {
  const results = await collectWifiState(iface);
  const at = Date.now();
  return writeDumpText(directory, at, buildWifiDump({ at, uptimeSeconds, results }));
}

/**
 * The write itself, separate so a check can drive it with no radio and no `nmcli`.
 *
 * ⚠️ `replaceFileDurably` and NOT `writeFile`, which is what this used to be. The reason
 * the file lives under the checkout rather than in /tmp is that the bike cuts 12 V at
 * key-off — and ext4's `delalloc` leaves up to 30 s in which `i_size` says the bytes are
 * there and the blocks read NUL (docs/power-cuts.md). A plain write would have made the
 * one failure this location was chosen to survive the one its write path does not.
 */
export async function writeDumpText(directory: string, at: number, text: string): Promise<string | null> {
  const path = join(directory, `${dumpFilename(at)}.txt`);
  try {
    await mkdir(directory, { recursive: true });
    await replaceFileDurably(path, text);
  } catch (error) {
    console.warn(`wifi-diag: could not write ${path}:`, error instanceof Error ? error.message : error);
    return null;
  }
  await pruneOldDumps(directory);
  return path;
}

/**
 * A filename that sorts chronologically and survives every filesystem.
 *
 * ⚠️ Colons are stripped rather than kept: an ISO timestamp is `2026-09-19T10:48:52Z`,
 * and a name with colons in it is a nuisance to `scp` and illegal on a FAT card, which
 * is what the Pi's boot partition is and what a rescue copy would land on.
 */
export function dumpFilename(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/**
 * Which dumps to delete, given everything in the directory. Pure, and separate from the
 * unlinking for one reason: the direction is the whole of the behaviour and a filesystem
 * test of it is awkward, so a mutation that deletes the NEWEST instead survived until
 * this was reachable from a check.
 *
 * ⚠️ The filename is an ISO instant with its punctuation swapped, so a lexical sort IS a
 * chronological one — no `stat()` per file and no clock read to decide what is old.
 */
export function dumpsToRemove(names: readonly string[], keep: number): string[] {
  // ⚠️ `.tmp` first, unconditionally. replaceFileDurably writes `<name>.txt.tmp` and
  // renames; a cut between the two leaves one behind, and it does not end in `.txt` — so
  // without this line the orphans are the one thing the prune can never reap.
  const orphans = names.filter(name => name.endsWith(".tmp"));
  const dumps = names.filter(name => name.endsWith(".txt")).sort();
  return [...orphans, ...dumps.slice(0, Math.max(0, dumps.length - keep))];
}

/** Keeps the newest WIFI_DIAG_KEEP dumps and removes the rest. */
async function pruneOldDumps(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    console.warn(`wifi-diag: could not list ${directory} to prune it:`, error);
    return;
  }
  for (const name of dumpsToRemove(names, WIFI_DIAG_KEEP)) {
    try {
      await unlink(join(directory, name));
    } catch (error) {
      console.warn(`wifi-diag: could not remove old dump ${name}:`, error);
    }
  }
}
