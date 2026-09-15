// The preview harness, part 2 of 4: the bike it is standing in for.
//
// Every named fixture the two preview pages serve, plus the scene the URL selected and the
// live signal table patches are written into. The contract and the injection order are in
// scripts/preview-harness.ts; the strings that may not appear here are in
// scripts/preview-harness-browser.js's header.
//
// ⚠️ These literals are TYPE-CHECKED against the Pi's own payload types by
// scripts/check-preview-fixtures.ts, which lifts each one out by name and hands it to tsc.
// Keep them whole literals: a fixture assembled per scene is a fixture it can no longer read,
// which is why the per-scene overlays live in each template instead of in here.

// ── this bike ────────────────────────────────────────────────────────────────
//
// Numbers from the Ribelle rather than placeholders: the sweep read 233 of 277
// parameters seventeen minutes ago, MAX_DC_CHG_CURRENT holds 75, both micros name
// parameter table 16407, and the stored codes include the water-pump open circuit
// that has been there since before anyone started looking.

const NOW = Date.now();
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const SWEPT_AT = NOW - 17 * MINUTE;

/**
 * Which bike this preview is standing in for, chosen with `?scene=` in the URL.
 *
 * ⚠️ A query string, and neither the hash nor a control on the page. The hash is the app's tab
 * router and the preview hands `location.hash` straight to it; a control of the page's own would
 * weaken this file's whole claim, which is that what you see is what the bike serves. `SCENES` is
 * each page's — the two stand in for different bikes — but the SPELLING is shared, because two
 * vocabularies for one bike is how a state gets added to one page and never exists in the other,
 * and it is what scripts/preview-scenes.ts greps for.
 */
const WANTED_SCENE = new URLSearchParams(window.location.search).get("scene");
// ⚠️ hasOwn, not a bare lookup: `?scene=constructor` would otherwise select a function.
const SCENE_NAME = WANTED_SCENE !== null && Object.hasOwn(SCENES, WANTED_SCENE) ? WANTED_SCENE : "parked";
if (WANTED_SCENE !== null && WANTED_SCENE !== SCENE_NAME) {
  console.warn(
    `preview: there is no scene called "${WANTED_SCENE}" — showing parked. Try ${Object.keys(SCENES).join(", ")}.`
  );
}
const SCENE = SCENES[SCENE_NAME];

/**
 * ⚠️ ONE gate object, declared ABOVE every fixture that references it: `const` has a temporal
 * dead zone and the fixtures are built as this file is evaluated, so putting it beside the
 * scene that mutates it rendered a blank page.
 *
 * A plain literal, and it has to stay one: check-preview-fixtures.ts splices this declaration
 * into WRITE_STATUS, READ_STATE and LIFETIME_READ to type-check them, which needs a literal —
 * and all three capture the same REFERENCE, which is why each page applies its scene by mutating
 * this object rather than by building a different one. docs/diagnostics-and-checks.md §11.10.
 */
const GATE = { safe: true, blockers: [], chargingEvidence: null, checks: [] };

const SWEPT = {
  MAX_DC_CHG_CURRENT: { value: 75, rawHex: "4B", label: "75 A", readAt: SWEPT_AT, complete: true },
  FCHG_CURRENT_GAIN: {
    value: 225,
    rawHex: "00E1",
    label: "225 (raw — the unit is not known)",
    readAt: SWEPT_AT,
    complete: true,
  },
  TORQUE_LIMIT: { value: 2300, rawHex: "08FC", label: "230.0 Nm", readAt: SWEPT_AT, complete: true },
  REGEN_TORQUE_LIMIT: { value: 600, rawHex: "0258", label: "60.0 Nm", readAt: SWEPT_AT, complete: true },
  VSM_CONFIG_1: { value: 0x1113, rawHex: "1113", label: "0x1113", readAt: SWEPT_AT, complete: true },
};

