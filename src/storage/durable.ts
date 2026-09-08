import { spawn } from "child_process";
import { open, rename, rm } from "fs/promises";
import { dirname } from "path";
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

/**
 * How long we WAIT for `sync(1)` — never how long it takes, which nothing here can bound.
 * Conflating the two was a bug, and `execFile`'s own `timeout` cannot do this job:
 * docs/power-cuts.md §"Why the `sync` runs after the reply" has the measurements.
 */
const SYNC_TIMEOUT_MS = 30_000;

/** What actually reached the card. Exists so a check can assert the flush happened at all. */
export interface DurabilityCounters {
  flushes: number;
  directorySyncs: number;
}

const counters: DurabilityCounters = { flushes: 0, directorySyncs: 0 };

/**
 * Appends `data` and does not resolve until those bytes are on the card.
 *
 * Creates the file when it is absent and flushes the DIRECTORY when it did: the entry is
 * metadata of the parent, so without that a cut can leave the data written and the file
 * itself gone — the "first .celog of a day" case.
 */
export async function appendDurably(path: string, data: Buffer | string): Promise<void> {
  const handle = await openForAppend(path);
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
}

/** A handle held open across many writes, flushed once when it is closed. */
export interface DeferredAppend {
  write: (data: Buffer | string) => Promise<void>;
  /** Flushes, then closes. Throws what the flush threw; the handle is closed either way. */
  close: () => Promise<void>;
}

/**
 * Opens `path` for appending, flushing the DIRECTORY if this call created it, and leaves
 * the data unflushed until close().
 *
 * For the one writer whose per-write flush is argued against and whose file is still worth
 * keeping: the parameter sweep's resume file. The directory entry costs one flush, once;
 * 277 data flushes inside a bus burst are what src/vcu/snapshot-store.ts refuses.
 *
 * ⚠️ Here rather than hand-rolled at that call site: the hand-rolled version leaked the
 * handle when the directory flush threw, which is the failure this file opens by warning
 * about, in the one place the recipe had been copied instead of imported.
 */
export async function openDeferredAppend(path: string): Promise<DeferredAppend> {
  const handle = await openForAppend(path);
  return {
    write: data => handle.writeFile(data),
    close: async () => {
      try {
        await flush(handle, path);
      } finally {
        await closeReportingOnly(handle, path);
      }
    },
  };
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
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    // ⚠️ After the close above, never instead of it — and covering the rename and directory
    // flush too, not just the write. writeSnapshot's archive name is unique per sweep, so an
    // orphan there is overwritten by nothing and would accumulate for the life of a card
    // whose free space may be why the write failed. A power cut can still leave one behind.
    await rm(temporaryPath, { force: true }).catch((removeError: unknown) => {
      console.warn(`durable: could not remove ${temporaryPath} after a failed write:`, removeError);
    });
    throw error;
  }
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
 * `command` is a parameter so the failure path stays checkable without breaking `sync` on
 * the machine running the suite.
 */
export async function syncFilesystems(command = "sync"): Promise<string | null> {
  // spawn/"ignore" rather than execFile: execFile's stdout/stderr pipes hold the event loop
  // open on their own, so unref()ing the child does not detach it (measured in
  // docs/power-cuts.md). ../http/update.ts spawns its restart the same way.
  const child = spawn(command, [], { stdio: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = new Promise<string | null>(resolve => {
    child.once("error", error => resolve(`\`${command}\` could not be run: ${error.message}`));
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      resolve(`\`${command}\` ended ${signal ? `on ${signal}` : `with status ${code}`} without reporting success`);
    });
  });
  // setTimeout is driven by libuv's own clock rather than the wall clock this process
  // steps from GPS, so a `date -u -s` mid-flush cannot fire or postpone it.
  const gaveUpWaiting = new Promise<string>(resolve => {
    timer = setTimeout(
      () =>
        resolve(
          `stopped waiting for \`${command}\` after ${SYNC_TIMEOUT_MS / 1000} s — it is still running. ` +
            `Writeback already issued carries on, so this is "we did not wait", NOT "the data did not land" ` +
            `— but it is also not a promise that all of it did.`
        ),
      SYNC_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([finished, gaveUpWaiting]);
  } finally {
    clearTimeout(timer);
    // Unref rather than kill: the whole point above is that a signal does not stop a sync.
    // Killing it would only stop US waiting, which the race has already done.
    child.unref();
    // Both listeners go too — a resolved race leaves them attached to a child that may run
    // for minutes, and the closure they hold is the whole promise chain above.
    child.removeAllListeners();
  }
}

/** A copy, so reading the counters cannot reset them. */
export function durabilityCounters(): DurabilityCounters {
  return { ...counters };
}

/**
 * An append handle whose directory entry is already on the card.
 *
 * "ax" is O_APPEND|O_CREAT|O_EXCL, so success means we created the entry and the directory
 * needs flushing too. Only EEXIST may fall through to a plain open — an ENOENT here means
 * the DIRECTORY is missing, which has to stay an error.
 *
 * ⚠️ The flush happens BEFORE the caller writes anything. The entry exists the moment "ax"
 * succeeds, so if a later write fails, every retry takes the EEXIST branch and this path
 * would never be flushed again — a cut would then cost the whole day's file, which is the
 * case the flush exists for. Flushing first exposes a zero-length file instead, which every
 * reader here already treats as no data. And the handle is closed if that flush throws:
 * this file's whole premise is that an abandoned handle is one fd per write until EMFILE.
 */
async function openForAppend(path: string): Promise<FileHandle> {
  let handle: FileHandle;
  let created = true;
  try {
    handle = await open(path, "ax");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    handle = await open(path, "a");
    created = false;
  }
  if (!created) {
    return handle;
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    await closeReportingOnly(handle, path);
    throw error;
  }
  return handle;
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
