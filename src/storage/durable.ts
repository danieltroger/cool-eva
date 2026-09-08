import { execFile } from "child_process";
import { open, rename, rm } from "fs/promises";
import { dirname } from "path";
import { promisify } from "util";
import type { FileHandle } from "fs/promises";

// Getting bytes onto the SD card, on a Pi that loses power with the bike every time.
//
// The root is ext4 mounted `delalloc data=ordered commit=5` with
// `dirty_expire_centisecs=3000`: an append publishes the new i_size in a journal commit
// within 5 s while the data blocks wait up to 30 s for writeback, so a cut in between
// leaves a file whose length says the bytes are there and whose blocks read as NUL. Not a
// theory — six such holes sit in one day of the ride log. docs/power-cuts.md has the
// evidence, and what each call here does and does not buy.
//
// ⚠️ Every path closes its handle in a `finally`. Both callers of appendDurably catch and
// carry on by design, and a dying card is a PERSISTENT EIO — so a handle leaked on the
// flush failure is one fd every 30 s until EMFILE takes the whole service down with it.

const execFileAsync = promisify(execFile);

/** A wedged flush must not postpone the service restart for ever. See syncFilesystems(). */
const SYNC_TIMEOUT_MS = 30_000;

/** What actually reached the card. Exists so a check can assert the flush happened at all. */
export interface DurabilityCounters {
  flushes: number;
  directorySyncs: number;
  failures: number;
}

const counters: DurabilityCounters = { flushes: 0, directorySyncs: 0, failures: 0 };

/**
 * Appends `data` and does not resolve until those bytes are on the card.
 *
 * Creates the file when it is absent and flushes the DIRECTORY when it did: the entry is
 * metadata of the parent, so without that a cut can leave the data written and the file
 * itself gone — the "first .celog of a day" case.
 */
export async function appendDurably(path: string, data: Buffer | string): Promise<void> {
  const { handle, created } = await openForAppend(path);
  try {
    // writeFile() rather than write(): write() reports a short write in `bytesWritten` and
    // leaves acting on it to the caller, so a partial record would be flushed to the card
    // as a truncated one — this module's own injury, made permanent. writeFile() loops,
    // which is the guarantee fs/promises appendFile() gave before this replaced it.
    await handle.writeFile(data);
    await flush(handle, path);
  } finally {
    await closeReportingOnly(handle, path);
  }
  if (created) {
    await syncDirectory(dirname(path));
  }
}

/**
 * Replaces `path` in one step: a reader sees the whole old file or the whole new one.
 *
 * rename(2) within a directory is atomic, so there is no window in which the target is a
 * partial file. For JSON that is the difference between an old answer and no answer —
 * a half-written snapshot does not parse, so in-place truncation costs the whole file.
 */
export async function replaceFileDurably(path: string, data: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  try {
    const handle = await open(temporaryPath, "w");
    try {
      await handle.writeFile(data);
      await flush(handle, temporaryPath);
    } finally {
      await closeReportingOnly(handle, temporaryPath);
    }
  } catch (error) {
    // ⚠️ After the close above, never instead of it. A power cut can still leave one of
    // these behind; nothing reads a `.tmp` and the next write of that name overwrites it.
    await rm(temporaryPath, { force: true }).catch((removeError: unknown) => {
      console.warn(`durable: could not remove ${temporaryPath} after a failed write:`, removeError);
    });
    throw error;
  }
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

/**
 * fsyncs a directory, so an entry created or removed in it survives a cut.
 *
 * Throws on failure like the rest of this module: the data may be on the card while the
 * name that finds it is not, which is a durability failure and not a lesser one.
 */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
    counters.directorySyncs += 1;
  } catch (error) {
    counters.failures += 1;
    throw new Error(`${directory}: the directory entry could not be flushed to the card`, { cause: error });
  } finally {
    await closeReportingOnly(handle, directory);
  }
}

/**
 * Flushes every filesystem. Null when it worked, a sentence when it did not.
 *
 * ⚠️ `sync` here is the COREUTILS BINARY as a child process, not a `*Sync` Node API —
 * CLAUDE.md bans those and this is not one of them.
 *
 * The timeout is a hang guard, the same instrument PULL_TIMEOUT_MS is, and it is a bound
 * rather than a measurement on purpose: only the Pi's own SD card could inform a number,
 * and both directions are harmless. `command` is a parameter so the failure path stays
 * checkable without breaking `sync` on the machine running the suite.
 */
export async function syncFilesystems(command = "sync"): Promise<string | null> {
  try {
    await execFileAsync(command, [], { timeout: SYNC_TIMEOUT_MS });
    return null;
  } catch (error) {
    const failure = error as Error & { killed?: boolean };
    if (failure.killed === true) {
      // Said this way round on purpose: the SIGTERM stops the `sync` process, not the
      // kernel's writeback, so the data has very likely landed anyway.
      return `stopped waiting for \`${command}\` after ${SYNC_TIMEOUT_MS / 1000} s — that is "we did not wait", not "the data did not land"`;
    }
    return `\`${command}\` failed: ${failure.message}`;
  }
}

/** A copy, so reading the counters cannot reset them. */
export function durabilityCounters(): DurabilityCounters {
  return { ...counters };
}

/**
 * An append handle, and whether this call created the file.
 *
 * "ax" is O_APPEND|O_CREAT|O_EXCL, so success means the directory entry is ours and needs
 * flushing too. Only EEXIST may fall through to a plain open — an ENOENT here means the
 * DIRECTORY is missing, which has to stay an error.
 */
async function openForAppend(path: string): Promise<{ handle: FileHandle; created: boolean }> {
  try {
    return { handle: await open(path, "ax"), created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return { handle: await open(path, "a"), created: false };
  }
}

/**
 * datasync() rather than sync(): fdatasync flushes the data plus the metadata needed to
 * RETRIEVE it, which for a size-extending write is i_size and the block map — exactly the
 * metadata whose absence is the NUL hole. The minimal correct primitive, not a faster one:
 * an append dirties i_size, so ext4 forces the journal commit either way.
 */
async function flush(handle: FileHandle, path: string): Promise<void> {
  try {
    await handle.datasync();
    counters.flushes += 1;
  } catch (error) {
    counters.failures += 1;
    throw new Error(`${path}: written but NOT flushed to the card — treat this write as unsafe`, { cause: error });
  }
}

/**
 * ⚠️ Reports instead of throwing, because it runs in a `finally`. A close() failure must
 * not replace the flush failure already on its way up: that one names what went wrong with
 * the DATA, which is the answer the caller needs.
 */
async function closeReportingOnly(handle: FileHandle, path: string): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    console.warn(`durable: could not close ${path}:`, error);
  }
}
