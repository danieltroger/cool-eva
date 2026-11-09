# Cells: nine-module map

The approved option C is the sole Cells screen at `#hypermile/cells`: physical battery low/high and the current BMS spread, a Temperature/Cell balance switch, one nine-module map and selected-cell detail with previous/next arrows. Every module contains nine series positions. The screen uses the existing Range/Cells header and persistent bottom navigation. There is no time selector, strip, second table, history plot or origin-specific Back control. Browser history still retains the entry origin. All's former Battery history navigation button is removed. Range's duplicate spread card becomes the approved Range at this rate card, moving the existing estimate out of the consumption caption.

## Physical modules and LMUs

An LMU is not a physical module. The existing frontend `cellVoltageLayout()` enumerates eleven LMUs, with eight cells on LMUs 1–4 and seven on 5–11. Its legacy `module` property is an LMU number; the new `packCellLayout()` names that value `lmu` and groups each consecutive nine series positions into a physical `module`.

The approved placement is `3 2 1 / 4 5 6 / 9 8 7`. Its module-to-LMU runs were read directly from the local diagnostic implementation's `MODULES`, `GRID` and `module_cells` blocks, and matched against the approved sketch's `pack-layout.mjs`. The local implementation records its placement as one 2023 21.5 kWh pack, unconfirmed by the manufacturer. The dashboard adopts the approved numbered arrangement and adds no front/rear orientation or verified disassembly claim. It is not a layout for an arbitrary replacement pack.

| Module | Series positions | LMU/local-cell runs   |
| ------ | ---------------- | --------------------- |
| M1     | 1–9              | L1 C1–8; L2 C1        |
| M2     | 10–18            | L2 C2–8; L3 C1–2      |
| M3     | 19–27            | L3 C3–8; L4 C1–3      |
| M4     | 28–36            | L4 C4–8; L5 C1–4      |
| M5     | 37–45            | L5 C5–7; L6 C1–6      |
| M6     | 46–54            | L6 C7; L7 C1–7; L8 C1 |
| M7     | 55–63            | L8 C2–7; L9 C1–3      |
| M8     | 64–72            | L9 C4–7; L10 C1–5     |
| M9     | 73–81            | L10 C6–7; L11 C1–7    |

A square retains its series position and LMU/local-cell key in both modes. Each physical module is a three-by-three square grid. Dashed shared edges distinguish adjacent different LMUs, and the start of each LMU run has its L label. M6 deliberately has three runs. A rejected or absent reading cannot move subsequent cells.

Temperature mode uses the battery sensor of each cell's LMU. LMUs 6 and 8 have no fitted battery sensor, regardless of which physical module contains their cells; those squares stay outlined. The selected LMU's two PCB temperatures remain available, and their age is taken from their own samples rather than from the battery sensor or an unrelated heartbeat. The data shape and fitted-sensor facts are also recorded in [the BMS configuration](bms-config.md) and [the CAN worksheet](bms-can-worksheet.md).

## Latest readings and quality

The map samples bounded readings through `peek()`/sampled reading-status on the existing chart pulse. It does not request historical cohorts or change the wire format. Pack low/high and spread use their own accepted aggregate signals, independently of the map's cells. BMS weakest/strongest indices are not translated into physical positions.

[Existing multiplex freshness](reading-status.md#bms-multiplex-holds) remains authoritative: a valid held reading can stay available within its measured age budget while its carrier and link remain live. Older readings use neutral ink, dashed module outlines and sampled server-clock age cues; they are never renewed by a WebSocket heartbeat. Missing, stale, faulted and not-fitted are distinct. A current physical-range rejection uses a red marker and explicit fault detail. A missing or expired reading keeps its square and an explicit selection state.

The temperature legend is the sketch's fixed 38–50 °C scale, converted only for display. It is a colour scale rather than a new warning threshold. Cell balance uses the current BMS maximum as its reference, with the sketch's 0 to −40 mV scale. A current value above that reference has zero gap, as before. An unknown reference or old sample gives neutral colour and suppresses a relative-gap claim; actual accepted selected voltage stays visible. Selecting a module in balance mode starts at its lowest current accepted cell, falling back to the module's first position when no eligible reading exists. Previous/next follows series order, stopping at positions 1 and 81.

## Retired composition

The former strip, eleven LMU value tables and ten-minute spread trace belonged to the previous Cells composition. Their signal-ordering, 0x203-summary and held-reading findings remain in [range-and-cells.md](range-and-cells.md). The current screen adds no second table or historical selector to replace them.
