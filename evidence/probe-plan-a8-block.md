# Probe plan — A8's 25 bank-1 parameters outside `params.ecf` (#219)

Written 2026-09-14 by Daniel's AI agent, for the next time the bike is awake and in wifi range. **Read-only throughout: every request below is `22` ReadDataByCommonIdentifier in a `10 81` session. Nothing here writes, and three of these identifiers must never be written — see §7.** The coordinator runs this; the track that wrote it does not touch the bus.

## 1. Preconditions

- Bike keyed on and **parked** — the service gate refuses everything below otherwise, and it is the gate, not this document, that decides.
- `SERVICE_MODE_ENABLED=1` on the Pi, and the Pi reachable (no reception in the garage; it has to be in wifi range).
- Nothing else on the bus: one sweep, probe, lifetime read or trouble-code clear at a time (`src/vcu/bus-lease.ts` refuses the second and says who has it).
- The service holds the single BLE connection to the Connectivity Hub; that is unrelated to this and does not need stopping.

## 2. ⚠️ Use ONE SWEEP as the primary instrument, not 25 probes

```
curl -X POST -H 'X-Cool-Eva: service-mode' '<pi>/vcu-read'        # start
curl -s '<pi>/vcu-read' | head -c 400                             # watch
```

Why the sweep rather than 25 separate `/vcu-probe` calls:

- **A sweep holds the A8 session across the whole block.** Requests are paced 10 ms apart and the session idles out after ~2.5 s, so all 25 are asked inside one session. A probe opens a session, asks once and stops — and on 2026-09-14 one of the three probes came back `no-session`.
- **It parks the 2 Hz OBD poller for each of the 25 block rows** — not only the three wide ones — because their widths come from a firmware image nobody has matched against what is flashed, and a park chosen off a width that might be wrong skips exactly the row it was needed for. The 44 named A8 parameters are read unparked, as they always have been. A hand-run probe parks unconditionally, which comes to the same thing for one read.
- **It writes the answers down.** A probe's reply exists only in the HTTP response; a sweep's lands in `vcu-params/latest.json`, in the archive, in the diff against the previous snapshot, and in `journalctl -u cool-eva`. For this question — _which of these 25 answer, and with how many bytes_ — the snapshot is the artefact.

Afterwards, keep the evidence the way `evidence/probes-20260914.txt` was kept:

```
journalctl -u cool-eva --since '-20 min' | grep -E 'vcu-(sweep|read):' > evidence/sweep-a8-block-<date>.txt
curl -s '<pi>/vcu-params' > evidence/vcu-params-<date>.json
```

## 3. What each index is, and what its answer settles

`CID = 0x1000 | index`, bank 1, micro **A8** — request `A8 03 22 <hi> <lo>`. Widths are what A8's own firmware parameter table types them (#219); a **width that disagrees is the most interesting outcome on this page**, because it is the first thing that would say the firmware image is not what is flashed.

| idx | CID | firmware width | expected reply | what an answer settles |
| --- | --- | --- | --- | --- |
| 278 | `0x1116` | DWORD | **7 bytes, two frames**: `F1 10 07 62 11 16 b0 b1` → our `A8 30 FF 00` → `F1 20 b2 b3 …` | Confirms the 4-byte record by **measurement** rather than by inference from framing — which is the one thing the 2026-09-14 probe could not do. Half of the odometer master. |
| 279 | `0x1117` | DWORD | 7 bytes, two frames | The other half. **Never asked before by anything in this project.** |
| 613–621 | `0x1265`–`0x126D` | WORD | 5 bytes, one frame | Whether the calibration block exists on this bike at all. Any answer makes it real; silence and a refusal (NRC) are different answers and both are informative. |
| 622 | `0x126E` | WORD | 5 bytes, one frame | The one with a traced use: A8 `0x10EB4` computes `([0x20000B2C+0x2A] × PARAM_622) >> 12` and range-checks the product against parameters 223/224 (600…2500). A non-zero value puts a number on that scale factor. |
| 623–625 | `0x126F`–`0x1271` | WORD | 5 bytes, one frame | Same block. |
| 626 | `0x1272` | DWORD | 7 bytes, two frames | The third wide record. Nothing is traced about it. |
| 627 | `0x1273` | BYTE | **4 bytes**, one frame | The only BYTE in the block — a 4-byte reply is the confirmation, and a 5-byte one would say the width column is wrong. |
| 1000–1003 | `0x13E8`–`0x13EB` | WORD | 5 bytes, one frame | The **last-service stamp**: date low/high, odometer low/high, `value = (high << 16) \| low`, date = seconds since 2000-01-01 UTC. All four answered **zero** on 2026-09-08 (`docs/service-stamp.md`). Zero again = still no service point. Non-zero = a service point exists, and the decode is already written (`src/vcu/service-actions.ts`). |
| 1004, 1005 | `0x13EC`, `0x13ED` | WORD | 5 bytes, one frame | Nothing traced. Never asked. |
| 1006, 1007 | `0x13EE`, `0x13EF` | WORD | 5 bytes, one frame | The **only two identifiers the manufacturer's service tool was ever captured writing** (2026-08-08, `obd-garage/DIAG_ADDRESSES.md` §9.2/§9.5). It read 1006 back as `0x93 80` and wrote the same value; it wrote `0x29 C2` to 1007. **Reading the same two values now would be strong evidence these are the same cells;** a different value is its own finding. |

### 3a. Controls — do not skip these

