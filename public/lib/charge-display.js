// @ts-check
// Fresh signed delivery and source evidence: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { connection, isStale, isStaleSampled, peek, valueOf } from "./store.js";
import { freshValue, readingHasFault, readingStatus, statusWord } from "./reading-status.js";
import { chargeMode } from "./charge-mode.js";
import { CHARGE_SESSION_MAX_AGE_MS } from "./charge-write.js";
import { power } from "./format.js";
import { BAD, CALM, FLOW, GOOD, MUTED } from "./colors.js";

/** @param {boolean} [sampled] */
export function currentChargeMode(sampled = false) {
  if ((sampled ? connection.rawVal : connection.val) !== "live") return "none";
  const stale = sampled ? isStaleSampled : isStale;
  return chargeMode(
    key => {
      if (
        readingHasFault(key, sampled) ||
        (["bms_state_charge", "bms_state_trickle", "bms_state_maintenance"].includes(key) &&
          stale(key, CHARGE_SESSION_MAX_AGE_MS))
      ) {
        return null;
      }
      return sampled ? peek(key) : valueOf(key);
    },
    (key, age) => readingHasFault(key, sampled) || stale(key, age)
  );
}

export const displayChargeMode = van.derive(() => currentChargeMode());

/** @param {boolean} [sampled] */
export function chargePowerDisplay(sampled = false) {
  const status = readingStatus("pack_kw", sampled);
  const value = freshValue("pack_kw", sampled);
  if (value === null) {
    return { label: "POWER", magnitude: statusWord(status), unit: "", color: status === "fault" ? BAD : MUTED, status };
  }
  const magnitude = power(Math.abs(value));
  if (Number(magnitude) === 0) return { label: "POWER", magnitude: "0.0", unit: "kW", color: CALM, status };
  return {
    label: value < 0 ? "POWER OUT" : currentChargeMode(sampled) === "none" ? "POWER IN" : "CHARGING",
    magnitude,
    unit: "kW",
    color: value < 0 ? FLOW : GOOD,
    status,
  };
}
