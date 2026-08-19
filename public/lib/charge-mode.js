// @ts-check

// Whether the bike is charging, and from what.
//
// One rule, asked by everything that needs the answer: the charging screen's hero,
// its delivery tiles, and the view rules in app.js. Its own module with no imports
// precisely so there can only be one — the arrangement this replaces had the hero
// working out AC-vs-DC for itself, and a parked bike read "DC charging" directly
// above a card correctly saying the pack was delivering 0.1 kW.
//
// The trap underneath that is worth stating on its own, because it caught two
// separate readers of this bus: `0x201` byte 0 does NOT answer "is it charging".
// Across ~24 M frames it takes exactly three values — 0x01, 0x02, 0x10 — and what
// they mean is whether the BMS is CHARGE-MANAGING, which is a narrower question:
//
//   0x01  not charging. Parked at −0.2 A and riding at −166 A alike.
//   0x02  AC charging. The BMS is running the charge.
//   0x10  the BMS is not charge-managing. That covers a whole DC session, where the
//         current bypasses the BMS charge path — and also the last ~2 s of every AC
//         session, at −0.1 A. So it is not "DC", and reading it as DC would call a
//         parked bike a fast charge twice a day.
//
// Which leaves DC with no evidence in this frame at all. It has plenty in 0x102 —
// see dcContactorClosed() below.

/**
 * How recently a signal must have arrived to be evidence about right now.
 *
 * Freshness rather than value is the whole point: the store keeps the last reading
 * of every signal for ever, so `dc_v` reads 400 V until the next reboot whether or
 * not anything is plugged in, and a contactor that closed at yesterday's charger
 * still reads 1 today. Six seconds is thirty frames of margin on 0x305/0x306 at
 * 5 Hz, and six hundred on 0x102 at 100 Hz.
 */
export const CHARGER_LIVE_MS = 6000;

/**
 * What kind of charge is happening, if any.
 *
 * `read` and `stale` are parameters rather than direct store calls so that one rule
 * can serve both the subscribing views and the tick-paced sampling in app.js, and so
 * it can be replayed against decoded frames with no browser at all
 * (scripts/check-charge-mode.ts). `stale` must report true for a key that has never
 * arrived, which is what store.js does.
 *
 * @param {(key: string) => number | null} read
 * @param {(key: string, maxAgeMs: number) => boolean} stale
 * @returns {"ac" | "dc" | "none"}
 */
export function chargeMode(read, stale) {
  if (dcContactorClosed(read, stale)) {
    return "dc";
  }
  if (!bmsIsChargeManaging(read)) {
    return "none";
  }
  // A charge is happening and it is not DC, so it is the onboard charger's — but
  // which TILES are worth drawing is a second question, because the AC set is
  // sourced entirely from the charger's own frames. If those have gone quiet the
  // pack-side set is the honest one, the same way it is at a fast charger; leaving
  // the AC tiles up would show the last values of a session that has ended, which
  // is what made this screen useless away from a wall socket.
  return isOnboardChargerLive(stale) ? "ac" : "dc";
}

/**
 * True while the DC fast-charge contactor is closed, right now.
 *
 * `fast_dc_contactor` (0x102 b3 bit0) is the only unambiguous DC evidence on this
 * bus, and it is unambiguous by a wide margin: across the whole 1.1 M-frame corpus
 * it is set in exactly one interval, that interval is a DC fast charge, and it reads
 * 0 through all four AC sessions — including a 48-minute one at 14 A mains. It also
 * LEADS the charge, rising 190 ms before `charger_enabled` and ~470 ms before the
 * first positive pack amp, which is what a contactor monitor should do. The full
 * argument and the timestamps are in src/can/decode.ts.
 *
 * @param {(key: string) => number | null} read
 * @param {(key: string, maxAgeMs: number) => boolean} stale
 */
function dcContactorClosed(read, stale) {
  return read("fast_dc_contactor") === 1 && !stale("fast_dc_contactor", CHARGER_LIVE_MS);
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
