import assert from "node:assert/strict";
import type { CanMessage, RawChannel } from "socketcan";
import { monotonicNow, since } from "../src/monotonic.ts";

export function scriptedChannel(
  outcome: (frame: CanMessage, attempt: number) => number | Error = () => 16,
  onAccepted: (frame: CanMessage) => void = () => {}
): ScriptedChannel {
  const attempted: CanMessage[] = [];
  const accepted: CanMessage[] = [];
  const channel: RawChannel = {
    send(frame) {
      const copied = { ...frame, data: Buffer.from(frame.data) };
      attempted.push(copied);
      const result = outcome(copied, attempted.length);
      if (result instanceof Error) {
        throw result;
      }
      if (result === 16) {
        accepted.push(copied);
        onAccepted(copied);
      }
      return result;
    },
    addListener() {},
    setRxFilters() {},
    disableLoopback() {},
    start: () => channel,
    stop: () => channel,
  };
  return { channel, attempted, accepted };
}

export interface ScriptedChannel {
  channel: RawChannel;
  attempted: CanMessage[];
  accepted: CanMessage[];
}

export async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 1500): Promise<void> {
  const startedAt = monotonicNow();
  while (!predicate() && since(startedAt) < timeoutMs) {
    await delay(2);
  }
  assert(predicate(), `Timed out waiting for ${description}`);
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function captureCanErrors(): { messages: string[]; restore: () => void } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...arguments_: unknown[]) => messages.push(arguments_.map(String).join(" "));
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

export function addressedReply(payload: number[]): Buffer {
  return Buffer.from([0xf1, payload.length, ...payload, ...Array<number>(6 - payload.length).fill(0)]);
}