const TARGETS = [
  {
    name: "MAX_DC_CHG_CURRENT",
    index: 258,
    micro: "A9",
    purpose:
      "The DC fast-charge current this bike advertises to a charger, in amperes. Reads 75. Energica's own 60/75/80 A options write this parameter and nothing else, so 80 is a value the factory shipped.",
    warnings: [
      "⚠️ It will probably do nothing. Across eight logged DC sessions the ceiling is the STATION, not the bike: station identity explains 84 % of the variance, the highest ever delivered is 73.2 A, and no station has offered even the 75 A already permitted.",
      "⚠️ 80 A is 1.25C for this pack. The cell datasheet allows 1.10C = 70.4 A, and only between 25 and 35 °C — and the VCU is shown 35 °C while the pack is really at 44-54 °C, so 91 % of DC charging time above 30 A is already over the cell's fast-charge ceiling.",
      "Free check afterwards, no charger needed: 0x625 b2 is the configured max DC current and is broadcast on a merely-awake bike. It should change from 0x4B to 0x50.",
      "A dealer visit reverts it. The service tool reinstalls parameter values from Energica's server, keyed by VIN.",
    ],
    control: { kind: "number", min: 0, max: 80, minLabel: "0 A", maxLabel: "80 A" },
    verify:
      "Free check, no charger needed: 0x625 b2 is the configured max DC current and is broadcast on a merely-awake bike.",
    onBike: SWEPT.MAX_DC_CHG_CURRENT,
  },
  {
    name: "FCHG_CURRENT_GAIN",
    index: 259,
    micro: "A9",
    purpose:
      "An EVSE-block scalar whose meaning has never been established. Reads 225. Absent from Energica's tooling entirely — no option, no label, no range, no code path.",
    warnings: ["⚠️⚠️ THE DIRECTION OF EFFECT IS UNKNOWN.", "Change ONE parameter per charge session."],
    control: { kind: "number", min: 0, max: 512, minLabel: "0 (raw)", maxLabel: "512 (raw)" },
    verify: "No broadcast field carries this one, so the read-back above is the only confirmation.",
    onBike: SWEPT.FCHG_CURRENT_GAIN,
  },
  {
    name: "TORQUE_LIMIT",
    index: 48,
    micro: "A9",
    purpose: "The drive torque ceiling, 0.1 Nm per count. Reads 230.0 Nm.",
    warnings: ["⚠️ Raising this raises what the bike will deliver at full throttle."],
    control: { kind: "number", min: 0, max: 2760, minLabel: "0.0 Nm", maxLabel: "276.0 Nm" },
    verify: "Nothing broadcasts this, so the read-back above is the only confirmation.",
    onBike: SWEPT.TORQUE_LIMIT,
  },
  {
    name: "REGEN_TORQUE_LIMIT",
    index: 49,
    micro: "A9",
    purpose: "The regenerative braking torque ceiling, 0.1 Nm per count. Reads 60.0 Nm.",
    warnings: ["⚠️ REGEN_MAP0..3_TRQ (63-66) are almost certainly PERCENTAGES of this limit."],
    control: { kind: "number", min: 0, max: 900, minLabel: "0.0 Nm", maxLabel: "90.0 Nm" },
    verify: "Nothing broadcasts this either — the read-back above is the confirmation.",
    onBike: SWEPT.REGEN_TORQUE_LIMIT,
  },
  {
    name: "VSM_CONFIG_1",
    index: 16,
    micro: "A9",
    purpose:
      "The VCU's option word. Only the heated-handlebar bit is offered here; the same word also carries the PSU type and the Bluetooth variant.",
    warnings: [
      "⚠️ The whole word is NOT writable through this repo, on purpose.",
      "⚠️ A successful write does NOT mean the feature turned on. See the bit's own note.",
      "This changes a flag, not wiring. There is no heated-grip circuit on this bike unless one was fitted.",
    ],
    control: {
      kind: "bits",
      bits: [
        {
          key: "heated-handlebars",
          mask: 4,
          label: "Heated handlebars",
          caveat:
            "Energica's option OP0024 sets exactly this bit and nothing else — but activation is normally granted per-VIN on Energica's server. Config words are only read at boot: key-cycle before judging it.",
        },
      ],
    },
    verify: "⚠️ Config words are only read at BOOT: key-cycle the bike before judging it.",
    onBike: SWEPT.VSM_CONFIG_1,
  },
];

