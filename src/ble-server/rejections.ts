import { monotonicNow } from "../monotonic.ts";
import { SYSTEM_TIMERS, type DeadlineTimer, type DeadlineTimers } from "./dbus-link.ts";

export class Rejections {
  #lastLog = Number.NEGATIVE_INFINITY;
  #pending = 0;
  #reason = "";
  #refusalWindow = Number.NEGATIVE_INFINITY;
  #refusals = 0;
  #timer: DeadlineTimer | null = null;
  #timers: DeadlineTimers;
  #now: () => number;

  constructor(timers: DeadlineTimers = SYSTEM_TIMERS, now: () => number = monotonicNow) {
    this.#timers = timers;
    this.#now = now;
  }

  problem(reason: string, now: number): void {
    this.#pending++;
    this.#reason = reason.slice(0, 160);
    if (now - this.#lastLog >= 2_000) {
      this.flush();
      this.#lastLog = now;
    } else if (this.#timer === null) {
      this.#timer = this.#timers.setTimer(
        () => {
          this.#timer = null;
          this.flush();
          this.#lastLog = this.#now();
        },
        2_000 - (now - this.#lastLog)
      );
    }
  }

  allowRefusal(now: number): boolean {
    if (now - this.#refusalWindow >= 2_000) {
      this.#refusalWindow = now;
      this.#refusals = 0;
    }
    if (this.#refusals >= 4) return false;
    this.#refusals++;
    return true;
  }

  flush(): void {
    if (this.#timer !== null) {
      this.#timers.clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#pending === 0) return;
    console.log(`ble-server: rejected ${this.#pending} frame/message(s): ${this.#reason}`);
    this.#pending = 0;
  }
}
