import { mkdir, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
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

/** How many dumps survive. A stuck gesture must not be able to fill the card. */
export const WIFI_DIAG_KEEP = 20;

export interface WifiDumpOutcome {
  path: string | null;
  /** Commands that exited non-zero, timed out or were truncated. */
  problems: number;
  error: Error | null;
}

/**
 * Takes a dump and writes it. Answers with where it went rather than throwing.
 *
 * ⚠️ A failure to WRITE is still reported through the return value and logged, never
 * swallowed: the caller is a handlebar gesture with nobody watching a terminal, and the
 * only other way the rider learns anything is the signal the caller records afterwards.
 */
export async function writeWifiDump(directory: string, iface: string, uptimeSeconds: number): Promise<WifiDumpOutcome> {
  const results = await collectWifiState(iface);
  const problems = results.filter(result => result.exitCode !== 0 || result.timedOut || result.truncated).length;
  const at = Date.now();
  const text = buildWifiDump({ at, uptimeSeconds, results });
  const path = join(directory, `${dumpFilename(at)}.txt`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, text, "utf8");
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.warn(`wifi-diag: could not write ${path}:`, failure.message);
    return { path: null, problems, error: failure };
  }
  await pruneOldDumps(directory);
  return { path, problems, error: null };
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
  const dumps = names.filter(name => name.endsWith(".txt")).sort();
  return dumps.slice(0, Math.max(0, dumps.length - keep));
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
