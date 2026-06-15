import type { RawChannel } from 'socketcan';
import { record } from './signals.ts';

// OBD-II Mode-01 polling over CAN (see obd-garage/CAN_MAP.md §OBD-II queries).
// Functional request to 0x7DF, single-frame responses arrive on 0x7E8..0x7EF.
// All four PIDs here return 1–2 data bytes, so no ISO-TP multiframe is needed.

const OBD_REQ_ID = 0x7df;
const OBD_RESP_LO = 0x7e0;
const OBD_RESP_HI = 0x7ef;

interface PidDef {
  pid: number;
  key: string;
  decode: (a: number, b: number) => number;
}

const PIDS: PidDef[] = [
  { pid: 0x0d, key: 'speed_kmh', decode: (a) => a },
  { pid: 0x0c, key: 'motor_rpm', decode: (a, b) => (256 * a + b) / 4 },
  { pid: 0x05, key: 'bike_coolant_temp', decode: (a) => a - 40 },
  { pid: 0x5c, key: 'oil_temp', decode: (a) => a - 40 },
  { pid: 0x46, key: 'ambient_temp', decode: (a) => a - 40 },
  { pid: 0x42, key: 'aux_12v', decode: (a, b) => (256 * a + b) / 1000 },
  { pid: 0x5b, key: 'soh_pid', decode: (a) => (a * 100) / 255 },
  { pid: 0x04, key: 'motor_load_pct', decode: (a) => (a * 100) / 255 },
  { pid: 0x31, key: 'dist_since_clear_km', decode: (a, b) => 256 * a + b },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let channel: RawChannel | undefined;
const pending = new Map<number, { resolve: (d: Buffer | null) => void; timer: ReturnType<typeof setTimeout> }>();

export function initObd(ch: RawChannel): void {
  channel = ch;
}

// Returns true if this frame was an OBD response we consumed.
export function isObdResponse(id: number): boolean {
  return id >= OBD_RESP_LO && id <= OBD_RESP_HI;
}

export function handleResponse(_id: number, data: Buffer): void {
  // Positive Mode-01 response: [len][0x41][pid][A][B]…
  if (data.length < 3 || data[1] !== 0x41) return;
  const pid = data[2];
  const p = pending.get(pid);
  if (p) {
    clearTimeout(p.timer);
    pending.delete(pid);
    p.resolve(data);
  }
}

function requestPid(pid: number, timeoutMs = 200): Promise<Buffer | null> {
  if (!channel) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(pid);
      resolve(null);
    }, timeoutMs);
    pending.set(pid, { resolve, timer });
    const frame = Buffer.from([0x02, 0x01, pid, 0x55, 0x55, 0x55, 0x55, 0x55]);
    try {
      channel!.send({ id: OBD_REQ_ID, ext: false, rtr: false, data: frame });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(pid);
      console.error('obd: send failed', err);
      resolve(null);
    }
  });
}

async function pollOnce(): Promise<void> {
  for (const def of PIDS) {
    const resp = await requestPid(def.pid);
    if (!resp) continue;
    const a = resp[3] ?? 0;
    const b = resp[4] ?? 0;
    record(def.key, def.decode(a, b));
  }
}

// Self-scheduling loop (avoids overlapping polls if a round runs long).
// Returns a stop function.
export function startObdPoller(intervalMs = 1000): () => void {
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      const t0 = Date.now();
      try {
        await pollOnce();
      } catch (err) {
        console.error('obd: poll error', err);
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
