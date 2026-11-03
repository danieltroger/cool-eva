# Daniel's personal BMS configuration

**Do not flash the whole file unless your installed cells, LMU/cell layout, enabled temperature sensors, BMS version and configuration-tool version are known to match. If anything required is unknown, keep your own configuration.** This is Daniel's personal configuration for an **81s2p P32B, 64 Ah pack**, not a recommendation for another rider. Matching the cell model is necessary, not sufficient. The original 54 Ah pack must not take this whole file.

The unchanged hardware assumptions matter as much as the changed settings:

| Requirement | This file and cool-eva expect |
| --- | --- |
| Series layout | 81 positions across eleven LMUs: eight on LMUs 1–4, seven on LMUs 5–11 |
| Battery temperature sensors | `BattTemp1Enabled=False` on LMUs 6 and 8; `BattTemp2Enabled=False` on all eleven |
| Recorded BMS version | BMS firmware v6.12, from the prior 2026-08-04 error-log report; not a new device read |
| Configuration tool | Version 6.18.0, confirmed by Daniel |
| Per-LMU broadcasts | Require BMS ≥ v6.11 and a verified compatible memory map/tool |
| Clamp assumption | The VCU does not enter battery-temperature limp below the 55 °C release. Daniel reports no known Energica VCU does; a known contrary threshold is a no-go. |

Loading the whole file also loads its cell/sensor layout. cool-eva hard-codes the eleven-module 8/7 layout and absent BAT1 sensors on 6/8; it does not adapt those views to another pack. A known mismatch stops this guide's selective worksheet too. Do not alter the rider's layout or sensor enables to fit the template. A tool's permitted input range does not prove cell compatibility.

## Read these hazards before downloading or writing

Keep your own saved configuration for rollback. Read the device before editing, read it back after writing, and restore your own original if the read-back or bus checks below fail.

| Change | Hazard or limitation |
| --- | --- |
| Target/overvoltage 4250/4300 mV; minimum/end-of-life/low-warning 2900/2000/2700 mV | These values can damage incompatible cells and create a **fire risk**. Daniel's lower values are 300/500/300 mV below the bike maker's P32B values. Matching cells alone does not establish that these deeper limits are compatible. |
| Lower end-of-life threshold | Lowers the voltage below which the BMS refuses to charge a cell, from 2500 to 2000 mV. A deeply discharged cell between those thresholds can therefore be charged instead of refused. This weakens the BMS's own backstop. |
| Temperature reporting clamp | Hides warm-pack heating and normal warm-pack derating from the VCU and dash. The required long `0x660` is the only frame retaining the true pack high/low under this routing. |
| Later charge/regen temperature knees | Allows current later into the warm range, reducing thermal margin. Retained limits do not prove safe charging under the changed curves. |
| Raised bleed threshold | Raises when voltage-based balancing can begin. It does not establish better balance or cell health; no hysteresis/timing improvement is claimed. |
| Higher low-SOC discharge current | Raises the 0%-SOC point from 40 to 50 A, increasing load on near-empty cells. Changes to shutdown, warning and current behavior can change available propulsion or regen. |
| Isolation offsets 5/15 V | These come from the bike maker's P32B calibration. Their diagnostic consequence is **unknown** here; do not infer stronger fault detection. |
| Charger 360 V / `Exp` | Also bike-maker P32B values. Consequence on another bike/charger is **unknown**; this is not a promised charging fix. |

The internal **55 °C maximum charge / 60 °C maximum discharge** and enabled internal temperature-limit flags are retained. BMS internal calculations use real temperatures. Those settings do not undo the weaker margins above, and the clamp's upper release is not an instantaneous shutdown guarantee. Backup, read-back and rollback remain required.

### Daniel's range trade-off also depends on the VCU

Daniel knowingly accepts a risk of faster cell degradation: at his realistic riding rate he prefers added usable range over a ten-year lifespan, and plans a future S35 upgrade. His choices leave the bike maker's official P32B limits and void the bike maker's warranty. That personal choice does not establish compatibility for anyone else's cells.

**With factory VCU settings, this BMS file alone gives no extra range, yet still weakens the BMS backstop.** The VCU still limps/cuts above these BMS values. Daniel's added range also depends on VCU settings he changed separately on **2026-08-09**, including:

| VCU parameter                      | Factory | Daniel's recorded change | Unit |
| ---------------------------------- | ------- | ------------------------ | ---- |
| `CELL_UNDERVOLTAGE`, index 76      | 3000    | 2750                     | mV   |
| `CELL_UNDERVOLTAGE_WARN`, index 77 | 3200    | 3000                     | mV   |

