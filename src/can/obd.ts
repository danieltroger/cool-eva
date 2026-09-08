import type { RawChannel } from "socketcan";
import type { DecodedValue } from "./frame.ts";
import { record } from "./signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { handleTroubleCodeFrame, requestTroubleCodeList } from "./obd-dtc.ts";
import { MODE_PENDING_DTCS, MODE_PERMANENT_DTCS, MODE_STORED_DTCS } from "../diagnostics/obd-dtc.ts";
import { FREEZE_FRAME_DTC_KEY, recordFreezeFrameDtc, recordTroubleCodeRead } from "../diagnostics/stored-codes.ts";

// OBD-II Mode-01 polling over CAN (see obd-garage/CAN_MAP.md §OBD-II queries).
// Functional request to 0x7DF, single-frame responses arrive on 0x7E8..0x7EF.
// Every PID here returns 1–2 data bytes, so no ISO-TP multiframe is needed.
// A/B follow the OBD-II convention: A = first data byte, B = second.
//
// The trouble-code services (modes 03/07/0A) DO need ISO-TP, and they live in
// ./obd-dtc.ts. They are driven from this file's poll loop rather than on a timer
// of their own, on purpose: pollOnce is strictly sequential, so nothing of ours is
// on 0x7DF while a multiframe transfer is running — and a request arriving
// mid-transfer is what makes the VCU abandon it.

const OBD_REQ_ID = 0x7df;
const OBD_RESP_LO = 0x7e0;
const OBD_RESP_HI = 0x7ef;

// Most PIDs carry exactly one signal, recorded under `key`. A PID that packs
// several signals into its bytes (0x01 = MIL lamp + stored-DTC count) instead
// returns the (key, value) pairs itself and leaves `key` off.
interface PidDef {
  pid: number;
  key?: string;
  decode: (a: number, b: number) => number | DecodedValue[];
  /**
   * Poll this PID only every Nth round (default: every round). `pollOnce` is
   * strictly sequential and an unanswered PID costs a full 200 ms timeout, so
   * putting slow-moving counters on every round would drag speed/rpm well below
   * the 2 Hz they're scheduled at — for values that change once a ride.
   */
  everyNthRound?: number;
}

// At the default 500 ms poll interval this is once every 10 s — plenty for
// counters that move once a ride, and it keeps them off 19 of every 20 rounds.
const DIAGNOSTIC_ROUND_DIVISOR = 20;

/**
 * How often the stored-code list itself is read: every 120th round, i.e. once a
 * minute at the default interval. Rarer than the counters above because it is far
 * more expensive — one multiframe transfer, retried up to five times when the VCU
 * abandons it, so up to ~2.8 s in the worst case (see ./obd-dtc.ts). It is also a
 * list that changes about as often as the bike is serviced.
 */
const STORED_DTC_ROUND_DIVISOR = 120;

/**
 * Pending (07) and permanent (0A) codes are asked for every 10th stored read, so
 * once every ~10 minutes. They have never answered — six requests, silence — and a
 * mode that says nothing still costs a 300 ms timeout each time. Asking rarely is
 * the compromise between never noticing if they start answering and spending
 * 600 ms a minute proving again that they do not.
 */
const SILENT_MODE_READ_EVERY = 10;

