import { recordReading, type SignalSource } from '../db.ts';

// The log-on-change core (see obd-garage/INTEGRATION_PLAN.md §Logging model).
//
// Two pieces of state:
//   liveState   — latest value of every signal, updated on EVERY decoded sample.
//                 This is what the WebSocket/phone dashboard broadcasts (so the
//                 display stays fresh even when a value is steady).
//   lastLogged  — last value actually written to the DB per signal. A new sample
//                 is written only when it differs from lastLogged by more than the
//                 signal's deadband (0 ⇒ log on any change, i.e. sensor resolution).
//                 lastLogged starts empty on boot, so the first sample of every
//                 signal after a (re)boot is always logged.

export interface SignalDef {
  key: string;
  unit: string;
  group: string;
  source: SignalSource;
  deadband?: number;
}

export interface LiveValue {
  value: number;
  unit: string;
  group: string;
  ts: number;
}

const defs = new Map<string, SignalDef>();
const liveState = new Map<string, LiveValue>();
const lastLogged = new Map<string, number>();

export function defineSignals(list: SignalDef[]): void {
  for (const d of list) defs.set(d.key, d);
}

export function record(key: string, value: number, ts: number = Date.now()): void {
  if (!Number.isFinite(value)) return;
  const def = defs.get(key);
  const unit = def?.unit ?? '';
  const group = def?.group ?? 'misc';

  // Always refresh live state for the dashboard.
  liveState.set(key, { value, unit, group, ts });

  // Change-detection (against last *logged* value) for the DB.
  const prev = lastLogged.get(key);
  const deadband = def?.deadband ?? 0;
  if (prev === undefined || Math.abs(value - prev) > deadband) {
    lastLogged.set(key, value);
    recordReading(ts, key, value, unit, group, def?.source ?? 'stream');
  }
}

export function snapshot(): Record<string, LiveValue> {
  const out: Record<string, LiveValue> = {};
  for (const [k, v] of liveState) out[k] = v;
  return out;
}
