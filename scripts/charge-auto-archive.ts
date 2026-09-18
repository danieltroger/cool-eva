import { CLIFF_C, decideChargeCurrent } from "../src/charge/auto-curve.ts";
import { newestSampleAtOrBefore, RATE_WINDOW_MS, type TemperatureSample } from "../src/charge/rate.ts";
import { SOC_WINDOW_MS, type SocSample } from "../src/charge/soc.ts";
import type { ArchiveSession } from "./archive-session.ts";
import { ARCHIVE_SESSIONS } from "./charge-archive-sessions.ts";

// Every DC session on record, driven through the rule twice: once against the logged temperature
// (what it would DECIDE) and once against a plant measured from the same archive (what would then
// HAPPEN). Data and arithmetic only — nothing here opens a database or talks to a bus.
//
// ⚠️ WHY TWICE, AND WHICH ANSWERS WHAT. An open-loop replay cannot score cliff crossings: the
// temperature trace is the one the bike really produced, so every rule sees the same crossings
// whatever it commands, and "crosses 55 no more often" would be true by construction. It is the
// right tool for what a rule DECIDES on real rings — the command's size, when it moves, whether it
// settles near the current the session itself demonstrated. The closed loop is the only one that
// can answer crossings, trains and charge delivered, and it pays for that with a model.
//
// ⚠️ THE MODEL IS MEASURED, unlike scripts/charge-auto-plant.ts's, which was fitted to two anchors
// from one day and whose sensitivity to current #279 measured as 2.4-5.3x too large. This one is
// the two-node balance from the post-55 recovery analysis over 56 crossings — heat in is I²R with
// R from docs/pack-resistance.md, heat out is a conductance to the loop's own logged inlet — and
// it is run at BOTH ends of the fitted k and C so a conclusion that depends on which end is chosen
// cannot hide. docs/charge-auto.md § "Riding the setpoint".

/** Pack resistance at 50-54 °C, ohms. docs/pack-resistance.md, measured, flat in SOC. */
const PACK_OHMS = 0.061;

/**
 * The pack-to-loop conductance and the hot node's heat capacity, at both ends of the fit.
 *
 * ⚠️ A RANGE, not a number, and every conclusion is reported at both ends. `k` sets where the pack
 * settles for a given current and `C` sets how fast it gets there; the post-55 analysis bounds them
 * at 7.3-8.6 W/K and 13-15 kJ/K over 56 crossings. Sanity, against the bike: 72.6 A at a 36 °C
 * inlet gives 0.8-1.0 K/min through the fifties, and 2026-09-18 measured 0.65-1.00.
 */
export const PLANT_CORNERS = [
  { name: "k7.3/C15", wattsPerKelvin: 7.3, joulesPerKelvin: 15_000 },
  { name: "k8.6/C13", wattsPerKelvin: 8.6, joulesPerKelvin: 13_000 },
];

/**
 * What the pack draws once the reading reaches 55 and the BMS clamp releases, and until the
 * reading comes back to 54. Measured: the current collapses to ~19.5 A, and #280 found no
 * hysteresis — it recovers a median +12 A the moment the reading returns.
 */
const DERATED_A = 19.5;

/**
 * How long the derate holds once it has released the clamp, at minimum.
 *
 * ⚠️ WITHOUT THIS THE MODEL CHATTERS AT 1 Hz and the crossing count is meaningless: the reading is
 * `floor(T)`, so a pack sitting at 54.999 re-enters 55 the second the current comes back, and the
 * do-nothing baseline scored 25 545 crossings against the 15-in-48-minutes the bike actually
 * produced on 2026-09-07. The BMS clamp is not instantaneous and #280 measured what it does
 * instead: the saw-tooth it produces has a period of about a minute, 31 of 50 charging crossings
 * returning 55 → 54 inside one. So the clamp holds for a minute, which reproduces that period
 * rather than inventing a hysteresis band nobody has measured.
 */
const DERATE_HOLD_MS = 60_000;

/** How often the controller re-decides. Mirrors AUTO_TICK_MS without importing the runner. */
const TICK_MS = 60_000;

export interface SessionRun {
  name: string;
  /** Every current the rule commanded, in order. */
  commands: number[];
  /** The same, with when each landed and whether it was a raise — what a property over ticks needs. */
  commandsAt: { atMs: number; amps: number; raised: boolean }[];
  /** Closed loop only: the peak true temperature, and every crossing into a reading of 55. */
  peakC: number;
  crossings: number;
  /** The longest run of crossings less than ten minutes apart — the train #280 is about. */
  longestTrain: number;
  /** Amp-hours the pack took over the session, and per minute: the number Daniel charges by. */
  ampHours: number;
  minutes: number;
}