/** The journal, newest first — the record of what has been done to this motorcycle. */
const JOURNAL = [
  {
    at: NOW - 2 * DAY,
    clockTrustworthy: true,
    action: "read-service-stamp",
    status: "read",
    before: "2000-01-01T00:00:00.000Z",
    after: 0,
  },
  {
    at: NOW - 9 * DAY,
    clockTrustworthy: true,
    action: "parameter-write",
    name: "MAX_DC_CHG_CURRENT",
    before: 80,
    after: 75,
    status: "written",
  },
  { at: NOW - 26 * DAY, clockTrustworthy: false, action: "clear-dtcs", status: "cleared" },
];

const WRITE_STATUS = {
  enabled: true,
  // ⚠️ Both of these were missing until 2026-09-08, and the first one is why this file now
  // has a check of its own: views/vcu-write.js destructures `runningVersion`, so the binding
  // threw, the section froze on Availability()'s "waiting for an answer" ellipsis, and the
  // safety-gate line and ⚙️ Running were absent from twelve days of screenshots. A FIXED
  // label rather than this checkout's real commit: a review instrument whose text — and
  // whose amber +dirty colour — changed with the reader's git state would be worse.
  runningVersion: { commit: "7f6dbcd", dirty: false, trustworthy: true, label: "7f6dbcd" },
  // Null is "nothing commanded this session", which is the honest answer off a charge. The
  // DC scene replaces it with a settled verdict, since that is the line #153 added.
  chargeAck: null,
  // ⚠️ No `readings` here. It is on ServiceGateEvidence, the gate's INPUT, and never on the
  // verdict the Pi sends — one of three fields the fixture had invented.
  gate: GATE,
  tableGate: {
    state: "confirmed",
    writesAllowed: true,
    noReadWillHelp: false,
    reason: "Both micros name table 16407, which is a table this software carries.",
    remedy: "",
    outstanding: [],
    tableType: 16407,
  },
  // ⚠️ PiClockVerdict is a UNION, and `reasons` belongs to its untrustworthy arm alone. A
  // trustworthy verdict carrying an empty `reasons` is a shape the Pi cannot produce.
  clock: {
    trustworthy: true,
    iso: new Date(NOW).toISOString(),
    offsetFromGpsSeconds: 0.2,
  },
  // ⚠️ Both null HERE, and filled in by `writeStatus()` below: since #107 they are the two
  // request-dependent halves of this payload — three fields for all 269 names when the
  // caller wants the list, everything else for the ONE target it named. Built from TARGETS
  // rather than restated, so the picker cannot offer a name the detail branch does not have.
  targets: null,
  detail: null,
  recent: JOURNAL,
  busHeldBy: null,
};

/**
 * What a lifetime-statistics read answers with (#177), in the shape src/http/lifetime-read.ts
 * serves. `measurement` is the Pi timing ITSELF during the read — how late its flow control
 * was, and the worst event-loop delay over the exchange — so a preview with no bus cannot
 * have measured one. The numbers here are this fixture's own; the SENTENCE is the shape
 * describeMeasurement() builds, so the panel is laid out as a real answer lays it out.
 */
const LIFETIME_READ = {
  measurement: "flow control 2.4 ms after the kernel saw the First Frame · worst event-loop delay 1.8 ms",
  answered: 2,
  message: null,
  gate: GATE,
};

