import MAX31865 from 'max31865';
import Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { handleDbEndpoint } from './db-endpoint.js';

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
  { name: 'sensor_0', bus: 0, device: 0 },  // /dev/spidev0.0 (SPI0 CE0, pin 24)
  { name: 'sensor_1', bus: 0, device: 1 },  // /dev/spidev0.1 (SPI0 CE1, pin 26)
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

// --- HTTP + WebSocket server ---

const PORT = 80;
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const dbPath = join(__dirname, '..', 'temperatures.db');

const server = createServer(async (req, res) => {
  if (req.url === '/db') {
    await handleDbEndpoint(req, res, dbPath);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(indexHtml);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  console.log(`WebSocket client connected (${wss.clients.size} total)`);
  ws.on('close', () => console.log(`WebSocket client disconnected (${wss.clients.size} total)`));
});

function broadcast(data: object) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

server.listen(PORT, () => {
  console.log(`HTTP + WebSocket server on http://0.0.0.0:${PORT}`);
});

// --- Graceful shutdown ---

function shutdown() {
  console.log('\nShutting down…');
  server.close();
  wss.close();
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
      const timestamp = new Date().toISOString();
      insert.run(result.name, result.celsius);
      broadcast({ timestamp, sensor: result.name, celsius: result.celsius });
      console.log(`${timestamp}  ${result.name}: ${result.celsius.toFixed(2)} °C`);
    }
  }
}

while (true) {
  await poll();
}
