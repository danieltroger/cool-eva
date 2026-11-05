import type { RawChannel } from "socketcan";
import { psuHoldFrame } from "./frame.ts";
import type { PsuTransport } from "./hold.ts";

export function openPsuTransport(
  createChannel: () => RawChannel,
  fault: (reason: "can-down" | "bus-off") => void
): PsuTransport {
  let channel: RawChannel | null = createChannel();
  let stopped = false;
  let closed = false;
  try {
    // socketcan.stop() requires a started channel. No JS listener exists until the filter succeeds.
    channel.start();
    channel.setRxFilters([{ id: 0x501, mask: 0x800007ff }]);
    channel.addListener("onMessage", message => {
      if (!closed && message.err && (message.id & 0x40) !== 0) {
        fault("bus-off");
      }
    });
    channel.addListener("onStopped", () => {
      // onStopped is inside the native stop callback; calling stop() again would recurse.
      stopped = true;
      if (!closed) {
        fault("can-down");
      }
    });
    return {
      send: () => {
        if (closed || !channel) return -1;
        return channel.send(psuHoldFrame());
      },
      close: () => {
        if (closed) return;
        closed = true;
        const closing = channel;
        channel = null;
        if (!stopped) {
          closing?.stop();
        }
      },
    };
  } catch (error) {
    closed = true;
    const closing = channel;
    channel = null;
    try {
      closing?.stop();
    } catch (cleanupError) {
      console.warn("psu-hold: failed channel setup cleanup:", cleanupError);
    }
    throw error;
  }
}
