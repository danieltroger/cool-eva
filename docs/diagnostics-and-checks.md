# Diagnostics, service mode, and the check suite

Where the long prose from `src/diagnostics/`, `src/http/`, `src/gps/`, `src/ws.ts`, `src/storage/` and `scripts/` now lives. Moved here 2026-08-19 under CLAUDE.md's comment budget; nothing was shortened on the way, only relocated. The code keeps a sentence and a pointer, plus two classes of comment that do not survive a link: a hazard a reader must meet at the line, and a check's own account of what it would fail to catch.

Sibling documents: `obd-garage/CAN_MAP.md` (local-only) for the broadcast frames, `README.md` for the operator-facing view, `docs/` for the CAN and VCU subsystems.

---

## 1. Three fault channels, three encodings

The bike answers three different questions about faults, and conflating them has already caused confusion in this project's own notes.

| Channel | Question | On this bike | Decoder |
| --- | --- | --- | --- |
| Connectivity Hub type 25 (`0x19`), mirrored to CAN `0x410` | what is ACTIVE right now | 0 or 1 entries, and it flickers | `src/diagnostics/decode.ts` |
| OBD-II mode 03 | what is STORED | 39 entries, stable | `src/diagnostics/obd-dtc.ts` |
| KWP `0x17` freeze frame | the conditions when ONE code latched | one record per component | `src/diagnostics/freeze-frame.ts` |

A bike with 39 stored and 1 active is exactly this bike's current state.

### The encodings are different too, which is the actual trap

- The hub and the freeze-frame service speak Energica's own **(component, symptom)** pair — the `COD.` and `SYMPTOM` columns of `src/diagnostics/dtc-table.ts`. Component numbers run 1…63, symptoms 0…15.
- Mode 03 sends the **16-bit binary DTC** a generic scan tool would print. The table is reached through its OBD column instead, via `lookupByObdCode()`.

The two are not convertible by arithmetic, and feeding one encoding to the other's lookup silently produces wrong names rather than no names: the hub's `2C 00 00` reads as **P0A07** under the component reading and as **P002C** under the binary one. Going the other way, sending `0x0514` to the `0x17` service because mode 03 called something P0514 asks for component 1300, which does not exist.

In the freeze-frame request the SYMPTOM is not sent at all. It comes back in the status byte's high nibble, so the caller asks about a component and the ECU says which of that component's faults it has a frame for. Everything in that decoder therefore keys off the RETURNED pair, never the requested one.

---

## 2. Energica's DTC table

`src/diagnostics/dtc-table.ts` — 154 codes, data only.

### 2.1 Sources, and how they were reconciled

**First source.** Transcribed from `<Energica_Manuals>/2 Technical/CAN & Diagnostics/CANBUS from Type Approval.pdf` (EN.H.010134.001.OBD E2110, 24/03/2022, §7.6.2.7.4 "List of all OBD output codes and formats used").

**Second source, 2026-08-15 — the manufacturer's service-tool data.** The tool ships the same table as JSON embedded in its own executable, one `{id, code, symptom, title}` record per fault; the extract and the notes on it are kept outside this repo, with the rest of the source material. That is a second path to the same data — a shipped binary rather than a PDF read by eye — so where the two agree the transcription is corroborated, not merely careful. Against the 2021 extract they share **147** (component, symptom) pairs and **144** of those carry an IDENTICAL OBD code; the 2024 extract adds two pairs and changes none of those numbers otherwise.

**⚠️ The two service-tool vintages are ONE source, not two.** Both the 2021 tool (153 records) and the 2024 tool (155) were extracted; the 2024 table is a strict superset with ZERO id or title changes — it only adds (4,5) U0115 and (35,2) B1021 "REAR BRAKE PROLONGED PRESSURE FAULT". So the newer tool cannot be cited as agreeing with the older one: it is the same file carried forward. Where the tool and the PDF conflict, three years of shipping did not settle it.

**Coverage** is one-directional once both tool vintages are counted: the PDF has nothing the 2024 tool lacks, and the tool carries seven codes the PDF omits — 51/0, 52/0, 54/13, 60/0, 63/0, 63/1, all six of which are in the table, plus (35,2) B1021, which is not. "Coverage differs in both directions" was the 2021 reading and it died with the U0115 retraction.

**(35,2) B1021 is deliberately not added.** Nothing states its MIL, and the table's third column is what Energica means by a code _on this vehicle_, which that source does not carry either. It is a real gap, written down so the next reader does not have to re-derive the extract to find it.

**⚠️ MIL is unknown for the six service-tool-only codes**, and they carry `null` to say so. Only the PDF has a MIL column and it does not list them; the service tool's JSON has no MIL field at all, for any code. `false` would have been a claim — the dashboard renders it as "warning lamp: no" and sorts the code with the harmless ones.

**Keyed by two columns, not one.** `COD.` (component, 1…63, every one used) and `SYMPTOM` (0…15). The OBD column is the translation for a generic scan tool and is **not unique**: U0182 appears under both component 39 and component 40, and `lookupByObdCode` returns the first — the low-beam entry (39), which the document lists first. So (component, symptom) is the primary key.

### 2.2 The water pump: why (44,0) is P0A07

These rows were swapped on 2026-08-15 and the swap was **wrong**; it was reverted 2026-08-16. The type-approval PDF's original pairing stands: symptom 0 (open circuit) is **P0A07**, symptom 2 (locked) is **P0A05**. The bike itself settles it, and the evidence was already in this repo.

**✅ What the VCU actually transmits.** `scripts/captured-dtc-transfer.ts` holds a real mode-03 reply, 2026-08-04, byte-identical across five transfers. Its 39 two-byte DTCs contain `0A 07` — P0A07 — and **no** `0A 05`. This bike's chronic fault is (44,0), the open pump driver: the coolant pump is wired to the heated-grip output, leaving the VCU's own pump driver open. It is the one fault known to be real independently of anything on the bus, it is permanently present, and it is therefore necessarily among the stored codes. Under the swap the stored list claimed a _seized_ pump and no open-circuit fault at all, on a bike whose pump is not connected to that driver and so cannot seize. Run `node --experimental-strip-types scripts/decode-dtc-response.ts` to see it.

**✅ The list is in component order** — a check on the reading rather than an argument for it. The 39 codes walk components 1, 3, 4, 4, 5, 6, 7, 10, 11, 12, 12, 16, 20, 22, 34…40, 41, 42, 44, 46, 48, 49, 53, 53, 54×6, 56, 56, 61, 62 — strictly ascending, symptoms ascending within a component. P0A07 lands between P0121 (42,0) and P1044 (46,0), i.e. in component 44's slot. That is worth nothing as evidence about WHICH symptom, since both readings put the code on component 44; it only confirms the code was read off the right row. Do not stretch it further — the list carries plenty of non-minimal symptoms (P0514 is (4,2), P1012 (10,2), P1016 (11,2), P1020 (12,2), P1021 (12,3), P0601 (53,4), and the charge-manager block reaches symptom 11), so "symptom 2 would be the odd one out" is **false** and was claimed once.

**❌ Why the SAE J2012 argument for the swap does not hold.** It ran: an "open circuit" description under a "CIRCUIT HIGH" name is self-contradictory, so the rows must be swapped. But HIGH ⇒ OPEN and LOW ⇒ SHORT is Energica's convention throughout this very table, and it is the physically right one for a pulled-up driver-diagnostic input — an open circuit floats high, a short to ground reads low. Uncontested examples in the same file: (4,3) P0516 "…CIRCUIT LOW" = short circuit against (4,4) P0517 "…CIRCUIT HIGH" = open circuit, and (16,0) P0A10 "…CIRCUIT HIGH INPUT" against (16,1) P0A09 "…LOW INPUT". The type-approval PDF spells it out in the code names themselves: P0117/P0118 "COOLANT TEMPERATURE CIRCUIT LOW (SHORT CIRCUIT)" / "HIGH (OPEN CIRCUIT)", and P0A02/P0A03 the same. So P0A07 "CIRCUIT HIGH" = open circuit is the CONSISTENT reading; the premise of the swap was backwards.

**🟡 The service tool still says otherwise**, in both the 2021 and the 2024 build — `{P0A05: open, P0A06: short, P0A07: locked}` — and that is left recorded rather than explained away. Three things weigh against it: the two builds are one file carried forward, not two witnesses; the tool is generic across Energica's range while the Ribelle workshop manual p.288 is bike-specific and agrees with the type-approval PDF; and nothing in the tool depends on this string being what the VCU puts on the wire — it looks faults up by (code, symptom) and prints the id, so an id that never matched the transmitted DTC would never misbehave for a technician. That is exactly the kind of field that rots unnoticed.

**📌 The row that still looks wrong, and why it isn't evidence.** Symptom 2 now reads P0A05 "…CONTROL CIRCUIT/OPEN" against the description "Water pump locked", which is the same shape of mismatch the swap pointed at. Recorded here so round three does not start from it: the `name` column is the code's GENERIC SAE name and `description` is what Energica means by it ON THIS VEHICLE, and those two are allowed to diverge — that is the whole reason the table has both columns. More to the point the mismatch is symmetric and so decides nothing: a locked rotor is not a circuit fault at all, so whichever of the three codes Energica hands it will carry a name that does not fit. Under the 2026-08-15 swap the very same complaint applied to P0A07 "…CIRCUIT HIGH" = "locked". Only symptom 0 has a name that must fit, and it does.

### 2.3 (61,2), the added rows, and (4,5)

**(61,2) C0065, corrected 2026-08-15.** This was recorded as the dual code "P2158+P0500", named "VEHICLE SPEED SENSOR 'A' + VEHICLE SPEED SENSOR 'B'". That was a deliberate reading, not a slip — the PDF's cell does appear to name both sensors' codes for the both-failed case, and the interface carried a special note for it. The service-tool data gives one ordinary code instead, C0065, and that wins: it was the only "two codes at once" entry in either source, and a scan tool has one code slot per fault to receive it in, so the dual form could never have been transmitted as written. The name in the table is the service tool's title, since the PDF's name described the pair rather than C0065.

**(4,5) U0115, kept 2026-08-15 and confirmed 2026-08-16.** It was the one entry the 2021 service-tool data had no record of, kept on the argument that its silence there was a gap rather than evidence. The 2024 tool carries it, identical id and title. The gap was the older extract's, not the PDF's.

**Added 2026-08-15 from the service-tool data**, MIL unknown for all of them: (51,0) P1050, (52,0) P1051, (60,0) P1052, (54,13) C1018, (63,0) B1019, (63,1) B1020. Components 51, 52 and 60 are the battery's three statistics records, and their existence is why the component range reads 1…63 — the file used to call those numbers unused, on the strength of the PDF's gap alone, and the PDF's table stops at 62. The names are the service tool's own titles: the PDF's "DTC NAME" column is where the terser house names elsewhere in the table come from, and it has nothing to say here.

**Component 53** is the safety micro's own self-check: every symptom shares the one description "LOW LEVEL SAFETY ERROR" and the detail is in the DTC name. **Component 54** is the charge manager, the AC/DC charging state machine.

---

## 3. The Connectivity Hub's active list (type 25 / CAN `0x410`)

`src/diagnostics/decode.ts`. Pure — bytes in, values out — so it can be replayed from a capture.

The same 8-byte message reaches us over two transports and one decoder serves both (`src/ble/client.ts`, `src/can/hub-mirror.ts`):

- **Bluetooth** — the hub's notify characteristic, in reply to `04 11 25 FF`
- **CAN `0x410`** — the hub mirrors every one of its Bluetooth messages onto the VDB bus with byte 0 = type and byte 1 = sub-index. Confirmed in `obd-garage/captures/2026-08-02_bms_90s.log`: `1A 00`/`1A 01`/`1A FE` GPS, `02 xx` vehicle status, `04 xx` odometer, `00 FF` seed.

Layout, from `CommParser.java`'s `case DIAGNOSTICS:` branch — an unfinished stub that decodes two codes per message and then throws them away:

```
b0 = 25          message type
b1               sub-index: 0x00 first page, 0xFE last page, 0xFF whole list
b2..b4           first code:  b2 | b3<<8 | (b4 & 0x0F)<<16
b5..b7           second code: b5 | b6<<8 | (b7 & 0x0F)<<16
```

Each code is 20 bits and the top nibble of b4/b7 is masked off — the app never used it, so we log it (`flags`) rather than assume it is padding.

**✅ This is the currently-ACTIVE fault list, not stored history.** Every early reply came back EMPTY (zero codes) while OBD-II PID 0x01 reported 38 stored, and two readings fit: the hub serves only currently-active faults while PID 0x01 counts stored history, or the VCU refuses the list while the bike is parked. It is the first. Across `capture-20260804-193952` — 19:39 to 20:26, riding, then a 19 kW DC charge, then riding — **11 of 47** once-a-minute replies carried ONE code while PID 0x01 read 39 stored throughout. Stored history cannot flicker, and the empty replies came with the bike awake and moving, so emptiness is not a parked-state refusal either. Two non-empty replies out of eight in the 2026-08-02 boot captures say the same thing.

**✅ The low 16 bits are the component number** — `matchedBy: "component"`. Every non-zero field seen so far is raw `0x0002C`: component 44, which the table gives as P0A07 "Water pump open circuit fault". That is the one fault on this bike known to be real independently of anything on the bus. Reading the same bytes as a binary OBD-II DTC gives "P002C", which is nowhere in the table. One non-zero field decides that much.

**🟡 The top nibble being SYMPTOM is still untested.** It has been 0 in every reply ever received, so "symptom" and "padding" and "flags" all predict exactly what we have seen — P0A07 is symptom 0, so the match above would have worked under any of them. Nothing distinguishes them until a code with a non-zero top nibble arrives. `flags` keeps carrying that nibble separately for that reason. **Do not upgrade this marker on the strength of more symptom-0 codes.** Both readings are still computed and `raw` is still carried through, because one component/symptom pair is not a survey of the encoding; the OBD branch is an unexercised fallback rather than an open question.

**🟡 The code FLAPS.** In that capture it was present at 19:40, 19:48, 19:53, 19:56, 20:01, 20:04, 20:07, 20:11, 20:12, 20:17 and 20:25, and absent at every other poll — while riding and while charging alike, so it does not track either state. A permanently open circuit ought to report every time, which says something gates the test; the VCU only exercising the pump driver when it commands the pump on would fit, but that is a guess and only the flapping is observed. At one poll a minute the series is undersampled, so the gaps are a sampling artefact as much as anything — **do not read a period out of them**.

**The type-31 companion message.** The hub answers `04 11 25 FF` with TWO messages, ~10 ms apart: a type 31 that no version of the app knows about, then the type-25 list. Verified live 2026-08-02 on both transports — type 31 appears only in reply to this request (it is absent from the 90 s baseline capture) and always immediately before the list, twice in a row 60 s apart, payload `1F FF 01 03 01 02 04 00` both times. What its six bytes mean is unknown, so it is logged, not decoded.

