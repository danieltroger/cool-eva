import MAX31865 from "max31865";
import { record } from "../can/signals.ts";

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
 * How many out-of-range reads in a row retire a probe.
 *
 * A probe reads about every 750 ms (the library biases, waits 100 ms, one-shots,
 * waits 650 ms), so this is roughly a minute of nothing believable before we stop
 * asking. Without it an unwired SPI bus writes two warnings every 1.5 s for the life
 * of the service, which is how a journal stops being worth reading — and the same
 * thing happens when a probe dies mid-ride on a bike that does have the loop.
 * Retiring is deliberately not permanent-looking in the log: it says which probe and
 * what it was reading, because on this bike that means a wire to go and wiggle.
 */
const MAX_CONSECUTIVE_FAULTS = 80;

/** Set COOLANT_ENABLED=0 on a bike with no watercooling loop to skip SPI entirely. */
const COOLANT_ENABLED = process.env.COOLANT_ENABLED !== "0";

interface Probe {
  key: string;
  sensor: MAX31865;
  consecutiveFaults: number;
}

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
      probes.push({ key: probeConfig.key, sensor, consecutiveFaults: 0 });
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
    let live = probes;
    while (live.length > 0) {
      for (const probe of live) {
        await readProbe(probe);
      }
      live = live.filter(probe => probe.consecutiveFaults < MAX_CONSECUTIVE_FAULTS);
    }
    console.warn("coolant: every probe retired — no coolant readings for the rest of this session");
  })();
}

/** One conversion, gated against the sentinels a dead or absent RTD produces. */
async function readProbe(probe: Probe): Promise<void> {
  try {
    const celsius = await probe.sensor.getTemperature();
    if (celsius < PLAUSIBLE_RANGE.min || celsius > PLAUSIBLE_RANGE.max) {
      probe.consecutiveFaults += 1;
      // Only the first and the last: one line to notice, one to explain the silence
      // that follows. The 78 in between say nothing the first did not.
      if (probe.consecutiveFaults === 1) {
        console.warn(`coolant: ${probe.key} out-of-range read ${celsius.toFixed(1)} °C — skipped`);
      } else if (probe.consecutiveFaults === MAX_CONSECUTIVE_FAULTS) {
        console.warn(
          `coolant: ${probe.key} has read out of range ${MAX_CONSECUTIVE_FAULTS} times running ` +
            `(latest ${celsius.toFixed(1)} °C) — giving up on it. Check the probe wiring, then restart the service. ` +
            "If this bike has no coolant loop, set COOLANT_ENABLED=0."
        );
      }
      return;
    }
    probe.consecutiveFaults = 0;
    record(probe.key, celsius);
  } catch (error) {
    probe.consecutiveFaults += 1;
    if (probe.consecutiveFaults === 1) {
      console.error(`coolant: ${probe.key} read failed:`, error);
    }
  }
}
