// The receive half of ISO-TP (ISO 15765-2), for the one thing on this bike that
// needs it: an OBD-II reply too long for a single CAN frame. Mode 03 answers with
// 80 bytes here, which is a First Frame plus eleven Consecutive Frames.
//
// Pure — frames in, payload out. It reads no clock, sends nothing and holds no
// socket: sending the flow-control frame and giving up on a stalled transfer are
// the caller's job (src/can/obd-dtc.ts). That split is what makes a transfer
// replayable from a candump when the bike is out of reach, the same way
// DiagnosticListAssembler in src/diagnostics/decode.ts is replayable — and the
// 2026-08-04 transfer below is checked into scripts/decode-dtc-response.ts as
// exactly that kind of fixture.
//
// The four frame types are identified by the top nibble of byte 0:
//
//   0x0n  Single Frame       n = payload length (1-7), payload in bytes 1..n
//   0x1n  First Frame        (n<<8)|b1 = total payload length, first 6 bytes follow
//   0x2n  Consecutive Frame  n = sequence number, wrapping 1,2,…,15,0,1,…
//   0x3n  Flow Control       ours to send, never to receive here
//
// Only the classic 12-bit length form is implemented. The escape form (a First
// Frame with length 0 and a 32-bit length in bytes 2-5) exists for payloads over
// 4095 bytes, which no OBD-II service can produce — mode 03's count byte is eight
// bits, so 255 codes × 2 + 2 = 512 bytes is the ceiling for the longest reply
// this bike has.

/** What one frame did to the transfer. */
export type IsoTpResult =
  /** Consumed; more frames are needed before there is a payload. */
  | { status: "incomplete" }
  /**
   * A First Frame landed. The caller MUST now send a flow-control frame or the
   * responder will never send the rest — verified on the bike 2026-08-04: with no
   * flow control, 0 of 8 mode-03 requests produced a single Consecutive Frame.
   */
  | { status: "flow-control-required"; totalLength: number }
  /** The payload is whole. `payload` excludes every PCI byte. */
  | { status: "complete"; payload: Uint8Array }
  /** Not part of a transfer we are following. Never an error. */
  | { status: "ignored"; reason: string }
  /** The transfer is unusable and has been reset. Worth a log line. */
  | { status: "abandoned"; reason: string };

/**
 * Longest payload we will assemble. See the ceiling argument above — 512 bytes is
 * the largest legal OBD-II trouble-code reply, so 1024 is double the worst case
 * and still a hard bound on what a stuck or hostile responder can make us hold.
 */
const MAX_PAYLOAD_BYTES = 1024;

/**
 * Frame-count guard, derived from the byte cap rather than picked separately so
 * the two cannot drift apart: a First Frame carries 6 bytes and each Consecutive
 * Frame at most 7, plus one for the First Frame itself.
 *
 * The byte cap alone very nearly bounds the buffer already (we only ever take
 * `min(7, remaining)` bytes, and `remaining` only falls). This exists for the case
 * that argument misses — a responder that keeps sending frames which contribute
 * nothing, e.g. all-padding Consecutive Frames after a First Frame that declared
 * far more than it intends to send. That is a loop, not a leak, but it is still
 * something that must terminate.
 */
const MAX_FRAMES = Math.ceil((MAX_PAYLOAD_BYTES - 6) / 7) + 1;

const SINGLE_FRAME = 0x0;
const FIRST_FRAME = 0x1;
const CONSECUTIVE_FRAME = 0x2;
const FLOW_CONTROL_FRAME = 0x3;

/**
 * Reassembles one ISO-TP transfer.
 *
 * Stateful, like DiagnosticListAssembler: `push` returns `incomplete` while the
 * payload is still arriving and `complete` on the frame that finishes it. One
 * instance follows one transfer; `reset()` between requests so a straggler from
 * the previous one cannot be mistaken for the start of the next.
 */
export class IsoTpReassembler {
  #payload: Uint8Array = new Uint8Array(0);
  #filled = 0;
  #expectedSequenceNumber = 1;
  #frames = 0;
  #receiving = false;

