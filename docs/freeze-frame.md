# Freeze frames — reading the VCU's per-code records, and showing them

What the VCU recorded at the moment a code latched, read over KWP `0x17` and shown under that code on the Faults tab. The protocol, its provenance and what the 29 captured replies settled live in [`docs/diagnostics-and-checks.md` §5 and §11.3.1](diagnostics-and-checks.md); this file is about the READ, the store and the rendering — everything #226 added.

**⚠️ Two different things on one tab are called a freeze frame, and only one of them is named that on screen.** OBD mode 01 PID 02 returns the DTC that was set when the bike captured _its_ freeze frame — the code that lit the lamp. `public/views/faults.js` has shown that since the tab existed, tagged `· freeze frame`. What this document is about is the KWP per-component record, a different thing read a different way, and the copy for it never uses the phrase: it says **"Recorded when this code set"**. The wire, the store and the code keep the protocol's name, because that is what every other file in the repo calls it.

## The read

`src/vcu/freeze-frame-read.ts`, behind `read-runner.ts`'s `runOneShotBusModule` — the same gate, bus lease, single-flight and unconditional OBD-poller hold as the lifetime read.

1. `0x18` ReadDTCByStatus on A8 → the components that have a stored record.
2. `0x17` per component, via `readOneComponent` — the same implementation the lifetime read uses, so there is one `0x17` and one definition of what counts as an answer.

**The list is the authority on which components have a record**, and that is measured rather than assumed: on 2026-09-08 `0x18` named five components — 44, 51, 52, 53, 60 — and the two it omitted, 36 and 54, each answered `0x17` with `57 00`. n = 2. So the page says _"the VCU's list did not include this component"_, a claim about the **list**, and not _"the bike has no record"_, which is a claim about `0x17` that nobody has made 63 times.

**No service byte was added.** `{ kind: "read-freeze-frame" }` and `{ kind: "list-stored-dtcs" }` were both already members of `multiframe-codec.ts`'s closed union, and `0x17`/`0x18` were already in its allowlist. `31 FE` (the freeze-frame erase) and `14 FF FF` remain inexpressible from this client.

### The deadline, and what happens past it

`src/can/obd-hold.ts` caps a hold at 15 s **and the cap is enforced by the poller, not the holder**: past it `parkedForHold()` drops the hold and the 2 Hz loop resumes _underneath whatever is in flight_, and a request landing mid-transfer is what makes the VCU abandon it (`src/can/obd.ts`). So this read carries its own deadline.

Per-component worst case, derived by `worstCaseMultiFrameReadMs` from the transport's own timeouts rather than typed here:

|              |                                                                                     |
| ------------ | ----------------------------------------------------------------------------------- |
| session open | `responseTimeoutMs` 300 + `paceMs` 10 = **310 ms**                                  |
| × 2 attempts | `firstReplyTimeoutMs` 300 + `transferTimeoutMs` 400 + `paceMs` 10 = **710 ms** each |
|              | **1730 ms**                                                                         |

**⚠️ One session open per component, not one per attempt.** `openSession` stamps `lastExchangeAt` on success (`kwp-client.ts`), `ensureSession` returns early while the session is younger than `SESSION_IDLE_LIMIT_MS` (1500 ms), and a single attempt cannot exceed 710 ms. Both attempts call `ensureSession`; only the first one opens. An earlier draft of this arithmetic counted two opens and got 2038 ms.

What that means in practice:

| scenario | cost | fits the 15 s hold? |
| --- | --- | --- |
| today's five components, good case | ~0.35 s | yes |
| today's five, session opens and every `0x17` stalls | 1020 + 5 × 1730 = **9.7 s** | yes |
| 29 components, micro genuinely silent | 29 × 310 ≈ **9.3 s** | yes — `no-session` is not retried |
| **29 components, session opens and every `0x17` stalls** | 1020 + 29 × 1730 = **51.2 s** | **no, by 3.4×** |

