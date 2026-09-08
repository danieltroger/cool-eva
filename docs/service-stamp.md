# The last-service stamp

What A8 holds as "when this motorcycle was last serviced", how it is read, and what it said the first time anything asked.

Related: `docs/vcu-parameters.md` §16 (the write audit journal), §4 (why the table-type gate does not apply to this read), and — outside this repository — `obd-garage/SERVICE_RESET.md` §2 and §3, which is where the addresses and the encoding come from.

## 1. What the block is

Four bank-1 WORDs on the A8 (the Safety micro), decompiled from the manufacturer's service tool — `ControlMotorbikeOverview_AvailableActions.GetMotorbikeService()`:

| field          | index | identifier |
| -------------- | ----- | ---------- |
| `dateLow`      | 1000  | `0x13E8`   |
| `dateHigh`     | 1001  | `0x13E9`   |
| `odometerLow`  | 1002  | `0x13EA`   |
| `odometerHigh` | 1003  | `0x13EB`   |

The halves are little-endian **across the pair** — `value = (high << 16) | low`, per the decompiled `num = (date2 << 16) | date1`. The date is a 32-bit count of **seconds since 2000-01-01 UTC**; the odometer is a plain 32-bit count whose unit is per market (km on a European bike, miles on a USA one).

⚠️ These sit **outside** `params.ecf`'s 1…277, so nothing in `src/vcu/param-table.ts` describes them and nothing ever will — that file's contents _are_ the name table. They are named in `src/vcu/service-actions.ts` instead, with their provenance, rather than smuggled into a table that claims a different source. The sweep does not reach them and is not supposed to.

## 2. The first read — 2026-09-08

Daniel pressed "📖 Read the last-service stamp" twice, at **14:17:06 and 14:17:16 CEST** (audit records at `at: 1788869826358` and `1788869836774`). Both took the 200 path. **A8 answered all four identifiers, each with 2 bytes, all zero.**

The journal recorded, for both:

```
status  "read"
before  "2000-01-01T00:00:00.000Z"     ← dateSeconds 0, rendered as the epoch
after   0                              ← the odometer
note    "reads zero — no service point has ever been set on this bike, or A8 answered
         with an empty cell"
```

### What that establishes

- **The identifiers exist on A8 and answer.** Four _positive_ responses, of the width the decode assumes. The branch `SERVICE_RESET.md` §2 warns about — a negative response, which the manufacturer's own tool treats as "this motorcycle does not have the feature" — did not happen. Everything this repo had said about these four ids until that afternoon was an expectation; it is now an observation.
- **The value is zero**, which reads as _no service point has ever been set on this bike_.

### What it does not establish

- **A zero cell and a never-written cell are the same bytes.** The reading cannot separate "nobody has ever stamped this bike" from "A8 keeps this block somewhere the read does not reach and answers zero". The `note` says both, in that order, on purpose.
- **Nothing has watched the block change.** `31 FC` Set Service Point has never been run from here, so the write half of this story is still entirely inferred — including the claim that the routine writes _these_ four cells.
- **km or miles is untested.** The odometer decoded to 0, which is the one value that reads the same in both units.

## 3. Why the raw WORDs are now kept, and shown

The journal records the **decoded** stamp — `before` is the ISO date, `after` is the odometer. So on the day these identifiers were first read, the bytes behind the reading were written down **nowhere**: not in the journal, not on the page. `result.stamp` came back in the POST's own response body carrying all four raw words, and nothing in `public/` read it.

Two changes, from issue #154:

1. **The audit record carries `rawHex`** — `13E8=0000 13E9=0000 13EA=0000 13EB=0000`, built from `SERVICE_STAMP_IDENTIFIERS` so the identifiers are written down once. It is in the file, not on the screen: `JournalLine` does not render `rawHex`, and making it visible is a separate decision.
2. **The dashboard shows the words at the control**, under the button that asked for them (`public/lib/service-stamp.js`).

The general rule this is an instance of: a decoded value is an interpretation, and an interpretation whose input has been thrown away cannot be re-checked when the decode turns out to be wrong. This project has already paid for that once — a date-decode bug stamped 49 772 rows of this bike's log as the year 2060.

## 4. Why the answer had to move

The read worked on the first press. Nothing visible changed, and the report was _"it doesn't seem to change anything"_.

The outcome sentence went to a `message` signal, whose only home on a sheet that has controls is `Outcome()` — **three sections above** the button, inside an `overflow-y: auto` sheet. (Its other home renders only when there are no controls at all; getting that pair wrong later cost this PR a blocking review finding, and `docs/dashboard-decisions.md` §"Reading the outcome" is where the corrected version lives.) It was also set as a bare `.action-note` — the same 11.52 px as the static line describing what the button does — so the answer was 600 px away _and_ the quietest type on the screen. Why an answer belongs between the control and its prose, and what `.caution` does and does not buy: `docs/dashboard-decisions.md` §"Where an ANSWER goes".

Below it, the journal showed `read-service-stamp · read` under a heading reading **"Recently written"**, in UTC — two hours off the clock of the person standing at the bike.

The fix and the argument for where an outcome belongs are in `docs/dashboard-decisions.md` §"Reading the outcome — `send()` and `performWrite()`". The journal's heading and its timezone are **not** fixed here: both are wrong for every action on the sheet, not just this one, and they belong to the follow-up that moves the other five controls' outcomes.

## 5. Reading it again

The button is outside the irreversible fold because it changes nothing, and it is the action you want _before_ Set Service Point — which stamps the bike's own clock and odometer over whatever this one showed you.

It costs a KWP session on A8 and no SecurityAccess. It is exempt from the table-type gate, and `docs/vcu-parameters.md` §4 argues why: the gate exists for parameters addressed **by index**, and this read addresses identifiers that no parameter table describes.

⚠️ **It is not a logged signal, and should not become one** — `docs/vcu-parameters.md` §13. A poll means requests on the bus while the bike is being ridden, the value moves about once a year, and the audit journal is a better record than a signal row would be.