const STATUS = {
  uptimeSeconds: 4173,
  waypoints: 4,
  waypointsRefused: 4,
  // Four saves and four refusals in FIRE order, as src/gps/waypoint-log.ts keeps them.
  // Eight against a six-row preview, so the toggle and the "showing the newest 6"
  // sentence are both on screen in the design gate; the newest of each outcome agrees
  // with `waypoint_seq` / `waypoint_refusal` in PARKED_SIGNALS. Two constraints carry
  // the rest: every save is the one Greenwich fixture point this repo allows
  // (docs/route-map.md §"No coordinates anywhere"), and the code-6 refusal is pinned
  // BY ITS TEXT in scripts/check-phone-width.ts — the longest sentence in
  // WAYPOINT_REFUSAL_TEXT, and the `clockTrustworthy: false` row. Why each:
  // docs/waypoints.md §"What the list can and cannot be short of".
  waypointEvents: [
    { outcome: "saved", sequence: 1, latitudeDeg: 51.4779, longitudeDeg: -0.0015, at: NOW - 95 * MINUTE },
    { outcome: "refused", refusal: 6, at: NOW - 51 * MINUTE, clockTrustworthy: false },
    { outcome: "saved", sequence: 2, latitudeDeg: 51.4779, longitudeDeg: -0.0015, at: NOW - 47 * MINUTE },
    { outcome: "refused", refusal: 3, at: NOW - 39 * MINUTE, clockTrustworthy: true },
    { outcome: "saved", sequence: 3, latitudeDeg: 51.4779, longitudeDeg: -0.0015, at: NOW - 22 * MINUTE },
    { outcome: "refused", refusal: 1, at: NOW - 14 * MINUTE, clockTrustworthy: true },
    { outcome: "saved", sequence: 4, latitudeDeg: 51.4779, longitudeDeg: -0.0015, at: NOW - 6 * MINUTE },
    { outcome: "refused", refusal: 8, at: NOW - 3 * MINUTE, clockTrustworthy: true },
  ],
  log: { files: 13, bytes: 4812442, enabled: true },
  groups: {
    battery: [17, 46],
    cells: [81, 81],
    charge: [8, 8],
    coolant: [4, 4],
    drive: [11, 11],
    gps: [9, 9],
    obd: [6, 6],
  },
};

/**
 * The last parameter sweep, and any sweep started from the preview.
 *
 * Shared across panels because there is one bike: a sweep started in the full-sheet
 * panel is the same sweep every other panel would be watching.
 */
const READ_STATE = {
  // ⚠️ No `expected` on a finished sweep: VcuReadState's `finished` arm does not carry it,
  // only `running` does. Nothing on screen changes — views/service-mode.js reads it in the
  // running branch alone — which is exactly why it sat here unnoticed.
  run: {
    phase: "finished",
    startedAt: SWEPT_AT,
    finishedAt: SWEPT_AT + 41000,
    complete: true,
    tally: {
      total: 277,
      read: 233,
      // ⚠️ All eight, because tallyOf() seeds every status at 0 (src/vcu/read-runner.ts) —
      // the Pi never sends a partial one, and views/service-mode.js reads the record.
      byStatus: {
        "read": 233,
        "refused": 30,
        "no-response": 14,
        "no-session": 0,
        "stalled": 0,
        "abandoned": 0,
        "unrecognised": 0,
        "not-sent": 0,
      },
      micros: [
        { micro: "A9", read: 201, failed: 22 },
        { micro: "A8", read: 32, failed: 22 },
      ],
    },
  },
  gate: GATE,
  enabled: true,
  export: { rows: 233, readAt: SWEPT_AT, complete: true },
  message: null,
};

// ── the bike on the wire ─────────────────────────────────────────────────────
//
// `[value, unit, group]`, and optionally the moment it was recorded. Left off, a reading is
// stamped when the message carrying it goes out — which is what src/can/signals.ts's
// record() does for anything whose frame keeps arriving, and why a parked bike's tiles do
// not dim. Given, the reading is an EVENT: the waypoint trio keeps the moment it was saved,
// because views/trip-stats.js PRINTS that time, and re-stamping it would walk the clock in
// the Waypoints tile forward by five seconds every five seconds.

