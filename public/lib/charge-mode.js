// @ts-check

// Whether the bike is charging, and from what.
//
// One rule, asked by everything that needs the answer: the charging screen's hero, its
// delivery tiles, and the view rules in app.js. Its own module with no imports precisely
// so there can only be one — the arrangement this replaces had the hero working out
// AC-vs-DC for itself, and a parked bike read "DC charging" over a card correctly saying
// the pack was delivering 0.1 kW.
//
// ⚠️ The trap that caught two separate readers of this bus: `0x201` byte 0 does NOT
// answer "is it charging". Its three values say whether the BMS is CHARGE-MANAGING,
// which is narrower — 0x10 covers a whole DC session AND the last ~2 s of every AC one,
// so reading it as DC would call a parked bike a fast charge twice a day. Which leaves
// DC with no evidence in this frame at all; it has plenty in 0x102, see
// dcContactorClosed() below. Value by value: docs/dashboard-decisions.md §"What `0x201`
// byte 0 actually says".

/**
 * How recently one of the onboard charger's frames must have arrived to mean it is
 * live.
 *
 * Freshness rather than value is the whole point: the store keeps the last reading
 * of every signal for ever, so `dc_v` reads 400 V until the next reboot whether or
 * not anything is plugged in. Six seconds is thirty frames of margin on 0x305/0x306
 * at 5 Hz, and these four are analog and carry no deadband, so every sample of a
 * charger that is actually running reaches the phone as its own patch.
 */
export const CHARGER_LIVE_MS = 6000;

/**
 * The same question for the contactor bit, and it needs a longer answer: a steady
 * BOOLEAN is only refreshed by ws.ts's 5 s heartbeat, so its apparent age sawtooths
 * 0 → ~5 s and CHARGER_LIVE_MS would leave one second of jitter between a healthy fast
 * charge and this rule falling to "none". 12 s is lib/connection.js's SILENCE_LIMIT_MS,
 * so nothing is claimed here that the page is not already disowning.
 *
 * ⚠️ `stale` is answered by store.js's isStale(), which reports true for EVERY signal
 * while the link is not live — so this rule collapses to "none" the moment a dropout
 * starts. Right for anything DISPLAYING a charge, wrong for an edge detector, which is
 * why lib/view-rules.js holds its edges across a dropout instead of asking this.
 * See docs/dashboard-decisions.md §"CHARGER_LIVE_MS and CONTACTOR_LIVE_MS".
 */
const CONTACTOR_LIVE_MS = 12_000;

/**
 * What is charging the pack, if anything.
 *
 *   "ac"        charging, with the onboard charger's own frames arriving
 *   "dc"        charging, with the DC fast-charge contactor closed
 *   "charging"  charging on the BMS's word, with neither of those confirmed
 *   "none"      not charging
 *
 * Not three: "not AC" is not evidence of DC — inferring it that way is precisely how a
 * parked bike came to read "DC charging". `read` and `stale` are parameters so one rule
 * serves the views, app.js's sampling and a browserless replay.
 * @param {(key: string) => number | null} read
 * @param {(key: string, maxAgeMs: number) => boolean} stale
 * @returns {"ac" | "dc" | "charging" | "none"}
 */
export function chargeMode(read, stale) {
  if (dcContactorClosed(read, stale)) {
    return "dc";
  }
  if (!bmsIsChargeManaging(read)) {
    return "none";
  }
  return isOnboardChargerLive(stale) ? "ac" : "charging";
}

/**
 * True while the DC fast-charge contactor is closed, right now.
 *
 * `fast_dc_contactor` (0x102 b3 bit0) is unambiguous by a wide margin: across the whole
 * 1.1 M-frame corpus it is set in exactly one interval, that interval is a DC fast
 * charge, and it reads 0 through all four AC sessions. Timestamps in src/can/decode.ts.
 *
 * ⚠️ It stopped being the ONLY DC evidence on 2026-08-19, when the charge manager was
 * decoded — but this is deliberately NOT moved onto those signals in the same commit
 * that decoded them: they have never been through a real charge, only through captures.
 * See docs/dashboard-decisions.md §"The DC evidence … deliberately not used yet".
 *
 * @param {(key: string) => number | null} read
 * @param {(key: string, maxAgeMs: number) => boolean} stale
 */
function dcContactorClosed(read, stale) {
  return read("fast_dc_contactor") === 1 && !stale("fast_dc_contactor", CONTACTOR_LIVE_MS);
}

/**
 * True when the BMS says it is running a charge — see the byte-0 note at the top of
 * this file for why that is not the same as "the bike is charging".
 *
 * `charge_state` is a bitfield, not an enum: 1 = discharge, 2 = charge, 4 balancing,
 * 8 trickle, 16 idle, 32 charge-complete, 64 maintenance. Testing it against a single
 * value flags Idle as charging, which is what the old dashboard's `!== 1` did — so
 * this reads the decoded bits instead. Charge-complete is deliberately excluded:
 * current is no longer going in.
 *
 * @param {(key: string) => number | null} read
 */
function bmsIsChargeManaging(read) {
  return read("bms_state_charge") === 1 || read("bms_state_trickle") === 1 || read("bms_state_maintenance") === 1;
}

/**
 * True while the onboard AC charger is talking.
 *
 * 0x300, 0x305, 0x306 and 0x10a's AC setpoint are silent on DC fast charging —
 * verified across a full 40-minute DC session on 2026-08-09, where every one of
 * mains_v, mains_a, dc_v, dc_a, charger_max_dc_v, charger_max_dc_a, charger_enabled
 * and charge_limit_a logged exactly zero readings. So anything sourced from them has
 * to be hidden on DC rather than left showing the last AC value.
 *
 * @param {(key: string, maxAgeMs: number) => boolean} stale
 */
function isOnboardChargerLive(stale) {
  return ["mains_v", "mains_a", "dc_v", "dc_a"].some(key => !stale(key, CHARGER_LIVE_MS));
}
