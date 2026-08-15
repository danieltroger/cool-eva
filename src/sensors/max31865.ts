import MAX31865 from "max31865";
import { record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";

// External MAX31865 PT100 probes on the battery coolant loop, refactored out of
// index.ts. Feeds the same log-on-change core as the CAN signals, as
// coolant_in (sensor_0 / inlet) and coolant_out (sensor_1 / outlet).
//
// This is the one part of the app that assumes hardware most Energicas do not have.
// A bike without the watercooling loop has no probes, and usually no SPI enabled
// either, in which case openSync fails and the caller carries on without coolant.
// The awkward case is SPI enabled with nothing wired to it: SPI has no ACK, so the
// reads succeed, return zero, and the library's polynomial resolves them to exactly
// -242.02 °C forever. See COOLANT_ENABLED and MAX_CONSECUTIVE_FAULTS below.

interface ProbeConfig {
  key: string;
  bus: number;
  device: number;
}

const PROBES: ProbeConfig[] = [
  { key: "coolant_in", bus: 0, device: 0 }, // /dev/spidev0.0 (SPI0 CE0) — inlet
  { key: "coolant_out", bus: 0, device: 1 }, // /dev/spidev0.1 (SPI0 CE1) — outlet
];

const OPTIONS = {
  rtdNominal: 100, // PT100
  refResistor: 430, // Adafruit board
  wires: 4 as const,
};

/** Readings outside this are an open, shorted or absent RTD rather than a temperature. */
const PLAUSIBLE_RANGE = { min: -40, max: 150 };

/**
 * How many bad reads in a row before a probe is backed off to the slow retry below.
 *
 * A healthy read costs about 750 ms (the library biases, waits 100 ms, one-shots,
 * waits 650 ms), so this is roughly a minute of nothing believable before we stop
 * asking at full rate. Without it an unwired SPI bus writes two warnings every
 * 1.5 s for the life of the service, which is how a journal stops being worth
 * reading.
 */
const MAX_CONSECUTIVE_FAULTS = 80;

/**
 * How often a backed-off probe is retried.
 *
 * Backed off, never retired: an out-of-range coolant probe on this bike means a
 * wire to go and wiggle (see public/lib/bounds.js), and the 40 351 rows of
 * `coolant_out` at 988 °C in the history are a flaky joint rather than a dead
 * sensor. A probe that drops out and comes back has to resume on its own, because
 * the alternative is losing ΔT for the rest of a ride you cannot SSH into.
 */
const RETRY_INTERVAL_MS = 60_000;

/**
 * Paces the failure path. The 750 ms that make MAX_CONSECUTIVE_FAULTS "about a
 * minute" are the library's conversion waits *inside a successful read* — a
 * rejection (fd closed, ENODEV, EBUSY on the transfer) comes back with no wall
 * clock spent at all, so without this the whole strike budget burns in one tick
 * and a momentary SPI hiccup backs off a working probe.
 */
const FAULT_PACING_MS = 750;

/** Set COOLANT_ENABLED=0 on a bike with no watercooling loop to skip SPI entirely. */
const COOLANT_ENABLED = process.env.COOLANT_ENABLED !== "0";

interface Probe {
  key: string;
  sensor: MAX31865;
  consecutiveFaults: number;
  /** Monotonic mark of the last attempt, for pacing retries once backed off. */
  lastAttemptAt: number;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

// Initialise whatever probes are actually there and read them back-to-back at the
// sensor's own rate (each getTemperature() awaits an SPI conversion, so the loop
// yields to the event loop between reads). Logging is on-change with a deadband in
// the registry, so polling fast doesn't bloat the log — it just makes changes show
// up sooner.
export async function startCoolantSensors(): Promise<void> {
  if (!COOLANT_ENABLED) {
    console.log("coolant: disabled (COOLANT_ENABLED=0)");
    return;
  }

  const probes: Probe[] = [];
  for (const probeConfig of PROBES) {
    // Per probe, not all-or-nothing: these are two independent chip selects, and
    // failing the second one used to throw out of here with the first already
    // initialised — so one bad solder joint on the outlet probe silently cost the
    // inlet reading too, and the ΔT the whole project is judged by with it.
    try {
      const sensor = new MAX31865(probeConfig.bus, probeConfig.device, OPTIONS);
      await sensor.init();
      probes.push({ key: probeConfig.key, sensor, consecutiveFaults: 0, lastAttemptAt: monotonicNow() });
    } catch (error) {
      console.warn(`coolant: ${probeConfig.key} unavailable on spidev${probeConfig.bus}.${probeConfig.device}:`, error);
    }
  }

  if (probes.length === 0) {
    // Not an error: this is every Energica without the custom loop. Say which switch
    // turns the attempt off so a stock bike can stop seeing this on every boot.
    console.log("coolant: no probes found — continuing without them (set COOLANT_ENABLED=0 to skip this)");
    return;
  }
  console.log(`coolant: ${probes.length} MAX31865 probe(s) started (sensor-rate polling)`);

  void (async () => {
    for (;;) {
      const due = probes.filter(probe => isDue(probe));
      for (const probe of due) {
        await readProbe(probe);
      }
      // Every probe is backed off, so nothing above awaited anything and this would
      // otherwise be a busy loop pinning a core the WebSocket and CAN RX share.
      if (due.length === 0) {
        await delay(RETRY_INTERVAL_MS);
      }
    }
  })();
}

/** A healthy probe is always due; a backed-off one only once the retry interval is up. */
function isDue(probe: Probe): boolean {
  if (probe.consecutiveFaults < MAX_CONSECUTIVE_FAULTS) {
    return true;
  }
  return since(probe.lastAttemptAt) >= RETRY_INTERVAL_MS;
}

/** One conversion, gated against the sentinels a dead or absent RTD produces. */
async function readProbe(probe: Probe): Promise<void> {
  const wasBackedOff = probe.consecutiveFaults >= MAX_CONSECUTIVE_FAULTS;
  probe.lastAttemptAt = monotonicNow();
  try {
    const celsius = await probe.sensor.getTemperature();
    if (celsius < PLAUSIBLE_RANGE.min || celsius > PLAUSIBLE_RANGE.max) {
      await noteFault(probe, `out-of-range read ${celsius.toFixed(1)} °C`);
      return;
    }
    if (wasBackedOff) {
      console.log(`coolant: ${probe.key} is reading again (${celsius.toFixed(1)} °C) — back to full rate`);
    }
    probe.consecutiveFaults = 0;
    record(probe.key, celsius);
  } catch (error) {
    await noteFault(probe, `read failed: ${(error as Error).message}`);
  }
}

/**
 * Count a bad read, and say something about it exactly twice: once when it starts,
 * once when it earns the slow lane. The 78 in between say nothing the first did not,
 * and a probe that goes quiet without explaining itself is the failure this file's
 * own header calls out as worth being loud about.
 */
async function noteFault(probe: Probe, detail: string): Promise<void> {
  probe.consecutiveFaults += 1;
  if (probe.consecutiveFaults === 1) {
    console.warn(`coolant: ${probe.key} ${detail} — skipped`);
  } else if (probe.consecutiveFaults === MAX_CONSECUTIVE_FAULTS) {
    console.warn(
      `coolant: ${probe.key} has failed ${MAX_CONSECUTIVE_FAULTS} times running (latest: ${detail}) — ` +
        `retrying every ${RETRY_INTERVAL_MS / 1000}s from now, and it will resume by itself if it comes back. ` +
        "Check the probe wiring. If this bike has no coolant loop, set COOLANT_ENABLED=0."
    );
  }
  await delay(FAULT_PACING_MS);
}