  push(frame: Uint8Array): IsoTpResult {
    if (frame.length < 1) {
      return { status: "ignored", reason: "empty frame" };
    }
    if (this.#frames >= MAX_FRAMES) {
      // Reached only by a responder that keeps sending without ever finishing.
      const reason = `more than ${MAX_FRAMES} frames in one transfer`;
      this.reset();
      return { status: "abandoned", reason };
    }
    this.#frames += 1;

    switch (frame[0] >> 4) {
      case SINGLE_FRAME:
        return this.#pushSingleFrame(frame);
      case FIRST_FRAME:
        return this.#pushFirstFrame(frame);
      case CONSECUTIVE_FRAME:
        return this.#pushConsecutiveFrame(frame);
      case FLOW_CONTROL_FRAME:
        // Ours to send, and the bus echoes nothing back to us, so this is either
        // another tester on the bus or a responder confused about direction.
        return { status: "ignored", reason: "flow-control frame from the bus" };
      default:
        return { status: "ignored", reason: `unknown PCI 0x${(frame[0] >> 4).toString(16)}` };
    }
  }

  reset(): void {
    this.#payload = new Uint8Array(0);
    this.#filled = 0;
    this.#expectedSequenceNumber = 1;
    this.#frames = 0;
    this.#receiving = false;
  }

  #pushSingleFrame(frame: Uint8Array): IsoTpResult {
    const length = frame[0] & 0x0f;
    if (length === 0) {
      // Length 0 is the CAN-FD escape form, which a classic 8-byte bus does not
      // use. Treat it as noise rather than reading byte 1 as a length we would
      // then trust.
      return { status: "ignored", reason: "single frame with zero length" };
    }
    if (frame.length < 1 + length) {
      return { status: "ignored", reason: `single frame claims ${length} bytes but carries ${frame.length - 1}` };
    }
    // A single frame is a whole transfer, so anything half-received is stale.
    this.reset();
    return { status: "complete", payload: frame.slice(1, 1 + length) };
  }

  #pushFirstFrame(frame: Uint8Array): IsoTpResult {
    if (frame.length < 8) {
      return { status: "ignored", reason: "first frame shorter than 8 bytes" };
    }
    const totalLength = ((frame[0] & 0x0f) << 8) | frame[1];
    if (totalLength <= 6) {
      // Would have fitted in a single frame. Sending it as a First Frame is a
      // protocol error, and honouring it would leave us waiting for a
      // Consecutive Frame that is never coming.
      return { status: "ignored", reason: `first frame declares only ${totalLength} bytes` };
    }
    if (totalLength > MAX_PAYLOAD_BYTES) {
      const reason = `first frame declares ${totalLength} bytes, over the ${MAX_PAYLOAD_BYTES} cap`;
      this.reset();
      return { status: "abandoned", reason };
    }
    // Allocated up front from a length we have just bounded, so the buffer cannot
    // grow past it however many frames arrive.
    this.#payload = new Uint8Array(totalLength);
    this.#payload.set(frame.subarray(2, 8));
    this.#filled = 6;
    this.#expectedSequenceNumber = 1;
    this.#frames = 1;
    this.#receiving = true;
    return { status: "flow-control-required", totalLength };
  }

  #pushConsecutiveFrame(frame: Uint8Array): IsoTpResult {
    if (!this.#receiving) {
      // The tail of somebody else's transfer, or of ours from before a reset.
      return { status: "ignored", reason: "consecutive frame with no first frame" };
    }
    const sequenceNumber = frame[0] & 0x0f;
    if (sequenceNumber !== this.#expectedSequenceNumber) {
      // A gap means bytes are missing and the payload would be silently wrong —
      // far worse than no payload, because it would decode into plausible codes.
      const reason = `consecutive frame out of sequence (expected ${this.#expectedSequenceNumber}, got ${sequenceNumber})`;
      this.reset();
      return { status: "abandoned", reason };
    }
    this.#expectedSequenceNumber = (this.#expectedSequenceNumber + 1) & 0x0f;

    const remaining = this.#payload.length - this.#filled;
    const available = Math.max(0, frame.length - 1);
    const take = Math.min(7, remaining, available);
    this.#payload.set(frame.subarray(1, 1 + take), this.#filled);
    this.#filled += take;

    if (this.#filled < this.#payload.length) {
      return { status: "incomplete" };
    }
    const payload = this.#payload;
    this.reset();
    return { status: "complete", payload };
  }
}