/**
 * Replays one session against the logged temperature — what the rule DECIDES, never what happens.
 *
 * `phaseSeconds` shifts the tick grid: the bike's own ticks landed on :18 and :39, so a fixture on
 * one phase is one of sixty possible traces and every caller here sweeps all of them.
 */
export function replayOpenLoop(session: ArchiveSession, phaseSeconds: number): SessionRun {
  const temperature = parseSamples(session.temperature);
  const socSamples = parseSoc(session.soc);
  const requested = parseRows(session.requested);
  const commands: number[] = [];
  const commandsAt: SessionRun["commandsAt"] = [];
  let commandedAmps: number | null = null;
  let lastCommandAtMs: number | null = null;
  for (let nowMs = phaseSeconds * 1000; nowMs <= session.spanMs; nowMs += TICK_MS) {
    const newest = newestSampleAtOrBefore(temperature, nowMs);
    if (newest === undefined) {
      continue;
    }
    const reading = newest.celsius;
    const decision = decideChargeCurrent({
      enabled: true,
      packTemperatureC: reading,
      packTemperatureAgeMs: 100,
      packTemperaturePlausible: true,
      chargeManagerState: 0x23,
      chargeManagerStateAgeMs: 100,
      ceilingAmps: session.ceilingAmps,
      commandedAmps,
      riderOverride: false,
      samples: ringAt(temperature, nowMs),
      socPercent: valueAt(
        socSamples.map(soc => ({ atMs: soc.atMs, value: soc.percent })),
        nowMs
      ),
      socAgeMs: 100,
      socSamples: socRingAt(socSamples, nowMs),
      requestedAmps: valueAt(requested, nowMs),
      lastCommandAtMs,
      nowMs,
    });
    if (decision.kind === "command") {
      commandsAt.push({
        atMs: nowMs,
        amps: decision.amps,
        raised: decision.amps > (commandedAmps ?? session.ceilingAmps),
      });
      commands.push(decision.amps);
      commandedAmps = decision.amps;
      lastCommandAtMs = nowMs;
    }
  }
  return {
    name: session.name,
    commands,
    commandsAt,
    peakC: Math.max(...temperature.map(sample => sample.celsius)),
    crossings: 0,
    longestTrain: 0,
    ampHours: 0,
    minutes: session.spanMs / 60_000,
  };
}

/**
 * Replays one session against the measured plant — what would HAPPEN. The controller sees a
 * whole-degree sensor built from the simulated temperature, exactly as the bike's rings are built.
 *
 * `control: false` runs the do-nothing baseline: the station's own ceiling, untouched.
 */
