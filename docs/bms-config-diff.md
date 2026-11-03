# Complete BMS configuration comparison

Read the [compatibility gate, hazards and recovery procedure](bms-config.md) before using these values. This is an authored comparison, not an import file or a set of packed numbers to type into GUI controls.

Baseline: `1-stock.bms`, identified by the source collection README as the original delivered-pack configuration; SHA-256 `ddbafbe4cc90862fba446ab48edcaefa6330a7aebd64f9ac06d107069900aaf1`. Selected file: [17-bounded-clamp-33.bms](../bms/17-bounded-clamp-33.bms), SHA-256 `97c92f9578a6eab742b7a301bce12e22fdaa8ff4afdbd2666ff02da4b0062193`. [Flash status](bms-config.md#flash-status).

**271 changed fields; 0 added; 0 removed**, over 2,978 stored fields: twenty ordinary BMCU, 153 CAN-transmit, 87 postprocessor and eleven LMU bleed thresholds. SUBC and all other LMU fields are unchanged. Of the changed rows, forty equal the bike maker's P32B calibration and 231 are Daniel's. Origin means value provenance, not compatibility or endorsement.

GUI labels below come from the tool's label bindings; missing/null labels are “unavailable.” CAN/postprocessor columns must be confirmed against the rider's observed dialogs. Explanations are ours, separate from the labels. The original stock baseline is different from the bike maker's later official P32B upgrade; [the guide compares Daniel's departures from that calibration too](bms-config.md#bike-makers-calibration-versus-cell-datasheet).

## Ordinary BMCU settings — 20 rows

| Stored field (BMCU) | Verified GUI label | Stock raw | 17 raw | Unit/scaling | Origin | Effect and hazard |
| --- | --- | --- | --- | --- | --- | --- |
| `BatteryCalculatedTotalAh` | Calculated total capacity | 52 | 64 | Ah | Bike maker P32B | Changes the calculated capacity/SOH model to 64 Ah; does not add physical capacity or health. |
| `BatteryInitialTotalAh` | Initial total capacity | 54 | 64 | Ah | Bike maker P32B | Changes the rated-capacity reference to 64 Ah for the P32B pack; incompatible with original 54 Ah cells. |
| `CANChargerVoltage` | Charge voltage | 340 | 360 | V | Bike maker P32B | Sets the charger voltage field to 360 V. Consequence on another charger is unknown; no charging fix is claimed. |
| `CellEndOfLifeVoltage` | Cell end of life voltage | 2500 | 2000 | mV | Daniel | Lowers the threshold below which the BMS refuses charging from 2500 to 2000 mV; weakens the backstop and can permit charging a deeply discharged cell. Damage/fire risk. |
| `CellMinimumVoltage` | Cell under voltage | 3300 | 2900 | mV | Daniel | Lowers the BMS empty/undervoltage threshold. No extra range with factory VCU settings; weakens the BMS backstop. Damage/fire risk. |
| `CellOverVoltage` | Cell over voltage | 4200 | 4300 | mV | Bike maker P32B | Raises the upper cell limit. Can damage incompatible cells and create a fire risk. |
| `CellTargetVoltage` | Cell target voltage | 4150 | 4250 | mV | Bike maker P32B | Raises the charge target. Can damage incompatible cells and create a fire risk. |
| `ChargeShapingTemp5` | unavailable | 45 | 52 | °C | Daniel | Moves charge temperature point 5 later, reducing thermal margin; retained limits do not prove safe charging. |
| `ChargeShapingTemp6` | unavailable | 50 | 53 | °C | Daniel | Moves charge temperature point 6 later, reducing thermal margin; retained limits do not prove safe charging. |
| `ChargeShapingTemp7` | unavailable | 53 | 54 | °C | Daniel | Moves charge temperature point 7 later, reducing thermal margin; retained limits do not prove safe charging. |
| `ChargeStartRegulationVoltage` | Charge regulating voltage | 4090 | 4190 | mV | Bike maker P32B | Raises the cell-voltage point where charge regulation/taper starts, as part of the higher-voltage P32B calibration. |
| `ChargerRegulationType` | Charger regulation type | Lin | Exp | enum | Bike maker P32B | Changes charger regulation from Lin to Exp. Consequence on another charger is unknown. |
| `DischargeShapingSOCCurrent1` | unavailable | 400 | 500 | 0.1 A | Bike maker P32B | Raises the 0%-SOC discharge point from 40 to 50 A, increasing load on near-empty cells and changing available propulsion. |
| `IsoOffsetChargeMode` | Charge mode offset | 40 | 5 | V | Bike maker P32B | Changes charge-mode isolation offset to 5 V; diagnostic consequence unknown. |
| `IsoOffsetDischargeMode` | Discharge mode offset | 40 | 15 | V | Bike maker P32B | Changes discharge-mode isolation offset to 15 V; diagnostic consequence unknown. |
| `RegenShapingTemp5` | unavailable | 40 | 45 | °C | Daniel | Moves regen temperature point 5 later, reducing thermal margin and changing available regen. |
| `RegenShapingTemp6` | unavailable | 45 | 47 | °C | Daniel | Moves regen temperature point 6 later; bike-maker P32B uses 42 °C. Reduces thermal margin and changes available regen. |
| `TrickleChargeCurrent` | Trickle charge current | 30 | 10 | 0.1 A | Bike maker P32B | Lowers the undervoltage/cold trickle-current ceiling from 3 to 1 A; does not establish safety of the lower charge-refusal threshold. |
| `WarningLevelHighCellVoltage` | High cell voltage | 4175 | 4275 | mV | Bike maker P32B | Raises the high-cell warning alongside the upper limit; warning arrives at a higher voltage and can be too late for incompatible cells. |
| `WarningLevelLowCellVoltage` | Low cell voltage | 3250 | 2700 | mV | Daniel | Moves the low-cell warning later, 300 mV below the bike-maker P32B warning; reduces warning margin and does not itself add range. |

## LMU bleed thresholds — 11 rows

Unit/label/description metadata for `BleedVoltage` are absent. The conventional cell-mV interpretation is stated here separately; no timing, hysteresis or health improvement is claimed. The raised threshold changes when voltage-based balancing can begin.

| Module (one-based) | Stored field | GUI label | Stock raw | 17 raw | Origin | Effect |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 2 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 3 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 4 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 5 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 6 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 7 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 8 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 9 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 10 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |
| 11 | `BleedVoltage` | unavailable | 4150 | 4240 | Bike maker P32B | Raises bleed threshold 4150 → 4240 (conventional mV); balancing may begin later. |

## CAN-transmit settings — 153 rows

The six added diagnostic frames are standard 11-bit IDs. Their intervals are 1000/1000/50/150/250/1000 ms for 660–665. Packed IDs include enable/checksum bits; signal StartBit includes enable, Bits includes Intel format, and Address includes data type. **Do not type these packed integers into display controls.** Use the [GUI worksheet](bms-can-worksheet.md) for CAN-only. Unused/unlisted signal rows remain untouched.

### TX row 1 — 2 changed fields

OEM 0x200: repoints its low/high temperature sources to the clamp results, hiding warm-pack heating from the VCU/dash. True temperatures require long 0x660.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_1_Signal_3_Address` | 18388 | 18459 | Daniel | Data type / Data identifier: Direct 2075 (reported high). |
| `CANTX_Frame_1_Signal_6_Address` | 18389 | 18461 | Daniel | Data type / Data identifier: Direct 2077 (reported low). |

### TX row 3 — 15 changed fields

OEM 0x202: bike-maker P32B pack stamp 4300/81/3 gives bytes 10 CC 51 03 in b0–3, matching overvoltage/count. Consumer/consequence unknown. Current fields remain b4–7; signal 6 is disabled. Calibration bundle only, never CAN-only.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_3_Signal_1_Address` | 2006 | 4300 | Bike maker P32B | Data type / Data identifier: Constant 4300. |
| `CANTX_Frame_3_Signal_1_Bits` | 8 | 16 | Bike maker P32B | Bit count 16; Intel format unticked. |
| `CANTX_Frame_3_Signal_2_Address` | 2012 | 81 | Bike maker P32B | Data type / Data identifier: Constant 81. |
| `CANTX_Frame_3_Signal_2_Bits` | 8 | 136 | Bike maker P32B | Bit count 8; Intel format ticked. |
| `CANTX_Frame_3_Signal_2_StartBit` | 136 | 144 | Bike maker P32B | Enabled; Start bit 16. |
| `CANTX_Frame_3_Signal_3_Address` | 0 | 3 | Bike maker P32B | Data type / Data identifier: Constant 3. |
| `CANTX_Frame_3_Signal_3_StartBit` | 144 | 152 | Bike maker P32B | Enabled; Start bit 24. |
| `CANTX_Frame_3_Signal_4_Address` | 2016 | 18414 | Bike maker P32B | Data type / Data identifier: Direct 2030. |
| `CANTX_Frame_3_Signal_4_Bits` | 8 | 16 | Bike maker P32B | Bit count 16; Intel format unticked. |
| `CANTX_Frame_3_Signal_4_StartBit` | 152 | 160 | Bike maker P32B | Enabled; Start bit 32. |
| `CANTX_Frame_3_Signal_5_Address` | 18414 | 18416 | Bike maker P32B | Data type / Data identifier: Direct 2032. |
| `CANTX_Frame_3_Signal_5_StartBit` | 160 | 176 | Bike maker P32B | Enabled; Start bit 48. |
| `CANTX_Frame_3_Signal_6_Address` | 18416 | 0 | Bike maker P32B | Data type / Data identifier: Constant 0. |
| `CANTX_Frame_3_Signal_6_Bits` | 16 | 8 | Bike maker P32B | Bit count 8; Intel format unticked. |
| `CANTX_Frame_3_Signal_6_StartBit` | 176 | 48 | Bike maker P32B | Disabled; Start bit 48. |

### TX row 7 — 1 changed fields

OEM 0x206: repoints the low-temperature source to the clamp result, consistent with 0x200.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_7_Signal_4_Address` | 18389 | 18461 | Daniel | Data type / Data identifier: Direct 2077 (reported low). |

### TX row 10 — 36 changed fields

0x660: highest/lowest-temperature LMU indices and average, plus true high/low, gate, pre-gate amount and reported-high echo. The full-length form is a hard clamp dependency.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_10_DLC` | 0 | 8 | Daniel | DLC 8; long true-temperature/clamp form. |
| `CANTX_Frame_10_Description` | Description Here | Thermal + bounded clamp | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_10_ID` | 0 | 2147485280 | Daniel | Enables ID 660 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_10_Interval` | 0 | 19 | Daniel | Interval 50 → 1000 ms. |
| `CANTX_Frame_10_Signal_1_Address` | 65535 | 18410 | Daniel | Data type / Data identifier: Direct 2026 (highest-temperature LMU index). |
| `CANTX_Frame_10_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_1_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_10_Signal_2_Address` | 65535 | 18411 | Daniel | Data type / Data identifier: Direct 2027 (lowest-temperature LMU index). |
| `CANTX_Frame_10_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_2_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_2_StartBit` | 255 | 136 | Daniel | Enabled; Start bit 8. |
| `CANTX_Frame_10_Signal_3_Address` | 65535 | 18507 | Daniel | Data type / Data identifier: Direct 2123 (average pack temperature). |
| `CANTX_Frame_10_Signal_3_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_3_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_3_StartBit` | 255 | 144 | Daniel | Enabled; Start bit 16. |
| `CANTX_Frame_10_Signal_4_Address` | 65535 | 18388 | Daniel | Data type / Data identifier: Direct 2004 (true pack high). |
| `CANTX_Frame_10_Signal_4_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_4_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_4_StartBit` | 255 | 152 | Daniel | Enabled; Start bit 24. |
| `CANTX_Frame_10_Signal_5_Address` | 65535 | 18389 | Daniel | Data type / Data identifier: Direct 2005 (true pack low). |
| `CANTX_Frame_10_Signal_5_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_5_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_5_StartBit` | 255 | 160 | Daniel | Enabled; Start bit 32. |
| `CANTX_Frame_10_Signal_6_Address` | 65535 | 18487 | Daniel | Data type / Data identifier: Direct 2103 (release gate). |
| `CANTX_Frame_10_Signal_6_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_6_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_6_StartBit` | 255 | 168 | Daniel | Enabled; Start bit 40. |
| `CANTX_Frame_10_Signal_7_Address` | 65535 | 18471 | Daniel | Data type / Data identifier: Direct 2087 (pre-gate high amount). |
| `CANTX_Frame_10_Signal_7_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_7_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_7_StartBit` | 255 | 176 | Daniel | Enabled; Start bit 48. |
| `CANTX_Frame_10_Signal_8_Address` | 65535 | 18459 | Daniel | Data type / Data identifier: Direct 2075 (reported high). |
| `CANTX_Frame_10_Signal_8_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_10_Signal_8_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_10_Signal_8_StartBit` | 255 | 184 | Daniel | Enabled; Start bit 56. |

### TX row 11 — 12 changed fields

0x661: 24-bit remaining energy in Wh and 24-bit uptime minutes; no duplicate cells-connected source.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_11_DLC` | 0 | 6 | Daniel | DLC 6; frame payload length. |
| `CANTX_Frame_11_Description` | Description Here | Energy and uptime | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_11_ID` | 0 | 2147485281 | Daniel | Enables ID 661 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_11_Interval` | 0 | 19 | Daniel | Interval 50 → 1000 ms. |
| `CANTX_Frame_11_Signal_1_Address` | 65535 | 18534 | Daniel | Data type / Data identifier: Direct 2150 (remaining energy). |
| `CANTX_Frame_11_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_11_Signal_1_Bits` | 255 | 24 | Daniel | Bit count 24; Intel format unticked. |
| `CANTX_Frame_11_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_11_Signal_2_Address` | 65535 | 18424 | Daniel | Data type / Data identifier: Direct 2040 (uptime minutes). |
| `CANTX_Frame_11_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_11_Signal_2_Bits` | 255 | 24 | Daniel | Bit count 24; Intel format unticked. |
| `CANTX_Frame_11_Signal_2_StartBit` | 255 | 152 | Daniel | Enabled; Start bit 24. |

### TX row 12 — 19 changed fields

0x662: module selector and cells 1–3, every 50 ms.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_12_DLC` | 0 | 8 | Daniel | DLC 8; frame payload length. |
| `CANTX_Frame_12_Description` | Description Here | LMU cells 1-3 | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_12_ID` | 0 | 2147485282 | Daniel | Enables ID 662 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_12_Signal_1_Address` | 65535 | 18513 | Daniel | Data type / Data identifier: Direct 2129 (current LMU index). |
| `CANTX_Frame_12_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_12_Signal_1_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_12_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_12_Signal_2_Address` | 65535 | 18514 | Daniel | Data type / Data identifier: Direct 2130 (cell 1). |
| `CANTX_Frame_12_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_12_Signal_2_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_12_Signal_2_StartBit` | 255 | 136 | Daniel | Enabled; Start bit 8. |
| `CANTX_Frame_12_Signal_3_Address` | 65535 | 18516 | Daniel | Data type / Data identifier: Direct 2132 (cell 2). |
| `CANTX_Frame_12_Signal_3_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_12_Signal_3_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_12_Signal_3_StartBit` | 255 | 152 | Daniel | Enabled; Start bit 24. |
| `CANTX_Frame_12_Signal_4_Address` | 65535 | 18518 | Daniel | Data type / Data identifier: Direct 2134 (cell 3). |
| `CANTX_Frame_12_Signal_4_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_12_Signal_4_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_12_Signal_4_StartBit` | 255 | 168 | Daniel | Enabled; Start bit 40. |

### TX row 13 — 20 changed fields

0x663: module selector and cells 4–6, every 150 ms. De-phasing addressed a known module-coverage gap; verify coverage again on the rider's bus.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_13_DLC` | 0 | 8 | Daniel | DLC 8; frame payload length. |
| `CANTX_Frame_13_Description` | Description Here | LMU cells 4-6 | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_13_ID` | 0 | 2147485283 | Daniel | Enables ID 663 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_13_Interval` | 0 | 2 | Daniel | Interval 50 → 150 ms. |
| `CANTX_Frame_13_Signal_1_Address` | 65535 | 18513 | Daniel | Data type / Data identifier: Direct 2129 (current LMU index). |
| `CANTX_Frame_13_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_13_Signal_1_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_13_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_13_Signal_2_Address` | 65535 | 18520 | Daniel | Data type / Data identifier: Direct 2136 (cell 4). |
| `CANTX_Frame_13_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_13_Signal_2_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_13_Signal_2_StartBit` | 255 | 136 | Daniel | Enabled; Start bit 8. |
| `CANTX_Frame_13_Signal_3_Address` | 65535 | 18522 | Daniel | Data type / Data identifier: Direct 2138 (cell 5). |
| `CANTX_Frame_13_Signal_3_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_13_Signal_3_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_13_Signal_3_StartBit` | 255 | 152 | Daniel | Enabled; Start bit 24. |
| `CANTX_Frame_13_Signal_4_Address` | 65535 | 18524 | Daniel | Data type / Data identifier: Direct 2140 (cell 6). |
| `CANTX_Frame_13_Signal_4_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_13_Signal_4_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_13_Signal_4_StartBit` | 255 | 168 | Daniel | Enabled; Start bit 40. |

### TX row 14 — 28 changed fields

0x664: module selector, cells 7–8 and BAT1/PCB1/PCB2 temperatures, every 250 ms. The in-frame selector applies only to that frame; disabled positions are not readings.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_14_DLC` | 0 | 8 | Daniel | DLC 8; frame payload length. |
| `CANTX_Frame_14_Description` | Description Here | LMU cells 7-8 + temps | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_14_ID` | 0 | 2147485284 | Daniel | Enables ID 664 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_14_Interval` | 0 | 4 | Daniel | Interval 50 → 250 ms. |
| `CANTX_Frame_14_Signal_1_Address` | 65535 | 18513 | Daniel | Data type / Data identifier: Direct 2129 (current LMU index). |
| `CANTX_Frame_14_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_1_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_14_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_14_Signal_2_Address` | 65535 | 18526 | Daniel | Data type / Data identifier: Direct 2142 (cell 7). |
| `CANTX_Frame_14_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_2_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_14_Signal_2_StartBit` | 255 | 136 | Daniel | Enabled; Start bit 8. |
| `CANTX_Frame_14_Signal_3_Address` | 65535 | 18528 | Daniel | Data type / Data identifier: Direct 2144 (cell 8). |
| `CANTX_Frame_14_Signal_3_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_3_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_14_Signal_3_StartBit` | 255 | 152 | Daniel | Enabled; Start bit 24. |
| `CANTX_Frame_14_Signal_4_Address` | 65535 | 18532 | Daniel | Data type / Data identifier: Direct 2148 (LMU BAT1). |
| `CANTX_Frame_14_Signal_4_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_4_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_14_Signal_4_StartBit` | 255 | 168 | Daniel | Enabled; Start bit 40. |
| `CANTX_Frame_14_Signal_5_Address` | 65535 | 18530 | Daniel | Data type / Data identifier: Direct 2146 (LMU PCB1). |
| `CANTX_Frame_14_Signal_5_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_5_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_14_Signal_5_StartBit` | 255 | 176 | Daniel | Enabled; Start bit 48. |
| `CANTX_Frame_14_Signal_6_Address` | 65535 | 18531 | Daniel | Data type / Data identifier: Direct 2147 (LMU PCB2). |
| `CANTX_Frame_14_Signal_6_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_14_Signal_6_Bits` | 255 | 8 | Daniel | Bit count 8; Intel format unticked. |
| `CANTX_Frame_14_Signal_6_StartBit` | 255 | 184 | Daniel | Enabled; Start bit 56. |

### TX row 15 — 20 changed fields

0x665: four literal effective voltage limits, not live register reads. Keep them synchronized with selected calibration. The whole file uses 2900/2000/4300/4250 mV.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `CANTX_Frame_15_DLC` | 0 | 8 | Daniel | DLC 8; frame payload length. |
| `CANTX_Frame_15_Description` | Description Here | Configured cell limits | Daniel | Description metadata only; no transmitted data change from this field. |
| `CANTX_Frame_15_ID` | 0 | 2147485285 | Daniel | Enables ID 665 (hex); 29-bit flag is separate and remains clear. |
| `CANTX_Frame_15_Interval` | 0 | 19 | Daniel | Interval 50 → 1000 ms. |
| `CANTX_Frame_15_Signal_1_Address` | 65535 | 2900 | Daniel | Data type / Data identifier: Constant 2900. |
| `CANTX_Frame_15_Signal_1_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_15_Signal_1_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_15_Signal_1_StartBit` | 255 | 128 | Daniel | Enabled; Start bit 0. |
| `CANTX_Frame_15_Signal_2_Address` | 65535 | 2000 | Daniel | Data type / Data identifier: Constant 2000. |
| `CANTX_Frame_15_Signal_2_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_15_Signal_2_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_15_Signal_2_StartBit` | 255 | 144 | Daniel | Enabled; Start bit 16. |
| `CANTX_Frame_15_Signal_3_Address` | 65535 | 4300 | Daniel | Data type / Data identifier: Constant 4300. |
| `CANTX_Frame_15_Signal_3_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_15_Signal_3_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_15_Signal_3_StartBit` | 255 | 160 | Daniel | Enabled; Start bit 32. |
| `CANTX_Frame_15_Signal_4_Address` | 65535 | 4250 | Daniel | Data type / Data identifier: Constant 4250. |
| `CANTX_Frame_15_Signal_4_Bitoffset` | 255 | 0 | Daniel | Bit offset 0. |
| `CANTX_Frame_15_Signal_4_Bits` | 255 | 16 | Daniel | Bit count 16; Intel format unticked. |
| `CANTX_Frame_15_Signal_4_StartBit` | 255 | 176 | Daniel | Enabled; Start bit 48. |

## Postprocessor settings — 87 rows

Operation 3 remains disabled. Operations 4–20 are enabled one-byte operations. Together they report min(true, floor) below the true-high release and pass both temperatures through at/above it, using wrapping bytes and unsigned truncating Divide. The [guide](bms-config.md#file-status-and-clamp-behavior) holds the central floor/release settings and the hazard: the clamp hides heating/derating from the VCU/dash. Operand types/numbers and output names here are display interpretations; confirm actual dialog captions before entry.

| Stored field (BMCU) | Stock raw | 17 raw | Origin | Display meaning / effect |
| --- | --- | --- | --- | --- |
| `Postprocessor_Frame_10_Bytes` | 0 | 129 | Daniel | Low sign test: enabled, 1 byte result. |
| `Postprocessor_Frame_10_Operand_1` | 0 | 18473 | Daniel | Low sign test: Operand 1 = Direct 2089. |
| `Postprocessor_Frame_10_Operand_2` | 0 | 128 | Daniel | Low sign test: Operand 2 = Constant 128. |
| `Postprocessor_Frame_10_Operator` | 0 | 3 | Daniel | Low sign test: Divide. |
| `Postprocessor_Frame_10_Output` | 0 | 10 | Daniel | Low sign test: stores into Output11 (stored zero-based index 10). |
| `Postprocessor_Frame_11_Bytes` | 0 | 129 | Daniel | Low sign mask: enabled, 1 byte result. |
| `Postprocessor_Frame_11_Operand_1` | 0 | 18475 | Daniel | Low sign mask: Operand 1 = Direct 2091. |
| `Postprocessor_Frame_11_Operand_2` | 0 | 255 | Daniel | Low sign mask: Operand 2 = Constant 255. |
| `Postprocessor_Frame_11_Operator` | 0 | 2 | Daniel | Low sign mask: Multiply. |
| `Postprocessor_Frame_11_Output` | 0 | 11 | Daniel | Low sign mask: stores into Output12 (stored zero-based index 11). |
| `Postprocessor_Frame_12_Bytes` | 0 | 129 | Daniel | Negative-low part: enabled, 1 byte result. |
| `Postprocessor_Frame_12_Operand_1` | 0 | 18473 | Daniel | Negative-low part: Operand 1 = Direct 2089. |
| `Postprocessor_Frame_12_Operand_2` | 0 | 18477 | Daniel | Negative-low part: Operand 2 = Direct 2093. |
| `Postprocessor_Frame_12_Operator` | 0 | 4 | Daniel | Negative-low part: AND_bitwise. |
| `Postprocessor_Frame_12_Output` | 0 | 12 | Daniel | Negative-low part: stores into Output13 (stored zero-based index 12). |
| `Postprocessor_Frame_13_Bytes` | 0 | 129 | Daniel | Positive low amount: enabled, 1 byte result. |
| `Postprocessor_Frame_13_Operand_1` | 0 | 18473 | Daniel | Positive low amount: Operand 1 = Direct 2089. |
| `Postprocessor_Frame_13_Operand_2` | 0 | 18479 | Daniel | Positive low amount: Operand 2 = Direct 2095. |
| `Postprocessor_Frame_13_Operator` | 0 | 1 | Daniel | Positive low amount: Subtract. |
| `Postprocessor_Frame_13_Output` | 0 | 13 | Daniel | Positive low amount: stores into Output14 (stored zero-based index 13). |
| `Postprocessor_Frame_14_Bytes` | 0 | 129 | Daniel | True high minus release: enabled, 1 byte result. |
| `Postprocessor_Frame_14_Operand_1` | 0 | 18388 | Daniel | True high minus release: Operand 1 = Direct 2004 (true pack high). |
| `Postprocessor_Frame_14_Operand_2` | 0 | 55 | Daniel | True high minus release: Operand 2 = Constant 55. |
| `Postprocessor_Frame_14_Operator` | 0 | 9 | Daniel | True high minus release: Signed_Subtract. |
| `Postprocessor_Frame_14_Output` | 0 | 14 | Daniel | True high minus release: stores into Output15 (stored zero-based index 14). |
| `Postprocessor_Frame_15_Bytes` | 0 | 129 | Daniel | Release regime test: enabled, 1 byte result. |
| `Postprocessor_Frame_15_Operand_1` | 0 | 18483 | Daniel | Release regime test: Operand 1 = Direct 2099. |
| `Postprocessor_Frame_15_Operand_2` | 0 | 128 | Daniel | Release regime test: Operand 2 = Constant 128. |
| `Postprocessor_Frame_15_Operator` | 0 | 3 | Daniel | Release regime test: Divide. |
| `Postprocessor_Frame_15_Output` | 0 | 15 | Daniel | Release regime test: stores into Output16 (stored zero-based index 15). |
| `Postprocessor_Frame_16_Bytes` | 0 | 129 | Daniel | 255/0 release gate: enabled, 1 byte result. |
| `Postprocessor_Frame_16_Operand_1` | 0 | 18485 | Daniel | 255/0 release gate: Operand 1 = Direct 2101. |
| `Postprocessor_Frame_16_Operand_2` | 0 | 255 | Daniel | 255/0 release gate: Operand 2 = Constant 255. |
| `Postprocessor_Frame_16_Operator` | 0 | 2 | Daniel | 255/0 release gate: Multiply. |
| `Postprocessor_Frame_16_Output` | 0 | 16 | Daniel | 255/0 release gate: stores into Output17 (stored zero-based index 16). |
| `Postprocessor_Frame_17_Bytes` | 0 | 129 | Daniel | High amount AND gate: enabled, 1 byte result. |
| `Postprocessor_Frame_17_Operand_1` | 0 | 18471 | Daniel | High amount AND gate: Operand 1 = Direct 2087 (pre-gate high amount). |
| `Postprocessor_Frame_17_Operand_2` | 0 | 18487 | Daniel | High amount AND gate: Operand 2 = Direct 2103 (release gate). |
| `Postprocessor_Frame_17_Operator` | 0 | 4 | Daniel | High amount AND gate: AND_bitwise. |
| `Postprocessor_Frame_17_Output` | 0 | 17 | Daniel | High amount AND gate: stores into Output18 (stored zero-based index 17). |
| `Postprocessor_Frame_18_Bytes` | 0 | 129 | Daniel | Low amount AND gate: enabled, 1 byte result. |
| `Postprocessor_Frame_18_Operand_1` | 0 | 18481 | Daniel | Low amount AND gate: Operand 1 = Direct 2097. |
| `Postprocessor_Frame_18_Operand_2` | 0 | 18487 | Daniel | Low amount AND gate: Operand 2 = Direct 2103 (release gate). |
| `Postprocessor_Frame_18_Operator` | 0 | 4 | Daniel | Low amount AND gate: AND_bitwise. |
| `Postprocessor_Frame_18_Output` | 0 | 18 | Daniel | Low amount AND gate: stores into Output19 (stored zero-based index 18). |
| `Postprocessor_Frame_19_Bytes` | 0 | 129 | Daniel | Reported high: enabled, 1 byte result. |
| `Postprocessor_Frame_19_Operand_1` | 0 | 18388 | Daniel | Reported high: Operand 1 = Direct 2004 (true pack high). |
| `Postprocessor_Frame_19_Operand_2` | 0 | 18489 | Daniel | Reported high: Operand 2 = Direct 2105. |
| `Postprocessor_Frame_19_Operator` | 0 | 9 | Daniel | Reported high: Signed_Subtract. |
| `Postprocessor_Frame_19_Output` | 0 | 2 | Daniel | Reported high: stores into Output3 (stored zero-based index 2). |
| `Postprocessor_Frame_20_Bytes` | 0 | 129 | Daniel | Reported low: enabled, 1 byte result. |
| `Postprocessor_Frame_20_Operand_1` | 0 | 18389 | Daniel | Reported low: Operand 1 = Direct 2005 (true pack low). |
| `Postprocessor_Frame_20_Operand_2` | 0 | 18491 | Daniel | Reported low: Operand 2 = Direct 2107. |
| `Postprocessor_Frame_20_Operator` | 0 | 9 | Daniel | Reported low: Signed_Subtract. |
| `Postprocessor_Frame_20_Output` | 0 | 3 | Daniel | Reported low: stores into Output4 (stored zero-based index 3). |
| `Postprocessor_Frame_3_Bytes` | 4 | 2 | Bike maker P32B | Disabled in both files; Bytes becomes 2 with enable bit clear. No claimed live effect. |
| `Postprocessor_Frame_3_Operand_1` | 18400 | 18418 | Bike maker P32B | Disabled in both files; Operand 1 becomes Direct 2034. No claimed live effect. |
| `Postprocessor_Frame_4_Bytes` | 0 | 129 | Daniel | High minus floor: enabled, 1 byte result. |
| `Postprocessor_Frame_4_Operand_1` | 16384 | 18388 | Daniel | High minus floor: Operand 1 = Direct 2004 (true pack high). |
| `Postprocessor_Frame_4_Operand_2` | 0 | 33 | Daniel | High minus floor: Operand 2 = Constant 33. |
| `Postprocessor_Frame_4_Operator` | 0 | 9 | Daniel | High minus floor: Signed_Subtract. |
| `Postprocessor_Frame_4_Output` | 0 | 4 | Daniel | High minus floor: stores into Output5 (stored zero-based index 4). |
| `Postprocessor_Frame_5_Bytes` | 0 | 129 | Daniel | High sign test: enabled, 1 byte result. |
| `Postprocessor_Frame_5_Operand_1` | 0 | 18463 | Daniel | High sign test: Operand 1 = Direct 2079. |
| `Postprocessor_Frame_5_Operand_2` | 0 | 128 | Daniel | High sign test: Operand 2 = Constant 128. |
| `Postprocessor_Frame_5_Operator` | 0 | 3 | Daniel | High sign test: Divide. |
| `Postprocessor_Frame_5_Output` | 0 | 5 | Daniel | High sign test: stores into Output6 (stored zero-based index 5). |
| `Postprocessor_Frame_6_Bytes` | 0 | 129 | Daniel | High sign mask: enabled, 1 byte result. |
| `Postprocessor_Frame_6_Operand_1` | 0 | 18465 | Daniel | High sign mask: Operand 1 = Direct 2081. |
| `Postprocessor_Frame_6_Operand_2` | 0 | 255 | Daniel | High sign mask: Operand 2 = Constant 255. |
| `Postprocessor_Frame_6_Operator` | 0 | 2 | Daniel | High sign mask: Multiply. |
| `Postprocessor_Frame_6_Output` | 0 | 6 | Daniel | High sign mask: stores into Output7 (stored zero-based index 6). |
| `Postprocessor_Frame_7_Bytes` | 0 | 129 | Daniel | Negative-high part: enabled, 1 byte result. |
| `Postprocessor_Frame_7_Operand_1` | 0 | 18463 | Daniel | Negative-high part: Operand 1 = Direct 2079. |
| `Postprocessor_Frame_7_Operand_2` | 0 | 18467 | Daniel | Negative-high part: Operand 2 = Direct 2083. |
| `Postprocessor_Frame_7_Operator` | 0 | 4 | Daniel | Negative-high part: AND_bitwise. |
| `Postprocessor_Frame_7_Output` | 0 | 7 | Daniel | Negative-high part: stores into Output8 (stored zero-based index 7). |
| `Postprocessor_Frame_8_Bytes` | 0 | 129 | Daniel | Positive high amount: enabled, 1 byte result. |
| `Postprocessor_Frame_8_Operand_1` | 0 | 18463 | Daniel | Positive high amount: Operand 1 = Direct 2079. |
| `Postprocessor_Frame_8_Operand_2` | 0 | 18469 | Daniel | Positive high amount: Operand 2 = Direct 2085. |
| `Postprocessor_Frame_8_Operator` | 0 | 1 | Daniel | Positive high amount: Subtract. |
| `Postprocessor_Frame_8_Output` | 0 | 8 | Daniel | Positive high amount: stores into Output9 (stored zero-based index 8). |
| `Postprocessor_Frame_9_Bytes` | 0 | 129 | Daniel | Low minus floor: enabled, 1 byte result. |
| `Postprocessor_Frame_9_Operand_1` | 0 | 18389 | Daniel | Low minus floor: Operand 1 = Direct 2005 (true pack low). |
| `Postprocessor_Frame_9_Operand_2` | 0 | 33 | Daniel | Low minus floor: Operand 2 = Constant 33. |
| `Postprocessor_Frame_9_Operator` | 0 | 9 | Daniel | Low minus floor: Signed_Subtract. |
| `Postprocessor_Frame_9_Output` | 0 | 9 | Daniel | Low minus floor: stores into Output10 (stored zero-based index 9). |

## Bundle field scopes

These scopes implement the [five named bundles](bms-config.md#choose-whole-bundles-for-your-own-configuration). Exact raw target rows for Daniel's whole file are above. No schema field absent from an older source is an instruction to delete or zero a rider's setting.

1. **CAN broadcasts:** TX rows 10–15 only: six IDs, six DLCs, six descriptions, five interval changes and 23 listed signal rows × four components (`StartBit`, `Bits`, `Address`, `Bitoffset`). Use the [worksheet](bms-can-worksheet.md), short row-10 DLC 3, no signals 4–8 there, and the rider's effective own four voltage literals. No OEM/postprocessor edits. The 115 count is for the verified original-stock source.
2. **Bike-maker P32B calibration:** the 46 effective fields in the table below. Fifteen frame-3 signal components and two disabled operation-3 components are included; the 0x202 stamp never belongs to bundle 1. Its matching limit/count are mandatory.
3. **Daniel's lower limits:** only `CellMinimumVoltage`, `CellEndOfLifeVoltage`, `WarningLevelLowCellVoltage`, plus synchronization of existing 0x665 literals. Factory VCU settings still stop the bike first: no extra range from this bundle alone, yet it weakens the BMS backstop and lowers the charge-refusal threshold. Daniel's range depends additionally on the separate VCU settings in the guide.
4. **Daniel's later thermal knees:** `ChargeShapingTemp5/6/7`, `RegenShapingTemp5/6/7/8` and `RegenShapingCurrent7`. Use the guide's bike-maker comparison, including the three rows that equal original stock.
5. **Clamp plus required long thermal frame:** three OEM pointers `CANTX_Frame_1_Signal_6_Address`, `CANTX_Frame_1_Signal_3_Address`, `CANTX_Frame_7_Signal_4_Address`; all five components (`Operator`, `Operand_1`, `Operand_2`, `Output`, `Bytes`) of operations 4–20; row-10 DLC/description; all four components of row-10 signals 4–8. These 110 rows layer on bundle 1. Long true-temperature 0x660 and `CUSTOM_BMS_CONFIG=1` are mandatory.

### Bike-maker calibration bundle — 46 effective stock changes

This table is **bundle 2**, not the final personal file. Bundles 3/4 deliberately override some values; do not accidentally retain these source values after choosing those overrides. With bundle 1 present, synchronize 0x665 to the resulting effective values. Eleven fields absent from the older source export have the same zero/false stock values; retain the rider's settings rather than deleting schema fields.

| Stored path                            | Original stock raw | Bike-maker P32B raw |
| -------------------------------------- | ------------------ | ------------------- |
| `BMCU/BatteryCalculatedTotalAh`        | 52                 | 64                  |
| `BMCU/BatteryInitialTotalAh`           | 54                 | 64                  |
| `BMCU/CANChargerVoltage`               | 340                | 360                 |
| `BMCU/CANTX_Frame_3_Signal_1_Address`  | 2006               | 4300                |
| `BMCU/CANTX_Frame_3_Signal_1_Bits`     | 8                  | 16                  |
| `BMCU/CANTX_Frame_3_Signal_2_Address`  | 2012               | 81                  |
| `BMCU/CANTX_Frame_3_Signal_2_Bits`     | 8                  | 136                 |
| `BMCU/CANTX_Frame_3_Signal_2_StartBit` | 136                | 144                 |
| `BMCU/CANTX_Frame_3_Signal_3_Address`  | 0                  | 3                   |
| `BMCU/CANTX_Frame_3_Signal_3_StartBit` | 144                | 152                 |
| `BMCU/CANTX_Frame_3_Signal_4_Address`  | 2016               | 18414               |
| `BMCU/CANTX_Frame_3_Signal_4_Bits`     | 8                  | 16                  |
| `BMCU/CANTX_Frame_3_Signal_4_StartBit` | 152                | 160                 |
| `BMCU/CANTX_Frame_3_Signal_5_Address`  | 18414              | 18416               |
| `BMCU/CANTX_Frame_3_Signal_5_StartBit` | 160                | 176                 |
| `BMCU/CANTX_Frame_3_Signal_6_Address`  | 18416              | 0                   |
| `BMCU/CANTX_Frame_3_Signal_6_Bits`     | 16                 | 8                   |
| `BMCU/CANTX_Frame_3_Signal_6_StartBit` | 176                | 48                  |
| `BMCU/CellMinimumVoltage`              | 3300               | 3200                |
| `BMCU/CellOverVoltage`                 | 4200               | 4300                |
| `BMCU/CellTargetVoltage`               | 4150               | 4250                |
| `BMCU/ChargeStartRegulationVoltage`    | 4090               | 4190                |
| `BMCU/ChargerRegulationType`           | Lin                | Exp                 |
| `BMCU/DischargeShapingSOCCurrent1`     | 400                | 500                 |
| `BMCU/IsoOffsetChargeMode`             | 40                 | 5                   |
| `BMCU/IsoOffsetDischargeMode`          | 40                 | 15                  |
| `BMCU/Postprocessor_Frame_3_Bytes`     | 4                  | 2                   |
| `BMCU/Postprocessor_Frame_3_Operand_1` | 18400              | 18418               |
| `BMCU/RegenShapingCurrent7`            | 600                | 400                 |
| `BMCU/RegenShapingTemp6`               | 45                 | 42                  |
| `BMCU/RegenShapingTemp7`               | 50                 | 48                  |
| `BMCU/RegenShapingTemp8`               | 55                 | 52                  |
| `BMCU/TrickleChargeCurrent`            | 30                 | 10                  |
| `BMCU/WarningLevelHighCellVoltage`     | 4175               | 4275                |
| `BMCU/WarningLevelLowCellVoltage`      | 3250               | 3000                |
| `LMU[10]/BleedVoltage`                 | 4150               | 4240                |
| `LMU[11]/BleedVoltage`                 | 4150               | 4240                |
| `LMU[1]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[2]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[3]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[4]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[5]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[6]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[7]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[8]/BleedVoltage`                  | 4150               | 4240                |
| `LMU[9]/BleedVoltage`                  | 4150               | 4240                |
