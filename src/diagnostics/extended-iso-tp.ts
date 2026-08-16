// The receive half of ISO-TP under EXTENDED addressing — the framing the VCU
// micros use, and the one thing standing between a `0x17` reply and a decoded
// freeze frame.
//
// Pure: frames in, payload out. No clock, no socket, nothing sent. Sending the
// flow-control frame and giving up on a stalled transfer belong to a caller, the
// same split src/can/iso-tp.ts makes — and for the same reason, which is that it
// lets a transfer be replayed from a capture with no bike attached.
//
// ── ⚠️ WHY THIS IS NOT src/can/iso-tp.ts ────────────────────────────────────
// That module assumes NORMAL addressing: byte 0 is the PCI and the payload starts
// at byte 1. The VCU's diagnostic channel puts the ADDRESS in byte 0 — `0xA8` /
// `0xA9` outbound, `0xF1` (the tester) inbound — and everything shifts one along.
// Every length in the two files therefore differs by one:
//
//                          normal (src/can/iso-tp.ts)   extended (here)
//   Single Frame payload            up to 7                 up to 6
//   First Frame payload               6                       5
//   Consecutive Frame payload         7                       6
//
// Feeding an extended-addressed frame to the normal reassembler does not throw.
// It reads the address byte as a PCI — `0xF1` has top nibble 0xF, so a reply
// would be silently `ignored` as an unknown PCI and the transfer would simply
// never complete. src/vcu/param-codec.ts' header records the same incompatibility
// from the other direction. Two small correct readers beat one parameterised one
// whose caller has to remember which mode it is in.
//
// ── ⚠️ THE FLOW-CONTROL FRAME, AND WHO SENDS IT ────────────────────────────
// Since 2026-08-16 somebody does: src/vcu/multiframe-transfer.ts drives this
// class, answers a First Frame with `<target> 30 FF 00` synchronously from its
// frame handler, and takes a lease from src/vcu/bus-lease.ts before it starts.
// The paragraph below is kept because it is still the reason this split exists —
// and because the property it worries about was preserved rather than spent: the
// flow control is addressed to the target the CALLER named, never to an address
// read off the bus.
//
// A multi-frame reply does not arrive unless the tester answers the First Frame
// with `<target> 30 FF 00`. Verified on this bike for the OBD channel on
// 2026-08-04: with no flow control, 0 of 8 mode-03 requests produced a single
// Consecutive Frame. So reading a freeze frame means TRANSMITTING between the
// request and the rest of the reply — and every freeze frame is multi-frame,
// because the header alone is 5 bytes and a single frame holds 6.
//
// src/vcu/kwp-client.ts, which owns the only KWP session machinery in this repo,
// deliberately never sends one: "no flow-control frame is ever sent: this module
// derives no transmit address from anything the bus said". That property survives
// a freeze-frame read — the flow-control frame goes to the target the CALLER
// named, never to anything read off the bus — but the transport still has to be
// taught to send it, and that is a change to src/vcu/, not to this file.
//
// Whoever does it: take a lease from src/vcu/bus-lease.ts first. The micros answer
// on ONE CAN id with no request/response tag, so a freeze-frame reply and a
// parameter read in flight together are resolved by whichever frame lands first —
// and a multi-frame read holds the bus for several frames rather than one.

/** What one frame did to the transfer. Mirrors src/can/iso-tp.ts' vocabulary on purpose. */
export type ExtendedIsoTpResult =
  /** Consumed; more frames are needed before there is a payload. */
  | { status: "incomplete" }
  /** A First Frame landed. The caller MUST now send `<target> 30 FF 00` or the rest never comes. */
  | { status: "flow-control-required"; totalLength: number }
  /** The payload is whole. `payload` excludes the address and every PCI byte. */
  | { status: "complete"; payload: Uint8Array }
  /** Not part of a transfer we are following. Never an error on a shared bus. */
  | { status: "ignored"; reason: string }
  /** The transfer is unusable and has been reset. Worth a log line. */
  | { status: "abandoned"; reason: string };

/** The tester's own address. Every reply meant for us is addressed to it. */
const TESTER_ADDRESS = 0xf1;

/**
 * Longest payload this will assemble.
 *
 * The largest freeze frame Energica's own table can describe is 25 bytes — a
 * 5-byte header plus (51,0) P1050's twelve fields, which is
 * `MAX_FREEZE_FRAME_FIELD_BYTES` in ./fault-infokeys.ts and is asserted at 20 by
 * scripts/check-freeze-frame.ts. This is deliberately well ABOVE that rather than
 * derived from it, so the two are tied together by that assertion rather than by
 * an import. That slack is the whole point: if the
 * layout inferred in ./freeze-frame.ts is wrong, the reply will be some other
 * length, and a cap set at 25 would throw away the one piece of evidence that
 * would show it. A generous cap keeps the bytes so the decoder can report them;
 * it is here only to bound what a stuck responder can make us hold.
 */
