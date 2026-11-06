import type { CanMessage } from "socketcan";
import { setTimeout as delay } from "node:timers/promises";
import { openCaptureLines } from "../can/capture-lines.ts";
import { matchesReceiveFilter } from "../can/receive.ts";
import { monotonicNow } from "../monotonic.ts";

export async function replayCapture(options: ReplaySourceOptions): Promise<ReplayCounts> {
  const clock = options.clock ?? REAL_CLOCK;
  let anchor = clock.now();
  let captureAnchor: number | null = null;
  let previousTime: number | null = null;
  const counts = { parsed: 0, delivered: 0, skipped: 0 };
  for await (const line of options.lines ?? openCaptureLines(options.path)) {
    options.signal.throwIfAborted();
    const frame = parseCaptureFrame(line);
    if (frame === null) {
      counts.skipped += 1;
      continue;
    }
    counts.parsed += 1;
    const delta = previousTime === null ? 0 : frame.captureTime - previousTime;
    if (captureAnchor === null || delta < -1_000 || delta > MAX_CAPTURE_GAP_MS) {
      if (captureAnchor !== null) {
        console.warn(`simulator: capture clock discontinuity ${delta.toFixed(3)} ms; re-anchoring`);
      }
      captureAnchor = frame.captureTime;
      anchor = clock.now();
    }
    previousTime = frame.captureTime;
    const deadline = anchor + frame.captureTime - captureAnchor;
    for (;;) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      await clock.wait(remaining, options.signal);
    }
    options.signal.throwIfAborted();
    options.progress(frame.captureTime);
    if (matchesReceiveFilter(frame.message)) {
      options.receive(frame.message);
      counts.delivered += 1;
    }
  }
  if (counts.delivered === 0) {
    throw new Error("The capture contains no recognised CAN frames. Use absolute/date candump -tA text.");
  }
  console.log(`simulator: ${counts.delivered} received, ${counts.parsed} parsed, ${counts.skipped} unparsed lines`);
  return counts;
}

export interface ReplayCounts {
  parsed: number;
  delivered: number;
  skipped: number;
}

export interface ReplayClock {
  now: () => number;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ReplaySourceOptions {
  path: string;
  signal: AbortSignal;
  receive: (message: CanMessage) => void;
  progress: (captureTime: number) => void;
  clock?: ReplayClock;
  lines?: AsyncIterable<string>;
}

export interface CaptureFrame {
  captureTime: number;
  message: CanMessage;
}

export const MAX_CAPTURE_GAP_MS = 30_000;
const REAL_CLOCK: ReplayClock = {
  now: monotonicNow,
  wait: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};

// Absolute/date candump only. Keeping the date makes midnight an ordinary interval.
export function parseCaptureFrame(line: string): CaptureFrame | null {
  const match =
    /^\s*\((\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})\)\s+\S+\s+([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})\s+\[(\d{1,2})\]\s*(.*?)\s*$/.exec(
      line
    );
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, identifier, length, text] = match;
  const date = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (new Date(date).toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null;
  const bytes = text === "" ? [] : text.split(/\s+/);
  if (bytes.length !== Number(length) || bytes.length > 64 || bytes.some(byte => !/^[0-9A-Fa-f]{2}$/.test(byte)))
    return null;
  const id = Number.parseInt(identifier, 16);
  if (id > (identifier.length === 3 ? 0x7ff : 0x1fffffff)) return null;
  return {
    captureTime: date + Number(fraction.padEnd(6, "0")) / 1000,
    message: { id, data: Buffer.from(bytes.join(""), "hex"), ext: identifier.length === 8 },
  };
}
