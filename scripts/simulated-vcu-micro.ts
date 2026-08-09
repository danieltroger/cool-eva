import type { CanMessage, RawChannel, RxFilter } from "socketcan";
import { monotonicNow, since } from "../src/monotonic.ts";
import { KWP_REQUEST_CAN_ID, KWP_RESPONSE_CAN_ID, TESTER_ADDRESS } from "../src/vcu/param-codec.ts";

// A stand-in for the VCU micros on a stand-in CAN channel, so the TRANSPORT half of
// reading parameters can be exercised on a laptop. The codec is pure and checks out
// against captured bytes (scripts/check-vcu-params.ts §1-5); this is what covers the
// parts that only exist in time — opening a session, keeping it alive, noticing it
// expired, retrying, telling silence apart from a refusal.
//
// It models the two behaviours that make this bus awkward, both from
// obd-garage/DIAG_ADDRESSES.md §3:
//   • a micro answers NOTHING until `10 81` has been sent — not even a negative
//     response, which is why a conventional sweep finds nothing here;
//   • the session then expires after an idle timeout, silently, so the next read
//     just vanishes rather than being refused.
//
// It is a test double and it says so: it is not a model of the VCU's behaviour
// beyond those two rules, and passing against it proves the client is well-behaved,
// not that the bike is.

export interface SimulatedMicro {
  /** 0xA9 or 0xA8 — byte 0 of a request. */
  address: number;
  /** Bank-1 index → the record it answers with. */
  records: Map<number, Uint8Array>;
  /** Indices that answer nothing at all, the way an unowned parameter does. */
  silentIndices?: number[];
  /** Indices that answer `7F 22 <nrc>`. */
  refusedIndices?: number[];
  /** How long the session survives without traffic. The bike's is ~2500 ms. */
  sessionIdleMs?: number;
}

export interface SimulatedBus {
  /** Hand this to createVcuKwpClient, and wire its onMessage to the client. */
  channel: RawChannel;
  /** Every request payload the bus carried, as "A9 22 11 02". The read-only assertions read this. */
  sentRequests: string[];
}

const SERVICE_START_SESSION = 0x10;
const SERVICE_TESTER_PRESENT = 0x3e;
const SERVICE_READ_BY_COMMON_IDENTIFIER = 0x22;
const DEFAULT_SESSION_IDLE_MS = 2500;

/** Replies land on the next tick or two, so the client's timers are exercised rather than short-circuited. */
const REPLY_DELAY_MS = 2;

export function simulateVcuMicros(micros: SimulatedMicro[]): SimulatedBus {
  const sentRequests: string[] = [];
  const listeners: ((message: CanMessage) => void)[] = [];
  const sessionOpenedAt = new Map<number, number>();

  const channel: RawChannel = {
    addListener(_event: string, callback: (message: CanMessage) => void): void {
      listeners.push(callback);
    },
    send(message: CanMessage): number {
      if (message.id !== KWP_REQUEST_CAN_ID) {
        throw new Error(`simulated bus: request on 0x${message.id.toString(16)}, expected 0x7C0`);
      }
      const address = message.data[0];
      const payload = message.data.subarray(2, 2 + message.data[1]);
      sentRequests.push([address, ...payload].map(toHexByte).join(" "));
      const micro = micros.find(candidate => candidate.address === address);
      if (micro) {
        const reply = respond(micro, payload, sessionOpenedAt);
        if (reply) {
          setTimeout(() => deliver(listeners, reply), REPLY_DELAY_MS);
        }
      }
      return message.data.length;
    },
    start(): RawChannel {
      return channel;
    },
    stop(): RawChannel {
      return channel;
    },
    setRxFilters(_filters: RxFilter | RxFilter[]): void {},
    disableLoopback(): void {},
  };
  return { channel, sentRequests };
}

/** The reply payload, or null for the silence that is this bus's most common answer. */
function respond(micro: SimulatedMicro, payload: Uint8Array, sessionOpenedAt: Map<number, number>): Uint8Array | null {
  const openedAt = sessionOpenedAt.get(micro.address);
  const sessionOpen = openedAt !== undefined && since(openedAt) < (micro.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);

  if (payload[0] === SERVICE_START_SESSION) {
    sessionOpenedAt.set(micro.address, monotonicNow());
    return Uint8Array.from([SERVICE_START_SESSION + 0x40, payload[1]]);
  }
  if (!sessionOpen) {
    // The wake-word rule: no session, no answer, not even a negative one.
    return null;
  }
  // Any accepted request refreshes the idle timer, which is what lets a sweep that
  // keeps moving never need a second `10 81`.
  sessionOpenedAt.set(micro.address, monotonicNow());

  if (payload[0] === SERVICE_TESTER_PRESENT) {
    return Uint8Array.from([SERVICE_TESTER_PRESENT + 0x40]);
  }
  if (payload[0] !== SERVICE_READ_BY_COMMON_IDENTIFIER) {
    // Loud, not silent. Nothing in this repo can build such a request, so reaching
    // here means the read-only guarantee has been broken and the test double is the
    // last place that can still say so.
    throw new Error(`simulated micro: refusing to model service 0x${toHexByte(payload[0])} — this bus is read-only`);
  }
  const index = ((payload[1] << 8) | payload[2]) & 0x0fff;
  if (micro.silentIndices?.includes(index)) {
    return null;
  }
  const record = micro.records.get(index);
  if (!record || micro.refusedIndices?.includes(index)) {
    return Uint8Array.from([0x7f, SERVICE_READ_BY_COMMON_IDENTIFIER, 0x31]);
  }
  return Uint8Array.from([SERVICE_READ_BY_COMMON_IDENTIFIER + 0x40, payload[1], payload[2], ...record]);
}

function deliver(listeners: ((message: CanMessage) => void)[], payload: Uint8Array): void {
  const data = Buffer.alloc(8);
  data[0] = TESTER_ADDRESS;
  data[1] = payload.length;
  Buffer.from(payload).copy(data, 2);
  for (const listener of listeners) {
    listener({ id: KWP_RESPONSE_CAN_ID, data });
  }
}

function toHexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