**Paging has never actually been observed.** Every reply so far has been a single `0xFF` frame carrying one code or none, which is exactly what an active list on a bike with one active fault looks like. `DiagnosticListAssembler`'s paging is therefore inferred, not confirmed, and deliberately tolerant: the sub-index convention comes from the hub's other multi-part messages (odometer, GPS and vehicle status all end their sequence with `0xFE` and use `0xFF` when the whole message fits one frame), so any sub-index is accepted as a continuation page and only `0xFE`/`0xFF` end the list. `MAX_PAGES = 100` bounds a stuck hub: 39 codes is 20 pages, so it is ~5× the largest list we have reason to expect.

A zero code field is padding, not a code: a list with an odd number of codes leaves the second slot of the last page zeroed, and component 0 does not exist in the table. That also discards that slot's flags nibble; if the top nibble ever turns out to carry something on its own, the raw-frame dump in `src/diagnostics/record.ts` is what would show it.

---

## 4. OBD-II modes 03, 07 and 0A

`src/diagnostics/obd-dtc.ts` (pure decode) and `src/diagnostics/stored-codes.ts` (the side-effecting half).

**✅ Proven on the bike 2026-08-04.** Mode 03 returns, byte-identical across five captured transfers, an 80-byte payload starting `43 27`:

```
43 27 05 62 10 00 10 03 05 14 C1 11 C1 12 …
^^ ^^ ^^^^^ ^^^^^
|  |  |     second code, P1000
|  |  first code, P0562
|  count = 0x27 = 39, exactly what mode 01 PID 01 reports
mode 03 positive response
```

ISO 15765-4 §6.3: over CAN the byte after the service id is the number of codes. Confirmed here — the byte read `0x27` and exactly 39 code pairs followed. It is trusted only as a **cross-check, never as the loop bound**: the payload's own length decides how many codes are read, so a wrong count byte cannot walk us off the end. `00 00` is an empty slot, not code P0000 — a list with an odd number of codes pads its last frame out, and Energica's table has no P0000 either, so keeping it would put an unnameable phantom on the screen.

**⚠️ Modes 07 and 0A got NO REPLY AT ALL** — six attempts over 5 s windows on a quiet bus, silence rather than a negative response. That is **not** the same claim as "nothing is pending", and nothing in the decoder or on the dashboard may render it as one: an ECU that does not implement the service and an ECU suppressing the answer look identical from here. The transport reports silence as its own outcome (`src/can/obd-dtc.ts`) rather than as an empty list, and `stored-codes.ts` keeps `no-response` distinct all the way to the screen.

### The distinction `stored-codes.ts` exists to protect

"The bike says there are no codes" and "the bike said nothing" are different claims, and every state keeps them apart:

| state | means |
| --- | --- |
| `not-read` | never asked this run |
| `codes` | the bike answered; `codes` may legitimately be empty |
| `no-response` | asked; nothing came back. **Not** "no codes" |
| `not-asked` | never made it onto the bus — our socket, not the bike. `can0` drops whenever the service restarts, and attributing that to the bike would be exactly the kind of invented answer this module exists to avoid |
| `incomplete` | a transfer started every time and never finished. Distinct from silence |
| `refused` | the bike refused, by name |
| `unrecognised` | something answered, but not in a shape we recognise |

A count is recorded as a signal **only when the bike actually answered**. Recording 0 for a silent mode would put a confident "no pending codes" into the ride log and onto the dashboard — and `record()` refreshes a signal's timestamp on every call, so it would also look freshly confirmed forever. `readAt`/`ageMs` are only stamped when a question actually reached the bus: "Last read: 3 s ago" next to a list we failed to send would be the screen inventing a freshness it does not have.

**Only counts become signals.** 39 stored codes would mean 39 more keys in `liveState`, which `ws.ts` broadcasts whole every 5 seconds, for a list that changes about as often as the bike is serviced. The codes go out over `/stored-dtcs` instead, and the journal names every one of them when the list changes.

The journal signature is taken over the **codes**, not the summary line. `describeReadOutcome` says "39 stored code(s)" and nothing more, so a service that cleared one code and set another would leave the count at 39, match the previous signature, and never print the list — silencing the journal for exactly the change worth finding later. The counts are the only signals, so this journal is the only durable record of WHICH codes were stored.

**Nulls, not empty strings or `false`.** A code Energica's table does not list has no MIL column, and rendering that absence as "warning lamp: no" would be an answer we do not have. Mode 01 PID 02's freeze-frame code with `raw: 0` becomes a row with an **empty** `obdCode` rather than null and rather than "P0000": null is reserved for "PID 02 has not answered yet", which the dashboard has to be able to tell apart from the bike saying there is no freeze frame.

---

## 5. Freeze frames over KWP `0x17`

`src/diagnostics/freeze-frame.ts`. Pure — bytes in, values out, no socket and no clock — so the whole thing is exercised from a laptop against constructed payloads (`scripts/check-freeze-frame.ts`).

### 5.1 The request is proven, and so, now, is the response layout

**✅ The request is proven, twice over.**

- On the wire, 2026-08-08, passive capture of the Energica factory software (`obd-garage/DIAG_ADDRESSES.md` §9.1): service `0x17` was sent 29 times, to micro A8 and to no other, and every one of the 29 got a POSITIVE `57` reply. So the service exists on THIS bike, on that micro, and it answers.
- In Energica's own code, 2026-08-16: the service tool's shared library has `KWP2000::ReadDiagnosticTroubleCodeInformation` emitting service byte `0x17` with a two-byte identifier `[(code & 0xFF00) >> 8, code & 0xFF]`, and its caller `ReadDTCDetails` does TesterPresent → `10 81` → SetFullDLC → send, against `MotorbikeECU.VCUSafety`. No SecurityAccess anywhere in that path.

```
request   7C0:  A8 03 17 <componentHi> <componentLo> 00 00 00
response  7E0:  F1 ..  57 …
```

**✅ The response layout is now proven too, and this paragraph used to say the opposite.** It read: _"the census counted service bytes and discarded the payloads, so no `0x17` reply has ever been recorded."_ That was wrong. The census looked at `7C0`, which carries only requests; the replies were on `7E0` the whole time. All 29 are in `scripts/captured-freeze-frames.ts`, and §11.3.1 has what they settle. The reasoning below is kept because it was right — the 5-byte reading it argues for is the one the captures confirm — but read it as the argument that anticipated the answer, not as an open question.

