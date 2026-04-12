import MAX31865 from 'max31865';
import Database from 'better-sqlite3';

interface SensorOptions {
  rtdNominal: number;
  refResistor: number;
  wires: 2 | 3 | 4;
}

interface Sensor {
  init(): Promise<void>;
  getTemperature(): Promise<number>;
}

interface SensorConfig {
  name: string;
  bus: number;
  device: number;
}

const SENSORS: SensorConfig[] = [
  { name: 'sensor_0', bus: 0, device: 0 },  // /dev/spidev0.0 (CE0)
  // { name: 'sensor_1', bus: 0, device: 1 },  // /dev/spidev0.1 (CE1) — uncomment when wired
];

const SENSOR_OPTIONS: SensorOptions = {
  rtdNominal: 100,   // PT100
  refResistor: 430,  // Adafruit board
  wires: 4,
};

// --- Database setup ---

const db = new Database('temperatures.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sensor    TEXT NOT NULL,
    celsius   REAL NOT NULL
  )
`);

const insert = db.prepare(
  'INSERT INTO readings (sensor, celsius) VALUES (?, ?)'
);

// --- Sensor init ---

const sensors: { name: string; sensor: Sensor }[] = [];

for (const cfg of SENSORS) {
  const sensor: Sensor = new MAX31865(cfg.bus, cfg.device, SENSOR_OPTIONS);
  await sensor.init();
  sensors.push({ name: cfg.name, sensor });
}

console.log(`Polling ${sensors.length} sensor(s) continuously — Ctrl+C to stop`);

// --- Graceful shutdown ---

function shutdown() {
  console.log('\nShutting down…');
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Poll loop ---

async function poll() {
  const results = await Promise.all(
    sensors.map(async ({ name, sensor }) => {
      try {
        const celsius = await sensor.getTemperature();
        return { name, celsius };
      } catch (err) {
        console.error(`${name} read failed:`, err);
        return null;
      }
    })
  );

  for (const result of results) {
    if (result) {
      insert.run(result.name, result.celsius);
      console.log(`${new Date().toISOString()}  ${result.name}: ${result.celsius.toFixed(2)} °C`);
    }
  }
}

while (true) {
  await poll();
}