const PARKED_SIGNALS = {
  "soc": [58, "%", "battery"],
  "pack_v": [346.8, "V", "battery"],
  "pack_kw": [0.1, "kW", "battery"],
  "cell_min_mv": [3612, "mV", "cells"],
  "cell_max_mv": [3641, "mV", "cells"],
  "cell_spread_mv": [29, "mV", "cells"],
  "range_km": [96, "km", "energy"],
  "coolant_in": [31.4, "°C", "coolant"],
  "coolant_out": [34.9, "°C", "coolant"],
  "odometer_can_km": [14849.4, "km", "drive"],
  "gps_speed_kmh": [0, "km/h", "gps"],
  "gps_altitude_m": [84, "m", "gps"],
  "gps_course_deg": [228, "°", "gps"],
  "gps_satellites": [11, "", "gps"],
  // A waypoint, so the Waypoints tile has something to draw in the preview.
  // Greenwich, deliberately: a coordinate everyone recognises as a fixture, and
  // one nobody can mistake for where this bike is kept. docs/route-map.md
  // §"No coordinates anywhere" is why it is not a real one.
  "waypoint_seq": [4, "", "waypoint", NOW - 6 * MINUTE],
  "waypoint_lat": [51.4779, "°", "waypoint", NOW - 6 * MINUTE],
  "waypoint_lon": [-0.0015, "°", "waypoint", NOW - 6 * MINUTE],
  // And a refusal, so the code has a tile to be drawn in. ⚠️ It is the NEWEST code
  // (FIX_UNCORROBORATED, #178) on purpose: public/lib/bounds.js gates this key to the
  // size of the enum, so a code added without widening that bound renders as a dead
  // sensor rather than as a number — which is a thing a screenshot can catch and a
  // check cannot phrase as well.
  "waypoint_refused_seq": [4, "", "waypoint", NOW - 3 * MINUTE],
  "waypoint_refusal": [8, "", "waypoint", NOW - 3 * MINUTE],
  // Two codes the bike is holding. 0044/0 is the water-pump open circuit — real,
  // and permanent on this bike, because the coolant pump is wired to the
  // heated-grip output and the VCU's own pump driver is left open.
  // 0x101 VCU_VEHICLE_STS and the rest of 0x102's named bits, added 2026-09-14. Every
  // value here is what the real frames say a PARKED bike publishes, byte for byte:
  // 0x101 reads `3E 3C 04 04 64 00 00 00` (state 60 / substate 62 — the pair the
  // engineering menu shows) and 0x102's byte 3 reads 0x44. They are in the fixture so
  // the ALL tab's new `vcu` section and the four new `controls` tiles render at all —
  // that page builds its sections from the signals that have ARRIVED, so an unlisted
  // key is an invisible one and the design gate would be looking at nothing.
  "vehicle_state_can": [60, "", "drive"],
  "vehicle_substate_can": [62, "", "drive"],
  "drive_vsm": [4, "", "drive"],
  "drive_vsm_b3": [0, "", "drive"],
  "limp_pack_res": [100, "", "vcu"],
  "limp_module_word": [0, "", "vcu"],
  "vehicle_status_flags": [4, "", "vcu"],
  "limp_mode_status": [1, "", "diag"],
  "limp_res_valid": [0, "", "diag"],
  "horn_switch": [0, "", "controls"],
  "blinker_switch_left": [0, "", "controls"],
  "blinker_switch_right": [0, "", "controls"],
  "low_beam_switch": [1, "", "controls"],
  "dsb_control": [1, "", "diag"],
  "imd_disable": [0, "", "diag"],
  "winter_storage": [0, "", "diag"],
  "mag_good": [1, "", "diag"],
  "vcu_abs_off": [0, "", "diag"],
  "dtc_0044_0": [1, "", "diag"],
  "dtc_0002_0": [1, "", "diag"],
  "dtc_count": [2, "", "diag"],
};

/** Everything the bike is broadcasting right now. Patches write here, so a snapshot carries them. */
const LIVE = Object.assign({}, PARKED_SIGNALS, SCENE.signals);
