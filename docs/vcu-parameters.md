# VCU parameters: how the tables were established, and what a write is allowed to do

The findings behind `src/vcu/` — which parameter values are proven, which were refuted, where every bound came from, and what a wrong write would do to a motorcycle. The code carries a sentence and a pointer to a section here; this is where the derivation lives.

Safety warnings that a reader must see **at the point of use** deliberately stay in the code. This file is the reasoning, not the guardrail.

Related, outside this repository: `obd-garage/DIAG_ADDRESSES.md` (the diagnostic channel), `obd-garage/PARAM_TABLES.md` (the 28-table measurement), `obd-garage/VCU_PARAM_CHANGES.md` (what has actually been written to this bike), `obd-garage/SERVICE_RESET.md` (routines and the service stamp), `obd-garage/CAN_MAP.md` (the frame map).

Sections:

1. [What is proven and what is not](#1-what-is-proven-and-what-is-not)
2. [`params.ecf`: the text and its provenance](#2-paramsecf-the-text-and-its-provenance)
3. [The 28 parameter tables](#3-the-28-parameter-tables)
4. [The table gate](#4-the-table-gate)
5. [The write allowlist, parameter by parameter](#5-the-write-allowlist-parameter-by-parameter)
6. [The write codec: what it can and cannot express](#6-the-write-codec-what-it-can-and-cannot-express)
7. [SecurityAccess and the write sequence](#7-securityaccess-and-the-write-sequence)
8. [The write runner: five locks](#8-the-write-runner-five-locks)
9. [The read path: read-only by construction](#9-the-read-path-read-only-by-construction)
10. [Multi-frame reads](#10-multi-frame-reads)
11. [The freeze-frame log](#11-the-freeze-frame-log)
12. [The service gate: when the bike may be serviced](#12-the-service-gate-when-the-bike-may-be-serviced)
13. [Service actions: the clock, and Mode 04](#13-service-actions-the-clock-and-mode-04)
14. [Snapshots on disk](#14-snapshots-on-disk)
15. [The backup CSV format](#15-the-backup-csv-format)
16. [The write audit journal](#16-the-write-audit-journal)

## 1. What is proven and what is not

As of 2026-08-16, and unchanged since:

- ✅ **The seed→key algorithm.** Four real A8 seed/key pairs off this bike's bus (`DIAG_ADDRESSES.md` §9.3) all satisfy it, and `scripts/check-vcu-params.ts` §13 asserts all four. This is the one part of the write path with live ground truth.
- ✅ **The `2E` write framing and its auth rule**, from a passive capture of Energica's own diagnostic software writing to this bike's A8 on 2026-08-08, and additionally exercised against this bike by `obd-garage/vcu_param.py` on 2026-08-09 — `VCU_PARAM_CHANGES.md` records five parameters written and persisting across a power cycle ("Write procedure — fully proven").
- 🟡 **The `31 FC` request bytes** are derived from Energica's own frame builder; the POSITIVE RESPONSE bytes `71 FC` are INFERRED, not logged (`SERVICE_RESET.md` §3). So `decodeRoutineReply` accepts the echo it expects and reports anything else as `unrecognised` rather than assuming success.
- ❌ **Nothing in `write-codec.ts` or `write-session.ts` has ever been transmitted by this repo. Not one frame.** None of the five allowlisted parameters has been written by this repo at any value. The direction of effect of `FCHG_CURRENT_GAIN` is not merely untested but genuinely unknown — see [§5](#5-the-write-allowlist-parameter-by-parameter).

The pure/transport split throughout `src/vcu/` exists for this reason: with the bike a week away (2026-08-16), the only claims that can be tested at all are the ones that live in a function taking numbers and returning numbers. `scripts/check-vcu-params.ts` exercises those branches.

## 2. `params.ecf`: the text and its provenance

`src/vcu/param-file.ts` holds Energica's own parameter-table text verbatim, plus the strict parser that turns it into rows.

### Why it is a separate module from `param-table.ts`

Three things used to live in one module: this text, the 28-table catalogue, and the question "which table is this bike on". They are separate now because the catalogue (`table-catalog.ts`) is BUILT from this text — every one of the 28 tables is stored as a delta against these 277 rows — so the text has to be importable without pulling in the catalogue that depends on it. `param-table.ts` is still the module everything else imports; it re-exports what is in `param-file.ts`.

### Provenance

`PARAMETER_FILE_TEXT` is `VCU/params.ecf` from Energica's own tooling, copied in verbatim on 2026-08-09 apart from stripped trailing whitespace. It is COPIED rather than read from disk at runtime on purpose: the original lives in one owner's iCloud folder, that path exists on exactly one laptop, and this repo is meant to be usable by other Energica owners. Keeping it as the literal file text (rather than 277 hand-typed object literals) means it can still be diffed against the original, and a name stays greppable.

### ⚠️ Which table this text is: 16406

`params.ecf` came off a bike running table **16406** (`0x4016`), which is one revision older than the bike this repo was built for — that one reports **16407**. The file says so itself: its own ids 276/277 (`TABLE_TYPE_uC`/`_uS`) both read 16406. Established offline 2026-08-16 by matching all 277 names against Energica's shipped bundles; `obd-garage/PARAM_TABLES.md` is the working.

So this text is the CATALOGUE'S BASE, not anybody's answer. `table-catalog.ts` carries all 28 of Energica's tables as deltas against it and checks each reconstruction against a fingerprint taken from Energica's own bundle — including 16406's, which is therefore a load-time proof that this text really is 16406 rather than a claim in a comment.

### ⚠️⚠️ The values in it are not any particular bike's

The file came off ONE Energica — `MODEL` 8452 where the Ribelle this repo runs on reads 358, `CELL_COUNT` 80 where that bike reads 81. Of the 233 parameters the A9 serves, **21 read differently on the Ribelle**, including `MAX_DC_CHG_CURRENT` (60 in the file, 75 there). That is why the field is called `otherBikeValue` and not `value`, `defaultValue` or anything else a caller could render as a reading. The only honest use for it is as a comparison column explicitly labelled as another bike's, which is how `obd-garage/DIAG_ADDRESSES.md` presents it. Use the table for names, widths and routing; get values from the bike.

And it is a comparison against a 16406 bike specifically. `table-catalog.ts` therefore drops `otherBikeValue` and `section` for any id whose NAME differs in the table being built — on a `RegenFade` table, id 70's "other bike says 80" is a fact about `CELL_COUNT`, and `RegenFade_0` is not `CELL_COUNT`. See `dropWhereRenamed()`.

### Why the index column is an address

`CommonIdentifier = (bank << 12) | id`, and bank 1 is EEPROM Calibration Parameters, so parameter _n_ is read with `22 [0x10|hi] [lo]`. Established in `DIAG_ADDRESSES.md` §4 and confirmed live on both micros 2026-08-08: 23 parameters read in `10 81` sessions, all 23 echoing the identifier back with a correctly-sized record.

Re-checked in full on 2026-08-09 against the stored 2026-06-14 A9 dump (`obd-garage/kwp_scan_raw.txt`), which is what `scripts/check-vcu-params.ts` reproduces:

- the file assigns exactly 233 indices to the A9, and the dump holds exactly 233 bank-1 records — the two index SETS are identical, with no id in one that is missing from the other;
- the TYPE column predicted the record length for all 233 (BYTE/BOOL → 1, WORD → 2), zero mismatches;
- 212 of 233 values are byte-identical to the file, and the 21 that differ all differ as variant tuning, never as an off-by-one — an off-by-one index would scramble the magic numbers (40000, 3600, 3300), and none of them moved;
- the S/U column is real: signed parameters holding negative values in the file (e.g. `TH_LOW_B_L_TEMP` −25) match the bike's two's-complement bytes.

### ⚠️ Routing: trust the µC column, not a range

A parameter must be requested from the micro that owns it or it simply does not answer. `DIAG_ADDRESSES.md` §4 summarises the split as "223–256 and 266–277 on the A8, the rest on A9". The first range is right and the SECOND ONE IS NOT: **274 `EEPROM_VERSION_uC` and 276 `TABLE_TYPE_uC` are A9**, sitting between A8 entries. The A8 set is 223–256, 266–273, 275 and 277 — 44 indices, which is the count that section's own consistency check quotes. The `_uC`/`_uS` suffixes are the giveaway: the control micro's copy of a pair lives on the control micro. Hence: never derive routing from an index range, always read `micro`.

✅ And that holds for EVERY table, not just this one: `id → ecu` and `id → datatype` are byte-identical across all 28 of Energica's bundles (measured, `PARAM_TABLES.md` §2). Names and signedness are what vary. That is exactly why a wrong table is dangerous rather than obvious — see [§4](#4-the-table-gate).

`CAN_MAP.md` logs 45 records for A8 bank 1 against these 44. The 45th is unidentified — this variant's file may simply not name it. A sweep reads the whole table and nothing beyond it, so going looking would mean adding the index to `params.ecf`; an identifier with no table entry reads back as raw bytes rather than failing, which is what makes that safe to try.

### ⚠️ Names are not unique

Four names appear twice — `VSM_DUMMY_WORD8`/`9`/`10`/`11` at indices 11-14 and again at 22-25 — and two of those pairs disagree about their own width (13 is a signed BYTE, 24 a WORD). So "read the parameter called X" can be an ambiguous question, and `param-table.ts`'s `parametersNamed()` returns an ARRAY rather than picking one. A caller that silently took the first match would answer a question it was never asked. All four are `_DUMMY_` placeholders, so this is unlikely to matter in practice; it is handled anyway because the failure would be silent.

### The parser is strict on purpose

Format, one parameter per line, whitespace-separated: `<index> <NAME> <BYTE|WORD|BOOL> <S|U> <A8|A9> <value>`. `[SECTION]` headings group them and carry no data; blank lines are skipped; anything else throws, naming the line. A bad edit to the embedded text then fails immediately and visibly rather than silently dropping a row — which would turn a named parameter into an "unknown identifier" much later and much quieter. `parseParameterFile` is exported so `scripts/check-vcu-params.ts` can point it at a fresh copy of the original file and prove the two still agree.

## 3. The 28 parameter tables

`src/vcu/table-catalog.ts` carries every parameter table Energica ships, keyed by the number the VCU reports for itself.

### ⚠️ Why a repo that runs on one motorcycle carries 28 name tables

A VCU calibration parameter is addressed BY INDEX. What index 258 IS depends on which table the VCU runs, and Energica has shipped many: the 2024 service-tool build selects 28, and `id → name` differs at 151 of 278 ids somewhere among them. Routing (`id → micro`) and record width (`id → datatype`) are IDENTICAL in all 28 — measured, `PARAM_TABLES.md` §2 — which is precisely what makes the wrong table dangerous instead of obvious: a write under a wrong name goes to the right micro with the right number of bytes, gets a positive response, and reads back exactly as sent.

The worst instance is not hypothetical and is the reason the catalogue exists. On 20 of the 28 tables, ids 70–94 are `RegenFade_0` … `RegenFade_24`, a regen-shaping curve. On the other 8 the same ids are the BATTERY CELL BLOCK — `CELL_COUNT`, `CELL_OVERVOLTAGE`, `CELL_TARGET_AC`, `CELLV_KA`. Another owner's tool has a live bug of exactly that shape: it writes a regen curve into the cell configuration. Carrying one hardcoded table and hoping is how you ship that bug; carrying all of them and refusing when the bike names one we do not have is how you do not.

### How they are stored: deltas against `params.ecf`

`table-catalog.data.ts` holds one entry per `TABLE_TYPE`, each a list of the ids whose NAME or S/U column differs from `param-file.ts`'s `params.ecf` text (which is itself table 16406). ~32 KB for all 28, against ~1.1 MB for 28 standalone JSON tables — this runs on a Pi Zero, and 27 of those copies would be re-saying the same 277 rows.

It is also the more reviewable artefact. A contributed table's diff is exactly the list of ids it renames, which is the thing a reviewer needs to look at.

Measured 2026-08-18 (laptop; a Pi Zero 2 W is several times slower):

| cost    | what for                                                                                |
| ------- | --------------------------------------------------------------------------------------- |
| 46 KB   | of source for all 28 tables, ~1.1 MB if they were standalone JSON                       |
| 6.5 ms  | importing `param-table.ts`: parse `params.ecf`, build the default table, fingerprint it |
| 0.26 ms | building one further table on demand                                                    |
| 3.8 ms  | building all 28, for +1.87 MiB of heap                                                  |

So they are built LAZILY: a Pi bolted to one motorcycle builds one table and keeps ~1.9 MiB it would otherwise spend saying the same 277 rows 27 more times. Verifying all 28 belongs in `scripts/check-vcu-params.ts` §1e, which runs in CI on every change to this data and is where a corrupt delta gets caught before it reaches a garage.

### ⚠️ The self-check: a fingerprint per table, taken from Energica's bundle

A delta is only as good as the base it was computed against, and the base is a text file one owner copied off one bike. If that text is ever re-copied, re-ordered or edited, all 28 reconstructions move together and nothing about them looks wrong.

So each entry carries a fingerprint of the WHOLE table, computed by `scripts/extract-vcu-tables.ts` from the bundle's own records before any delta arithmetic, and `buildTable()` recomputes it from the reconstruction and throws if they disagree. That is the generalisation of the check this module replaced, which threw at module load when `params.ecf` stopped saying what a hardcoded one-id correction expected. 16406's own entry has an empty delta, so its fingerprint check is a load-time proof that the embedded text really is table 16406 — a claim that used to live only in a comment.

⚠️ A fingerprint proves the delta rebuilds the bundle it was taken from. It cannot prove the bundle was labelled correctly in the first place; that comes from the resource NAME inside the service-tool executable, which is the one thing binding a table to a `TABLE_TYPE`. `scripts/extract-vcu-tables.ts` explains why a byte-scan loses it.

### ⚠️ What is not in Energica's bundles

No values (`vehicleValue` is null in all 28) and no `[SECTION]` grouping. Both come from `params.ecf` and therefore describe a 16406 bike. `dropWhereRenamed()` is the rule that keeps that honest.

### Null is the important case

`parameterTableFor()` returns null when this software does not carry the table, and that must never be softened into "here is our best guess". A bike on a table we do not have is a bike whose parameter names we do not know, and `table-gate.ts` turns that null into a refusal to write plus an instruction for adding the table. Returning the default table instead would produce a plausible, confident, wrong set of names — which on a `RegenFade` bike means calling id 70 `CELL_COUNT`.

Tables are built on first use and cached, so a Pi that only ever sees one bike only ever pays for one table. `parameterTableFor()` throws if the rebuild does not match the recorded fingerprint: that is a fault in this repo's own data, and a name table that disagrees with itself is worse than one that is merely narrow.

### ⚠️ Why there is an ACTIVE table rather than one table

`src/vcu/param-table.ts` answers the question the other two modules cannot: _whose bike is this_.

A parameter is addressed by index, and what an index means comes from the table the VCU runs. This repo used to encode one — 16407, the Ribelle it was written for — and refuse everything else. That was safe and it was narrow: on another owner's bike every name could be wrong, and on the 20 tables where ids 70–94 are `RegenFade_0…24` rather than the battery cell block, "wrong" means calling a regen curve `CELL_COUNT`.

So the names are now selected from what the bike reports at 276/277 instead of being assumed. Reads name themselves correctly on any of the 28; writes still refuse unless the bike named a table this software carries.

⚠️ THE ACTIVE TABLE IS NOT WHAT MAKES A WRITE SAFE, and must never be relied on for that. It is module state, it is set from a snapshot on disk, and it is right only for as long as the Pi is bolted to the bike it was last swept on. The write path re-derives the bike's table from the raw `TABLE_TYPE` words in the report it is handed, every time, and additionally checks that this table encodes the allowlist's five parameters the same way that one does — see [§4](#4-the-table-gate) and [§5](#5-the-write-allowlist-parameter-by-parameter). Selection is for NAMES; the gate is for BYTES.

`selectParameterTable()` refuses rather than throws for an unknown table, and leaves the previous table in place. A bike this software does not carry the table for must still be readable — the names will be another table's and every surface says so, and the way OUT of that state is a read. Throwing there would take the service down on the one bike that most needs to be able to report what it saw. It throws for one thing only: a table in the catalogue that does not rebuild to its recorded fingerprint, which is this repo's own data disagreeing with itself. It logs on every change and on every refusal, because this decides what every parameter on the dashboard is called and a silent switch is exactly the kind of thing that is baffling six months later in a garage.

### Retabling a snapshot

`retableSnapshot()` re-derives every row's NAME, section, width, signedness and typed value from the table the snapshot itself named. This is what makes a sweep of somebody else's bike come out right. A row is named when it arrives, from whatever table was active at that moment — and on a first sweep of an unfamiliar bike that is a default, because `TABLE_TYPE_uC` is read partway through the A9 pass and `TABLE_TYPE_uS` at the very end of the A8's. Without it, the first snapshot off a `RegenFade` bike would be stored, served, exported and diffed with ids 70–94 labelled `CELL_COUNT`, `CELL_OVERVOLTAGE`, `CELLV_KA` — the exact confusion the catalogue exists to prevent, written to disk.

⚠️ PER MICRO, because the two micros answer separately and can disagree. Each row is named from the table ITS OWN micro reported:

- the micro named a table we carry → its rows come from that table. Under a `split` this means the A9's 233 rows are named from one table and the A8's 44 from the other, which is the only honest reading of a bike that says it is like that.
- ⚠️ the micro named a table we do NOT carry → its rows lose their name, section, width, sign and comparison value. It has told us it is running something else, and borrowing the other micro's table for them would be a confident wrong label on exactly the half that disagreed. The raw bytes are kept, because they are real.
- the micro was never asked, or answered unusably → the table the rest of the report agrees on, if there is one. Unread is not the same as contradicted: a micro that has never spoken gets the benefit of the doubt, and today that is the A8 on this repo's own bike.

It is pure, and takes the report the caller already computed from this snapshot rather than re-deriving it — which is also what makes the dependency visible: the names in a stored snapshot are a view derived from that snapshot's own `TABLE_TYPE` rows.

⚠️ The typed `value` is recomputed from `rawHex`, not carried across. Signedness varies at 30 ids between Energica's tables, so the same two bytes are −350 under one and 65186 under another. Carrying the number forward would keep a value that the new name's own S/U column contradicts.

### Reading the table type back

`reportTableType()` is the check that stops the 2026-08-16 correction from being a one-off. The embedded name table was 16406 for a week while the bike had been reporting 16407 since 2026-06-14 — in a dump that had already been taken, in a parameter that had already been read. Nobody looked. Every name in the UI was therefore a claim about a table nobody had checked, and it happened to be wrong at exactly one id.

So every sweep now reads its own table type back out and says whether the names it just printed describe the bike that answered.

⚠️ The two micros are asked SEPARATELY and can disagree. 276 `TABLE_TYPE_uC` is the A9's, 277 `TABLE_TYPE_uS` is the A8's, and they sit in separate EEPROMs. On the bike this repo runs on, only the A9's has ever been read (2026-06-14); id 249 — the one id where 16406 and 16407 disagree — is an A8 parameter, so the A8's answer is the one still outstanding. A per-micro verdict is what makes "they disagree" expressible at all, and `split` is what stops a disagreement being averaged away.

A row's `name` being null is not an error, and it means one of three things: an index outside what that table describes (most run 1…277 with no gaps, but 61451/61452 carry a 278th, id 300 `MOTORING_MAP`, so an id one table has and another does not is an ordinary outcome); a bike with more parameters than any table here knows, which shows up the same way with its raw value intact; or the owning micro named a parameter table this software does not carry, so nothing can say what this index is called. (260/262/263/265 are named EVSE placeholders that read 0 on this bike, not unnamed slots.)

## 4. The table gate

`src/vcu/table-gate.ts` answers: does this Pi know what this bike's parameter indices are CALLED — and may a parameter write go ahead on the strength of it?

### ⚠️ The question this gate asks changed, 2026-08-18

It used to be "is this the bike this repo was written for?" — one hardcoded table, 16407, and every other value refused. That was safe and it was useless to anybody else. It is now **"do we have your table?"**: all 28 tables Energica's 2024 service tool can select are carried, so a recognised one PASSES whichever of the 28 it is, and an unrecognised one still refuses — with the instruction for adding it, because that is a thing an owner can actually do.

### ⚠️ Why a write needs this and a read does not

A parameter is addressed BY INDEX, and what an index means comes from the table. Routing (id → micro) and record width (id → datatype) are invariant across all 28 of Energica's tables, so a write aimed at a name under the wrong table still goes to the right micro with the right number of bytes: the micro accepts it, the read-back agrees, the audit journal records a success — and a different parameter has changed. 151 of 278 ids carry a different name in at least one other table. There is no NRC, no reply shape and no read-back that can report this, which makes it precisely the silent-wrong-answer failure this repo spends its effort on everywhere else.

The sharpest case is real rather than imagined: on 20 of the 28 tables, ids 70–94 are `RegenFade_0` … `RegenFade_24`; on the other 8 the same ids are `CELL_COUNT`, `CELL_OVERVOLTAGE`, `CELL_TARGET_AC`, `CELLV_KA` and the rest of the battery cell block. Another owner's tool writes a regen curve into that block today because it carries one table and does not ask.

A READ under the wrong table is wrong in a way that can be survived: it prints a name next to a number and nothing on the bike moves. It is also the only way out of here, because the remedy IS a read. So reads are deliberately not gated, and must not be — a gate that blocked the read that opens it would be a gate nobody could ever open.

### Fail closed, but say WHICH closed

Five ways to be shut, and they get five sentences because their remedies do not overlap at all:

| state | what happened, and what fixes it |
| --- | --- |
| `mismatched` | the bike named a table this software does not carry. No read helps. The fix is `scripts/extract-vcu-tables.ts` against your own service-tool install, and the remedy string says so in as many words. |
| `split` | the two micros named DIFFERENT tables. Also no read; the bike really may be like that, and no single set of names is right for it. |
| `unwritable` | the table is carried, and one of the allowlist's own parameters is not called that on it. The allowlist is what needs the work, not the bike. |
| `unusable` | the micro answered with a record the width column forbids, so it named no table AND the framing of the whole sweep is in question. Re-reading is worth doing, but the fault is not "unasked". |
| `unread` | one read clears it, and the gate names exactly which one. |

Collapsing those into a single "writes are blocked" would send someone hunting for a software bug when the answer was one frame, or the other way round.

### Why the refusal spells out the read

`readInstructionFor()` names which micro, which index, what the request is on the wire, that it changes nothing and needs no SecurityAccess, and where to do it so the answer survives. That is why the gate is worth having rather than merely being safe: a refusal that stopped at "the table type is not confirmed" would be a refusal nobody could act on, and the honest end of that road is the gate being switched off.

⚠️⚠️ SEEING THE ANSWER AND RECORDING IT ARE DIFFERENT ACTS, and an earlier version of that sentence conflated them — which made it worse than saying nothing. The gate is fed from the last SWEEP's snapshot (`latest.json`, written by `snapshot-store.ts`'s `writeSnapshot`, called from exactly one place: the end of a sweep). A one-identifier probe (`/vcu-probe`) performs precisely this read and returns it in an HTTP response that nothing persists — so someone who followed the old wording saw `0x4017` on screen, went back, and found the button still amber with the identical message and nothing to explain why. The probe is still named, because it IS the one-frame way to find out what the bike says; it is now named as what it is.

⚠️ It no longer says what the answer SHOULD be. Any of the tables this software carries is a good answer. Naming one would be telling an owner their bike is wrong.

### ⚠️ Which actions the gate applies to, and why the others are exempt

The gate exists for ONE failure: a parameter is addressed by index, what an index means comes from the parameter table, and a write under the wrong table is accepted, reads back cleanly and has changed something else. That argument is about index-addressed writes and does not survive being generalised:

- `31 FC` **Set Service Point** takes a routine LOCAL identifier, not a bank-1 parameter index. Routine ids are not in `params.ecf` at all — they come from the service tool's shared library (`SERVICE_RESET.md` §3) — and none of the 28 parameter tables says anything about them. `TABLE_TYPE` therefore carries no information about what `31 FC` does. (It IS ambiguous: `SERVICE_RESET.md` §7 records `0xFC` also meaning `VCUCheckSum` in the FLASHING enum. But that ambiguity is per ECU and session, which `write-codec.ts` pins with `ROUTINE_MICROS`; reading 277 would not resolve it by a single bit.)
- **Mode 04 clear-DTCs** is standard OBD-II with no identifier of any kind. Trouble codes are reconciled against `src/diagnostics/dtc-table.ts`, not against `params.ecf`.
- The **`0x120` clock broadcast** is a raw frame with a fixed layout and no identifier, addressed to nothing.
- **read-service-stamp** is read-only, and reads ids 1000-1003 — outside the name table's 1…277 entirely, from `SERVICE_RESET.md` §2 rather than from any table.

So gating them would be superstition: a refusal resting on evidence with no bearing on the action. It would also cost something real. The remedy for the state this bike is in TODAY is a read, reads share this page and this gate's vocabulary, and a precondition that blocks harmless actions for a reason nobody can connect to them is how a gate stops being believed — which is expensive precisely where it IS load-bearing. The fail-closed instinct is right about parameter writes and proves too much about everything else; taken to its end it would gate the reads too, and the reads are the way out.

The honest counter-argument, recorded rather than hidden: an unconfirmed table means this software may not understand this bike as well as it thinks, and Set Service Point is irreversible. It does not carry, because `31 FC` is `31 FC` on all 28 tables — the uncertainty is real and simply does not touch that frame.

## 5. The write allowlist, parameter by parameter

`src/vcu/write-targets.ts` is the only place in this repo that decides which VCU calibration parameters may be written, and to what.

### ⚠️ Why an allowlist and not a range check on an arbitrary identifier

Bank 1 is the VCU's calibration EEPROM. Two identifiers away from the five below sit `CELL_OVERVOLTAGE`, `THROTTLE_MAX_TH`, `ACTIVE_CURRENT_LIMIT` and `LIMP_MIN_CELL`; one mistyped index writes a cell limit or a throttle map instead of a charge current, and `obd-garage/VCU_PARAM_CHANGES.md` is a list of how interdependent those are (change `CELL_TARGET_AC` without `CHG_OVERSHOOT` and the charge stops with the same symptom you were trying to fix). A range check cannot see that. A closed list of parameters someone has actually reasoned about can.

So: an identifier not on the list is not "out of range", it is UNEXPRESSIBLE. There is no `writeIdentifier(id, value)` anywhere in this repo, the HTTP layer takes a NAME rather than a number (`src/http/vcu-write.ts`), and `write-codec.ts` re-checks the plan against `write-targets.ts` immediately before the bytes are built.

Adding a sixth entry means writing down what it does, what its bounds are and why — which is the friction that file exists to create.

### ⚠️ The ranges are POLICY, not measured hardware limits

Every bound is stated with its reasoning, and most of the reasoning is "this is as far as anyone here has an argument for", not "the hardware fails past here". They are deliberately narrow: a bound that is too tight costs one PR to widen, and a bound that is too loose costs a calibration EEPROM. Where a number IS anchored to something measured, the anchor is named below.

### ⚠️ The list is a list of NAMES, and a name is a claim about a table

Every entry pairs a name with an index, and which parameter that index IS depends on which of Energica's parameter tables the bike runs. There are two checks for that, and they answer different questions:

- `parameterFor()`, at module load — does the allowlist agree with the table this Pi is naming parameters from? A code-versus-code check between two files in this repo, so it THROWS: a service whose own allowlist disagrees with its own name table must refuse to start rather than write 80 into whatever now sits at index 258. Same reasoning as `param-file.ts`'s strict parser. ⚠️ It checks against the table this Pi currently NAMES parameters from, which is a default until a bike says otherwise, so it is a check on this repo's own consistency and not on any motorcycle.
- `allowlistProblemsIn()`, per write, through `table-gate.ts` — does the allowlist agree with the table THE BIKE named? That one cannot throw, because the answer belongs to a motorcycle rather than to a build; it comes back as a refusal with a sentence. ⚠️ It compares width, signedness and micro as well as the name, because those are what turn a value into bytes — signedness varies at 30 ids between Energica's tables, so a table that agreed on every name and disagreed on one S/U column would still encode −1 as `0xFFFF` where the bike expected `0x0001`. It compares the bike's table against the ACTIVE one rather than against the allowlist alone, because the active table is what `buildPlan()` will encode with.

✅ As of 2026-08-18 all five ids — 16, 48, 49, 258, 259 — are identical in name, width, signedness and micro across ALL 28 tables Energica ships in the 2024 build (measured; `scripts/check-vcu-params.ts` §1e re-measures it on every run). So the second check has nothing to refuse today. It is there for the tables this repo does not have yet: another owner has reported a build carrying roughly five more, one of them for a Corsa. What neither check can see is a rename in the OTHER direction — a table where some other id is called `MAX_DC_CHG_CURRENT` — which is why `snapshot.ts`'s `reportTableType()` exists and why a sweep says out loud which table the bike named.

### The compare-and-swap

`planWrite` takes `previousValue`: what the caller believes the bike currently holds. It is NOT decoration. `write-session.ts` re-reads the parameter off the bus and refuses the write when the bike disagrees with it. That turns every write into a compare-and-swap, which is what stops a page left open since yesterday writing 80 over a value that has since been changed by something else — and it is the same discipline `snapshot-store.ts` already applies to snapshots.

`planWrite` returns a reason rather than throwing, because every rejection there is a person typing into a box on a phone. `write-codec.ts` throws on the same inputs, one layer later, for the cases that are bugs.

### Bit writes, and why there is no way to write a config word

`planBitWrite` computes the new word FROM the word the bike currently holds, and the result is checked to differ from it in that one mask and nowhere else. So there is no input to that function — none — that can change the PSU type or the Bluetooth variant, whatever a caller sends. A nonsense current word is refused rather than masked into range, because the current word is the base every bit of the new one is copied from and a nonsense one would be written straight back into the EEPROM with one bit changed.

The failure this prevents is documented rather than imagined: Energica's own option file describes `OP0024` as "value 4, mask 4", and another owner's tool warns in as many words that "writing the label's value over the whole parameter would clear the others". Writing `4` into `VSM_CONFIG_1` would turn off fast charging, the IO extension, the PSU type and Bluetooth in one go.

`rebuildBitPlan` is the verifier's counterpart: a finished plan carries the new WORD, not the bit and the boolean that produced it, so it works backwards — finds which mask changed, refuses unless exactly one allowlisted bit accounts for it, then rebuilds through the normal path. A plan whose word differs from its predecessor in the PSU-type field, or in two bits at once, has no bit that explains it and is refused.

The registered verifier re-runs the SAME entry point a legitimate caller would have used, so the range check and the bit-mask check are re-applied and not merely the encoding: going straight to `buildPlan` would accept an in-width but out-of-range value — 127 into a parameter bounded at 80 encodes perfectly well as one signed byte. It then compares byte for byte, because the value could match while the bytes did not if a plan were assembled with a hand-written record, and it is the BYTES that reach the bus.

`encodeRecord` returns null rather than truncating. A truncated write is the worst failure that module could produce: it would be accepted by the micro, read back as whatever the low bytes happened to say, and leave a calibration cell holding a number nobody chose.

### `warnings` and `verify` are read at different moments

`verify` is kept OUT of `warnings` on purpose, and it is not a filing tidy-up: the two are read at different moments. `warnings` is the argument against pressing the button and is worth having in front of you first; `verify` is the first thing you want once you have pressed it, and standing in a garage that is a different screen. `public/views/vcu-write.js` shows it after the write for exactly that reason. It is null where nothing outside the read-back can confirm the change — which is itself worth saying rather than inventing a check.

### 258 `MAX_DC_CHG_CURRENT` — bounded 0…80 A

BYTE S per `params.ecf`, and Energica's own option data gives `mask=0x7F` — bit 7 is reserved, so the value field is 0…127 whatever the sign column says. **A bound of 80 is inside that mask; anything that pushed a written value past 127 would set the reserved bit, and a dealer's write would come back as a dead sensor.** 80 is `0x50`, bit 7 clear, so the sign question does not arise at any value on this list.

The unit is literal amperes: the service tool writes the integer 75 with no scaling anywhere (the 2024 service-tool analysis in `obd-garage/`), and 75 appears verbatim as `0x4B` in three independent broadcast fields — `0x620` b0, `0x625` b2 and `0x121` b4.

The ceiling is 80 because Energica shipped exactly that: OP0002/OP0003/OP0004 are "Fast Charge 60 / 75 / 80 Amps", all three writing THIS parameter and nothing else. That is the evidence the owner remembered, and it holds up in two separate service-tool builds. It is worth noting how unusual that is in the option data — `OP0100 Charge Limit 4300` moves four parameters together — so "only this byte" is a positive finding rather than an absence of evidence.

The floor is 0: turning DC charging DOWN is the safe direction, and is the obvious thing to want if a charger or the pack is unhappy. Nothing above 80, because past it there is no factory variant to point at and the next thing in the chain is the pack.

What the owner is told before pressing the button (the `warnings` array, which stays in the code):

- ⚠️ It will probably do nothing. Across eight logged DC sessions the ceiling is the STATION, not the bike: station identity explains 84 % of the variance, the highest ever delivered is 73.2 A, and no station has offered even the 75 A already permitted.
- ⚠️ 80 A is 1.25C for this pack. The cell datasheet allows 1.10C = 70.4 A, and only between 25 and 35 °C — and the VCU is shown 35 °C while the pack is really at 44-54 °C, so 91 % of DC charging time above 30 A is already over the cell's fast-charge ceiling. This raises the ceiling on an exposure that is already there.
- A dealer visit reverts it. The service tool reinstalls parameter values from Energica's server, keyed by VIN.

Free verification, no charger needed: `0x625` b2 is the configured max DC current and is broadcast on a merely-awake bike. It should read the value you wrote (`0x50` for 80 A, `0x4B` for 75). If it does not, the write did not take.

### 259 `FCHG_CURRENT_GAIN` — bounded 0…512, meaning unknown

WORD S per `params.ecf`. Reads 225 on this bike (live, 2026-08-08) and 225 in the other bike's variant file too, despite that bike's ceiling being 60 A rather than 75 — which is itself an argument that it does not set the ceiling.

⚠️ There is NO documented range for this parameter. It is not an Energica option, it does not appear in the 2021 or 2024 service-tool builds by name, this bike's firmware bundle ships no engineering range file, and 225 is the only value anyone has ever seen. So 0…512 is this repo's policy and nothing more: wide enough to hold both "unity" candidates and a doubling either side, narrow enough that a typo cannot write 30000. A tight range around a number whose semantics nobody has established would be false precision.

What is unknown, and why (the `warnings` array stays in the code):

- ⚠️⚠️ THE DIRECTION OF EFFECT IS UNKNOWN, and this is a genuine 50/50 rather than a gap someone forgot to close. If it is a MEASUREMENT CALIBRATION — which the name argues for — then raising it makes the bike believe it is drawing ~13 % more than it is, and it would back off SOONER, not later. If it sits in a denominator instead, it would draw more. Nothing anywhere derives which.
- ⚠️ Third possibility, and it is not remote: the DC charge is regulated by a PID loop (`CELLV_KA`/`KAI`/`KAD` against `CELL_TARGET_DC`), and a "gain" of 225 in the EVSE block may be a controller gain in that loop. If so, 225 → 255 changes loop DYNAMICS, not the ceiling — and a badly chosen loop gain oscillates.
- ⚠️ **The arithmetic that produced 255 has been RETRACTED.** "75 × 225/255 = 66.18 A" matched an observed ceiling to three figures, which is where 255 came from — but the wire request was later measured at 75 while 66.2 A flowed, and 73.2 A was delivered on another day with no parameter change. Both facts are incompatible with a fixed 88 % gate on the request. It is now treated as numerology.
- **Change ONE parameter per charge session.** With the station explaining 84 % of the variance, two changes at once cannot be told apart afterwards. Get `MAX_DC_CHG_CURRENT` = 80 into the bag first.

No broadcast field carries this one, so the read-back is the only confirmation the cell took it. What it DOES is a question for the next DC session — logged, at a station you have used before, with nothing else changed.

### 48 `TORQUE_LIMIT` — bounded 0…2760 (0…276.0 Nm)

WORD S, 0.1 Nm per count. This bike reads 2300 = 230.0 Nm.

The ceiling is 2760 = +20 %, and it is a POLICY bound with one piece of reasoning behind it: 20 % is the same step the owner already took on `REGEN_TORQUE_LIMIT` (500 → 600) on 2026-08-09, and there is no measured figure anywhere in `obd-garage/` for how much torque this motor and this pack will actually deliver — so a larger number would be a guess dressed as a limit. The floor is 0: reducing torque is the safe direction.

Torque may already be clipping against `ACTIVE_CURRENT_LIMIT` (400 A), which is NOT on the allowlist. If nothing changes, that is the likely reason. Nothing broadcasts this parameter, so the read-back is the only confirmation the cell took it; whether it changed anything is felt at full throttle.

### 49 `REGEN_TORQUE_LIMIT` — bounded 0…900 (0…90.0 Nm)

WORD S, 0.1 Nm per count. Factory 500; this bike was set to 600 = 60.0 Nm on 2026-08-09 (`VCU_PARAM_CHANGES.md`).

900 = 90.0 Nm, i.e. +50 % on today's value. Wider than `TORQUE_LIMIT`'s bound because regen is the gentler direction and because `VCU_PARAM_CHANGES.md` already records the suspicion that regen clips against `REGEN_CURRENT_LIMIT` (142) at 120 A well before torque runs out — so the interesting experiment is "does more headroom change anything", and it needs room to answer no.

⚠️ `REGEN_MAP0..3_TRQ` (63-66) read 10/20/30/40 and are almost certainly PERCENTAGES of this limit, so raising it scales every regen map at once. Engine braking that suddenly got stronger is a handling change, felt first when you close the throttle mid-corner. Whether it does anything shows up as regen current on the next ride: if that still tops out around 120 A, `REGEN_CURRENT_LIMIT` was the cap all along.

### 16 `VSM_CONFIG_1` — one bit, never the word

WORD U. This bike reads `0x1113`, and every set bit is accounted for:

| mask     | meaning                                 |
| -------- | --------------------------------------- |
| `0x0001` | Fast Charge                             |
| `0x0002` | VCU IO Extension                        |
| `0x0010` | VCU IO Ext. PRW+                        |
| `0x0100` | PSU type TDK-600W (field mask `0x0760`) |
| `0x1000` | Bluetooth STD (field mask `0x3000`)     |

Bit map from Energica's own option data (the 2024 service-tool analysis in `obd-garage/`), decoded against the live value in `obd-garage/HEATED_GRIPS.md` §4.2.

ONE bit is offered, `0x0004` heated handlebars. Not the word. Energica's option OP0024 sets exactly this bit and nothing else — but activation is normally granted per-VIN on Energica's server, and the option carries a firmware floor (FW.Min.V \*.042). The bit may therefore write and read back correctly and the feature still not appear, because the grip logic lives in the DASHBOARD's firmware, not the VCU's. It changes a flag, not wiring: there is no heated-grip circuit on this bike unless one was fitted.

⚠️ Config words are only read at BOOT: key-cycle the bike before judging it. A read-back proves the word in the VCU's EEPROM changed; it says nothing about whether the dashboard offers the grips, which is a separate firmware's decision.

## 6. The write codec: what it can and cannot express

`src/vcu/write-codec.ts` is the pure codec for the three services that CHANGE something in a VCU micro: SecurityAccess, WriteDataByCommonIdentifier and StartRoutineByLocalIdentifier.

### ⚠️ Why this is a new file and not a widened `param-codec.ts`

`param-codec.ts` opens with "READ-ONLY BY CONSTRUCTION, not by convention" and earns it: a closed three-member union, an allowlist of emittable service bytes, and nowhere to put a value. PR #50's author was right that "writes don't widen the read-only guarantee, they delete it" — so that guarantee is not touched. That file still cannot express a write, its union still has three members, and its `READ_ONLY_SERVICES` set is unchanged. Reads keep the property they had.

The writes live in `write-codec.ts` instead, behind a guarantee of the same SHAPE rather than a relaxed version of that one:

1. **The request union is closed**, exactly as the read codec's is. Four members, no raw-bytes alternative, no caller-supplied service byte.
2. **A caller cannot name an identifier.** `write-parameter` takes a `ParameterWritePlan`, and the ONLY way to obtain one is `write-targets.ts`'s `planWrite`, which refuses anything not on the allowlist. There is no constructor for a plan in the codec and no field a caller could fill in by hand that it would honour — `encodeWrite` re-checks the plan against the allowlist on the way out (`assertPlanIsAllowed`).
3. **A caller cannot write without the bike having named its parameter table.** `write-parameter` additionally carries the table-type report the write is being made on the strength of, and `encodeWrite` re-judges it through `table-gate.ts` — from the raw `TABLE_TYPE` words the bike sent, not from any `confirmed` boolean in the report. An index only MEANS a parameter relative to a table, so this is the same class of check as the allowlist and it is enforced in the same place, for the same reason: the UI is not the only thing that can reach that function.
4. **A caller cannot name a routine id.** `start-routine` takes a NAME from a three-member union, not a number. `0xFB`, one digit from the service point and the routine that wipes battery statistics, is unreachable because nothing in this repo gives it a name. That is deliberate and is the single most important line in that file.
5. **The emitted service byte is checked**, the same belt-and-braces `param-codec.ts` keeps: `WRITE_SERVICES` is the whole set, and 0x11 ECUReset, 0x2F InputOutputControl, 0x3B, 0x3D and 0x34/0x36/0x37 are absent and must stay absent. `0x2F` in particular is the factory tool's actuator-test channel (`DIAG_ADDRESSES.md` §9.6) — it drives the pump, the fan, the horn and the lights directly, and nothing in this project has any business doing that.

`SERVICE_RESET.md` §3 lists two siblings of the one named routine, on consecutive ids — `0xFB` Reset Battery Statistics (A8) and `0xFA` Learn Key (A9) — and NEITHER is named. That is the entire mechanism protecting against a fat-fingered `31 FB`: there is no number to mistype, because there is no number.

`ROUTINE_IDS` is the only table in this repo that maps a name to a routine byte, and it has one row. `0xFC` is Set Service Point on A8: it takes no parameters and the firmware stamps the CURRENT RTC time and odometer into the last-service block itself (`SERVICE_RESET.md` §2/§3). That is why it is irreversible and why the clock has to be right before it runs.

`ROUTINE_MICROS` pins the micro rather than leaving it to a caller. On the wire this is only an address byte, but getting it wrong is not harmless: `SERVICE_RESET.md` §7 records that `0xFC` also equals `RoutinesID.VCUCheckSum` in the FLASHING enum, which is a different ECU and session. "Don't send `31 FC` to A9 expecting a service reset" is a direct quote.

### The framing, proven on the wire

Same extended-addressed KWP as the read codec: `[target] [PCI] [service] …` on `0x7C0`, `[0xF1] [PCI] [service+0x40] …` back on `0x7E0`. Quoted from `DIAG_ADDRESSES.md` §9.2/§9.3, which is passive analysis of a candump taken while ENERGICA'S OWN diagnostic software was connected on 2026-08-08 — i.e. the factory tool's real bytes, not a reconstruction:

```
seed request   7C0: A8 02 27 01               → 7E0: F1 06 67 01 <4-byte seed>
key send       7C0: A8 06 27 02 <4-byte key>  → 7E0: F1 03 67 02 34
bad key                                       → 7E0: F1 03 7F 27 35   (invalidKey)
write (WORD)   7C0: A8 05 2E 13 EE 93 80      → 7E0: F1 03 6E 13 EE   (no value echoed)
write refused                                 → 7E0: F1 03 7F 2E 33   (securityAccessDenied)
```

A BYTE write is the same with `len = 04` and one value byte. The routine is from `SERVICE_RESET.md` §3, decompiled from the service tool's shared library rather than captured: `7C0: A8 02 31 FC` → `7E0: F1 02 71 FC`.

The `27 02` capture shows a trailing `0x34` byte after the sub-function; it is echoed back rather than asserted, because one capture is not enough to call a byte mandatory.

### The seed→key algorithm

Swap each adjacent bit pair of the 32-bit seed, then add `0xC1A0BABE` mod 2^32. Both seed and key travel big-endian. `DIAG_ADDRESSES.md` §8 records the same algorithm as `− 0x3E5F4542`; the two sum to 2^32, so subtracting one is adding the other mod 2^32 and there is no conflict to resolve. `BABE` is an Energica easter egg, not a coincidence.

`>>> 0` rather than `>> 0` throughout, and the addition done in double precision before the modulo, because JavaScript's bitwise operators work on SIGNED 32-bit integers: a seed with bit 30 set makes `(seed & 0x55555555) << 1` come out negative, and `+` would then be subtracting. That is a wrong key, which costs one of the ~3 attempts before the micro locks out until a power cycle (§8) — the most expensive silent bug that file could contain.

⚠️ **This is the VCU family's algorithm and only the VCU family's.** It covers A8 and A9, which is everything this repo addresses. It does NOT cover the rest of the bike, and the differences are not subtle: the dashboard uses a four-round multiply/xor/rotate then `^0xFFFFFFFF`, and the charge manager uses a CRC-16/CCITT level-9 scheme. Pointing this function at either would produce a wrong key and spend an attempt on an ECU whose lockout nobody here has ever cleared.

### Why the throws are where they are

`buildWriteFrame` throws rather than returning an error value, exactly as `param-codec.ts`'s builder does: by the time anything reaches it the allowlist has already turned a person's input into a plan, so a bad argument is a bug in this repo.

- The service-byte check is unreachable through the union, which is exactly why it is there.
- The single-frame length check: a WORD write is 5 bytes and a key send is 5, so nothing on the allowlist can reach it. It stays because the next parameter someone adds might be wider, and a silently truncated write to a calibration EEPROM is the worst outcome that file has — it would look like a success and leave a different number in the cell. Nothing there assembles a multi-frame request, on purpose.
- The unknown-routine throw is the most important one. Without it a routine name the table does not carry produces `Uint8Array.from([0x31, undefined])`, which JavaScript quietly turns into `31 00` — a request to start routine ZERO on a VCU, silently, instead of an error. The union makes an unnamed routine unexpressible in TypeScript; this makes it unreachable at runtime too, which is the half that survives a cast and a JSON boundary.
- The switch's default is unreachable while the union stays closed, and TypeScript proves it at compile time. It exists for the version of that file where someone widens the union and forgets a branch — falling through would return `undefined` and crash three frames away instead of saying what actually went wrong.

`assertPlanIsAllowed` and `assertTableTypeConfirmed` are re-checked in the codec rather than trusted because the type says `ParameterWritePlan`. TypeScript's guarantee ends at the process boundary and this is the last code before the bus: a plan assembled by hand, deserialised from JSON, or built by a future caller that skipped `write-targets.ts` is refused at the point where it would otherwise become eight bytes on a motorcycle's calibration EEPROM.

### ⚠️ Why an identifier is not enough on its own

`2E 11 02 50` is a well-formed write of 80 to CommonIdentifier `0x1102` whatever table the VCU is running — the micro takes it, echoes `6E 11 02`, and a read-back of the same identifier returns 80. What changes with the table is which PARAMETER `0x1102` is. Routing and record width are invariant across all 28 of Energica's tables, so there is no malformed frame, no NRC and no read-back anywhere in that sequence to notice it: the write succeeds and is wrong. 151 of 278 ids carry a different name in at least one other table — id 249 (`LM_TYPE` in 16406, `R_BRAKE_POPUP` in 16407) is a one-name example that was found rather than imagined, and ids 70–94 are the case that matters.

So the gate is enforced in the pure layer, and not only where the UI can see it — for exactly the reason `assertPlanIsAllowed` sits next to it. `curl` can reach `/vcu-write`, so can a script written before this existed, and a `TableTypeReport` is a plain object that could be posted, cast or reconstructed. `table-gate.ts` therefore re-derives the verdict from the raw words the bike sent rather than reading the report's own `confirmed` flag, which is what makes forging one useless: to get past it you would have to claim the bike answered with a table this software carries, and if it did then the write was checked against that table.

Both assertions throw, because by the time anything reaches them the runner has already declined the request with a sentence a person can act on. Reaching those lines means that check was bypassed, which is a bug, and a bug on this path must be loud rather than a frame.

`isAllowedPlan` is a function reference set once at module load by `write-targets.ts`, rather than a direct import, because the two modules would otherwise import each other (the codec needs the plan TYPE, the allowlist needs the frame builder) — and a type-only import cannot carry a runtime check. It is left as a throwing stub rather than a permissive default: a build where `write-targets.ts` was never loaded must refuse every write, not allow every write.

### What a reply does and does not prove

⚠️ A positive `6E <hi> <lo>` means ACCEPTED, and that is the whole of what it means. The reply NEVER carries the written value (`DIAG_ADDRESSES.md` §9.2), so it is not evidence that the cell now holds what was sent. That is what the read-back in `write-session.ts` is for, and why there is no path that reports success without one.

⚠️ The expected `31` reply shape is INFERRED. `SERVICE_RESET.md` §3 says so in as many words — the service tool only checks its own `Completed_ACK`, and the positive-response bytes were never logged. So an unexpected shape is reported as `unrecognised` and the caller must treat that as "we do not know whether it ran", never as success. The service point is irreversible; guessing in the optimistic direction is the one thing that cannot be undone afterwards.

Seeds decode big-endian, per the four captured pairs, with `>>> 0` because a seed with the top bit set is negative under `<<` — the same trap `securityKeyForSeed` guards.

## 7. SecurityAccess and the write sequence

`src/vcu/write-session.ts` is the transport half of writing: the socket, the clock and the sequencing. Every byte it sends is built by `param-codec.ts` (the read legs) or `write-codec.ts` (the write legs).

### ⚠️ Nothing here has ever run against the bike (2026-08-16)

The SERVICES and their framing are proven — from the passive capture of Energica's own software writing to this bike's A8 and from five parameters written to this bike with `vcu_param.py` on 2026-08-09 — but not one frame in that file has been transmitted by this repo. **The SEQUENCING is the part with no live evidence at all, and it is the part most likely to be wrong.**

### The sequence, and why each step is where it is

```
10 81        open a session on the micro that owns the parameter
22 CID       read what it holds RIGHT NOW
── compare against what the caller thought it held; refuse on disagreement
27 01        ask for a seed
27 02 <key>  answer it
2E CID <v>   write            ← must be within ~2 s of the line above
22 CID       READ IT BACK
── compare against what was written; a mismatch is reported, loudly
```

The two reads are the point. `2E`'s positive reply is `6E <hi> <lo>` and carries NO VALUE (`DIAG_ADDRESSES.md` §9.2), so "the micro accepted it" is not the same claim as "the cell now holds that number" — and another owner's tool has a failure message for exactly the gap between them: "the ECU accepted the write but the value reverted. That usually means the parameter is recomputed from something else." Nothing here reports success without having read the value back.

The read BEFORE is a compare-and-swap and matters just as much. A dashboard left open since yesterday would otherwise write 80 over whatever the parameter has since become.

### ⚠️ The SecurityAccess rules, which are the sharp edges

1. **The unlock decays in about two seconds.** Measured across six writes by the factory software (`DIAG_ADDRESSES.md` §9.3): 2 ms and 167 ms after the unlock succeeded were accepted; 2.32 s and 4.44 s were refused with NRC `0x33`. So the write follows the unlock immediately, with nothing in between — no read, no logging, no `await` that could be scheduled behind something else.
2. **A bad key costs one of about three attempts, and the lockout clears only on a VCU power cycle.** That is why `write-codec.ts`'s key function is asserted against four real captured seed/key pairs rather than trusted.
3. **Running `27` against an ALREADY-UNLOCKED micro returns NRC `0x35` invalidKey and burns an attempt.** `VCU_PARAM_CHANGES.md` records one being burned this way. Two writes in quick succession would do it — the second one's `27 01` would land while the first one's unlock was still live — so `SECURITY_COOLDOWN_MS` refuses to start a second authenticated operation until the unlock has certainly expired. It costs four seconds and it protects the one resource here that cannot be replenished without walking to the bike and turning it off.

## 8. The write runner: five locks

`src/vcu/write-runner.ts` is service mode's WRITE engine: decide whether the bike may be changed, do exactly one thing to it, read the result back, and write down what happened. The read engine is `read-runner.ts` and this deliberately mirrors it — same gate, same watchdog, same "answers with a reason rather than throwing" contract — but it is a separate file and a separate switch, because the two are not the same risk and must not share an off button.

The five locks, in the order they are checked:

1. **`SERVICE_WRITE_ENABLED`.** Its own switch, separate from `SERVICE_MODE_ENABLED`. A Pi with reads on and writes off is the normal configuration; a Pi that has never been told otherwise is that Pi, because this one defaults to OFF while `SERVICE_MODE_ENABLED` defaults to ON. That asymmetry is the point.
2. **The bus lease** (`bus-lease.ts`). One thing at a time — a sweep's read answered by a write's security seed would file four random bytes as a calibration value, and nothing would throw.
3. **The safety gate** (`service-gate.ts`), unchanged and shared with the read path. ⚠️ It permits STATIONARY-AND-CHARGING, deliberately: the DC charge parameters cannot be tested on a bike that is not plugged in, and a tethered bike cannot be ridden away without someone unplugging it first. Every other check still applies — zero speed, zero motor rpm, `moving`, `go`, `go_request` and `throttle_on` all clear.
4. **The table-type gate** (`table-gate.ts`), the newest of the five. A parameter is addressed BY INDEX, so every name on the allowlist is a claim about which of Energica's 28 parameter tables this bike runs — and a write under the wrong table is accepted, reads back cleanly, and has changed something else. It gates the two PARAMETER actions and nothing else; see [§4](#4-the-table-gate) for why the service actions are deliberately left alone.
5. **The allowlist and the ranges** (`write-targets.ts`), in the pure layer.

And behind all five, per action: a read of the current value, a compare-and-swap against what the caller thought it was, and a read-back afterwards.

### ⚠️ What is not there, and must not be added

No "write these five parameters". No "restore from a snapshot". No "revert". Each is a reasonable thing to want and each turns one confirmed change into a batch nobody reads. If a batch is ever genuinely needed, the right shape is a list the owner confirms one row at a time — not a loop over that function.

### Showing the last sweep's value for an allowlisted parameter

`sweptValueOf` has four conditions, and every one of them is a way it could otherwise put a number on screen that is not this parameter's:

1. **Matched BY INDEX**, never by name. The index is what gets addressed on the wire and what the allowlist is keyed on; a name is a claim about a table.
2. **And the name has to agree anyway.** The snapshot's rows are named from the table the BIKE reported (`retableSnapshot`), so a disagreement means that index is a different parameter on this bike than the allowlist believes — the same finding `table-gate.ts` refuses `unwritable` for. It shows nothing rather than the value of whatever that index turned out to be. A stripped name (an unrecognised table) lands there too, which is the same answer for the same reason.
3. **`status === "read"` and a typed `value`**, never `unsigned` — the same rule `readCurrent` in `public/views/vcu-write.js` follows, and for the same reason: this number becomes the compare-and-swap precondition, and comparing a signed parameter against an unsigned reading of itself is how a write goes to the wrong number.
4. **Not a width mismatch.** A record whose length contradicts the table means the framing is in question, not merely the value.

## 9. The read path: read-only by construction

### `param-codec.ts` — the pure codec

⚠️ **READ-ONLY BY CONSTRUCTION, not by convention.** The public entry point takes a `VcuRequest`, which is a closed union of three alternatives — start a session, say hello, read one parameter. There is no overload, option or escape hatch that accepts caller-supplied service bytes, so there is no code path in this repo that can put a write on this bus. Adding one would mean adding a variant to that union and a branch to the switch, in a file that says this, which is the point.

⚠️ What a caller CAN choose, since 2026-08-16: the target ECU, the bank and the index — i.e. WHICH thing is read, so that service mode can probe an identifier the name table does not describe. What a caller still cannot choose is the SERVICE and the VALUE, and those are the two that make a write. Keep that line where it is: widening "which" is recoverable, widening "what to do to it" is not.

Never implement IN THAT FILE: 0x2E WriteDataByCommonIdentifier, 0x3B WriteDataByLocalIdentifier, 0x27 SecurityAccess, 0x31 StartRoutineByLocalId, 0x11 ECUReset, 0x2F InputOutputControl, or OBD Mode 04. This is the bike's calibration EEPROM: one wrong word in it is a throttle map, a cell limit or a charge current, and nothing there is worth that. Reading needs none of them — A8 and A9 serve banks 1 and 2 with no authentication at all, so there is not even an argument for `0x27` (and per `DIAG_ADDRESSES.md` §3 the bank-0 refusal is NRC `0x12` subFunctionNotSupported, not `0x33`, so `0x27` would not open it anyway).

⚠️ That paragraph used to say "here or anywhere", and since 2026-08-16 that is no longer true of the repository. Three of those services (`0x27`, `0x2E`, `0x31`) and OBD Mode 04 now exist in `write-codec.ts`, behind their own closed union, their own allowlist of five parameters, their own enable switch (`SERVICE_WRITE_ENABLED`, off by default) and a read-back after every write. `param-codec.ts` is unchanged by that and must stay unchanged: its union still has three members, `READ_ONLY_SERVICES` still holds three bytes, and there is still nowhere in it to put a value. The two guarantees are deliberately separate rather than merged — a reader who wants to know whether a READ can change something should be able to answer it from that file alone, without reasoning about a flag somewhere else. 0x11 ECUReset, 0x2F InputOutputControl, 0x3B and 0x3D are implemented NOWHERE.

Since the bank is a parameter, the identifier is something a caller can choose. That is a real widening and it is worth naming precisely:

- A caller CAN now name any identifier in the 16-bit space. Every one of them is still a READ — `22` has no write semantics in KWP, whatever you point it at, and a bank an ECU does not serve answers with a negative response (`DIAG_ADDRESSES.md` §3 records bank 0 refusing with NRC `0x12`).
- A caller still CANNOT name a service. The union has the same three members it always had, and `READ_ONLY_SERVICES` still checks the emitted byte.
- A caller still CANNOT name a value. There is nowhere in that union to put one, which is what makes a write unexpressible rather than merely absent.

Bank 1 is the EEPROM calibration the parameter table describes. Bank 2 is live data. Both are read the same way; the difference is only which numbers come back.

### The framing

```
Request  0x7C0: [target] [PCI] [service] …      target = 0xA9 / 0xA8  (VCU micros)
Response 0x7E0: [0xF1]   [PCI] [service+0x40] … 0xF1 is the tester's address
```

That is ISO-TP with EXTENDED addressing — byte 0 is the address of whoever the frame is for, and everything else shifts one along. Byte 1 is an ordinary ISO-TP PCI: `0x0N` single frame, `0x1N` first frame, `0x2N` consecutive, `0x3N` flow control (the documented `[target] 30 FF 00`).

⚠️ It is NOT compatible with `src/can/iso-tp.ts`, which assumes normal addressing. Under extended addressing a First Frame carries five data bytes, not six, and arrives as seven bytes after the address is stripped — which that reassembler rejects outright. Reusing it would silently drop every multi-frame reply.

**Why single-frame only in `param-codec.ts`, and why that is not a gap.** A bank-1 record is 1 or 2 bytes (the TYPE column), so the longest possible reply is `62 <hi> <lo> <b0> <b1>` = 5 payload bytes, and extended addressing leaves room for 6 in a single frame. No parameter read in this table can produce a multi-frame reply. So none is assembled, and — the part that actually matters — no flow-control frame is ever sent from there: that module derives no transmit address from anything the bus said, it only ever addresses a micro the caller named. A First Frame is reported as its own outcome rather than being decoded from its first fragment, because a truthful "this did not fit the shape I understand" beats a plausible-looking value assembled from half a record.

### ⚠️⚠️ The charge manager was a target here, and it was WRONG. Removed 2026-08-16.

A third target `A4` was added earlier the same day, on request `0x7C3` / response `0x7E3`, described as the charge manager. Decompiling the service tool's shared library showed two things:

- **`0x7E3` is DashboardV2's REQUEST id.** So a probe on that pair, believing it was asking the charge manager, could have been talking to the DASHBOARD. That is not the harmless "silence from an id nothing listens on" the old comment claimed as the safe direction — it is a wrong ECU answering a question meant for another one, which is the exact failure the rest of that file is built to avoid.
- `RequestFrameIDs.CHM = 0x7C3` exists in the manufacturer's code as a **dead enum referenced nowhere**. There is no charge-manager case in any session, read, write or SecurityAccess switch, and the tool's own charge-manager install action is a stub returning `Skipped`. The 11-bit path was designed and never built.

Node `0xA4` really is the charge manager's 11-bit identity — that part was right. The ID PAIRING was not, and the pairing is what goes on the wire.

**Where it actually lives, for whoever adds it properly.** 29-bit ISO-TP on the VDB bus: request `0x18DA09F1`, response `0x18DAF109`, device byte `0x09`, tester `0xF1`. Verified three ways in the decompile — the hard-coded ids 416942577/417001737, the `SendExt` addressing math (`reqID | (target << 8) | source`), and consistency with the BMS/PSU 29-bit family. It is on the VDB manager, so it is reachable from the existing OBD tap with no second bus.

That is a real feature and not a constant: 29-bit ids need `ext: true` on transmit, their own RX filter, and their own addressing math. It does not belong bolted onto the 11-bit table, which is why the target is REMOVED rather than re-pointed. Three things to carry into that work:

- ⚠️ **The charge manager is off-bus when parked.** It answers only during a live charging session, so `no-session` from an unplugged bike is expected, not a fault.
- Identification reads (`0x22` on F191/F181/F180/F18C) need no SecurityAccess.
- ⚠️ Deeper access uses a **CRC-16/CCITT level-9 algorithm that is NOT the VCU's bit-swap**. Do not reuse `write-codec.ts`'s `securityKeyForSeed` for it.
- ❓ The code proves it answers at `0x18DA09F1` in bootloader/programming mode. Whether the RUNNING APPLICATION answers there without a reset is unproven — the BMS and PSU precedent (same node for app and boot) makes it likely, and a live probe is what would settle it.

A7 is deliberately absent from the target table: it answers no read on any bank.

### `kwp-client.ts` — the transport

⚠️ READ-ONLY, structurally. It cannot express a write. Since 2026-08-16 there are TWO ways a byte reaches `channel.send`, and both are closed unions with a throwing default and an allowlist re-check on the emitted service byte:

- `buildRequestFrame` (`param-codec.ts`) — start session / tester present / read one parameter. Three members, three permitted service bytes.
- `encodeMultiFrameRequestPayload` (`multiframe-codec.ts`) — the five reads whose request or reply does not fit one frame: `0x17`, `0x18`, `0x35`, `0x36`, `0x37`. Five members, five permitted service bytes.

There is no raw-bytes entry point to either. A caller names an operation and a target; it can never name a service byte and there is nowhere to put a value. `0x31`, `0x2E`, `0x3B`, `0x14`, `0x11`, `0x27`, `0x2F` and `0x34` are unreachable from this client.

⚠️ The client SENDS FLOW-CONTROL FRAMES, which it used not to, and the property that mattered is preserved rather than spent: **no transmit address is ever derived from something the bus said.** A flow-control frame is addressed to the target the CALLER named, exactly like every request. Contrast `src/can/obd-dtc.ts`, which derives its flow-control id from the reply's id and therefore needs a range guard so a stray First Frame cannot make it transmit on the functional broadcast address; there is nothing to guard here because there is nothing derived.

⚠️ IT DOES NOT CONFIGURE `can0`. `bringUpCan` takes the interface DOWN, which kills every other raw-CAN socket on the Pi including the running `cool-eva` service's. This client only ever opens a channel on an interface that is already up — in practice the service's own, since the sweep moved in-process. The cost is that it cannot rescue a listen-only bus: it would just see nothing, which is why `read-runner.ts` refuses to start a sweep when `OBD_ENABLED=0` rather than leaving it as a mystery.

**What the bus does**, per `DIAG_ADDRESSES.md` §3 (live 2026-08-08): the micros answer NOTHING until a session is open — `A9 01 3E` alone is silence, which is why a conventional sweep misses them entirely. `10 81` first, then reads work. The session then auto-closes after ~2.5 s idle, so a long sweep either keeps moving or re-opens; this client does the latter whenever it has been quiet for longer than `SESSION_IDLE_LIMIT_MS`, which also makes it correct when the caller pauses (a flaky ssh link, a Ctrl-Z, a slow write to the SD card). A8 and A9 hold SEPARATE sessions, so the client's state is per-micro. Switching between them mid-sweep is what makes that matter: whichever one you left goes idle and expires while you work on the other.

### `probe.ts` — one identifier, on demand

The sweep reads the 277 parameters `param-table.ts` describes, on the two VCU micros, in bank 1. That is the right default and it was also the whole of what this project could reach until 2026-08-16. What lives outside it: **other banks.** The identifier is `(bank << 12) | index`. Bank 1 is the EEPROM calibration; **bank 2 is live data** — the running values, not the stored settings — and nothing here has ever read one.

⚠️ **What this widens, precisely.** Before the probe, no HTTP input named a service, an identifier or a value. Now an identifier and a target are caller-supplied. That is a real change and it should be read exactly as far as it goes:

- The request union in `param-codec.ts` still has THREE members, and its encoder still throws on any service byte outside the read-only set. A caller cannot name a service.
- There is still nowhere in that union to put a VALUE. A write remains unexpressible rather than merely unwritten.
- `22` ReadDataByCommonIdentifier has no write semantics in KWP whatever it is pointed at, and a bank an ECU does not serve answers with a negative response (`DIAG_ADDRESSES.md` §3 records bank 0 refusing with NRC `0x12`).

The line held is "which thing is read" versus "what is done to it". Widening the first is recoverable; widening the second is not.

The charge-manager target was offered here too, on the same day, and removed for the reason above.

**One read, not a session.** A probe opens a session, asks once and stops. It does not hold the session open — it expires by itself after ~2.5 s of silence — and it does not retry beyond the one re-open the client already does when a read times out. The whole thing is bounded by two reply windows, so the safety gate's 200 ms watchdog can end it mid-flight the same way it ends a sweep.

### `read-runner.ts` — the engine, and its exit path

It used to `spawn` `scripts/read-vcu-params.ts` and watch the files it left behind, so that the always-on service could truthfully say it never asked the micros anything. That rule bought one thing — a bright line nobody could cross by accident — and cost three: a second copy of the resume/partial/baseline rules, a progress feed parsed back off disk, and a cross-process clock comparison to work out which archive belonged to which run.

The bright line is now drawn somewhere better. Service mode is entered only with the bike PROVED stationary and out of drive (`service-gate.ts`), and it is left automatically the instant that stops being true — so "the service does not touch the micros" becomes "the service touches the micros only when the motorcycle cannot move", which is the property that was actually wanted. Reading is still read-only by construction, and nothing in that file or in the HTTP layer can name a service, an identifier or a value.

**The exit path is the part that matters.** Two independent things stop a sweep, and both end in the same `abort`:

1. The sweep asks the gate before EVERY request (`sweep.ts`, `mayContinue`), so the check precedes the socket rather than racing it.
2. A watchdog re-checks the gate every `GATE_WATCH_INTERVAL_MS` and calls `abort` from outside the loop. That is what bounds the worst case: one `readParameter` can spend ~1.2 s inside itself (a reply window, a session re-open, a second reply window), and without the watchdog a bike that started moving during one would keep four more frames on the bus until the loop came back round.

`abort` calls `client.stop()`, which clears the pending request and refuses every subsequent transmit, so the sweep cannot emit one more frame on its way out. The diagnostic session it opened is left to expire by itself after ~2.5 s of silence, which is the documented behaviour and is why there is no closing frame to send.

Nothing read is lost on the way out: every row was appended to the resume file as it arrived, the partial snapshot is written and labelled `complete: false`, and starting again resumes from where it stopped.

### `sweep.ts` — why the sweep is allowed to live in the service

The standing rule this repo grew up with was that the always-on service never asks the micros anything: the sweep lived in a script you ran over ssh, and `/vcu-read` shelled out to it. The rule was never about the SERVICE being dangerous — it was about cost and about timing:

1. **Bus contention, measured.** `src/can/obd-dtc.ts` records a mode-03 transfer on this bike succeeding somewhere between 25 % and 70 % of the time, with zero mode-01 replies interleaved on the successful ones and 50+ on the failures. The bus is the scarce resource, and a ~277-request burst is the last thing to add to service startup, which is exactly when the OBD poller, the BLE link and the DTC reads are all coming up.
2. **A restart is routine** (deploy is `git pull` + `systemctl restart`), so "once at startup" means "every time anyone touches the Pi".
3. **Nothing downstream wants it live**: 277 keys in `liveState`, which `src/ws.ts` re-broadcasts whole every five seconds, for values that do not move.

None of those is an argument against a sweep the owner starts, once, standing next to a parked bike — which is what `service-gate.ts` proves the situation to be before a single frame goes out. So the sweep moved in-process and the script went away, because two copies of the four resume/partial/baseline rules was the real cost of keeping them apart.

It is **still read-only, and still structurally**: every byte that reaches the bus is built by `param-codec.ts`, whose request union has three members and whose encoder throws on anything else on the way out. Moving the caller from a child process into this one changes nothing about that.

It **does not configure `can0` and does not own the socket**. The channel is the service's, already up and already started. Nothing there calls `bringUpCan`, and nothing there calls `channel.start()` or `channel.stop()`. Frames are handed in by the caller rather than subscribed to, so the module owns no listener to leak either.

**Aborting.** `client.stop()` is what makes an abort immediate rather than advisory: it clears the pending request, settles it as `not-sent` — our own doing, never recorded as the bike refusing to answer — and refuses to transmit again, so `openSession` and `ping` on a micro we had not reached yet cannot put anything on the bus either. ⚠️ There is deliberately NO "close the session" request on the way out. `0x20` StopDiagnosticSession is not in `param-codec.ts`'s union and must not be added for this: the session the sweep opened expires by itself after ~2.5 s of silence (`DIAG_ADDRESSES.md` §3, live 2026-08-08), so the clean exit from a half-finished sweep is to stop talking. Sending one more frame to tidy up would be the one case where an abort put traffic on the bus of a bike that had just started moving.

**`mayContinue` is HALF of the auto-exit**, and it is worth being precise about which half, because "no frame after unsafe" is the sentence someone will quote when deciding whether the other half can be dropped. What that call guarantees on its own is weaker than it looks: it runs once per PARAMETER, and one parameter can put up to three frames on the bus — the read, then on a timeout a `10 81` to re-open the session and a second read. `pingMicros` is checked once per micro and `ping` sends two frames. So a gate transition landing just after a check can be followed by another frame up to a reply window later. What actually bounds it is `stopped` inside `kwp-client.ts`'s `exchange`, which refuses to transmit at all and is set by `abort` — reached from `mayContinue` AND from the 200 ms watchdog in `read-runner.ts`. Since 200 ms is shorter than the 300 ms reply window, at most one already-in-flight frame gets out. The check is still worth having: it is what makes the sweep correct on its own terms rather than dependent on a caller remembering to watch it, and in the common case (a read that answers in milliseconds) it is what stops the sweep, with the watchdog never firing. But the tight bound is the watchdog's.

**"Complete" means every parameter was ASKED ABOUT**, not that every one answered. A slot that refuses or stays silent is a finding in its own right and must not make a finished sweep look truncated for ever — the same distinction `src/diagnostics/stored-codes.ts` draws between "no codes" and "no answer".

⚠️ `stoppedBecause` is CAPTURED on the same line as `complete`, and the captured copy is what is returned. Re-reading `state.stoppedBecause` after the `await` would read it at a different moment: writing two JSON files and diffing 277 rows takes a few hundred milliseconds on a Pi's SD card, the watchdog is still armed for the first tick or two of that, and rolling the bike the instant `277/277 read` scrolls past is the natural thing for an owner to do. That would have returned `complete: true` in the snapshot and a gate exit as the reason, and `read-runner.ts` checks the reason first — so a sweep that asked about all 277 and deleted its own resume file would have rendered as "Stopped: the bike stopped being safe to service". Same shape as the wall-clock bug the first review found, and the same fix: read the fact once.

## 10. Multi-frame reads

`src/vcu/multiframe-codec.ts` is the pure codec for the VCU micros' MULTI-FRAME custom-KWP exchanges — the services whose request or reply does not fit one CAN frame. `src/vcu/multiframe-transfer.ts` is the transport half.

### ⚠️ Read-only by construction, and separately from `param-codec.ts`

`VcuMultiFrameRequest` is a closed union of five alternatives, every one of them a read, and `encodeMultiFrameRequestPayload` has a throwing default. There is no raw-bytes entry point: a caller names an operation, never a service byte and never a value. `READ_ONLY_SERVICES` then re-checks the emitted byte on the way out, so a future widening of the union that forgets the header still cannot put a write on this bus.

**Never implement there: `0x31` StartRoutine, `0x2E` WriteDataByIdentifier, `0x3B` WriteDataByLocalIdentifier, `0x14` ClearDiagnosticInformation, `0x11` ECUReset, `0x27` SecurityAccess, `0x2F` InputOutputControl, `0x34` RequestDownload.** Two of those sit uncomfortably close to what is there and are worth naming individually:

- `0x34` RequestDownload is `0x35`'s mirror image — one byte away in the switch, and it points the transfer the other way, tester → ECU. `0x35` RequestUpload is a read because upload means ECU → tester; `0x34` would make that same segmenter into a flasher. It must never appear.
- `0x31 FE` (`RoutinesID.VCUErase`, operand `01 00 00 00 01 FF FF FF`, then `33 FE` polled) is the service tool's freeze-frame ERASE, and it is the thing that destroys exactly what `0x35`/`0x36`/`0x37` exist to read. It also needs SecurityAccess, where every read there needs none.

`src/diagnostics/freeze-frame.ts`'s header lists the same rule for `0x17`'s module, and `param-codec.ts`'s for the parameter reads. Three small closed unions, each arguing its own case, beat one wide one — which is why `0x17`/`0x18`/`0x35`/`0x36`/`0x37` are NOT added to `param-codec.ts`. That file's header states as an invariant that its union has three members and its allowlist three bytes, and that invariant is worth more than the handful of lines sharing it would save.

### The framing

Per `DIAG_ADDRESSES.md` §3 and `CAN_MAP.md`:

```
request   7C0: [target] [PCI…] [service] …      target = 0xA8 / 0xA9
response  7E0: [0xF1]   [PCI…] [service+0x40] …  0xF1 is the tester
flow ctrl 7C0: [target] 30 FF 00                 ours to send
```

That is ISO-TP with EXTENDED addressing: byte 0 is an address and every length shifts one along from the normal-addressed form in `src/can/iso-tp.ts`. A Single Frame holds 6 payload bytes, a First Frame 5, a Consecutive Frame 6. `src/diagnostics/extended-iso-tp.ts` reassembles the receive side and its header argues why it is not `src/can/iso-tp.ts`; `multiframe-codec.ts` is the transmit side of the same framing, plus the service encodings that need it.

### 🔴 Consecutive Frames are numbered from 0 on this channel, not from 1 — fixed 2026-08-20

ISO 15765-2 assigns the First Frame sequence number 0 and says **"the SN of the first ConsecutiveFrame shall be set to 1"**. These micros do not. Both halves of this repo followed the standard, and both were wrong about this bus.

The evidence is not a reading of the spec, it is a count over the whole 55-minute capture:

|                                            | first CF is SN 0          | first CF is SN 1 |
| ------------------------------------------ | ------------------------- | ---------------- |
| micro → tester (A8 and A9), 1229 transfers | **1229**                  | 0                |
| tester → micro, the 1 multi-frame request  | **1** — and A8 granted it | 0                |

Every one of the 1229 runs is exactly `0, 1, … 15, 0, …` with a Consecutive Frame count matching `ceil((declaredLength − 5) / 6)` to the frame, so this is not a misparse of a dropped first frame — a 1-based run would come up one frame short of its own declared length, 1229 times.

Two separate defects came out of it, one per direction:

- **Transmit.** `segmentRequestPayload` started at 1, so the `0x35` request went out as `A8 10 0C …` / `A8 21 …` / `A8 22 …` where the only sender this ECU is known to have accepted sent `A8 20` / `A8 21`. Whether A8 would have taken it is untested and unknowable from here; what IS known is that its own stack is 0-based in every frame it emits, and that the 0-based form was granted.
- **Receive.** `ExtendedIsoTpReassembler` expected 1, so every real multi-frame reply is abandoned with `consecutive frame out of sequence (expected 1, got 0)`. That is 1229 of 1229 — the `0x36` blocks, all 29 `0x17` freeze frames, and the `1A 90` VIN read. This is the more serious of the two: it breaks `0x17` as well, which is the other thing on the on-bike list.

They had to be fixed together, and the check that says so is the segment→reassemble round trip in `scripts/check-kwp-multiframe.ts` §2: change one side alone and it returns `null`.

⚠️ **Why the constructed fixtures did not catch it.** Every reply fixture in `scripts/` was written 1-based, from the standard, including the one graded as strongest — §A's `F1 21 3C B6 …`, whose BYTES are quoted from two independent live records but whose PCI byte was inferred. Reassembler and fixtures agreed with each other and with ISO 15765-2, and disagreed with the motorcycle. They are 0-based now.

⚠️ Deviating from a standard inside a decoder is normally how a silent wrong answer gets shipped, so it is worth being explicit about which way round this is: the standard-conforming value **was** the silent wrong answer here, and the gap check itself is untouched — a missing frame is still abandoned, it is just counted from the right place.

### `0x17` — one component's freeze frame

✅ The SERVICE and its ROUTING are proven: 29 `0x17` requests went to A8 in the 2026-08-08 capture and all 29 drew a positive `57` (`DIAG_ADDRESSES.md` §9.1), and Energica's own `KWP2000::ReadDiagnosticTroubleCodeInformation` emits `0x17 <hi> <lo>` against `MotorbikeECU.VCUSafety` with no SecurityAccess in the path.

✅ **The literal FRAME is a quotation now** (2026-08-20). It used to say "reconstruction, not a quotation, because the census discarded payloads" — but the census is not the capture, and the capture kept everything. All 29 requests are `A8 03 17 00 <component> 00 00 00`, zero-padded to DLC 8, for components `03 04 05 06 07 08 0A 0B 0C 14 16 22 23 24 25 27 28 29 2A 2C 2E 30 31 33 34 35 36 3C 3E`. The reconstruction was right.

⚠️⚠️ **The 29 REPLIES are in the capture too, and they do not match the constructed fixture.** Component 44 (`0x2C`, P0A07, the water-pump code) answered `57 01 00 2C 07 16 00 00 FF FC 01 5D 01 5D 01 5D 89 FF` — 18 payload bytes with status `07`, where `scripts/freeze-frame-fixtures.ts` invents 17 bytes with status `05` and a different field block. Reply lengths across the 29 run 6…26 bytes. **This is not settled here and nothing in this PR acts on it**: it is a question about the `0x17` RESPONSE LAYOUT and `src/diagnostics/fault-infokeys.ts`' info-key shortlists, which is its own investigation. It is written down so that the next person starts from the bytes rather than from the fixture.

### ✅ `0x35` RequestUpload — captured whole, 2026-08-20

`35 12 FF FF FF FF FF FF FF FF FF FF` opens the bulk freeze-frame log read-out. `0x12` is `RoutinesID.ReadFreezeFrame`. Upload means ECU → tester, so this is a read; `0x34` RequestDownload, which is not, must never be added beside it.

The ten `0xFF` were this repo's least-supported byte sequence for two weeks. They are captured now, all of them, at 19:04:32 in `capture-20260808-182129-600daf87.log`:

```
19:04:32.265292  7C0  [8]  A8 10 0C 35 12 FF FF FF   First Frame, 0x00C = 12 payload bytes, carrying 5
19:04:32.276207  7E0  [8]  F1 30 FF 00 00 00 00 00   A8's flow control — BlockSize 255, STmin 0
19:04:32.279852  7C0  [8]  A8 20 FF FF FF FF FF FF   Consecutive Frame, sequence 0, carrying 6
19:04:32.282207  7C0  [8]  A8 21 FF 00 00 00 00 00   Consecutive Frame, sequence 1, carrying the 12th byte
19:04:32.316132  7E0  [8]  F1 03 75 12 E9 00 00 00   granted
```

5 + 6 + 1 = 12 = the `0x0C` the First Frame declared, and every operand byte is `0xFF`. The guess was right. It is the ONLY multi-frame request the tester sends in the whole 55-minute session, which is why there is exactly one flow control from a micro to compare against.

### ⚠️ How to read that capture — the instruction that used to be here does not work

The note this replaces said to grep the capture for "`7C0` frames whose second byte is `0x21`". That is wrong twice, and it cost the next reader a session before anyone got a byte out of the file:

- **`0x21` is the wrong frame.** Under extended addressing byte 0 is the ADDRESS (`A8`) and byte 1 is the PCI, so the frame carrying the operand is `A8 20 …`. The payload splits **5 / 6 / 1** across the First Frame and TWO Consecutive Frames, and `A8 21 …` is the second one — it holds the twelfth byte and nothing else.
- **Anchoring on `[8]` silently drops 48 frames.** The tool mixes DLC modes in one session: of the 26 662 `7C0` frames, 26 614 are padded to `[8]` and 48 are not (39 at `[3]`, 9 at `[4]`). The `0x37` that settles the transfer exit is one of the 48 — `A8 01 37` at `[3]` — so a pattern with `[8]` or a fixed run of spaces in it finds a perfectly consistent, perfectly wrong answer. ⚠️ The spacing varies too, and the trap is nastier than it looks: **48 lines also use a narrow interface field — but a DIFFERENT 48.** Cross-tabulated, 35 of the short-DLC frames are wide-padded and 35 full-DLC frames are narrow-padded. Two independent partitions that happen to be the same size, which is how an earlier reading matched the counts and concluded the padding was uniform. Anchor on neither: split on whitespace and read fields by position.

What works, on either copy of the file (`/home/pi/ride-captures/` on the Pi, `~/Documents/cool-eva-archive/` on the laptop). The format is one frame per line, whitespace-separated, `$4` the CAN id and `$6…` the data bytes:

```sh
# every request and reply on the diagnostic channel, ~96k lines out of 4.3M
awk '$4=="7C0" || $4=="7E0"' capture-20260808-182129-600daf87.log > diag.log

# the request census that answers "what did the tool actually send"
awk '$4=="7C0"{print $6,$7,$8,$9}' diag.log | sort | uniq -c | sort -rn

# the 0x35/0x36/0x37 exchange itself, in order
grep -n "35 12" diag.log        # the First Frame; read the next few lines
```

Two counts that make a parse self-checking: the tester sends 1227 `A8 30 FF 00` flow controls, and A8 sends 1227 First Frames — 1198 `0x36` blocks + **28** `0x17` replies + **1** `0x18`. (There are 29 `0x17` replies in the session, but component 60's fits a Single Frame, so it is not among the First Frames). If those do not match, the parse is wrong.

### 🔴 `0x36` TransferData is `36 12`, not a bare `36` — fixed 2026-08-20

**This was a live defect, and it was on the one path in this repo that has never been run.** The note that stood here reasoned that `0x36` carries no block-sequence counter, which is true, and then shipped a bare `36`, which does not follow.

Every one of the 1198 TransferData requests in the capture is the same Single Frame:

```
19:04:32.342118  7C0  [8]  A8 02 36 12 00 00 00 00   → F1 10 E7 76 …  (231 bytes)
…1196 more, byte-identical…
19:11:49.5      7C0  [8]  A8 02 36 12 00 00 00 00   → F1 10 41 76 …  (65 bytes, the last)
```

`A8 02` declares TWO payload bytes. The operand is `0x12` — `RoutinesID.ReadFreezeFrame`, the same identifier `0x35` opened the upload with — and it is CONSTANT across all 1198, which is what rules out an ISO 14229 block counter. So both halves of the question are now settled from the wire, and they have different answers: no counter, but not empty either.

What the bare `36` would have done: it is one byte short of anything this micro has been seen to accept, so the first block draws NRC `0x13` incorrectMessageLengthOrInvalidFormat (or `0x24` requestSequenceError) and the read fails at block 1 of 1198. Loud rather than silent — the old note was right about that — but a failure standing next to the motorcycle, which is the thing this file exists to prevent.

Pinned by `scripts/check-kwp-multiframe.ts` in two independent places: a byte-exact assertion against `TRANSFER_DATA_FRAME`, and `scripts/simulated-vcu-micro.ts` now refusing any `0x36` that is not `36 12` with the NRC the bike would have used, so the end-to-end §7 sequence fails too.

### ✅ `0x37` RequestTransferExit — a bare `37`, captured

```
19:11:49.670991  7C0  [3]  A8 01 37
19:11:49.693356  7E0  [8]  F1 02 77 FF 00 00 00 00
```

`A8 01` declares one payload byte, so the request carries no operand at all — exactly what KWP2000 and ISO 14229 specify. That resolves the `77 FF` puzzle in favour of the first reading: the `FF` is a status byte of the micro's own, not an echo of anything we sent. **The `37 FF` fallback this section used to name is not needed and should not be tried** — it was an untested branch guarding against a case that cannot arise.

Note the `[3]` DLC: the tool did NOT pad this one, where it padded the `0x35` and `0x36` frames to 8. Both modes appear in the same session (3050 of its `A8 01 3E` are padded, 31 are not) and the length byte governs, so this repo's uniform zero-padding is fine.

It is sent even when the read is abandoned early: an ECU left holding an open upload may refuse the next one. It is still a read — it transfers nothing and stores nothing.

### ✅ The `75` RequestUpload reply: settled by what followed it

`F1 03 75 12 E9`. Two readings used to fit; the 1198 blocks that followed pick one.

- **`12` echoes the routine id and `E9` = 233 is a maxNumberOfBlockLength.** ✅ The longest `76` reply in the transfer is exactly 233 bytes, and none is longer. The blocks run 206…233 with 233 hit 26 times.
- ~~`12` is ISO 14229's lengthFormatIdentifier and `E9` the first byte of a maxNumberOfBlockLength.~~ Out: it never fitted the 3-byte body, and it predicts nothing about the block sizes that then matched the other reading exactly.

Nothing here ACTS on the number even so — the loop still stops on what the micro does rather than on a count derived from `E9`. But `freeze-frame-log.ts` has to be able to HOLD 233 bytes, and until 2026-08-20 it could not; see [§11](#11-the-freeze-frame-log).

### The flow-control frame we send

`[target] 30 FF 00`. ⚠️ The transmit address is the target the CALLER named. It is never derived from the received frame — which is the property `param-codec.ts`'s header claims for the whole client ("no transmit address is ever derived from something the bus said") and the one thing that could quietly be lost by teaching this client to answer a First Frame. `src/can/obd-dtc.ts`'s flow control DOES derive its id from the reply's, and carries a range guard for exactly that reason; here there is nothing to guard because there is nothing derived.

`FF 00` is BlockSize 255, SeparationTime 0, taken from `DIAG_ADDRESSES.md` §3 and `CAN_MAP.md` rather than from the `30 00 00` `src/can/obd-dtc.ts` sends on the OBD channel.

✅ **Captured on this channel in BOTH directions, 2026-08-20.** This section used to say no flow-control frame ever had been, and that was a fact about the census rather than about the capture:

- **Ours**, 1227 times: `7C0: A8 30 FF 00 00 00 00 00` — one per multi-frame reply from A8 (1198 `0x36` blocks + 29 `0x17` replies). Byte for byte what `buildFlowControlFrame` builds, including the padding.
- **The micro's**, once: `7E0: F1 30 FF 00 00 00 00 00`, 11 ms after our `0x35` First Frame and 3.6 ms before the first Consecutive Frame went out. Once is all there can be — the `0x35` is the only multi-frame REQUEST in the session.

So `FF 00` is what this bus actually uses, BlockSize 255 and SeparationTime 0, and the choice between it and `30 00 00` is no longer a judgement call. It also settles `sawFlowControlFromMicro`: **A8 does answer a multi-frame request with a flow control**, so the unprompted-send fallback in `onRequestFlowControlTimeout` is a fallback rather than the expected path.

### The transport half

**What it exists to do that `kwp-client.ts`'s `exchange` cannot.** That function is one frame out, one frame back. Everything in `multiframe-transfer.ts` is one of the two halves being longer than that:

- RECEIVE: a `0x17` freeze frame is at minimum a 5-byte header plus fields, and an extended-addressed Single Frame holds 6 bytes — so every freeze frame is multi-frame. Assembling it means ANSWERING the First Frame with a flow-control frame, which `param-codec.ts`'s header says that path deliberately never does.
- TRANSMIT: `0x35 12` + a 10-byte operand is 12 payload bytes, which is a First Frame plus two Consecutive Frames. It is the only request in this repo that does not fit one frame.

⚠️ **The flow control we send keeps the read-only property intact.** `param-codec.ts` claims "no transmit address is ever derived from something the bus said". That survives: `buildFlowControlFrame` addresses the target the CALLER named, and the transport never reads an address out of a received frame.

⚠️ **Nothing may sit between a First Frame and its answer.** Measured on this bike's OBD channel 2026-08-04 (`src/can/obd-dtc.ts`'s header): delaying the flow control on purpose gave 4/12 completed transfers at 0 ms, 5/12 at 10 ms, 3/12 at 20 ms and 1/12 at 40 ms. So the flow control goes out synchronously from the frame handler, before the frame is even decoded — and `handleFrame` must stay callable straight off the CAN listener.

⚠️ **And it must not starve the OBD poller.** `handleFrame` returns false for every frame that is not part of this transfer, so the caller hands it on. That matters more here than usual: the micros answer on `0x7E0`, which is inside the `0x7E0`–`0x7EF` range the 2 Hz mode-01 poller reads, and a transport that swallowed frames would stall that poller for a whole timeout each time. Consecutive Frames are accepted only while a transfer is actually open, and every reply is checked for the tester's address first. The other half of not starving it is time: a 1198-block log read takes minutes, so `freeze-frame-log.ts` paces itself and yields between blocks. Nothing in the transport loops or blocks — every wait is a timer.

**The frame ceiling per exchange** is over and above the reassembler's own cap. The reassembler bounds frames that CONTRIBUTE to a payload; this bounds the ones that do not: a micro repeating flow-control frames — which the reassembler deliberately ignores, so nothing there counts them — would otherwise keep an exchange alive doing nothing until the timer saved us. The timer would save us; this is the cheaper guard, and it makes the loop terminate on its own terms rather than on the clock's. ⚠️ It is DERIVED from the payload cap rather than fixed, for the same reason `maxFramesFor` itself is. As a constant the two caps only stayed ordered while the payload cap was small: a caller that raised it past ~380 bytes would have seen a legitimate long reply abandoned as "more than 64 frames in one exchange" — a true statement about the wrong number, and a guard firing where it was never meant to.

**When the micro never answers our request's First Frame.** ✅ The question this used to hedge is answered: A8 DOES emit a flow control before the `0x35` Consecutive Frames — `F1 30 FF 00`, 11 ms after the First Frame — so waiting for one is the right default and the timeout path is a genuine fallback. It is kept because a fallback that never runs is still cheaper than a read that stalls.

So on a timeout the remaining frames go out anyway, loudly. Refusing instead would make the whole bulk read untestable on the guess that turns out wrong, and the frames themselves are close to inert: a Consecutive Frame carries PCI `0x2N` and no service byte at all, so a micro not in a receive state either discards it as ISO-TP noise or reads `0x21` as a length and `0xFF` as a service, which is not a service and draws a refusal. Neither outcome writes anything. `sawFlowControlFromMicro` rides out on the result either way, so the first live run settles the question that the capture could have.

## 11. The freeze-frame log

`src/vcu/freeze-frame-log.ts` runs the bulk read: `0x35` RequestUpload, then N × `0x36` TransferData, then `0x37` RequestTransferExit.

The factory tool did exactly this on 2026-08-08 and it took **~7 minutes for 1198 blocks** (`DIAG_ADDRESSES.md` §9.6). That single fact drives most of the design: everything there is about a read that runs for minutes on a bus shared with the brakes, rather than about the protocol, which is three services and a loop.

### ⚠️ What this gives that `0x17` does not

Timestamps and history. `0x17` answers "what was the bike doing when component N last latched" — one record per component, no date on it. This is the whole stored LOG: every freeze frame the micro has kept, each (per the service tool's `KWP2000Moto.ReadFreezeFrame`) a 4-byte big-endian timestamp in seconds since 2000-01-01, then `<compHi> <compLo> <status>`, then the same info-key field block `src/diagnostics/freeze-frame.ts` decodes.

⚠️ The module does NOT decode those records, on purpose. It hands back the block bodies exactly as they arrived. A decoder written against a guessed layout is how you get 1198 plausible wrong answers instead of one. The bytes are kept whole so that the first real transfer can be read by a human, and the decoder written against it afterwards.

### ✅ How much of this is established (rewritten 2026-08-20)

Everything in the list that stood here rested on a CENSUS that had kept service bytes and thrown payloads away. The capture itself kept the payloads, so:

- ✅ The service sequence and the counts: 1 × `0x35`, 1198 × `0x36`, 1 × `0x37`, with positive `75` / `76` / `77` for every one, on A8, in a `10 81` session with NO SecurityAccess anywhere in the capture.
- ✅ Every REQUEST byte, verbatim: `35 12` + ten `FF`, `36 12` × 1198, a bare `37`. [§10](#10-multi-frame-reads) quotes the frames.
- ✅ **1198 real block bodies**, 206…233 bytes each, 261 kB in total. Nothing in this repo reads them yet.
- ✅ The record layout the module refuses to decode is nonetheless CORROBORATED by the capture. The last block's second record is `00 4D F4 7D | 00 2C 07 | 16 00 00 FF FC 01 5D 01 5D 01 5D 89 FF`: a 4-byte stamp, then `00 2C 07` = component 44 status `07`, then a field block that is byte for byte the body of the `0x17` reply the same tool got for component 44 eight minutes earlier. Same shape, two services, one session.
- 🟡 What the tool used as an END marker is still unknown — see below.

### ⚠️ The end of the upload is NOT an empty block

`isUploadFinished` treats an empty `76` body as the end. The capture does not support that and does not refute it either, which is worth stating precisely because it is now the largest remaining guess on this path:

- The 1198th reply was `F1 10 41 76 …` — **65 bytes, a 64-byte body**, not empty. The other 1197 run 206…233.
- No `7F` refusal followed it. The tool simply sent `0x37` 61 ms later and closed the session.
- So an empty body was never observed, and "shorter than the last one" is not a rule either — the lengths vary by 27 bytes block to block.

Whatever told the factory tool to stop, this repo does not know it. Left alone deliberately: being wrong here is bounded rather than silent — the 5000-block ceiling stops the read and reports `block-cap`, with every block that arrived kept exactly as it arrived. The first live run against a bike is what settles it, and it will settle it cheaply because block 1199 is 25 ms away rather than 7 minutes.

### 🔴 The block cap was 128 bytes, and every block is bigger than that — fixed 2026-08-20

`TRANSFER_BLOCK_MAX_PAYLOAD_BYTES` was 128, reasoned from the size of ONE log record (~28 bytes) plus slack. But a block is not a record: it is as many records as fit, and the `75 12 E9` grant says how many — `E9` = 233 bytes. The captured blocks are 206…233.

At 128 the reassembler abandons the very first block with `first frame declares 231 bytes, over the 128 cap`, and the read fails having collected nothing. It is now 256: above the 233 the micro is granted, still a bound on what a stuck responder can make this process hold, and still under the frame ceiling `maxFramesFor` derives from it.

### Not starving the OBD poller, which is the operational risk

A sibling PR already made this mistake: a Mode 04 leg that ate the poller's replies. Four things stop it here.

1. **A bus lease** (`bus-lease.ts`). One thing at a time on this bus, and a second caller is told who has it rather than queued behind a seven-minute transfer.
2. **Every wait is a timer.** Nothing loops, nothing blocks; the event loop runs between every block, which is what keeps the WebSocket, the CAN RX handler and the poller alive.
3. **Pacing.** See `DEFAULT_PACE_MS`.
4. **`handleFrame` hands back everything that is not ours** — including frames on `0x7E0`–`0x7EF` that belong to the poller — so a transfer in flight costs the poller a null check, not a reply.

### ⚠️ And it must be stoppable

`cancel()` takes effect between blocks and inside the block in flight, and the `0x37` still goes out afterwards. An abandoned upload is a micro left holding state that may make it refuse the next request, and closing it is the one courtesy this read owes. `0x37` transfers nothing and stores nothing, so sending it on the way out of a failure is not a write.

## 12. The service gate: when the bike may be serviced

`src/vcu/service-gate.ts` answers one question: is this motorcycle safe to hold in service mode right now? Readings in, a verdict out.

### What it is for

Service mode is the one thing in this repo that puts ~277 requests on the bike's bus on purpose. Reading cannot change a calibration — `param-codec.ts`'s request union has three members and no write in it — but a diagnostic session and a request burst are still not things to hold open while the machine is being ridden, and this is the gate that says so. Tesla's service mode is the model: you get in while stationary and out of gear, and you are put back out the moment that stops being true.

### Fail closed

Every verdict starts from "no" and has to be argued up to "yes". A signal that has never arrived, or that arrived too long ago to still describe the bike, blocks — because "I cannot see the speedometer" and "the speedometer reads zero" are different claims and only one of them is a reason to proceed. That is the same distinction `src/can/obd-dtc.ts` draws between `not-sent` and `no-response`, and `src/diagnostics/stored-codes.ts` between "no codes" and "no answer".

The cost of failing closed is worth naming: the gate needs the bike's 100 Hz broadcasts, so it refuses on a bike that is completely switched off. That is not a hole, it is a coincidence of requirements — a sleeping VCU answers no `10 81` either, so a sweep would read 277 no-sessions anyway. Both halves want the same awake, parked, key-on bike.

### Why these signals and not others

Everything used is already decoded and already logged by this repo; nothing new was invented for the gate, no frame was added to the kernel RX filter, and no decoder was written for it. The ones deliberately NOT used are listed under `EXCLUDED_FROM_GATE` — an unreliable check is worse than no check, because it earns trust it cannot repay.

### ⚠️ What has and has not been verified (2026-08-16)

The bike is unavailable, so the only honest statement is about captured bytes.

- The PASSING path is checked against real ones. `0x102` = `80 10 02 44 99 FF D8 FF` and `0x104` with its speed and rpm fields zero are the 2026-08-02 parked capture, and `scripts/check-vcu-params.ts` §10 runs them through the real `src/can/decode.ts` and this gate and asserts `safe`. So "this refuses to let anyone in, ever" is ruled out on evidence rather than on hope.
- The BLOCKING path is checked the same way, from the same day's garage lap: `5F 00 32 00` in `0x104` b4-7 is 9.5 km/h and 400 rpm, measured against OBD PIDs 0D and 0C, and the gate must refuse it.
- Six days of real riding (`rides.db`, 6.2 M rows, analysed 2026-08-16) settled four things the captures alone could not, and every one of them changed this file: the bit then called `charging` is the high beam; a charging bike stops sending `0x104` entirely; `go_request` does not lead `go`; and `go`/`energized` read 0 while the bike rolls at up to 6.7 km/h.
- What CANNOT be checked without the bike is the thing the gate exists for: that these bits move the instant a real motorcycle starts to roll away, and that the sweep is out of the way before it does. Every signal has been seen in both states on a real bike, which is the strongest available evidence — but the LATENCY between the wheel turning and the last frame leaving the socket has only ever been reasoned about.

### Charge evidence: what makes a charge session believable

ANY ONE of the charger frames, fresh, is enough.

**Why the list exists at all.** The owner needs to read (and later write) the DC charge-current limits, and that work happens PLUGGED IN — you cannot test `MAX_DC_CHG_CURRENT` on a bike that is not charging. A stationary charging bike is also arguably a safer thing to be servicing than a stationary ready-to-ride one: it is tethered to a cable, the rider is off it, and it cannot be ridden away without unplugging first.

**Why the escape is narrow, and why that makes it cheap.** It excuses exactly ONE check, `energized`. Speed, motor rpm, `moving`, `go`, `go_request` and `throttle_on` all still have to be clear. So the worst a WRONG charge detection can do — a false positive, the list firing when nothing is plugged in — is degrade the gate to "stationary and not in drive", which is precisely what it would be if `energized` had never been in it. It cannot admit a moving bike, and it cannot admit one in drive.

**Why `0x102` carries no usable charge bit.** It used to look as though it did. `charging` (`0x102` b2 bit0) was reasoned about as "the AC bit", on the grounds that it reads 0 through a DC fast charge. That was too generous: it reads 0 through AC charging too, because it is the high beam. `0x102` does now carry ONE real charge signal, `fast_dc_contactor` (b3 bit0), but it is set only on DC, so it cannot cover the AC case on its own either. The charger frames cover both, which is why they are the whole list. Their VALUES are never consulted — that the frame arrived at all is the claim — so this detects "plugged in" rather than "current is flowing".

### ⚠️⚠️ `0x102` b2 bit0 is not a charging bit. It is the high beam.

It is now decoded under its real name, `high_beam_lamp`; it was called `charging` until 2026-08-16 and the service gate refused to depend on it for a fortnight before the rename caught up.

Established from `rides.db` on 2026-08-16, six days of real riding:

- it equals `high_beam` (`0x102` b0 bit6) at 421 of 421 timestamps — 100 %;
- every transition of one is within 3 ms of a transition of the other (median 0);
- it reads 1 at 100-142 km/h, for 47 s at a stretch, on clean uninterleaved data;
- it reads **0 through all 25 real charging sessions**.

Re-measured per frame the same day, over all 1 103 000 frames of `0x102` in the 14 candump captures: 1 103 000 / 1 103 000 agreement, zero disagreements either way, while the cross-pair (b2 bit0 against b0 bit7) agrees only 49.35 % — so this is not two nearly-constant bits flattering each other.

Two different bytes, so it is not decoder aliasing — they are two genuinely distinct bits that move together, the switch-and-lamp pairing `decode.ts` had already worked out for the blinkers. The third-party `.xdbc`'s "b2 bit0 = charge" is simply wrong.

Using it as charge evidence would have meant SWITCHING ON THE HIGH BEAM EXCUSED THE DRIVE BEING ENERGIZED. The rename removes the trap's bait; the finding is kept because the list of things that are NOT charge evidence is worth more than the name that misled us.

### ⚠️ Why two motion checks may go ABSENT while charging

`rides.db`, 2026-08-16: across all 25 real charging sessions there is **not one live `speed_can_kmh` or `motor_rpm_can` sample**. The bike stops broadcasting `0x104` while it charges (an Energica on a charger is asleep apart from the charge manager and the BMS), so a gate that demanded a fresh one could never open on a charging bike — which is the single state this whole feature exists to serve.

Worse, the naive workaround is a trap the same data documents: forward-filling the last value hands you **47.0 km/h and 1 976 rpm** for a bike that had been plugged in for seven hours, because that is what it was doing when it last spoke. Never fall back to the last value, and never fall back to zero.

So while a charger is attached, those two are allowed to be missing or stale — and `moving`, `go`, `go_request` and `throttle_on` still have to be FRESH and clear. All four are `0x102`, which is 100 Hz and which `CAN_MAP.md` records as live through a DC session (it caught b1 going `0x10` → `0x12` at the start of one). So the gate still requires proof that the bike is awake and talking; it just no longer requires the one frame the bike is known to stop sending. If `0x102` goes quiet too, everything blocks and service mode is unavailable — correct, because a sleeping VCU answers no `10 81` either.

A fresh `0x104` that says the bike IS moving still blocks, charger or no charger. This relaxes "we must see it" and not "it must be zero".

### `energized` — and why it is excused while charging

✅ CAN `0x102` b1 bit1, as a decode: observed 0 on the parked bike 2026-08-02 AND observed toggling with the rider's actions on the garage lap that afternoon — both states seen, which is what separates it from `key_on`.

⚠️ `energized` = 1 does NOT mean "rideable". `CAN_MAP.md` records it setting for the whole of a 17-minute stationary DC fast charge on 2026-08-04 (`0x102` b1 `0x10` → `0x12` at the session start, clearing at the end). The bit means the HV side is up, and a charging bike's HV side is up by definition.

⚠️⚠️ **So it is excused while charging, deliberately.** An earlier version of this file blocked a charging bike and argued that a false refusal was the safe direction. That was wrong on the merits, not merely unpopular: the entire reason service mode exists is to read — and later write — the DC charge-current limits, and there is no way to test `MAX_DC_CHG_CURRENT` on a bike that is not plugged in. Refusing the one state the feature is FOR is not caution; it is a gate that gets switched off. A charging bike is also tethered to a cable, so it cannot be ridden away without someone unplugging it first.

Do not "fix" this back. What keeps it safe is that the excuse is narrow and that every other check still applies: a charging bike must still show zero speed, zero motor rpm, `moving` clear and the whole drive-request trio clear. The implication the rule contributes is unchanged in the direction that matters: `energized` 0 ⇒ the drive is down.

### `go` — corroboration, not a load-bearing check

⚠️ Measured on `rides.db` 2026-08-16: `go` = 0 is NOT a reliable "cannot move". Two clean episodes have the bike rolling at **5.2-6.7 km/h with `go` = 0 AND `energized` = 0** (2026-08-08 14:59:53 for 8.1 s, and 15:00:30 for 1.1 s) — physically ordinary, since a bike can be pushed or coast with the drive down. That is exactly why speed and rpm are the load-bearing checks and these are corroboration. A gate resting on `go` alone would have opened on a bike rolling at jogging pace. The converse holds well — 98.5 % of live `go` = 1 time has the bike actually moving — so `go` = 1 is a trustworthy positive.

🟡 CAN `0x102` b1 bit3. Caught toggling with the rider's actions on the same lap, so SOMETHING real lives at that bit and it moves when the bike is ridden — which is what a gate needs. The NAME is weaker than the observation: the manufacturer's own signal table for this frame (the same service-tool source `src/diagnostics/dtc-table.ts` is reconciled against, which names the two adjacent bits KickStand and Start Switch) does not list b1 `0x08` at all, so "go" is the third-party `.xdbc`'s label and not the manufacturer's. Gating on it is still right — a bit that moves with riding and reads 0 parked is exactly the evidence wanted — but do not read the name as authority.

### Signals considered for the gate and deliberately left out

Kept because the next person to look at this will have the same ideas, and most of them are traps. Several are things a brief would reasonably suggest; the reasons they do not work are in the reverse-engineering notes rather than anywhere obvious.

- **`reverse_gear`** (`0x104` bit 63) — the obvious "not in gear" check, and now the best-understood rejection here. Settled against `rides.db` on 2026-08-16, six days of riding:
  - it is NOT a latched gear selection. 597 rising edges in **62 separate bursts across all six days**, and **404 of the 597 pulses are under 50 ms** (median 30 ms) — bus-rate chatter, which no rider-operated selector makes;
  - it IS tied to very low speed. Median `speed_can_kmh` at a rising edge is **0.4 km/h**, p95 0.7, and in clean data (excluding six windows where two contradictory `0x104` streams are interleaved) it **never exceeds 4.1 km/h**.

  So both earlier readings were half right: the owner saw it change when he engaged reverse, and the capture note saw it fire without reverse. It behaves like a direction-of-rotation or rollback indicator — plausibly the sign bit that `speed_can_kmh` and `motor_rpm_can` lack, since both are unsigned and neither ever goes negative in 6.2 M rows. Engaging reverse turns the wheel backwards, which is why it looked like a gear. Excluded because a 50 ms pulse cannot gate anything without heavy debouncing, and because "the wheel is creeping" is already covered by `speed_can_kmh` itself. Worth decoding properly under its real meaning some day.

- **`stand_up`** (`0x102` b1 bit5) — the bit itself is the best-attested one here: the manufacturer's own table calls it KickStand, so it is confirmed rather than reverse-engineered. It is left out on MEANING, not confidence. A bike on a paddock stand or a workshop lift reads `stand_up` 1 while being as parked as a motorcycle gets, and that is precisely the situation service mode is for. Requiring it would refuse the workshop. (Its polarity — 0 = stand down — also rests on one observation, "stand_up 0 (it is on the sidestand)".)
- **`key_on`** (`0x102` b1 bit4) — has only ever been observed as 1; `decode.ts` says so explicitly ("a key-off capture is what would confirm it"). A check never seen to fail is not a check.
- **`throttle_pct`** (`0x109` b0-1 ÷10) — would be a second, independent throttle reading, and the ÷10 scale is 🟡 with "0000 idle" seen at exactly one operating point. If this bike's throttle sensor rests a tenth of a percent off zero, a gate demanding zero refuses every sweep for ever, and nobody could find out for a week. `throttle_on` is the same fact as a confirmed BIT, so it is used instead.
- **`0x101` b0/b1** — suggested as a vehicle-mode enum. It is not one, or not one that helps: `obd-garage/DC_CHARGE_LIMITS.md` §5 gives 43/40 for **"riding / idle" as a single row**, 62/60 transitional and 104/100 DC charging, from one session on 2026-08-04. It therefore does not separate a moving bike from a parked one — it is a not-DC-charging detector. It is also not decoded here at all, not in the kernel RX filter, and `CAN_MAP.md` (older) still lists `0x101` under "unmapped".
- **`bms_state_*`** (`0x201` b0) — suggested as vehicle state; it is the BMS's own charge state and it says nothing about motion. `bms_state_discharge` reads 1 on a parked bike drawing −0.2 A of housekeeping current, and during a DC fast charge the BMS sits in `bms_state_idle` and never reports Charge at all (`CAN_MAP.md`, 2026-08-04). Neither state distinguishes parked from moving.
- **`high_beam_lamp`** (`0x102` b2 bit0) — **the high beam**, and shipped as `charging` until 2026-08-16. Not a gate, and not charge evidence either; the full argument and the numbers are above. Kept on this list under its new name because the old one is still in the ride log, in old Grafana panels and in anyone's memory, and it was the one signal here whose NAME invited you to use it.
- **`bms_err_contactor`** (`0x201` error bits 21-25) — a FAULT flag, not contactor state. It is 0 on a healthy bike whether the contactors are open or closed, so it says nothing about whether the HV bus is live. There is no contactor-state, precharge-complete or HV-live signal broadcast on this bus at all; the BMS has them internally and the stock config does not transmit them.

## 13. Service actions: the clock, and Mode 04

### Setting the bike's own clock

✅ **The mechanism exists, and it is not a diagnostic service at all.** Energica's "Sync RTC" is `KWP2000Moto.UpdateRTC()` in the service tool's shared library, and all it does is put ONE raw broadcast on CAN `0x120`: a `94 FF` header followed by five bit-packed bytes of **UTC**, zero-padded to eight. No session, no SecurityAccess, no reply — the method takes a host-side bus mutex, sends, sleeps 100 ms and returns true unconditionally. The tool fires it automatically on every connect, after both diagnostic sessions have been stopped, so the VCU accepts it with nothing open.

There is NO diagnostic route to the clock. Searched exhaustively: `SendFrame(288,…)` occurs exactly once in the whole of that library, the `RoutinesID` enum has no clock routine, and no parameter named for a clock exists in `params.ecf`, in any of the 28 firmware bundles' parameter tables, or in the VCU telemetry dictionary.

⚠️ **And the bike's current time cannot be read back.** There is no parameter, no service and no broadcast frame carrying the VCU's current date and time. So this action is WRITE-ONLY and unverifiable: unlike a parameter write, there is nothing to read back. The nearest indirect readback is a freeze frame's timestamp (same 2000-01-01 epoch), which needs a DTC to exist first. That asymmetry is why the confirmation asks the owner to confirm the time rather than reporting success afterwards — the Pi is the only thing that can vouch for it.

⚠️ **Corrections to `obd-garage/SERVICE_RESET.md` §5, 2026-08-16:**

- It says "`0x120` is a write/command frame — out of scope to send". That is now stale: the frame has been sent, twice, on 2026-08-16, by another owner's tool.
- It does not say the time is UTC. It is `DateTime.UtcNow`, not local. Sending local time would set the bike's clock wrong by the timezone offset, and the service stamp with it.
- The field-to-bit map is not in that file at all. It is below, from the decompiled method and cross-checked against two frames captured on the wire.

**The `0x120` layout**, from the decompiled `UpdateRTC()` — every field little-endian WITHIN itself and split across byte boundaries, which is why `buildRtcSyncFrame` writes it out rather than expressing it as a loop:

```
byte 2  bits 0-4  hour            bits 5-7  minute, low 3 of 6
byte 3  bits 0-2  minute, high 3  bits 3-7  second, low 5 of 6
byte 4  bit  0    second, bit 5   bits 1-5  day of month   bits 6-7  weekday, low 2 of 3
byte 5  bit  0    weekday, bit 2  bits 1-4  month          bits 5-7  unused, always 0
byte 6            year − 2000
byte 7            zero padding to DLC 8
```

The weekday is .NET's `DayOfWeek`: **Sunday = 0** through Saturday = 6, which is also what JavaScript's `getUTCDay()` returns — so no conversion, and that coincidence is worth stating rather than relying on silently.

✅ Checked against two frames that really went out: `94 ff 04 02 20 10 1a 00` is 2026-08-16 04:16:00 UTC and `94 ff 66 e8 20 10 1a 00` is 2026-08-16 06:03:29 UTC. `scripts/check-vcu-params.ts` §15 asserts both, in both directions.

### OBD Mode 04: clear stored trouble codes

⚠️ This is the first thing in this project that changes ECU state OUTSIDE the parameter table, and it deserves naming as such. `src/can/obd-dtc.ts` — the always-on poller — says Mode 04 "is deliberately absent and must stay absent", and it still is: that module reads codes on a timer and nothing about it changed. Mode 04 lives in `service-actions.ts`, on the service-mode path, behind the same gate, the same separate enable switch and the same two-step confirmation as a calibration write.

**Why it is dangerous in a way the DTC READS are not.** The stored list on this bike has been accumulating since before anyone started looking — 39 codes as of 2026-08-04 — and it is not recoverable once cleared. The pump code P0A07 in particular took two passes and a reconciliation against a second source to settle (PRs #48 and #54), and every one of those passes read the bike's own stored list. Clearing it throws that away and, worse, throws away the freeze frame with it.

**What it actually does, beyond clearing the list.** 🟡 Mode 04 in the standard also resets readiness monitors and the freeze frame, and on many ECUs it resets fuel trims and adaptive values. What THIS VCU does with it has never been observed. It is not a "clear the dashboard light" button; it is "erase the diagnostic memory", and the honest position is that we do not know the full extent of what is erased.

**Telling our Mode 04 reply from the poller's traffic.** `isClearDtcsReply` exists because the always-on OBD poller never stops. `startObdPoller(500)` keeps sending mode-01 PID requests — and, every 120th round, a multi-frame mode-03 transfer — throughout the 300 ms window a Mode 04 reply is awaited in, and the bus lease does not cover it (it excludes the two service-mode runners from each other, not the poller). So the OBD response range carries other people's frames while we are listening, and "the first frame in `0x7E0`-`0x7EF`" is not our answer.

The KWP legs of a write need no equivalent because `parseResponseFrame` requires byte 0 to be the tester's address `0xF1`, and no ISO-TP PCI byte can be `0xF1`. Mode 04 has no such discriminator built in, so it needs this one.

Getting it wrong is worse here than elsewhere: a poller reply consumed as ours would be reported as "nothing confirmed" for an action that may well have erased the bike's diagnostic memory — inviting a retry of something irreversible — and the poller would silently lose the frame, which for a Consecutive Frame means losing a whole trouble-code transfer.

It is deliberately permissive about WHICH ecu answered and strict about WHAT it said: a functional request may be answered from anywhere in the range, but only `44` or a refusal naming service `04` can be an answer to `04`. A First/Consecutive/Flow-control frame in that range belongs to the poller's mode-03 transfer, and taking it would break that.

### Should the service stamp be a LOGGED SIGNAL? No.

It was worth asking — the brief did — and the answer is a clear no, for the same reason `sweep.ts` gives for not sweeping at startup:

1. **Reading it costs a KWP session on A8.** The always-on service does not ask the micros anything outside service mode, and the whole safety argument rests on that. A logged signal means a poll, and a poll means requests on the bus while the bike is being ridden.
2. **It moves about once a year.** `src/can/signals.ts` logs on change, so this would be one row per service and ~230 extra keys' worth of nothing in between.
3. **The snapshot already IS the record.** A stamp read in service mode is written into the audit journal (`write-audit.ts`) with its before/after, which is a better record than a signal row: it says who read it and what happened next.

If it is ever wanted on a Grafana panel, the right shape is a row in the audit journal being exported — not a signal being polled off a motorcycle's bus.

## 14. Snapshots on disk

`src/vcu/snapshot-store.ts` implements four rules that are worth more than the code that implements them. All four came from `scripts/read-vcu-params.ts`, which is where the sweep used to live as a separate process. They are the reason the sweep was worth moving rather than reimplementing.

1. **Every row is written the moment it arrives**, to `sweep.partial.jsonl`. The link to the bike drops as routine — on 2026-08-08 it cost a whole result set mid-read (`DIAG_ADDRESSES.md` §6) — and a sweep that has to survive one connection is a sweep that loses everything to a service restart.
2. **A resumed sweep does not re-ask what already answered.** Rows that came back as a value are carried forward; rows that failed are retried, because on this link most failures are transient and the alternative is a resume that carries yesterday's timeout forward for ever.
3. **A partial snapshot is kept and labelled, never discarded.** Half the parameters off a real bike is half a set of facts. `complete: false` is what stops anything downstream reading it as all of them.
4. **A finished sweep names its own parameters.** A row is named when it arrives, from whatever table was active then — and on a first sweep of an unfamiliar bike that is a default, because `TABLE_TYPE_uC` is only read partway through the A9 pass. So before anything is written, the whole snapshot is re-named from the table the snapshot ITSELF reports (`retableSnapshot`). Otherwise the first sweep of another owner's bike is stored, served, exported and diffed under this bike's names — which on the 20 tables where ids 70–94 are `RegenFade_0…24` means writing `CELL_COUNT` and `CELL_OVERVOLTAGE` to disk for a bike that has neither.
5. **A worse run never clobbers `latest.json`.** That file is the diff baseline and what `GET /vcu-params` and `/vcu-backup.csv` serve. A run where the bike was asleep, or one the safety gate cut short after three parameters, is a fact about the run — the timestamped archive records it — and must not replace a file full of real values with one that is nearly empty. Otherwise the export button offers three parameters as this bike's calibration, and the next run diffs against them and reports 274 disappearances with any genuine value-changed buried underneath.

### Why the baseline rule is a comparison, not `read > 0`

`read > 0` only catches the fully-empty run. The failure the rule is actually about is A BAD RUN REPLACING A GOOD FILE, and the service gate has made a new way for that to happen routine: a complete sweep deletes the resume file, so the next one starts from nothing — and if the owner rolls the bike three parameters in, the auto-exit is working exactly as designed and `read === 3` is still greater than zero. That three-row snapshot would become what `/vcu-params` serves, what `/vcu-backup.csv` exports as this bike's calibration, and the baseline the next run diffs against (reporting 274 disappearances). The 277-row archive would still be on disk, and nothing in the dashboard can reach an archive.

So a snapshot has to be at least as good as the one it replaces: complete, or carrying at least as many real values. A complete sweep wins even with fewer rows — a bike that answered 200 of 277 today is a true reading of the bike, and the diff saying so is the point.

### Loading the last sweep

`loadLatestSweep` returns null on every failure — missing file, unreadable file, valid JSON that is not a snapshot — and never an empty report. `table-gate.ts` reads a null report as "nothing has confirmed either micro", which blocks, so every one of those failures fails closed. They are logged rather than swallowed because "no sweep has run" and "the snapshot is damaged" are different problems and only one of them is fixed by reading the bike.

⚠️ The rows are re-named from the table the snapshot itself reports, exactly as `src/http/vcu-params.ts` serves them. A stored snapshot's names are a DERIVED view: a file written before the catalogue existed carries whichever table that build hardcoded, and anything matching a row to a parameter BY NAME has to be looking at the bike's own names rather than that build's.

### Why a snapshot and not a signal

These are configuration, not telemetry. They do not move while riding, so logging 277 of them as time series at any rate is storage spent on re-recording a constant — the deadband reasoning in `src/can/registry.ts` counts rows/day onto a Pi Zero's SD card for signals that genuinely change, and these do not. Neither do they belong in `liveState`, which `src/ws.ts` re-broadcasts WHOLE every five seconds; `src/diagnostics/stored-codes.ts` already declined to put 39 trouble codes there for exactly that reason, and this would be seven times worse.

What IS worth knowing is that one of them CHANGED, because that means something reconfigured the bike. That is a diff between two snapshots, not a sample rate.

## 15. The backup CSV format

`src/vcu/backup-csv.ts` renders a snapshot as `vcu_backup.csv` — the file another owner's `energica_tool.py` writes from its "Save backup…" button, byte for byte, so the two tools can exchange parameter sets.

### Provenance of the format (established 2026-08-15)

`energica_tool.py` is a reverse-engineered Energica VCU tool by another owner, built from the decompiled NRJK7 app. Its `_params_save_backup` is six lines:

```python
with open(path, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["id_hex", "name", "value"])
    for pid in sorted(self._param_cur):
        if pid in PARAMS and self._param_cur[pid] is not None:
            w.writerow([f"0x{pid:02X}", PARAMS[pid][0], self._param_cur[pid]])
```

PROVEN, not inferred: that code was executed against its own PARAMS table on 2026-08-15 and the bytes captured. Python's default `csv` dialect is `excel`, so the shape below is not a guess about what "CSV" means here —

```
id_hex,name,value\r\n
0x06,CHARGE_RESTART_HOLDOFF,20\r\n
0x0F,MODEL,358\r\n
```

- comma delimiter, no spaces around it;
- CRLF after EVERY row INCLUDING the last (`csv.writer` terminates each row, so the file ends with a newline — unlike `params.ecf`, which does not);
- QUOTE_MINIMAL with `"`, which never fires for this table (see `quoteField`);
- ASCII throughout, and `newline=""` means Python does no translation, so the bytes are the same on every platform. No BOM.

`scripts/check-vcu-params.ts` §9 compares our bytes against a golden fixture taken from that tool's own writer, with no bike and no Python in the loop.

### Why `id_hex` is our `index` in hex

PROVEN 2026-08-15 by comparing that tool's 206-entry PARAMS table against `params.ecf` line by line: for every one of the 206, the dict key equals the file's decimal index, and the name, width, S/U column, µC column and `[SECTION]` all match with ZERO mismatches. So `0x{pid:02X}` is `0x` + this table's index in uppercase hex. It is the same number our identifier carries in its low 12 bits.

That tool reads parameters with `21` ReadDataByLocalIdentifier and a ONE-BYTE local id, which is why its table stops at `0xFF` and why it cannot see the ten real parameters at indices 256…277 — `MAX_AC_CHG_CURRENT`, `MAX_DC_CHG_CURRENT`, `MAX_C_TEMP`, `CHARGER_TYPE` and the EEPROM/TABLE version pairs among them. We read with `22` and a 16-bit identifier, so we do see them, and they are exported: `0x102` is simply three hex digits where the rest are two. Its restore path (`_params_restore_backup`) does `int(row["id_hex"], 16)` and skips any id not in PARAMS, so the extra rows are ignored by that tool rather than misread — and dropping this bike's actual DC charge-current limit from its own backup to look more like a tool that cannot reach it would be the wrong trade.

### Which rows are written

Only rows that carry a typed value, which is that tool's `pid in PARAMS and self._param_cur[pid] is not None` in our vocabulary:

- `status !== "read"` — the bike never answered, so there is no value to back up. Writing the failure reason into a numeric column would produce a file whose restore path (`int(row["value"])`) throws, or worse, doesn't.
- `value === null` — the name table has no honest opinion (an identifier it does not describe, or a record whose width contradicts the TYPE column). The raw bytes are still real and are still in the snapshot and on `/params.html`; they just have no place in a two-column-of-meaning file.
- `name === null` — nothing to put in the `name` column. Implied by the above (an unnamed identifier cannot have a typed value) and checked anyway, because a silently empty name field would look like a real parameter called "".

Ascending by index, which is that tool's `sorted(self._param_cur)`. The rows are already sorted by whatever wrote the snapshot; sorted again so the output does not depend on that staying true.

## 16. The write audit journal

`src/vcu/write-audit.ts` appends every attempt to change something on this motorcycle to one file, for ever: what was asked for, what the bike held before, what it held after, and how it went — including the attempts that were refused, and especially those.

### Why it exists at all

`obd-garage/VCU_PARAM_CHANGES.md` is the current record of what has been changed on this bike, and it is a hand-maintained markdown file in a folder that is not even in this repository. It has already proved its worth twice — it is what made "neither `MAX_DC_CHG_CURRENT` nor `FCHG_CURRENT_GAIN` was ever touched" a checkable claim, which is what killed a whole hypothesis about the charge ceiling. But a hand-maintained file records the changes someone remembered to write down.

A parameter sweep is the other half: `snapshot-store.ts` diffs every snapshot against the last and shouts when a value moved. That catches the FACT of a change and not its author — "something reconfigured the bike" is exactly as far as a diff can go. This journal is what turns that into "service mode wrote 80 into `MAX_DC_CHG_CURRENT` at 14:02 on 2026-08-23, over a 75 that it read first".

### Append-only, one JSON object per line

The same shape as `sweep.partial.jsonl` and for the same reasons: a torn write costs the last line and nothing else, it survives a service restart mid-write, and it can be read with `tail`. Never rewritten, never compacted, never pruned — this is a file that should be boring and enormous rather than clever and short.

⚠️ A REFUSED attempt is recorded exactly as carefully as a successful one. "The micro refused this three times" is the record that matters when someone is trying to work out why a parameter will not take, and a journal that only holds successes is a journal that answers no interesting question. It is also the only place the SecurityAccess attempts get counted, and those are the resource that runs out.