So the loop stops **while a whole worst-case component still fits**: `elapsed + WORST_CASE_COMPONENT_MS > budget`. A plain `elapsed > budget` would also be safe — `HOLD_MARGIN_MS` covers one overrun — but then the read could not promise that its elapsed time stays inside its own budget, and that promise is what the check asserts.

`FREEZE_FRAME_READ_BUDGET_MS = MAX_HOLD_MS − 3000`, derived from the cap it protects so raising one moves the other. Two relationships are asserted, and they are independent: a component starting at the deadline finishes inside the hold (`margin > worst`), and the budget is big enough to be a budget (`budget ≥ 4 × worst`) — a margin of 10 000 ms passes the first and fails the second.

Past it, the read completes as `budget-spent`, keeps everything already read, and says _"read 6 of 29 components before the 12 s budget ran out"_.

### What the `0x18` list is filtered for, and why before anything is asked

`decodeStoredDtcList` returns a full **16-bit** code and deliberately keeps `(0, 0)` padding — _"a padding record and a real record for component 0 are the same three bytes"_. `encodeRequestPayload` **throws** on a component outside 1…63, that throw rejects the read's promise, and `read-runner.ts` turns it into one error string. **One garbled record would discard every component already read.** So `selectComponentsToRead` drops them first, counts what it dropped, and never asks.

**⚠️ Padding and out-of-range are counted apart even though `(0, 0)` is both.** The store's "was this list empty, or garbled?" rule turns on the difference — see below.

Duplicates are dropped too: `0x17` carries no symptom, so a component named twice returns the same record twice — two store entries for one component and a component's worth of budget spent on nothing.

### The component echo

Every VCU reply lands on `0x7E0` with no request tag, so an answer to somebody else's question is a thing that happens here. `toStoredReply` now decodes a positive reply and requires the echo to match before filing it as an answer. At two components (the lifetime read) that was a small exposure; at ~30 sequential requests it is not, and the count it produces feeds a store rule that decides whether a good file is replaced.

`57 00` **is** an answer — the VCU saying it has no record for that component. Counting it as a failure would make a wholly successful read look partial and could block a store that should happen.

### ⚠️ `0x78` responsePending is a known gap

`src/diagnostics/freeze-frame.ts` says it plainly: NRC `0x78` is a **wait**, not a refusal — "ask again shortly". `toStoredReply` files it as a refusal and `shouldRetry` does not retry any `reply`. That is pre-existing, and this read multiplies the exposure from 2 requests to ~30 on a micro whose session is re-opened every 1.5 s.

It is **not** fixed here: retrying it means changing the transport's reply-window semantics on a shipped path, over a code path no capture in this repo has ever exercised. The cost of not retrying is **one wasted exchange per component, not a stall**, so the budget above is unaffected — the component is simply recorded as refused.

**⚠️ It interacts with the store's `degraded` rule below.** A component that is permanently listed and permanently refused sits in `degraded` for ever and freezes the live file, including good readings of the other components. The direction is the conservative one and every run is archived, but the two gaps are the same defect seen from two ends. The way out, if it ever bites, is per-component storage — each component with its own `readAt`, which dissolves the freeze and the merge problem together. Not built on a maybe.

## The store

`src/vcu/freeze-frame-store.ts`. **It stores the payload bytes, not the decoded rows** — `lifetime-store.ts`'s rule and its reason: the decode is partly an inference, this repo has already changed its mind about one field's scaling, and rendered numbers in a file are numbers nobody re-examines.

**The clobber rule is per component, not a count.** `lifetime-store.ts` compares how many of its two components answered, which is right when the question is always the same two. Here the **list is the bike's answer and can legitimately shrink** — clear the codes and five becomes two — so comparing counts across two different sets of components would be arithmetic between two different questions.

```
degraded = components the PREVIOUS file answered
           that this read does NOT answer
           and that are still on THIS read's list

store iff  (something answered, or the list was genuinely empty)
           and degraded is empty
```

