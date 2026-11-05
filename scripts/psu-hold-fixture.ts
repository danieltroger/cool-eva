import type { CanMessage, RawChannel, RxFilter } from "socketcan";
import { createPsuHold, type PsuClock, type PsuHold, type PsuHoldOptions } from "../src/psu/hold.ts";
import { openPsuTransport } from "../src/psu/can.ts";

export function psuFixture(options: { productionClock?: boolean; filterFails?: boolean } = {}) {
  const clock = new HoldClock();
  const state = { permitted: true, unavailable: null as string | null, filterFails: options.filterFails ?? false };
  const channels: FakePsuChannel[] = [];
  const configuration: PsuHoldOptions = {
    enabled: () => state.permitted,
    canUnavailable: () => state.unavailable,
    open: fault =>
      openPsuTransport(() => {
        const channel = new FakePsuChannel(state.filterFails);
        channels.push(channel);
        return channel;
      }, fault),
    ...(options.productionClock ? { schedule: clock.schedule } : { clock }),
  };
  const hold = createPsuHold(configuration);
  return {
    clock,
    state,
    channels,
    hold,
    act: (action: Parameters<PsuHold["perform"]>[0]) => hold.perform(action, hold.status().revision),
  };
}

export class HoldClock implements PsuClock {
  current = 100_000;
  timers: { due: number; callback: () => void; cancelled: boolean }[] = [];
  now = () => this.current;
  schedule = (callback: () => void, delay: number): (() => void) => {
    const timer = { due: this.current + delay, callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  advance(by: number): void {
    const until = this.current + by;
    for (let count = 0; count < 1000; count++) {
      this.timers.sort((left, right) => left.due - right.due);
      const timer = this.timers.find(entry => !entry.cancelled && entry.due <= until);
      if (!timer) {
        this.current = until;
        return;
      }
      timer.cancelled = true;
      this.current = timer.due;
      timer.callback();
    }
    throw new Error("Fake scheduler runaway");
  }
  jump(by: number): void {
    this.current += by;
    if (this.timers.some(timer => !timer.cancelled)) {
      this.fire();
    }
  }
  fire(): void {
    const timer = this.timers.find(entry => !entry.cancelled);
    if (!timer) {
      throw new Error("No live timer to fire");
    }
    timer.cancelled = true;
    timer.callback();
  }
}

export class FakePsuChannel implements RawChannel {
  frames: CanMessage[] = [];
  results: (number | Error)[] = [];
  messageListeners: ((message: CanMessage) => void)[] = [];
  stoppedListeners: (() => void)[] = [];
  filters: RxFilter | RxFilter[] = [];
  starts = 0;
  stops = 0;
  readonly filterFails: boolean;
  constructor(filterFails = false) {
    this.filterFails = filterFails;
  }
  addListener(event: "onMessage", callback: (message: CanMessage) => void): void;
  addListener(event: string, callback: (...args: unknown[]) => void): void;
  addListener(event: string, callback: unknown): void {
    if (event === "onMessage") {
      this.messageListeners.push(callback as (message: CanMessage) => void);
    } else if (event === "onStopped") {
      this.stoppedListeners.push(callback as () => void);
    } else {
      throw new Error(`Unexpected fake channel event ${event}`);
    }
  }
  send(message: CanMessage): number {
    this.frames.push({ ...message, data: Buffer.from(message.data) });
    const answer = this.results.shift() ?? 16;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
  start(): RawChannel {
    this.starts++;
    return this;
  }
  stop(): RawChannel {
    this.stops++;
    this.emitStopped();
    return this;
  }
  setRxFilters(filters: RxFilter | RxFilter[]): void {
    if (this.filterFails) {
      throw new Error("Synthetic RX filter refusal");
    }
    this.filters = filters;
  }
  disableLoopback(): void {
    throw new Error("PSU hold must not change loopback");
  }
  emitMessage(message: CanMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }
  emitStopped(): void {
    for (const listener of this.stoppedListeners) {
      listener();
    }
  }
}