The 2026-09-14 run is believable because index **254** (`SPEED_ODO_REARWHEEL_C`, a named A8 parameter) came back `07 BF` = 1983, matching `params.ecf`. A sweep reads all 44 named A8 parameters anyway, so the control is free. If any of them fails in the same run, the block's results are about the transport and not about the block.

### 3b. The one cross-check worth doing by hand

If 278 and/or 279 answer with four bytes, compare their `unsigned` readings against **the odometer as the bike reads it in the same minute** — CAN `0x104` bytes 0-3, little-endian, ÷ 10 = km (nailed against the Connectivity Hub's own `odometer_km` in `obd-garage/CAN_MAP.md`). The dashboard shows it live. A match on one of the two names which half is which and confirms the pair is the odometer master; a mismatch is worth more than a match, and means neither should be described as the odometer until it is understood.

## 4. Fallback: individual probes, and the order matters

If the sweep cannot be run, or a row comes back unread and is worth one more ask:

```
curl -X POST -H 'X-Cool-Eva: service-mode' '<pi>/vcu-probe?target=A8&bank=1&index=613'
```

⚠️ **Ask the NARROW rows first and the wide ones (278, 279, 626) last.** On 2026-09-14 the probe of 613 came back `no-session` — A8 did not answer `10 81` — in a run where 254 and 1000 both answered, and the evidence file records 613 **immediately after** the probe of 278, the one that produced an unanswered First Frame. A micro that has sent a First Frame and had no flow control sits in its N_Bs window with its transmit side busy (`docs/vcu-parameters.md` §9), which is a better explanation of that one `no-session` than anything about index 613. Since #231 this repo answers the First Frame, so the contamination should be gone — but the cheap way to keep the result clean is not to put a wide read in front of the rows you care about.

A `no-session` is a transport failure and not a refusal: retry the probe once before writing the index down as unreachable.

## 5. What this run settles that nothing else can: the 45th record

`docs/vcu-parameters.md` §2 has carried this since it was written: `obd-garage/CAN_MAP.md` logs **45** records for A8 bank 1 against `params.ecf`'s 44 named, and the 45th is unidentified.

It cannot be closed by arithmetic from here:

- The 2026-07-26 scan's index range is **not recoverable**: its script is gone (the corrected version lived in `/tmp`), and `obd-garage/kwp_scan_raw.txt` holds **A9 records only** — 233 bank-1 rows, highest identifier `0x0114` = 276, which bounds nothing about the A8 run.
- Nor is it recoverable which of the 44 named indices answered in that run, so "45 = 44 + 1" is not safe as arithmetic either. (An earlier draft of this plan argued from "44 named + 5 known-to-answer = 49 > 45". That needs all 44 to have answered, which is exactly what is not recorded — and read backwards it says 40 + 5 = 45, which would argue the other way. Dropped.)

**So the count is settled by enumeration, not by inference.** One sweep asks all 69 A8 bank-1 identifiers this software now describes and writes down which answered, with how many bytes. That number, and the list behind it, is the answer to §2's question — and if it is not 45, that is a fact about the old scan's range rather than about the bike.

## 6. ⚠️ PROPOSED, not authorised: `0x1A` ReadEcuIdentification

**Nothing in the repo can send this today and this document does not change that.** `param-codec.ts`'s request union has three members — `10 81`, `3E`, `22` — and `READ_ONLY_SERVICES` has the matching three service bytes. Adding a fourth is a decision, not a detail, and it needs a **coordinator GO on the events log before any code**.

- **What it would buy:** #219's own open caveat — _"whether the A8 in this bike runs this firmware build"_ is not established, and every width in §3 comes from that build. `0x1A` returns the ECU's identification block and would settle it in one frame.
- ⚠️ **What is NOT established, and it is the load-bearing part: A8 has never been asked.** The manufacturer's service tool sent `0x1A` 7 times in the 2026-08-08 capture and got a positive `5A` every time — but all seven were to **A9** (`obd-garage/DIAG_ADDRESSES.md` §9.1), and A7 answers nothing to it at all. Nobody has ever sent it to A8. **If A8 refuses, the firmware-build question stays open and the change bought nothing.** Weigh the GO on that, not on the seven replies.
- **The change, exactly:** a `{ kind: "read-ecu-identification"; identifier: number }` member on `VcuRequest`, `0x1A` added to `READ_ONLY_SERVICES`, one branch in `encodeRequestPayload`, and one entry point. It is a read — `0x1A` has no write semantics, takes no value, and cannot name one.
- **Why it is still a decision:** three module headers cite the union's three-ness as the reason a write is unexpressible, and `scripts/check-vcu-params.ts` §2 asserts it. Widening it is a change to the sentence this repo's read-only claim is made of.

Until that GO: **do not send `0x1A` by hand either.** A scratch script that puts a service byte on the bus is the same act with none of the review.

## 7. ⚠️ What must NOT happen on this run

- **No writes. At all.** Not `2E`, not `2F`, not `31`. Three of these identifiers are the ones the factory tool writes — the odometer master (278/279) and 1006/1007 — and another owner's tool writes the odometer pair. This project reads them and does not write them: _"He writes them. 🔴 Do not."_ (`obd-garage/OTHER_TOOL_AUDIT.md`).
- **No `31 FC`.** That is Set Service Point, which stamps _now_ over the last-service date and cannot be undone. Reading 1000–1003 is the opposite of running it.
- **No live test of anything on the write path**, and no `npm install` on the Pi — a plain `git pull` plus `systemctl restart cool-eva` is the deploy (`CLAUDE.md`).
- **Nothing here is a reason to ride the bike.** Every request above is refused unless the bike is parked, which is the correct behaviour and not an obstacle to work around.