const MAX_PAYLOAD_BYTES = 64;

/**
 * The frame-count guard for a given byte cap: a First Frame carries 5 bytes and
 * each Consecutive Frame at most 6, plus the First Frame itself.
 *
 * Derived rather than picked so the two cannot drift apart, and computed from
 * whatever cap an instance was given rather than from the default — otherwise a
 * caller that raised the byte cap would hit a frame cap sized for the old one and
 * see a long reply abandoned as "too many frames", which is a true statement
 * about the wrong number. Bounds a responder that keeps sending frames
 * contributing nothing: a loop rather than a leak, but it still has to terminate.
 */
export function maxFramesFor(maxPayloadBytes: number): number {
  return Math.ceil((maxPayloadBytes - FIRST_FRAME_PAYLOAD_BYTES) / CONSECUTIVE_FRAME_PAYLOAD_BYTES) + 1;
}

const SINGLE_FRAME = 0x0;
const FIRST_FRAME = 0x1;
const CONSECUTIVE_FRAME = 0x2;
const FLOW_CONTROL_FRAME = 0x3;

/** Payload bytes a First Frame carries under extended addressing. */
const FIRST_FRAME_PAYLOAD_BYTES = 5;
/** Payload bytes a Consecutive Frame carries under extended addressing. */
const CONSECUTIVE_FRAME_PAYLOAD_BYTES = 6;
/** Largest payload that fits one frame: 8 bytes − 1 address − 1 PCI. */
const MAX_SINGLE_FRAME_PAYLOAD = 6;

/**
 * Reassembles one extended-addressed ISO-TP transfer.
 *
 * Stateful, like IsoTpReassembler. One instance follows one transfer; `reset()`
 * between requests so a straggler from the previous one cannot be mistaken for
 * the start of the next.
 */
export class ExtendedIsoTpReassembler {
  #payload: Uint8Array = new Uint8Array(0);
  #filled = 0;
  #expectedSequenceNumber = 1;
  #frames = 0;
  #receiving = false;
  readonly #maxPayloadBytes: number;
  readonly #maxFrames: number;