const PIDS: PidDef[] = [
  { pid: 0x0d, key: "speed_kmh", decode: a => a },
  { pid: 0x0c, key: "motor_rpm", decode: (a, b) => (256 * a + b) / 4 },
  { pid: 0x05, key: "bike_coolant_temp", decode: a => a - 40 },
  { pid: 0x5c, key: "oil_temp", decode: a => a - 40 },
  { pid: 0x46, key: "ambient_temp", decode: a => a - 40 },
  { pid: 0x42, key: "aux_12v", decode: (a, b) => (256 * a + b) / 1000 },
  { pid: 0x5b, key: "soh_pid", decode: a => (a * 100) / 255 },
  { pid: 0x04, key: "motor_load_pct", decode: a => (a * 100) / 255 },
  { pid: 0x31, key: "dist_since_clear_km", decode: (a, b) => 256 * a + b },

  // Diagnostics / counters — slow-moving, so log-on-change makes them nearly free.
  // 0x01 monitor status: A bit7 = MIL lamp, low 7 bits = stored-DTC count.
  {
    pid: 0x01,
    everyNthRound: DIAGNOSTIC_ROUND_DIVISOR,
    decode: a => [
      { key: "mil_on", value: a & 0x80 ? 1 : 0 },
      { key: "dtc_count", value: a & 0x7f },
    ],
  },
  // 0x02 freeze-frame DTC — the code that was set when the bike captured its freeze
  // frame, i.e. in practice the one that turned the lamp on. It has been in the
  // bike's own supported-PID bitmap all along (PID 00 answers `D8 18 80 11`) and was
  // simply never polled; the first read of it, 2026-08-04, returned `05 14` = P0514
  // "Error reading temperature", MIL column 1 — which is the answer to why the lamp
  // is lit, out of 39 stored codes. Recorded raw so the formatting stays in one
  // place; 0 is the bike's own way of saying no freeze frame is stored.
  { pid: 0x02, key: FREEZE_FRAME_DTC_KEY, everyNthRound: DIAGNOSTIC_ROUND_DIVISOR, decode: (a, b) => 256 * a + b },
  // monotonic ⇒ hour meter
  { pid: 0x4e, key: "time_since_clear_min", everyNthRound: DIAGNOSTIC_ROUND_DIVISOR, decode: (a, b) => 256 * a + b },
  { pid: 0x21, key: "dist_with_mil_km", everyNthRound: DIAGNOSTIC_ROUND_DIVISOR, decode: (a, b) => 256 * a + b },
  { pid: 0x4d, key: "time_with_mil_min", everyNthRound: DIAGNOSTIC_ROUND_DIVISOR, decode: (a, b) => 256 * a + b },
  { pid: 0x30, key: "warmups_since_clear", everyNthRound: DIAGNOSTIC_ROUND_DIVISOR, decode: a => a },
];

// Normalises the two decode shapes into one list of (key, value) pairs.
function decodedValues(def: PidDef, a: number, b: number): DecodedValue[] {
  const decoded = def.decode(a, b);
  if (typeof decoded !== "number") return decoded;
  return def.key ? [{ key: def.key, value: decoded }] : [];
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let channel: RawChannel | undefined;
const pending = new Map<number, { resolve: (d: Buffer | null) => void; timer: ReturnType<typeof setTimeout> }>();

export function initObd(ch: RawChannel): void {
  channel = ch;
}

// Returns true if this frame was an OBD response we consumed.
export function isObdResponse(id: number): boolean {
  return id >= OBD_RESP_LO && id <= OBD_RESP_HI;
}

export function handleResponse(id: number, data: Buffer): void {
  // A trouble-code transfer, when one is running, gets first refusal: its
  // Consecutive Frames carry no service byte and would fall straight through the
  // mode-01 check below. It hands back anything that is not part of that transfer —
  // including the mode-01 replies still arriving on the same IDs — so this is not a
  // branch that can starve the poller.
  if (handleTroubleCodeFrame(id, data)) return;

  // Positive Mode-01 response: [len][0x41][pid][A][B]…
  //
  // The PCI check is not decoration. Now that mode 03 is asked for, ISO-TP
  // Consecutive Frames exist on these IDs, they carry no service byte, and one whose
  // second byte happened to be 0x41 would be read here as a mode-01 reply and record
  // two payload bytes as a PID value. A Single Frame has 0x0 in the top nibble; a
  // Consecutive Frame has 0x2.
  if (data.length < 3 || data[0] >> 4 !== 0x0 || data[1] !== 0x41) return;
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
  return new Promise(resolve => {
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
      console.error("obd: send failed", err);
      resolve(null);
    }
  });
}

