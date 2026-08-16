import type { CanMessage, RawChannel, RxFilter } from "socketcan";
import { monotonicNow, since } from "../src/monotonic.ts";
import { TESTER_ADDRESS, canIdsFor, type VcuTarget } from "../src/vcu/param-codec.ts";

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
  /** Which target this stands in for. Decides its address AND which CAN ids it speaks on. */
  target: VcuTarget;
  /** Bank-1 index → the record it answers with. */
  records: Map<number, Uint8Array>;
  /**
   * Bank-2 index → record. Bank 2 is live data on the real bus, so a probe of it
   * must be modelled separately from the calibration bank rather than aliased onto
   * it — otherwise a bank bug in the encoder would pass here.
   */
  liveRecords?: Map<number, Uint8Array>;
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
      const address = message.data[0];
      const payload = message.data.subarray(2, 2 + message.data[1]);
      sentRequests.push([address, ...payload].map(toHexByte).join(" "));
      // Matched on the id AND the address, so a request sent to the right ECU on the
      // wrong CAN id gets the silence it would get on the real bus. That is the whole
      // point of modelling the charge manager's 0x7C3 separately: if the pairing in
      // param-codec.ts is wrong, this must not paper over it.
      const micro = micros.find(
        candidate => addressOf(candidate) === address && canIdsFor(candidate.target).request === message.id
      );
      if (micro) {
        const reply = respond(micro, payload, sessionOpenedAt);
        if (reply) {
          setTimeout(() => deliver(listeners, canIdsFor(micro.target).response, reply), REPLY_DELAY_MS);
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
  const openedAt = sessionOpenedAt.get(addressOf(micro));
  const sessionOpen = openedAt !== undefined && since(openedAt) < (micro.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);

  if (payload[0] === SERVICE_START_SESSION) {
    sessionOpenedAt.set(addressOf(micro), monotonicNow());
    return Uint8Array.from([SERVICE_START_SESSION + 0x40, payload[1]]);
  }
  if (!sessionOpen) {
    // The wake-word rule: no session, no answer, not even a negative one.
    return null;
  }
  // Any accepted request refreshes the idle timer, which is what lets a sweep that
  // keeps moving never need a second `10 81`.
  sessionOpenedAt.set(addressOf(micro), monotonicNow());

  if (payload[0] === SERVICE_TESTER_PRESENT) {
    return Uint8Array.from([SERVICE_TESTER_PRESENT + 0x40]);
  }
  if (payload[0] !== SERVICE_READ_BY_COMMON_IDENTIFIER) {
    // Loud, not silent. Nothing in this repo can build such a request, so reaching
    // here means the read-only guarantee has been broken and the test double is the
    // last place that can still say so.
    throw new Error(`simulated micro: refusing to model service 0x${toHexByte(payload[0])} — this bus is read-only`);
  }
  const identifier = (payload[1] << 8) | payload[2];
  const bank = identifier >> 12;
  const index = identifier & 0x0fff;
  // The bank is honoured rather than masked away. DIAG_ADDRESSES.md §3 records bank 0
  // being refused with NRC 0x12 subFunctionNotSupported — so a bank nothing is
  // configured for answers by name here, which is how a probe of an empty bank is
  // told apart from a probe of an ECU that is not there.
  const bankRecords = bank === 1 ? micro.records : bank === 2 ? micro.liveRecords : undefined;
  if (!bankRecords) {
    return Uint8Array.from([0x7f, SERVICE_READ_BY_COMMON_IDENTIFIER, 0x12]);
  }
  if (bank === 1 && micro.silentIndices?.includes(index)) {
    return null;
  }
  const record = bankRecords.get(index);
  if (!record || (bank === 1 && micro.refusedIndices?.includes(index))) {
    return Uint8Array.from([0x7f, SERVICE_READ_BY_COMMON_IDENTIFIER, 0x31]);
  }
  return Uint8Array.from([SERVICE_READ_BY_COMMON_IDENTIFIER + 0x40, payload[1], payload[2], ...record]);
}

/** Byte 0 of a request addressed to this stand-in. The real mapping lives in param-codec.ts. */
function addressOf(micro: SimulatedMicro): number {
  return { A8: 0xa8, A9: 0xa9 }[micro.target];
}

function deliver(listeners: ((message: CanMessage) => void)[], responseCanId: number, payload: Uint8Array): void {
  const data = Buffer.alloc(8);
  data[0] = TESTER_ADDRESS;
  data[1] = payload.length;
  Buffer.from(payload).copy(data, 2);
  for (const listener of listeners) {
    listener({ id: responseCanId, data });
  }
}

function toHexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
