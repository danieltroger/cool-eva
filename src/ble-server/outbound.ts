import { splitIntoFrames, type Bytes } from "../../public/lib/ble-wire.js";
import { monotonicNow, since } from "../monotonic.ts";

// The Pi → phone send queue. A notification sent through BlueZ's GATT server is a
// PropertiesChanged signal with no flow control at all: emit faster than the radio drains
// and bluetoothd queues it, out of our sight. So this process paces itself, and the queue
// it keeps is the one place a backlog is visible — which is what stream.ts sheds on, the
// way ws.ts sheds on `bufferedAmount`. docs/ble-server.md §"Pacing".

/**
 * The ATT MTU until the phone's first write tells us better. 23 is the floor every BLE
 * link starts at. Multiple notifications also carry a value length: reserve MTU − 5.
 */
export const DEFAULT_ATT_MTU = 23;
const ATT_NOTIFICATION_OVERHEAD = 5;
const MAX_QUEUED_BYTES = 128 * 1024;

/** Unmeasured starting point — a Pi Zero 2 W sharing its radio with wifi. Tune on the bike. */
export const DEFAULT_BYTES_PER_SECOND = 24_000;
const TICK_MS = 20;

export interface OutboundQueueOptions {
  send: (frame: Bytes) => void;
  bytesPerSecond?: number;
}

export class OutboundQueue {
  #frames: Bytes[] = [];
  #queuedBytes = 0;
  #messageId = 0;
  #mtu = DEFAULT_ATT_MTU;
  #send: (frame: Bytes) => void;
  #bytesPerSecond: number;
  #allowanceBytes = 0;
  #lastTickMs = monotonicNow();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: OutboundQueueOptions) {
    this.#send = options.send;
    this.#bytesPerSecond = options.bytesPerSecond ?? DEFAULT_BYTES_PER_SECOND;
  }

  /** Bytes waiting to go out. The BLE analogue of a WebSocket's `bufferedAmount`. */
  get bufferedBytes(): number {
    return this.#queuedBytes;
  }

  /** Only the authenticated owner's WriteValue may select this MTU. */
  set mtu(value: number) {
    if (Number.isInteger(value) && value >= DEFAULT_ATT_MTU && value <= 517) {
      this.#mtu = value;
    }
  }

  enqueue(envelope: Bytes, mtu = this.#mtu): boolean {
    const frameBytes = Math.min(mtu - ATT_NOTIFICATION_OVERHEAD, 512);
    const requiredBytes = envelope.length + 2 * Math.max(1, Math.ceil(envelope.length / (frameBytes - 2)));
    if (this.#queuedBytes + requiredBytes > MAX_QUEUED_BYTES) return false;
    this.#messageId = (this.#messageId + 1) & 0xff;
    for (const frame of splitIntoFrames(envelope, this.#messageId, frameBytes)) {
      this.#frames.push(frame);
      this.#queuedBytes += frame.length;
    }
    return true;
  }

  clear(): void {
    this.#frames = [];
    this.#queuedBytes = 0;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#lastTickMs = monotonicNow();
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.clear();
  }

  #tick(): void {
    const elapsedMs = since(this.#lastTickMs);
    this.#lastTickMs = monotonicNow();
    // Capped when idle, so a quiet minute does not bank a burst that lands on bluetoothd
    // all at once — but never below one frame, or a low rate and a large MTU would leave
    // the head frame waiting forever.
    const tickBudget = (this.#bytesPerSecond * TICK_MS) / 1000;
    this.#allowanceBytes = Math.min(
      this.#allowanceBytes + (this.#bytesPerSecond * elapsedMs) / 1000,
      Math.max(tickBudget * 2, this.#mtu)
    );
    while (this.#frames.length > 0 && this.#allowanceBytes >= this.#frames[0].length) {
      const frame = this.#frames.shift() as Bytes;
      this.#queuedBytes -= frame.length;
      this.#allowanceBytes -= frame.length;
      this.#send(frame);
    }
  }
}
