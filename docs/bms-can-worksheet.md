# CAN-broadcasts worksheet for your own configuration

Use [bundle 1's compatibility gate, hazards and before/after checks](bms-config.md) first. This worksheet adds only the six diagnostic broadcasts to a verified, unclamped source configuration. It preserves the rider's ordinary calibration, OEM frames, postprocessors, SUBC and LMU settings. In the original-stock model it changes 115 stored fields within TX rows 10–15. It is not a whole-file transplant or a live validation of another bike.

Rows 10–15 must be free, and a 60-second passive capture with the BMS awake must show all six IDs absent. Stop for existing custom temperature processing, conflicting IDs/slots, unknown source mappings or a different/unverified layout. The app assumes eleven LMUs, eight cells on 1–4 and seven on 5–11, BAT1 disabled on 6/8 and BAT2 disabled on all. Per-LMU data needs BMS ≥ v6.11 and the verified memory map.

## Frame display values

All six are **standard 11-bit IDs**. Keep **“29 bit ID” unticked**, Checksum **None**, and Enabled ticked. IDs are **hexadecimal without `0x`**, intervals are **milliseconds**. Confirm your existing row 1 displays ID `200` and interval `50 ms` before using these conventions. Leave all other rows untouched. Descriptions are metadata.

| TX row | Enabled | ID (hex) | Interval (ms) | DLC | Description            |
| ------ | ------- | -------- | ------------- | --- | ---------------------- |
| 10     | yes     | 660      | 1000          | 3   | Pack thermal summary   |
| 11     | yes     | 661      | 1000          | 6   | Energy and uptime      |
| 12     | yes     | 662      | 50            | 8   | LMU cells 1-3          |
| 13     | yes     | 663      | 150           | 8   | LMU cells 4-6          |
| 14     | yes     | 664      | 250           | 8   | LMU cells 7-8 + temps  |
| 15     | yes     | 665      | 1000          | 8   | Configured cell limits |

## Signal display values

Confirm the exact captions on your own Signals dialog: the public presentation does not show it. The values below use the observed columns Enabled, Start bit, Bit count, Data type, Data identifier, Bit offset and Intel format. All listed signals are **enabled**, **Bit offset = 0**, **Intel format unticked**. Data identifiers are plain memory numbers or your own constants, not packed stored integers. Leave every unlisted/unused signal row as found, including sentinel rows; do not “normalize” them into enabled signals.

| ID (hex) | Signal row | Start bit | Bit count | Data type | Data identifier               |
| -------- | ---------- | --------- | --------- | --------- | ----------------------------- |
| 660      | 1          | 0         | 8         | Direct    | 2026                          |
| 660      | 2          | 8         | 8         | Direct    | 2027                          |
| 660      | 3          | 16        | 8         | Direct    | 2123                          |
| 661      | 1          | 0         | 24        | Direct    | 2150                          |
| 661      | 2          | 24        | 24        | Direct    | 2040                          |
| 662      | 1          | 0         | 8         | Direct    | 2129                          |
| 662      | 2          | 8         | 16        | Direct    | 2130                          |
| 662      | 3          | 24        | 16        | Direct    | 2132                          |
| 662      | 4          | 40        | 16        | Direct    | 2134                          |
| 663      | 1          | 0         | 8         | Direct    | 2129                          |
| 663      | 2          | 8         | 16        | Direct    | 2136                          |
| 663      | 3          | 24        | 16        | Direct    | 2138                          |
| 663      | 4          | 40        | 16        | Direct    | 2140                          |
| 664      | 1          | 0         | 8         | Direct    | 2129                          |
| 664      | 2          | 8         | 16        | Direct    | 2142                          |
| 664      | 3          | 24        | 16        | Direct    | 2144                          |
| 664      | 4          | 40        | 8         | Direct    | 2148                          |
| 664      | 5          | 48        | 8         | Direct    | 2146                          |
| 664      | 6          | 56        | 8         | Direct    | 2147                          |
| 665      | 1          | 0         | 16        | Constant  | your Cell under voltage       |
| 665      | 2          | 16        | 16        | Constant  | your Cell end of life voltage |
| 665      | 3          | 32        | 16        | Constant  | your Cell over voltage        |
| 665      | 4          | 48        | 16        | Constant  | your Cell target voltage      |

Take those four numeric constants, in mV, from **your effective Global cell settings after any selected calibration overrides**. They are literal values: changing a BMS limit later does not automatically update `0x665`. Never substitute Daniel's limits for a telemetry-only selection.

`660` reports highest/lowest-temperature LMU indices and average pack temperature. `661` reports remaining energy and uptime. `662/663/664` carry one LMU's cells 1–3, 4–6 and 7–8 plus temperatures, with that frame's own module index. The 150/250 ms intervals break a previously observed phase lock that missed modules; that history does not prove coverage on your bike. Verify every module in each frame. Disabled cell/sensor positions remain absent/sentinel, not useful readings.

Keep `CUSTOM_BMS_CONFIG` **unset** for this short, unclamped form. Confirm cool-eva's short-frame routing message after the write. The long `660` and its extra signals belong to [the inseparable clamp bundle](bms-config.md#choose-whole-bundles-for-your-own-configuration); do not install the clamp without them and the flag. The `0x202` P32B stamp belongs to the calibration bundle and is never included here.

Use the guide's complete [read-back and bus checklist](bms-config.md#write-read-back-and-roll-back): six correct DLCs/rates, your own four literals, every LMU on each per-cell frame, unchanged OEM traffic and no new fault bits. Unexpected results mean restore your own original and verify again.