**🟡 What IS known:** the service tool's `DTCode.GetInfoDetails` reads the status from index 3 of its buffer and starts the fields at index 4, walking the DTC's infokeys in order by datatype width (recovered from IL; the second owner's tool documents the same two constants). Both agree the status sits immediately before the fields. What neither settles is whether that buffer still has the `57` service byte on the front — so there are two readings, and they differ by ONE byte:

```
5-byte header  57 <count> <compHi> <compLo> <status> <fields…>   ← implemented
4-byte header  57         <compHi> <compLo> <status> <fields…>
```

The 5-byte reading is preferred because it makes `0x17` the same shape as its sibling `0x18` ReadDTCByStatus, which was seen on A8 in the same capture and answers `58 <count>` followed by 3-byte `<hi> <lo> <status>` records — the tool "unconditionally skips payload[0]" before walking those. A `0x17` reply that is that header with exactly one record, then the fields, puts status at index 3 and fields at index 4 of a service-byte-less buffer, which is precisely what `GetInfoDetails` does. **That is a coherent story, not a proof.**

**⚠️ So the decoder reports rather than assumes.** The length was expected to settle it, and it did not: `5 + fields + 1` and `6 + fields` are the same number, so the arithmetic cannot separate a 5-byte header with a trailer from a 6-byte header without one. What settled it was decoding all 29 against physical bounds (§11.3.1). `headerBytesThatFit` does that arithmetic on every decode and is the first thing to read on the first live reply:

| `headerBytesThatFit` | means |
| --- | --- |
| `[5]` | the implemented reading is right |
| `[4]` | 🚨 the header has no record-count byte; every field is shifted one byte and the numbers are wrong. Change `FREEZE_FRAME_HEADER_BYTES` |
| `[]` | **what every real reply actually returns.** Not an error: the payload is one byte longer than header-plus-fields, and that byte is `trailingHex`. See §11.3.1 |
| `[5, 4]` | impossible unless the shortlist is empty, since the two differ by one |

Empty when the shortlist is unknown, because then there is nothing to compare a length against. `trailingHex`, `truncated` and a `recordCount` that is not 1 are the other tells, and none of them is smoothed away. `trailingHex` was written down as needing to be empty if the layout above is right. On all 29 real replies it is NOT empty, and the layout is right anyway — the rule was a good instinct pointed at the wrong failure. It remains the most informative field here, just not in the direction predicted.

**A reply of exactly 4 bytes is the interesting case**: that is a valid empty-shortlist frame _under the 4-byte reading_, i.e. the one reply shape that would falsify the choice. It is reported rather than decoded — reading it would mean silently switching layouts mid-flight — but `rawHex` carries the bytes out, which is what makes it actionable instead of merely rejected.

**Every response variant carries `rawHex`**, not just the successful one. On the first read against a real bike the LIKELIEST outcome is `unrecognised`, and that is precisely the reply whose bytes would say what the layout actually is. A one-line reason with the payload thrown away would waste the only run that could settle it.

`payload` given to `decodeFreezeFrameResponse` starts with the response service byte — `57` positive, `7F` refusal — with every ISO-TP PCI byte already stripped. That is this repo's convention everywhere and it is ONE MORE than the index the second owner's tool counts from, which counts a payload with the service byte removed. Both readings put the fields in the same place; only the numbers in the two files' comments differ.

**Somebody else's refusal on the shared response id** is a thing that happens rather than a hypothetical: this repo's own parameter sweep asks `0x22` on `0x7C0` and is answered on `0x7E0`, so a `7F 22 31` can land in our reply window. Filing it as ours would report the freeze-frame read as refused when the micro never heard the question, and `service` sitting in the result does not help — the KIND already claims it answered us. Likewise `component-mismatch` is kept apart from `unrecognised` for the reason `src/vcu/param-codec.ts` keeps `identifier-mismatch` apart: the bytes decode perfectly, they are just the answer to another question.

**NRC `0x78` responsePending is a WAIT, not a refusal** — the micro is saying "ask again shortly". Whoever wires the transport must keep the reply window open after one instead of treating `refused` as terminal; `negativeResponseCode` is what to switch on.

**The target is not a parameter.** All 29 captured `0x17` requests went to A8, the service tool's own code targets `MotorbikeECU.VCUSafety`, and the freeze-frame flash bookkeeping fields (`FlashExt*`, infokeys 102…105) sit with the safety micro. Making the target callable would invite asking A9, which would at best answer nothing and at worst answer something else. The CAN ids are the ordinary VCU pair, `0x7C0` out and `0x7E0` back.

The request frame is zero-padded to a full 8-byte DLC because that is what the service tool sends (`OTHER_TOOL_AUDIT.md` §4.3, "full 8-byte DLC") — the length byte governs, but a short frame is a difference from the only known-good sender and this is not the place to introduce one.

**Why the request is not built through `src/vcu/param-codec.ts`.** That module's request union is the guarantee that nothing in this repo can write to the VCU's calibration EEPROM, and its comment says which services may never be added to it. Widening it for a service that reads a different thing entirely would spend that guarantee for no gain, and would put `0x17` one keystroke away from `0x14` and `0x31` in the same switch. The FRAMING is shared — same extended addressing, same target byte, same PCI, same request and response ids — and it is shared by being the same three lines, which is cheaper than the coupling. What cannot be duplicated so cheaply is the session, which is why nothing in this repo sends this frame yet.

A component number outside 1…63 is **thrown, not clamped**: it is a bug in the caller, and truncating it into range would ask about a different fault and answer confidently about the wrong one.

### 5.2 The status byte

**🟡 Inferred, 2026-08-16**, and one notch weaker than the layout above: this comes from the second owner's reading of the service tool's `DTCodeKey` UF\* properties (`obd-garage/OTHER_TOOL_AUDIT.md`), not from any capture.

```
bits 7:4  symptom — part of the code's identity, not a flag
bit  3    lamp on
bits 2:1  0 = not active · 1 = active · 2 = memory / freeze frame
bit  0    stored in memory
```

**⚠️ It is NOT the generic ISO 14229 DTCStatusMask**, which assigns those bits differently — so decoding one of these with a standard scan-tool status decoder gives confident nonsense.

`activity` is kept as the raw two-bit field rather than being flattened into booleans: the value 3 is not described by any source, and a boolean pair would have to invent a meaning for it.

The symptom is part of the code's identity, not a status flag: component 8 symptom 3 is U0113 and symptom 4 is U0114. The service tool's own `DTCode.FindDTCFrom` matches on `(status & 240) >> 4`.

### 5.3 Info keys and shortlists

`src/diagnostics/infokey-table.ts` — Energica's freeze-frame field dictionary, 120 "info keys". The manufacturer's service tool carries a resource it calls `DTCInfoKeys`: 120 records of `{id, name, unit, equation, datatype}`. Every fault in `fault-infokeys.ts` names a subset of these ids, IN ORDER, and that ordered subset IS the layout of that fault's freeze-frame payload. So the table is two things at once: the names and units that make a freeze frame readable, and — through `datatype` — the byte widths that make it decodable at all.

**Two independent copies were compared, 2026-08-16**, and they agree on all 120 rows for `name`, `equation` and `datatype`:

- the telemetry-scaling table extracted from the 2021 build, under the service tool's own folder in `<Energica_Manuals>/`
- the `DTCInfoKeys` JSON embedded in the service-tool executable (2024 build), by way of the second owner's `dtc_infokeys.py`

The tool did not change this table between its 1.2.0 and 1.3.0 builds.

**⚠️ The units come from the CSV, deliberately.** The 2024 executable's own copy has `EF BF BD` (U+FFFD REPLACEMENT CHARACTER) where the degree sign belongs, in all 11 temperature rows — Energica destroyed it in their own build, so any extraction from the binary inherits `<?>C`. The CSV is the only clean source for `°C` and is therefore authoritative for `unit`. That is the one column where the two sources differ, and it differs in exactly those 11 rows.

**⚠️ `id` is NOT an address.** It is the service tool's internal signal index and it has no meaning on the wire. The tempting reading `CommonIdentifier = 0x2000 | id` was tested against a real bank-2 dump and **refuted** (the service-tool file analysis in `obd-garage/`, §2.3: width agreement is 31.7 % against a 39.0 % chance baseline, and a 29-long run of 2-byte signals cannot be placed anywhere in bank 2 at any offset). The 2024 service-tool analysis in `obd-garage/`, §7.2, then found the reason in Energica's own source: `(bank << 12) | id` is real but applies to a DIFFERENT table, the tool's `LiveData`, which carries its own per-signal `bank`. This one carries none. So these ids are an index INTO A FREEZE-FRAME PAYLOAD. **Do not pass one to `src/vcu/param-codec.ts`.**

**What is not known:** nothing in the infokey table has been read off this bike. The table is the manufacturer's, the widths are the manufacturer's, and the claim that a payload is these fields concatenated in infokey order is the service tool's own decoder behaviour as read out of `DTCode.GetInfoDetails`.

`src/diagnostics/fault-infokeys.ts` — one ordered shortlist per fault. **155 faults, 944 references, every one resolving into 1…120 with none dangling.** Extracted 2026-08-16 from the `DTCodes` JSON embedded in the service-tool executable (2024 build, via the second owner's `dtc_codes.py`); the 2021 build carried the same table with 153 faults and 931 references, and the newer one only ADDS (4,5) U0115 and (35,2) B1021 — no removals and no changes to a shared list. So the two builds are one source carried forward, not two agreeing sources.

**⚠️ The order is the wire layout, not a display preference.** A freeze-frame payload is these fields concatenated in exactly this order, each occupying its datatype's width. Sorting a list, de-duplicating it, or filtering out a field whose name means nothing to us would silently shift every field after it and decode the rest of the frame as garbage that still looks like numbers. Treat each array as a struct definition.

**⚠️ `serviceToolObdCode` is a cross-check, not an authority.** It is what the manufacturer's service tool calls each (component, symptom) pair, carried so a change in either source shows up as a diff rather than as nothing. Where it disagrees with `dtc-table.ts`, **the DTC table wins**: that table is reconciled against the type-approval PDF and against this bike's own mode-03 reply, and this one is a single vendor build. There are exactly two disagreements today, both the water pump — the tool swaps (44,0) and (44,2) relative to the PDF — and `scripts/check-freeze-frame.ts` asserts that the set is still exactly those two, so a third one cannot appear quietly.

**One fault, (60,0) `P1052` BATTERY STATISTICS INFO3, has an EMPTY shortlist.** That is Energica's data, not a gap in the extraction, and it decodes to a freeze frame with no fields — which is a real answer and not an error. `shortlistKnown: false` (no shortlist for the returned pair) and an empty frame must not look the same on screen.

Fields are read **big-endian**, like every other multi-byte value on this diagnostic channel — and unlike the broadcast frames, which are little-endian (`src/can/decode.ts`). Mixing those up is a silent factor-of-256 error. `readFields` **stops** at the first field that does not fit rather than skipping it: skipping would decode every LATER field from the wrong offset, and those would come out as numbers, not as errors.

The largest freeze frame Energica's own table can describe is 25 bytes — a 5-byte header plus (51,0) P1050's twelve fields, which is `MAX_FREEZE_FRAME_FIELD_BYTES` in `fault-infokeys.ts` and is asserted at 20 by `scripts/check-freeze-frame.ts`.

### 5.4 The other freeze-frame route, and what must never be implemented

The service tool has a second route: `KWP2000Moto.ReadFreezeFrame` dumps the whole stored freeze-frame LOG as a stream, via `0x35` RequestUpload with identifier byte `0x12` (`RoutinesID.ReadFreezeFrame`) and operand `FF`×10, then N × `0x36` TransferData, then `0x37`. That is what the 1198-frame transfer in `obd-garage/DIAG_ADDRESSES.md` §9.6 actually was: `A8 10 0C 35 12 FF FF FF` is RequestUpload with identifier `0x12` and a 10-byte operand, and `1 + 1 + 10` is the `0x0C` the First Frame declares. **⚠️ That file (local-only, not in this repo) calls it "the software dumping A8's memory image", which is WRONG and should be corrected there.** Each `0x36` reply carries one record: a 4-byte big-endian timestamp (seconds since 2000-01-01), then `<compHi> <compLo> <status>`, then the same info-key field block. It is a read, and it would give timestamps `0x17` does not — but it is 1200 frames of upload-family services, and `0x17` answers the question this app is asking about one code at a time.

**⚠️ Read-only, and structurally so.** `FreezeFrameRequest` is a closed union with ONE member, and the encoder throws on anything else. `0x17` is a read; the things next to it in the tool are not, and none of them may ever be expressible here:

- **`31 FE` StartRoutine (`RoutinesID.VCUErase`)** with the 8-byte operand `01 00 00 00 01 FF FF FF`, then `33 FE` RequestRoutineResults polled until it reports 0 — the tool's freeze-frame ERASE, and it takes SecurityAccess first (`27 01` on A8) where the read takes none. It exists, it is written down so nobody has to rediscover it, and it is **deliberately not implemented**. It is a flash erase of the bike's own record of why it faulted: the least reversible thing in this corner of the protocol, and worth nothing to a telemetry app.
- **`14 FF FF` ClearDiagnosticInformation** — clears the stored codes. Also not ours. Note the factory software sends both, erase then clear, in that order.
- **`0x35`/`0x36`/`0x37` upload** — the factory tool's 7-minute bulk read-out of A8. A read, but a 1200-frame one, and not this.

---

## 6. Extended-addressed ISO-TP, and the flow-control frame

`src/diagnostics/extended-iso-tp.ts` — the receive half of ISO-TP under EXTENDED addressing, the framing the VCU micros use, and the one thing standing between a `0x17` reply and a decoded freeze frame. Pure: frames in, payload out.

**⚠️ Why this is not `src/can/iso-tp.ts`.** That module assumes NORMAL addressing: byte 0 is the PCI and the payload starts at byte 1. The VCU's diagnostic channel puts the ADDRESS in byte 0 — `0xA8`/`0xA9` outbound, `0xF1` (the tester) inbound — and everything shifts one along. Every length therefore differs by one:

|                           | normal (`src/can/iso-tp.ts`) | extended (here) |
| ------------------------- | ---------------------------- | --------------- |
| Single Frame payload      | up to 7                      | up to 6         |
| First Frame payload       | 6                            | 5               |
| Consecutive Frame payload | 7                            | 6               |

Feeding an extended-addressed frame to the normal reassembler **does not throw**. It reads the address byte as a PCI — `0xF1` has top nibble `0xF`, so a reply would be silently `ignored` as an unknown PCI and the transfer would simply never complete. `src/vcu/param-codec.ts`'s header records the same incompatibility from the other direction. Two small correct readers beat one parameterised one whose caller has to remember which mode it is in.

**⚠️ The flow-control frame, and who sends it.** Since 2026-08-16 somebody does: `src/vcu/multiframe-transfer.ts` drives this class, answers a First Frame with `<target> 30 FF 00` synchronously from its frame handler, and takes a lease from `src/vcu/bus-lease.ts` before it starts. The reason the split exists is still worth recording, and the property it worries about was preserved rather than spent: the flow control is addressed to the target the CALLER named, never to an address read off the bus.

A multi-frame reply does not arrive unless the tester answers the First Frame with `<target> 30 FF 00`. **Verified on this bike for the OBD channel on 2026-08-04: with no flow control, 0 of 8 mode-03 requests produced a single Consecutive Frame.** So reading a freeze frame means TRANSMITTING between the request and the rest of the reply — and every freeze frame is multi-frame, because the header alone is 5 bytes and a single frame holds 6.

`src/vcu/kwp-client.ts`, which owns the only KWP session machinery in this repo, deliberately never sends one: "no flow-control frame is ever sent: this module derives no transmit address from anything the bus said". Whoever teaches a transport to send one: **take a lease from `src/vcu/bus-lease.ts` first.** The micros answer on ONE CAN id with no request/response tag, so a freeze-frame reply and a parameter read in flight together are resolved by whichever frame lands first — and a multi-frame read holds the bus for several frames rather than one.

**`MAX_PAYLOAD_BYTES = 64` is deliberately well above the 25 bytes the largest describable freeze frame needs**, rather than derived from it, so the two are tied together by an assertion in `scripts/check-freeze-frame.ts` rather than by an import. That slack is the whole point: if the layout inferred in §5.1 is wrong, the reply will be some other length, and a cap set at 25 would throw away the one piece of evidence that would show it. The cap is there only to bound what a stuck responder can make us hold. `maxFramesFor()` derives the frame-count guard from whatever cap an instance was given rather than from the default — otherwise a caller that raised the byte cap would hit a frame cap sized for the old one and see a long reply abandoned as "too many frames", which is a true statement about the wrong number.

---

## 7. Service mode over HTTP

### 7.1 `/vcu-read` — the read surface

`GET` how the current or last sweep is going and whether the bike may be serviced; `POST` start one (refused, not queued, if one is already running); `DELETE` ask a running one to stop, keeping what it has.

**⚠️ This is the one endpoint in this repo that causes traffic on the bike's bus**, and since the sweep moved in-process (`src/vcu/sweep.ts`) it is also the only path from an HTTP request to a CAN frame that exists at all. What stands between the two is `src/vcu/service-gate.ts`: a POST is refused unless the bike is PROVED stationary and out of drive, and a sweep already running is put out the moment that stops being true. The gate is on the wire so the page can say why the button is unavailable rather than leaving it to fail.

**⚠️ Still read-only.** A sweep can only ask `10 81`, `3E` and `22`: those three are the whole of `param-codec.ts`'s request union, and its encoder throws on anything else on the way out. There is no parameter on this endpoint that selects a service, an identifier or a value — POST takes no body at all — so there is nothing here for a widened union to leak through either.

**Why POST returns immediately.** A sweep is ~277 reads at a 300 ms reply window; on a bike whose link drops as routine it can take a minute or stall entirely. Holding the response open would freeze the phone's request, time out on garage wifi, and leave the dashboard unable to say what had been read so far. So POST starts it and returns, and GET is how the page follows along — which also means closing the page, or walking out of wifi range, does not stop the sweep. Riding away does, but that is the gate rather than the HTTP layer.

The gate lives in the runner rather than in the endpoint, so that the check a POST makes and the check the sweep makes before every frame are the same code reading the same signals. An endpoint that decided for itself would be a second opinion to keep in step. `409` (not `500`) for "the bike is moving" and "one is already running" — both are the endpoint working correctly. `403` (not `404`) for `SERVICE_MODE_ENABLED=0` — the endpoint exists and is answering, it is the action that is switched off, and the page says which switch. DELETE is always allowed, even switched off: stopping something is never the dangerous direction, and a sweep could still be running from before the flag was set.

`Cache-Control: no-store` on the response: a cached copy would freeze the progress count on screen while the sweep carried on — and, far worse, show a stale "safe to service" for a bike that has since been ridden off.

The export summary counts **exportable** rows rather than all of them: a snapshot of 277 rows in which the bike answered none would otherwise offer a download of a header line, described as 277 parameters.

### 7.2 Why starting a read needs a header

A bare `POST` with no body and no custom headers is a **CORS-simple** request: any page open in the phone's browser while it is on the bike's hotspot can fire one at this endpoint (`fetch(url, {method: "POST", mode: "no-cors"})`, or a plain cross-origin `<form method=post>`) without a preflight. It never sees the response — but here the side effect IS the point, and it is the only side effect in this repo that reaches the bus. The two-tap arming on the page guards against a thumb, not against that.

Requiring a header a simple request cannot set makes the browser send a preflight first; nothing answers OPTIONS, so the browser blocks the request and the sweep never starts. Same-origin fetches from our own page need no preflight, so the dashboard is unaffected. `curl` can still start a read, which is correct — anything with a shell on that network already has the bus.

The header's **value is not a secret**; being unsettable cross-origin is the whole property. The gate does not replace this and this does not replace the gate: one answers "did the owner ask for this", the other "can the motorcycle move". A parked bike is exactly when a drive-by request would succeed, so the cheap check still earns its keep. DELETE needs no such guard: a non-simple method already forces a preflight.

`/vcu-probe` carries the same requirement for the same reason, and a query string does not change that — `Content-Type` is what a simple request is judged on, and it sends none. It is a POST rather than a GET because GET must be safe: a browser, a prefetcher, a link preview or a `curl` of the URL bar must not be able to open a diagnostic session. And it is behind the same safety gate: a probe is one read, not 277, but "short" is not the property the gate is about — the rule is that nothing transmits while the motorcycle can move, and one frame breaks it exactly as well as a burst does.

`/vcu-probe` returns the raw bytes and BOTH the unsigned and the signed reading of them, always. Outside bank 1 nothing there knows a width or a sign, so naming one of them "the value" would be inventing the half of the answer that was not read off the bus.

### 7.3 `/vcu-write` — the write surface, and its confirmations

**⚠️ The second endpoint that causes bus traffic, and the FIRST that changes anything.** `/vcu-read` and `/vcu-probe` are read-only by construction — `param-codec.ts`'s request union has three members and nowhere to put a value — and that has not changed. This is a separate door with separate locks, closed by default.

**Why a different header VALUE from `/vcu-read`.** Neither value is a secret, but making them DIFFERENT means a caller that only knows about reads cannot reach a write by accident, including a script of the owner's own written before this endpoint existed. It costs one string and closes a whole class of "I pointed my read tool at the wrong URL".

**Why the irreversible actions want a `confirm` parameter as well.** The UI does the real confirming: it shows old → new and needs two taps (`public/views/vcu-write.js`). But the UI is not the only thing that can reach this endpoint — `curl` can, which is correct, and so can a script someone wrote in a hurry. So the two actions that cannot be undone, and the one whose whole point is that a human agreed to a specific time, additionally require the caller to say what it thinks it is doing:

```
set-service-point  confirm=set-service-point
clear-dtcs         confirm=clear-dtcs
sync-clock         confirm=<the UTC minute the caller displayed, ISO>
```

The clock one is not ceremony. It is the server-side half of "Is it \<date and time\>?": the caller has to echo back the minute it showed the owner, and the Pi refuses if that is no longer the minute it is in. A page left open since this morning therefore cannot sync this morning's time. A mismatch is not a formatting quibble — it means the time the owner agreed to has passed, or the Pi's clock moved between the page rendering and the button being pressed. Minute resolution, because a second-resolution echo could never match.

`GET` is deliberately NOT behind the header: reading what may be written, what the gate says and what was done last week is how the page explains why a button is unavailable, and none of it goes near the bike.

`400` (not `409`) when the request itself is wrong and re-sending it unchanged will always be wrong; `409` is for a busy bus or a bike that may not be serviced. **`200` even when the bike refused**, and even for a read-back mismatch: those are ANSWERS — the micro is there and declined, or it accepted and the cell did not take — and turning them into HTTP errors would collapse the distinction the codec works hardest to keep. `result.succeeded` is where the page reads the verdict from.

### 7.4 The `-0x50` sign bug

`parseNumber` accepts `0x1F` and `31` both, because a value copied out of a hex dump is the common case.

**⚠️ The `-` is moved to the FRONT of the digits and handed to `parseInt`, rather than stripped and re-applied as a multiplier.** The multiplier version applied the sign twice — `parseInt("-50", 16)` is already −80, and multiplying by −1 turned it back into **+80**. So `value=-0x50` parsed as 80: a negative that every allowlist entry would have refused with a reason instead became a positive, in-range value on its way to a calibration EEPROM. Caught in review, never shipped.

### 7.5 The read-only endpoints

- **`/vcu-params`** — serves the last snapshot from disk. "No snapshot on this Pi" is deliberately NOT an empty list: "nobody has read the parameters here" and "this bike has no parameters" are different claims, and only one of them is true. `tableType` is derived server-side because deciding whether a `TABLE_TYPE` reading is one this software carries means holding all 28 of Energica's parameter tables (`src/vcu/table-catalog.ts`), and the page has no way to import a TypeScript module at runtime. Re-implementing the comparison in `public/lib/params-page.js` would put a second copy of "which table are we" in a file that cannot be checked against the first. The snapshot's rows are served **re-named** from that same reading: a stored snapshot's names are a DERIVED view, and deriving them from the bike's own answer is what keeps a file written under one table from being read under another. `unreadable` is never silently rendered as "never read".
- **`/vcu-backup.csv`** — the last parameter snapshot as `vcu_backup.csv`, the file another owner's `energica_tool.py` writes and reads. Byte-compatible on purpose: the format is that tool's, not ours, so a set of values can be sent to someone with a different bike and opened in the tool they already have. ⚠️ **It never touches the bus** — downloading cannot make the bike answer anything. ⚠️ But **what the receiving tool can do with this file is a WRITE**: `energica_tool.py`'s "Restore backup…" reads exactly this shape and puts every row back into an ECU over `3B` WriteDataByLocalIdentifier. Nothing on this side can do that, but the file is one input to something that can, on someone else's bike, with different values. That is a reason the download is a deliberate act in service mode rather than a link on the riding screens, and a reason the filename says backup. `404` with the fix in it rather than an empty CSV, because a file containing only a header would look like a bike whose every parameter is missing and would be indistinguishable from a real export of a bike that answered nothing.
- **`/fault-infokeys`** — Energica's "what to look at for this fault" lists, so the Faults tab can say what a code means you should go and measure. An endpoint rather than a JS copy in `public/` for the reason `src/http/dtc-table.ts` gives: the dashboard has no build step and cannot import the TypeScript tables, and a hand-maintained duplicate of 944 references would drift silently in a direction nobody would notice. **Why the two halves are sent separately:** the obvious shape — every fault carrying its fields inline — repeats the same handful of field definitions 944 times and comes to roughly **80 kB**. Sending the 120-entry dictionary once and the shortlists as id arrays is about **16 kB**, and the join is one array lookup on the client. That matters here: this is served to a phone over a hotspot in a garage with no reception. It never touches the bus and it cannot: both tables are static data compiled into the process. Nothing on this endpoint tells you what the bike actually recorded.
- **`/waypoint`** — see §9.5.
- **`/dl`** — see §9.4.

---

## 8. GPS time: the 2060 incident and the clock gate

`src/gps/clock-gate.ts` decides; `src/gps/clock.ts` does the I/O; `src/gps/decode.ts` is the pure decoder. The gate is pure — every clock it reasons about is passed in — which is what lets `scripts/check-gps-clock.ts` replay real sequences out of `rides.db` through the very code the Pi runs.

### 8.1 The failure this exists to stop

Measured in `rides.db`, 2026-08-02 … 08-15. One corrupt frame used to cost five minutes of corrupt timestamps. `#decodeUtc` accepted any two-digit year from 24 to 99, so a frame whose year field read 60 decoded to 2060; `syncSystemClockFromGps` stepped the system clock 34 years forward; and `MIN_SECONDS_BETWEEN_STEPS` — there to stop the clock thrashing — then blocked the correction that would have undone it. **The guard against thrashing was also the guard against recovery.**

Four such frames are in the log. Two of them landed while the service could set the time, and each produced a burst of rows stamped 2060: **2 192 rows over 299.9 s** (exactly the 300 s cooldown) and **47 580 rows over 501.5 s**. **49 772 rows in total — 0.8 % of the database**, and enough to make a ride's own analysis wrong rather than merely ugly.

The regression would be silent. Nothing crashes, nothing logs an error, and the dashboard looks fine; you find out weeks later when a ride's own analysis is wrong.

### 8.2 Why there is no year ceiling

A hard window — "2024 to 2035", say — is a fix with an expiry date, and the bike will outlive it. Every rule in the gate is either a floor, which stays true forever, or a comparison against a clock that advances on its own:

- **`GPS_UTC_FLOOR_EPOCH_S`** (`decode.ts`) is a FLOOR. A satellite fix from before this bike had telemetry on it cannot be real, and that stays true in 2035 and in 2060. It only ever becomes more conservative as it ages, never wrong. What it actually catches is the GPS week-number rollover, which lands a receiver in 1980 or 1999, and a zeroed date field, which reads as 2000. All three are decades below it.
- **Corroboration** compares GPS readings with each other and with the MONOTONIC clock. It asserts nothing but "time advances at one second per second", which names no year and cannot expire. This is what actually rejects the 2060 frames.
- **The known-good anchor** is a satellite time we already accepted, projected forward by monotonic elapsed time. It advances by itself, every second the bike runs.

A frame claiming 2060 is rejected because no other frame agrees with it — not because 2060 is a year we decided to disbelieve.

**⚠️ The floor is set to the start of 2026, NOT to the day it was written**, and the difference matters. The decoder also runs over history: `scripts/decrypt-log.ts` rebuilds segments sealed weeks ago and `scripts/replay-capture.ts` replays old candumps, and a floor at "today" would silently drop `gps_epoch_s` out of every one of them. It has to sit below the oldest data the repo can be handed, which is April 2026 (the legacy coolant history in `public/lib/bounds.js`); the first ride in `rides.db` is 2026-08-02. `scripts/check-gps-clock.ts` replays 2026-08 sequences and fails if the floor is ever raised past them.

### 8.3 Why a minimum satellite count is not the discriminator

The obvious guard — demand more satellites before trusting a big step — does not work here, and the log says so plainly. `gps_satellites` at the four corrupt frames read **10, 9, and (no sample within 15 s) twice**, against a population where **41 % of all readings are BELOW 8**. Every threshold that would have rejected a corrupt frame would have rejected the majority of good ones with it. The corruption is a single mangled frame in an otherwise healthy stream, not a weak fix.

The floor of 4 satellites stays where it is, in `#decodeUtc` — a 3-satellite fix has no altitude solution and a poor time solution — but it is a sanity check on the receiver, not a defence against this. Corroboration is the defence.

Nor is an implausible satellite count a usable tell: the log has readings of 18, 28 and 30 satellites (7 rows), none of them at a corrupt-year frame. **The hub corrupts single frames across every sub-field independently; no one field predicts another.**

### 8.4 The gate's constants, and what each was measured against

| constant | value | why |
| --- | --- | --- |
| `DRIFT_THRESHOLD_SECONDS` | 60 | below a minute the step is not worth the disruption a jumping wall clock causes everything that stamps a row with it |
| `REQUIRED_CONSISTENT_READINGS` | 5 | 1.4–5 s of readings at the observed rate; set against a Pi that has just booted with a nonsense date, that is nothing |
| `CONSISTENCY_TOLERANCE_SECONDS` | 3 | see below |
| `READING_WINDOW_MAX_AGE_MS` | 30 000 | so corroboration cannot be assembled out of five readings taken minutes apart; ~6× the room a full window needs |
| `KNOWN_GOOD_MAX_AGE_MS` | 600 000 | see below |
| `READINGS_TO_DISPLACE_CONTESTED_ANCHOR` | 30 | see below |

**`CONSISTENCY_TOLERANCE_SECONDS`** — how far two readings may disagree about how much time passed between them. Measured over the **90 622** consecutive `gps_epoch_s` pairs in `rides.db` that have no clock step between them: the median disagreement is **0.101 s** and the 90th percentile **0.445 s**. The long tail is the two transports interleaving — CAN and BLE deliver the same fix a few milliseconds apart and their seconds field can differ by one, which shows up as a **2.1 s** disagreement. So the tolerance has to clear 2.1 s. 3 s clears it with room to spare and is still eight orders of magnitude below what a corrupt frame produces: the four in the log disagree with their neighbours by **1 057 967 999.9 s, 1 073 001 599.7 s, 1 058 745 599.5 s and 1 057 276 799.5 s**. There is no value between "transport jitter" and "34 years" to be careful about.

**⚠️ Read that margin carefully:** the percentiles are PER PAIR, but the rule is the worst of the whole window against its newest reading. One reading over the line kills the window, so with an observed worst pair of 2.1 s the real headroom is **0.9 s**, not the 2.5 s the median and p90 suggest. If the transports ever drift further apart this is the constant that gives, and it gives by refusing to sync at all — which is why `inconsistent-readings` is warned about rather than logged.

**`KNOWN_GOOD_MAX_AGE_MS`** — how long a known-good satellite time stays authoritative without being reconfirmed. This is the line between "we have never had a good time this session" and "we had one and something now disagrees with it", which need different rules — a cold boot SHOULD step by hours, an established session should not. It has to expire, or a session that once had a good time could never re-establish one and would be locked out of correcting itself forever. Ten minutes of GPS silence (a garage, a tunnel, a hub that stopped talking) is long enough that we would rather re-derive the time from scratch than keep projecting a stale anchor forward.

**⚠️ Deliberately NOT equal to `MIN_SECONDS_BETWEEN_STEPS`.** They were both 300 by accident, which meant the anchor's life and the anti-thrash cooldown expired in lockstep and the cooldown damped nothing at exactly the period the expiry can generate. Keeping this at least twice the cooldown means a flip always costs a full cooldown as well as a full anchor life.

**`READINGS_TO_DISPLACE_CONTESTED_ANCHOR`** — how many consecutive agreeing readings it takes to displace an anchor that expired while being CONTRADICTED, rather than while starved of readings. The two are not the same event and must not cost the same. An anchor that went stale because the hub stopped talking tells us nothing — cold-boot rules are right. An anchor that went stale because something spent ten minutes disagreeing with it is a fight between two sources, and letting whichever one happens to be present at the moment of expiry win by default makes the clock an oscillator: adopt A, refuse B for an anchor life, adopt B, refuse A for an anchor life, forever. So the contradicting time has to work harder, not less hard. 30 readings is **8–30 s** of unbroken agreement at the measured rates — nothing to a genuinely new correct time, and out of reach of the sporadic single-frame corruption that is the only kind this bike has ever produced.

### 8.5 `systemClockTrust()` — and why it has no staleness bound

The Pi has no RTC. On a boot with no network its clock starts wherever the filesystem left it. Rows are logged regardless — a timestamp that is merely wrong is still recoverable from `gps_epoch_s`, which is logged raw beside it — but a caller creating a _record whose whole point is when and where_ needs to know, and `src/http/waypoint.ts` refuses to save one unless this says `satellite-backed`.

**Deliberately not derived from the `gps_epoch_s` signal**, which would be the obvious way and is wrong: that signal is recorded RAW, refused frames included, so a single corrupt frame would make a perfectly good clock look 34 years out and refuse waypoints for as long as it sat in `liveState`. The gate's verdict is the corroborated view, and corroboration is the whole defence.

**⚠️ There is deliberately NO staleness bound here, and the first version had one** — `KNOWN_GOOD_MAX_AGE_MS`, which looked like the obvious constant to reuse. It is not, and reviewing #74 is where that came out. That bound is about an ANCHOR used to validate the next satellite reading, where expiry means "re-derive from scratch" and costs a few seconds. Here expiry would mean "refuse to record anything", and nothing re-derives it until a fresh reading turns up — which is a different thing entirely once you notice that `decode.ts` withholds `gps_epoch_s` below 4 satellites while still emitting `gps_lat`/`gps_lon` for any fix at all. A bike parked under a partial sky view with a 3-satellite fix has a fresh position, a clock that was stepped from satellite time an hour ago and is still right to the second, and no time frames at all — and would have been told its clock was unsynced, at exactly the moment (parked somewhere worth remembering) the feature exists for.

So what expires it is a CONTRADICTION, not silence. Once `date` has returned, the monotonic clock has been running ever since and nothing has disagreed, the wall clock is still satellite-backed however long the sky has been quiet. A reboot clears it by construction: this is process state, and the process is what has no RTC.

`GPS_TIME_SYNC=0` says something else owns the clock — NTP on a bench, or a replay on a laptop. Claiming to know better than the operator who set that would refuse every waypoint on a machine whose clock is fine, so it reports `satellite-backed`.

### 8.6 The position decoder's freshness rule

`src/gps/decode.ts` emits a fix only when **both coordinate sub-frames have arrived within THIS cycle**, not merely at some point in the past.

**⚠️ The have-flags used to latch for the life of the stream**, which made a fix out of whatever the decoder happened to be holding. A latitude sub-frame that stopped arriving was re-emitted as current indefinitely, paired with a fresh longitude — a position that was never anywhere. The `#fix` check cannot catch it, because `#fix` is set by the LONGITUDE sub-frame (`0x01`) and so stays healthy exactly while the latitude is the dead half.

`rides.db` has **84 consecutive-sample transitions implying over 250 km/h** at more than 3× the bike's own speedometer, including single-sample jumps of **21 km on latitude alone and 6 km on longitude alone**, each going straight back where it came from on the next sample. That is one axis current and one axis not.

Expressed in sub-frames rather than milliseconds on purpose: the hub sends `00`, `01` and `FE` in a strict 1:1:1 cycle (measured 2026-08-02: 72/72/72 in 40 s with a BLE session up, 58/58/58 in 30 s with none), so "since the last fix we emitted" IS the hub's own idea of one fix. A wall-clock window would be an arbitrary translation of that — and this decoder is pure, so it has no clock to read anyway.

Two more guards on the same line: the stream can carry the time sub-frame _before_ either coordinate sub-frame on a fresh connection (seen live over BLE), which would otherwise log a bogus 0; and, like the app, we suppress the null island it emits before it has a fix.

**`#decodeUtc` returns a value the gate will refuse rather than dropping it.** `gps_epoch_s` is logged raw against every row's own timestamp, so a frame that lies about the year stays visible in the database instead of vanishing. All four corrupt frames behind the 2060 bursts were found that way.

`FRAME_SIZE = 8` is declared in the decoder rather than in either transport because both need it — `ble/protocol.ts` re-slices the notify characteristic to it, since BlueZ does not preserve ATT notification boundaries.

---

## 9. The sealed ride log

### 9.1 Design

`src/storage/encrypted-log.ts`. Write-only: the Pi holds **only a public key**, so it can append history it can never read back. A stolen bike yields an SD card full of ciphertext — no route history, no home address, no key-fob ID. Decryption needs the private key, which lives on the laptop and nowhere else.

Hybrid encryption, because public-key crypto cannot encrypt bulk data directly: each segment gets a fresh ephemeral X25519 keypair, ECDH against the recipient public key, HKDF-SHA256 to an AES-256-GCM key. The ephemeral private key is discarded immediately, so each segment is independently sealed — compromising the Pi cannot retroactively decrypt anything already written.

Segments are self-framing and appended whole, so a power cut mid-write costs at most the current buffer and leaves every earlier segment readable. Each one also carries the unit/group/source of the signals it contains, so a segment stays interpretable on its own even if the registry is later renamed — this is the only copy of the data, so it must not depend on a matching checkout.

### 9.2 `seq`, `session`, and row ordering no clock can corrupt

`ts` had been doing two jobs — saying WHEN a row happened and saying what order the rows came in — and it is only good at the first. This process steps its own wall clock from GPS, so a step reorders every row around it: in the 2060 incident the bad rows were stamped 34 years AHEAD, which means sorting by `ts` scatters 49 772 rows to the end of the log and interleaves nothing correctly.

Repairing that by forcing timestamps to increase would be **worse, not better**. It recovers ordering by destroying time: every good row after a forward step would be dragged up to 2060 and pinned there, turning a five-minute wound into a permanent one. So the two jobs get two fields instead. `seq` counts rows and is never derived from a clock, so it orders correctly however badly the clock behaves — including retroactively, for rows already written with a wrong `ts`. Together with the raw `gps_epoch_s` logged alongside, a reader can reconstruct both order and true time.

`seq` is per process, starting at 0, which is why the segment header carries `session`: across a restart the counter restarts too, and the session id is what keeps two runs' sequences from being mistaken for one run's. The session id is deliberately **not a timestamp** — a boot with a nonsense clock is the normal case on this hardware, and two boots could otherwise claim the same identity.

### 9.3 The v2 body format, and why nothing needs migrating

Body is a JSON header line naming the signals in this segment, then one `[ts, key, value, seq]` array per line. gzip collapses the repeated keys to almost nothing, and the format stays trivially readable once decrypted — which matters for data that cannot be re-collected.

v1 lines were `[ts, key, value]` and the header was `{ v: 1, signals }`. The fourth element and the header's `session` were added 2026-08-16. Both are backward AND forward compatible by construction, so old and new segments can sit in the same directory and be read by either reader:

- a v1 reader destructures `const [ts, key, value] = parsed`, which ignores a fourth element outright — `scripts/decrypt-log.ts` has always done exactly that — and it never looked at `v` either;
- a v2 reader gets `undefined` for `seq` on a v1 line and stores NULL, which is the honest answer: those rows were written before anything counted them.

The version number is bumped anyway. Nothing reads it today, but a segment that says what shape it is costs one integer and this is the only copy of the data.

### 9.4 Files are not segments, and what `/dl` does and does not hide

**⚠️ `measureLog()` counts FILES, not segments.** It used to return the same number under the name `segments`, and the dashboard printed it as "N sealed segments". It is not that, and the gap is not small: a segment is sealed on a timer (every 30 s by default) and **appended** to `rides-<YYYY-MM-DD>.celog`, so one file is one calendar day's worth of segments — hundreds or thousands of them. `scripts/decrypt-log.ts` is what counts the real thing, by walking the framing inside each file.

That also explains how the caption managed to look broken without ever being stale: within a day the file count CANNOT change however long the bike runs, so it sat on one number while the log grew underneath it. The reported number was always the true file count — every entry is stat'd, nothing is capped or sliced — it was the noun that was wrong. The two consequences the owner saw: the number was smaller than the truth by three or four orders of magnitude, and it could not move until midnight, however long the bike rode. A count wired to a constant and a count wired to the calendar look identical from a garage.

Counting segments instead would mean walking every file's framing (a 56-byte header, then a skip of the length it declares) on each `/status` poll, for a number the download button has no use for. So the cheap answer stays, and the name now says which answer it is.

**`/dl` — the transfer, not the bytes.** Short path because it gets typed on a phone. No snapshot dance is needed (unlike the old `/db`, which had to work around SQLite's WAL to avoid serving a torn file): segments are immutable once appended, and each one is self-framing with its own magic header, so the files can simply be concatenated in order and fed straight to `scripts/decrypt-log.ts`.

The payload is ciphertext: without the laptop's private key it is noise, which is what makes serving it over garage wifi acceptable. **That is a property of the bytes, though, not of the transfer**, and the difference is worth keeping straight — the dashboard caption above this button used to blur the two and claimed the log was "safe over any network". `/dl` authenticates nobody, so anyone on the network can pull the whole log and keep the ciphertext against the day the key leaks; and segments can be dropped or truncated in flight by someone holding no key at all, because each is sealed on its own and nothing binds them into a sequence. README, "What this does and doesn't hide", has the full list.

### 9.5 `/waypoint`

`GET /waypoint` — stamp "I am here, now" into the ride log. Built for a Siri Shortcut: one "Get Contents of URL" action, GET so there is no body to configure, and a short plain-text reply that Siri reads back out loud — which is the only feedback you get with the phone in a pocket and gloves on.

It has two more callers now, both on the dashboard and both wanting the same judgement: the menu button, and a long press of the handlebar indicator-cancel switch (`public/lib/handlebar-gestures.js`). They ask for `Accept: application/json` and get the same outcome as a machine-readable `WaypointReply`, because a banner that has to decide whether to be green or red cannot do it by reading English. **Siri's contract is untouched:** no `Accept` header, or any other `Accept`, still gets exactly the plain-text line it always did.

Nothing new goes on the wire. A waypoint is recorded as three ordinary signals (`waypoint_seq`, `waypoint_lat`, `waypoint_lon`), so it travels the existing path: sealed into the encrypted log by `record()`, and pushed to any open dashboard by the WebSocket patch it already triggers. The log format is unchanged, and `scripts/decrypt-log.ts` needs no special case.

Position is copied into the waypoint's own signals rather than left implicit in whatever `gps_lat`/`gps_lon` happened to be logged nearby: those carry a ~3 m deadband, so at a standstill the last logged fix can be minutes old even though the live one is current.

### 9.6 `/status` and on-demand-only groups

`onDemandOnlyGroups()` leaves a group out of the liveness summary entirely when every one of its signals is written on request.

`waypoint` is the only one today and the case that forced this. Its three signals are written by `GET /waypoint` and nothing else, so with `FRESH_MS` at 10 s the group reads `[0, 3]` before you ever save a waypoint and `[0, 3]` again ten seconds after you do. Reporting that is not reporting a fault; it is reporting the resting state, and anything filtering `live === 0` — a Grafana alert, a script, §5 of `scripts/check-ride-log-status.ts` — would fire on it forever and learn nothing. **Silence that is not evidence should not be served as if it were.**

This is also the one thing `/status` stopped reporting, and worth saying plainly because the rest of the change runs the other way: `waypoint` used to appear once a waypoint had been saved this boot, since the map was built from what had arrived. Every other group went from sometimes-present to always-present.

**WHOLE-GROUP, not per-signal**, and that is a decision rather than an accident: a group mixing measured and on-demand signals still has something to say about its measured half, so it stays. `.some` here would delete a whole group's liveness the moment one signal in it were flagged. The registry has no mixed group today, so nothing in the real data tells the two apart — which is why this is exported and `scripts/check-ride-log-status.ts` §5b feeds it a mixed group of its own.

---

## 10. The dashboard WebSocket

`src/ws.ts`. Event-driven push: a full snapshot on connect, a delta the instant a displayed value changes (per-signal deadbands already rate-limit these), and a slow full-snapshot heartbeat purely for liveness when the bike is sitting still.

**The snapshot is the whole of the resynchronisation protocol, and there is no other.** A new connection is answered with one, and every 5 s heartbeat is another. So a client that misses patches — dropped here, or thrown away on its own side after a suspension — is completely correct again one heartbeat later, with nothing to replay and no per-client history for this server to keep.

`HEARTBEAT_MS = 5000` is named rather than inlined because the dashboard's silence watchdog is measured in these: `public/lib/connection.js` gives a socket twelve seconds of nothing before it declares it dead, which is only safe on a parked bike because a snapshot lands every five whether or not a single CAN value has moved.

### 10.1 The fast-forward, and `MAX_CLIENT_BACKLOG_BYTES`

A client that is not reading is not a client to keep writing to. iOS suspends the dashboard whenever the screen locks or another app comes forward, and it does not close the socket on the way — so without a cap the Pi queues every patch of however long the phone spends in a pocket, and delivers all of it at once when the page wakes. That is a fast-forward of old telemetry on the phone and an unbounded buffer here, on a Pi Zero that is also sealing the ride log. `public/lib/connection.js` now closes the socket before the page is suspended, which is the real fix; this cap is the half that does not depend on the client being well-behaved, and it also covers a phone that walks out of wifi range without ever sending a FIN.

**256 kB is about ten seconds of riding**: measured over this bike's own ride log (6.2 M readings), a patch is **152 bytes** and riding produces **19–27 kB/s** of them (p90–p99). It is also **six times the largest snapshot that could ever go out** (38 kB with every declared signal live, 20 kB of what this bike has actually produced), which is the floor that matters — a cap under one snapshot would cut a recovering client off from the very message that resynchronises it. `scripts/check-connection.ts` §7 keeps both ends of that.

Nothing is lost by dropping a patch, which is the property that makes this safe: the heartbeat re-sends the complete state every 5 s.

**⚠️ What this does NOT bound is a client that is slow rather than absent.** A phone whose downlink is merely slower than the patch rate keeps draining the queue, so its own 12 s silence watchdog never fires and it never reconnects — and what it drains is old telemetry that `store.js` applies as current. This cap holds that lag to roughly ten seconds instead of the whole ride, which is worth having, but **it is not a lag detector and the dashboard has none of its own**. Comparing `message.ts` deltas against the phone's own monotonic deltas would be one — same clock on each side of both subtractions, so it stays legal — and is the missing half of this.

### 10.2 Hanging up on a stuck client

Skipping a stuck client stops the queue growing but never lets go of the ~256 kB it is already holding, nor of its slot in `wss.clients`. The phone that rides out of wifi range sends no FIN, so nothing else notices until the kernel gives up on the TCP retransmits — on the order of **fifteen minutes** with the default `tcp_retries2`, once per out-of-range event, on a Pi Zero that is also sealing the ride log.

Two consecutive heartbeats rather than one reading, so a client that is briefly over the cap is not hung up on for a spike. **Be precise about what that does and does not say:** this samples two INSTANTS a heartbeat apart, not the interval between them. A client over the cap at both is terminated however much it drained in between.

That is the right call at the rates involved, which is why the coarse test is enough. A client over the cap is sent nothing more (`broadcastTo` skips it), so its buffer only drains; and the overshoot is at most one message, the largest of which is a full snapshot at ~38 kB. So anything draining faster than **~7.6 kB/s** — 38 kB across one 5 s heartbeat — is back under the cap before the second sample is taken. A client that cannot manage even that is moving at under half of what riding produces at its QUIETEST (19 kB/s, p90), so it is not recovering from a spike, it is falling behind for good.

`alreadyStuck` is a `WeakSet` so a client that closes on its own takes its entry with it. **Terminate rather than close**: `close()` is a handshake, and a peer that is not reading is not going to answer one. The byte count is taken BEFORE the terminate — `bufferedAmount` is the sum of the socket's write buffer and the sender's, and destroying the socket has already emptied the first half of that by the time the caller could read it.

`broadcastTo` is a module-level function rather than the loop it used to be inside `setupWs()`, so the rule about who gets skipped can be exercised against stand-in clients with no server, no port and no sockets.

### 10.3 `MAX_CLIENT_FRAME_BYTES` and the two `error` listeners

The receive-side mirror of the backlog cap, and it can be this small because **nothing reads client messages at all** — there is no `on("message")` handler anywhere in `ws.ts` or below it, so every byte a client sends is already ignored. What was not bounded is how many bytes `ws` would buffer up before ignoring them: **the default is 100 MB**, on a Pi Zero, reachable by anyone on the same wifi as the bike. 4 kB is generous room for whatever the first client→server message turns out to be, and four orders of magnitude off the default.

**⚠️ This limit and the connection `error` listener are one change, not two.** Rejecting a frame is how `ws` reports a protocol violation, and it reports it by emitting `error` on the connection — which Node turns into an uncaught exception, and therefore a dead service, if nothing is listening. Setting a cap without the listener hands anyone on the bike's wifi a way to kill the process with one 8 kB frame, taking ride-log sealing down with it. **Remove one and you must remove the other.** Measured on this repo before the listener existed, a single 8 kB frame ended the process with exit 1. The malformed-frame case needed no cap at all.

Logged rather than swallowed, and at `log` rather than `warn`: on a machine anyone on the wifi can reach, a malformed frame is a thing that happens, and the reason to record it is to know it happened at all.

**The server-level listener is the same hazard one layer out — but NOT for the reason it is tempting to assume.** With `options.server`, ws 8.20.0 forwards the http server's own `error` straight to that emitter: `addListeners(this._server, { …, error: this.emit.bind(this, "error"), … })`, `websocket-server.js:116-125`. So what arrives is not a failed handshake — handshake faults are answered with an HTTP response and never reach an emitter — it is whatever goes wrong with the listener itself. In practice, the bind failing.

Which makes the default answer the wrong one, and dangerously so: `index.ts` calls `setupWs()` BEFORE `server.listen()`, so `EADDRINUSE` lands there, and merely logging it leaves the process alive with nothing bound. systemd restarts a failed unit; it does not restart a running one that happens to serve nothing. The dashboard would be dead and everything that reports on it — the unit's state, the exit code — would say fine.

So: **not listening means not a service.** Rethrown rather than exited, because an uncaught exception prints the whole error and exits 1 — exactly what this did before the listener existed — while `process.exit()` would abandon whatever stdio is still queued, which on a journald pipe is the message saying why.

The disclosure this replaced was wrong, and wrong in the way that matters: it rested on a claim about `ws` that nobody had checked against `ws` — that the server-level `error` is reserved for a listener `ws` owns itself, so no external-server deployment could reach it. The way in was never a handshake, which is why looking for a handshake found nothing.

---

## 11. The check suite

### 11.1 Why there is no test framework

`npm test` runs `scripts/run-checks.ts`, which runs every self-check in the repo, in order, and exits non-zero if any of them does.

Added 2026-08-16. Until then `npm test` was still the npm placeholder (`echo "Error: no test specified" && exit 1`) while the checks had been passing for weeks and gating nothing: CI ran Prettier and tsc, so a change that broke the parameter table or a decoder went green.

The checks predate the runner and were written as scripts, because that is what this repo is: TypeScript run directly under `--experimental-strip-types`, no build step, no bundler, deployed by `git pull`. Jest or Vitest would add a transform pipeline and a dependency tree to a project whose whole shape is "the file on disk is the file that runs" — to gain assertion sugar over the dozen-line `expect()` each check already carries, and nothing else those checks need. So it is a runner, not a framework: the checks stay runnable by hand exactly as their own comments document them, and the runner only decides what runs and what a failure means.

**Each check gets its own process.** They are top-level scripts that do their work at import time and report failure with `process.exit(1)`. Imported into one process, the first failure would take the runner down with it and every later check would go unreported — the opposite of what a red build should tell you. Separate processes also keep their module state apart.

**No bike — and no waiting for one.** Nothing in the suite opens a CAN socket. `socketcan` is imported at runtime in exactly one place, `src/can/socket.ts`, which none of these reach; everywhere else it is `import type`, which type stripping removes before Node ever sees it. That is why the suite runs on macOS and on an Actions runner, neither of which has a `can0`. `CHECK_TIMEOUT_MS` (120 s) is the guard against that quietly changing: a check that did reach for hardware would mostly not fail — it would sit waiting on a bus that is not there — so a check that stops producing a verdict is counted as one that failed. The whole suite runs in about a second today, so the timeout is not a performance budget.

`SelfCheck.args` carries fixed flags a script needs to be a check at all — not argument forwarding, but part of the entry, so what runs is what the `covers` line claims and cannot drift with however the suite happens to be invoked. `generate-grafana-dtc.ts` is why it exists: with no flag it REWRITES the dashboard and exits 0, which under `npm test` would be a check that silently edits a tracked file and never fails. `--check` is what makes it report instead of act.

### 11.2 What is deliberately not in `npm test`

Only checks that pass or fail on their own, with no bike and no local-only files, belong there.

| script | why it is out |
| --- | --- |
| `setup-service.ts` | installs a systemd unit, and wants root to do it |
| `generate-log-key.ts` | writes the keypair once and refuses to overwrite it |
| `decrypt-log.ts` | needs the private key and `.celog` segments, neither in the repo |
| `replay-capture.ts` | needs a candump capture — gitignored, and one bike's ride history — and serves a dashboard to look at rather than asserting anything, so there is no verdict to collect |
| `extract-vcu-tables.ts` | needs a copy of the manufacturer's service-tool executable — ~137 MB of somebody else's proprietary install, neither in this repo nor on an Actions runner. It is a GENERATOR anyway: it rewrites `src/vcu/table-catalog.data.ts`. What CI checks is the output, and it checks it hard — `check-vcu-params.ts` §1e rebuilds all 28 tables and compares each against the fingerprint the extractor took from Energica's own bundle, so a delta that has drifted from the `params.ecf` text underneath it fails the build without the exe being anywhere near it |
| `read-freeze-frame.ts` | **TALKS TO THE BIKE.** It is the live test for the multi-frame KWP transport and the only thing in the repo that opens a socket outside the service, so it must never be in the list — `CHECK_TIMEOUT_MS` exists precisely to catch a check that started waiting on a bus that is not there. Its own replayable half is `scripts/check-kwp-multiframe.ts` |

`captured-dtc-transfer.ts`, `captured-vcu-records.ts`, `freeze-frame-fixtures.ts` and `simulated-vcu-micro.ts` are fixtures and a test double: data and a stand-in bus, not checks. The replay scripts in `CHECKS` are what read them. `freeze-frame-fixtures.ts` is the one that is CONSTRUCTED rather than captured — what the check built on it proves is correspondingly narrower.

### 11.3 Provenance of the fixtures

**`scripts/captured-dtc-transfer.ts`** — a real 2026-08-04 candump, byte for byte, and that is why the checks built on it prove something about the bike.

**`scripts/captured-vcu-records.ts`** — two DIFFERENT kinds of evidence, kept apart on purpose:

- `CAPTURED_FRAMES` — whole CAN frames, quoted byte for byte from `obd-garage/DIAG_ADDRESSES.md` §3, where they were written down as they came off the bus on 2026-08-08. **These are the only things that prove the FRAMING.**
- `LIVE_BANK1_READS` — parameter values read live on 2026-08-08 (§4 and §5). The notes recorded the identifier, the record bytes and the decoded value, but NOT the enclosing frame — so the frame is reconstructed around them in the check script. They prove the name table, the routing and the interpretation; **they do not independently prove the framing, and are not presented as if they did.**

**`scripts/captured-freeze-frames.ts`** — the 29 real `0x17` replies from `capture-20260808-182129`, byte for byte, PCI bytes included.

**`scripts/freeze-frame-fixtures.ts`** — **⚠️ constructed, not captured. The name of the file says so.** It now holds only the shapes the bike never sent, which is the one thing a capture cannot supply: a refusal, an answer naming the wrong component, a short Consecutive Frame mid-transfer.

The note that used to stand here said no `0x17` payload had ever been recorded, and that the 2026-08-08 capture "kept only the service bytes, not the data" (`obd-garage/DIAG_ADDRESSES.md` §9.1). **That was wrong, and the reason is worth keeping.** The search looked at `7C0`. `7C0` carries only requests — byte 0 is the addressed component, `A8` or `A9`, on all 26 662 of them. Replies come back on **`7E0`** with byte 0 = `F1`, the tester. Both directions of a KWP session are not on one CAN id here, and assuming they were hid 29 real payloads for long enough that a fixture was built in their place. §9.1 of the garage notes is still uncorrected; it is gitignored, so this paragraph is the correction of record.

Two of the invented frames also **disagree with the real ones**, which matters before trusting them for anything else: component 44 really answered 18 bytes with status `0x07`, not 17 with `0x05`, and component 4 answered `0x25`, not `0x2D`.

How they were built: payload per §5.1, then the fault's own infokey shortlist in order, each field big-endian at its datatype's width; framed as extended-addressed ISO-TP to the tester (`0xF1`), a First Frame carrying 5 payload bytes and Consecutive Frames carrying 6, zero-padded to a full 8-byte DLC. The two faults were chosen because this bike has met both: **P0A07**, the water-pump code, which the bike reports intermittently; and **P0514**, which mode 01 PID 02 named as the freeze-frame code on 2026-08-04 and which is in the 39 stored codes. The VALUES are invented, but not arbitrarily — each was picked to exercise a decoding path that would otherwise go unchecked: a zero-current open circuit, a negative int16 (`B_PACK_I` = −1.8 A), a negative int8 (`B_L_TEMP` = −1 °C), the ×0.1 scaling, and the `(X/2)-40` air-temperature encoding.

**`scripts/kwp-multiframe-fixtures.ts`** — this channel has almost no captured payloads. The 2026-08-08 passive capture counted **26 662 requests and kept only their SERVICE bytes**, so `0x17`, `0x18`, `0x36` and `0x37` have counts and outcomes behind them and no bytes. The fixtures are graded, and the grades differ sharply:

| grade | what it is |
| --- | --- |
| §A | **Reconstructed from two independent live records.** The strongest thing there, and the only multi-frame reply on this channel with any real bytes in it at all |
| §B | **Captured verbatim**, request side only — the `0x35` First Frame |
| §C | **Decompiled**, not sniffed — the `0x18` request |
| §D | **Constructed.** Everything else, including every `0x36` block. These prove the transport is self-consistent and rejects what it should. They prove nothing about the bike |

The malformed frames in §D are the ones worth having regardless of provenance: a transport that completes a transfer from a short Consecutive Frame produces a plausible wrong answer, and that is a property of OUR code, which these fixtures do exercise honestly.

§A in detail: **✅ the First Frame is quoted verbatim off the bike** — `obd-garage/DIAG_ADDRESSES.md` §3's responder table records A8 answering `22 2001` (bank 2, live data) with `F1 10 07 62 20 01 00 09`, marked "(multiframe) **no auth**", from this project's own live probing on 2026-08-08. **✅ The PAYLOAD is quoted verbatim off the bike too**, from a DIFFERENT session and a different tool: `obd-garage/CAN_MAP.md`'s A8 scan of 2026-07-26 records bank-2 record `0001` = `00093cb6` — one of four multi-byte records that a bug in `kwp_scan.py` had been silently dropping until it was fixed and re-run. **🔗 The two agree**, and that is what makes this a real fixture rather than a construction: the First Frame declares 7 payload bytes and carries five of them, `62 20 01 00 09`; the scan says the record is `00 09 3C B6`; the first two bytes of the record are exactly the last two bytes of the First Frame, and `62` + identifier `20 01` + a 4-byte record is exactly 7. So the Consecutive Frame carried `3C B6`, and there is only one frame it can have been: `F1 20 3C B6 00 00 00 00`. That single frame is the inferred part, inferred from two independent live records that had to agree and did. ⚠️ Its SEQUENCE NUMBER was inferred wrongly and read `F1 21` until 2026-08-20: these micros open a Consecutive Frame run at **0**, in 1229 of 1229 captured replies. The bytes were never in doubt; the PCI was, and nothing noticed because the reassembler was wrong the same way — see [`docs/vcu-parameters.md` §10](vcu-parameters.md#10-multi-frame-reads). **⚠️ What it does NOT establish: the zero padding.** Both DLC modes exist on this bus (`obd-garage/SERVICE_RESET.md`, and `DIAG_ADDRESSES.md` §9.2 records the same write both padded and not), and the length byte governs either way.

**`scripts/simulated-vcu-micro.ts`** — a stand-in for the VCU micros on a stand-in CAN channel, so the TRANSPORT half of reading parameters can be exercised on a laptop. It models the two behaviours that make this bus awkward, both from `obd-garage/DIAG_ADDRESSES.md` §3: a micro answers NOTHING until `10 81` has been sent — not even a negative response, which is why a conventional sweep finds nothing here; and the session then expires after an idle timeout, silently, so the next read just vanishes rather than being refused. Since 2026-08-16 it also models the MULTI-FRAME half in both directions.

**⚠️ It is a test double, and the multi-frame half is a double of a GUESS.** The single-frame behaviours are modelled from things measured on the bike. The multi-frame ones are not, and cannot be: no multi-frame reply, no flow-control frame and no `0x36` payload has ever been captured on this channel. So passing against it proves the client is well-behaved against the framing this repo believes in — it does not prove the bike behaves that way.

**`scripts/check-gps-clock.ts`** — **PROVEN**: copied out of `rides.db` (269 MB, 6 200 564 rows, 2026-08-02 … 2026-08-15) on 2026-08-16, as `[row timestamp ms, gps_epoch_s]` pairs exactly as logged. The four corrupt sequences are the only four frames in the whole database whose decoded UTC is beyond year 2049; the two cold-boot sequences are real stale-clock starts. **INFERRED**: the raw 8-byte frames in the decoder section. `rides.db` stores decoded values, not bus bytes, and the one committed capture (`obd-garage/captures/2026-08-02_bms_90s.log`) was taken in a garage with no fix. So these are re-encoded from logged values through the documented bit layout: **they prove the decoder's arithmetic, not that the hub emitted those exact bytes.**

**`scripts/check-charge-mode.ts`** — the `0x102` payloads are REAL, copied byte for byte with their timestamps out of the candump captures, the same ones `check-button-decode.ts` asserts the button and contactor bits against. The `0x201` payloads are **CONSTRUCTED**, and it is worth being exact about how: byte 0 is an observed value in every case (the `01` is from a live candump taken beside the bike the day the bug was reported; the `02` and `10` are the states `CAN_MAP.md` records for an AC session and its tail), and bytes 1–7 are the error and warning words, which have read all-zero in every capture of this healthy pack. So the byte under test is measured and the rest is the quiet background it has always sat in. The charger frames `0x305` and `0x306` are not replayed at all, on purpose: the rule never reads their values, only whether they arrived, so a case sets their FRESHNESS directly rather than inventing charger bytes that would imply a precision this has no need of.

**`scripts/check-button-decode.ts`** — every frame is REAL, copied byte for byte with its timestamp out of the candump captures in `~/Documents/cool-eva-archive` (see `CAPTURES.md` there). None is hand-written, because a hand-written frame only proves the decoder agrees with whoever wrote the fixture. The `0x400` button payloads in particular are the only ones ever recorded on this bike: across **1 099 357** frames of `0x400`, byte 2 held a non-zero value in **362** of them and took exactly two values — until 2026-08-19, when a session of deliberate presses finally produced a third (`0x01`, `btn_set_back`, 132 frames).

**`scripts/check-handlebar-gestures.ts`** — most cases are real durations measured off this bike's own bus that must NOT be recognised as a gesture:

- **140 ms** — the median handlebar press across 14 candump captures, and since indicator-cancel is 63 of the ~70 presses in that corpus, effectively the median cancel tap.
- **120–260 ms** — the MODE buttons and `btn_set_back`, confirmed 2026-08-19 by instructed presses, 8/8 each, as clean momentary 0→1→0 pulses. An independent measurement of what an ordinary deliberate handlebar press looks like, and it agrees with the corpus median.
- **920 ms** — the longest ordinary press ever recorded on any handlebar button (`btn_cruise_enable`, 2026-08-04 19:45:47.924). The long-press threshold has to clear this, or a rider who leans on a button saves a waypoint by accident.
- **1794 ms** — the only `btn_cruise_set` press in the corpus (2026-08-04 18:04:45.055), held while cruise took the speed. A press this long must never pair with the one after it into a double click.

A "sample" there is one WebSocket message, carrying the SERVER's timestamp — not the phone's — so every `at` is the Pi's clock. That means a stalled link is representable, and is tested: a stall is simply a gap with no samples in it. The detector cannot see wall-clock time passing on the phone, because it is never given it.

The names are a trap: `btn_cruise_enable` sits next to `btn_cruise_set` and BOTH of its recorded presses armed cruise control 0.53 s later. Binding a UI gesture to that bit would put a tab switch on a control that changes how the bike is moving — which is why the check also pins which buttons the gestures are bound to.

#### 11.3.1 What the 29 captured replies settled

Numbered inside 11.3 rather than taking 11.4, because ten comments across seven files already point at "§11.4" meaning the section below, and renumbering them to make room for this one would have broken all ten silently.

The reply layout, confirmed on all 29: `57 <recordCount> <DTC-hi> <DTC-lo> <status>`, then the fault's infokey fields in payload order, then **one trailing byte**.

⚠️ **The lengths alone do NOT settle the header split.** `5 + fields + 1` and `6 + fields` are the same number, 29 times out of 29 — the arithmetic cannot tell a 5-byte header with a trailer from a 6-byte header without one. What the lengths confirm is the shortlists' total widths. The split is settled by decoding, below.

**The header is 5 bytes, and 16 of the 29 replies rule out an alternative.** Apply physical bounds to every decoded field at once — SOC and SOH within 0–100, pack voltage under 400, cell millivolts at or under 4500, temperatures within −40…80 — plus the cross-field orderings `MIN_CELL ≤ AVG_CELL ≤ MAX_CELL` and `L_TEMP ≤ H_TEMP`:

| header | replies containing an impossible value | violations |
| ------ | -------------------------------------- | ---------- |
| 4      | 11 of 29                               | 27         |
| **5**  | **0 of 29**                            | **0**      |
| 6      | 14 of 29                               | 31         |

The single sharpest reply is component 44, `P0A07`: `ai_WaterPumpCurrent_In` reads **0 mA** against a 400 mA open-circuit threshold — the pump is wired to the heated-grip output, so its driver sits open — and the three IGBT legs read an identical **34.9 °C**. Three legs of one inverter sampled in one instant must agree. Note this is doing real work only because it is a _three_-way test: at headers 3, 4 and 6, two of the three still agree by chance. Corroborating: component 46 (`P1044`, cell overvoltage) reads SOC 100 % with a 4201 mV maximum cell; component 7 (`P1004`, cell undervoltage) reads SOC 12 %, −88.3 A, minimum cell 3259 mV; components 36, 37 and 48 read `P_V12` at 12720, 12720 and 12736 mV. Those are self-consistent stories rather than coincidences.

**A second, independent witness to the count.** 596 ms before the first `0x17`, the tool sent `18 02 FF FF` (ReadDTCByStatus) and got back an 89-byte `0x58`: a count byte of `0x1D` = **29**, then 29 three-byte records whose `(component, status)` pairs are identical, and in the same order, to the 29 freeze-frame replies. The count and the status bytes are each confirmed down a second path.

**How far the shortlists are actually confirmed.** Every reply's length equals the header plus that fault's own infokey widths plus one, for components 3 to 62 and field payloads from 0 to 20 bytes, and 20 is reached by component 51 — so `MAX_FREEZE_FRAME_FIELD_BYTES = 20` is met exactly rather than exceeded. But **"29 of 29" is not 29 independent confirmations of the 944-reference table**, and the earlier wording here overstated it. The 29 replies touch **191 of 944 references (20 %)**, **65 of 120 infokeys**, and only **23 distinct shortlists** — five shortlists are shared by two or three captured faults ((41,0)+(42,0); (3,0)+(4,2); (5,0)+(6,0); (7,0)+(22,0)+(46,0); (39,0)+(40,0)), so those do not independently confirm each other. The length test distinguishes only **12 distinct total widths**, and length-consistency cannot detect two same-width fields being transposed. The cross-field orderings above do confirm ordering for the battery faults; nothing confirms it for the rest.

**The trailing byte is not decoded.** It is not a checksum, and this was tested exhaustively rather than casually: the entire CRC-8 space (256 polynomials × 256 inits × 256 xorouts × 4 reflection combinations × 7 byte ranges), nine accumulator variants (sum mod 256, sum mod 255, end-around carry, one's and two's complement, XOR, XOR complement, LRC, byte count) and 18 named CRC-8 presets. **Nothing beats a degenerate 6 of 29** — polynomial 0 with xorout `FF`, which only reproduces the six `0xFF` values and would match any data containing six `0xFF`s.

Values are small integers (1, 2, 3, 5…61, 118) plus `0xFF` on six replies. Two readings fit, and the evidence does not separate them:

- **A saturating occurrence counter.** Component 44 — this bike's permanent standing fault — is one of the `0xFF`s.
- **A "not applicable" sentinel.** Three of the six `0xFF`s sit on components 51, 52 and 60: `P1050`, `P1051` and `P1052`, _Battery statistics info 1/2/3_. Those are informational pseudo-codes, not faults that "occur" — a saturated occurrence count on a statistics record is odd, where a sentinel is natural. The distribution, topping out at 118 and then jumping to 255, suits either.

⚠️ Do NOT reason from "components seen once read `01`". Nothing in the capture measures how many times a component was seen; that sentence is the counter hypothesis restated as if it corroborated itself, and it stood here until a review caught it. The `0x58` list carries no per-DTC counter — exactly three bytes per record — so there is no second source.

⚠️ **The obvious test is compromised by this same capture.** "Read them again and see whether the counters moved" looks decisive but is not: at `19:04:28.392`, 25 s after the last freeze-frame read, the factory tool sent `14 FF FF` (ClearDiagnosticInformation) to the A8 and got `54 FF FF` back. The codes were cleared in this session. Unchanged or low values on a re-read are therefore consistent with the counter reading _and_ with its negation, since a clear would plausibly reset a counter too. A test that does discriminate has to span a clear it knows about, or find a component whose fault recurs on a known schedule.

`headerBytesThatFit` returns `[]` on all 29 real replies, because no candidate header length explains a payload one byte longer than header-plus-fields. That empty array is the correct answer and not an error. It also means the field can no longer do the job its docstring assigns it — it was written as the tie-breaker for the header split, and on real data it breaks no ties. It is kept because an empty result is itself the signal that the length is not header-plus-fields.

### 11.4 The bugs the checks were written for

**`check-ride-log-status.ts` — the caption.** It read "10 sealed segments · encrypted, safe over any network", and it read that for weeks — reported as "it always says 10". Ten was in fact the honest count of `.celog` FILES in `RIDE_LOG_DIR`, stat'd one by one, nothing hardcoded and nothing capped. It was the noun that was wrong (see §9.4). So the check pins both halves — that the count is computed from the directory and scales past any plausible cap (§1), and that a file is genuinely not a segment, so nothing may relabel one as the other again (§2 and §3).

"Safe over any network" was doing the same thing in words: broader than what the code provides. What the code provides is confidentiality, and it really does — the Pi holds only the recipient's public key, and §4 proves a segment opens with the matching private key and refuses any other. What it does not provide is **authenticity**: that public key is not a secret, and anyone holding it can seal a segment that decrypts and passes its GCM tag exactly like a real one. `/dl` is unauthenticated and nothing is signed.

**And the liveness summary.** §5 is here for a defect of the same family, found while deleting the readout that displayed it: `summariseGroups()` was built from the keys that had ARRIVED, so a source which had never spoken was missing from the payload rather than reading zero. Anything looking for a dead source by filtering `live === 0` therefore found nothing to report on a completely dead bus. It was visible in the wild and nobody noticed: a screenshot of the old sixteen-tile grid showed sixteen groups against a registry that declares seventeen. The missing one was `waypoint`, absent because no waypoint had been saved. **Both bugs are a true number that answers a different question from the one being asked of it.**

That check runs against a keypair generated and thrown away, in a temp directory, through the real `src/storage/encrypted-log.ts` and the real `src/http/status.ts`. The repo's own private key is never read and never needed. It restates the log's framing constants rather than importing them: those constants are not exported, and a check that borrowed the producer's own idea of the format could not notice the producer changing it. `scripts/decrypt-log.ts` keeps its own copy for the same reason. `FIXTURE_FILE_COUNT = 13` is deliberately more than ten — ten is the number the owner kept seeing, and the first guesses at why were a hardcoded literal, a `LIMIT 10` and a fixed-size preview array; none was the answer, but any of them a later change could introduce for real. Thirteen fails all three, and the byte total fails them again independently: the first ten files hold 55 bytes, all thirteen hold 91, so a truncated count cannot produce a matching size.

§5a's `MUST_BE_SUMMARISED` list is **named, not re-derived**. Computing `onDemandOnly` with the same expression the implementation uses makes the two agree by construction, so the check would bless whatever the implementation decided — including deleting liveness for the sensors this project exists for. Marking both coolant probes `onDemand` passed a version of this check that shared the formula.

#### The caption gate, and the two versions of it that were wrong

The caption was removed outright on 2026-08-19 for screen space, which is the event that narrowed §3: there is no count to label any more, and the old "must read `log.files`" assertion was firing on a deliberate deletion rather than on a bug. That assertion is **gone rather than gated**, because gating it made it unfirable — it was `showsACount && !includes("log.files")`, and `showsACount` was true only when `log.files` was present, so the two halves contradict. The `log.segments` arm could not save it either: `StatusPayload.log` is `{ files; bytes; enabled }` and `public/**/*.js` is checkJs'd against it, so tsc rejects that spelling before the script ever runs. Nothing was lost by deleting it; it was already dead.

What survives is the half tsc cannot check: the English. This is the **third attempt** at that gate, and the first two were both wrong in opposite directions — worth recording, because the shape recurs.

1. `showsACount && !includes("log.files")` — contradictory halves, **could never fire**.
2. `/\$\{/ && /\blog\b/` — the "any number reaches the rider" version. It **can never NOT fire**: the button's own `${bytes(current.log.bytes)}` gives the interpolation and the words "Download ride log" give the `log`. A caption with no count at all still tripped it.

So it is back to the file count's actual spelling. That is narrow, and the narrowness is the honest part: it catches the bug that was REPORTED and does not pretend to catch a caption that reads the count through a destructure (`const { files } = current.log;` walks past it). A guard that fires on everything is worth less than one that fires on the real case and says what it misses.

The canary in front of it is load-bearing for the same reason. Every other assertion in §3 fires on the PRESENCE of something wrong, so an over-eager `withoutComments()` that returned `""` would make them all pass and the section would go **quiet instead of red** — and `withoutComments()`'s own docstring promises the opposite. That promise used to rest on the `log.files` assertion firing on absence; removing the caption removed the canary with it, silently. So §3 now asserts the stripper left real code behind, against something structural rather than anything to do with the caption: `DownloadButton` exists to start the download, and if the `/dl` line is gone the input was not that function.

**`check-can-decoders.ts` — the RX filter.** `STREAM_IDS` sets the kernel's `CAN_RAW` filters (`src/index.ts`). An ID missing from it never reaches `decodeFrame`, so the decoder is dead and NOTHING SAYS SO: no error, no warning, no failing test — the signal is simply absent, which is indistinguishable from a bike that never sent it. That has already cost real time on this project once, on `0x400`. So the check runs the other way round, from the decoders to the filter: probe `decodeFrame` across the whole 11-bit ID space and fail if any ID that answers is missing from `STREAM_IDS`. It is deliberately one-directional — an ID in `STREAM_IDS` with no decoder is fine and there are several (`0x410`'s non-GPS sub-frames, frames only present while charging).

**⚠️ The emitted-key check used to be circular**, and the circle closed the moment decoders started gating on frame invariants. It enumerated the emitted keys by feeding `PROBE_PAYLOADS` to the ids that answered `PROBE_PAYLOADS`. `0x625` wants b1 = `0x01`, `0x615` wants b1 = `0x01` with a zero tail, `0x610` wants b4-6 = `F1 05 01` and `0x121` wants opcode `0x18` — none of the four probe payloads is any of those shapes, so all four ids answer nothing, drop out of `answeringIds`, and their nine keys quietly stop being checked. Nothing failed, because the entries exist; **the PROTECTION was gone**, while the script went on printing "every emitted key is declared". Worth saying how it got in: the fix for a real decoder bug disabled the check that guards the same decoder. So the emitted set is now the UNION of what the probes produce and what the replay cases produce, and the check runs after both. A fifth probe payload shaped like a real `0x625` would have patched the symptom and left the next differently-gated frame to rediscover the hole.

**`check-vcu-params.ts` §1e** is the one that keeps this repo honest about OTHER PEOPLE'S BIKES: it rebuilds all 28 of Energica's parameter tables from `src/vcu/table-catalog.data.ts` and compares each against a fingerprint `scripts/extract-vcu-tables.ts` took from Energica's own bundle — which is what stands in for the exe itself, since a 137 MB proprietary installer is not in this repo and is not on a CI runner. The checked-in fixtures are enough on their own; `--dump` additionally replays a full `kwp_scan.py` dump of the A9 if you have one, and that is where the strongest evidence for the whole mapping lives: **233 records against 233 table entries, every length predicted, every magic number in place.**

**`check-irreversible-actions.ts` — the fold's promise.** Collapsed, the menu sheet's red fold shows a count and three short names, and that line is what a rider standing at a bike reads to decide whether to open the drawer at all. Behind it are `31 FC` (which stamps a service point on the bike's own clock and odometer, with no unset), OBD Mode 04 (which takes the freeze frame with the codes) and a clock write that cannot be read back. A drawer that names the wrong three, or says three and holds four, is worse than one that names nothing.

Both halves used to be able to drift. The count was derived, but the names were a second hand-written array kept alongside, and the guard between them compared their LENGTHS — so reordering the list or swapping one action for another left the label wrong and the guard green. And it reported by `console.warn`, on a page whose entire deployment target is a phone clamped to a handlebar, where nobody has a console open, ever. The names are now read off the list itself.

The real invariant spans two files that cannot see each other: `src/http/vcu-write.ts` decides which actions are dangerous enough to demand `confirm=`, and `public/views/vcu-write.js` decides which ones a thumb has to open a drawer to reach. A fourth confirm-gated action added to the Pi and not put behind the fold is a destructive control sitting in the open list with the read-only ones, and nothing else in the repo would notice.

**⚠️ §3's vocabulary is read off the `case` labels of `parseWriteRequest`'s own switch, by parsing the source.** The first version read it out of the ENGLISH SENTENCE in that switch's `default:` arm instead, and that was worse than having no check at all, because it **inverted**: a new confirm-gated `case` whose author did not also edit that sentence was invisible, so the check went GREEN when the action was left in the open list — the exact state §3 exists to prevent — and RED when it was correctly put behind the fold, complaining that the fold held something "merely scary". A check that is green when you are wrong and red when you are right does not fail safe; it actively misleads. The `case` labels cannot drift from the dispatch because they ARE the dispatch. §4 calls `confirmationFor`, the single site the page builds `confirm=` from, rather than listing what it is expected to produce — a list there would be the same parallel array the check exists to abolish, and it would stay green while `31 FC` and Mode 04 were refused on every press.

**`check-charge-mode.ts` — "DC charging" in a garage.** The charging screen showed "DC charging" on a bike parked with nothing plugged into it, directly above a card correctly reporting that the pack was DELIVERING 0.1 kW. Every decoder involved was right: `0x201` byte 0 read `01`, the bits came out as Discharge, and the delivery card read them correctly. What was wrong was one line of the view, which asked only "are the AC charger's frames arriving?" and called everything else DC — never asking whether a charge was happening at all. So the check sits one level above the frame decoders: real bytes in, and the answer the SCREEN acts on out. It is the join that had nothing testing it.

Across ~24 M frames `0x201` byte 0 takes exactly three values, and each has caught somebody:

- `0x01` **Not charging** — parked at −0.2 A and riding at −166 A alike. Two independent reverse engineers labelled it "IDLE", which makes a discharging pack look idle (`obd-garage/CAN_MAP.md` §"the .xdbc").
- `0x02` **AC charging.** Solid.
- `0x10` **The BMS is not charge-managing.** It covers a whole DC session — the current bypasses the BMS charge path — but ALSO the last ~2 s of every AC session, at −0.1 A. Reading it as "DC" is therefore wrong, which is why the DC arm rests on the contactor monitor instead.

**`check-connection.ts` — the fast-forward, and nine other claims.** `public/lib/connection.js` is the policy — when a socket should exist and what to do when it should not — and it takes every effect it has on the world as a parameter, so the whole of it can be driven against a stand-in socket, a fake clock and a fake `document.hidden`: no jsdom, no headless browser, no dependency, no bike. §9 and §10 are the exceptions and bind ephemeral loopback ports, because "a client cannot kill the service" and "a service that cannot bind does not pretend to be up" are the two claims a stand-in cannot make.

- **The fast-forward.** The bike's phone is handlebar-mounted, so it spends much of a ride locked or behind another app, and iOS suspends the page for all of it. What was observed is that the socket survives that, the Pi keeps sending, and the backlog is delivered in a burst when the page wakes: about thirty seconds of the last few minutes replayed at speed, on tiles that look exactly like live telemetry. The fix is that there must be NO socket while the page is hidden — §1 is that rule and §2 is the anti-replay guard that goes with it, because closing a socket does not guarantee the frames already in flight are never delivered.
- **Recovery must not depend on a close event.** §3 drives the silence watchdog with a stand-in socket that NEVER fires `close` — that is the point of it. A socket can stop carrying data without closing (a hotspot dropping out mid-ride; iOS Safari is documented as reaching the same state with `readyState` still reading OPEN), and a reconnect path that only runs from `onclose` would sit there for ever. §3 also covers the handshake that never completes at all.
- **Nor on a visibility event.** §4 takes both directions of `visibilitychange` away and requires the fix to engage anyway. The hidden direction is the one that matters: a socket left open behind a page nobody is reading is not silent, so no watchdog can find it — it is busy filling up with the backlog, and the header goes on saying "live". `pagehide` and a branch in `tick()` are the two nets under it.
- **And it must not churn.** §3 pins the other end too: nothing may happen at eleven point nine seconds.
- **Nothing stale may be shown as live.** §5 holds the real `isStale()` from `store.js` up against the real connection states. This is the assertion worth the most: a frozen pack current at full brightness is worse than a visible dropout, because the rider has no cue that what they are reading is minutes old.
- §6 runs the real `connect()` with the browser globals faked, because everything above it drives the policy directly and would stay green if the wiring that attaches it to `visibilitychange` were deleted. §7 is the Pi's half of the same question.
- **And nothing may move the screen because of it.** §8 is the other side of §5: making everything stale while the link is down is right for anything that DISPLAYS a value and wrong for the edge-triggered view rules, which read freshness as evidence about the bike. On a DC charge the contactor bit's freshness is the only evidence there is, so a dropout would otherwise throw the rider off the Charge tab and back — with a history entry each way, once per screen lock, at a charger.
- §9 and §10 are §10.3 above, from the check's side.

`watchingForCrashes()` exists because §9 and §10 both have to catch a throw Node would otherwise turn into a dead process, which means installing a process-wide net. While that net is up it also catches failures in the CHECK, and an absorbed failure is worse than a loud one: the assertions stop half-made and the run hangs on the sockets nobody closed, until `run-checks.ts` kills it two minutes later with "no verdict". **Two mutations landed exactly there before this existed.**

**`check-tab-routing.ts` — a tab's name is a URL.** `/#charge` is what a bookmark on the phone's home screen holds, and what a link sent to somebody else holds. Renaming a tab in `TABS` silently breaks every one of them, and nothing else in the repo would notice: the dashboard would still build, still typecheck and still work perfectly for anyone who opened it fresh. So the names are pinned by hand, spelled out rather than derived from `TABS`, which is what makes changing one a decision rather than an accident.

**A URL that names nothing must still open something.** `tabFromHash` runs before the first render, so anything it threw on would be a blank screen rather than a wrong one — a bookmark with a stray `%` in it must land on the riding screen, not on nothing at all. Half the cases are malformed on purpose. **And it must stop lying about it:** `canonicalHash` decides both halves of the rewrite — correct a URL that says nothing this app has, and leave one alone that already says the right thing. The second half is not cosmetic: `showTabFromUrl` runs on every Back press, and a rule that rewrote unconditionally would spend Safari's history-call budget restating what the address bar already said. **The ring must close:** three flashes of the high beam advance one tab, and that gesture is the only input this dashboard has that works with both hands on the bars.

**`generate-grafana-dtc.ts` — the copy that drifted.** Grafana reads the ride log and nothing else, and the code table is not in the ride log: `reading` holds `dtc_0044_0 = 1`, not "water pump open circuit". So the two panels that name a code carry the whole table inline as a SQL `VALUES` CTE. Without a second datasource that copy cannot be deleted, so this makes it derived instead. `src/http/dtc-table.ts` already refuses this duplication for the phone dashboard; this is the same argument applied to the copy that cannot be removed.

**Why it had to be generated, 2026-08-16:** it drifted, in the direction nobody notices. When (44,0) and (44,2) were swapped on 2026-08-15 the JSON kept the old pairing, so for a day Grafana and the phone dashboard named THIS BIKE'S OWN FAULT `dtc_0044_0` differently — a seized pump on one screen, an unwired one on the other, on the fault the cooling work turns on. A wrong name still looks like an answer, which is why it survived being stared at.

**Measured, not assumed:** both panels' queries were run against `rides.db` before and after the regeneration. Same rows out of every panel, only the names changed — **486 for the timeline, 4 for the table, 633 for the counts.** The rewrite is textual, splicing only the bytes between the CTE header and its closing paren, so no other byte of the dashboard can move: panel ids, field order, transformations and the `\uXXXX` escaping the file happens to use all survive untouched. `assertOnlyValuesListsChanged()` proves that rather than trusting it.

**`check-freeze-frame.ts` and `check-kwp-multiframe.ts`** — see §11.3 for what their fixtures are worth. `check-kwp-multiframe.ts`'s request side has real evidence and leans on all of it: §2 asserts that the segmenter reproduces `A8 10 0C 35 12 FF FF FF` byte for byte — a frame captured off this bike — and §1 that the `0x18` request matches the one recovered from the manufacturer's code.

**`decode-dtc-response.ts`, `replay-capture.ts`, `check-button-decode.ts`, `check-gps-clock.ts`, `check-vcu-params.ts`** all play the same trick and for the same reason: **the bike is reachable for a few minutes at a time in a garage with no reception, and `socketcan` does not build on macOS anyway.** `replay-capture.ts` is the one that asserts nothing on purpose — the dashboard is the one part of this project that cannot be verified by reading the code; it is a judgement about what is legible at speed, and the only way to check it is to look at it with real numbers in it.

### 11.5 `check-vendor-names.ts`

Fails the build if the manufacturer's service-tool product name — or any of the file and library names that only exist inside it — appears anywhere in a TRACKED file.

**Why it exists.** This is a public repo and the owner does not want a third-party product name in it. It was scrubbed by hand on 2026-08-16 and was back within a dozen PRs, **92 lines across 27 files**. Not through carelessness: the reverse-engineering notes under `obd-garage/` are gitignored, they are where nearly every fact in `src/vcu/` and `src/diagnostics/` came from, and they use the real names throughout — correctly, since they are local-only. So anybody (human or agent) who reads them to write a comment copies the name across without ever deciding to. A review catches it sometimes. A grep catches it every time, which is the difference between a policy and a rule.

**The names are NOT the valuable part of those comments.** What is valuable is the provenance — proven vs inferred, which build, which section, how many rows agreed — and none of that needs a product name to survive. **Replace the name, keep the claim.**

**⚠️ Why the needles are spelled `"em" + "suite"`.** The check's own file is a tracked file, so it is scanned by its own check. A needle written as a single literal would sit in that source AS that literal, the check would find itself on its first run, and the build would be permanently red with no fix short of deleting the check. Splitting each needle across two string literals means the forbidden text never exists in the file at all — it comes into being at runtime, after the `+`. That is deliberately better than an exemption: there is no path this check skips and no file whose contents it declines to read, so nothing can be hidden from it by being moved into the one file it does not look at. **Do not "tidy" the concatenations.** (The `ForbiddenName.needle` JSDoc used to list the name's capitalisation variants to be helpful, which put the name in a tracked file and turned the check red on itself — caught by this check, in CI, which is the demonstration that it works.)

**Tracked files only, and that is load-bearing.** `git grep` with no tree-ish searches the working tree, restricted to files git tracks. `obd-garage/` is gitignored, so it is invisible by construction rather than by an ignore list this check maintains — which is what we want, because those notes must keep the real names. `manuals`, `Energica_Manuals`, `vcu-params`, ride logs and `node_modules` are out for the same reason.

**What it cannot do.** It sees text, not intent, and it only knows the names written down in `FORBIDDEN_NAMES`. A new artefact name out of the same tool needs a new entry. If git is missing or this is not a checkout, the check FAILS rather than passing: **a check that could not look is not a check that found nothing.** Same rule for an empty `git ls-files`: "no matches" and "nothing was searched" are the same exit status out of `git grep`, so an empty index or a sparse checkout would otherwise print a ✓ that means nothing.

**⚠️ And it guards the WORKING TREE, NOT HISTORY.** Every earlier commit still contains the names in full and stays readable through `git log -p`, the merged PR diffs and GitHub search — including the diff of the change that removed them. Making them unfindable rather than merely unshipped is a different and much larger job (a history rewrite, a force-push, and asking GitHub to collect the unreachable blobs its `/commit/<sha>` URLs otherwise keep serving), and it is not what this check is for. What it guarantees is the narrower, useful thing: **nothing this repo currently ships attributes anything to a named third-party product.**

Hits are matched against the RAW line and printed as the sanitised one. Doing both off the display string would lose the guidance on exactly the lines that most need it: a `--text` hit inside a CAD binary, or any line whose name sits past the 200-column cap, comes back with no name in it and so with nothing to tell the reader. Every name on the line is reported, not just the first: one comment can easily carry the product and one of its files, and both have to be rewritten before the line goes green.

Failure uses `process.exitCode = 1` rather than `process.exit()`, which the other checks do use. Node's stdio is asynchronous whenever it is a pipe, which it always is under `npm test` and under Actions, and `exit()` abandons whatever is still queued. Elsewhere that would cost a one-line assertion message; here the queued output IS the whole value of the red build — which file, which line, what to write instead.

---

## 12. Extracting Energica's VCU parameter tables

`scripts/extract-vcu-tables.ts` pulls the tables out of the manufacturer's service-tool executable and writes `src/vcu/table-catalog.data.ts`. README §"Adding your bike's VCU parameter table" is the operator-facing walkthrough.

**⚠️ This is the script that makes this repo usable on somebody else's bike.** A VCU addresses its calibration parameters BY INDEX, and what an index means comes from the table the VCU is running. Energica ships many; the 2024 service-tool build has 28 and another owner has reported a build with roughly five more, including one for a Corsa. If this repo does not carry your bike's table it will refuse to write anything (`src/vcu/table-gate.ts`) — correctly, because it would otherwise be writing a number into whichever parameter our table happens to give your name to.

**⚠️ It MERGES, and that is not a nicety.** Energica builds do not all carry the same tables. The 2021 build has 18 where the 2024 build has 28 — a strict subset, and the ten it lacks include every table with the battery cell block at ids 70–94. An owner running this against a 2021 install and getting a straight overwrite would delete this repo's own bike's table, and 19 others, while believing they had contributed something. **⚠️ A `TABLE_TYPE` present in both with DIFFERENT content stops the script.** Across the two builds available when this was written, every shared table is byte-identical, export stamp included — so a conflict means either Energica reissued a table under the same number or the base `params.ecf` text has moved underneath the catalogue. Both are worth a human deciding, and neither is worth guessing at. `--replace` is the deliberate escape hatch.

**⚠️ The resource name is the answer. Do not byte-scan.** The executable is a .NET assembly and each table is a ZIP archive stored as a `ManifestResource` byte array. The resource is NAMED `_<TABLE_TYPE>` — `_16407` is the table a VCU reporting 16407 runs — and that name is the ONLY thing in the binary that binds a table to the number the bike reports. It is corroborated inside the same exe by 28 compiler-generated accessors (`strings <the exe> | grep '^get__[0-9]*$'`) and by Energica's own changelog text ("Parameters bundle 61451 fixed").

An earlier attempt scanned the file for ZIP archives instead. That finds MORE archives — **58, because every resource is stored twice, covering 28 distinct export stamps of which only 24 are reachable by a `TABLE_TYPE` name** — and it throws the binding away, which is how it managed to identify the wrong table for the bike this repo runs on. Four of those stamps have no numeric resource name at all and the tool itself can therefore never select them. Hence: walk the resource directory, take the name, and ignore anything not called `_<digits>`.

**What a bundle does and does not contain.** Each ZIP holds `<stamp>.emcpd` (the parameter table: id, name, datatype, signedness, ecu, min, max) and `<stamp>.emcpc` (GUI editor panels, empty in 20 of the 28). ⚠️ There are **NO VALUES and NO SECTIONS** in a bundle: `vehicleValue` is null in all of them and `min`/`max` are just the datatype's range. That is why `src/vcu/param-file.ts` keeps `params.ecf`'s text — it is the only source of the `[SECTION]` grouping and the comparison column — and why this script emits DELTAS against it rather than 28 standalone tables.

**Why the output is a delta and not 28 tables.** `id → ecu` and `id → datatype` are byte-identical across all 28 bundles, and only names (151 ids) and signedness (30 ids) vary. Writing all 28 out in full would be ~1.1 MB of JSON to ship to a Pi Zero to say the same thing 28 times. The delta form is ~32 KB and is also the more reviewable artefact: the diff for a new table is a list of exactly which ids it renames.

Each emitted table carries a FINGERPRINT taken by the extractor, from the bundle's own records, before any delta arithmetic. `src/vcu/table-catalog.ts` recomputes it from the reconstruction, so a delta that does not rebuild the bundle it came from is a loud failure rather than a subtly wrong name table.

---

## 13. `scripts/read-freeze-frame.ts` — the live test

**⚠️ Read this before running it.** The only way to run the multi-frame KWP transport against the bike. It exists because the read cannot be done by hand: a First Frame has to be answered with a flow-control frame within milliseconds (`src/can/obd-dtc.ts` measured **4/12 transfers completing at 0 ms of added delay and 1/12 at 40 ms**), which is not something you can type into `cansend` in time.

- **Stop the service first:** `sudo systemctl stop cool-eva`. It holds its own socket on `can0` and restarting it re-initialises the interface, which kills ours (CLAUDE.md). Two testers on one bus is also how you get a reply matched to the wrong request — these micros answer on ONE id with no request tag.
- **It does NOT bring up `can0`**, deliberately, because `bringUpCan` takes the interface DOWN first and that kills every other socket on it. Bring the interface up yourself, ACTIVE (not listen-only), or nothing will transmit:
  ```
  sudo ip link set can0 down
  sudo ip link set can0 type can bitrate 500000 restart-ms 100 listen-only off
  sudo ip link set can0 up
  ```
- **Park the bike.** There is no service gate on this script — it is a scratch tool, not a feature — so that judgement is yours. Reading is read-only, but a bus shared with the ABS is not somewhere to be careless.
- **Run it detached** if you are over ssh. `DIAG_ADDRESSES.md`'s method note is from a link drop that cost a whole result set:
  ```
  nohup setsid node --experimental-strip-types scripts/read-freeze-frame.ts --log > /tmp/ff.txt 2>&1 &
  ```

**⚠️ Every reply is printed as raw hex first.** That is the point of the run, not the decode. The reply layout of all three services is unverified (see `src/vcu/multiframe-codec.ts` for which bytes are guessed), so the bytes are the evidence and the decode is a hypothesis printed beside them. **If the two disagree, the bytes are right.**

**⚠️ Read-only.** Everything goes through the same closed union as the rest of the client: `0x10`, `0x3E`, `0x17`, `0x18`, `0x35`, `0x36`, `0x37`. There is no argument that names a service and none that names a value.
