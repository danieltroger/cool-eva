import MAX31865 from "max31865";
import { record } from "../can/signals.ts";

// External MAX31865 PT100 probes on the battery coolant loop, refactored out of
// index.ts. Feeds the same log-on-change core as the CAN signals, as
// coolant_in (sensor_0 / inlet) and coolant_out (sensor_1 / outlet).

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

// Initialise the probes and read them back-to-back at the sensor's own rate (each
// getTemperature() awaits an SPI conversion, so the loop yields to the event loop
// between reads). Logging is on-change with a deadband in the registry, so polling
// fast doesn't bloat the DB — it just makes changes show up sooner.
export async function startCoolantSensors(): Promise<void> {
  const probes: { key: string; sensor: MAX31865 }[] = [];
  for (const probeConfig of PROBES) {
    const sensor = new MAX31865(probeConfig.bus, probeConfig.device, OPTIONS);
    await sensor.init();
    probes.push({ key: probeConfig.key, sensor });
  }
  console.log(`coolant: ${probes.length} MAX31865 probe(s) started (sensor-rate polling)`);

  void (async () => {
    for (;;) {
      for (const { key, sensor } of probes) {
        try {
          const celsius = await sensor.getTemperature();
          // MAX31865 returns wild values on an open/short/disconnected RTD —
          // skip obvious faults so they don't pollute the log.
          if (celsius < -40 || celsius > 150) {
            console.warn(`coolant: ${key} out-of-range read ${celsius.toFixed(1)} °C — skipped`);
            continue;
          }
          record(key, celsius);
        } catch (error) {
          console.error(`coolant: ${key} read failed:`, error);
        }
      }
    }
  })();
}