These separate VCU edits are not in the `.bms` file or its bundles and are not recommended by this guide. The dashboard's own [VCU parameter writes](vcu-parameters.md) can make such changes; flashing this file does not make them. The values above are the recorded changes, not a new VCU read-back.

Honest context for this trade-off: Daniel's saved error report as of **2026-08-04** recorded lifetime counters of **2,664 “Cell under voltage”** and **9 “Cell end of life”** events. They may span the pack's whole life, predate the bounded variants, and do not measure degradation or establish which configuration caused an event.

### Bike maker's calibration versus cell datasheet

The comparison source is **Energica's official P32B upgrade configuration, EN.W011181**. These are the **bike maker's** limits, not values read from the cell maker's datasheet. The cell datasheet minimum remains **to be confirmed**. Do not substitute a recollection or the tool's allowed range for that evidence.

| Stored field                 | Original delivered stock | Bike maker's P32B | Daniel's file | Unit |
| ---------------------------- | ------------------------ | ----------------- | ------------- | ---- |
| `CellMinimumVoltage`         | 3300                     | 3200              | 2900          | mV   |
| `CellEndOfLifeVoltage`       | 2500                     | 2500              | 2000          | mV   |
| `WarningLevelLowCellVoltage` | 3250                     | 3000              | 2700          | mV   |
| `ChargeShapingTemp5`         | 45                       | 45                | 52            | °C   |
| `ChargeShapingTemp6`         | 50                       | 50                | 53            | °C   |
| `ChargeShapingTemp7`         | 53                       | 53                | 54            | °C   |
| `RegenShapingTemp5`          | 40                       | 40                | 45            | °C   |
| `RegenShapingTemp6`          | 45                       | 42                | 47            | °C   |
| `RegenShapingTemp7`          | 50                       | 48                | 50            | °C   |
| `RegenShapingTemp8`          | 55                       | 52                | 55            | °C   |
| `RegenShapingCurrent7`       | 60                       | 40                | 60            | A    |

Relative to the bike maker's P32B calibration, Daniel moves regen points 7/8 from 48/52 to 50/55 °C and point 7's allowance from 40 to 60 A. The last three rows equal original delivered stock, so they would not appear in a stock-only diff. Point 7's current is not point 8's current.

## File, status and clamp behavior

### Flash status

**Status: to be flashed.** Keep this status until Daniel confirms both writing 17 and reading it back. [Download `17-bounded-clamp-33.bms`](../bms/17-bounded-clamp-33.bms), 223,920 bytes.

```text
SHA-256  97c92f9578a6eab742b7a301bce12e22fdaa8ff4afdbd2666ff02da4b0062193
```

### Clamp behavior

| Clamp setting              | Selected value |
| -------------------------- | -------------- |
| Reported-temperature floor | **33 °C**      |
| True-high release          | **55 °C**      |

The floor uses the bike's observed charging as context: [75 A was held on 2026-09-12 and 2026-09-13](dc-taper.md) while the VCU saw pack temperatures of **29–35 °C**. **75 A is the configured ceiling**, as described in the [charge-current documentation](can-decode-findings.md#0x121--the-riders-own-charge-current-limit). These observations do not guarantee current from a charger at one particular reported temperature.

Below the release, each reported temperature is the lesser of its true value and the floor in the table. At/above the release, both true temperatures pass through. The operations use wrapping-byte arithmetic and unsigned, truncating Divide; this describes the configuration, not a live test of 17. Only `Postprocessor_Frame_4_Operand_2` and `Postprocessor_Frame_9_Operand_2` change relative to 15. Both use that one floor setting; the 55 °C release is unchanged.

`0x200` b0/b3 and `0x206` b7 carry the reported VCU/dash view. In the required long `0x660`, b3/b4 retain true high/low, b5 is the 255/0 gate, b6 is the **pre-gate amount**, and b7 is the reported-high echo:

```text
echo = true high - (pre-gate amount & gate)
```

A nonzero b6 after release does not mean subtraction continues. Operation 3 is disabled in stock and 17 despite its changed operand/byte count; operations 4–20 are enabled. See the [complete per-field appendix](bms-config-diff.md).

