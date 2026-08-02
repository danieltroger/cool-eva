import type { DecodedValue } from "./frame.ts";

// Decides which frame is allowed to write batt_temp_lo / batt_temp_hi.
//
// Those two keys have years of history behind them and must keep meaning the TRUE
// pack temperature. On a stock Energica that is 0x200 bytes 0/3, full stop. Once the
// custom LiBAL config is flashed those bytes are shifted 15 °C low — to move the VCU's
// DC-charge derate knee from 36 °C reported to 51 °C actual — and the truth moves to
// the long 0x660 instead. This routing is the ONLY config-dependent decode in the
// repo; every other frame and correction is right on both.
//
// CUSTOM_BMS_CONFIG says which to expect, but the frames say what actually arrived and
// the frames win. The flag by itself decides nothing that could corrupt data: it picks
// the default for the one case the bus can't answer (0x660 never showing up at all),
// and it decides which mismatch gets warned about.
//
// This is routing, not deriving: no value is computed here. A measured byte is either
// passed through under its historical key or left alone.

const PACK_THERMAL_FRAME_ID = 0x660;

// 0x660 is DLC 3 before the VCU offset exists and DLC 8 after. Bytes 3-4 (the true
// pack temp high/low) exist only in the long form.
const OFFSET_CONFIG_MIN_DLC = 5;

// How long to wait for a long 0x660 before concluding it is not coming. Only consulted
// when the flag says to expect one — 0x660 is 1 Hz, so a few seconds is plenty.
const THERMAL_FRAME_WAIT_MS = 5000;

const VCU_TEMPERATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["batt_temp_lo_vcu", "batt_temp_lo"],
  ["batt_temp_hi_vcu", "batt_temp_hi"],
];

let customBmsConfigExpected = false;
let latestThermalFrameIsLong = false;
let anyLongThermalFrameSeen = false;
let startedAtMs = Date.now();
let warnedThermalFrameMissing = false;
let warnedThermalFrameUnexpected = false;

/**
 * Takes what a frame decoded to and returns what should actually be recorded, adding
 * batt_temp_lo / batt_temp_hi from 0x200's bytes when — and only when — those bytes
 * are the true temperature. Stateful: it watches 0x660's length as frames arrive.
 */
export function resolvePackTemperatures(id: number, data: Buffer, decoded: DecodedValue[]): DecodedValue[] {
  if (id === PACK_THERMAL_FRAME_ID) {
    notePackThermalFrame(data.length);
    return decoded;
  }
  if (!shouldMirrorVcuTemperatures()) return decoded;
  const trueTemperatures: DecodedValue[] = [];
  for (const { key, value } of decoded) {
    for (const [vcuKey, trueKey] of VCU_TEMPERATURE_KEYS) {
      if (key === vcuKey) {
        trueTemperatures.push({ key: trueKey, value });
      }
    }
  }
  if (trueTemperatures.length === 0) return decoded;
  return [...decoded, ...trueTemperatures];
}

/** Call once at startup with the CUSTOM_BMS_CONFIG flag. Default is stock. */
export function configurePackTemperature(customBmsConfig: boolean): void {
  customBmsConfigExpected = customBmsConfig;
  startedAtMs = Date.now();
}

function notePackThermalFrame(frameLength: number): void {
  // Most recent 0x660 wins, so a reflash in either direction recovers within a second
  // rather than needing a restart.
  latestThermalFrameIsLong = frameLength >= OFFSET_CONFIG_MIN_DLC;
  if (!latestThermalFrameIsLong) return;
  anyLongThermalFrameSeen = true;
  if (customBmsConfigExpected || warnedThermalFrameUnexpected) return;
  // The dangerous direction: the offset IS flashed but we were told it wasn't, so
  // 0x200's bytes are 15 °C low and whatever was logged from them is wrong. The frame
  // is proof, so switch to it — but say so loudly, because rows are already affected
  // and only the operator can fix the flag.
  warnedThermalFrameUnexpected = true;
  console.error(
    "bms: *** CUSTOM_BMS_CONFIG is not set, but extended 0x660 frames " +
      `(DLC >= ${OFFSET_CONFIG_MIN_DLC}) are arriving. *** The custom BMS config IS flashed, so ` +
      "0x200's temperature bytes are shifted 15 °C LOW. Switching batt_temp_lo/batt_temp_hi to " +
      "0x660's true values now, but any rows logged before this point are 15 °C cold. " +
      "Set CUSTOM_BMS_CONFIG=1 and restart."
  );
}

// 0x200's temperature bytes are the truth unless something else is known to own them.
function shouldMirrorVcuTemperatures(): boolean {
  // A long 0x660 is proof of the offset config whatever the flag claims, and it
  // carries the true values itself.
  if (latestThermalFrameIsLong) return false;
  // Stock bike: 0x200 is the only source there is, so mirror from the very first
  // frame — no waiting period, exactly as it behaved before any of this existed.
  if (!customBmsConfigExpected) return true;
  // A long 0x660 was seen earlier and has now stopped. The offset config is real, so
  // falling back to 0x200 would log 15 °C-cold values: go stale rather than wrong.
  if (anyLongThermalFrameSeen) return false;
  // The flag expects the offset config but no long 0x660 has ever arrived. Give it a
  // moment (0x200 is 20 Hz, 0x660 only 1 Hz), then treat the flag as mistaken rather
  // than leave the bike with no temperature logging at all.
  if (Date.now() - startedAtMs < THERMAL_FRAME_WAIT_MS) return false;
  if (!warnedThermalFrameMissing) {
    warnedThermalFrameMissing = true;
    console.warn(
      `bms: CUSTOM_BMS_CONFIG is set but no extended 0x660 frame (DLC >= ${OFFSET_CONFIG_MIN_DLC}) ` +
        `arrived within ${THERMAL_FRAME_WAIT_MS} ms — the pack is probably running a config without ` +
        "the VCU temperature offset. Taking batt_temp_lo/batt_temp_hi from 0x200 so temperatures " +
        "keep flowing. Unset CUSTOM_BMS_CONFIG to silence this."
    );
  }
  return true;
}
