// The VCU's own state machine, CAN 0x101 `VCU_VEHICLE_STS` at 100 Hz.
//
// Energica's frame database names all eight signals (the 2024 service-tool analysis in
// obd-garage/, §`0x101` `VCU_VEHICLE_STS`), and until now every byte of it was discarded
// on arrival — 0x101 was not in STREAM_IDS, so the kernel filter never passed it.
//
// ⚠️ The two state words are ALREADY LOGGED, from the other transport: src/ble/protocol.ts
// reads them out of the Connectivity Hub's vehicle-status message under `vehicle_state` and
// `vehicle_substate`. These keys therefore carry `_can`, the way `odometer_can_km` does
// beside the hub's `odometer_km` — one key with two writers flaps between them, and keeping
// them apart is what lets a ride say whether the two agree. They mostly do: the CAN byte
// produces every substate the BLE path has logged except 0, and every state except 0 and 4 —
// 7 rows of 816 in all, which read as that path's partial-frame sentinels. docs/can-0x101.md.
//
// What the bytes mean, how the state/substate bands work, and what is still open:
// docs/can-0x101.md.

import { type DecodedValue, bit, u16le } from "./frame.ts";

export const VEHICLE_STATUS_CAN_ID = 0x101;

/** Decodes one 0x101 frame. Pure: bytes in, values out. */
export function decodeVehicleStatusFrame(data: Buffer): DecodedValue[] {
  if (data.length < 8) return [];
  const flags = data[3];
  return [
    // b0/b1 — `V_VEHICLE_SUBSTATE` and `V_VEHICLE_STATE`. The state takes six values in
    // 15 006 844 archive frames (1, 20, 40, 60, 80, 100) and each owns a band of substates;
    // a substate with bit 7 set belongs to no band and the state latches while it is
    // present, 1 748 of 1 748 frames. Raw bytes rather than labels: the database names the
    // fields and not their enumerations, and only a handful of values are identified.
    { key: "vehicle_substate_can", value: data[0] },
    { key: "vehicle_state_can", value: data[1] },
    // b2 — `V_DRIVE_VSM`, and ⚠️ the database assigns that name TWICE, here and to b3's low
    // two bits. §A.3 lists it among the bugs in Energica's own parser ("assigned twice; byte
    // 2 lost"), so the two are decoded as separate quantities rather than reproducing it.
    //
    // ✅ b2 says WHICH SUBSTATE THE BIKE IS IN, coarsely: 6 in the three driving substates
    // (43 riding, 52 park assist, 53) and 4 in every other substate and every other state.
    // Over three boots that rule holds in 736 095 of 736 574 frames, 99.94 %. Archive-wide,
    // 6 occurs only in state 40.
    //
    // 🟡 It ALSO dips to 4 for ~0.1 s at substate changes WITHIN those three — 26 of 26 such
    // changes, 479 frames — which a lagged copy of b0 cannot explain, since 43 → 52 is a
    // change between two substates that both read 6. Weaker than it first looked: the
    // "107 of 107" this comment used to claim counted 81 enable-chain changes where b2 is 4
    // throughout anyway. docs/can-0x101.md §"b2" has both readings and the retraction.
    { key: "drive_vsm", value: data[2] },
    { key: "drive_vsm_b3", value: flags & 0x03 },
    // b3 bit 2 — `V_LIMP_MODE_STATUS`. 🟡 Set in ALL 15 006 844 archive frames and all
    // 1 184 096 September ones. It is decoded because a flag that only matters when it moves
    // is worth having before it moves (src/can/vcu-flags.ts's argument), and it is NOT
    // something to gate on: nothing on this bike has ever shown it clear, so "limp mode is
    // active" and "the bit is stuck" are indistinguishable from the data.
    { key: "limp_mode_status", value: bit(flags, 2) },
    { key: "limp_res_valid", value: bit(flags, 3) },
    // b3 raw, for the reason 0x100 logs `vcu_flags_low`/`vcu_flags_high` beside its
    // broken-out bits: ⚠️ bits 4 and 6 MOVE and the vendor table does not name them — bit 4
    // in 9 345 176 frames (states 100/80/20/1), bit 6 in 135 811 (state 40 only). A key for
    // either would have to invent a name; the byte is the only honest carrier, and a wrong
    // bit position then costs a re-read of the log rather than a lost event.
    { key: "vehicle_status_flags", value: flags },
    // b4-5 / b6-7 — `V_LIMP_PACK_RES` and `V_LIMP_MODULE_STS`, both `short` in the database.
    // Read UNSIGNED: b5 is 0 in every frame on record so the two readings are
    // indistinguishable here, and an unsigned read cannot turn a wrong-endian value into a
    // plausible negative. ⚠️ No unit — the database carries no scaling factors (§A.4), and
    // 75…154 is only PLAUSIBLE for this pack's milliohms. 🟡 `limp_module_word` is 0 in all
    // 15 006 844 archive frames and all 1 184 096 September ones.
    { key: "limp_pack_res", value: u16le(data[4], data[5]) },
    { key: "limp_module_word", value: u16le(data[6], data[7]) },
  ];
}