| run | outcome |
| --- | --- |
| 5 listed, 1 answered, over a file holding 5 of 5 | **refused** — four still-listed components would be lost |
| list shrank to 2 after a clear, both answered | **stored** — the bike says the others are gone |
| `budget-spent` that never reached a component the file holds | **refused** — it is still listed |
| every component refused | **refused** — `7F 17 31` carries bytes and is not an answer |
| `0x18` listed nothing, cleanly | **stored** — the bike saying "nothing is stored" |
| `0x18` list where every record was illegal, or arrived short | **refused** — a garbled list is not an empty one |
| `no-list` (the `0x18` itself failed) | **never stored** — nothing to judge a loss against |

The last two are why padding and out-of-range are counted apart: writing "nothing is stored" from a list this code could not read would turn a transport fault into a confident claim about the motorcycle.

Every run is archived whatever the rule decides — `snapshot-store.ts` rule 1. Rule 5 without rule 1 is how a reading that cost a service stop ends up in terminal scrollback only.

## Showing the values

`public/views/recorded-values.js`, under an opened code line. **Four states**, because they are four different claims:

1. **nothing read on this Pi** — says nothing about the bike
2. **read, and the VCU's list did not name this component**
3. **read, the VCU listed it and answered `57 00`** — it has no record to give
4. **read, and here is what it recorded**

State 3 reaches the view as `kind: "unrecognised"` with **no failure**: `57 00` is two bytes, shorter than the 5-byte header, so the decoder rightly cannot read it as a frame. `isNoStoredRecordReply` is a predicate beside the decoder rather than a sixth member of its union, and it matches **exactly two bytes** — a reply of five or more whose `recordCount` is zero is a different and more interesting claim (a bike answering 0 there is telling us the header reading is wrong), and folding it in would delete that signal.

### "Cycles since stored"

The trailing byte, surfaced as `cyclesSinceStored`. Null — not 0 — whenever it cannot be placed: an unknown shortlist leaves the whole body trailing, a truncated frame ends mid-field, and two or more trailing bytes mean a field is missing from the shortlist. In each of those the last byte is still readable and would still be a number, which is exactly why it is null instead.

⚠️ The screen says _"a cycle is a key-off/key-on or a VCU reset"_ and not "key cycles". The read that settled this counter spanned **both** and moved by +1, not +2, so which of the two it counts is unresolved. It is also **not** an OBD aging counter: those count fault-free cycles and reset on recurrence, and `P0A07` is permanently present on this bike while its byte climbs.

### The bounds gate, and the two things it got wrong first

Values go through `boundsForInfokey` / `infokeyFault` in `public/lib/bounds.js`. A rejected value is drawn as a **fault** — never clamped, never dropped.

Two findings, both measured by replaying all 34 committed replies (211 field slots) through the production decoder and the production gate:

**⚠️ `BY_UNIT["mV"]` is `[0, 5000]` because it was written for cell voltages, and it rejects a healthy 12 V rail.** `P_V12` reads 12 720 mV on components 36 and 37 and 12 736 mV on 48; `P_12VLP` reads 9 028 mV on 48. Four of 211 slots, all four correct readings. the repo already had the answer — `psu_12v_mv` declares `[0, 20_000]` of its own for exactly this reason (`src/can/registry.ts`, and docs/signal-bounds.md for why) — so `INFOKEY_ALIAS` points the three rail fields at the signal keys that already describe them rather than inventing a second set of numbers.

**⚠️ A field whose scaling this repo refuses must not be bounds-checked.** `AvgDOD`'s equation is malformed (`f(x)=x@&255`) and `TotalExchangedAh`'s gives an impossible result, so both are shown raw, with the reason, claiming no unit — that **is** the fault rendering. Gating a deliberately unscaled number against the scaled unit's range produces a second, wrong complaint about the same field: `AvgDOD` reads 25 658 against a "%" range of 0…100 and is not out of range, it is unscaled. The rule is enforced by `infokeyFault`'s **signature**, which is handed no `raw` to gate.

With both: **0 of 211 captured field slots are drawn as a fault.** 103 of the 207 valued slots have no bound at all — blank-unit status words, ADC counts, `rpm`, `km`, `Ah` — and are shown ungated, which is what the dashboard already does with `odometer_km`.