// ── Parking the poller, so a multi-frame read gets a quiet bus of OUR traffic ──
//
// ⚠️ AN ACKNOWLEDGEMENT, NOT A FLAG: `holdObdPoller` resolves only once the loop has
// PARKED, because a boolean set from an HTTP handler cannot unwind a trouble-code
// transfer four retries deep. Fail-safe — a loop that never parks means a refusal, never
// a false grant. And ⚠️ THE HOLD IS CAPPED BY THE LOOP, not by the holder: a leaked one
// would take speed, rpm, the temperatures and the whole DTC list off the dashboard AND
// out of the log, with a healthy journal, on a bike where there is no reception.
//
// Why the poller is worth parking at all, why parked implies nothing of ours is in
// flight, and where the three park points are: docs/lifetime-battery-statistics.md
// § "The poller is parked, and that is the point".

/** A parked poller. Releasing twice is safe, which is what a `finally` on a retried path does. */
export interface ObdPollerHold {
  release: () => void;
}

/**
 * How long a caller may keep the poller parked before it resumes anyway.
 *
 * Sized from the work it is protecting, not picked: two components, two attempts each,
 * bounded by the transport's own first-reply and transfer timeouts, plus the session
 * opens — comfortably inside ten seconds. Past that, something is wrong with the read
 * and telemetry matters more.
 */
const MAX_HOLD_MS = 15_000;

/**
 * How long to WAIT for the loop to park before giving up.
 *
 * The worst case is one trouble-code mode in flight when the hold is asked for:
 * 5 attempts × (300 ms first reply + 400 ms transfer) + 4 × 120 ms between them =
 * 3.98 s (src/can/obd-dtc.ts). It is not the 14.2 s of a whole `pollOnce`, because the
 * loop parks between PIDs and between the three modes as well as at the top — every one
 * of those calls is awaited, so the implication above holds at all three. The common
 * case is one `requestPid` timeout, 200 ms, since 119 rounds in 120 are PIDs only.
 */
const HOLD_WAIT_MS = 6000;

/** How often a parked loop re-checks. Short enough that the cap expires promptly, cheap enough to ignore. */
const HOLD_POLL_MS = 100;

let hold: {
  name: string;
  parked: boolean;
  announce: (() => void) | null;
  expiresAt: number;
  maxHoldMs: number;
} | null = null;

/**
 * Parks the 2 Hz poller and resolves once it has actually stopped, or null on timeout.
 *
 * `reason` is shown to a person, so it is a phrase: "a lifetime-statistics read".
 */
export async function holdObdPoller(
  reason: string,
  waitMs = HOLD_WAIT_MS,
  // Injectable for the same reason `waitMs` is: scripts/check-obd-poller-hold.ts has to
  // watch the loop take the poller back, and waiting out the real cap would put fifteen
  // seconds into a suite that runs in ten. No production caller passes it.
  maxHoldMs = MAX_HOLD_MS
): Promise<ObdPollerHold | null> {
  if (hold) {
    console.warn(`obd: refusing to park for ${reason} — ${hold.name} already has it`);
    return null;
  }
  const mine = { name: reason, parked: false, announce: null as (() => void) | null, expiresAt: 0, maxHoldMs };
  hold = mine;
  const parked = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      mine.announce = null;
      resolve(false);
    }, waitMs);
    timer.unref?.();
    mine.announce = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
  if (!parked) {
    hold = null;
    console.warn(`obd: the poller did not park within ${waitMs} ms — refusing ${reason}`);
    return null;
  }
  mine.expiresAt = monotonicNow() + maxHoldMs;
  console.log(`obd: parked for ${reason}`);
  return {
    release: () => {
      // Only clears the hold if it is still OURS — the same identity check
      // src/vcu/bus-lease.ts makes, for the same reason: a late release must not free
      // somebody else's.
      if (hold === mine) {
        hold = null;
        console.log(`obd: resumed after ${reason}`);
      }
    },
  };
}

/** Whether the poller is currently parked. Read at each park point. */
export function obdPollerHeldBy(): string | null {
  return hold?.name ?? null;
}

