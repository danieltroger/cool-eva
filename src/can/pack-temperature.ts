import type { DecodedValue } from "./frame.ts";

// Decides which frame is allowed to write batt_temp_lo / batt_temp_hi.
//
// Those two keys have years of history behind them and must keep meaning the TRUE
// pack temperature. Under the VCU-offset BMS config they can no longer come from
// 0x200, whose bytes are shifted down 15 °C — but under every earlier config 0x200 is
// the only source there is. Which one applies is knowable only from a *different*
// frame (0x660's length), and decoders are pure by rule, so this is the one place
// that holds that bit of state.
//
// This is routing, not deriving: no value is computed here. A measured byte is either
// passed through under its historical key or left alone.
//
// Failure mode is deliberately "stale, not wrong". If 0x660 stops arriving under the
// offset config, batt_temp_* simply stops updating rather than silently reverting to
// readings that are 15 °C cold.

const PACK_THERMAL_FRAME_ID = 0x660;

// 0x660 is DLC 3 before the offset config and DLC 8 after. Bytes 3-4 (true pack temp
// high/low) exist only in the long form.
const OFFSET_CONFIG_MIN_DLC = 5;

// A pack on the stock config never sends 0x660 at all, so absence of evidence has to
// become evidence eventually. 0x660 is 1 Hz, so a few seconds of 0x200 traffic with
// no 0x660 means it isn't coming — and waiting that long at startup is what stops an
// offset-config pack from logging one 15 °C-cold sample before its first 0x660 lands.
const CONFIG_DETECTION_TIMEOUT_MS = 5000;

const VCU_TEMPERATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["batt_temp_lo_vcu", "batt_temp_lo"],
  ["batt_temp_hi_vcu", "batt_temp_hi"],
];

let vcuOffsetConfigSeen = false;
let directConfigSeen = false;
const startedAtMs = Date.now();

/**
 * Takes what a frame decoded to and returns what should actually be recorded, adding
 * batt_temp_lo / batt_temp_hi from 0x200's bytes when — and only when — no VCU offset
 * is in play. Stateful: it learns the config from 0x660's length as frames arrive.
 */
export function resolvePackTemperatures(id: number, data: Buffer, decoded: DecodedValue[]): DecodedValue[] {
  if (id === PACK_THERMAL_FRAME_ID) {
    // Most recent 0x660 wins, so a reflash in either direction recovers within a
    // second instead of needing a restart.
    vcuOffsetConfigSeen = data.length >= OFFSET_CONFIG_MIN_DLC;
    directConfigSeen = !vcuOffsetConfigSeen;
    return decoded;
  }
  if (vcuOffsetConfigSeen) return decoded; // 0x660 owns the true temperatures
  if (!directConfigSeen && Date.now() - startedAtMs < CONFIG_DETECTION_TIMEOUT_MS) {
    return decoded; // still waiting to find out whether a long 0x660 exists
  }
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
