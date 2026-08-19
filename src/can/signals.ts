import type { SignalSource } from "../db.ts";
import { appendReading } from "../storage/encrypted-log.ts";
import { monotonicNow, since } from "../monotonic.ts";

// The log-on-change core (see obd-garage/INTEGRATION_PLAN.md §Logging model).
//
// Two pieces of state:
//   liveState   — latest value of every signal, updated on EVERY decoded sample.
//                 This is what the WebSocket/phone dashboard broadcasts (so the
//                 display stays fresh even when a value is steady).
//   lastLogged  — last value actually written to the ride log per signal. A new sample
//                 is sealed only when it differs from lastLogged by more than the
//                 signal's deadband (0 ⇒ log on any change, i.e. sensor resolution).
//                 lastLogged starts empty on boot, so the first sample of every
//                 signal after a (re)boot is always logged.

export interface SignalDef {
  key: string;
  unit: string;
  group: string;
  source: SignalSource;
  deadband?: number;
  /**
   * Written only when something asks for it, so silence is its resting state and
   * says nothing about health. A group of nothing but these is left out of the
   * liveness summary in ../http/status.ts: `live === 0` is what a reader of that
   * summary filters on to find a dead source, and a source that is silent by
   * design would match that filter forever while nothing was wrong.
   *
   * Not the same as a signal that is merely slow. If a real one stops arriving
   * that is a fault worth surfacing; if no waypoint has been saved, nothing is
   * wrong.
   *
   * Flagging one costs the whole group its liveness once every signal in it is
   * flagged, so it is not a free annotation — scripts/check-ride-log-status.ts §5
   * names the groups that must always be summarised, and goes red if one of them
   * disappears from the payload.
   */
  onDemand?: true;
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

// When each signal was last seen, on the monotonic clock.
//
// Deliberately NOT a field on LiveValue: `ts` is a wall-clock stamp because that is
// what gets sealed into the ride log and what the dashboard displays, and it has to
// stay that. But "how old is this reading" is a duration, and this process steps its
// own wall clock (gps/clock.ts, see ../monotonic.ts) — so every server-side
// freshness check has to measure against something a `date -s` cannot move. Keeping
// it in a parallel map also keeps it off the WebSocket, where a second timestamp per
// signal would be ~230 numbers per snapshot that no client can use: performance.now()
// origins are per-process and mean nothing in the browser.
const lastSeenMonotonic = new Map<string, number>();

// Event-driven push: the WS layer registers a listener and we hand it the signals
// that changed (already rate-limited by the per-signal deadbands). Changes that
// happen synchronously (e.g. the several values in one 0x200 frame) are coalesced
// into one notification via a microtask — no time-based throttle, no added latency.
type ChangeListener = (changed: Record<string, LiveValue>) => void;
let changeListener: ChangeListener | null = null;
let pending: Record<string, LiveValue> | null = null;

export function onChange(listener: ChangeListener): void {
  changeListener = listener;
}

function notifyChange(key: string, v: LiveValue): void {
  if (!changeListener) return;
  if (!pending) {
    pending = {};
    queueMicrotask(() => {
      const batch = pending;
      pending = null;
      if (batch && changeListener) changeListener(batch);
    });
  }
  pending[key] = v;
}

export function defineSignals(list: SignalDef[]): void {
  for (const d of list) defs.set(d.key, d);
}

export function record(key: string, value: number, ts: number = Date.now()): void {
  if (!Number.isFinite(value)) return;
  const def = defs.get(key);
  const unit = def?.unit ?? "";
  const group = def?.group ?? "misc";

  // Always refresh live state for the dashboard.
  liveState.set(key, { value, unit, group, ts });
  lastSeenMonotonic.set(key, monotonicNow());

  // Change-detection (against last *logged* value) for the DB.
  const prev = lastLogged.get(key);
  const deadband = def?.deadband ?? 0;
  if (prev === undefined || Math.abs(value - prev) > deadband) {
    lastLogged.set(key, value);
    // The encrypted ride log is the only persistence — there is no plaintext DB
    // on the bike. No-op until a public key is configured, which the startup
    // banner shouts about. See src/storage/encrypted-log.ts.
    appendReading(ts, key, value, unit, group, def?.source ?? "stream");
    notifyChange(key, { value, unit, group, ts });
  }
}

/**
 * Milliseconds since this signal last arrived, or null if it never has.
 *
 * Use this for every "is it fresh / is it stale" question on the server. Comparing
 * `Date.now()` against `LiveValue.ts` looks equivalent and is not: the first GPS fix
 * after a no-network boot steps the clock by however wrong the Pi was, and every
 * reading taken before that step instantly looks hours old — or, on a backwards
 * step, arrives from the future.
 */
export function ageMs(key: string): number | null {
  const mark = lastSeenMonotonic.get(key);
  return mark === undefined ? null : since(mark);
}

/**
 * The latest value of one signal, or null if it has never arrived.
 *
 * The per-key counterpart to `ageMs()` above, and the two are meant to be read
 * together: a value with no age attached is not evidence about the bike.
 *
 * It reads `liveState`, which is refreshed on EVERY decoded sample — the deadband
 * gates the ride log and the WebSocket patch, never this. So a 100 Hz signal with a
 * 0.5 km/h deadband still answers here at 100 Hz, which is what makes this usable
 * for a decision rather than only for a display.
 *
 * Exists so a caller wanting two or three signals does not go through `snapshot()`,
 * which copies all ~230 of them. src/vcu/service-gate.ts asks eight times a second
 * while a parameter sweep runs.
 */
export function latestValue(key: string): number | null {
  return liveState.get(key)?.value ?? null;
}

export function snapshot(): Record<string, LiveValue> {
  const out: Record<string, LiveValue> = {};
  for (const [k, v] of liveState) out[k] = v;
  return out;
}
