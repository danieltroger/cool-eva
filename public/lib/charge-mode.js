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
 * The same question for the contactor bit, and it needs a longer answer.
 *
 * A steady BOOLEAN does not reach the phone the way a moving analog value does.
 * `fast_dc_contactor` sits at 1 for the whole of a fast charge — 1038 s in the one
 * captured session — and signals.ts patches a signal only when its value moves, so
 * nothing refreshes this one's timestamp except ws.ts's 5 s full-snapshot heartbeat,
 * while `serverTime` advances on every 20 Hz pack_a patch. Its apparent age on the
 * dashboard therefore sawtooths 0 → ~5 s, and CHARGER_LIVE_MS would leave a single
 * second of heartbeat jitter between a healthy fast charge and this rule falling all
 * the way to "none" — the BMS reports Idle throughout a DC session, so there is
 * nothing behind it to catch the fall. That tears down the DC tiles and their
 * sparklines and, through autoFocus(), throws the rider off the charge tab and back
 * again on the next heartbeat.
 *
 * 12 s is lib/connection.js's own SILENCE_LIMIT_MS: past that the dashboard has
 * already decided the whole link is down — it says so in the header, drops the socket
 * and opens another — so nothing is claimed here that the page is not already
 * disowning. It costs nothing at the other end of a session either: unplugging moves
 * the bit 1 → 0, which patches immediately, so this gate is only ever the backstop
 * against a store that never forgets.
 *
 * ⚠️ `stale` is answered by store.js's isStale(), which now reports true for EVERY
 * signal while the link is not live. So this rule does not merely age out during a
 * dropout — it collapses to "none" the moment one starts, since the BMS's Idle leaves
 * nothing behind the contactor bit. That is the right answer for anything DISPLAYING a
 * charge, which is what this rule is for, and the wrong one for an edge detector; which
 * is why lib/view-rules.js holds its edges across a dropout instead of asking this.
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
 * Four values rather than three because the source is a separate fact from whether a
 * charge is happening, and only one of them always has evidence. "Not AC" is not
 * evidence of DC — inferring it that way is precisely how a parked bike came to read
 * "DC charging" — and "not DC" is no more evidence of AC, so the fourth value exists
 * to be honest about the case where the bus says a charge is running but nothing
 * says what kind. Callers naming a source to the rider may only name it for "ac" and
 * "dc"; the tile sets are a separate choice, made in views/charge.js.
 *
 * `read` and `stale` are parameters rather than direct store calls so that one rule
 * can serve both the subscribing views and the tick-paced sampling in app.js, and so
 * it can be replayed against decoded frames with no browser at all
 * (scripts/check-charge-mode.ts). `stale` must report true for a key that has never
 * arrived, which is what store.js does.
 *
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
 * `fast_dc_contactor` (0x102 b3 bit0) is the only unambiguous DC evidence on this
 * bus, and it is unambiguous by a wide margin: across the whole 1.1 M-frame corpus
 * it is set in exactly one interval, that interval is a DC fast charge, and it reads
 * 0 through all four AC sessions — including a 48-minute one at 14 A mains. It also
 * LEADS the charge, rising 190 ms before `charger_enabled` and ~470 ms before the
 * first positive pack amp, which is what a contactor monitor should do. The full
 * argument and the timestamps are in src/can/decode.ts.
 *
 * ⚠️ "the only unambiguous DC evidence" stopped being true on 2026-08-19, when the charge
 * manager was decoded (src/can/charge-manager.ts). There are now three more, all measured
 * across 29 charge sessions rather than the single interval above: `charge_manager_state`
 * (0x610 b7) reads 0x23 on DC and 0x02 on AC in 100.000 % of 44 444 frames, `charge_type`
 * (0x605 b2) is 1/2, and `dc_charging` / `ac_charging` (0x625 b4) say whether current is
 * actually flowing rather than whether a session exists — a distinction this file currently
 * cannot make. That last pair would also retire the freshness dance below, since they go to
 * 0 by themselves instead of needing CONTACTOR_LIVE_MS to decide a stale 1 is over.
 *
 * This function is deliberately NOT changed in the same commit that decoded its replacement:
 * the new signals have never been through a real charge on the bike, only through captures,
 * and swapping the screen's one charge rule onto them before that is exactly the kind of
 * change that should wait for evidence it cannot get from a laptop.
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
