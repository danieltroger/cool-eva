import { OFFSET_CONFIG_MIN_DLC } from "./decode-bms.ts";
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
// No single frame announces which config is flashed, so it has to be established from
// what arrives:
//   • a long 0x660 (DLC >= OFFSET_CONFIG_MIN_DLC) proves the offset config, and carries
//     the true temperatures itself;
//   • a short 0x660 proves the extended config WITHOUT the offset, so 0x200 is true;
//   • no 0x660 at all, while the BMS is demonstrably transmitting, means a stock pack.
//
// Until one of those holds, batt_temp_lo/batt_temp_hi are not emitted AT ALL. That is
// the rule the module exists to enforce, and it is deliberately asymmetric: a gap in a
// log-on-change series costs nothing and reads as "not known yet", whereas a shifted
// value under the true-temperature key reads as a 15 °C plunge indistinguishable from a
// failing sensor — and the ride log is sealed, so it can never be corrected afterwards.
// There is no such thing as a safe fallback here; going quiet IS the fallback.
//
// CUSTOM_BMS_CONFIG says which config to expect, but the frames say what actually
// arrived and the frames win. The flag by itself decides nothing that could corrupt
// data: it decides how the one case the bus can't answer (no 0x660 at all) is read, and
// which mismatch gets warned about.
//
// This is routing, not deriving: no value is computed here. A measured byte is either
// passed through under its historical key or left alone.

const PACK_THERMAL_FRAME_ID = 0x660;

// How long to wait for a 0x660 before its absence counts as an answer. 0x660 is 1 Hz,
// so five seconds is five chances to see one.
//
// Measured from the first 0x200 seen — NOT from startup, and NOT from the first frame
// of any id. 0x200 and 0x660 sit in the same BMS TX table, so a 0x200 on the wire is
// the proof that the transmitter is alive and that a configured 0x660 would follow
// within a second. Timing from startup would spend the window while the Pi waits hours
// for a sleeping bike; timing from any frame would spend it on VCU traffic while the
// BMS is still asleep. Both leave the window already expired at the moment the first
// 0x200 lands, which is precisely when it has to be full.
const THERMAL_FRAME_WAIT_MS = 5000;

// 0x200's two temperature bytes, and the true-temperature key each one feeds when 0x200
// is the frame that owns the truth. Matched on the keys the decoder emitted rather than
// on the frame id, so decode-bms.ts stays the only place that knows which bytes of which
// frame these are.
const VCU_TEMPERATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["batt_temp_lo_vcu", "batt_temp_lo"],
  ["batt_temp_hi_vcu", "batt_temp_hi"],
];

// Which frame owns batt_temp_lo/batt_temp_hi right now. "unknown" is a real state with
// a real output, not a placeholder: it means nothing is written under those keys.
type TrueTemperatureSource = "unknown" | "vcu-frame" | "thermal-frame";

let customBmsConfigExpected = false;
let trueTemperatureSource: TrueTemperatureSource = "unknown";
let firstVcuTemperatureAtMs: number | undefined;
let warnedThermalFrameMissing = false;
let warnedThermalFrameUnexpected = false;
let warnedThermalFrameShort = false;

/**
 * Takes what a frame decoded to and returns what should actually be recorded, adding
 * batt_temp_lo / batt_temp_hi from 0x200's bytes when — and only when — those bytes are
 * KNOWN to be the true temperature. Stateful: it watches 0x660's length as frames
 * arrive, and emits nothing under those keys while the answer is still open.
 */
export function resolvePackTemperatures(id: number, data: Buffer, decoded: DecodedValue[]): DecodedValue[] {
  if (id === PACK_THERMAL_FRAME_ID) {
    notePackThermalFrame(data.length);
    return decoded;
  }
  const trueTemperatures = collectTrueTemperatureCandidates(decoded);
  if (trueTemperatures.length === 0) return decoded;
  firstVcuTemperatureAtMs ??= Date.now();
  if (!vcuFrameOwnsTrueTemperature(firstVcuTemperatureAtMs)) return decoded;
  return [...decoded, ...trueTemperatures];
}

/**
 * Call once at startup with the CUSTOM_BMS_CONFIG flag. Default is stock. Resets
 * detection to "nothing known": the flag never establishes a source by itself, and the
 * wait window starts at the first 0x200, which may be hours later.
 */
export function configurePackTemperature(customBmsConfig: boolean): void {
  customBmsConfigExpected = customBmsConfig;
  trueTemperatureSource = "unknown";
  firstVcuTemperatureAtMs = undefined;
  warnedThermalFrameMissing = false;
  warnedThermalFrameUnexpected = false;
  warnedThermalFrameShort = false;
}