export function replayClosedLoop(
  session: ArchiveSession,
  phaseSeconds: number,
  corner: (typeof PLANT_CORNERS)[number],
  control = true
): SessionRun {
  const logged = parseSamples(session.temperature);
  const socSamples = parseSoc(session.soc);
  const requested = parseRows(session.requested);
  const coolantIn = parseRows(session.coolantIn);
  const commands: number[] = [];
  const commandsAt: SessionRun["commandsAt"] = [];
  const samples: TemperatureSample[] = [];
  const crossingsAt: number[] = [];
  // ⚠️ Started at the logged reading's MIDPOINT: a reading of 47 is a true [47, 48), and starting
  // at the floor of the bin biases every session cold by half a degree.
  let temperatureC = logged[0].celsius + 0.5;
  let peakC = temperatureC;
  let commandedAmps: number | null = null;
  let lastCommandAtMs: number | null = null;
  let lastReading: number | null = null;
  let derated = false;
  let derateStartedAtMs = -Infinity;
  let ampSeconds = 0;
  let lastTick = -Infinity;
  const stepMs = 1000;
  for (let nowMs = 0; nowMs <= session.spanMs; nowMs += stepMs) {
    const reading = Math.floor(temperatureC);
    if (reading !== lastReading) {
      if (lastReading !== null && reading >= CLIFF_C && lastReading < CLIFF_C) {
        crossingsAt.push(nowMs);
      }
      lastReading = reading;
      samples.push({ atMs: nowMs, celsius: reading });
      while (samples.length > 1 && samples[1].atMs < nowMs - RATE_WINDOW_MS) {
        samples.shift();
      }
    }
    // The clamp releases at a true 55 and lets go when the reading is back at 54 — but not before
    // it has held for the saw-tooth's own period. See DERATE_HOLD_MS.
    if (reading >= CLIFF_C) {
      if (!derated) {
        derateStartedAtMs = nowMs;
      }
      derated = true;
    } else if (derated && nowMs - derateStartedAtMs >= DERATE_HOLD_MS) {
      derated = false;
    }
    if (control && nowMs - lastTick >= TICK_MS && nowMs >= phaseSeconds * 1000) {
      lastTick = nowMs;
      const decision = decideChargeCurrent({
        enabled: true,
        packTemperatureC: reading,
        packTemperatureAgeMs: 100,
        packTemperaturePlausible: true,
        chargeManagerState: 0x23,
        chargeManagerStateAgeMs: 100,
        ceilingAmps: session.ceilingAmps,
        commandedAmps,
        riderOverride: false,
        samples,
        socPercent: valueAt(
          socSamples.map(soc => ({ atMs: soc.atMs, value: soc.percent })),
          nowMs
        ),
        socAgeMs: 100,
        socSamples: socRingAt(socSamples, nowMs),
        requestedAmps: valueAt(requested, nowMs),
        lastCommandAtMs,
        nowMs,
      });
      if (decision.kind === "command") {
        commandsAt.push({
          atMs: nowMs,
          amps: decision.amps,
          raised: decision.amps > (commandedAmps ?? session.ceilingAmps),
        });
        commands.push(decision.amps);
        commandedAmps = decision.amps;
        lastCommandAtMs = nowMs;
      }
    }
    // What the pack actually takes: the derate first, then the smaller of what the rule commands
    // and what the vehicle is asking the station for — its own taper, logged, not modelled.
    const asking = valueAt(requested, nowMs) ?? session.ceilingAmps;
    const flowing = derated ? DERATED_A : Math.min(commandedAmps ?? session.ceilingAmps, asking);
    ampSeconds += flowing;
    const coolant = valueAt(coolantIn, nowMs) ?? 35;
    const watts = flowing * flowing * PACK_OHMS - corner.wattsPerKelvin * (temperatureC - coolant);
    temperatureC += (watts / corner.joulesPerKelvin) * (stepMs / 1000);
    peakC = Math.max(peakC, temperatureC);
  }
  const minutes = session.spanMs / 60_000;
  const ampHours = ampSeconds / 3600;
  return {
    name: session.name,
    commands,
    commandsAt,
    peakC,
    crossings: crossingsAt.length,
    longestTrain: longestTrain(crossingsAt),
    ampHours,
    minutes,
  };
}

/** The longest run of crossings less than ten minutes apart — one excursion is not a train. */
function longestTrain(crossingsAt: number[]): number {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < crossingsAt.length; index += 1) {
    run = index > 0 && crossingsAt[index] - crossingsAt[index - 1] < 10 * 60_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

interface Row {
  atMs: number;
  value: number;
}

function parseRows(packed: string): Row[] {
  if (packed.length === 0) {
    return [];
  }
  return packed.split(" ").map(entry => {
    const [atMs, value] = entry.split(":");
    return { atMs: Number(atMs), value: Number(value) };
  });
}

export function parseSamples(packed: string): TemperatureSample[] {
  return parseRows(packed).map(row => ({ atMs: row.atMs, celsius: row.value }));
}

function parseSoc(packed: string): SocSample[] {
  return parseRows(packed).map(row => ({ atMs: row.atMs, percent: row.value }));
}

/** Zero-order hold: what the signal last said at or before `nowMs`, or null before its first row. */
function valueAt(rows: Row[], nowMs: number): number | null {
  const found = rows.findLast(row => row.atMs <= nowMs);
  return found === undefined ? null : found.value;
}

/** The temperature ring as src/charge/auto.ts keeps it: trimmed to the window, one anchor kept. */
function ringAt(samples: TemperatureSample[], nowMs: number): TemperatureSample[] {
  const ring: TemperatureSample[] = [];
  for (const sample of samples) {
    if (sample.atMs > nowMs) {
      break;
    }
    ring.push(sample);
    while (ring.length > 1 && ring[1].atMs < sample.atMs - RATE_WINDOW_MS) {
      ring.shift();
    }
  }
  return ring;
}

/** The SOC ring, trimmed the same way and with no anchor — src/charge/soc.ts says why. */
function socRingAt(samples: SocSample[], nowMs: number): SocSample[] {
  return samples.filter(sample => sample.atMs <= nowMs && sample.atMs >= nowMs - SOC_WINDOW_MS);
}
