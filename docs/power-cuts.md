# Power cuts

The Pi loses power with the bike. Every ride, no exceptions — there is no key-off warning on the bus and no battery behind the 5 V rail. `tune2fs` counted 607 mounts since 2025-12-04, about 2.2 boots a day, essentially all of them unclean, and this boot's `dmesg` still shows `orphan cleanup on readonly fs`.

This file is what that costs, what the code now does about it, and — the part that matters most — **what it still does not do**. Issues [#158](https://github.com/danieltroger/cool-eva/issues/158) and [#57](https://github.com/danieltroger/cool-eva/issues/57).

## 1. The mechanism

The root filesystem is ext4, mounted `data=ordered delalloc commit=5 … noatime`, with `vm.dirty_expire_centisecs=3000`. That combination is the whole story:

- **`delalloc`** defers block allocation, so an `append()` returns having only dirtied page cache.
- **`commit=5`** publishes metadata — including the file's new `i_size` — in a journal commit within five seconds.
- **`dirty_expire_centisecs=3000`** lets the data blocks themselves wait up to thirty.

So for up to ~30 s there is a window in which the file's **length says the bytes are there and the blocks have never been written**. Cut the power inside it and the filesystem, on remount, honestly reports a file of the right size whose contents are NUL.

That is not a hypothesis. It is what the ride log looks like.

## 2. The evidence

`.celog` bodies are AES-GCM ciphertext, so the expected NUL rate is 1/256 = **0.39 %**, and a run of 256 consecutive NULs has probability about 256⁻²⁵⁶. Any long run is a hole, not chance.

| File | Injury |
| --- | --- |
| `rides-2026-09-07.celog` | six runs of ≥ 256 NULs mid-file, 1306–3398 bytes, at bytes 60006 / 43507775 / 44636398 / 44753464 / 46551738 / 54778547 |
| `rides-2026-09-06.celog` | 2.93 % NUL overall — 7.5× the expected rate |
| `rides-2026-09-03.celog` | ends in 3110 NULs |
| `rides-2026-09-08.celog` | one run, on a day barely started |
| `vcu-params/service-writes.jsonl` | a 1710-NUL line, same mechanism, same day |

Each mid-file hole marks one power cut.

The four writers, and what each was doing before this change — all four unflushed:

| Write                                   | Where                          | Shape                                    |
| --------------------------------------- | ------------------------------ | ---------------------------------------- |
| ride log, every 30 s                    | `src/storage/encrypted-log.ts` | `appendFile()`                           |
| audit journal, per deliberate change    | `src/vcu/write-audit.ts`       | open / append / close                    |
| sweep resume file, per row              | `src/vcu/snapshot-store.ts`    | handle held open, no fsync **by design** |
| `latest.json` + `<iso>.json`, per sweep | `src/vcu/snapshot-store.ts`    | in-place `writeFile()`                   |
| `git pull`, per Update press            | `src/http/update.ts`           | no flush before the restart              |

> ⚠️ #158 cites the audit journal's append at `write-audit.ts:110-116`. Those lines are the **reader's** catch block. The append was at `:82-87`. The claim was right, the citation was not.

`SIGTERM` (`src/index.ts:498`) already seals the ride log before stopping the fan — but it never runs on a power cut, and nothing on the bus warns of one: `key_on` has never read 0, `vcu_12v_power_good` reads 0 in every frame, and `psu_12v_mv` (0x501, 10 Hz) simply stops.

## 3. What the code does now

`src/storage/durable.ts` holds the recipe, so it cannot be half-applied:

| Call | Guarantee |
| --- | --- |
| `appendDurably(path, data)` | the bytes are on the card before it resolves; the **directory** is flushed too on the call that created the file |
| `replaceFileDurably(path, data)` | tmp → flush → `rename()` → flush directory. A reader sees the whole old file or the whole new one |
| `syncDirectory(dir)` | an entry created or removed in `dir` survives a cut |
| `syncFilesystems()` | `sync(1)` as a child process, before the service restart |

`fdatasync` rather than `fsync` on the file: it flushes the data plus the metadata needed to _retrieve_ it, which for a size-extending write is `i_size` and the block map — exactly the metadata whose absence is the hole. It is the minimal correct primitive, **not** a faster one; on ext4 an append dirties `i_size` and forces the journal commit either way.

### The resume file keeps its no-fsync design

`sweep.partial.jsonl` still does **not** fsync per row, and that is deliberate:

1. Every failure it was built for — a dropped link, an abort, a killed process — leaves the page cache, and therefore the file, intact. fsync buys those nothing.
2. What a cut costs here is **re-asking the bike**, inside a manual procedure someone is standing over. The ride log is the only copy of data that can never be re-collected; these are two different values and they get two different prices.
3. 277 flushes would land inside the most bus-intensive burst the service runs, whose pacing was tuned against a session timeout and a tester-present cadence.
4. The crash shape is benign: NULs cannot make a line parse as valid JSON with a wrong `index`, so a hole costs re-reading the mangled rows, and `loadPartialRows` already warns about every damaged line that is not the last.

What it _did_ gain is one flush at `close()` — 1/277 of the cost, landing at the moment a sweep ends, which is very often the moment the bike is switched off — plus a directory flush when the file is created.

### Why `clearPartialSweep()` flushes the directory

Not tidiness. `clearPartialSweep` runs from _inside_ `writeSnapshot`, after the snapshot is already durable. A cut between the two resurrects the resume file next to a durable `latest.json`. The next sweep then loads all 277 rows, computes an empty `remaining`, sets `complete = true`, stamps `readAt: Date.now()` — and rule 5 happily replaces `latest.json` with **weeks-old calibration values wearing today's timestamp**, while `reportChanges` reports that nothing moved. Silent wrong data about a motorcycle. Two lines close it.

### Why `latest.json` is renamed into place

It is the diff baseline behind `GET /vcu-params` and `/vcu-backup.csv` — and it also feeds `loadLatestTableType`, which `table-gate.ts` reads as _"nothing has confirmed either micro"_ when it is null, and then **blocks**. A cut inside the old in-place `writeFile` therefore cost the VCU read gate until the next successful sweep. A rename has no such window.

### Why the `sync` runs after the reply, not before it

`POST /update` arms the restart on the response's `finish` event, and that is the only path that arms it. Running a flush of up to 30 s _before_ the reply would put that much garage wifi between a successful pull and the restart it promised: a dropped socket there means `finish` never fires, the restart never happens, the new code sits on disk unrun, and the rider is told the Pi is unreachable for an update that in fact succeeded.

So `flushThenRestart()` runs after the reply is on the wire, and **`scheduleServiceRestart()` is in its `finally`** — no failure or timeout in the flush can cost the restart. The reply makes no claim about flushing, so it cannot make a false one; a failure goes to `journalctl`, where the person who can act on it is looking.

`SYNC_TIMEOUT_MS` is a hang guard, the same instrument `PULL_TIMEOUT_MS` is, and it is a bound rather than a measurement on purpose: only the Pi's own SD card could inform a number, and both directions are harmless. When it fires, `execFile` SIGTERMs the `sync` **process**, which does not stop the kernel's writeback — so the log line says _"stopped waiting"_, never _"the data did not land"_.

## 4. What a crash can still lose

A hardening change that lets someone believe the problem is gone has done harm. It is not gone.

1. **Up to 30 s of readings that were never written.** They are still in `encrypted-log.ts`'s `buffered[]` at the cut. That is the designed segment interval and this change does not touch it.
2. **The one write in flight**, if the cut lands between the `write()` and the `datasync()`. The window shrinks from ~30 s of writeback delay to the duration of one flush; it does not become zero.
3. **A whole sweep's resume rows**, by the deliberate decision above.
4. **A cut during the `git pull` itself** — half-fetched objects, a stale `index.lock`. Unchanged. `deployHint` in `src/http/update.ts` already names that one and tells the rider to delete the lock.
5. **Every file we do not fsync.** Under `data=ordered` the whole filesystem still gets metadata ahead of data; only these four writes are covered.
6. **An SD card that lies.** `fsync` is only as honest as the device. A card that acknowledges a flush it has not completed, or that loses an erase block mid-program, defeats all of this. That is the hardware half, and it is still open.

### Duplicates, on a flush failure

`sealSegment` puts its readings back for the next tick when an append fails. If it was the _flush_ that failed, the bytes are probably on the card already and the retry appends them a second time. `scripts/decrypt-log.ts` states that the `reading` table has no uniqueness constraint, so those land as duplicate **rows** and nothing removes them. They are identifiable by `session` + `seq` — identifiable, **not** deduplicated. Duplicate beats lost, which is why the retry is right, but the word matters.

### `rides.db` is not a Pi-side exposure at all

The service opens no database. `initDb` has no caller under `src/`; `rides.db` is rebuilt on the laptop by `scripts/decrypt-log.ts` (README, §`src/db.ts`). It is outside this issue's blast radius.

Recorded because it was measured and got the wrong answer once: better-sqlite3 ships SQLite compiled `DEFAULT_SYNCHRONOUS=2 DEFAULT_WAL_SYNCHRONOUS=1`, so under `journal_mode = WAL` the pragma reads `2` only until the first write transaction and settles to **`1` (NORMAL)** thereafter — and from the first read on any file already in WAL. NORMAL in WAL mode does not fsync per commit. Measuring it immediately after setting `journal_mode` catches the one moment it still says `2`.

## 5. Measurements

**Cost of a flush** — 200 × 1 KiB appends on the development Mac (APFS, NVMe): 3.5 ms with no flushing, 731 ms with `datasync()` on each, i.e. **3.64 ms per flush**. Independently reproduced at 3.91 ms.

That number is **not** extrapolated to the Pi: different filesystem, different device class, and the rails for this work barred ssh'ing the bike to measure it. What survives the difference is the frequency. The ride log flushes twice a minute, the audit journal about once per deliberate change to the bike, the snapshot twice per manually-started sweep, the resume file once per sweep. Even at a pessimistic 50 ms per flush on a poor SD card that is a 0.17 % duty cycle on one timer callback. No interval moved and no burst gained a per-item flush, so the functionality cost is none.

**Cost of one hole** — #158 records the loss per hole as unmeasured, because the private key is not on the Pi. Measured instead on a synthetic file of the same shape, in `scripts/check-power-cut-durability.ts` §5: 24 real segments sealed through `src/storage/encrypted-log.ts` into one 4763-byte `.celog`, a **1710-byte NUL run** punched at byte 1587, then decrypted by `scripts/decrypt-log.ts` itself.

> A 1710-byte hole cost **9 of 24 segments** — exactly those whose bytes it touched — and every one of the 15 on either side of it was recovered.

That is the resync contract holding: `decrypt-log.ts` scans forward to the next `COOLEVA1` and carries on, so a hole costs the segments inside it and nothing else. At a 30 s segment interval, each of the six holes in `rides-2026-09-07.celog` cost on the order of a few minutes of readings, not the file.

> ⚠️ macOS `fsync` is not `F_FULLFSYNC`. A green check run on the development Mac proves the calls are made and the ordering is right — the **durability** claim is an ext4-on-Linux claim, and nothing in the suite can test it.

## 6. Deferred, and why

Everything here is out of scope for the code change and belongs to someone with the bike in front of them.

| Item | Why it is deferred |
| --- | --- |
| persistent journald (`Storage=volatile` today, so there is **no post-mortem log at all**) and sysctl writeback drop-ins | Pi config, not repo code. Needs Daniel's go-ahead. |
| service-level `WatchdogSec` | Separate track. The hardware watchdog (`RuntimeWatchdogSec=1m`) is already on. |
| `data=journal` — journals file _contents_, the general answer to §4.5 | Needs a USB-TTL adapter in hand before changing mount options on a machine reachable only over wifi. |
| key-off rail measurement; a supercapacitor UPS with a power-fail GPIO | Hardware. It is the only thing that would close §4.1, since it buys the seconds a clean shutdown needs. |

Already right, and worth not re-litigating: `fsck.repair=yes` is in `cmdline.txt`, the hardware watchdog is on, `unattended-upgrades` is not installed, `/tmp` is tmpfs, and the serial console is enabled.
