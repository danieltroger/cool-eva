import MAX31865 from 'max31865';
import { record } from '../can/signals.ts';

// External MAX31865 PT100 probes on the battery coolant loop, refactored out of
// index.ts. Feeds the same log-on-change core as the CAN signals, as
// coolant_in (sensor_0 / inlet) and coolant_out (sensor_1 / outlet).

interface ProbeConfig {
  key: string;
  bus: number;
  device: number;
}

const PROBES: ProbeConfig[] = [
  { key: 'coolant_in', bus: 0, device: 0 }, // /dev/spidev0.0 (SPI0 CE0) — inlet
  { key: 'coolant_out', bus: 0, device: 1 }, // /dev/spidev0.1 (SPI0 CE1) — outlet
];

const OPTIONS = {
  rtdNominal: 100, // PT100
  refResistor: 430, // Adafruit board
  wires: 4 as const,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Initialise the probes and start a poll loop. Coolant is thermally slow, so 1 Hz
// + a 0.1 °C deadband (in the registry) keeps the log compact while still catching
// real movement. Reads are logged via record() (log-on-change).
export async function startCoolantSensors(intervalMs = 1000): Promise<void> {
  const probes: { key: string; sensor: MAX31865 }[] = [];
  for (const cfg of PROBES) {
    const sensor = new MAX31865(cfg.bus, cfg.device, OPTIONS);
    await sensor.init();
    probes.push({ key: cfg.key, sensor });
  }
  console.log(`coolant: ${probes.length} MAX31865 probe(s) started @${intervalMs}ms`);

  void (async () => {
    for (;;) {
      const t0 = Date.now();
      for (const { key, sensor } of probes) {
        try {
          const c = await sensor.getTemperature();
          // MAX31865 returns wild values on an open/short/disconnected RTD —
          // skip obvious faults so they don't pollute the log.
          if (c < -40 || c > 150) {
            console.warn(`coolant: ${key} out-of-range read ${c.toFixed(1)} °C — skipped`);
            continue;
          }
          record(key, c);
        } catch (err) {
          console.error(`coolant: ${key} read failed:`, err);
        }
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
    }
  })();
}