The previous 15 configuration has archive behavior consistent with being live since **2026-08-09**, not a byte-identical device read-back. From that date through 2026-09-19, true pack high reached at least 55 °C on **nine UTC days**, with a **57 °C peak**. The saved log-on-change archive also shows the gate opening at 55 °C and closing at 54 °C under 15. This is measured context, not a safety test or a measurement of 17.

## Choose whole bundles for your own configuration

Start from your own preserved configuration. Select only these named bundles. A prerequisite must already be independently verified in your file or selected as a complete bundle; otherwise stop. Do not silently add it or offer a version with a hard dependency removed. Exact raw rows and the calibration field set are in the [appendix](bms-config-diff.md#bundle-field-scopes); GUI values for bundle 1 are in the [CAN worksheet](bms-can-worksheet.md).

| Bundle | Scope | Evidence and hard dependencies | On mismatch; verification |
| --- | --- | --- | --- |
| **1. CAN broadcasts** | Six new diagnostic frames in TX rows 10–15; short `0x660`, DLC 3. On the verified stock source this changes 115 fields only within those rows. | Unclamped OEM temperature routing; BMS ≥ v6.11, compatible memory map/tool, matching app layout/sensors; free slots and no bus ID conflict. Derive `0x665` from your own effective four limits. | Stop for occupied rows, unknown routing/maps, existing custom temperature processing or layout mismatch. Preserve ordinary calibration, OEM frames, all postprocessors and LMU/SUBC settings. Use scope A and all bus checks below; leave `CUSTOM_BMS_CONFIG` unset. |
| **2. Bike-maker P32B calibration** | The 46 effective stock-to-P32B fields, including capacities/limits/curves, eleven bleed thresholds and the `0x202` stamp. | Actual compatible P32B pack and whole-file layout/tool gate. The stamp needs its matching 4300 mV overvoltage and 81 series count. Synchronize an existing `0x665`. | No transfer to original 54 Ah cells or an unknown/different pack. Use A+B; verify limits/curves, header and literals. |
| **3. Daniel's lower limits** | `CellMinimumVoltage=2900`, `CellEndOfLifeVoltage=2000`, `WarningLevelLowCellVoltage=2700`; synchronize existing `0x665`. | Bundle 2 selected or fully verified as present; cell compatibility evidence beyond model identity; explicit acceptance of damage/fire/degradation and warranty hazards. | Missing evidence/prerequisite: stop. With factory VCU settings this alone gives **no extra range**, while lowering the BMS backstop and its charge-refusal threshold. Daniel's range also requires his separately changed VCU settings above. Use A+C. |
| **4. Daniel's later charge/regen knees** | Charge points 5/6/7 = 52/53/54 °C; regen points 5/6/7/8 = 45/47/50/55 °C; regen point 7 = 60 A. | Bundle 2 selected or fully verified as present; cell/thermal compatibility and acceptance of later derating. Retain internal temperature-limit flags and maxima. | Unknown/incompatible thermal evidence: stop. Use A+D; verify complete curves and retained 55/60 °C settings. |
| **5. Bounded temperature clamp** | Three OEM source pointers; operations 4–20; long row-10 DLC/description and signals 4–8. | **Bundle 1 in its long `0x660` DLC-8 form with true high/low, plus `CUSTOM_BMS_CONFIG=1`, are inseparable.** Compatible source routing/free postprocessor slots and the no-limp-below-release assumption are required. | You cannot decline the long frame/flag and retain the clamp. Known earlier VCU limp, conflicting slots/routing or missing true temperatures: stop. Use A+E and long-frame checks. |

The whole personal file combines all five. Bundle counts overlap at declared overrides; they are not additive. CAN-only can retain a rider's original 54 Ah calibration when its own layout, sensors, versions and routing meet the worksheet's requirements. The `0x202` calibration stamp is **never** part of CAN-only.

The bike maker's `0x202` b0–3 stamp is `10 CC 51 03`, representing 4300/81/3. The first two match the overvoltage limit and series count; the header's consumer/consequence remains unknown. Current fields stay in b4–7. Never copy the stamp without matching limit/count. `0x665` is four **literal constants**, not live register reads: update them whenever selected calibration changes the effective limits.

## Before editing: preserve a bounded comparison

Read and save your current configuration through the write-capable **BMS configuration tool**. Keep that original unchanged. Record the cell installation evidence and versions. Capture these views before editing and the **same views after writing and reading back**, including observed labels/columns, module/frame/signal indices and units:

| Scope | Views to preserve |
| --- | --- |
| **A, common/CAN** | System/LMU cell counts and enabled sensors; complete CAN settings including existing RX/settings sections, TX rows 1–20, Signals dialogs for all occupied rows and target rows 10–15, complete postprocessor table; Global “Cell under voltage,” “Cell end of life voltage,” “Cell over voltage,” “Cell target voltage.” |
| **B, P32B** | A plus both capacities; all Global cell settings, including regulating/high-warning and retained temperature-limit enables/maxima; charger voltage/regulation, isolation offsets, trickle and full low-SOC curve, full charge/regen temperature/current curves, eleven bleed settings, frame-3 header/signals and operation 3. |
| **C, lower limits** | A plus surrounding Global cell settings and installed `0x665` constants. |
| **D, thermal knees** | A plus complete charge/regen curves, current units and retained temperature-limit enables/maxima. |
| **E, clamp** | A plus three OEM temperature pointers, full row-10 Signals dialog, operations 4–20 and app flag. |

Keep native before/candidate/read-back files too. A full effective-field comparison is required for the whole personal file. For a worksheet applied by hand, state precisely which dialog scope was verified; unseen fields are not a completed all-field comparison. Only documented non-device metadata differences, such as descriptions, can be excluded. An unexpected calibration difference is never dismissed as metadata.

Before a first CAN installation, preserve a **60-second passive raw-bus capture with the BMS awake**. All IDs `0x660`–`0x665` must be absent; also record existing `0x200`–`0x207`/`0x300`. Free configuration slots do not prove the bus IDs are unused. If any target ID exists, stop the first-install worksheet rather than overwriting an unknown sender. For an existing installation update, such as 15 → 17, first account for every existing diagnostic frame through that bike's own saved/read-back settings and matching bus signature; introduce no new ID.

## Write, read back and roll back

1. Complete the gate, hazards, original backup, matching scope captures and pre-write bus checks. If you load Daniel's file merely to inspect it, **do not press Write** while it is loaded.
2. Use the appropriate BMS serial service interface and write-capable BMS configuration tool. Review the selected candidate and target before the rider writes. Follow actual restart prompts; no pinout or unconditional reset is prescribed here. The agent never operates the GUI or live connection.
3. Read back, save separately and compare effective settings using the scopes above. Set `CUSTOM_BMS_CONFIG=1` for the clamp; keep it unset for the short CAN-only form. It declares the app's expectation, not a command to flash the BMS.
4. Preserve a comparable **60-second passive raw-bus capture** in the same operating mode. Check all of the following; use raw frames, not log-on-change row counts, for rates.
5. Any unexpected read-back or bus result: stop, write **your own preserved original**, read back again and repeat applicable bus checks. Restore the original configuration's app-flag requirement.

| After-write check | Expected result |
| --- | --- |
| Six added frames | `660/661/662/663/664/665`: DLC **3/6/8/8/8/8**; `660` is **8** with the clamp |
| Rates | Approximately **1/1/20/6.7/4/1 Hz**, respectively |
| Voltage literals | `0x665` equals your effective minimum/end-of-life/overvoltage/target values after selected overrides |
| Coverage | **Every module 1…11 in each of `0x662`, `0x663`, `0x664`**; a missing module in the bounded window fails coverage |
| Existing traffic | OEM rates/content classes retained, except selected `0x202` header or clamped temperature bytes; no new `0x201` error/warning bits. Actual sensor/current readings may change between captures. |
| CAN-only routing | Flag unset, short-frame routing message observed in cool-eva |
| Clamp routing | Flag set, true high/low from the long frame; gate only 0/255; echo identity above holds. Missing true-temperature data is a failure. |

Verify behavior only at naturally encountered temperatures. Do not heat the pack to test the release.

### Daniel's next-bike-contact and post-flash checklist

- Read/save the bike's current configuration and compare it before the write; archive behavior is not byte-level identity.
- After writing 17, read it back and compare every effective field, preserving the file and bus checks above. Only after Daniel confirms both steps, update the guide's [flash-status line](#flash-status).
- Read back the separately recorded VCU undervoltage settings; do not treat the change record as a new device read.
- **Only after Daniel confirms flashing 17:** update `CLAMP_FLOOR_C = 35` in `src/can/decode-bms.ts` and its comment to the selected floor; the floor warning uses that constant. Until then they describe the previous live variant. The current monitor's band above 35 and below 55 is a conservative subset for both bounded variants; temperature routing uses actual frame values, not a reconstructed floor.

## Copy-paste prompt for your own agent

The public configuration-tool presentation shows editable CAN tables and native Save/Load/Read/Write controls. It does not document a plain configuration import/export route; its CSV exports are logs. Screenshots/field lists and the [fixed CAN worksheet](bms-can-worksheet.md) are one input route. Optionally provide your own saved configuration and the folder of your own installed BMS configuration tool: your agent may work out how to read/write your save and return a separate candidate for you to load. Both routes retain every gate and leave writing to you.

```text
Read https://github.com/danieltroger/cool-eva/blob/main/docs/bms-config.md,
including its compatibility gate, hazards, complete diff and CAN worksheet.

My selected named bundles: [numbers/names from the guide's table].
Example: bundle 1, CAN broadcasts only, without the temperature clamp.
Apply nothing outside selected bundles and their declared synchronization
rows. A missing hard dependency stops the selection; do not silently add
it or offer a version with that dependency removed.

Start from MY bike's current configuration. Preserve my original unchanged
for rollback. First check actual installed-cell evidence, BMS/tool versions,
LMU/cell layout, enabled sensors and existing temperature routing against
the chosen bundles. Stored capacity does not prove which cells are fitted.
The whole personal file targets 81s2p P32B, 64 Ah. Matching cells alone
does not validate Daniel's deeper limits or thermal curves. Unknown or
mismatched required compatibility means stop and keep my configuration.
Never force my layout, sensors or calibration to match Daniel's template.

Route A: I provide screenshots or a field list from the specified dialogs,
with exact tab/group/column captions, module/frame/signal indices, values
and units. Use the guide's verified labels, never invented labels. Return
a GUI change sheet for me to enter and save in the tool.

Optional route B: I provide MY saved configuration and the folder of MY
own installed BMS configuration tool. You may work out how to read and
write my save and return a separate candidate for me to load with the tool.
Keep the original and installed tool intact. Verify an unchanged round trip
and compare every effective field before/after the chosen edits. If reliable
file handling cannot be established, stop this route and return route A's
worksheet. Do not operate the tool GUI, connect to the BMS or write the bike.

For every edit show MY observed old value, proposed GUI value, unit and
conversion, stored-field reference, reason and the guide's applicable hazard
text. Explain damage/fire risk, hidden heating/derating, later temperature
knees, raised bleed/low-SOC current and warranty consequences where relevant.
Keep unsupported isolation/charger effects unknown. The bike maker's limits
are not a cell datasheet. Explain that the lower BMS limits alone give no
extra range with factory VCU settings, yet weaken the backstop and lower the
voltage below which the BMS refuses charging. Daniel's range also depends
on separately changed VCU settings; do not add those edits to my selection.

For CAN-only use the worksheet, verify rows 10–15 are free, and derive
0x665 from MY effective four Global cell settings. Preserve calibration,
OEM temperature pointers and all postprocessors. Use short 0x660 DLC 3;
keep CUSTOM_BMS_CONFIG unset. Use standard 11-bit IDs, hex without prefix,
ms intervals, '29 bit ID' unticked, plain data identifiers; leave unused
rows as found. Existing custom routing stops this first-install worksheet.

The 0x202 P32B stamp belongs only to calibration bundle 2, never CAN-only;
its overvoltage limit and series count must match. Synchronize 0x665 after
any selected calibration overrides. The clamp is inseparable from long
0x660 DLC 8 carrying true temperatures and CUSTOM_BMS_CONFIG=1. It assumes
no VCU battery-temperature limp below the guide's release; a known earlier
threshold is a no-go. Never offer the clamp without its long frame or flag.

Collect scope A plus each chosen bundle's scopes BEFORE edits, and the
same views AFTER device read-back. Require the guide's pre-write passive
capture, BMS awake, IDs absent for first installation and existing frames
recorded. Conflicting slots/IDs, unknown mappings or missing evidence stop.

Return the per-field change sheet, candidate comparison if route B succeeds,
app-flag setting and exact backup/write/read-back/rollback checklist. I do
the live write. Compare effective fields after read-back or explicitly state
the verified dialog scope; never claim unseen fields were checked. Require
the after-write raw capture: each new frame's DLC/rate, my own 0x665 limits,
all modules in EACH per-cell frame, OEM traffic preserved except declared
changes, no new 0x201 faults and correct temperature routing. Do not infer
rates from log-on-change counts or heat the pack for testing. Any unexpected
result means stop, restore MY original, restore its app-flag requirement,
read back and repeat applicable bus checks.
```