/**
 * Called at each park point. True when the caller should stop and not transmit.
 *
 * ⚠️ This is where the cap is enforced, by the loop rather than by the holder — see the
 * header. A hold past its expiry is dropped loudly and the poller carries on.
 */
function parkedForHold(): boolean {
  if (!hold) {
    return false;
  }
  if (hold.parked && hold.expiresAt > 0 && monotonicNow() > hold.expiresAt) {
    console.warn(`obd: ${hold.name} held the poller past ${hold.maxHoldMs} ms — resuming anyway`);
    hold = null;
    return false;
  }
  if (!hold.parked) {
    hold.parked = true;
    hold.announce?.();
    hold.announce = null;
  }
  return true;
}

let pollRound = 0;
let storedDtcReads = 0;

async function pollOnce(): Promise<void> {
  pollRound += 1;
  for (const def of PIDS) {
    if (def.everyNthRound && pollRound % def.everyNthRound !== 0) {
      continue;
    }
    // Park point. Every requestPid above is awaited and single-frame, so stopping here
    // leaves nothing of ours in flight — and it is what keeps the common-case wait at
    // one PID timeout rather than a whole round.
    if (parkedForHold()) {
      return;
    }
    const resp = await requestPid(def.pid);
    if (!resp) continue;
    const a = resp[3] ?? 0;
    const b = resp[4] ?? 0;
    for (const { key, value } of decodedValues(def, a, b)) {
      record(key, value);
      // Same shape as index.ts's gps_epoch_s hook: one signal that a second module
      // also needs, taken off the recording path rather than decoded twice.
      if (key === FREEZE_FRAME_DTC_KEY) {
        recordFreezeFrameDtc(value);
      }
    }
  }
  await readTroubleCodeLists();
}

/**
 * The multiframe reads, in the same sequential loop as the PIDs above.
 *
 * `% === 1` rather than `% === 0` so the first read happens on the first round
 * instead of a minute in: this is the one thing on the bike that answers "what is
 * actually wrong with it", and it should be on screen by the time you have the
 * phone out. The counters above can afford to wait; this cannot.
 */
async function readTroubleCodeLists(): Promise<void> {
  if (!channel || pollRound % STORED_DTC_ROUND_DIVISOR !== 1) {
    return;
  }
  if (parkedForHold()) {
    return;
  }
  recordTroubleCodeRead(await requestTroubleCodeList(channel, MODE_STORED_DTCS), "stored");

  storedDtcReads += 1;
  if (storedDtcReads % SILENT_MODE_READ_EVERY !== 1) {
    return;
  }
  // Between the modes as well: each requestTroubleCodeList is awaited and obd-dtc.ts
  // settles before resolving, so this is the point that keeps the worst case at one
  // mode (3.98 s) rather than three (11.9 s).
  if (parkedForHold()) {
    return;
  }
  recordTroubleCodeRead(await requestTroubleCodeList(channel, MODE_PENDING_DTCS), "pending");
  if (parkedForHold()) {
    return;
  }
  recordTroubleCodeRead(await requestTroubleCodeList(channel, MODE_PERMANENT_DTCS), "permanent");
}

// Self-scheduling loop (avoids overlapping polls if a round runs long).
// Returns a stop function.
export function startObdPoller(intervalMs = 1000): () => void {
  let stopped = false;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      // Monotonic: a backwards wall-clock step makes the elapsed time negative,
      // so `intervalMs - elapsed` becomes the size of the step and polling stalls
      // for that long — a minute-sized step means a minute with no OBD data.
      const roundStartedAt = monotonicNow();
      // Park point, and the one that matters for a hold asked for mid-`sleep`.
      if (parkedForHold()) {
        await sleep(HOLD_POLL_MS);
        continue;
      }
      try {
        await pollOnce();
      } catch (err) {
        console.error("obd: poll error", err);
      }
      await sleep(Math.max(0, intervalMs - since(roundStartedAt)));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
