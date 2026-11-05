import type { CanMessage, RawChannel } from "socketcan";

export function transmitCanFrame(channel: Pick<RawChannel, "send">, frame: CanMessage): number {
  // socketcan copies into an eight-byte native buffer before the kernel validates it.
  if (frame.data.length > 8) {
    throw new CanTransmitError(`CAN 0x${frame.id.toString(16)} payload exceeds eight bytes`);
  }
  return checkCanTransmitResult(channel.send(frame), `CAN 0x${frame.id.toString(16)}`);
}

export function checkCanTransmitResult(writtenBytes: number, description = "CAN frame"): number {
  // The native return counts struct can_frame, including its header, not just the payload.
  if (writtenBytes !== 16) {
    throw new CanTransmitError(
      `${description} not sent: send() returned ${writtenBytes}, expected 16 (socketcan does not expose errno)`
    );
  }
  return writtenBytes;
}

export class CanTransmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanTransmitError";
  }
}