**⚠️ The eight `ai_*Current_In` accessory drivers get one named bound of their own**, `[0, 60_000]`, rather than an alias to `psu_12v_load_ma` whose reasoning is about the DC-DC converter's capacity. Its only job is the `uint16_t` sentinel: all eight are u16 and `BY_UNIT["mA"]` is `[-100_000, 100_000]`, so that rule **cannot reject any value the field can hold** — a field-width bound wearing a physical limit's clothes. It is deliberately not a tight band: `ai_WaterPumpCurrent_In` reading 0 mA _is_ `P0A07`, and a short-circuit code is a genuinely high reading, so a band drawn round normal current would flag the very measurements these codes exist to show.

**⚠️ `RealSpd_x10` is left ungated, and this is a landmine note rather than a decision.** `"km/h"` is not in `BY_UNIT`, so it is already ungated. But the field declares `km/h` while its name says it is ten times that and Energica states no equation — so whoever adds a `km/h` rule must not let this field inherit it, or every reading above 30 km/h is drawn as a fault.

### Three captured numbers nobody can explain, and two fields left on a loose rule

**`P_V12` spans 1296…12 736 mV** across the captures — 1296 on components 34 and 39, 12 720/12 736 on 36, 37 and 48. Both pass the aliased bound, so nothing here flags either.

**`WaterPump_ModuleSts` reads −4** in the component-44 record and renders as an ordinary number beside seven healthy ones. Every other `*_ModuleSts` in the captures reads 0 or 1. Its unit is blank, so it is ungated — correctly, since a status word has no physical range — but −4 is the sort of number that is either a signed enumeration nobody has decoded or a field boundary that is off by one.

**`uC_saferty_low_level_Sts` reads 65535** and is ungated for the same reason. ⚠️ So _"a `0xFFFF` sentinel is drawn as a fault"_ is true of **unit-bearing fields only**. A blank-unit field has no bound this repo can justify, and inventing one that rejects `0xFFFF` would also reject a legitimate all-ones status word.

**⚠️ `B_MIN_CELL`, `B_MAX_CELL` and `B_AVG_CELL` keep `BY_UNIT["mV"]`'s `[0, 5000]`, not this repo's own cell band `[1000, 5000]`.** They do not match `CELL_VOLTAGE_PATTERN`, so they fall through rather than being aliased — and that is a decision rather than an oversight: `B_MIN_CELL` and `B_MAX_CELL` read **0 mV** in captures whose `B_PACK_V` also reads 0, i.e. a sleeping BMS, and aliasing them to the cell band would draw those as faults. Worth saying out loud that the headline "0 of 211" depends on it.

**⚠️ `worstCaseMultiFrameReadMs` omits `requestFlowControlTimeoutMs`.** Correct today: both `0x17` (3 payload bytes) and `0x18` (4) are single-frame REQUESTS, so `multiframe-transfer.ts` never arms that timer. But #231 landed multi-frame request assembly and the function's name promises a general worst case, so a future caller sending a segmented request must add it rather than assume this number covers them.

**⚠️ `archive()` writes one `freeze-frames-<stamp>.json` per run and prunes nothing**, on a Pi whose SD card is the one part that fails. Inherited from `lifetime-store.ts` deliberately — rule 1, every run leaves a trace — and the files are small, but nothing deletes them.

## Expected faults

`src/vcu/expected-faults.ts`, `vcu-params/expected-faults.json` on the Pi. **Data, not a list in the repo**: which faults are expected is a fact about one motorcycle and about what its owner has done to it — today, the "turn all lights off" feature and a water pump hardwired to the heated-grip output so the VCU's pump driver reads open. Another Eva Ribelle running this software has a different list.

Keyed on `(component, symptom)` and never on the OBD code, because the OBD column is not unique — `U0182` is both (39,3) and (40,3).