  /**
   * `maxPayloadBytes` defaults to the freeze-frame figure argued above. It is a
   * parameter because the other multi-frame reads on this channel are not freeze
   * frames and are not bounded by the same table: a `0x18` ReadDTCByStatus reply
   * is `58 <count>` plus a 3-byte record per stored code, so 63 components would
   * be 191 bytes and a cap of 64 would abandon a perfectly good list.
   *
   * It is deliberately not "large enough for anything". The cap exists to bound
   * what a stuck or hostile responder can make this process hold, so a caller
   * states the largest reply IT can justify rather than inheriting a number
   * argued for a different service.
   */
  constructor(maxPayloadBytes: number = MAX_PAYLOAD_BYTES) {
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes <= MAX_SINGLE_FRAME_PAYLOAD) {
      // A cap that a single frame already satisfies would abandon every transfer
      // this class exists to assemble. A caller bug, so it is loud immediately
      // rather than at the first First Frame.
      throw new Error(
        `extended-iso-tp: a payload cap of ${maxPayloadBytes} cannot hold a multi-frame reply ` +
          `(it must exceed the ${MAX_SINGLE_FRAME_PAYLOAD} bytes a single frame carries)`
      );
    }
    this.#maxPayloadBytes = maxPayloadBytes;
    this.#maxFrames = maxFramesFor(maxPayloadBytes);
  }

  push(frame: Uint8Array): ExtendedIsoTpResult {
    if (frame.length < 2) {
      return { status: "ignored", reason: "frame shorter than an address plus a PCI byte" };
    }
    if (frame[0] !== TESTER_ADDRESS) {
      // Another tester's traffic, or a micro answering something that is not us.
      // Handed back rather than swallowed — the caller shares this socket.
      return { status: "ignored", reason: `addressed to 0x${frame[0].toString(16)}, not the tester` };
    }
    if (this.#frames >= this.#maxFrames) {
      const reason = `more than ${this.#maxFrames} frames in one transfer`;
      this.reset();
      return { status: "abandoned", reason };
    }
    this.#frames += 1;

    switch (frame[1] >> 4) {
      case SINGLE_FRAME:
        return this.#pushSingleFrame(frame);
      case FIRST_FRAME:
        return this.#pushFirstFrame(frame);
      case CONSECUTIVE_FRAME:
        return this.#pushConsecutiveFrame(frame);
      case FLOW_CONTROL_FRAME:
        return { status: "ignored", reason: "flow-control frame, which is ours to send and never to receive" };
      default:
        return { status: "ignored", reason: `unknown PCI 0x${(frame[1] >> 4).toString(16)}` };
    }
  }

  reset(): void {
    this.#payload = new Uint8Array(0);
    this.#filled = 0;
    this.#expectedSequenceNumber = 1;
    this.#frames = 0;
    this.#receiving = false;
  }

  #pushSingleFrame(frame: Uint8Array): ExtendedIsoTpResult {
    const length = frame[1] & 0x0f;
    if (length === 0) {
      return { status: "ignored", reason: "single frame declaring zero payload bytes" };
    }
    if (length > MAX_SINGLE_FRAME_PAYLOAD) {
      // Six is all that fits once the address and the PCI are paid for. A larger
      // claim is a frame from a different addressing mode, not a long single frame.
      return {
        status: "ignored",
        reason: `single frame claims ${length} bytes, over the ${MAX_SINGLE_FRAME_PAYLOAD}-byte limit`,
      };
    }
    if (frame.length < 2 + length) {
      return { status: "ignored", reason: `single frame claims ${length} bytes but carries ${frame.length - 2}` };
    }
    // A single frame is a whole transfer, so anything half-received is stale.
    this.reset();
    // COPIED, not a subarray view. The caller is handed a Buffer straight out of
    // the CAN socket and the payload outlives the frame handler, so a driver that
    // reuses its receive buffer would rewrite bytes we had already "read" — the
    // same reasoning as src/vcu/param-codec.ts' parseResponseFrame.
    return { status: "complete", payload: Uint8Array.from(frame.subarray(2, 2 + length)) };
  }

  #pushFirstFrame(frame: Uint8Array): ExtendedIsoTpResult {
    if (frame.length < 8) {
      return { status: "ignored", reason: "first frame shorter than 8 bytes" };
    }
    const totalLength = ((frame[1] & 0x0f) << 8) | frame[2];
    if (totalLength <= MAX_SINGLE_FRAME_PAYLOAD) {
      // Would have fitted in a single frame. Honouring it would leave us waiting
      // for a Consecutive Frame that is never coming.
      return { status: "ignored", reason: `first frame declares only ${totalLength} bytes` };
    }
    if (totalLength > this.#maxPayloadBytes) {
      const reason = `first frame declares ${totalLength} bytes, over the ${this.#maxPayloadBytes} cap`;
      this.reset();
      return { status: "abandoned", reason };
    }
    // Allocated up front from a length just bounded, so the buffer cannot grow
    // past it however many frames arrive.
    this.#payload = new Uint8Array(totalLength);
    this.#payload.set(frame.subarray(3, 8));
    this.#filled = FIRST_FRAME_PAYLOAD_BYTES;
    this.#expectedSequenceNumber = 1;
    this.#frames = 1;
    this.#receiving = true;
    return { status: "flow-control-required", totalLength };
  }

  #pushConsecutiveFrame(frame: Uint8Array): ExtendedIsoTpResult {
    if (!this.#receiving) {
      return { status: "ignored", reason: "consecutive frame with no first frame" };
    }
    const sequenceNumber = frame[1] & 0x0f;
    if (sequenceNumber !== this.#expectedSequenceNumber) {
      // A gap means bytes are missing and the payload would be silently wrong —
      // far worse than no payload, because a freeze frame full of shifted bytes
      // still decodes into numbers with units on them.
      const reason = `consecutive frame out of sequence (expected ${this.#expectedSequenceNumber}, got ${sequenceNumber})`;
      this.reset();
      return { status: "abandoned", reason };
    }
    this.#expectedSequenceNumber = (this.#expectedSequenceNumber + 1) & 0x0f;

    const remaining = this.#payload.length - this.#filled;
    const available = Math.max(0, frame.length - 2);
    const wanted = Math.min(CONSECUTIVE_FRAME_PAYLOAD_BYTES, remaining);
    if (available < wanted) {
      // Only the LAST consecutive frame may carry fewer than six payload bytes,
      // and then only down to `remaining` — which is what `wanted` already
      // accounts for. Anything shorter than that is a truncated DLC, i.e. missing
      // bytes, and taking what arrived would write the NEXT frame's bytes at the
      // wrong offset. The sequence numbers would still run 1, 2, 3…, so nothing
      // would be abandoned and the transfer would complete at its declared length
      // with every field after the short frame shifted — decoding into int16s
      // with °C on them and an empty `trailingHex`, which is indistinguishable
      // from a good read. Exactly the hazard the sequence check above exists for,
      // with a different cause.
      const reason = `consecutive frame carries ${available} bytes where ${wanted} were needed`;
      this.reset();
      return { status: "abandoned", reason };
    }
    this.#payload.set(frame.subarray(2, 2 + wanted), this.#filled);
    this.#filled += wanted;

    if (this.#filled < this.#payload.length) {
      return { status: "incomplete" };
    }
    const payload = this.#payload;
    this.reset();
    return { status: "complete", payload };
  }
}
