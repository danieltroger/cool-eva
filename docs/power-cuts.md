# Power cuts

The Pi loses power with the bike. Every ride, no exceptions, and there is no battery behind the 5 V rail. ⚠️ This paragraph used to say there was _no key-off warning on the bus_ either. **There is** — parking announces itself 10 s to 7 minutes ahead, and §7 is what that is worth. `tune2fs` counted 607 mounts since 2025-12-04, about 2.2 boots a day, essentially all of them unclean, and this boot's `dmesg` still shows `orphan cleanup on readonly fs`.

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

⚠️ **A fixed writer does not repair a file that is already holed.** That 1710-NUL line is still on the Pi, and it is line 11 of a file the dashboard reads on _every_ GET and POST to `/vcu-write`. U+0000 is not JS whitespace, so `trim()` did not catch it and `JSON.parse` threw once per request. `recentAuditRecords` treats a NUL-only line as blank and names it once instead (#154, `scripts/check-write-audit.ts`) — nothing is recovered, because 1710 NUL bytes are not a record.

### ⚠️ The holed line is not the shape it was reported as, and reading it as one loses a record (#189, 2026-09-14)

Both the issue that reported this and the brief that scheduled the fix described the injury as "NULs followed by a torn JSON tail", with the prescribed fix being to skip it. It is not a torn tail. Measured on a copy pulled off the Pi on 2026-09-14 (29 562 bytes, 94 records):

```
line 15: 429 characters — bytes 0…214 all NUL (a contiguous prefix), then 214 bytes that parse:
{"at":1788949247772,"clockTrustworthy":true,"action":"reset-vcu","status":"reset","after":null,
 "note":"both VCU micros restarted (A9: accepted (positive 51); A8: accepted (positive 51))",
 "runningVersion":"754dfa2"}

line 14: at=1788869836774  read-service-stamp
line 16: at=1788950222964  charge-current
```

The tail's stamp sits between its neighbours', so those bytes are the record that belongs there. **The hole is the record _before_ it**, whose block was allocated and never written back — taking its own trailing newline with it, which is what glued the next record onto the same line. So the shape a power cut leaves here is `hole + intact neighbour`, not `hole + fragment`, and the reader that skipped line 15 was **throwing away a complete record of an ECUReset on both VCU micros** while printing a `SyntaxError` and a stack trace on every request.

**The tail is now kept when it parses, and that is not optimism.** A record truncated at the front cannot parse. Across this whole journal, of the 28 933 possible front-truncations of its 94 records, **none parses to any JSON value** — no record carries a `{` after position 0, because `before`/`after` are scalars by type and no `note` contains a brace. So on this corpus "the NUL-stripped tail parses" is exact rather than heuristic: it means the hole ended on a record boundary. Salvaged bytes still face a stricter bar than an ordinary line — an `at` that is a number and an `action` that is a string, the two fields the sheet renders — because a fragment that happens to parse is not thereby a record.

⚠️ **A NUL anywhere but a contiguous leading run is still an ordinary damaged line.** That is the fence, and `scripts/check-write-audit.ts` §5c is red on any reader that switches on `line.includes("\0")` instead: a line with NULs in the _middle_ is not a power-cut prefix, and treating it as one would be the "skip anything that will not parse" widening this whole area exists to prevent.

**Each injury is named once per process, not once per read.** The dashboard polls `/vcu-write`, so "once per read" is dozens of lines a minute about one damaged line — which is what #189 was actually reporting. The key is per file, line number, length and injury kind; an append-only journal cannot change an existing line under that key, and a _different_ injury still gets its own line (asserted, so the dedupe cannot quietly degenerate into "once ever"). A torn **last** line is deliberately excluded: it is routine rather than damage, and the next append turns it into a mid-file line the key then covers. Where a holed line is _also_ the last one, the NUL prefix wins and it is reported as damage — same precedence as the all-NUL trailing line has had since #172.

⚠️ **One line of the table above does not describe this copy.** In it, line 15 is the **only** NUL-bearing line — line 11 is an ordinary `rtc-sync` record — so the 1710-NUL line #154 found is not in the journal as it stands on 2026-09-14. Whether it was compacted, whether that count came from a different copy, or whether the file was replaced is not established here, and this note says only what these bytes say. Both readers handle both shapes either way.

**Known gap, stated rather than left implicit:** the warning goes to the Pi's journal, and the sheet shows its twelve lines with no sign that one is missing. Telling the _page_ a record was lost would change `recentAuditRecords`' signature and ripple into the payload and the sheet, which is a different change from "stop printing a stack trace per request". Not done here.

Each mid-file hole marks one power cut.

The writes this Pi makes, and what each was doing before this change — none of them flushed (`snapshot-store.ts` owns two of them, and `lifetime-store.ts` was added after and is listed here for the same reason):

| Write                                   | Where                          | Shape                                    |
| --------------------------------------- | ------------------------------ | ---------------------------------------- |
| ride log, every 30 s                    | `src/storage/encrypted-log.ts` | `appendFile()`                           |
| audit journal, per deliberate change    | `src/vcu/write-audit.ts`       | open / append / close                    |
| sweep resume file, per row              | `src/vcu/snapshot-store.ts`    | handle held open, no fsync **by design** |
| `latest.json` + `<iso>.json`, per sweep | `src/vcu/snapshot-store.ts`    | in-place `writeFile()`                   |
| `git pull`, per Update press            | `src/http/update.ts`           | no flush before the restart              |
| `lifetime.json` + `lifetime-<iso>.json` | `src/vcu/lifetime-store.ts`    | in-place `writeFile()` — see below       |

⚠️ The lifetime store landed one commit after this change and inherited the old shape, so for a few days it was the one write on this list still done in place. It is the **least reproducible file the Pi holds**: a reading costs a service stop and someone standing at the bike, and a truncated one reads as null — so the page says "never read" and it is simply gone rather than stale. Both of its writes are `replaceFileDurably` now, and `scripts/check-power-cut-durability.ts` §4 drives them.

> ⚠️ #158 cites the audit journal's append at `write-audit.ts:110-116`. Those lines are the **reader's** catch block; the append was at `:82-87` **as of `dd8acac`**, which is the commit #158 was counting lines in. The claim was right, the citation was not — and since a callout about a wrong citation had better not become one, note that line numbers in this file are stated against the commit named beside them.

`SIGTERM` (`src/index.ts:498`) already seals the ride log before stopping the fan — but it never runs on a power cut.

> ⚠️ **Two of the three facts this paragraph used to give for "nothing on the bus warns of one" are false, and they are why #57 item 1 sat closed for months.** Kept rather than rewritten away, because the shape of the error is the useful part: all three were _true of the captures that had been looked at_.
>
> - ❌ _"`key_on` has never read 0."_ It reads **0 in 89 rows** of `rides.db` against 184 at 1, and there are **20 observed 1→0 edges across 14** archive captures. 🟡 It is still not a power-fail signal, and it does not settle what the bit means — §7.
> - ❌ _"`vcu_12v_power_good` reads 0 in every frame."_ It reads **1 in 129 of 131 rows** and 0 in exactly two. The resting value was written down inverted. One of the two zeros is a **300 ms blip** with the bike riding on for 30 944 more readings; the other lands 40 ms after a key-off in a session that ends 1.413 s later. n=1, not n=2.
> - ✅ _"`psu_12v_mv` (0x501, 10 Hz) simply stops."_ Right, and re-checked: the last reading of all **128** sessions that carry it is **12 661–12 784 mV**. The rail does not sag. It stops.

## 3. What the code does now

`src/storage/durable.ts` holds the recipe, so it cannot be half-applied:

| Call | Guarantee |
| --- | --- |
| `appendDurably(path, data)` | the bytes are on the card before it resolves; the **directory** is flushed too on the call that created the file |
| `replaceFileDurably(path, data)` | tmp → flush → `rename()` → flush directory. A reader sees the whole old file or the whole new one |
| `syncDirectory(dir)` | an entry created or removed in `dir` survives a cut |
| `syncFilesystems()` | `sync(1)` as a child process (spawned, stdio ignored), before the service restart |

### Why the reader still reads the whole journal

`recentAuditRecords` reads the file whole and slices, and #207 asked whether it should read only the tail — it is on the event loop that also serves the 10 Hz WebSocket and the CAN RX handler. Measured 2026-09-14 over the real 29 562-byte, 94-record journal, 200 iterations: **0.134 ms** per read-and-parse, against `status()`'s 0.628 ms with a full sweep on disk. Roughly 1.3 ms scaled to a Pi Zero.

Against that, a tail read costs three things. The reader stops seeing damage outside the window, so the line-15 hole above goes invisible the moment the file outgrows it — taking the recovery with it. Line numbers stop being line numbers, so a warning can no longer name the line somebody would `sed -n '15p'`. And "the count of what was done to this bike" becomes "the count in the last N bytes". `write-audit.ts` already made this call — _"at one line per deliberate change to a motorcycle, it will be kilobytes in a decade"_ — and 94 records after a year says it was right. A `stat`-gated cache would cost nothing in correctness and still buys ~0.1 ms on a path #207 itself takes from twelve requests a minute to roughly none, so that is not here either.

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

It is the diff baseline behind `GET /vcu-params` and `/vcu-backup.csv` — and it also feeds `loadLatestTableType`, which `table-gate.ts` reads as _"nothing has confirmed either micro"_ when it is null, and then **blocks**. A cut inside the old in-place `writeFile` therefore cost the VCU **write** gate until the next successful sweep — parameter writes, not reads: `table-gate.ts:25` says in capitals that reads are deliberately not gated, because a read is the only way back out of that state. A rename has no such window.

### Why the `sync` runs after the reply, not before it

`POST /update` arms the restart on the response's `finish` event, and that is the only path that arms it. Running a flush of up to 30 s _before_ the reply would put that much garage wifi between a successful pull and the restart it promised: a dropped socket there means `finish` never fires, the restart never happens, the new code sits on disk unrun, and the rider is told the Pi is unreachable for an update that in fact succeeded.

So `flushThenRestart()` runs after the reply is on the wire, and **`scheduleServiceRestart()` is in its `finally`** — no failure or timeout in the flush can cost the restart. The reply makes no claim about flushing, so it cannot make a false one; a failure goes to `journalctl`, where the person who can act on it is looking.

`SYNC_TIMEOUT_MS` bounds **how long we wait**, and nothing else. That distinction was a bug here first, and it is worth spelling out because the obvious implementation does not work:

`execFile`'s own `timeout` option only _sends_ SIGTERM, and settles the promise on the child's exit. `sync(2)` is uninterruptible, so on the slow or dying card this whole file is about, the signal sits pending while the kernel finishes writeback. Measured against a child that ignores SIGTERM, `execFile` timeouts of 300/500/1000/2000 ms all settled only when the child exited **8 s** later — and settled by **resolving**, because the exit status was 0. A wedged flush would therefore have been reported as a success, with nothing in the journal at all, and the restart delayed for as long as the flush took.

So the bound is a timer raced against the child, and stopping the wait is all it does. The child is `spawn`ed with `stdio: "ignore"` rather than run through `execFile`, for a second measured reason: `execFile` always pipes stdout and stderr, and those pipes hold the event loop open on their own — `unref()`ing the child alone still kept the process alive for the full 8 s of a wedged flush, which would have handed back exactly the delay the timer exists to avoid. When it fires, the flush is still running; the restart goes ahead anyway. The log line says _"stopped waiting"_ and explicitly **not** _"the data did not land"_ — writeback already issued carries on — but it does not claim all of it landed either. The number itself is a bound rather than a measurement on purpose: only the Pi's own SD card could inform one, and both directions are harmless.

## 4. What a crash can still lose

A hardening change that lets someone believe the problem is gone has done harm. It is not gone.

1. **Up to 30 s of readings that were never written.** They are still in `encrypted-log.ts`'s `buffered[]` at the cut. That is the designed segment interval and #158 did not touch it. ⚠️ **Partly closed since**: §7's park seal empties that buffer when the bike parks, which is 10 s to 7 minutes before the power goes — but only on the boots that park, which is about half of them.
2. **The one write in flight**, if the cut lands between the `write()` and the `datasync()`. The window shrinks from ~30 s of writeback delay to the duration of one flush; it does not become zero.
3. **A whole sweep's resume rows**, by the deliberate decision above.
4. **A cut during the `git pull` itself** — half-fetched objects, a stale `index.lock`. Unchanged. `deployHint` in `src/http/update.ts` already names that one and tells the rider to delete the lock.
5. **Every file we do not fsync.** `data=ordered` is not the cause and never was — it is the mode that forces data out _before_ the metadata referencing it is committed, and the mode where metadata may precede data is `data=writeback`. What defeats it here is `delalloc`: blocks that have not been allocated yet are not in the transaction that publishes `i_size`, so there is nothing for ordered mode to order. An explicit flush is what puts them there, and only the writes in the table above get one.
6. **An SD card that lies.** `fsync` is only as honest as the device. A card that acknowledges a flush it has not completed, or that loses an erase block mid-program, defeats all of this. That is the hardware half, and it is still open.

### Duplicates, on a flush failure

`sealSegment` puts its readings back for the next tick when an append fails. If it was the _flush_ that failed, the bytes are probably on the card already and the retry appends them a second time. `scripts/decrypt-log.ts` states that the `reading` table has no uniqueness constraint, so those land as duplicate **rows** and nothing removes them. They are identifiable by `session` + `seq` — identifiable, **not** deduplicated. Duplicate beats lost, which is why the retry is right, but the word matters.

### `rides.db` is not a Pi-side exposure at all

The service opens no database. `initDb` has no caller under `src/`; `rides.db` is rebuilt on the laptop by `scripts/decrypt-log.ts` (README, §`src/db.ts`). It is outside this issue's blast radius.

Recorded because it was measured and got the wrong answer once: better-sqlite3 ships SQLite compiled `DEFAULT_SYNCHRONOUS=2 DEFAULT_WAL_SYNCHRONOUS=1`, so under `journal_mode = WAL` the pragma reads `2` only until the first write transaction and settles to **`1` (NORMAL)** thereafter — and from the first read on any file already in WAL. NORMAL in WAL mode does not fsync per commit. Measuring it immediately after setting `journal_mode` catches the one moment it still says `2`.

## 5. Measurements

**Cost of a flush** — 200 × 1 KiB appends on the development Mac (APFS, NVMe): 3.5 ms with no flushing, 731 ms with `datasync()` on each, i.e. **3.64 ms per flush**. Independently reproduced at 3.91 ms.

That number is **not** extrapolated to the Pi: different filesystem, different device class, and the rails for this work barred ssh'ing the bike to measure it. What survives the difference is the frequency. The ride log flushes twice a minute, the audit journal about once per deliberate change to the bike, the snapshot twice per manually-started sweep, the resume file once per sweep. Even at a pessimistic 50 ms per flush on a poor SD card that is a 0.17 % duty cycle on one timer callback. No interval moved and no burst gained a per-item flush, so the functionality cost is none.

**Cost of one hole** — #158 records the loss per hole as unmeasured, because the private key is not on the Pi. Measured instead on a synthetic file of the same shape, in `scripts/check-power-cut-durability.ts` §5: 24 real segments sealed through `src/storage/encrypted-log.ts` into one `.celog` of about 4.75 kB, a **1710-byte NUL run** punched a third of the way in, then decrypted by `scripts/decrypt-log.ts` itself. (The exact byte figures move a few bytes per run — fresh nonces, gzip — so the reproducible result is the segment count, not the offsets.)

> A 1710-byte hole cost **9 of 24 segments** — exactly those whose bytes it touched — and every one of the 15 on either side of it was recovered.

That is the resync contract holding: `decrypt-log.ts` scans forward to the next `COOLEVA1` and carries on, so a hole costs the segments inside it and nothing else.

⚠️ **Do not read "9 of 24" across to the real log.** The synthetic file carries one reading per segment, ~198 bytes each, so nine segments is just 1710/198 — an artefact of the fixture. A real day file is ≥ 54.8 MB over at most 2880 segments, i.e. **≥ 19 kB per segment**, so a 1306–3398-byte hole lands inside one segment or straddles two: **30–60 s of readings per hole**, not minutes. The measurement is of the reader's behaviour; the segment count does not transfer.

> ⚠️ macOS `fsync` is not `F_FULLFSYNC`. A green check run on the development Mac proves the calls are made and the ordering is right — the **durability** claim is an ext4-on-Linux claim, and nothing in the suite can test it.

## 6. Deferred, and why

Everything here is out of scope for the code change and belongs to someone with the bike in front of them.

| Item | Why it is deferred |
| --- | --- |
| persistent journald (`Storage=volatile` today, so there is **no post-mortem log at all**) and sysctl writeback drop-ins | Pi config, not repo code. Needs Daniel's go-ahead. |
| service-level `WatchdogSec` | Separate track. The hardware watchdog (`RuntimeWatchdogSec=1m`) is already on. |
| `data=journal` — journals file _contents_, the general answer to §4.5 | Needs a USB-TTL adapter in hand before changing mount options on a machine reachable only over wifi. **Measured and recommended against in §8**, with the exact sequence if Daniel wants it anyway. |
| key-off rail measurement; a supercapacitor UPS with a power-fail GPIO | Hardware. ⚠️ It is no longer the _only_ thing that would close §4.1: the park seal in §7 closes it for the roughly half of boots that park, which a UPS would close for all of them. |

Already right, and worth not re-litigating: `fsck.repair=yes` is in `cmdline.txt`, the hardware watchdog is on, `unattended-upgrades` is not installed, `/tmp` is tmpfs, and the serial console is enabled.

## 7. What the bus actually says at key-off, and the seal that answers it

Issue [#57](https://github.com/danieltroger/cool-eva/issues/57) item 1 guessed _"If the CAN bus signals key-off we may get 1–2 s of warning."_ The warning is real and it is much larger than that — but it is not key-off.

**Corpus.** Every candump-format log in `~/Documents/cool-eva-archive`: 255 files, 16 GB, 97 carrying frames, 98 distinct boot ids. A capture name carries the boot id, so every file of a boot **except the last** ended because `candump` restarted while the Pi was still alive (pre-`-D`, #185). Only the **80 last-of-boot captures** ended when the Pi did, and every figure below is measured on those. Reductions: `evidence/keyoff/`, whose `figures.txt` is the generated source of every number here.

⚠️ **The corpus is six days old and narrow.** 78 of the 80 terminal captures fall in 2026-08-02…08-10, 22 of them on one day. Sixteen park measurements are not sixteen independent weeks.

### ❌ `key_on` is not a power-loss predictor

It appears before only **9 of the 80** boot-terminal captures, and where it does the bus keeps transmitting for **0.014 s to 2 996 s** afterwards (7 gap-free). In `rides.db` it fires 18 times across 14 sessions and **17 of the 18** are followed by 988 to 1 633 226 more readings. Acting on it would flush at a moment unrelated to the cut.

🟡 That also means the bit is **not confirmed to mean "the key is off"**, which `src/can/decode.ts` had listed as an open question. It moves, and its resting value is 1. What it names is still open, and a bit that clears while the bike runs for fifty minutes is evidence against the obvious reading rather than for it.

### ✅ Entering the parked state is a predictor, and a generous one

`0x101` b1 → 60, through the one-frame `60/63` edge `docs/can-0x101.md` identifies:

|  | n | lead to the last frame of the boot |
| --- | --- | --- |
| **observed park entries**, every one at `60/63` | **16** | **10.03 – 442.11 s, median 64.39 s** |
| captures that opened with the bike already parked (`60/62`) — file lengths, **not** park measurements | 12 | 30.98 – 393.36 s |

**Not one is under 10 s.** Five are under 30 s.

⚠️ The second row is not a narrower cut of the first; it is the population the first row has to exclude. An earlier version of this table reported 28 entries at a median of 93.03 s by counting both together — a capture that _opened_ on a parked bike scores as an entry only because nothing was watching before the file began, and its "lead" is just how long the file is.

**It is a lower bound twice over**, which is the direction that makes it safe to build on: the capture stops when the _bus_ goes quiet, which can only be at or before the Pi's death; and whatever the cut cost the file's tail moves the measured end earlier, never later. Independently, the three captures that record a complete shutdown walk end **0.000 / 0.184 / 1.367 s** after its last 0x101 substate change — `capture-20260802-203750-7ce067a7.log` (`1/2`), `capture-20260809-211759-1956320f.log` (`20/22`) and `capture-20260802-185513-563dd217.log` (`20/33`) — so on those the file ends essentially where the bus stopped. (Measured from the last **substate** change; from the entry into state 1 the same two files read 1.52 and 1.55 s. Two further captures enter state 20 and then reach `60/62`, so entering state 20 is not itself terminal.)

⚠️ **The gap rule is not hiding a short lead**, which is the obvious way this could be biased: 14 park intervals are refused for spanning a clock discontinuity, and the smallest raw lead among them is **248.99 s**.

### What the seal covers, and what it does not

`src/storage/seal-on-park.ts` seals the ride log on an observed entry into state 60. What it protects, measured on `rides.db`: the 30 s before the last park of each session holds **23 to 6 879 readings, median 527** across 40 sessions — the arrival, the final SOC, the last fix before the bike is left. (Under-counted: that uses the sparse BLE `vehicle_state`; `0x101` at 100 Hz catches every park.)

⚠️ **It covers about half the boots.** The last `0x101` state across the 80 terminal captures is 60 in 35, **100 (DC charging) in 20**, **80 (blocking fault) in 14**, 40 in 5, 20 in 5 and 1 in 1 — and **38 of 80 never show state 60 at all**. A boot that ends while charging or in a fault gets nothing from this.

❌ **Entering state 80 was measured as a second trigger and rejected.** 13 observed entries, lead **0.38 – 1 847.70 s**, eleven of them under 11 s. The minimum is too short to rely on and it is a fault state the bike recovers from, so it would fire when nothing is ending.

⚠️ **Unverified on the bike.** `vehicle_state_can` exists only because `0x101` entered `STREAM_IDS` on 2026-09-14 (`084b3e2`), which has never run on the Pi — and `docs/can-0x101.md` notes it adds ~100 RX wakeups and ~900 `record()` calls a second on a Pi Zero. The trigger inherits both.

### ❌ Why there is no `sync` here

`sync(1)` cannot reach what is still lost. §4.1's readings were **never written** — they are in `buffered[]` — and `sync` flushes writes, not intentions. Sealing is the only thing that converts them, which is why the answer to #57 item 1 is a seal and not a flush.

For the one other file being written continuously — the `candump` capture, which nobody fsyncs — the tail a cut costs is small: **83 of the 232 non-empty archive files end exactly on a 4096-byte boundary** (72 of those mid-line) and only **12 carry a trailing NUL run at all, of 20–1 527 bytes**. Call it ≤ ~5.6 kB, about 0.08 s of frames. And a `sync` at park cannot protect the 10–442 s of writing that happens _after_ it.

## 8. `data=journal`: the sequence, and why not to run it

🔥 **#158's fsync work held.** All **61** NUL runs of ≥ 64 bytes in the 322.3 MB `/dl` dump of 2026-09-13 lie at or below byte **122 320 758**. Decrypted 3 MB slices date bytes 104 M / 109 M / 117.2 M to **2026-09-07**, 122.4 M to **2026-09-08**, 200 M to **2026-09-10** and 300 M to **2026-09-13**. Every hole is in data written on or before 2026-09-08 — the day #158 merged as `a55b273` — and the ~200 MB written since, covering **80 boots**, carries none. The 09-07 region holds runs of exactly 1306 and 3398 bytes, the two endpoints §2's table gives for that file.

⚠️ **`data=journal` really would kill the mechanism §1 blames**, and this file previously declined to say so. From `fs/ext4/super.c`, `ext4_check_journal_data_mode()` at :5057, read rather than relayed:

```c
	if (test_opt(sb, DATA_FLAGS) == EXT4_MOUNT_JOURNAL_DATA) {
		printk_once(KERN_WARNING "EXT4-fs: Warning: mounting with "
			    "data=journal disables delayed allocation, "
			    "dioread_nolock, O_DIRECT and fast_commit support!\n");
		…
		if (test_opt2(sb, EXPLICIT_DELALLOC)) {
			ext4_msg(sb, KERN_ERR, "can't mount with "
				 "both data=journal and delalloc");
			return -EINVAL;
		}
		…
		if (test_opt(sb, DELALLOC))
			clear_opt(sb, DELALLOC);
```

**So the recommendation is still against it, but for a different reason than "it would not help".** It would. What it buys _now_ is the ≤ ~5.6 kB of unfsynced capture tail per cut from §7, because everything else the Pi writes is already flushed and has taken no hole in 80 boots. The price is every byte written to the card twice, on the one device that carries all of this. If the capture corpus later turns out to be losing something that matters, this is the lever — and it is Daniel's call, not a lane's.

⚠️ Two hazards, in the order they bite:

1. **It cannot be applied by `remount`, and `/etc/fstab` will not do it for the root filesystem** — which systemd applies by remounting. `ext4_check_opt_consistency()` (super.c:2789): `if ((ctx->spec & EXT4_SPEC_DATAJ) && is_remount) { … ext4_msg(NULL, KERN_ERR, "Cannot change data mode " "on remount"); return -EINVAL; }`. It needs `rootflags=data=journal` in `cmdline.txt` and a reboot.
2. 🚨 **An EXPLICIT `delalloc` beside it is `-EINVAL` at mount** — a root mount that fails, i.e. a Pi that does not come back, in a garage, over wifi. An _implicit_ delalloc (the default) is silently cleared by the `clear_opt` above and is safe. So the word is what kills the boot, and `/proc/mounts` shows **effective** options and cannot tell you whether anyone wrote it down.

**The sequence, for the coordinator, at the bike, with a USB-TTL serial console attached — and only on Daniel's GO:**

```sh
# 0. Rule the -EINVAL out. BOTH must come back empty; if either prints, stop.
grep -o 'delalloc' /proc/cmdline
grep ' / ' /etc/fstab | grep -o 'delalloc'

# 1. Back up the file you are about to make unbootable-able.
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.before-data-journal

# 2. cmdline.txt is ONE line. Append, do not add a newline.
sudo sed -i '1s|$| rootflags=data=journal|' /boot/firmware/cmdline.txt
cat /boot/firmware/cmdline.txt          # read it back before rebooting

# 3. Reboot with the serial console open, and watch for the two messages above.
sudo reboot

# 4. Afterwards, from the serial console or ssh:
grep -o 'data=journal' /proc/mounts     # expect one hit for /
dmesg | grep -i 'EXT4-fs.*data=journal' # expect the delayed-allocation warning
```

To undo: `sudo cp /boot/firmware/cmdline.txt.before-data-journal /boot/firmware/cmdline.txt && sudo reboot`. If it does not boot, the serial console is the only way in, which is why §6 defers this behind having the adapter in hand.