**⚠️ Seeded with nothing, and that is not laziness.** Issue #226 names today's five as B1001/B1003/B1010/B1013/P0A06 — all symptom **1**, _short_ circuit. The freeze frames captured off this bike hold the symptom **0** variants: `B1000` position lights _open_ circuit with `ai_PosLightsCurrent_In = 0 mA`, `B1009` low beam _open_ circuit with `ai_BeamCurrent_In = 0 mA`, `P0A07` with `ai_WaterPumpCurrent_In = 0 mA` and the three IGBT legs agreeing at 34.9 °C. Lights switched off draw no current, which is an **open** circuit. A seeded list would have muted the wrong five and left the right five looking new.

### ⚠️ "Renders MUTED" was a no-op, so the treatment is not a colour

All five codes named in the issue have `illuminatesMil: false`, and `faults.js` already renders a lamp-free code in `colors.MUTED`. Muting them changes nothing on screen for exactly the set it was written for — and muting a code whose lamp bit is `true`, or `null`, would destroy the three-way distinction `milText` and `rank`'s own comment keep on purpose.

So the colour is left entirely alone, and the treatment differs per list because the lists differ:

- **Active list (the fault cards).** Expected sorts **last**. A handful of cards, no truncation, so a code the owner has not marked becomes the first card — the whole ask.
- **Stored list (41 codes).** **No re-ranking.** Position kept, `· expected` tag added, count in the section label. It sits behind a six-row preview (`STORED_PREVIEW_LIMIT`), so sorting five expected codes last would push all five out of the default view — hiding them — and demoting them below ~36 unlisted peers in a history that only grows would bury them without surfacing anything.

The hero number keeps counting **every** active fault; the split goes in its caption, and each count names the population it belongs to.

**⚠️ Which list Daniel meant is unresolved.** The issue quotes him under _"SET IN THE BIKE'S HISTORY"_, which is the stored list's own label, while _"all faults now are expected"_ reads like the active one. The mark applies to both, which is why this paragraph exists rather than a guess.

## Verification

`scripts/check-freeze-frame-values.ts`, in `npm test`. No bike and no `can0`: a simulated A8 answers the frames and the committed captures are what it serves.

Mutations are run against it one at a time, each reverted before the next, each judged on **exit code**. Every one turns the suite red — including dropping either bounds alias, deleting the deadline check, replacing the lookahead predicate with a plain `elapsed > budget`, back-dating the deadline's clock, counting bytes instead of readings, skipping the component echo, storing a `budget-spent` run unconditionally, treating a garbled list as an empty one, failing to filter or dedupe the `0x18` list, removing any of the three list-damage tells, un-serialising the expected-fault writes, and understating the per-component worst case.

**⚠️ Five mutations survived at some point and every one was a real gap**, which is the reason to keep writing them down:

- §6 was gating with a copy of the rule rather than the shipped `infokeyFault`.
- nothing in §4 made `answeredCount` load-bearing — no fixture carried bytes _and_ a failure.
- nothing pinned `WORST_CASE_COMPONENT_MS` to the transport: §2's injected clock advances by that same constant and §8's threshold is a multiple of it, so understating it just made the simulated bike proportionally faster and no count moved. §8 now asserts the **terms** — 310 + 2 × 710 = 1730 — rather than a ratio.
- `completion: "cancelled"` was the one member of a closed union nothing exercised, on the path the gate watchdog uses.
- the flow-control assertion matched _"no flow control was needed"_, so discarding the accumulator passed it. It now asserts the value rather than the words.

**⚠️ The `P_I12` alias cannot be killed by a captured reply** — every `mA` infokey is a `uint16_t` and `BY_UNIT["mA"]` rejects nothing one can hold, which is the whole argument for the alias. It is killed by a **constructed** payload instead: component 62's real reply with `P_I12` overwritten to `FF FF`, labelled as constructed wherever it appears.

**⚠️ The deadline's clock is injectable, and that is a bypass as much as a seam** — a `now` that does not advance defeats the deadline entirely. §2b greps `src/` and asserts no shipping call site passes one, the same guard and the same reasoning as `check-arming.ts` §7. It exists because no double in this repo can burn a worst-case component (replies come back in ~2 ms), so walking the real clock would make the count depend on how loaded the laptop is.

**The first live read has not happened.** Everything above is a laptop replaying bytes this bike sent in August and September 2026.
