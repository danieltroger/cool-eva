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
// Since 2026-08-16 it also models the MULTI-FRAME half, in both directions: it
// reassembles a segmented request (which only `0x35` produces), optionally answers
// its First Frame with a flow control, and segments its own long replies and waits
// for ours. That is what lets scripts/check-kwp-multiframe.ts exercise the
// `0x35`/`0x36`/`0x37` sequence and its cancellation without a bike.
//
// ── ⚠️ IT IS A TEST DOUBLE, AND THE MULTI-FRAME HALF IS A DOUBLE OF A GUESS ──
// The single-frame behaviours above are modelled from things measured on the bike.
// The multi-frame ones are not, and cannot be: no multi-frame reply, no flow-control
// frame and no `0x36` payload has ever been captured on this channel. So passing
// against this proves the client is well-behaved against the framing this repo
// believes in — it does not prove the bike behaves that way. src/vcu/multiframe-codec.ts
// marks each individual guess.

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
  /** Component number → the whole `0x17` reply payload, service byte included. */
  freezeFrames?: Map<number, Uint8Array>;
  /** The whole `0x18` reply payload, service byte included. */
  storedDtcList?: Uint8Array;
  /** The bulk `0x35`/`0x36`/`0x37` upload this micro will serve, if any. */
  upload?: SimulatedUpload;
  /**
   * Services this micro hears and does not answer, even with a session open.
   *
   * Silence is not a refusal, and on this bus it is the commoner failure of the
   * two: a micro that opened an upload and then said nothing leaves the tester
   * holding a transfer it must still close. Modelled separately from
   * `silentIndices` because that one is about a parameter, not a service.
   */
  silentServices?: number[];
  /**
   * Whether this micro answers OUR multi-frame request's First Frame with a flow
   * control of its own.
   *
   * ⚠️ Both settings are modelled because which one the bike does is UNKNOWN — no
   * flow-control frame has ever been captured on this channel in either direction.
   * src/vcu/multiframe-transfer.ts sends the remaining frames anyway on a timeout,
   * and `false` here is what proves that path works rather than merely exists.
   * Defaults to true.
   */
  sendsRequestFlowControl?: boolean;
}

export interface SimulatedUpload {
  /** The `75` reply's body, after the service byte. The captured one is `12 E9`. */
  grantBody: Uint8Array;
  /** Each `0x36` block's body, after the service byte, in order. */
  blocks: Uint8Array[];
  /**
   * What the micro answers once `blocks` runs out. An empty body is
   * `isUploadFinished`'s end-of-upload marker; a refusal models a micro that ends
   * the transfer by saying no instead.
   */
  afterLastBlock?: "empty-body" | "refuse";
}

export interface SimulatedBus {
  /** Hand this to createVcuKwpClient, and wire its onMessage to the client. */
  channel: RawChannel;
  /** Every request payload the bus carried, as "A9 22 11 02". The read-only assertions read this. */
  sentRequests: string[];
  /** Every frame the tester put on the bus, as "A8 30 FF 00". Flow control shows up here and nowhere else. */
  sentFrames: string[];
}

const SERVICE_START_SESSION = 0x10;
const SERVICE_TESTER_PRESENT = 0x3e;
const SERVICE_READ_BY_COMMON_IDENTIFIER = 0x22;
const SERVICE_READ_DTC_INFORMATION = 0x17;
const SERVICE_READ_DTC_BY_STATUS = 0x18;
const SERVICE_REQUEST_UPLOAD = 0x35;
const SERVICE_TRANSFER_DATA = 0x36;
const SERVICE_REQUEST_TRANSFER_EXIT = 0x37;
const POSITIVE_RESPONSE_OFFSET = 0x40;
const DEFAULT_SESSION_IDLE_MS = 2500;

/** Replies land on the next tick or two, so the client's timers are exercised rather than short-circuited. */
const REPLY_DELAY_MS = 2;

/** Payload bytes each frame type carries under extended addressing. */
const MAX_SINGLE_FRAME_PAYLOAD = 6;
const FIRST_FRAME_PAYLOAD_BYTES = 5;
const CONSECUTIVE_FRAME_PAYLOAD_BYTES = 6;