// 0x200's VCU-view values, relabelled with the true-temperature keys they would feed.
// Whether they are actually emitted is the caller's decision.
function collectTrueTemperatureCandidates(decoded: DecodedValue[]): DecodedValue[] {
  const candidates: DecodedValue[] = [];
  for (const { key, value } of decoded) {
    for (const [vcuKey, trueKey] of VCU_TEMPERATURE_KEYS) {
      if (key === vcuKey) {
        candidates.push({ key: trueKey, value });
      }
    }
  }
  return candidates;
}

function notePackThermalFrame(frameLength: number): void {
  // Most recent 0x660 wins, so a reflash in either direction recovers within a second
  // rather than needing a restart.
  if (frameLength < OFFSET_CONFIG_MIN_DLC) {
    // The extended config without the temperature offset: 0x660 exists, but the bytes
    // carrying the true temperature don't, so 0x200 is the truth as on a stock pack.
    trueTemperatureSource = "vcu-frame";
    if (!customBmsConfigExpected || warnedThermalFrameShort) return;
    warnedThermalFrameShort = true;
    console.warn(
      `bms: CUSTOM_BMS_CONFIG is set, but 0x660 arrives in its short form (DLC < ${OFFSET_CONFIG_MIN_DLC}) ` +
        "— that is the extended config WITHOUT the VCU temperature offset. Taking " +
        "batt_temp_lo/batt_temp_hi from 0x200, which is correct for that config. Unset " +
        "CUSTOM_BMS_CONFIG to silence this."
    );
    return;
  }
  trueTemperatureSource = "thermal-frame";
  if (customBmsConfigExpected || warnedThermalFrameUnexpected) return;
  // The dangerous direction: the offset IS flashed but we were told it wasn't, so
  // 0x200's bytes are 15 °C low. Normally nothing has been logged from them, because the
  // keys stay unwritten until a frame settles the question — but say so loudly anyway,
  // since the flag is wrong and only the operator can fix it.
  warnedThermalFrameUnexpected = true;
  console.error(
    "bms: *** CUSTOM_BMS_CONFIG is not set, but extended 0x660 frames " +
      `(DLC >= ${OFFSET_CONFIG_MIN_DLC}) are arriving. *** The custom BMS config IS flashed, so ` +
      "0x200's temperature bytes are shifted 15 °C LOW. Taking batt_temp_lo/batt_temp_hi from " +
      `0x660. If 0x200 had already been flowing for ${THERMAL_FRAME_WAIT_MS} ms when this frame ` +
      "arrived, the keys were briefly fed from 0x200 and those rows are 15 °C cold. " +
      "Set CUSTOM_BMS_CONFIG=1 and restart."
  );
}

// Whether 0x200's temperature bytes are currently KNOWN to be the true pack
// temperature. Never true on a guess: "not established yet" produces the same answer as
// "0x660 owns them" — no row written.
function vcuFrameOwnsTrueTemperature(firstVcuTemperatureAtMs: number): boolean {
  if (trueTemperatureSource !== "unknown") return trueTemperatureSource === "vcu-frame";
  if (Date.now() - firstVcuTemperatureAtMs < THERMAL_FRAME_WAIT_MS) return false;
  if (customBmsConfigExpected) {
    // The flag says the offset config is flashed, and the frame that would carry the
    // true temperature has never arrived. 0x200 is NOT a fallback: under that config its
    // bytes are the shifted view, and writing them here is the exact corruption this
    // module exists to prevent. Leave the gap and say why.
    if (warnedThermalFrameMissing) return false;
    warnedThermalFrameMissing = true;
    console.warn(
      `bms: CUSTOM_BMS_CONFIG is set but no 0x660 arrived within ${THERMAL_FRAME_WAIT_MS} ms of the ` +
        "first 0x200, so nothing on the bus carries the true pack temperature. " +
        "batt_temp_lo/batt_temp_hi stay UNLOGGED until a 0x660 turns up — under this config 0x200's " +
        "bytes are the VCU's 15 °C-shifted view, not the truth. batt_temp_lo_vcu/batt_temp_hi_vcu " +
        "keep logging throughout. If this pack is in fact stock, unset CUSTOM_BMS_CONFIG and the " +
        "true keys resume from 0x200."
    );
    return false;
  }
  // No 0x660 across five of its own broadcast periods while the BMS is demonstrably
  // transmitting, and the flag says stock — that is as close to proof of a stock pack as
  // the bus can give. 0x200 takes the keys and keeps them.
  trueTemperatureSource = "vcu-frame";
  console.log(
    `bms: no 0x660 within ${THERMAL_FRAME_WAIT_MS} ms of the first 0x200 — stock config confirmed, ` +
      "batt_temp_lo/batt_temp_hi now come from 0x200."
  );
  return true;
}
