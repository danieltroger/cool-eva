# Freeze-frame field audit — 2026-11-09

All 120 declared field names, datatypes, equations and units agree with the existing application table after repairing the newer dictionary's broken degree sign from the older dictionary. This audit found **no proven application decode error**. It changes no decoder, bounds, wire shape or UI.

In particular, `P_V12` is already in **mV**, with no multiplier. The recorded `1296 mV` in B1012 remains `1296 mV`. A voltage collapse during power-down is a plausible explanation, not something these stored bytes alone prove. An unusual fault-time measurement is not a dead sensor merely because it is outside normal running conditions.

## Sources opened

These primary manufacturer definitions from the locally held manuals archive were opened and compared directly.

| Source | Material actually read                                 |
| ------ | ------------------------------------------------------ |
| A      | The manufacturer's 2021 field dictionary, all 120 rows |
| B      | The manufacturer's 2024 field dictionary, all 120 rows |
| C      | The manufacturer's 2024 scaling rules for these fields |

B contains `�C` (U+FFFD followed by C) for exactly 11 temperature units: ids 5, 8, 9, 11, 32, 41, 42, 61, 62, 63 and 84. A spells these `°C`; that is the only normalization in the comparison.

A's header and voltage row, quoted from the opened dictionary:

```csv
id,name,unit,equation,datatype
3,P_V12,mV,,uint16_t
```

B's corresponding definition, quoted from the opened dictionary:

```json
{ "id": 3, "name": "P_V12", "datatype": "uint16_t", "equation": "", "unit": "mV" }
```

C's scaling rules use the declared datatype, apply a nonempty equation and retain the stated unit. They specify no additional rail multiplier. All three sources agree that `P_V12` is mV with no scale.

## All-field comparison

[`manufacturer-infokey-audit.ts`](../scripts/manufacturer-infokey-audit.ts) is a snapshot taken from A, independent of the application's table. Each tuple is `[id, name, datatype, unit, equation]`. All 120 entries were compared with B and with `INFOKEY_TABLE`; the registered check verifies that comparison.

| Declared equation | Fields | Existing behavior                                      |
| ----------------- | -----: | ------------------------------------------------------ |
| empty             |     98 | Identity                                               |
| `f(x)=x*0.1`      |     18 | Multiply by 0.1, except the existing refusal for id 80 |
| `f(x)=x*0.05625`  |      2 | Wheel speeds, multiply by 0.05625                      |
| `(X/2)-40`        |      1 | Air temperature, divide by 2 then subtract 40          |
| `f(x)=x@&255`     |      1 | Existing malformed-equation refusal for id 86          |

The declared datatypes are 34 `uint8_t`, 4 `int8_t`, 54 `uint16_t`, 26 `int16_t` and 2 `uint32_t`. Names, signedness, widths, equations and units match for every entry.

Two existing uncertainties remain explicit:

- `TotalExchangedAh` (80) declares `×0.1`, but the application's established refusal retains raw counts because that scale disagrees with independently logged pack throughput. This audit supplies no proven replacement. See [lifetime battery statistics](lifetime-battery-statistics.md).
- `AvgDOD` (86) declares the malformed expression shown above; it remains raw rather than receiving a guessed correction.

`RealSpd_x10` (106) declares an empty equation and `km/h` in both editions. Its name alone does not prove a divide-by-ten conversion. The captured value is zero, so the captures cannot settle its nonzero resolution. The declared identity conversion remains unchanged.

## Recorded replies and bounds

`check-freeze-frame-field-audit.ts` replays the 29 existing August replies and five September replies: **34 replies, 33 records, 211 field slots, 65 distinct infokeys**, across all five datatypes. The remaining reply is the actual `57 00` no-record answer. The other **55 fields have dictionary verification only**; this is not a claim to have captured every field or proven every possible fault-time value.

The check pins recorded raw and scaled values, including:

| Recorded field                    |             Raw | Expected interpretation                        |
| --------------------------------- | --------------: | ---------------------------------------------- |
| B1012, `P_V12`                    |            1296 | 1296 mV; cycle age 23                          |
| B1004/B1006, `P_V12`              |           12720 | 12720 mV                                       |
| P1045, `P_V12` / `P_12VLP`        |    12736 / 9028 | 12736 / 9028 mV                                |
| U0121, `P_V12`                    |            1732 | 1732 mV                                        |
| P1004, `B_PACK_I`                 |            −883 | −88.3 A                                        |
| P0514, `B_PACK_V`                 |            2959 | 295.9 V                                        |
| P0A07, `D_IGBTA_T` / `V_AIR_TEMP` |       349 / 137 | 34.9 / 28.5 °C                                 |
| August / September, `V_ODOMETER`  | 174729 / 184405 | 17472.9 / 18440.5 km                           |
| Safety status words 87 and 88     |           65535 | Valid unitless words, not a universal sentinel |

The real low rails, a zero pack voltage and a negative module status stay visible as values. Bounds are not tightened around normal operation. Existing aliases preserve the rail-specific range instead of applying the cell-voltage mV range to a 12 V supply.

Separate **constructed corruptions** of copied replies check `0xFFFF` current and rail readings, and a −242 °C dead-temperature value. They must render as faults without clamping. These are labelled test mutations, not claims that the original recordings contained those readings. The original captured bytes are unchanged. The two existing scaling refusals are also exercised on both dates and retain their raw numbers.

The two wheel-speed equations have source-based arithmetic examples, explicitly separate from recorded evidence. No live bike read, write or deployment was needed for this audit.