export function simulateVcuMicros(micros: SimulatedMicro[]): SimulatedBus {
  const sentRequests: string[] = [];
  const sentFrames: string[] = [];
  const listeners: ((message: CanMessage) => void)[] = [];
  const sessionOpenedAt = new Map<number, number>();
  /** Per-micro state that spans frames: a half-received request, a half-sent reply, an open upload. */
  const conversations = new Map<number, Conversation>();

  const channel: RawChannel = {
    addListener(_event: string, callback: (message: CanMessage) => void): void {
      listeners.push(callback);
    },
    send(message: CanMessage): number {
      const address = message.data[0];
      sentFrames.push(Array.from(message.data.subarray(0, 8), toHexByte).join(" "));
      // Matched on the id AND the address, so a request sent to the right ECU on the
      // wrong CAN id gets the silence it would get on the real bus. That is the whole
      // point of modelling the charge manager's 0x7C3 separately: if the pairing in
      // param-codec.ts is wrong, this must not paper over it.
      const micro = micros.find(
        candidate => addressOf(candidate) === address && canIdsFor(candidate.target).request === message.id
      );
      if (micro) {
        receiveFrame({ micro, listeners, sessionOpenedAt, sentRequests, conversations }, message.data);
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
  return { channel, sentRequests, sentFrames };
}

interface BusContext {
  micro: SimulatedMicro;
  listeners: ((message: CanMessage) => void)[];
  sessionOpenedAt: Map<number, number>;
  sentRequests: string[];
  conversations: Map<number, Conversation>;
}

interface Conversation {
  /** A request being reassembled: the buffer, how much has arrived, the next sequence number. */
  incoming: { payload: Uint8Array; filled: number; expectedSequenceNumber: number } | null;
  /** A reply being sent: the frames still to go out. */
  outgoing: Uint8Array[];
  /** How many blocks of an open upload have been handed over. Null when no upload is open. */
  uploadPosition: number | null;
}

/** One frame from the tester. Single, first, consecutive or flow control. */
function receiveFrame(context: BusContext, data: Buffer): void {
  const conversation = conversationFor(context);
  const protocolControl = data[1];
  switch (protocolControl >> 4) {
    case 0x0: {
      const length = protocolControl & 0x0f;
      handleRequestPayload(context, Uint8Array.from(data.subarray(2, 2 + length)));
      return;
    }
    case 0x1: {
      const totalLength = ((protocolControl & 0x0f) << 8) | data[2];
      conversation.incoming = {
        payload: new Uint8Array(totalLength),
        filled: FIRST_FRAME_PAYLOAD_BYTES,
        expectedSequenceNumber: 1,
      };
      conversation.incoming.payload.set(data.subarray(3, 8));
      if (context.micro.sendsRequestFlowControl !== false) {
        // `30 FF 00` back at the tester: clear to send, no separation time. The
        // mirror image of what the tester sends us, and the frame whose real
        // existence on this bus is unknown.
        setTimeout(() => deliverFrame(context, Uint8Array.from([TESTER_ADDRESS, 0x30, 0xff, 0x00])), REPLY_DELAY_MS);
      }
      return;
    }
    case 0x2: {
      const incoming = conversation.incoming;
      if (!incoming) {
        // A consecutive frame with no first frame. Silence, the way a real ECU
        // with no open transfer would treat it.
        return;
      }
      if ((protocolControl & 0x0f) !== incoming.expectedSequenceNumber) {
        conversation.incoming = null;
        return;
      }
      incoming.expectedSequenceNumber = (incoming.expectedSequenceNumber + 1) & 0x0f;
      const take = Math.min(CONSECUTIVE_FRAME_PAYLOAD_BYTES, incoming.payload.length - incoming.filled);
      incoming.payload.set(data.subarray(2, 2 + take), incoming.filled);
      incoming.filled += take;
      if (incoming.filled >= incoming.payload.length) {
        conversation.incoming = null;
        handleRequestPayload(context, incoming.payload);
      }
      return;
    }
    case 0x3:
      // The tester's flow control, answering a multi-frame reply of ours. Send the rest.
      sendOutgoing(context, conversation);
      return;
    default:
      return;
  }
}

/** A whole request payload, however many frames it took. */
function handleRequestPayload(context: BusContext, payload: Uint8Array): void {
  context.sentRequests.push([addressOf(context.micro), ...payload].map(toHexByte).join(" "));
  const reply = respond(context, payload);
  if (reply) {
    setTimeout(() => sendReply(context, reply), REPLY_DELAY_MS);
  }
}

/** The reply payload, or null for the silence that is this bus's most common answer. */
function respond(context: BusContext, payload: Uint8Array): Uint8Array | null {
  const { micro, sessionOpenedAt } = context;
  const openedAt = sessionOpenedAt.get(addressOf(micro));
  const sessionOpen = openedAt !== undefined && since(openedAt) < (micro.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);

  if (payload[0] === SERVICE_START_SESSION) {
    sessionOpenedAt.set(addressOf(micro), monotonicNow());
    return Uint8Array.from([SERVICE_START_SESSION + POSITIVE_RESPONSE_OFFSET, payload[1]]);
  }
  if (!sessionOpen) {
    // The wake-word rule: no session, no answer, not even a negative one.
    return null;
  }
  // Any accepted request refreshes the idle timer, which is what lets a sweep that
  // keeps moving never need a second `10 81`.
  sessionOpenedAt.set(addressOf(micro), monotonicNow());

  if (micro.silentServices?.includes(payload[0])) {
    // Heard, acted on internally, and not answered. For `0x35` that means the
    // upload really does open — which is exactly the state a tester must not walk
    // away from.
    if (payload[0] === SERVICE_REQUEST_UPLOAD && micro.upload) {
      conversationFor(context).uploadPosition = 0;
    }
    return null;
  }

  switch (payload[0]) {
    case SERVICE_TESTER_PRESENT:
      return Uint8Array.from([SERVICE_TESTER_PRESENT + POSITIVE_RESPONSE_OFFSET]);
    case SERVICE_READ_BY_COMMON_IDENTIFIER:
      return respondToParameterRead(micro, payload);
    case SERVICE_READ_DTC_INFORMATION:
      return micro.freezeFrames?.get((payload[1] << 8) | payload[2]) ?? refusal(SERVICE_READ_DTC_INFORMATION, 0x31);
    case SERVICE_READ_DTC_BY_STATUS:
      return micro.storedDtcList ?? refusal(SERVICE_READ_DTC_BY_STATUS, 0x31);
    case SERVICE_REQUEST_UPLOAD:
      return respondToRequestUpload(context, payload);
    case SERVICE_TRANSFER_DATA:
      return respondToTransferData(context);
    case SERVICE_REQUEST_TRANSFER_EXIT:
      conversationFor(context).uploadPosition = null;
      return Uint8Array.from([SERVICE_REQUEST_TRANSFER_EXIT + POSITIVE_RESPONSE_OFFSET, 0xff]);
    default:
      // Loud, not silent. Nothing in this repo can build such a request, so reaching
      // here means the read-only guarantee has been broken and the test double is the
      // last place that can still say so. The permitted set grew on 2026-08-16 with
      // the multi-frame reads; it must never grow to include a write.
      throw new Error(`simulated micro: refusing to model service 0x${toHexByte(payload[0])} — this bus is read-only`);
  }
}

function respondToParameterRead(micro: SimulatedMicro, payload: Uint8Array): Uint8Array | null {
  const identifier = (payload[1] << 8) | payload[2];
  const bank = identifier >> 12;
  const index = identifier & 0x0fff;
  // The bank is honoured rather than masked away. DIAG_ADDRESSES.md §3 records bank 0
  // being refused with NRC 0x12 subFunctionNotSupported — so a bank nothing is
  // configured for answers by name here, which is how a probe of an empty bank is
  // told apart from a probe of an ECU that is not there.
  const bankRecords = bank === 1 ? micro.records : bank === 2 ? micro.liveRecords : undefined;
  if (!bankRecords) {
    return refusal(SERVICE_READ_BY_COMMON_IDENTIFIER, 0x12);
  }
  if (bank === 1 && micro.silentIndices?.includes(index)) {
    return null;
  }
  const record = bankRecords.get(index);
  if (!record || (bank === 1 && micro.refusedIndices?.includes(index))) {
    return refusal(SERVICE_READ_BY_COMMON_IDENTIFIER, 0x31);
  }
  return Uint8Array.from([
    SERVICE_READ_BY_COMMON_IDENTIFIER + POSITIVE_RESPONSE_OFFSET,
    payload[1],
    payload[2],
    ...record,
  ]);
}

function respondToRequestUpload(context: BusContext, payload: Uint8Array): Uint8Array | null {
  const upload = context.micro.upload;
  if (!upload) {
    return refusal(SERVICE_REQUEST_UPLOAD, 0x31);
  }
  if (payload.length !== 12) {
    // The captured request is 12 bytes. A micro that got a different length is
    // modelled as refusing it, so a segmenter that dropped or duplicated a
    // consecutive frame fails here rather than passing.
    return refusal(SERVICE_REQUEST_UPLOAD, 0x13);
  }
  conversationFor(context).uploadPosition = 0;
  return Uint8Array.from([SERVICE_REQUEST_UPLOAD + POSITIVE_RESPONSE_OFFSET, ...upload.grantBody]);
}

function respondToTransferData(context: BusContext): Uint8Array | null {
  const upload = context.micro.upload;
  const conversation = conversationFor(context);
  if (!upload || conversation.uploadPosition === null) {
    // No upload open. `0x24 requestSequenceError` is what a `36` before its `35`
    // should draw, and modelling it is how the check proves the runner opens one.
    return refusal(SERVICE_TRANSFER_DATA, 0x24);
  }
  if (conversation.uploadPosition >= upload.blocks.length) {
    if (upload.afterLastBlock === "refuse") {
      return refusal(SERVICE_TRANSFER_DATA, 0x31);
    }
    return Uint8Array.from([SERVICE_TRANSFER_DATA + POSITIVE_RESPONSE_OFFSET]);
  }
  const block = upload.blocks[conversation.uploadPosition];
  conversation.uploadPosition += 1;
  return Uint8Array.from([SERVICE_TRANSFER_DATA + POSITIVE_RESPONSE_OFFSET, ...block]);
}

function refusal(service: number, negativeResponseCode: number): Uint8Array {
  return Uint8Array.from([0x7f, service, negativeResponseCode]);
}

/** Queues a reply, segmenting it when it does not fit one frame, and sends the first frame. */
function sendReply(context: BusContext, payload: Uint8Array): void {
  const conversation = conversationFor(context);
  if (payload.length <= MAX_SINGLE_FRAME_PAYLOAD) {
    const frame = new Uint8Array(8);
    frame[0] = TESTER_ADDRESS;
    frame[1] = payload.length;
    frame.set(payload, 2);
    deliverFrame(context, frame);
    return;
  }

  const first = new Uint8Array(8);
  first[0] = TESTER_ADDRESS;
  first[1] = 0x10 | (payload.length >> 8);
  first[2] = payload.length & 0xff;
  first.set(payload.subarray(0, FIRST_FRAME_PAYLOAD_BYTES), 3);

  conversation.outgoing = [];
  let sent = FIRST_FRAME_PAYLOAD_BYTES;
  let sequenceNumber = 1;
  while (sent < payload.length) {
    const consecutive = new Uint8Array(8);
    consecutive[0] = TESTER_ADDRESS;
    consecutive[1] = 0x20 | (sequenceNumber & 0x0f);
    const take = Math.min(CONSECUTIVE_FRAME_PAYLOAD_BYTES, payload.length - sent);
    consecutive.set(payload.subarray(sent, sent + take), 2);
    conversation.outgoing.push(consecutive);
    sent += take;
    sequenceNumber += 1;
  }
  // Only the First Frame goes out now. The rest waits for the tester's flow
  // control — which is the whole behaviour under test, and modelling it as
  // anything else would let a client that never sends one pass.
  deliverFrame(context, first);
}

function sendOutgoing(context: BusContext, conversation: Conversation): void {
  const frames = conversation.outgoing;
  conversation.outgoing = [];
  for (const [index, frame] of frames.entries()) {
    // Spread across ticks rather than delivered in one synchronous burst, so the
    // client's per-frame handling and its transfer timer are both exercised.
    setTimeout(() => deliverFrame(context, frame), REPLY_DELAY_MS * (index + 1));
  }
}

function conversationFor(context: BusContext): Conversation {
  const address = addressOf(context.micro);
  const existing = context.conversations.get(address);
  if (existing) {
    return existing;
  }
  const created: Conversation = { incoming: null, outgoing: [], uploadPosition: null };
  context.conversations.set(address, created);
  return created;
}

/** Byte 0 of a request addressed to this stand-in. The real mapping lives in param-codec.ts. */
function addressOf(micro: SimulatedMicro): number {
  return { A8: 0xa8, A9: 0xa9 }[micro.target];
}

function deliverFrame(context: BusContext, frame: Uint8Array): void {
  const data = Buffer.alloc(8);
  Buffer.from(frame).copy(data);
  for (const listener of context.listeners) {
    listener({ id: canIdsFor(context.micro.target).response, data });
  }
}

function toHexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
